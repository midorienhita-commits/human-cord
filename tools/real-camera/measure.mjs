// tools/real-camera/measure.mjs
// 柱7 実カメラ測定キット ③: 撮影写真(PNG)を scanPhoto で復号できるか測り、復元率を出す。
//   JPEG は先に convert-to-png.ps1 で PNG 化(コアは PNG・依存ゼロを保つ)。
//   担体の特定は、復号した cord.tip を manifest と突き合わせて自動判定する(ファイル名規約は不要)。
//   さらに「同一担体のバーストを融合(scanPhotoMulti)」して、連写→1 復元の実用シナリオを測る。
//   グルーピングは nearest-decoded(各写真を、ソート順で最も近い復号成功写真の担体に割当)=
//   撮影が担体ごとのバーストなら自然に分かれる(命名・撮影時刻形式に依存しない)。
// 実行(repo ルートから): node tools/real-camera/measure.mjs <photosDir> [carriersDir]

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open } from '../../src/cord.js';
import { scanPhoto, scanPhotoMulti, PhotoError } from '../../src/photo.js';

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

// ── 単フレーム ──────────────────────────────────────────────────
const perCarrier = new Map(manifest.carriers.map((c) => [c.id, 0]));
const failTypes = new Map();
const ids = new Array(photos.length).fill(null); // 各写真の復号担体 id(失敗は null)
let okCount = 0;

console.log(`写真 ${photos.length} 枚を測定(担体は復号 tip で自動判定)…\n`);
photos.forEach((f, i) => {
  let line;
  try {
    const back = scanPhoto(readFileSync(join(photosDir, f))); // 媒体層: finder→補正→再標本→RS 復号
    const c = byTip.get(back.tip);                            // 復号 tip で担体を特定
    if (!c) {
      line = `△ デコード成功・manifest 外 tip(${back.tip.slice(0, 10)}…)`;
    } else if (open(back, manifest.secret) === c.text) {
      okCount++; perCarrier.set(c.id, perCarrier.get(c.id) + 1); ids[i] = c.id;
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
});

console.log(`\n=== 単フレーム復元率: ${okCount}/${photos.length} (${Math.round((okCount / photos.length) * 100)}%) ===`);
console.log('担体別(復号成功分): ' + manifest.carriers.map((c) => `${c.id}=${perCarrier.get(c.id)}`).join(' / '));
if (failTypes.size) console.log('失敗の型: ' + [...failTypes].map(([t, n]) => `${t}×${n}`).join(' / '));

// ── バースト融合(連写→1 復元)──────────────────────────────────
// 各写真を nearest-decoded(ソート順で最も近い復号成功)の担体に割当 → 担体ごとに全ショットを融合。
// 撮影が担体ごとのバーストなら正しく分かれる。失敗写真も融合に混ざるが、§5.11/§5.14 の soft 融合で
// クリーンな多数が押し返す。1 枚も復号できない担体は割当不能(融合対象外)。
if (okCount > 0 && photos.length > okCount) {
  const assigned = ids.map((id, i) => {
    if (id) return id;
    for (let d = 1; d < photos.length; d++) {            // 前後で最も近い復号成功の担体
      if (i - d >= 0 && ids[i - d]) return ids[i - d];
      if (i + d < photos.length && ids[i + d]) return ids[i + d];
    }
    return null;
  });
  console.log('\n--- バースト融合(同一担体の全ショットを scanPhotoMulti)---');
  for (const c of manifest.carriers) {
    const pngs = photos.filter((_, i) => assigned[i] === c.id).map((f) => readFileSync(join(photosDir, f)));
    if (pngs.length === 0) { console.log(`  ${c.id}: 割当ショット無し(全滅 or 未撮影)`); continue; }
    let v;
    try {
      const b = scanPhotoMulti(pngs);
      v = (b.tip === c.tip && open(b, manifest.secret) === c.text) ? '✓ 復元+平文一致' : '△ 不一致';
    } catch (e) { v = '✗ ' + (e.message || e.name); }
    console.log(`  ${c.id}(${pngs.length}枚バースト)→ ${v}`);
  }
}

console.log('\n注: 失敗の型 × 撮影条件でデコーダ改良の的を絞る。バースト融合は「連写→確実に1復元」の実用形。');
