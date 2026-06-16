// tools/real-camera/fuse-bursts.mjs
// 印刷実写: 単フレーム全敗(0/15)でも、連写バーストを融合(scanPhotoMulti)すれば
//   モアレ(フレーム間で位相がずれる)や局所バンディングを相殺できるか測る。
//   measure.mjs は単フレーム成功>0 でないと融合に入らないので、ここで明示的にバースト分けして回す。
// 実行: node tools/real-camera/fuse-bursts.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { open } from '../../src/cord.js';
import { scanPhotoMulti, PhotoError } from '../../src/photo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// 実行: node fuse-bursts.mjs [photosDir] [carriersDir]
const dir = process.argv[2] || join(HERE, 'photos-print');
const carriersDir = process.argv[3] || join(HERE, 'carriers');
const manifest = JSON.parse(readFileSync(join(carriersDir, 'manifest.json'), 'utf8'));

// 撮影時刻クラスタ = バースト = 担体。ファイル名 yyyymmddHHMMSS の秒で 3 群に割る。
const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
// 連続する撮影を「30 秒以上の空き」で区切る。
function tsOf(f) { const m = f.match(/(\d{14})/); return m ? Number(m[1].slice(8)) : 0; } // HHMMSS
const bursts = [];
let cur = [];
let prev = null;
for (const f of files) {
  const t = tsOf(f);
  const hms = (h) => (h % 100) + Math.floor(h / 100 % 100) * 60 + Math.floor(h / 10000) * 3600;
  if (prev !== null && hms(t) - hms(prev) > 30) { bursts.push(cur); cur = []; }
  cur.push(f); prev = t;
}
if (cur.length) bursts.push(cur);

console.log(`${files.length} 枚を ${bursts.length} バーストに分割:\n`);
for (const b of bursts) console.log('  [' + b.map((f) => f.match(/(\d{14})/)[1].slice(8)).join(', ') + ']');

for (const sub of [3, 5]) {
  console.log(`\n=== subsamples=${sub} でバースト融合 ===`);
  for (const b of bursts) {
    const pngs = b.map((f) => readFileSync(join(dir, f)));
    let verdict;
    try {
      const back = scanPhotoMulti(pngs, { subsamples: sub });
      const c = manifest.carriers.find((c) => c.tip === back.tip);
      if (!c) verdict = `△ デコード成功・manifest 外 tip(${back.tip.slice(0, 10)}…)`;
      else if (open(back, manifest.secret) === c.text) verdict = `✓ ${c.id} 復元+平文一致 → "${c.text}"`;
      else verdict = `△ ${c.id} tip 一致だが open 不一致`;
    } catch (e) {
      verdict = `✗ ${e instanceof PhotoError ? 'PhotoError' : e.name}: ${e.message}`;
    }
    console.log(`  ${b[0].slice(8, 14)} burst(${b.length}枚) → ${verdict}`);
  }
}
