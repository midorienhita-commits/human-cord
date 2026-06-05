// challenge.js
// ─────────────────────────────────────────────────────────────
// 柱5/柱9: 対話チャレンジ応答 liveness — 「いま・私のために」生きている証明
// ─────────────────────────────────────────────────────────────
// 設計の起点: docs/seed-bio-analogies.md §2 / src/livecord.js の「正直な限界」。
// livecord.js(テロメア型フレーム鎖)は非対話の「生きた担体」= 連続・順序・単調・有限・鮮度を
// 与えるが、**非対話ゆえ「鮮度窓内・別の検証者への即時リプレイ」は原理的に防げない**と明言していた。
// 本モジュールはその厳密版 = **検証者の nonce をその場で取り込む対話**でこの穴を閉じる。
//
// 仕組み(新しい暗号は持ち込まない・既存の context 軸=実質 AAD を流用):
//   1. 検証者がランダムな chal.nonce を発行(その場限り・公開してよい)。
//   2. 証明者(秘密保持者)が nonce を**文脈(context)に畳み込んで** seal で応答を封じる。
//      cord.context は codebook 導出 deriveCodebook(secret, context, axes) に effく
//      → 別の nonce で封じ直すには秘密が要る/ context を後から書き換えると AEAD が割れる。
//   3. 検証者は ① 応答の context が**自分が出した nonce** と一致するか + ② open が通るか を両方確認。
//      両立 ⟺ その応答は「秘密保持者が・まさに私のチャレンジのために」封じたもの。
//
// これが防ぐもの:
//   - **別の検証者への即時リプレイ**: 検証者 B の nonce_B は録画(nonce_A 束縛)と違う → mismatch。
//   - **旧チャレンジの使い回し**: 新しいチャレンジは新 nonce → 旧応答は束縛違いで mismatch。
//   - **後日再生**: epoch(鮮度窓)は ciphertext に束縛 → 窓外は stale。
//   - **同一検証者への厳密リプレイ**: 受理済み tip を seen で弾く(replay)。
//
// 正直な限界(プロジェクトの正直さ原則): **実時間の中継(MITM relay)/距離詐称は防げない** —
//   攻撃者が私のチャレンジを遠隔の本物の証明者へ中継し、応答を即座に持ち帰ると通る。
//   これは距離限定(distance bounding=往復遅延の物理計測)の領分で、暗号単独では閉じない。
//   本モジュールが保証するのは「秘密保持者が・私のチャレンジに・鮮度内で応答した」ことまで。

import { randomBytes } from 'node:crypto';
import { seal, open, CordTamper } from './cord.js';

const CHALLENGE_BYTES = 16;

/**
 * 検証者: その場限りのチャレンジ(nonce)を発行する。
 * @param {number} clock 発行時刻(ms)。テスト用に明示で渡す(壁時計に依存しない)。
 * @param {{bytes?:number}} [opts]
 * @returns {{nonce:string, issuedAt:number}}
 */
export function issueChallenge(clock, { bytes = CHALLENGE_BYTES } = {}) {
  if (typeof clock !== 'number') throw new Error('issueChallenge: clock(ms) が必要');
  return { nonce: randomBytes(bytes).toString('hex'), issuedAt: clock };
}

// チャレンジ nonce を文脈に畳み込む(= 鍵導出に effく実質 AAD)。応答はこの文脈でしか開けない。
function boundContext(baseContext, nonce) {
  return `${baseContext}|chal:${nonce}`;
}

/**
 * 証明者(秘密保持者): チャレンジに束縛した応答 cord を「いま」封じる。
 * @param {{nonce:string, issuedAt:number}} challenge 検証者から受け取ったチャレンジ
 * @param {string} message      応答に載せる内容(在席証明なら定数でよい。内容も認証される)
 * @param {string} issuerSecret 発行者秘密(片割れ)
 * @param {string} [baseContext] 文脈ラベル(拠点別の鍵分離など)
 * @param {{clock?:number}} [opts] clock: 応答時刻(ms、既定=issuedAt 即応答)
 * @returns {object} cord(context に nonce が畳み込まれている)
 */
export function respond(challenge, message, issuerSecret, baseContext = 'live', { clock } = {}) {
  if (!challenge || typeof challenge.nonce !== 'string') throw new Error('respond: challenge が不正');
  const t = typeof clock === 'number' ? clock : challenge.issuedAt;
  const d = new Date(t); // 渡された時刻から導出(壁時計は読まない)
  const axes = { epoch: t, weekday: d.getDay(), hour: d.getHours(), parity: t % 2 };
  return seal(message, issuerSecret, boundContext(baseContext, challenge.nonce), { axes });
}

