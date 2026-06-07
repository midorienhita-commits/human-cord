// image.js
// ─────────────────────────────────────────────────────────────
// 柱7 物理層: 視覚担体の「実ピクセル」アダプタ — 依存ゼロ
// ─────────────────────────────────────────────────────────────
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4(実ピクセル/QR は媒体アダプタ)。
//
// visual.js は「媒体非依存のテキスト担体(HC1/HC2)」までを担い、実ピクセル描画は
// 明示的に将来アダプタとして外出しされていた(メモ §6 非目標 / §5.4 ⏳)。
// 本モジュールはその一周を閉じる: cord → 実 PNG 画像 →(光学ノイズ)→ 読み戻し → cord。
//
// 役割分担(プロジェクト第三条「AI と人は役割を分ける」):
//   - 本モジュール = 「目」(媒体)。ピクセルへの描画・サンプリング・幾何だけを担う。
//     暗号判定は一切しない(open/verify は呼び出し側=約束の層)。
//   - 誤り「訂正」は HC2 と同じ Reed-Solomon(ecc.js)を再利用する。
//     光学ノイズ・部分欠損(影・指・反射)で一部モジュールが化けても RS が復元する。
//
// 北極星(計算非依存性 / 依存ゼロ):
//   PNG は node:zlib(標準同梱=外部依存ではない)の deflate/inflate だけで書き読みする。
//   2 値モジュール(白/黒)を使うのは QR と同じ理由 — 多値グレーは実光学で潰れるが、
//   2 値はぼけ・露出ずれ・しきい値ドリフトに強い。中心サンプリング+固定しきい値で読む。
//
// 担体の構造(QR の素朴版。有機担体=メモ §6「見た目の美しさ」は後回し):
//   ┌─ 静寂帯(quiet zone, 白) ──────────────┐
//   │  ┌─ N×N データモジュール格子 ────────┐  │
//   │  │ [14B RS 保護ヘッダ][HC2 の RS バイト] │  │  ← MSB 先頭で 1bit=1module
//   │  └────────────────────────────────────┘  │
//   └──────────────────────────────────────────┘
//   ヘッダは別の小さな RS(nsym=10)で保護し、本体 RS バイト長を頑健に伝える。
//   本体は ecc.js の encodeBlocks 出力そのもの(自己記述・255B ブロック)。

import zlib from 'node:zlib';
import { encodeBlocks, decodeBlocks, rsEncode, rsDecode, RsError } from './ecc.js';
import { reviveBuffers } from './freshness.js';

// ── 描画定数(decoder はこれらと PNG 幅だけから幾何を復元する=自己記述)──
const SCALE = 4;   // 1 モジュール = SCALE×SCALE px(実スキャンを想定した素朴な拡大)
const QUIET = 4;   // 静寂帯(モジュール単位)。格子発見の余白
const THRESH = 128; // 2 値化しきい値(グレー<128 を黒=ビット1 とみなす)
const HDR_NSYM = 10; // ヘッダ RS パリティ(5 バイト誤りまで訂正)
const MAGIC = 0x48; // 'H' — ヘッダ先頭の版マーカ
const VERSION = 1;
const BLOCK = 255; // RS ブロック長(ecc.js encodeBlocks 既定 k=223 + nsym=32)。インターリーブ単位

/** 視覚担体の読み取り破損(PNG 不正・格子不整合・訂正能力超過)を表す例外。 */
export class ImageCarrierError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageCarrierError';
  }
}

// ── ビット ⇄ バイト(MSB 先頭)─────────────────────────────────
function bytesToBits(buf) {
  const bits = new Uint8Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (buf[i] >> (7 - b)) & 1;
  }
  return bits;
}
function bitsToBytes(bits) {
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
    out[i] = v;
  }
  return out;
}

// ── CRC32(PNG チャンク用・依存ゼロ)──────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── 最小 PNG(8bit グレースケール・フィルタ 0・インターレース無し)─────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

