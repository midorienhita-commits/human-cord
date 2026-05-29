// tally.test.js
// 柱3「割符演算(+/-)」の振る舞い検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/cord.js';
import { combine, verifyTally } from '../src/tally.js';

const SECRET = 'issuer-private-half-xyz';
const OTHER = 'different-issuer-secret';

test('柱3 +: 同一発行者・同一案件の片割れは統合(merged = a + b)', () => {
  const a = seal('消去記録:HDD-001 完了 ', SECRET, 'case', { docId: 'CASE-0042' });
  const b = seal('破砕記録:SSD-002 完了', SECRET, 'case', { docId: 'CASE-0042' });
  const r = combine(a, b, SECRET);
  assert.equal(r.op, '+');
  assert.equal(r.matched, true);
  assert.equal(r.docId, 'CASE-0042');
  assert.equal(r.merged, '消去記録:HDD-001 完了 破砕記録:SSD-002 完了');
});

test('柱3 -: 同一発行者でも別案件(docId 不一致)は差分発火', () => {
  const a = seal('case A payload', SECRET, 'case', { docId: 'CASE-0042' });
  const b = seal('case B payload', SECRET, 'case', { docId: 'CASE-9999' });
  const r = combine(a, b, SECRET);
  assert.equal(r.op, '-');
  assert.equal(r.matched, false);
  assert.match(r.diff.reason, /別案件/);
  assert.equal(r.diff.docIdA, 'CASE-0042');
  assert.equal(r.diff.docIdB, 'CASE-9999');
});

test('柱3 -: 別発行者の cord は通行手形が噛み合わず差分発火', () => {
  const a = seal('genuine', SECRET, 'case', { docId: 'CASE-0042' });
  const b = seal('forged', OTHER, 'case', { docId: 'CASE-0042' });
  const r = combine(a, b, SECRET);
  assert.equal(r.op, '-');
  assert.equal(r.diff.tallyMatchA, true);
  assert.equal(r.diff.tallyMatchB, false); // B は別発行者なので不正
});

test('柱3 -: 改ざんされた cord は統合できない(失敗境界と連動)', () => {
  const a = seal('integrity A', SECRET, 'case', { docId: 'CASE-0042' });
  const b = seal('integrity B', SECRET, 'case', { docId: 'CASE-0042' });
  b.eggs[0].ct[0] ^= 0xff; // B を改ざん
  const r = combine(a, b, SECRET);
  assert.equal(r.op, '-');
  assert.equal(r.diff.tallyMatchB, false);
});

test('verifyTally: 正しい発行者秘密で true、誤りで false', () => {
  const cord = seal('verify me', SECRET, 'case', { docId: 'CASE-0042' });
  assert.equal(verifyTally(cord, SECRET), true);
  assert.equal(verifyTally(cord, OTHER), false);
});

test('verifyTally: docId / tally の無い cord は通行手形なしとして false', () => {
  const plain = seal('no docId cord', SECRET, 'case'); // docId 未指定 → tally なし
  assert.equal(plain.tally, undefined);
  assert.equal(verifyTally(plain, SECRET), false);
});

test('柱3 +: 統合は順序を保持する(A→B)', () => {
  const a = seal('AAA', SECRET, 'c', { docId: 'D1' });
  const b = seal('BBB', SECRET, 'c', { docId: 'D1' });
  assert.equal(combine(a, b, SECRET).merged, 'AAABBB');
  assert.equal(combine(b, a, SECRET).merged, 'BBBAAA');
});
