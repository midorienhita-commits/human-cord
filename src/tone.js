// tone.js
// ─────────────────────────────────────────────────────────────
// 柱7 音響担体(実環境向け)— DTMF 互換の 2 周波トーンで短い数字列を運ぶ
// ─────────────────────────────────────────────────────────────
// audio.js(FSK)は清浄な信号・WAV 往復向け。本モジュールは「スピーカー → 空気 → マイク」「通話コーデック越し」を
// 前提に、電話のプッシュ音と同じ方式(697–1633 Hz、電話帯域内)と Goertzel 復号を採る。純関数・依存ゼロ・ブラウザ/Node 共通。
// 初出は採用先「家族の紐」(人と人用途: 端末が鳴らす使い捨て合言葉)。ここでは payload の意味を持たない汎用担体として置く。
//
// なぜ DTMF 方式か: 電話の音声帯域(300–3400 Hz)に収まり、通話コーデック(AMR/EVS)や
// スピーカー → 空気 → マイクの経路でも壊れにくいことが実績で分かっている(電話のプッシュ音そのもの)。
// human cord 上流の FSK 担体(audio.js)は清浄な信号向けなので、実環境用にここでは 2 周波 + Goertzel を採る。
//
// フレーム: '*' <11 桁> '#'。既定 payload = ver(1) + member(2) + code(6) + check(2)。
// check = (各桁の重み付き和) mod 97 の下 2 桁(誤読検出)。任意の数字列を運ぶには frameDigits / parseDigits を使う。

export const LOW = [697, 770, 852, 941];
export const HIGH = [1209, 1336, 1477, 1633];
const KEYS = [['1', '2', '3', 'A'], ['4', '5', '6', 'B'], ['7', '8', '9', 'C'], ['*', '0', '#', 'D']];
const FREQ_OF = {}; KEYS.forEach((row, i) => row.forEach((k, j) => { FREQ_OF[k] = [LOW[i], HIGH[j]]; }));

export const SYMBOL_MS = 110;  // トーン長
export const GAP_MS = 60;      // 無音長(同じ数字の連続を区切る)

