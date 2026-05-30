// visual-ecc.test.js
// 柱7 視覚担体の HC2(Reed-Solomon 誤り訂正つき)。
// 実世界の雑音で担体が一部化けても、能力内なら訂正して開けることを検証。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/cord.js';
import { renderEcc, extract, receiveVisual, FreshnessGuard, VisualFrameError } from '../src/visual.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const BODY = 'ECC 担体テスト: データ消去証明書 CASE-2026-0042 / 長めの本文で複数ブロックにまたがらせる';

function freshCord() {
  return seal(BODY, SECRET, 'cert', { axes: AXES });
}
// 4 番目フィールド(base64 payload)の指定位置だけ化けさせる(枠は壊さない)。
function corruptPayload(frame, positions) {
  const parts = frame.split('|');
  const b = parts[3].split('');
  for (const p of positions) {
    const i = p % b.length;
    b[i] = b[i] === 'A' ? 'B' : 'A';
  }
  parts[3] = b.join('');
  return parts.join('|');
}

test('柱7 HC2: renderEcc→extract 往復(誤り無し)', () => {
  const cord = freshCord();
  const frame = renderEcc(cord);
  assert.ok(frame.startsWith('HC2|'));
  assert.equal(extract(frame).tip, cord.tip);
});

test('柱7 HC2: 担体が散発的に化けても RS が訂正して開ける(能力内)', () => {
  const cord = freshCord();
  const frame = renderEcc(cord);
  // 16 箇所を散らして化けさせる(7 ブロックに分散 → 各ブロック数バイト < 16 訂正能力)
  const positions = [];
  for (let i = 0; i < 16; i++) positions.push(Math.floor((i * frame.length) / 17) + 7);
  const noisy = corruptPayload(frame, positions);
  assert.notEqual(noisy, frame);

  const guard = new FreshnessGuard({ windowMs: 60_000 });
  assert.equal(receiveVisual(noisy, SECRET, { guard, clock: AXES.epoch + 1000 }), BODY);
});

test('柱7 HC2: 1 ブロックに密集した過大な誤りは訂正不能として弾く(checksum で安全)', () => {
  const cord = freshCord();
  const frame = renderEcc(cord);
  // 先頭ブロック相当の base64 連続 60 文字を破壊(>16 バイト誤り → 訂正能力超過)
  const positions = [];
  for (let i = 0; i < 60; i++) positions.push(10 + i);
  const broken = corruptPayload(frame, positions);
  assert.throws(() => extract(broken), VisualFrameError);
});

test('柱7 HC2: 誤り訂正後も改ざんは AEAD で検知(媒体訂正 ≠ 本体改ざん)', () => {
  // renderEcc は payload=JSON(cord) を保護する。卵を改ざんしてから担体化すると、
  // RS は「改ざん後の payload」を忠実に運ぶだけなので、本体の AEAD で割れる。
  const cord = freshCord();
  cord.eggs[0].ct[0] ^= 0xff;
  const frame = renderEcc(cord);
  const guard = new FreshnessGuard({ windowMs: 60_000 });
  assert.throws(() => receiveVisual(frame, SECRET, { guard, clock: AXES.epoch + 1000 }),
    (e) => e.name === 'CordTamper');
});
