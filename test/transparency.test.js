// transparency.test.js — RFC 6962/9162 Merkle(CT 公知ベクタ)+ 署名済みチェックポイント。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  EMPTY_ROOT, merkleRoot, inclusionProof, verifyInclusion, consistencyProof, verifyConsistency,
  signCheckpoint, verifyCheckpoint, checkpointHash,
} from '../src/transparency.js';
import { generateKeypair, makeJwks } from '../src/jws.js';

// certificate-transparency(Google)リファレンス実装の公開テストデータ(8 葉と各サイズのルート)
const CT_LEAVES = ['', '00', '10', '2021', '3031', '40414243', '5051525354555657', '606162636465666768696a6b6c6d6e6f']
  .map((h) => Buffer.from(h, 'hex'));
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

test('RFC 6962 公知ベクタ: 空木と n=1..8 のルート', () => {
  assert.equal(EMPTY_ROOT.toString('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  for (let n = 1; n <= 8; n++) assert.equal(merkleRoot(CT_LEAVES.slice(0, n)).toString('hex'), CT_ROOTS[n - 1], `n=${n}`);
});

const leaves = Array.from({ length: 33 }, (_, i) => createHash('sha256').update('leaf-' + i).digest());

test('包含証明: 全サイズ・全インデックスで検証が通り、別葉・別インデックスでは落ちる', () => {
  for (let n = 1; n <= 33; n++) {
    const tree = leaves.slice(0, n); const root = merkleRoot(tree);
    for (let i = 0; i < n; i++) {
      const proof = inclusionProof(tree, i);
      assert.equal(verifyInclusion(tree[i], i, n, proof, root), true, `n=${n} i=${i}`);
      assert.equal(verifyInclusion(Buffer.from('x'), i, n, proof, root), false);
      if (n > 1) assert.equal(verifyInclusion(tree[i], (i + 1) % n, n, proof, root), false);
    }
  }
});

test('整合証明: 全 (m, n) 組で通り、過去を書き換えた木では落ちる', () => {
  for (let n = 1; n <= 33; n++) {
    const tree = leaves.slice(0, n); const newRoot = merkleRoot(tree);
    for (let m = 0; m <= n; m++) {
      const oldRoot = merkleRoot(tree.slice(0, m));
      assert.equal(verifyConsistency(m, n, consistencyProof(tree, m), oldRoot, newRoot), true, `m=${m} n=${n}`);
    }
  }
  const m = 10, n = 25;
  const rewritten = leaves.slice(0, n); rewritten[3] = createHash('sha256').update('evil').digest();
  assert.equal(verifyConsistency(m, n, consistencyProof(rewritten, m), merkleRoot(leaves.slice(0, m)), merkleRoot(rewritten)), false);
});

test('チェックポイント: 署名 → 公開鍵だけで検証、接頭辞検査、prev 連鎖、縮小/書き換えは alarm', () => {
  const { privateKey, publicKey } = generateKeypair();
  const jwks = makeJwks([publicKey]);
  const c1 = signCheckpoint(leaves.slice(0, 10), privateKey, { origin: 'work_logs', issuedAt: '2026-09-26T00:00:00Z' });
  assert.equal(c1.ok, true);
  assert.equal(c1.checkpoint.hash, checkpointHash({ treeSize: 10, rootHex: c1.checkpoint.root, prevHex: '', origin: 'work_logs' }).toString('hex'));
  const v1 = verifyCheckpoint(c1.attestation, jwks, { entries: leaves.slice(0, 20) });
  assert.equal(v1.ok, true); assert.equal(v1.prefixOfCurrent, true); assert.equal(v1.checkpoint.tree_size, 10);

  const c2 = signCheckpoint(leaves.slice(0, 20), privateKey, { prev: c1.checkpoint, origin: 'work_logs' });
  assert.equal(c2.ok, true); assert.equal(c2.checkpoint.prev, c1.checkpoint.hash);
  // 縮小
  const shrunk = signCheckpoint(leaves.slice(0, 15), privateKey, { prev: c2.checkpoint });
  assert.equal(shrunk.ok, false); assert.match(shrunk.alarm, /shrunk/);
  // 過去の書き換え
  const evil = leaves.slice(0, 25); evil[2] = Buffer.from('evil');
  const rew = signCheckpoint(evil, privateKey, { prev: c2.checkpoint });
  assert.equal(rew.ok, false); assert.match(rew.alarm, /rewritten/);
  // 検証側でも接頭辞不一致を検出
  const bad = verifyCheckpoint(c2.attestation, jwks, { entries: evil });
  assert.equal(bad.ok, false); assert.match(bad.reason, /not a prefix/);
  // 別鍵では検証不能
  assert.equal(verifyCheckpoint(c2.attestation, generateKeypair().publicKey).ok, false);
});
