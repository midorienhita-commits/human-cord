// ecc-demo.js — 柱7 物理層の頑健化(Reed-Solomon 誤り訂正)
// 設計メモ: docs/phase2-pillar7-visual-channel.md(ECC = 物理層の頑健化)
// 実行: node examples/ecc-demo.js

import { seal } from '../src/cord.js';
import { render, renderEcc, extract, receiveVisual, FreshnessGuard } from '../src/visual.js';

const ISSUER = 'demo-issuer-secret-not-real';
const T0 = 1_717_000_000_000;
const AXES = { epoch: T0, weekday: 2, hour: 9, parity: 0 };
const BODY = 'データ消去証明書 CASE-2026-0042(ECC 頑健化デモ・複数ブロックにまたがる本文)';

const cord = seal(BODY, ISSUER, 'cert', { axes: AXES });

// 4 番目フィールド(base64 payload)の指定本数を散らして化けさせる。
function scatter(frame, count) {
  const parts = frame.split('|');
  const b = parts[3].split('');
  for (let i = 0; i < count; i++) {
    const idx = (Math.floor((i * b.length) / (count + 1)) + 5) % b.length;
    b[idx] = b[idx] === 'A' ? 'B' : 'A';
  }
  parts[3] = b.join('');
  return parts.join('|');
}

console.log('=== 柱7 物理層の頑健化(Reed-Solomon)demo ===');
console.log('原則: checksum は破損を「検知」しかできない。RS は「訂正」する(QR と同じ GF256)。\n');

const hc1 = render(cord);
const hc2 = renderEcc(cord);
console.log('HC1 担体(検知のみ): ' + hc1.length + ' 文字');
console.log('HC2 担体(RS訂正)  : ' + hc2.length + ' 文字  ← パリティ分だけ長い\n');

// --- 同じ散発ノイズを HC1 と HC2 に与えて挙動を比べる ---
const N = 14;
console.log(`--- ${N} 箇所を散発的に化けさせる ---`);

const guard1 = new FreshnessGuard({ windowMs: 60_000 });
try {
  receiveVisual(scatter(hc1, N), ISSUER, { guard: guard1, clock: T0 + 1000 });
  console.log('HC1            : 受理(まれな一致)');
} catch (e) {
  console.log('HC1            : ' + e.name + ' → 復元不能(検知のみなので訂正できない)');
}

const guard2 = new FreshnessGuard({ windowMs: 60_000 });
const recovered = receiveVisual(scatter(hc2, N), ISSUER, { guard: guard2, clock: T0 + 1000 });
console.log('HC2            : ' + recovered + '  ← RS が訂正して復元\n');

// --- HC2 でも訂正能力を超えれば安全に拒否(checksum が最後の砦)---
console.log('--- HC2: 1 ブロックに 60 文字の密集破壊(能力超過)---');
const broken = (() => {
  const parts = hc2.split('|');
  const b = parts[3].split('');
  for (let i = 0; i < 60; i++) b[10 + i] = 'A';
  parts[3] = b.join('');
  return parts.join('|');
})();
try {
  extract(broken);
  console.log('結果           : 受理(想定外)');
} catch (e) {
  console.log('結果           : ' + e.name + ' → 訂正不能を安全に拒否(誤った復元を主張しない)');
}

console.log('\n注: 担体は payload を保護する。本体の改ざんは RS では消えず、AEAD(柱9)で割れる。');
console.log('    実ピクセル/QR への載せ替え・音響担体への適用は継続課題。');
console.log('=== demo end ===');
