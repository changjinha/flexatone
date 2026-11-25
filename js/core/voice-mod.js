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
 * Advanced randomizer (adv = true; the simple sliders stay the defaults) / 고급 랜덤화
 *   per lane: rateSpread (oct) · depthSpread · phaseSpread replace the single spread;
 *   dist shapes u₁: uniform | center (u³ — most voices near the base rate, a few outliers) | split (two groups ±);
 *   drift: each voice's rate wanders slowly, rate·(1 + ½·drift·sin(2π·fᵈ·t + 2π·u₃)), fᵈ = 0.05…0.15 Hz;
 *   env: the band-follow envelope [{x: band place 0…1, y: oct}] replaces track·(2b − 1).
 *   rateᵢ = rate · 2^(rateSpread·D(u₁) + env(b)),  depthᵢ = depth·(1 − ½·depthSpread·(1 + u₂)),
 *   phaseᵢ = phaseSpread·(u₃ + 1)/2
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

export const VMOD_DISTS = Object.freeze(['uniform', 'center', 'split']);
export const VMOD_ENV_POINTS = 17; // band-follow envelope table size sent to DSP loops / DSP용 포락선 표 크기
export const VMOD_DRIFT_HZ = 0.1;

export function createDefaultVoiceMod() {
  return {
    seed: 1,
    adv: false,
    trem: { on: false, rate: 5, depth: 0.5, spread: 0.5, track: 0, rateSpread: 0.5, depthSpread: 0.25, phaseSpread: 0.5, dist: 'uniform', drift: 0, env: null },
    vib: { on: false, rate: 5.5, cents: 25, spread: 0.5, track: 0, rateSpread: 0.5, depthSpread: 0.25, phaseSpread: 0.5, dist: 'uniform', drift: 0, env: null },
  };
}

/** Band-follow envelope from the simple slider: −track at the bottom of the band … +track at the top. / 단순 슬라이더 → 포락선 */
export function trackToEnv(track) {
  const k = clamp(Number(track) || 0, -VMOD_TRACK_MAX, VMOD_TRACK_MAX);
  return [{ x: 0, y: -k }, { x: 1, y: k }];
}

function normEnv(raw) {
  if (!Array.isArray(raw)) return null;
  const pts = raw
    .map((p) => ({ x: clamp(Number(p?.x), 0, 1), y: clamp(Number(p?.y), -VMOD_TRACK_MAX, VMOD_TRACK_MAX) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x)
    .slice(0, 32);
  return pts.length >= 1 ? pts : null;
}

/** Envelope value (oct) at band place b ∈ [0, 1], linear between points, held past the ends. / 포락선 값 */
export function envAt(pts, b) {
  if (!pts || !pts.length) return 0;
  if (b <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (b <= p.x) { const q = pts[i - 1]; return p.x > q.x ? q.y + ((p.y - q.y) * (b - q.x)) / (p.x - q.x) : p.y; }
  }
  return pts[pts.length - 1].y;
}

/** Envelope sampled at VMOD_ENV_POINTS band places (the table the DSP loops read). / DSP용 표 */
export function envTable(pts) {
  const out = new Array(VMOD_ENV_POINTS);
  for (let i = 0; i < VMOD_ENV_POINTS; i++) out[i] = envAt(pts, i / (VMOD_ENV_POINTS - 1));
  return out;
}

/** Shape of u by the distribution. / 분포 변환 */
export function distU(dist, u) {
  if (dist === 'center') return u * u * u;
  if (dist === 'split') return u < 0 ? -1 : 1;
  return u;
}

const fin = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);

function lane(raw, d, depthKey, depthMax) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const spread = clamp(fin(s.spread, d.spread), 0, 1);
  return {
    on: s.on === true,
    rate: clamp(fin(s.rate, d.rate), VMOD_RATE_MIN, VMOD_RATE_MAX),
    [depthKey]: clamp(fin(s[depthKey], d[depthKey]), 0, depthMax),
    spread,
    track: clamp(fin(s.track, d.track), -VMOD_TRACK_MAX, VMOD_TRACK_MAX),
    // advanced (used when adv = true); they start from the simple spread / 고급 (단순 값에서 출발)
    rateSpread: clamp(fin(s.rateSpread, spread), 0, 2),
    depthSpread: clamp(fin(s.depthSpread, spread / 2), 0, 1),
    phaseSpread: clamp(fin(s.phaseSpread, spread), 0, 1),
    dist: VMOD_DISTS.includes(s.dist) ? s.dist : 'uniform',
    drift: clamp(fin(s.drift, 0), 0, 1),
    env: normEnv(s.env),
  };
}

