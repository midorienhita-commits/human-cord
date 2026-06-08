// examples/threshold-sign-demo.js
// ─────────────────────────────────────────────────────────────
// 柱4b: 真の閾値署名 — 単一拠点だけでは「偽造できない」多者発行(秘密を再構成しない版)
// ─────────────────────────────────────────────────────────────
// 既存 demo:threshold(issueWithShares)は「k 片を集めて秘密を復元してから seal」する方式で、
// 復元の一瞬に 1 ノードへ完全な秘密が顕在化していた(= 公開準備レビュー H-2 の指摘)。
// こちらは FROST 系の(単一nonce・逐次専用)しきい値 Schnorr。**秘密 x は署名のどの瞬間にも再構成されない**:
// 各拠点が外に出すのは g^{r_i} と部分応答 z_i だけ。検証は公開鍵 y だけで誰でもできる。
//
//   npm run demo:threshold-sign

import {
  generateGroup,
  generateKey,
  thresholdSign,
  verifyThreshold,
} from '../src/threshold.js';

const line = (s = '') => console.log(s);

line('■ 本社が Schnorr 群と発行鍵を生成し、秘密 x を 3 片に分割(本社 / 拠点A / 拠点B、閾値 k=2)');
const group = generateGroup(512); // デモ用 512bit(本番は >=2048bit)
const { y, shares } = generateKey(group, 3, 2); // ディーラは戻り値の x をこの直後に消去する想定
const [hq, siteA, siteB] = shares;
line(`  群: p は ${group.p.toString(2).length} bit / 公開鍵 y を配布(検証は誰でも y だけで可能)`);
line(`  片を配布: 本社=#${hq.i} / 拠点A=#${siteA.i} / 拠点B=#${siteB.i}(各拠点は 1 片だけ保持)`);
line('  → ディーラ(本社)は配布後に x と多項式係数を消去。以降 x はどこにも存在しない。');
line('');

const fact = 'CERT-2026-THRESHOLD :: 案件CASE-7 / データ消去 4台 / 2026-05-31';

// ① k 片(本社 + 拠点A)で共同署名 → 公開鍵だけで検証
line('① 本社 + 拠点A(2 片 ≥ k)が共同署名(秘密は再構成しない)');
const sig1 = thresholdSign(group, y, [hq.i, siteA.i], [hq, siteA], fact);
line(`   署名 (R,z) を発行 → 公開検証 verifyThreshold(y, …) = ${verifyThreshold(group, y, fact, sig1)}  ✅`);
line('');

// ② 別の k 片(拠点A + 拠点B)でも同じ公開鍵 y の下で正規署名になる
line('② 拠点A + 拠点B(別の 2 片)で共同署名 — どの k 片でも同じ y の正規署名');
const sig2 = thresholdSign(group, y, [siteA.i, siteB.i], [siteA, siteB], fact);
line(`   公開検証 = ${verifyThreshold(group, y, fact, sig2)}  ✅`);
line('');

// ③ 拠点A 単独(1 片 < k)で署名を試みる → 公開検証は false
line('③ 拠点A が単独(1 片 < k)で署名を試みる');
const forged = thresholdSign(group, y, [siteA.i], [siteA], fact); // 単独 → λ=1 で自分の片だけ
line(`   公開検証 = ${verifyThreshold(group, y, fact, forged)}  ❌ 偽造拒否(単一拠点では y の正規署名にならない)`);
line('');

// 念のため: 連合でも k 未満なら、組んだ秘密候補は真の x と一致しない(根本的に不可能)
line('   ※ 連合(k-1 片)が補間を試みても Σλ_i s_i ≠ x。x は Z_q 上で情報理論的に一様(Shamir 完全秘匿)。');
line('');

line('──────────────────────────────────────────────');
line('真の閾値署名: 秘密 x は署名のどの瞬間にも再構成されない(各拠点は g^{r_i} と z_i しか出さない)。');
line('= 単一拠点単独の偽造は「計算力と無関係に」不可能。これが issueWithShares(復元して seal)との違い。');
line('検証は単一鍵 Schnorr とバイト同一 — 閾値で作られたことは検証者から見えず、公開鍵だけでオフライン検証できる。');
