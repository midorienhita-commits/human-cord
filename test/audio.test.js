// audio.test.js
// 柱7「物理層出力(音響・ノイズ担体)」の振る舞い検証。
// 設計メモ: docs/phase2-pillar7-audio-channel.md
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, CordTamper } from '../src/cord.js';
import { SmokeLog } from '../src/smoke.js';
import {
  renderAudio, extractAudio, receiveAudio, toWav, fromWav,
  FreshnessGuard, AudioFrameError,
} from '../src/audio.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };

function freshCord(text, ctx = 'audio') {
  return seal(text, SECRET, ctx, { axes: AXES });
}

// ① 音響 codec ─────────────────────────────────────────────────

test('柱7 音響: renderAudio→extractAudio→open で平文が往復する', () => {
  const cord = freshCord('AUDIO-CERT-2026-0529 音響チャネル往復');
  const samples = renderAudio(cord);
  assert.ok(samples.length > 0);
  assert.equal(extractAudio(samples).tip, cord.tip);

  const guard = new FreshnessGuard();
  assert.equal(receiveAudio(samples, SECRET, { guard, clock: AXES.epoch + 1000 }),
    'AUDIO-CERT-2026-0529 音響チャネル往復');
});

test('柱7 音響: WAV(PCM16)に書き出して読み戻しても復元できる', () => {
  const cord = freshCord('WAV roundtrip payload');
  const wav = toWav(renderAudio(cord));
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  const back = extractAudio(fromWav(wav));
  assert.equal(back.tip, cord.tip);
});

test('柱7 音響: 波形の一部が潰れると checksum で破損検知(AudioFrameError)', () => {
  const samples = renderAudio(freshCord('acoustic noise robustness test payload'));
  for (let i = 5000; i < 5400 && i < samples.length; i++) samples[i] = 0; // 中間を雑音で潰す
  assert.throws(() => extractAudio(samples), AudioFrameError);
});

test('柱7 音響: 途中で切れた録音(truncation)を弾く', () => {
  const samples = renderAudio(freshCord('truncated recording should fail'));
  const cut = samples.slice(0, Math.floor(samples.length / 2));
  assert.throws(() => extractAudio(cut), AudioFrameError);
});

// ② リプレイ防止(プロトコル側・視覚チャネルと共通)──────────────

test('柱7 音響リプレイ: 同じ波形の再生は replay として煙を上げて拒否', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const samples = renderAudio(freshCord('one-time audio token'));
  const clock = AXES.epoch + 1_000;

  assert.equal(receiveAudio(samples, SECRET, { guard, smokeLog: log, clock }), 'one-time audio token');
  assert.equal(log.entries.length, 0);

  assert.throws(() => receiveAudio(samples, SECRET, { guard, smokeLog: log, clock }), AudioFrameError);
  assert.equal(log.entries[0].type, 'replay-or-stale');
  assert.equal(log.entries[0].detail.verdict, 'replay');
  assert.equal(log.verify(), true);
});

test('柱7 音響鮮度切れ: 窓外の到着は煙を上げて拒否(本体は開かない)', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const samples = renderAudio(freshCord('stale on arrival'));
  assert.throws(() => receiveAudio(samples, SECRET, { guard, smokeLog: log, clock: AXES.epoch + 300_000 }),
    AudioFrameError);
  assert.equal(log.entries[0].detail.verdict, 'stale');
});

// 2 つのエラードメインの分離(メモ §2) ───────────────────────────

test('柱7 音響ドメイン分離: 本体改ざんは媒体エラーでなく CordTamper(柱8 で煙=tamper)', () => {
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const cord = freshCord('integrity protected audio body');
  cord.eggs[0].ct[0] ^= 0xff;          // 卵を改ざんしてから担体化
  const samples = renderAudio(cord);    // checksum は改ざん後 payload に整合
  // → extract(媒体層)は通る。割れるのは本体 AEAD = guardedOpen。
  assert.throws(() => receiveAudio(samples, SECRET, { guard, smokeLog: log, clock: AXES.epoch + 1000 }),
    CordTamper);
  assert.equal(log.entries[0].type, 'tamper');
});
