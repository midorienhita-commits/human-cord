// livecord-demo.js — 柱5/7/9 生きた担体(テロメア型フレーム鎖)のデモ
// 設計の種: docs/seed-bio-analogies.md §2(テロメア=不可逆な世代計数)
// 実行: node examples/livecord-demo.js
//
// 1 枚の担体(image.js/photo.js)に対し、ここは担体を「フレーム鎖」にして
// 「いま・ここで生きている」ことを証明する。録画を後で再生しても通らない。

import { emitLive, LiveVerifier } from '../src/livecord.js';

const ISSUER = 'demo-issuer-secret-not-real';
const T0 = 1_717_000_000_000; // 先頭フレームのエポック(固定)
const FRAME_MS = 200;          // フレーム間隔
const LEN = 6;                 // テロメア予算(枚)

console.log('=== 柱5/7/9 生きた担体(テロメア型フレーム鎖)demo ===');
console.log('防御: 鮮度(epoch は codebook 経由で ciphertext に束縛=freshen 不能)');
console.log('    + 連続性(各フレームに prev=前フレーム tip を封入=卵の鎖の時間方向)');
console.log('    + テロメア(seq 0..' + (LEN - 1) + ' を一方向に消費=巻き戻し/枯渇)\n');

const frames = emitLive('在席証明 BiosGuide 室', ISSUER, 'live',
  { startEpoch: T0, frameMs: FRAME_MS, length: LEN });
console.log('--- ① 発行(emitLive)---');
console.log('フレーム鎖      : ' + frames.length + ' 枚 / 間隔 ' + FRAME_MS + 'ms / seq0 は prev=null(genesis)');

// --- ② 正規ライブ: 各フレームをその時刻ちょうどに受信 ---
console.log('\n--- ② 正規ライブ(各フレームを発行時刻に受信)---');
let v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
for (let i = 0; i < LEN; i++) {
  const r = v.feed(frames[i], T0 + i * FRAME_MS + 20); // 20ms 遅れで到着
  console.log('  seq ' + i + ' → ' + r.verdict + (r.verdict === 'live' ? ' (受理)' : ' [' + r.reason + ']'));
}

// --- ③ 攻撃シナリオ: いずれも安全に弾く ---
console.log('\n--- ③ 攻撃シナリオ ---');
const show = (label, r, expect) => console.log('  ' + label + ' → ' + r.verdict + '  (期待: ' + expect + ')');

// 後日再生(録画を 10 分後に再生 → epoch 失効)
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
show('録画を10分後に再生  ', v.feed(frames[0], T0 + 600_000), 'stale');

// 別録画との接ぎ木(prev 鎖が繋がらない)
const other = emitLive('偽の在席', ISSUER, 'live', { startEpoch: T0 + 50, frameMs: FRAME_MS, length: LEN });
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
v.feed(frames[0], T0 + 20);
show('別録画フレームを接ぎ木', v.feed(other[1], T0 + FRAME_MS + 20), 'spliced');

// 並べ替え(seq 飛ばし)
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
v.feed(frames[0], T0 + 20);
show('順序入れ替え(seq2)   ', v.feed(frames[2], T0 + 2 * FRAME_MS + 20), 'reorder');

// 改ざん(暗号文 1 バイト反転)
const bad = JSON.parse(JSON.stringify(frames[0]));
if (bad.eggs[0].ct && bad.eggs[0].ct.data) bad.eggs[0].ct.data[0] ^= 0xff;
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
show('フレーム改ざん        ', v.feed(bad, T0 + 20), 'tamper');

// 同一フレームの再提示
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
v.feed(frames[0], T0 + 20);
show('同一フレーム再提示    ', v.feed(frames[0], T0 + 30), 'replay');

// テロメア枯渇
const longer = emitLive('x', ISSUER, 'live', { startEpoch: T0, frameMs: FRAME_MS, length: LEN + 1 });
v = new LiveVerifier(ISSUER, { windowMs: 500, length: LEN });
for (let i = 0; i < LEN; i++) v.feed(longer[i], T0 + i * FRAME_MS + 20);
show('予算超過(' + LEN + '枚消費後)  ', v.feed(longer[LEN], T0 + LEN * FRAME_MS + 20), 'exhausted');

console.log('\n正直な限界: 非対話では「鮮度窓内・別の検証者への即時リプレイ」は原理的に防げない。');
console.log('  窓を frameMs 数個に絞れば実用上ほぼ封じるが、厳密にはチャレンジ応答(検証者 nonce)が要る。');
console.log('結論: フレーム鎖が世代を不可逆に消費する「生きた担体」で、連続・順序・鮮度・有限性を保証できた。');