/** Fill defaults and clamp. / 정규화 */
export function normalizeVoiceMod(raw) {
  const d = createDefaultVoiceMod();
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    seed: Math.round(clamp(fin(s.seed, d.seed), 0, 99999)),
    adv: s.adv === true,
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
 * Compact form for a DSP loop (the Risset control frame, the Wave bank): null when nothing modulates.
 * Each lane = [on, rate, depth|cents, rateSpread, rateK, depthK, phaseSpread, dist, drift, driftHz]
 * with the simple mode written in the same terms (rateSpread = spread, depthK = ½·spread·…), and
 * tE / vE = the band-follow table (VMOD_ENV_POINTS values in oct over the band, 0 … 1).
 * dist: 0 uniform · 1 center · 2 split. / DSP 루프용 압축 형태 (단순 모드도 같은 형식으로)
 */
export function voiceModFrame(cfg) {
  const c = normalizeVoiceMod(cfg);
  if (!isVoiceModOn(c)) return null;
  const laneOf = (L, depthKey) => {
    const on = L.on && L[depthKey] > 0 ? 1 : 0;
    if (!c.adv) return { a: [on, L.rate, L[depthKey], L.spread, 0.25 * L.spread, L.spread, 0, 0, 0], e: envTable(trackToEnv(L.track)) };
    return { a: [on, L.rate, L[depthKey], L.rateSpread, 0.5 * L.depthSpread, L.phaseSpread, VMOD_DISTS.indexOf(L.dist), L.drift, 0], e: envTable(L.env || trackToEnv(L.track)) };
  };
  const T = laneOf(c.trem, 'depth');
  const V = laneOf(c.vib, 'cents');
  return { seed: c.seed, t: T.a, v: V.a, tE: T.e, vE: V.e };
}

/**
 * One voice's numbers for one lane of a frame: rate (Hz, before drift), depth (fraction / cents),
 * phase offset, drift amount and drift (rate, phase). Shared by the curve evaluator and the UI.
 * 프레임의 한 레인에서 보이스 하나의 값 (속도·깊이·위상·표류).
 */
export function voiceLaneParams(q, table, seed, index, k0, b01) {
  const u = (k) => voiceRand(seed, index, k0 + k);
  const dist = VMOD_DISTS[q[6] | 0] || 'uniform';
  const rate = q[1] * 2 ** (q[3] * distU(dist, u(0)) + envAt01(table, b01));
  const depth = q[2] * (1 - q[4] * (u(1) + 1));
  const phase = q[5] * 0.5 * (u(2) + 1);
  const drift = 0.5 * q[7];
  const dHz = VMOD_DRIFT_HZ * (1 + 0.5 * voiceRand(seed, index, k0 + 7));
  const dPh = 0.5 * (voiceRand(seed, index, k0 + 8) + 1);
  return { rate, depth, phase, drift, dHz, dPh };
}

/** Table lookup (VMOD_ENV_POINTS values over b ∈ [0, 1]), linear. / 표 보간 */
export function envAt01(table, b) {
  if (!table) return 0;
  const n = table.length;
  const x = clamp(b, 0, 1) * (n - 1);
  const k = Math.min(n - 2, Math.floor(x));
  return table[k] + (table[k + 1] - table[k]) * (x - k);
}

/** LFO phase (cycles) at t of a voice with drift: ∫ rate·(1 + a·sin(2π(fᵈt + φᵈ))) dt. / 표류 포함 위상 */
export function lanePhase(L, t) {
  if (!L.drift) return L.rate * t;
  const w = 2 * Math.PI * L.dHz;
  return L.rate * (t - (L.drift / w) * (Math.cos(w * t + 2 * Math.PI * L.dPh) - Math.cos(2 * Math.PI * L.dPh)));
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
  const b01 = clamp((Number(refMidi) - 24) / 84, 0, 1);
  const TAU = 2 * Math.PI;
  const T = f.t[0] ? voiceLaneParams(f.t, f.tE, f.seed, index, 0, b01) : null;
  const V = f.v[0] ? voiceLaneParams(f.v, f.vE, f.seed, index, 3, b01) : null;
  return {
    gain: T && T.rate ? (t) => 1 - T.depth * (0.5 - 0.5 * Math.cos(TAU * (lanePhase(T, t) + T.phase))) : () => 1,
    cents: V && V.rate ? (t) => V.depth * Math.sin(TAU * (lanePhase(V, t) + V.phase)) : () => 0,
    rateMax: Math.max(T ? T.rate * (1 + T.drift) : 0, V ? V.rate * (1 + V.drift) : 0),
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

/**
 * Sampler for drawing (Risset window): (index, band place b ∈ [0, 1], t s) → { gain, semis } —
 * the tremolo gain and vibrato offset a voice has at time t. Null when nothing modulates.
 * 그리기용 표본기: 보이스의 트레몰로 이득과 비브라토 오프셋.
 * @returns {((index: number, b01: number, t: number) => { gain: number, semis: number }) | null}
 */
export function voiceModSampler(cfg) {
  const f = voiceModFrame(cfg);
  if (!f) return null;
  const TAU = 2 * Math.PI;
  return (index, b01, t) => {
    let gain = 1;
    let semis = 0;
    if (f.t[0]) { const L = voiceLaneParams(f.t, f.tE, f.seed, index, 0, b01); gain = 1 - L.depth * (0.5 - 0.5 * Math.cos(TAU * (lanePhase(L, t) + L.phase))); }
    if (f.v[0]) { const L = voiceLaneParams(f.v, f.vE, f.seed, index, 3, b01); semis = (L.depth / 100) * Math.sin(TAU * (lanePhase(L, t) + L.phase)); }
    return { gain, semis };
  };
}
