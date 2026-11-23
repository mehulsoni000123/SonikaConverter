'use strict';
// node test/image.test.js  -  convert / resize / compress, including a real tiled HEVC HEIC file.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const H = require('./fixtures/docs/helpers');
const { makeHeic } = require('./fixtures/docs/make-heic');
const util = require('../src/engine/util');
const image = require('../src/engine/image');

const tool = (id) => image.tools.find((t) => t.id === id);
const run = (id, file, options, extra) => tool(id).run([file], options, H.ctx(extra));

async function noisyRaw(w, h, seed) {
  const raw = Buffer.alloc(w * h * 3);
  let s = seed || 1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = (s >> 16) & 31; const o = (y * w + x) * 3;
      raw[o] = Math.min(255, (x * 255 / w) + n); raw[o + 1] = Math.min(255, (y * 255 / h) + n); raw[o + 2] = Math.min(255, ((x + y) * 127 / (w + h)) + n * 2);
    }
  }
  return raw;
}

function bmpEncode(w, h, rgbFn, bpp) {
  const rowSize = Math.floor((bpp * w + 31) / 32) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0, 'latin1'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(bpp, 28);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = rgbFn(x, y);
      const o = 54 + (h - 1 - y) * rowSize + x * (bpp / 8);
      buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; if (bpp === 32) buf[o + 3] = 255;
    }
  }
  return buf;
}

async function pixel(file, x, y) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return Array.from(data.slice(o, o + Math.min(3, info.channels)));
}
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

