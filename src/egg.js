// egg.js
// ─────────────────────────────────────────────────────────────
// 柱9: 卵流アーキテクチャ(AEAD ブロック暗号 + ハッシュチェーン)
// ─────────────────────────────────────────────────────────────
// 各「卵」= AES-256-GCM で封じられた 1 チャンク。
// 卵同士は prevHash(直前の卵のハッシュ)で連結され「鎖」を成す。
//   - seq と prevHash を AAD(認証付き関連データ)に含めるため、
//     順序の入れ替えや差し替えは AEAD タグ検証で即座に破綻する。
//   - egg.hash は次の卵の prevHash になり、改ざんは鎖断絶として伝播する。

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 鎖の起点(genesis prevHash)。全ゼロ 32 バイト。 */
export const GENESIS = Buffer.alloc(32, 0);

/** 卵の正準ハッシュ(seq + prevHash + iv + ct + tag を連結して SHA-256)。 */
export function hashEgg(egg) {
  return createHash('sha256')
    .update(Buffer.from(String(egg.seq)))
    .update(egg.prevHash)
    .update(egg.iv)
    .update(egg.ct)
    .update(egg.tag)
    .digest();
}

/**
 * 1 チャンクを卵に封じる。
 * @param {number} seq 卵の通し番号(0 始まり)
 * @param {Buffer} prevHash 直前の卵のハッシュ(先頭は GENESIS)
 * @param {Buffer} key 32 バイト鍵(ratchet から払い出し)
 * @param {string} plaintextChunk 平文チャンク
 */
export function sealEgg(seq, prevHash, key, plaintextChunk) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const aad = Buffer.concat([Buffer.from(String(seq)), prevHash]);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintextChunk, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const egg = { seq, prevHash, iv, ct, tag };
  egg.hash = hashEgg(egg);
  return egg;
}

/**
 * 卵を開く。AEAD タグ検証に失敗すると例外を投げる(改ざん検知)。
 * @returns {string} 復号された平文チャンク
 */
export function openEgg(egg, key) {
  const aad = Buffer.concat([Buffer.from(String(egg.seq)), egg.prevHash]);
  const decipher = createDecipheriv('aes-256-gcm', key, egg.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(egg.tag);
  // final() で認証タグを検証。改ざん・鍵違いなら throw。
  const pt = Buffer.concat([decipher.update(egg.ct), decipher.final()]);
  return pt.toString('utf8');
}
