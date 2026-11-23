/**
 * Flexatone — studios/chaos-studio.js
 * Layer 2 (studios): Chaos Studio plugin — sonified trajectories of chaotic dynamical systems.
 * 계층 2 (studios): 카오스 스튜디오 플러그인 — 카오스 동역학계 궤적의 글리산도 소리화.
 *
 * N voices start a hair apart (spread) on the same attractor; the "butterfly effect" is heard as
 * they drift out of unison and seen in the divergence graph. The document lives in
 * appState.studioParams.chaos (saved, undoable). Integration + baking is in
 * studios/chaos/chaos-engine.js (pure); UI / audio tiers live in studios/chaos/chaos-*.js and are
 * mounted by ui/studio-host.js — this file stays DOM- and audio-free.
 * 문서는 appState.studioParams.chaos (저장·실행 취소). 이 파일은 DOM·오디오 의존 없음.
 *
 * Bake to Glissando Voices: each chaos voice → 1..k standard Voices (engine 'custom', log pitch
 * lo→hi, gain points). Long chaotic curves are split into back-to-back time segments so each
 * spline keeps ≤ ~40 extrema; hold-mode steps are written as exact linear anchors. Lost in the
 * bake: stereo width (pan) and the Bright → low-pass modulation.
 * Imports: core/*, modules/*, studios/registry.js, studios/chaos/*.
 */

import { clamp, roundTo, deepClone, rk4Step } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { appState, registerSelfCheck, withIsolatedState } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import './chaos/chaos-i18n.js'; // merges EN/KO strings before the tabs are drawn / 탭 표시 전 문자열 병합
import {
  CHAOS_SYSTEMS,
  BAKE_RATE,
  MAX_CHAOS_VOICES,
  getChaosSystem,
  systemSources,
  defaultSystemParams,
  resolveSystemParams,
  createRK4,
  bakeChaos,
  bakeChaosTrajectories,
  getBakeCount,
  getMapCount,
  defaultChaosAxes,
  resolveAxes,
} from './chaos/chaos-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const CHAOS_ID = 'chaos';
export const CHAOS_COLORS = Object.freeze([
  '#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa',
  '#facc15', '#2dd4bf', '#f97316', '#e879f9', '#4ade80', '#93c5fd', '#fda4af', '#d9f99d',
]);
export const PRESET_IDS = Object.freeze(['butterfly', 'twoScrolls', 'drivenBell', 'bifurcation', 'dpendPair']);

/** Default document (Butterfly preset). / 기본 문서 */
export function createDefaultChaosParams() {
  return {
    preset: 'butterfly',
    system: 'lorenz',
    params: { sigma: 10, rho: 28, beta: 8 / 3 },
    seed: 1,
    voices: 8,
    spread: 1e-6,
    dt: 0.005,
    transient: 20,
    simTime: 60,
    duration: 30,
    map: {
      pitch: { source: 'x', lo: 36, hi: 84, curve: 'linear', invert: false, quantize: 'off', scale: 'major', root: 0, slewMs: 0, quantAmt: 1, sens: 1 },
      gain: { source: 'z', lo: 0.15, hi: 0.9, curve: 'linear', invert: false },
      bright: { source: 'speed', lo: 0, hi: 1, curve: 'linear', invert: false },
    },
    discrete: { mode: 'hold', rate: 8, glideMs: 40 },
    sweep: { on: false, param: 'rho', from: 20, to: 30 },
    timbre: { sine: 0.7, tri: 0.3, saw: 0.12, sqr: 0, rich: 0.1, baseGain: 0.8, width: 0.6, brightAmt: 0.5 },
    normalize: 'reference',
    view: { proj: 'xz', yaw: 0.6, tilt: 0.35, trailSec: 2.5, axesEdit: false },
    // 3-D mapping axes (A/B/C): target channel, direction, centre, length — see chaos-engine.js.
    // 3D 매핑 축: 대상 채널·방향·중심·길이
    axes: defaultChaosAxes(),
  };
}

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

