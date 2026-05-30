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
import { combine as combineTally } from './tally.js';
import { embedSubliminal, readSubliminal } from './subliminal.js';
import { renderEcc, extract } from './visual.js';
import { SmokeLog, guardedOpen } from './smoke.js';
import { signStatement, verifyStatement } from './pubkey.js';
import { split as splitSecret, combine as combineShares } from './shard.js';

function parseFacts(s) {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * 発行: 本質事実(payload)を cord に封じ、堅牢な視覚担体(HC2 = ECC 付)を返す。
 * @param {string|object} payload  封じる事実(オブジェクトは JSON 化)。用途固有スキーマは採用側定義。
 * @param {string} issuerSecret    発行者秘密(柱4 片割れ。信頼境界=サーバ側にのみ存在)
 * @param {{context?:string, docId?:string|number|null, axes?:object, mark?:string|object|null,
 *          signingKey?:string, issuedAt?:string|null}} [opts]
 *        context: 鍵列を分ける軸(例: 拠点)/ docId: 柱3 案件鍵 / mark: 柱6 発行者控え(任意)
 *        signingKey: 指定時、公開検証用の attestation(Ed25519 署名)も同時に生成(柱4 公開鍵層)
 * @returns {{cord:object, carrier:string, attestation?:object}}
 *        cord 本体 + HC2 担体(発行者媒介)。signingKey 指定時は attestation(誰でも公開鍵で検証可)も。
 */
export function issue(payload, issuerSecret, { context = 'default', docId = null, axes, mark = null, signingKey = null, issuedAt = null } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const opts = { docId };
  if (axes) opts.axes = axes;
  let cord = seal(text, issuerSecret, context, opts);
  if (mark != null) {
    cord = embedSubliminal(cord, issuerSecret, typeof mark === 'string' ? mark : JSON.stringify(mark));
  }
  const out = { cord, carrier: renderEcc(cord) };
  // 柱4 公開鍵層: 署名鍵があれば「誰でもオフライン検証できる公開証明」も併せて発行。
  //   発行者媒介(秘密で隠す/読む)と公開検証(公開鍵で誰でも確認)を 1 回の発行で両立。
  if (signingKey) out.attestation = signStatement(payload, signingKey, { docId, issuedAt });
  return out;
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

/**
 * 柱3 案件内関連付け: 同一案件(docId)の 2 証明書を発行者媒介で突き合わせる。
 *   - matched(+): 同一発行者・同一案件 → 両者の本質事実を併せて提示できる。
 *   - unmatched(-): 別案件 / 別発行者 / 改ざん → 「どう違うか」(diff)を返す。
 * 発行者秘密が要る(発行者媒介)。担体破損は media-error。
 * @param {string|object} carrierA  HC2 担体 or cord
 * @param {string|object} carrierB
 * @param {string} issuerSecret
 * @returns {{ok:boolean, op?:'+'|'-', matched?:boolean, docId?:string|number|null, parts?:any[], diff?:object, verdict?:string, reason?:string}}
 */
export function relate(carrierA, carrierB, issuerSecret) {
  let a, b;
  try {
    a = typeof carrierA === 'string' ? extract(carrierA) : carrierA;
    b = typeof carrierB === 'string' ? extract(carrierB) : carrierB;
  } catch (e) {
    return { ok: false, verdict: 'media-error', reason: e.message };
  }
  const r = combineTally(a, b, issuerSecret); // 柱3 割符演算(+/-)
  if (r.op === '+') {
    return { ok: true, op: '+', matched: true, docId: r.docId ?? null, parts: (r.parts || []).map(parseFacts) };
  }
  return { ok: true, op: '-', matched: false, diff: r.diff };
}

/**
 * 柱4深化 閾値発行(Shamir): 発行者秘密を n 片に分割する(本社 + 各拠点に配る想定)。
 * @param {string} issuerSecret  発行者秘密(片割れ)
 * @param {number} n  片数 / @param {number} k  発行に必要な閾値
 * @returns {{x:number,y:Buffer}[]} 分散片(各保管者に 1 片ずつ)
 */
export function splitIssuerSecret(issuerSecret, n, k) {
  return splitSecret(Buffer.from(String(issuerSecret)), n, k);
}

/**
 * k 片以上を持ち寄って発行する。**単一保管者(片 < k)では正規の証明書を作れない**
 *   = 単一拠点単独の偽造を防ぐ多者発行。
 * 注: 本 POC は「k 片で秘密を復元してから seal」する方式(発行時に秘密が一時的に組み上がる)。
 *   復元しない真の閾値署名(BLS 等)は将来。閾値未満では誤った秘密になり、発行者の正規秘密では
 *   検証できない(= 偽造証明書は弾かれる)。
 * @param {string|object} payload
 * @param {{x:number,y:Buffer}[]} shares  持ち寄った片(k 片以上で正規)
 * @param {object} [opts]  issue() と同じ
 */
export function issueWithShares(payload, shares, opts = {}) {
  const secret = combineShares(shares).toString();
  return issue(payload, secret, opts);
}

export { SmokeLog };
export { FreshnessGuard } from './freshness.js';
// 柱4 公開鍵層を採用面から再 export(adopters は issue.js だけ見れば surface 完結)。
//   attest = 公開可能な事実に発行者署名 / verifyPublic = 公開鍵だけでオフライン検証。
export { generateIssuerKeypair, signStatement as attest, verifyStatement as verifyPublic } from './pubkey.js';
