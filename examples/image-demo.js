// image-demo.js — 柱7 物理層出力(視覚チャネルの「実ピクセル」アダプタ)のデモ
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4
// 実行: node examples/image-demo.js
//
// visual.js が「媒体非依存のテキスト担体」までを担うのに対し、本デモは一周を閉じる:
//   cord → 実 PNG 画像 →(撮影で起きる劣化)→ 読み戻し → cord → open。
// 光学ノイズ・部分遮蔽(影・指・反射)で一部モジュールが化けても、HC2 と同じ
// Reed-Solomon が訂正する。AI は「目」(頑健性)、cord は「約束」(真正性)。

import { writeFileSync } from 'node:fs';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderImage, extractImage, simulateOptics, ImageCarrierError } from '../src/image.js';

const ISSUER = 'demo-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層出力(視覚チャネル: 実 PNG)demo ===');
console.log('原則: AI は「目」(歪み・光・欠損への頑健性)、cord は「約束」(真正性)。');
console.log('     実ピクセル担体の一周を閉じる(cord → PNG → 撮影劣化 → 読み戻し → open)。\n');

// --- ① cord を実 PNG 画像へ ---
const cord = seal('データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco', ISSUER, 'cert', { axes: AXES });
const { png, modules, side } = renderImage(cord);
writeFileSync('human-cord-carrier.png', png);
console.log('--- ① 担体画像(renderImage)---');
console.log('PNG 書き出し    : human-cord-carrier.png (' + png.length + ' bytes)');
console.log('格子            : ' + modules + '×' + modules + ' モジュール / ' + side + '×' + side + ' px(白黒2値)');
console.log('  形式          : [静寂帯][RS保護ヘッダ][HC2 の RS バイト(ブロックインターリーブ)]');

// --- ② 無劣化の読み戻し ---
const clean = extractImage(png);
console.log('\n--- ② 無劣化の読み戻し(extractImage)---');
console.log('tip 一致        :', clean.tip === cord.tip);
console.log('open(平文)      :', open(clean, ISSUER));

// --- ③ 撮影劣化を加えても RS が訂正する ---
console.log('\n--- ③ 撮影劣化 → RS 誤り訂正 ---');
const scenarios = [
  { label: 'ぼけ+露出ずれ+0.5%ノイズ', opts: { blur: 1, brightness: 40, noise: 0.005, seed: 7 } },
  { label: '隅6%を遮蔽(指/反射想定) ', opts: { occlude: 0.06, seed: 3 } },
  { label: '遮蔽3%+0.3%ノイズ+ぼけ   ', opts: { occlude: 0.03, noise: 0.003, blur: 1, seed: 9 } },
];
for (const s of scenarios) {
  const noisy = simulateOptics(png, s.opts);
  try {
    const back = extractImage(noisy);
    console.log(s.label + ' → ✓ 訂正成功・open:', open(back, ISSUER));
  } catch (e) {
    console.log(s.label + ' → ✗ ' + e.name + ': ' + e.message);
  }
}

// 訂正能力を超える劣化は「安全に」媒体エラーとして弾く(改ざんと混同しない)。
const wrecked = simulateOptics(png, { noise: 0.05, seed: 1 });
writeFileSync('human-cord-carrier-noisy.png', wrecked);
try {
  extractImage(wrecked);
} catch (e) {
  console.log('過大ノイズ(5%)       → ✗ ' + e.name + ': ' + e.message + ' (安全失敗)');
}
console.log('  劣化サンプル    : human-cord-carrier-noisy.png');

// --- ④ 媒体層と暗号層は別ドメイン: 物理を抜けても「約束」は守られる ---
console.log('\n--- ④ 媒体エラー(RS)と改ざん(AEAD)は別ドメイン ---');
const recovered = extractImage(simulateOptics(png, { occlude: 0.04, seed: 2 }));
// 物理チャネルを抜けて復元した cord の本体を 1 バイト書き換える(=改ざん)。
const tampered = JSON.parse(JSON.stringify(recovered));
// cord 構造に依らず、最初に見つかった Buffer 風フィールドを汚す。
function corruptFirstBuffer(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) {
      v.data[0] ^= 0xff;
      return true;
    }
    if (v && typeof v === 'object' && corruptFirstBuffer(v)) return true;
  }
  return false;
}
corruptFirstBuffer(tampered);
try {
  open(tampered, ISSUER);
  console.log('改ざん cord     : (検知できず — 想定外)');
} catch (e) {
  const kind = e instanceof CordTamper ? 'CordTamper' : e.name;
  console.log('改ざん cord     : ✗ ' + kind + ' ← 物理を抜けても AEAD が改ざんを検知');
}

console.log('\n結論: 実ピクセル担体の一周が閉じた。撮影劣化は RS(目)が吸収し、');
console.log('      真正性は cord(約束)が守る。役割が分かれている = 調和。');
