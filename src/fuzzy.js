// fuzzy.js
// ─────────────────────────────────────────────────────────────
// 柱4/柱7 合流: Fuzzy Extractor(Dodis et al. 2004)
//   / Fuzzy Commitment(Juels & Wattenberg 1999)
// ─────────────────────────────────────────────────────────────
// 手相・虹彩など「曖昧な生体」入力から、誤り訂正で毎回「同じ鍵」を再生する。
// 生体テンプレートそのものは保存しない。helper data(誤り訂正の補助情報)だけを
// 公開保存し、これは生体を漏らさない。
//
// 計算非依存性の原則:
//   突破には発行者の「手」または「眼」が物理的に必要。Mythos級が計算をいくら
//   積んでも、本人の生体が無ければ鍵は再生できない。
//
// モダリティ非依存:
//   コア(繰り返し符号 + 多数決)は生体の種類に依存しない。手相 / 虹彩は
//   「特徴ビット列の長さ」と「想定誤り率(=訂正冗長度 rep)」だけが違う。
//
// 鉄板技術: 繰り返し符号(最古の誤り訂正)+ code-offset(fuzzy commitment)。
//   実画像→特徴ビット列の抽出は Phase 2(物理層)で。本モジュールはコアを担う。
//
// ⚠ 生体ゆえの注意(運用で守る):
//   生体は変更不能 → テンプレートは保存しない(helper のみ)。単独でなく
//   発行者秘密や Shamir 片と組み合わせる。経年で再登録、強制リスクは運用で補う。

import { createHash, randomBytes } from 'node:crypto';

// モダリティ別プロファイル。rep は奇数(多数決のため)。誤り率が高いほど rep を大きく。
export const MODALITY = {
  palm: { rep: 7, label: '手相' }, // 撮影容易・非侵襲、誤り率 中 → 3 bit/ブロック訂正
  iris: { rep: 9, label: '虹彩' }, // 高エントロピー・安定だが照合誤り高め → 4 bit/ブロック訂正
};

// 0/1 ビット配列 → バイト列(鍵導出のため)
function bitsToBytes(bits) {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

function keyFromBits(bits) {
  return createHash('sha256').update(bitsToBytes(bits)).digest();
}

/**
 * 登録(Gen): 生体特徴ビット列から鍵と helper を生成する。
 * @param {Uint8Array|number[]} feature 特徴ビット列(0/1)
 * @param {'palm'|'iris'} modality
 * @returns {{key: Buffer, helper: {modality:string, n:number, offset:Uint8Array}}}
 */
export function gen(feature, modality = 'palm') {
  const prof = MODALITY[modality];
  if (!prof) throw new Error(`unknown modality: ${modality}`);
  const rep = prof.rep;
  const k = Math.floor(feature.length / rep); // 復元できる鍵ビット数
  if (k < 1) throw new Error('feature too short for modality');
  const n = k * rep;

  // ランダム鍵ビット R(k ビット)
  const rnd = randomBytes(k);
  const R = new Uint8Array(k);
  for (let i = 0; i < k; i += 1) R[i] = (rnd[i >> 3] >> (7 - (i & 7))) & 1;

  // 符号化: R の各ビットを rep 回繰り返した codeword(n ビット)
  // helper = feature XOR codeword(code-offset / fuzzy commitment)
  const offset = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const codeBit = R[Math.floor(i / rep)];
    offset[i] = (feature[i] & 1) ^ codeBit;
  }

  return { key: keyFromBits(R), helper: { modality, n, offset } };
}

/**
 * 再生(Rep): 別の(曖昧に違う)生体特徴と helper から鍵を再生する。
 * 特徴が登録時に十分近ければ同じ鍵、遠ければ別の鍵(=他人)になる。
 * @param {Uint8Array|number[]} feature
 * @param {{modality:string, n:number, offset:Uint8Array}} helper
 * @returns {Buffer} 再生された鍵
 */
export function rep(feature, helper) {
  const prof = MODALITY[helper.modality];
  if (!prof) throw new Error(`unknown modality: ${helper.modality}`);
  const rep_ = prof.rep;
  const n = helper.n;
  const k = n / rep_;

  // codeword' = feature XOR offset(= 元 codeword に生体誤差が乗ったもの)
  // 各 rep ブロックを多数決して R を復元(誤り訂正)
  const R = new Uint8Array(k);
  for (let blk = 0; blk < k; blk += 1) {
    let ones = 0;
    for (let j = 0; j < rep_; j += 1) {
      const i = blk * rep_ + j;
      ones += ((feature[i] & 1) ^ helper.offset[i]);
    }
    R[blk] = ones * 2 > rep_ ? 1 : 0; // 多数決
  }
  return keyFromBits(R);
}