/** Fill every nested field from the defaults (saved docs may be partial). / 중첩 필드 기본값 채우기 */
export function normalizeChaosDoc(raw) {
  const d = createDefaultChaosParams();
  const r = isObj(raw) ? raw : {};
  const out = { ...d, ...deepClone(r) };
  const sys = getChaosSystem(out.system);
  out.system = sys.id;
  out.params = { ...defaultSystemParams(sys), ...(isObj(r.params) ? r.params : {}) };
  out.map = {};
  for (const k of ['pitch', 'gain', 'bright']) out.map[k] = { ...d.map[k], ...(isObj(r.map?.[k]) ? r.map[k] : {}) };
  for (const k of ['discrete', 'sweep', 'timbre', 'view']) out[k] = { ...d[k], ...(isObj(r[k]) ? r[k] : {}) };
  out.axes = resolveAxes(out);
  return out;
}

/** Chaos document = defaults overlaid with the saved params. / 카오스 문서 */
export function getChaosParams() {
  return normalizeChaosDoc(StudioRegistry.has(CHAOS_ID) ? StudioRegistry.getParams(CHAOS_ID) : null);
}

/**
 * Apply an edit: `fn(draft)` mutates a copy. View-only edits pass { history: false }.
 * 문서 편집 (보기 전용 변경은 history:false).
 */
export function editChaos(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getChaosParams();
  fn(draft);
  return StudioRegistry.setParams(CHAOS_ID, draft, { history, coalesceKey });
}

/** Baked result for the current document (two-stage memoised). / 현재 베이킹 결과 */
export function getChaosBake(doc = getChaosParams()) {
  return bakeChaos(doc);
}

/**
 * Switch the system of a draft: its params, run defaults, sources and projection follow.
 * 시스템 전환: 파라미터·실행 기본값·소스·투영이 함께 바뀜.
 */
export function setChaosSystem(d, id) {
  const sys = getChaosSystem(id);
  d.system = sys.id;
  d.params = defaultSystemParams(sys);
  Object.assign(d, sys.docDefaults);
  const ids = systemSources(sys);
  for (const k of ['pitch', 'gain', 'bright']) if (!ids.includes(d.map[k].source)) d.map[k].source = sys.defaultMap[k];
  d.map.pitch.source = sys.defaultMap.pitch;
  const p0 = sys.params[0];
  if (!sys.params.some((p) => p.id === d.sweep.param)) d.sweep = { on: false, param: p0.id, from: p0.min, to: p0.max };
  d.view.proj = sys.defaultView;
  return d;
}

