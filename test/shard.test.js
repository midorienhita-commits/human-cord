// shard.test.js
// 柱4深化「Shamir 秘密分散による割符の情報理論的分割」の検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { split, combine } from '../src/shard.js';
import { seal, open } from '../src/cord.js';

const SECRET = Buffer.from('issuer-private-half-32byte-secretX'); // 任意長

test('Shamir: 閾値ちょうどの片で秘密を復元', () => {
  const shares = split(SECRET, 5, 3);
  const got = combine([shares[0], shares[2], shares[4]]);
  assert.equal(got.toString(), SECRET.toString());
});

test('Shamir: 閾値超の片でも復元できる', () => {
  const shares = split(SECRET, 5, 3);
  const got = combine(shares); // 5 片全部
  assert.equal(got.toString(), SECRET.toString());
});

test('Shamir: どの k 片の組み合わせでも同じ秘密になる', () => {
  const shares = split(SECRET, 5, 3);
  const a = combine([shares[0], shares[1], shares[2]]).toString('hex');
  const b = combine([shares[1], shares[3], shares[4]]).toString('hex');
  assert.equal(a, b);
});

test('Shamir 情報理論的安全: k-1 片では復元できない(秘密と一致しない)', () => {
  const shares = split(SECRET, 5, 3);
  const partial = combine([shares[0], shares[1]]); // 2 片(閾値未満)
  assert.notEqual(partial.toString(), SECRET.toString());
});

test('Shamir: 分割のたびに片は変わるが復元値は同じ(ランダム係数)', () => {
  const s1 = split(SECRET, 4, 2);
  const s2 = split(SECRET, 4, 2);
  // 同じ x=1 の片でも y は異なる(係数がランダム)
  assert.notEqual(s1[0].y.toString('hex'), s2[0].y.toString('hex'));
  // しかし復元値はどちらも元の秘密
  assert.equal(combine([s1[0], s1[1]]).toString(), SECRET.toString());
  assert.equal(combine([s2[2], s2[3]]).toString(), SECRET.toString());
});

test('柱4深化: 片割れを Shamir で分割 → k 片で復元した秘密で open が通る', () => {
  const issuerSecret = 'green-office-issuer-2026';
  const cord = seal('データ消去証明書 本文', issuerSecret, 'cert');
  // 発行者秘密を 5 片に分割(閾値 3)
  const shares = split(Buffer.from(issuerSecret), 5, 3);
  // 3 片を集めて秘密を復元
  const recovered = combine([shares[1], shares[2], shares[4]]).toString();
  assert.equal(recovered, issuerSecret);
  // 復元した秘密で実際に open できる
  assert.equal(open(cord, recovered), 'データ消去証明書 本文');
});

test('柱4深化: 閾値未満で復元した秘密では open できない(計算と無関係に不可能)', () => {
  const issuerSecret = 'green-office-issuer-2026';
  const cord = seal('機密本文', issuerSecret, 'cert');
  const shares = split(Buffer.from(issuerSecret), 5, 3);
  const wrong = combine([shares[0], shares[1]]).toString(); // 2 片(閾値未満)
  assert.throws(() => open(cord, wrong));
});

test('Shamir: バイナリ(全バイト値)を正しく往復', () => {
  const bin = Buffer.from([0, 1, 2, 127, 128, 200, 254, 255]);
  const shares = split(bin, 3, 2);
  assert.equal(combine([shares[0], shares[2]]).toString('hex'), bin.toString('hex'));
});
