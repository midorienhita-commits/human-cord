// smoke.js
// ─────────────────────────────────────────────────────────────
// 柱8: 能動的発火応答(active tamper response)= 煙
// ─────────────────────────────────────────────────────────────
// 「火のないところに煙は立たぬ」の逆実装:
//   火(改ざん・不正)があれば、煙(証拠ログ)が必ず立つ。
//
// 煙の 4 機能:
//   可視性     … append-only ログに残り、誰でも見える
//   即時性     … 検知と同時に raise
//   不可逆性   … ハッシュチェーンで遡及改ざん不能(Certificate Transparency 型)
//   広範囲伝達 … ログは共有・ブロードキャストされる前提
//
// 罰しない。ただ煙が誰の目にも見えることで真実が逃げない(プロジェクト第二条)。

import { createHash } from 'node:crypto';
import { open, CordTamper } from './cord.js';

const GENESIS = '0'.repeat(64);

// エントリの正準シリアライズ(raise と verify で同一にすること)
function canon(seq, ts, type, detail, prevHash) {
  return JSON.stringify({ seq, ts, type, detail, prevHash });
}

export class SmokeLog {
  constructor() {
    this.entries = [];
  }

  tip() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  /** 煙を上げる(検知イベントを append-only に記録)。clock はテスト用に固定可。 */
  raise(type, detail = {}, clock) {
    const seq = this.entries.length;
    const ts = clock ?? Date.now();
    const prevHash = this.tip();
    const hash = createHash('sha256').update(canon(seq, ts, type, detail, prevHash)).digest('hex');
    const entry = { seq, ts, type, detail, prevHash, hash };
    this.entries.push(entry);
    return entry;
  }

  /** ログ自体の整合性検証(遡及改ざん・連結断絶を検知)。 */
  verify() {
    let prev = GENESIS;
    for (const e of this.entries) {
      if (e.prevHash !== prev) return false;
      const recomputed = createHash('sha256')
        .update(canon(e.seq, e.ts, e.type, e.detail, e.prevHash))
        .digest('hex');
      if (recomputed !== e.hash) return false;
      prev = e.hash;
    }
    return true;
  }
}

/**
 * 検証付き open。改ざんを検知したら「煙」を上げて(SmokeLog に記録)再 throw する。
 * 露出するのは型(seq・context・メッセージ)のみ。鍵・平文・核は載せない(柱10 と整合)。
 * @returns {string} 復号された平文(正常時)
 */
export function guardedOpen(cord, issuerSecret, smokeLog, clock) {
  try {
    return open(cord, issuerSecret);
  } catch (e) {
    if (e instanceof CordTamper) {
      smokeLog.raise('tamper', { context: cord.context, seq: e.seq, message: e.message }, clock);
    }
    throw e;
  }
}
