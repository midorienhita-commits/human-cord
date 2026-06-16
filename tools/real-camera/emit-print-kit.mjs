// tools/real-camera/emit-print-kit.mjs
// 柱7 再印刷キット: 印刷実写の第1テスト(2026-06-16)で確定した2つの物理失敗型
//   ① プリンタ横バンディング(行潰れ・シート固定欠陥=融合免疫) ② 高密度モアレ
//   を同時に殺すための「密度最小=モジュール最大」担体を出す。
//   既存 emit-carriers.mjs は容量スイープ用(p1/p2/p3)。こちらは「まず1枚通す」ための低密度版。
// 設計:
//   - 文面を短くして N(データ辺長)を小さく → 同じ印刷サイズなら 1 モジュールが大きい
//     = バンディングの帯が 1 モジュール未満に相対縮小し、モアレ周波数も下がる。
//   - UPSCALE を上げて file px を増やす(印刷ラスタでモジュール境界が滲まない)。PNG px は律速でないが
//     大判印刷でのエッジを保つ保険。
//   - measure.mjs はそのまま使える: node tools/real-camera/measure.mjs <photos> tools/real-camera/carriers-print
// 実行(repo ルートから): node tools/real-camera/emit-print-kit.mjs [outDir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seal } from '../../src/cord.js';
import { renderScannable } from '../../src/photo.js';
import { decodePng, encodePng } from '../../src/image.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, 'carriers-print');

// measure.mjs の open 検証と一致させる(emit-carriers.mjs と同じダミー秘密)。
const SECRET = 'real-camera-measure-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };
const UPSCALE = 8; // 印刷大判でモジュール境界を保つため emit-carriers(4)より高解像度。

// 低密度から少し上げる 3 段。まず p0-min を 1 枚通すのが目標。p1 は比較、p2 は伸び代確認。
const PAYLOADS = [
  { id: 'p0-min',   text: 'CERT-RC-0001' },                         // 最短(12 文字)= 最大モジュール
  { id: 'p1-short', text: 'CERT-RC-0001 / 1台' },                   // emit-carriers の p1 と同文面(横並び比較用)
  { id: 'p2-prod',  text: 'データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco' }, // 本番相当(伸び代)
];

function nnUpscale(png, k) {
  if (k <= 1) return png;
  const { w, h, pixels } = decodePng(png);
  const W = w * k, H = h * k;
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    const sy = (y / k) | 0;
    const srow = sy * w, drow = y * W;
    for (let x = 0; x < W; x++) out[drow + x] = pixels[srow + ((x / k) | 0)];
  }
  return encodePng(out, W, H);
}

mkdirSync(OUT, { recursive: true });
const manifest = { secret: SECRET, axes: AXES, upscale: UPSCALE, carriers: [] };
console.log(`再印刷キットを ${OUT}/ に出力:\n`);
for (const p of PAYLOADS) {
  const cord = seal(p.text, SECRET, 'cert', { axes: AXES });
  const { png, modules, total, side } = renderScannable(cord);
  const big = nnUpscale(png, UPSCALE);
  writeFileSync(join(OUT, `${p.id}.png`), big);
  const captureModules = total + 8;
  manifest.carriers.push({
    id: p.id, file: `${p.id}.png`, text: p.text, tip: cord.tip,
    dataModules: modules, captureModules, srcSide: side, fileSide: side * UPSCALE,
  });
  // 15cm 角で印刷した場合の 1 モジュール mm(撮影で横切る総モジュール基準)。
  const mmPerModule = (150 / captureModules).toFixed(2);
  console.log(`  ${p.id.padEnd(9)} データ ${modules}×${modules} / 撮影総 ${captureModules} モジュール / file ${side * UPSCALE}px / 15cm印刷時 1モジュール≈${mmPerModule}mm`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest.json も出力。印刷・撮影手順は PRINT-KIT.md を参照。`);
console.log(`測定: node tools/real-camera/measure.mjs <photosDir> tools/real-camera/carriers-print`);
