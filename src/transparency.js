// transparency.js
// ─────────────────────────────────────────────────────────────
// 透明性ログ(RFC 6962 / RFC 9162 Merkle Tree)— 追記専用ログの「歴史不変」証明
// ─────────────────────────────────────────────────────────────
// 柱8(煙=改ざんの痕跡を残す)の実体を、採用先の監査ログ基盤に持ち込める形で提供する。
//   - ルート        : ログ全体を 32 byte に束ねる(RFC 9162 §2.1.1)
//   - 包含証明      : 「この行はこのルートに含まれる」(§2.1.3)
//   - 整合証明      : 「新ルートは旧ルートの追記拡張=過去は書き換わっていない」(§2.1.4)
//   - チェックポイント: {tree_size, root, prev} を JCS で正準化し attestation v1 で署名(§3)
// 依存ゼロ(node:crypto の SHA-256 のみ)。ドメイン分離 0x00(葉)/ 0x01(内部)で第二原像攻撃を遮断。
//
// 採用例: 監査ログ表に seq(全順序)と leaf_hash(行の正準直列化の SHA-256)を持たせ、
//   定期的に signCheckpoint() で署名済みルートを記録し、外部(顧客配布物・公開リポジトリ)へ
//   複製する。監査人は verifyInclusion / verifyConsistency と公開鍵だけで、運用者を信用せずに
//   「行が存在した」「履歴が縮んでいない」を確かめられる。SQL 側の雛形は docs/adopters/ を参照。
//
// 実装ノート: 再帰 + 部分配列で O(n log n)。数万行までは十分。それ以上は compact range を検討。

import { createHash } from 'node:crypto';
import { canonicalize } from './jcs.js';
import { signAttestation, verifyAttestation } from './jws.js';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const sha256 = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** 空の木のルート = SHA-256 of empty string(RFC 9162 §2.1.1) */
export const EMPTY_ROOT = sha256();

/** 葉ハッシュ: SHA-256(0x00 || entry) */
export function leafHash(entry) {
  return sha256(LEAF_PREFIX, entry);
}
/** 内部ノード: SHA-256(0x01 || left || right) */
export function nodeHash(left, right) {
  return sha256(NODE_PREFIX, left, right);
}

// n(>=2)未満で最大の 2 の冪
function largestPowerOfTwoBelow(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle Tree Hash(RFC 9162 §2.1.1)。
 * @param {Buffer[]} entries 葉エントリ(ハッシュ前のデータ)。順序が意味を持つ
 * @returns {Buffer} 32 byte ルート
 */
export function merkleRoot(entries) {
  const n = entries.length;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leafHash(entries[0]);
  const k = largestPowerOfTwoBelow(n);
  return nodeHash(merkleRoot(entries.slice(0, k)), merkleRoot(entries.slice(k)));
}

/**
 * 包含証明(RFC 9162 §2.1.3.1)。葉 index の監査パス(葉側から根側へ)。
 * @param {Buffer[]} entries  木サイズ分の全葉
 * @param {number} index      0 起点
 * @returns {Buffer[]}
 */
export function inclusionProof(entries, index) {
  const n = entries.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new RangeError(`index ${index} out of [0,${n})`);
  if (n === 1) return [];
  const k = largestPowerOfTwoBelow(n);
  return index < k
    ? [...inclusionProof(entries.slice(0, k), index), merkleRoot(entries.slice(k))]
    : [...inclusionProof(entries.slice(k), index - k), merkleRoot(entries.slice(0, k))];
}

/**
 * 包含証明の検証(RFC 9162 §2.1.3.2)。
 * @param {Buffer} entry  葉エントリ(ハッシュ前)
 */
export function verifyInclusion(entry, index, treeSize, proof, root) {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize) || index < 0 || index >= treeSize) return false;
  let fn = index, sn = treeSize - 1;
  let r = leafHash(entry);
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && r.equals(root);
}

/**
 * 整合証明(RFC 9162 §2.1.4.1): サイズ m の旧木がサイズ n の新木の接頭辞であることの証明。
 * @param {Buffer[]} entries 新木の全葉
 * @param {number} oldSize   m(0 <= m <= n)
 */
export function consistencyProof(entries, oldSize) {
  const n = entries.length;
  if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > n) throw new RangeError(`oldSize ${oldSize} out of [0,${n}]`);
  if (oldSize === 0 || oldSize === n) return [];
  return subProof(entries, oldSize, true);
}
function subProof(entries, m, complete) {
  const n = entries.length;
  if (m === n) return complete ? [] : [merkleRoot(entries)];
  const k = largestPowerOfTwoBelow(n);
  return m <= k
    ? [...subProof(entries.slice(0, k), m, complete), merkleRoot(entries.slice(k))]
    : [...subProof(entries.slice(k), m - k, false), merkleRoot(entries.slice(0, k))];
}

