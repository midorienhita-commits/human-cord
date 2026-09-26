# human cord

**嘘では逃げられない情報インフラ** — A cryptographic infrastructure for documentary integrity in the AI era.

`cord ≠ code`. 人と人、人と真実を結ぶ「紐」としての暗号インフラ。

> 公開できる事実の真贋なら、既存の電子署名で足りる——human cord はその公開検証層(Ed25519・ブラウザだけで誰でもオフライン検証)を自身の一層として備える。その上に、署名単体では出せない二つ——本体を封じたまま発行者だけが真贋を判定できる封印本体と、単一拠点では発行できない閾値発行——を一度の発行で同じ一枚に束ね、紙に印刷しスマホで撮影しても検証まで戻ることを実測してある(依存ゼロ)。

---

## ▶ 採用する:attestation profile v1(JWS / EdDSA)— human cord のコード無しで検証できる

公開検証層を **標準コンテナ**(JWS RFC 7515 + EdDSA RFC 8037、JWK/JWKS RFC 7517、kid = RFC 7638、正準化 = JCS RFC 8785)に載せた。
発行は 5 行、検証は既存の JWS ライブラリでも、同梱の **依存ゼロ Python 参照実装**でも、ブラウザ 1 枚でもできる。

```js
import { generateKeypair, signAttestation, verifyAttestation, makeJwks } from 'human-cord/attest';

const { privateKey, publicKey } = generateKeypair();          // 秘密鍵はサーバにのみ
const jws = signAttestation({ cert: 'CERT-2026-0001', devices: 12 }, privateKey,
                            { docId: 'J-001', issuedAt: '2026-05-31T03:52:04Z', iss: 'example' });
const jwks = makeJwks([publicKey]);                            // /.well-known/human-cord-keys.json に置く
verifyAttestation(jws, jwks);   // → { ok:true, facts:{…}, docId:'J-001', kid:'…' }
```

```bash
npx human-cord keygen --out keys/                 # 鍵対 + 公開 JWK
npx human-cord sign facts.json --key keys/issuer-private.pem --doc-id J-001 > att.jws
npx human-cord jwks keys/issuer-public.pem > keys.json
npx human-cord verify att.jws --keys keys.json    # 終了コード 0/1
python3 verify/verify_attestation.py att.jws --keys keys.json   # 独立実装(標準ライブラリのみ)で同じ答え
```

- 仕様: [`docs/spec/attestation-profile-v1.md`](docs/spec/attestation-profile-v1.md)。
- テストベクタ: [`test/vectors/attestation-v1.json`](test/vectors/attestation-v1.json)(RFC 8032 §7.1 のシード由来のテスト専用鍵・肯定 4 例・否定 4 例)。Node と Python が全件一致。
- 汎用検証ページ: [`examples/verify-jws.html`](examples/verify-jws.html)(`?jws=…&keys=<JWKS URL>` または `&jwks=<base64url(JWKS)>` で完全オフライン)。採用先ごとの写しは不要。
- 従来の v0(`signStatement` 形式)は今後も検証できる(`verifyAny`)。正準化規則が JCS と同一であることはテストで証明済み。
- 保証の所在は層ごとに違う → [`SECURITY.md`](SECURITY.md) の層別表。公開検証層は `node:crypto` / Web Crypto の Ed25519 のみで、自作暗号を含まない。

---

## ▶ まず触る:公開検証(30 秒・サーバ不要)

[`examples/verify.html`](examples/verify.html) をブラウザで開くだけ。発行者の**公開鍵だけ**で、
証明書が本物か・改ざんされていないかを**オフラインで**(サーバ通信なし)確かめられます。

- 開いた瞬間に実例(実際に発行した消去証明書)を自動検証 → **✓ 緑(正規・改ざんなし)**
- **「⚠ 改ざんしてみる」**を押すと、数値が 1 つ変わるだけで **✗ 赤(署名不一致)**

