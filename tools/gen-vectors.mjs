// tools/gen-vectors.mjs — attestation profile v1 のテストベクタを生成(決定的)
// 実行: node tools/gen-vectors.mjs > test/vectors/attestation-v1.json
// 鍵は固定シードから作る(Ed25519 の秘密鍵 = 32 byte シード)。テスト専用鍵であり実運用では使わない。
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { canonicalize } from '../src/jcs.js';
import { signAttestation, toPublicJwk, makeJwks, decodeAttestation } from '../src/jws.js';
import { signStatement } from '../src/pubkey.js';

// PKCS#8 DER の Ed25519 プレフィックス + 32 byte シード
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keyFromSeed(seedHex) {
  const der = Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, 'hex')]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return {
    seed: seedHex,
    privateKey: priv.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: createPublicKey(priv).export({ type: 'spki', format: 'pem' }),
  };
}

const K1 = keyFromSeed('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'); // RFC 8032 §7.1 TEST 1 のシード
const K2 = keyFromSeed('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb'); // RFC 8032 §7.1 TEST 2 のシード

const cases = [
  {
    name: 'basic',
    key: 'k1',
    facts: { cert: 'CERT-2026-0001', docId: 'J-001', devices: 12, issuedAt: '2026-05-31T03:52:04.941Z' },
    docId: 'J-001', issuedAt: '2026-05-31T03:52:04.941Z', iss: 'example-issuer',
  },
  {
    name: 'nested-and-unicode',
    key: 'k1',
    facts: { 名称: 'データ消去証明書', list: [1, 2.5, 'x', null, true], nested: { z: { y: 'w' }, a: [] }, '€': '\u0000\n"\\/' },
    docId: 'INTK-20260531-001', issuedAt: '2026-05-31T03:52:04Z', iss: null,
  },
  {
    name: 'string-facts-no-optional-claims',
    key: 'k2',
    facts: 'plain string facts',
    docId: null, issuedAt: null, iss: null,
  },
  {
    name: 'numbers-jcs',
    key: 'k2',
    facts: { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27, 0, -0, 1e21] },
    docId: 42, issuedAt: '2026-01-01T00:00:00.000Z', iss: 'n',
  },
];

const keys = { k1: K1, k2: K2 };
const out = {
  profile: 'human-cord attestation v1',
  note: 'Test-only keys derived from RFC 8032 §7.1 seeds. Never use in production.',
  keys: Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, {
    seed_hex: k.seed, private_pem: k.privateKey, public_pem: k.publicKey, jwk: toPublicJwk(k.publicKey),
  }])),
  jwks: makeJwks([K1.publicKey, K2.publicKey]),
  cases: cases.map((c) => {
    const k = keys[c.key];
    const jws = signAttestation(c.facts, k.privateKey, { docId: c.docId, issuedAt: c.issuedAt, iss: c.iss });
    const d = decodeAttestation(jws);
    return {
      name: c.name, key: c.key, facts: c.facts, docId: c.docId, issuedAt: c.issuedAt, iss: c.iss,
      header: d.header, payload: d.payload,
      header_jcs: canonicalize(d.header), payload_jcs: canonicalize(d.payload),
      jws,
      legacy_v0: signStatement(c.facts, k.privateKey, { docId: c.docId, issuedAt: c.issuedAt }),
      legacy_v0_canonical: canonicalize({ facts: c.facts, docId: c.docId ?? null, issuedAt: c.issuedAt ?? null }),
    };
  }),
  negative: (() => {
    const jws = signAttestation(cases[0].facts, K1.privateKey, { docId: cases[0].docId, issuedAt: cases[0].issuedAt, iss: cases[0].iss });
    const [h, p, s] = jws.split('.');
    const pl = JSON.parse(Buffer.from(p, 'base64url').toString()); pl.hc.facts.devices = 9999;
    return [
      { name: 'tampered-payload', jws: `${h}.${Buffer.from(JSON.stringify(pl)).toString('base64url')}.${s}`, key: 'k1' },
      { name: 'wrong-key', jws, key: 'k2' },
      { name: 'alg-none', jws: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`, key: 'k1' },
      { name: 'truncated-signature', jws: `${h}.${p}.${s.slice(0, -4)}`, key: 'k1' },
    ];
  })(),
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
