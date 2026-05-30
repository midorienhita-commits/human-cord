// issue.test.js
// 発行 / 発行者媒介検証(アプリ採用面)の振る舞い検証。
// payload は opaque(用途固有スキーマは採用側)。verify は throw せず構造化結果を返す。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issue, verify, FreshnessGuard, SmokeLog } from '../src/issue.js';

const SECRET = 'issuer-private-half-xyz';
const OTHER = 'someone-elses-secret';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
// 用途固有スキーマ(採用側=アプリが定義する例。human cord には持ち込まない)
const FACTS = { docId: 'CASE-2026-0042', kind: 4, devices: 12, method: 'Blancco', site: 'LOG' };

test('発行→検証: opaque payload が往復し、発行者控え(柱6)も読める', () => {
  const { carrier } = issue(FACTS, SECRET, { context: 'cert', docId: FACTS.docId, axes: AXES, mark: '正規:R3-0042' });
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const r = verify(carrier, SECRET, { guard, clock: AXES.epoch + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'fresh');
  assert.deepEqual(JSON.parse(r.payload), FACTS);
  assert.equal(r.mark, '正規:R3-0042'); // 発行者は控えを読める
  assert.equal(r.docId, 'CASE-2026-0042');
});

test('検証: 発行者でなければ tamper(秘密=片割れが無いと開けない・露出は型のみ)', () => {
  const { carrier } = issue(FACTS, SECRET, { context: 'cert', docId: FACTS.docId, axes: AXES });
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const r = verify(carrier, OTHER, { guard, clock: AXES.epoch + 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'tamper');
  assert.equal(typeof r.seq, 'number');
});

test('検証: 同じ担体の再提示は replay(煙を上げる)', () => {
  const { carrier } = issue('one-time', SECRET, { context: 'cert', axes: AXES });
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const clock = AXES.epoch + 1000;
  assert.equal(verify(carrier, SECRET, { guard, smokeLog: log, clock }).ok, true);
  const r2 = verify(carrier, SECRET, { guard, smokeLog: log, clock });
  assert.equal(r2.ok, false);
  assert.equal(r2.verdict, 'replay');
  assert.equal(log.entries.at(-1).type, 'replay-or-stale');
  assert.equal(log.verify(), true);
});

test('検証: 鮮度窓を超えた到着は stale(本体は開かない)', () => {
  const { carrier } = issue('stale', SECRET, { context: 'cert', axes: AXES });
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const r = verify(carrier, SECRET, { guard, clock: AXES.epoch + 300_000 });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'stale');
});

test('検証: 担体の破損は media-error(本体改ざんとは別ドメイン)', () => {
  const { carrier } = issue('payload', SECRET, { context: 'cert', axes: AXES });
  const parts = carrier.split('|');
  parts[1] = '999999'; // 長さフィールドを壊す
  const r = verify(parts.join('|'), SECRET, {});
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'media-error');
});

test('検証: 本体改ざんは tamper + 煙(媒体は正常)', () => {
  const { cord } = issue(FACTS, SECRET, { context: 'cert', docId: FACTS.docId, axes: AXES });
  cord.eggs[0].ct[0] ^= 0xff;
  const log = new SmokeLog();
  const r = verify(cord, SECRET, { smokeLog: log, clock: AXES.epoch + 1000 }); // cord を直接渡す経路
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'tamper');
  assert.equal(log.entries[0].type, 'tamper');
});
