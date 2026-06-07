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
// 既知の射程: 面内回転 0–360° 全周(§5.9 TL リング=キラリティで向き曖昧性を解消)+ 鏡像、
//   中程度の透視・光学劣化まで。1 モジュールを k×k の小格子で標本し多数決(§5.10 高 N 頑健化)=
//   塩胡椒ノイズ・格子レジストレーション誤差に強い(`scanPhoto(png,{subsamples})` 既定 3×3)。
//   実カメラ撮影・端末内 AI 抽出・有機担体・録画リプレイ耐性(動画 ratchet)は継続。

import { cordToMatrix, matrixToCord, encodePng, decodePng, mulberry32, boxBlur, ImageCarrierError } from './image.js';

const SCALE = 4;   // 1 モジュール = SCALE×SCALE px
const QUIET = 4;   // 静寂帯(モジュール)
const FINDER = 7;  // finder 正方(モジュール辺長)。4 隅。うち TL だけ「リング(中央に穴)」
const RING_HOLE = 3; // TL finder の中央に空ける白い穴(モジュール辺長・中央寄せ)
const GAP = 2;     // finder とデータ領域の白セパレータ(モジュール)
const BORDER = FINDER + GAP; // データ領域は各辺から BORDER モジュール内側

// 撮影時にカメラが捉える、データ外の固定モジュール数(両辺合計)= finder+GAP+静寂帯。
// renderScannable の総辺は N + 2*BORDER、撮影される PNG は静寂帯込み N + 2*(BORDER+QUIET)。
// 可読性バジェット(src/budget.js)が「担体を横切る画素 ÷ px/module」で参照する単一の真実。
export const SCANNABLE_OVERHEAD_MODULES = 2 * (BORDER + QUIET); // = 26

/** 写真からの読み取り失敗(finder 不検出・補正破綻)を表す例外。 */
export class PhotoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PhotoError';
  }
}

