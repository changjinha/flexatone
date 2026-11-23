/**
 * Flexatone — studios/cloud/cloud-engine.js
 * Layer 2 (studios, pure): Cloud Studio engine — Xenakis-style stochastic glissando clouds.
 * 계층 2 (순수): 클라우드 스튜디오 엔진 — 크세나키스식 확률 글리산도 구름.
 *
 * An event is a short glissando grain { t0, dur, p0, p1 (MIDI), gain, pan }. The whole event
 * list is generated ONCE per document signature (seeded PRNG, fully deterministic) and cached
 * as struct-of-arrays Float32Arrays; playback, drawing and baking only read the cache.
 * 이벤트 목록은 문서 시그니처당 한 번만 생성(시드 PRNG, 결정적)되어 SoA 배열로 캐시되며,
 * 재생·그리기·베이킹은 캐시만 읽음.
 *
 * Pipeline / 처리 순서
 *   λ(t) table → inhomogeneous Poisson times (cumulative-intensity inversion)
 *   → pitch p0 ~ dist(center(t), width(t)·(1 − collapse(t))) → sieve → duration → glide p1
 *   → gain (+ equal-loudness) → polyphony cap (drop quietest, then oldest) → SoA cache.
 * Bake to Glissando: greedy interval colouring into lanes (≤ 64 voices) and an EXACT
 * piecewise-linear MIDI representation per lane (log-Hz glide = straight line in MIDI).
 *
 * Imports: core/*, modules/* only (no DOM, no audio). / DOM·오디오 의존 없음.
 */

import { clamp, createSeededRandom, deepClone, roundTo, createLinearSplinePoints, evalPiecewiseBezierPoints } from '../../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../../core/units.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { timbreSpecMode, timbreSpecFunc } from '../../modules/timbre-spec.js';

// ==========================================================================
// Constants / 상수
// ==========================================================================

export const CLOUD_DISTS = Object.freeze(['uniform', 'gauss', 'cauchy', 'logistic', 'levy', 'brownian']);
export const DUR_DISTS = Object.freeze(['exp', 'lognormal', 'uniform']);
export const ENVELOPES = Object.freeze(['hann', 'tukey', 'expdecay']);
export const GLIDE_MODES = Object.freeze(['slope', 'target']);
export const PITCH_COMPS = Object.freeze(['off', 'equalLoud']);
export const SIEVE_OPS = Object.freeze(['union', 'inter']);
export const SIEVE_GRIDS = Object.freeze({ semitone: 1, quarter: 0.5, eighth: 0.25 });
/** Curve engines offered for the time curves ('custom' = editable breakpoints). / 시간 곡선 엔진 */
export const CURVE_ENGINES = Object.freeze(['custom', 'harmonic', 'damped', 'anticipation', 'ratchet', 'chirp', 'bounce', 'bezier', 'plateau', 'expo', 'trig']);
export const CURVE_KEYS = Object.freeze(['density', 'center', 'width', 'collapse']);
/** Value range of each time curve (lo/hi are clamped into it). / 시간 곡선 값 범위 */
export const CURVE_RANGES = Object.freeze({
  density: Object.freeze({ min: 0.2, max: 200, step: 0.1, unit: 'ev/s' }),
  center: Object.freeze({ min: 12, max: 120, step: 0.5, unit: 'MIDI' }),
  width: Object.freeze({ min: 0, max: 48, step: 0.1, unit: 'st' }),
  collapse: Object.freeze({ min: 0, max: 1, step: 0.01, unit: '' }),
});
export const MAX_EVENTS_LIMIT = 20000;
export const MAX_POLY_LIMIT = 256;
export const MAX_LENGTH_SEC = 300;
/** Silent gap kept between consecutive events of one baked lane (pitch jumps happen here). */
export const LANE_GAP_SEC = 0.02;
export const MAX_BAKE_VOICES = 64;
/** Pitch jump time inside the silent gap (< LANE_GAP_SEC). / 무음 구간 내 음고 점프 시간 */
const JUMP_SEC = 0.01;
/** Envelope sample positions written as gain points per event (ends are 0). / 포락선 기준점 */
const ENV_POINTS = Object.freeze({
  hann: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1],
  tukey: null, // depends on the attack fraction / 어택 비율에 따라 달라짐
  expdecay: null,
});
const TABLE_N = 2048;

// ==========================================================================
// Document / 문서
// ==========================================================================

/** A time curve = curve-engine object + value range [lo, hi]. / 시간 곡선 객체 */
export function makeCurve(lo, hi = lo, engine = 'custom', extra = {}) {
  return { engine, lo, hi, reverse: false, inverse: false, customPoints: createLinearSplinePoints(0, 1), ...extra };
}

