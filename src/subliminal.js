// subliminal.js
// ─────────────────────────────────────────────────────────────
// 柱6-i: 付帯 authenticated ペイロード(別フィールド)— 厳密には subliminal channel ではない
// ─────────────────────────────────────────────────────────────
// ⚠️ これは裏メッセージを cord の**別フィールド**に足す最小実装で、**署名の自由度に埋める
//    Simmons の構成ではない**。真の Simmons 潜在チャネル(署名の乱数自由度=nonce に埋め、別フィールドを
//    一切持たない)は src/simmons.js(柱6-ii)で実装済み。本モジュールは「発行者だけが読める
//    authenticated 付帯ペイロード」として正直に位置づける。
//
// 表のデータ(surface / 卵の鎖)とは別に、発行者だけが読める「第二のメッセージ」を
// 埋め込む。検証者は表チャネルを通常どおり検証・復号できるが、裏フィールドは読めない。
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
//   真の潜在チャネル(署名の自由度=nonce に埋め、別フィールドを持たない)は src/simmons.js で
//   実装到達(柱6-ii)。目玉文字(柱2)への文書レベル steganographic 埋め込みは引き続き将来課題。

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
