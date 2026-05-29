# human cord

**嘘では逃げられない情報インフラ** — A cryptographic infrastructure for documentary integrity in the AI era.

`cord ≠ code`. 人と人、人と真実を結ぶ「紐」としての暗号インフラ。

> 本リポジトリは Phase 1(最小 POC)です。設計の全体像・10 本の柱・哲学的背景は
> 構想白書 v0.2(別途)を参照してください。本 POC は 10 柱のうち 4 本を縦に貫いて
> 「動く最小版」を示すものです。

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
| **柱6 潜在チャネル** | 発行者だけが読める裏メッセージ(Simmons subliminal channel) | `src/subliminal.js` |
| **柱8 能動的発火応答** | 改ざん検知を append-only ハッシュチェーンログ(煙)に永久記録 | `src/smoke.js` |
| **柱10 失敗境界の自己観測抵抗** | 改ざん検知で露出するのは「型(seq)」のみ、核は不漏 | `src/cord.js` |

次イテレーション候補: 柱7(物理層信号)— 画像/センサー絡みのため Phase 2(物理層拡張)向き。

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
npm run demo    # ひと回しデモ(発行→検証→片割れ拒否→改ざん検知)
npm test        # 振る舞いテスト(node --test, 依存ゼロ)
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

`src/shard.js`(Shamir 秘密分散)はこの原則の最初の実装: 発行者の片割れを n 片に分割し、
閾値 k 片あれば復元できるが、**k 未満では計算能力が無限でも秘密について何も分からない**。

```js
import { split, combine } from './src/shard.js';
const shares = split(Buffer.from(issuerSecret), 5, 3); // 5 片・閾値 3
combine([shares[1], shares[2], shares[4]]); // 3 片 → 秘密を復元 → open 可能
combine([shares[0], shares[1]]);            // 2 片 → ゴミ(情報理論的に復元不能)
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

Phase 0(設計文書化)完了 → **Phase 1(最小 POC)着手・本リポジトリ。10 柱中 9 本実装済** → Phase 2(物理層)…

実装済み柱: 1, 2, 3, 4, 5, 6, 8, 9, 10(残り 柱7 物理層は Phase 2 で)。