export function createDefaultCloudParams() {
  return {
    seed: 1,
    length: 30,
    density: makeCurve(30),
    pitch: {
      center: makeCurve(60),
      width: makeCurve(7),
      dist: 'gauss',
      brownStep: 2.0,
      brownDrift: 0,
      levyAlpha: 1.5,
      min: 24,
      max: 108,
      sieve: { enabled: false, terms: [{ mod: 12, residues: [0, 2, 4, 5, 7, 9, 11], shift: 0 }], op: 'union', grid: 'semitone' },
      snapSieve: true,
    },
    glide: { mode: 'slope', slopeMean: 0, slopeSpread: 6, upBias: 0.5, clusterCollapse: makeCurve(0) },
    duration: { dist: 'exp', mean: 0.8, min: 0.05, max: 4 },
    gain: { base: 0.5, spread: 0.3, pitchComp: 'off', envelope: 'hann', attack: 0.02, autoLevel: true },
    timbre: { sine: 0.8, tri: 0.3, saw: 0.05, sqr: 0, rich: 0.1, stereo: 0.6 },
    maxEvents: 4000,
    maxPolyphony: 128,
    sched: { lookahead: 0.5, interval: 25 },
    view: { tMin: 0, tMax: 30, midiMin: 24, midiMax: 108, curveTab: 'density', histWin: 4 },
  };
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(base, over) {
  if (!isObj(over)) return base;
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(base[k])) deepMerge(base[k], v);
    else if (v !== undefined) base[k] = deepClone(v);
  }
  return base;
}

/** Defaults deep-merged with a saved document (old / partial files load safely). / 정규화 */
export function normalizeCloudParams(raw) {
  const d = deepMerge(createDefaultCloudParams(), raw);
  d.seed = Math.max(0, Math.floor(Number(d.seed) || 0)) >>> 0;
  d.length = clamp(Number(d.length) || 30, 1, MAX_LENGTH_SEC);
  d.maxEvents = clamp(Math.round(Number(d.maxEvents) || 4000), 1, MAX_EVENTS_LIMIT);
  d.maxPolyphony = clamp(Math.round(Number(d.maxPolyphony) || 128), 1, MAX_POLY_LIMIT);
  if (!CLOUD_DISTS.includes(d.pitch.dist)) d.pitch.dist = 'gauss';
  if (!DUR_DISTS.includes(d.duration.dist)) d.duration.dist = 'exp';
  if (!ENVELOPES.includes(d.gain.envelope)) d.gain.envelope = 'hann';
  if (!GLIDE_MODES.includes(d.glide.mode)) d.glide.mode = 'slope';
  if (!PITCH_COMPS.includes(d.gain.pitchComp)) d.gain.pitchComp = 'off';
  if (!SIEVE_OPS.includes(d.pitch.sieve.op)) d.pitch.sieve.op = 'union';
  if (!(d.pitch.sieve.grid in SIEVE_GRIDS)) d.pitch.sieve.grid = 'semitone';
  if (!Array.isArray(d.pitch.sieve.terms)) d.pitch.sieve.terms = [];
  if (d.pitch.min > d.pitch.max) [d.pitch.min, d.pitch.max] = [d.pitch.max, d.pitch.min];
  for (const k of CURVE_KEYS) {
    const c = getCurve(d, k);
    if (!CURVE_ENGINES.includes(c.engine)) c.engine = 'custom';
    if (!Array.isArray(c.customPoints) || c.customPoints.length < 2) c.customPoints = createLinearSplinePoints(0, 1);
  }
  return d;
}

/** The curve object stored at a curve key. / 곡선 키의 곡선 객체 */
export function getCurve(doc, key) {
  if (key === 'density') return doc.density;
  if (key === 'center') return doc.pitch.center;
  if (key === 'width') return doc.pitch.width;
  return doc.glide.clusterCollapse;
}

/** Value of a time curve at normalized time tn ∈ [0, 1]. / 시간 곡선 값 */
export function evalCloudCurve(curve, tn, key) {
  const r = CURVE_RANGES[key];
  const lo = Number(curve?.lo);
  const hi = Number(curve?.hi);
  const a = Number.isFinite(lo) ? lo : r.min;
  const b = Number.isFinite(hi) ? hi : a;
  if (a === b) return clamp(a, r.min, r.max);
  return clamp(a + (b - a) * evaluateCurveObjectY(curve, tn, { regions: false }), r.min, r.max);
}

/** Dense lookup table of a curve (index i ↔ tn = i/(n−1)). / 곡선 조회 테이블 */
export function curveTable(curve, key, n = TABLE_N) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = evalCloudCurve(curve, i / (n - 1), key);
  return out;
}

