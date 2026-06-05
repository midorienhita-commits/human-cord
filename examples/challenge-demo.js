// challenge-demo.js — 柱5/9 対話チャレンジ応答 liveness のデモ
// 設計メモ: src/challenge.js(livecord.js の「正直な限界」を閉じる厳密版)。
// 実行: node examples/challenge-demo.js
//
// livecord(非対話のフレーム鎖)は「連続・順序・単調・有限・鮮度」までで、
// 「鮮度窓内・別の検証者への即時リプレイ」は原理的に防げないと明言していた。
// 本デモは、検証者がその場で出す nonce を応答に暗号的に束縛することで、その穴を閉じる。

import { respond, ChallengeVerifier } from '../src/challenge.js';

const ISSUER = 'demo-issuer-secret-not-real';
const SITE = 'site-tokyo';
const T0 = 1_717_000_000_000; // チャレンジ発行時刻(ms)

console.log('=== 柱5/9 対話チャレンジ応答 liveness demo ===');
console.log('原則: 検証者の nonce を応答に束縛 →「秘密保持者が・私のチャレンジに・いま」応えた証明。\n');

// --- ① 正規フロー ---
console.log('--- ① 正規フロー(検証者A チャレンジ → 証明者 応答 → A 検証)---');
const A = new ChallengeVerifier(ISSUER, SITE);
const chA = A.issue(T0);
console.log('A チャレンジ発行  : nonce=' + chA.nonce.slice(0, 12) + '…(その場限り・公開してよい)');
const res = respond(chA, '東京第二DC 在席', ISSUER, SITE, { clock: T0 + 200 });
console.log('証明者 応答(seal): context に nonce を畳み込み(' + res.context.slice(0, 24) + '…)');
const v1 = A.verify(res, T0 + 400);
console.log('A 検証            : ' + v1.verdict + ' / msg="' + v1.msg + '"  ← いま生きている');

// --- ② 別の検証者への即時リプレイ(本モジュールの主眼)---
console.log('\n--- ② 別の検証者Bへ録画を即時リプレイ → mismatch ---');
console.log('     攻撃者が A への正規応答をそのまま B に流す。B は自分の nonce_B を出しているので、');
console.log('     A の nonce に束縛された応答は「B が出していないチャレンジ」として弾かれる。');
const A2 = new ChallengeVerifier(ISSUER, SITE);
const B = new ChallengeVerifier(ISSUER, SITE);
const chA2 = A2.issue(T0);
const res2 = respond(chA2, '在席', ISSUER, SITE, { clock: T0 + 100 });
B.issue(T0); // B も自分のチャレンジを出している(別 nonce)
console.log('B 検証(リプレイ): ' + B.verify(res2, T0 + 200).verdict + ' ← 別検証者へのリプレイを拒否');
console.log('A 検証(本人)    : ' + A2.verify(res2, T0 + 200).verdict + ' ← 束縛先が一致する本人だけ live');

// --- ③ 厳密リプレイ・チャレンジ一回限り ---
console.log('\n--- ③ 厳密リプレイ / チャレンジ一回限り ---');
const C = new ChallengeVerifier(ISSUER, SITE);
const chC = C.issue(T0);
const resC1 = respond(chC, '在席', ISSUER, SITE, { clock: T0 + 100 });
console.log('1 回目            : ' + C.verify(resC1, T0 + 150).verdict + '(受理 → nonce 消費・tip seen)');
console.log('同一応答 再提示   : ' + C.verify(resC1, T0 + 160).verdict + '(同じ tip)');
const resC2 = respond(chC, '在席', ISSUER, SITE, { clock: T0 + 200 });
console.log('同チャレンジ別応答: ' + C.verify(resC2, T0 + 250).verdict + '(チャレンジは消費済 = 一回限り)');

// --- ④ 鮮度(後日再生)---
console.log('\n--- ④ 鮮度: 窓外の応答は stale(後日再生を弾く)---');
const D = new ChallengeVerifier(ISSUER, SITE, { windowMs: 1000 });
const chD = D.issue(T0);
const resD = respond(chD, '在席', ISSUER, SITE, { clock: T0 + 100 });
console.log('5 秒後に受信      : ' + D.verify(resD, T0 + 100 + 5000).verdict);

// --- ⑤ 真正性(媒体≠暗号)---
console.log('\n--- ⑤ 真正性: 束縛 context を保っても中身改ざん/別秘密は tamper ---');
const E = new ChallengeVerifier(ISSUER, SITE);
const chE = E.issue(T0);
const resE = respond(chE, '在席', ISSUER, SITE, { clock: T0 + 100 });
resE.eggs[0].ct[0] ^= 0xff; // 暗号文を 1 バイト反転(束縛 context はそのまま)
console.log('中身改ざん        : ' + E.verify(resE, T0 + 150).verdict);
const E2 = new ChallengeVerifier(ISSUER, SITE);
const chE2 = E2.issue(T0);
const resWrong = respond(chE2, '在席', 'wrong-issuer-secret', SITE, { clock: T0 + 100 });
console.log('別の発行者秘密    : ' + E2.verify(resWrong, T0 + 150).verdict);

console.log('\n結論: livecord(非対話)が残した「別検証者への即時リプレイ」を、検証者 nonce の対話束縛で閉じた。');
console.log('      正直な限界: 実時間の中継(MITM relay)/距離詐称は暗号単独では防げない(距離限定=往復遅延');
console.log('      の物理計測の領分)。保証は「秘密保持者が・私のチャレンジに・鮮度内で応答した」ことまで。');
