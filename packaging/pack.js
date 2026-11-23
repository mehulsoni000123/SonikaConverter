'use strict';
// Builds dist\Sonika Converter-win32-x64 with @electron/packager.
//   node packaging/pack.js        (or npm.cmd run pack)
// asar is OFF because the engine runs helper scripts by path. Dev dependencies are pruned;
// mupdf, pdf-lib and sharp (with its native @img/sharp-win32-x64 binary) are kept.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
const APP_NAME = 'Sonika Converter';

/** Use the Electron zip already in the local cache so packing works offline. */
function cachedElectronZipDir() {
  const zip = `electron-v${electronVersion}-win32-x64.zip`;
  const roots = [
    process.env.electron_config_cache,
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache'),
  ].filter(Boolean);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (fs.existsSync(path.join(root, zip))) return root;
    for (const sub of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, sub, zip))) return path.join(root, sub);
    }
  }
  return null;
}

// Paths (relative to the project, forward slashes) that never go into the package.
const IGNORE = [
  /^\/dist($|\/)/,
  /^\/test($|\/)/,
  /^\/packaging($|\/)/,
  /^\/\.git($|\/)/,
  /^\/\.claude($|\/)/,
  /^\/\.vscode($|\/)/,
  /^\/assets\/build-icon\.js$/,
  /^\/assets\/png\/preview-sheet/,
  /^\/README\.md$/,
  /\.env$/,
  /(^|\/)\.DS_Store$/,
  /^\/node_modules\/\.cache($|\/)/,
];

function checkOutput(appDir) {
  const res = path.join(appDir, 'resources', 'app');
  const must = [
    path.join(appDir, `${APP_NAME}.exe`),
    path.join(res, 'package.json'),
    path.join(res, 'src', 'main', 'main.js'),
    path.join(res, 'src', 'engine', 'index.js'),
    path.join(res, 'src', 'renderer', 'index.html'),
    path.join(res, 'assets', 'icon.ico'),
    path.join(res, 'node_modules', 'sharp', 'package.json'),
    path.join(res, 'node_modules', 'pdf-lib', 'package.json'),
    path.join(res, 'node_modules', 'mupdf', 'package.json'),
  ];
  const missing = must.filter((p) => !fs.existsSync(p));
  const sharpNative = path.join(res, 'node_modules', '@img', 'sharp-win32-x64');
  if (!fs.existsSync(sharpNative)) missing.push(sharpNative + ' (sharp native binary)');
  const devLeft = ['electron', '@electron/packager'].filter((d) => fs.existsSync(path.join(res, 'node_modules', d)));
  return { missing, devLeft, asar: fs.existsSync(path.join(appDir, 'resources', 'app.asar')) };
}

/**
 * Explorer right-click entries, generated from the engine registry so they always match the real tools.
 * install.ps1 reads <app>\context-menu.json; each verb is registered per extension under
 * HKCU\Software\Classes\SystemFileAssociations\<ext>\shell\SonikaConverter\shell\<key>.
 */
function writeContextMenu(appDir) {
  let tools = [];
  try {
    tools = require(path.join(ROOT, 'src', 'engine', 'index.js')).describeTools();
  } catch (err) {
    console.log('WARNING: engine registry could not load for the Explorer menu: ' + err.message);
  }
  const byId = (id) => tools.find((t) => t.id === id);
  const verbs = [];
  const audioExts = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff']);
  const v2a = byId('video-to-audio');
  if (v2a) {
    verbs.push({ key: '10-audio', label: 'Extract audio (MP3)', args: '--tool video-to-audio --opt format=mp3-320', exts: v2a.accepts.filter((e) => !audioExts.has(e)) });
  }
  const tr = byId('transcribe');
  if (tr) verbs.push({ key: '20-transcript', label: 'Make transcript', args: '--tool transcribe', exts: tr.accepts.slice() });
  const w2p = byId('word-to-pdf');
  if (w2p) verbs.push({ key: '30-pdf', label: 'Convert to PDF', args: '--tool word-to-pdf', exts: w2p.accepts.filter((e) => e !== '.txt') });
  const o2p = byId('office-to-pdf');
  if (o2p) verbs.push({ key: '30-pdf', label: 'Convert to PDF', args: '--tool office-to-pdf', exts: o2p.accepts.slice() });
  const all = [...new Set(tools.flatMap((t) => t.accepts))].filter((e) => e !== '.txt').sort();
  verbs.push({ key: '90-open', label: 'Open in Sonika Converter', args: '', exts: all });
  const menu = { app: APP_NAME, keyName: 'SonikaConverter', generated: new Date().toISOString(), verbs };
  fs.writeFileSync(path.join(appDir, 'context-menu.json'), JSON.stringify(menu, null, 2));
  return menu;
}

function folderSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? folderSize(p) : fs.statSync(p).size;
  }
  return total;
}

(async () => {
  const zipDir = cachedElectronZipDir();
  console.log(`Packing ${APP_NAME} ${pkg.version} with Electron ${electronVersion}${zipDir ? ' (cached zip: ' + zipDir + ')' : ' (zip will be downloaded)'}`);
  const t0 = Date.now();
  const paths = await packager({
    dir: ROOT,
    out: OUT,
    name: APP_NAME,
    executableName: APP_NAME,
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    ...(zipDir ? { electronZipDir: zipDir } : {}),
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    asar: false,
    prune: true,
    overwrite: true,
    derefSymlinks: true,
    ignore: IGNORE,
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appCopyright: 'Copyright (c) Mehul',
    win32metadata: {
      CompanyName: 'Mehul',
      FileDescription: APP_NAME,
      ProductName: APP_NAME,
      InternalName: 'SonikaConverter',
      OriginalFilename: `${APP_NAME}.exe`,
      'requested-execution-level': 'asInvoker',
    },
  });
  const appDir = paths[0];
  // Trim: keep only the English UI locale (the interface is English) and drop empty scope folders left by pruning.
  const locales = path.join(appDir, 'locales');
  if (fs.existsSync(locales)) {
    for (const f of fs.readdirSync(locales)) if (!/^en-(US|GB)\.pak$/.test(f)) fs.rmSync(path.join(locales, f), { force: true });
  }
  const nm = path.join(appDir, 'resources', 'app', 'node_modules');
  for (const d of fs.existsSync(nm) ? fs.readdirSync(nm) : []) {
    const p = path.join(nm, d);
    if (d.startsWith('@') && fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0) fs.rmdirSync(p);
  }
  const menu = writeContextMenu(appDir);
  console.log(`Explorer menu: ${menu.verbs.map((v) => `${v.label} (${v.exts.length} types)`).join(', ')}`);
  const c = checkOutput(appDir);
  console.log(`Packed to ${appDir} in ${Math.round((Date.now() - t0) / 1000)} s, ${Math.round(folderSize(appDir) / 1048576)} MB`);
  if (c.asar) console.log('WARNING: app.asar exists although asar is off.');
  if (c.devLeft.length) console.log('WARNING: dev dependencies were not pruned: ' + c.devLeft.join(', '));
  if (c.missing.length) {
    console.log('MISSING in package:\n  ' + c.missing.join('\n  '));
    process.exit(1);
  }
  console.log('Package check: exe, app files, icon, mupdf, pdf-lib and sharp (native) all present; asar off.');
})().catch((err) => {
  console.error('Packing failed: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
