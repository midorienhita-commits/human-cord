// tally.js
// ─────────────────────────────────────────────────────────────
// 柱3: 割符演算(`+` 統合 / `-` 差分発火)
// ─────────────────────────────────────────────────────────────
// 江戸の通行手形(割符)= 割った 2 片がぴったり噛み合うかで本人確認する仕組み。
// human cord では、2 つの cord が「同じ発行者秘密で封じられ」「同一案件(docId)を
// 共有する」とき、片割れが噛み合うとみなして `+`(統合)。噛み合わなければ
// `-`(差分発火)— エラーではなく「どう違うか」という有用情報を返す。
//
// 夢 1・2 の原典:
//   A + B = 一つの文章   ← 通行手形合致 → 統合
//   A − B = 違う単文     ← 差分アルゴリズム
//   「+」「−」は単なる演算子ではなく、判定基準そのものが住む位置。
//
// 白書 §4.3: BLS 集約署名の演算子化。POC では依存ゼロのため HMAC ベースの
// 通行手形で割符性を最小実装(将来 BLS/Accumulator へ差し替え可能な境界)。

import { open, computeTally, CordTamper } from './cord.js';

/**
 * 通行手形の検証。発行者秘密で tally を再計算して一致を確認し、
 * さらに本体(卵の鎖)が改ざんされていないことを open で確かめる。
 * @returns {boolean}
 */
export function verifyTally(cord, issuerSecret) {
  if (!cord || cord.tally == null || cord.docId == null) return false;
  const expected = computeTally(issuerSecret, cord.context, cord.docId, cord.tip);
  if (expected !== cord.tally) return false; // 片割れが噛み合わない
  try {
    open(cord, issuerSecret); // 中身の整合(柱10)も満たすか
    return true;
  } catch (e) {
    if (e instanceof CordTamper) return false;
    throw e;
  }
}

/**
 * 割符演算。2 つの cord を `+`(統合)または `-`(差分)で結合する。
 *   - 両方の通行手形が合致し、かつ同一 docId → `+` 統合(検証済み平文を連結)
 *   - それ以外 → `-` 差分発火(食い違いの理由・属性を返す)
 *
 * @returns {{op:'+'|'-', matched:boolean, ...}}
 */
export function combine(cordA, cordB, issuerSecret) {
  const okA = verifyTally(cordA, issuerSecret);
  const okB = verifyTally(cordB, issuerSecret);
  const sameCase = okA && okB && cordA.docId === cordB.docId;

  if (sameCase) {
    // `+` 統合: 同一案件の片割れが噛み合った。検証済みの統合ドキュメントを構成。
    const a = open(cordA, issuerSecret);
    const b = open(cordB, issuerSecret);
    return {
      op: '+',
      matched: true,
      docId: cordA.docId,
      merged: a + b,
      parts: [a, b],
    };
  }

  // `−` 差分発火: 噛み合わない。エラーにせず「どう違うか」を返す(夢 2 の設計)。
  return {
    op: '-',
    matched: false,
    diff: {
      reason: !okA
        ? 'A の通行手形が不正(別発行者 / 改ざん / tally 欠落)'
        : !okB
          ? 'B の通行手形が不正(別発行者 / 改ざん / tally 欠落)'
          : '同一発行者だが別案件(docId 不一致)',
      tallyMatchA: okA,
      tallyMatchB: okB,
      docIdA: cordA?.docId ?? null,
      docIdB: cordB?.docId ?? null,
    },
  };
}