function lookupTable(tab, tn) {
  const x = clamp(tn, 0, 1) * (tab.length - 1);
  const i = Math.min(tab.length - 2, Math.floor(x));
  const f = x - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
}

/** Parameters that change the event list (timbre, view, scheduler do not). / 시그니처 */
export function cloudSignature(doc) {
  const { seed, length, density, pitch, glide, duration, gain, maxEvents, maxPolyphony } = doc;
  return JSON.stringify({ seed, length, density, pitch, glide, duration, gain, maxEvents, maxPolyphony });
}

// ==========================================================================
// Seeded samplers (pure; each takes the PRNG) / 시드 샘플러
// ==========================================================================

/** Independent deterministic sub-streams so e.g. a pitch edit never moves event times. */
export function subStream(seed, k) {
  return createSeededRandom((Math.imul((seed >>> 0) ^ 0x5bd1e995, 0x9e3779b1) + Math.imul(k + 1, 0x85ebca77)) >>> 0);
}
const open01 = (rng) => { const u = rng(); return u <= 0 ? 1e-12 : u >= 1 ? 1 - 1e-12 : u; };

export const sampleUniform = (rng) => 2 * rng() - 1; // U(−1, 1)
/** Box–Muller standard normal (one value per call). / 표준 정규 */
export function sampleGauss(rng) {
  const u1 = open01(rng);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
export const sampleCauchy = (rng) => Math.tan(Math.PI * (open01(rng) - 0.5));
export const sampleLogistic = (rng) => { const u = open01(rng); return Math.log(u / (1 - u)); };
/**
 * Symmetric α-stable S_α(1, 0, 0) by Chambers–Mallows–Stuck. α = 2 → N(0, 2) (σ√2 Gaussian),
 * α = 1 → Cauchy. / 대칭 α-안정 분포 (CMS)
 */
export function sampleLevy(rng, alpha) {
  const a = clamp(alpha, 0.5, 2);
  const V = Math.PI * (open01(rng) - 0.5);
  const W = -Math.log(open01(rng));
  const cosV = Math.cos(V);
  return (Math.sin(a * V) / Math.pow(cosV, 1 / a)) * Math.pow(Math.cos(V - a * V) / W, (1 - a) / a);
}
/** One Brownian increment (Gaussian, RMS = step) plus a drift. / 브라운 증분 */
export const brownianStep = (rng, step, drift = 0) => drift + step * sampleGauss(rng);

/** Reflect x into [lo, hi] (repeated folding). / 반사 경계 */
export function reflectInto(x, lo, hi) {
  if (!(hi > lo)) return lo;
  const span = hi - lo;
  let y = (x - lo) % (2 * span);
  if (y < 0) y += 2 * span;
  return lo + (y > span ? 2 * span - y : y);
}

/** Standardized draw for a (non-Brownian) distribution. / 표준화 표본 */
function sampleStd(dist, rng, alpha) {
  switch (dist) {
    case 'uniform': return sampleUniform(rng);
    case 'cauchy': return sampleCauchy(rng);
    case 'logistic': return sampleLogistic(rng);
    case 'levy': return sampleLevy(rng, alpha);
    default: return sampleGauss(rng);
  }
}

/**
 * Theoretical PDF of p for the non-Brownian distributions (null when no closed form).
 * width = half-width (uniform), σ (gauss), γ (cauchy), s (logistic), scale (lévy).
 * 이론 확률밀도 (닫힌 형태가 없으면 null).
 */
export function distributionPdf(dist, x, c, w, alpha = 1.5) {
  const s = Math.max(1e-6, w);
  const z = (x - c) / s;
  switch (dist) {
    case 'uniform': return Math.abs(z) <= 1 ? 1 / (2 * s) : 0;
    case 'gauss': return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
    case 'cauchy': return 1 / (Math.PI * s * (1 + z * z));
    case 'logistic': { const e = Math.exp(-Math.abs(z)); return e / (s * (1 + e) * (1 + e)); }
    case 'levy': return levyPdfStd(z, alpha) / s;
    default: return null;
  }
}

const levyPdfCache = new Map();
/** Numerical standard α-stable PDF (inverse Fourier of e^(−|k|^α)), cached per α. */
function levyPdfStd(z, alpha) {
  const a = roundTo(clamp(alpha, 0.5, 2), 3);
  let tab = levyPdfCache.get(a);
  if (!tab) {
    // f(z) = (1/π) ∫₀^∞ cos(kz) e^(−k^α) dk on z ∈ [−20, 20] / 수치 적분
    const N = 801;
    const zs = new Float64Array(N);
    const K = 2000;
    const kMax = 40;
    const dk = kMax / K;
    for (let i = 0; i < N; i++) {
      const zz = -20 + (40 * i) / (N - 1);
      let sum = 0;
      for (let j = 0; j <= K; j++) {
        const k = j * dk;
        const w = j === 0 || j === K ? 0.5 : 1;
        sum += w * Math.cos(k * zz) * Math.exp(-Math.pow(k, a));
      }
      zs[i] = Math.max(0, (sum * dk) / Math.PI);
    }
    tab = zs;
    if (levyPdfCache.size > 16) levyPdfCache.clear();
    levyPdfCache.set(a, tab);
  }
  if (Math.abs(z) >= 20) return 0;
  const x = ((z + 20) / 40) * (tab.length - 1);
  const i = Math.min(tab.length - 2, Math.floor(x));
  return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
}

// ==========================================================================
// Sieves (Xenakis) / 체
// ==========================================================================

/** True when grid index k passes one term { mod, residues[], shift }. / 항 판정 */
export function sieveTermHas(term, k) {
  const m = Math.max(1, Math.round(Number(term?.mod) || 1));
  const r = (((k - Math.round(Number(term?.shift) || 0)) % m) + m) % m;
  return Array.isArray(term?.residues) && term.residues.some((x) => ((Math.round(x) % m) + m) % m === r);
}

/**
 * Sorted allowed pitches of a sieve within [lo, hi]. Moduli count grid steps (semitone,
 * ¼-tone or ⅛-tone). No terms → every grid point. / 체의 허용 음고 집합 (정렬)
 */
export function buildSieveSet(sieve, lo, hi, termsOverride = null) {
  const g = SIEVE_GRIDS[sieve?.grid] || 1;
  const terms = termsOverride || (Array.isArray(sieve?.terms) ? sieve.terms : []);
  const inter = sieve?.op === 'inter';
  const out = [];
  for (let k = Math.ceil(lo / g - 1e-9); k * g <= hi + 1e-9; k++) {
    const ok = !terms.length || (inter ? terms.every((t) => sieveTermHas(t, k)) : terms.some((t) => sieveTermHas(t, k)));
    if (ok) out.push(roundTo(k * g, 6));
  }
  return Float64Array.from(out);
}

/** Nearest element of a sorted set (the value itself when the set is empty). / 가장 가까운 원소 */
export function snapToSet(set, p) {
  const n = set.length;
  if (!n) return p;
  if (p <= set[0]) return set[0];
  if (p >= set[n - 1]) return set[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (set[mid] <= p) lo = mid;
    else hi = mid;
  }
  return p - set[lo] <= set[hi] - p ? set[lo] : set[hi];
}

// ==========================================================================
// Envelopes / 포락선
// ==========================================================================

/** Envelope value at x ∈ [0, 1]; always 0 at both ends (click-free). / 포락선 (양끝 0) */
export function envelopeAt(type, x, dur, attack) {
  if (x <= 0 || x >= 1) return 0;
  if (type === 'tukey') {
    const a = clamp(attack / Math.max(1e-4, dur), 0.002, 0.5);
    if (x < a) return 0.5 * (1 - Math.cos((Math.PI * x) / a));
    if (x > 1 - a) return 0.5 * (1 - Math.cos((Math.PI * (1 - x)) / a));
    return 1;
  }
  if (type === 'expdecay') {
    const a = clamp(attack / Math.max(1e-4, dur), 0.005, 0.5);
    if (x < a) return 0.5 * (1 - Math.cos((Math.PI * x) / a));
    const tail = Math.min(1, (1 - x) / 0.05);
    return Math.exp((-6.9 * (x - a)) / (1 - a)) * tail;
  }
  const s = Math.sin(Math.PI * x);
  return s * s;
}

/** Envelope as n samples (Float32Array, first and last 0). / 포락선 샘플 배열 */
export function envelopeCurve(type, dur, attack, n = 48, out = null) {
  const arr = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = envelopeAt(type, i / (n - 1), dur, attack);
  arr[0] = 0;
  arr[n - 1] = 0;
  return arr;
}

/** Gain-point positions per event for the bake (exact breakpoints for tukey/expdecay). */
function envelopeKnots(type, dur, attack) {
  if (type === 'hann') return ENV_POINTS.hann;
  const a = clamp(attack / Math.max(1e-4, dur), type === 'tukey' ? 0.002 : 0.005, 0.5);
  if (type === 'tukey') return [0, a / 2, a, 1 - a, 1 - a / 2, 1];
  return [0, a / 2, a, a + (1 - a) * 0.2, a + (1 - a) * 0.5, 0.95, 1];
}

/** Gentle equal-loudness compensation (half of the inverse A-weighting, −6…+12 dB). */
export function equalLoudGain(midi) {
  const f = midiToFreq(midi);
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  const aDb = 20 * Math.log10(Math.max(1e-9, ra)) + 2.0;
  return Math.pow(10, clamp(-0.5 * aDb, -6, 12) / 20);
}

// ==========================================================================
// Event generation (the bake) / 이벤트 생성 (베이킹)
// ==========================================================================

let bakeCount = 0;
const cache = new Map(); // signature → result (LRU, 6 entries)
export const getBakeCount = () => bakeCount;

/**
 * Event list for a document — memoised by signature, so the same input returns the same
 * (identical) object and never re-generates during playback.
 * 문서의 이벤트 목록 (시그니처 캐시: 같은 입력이면 같은 객체).
 */
export function bakeCloudEvents(rawDoc) {
  const doc = normalizeCloudParams(rawDoc);
  const sig = cloudSignature(doc);
  const hit = cache.get(sig);
  if (hit) {
    cache.delete(sig);
    cache.set(sig, hit);
    return hit;
  }
  const res = generateCloudEvents(doc);
  res.sig = sig;
  bakeCount++;
  cache.set(sig, res);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return res;
}

/** Uncached generation (pure, deterministic). / 캐시 없는 생성 */
export function generateCloudEvents(rawDoc) {
  const doc = normalizeCloudParams(rawDoc);
  const T = doc.length;
  const { pitch, glide, duration, gain } = doc;
  const rT = subStream(doc.seed, 0);
  const rP = subStream(doc.seed, 1);
  const rG = subStream(doc.seed, 2);
  const rD = subStream(doc.seed, 3);
  const rA = subStream(doc.seed, 4);
  const tabs = {};
  for (const k of CURVE_KEYS) tabs[k] = curveTable(getCurve(doc, k), k);

  // 1. Inhomogeneous Poisson by inversion of Λ(t) (λ piecewise-constant per cell).
  //    Unit-rate arrivals E_k = Σ Exp(1) are mapped through Λ⁻¹. / 누적 강도 역변환
  const N = TABLE_N - 1;
  const dt = T / N;
  const cum = new Float64Array(N + 1);
  const lam = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    lam[i] = 0.5 * (tabs.density[i] + tabs.density[i + 1]);
    cum[i + 1] = cum[i] + lam[i] * dt;
  }
  const total = cum[N];
  const times = [];
  let E = -Math.log(open01(rT));
  let cell = 0;
  let truncated = false;
  while (E < total) {
    if (times.length >= doc.maxEvents) { truncated = true; break; }
    while (cell < N - 1 && cum[cell + 1] <= E) cell++;
    times.push(Math.min(T, (cell + (E - cum[cell]) / lam[cell]) * dt));
    E += -Math.log(open01(rT));
  }

  // 2. Attributes / 속성
  const sieveSet = pitch.sieve.enabled ? buildSieveSet(pitch.sieve, pitch.min, pitch.max) : null;
  const useSieve = !!(sieveSet && sieveSet.length);
  const g = SIEVE_GRIDS[pitch.sieve.grid] || 1;
  const inSet = (p) => { const s = snapToSet(sieveSet, p); return Math.abs(s - p) < 1e-6; };
  const ev = { t0: [], dur: [], p0: [], p1: [], gain: [], pan: [] };
  let droppedSieve = 0;
  let prev = NaN;
  const drawPitch = (tn) => {
    const c = lookupTable(tabs.center, tn);
    const w = lookupTable(tabs.width, tn) * (1 - clamp(lookupTable(tabs.collapse, tn), 0, 1));
    if (pitch.dist === 'brownian') {
      if (!Number.isFinite(prev)) prev = c;
      const lo = Math.max(pitch.min, c - w);
      const hi = Math.min(pitch.max, c + w);
      prev = hi > lo ? reflectInto(prev + brownianStep(rP, pitch.brownStep, pitch.brownDrift), lo, hi) : clamp(c, pitch.min, pitch.max);
      return prev;
    }
    let p = c + w * sampleStd(pitch.dist, rP, pitch.levyAlpha);
    for (let k = 0; k < 8 && (p < pitch.min || p > pitch.max); k++) p = c + w * sampleStd(pitch.dist, rP, pitch.levyAlpha);
    return clamp(p, pitch.min, pitch.max);
  };
  const drawDur = () => {
    const { min, max, mean } = duration;
    let d;
    if (duration.dist === 'uniform') d = min + (max - min) * rD();
    else if (duration.dist === 'lognormal') { const sg = 0.6; d = Math.exp(Math.log(Math.max(1e-3, mean)) - 0.5 * sg * sg + sg * sampleGauss(rD)); }
    else d = -Math.log(open01(rD)) * mean;
    return clamp(d, Math.min(min, max), Math.max(min, max));
  };

  for (const t0 of times) {
    const tn = t0 / T;
    let p0 = drawPitch(tn);
    let d = drawDur();
    const up = rG() < clamp(glide.upBias, 0, 1);
    const mag = Math.abs(glide.slopeMean + glide.slopeSpread * sampleGauss(rG));
    const gRaw = gain.base * (1 + gain.spread * sampleUniform(rA));
    const pan = sampleUniform(rA);
    d = Math.min(d, T - t0);
    if (d < 0.03) continue; // too close to the end / 끝에 너무 가까움
    let p1;
    if (glide.mode === 'target') {
      p1 = drawPitch(Math.min(1, (t0 + d) / T));
      if ((p1 > p0) !== up && p1 !== p0) [p0, p1] = [p1, p0];
    } else {
      p1 = p0 + (up ? 1 : -1) * mag * d;
    }
    p1 = clamp(p1, pitch.min, pitch.max);
    if (useSieve) {
      if (!pitch.snapSieve) {
        const r0 = Math.round(p0 / g) * g;
        if (!inSet(r0)) { droppedSieve++; continue; }
        p0 = r0;
      } else p0 = snapToSet(sieveSet, p0);
      p1 = snapToSet(sieveSet, p1);
    }
    let gv = gRaw;
    if (gain.pitchComp === 'equalLoud') gv *= equalLoudGain(0.5 * (p0 + p1));
    ev.t0.push(t0); ev.dur.push(d); ev.p0.push(p0); ev.p1.push(p1); ev.gain.push(clamp(gv, 0, 1)); ev.pan.push(pan);
  }

  // 3. Polyphony cap: drop the quietest (then oldest, then lowest index). / 폴리포니 제한
  const n0 = ev.t0.length;
  const keep = new Uint8Array(n0).fill(1);
  const active = [];
  const maxPoly = doc.maxPolyphony;
  let droppedPoly = 0;
  for (let i = 0; i < n0; i++) {
    for (let k = active.length - 1; k >= 0; k--) if (ev.t0[active[k]] + ev.dur[active[k]] <= ev.t0[i]) active.splice(k, 1);
    if (active.length < maxPoly) { active.push(i); continue; }
    let victim = i;
    for (const j of active) {
      const a = ev.gain[j];
      const b = ev.gain[victim];
      if (a < b || (a === b && (ev.t0[j] < ev.t0[victim] || (ev.t0[j] === ev.t0[victim] && j < victim)))) victim = j;
    }
    keep[victim] = 0;
    droppedPoly++;
    if (victim !== i) { active.splice(active.indexOf(victim), 1); active.push(i); }
  }

  // 4. Struct-of-arrays / SoA 배열
  let n = 0;
  for (let i = 0; i < n0; i++) n += keep[i];
  const out = { n, t0: new Float32Array(n), dur: new Float32Array(n), p0: new Float32Array(n), p1: new Float32Array(n), gain: new Float32Array(n), pan: new Float32Array(n) };
  let maxDur = 0;
  let sumDur = 0;
  for (let i = 0, j = 0; i < n0; i++) {
    if (!keep[i]) continue;
    out.t0[j] = ev.t0[i]; out.dur[j] = ev.dur[i]; out.p0[j] = ev.p0[i]; out.p1[j] = ev.p1[i]; out.gain[j] = ev.gain[i]; out.pan[j] = ev.pan[i];
    maxDur = Math.max(maxDur, out.dur[j]);
    sumDur += out.dur[j];
    j++;
  }
  out.maxDur = maxDur;
  out.length = T;
  out.envelope = gain.envelope;
  out.attack = gain.attack;
  out.stats = {
    generated: times.length,
    expected: total,
    truncated,
    droppedSieve,
    droppedPoly,
    events: n,
    maxOverlap: maxOverlap(out),
    meanOverlap: sumDur / T,
    sieveSize: sieveSet ? sieveSet.length : 0,
  };
  out.levelScale = gain.autoLevel ? 1 / Math.sqrt(Math.max(1, out.stats.meanOverlap)) : 1;
  return out;
}

