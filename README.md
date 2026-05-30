# human cord

**嘘では逃げられない情報インフラ** — A cryptographic infrastructure for documentary integrity in the AI era.

`cord ≠ code`. 人と人、人と真実を結ぶ「紐」としての暗号インフラ。

> 本リポジトリは Phase 1(最小 POC)です。設計の全体像・10 本の柱・哲学的背景は
> 構想白書 v0.2(`docs/whitepaper-v0.2.ja.md` / 英語版 `.en.md`、PDF 同梱)を参照してください。
> 本 POC は 10 柱すべてに実装を到達させた「動く最小版」です。

---

## Phase 1 POC のスコープ

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
| **柱6 潜在チャネル** | 発行者だけが読める裏メッセージ(Simmons subliminal channel) | `src/subliminal.js` |
| **柱8 能動的発火応答** | 改ざん検知を append-only ハッシュチェーンログ(煙)に永久記録 | `src/smoke.js` |
| **柱7 物理層出力(視覚チャネル)** | 媒体非依存フレーム codec(HC1 検知 / HC2 = Reed-Solomon 誤り訂正)+ リプレイ防止(nonce 一回性 + 鮮度窓 + 煙)。実ピクセル/QR/AI 抽出は Phase 2+ アダプタ | `src/visual.js` |
| **柱7 物理層: 誤り訂正(ECC)** | Reed-Solomon over GF(256)(QR と同じ field, 依存ゼロ)。担体ノイズ・バースト・部分欠損を訂正。fuzz テスト済 | `src/ecc.js` |
| **柱7 物理層出力(音響担体)** | FSK 音響 codec(+ WAV、RS 訂正フレーム)+ リプレイ防止(視覚と共通)。「見えない著作権コード」= 鍵付き署名を音に乗せる。不可聴化/実マイク同期は Phase 2+ | `src/audio.js` |
| **柱10 失敗境界の自己観測抵抗** | 改ざん検知で露出するのは「型(seq)」のみ、核は不漏 | `src/cord.js` |

柱7 はプロトコル層(担体 codec + リプレイ防止)を Phase 2 最小縦切りとして実装済で、
**視覚(`src/visual.js`)と音響(`src/audio.js`)の 2 担体**に枝分かれする。リプレイ防止
(FreshnessGuard / 忠実復元)は `src/freshness.js` に共通化し両担体で共有。
誤り訂正は `src/ecc.js`(Reed-Solomon / 依存ゼロ)で実装し、視覚(HC2)・音響(RS フレーム)の両担体に統合済。
残る物理アダプタ(実ピクセル/QR/カメラ/AI 抽出、音の不可聴化=心理音響マスキング・実マイク同期)は依存を増やすため別腹で継続。
設計は `docs/phase2-pillar7-visual-channel.md` / `docs/phase2-pillar7-audio-channel.md` を参照。

### 柱6 潜在チャネル / 柱8 発火応答

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

- 柱6 は夢4(目玉の見えないノイズ)/ 白書 §4.1。表チャネル(open)に影響しない独立の第二チャネル。
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
npm run demo:e2e        # ★統合デモ: 証明書ライフサイクルで 10 柱+2担体が噛み合う通し
npm run demo            # ひと回しデモ(発行→検証→片割れ拒否→改ざん検知)
npm run demo:tally      # 柱3 割符演算(+ 統合 / − 差分発火)
npm run demo:shard      # 柱4 Shamir 秘密分散(閾値未満は復元不能)
npm run demo:fuzzy      # 柱4/7 Fuzzy Extractor(手相・虹彩から安定鍵)
npm run demo:subliminal # 柱6 潜在チャネル + 柱8 煙(改ざんで煙が立つ)
npm run demo:visual     # 柱7 視覚チャネル(担体 codec + リプレイ防止 + 煙)
npm run demo:audio      # 柱7 音響担体(FSK→WAV、見えない著作権コード)
npm run demo:ecc        # 柱7 物理層の頑健化(Reed-Solomon で担体ノイズを訂正)
npm run demo:issue      # 採用面: 発行 / 発行者媒介検証(verify は構造化結果を返す)
npm test                # 振る舞いテスト 104 本(node --test, 依存ゼロ)
```

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

- コード: Apache License 2.0
- (構想白書等の文書: CC BY-SA 4.0)

## ステータス

Phase 0(設計文書化)完了 → **Phase 1(最小 POC)着手・本リポジトリ。10 柱すべてに実装が到達** → Phase 2(物理アダプタ)…

実装済み柱: 1, 2, 3, 4, 5, 6, 8, 9, 10 に加え、柱7 はプロトコル層を Phase 2 最小縦切りで実装
(視覚 + 音響の 2 担体)。柱7 の物理アダプタ(実ピクセル/QR/ECC/AI 抽出・音の不可聴化)は継続課題。

採用面(application surface): `src/issue.js` の `issue()`(発行 → HC2 担体)/ `verify()`(発行者媒介検証 →
`{ok, verdict, payload, …}` の構造化結果)。payload は opaque(用途固有スキーマは採用側が定義)。
Web Crypto との等価性は `test/webcrypto-compat.test.js` で実証済(サーバ側=Edge Function 等へ移植可能)。
