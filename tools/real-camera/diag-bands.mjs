// diag-bands.mjs: 横帯が「情報破壊(行が全黒に潰れた)」か「ただ暗いだけ(復元可能)」かを判定。
//   各行(中央クロップ)の平均輝度と標準偏差を出す。
//   - clean 行: 黒(~30)と白(~200)が混在 → 平均=中, 標準偏差=高
//   - 破壊バー: 全部黒に潰れた     → 平均=低, 標準偏差=低
//   - 暗いだけ: フリッカ/影で暗いが黒白の差は残る → 平均=低, 標準偏差=高(=再撮影/閾値で復元可)
//   さらに帯の縦周期(フリッカ=規則的, データ起因=不規則)も FFT 無しの自己相関で粗く見る。
// 実行: node tools/real-camera/diag-bands.mjs <photo.png> [more...]
import { readFileSync } from 'node:fs';
import { decodePng } from '../../src/image.js';

for (const path of process.argv.slice(2)) {
  const { w, h, pixels } = decodePng(readFileSync(path));
  // 中央 60% を解析(データ領域。finder/余白を避ける)。
  const x0 = (w * 0.2) | 0, x1 = (w * 0.8) | 0, y0 = (h * 0.2) | 0, y1 = (h * 0.8) | 0;
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let s = 0, s2 = 0, n = 0;
    for (let x = x0; x < x1; x++) { const v = pixels[y * w + x]; s += v; s2 += v * v; n++; }
    const mean = s / n, std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    rows.push({ y, mean, std });
  }
  const meanAll = rows.reduce((a, r) => a + r.mean, 0) / rows.length;
  const stdAll = rows.reduce((a, r) => a + r.std, 0) / rows.length;
  // 「暗い行」= 平均が全体平均の 0.7 未満。その中で std が保たれているか(復元可能の指標)。
  const darkRows = rows.filter((r) => r.mean < meanAll * 0.72);
  const darkStdMed = darkRows.length
    ? darkRows.map((r) => r.std).sort((a, b) => a - b)[darkRows.length >> 1] : 0;
  console.log(`\n${path}  ${w}x${h}  (解析: 中央60%, ${rows.length}行)`);
  console.log(`  行平均輝度: 全体平均=${meanAll.toFixed(0)}  行std中央値=${stdAll.toFixed(0)}`);
  console.log(`  暗い行(<0.72×平均): ${darkRows.length}/${rows.length} 行  そのstd中央値=${darkStdMed.toFixed(0)}`);
  const recoverable = darkStdMed > stdAll * 0.6;
  console.log(`  → 暗い行は ${recoverable ? '★復元可能(黒白の差が残存=撮影/閾値の問題=再撮影で直る公算)'
    : '✗ 情報破壊(全黒に潰れた=印刷or露出で実損=その帯は復元不能)'}`);
  // 縦プロファイルを 48 段にダウンサンプルして可視化(▁▂▃▄▅▆▇█)。
  const bars = '▁▂▃▄▅▆▇█';
  const K = 64, prof = new Array(K).fill(0), cnt = new Array(K).fill(0);
  rows.forEach((r, i) => { const b = (i * K / rows.length) | 0; prof[b] += r.mean; cnt[b]++; });
  const pv = prof.map((v, i) => v / (cnt[i] || 1));
  const lo = Math.min(...pv), hi = Math.max(...pv);
  const spark = pv.map((v) => bars[Math.min(7, Math.max(0, ((v - lo) / (hi - lo + 1e-9) * 7) | 0))]).join('');
  console.log(`  行平均輝度プロファイル(上→下, 暗=低): ${spark}`);
  // 帯の規則性: 行平均を平均除去して自己相関のピーク周期を粗探索。
  const dm = rows.map((r) => r.mean - meanAll);
  let bestLag = 0, bestC = -Infinity;
  for (let lag = 8; lag < rows.length / 3; lag++) {
    let c = 0; for (let i = 0; i + lag < dm.length; i++) c += dm[i] * dm[i + lag];
    if (c > bestC) { bestC = c; bestLag = lag; }
  }
  console.log(`  帯の卓越周期 ≈ ${bestLag}px(規則的なら フリッカ/レーザー周期, 不規則なら データ起因の疑い)`);
}
