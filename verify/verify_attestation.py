#!/usr/bin/env python3
"""human cord attestation v1 — 独立参照実装(Python, 依存ゼロ)

human cord の JavaScript コードを一切使わず、標準ライブラリ(hashlib / json / base64)だけで
JWS(EdDSA / Ed25519)attestation を検証する。目的は「別言語で同じ答えが出る」ことの証明。

  python3 verify/verify_attestation.py <jws-file-or-string> --keys <jwks.json | public.pem>
  python3 verify/verify_attestation.py --self-test test/vectors/attestation-v1.json

Ed25519 の検証は RFC 8032 §6 の参照実装(純 Python・非定数時間・検証専用)。
署名鍵は扱わないので定数時間性は問題にならない。速度は 1 検証あたり数十 ms。
"""
import base64, hashlib, json, sys

# ── RFC 8032 Ed25519 verify(参照実装の検証部分のみ) ──────────────────────────
p = 2**255 - 19
q = 2**252 + 27742317777372353535851937790883648493
d = (-121665 * pow(121666, p - 2, p)) % p
I = pow(2, (p - 1) // 4, p)

def _inv(x): return pow(x, p - 2, p)

def _xrecover(y):
    xx = (y * y - 1) * _inv(d * y * y + 1)
    x = pow(xx, (p + 3) // 8, p)
    if (x * x - xx) % p != 0: x = (x * I) % p
    if x % 2 != 0: x = p - x
    return x

def _edwards_add(P, Q):
    (x1, y1), (x2, y2) = P, Q
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + d * x1 * x2 * y1 * y2)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - d * x1 * x2 * y1 * y2)
    return (x3 % p, y3 % p)

def _scalarmult(P, e):
    Q = (0, 1)
    while e:
        if e & 1: Q = _edwards_add(Q, P)
        P = _edwards_add(P, P); e >>= 1
    return Q

By = 4 * _inv(5) % p
B = (_xrecover(By), By)

def _decodepoint(s):
    y = int.from_bytes(s, 'little') & ((1 << 255) - 1)
    x = _xrecover(y)
    if x & 1 != (s[31] >> 7): x = p - x
    P = (x, y)
    if (-x * x + y * y - 1 - d * x * x * y * y) % p != 0:
        raise ValueError('point not on curve')
    return P

def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(signature) != 64 or len(public_key) != 32: return False
    try:
        R = _decodepoint(signature[:32]); A = _decodepoint(public_key)
    except ValueError:
        return False
    S = int.from_bytes(signature[32:], 'little')
    if S >= q: return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), 'little')
    return _scalarmult(B, S) == _edwards_add(R, _scalarmult(A, h))

# ── JCS(RFC 8785)— 参照用(検証自体は base64url された payload をそのまま使う) ─────
def jcs(v) -> str:
    if v is None: return 'null'
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False, separators=(',', ':'))
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (v != v or v in (float('inf'), float('-inf'))): raise TypeError('non-finite')
        return _es_number(v)
    if isinstance(v, list): return '[' + ','.join(jcs(x) for x in v) + ']'
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=lambda k: k.encode('utf-16-be'))
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + jcs(v[k]) for k in keys) + '}'
    raise TypeError(type(v))

def _es_number(v) -> str:
    # ECMAScript Number::toString(RFC 8785 §3.2.2.3)の Python 実装
    if v == 0: return '0'
    if isinstance(v, int) and abs(v) < 2**53: return str(v)
    r = repr(float(v))  # 最短往復表現
    if 'e' in r or 'E' in r:
        mant, exp = r.split('e'); exp = int(exp)
    else:
        mant, exp = r, 0
    if mant.endswith('.0'): mant = mant[:-2]
    neg = mant.startswith('-'); mant = mant.lstrip('-')
    if '.' in mant:
        ip, fp = mant.split('.')
    else:
        ip, fp = mant, ''
    digits = (ip + fp).lstrip('0'); n = len(ip) + exp  # 小数点の位置
    if not digits: return '0'
    lead = len(ip + fp) - len((ip + fp).lstrip('0')); n -= lead
    digits = digits.rstrip('0'); k = len(digits)
    if k <= n <= 21: s = digits + '0' * (n - k)
    elif 0 < n <= 21: s = digits[:n] + '.' + digits[n:]
    elif -6 < n <= 0: s = '0.' + '0' * (-n) + digits
    else:
        e = n - 1
        s = digits[0] + ('.' + digits[1:] if k > 1 else '') + 'e' + ('+' if e >= 0 else '-') + str(abs(e))
    return ('-' if neg else '') + s

# ── JWS / JWK ──────────────────────────────────────────────────────────────
def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip('=')

def thumbprint(jwk) -> str:
    s = jcs({'crv': jwk['crv'], 'kty': jwk['kty'], 'x': jwk['x']})
    return b64u(hashlib.sha256(s.encode()).digest())

SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')