/** 8bit グレースケール画素(長さ w*h の Buffer)を実 PNG バイト列へ。 */
export function encodePng(pixels, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  // [10..12] = 圧縮/フィルタ/インターレース = 0
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0; // 各走査線のフィルタ種別 = None
    pixels.copy(raw, y * (w + 1) + 1, y * w, y * w + w);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG バイト列 → {w,h,pixels}。本モジュールが書いた形式(8bit グレー/フィルタ0)専用。 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new ImageCarrierError('not a PNG (bad signature)');
  }
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = 0;
  const idats = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  // 8-bit の グレー(0)/真彩 RGB(2)/グレー+α(4)/真彩+α(6) に対応。合成担体は colorType 0・フィルタ 0 だが、
  // 実カメラ画像(System.Drawing 等で PNG 化)はカラー + 各種 PNG フィルタを使う。RGB は輝度でグレー化する。
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (CH === undefined || bitDepth !== 8) {
    throw new ImageCarrierError(`unsupported PNG (need 8-bit gray/RGB/RGBA; got colorType=${colorType} depth=${bitDepth})`);
  }
  if (interlace !== 0) throw new ImageCarrierError('unsupported PNG (interlaced)');
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idats));
  } catch (e) {
    throw new ImageCarrierError('IDAT inflate failed: ' + e.message);
  }
  const stride = w * CH;
  if (raw.length !== h * (stride + 1)) throw new ImageCarrierError('IDAT size mismatch');

  // PNG フィルタ解除(行ごと・bpp 認識)→ 輝度グレー化。None/Sub/Up/Average/Paeth に対応。
  let cur = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  const pixels = Buffer.alloc(w * h);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= CH ? cur[i - CH] : 0; // 左
      const b = prev[i];                   // 上
      const c = i >= CH ? prev[i - CH] : 0; // 左上
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new ImageCarrierError('unsupported PNG scanline filter ' + ft);
      }
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < w; px++) {
      const o = px * CH;
      pixels[y * w + px] = CH <= 2
        ? cur[o] // グレー(+α)
        : (cur[o] * 299 + cur[o + 1] * 587 + cur[o + 2] * 114 + 500) / 1000 | 0; // RGB→輝度
    }
    const tmp = prev; prev = cur; cur = tmp; // prev←この行(次行の「上」)。cur は次行で全上書きされる
  }
  return { w, h, pixels };
}

// ── モジュール格子 ⇄ ピクセル ──────────────────────────────────
// 格子は N×N データモジュール + 周囲 QUIET モジュールの静寂帯。1 モジュール=SCALE px。
function matrixToPixels(matrix, n) {
  const side = (n + 2 * QUIET) * SCALE;
  const pixels = Buffer.alloc(side * side, 255); // 既定=白(静寂帯)
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      const bit = matrix[my * n + mx];
      if (!bit) continue; // ビット0 = 白(描画不要)
      const x0 = (QUIET + mx) * SCALE;
      const y0 = (QUIET + my) * SCALE;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = (y0 + dy) * side + x0;
        pixels.fill(0, row, row + SCALE); // ビット1 = 黒
      }
    }
  }
  return { pixels, side };
}

// PNG 幅と描画定数から N を復元し、各モジュール中心画素をしきい値判定してビットへ。
function pixelsToBits(pixels, w, h) {
  if (w !== h) throw new ImageCarrierError('carrier image must be square');
  if (w % SCALE !== 0) throw new ImageCarrierError('width not a multiple of module scale');
  const n = w / SCALE - 2 * QUIET;
  if (n <= 0) throw new ImageCarrierError('no data region (image too small)');
  const c = Math.floor(SCALE / 2); // モジュール内のサンプリング中心
  const bits = new Uint8Array(n * n);
  for (let my = 0; my < n; my++) {
    for (let mx = 0; mx < n; mx++) {
      const px = (QUIET + mx) * SCALE + c;
      const py = (QUIET + my) * SCALE + c;
      bits[my * n + mx] = pixels[py * w + px] < THRESH ? 1 : 0; // 黒=1
    }
  }
  return bits;
}