const PRESETS = {
  butterfly(d) {
    setChaosSystem(d, 'lorenz');
    Object.assign(d, { voices: 8, spread: 1e-6, seed: 1, simTime: 60, duration: 30, normalize: 'reference' });
    d.map.pitch = { ...d.map.pitch, source: 'x', lo: 36, hi: 84, curve: 'linear', invert: false, quantize: 'off', slewMs: 0, quantAmt: 1, sens: 1 };
    d.map.gain = { ...d.map.gain, source: 'z', lo: 0.15, hi: 0.9 };
    d.map.bright = { ...d.map.bright, source: 'speed', lo: 0, hi: 1 };
    d.timbre = { ...d.timbre, sine: 0.7, tri: 0.3, saw: 0.12, sqr: 0, rich: 0.1, width: 0.6, brightAmt: 0.5 };
  },
  twoScrolls(d) {
    setChaosSystem(d, 'rossler');
    Object.assign(d, { voices: 3, spread: 1e-2, seed: 2, simTime: 300, duration: 40 });
    d.map.pitch = { ...d.map.pitch, source: 'x', lo: 40, hi: 76, curve: 'linear', quantize: 'off', slewMs: 0, quantAmt: 1, sens: 1 };
    d.map.gain = { ...d.map.gain, source: 'radius', lo: 0.25, hi: 0.9 };
    d.map.bright = { ...d.map.bright, source: 'z', lo: 0, hi: 1, curve: 'log' };
    d.timbre = { ...d.timbre, sine: 0.5, tri: 0.5, saw: 0.25, sqr: 0, rich: 0.15, width: 0.8 };
  },
  drivenBell(d) {
    setChaosSystem(d, 'duffing');
    d.params.gamma = 0.5; // γ = 0.37 (system default) is periodic here; 0.5 is chaotic / 0.37은 주기적, 0.5는 카오스
    Object.assign(d, { voices: 4, spread: 1e-4, seed: 3, simTime: 200, duration: 30 });
    d.map.pitch = { ...d.map.pitch, source: 'x', lo: 48, hi: 79, curve: 'linear', quantize: '12tet', slewMs: 0, quantAmt: 1, sens: 1 };
    d.map.gain = { ...d.map.gain, source: 'speed', lo: 0.1, hi: 0.85, curve: 'smooth' };
    d.map.bright = { ...d.map.bright, source: 'speed', lo: 0, hi: 1 };
    d.timbre = { ...d.timbre, sine: 0.9, tri: 0, saw: 0, sqr: 0, rich: 0.55, width: 0.5, brightAmt: 0.7 };
  },
  bifurcation(d) {
    setChaosSystem(d, 'logistic');
    Object.assign(d, { voices: 2, spread: 1e-6, seed: 4, transient: 200, duration: 40 });
    d.sweep = { on: true, param: 'r', from: 2.8, to: 3.99 };
    d.discrete = { mode: 'hold', rate: 8, glideMs: 40 };
    d.map.pitch = { ...d.map.pitch, source: 'x', lo: 48, hi: 84, curve: 'linear', quantize: 'off', slewMs: 0, quantAmt: 1, sens: 1 };
    d.map.gain = { ...d.map.gain, source: 'speed', lo: 0.35, hi: 0.9 };
    d.map.bright = { ...d.map.bright, source: 'x', lo: 0, hi: 1 };
    d.timbre = { ...d.timbre, sine: 0.6, tri: 0.4, saw: 0.2, sqr: 0, rich: 0.05, width: 0.7 };
  },
  dpendPair(d) {
    setChaosSystem(d, 'dpend');
    Object.assign(d, { voices: 2, spread: 1e-5, seed: 5, simTime: 40, duration: 30 });
    d.map.pitch = { ...d.map.pitch, source: 'theta2u', lo: 40, hi: 84, curve: 'linear', quantize: 'off', slewMs: 0, quantAmt: 1, sens: 1 };
    d.map.gain = { ...d.map.gain, source: 'angspeed', lo: 0.2, hi: 0.9 };
    d.map.bright = { ...d.map.bright, source: 'speed', lo: 0, hi: 1 };
    d.timbre = { ...d.timbre, sine: 0.6, tri: 0.3, saw: 0.3, sqr: 0, rich: 0.1, width: 1 };
  },
};

/** Apply a preset to a draft. / 프리셋 적용 */
export function applyChaosPreset(d, id) {
  const fn = PRESETS[id];
  if (!fn) return d;
  d.axes = defaultChaosAxes();
  fn(d);
  d.preset = id;
  return d;
}

// ==========================================================================
// Bake to Glissando / 글리산도 보이스로 베이킹
// ==========================================================================

function countExtrema(ys, a, b) {
  let n = 0;
  let prev = 0;
  for (let j = a + 1; j <= b; j++) {
    const d = ys[j] - ys[j - 1];
    const s = d > 1e-6 ? 1 : d < -1e-6 ? -1 : 0;
    if (s && prev && s !== prev) n++;
    if (s) prev = s;
  }
  return n;
}

const STEP_ANCHORS_PER_SEG = 240;
const EXTREMA_PER_SEG = 36;

/** Linear anchors for a stepped curve on samples [a, b]. / 계단 곡선의 선형 기준점 */
function stepAnchors(ys, a, b) {
  const pts = [{ j: a, y: ys[a] }];
  for (let j = a + 1; j <= b; j++) {
    if (Math.abs(ys[j] - ys[j - 1]) > 1e-7) {
      if (pts[pts.length - 1].j !== j - 1) pts.push({ j: j - 1, y: ys[j - 1] });
      pts.push({ j, y: ys[j] });
    }
  }
  if (pts[pts.length - 1].j !== b) pts.push({ j: b, y: ys[b] });
  const span = Math.max(1, b - a);
  return pts.map((p) => ({ x: roundTo((p.j - a) / span, 6), y: roundTo(p.y, 5), handles: [] }));
}

