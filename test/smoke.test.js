// smoke.test.js
// 柱8「能動的発火応答(煙)」の振る舞い検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/cord.js';
import { SmokeLog, guardedOpen } from '../src/smoke.js';

const SECRET = 'issuer-private-half-xyz';

test('柱8: 正常な open では煙は立たない', () => {
  const log = new SmokeLog();
  const cord = seal('clean document', SECRET);
  assert.equal(guardedOpen(cord, SECRET, log, 1000), 'clean document');
  assert.equal(log.entries.length, 0);
});

test('柱8: 改ざんを検知すると煙が立つ(ログに記録)', () => {
  const log = new SmokeLog();
  const cord = seal('tamper this please now', SECRET);
  cord.eggs[1].ct[0] ^= 0xff;
  assert.throws(() => guardedOpen(cord, SECRET, log, 1000));
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].type, 'tamper');
  assert.equal(typeof log.entries[0].detail.seq, 'number'); // 露出は型のみ
});

test('柱8: 煙は append-only ハッシュチェーンで連結される', () => {
  const log = new SmokeLog();
  log.raise('tamper', { seq: 0 }, 1000);
  log.raise('tamper', { seq: 3 }, 2000);
  assert.equal(log.entries[1].prevHash, log.entries[0].hash); // 連結
  assert.equal(log.verify(), true);
});

test('柱8 不可逆性: ログを遡及改ざんすると verify が落ちる', () => {
  const log = new SmokeLog();
  log.raise('tamper', { seq: 0 }, 1000);
  log.raise('tamper', { seq: 1 }, 2000);
  assert.equal(log.verify(), true);
  log.entries[0].detail.seq = 99; // 過去エントリを書き換え
  assert.equal(log.verify(), false); // 煙は消せない
});

test('柱8: 複数の改ざんが順に煙として積み上がる', () => {
  const log = new SmokeLog();
  for (const ctx of ['a', 'b', 'c']) {
    const cord = seal('x'.repeat(20), SECRET, ctx);
    cord.eggs[0].ct[0] ^= 0xff;
    try {
      guardedOpen(cord, SECRET, log, 1000);
    } catch {
      /* 煙が立つ */
    }
  }
  assert.equal(log.entries.length, 3);
  assert.equal(log.verify(), true);
});