これが human cord の一番分かりやすい入口です。後述の 5 機能コア・10 柱は、このデモの「裏側の理屈」。
**まず動くものを見て、必要になったら設計を読む** —— の順で十分です。

---

## ▶ 実測:紙に印刷し、スマホで撮影して、検証まで戻る

主張ではなく測定で語る。暗号担体(HC2 = Reed-Solomon 誤り訂正付き視覚フレーム)を実環境で復元できることを実測済み:

- **実印刷**: コンビニのカラーレーザー印刷 → スマホ撮影で、**4 密度ティア(91² / 112² / 136² / 187² モジュール)すべてが単フレーム復号**に到達。
- **画面撮影**: 単フレーム復元率 ~48%、**バースト撮影のフレーム融合で全 3 担体を復元**。finder 局所化は 22/22。
- 復号側は依存ゼロ(`node:zlib` のみ)。撮影→復号の測定キットは `tools/real-camera/`、測定記録は `docs/phase2-pillar7-visual-channel.md` §5.15–§5.17。

条件と限界も正直に記録している(画面モアレは capture 律速・高密度 187² の融合はモアレ位相で悪化=単フレーム多数撮りが正解、など)。

---

## ▶ 仕様の核は 5 機能

10 柱は着想の全体地図(後述)だが、脅威→機構→性質で棚卸しすると(`docs/pillar-threat-map.md`)、仕様の核は実質 5 つに絞れる:

| # | 機能 | 何が新しいか / 何に効くか | 実装 |
|---|---|---|---|
| 1 | **対称発行コア** | KDF(多軸)+ AEAD ハッシュ鎖 + ratchet + 最小開示。本体を封じたまま発行者だけが真贋判定(封印本体) | `src/kdf.js` `egg.js` `ratchet.js` `cord.js` |
| 2 | **公開検証層(Ed25519)** | 公開可能な事実は誰でも・公開鍵だけで・オフライン検証(上のキラーデモ) | `src/pubkey.js` |
| 3 | **秘匿突き合わせ(割符 `+/-`)** | 本体を開示せず同一案件の統合 / 差分を判定 | `src/tally.js` `issue.js` |
| 4 | **閾値発行** | 単一拠点では発行できない。真の閾値署名(秘密を一度も再構成しないしきい値 Schnorr・素数体・依存ゼロ)まで実装到達 | `src/threshold.js` `shard.js` |
| 5 | **印刷可能担体 + 誤り訂正** | Reed-Solomon over GF(256)。紙・画面・音に載せて実測で復元(上の実測) | `src/ecc.js` `image.js` `photo.js` `audio.js` |

この 5 つを**一度の発行で同じ一枚に束ねる**のが採用面 `src/issue.js` の `issue()`。

---

> 本リポジトリは Phase 1(最小 POC)です。設計の全体像・10 本の柱・哲学的背景は
> 構想白書 v0.2(`docs/whitepaper-v0.2.ja.md` / 英語版 `.en.md`、PDF 同梱)を参照してください。
> 本 POC は 10 柱すべてに実装を到達させた「動く最小版」です。

---

## 10 柱の概念地図(Phase 1 POC のスコープ)

「文字 1 個が辿る道」を最小実装し、**発行 → 卵の鎖 → 改ざん検知**の一周を動かす。

