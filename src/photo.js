// photo.js
// ─────────────────────────────────────────────────────────────
// 柱7 物理層: 視覚担体の「カメラ写真」アダプタ — finder + 透視補正(依存ゼロ)
// ─────────────────────────────────────────────────────────────
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4 / §7(傾き/透視・finder)。
//
// image.js は「位置・尺度・向きが既知の格子」を前提に読む(extractImage)。
// 実カメラ写真は位置・回転・傾き(透視)が未知 — そこを埋めるのが本モジュール。
//   発行: renderScannable(cord) … 4 隅に finder(位置検出パターン)を足した実 PNG。
//   劣化: simulatePhoto(png, …)  … 回転・透視・並進・背景・光学劣化を模す(実カメラの前段)。
//   受信: scanPhoto(png)         … finder を検出 → ホモグラフィで補正 → モジュール再標本 → cord。
//
// 役割分担(プロジェクト第三条): 本モジュールは「目」(幾何の頑健化)に徹し、
// 暗号判定はしない。誤り訂正は HC2 と同じ RS(image.js 経由 matrixToCord)に委ねる。
//
// 北極星(依存ゼロ): PNG=node:zlib(image.js)。Otsu 2値化・連結成分・ホモグラフィ(8元
// ガウス消去)・バイリニア標本はすべて自前。新しい暗号も重い CV ライブラリも持ち込まない。
//
// 既知の射程(この増分): 面内回転 ≲ ±45°(4 隅 finder が同一形のため向きの曖昧性が出る限界)、
//   中程度の透視・光学劣化まで。実カメラ撮影・有機担体・録画リプレイ耐性(動画 ratchet)は継続。

import { cordToMatrix, matrixToCord, encodePng, decodePng, mulberry32, boxBlur, ImageCarrierError } from './image.js';

const SCALE = 4;   // 1 モジュール = SCALE×SCALE px
const QUIET = 4;   // 静寂帯(モジュール)
const FINDER = 6;  // finder 正方(モジュール辺長)。4 隅に solid black
const GAP = 2;     // finder とデータ領域の白セパレータ(モジュール)
const BORDER = FINDER + GAP; // データ領域は各辺から BORDER モジュール内側

/** 写真からの読み取り失敗(finder 不検出・補正破綻)を表す例外。 */
export class PhotoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhotoError';
  }
}

// ── 発行: finder 付き担体を実 PNG へ ───────────────────────────
// 総格子 T×T = データ N×N + 四辺 BORDER。四隅に FINDER×FINDER の solid finder。
function placeFinder(grid, T, cx0, cy0) {
  for (let y = 0; y < FINDER; y++) {
    for (let x = 0; x < FINDER; x++) grid[(cy0 + y) * T + (cx0 + x)] = 1;
  }
}

/**
 * renderScannable: cord → finder 付き実 PNG(カメラ写真から読める担体)。
 * @param {object} cord
 * @returns {{png:Buffer, modules:number, total:number, side:number}}
 */
export function renderScannable(cord) {
  const { matrix, n } = cordToMatrix(cord);
  const T = n + 2 * BORDER;
  const grid = new Uint8Array(T * T); // 0=白,1=黒
  // データを内側へ配置
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      grid[(BORDER + my) * T + (BORDER + mx)] = matrix[my * n + mx];
    }
  }
  // 四隅 finder
  placeFinder(grid, T, 0, 0);
  placeFinder(grid, T, T - FINDER, 0);
  placeFinder(grid, T, 0, T - FINDER);
  placeFinder(grid, T, T - FINDER, T - FINDER);
  // ピクセル化(静寂帯込み)
  const side = (T + 2 * QUIET) * SCALE;
  const pixels = Buffer.alloc(side * side, 255);
  for (let my = 0; my < T; my++) {
    for (let mx = 0; mx < T; mx++) {
      if (!grid[my * T + mx]) continue;
      const x0 = (QUIET + mx) * SCALE;
      const y0 = (QUIET + my) * SCALE;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = (y0 + dy) * side + x0;
        pixels.fill(0, row, row + SCALE);
      }
    }
  }
  return { png: encodePng(pixels, side, side), modules: n, total: T, side };
}

