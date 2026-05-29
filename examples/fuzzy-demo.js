// fuzzy-demo.js — 柱4/柱7 合流「手相・虹彩から安定鍵を再生」デモ
// 実行: node examples/fuzzy-demo.js

import { gen, rep, MODALITY } from '../src/fuzzy.js';
import { seal, open } from '../src/cord.js';

// 擬似的な生体特徴ビット列(Phase 2 で実画像→特徴抽出に置換)
function feature(len, seed) {
  const out = new Uint8Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >> 16) & 1;
  }
  return out;
}
function withNoise(bits, count) {
  const out = Uint8Array.from(bits);
  for (let i = 0; i < count; i += 1) out[(i * 7) % out.length] ^= 1;
  return out;
}

console.log('=== 柱4/柱7 合流: 手相・虹彩 → 安定鍵 demo ===\n');

for (const modality of ['palm', 'iris']) {
  const len = modality === 'palm' ? 256 : 2048;
  const enroll = feature(len, modality === 'palm' ? 1 : 2); // 登録時の生体
  const { key, helper } = gen(enroll, modality);

  console.log(`--- ${MODALITY[modality].label}(${modality})---`);
  console.log('登録鍵        :', key.toString('hex').slice(0, 24) + '…');
  console.log('helper        : 生体は保存せず offset のみ(', helper.n, 'bit)');

  // 後日:少し曖昧な同一人物の生体 → 同じ鍵が再生される
  const again = withNoise(enroll, 3);
  const reKey = rep(again, helper);
  console.log('再提示(曖昧)  :', reKey.toString('hex').slice(0, 24) + '…',
    reKey.equals(key) ? '✓ 同じ鍵' : '✗ 不一致');

  // 他人の生体 → 別の鍵
  const other = rep(feature(len, 9999), helper);
  console.log('他人の生体    :', other.toString('hex').slice(0, 24) + '…',
    other.equals(key) ? '?! 一致(想定外)' : '✓ 別の鍵(他人は開けない)');

  // 生体由来の鍵で証明書を発行・再検証
  const cord = seal(`${MODALITY[modality].label}で結ぶ証明書`, key.toString('hex'), 'cert');
  console.log('証明書 open   :', open(cord, reKey.toString('hex')), '\n');
}

console.log('=== demo end ===');
