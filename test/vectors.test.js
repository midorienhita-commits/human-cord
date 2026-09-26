// vectors.test.js — 公開テストベクタ(test/vectors/attestation-v1.json)の再現と、独立実装との一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { canonicalize } from '../src/jcs.js';
import { signAttestation, verifyAttestation, verifyAny, toPublicJwk } from '../src/jws.js';
import { verifyStatement } from '../src/pubkey.js';

const V = JSON.parse(readFileSync(new URL('./vectors/attestation-v1.json', import.meta.url), 'utf8'));

test('ベクタの鍵: シード → 公開鍵は RFC 8032 §7.1 TEST 1/2 と一致', () => {
  const pub = (seedHex) => {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
    const ko = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
    return Buffer.from(ko.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  };
  assert.equal(pub(V.keys.k1.seed_hex), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  assert.equal(pub(V.keys.k2.seed_hex), '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c');
  assert.equal(toPublicJwk(V.keys.k1.public_pem).kid, V.keys.k1.jwk.kid);
});

test('ベクタの再生成: 同じ鍵・facts から同じ JWS(決定性)', () => {
  for (const c of V.cases) {
    const jws = signAttestation(c.facts, V.keys[c.key].private_pem, { docId: c.docId, issuedAt: c.issuedAt, iss: c.iss });
    assert.equal(jws, c.jws, c.name);
    assert.equal(canonicalize(c.payload), c.payload_jcs, c.name);
  }
});

test('ベクタの検証: JWKS(kid 選択)と PEM の両方で ok、v0 も同じ鍵で ok', () => {
  for (const c of V.cases) {
    const r = verifyAttestation(c.jws, V.jwks);
    assert.equal(r.ok, true, c.name);
    assert.deepEqual(r.facts, c.facts, c.name);
    assert.equal(verifyAttestation(c.jws, V.keys[c.key].public_pem).ok, true, c.name);
    assert.equal(verifyStatement(c.legacy_v0, V.keys[c.key].public_pem).ok, true, c.name + ' v0');
    assert.equal(verifyAny(c.legacy_v0, V.jwks).ok, true, c.name + ' v0 via verifyAny');
  }
});

test('ベクタの否定例はすべて拒否', () => {
  for (const n of V.negative) {
    assert.equal(verifyAttestation(n.jws, V.keys[n.key].public_pem).ok, false, n.name);
  }
});

test('独立実装(Python, 依存ゼロ)が同じベクタで ALL PASS', (t) => {
  const py = spawnSync('python3', ['--version']);
  if (py.status !== 0 || !existsSync(new URL('../verify/verify_attestation.py', import.meta.url))) {
    t.skip('python3 not available'); return;
  }
  const r = spawnSync('python3', ['verify/verify_attestation.py', '--self-test', 'test/vectors/attestation-v1.json'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL PASS/);
});
