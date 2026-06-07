// tools/real-camera/measure.mjs
// 柱7 実カメラ測定キット ③: 撮影写真(PNG)を scanPhoto で復号できるか測り、復元率を出す。
//   JPEG 写真は先に convert-to-png.ps1 で PNG 化しておく(コアは PNG・依存ゼロを保つ)。
//   写真ファイル名は <carrierId>__<任意>.png(例 p2-prod__straight.png)= prefix で担体を引く。
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
const byId = new Map(manifest.carriers.map((c) => [c.id, c]));

const photos = readdirSync(photosDir).filter((f) => /\.png$/i.test(f));
if (photos.length === 0) {
  console.error(`${photosDir} に PNG がありません(JPEG は convert-to-png.ps1 で PNG 化してください)。`);
  process.exit(1);
}

// 担体ごとに写真をまとめる(prefix = '__' の前)。
const groups = new Map();
for (const f of photos) {
  const id = f.replace(/\.png$/i, '').split('__')[0];
  if (!byId.has(id)) { console.warn(`(skip) ${f}: manifest に担体 "${id}" が無い`); continue; }
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(f);
}

let total = 0, okSingle = 0;
const fuseRows = [];
for (const [id, files] of groups) {
  const c = byId.get(id);
  console.log(`\n■ ${id}  データ ${c.dataModules}² / 撮影総 ${c.captureModules} モジュール(期待 tip ${c.tip.slice(0, 12)}…)`);
  const pngs = [];
  for (const f of files.sort()) {
    total++;
    let verdict;
    try {
      const png = readFileSync(join(photosDir, f));
      pngs.push(png);
      const back = scanPhoto(png);
      if (back.tip !== c.tip) verdict = '✗ tip 不一致(別担体/誤デコード)';
      else if (open(back, manifest.secret) === c.text) { verdict = '✓ 復元+平文一致'; okSingle++; }
      else verdict = '△ tip 一致だが open 不一致';
    } catch (e) {
      verdict = (e instanceof PhotoError ? '✗ ' : '✗! ') + e.name + ': ' + e.message;
    }
    console.log(`   ${f.padEnd(30)} ${verdict}`);
  }
  // 同一担体の複数写真をフレーム融合(§5.11/§5.14)。実カメラで融合が効くかを見る。
  if (pngs.length >= 2) {
    let v;
    try {
      const b = scanPhotoMulti(pngs);
      v = (b.tip === c.tip && open(b, manifest.secret) === c.text) ? '✓ 復元' : '△ 不一致';
    } catch (e) { v = '✗ ' + (e.message || e.name); }
    console.log(`   └ 融合(${pngs.length} 枚)${' '.repeat(Math.max(1, 20 - String(pngs.length).length))}${v}`);
    fuseRows.push(`${id}: ${v}`);
  }
}

console.log(`\n=== 単フレーム復元率: ${okSingle}/${total}` + (total ? ` (${Math.round((okSingle / total) * 100)}%)` : '') + ' ===');
if (fuseRows.length) console.log('融合: ' + fuseRows.join(' / '));
console.log('\n失敗の型(PhotoError = 媒体層で読めず / CordTamper = 改ざん扱い)を見て、実カメラ特有のギャップ');
console.log('(JPEG ノイズ・実レンズ歪み・照明勾配・焦点・グレア・モアレ)をデコーダ改良の的にする。');
