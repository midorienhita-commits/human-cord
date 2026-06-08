// threshold.js
// ─────────────────────────────────────────────────────────────
// 柱4b: 真の閾値署名(FROST 方式のしきい値 Schnorr・素数体 DLOG 群)
// ─────────────────────────────────────────────────────────────
// 発行者の秘密 x を n 片に分割し、k 片以上を「持ち寄った時だけ」正規の署名を作れる。
// **秘密 x は署名のどの瞬間にも一度も再構成されない**(各拠点が外に出すのは g^{r_i} と、
// ワンタイムパッドされた部分応答 z_i だけ)。これが issueWithShares(秘密を復元して
// seal=復元の一瞬に 1 ノードへ完全な秘密が顕在化する)との決定的な違い:
// こちらは「単一拠点では偽造不能」が文字どおり成立する。
//
// 検証は公開鍵 y だけで誰でもオフラインにできる(g^z == R·y^c mod p)。これは
// 単一発行者の Ed25519 公開検証(pubkey.js attest/verifyPublic)の k-of-n 版にあたる。
//
// なぜ楕円曲線でなく素数体か:
//   真の閾値署名 FROST は本来 edwards25519 上の Schnorr。だが「秘密を再構成しない」
//   という性質は曲線に依存しない。同じ構成を古典的な素数位数 DLOG 群(Schnorr/DSA 群)で
//   実体化すれば、必要なのは BigInt のべき剰余だけ — 曲線演算もペアリングも要らず、
//   node 標準 crypto + native BigInt のまま依存ゼロを保てる(EC を選ぶ理由=鍵長/速度は
//   POC の要件ではない)。鉄板技術のみ: Schnorr(1989)+ Shamir(1979)+ 素数体 DLOG。
//
// 正直な限界(誇張しない):
//   - 単一 nonce 版は **逐次・非並行の署名セッションでのみ安全**。並行セッション(ROS/Drijvers)も、
//     同じ nonce r の単純な再利用も、片 s_i の漏洩につながる(後者は Schnorr 系共通の致命傷)。
//     本物の FROST は二重 nonce バインディング(rho_i)で並行を塞ぐ=将来。本モジュールが提供するのは
//     「単一セッション・逐次の真の閾値署名」。コーディネータ補助 thresholdSign は毎回新規 nonce を引く。
//   - 閾値 k は **k>=2 必須**(k=1 は全片が秘密と等しく、閾値の意味を成さない=splitKey が拒否)。
//   - 信頼ディーラ前提(ディーラは配布時に一瞬 x を知る。配布後に即消去)。DKG は将来。
//   - 不正者の identifiable abort 無し(部分署名の個別検証 = Feldman/Pedersen VSS は将来)。
//   - BigInt のべき剰余/逆元は定数時間でない。96–256bit 群はテスト用、本番は p>=2048/q>=256bit。
//
// ⚠️ FROST「方式」= 各片が秘密を再構成せず部分署名する FROST 系の構成。ただし本実装は単一 nonce で、
//    FROST の定義的特徴である二重 nonce バインディング(rho_i)は未実装(=並行非対応・逐次専用)。
//
// 戦略ドクトリン「根は"変えられないもの"(情報理論)で守る」: k 未満では x=f(0) が
// Z_q 上で情報理論的に一様(Shamir 完全秘匿)= どんな計算力でも偽造は確率 1/q でしか成立しない。

import { generatePrimeSync, randomBytes, createHash } from 'node:crypto';

// 課題ハッシュのドメイン分離タグ(プロトコル/版を固定して交差プロトコル攻撃を防ぐ)。
export const DOMAIN_TAG = 'human-cord/threshold-schnorr-v1';

// ── スカラは mod q(Z_q)、群元は mod p。両者を混ぜると恒等式が静かに壊れる ──
export function mod(a, m) {
  return ((a % m) + m) % m;
}

/** べき剰余(square-and-multiply)。native BigInt のみ。 */
export function modpow(base, exp, m) {
  let b = mod(base, m);
  let e = exp;
  let r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return r;
}

/** 逆元。q は素数なのでフェルマー(a^(q-2) mod q)。 */
export function invMod(a, q) {
  return modpow(mod(a, q), q - 2n, q);
}

// [1, q-1] の一様乱数スカラ。余りバイアスを抑えるため q より十分広く取って mod。
function randScalar(q) {
  const bytes = ((q.toString(16).length + 1) >> 1) + 16; // q のバイト長 + 余裕(>=128bit)
  let s;
  do {
    s = mod(BigInt('0x' + randomBytes(bytes).toString('hex')), q);
  } while (s === 0n);
  return s;
}

/**
 * Schnorr 群 (p, q, g) を生成。p=2q+1 は安全素数、q=(p-1)/2 も素数。
 * g は位数 q の部分群の生成元(g=h^2 で g!=1 とすれば、q が素数ゆえ位数はちょうど q)。
 * @param {number} bits  p のビット長(本番 >=2048、テストは 256 で十分速い)
 * @returns {{p:bigint,q:bigint,g:bigint}}
 */
