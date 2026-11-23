'use strict';
// PDF tools: merge, split, compress, PDF -> Word, PDF -> images, images -> PDF.
// pdf-lib builds/splits documents, mupdf (WASM, loaded with dynamic import) renders pages and re-compresses images,
// sharp decodes pictures, Microsoft Word (COM) turns PDFs into editable .docx.
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const util = require('./util');
const du = require('./scripts/docutil');
const { runOffice } = require('./scripts/office-runner');

let mupdfPromise = null;
function getMupdf() {
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

const MSG_PASSWORD = (name) => `"${name}" is protected with a password, so it cannot be processed. Remove the password in a PDF viewer first (open it, then save a copy without a password) and try again.`;
const MSG_CORRUPT = (name) => `"${name}" does not look like a valid PDF, or it is damaged.`;

function bufferToU8(b) {
  return Buffer.from(b.asUint8Array());
}

/** Open a PDF with mupdf from a buffer. Throws friendly errors for password / damaged files. */
async function openMupdf(buf, name) {
  const mupdf = await getMupdf();
  let doc;
  try {
    doc = mupdf.Document.openDocument(buf, 'application/pdf');
  } catch (_) {
    throw new Error(MSG_CORRUPT(name));
  }
  if (!doc.isPDF()) throw new Error(MSG_CORRUPT(name));
  if (doc.needsPassword()) throw new Error(MSG_PASSWORD(name));
  return { mupdf, doc };
}

/**
 * Load a PDF with pdf-lib. Falls back to mupdf to repair damaged files and to strip owner-only restrictions
 * (files that open without a password but are flagged "encrypted").
 */
async function loadPdfLib(file) {
  const name = path.basename(file);
  du.assertInputFile(file);
  const buf = du.readFileFriendly(file);
  if (buf.slice(0, 1024).indexOf('%PDF') < 0) throw new Error(MSG_CORRUPT(name));
  try {
    return await PDFDocument.load(buf, { updateMetadata: false });
  } catch (firstErr) {
    const wasEncrypted = /encrypt/i.test(firstErr.message);
    let repaired;
    try {
      const { doc } = await openMupdf(buf, name);
      repaired = bufferToU8(doc.asPDF().saveToBuffer('garbage=compact,encrypt=none'));
    } catch (e2) {
      if (e2.message.includes('password')) throw e2;
      if (wasEncrypted) throw new Error(MSG_PASSWORD(name));
      throw new Error(MSG_CORRUPT(name));
    }
    try {
      return await PDFDocument.load(repaired, { updateMetadata: false });
    } catch (_) {
      throw new Error(wasEncrypted ? MSG_PASSWORD(name) : MSG_CORRUPT(name));
    }
  }
}

function singleOrAll(inputs) { return inputs.filter(Boolean); }

// ---------------------------------------------------------------- merge
const pdfMerge = {
  id: 'pdf-merge',
  category: 'pdf',
  label: 'Merge PDFs',
  hint: 'Join several PDFs into one, in the order shown',
  accepts: ['.pdf'],
  multi: 'combine',
  isDefault: true,
  options: [],
  async run(inputs, options, ctx) {
    const files = singleOrAll(inputs);
    if (!files.length) throw new Error('Add at least one PDF to merge.');
    const outDir = util.resolveOutDir(files, ctx);
    const out = await PDFDocument.create();
    let total = 0;
    for (let i = 0; i < files.length; i += 1) {
      du.checkAbort(ctx.signal);
      ctx.onProgress((i / files.length) * 0.9, `Reading ${path.basename(files[i])}`);
      const src = await loadPdfLib(files[i]);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      total += pages.length;
      ctx.onProgress(((i + 1) / files.length) * 0.9, `Added ${path.basename(files[i])} (${pages.length} pages)`);
    }
    du.checkAbort(ctx.signal);
    ctx.onProgress(0.93, 'Saving');
    const bytes = await out.save();
    du.checkAbort(ctx.signal);
    const outPath = du.writeUnique(outDir, `${du.baseNameNoExt(files[0])} merged`, '.pdf', bytes);
    ctx.onProgress(1, 'Done');
    const note = files.length === 1 ? ' (only one PDF was given, so this is a copy)' : '';
    return { outputs: [outPath], message: `Merged ${files.length} PDF${files.length === 1 ? '' : 's'} into ${total} pages: ${path.basename(outPath)}${note}.` };
  },
};

// ---------------------------------------------------------------- split
/** Parse "1-3, 5, 8-10" against a page count. Returns [{from,to}] (1-based, inclusive). */
function parseRanges(text, pageCount) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Type the pages you want, for example 1-3, 5, 8-10.');
  const out = [];
  for (const part of raw.replace(/\s*[-–]\s*/g, '-').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
    if (!m) throw new Error(`"${part}" is not a valid page range. Use numbers like 1-3, 5, 8-10.`);
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    if (from < 1 || to < 1) throw new Error('Page numbers start at 1.');
    if (to < from) throw new Error(`The range ${part} goes backwards. Write it as ${to}-${from}.`);
    if (from > pageCount || to > pageCount) throw new Error(`The range ${part} is outside this PDF, which has only ${pageCount} page${pageCount === 1 ? '' : 's'}.`);
    out.push({ from, to });
  }
  return out;
}

