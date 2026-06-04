// livecord.test.js
// 柱5/7/9「生きた担体(テロメア型フレーム鎖)」の振る舞い検証。
// 設計の種: docs/seed-bio-analogies.md §2
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitLive, LiveVerifier } from '../src/livecord.js';

const SECRET = 'issuer-private-half-xyz';
const T0 = 1_000_000_000_000;
const FM = 200;
const LEN = 6;
const MSG = '在席証明 CASE-2026';

function freshFrames(secret = SECRET, startEpoch = T0, length = LEN) {
  return emitLive(MSG, secret, 'live', { startEpoch, frameMs: FM, length });
}

test('柱5 live: emitLive は length 枚を出し、seq0 の prev は null(genesis)', () => {
  const frames = freshFrames();
  assert.equal(frames.length, LEN);
  assert.ok(frames.every((f) => typeof f.tip === 'string'));
  // seq0 の prev=null は封入平文の中(open で確認)。tip は全フレームで相異。
  assert.equal(new Set(frames.map((f) => f.tip)).size, LEN);
});

test('柱5 live: 正規ライブ列は全フレーム live で受理される', () => {
  const frames = freshFrames();
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  for (let i = 0; i < LEN; i++) {
    const r = v.feed(frames[i], T0 + i * FM + 20);
    assert.equal(r.verdict, 'live', `seq ${i}`);
    assert.equal(r.seq, i);
    assert.equal(r.msg, MSG);
  }
});

test('柱5 live: 録画の後日再生は鮮度失効で stale(epoch は freshen 不能)', () => {
  const frames = freshFrames();
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  assert.equal(v.feed(frames[0], T0 + 600_000).verdict, 'stale');
});

test('柱5 live: 別録画との接ぎ木は鎖断裂で spliced', () => {
  const a = freshFrames();
  const b = emitLive(MSG, SECRET, 'live', { startEpoch: T0 + 50, frameMs: FM, length: LEN });
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  assert.equal(v.feed(a[0], T0 + 20).verdict, 'live');
  assert.equal(v.feed(b[1], T0 + FM + 20).verdict, 'spliced');
});

test('柱5 live: 順序入れ替え(seq 飛ばし)は reorder', () => {
  const frames = freshFrames();
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  v.feed(frames[0], T0 + 20);
  assert.equal(v.feed(frames[2], T0 + 2 * FM + 20).verdict, 'reorder');
});

test('柱5 live: フレーム改ざんは AEAD で tamper', () => {
  const frames = freshFrames();
  const bad = JSON.parse(JSON.stringify(frames[0]));
  if (bad.eggs[0].ct && bad.eggs[0].ct.data) bad.eggs[0].ct.data[0] ^= 0xff;
  else if (typeof bad.eggs[0].ct === 'string') bad.eggs[0].ct = (bad.eggs[0].ct[0] === '0' ? 'f' : '0') + bad.eggs[0].ct.slice(1);
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  assert.equal(v.feed(bad, T0 + 20).verdict, 'tamper');
});

test('柱5 live: 別発行者(秘密違い)のフレームは tamper', () => {
  const frames = emitLive(MSG, 'other-issuer', 'live', { startEpoch: T0, frameMs: FM, length: LEN });
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  assert.equal(v.feed(frames[0], T0 + 20).verdict, 'tamper');
});

test('柱5 live: 同一フレームの再提示は replay', () => {
  const frames = freshFrames();
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  v.feed(frames[0], T0 + 20);
  assert.equal(v.feed(frames[0], T0 + 30).verdict, 'replay');
});

test('柱5 live: テロメア予算(length)を超えた到着は exhausted', () => {
  const longer = emitLive(MSG, SECRET, 'live', { startEpoch: T0, frameMs: FM, length: LEN + 1 });
  const v = new LiveVerifier(SECRET, { windowMs: 500, length: LEN });
  for (let i = 0; i < LEN; i++) assert.equal(v.feed(longer[i], T0 + i * FM + 20).verdict, 'live');
  assert.equal(v.feed(longer[LEN], T0 + LEN * FM + 20).verdict, 'exhausted');
});
