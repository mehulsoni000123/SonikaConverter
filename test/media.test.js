'use strict';
// Real tests for src/engine/media.js. Run: node test/media.test.js
// Generates fixtures with ffmpeg into test/fixtures/media, writes outputs to test/fixtures/media/out (wiped each run).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('../src/engine/util');
const media = require('../src/engine/media');

const FIX = path.join(__dirname, 'fixtures', 'media');
const OUT = path.join(FIX, 'out');
const ffmpeg = util.findFfmpeg({});
const ffprobe = util.findFfprobe({});
const tool = (id) => media.tools.find((t) => t.id === id);
const defaults = (t) => Object.fromEntries(t.options.map((o) => [o.key, o.default]));

let pass = 0;
let fail = 0;
const speeds = [];

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
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed: ${(r.stderr || '').slice(-400)}`);
  return r.stdout;
}

function probe(file) {
  const j = JSON.parse(sh(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  return {
    duration: parseFloat(j.format.duration),
    a: j.streams.filter((s) => s.codec_type === 'audio'),
    v: j.streams.filter((s) => s.codec_type === 'video'),
    format: j.format,
  };
}

function gen(name, args) {
  const p = path.join(FIX, name);
  if (!fs.existsSync(p)) sh(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y'].concat(args, [p]));
  return p;
}

function ctxFor(sub, extra) {
  const dir = path.join(OUT, sub);
  fs.mkdirSync(dir, { recursive: true });
  return Object.assign({ outDir: dir, settings: {}, onProgress: () => {}, signal: undefined }, extra || {});
}

function near(actual, expected, tol, what) {
  assert.ok(Math.abs(actual - expected) <= tol, `${what || 'value'} ${actual} not within ${tol} of ${expected}`);
}

async function main() {
  fs.mkdirSync(FIX, { recursive: true });
  util.removeDir(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  // ---------------- fixtures
  const SRC = ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6'];
  const av = gen('av.mp4', SRC.concat(['-ac', '2', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest']));
  const noaudio = gen('noaudio.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const multi = gen('multitrack.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-f', 'lavfi', '-i', 'sine=f=880:d=4', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-g', '25', '-c:a:0', 'aac', '-c:a:1', 'libmp3lame']);
  const movPcm = gen('pcm.mov', SRC.concat(['-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16be', '-shortest']));
  const webm = gen('vp9.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-c:a', 'libopus', '-shortest']);
  const avi = gen('mpeg4.avi', ['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-shortest']);
  const vertical = gen('vertical.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  const audioOnly = gen('tone.wav', ['-f', 'lavfi', '-i', 'sine=f=300:d=3:sample_rate=44100']);
  // 10-minute 720p file with stereo audio, for speed measurement and cancel tests.
  const long = gen('long10min.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=600', '-f', 'lavfi', '-i', 'sine=f=220:sample_rate=48000:d=600',
    '-ac', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest']);
  const uniName = path.join(FIX, 'मेरा video (final) #2.mp4');
  if (!fs.existsSync(uniName)) fs.copyFileSync(av, uniName);

  // ---------------- contract
  await check('contract: every tool has the required fields and one default per category', () => {
    const ids = new Set();
    for (const t of media.tools) {
      assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id), 'kebab id ' + t.id);
      assert.ok(!ids.has(t.id)); ids.add(t.id);
      assert.ok(['audio', 'video'].includes(t.category));
      assert.ok(t.label && t.hint && typeof t.run === 'function');
      assert.ok(t.accepts.length && t.accepts.every((e) => e === e.toLowerCase() && e.startsWith('.')));
      assert.ok(['each', 'combine'].includes(t.multi));
      for (const o of t.options) {
        assert.ok(['choice', 'number', 'text', 'toggle'].includes(o.type));
        if (o.type === 'choice') assert.ok(o.choices.some((c) => c.value === o.default), 'default in choices for ' + o.key);
      }
    }
    assert.strictEqual(media.tools.filter((t) => t.category === 'audio' && t.isDefault).length, 1);
    assert.strictEqual(media.tools.filter((t) => t.category === 'video' && t.isDefault).length, 1);
    assert.strictEqual(tool('video-to-audio').isDefault, true);
    assert.strictEqual(tool('video-compress').isDefault, true);
    for (const e of ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.mxf', '.wmv', '.flv', '.3gp', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']) {
      assert.ok(tool('video-to-audio').accepts.includes(e), 'video-to-audio accepts ' + e);
    }
  });

  // ---------------- video-to-audio
  const v2a = tool('video-to-audio');
  const expect = {
    'mp3-320': { ext: '.mp3', codec: 'mp3', kbps: 320 },
    'mp3-192': { ext: '.mp3', codec: 'mp3', kbps: 192 },
    'wav-48k': { ext: '.wav', codec: 'pcm_s16le', rate: 48000 },
    m4a: { ext: '.m4a', codec: 'aac' },
    copy: { ext: '.m4a', codec: 'aac' },
    flac: { ext: '.flac', codec: 'flac' },
  };
  for (const fmt of v2a.options.find((o) => o.key === 'format').choices.map((c) => c.value)) {
    await check(`video-to-audio format ${fmt}`, async () => {
      const ctx = ctxFor('v2a-' + fmt);
      let progressed = false;
      ctx.onProgress = (f) => { if (f > 0) progressed = true; };
      const r = await v2a.run([av], { ...defaults(v2a), format: fmt }, ctx);
      assert.strictEqual(r.outputs.length, 1);
      const out = r.outputs[0];
      assert.strictEqual(path.extname(out), expect[fmt].ext);
      const p = probe(out);
      assert.strictEqual(p.v.length, 0, 'no video in audio output');
      assert.strictEqual(p.a[0].codec_name, expect[fmt].codec);
      if (expect[fmt].rate) assert.strictEqual(Number(p.a[0].sample_rate), expect[fmt].rate);
      if (expect[fmt].kbps) near(Number(p.format.bit_rate) / 1000, expect[fmt].kbps, 15, 'bitrate');
      near(p.duration, 6, 0.15, 'duration');
      assert.ok(progressed, 'progress reported');
      assert.ok(typeof r.message === 'string' && r.message.length > 10);
    });
  }

  await check('video-to-audio copy of big-endian PCM (MOV) gives a valid WAV', async () => {
    const r = await v2a.run([movPcm], { format: 'copy' }, ctxFor('v2a-pcm'));
    assert.strictEqual(path.extname(r.outputs[0]), '.wav');
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.a[0].codec_name, 'pcm_s16le');
    near(p.duration, 6, 0.15, 'duration');
  });

  await check('video-to-audio from an audio-only WAV to MP3', async () => {
    const r = await v2a.run([audioOnly], { format: 'mp3-192' }, ctxFor('v2a-wav'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.a[0].codec_name, 'mp3');
    near(p.duration, 3, 0.15, 'duration');
  });

  await check('video-to-audio multi-track: first track only, message says so', async () => {
    const r = await v2a.run([multi], { format: 'mp3-320', tracks: 'first' }, ctxFor('v2a-multi-first'));
    assert.strictEqual(r.outputs.length, 1);
    assert.match(r.message, /2 audio tracks/);
  });
  await check('video-to-audio multi-track: every track separately (copy keeps each codec)', async () => {
    const r = await v2a.run([multi], { format: 'copy', tracks: 'all' }, ctxFor('v2a-multi-all'));
    assert.strictEqual(r.outputs.length, 2);
    assert.deepStrictEqual(r.outputs.map((o) => path.extname(o)).sort(), ['.m4a', '.mp3']);
    r.outputs.forEach((o) => near(probe(o).duration, 4, 0.15, 'duration'));
  });
  await check('video-to-audio multi-track: mix into one', async () => {
    const r = await v2a.run([multi], { format: 'wav-48k', tracks: 'mix' }, ctxFor('v2a-multi-mix'));
    assert.strictEqual(r.outputs.length, 1);
    assert.match(path.basename(r.outputs[0]), /mixed/);
    near(probe(r.outputs[0]).duration, 4, 0.15, 'duration');
  });

  await check('video-to-audio on a file with no audio gives a clear error', async () => {
    await assert.rejects(v2a.run([noaudio], { format: 'mp3-320' }, ctxFor('v2a-noaudio')), /has no audio track/);
    assert.strictEqual(fs.readdirSync(path.join(OUT, 'v2a-noaudio')).length, 0);
  });

  await check('video-to-audio with a unicode, space and # file name, output next to input', async () => {
    const r = await v2a.run([uniName], { format: 'mp3-320' }, { outDir: null, settings: {}, onProgress: () => {} });
    assert.strictEqual(r.outputs[0], path.join(FIX, 'मेरा video (final) #2.mp3'));
    near(probe(r.outputs[0]).duration, 6, 0.15, 'duration');
    fs.rmSync(r.outputs[0]);
  });

  await check('video-to-audio never overwrites: second run makes "name (2)"', async () => {
    const ctx = ctxFor('v2a-twice');
    const a = await v2a.run([av], { format: 'mp3-192' }, ctx);
    const b = await v2a.run([av], { format: 'mp3-192' }, ctx);
    assert.strictEqual(path.basename(a.outputs[0]), 'av.mp3');
    assert.strictEqual(path.basename(b.outputs[0]), 'av (2).mp3');
  });

  await check('video-to-audio missing input gives a clear error', async () => {
    await assert.rejects(v2a.run([path.join(FIX, 'does not exist.mp4')], { format: 'mp3-320' }, ctxFor('v2a-missing')), /could not be found/);
  });

  await check('video-to-audio on a damaged file gives a clear error', async () => {
    const bad = path.join(OUT, 'broken.mp4');
    fs.writeFileSync(bad, Buffer.alloc(5000, 7));
    await assert.rejects(v2a.run([bad], { format: 'mp3-320' }, ctxFor('v2a-broken')), /could not be read/);
  });

  // Speed on a known 10-minute file.
  for (const fmt of ['mp3-320', 'copy', 'wav-48k', 'm4a']) {
    await check(`video-to-audio speed, 10-minute 720p file, ${fmt}`, async () => {
      const t0 = Date.now();
      const r = await v2a.run([long], { format: fmt }, ctxFor('speed-' + fmt));
      const secs = (Date.now() - t0) / 1000;
      near(probe(r.outputs[0]).duration, 600, 0.5, 'duration');
      speeds.push(`${fmt}: 10:00 of media in ${secs.toFixed(2)} s = ${Math.round(600 / secs)}x real time`);
    });
  }

  await check('video-to-audio cancel mid-job leaves no partial file', async () => {
    const ctx = ctxFor('v2a-cancel');
    const ac = new AbortController();
    ctx.signal = ac.signal;
    ctx.onProgress = (f) => { if (f > 0.05) ac.abort(); };
    await assert.rejects(v2a.run([long], { format: 'flac' }, ctx), /Cancelled/);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(fs.readdirSync(ctx.outDir), []);
  });

  // ---------------- video-compress
  const comp = tool('video-compress');
  const gpu = await media.nvencAvailable({ settings: {} });
  console.log(`INFO  NVENC (h264_nvenc) available on this PC: ${gpu}`);
  for (const preset of ['whatsapp', 'email-small', 'high-quality']) {
    await check(`video-compress ${preset} (vertical 1080x1920 source)`, async () => {
      const r = await comp.run([vertical], { preset, forceCpu: false }, ctxFor('comp-' + preset));
      const p = probe(r.outputs[0]);
      assert.strictEqual(p.v[0].codec_name, 'h264');
      assert.strictEqual(p.a[0].codec_name, 'aac');
      assert.strictEqual(p.v[0].pix_fmt, 'yuv420p');
      const short = Math.min(p.v[0].width, p.v[0].height);
      const exp = { whatsapp: 720, 'email-small': 480, 'high-quality': 1080 }[preset];
      assert.strictEqual(short, exp, 'short side');
      assert.ok(p.v[0].height > p.v[0].width, 'stays vertical');
      near(p.duration, 4, 0.2, 'duration');
      if (gpu) assert.match(r.message, /graphics card/);
    });
  }
  await check('video-compress force CPU uses libx264', async () => {
    const r = await comp.run([av], { preset: 'whatsapp', forceCpu: true }, ctxFor('comp-cpu'));
    assert.match(r.message, /using the CPU/);
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    assert.strictEqual(p.v[0].height, 360, 'no upscaling of a 360p source');
  });
  await check('video-compress on a file without audio still works', async () => {
    const r = await comp.run([noaudio], { preset: 'email-small' }, ctxFor('comp-noaudio'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.a.length, 0);
    near(p.duration, 3, 0.2, 'duration');
  });
  await check('video-compress cancel mid-job leaves no partial file', async () => {
    const ctx = ctxFor('comp-cancel');
    const ac = new AbortController();
    ctx.signal = ac.signal;
    ctx.onProgress = (f) => { if (f > 0.02) ac.abort(); };
    await assert.rejects(comp.run([long], { preset: 'high-quality', forceCpu: true }, ctx), /Cancelled/);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepStrictEqual(fs.readdirSync(ctx.outDir), []);
  });

  // ---------------- video-to-mp4
  const tomp4 = tool('video-to-mp4');
  await check('video-to-mp4 AVI (mpeg4 + mp3) is repackaged without re-encoding', async () => {
    const r = await tomp4.run([avi], { mode: 'auto' }, ctxFor('mp4-avi'));
    assert.match(r.message, /Repackaged/);
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'mpeg4');
    assert.strictEqual(p.a[0].codec_name, 'mp3');
    near(p.duration, 3, 0.2, 'duration');
  });
  await check('video-to-mp4 MOV with PCM audio: video copied, audio converted to AAC', async () => {
    const r = await tomp4.run([movPcm], { mode: 'auto' }, ctxFor('mp4-mov'));
    assert.match(r.message, /audio converted/);
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    assert.strictEqual(p.a[0].codec_name, 'aac');
    near(p.duration, 6, 0.2, 'duration');
  });
  await check('video-to-mp4 WEBM (VP9 + Opus) is re-encoded to H.264 + AAC', async () => {
    const r = await tomp4.run([webm], { mode: 'auto' }, ctxFor('mp4-webm'));
    assert.match(r.message, /Converted/);
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    assert.strictEqual(p.a[0].codec_name, 'aac');
    near(p.duration, 3, 0.2, 'duration');
  });
  await check('video-to-mp4 forced re-encode of an MKV', async () => {
    const r = await tomp4.run([multi], { mode: 'reencode', forceCpu: true }, ctxFor('mp4-mkv'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    assert.strictEqual(p.a.length, 2, 'both audio tracks kept');
    near(p.duration, 4, 0.2, 'duration');
  });

  // ---------------- video-trim
  await check('parseTimecode accepts 90, 1:30, 00:01:30.5, 1:30,5 and rejects nonsense', () => {
    assert.strictEqual(media.parseTimecode('90'), 90);
    assert.strictEqual(media.parseTimecode('1:30'), 90);
    assert.strictEqual(media.parseTimecode('00:01:30.5'), 90.5);
    assert.strictEqual(media.parseTimecode('1:30,5'), 90.5);
    assert.strictEqual(media.parseTimecode(' '), null);
    assert.throws(() => media.parseTimecode('abc'), /not a time I understand/);
    assert.throws(() => media.parseTimecode('1:2:3:4'), /not a time I understand/);
  });
  const trim = tool('video-trim');
  await check('video-trim fast stream-copy cut 0:01 to 0:04', async () => {
    const r = await trim.run([av], { start: '0:01', end: '4', frameAccurate: false }, ctxFor('trim-copy'));
    assert.strictEqual(path.basename(r.outputs[0]), 'av_trim.mp4');
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    near(p.duration, 3, 0.25, 'duration');
  });
  await check('video-trim keeps the source container (MKV)', async () => {
    const r = await trim.run([multi], { start: '1', end: '' }, ctxFor('trim-mkv'));
    assert.strictEqual(path.extname(r.outputs[0]), '.mkv');
    near(probe(r.outputs[0]).duration, 3, 0.25, 'duration');
  });
  await check('video-trim frame accurate 00:00:01.5 to 3.2', async () => {
    const r = await trim.run([av], { start: '00:00:01.5', end: '3.2', frameAccurate: true }, ctxFor('trim-acc'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'h264');
    near(parseFloat(p.v[0].duration), 1.7, 0.07, 'video duration');
  });
  await check('video-trim errors: end before start, start after end of video', async () => {
    await assert.rejects(trim.run([av], { start: '4', end: '2' }, ctxFor('trim-err')), /end time must be after/);
    await assert.rejects(trim.run([av], { start: '1:00', end: '' }, ctxFor('trim-err')), /after the end of the video/);
    await assert.rejects(trim.run([av], { start: 'soon', end: '' }, ctxFor('trim-err')), /not a time I understand/);
    assert.deepStrictEqual(fs.readdirSync(path.join(OUT, 'trim-err')), []);
  });

  // ---------------- video-to-gif
  const gif = tool('video-to-gif');
  await check('video-to-gif with defaults (12 fps, 480 wide, 5 s)', async () => {
    const r = await gif.run([av], defaults(gif), ctxFor('gif-default'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].codec_name, 'gif');
    assert.strictEqual(p.v[0].width, 480);
    near(p.duration, 5, 0.2, 'duration');
  });
  await check('video-to-gif custom fps 10, width 320, start 0:01, 2 s', async () => {
    const r = await gif.run([uniName], { fps: 10, width: 320, start: '0:01', duration: 2 }, ctxFor('gif-custom'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].width, 320);
    assert.strictEqual(p.v[0].height, 180);
    near(p.duration, 2, 0.15, 'duration');
    assert.strictEqual(path.basename(r.outputs[0]), 'मेरा video (final) #2.gif');
  });
  await check('video-to-gif never upscales a narrow source', async () => {
    const r = await gif.run([noaudio], { fps: 12, width: 1000, start: '0', duration: 0 }, ctxFor('gif-small'));
    const p = probe(r.outputs[0]);
    assert.strictEqual(p.v[0].width, 320);
    near(p.duration, 3, 0.2, 'duration');
  });

  // ---------------- done
  console.log('');
  for (const s of speeds) console.log(`SPEED ${s}`);
  console.log(`\nmedia.test.js: ${pass} passed, ${fail} failed`);
  util.removeDir(OUT);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.log('FAIL  test runner crashed: ' + (err && err.stack)); process.exit(1); });