// ── ブロックインターリーブ(バースト/部分遮蔽の誤りを全ブロックへ拡散)──────
// 非インターリーブだと、画像上の連続領域(影・指・反射)の破損が特定 RS ブロックに
// 集中し、そのブロックの訂正能力(16B/255)を一気に超える。QR と同じく、バイトを
// 全ブロックに撒くことで「連続 L バイトの破損」が各ブロックに L/B 程度しか乗らなくなる。
// 画像層だけの並べ替え(ecc.js は無改変)。rs.length は BLOCK の倍数(encodeBlocks 保証)。
function interleave(rs) {
  const B = rs.length / BLOCK;
  const out = Buffer.alloc(rs.length);
  let p = 0;
  for (let j = 0; j < BLOCK; j++) for (let b = 0; b < B; b++) out[p++] = rs[b * BLOCK + j];
  return out;
}
function deinterleave(rsI) {
  const B = rsI.length / BLOCK;
  const out = Buffer.alloc(rsI.length);
  let p = 0;
  for (let j = 0; j < BLOCK; j++) for (let b = 0; b < B; b++) out[b * BLOCK + j] = rsI[p++];
  return out;
}

// ── ヘッダ(本体 RS バイト長を RS で頑健に運ぶ)─────────────────
function buildHeader(rsLen) {
  // [MAGIC, VERSION, len(3B BE)] を RS 保護。固定長 4+HDR_NSYM=14 バイト。
  const data = Uint8Array.from([MAGIC, VERSION, (rsLen >>> 16) & 0xff, (rsLen >>> 8) & 0xff, rsLen & 0xff]);
  return Buffer.from(rsEncode(data, HDR_NSYM));
}
const HEADER_LEN = 5 + HDR_NSYM; // 15
function parseHeader(bytes) {
  let data;
  try {
    data = rsDecode(Uint8Array.from(bytes.subarray(0, HEADER_LEN)), HDR_NSYM).data;
  } catch (e) {
    if (e instanceof RsError) throw new ImageCarrierError('header uncorrectable: ' + e.message);
    throw e;
  }
  if (data[0] !== MAGIC) throw new ImageCarrierError('bad magic (not a human-cord image carrier)');
  if (data[1] !== VERSION) throw new ImageCarrierError('unsupported carrier version: ' + data[1]);
  return (data[2] << 16) | (data[3] << 8) | data[4];
}

/**
 * cordToMatrix: cord → 2 値モジュール格子(描画前の論理担体)。
 *   payload(JSON) を HC2 と同じ RS で符号化 → ヘッダ + インターリーブ本体 → ビット列 → 正方格子。
 *   描画(ピクセル化)から独立させ、視覚カメラアダプタ(photo.js)からも再利用する。
 * @param {object} cord
 * @returns {{matrix:Uint8Array, n:number}} matrix=長さ n*n の 0/1 ビット(行優先・MSB先頭)
 */
export function cordToMatrix(cord) {
  const payload = Buffer.from(JSON.stringify(cord), 'utf8');
  const rs = encodeBlocks(payload); // HC2 と同一の誤り訂正
  const stream = Buffer.concat([buildHeader(rs.length), interleave(rs)]); // 本体はインターリーブして配置
  const bits = bytesToBits(stream);
  const n = Math.ceil(Math.sqrt(bits.length)); // 正方格子に収める
  const matrix = new Uint8Array(n * n); // 余りは 0(白)で自然にパディング
  matrix.set(bits);
  return { matrix, n };
}

/**
 * matrixToCord: 2 値モジュール格子(0/1 ビット列)→ cord。RS が訂正能力内の誤りを直す。
 *   サンプリング手段(固定幾何 or カメラ補正)に依らず、ビット格子からの復号を共通化する。
 * @param {Uint8Array|number[]} bits  行優先・MSB先頭の 0/1 列(長さは 8 の倍数でなくてよい)
 * @returns {object} cord
 */
