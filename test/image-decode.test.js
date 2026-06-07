// image-decode.test.js
// decodePng の実カメラ対応(8-bit RGB/RGBA + PNG フィルタ → 輝度グレー)の回帰検証。
// 合成担体は grayscale・filter 0 だけだが、実写は カラー + Sub/Up/Average/Paeth フィルタを使う。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng } from '../src/image.js';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
};
// raw 行(各 stride バイト)を指定フィルタで前方符号化して PNG を組む(decodePng の逆)。
function makePng(w, h, ch, colorType, rows, filters) {
  const stride = w * ch;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const ft = filters[y]; raw[y * (stride + 1)] = ft;
    const cur = rows[y], above = y > 0 ? rows[y - 1] : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = above[i], c = i >= ch ? above[i - ch] : 0;
      let v;
      switch (ft) {
        case 0: v = cur[i]; break;
        case 1: v = cur[i] - a; break;
        case 2: v = cur[i] - b; break;
        case 3: v = cur[i] - ((a + b) >> 1); break;
        case 4: v = cur[i] - paeth(a, b, c); break;
      }
      raw[y * (stride + 1) + 1 + i] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = colorType;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const lum = (r, g, b) => (r * 299 + g * 587 + b * 114 + 500) / 1000 | 0;

test('decodePng: 8-bit RGB を全フィルタ(Sub/Up/Average/Paeth)で輝度グレーへ復号', () => {
  // 4 行とも同じ RGB(R/G/B/白)。各行に別フィルタを当てても同一内容に復号されるはず。
  const px = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
  const rows = [0, 1, 2, 3].map(() => Buffer.from(px));
  const png = makePng(4, 4, 3, 2, rows, [1, 2, 3, 4]); // Sub/Up/Average/Paeth
  const { w, h, pixels } = decodePng(png);
  assert.equal(w, 4); assert.equal(h, 4);
  const exp = [lum(255, 0, 0), lum(0, 255, 0), lum(0, 0, 255), lum(255, 255, 255)];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    assert.equal(pixels[y * 4 + x], exp[x], `row ${y} col ${x}`);
  }
});

test('decodePng: 8-bit RGBA はアルファを無視して RGB 輝度で復号', () => {
  const px = [255, 0, 0, 128, 0, 255, 0, 255]; // 赤(α=128)・緑(α=255)
  const png = makePng(2, 1, 4, 6, [Buffer.from(px)], [0]);
  const { w, h, pixels } = decodePng(png);
  assert.equal(w, 2); assert.equal(h, 1);
  assert.equal(pixels[0], lum(255, 0, 0));
  assert.equal(pixels[1], lum(0, 255, 0));
});

test('decodePng: 8-bit グレースケール(filter 0)は従来どおり素通し', () => {
  const png = makePng(3, 1, 1, 0, [Buffer.from([10, 128, 250])], [0]);
  const { pixels } = decodePng(png);
  assert.deepEqual([...pixels], [10, 128, 250]);
});