export function checksum(digits) {
  let s = 0; for (let i = 0; i < digits.length; i++) s += (Number(digits[i]) + 1) * (i + 3);
  return String(s % 97).padStart(2, '0');
}
/** payload を組む: member 0–99、code 6 桁。 */
export function framePayload(member, code) {
  const body = '1' + String(member).padStart(2, '0') + String(code).padStart(6, '0');
  return '*' + body + checksum(body) + '#';
}
/** 任意の数字列(1–20 桁)をフレーム化 / 取り出し(チェックサム付き)。 */
export function frameDigits(digits) { const d = String(digits); if (!/^\d{1,20}$/.test(d)) throw new RangeError('digits 1–20'); return '*' + d + checksum(d) + '#'; }
export function parseDigits(symbols) { const m = symbols.join('').match(/\*(\d{3,22})#/); if (!m) return null; const body = m[1].slice(0, -2), chk = m[1].slice(-2); return checksum(body) === chk ? { digits: body } : { error: 'checksum' }; }
/** 受信した記号列から payload を取り出す。 */
export function parsePayload(symbols) {
  const s = symbols.join('');
  const m = s.match(/\*(\d{11})#/);
  if (!m) return null;
  const body = m[1].slice(0, 9), chk = m[1].slice(9);
  if (checksum(body) !== chk) return { error: 'checksum' };
  if (body[0] !== '1') return { error: 'version' };
  return { version: 1, member: Number(body.slice(1, 3)), code: body.slice(3, 9) };
}

/** 記号列 → PCM サンプル(Float32Array, -1..1)。 */
export function synthesize(symbols, sampleRate = 48000, { amp = 0.5, symbolMs = SYMBOL_MS, gapMs = GAP_MS, leadMs = 150 } = {}) {
  const symN = Math.round(sampleRate * symbolMs / 1000), gapN = Math.round(sampleRate * gapMs / 1000), leadN = Math.round(sampleRate * leadMs / 1000);
  const out = new Float32Array(leadN + symbols.length * (symN + gapN) + leadN);
  let p = leadN;
  const ramp = Math.round(sampleRate * 0.005); // 5 ms のフェードでクリック音を防ぐ
  for (const s of symbols) {
    const [f1, f2] = FREQ_OF[s];
    for (let i = 0; i < symN; i++) {
      const env = Math.min(1, i / ramp, (symN - i) / ramp);
      out[p + i] = amp * env * 0.5 * (Math.sin(2 * Math.PI * f1 * i / sampleRate) + Math.sin(2 * Math.PI * f2 * i / sampleRate));
    }
    p += symN + gapN;
  }
  return out;
}

// Goertzel: 1 周波数のパワー
function goertzel(buf, start, n, freq, sampleRate) {
  const w = 2 * Math.PI * freq / sampleRate, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s0 = buf[start + i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/**
 * ストリーミング復号器。feed() に PCM を流すと、確定した記号を onSymbol で返す。
 * 判定: 1 フレーム(20 ms)ごとに低群・高群それぞれ最大パワーの周波数を取り、
 *   両群の最大が 2 番手の 4 倍以上・全体パワーが無音基準の 8 倍以上なら「その記号」。
 *   同じ記号が 3 フレーム続けば確定、無音(または別記号)で区切る。
 */
export class ToneDecoder {
  constructor(sampleRate = 48000, { frameMs = 20, minFrames = 3 } = {}) {
    this.sr = sampleRate; this.n = Math.round(sampleRate * frameMs / 1000); this.minFrames = minFrames;
    this.buf = new Float32Array(0); this.cur = null; this.run = 0; this.emitted = false; this.symbols = []; this.noise = 1e-6; this.onSymbol = null;
  }
  feed(chunk) {
    const merged = new Float32Array(this.buf.length + chunk.length); merged.set(this.buf); merged.set(chunk, this.buf.length);
    let off = 0;
    for (; off + this.n <= merged.length; off += this.n) this._frame(merged, off);
    this.buf = merged.slice(off);
  }
  _frame(buf, start) {
    const n = this.n, sr = this.sr;
    let energy = 0; for (let i = 0; i < n; i++) energy += buf[start + i] * buf[start + i];
    const lo = LOW.map((f) => goertzel(buf, start, n, f, sr)), hi = HIGH.map((f) => goertzel(buf, start, n, f, sr));
    const pick = (arr) => { // [最大の index, 2 番手の index]
      let a = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[a]) a = i;
      let b = -1; for (let i = 0; i < arr.length; i++) if (i !== a && (b < 0 || arr[i] > arr[b])) b = i;
      return [a, b];
    };
    const [li, lj] = pick(lo), [hi1, hi2] = pick(hi);
    const toneEnergy = (lo[li] + hi[hi1]) / (n * n);
    const isTone = lo[li] > 4 * lo[lj] && hi[hi1] > 4 * hi[hi2] && toneEnergy > 8 * this.noise && toneEnergy > 1e-7;
    if (!isTone) {
      // 無音基準: 下がるときは即追従、上がるときはゆっくり(記号境界の半端なフレームで基準が跳ねないように)
      const e = Math.max(energy / n, 1e-9);
      this.noise = e < this.noise ? e : Math.min(this.noise * 1.02, e);
      this.cur = null; this.run = 0; this.emitted = false; return;
    }
    const sym = KEYS[li][hi1];
    if (sym === this.cur) { this.run++; } else { this.cur = sym; this.run = 1; this.emitted = false; }
    if (this.run >= this.minFrames && !this.emitted) { this.emitted = true; this.symbols.push(sym); if (this.onSymbol) this.onSymbol(sym, this.symbols); }
  }
  /** 直近の記号列から payload を探す(見つかれば返し、記号列をクリア)。 */
  take() { const p = parsePayload(this.symbols); if (p && !p.error) this.symbols = []; return p; }
}

/** 一括復号(テスト・ファイル用)。 */
export function decodeAll(samples, sampleRate = 48000) {
  const d = new ToneDecoder(sampleRate); d.feed(samples); return { symbols: d.symbols.slice(), payload: parsePayload(d.symbols) };
}

/** PCM → 16bit WAV バイト列(テスト・保存用)。 */
export function toWav(samples, sampleRate = 48000) {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}
