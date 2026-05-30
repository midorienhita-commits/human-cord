// ecc.test.js
// 柱7 物理層: Reed-Solomon 誤り訂正の正当性検証。
// 訂正は正確さが命なので、ランダム誤り注入の fuzz で「訂正能力内なら必ず厳密復元」を担保。
// 決定的再現のため seeded PRNG を使う。実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode, encodeBlocks, decodeBlocks, RsError } from '../src/ecc.js';

// 決定的な擬似乱数(LCG)。テストの再現性のため Math.random を使わない。
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}
function randBytes(rng, n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = rng() & 0xff;
  return b;
}
// distinct な位置に t 個の誤り(必ず値を変える)を注入する。
function injectErrors(rng, buf, t) {
  const out = Uint8Array.from(buf);
  const positions = new Set();
  while (positions.size < t) positions.add(rng() % out.length);
  for (const p of positions) {
    let v = rng() & 0xff;
    if (v === out[p]) v = (v + 1) & 0xff; // 必ず変化させる
    out[p] = v;
  }
  return out;
}

test('RS 単一ブロック: 誤り無しで厳密復元(corrected=0)', () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5, 250, 0, 255]);
  const code = rsEncode(data, 8);
  assert.equal(code.length, data.length + 8);
  const { data: back, corrected } = rsDecode(code, 8);
  assert.equal(corrected, 0);
  assert.deepEqual(Array.from(back), Array.from(data));
});

test('RS 単一ブロック fuzz: 訂正能力内(floor(nsym/2))なら必ず厳密復元', () => {
  const rng = lcg(20260530);
  let trials = 0;
  for (let trial = 0; trial < 400; trial++) {
    const nsym = 4 + (rng() % 29); // 4..32
    const cap = Math.floor(nsym / 2);
    const dataLen = 1 + (rng() % (255 - nsym)); // 1..(255-nsym)
    const data = randBytes(rng, dataLen);
    const code = rsEncode(data, nsym);
    const t = rng() % (cap + 1); // 0..cap
    const corrupted = injectErrors(rng, code, t);
    const { data: back } = rsDecode(corrupted, nsym);
    assert.deepEqual(Array.from(back), Array.from(data), `nsym=${nsym} len=${dataLen} t=${t}`);
    trials++;
  }
  assert.ok(trials === 400);
});

test('RS チャンク化: cord 大の data を符号化→ブロック横断の誤りを訂正', () => {
  const rng = lcg(42);
  const data = randBytes(rng, 1504); // 実 cord JSON 相当
  const encoded = encodeBlocks(data, { nsym: 32, k: 223 });
  assert.equal(encoded.length % 255, 0);

  // 各 255 ブロックに最大 16 誤り(=訂正能力)を散らす
  const blockSize = 255;
  const corrupted = Buffer.from(encoded);
  for (let b = 0; b < encoded.length / blockSize; b++) {
    const block = corrupted.subarray(b * blockSize, b * blockSize + blockSize);
    const bad = injectErrors(rng, block, 16);
    bad.forEach((v, i) => { block[i] = v; });
  }
  const { data: back, corrected } = decodeBlocks(corrupted, { nsym: 32, k: 223 });
  assert.deepEqual(Array.from(back), Array.from(data));
  assert.ok(corrected > 0);
});

test('RS チャンク化: バースト誤り(連続 12 バイト)を訂正', () => {
  const rng = lcg(7);
  const data = randBytes(rng, 600);
  const encoded = encodeBlocks(data, { nsym: 32, k: 223 });
  const corrupted = Buffer.from(encoded);
  for (let i = 100; i < 112; i++) corrupted[i] ^= 0xa5; // 12 連続バイトを破壊
  const { data: back } = decodeBlocks(corrupted, { nsym: 32, k: 223 });
  assert.deepEqual(Array.from(back), Array.from(data));
});

test('RS: 訂正能力を超える誤りは訂正成功を主張しない(throw か別値)', () => {
  // nsym=4 → 訂正 2。3 誤りを入れる。
  const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
  const code = Uint8Array.from(rsEncode(data, 4));
  code[0] ^= 0xff; code[3] ^= 0xff; code[6] ^= 0xff;
  let threw = false;
  let recovered = null;
  try {
    recovered = rsDecode(code, 4).data;
  } catch (e) {
    threw = true;
    assert.ok(e instanceof RsError);
  }
  // 能力超過では「厳密復元を保証しない」。throw するか、復元しても上位の checksum で弾ける。
  if (!threw) assert.notDeepEqual(Array.from(recovered), Array.from(data));
});