| 柱 | 実装 | ファイル |
|---|---|---|
| **柱1 干支型多軸鍵生成** | 公開軸(時間多軸)× 私的軸(発行者秘密)→ コードブック(HKDF) | `src/kdf.js` |
| **柱9 卵流アーキテクチャ** | AES-256-GCM(AEAD)+ ハッシュチェーン | `src/egg.js` |
| **柱5 生きた演算子** | HMAC ベースの一方向 ratchet(卵ごとに鍵が進む) | `src/ratchet.js` |
| **柱2 風景溶込み** | 目玉文字置換(表示用レイヤー、検証非依存) | `src/eyeglyph.js` |
| **柱3 割符演算 `+/-`** | 通行手形(HMAC tally)で `+` 統合 / `-` 差分発火 | `src/tally.js` |
| **柱4 発行者の片割れ** | 発行者秘密が無いとコードブック・通行手形を再現不能 | `src/cord.js` |
| **柱4深化 割符の情報理論的分割** | Shamir 秘密分散(GF256)。閾値未満は計算無限でも復元不能 | `src/shard.js` |
| **柱4/7 人間の曖昧さを鍵源に** | Fuzzy Extractor。手相・虹彩から誤り訂正で安定鍵を再生(生体は保存しない) | `src/fuzzy.js` |
| **柱4 公開鍵検証層(Ed25519)** | 公開可能な事実に発行者署名 → 公開鍵だけでオフライン第三者検証(秘密不要)。対称コアの相補 | `src/pubkey.js` |
| **柱4b 真の閾値署名** | 秘密を署名のどの瞬間にも再構成しないしきい値 Schnorr(素数体 DLOG 群・依存ゼロ・公開検証可)。k−1 拠点の連合でも発行不能 | `src/threshold.js` |
| **柱6-i 付帯ペイロード** | 発行者だけが読める裏メッセージ(authenticated 付帯フィールド。厳密には subliminal channel ではない=正直な枠づけ) | `src/subliminal.js` |
| **柱6-ii 真の Simmons 潜在チャネル** | DSA 署名の nonce に covert を埋込(付帯フィールド無し・(r,s) レベルで看守に検出不能)。監査で警戒される性質ゆえ採用面から隔離・既定 OFF | `src/simmons.js` |
| **柱8 能動的発火応答** | 改ざん検知を append-only ハッシュチェーンログ(煙)に永久記録 | `src/smoke.js` |
| **柱7 物理層出力(視覚チャネル)** | 媒体非依存フレーム codec(HC1 検知 / HC2 = Reed-Solomon 誤り訂正)+ リプレイ防止(nonce 一回性 + 鮮度窓 + 煙) | `src/visual.js` |
| **柱7 実ピクセル / カメラ撮影復号** | 実 PNG 描画・finder 検出・ホモグラフィ補正・レンズ歪み補正・フレーム融合・deflicker。**実印刷・実カメラで復元を実測済(上記「実測」)** | `src/image.js` `photo.js` `budget.js` |
| **柱7 物理層: 誤り訂正(ECC)** | Reed-Solomon over GF(256)(QR と同じ field, 依存ゼロ)。担体ノイズ・バースト・部分欠損を訂正。fuzz テスト済 | `src/ecc.js` |
| **柱7 物理層出力(音響担体)** | FSK 音響 codec(+ WAV、RS 訂正フレーム)+ リプレイ防止(視覚と共通)。「見えない著作権コード」= 鍵付き署名を音に乗せる。不可聴化/実マイク同期は Phase 2+ | `src/audio.js` |
| **柱10 失敗境界の自己観測抵抗** | 改ざん検知で露出するのは「型(seq)」のみ、核は不漏 | `src/cord.js` |

柱7 はプロトコル層(担体 codec + リプレイ防止)を Phase 2 最小縦切りとして実装済で、
**視覚(`src/visual.js`)と音響(`src/audio.js`)の 2 担体**に枝分かれする。リプレイ防止
(FreshnessGuard / 忠実復元)は `src/freshness.js` に共通化し両担体で共有。
誤り訂正は `src/ecc.js`(Reed-Solomon / 依存ゼロ)で実装し、視覚(HC2)・音響(RS フレーム)の両担体に統合済。
視覚は実ピクセル(`src/image.js`)→ カメラ撮影復号(`src/photo.js`: finder 検出・ホモグラフィ・
レンズ歪み補正・フレーム融合・deflicker)→ 可読性バジェット(`src/budget.js`)まで実装し、
**実印刷・実カメラで復元を実測済**(冒頭「実測」参照)。残り(音の不可聴化=心理音響マスキング・実マイク同期)は継続。
設計・測定記録は `docs/phase2-pillar7-visual-channel.md` / `docs/phase2-pillar7-audio-channel.md` を参照。

