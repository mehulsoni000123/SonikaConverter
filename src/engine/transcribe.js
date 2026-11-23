'use strict';
// Speech to text with Mehul's installed Handy app (handy.exe --transcribe-file). Pure Node (no Electron imports).
//
// What Handy's CLI really does (measured on this PC, Handy at D:\Handy):
//  - `handy.exe -f <16 kHz mono s16 WAV> --json [--model <id>]` prints ONE JSON object on stdout:
//      { audio_secs, best_ms, bound_backend, load_ms, model, requested_device, rtf, text, transcribe_ms: [ms] }
//    Only plain text - no word or segment timestamps. Logs go to stderr. Exit 0 = ok, 1 = load/transcribe error,
//    2 = bad input (wrong WAV format / missing file).
//  - Language: there is no CLI flag; it uses Handy's own saved setting (selected_language). We never change it.
//  - Works while the Handy tray app is running (separate process).
//  - Model load is ~0.8 s per call. A single 11.9-minute pass runs out of GPU memory, so long audio is split
//    at silences into ~50 s chunks (each chunk is a separate Handy call).
const fs = require('fs');
const path = require('path');
const util = require('./util');
const media = require('./media');

const TARGET_CHUNK = 50; // seconds; measured sweet spot: 50-60 s runs ~25x real time incl. model load
const MIN_CHUNK = 25;
const MAX_CHUNK = 70;
const SAMPLE_RATE = 16000;

const KNOWN_MODELS = [
  { id: 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf', label: 'Nemotron (Hindi + English, multilingual)' },
  { id: 'handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf', label: 'Parakeet (English only, fastest)' },
  { id: 'handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf', label: 'Canary Flash (small, 4 languages, slower)' },
];

function report(ctx, fraction, text) {
  if (ctx && typeof ctx.onProgress === 'function') {
    try { ctx.onProgress(Math.max(0, Math.min(1, fraction)), text); } catch (_) { /* ignore */ }
  }
}

function handySettingsPath() {
  return path.join(process.env.APPDATA || '', 'com.pais.handy', 'settings_store.json');
}

/** Read (never write) Handy's saved settings. Returns {} when unavailable. */
function readHandySettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(handySettingsPath(), 'utf8'));
    const s = raw.settings || raw;
    return { selectedModel: s.selected_model || null, selectedLanguage: s.selected_language || null };
  } catch (_) {
    return {};
  }
}

function labelForModel(id, name) {
  const known = KNOWN_MODELS.find((m) => m.id === id);
  if (known) return known.label;
  if (name) return name;
  return path.basename(String(id)).replace(/\.gguf$/i, '');
}

function initialModelChoices() {
  const choices = KNOWN_MODELS.map((m) => ({ value: m.id, label: m.label }));
  const sel = readHandySettings().selectedModel;
  if (sel && !choices.some((c) => c.value === sel)) choices.unshift({ value: sel, label: labelForModel(sel) });
  return { choices, def: sel || KNOWN_MODELS[0].id };
}

function resolveHandy(settings) {
  if (settings && settings.handyPath && !fs.existsSync(settings.handyPath)) {
    throw new Error(`Handy was not found at "${settings.handyPath}". Check the Handy location in Settings.`);
  }
  return util.findHandy(settings);
}

/** Ask Handy which models are installed. Returns [{ id, name, label, languages }]. */
async function listInstalledModels(settings, signal) {
  const handy = resolveHandy(settings);
  // Older Handy builds exit non-zero even on success, so accept any exit code and parse stdout.
  const res = await util.runProcess(handy, ['--list-models', '--json'], { signal, okCodes: [0, 1, 2, 3, 101, -1, null] });
  const out = res.stdout;
  const a = out.indexOf('[');
  const b = out.lastIndexOf(']');
  if (a < 0 || b < a) throw new Error('Handy did not return its model list.');
  const list = JSON.parse(out.slice(a, b + 1));
  return list.filter((m) => m.is_downloaded).map((m) => ({
    id: m.id, name: m.name, label: labelForModel(m.id, m.name), languages: m.supported_languages || [],
  }));
}

/** Refresh the tool's model choices from Handy itself (the app may call this after startup). */
async function refreshModelOptions(settings) {
  const models = await listInstalledModels(settings);
  if (!models.length) return tool.options[0].choices;
  const opt = tool.options.find((o) => o.key === 'model');
  opt.choices = models.map((m) => ({ value: m.id, label: m.label }));
  const sel = readHandySettings().selectedModel;
  opt.default = models.some((m) => m.id === sel) ? sel : models[0].id;
  return opt.choices;
}

