// simmons.js
// ─────────────────────────────────────────────────────────────
// 柱6-ii: 真の Simmons 潜在チャネル(Simmons Subliminal Channel, CRYPTO '83)
// ─────────────────────────────────────────────────────────────
// 表のデータとは別に、発行者だけが読める「第二のメッセージ」を、**署名の乱数自由度(nonce)**に埋める。
// 別フィールドを一切持たない=外部の検証者(看守=warden)には**普通の署名にしか見えない**。鍵を持つ受信者
// だけが nonce を復元して裏を読む。これが本来の Simmons subliminal channel(`subliminal.js` の別フィールド
// XOR=付帯 AEAD とは別物。あちらは 6-i「authenticated 付帯ペイロード」で厳密には subliminal ではない)。
//
// 夢4: 目玉文字の「目」から、人には知覚できないが発行者だけが復号できるノイズが出る — の暗号的実体。
//
// なぜ素数体 DSA か:
//   Ed25519 は決定的(nonce 自由度ゼロ)で古典 subliminal が乗らない。Simmons の原典は乱数化 DLOG 署名
//   (ElGamal/DSA)。柱4b で作った素数体群(threshold.js)の order-q 部分群上の **DSA 署名の nonce k** に
//   covert を埋める。依存ゼロ=node:crypto + native BigInt、群/べき剰余は threshold.js を再利用。
//
// 看守に気づかれない(undetectability)= この方式の定義的性質:
//   nonce k を **正直な一様 nonce と同分布**にしなければ検出される。covert を keystream で XOR し、
//   **切り詰め棄却抽出(0<k<q を満たすまで再試行・mod 還元しない)**で k を厳密一様にする(mod-q バイアス無し)。
//   → 看守が見る (r,s) は正直署名と計算量的に区別不能(HMAC-SHA256 の PRF 安全性に帰着・chi-square で実証)。
//   **本文レベルの注意(重要)**: 表本文には毎回ランダム salt(`|salt=<hex>`)を付す。識別不能性は **(r,s) 分布
//   レベルでは常に成立**するが、**本文レベルでは「全署名に salt を付す」運用規約を前提**とする。裏なしの cover 署名は
//   `signSalted`(同じ salt 形式・ランダム nonce)を使うこと=cover と covert が同形式になり salt の有無/中身は
//   手がかりにならない(salt は一様乱数)。bare な `sign()` は salt を付さない低レベル原語で、単独使用は本文形式で
//   裏の有無を露呈しうる(cover には使わない)。
//
// 正直な限界(誇張しない):
//   - **broadband(本実装)は署名鍵 x を受信者と共有する**=受信者も発行者として署名できてしまう(Simmons
//     broadband の古典的コスト)。署名者と受信者が同一主体/全面信頼の時のみ妥当。署名鍵を渡さない narrowband
//     (k の数ビットだけ・別鍵・低容量)は将来。
//   - **nonce 再利用は致命的**:同じ k で別メッセージ2通に署名すると x が漏れる(Schnorr/DSA 共通)。salt を
//     毎回新規にして k を新鮮化する。
//   - 容量は ~log2(q) ビット/署名(qByteLen-6 byte)。長文は複数署名に分割。
//   - **受動的看守のみ**:署名を改変せず転送する看守は欺けるが、毎回自分の鍵で再署名する能動的看守はチャネルを
//     破壊できる(ただし公開検証で別署名と判る=検出可能)。
//   - 非定数時間(threshold.js の BigInt 由来)。本番群 q>=256bit。
//   - **監査文脈では潜在チャネル自体が警戒対象**(証明書中の covert はバックドアと見なされうる)→ 既定 OFF・
//     標準コアから隔離(層IV)。これは「便利だから載せる」ものではない。

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { generateGroup, modpow, invMod, mod } from './threshold.js';

export { generateGroup };

const DOMAIN = 'human-cord/subliminal-channel-v1';

/** q のバイト長(固定幅エンコード用)。 */
export function qByteLen(q) {
  return (q.toString(16).length + 1) >> 1;
}

/** 1 署名あたりの covert 容量(byte)= 幅 − 2(長さ)− 4(MAC)。 */
export function subliminalCapacityBytes(q) {
  return qByteLen(q) - 6;
}

/** H(m) = sha256(m) mod q。 */
export function hashToScalar(message, q) {
  const h = createHash('sha256').update(Buffer.from(String(message), 'utf8')).digest('hex');
  return mod(BigInt('0x' + h), q);
}

