// ratchet.js
// ─────────────────────────────────────────────────────────────
// 柱5: 生きた演算子(stateful ratchet)— カエルの卵の「動く核」
// ─────────────────────────────────────────────────────────────
// next() を呼ぶたびに内部状態(state)が一方向に進み、卵ごとに異なる鍵を
// 生成する。同じ平文・同じ発行者秘密でも、卵の位置が違えば鍵が違うため、
// リプレイ攻撃が無効化され、固定パターンを機械学習で抽出できない。
//
// 一方向性(forward secrecy 風):
//   現在の state が漏れても、過去に払い出した鍵は HMAC の逆算不能性により
//   復元できない。これは 柱10「割れても核(現在状態)は出ない」の基盤。

import { createHash, createHmac } from 'node:crypto';

const KEY_LABEL = Buffer.from('human-cord/key');
const STEP_LABEL = Buffer.from('human-cord/ratchet');

export class Ratchet {
  /** @param {string|Buffer} seed 発行者秘密 + 文脈から導出されたシード */
  constructor(seed) {
    this.state = createHash('sha256').update(seed).digest();
    this.counter = 0;
  }

  /** 次の 32 バイト鍵(AES-256 用)を払い出し、内部状態を 1 段進める。 */
  next() {
    const key = createHmac('sha256', this.state).update(KEY_LABEL).digest();
    this.state = createHmac('sha256', this.state).update(STEP_LABEL).digest();
    this.counter += 1;
    return key;
  }
}
