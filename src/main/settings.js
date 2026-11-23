'use strict';
// Persistent settings stored as JSON in the user-data folder. Writes are atomic (temp file + rename).
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  outputMode: 'source',          // 'source' = next to the source file, 'folder' = one fixed folder
  outputFolder: '',
  handyPath: '',                 // '' = auto-detect
  ffmpegPath: '',                // '' = auto-detect
  hotkey: 'Ctrl+Alt+Space',
  hotkeyChosen: false,           // true once the user picks a shortcut; until then a busy default falls back
  startWithWindows: false,
  closeToTray: true,
  instantMode: true,
  concurrency: 2,
  toolOptions: {},               // { [toolId]: { key: value } } remembered per tool
  lastTool: {},                  // { [categoryId]: toolId } last tool used in each wheel slot
  trayHintShown: false,
  lastOutputDir: '',
});

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS, toolOptions: {}, lastTool: {} };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') this.data = { ...DEFAULTS, ...raw };
    } catch (_) { /* first run or unreadable: keep defaults */ }
    if (!this.data.toolOptions || typeof this.data.toolOptions !== 'object') this.data.toolOptions = {};
    if (!this.data.lastTool || typeof this.data.lastTool !== 'object') this.data.lastTool = {};
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  get() { return this.data; }

  /** Merge a patch of known keys only, then save. Returns the new data. */
  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) this.data[k] = v;
    }
    this.save();
    return this.data;
  }

  toolOptions(toolId) { return this.data.toolOptions[toolId] || null; }

  setToolOptions(toolId, options) {
    this.data.toolOptions[toolId] = { ...(options || {}) };
    this.save();
  }

  setLastTool(categoryId, toolId) {
    this.data.lastTool[categoryId] = toolId;
    this.save();
  }
}

module.exports = { Settings, DEFAULTS };