def load_keys(src) -> list:
    """PEM(SPKI)/ JWK / JWKS → [{'kid','raw',...}]"""
    if isinstance(src, str) and 'BEGIN PUBLIC KEY' in src:
        der = base64.b64decode(''.join(l for l in src.splitlines() if not l.startswith('-----')))
        if not der.startswith(SPKI_PREFIX) or len(der) != 44: raise ValueError('not an Ed25519 SPKI')
        raw = der[12:]
        jwk = {'kty': 'OKP', 'crv': 'Ed25519', 'x': b64u(raw)}
        return [{**jwk, 'kid': thumbprint(jwk), 'raw': raw}]
    if isinstance(src, str): src = json.loads(src)
    if isinstance(src, dict) and 'keys' in src: return [k for j in src['keys'] for k in load_keys(j)]
    if isinstance(src, dict) and src.get('kty') == 'OKP' and src.get('crv') == 'Ed25519':
        return [{**src, 'kid': src.get('kid') or thumbprint(src), 'raw': b64u_decode(src['x'])}]
    if isinstance(src, list): return [k for j in src for k in load_keys(j)]
    raise ValueError('unsupported key material')

def verify_attestation(jws: str, keys) -> dict:
    parts = jws.split('.')
    if len(parts) != 3: return {'ok': False, 'reason': 'malformed JWS'}
    try:
        header = json.loads(b64u_decode(parts[0])); payload = json.loads(b64u_decode(parts[1]))
        sig = b64u_decode(parts[2])
    except Exception as e:
        return {'ok': False, 'reason': 'malformed JWS: %s' % e}
    if header.get('alg') != 'EdDSA': return {'ok': False, 'reason': 'unsupported alg %r' % header.get('alg')}
    if 'crit' in header: return {'ok': False, 'reason': 'crit not supported'}
    hc = payload.get('hc') if isinstance(payload, dict) else None
    if not isinstance(hc, dict) or hc.get('v') != 1: return {'ok': False, 'reason': 'not a human cord attestation v1'}
    cands = load_keys(keys)
    kid = header.get('kid')
    if kid:
        cands = [k for k in cands if k['kid'] == kid]
        if not cands: return {'ok': False, 'reason': 'unknown kid %s' % kid}
    elif len(cands) != 1:
        return {'ok': False, 'reason': 'kid missing and multiple keys'}
    k = cands[0]
    if k.get('hc:status') == 'revoked': return {'ok': False, 'reason': 'key revoked', 'kid': k['kid']}
    ok = ed25519_verify(k['raw'], (parts[0] + '.' + parts[1]).encode('ascii'), sig)
    if not ok: return {'ok': False, 'reason': 'signature mismatch', 'kid': k['kid']}
    return {'ok': True, 'facts': hc.get('facts'), 'docId': payload.get('sub'),
            'issuedAt': hc.get('issuedAt'), 'iss': payload.get('iss'), 'kid': k['kid']}

# ── self-test against vectors ─────────────────────────────────────────────
def self_test(path) -> int:
    v = json.load(open(path, encoding='utf-8'))
    fails = 0
    def check(cond, msg):
        nonlocal fails
        print(('ok   ' if cond else 'FAIL ') + msg)
        if not cond: fails += 1
    for name, k in v['keys'].items():
        loaded = load_keys(k['public_pem'])[0]
        check(loaded['kid'] == k['jwk']['kid'] and loaded['x'] == k['jwk']['x'], 'key %s: PEM -> JWK/kid matches' % name)
    for c in v['cases']:
        check(jcs(c['payload']) == c['payload_jcs'], 'case %s: JCS(payload) matches' % c['name'])
        check(jcs(c['header']) == c['header_jcs'], 'case %s: JCS(header) matches' % c['name'])
        r = verify_attestation(c['jws'], v['jwks'])
        check(r['ok'] and r['facts'] == c['facts'] and r['docId'] == (None if c['docId'] is None else str(c['docId'])),
              'case %s: verifies with JWKS and facts round-trip' % c['name'])
        r2 = verify_attestation(c['jws'], v['keys'][c['key']]['public_pem'])
        check(r2['ok'], 'case %s: verifies with PEM' % c['name'])
        # v0 canonical form(pubkey.js)は JCS と同じ規則
        check(jcs({'facts': c['facts'], 'docId': c['docId'], 'issuedAt': c['issuedAt']}) == c['legacy_v0_canonical'],
              'case %s: legacy v0 canonical == JCS' % c['name'])
    for n in v['negative']:
        r = verify_attestation(n['jws'], v['keys'][n['key']]['public_pem'])
        check(not r['ok'], 'negative %s rejected (%s)' % (n['name'], r.get('reason')))
    print('\n%s' % ('ALL PASS' if fails == 0 else '%d FAILED' % fails))
    return 1 if fails else 0

def main(argv):
    if len(argv) >= 3 and argv[1] == '--self-test':
        return self_test(argv[2])
    if len(argv) < 4 or argv[2] != '--keys':
        print(__doc__); return 2
    src = argv[1]
    try:
        jws = open(src, encoding='utf-8').read().strip()
    except OSError:
        jws = src
    keys = open(argv[3], encoding='utf-8').read()
    r = verify_attestation(jws, keys)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    return 0 if r['ok'] else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv))