const pdfSplit = {
  id: 'pdf-split',
  category: 'pdf',
  label: 'Split PDF',
  hint: 'One file per page, or per page range',
  accepts: ['.pdf'],
  multi: 'each',
  options: [
    { key: 'mode', label: 'Split by', type: 'choice', default: 'every-page', choices: [
      { value: 'every-page', label: 'Every page' },
      { value: 'ranges', label: 'Page ranges' },
    ] },
    { key: 'ranges', label: 'Ranges (for "Page ranges")', type: 'text', default: '1-3, 5' },
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const mode = (options && options.mode) || 'every-page';
    const outDir = util.resolveOutDir(inputs, ctx);
    const base = du.baseNameNoExt(input);
    ctx.onProgress(0.02, 'Reading the PDF');
    const src = await loadPdfLib(input);
    const count = src.getPageCount();
    if (count < 1) throw new Error('This PDF has no pages.');
    let jobs;
    if (mode === 'ranges') {
      jobs = parseRanges(options && options.ranges, count);
    } else {
      jobs = Array.from({ length: count }, (_, i) => ({ from: i + 1, to: i + 1 }));
    }
    du.checkAbort(ctx.signal);
    const folder = du.makeUniqueDir(outDir, `${base} pages`);
    const written = [];
    try {
      const pad = String(count).length;
      for (let i = 0; i < jobs.length; i += 1) {
        du.checkAbort(ctx.signal);
        const { from, to } = jobs[i];
        const doc = await PDFDocument.create();
        const idx = [];
        for (let p = from; p <= to; p += 1) idx.push(p - 1);
        (await doc.copyPages(src, idx)).forEach((pg) => doc.addPage(pg));
        const bytes = await doc.save();
        const label = from === to ? `page ${String(from).padStart(pad, '0')}` : `pages ${from}-${to}`;
        written.push(du.writeUnique(folder, `${base} ${label}`, '.pdf', bytes));
        ctx.onProgress((i + 1) / jobs.length * 0.98, `Saved ${path.basename(written[written.length - 1])}`);
      }
    } catch (err) {
      du.removeFiles(written);
      try { fs.rmdirSync(folder); } catch (_) { /* not empty or gone */ }
      throw err;
    }
    ctx.onProgress(1, 'Done');
    return { outputs: written, message: `Split into ${written.length} PDF${written.length === 1 ? '' : 's'} in the folder "${path.basename(folder)}".` };
  },
};

// ---------------------------------------------------------------- compress
const LEVELS = {
  // maxDim: longest side in pixels an embedded picture may keep; quality: JPEG quality 1-100
  light: { maxDim: 2600, quality: 85 },
  balanced: { maxDim: 1700, quality: 72 },
  strong: { maxDim: 1100, quality: 52 },
};

