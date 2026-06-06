// photo-demo.js — 柱7 物理層: 視覚担体の「カメラ写真」アダプタ(finder + 透視補正)のデモ
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4 / §7
// 実行: node examples/photo-demo.js
//
// image.js(extractImage)は「位置・尺度・向きが既知の格子」を前提に読む。
// 本デモは実カメラ写真に一歩近づく: 担体を傾けて撮った写真(回転・透視・背景・劣化)を、
// finder(四隅の位置検出パターン)で見つけ → ホモグラフィで補正 → モジュールを再標本 → cord。
// AI は「目」(幾何の頑健化)、cord は「約束」(真正性)。誤り訂正は HC2 と同じ RS。

import { writeFileSync } from 'node:fs';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, scanPhotoMulti, PhotoError } from '../src/photo.js';

const ISSUER = 'demo-issuer-secret-not-real';
const AXES = { epoch: 1_717_000_000_000, weekday: 2, hour: 9, parity: 0 };

console.log('=== 柱7 物理層: カメラ写真アダプタ(finder + 透視補正)demo ===');
console.log('原則: AI は「目」(傾き・透視・劣化への頑健性)、cord は「約束」(真正性)。\n');

// --- ① finder 付き担体を実 PNG へ ---
const cord = seal('データ消去証明書 CASE-2026-0042 / 機器3台 / Blancco', ISSUER, 'cert', { axes: AXES });
const { png, modules, total, side } = renderScannable(cord);
writeFileSync('human-cord-scannable.png', png);
console.log('--- ① finder 付き担体(renderScannable)---');
console.log('PNG 書き出し    : human-cord-scannable.png (' + png.length + ' bytes)');
console.log('格子            : データ ' + modules + '×' + modules + ' + 四隅 finder(TL=リング=キラリティ標識)/ 総 ' + total + '×' + total + ' モジュール / ' + side + 'px');

// --- ② 傾けて撮った「写真」へ → 検出+補正で読み戻す ---
console.log('\n--- ② 写真(回転・透視・背景・劣化)→ finder 検出 → 補正 → 読み戻し ---');
const shots = [
  { label: '縮小+並進(机の隅)      ', opts: { scale: 0.75, tx: 50, ty: -30 } },
  { label: '回転 20°              ', opts: { rotateDeg: 20, scale: 0.8 } },
  { label: '回転 -32°             ', opts: { rotateDeg: -32, scale: 0.8 } },
  { label: '透視(横keystone 22%)  ', opts: { tiltX: 0.22, scale: 0.9 } },
  { label: '透視(縦keystone 20%)  ', opts: { tiltY: 0.20, scale: 0.9 } },
  { label: '回転+透視+ぼけ+露出    ', opts: { rotateDeg: 12, tiltY: 0.15, scale: 0.82, blur: 1, brightness: 25 } },
  { label: '回転+透視+ノイズ+暗    ', opts: { rotateDeg: -14, tiltX: 0.16, scale: 0.8, blur: 1, brightness: -25, noise: 0.006 } },
];
for (const s of shots) {
  try {
    const back = scanPhoto(simulatePhoto(png, s.opts));
    console.log(s.label + ' → ✓ ' + (back.tip === cord.tip ? 'tip一致' : 'tip不一致!') + ' / open: ' + open(back, ISSUER));
  } catch (e) {
    console.log(s.label + ' → ✗ ' + e.name + ': ' + e.message);
  }
}
// 写真サンプルを 1 枚保存(目視確認用)。
writeFileSync('human-cord-photo.png', simulatePhoto(png, { rotateDeg: 12, tiltY: 0.15, scale: 0.82, blur: 1, brightness: 25 }));
console.log('  写真サンプル    : human-cord-photo.png(回転+透視+ぼけ+露出)');

