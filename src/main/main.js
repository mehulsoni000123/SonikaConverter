'use strict';
// Sonika Converter - Electron main process.
// Windows: main window (wheel home screen), pre-created hotkey overlay, small progress toast. Tray icon.
// Engine runs in a utility process (engine-host.js) through a 2-at-a-time job queue.
const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, screen,
  Notification, nativeImage, clipboard, session,
} = require('electron');

// ---- Hooks that must run before the app is ready -------------------------------------------
// SONIKA_USERDATA: throwaway settings folder for tests. SONIKA_SCALE: emulate Windows display scaling.
if (process.env.SONIKA_USERDATA) app.setPath('userData', path.resolve(process.env.SONIKA_USERDATA));
if (process.env.SONIKA_SCALE) app.commandLine.appendSwitch('force-device-scale-factor', String(process.env.SONIKA_SCALE));
const SCENARIO = process.env.SONIKA_SCENARIO ? path.resolve(process.env.SONIKA_SCENARIO) : null;

const { Settings } = require('./settings');
const { JobQueue } = require('./queue');
const { EngineClient } = require('./engine-client');
const cli = require('./cli');
const util = require('../engine/util');

const APP_NAME = 'Sonika Converter';
const APP_ID = 'com.sonika.converter';
const ROOT = path.join(__dirname, '..', '..');
const ASSETS = path.join(ROOT, 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);

const launchArgs = cli.userArgs(process.argv, app.isPackaged);
const gotLock = app.requestSingleInstanceLock({ args: launchArgs, cwd: process.cwd() });
if (!gotLock) {
  // Another copy is running: it receives our arguments through 'second-instance'.
  app.quit();
} else {
  boot();
}

