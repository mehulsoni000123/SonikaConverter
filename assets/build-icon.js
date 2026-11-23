'use strict';
// Builds the Sonika Converter icon set from code.
//   node assets/build-icon.js
// Writes: assets/icon.svg (master, 256 grid), assets/icon-small.svg (simplified mark for 16-24 px),
//         assets/png/icon-<size>.png, assets/icon.ico (multi-size, PNG entries), assets/tray.png (+@1.5x, @2x),
//         assets/icon.png (256).
// Design: flat green rounded square, two opposing white arrows chasing each other around a circle
// (the universal "convert / cycle" mark) and, at larger sizes, a small sound-wave + page mark in the middle.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = __dirname;
const GREEN = '#16A34A';
const GREEN_DARK = '#15803D';
const WHITE = '#FFFFFF';
const MINT = '#DCFCE7';

const C = 128; // centre of the 256 grid

function pt(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}
const f = (n) => Number(n.toFixed(2));

/** One clockwise arc arrow: stroke from a0 to a1 (degrees, screen coords, clockwise) plus a triangular head at a1. */
function arcArrow(r, a0, a1, stroke, headLen, headWidth, color) {
  // End the stroke a little before the head so the round cap does not poke through.
  const headArcDeg = (headLen * 0.55 / r) * 180 / Math.PI;
  const strokeEnd = a1 - headArcDeg;
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, strokeEnd);
  const large = (strokeEnd - a0) > 180 ? 1 : 0;
  const arc = `<path d="M ${f(x0)} ${f(y0)} A ${r} ${r} 0 ${large} 1 ${f(x1)} ${f(y1)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"/>`;
  // Head: base centred on the arc at (a1 - headArc), tip along the tangent.
  const baseDeg = a1 - (headLen * 0.5 / r) * 180 / Math.PI;
  const [bx, by] = pt(r, baseDeg);
  const b = (baseDeg * Math.PI) / 180;
  const radial = [Math.cos(b), Math.sin(b)];
  const tangent = [-Math.sin(b), Math.cos(b)]; // clockwise direction in screen space
  const tip = [bx + tangent[0] * headLen, by + tangent[1] * headLen];
  const p1 = [bx + radial[0] * headWidth / 2, by + radial[1] * headWidth / 2];
  const p2 = [bx - radial[0] * headWidth / 2, by - radial[1] * headWidth / 2];
  const head = `<path d="M ${f(p1[0])} ${f(p1[1])} L ${f(tip[0])} ${f(tip[1])} L ${f(p2[0])} ${f(p2[1])} Z" fill="${color}" stroke="${color}" stroke-width="${Math.max(2, stroke * 0.18)}" stroke-linejoin="round"/>`;
  return arc + head;
}

function iconSvg({ small }) {
  const pad = small ? 0 : 10;
  const size = 256 - pad * 2;
  const rx = small ? 52 : 58;
  const r = small ? 72 : 80;
  const stroke = small ? 36 : 22;
  const headLen = small ? 58 : 40;
  const headWidth = small ? 92 : 60;
  let body = '';
  body += `<rect x="${pad}" y="${pad}" width="${size}" height="${size}" rx="${rx}" fill="${GREEN}"/>`;
  // Two arrows chasing each other: top arc goes left->right, bottom arc goes right->left.
  body += arcArrow(r, 192, 338, stroke, headLen, headWidth, WHITE);
  body += arcArrow(r, 12, 158, stroke, headLen, headWidth, WHITE);
  if (!small) {
    // Centre mark: a short sound wave (five rounded bars) - "media in, file out".
    const bars = [16, 34, 48, 34, 16];
    const gap = 13;
    const w = 8;
    const x0 = C - ((bars.length - 1) * gap) / 2;
    bars.forEach((h, i) => {
      const x = x0 + i * gap;
      body += `<line x1="${f(x)}" y1="${f(C - h / 2)}" x2="${f(x)}" y2="${f(C + h / 2)}" stroke="${MINT}" stroke-width="${w}" stroke-linecap="round"/>`;
    });
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">${body}</svg>\n`;
}

function buildIco(pngBuffers) {
  // ICO container with PNG-compressed entries (supported since Windows Vista).
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngBuffers.forEach(({ size, buf }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e);
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
    entries.writeUInt8(0, e + 2);
    entries.writeUInt8(0, e + 3);
    entries.writeUInt16LE(1, e + 4);
    entries.writeUInt16LE(32, e + 6);
    entries.writeUInt32LE(buf.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, entries, ...pngBuffers.map((p) => p.buf)]);
}

async function render(svg, size) {
  return sharp(Buffer.from(svg), { density: Math.max(72, (72 * size) / 256 * 4) })
    .resize(size, size, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function main() {
  const full = iconSvg({ small: false });
  const small = iconSvg({ small: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), full);
  fs.writeFileSync(path.join(OUT, 'icon-small.svg'), small);
  const pngDir = path.join(OUT, 'png');
  fs.mkdirSync(pngDir, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const bufs = [];
  for (const s of sizes) {
    const buf = await render(s <= 32 ? small : full, s);
    fs.writeFileSync(path.join(pngDir, `icon-${s}.png`), buf);
    bufs.push({ size: s, buf });
  }
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(bufs));
  fs.writeFileSync(path.join(OUT, 'icon.png'), bufs.find((b) => b.size === 256).buf);
  // Tray: Electron picks @1.5x / @2x automatically on scaled displays.
  fs.writeFileSync(path.join(OUT, 'tray.png'), await render(small, 16));
  fs.writeFileSync(path.join(OUT, 'tray@1.5x.png'), await render(small, 24));
  fs.writeFileSync(path.join(OUT, 'tray@2x.png'), await render(small, 32));
  // A preview sheet so the sizes can be checked side by side.
  const sheetW = 760;
  const sheetH = 300;
  const composites = [];
  let x = 20;
  for (const s of sizes) {
    composites.push({ input: bufs.find((b) => b.size === s).buf, left: x, top: 20 });
    x += s + 20;
  }
  // 16 and 32 also shown magnified 8x / 4x (nearest neighbour) to judge pixel crispness.
  const mag16 = await sharp(bufs[0].buf).resize(128, 128, { kernel: 'nearest' }).png().toBuffer();
  const mag32 = await sharp(bufs[2].buf).resize(128, 128, { kernel: 'nearest' }).png().toBuffer();
  composites.push({ input: mag16, left: 20, top: 150 });
  composites.push({ input: mag32, left: 170, top: 150 });
  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: '#0B0F0D' } })
    .composite(composites).png().toFile(path.join(OUT, 'png', 'preview-sheet.png'));
  // Same sheet on a light background (Explorer light theme).
  await sharp({ create: { width: sheetW, height: sheetH, channels: 4, background: '#F3F3F3' } })
    .composite(composites).png().toFile(path.join(OUT, 'png', 'preview-sheet-light.png'));
  console.log('icon set written to', OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
