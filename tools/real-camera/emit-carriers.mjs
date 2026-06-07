// tools/real-camera/emit-carriers.mjs
// 柱7 実カメラ測定キット ①: ラベル付き担体 PNG 群 + manifest.json を出す。
// これを画面表示/印刷して撮影し(PROTOCOL.md)、measure.mjs で実カメラ復元率を測る。
//   合成劣化(simulatePhoto)で止まっている柱7 を、実カメラ/実印刷/実スキャンの
//   「測定された復元率」に変えるのが目的(白書を主張でなく測定で語れるようにする)。
// 実行(repo ルートから): node tools/real-camera/emit-carriers.mjs [outDir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { seal } from '../../src/cord.js';
import { renderScannable } from '../../src/photo.js';
import { decodePng, encodePng } from '../../src/image.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, 'carriers');

// 測定用ダミー(本番の発行者秘密ではない)。manifest に保存し measure.mjs が open 検証に使う。
const SECRET = 'real-camera-measure-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };
const UPSCALE = 4; // 最近傍整数拡大(表示/印刷で滲ませない)。1 モジュール = 4×UPSCALE px in file。

// 段階的な payload(N が変わる = 容量と実カメラ可読性の関係を見る)。
const PAYLOADS = [
  { id: 'p1-short', text: 'CERT-RC-0001 / 1台' },
  { id: 'p2-prod',  text: 'データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco' },
  { id: 'p3-long',  text: 'データ消去証明書 CASE-2026-0042 / 機器12台 / Blancco 完全消去 / 拠点:関東 / 監査ID AUD-2026Q2-0007 / 追記' },
];

// 最近傍で整数倍に拡大(モジュール境界を保ったまま大きくする)。
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
console.log(`担体を ${OUT}/ に出力:\n`);
for (const p of PAYLOADS) {
  const cord = seal(p.text, SECRET, 'cert', { axes: AXES });
  const { png, modules, total, side } = renderScannable(cord);
  const big = nnUpscale(png, UPSCALE);
  const file = `${p.id}.png`;
  writeFileSync(join(OUT, file), big);
  const captureModules = total + 8; // データ N + 固定費 26(finder+静寂帯)= 撮影で横切る総モジュール
  manifest.carriers.push({
    id: p.id, file, text: p.text, tip: cord.tip,
    dataModules: modules, captureModules, srcSide: side, fileSide: side * UPSCALE,
  });
  console.log(`  ${file.padEnd(14)} データ ${modules}×${modules} / 撮影総 ${captureModules} モジュール / file ${side * UPSCALE}px`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nmanifest.json も出力。次は PROTOCOL.md に従って各担体を撮影してください。`);
console.log(`撮影写真は <carrierId>__<任意>.jpg で命名(例 p2-prod__straight.jpg / p2-prod__tilt20.jpg)。`);