### 柱6-i 付帯ペイロード / 柱8 発火応答

```js
import { embedSubliminal, readSubliminal } from './src/subliminal.js';
import { SmokeLog, guardedOpen } from './src/smoke.js';

// 柱6: 表は誰でも検証できるが、裏は発行者だけが読める
let cord = embedSubliminal(seal('証明書本体', secret, 'ctx'), secret, '発行者控え');
readSubliminal(cord, secret);      // → '発行者控え'
readSubliminal(cord, otherSecret); // → null(ノイズにしか見えない)

// 柱8: 改ざんを検知したら「煙」を append-only ログに記録(遡及改ざん不能)
const log = new SmokeLog();
guardedOpen(tamperedCord, secret, log); // 改ざんなら throw + log.raise('tamper', …)
log.verify();                           // ログ自体の整合性(煙は消せない)
```

- 柱6-i は夢4(目玉の見えないノイズ)/ 白書 §4.1。表チャネル(open)に影響しない独立の第二チャネル
  (authenticated 付帯フィールド方式=厳密には subliminal channel ではない)。**真の Simmons 潜在チャネルは
  柱6-ii(`src/simmons.js`・署名 nonce 埋込・`npm run demo:simmons`)**として別実装(採用面から隔離・既定 OFF)。
- 柱8 は夢6(悪さをすると煙が立つ)。「火のないところに煙は立たぬ」の逆実装。罰しないが、煙は誰の目にも残る(第二条)。

### 柱1 干支型多軸鍵(時計は公開・秘密だけが片割れ)

コードブック = **公開軸(発行時刻の時間多軸:曜日 × 時刻 × 偶奇 × エポック)× 私的軸(発行者秘密)**を HKDF で結合した「その瞬間専用の鍵素材」。ratchet(柱5)と通行手形(柱3)の共通の根になる。

時間多軸は `cord.kdf` に平文保存され、検証側が同じコードブックを再現できる(時計は公開)。一方、発行者秘密が無ければコードブックは導出できない(秘密は片割れ)。

```js
const cord = seal('…', secret, 'ctx', { axes });  // axes 省略時は現在時刻
// cord.kdf : { epoch, weekday, hour, parity } ← 公開軸(時計)
// 発行者秘密なしでは open も verifyTally も不能(片割れ)
```

### 柱3 割符演算(`+/-`)

江戸の通行手形(割符)= 割った 2 片が噛み合うかで本人確認する仕組み。
2 つの cord が同一発行者・同一案件(`docId`)なら `+` で統合、噛み合わなければ
`-` で差分を返す(エラーではなく「どう違うか」という有用情報)。

```js
import { combine } from './src/tally.js';

const a = seal('消去記録…', secret, 'cert', { docId: 'CASE-0042' });
const b = seal('破砕記録…', secret, 'cert', { docId: 'CASE-0042' });
combine(a, b, secret);   // → { op:'+', matched:true, merged:'消去記録…破砕記録…' }

const other = seal('別案件', secret, 'cert', { docId: 'CASE-9999' });
combine(a, other, secret); // → { op:'-', matched:false, diff:{ reason:'別案件…' } }
```

夢 1・2 の原典「A+B=一つの文章(合致)/ A−B=違う単文(差分)」に対応。
白書 §4.3 の BLS 集約署名の演算子化を、POC では依存ゼロの HMAC 通行手形で最小実装
(将来 BLS / Accumulator へ差し替え可能な境界として設計)。

---

## 使い方

