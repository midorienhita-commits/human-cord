// threshold.test.js
// 柱4b「真の閾値署名(FROST 系・単一nonce しきい値 Schnorr・素数体・逐次専用)」の検証。
// 実行: node --test
//
// 3 つの load-bearing 性質を固定する:
//   (1) k-of-n は検証が通る(どの k 片の組でも・k+1 でも)
//   (2) k 未満は通らない — **単独署名者でなく本物の k-1 連合**が 2 通りの偽造戦略で失敗する
//   (3) 改ざん(本文 / z / R)は通らない
// (2)(3) は独立に生成した 2 群で走らせ、群固有のまぐれを排除する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mod,
  modpow,
  lambdaAt0,
  challenge,
  commit,
  combineCommitments,
  partialSign,
  aggregate,
  thresholdSign,
  verifyThreshold,
  generateGroup,
  generateKey,
  splitKey,
} from '../src/threshold.js';

// [1..n] から k 個を選ぶ全組合せ
function kSubsets(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i <= n; i += 1) {
      acc.push(i);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(1, []);
  return out;
}

// ───────────────────────────────────────────────────────────
// (0) 正準テストベクトル(手計算可能な極小群での回帰アンカー)
//     エンコード非依存の値(p,q,g,x,y,shares,λ,R)は実装に関わらず一致しなければならない。
//     c/z は本実装の課題エンコードに固有(=ここに固定)。
// ───────────────────────────────────────────────────────────
test('正準ベクトル: 極小群 p=2039 で全中間値が一致し検証が通る', () => {
  const group = { p: 2039n, q: 1019n, g: 4n };
  assert.equal(modpow(group.g, group.q, group.p), 1n, 'g は位数 q の部分群');

  const x = 137n; // f(X) = 137 + 251 X mod 1019
  const shares = [{ i: 1, s: 388n }, { i: 2, s: 639n }, { i: 3, s: 890n }];
  const y = modpow(group.g, x, group.p);
  assert.equal(y, 542n, 'y = g^x');

  const S = [1, 2];
  assert.equal(lambdaAt0(group, S, 1), 2n);
  assert.equal(lambdaAt0(group, S, 2), 1018n);
  // 相同性: Σ λ_i s_i = x
  assert.equal(mod(lambdaAt0(group, S, 1) * shares[0].s + lambdaAt0(group, S, 2) * shares[1].s, group.q), 137n);

  const r1 = 400n;
  const r2 = 900n;
  const R1 = modpow(group.g, r1, group.p);
  const R2 = modpow(group.g, r2, group.p);
  assert.equal(R1, 361n);
  assert.equal(R2, 86n);
  const R = combineCommitments(group, [R1, R2]);
  assert.equal(R, 461n);

  // 本実装の課題エンコード(長さ前置フレーミング)に固有の値(別実装では c/z だけが変わる)
  assert.equal(challenge(group, R, y, 'canonical-vector'), 252n);
  const p1 = partialSign(group, shares[0], r1, S, R, y, 'canonical-vector');
  const p2 = partialSign(group, shares[1], r2, S, R, y, 'canonical-vector');
  const sig = aggregate(group, [R1, R2], [p1, p2]);
  assert.equal(sig.z, 159n);
  assert.equal(sig.R, 461n);

  assert.equal(verifyThreshold(group, y, 'canonical-vector', sig), true);
  assert.equal(verifyThreshold(group, y, 'tampered', sig), false);
});

// ───────────────────────────────────────────────────────────
// (1) k-of-n は検証が通る(どの k 片の組でも・k+1 でも)
// ───────────────────────────────────────────────────────────
test('(1) k-of-n: 任意の k 片(と k+1 片)の組で署名でき公開検証が通る', () => {
  const group = generateGroup(256);
  const n = 5;
  const k = 3;
  const { y, shares, x } = generateKey(group, n, k);
  const msg = 'CERT-2026-THRESHOLD :: data-erasure attestation';

  // 相同性のサニティ: いくつかの k 部分集合で Σ λ_i s_i = x
  for (const S of [[1, 2, 3], [2, 4, 5], [1, 3, 5]]) {
    const recon = S.reduce(
      (acc, i) => mod(acc + lambdaAt0(group, S, i) * shares[i - 1].s, group.q),
      0n,
    );
    assert.equal(recon, x, `subset ${S} は秘密を補間する`);
  }

  // 全 C(5,3)=10 の k 部分集合 + 一つの k+1 部分集合で署名 → すべて検証 true
  const subsets = kSubsets(n, k);
  subsets.push([1, 2, 3, 4]); // k+1
  assert.equal(subsets.length, 11);
  for (const S of subsets) {
    const parts = S.map((i) => shares[i - 1]);
    const sig = thresholdSign(group, y, S, parts, msg);
    assert.equal(verifyThreshold(group, y, msg, sig), true, `subset ${S} の署名は検証が通る`);
  }
});

