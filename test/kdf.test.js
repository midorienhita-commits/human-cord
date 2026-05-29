// kdf.test.js
// 柱1「干支型多軸鍵生成」の振る舞い検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeAxes, deriveCodebook } from '../src/kdf.js';
import { seal, open } from '../src/cord.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1716960000000, weekday: 3, hour: 9, parity: 0 };

test('柱1: deriveCodebook は決定的(同じ入力→同じ 32B 鍵)', () => {
  const k1 = deriveCodebook(SECRET, 'ctx', AXES);
  const k2 = deriveCodebook(SECRET, 'ctx', AXES);
  assert.equal(k1.toString('hex'), k2.toString('hex'));
  assert.equal(k1.length, 32);
});

test('柱1: 発行者秘密(私的軸)が違えばコードブックが変わる', () => {
  const a = deriveCodebook(SECRET, 'ctx', AXES).toString('hex');
  const b = deriveCodebook('other-secret', 'ctx', AXES).toString('hex');
  assert.notEqual(a, b);
});

test('柱1: 時間多軸(公開軸)が違えばコードブックが変わる', () => {
  const a = deriveCodebook(SECRET, 'ctx', AXES).toString('hex');
  const b = deriveCodebook(SECRET, 'ctx', { ...AXES, hour: 10 }).toString('hex');
  assert.notEqual(a, b);
});

test('柱1: context が違えばコードブックが変わる', () => {
  const a = deriveCodebook(SECRET, 'ctx-a', AXES).toString('hex');
  const b = deriveCodebook(SECRET, 'ctx-b', AXES).toString('hex');
  assert.notEqual(a, b);
});

test('柱1: timeAxes は必要な軸を含む', () => {
  const ax = timeAxes(new Date(AXES.epoch));
  assert.equal(typeof ax.epoch, 'number');
  assert.ok(ax.weekday >= 0 && ax.weekday <= 6);
  assert.ok(ax.hour >= 0 && ax.hour <= 23);
  assert.ok(ax.parity === 0 || ax.parity === 1);
});

test('柱1: 時間多軸(kdf)は cord に公開保存される(時計は公開)', () => {
  const cord = seal('hello', SECRET, 'ctx', { axes: AXES });
  assert.deepEqual(cord.kdf, AXES); // 平文で時計が見える
});

test('柱1: 固定 axes なら seal→open が再現的に成功する', () => {
  const cord = seal('certificate body', SECRET, 'ctx', { axes: AXES });
  assert.equal(open(cord, SECRET), 'certificate body');
});

test('柱1: 時間軸が違えば通行手形(tally)も変わる', () => {
  const a = seal('x', SECRET, 'ctx', { docId: 'D', axes: AXES });
  const b = seal('x', SECRET, 'ctx', { docId: 'D', axes: { ...AXES, weekday: 4 } });
  assert.notEqual(a.tally, b.tally); // コードブックが変われば tally も変わる
});