```bash
npm run demo:e2e            # ★統合デモ: 証明書ライフサイクルで 10 柱+2担体が噛み合う通し
npm run demo                # ひと回しデモ(発行→検証→片割れ拒否→改ざん検知)
npm run demo:issue          # 採用面: 発行 / 発行者媒介検証(verify は構造化結果を返す)
npm run demo:pubkey         # コア2 公開鍵検証層(Ed25519、公開鍵だけでオフライン検証)
npm run demo:tally          # コア3 割符演算(+ 統合 / − 差分発火)
npm run demo:reconstruct    # コア3 相同組換え: 複数担体から案件の本質事実を再建
npm run demo:threshold      # コア4 閾値発行(Shamir): 単一拠点では発行不可
npm run demo:threshold-sign # コア4 真の閾値署名(しきい値 Schnorr・秘密を再構成しない)
npm run demo:shard          # コア4 Shamir 秘密分散(閾値未満は復元不能)
npm run demo:ecc            # コア5 誤り訂正(Reed-Solomon で担体ノイズを訂正)
npm run demo:visual         # コア5 視覚チャネル(担体 codec + リプレイ防止 + 煙)
npm run demo:image          # コア5 実ピクセル担体(実PNG 描画→抽出、部分遮蔽に耐性)
npm run demo:photo          # コア5 カメラ撮影復号(finder・ホモグラフィ・歪み補正・融合)
npm run demo:budget         # コア5 可読性バジェット(px/module 計画)
npm run demo:audio          # コア5 音響担体(FSK→WAV、見えない著作権コード)
npm run demo:fuzzy          # 柱4c Fuzzy Extractor(手相・虹彩から安定鍵)
npm run demo:subliminal     # 柱6-i 付帯ペイロード + 柱8 煙(改ざんで煙が立つ)
npm run demo:simmons        # 柱6-ii 真の Simmons 潜在チャネル(署名 nonce 埋込)
npm run demo:live           # 生きた担体(テロメア型フレーム鎖・リプレイ検知)
npm run demo:challenge      # 対話チャレンジ応答 liveness
npm test                    # 振る舞いテスト 241 本(node --test, 依存ゼロ。attestation v1・JCS・透明性ログ・独立実装一致を含む)
# examples/verify.html をブラウザで開く → 公開検証ページ(サーバ不要・公開鍵だけで真贋確認)
```

`examples/verify.html` は、発行者の公開鍵だけで**オフライン(サーバ非通信)**に真贋を確認できる静的ページ。
ブラウザの Web Crypto(Ed25519)で完結し、改ざん/別発行者は弾く。**開いた瞬間に実例(消去証明書を模した事実)を
自動検証して緑表示**し、**「⚠ 改ざんしてみる」ボタンで数値を1つ書き換える**と署名が一致せず即座に赤(検証失敗)になる
=改ざん検知を 30 秒で体感できるキラーデモ。秘密鍵は非掲載。headless 用に `?autotest=valid` / `?autotest=tamper`。

```js
import { seal, open, CordTamper } from './src/cord.js';

const cord = seal('CERTIFICATE-2026-0529', issuerSecret, 'context');
// cord.surface : 目玉文字の風景表示(人間向け)
// cord.eggs    : 卵の鎖(本体)
// cord.tip     : 鎖の先端ハッシュ

const text = open(cord, issuerSecret);   // 発行者秘密が無ければ CordTamper
```

---

## 計算非依存性の原則(技術的北極星)

> **昔からある鉄板技術 × 人間の曖昧さ → いかに高度な計算でも変えられない構造。**

- **鉄板技術**: 枯れて検証され尽くしたプリミティブのみ(新発明しない)。AES-GCM / HMAC / HKDF /
  ハッシュチェーンに加え、情報理論的安全の鉄板 = **One-Time Pad / Shamir 秘密分散 / Fuzzy Extractor / PUF**。
- **人間の曖昧さ**: 計算では取得・再現できない人間側のもの(物理割符・曖昧な記憶・知覚)を鍵源に置く。
- 目指すのは **計算量的安全(計算が困難)を超えた情報理論的安全(計算と無関係に不可能)**。
  突破のボトルネックを「計算力」ではなく「人間が物理的に持つ片割れ」に置く。

