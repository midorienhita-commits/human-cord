// visual.test.js
// 柱7「物理層出力(視覚チャネル)」の振る舞い検証。
// 設計メモ: docs/phase2-pillar7-visual-channel.md
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, CordTamper } from '../src/cord.js';
import { SmokeLog } from '../src/smoke.js';
import { render, extract, FreshnessGuard, receiveVisual, VisualFrameError } from '../src/visual.js';

const SECRET = 'issuer-private-half-xyz';
// 固定の公開軸(epoch を握って鮮度窓をテストで制御する)
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };

function freshCord(text, ctx = 'visual') {
  return seal(text, SECRET, ctx, { axes: AXES });
}

// ① フレーム codec ─────────────────────────────────────────────

test('柱7 codec: render→extract→open で平文が往復する', () => {
  const cord = freshCord('CERTIFICATE-2026-0529 視覚チャネル往復');
  const frame = render(cord);
  assert.equal(typeof frame, 'string');
  assert.ok(frame.startsWith('HC1|'));

  const back = extract(frame);
  const guard = new FreshnessGuard();
  assert.equal(receiveVisual(frame, SECRET, { guard, clock: AXES.epoch + 1000 }),
    'CERTIFICATE-2026-0529 視覚チャネル往復');
  assert.equal(back.tip, cord.tip);
});

test('柱7 codec: 1 文字でも化けると checksum で破損検知(VisualFrameError)', () => {
  const frame = render(freshCord('optical noise test payload'));
  // payload 部(4 フィールド目)の 1 文字を差し替える
  const parts = frame.split('|');
  const ch = parts[3][5] === 'A' ? 'B' : 'A';
  parts[3] = parts[3].slice(0, 5) + ch + parts[3].slice(6);
  assert.throws(() => extract(parts.join('|')), VisualFrameError);
});

test('柱7 codec: 途中で切れた読み取り(truncation)は長さ不一致で弾く', () => {
  const frame = render(freshCord('truncated read should fail length check'));
  const cut = frame.slice(0, frame.length - 4);
  assert.throws(() => extract(cut), VisualFrameError);
});

test('柱7 codec: 未知マジック / 壊れた枠を拒否する', () => {
  assert.throws(() => extract('ZZ9|10|deadbeef|xxxx'), VisualFrameError);
  assert.throws(() => extract('not a frame at all'), VisualFrameError);
  assert.throws(() => extract(12345), VisualFrameError);
});

// ② リプレイ防止(プロトコル側)─────────────────────────────────

test('柱7 freshness: 鮮度窓内・未受理なら fresh', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const cord = freshCord('hello');
  assert.equal(guard.check(cord, AXES.epoch + 5_000).verdict, 'fresh');
});

test('柱7 freshness: 窓を超えたら stale', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const cord = freshCord('hello');
  assert.equal(guard.check(cord, AXES.epoch + 120_000).verdict, 'stale');
});

test('柱7 リプレイ: 同じフレームの再提示は replay として煙を上げて拒否', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const frame = render(freshCord('one-time document'));
  const clock = AXES.epoch + 1_000;

  // 1 回目: 受理される
  assert.equal(receiveVisual(frame, SECRET, { guard, smokeLog: log, clock }), 'one-time document');
  assert.equal(log.entries.length, 0);

  // 2 回目: 同じ tip → リプレイ。煙が立ち、拒否される。
  assert.throws(() => receiveVisual(frame, SECRET, { guard, smokeLog: log, clock }), VisualFrameError);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].type, 'replay-or-stale');
  assert.equal(log.entries[0].detail.verdict, 'replay');
  assert.equal(log.verify(), true); // 煙は消せない
});

test('柱7 鮮度切れ受信: 窓外フレームは煙を上げて拒否(本体は開かない)', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const frame = render(freshCord('stale on arrival'));
  assert.throws(() => receiveVisual(frame, SECRET, { guard, smokeLog: log, clock: AXES.epoch + 300_000 }),
    VisualFrameError);
  assert.equal(log.entries[0].detail.verdict, 'stale');
});

// 2 つのエラードメインの分離(メモ §2) ───────────────────────────

test('柱7 ドメイン分離: 本体改ざんは媒体エラーでなく CordTamper(柱8 で煙=tamper)', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const cord = freshCord('integrity protected body text here');
  cord.eggs[0].ct[0] ^= 0xff;       // 卵の中身を改ざんしてから担体化
  const frame = render(cord);        // checksum は改ざん後の payload に対して整合
  // → extract(媒体層)は通る。割れるのは本体の AEAD = guardedOpen。
  assert.throws(() => receiveVisual(frame, SECRET, { guard, smokeLog: log, clock: AXES.epoch + 1000 }),
    CordTamper);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].type, 'tamper'); // 媒体ノイズ(replay-or-stale)とは別の型
});