export function generateGroup(bits = 2048) {
  const p = generatePrimeSync(bits, { safe: true, bigint: true });
  const q = (p - 1n) / 2n;
  let g = 0n;
  for (let h = 2n; ; h += 1n) {
    const cand = modpow(h, 2n, p);
    if (cand !== 1n && modpow(cand, q, p) === 1n) {
      g = cand;
      break;
    }
  }
  return { p, q, g };
}

/**
 * 秘密 x を Z_q 上の Shamir で n 片に分割(閾値 k)。f(X)=x + a1 X + … + a_{k-1} X^{k-1} mod q。
 * 各片は評価点 i(1..n)での f(i)。点 0 は秘密 f(0)=x 用に予約=配らない。
 * @returns {{i:number, s:bigint}[]}
 */
export function splitKey(group, x, n, k) {
  const { q } = group;
  // k>=2 必須: k=1 は定数多項式 f(X)=x になり全片が秘密と等しく、閾値の意味を成さない。
  if (k < 2 || n < k) throw new Error('invalid (n,k): need 2<=k<=n (k=1 means every share equals the secret = no forge-resistance)');
  if (BigInt(n) >= q) throw new Error('n too large for group order q');
  const x0 = mod(BigInt(x), q);
  // x=0 は y=g^0=1(恒等鍵)になり、ゼロ片で普遍的に偽造可能。発行を拒否する。
  if (x0 === 0n) throw new Error('secret must be nonzero mod q (x=0 → y=1 identity key, universally forgeable)');
  const coef = [x0];
  for (let j = 1; j < k; j += 1) coef.push(randScalar(q));
  const shares = [];
  for (let i = 1; i <= n; i += 1) {
    const xi = BigInt(i);
    let acc = 0n;
    for (let j = k - 1; j >= 0; j -= 1) acc = mod(acc * xi + coef[j], q); // Horner で f(i)
    shares.push({ i, s: acc });
  }
  return shares;
}

/**
 * 信頼ディーラ鍵生成。x を引く(または与えられた秘密を使う)→ Shamir 分割し、
 * 群公開鍵 y=g^x と n 片を返す。**ディーラは戻り値の x と係数を直ちに消去すること。**
 * @returns {{y:bigint, shares:{i:number,s:bigint}[], x:bigint}}
 */
export function generateKey(group, n, k, { secret } = {}) {
  const { q, g, p } = group;
  const x = secret != null ? mod(BigInt(secret), q) : randScalar(q);
  const shares = splitKey(group, x, n, k);
  const y = modpow(g, x, p);
  return { y, shares, x };
}

/**
 * 評価点 0 でのラグランジュ係数 λ_i(実際の参加者集合 S 上)。
 * λ_i = Π_{j∈S, j≠i} (0-j)/(i-j) mod q。減算は必ず先に mod してから掛ける。逆元は mod q。
 * 任意の |S|>=k で Σ_{i∈S} λ_i·s_i = f(0) = x。
 */
export function lambdaAt0(group, S, i) {
  const { q } = group;
  const bi = BigInt(i);
  let num = 1n;
  let den = 1n;
  for (const j of S) {
    if (j === i) continue;
    const bj = BigInt(j);
    num = mod(num * mod(0n - bj, q), q); // (0 - j)
    den = mod(den * mod(bi - bj, q), q); // (i - j)
  }
  return mod(num * invMod(den, q), q);
}

// メッセージは string か Buffer のみ。数値や object の暗黙 String 化は取り違えを生む
// (123 と '123' が衝突、任意の object が '[object Object]' に潰れて別文書が同一署名で通る)。
function messageBytes(message) {
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === 'string') return Buffer.from(message, 'utf8');
  throw new TypeError(`message must be a string or Buffer (got ${typeof message})`);
}

/**
 * 課題 c = H( domainTag ‖ len(R)‖R ‖ len(y)‖y ‖ len(m)‖m ) mod q。
 * 各フィールドを 4byte 長さ前置でフレーミング=R/y/m の境界を一意にし連結あいまいさを排除。
 * 群公開鍵 y を含めて鍵コミット。256bit ダイジェストを mod q(僅かな偏りは POC 許容)。
 */
export function challenge(group, R, y, message, domainTag = DOMAIN_TAG) {
  const h = createHash('sha256');
  h.update(domainTag);
  for (const buf of [
    Buffer.from(BigInt(R).toString(16), 'utf8'),
    Buffer.from(BigInt(y).toString(16), 'utf8'),
    messageBytes(message),
  ]) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    h.update(len);
    h.update(buf);
  }
  return mod(BigInt('0x' + h.digest('hex')), group.q);
}

