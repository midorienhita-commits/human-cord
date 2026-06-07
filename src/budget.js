// src/budget.js — 可読性バジェット(柱7 視覚担体)。依存ゼロ。
//
// 超解像の「正しい代替」。写真から消えた解像は枚数では戻らない(消えた高周波は
// shift-and-add で復元できない=2026-06-07 de-risk で確証)。なら撮影/表示の時点で
// 1 モジュールあたり十分な画素を「最初から確保」すればよい。本モジュールは
//   ・payload(cord JSON バイト)→ 担体が要する総モジュール辺
//   ・撮影解像(担体を横切る画素数)→ 1 モジュールあたり画素(px/module)
//   ・可読しきい値(実測)との突合 → 読めるか / 最低何 px 要るか / 容量上限
// を相互変換する。新しい暗号も新しい媒体処理も足さない。既存の幾何(cordToMatrix /
// renderScannable)の上に「どれだけ大きく写せば確実に読めるか」の予算管理を載せるだけ。
//
// 根拠数値の出所と正直な限界:
//   ・しきい値は可読性プローブの実測(blur 単独 / 複合劣化)。表と導出は
//     docs/phase2-pillar7-visual-channel.md §5.13。constants は test/budget.test.js が
//     実パイプライン(render→simulatePhoto→scanPhoto)に紐づけて継続検証する。
//   ・しきい値は N(payload サイズ)に非依存(N=112 と N=136 で同一)=式が clean。
//   ・融合(複数フレーム)は確実しきい値を下げない。際の部分成功を埋める保険であって、
//     バジェットの根拠にはしない(超解像が高周波を戻せないのと同根)。

import { cordToMatrix } from './image.js';
import { SCANNABLE_OVERHEAD_MODULES } from './photo.js';

// ── 幾何(撮影時に捉えねばならない、データ外の固定モジュール)──────────────
// renderScannable の総辺 = データ N + 四隅 finder + GAP セパレータ + 静寂帯。
//   photo.js: BORDER = FINDER(7) + GAP(2) = 9 / 辺、QUIET = 4 / 辺。両辺で 2×(9+4)=26。
// この固定費は N に依らないので、小さい payload ほど相対オーバーヘッドが大きい。
// 値は photo.js の SCANNABLE_OVERHEAD_MODULES を単一の真実として参照(幾何 drift を防ぐ)。
export const OVERHEAD_MODULES = SCANNABLE_OVERHEAD_MODULES; // = 26

// ── 符号化(レンダリング不要で N を解析的に出すための image.js / ecc.js 定数）──
const HEADER_LEN = 15; // image.js: MAGIC+VERSION+len(3B) + RS パリティ10
const RS_BLOCK = 255;  // image.js BLOCK（RS ブロック長）
const RS_DATA = 223;   // ecc.js encodeBlocks 既定 k（1 ブロックのデータ部）

// ── 可読しきい値（px/module・実測）──────────────────────────────
// SHARP: ぼけ無し（画面直キャプチャ等）。プローブ下限 1.8 で読取り 100%、N 非依存。
// BLUR : 光学ぼけ box radius 1（≈1 モジュール幅 PSF）下。N=112/136 とも 2.6 で 100%、
//        2.4 以下で破綻。N 非依存。実カメラ前提の既定。
// RECOMMENDED: 複合劣化（ぼけ+ノイズ+透視回転+樽レンズ歪み）下で単フレーム 100% を
//        確保する推奨ヘッドルーム。実カメラは劣化が重なるので発行時の目標はこちら。
export const PX_PER_MODULE = Object.freeze({
  sharp: 1.8,
  blur: 2.6,
  recommended: 4.0, // 複合劣化の単フレーム床 3.0 に余裕を足した発行時目標(§5.13・実測 100%）
});

function thresholdOf(condition) {
  if (typeof condition === 'number') {
    if (!(condition > 0)) throw new RangeError('threshold must be a positive number');
    return condition;
  }
  const t = PX_PER_MODULE[condition];
  if (t === undefined) throw new RangeError(`unknown condition "${condition}" (use sharp|blur|recommended or a number)`);
  return t;
}

// ── payload バイト → データモジュール辺 N（解析式・レンダリング不要）─────────
// 容量計画用。実 cord は measureCord（cordToMatrix）で厳密 N を使うこと。
export function dataModulesForBytes(cordJsonBytes) {
  if (!Number.isInteger(cordJsonBytes) || cordJsonBytes < 1) {
    throw new RangeError('cordJsonBytes must be a positive integer');
  }
  const blocks = Math.ceil(cordJsonBytes / RS_DATA);
  const streamBytes = HEADER_LEN + blocks * RS_BLOCK;
  return Math.ceil(Math.sqrt(streamBytes * 8)); // 正方格子に収める（cordToMatrix と同式）
}

// データ辺 N → 撮影時に横切る総モジュール（静寂帯込み）。カメラはこの幅を捉える。
export function captureSpanForN(dataModules) {
  if (!Number.isInteger(dataModules) || dataModules < 1) {
    throw new RangeError('dataModules must be a positive integer');
  }
  return dataModules + OVERHEAD_MODULES;
}

