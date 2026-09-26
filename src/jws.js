// jws.js
// ─────────────────────────────────────────────────────────────
// human cord attestation profile v1 — JWS(EdDSA / Ed25519)+ JWKS
// ─────────────────────────────────────────────────────────────
// 公開検証層(pubkey.js)の「誰でも公開鍵だけでオフライン検証」を、human cord のコードを
// 使わずに検証できる標準コンテナへ載せ替える。
//
//   - コンテナ: JWS Compact Serialization(RFC 7515)、alg = EdDSA(RFC 8037)
//   - 鍵:      JWK(RFC 7517)OKP/Ed25519、kid = JWK Thumbprint(RFC 7638, SHA-256, base64url)
//   - payload: JWT 風クレーム(RFC 7519)+ human cord 固有は `hc` 名前空間に閉じ込める
//       { iss?, sub?(docId), iat?(issuedAt を epoch 秒), hc: { v:1, facts, issuedAt? } }
//   - 署名対象は JWS の規定どおり ASCII(BASE64URL(header) || '.' || BASE64URL(payload))。
//     payload の JSON は JCS(RFC 8785)で正準化してから base64url する(検証には不要だが、
//     同じ facts からは常に同じ JWS が出る=再現性・テストベクタのため)。
//
// v0(pubkey.js の {facts, docId, issuedAt, alg:'ed25519', sig})は別形式として残す。
// 配布済みの v0 は verifyStatement で今後も検証できる。upgradeLegacy() で v1 に再署名できる。
//
// 依存ゼロ: node:crypto の Ed25519 のみ。ブラウザ(Web Crypto)・他言語(verify/ 参照実装)と同一結果。

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { canonicalize } from './jcs.js';
import { verifyStatement } from './pubkey.js';

export const PROFILE_VERSION = 1;
export const JWS_TYP = 'hc-attestation+jwt';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// ── 鍵 ───────────────────────────────────────────────────────

/** Ed25519 鍵対を生成(PEM)。pubkey.js と同形。 */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

/** 公開鍵(PEM / KeyObject / JWK)→ 公開 JWK {kty:'OKP', crv:'Ed25519', x, kid}。 */
export function toPublicJwk(key, { kid } = {}) {
  let ko;
  if (key && typeof key === 'object' && key.kty) ko = createPublicKey({ key, format: 'jwk' });
  else if (key && typeof key === 'object' && typeof key.export === 'function') ko = key.type === 'public' ? key : createPublicKey(key);
  else ko = createPublicKey(key);
  const jwk = ko.export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw new TypeError('Ed25519 key expected');
  const pub = { kty: 'OKP', crv: 'Ed25519', x: jwk.x };
  return { ...pub, kid: kid || thumbprint(pub) };
}

