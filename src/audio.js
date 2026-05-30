// audio.js
// ─────────────────────────────────────────────────────────────
// 柱7: 物理層出力(音響・ノイズ担体)— Phase 2 最小縦切り
// ─────────────────────────────────────────────────────────────
// 設計メモ: docs/phase2-pillar7-audio-channel.md
//
// 原則(視覚チャネルと同一):
//   信号処理/AI は「耳」… 雑音・再録音・圧縮への頑健性(本モジュール外の将来アダプタ)
//   cord は「約束」      … 真正性・改ざん検知・新鮮性(ここで守る)
//
// 本モジュールが実装するのは、媒体非依存の 2 層:
//   ① 音響 codec   … cord ⇄ FSK 変調した PCM 波形(renderAudio / extractAudio)+ WAV 入出力
//   ② リプレイ防止 … 視覚チャネルの FreshnessGuard / SmokeLog をそのまま流用
//
// 明示的に「やらない」(メモ §6 / 将来アダプタ):
//   - 不可聴化(心理音響マスキング)。本 POC は「可聴だが素直な」FSK 音。
//   - 誤り「訂正」(ECC)。ここでは検知のみ(checksum)。
//   - 実マイク録音の同期復元(タイミング/前置同期)。本 POC は試料整列前提の往復。
//
// 最重要(メモ §2): 音をコピーすれば透かしごとコピーされる。
//   リプレイ防止はチャネルでなくプロトコル(nonce 一回性 + 鮮度窓 + 煙)で行う。

import { createHash } from 'node:crypto';
import { open } from './cord.js';
import { guardedOpen } from './smoke.js';
// 視覚チャネルと共有する基盤(freshness.js に括り出し済 — メモ §7)
import { FreshnessGuard, reviveBuffers } from './freshness.js';
export { FreshnessGuard } from './freshness.js';

// ── 変調パラメータ(f0/f1 は fs/N の整数倍 = 直交)───────────────
const SAMPLE_RATE = 16000;
const SYMBOL_SAMPLES = 16;     // 1 ビット = 16 サンプル → 1000 baud
const FREQ0 = 2000;            // bit 0 (k=2)
const FREQ1 = 4000;            // bit 1 (k=4)
const AMP = 0x3fff;            // 16bit PCM の約半分
const PREAMBLE = 0xac;         // フレーム先頭マーカー
const CKSUM_LEN = 4;           // sha256 先頭 4 バイト

/** 音響担体の読み取り破損(同期ずれ・雑音・改ざんで枠が壊れた)を表す例外。 */
export class AudioFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AudioFrameError';
  }
}

function checksum(buf) {
  return createHash('sha256').update(buf).digest().subarray(0, CKSUM_LEN);
}

// ── フレーム: [preamble(1)][len(4 BE)][payload][cksum(4)] ───────
function frame(payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([Buffer.from([PREAMBLE]), len, payload, checksum(payload)]);
}
function deframe(bytes) {
  if (bytes.length < 1 + 4 + CKSUM_LEN) throw new AudioFrameError('frame too short');
  if (bytes[0] !== PREAMBLE) throw new AudioFrameError('preamble not found (sync lost)');
  const len = bytes.readUInt32BE(1);
  const end = 5 + len;
  if (end + CKSUM_LEN > bytes.length) throw new AudioFrameError('length exceeds signal (truncated/garbled)');
  const payload = bytes.subarray(5, end);
  const cksum = bytes.subarray(end, end + CKSUM_LEN);
  if (!checksum(payload).equals(cksum)) throw new AudioFrameError('checksum mismatch (noise / tamper)');
  return Buffer.from(payload);
}

// ── ビット列 ⇄ バイト列(MSB first)─────────────────────────────
function bytesToBits(buf) {
  const bits = new Uint8Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (buf[i] >> (7 - b)) & 1;
  }
  return bits;
}
function bitsToBytes(bits) {
  const out = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    out[i] = v;
  }
  return out;
}

