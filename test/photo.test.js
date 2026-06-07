// photo.test.js
// 柱7「視覚担体のカメラ写真アダプタ(finder + 透視補正)」の振る舞い検証。
// 設計メモ: docs/phase2-pillar7-visual-channel.md §5.4 / §7
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';
import { renderScannable, simulatePhoto, scanPhoto, scanPhotoMulti, PhotoError } from '../src/photo.js';
import { encodePng } from '../src/image.js';

const SECRET = 'issuer-private-half-xyz';
const AXES = { epoch: 1_000_000, weekday: 3, hour: 10, parity: 0 };
const TEXT = 'CERT-2026-0603 / 機器3台 / Blancco 完全消去';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function freshCord(text = TEXT, ctx = 'photo') {
  return seal(text, SECRET, ctx, { axes: AXES });
}
function shoot(cord, opts) {
  const { png } = renderScannable(cord);
  return scanPhoto(simulatePhoto(png, opts));
}

// ① finder 付き担体 ─────────────────────────────────────────────

test('柱7 photo: renderScannable は finder 付き実 PNG を出す', () => {
  const { png, modules, total, side } = renderScannable(freshCord());
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  assert.ok(modules > 0);
  assert.equal(total, modules + 18); // データ + 四辺 BORDER(=FINDER7+GAP2=9)×2
  assert.equal(side, (total + 8) * 4); // + 静寂帯(QUIET=4)×2, SCALE=4
});

// ② 写真(回転・透視・劣化)からの復元 ───────────────────────────

test('柱7 photo: 縮小+並進した写真を finder 検出+補正で復元する', () => {
  const cord = freshCord();
  const back = shoot(cord, { scale: 0.75, tx: 50, ty: -30 });
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: キラリティ(TLリング)で全方位 0–360° の回転を復元する', () => {
  // 四隅同形 finder の ±45° 限界を、TL のリング(重心が白=回転不変なトポロジー特徴)で破る。
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const cord = freshCord();
    assert.equal(open(shoot(cord, { rotateDeg: deg, scale: 0.8 }), SECRET), TEXT, `rot ${deg}`);
  }
});

test('柱7 photo: 透視(keystone 横22%/縦20%)をホモグラフィ補正して復元する', () => {
  const cord = freshCord();
  assert.equal(open(shoot(cord, { tiltX: 0.22, scale: 0.9 }), SECRET), TEXT);
  assert.equal(open(shoot(cord, { tiltY: 0.20, scale: 0.9 }), SECRET), TEXT);
});

test('柱7 photo: 回転+透視+ぼけ+露出ずれ+ノイズの複合写真でも復元する', () => {
  const cord = freshCord();
  const back = shoot(cord, { rotateDeg: -14, tiltX: 0.16, scale: 0.8, blur: 1, brightness: -25, noise: 0.006 });
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: 高 N + 塩胡椒ノイズ — 単点標本は破綻し多数決(既定3×3)は同じ写真を復元する', () => {
  // N=136(本番相当密度・1 モジュール ≈ 3.6px)。simulatePhoto の noise はランダム画素を 0/255 へ反転(塩胡椒)。
  // 中心 1 点標本(subsamples:1)はノイズ余裕が無く、反転画素が RS 訂正能力を超えて PhotoError。
  // k×k 多数決(既定 3×3)はモジュールごと過半数票で 1 ビットを守り、同一画像から復元する(§5.10)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const noisy = simulatePhoto(png, { scale: 0.9, noise: 0.03, seed: 7 }); // seed 固定 = 決定的
  assert.throws(() => scanPhoto(noisy, { subsamples: 1 }), PhotoError); // 単点は破綻
  const back = scanPhoto(noisy); // 既定 3×3 多数決 = 同じ画像から復元
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

// ③ 媒体層と暗号層は別ドメイン ──────────────────────────────────

test('柱7 photo: 写真チャネルを抜けても改ざんは AEAD が検知する', () => {
  const cord = freshCord();
  const recovered = shoot(cord, { rotateDeg: 10, scale: 0.85, blur: 1 });
  let corrupted = false;
  (function corrupt(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Buffer.isBuffer(v) && v.length) { v[0] ^= 0xff; corrupted = true; return; }
      if (v && v.type === 'Buffer' && Array.isArray(v.data) && v.data.length) { v.data[0] ^= 0xff; corrupted = true; return; }
      if (v && typeof v === 'object') { corrupt(v); if (corrupted) return; }
    }
  })(recovered);
  assert.ok(corrupted);
  assert.throws(() => open(recovered, SECRET), CordTamper);
});