この原則の 2 つの実装:

**1. Shamir 秘密分散(`src/shard.js`)** — 片割れを情報理論的に分割。
```js
import { split, combine } from './src/shard.js';
const shares = split(Buffer.from(issuerSecret), 5, 3); // 5 片・閾値 3
combine([shares[1], shares[2], shares[4]]); // 3 片 → 秘密を復元 → open 可能
combine([shares[0], shares[1]]);            // 2 片 → ゴミ(情報理論的に復元不能)
```

**2. Fuzzy Extractor(`src/fuzzy.js`)** — 人間の曖昧さ(手相・虹彩)を鍵源に。
生体テンプレートは保存せず、誤り訂正で毎回「同じ鍵」を再生する。突破には
発行者の手・眼が物理的に必要(計算では取得不能)。`cord` = 手のひらで結ぶ紐、の原点。
```js
import { gen, rep } from './src/fuzzy.js';
const { key, helper } = gen(palmFeature, 'palm');  // 'palm'(手相) | 'iris'(虹彩)
rep(slightlyDifferentPalm, helper); // 曖昧でも同じ key(本人)
rep(otherPersonsPalm, helper);      // 別の key(他人は開けない)
```

## 設計原則(柱10)

> **割れたときに露出するのは「型」だけ。秘密(発行者鍵・核の現在状態)は割れても出ない。**

- AEAD タグ検証・ハッシュ鎖・順序(AAD の seq)で改ざんを多層検知する。
- 検証失敗時に投げる `CordTamper` は `seq`(どの卵で割れたか=型)のみを載せ、
  鍵・平文・ratchet 状態(核)は一切外に出さない。
- ratchet は一方向(HMAC)で、現在状態が漏れても過去の鍵は復元できない。

---

## 依存・要件

- Node.js >= 20(標準 `node:crypto` のみ。外部依存ゼロ)
- 実装言語: JavaScript (ESM)

## ライセンス

- コード: Apache License 2.0([`LICENSE`](LICENSE))
- 文書(構想白書 `docs/` 等): CC BY-SA 4.0

## セキュリティ

本実装は POC であり第三者監査を受けていない。既知の限界(自作 GF(256)/RS・BigInt modexp の
非定数時間性など)と報告窓口は [`SECURITY.md`](SECURITY.md) を参照。

## ステータス

Phase 0(設計文書化)完了 → **Phase 1(最小 POC)・本リポジトリ。10 柱すべてに実装が到達** →
Phase 2(物理層)は視覚担体が実印刷・実カメラの実測まで到達(冒頭「実測」)。

実装済み柱: 1, 2, 3, 4(+4b 真の閾値署名), 5, 6(6-i / 6-ii), 8, 9, 10 に加え、柱7 は
プロトコル層(視覚 + 音響の 2 担体)+ 実ピクセル / カメラ撮影復号まで実装・実測済。
継続課題: 音の不可聴化(心理音響マスキング)・実マイク同期・実機条件の体系スイープ。

採用面(application surface): `src/issue.js` の `issue()`(発行 → HC2 担体)/ `verify()`(発行者媒介検証 →
`{ok, verdict, payload, …}` の構造化結果)/ `relate()`(柱3 案件内関連付け: 同一案件を + 統合 / 別案件を − 差分)/
`attest()`・`verifyPublic()`(柱4 公開鍵層: 誰でも公開鍵でオフライン検証)。
`issue(..., { signingKey })` 指定で **発行者媒介(担体)+ 公開検証(attestation)を 1 回で**発行。
`splitIssuerSecret()` / `issueWithShares()`(柱4深化 閾値発行: 秘密を本社+拠点に分割、k 片以上でのみ発行=単一拠点の偽造防止)。
payload は opaque(用途固有スキーマは採用側が定義)。
Web Crypto との等価性は `test/webcrypto-compat.test.js` で実証済(サーバ側=Edge Function 等へ移植可能)。
