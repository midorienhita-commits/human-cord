// simmons.test.js
// 柱6-ii「真の Simmons 潜在チャネル(署名 nonce に covert を埋める・素数体 DSA)」の検証。
// 実行: node --test
//
// 定義的性質を固定する:
//   (1) 公開検証は普通に通る(看守には潜在チャネルが見えない)
//   (2) 鍵保持者(x + subKey)だけが covert を正確に復元・鍵違いは null
//   (3) 改ざんは公開検証で弾かれる
//   (4) **看守 undetectability**: 潜在署名の nonce k は一様・r 分布は正直署名と区別不能
//   (5) **nonce 再利用は署名鍵 x を漏らす**(DSA/Schnorr 共通の致命傷=正直に固定)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  generateGroup,
  generateSigningKey,
  sign,
  signSalted,
  signWithNonce,
  verify,
  recoverNonce,
  signWithSubliminal,
  recoverSubliminal,
  subliminalCapacityBytes,
  qByteLen,
  hashToScalar,
} from '../src/simmons.js';
import { mod, invMod, modpow } from '../src/threshold.js';

// ───────────────────────────────────────────────────────────
// (0) 正準ベクトル(固定群 + 固定 x/subKey/sigSalt で決定的)
// ───────────────────────────────────────────────────────────
test('正準ベクトル: 固定入力で (r,s) が再現し、公開検証が通り、covert を復元できる', () => {
  const group = {
    p: 309593495805012931101933053251786035863n,
    q: 154796747902506465550966526625893017931n,
    g: 4n,
  };
  const x = 22685491128062564230891640495451214097n;
  const subKey = Buffer.from('a1'.repeat(32), 'hex');
  const y = modpow(group.g, x, group.p);

  const { message, sig } = signWithSubliminal(group, x, 'CERT#42 GreenOffice', 'GO', subKey, {
    sigSalt: '4815a08ad3885bbbc4aa50c5ef018996',
  });
  assert.equal(message, 'CERT#42 GreenOffice|salt=4815a08ad3885bbbc4aa50c5ef018996');
  assert.equal(sig.r, 91396327405555019679118065937636902903n);
  assert.equal(sig.s, 120070879798093694876105331048653962939n);
  assert.equal(verify(group, y, message, sig), true);
  assert.equal(recoverSubliminal(group, x, message, sig, subKey), 'GO');
});

// ───────────────────────────────────────────────────────────
// (1)(2) 往復・鍵違い
// ───────────────────────────────────────────────────────────
test('(1)(2) 潜在署名は公開検証が通り、鍵保持者だけが covert を正確に復元、鍵違いは null', () => {
  const group = generateGroup(256);
  const { x, y } = generateSigningKey(group);
  const subKey = Buffer.from('5f09b90642412c83192474c4b45d7faebc92522f55331a617c8c99a22f19b2ce', 'hex');
  const covert = 'AUDIT:HQ-only memo 2026'; // 23B <= 容量 26B(256bit 群)

  const { message, sig } = signWithSubliminal(group, x, 'データ消去証明書 INTK-20260609', covert, subKey);
  // 看守(公開鍵のみ)には普通の署名に見える
  assert.equal(verify(group, y, message, sig), true);
  // 鍵保持者だけが読める
  assert.equal(recoverSubliminal(group, x, message, sig, subKey), covert);
  // 鍵違いは null(MAC が弾く)
  assert.equal(recoverSubliminal(group, x, message, sig, Buffer.alloc(32, 7)), null, '別 subKey');
  assert.equal(recoverSubliminal(group, mod(x + 1n, group.q), message, sig, subKey), null, '別 x');
});

test('正直署名は公開検証が通り、covert は復元されない(salt 無し)', () => {
  const group = generateGroup(256);
  const { x, y } = generateSigningKey(group);
  const subKey = Buffer.alloc(32, 9);
  const m = 'plain attestation no channel';
  const sig = sign(group, x, m);
  assert.equal(verify(group, y, m, sig), true);
  assert.equal(recoverSubliminal(group, x, m, sig, subKey), null);
});

test('本文レベル undetectability: cover(signSalted)は covert と同形式・裏は復元されない', () => {
  // 看守は本文で裏の有無を区別できない(レビューで見つかった salt-suffix distinguisher を塞ぐ)。
  const group = generateGroup(256);
  const { x, y } = generateSigningKey(group);
  const subKey = Buffer.alloc(32, 0x33);
  const covert = signWithSubliminal(group, x, 'attestation', 'secret', subKey);
  const cover = signSalted(group, x, 'attestation');
  const fmt = /\|salt=[0-9a-f]{32}$/; // 同一形式 = 本文では区別不能
  assert.match(covert.message, fmt);
  assert.match(cover.message, fmt);
  assert.equal(verify(group, y, covert.message, covert.sig), true);
  assert.equal(verify(group, y, cover.message, cover.sig), true);
  // cover(裏なし)から covert を読もうとしても null(MAC が弾く)
  assert.equal(recoverSubliminal(group, x, cover.message, cover.sig, subKey), null);
});

