// audio-demo.js — 柱7 物理層出力(音響・ノイズ担体)のデモ
// 設計メモ: docs/phase2-pillar7-audio-channel.md
// 実行: node examples/audio-demo.js

import { writeFileSync } from 'node:fs';
import { seal } from '../src/cord.js';
import { SmokeLog } from '../src/smoke.js';
import { renderAudio, extractAudio, receiveAudio, toWav, FreshnessGuard } from '../src/audio.js';

const ISSUER = 'demo-issuer-secret-not-real';
const T0 = 1_717_000_000_000;
const AXES = { epoch: T0, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層出力(音響・ノイズ担体)demo ===');
console.log('原則: 信号処理/AI は「耳」(頑健性)、cord は「約束」(真正性)。');
console.log('     見えない著作権コード = 隠すでなく「証明する」(鍵付き署名=柱6)。\n');

// --- ① 音響 codec: cord → FSK 波形 → WAV ---
console.log('--- ① 担体 codec(renderAudio / WAV)---');
const cord = seal('データ消去証明書 CASE-2026-0042', ISSUER, 'cert', { axes: AXES });
const samples = renderAudio(cord);
const wav = toWav(samples);
writeFileSync('human-cord-demo.wav', wav);
console.log('FSK 波形        :', samples.length, 'サンプル (16kHz, BFSK 2k/4kHz)');
console.log('WAV 書き出し    : human-cord-demo.wav (' + wav.length + ' bytes)');
console.log('extract 往復    : tip 一致 =', extractAudio(samples).tip === cord.tip, '\n');

// --- 雑音: 波形の一部が潰れると checksum 破綻(媒体エラー)---
console.log('--- 雑音検知 ---');
const noisy = Int16Array.from(samples);
for (let i = 5000; i < 5400; i++) noisy[i] = 0;
try {
  extractAudio(noisy);
} catch (e) {
  console.log('波形破損        :', e.name, '-', e.message, '\n');
}

// --- ② 受信口: 正常 → リプレイ → 鮮度切れ ---
console.log('--- ② 受信(receiveAudio)= codec + リプレイ防止 + 煙 ---');
const guard = new FreshnessGuard({ windowMs: 60_000 });
const log = new SmokeLog();
const T_recv = T0 + 3_000;

console.log('1 回目          :', receiveAudio(samples, ISSUER, { guard, smokeLog: log, clock: T_recv }), '  ← 受理');
try {
  receiveAudio(samples, ISSUER, { guard, smokeLog: log, clock: T_recv }); // 録音を再生した想定
} catch (e) {
  console.log('2 回目(再生)   :', e.name, '-', e.message, '  ← 拒否');
}
const old = renderAudio(seal('古い証明書', ISSUER, 'cert', { axes: AXES }));
try {
  receiveAudio(old, ISSUER, { guard, smokeLog: log, clock: T0 + 300_000 });
} catch (e) {
  console.log('窓外の到着      :', e.name, '-', e.message, '  ← 拒否');
}

console.log('\n煙(ログ)        :', log.entries.length, '件 / types =', log.entries.map((e) => `${e.type}:${e.detail.verdict}`).join(', '));
console.log('ログ整合性      :', log.verify(), '  ← 煙は消せない(柱8)');
console.log('\n注: 不可聴化(心理音響マスキング)・ECC・実マイク同期は Phase 2+ アダプタ(メモ §5/§6)。');
console.log('=== demo end ===');
