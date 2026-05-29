// shard.js
// ─────────────────────────────────────────────────────────────
// 柱4 深化: Shamir 秘密分散(Adi Shamir, 1979)による「割符」の情報理論的分割
// ─────────────────────────────────────────────────────────────
// 発行者の片割れ(秘密)を n 片に分割し、閾値 k 片あれば復元できる。
// k 未満の片からは、計算能力が無限であっても元の秘密について「何も分からない」
// (情報理論的安全)。これが human cord の「計算非依存性の原則」の核:
//   突破のボトルネックは計算力ではなく、人間が物理的に持つ片割れの枚数。
//
// 鉄板技術: GF(256)(AES と同じ既約多項式 0x11b)上の多項式補間。新発明はしない。
// 各バイトを独立に分散する(バイト列の長さは保たれる)。

import { randomBytes } from 'node:crypto';

// ── GF(256) 乗算テーブル(generator = 3, 既約多項式 0x11b)──
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  // 素朴な GF 乗算でテーブルを生成(初期化時のみ使用)
  const gmul = (a, b) => {
    let p = 0;
    for (let i = 0; i < 8; i += 1) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1b; // 0x11b の下位 8bit
      b >>= 1;
    }
    return p;
  };
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x = gmul(x, 3); // 3 は 0x11b の原始元
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function inv(a) {
  // a^(-1) = EXP[255 - LOG[a]](a !== 0 前提)
  return EXP[255 - LOG[a]];
}

/**
 * 秘密(Buffer)を n 片に分割。閾値 k 片で復元可能。
 * @param {Buffer} secret 分割する秘密のバイト列
 * @param {number} n 生成する片の総数(1..255)
 * @param {number} k 復元に必要な閾値(1..n)
 * @returns {{x:number, y:Buffer}[]} n 個の片(x は 1..n の評価点)
 */
export function split(secret, n, k) {
  if (k < 1 || n < k || n > 255) throw new Error('invalid (n,k)');
  const shares = [];
  for (let i = 1; i <= n; i += 1) shares.push({ x: i, y: Buffer.alloc(secret.length) });

  for (let b = 0; b < secret.length; b += 1) {
    // 多項式 f(x) = secret[b] + a1 x + … + a_{k-1} x^{k-1}(係数はランダム)
    const coef = new Uint8Array(k);
    coef[0] = secret[b];
    if (k > 1) {
      const rnd = randomBytes(k - 1);
      for (let j = 1; j < k; j += 1) coef[j] = rnd[j - 1];
    }
    for (let i = 1; i <= n; i += 1) {
      let y = 0;
      let xp = 1; // x^0
      for (let j = 0; j < k; j += 1) {
        y ^= mul(coef[j], xp);
        xp = mul(xp, i);
      }
      shares[i - 1].y[b] = y;
    }
  }
  return shares;
}

/**
 * k 片以上から秘密を復元(ラグランジュ補間で f(0) を求める)。
 * k 未満では誤った値になり、元の秘密は一切漏れない(情報理論的安全)。
 * @param {{x:number, y:Buffer}[]} shares
 * @returns {Buffer}
 */
export function combine(shares) {
  if (!shares.length) throw new Error('no shares');
  const len = shares[0].y.length;
  const out = Buffer.alloc(len);

  for (let b = 0; b < len; b += 1) {
    let secret = 0;
    for (let i = 0; i < shares.length; i += 1) {
      // ラグランジュ基底 L_i(0) = Π_{j≠i} (0 - x_j)/(x_i - x_j)
      // GF では減算=加算=XOR なので (0 - x_j) = x_j, (x_i - x_j) = x_i ^ x_j
      let num = 1;
      let den = 1;
      for (let j = 0; j < shares.length; j += 1) {
        if (i === j) continue;
        num = mul(num, shares[j].x);
        den = mul(den, shares[i].x ^ shares[j].x);
      }
      const li = mul(num, inv(den));
      secret ^= mul(shares[i].y[b], li);
    }
    out[b] = secret;
  }
  return out;
}
