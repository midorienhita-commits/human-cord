// kdf.js
// ─────────────────────────────────────────────────────────────
// 柱1: 干支型多軸鍵生成
// ─────────────────────────────────────────────────────────────
// 公開軸(発行時刻から導出する時間多軸)× 私的軸(発行者秘密)→ コードブック。
//
// 設計原則「時計は公開、秘密だけが片割れ」:
//   時間多軸(曜日 × 時刻 × 偶奇 × エポック)は cord に平文保存し、検証側が
//   同じコードブックを再現できる。一方、発行者秘密は手元に残る片割れであり、
//   これが無ければ同じコードブックは導出できない。
//
//   コードブックは「その瞬間専用の鍵素材」であり、ratchet(柱5)と
//   通行手形(柱3)の共通の根になる。
//
// 干支メタファー: 干支(60 周期)のように、複数の循環軸の組み合わせで
//   「その時刻に固有の鍵」を作る。POC では曜日 7 × 時刻 24 × 偶奇 2 を採用。

import { hkdfSync } from 'node:crypto';

/**
 * 発行時刻から時間多軸(公開軸)を導出する。
 * @param {Date} [date]
 * @returns {{epoch:number, weekday:number, hour:number, parity:number}}
 */
export function timeAxes(date = new Date()) {
  const epoch = date.getTime();
  return {
    epoch, // ミリ秒エポック(一意性の軸)
    weekday: date.getDay(), // 0(日)〜6(土)
    hour: date.getHours(), // 0〜23
    parity: epoch % 2, // 偶奇(0/1)
  };
}

/**
 * 干支型多軸コードブックを導出する(HKDF-SHA256, 32 バイト)。
 *   ikm  = 発行者秘密(私的軸)
 *   salt = 時間多軸の連結(公開軸)
 *   info = context ラベル
 * @returns {Buffer} 32 バイトのコードブック(ratchet / tally の根)
 */
export function deriveCodebook(issuerSecret, context, axes) {
  const salt = Buffer.from(`${axes.weekday}|${axes.hour}|${axes.parity}|${axes.epoch}`);
  const info = Buffer.from(`human-cord/codebook|${context}`);
  const ikm = Buffer.from(String(issuerSecret));
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}
