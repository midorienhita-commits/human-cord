// pubkey.test.js
// 柱4 公開鍵検証層(Ed25519)の振る舞い検証。
// 「発行者の公開鍵だけでオフライン検証(秘密不要)」を担保。実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIssuerKeypair, signStatement, verifyStatement } from '../src/pubkey.js';

const FACTS = { docId: 'CASE-2026-0042', kind: 4, devices: 12, method: 'Blancco', site: 'LOG' };

test('公開検証: 発行者公開鍵だけで真贋確認(秘密不要・オフライン)', () => {
  const { privateKey, publicKey } = generateIssuerKeypair();
  const signed = signStatement(FACTS, privateKey, { docId: FACTS.docId, issuedAt: '2026-05-30' });
  // 検証側は公開鍵だけ(秘密鍵を一切使わない)
  const r = verifyStatement(signed, publicKey);
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts, FACTS);
  assert.equal(r.docId, FACTS.docId);
});

test('公開検証: 別の公開鍵では検証失敗(別発行者)', () => {
  const a = generateIssuerKeypair();
  const b = generateIssuerKeypair();
  const signed = signStatement(FACTS, a.privateKey, { docId: FACTS.docId });
  const r = verifyStatement(signed, b.publicKey); // 別人の公開鍵
  assert.equal(r.ok, false);
});

test('公開検証: 事実を改ざんすると失敗', () => {
  const { privateKey, publicKey } = generateIssuerKeypair();
  const signed = signStatement(FACTS, privateKey, { docId: FACTS.docId });
  signed.facts = { ...FACTS, devices: 9999 }; // 署名後に改ざん
  const r = verifyStatement(signed, publicKey);
  assert.equal(r.ok, false);
});

test('公開検証: docId を差し替えると失敗', () => {
  const { privateKey, publicKey } = generateIssuerKeypair();
  const signed = signStatement(FACTS, privateKey, { docId: 'CASE-1' });
  signed.docId = 'CASE-9';
  assert.equal(verifyStatement(signed, publicKey).ok, false);
});

test('公開検証: 鍵順非依存(facts のキー順が違っても検証できる)', () => {
  const { privateKey, publicKey } = generateIssuerKeypair();
  const signed = signStatement({ a: 1, b: 2 }, privateKey, { docId: 'X' });
  // JSON 往復でキー順が変わっても OK(stableStringify 正準化)
  const reordered = { sig: signed.sig, alg: signed.alg, issuedAt: signed.issuedAt, docId: signed.docId, facts: { b: 2, a: 1 } };
  assert.equal(verifyStatement(reordered, publicKey).ok, true);
});

test('公開検証: JSON 往復しても検証できる(配布物として運べる)', () => {
  const { privateKey, publicKey } = generateIssuerKeypair();
  const signed = signStatement(FACTS, privateKey, { docId: FACTS.docId, issuedAt: '2026-05-30' });
  const roundTripped = JSON.parse(JSON.stringify(signed));
  assert.equal(verifyStatement(roundTripped, publicKey).ok, true);
});
