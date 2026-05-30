// issue-demo.js — 発行 / 発行者媒介検証(アプリ採用面)のデモ
// Phase 4 統合設計の中核 API。verify() は throw せず構造化結果を返す(検証口の応答イメージ)。
// 実行: node examples/issue-demo.js

import { issue, verify, FreshnessGuard, SmokeLog } from '../src/issue.js';

const ISSUER = 'demo-issuer-secret-not-real'; // 信頼境界(サーバ側)にのみ存在
const OTHER = 'someone-elses-secret';
const T0 = 1_717_000_000_000;
const AXES = { epoch: T0, weekday: 2, hour: 9, parity: 0 };

// 用途固有スキーマ(採用側アプリが定義。human cord には持ち込まない)
const FACTS = { docId: 'CASE-2026-0042', kind: 4, devices: 12, method: 'Blancco', site: 'LOG', date: '2026-05-30' };

const j = (o) => JSON.stringify(o);
console.log('=== human cord 採用面: 発行 / 発行者媒介検証 demo ===');
console.log('payload は opaque(用途固有スキーマは採用側)。verify は構造化結果を返す。\n');

// --- 発行 ---
const { carrier } = issue(FACTS, ISSUER, { context: 'cert', docId: FACTS.docId, axes: AXES, mark: '正規:R3-0042' });
console.log('発行 carrier   :', carrier.slice(0, 44), '…  (HC2 = ECC 付担体)\n');

const clock = T0 + 3_000;

// --- 正常検証(発行者媒介)---
console.log('--- 正常(発行者が検証)---');
console.log(j(verify(carrier, ISSUER, { guard: new FreshnessGuard({ windowMs: 60_000 }), clock })));

// --- 他者検証(秘密=片割れ無し)---
console.log('\n--- 他者(片割れ無し)---');
console.log(j(verify(carrier, OTHER, { guard: new FreshnessGuard({ windowMs: 60_000 }), clock })));

// --- リプレイ ---
console.log('\n--- リプレイ(同じ担体を再提示)---');
const g = new FreshnessGuard({ windowMs: 60_000 });
const log = new SmokeLog();
verify(carrier, ISSUER, { guard: g, smokeLog: log, clock }); // 1 回目受理
console.log(j(verify(carrier, ISSUER, { guard: g, smokeLog: log, clock })));

// --- 担体破損 ---
console.log('\n--- 担体破損(媒体エラー)---');
const broken = (() => { const p = carrier.split('|'); p[1] = '999999'; return p.join('|'); })();
console.log(j(verify(broken, ISSUER, {})));

console.log('\n煙ログ:', log.entries.length, '件 /', log.entries.map((e) => e.type).join(','), '/ verify =', log.verify());
console.log('\n注: この verify 結果をそのまま Edge Function が JSON 応答にする(秘密は信頼境界の中)。');
console.log('=== demo end ===');
