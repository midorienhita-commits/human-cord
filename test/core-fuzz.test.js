// core-fuzz.test.js
// 核(対称コア + 公開鍵層)の不変条件を seed 付き乱択で多数回叩く敵対的/property テスト。
// 例示テストの上に「ランダム入力でも不変条件が崩れない」確証を積む(公開準備=確証の核)。
//   不変条件: ①往復恒等 ②鍵違い拒否 ③あらゆる改ざんは CordTamper ④verify verdict ⑤公開検証。
// 決定的: seed 固定の mulberry32(失敗は再現可能)。実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';
import { issue, verify, attest, verifyPublic, generateIssuerKeypair } from '../src/issue.js';
import { mulberry32 } from '../src/image.js';

// BMP 文字のみ(astral=サロゲート対は chunk 境界で割れ得るので除外)。ascii + ひらがな + 漢字 + 記号。
const CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/.,:;!?#@()[]あいうえおかきくけこさしすせそたちつてとXYZ漢字証明書消去機器拠点';
const rng = (seed) => mulberry32(seed);
const pick = (r) => CHARS[Math.floor(r() * CHARS.length)];
const randText = (r, max = 60) => { const n = 1 + Math.floor(r() * max); let s = ''; for (let i = 0; i < n; i++) s += pick(r); return s; };
const randSecret = (r) => { const n = 8 + Math.floor(r() * 40); let s = ''; for (let i = 0; i < n; i++) s += pick(r); return s; };
const randAxes = (r) => ({ epoch: Math.floor(r() * 2e12), weekday: Math.floor(r() * 7), hour: Math.floor(r() * 24), parity: Math.floor(r() * 2) });
// JSON 往復後の egg(Buffer は {type:'Buffer',data})の暗号文 1 バイトを反転(空なら tag を反転)。
function tamperEgg(egg, r) {
  const ct = egg.ct.data;
  if (ct.length === 0) egg.tag.data[Math.floor(r() * egg.tag.data.length)] ^= 0xff;
  else ct[Math.floor(r() * ct.length)] ^= 0xff;
}

test('fuzz: seal/open 往復は乱択 text/secret/context/axes で恒等', () => {
  const r = rng(1);
  for (let i = 0; i < 128; i++) {
    const text = randText(r), secret = randSecret(r), ctx = randText(r, 8), axes = randAxes(r);
    assert.equal(open(seal(text, secret, ctx, { axes }), secret), text, `iter ${i}`);
  }
});

test('fuzz: 鍵違いは拒否(別秘密で open は throw)', () => {
  const r = rng(2);
  for (let i = 0; i < 64; i++) {
    const text = randText(r), a = randSecret(r);
    let b; do { b = randSecret(r); } while (b === a);
    const cord = seal(text, a, 'cert', { axes: randAxes(r) });
    assert.throws(() => open(cord, b), `iter ${i}: 別鍵で open できてはならない`);
  }
});

test('fuzz: あらゆる暗号文改ざんは CordTamper', () => {
  const r = rng(3);
  for (let i = 0; i < 64; i++) {
    const text = randText(r), secret = randSecret(r);
    const cord = JSON.parse(JSON.stringify(seal(text, secret, 'cert', { axes: randAxes(r) }))); // 転送を模す
    tamperEgg(cord.eggs[Math.floor(r() * cord.eggs.length)], r);
    assert.throws(() => open(cord, secret), CordTamper, `iter ${i}`);
  }
});

test('fuzz: issue/verify(正規=ok+fresh / cord 改ざん=ok:false)', () => {
  const r = rng(4);
  for (let i = 0; i < 48; i++) {
    const text = randText(r), secret = randSecret(r);
    const { cord, carrier } = issue(text, secret, { context: 'cert', axes: randAxes(r) });
    const v = verify(carrier, secret);
    assert.equal(v.ok, true, `iter ${i} 正規 ok`);
    assert.equal(v.verdict, 'fresh', `iter ${i} 正規 fresh`);
    const t = JSON.parse(JSON.stringify(cord));
    tamperEgg(t.eggs[0], r);
    assert.equal(verify(t, secret).ok, false, `iter ${i} 改ざんは ok:false`);
  }
});

test('fuzz: 公開検証(正規=ok / facts改ざん=不可 / 別鍵=不可)', () => {
  const r = rng(5);
  const kp = generateIssuerKeypair();
  const other = generateIssuerKeypair();
  for (let i = 0; i < 48; i++) {
    const facts = { cert: randText(r, 24), devices: Math.floor(r() * 999), docId: randText(r, 10) };
    const att = attest(facts, kp.privateKey, { docId: facts.docId });
    assert.equal(verifyPublic(att, kp.publicKey).ok, true, `iter ${i} 正規`);
    const tampered = { ...att, facts: { ...att.facts, devices: att.facts.devices + 1 } };
    assert.equal(verifyPublic(tampered, kp.publicKey).ok, false, `iter ${i} facts改ざん`);
    assert.equal(verifyPublic(att, other.publicKey).ok, false, `iter ${i} 別鍵`);
  }
});
