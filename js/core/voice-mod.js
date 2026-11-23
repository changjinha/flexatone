/**
 * Flexatone — core/voice-mod.js
 * Layer 0 (core): per-voice modulation — tremolo and vibrato that every voice plays with its own
 * rate, depth and phase (a seeded randomizer), and whose rate can follow the frequency band.
 * Pure data + pure maths (no DOM, no audio). First user: Risset (studios/risset/risset-voicebank.js);
 * the object is studio-neutral so other studios can store the same `voiceMod` in their documents.
 * 계층 0 (core): 보이스별 변조 — 보이스마다 속도·깊이·위상이 다른(시드 랜덤) 트레몰로와 비브라토,
 * 속도는 주파수 대역을 따라갈 수 있음. 순수 데이터·수학. 첫 사용처: 리세.
 *
 * Config / 설정
 *   { seed,
 *     trem: { on, rate Hz, depth 0…1, spread 0…1, track oct },
 *     vib:  { on, rate Hz, cents, spread 0…1, track oct } }
 * Voice i gets three numbers u₁ u₂ u₃ ∈ [−1, 1] from hash(seed, i, lane) / 보이스 i의 난수
 *   rateᵢ  = rate · 2^(spread·u₁) · 2^(track·(2b − 1))     b = the voice's place in the band, 0 low … 1 high
 *   depthᵢ = depth · (1 − ½·spread·(1 + u₂)/2)                (spread lowers some voices' depth, up to −50 %)
 *   phaseᵢ = spread · (u₃ + 1)/2                              (spread = 1 → fully scattered phases)
 *   tremolo gain  g = 1 − depthᵢ · (½ − ½·cos 2π(φ + phaseᵢ))  ∈ [1 − depthᵢ, 1]   never boosts
 *   vibrato pitch Δ = centsᵢ/100 · sin 2π(φ + phaseᵢ)  semitones
 * track > 0: higher voices modulate faster (±track octaves across the band); this is what makes the rate
 * follow the frequency band — a looping (time) automation cannot, because in a Risset field every voice
 * sits at a different place in the band at the same moment.
 * track > 0: 높은 보이스일수록 빠르게 (대역 전체에서 ±track 옥타브). 루핑(시간) 오토메이션으로는 불가능 —
 * 같은 순간에 보이스마다 대역 위치가 다르기 때문.
 */

import { clamp } from './math-utils.js';

export const VMOD_RATE_MIN = 0.05;
export const VMOD_RATE_MAX = 30;
export const VMOD_CENTS_MAX = 200;
export const VMOD_TRACK_MAX = 3;

export function createDefaultVoiceMod() {
  return {
    seed: 1,
    trem: { on: false, rate: 5, depth: 0.5, spread: 0.5, track: 0 },
    vib: { on: false, rate: 5.5, cents: 25, spread: 0.5, track: 0 },
  };
}

const fin = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);

function lane(raw, d, depthKey, depthMax) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    on: s.on === true,
    rate: clamp(fin(s.rate, d.rate), VMOD_RATE_MIN, VMOD_RATE_MAX),
    [depthKey]: clamp(fin(s[depthKey], d[depthKey]), 0, depthMax),
    spread: clamp(fin(s.spread, d.spread), 0, 1),
    track: clamp(fin(s.track, d.track), -VMOD_TRACK_MAX, VMOD_TRACK_MAX),
  };
}

/** Fill defaults and clamp. / 정규화 */
export function normalizeVoiceMod(raw) {
  const d = createDefaultVoiceMod();
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    seed: Math.round(clamp(fin(s.seed, d.seed), 0, 99999)),
    trem: lane(s.trem, d.trem, 'depth', 1),
    vib: lane(s.vib, d.vib, 'cents', VMOD_CENTS_MAX),
  };
}

export function isVoiceModOn(cfg) {
  return !!(cfg && ((cfg.trem?.on && cfg.trem.depth > 0) || (cfg.vib?.on && cfg.vib.cents > 0)));
}

/** Deterministic u ∈ [−1, 1] for (seed, voice, lane k). / 결정적 난수 */
export function voiceRand(seed, i, k) {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 1, 0x85ebca77) ^ Math.imul(k + 1, 0xc2b2ae3d)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295 * 2 - 1;
}

/**
 * Compact form for a DSP loop (the Risset control frame): null when nothing modulates.
 * t = [on, rate, depth, spread, track], v = [on, rate, cents, spread, track]. / DSP 루프용 압축 형태
 */
export function voiceModFrame(cfg) {
  const c = normalizeVoiceMod(cfg);
  if (!isVoiceModOn(c)) return null;
  return {
    seed: c.seed,
    t: [c.trem.on && c.trem.depth > 0 ? 1 : 0, c.trem.rate, c.trem.depth, c.trem.spread, c.trem.track],
    v: [c.vib.on && c.vib.cents > 0 ? 1 : 0, c.vib.rate, c.vib.cents, c.vib.spread, c.vib.track],
  };
}

