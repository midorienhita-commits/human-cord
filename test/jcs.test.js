// jcs.test.js — RFC 8785(JCS)準拠の検証。公式例(RFC 8785 §3.2.3)と辺境ケース。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../src/jcs.js';

test('RFC 8785 §3.2.3 の公式例と一致', () => {
  // 入力は RFC の JSON テキストをそのままパースしたもの(数値・文字列エスケープを含む)
  const text = '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], '
    + '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", '
    + '"literals": [null, true, false]}';
  const input = JSON.parse(text);
  const expected = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
    + '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(canonicalize(input), expected);
});

test('キー順は UTF-16 コード単位順(RFC 8785 §3.2.3 の並び例)', () => {
  // RFC の例: "€"(€) < "𐌀"(𐌀, サロゲート) < "＠"(＠) ではなく
  // コード単位比較なので \ud800 < ＠ < € の順にはならない。実際の順: "€"(0x20AC) < "\ud800…"(0xD800) < "＠"(0xFF20)
  const obj = { '＠': 1, '€': 2, '𐌀': 3, 'a': 4, 'A': 5, '': 6, '1': 7 };
  assert.equal(canonicalize(obj), '{"":6,"1":7,"A":5,"a":4,"€":2,"𐌀":3,"＠":1}');
});

test('undefined 値は省き、配列内の undefined は null(JSON.stringify と同じ)', () => {
  assert.equal(canonicalize({ a: undefined, b: [undefined, 1] }), '{"b":[null,1]}');
});

test('非有限数・BigInt は拒否', () => {
  assert.throws(() => canonicalize({ x: NaN }), TypeError);
  assert.throws(() => canonicalize({ x: Infinity }), TypeError);
  assert.throws(() => canonicalize({ x: 10n }), TypeError);
});

test('pubkey.js の旧 stableStringify と同一出力(後方互換の根拠)', () => {
  // 旧実装をそのまま再掲して突き合わせる(v0 attestation の検証は今後もこの規則に依存)
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    const keys = Object.keys(v).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  const samples = [
    { facts: { cert: 'CERT-1', devices: 12, nested: { z: [1, 2.5, 'x'], a: true } }, docId: 'J-1', issuedAt: null },
    { b: '日本語', a: '\u0000\u001f"\\/', c: [{}, []] },
    { n: [0, -0, 1e21, 1e-7, 123456789012345680000] },
  ];
  for (const s of samples) assert.equal(canonicalize(s), stableStringify(s));
});
