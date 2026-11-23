'use strict';
// Builds a REAL HEVC-coded, tiled (grid) HEIC file for tests, the same structure iPhones write:
// many small HEVC tiles + a 'grid' item + a rotation property. Tiles are encoded with FFmpeg (libx265).
// The picture: left 60% red, right 40% blue, a white square in the top-left corner, a green band along the bottom.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function box(type, ...payload) {
  const body = Buffer.concat(payload.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const u8 = (n) => Buffer.from([n]);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const fullBox = (type, version, flags, ...payload) => box(type, u8(version), Buffer.from([(flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payload);

function splitAnnexB(buf) {
  const nals = [];
  let i = 0; let start = -1;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const sc = buf[i + 2] === 1 ? 3 : 4;
      if (start >= 0) nals.push(buf.slice(start, i));
      start = i + sc; i += sc;
    } else i += 1;
  }
  if (start >= 0) nals.push(buf.slice(start));
  return nals;
}

function unescapeRbsp(b) {
  const out = [];
  for (let i = 0; i < b.length; i += 1) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out.push(b[i]);
  }
  return Buffer.from(out);
}

function hvcC(vps, sps, pps) {
  const rbsp = unescapeRbsp(sps.slice(2));
  // SPS: 1 byte (vps id, max sub layers, nesting) then profile_tier_level: 1 + 4 + 6 + 1 bytes
  const ptl = rbsp.slice(1, 13);
  const arr = (type, nal) => Buffer.concat([u8(0x80 | type), u16(1), u16(nal.length), nal]);
  return box('hvcC', Buffer.concat([
    u8(1), ptl.slice(0, 1), ptl.slice(1, 5), ptl.slice(5, 11), ptl.slice(11, 12),
    u16(0xf000), u8(0xfc), u8(0xfc | 1), u8(0xf8), u8(0xf8), u16(0),
    u8(0x03 | 0x08), // constantFrameRate 0, numTemporalLayers 1, nested 0, lengthSizeMinusOne 3
    u8(3), arr(32, vps), arr(33, sps), arr(34, pps),
  ]));
}

/** opts: { tile=256, cols=3, rows=2, outW=700, outH=500, rotate (0..3 = irot angle, quarter turns CCW) } */
function makeHeic(file, ffmpeg, opts) {
  const sharp = require('sharp');
  const o = Object.assign({ tile: 256, cols: 3, rows: 2, outW: 700, outH: 500, rotate: 1 }, opts || {});
  const W = o.tile * o.cols; const Hh = o.tile * o.rows;
  const raw = Buffer.alloc(W * Hh * 3);
  for (let y = 0; y < Hh; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let c = x < o.outW * 0.6 ? [230, 20, 20] : [20, 20, 230];
      if (x < 120 && y < 120) c = [250, 250, 250];
      if (y > o.outH - 80) c = [20, 200, 20];
      const k = (y * W + x) * 3;
      raw[k] = c[0]; raw[k + 1] = c[1]; raw[k + 2] = c[2];
    }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonika-heic-'));
  try {
    const tiles = []; let vps; let sps; let pps;
    for (let r = 0; r < o.rows; r += 1) {
      for (let c = 0; c < o.cols; c += 1) {
        const hevc = path.join(tmp, `t${r}_${c}.hevc`);
        const tileRaw = Buffer.alloc(o.tile * o.tile * 3);
        for (let y = 0; y < o.tile; y += 1) raw.copy(tileRaw, y * o.tile * 3, ((r * o.tile + y) * W + c * o.tile) * 3, ((r * o.tile + y) * W + c * o.tile) * 3 + o.tile * 3);
        // write the tile as raw RGB and let ffmpeg read it
        const rgb = path.join(tmp, `t${r}_${c}.rgb`);
        fs.writeFileSync(rgb, tileRaw);
        const res = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${o.tile}x${o.tile}`, '-i', rgb,
          '-frames:v', '1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-crf', '12', '-x265-params', 'keyint=1:info=0:log-level=none:repeat-headers=1', '-f', 'hevc', hevc], { encoding: 'utf8' });
        if (res.status !== 0) throw new Error('ffmpeg tile encode failed: ' + res.stderr);
        const nals = splitAnnexB(fs.readFileSync(hevc));
        const slices = [];
        for (const n of nals) {
          const t = (n[0] >> 1) & 63;
          if (t === 32 && !vps) vps = n;
          else if (t === 33 && !sps) sps = n;
          else if (t === 34 && !pps) pps = n;
          else if (t <= 21 && t !== 35) slices.push(n);
        }
        if (!slices.length) throw new Error('no slice found in tile');
        tiles.push(Buffer.concat(slices.map((s) => Buffer.concat([u32(s.length), s]))));
      }
    }
    const nTiles = tiles.length;
    const gridId = nTiles + 1;
    const gridData = Buffer.concat([u8(0), u8(o.outW > 65535 || o.outH > 65535 ? 1 : 0), u8(o.rows - 1), u8(o.cols - 1), u16(o.outW), u16(o.outH)]);
    const ftyp = box('ftyp', 'heic', u32(0), 'mif1', 'heic');

    const build = (baseOffset) => {
      const items = [];
      let off = baseOffset;
      const ilocItems = [];
      ilocItems.push([gridId, off, gridData.length]); off += gridData.length;
      tiles.forEach((t, i) => { ilocItems.push([i + 1, off, t.length]); off += t.length; });
      const iloc = fullBox('iloc', 0, 0, u8(0x44), u8(0x00), u16(ilocItems.length),
        ...ilocItems.map(([id, o2, l]) => Buffer.concat([u16(id), u16(0), u16(1), u32(o2), u32(l)])));
      const infe = (id, type, hidden) => fullBox('infe', 2, hidden ? 1 : 0, u16(id), u16(0), type, u8(0));
      const iinf = fullBox('iinf', 0, 0, u16(nTiles + 1), infe(gridId, 'grid', false), ...tiles.map((_, i) => infe(i + 1, 'hvc1', true)));
      const dimg = box('dimg', u16(gridId), u16(nTiles), ...tiles.map((_, i) => u16(i + 1)));
      const iref = fullBox('iref', 0, 0, dimg);
      const ispe = (w, h) => fullBox('ispe', 0, 0, u32(w), u32(h));
      const irot = box('irot', u8(o.rotate & 3));
      const colr = o.icc ? box('colr', 'prof', o.icc) : null;
      const ipco = box('ipco', hvcC(vps, sps, pps), ispe(o.tile, o.tile), ispe(o.outW, o.outH), irot, ...(colr ? [colr] : []));
      const assoc = [];
      tiles.forEach((_, i) => assoc.push(Buffer.concat([u16(i + 1), u8(2), u8(0x81), u8(0x02)])));
      const gridAssoc = [u8(0x03), ...(o.rotate ? [u8(0x84)] : []), ...(colr ? [u8(0x05)] : [])];
      assoc.push(Buffer.concat([u16(gridId), u8(gridAssoc.length), ...gridAssoc]));
      const ipma = fullBox('ipma', 0, 0, u32(assoc.length), ...assoc);
      const iprp = box('iprp', ipco, ipma);
      const hdlr = fullBox('hdlr', 0, 0, u32(0), 'pict', Buffer.alloc(12), u8(0));
      const pitm = fullBox('pitm', 0, 0, u16(gridId));
      return fullBox('meta', 0, 0, hdlr, pitm, iloc, iinf, iref, iprp);
    };
    const metaSize = build(0).length;
    const meta = build(ftyp.length + metaSize + 8);
    const mdat = box('mdat', gridData, ...tiles);
    fs.writeFileSync(file, Buffer.concat([ftyp, meta, mdat]));
    return { width: o.rotate & 1 ? o.outH : o.outW, height: o.rotate & 1 ? o.outW : o.outH };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { makeHeic };
