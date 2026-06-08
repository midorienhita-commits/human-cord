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

// 相同領域 = 全姉妹で (key,value) が一致するフィールド(JSON 等値で判定)。
//   生物の「相同配列」= 鋳型として使える共通部分。ここが案件レベルの事実(再建可能な真実)。
function homologousRegion(factsList) {
  if (factsList.length === 0) return {};
  const first = factsList[0];
  const out = {};
  for (const k of Object.keys(first)) {
    const v = JSON.stringify(first[k]);
    if (factsList.every((o) => o && JSON.stringify(o[k]) === v)) out[k] = first[k];
  }
  return out;
}
// 姉妹間で値が分かれるフィールド(= 文書固有・非相同。鋳型では再建できない)。
function variableRegion(factsList) {
  const keys = new Set();
  for (const o of factsList) for (const k of Object.keys(o || {})) keys.add(k);
  const out = {};
  for (const k of keys) {
    const vals = factsList.map((o) => (o ? o[k] : undefined));
    if (new Set(vals.map((v) => JSON.stringify(v))).size > 1) out[k] = vals;
  }
  return out;
}

/**
 * 柱3 相同組換え修復(reconstructCase): 同一案件(docId)の複数担体を相互の冗長コピーとみなし、
 *   一部が破損(RS 訂正能力超過 / 改ざん)しても、**無傷の姉妹を鋳型に案件の本質事実を再建**する。
 *   設計の種: docs/seed-bio-analogies.md §1(相同組換え修復)。
 *
 * 生物の写し: 二本鎖切断を相同な姉妹染色体を鋳型に再建する。共通(相同)領域だけが再建可能で、
 *   非相同(文書固有のフィールド)は鋳型に無いので復元できない(正直な限界)。
 *
 * セマンティクス:
 *   - 各担体を発行者媒介 verify。intact(ok)と damaged(media-error/tamper)に分ける。
 *   - intact を docId でグループ化し、対象案件(指定 docId or 最多数の案件)を選ぶ。
 *   - **相同領域** = その案件の intact 姉妹すべてで一致する (key,value) = 再建された案件の真実
 *     (複数姉妹が corroborate=相互検証する)。値が分かれるキーは variable(文書固有)として報告。
 *   - **非相同**(intact だが別 docId)= foreign として排除(別案件 / 取り違え検知)。
 *   - 無傷の姉妹が 1 枚も無ければ ok:false(案件のコピーが全滅=再建不能)。
 *
 * @param {(string|object)[]} carriers  HC2 担体 or cord の配列(同一案件と想定して持ち寄る)
 * @param {string} issuerSecret
 * @param {{docId?:string|number|null, ctx?:object}} [opts] docId: 対象案件を明示 / ctx: verify の guard/smokeLog/clock
 * @returns {{ok:boolean, docId:any, recovered?:object, corroboration?:number, repaired?:object[],
 *            foreign?:object[], variable?:object, damaged?:object[], reason?:string}}
 */
export function reconstructCase(carriers, issuerSecret, { docId = null, ctx = {} } = {}) {
  const results = carriers.map((c, i) => ({ i, ...verify(c, issuerSecret, ctx) }));
  const damaged = results.filter((r) => !r.ok).map((r) => ({ index: r.i, verdict: r.verdict, reason: r.reason, seq: r.seq }));
  const intact = results.filter((r) => r.ok);

  // 対象案件: 明示 docId、無ければ intact 中で最多数の docId。
  let target = docId;
  if (target == null) {
    const counts = new Map();
    for (const r of intact) counts.set(String(r.docId), (counts.get(String(r.docId)) || 0) + 1);
    let best = -1;
    for (const r of intact) {
      const c = counts.get(String(r.docId));
      if (c > best) { best = c; target = r.docId; }
    }
  }

  const siblings = intact.filter((r) => String(r.docId) === String(target));
  const foreign = intact
    .filter((r) => String(r.docId) !== String(target))
    .map((r) => ({ index: r.i, docId: r.docId ?? null }));

  if (siblings.length === 0) {
    return { ok: false, docId: target ?? null, reason: '無傷の姉妹が無い(案件のコピーが全滅=再建不能)', damaged, foreign };
  }

  // facts を比較可能な形に正規化: verify の payload は JSON 文字列なので parse(relate と同じ)。
  //   オブジェクトは相同/非相同をフィールド単位で比較。非オブジェクトは {value} に包む。
  const factsList = siblings.map((s) => {
    const f = parseFacts(s.payload);
    return f && typeof f === 'object' && !Array.isArray(f) ? f : { value: f };
  });
  const recovered = homologousRegion(factsList);
  const variable = variableRegion(factsList);

  return {
    ok: true,
    docId: target ?? null,
    recovered,                 // 相同領域 = 再建された案件の本質事実(無傷姉妹が鋳型)
    corroboration: siblings.length, // 何枚の姉妹が相互検証したか(鋳型の重複度)
    repaired: damaged,         // 破損担体: 相同領域は鋳型から再建/被覆。固有フィールドは喪失(非相同)
    foreign,                   // 非相同(別案件)= 排除した担体
    variable,                  // 姉妹間で分かれる文書固有フィールド
  };
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

// 柱4b 真の閾値署名(k-of-n 公開検証)を採用面から再 export。
//   発行者媒介(担体)・単一発行者公開検証(attest)に続く三つ目の検証口 = k-of-n 公開検証。
//   秘密を一度も再構成せず本社+拠点で発行 → 公開鍵だけで誰でも検証(thresholdVerify)。
//   採用面には鍵/群生成・安全なコーディネータ(thresholdSign は毎回新規 nonce)・公開検証のみを出す。
//   分散二段(commit/partialSign/aggregate)は nonce の一回限り規律を要する足撃ちのため、
//   理解した上で src/threshold.js から直接 import する(採用面には載せない)。
export {
  generateGroup as generateThresholdGroup,
  generateKey as generateThresholdKey,
  splitKey as splitThresholdShares,
  thresholdSign,
  verifyThreshold as thresholdVerify,
} from './threshold.js';