// ───────────────────────────────────────────────────────────
// (2) k 未満は通らない — 本物の k-1 連合が 2 戦略で偽造を試みても失敗する
//     (単独署名者は最弱の攻撃者。連合 + full-set λ 戦略まで試すのが本来の基準)
// ───────────────────────────────────────────────────────────
function forge(group, y, message, W) {
  // 攻撃者は自分たちの nonce で R を作り、保有片から組んだ W を秘密のつもりで署名
  const { r, R } = commit(group);
  const c = challenge(group, R, y, message);
  const z = mod(r + c * W, group.q);
  return { sig: { R, z }, c };
}

for (const round of [1, 2]) {
  test(`(2) k 未満の連合は偽造できない(2 戦略・群#${round})`, () => {
    const group = generateGroup(256);
    const n = 5;
    const k = 3;
    const { y, shares, x } = generateKey(group, n, k);
    const msg = 'forge-attempt';

    const T = [1, 2]; // |T| = k-1 = 2 の本物の連合(単独でない)
    const s1 = shares[0].s;
    const s2 = shares[1].s;

    // 戦略A: 自分たちの部分集合 T 上の λ で補間
    const Wa = mod(lambdaAt0(group, T, 1) * s1 + lambdaAt0(group, T, 2) * s2, group.q);
    // 戦略B: full-set {1,2,3} の λ を使うが、欠けている party3 の項 (λ3 s3) は持っていない
    const F = [1, 2, 3];
    const Wb = mod(lambdaAt0(group, F, 1) * s1 + lambdaAt0(group, F, 2) * s2, group.q);

    // 失敗が偶然でなく根本的であること: 連合の組んだ秘密候補は真の x と一致しない
    assert.notEqual(Wa, x, '戦略A の補間値は x と一致しない');
    assert.notEqual(Wb, x, '戦略B の部分和は x と一致しない');

    // どちらの偽造署名も公開検証で false
    assert.equal(verifyThreshold(group, y, msg, forge(group, y, msg, Wa).sig), false, '戦略A 拒否');
    assert.equal(verifyThreshold(group, y, msg, forge(group, y, msg, Wb).sig), false, '戦略B 拒否');

    // 単独署名者(最弱)も当然 false
    const lone = [2];
    const Wl = mod(lambdaAt0(group, lone, 2) * s2, group.q); // λ=1 → s2 そのもの
    assert.notEqual(Wl, x);
    assert.equal(verifyThreshold(group, y, msg, forge(group, y, msg, Wl).sig), false, '単独署名者 拒否');
  });
}

// ───────────────────────────────────────────────────────────
// (3) 改ざんは通らない(本文 / z / R)。独立な 2 群で。
// ───────────────────────────────────────────────────────────
for (const round of [1, 2]) {
  test(`(3) 改ざん(本文/z/R)は検証が通らない(群#${round})`, () => {
    const group = generateGroup(256);
    const { y, shares } = generateKey(group, 5, 3);
    const msg = 'original-message';
    const S = [1, 3, 5];
    const sig = thresholdSign(group, y, S, S.map((i) => shares[i - 1]), msg);

    assert.equal(verifyThreshold(group, y, msg, sig), true, '正規は通る');
    assert.equal(verifyThreshold(group, y, 'original-messagE', sig), false, '本文1文字改ざん → 拒否');
    assert.equal(
      verifyThreshold(group, y, msg, { R: sig.R, z: mod(sig.z + 1n, group.q) }, {}),
      false,
      'z+1 → 拒否',
    );
    assert.equal(
      verifyThreshold(group, y, msg, { R: mod(sig.R * group.g, group.p), z: sig.z }, {}),
      false,
      'R*g → 拒否',
    );
  });
}

// ───────────────────────────────────────────────────────────
// 追加の頑健性
// ───────────────────────────────────────────────────────────
test('別発行者の公開鍵では検証が通らない(鍵コミット)', () => {
  const group = generateGroup(256);
  const a = generateKey(group, 5, 3);
  const b = generateKey(group, 5, 3); // 別の鍵対(同じ群)
  const msg = 'cross-key';
  const S = [1, 2, 3];
  const sig = thresholdSign(group, a.y, S, S.map((i) => a.shares[i - 1]), msg);
  assert.equal(verifyThreshold(group, a.y, msg, sig), true);
  assert.equal(verifyThreshold(group, b.y, msg, sig), false, '別の y では false');
});

