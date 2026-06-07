// tools/envelope-sweep.mjs
// 柱7 復号エンベロープの再現可能な特性評価(合成・単フレーム)。
//   §5.9〜5.14 の各軸の破綻点を「一つの再現可能な表」に集約し、さらに実カメラで効く
//   複合劣化(ぼけ+ノイズ+回転+透視+レンズ歪み)を px/module で掃引する。
//   これが柱7 の「主張でなく測定」の合成側の土台(実機測定 §5.15 と対で読む)。
//   正直な限界: 画面撮影のモアレ/JPEG 量子化は構造的干渉で、ここでは忠実にモデル化しない
//   (事前ぼかしが実機で悪化したのと整合)。それらは実カメラ測定(§5.15 / 印刷回)でカバーする。
// 実行(repo ルートから): node tools/envelope-sweep.mjs

import { seal, open } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, PhotoError } from '../src/photo.js';

const SECRET = 'envelope-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };
const TEXT = 'データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco'; // 本番相当 N=136
const cord = seal(TEXT, SECRET, 'cert', { axes: AXES });
const { png, modules } = renderScannable(cord);

// 単フレーム復号できるか(tip 一致 + 平文一致)。決定的に複数 seed で頑健化。
function ok(opts, seeds = [1, 2, 3]) {
  let pass = 0;
  for (const seed of seeds) {
    try {
      const back = scanPhoto(simulatePhoto(png, { ...opts, seed }));
      if (back.tip === cord.tip && open(back, SECRET) === TEXT) pass++;
    } catch (e) { if (!(e instanceof PhotoError)) throw e; }
  }
  return pass === seeds.length ? '✓' : pass === 0 ? '✗' : `${pass}/${seeds.length}`;
}

console.log(`柱7 復号エンベロープ(prod 担体 N=${modules}・単フレーム・各セル 3 seed 全成功で ✓)\n`);

// ── 単軸掃引(他は clean。base scale=0.8=px/mod 3.2)──────────────
const base = { scale: 0.8 };
const sweeps = [
  ['px/module (scale)', 'scale', [0.5, 0.55, 0.6, 0.65, 0.7, 0.8], (v) => `${(4 * v).toFixed(2)}px`],
  ['光学ぼけ blur (box r)', 'blur', [0, 1, 2, 3], (v) => `r=${v}`],
  ['塩胡椒ノイズ noise', 'noise', [0, 0.1, 0.2, 0.3, 0.4], (v) => `${v}`],
  ['面内回転 rotateDeg', 'rotateDeg', [0, 15, 45, 90, 180], (v) => `${v}°`],
  ['透視 tiltX', 'tiltX', [0, 0.1, 0.2, 0.3, 0.4], (v) => `${v}`],
  ['レンズ歪み lensK', 'lensK', [-0.2, -0.15, -0.1, 0, 0.15, 0.3], (v) => `${v}`],
];
for (const [label, key, values, fmt] of sweeps) {
  const cells = values.map((v) => `${fmt(v)}:${ok({ ...base, [key]: v })}`);
  console.log(`  ${label.padEnd(22)} ${cells.join('  ')}`);
}

// ── 複合劣化を px/module で掃引(実カメラに最も近い・§5.13 ヘッドルームの拡張)──
console.log('\n複合劣化(ぼけ1 + ノイズ0.06 + 回転2° + 透視0.1 + 樽歪 -0.06)を px/module で:');
for (const s of [0.65, 0.75, 0.85, 1.0]) {
  console.log(`  px/mod ${(4 * s).toFixed(2)}: ${ok({ scale: s, blur: 1, noise: 0.06, rotateDeg: 2, tiltX: 0.1, lensK: -0.06 })}`);
}
console.log('\n※ 画面撮影のモアレ/JPEG はここでは非モデル(構造的干渉)。実機の射程は §5.15(実カメラ測定)を参照。');
