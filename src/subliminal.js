// subliminal.js
// ─────────────────────────────────────────────────────────────
// 柱6: 潜在チャネル(Simmons Subliminal Channel, CRYPTO 1983)
// ─────────────────────────────────────────────────────────────
// 表のデータ(surface / 卵の鎖)とは別に、発行者だけが読める「第二のメッセージ」を
// 埋め込む。検証者は表チャネルを通常どおり検証・復号できるが、裏チャネルは読めない。
// 発行者(subliminal 鍵の保持者)だけが裏を読み出せる。
//
// 夢4: 目玉文字の「目」から、人には知覚できないが発行者だけが復号できるノイズが出る。
//
// POC 実装方針:
//   - subliminal 鍵は codebook(柱1)から専用ドメインで HKDF 分離導出する。
//     → 表の検証(open)とは別チャネルの鍵。
//   - 裏メッセージはキーストリーム XOR で隠し、認証タグで「正しい鍵か」を判定。
//     鍵が違えば read は null(=読めない / ノイズにしか見えない)。
//   - 表チャネル(surface / eggs)には一切影響しない(独立して open・検証可能)。
//
//   将来(Phase 2+): 裏ペイロードを目玉文字(柱2)の選択・位置に分散して埋め込み、
//   別フィールドを持たない真の steganographic subliminal channel へ拡張する。
//   また検証者≠発行者の権限分離(検証鍵と subliminal 鍵の完全分離)も Phase 2+ の課題。

import { createHmac, hkdfSync } from 'node:crypto';
import { deriveCodebook } from './kdf.js';

// codebook から subliminal 専用のキーストリームを導出(表チャネルと分離)
function subliminalKeystream(codebook, length) {
  return Buffer.from(
    hkdfSync('sha256', codebook, Buffer.from('human-cord/subliminal-salt'), Buffer.from('keystream'), Math.max(length, 1)),
  );
}

/**
 * 裏メッセージを cord に埋め込む(発行時)。表チャネルは変更しない。
 * @returns {object} subliminal フィールドを足した新しい cord
 */
export function embedSubliminal(cord, issuerSecret, message) {
  const codebook = deriveCodebook(issuerSecret, cord.context, cord.kdf);
  const msg = Buffer.from(String(message), 'utf8');
  const ks = subliminalKeystream(codebook, msg.length);
  const hidden = Buffer.alloc(msg.length);
  for (let i = 0; i < msg.length; i += 1) hidden[i] = msg[i] ^ ks[i];
  const tag = createHmac('sha256', codebook).update('subliminal-tag|').update(hidden).digest('hex').slice(0, 16);
  return { ...cord, subliminal: { data: hidden.toString('base64'), tag } };
}

/**
 * 発行者だけが裏メッセージを読み出す。鍵が違えば(=発行者でなければ)null。
 * @returns {string|null}
 */
export function readSubliminal(cord, issuerSecret) {
  if (!cord || !cord.subliminal) return null;
  const codebook = deriveCodebook(issuerSecret, cord.context, cord.kdf);
  const hidden = Buffer.from(cord.subliminal.data, 'base64');
  const expectTag = createHmac('sha256', codebook).update('subliminal-tag|').update(hidden).digest('hex').slice(0, 16);
  if (expectTag !== cord.subliminal.tag) return null; // 鍵が違う → 読めない(ノイズ)
  const ks = subliminalKeystream(codebook, hidden.length);
  const msg = Buffer.alloc(hidden.length);
  for (let i = 0; i < hidden.length; i += 1) msg[i] = hidden[i] ^ ks[i];
  return msg.toString('utf8');
}
