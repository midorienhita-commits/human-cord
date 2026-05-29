// cord.js
// ─────────────────────────────────────────────────────────────
// human cord 統合レイヤー — seal(発行) / open(検証)
// ─────────────────────────────────────────────────────────────
// 縦切り POC: 柱2(目玉文字)× 柱5(ratchet)× 柱9(卵の鎖)× 柱10(失敗境界)
//   さらに 柱4(発行者の片割れ)を deriveSeed で最小実装。
//
// seal:  平文 → チャンク分割 → 卵ごとに ratchet 鍵で AEAD 封 → ハッシュ鎖
// open:  発行者秘密で ratchet を再構築 → 鎖検証 → AEAD 復号
//
// 柱10「失敗境界の自己観測抵抗」の実装方針:
//   検証に失敗したとき、露出するのは「型」= どの seq で割れたか だけ。
//   鍵・平文・ratchet の現在状態(核)は CordTamper に一切載せない。

import { createHmac } from 'node:crypto';
import { Ratchet } from './ratchet.js';
import { sealEgg, openEgg, hashEgg, GENESIS } from './egg.js';
import { toLandscape } from './eyeglyph.js';

const DEFAULT_CHUNK = 16; // AES ブロック相当(16 文字 = 卵の中身の粒度)

/** 改ざん・検証失敗を表す例外。露出は seq(型)のみ。 */
export class CordTamper extends Error {
  constructor(message, seq) {
    super(message);
    this.name = 'CordTamper';
    this.seq = seq; // 露出してよい「型」情報。核(鍵・状態)は載せない。
  }
}

// 柱4: 発行者の片割れ。issuerSecret を知る者だけが同じ ratchet を再現できる。
function deriveSeed(issuerSecret, context) {
  return `${issuerSecret}|${context}`;
}

// 柱3: 通行手形(割符のタグ)。発行者秘密 + docId(案件鍵) + 鎖先端 tip から導出。
//   - 発行者秘密を知る者だけが再計算できる(片割れ性)
//   - tip を含むため、卵が 1 bit でも改ざんされると値が変わる
//   割符演算(combine / verifyTally)は tally.js に分離。
export function computeTally(issuerSecret, context, docId, tip) {
  return createHmac('sha256', deriveSeed(issuerSecret, context))
    .update('human-cord/tally|')
    .update(String(docId))
    .update('|')
    .update(tip)
    .digest('hex');
}

/**
 * 平文を human cord(卵の鎖)に封じる。
 * @param {string} plaintext
 * @param {string} issuerSecret 発行者秘密(片割れ)
 * @param {string} [context] 文脈ラベル(同一秘密でも鍵列を分ける軸)
 * @param {{chunkSize?: number, docId?: string|number|null}} [opts]
 *        chunkSize: 卵の中身の粒度 / docId: 柱3 割符演算の案件鍵(指定時 tally 付与)
 */
export function seal(plaintext, issuerSecret, context = 'default', opts = {}) {
  const { chunkSize = DEFAULT_CHUNK, docId = null } = opts;
  const ratchet = new Ratchet(deriveSeed(issuerSecret, context));
  const chunks = [];
  for (let i = 0; i < plaintext.length; i += chunkSize) {
    chunks.push(plaintext.slice(i, i + chunkSize));
  }
  if (chunks.length === 0) chunks.push('');

  const eggs = [];
  let prevHash = GENESIS;
  chunks.forEach((chunk, i) => {
    const key = ratchet.next(); // 柱5: 卵ごとに鍵が進む
    const egg = sealEgg(i, prevHash, key, chunk); // 柱9: AEAD + 鎖
    eggs.push(egg);
    prevHash = egg.hash;
  });

  const cord = {
    version: 'human-cord/0.1',
    context,
    surface: toLandscape(plaintext), // 柱2: 風景(表示用・検証非依存)
    eggs, // 柱9: 卵の鎖(本体)
    tip: prevHash.toString('hex'), // 鎖の先端ハッシュ
  };

  // 柱3: docId 指定時は通行手形(割符タグ)を付与
  if (docId != null) {
    cord.docId = docId;
    cord.tally = computeTally(issuerSecret, context, docId, cord.tip);
  }
  return cord;
}

/**
 * human cord を検証・復号する。改ざん時は CordTamper を投げる。
 * @returns {string} 復元された平文
 */
export function open(cord, issuerSecret) {
  const ratchet = new Ratchet(deriveSeed(issuerSecret, cord.context));
  let prevHash = GENESIS;
  let out = '';

  for (const egg of cord.eggs) {
    // 柱10: ハッシュ鎖の連結検証(型=構造の検査。核には触れない)
    if (Buffer.compare(toBuf(egg.prevHash), prevHash) !== 0) {
      throw new CordTamper(`chain break at egg ${egg.seq}`, egg.seq);
    }
    // 柱10: 卵自身のハッシュ整合(中身の差し替え検知)
    if (Buffer.compare(toBuf(egg.hash), hashEgg(egg)) !== 0) {
      throw new CordTamper(`egg hash mismatch at egg ${egg.seq}`, egg.seq);
    }
    const key = ratchet.next();
    let chunk;
    try {
      chunk = openEgg(egg, key); // 柱9: AEAD タグ検証(鍵違い・改ざんで throw)
    } catch {
      // 柱10: 割れても露出するのは seq だけ。鍵・平文・状態は外に出さない。
      throw new CordTamper(`AEAD verify failed at egg ${egg.seq}`, egg.seq);
    }
    out += chunk;
    prevHash = toBuf(egg.hash);
  }

  // 鎖の先端ハッシュの一致(全体整合の最終確認)
  if (cord.tip && prevHash.toString('hex') !== cord.tip) {
    throw new CordTamper('tip mismatch (chain length altered)', -1);
  }
  return out;
}

// JSON 経由などで Buffer が {type:'Buffer',data:[…]} 化していても吸収する保険。
function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  return Buffer.from(v);
}
