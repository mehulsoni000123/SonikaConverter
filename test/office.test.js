'use strict';
// node test/office.test.js  -  real Word / Excel / PowerPoint conversions (needs Microsoft Office on this PC).
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./fixtures/docs/helpers');
const office = require('../src/engine/office');

const OFFICE_PROCS = ['WINWORD.EXE', 'EXCEL.EXE', 'POWERPNT.EXE'];
const tool = (id) => office.tools.find((t) => t.id === id);
const norm = (s) => s.replace(/\s+/g, ' ');

(async () => {
  const R = H.createRunner('office.test');
  const { check } = R;
  const procsAtStart = H.listProcs(OFFICE_PROCS);
  const fx = H.FIX;

  // ---- fixtures ----
  const work = H.freshDir('office');
  const docxName = 'मेरा file (final) #2.docx';
  const docxUni = path.join(work, docxName);
  const MARK = 'Sonika Fixture Alpha';
  H.makeDocx(docxUni, [MARK, 'मेरा test paragraph', 'Second line with numbers 12345']);
  const plain = path.join(work, 'plain.docx');
  H.makeDocx(plain, [MARK, 'Plain file']);
  const txt = path.join(work, 'notes.txt');
  fs.writeFileSync(txt, `${MARK}\nUTF-8 text with Hindi: मेरा नाम\nCafé résumé\n`, 'utf8');

  await check('fixtures: Word/Excel/PowerPoint save sample files (doc, odt, rtf, xlsx, xls, pptx, ppt)', async () => {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(fx, 'make-office-fixtures.ps1'), '-Dir', work, '-SourceDocx', plain],
      { encoding: 'utf8', timeout: 240000 });
    assert.ok(/FIXTURES-OK/.test(r.stdout), `fixture generation failed: ${r.stdout} ${r.stderr}`);
    for (const f of ['sample-word.doc', 'sample-word.odt', 'sample-word.rtf', 'sample-protected.docx', 'sample-sheet.xlsx', 'sample-sheet.xls', 'sample-slides.pptx', 'sample-slides.ppt']) {
      assert.ok(fs.existsSync(path.join(work, f)) && fs.statSync(path.join(work, f)).size > 0, `${f} missing`);
    }
  });

  await check('tool metadata: ids, category, default, accepts', async () => {
    const w = tool('word-to-pdf'); const o = tool('office-to-pdf');
    assert.ok(w && o);
    assert.strictEqual(w.category, 'word'); assert.strictEqual(o.category, 'word');
    assert.strictEqual(w.isDefault, true);
    for (const e of ['.docx', '.doc', '.rtf', '.odt', '.txt']) assert.ok(w.accepts.includes(e), e);
    for (const e of ['.xlsx', '.xls', '.pptx', '.ppt']) assert.ok(o.accepts.includes(e), e);
    assert.strictEqual(w.multi, 'each');
  });

  // ---- Word -> PDF, each format ----
  const timings = [];
  const wordCases = [
    ['docx', docxUni, MARK],
    ['doc', path.join(work, 'sample-word.doc'), MARK],
    ['rtf', path.join(work, 'sample-word.rtf'), MARK],
    ['odt', path.join(work, 'sample-word.odt'), MARK],
    ['txt (UTF-8, Hindi)', txt, 'मेरा नाम'],
  ];
  for (const [label, file, expect] of wordCases) {
    await check(`word-to-pdf ${label}: valid PDF containing the expected text`, async () => {
      const outDir = path.join(work, 'out-' + label.split(' ')[0]);
      const c = H.ctx({ outDir });
      const t0 = Date.now();
      const res = await tool('word-to-pdf').run([file], {}, c);
      timings.push(Date.now() - t0);
      assert.strictEqual(res.outputs.length, 1);
      assert.ok(path.isAbsolute(res.outputs[0]) && fs.existsSync(res.outputs[0]));
      assert.ok(typeof res.message === 'string' && res.message.length > 5);
      const info = await H.pdfInfo(res.outputs[0]);
      assert.ok(info.pages >= 1, 'no pages');
      assert.ok(norm(info.text).includes(expect), `PDF text "${norm(info.text).slice(0, 120)}" lacks "${expect}"`);
      assert.ok(c._events.length >= 3, 'progress was reported');
      assert.ok(c._events.every(([f]) => f >= 0 && f <= 1), 'progress between 0 and 1');
    });
  }

  await check('unicode + spaces + brackets in name: output keeps the name, lands next to input when outDir is null', async () => {
    const res = await tool('word-to-pdf').run([docxUni], {}, H.ctx());
    assert.strictEqual(res.outputs[0], path.join(work, 'मेरा file (final) #2.pdf'));
    assert.ok(fs.existsSync(res.outputs[0]));
  });

  await check('no overwrite: second run makes "name (2).pdf", third "(3)"; first output untouched', async () => {
    const first = path.join(work, 'मेरा file (final) #2.pdf');
    const sizeBefore = fs.statSync(first).size;
    const mtime = fs.statSync(first).mtimeMs;
    const res2 = await tool('word-to-pdf').run([docxUni], {}, H.ctx());
    assert.strictEqual(res2.outputs[0], path.join(work, 'मेरा file (final) #2 (2).pdf'));
    const res3 = await tool('word-to-pdf').run([docxUni], {}, H.ctx());
    assert.strictEqual(res3.outputs[0], path.join(work, 'मेरा file (final) #2 (3).pdf'));
    assert.strictEqual(fs.statSync(first).size, sizeBefore);
    assert.strictEqual(fs.statSync(first).mtimeMs, mtime);
  });

  await check('source document is never modified', async () => {
    const before = fs.readFileSync(docxUni);
    await tool('word-to-pdf').run([docxUni], {}, H.ctx({ outDir: path.join(work, 'out-src') }));
    assert.ok(before.equals(fs.readFileSync(docxUni)), 'source bytes changed');
    assert.ok(!fs.existsSync(path.join(work, '~$' + path.basename(docxUni).slice(2))), 'no Word lock file left');
  });

  await check('long path: deep folder + 120 character file name', async () => {
    const deep = path.join(work, 'a folder with spaces', 'и юникод', 'x'.repeat(20));
    fs.mkdirSync(deep, { recursive: true });
    const longName = 'long name ' + 'abcdefghij '.repeat(10) + '.docx';
    const f = path.join(deep, longName);
    H.makeDocx(f, [MARK, 'long path']);
    const res = await tool('word-to-pdf').run([f], {}, H.ctx());
    assert.ok(fs.existsSync(res.outputs[0]));
    assert.ok(norm((await H.pdfInfo(res.outputs[0])).text).includes(MARK));
  });

  // ---- bad input ----
  await check('corrupt .docx (random bytes) gives a plain-English error and leaves no output', async () => {
    const bad = path.join(work, 'corrupt.docx');
    fs.writeFileSync(bad, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 37 + 11) & 255)));
    const outDir = path.join(work, 'out-corrupt');
    const err = await H.expectError(tool('word-to-pdf').run([bad], {}, H.ctx({ outDir })), /could not be opened|damaged|not.*understand/i, 'corrupt docx');
    assert.ok(!/\bCOM\b|HRESULT|Exception/i.test(err.message), `message leaks technical text: ${err.message}`);
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'partial output left behind');
  });

  await check('empty file gives a clear error', async () => {
    const e = path.join(work, 'empty.docx'); fs.writeFileSync(e, '');
    await H.expectError(tool('word-to-pdf').run([e], {}, H.ctx()), /empty/i, 'empty');
  });

  await check('missing file gives a clear error', async () => {
    await H.expectError(tool('word-to-pdf').run([path.join(work, 'nope.docx')], {}, H.ctx()), /could not be found/i, 'missing');
  });

  await check('password-protected .docx gives a password message', async () => {
    await H.expectError(tool('word-to-pdf').run([path.join(work, 'sample-protected.docx')], {}, H.ctx({ outDir: path.join(work, 'out-pw') })), /password/i, 'protected');
  });

  // ---- Excel / PowerPoint ----
  for (const [file, expect] of [['sample-sheet.xlsx', 'Sonika Excel Fixture'], ['sample-sheet.xls', 'Sonika Excel Fixture'], ['sample-slides.pptx', 'Sonika Slide Fixture 1'], ['sample-slides.ppt', 'Sonika Slide Fixture 2']]) {
    await check(`office-to-pdf ${file}: valid PDF with expected text`, async () => {
      const t0 = Date.now();
      const res = await tool('office-to-pdf').run([path.join(work, file)], { fitWidth: true }, H.ctx({ outDir: path.join(work, 'out-' + file) }));
      timings.push(Date.now() - t0);
      const info = await H.pdfInfo(res.outputs[0]);
      assert.ok(info.pages >= 1);
      assert.ok(norm(info.text).includes(expect), `lacks "${expect}": ${norm(info.text).slice(0, 100)}`);
      if (file.startsWith('sample-slides')) assert.strictEqual(info.pages, 2, 'two slides -> two pages');
    });
  }

  await check('office-to-pdf Excel option fitWidth: fewer pages when on than when off', async () => {
    const on = await tool('office-to-pdf').run([path.join(work, 'sample-sheet.xlsx')], { fitWidth: true }, H.ctx({ outDir: path.join(work, 'fw-on') }));
    const off = await tool('office-to-pdf').run([path.join(work, 'sample-sheet.xlsx')], { fitWidth: false }, H.ctx({ outDir: path.join(work, 'fw-off') }));
    const a = (await H.pdfInfo(on.outputs[0])).pages; const b = (await H.pdfInfo(off.outputs[0])).pages;
    assert.ok(a < b, `fitWidth on = ${a} pages, off = ${b} pages`);
  });

  await check('office-to-pdf unicode file name', async () => {
    const f = path.join(work, 'बिक्री report (Q1).xlsx');
    fs.copyFileSync(path.join(work, 'sample-sheet.xlsx'), f);
    const res = await tool('office-to-pdf').run([f], {}, H.ctx());
    assert.strictEqual(path.basename(res.outputs[0]), 'बिक्री report (Q1).pdf');
  });

  await check('corrupt .xlsx and .pptx give clear errors', async () => {
    for (const ext of ['.xlsx', '.pptx']) {
      const bad = path.join(work, 'corrupt' + ext);
      fs.writeFileSync(bad, Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 91 + 5) & 255)));
      await H.expectError(tool('office-to-pdf').run([bad], {}, H.ctx({ outDir: path.join(work, 'out-c' + ext) })), /could not be opened|damaged/i, 'corrupt ' + ext);
    }
  });

  // ---- cancel + timeout ----
  await check('cancel via AbortSignal: rejects "Cancelled", no output, no orphan Office process', async () => {
    const ac = new AbortController();
    const outDir = path.join(work, 'out-cancel');
    const before = H.listProcs(OFFICE_PROCS);
    const p = tool('word-to-pdf').run([plain], {}, H.ctx({ signal: ac.signal, outDir }));
    setTimeout(() => ac.abort(), 2500);
    await H.expectError(p, /^Cancelled$/, 'cancel');
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(H.listProcs(OFFICE_PROCS), before, 'Office processes differ after cancel');
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'output left behind');
  });

  await check('already-cancelled signal fails immediately', async () => {
    const ac = new AbortController(); ac.abort();
    await H.expectError(tool('word-to-pdf').run([plain], {}, H.ctx({ signal: ac.signal })), /^Cancelled$/, 'pre-cancelled');
  });

  await check('timeout kills only our instance and explains why', async () => {
    const before = H.listProcs(OFFICE_PROCS);
    await H.expectError(tool('word-to-pdf').run([plain], {}, H.ctx({ settings: { officeTimeoutSec: 1 }, outDir: path.join(work, 'out-timeout') })), /longer than 1 seconds/i, 'timeout');
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepStrictEqual(H.listProcs(OFFICE_PROCS), before, 'Office processes differ after timeout');
  });

  // ---- a Word the user already has open must not be touched ----
  await check('a Word instance that is already open (simulated user window) is left alone', async () => {
    const script = `
$ErrorActionPreference='Stop'
$b=@(Get-Process WINWORD -ErrorAction SilentlyContinue|%{$_.Id})
$w=New-Object -ComObject Word.Application
$w.Visible=$true
Start-Sleep 1
$n=@((Get-Process WINWORD|%{$_.Id})|?{$b -notcontains $_})
$d=$w.Documents.Add()
$d.Content.Text='USER DOCUMENT DO NOT TOUCH'
Write-Output ('USERPID:'+$n[0])
Start-Sleep -Seconds 60
`;
    const scriptFile = path.join(work, 'user-word.ps1');
    fs.writeFileSync(scriptFile, script);
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true });
    let userPid = 0;
    await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; const m = buf.match(/USERPID:(\d+)/); if (m) { userPid = +m[1]; resolve(); } });
      setTimeout(() => reject(new Error('could not start the simulated user Word')), 60000);
    });
    try {
      const res = await tool('word-to-pdf').run([plain], {}, H.ctx({ outDir: path.join(work, 'out-shared') }));
      assert.ok(norm((await H.pdfInfo(res.outputs[0])).text).includes(MARK));
      const alive = H.listProcs(['WINWORD.EXE']).some((p) => p.endsWith(':' + userPid));
      assert.ok(alive, 'the simulated user Word instance was closed by the converter');
    } finally {
      spawnSync('taskkill', ['/pid', String(userPid), '/f', '/t'], { windowsHide: true });
      child.kill();
    }
  });

  await check('a PowerPoint the user already has open (single-instance app) keeps running with its presentation', async () => {
    const script = `
$ErrorActionPreference='Stop'
$b=@(Get-Process POWERPNT -ErrorAction SilentlyContinue|%{$_.Id})
$p=New-Object -ComObject PowerPoint.Application
$p.Visible=-1
$pres=$p.Presentations.Add(-1)
Start-Sleep 1
$n=@((Get-Process POWERPNT|%{$_.Id})|?{$b -notcontains $_})
Write-Output ('USERPID:'+$n[0])
Start-Sleep -Seconds 90
`;
    const scriptFile = path.join(work, 'user-ppt.ps1');
    fs.writeFileSync(scriptFile, script);
    const { spawn } = require('child_process');
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], { windowsHide: true });
    let userPid = 0;
    await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; const m = buf.match(/USERPID:(\d+)/); if (m) { userPid = +m[1]; resolve(); } });
      setTimeout(() => reject(new Error('could not start the simulated user PowerPoint')), 60000);
    });
    try {
      const res = await tool('office-to-pdf').run([path.join(work, 'sample-slides.pptx')], {}, H.ctx({ outDir: path.join(work, 'out-shared-ppt') }));
      assert.ok(norm((await H.pdfInfo(res.outputs[0])).text).includes('Sonika Slide Fixture 1'));
      assert.ok(H.listProcs(['POWERPNT.EXE']).some((p) => p.endsWith(':' + userPid)), 'the simulated user PowerPoint was closed by the converter');
      const q = spawnSync('powershell', ['-NoProfile', '-Command', "$p=[Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application'); Write-Output ('COUNT:'+$p.Presentations.Count)"], { encoding: 'utf8' });
      assert.ok(/COUNT:1/.test(q.stdout), `the user's presentation should still be the only one open: ${q.stdout} ${q.stderr}`);
    } finally {
      spawnSync('taskkill', ['/pid', String(userPid), '/f', '/t'], { windowsHide: true });
      child.kill();
    }
  });

  await check('no orphan WINWORD / EXCEL / POWERPNT processes remain after all tests', async () => {
    await new Promise((r) => setTimeout(r, 2000));
    assert.deepStrictEqual(H.listProcs(OFFICE_PROCS), procsAtStart);
  });

  if (timings.length) {
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`\nTiming: ${timings.length} conversions, average ${(avg / 1000).toFixed(1)} s, min ${(Math.min(...timings) / 1000).toFixed(1)} s, max ${(Math.max(...timings) / 1000).toFixed(1)} s`);
  }
  R.finish();
})().catch((e) => { console.error(e); process.exit(1); });