// ---------------------------------------------------------------- glossary

function loadGlossary(settings) {
  const candidates = [
    settings && settings.glossaryPath,
    path.join(process.env.USERPROFILE || 'C:\\Users\\mehul', 'Documents', 'Speech tool', 'glossary.txt'),
  ];
  const file = candidates.find((c) => c && fs.existsSync(c));
  if (!file) return { file: null, rules: [] };
  const rules = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return { file: null, rules: [] }; }
  for (let line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const wrong = line.slice(0, eq).trim();
    const right = line.slice(eq + 1).trim();
    if (!wrong) continue;
    const esc = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({ re: new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'giu'), right });
  }
  return { file, rules };
}

function applyGlossary(text, rules) {
  let out = text;
  for (const r of rules) out = out.replace(r.re, () => r.right);
  return out;
}

// ---------------------------------------------------------------- silence + chunk planning

function parseSilences(stderr, total) {
  const sil = [];
  let open = null;
  for (const line of stderr.split(/\r?\n/)) {
    let m = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (m) { open = Math.max(0, parseFloat(m[1])); continue; }
    m = line.match(/silence_end:\s*([\d.]+)/);
    if (m && open != null) { sil.push({ s: open, e: parseFloat(m[1]) }); open = null; }
  }
  if (open != null) sil.push({ s: open, e: total });
  return sil;
}

/** Choose cut points (seconds) at silences, aiming for TARGET_CHUNK-long chunks. */
function planChunks(total, silences) {
  const cuts = [0];
  let start = 0;
  while (total - start > MAX_CHUNK) {
    const inWindow = silences.filter((x) => {
      const mid = (x.s + x.e) / 2;
      return mid > start + MIN_CHUNK && mid < start + MAX_CHUNK;
    });
    let cut;
    if (inWindow.length) {
      // Prefer long pauses close to the target length.
      let best = null;
      let bestScore = -Infinity;
      for (const x of inWindow) {
        const mid = (x.s + x.e) / 2;
        const score = Math.min(x.e - x.s, 1.5) * 10 - Math.abs(mid - (start + TARGET_CHUNK)) * 0.3;
        if (score > bestScore) { bestScore = score; best = mid; }
      }
      cut = best;
    } else {
      cut = start + 60; // no pause found: hard cut
    }
    cuts.push(cut);
    start = cut;
  }
  cuts.push(total);
  const chunks = [];
  for (let i = 0; i < cuts.length - 1; i += 1) chunks.push({ start: cuts[i], end: cuts[i + 1] });
  return chunks;
}

/** Speech (non-silent) intervals inside [a, b], in absolute seconds. */
function speechIntervals(a, b, silences) {
  const out = [];
  let t = a;
  for (const x of silences) {
    if (x.e <= a || x.s >= b) continue;
    const s0 = Math.max(a, x.s);
    if (s0 > t) out.push({ s: t, e: s0 });
    t = Math.max(t, Math.min(b, x.e));
  }
  if (t < b) out.push({ s: t, e: b });
  return out.filter((iv) => iv.e - iv.s > 0.02);
}

// ---------------------------------------------------------------- WAV slicing

function wavDataInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Internal audio file is not a WAV.');
    let pos = 12;
    const hdr = Buffer.alloc(8);
    const size = fs.fstatSync(fd).size;
    while (pos + 8 <= size) {
      fs.readSync(fd, hdr, 0, 8, pos);
      const id = hdr.toString('ascii', 0, 4);
      let len = hdr.readUInt32LE(4);
      if (id === 'data') {
        if (len === 0 || len === 0xFFFFFFFF || pos + 8 + len > size) len = size - pos - 8;
        return { offset: pos + 8, length: len };
      }
      pos += 8 + len + (len % 2);
    }
    throw new Error('Internal audio file has no data.');
  } finally {
    fs.closeSync(fd);
  }
}

function wavHeader(dataBytes) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24); h.writeUInt32LE(SAMPLE_RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(dataBytes, 40);
  return h;
}

function writeWavSlice(src, info, startSec, endSec, dest) {
  const a = Math.max(0, Math.round(startSec * SAMPLE_RATE) * 2);
  const b = Math.min(info.length, Math.round(endSec * SAMPLE_RATE) * 2);
  const len = Math.max(0, b - a);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(src, 'r');
  try { fs.readSync(fd, buf, 0, len, info.offset + a); } finally { fs.closeSync(fd); }
  fs.writeFileSync(dest, Buffer.concat([wavHeader(len), buf]));
}

// ---------------------------------------------------------------- Handy call

