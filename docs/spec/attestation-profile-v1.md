# human cord attestation profile v1 (JWS / EdDSA)

Status: draft (2026-09). Normative parts use RFC 2119 keywords. English first, 日本語は各節末尾。

## 1. Purpose

Profile the human cord public-verification layer (Pillar 4d, `pubkey.js`) onto standard containers so that
**anyone can verify an attestation without human cord code**: JWS (RFC 7515) with EdDSA (RFC 8037),
JWK/JWKS (RFC 7517), JWK Thumbprint (RFC 7638) and JSON Canonicalization Scheme (RFC 8785).

> human cord の公開検証層を標準コンテナに載せ、human cord のコード無しで誰でも検証できるようにする。

## 2. Container

An attestation is a JWS Compact Serialization: `BASE64URL(header) '.' BASE64URL(payload) '.' BASE64URL(signature)`.

### 2.1 Protected header

| member | value |
|---|---|
| `alg` | MUST be `"EdDSA"` (Ed25519) |
| `typ` | SHOULD be `"hc-attestation+jwt"` |
| `kid` | MUST be present: the RFC 7638 thumbprint (SHA-256, base64url) of the signing public JWK |

`crit` MUST NOT be used. Verifiers MUST reject any other `alg` (including `none`).

### 2.2 Payload

JSON object. Members:

| member | required | meaning |
|---|---|---|
| `hc` | yes | human cord namespace: `{ "v": 1, "facts": <any JSON>, "issuedAt"?: <RFC 3339> }` |
| `hc.v` | yes | profile version, MUST be the integer `1` |
| `hc.facts` | yes | the attested facts. Schema is defined by the adopter (opaque to this profile) |
| `hc.issuedAt` | no | issuance time with the issuer's original precision |
| `iss` | no | issuer identifier (RFC 7519 §4.1.1) |
| `sub` | no | document / case identifier (`docId` in v0) as a string |
| `iat` | no | `hc.issuedAt` truncated to seconds (RFC 7519 §4.1.6) |

Issuers SHOULD serialize header and payload with JCS (RFC 8785) before base64url so that identical
inputs yield byte-identical JWS (Ed25519 is deterministic). Verifiers MUST NOT depend on this: they
verify the signature over the exact base64url strings received (RFC 7515 §5.2).

### 2.3 Keys

Public keys are JWK `{"kty":"OKP","crv":"Ed25519","x":<base64url 32 bytes>,"kid":<thumbprint>}`.
Adopters publish a JWKS (`{"keys":[...]}`), for example at `/.well-known/human-cord-keys.json`.
Private extension members (this profile): `hc:status` = `active` | `retired` | `revoked`,
`hc:nbf` / `hc:exp` = RFC 3339 key validity window.

Verifier rules: select the key by `kid`; `revoked` → reject; `retired` → accept (past issuance stays valid);
if `hc:nbf`/`hc:exp` are present, the attestation's `hc.issuedAt` (or `iat`) MUST fall inside the window.

## 3. Verification algorithm

1. Split into three parts; base64url-decode header and payload as UTF-8 JSON.
2. Check `alg == "EdDSA"`, no `crit`, `hc.v == 1`.
3. Resolve the key by `kid` from the supplied JWKS/PEM(s). Apply `hc:status` and validity rules.
4. Ed25519-verify `signature` over `ASCII(BASE64URL(header) '.' BASE64URL(payload))`.
5. On success return `hc.facts`, `sub`, `hc.issuedAt`, `iss`, `kid`.

Reference implementations: `src/jws.js` (Node, zero dependency), `verify/verify_attestation.py`
(Python, standard library only, RFC 8032 arithmetic), `examples/verify-jws.html` (browser Web Crypto).
All three MUST agree on `test/vectors/attestation-v1.json`.

## 4. Relation to v0

v0 is the pre-profile object `{facts, docId, issuedAt, alg:"ed25519", sig}` produced by `signStatement`.
Its canonical form is `JCS({facts, docId, issuedAt})` (the historical `stableStringify` is JCS-equivalent;
proven by `test/jcs.test.js` and the Python self-test). v0 remains verifiable via `verifyStatement` /
`verifyAny`. `upgradeLegacy()` re-signs a verified v0 as v1 with the same private key.

## 5. Test vectors

`test/vectors/attestation-v1.json`: two test-only keys derived from the RFC 8032 §7.1 seeds, four positive
cases (nested/unicode/string facts/JCS numbers) with header, payload, JCS forms, JWS, and the v0 twin,
plus four negative cases (tampered payload, wrong key, `alg:none`, truncated signature).
Regenerate with `node tools/gen-vectors.mjs`.

## 6. Security considerations

- Ed25519 via platform crypto (Node `node:crypto`, Web Crypto); no self-implemented signature arithmetic
  on the signing side. The Python verifier is a non-constant-time *reference* and handles public data only.
- `kid` is a thumbprint, not a trust anchor. Trust in a JWKS comes from how it is distributed
  (HTTPS origin, out-of-band fingerprint, key transparency) — out of scope here, as in whitepaper §2.5.
- `alg:none` and algorithm substitution are rejected by construction (only `EdDSA` is accepted).

---

## 付録: 日本語要約

- コンテナは JWS compact、`alg=EdDSA`、`kid`=RFC 7638 サムプリント必須。`crit` 禁止。
- payload は `hc:{v:1, facts, issuedAt?}` に human cord 固有を閉じ込め、`iss`/`sub`(docId)/`iat` は JWT 標準クレーム。
- 発行側は JCS で正準化してから base64url(決定性)。検証側は受け取った文字列そのものを検証する(JWS の規定)。
- 鍵は JWKS で配布。`hc:status`(active/retired/revoked)と `hc:nbf`/`hc:exp` で状態と期間を表す。revoked は不合格、retired は合格。
- v0(`signStatement` 形式)は今後も検証可能。正準化規則は JCS と同一であることをテストで証明済み。