// ── FSK 変調 / 復調(Goertzel)──────────────────────────────────
function modulate(bytes) {
  const bits = bytesToBits(bytes);
  const samples = new Int16Array(bits.length * SYMBOL_SAMPLES);
  for (let i = 0; i < bits.length; i++) {
    const f = bits[i] ? FREQ1 : FREQ0;
    for (let n = 0; n < SYMBOL_SAMPLES; n++) {
      samples[i * SYMBOL_SAMPLES + n] = Math.round(AMP * Math.sin((2 * Math.PI * f * n) / SAMPLE_RATE));
    }
  }
  return samples;
}

function goertzelPower(samples, start, freq) {
  const k = Math.round((SYMBOL_SAMPLES * freq) / SAMPLE_RATE);
  const w = (2 * Math.PI * k) / SYMBOL_SAMPLES;
  const coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let n = 0; n < SYMBOL_SAMPLES; n++) {
    s0 = samples[start + n] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function demodulate(samples) {
  const nBits = Math.floor(samples.length / SYMBOL_SAMPLES);
  const bits = new Uint8Array(nBits);
  for (let i = 0; i < nBits; i++) {
    const start = i * SYMBOL_SAMPLES;
    bits[i] = goertzelPower(samples, start, FREQ1) > goertzelPower(samples, start, FREQ0) ? 1 : 0;
  }
  return bitsToBytes(bits);
}

// ── WAV(16bit PCM mono)入出力 ────────────────────────────────
/** Int16 サンプル列を WAV(RIFF/PCM16/mono)Buffer にする。 */
export function toWav(samples, sampleRate = SAMPLE_RATE) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}
/** WAV Buffer から Int16 サンプル列を取り出す(最小パーサ)。 */
export function fromWav(buf) {
  const dataOffset = 44;
  const dataLen = buf.readUInt32LE(40);
  const samples = new Int16Array(dataLen / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(dataOffset + i * 2);
  return samples;
}

/**
 * ① renderAudio: cord → 音響担体(FSK 変調した Int16 サンプル列)。
 *   将来この波形をスピーカ/楽曲・環境音に溶込ませる(不可聴化は後段アダプタ)。
 * @returns {Int16Array}
 */
export function renderAudio(cord) {
  const payload = Buffer.from(JSON.stringify(cord), 'utf8');
  return modulate(frame(payload));
}

/**
 * ① extractAudio: 音響担体 → cord。復調 → 枠/長さ/チェックサム検証 → バイト忠実復元。
 *   破損していれば AudioFrameError(復号より手前で弾く=媒体エラーと改ざんを分離)。
 * @param {Int16Array} samples
 * @returns {object} cord
 */
export function extractAudio(samples) {
  const bytes = demodulate(samples);
  const payload = deframe(bytes); // 媒体層: 破損は AudioFrameError
  let cord;
  try {
    cord = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new AudioFrameError('payload is not valid cord JSON');
  }
  return reviveBuffers(cord);
}

/**
 * ②+①+柱8/9/10 を束ねた受信口。音響担体を受け取り、検証済み平文を返す。
 *   視覚チャネルの receiveVisual と同型(担体が波形に替わるだけ)。
 * @param {Int16Array} samples
 * @param {string} issuerSecret
 * @param {{guard:FreshnessGuard, smokeLog:object, clock?:number}} ctx
 * @returns {string} 検証済み平文
 */
export function receiveAudio(samples, issuerSecret, { guard, smokeLog, clock } = {}) {
  const cord = extractAudio(samples);

  const { verdict, reason } = guard.check(cord, clock);
  if (verdict !== 'fresh') {
    if (smokeLog) {
      smokeLog.raise('replay-or-stale', { context: cord.context, verdict, reason, tip: cord.tip }, clock);
    }
    throw new AudioFrameError(`rejected: ${verdict} (${reason})`);
  }

  const text = smokeLog ? guardedOpen(cord, issuerSecret, smokeLog, clock) : open(cord, issuerSecret);
  guard.accept(cord);
  return text;
}