async function recompressImages(pdf, mupdf, level, ctx) {
  const sharp = require('sharp');
  const n = pdf.countObjects();
  // Pictures that are masks of other pictures must keep their exact form.
  const maskNums = new Set();
  const images = [];
  for (let i = 1; i < n; i += 1) {
    let ref;
    try { ref = pdf.newIndirect(i); if (!ref.isStream()) continue; } catch (_) { continue; }
    const st = ref.get('Subtype');
    if (!st || !st.isName() || st.asName() !== 'Image') continue;
    images.push(i);
    for (const key of ['SMask', 'Mask']) {
      const m = ref.get(key);
      if (m && m.isIndirect()) maskNums.add(m.asIndirect());
    }
  }
  let replaced = 0; let savedBytes = 0;
  for (let k = 0; k < images.length; k += 1) {
    du.checkAbort(ctx.signal);
    ctx.onProgress(0.05 + 0.8 * (k / Math.max(1, images.length)), `Shrinking picture ${k + 1} of ${images.length}`);
    const num = images[k];
    if (maskNums.has(num)) continue;
    try {
      const ref = pdf.newIndirect(num);
      const isMask = ref.get('ImageMask');
      if (isMask && isMask.isBoolean() && isMask.asBoolean()) continue;
      const maskObj = ref.get('Mask');
      if (maskObj && maskObj.isArray()) continue; // colour-key mask: only works with the original pixels
      const smask = ref.get('SMask');
      if (smask && !smask.isNull()) { const mt = smask.get('Matte'); if (mt && !mt.isNull()) continue; }
      const filter = ref.get('Filter');
      const fstr = filter ? filter.toString() : '';
      if (/JBIG2|CCITT/.test(fstr)) continue; // black-and-white scans are already tiny
      const oldLen = ref.readRawStream().length;
      const img = pdf.loadImage(ref);
      const w = img.getWidth(); const h = img.getHeight();
      if (w * h < 60000 || img.getBitsPerComponent() === 1) continue;
      let pix = img.toPixmap();
      if (pix.getAlpha()) continue;
      const cs = pix.getColorSpace();
      let channels = pix.getNumberOfComponents();
      if (cs && !(cs.getNumberOfComponents() === 1 || cs.toString() === 'DeviceRGB')) {
        pix = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
        channels = pix.getNumberOfComponents();
      }
      if (channels !== 1 && channels !== 3) continue;
      const pw = pix.getWidth(); const ph = pix.getHeight(); const stride = pix.getStride();
      const px = pix.getPixels();
      let raw;
      if (stride === pw * channels) raw = Buffer.from(px.buffer, px.byteOffset, px.byteLength);
      else {
        raw = Buffer.alloc(pw * ph * channels);
        for (let y = 0; y < ph; y += 1) Buffer.from(px.buffer, px.byteOffset + y * stride, pw * channels).copy(raw, y * pw * channels);
      }
      let pipe = sharp(raw, { raw: { width: pw, height: ph, channels } });
      let nw = pw; let nh = ph;
      const longest = Math.max(pw, ph);
      if (longest > level.maxDim) {
        const s = level.maxDim / longest;
        nw = Math.max(1, Math.round(pw * s)); nh = Math.max(1, Math.round(ph * s));
        pipe = pipe.resize(nw, nh, { kernel: 'lanczos3' });
      }
      const jpg = await pipe.jpeg({ quality: level.quality, mozjpeg: true }).toBuffer();
      if (jpg.length >= oldLen * 0.95) continue; // not worth it
      ref.writeRawStream(jpg);
      ref.put('Filter', pdf.newName('DCTDecode'));
      ref.delete('DecodeParms');
      ref.delete('Decode');
      ref.put('Width', nw);
      ref.put('Height', nh);
      ref.put('BitsPerComponent', 8);
      ref.put('ColorSpace', pdf.newName(channels === 1 ? 'DeviceGray' : 'DeviceRGB'));
      replaced += 1;
      savedBytes += oldLen - jpg.length;
    } catch (_) {
      // Leave this picture exactly as it was if anything about it is unusual.
    }
  }
  return { replaced, total: images.length, savedBytes };
}