/** Adaptive spline fit of samples [a, b] (Field-style captureCurveToCustomPoints). / 적응형 스플라인 */
function smoothAnchors(ys, a, b) {
  const n = Math.max(1, b - a);
  const count = Math.min(480, n);
  const dense = [];
  for (let i = 0; i <= count; i++) {
    const f = a + (i / count) * n;
    const j = Math.floor(f);
    const y = j >= b ? ys[b] : ys[j] + (f - j) * (ys[j + 1] - ys[j]);
    dense.push({ x: roundTo(i / count, 6), y: roundTo(y, 5), handles: [] });
  }
  return captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.002, maxAnchors: 64, samples: 480, includeTransforms: true });
}

/**
 * Plan the segments of one voice: [{ a, b }] sample ranges. / 보이스 하나의 구간 계획
 */
export function planSegments(ys, stepMode, maxSeg) {
  const M = ys.length;
  let segs = 1;
  if (stepMode) segs = Math.ceil(stepAnchors(ys, 0, M - 1).length / STEP_ANCHORS_PER_SEG);
  else segs = Math.ceil(countExtrema(ys, 0, M - 1) / EXTREMA_PER_SEG);
  segs = clamp(segs, 1, maxSeg);
  const out = [];
  for (let k = 0; k < segs; k++) out.push({ a: Math.round((k * (M - 1)) / segs), b: Math.round(((k + 1) * (M - 1)) / segs) });
  return out;
}

/**
 * Convert the baked ensemble to Glissando Voices (≤ MAX_GENERATED_VOICES).
 * 베이킹된 앙상블 → 글리산도 보이스 (최대 64개).
 */
