// jws.test.js — attestation profile v1(JWS EdDSA + JWKS)の振る舞い検証。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import {
  generateKeypair, signAttestation, verifyAttestation, verifyAny, decodeAttestation,
  toPublicJwk, makeJwks, thumbprint, upgradeLegacy, JWS_TYP,
} from '../src/jws.js';
import { signStatement } from '../src/pubkey.js';

const FACTS = { cert: 'CERT-2026-0001', devices: 12, method: ['blancco'], site: 'LOG' };
const AT = '2026-05-31T03:52:04.941Z';

test('発行 → 公開鍵(PEM)だけで検証', () => {
  const { privateKey, publicKey } = generateKeypair();
  const jws = signAttestation(FACTS, privateKey, { docId: 'J-001', issuedAt: AT, iss: 'example-issuer' });
  const r = verifyAttestation(jws, publicKey);
  assert.equal(r.ok, true);
  assert.deepEqual(r.facts, FACTS);
  assert.equal(r.docId, 'J-001');
  assert.equal(r.issuedAt, AT);
  assert.equal(r.iss, 'example-issuer');
});

test('ヘッダは EdDSA / typ / kid(RFC 7638 サムプリント)', () => {
  const { privateKey, publicKey } = generateKeypair();
  const jws = signAttestation(FACTS, privateKey);
  const { header, payload } = decodeAttestation(jws);
  assert.equal(header.alg, 'EdDSA');
  assert.equal(header.typ, JWS_TYP);
  assert.equal(header.kid, thumbprint(toPublicJwk(publicKey)));
  assert.equal(payload.hc.v, 1);
  assert.deepEqual(payload.hc.facts, FACTS);
});

test('決定的: 同じ入力から常に同じ JWS(Ed25519 は決定的署名 + JCS 正準化)', () => {
  const { privateKey } = generateKeypair();
  const a = signAttestation({ b: 1, a: [2, { d: 3, c: 4 }] }, privateKey, { docId: 'X', issuedAt: AT });
  const b = signAttestation({ a: [2, { c: 4, d: 3 }], b: 1 }, privateKey, { docId: 'X', issuedAt: AT });
  assert.equal(a, b);
});

test('JWKS から kid で鍵を選ぶ・別鍵では失敗・kid 不明は失敗', () => {
  const k1 = generateKeypair(); const k2 = generateKeypair(); const k3 = generateKeypair();
  const jwks = makeJwks([k1.publicKey, k2.publicKey]);
  const jws = signAttestation(FACTS, k2.privateKey, { docId: 'J-002' });
  assert.equal(verifyAttestation(jws, jwks).ok, true);
  assert.equal(verifyAttestation(jws, k1.publicKey).ok, false);
  const r3 = verifyAttestation(signAttestation(FACTS, k3.privateKey), jwks);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /unknown kid/);
});

test('改ざん: payload の 1 文字・署名の 1 文字・ヘッダ alg 差し替えはすべて失敗', () => {
  const { privateKey, publicKey } = generateKeypair();
  const jws = signAttestation(FACTS, privateKey, { docId: 'J-003' });
  const [h, p, s] = jws.split('.');
  // payload 改ざん(再エンコード)
  const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
  pl.hc.facts.devices = 9999;
  const p2 = Buffer.from(JSON.stringify(pl)).toString('base64url');
  assert.equal(verifyAttestation(`${h}.${p2}.${s}`, publicKey).ok, false);
  // 署名改ざん
  const s2 = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  assert.equal(verifyAttestation(`${h}.${p}.${s2}`, publicKey).ok, false);
  // alg 差し替え(none 攻撃)
  const h2 = Buffer.from(JSON.stringify({ alg: 'none', typ: JWS_TYP })).toString('base64url');
  assert.equal(verifyAttestation(`${h2}.${p}.`, publicKey).ok, false);
  // 壊れた入力
  assert.equal(verifyAttestation('not.a.jws', publicKey).ok, false);
  assert.equal(verifyAttestation(42, publicKey).ok, false);
});

test('鍵の状態: revoked は不合格、retired は合格、有効期間外は不合格', () => {
  const { privateKey, publicKey } = generateKeypair();
  const jws = signAttestation(FACTS, privateKey, { issuedAt: '2026-06-01T00:00:00Z' });
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, status: 'revoked' }])).ok, false);
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, status: 'retired' }])).ok, true);
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, status: 'retired' }])).keyStatus, 'retired');
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, nbf: '2026-01-01T00:00:00Z', exp: '2026-12-31T00:00:00Z' }])).ok, true);
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, exp: '2026-05-01T00:00:00Z' }])).ok, false);
  assert.equal(verifyAttestation(jws, makeJwks([{ key: publicKey, nbf: '2026-07-01T00:00:00Z' }])).ok, false);
});

test('verifyAny: v0(pubkey.js 形式)と v1(JWS)の両方を同じ鍵で検証', () => {
  const { privateKey, publicKey } = generateKeypair();
  const v0 = signStatement(FACTS, privateKey, { docId: 'J-004', issuedAt: AT });
  const v1 = signAttestation(FACTS, privateKey, { docId: 'J-004', issuedAt: AT });
  const jwks = makeJwks([publicKey]);
  const r0 = verifyAny(v0, jwks); const r1 = verifyAny(v1, jwks);
  assert.equal(r0.version, 0); assert.equal(r0.ok, true); assert.deepEqual(r0.facts, FACTS);
  assert.equal(r1.version, 1); assert.equal(r1.ok, true); assert.deepEqual(r1.facts, FACTS);
  assert.equal(verifyAny({ foo: 1 }, jwks).ok, false);
});

test('upgradeLegacy: v0 を検証してから v1 に再署名、壊れた v0 は拒否', () => {
  const { privateKey, publicKey } = generateKeypair();
  const v0 = signStatement(FACTS, privateKey, { docId: 'J-005', issuedAt: AT });
  const v1 = upgradeLegacy(v0, privateKey, { iss: 'issuer' });
  const r = verifyAttestation(v1, publicKey);
  assert.equal(r.ok, true); assert.equal(r.docId, 'J-005'); assert.equal(r.issuedAt, AT);
  const bad = { ...v0, facts: { ...FACTS, devices: 1 } };
  assert.throws(() => upgradeLegacy(bad, privateKey), /does not verify/);
});

test('JWK ⇄ KeyObject 往復とサムプリントの安定性', () => {
  const { publicKey } = generateKeypair();
  const jwk = toPublicJwk(publicKey);
  const back = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(back, publicKey);
  assert.equal(thumbprint(jwk), jwk.kid);
  assert.equal(toPublicJwk(jwk).kid, jwk.kid);
});
