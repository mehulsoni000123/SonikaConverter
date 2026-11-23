'use strict';
// Shared helpers for the pdf / office / image tests: tiny test runner, zip reader/writer, fixture builders.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const FIX = __dirname;

// ---------- tiny test runner: one line per check, exit non-zero on any failure ----------
function createRunner(title) {
  let pass = 0; let fail = 0;
  async function check(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      pass += 1;
      console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
    } catch (err) {
      fail += 1;
      console.log(`FAIL  ${name}  -> ${err && err.message ? err.message : err}`);
    }
  }
  function finish() {
    console.log(`\n${title}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
  return { check, finish, counts: () => ({ pass, fail }) };
}

function freshDir(name) {
  const d = path.join(FIX, '_work', name);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ctx(extra) {
  const events = [];
  return Object.assign({
    onProgress: (f, t) => events.push([f, t]),
    signal: new AbortController().signal,
    outDir: null,
    settings: {},
    _events: events,
  }, extra || {});
}

async function expectError(promise, regex, label) {
  try { await promise; } catch (err) {
    if (regex && !regex.test(err.message)) throw new Error(`${label || 'error'} message was "${err.message}", expected ${regex}`);
    return err;
  }
  throw new Error(`${label || 'call'} should have failed but succeeded`);
}

// ---------- zip (store/deflate) writer + reader ----------
function zipStore(entries) {
  // entries: [{name, data(Buffer|string)}]  -> Buffer of a valid zip using deflate
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function zipRead(file) {
  // returns { 'name': Buffer }
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const loff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(loff + 26); const lelen = buf.readUInt16LE(loff + 28);
    const data = buf.slice(loff + 30 + lnlen + lelen, loff + 30 + lnlen + lelen + csize);
    out[name] = method === 0 ? data : zlib.inflateRawSync(data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function xmlEsc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** Build a minimal valid .docx with the given paragraphs. */
function makeDocx(file, paragraphs) {
  const body = paragraphs.map((t) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Mangal"/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join('');
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  fs.writeFileSync(file, zipStore([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: docXml },
  ]));
}

// ---------- PDF helpers (mupdf for reading, pdf-lib for building) ----------
let mupdfP = null;
function mupdf() { if (!mupdfP) mupdfP = import('mupdf'); return mupdfP; }

async function pdfInfo(file) {
  const m = await mupdf();
  const d = m.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  if (d.needsPassword()) throw new Error('needs password');
  const pages = d.countPages();
  const texts = [];
  for (let i = 0; i < pages; i += 1) texts.push(d.loadPage(i).toStructuredText('').asText());
  return { pages, texts, text: texts.join('\n') };
}

async function makeTextPdf(file, pageCount, label) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pageCount; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} page ${i} of ${pageCount}`, { x: 60, y: 760, size: 24, font, color: rgb(0, 0, 0) });
    page.drawText('The quick brown fox jumps over the lazy dog.', { x: 60, y: 720, size: 14, font });
  }
  fs.writeFileSync(file, await doc.save());
}

/** Image-heavy PDF: `pages` pages each with a large noisy photo-like JPEG (so compression has real work to do). */
async function makeImagePdf(file, pages) {
  const sharp = require('sharp');
  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) {
    const w = 2400; const h = 1800;
    const raw = Buffer.alloc(w * h * 3);
    let seed = 12345 + i * 777;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = (seed >> 16) & 31;
        const o = (y * w + x) * 3;
        raw[o] = Math.min(255, (x * 255 / w) + n + (i * 40) % 90);
        raw[o + 1] = Math.min(255, (y * 255 / h) + n);
        raw[o + 2] = Math.min(255, ((x + y) * 127 / (w + h)) + n * 2);
      }
    }
    const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 97 }).toBuffer();
    const img = await doc.embedJpg(jpg);
    const page = doc.addPage([595, 842]);
    page.drawImage(img, { x: 20, y: 200, width: 555, height: 416 });
    page.drawText(`Image heavy page ${i + 1}`, { x: 40, y: 700, size: 20 });
  }
  fs.writeFileSync(file, await doc.save());
}

function listProcs(names) {
  const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && names.some((n) => m[1].toLowerCase() === n.toLowerCase())) out.push(`${m[1]}:${m[2]}`);
  }
  return out.sort();
}

module.exports = {
  FIX, createRunner, freshDir, ctx, expectError, zipStore, zipRead, makeDocx, mupdf, pdfInfo, makeTextPdf, makeImagePdf, listProcs, xmlEsc,
};
