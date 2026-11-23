'use strict';
// Shared helpers for every engine module. Pure Node, no Electron imports.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** Return a path in `dir` that does not exist yet: "base.ext", "base (2).ext", ... Never overwrite user files. */
function uniquePath(dir, base, ext) {
  if (ext && !ext.startsWith('.')) ext = '.' + ext;
  let candidate = path.join(dir, base + (ext || ''));
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n})${ext || ''}`);
    n += 1;
  }
  return candidate;
}

/** Output folder: ctx.outDir when set, otherwise the folder of the first input. Created if missing. */
function resolveOutDir(inputs, ctx) {
  const dir = (ctx && ctx.outDir) ? ctx.outDir : path.dirname(inputs[0]);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A fresh private temp folder for one job. Caller removes it with removeDir when done. */
function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || 'sonika-') ));
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

function firstExisting(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function findOnPath(exeName) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  return firstExisting(dirs.map((d) => path.join(d, exeName)));
}

function wingetFfmpegBin() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(root)) {
      if (!pkg.toLowerCase().startsWith('gyan.ffmpeg')) continue;
      for (const sub of fs.readdirSync(path.join(root, pkg))) {
        const bin = path.join(root, pkg, sub, 'bin');
        if (fs.existsSync(path.join(bin, 'ffmpeg.exe'))) return bin;
      }
    }
  } catch (_) { /* not installed this way */ }
  return null;
}

/** Locate ffmpeg.exe: settings.ffmpegPath, then PATH, then the winget install. Throws a plain-English error if missing. */
function findFfmpeg(settings) {
  const bin = wingetFfmpegBin();
  const found = firstExisting([
    settings && settings.ffmpegPath,
    findOnPath('ffmpeg.exe'),
    bin && path.join(bin, 'ffmpeg.exe'),
  ]);
  if (!found) throw new Error('FFmpeg was not found on this PC. Set its location in Settings.');
  return found;
}

function findFfprobe(settings) {
  const ffmpeg = findFfmpeg(settings);
  const probe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  const found = firstExisting([probe, findOnPath('ffprobe.exe')]);
  if (!found) throw new Error('ffprobe was not found next to FFmpeg.');
  return found;
}

/** Locate handy.exe: settings.handyPath, then known install spots. Throws a plain-English error if missing. */
function findHandy(settings) {
  const found = firstExisting([
    settings && settings.handyPath,
    'D:\\Handy\\handy.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Handy', 'handy.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Handy', 'handy.exe'),
    'C:\\Program Files\\Handy\\handy.exe',
    findOnPath('handy.exe'),
  ]);
  if (!found) throw new Error('Handy was not found on this PC. Set the location of handy.exe in Settings.');
  return found;
}

/**
 * Run a program without a console window. Resolves {code, stdout, stderr}.
 * opts: { signal, cwd, env, onStdout(chunkText), onStderr(chunkText), okCodes: [0] }
 * Rejects with a plain-English Error on a non-ok exit code, and with Error('Cancelled') when aborted.
 */
function runProcess(cmd, args, opts) {
  opts = opts || {};
  const okCodes = opts.okCodes || [0];
  return new Promise((resolve, reject) => {
    if (opts.signal && opts.signal.aborted) { reject(new Error('Cancelled')); return; }
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }); } catch (_) { child.kill(); }
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => { const t = d.toString(); stdout += t; if (opts.onStdout) opts.onStdout(t); });
    child.stderr.on('data', (d) => { const t = d.toString(); stderr += t; if (opts.onStderr) opts.onStderr(t); });
    child.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start ${path.basename(cmd)}: ${err.message}`));
    });
    child.on('close', (code) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      if (aborted) { reject(new Error('Cancelled')); return; }
      if (!okCodes.includes(code)) {
        const tail = (stderr || stdout).trim().split(/\r?\n/).slice(-4).join(' | ');
        const err = new Error(`${path.basename(cmd)} failed (code ${code}): ${tail}`);
        err.code = code; err.stdout = stdout; err.stderr = stderr;
        reject(err); return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

module.exports = {
  uniquePath, resolveOutDir, makeTempDir, removeDir,
  firstExisting, findOnPath, findFfmpeg, findFfprobe, findHandy, runProcess,
};