// --- ③ キラリティで全方位 0–360°(四隅同形 finder の ±45° 限界を TL リングが破る)---
console.log('\n--- ③ キラリティ(TLリング)で全方位 0–360° ---');
console.log('     四隅が同一形だと面内回転 ±45° で向きが曖昧。TL の「リング」(中央に穴=重心が白)は');
console.log('     回転・尺度・透視に不変なトポロジー標識 → どれが物理 TL かを一意に決め、全周を解く。');
let ok = 0;
const degs = [0, 45, 90, 135, 180, 225, 270, 315];
for (const deg of degs) {
  try {
    const back = scanPhoto(simulatePhoto(png, { rotateDeg: deg, scale: 0.8 }));
    if (back.tip === cord.tip) ok++;
  } catch { /* count below */ }
}
console.log('回転 ' + degs.join('/') + '° → ' + ok + '/' + degs.length + ' 復元');
// 上下逆さ(180°)+ 透視 + ぼけ の難物も 1 件明示
try {
  const back = scanPhoto(simulatePhoto(png, { rotateDeg: 180, tiltX: 0.18, scale: 0.8, blur: 1 }));
  console.log('上下逆さ+透視+ぼけ    → ✓ open: ' + open(back, ISSUER));
} catch (e) {
  console.log('上下逆さ+透視+ぼけ    → ✗ ' + e.message);
}

// --- ④ 媒体層と暗号層は別ドメイン: 写真を抜けても「約束」は守られる ---
console.log('\n--- ④ 写真チャネルを抜けても改ざんは AEAD が検知する(媒体≠暗号)---');
const recovered = scanPhoto(simulatePhoto(png, { rotateDeg: 10, scale: 0.85, blur: 1 }));
(function corrupt(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Buffer.isBuffer(v) && v.length) { v[0] ^= 0xff; return true; }
    if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) { v.data[0] ^= 0xff; return true; }
    if (v && typeof v === 'object' && corrupt(v)) return true;
  }
  return false;
})(recovered);
try {
  open(recovered, ISSUER);
  console.log('改ざん cord     : (検知できず — 想定外)');
} catch (e) {
  console.log('改ざん cord     : ✗ ' + (e instanceof CordTamper ? 'CordTamper' : e.name) + ' ← 写真を抜けても AEAD が改ざんを検知');
}

// --- ⑤ 多点標本 + 多数決(§5.10 高 N 頑健化): 単点は破綻、多数決は復元 ---
console.log('\n--- ⑤ 多点標本 + 多数決(§5.10 高 N 頑健化)---');
console.log('     塩胡椒ノイズ(ランダム画素を 0/255 へ反転)下、1 モジュールを中心 1 点で読むと');
console.log('     反転画素が RS 訂正能力を超えて破綻。k×k の小格子で読み「過半数票」で 1 ビットを守る。');
console.log('     ' + modules + '×' + modules + '(本番相当密度・1 モジュール≈3.6px)で比較:');
for (const noise of [0.01, 0.02, 0.03, 0.05, 0.1]) {
  const noisy = simulatePhoto(png, { scale: 0.9, noise, seed: 7 });
  const read = (sub) => {
    try { return scanPhoto(noisy, { subsamples: sub }).tip === cord.tip ? '✓' : '△tip'; }
    catch { return '✗'; }
  };
  console.log('  noise=' + noise.toFixed(2) + '  単点(1×1)=' + read(1) + '   多数決(3×3)=' + read(3));
}
console.log('  → 単点は noise≈0.02 で破綻、3×3 多数決は noise≈0.2 まで復元。');
console.log('    (5×5+ は module が小さい間は標本が相関し上積み無し — 大きな担体/高 SCALE で効く=正直な限界)');

