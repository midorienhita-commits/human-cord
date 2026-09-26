// jcs.js
// ─────────────────────────────────────────────────────────────
// JSON Canonicalization Scheme(RFC 8785)— 署名対象の決定的バイト列
// ─────────────────────────────────────────────────────────────
// human cord の公開検証層は、これまで pubkey.js 内の stableStringify(キー再帰ソート +
// JSON.stringify)で正準化してきた。その規則は RFC 8785 と一致する:
//   - オブジェクトのキーは UTF-16 コード単位の昇順(Array.prototype.sort の既定比較と同一)
//   - 文字列・数値・リテラルの直列化は ECMAScript JSON.stringify と同一(RFC 8785 §3.2.2)
//   - 空白なし
// 本モジュールはその事実を「宣言」し、RFC 8785 §3.2.3 の公式例で検証する(test/jcs.test.js)。
// 他言語の JCS 実装(Python jcs / Go / Java 等)と同一バイト列になるため、
// human cord の attestation は human cord のコードを使わずに検証できる。
//
// 制約(RFC 8785 と同じ): NaN / ±Infinity / undefined / BigInt / 関数は表現できず TypeError。

/**
 * RFC 8785 正準 JSON 文字列を返す。
 * @param {*} v  JSON 値(オブジェクト・配列・文字列・有限数・真偽・null)
 * @returns {string}
 */
export function canonicalize(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return JSON.stringify(v);
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('JCS: non-finite number');
    return JSON.stringify(v); // ES Number::toString == RFC 8785 §3.2.2.3
  }
  if (t !== 'object') throw new TypeError('JCS: unsupported type ' + t);
  if (Array.isArray(v)) {
    return '[' + v.map((x) => canonicalize(x === undefined ? null : x)).join(',') + ']';
  }
  // キーは UTF-16 コード単位順(RFC 8785 §3.2.3)。undefined 値のプロパティは JSON と同様に省く。
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

/** 正準 JSON の UTF-8 バイト列(署名・ハッシュの入力)。 */
export function canonicalBytes(v) {
  return Buffer.from(canonicalize(v), 'utf8');
}
