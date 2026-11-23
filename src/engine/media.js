'use strict';
// Audio and video tools built on FFmpeg. Pure Node (no Electron imports).
const fs = require('fs');
const path = require('path');
const util = require('./util');

const VIDEO_EXTS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts', '.ts', '.mxf', '.wmv', '.flv', '.3gp', '.mpg', '.mpeg'];
const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff'];
const ALL_MEDIA_EXTS = VIDEO_EXTS.concat(AUDIO_EXTS);

// ---------------------------------------------------------------- helpers

function report(ctx, fraction, text) {
  if (ctx && typeof ctx.onProgress === 'function') {
    try { ctx.onProgress(Math.max(0, Math.min(1, fraction)), text); } catch (_) { /* ignore UI errors */ }
  }
}

function settingsOf(ctx) { return (ctx && ctx.settings) || {}; }

function removeFile(p) {
  try { if (p && fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch (_) { /* best effort */ }
}

function isCancel(err, ctx) {
  return (err && err.message === 'Cancelled') || !!(ctx && ctx.signal && ctx.signal.aborted);
}

function baseName(file) { return path.basename(file, path.extname(file)); }

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function fmtSecs(sec) { return sec < 10 ? sec.toFixed(1) + ' s' : Math.round(sec) + ' s'; }

/** Translate raw ffmpeg / ffprobe failures into something a non-coder understands. */
function friendlyError(err, file) {
  const raw = (err && (err.stderr || err.message)) || '';
  const name = file ? `"${path.basename(file)}"` : 'This file';
  if (/Invalid data found|moov atom not found|could not find codec parameters|EBML header parsing failed|Invalid argument/i.test(raw)) {
    return new Error(`${name} could not be read. It may be damaged, still copying, or not a real video/audio file.`);
  }
  if (/No such file|does not exist/i.test(raw)) return new Error(`${name} could not be found. It may have been moved or deleted.`);
  if (/Permission denied|Access is denied/i.test(raw)) return new Error(`Windows did not allow access to ${name} or its folder. Close any program using it and try again.`);
  if (/No space left|not enough space/i.test(raw)) return new Error('The disk is full. Free some space and try again.');
  const e = new Error(`FFmpeg could not process ${name}. ${String(err && err.message || '').slice(0, 300)}`);
  return e;
}

/** ffprobe a file. Returns { duration, format, streams, audio: [...], video: [...] }. */
async function probe(file, ctx) {
  if (!fs.existsSync(file)) throw new Error(`"${path.basename(file)}" could not be found. It may have been moved or deleted.`);
  const ffprobe = util.findFfprobe(settingsOf(ctx));
  let res;
  try {
    res = await util.runProcess(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal: ctx && ctx.signal });
  } catch (err) {
    if (isCancel(err, ctx)) throw new Error('Cancelled');
    throw friendlyError(err, file);
  }
  let info;
  try { info = JSON.parse(res.stdout); } catch (_) { throw new Error(`"${path.basename(file)}" could not be read.`); }
  const streams = info.streams || [];
  const fmt = info.format || {};
  let duration = parseFloat(fmt.duration);
  if (!isFinite(duration)) {
    duration = Math.max(0, ...streams.map((s) => parseFloat(s.duration)).filter(isFinite));
  }
  const video = streams.filter((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  return { duration: isFinite(duration) ? duration : 0, format: fmt, streams, video, audio };
}

/**
 * Run ffmpeg with real progress (parsed from -progress pipe:1 against the known duration).
 * Deletes `outPath` on failure or cancel. Progress is mapped into [from, to].
 */
async function runFfmpeg(args, opts) {
  const { ctx, duration, outPath, label } = opts;
  const from = opts.from || 0;
  const to = opts.to == null ? 1 : opts.to;
  const ffmpeg = util.findFfmpeg(settingsOf(ctx));
  const full = ['-hide_banner', '-nostdin', '-n', '-progress', 'pipe:1', '-nostats', '-loglevel', opts.loglevel || 'error'].concat(args);
  let buf = '';
  let lastSpeed = '';
  const onStdout = (t) => {
    buf += t;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1).trim();
      if (k === 'speed') lastSpeed = v;
      if ((k === 'out_time_us' || k === 'out_time_ms') && duration > 0) {
        const us = parseInt(v, 10);
        if (isFinite(us) && us >= 0) {
          const frac = Math.min(1, us / 1e6 / duration);
          const sp = lastSpeed && lastSpeed !== 'N/A' ? ` (${lastSpeed.replace(/\s+/g, '')})` : '';
          report(ctx, from + (to - from) * frac, `${label || 'Working'} ${Math.round(frac * 100)}%${sp}`);
        }
      }
    }
  };
  try {
    const res = await util.runProcess(ffmpeg, full, { signal: ctx && ctx.signal, onStdout });
    report(ctx, to, `${label || 'Working'} 100%`);
    return res;
  } catch (err) {
    removeFile(outPath);
    if (isCancel(err, ctx)) throw new Error('Cancelled');
    throw err;
  }
}

function assertOutput(outPath) {
  let st;
  try { st = fs.statSync(outPath); } catch (_) { st = null; }
  if (!st || st.size === 0) {
    removeFile(outPath);
    throw new Error('FFmpeg finished but did not produce a usable file.');
  }
  return st.size;
}

/** Parse "90", "1:30", "00:01:30.5", "1:30,5" into seconds. Returns null for empty. Throws on nonsense. */
function parseTimecode(value, what) {
  if (value == null) return null;
  const s = String(value).trim().replace(',', '.');
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$|^\d+:\d{1,2}(\.\d+)?$|^\d+:\d{1,2}:\d{1,2}(\.\d+)?$/.test(s)) {
    throw new Error(`The ${what || 'time'} "${value}" is not a time I understand. Use seconds (90), minutes:seconds (1:30) or hours:minutes:seconds (00:01:30.5).`);
  }
  const parts = s.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

// ---------------------------------------------------------------- NVENC detection

let nvencCache = null;
/** True when h264_nvenc really encodes on this PC (tested once with a tiny encode, then cached). */
async function nvencAvailable(ctx) {
  if (nvencCache !== null) return nvencCache;
  const ffmpeg = util.findFfmpeg(settingsOf(ctx));
  try {
    await util.runProcess(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30:d=0.2',
      '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    nvencCache = true;
  } catch (_) {
    nvencCache = false;
  }
  return nvencCache;
}

/** H.264 video encoder args. mode: {crf} or {bitrate (kbps)}. */
function h264Args(useGpu, mode) {
  if (useGpu) {
    const a = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-profile:v', 'high'];
    if (mode.bitrate) {
      a.push('-rc', 'vbr', '-b:v', `${mode.bitrate}k`, '-maxrate', `${Math.round(mode.bitrate * 1.5)}k`, '-bufsize', `${mode.bitrate * 2}k`);
    } else {
      a.push('-rc', 'vbr', '-cq', String(mode.crf), '-b:v', '0', '-spatial-aq', '1');
    }
    return a;
  }
  const a = ['-c:v', 'libx264', '-preset', mode.preset || 'medium', '-profile:v', 'high', '-threads', '0'];
  if (mode.bitrate) a.push('-b:v', `${mode.bitrate}k`, '-maxrate', `${Math.round(mode.bitrate * 1.5)}k`, '-bufsize', `${mode.bitrate * 2}k`);
  else a.push('-crf', String(mode.crf));
  return a;
}

/**
 * Encode with NVENC when possible, falling back to libx264 automatically.
 * buildArgs(useGpu) -> ffmpeg args. Returns { usedGpu, fellBack }.
 */
async function encodeWithFallback(buildArgs, opts, forceCpu) {
  const ctx = opts.ctx;
  const gpu = !forceCpu && await nvencAvailable(ctx);
  if (gpu) {
    try {
      await runFfmpeg(buildArgs(true), opts);
      return { usedGpu: true, fellBack: false };
    } catch (err) {
      if (err.message === 'Cancelled') throw err;
      report(ctx, opts.from || 0, 'Graphics card encoder failed, using the CPU instead');
    }
  }
  try {
    await runFfmpeg(buildArgs(false), opts);
  } catch (err) {
    if (err.message === 'Cancelled') throw err;
    throw friendlyError(err, opts.input);
  }
  return { usedGpu: false, fellBack: gpu };
}

// ---------------------------------------------------------------- video-to-audio

const AUDIO_FORMATS = {
  'mp3-320': { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3'], label: 'MP3 320k' },
  'mp3-192': { ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '192k', '-id3v2_version', '3'], label: 'MP3 192k' },
  'wav-48k': { ext: '.wav', args: ['-c:a', 'pcm_s16le', '-ar', '48000'], label: 'WAV 48 kHz' },
  m4a: { ext: '.m4a', args: ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k', '-movflags', '+faststart'], label: 'M4A (AAC 256k)' },
  flac: { ext: '.flac', args: ['-c:a', 'flac', '-compression_level', '5'], label: 'FLAC' },
};

/** For "copy": the container that can hold this codec without re-encoding. */
function copyTarget(codec) {
  const c = String(codec || '').toLowerCase();
  const big = { pcm_s16be: 'pcm_s16le', pcm_s24be: 'pcm_s24le', pcm_s32be: 'pcm_s32le', pcm_f32be: 'pcm_f32le', pcm_f64be: 'pcm_f64le' };
  if (big[c]) return { ext: '.wav', args: ['-c:a', big[c]], note: 'big-endian PCM rewritten losslessly as WAV' };
  if (/^pcm_(s16le|s24le|s32le|f32le|f64le|u8|alaw|mulaw)$/.test(c)) return { ext: '.wav', args: ['-c:a', 'copy'] };
  const map = {
    aac: '.m4a', alac: '.m4a', mp3: '.mp3', mp2: '.mp2', opus: '.opus', vorbis: '.ogg', flac: '.flac',
    ac3: '.ac3', eac3: '.eac3', dts: '.dts', truehd: '.mka', wmav1: '.wma', wmav2: '.wma', wmapro: '.wma', amr_nb: '.amr',
  };
  const ext = map[c] || '.mka';
  const args = ['-c:a', 'copy'];
  if (ext === '.m4a') args.push('-movflags', '+faststart');
  if (ext === '.mka' && !map[c]) return { ext, args, note: `${c} audio kept as-is in an MKA file` };
  return { ext, args };
}

async function videoToAudio(inputs, options, ctx) {
  const input = inputs[0];
  const format = (options && options.format) || 'mp3-320';
  const trackMode = (options && options.tracks) || 'first';
  if (format !== 'copy' && !AUDIO_FORMATS[format]) throw new Error(`Unknown audio format "${format}".`);
  report(ctx, 0, 'Reading file');
  const info = await probe(input, ctx);
  if (!info.audio.length) throw new Error(`"${path.basename(input)}" has no audio track, so there is nothing to extract.`);
  const outDir = util.resolveOutDir(inputs, ctx);
  const nTracks = info.audio.length;

  // Which audio tracks to produce.
  let jobs;
  if (trackMode === 'all' && nTracks > 1) {
    jobs = info.audio.map((s, i) => ({ map: ['-map', `0:a:${i}`], stream: s, suffix: ` (track ${i + 1})` }));
  } else if (trackMode === 'mix' && nTracks > 1) {
    jobs = [{ mix: true, stream: info.audio[0], suffix: ' (mixed)' }];
  } else {
    jobs = [{ map: ['-map', '0:a:0'], stream: info.audio[0], suffix: '' }];
  }

  const started = Date.now();
  const outputs = [];
  const notes = [];
  try {
    for (let j = 0; j < jobs.length; j += 1) {
      const job = jobs[j];
      let target;
      let mapArgs = job.map || [];
      let filter = [];
      if (format === 'copy' && !job.mix) {
        target = copyTarget(job.stream.codec_name);
        if (target.note) notes.push(target.note);
      } else {
        if (format === 'copy' && job.mix) notes.push('mixing tracks needs re-encoding, so the mix was saved as WAV');
        target = format === 'copy' ? { ext: '.wav', args: ['-c:a', 'pcm_s16le'] } : AUDIO_FORMATS[format];
      }
      if (job.mix) {
        const ins = info.audio.map((_, i) => `[0:a:${i}]`).join('');
        filter = ['-filter_complex', `${ins}amix=inputs=${nTracks}:duration=longest:normalize=0[aout]`];
        mapArgs = ['-map', '[aout]'];
      }
      const outPath = util.uniquePath(outDir, baseName(input) + job.suffix, target.ext);
      const args = ['-threads', '0', '-i', input].concat(filter, mapArgs, ['-vn', '-sn', '-dn', '-map_metadata', '0'], target.args, ['-threads', '0', outPath]);
      const label = jobs.length > 1 ? `Extracting audio ${j + 1}/${jobs.length}` : 'Extracting audio';
      try {
        await runFfmpeg(args, { ctx, duration: info.duration, outPath, label, input, from: j / jobs.length, to: (j + 1) / jobs.length });
      } catch (err) {
        if (err.message === 'Cancelled') throw err;
        throw friendlyError(err, input);
      }
      assertOutput(outPath);
      outputs.push(outPath);
    }
  } catch (err) {
    outputs.forEach(removeFile);
    throw err;
  }

  const secs = (Date.now() - started) / 1000;
  const speed = info.duration > 0 && secs > 0 ? ` (${Math.round(info.duration / secs)}x real time)` : '';
  const fmtLabel = format === 'copy' ? 'original quality (no re-encode)' : AUDIO_FORMATS[format].label;
  let msg = `Saved ${outputs.length > 1 ? outputs.length + ' audio files' : path.basename(outputs[0])} as ${fmtLabel} from ${fmtTime(info.duration)} of media in ${fmtSecs(secs)}${speed}.`;
  if (nTracks > 1) {
    if (trackMode === 'first') msg += ` This file has ${nTracks} audio tracks; only track 1 was used (choose "Every track" or "Mix all tracks" to change that).`;
    else if (trackMode === 'all') msg += ` Saved each of the ${nTracks} audio tracks separately.`;
    else msg += ` Mixed all ${nTracks} audio tracks together.`;
  }
  if (notes.length) msg += ` Note: ${Array.from(new Set(notes)).join('; ')}.`;
  return { outputs, message: msg };
}

// ---------------------------------------------------------------- video-compress

const COMPRESS_PRESETS = {
  whatsapp: { label: 'WhatsApp', shortSide: 720, targetMB: 60, maxKbps: 2500, audioK: 128 },
  'email-small': { label: 'Email', shortSide: 480, targetMB: 22, maxKbps: 1000, audioK: 96 },
  'high-quality': { label: 'High quality', crf: 20, audioK: 192 },
};

function scaleShortSide(n) {
  // Shrink so the short side is at most n (never upscale), keep aspect, even dimensions.
  return `scale='if(gte(iw,ih),-2,min(${n},trunc(iw/2)*2))':'if(gte(iw,ih),min(${n},trunc(ih/2)*2),-2)'`;
}
const EVEN_DIMS = "scale='trunc(iw/2)*2':'trunc(ih/2)*2'";

async function videoCompress(inputs, options, ctx) {
  const input = inputs[0];
  const presetKey = (options && options.preset) || 'whatsapp';
  const preset = COMPRESS_PRESETS[presetKey];
  if (!preset) throw new Error(`Unknown compression preset "${presetKey}".`);
  report(ctx, 0, 'Reading file');
  const info = await probe(input, ctx);
  if (!info.video.length) throw new Error(`"${path.basename(input)}" has no video picture to compress.`);
  const inSize = fs.statSync(input).size;
  const outDir = util.resolveOutDir(inputs, ctx);
  const outPath = util.uniquePath(outDir, `${baseName(input)}_${presetKey}`, '.mp4');
  const hasAudio = info.audio.length > 0;

  let mode;
  let vf;
  let fitNote = '';
  if (preset.crf) {
    mode = { crf: preset.crf };
    vf = EVEN_DIMS;
  } else {
    const dur = Math.max(1, info.duration || 1);
    const budgetKbps = Math.floor((preset.targetMB * 8 * 1024 * 0.95) / dur) - (hasAudio ? preset.audioK : 0);
    let kbps = Math.min(preset.maxKbps, budgetKbps);
    if (kbps < 250) { kbps = 250; fitNote = ` The video is long, so it may still be over ${preset.targetMB} MB.`; }
    mode = { bitrate: kbps };
    vf = scaleShortSide(preset.shortSide);
  }
  const buildArgs = (gpu) => ['-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-vf', vf, '-pix_fmt', 'yuv420p']
    .concat(h264Args(gpu, mode), hasAudio ? ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', `${preset.audioK}k`, '-ac', '2'] : ['-an'],
      ['-movflags', '+faststart', '-map_metadata', '0', outPath]);
  const started = Date.now();
  const res = await encodeWithFallback(buildArgs, { ctx, duration: info.duration, outPath, label: 'Compressing', input }, !!(options && options.forceCpu));
  const outSize = assertOutput(outPath);
  const secs = (Date.now() - started) / 1000;
  const enc = res.usedGpu ? 'graphics card (NVENC)' : (res.fellBack ? 'CPU (graphics card encoder failed)' : 'CPU');
  const pct = Math.round((1 - outSize / inSize) * 100);
  const change = pct >= 0 ? `${pct}% smaller` : `${-pct}% bigger (the original was already very compressed)`;
  return {
    outputs: [outPath],
    message: `${preset.label}: ${fmtSize(inSize)} -> ${fmtSize(outSize)} (${change}) in ${fmtSecs(secs)} using the ${enc}.${fitNote}`,
  };
}

// ---------------------------------------------------------------- video-to-mp4

const MP4_VIDEO_OK = ['h264', 'hevc', 'mpeg4', 'av1'];
const MP4_AUDIO_OK = ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus', 'flac'];

async function videoToMp4(inputs, options, ctx) {
  const input = inputs[0];
  const mode = (options && options.mode) || 'auto';
  report(ctx, 0, 'Reading file');
  const info = await probe(input, ctx);
  if (!info.video.length) throw new Error(`"${path.basename(input)}" has no video picture. Use the Audio tools for audio-only files.`);
  const outDir = util.resolveOutDir(inputs, ctx);
  const outPath = util.uniquePath(outDir, baseName(input), '.mp4');
  const v = info.video[0];
  const vCodec = String(v.codec_name || '').toLowerCase();
  const pix = String(v.pix_fmt || '');
  const audioOk = info.audio.every((a) => MP4_AUDIO_OK.includes(String(a.codec_name).toLowerCase()));
  const videoOk = MP4_VIDEO_OK.includes(vCodec);
  const started = Date.now();
  const base = ['-i', input, '-map', '0:v:0', '-map', '0:a?', '-sn', '-dn', '-map_metadata', '0'];
  const tail = ['-movflags', '+faststart', outPath];

  if (mode === 'auto' && videoOk) {
    // Remux: copy the video untouched; copy audio when MP4 can hold it, otherwise convert audio only.
    const vTag = vCodec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
    const aArgs = audioOk ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k'];
    try {
      await runFfmpeg(base.concat(['-c:v', 'copy'], vTag, aArgs, tail), { ctx, duration: info.duration, outPath, label: audioOk ? 'Repackaging' : 'Repackaging (converting audio)', input });
      const outSize = assertOutput(outPath);
      const secs = (Date.now() - started) / 1000;
      return {
        outputs: [outPath],
        message: `Repackaged to MP4 without re-encoding the picture${audioOk ? '' : ' (audio converted to AAC)'} in ${fmtSecs(secs)}. ${fmtSize(outSize)}.`,
      };
    } catch (err) {
      if (err.message === 'Cancelled') throw err;
      report(ctx, 0, 'Quick repackage failed, re-encoding instead');
    }
  }
  // Re-encode to H.264 + AAC.
  const why = videoOk ? 'by request' : `because ${vCodec || 'this'} video cannot go into MP4 as-is`;
  const buildArgs = (gpu) => base.concat(['-vf', EVEN_DIMS, '-pix_fmt', 'yuv420p'], h264Args(gpu, { crf: 19 }),
    info.audio.length ? ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k'] : [], tail);
  const res = await encodeWithFallback(buildArgs, { ctx, duration: info.duration, outPath, label: 'Converting', input }, !!(options && options.forceCpu));
  const outSize = assertOutput(outPath);
  const secs = (Date.now() - started) / 1000;
  const note = pix.includes('10') || pix.includes('12') ? ' The original was 10-bit or higher; the MP4 is standard 8-bit for compatibility.' : '';
  return {
    outputs: [outPath],
    message: `Converted to MP4 (H.264 + AAC) ${why}, using the ${res.usedGpu ? 'graphics card' : 'CPU'}, in ${fmtSecs(secs)}. ${fmtSize(outSize)}.${note}`,
  };
}

// ---------------------------------------------------------------- video-trim

async function videoTrim(inputs, options, ctx) {
  const input = inputs[0];
  options = options || {};
  const start = parseTimecode(options.start, 'start time') || 0;
  const endRaw = parseTimecode(options.end, 'end time');
  report(ctx, 0, 'Reading file');
  const info = await probe(input, ctx);
  const total = info.duration;
  const end = endRaw == null || endRaw <= 0 ? total : Math.min(endRaw, total || endRaw);
  if (total && start >= total) throw new Error(`The start time ${fmtTime(start)} is after the end of the video (${fmtTime(total)}).`);
  if (end <= start) throw new Error('The end time must be after the start time.');
  const len = end - start;
  const outDir = util.resolveOutDir(inputs, ctx);
  const accurate = !!options.frameAccurate;
  const started = Date.now();
  let outPath;
  if (!accurate) {
    let ext = path.extname(input).toLowerCase();
    if (!ext) ext = '.mp4';
    outPath = util.uniquePath(outDir, `${baseName(input)}_trim`, ext);
    // Fast input seek to a little before the start, then an exact output seek. Pure input seeking can land a
    // whole keyframe interval early in MKV; this way the cut starts on the keyframe just before `start`.
    const pre = Math.max(0, start - 30);
    const args = ['-ss', String(pre), '-i', input, '-ss', String(start - pre), '-t', String(len), '-map', '0:v?', '-map', '0:a?', '-sn', '-dn',
      '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-map_metadata', '0'];
    if (['.mp4', '.mov', '.m4v'].includes(ext)) args.push('-movflags', '+faststart');
    args.push(outPath);
    try {
      await runFfmpeg(args, { ctx, duration: len, outPath, label: 'Cutting', input });
    } catch (err) {
      if (err.message === 'Cancelled') throw err;
      throw friendlyError(err, input);
    }
  } else {
    outPath = util.uniquePath(outDir, `${baseName(input)}_trim`, '.mp4');
    const hasVideo = info.video.length > 0;
    const buildArgs = (gpu) => ['-ss', String(start), '-i', input, '-t', String(len), '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn']
      .concat(hasVideo ? ['-vf', EVEN_DIMS, '-pix_fmt', 'yuv420p'].concat(h264Args(gpu, { crf: 18 })) : [],
        info.audio.length ? ['-c:a', 'aac', '-aac_coder', 'fast', '-b:a', '256k'] : [], ['-movflags', '+faststart', outPath]);
    await encodeWithFallback(buildArgs, { ctx, duration: len, outPath, label: 'Cutting (frame accurate)', input }, !!options.forceCpu);
  }
  assertOutput(outPath);
  const secs = (Date.now() - started) / 1000;
  return {
    outputs: [outPath],
    message: `Cut ${fmtTime(start)} to ${fmtTime(end)} (${fmtSecs(len)}) in ${fmtSecs(secs)}. `
      + (accurate ? 'Frame-accurate cut, re-encoded to H.264 MP4.' : 'Fast cut without re-encoding; it starts on the nearest keyframe, so it may begin a fraction of a second early.'),
  };
}

// ---------------------------------------------------------------- video-to-gif

async function videoToGif(inputs, options, ctx) {
  const input = inputs[0];
  options = options || {};
  const fps = Math.max(1, Math.min(50, Number(options.fps) || 12));
  const width = Math.max(32, Math.min(1920, Math.round(Number(options.width) || 480)));
  const start = parseTimecode(options.start, 'start time') || 0;
  let dur = Number(options.duration);
  if (!isFinite(dur) || dur < 0) dur = 5;
  report(ctx, 0, 'Reading file');
  const info = await probe(input, ctx);
  if (!info.video.length) throw new Error(`"${path.basename(input)}" has no video picture to turn into a GIF.`);
  if (info.duration && start >= info.duration) throw new Error(`The start time ${fmtTime(start)} is after the end of the video (${fmtTime(info.duration)}).`);
  const avail = info.duration ? info.duration - start : dur;
  const len = dur === 0 ? avail : Math.min(dur, avail);
  const outDir = util.resolveOutDir(inputs, ctx);
  const outPath = util.uniquePath(outDir, baseName(input), '.gif');
  const filter = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  const started = Date.now();
  try {
    await runFfmpeg(['-ss', String(start), '-t', String(len), '-i', input, '-filter_complex', filter, '-an', '-loop', '0', outPath],
      { ctx, duration: len, outPath, label: 'Making GIF', input });
  } catch (err) {
    if (err.message === 'Cancelled') throw err;
    throw friendlyError(err, input);
  }
  const size = assertOutput(outPath);
  const secs = (Date.now() - started) / 1000;
  let msg = `Made a ${fmtSecs(len)} GIF (${width}px wide max, ${fps} fps), ${fmtSize(size)}, in ${fmtSecs(secs)}.`;
  if (size > 15 * 1024 * 1024) msg += ' It is large; lower the width, fps or duration for a smaller file.';
  return { outputs: [outPath], message: msg };
}

// ---------------------------------------------------------------- tool list

const tools = [
  {
    id: 'video-to-audio',
    category: 'audio',
    label: 'Video to Audio',
    hint: 'Pull the sound out of any video, fast',
    accepts: ALL_MEDIA_EXTS,
    multi: 'each',
    isDefault: true,
    options: [
      {
        key: 'format', label: 'Format', type: 'choice', default: 'mp3-320',
        choices: [
          { value: 'mp3-320', label: 'MP3 320k (best MP3)' },
          { value: 'mp3-192', label: 'MP3 192k (smaller)' },
          { value: 'wav-48k', label: 'WAV 48 kHz (for editing)' },
          { value: 'm4a', label: 'M4A / AAC 256k' },
          { value: 'copy', label: 'Original audio, no re-encode (instant)' },
          { value: 'flac', label: 'FLAC (lossless)' },
        ],
      },
      {
        key: 'tracks', label: 'If there are several audio tracks', type: 'choice', default: 'first',
        choices: [
          { value: 'first', label: 'Track 1 only' },
          { value: 'all', label: 'Every track as its own file' },
          { value: 'mix', label: 'Mix all tracks into one' },
        ],
      },
    ],
    run: videoToAudio,
  },
  {
    id: 'video-compress',
    category: 'video',
    label: 'Compress Video',
    hint: 'Smaller H.264 MP4 for WhatsApp, email or archive',
    accepts: VIDEO_EXTS,
    multi: 'each',
    isDefault: true,
    options: [
      {
        key: 'preset', label: 'Size', type: 'choice', default: 'whatsapp',
        choices: [
          { value: 'whatsapp', label: 'WhatsApp (720p, under ~60 MB)' },
          { value: 'email-small', label: 'Email (480p, under ~22 MB)' },
          { value: 'high-quality', label: 'High quality (full size)' },
        ],
      },
      { key: 'forceCpu', label: 'Use CPU only (skip graphics card)', type: 'toggle', default: false },
    ],
    run: videoCompress,
  },
  {
    id: 'video-to-mp4',
    category: 'video',
    label: 'Convert to MP4',
    hint: 'MOV, MKV, AVI, WEBM and more to MP4',
    accepts: VIDEO_EXTS.filter((e) => e !== '.mp4'),
    multi: 'each',
    options: [
      {
        key: 'mode', label: 'Method', type: 'choice', default: 'auto',
        choices: [
          { value: 'auto', label: 'Fastest (repackage when possible)' },
          { value: 'reencode', label: 'Always re-encode (most compatible)' },
        ],
      },
      { key: 'forceCpu', label: 'Use CPU only (skip graphics card)', type: 'toggle', default: false },
    ],
    run: videoToMp4,
  },
  {
    id: 'video-trim',
    category: 'video',
    label: 'Trim Video',
    hint: 'Cut a section out by start and end time',
    accepts: VIDEO_EXTS,
    multi: 'each',
    options: [
      { key: 'start', label: 'Start (e.g. 1:30)', type: 'text', default: '0' },
      { key: 'end', label: 'End (empty = to the end)', type: 'text', default: '' },
      { key: 'frameAccurate', label: 'Frame accurate (slower, re-encodes to MP4)', type: 'toggle', default: false },
    ],
    run: videoTrim,
  },
  {
    id: 'video-to-gif',
    category: 'video',
    label: 'Video to GIF',
    hint: 'Turn a short clip into a looping GIF',
    accepts: VIDEO_EXTS,
    multi: 'each',
    options: [
      { key: 'fps', label: 'Frames per second', type: 'number', default: 12 },
      { key: 'width', label: 'Width (pixels)', type: 'number', default: 480 },
      { key: 'start', label: 'Start (e.g. 0:05)', type: 'text', default: '0' },
      { key: 'duration', label: 'Length in seconds (0 = to the end)', type: 'number', default: 5 },
    ],
    run: videoToGif,
  },
];

module.exports = {
  tools,
  // Shared with transcribe.js and tests.
  VIDEO_EXTS, AUDIO_EXTS, ALL_MEDIA_EXTS,
  probe, runFfmpeg, parseTimecode, nvencAvailable, friendlyError, fmtTime,
};
