// cord.test.js
// 柱10「失敗境界の自己観測抵抗」を中心とした POC の振る舞い検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';

const SECRET = 'issuer-private-half-xyz';

test('正常系: seal → open で原文を完全復元', () => {
  const pt = 'CERTIFICATE-ABCDEF-0123456789-GHIJKL';
  const cord = seal(pt, SECRET);
  assert.equal(open(cord, SECRET), pt);
});

test('空文字列でも往復できる', () => {
  const cord = seal('', SECRET);
  assert.equal(open(cord, SECRET), '');
});

test('マルチバイト(日本語)を往復できる', () => {
  const pt = 'データ消去証明書 2026年5月29日 ABC商事 御中';
  const cord = seal(pt, SECRET);
  assert.equal(open(cord, SECRET), pt);
});

test('柱4: 発行者秘密が違うと開けない(片割れ性)', () => {
  const cord = seal('hello world secret payload', SECRET);
  assert.throws(() => open(cord, 'wrong-secret'), CordTamper);
});

test('柱10: 卵の本体(ct)を 1bit 改ざんすると検知し、平文は漏れない', () => {
  const cord = seal('tamper me please right now ok', SECRET);
  cord.eggs[1].ct[0] ^= 0xff;
  assert.throws(
    () => open(cord, SECRET),
    (err) => {
      assert.ok(err instanceof CordTamper);
      assert.equal(typeof err.seq, 'number'); // 露出は seq(型)のみ
      assert.ok(!('key' in err) && !('plaintext' in err)); // 核は載らない
      return true;
    },
  );
});

test('柱10: ハッシュ鎖の prevHash を差し替えると鎖断絶を検知', () => {
  const cord = seal('chain integrity must hold tight', SECRET);
  cord.eggs[1].prevHash = Buffer.alloc(32, 9);
  assert.throws(() => open(cord, SECRET), CordTamper);
});

test('柱10: 卵の順序入れ替えを検知(AAD に seq を含むため)', () => {
  const cord = seal('order zero / order one / order two', SECRET);
  [cord.eggs[0], cord.eggs[1]] = [cord.eggs[1], cord.eggs[0]];
  assert.throws(() => open(cord, SECRET), CordTamper);
});

test('柱5: 同一平文チャンクでも卵ごとに暗号文が異なる(ratchet)', () => {
  // 16 文字 'A' × 2 卵 → 同じ平文チャンクだが ct は不一致
  const cord = seal('A'.repeat(32), SECRET, 'ctx', { chunkSize: 16 });
  assert.notEqual(cord.eggs[0].ct.toString('hex'), cord.eggs[1].ct.toString('hex'));
});

test('観測抵抗: context が違えば同一入力でも別の鎖になる', () => {
  const a = seal('same input string here', SECRET, 'ctx-a');
  const b = seal('same input string here', SECRET, 'ctx-b');
  assert.notEqual(a.eggs[0].ct.toString('hex'), b.eggs[0].ct.toString('hex'));
});

test('柱2: 風景(surface)は目玉文字が置換され、検証には影響しない', () => {
  const pt = 'ABODES'; // a,o,e,s が目玉文字
  const cord = seal(pt, SECRET);
  assert.notEqual(cord.surface, pt); // 風景化されている
  assert.equal(open(cord, SECRET), pt); // surface を壊しても本体は別途復元
  cord.surface = 'GARBAGE';
  assert.equal(open(cord, SECRET), pt);
});