export function matrixToCord(bits) {
  const bytes = bitsToBytes(bits);
  const rsLen = parseHeader(bytes);
  const start = HEADER_LEN;
  if (start + rsLen > bytes.length) throw new ImageCarrierError('declared length exceeds carrier');
  const rs = deinterleave(bytes.subarray(start, start + rsLen)); // 配置を元順へ戻す
  let payload;
  try {
    payload = decodeBlocks(rs).data;
  } catch (e) {
    if (e instanceof RsError) throw new ImageCarrierError('body uncorrectable: ' + e.message);
    throw e;
  }
  let cord;
  try {
    cord = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new ImageCarrierError('recovered payload is not valid cord JSON');
  }
  return reviveBuffers(cord);
}

/**
 * renderImage: cord → 実 PNG 画像(視覚物理担体・既知幾何版)。
 *   返り値の png はそのままファイルに書け、画面表示・印刷・撮影できる。
 *   位置・回転・傾きが未知の「写真」から読むには photo.js(finder + 透視補正)を使う。
 * @param {object} cord  seal()/issue() の出力
 * @returns {{png:Buffer, modules:number, side:number}} png=画像バイト, modules=N, side=画素辺長
 */
export function renderImage(cord) {
  const { matrix, n } = cordToMatrix(cord);
  const { pixels, side } = matrixToPixels(matrix, n);
  return { png: encodePng(pixels, side, side), modules: n, side };
}

/**
 * extractImage: 実 PNG 画像(既知幾何)→ cord。光学ノイズは RS が訂正する。
 *   モジュールが軸整列・固定尺で並ぶ前提(renderImage の出力)。写真は photo.scanPhoto。
 * @param {Buffer} png
 * @returns {object} cord
 */
export function extractImage(png) {
  const { w, h, pixels } = decodePng(png);
  return matrixToCord(pixelsToBits(pixels, w, h));
}

// ── 光学ノイズのシミュレーション(実カメラ前の研究用)──────────────
// 実カメラ/AI 抽出アダプタは別腹(依存が要る)。ここでは「撮影で起きる劣化」を
// 画素レベルで模す: ぼけ・露出ずれ・塩胡椒ノイズ・部分遮蔽(影・指・反射)。
// 決定的に再現するため簡易 PRNG(mulberry32)を使う(テスト安定性のため)。
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function boxBlur(pixels, w, h, radius) {
  if (radius <= 0) return pixels;
  const out = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += pixels[yy * w + xx];
          cnt++;
        }
      }
      out[y * w + x] = Math.round(sum / cnt);
    }
  }
  return out;
}

/**
 * simulateOptics: 担体 PNG に撮影劣化を加えた PNG を返す(画像→画像)。
 * @param {Buffer} png
 * @param {{blur?:number, brightness?:number, noise?:number, occlude?:number, seed?:number}} [opts]
 *   blur: 箱ぼかし半径(px) / brightness: 明度オフセット(-255..255) /
 *   noise: 塩胡椒ノイズ確率(0..1) / occlude: 隅を遮蔽する面積比(0..1)
 * @returns {Buffer} 劣化後の PNG
 */
export function simulateOptics(png, { blur = 0, brightness = 0, noise = 0, occlude = 0, seed = 1 } = {}) {
  const { w, h } = decodePng(png);
  let { pixels } = decodePng(png);
  pixels = Buffer.from(pixels); // コピー(元を壊さない)
  const rng = mulberry32(seed);

  if (blur > 0) pixels = boxBlur(pixels, w, h, blur);

  if (brightness !== 0) {
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = Math.max(0, Math.min(255, pixels[i] + brightness));
    }
  }

  if (occlude > 0) {
    // 右下隅を白(反射)で塗りつぶす想定。面積比 occlude を 1 辺比に。
    const frac = Math.min(0.9, occlude);
    const ow = Math.round(w * Math.sqrt(frac));
    const oh = Math.round(h * Math.sqrt(frac));
    for (let y = h - oh; y < h; y++) {
      if (y < 0) continue;
      pixels.fill(255, y * w + (w - ow), y * w + w);
    }
  }

  if (noise > 0) {
    for (let i = 0; i < pixels.length; i++) {
      if (rng() < noise) pixels[i] = rng() < 0.5 ? 0 : 255;
    }
  }

  return encodePng(pixels, w, h);
}