test('柱7 photo: 全方位回転 + 透視 + 劣化の複合でも復元する', () => {
  const cord = freshCord();
  for (const opts of [
    { rotateDeg: 135, tiltY: 0.18, scale: 0.8, noise: 0.005 },
    { rotateDeg: 250, tiltX: 0.2, scale: 0.78, blur: 1, brightness: -20 },
  ]) {
    assert.equal(open(shoot(cord, opts), SECRET), TEXT, JSON.stringify(opts));
  }
});

// ④ 安全な失敗 ──────────────────────────────────────────────────

test('柱7 photo: finder を見つけられない画像は安全に失敗する(PhotoError)', () => {
  // 一様グレー(finder の無い)画像。連結成分が finder 条件を満たさず PhotoError。
  const blank = encodePng(Buffer.alloc(200 * 200, 200), 200, 200);
  assert.throws(() => scanPhoto(blank), PhotoError);
});

test('柱7 photo: finder の無い画像/PNG でないものは安全に失敗する', () => {
  assert.throws(() => scanPhoto(Buffer.from('not a png')), Error); // ImageCarrierError(PNG不正)
});

// ⑤ シミュレーションの決定性 ────────────────────────────────────

test('柱7 photo: simulatePhoto は seed が同じなら同一画像(決定的)', () => {
  const { png } = renderScannable(freshCord());
  const a = simulatePhoto(png, { rotateDeg: 10, noise: 0.02, seed: 5 });
  const b = simulatePhoto(png, { rotateDeg: 10, noise: 0.02, seed: 5 });
  assert.ok(a.equals(b));
});

// ⑥ 複数フレーム融合(§5.11)──────────────────────────────────────

test('柱7 photo: 遮蔽 — 各フレームで別の場所が隠れても複数フレーム融合で復元する', () => {
  // 同じ担体を 3 枚撮影。各フレームでデータ領域の別の 1/3 帯が指/影で隠れる(finder は無傷)。
  // どの 1 枚も遮蔽帯が RS 訂正能力を超えて単独復号は全滅。フレーム横断で暗さ率を平均(soft 融合)すると
  // 各モジュールは 2/3 のクリーンなフレームに支えられて埋まり、復元する(§2 本命脅威=影・指・反射)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const band = (i) => ({ x: 0.27, w: 0.47, y: 0.27 + i * (0.47 / 3), h: 0.47 / 3 });
  const frames = [0, 1, 2].map((i) => simulatePhoto(png, { scale: 0.9, noise: 0.01, seed: 10 + i, occlude: band(i) }));
  // 同じ融合経路で 1 枚 vs 3 枚を比較(フレーム数だけが違う = 救ったのは融合だと示せる)。
  assert.throws(() => scanPhotoMulti([frames[1]]), PhotoError); // 1 枚だけでは遮蔽帯が RS 能力超過で復号不可
  const back = scanPhotoMulti(frames); // 3 枚融合で復元
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: 強ノイズ — 単フレームは全滅でも独立ノイズの複数フレーム融合で復元する', () => {
  // noise=0.25(塩胡椒)では 3×3 多数決でも単フレームは破綻(§5.10 の天井超)。独立ノイズの 3 フレームを
  // soft 融合すると、フレーム平均がノイズを均して復元する(フレーム内多数決 §5.10 の時間方向拡張)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const frames = [0, 1, 2].map((i) => simulatePhoto(png, { scale: 0.9, noise: 0.25, seed: 20 + i }));
  assert.throws(() => scanPhotoMulti([frames[0]]), PhotoError); // 1 枚だけでは 3×3 多数決でも破綻
  const back = scanPhotoMulti(frames);
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: scanPhotoMulti は 1 枚なら単フレームと等価 / 空配列は安全に失敗する', () => {
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const one = simulatePhoto(png, { scale: 0.85, rotateDeg: 10 });
  assert.equal(open(scanPhotoMulti([one]), SECRET), TEXT); // 1 枚 = 単フレーム soft 復号
  assert.throws(() => scanPhotoMulti([]), PhotoError);     // 空配列は安全に失敗
});