function handyErrorText(err) {
  const raw = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
  const line = raw.split(/\r?\n/).reverse().find((l) => /^error:/i.test(l.trim())) || '';
  return { raw, line: line.replace(/^error:\s*/i, '').trim() };
}

async function handyTranscribe(handy, wavPath, modelId, signal, seconds) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), Math.round((90 + seconds * 4) * 1000));
  const sig = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const args = ['-f', wavPath, '--json'];
    if (modelId) args.push('--model', modelId);
    const res = await util.runProcess(handy, args, { signal: sig });
    const out = res.stdout;
    const a = out.indexOf('{');
    const b = out.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('Handy finished but gave no transcript.');
    const j = JSON.parse(out.slice(a, b + 1));
    return { text: String(j.text || '').trim(), loadMs: j.load_ms || 0, txMs: (j.transcribe_ms && j.transcribe_ms[0]) || 0, model: j.model };
  } catch (err) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    if (timeout.signal.aborted) throw new Error('Handy stopped responding while transcribing, so it was closed. Try again, or restart the PC if it keeps happening.');
    const { raw, line } = handyErrorText(err);
    if (/out of memory/i.test(raw)) { const e = new Error('OOM'); e.oom = true; throw e; }
    if (/Model not found|load_model/i.test(raw)) {
      throw new Error(`The Handy model "${labelForModel(modelId)}" is not installed. Open Handy and download it, or pick another model.`);
    }
    throw new Error(`Handy could not transcribe this audio${line ? ': ' + line : '.'}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- timing + SRT

/** Spread a chunk's words over its speech time in proportion to their length (Handy gives no timings). */
function timeWords(text, intervals) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || !intervals.length) return [];
  const weights = words.map((w) => w.length + 1);
  const totalW = weights.reduce((x, y) => x + y, 0);
  const speech = intervals.reduce((x, iv) => x + (iv.e - iv.s), 0);
  const at = (pos) => { // pos in 0..speech -> { t: absolute time, k: interval index }
    let left = pos;
    for (let k = 0; k < intervals.length; k += 1) {
      const iv = intervals[k];
      const d = iv.e - iv.s;
      if (left < d - 1e-9) return { t: iv.s + left, k };
      left -= d;
    }
    const k = intervals.length - 1;
    return { t: intervals[k].e, k };
  };
  const out = [];
  let acc = 0;
  for (let i = 0; i < words.length; i += 1) {
    const a = at((acc / totalW) * speech);
    acc += weights[i];
    const b = at(((acc - 1) / totalW) * speech);
    let s = a.t;
    let e = b.t;
    if (b.k !== a.k) {
      // The word straddles a pause: put it wholly on the side where most of it falls.
      const before = intervals[a.k].e - s;
      const after = e - intervals[b.k].s;
      if (after >= before) s = intervals[b.k].s;
      else e = intervals[a.k].e;
    }
    out.push({ w: words[i], s, e: Math.max(e, s + 0.05) });
  }
  return out;
}

const LINE = 42;

function splitLines(text) {
  if (text.length <= LINE) return text;
  const words = text.split(' ');
  let best = null;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const l1 = words.slice(0, i).join(' ');
    const l2 = words.slice(i).join(' ');
    const over = Math.max(0, l1.length - LINE) + Math.max(0, l2.length - LINE);
    const score = over * 100 + Math.abs(l1.length - l2.length);
    if (score < bestScore) { bestScore = score; best = l1 + '\n' + l2; }
  }
  return best || text;
}

function fitsTwoLines(text) {
  if (text.length <= LINE) return true;
  if (text.length > LINE * 2 + 1) return false;
  const l = splitLines(text).split('\n');
  return l.length === 2 && l[0].length <= LINE && l[1].length <= LINE;
}

function buildCues(words) {
  const cues = [];
  let cur = [];
  const textOf = (ws) => ws.map((x) => x.w).join(' ');
  const flush = () => { if (cur.length) cues.push({ s: cur[0].s, e: cur[cur.length - 1].e, text: textOf(cur) }); cur = []; };
  for (const w of words) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      if (!fitsTwoLines(textOf(cur) + ' ' + w.w) || w.e - cur[0].s > 7 || w.s - prev.e > 0.8) flush();
    }
    cur.push(w);
    const t = textOf(cur);
    const dur = w.e - cur[0].s;
    if (/[.?!।]$/.test(w.w) && dur >= 1.2 && t.length >= 18) flush();
    else if (/[,;:]$/.test(w.w) && t.length >= 60) flush();
  }
  flush();
  // Timing rules: 1-7 s, no overlaps, strictly increasing.
  for (let i = 0; i < cues.length; i += 1) {
    const c = cues[i];
    const next = cues[i + 1];
    const limit = next ? next.s - 0.04 : Infinity;
    if (c.e - c.s < 1) c.e = Math.min(c.s + 1, Math.max(limit, c.e));
    if (c.e - c.s > 7) c.e = c.s + 7;
    if (c.e > limit) c.e = limit;
    if (c.e <= c.s) c.e = c.s + 0.3;
    if (next && next.s < c.e + 0.001) next.s = c.e + 0.04;
  }
  return cues;
}

function srtTime(sec) {
  let ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.s)} --> ${srtTime(c.e)}\r\n${splitLines(c.text)}\r\n`).join('\r\n');
}

