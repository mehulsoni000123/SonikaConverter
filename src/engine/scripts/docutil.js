'use strict';
// Small helpers shared by pdf.js, office.js and image.js. Pure Node.
const fs = require('fs');
const path = require('path');
const util = require('../util');

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isCancelled(err) { return !!err && err.message === 'Cancelled'; }

function checkAbort(signal) {
  if (signal && signal.aborted) throw new Error('Cancelled');
}

/** Turn a Node file-system error into a sentence a non-coder can act on. */
function friendlyFsError(err, what) {
  const name = what ? `"${what}"` : 'the file';
  switch (err && err.code) {
    case 'ENOENT': return new Error(`${name} could not be found. It may have been moved or deleted.`);
    case 'EACCES':
    case 'EPERM': return new Error(`Windows would not let me use ${name}. Check that it is not read-only or locked by another program.`);
    case 'EBUSY': return new Error(`${name} is in use by another program. Close it there and try again.`);
    case 'ENOSPC': return new Error('The disk is full. Free some space or pick another output folder.');
    case 'ENAMETOOLONG': return new Error('The file name or folder path is too long for Windows. Use a shorter name or a different output folder.');
    default: return err;
  }
}

function readFileFriendly(file) {
  try { return fs.readFileSync(file); } catch (err) { throw friendlyFsError(err, path.basename(file)); }
}

function assertInputFile(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) { throw friendlyFsError(err, path.basename(file)); }
  if (!st.isFile()) throw new Error(`"${path.basename(file)}" is not a file.`);
  if (st.size === 0) throw new Error(`"${path.basename(file)}" is an empty file (0 bytes), so there is nothing to convert.`);
  return st.size;
}

/** Write `data` to a brand-new unique path "<dir>/<base><ext>" (never overwrites). Returns the path. */
function writeUnique(dir, base, ext, data) {
  for (let i = 0; i < 1000; i += 1) {
    const p = util.uniquePath(dir, base, ext);
    try {
      fs.writeFileSync(p, data, { flag: 'wx' });
      return p;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw friendlyFsError(err, path.basename(p));
    }
  }
  throw new Error('Could not find a free file name in the output folder.');
}

/** Copy an existing file to a unique name in dir (COPYFILE_EXCL: never overwrites). */
function copyUnique(srcFile, dir, base, ext) {
  for (let i = 0; i < 1000; i += 1) {
    const p = util.uniquePath(dir, base, ext);
    try {
      fs.copyFileSync(srcFile, p, fs.constants.COPYFILE_EXCL);
      return p;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw friendlyFsError(err, path.basename(p));
    }
  }
  throw new Error('Could not find a free file name in the output folder.');
}

/** Create a new, empty sub folder "<dir>/<name>" (or "<name> (2)" ...). Returns its path. */
function makeUniqueDir(dir, name) {
  for (let i = 0; i < 1000; i += 1) {
    const p = i === 0 ? path.join(dir, name) : path.join(dir, `${name} (${i + 1})`);
    try {
      fs.mkdirSync(p);
      return p;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw friendlyFsError(err, name);
    }
  }
  throw new Error('Could not create an output folder.');
}

/** Remove files we created (best effort). */
function removeFiles(files) {
  for (const f of files) { try { fs.rmSync(f, { force: true }); } catch (_) { /* ignore */ } }
}

function baseNameNoExt(file) {
  return path.basename(file, path.extname(file));
}

module.exports = {
  formatSize, isCancelled, checkAbort, friendlyFsError, readFileFriendly, assertInputFile,
  writeUnique, copyUnique, makeUniqueDir, removeFiles, baseNameNoExt,
};