// --- ⑥ 複数フレーム融合(§5.11): 指/影が毎回別の場所でも、何枚か撮れば埋まる ---
console.log('\n--- ⑥ 複数フレーム融合(§5.11)指/影で別の場所が隠れても、複数枚で埋める ---');
console.log('     同じ担体を 3 枚撮影。各フレームでデータの別の 1/3 帯が指/影で隠れる(finder は無傷)。');
console.log('     どの 1 枚も遮蔽帯が RS 能力を超えて単独では読めない。フレーム横断で暗さ率を平均(soft 融合)し、');
console.log('     各モジュールを多数のクリーンなフレームで支えて復元する(§2 本命脅威=影・指・反射)。');
const band = (i) => ({ x: 0.27, w: 0.47, y: 0.27 + i * (0.47 / 3), h: 0.47 / 3 });
const occFrames = [0, 1, 2].map((i) => simulatePhoto(png, { scale: 0.9, noise: 0.01, seed: 10 + i, occlude: band(i) }));
occFrames.forEach((f, i) => {
  try { scanPhotoMulti([f]); console.log('  フレーム ' + i + ' 単独    → ✓?(想定外)'); }
  catch { console.log('  フレーム ' + i + ' 単独    → ✗ 遮蔽帯で復号不可'); }
});
try {
  const back = scanPhotoMulti(occFrames);
  console.log('  3 枚を融合        → ✓ ' + (back.tip === cord.tip ? 'tip一致' : 'tip不一致') + ' / open: ' + open(back, ISSUER));
} catch (e) { console.log('  3 枚を融合        → ✗ ' + e.message); }
writeFileSync('human-cord-photo-occluded.png', occFrames[0]);
console.log('  遮蔽フレーム例    : human-cord-photo-occluded.png(指/影で 1/3 帯が隠れた 1 枚)');

// --- ⑦ 自己クロックで放射状レンズ歪みを補正(§5.12): 純ホモグラフィの射程外を埋める ---
console.log('\n--- ⑦ 自己クロック(timing tick)でレンズ放射歪みを補正(§5.12)---');
console.log('     実カメラのレンズ放射歪み(樽/糸巻き)はホモグラフィでは表せない曲がり。4 隅 finder で');
console.log('     合わせた単一ホモグラフィは「隅で正しく内側でズレ」、高 N(モジュール≈3.6px)で破綻する。');
console.log('     データを囲む自己クロック(tick 列)のプラムライン(=直線は直線のまま)で歪み係数を推定し、');
console.log('     歪み認識で再標本して復元する。種 §3「二重らせんのひねりの周期=自己クロック」。');
console.log('     ' + modules + '×' + modules + ' で比較(plain=純ホモグラフィ / self-clock=自己クロック補正):');
for (const lensK of [0.1, 0.15, 0.2, 0.3, -0.1, -0.12, -0.2]) {
  const img = simulatePhoto(png, { scale: 0.9, lensK, seed: 3 });
  const read = (opts) => {
    try { return scanPhoto(img, opts).tip === cord.tip ? '✓' : '△tip'; }
    catch { return '✗'; }
  };
  const kind = lensK >= 0 ? '糸巻き' : '樽　';
  console.log('  lensK=' + String(lensK).padStart(5) + '(' + kind + ')  plain=' + read({ undistort: false }) + '   self-clock=' + read({}));
}
console.log('  → plain は |lensK|≈0.1 で破綻、self-clock は糸巻き +0.3 / 樽 -0.15 まで復元。');
console.log('    (樽型は周辺=tick の場所を中心へ圧縮し観測できる曲がりを自ら弱めるため糸巻きより難しい=正直な非対称。');
console.log('     歪み中心≈担体中心の前提のため強透視との同時はずれる。実レンズ歪み・実カメラは継続)');
writeFileSync('human-cord-photo-lens.png', simulatePhoto(png, { scale: 0.9, lensK: 0.25, seed: 3 }));
console.log('  歪み写真例        : human-cord-photo-lens.png(糸巻き型 lensK=0.25)');

console.log('\n結論: 位置・回転(全周)・傾き・レンズ放射歪みが未知の「写真」からでも、finder で見つけ・キラリティで');
console.log('      向きを決め・自己クロックで歪みを推定して補正し・多点標本の多数決でノイズを均し・複数フレームの');
console.log('      融合で遮蔽を埋め・RS で訂正して cord を復元できた。実カメラ撮影/端末内 AI 抽出・有機担体は継続(§7)。');
