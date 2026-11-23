'use strict';
// Runs one Word / Excel / PowerPoint conversion through scripts/office-convert.ps1 (COM automation).
// Safe by design: the source is copied to a private temp folder first (the user's file is never opened or locked),
// the Office instance is started hidden by the helper script, and on timeout / cancel only the instance started
// for this job is killed (its PID is reported by the helper script).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const util = require('../util');
const du = require('./docutil');

const SCRIPT = path.join(__dirname, 'office-convert.ps1');
const NICE = { word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint' };
const IMAGE = { word: 'WINWORD.EXE', excel: 'EXCEL.EXE', powerpoint: 'POWERPNT.EXE' };

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

function killInstance(pid, imageName) {
  if (!pid) return;
  try {
    // Only kill if that PID is still the expected Office program (guards against PID reuse).
    const r = spawnSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    if (r.stdout && r.stdout.toLowerCase().includes(`"${imageName.toLowerCase()}"`)) {
      spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true });
    }
  } catch (_) { /* best effort */ }
}

/** UTF-8 text files: tell Word explicitly so Hindi/accents are not garbled. Returns 65001 or 0 (let Word decide). */
function detectTextEncoding(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(fs.statSync(file).size, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return 0; // UTF-16 BOM: Word detects it
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 65001; } catch (_) { return 0; }
  } catch (_) { return 0; }
}

/**
 * opts: { app: 'word'|'excel'|'powerpoint', action: 'pdf'|'saveas', format (Word SaveAs2 code), destExt: '.pdf'|'.docx',
 *         source, outDir, baseName, suffix, timeoutSec, signal, onProgress, fitWidth }
 * Returns { outputPath, seconds }.
 */
async function runOffice(opts) {
  const { app, source, signal } = opts;
  const nice = NICE[app];
  du.checkAbort(signal);
  du.assertInputFile(source);
  const timeoutMs = Math.max(1, Number(opts.timeoutSec) || 120) * 1000;
  const srcExt = path.extname(source).toLowerCase();
  const tmp = util.makeTempDir('sonika-office-');
  const started = Date.now();
  const ownPids = new Set();
  let ownPid = 0;
  let timedOut = false;
  let success = false;
  let timer = null;
  const ac = new AbortController();
  let instanceKnown = false; // true once the helper told us the PID of its Office instance (or that it has none)
  let exited = false;
  let stopping = false;
  // Stop the job. If the helper has not yet reported which Office instance it started, wait for that first,
  // so the instance can be killed precisely (we never guess and never kill an Office window we did not start).
  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    const tick = () => {
      if (instanceKnown || exited || Date.now() - t0 > 25000) { killAll(); ac.abort(); }
      else setTimeout(tick, 100);
    };
    tick();
  };
  const killAll = () => { for (const p of ownPids) killInstance(p, IMAGE[app]); };
  const onUserAbort = () => requestStop();
  if (signal) signal.addEventListener('abort', onUserAbort, { once: true });
  try {
    const inCopy = path.join(tmp, `in${srcExt}`);
    const outTmp = path.join(tmp, `out${opts.destExt}`);
    try { fs.copyFileSync(source, inCopy); } catch (err) { throw du.friendlyFsError(err, path.basename(source)); }
    const job = {
      app, action: opts.action, format: opts.format || 0, source: inCopy, dest: outTmp,
      encoding: srcExt === '.txt' ? detectTextEncoding(source) : 0,
      fitWidth: !!opts.fitWidth,
    };
    const jobFile = path.join(tmp, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8');

    let errCode = null; let errMsg = null; let ok = false; let carry = '';
    const onLine = (line) => {
      if (!line.startsWith('SONIKA:')) return;
      const rest = line.slice(7);
      if (rest.startsWith('PID:')) { ownPid = parseInt(rest.slice(4), 10) || 0; if (ownPid) ownPids.add(ownPid); instanceKnown = true; }
      else if (rest.startsWith('NOPID')) { instanceKnown = true; }
      else if (rest.startsWith('PROGRESS:')) {
        const m = rest.slice(9).match(/^([0-9.]+):(.*)$/);
        if (m && opts.onProgress) opts.onProgress(Math.min(0.95, parseFloat(m[1])), m[2]);
      } else if (rest.startsWith('ERR:')) {
        const m = rest.slice(4).match(/^([a-z]+):(.*)$/);
        errCode = m ? m[1] : 'other'; errMsg = m ? m[2] : rest.slice(4);
      } else if (rest.startsWith('OK')) ok = true;
    };
    timer = setTimeout(() => { timedOut = true; requestStop(); }, timeoutMs);

    try {
      await util.runProcess(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-JobFile', jobFile], {
        signal: ac.signal,
        okCodes: [0, 1, 2],
        onStdout: (chunk) => {
          carry += chunk;
          let idx;
          while ((idx = carry.indexOf('\n')) >= 0) { onLine(carry.slice(0, idx).replace(/\r$/, '')); carry = carry.slice(idx + 1); }
        },
      });
      if (carry) onLine(carry.replace(/\r$/, ''));
    } catch (err) {
      exited = true;
      if (du.isCancelled(err)) {
        killAll();
        if (timedOut) throw new Error(`${nice} took longer than ${Math.round(timeoutMs / 1000)} seconds on this file, so I stopped it. Very large or complex files can need more time.`);
        throw err;
      }
      throw err;
    }
    if (!ok) {
      if (errMsg) throw new Error(errMsg);
      throw new Error(`${nice} did not finish the conversion. Make sure it opens normally on this PC (activation or first-run screens can block it).`);
    }
    if (!fs.existsSync(outTmp) || fs.statSync(outTmp).size === 0) throw new Error(`${nice} finished but the result file is empty.`);
    const outDir = opts.outDir;
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = du.copyUnique(outTmp, outDir, opts.baseName + (opts.suffix || ''), opts.destExt);
    success = true;
    return { outputPath, seconds: (Date.now() - started) / 1000 };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onUserAbort);
    // Safety net: if our helper died before it could quit its Office instance, make sure it is gone.
    if (!success) killAll();
    util.removeDir(tmp);
  }
}

module.exports = { runOffice, NICE };