// ── 発行: finder 付き担体を実 PNG へ ───────────────────────────
// 総格子 T×T = データ N×N + 四辺 BORDER。四隅に FINDER×FINDER の finder。
// うち TL だけ「リング」(中央に白い穴)= キラリティ標識: 重心ピクセルが白になり、回転・尺度・
// 透視に不変なトポロジー特徴として「どれが物理 TL か」を一意に決める(四隅同形の向き曖昧性を破る)。
function placeFinder(grid, T, cx0, cy0, ring = false) {
  for (let y = 0; y < FINDER; y++) {
    for (let x = 0; x < FINDER; x++) grid[(cy0 + y) * T + (cx0 + x)] = 1;
  }
  if (ring) {
    const off = (FINDER - RING_HOLE) >> 1; // 中央寄せ
    for (let y = 0; y < RING_HOLE; y++) {
      for (let x = 0; x < RING_HOLE; x++) grid[(cy0 + off + y) * T + (cx0 + off + x)] = 0; // 穴=白
    }
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
  // 四隅 finder。TL(左上)だけリング(キラリティ標識)。
  placeFinder(grid, T, 0, 0, true); // TL = リング
  placeFinder(grid, T, T - FINDER, 0);
  placeFinder(grid, T, 0, T - FINDER);
  placeFinder(grid, T, T - FINDER, T - FINDER);
  // 自己クロック(timing ticks): データを囲む白い GAP リングの 4 辺に交互の黒モジュールを並べる。
  // 既知の単位座標に並ぶ基準点列 = 復号時にレンズ放射歪み(ホモグラフィでは表せない曲がり)を
  // プラムライン法(=「直線は直線のまま」を最も満たす歪み係数を探す)で推定し補正する手掛かり。
  // 種 docs/seed-bio-analogies.md §3「二重らせんのひねりの周期=自己クロック(timing pattern)」。
  // データ列/行に整列して置き(=単位座標が既知)、データ・finder・幾何定数(BORDER/denom)は無改変。
  // リング(modules 7 と T-8)はデータ(modules 9..T-10)とも finder(中央寄りは白)とも 1 モジュール白で離れる。
  const tickLo = FINDER;        // = 7(上辺/左辺の tick リング)
  const tickHi = T - 1 - FINDER; // = N+10(下辺/右辺の tick リング)
  for (let i = 0; i < n; i += 2) { // 交互(偶数データ index が黒)
    const d = BORDER + i; // データ列/行の絶対モジュール(9..N+8)
    grid[tickLo * T + d] = 1; // 上辺(行 tickLo)
    grid[tickHi * T + d] = 1; // 下辺(行 tickHi)
    grid[d * T + tickLo] = 1; // 左辺(列 tickLo)
    grid[d * T + tickHi] = 1; // 右辺(列 tickHi)
  }
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

// ── 放射状レンズ歪み(division model・依存ゼロ)──────────────────
// 実カメラのレンズは光線を放射状に曲げる(樽型/糸巻き型)。これは透視変換(ホモグラフィ)
// では表せない曲がりで、4 隅 finder で合わせた単一ホモグラフィは「隅で正しく内側でズレる」。
// 高 N(モジュール ≈3.6px)では僅かなズレでも標本点が隣モジュールに落ちて復号が破綻する。
//
// モデルは Fitzgibbon の division model(歪み中心 c のまわり、正規化半径 R):
//   undistort(歪んだ点 p → 理想点): ideal = c + (p-c) / (1 + k·ρ²),  ρ=|p-c|/R
//   distort(理想点 q → 歪んだ点):    r_u=|q-c|/R を満たす r_d を ru = s/(1+k s²) から解く(s=r_d/R)。
// 中心 c と只 1 つの係数 k で表す素朴な 1 次モデル(計算非依存性: 鉄板技術のみ)。係数の意味は
// κ=k/R² だけ(R は正規化の自由度)ので、シミュレータと復号で R が違っても同じ歪み場を再現できる。
function lensUndistort(x, y, cx, cy, R, k) {
  const dx = x - cx;
  const dy = y - cy;
  const f = 1 / (1 + k * (dx * dx + dy * dy) / (R * R));
  return [cx + dx * f, cy + dy * f];
}
function lensDistort(x, y, cx, cy, R, k) {
  if (k === 0) return [x, y];
  const dx = x - cx;
  const dy = y - cy;
  const ru = Math.hypot(dx, dy) / R;
  if (ru < 1e-9) return [x, y];
  const disc = 1 - 4 * k * ru * ru;
  if (disc <= 0) return [x, y]; // 過大歪み: 安全側で素通し(復号は別経路で失敗する)
  const s = (1 - Math.sqrt(disc)) / (2 * k * ru); // 小さい根(k→0 で s→ru)
  const f = s / ru; // = r_d / r_u
  return [cx + dx * f, cy + dy * f];
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

// ── 多点標本 + 多数決(§5.10 高 N 頑健化)──────────────────────────
// 1 モジュールを中心 1 点でなく k×k の小格子で標本し、各点を 2 値化して多数決で 1 ビットを決める。
//   なぜ効くか:
//   - 塩胡椒ノイズ(simulatePhoto の noise= ランダム画素を 0/255 へ反転)は各点で独立。多数決は
//     過半数が反転しない限り正しい値を保つ → モジュール 1 個を倒すのに ⌈k²/2⌉ 点の反転が要る。
//   - 格子レジストレーション誤差(中心がモジュール境界寄りに落ちる)も、モジュール内部の周辺票が支配。
//   標本点はモジュール中央 ±span(中央 ~1-2·span の領域)に限定し、隣モジュールへ滲ませない。

/** k 点標本のオフセット列(モジュール幅に対する相対)。k≤1 は単点(中央)= 従来動作。 */
function subOffsets(k) {
  if (k <= 1) return [0];
  const span = 0.24; // 中央 ±0.24 モジュール(中央 ~48% 内)= 隣へ滲まない安全域
  const offs = [];
  for (let i = 0; i < k; i++) offs.push(-span + (2 * span * i) / (k - 1));
  return offs;
}

// 単位座標 (ucx,ucy) のモジュール 1 個を、ホモグラフィ H 越しに offs×offs 点標本し、暗い点の割合 ∈[0,1] を返す。
//   ustep = 1 モジュールの単位幅(=1/(N+11))。offs は subOffsets の相対オフセット列(offs=[0] は単点=従来動作)。
//   単一フレームは frac>0.5 で 2 値化(=フレーム内多数決)。複数フレーム融合(scanPhotoMulti)は frac を
//   フレーム横断で平均してから 2 値化する(soft 融合)= 各フレームの票を平等に混ぜ、少数フレームの
//   遮蔽(指・影・反射)やノイズを、多数のクリーンなフレームが押し返す(§5.11)。
function moduleDarkFrac(pixels, w, h, H, ucx, ucy, ustep, thr, offs) {
  let dark = 0;
  let total = 0;
  for (const oy of offs) {
    for (const ox of offs) {
      const [px, py] = H(ucx + ox * ustep, ucy + oy * ustep);
      if (sampleBilinear(pixels, w, h, px, py) <= thr) dark++;
      total++;
    }
  }
  return dark / total; // 暗い点の割合(過半数が暗 = >0.5)
}

// ── 劣化: 担体 PNG を「写真」へ(回転・透視・並進・背景・光学)──────
/**
 * simulatePhoto: 担体 PNG を、傾けた机/画面を撮った写真風 PNG に変換する(実カメラ前段)。
 * @param {Buffer} png 担体(renderScannable の出力)
 * @param {{scale?:number, rotateDeg?:number, tiltX?:number, tiltY?:number, tx?:number, ty?:number,
 *          canvas?:number, background?:number, blur?:number, brightness?:number, noise?:number, seed?:number,
 *          lensK?:number, occlude?:{x:number,y:number,w:number,h:number,value?:number}}} [opts]
 *   lensK = 放射状レンズ歪み係数(division model)。0=歪み無し(従来の純ホモグラフィ)。正=糸巻き型・
 *     負=樽型(中心まわり、正規化半径=キャンバス半幅)。実カメラの未モデル化要因 — ホモグラフィでは
 *     表せない曲がりを足す。歪み中心は担体中心(撮影が中心寄せ前提=正直な限界。tx/ty で偏心すると残差)。
 *   occlude = 指/影/反射で覆う矩形(キャンバス比 [0,1]、value=覆いの輝度・既定 30=暗い指)。フレームごとに
 *   位置を変えると「単フレームでは欠ける/複数フレーム融合で埋まる」を作れる(§5.11)。
 * @returns {Buffer} 写真風 PNG(背景込み・劣化込み)
 */
export function simulatePhoto(png, opts = {}) {
  const { scale = 1, rotateDeg = 0, tiltX = 0, tiltY = 0, tx = 0, ty = 0,
    background = 210, blur = 0, brightness = 0, noise = 0, seed = 1, lensK = 0, occlude = null } = opts;
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
  // レンズ歪みがあれば、出力(=歪んだセンサ)画素をまず undistort して「理想センサ座標」に直し、
  // それをホモグラフィで carrier へ。こうして得た画像は carrier が放射状に曲がった「写真」になる。
  const sceneToCarrier = solveHomography(dest, carrierCorners);
  const lR = canvas / 2; // 歪み正規化半径(中心 cx,cy)
  let pixels = Buffer.alloc(canvas * canvas, background);
  for (let Y = 0; Y < canvas; Y++) {
    for (let X = 0; X < canvas; X++) {
      let sx = X + 0.5;
      let sy = Y + 0.5;
      if (lensK !== 0) [sx, sy] = lensUndistort(sx, sy, cx, cy, lR, lensK);
      const [x, y] = sceneToCarrier(sx, sy);
      if (x >= 0 && y >= 0 && x <= cw - 1 && y <= ch - 1) {
        pixels[Y * canvas + X] = Math.round(sampleBilinear(carrier, cw, ch, x, y));
      }
    }
  }

  // 遮蔽(指・影・反射)= シーン中の物体。ワープ後・光学(ぼけ)前に矩形を覆う。
  if (occlude) {
    const ov = occlude.value == null ? 30 : occlude.value;
    const ox0 = Math.max(0, Math.round(occlude.x * canvas));
    const oy0 = Math.max(0, Math.round(occlude.y * canvas));
    const ox1 = Math.min(canvas, Math.round((occlude.x + occlude.w) * canvas));
    const oy1 = Math.min(canvas, Math.round((occlude.y + occlude.h) * canvas));
    for (let Y = oy0; Y < oy1; Y++) pixels.fill(ov, Y * canvas + ox0, Y * canvas + ox1);
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

// 凸包(Andrew monotone chain, 重心 cx,cy で。依存ゼロ)。頂点を CCW で返す。
function convexHull(pts) {
  if (pts.length <= 3) return [...pts];
  const s = [...pts].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  const cross = (o, a, b) => (a.cx - o.cx) * (b.cy - o.cy) - (a.cy - o.cy) * (b.cx - o.cx);
  const lower = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// finder 候補から 4 隅を選び、リング(キラリティ標識=重心ピクセルが白)を識別する。
//   向きの割り当て(どれが TL/TR/BR/BL か)は scanPhoto 側で「リング=物理 TL」を起点に行う。
//   pickFinders は連結成分を引数に取る(自己クロック検出でも同じ comps を使い回すため)。
function pickFinders(comps, pixels, w, h, thr) {
  // minArea は絶対値(極小ノイズ/塩胡椒の単画素を除く)。finder の絶対サイズはモジュール尺に依り
  // 画像全体に依らないので、画像サイズ比で決めると大きい担体で finder を弾く(=バグだった)。
  const minArea = 30;
  const maxBox = Math.min(w, h) * 0.4; // データ全域の巨大連結塊を除外
  // 正方 finder の充填率は回転で 1/(cos+sin)² まで下がる(45°で solid=0.5, リング≈0.41)。
  // 全方位(0–360°)を射程にするため 0.35 まで許す。aspect は回転正方の AABB が正方に近いまま=1 付近。
  const cand = comps.filter((c) =>
    c.area >= minArea && c.fill >= 0.35 && c.aspect >= 0.72 && c.aspect <= 1.38 &&
    c.bw <= maxBox && c.bh <= maxBox);
  if (cand.length < 4) throw new PhotoError(`finder candidates < 4 (got ${cand.length})`);
  // finder は担体の物理的な四隅。データ領域は BORDER 内側=4 finder が成す四角形の**内部**にあるので、
  // 全候補の**凸包頂点が finder**。凸包は重心に依らず、回転・透視に頑健(最遠4点法の重心バイアス
  // による取りこぼし=断続失敗を避ける)。x±y 極値法の 45° 退化も起きない。
  let hull = convexHull(cand);
  if (hull.length < 4) throw new PhotoError(`convex hull < 4 vertices (got ${hull.length})`);
  if (hull.length > 4) {
    // 背景ノイズ塊などが頂点に混じった場合: finder は大面積 → 面積上位 4 を採る。
    hull = [...hull].sort((a, b) => b.area - a.area).slice(0, 4);
  }
  const corners = hull;
  // リング識別: 各 finder の重心ピクセル色。リングは中央が穴=白(>thr)、solid は黒(<=thr)。
  //   重心(黒画素の質量中心)は対称な穴の中央に落ちるため、回転・尺度・透視に不変。
  let ringIndex = -1;
  let ringCount = 0;
  for (let i = 0; i < 4; i++) {
    const px = Math.round(corners[i].cx);
    const py = Math.round(corners[i].cy);
    if (pixels[py * w + px] > thr) { ringIndex = i; ringCount++; }
  }
  if (ringCount !== 1) ringIndex = -1; // 0 個 or 複数なら不確定 → scanPhoto が全候補を試す
  return { corners, ringIndex };
}
function findFinders(pixels, w, h, thr) {
  return pickFinders(connectedComponents(pixels, w, h, thr), pixels, w, h, thr);
}

// [TL,TR,BR,BL] 対応から、単位正方(0..1)→ピクセルのホモグラフィ H と N(データ辺長)推定を返す(幾何のみ)。
function cornerHomography([TL, TR, BR, BL]) {
  const H = solveHomography([[0, 0], [1, 0], [1, 1], [0, 1]],
    [[TL.cx, TL.cy], [TR.cx, TR.cy], [BR.cx, BR.cy], [BL.cx, BL.cy]]);
  // modulePx は面積から(回転不変。bbox 幅は回転で √2 方向に膨らみ過大推定になる)。
  const modulePx = (Math.sqrt(TL.area) + Math.sqrt(TR.area) + Math.sqrt(BR.area) + Math.sqrt(BL.area)) / 4 / FINDER;
  const distTLTR = Math.hypot(TR.cx - TL.cx, TR.cy - TL.cy);
  const distTLBL = Math.hypot(BL.cx - TL.cx, BL.cy - TL.cy);
  const spanMod = ((distTLTR + distTLBL) / 2) / modulePx; // ≈ (T-7) = (N+11)
  return { H, nEst: Math.round(spanMod - 11) };
}

// N のもとで H 越しに N×N の「暗さ率」グリッド(各モジュール ∈[0,1])を標本する。
//   データ module (mx,my) の単位座標: ((6+mx)/(N+11), (6+my)/(N+11))。finder 中心=(3.5,3.5)/(T-3.5,…)。
function sampleDarkGrid(pixels, w, h, thr, H, N, offs) {
  const denom = N + 11;
  const ustep = 1 / denom; // 1 モジュールの単位幅
  const grid = new Float64Array(N * N);
  for (let my = 0; my < N; my++) {
    for (let mx = 0; mx < N; mx++) {
      grid[my * N + mx] = moduleDarkFrac(pixels, w, h, H, (6 + mx) / denom, (6 + my) / denom, ustep, thr, offs);
    }
  }
  return grid;
}

// 単位正方→ピクセルの写像 map((u,v))->[px,py] でモジュールを再標本 → matrixToCord(単一フレーム)。
//   map は純ホモグラフィ(従来)でも、歪み認識(ホモグラフィ→放射状 distort の合成)でもよい — どちらも
//   同じ「単位座標→読み取り画素」の契約なので、標本以降は共通化できる。
//   N は推定値 nEst のまわりをブルートフォース(誤 N は magic+RS が通らず安全に弾かれる)。
//   各モジュールは offs×offs 点の多数決(frac>0.5)で読む(§5.10 高 N 頑健化)。
//   復号できなければ null(向き/順序/歪み係数が誤りの可能性=呼び出し側が別候補を試す)。
function decodeWithMapping(pixels, w, h, thr, map, nEst, offs, maxD = 20) {
  for (let d = 0; d <= maxD; d++) {
    for (const dn of d === 0 ? [0] : [d, -d]) {
      const N = nEst + dn;
      if (N < 1) continue;
      const grid = sampleDarkGrid(pixels, w, h, thr, map, N, offs);
      const bits = new Uint8Array(N * N);
      for (let i = 0; i < bits.length; i++) bits[i] = grid[i] > 0.5 ? 1 : 0; // フレーム内多数決
      try { return matrixToCord(bits); } catch { /* 次の N */ }
    }
  }
  return null;
}

// 与えた [TL,TR,BR,BL] 対応(純ホモグラフィ=従来経路)で復号。歪みは無いものとして標本する。
function decodeWithCorners(pixels, w, h, thr, ordering, offs) {
  const { H, nEst } = cornerHomography(ordering);
  return decodeWithMapping(pixels, w, h, thr, H, nEst, offs);
}

// 起点 k(物理 TL)から巡回順に [TL,TR,BR,BL] を並べる。rot=順(非鏡像)/ rev=逆(鏡像)。
const rotOrder = (sorted, k) => [sorted[k % 4], sorted[(k + 1) % 4], sorted[(k + 2) % 4], sorted[(k + 3) % 4]];
const revOrder = (sorted, k) => [sorted[k % 4], sorted[(k + 3) % 4], sorted[(k + 2) % 4], sorted[(k + 1) % 4]];

// finder を検出し、4 隅を重心まわりの角度で巡回ソート(回転不変な巡回順)+ リング起点(物理 TL)位置を返す。
//   = 向きの幾何的確定。ringPos<0 はリング不検出(向きが幾何だけでは未確定 → 呼び出し側が全起点を試す)。
function frameGeometry(pixels, w, h, thr) {
  const { corners, ringIndex } = findFinders(pixels, w, h, thr);
  const ccx = (corners[0].cx + corners[1].cx + corners[2].cx + corners[3].cx) / 4;
  const ccy = (corners[0].cy + corners[1].cy + corners[2].cy + corners[3].cy) / 4;
  const sorted = [...corners].sort((a, b) =>
    Math.atan2(a.cy - ccy, a.cx - ccx) - Math.atan2(b.cy - ccy, b.cx - ccx));
  const ringPos = ringIndex >= 0 ? sorted.indexOf(corners[ringIndex]) : -1;
  return { sorted, ringPos };
}

// ── 自己クロック(timing ticks)→ 放射状レンズ歪みの推定(§5.12)──────────
// finder 四隅で合わせる単一ホモグラフィは透視には厳密だが、実カメラの放射状レンズ歪み
// (樽/糸巻き=ホモグラフィでは表せない曲がり)は補えない。データを囲む自己クロックの tick 列は
// 歪みが無ければ直線・あれば弓なりに反る。その反りから歪み係数を推定し、標本時に打ち消す。

// tick(自己クロックの小さな黒正方)を 4 辺のリングから拾い、辺ごとにグループ化する。
// finder 四隅 sorted(巡回順)の各辺=finder 中心を結ぶ弦。tick はその弦から内側へ約 4 モジュール
// (renderScannable の tickLo/tickHi=finder 中心から 4 モジュール内側)に一列。
function detectTickLines(comps, sorted, modulePx) {
  const mp = modulePx;
  const qcx = (sorted[0].cx + sorted[1].cx + sorted[2].cx + sorted[3].cx) / 4;
  const qcy = (sorted[0].cy + sorted[1].cy + sorted[2].cy + sorted[3].cy) / 4;
  // tick 候補: ほぼ 1 モジュールの充実した小正方(finder=大、データ塊=不定形 を除く)。
  const ticks = comps.filter((c) =>
    c.area >= 0.25 * mp * mp && c.area <= 3 * mp * mp &&
    c.fill >= 0.5 && c.aspect >= 0.55 && c.aspect <= 1.8);
  // 各 tick 候補を、最も近い辺(finder 中心の弦)へ「内向き垂直距離・辺方向位置」で割り当てる。
  // 候補には perpendicular distance dp(内向き)も保持する(後でレールにロックして混入を排除)。
  const raw = [[], [], [], []]; // 4 辺(各 {x,y,dp})
  for (const c of ticks) {
    let bestEdge = -1;
    let bestErr = Infinity;
    let bestDp = 0;
    for (let e = 0; e < 4; e++) {
      const A = sorted[e];
      const B = sorted[(e + 1) % 4];
      const ex = B.cx - A.cx;
      const ey = B.cy - A.cy;
      const len = Math.hypot(ex, ey);
      if (len < 1e-6) continue;
      const ux = ex / len;
      const uy = ey / len;
      let nx = -uy;
      let ny = ux; // 法線
      if ((qcx - A.cx) * nx + (qcy - A.cy) * ny < 0) { nx = -nx; ny = -ny; } // 内向きへ
      const t = ((c.cx - A.cx) * ux + (c.cy - A.cy) * uy) / len; // 辺方向の位置 [0,1]
      const dp = (c.cx - A.cx) * nx + (c.cy - A.cy) * ny;        // 内向き垂直距離(≒ 4·mp)
      if (t < 0.04 || t > 0.96 || dp < 1.5 * mp || dp > 6.5 * mp) continue;
      const err = Math.abs(dp - 4 * mp);
      if (err < bestErr) { bestErr = err; bestEdge = e; bestDp = dp; }
    }
    if (bestEdge >= 0) raw[bestEdge].push({ x: c.cx, y: c.cy, dp: bestDp });
  }
  // レールにロック: tick 列は finder 中心から一定の内向き距離(≒4 モジュール)に並び、その内側に
  // データは無い(分離リング)。候補の dp 中央値をレールとし、±1.2·mp 内だけを残す。これで「帯に
  // 紛れ込んだデータビット(より内側=より大きい dp)」を排除する(finder 面積由来の mp 誤差にも頑健)。
  const lines = [];
  for (const cand of raw) {
    if (cand.length < 4) continue;
    const dps = cand.map((p) => p.dp).sort((a, b) => a - b);
    const rail = dps[dps.length >> 1];
    const kept = cand.filter((p) => Math.abs(p.dp - rail) <= 1.2 * mp).map((p) => ({ x: p.x, y: p.y }));
    if (kept.length >= 4) lines.push(kept);
  }
  return lines;
}

// 点群の主軸(全最小二乗)の固有値 {lmin,lmax}。lmin=垂直残差の二乗和, lmax=主軸方向の広がり。
function lineShape(pts) {
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let Sxx = 0;
  let Sxy = 0;
  let Syy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy;
  }
  const tr = Sxx + Syy;
  const root = Math.sqrt((Sxx - Syy) * (Sxx - Syy) + 4 * Sxy * Sxy);
  return { lmin: (tr - root) / 2, lmax: (tr + root) / 2 };
}

// プラムライン法: 「直線(tick 列)は undistort 後も直線」を最も満たす歪み係数 k を探す。
//   k は放射状歪みのみ・1 次・中心≈担体中心という素朴モデルの 1 パラメータ(正直な限界)。
//   コストは**スケール不変**な垂直分散比 lmin/(lmin+lmax)(=直線らしさ)の総和にする。
//   単純な垂直残差の和だと「k→大で全点を中心へ収縮させれば残差が下がる」退化で k が発散するため。
//   粗探索で谷を囲んでから黄金分割で精密化(残差は局所最小を持ちうるので単峰仮定に頼らない)。
function estimateLensK(lines, cx, cy, R) {
  const cost = (k) => {
    let s = 0;
    for (const line of lines) {
      const { lmin, lmax } = lineShape(line.map((p) => {
        const [x, y] = lensUndistort(p.x, p.y, cx, cy, R, k);
        return { x, y };
      }));
      s += lmin / (lmin + lmax + 1e-9); // 直線=0, 等方塊=0.5(スケール不変)
    }
    return s;
  };
  let lo = -1.5;
  let hi = 1.5;
  let bestK = 0;
  let bestC = Infinity;
  for (let k = lo; k <= hi + 1e-9; k += 0.1) { // 粗探索で谷を囲む
    const c = cost(k);
    if (c < bestC) { bestC = c; bestK = k; }
  }
  lo = bestK - 0.1;
  hi = bestK + 0.1;
  const phi = (Math.sqrt(5) - 1) / 2;
  let c1 = hi - phi * (hi - lo);
  let c2 = lo + phi * (hi - lo);
  let f1 = cost(c1);
  let f2 = cost(c2);
  for (let i = 0; i < 40; i++) {
    if (f1 < f2) { hi = c2; c2 = c1; f2 = f1; c1 = hi - phi * (hi - lo); f1 = cost(c1); }
    else { lo = c1; c1 = c2; f1 = f2; c2 = lo + phi * (hi - lo); f2 = cost(c2); }
  }
  return (lo + hi) / 2;
}

// 自己クロックから真のモジュール尺を測る。tick は 2 モジュール間隔なので、undistort 後の
// 隣接 tick 間隔の中央値 /2 が真の 1 モジュール画素幅。finder 面積は周辺の放射状拡大で肥大して
// 信用できない(=nEst が大きくずれる原因)が、tick 列の間隔は局所的で頑健な尺度参照になる
// (種 §3「ひねりの周期=自己クロックが撮影スケール変動に強い標本格子を与える」)。
function moduleSizeFromTicks(lines, cx, cy, R, k) {
  const gaps = [];
  for (const line of lines) {
    const u = line.map((p) => {
      const [x, y] = lensUndistort(p.x, p.y, cx, cy, R, k);
      return { x, y };
    });
    const n = u.length;
    let mx = 0;
    let my = 0;
    for (const p of u) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let Sxx = 0;
    let Sxy = 0;
    let Syy = 0;
    for (const p of u) { const dx = p.x - mx; const dy = p.y - my; Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * Sxy, Sxx - Syy); // 主軸方向
    const ax = Math.cos(ang);
    const ay = Math.sin(ang);
    const proj = u.map((p) => (p.x - mx) * ax + (p.y - my) * ay).sort((a, b) => a - b);
    for (let i = 1; i < proj.length; i++) gaps.push(proj[i] - proj[i - 1]);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1] / 2; // 中央値 /2(tick は 2 モジュール間隔)
}

// 純ホモグラフィ(従来=歪み無し前提)で復号を試みる。読めなければ null。
function tryPlain(pixels, w, h, thr, offs) {
  let geo;
  try { geo = frameGeometry(pixels, w, h, thr); }
  catch { return null; } // finder 不検出 → 純ホモグラフィでは読めない
  const { sorted, ringPos } = geo;
  const starts = ringPos >= 0 ? [ringPos] : [0, 1, 2, 3];
  for (const s of starts) {
    for (const order of [rotOrder(sorted, s), revOrder(sorted, s)]) { // 順=非鏡像 / 逆=鏡像
      const cord = decodeWithCorners(pixels, w, h, thr, order, offs);
      if (cord) return cord;
    }
  }
  if (ringPos >= 0) { // リング起点で全滅 → 念のため全起点(リング誤検出/極端な劣化の保険)
    for (let s = 0; s < 4; s++) {
      for (const order of [rotOrder(sorted, s), revOrder(sorted, s)]) {
        const cord = decodeWithCorners(pixels, w, h, thr, order, offs);
        if (cord) return cord;
      }
    }
  }
  return null;
}

// 自己クロック補正: tick 列のプラムラインで放射状レンズ歪み k を推定し、歪み認識で再標本して復号。
//   標本は「単位座標→純ホモグラフィ(歪み無し finder 中心)→ forward distort で歪んだ実画素」を読む。
//   tick が足りない/歪みが≒0 なら null(plain 既敗のため無駄打ちしない)。
function scanDistorted(pixels, w, h, thr, offs) {
  const comps = connectedComponents(pixels, w, h, thr);
  let finders;
  try { finders = pickFinders(comps, pixels, w, h, thr); }
  catch { return null; } // finder すら無ければ歪み補正もできない
  const { corners, ringIndex } = finders;
  const qcx = (corners[0].cx + corners[1].cx + corners[2].cx + corners[3].cx) / 4;
  const qcy = (corners[0].cy + corners[1].cy + corners[2].cy + corners[3].cy) / 4;
  const sorted = [...corners].sort((a, b) =>
    Math.atan2(a.cy - qcy, a.cx - qcx) - Math.atan2(b.cy - qcy, b.cx - qcx));
  const ringPos = ringIndex >= 0 ? sorted.indexOf(corners[ringIndex]) : -1;
  const modulePx = (Math.sqrt(corners[0].area) + Math.sqrt(corners[1].area) +
    Math.sqrt(corners[2].area) + Math.sqrt(corners[3].area)) / 4 / FINDER;
  const R = (Math.hypot(corners[0].cx - qcx, corners[0].cy - qcy) +
    Math.hypot(corners[1].cx - qcx, corners[1].cy - qcy) +
    Math.hypot(corners[2].cx - qcx, corners[2].cy - qcy) +
    Math.hypot(corners[3].cx - qcx, corners[3].cy - qcy)) / 4;
  const lines = detectTickLines(comps, sorted, modulePx);
  if (lines.length < 2) return null; // 自己クロックが足りない → 補正不能(安全に諦める)
  const k1 = estimateLensK(lines, qcx, qcy, R);
  if (Math.abs(k1) < 5e-3) return null; // 歪み≒0(plain と同じ)= 既に失敗済のため無駄打ち回避
  // N(データ辺長)を自己クロックから決める。finder 面積は周辺拡大で肥大し nEst が大きくずれるので、
  // tick 間隔から真のモジュール尺 mp を出し、undistort した finder 中心の平均辺長 / mp - 11 を N とする。
  const mp = moduleSizeFromTicks(lines, qcx, qcy, R, k1);
  if (!mp || mp < 1) return null;
  const undC = sorted.map((f) => {
    const [x, y] = lensUndistort(f.cx, f.cy, qcx, qcy, R, k1);
    return { cx: x, cy: y };
  });
  let perim = 0;
  for (let e = 0; e < 4; e++) {
    const A = undC[e];
    const B = undC[(e + 1) % 4];
    perim += Math.hypot(B.cx - A.cx, B.cy - A.cy);
  }
  const nEst = Math.round((perim / 4) / mp - 11); // 平均辺長 ≈ (N+11)·mp
  if (nEst < 1) return null;
  // 起点(物理 TL)候補: リングが一意なら其処を先頭に、全起点 × 順/逆(鏡像)を試す。
  const starts = ringPos >= 0 ? [ringPos, 0, 1, 2, 3] : [0, 1, 2, 3];
  const seen = new Set();
  for (const s of starts) {
    if (seen.has(s)) continue;
    seen.add(s);
    for (const order of [rotOrder(sorted, s), revOrder(sorted, s)]) {
      // finder 中心を undistort → 純ホモグラフィ部 H を fit。標本は forward distort で歪んだ画素を読む。
      const und = order.map((f) => {
        const [x, y] = lensUndistort(f.cx, f.cy, qcx, qcy, R, k1);
        return { cx: x, cy: y, area: f.area };
      });
      const { H } = cornerHomography(und);
      const map = (u, v) => {
        const [px, py] = H(u, v);
        return lensDistort(px, py, qcx, qcy, R, k1);
      };
      // nEst は自己クロック由来で正確 → 近傍だけ探索(±6)。誤 N は magic+RS が弾く。
      const cord = decodeWithMapping(pixels, w, h, thr, map, nEst, offs, 6);
      if (cord) return cord;
    }
  }
  return null;
}

/**
 * scanPhoto: 写真風 PNG → cord。finder 検出 → 向き決定(キラリティ)→ 補正 → 再標本 → RS 復号。
 *   向きの曖昧性(四隅同形 finder では面内回転 ±45° が限界)を TL のリング(重心が白)で破り、
 *   全方位(0–360°)+ 鏡像に対応。まず純ホモグラフィ(従来=速い)、失敗したら自己クロック補正で
 *   放射状レンズ歪みを推定し undistort して再挑戦する(§5.12)。役割分担は不変=これは「目」。
 * @param {Buffer} png
 * @param {{subsamples?:number, undistort?:boolean}} [opts]
 *   subsamples = 1 モジュールあたりの 1 辺標本数(既定 3 = 3×3 多数決)。1 は中心 1 点(ノイズに弱い・比較用)。
 *   undistort = false で自己クロック補正を使わない(レンズ歪み下で「補正前=✗」を示す比較用。既定は補正あり)。
 * @returns {object} cord
 */
export function scanPhoto(png, opts = {}) {
  const k = opts.subsamples == null ? 3 : Math.max(1, Math.floor(opts.subsamples));
  const offs = subOffsets(k);
  const { w, h, pixels } = decodePng(png);
  const thr = otsuThreshold(pixels);
  // ① 純ホモグラフィ(従来)。歪み無し/軽微はこれで読め、速い。
  const plain = tryPlain(pixels, w, h, thr, offs);
  if (plain) return plain;
  // {undistort:false} は自己クロック補正を使わない(レンズ歪み下で「補正前=✗」を見せる比較用)。
  if (opts.undistort === false) {
    throw new PhotoError('decode failed (純ホモグラフィのみ・自己クロック補正は無効)');
  }
  // ② 自己クロック補正: tick 列のプラムラインで放射状レンズ歪みを推定し、歪み認識で再標本(§5.12)。
  const corrected = scanDistorted(pixels, w, h, thr, offs);
  if (corrected) return corrected;
  throw new PhotoError('decode failed (純ホモグラフィ + 自己クロック補正の双方で復号不可)');
}

/**
 * scanPhotoMulti: 同じ担体を撮った複数フレーム(写真風 PNG の配列)を融合して 1 つの cord を復元する。
 *   実カメラ/動画は同じ担体を何枚も撮る。各フレームは独立ノイズ・わずかに違う幾何・違う遮蔽(指/影/反射が
 *   毎回別の場所)を持つ。単フレームでは欠ける情報を、フレーム横断で**モジュールごとに暗さ率を平均(soft 融合)**
 *   して埋める = 各フレームの票を平等に混ぜ、少数フレームの遮蔽・ノイズを多数のクリーンなフレームが押し返す。
 *   フレーム内多数決(§5.10)を時間方向へ拡張したもの(§5.11)。
 *
 *   役割分担は不変: これは「目」(物理層の冗長)。融合後も AEAD(柱9)/発行者検査(柱4)は独立に効く。
 *   向きはフレームごとにキラリティ(リング)で幾何的に確定し、winding(順/鏡像)はフレーム一括で試す。
 *   リング不検出のフレームは向きを幾何だけで確定できないため融合から外す(安全側)。
 * @param {Buffer[]} pngs 同一担体を撮った写真風 PNG の配列(1 枚でも可=単フレーム soft 復号と等価)。
 * @param {{subsamples?:number}} [opts]
 * @returns {object} cord
 */
export function scanPhotoMulti(pngs, opts = {}) {
  if (!Array.isArray(pngs) || pngs.length === 0) throw new PhotoError('scanPhotoMulti は PNG の非空配列を要する');
  const k = opts.subsamples == null ? 3 : Math.max(1, Math.floor(opts.subsamples));
  const offs = subOffsets(k);
  // 各フレームの幾何(finder + リング向き)を確定。読めない/リング不検出のフレームは融合から外す。
  const frames = [];
  for (const png of pngs) {
    let w, h, pixels, thr, geo;
    try {
      ({ w, h, pixels } = decodePng(png));
      thr = otsuThreshold(pixels);
      geo = frameGeometry(pixels, w, h, thr);
    } catch { continue; } // finder 不検出など → このフレームは捨てる
    if (geo.ringPos < 0) continue; // 向きを幾何的に確定できない → 融合に使わない(保険なし)
    frames.push({ pixels, w, h, thr, sorted: geo.sorted, ringPos: geo.ringPos });
  }
  if (frames.length === 0) throw new PhotoError('融合に使えるフレームが無い(全フレームで finder/リング不検出)');

  // N 中心 = 各フレーム nEst の中央値(幾何は向きに依らないので primary winding で代表)。
  const nEsts = frames.map((f) => cornerHomography(rotOrder(f.sorted, f.ringPos)).nEst).sort((a, b) => a - b);
  const nCenter = nEsts[nEsts.length >> 1];

  // winding(順/鏡像)はフレーム一括(同じ撮影系は全フレーム同じ巻き)。各 winding × N 候補で融合復号。
  for (const winding of [rotOrder, revOrder]) {
    const geos = frames.map((f) => {
      const { H } = cornerHomography(winding(f.sorted, f.ringPos));
      return { pixels: f.pixels, w: f.w, h: f.h, thr: f.thr, H };
    });
    for (let d = 0; d <= 20; d++) {
      for (const dn of d === 0 ? [0] : [d, -d]) {
        const N = nCenter + dn;
        if (N < 1) continue;
        const denom = N + 11;
        const ustep = 1 / denom;
        const bits = new Uint8Array(N * N);
        for (let my = 0; my < N; my++) {
          for (let mx = 0; mx < N; mx++) {
            const ucx = (6 + mx) / denom;
            const ucy = (6 + my) / denom;
            let sum = 0; // Σ 暗さ率(フレーム横断 soft 融合)
            for (const g of geos) sum += moduleDarkFrac(g.pixels, g.w, g.h, g.H, ucx, ucy, ustep, g.thr, offs);
            bits[my * N + mx] = sum * 2 > geos.length ? 1 : 0; // フレーム平均が >0.5 → 黒
          }
        }
        try { return matrixToCord(bits); } catch { /* 次の N */ }
      }
    }
  }
  throw new PhotoError(`fusion decode failed (${frames.length} frame(s), N≈${nCenter})`);
}

export { ImageCarrierError };