export function chaosToGlissandoVoices(B, doc, helpers) {
  const A = B.A;
  const sys = getChaosSystem(A.sysId);
  const mp = B.mapping.pitch;
  const lo = Math.min(mp.lo, mp.hi);
  const hi = Math.max(mp.lo, mp.hi, lo + 0.01);
  const span = hi - lo;
  const maxSeg = Math.max(1, Math.floor(MAX_GENERATED_VOICES / A.N));
  const out = [];
  const sysName = sys.name.en;
  B.voices.forEach((v, i) => {
    const ys = new Float64Array(B.M);
    for (let j = 0; j < B.M; j++) ys[j] = clamp((v.pitch[j] - lo) / span, 0, 1);
    const segs = planSegments(ys, B.stepMode, maxSeg);
    segs.forEach(({ a, b }, k) => {
      const customPoints = B.stepMode ? stepAnchors(ys, a, b) : smoothAnchors(ys, a, b);
      const gainPoints = [];
      for (let g = 0; g <= 32; g++) {
        const j = Math.round(a + ((b - a) * g) / 32);
        gainPoints.push({ x: roundTo(g / 32, 4), y: roundTo(clamp(v.gain[j], 0, 1), 4), handles: [] });
      }
      out.push(helpers.createDefaultVoice(helpers.startIndex + out.length, {
        name: `${sysName} ${i + 1}${segs.length > 1 ? ` · ${k + 1}/${segs.length}` : ''}`,
        color: CHAOS_COLORS[i % CHAOS_COLORS.length],
        startTime: roundTo(a / BAKE_RATE, 4),
        duration: roundTo(Math.max(0.05, (b - a) / BAKE_RATE), 4),
        baseGain: clamp(Number(doc.timbre?.baseGain) || 0.8, 0, 1.5),
        f0Hz: roundTo(midiToFreq(lo), 2),
        f1Hz: roundTo(midiToFreq(hi), 2),
        f0Fine: 0,
        f1Fine: 0,
        logScale: true,
        ...timbreSpecToVoiceFields(doc.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
        engine: 'custom',
        lastNonCustomEngine: 'harmonic',
        customPoints,
        gainMode: 'points',
        gainPoints,
        ...(helpers.debugSegments ? { chaosSegment: { voice: i, a, b } } : {}), // self-check only / 자가진단 전용
      }));
    });
  });
  return out.slice(0, MAX_GENERATED_VOICES);
}

export const ChaosStudio = {
  id: CHAOS_ID,
  name: { en: 'Chaos Studio', ko: '카오스 스튜디오' },
  description: { en: 'Chaotic attractors (Lorenz, Rössler, …) sonified as diverging glissandi', ko: '카오스 끌개(로렌츠, 뢰슬러 …)를 갈라지는 글리산도로 소리화' },
  order: 50,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'chaos',
  defaultParams: createDefaultChaosParams,
  generateVoices(params, helpers) {
    const doc = normalizeChaosDoc(params);
    return chaosToGlissandoVoices(bakeChaos(doc), doc, helpers);
  },
};

StudioRegistry.register(ChaosStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const small = (over = {}) => ({ ...createDefaultChaosParams(), voices: 4, simTime: 20, duration: 5, ...over });

registerSelfCheck('Chaos: RK4 convergence order (ẍ = −x) & parity with core rk4Step', (a) => {
  const osc = (s, p, t, out) => { out[0] = s[1]; out[1] = -s[0]; return out; };
  const err = (h) => {
    const rk = createRK4(2);
    const s = Float64Array.of(1, 0);
    const n = Math.round(10 / h);
    for (let k = 0; k < n; k++) rk(osc, s, null, k * h, h, s);
    return Math.hypot(s[0] - Math.cos(10), s[1] + Math.sin(10));
  };
  const ratio = err(0.1) / err(0.05);
  a.ok(ratio > 16 * 0.7 && ratio < 16 * 1.3, `halving dt divides the global error by ≈16 (got ${ratio.toFixed(2)})`);
  const lor = getChaosSystem('lorenz');
  const p = defaultSystemParams(lor);
  const y0 = [1.2, -0.7, 20.5];
  const ref = rk4Step((t, y) => Array.from(lor.deriv(y, p, t, new Float64Array(3))), 0, y0, 0.005);
  const mine = createRK4(3)(lor.deriv, Float64Array.from(y0), p, 0, 0.005, new Float64Array(3));
  a.ok(ref.every((v, i) => Math.abs(v - mine[i]) < 1e-12), 'same step as core rk4Step');
}, { group: 'studio' });

registerSelfCheck('Chaos: determinism (same signature → identical arrays, other seed → different)', (a) => {
  const doc = small();
  const A1 = bakeChaosTrajectories(doc, { noCache: true });
  const A2 = bakeChaosTrajectories(doc, { noCache: true });
  let same = true;
  for (let i = 0; i < A1.N; i++) {
    for (const id of A1.srcIds) {
      const x = A1.voices[i].src[id];
      const y = A2.voices[i].src[id];
      for (let j = 0; j < x.length; j++) if (!Object.is(x[j], y[j])) { same = false; break; }
    }
  }
  a.ok(same, 'bit-identical re-bake');
  a.equal(A1.lyapunov, A2.lyapunov, 'same λ');
  const A3 = bakeChaosTrajectories(small({ seed: 2 }), { noCache: true });
  let diff = false;
  const x1 = A1.voices[0].src.x;
  const x3 = A3.voices[0].src.x;
  for (let j = 0; j < x1.length; j++) if (x1[j] !== x3[j]) { diff = true; break; }
  a.ok(diff, 'different seed → different trajectory');
}, { group: 'studio' });

registerSelfCheck('Chaos: Lorenz boundedness over 60 sim-s', (a) => {
  const A = bakeChaosTrajectories(small({ voices: 1, simTime: 60, duration: 30 }), { noCache: true });
  const { x, y, z } = A.voices[0].src;
  let ok = true;
  for (let j = 0; j < x.length; j++) {
    if (!(Math.abs(x[j]) < 60 && Math.abs(y[j]) < 80 && z[j] > 0 && z[j] < 70)) { ok = false; break; }
  }
  a.ok(ok && !A.anyDiverged, '|x| < 60, |y| < 80, 0 < z < 70 and finite');
}, { group: 'studio' });

registerSelfCheck('Chaos: largest Lyapunov exponent of Lorenz ≈ 0.9 (Benettin)', (a) => {
  const A = bakeChaosTrajectories(small({ voices: 1, simTime: 100, duration: 10 }), { noCache: true });
  a.ok(A.lyapunov > 0.6 && A.lyapunov < 1.2, `λ = ${A.lyapunov.toFixed(3)} ∈ [0.6, 1.2]`);
}, { group: 'studio' });

registerSelfCheck('Chaos: spread sets d(0), then d grows (log slope > 0)', (a) => {
  const A = bakeChaosTrajectories(small({ voices: 4, spread: 1e-6, simTime: 40, duration: 20 }), { noCache: true });
  const d0 = A.voices[1].logd[0];
  a.ok(Math.abs(d0 - -6) < 1, `log10 d₁(0) = ${d0.toFixed(2)} ≈ log10(spread) = −6`);
  a.ok(A.fitSlope > 0, `fitted ln-slope ${A.fitSlope?.toFixed?.(3)} > 0`);
  a.ok(A.meanLogd[A.Ms - 1] > A.meanLogd[0] + 3, 'distance grew by > 3 decades');
  a.ok(A.divergeSim !== null && A.divergeSim > 5 && A.divergeSim < 30, `divergence at ${A.divergeSim?.toFixed?.(1)} sim-s`);
}, { group: 'studio' });

registerSelfCheck('Chaos: logistic map period-2 at r = 3.2, chaos in [0,1] at r = 3.99', (a) => {
  const base = applyChaosPreset(createDefaultChaosParams(), 'bifurcation');
  const p2 = bakeChaosTrajectories({ ...base, sweep: { ...base.sweep, on: false }, params: { r: 3.2 }, transient: 500, duration: 2, voices: 1 }, { noCache: true });
  const x = p2.voices[0].src.x;
  const n = x.length;
  a.ok(Math.abs(x[n - 1] - x[n - 3]) < 1e-5 && Math.abs(x[n - 2] - x[n - 4]) < 1e-5 && Math.abs(x[n - 1] - x[n - 2]) > 0.1, `last 4: ${Array.from(x.slice(n - 4)).map((v) => v.toFixed(4)).join(', ')}`);
  const c = bakeChaosTrajectories({ ...base, sweep: { ...base.sweep, on: false }, params: { r: 3.99 }, duration: 20, voices: 1 }, { noCache: true });
  a.ok(c.voices[0].src.x.every((v) => v >= 0 && v <= 1), 'values stay in [0, 1]');
  a.ok(c.lyapunov > 0.2, `λ = ${c.lyapunov.toFixed(3)} > 0 (chaotic)`);
}, { group: 'studio' });

registerSelfCheck('Chaos: signature cache (timbre 0 bakes, mapping = stage B only, params 1 bake)', (a) => {
  const doc = small({ seed: 77 });
  const B0 = bakeChaos(doc);
  const c0 = getBakeCount();
  const m0 = getMapCount();
  const t = deepClone(doc);
  t.timbre = { ...t.timbre, saw: 1, baseGain: 0.2, width: 0 };
  t.view = { ...t.view, proj: 'yz' };
  a.ok(bakeChaos(t) === B0 && getBakeCount() === c0 && getMapCount() === m0, 'timbre / gain / view → 0 recomputations');
  const m = deepClone(doc);
  m.map.pitch.hi = 72;
  const B1 = bakeChaos(m);
  a.ok(B1 !== B0 && B1.A === B0.A && getBakeCount() === c0 && getMapCount() === m0 + 1, 'mapping change → stage B only');
  const q = deepClone(doc);
  q.params.rho = 30;
  bakeChaos(q);
  a.equal(getBakeCount() - c0, 1, 'params change → exactly one integration');
}, { group: 'studio' });

registerSelfCheck('Chaos: 3-D axis along x = source x; turning / shortening the axis changes the mapping', (a) => {
  const doc = small({ seed: 5 });
  doc.map.pitch.source = 'x';
  const B0 = bakeChaos(doc);
  const ax = deepClone(doc);
  ax.map.pitch.source = 'y';
  ax.axes[0] = { target: 'pitch', az: 0, el: 0, len: 1, c: [0, 0, 0] };
  const B1 = bakeChaos(ax);
  a.equal(B1.mapping.pitch.source, 'axA', 'pitch reads axis A');
  const d01 = B0.voices[0].pitch.reduce((m, v, j) => Math.max(m, Math.abs(v - B1.voices[0].pitch[j])), 0);
  a.ok(d01 < 1e-3, `axis A on x reproduces source x (max Δ ${d01.toExponential(2)})`);
  const tw = deepClone(ax);
  tw.axes[0].az = 60;
  const B2 = bakeChaos(tw);
  const d02 = B0.voices[0].pitch.reduce((m, v, j) => Math.max(m, Math.abs(v - B2.voices[0].pitch[j])), 0);
  a.ok(d02 > 1, `turned axis → different pitch (max Δ ${d02.toFixed(2)})`);
  const sh = deepClone(ax);
  sh.axes[0].len = 0.5;
  const sd = (B) => { const p = B.voices[0].pitch; const m = p.reduce((s, v) => s + v, 0) / p.length; return Math.sqrt(p.reduce((s, v) => s + (v - m) ** 2, 0) / p.length); };
  a.ok(sd(bakeChaos(sh)) > sd(B1), 'shorter axis → wider pitch motion');
}, { group: 'studio' });

registerSelfCheck('Chaos: mapping clamps to lo..hi, divergent voices never throw', (a) => {
  const doc = small();
  doc.map.pitch = { ...doc.map.pitch, lo: 70, hi: 40, curve: 'expo', quantize: 'scale', scale: 'penta', root: 2, slewMs: 30 };
  doc.normalize = 'perVoice';
  const B = bakeChaos(doc);
  a.ok(B.voices.every((v) => v.pitch.every((m) => m >= 40 && m <= 70)), 'pitch within [40, 70]');
  a.ok(B.voices.every((v) => v.gain.every((g) => g >= Math.min(doc.map.gain.lo, doc.map.gain.hi) - 1e-6 && g <= Math.max(doc.map.gain.lo, doc.map.gain.hi) + 1e-6)), 'gain within range');
  const blow = { ...getChaosSystem('lorenz'), id: 'blowup', deriv: (s, p, t, out) => { out[0] = s[0] * s[0] + 1; out[1] = 0; out[2] = 0; return out; }, defaultIC: [1, 0, 0] };
  let res = null;
  let threw = false;
  try { res = bakeChaos({ ...small(), simTime: 10 }, { system: blow }); } catch (err) { threw = String(err); }
  a.ok(!threw, `no throw ${threw || ''}`);
  a.ok(res && res.A.anyDiverged, 'divergence flagged');
  a.ok(res.voices.every((v) => v.pitch.every(Number.isFinite) && v.gain.every(Number.isFinite)), 'last finite value held');
}, { group: 'studio' });

registerSelfCheck('Chaos: bake to Glissando voices (count ≤ 64, monotone x, state untouched, curve match)', (a) => {
  a.ok(StudioRegistry.has(CHAOS_ID), 'registered');
  a.ok(CHAOS_SYSTEMS.size >= 8 && [...CHAOS_SYSTEMS.values()].every((s) => s.params.every((p) => p.default >= p.min && p.default <= p.max)), 'systems valid');
  withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    for (const id of ['butterfly', 'bifurcation', 'drivenBell']) {
      const doc = applyChaosPreset(createDefaultChaosParams(), id);
      const B = bakeChaos(doc);
      const voices = StudioRegistry.generateVoices(CHAOS_ID, doc);
      a.ok(voices.length >= B.A.N && voices.length <= MAX_GENERATED_VOICES, `${id}: ${voices.length} voices`);
      a.ok(voices.every((v) => v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints[0].x === 0 && v.customPoints[v.customPoints.length - 1].x === 1 && v.customPoints.every((p, i, arr) => i === 0 || p.x > arr[i - 1].x)), `${id}: x strictly increasing 0 → 1`);
      // compare the spline with the baked curve / 스플라인과 베이킹 곡선 비교
      const raw = chaosToGlissandoVoices(B, doc, { createDefaultVoice: (i, o) => o, startIndex: 0, debugSegments: true });
      const lo = Math.min(B.mapping.pitch.lo, B.mapping.pitch.hi);
      const span = Math.max(B.mapping.pitch.lo, B.mapping.pitch.hi, lo + 0.01) - lo;
      let sum = 0;
      let n = 0;
      for (const v of raw) {
        const { voice, a: s0, b: s1 } = v.chaosSegment;
        for (let k = 1; k < 64; k++) {
          const x = k / 64;
          const y = evaluateCurveObjectY({ engine: 'custom', customPoints: v.customPoints, reverse: false, inverse: false }, x, { raw: true, regions: false });
          const j = Math.round(s0 + x * (s1 - s0));
          sum += Math.abs(y - (B.voices[voice].pitch[j] - lo) / span);
          n++;
        }
      }
      a.ok(sum / n < 0.02, `${id}: mean |spline − baked| = ${(sum / n).toFixed(4)} < 0.02`);
    }
    a.equal(JSON.stringify(appState.voices), before, 'generateVoices leaves the document alone');
  });
}, { group: 'studio' });

