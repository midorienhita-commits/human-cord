// visual.js
// ─────────────────────────────────────────────────────────────
// 柱7: 物理層出力(視覚チャネル)— Phase 2 最小縦切り
// ─────────────────────────────────────────────────────────────
// 設計メモ: docs/phase2-pillar7-visual-channel.md
//
// 原則(メモ §0, §3.3):
//   AI は「目」  … 歪み・光・欠損への頑健性(本モジュール外の将来アダプタ)
//   cord は「約束」… 真正性・改ざん検知・新鮮性(ここで守る)
//
// 本モジュールが実装するのは、媒体に依存しない 2 層:
//   ① フレーム codec   … cord ⇄ 自己記述的なテキスト担体(render / extract)
//   ② リプレイ防止     … nonce 一回性 + 鮮度窓 + 煙(FreshnessGuard / receiveVisual)
//
// 明示的に「やらない」(メモ §6 非目標 / 将来アダプタ):
//   - 実ピクセル描画・QR 格子・印刷(媒体アダプタ。依存を増やすため別腹)
//   - 誤り「訂正」(ECC/Reed-Solomon)。ここでは誤り「検知」のみ(checksum)。
//     訂正 = AI の目の仕事 = Phase 2+。
//   - AI による画像抽出。本モジュールはその出力(復元フレーム文字列)を受け取る前提。
//
// 最重要(メモ §2): 光チャネル自体はリプレイを防げない。
//   画面を撮った画像はそのまま再表示・再撮影できる。
//   → チャネルでなく「プロトコル」で守る。それが ② の存在理由。

import { createHash } from 'node:crypto';
import { open } from './cord.js';
import { guardedOpen } from './smoke.js';

const MAGIC = 'HC1'; // human-cord visual frame v1
const SEP = '|';
const CKSUM_LEN = 12; // sha256 先頭 12 hex を整合性チェックに使う

/** 担体の読み取り破損(光学ノイズ・改ざんで枠が壊れた)を表す例外。 */
export class VisualFrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisualFrameError';
  }
}

// base64url(パディング無し)。'|' を含まないので SEP と衝突しない。
function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function checksum(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, CKSUM_LEN);
}

// JSON 化で Buffer は {type:'Buffer',data:[…]} に化ける。物理層 codec の責務として
// ここでバイト忠実な cord に戻す(crypto コア=既存 9 柱は無改変のまま開ける)。
// メモ §4「既存 9 柱に触れず物理層ラッパを足す」の実装上の帰結。
// 音響担体(audio.js)も同じ復元が要るため export(将来 freshness.js へ共通化候補)。
export function reviveBuffers(value) {
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
    if (Array.isArray(value)) return value.map(reviveBuffers);
    const out = {};
    for (const k of Object.keys(value)) out[k] = reviveBuffers(value[k]);
    return out;
  }
  return value;
}

/**
 * ① render: cord → 視覚担体(自己記述テキストフレーム)。
 *   形式: HC1|<payloadバイト長>|<sha256先頭12hex>|<base64url(JSON(cord))>
 *   - 自己記述(長さ+チェックサム)なので、部分的な読み取り破損を extract が検知できる。
 *   - cord の Buffer は JSON 化で {type:'Buffer',data:[…]} になるが、open 側の
 *     toBuf がこれを吸収するため往復で復号可能(cord.js 参照)。
 * @param {object} cord  seal() の出力
 * @returns {string} 担体フレーム文字列(将来この文字列を QR/画像/印刷に載せる)
 */
export function render(cord) {
  const payload = Buffer.from(JSON.stringify(cord), 'utf8');
  const b64 = b64urlEncode(payload);
  return [MAGIC, String(payload.length), checksum(payload), b64].join(SEP);
}

/**
 * ① extract: 視覚担体 → cord。枠・長さ・チェックサムを検証して復元する。
 *   AI の目が復元した「読み取り結果の文字列」を受け取り、約束(cord)に戻す役。
 *   破損していれば VisualFrameError(復号より手前で弾く＝媒体エラーと改ざんを分離)。
 * @param {string} frame
 * @returns {object} cord
 */
