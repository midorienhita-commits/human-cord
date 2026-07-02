// examples/simmons-demo.js
// ─────────────────────────────────────────────────────────────
// 柱6-ii: 真の Simmons 潜在チャネル — 署名の nonce に裏メッセージを埋める
// ─────────────────────────────────────────────────────────────
// 既存 demo:subliminal(subliminal.js)は cord に **別フィールド**を足す付帯 AEAD で、
// 厳密には潜在チャネルではない。こちらは Simmons の原典: 裏メッセージを **署名の乱数自由度(nonce)**に
// 埋め、別フィールドを一切持たない。看守(公開鍵だけ)には普通の署名にしか見えず、鍵保持者だけが読む。
//
//   npm run demo:simmons

import {
  generateGroup,
  generateSigningKey,
  signSalted,
  verify,
  signWithSubliminal,
  recoverSubliminal,
  subliminalCapacityBytes,
} from '../src/simmons.js';

const line = (s = '') => console.log(s);

line('■ 発行者が DSA 鍵対(素数体群・threshold.js 再利用)と、別の「潜在鍵 subKey」を持つ');
const group = generateGroup(512); // デモ用 512bit(本番は >=2048bit)
const { x, y } = generateSigningKey(group);
const subKey = Buffer.from('5f09b90642412c83192474c4b45d7faebc92522f55331a617c8c99a22f19b2ce', 'hex');
line(`  公開鍵 y を配布。potency: 1 署名あたり covert 容量 = ${subliminalCapacityBytes(group.q)} byte`);
line('');

const publicText = 'CERT-2026-0042 データ消去 4台 / サンプル社発行';
const covert = 'AUDIT:本社のみ';

// ① 潜在署名: 表の本文に署名しつつ、裏メッセージを nonce に埋める
line('① 発行者: 表の証明書本文に署名(裏メッセージを nonce に隠す)');
const { message, sig } = signWithSubliminal(group, x, publicText, covert, subKey);
line(`   表本文: ${message}`);
line(`   署名: (r,s) — 追加フィールドは無い。普通の DSA 署名と見分けがつかない`);
line('');

// ② 看守(公開鍵だけ)= 普通の署名として検証が通る。裏があるとは気づけない
line('② 看守(公開鍵 y のみ・潜在鍵なし): 公開検証する');
line(`   verify(y) = ${verify(group, y, message, sig)}  ✅ 正規署名。潜在チャネルの存在は検出できない`);
line('');

// ③ 裏なし cover 署名(signSalted)と並べても区別がつかない(看守視点)
const cover = signSalted(group, x, publicText);
line('③ 同じ鍵の「裏なし cover 署名」(signSalted)と並べても、看守には区別できない');
line(`   cover 本文も ...|salt=<hex> 形式 → covert と同形式。本文の形では裏の有無が分からない`);
line(`   cover verify = ${verify(group, y, cover.message, cover.sig)}(nonce 一様・本文形式も同一)`);
line('');

// ④ 鍵保持者(x + subKey を共有)だけが裏を読む
line('④ 受信者(署名鍵 x + 潜在鍵 subKey を共有): nonce を復元して裏を読む');
line(`   recoverSubliminal = ${JSON.stringify(recoverSubliminal(group, x, message, sig, subKey))}  ← 発行者だけの裏メッセージ`);
line('');

// ⑤ 鍵が違えば読めない
line('⑤ 潜在鍵が違う者は読めない(MAC が弾く)');
line(`   wrong subKey → ${JSON.stringify(recoverSubliminal(group, x, message, sig, Buffer.alloc(32, 1)))}`);
line('');

line('──────────────────────────────────────────────');
line('真の潜在チャネル: 裏は署名の nonce に住み、別フィールドが無い → 看守には普通の署名にしか見えない。');
line('正直な限界: これは broadband 版=受信者は署名鍵 x を共有する(=受信者も発行者として署名できる)。');
line('  署名鍵を渡さない narrowband(少ビット・別鍵)は将来。nonce 再利用は x を漏らすので salt は毎回新規。');
line('監査文脈では潜在チャネル自体が警戒対象 → 既定 OFF・標準コアから隔離(層IV)。便利だから載せるものではない。');