// ---------------------------------------------------------------- main run

async function convertToWav(input, wavPath, duration, ctx) {
  const res = await media.runFfmpeg(['-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'silencedetect=noise=-32dB:d=0.3',
    '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', wavPath],
  { ctx, duration, outPath: wavPath, label: 'Preparing audio', from: 0, to: 0.08, loglevel: 'info' });
  return parseSilences(res.stderr, duration);
}

async function detectSilencesLoose(wavPath, duration, ctx) {
  const res = await media.runFfmpeg(['-i', wavPath, '-af', 'silencedetect=noise=-24dB:d=0.15', '-f', 'null', '-'],
    { ctx, duration, label: 'Finding pauses', from: 0.08, to: 0.1, loglevel: 'info' });
  return parseSilences(res.stderr, duration);
}

async function transcribeRun(inputs, options, ctx) {
  ctx = ctx || {};
  options = options || {};
  const input = inputs[0];
  const settings = ctx.settings || {};
  const signal = ctx.signal;
  const handy = resolveHandy(settings);
  const modelId = options.model || readHandySettings().selectedModel || KNOWN_MODELS[0].id;
  const wantSrt = options.srt !== false;

  report(ctx, 0, 'Reading file');
  const info = await media.probe(input, ctx);
  if (!info.audio.length) throw new Error(`"${path.basename(input)}" has no audio track, so there is nothing to transcribe.`);
  const outDir = util.resolveOutDir(inputs, ctx);
  const tmp = util.makeTempDir('sonika-tx-');
  const started = Date.now();
  try {
    const wav = path.join(tmp, 'full.wav');
    let silences;
    try {
      silences = await convertToWav(input, wav, info.duration, ctx);
    } catch (err) {
      if (err.message === 'Cancelled') throw err;
      throw media.friendlyError(err, input);
    }
    const wInfo = wavDataInfo(wav);
    const total = wInfo.length / 2 / SAMPLE_RATE;
    if (total < 0.2) throw new Error('The audio is too short to transcribe.');

    let chunks = planChunks(total, silences);
    if (chunks.some((c) => c.end - c.start > MAX_CHUNK + 1) || (chunks.length > 1 && silences.length < chunks.length)) {
      // Few pauses at the normal level (music bed / noisy room): look again with a looser threshold.
      const loose = await detectSilencesLoose(wav, total, ctx);
      chunks = planChunks(total, silences.concat(loose).sort((a, b) => a.s - b.s));
      silences = silences.length ? silences : loose;
    }

    // Transcribe each chunk in order. If the graphics card runs out of memory, split that chunk and retry.
    const queue = chunks.map((c) => ({ ...c, depth: 0 }));
    const done = [];
    let processed = 0;
    let loadMs = 0;
    let calls = 0;
    let idx = 0;
    while (queue.length) {
      const c = queue.shift();
      const len = c.end - c.start;
      const speech = speechIntervals(c.start, c.end, silences);
      const speechSecs = speech.reduce((x, iv) => x + iv.e - iv.s, 0);
      idx += 1;
      report(ctx, 0.1 + 0.88 * (processed / total), `Transcribing part ${idx} of ${idx + queue.length} (${media.fmtTime(c.start)})`);
      if (speechSecs < 0.25) { processed += len; continue; } // pure silence: skip
      const chunkWav = path.join(tmp, `chunk_${String(idx).padStart(4, '0')}.wav`);
      writeWavSlice(wav, wInfo, c.start, c.end, chunkWav);
      let r;
      try {
        r = await handyTranscribe(handy, chunkWav, modelId, signal, len);
      } catch (err) {
        if (err.oom && c.depth < 4 && len > 6) {
          const mid = (c.start + c.end) / 2;
          const near = silences.filter((x) => Math.abs((x.s + x.e) / 2 - mid) < len / 4)
            .sort((a, b) => Math.abs((a.s + a.e) / 2 - mid) - Math.abs((b.s + b.e) / 2 - mid))[0];
          const cut = near ? (near.s + near.e) / 2 : mid;
          queue.unshift({ start: c.start, end: cut, depth: c.depth + 1 }, { start: cut, end: c.end, depth: c.depth + 1 });
          idx -= 1;
          continue;
        }
        if (err.oom) throw new Error('The graphics card ran out of memory while transcribing. Close Premiere, After Effects or ComfyUI and try again.');
        throw err;
      } finally {
        try { fs.rmSync(chunkWav, { force: true }); } catch (_) { /* ignore */ }
      }
      calls += 1;
      loadMs += r.loadMs;
      processed += len;
      if (r.text) done.push({ start: c.start, end: c.end, text: r.text, speech });
    }

    if (signal && signal.aborted) throw new Error('Cancelled');
    if (!done.length) throw new Error('No speech was heard in this file, so there is no transcript.');

    const glossary = loadGlossary(settings);
    for (const d of done) d.text = applyGlossary(d.text, glossary.rules);

    // Plain text: chunks joined; a long pause between chunks starts a new paragraph.
    let text = '';
    for (let i = 0; i < done.length; i += 1) {
      if (i > 0) {
        const gapSil = silences.find((x) => x.s <= done[i - 1].end + 0.01 && x.e >= done[i].start - 0.01 && x.e - x.s >= 1.5);
        text += gapSil ? '\n\n' : ' ';
      }
      text += done[i].text;
    }
    text = text.trim();

    report(ctx, 0.99, 'Saving');
    const outputs = [];
    const base = path.basename(input, path.extname(input));
    const txtPath = util.uniquePath(outDir, base, '.txt');
    try {
      fs.writeFileSync(txtPath, text + '\r\n', { encoding: 'utf8', flag: 'wx' });
      outputs.push(txtPath);
      if (wantSrt) {
        const words = [];
        for (const d of done) words.push(...timeWords(d.text, d.speech.length ? d.speech : [{ s: d.start, e: d.end }]));
        const cues = buildCues(words);
        const srtPath = util.uniquePath(outDir, base, '.srt');
        fs.writeFileSync(srtPath, '\uFEFF' + toSrt(cues), { encoding: 'utf8', flag: 'wx' });
        outputs.push(srtPath);
      }
    } catch (err) {
      outputs.forEach((p) => { try { fs.rmSync(p, { force: true }); } catch (_) { /* ignore */ } });
      throw new Error(`Could not save the transcript next to the file: ${err.message}`);
    }

    const secs = (Date.now() - started) / 1000;
    const rtf = total / Math.max(0.001, secs);
    const words = text.split(/\s+/).filter(Boolean).length;
    let msg = `Transcribed ${media.fmtTime(total)} of audio in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s (${rtf.toFixed(1)}x real time) with ${labelForModel(modelId)}: ${words} words`;
    msg += calls > 1 ? `, in ${calls} parts split at pauses.` : '.';
    if (wantSrt) msg += ' Subtitle timings are estimated from the pauses, because Handy does not give word timings - check them before publishing.';
    const lang = readHandySettings().selectedLanguage;
    if (lang) msg += ` Language follows Handy's own setting (${lang === 'auto' ? 'auto-detect' : lang}).`;
    if (glossary.rules.length) msg += ` Glossary fixes applied (${glossary.rules.length} rules).`;
    report(ctx, 1, 'Done');
    return { outputs, message: msg, text, stats: { audioSecs: total, wallSecs: secs, rtf, chunks: calls, modelLoadMs: loadMs } };
  } finally {
    util.removeDir(tmp);
  }
}

const modelInit = initialModelChoices();

const tool = {
  id: 'transcribe',
  category: 'transcript',
  label: 'Transcribe',
  hint: 'Speech to text and subtitles with Handy',
  accepts: media.ALL_MEDIA_EXTS,
  multi: 'each',
  isDefault: true,
  options: [
    { key: 'model', label: 'Handy model', type: 'choice', choices: modelInit.choices, default: modelInit.def },
    { key: 'srt', label: 'Also make subtitles (.srt)', type: 'toggle', default: true },
  ],
  run: transcribeRun,
};

module.exports = {
  tools: [tool],
  // Exposed for the app and tests.
  listInstalledModels, refreshModelOptions, readHandySettings, loadGlossary, applyGlossary,
  planChunks, speechIntervals, timeWords, buildCues, toSrt, srtTime, parseSilences,
};
