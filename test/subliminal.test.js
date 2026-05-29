// subliminal.test.js
// 柱6「潜在チャネル(subliminal channel)」の振る舞い検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open } from '../src/cord.js';
import { embedSubliminal, readSubliminal } from '../src/subliminal.js';

const SECRET = 'issuer-private-half-xyz';
const OTHER = 'not-the-issuer';
const AXES = { epoch: 1716960000000, weekday: 3, hour: 9, parity: 0 };

test('柱6: 発行者は裏メッセージを読み出せる', () => {
  const cord = embedSubliminal(seal('表の証明書', SECRET, 'ctx', { axes: AXES }), SECRET, '発行者控え:R-0042');
  assert.equal(readSubliminal(cord, SECRET), '発行者控え:R-0042');
});

test('柱6: 発行者でなければ裏は読めない(null = ノイズ)', () => {
  const cord = embedSubliminal(seal('表の証明書', SECRET, 'ctx', { axes: AXES }), SECRET, 'secret note');
  assert.equal(readSubliminal(cord, OTHER), null);
});

test('柱6: 裏チャネルは表チャネル(open)に影響しない', () => {
  const base = seal('CERTIFICATE-BODY-2026', SECRET, 'ctx', { axes: AXES });
  const cord = embedSubliminal(base, SECRET, 'hidden issuer mark');
  assert.equal(open(cord, SECRET), 'CERTIFICATE-BODY-2026'); // 表は普通に開ける
});

test('柱6: subliminal を持たない cord は readSubliminal が null', () => {
  const cord = seal('no subliminal here', SECRET, 'ctx', { axes: AXES });
  assert.equal(readSubliminal(cord, SECRET), null);
});

test('柱6: マルチバイト裏メッセージも往復できる', () => {
  const cord = embedSubliminal(seal('x', SECRET, 'ctx', { axes: AXES }), SECRET, '裏の伝言です😀');
  assert.equal(readSubliminal(cord, SECRET), '裏の伝言です😀');
});

test('柱6: 同じ表でも裏メッセージが違えば subliminal データが変わる', () => {
  const base = seal('same surface', SECRET, 'ctx', { axes: AXES });
  const a = embedSubliminal(base, SECRET, 'mark-A');
  const b = embedSubliminal(base, SECRET, 'mark-B');
  assert.notEqual(a.subliminal.data, b.subliminal.data);
});
