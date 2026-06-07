// budget-demo.js — 柱7 物理層: 可読性バジェット(適応SCALE)のデモ
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.13
// 実行: node examples/budget-demo.js
//
// 超解像は「消えた解像を後から戻す」アプローチで、光学ぼけで消えた高周波は
// 枚数を重ねても戻らない(2026-06-07 de-risk で棄却)。正しい代替は逆方向=
// 撮影/表示の時点で 1 モジュールあたり十分な画素を「最初から確保」すること。
// 本デモは payload サイズ・撮影解像・可読しきい値(実測)を相互変換し、最後に
// バジェットの予測を実パイプライン(render→simulatePhoto→scan)で実証する。

import { seal, open } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, PhotoError } from '../src/photo.js';
import {
  PX_PER_MODULE, measureCord, minCaptureWidthPx, planLegibility, maxCordBytes,
} from '../src/budget.js';

const ISSUER = 'demo-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層: 可読性バジェット(適応SCALE)demo ===');
console.log('原則: 消えた解像は枚数で戻らない → 撮影/表示時に px/module を最初から確保する。\n');

// --- ① 担体を測る(レンダリング前に N・撮影モジュール辺がわかる)---
const cord = seal('データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco', ISSUER, 'cert', { axes: AXES });
const m = measureCord(cord);
console.log('--- ① 担体を測る ---');
console.log(`cord JSON       : ${m.jsonBytes} バイト`);
console.log(`データ格子       : ${m.dataModules}×${m.dataModules} モジュール`);
console.log(`撮影で捉える辺   : ${m.captureModules} モジュール(= データ ${m.dataModules} + 固定費 ${m.captureModules - m.dataModules}: finder+静寂帯)`);

// --- ② 可読しきい値(実測)と、確実に読む最低撮影幅 ---
console.log('\n--- ② 可読しきい値(px/module・実測)と最低撮影幅 ---');
for (const cond of ['sharp', 'blur', 'recommended']) {
  console.log(`  ${cond.padEnd(12)} ${PX_PER_MODULE[cond]} px/mod → 最低 ${minCaptureWidthPx(cord, { condition: cond })}px 幅`);
}

// --- ③ 撮影解像を与えて「読めるか」を判定(助言つき)---
console.log('\n--- ③ この撮影解像で読めるか(planLegibility)---');
for (const w of [300, 480, 650, 900]) {
  const p = planLegibility(cord, { captureWidthPx: w });
  console.log(`  ${String(w).padStart(4)}px 幅 → px/mod=${p.pxPerModule.toFixed(2)} ${p.legible ? '✓' : '✗'} [${p.tier}]  ${p.advice}`);
}

// --- ④ 撮影解像が決まっているときの容量上限(maxCordBytes)---
console.log('\n--- ④ 撮影解像 → 載せられる最大 cord JSON(容量上限・複合劣化想定)---');
for (const w of [480, 900, 1500, 3000]) {
  console.log(`  ${String(w).padStart(4)}px 幅 → 最大 ${maxCordBytes({ captureWidthPx: w, condition: 'recommended' })} バイト`);
}

// --- ⑤ 実証: バジェットの予測どおりに読める/読めないことを実パイプラインで確認 ---
console.log('\n--- ⑤ 実証: バジェットの予測を実パイプライン(render→撮影→読戻し)で確認 ---');
const { png, side } = renderScannable(cord); // side = SCALE×撮影モジュール
const tryRead = (captureWidthPx, blur) => {
  const scale = captureWidthPx / side; // simulatePhoto は PNG を scale 倍に縮小=撮影解像を模す
  try {
    const back = scanPhoto(simulatePhoto(png, { scale, blur }));
    return back && back.tip === cord.tip;
  } catch (e) {
    if (e instanceof PhotoError) return false;
    throw e;
  }
};
const floorPx = minCaptureWidthPx(cord, { condition: 'blur' });
for (const [label, w] of [['しきい値の 0.8 倍', Math.round(floorPx * 0.8)], ['しきい値ちょうど', floorPx], ['推奨幅', minCaptureWidthPx(cord, { condition: 'recommended' })]]) {
  const pred = planLegibility(cord, { captureWidthPx: w }).legible;
  const real = tryRead(w, 1); // blur=1(光学ぼけ)で撮る
  console.log(`  ${label.padEnd(10)} ${String(w).padStart(4)}px: 予測=${pred ? '読める' : '読めない'} / 実際=${real ? '読めた' : '読めず'} ${pred === real ? '✓一致' : '✗不一致'}`);
}

console.log('\n正直な限界: しきい値は blur 単独の実測(2.6)。実カメラはノイズ+透視+レンズ歪みが');
console.log('複合し単フレームで ~3.0 要る(推奨 4.0 は余裕込み)。融合はレンズ歪みに効かない');
console.log('(scanPhotoMulti は §5.12 の歪み補正を持たない)ので px/module 確保が確実な手。');