export function extract(frame) {
  if (typeof frame !== 'string') throw new VisualFrameError('frame is not a string');
  const parts = frame.split(SEP);
  if (parts.length !== 4) throw new VisualFrameError('malformed frame (field count)');
  const [magic, lenStr, cksum, b64] = parts;
  if (magic !== MAGIC) throw new VisualFrameError(`unknown magic: ${magic}`);

  let payload;
  try {
    payload = b64urlDecode(b64);
  } catch {
    throw new VisualFrameError('base64url decode failed');
  }
  if (payload.length !== Number(lenStr)) {
    throw new VisualFrameError('length mismatch (truncated/garbled read)');
  }
  if (checksum(payload) !== cksum) {
    throw new VisualFrameError('checksum mismatch (optical noise / tamper)');
  }
  let cord;
  try {
    cord = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new VisualFrameError('payload is not valid cord JSON');
  }
  return reviveBuffers(cord); // バイト忠実に復元(eggs の Buffer 群を生に戻す)
}

/**
 * ② リプレイ防止ガード(プロトコル側)。
 *   - 一回性: cord.tip(seal ごとに一意な鎖先端ハッシュ)を nonce として使い、
 *             一度受理した tip の再提示を「リプレイ」として弾く。
 *   - 鮮度窓: cord.kdf.epoch(公開軸のミリ秒エポック)が now から windowMs 以内か。
 *   どちらも cord が「表に出している」公開情報だけで判定する(seal 無改造)。
 */
export class FreshnessGuard {
  /** @param {{windowMs?: number}} [opts] 既定 5 分。 */
  constructor({ windowMs = 5 * 60 * 1000 } = {}) {
    this.windowMs = windowMs;
    this.seen = new Set(); // 受理済み tip(一回性)
  }

  /**
   * 受理可否を判定する(状態は変えない)。
   * @returns {{verdict:'fresh'|'replay'|'stale', reason:string}}
   */
  check(cord, clock) {
    const tip = cord && cord.tip;
    if (!tip) return { verdict: 'stale', reason: 'no tip (cannot establish one-time identity)' };
    if (this.seen.has(tip)) return { verdict: 'replay', reason: 'tip already accepted' };

    const epoch = cord.kdf && cord.kdf.epoch;
    if (typeof epoch !== 'number') {
      return { verdict: 'stale', reason: 'no public epoch axis (kdf.epoch)' };
    }
    const now = clock ?? Date.now();
    const age = now - epoch;
    if (age < 0 || age > this.windowMs) {
      return { verdict: 'stale', reason: `outside freshness window (age=${age}ms)` };
    }
    return { verdict: 'fresh', reason: 'within window and unseen' };
  }

  /** 受理を確定し、tip を使用済みにする(以後リプレイ扱い)。 */
  accept(cord) {
    if (cord && cord.tip) this.seen.add(cord.tip);
  }
}

/**
 * ②+①+柱8/9/10 を束ねた受信口。視覚担体を受け取り、検証済み平文を返す。
 *   手順:
 *     1. extract で枠・整合を検証(媒体破損は VisualFrameError)
 *     2. FreshnessGuard で一回性+鮮度を判定。replay/stale なら煙を上げて拒否
 *     3. guardedOpen(柱8/9/10)で復号。改ざんなら煙 + CordTamper
 *     4. 成功時のみ tip を使用済みに(原子的に「受理 = 一回」を成立させる)
 * @param {string} frame
 * @param {string} issuerSecret
 * @param {{guard:FreshnessGuard, smokeLog:object, clock?:number}} ctx
 * @returns {string} 検証済み平文
 */
export function receiveVisual(frame, issuerSecret, { guard, smokeLog, clock } = {}) {
  const cord = extract(frame); // 媒体層: 破損は VisualFrameError として分離

  const { verdict, reason } = guard.check(cord, clock);
  if (verdict !== 'fresh') {
    // メモ §2/§4: リプレイ・期限切れは煙を上げる(柱8)。露出は型のみ(柱10 と整合)。
    if (smokeLog) {
      smokeLog.raise('replay-or-stale', { context: cord.context, verdict, reason, tip: cord.tip }, clock);
    }
    throw new VisualFrameError(`rejected: ${verdict} (${reason})`);
  }

  // 柱9/4/8/10: 本体の復号・改ざん検知。煙は guardedOpen が必要時に上げる。
  const text = smokeLog ? guardedOpen(cord, issuerSecret, smokeLog, clock) : open(cord, issuerSecret);
  guard.accept(cord); // 復号成功して初めて「一回」を消費する
  return text;
}
