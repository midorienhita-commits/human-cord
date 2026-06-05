// challenge.test.js
// 柱5/柱9「対話チャレンジ応答 liveness」の振る舞い検証。
// 設計メモ: src/challenge.js(livecord.js の「正直な限界」を閉じる厳密版)。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueChallenge, respond, ChallengeVerifier } from '../src/challenge.js';

const SECRET = 'issuer-private-half-xyz';
const BASE = 'site-tokyo';
const T0 = 1_000_000; // チャレンジ発行時刻(ms)

// ① 正規フロー: 自分のチャレンジに束縛された新鮮な応答は live ───────────

test('柱5/9 challenge: 自分のチャレンジに束縛された新鮮な応答を live と判定する', () => {
  const V = new ChallengeVerifier(SECRET, BASE);
  const ch = V.issue(T0);
  const res = respond(ch, '東京第二DC 在席', SECRET, BASE, { clock: T0 + 200 }); // 200ms 後に応答
  const v = V.verify(res, T0 + 400);                                            // さらに 200ms 後に受信
  assert.equal(v.verdict, 'live');
  assert.equal(v.msg, '東京第二DC 在席');
  assert.equal(v.nonce, ch.nonce);
});

// ② 別の検証者への即時リプレイ = mismatch(本モジュールの主眼)──────────

test('柱5/9 challenge: 録画を別の検証者に即時リプレイしても mismatch で弾く', () => {
  // 検証者 A のチャレンジに対する正規応答を、検証者 B(別 nonce)へ流す。
  const A = new ChallengeVerifier(SECRET, BASE);
  const B = new ChallengeVerifier(SECRET, BASE);
  const chA = A.issue(T0);
  const res = respond(chA, '在席', SECRET, BASE, { clock: T0 + 100 });
  B.issue(T0); // B も自分のチャレンジを出している(別 nonce)
  // B から見ると res は B が出していない nonce(=A の nonce)に束縛 → mismatch。
  const v = B.verify(res, T0 + 200);
  assert.equal(v.verdict, 'mismatch');
  // 一方 A から見れば同じ res は live(束縛先が一致)。
  assert.equal(A.verify(res, T0 + 200).verdict, 'live');
});

// ③ 厳密リプレイ / チャレンジ一回限り ───────────────────────────────

test('柱5/9 challenge: 同一応答の再提示は replay、消費済みチャレンジへの別応答は mismatch', () => {
  const V = new ChallengeVerifier(SECRET, BASE);
  const ch = V.issue(T0);
  const res1 = respond(ch, '在席', SECRET, BASE, { clock: T0 + 100 });
  assert.equal(V.verify(res1, T0 + 150).verdict, 'live'); // 受理 → nonce 消費・tip seen
  assert.equal(V.verify(res1, T0 + 160).verdict, 'replay'); // 同一 tip の再提示
  const res2 = respond(ch, '在席', SECRET, BASE, { clock: T0 + 200 }); // 同じ nonce への別応答
  assert.equal(V.verify(res2, T0 + 250).verdict, 'mismatch'); // チャレンジは消費済み(一回限り)
});

// ④ 鮮度: 窓外の応答は stale(後日再生)─────────────────────────────

test('柱5/9 challenge: 鮮度窓を超えた応答は stale(後日再生を弾く)', () => {
  const V = new ChallengeVerifier(SECRET, BASE, { windowMs: 1000 });
  const ch = V.issue(T0);
  const res = respond(ch, '在席', SECRET, BASE, { clock: T0 + 100 });
  const v = V.verify(res, T0 + 100 + 5000); // 5 秒後に受信 = 窓外
  assert.equal(v.verdict, 'stale');
});

// ⑤ 真正性: context は一致しても中身改ざん/別発行者は tamper ──────────

test('柱5/9 challenge: 束縛 context は保ったまま中身を改ざんすると tamper', () => {
  const V = new ChallengeVerifier(SECRET, BASE);
  const ch = V.issue(T0);
  const res = respond(ch, '在席', SECRET, BASE, { clock: T0 + 100 });
  res.eggs[0].ct[0] ^= 0xff; // context(束縛)はそのまま、暗号文を 1 バイト反転
  const v = V.verify(res, T0 + 150);
  assert.equal(v.verdict, 'tamper');
});

test('柱5/9 challenge: 別の発行者秘密で封じた応答は tamper(束縛 nonce は一致でも)', () => {
  const V = new ChallengeVerifier(SECRET, BASE);
  const ch = V.issue(T0);
  const res = respond(ch, '在席', 'wrong-issuer-secret', BASE, { clock: T0 + 100 }); // 別秘密
  const v = V.verify(res, T0 + 150);
  assert.equal(v.verdict, 'tamper');
});

// ⑥ 事前計算の疑い: チャレンジ発行より前の epoch は precomputed ──────────

test('柱5/9 challenge: チャレンジ発行より前の epoch を主張する応答は precomputed', () => {
  const V = new ChallengeVerifier(SECRET, BASE);
  const ch = V.issue(T0);
  const res = respond(ch, '在席', SECRET, BASE, { clock: T0 - 1000 }); // 発行前に作ったと主張
  const v = V.verify(res, T0 + 100);
  assert.equal(v.verdict, 'precomputed');
});

// ⑦ 基本不変条件 ────────────────────────────────────────────────────

test('柱5/9 challenge: issueChallenge は毎回異なる nonce / clock 必須', () => {
  assert.notEqual(issueChallenge(T0).nonce, issueChallenge(T0).nonce);
  assert.equal(issueChallenge(T0).issuedAt, T0);
  assert.throws(() => issueChallenge(), Error);
});

test('柱5/9 challenge: 別 baseContext への応答は mismatch(文脈の取り違え)', () => {
  const V = new ChallengeVerifier(SECRET, 'site-osaka'); // 大阪の検証者
  const ch = V.issue(T0);
  const res = respond(ch, '在席', SECRET, 'site-tokyo', { clock: T0 + 100 }); // 東京の文脈で応答
  assert.equal(V.verify(res, T0 + 150).verdict, 'mismatch');
});
