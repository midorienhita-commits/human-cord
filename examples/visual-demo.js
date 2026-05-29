// visual-demo.js — 柱7 物理層出力(視覚チャネル)のデモ
// 設計メモ: docs/phase2-pillar7-visual-channel.md
// 実行: node examples/visual-demo.js

import { seal } from '../src/cord.js';
import { SmokeLog } from '../src/smoke.js';
import { render, extract, FreshnessGuard, receiveVisual, VisualFrameError } from '../src/visual.js';

const ISSUER = 'demo-issuer-secret-not-real';
// 公開軸(epoch を握って鮮度をデモで動かす)。発行は仮想時刻 T0。
const T0 = 1_717_000_000_000;
const AXES = { epoch: T0, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層出力(視覚チャネル)demo ===');
console.log('原則: AI は「目」(頑健性)、cord は「約束」(真正性)。');
console.log('     光チャネルはリプレイを防げない → プロトコル(nonce+鮮度+煙)で守る。\n');

// --- ① フレーム codec: cord → 視覚担体 → cord ---
console.log('--- ① 担体 codec(render / extract)---');
const cord = seal('データ消去証明書 CASE-2026-0042', ISSUER, 'cert', { axes: AXES });
const frame = render(cord);
console.log('担体フレーム    :', frame.slice(0, 56) + ' …');
console.log('  形式          : HC1|<長さ>|<sha256先頭12>|<base64url(cord)>');
console.log('  (将来この文字列を QR/画像/印刷に載せ、カメラ+AI で読み戻す)');
const back = extract(frame);
console.log('extract 往復    : tip 一致 =', back.tip === cord.tip, '\n');

// --- 光学ノイズ: 1 文字化けると checksum が破綻(媒体エラーとして検知)---
console.log('--- 光学ノイズ検知 ---');
const noisy = frame.slice(0, 30) + (frame[30] === 'A' ? 'B' : 'A') + frame.slice(31);
try {
  extract(noisy);
} catch (e) {
  console.log('1 文字化け      :', e.name, '-', e.message, '\n');
}

// --- ② 受信口: 正常 → リプレイ → 鮮度切れ ---
console.log('--- ② 受信(receiveVisual)= codec + リプレイ防止 + 煙 ---');
const guard = new FreshnessGuard({ windowMs: 60_000 });
const log = new SmokeLog();

// 1 回目: 鮮度窓内・未受理 → 受理
const T_recv = T0 + 3_000; // 発行 3 秒後に受信
console.log('1 回目          :', receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock: T_recv }), '  ← 受理');

// 2 回目: 同じ担体を再提示(画面を撮って再表示した想定)→ リプレイ
try {
  receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock: T_recv });
} catch (e) {
  console.log('2 回目(再提示) :', e.name, '-', e.message, '  ← 拒否');
}

// 別の担体だが鮮度窓を超えて到着 → stale
const old = render(seal('古い証明書', ISSUER, 'cert', { axes: AXES }));
try {
  receiveVisual(old, ISSUER, { guard, smokeLog: log, clock: T0 + 300_000 }); // 5 分後
} catch (e) {
  console.log('窓外の到着      :', e.name, '-', e.message, '  ← 拒否');
}

console.log('\n煙(ログ)        :', log.entries.length, '件 / types =', log.entries.map((e) => `${e.type}:${e.detail.verdict}`).join(', '));
console.log('ログ整合性      :', log.verify(), '  ← 煙は消せない(柱8)');
console.log('\n注: 実ピクセル描画・QR 格子・ECC・AI 抽出は Phase 2+ アダプタ(メモ §5/§6)。');
console.log('=== demo end ===');