// ── ホモグラフィ(4 点対応・8 元ガウス消去・依存ゼロ)────────────
// src[i]=(x,y) → dst[i]=(X,Y) を満たす射影変換 H を解き、適用関数を返す。
function solveHomography(src, dst) {
  // 8 未知数 h0..h7(h8=1)。各点で 2 式。A h = b。
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  const h = gauss8(A, b);
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h;
  return (x, y) => {
    const d = h6 * x + h7 * y + 1;
    return [(h0 * x + h1 * y + h2) / d, (h3 * x + h4 * y + h5) / d];
  };
}
function gauss8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // 部分ピボット
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) throw new PhotoError('degenerate homography (collinear finders?)');
    [M[col], M[piv]] = [M[piv], M[col]];
    const inv = 1 / M[col][col];
    for (let c = col; c <= n; c++) M[col][c] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

// バイリニア標本(グレースケール)。範囲外は 255(白)。
function sampleBilinear(pixels, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 255;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = pixels[y0 * w + x0];
  const p10 = pixels[y0 * w + x1];
  const p01 = pixels[y1 * w + x0];
  const p11 = pixels[y1 * w + x1];
  return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
}

// ── 劣化: 担体 PNG を「写真」へ(回転・透視・並進・背景・光学)──────
/**
 * simulatePhoto: 担体 PNG を、傾けた机/画面を撮った写真風 PNG に変換する(実カメラ前段)。
 * @param {Buffer} png 担体(renderScannable の出力)
 * @param {{scale?:number, rotateDeg?:number, tiltX?:number, tiltY?:number, tx?:number, ty?:number,
 *          canvas?:number, background?:number, blur?:number, brightness?:number, noise?:number, seed?:number}} [opts]
 * @returns {Buffer} 写真風 PNG(背景込み・劣化込み)
 */
export function simulatePhoto(png, opts = {}) {
  const { scale = 1, rotateDeg = 0, tiltX = 0, tiltY = 0, tx = 0, ty = 0,
    background = 210, blur = 0, brightness = 0, noise = 0, seed = 1 } = opts;
  const { w: cw, h: ch, pixels: carrier } = decodePng(png);
  const S = cw; // 担体は正方
  const canvas = Math.round((opts.canvas || S * 1.6));
  const cx = canvas / 2 + tx;
  const cy = canvas / 2 + ty;
  const half = (S / 2) * scale;

  // 担体4隅(TL,TR,BR,BL)を、傾き(keystone)→回転→並進した行き先へ。
  let corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
  corners = corners.map(([x, y]) => {
    // keystone: 上辺/左辺を縮めて見下ろし/斜めを模す。
    const ky = 1 - tiltY * (y < 0 ? 1 : 0); // 上辺(y<0)を tiltY 縮小
    const kx = 1 - tiltX * (x < 0 ? 1 : 0); // 左辺(x<0)を tiltX 縮小
    return [x * ky, y * kx];
  });
  const th = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const dest = corners.map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  const carrierCorners = [[0, 0], [S - 1, 0], [S - 1, S - 1], [0, S - 1]];

  // 逆ワープ(scene→carrier)。各 scene 画素に carrier 画素を引き戻し、穴を作らない。
  const sceneToCarrier = solveHomography(dest, carrierCorners);
  let pixels = Buffer.alloc(canvas * canvas, background);
  for (let Y = 0; Y < canvas; Y++) {
    for (let X = 0; X < canvas; X++) {
      const [x, y] = sceneToCarrier(X + 0.5, Y + 0.5);
      if (x >= 0 && y >= 0 && x <= cw - 1 && y <= ch - 1) {
        pixels[Y * canvas + X] = Math.round(sampleBilinear(carrier, cw, ch, x, y));
      }
    }
  }

  // 光学劣化(撮影で起きる photometric な劣化)。
  if (blur > 0) pixels = boxBlur(pixels, canvas, canvas, blur);
  if (brightness !== 0) for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(0, Math.min(255, pixels[i] + brightness));
  if (noise > 0) {
    const rng = mulberry32(seed);
    for (let i = 0; i < pixels.length; i++) if (rng() < noise) pixels[i] = rng() < 0.5 ? 0 : 255;
  }
  return encodePng(pixels, canvas, canvas);
}

