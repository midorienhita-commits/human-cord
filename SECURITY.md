# Security Policy / セキュリティポリシー

## Status: Proof of Concept — NOT audited

This repository is a research proof of concept. **It has not undergone any
third-party security audit.** Do not use it to protect production secrets
without an independent review.

本リポジトリは研究用 POC であり、**第三者によるセキュリティ監査を受けていません**。
独立レビューなしに本番の秘密の保護に使わないでください。

## Assurance by layer / 層別の保証状況

The codebase is not uniform. Adopters who only need public verification can rely on
platform cryptography; the research extensions carry the POC caveats. (層ごとに保証の所在が違う。
公開検証だけを使う採用者は標準実装の暗号のみに依存する。)

| Layer (whitepaper §3.5) | Modules | Cryptography used | Status |
|---|---|---|---|
| **(II) Public verification** — attestation profile v1 (JWS/EdDSA, JWKS, JCS) and v0 | `src/jws.js`, `src/jcs.js`, `src/pubkey.js`, `bin/`, `verify/` | **Ed25519 from `node:crypto` / Web Crypto only. No self-implemented signature arithmetic.** JCS is RFC 8785-conformant (tested against the RFC example) | Suitable for adoption. Independent Python reference verifier agrees on all published vectors |
| **(I) Symmetric issuing core** — seal/open, KDF, ratchet, AEAD chain | `src/cord.js`, `egg.js`, `kdf.js`, `ratchet.js` | AES-256-GCM / HMAC / HKDF from `node:crypto` | Standard primitives, but the *composition* is unaudited. Use behind a trust boundary (server) |
| **(III) Extensions** — Reed-Solomon carrier, Shamir sharing, threshold Schnorr, tally | `src/ecc.js`, `shard.js`, `threshold.js`, `tally.js`, `visual.js`, `image.js`, `photo.js`, `audio.js` | **Self-implemented GF(256) / BigInt modular arithmetic** | Research grade. Not constant-time, not audited. See limitations below |
| **(IV) Isolated / off by default** — subliminal channels, fuzzy extractor | `src/simmons.js`, `subliminal.js`, `fuzzy.js` | mixed | Disabled by default; excluded from the adoption surface |

## Known limitations (honest disclosure) / 既知の限界

These are documented design trade-offs, not undisclosed defects. Details and
measurements live in the whitepaper (`docs/whitepaper-v0.2.*.md`) and
`docs/pillar-threat-map.md`.

- **Non-constant-time arithmetic (layer III only)**: the self-implemented GF(256) / Reed-Solomon
  codec (`src/ecc.js`, `src/shard.js`) and the BigInt modular exponentiation in
  `src/threshold.js` / `src/simmons.js` are **not constant-time**. Timing
  side channels are out of scope for this POC. Layers I and II are unaffected.
  (自作 GF(256)/Reed-Solomon と BigInt modexp は非定数時間=タイミング側路は POC の射程外。層 I・II には該当しない)
- **Python reference verifier** (`verify/verify_attestation.py`): pure-Python RFC 8032 arithmetic,
  verification only, non-constant-time by design. It never touches private keys.
- **Key distribution is out of scope**: `kid` is a thumbprint, not a trust anchor. How a JWKS is
  trusted (HTTPS origin, out-of-band fingerprint, key transparency) is the adopter's responsibility.
- **Threshold signing** (`src/threshold.js`): single-nonce, strictly sequential
  signing sessions only (no concurrent-session hardening); trusted dealer for
  key shares (no DKG); no VSS / identifiable abort. Use groups of at least
  2048 bits in any real deployment.
  (単一 nonce 逐次専用・信頼ディーラ前提・VSS/DKG は将来課題・実運用は 2048bit 以上の群)
- **Shamir path** (`src/shard.js`, `issueWithShares`): reconstruct-then-seal —
  the secret briefly exists in memory at the aggregation point. The true
  threshold scheme that never reconstructs the secret is `src/threshold.js`.
  (Shamir 経路は復元後封緘方式。秘密を再構成しない方式は threshold.js)
- **Tally operator** (`src/tally.js`): HMAC-based minimal implementation, not
  BLS aggregate signatures.(HMAC 最小実装であり BLS ではない)
- **Subliminal channel** (`src/simmons.js`): isolated from the adoption
  surface, disabled by default; covert channels are treated with suspicion by
  auditors by design.(採用面から隔離・既定 OFF)
- **Zero-dependency policy**: no third-party constant-time crypto libraries are
  used, by explicit design choice (only Node's built-in `node:crypto`). For layer II this
  means platform Ed25519; for layer III it means self-implemented field arithmetic.

## Reporting a vulnerability / 脆弱性の報告

Please report suspected vulnerabilities privately by email:

**midorien.hita@gmail.com** (JUNJI MIZUMA)

- Please include reproduction steps or a failing test where possible.
- You should receive an acknowledgement within 7 days.
- Only the `main` branch is supported.

再現手順(可能なら失敗するテスト)を添えて、上記メールアドレスへ非公開でご連絡ください。
7 日以内に受領確認を返します。サポート対象は `main` ブランチのみです。
