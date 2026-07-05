# Security Policy / セキュリティポリシー

## Status: Proof of Concept — NOT audited

This repository is a research proof of concept. **It has not undergone any
third-party security audit.** Do not use it to protect production secrets
without an independent review.

本リポジトリは研究用 POC であり、**第三者によるセキュリティ監査を受けていません**。
独立レビューなしに本番の秘密の保護に使わないでください。

## Known limitations (honest disclosure) / 既知の限界

These are documented design trade-offs, not undisclosed defects. Details and
measurements live in the whitepaper (`docs/whitepaper-v0.2.*.md`) and
`docs/pillar-threat-map.md`.

- **Non-constant-time arithmetic**: the self-implemented GF(256) / Reed-Solomon
  codec (`src/ecc.js`, `src/shard.js`) and the BigInt modular exponentiation in
  `src/threshold.js` / `src/simmons.js` are **not constant-time**. Timing
  side channels are out of scope for this POC.
  (自作 GF(256)/Reed-Solomon と BigInt modexp は非定数時間=タイミング側路は POC の射程外)
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
- **Zero-dependency policy**: no battle-tested constant-time crypto libraries
  are used, by explicit design choice (only Node's built-in `node:crypto`).
  (依存ゼロ方針のため、実績ある定数時間ライブラリを意図的に使っていない)

## Reporting a vulnerability / 脆弱性の報告

Please report suspected vulnerabilities privately by email:

**midorien.hita@gmail.com** (JUNJI MIZUMA)

- Please include reproduction steps or a failing test where possible.
- You should receive an acknowledgement within 7 days.
- Only the `main` branch is supported.

再現手順(可能なら失敗するテスト)を添えて、上記メールアドレスへ非公開でご連絡ください。
7 日以内に受領確認を返します。サポート対象は `main` ブランチのみです。
