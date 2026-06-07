// budget.test.js
// 柱7「可読性バジェット(適応SCALE)」の検証。
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.13
// 実行: node --test
//
// 核心は「バジェットの予測が実パイプライン(render→simulatePhoto→scanPhoto)と一致する」こと。
// しきい値定数(2.6/4.0)を空言にせず、実際の読取り成否に紐づけて検証する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, PhotoError, SCANNABLE_OVERHEAD_MODULES } from '../src/photo.js';
import { cordToMatrix } from '../src/image.js';
import {
  PX_PER_MODULE, OVERHEAD_MODULES, dataModulesForBytes, captureSpanForN,
  measureCord, minCaptureWidthPx, planLegibility, maxCordBytes,
} from '../src/budget.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const SHORT = 'CASE-7'; // 最小 payload(crypto オーバーヘッドで N は下限近辺)
const PROD = 'データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco'; // 本番相当 N≈136

const freshCord = (text, ctx = 'budget') => seal(text, SECRET, ctx, { axes: AXES });

// ── ① 幾何の単一の真実(drift 検知)───────────────────────────────
test('柱7 budget: OVERHEAD は photo.js の SCANNABLE_OVERHEAD_MODULES と一致(=26)', () => {
  assert.equal(OVERHEAD_MODULES, SCANNABLE_OVERHEAD_MODULES);
  assert.equal(OVERHEAD_MODULES, 26);
});

test('柱7 budget: measureCord の撮影モジュール辺が renderScannable の実描画と一致', () => {
  for (const text of [SHORT, PROD]) {
    const cord = freshCord(text);
    const m = measureCord(cord);
    const { modules, total, side } = renderScannable(cord);
    assert.equal(m.dataModules, modules);            // 厳密 N(cordToMatrix 経由)
    assert.equal(m.captureModules, modules + 26);    // データ + 固定費
    assert.equal(m.captureModules, total + 8);       // total(=N+18) + 静寂帯 2×QUIET(=8)
    assert.equal(side, m.captureModules * 4);        // side = 撮影モジュール × SCALE(=4)
  }
});

// ── ② 解析式が実符号化(cordToMatrix)と一致 ─────────────────────────
test('柱7 budget: dataModulesForBytes は cordToMatrix の N と一致(レンダリング不要の計画式)', () => {
  for (const text of [SHORT, PROD, PROD + ' / 追記でブロック境界を跨ぐ長文ペイロードの検証用テキスト']) {
    const cord = freshCord(text);
    const jsonBytes = Buffer.byteLength(JSON.stringify(cord), 'utf8');
    assert.equal(dataModulesForBytes(jsonBytes), cordToMatrix(cord).n);
  }
});

test('柱7 budget: captureSpanForN は N + 固定費', () => {
  assert.equal(captureSpanForN(100), 126);
  assert.equal(captureSpanForN(136), 162);
});

// ── ③ バジェット算術(minCaptureWidthPx / maxCordBytes の整合)──────────
test('柱7 budget: minCaptureWidthPx = ceil(撮影モジュール × しきい値)', () => {
  const cord = freshCord(PROD);
  const { captureModules } = measureCord(cord);
  for (const cond of ['sharp', 'blur', 'recommended']) {
    assert.equal(minCaptureWidthPx(cord, { condition: cond }), Math.ceil(captureModules * PX_PER_MODULE[cond]));
  }
});

test('柱7 budget: maxCordBytes は minCaptureWidthPx の逆(ブロック粒度で tight)', () => {
  const W = 900;
  const cond = 'recommended';
  const B = maxCordBytes({ captureWidthPx: W, condition: cond });
  assert.ok(B > 0);
  const T = PX_PER_MODULE[cond];
  // B バイトの担体は W に収まる
  assert.ok((dataModulesForBytes(B) + OVERHEAD_MODULES) * T <= W);
  // 1 ブロック分(+223B)増やすと収まらない = 上限が tight
  assert.ok((dataModulesForBytes(B + 223) + OVERHEAD_MODULES) * T > W);
});

