// photo-demo.js — 柱7 物理層: 視覚担体の「カメラ写真」アダプタ(finder + 透視補正)のデモ
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4 / §7
// 実行: node examples/photo-demo.js
//
// image.js(extractImage)は「位置・尺度・向きが既知の格子」を前提に読む。
// 本デモは実カメラ写真に一歩近づく: 担体を傾けて撮った写真(回転・透視・背景・劣化)を、
// finder(四隅の位置検出パターン)で見つけ → ホモグラフィで補正 → モジュールを再標本 → cord。
// AI は「目」(幾何の頑健化)、cord は「約束」(真正性)。誤り訂正は HC2 と同じ RS。

import { writeFileSync } from 'node:fs';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, PhotoError } from '../src/photo.js';

const ISSUER = 'demo-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層: カメラ写真アダプタ(finder + 透視補正)demo ===');
console.log('原則: AI は「目」(傾き・透視・劣化への頑健性)、cord は「約束」(真正性)。\n');

// --- ① finder 付き担体を実 PNG へ ---
const cord = seal('データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco', ISSUER, 'cert', { axes: AXES });
const { png, modules, total, side } = renderScannable(cord);
writeFileSync('human-cord-scannable.png', png);
console.log('--- ① finder 付き担体(renderScannable)---');
console.log('PNG 書き出し    : human-cord-scannable.png (' + png.length + ' bytes)');
console.log('格子            : データ ' + modules + '×' + modules + ' + 四隅 finder / 総 ' + total + '×' + total + ' モジュール / ' + side + 'px');

// --- ② 傾けて撮った「写真」へ → 検出+補正で読み戻す ---
console.log('\n--- ② 写真(回転・透視・背景・劣化)→ finder 検出 → 補正 → 読み戻し ---');
const shots = [
  { label: '縮小+並進(机の隅)      ', opts: { scale: 0.75, tx: 50, ty: -30 } },
  { label: '回転 20°              ', opts: { rotateDeg: 20, scale: 0.8 } },
  { label: '回転 -32°             ', opts: { rotateDeg: -32, scale: 0.8 } },
  { label: '透視(横keystone 22%)  ', opts: { tiltX: 0.22, scale: 0.9 } },
  { label: '透視(縦keystone 20%)  ', opts: { tiltY: 0.20, scale: 0.9 } },
  { label: '回転+透視+ぼけ+露出    ', opts: { rotateDeg: 12, tiltY: 0.15, scale: 0.82, blur: 1, brightness: 25 } },
  { label: '回転+透視+ノイズ+暗    ', opts: { rotateDeg: -14, tiltX: 0.16, scale: 0.8, blur: 1, brightness: -25, noise: 0.006 } },
];
for (const s of shots) {
  try {
    const back = scanPhoto(simulatePhoto(png, s.opts));
    console.log(s.label + ' → ✓ ' + (back.tip === cord.tip ? 'tip一致' : 'tip不一致!') + ' / open: ' + open(back, ISSUER));
  } catch (e) {
    console.log(s.label + ' → ✗ ' + e.name + ': ' + e.message);
  }
}
// 写真サンプルを 1 枚保存(目視確認用)。
writeFileSync('human-cord-photo.png', simulatePhoto(png, { rotateDeg: 12, tiltY: 0.15, scale: 0.82, blur: 1, brightness: 25 }));
console.log('  写真サンプル    : human-cord-photo.png(回転+透視+ぼけ+露出)');

// --- ③ 設計上の射程と「安全な失敗」---
console.log('\n--- ③ 射程(面内回転 ≲±45°: 四隅 finder が同一形のため向きの曖昧性が限界)---');
try {
  scanPhoto(simulatePhoto(png, { rotateDeg: 60, scale: 0.8 }));
  console.log('回転 60°              → (読めた — 想定外)');
} catch (e) {
  console.log('回転 60°(限界超)     → ✗ ' + e.name + ': ' + e.message + ' (安全失敗)');
}

// --- ④ 媒体層と暗号層は別ドメイン: 写真を抜けても「約束」は守られる ---
console.log('\n--- ④ 写真チャネルを抜けても改ざんは AEAD が検知する(媒体≠暗号)---');
const recovered = scanPhoto(simulatePhoto(png, { rotateDeg: 10, scale: 0.85, blur: 1 }));
(function corrupt(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Buffer.isBuffer(v) && v.length) { v[0] ^= 0xff; return true; }
    if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) { v.data[0] ^= 0xff; return true; }
    if (v && typeof v === 'object' && corrupt(v)) return true;
  }
  return false;
})(recovered);
try {
  open(recovered, ISSUER);
  console.log('改ざん cord     : (検知できず — 想定外)');
} catch (e) {
  console.log('改ざん cord     : ✗ ' + (e instanceof CordTamper ? 'CordTamper' : e.name) + ' ← 写真を抜けても AEAD が改ざんを検知');
}

console.log('\n結論: 位置・回転・傾きが未知の「写真」からでも、finder で見つけ・透視補正し・RS で訂正して');
console.log('      cord を復元できた。実カメラ撮影/AI 抽出・有機担体・録画リプレイ耐性は継続(§7)。');
