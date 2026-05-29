// demo.js — human cord Phase 1 POC のひと回しデモ
// 実行: node examples/demo.js

import { seal, open } from '../src/cord.js';

// デモ用のダミー発行者秘密(本番は環境変数 / HSM 等から取得する想定)
const ISSUER_SECRET = 'demo-issuer-secret-not-real';
const plaintext = 'BiosGuide-Cert No.2026-0529 ABCDEFG';

console.log('=== human cord Phase 1 POC demo ===\n');
console.log('原文           :', plaintext);

// --- 発行(seal) ---
const cord = seal(plaintext, ISSUER_SECRET, 'demo');
console.log('\n--- 発行 (seal) ---');
console.log('風景 surface   :', cord.surface, '  ← 柱2 目玉文字(表示用・検証非依存)');
console.log('卵の数         :', cord.eggs.length, '  ← 柱9 卵の鎖(AEAD+ハッシュチェーン)');
console.log('鎖の先端 hash  :', cord.tip.slice(0, 16) + '…');
console.log('卵0 暗号文(hex):', cord.eggs[0].ct.toString('hex').slice(0, 32) + '…');

// --- 検証(open) ---
console.log('\n--- 検証 (open) ---');
console.log('復元           :', open(cord, ISSUER_SECRET));

// --- 柱4: 発行者の片割れが無ければ開けない ---
console.log('\n--- 柱4 片割れ: 他人は開けない ---');
try {
  open(cord, 'attacker-secret');
} catch (e) {
  console.log('✓ 拒否          :', e.name, '-', e.message);
}

// --- 柱10: 改ざんは「煙」を立てる(露出は seq のみ、核は不漏) ---
console.log('\n--- 柱10 失敗境界: 改ざん検知 ---');
const cord2 = seal(plaintext, ISSUER_SECRET, 'demo');
cord2.eggs[1].ct[0] ^= 0xff; // 卵1 の中身を 1 バイト改ざん
try {
  open(cord2, ISSUER_SECRET);
} catch (e) {
  console.log('✓ 改ざん検知    :', e.name, '- seq', e.seq, '(露出は型=seqのみ。鍵・平文・核は出ない)');
}

console.log('\n=== demo end ===');
