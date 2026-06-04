// livecord.js
// ─────────────────────────────────────────────────────────────
// 柱5/柱7/柱9: 生きた担体(live carrier)— テロメア型フレーム鎖で録画リプレイ耐性
// ─────────────────────────────────────────────────────────────
// 設計の種: docs/seed-bio-analogies.md §2(テロメア=不可逆な世代計数)。
// 視覚/音響の物理層(image.js/photo.js/audio.js)が「1 枚の担体」を扱うのに対し、本モジュールは
// 担体を**フレーム鎖**(動画/点滅列)にして「いま・ここで生きている」ことを証明する。
//
// 脅威(視覚チャネル設計メモ §2 の本命): 光チャネル自体はリプレイを防げない —
//   画面を撮った録画はそのまま再生・再撮影できる。防御は「チャネル」でなく「プロトコル」へ。
//
// 防御の三本柱(すべて発行者媒介=検証側が秘密を持つ前提):
//   1. 鮮度(柱1 公開軸 epoch): 各フレームの epoch は seal の codebook 導出に effきく公開軸。
//      epoch を後付けで「新しく」書き換えると codebook が変わり AEAD が割れる(open が throw)。
//      → epoch は実質 ciphertext に束縛され、録画を後日再生すると freshen 不能=失効(stale)。
//   2. 連続性(柱9 卵の鎖の時間方向版): 各フレームの封入平文に prev=前フレーム tip を入れる。
//      差し替え・並べ替え・別録画との接ぎ木は鎖断裂(spliced)として検知。
//   3. テロメア(柱5 一方向): seq は 0..length-1 を一方向に消費する有限予算。巻き戻し不可、
//      length 到達で枯渇(exhausted)。Hayflick 限界の写し。
//
// 正直な限界(プロジェクトの正直さ原則): 非対話では「鮮度窓内・新しい検証者への即時リプレイ」は
//   原理的に防げない(録画を窓内に別の検証者へ流すと通る)。窓を frameMs 数個ぶんに絞れば実用上
//   ほぼ封じられるが、厳密にはチャレンジ応答(検証者 nonce をその場で取り込む対話)が必要。
//   本モジュールが与えるのは「連続・順序・単調・有限・鮮度」までで、対話的 liveness は将来課題。

import { seal, open, CordTamper } from './cord.js';

/**
 * 生きた担体のフレーム鎖を発行する。各フレーム = 1 cord(平文に {msg,seq,prev} を封入)。
 * @param {string} message            各フレームが運ぶメッセージ(在席証明なら定数でよい)
 * @param {string} issuerSecret       発行者秘密(片割れ)
 * @param {string} context            文脈ラベル(拠点別の鍵分離など)
 * @param {{startEpoch:number, frameMs:number, length:number}} opts
 *        startEpoch: 先頭フレームのエポック(ms) / frameMs: フレーム間隔(ms) / length: テロメア予算(枚)
 * @returns {object[]} frames(cord の配列)。seq 順に表示する。
 */
export function emitLive(message, issuerSecret, context = 'live', { startEpoch, frameMs, length }) {
  if (!(length > 0) || !(frameMs > 0) || typeof startEpoch !== 'number') {
    throw new Error('emitLive: startEpoch/frameMs/length が不正');
  }
  const frames = [];
  let prevTip = null; // 先頭(seq 0)は prev=null(GENESIS フレーム)
  for (let i = 0; i < length; i++) {
    const epoch = startEpoch + i * frameMs;
    const d = new Date(epoch);
    const axes = { epoch, weekday: d.getDay(), hour: d.getHours(), parity: epoch % 2 };
    const payload = JSON.stringify({ msg: message, seq: i, prev: prevTip });
    const cord = seal(payload, issuerSecret, context, { axes });
    frames.push(cord);
    prevTip = cord.tip; // 次フレームが鎖でこの tip にコミットする
  }
  return frames;
}

