'use strict';
// 1024 黑白圆角方图标，无文字。一条入射、一条棱、两条出射。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 1024;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, c]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function cover(x, y, l, t, r, b, rad) {
  const mx = (l + r) / 2;
  const my = (t + b) / 2;
  const hw = (r - l) / 2;
  const hh = (b - t) / 2;
  const dx = Math.abs(x + 0.5 - mx) - (hw - rad);
  const dy = Math.abs(y + 0.5 - my) - (hh - rad);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  const dist = Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - rad;
  if (dist <= -0.75) return 1;
  if (dist >= 0.75) return 0;
  return Math.max(0, Math.min(1, 0.5 - dist));
}

function blend(px, x, y, a) {
  if (a <= 0 || x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const sa = a;
  const da = px[i + 3] / 255;
  const out = sa + da * (1 - sa);
  const src = 255;
  px[i] = Math.round((src * sa + px[i] * da * (1 - sa)) / (out || 1));
  px[i + 1] = Math.round((src * sa + px[i + 1] * da * (1 - sa)) / (out || 1));
  px[i + 2] = Math.round((src * sa + px[i + 2] * da * (1 - sa)) / (out || 1));
  px[i + 3] = Math.round(out * 255);
}

function fill(px, l, t, r, b, rad, black) {
  const x0 = Math.max(0, Math.floor(l - 1));
  const y0 = Math.max(0, Math.floor(t - 1));
  const x1 = Math.min(S - 1, Math.ceil(r + 1));
  const y1 = Math.min(S - 1, Math.ceil(b + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = cover(x, y, l, t, r, b, rad);
      if (a <= 0) continue;
      const i = (y * S + x) * 4;
      if (black) {
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = Math.round(a * 255);
      } else {
        blend(px, x, y, a);
      }
    }
  }
}

function downscale(src, sw, dw) {
  const out = Buffer.alloc(dw * dw * 4);
  for (let y = 0; y < dw; y++) {
    const y0 = Math.floor((y * sw) / dw);
    const y1 = Math.floor(((y + 1) * sw) / dw);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.floor(((x + 1) * sw) / dw);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * sw + xx) * 4;
          const aa = src[i + 3];
          r += src[i] * aa;
          g += src[i + 1] * aa;
          b += src[i + 2] * aa;
          a += aa;
          n++;
        }
      }
      const o = (y * dw + x) * 4;
      if (!a || !n) continue;
      out[o] = Math.round(r / a);
      out[o + 1] = Math.round(g / a);
      out[o + 2] = Math.round(b / a);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function ico(images) {
  const count = images.length;
  const dir = Buffer.alloc(6 + count * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  let offset = dir.length;
  const parts = [dir];
  images.forEach((im, i) => {
    const o = 6 + i * 16;
    dir[o] = im.w >= 256 ? 0 : im.w;
    dir[o + 1] = im.h >= 256 ? 0 : im.h;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(im.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
    parts.push(im.png);
  });
  return Buffer.concat(parts);
}

function draw() {
  const px = Buffer.alloc(S * S * 4);
  fill(px, 72, 72, 952, 952, 196, true);
  fill(px, 246, 470, 452, 554, 16, false);
  fill(px, 468, 292, 548, 732, 18, false);
  fill(px, 568, 360, 790, 428, 16, false);
  fill(px, 568, 596, 748, 664, 16, false);
  return px;
}

const px = draw();
const dir = __dirname;
fs.writeFileSync(path.join(dir, 'icon.png'), encodePNG(S, S, px));
fs.writeFileSync(path.join(dir, 'icon512.png'), encodePNG(512, 512, downscale(px, S, 512)));

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((w) => ({ w, h: w, png: encodePNG(w, w, downscale(px, S, w)) }));
fs.writeFileSync(path.join(dir, 'icon.ico'), ico(images));
console.log('icon.png', S, 'icon.ico', sizes.join(','));
