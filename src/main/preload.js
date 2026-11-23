'use strict';
// Narrow, explicit bridge between the sandboxed interface and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set([
  'state', 'jobs', 'job', 'settings', 'registry', 'files-incoming', 'overlay-open', 'nav', 'toast-jobs', 'notice',
]);

contextBridge.exposeInMainWorld('sonika', {
  // State and events
  getState: () => ipcRenderer.invoke('app:state'),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown event ' + channel);
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('ev:' + channel, handler);
    return () => ipcRenderer.removeListener('ev:' + channel, handler);
  },
  // Files
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; } },
  pickFiles: (toolId) => ipcRenderer.invoke('files:pick', toolId),
  // Jobs
  startJobs: (req) => ipcRenderer.invoke('jobs:start', req),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  openOutput: (id) => ipcRenderer.invoke('jobs:open', id),
  showOutput: (id) => ipcRenderer.invoke('jobs:show', id),
  copyText: (id) => ipcRenderer.invoke('jobs:copy', id),
  clearFinished: () => ipcRenderer.invoke('jobs:clear'),
  // Remembered choices
  saveToolOptions: (toolId, options) => ipcRenderer.invoke('tool:save-options', toolId, options),
  setLastTool: (categoryId, toolId) => ipcRenderer.invoke('tool:set-last', categoryId, toolId),
  // Settings
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  setHotkey: (accelerator) => ipcRenderer.invoke('settings:hotkey', accelerator),
  suspendHotkey: (on) => ipcRenderer.invoke('settings:hotkey-suspend', !!on),
  browse: (kind) => ipcRenderer.invoke('settings:browse', kind),
  detect: () => ipcRenderer.invoke('settings:detect'),
  openFolder: (kind) => ipcRenderer.invoke('app:open-folder', kind),
  // Overlay and toast
  overlayPick: (toolId) => ipcRenderer.invoke('overlay:pick', toolId),
  overlayDismiss: () => ipcRenderer.invoke('overlay:dismiss'),
  overlayShown: (token) => ipcRenderer.send('overlay:shown', token),
  toastResize: (height) => ipcRenderer.send('toast:resize', height),
  toastHide: () => ipcRenderer.send('toast:hide'),
  showMain: () => ipcRenderer.invoke('app:show-main'),
});