/**
 * Evaluator for one voice of a curve-based renderer (the studios that bake pitch / gain curves).
 * `index` = the voice's number (its random draw), `refMidi` = the pitch that sets its band place
 * (b = (midi − 24) / 84, clamped). Time `t` = seconds since the voice started.
 * Returns null when nothing modulates. `rateMax` tells a renderer how dense its curves must be.
 * 커브 기반 렌더러의 보이스 하나용 평가기. index = 보이스 번호(난수), refMidi = 대역 위치를 정하는 음고.
 * @returns {{ gain: (t: number) => number, cents: (t: number) => number, rateMax: number } | null}
 */
export function createVoiceModEvaluator(cfg, index, refMidi = 60) {
  const f = voiceModFrame(cfg);
  if (!f) return null;
  const seed = f.seed;
  const b = 2 * clamp((Number(refMidi) - 24) / 84, 0, 1) - 1;
  const u = (k) => voiceRand(seed, index, k);
  const TAU = 2 * Math.PI;
  let rT = 0; let dT = 0; let oT = 0; let rV = 0; let cV = 0; let oV = 0;
  if (f.t[0]) {
    const q = f.t;
    rT = q[1] * 2 ** (q[3] * u(0) + q[4] * b);
    dT = q[2] * (1 - 0.25 * q[3] * (u(1) + 1));
    oT = q[3] * 0.5 * (u(2) + 1);
  }
  if (f.v[0]) {
    const q = f.v;
    rV = q[1] * 2 ** (q[3] * u(3) + q[4] * b);
    cV = q[2] * (1 - 0.25 * q[3] * (u(4) + 1));
    oV = q[3] * 0.5 * (u(5) + 1);
  }
  return {
    gain: rT ? (t) => 1 - dT * (0.5 - 0.5 * Math.cos(TAU * (rT * t + oT))) : () => 1,
    cents: rV ? (t) => cV * Math.sin(TAU * (rV * t + oV)) : () => 0,
    rateMax: Math.max(rT, rV),
  };
}

/** Curve samples a renderer needs for `sec` seconds of a voice (≥ 24 per LFO cycle). / 필요한 커브 샘플 수 */
export function voiceModSamples(ev, sec, base, cap = 16384) {
  if (!ev) return base;
  return Math.max(base, Math.min(cap, Math.ceil(sec * ev.rateMax * 24)));
}

/** Linear resample of a curve to n points. / 선형 재표본화 */
function resampleCurve(a, n) {
  const out = new Float32Array(n);
  const m = a.length;
  if (m === 1) { out.fill(a[0]); return out; }
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (m - 1);
    const k = Math.min(m - 2, Math.floor(x));
    out[i] = a[k] + (a[k + 1] - a[k]) * (x - k);
  }
  return out;
}

/**
 * Multiply a voice's frequency curve by its vibrato (2^(cents/1200)), made dense enough for the LFO.
 * `tStart` = voice time (s) of the first point, `dur` = seconds the curve covers. Returns the curve to use.
 * 주파수 커브에 비브라토 적용 (LFO에 충분한 밀도로). 사용할 커브를 반환.
 */
export function voiceModFreqCurve(ev, curve, tStart, dur) {
  if (!ev || !(ev.rateMax > 0) || ev.cents(0.123) === 0 && ev.cents(0.377) === 0) return curve;
  const n = voiceModSamples(ev, dur, curve.length);
  const out = n === curve.length ? Float32Array.from(curve) : resampleCurve(curve, n);
  for (let i = 0; i < n; i++) out[i] *= 2 ** (ev.cents(tStart + (i / Math.max(1, n - 1)) * dur) / 1200);
  return out;
}

/** Multiply a voice's gain curve by its tremolo. Returns the curve to use. / 게인 커브에 트레몰로 적용 */
export function voiceModGainCurve(ev, curve, tStart, dur) {
  if (!ev || !(ev.rateMax > 0) || ev.gain(0.123) === 1 && ev.gain(0.377) === 1) return curve;
  const n = voiceModSamples(ev, dur, curve.length);
  const out = n === curve.length ? Float32Array.from(curve) : resampleCurve(curve, n);
  for (let i = 0; i < n; i++) out[i] *= ev.gain(tStart + (i / Math.max(1, n - 1)) * dur);
  return out;
}

/** Stable voice number from an id string (or a number). / id 문자열에서 안정적인 보이스 번호 */
export function voiceModIndex(id) {
  if (Number.isFinite(id)) return id | 0;
  let h = 2166136261;
  for (const c of String(id ?? '')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 100003;
}

/** Add a voice's vibrato to a cents (detune) curve. Returns the curve to use. / 센트(detune) 커브에 비브라토 더하기 */
export function voiceModCentsCurve(ev, curve, tStart, dur) {
  if (!ev || !(ev.rateMax > 0) || ev.cents(0.123) === 0 && ev.cents(0.377) === 0) return curve;
  const n = voiceModSamples(ev, dur, curve.length);
  const out = n === curve.length ? Float32Array.from(curve) : resampleCurve(curve, n);
  for (let i = 0; i < n; i++) out[i] += ev.cents(tStart + (i / Math.max(1, n - 1)) * dur);
  return out;
}