// ───────────────────────────────────────────────────────────
// (3) 改ざんは公開検証で弾かれる
// ───────────────────────────────────────────────────────────
test('(3) 本文/署名スカラの改ざんは公開検証が false', () => {
  const group = generateGroup(256);
  const { x, y } = generateSigningKey(group);
  const subKey = Buffer.alloc(32, 3);
  const { message, sig } = signWithSubliminal(group, x, 'cert body', 'hi', subKey);
  assert.equal(verify(group, y, message, sig), true);
  assert.equal(verify(group, y, message + 'X', sig), false, '本文改ざん');
  assert.equal(verify(group, y, message, { r: mod(sig.r + 1n, group.q), s: sig.s }), false, 'r 改ざん');
  assert.equal(verify(group, y, message, { r: sig.r, s: mod(sig.s + 1n, group.q) }), false, 's 改ざん');
});

// ───────────────────────────────────────────────────────────
// (4) 看守 undetectability(統計): nonce k は一様・r は正直署名と区別不能
//     ※ フレーキー回避のため非常に緩い上限(一様なら chi2≈15、偏れば数百〜)。
// ───────────────────────────────────────────────────────────
test('(4) 潜在署名の nonce k は一様・r 分布は正直署名と区別不能(看守に検出されない)', () => {
  const group = generateGroup(256);
  const { x } = generateSigningKey(group);
  const subKey = Buffer.alloc(32, 0x5a);
  const q = group.q;
  const N = 2000;
  const B = 16;
  const bucket = (v) => Number((v * BigInt(B)) / q);
  const chi2 = (counts) => counts.reduce((a, c) => a + ((c - N / B) ** 2) / (N / B), 0);
  const sk = new Array(B).fill(0);
  const sr = new Array(B).fill(0);
  const hr = new Array(B).fill(0);
  for (let i = 0; i < N; i += 1) {
    const r = signWithSubliminal(group, x, `sub-${i}`, 'x', subKey);
    sk[bucket(recoverNonce(group, x, r.message, r.sig))] += 1;
    sr[bucket(r.sig.r)] += 1;
    hr[bucket(sign(group, x, `honest-${i}`).r)] += 1;
  }
  // 一様なら chi2 は df=15 の平均 15 付近。偏った構成(mod-q バイアス等)なら数百以上。
  // 60 は超緩い上限(一様が超える確率 ~3e-8)= 非フレーキーかつ粗バイアスは確実に捕捉。
  assert.ok(chi2(sk) < 60, `subliminal k 一様 (chi2=${chi2(sk).toFixed(1)})`);
  assert.ok(chi2(sr) < 60, `subliminal r 一様 (chi2=${chi2(sr).toFixed(1)})`);
  assert.ok(chi2(hr) < 60, `honest r 一様 (chi2=${chi2(hr).toFixed(1)})`);
});

// ───────────────────────────────────────────────────────────
// (5) nonce 再利用は署名鍵 x を漏らす(正直な限界を回帰で固定)
// ───────────────────────────────────────────────────────────
test('(5) 同じ nonce で別メッセージ2通に署名すると x が漏れる(再利用厳禁の実証)', () => {
  const group = generateGroup(256);
  const { x } = generateSigningKey(group);
  const k = recoverNonce(group, x, 'seed', sign(group, x, 'seed')); // 適当な有効 nonce を1つ得る
  const mA = 'message-A';
  const mB = 'message-B';
  const sA = signWithNonce(group, x, mA, k);
  const sB = signWithNonce(group, x, mB, k);
  assert.equal(sA.r, sB.r, '同じ k → 同じ r');
  const eA = hashToScalar(mA, group.q);
  const eB = hashToScalar(mB, group.q);
  const kLeak = mod((eA - eB) * invMod(mod(sA.s - sB.s, group.q), group.q), group.q);
  const xLeak = mod(mod(sA.s * kLeak - eA, group.q) * invMod(sA.r, group.q), group.q);
  assert.equal(xLeak, x, 'nonce 再利用から署名鍵 x が完全復元される');
});

// ───────────────────────────────────────────────────────────
// 容量境界
// ───────────────────────────────────────────────────────────
test('covert が容量(qByteLen-6)を超えると throw', () => {
  const group = generateGroup(256);
  const { x } = generateSigningKey(group);
  const cap = subliminalCapacityBytes(group.q);
  assert.equal(cap, qByteLen(group.q) - 6);
  const tooLong = 'a'.repeat(cap + 1);
  assert.throws(() => signWithSubliminal(group, x, 'm', tooLong, Buffer.alloc(32)));
  // 容量ちょうどは通る
  const ok = 'a'.repeat(cap);
  const { message, sig } = signWithSubliminal(group, x, 'm', ok, Buffer.alloc(32, 1));
  assert.equal(recoverSubliminal(group, x, message, sig, Buffer.alloc(32, 1)), ok);
});