/**
 * 生きた担体の受信検証器(発行者媒介)。フレームを到着順に feed し、構造化 verdict を返す(throw しない)。
 *   verdict:
 *     'live'      … 正規・連続・鮮度内で受理(seq を 1 消費)
 *     'tamper'    … 改ざん/別発行者(open=AEAD 失敗)
 *     'stale'     … 鮮度窓外(録画の後日再生など epoch 失効)
 *     'replay'    … 同一フレームの再提示(tip 既受理)
 *     'reorder'   … seq が期待値でない(抜け/前後/巻き戻し)
 *     'spliced'   … prev が直前受理フレームの tip と不一致(別録画の接ぎ木)
 *     'exhausted' … テロメア予算(length)を使い切った後の到着
 */
export class LiveVerifier {
  /**
   * @param {string} issuerSecret
   * @param {{windowMs?:number, length?:number}} [opts]
   *   windowMs: 鮮度窓(既定 3000ms。live 用は frameMs 数個ぶんに絞るのが安全) /
   *   length: テロメア予算(指定時 seq>=length を exhausted)
   */
  constructor(issuerSecret, { windowMs = 3000, length = Infinity } = {}) {
    this.secret = issuerSecret;
    this.windowMs = windowMs;
    this.length = length;
    this.expectedSeq = 0;     // 次に受理すべき seq(一方向)
    this.lastTip = null;      // 直前に受理したフレームの tip(鎖の連結確認用)
    this.seen = new Set();    // 受理済み tip(同一フレームの再提示=replay 検知)
    this.accepted = 0;
  }

  /**
   * 1 フレームを到着時刻 clock(ms)で検証する。状態は受理時のみ進む。
   * @param {object} frame  emitLive が出した cord
   * @param {number} clock  到着時刻(ms)
   * @returns {{verdict:string, seq?:number, reason?:string, msg?:string}}
   */
  feed(frame, clock) {
    // 同一フレームの再提示(exact replay)。tip は seal ごとに一意。
    if (frame && frame.tip && this.seen.has(frame.tip)) {
      return { verdict: 'replay', reason: 'tip already accepted' };
    }
    // 1. 真正性(発行者媒介): open は AEAD + 鎖整合を検証。失敗=改ざん/別発行者。
    let payload;
    try {
      payload = open(frame, this.secret);
    } catch (e) {
      const seq = e instanceof CordTamper ? e.seq : undefined;
      return { verdict: 'tamper', seq, reason: 'open failed (AEAD/chain)' };
    }
    let meta;
    try {
      meta = JSON.parse(payload);
    } catch {
      return { verdict: 'tamper', reason: 'payload not live-frame JSON' };
    }
    // 2. 鮮度(epoch は codebook 経由で ciphertext に束縛 → freshen 不能)。
    const epoch = frame.kdf && frame.kdf.epoch;
    const age = clock - epoch;
    if (!(typeof epoch === 'number') || age < -this.windowMs || age > this.windowMs) {
      return { verdict: 'stale', seq: meta.seq, reason: `outside freshness window (age=${age}ms)` };
    }
    // 3. テロメア予算。
    if (meta.seq >= this.length) {
      return { verdict: 'exhausted', seq: meta.seq, reason: 'telomere budget consumed' };
    }
    // 4. 単調・連続(順序)。
    if (meta.seq !== this.expectedSeq) {
      return { verdict: 'reorder', seq: meta.seq, reason: `expected seq ${this.expectedSeq}, got ${meta.seq}` };
    }
    // 5. 連続性(時間方向の卵の鎖): prev は直前受理フレームの tip でなければならない。
    if (meta.prev !== this.lastTip) {
      return { verdict: 'spliced', seq: meta.seq, reason: 'prev tip does not chain to last accepted frame' };
    }
    // 受理: ここでだけ状態を一方向に進める(tick を 1 消費)。
    this.expectedSeq += 1;
    this.lastTip = frame.tip;
    this.seen.add(frame.tip);
    this.accepted += 1;
    return { verdict: 'live', seq: meta.seq, msg: meta.msg };
  }
}