/** RFC 7638 JWK Thumbprint(SHA-256, base64url)。OKP の必須メンバは crv, kty, x(辞書順)。 */
export function thumbprint(jwk) {
  const s = canonicalize({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64u(createHash('sha256').update(s, 'utf8').digest());
}

/** 公開 JWK → KeyObject(検証用)。 */
export function fromPublicJwk(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new TypeError('OKP/Ed25519 JWK expected');
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
}

/**
 * JWKS(RFC 7517 §5)を作る。採用先は /.well-known/human-cord-keys.json 等に置く。
 * @param {Array<string|object|{key:any, kid?:string, status?:'active'|'retired'|'revoked', nbf?:string, exp?:string}>} keys
 */
export function makeJwks(keys) {
  return {
    keys: keys.map((k) => {
      const e = (typeof k === 'object' && k !== null && 'key' in k) ? k : { key: k };
      const jwk = toPublicJwk(e.key, { kid: e.kid });
      const out = { ...jwk, use: 'sig', alg: 'EdDSA' };
      // human cord 拡張(私的クレーム): 鍵の状態と期間。検証時の判定材料。
      if (e.status) out['hc:status'] = e.status;
      if (e.nbf) out['hc:nbf'] = e.nbf;
      if (e.exp) out['hc:exp'] = e.exp;
      return out;
    }),
  };
}

// ── 署名 ─────────────────────────────────────────────────────

/**
 * attestation v1 を発行する(JWS compact)。
 * @param {object|string} facts       公開してよい事実(用途固有スキーマは採用側)
 * @param {string} privateKeyPem      発行者秘密鍵(PKCS8 PEM)
 * @param {{docId?:string|number|null, issuedAt?:string|null, iss?:string|null, kid?:string}} [opts]
 * @returns {string}  compact JWS
 */
export function signAttestation(facts, privateKeyPem, { docId = null, issuedAt = null, iss = null, kid } = {}) {
  const priv = createPrivateKey(privateKeyPem);
  const pubJwk = toPublicJwk(createPublicKey(priv), { kid });
  const header = { alg: 'EdDSA', typ: JWS_TYP, kid: pubJwk.kid };
  const payload = { hc: { v: PROFILE_VERSION, facts } };
  if (iss != null) payload.iss = String(iss);
  if (docId != null) payload.sub = String(docId);
  if (issuedAt != null) {
    const t = Date.parse(issuedAt);
    if (!Number.isFinite(t)) throw new TypeError('issuedAt must be an ISO 8601 date-time');
    payload.iat = Math.floor(t / 1000);
    payload.hc.issuedAt = issuedAt; // 秒未満と元の表記を保持(iat は秒精度)
  }
  const h = b64u(Buffer.from(canonicalize(header), 'utf8'));
  const p = b64u(Buffer.from(canonicalize(payload), 'utf8'));
  const sig = edSign(null, Buffer.from(h + '.' + p, 'ascii'), priv);
  return h + '.' + p + '.' + b64u(sig);
}

// ── 検証 ─────────────────────────────────────────────────────

/** compact JWS を分解(検証はしない)。壊れていれば null。 */
export function decodeAttestation(jws) {
  if (typeof jws !== 'string') return null;
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(unb64u(parts[0]).toString('utf8'));
    const payload = JSON.parse(unb64u(parts[1]).toString('utf8'));
    return { header, payload, signature: parts[2], signingInput: parts[0] + '.' + parts[1] };
  } catch {
    return null;
  }
}

function resolveKey(header, keys) {
  // keys: PEM 文字列 / JWK / JWKS {keys:[…]} / それらの配列
  const list = [];
  const push = (k) => {
    if (k == null) return;
    if (Array.isArray(k)) return k.forEach(push);
    if (typeof k === 'object' && Array.isArray(k.keys)) return k.keys.forEach(push);
    list.push(typeof k === 'string' || k.kty ? toPublicJwkLoose(k) : null);
  };
  push(keys);
  const cands = list.filter(Boolean);
  if (cands.length === 0) return { error: 'no verification key supplied' };
  if (header.kid) {
    const hit = cands.find((j) => j.kid === header.kid);
    if (hit) return { jwk: hit };
    return { error: `unknown kid ${header.kid}` };
  }
  if (cands.length === 1) return { jwk: cands[0] };
  return { error: 'kid missing and multiple keys supplied' };
}
function toPublicJwkLoose(k) {
  try {
    const jwk = toPublicJwk(k, { kid: k && k.kid });
    // JWKS 側の拡張メンバ(hc:status 等)を持ち越す
    return typeof k === 'object' ? { ...k, ...jwk } : jwk;
  } catch { return null; }
}

/**
 * attestation v1 を公開鍵だけで検証する(オフライン・秘密不要)。例外を投げない。
 * @param {string} jws
 * @param {string|object|Array} keys  公開鍵 PEM / JWK / JWKS / それらの配列(kid で選択)
 * @param {{now?:Date|number|string}} [opts]  now: 鍵の hc:nbf / hc:exp 判定に使う時刻
 * @returns {{ok:true, facts:any, docId:any, issuedAt:any, iss:any, kid:string, keyStatus:string|null}
 *          |{ok:false, reason:string, kid?:string}}
 */
export function verifyAttestation(jws, keys, { now } = {}) {
  const d = decodeAttestation(jws);
  if (!d) return { ok: false, reason: 'malformed JWS' };
  const { header, payload } = d;
  if (header.alg !== 'EdDSA') return { ok: false, reason: `unsupported alg ${header.alg}` };
  if (header.typ !== undefined && header.typ !== JWS_TYP) return { ok: false, reason: `unexpected typ ${header.typ}` };
  if (header.crit) return { ok: false, reason: 'crit header not supported' };
  if (!payload || typeof payload !== 'object' || !payload.hc || payload.hc.v !== PROFILE_VERSION) {
    return { ok: false, reason: 'not a human cord attestation v1 payload' };
  }
  const r = resolveKey(header, keys);
  if (r.error) return { ok: false, reason: r.error, kid: header.kid };
  const jwk = r.jwk;

  let ok;
  try {
    ok = edVerify(null, Buffer.from(d.signingInput, 'ascii'), fromPublicJwk(jwk), unb64u(d.signature));
  } catch (e) {
    return { ok: false, reason: 'verify error: ' + e.message, kid: jwk.kid };
  }
  if (!ok) return { ok: false, reason: 'signature mismatch (改ざん or 別発行者)', kid: jwk.kid };

  // 鍵の状態(JWKS の hc:* 拡張)。revoked は不合格、retired は合格(過去発行分は有効)。
  const status = jwk['hc:status'] || null;
  if (status === 'revoked') return { ok: false, reason: 'key revoked', kid: jwk.kid };
  const at = payload.hc.issuedAt ? Date.parse(payload.hc.issuedAt)
    : (payload.iat != null ? payload.iat * 1000 : (now != null ? new Date(now).getTime() : Date.now()));
  if (jwk['hc:nbf'] && at < Date.parse(jwk['hc:nbf'])) return { ok: false, reason: 'issued before key validity (nbf)', kid: jwk.kid };
  if (jwk['hc:exp'] && at > Date.parse(jwk['hc:exp'])) return { ok: false, reason: 'issued after key validity (exp)', kid: jwk.kid };

  return {
    ok: true,
    facts: payload.hc.facts,
    docId: payload.sub ?? null,
    issuedAt: payload.hc.issuedAt ?? (payload.iat != null ? new Date(payload.iat * 1000).toISOString() : null),
    iss: payload.iss ?? null,
    kid: jwk.kid,
    keyStatus: status,
  };
}

/**
 * v0(pubkey.js 形式)/ v1(JWS)のどちらでも検証する採用者向け入口。
 * v0 は PEM 公開鍵が必要(JWKS からは最初の active 鍵、または kid 一致鍵を試す)。
 */
export function verifyAny(att, keys, opts) {
  if (typeof att === 'string' && att.split('.').length === 3) {
    return { version: 1, ...verifyAttestation(att, keys, opts) };
  }
  if (att && typeof att === 'object' && att.alg === 'ed25519') {
    const pems = collectPems(keys);
    for (const pem of pems) {
      const r = verifyStatement(att, pem);
      if (r.ok) return { version: 0, ok: true, facts: r.facts, docId: r.docId, issuedAt: att.issuedAt ?? null };
    }
    return { version: 0, ok: false, reason: pems.length ? 'signature mismatch (改ざん or 別発行者)' : 'no verification key supplied' };
  }
  return { version: null, ok: false, reason: 'unrecognized attestation format' };
}
function collectPems(keys) {
  const out = [];
  const push = (k) => {
    if (k == null) return;
    if (Array.isArray(k)) return k.forEach(push);
    if (typeof k === 'object' && Array.isArray(k.keys)) return k.keys.forEach(push);
    try {
      const ko = typeof k === 'string' ? createPublicKey(k) : fromPublicJwk(k);
      out.push(ko.export({ type: 'spki', format: 'pem' }).toString());
    } catch { /* skip */ }
  };
  push(keys);
  return out;
}

/**
 * v0 attestation を v1(JWS)へ再署名する(移行用。同じ秘密鍵が要る)。
 * v0 の署名を先に検証し、通らなければ拒否(壊れたものを新形式で正当化しない)。
 */
export function upgradeLegacy(att, privateKeyPem, { iss = null, kid } = {}) {
  const pub = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
  const v = verifyStatement(att, pub);
  if (!v.ok) throw new Error('legacy attestation does not verify: ' + v.reason);
  return signAttestation(att.facts, privateKeyPem, { docId: att.docId ?? null, issuedAt: att.issuedAt ?? null, iss, kid });
}
