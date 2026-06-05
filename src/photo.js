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
 *          occlude?:{x:number,y:number,w:number,h:number,value?:number}}} [opts]
 *   occlude = 指/影/反射で覆う矩形(キャンバス比 [0,1]、value=覆いの輝度・既定 30=暗い指)。フレームごとに
 *   位置を変えると「単フレームでは欠ける/複数フレーム融合で埋まる」を作れる(§5.11)。
 * @returns {Buffer} 写真風 PNG(背景込み・劣化込み)
 */
export function simulatePhoto(png, opts = {}) {
  const { scale = 1, rotateDeg = 0, tiltX = 0, tiltY = 0, tx = 0, ty = 0,
    background = 210, blur = 0, brightness = 0, noise = 0, seed = 1, occlude = null } = opts;
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
function findFinders(pixels, w, h, thr) {
  const comps = connectedComponents(pixels, w, h, thr);
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

// 与えた [TL,TR,BR,BL] 対応でホモグラフィ補正 → モジュール再標本 → matrixToCord(単一フレーム)。
//   N は finder 間隔/面積から推定し、ヘッダ magic+RS が通る候補をブルートフォース。
//   各モジュールは offs×offs 点の多数決(frac>0.5)で読む(§5.10 高 N 頑健化)。
//   復号できなければ null(向き/順序が誤りの可能性=呼び出し側が別候補を試す)。
function decodeWithCorners(pixels, w, h, thr, ordering, offs) {
  const { H, nEst } = cornerHomography(ordering);
  for (let d = 0; d <= 20; d++) {
    for (const dn of d === 0 ? [0] : [d, -d]) {
      const N = nEst + dn;
      if (N < 1) continue;
      const grid = sampleDarkGrid(pixels, w, h, thr, H, N, offs);
      const bits = new Uint8Array(N * N);
      for (let i = 0; i < bits.length; i++) bits[i] = grid[i] > 0.5 ? 1 : 0; // フレーム内多数決
      try { return matrixToCord(bits); } catch { /* 次の N */ }
    }
  }
  return null;
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

/**
 * scanPhoto: 写真風 PNG → cord。finder 検出 → 向き決定(キラリティ)→ ホモグラフィ補正 → 再標本 → RS 復号。
 *   向きの曖昧性(四隅同形 finder では面内回転 ±45° が限界)を、TL のリング(重心が白)で破る。
 *   リングを物理 TL の起点とし、4 隅を角度順(巡回)に並べて [TL,TR,BR,BL] を一意に決める
 *   → 全方位(0–360°)+ 鏡像(裏返し)に対応。リング不検出時は全 4 起点 × 2 方向を試す保険つき。
 * @param {Buffer} png
 * @param {{subsamples?:number}} [opts] subsamples = 1 モジュールあたりの 1 辺標本数(既定 3 = 3×3 多数決)。
 *   1 を渡すと従来の中心 1 点標本(ノイズに弱い・比較用)。大きいほどノイズ余裕↑・標本コスト↑。
 * @returns {object} cord
 */
export function scanPhoto(png, opts = {}) {
  const k = opts.subsamples == null ? 3 : Math.max(1, Math.floor(opts.subsamples));
  const offs = subOffsets(k);
  const { w, h, pixels } = decodePng(png);
  const thr = otsuThreshold(pixels);
  const { sorted, ringPos } = frameGeometry(pixels, w, h, thr);

  // 起点(物理 TL)候補: リングが一意なら其処、なければ全 4 隅。各起点で順方向/逆方向(鏡像)を試す。
  const starts = ringPos >= 0 ? [ringPos] : [0, 1, 2, 3];
  for (const s of starts) {
    for (const ordering of [rotOrder(sorted, s), revOrder(sorted, s)]) { // 順=非鏡像 / 逆=鏡像
      const cord = decodeWithCorners(pixels, w, h, thr, ordering, offs);
      if (cord) return cord;
    }
  }
  // リング起点で全滅 → 念のため全起点もさらう(リング誤検出/極端な劣化の保険)。
  if (ringPos >= 0) {
    for (let s = 0; s < 4; s++) {
      for (const ordering of [rotOrder(sorted, s), revOrder(sorted, s)]) {
        const cord = decodeWithCorners(pixels, w, h, thr, ordering, offs);
        if (cord) return cord;
      }
    }
  }
  throw new PhotoError('decode failed (finder 検出済だが全向き/全 N で復号不可)');
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
