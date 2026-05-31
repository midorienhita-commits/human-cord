// examples/threshold-demo.js
// ─────────────────────────────────────────────────────────────
// 柱4深化: 閾値発行(Shamir)— 単一拠点だけでは偽造できない「多者発行」
// ─────────────────────────────────────────────────────────────
// 戦略ドクトリン「根は"変えられないもの"(情報理論)で守る」の実証(依存ゼロ)。
//   発行者の片割れ(秘密)を n 片に分割し、k 片を持ち寄った時だけ正規発行できる。
//   k 片未満では、計算能力が無限でも秘密を復元できない(情報理論的)=
//   どんな計算力でも単一拠点単独の偽造は成立しない。
//   突破のボトルネックは「計算力」ではなく「物理的に持つ片割れの枚数」。
//
//   npm run demo:threshold

import { splitIssuerSecret, issueWithShares, verify, SmokeLog } from '../src/issue.js';

const issuerSecret = 'HQ-master-issuer-secret-本社の片割れ-2026';
const facts = { cert: 'CERT-2026-THRESHOLD-DEMO', docId: 'CASE-7', devices: 4, issuedAt: '2026-05-31' };

const line = (s = '') => console.log(s);

line('■ 発行者秘密(根)を 3 片に分割 — 本社 / 拠点A / 拠点B、閾値 k=2');
const [hq, siteA, siteB] = splitIssuerSecret(issuerSecret, 3, 2);
line(`  片を配布: 本社=x${hq.x} / 拠点A=x${siteA.x} / 拠点B=x${siteB.x}(各拠点は1片だけ保持)`);
line('');

// ① k 片(本社 + 拠点A)を持ち寄って正規発行
line('① 本社 + 拠点A(2 片 ≥ k)を持ち寄って発行');
const { carrier } = issueWithShares(facts, [hq, siteA], { context: 'cert', docId: facts.docId, issuedAt: facts.issuedAt });
const r1 = verify(carrier, issuerSecret, { smokeLog: new SmokeLog() });
line(`   → 発行者秘密で検証: ok=${r1.ok} verdict=${r1.verdict}  ✅ 正規発行`);
line('');

// ② 別の k 片(拠点A + 拠点B)でも同じ正規発行になる(どの k 片でも復元可)
line('② 拠点A + 拠点B(別の 2 片)で発行 — どの k 片でも同じ根が復元される');
const { carrier: c2 } = issueWithShares(facts, [siteA, siteB], { context: 'cert', docId: facts.docId, issuedAt: facts.issuedAt });
const r2 = verify(c2, issuerSecret, { smokeLog: new SmokeLog() });
line(`   → 検証: ok=${r2.ok} verdict=${r2.verdict}  ✅ 正規発行`);
line('');

// ③ 拠点A 単独(1 片 < k)で発行を試みる → 正規秘密では検証不能(偽造不可)
line('③ 拠点A が単独(1 片 < k)で発行を試みる');
const { carrier: forged } = issueWithShares(facts, [siteA], { context: 'cert', docId: facts.docId, issuedAt: facts.issuedAt });
const sl = new SmokeLog();
const r3 = verify(forged, issuerSecret, { smokeLog: sl });
line(`   → 発行者秘密で検証: ok=${r3.ok} verdict=${r3.verdict}  ❌ 偽造拒否(単一拠点では正規化できない)`);
line(`     煙(柱8): ${sl.entries.map((e) => e.type).join(',') || '(なし)'}`);
line('');

line('──────────────────────────────────────────────');
line('k 片未満は計算が無限でも秘密を復元できない(情報理論的安全)。');
line('= 単一拠点単独の偽造は「計算力と無関係に」不可能。これが「変えられない根」。');
line('表(公開検証の署名)は差し替え可能な床、根はこの閾値で固める。');
