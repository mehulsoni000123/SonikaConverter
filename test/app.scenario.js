'use strict';
// Drives the real Sonika Converter app (main process + windows) and checks the interface end to end.
// Launched by test/run-all.js as:  electron . with SONIKA_SCENARIO=<this file>, SONIKA_USERDATA=<temp dir>
// This module is loaded twice: by the engine utility process (to read `fakeTools`) and by the main
// process (to call `run`). Keep the top level free of side effects and of Electron imports.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCREENS = process.env.SONIKA_SCREENS || path.join(__dirname, 'screens');
const util = require(path.join(ROOT, 'src', 'engine', 'util.js'));

// ------------------------------------------------------------------ fake tools (engine side)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function writeOut(inputs, ctx, suffix, ext, body) {
  const dir = util.resolveOutDir(inputs, ctx);
  const stem = path.basename(inputs[0], path.extname(inputs[0]));
  const out = util.uniquePath(dir, stem + suffix, ext);
  fs.writeFileSync(out, body || 'test output');
  return out;
}
function checkAbort(signal) { if (signal && signal.aborted) throw new Error('Cancelled'); }

const fakeTools = [
  {
    id: 'test-ok', category: 'audio', label: 'Test Extract', hint: 'Scenario tool that always works',
    accepts: ['.mp4', '.mov', '.tst'], multi: 'each',
    options: [
      { key: 'format', label: 'Format', type: 'choice', choices: [{ value: 'mp3', label: 'MP3' }, { value: 'wav', label: 'WAV' }], default: 'mp3' },
      { key: 'quality', label: 'Quality', type: 'number', default: 5 },
    ],
    async run(inputs, options, ctx) {
      ctx.onProgress(0.3, 'Reading');
      await sleep(120);
      ctx.onProgress(0.7, 'Writing');
      await sleep(120);
      checkAbort(ctx.signal);
      const out = writeOut(inputs, ctx, ' (test)', '.' + options.format, 'q=' + options.quality);
      return { outputs: [out], message: 'Test output written' };
    },
  },
  {
    id: 'test-slow', category: 'video', label: 'Test Slow Job', hint: 'Scenario tool that takes a while',
    accepts: ['.mp4', '.tst'], multi: 'each', options: [],
    async run(inputs, options, ctx) {
      for (let i = 1; i <= 40; i += 1) {
        checkAbort(ctx.signal);
        ctx.onProgress(i / 40, `Step ${i} of 40`);
        await sleep(150);
      }
      return { outputs: [writeOut(inputs, ctx, ' (slow)', '.txt')], message: 'Slow job finished' };
    },
  },
  {
    id: 'test-fail', category: 'pdf', label: 'Test Failure', hint: 'Scenario tool that always fails',
    accepts: ['.pdf', '.tst'], multi: 'each', options: [],
    async run(inputs, options, ctx) {
      ctx.onProgress(0.2, 'Opening');
      await sleep(100);
      const err = new Error('This PDF is protected with a password, so it cannot be changed.\n    at fakeStack (C:\\secret\\internal.js:1:1)');
      throw err;
    },
  },
  {
    id: 'test-text', category: 'transcript', label: 'Test Transcript', hint: 'Scenario tool that returns text',
    accepts: ['.wav', '.mp4', '.tst'], multi: 'each', options: [],
    async run(inputs, options, ctx) {
      ctx.onProgress(0.5, 'Listening');
      await sleep(150);
      const text = 'Hi, this is Mehul from Aura Key. Today we are looking at three homes in Brampton, and the numbers might surprise you.';
      const out = writeOut(inputs, ctx, ' (transcript)', '.txt', text);
      return { outputs: [out], message: 'Transcript ready', text };
    },
  },
  {
    id: 'test-merge', category: 'pdf', label: 'Test Merge', hint: 'Scenario tool that combines files',
    accepts: ['.pdf'], multi: 'combine', options: [{ key: 'name', label: 'File name', type: 'text', default: 'Merged' }],
    async run(inputs, options, ctx) {
      ctx.onProgress(0.5, `Combining ${inputs.length}`);
      await sleep(100);
      return { outputs: [writeOut(inputs, ctx, ' merged', '.pdf', inputs.join('\n'))], message: `${inputs.length} files combined` };
    },
  },
  {
    id: 'test-doc', category: 'word', label: 'Test Doc to PDF', hint: 'Scenario tool for documents',
    accepts: ['.docx'], multi: 'each',
    options: [{ key: 'keep', label: 'Keep layout', type: 'toggle', default: true }],
    async run(inputs, options, ctx) { return { outputs: [writeOut(inputs, ctx, '', '.pdf')], message: 'Done' }; },
  },
  {
    id: 'test-image', category: 'image', label: 'Test Image', hint: 'Scenario tool for pictures',
    accepts: ['.png'], multi: 'each', options: [],
    async run(inputs, options, ctx) { return { outputs: [writeOut(inputs, ctx, ' small', '.png')], message: 'Done' }; },
  },
];