// スカラ → 固定幅ビッグエンディアン bytes
function scalarToBytes(k, width) {
  let hex = k.toString(16);
  if (hex.length > width * 2) throw new Error('scalar wider than width');
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}

// [1,q-1] の厳密一様スカラ(棄却抽出=subliminal の k と同じ分布)
function randScalar(q) {
  const width = qByteLen(q);
  for (;;) {
    const k = BigInt('0x' + randomBytes(width).toString('hex'));
    if (k > 0n && k < q) return k;
  }
}

// keystream: HMAC-SHA256(subKey, DOMAIN|ks|salt|attempt|block) のカウンタモードで width byte
function keystream(subKey, sigSalt, attempt, width) {
  const out = Buffer.alloc(width);
  const a = Buffer.alloc(4); a.writeUInt32BE(attempt >>> 0);
  let off = 0;
  let block = 0;
  while (off < width) {
    const b = Buffer.alloc(4); b.writeUInt32BE(block);
    const blk = createHmac('sha256', subKey).update(DOMAIN).update('|ks|').update(sigSalt).update(a).update(b).digest();
    blk.copy(out, off, 0, Math.min(blk.length, width - off));
    off += blk.length; block += 1;
  }
  return out;
}

// 4 byte MAC(covert の真正性 + 鍵違い検出 + 棄却試行の特定)
function mac4(subKey, sigSalt, lenBuf, msgBuf) {
  return createHmac('sha256', subKey).update(DOMAIN).update('|mac|').update(sigSalt).update(lenBuf).update(msgBuf).digest().subarray(0, 4);
}

// covert(framed)を一様 nonce k に符号化(切り詰め棄却抽出で厳密一様)。
function encipherToNonce(subKey, sigSalt, framed, q, width) {
  for (let attempt = 0; attempt < 1 << 20; attempt += 1) {
    const buf = Buffer.from(keystream(subKey, sigSalt, attempt, width));
    const start = width - framed.length; // framed は低位(右詰め)
    for (let i = 0; i < framed.length; i += 1) buf[start + i] ^= framed[i];
    const k = BigInt('0x' + buf.toString('hex'));
    if (k > 0n && k < q) return k; // mod 還元せず棄却 → 厳密一様
  }
  throw new Error('rejection sampling did not converge');
}

/** DSA 署名鍵対(x=署名秘密、y=公開鍵)。 */
export function generateSigningKey(group) {
  const { p, q, g } = group;
  const x = randScalar(q);
  const y = modpow(g, x, p);
  return { x, y };
}

/** 明示 nonce で署名(r==0/s==0 は null)。内部/テスト用。 */
export function signWithNonce(group, x, message, k) {
  const { p, q, g } = group;
  const e = hashToScalar(message, q);
  const r = mod(modpow(g, k, p), q);
  if (r === 0n) return null;
  const s = mod(invMod(k, q) * mod(e + x * r, q), q);
  if (s === 0n) return null;
  return { r, s };
}

/** 正直署名(毎回新規の一様 nonce)。covert 無し。bare な低レベル原語(salt を付さない)。 */
export function sign(group, x, message) {
  for (;;) {
    const sig = signWithNonce(group, x, message, randScalar(group.q));
    if (sig) return sig;
  }
}

/**
 * cover 署名: 裏なしだが `signWithSubliminal` と**同じ形式**(`<publicMessage>|salt=<hex>`・一様 nonce)で署名する。
 * 潜在の有無で本文形式が変わらないようにするための「囮(cover)」。看守には covert 署名と区別できない。
 * @returns {{message:string, sig:{r:bigint,s:bigint}, sigSalt:string}}
 */
export function signSalted(group, x, publicMessage, opts = {}) {
  for (let tries = 0; tries < 64; tries += 1) {
    const sigSalt = opts.sigSalt ? Buffer.from(opts.sigSalt, 'hex') : randomBytes(16);
    const message = `${publicMessage}|salt=${sigSalt.toString('hex')}`;
    const sig = signWithNonce(group, x, message, randScalar(group.q));
    if (sig) return { message, sig, sigSalt: sigSalt.toString('hex') };
    if (opts.sigSalt) throw new Error('fixed sigSalt produced r/s==0; choose another salt');
  }
  throw new Error('could not produce a salted signature');
}

/**
 * 公開検証(秘密・nonce 不要、公開鍵 y だけ)。標準 DSA 検証=subliminal の有無は見えない。
 * @returns {boolean}
 */