const pdfCompress = {
  id: 'pdf-compress',
  category: 'pdf',
  label: 'Compress PDF',
  hint: 'Make a PDF smaller by shrinking its pictures',
  accepts: ['.pdf'],
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
    const level = LEVELS[levelKey];
    if (!level) throw new Error(`Unknown compression level "${levelKey}".`);
    const outDir = util.resolveOutDir(inputs, ctx);
    const origSize = du.assertInputFile(input);
    const buf = du.readFileFriendly(input);
    ctx.onProgress(0.02, 'Opening the PDF');
    const { mupdf, doc } = await openMupdf(buf, name);
    const pdf = doc.asPDF();
    if (!pdf) throw new Error(MSG_CORRUPT(name));
    const stats = await recompressImages(pdf, mupdf, level, ctx);
    du.checkAbort(ctx.signal);
    ctx.onProgress(0.9, 'Cleaning up and saving');
    const saved = bufferToU8(pdf.saveToBuffer('garbage=deduplicate,compress=yes,compress-fonts=yes,objstms=yes'));
    du.checkAbort(ctx.signal);
    const base = `${du.baseNameNoExt(input)} compressed`;
    let outPath; let message;
    if (saved.length < origSize) {
      outPath = du.writeUnique(outDir, base, '.pdf', saved);
      const pct = Math.round((1 - saved.length / origSize) * 100);
      message = `Compressed ${name}: ${du.formatSize(origSize)} -> ${du.formatSize(saved.length)} (${pct}% smaller, ${stats.replaced} of ${stats.total} pictures shrunk).`;
    } else {
      outPath = du.writeUnique(outDir, base, '.pdf', buf);
      message = `This PDF could not be made any smaller (${du.formatSize(origSize)} before, ${du.formatSize(saved.length)} after trying), so the new file is an unchanged copy. It is probably already well compressed or contains mostly text.`;
    }
    ctx.onProgress(1, 'Done');
    return { outputs: [outPath], message };
  },
};

// ---------------------------------------------------------------- PDF -> Word
const pdfToWord = {
  id: 'pdf-to-word',
  category: 'pdf',
  label: 'PDF to Word',
  hint: 'Make an editable .docx using Microsoft Word',
  accepts: ['.pdf'],
  multi: 'each',
  options: [],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const name = path.basename(input);
    const outDir = util.resolveOutDir(inputs, ctx);
    du.assertInputFile(input);
    const bytes = du.readFileFriendly(input);
    if (bytes.slice(0, 1024).indexOf('%PDF') < 0) throw new Error(MSG_CORRUPT(name));
    const { doc } = await openMupdf(bytes, name); // throws the password / damaged messages
    if (doc.countPages() < 1) throw new Error(`"${name}" has no readable pages, so there is nothing to convert.`);
    ctx.onProgress(0.02, 'Getting ready');
    const timeoutSec = (ctx.settings && Number(ctx.settings.officeTimeoutSec)) > 0 ? Number(ctx.settings.officeTimeoutSec) : 240;
    const r = await runOffice({
      app: 'word', action: 'saveas', format: 16, destExt: '.docx', source: input, outDir,
      baseName: du.baseNameNoExt(input), timeoutSec, signal: ctx.signal, onProgress: ctx.onProgress,
    });
    ctx.onProgress(1, 'Done');
    return {
      outputs: [r.outputPath],
      message: `Made ${path.basename(r.outputPath)} in ${r.seconds.toFixed(1)} s using Microsoft Word. Layout may shift a little; scanned PDFs come out as pictures, not editable text.`,
    };
  },
};

// ---------------------------------------------------------------- PDF -> images
const pdfToJpg = {
  id: 'pdf-to-jpg',
  category: 'pdf',
  label: 'PDF to images',
  hint: 'Save every page as a picture',
  accepts: ['.pdf'],
  multi: 'each',
  options: [
    { key: 'dpi', label: 'Sharpness (DPI)', type: 'choice', default: 150, choices: [
      { value: 72, label: '72 (small)' },
      { value: 150, label: '150 (normal)' },
      { value: 300, label: '300 (print)' },
    ] },
    { key: 'format', label: 'Picture type', type: 'choice', default: 'jpg', choices: [
      { value: 'jpg', label: 'JPG' },
      { value: 'png', label: 'PNG' },
    ] },
  ],
  async run(inputs, options, ctx) {
    const input = inputs[0];
    const name = path.basename(input);
    const dpi = [72, 150, 300].includes(Number(options && options.dpi)) ? Number(options.dpi) : 150;
    const format = (options && options.format) === 'png' ? 'png' : 'jpg';
    const outDir = util.resolveOutDir(inputs, ctx);
    du.assertInputFile(input);
    const buf = du.readFileFriendly(input);
    ctx.onProgress(0.02, 'Opening the PDF');
    const { mupdf, doc } = await openMupdf(buf, name);
    const count = doc.countPages();
    if (count < 1) throw new Error('This PDF has no pages.');
    const folder = du.makeUniqueDir(outDir, `${du.baseNameNoExt(input)} images`);
    const written = [];
    try {
      const pad = String(count).length;
      for (let i = 0; i < count; i += 1) {
        du.checkAbort(ctx.signal);
        ctx.onProgress(0.03 + 0.95 * (i / count), `Page ${i + 1} of ${count}`);
        const page = doc.loadPage(i);
        const b = page.getBounds();
        const wPt = Math.abs(b[2] - b[0]); const hPt = Math.abs(b[3] - b[1]);
        let scale = dpi / 72;
        const longPx = Math.max(wPt, hPt) * scale;
        if (longPx > 14000) scale = 14000 / Math.max(wPt, hPt); // keep huge posters from exhausting memory
        const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        const data = format === 'png' ? Buffer.from(pix.asPNG()) : Buffer.from(pix.asJPEG(90, false));
        written.push(du.writeUnique(folder, `${du.baseNameNoExt(input)} page ${String(i + 1).padStart(pad, '0')}`, `.${format}`, data));
      }
    } catch (err) {
      du.removeFiles(written);
      try { fs.rmdirSync(folder); } catch (_) { /* ignore */ }
      throw err;
    }
    ctx.onProgress(1, 'Done');
    return { outputs: written, message: `Saved ${written.length} ${format.toUpperCase()} picture${written.length === 1 ? '' : 's'} (${dpi} DPI) in the folder "${path.basename(folder)}".` };
  },
};

