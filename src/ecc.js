// ecc.js
// ─────────────────────────────────────────────────────────────
// 柱7 物理層: 誤り訂正(Reed-Solomon over GF(256))— 依存ゼロ
// ─────────────────────────────────────────────────────────────
// 設計メモ: docs/phase2-pillar7-{visual,audio}-channel.md(ECC = 物理層の頑健化)
//
// 担体(視覚/音響)は実世界で雑音・部分欠損・再圧縮を受ける。checksum は破損を
// 「検知」できるが「訂正」はできない。RS は nsym パリティで floor(nsym/2) シンボル
// 誤りまで訂正する鉄板技術(QR コードと同じ GF(256), 既約多項式 0x11d)。
//
// 北極星(計算非依存性): 新発明せず、枯れた RS をそのまま使う。GF(256) は
// 柱4 Shamir(shard.js)と同じ有限体の発想。
//
// 実装は公知の RS アルゴリズム(syndrome → Berlekamp-Massey → Chien → Forney)に忠実。

const PRIM = 0x11d; // GF(256) 既約多項式(QR 標準)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export class RsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RsError';
  }
}

// ── GF(256) スカラー演算 ───────────────────────────────────────
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function gfPow(x, power) {
  const i = (((LOG[x] * power) % 255) + 255) % 255;
  return EXP[i];
}
function gfInverse(x) {
  return EXP[255 - LOG[x]];
}
function gfDiv(a, b) {
  if (b === 0) throw new RsError('division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

// ── GF(256) 多項式(big-endian: index 0 = 最高次)──────────────
function polyScale(p, x) {
  const r = new Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
  return r;
}
function polyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= gfMul(p[i], q[j]);
  }
  return r;
}
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}

// ── RS 符号化 ─────────────────────────────────────────────────
function generatorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]);
  return g;
}

/** 単一ブロック(data.length + nsym <= 255)を RS 符号化。data+parity を返す。 */
export function rsEncode(data, nsym) {
  if (data.length + nsym > 255) throw new RsError('block too long (>255)');
  const gen = generatorPoly(nsym);
  const out = new Array(data.length + nsym).fill(0);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], coef);
    }
  }
  for (let i = 0; i < data.length; i++) out[i] = data[i]; // メッセージ部を復元
  return Uint8Array.from(out);
}

// ── RS 復号(誤り訂正)─────────────────────────────────────────
function calcSyndromes(msg, nsym) {
  const synd = [0];
  for (let i = 0; i < nsym; i++) synd.push(polyEval(msg, gfPow(2, i)));
  return synd; // length nsym+1, 先頭は 0
}
function findErrorLocator(synd, nsym) {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) throw new RsError('too many errors to correct');
  return errLoc;
}
function findErrors(errLocRev, nmess) {
  const errs = errLocRev.length - 1;
  const errPos = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLocRev, gfPow(2, i)) === 0) errPos.push(nmess - 1 - i);
  }
  if (errPos.length !== errs) throw new RsError('could not locate errors');
  return errPos;
}
function errataLocator(ePos) {
  let eLoc = [1];
  for (const i of ePos) eLoc = polyMul(eLoc, polyAdd([1], [gfPow(2, i), 0]));
  return eLoc;
}
function errorEvaluator(synd, errLoc, nsym) {
  const prod = polyMul(synd, errLoc);
  return prod.slice(prod.length - (nsym + 1)); // (synd*errLoc) mod x^(nsym+1)
}
function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = errataLocator(coefPos);
  const syndRev = synd.slice().reverse();
  const errEval = errorEvaluator(syndRev, errLoc, errLoc.length - 1).reverse();

  const X = coefPos.map((cp) => gfPow(2, cp - 255));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    }
    if (errLocPrime === 0) throw new RsError('errata locator derivative is zero');
    let y = polyEval(errEval.slice().reverse(), XiInv);
    y = gfMul(Xi, y);
    E[errPos[i]] = gfDiv(y, errLocPrime);
  }
  return polyAdd(msg, E);
}

/**
 * 単一ブロックを復号・訂正する。
 * @returns {{data:Uint8Array, corrected:number}} 訂正後のメッセージ部と訂正シンボル数
 * @throws {RsError} 訂正能力を超えるとき
 */
export function rsDecode(code, nsym) {
  const msg = Array.from(code);
  const synd = calcSyndromes(msg, nsym);
  if (synd.reduce((a, b) => Math.max(a, b), 0) === 0) {
    return { data: Uint8Array.from(msg.slice(0, msg.length - nsym)), corrected: 0 };
  }
  const errLoc = findErrorLocator(synd, nsym);
  const errPos = findErrors(errLoc.slice().reverse(), msg.length);
  const corrected = correctErrata(msg, synd, errPos);
  const synd2 = calcSyndromes(corrected, nsym);
  if (synd2.reduce((a, b) => Math.max(a, b), 0) !== 0) {
    throw new RsError('failed to correct (residual syndromes)');
  }
  return { data: Uint8Array.from(corrected.slice(0, corrected.length - nsym)), corrected: errPos.length };
}

// ── チャンク化(cord は >255B。QR 同様に複数ブロックへ)──────────
function u32be(n) {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/**
 * 任意長データを「4Bヘッダ(真の長さ)+ data」を k バイトブロックに分け、各ブロックを
 * RS 符号化して連結する。各ブロックは固定長 (k+nsym)。
 * @param {Uint8Array|Buffer} data
 * @param {{nsym?:number, k?:number}} [opts] 既定 nsym=32, k=223(255 ブロック、16 誤り/ブロック)
 * @returns {Buffer}
 */
export function encodeBlocks(data, { nsym = 32, k = 223 } = {}) {
  if (k + nsym > 255) throw new RsError('k+nsym > 255');
  const header = u32be(data.length);
  const withHeader = Uint8Array.from([...header, ...data]);
  const nblocks = Math.ceil(withHeader.length / k);
  const padded = new Uint8Array(nblocks * k);
  padded.set(withHeader);
  const out = [];
  for (let b = 0; b < nblocks; b++) {
    out.push(rsEncode(padded.subarray(b * k, b * k + k), nsym));
  }
  return Buffer.concat(out.map((u) => Buffer.from(u)));
}

/**
 * encodeBlocks の逆。各ブロックを訂正し、ヘッダの長さで真のデータを切り出す。
 * @returns {{data:Buffer, corrected:number}} corrected = 訂正したシンボル総数
 * @throws {RsError} いずれかのブロックが訂正不能なとき
 */
export function decodeBlocks(buf, { nsym = 32, k = 223 } = {}) {
  const blockSize = k + nsym;
  if (buf.length % blockSize !== 0) throw new RsError('not a multiple of block size');
  const nblocks = buf.length / blockSize;
  const parts = [];
  let corrected = 0;
  for (let b = 0; b < nblocks; b++) {
    const { data, corrected: c } = rsDecode(buf.subarray(b * blockSize, b * blockSize + blockSize), nsym);
    parts.push(Buffer.from(data));
    corrected += c;
  }
  const all = Buffer.concat(parts);
  const len = (all[0] << 24) | (all[1] << 16) | (all[2] << 8) | all[3];
  if (len < 0 || len + 4 > all.length) throw new RsError('invalid recovered length header');
  return { data: all.subarray(4, 4 + len), corrected };
}
