// smoke-subliminal-demo.js — 柱8(煙)+ 柱6(潜在チャネル)のデモ
// 実行: node examples/smoke-subliminal-demo.js

import { seal, open } from '../src/cord.js';
import { SmokeLog, guardedOpen } from '../src/smoke.js';
import { embedSubliminal, readSubliminal } from '../src/subliminal.js';

const ISSUER = 'demo-issuer-secret-not-real';
const VERIFIER_ONLY = 'verifier-without-issuer-secret';

console.log('=== 柱6 潜在チャネル + 柱8 発火応答 demo ===\n');

// --- 柱6: 表の証明書に、発行者だけが読める裏マークを埋める ---
let cord = seal('データ消去証明書 CASE-2026-0042', ISSUER, 'cert');
cord = embedSubliminal(cord, ISSUER, '発行者控え:本物R3-0042');

console.log('--- 柱6 潜在チャネル ---');
console.log('表(open)        :', open(cord, ISSUER), '  ← 検証者も表は読める');
console.log('裏(発行者)      :', readSubliminal(cord, ISSUER), '  ← 発行者だけ');
console.log('裏(発行者でない) :', readSubliminal(cord, VERIFIER_ONLY), '  ← 読めない(ノイズ)\n');

// --- 柱8: 改ざんすると煙が立ち、append-only ログに永久記録 ---
console.log('--- 柱8 発火応答(煙)---');
const log = new SmokeLog();
const tampered = seal('改ざんされる証明書', ISSUER, 'cert');
tampered.eggs[0].ct[0] ^= 0xff; // 火(改ざん)をつける
try {
  guardedOpen(tampered, ISSUER, log, 1717000000000);
} catch (e) {
  console.log('検知            :', e.name, '- seq', e.seq);
}
console.log('煙(ログ)        :', log.entries.length, '件 / type =', log.entries[0].type);
console.log('ログ整合性      :', log.verify(), '  ← ハッシュチェーンで遡及改ざん不能');

// ログを遡及改ざんしてみる → 煙は消せない
log.entries[0].detail.message = 'なかったことにする';
console.log('改ざん後の整合性:', log.verify(), '  ← 煙は消えない(火のないところに煙は立たぬの逆)\n');

console.log('=== demo end ===');