registerSelfCheck('Chaos: default bake time & every system bakes finite', (a) => {
  const t0 = (globalThis.performance || Date).now();
  const A = bakeChaosTrajectories(createDefaultChaosParams(), { noCache: true });
  const ms = (globalThis.performance || Date).now() - t0;
  a.ok(ms < 1000, `default Lorenz N=8 bake ${ms.toFixed(0)} ms`);
  a.ok(A.N === 8 && A.Ms === 30 * BAKE_RATE + 1, 'sample count');
  for (const sys of CHAOS_SYSTEMS.values()) {
    const d = setChaosSystem(createDefaultChaosParams(), sys.id);
    const B = bakeChaos({ ...d, voices: 2, duration: 4, simTime: Math.min(d.simTime, 20) });
    a.ok(B.voices.every((v) => v.pitch.every(Number.isFinite)), `${sys.id} finite`);
  }
  a.ok(MAX_CHAOS_VOICES * Math.floor(MAX_GENERATED_VOICES / MAX_CHAOS_VOICES) <= MAX_GENERATED_VOICES, 'voice budget');
  a.ok(resolveSystemParams(getChaosSystem('lorenz'), { rho: 1e9 }).rho === 120, 'params clamped');
}, { group: 'studio' });

registerSelfCheck('Chaos: quantize amount & pitch sensitivity', (a) => {
  const base = small({ seed: 9 });
  base.map.pitch = { ...base.map.pitch, quantize: '12tet', slewMs: 0 };
  const at = (amt, sens = 1) => { const d = deepClone(base); d.map.pitch.quantAmt = amt; d.map.pitch.sens = sens; return bakeChaos(d); };
  const off = (() => { const d = deepClone(base); d.map.pitch.quantize = 'off'; return bakeChaos(d); })();
  const full = at(1);
  const half = at(0.5);
  a.ok(full.voices[0].pitch.every((m) => Math.abs(m - Math.round(m)) < 1e-4), '100 % → whole semitones');
  a.ok(full.stepMode && !half.stepMode, 'only 100 % is baked as steps');
  const p0 = off.voices[0].pitch;
  a.ok(half.voices[0].pitch.every((m, j) => Math.abs(m - (p0[j] + 0.5 * (Math.round(p0[j]) - p0[j]))) < 1e-3), '50 % → halfway to the grid');
  a.ok(at(0).voices[0].pitch.every((m, j) => Math.abs(m - p0[j]) < 1e-6), '0 % = continuous');
  const spread = (B) => { const p = B.voices[0].pitch; let lo = Infinity; let hi = -Infinity; for (const m of p) { lo = Math.min(lo, m); hi = Math.max(hi, m); } return hi - lo; };
  a.ok(spread(at(0, 0.5)) < spread(at(0, 1)) && spread(at(0, 0)) < 1e-6, 'lower sensitivity → narrower pitch motion, 0 = constant');
  a.ok(at(0, 3).voices[0].pitch.every((m) => m >= 36 && m <= 84), 'high sensitivity stays clamped to Low..High');
}, { group: 'studio' });
