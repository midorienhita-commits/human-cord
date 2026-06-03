// image.test.js
// 柱7「物理層出力(視覚チャネルの実ピクセルアダプタ)」の振る舞い検証。
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderImage, extractImage, simulateOptics, ImageCarrierError } from '../src/image.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function freshCord(text, ctx = 'image') {
  return seal(text, SECRET, ctx, { axes: AXES });
}

// ① 実 PNG への往復 ─────────────────────────────────────────────

test('柱7 image: renderImage→extractImage→open で平文が往復する', () => {
  const cord = freshCord('CERT-2026-0603 実ピクセル担体往復');
  const { png, modules, side } = renderImage(cord);
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.subarray(0, 8).equals(PNG_SIG), 'PNG シグネチャを持つ');
  assert.ok(modules > 0 && side === (modules + 8) * 4, '幾何が描画定数と整合');

  const back = extractImage(png);
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), 'CERT-2026-0603 実ピクセル担体往復');
});

test('柱7 image: 生成 PNG は正方(辺長=幅=高さ)', () => {
  const { png, side } = renderImage(freshCord('square invariant'));
  // IHDR: width@16, height@20(8B sig + 4B len + 4B type の後)
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  assert.equal(w, side);
  assert.equal(h, side);
});

// ② 光学劣化の訂正(RS = 目)───────────────────────────────────

test('柱7 image: ぼけ+露出ずれ+軽ノイズは RS が訂正して復元する', () => {
  const cord = freshCord('blur+exposure+noise should be corrected');
  const { png } = renderImage(cord);
  const noisy = simulateOptics(png, { blur: 1, brightness: 40, noise: 0.005, seed: 7 });
  const back = extractImage(noisy);
  assert.equal(open(back, SECRET), 'blur+exposure+noise should be corrected');
});

test('柱7 image: 隅の部分遮蔽(指/反射)もインターリーブ+RS で復元する', () => {
  const cord = freshCord('occlusion recovered via interleave');
  const { png } = renderImage(cord);
  const occluded = simulateOptics(png, { occlude: 0.06, seed: 3 });
  const back = extractImage(occluded);
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), 'occlusion recovered via interleave');
});

test('柱7 image: 訂正能力を超える劣化は ImageCarrierError として安全に弾く(クラッシュしない)', () => {
  const { png } = renderImage(freshCord('beyond correction capacity'));
  const wrecked = simulateOptics(png, { noise: 0.05, seed: 1 });
  assert.throws(() => extractImage(wrecked), ImageCarrierError);
});

// ③ 媒体層と暗号層は別ドメイン ──────────────────────────────────

test('柱7 image: 物理チャネルを抜けても改ざんは AEAD が検知する(媒体≠暗号)', () => {
  const cord = freshCord('authenticity survives the physical channel');
  const { png } = renderImage(cord);
  const recovered = extractImage(simulateOptics(png, { occlude: 0.04, seed: 2 }));
  // 復元 cord の最初の Buffer フィールドを汚す = 改ざん。
  // extractImage は reviveBuffers 済なので実 Buffer。JSON 形式({type:'Buffer'})も両対応。
  let corrupted = false;
  (function corrupt(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Buffer.isBuffer(v) && v.length) { v[0] ^= 0xff; corrupted = true; return; }
      if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) { v.data[0] ^= 0xff; corrupted = true; return; }
      if (v && typeof v === 'object') { corrupt(v); if (corrupted) return; }
    }
  })(recovered);
  assert.ok(corrupted, 'テスト前提: 汚せる Buffer が存在');
  assert.throws(() => open(recovered, SECRET), CordTamper);
});

// ④ 媒体エラーの入力検証 ────────────────────────────────────────

test('柱7 image: PNG でないバイト列は ImageCarrierError', () => {
  assert.throws(() => extractImage(Buffer.from('not a png at all')), ImageCarrierError);
});

test('柱7 image: 途中で切れた PNG は ImageCarrierError(デコード破綻)', () => {
  const { png } = renderImage(freshCord('truncated png'));
  assert.throws(() => extractImage(png.subarray(0, png.length - 50)), ImageCarrierError);
});

// ⑤ シミュレーションの決定性(テスト安定性)──────────────────────

test('柱7 image: simulateOptics は seed が同じなら同一画像(決定的)', () => {
  const { png } = renderImage(freshCord('deterministic optics'));
  const a = simulateOptics(png, { noise: 0.02, occlude: 0.02, seed: 42 });
  const b = simulateOptics(png, { noise: 0.02, occlude: 0.02, seed: 42 });
  assert.ok(a.equals(b));
  const c = simulateOptics(png, { noise: 0.02, occlude: 0.02, seed: 43 });
  assert.ok(!a.equals(c), '異なる seed は異なる劣化');
});
