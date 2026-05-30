// issue.js
// ─────────────────────────────────────────────────────────────
// 発行 / 発行者媒介検証 — アプリ採用面(application surface)
// ─────────────────────────────────────────────────────────────
// Phase 4 統合設計(BiosGuide が外部採用する独立コンポーネント)の中核 API。
// 既存の柱(seal=1/9/4/5/2, embedSubliminal=6, renderEcc=7+ECC, freshness, smoke=8/10)を
// 束ねた「薄い採用面」。新規の暗号は無い。
//
// 設計上の境界(重要):
//   - payload は **opaque**(任意の文字列 / JSON 化可能オブジェクト)。用途固有のスキーマ
//     (例: 証明書の本質事実)は **採用側アプリが定義**する。human cord 側には持ち込まない。
//   - verify() は throw でなく構造化結果 {ok, verdict, …} を返す。HTTP 検証口がそのまま
//     JSON で応答できる(発行者媒介検証 = 信頼境界=サーバ側で実行する前提)。

import { seal, open, CordTamper } from './cord.js';
import { embedSubliminal, readSubliminal } from './subliminal.js';
import { renderEcc, extract } from './visual.js';
import { SmokeLog, guardedOpen } from './smoke.js';

/**
 * 発行: 本質事実(payload)を cord に封じ、堅牢な視覚担体(HC2 = ECC 付)を返す。
 * @param {string|object} payload  封じる事実(オブジェクトは JSON 化)。用途固有スキーマは採用側定義。
 * @param {string} issuerSecret    発行者秘密(柱4 片割れ。信頼境界=サーバ側にのみ存在)
 * @param {{context?:string, docId?:string|number|null, axes?:object, mark?:string|object|null}} [opts]
 *        context: 鍵列を分ける軸(例: 拠点)/ docId: 柱3 案件鍵 / mark: 柱6 発行者控え(任意)
 * @returns {{cord:object, carrier:string}} cord 本体と HC2 担体文字列(証明書に同梱する)
 */
export function issue(payload, issuerSecret, { context = 'default', docId = null, axes, mark = null } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const opts = { docId };
  if (axes) opts.axes = axes;
  let cord = seal(text, issuerSecret, context, opts);
  if (mark != null) {
    cord = embedSubliminal(cord, issuerSecret, typeof mark === 'string' ? mark : JSON.stringify(mark));
  }
  return { cord, carrier: renderEcc(cord) };
}

/**
 * 発行者媒介検証: 担体(HC2 文字列)または cord を受け取り、真贋+本質事実を構造化して返す。
 * 例外を投げず、判定を verdict で表す(検証口がそのまま応答可能)。
 *   - {ok:true,  verdict:'fresh',        payload, mark, docId}
 *   - {ok:false, verdict:'media-error',  reason}   担体の破損(光学/音響ノイズ・枠不正)
 *   - {ok:false, verdict:'replay'|'stale', reason} リプレイ防止で拒否(煙を上げる)
 *   - {ok:false, verdict:'tamper',       seq}      本体改ざん(AEAD 失敗。煙を上げる。露出は型のみ)
 * @param {string|object} carrierOrCord
 * @param {string} issuerSecret
 * @param {{guard?:object, smokeLog?:object, clock?:number}} [ctx] guard=FreshnessGuard, smokeLog=SmokeLog
 */
export function verify(carrierOrCord, issuerSecret, { guard, smokeLog, clock } = {}) {
  let cord;
  try {
    cord = typeof carrierOrCord === 'string' ? extract(carrierOrCord) : carrierOrCord;
  } catch (e) {
    return { ok: false, verdict: 'media-error', reason: e.message };
  }

  if (guard) {
    const { verdict, reason } = guard.check(cord, clock);
    if (verdict !== 'fresh') {
      if (smokeLog) smokeLog.raise('replay-or-stale', { context: cord.context, verdict, reason, tip: cord.tip }, clock);
      return { ok: false, verdict, reason };
    }
  }

  try {
    const payload = smokeLog ? guardedOpen(cord, issuerSecret, smokeLog, clock) : open(cord, issuerSecret);
    if (guard) guard.accept(cord);
    // 発行者は控え(柱6)も読める。他者検証では null になる(秘密が片割れだから)。
    const mark = readSubliminal(cord, issuerSecret);
    return { ok: true, verdict: 'fresh', payload, mark, docId: cord.docId ?? null };
  } catch (e) {
    if (e instanceof CordTamper) return { ok: false, verdict: 'tamper', seq: e.seq };
    throw e;
  }
}

export { SmokeLog };
export { FreshnessGuard } from './freshness.js';