test('柱7 budget: 撮影幅が固定費に満たなければ容量 0', () => {
  // OVERHEAD(26) × しきい値 すら無い幅
  assert.equal(maxCordBytes({ captureWidthPx: 10, condition: 'blur' }), 0);
});

test('柱7 budget: 不正入力は投げる', () => {
  const cord = freshCord(SHORT);
  assert.throws(() => planLegibility(cord, { captureWidthPx: 0 }), RangeError);
  assert.throws(() => minCaptureWidthPx(cord, { condition: 'nope' }), RangeError);
  assert.throws(() => dataModulesForBytes(0), RangeError);
  assert.throws(() => planLegibility(cord, { captureWidthPx: 100, condition: -1 }), RangeError);
});

// ── ④ ティア判定(実測の床に紐づく)───────────────────────────────
test('柱7 budget: planLegibility のティア(insufficient / marginal / safe)', () => {
  const cord = freshCord(PROD);
  const { captureModules } = measureCord(cord);
  const at = (pxPerMod) => planLegibility(cord, { captureWidthPx: captureModules * pxPerMod });

  const lo = at(2.0); // < 床 2.6
  assert.equal(lo.legible, false);
  assert.equal(lo.tier, 'insufficient');

  const mid = at(3.2); // 床は満たすが推奨 4.0 未満
  assert.equal(mid.legible, true);
  assert.equal(mid.tier, 'marginal');

  const hi = at(4.5); // 推奨以上
  assert.equal(hi.legible, true);
  assert.equal(hi.tier, 'safe');
});

// ── ⑤ 実証: 予測 ↔ 実パイプライン ─────────────────────────────────
// バジェットが「読める」と言う幅では実際に読め、「読めない」と言う幅では実際に読めない。
function shootAt(cord, captureWidthPx, opts = {}) {
  const { png, side } = renderScannable(cord);
  const scale = captureWidthPx / side; // simulatePhoto.scale = 撮影解像 / 元解像
  try {
    const back = scanPhoto(simulatePhoto(png, { scale, blur: 1, ...opts }));
    return back && back.tip === cord.tip ? open(back, SECRET) : null;
  } catch (e) {
    if (e instanceof PhotoError) return null;
    throw e;
  }
}

test('柱7 budget: blur 床(2.6)の幅では実際に読め、その 0.8 倍では読めない', () => {
  const cord = freshCord(PROD);
  const floorPx = minCaptureWidthPx(cord, { condition: 'blur' });
  // 床ちょうど: 読めて平文まで復元
  assert.equal(shootAt(cord, floorPx), PROD);
  assert.equal(planLegibility(cord, { captureWidthPx: floorPx }).legible, true);
  // 床の 0.8 倍(≈2.08px/mod): 予測も実際も読めない
  const below = Math.round(floorPx * 0.8);
  assert.equal(planLegibility(cord, { captureWidthPx: below }).legible, false);
  assert.equal(shootAt(cord, below), null);
});

test('柱7 budget: しきい値は N 非依存(小 payload も床の幅で読める)', () => {
  const cord = freshCord(SHORT);
  const floorPx = minCaptureWidthPx(cord, { condition: 'blur' });
  assert.equal(shootAt(cord, floorPx), SHORT);
});

test('柱7 budget: 推奨幅(4.0)は複合劣化(ノイズ+透視回転+樽歪み)に単フレームで耐える', () => {
  const cord = freshCord(PROD);
  const recPx = minCaptureWidthPx(cord, { condition: 'recommended' });
  // 複合劣化を 1 枚に乗せる(可読性プローブ §5.13 と同種・推奨幅で 100% を実測した条件)
  const out = shootAt(cord, recPx, { noise: 0.06, rotateDeg: 2.5, lensK: -0.06 });
  assert.equal(out, PROD);
  assert.equal(planLegibility(cord, { captureWidthPx: recPx }).tier, 'safe');
});
