// tally-demo.js — 柱3 割符演算(+/-)のデモ
// 実行: node examples/tally-demo.js
//
// シナリオ: 1 つの案件(CASE-2026-0042)の消去証明と破砕証明を別々の cord として
// 発行し、割符演算 `+` で統合。別案件・別発行者とは噛み合わず `-` 差分が出る。

import { seal } from '../src/cord.js';
import { combine } from '../src/tally.js';

const ISSUER = 'demo-issuer-secret-not-real';
const ATTACKER = 'attacker-secret';

const erase = seal('消去:HDD-001 NIST完了 ', ISSUER, 'cert', { docId: 'CASE-2026-0042' });
const crush = seal('破砕:SSD-002 穿孔完了', ISSUER, 'cert', { docId: 'CASE-2026-0042' });
const other = seal('別案件:PC-900', ISSUER, 'cert', { docId: 'CASE-2026-9999' });
const forged = seal('偽造:HDD-001', ATTACKER, 'cert', { docId: 'CASE-2026-0042' });

console.log('=== human cord 柱3 割符演算 demo ===\n');

console.log('--- A + B: 同一案件の片割れ(消去 + 破砕)---');
const merged = combine(erase, crush, ISSUER);
console.log('演算:', merged.op, '/ 合致:', merged.matched);
console.log('統合:', merged.merged, '  ← 通行手形が噛み合い 1 通に統合\n');

console.log('--- A − C: 別案件(docId 不一致)---');
const diffCase = combine(erase, other, ISSUER);
console.log('演算:', diffCase.op, '/ 合致:', diffCase.matched);
console.log('差分:', diffCase.diff.reason, '\n');

console.log('--- A − Forged: 別発行者の偽造片 ---');
const diffForge = combine(erase, forged, ISSUER);
console.log('演算:', diffForge.op, '/ 合致:', diffForge.matched);
console.log('差分:', diffForge.diff.reason);
console.log('  tally 合致 A=' + diffForge.diff.tallyMatchA, 'B=' + diffForge.diff.tallyMatchB,
  '  ← 偽造片は通行手形が噛み合わない\n');

console.log('=== demo end ===');