/**
 * ラウンド1: 各署名者の nonce コミット。R を公開、r は秘匿。
 * ⚠️ r は CSPRNG で **毎回新規・一回限り**。同じ r(=同じ R)で異なる 2 メッセージに partialSign すると
 *    λ_i·s_i が漏れ、生の Shamir 片 s_i と r_i が完全に復元される(Schnorr 系共通の致命傷)。
 *    再試行で r をキャッシュ/永続化しないこと。
 */
export function commit(group) {
  const r = randScalar(group.q);
  return { r, R: modpow(group.g, r, group.p) };
}

/** ラウンド1 のコミット群を集約: R = Π R_i mod p(ラグランジュ重みは掛けない)。 */
export function combineCommitments(group, commitments) {
  let R = 1n;
  for (const Ri of commitments) R = mod(R * BigInt(Ri), group.p);
  return R;
}

/**
 * ラウンド2: 各署名者の部分応答 z_i = r_i + c·λ_i·s_i mod q。
 * **λ_i は自分の片 s_i だけに掛かる(nonce r_i には掛けない)** — ここが要。
 * ⚠️ r は commit() が出した一回限りの nonce。**同じ r を 2 度使うと片 s_i が漏れる**(commit 参照)。
 * @param {{i:number,s:bigint}} share  この署名者の片
 * @param {bigint} r  この署名者のラウンド1 nonce(秘密・一回限り)
 * @param {number[]} S  参加者集合(全員が同一 S で λ を計算する。相異なる添字であること)
 * @param {bigint} R  集約コミット(= Π R_j)
 * @param {bigint} y  群公開鍵
 */
export function partialSign(group, share, r, S, R, y, message, { domainTag = DOMAIN_TAG } = {}) {
  if (new Set(S).size !== S.length) throw new Error('S must have distinct indices');
  if (!S.includes(share.i)) throw new Error('signer index not in agreed set S');
  const { q } = group;
  const c = challenge(group, R, y, message, domainTag);
  const lam = lambdaAt0(group, S, share.i);
  const zi = mod(r + c * mod(lam * mod(share.s, q), q), q);
  return { i: share.i, z_i: zi };
}

/**
 * 集約: コミットを R=ΠR_i に、部分応答を z=Σz_i mod q にまとめて (R,z) を作る。
 * @returns {{R:bigint, z:bigint}}
 */
export function aggregate(group, commitments, partials) {
  const R = combineCommitments(group, commitments);
  let z = 0n;
  for (const pt of partials) z = mod(z + pt.z_i, group.q);
  return { R, z };
}

/**
 * コーディネータ補助(単一プロセス・逐次単一セッション専用)。分散実体では
 * commit / partialSign / aggregate を各拠点が個別に呼ぶ(片 s_i はネットワークに出さない)。
 * @param {bigint} y  群公開鍵
 * @param {number[]} S  参加者集合(|S|>=k)
 * @param {{i:number,s:bigint}[]} shares  参加者の片(S をカバーすること)
 * @returns {{R:bigint, z:bigint}}  閾値 Schnorr 署名
 */
export function thresholdSign(group, y, S, shares, message, { domainTag = DOMAIN_TAG } = {}) {
  if (new Set(S).size !== S.length) throw new Error('S must have distinct indices');
  const byIndex = new Map(shares.map((sh) => [sh.i, sh]));
  const commits = S.map(() => commit(group));
  const R = combineCommitments(group, commits.map((cm) => cm.R));
  const partials = S.map((idx, kth) => {
    const share = byIndex.get(idx);
    if (!share) throw new Error(`missing share for signer ${idx}`);
    return partialSign(group, share, commits[kth].r, S, R, y, message, { domainTag });
  });
  return aggregate(group, commits.map((cm) => cm.R), partials);
}

/**
 * 公開検証。(p,q,g,y,message,(R,z)) だけで真贋を確認(秘密・片・S・λ 一切不要・オフライン)。
 * c=H(domainTag|R|y|message) mod q を再計算し g^z == R·y^c mod p を検査。
 * 単一鍵 Schnorr の検証とバイト同一 = 閾値で作られたことは検証者から見えない。
 * 例外は投げず、壊れた署名には false を返す。
 * @returns {boolean}
 */
export function verifyThreshold(group, y, message, signature, { domainTag = DOMAIN_TAG } = {}) {
  try {
    const { p, q, g } = group;
    const Y = BigInt(y);
    const R = BigInt(signature.R);
    const z = BigInt(signature.z);
    // 入力衛生(y も R と同じ厳密さで検査): y/R は (1,p) かつ位数 q の非単位部分群元、z ∈ [0,q)。
    // y=1(恒等鍵)はゼロ片で g^z==R を満たし普遍的に偽造可能=必ず弾く。
    if (Y <= 1n || Y >= p) return false;
    if (modpow(Y, q, p) !== 1n) return false;
    if (R <= 1n || R >= p) return false;
    if (modpow(R, q, p) !== 1n) return false;
    if (z < 0n || z >= q) return false;
    const c = challenge(group, R, Y, message, domainTag);
    return modpow(g, z, p) === mod(R * modpow(Y, c, p), p);
  } catch {
    return false;
  }
}