/**
 * 検証者の応答検証器(発行者媒介)。チャレンジを発行し、束縛された応答だけを live と判定する。
 *   verdict:
 *     'live'        … 自分のチャレンジに束縛・真正・鮮度内・発行後・未受理で受理
 *     'mismatch'    … 別のチャレンジに束縛(別検証者への/旧チャレンジのリプレイ)or 自分が出していない nonce
 *     'tamper'      … context は一致するが open=AEAD 失敗(偽造/書換/別発行者)
 *     'stale'       … 真正だが鮮度窓外(後日再生)
 *     'replay'      … 同一応答の再提示(tip 既受理)
 *     'precomputed' … 真正・鮮度内だが epoch がチャレンジ発行より前(事前計算の疑い)
 */
export class ChallengeVerifier {
  /**
   * @param {string} issuerSecret
   * @param {string} [baseContext] respond と同じ baseContext を使う
   * @param {{windowMs?:number}} [opts] windowMs: 鮮度窓(既定 3000ms。対話なら数百ms〜数秒が安全)
   */
  constructor(issuerSecret, baseContext = 'live', { windowMs = 3000 } = {}) {
    this.secret = issuerSecret;
    this.baseContext = baseContext;
    this.windowMs = windowMs;
    this.issued = new Map(); // nonce → issuedAt(自分が出したチャレンジ)
    this.seen = new Set();   // 受理済み応答 tip(厳密リプレイ検知)
  }

  /** チャレンジを発行し、自分が出したものとして記録する。 */
  issue(clock, opts) {
    const ch = issueChallenge(clock, opts);
    this.issued.set(ch.nonce, ch.issuedAt);
    return ch;
  }

  /**
   * 応答を検証する。状態(seen)は受理時のみ進む。
   * @param {object} response respond が出した cord
   * @param {number} clock    受信時刻(ms)
   * @returns {{verdict:string, msg?:string, nonce?:string, seq?:number, reason?:string}}
   */
  verify(response, clock) {
    // 厳密リプレイ(同一応答の再提示)。tip は seal ごとに一意。
    if (response && response.tip && this.seen.has(response.tip)) {
      return { verdict: 'replay', reason: 'response already accepted (same tip)' };
    }
    // 束縛の確認: 応答の context は「baseContext|chal:<私が出した nonce>」でなければならない。
    const prefix = `${this.baseContext}|chal:`;
    const ctx = response && response.context;
    if (typeof ctx !== 'string' || !ctx.startsWith(prefix)) {
      return { verdict: 'mismatch', reason: 'response not bound to this verifier base context' };
    }
    const nonce = ctx.slice(prefix.length);
    if (!this.issued.has(nonce)) {
      // 別検証者へのリプレイ / 旧チャレンジ / 私が出していない nonce はここで弾かれる。
      return { verdict: 'mismatch', nonce, reason: 'bound to a challenge this verifier did not issue' };
    }
    // 真正性(発行者媒介): context が一致しても、その context で実際に封じられていなければ AEAD が割れる。
    let msg;
    try {
      msg = open(response, this.secret);
    } catch (e) {
      const seq = e instanceof CordTamper ? e.seq : undefined;
      return { verdict: 'tamper', nonce, seq, reason: 'open failed (AEAD/chain)' };
    }
    // 鮮度(epoch は codebook 経由で ciphertext に束縛 → freshen 不能)。
    const epoch = response.kdf && response.kdf.epoch;
    const age = clock - epoch;
    if (!(typeof epoch === 'number') || age < -this.windowMs || age > this.windowMs) {
      return { verdict: 'stale', nonce, reason: `outside freshness window (age=${age}ms)` };
    }
    // 事前計算の疑い: 応答は私がチャレンジを出した後にしか作れないはず。
    const issuedAt = this.issued.get(nonce);
    if (epoch < issuedAt) {
      return { verdict: 'precomputed', nonce, reason: `response epoch (${epoch}) precedes challenge issuance (${issuedAt})` };
    }
    // 受理。チャレンジは一回限り(消費)= 同じ nonce への別応答の使い回しも以後 mismatch。
    this.seen.add(response.tip);
    this.issued.delete(nonce);
    return { verdict: 'live', msg, nonce };
  }
}
