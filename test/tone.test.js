import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/tone.js';

const payload = T.framePayload(7, '483015');

test('payload の往復とチェックサム', () => {
  assert.equal(payload.length, 13); assert.ok(payload.startsWith('*') && payload.endsWith('#'));
  const p = T.parsePayload(payload.split(''));
  assert.equal(p.member, 7); assert.equal(p.code, '483015'); assert.equal(p.version, 1);
  const bad = payload.slice(0, 5) + (payload[5] === '9' ? '0' : '9') + payload.slice(6);
  assert.equal(T.parsePayload(bad.split('')).error, 'checksum');
  assert.equal(T.parsePayload('12345'.split('')), null);
});

test('清浄な信号: 48k / 44.1k / 16k(電話帯)で復号', () => {
  for (const sr of [48000, 44100, 16000, 8000]) {
    const pcm = T.synthesize(payload.split(''), sr);
    const r = T.decodeAll(pcm, sr);
    assert.equal(r.payload && r.payload.code, '483015', `sr=${sr} symbols=${r.symbols.join('')}`);
  }
});

function noisy(pcm, snrDb, seed = 1) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 - 0.5; };
  let sig = 0; for (const x of pcm) sig += x * x; sig /= pcm.length;
  const noiseRms = Math.sqrt(sig / 10 ** (snrDb / 10));
  return pcm.map((x) => x + rnd() * noiseRms * Math.sqrt(12));
}

test('雑音・音量変化・DC・連続する同じ数字に耐える', () => {
  const sr = 48000;
  const pcm = T.synthesize(payload.split(''), sr);
  for (const snr of [20, 10, 6]) {
    const r = T.decodeAll(noisy(pcm, snr), sr);
    assert.equal(r.payload && r.payload.code, '483015', `snr=${snr}dB symbols=${r.symbols.join('')}`);
  }
  const quiet = pcm.map((x) => x * 0.08);
  assert.equal(T.decodeAll(quiet, sr).payload.code, '483015', '小音量');
  const dc = pcm.map((x) => x * 0.6 + 0.2);
  assert.equal(T.decodeAll(dc, sr).payload.code, '483015', 'DC オフセット');
  const rep = T.framePayload(11, '111111');
  assert.equal(T.decodeAll(T.synthesize(rep.split(''), sr), sr).payload.code, '111111', '同じ数字の連続');
});

test('ストリーミング: 小さなチャンクで流しても同じ結果、無関係な音では何も出ない', () => {
  const sr = 48000; const pcm = noisy(T.synthesize(payload.split(''), sr), 12);
  const d = new T.ToneDecoder(sr); let got = null;
  for (let i = 0; i < pcm.length; i += 128) { d.feed(pcm.subarray(i, i + 128)); const p = d.take(); if (p && !p.error) got = p; }
  assert.equal(got && got.code, '483015');
  const speech = new Float32Array(sr * 2).map((_, i) => 0.3 * Math.sin(2 * Math.PI * 220 * i / sr) * Math.sin(2 * Math.PI * 3 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 1000 * i / sr));
  assert.equal(T.decodeAll(speech, sr).payload, null);
});

test('WAV 出力のヘッダ', () => {
  const w = T.toWav(new Float32Array(100), 8000);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF'); assert.equal(w.length, 44 + 200);
});

test('汎用: 任意桁の数字列をフレーム化して往復', () => {
  const f = T.frameDigits('20260926'); assert.equal(T.parseDigits(f.split('')).digits, '20260926');
  const pcm = T.synthesize(f.split(''), 16000); assert.equal(T.parseDigits(T.decodeAll(pcm, 16000).symbols).digits, '20260926');
  assert.throws(() => T.frameDigits('x'));
});