// ⑦ 自己クロックでレンズ放射歪みを補正(§5.12)──────────────────────
// 実カメラのレンズ放射歪み(樽/糸巻き)はホモグラフィでは表せない曲がり。4 隅 finder で合わせた
// 単一ホモグラフィは「隅で正しく内側でズレ」、高 N(モジュール≈3.6px)では復号が破綻する。
// データを囲む自己クロック(timing tick 列)のプラムライン(=直線は直線のまま)で歪み係数を推定し、
// 歪み認識で再標本して復元する。役割分担は不変=これは「目」。AEAD/発行者検査は独立に効く。

test('柱7 photo: 糸巻き型レンズ歪み — 純ホモグラフィは破綻し自己クロック補正は復元する', () => {
  // N=136(本番相当・モジュール≈3.6px)。lensK=0.2 の放射状歪みは透視補正の射程外(曲がり)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const img = simulatePhoto(png, { scale: 0.9, lensK: 0.2, seed: 3 });
  assert.throws(() => scanPhoto(img, { undistort: false }), PhotoError); // 補正なし(純ホモグラフィ)は破綻
  const back = scanPhoto(img); // 既定 = 自己クロック補正で復元
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: 樽型レンズ歪み(負)も自己クロック補正で復元する', () => {
  // 樽型は周辺(tick のある場所)を中心へ圧縮し観測できる曲がりを自ら弱めるため糸巻きより難しい
  //(正直な非対称)。それでも純ホモグラフィが破綻する帯で補正が復元する(plain 破綻の実証は上の
  // 糸巻き型テストで済むので、ここは補正成功のみを確認=失敗側のブルートフォース総当たりを省き高速化)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const img = simulatePhoto(png, { scale: 0.9, lensK: -0.12, seed: 3 });
  const back = scanPhoto(img);
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});

test('柱7 photo: レンズ歪み + 全方位回転(キラリティと合成)でも補正で復元する', () => {
  // 自己クロック補正は「目」の幾何処理。リング(キラリティ)で向きを決める層と独立に重なる。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const img = simulatePhoto(png, { scale: 0.85, lensK: 0.2, rotateDeg: 30, seed: 2 });
  assert.equal(open(scanPhoto(img), SECRET), TEXT);
});

test('柱7 photo: 自己クロック補正は純粋なフォールバック — 歪み無しの写真は従来通り読める', () => {
  // ticks を足しても通常(歪み無し)の経路は不変。{undistort:false}(補正を切る)でも歪み無しは読める
  // = 補正は plain 失敗時だけ働く後段で、既存挙動を変えない。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const clean = simulatePhoto(png, { scale: 0.85, rotateDeg: 12, blur: 1 }); // lensK 無し
  assert.equal(open(scanPhoto(clean, { undistort: false }), SECRET), TEXT); // 純ホモグラフィで読める
  assert.equal(open(scanPhoto(clean), SECRET), TEXT);                       // 既定でも同じ
});

// ⑧ 融合 × レンズ歪み(§5.14)──────────────────────────────────────
// §5.13 で判明した穴: scanPhotoMulti は §5.12 の歪み補正を持たず、レンズ歪み下では単フレームが
// 読める所でも融合が全滅した(plain ホモグラフィで重ねるとフレームごとの歪みが食い違う)。
// 各フレームを scanDistorted と同じ式(lensDistort∘H)で整流してから soft 融合する修正で塞ぐ。

test('柱7 photo: 融合がレンズ歪みに対応 — 各フレームを歪み認識で整流してから soft 融合する', () => {
  // 横帯遮蔽(各フレーム別の 1/3 帯=融合が必要)に糸巻きレンズ歪みを重ねる。どの 1 枚も遮蔽帯で
  // 単独復号は不可(融合が要る)。歪み認識の融合で復元する(旧=純ホモグラフィ融合は同条件で全滅)。
  const cord = freshCord();
  const { png } = renderScannable(cord);
  const band = (i) => ({ x: 0.27, w: 0.47, y: 0.27 + i * (0.47 / 3), h: 0.47 / 3 });
  const frames = [0, 1, 2].map((i) => simulatePhoto(png, { scale: 0.9, noise: 0.01, lensK: 0.15, seed: 10 + i, occlude: band(i) }));
  assert.throws(() => scanPhotoMulti([frames[1]]), PhotoError); // 1 枚は遮蔽帯で復号不可
  const back = scanPhotoMulti(frames);
  assert.equal(back.tip, cord.tip);
  assert.equal(open(back, SECRET), TEXT);
});
