// reconstruct-demo.js — 柱3 相同組換え修復(reconstructCase)のデモ
// 設計の種: docs/seed-bio-analogies.md §1(相同組換え修復)
// 実行: node examples/reconstruct-demo.js
//
// 生物: 二本鎖切断を、相同な無傷の姉妹染色体を鋳型に再建する。共通(相同)領域だけが再建可能。
// human cord: 同一案件(docId)の複数担体を相互の冗長コピーとみなし、一部が破損しても
//   無傷の姉妹を鋳型に「案件の本質事実(相同領域)」を再建・相互検証する。

import { issue, reconstructCase } from '../src/issue.js';

const ISSUER = 'demo-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };

// 同一案件 INTK-001 の姉妹3枚: 共有(case/devices/location)+ 文書固有(cert/serial)。
const sib = (cert, serial) => issue(
  { case: 'INTK-20260531-001', devices: 3, location: 'sapporo', cert, serial },
  ISSUER, { docId: 'INTK-20260531-001', axes: AXES });
const a = sib('CERT-A', 'SN-111');
const b = sib('CERT-B', 'SN-222');
const c = sib('CERT-C', 'SN-333');
// 別案件(同一発行者)= 非相同
const foreign = issue(
  { case: 'INTK-20260531-009', devices: 1, location: 'tokyo', cert: 'CERT-X', serial: 'SN-999' },
  ISSUER, { docId: 'INTK-20260531-009', axes: AXES });

// 担体の物理破損(影・水濡れ・指=RS 訂正能力を超える)を模す: b64 部を大きく潰す。
const wreck = (carrier) => {
  const p = carrier.split('|');
  const z = p[3];
  const n = Math.floor(z.length * 0.5);
  p[3] = z.slice(0, 8) + 'X'.repeat(n) + z.slice(8 + n);
  return p.join('|');
};

console.log('=== 柱3 相同組換え修復(reconstructCase)demo ===');
console.log('生物: 損傷鎖を無傷の姉妹を鋳型に再建。共通(相同)領域だけ再建可能。');
console.log('cord: 同一案件の複数担体を冗長コピーとし、案件の本質事実を再建・相互検証。\n');

console.log('--- ① 全姉妹が無傷 ---');
let r = reconstructCase([a.carrier, b.carrier, c.carrier], ISSUER);
console.log('再建(相同領域)  :', JSON.stringify(r.recovered));
console.log('文書固有(非相同):', JSON.stringify(Object.keys(r.variable)), '← 鋳型では再建できない');
console.log('相互検証 corroboration:', r.corroboration, '枚が一致');

console.log('\n--- ② 2 枚が物理破損、C だけ生存 ---');
r = reconstructCase([wreck(a.carrier), wreck(b.carrier), c.carrier], ISSUER);
console.log('ok:', r.ok, '| 再建:', JSON.stringify(r.recovered));
console.log('破損担体(鋳型で被覆):', r.repaired.map((d) => d.verdict), '← 1 枚残れば案件の真実は生き延びる');

console.log('\n--- ③ 別案件の担体を混入(非相同 → 排除)---');
r = reconstructCase([a.carrier, c.carrier, foreign.carrier], ISSUER);
console.log('対象案件 docId  :', r.docId);
console.log('foreign(排除)   :', JSON.stringify(r.foreign), '← 別 docId = 取り違え/別案件を検知');
console.log('再建(真の姉妹のみ):', JSON.stringify(r.recovered));

console.log('\n--- ④ 全滅(案件のコピーが全破損)---');
r = reconstructCase([wreck(a.carrier), wreck(b.carrier), wreck(c.carrier)], ISSUER);
console.log('ok:', r.ok, '| reason:', r.reason, '← 1 枚も残らなければ案件は失われる(正直な限界)');

console.log('\n結論: 相同領域(案件の本質事実)は無傷の姉妹を鋳型に再建でき、複数姉妹が相互検証する。');
console.log('      文書固有(非相同)フィールドは鋳型に無いので復元しない。再建は verify 済みの真正な');
console.log('      姉妹からのみ = 偽の事実は混ざらない(媒体修復 ≠ 暗号的真正性は別ドメイン)。');
