// tools/real-camera/measure.mjs
// 柱7 実カメラ測定キット ③: 撮影写真(PNG)を scanPhoto で復号できるか測り、復元率を出す。
//   JPEG は先に convert-to-png.ps1 で PNG 化(コアは PNG・依存ゼロを保つ)。
//   担体の特定は、復号した cord.tip を manifest と突き合わせて自動判定する(ファイル名規約は不要)。
// 実行(repo ルートから): node tools/real-camera/measure.mjs <photosDir> [carriersDir]

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open } from '../../src/cord.js';
import { scanPhoto, PhotoError } from '../../src/photo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const photosDir = process.argv[2];
const carriersDir = process.argv[3] || join(HERE, 'carriers');
if (!photosDir) {
  console.error('使い方: node tools/real-camera/measure.mjs <photosDir> [carriersDir]');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(carriersDir, 'manifest.json'), 'utf8'));
const byTip = new Map(manifest.carriers.map((c) => [c.tip, c]));

const photos = readdirSync(photosDir).filter((f) => /\.png$/i.test(f)).sort();
if (photos.length === 0) {
  console.error(`${photosDir} に PNG がありません(JPEG は convert-to-png.ps1 で PNG 化してください)。`);
  process.exit(1);
}

const perCarrier = new Map(manifest.carriers.map((c) => [c.id, 0]));
const failTypes = new Map();
let okCount = 0;

console.log(`写真 ${photos.length} 枚を測定(担体は復号 tip で自動判定)…\n`);
for (const f of photos) {
  let line;
  try {
    const png = readFileSync(join(photosDir, f));
    const back = scanPhoto(png);                 // 媒体層: finder→補正→再標本→RS 復号
    const c = byTip.get(back.tip);               // 復号 tip で担体を特定
    if (!c) {
      line = `△ デコード成功・manifest 外 tip(${back.tip.slice(0, 10)}…)`;
    } else if (open(back, manifest.secret) === c.text) {
      okCount++; perCarrier.set(c.id, perCarrier.get(c.id) + 1);
      line = `✓ ${c.id} 復元+平文一致`;
    } else {
      line = `△ ${c.id} tip 一致だが open 不一致`;
    }
  } catch (e) {
    const t = e instanceof PhotoError ? 'PhotoError' : e.name; // PhotoError=媒体層で読めず / CordTamper=改ざん扱い
    failTypes.set(t, (failTypes.get(t) || 0) + 1);
    line = `✗ ${t}: ${e.message}`;
  }
  console.log(`  ${f.padEnd(26)} ${line}`);
}

console.log(`\n=== 単フレーム復元率: ${okCount}/${photos.length} (${Math.round((okCount / photos.length) * 100)}%) ===`);
console.log('担体別(復号成功分): ' + manifest.carriers.map((c) => `${c.id}=${perCarrier.get(c.id)}`).join(' / '));
if (failTypes.size) console.log('失敗の型: ' + [...failTypes].map(([t, n]) => `${t}×${n}`).join(' / '));
console.log('\n注: 失敗写真はどの担体か不明(復号できないため)。特定担体が全滅なら、その担体だけを');
console.log('__<id> 命名で撮り直せば融合(scanPhotoMulti)も試せる。失敗の型 × 撮影条件でデコーダ改良の的を絞る。');
