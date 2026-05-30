// freshness.js
// ─────────────────────────────────────────────────────────────
// 柱7/柱10 共通基盤: 物理層担体(視覚・音響)で共有するリプレイ防止と
//   バイト忠実復元。視覚チャネル(visual.js)で先に書いたものを、音響チャネル
//   (audio.js)と共有するためここへ括り出した(重複解消)。
//
// 設計メモ: docs/phase2-pillar7-visual-channel.md §4 / -audio-channel.md §5,§7
//
// 最重要(メモ §2): 光・音のチャネル自体はリプレイ/コピーを防げない。
//   防御は「チャネル」でなく「プロトコル」へ = 本ファイルの存在理由。

/**
 * JSON 化で Buffer は {type:'Buffer',data:[…]} に化ける。物理層 codec の責務として
 * バイト忠実な cord に戻す(crypto コア=既存 9 柱は無改変のまま開ける)。
 * cord.js 側でも toBuf が JSON 往復を吸収するが(4dd1c72)、担体層は復元した cord を
 * 返す契約なので、ここでも忠実復元しておく(視覚・音響で共有)。
 */
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
 * リプレイ防止ガード(プロトコル側)。視覚・音響の両担体で共有する。
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
