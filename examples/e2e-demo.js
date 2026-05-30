// e2e-demo.js — 統合デモ: データ消去証明書のライフサイクル
// 10 柱 + 2 担体(視覚/音響)が 1 つの現実シナリオで噛み合う様子を通しで示す。
// 実行: node examples/e2e-demo.js

import { seal, open, CordTamper } from '../src/cord.js';
import { combine as combineTally } from '../src/tally.js';
import { embedSubliminal, readSubliminal } from '../src/subliminal.js';
import { split, combine as combineShares } from '../src/shard.js';
import { SmokeLog, guardedOpen } from '../src/smoke.js';
import { render, extract, receiveVisual, FreshnessGuard } from '../src/visual.js';
import { renderAudio, extractAudio, receiveAudio, toWav } from '../src/audio.js';

const ISSUER = 'GO-issuer-secret-2026';   // 発行者の片割れ(本来は手元にのみ)
const OTHER = 'someone-elses-secret';
const T0 = 1_717_000_000_000;
const AXES = { epoch: T0, weekday: 2, hour: 9, parity: 0 };
const DOC = 'CASE-2026-0042';

const line = (s = '') => console.log(s);
line('=== human cord 統合 e2e — データ消去証明書のライフサイクル ===');
line('1 枚の証明書が「発行 → 関連付け → 物理担体 → 改ざん検知」を辿る間に、');
line('10 柱がどう噛み合うかを通しで示す。\n');

// ── ① 発行(柱1 多軸鍵 / 柱5 ratchet / 柱9 卵の鎖 / 柱2 風景 / 柱4 片割れ)──
line('--- ① 発行(柱1/2/4/5/9)---');
const cert = seal('データ消去証明書 ' + DOC, ISSUER, 'cert', { axes: AXES, docId: DOC });
line('公開軸 kdf      : ' + JSON.stringify(cert.kdf) + '  ← 時計は公開');
line('風景 surface    : ' + cert.surface.slice(0, 24) + ' …  ← 柱2 目玉文字');
line('卵の数          : ' + cert.eggs.length + ' / tip ' + cert.tip.slice(0, 16) + '…');
line('発行者で open   : ' + open(cert, ISSUER));
line('');

// ── ② 潜在チャネル(柱6)──
line('--- ② 潜在チャネル(柱6)---');
const marked = embedSubliminal(cert, ISSUER, '発行者控え:R3-0042 正規');
line('表(誰でも)     : ' + open(marked, ISSUER));
line('裏(発行者)     : ' + readSubliminal(marked, ISSUER));
line('裏(他人)       : ' + readSubliminal(marked, OTHER) + '  ← ノイズにしか見えない');
line('');

// ── ③ 割符演算(柱3)──
line('--- ③ 割符演算 +/-(柱3)---');
const erase = seal('消去:Blancco XML…', ISSUER, 'cert', { axes: AXES, docId: DOC });
const crush = seal('破砕:写真ログ…', ISSUER, 'cert', { axes: AXES, docId: DOC });
const merged = combineTally(erase, crush, ISSUER);
line('同一案件 + 統合 : matched=' + merged.matched + ' / ' + merged.merged);
const other = seal('別案件', ISSUER, 'cert', { axes: AXES, docId: 'CASE-9999' });
const diff = combineTally(erase, other, ISSUER);
line('別案件 - 差分   : matched=' + diff.matched + ' / ' + diff.diff.reason);
line('');

// ── ④ 発行者の片割れを分割(柱4深化 Shamir)──
line('--- ④ 片割れの情報理論的分割(柱4 Shamir)---');
const shares = split(Buffer.from(ISSUER), 5, 3);
line('分割            : 5 片(閾値 3)に分割');
const recovered = combineShares([shares[0], shares[2], shares[4]]).toString();
line('3 片で復元      : ' + (recovered === ISSUER ? '一致 → open=' + open(cert, recovered) : '失敗'));
const tooFew = combineShares([shares[0], shares[1]]).toString();
line('2 片では        : ' + (tooFew === ISSUER ? '復元' : '復元不能(計算無限でも不可)'));
line('');

// ── ⑤ 物理層担体(柱7)— 視覚 と 音響 ──
line('--- ⑤ 物理層担体(柱7)— 視覚 / 音響 の 2 経路 ---');
const guard = new FreshnessGuard({ windowMs: 60_000 });
const log = new SmokeLog();
const recvClock = T0 + 3_000;

const frame = render(marked);          // 視覚担体(裏マーク込み)
line('視覚 担体       : ' + frame.slice(0, 40) + ' …');
line('  裏マーク生存  : ' + (readSubliminal(extract(frame), ISSUER) ? 'OK(担体を越えて生き残る)' : 'NG'));
line('  受信(1回目)  : ' + receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock: recvClock }) + '  ← 受理');

const wav = toWav(renderAudio(cert));  // 音響担体(WAV)
line('音響 担体       : WAV ' + wav.length + ' bytes');
line('  復調 tip 一致 : ' + (extractAudio(renderAudio(cert)).tip === cert.tip));
const guard2 = new FreshnessGuard({ windowMs: 60_000 });
line('  受信          : ' + receiveAudio(renderAudio(cert), ISSUER, { guard: guard2, clock: recvClock }) + '  ← 受理');
line('');

// ── ⑥ リプレイ と 改ざん(柱8 煙 / 柱10 失敗境界)──
line('--- ⑥ リプレイ & 改ざん(柱8 煙 / 柱10 型のみ露出)---');
try {
  receiveVisual(frame, ISSUER, { guard, smokeLog: log, clock: recvClock }); // 録画の再提示
} catch (e) {
  line('視覚 再提示     : ' + e.name + ' → 拒否');
}
const tampered = seal('改ざんされる証明書', ISSUER, 'cert', { axes: AXES, docId: DOC });
tampered.eggs[0].ct[0] ^= 0xff;
try {
  guardedOpen(tampered, ISSUER, log, recvClock);
} catch (e) {
  line('本体 改ざん     : ' + e.name + '(seq=' + e.seq + ' のみ露出。核は不漏)');
}
line('煙ログ          : ' + log.entries.length + ' 件 / ' + log.entries.map((e) => e.type).join(', '));
line('ログ整合性      : ' + log.verify() + '  ← 煙は消せない(append-only)');
line('');
line('=== 結論: 10 柱が 1 つの証明書ライフサイクルで噛み合う ===');
line('発行者性(柱4/6)・関係性(柱3)・物理担体(柱7)・改ざんの痕跡(柱8/10)が');
line('別々の機能でなく、一本の紐(cord)として通っている。');
