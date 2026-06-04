// reconstruct.test.js
// 柱3「相同組換え修復(reconstructCase)」の振る舞い検証。
// 設計の種: docs/seed-bio-analogies.md §1
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issue, reconstructCase } from '../src/issue.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const CASE = 'INTK-2026-001';

// 同一案件の姉妹: 共有(case/devices/location)+ 文書固有(cert/serial)。
function sibling(cert, serial, secret = SECRET) {
  return issue({ case: CASE, devices: 3, location: 'sapporo', cert, serial },
    secret, { docId: CASE, axes: AXES });
}
// RS 能力を超える担体破損を模す(b64 部を大きく潰す)。
function wreck(carrier) {
  const p = carrier.split('|');
  const z = p[3];
  const n = Math.floor(z.length * 0.5);
  p[3] = z.slice(0, 8) + 'X'.repeat(n) + z.slice(8 + n);
  return p.join('|');
}

test('柱3 修復: 全姉妹無傷 → 相同領域=共有事実 / 非相同=文書固有 / 相互検証', () => {
  const a = sibling('CERT-A', 'SN-1');
  const b = sibling('CERT-B', 'SN-2');
  const c = sibling('CERT-C', 'SN-3');
  const r = reconstructCase([a.carrier, b.carrier, c.carrier], SECRET);
  assert.equal(r.ok, true);
  assert.equal(r.docId, CASE);
  assert.deepEqual(r.recovered, { case: CASE, devices: 3, location: 'sapporo' });
  assert.deepEqual(Object.keys(r.variable).sort(), ['cert', 'serial']);
  assert.equal(r.corroboration, 3);
  assert.equal(r.repaired.length, 0);
});

test('柱3 修復: 2 枚破損・1 枚生存でも案件の本質事実を再建する(鋳型=無傷の姉妹)', () => {
  const a = sibling('CERT-A', 'SN-1');
  const b = sibling('CERT-B', 'SN-2');
  const c = sibling('CERT-C', 'SN-3');
  const r = reconstructCase([wreck(a.carrier), wreck(b.carrier), c.carrier], SECRET);
  assert.equal(r.ok, true);
  // 1 枚生存なので相同領域=その全 facts(案件の真実は生き延びる)。
  assert.equal(r.recovered.case, CASE);
  assert.equal(r.recovered.devices, 3);
  assert.equal(r.corroboration, 1);
  assert.equal(r.repaired.length, 2);
  assert.ok(r.repaired.every((d) => d.verdict === 'media-error'));
});

test('柱3 修復: 別案件(別 docId)の担体は非相同として foreign に排除する', () => {
  const a = sibling('CERT-A', 'SN-1');
  const c = sibling('CERT-C', 'SN-3');
  const other = issue({ case: 'INTK-2026-009', devices: 1, location: 'tokyo', cert: 'CERT-X', serial: 'SN-9' },
    SECRET, { docId: 'INTK-2026-009', axes: AXES });
  const r = reconstructCase([a.carrier, c.carrier, other.carrier], SECRET);
  assert.equal(r.docId, CASE);
  assert.equal(r.foreign.length, 1);
  assert.equal(r.foreign[0].docId, 'INTK-2026-009');
  assert.deepEqual(r.recovered, { case: CASE, devices: 3, location: 'sapporo' });
});

test('柱3 修復: 案件のコピーが全滅すると ok:false(再建不能=正直な限界)', () => {
  const a = sibling('CERT-A', 'SN-1');
  const b = sibling('CERT-B', 'SN-2');
  const r = reconstructCase([wreck(a.carrier), wreck(b.carrier)], SECRET);
  assert.equal(r.ok, false);
  assert.equal(r.damaged.length, 2);
});

test('柱3 修復: docId を明示すると、その案件の姉妹だけで再建する', () => {
  const a = sibling('CERT-A', 'SN-1');
  const other = issue({ case: 'OTHER', devices: 9, location: 'tokyo' }, SECRET, { docId: 'OTHER', axes: AXES });
  const r = reconstructCase([a.carrier, other.carrier], SECRET, { docId: 'OTHER' });
  assert.equal(r.docId, 'OTHER');
  assert.equal(r.recovered.devices, 9);
  assert.equal(r.foreign.length, 1); // CASE の方が foreign 扱い
});

test('柱3 修復: 別発行者(秘密違い)の担体は tamper として damaged(foreign ではない)', () => {
  const a = sibling('CERT-A', 'SN-1');
  const evil = sibling('CERT-E', 'SN-E', 'wrong-issuer-secret');
  const r = reconstructCase([a.carrier, evil.carrier], SECRET);
  assert.equal(r.ok, true); // a は無傷
  assert.equal(r.corroboration, 1);
  assert.equal(r.repaired.length, 1);
  assert.equal(r.repaired[0].verdict, 'tamper'); // 別発行者は AEAD 失敗
});
