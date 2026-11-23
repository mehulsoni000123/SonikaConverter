'use strict';
// Command-line parsing and the batch collector for files forwarded by Explorer.
//   "Sonika Converter.exe" --tool <toolId> <file>...   -> run that tool on the files with saved options
//   "Sonika Converter.exe" --tool <toolId> --opt key=value <file>...  -> same, overriding one option for this run only
//   "Sonika Converter.exe" <file>...                   -> open the main window with those files loaded
//   "Sonika Converter.exe" --hidden                    -> start in the tray (used by Start with Windows)
//   "Sonika Converter.exe" --wheel                     -> pop the wheel overlay
const path = require('path');

/** Arguments the user (or Explorer) passed, without electron.exe / the app path. */
function userArgs(argv, isPackaged) {
  const args = argv.slice(isPackaged ? 1 : 2);
  // When started as `electron path/to/app`, skip a leading app-path argument if present.
  return args;
}

/**
 * Parse arguments into { tool, files, hidden, wheel }.
 * Unknown "--flags" (Chromium switches) are ignored. Relative paths resolve against cwd.
 */
function parseArgs(args, cwd) {
  const out = { tool: null, files: [], hidden: false, wheel: false, options: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '');
    if (!a) continue;
    if (a === '--tool' || a === '-t') { out.tool = args[i + 1] || null; i += 1; continue; }
    if (a.startsWith('--tool=')) { out.tool = a.slice(7) || null; continue; }
    if (a === '--opt' || a.startsWith('--opt=')) {
      const kv = a === '--opt' ? String(args[i + 1] || '') : a.slice(6);
      if (a === '--opt') i += 1;
      const eq = kv.indexOf('=');
      if (eq > 0) {
        out.options = out.options || {};
        const raw = kv.slice(eq + 1);
        out.options[kv.slice(0, eq)] = raw === 'true' ? true : raw === 'false' ? false : (raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
      }
      continue;
    }
    if (a === '--hidden') { out.hidden = true; continue; }
    if (a === '--wheel') { out.wheel = true; continue; }
    if (a.startsWith('--')) continue;
    if (a === '.') continue; // `electron .`
    out.files.push(path.resolve(cwd || process.cwd(), a));
  }
  return out;
}

/**
 * Collects forwarded requests for a short window and flushes them as one batch per tool.
 * Explorer starts one process per selected file, so 5 selected files arrive as 5 quick requests.
 */
class BatchCollector {
  constructor(onFlush, windowMs) {
    this.onFlush = onFlush;
    this.windowMs = windowMs == null ? 300 : windowMs;
    this.pending = new Map(); // key -> { tool, files:Set }
    this.timer = null;
  }

  add(parsed) {
    if (!parsed || !parsed.files || parsed.files.length === 0) return false;
    const key = (parsed.tool || '') + '|' + JSON.stringify(parsed.options || null);
    if (!this.pending.has(key)) this.pending.set(key, { tool: parsed.tool || null, options: parsed.options || null, files: new Set() });
    const entry = this.pending.get(key);
    for (const f of parsed.files) entry.files.add(f);
    // Each new arrival extends the window a little, so a slow Explorer burst still lands as one batch.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    return true;
  }

  flush() {
    this.timer = null;
    const batches = [...this.pending.values()].map((e) => ({ tool: e.tool, options: e.options, files: [...e.files] }));
    this.pending.clear();
    for (const b of batches) this.onFlush(b);
  }
}

module.exports = { userArgs, parseArgs, BatchCollector };
