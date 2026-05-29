// fuzzy.test.js
// 柱4/柱7 合流「Fuzzy Extractor(手相・虹彩などの曖昧な生体→安定鍵)」の検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gen, rep, MODALITY } from '../src/fuzzy.js';
import { seal, open } from '../src/cord.js';

// 決定的テスト用に擬似乱数で特徴ビット列を作る(seed 固定)
function feature(len, seed) {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >> 16) & 1;
  }
  return out;
}

// ビットを count 個反転(生体の曖昧さ=照合誤差を模す)
function flip(bits, count) {
  const out = Uint8Array.from(bits);
  for (let i = 0; i < count; i += 1) out[i * 7 % out.length] ^= 1;
  return out;
}

test('手相: 完全一致なら同じ鍵', () => {
  const w = feature(256, 1);
  const { key, helper } = gen(w, 'palm');
  assert.equal(rep(w, helper).toString('hex'), key.toString('hex'));
});

test('手相: 数ビットの曖昧さ(訂正能力内)でも同じ鍵を再生', () => {
  const w = feature(256, 2);
  const { key, helper } = gen(w, 'palm');
  const noisy = flip(w, 3); // ブロックあたり訂正能力内の少数反転
  assert.equal(rep(noisy, helper).toString('hex'), key.toString('hex'));
});

test('手相: 大きく違う特徴(他人の手)では別の鍵になる', () => {
  const w = feature(256, 3);
  const { key, helper } = gen(w, 'palm');
  const other = feature(256, 999); // 無関係な特徴
  assert.notEqual(rep(other, helper).toString('hex'), key.toString('hex'));
});

test('虹彩: 完全一致なら同じ鍵(モダリティ切替)', () => {
  const w = feature(2048, 7);
  const { key, helper } = gen(w, 'iris');
  assert.equal(helper.modality, 'iris');
  assert.equal(rep(w, helper).toString('hex'), key.toString('hex'));
});

test('虹彩: 手相より高い訂正冗長度(rep)を持つ', () => {
  assert.ok(MODALITY.iris.rep > MODALITY.palm.rep);
});

test('helper は生体特徴を平文で含まない(offset は XOR 済み)', () => {
  const w = feature(256, 5);
  const { helper } = gen(w, 'palm');
  // offset と元特徴が同一でない(codeword と XOR されている)
  let same = true;
  for (let i = 0; i < helper.n; i += 1) {
    if (helper.offset[i] !== (w[i] & 1)) { same = false; break; }
  }
  assert.equal(same, false);
});

test('柱4/7合流: 生体から再生した鍵で証明書を open できる', () => {
  const w = feature(256, 11);
  const { key, helper } = gen(w, 'palm');
  const issuerSecret = key.toString('hex'); // 生体由来の鍵を発行者秘密に
  const cord = seal('手のひらで結ぶ証明書', issuerSecret, 'cert');

  // 後日、少し曖昧な手相を再提示しても同じ鍵が再生され、open できる
  const reissued = rep(flip(w, 2), helper).toString('hex');
  assert.equal(open(cord, reissued), '手のひらで結ぶ証明書');
});

test('柱4/7合流: 他人の生体では鍵が違い open できない', () => {
  const w = feature(256, 13);
  const { key, helper } = gen(w, 'palm');
  const cord = seal('機密', key.toString('hex'), 'cert');
  const attacker = rep(feature(256, 4242), helper).toString('hex');
  assert.throws(() => open(cord, attacker));
});
