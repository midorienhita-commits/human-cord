// pubkey.js
// ─────────────────────────────────────────────────────────────
// 柱4 公開鍵検証層(Ed25519)— オフライン第三者検証
// ─────────────────────────────────────────────────────────────
// 設計: Phase 4 統合設計 §5 将来(b)「Ed25519/BLS 署名層でオフライン公開検証」。
//
// human cord のコア(柱9 卵 + 柱4 発行者秘密)は対称鍵で、検証に発行者秘密が要る
// = 発行者媒介検証(発行者だけが open/verify できる)。
// 本層はその「公開検証」相補: 発行者が秘密鍵で「公開可能な事実」に署名し、
// **誰でも発行者の公開鍵だけで真贋をオフライン検証**できる(秘密は不要)。
//   - 秘密鍵 = 発行者の片割れ(信頼境界=サーバにのみ)。
//   - 公開鍵 = 配布してよい(証明書検証ページ・監査人に渡す)。
//
// 鉄板技術のみ・依存ゼロ: node:crypto の Ed25519(RFC 8032)。Web Crypto / Deno でも同一。
//
// 用途分担:
//   - 暗号化して隠す本体(発行者だけが読む) … 柱9 卵 + 柱6 潜在チャネル(issue/verify)
//   - 公開してよい事実を署名(誰でも検証)     … 本層(signStatement/verifyStatement)
//   証明書のように「事実は公開・真贋は誰でも確認」したい場合は本層を使う。

import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey } from 'node:crypto';

/** 発行者の Ed25519 鍵対を生成(PEM)。秘密鍵=片割れ・公開鍵=配布用。 */
export function generateIssuerKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// 鍵順非依存の正準化(再帰的にキーをソート)。署名対象を決定的バイト列にする。
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function canonical(statement) {
  // 署名/検証で同一バイト列になるよう、対象フィールドを固定して正準化。
  return Buffer.from(stableStringify({
    facts: statement.facts,
    docId: statement.docId ?? null,
    issuedAt: statement.issuedAt ?? null,
  }), 'utf8');
}

/**
 * 発行者署名: 公開可能な事実に Ed25519 署名する(秘密鍵が要る=発行者媒介)。
 * @param {object|string} facts        公開してよい本質事実(用途固有スキーマは採用側)
 * @param {string} privateKeyPem       発行者秘密鍵(PKCS8 PEM)
 * @param {{docId?:string|number|null, issuedAt?:string|null}} [opts]
 * @returns {{facts:any, docId:any, issuedAt:any, alg:'ed25519', sig:string}} 署名付きステートメント(配布物)
 */
export function signStatement(facts, privateKeyPem, { docId = null, issuedAt = null } = {}) {
  const statement = { facts, docId, issuedAt };
  const sig = edSign(null, canonical(statement), createPrivateKey(privateKeyPem));
  return { ...statement, alg: 'ed25519', sig: sig.toString('base64') };
}

/**
 * 公開検証: 発行者の公開鍵だけで真贋を確認する(秘密不要・オフライン)。
 * 例外を投げず構造化結果を返す。
 * @param {object} signed         signStatement の出力(JSON 往復可)
 * @param {string} publicKeyPem   発行者公開鍵(SPKI PEM)
 * @returns {{ok:true, facts:any, docId:any} | {ok:false, reason:string}}
 */
export function verifyStatement(signed, publicKeyPem) {
  try {
    if (!signed || signed.alg !== 'ed25519' || typeof signed.sig !== 'string') {
      return { ok: false, reason: 'unsupported or malformed statement' };
    }
    const statement = { facts: signed.facts, docId: signed.docId ?? null, issuedAt: signed.issuedAt ?? null };
    const ok = edVerify(null, canonical(statement), createPublicKey(publicKeyPem), Buffer.from(signed.sig, 'base64'));
    return ok
      ? { ok: true, facts: statement.facts, docId: statement.docId }
      : { ok: false, reason: 'signature mismatch (改ざん or 別発行者)' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