/** 整合証明の検証(RFC 9162 §2.1.4.2)。 */
export function verifyConsistency(oldSize, newSize, proof, oldRoot, newRoot) {
  if (!Number.isInteger(oldSize) || !Number.isInteger(newSize) || oldSize < 0 || oldSize > newSize) return false;
  if (oldSize === 0) return proof.length === 0;
  if (oldSize === newSize) return proof.length === 0 && oldRoot.equals(newRoot);
  const path = (oldSize & (oldSize - 1)) === 0 ? [oldRoot, ...proof] : proof; // m が 2 の冪なら旧ルートを先頭に補う
  if (path.length === 0) return false;
  let fn = oldSize - 1, sn = newSize - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  let fr = path[0], sr = path[0];
  for (const p of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(p, fr); sr = nodeHash(p, sr);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      sr = nodeHash(sr, p);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr.equals(oldRoot) && sr.equals(newRoot);
}

// ── チェックポイント(署名済みルート)─────────────────────────────

/** チェックポイントの正準形(署名・連鎖の対象)。id は採番前なので含めず、prev で連鎖する。 */
export function checkpointCanonical({ treeSize, rootHex, prevHex = '', origin = null }) {
  const o = { v: 1, tree_size: treeSize, root: rootHex, prev: prevHex || '' };
  if (origin != null) o.origin = String(origin);
  return canonicalize(o);
}
/** チェックポイントハッシュ = SHA-256(正準形)。次のチェックポイントの prev になる。 */
export function checkpointHash(fields) {
  return sha256(Buffer.from(checkpointCanonical(fields), 'utf8'));
}

/**
 * チェックポイントを作って attestation v1 で署名する。
 * @param {Buffer[]} entries  現在の全葉(seq 順)
 * @param {string} privateKeyPem
 * @param {{prev?:{tree_size:number, root:Buffer|string, hash:Buffer|string}|null, origin?:string|null, issuedAt?:string}} [opts]
 *   prev: 直前のチェックポイント。与えると「旧ルートが現在の接頭辞か」を先に検査し、破れていれば alarm を返す。
 * @returns {{ok:true, checkpoint:{tree_size:number, root:string, prev:string, hash:string, origin:string|null}, attestation:string}
 *          |{ok:false, alarm:string, detail:object}}
 */
export function signCheckpoint(entries, privateKeyPem, { prev = null, origin = null, issuedAt = new Date().toISOString() } = {}) {
  const treeSize = entries.length;
  if (prev) {
    const prevSize = Number(prev.tree_size);
    const prevRoot = toBuf(prev.root);
    if (prevSize > treeSize) return { ok: false, alarm: 'log shrunk since last checkpoint', detail: { checkpointed: prevSize, current: treeSize } };
    if (!merkleRoot(entries.slice(0, prevSize)).equals(prevRoot)) {
      return { ok: false, alarm: 'history rewritten: prefix root mismatch with previous checkpoint', detail: { tree_size: prevSize } };
    }
  }
  const rootHex = merkleRoot(entries).toString('hex');
  const prevHex = prev ? toBuf(prev.hash).toString('hex') : '';
  const fields = { treeSize, rootHex, prevHex, origin };
  const hash = checkpointHash(fields).toString('hex');
  const facts = { type: 'transparency-checkpoint', tree_size: treeSize, root: rootHex, prev: prevHex, ...(origin != null ? { origin: String(origin) } : {}) };
  const attestation = signAttestation(facts, privateKeyPem, { docId: origin ?? 'transparency', issuedAt });
  return { ok: true, checkpoint: { tree_size: treeSize, root: rootHex, prev: prevHex, hash, origin: origin ?? null }, attestation };
}

/**
 * 署名済みチェックポイントを公開鍵だけで検証し、facts と(任意で)現在の葉との整合を確かめる。
 * @param {string} attestation  signCheckpoint の JWS
 * @param {string|object} keys  公開鍵 PEM / JWK / JWKS
 * @param {{entries?:Buffer[]}} [opts]  entries を渡すと「チェックポイントは現在の木の接頭辞か」も検査
 */
export function verifyCheckpoint(attestation, keys, { entries } = {}) {
  const r = verifyAttestation(attestation, keys);
  if (!r.ok) return r;
  const f = r.facts;
  if (!f || f.type !== 'transparency-checkpoint' || !Number.isInteger(f.tree_size) || typeof f.root !== 'string') {
    return { ok: false, reason: 'not a transparency checkpoint attestation' };
  }
  const out = { ok: true, checkpoint: { tree_size: f.tree_size, root: f.root, prev: f.prev || '', origin: f.origin ?? null }, kid: r.kid, issuedAt: r.issuedAt };
  if (entries) {
    if (entries.length < f.tree_size) return { ok: false, reason: 'current log shorter than checkpoint (deletion?)', checkpoint: out.checkpoint };
    const prefixRoot = merkleRoot(entries.slice(0, f.tree_size)).toString('hex');
    if (prefixRoot !== f.root) return { ok: false, reason: 'checkpoint root is not a prefix of the current log (history rewritten?)', checkpoint: out.checkpoint };
    out.prefixOfCurrent = true;
  }
  return out;
}

function toBuf(v) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'string') return Buffer.from(v.startsWith('\\x') ? v.slice(2) : v, 'hex');
  throw new TypeError('Buffer or hex string expected');
}
