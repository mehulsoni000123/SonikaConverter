'use strict';
// node test/pdf.test.js  -  merge / split / compress / PDF->Word / PDF->images / images->PDF (real files, real Word).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const H = require('./fixtures/docs/helpers');
const { makeHeic } = require('./fixtures/docs/make-heic');
const util = require('../src/engine/util');
const pdf = require('../src/engine/pdf');

const tool = (id) => pdf.tools.find((t) => t.id === id);
const norm = (s) => s.replace(/\s+/g, ' ');

async function pageBounds(file) {
  const m = await H.mupdf();
  const d = m.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  const out = [];
  for (let i = 0; i < d.countPages(); i += 1) { const b = d.loadPage(i).getBounds(); out.push([b[2] - b[0], b[3] - b[1]]); }
  return out;
}

async function renderMean(file, pageIndex) {
  const m = await H.mupdf();
  const d = m.Document.openDocument(fs.readFileSync(file), 'application/pdf');
  const pix = d.loadPage(pageIndex).toPixmap(m.Matrix.scale(0.5, 0.5), m.ColorSpace.DeviceRGB, false, true);
  const png = Buffer.from(pix.asPNG());
  const st = await sharp(png).stats();
  return st.channels.map((c) => c.mean);
}

(async () => {
  const R = H.createRunner('pdf.test');
  const { check } = R;
  const work = H.freshDir('pdf');
  const W = (n) => path.join(work, n);
  const OFFICE = ['WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE'];
  const procsAtStart = H.listProcs(OFFICE);

  // ---------------- fixtures ----------------
  await H.makeTextPdf(W('alpha.pdf'), 5, 'Alpha');
  await H.makeTextPdf(W('beta.pdf'), 3, 'Beta');
  await H.makeTextPdf(W('gamma.pdf'), 1, 'Gamma');
  await H.makeTextPdf(W('मेरा file (final) #2.pdf'), 2, 'Unicode');
  await H.makeImagePdf(W('photos.pdf'), 3);
  {
    const m = await H.mupdf();
    const base = m.Document.openDocument(fs.readFileSync(W('alpha.pdf')), 'application/pdf').asPDF();
    fs.writeFileSync(W('locked.pdf'), Buffer.from(base.saveToBuffer('encrypt=aes-256,user-password=abc,owner-password=def').asUint8Array()));
    fs.writeFileSync(W('owner-only.pdf'), Buffer.from(base.saveToBuffer('encrypt=aes-256,user-password=,owner-password=def').asUint8Array()));
  }
  fs.writeFileSync(W('corrupt.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 53 + 3) & 255))]));
  fs.writeFileSync(W('notpdf.pdf'), 'hello, I am a text file');
  fs.writeFileSync(W('empty.pdf'), '');

  await check('tool metadata: ids, category, default (pdf-merge), accepts, options', async () => {
    assert.deepStrictEqual(pdf.tools.map((t) => t.id), ['pdf-merge', 'pdf-split', 'pdf-compress', 'pdf-to-word', 'pdf-to-jpg', 'images-to-pdf']);
    assert.ok(pdf.tools.every((t) => t.category === 'pdf'));
    assert.deepStrictEqual(pdf.tools.filter((t) => t.isDefault).map((t) => t.id), ['pdf-merge']);
    assert.strictEqual(tool('pdf-merge').multi, 'combine');
    assert.strictEqual(tool('images-to-pdf').multi, 'combine');
    for (const id of ['pdf-split', 'pdf-compress', 'pdf-to-word', 'pdf-to-jpg']) { assert.strictEqual(tool(id).multi, 'each'); assert.deepStrictEqual(tool(id).accepts, ['.pdf']); }
    for (const e of ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic']) assert.ok(tool('images-to-pdf').accepts.includes(e), e);
    assert.deepStrictEqual(tool('pdf-split').options.map((o) => o.key), ['mode', 'ranges']);
    assert.deepStrictEqual(tool('pdf-compress').options[0].choices.map((c) => c.value), ['light', 'balanced', 'strong']);
    assert.strictEqual(tool('pdf-compress').options[0].default, 'balanced');
    assert.deepStrictEqual(tool('pdf-to-jpg').options.map((o) => o.key), ['dpi', 'format']);
    assert.strictEqual(tool('pdf-to-jpg').options[0].default, 150);
    assert.deepStrictEqual(tool('pdf-to-jpg').options[0].choices.map((c) => c.value), [72, 150, 300]);
    assert.deepStrictEqual(tool('images-to-pdf').options[0].choices.map((c) => c.value), ['fit-image', 'a4']);
  });

  // ---------------- merge ----------------
  await check('merge: 2 PDFs in the given order -> "<first> merged.pdf", 8 pages, text in order', async () => {
    const c = H.ctx({ outDir: path.join(work, 'm1') });
    const res = await tool('pdf-merge').run([W('alpha.pdf'), W('beta.pdf')], {}, c);
    assert.strictEqual(path.basename(res.outputs[0]), 'alpha merged.pdf');
    const info = await H.pdfInfo(res.outputs[0]);
    assert.strictEqual(info.pages, 8);
    assert.ok(info.texts[0].includes('Alpha page 1 of 5') && info.texts[4].includes('Alpha page 5 of 5'));
    assert.ok(info.texts[5].includes('Beta page 1 of 3') && info.texts[7].includes('Beta page 3 of 3'));
    assert.ok(c._events.length >= 3 && c._events.every(([f]) => f >= 0 && f <= 1) && c._events[c._events.length - 1][0] === 1);
    assert.ok(/8 pages/.test(res.message));
  });
  await check('merge: reversed order gives reversed result', async () => {
    const res = await tool('pdf-merge').run([W('beta.pdf'), W('alpha.pdf'), W('gamma.pdf')], {}, H.ctx({ outDir: path.join(work, 'm2') }));
    const info = await H.pdfInfo(res.outputs[0]);
    assert.strictEqual(info.pages, 9);
    assert.ok(info.texts[0].includes('Beta page 1') && info.texts[3].includes('Alpha page 1') && info.texts[8].includes('Gamma page 1'));
    assert.strictEqual(path.basename(res.outputs[0]), 'beta merged.pdf');
  });
  await check('merge: no overwrite -> "(2)", "(3)"; unicode + brackets in the first name', async () => {
    const f = W('मेरा file (final) #2.pdf');
    const a = await tool('pdf-merge').run([f, W('gamma.pdf')], {}, H.ctx());
    const b = await tool('pdf-merge').run([f, W('gamma.pdf')], {}, H.ctx());
    const c = await tool('pdf-merge').run([f, W('gamma.pdf')], {}, H.ctx());
    assert.strictEqual(a.outputs[0], W('मेरा file (final) #2 merged.pdf'));
    assert.strictEqual(b.outputs[0], W('मेरा file (final) #2 merged (2).pdf'));
    assert.strictEqual(c.outputs[0], W('मेरा file (final) #2 merged (3).pdf'));
    assert.strictEqual((await H.pdfInfo(a.outputs[0])).pages, 3);
  });
  await check('merge: a single PDF is accepted (makes a copy and says so)', async () => {
    const res = await tool('pdf-merge').run([W('gamma.pdf')], {}, H.ctx({ outDir: path.join(work, 'm3') }));
    assert.strictEqual((await H.pdfInfo(res.outputs[0])).pages, 1);
    assert.ok(/only one PDF/i.test(res.message));
  });
  await check('merge: PDF with owner restrictions but no user password still merges', async () => {
    const res = await tool('pdf-merge').run([W('owner-only.pdf'), W('gamma.pdf')], {}, H.ctx({ outDir: path.join(work, 'm4') }));
    assert.strictEqual((await H.pdfInfo(res.outputs[0])).pages, 6);
  });
  await check('merge: password-protected PDF -> clear password message, no output', async () => {
    const outDir = path.join(work, 'm5');
    const err = await H.expectError(tool('pdf-merge').run([W('alpha.pdf'), W('locked.pdf')], {}, H.ctx({ outDir })), /password/i, 'locked');
    assert.ok(/locked\.pdf/.test(err.message), 'names the file');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });
  for (const f of ['corrupt.pdf', 'notpdf.pdf']) {
    await check(`merge: ${f} -> clear "not a valid PDF" message`, async () => {
      const err = await H.expectError(tool('pdf-merge').run([W('alpha.pdf'), W(f)], {}, H.ctx({ outDir: path.join(work, 'm6') })), /valid PDF|damaged/i, f);
      assert.ok(!/pdf-lib|Failed to parse|stack|undefined/i.test(err.message), err.message);
    });
  }
  await check('merge: empty / missing file -> clear errors', async () => {
    await H.expectError(tool('pdf-merge').run([W('empty.pdf'), W('alpha.pdf')], {}, H.ctx()), /empty/i, 'empty');
    await H.expectError(tool('pdf-merge').run([W('alpha.pdf'), W('nope.pdf')], {}, H.ctx()), /could not be found/i, 'missing');
  });
  await check('merge: cancel mid-way -> Cancelled and no file written', async () => {
    const ac = new AbortController(); const outDir = path.join(work, 'm7');
    const c = H.ctx({ signal: ac.signal, outDir });
    c.onProgress = (f, t) => { if (/Added alpha/.test(t)) ac.abort(); };
    await H.expectError(tool('pdf-merge').run([W('alpha.pdf'), W('beta.pdf')], {}, c), /^Cancelled$/, 'cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  // ---------------- split ----------------
  await check('split every-page: 5 files in "<name> pages", each one page with the right text', async () => {
    const res = await tool('pdf-split').run([W('alpha.pdf')], { mode: 'every-page' }, H.ctx({ outDir: path.join(work, 's1') }));
    assert.strictEqual(res.outputs.length, 5);
    assert.ok(res.outputs.every((f) => path.basename(path.dirname(f)) === 'alpha pages'));
    for (let i = 0; i < 5; i += 1) {
      const info = await H.pdfInfo(res.outputs[i]);
      assert.strictEqual(info.pages, 1);
      assert.ok(info.text.includes(`Alpha page ${i + 1} of 5`), info.text);
    }
    assert.deepStrictEqual(res.outputs.map((f) => path.basename(f)), [1, 2, 3, 4, 5].map((n) => `alpha page ${n}.pdf`));
  });
  await check('split every-page twice: second run goes to "alpha pages (2)"', async () => {
    const outDir = path.join(work, 's2');
    const a = await tool('pdf-split').run([W('beta.pdf')], { mode: 'every-page' }, H.ctx({ outDir }));
    const b = await tool('pdf-split').run([W('beta.pdf')], { mode: 'every-page' }, H.ctx({ outDir }));
    assert.strictEqual(path.basename(path.dirname(a.outputs[0])), 'beta pages');
    assert.strictEqual(path.basename(path.dirname(b.outputs[0])), 'beta pages (2)');
    assert.strictEqual(a.outputs.length + b.outputs.length, 6);
  });
  await check('split ranges "1-3, 5": two files with 3 and 1 pages, correct content', async () => {
    const res = await tool('pdf-split').run([W('alpha.pdf')], { mode: 'ranges', ranges: '1-3, 5' }, H.ctx({ outDir: path.join(work, 's3') }));
    assert.strictEqual(res.outputs.length, 2);
    const a = await H.pdfInfo(res.outputs[0]); const b = await H.pdfInfo(res.outputs[1]);
    assert.strictEqual(a.pages, 3); assert.ok(a.texts[0].includes('Alpha page 1') && a.texts[2].includes('Alpha page 3'));
    assert.strictEqual(b.pages, 1); assert.ok(b.text.includes('Alpha page 5'));
    assert.ok(/pages 1-3/.test(path.basename(res.outputs[0])) && /page 5/.test(path.basename(res.outputs[1])));
  });
  await check('split ranges: "2-2", "4-5", "5, 1" (given order kept), spaces and semicolons', async () => {
    const r1 = await tool('pdf-split').run([W('alpha.pdf')], { mode: 'ranges', ranges: '2-2' }, H.ctx({ outDir: path.join(work, 's4') }));
    assert.strictEqual((await H.pdfInfo(r1.outputs[0])).pages, 1);
    const r2 = await tool('pdf-split').run([W('alpha.pdf')], { mode: 'ranges', ranges: '4 - 5' }, H.ctx({ outDir: path.join(work, 's5') }));
    assert.strictEqual((await H.pdfInfo(r2.outputs[0])).pages, 2);
    const r3 = await tool('pdf-split').run([W('alpha.pdf')], { mode: 'ranges', ranges: '5; 1' }, H.ctx({ outDir: path.join(work, 's6') }));
    assert.ok((await H.pdfInfo(r3.outputs[0])).text.includes('Alpha page 5') && (await H.pdfInfo(r3.outputs[1])).text.includes('Alpha page 1'));
  });
  for (const [rng, re] of [['0', /start at 1/i], ['6', /outside this PDF.*5 pages/i], ['3-1', /backwards/i], ['abc', /not a valid page range/i], ['', /Type the pages/i], ['1-9', /outside this PDF/i], ['1,,x', /not a valid/i]]) {
    await check(`split ranges "${rng}" -> clear error, no folder left behind`, async () => {
      const outDir = path.join(work, 's-bad');
      fs.rmSync(outDir, { recursive: true, force: true });
      await H.expectError(tool('pdf-split').run([W('alpha.pdf')], { mode: 'ranges', ranges: rng }, H.ctx({ outDir })), re, rng);
      assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'left something behind');
    });
  }
  await check('split: locked PDF -> password message; corrupt PDF -> valid-PDF message', async () => {
    await H.expectError(tool('pdf-split').run([W('locked.pdf')], {}, H.ctx({ outDir: path.join(work, 's7') })), /password/i, 'locked');
    await H.expectError(tool('pdf-split').run([W('corrupt.pdf')], {}, H.ctx({ outDir: path.join(work, 's7') })), /valid PDF|damaged/i, 'corrupt');
  });
  await check('split: cancel mid-way removes the files already written and the folder', async () => {
    const ac = new AbortController(); const outDir = path.join(work, 's8');
    const c = H.ctx({ signal: ac.signal, outDir });
    c.onProgress = (f, t) => { if (/Saved alpha page 2/.test(t)) ac.abort(); };
    await H.expectError(tool('pdf-split').run([W('alpha.pdf')], { mode: 'every-page' }, c), /^Cancelled$/, 'cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, `left: ${fs.existsSync(outDir) ? fs.readdirSync(outDir) : ''}`);
  });
  await check('split: unicode name -> folder and files keep the name', async () => {
    const res = await tool('pdf-split').run([W('मेरा file (final) #2.pdf')], { mode: 'every-page' }, H.ctx({ outDir: path.join(work, 's9') }));
    assert.strictEqual(path.basename(path.dirname(res.outputs[0])), 'मेरा file (final) #2 pages');
    assert.strictEqual(res.outputs.length, 2);
  });

  // ---------------- compress ----------------
  const origPhotos = fs.statSync(W('photos.pdf')).size;
  const csize = {};
  for (const level of ['light', 'balanced', 'strong']) {
    await check(`compress image-heavy PDF (${level}): really smaller, same pages, still renders`, async () => {
      const t0 = Date.now();
      const res = await tool('pdf-compress').run([W('photos.pdf')], { level }, H.ctx({ outDir: path.join(work, 'c-' + level) }));
      csize[level] = fs.statSync(res.outputs[0]).size;
      assert.ok(csize[level] < origPhotos * 0.8, `${level}: ${csize[level]} vs original ${origPhotos}`);
      assert.ok(/->/.test(res.message) && /smaller/.test(res.message), res.message);
      const info = await H.pdfInfo(res.outputs[0]);
      assert.strictEqual(info.pages, 3);
      assert.ok(info.texts[1].includes('Image heavy page 2'), 'text still there');
      const mean = await renderMean(res.outputs[0], 0); const ref = await renderMean(W('photos.pdf'), 0);
      assert.ok(mean.every((v, i) => Math.abs(v - ref[i]) < 12), `picture changed too much: ${mean} vs ${ref}`);
      assert.ok(path.basename(res.outputs[0]) === 'photos compressed.pdf');
      console.log(`      ${level}: ${origPhotos} -> ${csize[level]} bytes in ${Date.now() - t0} ms`);
    });
  }
  await check('compress: levels are ordered (light > balanced > strong)', async () => {
    assert.ok(csize.light > csize.balanced && csize.balanced > csize.strong, JSON.stringify(csize));
  });
  await check('compress: default level is balanced when no option is given', async () => {
    const res = await tool('pdf-compress').run([W('photos.pdf')], {}, H.ctx({ outDir: path.join(work, 'c-default') }));
    assert.ok(Math.abs(fs.statSync(res.outputs[0]).size - csize.balanced) < csize.balanced * 0.05);
  });
  await check('compress: text-only PDF stays valid and the message is honest about the result', async () => {
    const orig = fs.statSync(W('alpha.pdf')).size;
    const res = await tool('pdf-compress').run([W('alpha.pdf')], { level: 'strong' }, H.ctx({ outDir: path.join(work, 'c-text') }));
    const out = fs.statSync(res.outputs[0]).size;
    assert.strictEqual((await H.pdfInfo(res.outputs[0])).pages, 5);
    if (out < orig) assert.ok(/smaller/.test(res.message), res.message);
    else { assert.ok(/could not be made any smaller/.test(res.message) && out === orig, res.message); assert.ok(fs.readFileSync(res.outputs[0]).equals(fs.readFileSync(W('alpha.pdf')))); }
    assert.ok(res.message.includes('B') || res.message.includes('KB'), 'sizes mentioned');
  });
  await check('compress: second pass on an already-compressed file never makes it bigger and says what happened', async () => {
    const once = path.join(work, 'c-strong', 'photos compressed.pdf');
    const sizeBefore = fs.statSync(once).size;
    const res = await tool('pdf-compress').run([once], { level: 'strong' }, H.ctx({ outDir: path.join(work, 'c-twice') }));
    assert.ok(fs.statSync(res.outputs[0]).size <= sizeBefore);
    assert.ok(/smaller|could not be made any smaller/.test(res.message), res.message);
  });
  await check('compress: no overwrite, locked and corrupt PDFs, unknown level', async () => {
    const outDir = path.join(work, 'c-no');
    const a = await tool('pdf-compress').run([W('gamma.pdf')], {}, H.ctx({ outDir }));
    const b = await tool('pdf-compress').run([W('gamma.pdf')], {}, H.ctx({ outDir }));
    assert.strictEqual(path.basename(a.outputs[0]), 'gamma compressed.pdf');
    assert.strictEqual(path.basename(b.outputs[0]), 'gamma compressed (2).pdf');
    await H.expectError(tool('pdf-compress').run([W('locked.pdf')], {}, H.ctx({ outDir })), /password/i, 'locked');
    await H.expectError(tool('pdf-compress').run([W('corrupt.pdf')], {}, H.ctx({ outDir })), /valid PDF|damaged/i, 'corrupt');
    await H.expectError(tool('pdf-compress').run([W('alpha.pdf')], { level: 'extreme' }, H.ctx({ outDir })), /Unknown compression/i, 'level');
  });
  await check('compress: cancel mid-way -> Cancelled, nothing written', async () => {
    const ac = new AbortController(); const outDir = path.join(work, 'c-cancel');
    const c = H.ctx({ signal: ac.signal, outDir });
    c.onProgress = (f, t) => { if (/picture 2 of/.test(t)) ac.abort(); };
    await H.expectError(tool('pdf-compress').run([W('photos.pdf')], {}, c), /^Cancelled$/, 'cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  // ---------------- PDF -> images ----------------
  for (const [dpi, w, h] of [[72, 595, 842], [150, 1240, 1754], [300, 2480, 3508]]) {
    await check(`pdf-to-jpg ${dpi} dpi (jpg): page size ~${w}x${h}`, async () => {
      const res = await tool('pdf-to-jpg').run([W('beta.pdf')], { dpi, format: 'jpg' }, H.ctx({ outDir: path.join(work, `i-${dpi}`) }));
      assert.strictEqual(res.outputs.length, 3);
      assert.ok(res.outputs.every((f) => path.basename(path.dirname(f)) === 'beta images' && f.endsWith('.jpg')));
      const m = await sharp(res.outputs[0]).metadata();
      assert.strictEqual(m.format, 'jpeg');
      assert.ok(Math.abs(m.width - w) <= 2 && Math.abs(m.height - h) <= 2, `${m.width}x${m.height}`);
      assert.deepStrictEqual(res.outputs.map((f) => path.basename(f)), ['beta page 1.jpg', 'beta page 2.jpg', 'beta page 3.jpg']);
    });
  }
  await check('pdf-to-jpg png: valid PNGs and visible text (not blank); default options = 150 dpi jpg', async () => {
    const res = await tool('pdf-to-jpg').run([W('gamma.pdf')], { dpi: 150, format: 'png' }, H.ctx({ outDir: path.join(work, 'i-png') }));
    const m = await sharp(res.outputs[0]).metadata();
    assert.strictEqual(m.format, 'png');
    const st = await sharp(res.outputs[0]).stats();
    assert.ok(st.channels[0].min < 60, 'there should be dark text pixels on the page');
    const def = await tool('pdf-to-jpg').run([W('gamma.pdf')], {}, H.ctx({ outDir: path.join(work, 'i-def') }));
    assert.ok(def.outputs[0].endsWith('.jpg'));
    assert.ok(Math.abs((await sharp(def.outputs[0]).metadata()).width - 1240) <= 2);
  });
  await check('pdf-to-jpg: image page renders the photo (colourful, not white)', async () => {
    const res = await tool('pdf-to-jpg').run([W('photos.pdf')], { dpi: 72, format: 'jpg' }, H.ctx({ outDir: path.join(work, 'i-photo') }));
    const st = await sharp(res.outputs[0]).stats();
    assert.ok(st.channels.some((c) => c.stdev > 30), 'photo area should have variation');
  });
  await check('pdf-to-jpg: second run -> "images (2)" folder; 12-page PDF pads numbers', async () => {
    const outDir = path.join(work, 'i-twice');
    await tool('pdf-to-jpg').run([W('gamma.pdf')], { dpi: 72 }, H.ctx({ outDir }));
    const b = await tool('pdf-to-jpg').run([W('gamma.pdf')], { dpi: 72 }, H.ctx({ outDir }));
    assert.strictEqual(path.basename(path.dirname(b.outputs[0])), 'gamma images (2)');
    await H.makeTextPdf(W('twelve.pdf'), 12, 'Twelve');
    const t = await tool('pdf-to-jpg').run([W('twelve.pdf')], { dpi: 72 }, H.ctx({ outDir }));
    assert.strictEqual(path.basename(t.outputs[0]), 'twelve page 01.jpg');
    assert.strictEqual(path.basename(t.outputs[11]), 'twelve page 12.jpg');
  });
  await check('pdf-to-jpg: locked / corrupt -> clear errors; cancel cleans up', async () => {
    await H.expectError(tool('pdf-to-jpg').run([W('locked.pdf')], {}, H.ctx({ outDir: path.join(work, 'i-bad') })), /password/i, 'locked');
    await H.expectError(tool('pdf-to-jpg').run([W('corrupt.pdf')], {}, H.ctx({ outDir: path.join(work, 'i-bad') })), /valid PDF|damaged/i, 'corrupt');
    assert.ok(!fs.existsSync(path.join(work, 'i-bad')) || fs.readdirSync(path.join(work, 'i-bad')).length === 0);
    const ac = new AbortController(); const outDir = path.join(work, 'i-cancel');
    const c = H.ctx({ signal: ac.signal, outDir });
    c.onProgress = (f, t) => { if (/Page 2 of/.test(t)) ac.abort(); };
    await H.expectError(tool('pdf-to-jpg').run([W('alpha.pdf')], { dpi: 72 }, c), /^Cancelled$/, 'cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  // ---------------- images -> PDF ----------------
  const imgs = {};
  const mk = async (name, w, h, rgb, fmt, extra) => {
    const raw = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i += 1) { raw[i * 3] = rgb[0]; raw[i * 3 + 1] = rgb[1]; raw[i * 3 + 2] = rgb[2]; }
    let p = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
    if (extra && extra.orientation) p = p.withMetadata({ orientation: extra.orientation });
    await p[fmt]().toFile(W(name)); imgs[name] = W(name);
  };
  await mk('a.jpg', 600, 400, [230, 20, 20], 'jpeg');
  await mk('b.png', 300, 450, [20, 200, 20], 'png');
  await mk('c.webp', 500, 500, [20, 20, 230], 'webp');
  await mk('e.tif', 400, 300, [200, 200, 20], 'tiff');
  await mk('rot6.jpg', 600, 400, [230, 20, 20], 'jpeg', { orientation: 6 });
  {
    const w = 60; const h = 60; const raw = Buffer.alloc(w * h * 4); for (let i = 0; i < w * h; i += 1) { if (i % w >= 30) { raw[i * 4] = 255; raw[i * 4 + 3] = 255; } }
    await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(W('alpha.png'));
  }
  {
    // 24-bit bottom-up BMP 100x80
    const w = 100; const h = 80; const row = Math.floor((24 * w + 31) / 32) * 4; const buf = Buffer.alloc(54 + row * h);
    buf.write('BM', 0, 'latin1'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = 54 + y * row + x * 3; buf[o] = 30; buf[o + 1] = 60; buf[o + 2] = 220; }
    fs.writeFileSync(W('d.bmp'), buf);
  }
  makeHeic(W('phone.heic'), util.findFfmpeg({}), {});
  const ppp = (px) => px * 72 / 150;

  await check('images-to-pdf fit-image: one page per picture in order, page = picture size (150 dpi)', async () => {
    const res = await tool('images-to-pdf').run([W('a.jpg'), W('b.png'), W('c.webp'), W('d.bmp'), W('e.tif')], { page: 'fit-image' }, H.ctx({ outDir: path.join(work, 'p1') }));
    const bounds = await pageBounds(res.outputs[0]);
    assert.strictEqual(bounds.length, 5);
    const exp = [[600, 400], [300, 450], [500, 500], [100, 80], [400, 300]];
    exp.forEach(([w, h], i) => { assert.ok(Math.abs(bounds[i][0] - ppp(w)) < 1 && Math.abs(bounds[i][1] - ppp(h)) < 1, `page ${i + 1}: ${bounds[i]} vs ${ppp(w)}x${ppp(h)}`); });
    assert.strictEqual(path.basename(res.outputs[0]), 'a images.pdf');
  });
  await check('images-to-pdf: page content really is the picture (colours in the right order)', async () => {
    const res = await tool('images-to-pdf').run([W('a.jpg'), W('b.png'), W('c.webp')], {}, H.ctx({ outDir: path.join(work, 'p2') }));
    const m1 = await renderMean(res.outputs[0], 0); const m2 = await renderMean(res.outputs[0], 1); const m3 = await renderMean(res.outputs[0], 2);
    assert.ok(m1[0] > 200 && m1[1] < 60, `page 1 should be red: ${m1}`);
    assert.ok(m2[1] > 170 && m2[0] < 60, `page 2 should be green: ${m2}`);
    assert.ok(m3[2] > 200 && m3[0] < 60, `page 3 should be blue: ${m3}`);
  });
  await check('images-to-pdf a4: portrait/landscape A4 pages with the picture centred and uncropped', async () => {
    const res = await tool('images-to-pdf').run([W('a.jpg'), W('b.png')], { page: 'a4' }, H.ctx({ outDir: path.join(work, 'p3') }));
    const b = await pageBounds(res.outputs[0]);
    assert.ok(Math.abs(b[0][0] - 841.89) < 0.5 && Math.abs(b[0][1] - 595.28) < 0.5, `landscape picture -> landscape A4: ${b[0]}`);
    assert.ok(Math.abs(b[1][0] - 595.28) < 0.5 && Math.abs(b[1][1] - 841.89) < 0.5, `portrait picture -> portrait A4: ${b[1]}`);
    const mean = await renderMean(res.outputs[0], 1);
    assert.ok(mean[1] > mean[0] + 30, `page should be mostly the green picture: ${mean}`);
  });
  await check('images-to-pdf: EXIF-rotated JPEG ends up upright (portrait page)', async () => {
    const res = await tool('images-to-pdf').run([W('rot6.jpg')], {}, H.ctx({ outDir: path.join(work, 'p4') }));
    const b = await pageBounds(res.outputs[0]);
    assert.ok(b[0][1] > b[0][0], `expected portrait, got ${b[0]}`);
    assert.strictEqual(path.basename(res.outputs[0]), 'rot6.pdf');
  });
  await check('images-to-pdf: transparent PNG is placed on white (no black box)', async () => {
    const res = await tool('images-to-pdf').run([W('alpha.png')], {}, H.ctx({ outDir: path.join(work, 'p5') }));
    const m = await H.mupdf();
    const d = m.Document.openDocument(fs.readFileSync(res.outputs[0]), 'application/pdf');
    const pix = d.loadPage(0).toPixmap(m.Matrix.scale(1, 1), m.ColorSpace.DeviceRGB, false, true);
    const { data, info } = await sharp(Buffer.from(pix.asPNG())).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => Array.from(data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    assert.ok(at(3, 3).every((v) => v > 240), `transparent part should be white, got ${at(3, 3)}`);
    assert.ok(at(info.width - 4, 3)[0] > 240 && at(info.width - 4, 3)[1] < 20, 'red part present');
  });
  await check('images-to-pdf: HEIC (iPhone) picture is embedded as the FULL upright picture', async () => {
    const res = await tool('images-to-pdf').run([W('phone.heic'), W('a.jpg')], {}, H.ctx({ outDir: path.join(work, 'p6') }));
    const b = await pageBounds(res.outputs[0]);
    assert.ok(Math.abs(b[0][0] - ppp(500)) < 1 && Math.abs(b[0][1] - ppp(700)) < 1, `heic page ${b[0]}`);
    const mean = await renderMean(res.outputs[0], 0);
    assert.ok(mean[2] > 80 && mean[0] > 80, `heic page should be mixed red/blue/white: ${mean}`);
  });
  await check('images-to-pdf: single picture; names with unicode; no overwrite "(2)"', async () => {
    const f = W('चित्र (1) #3.jpg'); fs.copyFileSync(W('a.jpg'), f);
    const a = await tool('images-to-pdf').run([f], {}, H.ctx());
    const b = await tool('images-to-pdf').run([f], {}, H.ctx());
    assert.strictEqual(a.outputs[0], W('चित्र (1) #3.pdf'));
    assert.strictEqual(b.outputs[0], W('चित्र (1) #3 (2).pdf'));
    assert.strictEqual((await H.pdfInfo(a.outputs[0])).pages, 1);
  });
  await check('images-to-pdf: bad picture -> plain-English error and no PDF', async () => {
    fs.writeFileSync(W('junk.jpg'), Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 17 + 1) & 255)));
    const outDir = path.join(work, 'p7');
    const err = await H.expectError(tool('images-to-pdf').run([W('a.jpg'), W('junk.jpg')], {}, H.ctx({ outDir })), /could not be read as a picture|damaged/i, 'junk');
    assert.ok(!/vips|sharp|libheif/i.test(err.message));
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });
  await check('images-to-pdf: cancel mid-way -> Cancelled, nothing written', async () => {
    const ac = new AbortController(); const outDir = path.join(work, 'p8');
    const c = H.ctx({ signal: ac.signal, outDir });
    c.onProgress = (f, t) => { if (/Adding b\.png/.test(t)) ac.abort(); };
    await H.expectError(tool('images-to-pdf').run([W('a.jpg'), W('b.png'), W('c.webp')], {}, c), /^Cancelled$/, 'cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  // ---------------- PDF -> Word (real Microsoft Word) ----------------
  let word1;
  await check('pdf-to-word: makes a valid .docx whose text matches the PDF', async () => {
    const c = H.ctx({ outDir: path.join(work, 'w1') });
    const t0 = Date.now();
    const res = await tool('pdf-to-word').run([W('beta.pdf')], {}, c);
    word1 = Date.now() - t0;
    assert.strictEqual(path.basename(res.outputs[0]), 'beta.docx');
    const zip = H.zipRead(res.outputs[0]);
    assert.ok(zip['word/document.xml'] && zip['[Content_Types].xml'], 'docx structure');
    const xml = zip['word/document.xml'].toString('utf8').replace(/<[^>]+>/g, ' ');
    assert.ok(/Beta\s+page\s+1\s+of\s+3/.test(norm(xml)), `text missing: ${norm(xml).slice(0, 200)}`);
    assert.ok(/Beta\s+page\s+3\s+of\s+3/.test(norm(xml)));
    assert.ok(c._events.length >= 3 && c._events.every(([f]) => f >= 0 && f <= 1));
    // the .docx must itself re-open in Word: convert it back to PDF through the office module
    const office = require('../src/engine/office');
    const back = await office.tools.find((t) => t.id === 'word-to-pdf').run([res.outputs[0]], {}, H.ctx({ outDir: path.join(work, 'w1-back') }));
    assert.ok(norm((await H.pdfInfo(back.outputs[0])).text).includes('Beta page 1 of 3'));
  });
  await check('pdf-to-word: unicode name + no overwrite', async () => {
    const f = W('मेरा file (final) #2.pdf');
    const a = await tool('pdf-to-word').run([f], {}, H.ctx());
    const b = await tool('pdf-to-word').run([f], {}, H.ctx());
    assert.strictEqual(a.outputs[0], W('मेरा file (final) #2.docx'));
    assert.strictEqual(b.outputs[0], W('मेरा file (final) #2 (2).docx'));
  });
  await check('pdf-to-word: locked PDF -> password message; garbage -> clear message; no outputs', async () => {
    const outDir = path.join(work, 'w-bad');
    await H.expectError(tool('pdf-to-word').run([W('locked.pdf')], {}, H.ctx({ outDir })), /password/i, 'locked');
    await H.expectError(tool('pdf-to-word').run([W('notpdf.pdf')], {}, H.ctx({ outDir })), /valid PDF|damaged/i, 'notpdf');
    await H.expectError(tool('pdf-to-word').run([W('corrupt.pdf')], {}, H.ctx({ outDir })), /could not be opened|damaged|valid PDF/i, 'corrupt');
    await H.expectError(tool('pdf-to-word').run([W('empty.pdf')], {}, H.ctx({ outDir })), /empty/i, 'empty');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });
  await check('pdf-to-word: cancel -> Cancelled, no output, no orphan Word', async () => {
    const ac = new AbortController(); const outDir = path.join(work, 'w-cancel');
    const before = H.listProcs(OFFICE);
    const p = tool('pdf-to-word').run([W('alpha.pdf')], {}, H.ctx({ signal: ac.signal, outDir }));
    setTimeout(() => ac.abort(), 2500);
    await H.expectError(p, /^Cancelled$/, 'cancel');
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(H.listProcs(OFFICE), before);
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  await check('no orphan WINWORD / EXCEL / POWERPNT processes after the PDF tests', async () => {
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(H.listProcs(OFFICE), procsAtStart);
  });
  await check('registry loads the pdf module without errors', async () => {
    const reg = require('../src/engine/index');
    assert.ok(!reg.loadErrors.some((e) => e.module === 'pdf' || e.module === 'office' || e.module === 'image'), JSON.stringify(reg.loadErrors));
    assert.strictEqual(reg.toolsForCategory('pdf').filter((t) => t.isDefault).length, 1);
  });

  if (word1) console.log(`\nTiming: PDF to Word (3-page PDF, first call) ${(word1 / 1000).toFixed(1)} s`);
  R.finish();
})().catch((e) => { console.error(e); process.exit(1); });
