#!/usr/bin/env node
// human-cord CLI — 鍵生成・attestation 発行・検証・JWKS 作成(依存ゼロ)
//
//   human-cord keygen [--out DIR]                     Ed25519 鍵対(PEM)+ 公開 JWK
//   human-cord jwks <pub.pem>... [--status active]    JWKS(RFC 7517)を stdout へ
//   human-cord sign <facts.json> --key priv.pem [--doc-id ID] [--issued-at ISO] [--iss NAME]
//   human-cord verify <jws|file|v0.json> --keys <jwks.json|pub.pem>
//   human-cord decode <jws>                           ヘッダ/ペイロードを表示(検証なし)
//
// 終了コード: verify は ok=0 / 不合格=1。監査人がスクリプトから叩ける。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateKeypair, toPublicJwk, makeJwks, signAttestation, verifyAny, decodeAttestation,
} from '../src/jws.js';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name, def = undefined) => {
  const i = args.indexOf(name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const readMaybeFile = (s) => (s && existsSync(s) ? readFileSync(s, 'utf8').trim() : s);
const out = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');
const usage = () => process.stderr.write(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');

try {
  switch (cmd) {
    case 'keygen': {
      const dir = opt('--out', '.');
      mkdirSync(dir, { recursive: true });
      const kp = generateKeypair();
      const jwk = toPublicJwk(kp.publicKey);
      writeFileSync(join(dir, 'issuer-private.pem'), kp.privateKey, { mode: 0o600 });
      writeFileSync(join(dir, 'issuer-public.pem'), kp.publicKey);
      writeFileSync(join(dir, 'issuer-public.jwk.json'), JSON.stringify(jwk, null, 2) + '\n');
      out({ ok: true, dir, kid: jwk.kid, files: ['issuer-private.pem', 'issuer-public.pem', 'issuer-public.jwk.json'] });
      break;
    }
    case 'jwks': {
      const status = opt('--status');
      if (args.length === 0) throw new Error('public key PEM file(s) required');
      out(makeJwks(args.map((f) => ({ key: readFileSync(f, 'utf8'), status }))));
      break;
    }
    case 'sign': {
      const keyFile = opt('--key');
      if (!keyFile) throw new Error('--key priv.pem is required');
      const docId = opt('--doc-id', null);
      const issuedAt = opt('--issued-at', null);
      const iss = opt('--iss', null);
      if (!args[0]) throw new Error('facts (JSON file or literal) required');
      const facts = JSON.parse(readMaybeFile(args[0]));
      process.stdout.write(signAttestation(facts, readFileSync(keyFile, 'utf8'), { docId, issuedAt, iss }) + '\n');
      break;
    }
    case 'verify': {
      const keysRaw = readMaybeFile(opt('--keys'));
      if (!keysRaw) throw new Error('--keys <jwks.json|pub.pem> is required');
      if (!args[0]) throw new Error('attestation (JWS, file, or v0 JSON) required');
      let att = readMaybeFile(args[0]);
      if (att.trim().startsWith('{')) att = JSON.parse(att);
      const keys = keysRaw.trim().startsWith('{') ? JSON.parse(keysRaw) : keysRaw;
      const r = verifyAny(att, keys);
      out(r);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    case 'decode': {
      out(decodeAttestation(readMaybeFile(args[0])));
      break;
    }
    default:
      usage();
      process.exitCode = cmd ? 2 : 0;
  }
} catch (e) {
  process.stderr.write('error: ' + e.message + '\n');
  process.exitCode = 2;
}
