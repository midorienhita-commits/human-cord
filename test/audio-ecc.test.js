// audio-ecc.test.js
// 柱7 音響担体の ECC(Reed-Solomon)。波形が一部化けても能力内なら訂正して開ける。
// 視覚担体 HC2 と同型(src/ecc.js を共有)。実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/cord.js';
import { renderAudioEcc, extractAudio, receiveAudio, toWav, fromWav, FreshnessGuard, AudioFrameError } from '../src/audio.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const BODY = 'ECC 音響担体テスト: データ消去証明書 CASE-2026-0042 / 複数ブロックにまたがる本文';

function freshCord() {
  return seal(BODY, SECRET, 'cert', { axes: AXES });
}
// 指定範囲のサンプルを潰す(ゼロ化=雑音)。返り値は新しい Int16Array。
function zeroSpan(samples, start, count) {
  const out = Int16Array.from(samples);
  for (let i = start; i < start + count && i < out.length; i++) out[i] = 0;
  return out;
}

test('柱7 音響ECC: renderAudioEcc→extractAudio 往復(誤り無し)', () => {
  const cord = freshCord();
  const samples = renderAudioEcc(cord);
  assert.equal(extractAudio(samples).tip, cord.tip);
});

test('柱7 音響ECC: WAV 往復でも復元', () => {
  const cord = freshCord();
  const back = extractAudio(fromWav(toWav(renderAudioEcc(cord))));
  assert.equal(back.tip, cord.tip);
});

test('柱7 音響ECC: 波形が一部潰れても RS が訂正して開ける(能力内)', () => {
  const cord = freshCord();
  const samples = renderAudioEcc(cord);
  // 中盤の ~1000 サンプル(≈8 バイト)を潰す = 1 ブロック内 < 16 訂正能力
  const noisy = zeroSpan(samples, 50_000, 1000);
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  assert.equal(receiveAudio(noisy, SECRET, { guard, clock: AXES.epoch + 1000 }), BODY);
});

test('柱7 音響ECC: 1 ブロックに過大な連続破壊は訂正不能として安全に拒否', () => {
  const cord = freshCord();
  const samples = renderAudioEcc(cord);
  // ~3000 連続サンプル(≈23 バイト)を潰す = 1 ブロックの 16 訂正能力超過
  const broken = zeroSpan(samples, 40_000, 3000);
  assert.throws(() => extractAudio(broken), AudioFrameError);
});

test('柱7 音響ECC: 誤り訂正後も本体改ざんは AEAD で検知(媒体訂正 ≠ 本体改ざん)', () => {
  const cord = freshCord();
  cord.eggs[0].ct[0] ^= 0xff;
  const samples = renderAudioEcc(cord);
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  assert.throws(() => receiveAudio(samples, SECRET, { guard, clock: AXES.epoch + 1000 }),
    (e) => e.name === 'CordTamper');
});