// 実 cord を測る（厳密 N を cordToMatrix から得る＝符号化の将来変更にも追従）。
export function measureCord(cord) {
  const { n } = cordToMatrix(cord);
  const jsonBytes = Buffer.byteLength(JSON.stringify(cord), 'utf8');
  return { jsonBytes, dataModules: n, captureModules: n + OVERHEAD_MODULES };
}

// 確実に読むのに最低限要る撮影幅（担体を横切る画素数）。
export function minCaptureWidthPx(cord, { condition = 'blur' } = {}) {
  const { captureModules } = measureCord(cord);
  return Math.ceil(captureModules * thresholdOf(condition));
}

/**
 * planLegibility: 「この payload を、この撮影解像で、確実に読めるか」を判定する。
 * @param {object} cord  seal()/issue() の出力
 * @param {object} opts
 * @param {number} opts.captureWidthPx  担体を横切って写る画素数（カメラ解像・距離・画角で決まる）
 * @param {('sharp'|'blur'|'recommended'|number)} [opts.condition='blur']  可読しきい値の条件
 * @returns {object} 判定 + 助言
 */
export function planLegibility(cord, { captureWidthPx, condition = 'blur' } = {}) {
  if (!(captureWidthPx > 0)) throw new RangeError('captureWidthPx must be a positive number');
  const m = measureCord(cord);
  const threshold = thresholdOf(condition);
  const pxPerModule = captureWidthPx / m.captureModules;
  const minPx = Math.ceil(m.captureModules * threshold);
  const legible = pxPerModule >= threshold;
  const marginRatio = pxPerModule / threshold;
  const maxBytesHere = maxCordBytes({ captureWidthPx, condition });
  const recPx = Math.ceil(m.captureModules * PX_PER_MODULE.recommended);

  // ティアは実測の床に紐づける(マジックな余裕係数でなく):
  //   safe       … 推奨 px/module 以上(複合劣化込みで単フレーム 100% を実測した余裕域)
  //   marginal   … 選んだ条件のしきい値は満たすが推奨未満(ぼけ単独なら読めるが
  //                 実カメラのノイズ+透視+レンズ歪みの複合で割れ得る)
  //   insufficient … 床も満たさない(理想光学でも読めない)
  let tier, advice;
  if (pxPerModule >= PX_PER_MODULE.recommended) {
    tier = 'safe';
    advice = `可: px/module=${pxPerModule.toFixed(2)}(推奨 ${PX_PER_MODULE.recommended} 以上を満たす)。`;
  } else if (legible) {
    tier = 'marginal';
    advice =
      `境界: px/module=${pxPerModule.toFixed(2)}。しきい値 ${threshold}(${typeof condition === 'number' ? '指定' : condition})は満たすが、` +
      `実カメラの複合劣化(ノイズ+透視+レンズ歪み)で割れ得る。撮影解像/表示サイズを上げて推奨 ${recPx}px 幅へ` +
      `(融合はレンズ歪みに効かない=px/module 確保が確実な手)。`;
  } else {
    tier = 'insufficient';
    advice =
      `不足: px/module=${pxPerModule.toFixed(2)} < しきい値 ${threshold}。` +
      `担体をより大きく表示/印刷するか近づいて撮る(最低 ${minPx}px 幅、現在 ${Math.round(captureWidthPx)}px)、` +
      `または payload を ${maxBytesHere}B 以下に減らす。`;
  }

  return {
    jsonBytes: m.jsonBytes,
    dataModules: m.dataModules,
    captureModules: m.captureModules,
    condition: typeof condition === 'number' ? `${condition}px/mod` : condition,
    threshold,
    pxPerModule,
    legible,
    marginRatio,
    tier,
    minCaptureWidthPx: minPx,
    recommendedCaptureWidthPx: recPx,
    maxCordBytesHere: maxBytesHere,
    advice,
  };
}

/**
 * maxCordBytes: 与えた撮影解像で確実に読める最大 cord JSON バイト数（容量上限）。
 *   minCaptureWidthPx の逆。floor で安全側（読めない payload を許さない）。
 * @returns {number} 0 = この解像では 1 ブロックも載らない（担体を大きく写すしかない）
 */
export function maxCordBytes({ captureWidthPx, condition = 'blur' } = {}) {
  if (!(captureWidthPx > 0)) throw new RangeError('captureWidthPx must be a positive number');
  const threshold = thresholdOf(condition);
  const maxCaptureModules = Math.floor(captureWidthPx / threshold);
  const maxN = maxCaptureModules - OVERHEAD_MODULES;
  if (maxN < 1) return 0;
  const maxStreamBytes = Math.floor((maxN * maxN) / 8); // bits ≤ maxN² を満たす最大バイト
  const maxRsBytes = maxStreamBytes - HEADER_LEN;
  if (maxRsBytes < RS_BLOCK) return 0; // 1 ブロック(255B)も入らない
  const maxBlocks = Math.floor(maxRsBytes / RS_BLOCK);
  return maxBlocks * RS_DATA;
}