// ── 受信: Otsu 2値化 → finder 検出 → 補正 → 標本 → cord ──────────
function otsuThreshold(pixels) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i++) hist[pixels[i]]++;
  const total = pixels.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// 黒(< thr)の連結成分(4近傍)を列挙。各成分の面積・bbox・重心を返す。
function connectedComponents(pixels, w, h, thr) {
  const label = new Int32Array(w * h).fill(0);
  const comps = [];
  const stack = new Int32Array(w * h);
  let cur = 0;
  for (let start = 0; start < w * h; start++) {
    if (pixels[start] > thr || label[start] !== 0) continue; // 前景=暗(<=thr)。2値画像で thr=0 でも拾う
    cur++;
    let sp = 0;
    stack[sp++] = start;
    label[start] = cur;
    let area = 0;
    let minx = w;
    let maxx = 0;
    let miny = h;
    let maxy = 0;
    let sx = 0;
    let sy = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p - px) / w;
      area++;
      sx += px;
      sy += py;
      if (px < minx) minx = px;
      if (px > maxx) maxx = px;
      if (py < miny) miny = py;
      if (py > maxy) maxy = py;
      // 4 近傍(前景=暗 <=thr)
      if (px > 0 && pixels[p - 1] <= thr && label[p - 1] === 0) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (px < w - 1 && pixels[p + 1] <= thr && label[p + 1] === 0) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (py > 0 && pixels[p - w] <= thr && label[p - w] === 0) { label[p - w] = cur; stack[sp++] = p - w; }
      if (py < h - 1 && pixels[p + w] <= thr && label[p + w] === 0) { label[p + w] = cur; stack[sp++] = p + w; }
    }
    const bw = maxx - minx + 1;
    const bh = maxy - miny + 1;
    comps.push({ area, bw, bh, cx: sx / area, cy: sy / area, fill: area / (bw * bh), aspect: bw / bh });
  }
  return comps;
}

// finder 候補: solid(高 fill)・正方(aspect≈1)・適度な大きさ。4 隅へ割り当て。
function findFinders(pixels, w, h, thr) {
  const comps = connectedComponents(pixels, w, h, thr);
  // minArea は絶対値(極小ノイズ/塩胡椒の単画素を除く)。finder の絶対サイズはモジュール尺に依り
  // 画像全体に依らないので、画像サイズ比で決めると大きい担体で finder を弾く(=バグだった)。
  const minArea = 30;
  const maxBox = Math.min(w, h) * 0.4; // データ全域の巨大連結塊を除外
  // solid 正方 finder: 充填率は回転で 1/(cos+sin)² まで下がる(45°で 0.5)。0.5 まで許して
  // 回転 ≲±40° を射程に。aspect は回転正方の AABB が正方に近いまま=1 付近で絞る。
  const cand = comps.filter((c) =>
    c.area >= minArea && c.fill >= 0.5 && c.aspect >= 0.72 && c.aspect <= 1.38 &&
    c.bw <= maxBox && c.bh <= maxBox);
  if (cand.length < 4) throw new PhotoError(`finder candidates < 4 (got ${cand.length})`);
  // finder は担体の物理的な四隅 = データより必ず外側 → 各隅方向の極値が finder。
  //   TL=min(x+y), BR=max(x+y), TR=max(x-y), BL=min(x-y)。中央値プールは不要(大 N で誤排除する)。
  const pick = (score, want) => {
    let bestC = cand[0];
    let bestV = want === 'max' ? -Infinity : Infinity;
    for (const c of cand) {
      const v = score(c);
      if ((want === 'max' && v > bestV) || (want === 'min' && v < bestV)) { bestV = v; bestC = c; }
    }
    return bestC;
  };
  const TL = pick((c) => c.cx + c.cy, 'min');
  const BR = pick((c) => c.cx + c.cy, 'max');
  const TR = pick((c) => c.cx - c.cy, 'max');
  const BL = pick((c) => c.cx - c.cy, 'min');
  const uniq = new Set([TL, BR, TR, BL]);
  if (uniq.size !== 4) throw new PhotoError('finder corner assignment collided (rotation > limit?)');
  // modulePx は面積から(面積は回転不変。bbox 幅は回転で √2 方向に膨らみ過大推定になる)。
  const modulePx = (Math.sqrt(TL.area) + Math.sqrt(TR.area) + Math.sqrt(BL.area) + Math.sqrt(BR.area)) / 4 / FINDER;
  return { TL, TR, BR, BL, modulePx };
}