/** Maximum number of simultaneously sounding events (extended by `pad` seconds). / 최대 중첩 */
export function maxOverlap(ev, pad = 0, mask = null) {
  const pts = [];
  for (let i = 0; i < ev.n; i++) {
    if (mask && !mask[i]) continue;
    pts.push([ev.t0[i], 1], [ev.t0[i] + ev.dur[i] + pad, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at equal times / 같은 시각엔 끝 먼저
  let cur = 0;
  let best = 0;
  for (const [, d] of pts) { cur += d; if (cur > best) best = cur; }
  return best;
}

/** First event index whose t0 ≥ sec (events are sorted by t0). / 이분 탐색 */
export function lowerBound(t0, n, sec) {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t0[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** MIDI of event i at absolute time sec (straight line in MIDI = exponential in Hz). */
export const eventMidiAt = (ev, i, sec) => ev.p0[i] + (ev.p1[i] - ev.p0[i]) * clamp((sec - ev.t0[i]) / ev.dur[i], 0, 1);

/** Pitch histogram of event onsets within [tA, tB). / 구간 피치 히스토그램 */
export function pitchHistogram(ev, tA, tB, lo, hi, binW = 0.5) {
  const bins = Math.max(1, Math.ceil((hi - lo) / binW));
  const counts = new Float64Array(bins);
  let total = 0;
  for (let i = lowerBound(ev.t0, ev.n, tA); i < ev.n && ev.t0[i] < tB; i++) {
    const b = Math.floor((ev.p0[i] - lo) / binW);
    if (b >= 0 && b < bins) counts[b]++;
    total++;
  }
  return { counts, total, bins, binW };
}

// ==========================================================================
// Lanes (interval-graph colouring) & Glissando voices / 레인 할당 · 글리산도 보이스
// ==========================================================================

/**
 * Greedy colouring in start order: each event goes to the lowest lane that is free (previous
 * end + gap ≤ t0). The lane count equals the maximum overlap of the gap-extended intervals.
 * 시작 순 그리디: 가장 앞의 빈 레인에 배치 → 레인 수 = 최대 중첩.
 */
export function assignLanes(ev, { gap = LANE_GAP_SEC, mask = null } = {}) {
  const lane = new Int32Array(ev.n).fill(-1);
  const free = [];
  for (let i = 0; i < ev.n; i++) {
    if (mask && !mask[i]) continue;
    let l = 0;
    while (l < free.length && free[l] > ev.t0[i] + 1e-9) l++;
    if (l === free.length) free.push(0);
    free[l] = ev.t0[i] + ev.dur[i] + gap;
    lane[i] = l;
  }
  return { lane, laneCount: free.length };
}

/**
 * Keep events so that at most maxLanes lanes are needed: loudest first, accepted only if the
 * binned coverage stays below maxLanes (conservative → never exceeds). / 레인 상한 맞추기
 */
export function selectForLanes(ev, maxLanes = MAX_BAKE_VOICES, gap = LANE_GAP_SEC) {
  const all = new Uint8Array(ev.n).fill(1);
  if (maxOverlap(ev, gap) <= maxLanes) return { mask: all, dropped: 0 };
  const BIN = 0.005;
  const bins = new Uint16Array(Math.ceil((ev.length + gap + 1) / BIN) + 2);
  const order = Array.from({ length: ev.n }, (_, i) => i).sort((a, b) => ev.gain[b] - ev.gain[a] || ev.t0[a] - ev.t0[b] || a - b);
  const mask = new Uint8Array(ev.n);
  let dropped = 0;
  for (const i of order) {
    const a = Math.floor(ev.t0[i] / BIN);
    const b = Math.floor((ev.t0[i] + ev.dur[i] + gap) / BIN);
    let ok = true;
    for (let k = a; k <= b; k++) if (bins[k] >= maxLanes) { ok = false; break; }
    if (!ok) { dropped++; continue; }
    for (let k = a; k <= b; k++) bins[k]++;
    mask[i] = 1;
  }
  return { mask, dropped };
}

/**
 * Convert the cached events into ≤ maxVoices Glissando voices (one lane or lane chunk each).
 * Pitch is EXACT: log-Hz glides are straight lines in MIDI, and the voice maps y linearly to
 * MIDI between F0 and F1 (logScale). Envelopes become gain points; pan and phase are lost.
 * 이벤트 → 글리산도 보이스 (음고는 정확, 포락선은 게인 포인트 근사, pan·위상 손실).
 * @returns {{ voices: object[], report: object }}
 */
export function cloudEventsToVoices(ev, helpers, { maxVoices = MAX_BAKE_VOICES, anchorBudget = 128, timbre = {}, gap = LANE_GAP_SEC } = {}) {
  const { mask, dropped } = selectForLanes(ev, maxVoices, gap);
  const { lane, laneCount } = assignLanes(ev, { gap, mask });
  const lanes = Array.from({ length: laneCount }, () => []);
  for (let i = 0; i < ev.n; i++) if (lane[i] >= 0) lanes[lane[i]].push(i);
  const knots = (i) => envelopeKnots(ev.envelope, ev.dur[i], ev.attack);
  const perEvent = Math.max(2, knots(0).length || 7);
  let budget = Math.max(16, anchorBudget);
  const chunksFor = (b) => lanes.reduce((s, L) => s + Math.max(1, Math.ceil(L.length / Math.max(1, Math.floor(b / perEvent)))), 0);
  while (chunksFor(budget) > maxVoices && budget < 4096) budget *= 2;
  const perChunk = Math.max(1, Math.floor(budget / perEvent));
  const wave = { sine: 0.8, tri: 0.3, saw: 0.05, sqr: 0, rich: 0.1 };
  for (const k of Object.keys(wave)) if (Number.isFinite(timbre[k])) wave[k] = clamp(timbre[k], 0, 1);

  const voices = [];
  let maxPts = 0;
  lanes.forEach((L, li) => {
    for (let c = 0; c * perChunk < L.length && voices.length < maxVoices; c++) {
      const idx = L.slice(c * perChunk, (c + 1) * perChunk);
      const first = idx[0];
      const last = idx[idx.length - 1];
      const start = ev.t0[first];
      const end = ev.t0[last] + ev.dur[last];
      const dur = Math.max(0.05, end - start);
      let lo = Infinity;
      let hi = -Infinity;
      let gMax = 0;
      for (const i of idx) {
        lo = Math.min(lo, ev.p0[i], ev.p1[i]);
        hi = Math.max(hi, ev.p0[i], ev.p1[i]);
        gMax = Math.max(gMax, ev.gain[i]);
      }
      if (hi - lo < 0.01) hi = lo + 1;
      const f0Hz = roundTo(midiToFreq(lo), 3);
      const f1Hz = roundTo(midiToFreq(hi), 3);
      const loM = freqToMidi(f0Hz);
      const hiM = freqToMidi(f1Hz);
      const yOf = (m) => roundTo((m - loM) / (hiM - loM), 6);
      const xOf = (sec) => clamp((sec - start) / dur, 0, 1);
      const customPoints = [];
      const gainPoints = [];
      const push = (arr, x, y) => {
        const px = arr.length ? Math.max(roundTo(x, 7), arr[arr.length - 1].x + 1e-7) : 0;
        arr.push({ x: Math.min(1, px), y, handles: [] });
      };
      let prevEnd = -Infinity;
      let prevY = 0;
      for (const i of idx) {
        // Hold the previous end pitch through the silence, jump in the last JUMP_SEC before the
        // onset (gain is 0 there). / 무음 구간에서는 직전 끝음 유지, 시작 직전 JUMP_SEC에서 점프
        const holdAt = ev.t0[i] - JUMP_SEC;
        if (holdAt > prevEnd + 1e-4) push(customPoints, xOf(holdAt), prevY);
        push(customPoints, xOf(ev.t0[i]), yOf(ev.p0[i]));
        prevEnd = ev.t0[i] + ev.dur[i];
        prevY = yOf(ev.p1[i]);
        push(customPoints, xOf(ev.t0[i] + ev.dur[i]), yOf(ev.p1[i]));
        const g = gMax > 0 ? ev.gain[i] / gMax : 0;
        for (const u of knots(i)) push(gainPoints, xOf(ev.t0[i] + u * ev.dur[i]), roundTo(g * envelopeAt(ev.envelope, u, ev.dur[i], ev.attack), 5));
      }
      customPoints[customPoints.length - 1].x = 1;
      gainPoints[gainPoints.length - 1].x = 1;
      maxPts = Math.max(maxPts, customPoints.length, gainPoints.length);
      const part = L.length > perChunk ? `·${c + 1}` : '';
      voices.push(helpers.createDefaultVoice(helpers.startIndex + voices.length, {
        name: `Cloud L${li + 1}${part}`,
        startTime: roundTo(start, 6),
        duration: roundTo(dur, 6),
        baseGain: roundTo(clamp(gMax * ev.levelScale * 1.4, 0, 1.5), 4),
        f0Hz, f1Hz, f0Fine: 0, f1Fine: 0,
        logScale: true,
        timbreMode: timbreSpecMode(timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
        timbreFunc: timbreSpecFunc(timbre),
        timbre: { ...wave },
        engine: 'custom',
        lastNonCustomEngine: 'harmonic',
        customPoints,
        gainMode: 'points',
        gainUnit: 'amp',
        gainPoints,
      }));
    }
  });
  const kept = mask.reduce((s, x) => s + x, 0);
  return { voices, report: { lanes: laneCount, voices: voices.length, kept, dropped, anchorBudget: budget, maxPoints: maxPts } };
}

/** MIDI of a baked voice at absolute time sec (reads its custom points). / 보이스 음고 */
export function voiceMidiAt(v, sec) {
  const y = evalPiecewiseBezierPoints(v.customPoints, (sec - v.startTime) / v.duration);
  const lo = freqToMidi(v.f0Hz);
  const hi = freqToMidi(v.f1Hz);
  return lo + y * (hi - lo);
}
