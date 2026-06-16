// rescue-flicker.mjs: 横フリッカー帯(LED×ローリングシャッター)を画像行ごとに正規化して
//   既存写真を復号できるか試す。フリッカーは「センサ行=画像行」ごとに輝度をスケールする(帯は
//   画像内で水平・担体の傾きに依らない)。よって各画像行を、その行の白基準(高percentile)で割れば平らになる。
//   担体の回転には無依存(行スカラ補正のみ・モジュールを横に滲ませない)。
// 実行: node tools/real-camera/rescue-flicker.mjs <carriersDir>   (既定 carriers, 写真は photos-print)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodePng, encodePng } from '../../src/image.js';
import { scanPhoto, scanPhotoMulti, PhotoError } from '../../src/photo.js';
import { open } from '../../src/cord.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const carriersDir = process.argv[2] || join(HERE, 'carriers');
const photosDir = join(HERE, 'photos-print');
const manifest = JSON.parse(readFileSync(join(carriersDir, 'manifest.json'), 'utf8'));
const byTip = new Map(manifest.carriers.map((c) => [c.tip, c]));

// 各画像行を白基準(中央60%列の高percentile)で正規化してフリッカーを平らにする。
function deflicker(png, pct = 0.80, smoothY = 5) {
  const { w, h, pixels } = decodePng(png);
  const x0 = (w * 0.2) | 0, x1 = (w * 0.8) | 0;
  const white = new Float64Array(h);
  const buf = new Uint8Array(x1 - x0);
  for (let y = 0; y < h; y++) {
    for (let x = x0; x < x1; x++) buf[x - x0] = pixels[y * w + x];
    const s = Uint8Array.from(buf).sort();
    white[y] = s[Math.min(s.length - 1, (s.length * pct) | 0)] || 1;
  }
  // 行白基準を縦に少し平滑(行ノイズ抑制・フリッカ本体は残す)。
  const sm = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let a = 0, n = 0;
    for (let d = -smoothY; d <= smoothY; d++) { const yy = y + d; if (yy >= 0 && yy < h) { a += white[yy]; n++; } }
    sm[y] = a / n;
  }
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const g = 200 / Math.max(20, sm[y]); // 白を ~200 に揃える(暗い帯の行ほど強く持ち上がる)
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = Math.max(0, Math.min(255, Math.round(pixels[row + x] * g)));
  }
  return encodePng(out, w, h);
}

const files = readdirSync(photosDir).filter((f) => /\.png$/i.test(f)).sort();
function tsOf(f) { const m = f.match(/(\d{14})/); return m ? Number(m[1].slice(8)) : 0; }
const hms = (h) => (h % 100) + Math.floor(h / 100 % 100) * 60 + Math.floor(h / 10000) * 3600;
const bursts = []; let cur = []; let prev = null;
for (const f of files) { const t = tsOf(f); if (prev !== null && hms(t) - hms(prev) > 30) { bursts.push(cur); cur = []; } cur.push(f); prev = t; }
if (cur.length) bursts.push(cur);

console.log(`deflicker(行正規化)後に復号を試す。photos=${files.length} 枚 / ${bursts.length} バースト\n`);

// 単フレーム
let ok = 0;
const deflickered = new Map();
for (const f of files) {
  const dp = deflicker(readFileSync(join(photosDir, f)));
  deflickered.set(f, dp);
  let line;
  try {
    const back = scanPhoto(dp);
    const c = byTip.get(back.tip);
    if (c && open(back, manifest.secret) === c.text) { ok++; line = `✓ ${c.id} 復元+平文一致`; }
    else if (c) line = `△ ${c.id} tip一致 open不一致`;
    else line = `△ manifest外 tip ${back.tip.slice(0, 10)}…`;
  } catch (e) { line = `✗ ${e instanceof PhotoError ? 'PhotoError' : e.name}`; }
  console.log(`  ${f.slice(8, 14)} ${line}`);
}
console.log(`\n単フレーム(deflicker後): ${ok}/${files.length}`);

console.log(`\n--- バースト融合(deflicker後)---`);
for (const b of bursts) {
  const pngs = b.map((f) => deflickered.get(f));
  let v;
  try {
    const back = scanPhotoMulti(pngs);
    const c = byTip.get(back.tip);
    v = c && open(back, manifest.secret) === c.text ? `✓ ${c.id} 復元+平文一致 → "${c.text}"`
      : c ? `△ ${c.id} tip一致 open不一致` : `△ manifest外 tip`;
  } catch (e) { v = `✗ ${e.message}`; }
  console.log(`  ${b[0].slice(8, 14)} burst(${b.length}枚) → ${v}`);
}

// 1 枚だけ deflicker 結果を保存(目視用)。
if (files[0]) { writeFileSync(join(photosDir, files[0].replace(/\.png$/, '.deflick.png')), deflickered.get(files[0])); console.log(`\n${files[0]} の deflicker 画像を .deflick.png に保存(目視用)`); }
