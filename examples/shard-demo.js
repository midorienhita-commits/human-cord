// shard-demo.js — 柱4深化「Shamir 秘密分散による割符」のデモ
// 実行: node examples/shard-demo.js
//
// 発行者の片割れ(秘密)を 5 片に分割(閾値 3)。3 人が片を持ち寄れば証明書を開けるが、
// 2 片以下では計算能力が無限でも何も分からない(情報理論的安全)。

import { Buffer } from 'node:buffer';
import { seal, open } from '../src/cord.js';
import { split, combine } from '../src/shard.js';

const ISSUER = 'green-office-issuer-2026';
const cord = seal('データ消去証明書 CASE-2026-0042', ISSUER, 'cert');

console.log('=== 柱4深化: Shamir 秘密分散による割符 demo ===\n');

const shares = split(Buffer.from(ISSUER), 5, 3);
console.log('発行者の片割れを 5 片に分割(閾値 3)');
shares.forEach((s) => console.log(`  片#${s.x}: ${s.y.toString('hex')}`));

console.log('\n--- 3 片を持ち寄る(#2 + #3 + #5)---');
const ok = combine([shares[1], shares[2], shares[4]]).toString();
console.log('復元した秘密  :', ok);
console.log('証明書 open   :', open(cord, ok), '  ← 開けた\n');

console.log('--- 2 片だけ(#1 + #2、閾値未満)---');
const partial = combine([shares[0], shares[1]]).toString();
console.log('復元(失敗)   :', JSON.stringify(partial), '  ← 元の秘密と無関係なゴミ');
try {
  open(cord, partial);
  console.log('  ?! 開けてしまった(想定外)');
} catch {
  console.log('証明書 open   : 不能  ← 計算が無限でも 2 片では届かない(情報理論的安全)');
}

console.log('\n=== demo end ===');
