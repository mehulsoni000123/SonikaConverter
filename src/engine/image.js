'use strict';
// Image tools: convert, resize, compress. Uses sharp (libvips). Formats sharp cannot read itself are handled here:
//  - BMP: a small built-in decoder.
//  - iPhone HEIC/HEIF (HEVC): sharp's prebuilt binary has no HEVC decoder, so we fall back to FFmpeg and then to
//    Windows' own codecs (WIC). A fallback result is accepted only if its size equals the size stated in the file's
//    header, which catches the classic "only one tile of a tiled HEIC" mistake.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const util = require('./util');
const du = require('./scripts/docutil');

sharp.cache(false);

const READ_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.gif', '.avif', '.heic', '.heif'];
const COMPRESS_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.gif', '.avif'];
const SHARP_OPTS = { failOn: 'error', limitInputPixels: false };

// ------------------------------------------------------------------ BMP decoder (sharp has none)
function decodeBmp(buf) {
  if (buf.length < 26 || buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP');
  const dataOff = buf.readUInt32LE(10);
  const hdr = buf.readUInt32LE(14);
  let w; let h; let bpp; let comp = 0; let colors = 0; let palOff; let palStep = 4;
  if (hdr === 12) {
    w = buf.readUInt16LE(18); h = buf.readUInt16LE(20); bpp = buf.readUInt16LE(24); palOff = 26; palStep = 3;
  } else {
    w = buf.readInt32LE(18); h = buf.readInt32LE(22); bpp = buf.readUInt16LE(28); comp = buf.readUInt32LE(30); colors = buf.readUInt32LE(46);
    palOff = 14 + hdr;
  }
  const topDown = h < 0; h = Math.abs(h);
  if (w <= 0 || h <= 0 || w > 60000 || h > 60000) throw new Error('bad BMP size');
  if (comp !== 0 && comp !== 3) throw new Error('compressed BMP files are not supported');
  let masks = null;
  if (comp === 3 || (hdr >= 52 && (bpp === 16 || bpp === 32))) {
    const mo = hdr === 40 ? 54 : 54;
    masks = [buf.readUInt32LE(mo), buf.readUInt32LE(mo + 4), buf.readUInt32LE(mo + 8), hdr >= 56 ? buf.readUInt32LE(mo + 12) : 0];
    if (hdr === 40) palOff = 14 + hdr + 12;
  }
  const pal = [];
  if (bpp <= 8) {
    const n = colors || (1 << bpp);
    for (let i = 0; i < n; i += 1) { const o = palOff + i * palStep; pal.push([buf[o + 2], buf[o + 1], buf[o]]); }
  }
  const rowSize = Math.floor((bpp * w + 31) / 32) * 4;
  if (dataOff + rowSize * h > buf.length + 4) throw new Error('truncated BMP');
  const out = Buffer.alloc(w * h * 4);
  const shift = (mask) => { if (!mask) return [0, 0]; let s = 0; let m = mask; while (!(m & 1)) { m >>>= 1; s += 1; } let bits = 0; while (m & 1) { m >>>= 1; bits += 1; } return [s, bits]; };
  const scale = (v, bits) => (bits >= 8 ? v >> (bits - 8) : Math.round((v * 255) / ((1 << bits) - 1)));
  let useAlpha = false;
  for (let y = 0; y < h; y += 1) {
    const row = dataOff + (topDown ? y : h - 1 - y) * rowSize;
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      let r; let g; let b; let a = 255;
      if (bpp === 24) { b = buf[row + x * 3]; g = buf[row + x * 3 + 1]; r = buf[row + x * 3 + 2]; }
      else if (bpp === 32) {
        const v = buf.readUInt32LE(row + x * 4);
        if (masks && comp === 3) {
          const [rs, rb] = shift(masks[0]); const [gs, gb] = shift(masks[1]); const [bs, bb] = shift(masks[2]); const [as, ab] = shift(masks[3]);
          r = scale((v & masks[0]) >>> rs, rb); g = scale((v & masks[1]) >>> gs, gb); b = scale((v & masks[2]) >>> bs, bb);
          if (ab) { a = scale((v & masks[3]) >>> as, ab); if (a) useAlpha = true; }
        } else { b = v & 255; g = (v >>> 8) & 255; r = (v >>> 16) & 255; }
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(row + x * 2);
        if (masks && comp === 3) {
          const [rs, rb] = shift(masks[0]); const [gs, gb] = shift(masks[1]); const [bs, bb] = shift(masks[2]);
          r = scale((v & masks[0]) >>> rs, rb); g = scale((v & masks[1]) >>> gs, gb); b = scale((v & masks[2]) >>> bs, bb);
        } else { r = scale((v >> 10) & 31, 5); g = scale((v >> 5) & 31, 5); b = scale(v & 31, 5); }
      } else if (bpp === 8) { [r, g, b] = pal[buf[row + x]] || [0, 0, 0]; }
      else if (bpp === 4) { const byte = buf[row + (x >> 1)]; [r, g, b] = pal[(x & 1) ? byte & 15 : byte >> 4] || [0, 0, 0]; }
      else if (bpp === 1) { const byte = buf[row + (x >> 3)]; [r, g, b] = pal[(byte >> (7 - (x & 7))) & 1] || [0, 0, 0]; }
      else throw new Error('unsupported BMP depth');
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  if (!useAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return { data: out, width: w, height: h, channels: 4 };
}

// ------------------------------------------------------------------ HEIC / generic fallbacks
function findPowershell() {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

/** Insert an ICC profile into a PNG (after IHDR) so sharp converts the colours to sRGB on output. */
function embedIccInPng(png, icc) {
  try {
    if (png.readUInt32BE(0) !== 0x89504e47) return png;
    const ihdrEnd = 8 + 8 + 13 + 4;
    const data = Buffer.concat([Buffer.from('icc\0', 'latin1'), Buffer.from([0]), zlib.deflateSync(icc)]);
    const type = Buffer.from('iCCP', 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
    return Buffer.concat([png.slice(0, ihdrEnd), len, type, data, crc, png.slice(ihdrEnd)]);
  } catch (_) { return png; }
}

async function decodeWithFfmpeg(srcCopy, outPng, settings, signal) {
  const ffmpeg = util.findFfmpeg(settings);
  const attempts = [[], ['-map', '0:v:0']];
  let lastErr;
  for (const extra of attempts) {
    try {
      await util.runProcess(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcCopy, ...extra, '-frames:v', '1', '-pix_fmt', 'rgb24', '-update', '1', outPng], { signal });
      if (fs.existsSync(outPng) && fs.statSync(outPng).size > 0) return;
    } catch (err) { if (du.isCancelled(err)) throw err; lastErr = err; }
  }
  throw lastErr || new Error('FFmpeg could not decode this picture');
}

async function decodeWithWic(srcCopy, outPng, signal) {
  const script = path.join(__dirname, 'scripts', 'wic-decode.ps1');
  const r = await util.runProcess(findPowershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-InFile', srcCopy, '-OutFile', outPng], { signal, okCodes: [0, 2] });
  if (!/SONIKA:OK/.test(r.stdout) || !fs.existsSync(outPng)) throw new Error('Windows could not decode this picture');
}

/**
 * Decode a picture sharp cannot read into a temp PNG, verifying its size against the header.
 * Returns { input: Buffer(PNG), cleanup() }.
 */
async function fallbackDecode(file, settings, signal) {
  const tmp = util.makeTempDir('sonika-img-');
  const cleanup = () => util.removeDir(tmp);
  try {
    const ext = path.extname(file).toLowerCase();
    const srcCopy = path.join(tmp, `src${ext}`);
    fs.copyFileSync(file, srcCopy);
    let expect = null; let icc = null;
    try { const m = await sharp(file, SHARP_OPTS).metadata(); if (m.width && m.height) expect = { w: m.width, h: m.height }; icc = m.icc || null; } catch (_) { /* header unreadable */ }
    const tries = [
      ['FFmpeg', (out) => decodeWithFfmpeg(srcCopy, out, settings, signal)],
      ['Windows', (out) => decodeWithWic(srcCopy, out, signal)],
    ];
    const problems = [];
    for (const [name, fn] of tries) {
      du.checkAbort(signal);
      const out = path.join(tmp, `out-${name}.png`);
      try {
        await fn(out);
        const png = fs.readFileSync(out);
        const m = await sharp(png, SHARP_OPTS).metadata();
        if (expect && (m.width !== expect.w || m.height !== expect.h)) {
          problems.push(`${name} produced ${m.width}x${m.height} but the file says ${expect.w}x${expect.h}`);
          continue;
        }
        const input = icc ? embedIccInPng(png, icc) : png;
        return { input, cleanup, via: name };
      } catch (err) {
        if (du.isCancelled(err)) throw err;
        problems.push(`${name}: ${String(err.message).split('\n')[0].slice(0, 120)}`);
      }
    }
    cleanup();
    const isHeic = ext === '.heic' || ext === '.heif';
    const e = new Error(isHeic
      ? 'This HEIC picture could not be decoded reliably on this PC, so I did not convert it (a wrong result would be worse than none). Opening it in the Photos app and exporting a JPG is a workaround.'
      : `"${path.basename(file)}" could not be read as a picture. It may be damaged or not really a ${ext.slice(1).toUpperCase()} file.`);
    e.detail = problems.join(' | ');
    throw e;
  } catch (err) { cleanup(); throw err; }
}

function needsFallback(err, ext) {
  const m = String(err && err.message);
  if (/unsupported image format|Input file contains unsupported/i.test(m)) return true;
  if (['.heic', '.heif'].includes(ext) && /heif|hevc|plugin|decoder|compression format|bad seek|vips/i.test(m)) return true;
  return false;
}

function friendlyDecodeError(err, file) {
  const name = path.basename(file);
  const m = String(err && err.message);
  if (err && err.code && /^E[A-Z]+$/.test(err.code)) return du.friendlyFsError(err, name);
  if (/Cancelled/.test(m)) return err;
  if (err && err.detail) return err; // our own fully worded message
  if (/FFmpeg was not found/.test(m)) return err;
  return new Error(`"${name}" could not be read as a picture. It may be damaged or not really a ${path.extname(file).slice(1).toUpperCase()} file.`);
}

/**
 * Run `work(src)` where src = { input, opts }, for a picture file. Handles BMP and fallbacks.
 * work receives a function make(extraOpts) that creates a fresh sharp instance for the decoded picture.
 */
async function withPicture(file, settings, signal, work) {
  du.assertInputFile(file);
  const ext = path.extname(file).toLowerCase();
  let input = file;
  let cleanup = () => {};
  try {
    if (ext === '.bmp') {
      let png;
      try {
        const bmp = decodeBmp(du.readFileFriendly(file));
        png = await sharp(bmp.data, { raw: { width: bmp.width, height: bmp.height, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
      } catch (err) {
        if (err.code) throw err;
        // Unusual BMP variants: let FFmpeg try.
        const fb = await fallbackDecode(file, settings, signal);
        png = fb.input; fb.cleanup();
      }
      input = png;
    }
    const make = (extra) => sharp(input, Object.assign({}, SHARP_OPTS, extra || {}));
    try {
      return await work(make);
    } catch (err) {
      if (du.isCancelled(err) || !needsFallback(err, ext) || ext === '.bmp') throw err;
      du.checkAbort(signal);
      const fb = await fallbackDecode(file, settings, signal);
      cleanup = fb.cleanup;
      input = fb.input;
      return await work(make);
    }
  } catch (err) {
    throw friendlyDecodeError(err, file);
  } finally {
    cleanup();
  }
}

// ------------------------------------------------------------------ helpers
function clampQuality(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function orientedSize(meta) {
  const swap = meta.orientation && meta.orientation >= 5;
  return swap ? { w: meta.height, h: meta.width } : { w: meta.width, h: meta.height };
}

const OUT_FORMATS = {
  jpg: { ext: '.jpg', label: 'JPG' },
  png: { ext: '.png', label: 'PNG' },
  webp: { ext: '.webp', label: 'WebP' },
};

/** Apply an output format to a sharp pipeline. */
function applyFormat(pipe, fmt, quality, hasAlpha) {
  if (fmt === 'jpg') return pipe.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  if (fmt === 'png') return pipe.png({ compressionLevel: 9, effort: 7 });
  if (fmt === 'webp') return pipe.webp({ quality, effort: 5 });
  if (fmt === 'tiff') return pipe.tiff({ compression: 'lzw' });
  if (fmt === 'gif') return pipe.gif({ effort: 7 });
  if (fmt === 'avif') return pipe.avif({ quality: Math.min(quality, 80), effort: 4 });
  throw new Error(`Unknown output format ${fmt}`);
}

function sameKindFormat(ext) {
  switch (ext) {
    case '.jpg': case '.jpeg': return { fmt: 'jpg', ext: '.jpg' };
    case '.png': return { fmt: 'png', ext: '.png' };
    case '.webp': return { fmt: 'webp', ext: '.webp' };
    case '.tif': case '.tiff': return { fmt: 'tiff', ext };
    case '.gif': return { fmt: 'gif', ext: '.gif' };
    case '.avif': return { fmt: 'avif', ext: '.avif' };
    case '.bmp': return { fmt: 'png', ext: '.png' };
    default: return { fmt: 'jpg', ext: '.jpg' }; // heic / heif
  }
}

function prepare(pipe, meta) {
  let p = pipe.rotate(); // honour the EXIF orientation (rotate to upright)
  if (meta && meta.space === 'cmyk') p = p.toColourspace('srgb');
  return p;
}

// ------------------------------------------------------------------ tools
const qualityOption = { key: 'quality', label: 'Quality (JPG / WebP, 1-100)', type: 'number', default: 90 };

const imageConvert = {
  id: 'image-convert',
  category: 'image',
  label: 'Convert image',
  hint: 'JPG, PNG or WebP from almost any picture, including iPhone HEIC',
  accepts: READ_EXTS,
  multi: 'each',
  isDefault: true,
  options: [
    { key: 'format', label: 'Convert to', type: 'choice', default: 'jpg', choices: [
      { value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' },
    ] },
    qualityOption,
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const fmt = OUT_FORMATS[(options && options.format) || 'jpg'] ? ((options && options.format) || 'jpg') : 'jpg';
    const quality = clampQuality(options && options.quality, 90);
    const outDir = util.resolveOutDir(inputs, ctx);
    ctx.onProgress(0.05, 'Reading the picture');
    const inExt = path.extname(input).toLowerCase();
    const result = await withPicture(input, ctx.settings, ctx.signal, async (make) => {
      const animated = inExt === '.gif' && fmt === 'webp';
      const probe = make({ animated });
      const meta = await probe.metadata();
      du.checkAbort(ctx.signal);
      ctx.onProgress(0.3, 'Converting');
      let pipe = make({ animated });
      pipe = animated ? pipe : prepare(pipe, meta);
      pipe = applyFormat(pipe, fmt, quality, meta.hasAlpha);
      const buf = await pipe.toBuffer({ resolveWithObject: true });
      return { buf: buf.data, info: buf.info };
    });
    du.checkAbort(ctx.signal);
    const outPath = du.writeUnique(outDir, du.baseNameNoExt(input), OUT_FORMATS[fmt].ext, result.buf);
    ctx.onProgress(1, 'Done');
    return {
      outputs: [outPath],
      message: `Converted ${path.basename(input)} to ${OUT_FORMATS[fmt].label} (${result.info.width}x${result.info.height}, ${du.formatSize(result.buf.length)}).`,
    };
  },
};

const imageResize = {
  id: 'image-resize',
  category: 'image',
  label: 'Resize image',
  hint: 'Instagram size, 4K, half size or a width you choose',
  accepts: READ_EXTS,
  multi: 'each',
  options: [
    { key: 'preset', label: 'Size', type: 'choice', default: 'instagram-1080', choices: [
      { value: 'instagram-1080', label: 'Instagram (long side 1080 px)' },
      { value: '4k-3840', label: '4K (long side 3840 px)' },
      { value: 'half', label: 'Half size' },
      { value: 'custom', label: 'Custom width' },
    ] },
    { key: 'width', label: 'Custom width (px)', type: 'number', default: 1920 },
    { key: 'allowUpscale', label: 'Allow making small pictures bigger', type: 'toggle', default: false },
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const preset = (options && options.preset) || 'instagram-1080';
    const allowUp = !!(options && options.allowUpscale);
    const customW = Math.round(Number(options && options.width));
    if (preset === 'custom' && !(customW >= 1 && customW <= 30000)) throw new Error('Type a width between 1 and 30000 pixels.');
    if (!['instagram-1080', '4k-3840', 'half', 'custom'].includes(preset)) throw new Error(`Unknown size choice "${preset}".`);
    const outDir = util.resolveOutDir(inputs, ctx);
    const inExt = path.extname(input).toLowerCase();
    const target = sameKindFormat(inExt);
    ctx.onProgress(0.05, 'Reading the picture');
    const result = await withPicture(input, ctx.settings, ctx.signal, async (make) => {
      const animated = inExt === '.gif';
      const meta = await make({ animated }).metadata();
      const { w, h } = orientedSize(meta);
      const frameH = animated && meta.pageHeight ? meta.pageHeight : h;
      let nw; let nh;
      if (preset === 'half') { nw = Math.max(1, Math.round(w / 2)); nh = Math.max(1, Math.round(frameH / 2)); }
      else {
        let scale;
        if (preset === 'custom') scale = customW / w;
        else scale = (preset === '4k-3840' ? 3840 : 1080) / Math.max(w, frameH);
        if (scale > 1 && !allowUp) scale = 1;
        nw = Math.max(1, Math.round(w * scale)); nh = Math.max(1, Math.round(frameH * scale));
      }
      du.checkAbort(ctx.signal);
      ctx.onProgress(0.3, 'Resizing');
      let pipe = make({ animated });
      pipe = animated ? pipe : prepare(pipe, meta);
      if (nw !== w || nh !== frameH) pipe = pipe.resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' });
      pipe = applyFormat(pipe, target.fmt, 90, meta.hasAlpha);
      const out = await pipe.toBuffer({ resolveWithObject: true });
      return { buf: out.data, w: nw, h: nh, origW: w, origH: frameH, unchanged: nw === w && nh === frameH };
    });
    du.checkAbort(ctx.signal);
    const outPath = du.writeUnique(outDir, `${du.baseNameNoExt(input)} ${result.w}x${result.h}`, target.ext, result.buf);
    ctx.onProgress(1, 'Done');
    const note = result.unchanged ? ' (already that size or smaller, so the size was kept)' : '';
    return { outputs: [outPath], message: `Resized ${path.basename(input)} from ${result.origW}x${result.origH} to ${result.w}x${result.h}${note}: ${du.formatSize(result.buf.length)}.` };
  },
};

const COMPRESS_LEVELS = {
  light: { q: 85, png: { palette: false }, colours: 256, tiff: 'lzw' },
  balanced: { q: 75, png: { palette: true, quality: 85, colours: 256 }, colours: 192, tiff: 'deflate' },
  strong: { q: 60, png: { palette: true, quality: 65, colours: 128 }, colours: 96, tiff: 'jpeg' },
};

const imageCompress = {
  id: 'image-compress',
  category: 'image',
  label: 'Compress image',
  hint: 'Make the file smaller, same format',
  accepts: COMPRESS_EXTS,
  multi: 'each',
  options: [
    { key: 'level', label: 'Compression', type: 'choice', default: 'balanced', choices: [
      { value: 'light', label: 'Light (best quality)' },
      { value: 'balanced', label: 'Balanced' },
      { value: 'strong', label: 'Strong (smallest file)' },
    ] },
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const name = path.basename(input);
    const levelKey = (options && options.level) || 'balanced';
    const L = COMPRESS_LEVELS[levelKey];
    if (!L) throw new Error(`Unknown compression level "${levelKey}".`);
    const outDir = util.resolveOutDir(inputs, ctx);
    const origSize = du.assertInputFile(input);
    const inExt = path.extname(input).toLowerCase();
    const target = sameKindFormat(inExt);
    ctx.onProgress(0.05, 'Reading the picture');
    const result = await withPicture(input, ctx.settings, ctx.signal, async (make) => {
      const animated = inExt === '.gif' || inExt === '.webp';
      const meta = await make({ animated }).metadata();
      du.checkAbort(ctx.signal);
      ctx.onProgress(0.3, 'Compressing');
      let pipe = make({ animated });
      pipe = (animated && (meta.pages || 1) > 1) ? pipe : prepare(pipe, meta);
      switch (target.fmt) {
        case 'jpg': pipe = pipe.jpeg({ quality: L.q, mozjpeg: true }); break;
        case 'webp': pipe = pipe.webp({ quality: L.q, effort: 5 }); break;
        case 'png': pipe = pipe.png(Object.assign({ compressionLevel: 9, effort: 10 }, L.png)); break;
        case 'gif': pipe = pipe.gif({ effort: 8, colours: L.colours }); break;
        case 'avif': pipe = pipe.avif({ quality: Math.max(30, L.q - 15), effort: 4 }); break;
        case 'tiff':
          pipe = pipe.tiff(L.tiff === 'jpeg' && !meta.hasAlpha ? { compression: 'jpeg', quality: L.q } : { compression: L.tiff === 'jpeg' ? 'deflate' : L.tiff, predictor: 'horizontal' });
          break;
        default: throw new Error('Unsupported format');
      }
      const out = await pipe.toBuffer({ resolveWithObject: true });
      return { buf: out.data, w: out.info.width, h: out.info.pageHeight || out.info.height };
    });
    du.checkAbort(ctx.signal);
    const base = `${du.baseNameNoExt(input)} compressed`;
    let outPath; let message;
    if (result.buf.length < origSize) {
      outPath = du.writeUnique(outDir, base, target.ext, result.buf);
      const pct = Math.round((1 - result.buf.length / origSize) * 100);
      message = `Compressed ${name}: ${du.formatSize(origSize)} -> ${du.formatSize(result.buf.length)} (${pct}% smaller).`;
    } else {
      outPath = du.copyUnique(input, outDir, base, inExt);
      message = `${name} could not be made any smaller (${du.formatSize(origSize)} before, ${du.formatSize(result.buf.length)} after trying), so the new file is an unchanged copy. It is probably already well compressed.`;
    }
    ctx.onProgress(1, 'Done');
    return { outputs: [outPath], message };
  },
};

// ------------------------------------------------------------------ for images -> PDF (used by pdf.js)
/** Returns { kind: 'jpg'|'png', data: Buffer } ready for pdf-lib, upright and in sRGB. */
async function preparePictureForPdf(file, settings) {
  const ext = path.extname(file).toLowerCase();
  return withPicture(file, settings, null, async (make) => {
    const meta = await make().metadata();
    const plainJpeg = (ext === '.jpg' || ext === '.jpeg') && (!meta.orientation || meta.orientation === 1)
      && (meta.channels === 3 || meta.channels === 1) && (meta.space === 'srgb' || meta.space === 'b-w') && !meta.hasAlpha;
    if (plainJpeg) return { kind: 'jpg', data: fs.readFileSync(file) };
    let pipe = prepare(make(), meta);
    if (meta.hasAlpha) return { kind: 'png', data: await pipe.png({ compressionLevel: 6 }).toBuffer() };
    return { kind: 'jpg', data: await pipe.jpeg({ quality: 92 }).toBuffer() };
  });
}

module.exports = { tools: [imageConvert, imageResize, imageCompress], preparePictureForPdf, decodeBmp };
