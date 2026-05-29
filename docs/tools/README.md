# docs/tools — 白書レンダリング(依存ゼロ)

インストール済みの **Chrome / Edge** を headless で使い、`mermaid` / `marked` は CDN から読む。
npm への依存追加なし(プロジェクトの計算非依存性・依存ゼロの方針に合わせる)。
**文書内容は外部送信されず**、ローカルの headless ブラウザで描画・組版するだけ(CDN からはライブラリのみ取得)。

## 必要なもの
- Chrome または Edge(既定パスに存在すれば自動検出)
- ネットワーク(初回の mermaid/marked ライブラリ取得のみ)

## コマンド
```bash
# Mermaid (.mmd) → SVG
node tools/mmd-to-svg.mjs figures/architecture.ja.mmd figures/architecture.ja.svg
node tools/mmd-to-svg.mjs figures/architecture.en.mmd figures/architecture.en.svg

# Markdown 白書 → PDF(本文 + 図を Chrome で印刷)
node tools/md-to-pdf.mjs whitepaper-v0.2.ja.md whitepaper-v0.2.ja.pdf
node tools/md-to-pdf.mjs whitepaper-v0.2.en.md whitepaper-v0.2.en.pdf

# 検証: 印刷直前 DOM に本文・表・描画済み図が入っているか
node tools/render-check.mjs whitepaper-v0.2.ja.md "概要" "干支型多軸鍵" "参考文献"
```

## 注意
- `render-check.mjs` は dump-dom 全体を検査するため、`<script>` に埋め込んだ md 文字列にも
  検査語がヒットする(印刷されない領域)。図の描画確認は `data-processed="true"` + `<svg>` で判断する。
- Chrome/Edge のパスが既定と異なる場合は各スクリプト冒頭の候補配列に追記する。
