// json-roundtrip.test.js
// 柱9: cord の JSON シリアライズ往復(seal→JSON.stringify→JSON.parse→open)。
// 卵の Buffer フィールド(prevHash/iv/ct/tag/hash)は JSON 化で
// {type:'Buffer',data:[…]} に化けるが、コア(egg.js の toBuf)で吸収して復号できる。
// 実行: node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, CordTamper } from '../src/cord.js';

const SECRET = 'issuer-private-half-xyz';

test('柱9: seal→JSON.stringify→JSON.parse→open で平文が往復する', () => {
  const plaintext = 'JSON round-trip must restore this plaintext exactly.';
  const cord = seal(plaintext, SECRET);
  const revived = JSON.parse(JSON.stringify(cord)); // 卵の Buffer が {type:'Buffer'} 化
  assert.equal(open(revived, SECRET), plaintext);
});

test('柱9: JSON 往復後でも改ざんは CordTamper として検知される', () => {
  const cord = seal('tamper after a json round trip please', SECRET);
  const revived = JSON.parse(JSON.stringify(cord));
  revived.eggs[1].ct.data[0] ^= 0xff; // 復元後の生バイト配列を 1 bit 反転
  assert.throws(() => open(revived, SECRET), CordTamper);
});

test('柱9: docId 付き(柱3 通行手形)cord も JSON 往復で復号できる', () => {
  const plaintext = 'document with a passage tally over JSON';
  const cord = seal(plaintext, SECRET, 'default', { docId: 'DOC-001' });
  const revived = JSON.parse(JSON.stringify(cord));
  assert.equal(open(revived, SECRET), plaintext);
  assert.equal(revived.docId, 'DOC-001');
});
