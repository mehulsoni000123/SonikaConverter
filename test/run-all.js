'use strict';
// Runs every test/*.test.js with plain Node, then the interface scenario under Electron
// (normal scale, then a 150 percent display-scaling pass). Prints a pass/fail summary.
//   node test/run-all.js            (or npm.cmd test)
//   node test/run-all.js --ui-only  (skip the *.test.js files)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const uiOnly = process.argv.includes('--ui-only');
const summary = [];

function runNodeTests() {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  if (!files.length) { console.log('(no *.test.js files yet)'); return; }
  for (const f of files) {
    console.log(`\n=== node ${f}`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 10 * 60 * 1000 });
    summary.push({ name: f, ok: r.status === 0, ms: Date.now() - t0, detail: r.status === null ? 'timed out' : `exit ${r.status}` });
  }
}

function runScenario(label, extraEnv) {
  return new Promise((resolve) => {
    let electronPath;
    try { electronPath = require(path.join(ROOT, 'node_modules', 'electron')); } catch (err) {
      summary.push({ name: label, ok: false, ms: 0, detail: 'Electron is not installed: ' + err.message });
      resolve(); return;
    }
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sonika-userdata-'));
    const env = { ...process.env, SONIKA_SCENARIO: path.join(__dirname, 'app.scenario.js'), SONIKA_USERDATA: userData, ...extraEnv };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log(`\n=== electron scenario: ${label}`);
    const t0 = Date.now();
    const child = spawn(electronPath, [ROOT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => {
      const s = String(d);
      // Chromium prints harmless GPU/cache noise on stderr; keep only our own lines.
      if (/SCENARIO|Error|error:/.test(s) && !/gpu|cache|disk_cache|Gpu|dxgi|angle/i.test(s)) process.stderr.write(s);
    });
    const timer = setTimeout(() => { child.kill(); }, 5 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const m = out.match(/SUMMARY (\d+) passed, (\d+) failed/);
      summary.push({ name: label, ok: code === 0, ms: Date.now() - t0, detail: m ? `${m[1]} passed, ${m[2]} failed` : `exit ${code}` });
      try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      resolve();
    });
  });
}

(async () => {
  if (!uiOnly) runNodeTests();
  await runScenario('app.scenario (100%)', {});
  await runScenario('app.scenario (150% scaling)', { SONIKA_SCENARIO_MODE: 'scale', SONIKA_SCALE: '1.5' });
  console.log('\n================ SUMMARY ================');
  for (const s of summary) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name.padEnd(34)} ${String(Math.round(s.ms / 1000)).padStart(4)} s  ${s.detail}`);
  const failed = summary.filter((s) => !s.ok).length;
  console.log(`${summary.length - failed} of ${summary.length} suites passed`);
  process.exit(failed ? 1 : 0);
})();
