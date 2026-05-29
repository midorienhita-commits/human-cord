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
| **柱9 卵流アーキテクチャ** | AES-256-GCM(AEAD)+ ハッシュチェーン | `src/egg.js` |
| **柱5 生きた演算子** | HMAC ベースの一方向 ratchet(卵ごとに鍵が進む) | `src/ratchet.js` |
| **柱2 風景溶込み** | 目玉文字置換(表示用レイヤー、検証非依存) | `src/eyeglyph.js` |
| **柱4 発行者の片割れ** | 発行者秘密からの ratchet シード導出 | `src/cord.js` |
| **柱10 失敗境界の自己観測抵抗** | 改ざん検知で露出するのは「型(seq)」のみ、核は不漏 | `src/cord.js` |

次イテレーション候補: 柱1(干支型多軸鍵)/ 柱3(割符演算 `+/-`)/ 柱6(潜在チャネル)/
柱7(物理層信号)/ 柱8(発火応答)。

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

Phase 0(設計文書化)完了 → **Phase 1(最小 POC)着手・本リポジトリ** → Phase 2(物理層)…
