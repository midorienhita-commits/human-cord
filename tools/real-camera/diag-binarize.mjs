// tools/real-camera/diag-binarize.mjs
// 失敗解剖: 実印刷写真が scanPhoto の媒体層で落ちる原因を「2値化画像」で目視する診断。
//   scanPhoto はグローバル Otsu を使う。印刷紙を室内光で撮ると照明勾配が乗り、グローバル閾値は
//   暗い隅で白紙を黒に塗り、明るい隅で黒モジュールを白に飛ばす。ここでそれを可視化する。
//   出力: <photo>.otsu.png(グローバル Otsu)/ <photo>.adapt.png(局所平均=適応 2値化)。
// 実行: node tools/real-camera/diag-binarize.mjs <photo.png> [more.png ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from '../../src/image.js';

function otsu(pixels) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) hist[pixels[i]]++;
  const total = pixels.length;
  let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// 積分画像による局所平均適応 2値化(Bradley)。window=radius, t=暗側マージン%。
function adaptiveBradley(pixels, w, h, radius, pct) {
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    for (let x = 0; x < w; x++) {
      rs += pixels[y * w + x];
      integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rs;
    }
  }
  const out = Buffer.alloc(w * h, 255);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(w - 1, x + radius);
      const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integ[(y1 + 1) * (w + 1) + (x1 + 1)] - integ[y0 * (w + 1) + (x1 + 1)]
        - integ[(y1 + 1) * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      const mean = s / cnt;
      out[y * w + x] = pixels[y * w + x] <= mean * (1 - pct) ? 0 : 255;
    }
  }
  return out;
}

function quadMeans(pixels, w, h) {
  const q = [0, 0, 0, 0], c = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1);
    q[idx] += pixels[y * w + x]; c[idx]++;
  }
  return q.map((s, i) => Math.round(s / c[i]));
}

for (const path of process.argv.slice(2)) {
  const { w, h, pixels } = decodePng(readFileSync(path));
  const thr = otsu(pixels);
  const qm = quadMeans(pixels, w, h);
  const grad = Math.max(...qm) - Math.min(...qm);
  console.log(`\n${path}  ${w}x${h}`);
  console.log(`  global Otsu thr=${thr}  quad means TL=${qm[0]} TR=${qm[1]} BL=${qm[2]} BR=${qm[3]}  gradient=${grad}`);
  // グローバル Otsu 2値化
  const bin = Buffer.alloc(w * h);
  for (let i = 0; i < pixels.length; i++) bin[i] = pixels[i] <= thr ? 0 : 255;
  writeFileSync(path.replace(/\.png$/i, '.otsu.png'), encodePng(bin, w, h));
  // 適応 2値化(半径 = 担体辺の ~1/24 を目安。ここでは固定 24px だが小さければ後で調整)
  const radius = Math.max(8, Math.round(Math.min(w, h) / 40));
  const adapt = adaptiveBradley(pixels, w, h, radius, 0.10);
  writeFileSync(path.replace(/\.png$/i, '.adapt.png'), encodePng(adapt, w, h));
  console.log(`  wrote .otsu.png and .adapt.png (adaptive radius=${radius})`);
}
