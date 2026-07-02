// webcrypto-compat.test.js
// human cord の移植性検証(Phase 4 / BiosGuide 統合設計 §8 の最初の技術タスク)。
//
// human cord POC は node:crypto を使うが、サーバレス実行環境(Deno / ブラウザ)等では
// W3C Web Crypto API(crypto.subtle)を使う。両者が「同じ入力に同じ出力」を返すなら、
// seal/open をブラウザ非保持の信頼境界(サーバ)へそのまま移植できる。
//
// この環境は Node だが、Node にも Web Crypto(globalThis.crypto.subtle)が標準搭載で
// Deno と同一仕様。ここで node:crypto ≡ Web Crypto をバイト一致で確認する
// = アルゴリズム等価性(移植の核心リスク)の裏取り。実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash, createHmac, hkdfSync, createCipheriv, createDecipheriv,
  sign as edSign, verify as edVerify, createPrivateKey, createPublicKey,
} from 'node:crypto';
import { generateIssuerKeypair } from '../src/pubkey.js';

const subtle = globalThis.crypto.subtle;

// PEM(SPKI/PKCS8)→ DER(Web Crypto importKey は DER を取る)。
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

// 決定的な固定ベクトル(human cord の実使用に対応)
const KEY = Buffer.alloc(32, 7); // 32B 鍵(AES-256 / HMAC)
const IV = Buffer.alloc(12, 9); // 12B IV(GCM)
const DATA = Buffer.from('human-cord webcrypto parity 干支型多軸鍵', 'utf8');
const AAD = Buffer.concat([Buffer.from('3'), Buffer.alloc(32, 0)]); // egg.js の aad = seq||prevHash 相当
const IKM = Buffer.from('issuer-private-half', 'utf8');
const SALT = Buffer.from('3|10|0|1000000', 'utf8'); // kdf.js の salt 相当
const INFO = Buffer.from('human-cord/codebook|cert', 'utf8');

const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b));

test('SHA-256: node:crypto ≡ Web Crypto', async () => {
  const a = createHash('sha256').update(DATA).digest();
  const b = new Uint8Array(await subtle.digest('SHA-256', DATA));
  assert.ok(eq(a, b));
});

test('HMAC-SHA256: node:crypto ≡ Web Crypto(柱5 ratchet / 柱3 tally の根)', async () => {
  const a = createHmac('sha256', KEY).update(DATA).digest();
  const k = await subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = new Uint8Array(await subtle.sign('HMAC', k, DATA));
  assert.ok(eq(a, b));
});

test('HKDF-SHA256: node:crypto ≡ Web Crypto(柱1 コードブック導出)', async () => {
  const a = Buffer.from(hkdfSync('sha256', IKM, SALT, INFO, 32));
  const k = await subtle.importKey('raw', IKM, 'HKDF', false, ['deriveBits']);
  const b = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO }, k, 32 * 8));
  assert.ok(eq(a, b));
});

test('AES-256-GCM+AAD: node 暗号文+タグ ≡ Web Crypto 出力(柱9 卵の封)', async () => {
  // node: ct と tag を分離して返す
  const cipher = createCipheriv('aes-256-gcm', KEY, IV);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(DATA), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Web Crypto: ct || tag(末尾 16B がタグ)を返す
  const k = await subtle.importKey('raw', KEY, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const out = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: IV, additionalData: AAD, tagLength: 128 }, k, DATA));

  assert.ok(eq(Buffer.concat([ct, tag]), out), 'ct||tag が一致する');
});

test('AES-256-GCM: Web Crypto で封じ node:crypto で開く(相互運用)', async () => {
  const k = await subtle.importKey('raw', KEY, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const out = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: IV, additionalData: AAD, tagLength: 128 }, k, DATA));
  const ct = out.subarray(0, out.length - 16);
  const tag = out.subarray(out.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', KEY, IV);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  assert.ok(eq(pt, DATA));
});

test('AES-256-GCM: node:crypto で封じ Web Crypto で開く(相互運用・逆)', async () => {
  const cipher = createCipheriv('aes-256-gcm', KEY, IV);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(DATA), cipher.final()]);
  const tag = cipher.getAuthTag();

  const k = await subtle.importKey('raw', KEY, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const pt = new Uint8Array(await subtle.decrypt(
    { name: 'AES-GCM', iv: IV, additionalData: AAD, tagLength: 128 }, k, Buffer.concat([ct, tag]),
  ));
  assert.ok(eq(pt, DATA));
});

// 柱4 公開鍵層(Ed25519)の相互運用 — node 署名 ⇄ ブラウザ Web Crypto 検証 ────────
test('Ed25519: node:crypto 署名 → Web Crypto 検証(発行者署名をブラウザで公開検証)', async () => {
  const { publicKey, privateKey } = generateIssuerKeypair(); // PEM
  const sig = edSign(null, DATA, createPrivateKey(privateKey)); // サーバ(node)で署名
  const pub = await subtle.importKey('spki', pemToDer(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const ok = await subtle.verify({ name: 'Ed25519' }, pub, sig, DATA); // ブラウザ(Web Crypto)で検証
  assert.equal(ok, true);
});

test('Ed25519: Web Crypto 署名 → node:crypto 検証(相互運用・逆)', async () => {
  const { publicKey, privateKey } = generateIssuerKeypair();
  const priv = await subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'Ed25519' }, false, ['sign']);
  const sig = Buffer.from(await subtle.sign({ name: 'Ed25519' }, priv, DATA));
  const ok = edVerify(null, DATA, createPublicKey(publicKey), sig);
  assert.equal(ok, true);
});