// ---------------------------------------------------------------- images -> PDF
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic'];

const imagesToPdf = {
  id: 'images-to-pdf',
  category: 'pdf',
  label: 'Images to PDF',
  hint: 'One page per picture, in the order shown',
  accepts: IMAGE_EXTS,
  multi: 'combine',
  options: [
    { key: 'page', label: 'Page size', type: 'choice', default: 'fit-image', choices: [
      { value: 'fit-image', label: 'Same as each picture' },
      { value: 'a4', label: 'A4 page' },
    ] },
  ],
  async run(inputs, options, ctx) {
    const files = singleOrAll(inputs);
    if (!files.length) throw new Error('Add at least one picture.');
    const page = (options && options.page) === 'a4' ? 'a4' : 'fit-image';
    const outDir = util.resolveOutDir(files, ctx);
    const image = require('./image');
    const doc = await PDFDocument.create();
    for (let i = 0; i < files.length; i += 1) {
      du.checkAbort(ctx.signal);
      const f = files[i];
      ctx.onProgress((i / files.length) * 0.9, `Adding ${path.basename(f)}`);
      du.assertInputFile(f);
      const pic = await image.preparePictureForPdf(f, ctx.settings);
      // pdf-lib needs a standalone byte array (a Node Buffer can be a slice of a shared pool)
      const bytes = new Uint8Array(pic.data);
      const embedded = pic.kind === 'jpg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
      const iw = embedded.width; const ih = embedded.height;
      let pw; let ph; let x; let y; let dw; let dh;
      if (page === 'a4') {
        const landscape = iw > ih;
        pw = landscape ? 841.89 : 595.28; ph = landscape ? 595.28 : 841.89;
        const margin = 24;
        const s = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih);
        dw = iw * s; dh = ih * s; x = (pw - dw) / 2; y = (ph - dh) / 2;
      } else {
        const s = 72 / 150; // treat pictures as 150 DPI so the page size is sensible
        pw = Math.max(36, iw * s); ph = Math.max(36, ih * s);
        if (Math.max(pw, ph) > 14400) { const k = 14400 / Math.max(pw, ph); pw *= k; ph *= k; }
        dw = pw; dh = ph; x = 0; y = 0;
      }
      const pg = doc.addPage([pw, ph]);
      pg.drawImage(embedded, { x, y, width: dw, height: dh });
    }
    du.checkAbort(ctx.signal);
    ctx.onProgress(0.94, 'Saving');
    const bytes = await doc.save();
    const outPath = du.writeUnique(outDir, `${du.baseNameNoExt(files[0])}${files.length > 1 ? ' images' : ''}`, '.pdf', bytes);
    ctx.onProgress(1, 'Done');
    return { outputs: [outPath], message: `Made a ${files.length}-page PDF: ${path.basename(outPath)}.` };
  },
};

module.exports = {
  tools: [pdfMerge, pdfSplit, pdfCompress, pdfToWord, pdfToJpg, imagesToPdf],
  parseRanges,
};
