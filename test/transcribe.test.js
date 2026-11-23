'use strict';
// Real tests for src/engine/transcribe.js using Mehul's installed Handy (D:\Handy\handy.exe). Run: node test/transcribe.test.js
// Speech fixtures are made with Windows' built-in text to speech (System.Speech), then looped with ffmpeg for a long file.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('../src/engine/util');
const tx = require('../src/engine/transcribe');

const FIX = path.join(__dirname, 'fixtures', 'media');
const OUT = path.join(FIX, 'out-transcribe');
const ffmpeg = util.findFfmpeg({});
const ffprobe = util.findFfprobe({});
const tool = tx.tools[0];
const NEMOTRON = 'handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf';
const PARAKEET = 'handy-computer/parakeet-unified-en-0.6b-gguf/parakeet-unified-en-0.6b-Q8_0.gguf';
const CANARY = 'handy-computer/canary-180m-flash-gguf/canary-180m-flash-Q8_0.gguf';
const SENTENCE = 'Welcome to the Greater Toronto Area real estate market update. Today we look at house prices in Mississauga and Brampton, and why buyers are waiting for lower interest rates.';

let pass = 0;
let fail = 0;
const notes = [];

async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    pass += 1;
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL  ${name}: ${err && err.message}`);
  }
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || r.stdout || '').slice(-400)}`);
  return r.stdout;
}

function duration(file) {
  return parseFloat(sh(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]));
}

function ctxFor(sub, extra) {
  const dir = path.join(OUT, sub);
  fs.mkdirSync(dir, { recursive: true });
  return Object.assign({ outDir: dir, settings: {}, onProgress: () => {} }, extra || {});
}

function parseSrtTime(t) {
  const m = t.match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)$/);
  assert.ok(m, 'bad SRT time ' + t);
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

/** Validate SRT rules: numbering, format, 1-2 lines of <= 42 chars, 1-7 s, no overlaps. Returns cues. */
function validateSrt(file, audioSecs) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const blocks = raw.trim().split(/\r?\n\r?\n/);
  const cues = [];
  let prevEnd = -1;
  blocks.forEach((b, i) => {
    const lines = b.split(/\r?\n/);
    assert.strictEqual(lines[0], String(i + 1), 'sequential numbering');
    const m = lines[1].match(/^(\S+) --> (\S+)$/);
    assert.ok(m, 'timing line');
    const s = parseSrtTime(m[1]);
    const e = parseSrtTime(m[2]);
    const text = lines.slice(2);
    assert.ok(text.length >= 1 && text.length <= 2, `cue ${i + 1} has ${text.length} lines`);
    for (const l of text) assert.ok(l.length <= 42 || !l.includes(' '), `cue ${i + 1} line too long: "${l}"`);
    assert.ok(e > s, `cue ${i + 1} ends after it starts`);
    assert.ok(e - s <= 7.001, `cue ${i + 1} longer than 7 s`);
    assert.ok(s >= prevEnd, `cue ${i + 1} overlaps the previous one`);
    cues.push({ s, e, text: text.join(' ') });
    prevEnd = e;
  });
  const short = cues.filter((c) => c.e - c.s < 0.999);
  // A cue may only be under 1 s when the next cue starts right after it (no room to extend).
  short.forEach((c) => {
    const next = cues[cues.indexOf(c) + 1];
    assert.ok(next && next.s - c.e < 0.1, `cue "${c.text}" shorter than 1 s with room to extend`);
  });
  if (audioSecs) assert.ok(prevEnd <= audioSecs + 1.1, `last cue ends at ${prevEnd}, after the audio (${audioSecs})`);
  return cues;
}