function boot() {
  let settings = null;
  let engine = null;
  let queue = null;
  let mainWindow = null;
  let overlayWindow = null;
  let toastWindow = null;
  let tray = null;
  let quitting = false;
  let mainReady = false;
  const pendingIncoming = [];      // file lists waiting for the main window to load
  const toastBatches = new Set();  // batches shown in the toast
  let hotkeyState = { accelerator: '', ok: false, message: '' };
  let hotkeySuspended = false;
  const overlayTiming = { token: 0, t0: 0, last: -1 };
  const startedLoginItemWrites = []; // scenario mode records instead of writing the registry

  const collector = new cli.BatchCollector((batch) => handleBatch(batch), 300);

  // ---- helpers --------------------------------------------------------------------------------
  const registry = () => engine.registry;
  const findTool = (id) => registry().tools.find((t) => t.id === id) || null;

  function engineSettings() {
    const s = settings.get();
    return {
      handyPath: s.handyPath || '', ffmpegPath: s.ffmpegPath || '',
      outputMode: s.outputMode, outputFolder: s.outputFolder,
    };
  }

  function outDir() {
    const s = settings.get();
    return (s.outputMode === 'folder' && s.outputFolder) ? s.outputFolder : null;
  }

  function savedOptions(tool) {
    const defaults = {};
    for (const o of tool.options || []) defaults[o.key] = o.default;
    const saved = settings.toolOptions(tool.id) || {};
    const out = { ...defaults };
    for (const o of tool.options || []) if (Object.prototype.hasOwnProperty.call(saved, o.key)) out[o.key] = saved[o.key];
    return out;
  }

  function accepts(tool, file) {
    return tool.accepts.includes(path.extname(file).toLowerCase());
  }

  function send(win, channel, payload) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('ev:' + channel, payload);
    }
  }
  function broadcast(channel, payload) {
    for (const w of [mainWindow, overlayWindow, toastWindow]) send(w, channel, payload);
  }

  function publicSettings() {
    const s = settings.get();
    return { ...s };
  }

  function detectTools() {
    const s = engineSettings();
    const out = {};
    for (const [key, fn, label] of [['handy', util.findHandy, 'Handy'], ['ffmpeg', util.findFfmpeg, 'FFmpeg']]) {
      try {
        const p = fn(s);
        out[key] = { ok: true, path: p, message: `${label} found` };
      } catch (err) {
        out[key] = { ok: false, path: '', message: String(err.message || `${label} was not found.`) };
      }
    }
    return out;
  }

  // ---- jobs -----------------------------------------------------------------------------------
  /**
   * Start jobs for a tool. 'each' tools get one job per file, 'combine' tools one job for all files.
   * Returns { ok, batchId, jobIds, skipped, message }.
   */
  function startJobs({ toolId, files, options, source, persist }) {
    const tool = findTool(toolId);
    if (!tool) return { ok: false, message: 'That converter is not available right now.', jobIds: [], skipped: [] };
    const list = [...new Set((files || []).map(String))];
    const skipped = [];
    const usable = [];
    for (const f of list) {
      if (!fs.existsSync(f)) skipped.push({ file: f, reason: 'not found' });
      else if (!accepts(tool, f)) skipped.push({ file: f, reason: 'wrong type' });
      else usable.push(f);
    }
    if (usable.length === 0) {
      const why = skipped.length ? `${tool.label} cannot use ${skipped.length === 1 ? 'this file' : 'these files'}.` : 'No files were chosen.';
      return { ok: false, message: why, jobIds: [], skipped };
    }
    // Only keys the tool declares; choice values must be one of its choices.
    const clean = {};
    for (const o of tool.options || []) {
      if (!options || !Object.prototype.hasOwnProperty.call(options, o.key)) continue;
      const v = options[o.key];
      if (o.type === 'choice' && !(o.choices || []).some((c) => c.value === v)) continue;
      clean[o.key] = v;
    }
    const opts = { ...savedOptions(tool), ...clean };
    if (options && persist !== false) settings.setToolOptions(tool.id, opts);
    settings.setLastTool(tool.category, tool.id);
    const batchId = queue.newBatchId();
    const common = { tool, options: opts, outDir: outDir(), settings: engineSettings(), batchId, source: source || 'app' };
    const jobs = tool.multi === 'combine'
      ? [queue.add({ ...common, inputs: usable })]
      : usable.map((f) => queue.add({ ...common, inputs: [f] }));
    if (source === 'overlay' || source === 'cli') { toastBatches.add(batchId); showToast(); }
    let message = '';
    if (skipped.length) message = `${skipped.length} file${skipped.length > 1 ? 's were' : ' was'} skipped (not a type ${tool.label} can use).`;
    return { ok: true, batchId, jobIds: jobs.map((j) => j.id), skipped, message };
  }

  const pendingJobSends = new Map();
  let jobSendTimer = null;
  function queueJobSend(job) {
    pendingJobSends.set(job.id, job);
    if (jobSendTimer) return;
    jobSendTimer = setTimeout(() => {
      jobSendTimer = null;
      const jobs = [...pendingJobSends.values()];
      pendingJobSends.clear();
      for (const j of jobs) broadcast('job', require('./queue').publicJob(j));
      updateToast();
      updateTrayTooltip();
    }, 40);
  }

  function onBatchDone(batchId, jobs) {
    const done = jobs.filter((j) => j.status === 'done');
    const failed = jobs.filter((j) => j.status === 'error');
    const firstOut = done.find((j) => j.outputs && j.outputs.length);
    if (firstOut) settings.update({ lastOutputDir: path.dirname(firstOut.outputs[0]) });
    rebuildTrayMenu();
    const anyFocused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused());
    if (anyFocused || (done.length === 0 && failed.length === 0)) return;
    if (!Notification.isSupported()) return;
    const tool = jobs[0].toolLabel;
    let body;
    if (failed.length === 0) body = done.length === 1 ? `${jobs[0].title} is ready.` : `${done.length} files are ready.`;
    else if (done.length === 0) body = failed.length === 1 ? failed[0].error : `${failed.length} files could not be converted.`;
    else body = `${done.length} ready, ${failed.length} could not be converted.`;
    const n = new Notification({ title: `${tool} finished`, body, icon: path.join(ASSETS, 'icon.png'), silent: false });
    n.on('click', () => {
      if (firstOut) shell.showItemInFolder(firstOut.outputs[0]);
      else showMain();
    });
    n.show();
    if (SCENARIO) lastNotification = { title: `${tool} finished`, body };
  }
  let lastNotification = null;

  // ---- windows ----------------------------------------------------------------------------------
  const webPrefs = () => ({
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    devTools: !app.isPackaged,
  });

  function lockDown(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
  }

  function createMainWindow(show) {
    mainWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 900,
      minHeight: 640,
      show: false,
      title: APP_NAME,
      icon: path.join(ASSETS, 'icon.ico'),
      backgroundColor: '#0B0F0D',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0B0F0D', symbolColor: '#C7CFCA', height: 44 },
      webPreferences: webPrefs(),
    });
    lockDown(mainWindow);
    mainWindow.loadFile(path.join(RENDERER, 'index.html'));
    mainWindow.webContents.on('did-finish-load', () => {
      mainReady = true;
      while (pendingIncoming.length) send(mainWindow, 'files-incoming', pendingIncoming.shift());
    });
    mainWindow.once('ready-to-show', () => { if (show) { mainWindow.show(); mainWindow.focus(); } });
    mainWindow.on('close', (e) => {
      if (quitting) return;
      if (settings.get().closeToTray) {
        e.preventDefault();
        mainWindow.hide();
        if (!settings.get().trayHintShown && Notification.isSupported() && !SCENARIO) {
          new Notification({ title: APP_NAME, body: 'Still running in the tray. Your shortcut keeps working.', icon: path.join(ASSETS, 'icon.png') }).show();
          settings.update({ trayHintShown: true });
        }
      } else {
        quitting = true;
        app.quit();
      }
    });
  }

  function createOverlayWindow() {
    overlayWindow = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      title: APP_NAME + ' wheel',
      webPreferences: webPrefs(),
    });
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    lockDown(overlayWindow);
    overlayWindow.loadFile(path.join(RENDERER, 'overlay.html'));
    overlayWindow.on('blur', () => { if (overlayWindow.isVisible()) hideOverlay(); });
  }

  function createToastWindow() {
    toastWindow = new BrowserWindow({
      width: 380,
      height: 120,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      title: APP_NAME + ' progress',
      webPreferences: webPrefs(),
    });
    toastWindow.setAlwaysOnTop(true, 'pop-up-menu');
    lockDown(toastWindow);
    toastWindow.loadFile(path.join(RENDERER, 'toast.html'));
  }

  function showMain() {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow(true);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function showOverlay() {
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    overlayTiming.token += 1;
    overlayTiming.t0 = process.hrtime.bigint();
    overlayWindow.setBounds(display.bounds);
    send(overlayWindow, 'overlay-open', {
      token: overlayTiming.token,
      cursor: { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y },
      hotkey: hotkeyState.accelerator,
      lastTool: settings.get().lastTool || {},
    });
    overlayWindow.show();
    overlayWindow.focus();
  }

  function hideOverlay() {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
  }

  function toastJobs() {
    return queue.list().filter((j) => toastBatches.has(j.batchId));
  }

  function showToast() {
    if (!toastWindow || toastWindow.isDestroyed()) createToastWindow();
    positionToast(toastWindow.getBounds().height);
    send(toastWindow, 'toast-jobs', toastJobs());
    if (!toastWindow.isVisible()) toastWindow.showInactive();
  }

  function positionToast(height) {
    const cursor = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cursor).workArea;
    const w = 380;
    const h = Math.max(80, Math.min(420, Math.round(height || 120)));
    toastWindow.setBounds({ x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16, width: w, height: h });
  }

  function updateToast() {
    if (toastWindow && !toastWindow.isDestroyed() && toastBatches.size) send(toastWindow, 'toast-jobs', toastJobs());
  }

  // ---- tray -------------------------------------------------------------------------------------
  function recentOutputsDir() {
    const s = settings.get();
    if (s.lastOutputDir && fs.existsSync(s.lastOutputDir)) return s.lastOutputDir;
    if (s.outputMode === 'folder' && s.outputFolder && fs.existsSync(s.outputFolder)) return s.outputFolder;
    return '';
  }

  function rebuildTrayMenu() {
    if (!tray) return;
    const recent = recentOutputsDir();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Sonika Converter', click: () => showMain() },
      { label: `Show wheel${hotkeyState.ok ? '   (' + hotkeyState.accelerator + ')' : ''}`, click: () => showOverlay() },
      { label: 'Open recent outputs folder', enabled: !!recent, click: () => { const d = recentOutputsDir(); if (d) shell.openPath(d); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  }

  function updateTrayTooltip() {
    if (!tray) return;
    const running = queue.list().filter((j) => j.status === 'running' || j.status === 'queued').length;
    tray.setToolTip(running ? `${APP_NAME} - ${running} job${running > 1 ? 's' : ''} running` : APP_NAME);
  }

  function createTray() {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.on('click', () => showMain());
    rebuildTrayMenu();
  }

  // ---- hotkey -----------------------------------------------------------------------------------
  function tryRegister(accel) {
    try { return globalShortcut.register(accel, () => showOverlay()); } catch (_) { return false; }
  }

  function registerHotkey(accel) {
    if (hotkeyState.accelerator && hotkeyState.ok) {
      try { globalShortcut.unregister(hotkeyState.accelerator); } catch (_) { /* ignore */ }
    }
    const ok = !!accel && tryRegister(accel);
    hotkeyState = {
      accelerator: accel,
      ok,
      message: ok ? '' : `${accel} is already used by another app, so it could not be turned on. Pick a different shortcut in Settings.`,
    };
    rebuildTrayMenu();
    return hotkeyState;
  }

  // Shortcuts tried, in order, while the user has never picked one and the default is busy.
  const DEFAULT_HOTKEY = 'Ctrl+Alt+Space';
  const FALLBACK_HOTKEYS = ['Alt+Shift+Space', 'Ctrl+Shift+Alt+Space', 'Ctrl+Alt+C'];

  /** Register the saved shortcut at startup; if the untouched default is busy, use a free fallback. */
  function registerStartupHotkey() {
    const s = settings.get();
    const st = registerHotkey(s.hotkey);
    if (st.ok || s.hotkeyChosen || s.hotkey !== DEFAULT_HOTKEY) return st;
    for (const alt of FALLBACK_HOTKEYS) {
      if (tryRegister(alt)) {
        hotkeyState = {
          accelerator: alt,
          ok: true,
          fallback: true,
          message: `${DEFAULT_HOTKEY} is used by another app on this PC, so the wheel opens with ${alt} instead. You can change it here.`,
        };
        rebuildTrayMenu();
        return hotkeyState;
      }
    }
    return st;
  }

  const MOD_KEYS = new Set(['Ctrl', 'Control', 'Alt', 'Shift', 'Super', 'CommandOrControl', 'CmdOrCtrl']);
  const MAIN_KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|num[0-9]|[`\-=[\]\\;',./])$/;
  function validAccelerator(accel) {
    const parts = accel.split('+');
    const k = parts.pop();
    if (!MAIN_KEY.test(k)) return false;
    if (!parts.every((p) => MOD_KEYS.has(p))) return false;
    return /^F\d+$/.test(k) || parts.some((p) => p !== 'Shift');
  }

  function changeHotkey(accel) {
    accel = String(accel || '').trim();
    if (!accel) return { ok: false, message: 'Press a key combination first.', hotkey: hotkeyState };
    if (!validAccelerator(accel)) {
      return { ok: false, message: `${accel} cannot be used as a shortcut. Use Ctrl, Alt or the Windows key together with a letter, number or F-key.`, hotkey: hotkeyState };
    }
    const previous = hotkeyState.accelerator;
    if (accel === previous && hotkeyState.ok) {
      settings.update({ hotkey: accel, hotkeyChosen: true });
      hotkeyState = { accelerator: accel, ok: true, message: '' };
      return { ok: true, message: `The wheel opens with ${accel}.`, hotkey: hotkeyState };
    }
    if (hotkeyState.ok && previous) { try { globalShortcut.unregister(previous); } catch (_) { /* ignore */ } }
    if (tryRegister(accel)) {
      hotkeyState = { accelerator: accel, ok: true, message: '' };
      settings.update({ hotkey: accel, hotkeyChosen: true });
      rebuildTrayMenu();
      broadcast('settings', publicSettings());
      return { ok: true, message: `Shortcut changed to ${accel}.`, hotkey: hotkeyState };
    }
    // Put the old one back.
    const restored = previous ? tryRegister(previous) : false;
    hotkeyState = { accelerator: previous, ok: restored, message: restored ? '' : hotkeyState.message };
    return {
      ok: false,
      message: `${accel} is already used by another app (or by Windows). Try a different combination.`,
      hotkey: hotkeyState,
    };
  }

  function applyStartWithWindows(on) {
    const opts = {
      openAtLogin: !!on,
      name: APP_ID, // value name in the HKCU Run key; uninstall.ps1 removes it
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
    };
    if (SCENARIO) { startedLoginItemWrites.push(opts); return; } // tests never touch the registry
    app.setLoginItemSettings(opts);
  }

  // ---- launches (first run, second instance, Explorer) ----------------------------------------
  function handleLaunch(parsed) {
    if (parsed.files.length) { collector.add(parsed); return; }
    if (parsed.wheel) { showOverlay(); return; }
    if (!parsed.hidden) showMain();
  }

  function handleBatch(batch) {
    if (batch.tool) {
      const tool = findTool(batch.tool);
      if (!tool) {
        showMain();
        send(mainWindow, 'notice', { kind: 'error', text: `Unknown converter "${batch.tool}". The files were loaded instead.` });
        deliverFiles(batch.files);
        return;
      }
      const res = startJobs({ toolId: tool.id, files: batch.files, options: batch.options || undefined, source: 'cli', persist: false });
      if (!res.ok) {
        showMain();
        send(mainWindow, 'notice', { kind: 'error', text: res.message });
      }
      return;
    }
    showMain();
    deliverFiles(batch.files);
  }

  function deliverFiles(files) {
    const payload = { files, at: Date.now() };
    if (mainReady) send(mainWindow, 'files-incoming', payload);
    else pendingIncoming.push(payload);
  }

  app.on('second-instance', (_e, argv, cwd, data) => {
    const args = (data && Array.isArray(data.args)) ? data.args : cli.userArgs(argv, app.isPackaged);
    handleLaunch(cli.parseArgs(args, (data && data.cwd) || cwd));
  });

  // ---- IPC --------------------------------------------------------------------------------------
  function jobOutputs(id) {
    const job = queue.get(id);
    return job && job.status === 'done' ? job.outputs.filter((p) => fs.existsSync(p)) : [];
  }

  function registerIpc() {
    ipcMain.handle('app:state', () => ({
      appName: APP_NAME,
      version: app.getVersion(),
      categories: registry().categories,
      tools: registry().tools,
      loadErrors: registry().loadErrors,
      settings: publicSettings(),
      jobs: queue.list(),
      hotkey: hotkeyState,
      tools_detect: detectTools(),
    }));
    ipcMain.handle('files:pick', async (e, toolId) => {
      const tool = findTool(toolId);
      const parent = BrowserWindow.fromWebContents(e.sender);
      const filters = tool
        ? [{ name: `${tool.label} files`, extensions: tool.accepts.map((x) => x.replace(/^\./, '')) }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'All files', extensions: ['*'] }];
      const res = await dialog.showOpenDialog(parent, {
        title: tool ? `${tool.label} - choose files` : 'Choose files',
        properties: ['openFile', 'multiSelections'],
        filters,
      });
      return res.canceled ? [] : res.filePaths;
    });
    ipcMain.handle('jobs:start', (_e, req) => startJobs({ toolId: req && req.toolId, files: req && req.files, options: req && req.options, source: 'app', persist: true }));
    ipcMain.handle('jobs:cancel', (_e, id) => queue.cancel(id));
    ipcMain.handle('jobs:open', async (_e, id) => {
      const outs = jobOutputs(id);
      if (!outs.length) return { ok: false, message: 'The output file is no longer there.' };
      const err = await shell.openPath(outs[0]);
      return { ok: !err, message: err || '' };
    });
    ipcMain.handle('jobs:show', (_e, id) => {
      const outs = jobOutputs(id);
      if (!outs.length) return { ok: false, message: 'The output file is no longer there.' };
      shell.showItemInFolder(outs[0]);
      return { ok: true };
    });
    ipcMain.handle('jobs:copy', (_e, id) => {
      const job = queue.get(id);
      if (!job || typeof job.text !== 'string') return { ok: false };
      clipboard.writeText(job.text);
      return { ok: true };
    });
    ipcMain.handle('jobs:clear', () => { queue.clearFinished(); broadcast('jobs', queue.list()); return true; });
    ipcMain.handle('tool:save-options', (_e, toolId, options) => {
      if (!findTool(toolId)) return false;
      settings.setToolOptions(toolId, options || {});
      return true;
    });
    ipcMain.handle('tool:set-last', (_e, categoryId, toolId) => {
      const t = findTool(toolId);
      if (!t || t.category !== categoryId) return false;
      settings.setLastTool(categoryId, toolId);
      return true;
    });
    ipcMain.handle('settings:update', (_e, patch) => {
      const allowed = ['outputMode', 'outputFolder', 'handyPath', 'ffmpegPath', 'startWithWindows', 'closeToTray', 'instantMode'];
      const clean = {};
      for (const k of allowed) if (patch && Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
      if ('outputMode' in clean && !['source', 'folder'].includes(clean.outputMode)) delete clean.outputMode;
      for (const k of ['startWithWindows', 'closeToTray', 'instantMode']) if (k in clean) clean[k] = !!clean[k];
      const before = settings.get().startWithWindows;
      settings.update(clean);
      if ('startWithWindows' in clean && clean.startWithWindows !== before) applyStartWithWindows(clean.startWithWindows);
      rebuildTrayMenu();
      broadcast('settings', publicSettings());
      return { ok: true, settings: publicSettings(), detect: detectTools() };
    });
    ipcMain.handle('settings:hotkey', (_e, accel) => {
      hotkeySuspended = false;
      return changeHotkey(accel);
    });
    ipcMain.handle('settings:hotkey-suspend', (_e, on) => {
      if (on && !hotkeySuspended) {
        hotkeySuspended = true;
        if (hotkeyState.ok) { try { globalShortcut.unregister(hotkeyState.accelerator); } catch (_) { /* ignore */ } }
      } else if (!on && hotkeySuspended) {
        hotkeySuspended = false;
        registerHotkey(hotkeyState.accelerator || settings.get().hotkey);
      }
      return hotkeyState;
    });
    ipcMain.handle('settings:browse', async (e, kind) => {
      const parent = BrowserWindow.fromWebContents(e.sender);
      let res;
      if (kind === 'outputFolder') {
        res = await dialog.showOpenDialog(parent, { title: 'Choose the output folder', properties: ['openDirectory', 'createDirectory'] });
        if (!res.canceled && res.filePaths[0]) settings.update({ outputFolder: res.filePaths[0], outputMode: 'folder' });
      } else if (kind === 'handy' || kind === 'ffmpeg') {
        const exe = kind === 'handy' ? 'handy.exe' : 'ffmpeg.exe';
        res = await dialog.showOpenDialog(parent, {
          title: `Find ${exe}`, properties: ['openFile'], filters: [{ name: exe, extensions: ['exe'] }],
        });
        if (!res.canceled && res.filePaths[0]) settings.update({ [kind + 'Path']: res.filePaths[0] });
      } else {
        return { ok: false };
      }
      broadcast('settings', publicSettings());
      return { ok: !res.canceled, settings: publicSettings(), detect: detectTools() };
    });
    ipcMain.handle('settings:detect', () => detectTools());
    ipcMain.handle('app:open-folder', (_e, kind) => {
      const dir = kind === 'outputs' ? recentOutputsDir() : '';
      if (dir) shell.openPath(dir);
      return !!dir;
    });
    ipcMain.handle('app:show-main', () => { showMain(); return true; });
    ipcMain.handle('overlay:dismiss', () => { hideOverlay(); return true; });
    ipcMain.handle('overlay:pick', async (_e, toolId) => {
      hideOverlay();
      const tool = findTool(toolId);
      if (!tool) return { ok: false };
      settings.setLastTool(tool.category, tool.id);
      if (overlayPickHook) return overlayPickHook(tool);
      const res = await dialog.showOpenDialog({
        title: `${tool.label} - choose files`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: `${tool.label} files`, extensions: tool.accepts.map((x) => x.replace(/^\./, '')) }, { name: 'All files', extensions: ['*'] }],
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      return startJobs({ toolId: tool.id, files: res.filePaths, source: 'overlay' });
    });
    ipcMain.on('overlay:shown', (_e, token) => {
      if (token === overlayTiming.token && overlayTiming.t0) {
        overlayTiming.last = Number(process.hrtime.bigint() - overlayTiming.t0) / 1e6;
        overlayTiming.t0 = 0;
      }
    });
    ipcMain.on('toast:resize', (_e, h) => { if (toastWindow && !toastWindow.isDestroyed()) positionToast(h); });
    ipcMain.on('toast:hide', () => {
      toastBatches.clear();
      if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide();
    });
  }
  let overlayPickHook = null; // scenario tests replace the file dialog

  // ---- startup ----------------------------------------------------------------------------------
  app.whenReady().then(async () => {
    settings = new Settings(app.getPath('userData'));
    Menu.setApplicationMenu(null);

    // Offline only: refuse every network request and every permission prompt.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));

    engine = new EngineClient(SCENARIO ? { SONIKA_INJECT_TOOLS: SCENARIO } : {});
    await engine.start();
    engine.on('registry', (r) => broadcast('registry', r));

    queue = new JobQueue({
      concurrency: settings.get().concurrency || 2,
      runner: (job, onProgress) => engine.run({
        jobId: job.id, toolId: job.toolId, inputs: job.inputs, options: job.options, outDir: job.outDir, settings: job.settings,
      }, onProgress),
    });
    queue.on('update', (job) => queueJobSend(job));
    queue.on('batch-done', (id, jobs) => onBatchDone(id, jobs));

    registerIpc();
    const startHidden = cli.parseArgs(launchArgs, process.cwd()).hidden || !!SCENARIO;
    createMainWindow(!startHidden);
    createOverlayWindow();
    createToastWindow();
    createTray();
    registerStartupHotkey();

    // Handle our own command line (files from Explorer, --tool, --wheel).
    const first = cli.parseArgs(launchArgs, process.cwd());
    if (!SCENARIO && (first.files.length || first.wheel)) handleLaunch(first);

    if (SCENARIO) runScenario();
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (engine) engine.stop();
  });
  app.on('window-all-closed', () => { /* stays in the tray */ });

  // ---- scenario test hook -------------------------------------------------------------------------
  function runScenario() {
    const harness = {
      app, ROOT,
      get mainWindow() { return mainWindow; },
      get overlayWindow() { return overlayWindow; },
      get toastWindow() { return toastWindow; },
      get tray() { return tray; },
      get settings() { return settings; },
      get queue() { return queue; },
      get registry() { return registry(); },
      get hotkeyState() { return hotkeyState; },
      get overlayLatencyMs() { return overlayTiming.last; },
      get lastNotification() { return lastNotification; },
      get loginItemWrites() { return startedLoginItemWrites.slice(); },
      get mainReady() { return mainReady; },
      setOverlayPickHook(fn) { overlayPickHook = fn; },
      startJobs, showOverlay, hideOverlay, showMain, showToast, handleLaunch, collector, cli, detectTools,
      changeHotkey, registerHotkey,
    };
    const waitLoaded = () => new Promise((resolve) => {
      const check = () => (mainReady && !overlayWindow.webContents.isLoading() && !toastWindow.webContents.isLoading()) ? resolve() : setTimeout(check, 50);
      check();
    });
    waitLoaded()
      .then(() => require(SCENARIO).run(harness))
      .then((code) => { quitting = true; app.exit(code || 0); })
      .catch((err) => { console.error('SCENARIO CRASH', err && err.stack); quitting = true; app.exit(2); });
  }
}