// ------------------------------------------------------------------ scenario (main side)
async function run(h) {
  const { BrowserWindow, clipboard, globalShortcut } = require('electron');
  const { spawn } = require('child_process');
  const mode = process.env.SONIKA_SCENARIO_MODE || 'full';
  const results = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonika-scenario-'));
  fs.mkdirSync(SCREENS, { recursive: true });

  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
    return !!ok;
  };
  const soft = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'WARN'}  ${name}${detail ? '  -- ' + detail : ''}`); };
  const waitFor = async (fn, ms, step) => {
    const end = Date.now() + (ms || 5000);
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v; } catch (_) { /* retry */ }
      await sleep(step || 50);
    }
    return null;
  };
  const W = () => h.mainWindow;
  const exec = (js, win) => (win || W()).webContents.executeJavaScript(js, true);
  const shot = async (win, name) => {
    await sleep(60);
    const img = await win.webContents.capturePage();
    const file = path.join(SCREENS, name);
    fs.writeFileSync(file, img.toPNG());
    return file;
  };
  const key = async (win, keyCode, modifiers) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: modifiers || [] });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers: modifiers || [] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: modifiers || [] });
    await sleep(40);
  };
  const mouse = async (win, x, y) => { win.webContents.sendInputEvent({ type: 'mouseMove', x, y }); await sleep(40); };
  const click = async (win, x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(80);
  };
  const mkfile = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body || 'x'); return p; };
  const jobById = (id) => h.queue.list().find((j) => j.id === id);
  const waitJob = (id, statuses, ms) => waitFor(() => { const j = jobById(id); return j && statuses.includes(j.status) ? j : null; }, ms || 8000);
  const appState = () => exec('({view: SonikaApp.S.view, tool: SonikaApp.S.tool && SonikaApp.S.tool.id, files: SonikaApp.S.files.slice(), held: SonikaApp.S.held.slice(), index: SonikaApp.wheel.index, lit: SonikaApp.wheel.lit ? [...SonikaApp.wheel.lit] : null, hubTool: document.querySelector(".hub-tool").textContent, settingsOpen: SonikaApp.S.settingsOpen})');
  const layoutProblems = () => exec(`(() => {
    const p = [];
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth + 1) p.push('page wider than window');
    if (de.scrollHeight > innerHeight + 1) p.push('page taller than window');
    for (const sel of ['.stage-foot', '.queue-head', '.titlebar', '.sheet-foot', '.settings-head']) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && el.scrollWidth > el.clientWidth + 1) p.push(sel + ' overflows');
    }
    const hub = document.querySelector('.hub-tool');
    if (hub && hub.scrollHeight > hub.clientHeight + 2) p.push('hub tool name clipped');
    const wheel = document.querySelector('.wheel-host').getBoundingClientRect();
    const sv = document.querySelector('.wheel-svg').getBoundingClientRect();
    if (sv.left < wheel.left - 20 || sv.right > wheel.right + 20 || sv.top < wheel.top - 20 || sv.bottom > wheel.bottom + 20) p.push('wheel larger than its area');
    return p;
  })()`);

  const finish = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`SUMMARY ${results.length - failed} passed, ${failed} failed (${mode})`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    return failed ? 1 : 0;
  };

  // ---- start
  h.showMain();
  W().setSize(1100, 760);
  W().center();
  await waitFor(() => exec('document.body.dataset.ready === "1"'), 8000);
  await sleep(300);
  const reg = h.registry;

  if (mode === 'scale') {
    check('scaled window loads the wheel', await exec('document.querySelectorAll(".seg").length === 6'));
    await shot(W(), '13-scale150-default.png');
    W().setSize(900, 640);
    await sleep(400);
    const probs = await layoutProblems();
    check('150% scaling at minimum size: nothing cut off', probs.length === 0, probs.join('; '));
    await shot(W(), '14-scale150-min-size.png');
    return finish();
  }

  // ---- registry and wheel
  const realTools = reg.tools.filter((t) => !t.id.startsWith('test-'));
  console.log(`INFO  registry: ${reg.tools.length} tools (${realTools.length} real), load errors: ${JSON.stringify(reg.loadErrors)}`);
  check('six wheel slots in registry order', JSON.stringify(await exec('[...document.querySelectorAll(".seg")].map(s => s.dataset.cat)')) === JSON.stringify(reg.categories.map((c) => c.id)));
  check('settings start in a throwaway folder', h.app.getPath('userData').startsWith(path.resolve(process.env.SONIKA_USERDATA)));
  check('Start with Windows is off by default', h.settings.get().startWithWindows === false && h.loginItemWrites.length === 0);
  check('Close hides to tray is on by default', h.settings.get().closeToTray === true);
  check('Instant mode is on by default', h.settings.get().instantMode === true);
  await shot(W(), '01-wheel-idle.png');

  // Every tool reachable: number key to the slot, then cycle with the Right arrow.
  let allReachable = true;
  const missing = [];
  for (let i = 0; i < reg.categories.length; i += 1) {
    const cat = reg.categories[i];
    const expected = reg.tools.filter((t) => t.category === cat.id).map((t) => t.label).sort();
    await exec('SonikaApp.wheel.host.focus()');
    await key(W(), String(i + 1));
    const st = await appState();
    if (st.index !== i) { allReachable = false; missing.push(`key ${i + 1} did not select ${cat.id}`); continue; }
    const seen = new Set();
    for (let k = 0; k < Math.max(1, expected.length) + 1; k += 1) {
      seen.add((await appState()).hubTool);
      await key(W(), 'Right');
    }
    for (const label of expected) if (!seen.has(label)) { allReachable = false; missing.push(`${cat.id}: ${label}`); }
  }
  check('number keys 1-6 jump to slots and every registry tool is reachable by cycling', allReachable, missing.join('; '));

  // Angle selection with the real mouse.
  let angleOk = true;
  const angleLog = [];
  for (let i = 0; i < 6; i += 1) {
    const p = await exec(`SonikaApp.segmentPoint(${i}, 230)`);
    await mouse(W(), p.x, p.y);
    const got = await waitFor(async () => (await appState()).index === i, 600);
    if (!got) { angleOk = false; angleLog.push(`slot ${i + 1} -> ${(await appState()).index + 1}`); }
  }
  check('moving the mouse over each slot highlights it', angleOk, angleLog.join(', '));
  const far = await exec('(() => { const c = SonikaApp.wheel.center(); return { x: Math.round(c.x + 20), y: 70 }; })()');
  await mouse(W(), far.x, far.y);
  check('selection follows the angle even outside the ring', await waitFor(async () => (await appState()).index === 0, 600));
  const before = await appState();
  const pv = await exec('SonikaApp.segmentPoint(4, 230)');
  await mouse(W(), pv.x, pv.y);
  const vBefore = (await appState()).hubTool;
  W().webContents.sendInputEvent({ type: 'mouseWheel', x: pv.x, y: pv.y, deltaX: 0, deltaY: -120, wheelTicksY: -1, canScroll: true });
  await sleep(200);
  const vAfter = (await appState()).hubTool;
  const videoCount = reg.tools.filter((t) => t.category === 'video').length;
  check('mouse wheel cycles tools inside the highlighted slot', videoCount < 2 || vAfter !== vBefore, `${vBefore} -> ${vAfter}`);
  void before;
  // Highlight AUDIO for the screenshot, preferring the real default tool.
  const pa = await exec('SonikaApp.segmentPoint(0, 230)');
  await mouse(W(), pa.x, pa.y);
  await exec(`(() => { const w = SonikaApp.wheel; const list = w.toolsIn('audio'); const i = list.findIndex(t => t.id === 'video-to-audio'); if (i >= 0) { w.toolIdx.audio = i; w.update(false); } })()`);
  await sleep(220);
  await shot(W(), '02-segment-highlighted.png');

  // ---- Flow A: click picks -> options sheet
  await exec(`(() => { const w = SonikaApp.wheel; const list = w.toolsIn('audio'); w.toolIdx.audio = list.findIndex(t => t.id === 'test-ok'); w.update(false); })()`);
  await click(W(), pa.x, pa.y);
  let st = await waitFor(async () => { const s = await appState(); return s.view === 'options' ? s : null; }, 2000);
  check('clicking a slot opens the options panel for its tool', st && st.tool === 'test-ok', st && st.tool);
  const ctl = await exec('({ seg: document.querySelectorAll(".seg-ctl button").length, num: document.querySelectorAll("input[type=number]").length, start: document.querySelector("[data-act=start]").disabled, chips: document.querySelectorAll(".tool-switch .chip").length })');
  check('options panel is built from the registry (choice + number, Start disabled with no files)', ctl.seg === 2 && ctl.num === 1 && ctl.start === true, JSON.stringify(ctl));
  const vid1 = mkfile('Listing walkthrough.mp4');
  const vid2 = mkfile('Drone pass 02.mov');
  await exec(`SonikaApp.addFilesToSheet(${JSON.stringify([vid1, vid2, mkfile('notes.xyz')])})`);
  await exec('document.querySelector(".seg-ctl button[data-val=\'\\"wav\\"\']").click()');
  await sleep(400);
  check('changed option is remembered per tool', (h.settings.get().toolOptions['test-ok'] || {}).format === 'wav');
  const savedFile = JSON.parse(fs.readFileSync(path.join(h.app.getPath('userData'), 'settings.json'), 'utf8'));
  check('remembered option is written to settings.json', (savedFile.toolOptions['test-ok'] || {}).format === 'wav');
  check('wrong file types are refused by the panel', (await appState()).files.length === 2);
  // Show a real tool's options for the screenshot when the engine has it.
  const realAudio = reg.tools.find((t) => t.id === 'video-to-audio');
  if (realAudio) {
    await exec(`SonikaApp.openOptions(SonikaApp.S.tools.find(t => t.id === 'video-to-audio'), ${JSON.stringify([vid1, vid2])})`);
    await sleep(250);
    await shot(W(), '03-options-panel.png');
    await exec(`SonikaApp.openOptions(SonikaApp.S.tools.find(t => t.id === 'test-ok'), ${JSON.stringify([vid1, vid2])})`);
  } else {
    await sleep(250);
    await shot(W(), '03-options-panel.png');
  }
  const startRes = await exec('SonikaApp.startFromSheet()');
  check('Start creates one job per file for an "each" tool', startRes && startRes.ok && startRes.jobIds.length === 2, JSON.stringify(startRes && startRes.jobIds));
  const done1 = await Promise.all(startRes.jobIds.map((id) => waitJob(id, ['done', 'error'])));
  check('fake success jobs finish with output files', done1.every((j) => j && j.status === 'done' && fs.existsSync(j.outputs[0]) && j.outputs[0].endsWith('.wav')), done1.map((j) => j && j.outputs[0]).join(', '));
  check('the panel closes and the wheel returns after Start', (await appState()).view === 'wheel');
  await waitFor(() => exec(`document.querySelectorAll('.job.done').length >= 2`), 3000);
  check('done jobs show Show in folder and Open', await exec(`(() => { const j = document.querySelector('.job.done'); return !!(j && j.querySelector('[data-job=show]') && j.querySelector('[data-job=open]')); })()`));

  // ---- progress + cancel
  const slowA = h.startJobs({ toolId: 'test-slow', files: [mkfile('Long interview.mp4')], source: 'app' });
  const slowB = h.startJobs({ toolId: 'test-slow', files: [mkfile('B-roll set.mp4')], source: 'app' });
  const slowC = h.startJobs({ toolId: 'test-slow', files: [mkfile('Third clip.mp4')], source: 'app' });
  await waitFor(() => { const j = jobById(slowA.jobIds[0]); return j && j.progress > 0.15; }, 5000);
  const runningNow = h.queue.list().filter((j) => j.status === 'running').length;
  check('queue runs at most two jobs at once', runningNow === 2 && jobById(slowC.jobIds[0]).status === 'queued', `${runningNow} running`);
  const barW = await exec(`(() => { const el = document.querySelector('.job[data-id="${slowA.jobIds[0]}"] .job-bar i'); return el ? parseFloat(el.style.width) : -1; })()`);
  check('live progress bar moves in the jobs list', barW > 0, `${barW}%`);
  await shot(W(), '04-jobs-running.png');
  await exec(`document.querySelector('.job[data-id="${slowA.jobIds[0]}"] [data-job=cancel]').click()`);
  const cancelled = await waitJob(slowA.jobIds[0], ['cancelled', 'done', 'error'], 4000);
  check('Cancel stops a running job', cancelled && cancelled.status === 'cancelled', cancelled && cancelled.status);
  h.queue.cancel(slowB.jobIds[0]);
  h.queue.cancel(slowC.jobIds[0]);
  const qc = await waitJob(slowC.jobIds[0], ['cancelled'], 4000);
  check('a waiting job can be cancelled too', !!qc);
  await waitJob(slowB.jobIds[0], ['cancelled', 'done', 'error'], 4000);

  // ---- failure
  const failRes = h.startJobs({ toolId: 'test-fail', files: [mkfile('Locked contract.pdf')], source: 'app' });
  const failed = await waitJob(failRes.jobIds[0], ['error', 'done'], 4000);
  check('a failing tool ends in a plain error', failed && failed.status === 'error' && /password/.test(failed.error));
  await waitFor(() => exec(`!!document.querySelector('.job[data-id="${failRes.jobIds[0]}"] .job-error')`), 2000);
  const errText = await exec(`document.querySelector('.job[data-id="${failRes.jobIds[0]}"] .job-error').textContent`);
  const errColor = await exec(`getComputedStyle(document.querySelector('.job[data-id="${failRes.jobIds[0]}"] .job-error')).color`);
  check('error text is shown in red without a stack trace', !/\bat\s+\S+\s*\(/.test(errText) && !/internal\.js/.test(errText) && /248, 113, 113/.test(errColor), errText);
  await shot(W(), '06-job-error.png');

  // ---- transcript text + copy
  const textRes = h.startJobs({ toolId: 'test-text', files: [mkfile('Voice memo.wav')], source: 'app' });
  await waitJob(textRes.jobIds[0], ['done', 'error'], 4000);
  await waitFor(() => exec(`!!document.querySelector('.job[data-id="${textRes.jobIds[0]}"] .transcript')`), 2000);
  const oldClip = await clipboard.readText();
  await exec(`document.querySelector('.job[data-id="${textRes.jobIds[0]}"] [data-job=copy]').click()`);
  await sleep(200);
  const copied = await clipboard.readText();
  if (typeof oldClip === 'string' && oldClip.length) clipboard.writeText(oldClip); else clipboard.clear();
  check('transcript text is shown with a working Copy text button', /Aura Key/.test(copied));
  await shot(W(), '05-jobs-done.png');

  // ---- Flow B: files first
  const pdf1 = mkfile('Offer page 1.pdf');
  const pdf2 = mkfile('Offer page 2.pdf');
  let fb = await exec(`SonikaApp.handleFiles(${JSON.stringify([vid1, pdf1])}, {})`);
  st = await appState();
  const expectLit = [...new Set(reg.tools.filter((t) => t.accepts.includes('.mp4') || t.accepts.includes('.pdf')).map((t) => t.category))].sort();
  check('dropped files light only the slots that can use them', fb.action === 'held' && JSON.stringify((st.lit || []).sort()) === JSON.stringify(expectLit), JSON.stringify(st.lit));
  const dimCat = reg.categories.findIndex((c) => !expectLit.includes(c.id));
  if (dimCat >= 0) {
    const pd = await exec(`SonikaApp.segmentPoint(${dimCat}, 230)`);
    await mouse(W(), pd.x, pd.y);
    await sleep(160);
    check('a dim slot says it is not for these files', /Not for these files/.test((await appState()).hubTool));
  }
  const lp = await exec(`SonikaApp.segmentPoint(${reg.categories.findIndex((c) => c.id === 'pdf')}, 230)`);
  await mouse(W(), lp.x, lp.y);
  await sleep(200);
  await shot(W(), '07-flowb-files-held.png');
  fb = await exec(`SonikaApp.dropAt(${JSON.stringify([pdf1, pdf2])}, ${lp.x}, ${lp.y})`);
  st = await appState();
  check('dropping on a slot opens that slot\'s tool with the files', st.view === 'options' && st.files.length === 2 && reg.tools.find((t) => t.id === st.tool).category === 'pdf', `${fb.action} ${st.tool}`);
  await exec('SonikaApp.closeSheet()');
  await exec('SonikaApp.clearHeld()');
  fb = await exec(`SonikaApp.handleFiles(${JSON.stringify([mkfile('Floor plan.docx')])}, {})`);
  const docTools = reg.tools.filter((t) => t.accepts.includes('.docx'));
  check('when only one tool fits, the options panel opens straight away', docTools.length !== 1 || (fb.action === 'options' && fb.tool === docTools[0].id), JSON.stringify(fb));
  await exec('SonikaApp.closeSheet()');
  fb = await exec(`SonikaApp.handleFiles(${JSON.stringify([mkfile('weird.xyz')])}, {})`);
  check('unsupported files get a plain message', fb.action === 'unsupported' && /cannot work with/.test(await exec('document.getElementById("notice").textContent')));
  // Instant mode: a video dropped straight on AUDIO starts at once.
  await exec(`SonikaApp.S.settings.lastTool = Object.assign({}, SonikaApp.S.settings.lastTool, { audio: 'test-ok' })`);
  const before2 = h.queue.list().length;
  const ap = await exec('SonikaApp.segmentPoint(0, 230)');
  fb = await exec(`SonikaApp.dropAt(${JSON.stringify([mkfile('Quick export.mp4')])}, ${ap.x}, ${ap.y})`);
  await sleep(150);
  check('Instant mode: video dropped on AUDIO starts with saved options', fb.action === 'instant' && h.queue.list().length === before2 + 1 && h.queue.list().slice(-1)[0].options.format === 'wav', JSON.stringify(fb));
  await exec('SonikaApp.updateSetting({ instantMode: false })');
  fb = await exec(`SonikaApp.dropAt(${JSON.stringify([mkfile('Quick export 2.mp4')])}, ${ap.x}, ${ap.y})`);
  check('with Instant mode off the same drop opens the options panel', fb.action === 'options');
  await exec('SonikaApp.closeSheet()');
  await exec('SonikaApp.updateSetting({ instantMode: true })');
  // Combine tool keeps one job for all files.
  const mergeRes = h.startJobs({ toolId: 'test-merge', files: [pdf1, pdf2], source: 'app' });
  const merged = await waitJob(mergeRes.jobIds[0], ['done', 'error'], 4000);
  check('a "combine" tool runs once for all files', mergeRes.jobIds.length === 1 && merged && merged.status === 'done');

  // ---- settings
  await exec('SonikaApp.openSettings()');
  await sleep(450);
  await shot(W(), '08-settings.png');
  await exec('document.querySelector("[data-switch=closeToTray]").click()');
  await sleep(250);
  check('settings toggles save immediately', h.settings.get().closeToTray === false);
  await exec('document.querySelector("[data-switch=closeToTray]").click()');
  await sleep(250);
  const { Settings } = require(path.join(ROOT, 'src', 'main', 'settings.js'));
  const reread = new Settings(h.app.getPath('userData')).get();
  check('settings persist on disk (fresh read)', reread.closeToTray === true && reread.instantMode === true && reread.toolOptions['test-ok'].format === 'wav');
  const det = h.detectTools();
  const shown = await exec('({ handy: document.querySelector("[data-tool-status=handy]").className, ffmpeg: document.querySelector("[data-tool-status=ffmpeg]").className })');
  check('Handy and FFmpeg status match auto-detection', shown.handy.includes(det.handy.ok ? 'ok' : 'bad') && shown.ffmpeg.includes(det.ffmpeg.ok ? 'ok' : 'bad'), `handy ${det.handy.ok}, ffmpeg ${det.ffmpeg.ok}`);
  await exec('SonikaApp.closeSettings()');
  check('Start with Windows was never written during the test', h.loginItemWrites.length === 0);

  // ---- hotkey
  check('a global wheel shortcut is active at start (default, or a free fallback)', h.hotkeyState.ok && globalShortcut.isRegistered(h.hotkeyState.accelerator), `${h.hotkeyState.accelerator}${h.hotkeyState.message ? ' -- ' + h.hotkeyState.message : ''}`);
  const original = h.hotkeyState.accelerator;
  const startHk = { ...h.hotkeyState };
  const ch = h.changeHotkey('Ctrl+Alt+Shift+F11');
  check('the hotkey can be changed', ch.ok && globalShortcut.isRegistered('Ctrl+Alt+Shift+F11') && h.settings.get().hotkey === 'Ctrl+Alt+Shift+F11', ch.message);
  const back = h.changeHotkey(original);
  check('the hotkey can be changed back', back.ok && globalShortcut.isRegistered(original), back.message);
  const bad = h.changeHotkey('NotAKey+Q');
  check('an invalid shortcut is refused with a clear message', !bad.ok && /cannot be used/.test(bad.message) && h.hotkeyState.accelerator === original, bad.message);
  if (startHk.fallback || /used by another app/.test(startHk.message || '')) {
    const busy = h.changeHotkey('Ctrl+Alt+Space');
    check('a shortcut taken by another app shows a clear message and keeps the old one', !busy.ok && /already used/.test(busy.message) && h.hotkeyState.ok && h.hotkeyState.accelerator === original, busy.message);
  } else {
    soft('busy-shortcut message', true, 'Ctrl+Alt+Space is free on this PC, so the busy case could not be exercised');
  }
  await exec('SonikaApp.openSettings()');
  await sleep(300);
  check('the settings panel shows the active shortcut', (await exec('document.getElementById("hotkey-box").textContent.replace(/\\s/g, "")')) === original.replace(/\s/g, ''));
  await exec('SonikaApp.closeSettings()');

  // ---- overlay
  const ov = h.overlayWindow;
  h.showOverlay();
  await waitFor(() => ov.isVisible() && h.overlayLatencyMs >= 0, 2000, 5);
  const latency = h.overlayLatencyMs;
  check('overlay shows on hotkey in well under 200 ms', ov.isVisible() && latency >= 0 && latency < 200, `${latency.toFixed(1)} ms`);
  const ovBounds = ov.getBounds();
  const { screen } = require('electron');
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  check('overlay covers the display under the mouse', ovBounds.x === disp.x && ovBounds.y === disp.y && ovBounds.width === disp.width);
  await sleep(250);
  const ovp = await exec('(() => { const w = SonikaOverlay.wheel; const c = w.center(); const a = -90 * Math.PI / 180; const r = 230 * w.scale; return { x: Math.round(c.x + r * Math.cos(a) + 0), y: Math.round(c.y + r * Math.sin(a)) }; })()', ov);
  await mouse(ov, ovp.x, ovp.y);
  await exec(`(() => { const w = SonikaOverlay.wheel; const list = w.toolsIn('audio'); const i = list.findIndex(t => t.id === 'video-to-audio'); if (i >= 0) { w.toolIdx.audio = i; w.update(false); } })()`, ov);
  await sleep(200);
  await shot(ov, '09-overlay.png');
  await key(ov, 'Escape');
  await waitFor(() => !ov.isVisible(), 1500);
  check('Esc hides the overlay', !ov.isVisible());
  h.showOverlay();
  await waitFor(() => ov.isVisible(), 1500);
  await sleep(200);
  await click(ov, 12, 12);
  await waitFor(() => !ov.isVisible(), 1500);
  check('clicking outside the wheel hides the overlay', !ov.isVisible());
  // Pick from the overlay: the file dialog is replaced by a hook that supplies a test file.
  const overlayFile = mkfile('From hotkey.mp4');
  let picked = null;
  h.setOverlayPickHook((tool) => { picked = tool.id; return h.startJobs({ toolId: tool.id, files: [overlayFile], source: 'overlay' }); });
  h.showOverlay();
  await waitFor(() => ov.isVisible(), 1500);
  await sleep(180);
  await exec(`(() => { const w = SonikaOverlay.wheel; w.select(0); const list = w.toolsIn('audio'); w.toolIdx.audio = list.findIndex(t => t.id === 'test-ok'); w.update(false); })()`, ov);
  await key(ov, 'Return');
  await waitFor(() => picked, 2000);
  const ovJob = await waitFor(() => h.queue.list().find((j) => j.source === 'overlay'), 2000);
  check('choosing a tool in the overlay runs it with saved options', picked === 'test-ok' && ovJob && ovJob.options.format === 'wav' && !ov.isVisible());
  await waitFor(() => h.toastWindow.isVisible(), 2000);
  check('a progress toast appears for overlay jobs', h.toastWindow.isVisible());
  await waitJob(ovJob.id, ['done', 'error'], 4000);
  await sleep(300);
  await shot(h.toastWindow, '10-toast.png');
  check('the overlay job also appears in the main window queue', await exec(`!!document.querySelector('.job[data-id="${ovJob.id}"]')`));
  h.setOverlayPickHook(null);

  // ---- notification when not focused
  W().blur();
  BrowserWindow.getAllWindows().forEach((w) => w.blur());
  const nRes = h.startJobs({ toolId: 'test-ok', files: [mkfile('Background job.mp4')], source: 'app' });
  await waitJob(nRes.jobIds[0], ['done', 'error'], 4000);
  await sleep(200);
  soft('Windows notification raised when the batch finished unfocused', h.lastNotification && /finished/.test(h.lastNotification.title), JSON.stringify(h.lastNotification));

  // ---- command line + second instance
  const parsed = h.cli.parseArgs(['--tool', 'video-to-audio', 'a.mp4', '--some-chromium-flag', 'b.mov'], 'C:\\work');
  check('command line parsing (--tool + files, flags ignored)', parsed.tool === 'video-to-audio' && parsed.files.length === 2 && parsed.files[0] === path.resolve('C:\\work', 'a.mp4'));
  const flushed = [];
  const { BatchCollector } = require(path.join(ROOT, 'src', 'main', 'cli.js'));
  const col = new BatchCollector((b) => flushed.push(b), 120);
  col.add({ tool: 'x', files: ['1'] }); await sleep(40); col.add({ tool: 'x', files: ['2'] }); col.add({ tool: null, files: ['3'] });
  await sleep(260);
  check('forwarded files arriving close together form one batch per tool', flushed.length === 2 && flushed.find((b) => b.tool === 'x').files.length === 2);
  // Real second instances: Explorer starts one process per selected file.
  const fwd1 = mkfile('Explorer pick 1.mp4');
  const fwd2 = mkfile('Explorer pick 2.mp4');
  const fwd3 = mkfile('Explorer open.pdf');
  const env = { ...process.env };
  delete env.SONIKA_SCENARIO; delete env.SONIKA_SCENARIO_MODE; delete env.ELECTRON_RUN_AS_NODE;
  const launch = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [...(h.app.isPackaged ? [] : [ROOT]), ...args], { env, stdio: 'ignore', windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } resolve(-1); }, 15000);
    p.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  const beforeCli = h.queue.list().length;
  const codes = await Promise.all([launch(['--tool', 'test-ok', '--opt', 'format=mp3', fwd1]), launch(['--tool', 'test-ok', '--opt', 'format=mp3', fwd2])]);
  const cliJobs = await waitFor(() => { const js = h.queue.list().slice(beforeCli).filter((j) => j.source === 'cli'); return js.length >= 2 ? js : null; }, 6000);
  check('second launches exit and forward their files to the running app', codes.every((c) => c === 0) && !!cliJobs, `exit codes ${codes.join(',')}`);
  check('two Explorer launches become one batch', cliJobs && cliJobs.length === 2 && cliJobs[0].batchId === cliJobs[1].batchId);
  check('--opt overrides an option for that run only (saved options untouched)', cliJobs && cliJobs.every((j) => j.options.format === 'mp3') && h.settings.get().toolOptions['test-ok'].format === 'wav');
  await launch([fwd3]);
  const heldNow = await waitFor(async () => { const s = await appState(); return (s.held.includes(fwd3) || s.files.includes(fwd3)) ? s : null; }, 5000);
  check('a launch with only files opens the main window with them loaded', !!heldNow && W().isVisible());
  await exec('SonikaApp.closeSheet && SonikaApp.S.view === "options" && SonikaApp.closeSheet()');
  await exec('SonikaApp.clearHeld()');

  // ---- real engine end to end (only when the media module has arrived)
  if (reg.tools.find((t) => t.id === 'video-to-audio')) {
    let ffmpeg = null;
    try { ffmpeg = util.findFfmpeg({}); } catch (_) { /* none */ }
    if (ffmpeg) {
      const vid = path.join(tmp, 'Real test clip.mp4');
      await util.runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', vid]);
      await exec(`SonikaApp.S.settings.toolOptions = Object.assign({}, SonikaApp.S.settings.toolOptions); delete SonikaApp.S.settings.toolOptions['video-to-audio']`);
      await exec(`SonikaApp.openOptions(SonikaApp.S.tools.find(t => t.id === 'video-to-audio'), ${JSON.stringify([vid])})`);
      const r = await exec('SonikaApp.startFromSheet()');
      const j = r && r.ok ? await waitJob(r.jobIds[0], ['done', 'error'], 60000) : null;
      const out = j && j.outputs && j.outputs[0];
      check('REAL: video-to-audio through the UI produces an MP3', j && j.status === 'done' && out && out.toLowerCase().endsWith('.mp3') && fs.statSync(out).size > 1000, j ? `${j.status} ${out || j.error}` : 'no job');
    } else soft('REAL: video-to-audio end to end', false, 'ffmpeg not found');
  } else {
    soft('REAL: video-to-audio end to end', false, 'media module not loaded yet: ' + JSON.stringify(reg.loadErrors.find((e) => e.module === 'media') || {}));
  }

  // ---- minimum window size
  W().setSize(900, 640);
  await sleep(450);
  let probs = await layoutProblems();
  check('minimum window size (900x640): nothing cut off or overflowing', probs.length === 0, probs.join('; '));
  await shot(W(), '11-min-size.png');
  await exec(`SonikaApp.openOptions(SonikaApp.S.tools.find(t => t.id === '${realAudio ? 'video-to-audio' : 'test-ok'}'), ${JSON.stringify([vid1, vid2])})`);
  await sleep(300);
  probs = await layoutProblems();
  const sheetFits = await exec('(() => { const s = document.querySelector(".sheet").getBoundingClientRect(); return s.bottom <= innerHeight && s.right <= innerWidth - 300; })()');
  check('options panel fits at minimum size', probs.length === 0 && sheetFits, probs.join('; '));
  await shot(W(), '12-min-size-options.png');
  await exec('SonikaApp.closeSheet()');
  W().setSize(1100, 760);

  // ---- close button hides to tray
  W().close();
  await sleep(300);
  check('the close button hides the window to the tray', !W().isDestroyed() && !W().isVisible() && !!h.tray);

  return finish();
}

module.exports = { fakeTools, run };