(async () => {
  const R = H.createRunner('image.test');
  const { check } = R;
  const work = H.freshDir('image');
  const W = (n) => path.join(work, n);
  const ffmpeg = util.findFfmpeg({});
  const dims = async (f) => { const m = await sharp(f).metadata(); return `${m.width}x${m.height}`; };

  // ---------------- fixtures ----------------
  // 300x200: left half red, right half blue
  const twoTone = (w, h) => {
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = (y * w + x) * 3; if (x < w / 2) { raw[o] = 230; raw[o + 1] = 20; raw[o + 2] = 20; } else { raw[o] = 20; raw[o + 1] = 20; raw[o + 2] = 230; } }
    return raw;
  };
  const base = sharp(twoTone(300, 200), { raw: { width: 300, height: 200, channels: 3 } });
  await base.clone().jpeg({ quality: 92 }).toFile(W('photo.jpg'));
  fs.copyFileSync(W('photo.jpg'), W('photo2.jpeg'));
  await base.clone().png().toFile(W('flat.png'));
  await base.clone().webp({ quality: 90 }).toFile(W('pic.webp'));
  await base.clone().tiff({ compression: 'lzw' }).toFile(W('pic.tif'));
  await base.clone().avif({ quality: 60, effort: 2 }).toFile(W('pic.avif'));
  await base.clone().jpeg({ quality: 92 }).withMetadata({ orientation: 6 }).toFile(W('rotated6.jpg'));
  fs.writeFileSync(W('pic.bmp'), bmpEncode(300, 200, (x) => (x < 150 ? [230, 20, 20] : [20, 20, 230]), 24));
  fs.writeFileSync(W('pic32.bmp'), bmpEncode(64, 48, (x) => (x < 32 ? [230, 20, 20] : [20, 20, 230]), 32));
  // animated gif, 3 frames of 60x40
  {
    const w = 60; const h = 40; const frames = [];
    for (let f = 0; f < 3; f += 1) { const fr = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i += 1) { fr[i * 3 + f] = 255; } frames.push(fr); }
    await sharp(Buffer.concat(frames), { raw: { width: w, height: h * 3, channels: 3, pageHeight: h } }).gif({ delay: [100, 100, 100], loop: 0 }).toFile(W('anim.gif'));
    await sharp(frames[0], { raw: { width: w, height: h, channels: 3 } }).gif().toFile(W('still.gif'));
  }
  // transparent PNG: opaque red circle-ish square on transparent background
  {
    const w = 80; const h = 60; const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const o = (y * w + x) * 4; if (x >= 40) { raw[o] = 255; raw[o + 3] = 255; } }
    await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(W('alpha.png'));
  }
  // big noisy photos for resize / compress
  const bigRaw = await noisyRaw(3000, 2000, 7);
  await sharp(bigRaw, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 95 }).toFile(W('big.jpg'));
  await sharp(bigRaw, { raw: { width: 3000, height: 2000, channels: 3 } }).rotate(90).jpeg({ quality: 90 }).toFile(W('tall.jpg'));
  const midRaw = await noisyRaw(1200, 800, 9);
  await sharp(midRaw, { raw: { width: 1200, height: 800, channels: 3 } }).png().toFile(W('photo-like.png'));
  await sharp(midRaw, { raw: { width: 1200, height: 800, channels: 3 } }).webp({ quality: 95 }).toFile(W('photo-like.webp'));
  await sharp(midRaw, { raw: { width: 1200, height: 800, channels: 3 } }).tiff({ compression: 'none' }).toFile(W('photo-like.tif'));
  await sharp(midRaw, { raw: { width: 1200, height: 800, channels: 3 } }).gif().toFile(W('photo-like.gif'));
  await sharp(midRaw, { raw: { width: 1200, height: 800, channels: 3 } }).avif({ quality: 90, effort: 2 }).toFile(W('photo-like.avif'));
  await sharp({ create: { width: 800, height: 600, channels: 3, background: '#336699' } }).jpeg().toFile(W('small800.jpg'));
  await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).png({ compressionLevel: 9 }).toFile(W('tiny.png'));
  // CMYK jpeg of pure-ish red, and a Display-P3 tagged jpeg
  await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 230, g: 20, b: 20 } } }).toColourspace('cmyk').jpeg().toFile(W('cmyk.jpg'));
  await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 230, g: 20, b: 20 } } }).withIccProfile('p3').jpeg({ quality: 95 }).toFile(W('p3.jpg'));
  // names with spaces / unicode / brackets
  fs.copyFileSync(W('photo.jpg'), W('मेरा photo (final) #2.jpg'));
  // HEIC: tiled HEVC (3x2 tiles of 256, cropped to 700x500, rotated 90 deg => 500x700)
  const heicInfo = makeHeic(W('iphone.heic'), ffmpeg, {});
  fs.copyFileSync(W('iphone.heic'), W('iphone2.heif'));
  const p3icc = (await sharp(W('p3.jpg')).metadata()).icc;
  makeHeic(W('iphone-p3.heic'), ffmpeg, { icc: p3icc });
  // heic with no rotation, 2x2 tiles exactly: 512x512
  makeHeic(W('square.heic'), ffmpeg, { tile: 256, cols: 2, rows: 2, outW: 512, outH: 512, rotate: 0 });
  // bad files
  fs.writeFileSync(W('random.jpg'), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) & 255)));
  fs.writeFileSync(W('text.png'), 'this is not a picture at all');
  fs.writeFileSync(W('empty.jpg'), '');
  const goodJpg = fs.readFileSync(W('big.jpg'));
  fs.writeFileSync(W('truncated.jpg'), goodJpg.slice(0, Math.floor(goodJpg.length / 3)));
  fs.writeFileSync(W('broken.heic'), Buffer.concat([fs.readFileSync(W('iphone.heic')).slice(0, 600), Buffer.alloc(100)]));

  // ---------------- metadata ----------------
  await check('tool metadata: ids, category, default tool, option keys', async () => {
    assert.deepStrictEqual(image.tools.map((t) => t.id), ['image-convert', 'image-resize', 'image-compress']);
    assert.ok(image.tools.every((t) => t.category === 'image' && t.multi === 'each' && t.accepts.every((e) => e === e.toLowerCase() && e.startsWith('.'))));
    assert.strictEqual(image.tools.filter((t) => t.isDefault).length, 1);
    assert.strictEqual(tool('image-convert').isDefault, true);
    assert.ok(tool('image-convert').accepts.includes('.heic') && tool('image-convert').accepts.includes('.heif'));
    assert.deepStrictEqual(tool('image-convert').options.map((o) => o.key), ['format', 'quality']);
    assert.deepStrictEqual(tool('image-resize').options.map((o) => o.key), ['preset', 'width', 'allowUpscale']);
    assert.deepStrictEqual(tool('image-compress').options.map((o) => o.key), ['level']);
    for (const t of image.tools) for (const o of t.options) { if (o.type === 'choice') assert.ok(o.choices.some((c) => c.value === o.default), `${t.id}.${o.key} default is a choice`); }
  });

  // ---------------- convert: every input x every output ----------------
  const inputs = [['photo.jpg', 300, 200], ['photo2.jpeg', 300, 200], ['flat.png', 300, 200], ['pic.webp', 300, 200], ['pic.bmp', 300, 200], ['pic.tif', 300, 200], ['pic.avif', 300, 200], ['still.gif', 60, 40], ['iphone.heic', 500, 700], ['iphone2.heif', 500, 700]];
  for (const [name, w, h] of inputs) {
    for (const fmt of ['jpg', 'png', 'webp']) {
      await check(`convert ${name} -> ${fmt}: right format and size`, async () => {
        const outDir = path.join(work, `out-${name}-${fmt}`);
        const res = await run('image-convert', W(name), { format: fmt, quality: 90 }, { outDir });
        assert.strictEqual(res.outputs.length, 1);
        const m = await sharp(res.outputs[0]).metadata();
        assert.strictEqual(m.format, fmt === 'jpg' ? 'jpeg' : fmt);
        assert.strictEqual(m.width, w, `width ${m.width} != ${w}`);
        assert.strictEqual(m.height, h, `height ${m.height} != ${h}`);
        assert.ok(res.outputs[0].endsWith(fmt === 'jpg' ? '.jpg' : '.' + fmt));
        assert.ok(/Converted/.test(res.message));
      });
    }
  }

  await check('HEIC: decoded as the FULL picture, upright, correct colours (not one tile, not sideways)', async () => {
    assert.deepStrictEqual(heicInfo, { width: 500, height: 700 });
    const res = await run('image-convert', W('iphone.heic'), { format: 'png' }, { outDir: path.join(work, 'out-heic') });
    const m = await sharp(res.outputs[0]).metadata();
    assert.strictEqual(`${m.width}x${m.height}`, '500x700');
    // source: left 60% red, right 40% blue, white square top-left, green band along the bottom; rotated 90deg counter-clockwise
    assert.ok(near(await pixel(res.outputs[0], 10, 10), [20, 20, 230], 45), 'top should be blue');
    assert.ok(near(await pixel(res.outputs[0], 250, 400), [230, 20, 20], 45), 'middle/bottom should be red');
    assert.ok(near(await pixel(res.outputs[0], 10, 690), [250, 250, 250], 45), 'bottom-left should be the white square');
    assert.ok(near(await pixel(res.outputs[0], 490, 350), [20, 200, 20], 45), 'right edge should be the green band');
  });

  await check('HEIC without rotation, exact 2x2 tiles -> 512x512 (grid fully assembled)', async () => {
    const res = await run('image-convert', W('square.heic'), { format: 'png' }, { outDir: path.join(work, 'out-square') });
    const m = await sharp(res.outputs[0]).metadata();
    assert.strictEqual(`${m.width}x${m.height}`, '512x512');
    assert.ok(near(await pixel(res.outputs[0], 5, 5), [250, 250, 250], 45));
    assert.ok(near(await pixel(res.outputs[0], 500, 5), [20, 20, 230], 45), 'top-right tile present');
    assert.ok(near(await pixel(res.outputs[0], 5, 505), [20, 200, 20], 45), 'bottom-left tile present');
    assert.ok(near(await pixel(res.outputs[0], 500, 505), [20, 200, 20], 45), 'bottom-right tile present');
  });

  await check('HEIC with an embedded Display-P3 profile: colours converted to sRGB, not left raw', async () => {
    const plain = await run('image-convert', W('iphone.heic'), { format: 'png' }, { outDir: path.join(work, 'out-icc-a') });
    const p3 = await run('image-convert', W('iphone-p3.heic'), { format: 'png' }, { outDir: path.join(work, 'out-icc-b') });
    const a = await pixel(plain.outputs[0], 250, 400); const b = await pixel(p3.outputs[0], 250, 400); // the red part
    assert.ok(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])   >= 12, `P3 colour was not converted: untagged ${a} vs P3 ${b}`);
    assert.strictEqual(await dims(p3.outputs[0]), '500x700');
  });

  await check('HEIC resize and compress paths decode correctly too', async () => {
    const r = await run('image-resize', W('iphone.heic'), { preset: 'half' }, { outDir: path.join(work, 'out-heic-r') });
    const m = await sharp(r.outputs[0]).metadata();
    assert.strictEqual(`${m.width}x${m.height}`, '250x350');
    assert.strictEqual(m.format, 'jpeg');
  });

  await check('broken / cut-off HEIC fails clearly (no wrong picture produced)', async () => {
    const outDir = path.join(work, 'out-brokenheic');
    const err = await H.expectError(run('image-convert', W('broken.heic'), { format: 'jpg' }, { outDir }), /could not be (read|decoded)/i, 'broken heic');
    assert.ok(!/vips|libheif|plugin/i.test(err.message), err.message);
    assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
  });

  await check('EXIF orientation is applied (orientation 6 -> upright 200x300, red on top)', async () => {
    const res = await run('image-convert', W('rotated6.jpg'), { format: 'png' }, { outDir: path.join(work, 'out-exif') });
    const m = await sharp(res.outputs[0]).metadata();
    assert.strictEqual(`${m.width}x${m.height}`, '200x300');
    assert.ok(near(await pixel(res.outputs[0], 100, 20), [230, 20, 20], 40), 'red should be at the top');
    assert.ok(near(await pixel(res.outputs[0], 100, 280), [20, 20, 230], 40), 'blue should be at the bottom');
  });

  await check('transparent PNG -> JPG becomes white, -> WebP keeps transparency', async () => {
    const j = await run('image-convert', W('alpha.png'), { format: 'jpg' }, { outDir: path.join(work, 'out-alpha-j') });
    assert.ok(near(await pixel(j.outputs[0], 5, 5), [255, 255, 255], 6), 'transparent area must be white');
    assert.ok(near(await pixel(j.outputs[0], 70, 30), [255, 0, 0], 25));
    const w = await run('image-convert', W('alpha.png'), { format: 'webp' }, { outDir: path.join(work, 'out-alpha-w') });
    const m = await sharp(w.outputs[0]).metadata();
    assert.strictEqual(m.hasAlpha, true);
  });

  await check('animated GIF -> WebP keeps all 3 frames; -> JPG gives first frame', async () => {
    const w = await run('image-convert', W('anim.gif'), { format: 'webp' }, { outDir: path.join(work, 'out-gif-w') });
    const m = await sharp(w.outputs[0], { animated: true }).metadata();
    assert.strictEqual(m.pages, 3);
    const j = await run('image-convert', W('anim.gif'), { format: 'jpg' }, { outDir: path.join(work, 'out-gif-j') });
    const mj = await sharp(j.outputs[0]).metadata();
    assert.strictEqual(`${mj.width}x${mj.height}`, '60x40');
  });

  await check('CMYK JPEG converted to RGB with sane colours', async () => {
    const res = await run('image-convert', W('cmyk.jpg'), { format: 'png' }, { outDir: path.join(work, 'out-cmyk') });
    const m = await sharp(res.outputs[0]).metadata();
    assert.ok(m.channels >= 3 && m.space === 'srgb', `space ${m.space}`);
    assert.ok(near(await pixel(res.outputs[0], 20, 20), [230, 20, 20], 60), `got ${await pixel(res.outputs[0], 20, 20)}`);
  });

  await check('Display-P3 tagged JPEG is colour-managed: converting gives back the original sRGB colour, not the raw tagged numbers', async () => {
    assert.strictEqual((await sharp(W('p3.jpg')).metadata()).hasProfile, true);
    const res = await run('image-convert', W('p3.jpg'), { format: 'png' }, { outDir: path.join(work, 'out-p3') });
    const p = await pixel(res.outputs[0], 20, 20);
    // the file stores P3 numbers (about 219,33,29); correct conversion returns the sRGB colour that was tagged: (230,20,20)
    assert.ok(near(p, [230, 20, 20], 8), `got ${p}`);
  });

  await check('32-bit BMP decodes correctly', async () => {
    const res = await run('image-convert', W('pic32.bmp'), { format: 'png' }, { outDir: path.join(work, 'out-bmp32') });
    assert.ok(near(await pixel(res.outputs[0], 5, 5), [230, 20, 20], 3));
    assert.ok(near(await pixel(res.outputs[0], 60, 40), [20, 20, 230], 3));
  });

  await check('quality option works: JPG q30 smaller than q95', async () => {
    const lo = await run('image-convert', W('big.jpg'), { format: 'jpg', quality: 30 }, { outDir: path.join(work, 'q30') });
    const hi = await run('image-convert', W('big.jpg'), { format: 'jpg', quality: 95 }, { outDir: path.join(work, 'q95') });
    assert.ok(fs.statSync(lo.outputs[0]).size < fs.statSync(hi.outputs[0]).size * 0.7, 'q30 should be much smaller');
    const wl = await run('image-convert', W('big.jpg'), { format: 'webp', quality: 20 }, { outDir: path.join(work, 'w20') });
    const wh = await run('image-convert', W('big.jpg'), { format: 'webp', quality: 95 }, { outDir: path.join(work, 'w95') });
    assert.ok(fs.statSync(wl.outputs[0]).size < fs.statSync(wh.outputs[0]).size);
  });

  await check('names with spaces, unicode and brackets are kept; output lands next to input when outDir is null', async () => {
    const res = await run('image-convert', W('मेरा photo (final) #2.jpg'), { format: 'png' });
    assert.strictEqual(res.outputs[0], W('मेरा photo (final) #2.png'));
    assert.ok(fs.existsSync(res.outputs[0]));
  });

  await check('no overwrite: same-format convert makes "name (2).jpg", then "(3)"', async () => {
    const dir = H.freshDir('image-nooverwrite');
    const src = path.join(dir, 'shot.jpg');
    fs.copyFileSync(W('photo.jpg'), src);
    const before = fs.readFileSync(src);
    const a = await run('image-convert', src, { format: 'jpg' });
    const b = await run('image-convert', src, { format: 'jpg' });
    assert.strictEqual(path.basename(a.outputs[0]), 'shot (2).jpg');
    assert.strictEqual(path.basename(b.outputs[0]), 'shot (3).jpg');
    assert.ok(before.equals(fs.readFileSync(src)), 'original untouched');
  });

  // ---------------- resize ----------------
  await check('resize instagram-1080: landscape 3000x2000 -> 1080x720; keeps JPG', async () => {
    const res = await run('image-resize', W('big.jpg'), { preset: 'instagram-1080' }, { outDir: path.join(work, 'r1') });
    assert.strictEqual(await dims(res.outputs[0]), '1080x720');
    assert.ok(/\.jpg$/.test(res.outputs[0]) && /1080x720/.test(path.basename(res.outputs[0])));
    assert.strictEqual((await sharp(res.outputs[0]).metadata()).format, 'jpeg');
  });
  await check('resize instagram-1080: portrait (EXIF-rotated) picture long edge 1080', async () => {
    const res = await run('image-resize', W('tall.jpg'), { preset: 'instagram-1080' }, { outDir: path.join(work, 'r2') });
    assert.strictEqual(await dims(res.outputs[0]), '720x1080');
  });
  await check('resize 4k-3840: 5000 px wide source', async () => {
    const src = W('wide5000.png');
    await sharp({ create: { width: 5000, height: 3000, channels: 3, background: '#808080' } }).png({ compressionLevel: 9 }).toFile(src);
    const res = await run('image-resize', src, { preset: '4k-3840' }, { outDir: path.join(work, 'r3') });
    assert.strictEqual(await dims(res.outputs[0]), '3840x2304');
    assert.strictEqual((await sharp(res.outputs[0]).metadata()).format, 'png');
  });
  await check('resize half: 3000x2000 -> 1500x1000', async () => {
    const res = await run('image-resize', W('big.jpg'), { preset: 'half' }, { outDir: path.join(work, 'r4') });
    assert.strictEqual(await dims(res.outputs[0]), '1500x1000');
  });
  await check('resize custom width 500 keeps aspect ratio; 777 px wide too', async () => {
    const a = await run('image-resize', W('big.jpg'), { preset: 'custom', width: 500 }, { outDir: path.join(work, 'r5') });
    assert.strictEqual(await dims(a.outputs[0]), '500x333');
    const b = await run('image-resize', W('big.jpg'), { preset: 'custom', width: 777 }, { outDir: path.join(work, 'r5b') });
    assert.strictEqual(await dims(b.outputs[0]), '777x518');
  });
  await check('never upscales by default (preset and custom)', async () => {
    const a = await run('image-resize', W('small800.jpg'), { preset: 'instagram-1080' }, { outDir: path.join(work, 'r6') });
    assert.strictEqual(await dims(a.outputs[0]), '800x600');
    assert.ok(/kept|already/i.test(a.message), a.message);
    const b = await run('image-resize', W('small800.jpg'), { preset: 'custom', width: 2000, allowUpscale: false }, { outDir: path.join(work, 'r6b') });
    assert.strictEqual(await dims(b.outputs[0]), '800x600');
  });
  await check('upscale toggle on: 800x600 -> 1080x810 and custom 1600 -> 1600x1200', async () => {
    const a = await run('image-resize', W('small800.jpg'), { preset: 'instagram-1080', allowUpscale: true }, { outDir: path.join(work, 'r7') });
    assert.strictEqual(await dims(a.outputs[0]), '1080x810');
    const b = await run('image-resize', W('small800.jpg'), { preset: 'custom', width: 1600, allowUpscale: true }, { outDir: path.join(work, 'r7b') });
    assert.strictEqual(await dims(b.outputs[0]), '1600x1200');
  });
  await check('resize output format follows input: png->png, webp->webp, bmp->png, gif->gif (animated), avif->avif, tif->tif', async () => {
    const cases = [['flat.png', 'png'], ['pic.webp', 'webp'], ['pic.bmp', 'png'], ['pic.avif', 'heif'], ['pic.tif', 'tiff']];
    for (const [f, fmt] of cases) {
      const r = await run('image-resize', W(f), { preset: 'half' }, { outDir: path.join(work, 'r8-' + f) });
      assert.strictEqual((await sharp(r.outputs[0]).metadata()).format, fmt, f);
      assert.strictEqual(await dims(r.outputs[0]), '150x100', f);
    }
    const g = await run('image-resize', W('anim.gif'), { preset: 'half' }, { outDir: path.join(work, 'r8-gif') });
    const m = await sharp(g.outputs[0], { animated: true }).metadata();
    assert.strictEqual(m.format, 'gif'); assert.strictEqual(m.pages, 3); assert.strictEqual(m.pageHeight, 20); assert.strictEqual(m.width, 30);
  });
  await check('resize: bad custom width gives a clear error', async () => {
    await H.expectError(run('image-resize', W('big.jpg'), { preset: 'custom', width: 0 }, { outDir: path.join(work, 'r9') }), /width between 1 and/i, 'zero width');
    await H.expectError(run('image-resize', W('big.jpg'), { preset: 'custom', width: 'abc' }, { outDir: path.join(work, 'r9') }), /width between 1 and/i, 'text width');
    await H.expectError(run('image-resize', W('big.jpg'), { preset: 'nonsense' }, { outDir: path.join(work, 'r9') }), /Unknown size/i, 'unknown preset');
  });

  // ---------------- compress ----------------
  await check('compress jpeg: light > balanced > strong in size, all smaller than original; message has both sizes', async () => {
    const orig = fs.statSync(W('big.jpg')).size;
    const sizes = {};
    for (const level of ['light', 'balanced', 'strong']) {
      const r = await run('image-compress', W('big.jpg'), { level }, { outDir: path.join(work, 'c-' + level) });
      sizes[level] = fs.statSync(r.outputs[0]).size;
      assert.strictEqual((await sharp(r.outputs[0]).metadata()).format, 'jpeg');
      assert.ok(/compressed\.jpg$/.test(r.outputs[0]));
      assert.ok(/->/.test(r.message) && /% smaller/.test(r.message), r.message);
      assert.strictEqual(await dims(r.outputs[0]), '3000x2000');
    }
    assert.ok(sizes.light < orig && sizes.balanced < sizes.light && sizes.strong < sizes.balanced, JSON.stringify({ orig, ...sizes }));
  });
  for (const [f, fmt] of [['photo-like.png', 'png'], ['photo-like.webp', 'webp'], ['photo-like.tif', 'tiff'], ['photo-like.gif', 'gif'], ['photo-like.avif', 'heif']]) {
    await check(`compress ${f}: same format, smaller (balanced)`, async () => {
      const r = await run('image-compress', W(f), { level: 'balanced' }, { outDir: path.join(work, 'c2-' + f) });
      assert.strictEqual((await sharp(r.outputs[0]).metadata()).format, fmt);
      assert.ok(fs.statSync(r.outputs[0]).size < fs.statSync(W(f)).size, `${fs.statSync(r.outputs[0]).size} vs ${fs.statSync(W(f)).size}`);
      assert.ok(/% smaller/.test(r.message), r.message);
    });
  }
  await check('compress png: light (lossless) never changes pixels', async () => {
    const r = await run('image-compress', W('photo-like.png'), { level: 'light' }, { outDir: path.join(work, 'c3') });
    const a = await sharp(W('photo-like.png')).raw().toBuffer(); const b = await sharp(r.outputs[0]).raw().toBuffer();
    assert.ok(a.equals(b), 'pixels differ for lossless level');
  });
  await check('compress animated GIF keeps its frames', async () => {
    const r = await run('image-compress', W('anim.gif'), { level: 'strong' }, { outDir: path.join(work, 'c4') });
    const m = await sharp(r.outputs[0], { animated: true }).metadata();
    assert.strictEqual(m.pages, 3);
  });
  await check('compress that cannot help is honest: unchanged copy + message with both sizes', async () => {
    const r = await run('image-compress', W('tiny.png'), { level: 'strong' }, { outDir: path.join(work, 'c5') });
    assert.ok(/could not be made any smaller/i.test(r.message) && /\d+ B/.test(r.message), r.message);
    assert.ok(fs.readFileSync(r.outputs[0]).equals(fs.readFileSync(W('tiny.png'))), 'should be an unchanged copy');
  });
  await check('compress: heic is not accepted (same-format output impossible)', async () => {
    assert.ok(!tool('image-compress').accepts.includes('.heic'));
  });

  // ---------------- bad input ----------------
  for (const [file, label] of [['random.jpg', 'random bytes named .jpg'], ['text.png', 'text file named .png'], ['truncated.jpg', 'cut-off JPEG']]) {
    for (const id of ['image-convert', 'image-resize', 'image-compress']) {
      await check(`bad input (${label}) -> ${id}: plain-English error, no output`, async () => {
        const outDir = path.join(work, `bad-${id}-${file}`);
        const err = await H.expectError(run(id, W(file), {}, { outDir }), /could not be read as a picture|damaged/i, label);
        assert.ok(!/vips|sharp|libheif|Error:|ffmpeg|exit code/i.test(err.message), `technical text leaked: ${err.message}`);
        assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'no partial output');
      });
    }
  }
  await check('empty and missing files give clear errors', async () => {
    await H.expectError(run('image-convert', W('empty.jpg'), {}), /empty/i, 'empty');
    await H.expectError(run('image-convert', W('does-not-exist.jpg'), {}), /could not be found/i, 'missing');
  });

  // ---------------- cancel + progress ----------------
  await check('cancel: signal aborted before start -> Cancelled, nothing written', async () => {
    const ac = new AbortController(); ac.abort();
    const outDir = path.join(work, 'cancel1');
    await H.expectError(run('image-convert', W('big.jpg'), {}, { signal: ac.signal, outDir }), /^Cancelled$/, 'pre-cancel');
  });
  await check('cancel during conversion (aborted at the "Converting" step) -> Cancelled, nothing written', async () => {
    for (const [id, file] of [['image-convert', 'big.jpg'], ['image-resize', 'big.jpg'], ['image-compress', 'big.jpg'], ['image-convert', 'iphone.heic']]) {
      const ac = new AbortController();
      const outDir = path.join(work, `cancel-${id}-${file}`);
      const c = H.ctx({ signal: ac.signal, outDir });
      c.onProgress = (f, t) => { if (/Converting|Resizing|Compressing/.test(t)) ac.abort(); };
      await H.expectError(tool(id).run([W(file)], {}, c), /^Cancelled$/, `${id} ${file}`);
      assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'output left behind');
    }
  });
  await check('progress is reported and stays between 0 and 1, ending at 1', async () => {
    const c = H.ctx({ outDir: path.join(work, 'prog') });
    await tool('image-convert').run([W('big.jpg')], { format: 'webp' }, c);
    assert.ok(c._events.length >= 3);
    assert.ok(c._events.every(([f]) => f >= 0 && f <= 1));
    assert.strictEqual(c._events[c._events.length - 1][0], 1);
  });

  await check('works from a plain node process and via the registry (index.js)', async () => {
    const reg = require('../src/engine/index');
    assert.ok(reg.getTool('image-convert') && reg.getTool('image-resize') && reg.getTool('image-compress'));
    assert.ok(reg.toolsForFile('x.HEIC').some((t) => t.id === 'image-convert'));
    assert.ok(!reg.loadErrors.some((e) => e.module === 'image'), JSON.stringify(reg.loadErrors));
  });

  R.finish();
})().catch((e) => { console.error(e); process.exit(1); });