test('同じメッセージでも署名ごとに R が変わる(nonce の新鮮さ)', () => {
  const group = generateGroup(256);
  const { y, shares } = generateKey(group, 5, 3);
  const msg = 'same-message';
  const S = [1, 2, 3];
  const sig1 = thresholdSign(group, y, S, S.map((i) => shares[i - 1]), msg);
  const sig2 = thresholdSign(group, y, S, S.map((i) => shares[i - 1]), msg);
  assert.notEqual(sig1.R, sig2.R, 'R は毎回異なる(nonce 再利用なし)');
  assert.equal(verifyThreshold(group, y, msg, sig1), true);
  assert.equal(verifyThreshold(group, y, msg, sig2), true);
});

test('入力衛生: 壊れた署名は例外でなく false を返す', () => {
  const group = generateGroup(256);
  const { y } = generateKey(group, 5, 3);
  assert.equal(verifyThreshold(group, y, 'm', { R: 1n, z: 0n }), false, 'R=1 拒否');
  assert.equal(verifyThreshold(group, y, 'm', { R: group.p, z: 0n }), false, 'R=p 拒否');
  assert.equal(verifyThreshold(group, y, 'm', { R: 5n, z: group.q }), false, 'z=q(範囲外)拒否');
  assert.equal(verifyThreshold(group, y, 'm', { R: 'x', z: 'y' }), false, 'パース不能 拒否');
});

test('分散実体: commit/partialSign/aggregate を個別に呼んでも検証が通る(片は集約されない)', () => {
  const group = generateGroup(256);
  const { y, shares } = generateKey(group, 3, 2);
  const msg = 'distributed-path';
  const S = [1, 3];
  // 各拠点が独立に commit(r は各自が秘匿)
  const c1 = commit(group);
  const c3 = commit(group);
  const R = combineCommitments(group, [c1.R, c3.R]);
  // 各拠点が部分応答(s_i はネットワークに出さない)
  const p1 = partialSign(group, shares[0], c1.r, S, R, y, msg);
  const p3 = partialSign(group, shares[2], c3.r, S, R, y, msg);
  const sig = aggregate(group, [c1.R, c3.R], [p1, p3]);
  assert.equal(verifyThreshold(group, y, msg, sig), true);
});

// ───────────────────────────────────────────────────────────
// 敵対的レビューで見つかった抜けの回帰(これらが無いと「公開鍵だけで検証」の主張が嘘になる)
// ───────────────────────────────────────────────────────────
test('レビュー修正: 恒等鍵 y=1 / 位数違い y=p-1 はゼロ片で偽造できない(y 入力衛生)', () => {
  const group = generateGroup(256);
  const r = 777n;
  const R = modpow(group.g, r, group.p);
  // y=1 だと g^z==R·y^c が g^z==R に潰れ、片なしで満たせてしまう → 必ず弾く
  assert.equal(verifyThreshold(group, 1n, 'anything', { R, z: r }), false);
  assert.equal(verifyThreshold(group, group.p - 1n, 'anything', { R, z: r }), false);
});

test('レビュー修正: 恒等鍵を生む秘密(x≡0 mod q)は発行を拒否する', () => {
  const group = generateGroup(256);
  assert.throws(() => generateKey(group, 3, 2, { secret: 0n }));
  assert.throws(() => generateKey(group, 3, 2, { secret: group.q })); // q ≡ 0 mod q → y=1
});

test('レビュー修正: k=1(閾値なし=全片が秘密)は拒否される', () => {
  const group = generateGroup(256);
  assert.throws(() => generateKey(group, 3, 1));
  assert.throws(() => splitKey(group, 5n, 3, 1));
});

test('レビュー修正: メッセージは string/Buffer のみ — 数値/object の取り違えを断つ', () => {
  const group = generateGroup(256);
  const { y, shares } = generateKey(group, 3, 2);
  // 暗黙 String 化(123≡"123"、object≡"[object Object]")による別文書の同一署名通過を防ぐ
  assert.throws(() => thresholdSign(group, y, [1, 2], [shares[0], shares[1]], 123), TypeError);
  assert.throws(() => challenge(group, 5n, 7n, { a: 1 }), TypeError);
  // 別文字列は別の課題(衝突しない)
  assert.notEqual(challenge(group, 5n, 7n, 'hello'), challenge(group, 5n, 7n, 'world'));
  // Buffer は通る
  const sig = thresholdSign(group, y, [1, 2], [shares[0], shares[1]], Buffer.from('msg'));
  assert.equal(verifyThreshold(group, y, Buffer.from('msg'), sig), true);
});

test('レビュー修正: 重複添字の S は黙って誤らず例外を投げる(fail-closed → fail-loud)', () => {
  const group = generateGroup(256);
  const { y, shares } = generateKey(group, 3, 2);
  assert.throws(() => thresholdSign(group, y, [1, 1, 2], [shares[0], shares[1]], 'm'));
  assert.throws(() => partialSign(group, shares[0], 5n, [1, 1, 2], 10n, y, 'm'));
});
