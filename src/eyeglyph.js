// eyeglyph.js
// ─────────────────────────────────────────────────────────────
// 柱2: 風景溶込み(目玉文字置換)
// ─────────────────────────────────────────────────────────────
// 目玉文字(特定の文字)だけを置換し、それ以外は素通し(風景)。
// これは「表のレイヤー」= 人間が見ても普通の文字列に見える表示用。
// 本体のセキュリティは卵(柱9 AEAD)が担うため、surface は検証・復号には
// 使わない。将来 柱6(潜在チャネル)を目玉文字位置に埋め込む土台となる。
//
// 設計メモ:
//   POC では leetspeak 風の固定マップ。Phase 2 以降で「目玉文字位置を
//   発行者鍵で選択」「目玉のノイズに subliminal payload を載せる」へ拡張。

const EYE = { a: '4', e: '3', o: '0', i: '1', s: '5', t: '7', b: '8', g: '9' };

/**
 * 平文を「風景」表示に変換する(目玉文字だけ置換、他は素通し)。
 * @param {string} text
 * @returns {string}
 */
export function toLandscape(text) {
  return [...text].map((ch) => EYE[ch.toLowerCase()] ?? ch).join('');
}

/** 目玉文字の位置(インデックス配列)を返す。柱6 のキャリア候補位置。 */
export function eyePositions(text) {
  const pos = [];
  [...text].forEach((ch, i) => {
    if (EYE[ch.toLowerCase()] !== undefined) pos.push(i);
  });
  return pos;
}

export { EYE };