/**
 * scanPhoto: 写真風 PNG → cord。finder 検出 → ホモグラフィ補正 → モジュール再標本 → RS 復号。
 *   N(データ辺長)は finder 間隔から推定し、ヘッダ magic が通る候補を採る(自己修正)。
 * @param {Buffer} png
 * @returns {object} cord
 */
export function scanPhoto(png) {
  const { w, h, pixels } = decodePng(png);
  const thr = otsuThreshold(pixels);
  const { TL, TR, BR, BL, modulePx } = findFinders(pixels, w, h, thr);

  // finder 中心(モジュール座標 (3,3),(T-3,3),(T-3,T-3),(3,T-3))を単位正方へ。
  const H = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]],
    [[TL.cx, TL.cy], [TR.cx, TR.cy], [BR.cx, BR.cy], [BL.cx, BL.cy]]);

  // finder 中心間隔(モジュール)= (T-6) = (N+10)。画素間隔/modulePx から N を推定。
  const distTLTR = Math.hypot(TR.cx - TL.cx, TR.cy - TL.cy);
  const distTLBL = Math.hypot(BL.cx - TL.cx, BL.cy - TL.cy);
  const spanMod = ((distTLTR + distTLBL) / 2) / modulePx; // ≈ N+10
  const nEst = Math.round(spanMod - 10);

  // データ module (mx,my) の単位座標: ((5.5+mx)/(N+10), (5.5+my)/(N+10))。
  // N は推定 nEst の周辺をブルートフォース探索し、ヘッダ magic+RS が通る最初を採る。
  //   しきい値化で finder 面積にバイアスが乗り nEst が数モジュールずれ得るため広めに探索。
  //   誤った N は乱数同然のビットになり、magic(0x48)+版+RS+本体RS+JSON を全通過する確率は
  //   無視できる(=自己修正が安全に成立する)。中心位置(ホモグラフィ)は正確なのが前提。
  const order = [];
  for (let d = 0; d <= 20; d++) { order.push(d); if (d) order.push(-d); }
  let lastErr = null;
  for (const dn of order) {
    const N = nEst + dn;
    if (N < 1) continue;
    const denom = N + 10;
    const bits = new Uint8Array(N * N);
    for (let my = 0; my < N; my++) {
      for (let mx = 0; mx < N; mx++) {
        const [px, py] = H((5.5 + mx) / denom, (5.5 + my) / denom);
        bits[my * N + mx] = sampleBilinear(pixels, w, h, px, py) <= thr ? 1 : 0;
      }
    }
    try {
      return matrixToCord(bits);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new PhotoError('decode failed for all N candidates near ' + nEst +
    (lastErr ? ' (' + lastErr.message + ')' : ''));
}

export { ImageCarrierError };