function makeSpeech(file, text) {
  if (fs.existsSync(file)) return file;
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; `
    + `$s.SetOutputToWaveFile($env:SONIKA_WAV); $s.Speak($env:SONIKA_TEXT); $s.Dispose()`;
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, encoding: 'utf8', env: { ...process.env, SONIKA_WAV: file, SONIKA_TEXT: text } });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('Windows text to speech failed: ' + r.stderr);
  return file;
}

function words(s) { return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean); }

function assertHeard(text) {
  const w = new Set(words(text));
  for (const k of ['toronto', 'mississauga', 'brampton', 'interest', 'rates', 'buyers']) assert.ok(w.has(k), `transcript is missing "${k}": ${text.slice(0, 200)}`);
}

function tempCount() {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('sonika-tx-')).length;
}

async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  util.removeDir(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // ---------------- fixtures
  const speech = makeSpeech(path.join(FIX, 'speech.wav'), SENTENCE);
  const padded = path.join(FIX, 'speech_padded.wav');
  if (!fs.existsSync(padded)) sh(ffmpeg, ['-v', 'error', '-y', '-i', speech, '-af', 'apad=pad_dur=1.5', '-ar', '16000', '-ac', '1', padded]);
  const uniVideo = path.join(FIX, 'मेरा speech (final) #2.mp4');
  if (!fs.existsSync(uniVideo)) {
    sh(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25', '-i', speech, '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', uniVideo]);
  }
  // ~11.9 minutes of speech (55 loops) as compressed M4A - longer than one safe Handy pass.
  const long = path.join(FIX, 'long_speech.m4a');
  if (!fs.existsSync(long)) sh(ffmpeg, ['-v', 'error', '-y', '-stream_loop', '54', '-i', padded, '-c:a', 'aac', '-b:a', '96k', long]);
  const silent = path.join(FIX, 'silence.wav');
  if (!fs.existsSync(silent)) sh(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '5', silent]);
  const noaudio = path.join(FIX, 'noaudio_tx.mp4');
  if (!fs.existsSync(noaudio)) sh(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', noaudio]);
  const glossary = path.join(FIX, 'glossary-test.txt');
  fs.writeFileSync(glossary, '# test glossary\nMississauga=Sauga City\nbrampton = BRAMPTON-ON\n\nnot a rule line\n', 'utf8');

  // ---------------- contract + pure helpers
  await check('contract: transcribe tool shape, default, accepts all media extensions', () => {
    assert.strictEqual(tool.id, 'transcribe');
    assert.strictEqual(tool.category, 'transcript');
    assert.strictEqual(tool.isDefault, true);
    assert.strictEqual(tool.multi, 'each');
    for (const e of ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.mxf', '.wmv', '.flv', '.3gp', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']) {
      assert.ok(tool.accepts.includes(e), 'accepts ' + e);
    }
    const model = tool.options.find((o) => o.key === 'model');
    assert.ok(model.choices.some((c) => c.value === model.default));
    assert.strictEqual(model.default, NEMOTRON, "default is Handy's selected model");
    assert.ok(model.choices.every((c) => !/gguf/.test(c.label)), 'plain labels');
    assert.strictEqual(tool.options.find((o) => o.key === 'srt').default, true);
  });

  await check('Handy --list-models: the three installed models are found', async () => {
    const models = await tx.listInstalledModels({});
    const ids = models.map((m) => m.id);
    for (const id of [NEMOTRON, PARAKEET, CANARY]) assert.ok(ids.includes(id), 'installed: ' + id);
    const choices = await tx.refreshModelOptions({});
    assert.ok(choices.length >= 3);
  });

  await check('chunk planner cuts at pauses, every chunk 25-70 s', () => {
    const sil = [];
    for (let t = 10; t < 700; t += 13) sil.push({ s: t, e: t + 0.6 });
    const chunks = tx.planChunks(700, sil);
    assert.strictEqual(chunks[0].start, 0);
    assert.strictEqual(chunks[chunks.length - 1].end, 700);
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0) assert.strictEqual(chunks[i].start, chunks[i - 1].end);
      const len = chunks[i].end - chunks[i].start;
      if (i < chunks.length - 1) {
        assert.ok(len >= 25 && len <= 70, 'chunk length ' + len);
        assert.ok(sil.some((x) => chunks[i].end > x.s && chunks[i].end < x.e), 'cut inside a pause');
      }
    }
    const hard = tx.planChunks(200, []);
    assert.ok(hard.every((c) => c.end - c.start <= 70));
  });

  await check('SRT time format and cue builder rules', () => {
    assert.strictEqual(tx.srtTime(3725.0456), '01:02:05,046');
    assert.strictEqual(tx.srtTime(0), '00:00:00,000');
    const w = tx.timeWords('one two three. four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen.',
      [{ s: 0, e: 2 }, { s: 3, e: 9 }]);
    const cues = tx.buildCues(w);
    for (let i = 0; i < cues.length; i += 1) {
      assert.ok(cues[i].e > cues[i].s);
      assert.ok(cues[i].e - cues[i].s <= 7);
      if (i) assert.ok(cues[i].s >= cues[i - 1].e);
    }
  });

  await check('glossary loader: wrong=right lines, comments and junk ignored, whole words only', () => {
    const g = tx.loadGlossary({ glossaryPath: glossary });
    assert.strictEqual(g.rules.length, 2);
    assert.strictEqual(tx.applyGlossary('mississauga and Brampton, not Bramptonville', g.rules), 'Sauga City and BRAMPTON-ON, not Bramptonville');
  });

  // ---------------- real transcription
  await check('transcribe a WAV with the default model: .txt + .srt, words recognised, text returned', async () => {
    const ctx = ctxFor('wav');
    const fr = [];
    ctx.onProgress = (f) => fr.push(f);
    const r = await tool.run([speech], { model: NEMOTRON, srt: true }, ctx);
    assert.deepStrictEqual(r.outputs.map((o) => path.basename(o)), ['speech.txt', 'speech.srt']);
    const txt = fs.readFileSync(r.outputs[0], 'utf8');
    assertHeard(txt);
    assert.strictEqual(r.text.trim(), txt.trim());
    assertHeard(r.text);
    validateSrt(r.outputs[1], duration(speech));
    assert.ok(fr.length > 2 && fr[fr.length - 1] === 1, 'progress reported up to 1');
    for (let i = 1; i < fr.length; i += 1) assert.ok(fr[i] >= fr[i - 1] - 1e-9, 'progress never goes backwards');
  });

  await check('transcribe a video with a unicode, space and # name, Parakeet model, SRT off, output next to the file', async () => {
    const r = await tool.run([uniVideo], { model: PARAKEET, srt: false }, { outDir: null, settings: {}, onProgress: () => {} });
    assert.deepStrictEqual(r.outputs, [path.join(FIX, 'मेरा speech (final) #2.txt')]);
    assertHeard(fs.readFileSync(r.outputs[0], 'utf8'));
    assert.match(r.message, /Parakeet/);
    fs.rmSync(r.outputs[0]);
  });

  await check('transcribe with Canary model works', async () => {
    const r = await tool.run([speech], { model: CANARY, srt: false }, ctxFor('canary'));
    assertHeard(r.text);
  });

  await check('glossary from settings.glossaryPath is applied to .txt, .srt and text', async () => {
    const r = await tool.run([speech], { model: PARAKEET, srt: true }, ctxFor('glossary', { settings: { glossaryPath: glossary } }));
    assert.match(r.text, /Sauga City/);
    assert.doesNotMatch(r.text, /Mississauga/);
    assert.match(fs.readFileSync(r.outputs[1], 'utf8'), /BRAMPTON-ON/);
    assert.match(r.message, /Glossary/);
  });

  await check('no overwrite: second run makes "speech (2).txt" and "speech (2).srt"', async () => {
    const ctx = ctxFor('twice');
    await tool.run([speech], { model: PARAKEET, srt: true }, ctx);
    const b = await tool.run([speech], { model: PARAKEET, srt: true }, ctx);
    assert.deepStrictEqual(b.outputs.map((o) => path.basename(o)), ['speech (2).txt', 'speech (2).srt']);
  });

  await check('long file (~11.9 min, too long for one Handy pass) is split at pauses and stitched', async () => {
    const before = tempCount();
    const ctx = ctxFor('long');
    const fr = [];
    ctx.onProgress = (f, t) => fr.push([f, t]);
    const r = await tool.run([long], { model: NEMOTRON, srt: true }, ctx);
    const secs = duration(long);
    assert.ok(r.stats.chunks >= 10, 'chunks: ' + r.stats.chunks);
    const w = words(r.text);
    const count = w.filter((x) => x === 'mississauga').length;
    assert.ok(count >= 50, `"Mississauga" heard ${count} of 55 times`);
    const cues = validateSrt(r.outputs[1], secs);
    // Timing sanity: each repeat starts every ~12.94 s; the cue holding "Welcome" should start within 1.5 s of that.
    const unit = duration(padded);
    const welcomes = cues.filter((c) => /^welcome/i.test(c.text));
    assert.ok(welcomes.length >= 50, 'welcome cues ' + welcomes.length);
    const off = welcomes.map((c) => Math.abs(c.s - Math.round(c.s / unit) * unit));
    const bad = off.filter((o) => o > 1.5).length;
    assert.ok(bad <= 3, `${bad} "Welcome" cues start more than 1.5 s from the real time`);
    const parts = new Set(fr.map((x) => x[1]).filter((t) => /Transcribing part/.test(t)));
    assert.ok(parts.size >= 10, 'progress moves per chunk');
    assert.strictEqual(tempCount(), before, 'temp folder removed');
    notes.push(`long file: ${secs.toFixed(0)} s audio in ${r.stats.wallSecs.toFixed(1)} s = ${r.stats.rtf.toFixed(1)}x real time, `
      + `${r.stats.chunks} Handy calls, model loading ${(r.stats.modelLoadMs / 1000).toFixed(1)} s total; worst "Welcome" cue offset ${Math.max(...off).toFixed(2)} s`);
  });

  await check('cancel mid-job: rejects with Cancelled, no .txt/.srt left, temp folder removed, no Handy left running', async () => {
    const before = tempCount();
    const ctx = ctxFor('cancel');
    const ac = new AbortController();
    ctx.signal = ac.signal;
    ctx.onProgress = (f) => { if (f > 0.3) ac.abort(); };
    await assert.rejects(tool.run([long], { model: NEMOTRON }, ctx), /Cancelled/);
    await new Promise((res) => setTimeout(res, 1500));
    assert.deepStrictEqual(fs.readdirSync(ctx.outDir), []);
    assert.strictEqual(tempCount(), before, 'temp folder removed');
    const procs = spawnSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='handy.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8' }).stdout;
    assert.ok(!/sonika-tx-/.test(procs), 'a Handy transcription process is still running: ' + procs);
  });

  await check('missing Handy path gives a clear error', async () => {
    await assert.rejects(tool.run([speech], {}, ctxFor('nohandy', { settings: { handyPath: 'X:\\Nowhere\\handy.exe' } })),
      /Handy was not found at "X:\\Nowhere\\handy.exe"/);
    assert.deepStrictEqual(fs.readdirSync(path.join(OUT, 'nohandy')), []);
  });

  await check('a model that is not installed gives a clear error', async () => {
    await assert.rejects(tool.run([speech], { model: 'handy-computer/not-a-model' }, ctxFor('badmodel')), /is not installed/);
  });

  await check('file with no audio track gives a clear error', async () => {
    await assert.rejects(tool.run([noaudio], {}, ctxFor('noaudio')), /has no audio track/);
  });

  await check('pure silence gives "No speech was heard"', async () => {
    await assert.rejects(tool.run([silent], {}, ctxFor('silent')), /No speech was heard/);
    assert.deepStrictEqual(fs.readdirSync(path.join(OUT, 'silent')), []);
  });

  console.log('');
  for (const n of notes) console.log('SPEED ' + n);
  console.log(`\ntranscribe.test.js: ${pass} passed, ${fail} failed`);
  util.removeDir(OUT);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.log('FAIL  test runner crashed: ' + (err && err.stack)); process.exit(1); });
