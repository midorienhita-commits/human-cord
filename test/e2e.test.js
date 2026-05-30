// e2e.test.js
// 統合 e2e: データ消去証明書のライフサイクルで 10 柱 + 2 担体が噛み合うことを検証。
// 各柱が個別に動くだけでなく、1 つの現実シナリオで合成できることを保証する(回帰防止)。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seal, open, CordTamper } from '../src/cord.js';
import { combine as combineTally } from '../src/tally.js';
import { embedSubliminal, readSubliminal } from '../src/subliminal.js';
import { split, combine as combineShares } from '../src/shard.js';
import { SmokeLog, guardedOpen } from '../src/smoke.js';
import { render, extract, receiveVisual, VisualFrameError, FreshnessGuard } from '../src/visual.js';
import { renderAudio, extractAudio, receiveAudio, toWav, fromWav } from '../src/audio.js';

const ISSUER = 'GO-issuer-secret-2026';
const OTHER = 'someone-elses-secret';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const DOC = 'CASE-2026-0042';
const BODY = 'データ消去証明書 CASE-2026-0042 / Blancco XML 由来';

function issue(text = BODY, docId = DOC) {
  return seal(text, ISSUER, 'cert', { axes: AXES, docId });
}

// 柱1/2/4/5/9/10 — 発行と検証の芯 ───────────────────────────────
test('e2e 芯: 発行→検証で平文が戻り、発行者でなければ割れる(露出は型のみ)', () => {
  const cord = issue();
  assert.ok(cord.kdf.epoch === AXES.epoch);     // 柱1 公開軸(時計は公開)
  assert.ok(typeof cord.surface === 'string');  // 柱2 風景(目玉文字)
  assert.ok(Array.isArray(cord.eggs) && cord.eggs.length > 0); // 柱9 卵の鎖
  assert.equal(open(cord, ISSUER), BODY);        // 柱4 片割れで開く

  try {
    open(cord, OTHER);                            // 柱4: 片割れ無しは不能
    assert.fail('別秘密で開けてしまった');
  } catch (e) {
    assert.ok(e instanceof CordTamper);
    assert.equal(typeof e.seq, 'number');         // 柱10: 露出は型(seq)のみ
    assert.ok(!('key' in e) && !('plaintext' in e)); // 核は載らない
  }
});

// 柱6 — 潜在チャネル ────────────────────────────────────────────
test('e2e 柱6: 発行者だけが裏マークを読める(表は誰でも、裏は片割れ)', () => {
  const mark = '発行者控え:R3-0042 正規';
  const cord = embedSubliminal(issue(), ISSUER, mark);
  assert.equal(open(cord, ISSUER), BODY);         // 表は通常どおり
  assert.equal(readSubliminal(cord, ISSUER), mark); // 裏は発行者
  assert.equal(readSubliminal(cord, OTHER), null);  // 他人にはノイズ
});

// 柱3 — 割符演算 +/- ───────────────────────────────────────────
test('e2e 柱3: 同一案件は + で統合、別案件は - で差分発火', () => {
  const a = seal('消去記録 A…', ISSUER, 'cert', { axes: AXES, docId: DOC });
  const b = seal('破砕記録 B…', ISSUER, 'cert', { axes: AXES, docId: DOC });
  const plus = combineTally(a, b, ISSUER);
  assert.equal(plus.op, '+');
  assert.equal(plus.matched, true);
  assert.equal(plus.merged, '消去記録 A…破砕記録 B…');

  const other = seal('別案件', ISSUER, 'cert', { axes: AXES, docId: 'CASE-9999' });
  const minus = combineTally(a, other, ISSUER);
  assert.equal(minus.op, '-');
  assert.equal(minus.matched, false);
});

// 柱4深化 — Shamir 秘密分散 ─────────────────────────────────────
test('e2e 柱4深化: 閾値 k 片で発行者秘密を復元して開ける / k-1 片では不能', () => {
  const cord = issue();
  const shares = split(Buffer.from(ISSUER), 5, 3); // 5 片・閾値 3

  const enough = combineShares([shares[0], shares[2], shares[4]]).toString();
  assert.equal(enough, ISSUER);                    // 3 片で復元
  assert.equal(open(cord, enough), BODY);          // 復元秘密で開ける

  const tooFew = combineShares([shares[0], shares[1]]).toString();
  assert.notEqual(tooFew, ISSUER);                 // 2 片では別物(情報理論的)
  assert.throws(() => open(cord, tooFew), CordTamper);
});

// 柱7 視覚担体 + 柱8/10 — 物理層 + リプレイ防止 ──────────────────
test('e2e 柱7 視覚: 担体往復で開ける / 潜在チャネルも担体を生き残る / 再提示は煙', () => {
  const mark = '発行者控え:visual';
  const cord = embedSubliminal(issue(), ISSUER, mark);
  const frame = render(cord);

  // 担体を JSON 往復しても裏マークは生き残る(柱6 × 柱7)
  assert.equal(readSubliminal(extract(frame), ISSUER), mark);

  const guard = new FreshnessGuard({ windowMs: 60_000 });
  const log = new SmokeLog();
  const clock = AXES.epoch + 1_000;
  assert.equal(receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock }), BODY);

  // 同じ担体の再提示 = リプレイ → 煙
  assert.throws(() => receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock }), VisualFrameError);
  assert.equal(log.entries.at(-1).type, 'replay-or-stale');
  assert.equal(log.verify(), true);
});

// 柱7 音響担体 ─────────────────────────────────────────────────
test('e2e 柱7 音響: WAV 往復で開ける(視覚と同じ約束を別担体で)', () => {
  const cord = issue();
  const wav = toWav(renderAudio(cord));
  assert.equal(extractAudio(fromWav(wav)).tip, cord.tip);

  const guard = new FreshnessGuard({ windowMs: 60_000 });
  assert.equal(receiveAudio(fromWav(wav), ISSUER, { guard, clock: AXES.epoch + 1_000 }), BODY);
});

// 柱8/10 — 改ざんで煙、露出は型のみ ─────────────────────────────
test('e2e 柱8/10: 本体改ざんは煙(tamper)を上げ、消せない。露出は seq のみ', () => {
  const cord = issue();
  cord.eggs[1].ct[0] ^= 0xff;             // 火(改ざん)をつける
  const log = new SmokeLog();
  assert.throws(() => guardedOpen(cord, ISSUER, log, AXES.epoch + 1_000), CordTamper);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].type, 'tamper');      // 柱8 煙
  assert.equal(typeof log.entries[0].detail.seq, 'number'); // 柱10 型のみ
  assert.equal(log.verify(), true);                  // 煙は消せない

  log.entries[0].detail.seq = 0;                     // 遡及改ざんを試みる
  assert.equal(log.verify(), false);                 // 検知される
});
