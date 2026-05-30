// pubkey-demo.js — 柱4 公開鍵検証層(Ed25519)のデモ
// 「発行者の公開鍵だけで、誰でもオフラインで真贋検証(秘密不要)」を示す。
// 実行: node examples/pubkey-demo.js

import { generateIssuerKeypair, signStatement, verifyStatement } from '../src/pubkey.js';

const j = (o) => JSON.stringify(o);
console.log('=== 柱4 公開鍵検証層(Ed25519)demo ===');
console.log('対称コア(発行者媒介)の相補: 公開してよい事実を発行者が署名 →');
console.log('誰でも公開鍵だけでオフライン検証(秘密は不要)。\n');

// 発行者(信頼境界=サーバ)で鍵対を生成。秘密鍵は手元、公開鍵は配布。
const { privateKey, publicKey } = generateIssuerKeypair();
console.log('発行者公開鍵   :', publicKey.split('\n')[1].slice(0, 32), '…(配布してよい)\n');

// 公開してよい本質事実(顧客個人情報は載せない)
const facts = { docId: 'CASE-2026-0042', kind: 4, devices: 12, method: 'Blancco', site: 'LOG' };
const signed = signStatement(facts, privateKey, { docId: facts.docId, issuedAt: '2026-05-30' });
console.log('署名付き証明   :', j({ ...signed, sig: signed.sig.slice(0, 24) + '…' }), '\n');

// --- 検証は公開鍵だけ(秘密鍵を一切使わない=オフライン第三者検証)---
console.log('--- 顧客/監査人(公開鍵のみ)---');
console.log('正規           :', j(verifyStatement(signed, publicKey)));

// 別発行者の公開鍵では通らない
const other = generateIssuerKeypair();
console.log('別発行者の鍵   :', j(verifyStatement(signed, other.publicKey)));

// 事実を改ざんすると通らない
const tampered = { ...signed, facts: { ...facts, devices: 9999 } };
console.log('事実を改ざん   :', j(verifyStatement(tampered, publicKey)));

console.log('\n注: 本層は「公開してよい事実」を署名する。隠したい本体は柱9 卵 + 柱6 潜在チャネル(issue/verify)。');
console.log('    用途で使い分け: 公開証明書=本層 / 発行者だけが読む控え=対称コア。');
console.log('=== demo end ===');
