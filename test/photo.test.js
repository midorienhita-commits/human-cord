// photo.test.js
// 柱7「視覚担体のカメラ写真アダプタ(finder + 透視補正)」の振る舞い検証。
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4 / §7
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, PhotoError } from '../src/photo.js';
import { encodePng } from '../src/image.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const TEXT = 'CERT-2026-0603 / 機器3台 / Blancco 完全消去';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function freshCord(text = TEXT, ctx = 'photo') {
  return seal(text, SECRET, ctx, { axes: AXES });
}
function shoot(cord, opts) {
  const { png } = renderScannable(cord);
  return scanPhoto(simulatePhoto(png, opts));
}

// ① finder 付き担体 ─────────────────────────────────────────────

test('柱7 photo: renderScannable は finder 付き実 PNG を出す', () => {
  const { png, modules, total, side } = renderScannable(freshCord());
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  assert.ok(modules > 0);
  assert.equal(total, modules + 18); // データ + 四辺 BORDER(=FINDER7+GAP2=9)×2
  assert.equal(side, (total + 8) * 4); // + 静寂帯(QUIET=4)×2, SCALE=4
});

// ② 写真(回転・透視・劣化)からの復元 ───────────────────────────

test('柱7 photo: 縮小+並進した写真を finder 検出+補正で復元する', () => {
  const cord = freshCord();
  const back = shoot(cord, { scale: 0.75, tx: 50, ty: -30 });
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: キラリティ(TLリング)で全方位 0–360° の回転を復元する', () => {
  // 四隅同形 finder の ±45° 限界を、TL のリング(重心が白=回転不変なトポロジー特徴)で破る。
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const cord = freshCord();
    assert.equal(open(shoot(cord, { rotateDeg: deg, scale: 0.8 }), SECRET), TEXT, `rot ${deg}`);
  }
});

test('柱7 photo: 透視(keystone 横22%/縦20%)をホモグラフィ補正して復元する', () => {
  const cord = freshCord();
  assert.equal(open(shoot(cord, { tiltX: 0.22, scale: 0.9 }), SECRET), TEXT);
  assert.equal(open(shoot(cord, { tiltY: 0.20, scale: 0.9 }), SECRET), TEXT);
});

test('柱7 photo: 回転+透視+ぼけ+露出ずれ+ノイズの複合写真でも復元する', () => {
  const cord = freshCord();
  const back = shoot(cord, { rotateDeg: -14, tiltX: 0.16, scale: 0.8, blur: 1, brightness: -25, noise: 0.006 });
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: 高 N + 塩胡椒ノイズ — 単点標本は破綻し多数決(既定3×3)は同じ写真を復元する', () => {
  // N=136(本番相当密度・1 モジュール ≈ 3.6px)。simulatePhoto の noise はランダム画素を 0/255 へ反転(塩胡椒)。
  // 中心 1 点標本(subsamples:1)はノイズ余裕が無く、反転画素が RS 訂正能力を超えて PhotoError。
  // k×k 多数決(既定 3×3)はモジュールごと過半数票で 1 ビットを守り、同一画像から復元する(§5.10)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const noisy = simulatePhoto(png, { scale: 0.9, noise: 0.03, seed: 7 }); // seed 固定 = 決定的
  assert.throws(() => scanPhoto(noisy, { subsamples: 1 }), PhotoError); // 単点は破綻
  const back = scanPhoto(noisy); // 既定 3×3 多数決 = 同じ画像から復元
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

// ③ 媒体層と暗号層は別ドメイン ──────────────────────────────────

test('柱7 photo: 写真チャネルを抜けても改ざんは AEAD が検知する', () => {
  const cord = freshCord();
  const recovered = shoot(cord, { rotateDeg: 10, scale: 0.85, blur: 1 });
  let corrupted = false;
  (function corrupt(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Buffer.isBuffer(v) && v.length) { v[0] ^= 0xff; corrupted = true; return; }
      if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) { v.data[0] ^= 0xff; corrupted = true; return; }
      if (v && typeof v === 'object') { corrupt(v); if (corrupted) return; }
    }
  })(recovered);
  assert.ok(corrupted);
  assert.throws(() => open(recovered, SECRET), CordTamper);
});

test('柱7 photo: 全方位回転 + 透視 + 劣化の複合でも復元する', () => {
  const cord = freshCord();
  for (const opts of [
    { rotateDeg: 135, tiltY: 0.18, scale: 0.8, noise: 0.005 },
    { rotateDeg: 250, tiltX: 0.2, scale: 0.78, blur: 1, brightness: -20 },
  ]) {
    assert.equal(open(shoot(cord, opts), SECRET), TEXT, JSON.stringify(opts));
  }
});

// ④ 安全な失敗 ──────────────────────────────────────────────────

test('柱7 photo: finder を見つけられない画像は安全に失敗する(PhotoError)', () => {
  // 一様グレー(finder の無い)画像。連結成分が finder 条件を満たさず PhotoError。
  const blank = encodePng(Buffer.alloc(200 * 200, 200), 200, 200);
  assert.throws(() => scanPhoto(blank), PhotoError);
});

test('柱7 photo: finder の無い画像/PNG でないものは安全に失敗する', () => {
  assert.throws(() => scanPhoto(Buffer.from('not a png')), Error); // ImageCarrierError(PNG不正)
});

// ⑤ シミュレーションの決定性 ────────────────────────────────────

test('柱7 photo: simulatePhoto は seed が同じなら同一画像(決定的)', () => {
  const { png } = renderScannable(freshCord());
  const a = simulatePhoto(png, { rotateDeg: 10, noise: 0.02, seed: 5 });
  const b = simulatePhoto(png, { rotateDeg: 10, noise: 0.02, seed: 5 });
  assert.ok(a.equals(b));
});