export function verify(group, y, message, sig) {
  try {
    const { p, q, g } = group;
    const r = BigInt(sig.r);
    const s = BigInt(sig.s);
    if (r <= 0n || r >= q || s <= 0n || s >= q) return false;
    const w = invMod(s, q);
    const e = hashToScalar(message, q);
    const u1 = mod(e * w, q);
    const u2 = mod(r * w, q);
    const v = mod(mod(modpow(g, u1, p) * modpow(BigInt(y), u2, p), p), q);
    return v === r;
  } catch {
    return false;
  }
}

/** nonce 復元(署名秘密 x が要る)= 潜在チャネルの読み出し第一段。 */
export function recoverNonce(group, x, message, sig) {
  const { q } = group;
  const e = hashToScalar(message, q);
  const r = BigInt(sig.r);
  const s = BigInt(sig.s);
  return mod(mod(e + x * r, q) * invMod(s, q), q);
}

/**
 * 潜在署名: covert を nonce に埋め、`<publicMessage>|salt=<hex>` に署名する。
 * 返す署名は普通の DSA 署名として公開検証が通る。
 * @param {object} group / @param {bigint} x 署名秘密 / @param {string} publicMessage 表の本文
 * @param {string} covert 裏メッセージ / @param {Buffer} subKey 潜在鍵(署名鍵 x とは別の 32byte)
 * @param {{sigSalt?:string}} [opts]  sigSalt(hex)固定で決定的(テスト用)
 * @returns {{message:string, sig:{r:bigint,s:bigint}, sigSalt:string}}
 */
export function signWithSubliminal(group, x, publicMessage, covert, subKey, opts = {}) {
  const { q } = group;
  const width = qByteLen(q);
  const covertBuf = Buffer.from(String(covert), 'utf8');
  const cap = subliminalCapacityBytes(q);
  if (covertBuf.length > cap) throw new Error(`covert too long: ${covertBuf.length}B > capacity ${cap}B (use a larger group or chunk)`);
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(covertBuf.length);
  for (let tries = 0; tries < 64; tries += 1) {
    const sigSalt = opts.sigSalt ? Buffer.from(opts.sigSalt, 'hex') : randomBytes(16);
    const message = `${publicMessage}|salt=${sigSalt.toString('hex')}`;
    const mac = mac4(subKey, sigSalt, lenBuf, covertBuf);
    const framed = Buffer.concat([lenBuf, covertBuf, mac]); // 2 + len + 4 <= width
    const k = encipherToNonce(subKey, sigSalt, framed, q, width);
    const sig = signWithNonce(group, x, message, k);
    if (sig) return { message, sig, sigSalt: sigSalt.toString('hex') };
    if (opts.sigSalt) throw new Error('fixed sigSalt produced r/s==0; choose another salt');
    // r/s==0(極稀)→ salt 再抽選
  }
  throw new Error('could not produce a valid subliminal signature');
}

/**
 * 潜在メッセージの読み出し(署名秘密 x で nonce 復元 → 潜在鍵 subKey で復号)。
 * 鍵が違えば(x か subKey)MAC 不一致で null。
 * @returns {string|null}
 */
export function recoverSubliminal(group, x, message, sig, subKey, opts = {}) {
  const { q } = group;
  const width = qByteLen(q);
  const m = String(message);
  const saltMatch = m.match(/\|salt=([0-9a-f]+)$/);
  if (!saltMatch) return null;
  const sigSalt = Buffer.from(saltMatch[1], 'hex');
  const buf = scalarToBytes(recoverNonce(group, x, m, sig), width);
  const maxAttempts = opts.maxAttempts ?? 256;
  const cap = subliminalCapacityBytes(q);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const ks = keystream(subKey, sigSalt, attempt, width);
    const pt = Buffer.alloc(width);
    for (let i = 0; i < width; i += 1) pt[i] = buf[i] ^ ks[i];
    for (let len = 0; len <= cap; len += 1) {
      const L = 2 + len + 4;
      if (L > width) break;
      const framed = pt.subarray(width - L);
      if (framed.readUInt16BE(0) !== len) continue;
      const msgBuf = framed.subarray(2, 2 + len);
      const tag = framed.subarray(2 + len);
      if (tag.equals(mac4(subKey, sigSalt, framed.subarray(0, 2), msgBuf))) {
        return msgBuf.toString('utf8');
      }
    }
  }
  return null;
}
