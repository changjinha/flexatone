/**
 * Flexatone — studios/chaos/chaos-engine.js
 * Chaos Studio pure engine: dynamical-system registry, fixed-step RK4, edit-time baking with a
 * two-stage signature cache, reference normalisation, Lyapunov / divergence analysis.
 * 카오스 스튜디오 순수 엔진: 동역학계 레지스트리, 고정 스텝 RK4, 2단 시그니처 캐시 베이킹,
 * 기준 궤적 정규화, 리아푸노프·발산 분석.
 *
 * Layer: studios (pure). Imports core/* only — no DOM, no audio. / DOM·오디오 의존 없음.
 *
 * Pipeline / 파이프라인
 *   Stage A  bakeChaosTrajectories(doc)  — integrate N voices (+1 Benettin partner) once per
 *            trajectory signature (system, params, sweep, seed, voices, spread, dt, transient,
 *            simTime, duration, discrete.rate). Output: every source channel per voice at
 *            BAKE_RATE samples / song-second (flows) or one sample per iteration (maps).
 *   Stage B  bakeChaos(doc)              — map sources → pitch / gain / bright arrays (range,
 *            curve, invert, quantize, slew, hold / glide). Cheap; own signature.
 *   Timbre / base gain / stereo width / view are in neither signature (no recompute).
 *   음색·게인·폭·보기는 어떤 시그니처에도 포함되지 않음 (재계산 없음).
 */

import { clamp, createSeededRandom, smoothstep } from '../../core/math-utils.js';

export const MAX_CHAOS_VOICES = 16;
/** Song-time samples per second of the baked curves. / 곡 시간 초당 베이킹 샘플 수 */
export const BAKE_RATE = 200;
/** Cap on RK4 steps of one bake (all voices + Lyapunov partner). / 베이킹 1회 적분 스텝 상한 */
export const MAX_TOTAL_STEPS = 3e6;
/** Cap on voices × samples of one bake. / 보이스 × 샘플 상한 */
export const MAX_TOTAL_SAMPLES = 3e6;
export const REF_SIM_TIME = 200;
export const REF_TRANSIENT = 20;
export const REF_MAP_ITERS = 4000;
const BLOWUP = 1e6;
const LYAP_D0 = 1e-8;
const LRU_SIZE = 6;

export const PITCH_CURVES = Object.freeze(['linear', 'expo', 'log', 'smooth']);
export const QUANTIZE_MODES = Object.freeze(['off', '12tet', 'scale']);
export const SCALES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  penta: [0, 2, 4, 7, 9],
  whole: [0, 2, 4, 6, 8, 10],
  hijaz: [0, 1, 4, 5, 7, 8, 10],
});
export const DISCRETE_MODES = Object.freeze(['hold', 'glide']);
export const NORMALIZE_MODES = Object.freeze(['reference', 'perVoice']);
export const PROJECTIONS = Object.freeze(['xz', 'xy', 'yz', '3d']);

// --------------------------------------------------------------------------
// 3-D mapping axes / 3D 매핑 축
// Three free lines in the normalised x/y/z state space (each coordinate ≈ −1…1 over the 2–98 %
// reference range). A sound channel assigned to an axis reads the projection of the state onto it:
// value = ((s − centre) · dir) / len, so −1…+1 along the drawn segment = Low…High.
// Turning the axis mixes x/y/z, moving the centre shifts the range, a shorter axis = stronger.
// 정규화된 x/y/z 상태 공간의 자유로운 세 직선. 축에 할당된 채널은 상태를 그 축에 투영한 값을 읽음.
// --------------------------------------------------------------------------
export const AXIS_IDS = Object.freeze(['axA', 'axB', 'axC']);
export const AXIS_TARGETS = Object.freeze(['none', 'pitch', 'gain', 'bright']);
export const AXIS_LEN_RANGE = Object.freeze([0.1, 4]);
export const AXIS_CENTER_RANGE = 3;
const AXIS_DEFAULTS = Object.freeze([
  Object.freeze({ target: 'none', az: 0, el: 0, len: 1, c: [0, 0, 0] }),
  Object.freeze({ target: 'none', az: 90, el: 0, len: 1, c: [0, 0, 0] }),
  Object.freeze({ target: 'none', az: 0, el: 90, len: 1, c: [0, 0, 0] }),
]);

export function defaultChaosAxes() {
  return AXIS_DEFAULTS.map((a) => ({ ...a, c: [...a.c] }));
}

/** Clamped axes (always 3). / 정리된 축 3개 */
export function resolveAxes(doc) {
  const raw = Array.isArray(doc?.axes) ? doc.axes : [];
  return AXIS_DEFAULTS.map((d, i) => {
    const a = raw[i] || {};
    const c = Array.isArray(a.c) ? a.c : d.c;
    return {
      target: AXIS_TARGETS.includes(a.target) ? a.target : 'none',
      az: clamp(num(a.az, d.az), -180, 180),
      el: clamp(num(a.el, d.el), -90, 90),
      len: clamp(num(a.len, d.len), AXIS_LEN_RANGE[0], AXIS_LEN_RANGE[1]),
      c: [0, 1, 2].map((k) => clamp(num(c[k], 0), -AXIS_CENTER_RANGE, AXIS_CENTER_RANGE)),
    };
  });
}

/** Unit direction of an axis in normalised x/y/z. / 축의 단위 방향 */
export function axisDirection(a) {
  const az = (a.az * Math.PI) / 180;
  const el = (a.el * Math.PI) / 180;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

/** Per-coordinate {mid, half} of the reference x/y/z range (portrait + axes). / 기준 x/y/z 정규화 틀 */
export function refFrame(A) {
  const r = A.ref.ranges;
  return ['x', 'y', 'z'].map((id) => {
    const [a, b] = r[id] || [0, 1];
    const span = Math.abs(b - a) > 1e-9 ? b - a : 1;
    return { mid: 0.5 * (a + b), half: 0.5 * span };
  });
}

/** Projection of one voice onto an axis (≈ −1…1 over the drawn segment). / 축 투영값 */
export function axisValues(A, v, a, out = new Float32Array(v.src.x.length)) {
  const f = refFrame(A);
  const d = axisDirection(a);
  const { x, y, z } = v.src;
  for (let j = 0; j < out.length; j++) {
    const X = (x[j] - f[0].mid) / f[0].half - a.c[0];
    const Y = (y[j] - f[1].mid) / f[1].half - a.c[1];
    const Z = (z[j] - f[2].mid) / f[2].half - a.c[2];
    out[j] = (X * d[0] + Y * d[1] + Z * d[2]) / a.len;
  }
  return out;
}

// ==========================================================================
// System registry / 시스템 레지스트리 — adding a system = one registerChaosSystem() call
// ==========================================================================

/** id → frozen system definition. / 시스템 정의 Map */
export const CHAOS_SYSTEMS = new Map();

const P = (id, min, max, def, step) => Object.freeze({ id, min, max, default: def, step });

/**
 * Register a dynamical system.
 * @param {object} def { id, name:{en,ko}, kind:'flow'|'map', dim, params:[{id,min,max,default,step}],
 *   deriv(s, p, t, out) (flow) | step(s, p, n, out) (map), defaultIC, scaleHint,
 *   coords?(s, p, t, out3), extras?:[{id, get(s,p,t)}], defaultView?, defaultMap?, perturbMask?,
 *   docDefaults?, equation? }
 */
export function registerChaosSystem(def) {
  const errs = [];
  if (!def || typeof def.id !== 'string' || !/^[a-z][a-z0-9]*$/.test(def.id)) errs.push('id');
  if (!def?.name?.en || !def?.name?.ko) errs.push('name');
  if (def?.kind !== 'flow' && def?.kind !== 'map') errs.push('kind');
  if (!(def?.dim >= 1)) errs.push('dim');
  if (def?.kind === 'flow' && typeof def.deriv !== 'function') errs.push('deriv');
  if (def?.kind === 'map' && typeof def.step !== 'function') errs.push('step');
  if (!Array.isArray(def?.params)) errs.push('params');
  if (!Array.isArray(def?.defaultIC) || def.defaultIC.length !== def?.dim) errs.push('defaultIC');
  if (errs.length) throw new TypeError(`registerChaosSystem: invalid ${errs.join(', ')}`);
  const full = Object.freeze({
    scaleHint: 1,
    defaultView: 'xy',
    perturbMask: null,
    diamDims: null,
    extras: [],
    docDefaults: {},
    defaultMap: { pitch: 'x', gain: 'y', bright: 'speed' },
    coords: null,
    equation: '',
    ...def,
  });
  CHAOS_SYSTEMS.set(full.id, full);
  return full;
}

export function getChaosSystem(id) {
  return CHAOS_SYSTEMS.get(id) || CHAOS_SYSTEMS.get('lorenz');
}

/** Source channel ids a system offers (order = internal source vector). / 시스템의 소스 목록 */
export function systemSources(sys) {
  const base = sys.kind === 'flow' ? ['x', 'y', 'z', 'speed', 'curv', 'radius'] : ['x', 'y', 'z', 'speed', 'radius'];
  return [...base, ...sys.extras.map((e) => e.id)];
}

/** Params clamped to the system's ranges (missing → default). / 시스템 파라미터 정리 */
export function resolveSystemParams(sys, raw) {
  const out = {};
  for (const d of sys.params) {
    const v = Number(raw?.[d.id]);
    out[d.id] = Number.isFinite(v) ? clamp(v, d.min, d.max) : d.default;
  }
  return out;
}

export function defaultSystemParams(sys) {
  return Object.fromEntries(sys.params.map((d) => [d.id, d.default]));
}

registerChaosSystem({
  id: 'lorenz',
  name: { en: 'Lorenz', ko: '로렌츠' },
  kind: 'flow',
  dim: 3,
  params: [P('sigma', 0.1, 30, 10, 0.1), P('rho', 0.5, 120, 28, 0.1), P('beta', 0.05, 8, 8 / 3, 0.01)],
  deriv(s, p, t, out = new Float64Array(3)) {
    out[0] = p.sigma * (s[1] - s[0]);
    out[1] = s[0] * (p.rho - s[2]) - s[1];
    out[2] = s[0] * s[1] - p.beta * s[2];
    return out;
  },
  defaultIC: [0.1, 0, 0],
  scaleHint: 20,
  defaultView: 'xz',
  defaultMap: { pitch: 'x', gain: 'z', bright: 'speed' },
  docDefaults: { dt: 0.005, transient: 20, simTime: 60 },
  equation: 'ẋ = σ(y − x),  ẏ = x(ρ − z) − y,  ż = xy − βz',
});

registerChaosSystem({
  id: 'rossler',
  name: { en: 'Rössler', ko: '뢰슬러' },
  kind: 'flow',
  dim: 3,
  params: [P('a', 0.01, 0.4, 0.2, 0.005), P('b', 0.01, 2, 0.2, 0.01), P('c', 1, 20, 5.7, 0.05)],
  deriv(s, p, t, out = new Float64Array(3)) {
    out[0] = -s[1] - s[2];
    out[1] = s[0] + p.a * s[1];
    out[2] = p.b + s[2] * (s[0] - p.c);
    return out;
  },
  defaultIC: [1, 1, 0],
  scaleHint: 10,
  defaultView: 'xy',
  defaultMap: { pitch: 'x', gain: 'radius', bright: 'z' },
  docDefaults: { dt: 0.01, transient: 50, simTime: 300 },
  equation: 'ẋ = −y − z,  ẏ = x + ay,  ż = b + z(x − c)',
});

registerChaosSystem({
  id: 'duffing',
  name: { en: 'Duffing (driven)', ko: '더핑 (강제 진동)' },
  kind: 'flow',
  dim: 3, // [x, v, θ = ωt] — the drive phase makes it autonomous / 구동 위상으로 자율계화
  params: [P('delta', 0, 1, 0.3, 0.01), P('alpha', -2, 2, -1, 0.01), P('beta', 0, 3, 1, 0.01), P('gamma', 0, 1.5, 0.37, 0.005), P('omega', 0.2, 3, 1.2, 0.01)],
  deriv(s, p, t, out = new Float64Array(3)) {
    out[0] = s[1];
    out[1] = -p.delta * s[1] - p.alpha * s[0] - p.beta * s[0] * s[0] * s[0] + p.gamma * Math.cos(s[2]);
    out[2] = p.omega;
    return out;
  },
  coords(s, p, t, out) {
    out[0] = s[0];
    out[1] = s[1];
    out[2] = Math.cos(s[2]);
    return out;
  },
  defaultIC: [1, 0, 0],
  scaleHint: 1.5,
  perturbMask: [1, 1, 0], // shared drive phase / 구동 위상은 공유
  diamDims: [0, 1], // θ grows without bound: not part of the attractor size / θ는 끌개 크기에서 제외
  defaultView: 'xy',
  defaultMap: { pitch: 'x', gain: 'speed', bright: 'speed' },
  docDefaults: { dt: 0.01, transient: 50, simTime: 200 },
  equation: 'ẍ + δẋ + αx + βx³ = γ cos(ωt)',
});

registerChaosSystem({
  id: 'thomas',
  name: { en: 'Thomas', ko: '토머스' },
  kind: 'flow',
  dim: 3,
  params: [P('b', 0.05, 0.35, 0.208, 0.001)],
  deriv(s, p, t, out = new Float64Array(3)) {
    out[0] = Math.sin(s[1]) - p.b * s[0];
    out[1] = Math.sin(s[2]) - p.b * s[1];
    out[2] = Math.sin(s[0]) - p.b * s[2];
    return out;
  },
  defaultIC: [0.1, 0, 0],
  scaleHint: 3,
  defaultView: 'xy',
  defaultMap: { pitch: 'x', gain: 'speed', bright: 'z' },
  docDefaults: { dt: 0.02, transient: 50, simTime: 600 },
  equation: 'ẋ = sin y − bx,  ẏ = sin z − by,  ż = sin x − bz',
});

registerChaosSystem({
  id: 'aizawa',
  name: { en: 'Aizawa', ko: '아이자와' },
  kind: 'flow',
  dim: 3,
  params: [P('a', 0.5, 1.2, 0.95, 0.005), P('b', 0.3, 1, 0.7, 0.005), P('c', 0.3, 1, 0.6, 0.005), P('d', 2, 5, 3.5, 0.01), P('e', 0, 0.6, 0.25, 0.005), P('f', 0, 0.3, 0.1, 0.005)],
  deriv(s, p, t, out = new Float64Array(3)) {
    const [x, y, z] = [s[0], s[1], s[2]];
    out[0] = (z - p.b) * x - p.d * y;
    out[1] = p.d * x + (z - p.b) * y;
    out[2] = p.c + p.a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + p.e * z) + p.f * z * x * x * x;
    return out;
  },
  defaultIC: [0.1, 0, 0],
  scaleHint: 1.5,
  defaultView: 'xz',
  defaultMap: { pitch: 'z', gain: 'radius', bright: 'speed' },
  docDefaults: { dt: 0.01, transient: 30, simTime: 120 },
  equation: 'ẋ = (z−b)x − dy,  ẏ = dx + (z−b)y,  ż = c + az − z³/3 − (x²+y²)(1+ez) + fzx³',
});

registerChaosSystem({
  id: 'dpend',
  name: { en: 'Double pendulum', ko: '이중 진자' },
  kind: 'flow',
  dim: 4, // [θ1, θ2, ω1, ω2] — never wrapped, so θ stays continuous / 래핑하지 않아 연속
  params: [P('m', 0.1, 5, 1, 0.05), P('L', 0.2, 3, 1, 0.05), P('g', 1, 20, 9.81, 0.01)],
  deriv(s, p, t, out = new Float64Array(4)) {
    const [t1, t2, w1, w2] = [s[0], s[1], s[2], s[3]];
    const m1 = p.m;
    const m2 = p.m;
    const L = p.L;
    const d = t1 - t2;
    const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
    out[0] = w1;
    out[1] = w2;
    out[2] = (-p.g * (2 * m1 + m2) * Math.sin(t1) - m2 * p.g * Math.sin(t1 - 2 * t2) - 2 * Math.sin(d) * m2 * (w2 * w2 * L + w1 * w1 * L * Math.cos(d))) / (L * den);
    out[3] = (2 * Math.sin(d) * (w1 * w1 * L * (m1 + m2) + p.g * (m1 + m2) * Math.cos(t1) + w2 * w2 * L * m2 * Math.cos(d))) / (L * den);
    return out;
  },
  coords(s, p, t, out) {
    out[0] = p.L * (Math.sin(s[0]) + Math.sin(s[1])); // tip x / 끝점 x
    out[1] = -p.L * (Math.cos(s[0]) + Math.cos(s[1])); // tip y / 끝점 y
    out[2] = s[3]; // ω2
    return out;
  },
  extras: [
    { id: 'theta1u', get: (s) => s[0] },
    { id: 'theta2u', get: (s) => s[1] },
    { id: 'angspeed', get: (s) => Math.hypot(s[2], s[3]) },
  ],
  defaultIC: [2.1, 2.3, 0, 0],
  diamDims: [2, 3], // unwrapped angles drift after flips: size from ω₁, ω₂ / 펼친 각은 표류하므로 ω로 크기 측정
  scaleHint: 2,
  defaultView: 'xy',
  defaultMap: { pitch: 'theta2u', gain: 'angspeed', bright: 'speed' },
  docDefaults: { dt: 0.004, transient: 0, simTime: 40 },
  equation: 'Lagrangian double pendulum (θ₁, θ₂, ω₁, ω₂), m₁ = m₂ = m, L₁ = L₂ = L',
});

registerChaosSystem({
  id: 'logistic',
  name: { en: 'Logistic map', ko: '로지스틱 사상' },
  kind: 'map',
  dim: 2, // [xₙ, xₙ₋₁] so the return map can be drawn / 반환 사상 표시용
  params: [P('r', 2.5, 4, 3.7, 0.001)],
  step(s, p, n, out = new Float64Array(2)) {
    const x = s[0];
    out[0] = p.r * x * (1 - x);
    out[1] = x;
    return out;
  },
  coords(s, p, t, out) {
    out[0] = s[0];
    out[1] = s[1];
    out[2] = p.r;
    return out;
  },
  defaultIC: [0.2, 0.2],
  scaleHint: 0.5,
  perturbMask: [1, 0],
  defaultView: 'xy',
  defaultMap: { pitch: 'x', gain: 'speed', bright: 'x' },
  docDefaults: { transient: 200 },
  equation: 'xₙ₊₁ = r · xₙ (1 − xₙ)',
});

registerChaosSystem({
  id: 'henon',
  name: { en: 'Hénon map', ko: '에농 사상' },
  kind: 'map',
  dim: 2,
  params: [P('a', 0.5, 1.42, 1.4, 0.001), P('b', 0, 0.4, 0.3, 0.001)],
  step(s, p, n, out = new Float64Array(2)) {
    const x = s[0];
    out[0] = 1 - p.a * x * x + s[1];
    out[1] = p.b * x;
    return out;
  },
  defaultIC: [0.1, 0.1],
  scaleHint: 1,
  defaultView: 'xy',
  defaultMap: { pitch: 'x', gain: 'speed', bright: 'y' },
  docDefaults: { transient: 200 },
  equation: "x' = 1 − ax² + y,  y' = bx",
});

// ==========================================================================
// Numerics / 수치 해석
// ==========================================================================

/**
 * Allocation-free classical RK4 for deriv(s, p, t, out). Same scheme as core rk4Step (checked
 * bit-for-bit in the self-check) but on Float64Array scratch buffers. `out` may alias `s`.
 * 할당 없는 고전 RK4 (core rk4Step과 동일 공식, 자가진단에서 비교).
 */
export function createRK4(dim) {
  const k1 = new Float64Array(dim);
  const k2 = new Float64Array(dim);
  const k3 = new Float64Array(dim);
  const k4 = new Float64Array(dim);
  const tmp = new Float64Array(dim);
  return function step(deriv, s, p, t, h, out) {
    deriv(s, p, t, k1);
    for (let i = 0; i < dim; i++) tmp[i] = s[i] + (h / 2) * k1[i];
    deriv(tmp, p, t + h / 2, k2);
    for (let i = 0; i < dim; i++) tmp[i] = s[i] + (h / 2) * k2[i];
    deriv(tmp, p, t + h / 2, k3);
    for (let i = 0; i < dim; i++) tmp[i] = s[i] + h * k3[i];
    deriv(tmp, p, t + h, k4);
    for (let i = 0; i < dim; i++) out[i] = s[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    return out;
  };
}

function coordsOf(sys, s, p, t, out) {
  if (sys.coords) return sys.coords(s, p, t, out);
  out[0] = s[0];
  out[1] = sys.dim > 1 ? s[1] : 0;
  out[2] = sys.dim > 2 ? s[2] : 0;
  return out;
}

/** Evaluate every source into `out` (order = systemSources). c0 current, c1/c2 previous coords. */
function makeSourceEval(sys, center) {
  const ids = systemSources(sys);
  const flow = sys.kind === 'flow';
  const ex = sys.extras;
  return {
    ids,
    n: ids.length,
    eval(s, p, t, c0, c1, c2, h, out) {
      out[0] = c0[0];
      out[1] = c0[1];
      out[2] = c0[2];
      let k = 3;
      if (flow) {
        const vx = (3 * c0[0] - 4 * c1[0] + c2[0]) / (2 * h);
        const vy = (3 * c0[1] - 4 * c1[1] + c2[1]) / (2 * h);
        const vz = (3 * c0[2] - 4 * c1[2] + c2[2]) / (2 * h);
        const ax = (c0[0] - 2 * c1[0] + c2[0]) / (h * h);
        const ay = (c0[1] - 2 * c1[1] + c2[1]) / (h * h);
        const az = (c0[2] - 2 * c1[2] + c2[2]) / (h * h);
        const sp = Math.hypot(vx, vy, vz);
        const cr = Math.hypot(vy * az - vz * ay, vz * ax - vx * az, vx * ay - vy * ax);
        out[3] = sp;
        out[4] = sp > 1e-9 ? Math.min(1e6, cr / (sp * sp * sp)) : 0;
        k = 5;
      } else {
        out[3] = Math.hypot(c0[0] - c1[0], c0[1] - c1[1], c0[2] - c1[2]);
        k = 4;
      }
      out[k++] = Math.hypot(c0[0] - center[0], c0[1] - center[1], c0[2] - center[2]);
      for (const e of ex) out[k++] = e.get(s, p, t);
    },
  };
}

const isBad = (s) => {
  for (let i = 0; i < s.length; i++) if (!Number.isFinite(s[i]) || Math.abs(s[i]) > BLOWUP) return true;
  return false;
};

/** 2–98 percentile range of the finite values. / 2–98 퍼센타일 범위 */
export function percentileRange(arr, lo = 0.02, hi = 0.98) {
  const buf = new Float64Array(arr.length);
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i])) buf[n++] = arr[i];
  if (!n) return [0, 1];
  const sorted = buf.subarray(0, n).sort();
  return [sorted[Math.floor(lo * (n - 1))], sorted[Math.ceil(hi * (n - 1))]];
}

function sweepInfo(sys, doc) {
  const sw = doc.sweep || {};
  const def = sys.params.find((d) => d.id === sw.param);
  if (!sw.on || !def) return null;
  return { param: def.id, from: clamp(Number(sw.from) || def.min, def.min, def.max), to: clamp(Number(sw.to) || def.max, def.min, def.max) };
}

const applySweep = (pp, sw, u) => { if (sw) pp[sw.param] = sw.from + (sw.to - sw.from) * clamp(u, 0, 1); };

// LRU helper / LRU 캐시
function lruGet(map, key) {
  const v = map.get(key);
  if (v !== undefined) { map.delete(key); map.set(key, v); }
  return v;
}
function lruSet(map, key, v) {
  map.set(key, v);
  while (map.size > LRU_SIZE) map.delete(map.keys().next().value);
}

// ==========================================================================
// Reference trajectory (normalisation) / 기준 궤적 (정규화)
// ==========================================================================

const refCache = new Map();
let refCount = 0;
export const getReferenceCount = () => refCount;

/**
 * Long reference run from the default IC → 2–98 percentile range of every source, the attractor
 * centre (for `radius`) and diameter. Cached by (system, params, sweep, dt).
 * 기본 초기값에서 긴 기준 궤적 → 소스별 2–98 퍼센타일, 중심, 지름. (system, params, sweep, dt) 캐시.
 */
export function computeReference(sys, params, sweep, dt) {
  const key = JSON.stringify([sys.id, params, sweep, sys.kind === 'flow' ? dt : 0]);
  const hit = lruGet(refCache, key);
  if (hit) return hit;
  refCount++;
  const dim = sys.dim;
  const pp = { ...params };
  const s = Float64Array.from(sys.defaultIC);
  const c0 = new Float64Array(3);
  const c1 = new Float64Array(3);
  const c2 = new Float64Array(3);
  const zero = new Float64Array(3);
  const ev = makeSourceEval(sys, zero);
  const sv = new Float64Array(ev.n);
  const flow = sys.kind === 'flow';
  const rk = flow ? createRK4(dim) : null;
  const stepOnce = (t, n) => (flow ? rk(sys.deriv, s, pp, t, dt, s) : sys.step(s, pp, n, s));
  const transient = flow ? Math.round(REF_TRANSIENT / dt) : 200;
  const total = flow ? Math.round(REF_SIM_TIME / dt) : REF_MAP_ITERS;
  const stride = flow ? Math.max(1, Math.round(0.05 / dt)) : 1;
  const count = Math.floor(total / stride) + 1;
  const store = ev.ids.map(() => new Float64Array(count));
  const coordsStore = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const stateStore = Array.from({ length: dim }, () => new Float64Array(count));
  applySweep(pp, sweep, 0);
  let bad = false;
  for (let k = 0; k < transient && !bad; k++) { stepOnce(-transient * dt + k * dt, k); bad = isBad(s); }
  coordsOf(sys, s, pp, 0, c2);
  stepOnce(0, 0);
  coordsOf(sys, s, pp, 0, c1);
  stepOnce(0, 1);
  let j = 0;
  for (let k = 0; k <= total && !bad; k++) {
    applySweep(pp, sweep, k / total);
    coordsOf(sys, s, pp, k * dt, c0);
    if (k % stride === 0 && j < count) {
      ev.eval(s, pp, k * dt, c0, c1, c2, flow ? dt : 1, sv);
      for (let q = 0; q < ev.n; q++) store[q][j] = sv[q];
      for (let q = 0; q < 3; q++) coordsStore[q][j] = c0[q];
      for (let q = 0; q < dim; q++) stateStore[q][j] = s[q];
      j++;
    }
    c2.set(c1);
    c1.set(c0);
    stepOnce(k * dt, k + 2);
    if (isBad(s)) bad = true;
  }
  const n = Math.max(1, j);
  const center = new Float64Array(3);
  for (let q = 0; q < 3; q++) { let m = 0; for (let i = 0; i < n; i++) m += coordsStore[q][i]; center[q] = m / n; }
  const ridx = ev.ids.indexOf('radius');
  for (let i = 0; i < n; i++) store[ridx][i] = Math.hypot(coordsStore[0][i] - center[0], coordsStore[1][i] - center[1], coordsStore[2][i] - center[2]);
  const ranges = {};
  ev.ids.forEach((id, q) => { ranges[id] = percentileRange(store[q].subarray(0, n)); });
  let diam2 = 0;
  for (const q of sys.diamDims || Array.from({ length: dim }, (_, i) => i)) { const [a, b] = percentileRange(stateStore[q].subarray(0, n)); diam2 += (b - a) ** 2; }
  const ref = Object.freeze({ key, ranges, center, diam: Math.sqrt(diam2) || sys.scaleHint, finite: !bad, samples: n });
  lruSet(refCache, key, ref);
  return ref;
}

// ==========================================================================
// Document normalisation & signatures / 문서 정규화·시그니처
// ==========================================================================

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const int = (v, lo, hi, d) => clamp(Math.round(num(v, d)), lo, hi);

/** Numeric run settings after clamping (shared by stage A and the UI). / 실행 설정 정리 */
export function resolveRun(doc) {
  const sys = getChaosSystem(doc.system);
  return {
    sys,
    params: resolveSystemParams(sys, doc.params),
    sweep: sweepInfo(sys, doc),
    seed: int(doc.seed, 0, 1e9, 1),
    N: int(doc.voices, 1, MAX_CHAOS_VOICES, 8),
    spread: clamp(num(doc.spread, 1e-6), 1e-12, 1),
    dt: clamp(num(doc.dt, 0.005), 1e-4, 0.1),
    transient: clamp(num(doc.transient, 20), 0, 5000),
    simTime: clamp(num(doc.simTime, 60), 1, 5000),
    duration: clamp(num(doc.duration, 30), 1, 300),
    rate: clamp(num(doc.discrete?.rate, 8), 0.5, 32),
  };
}

export function trajectorySignature(doc) {
  const r = resolveRun(doc);
  const map = r.sys.kind === 'map';
  return JSON.stringify([r.sys.id, r.params, r.sweep, r.seed, r.N, r.spread, map ? 0 : r.dt, Math.round(r.transient * 1e6), r.simTime, r.duration, map ? r.rate : 0]);
}

// ==========================================================================
// Stage A — trajectories / 1단계: 궤적 적분
// ==========================================================================

const trajCache = new Map();
let bakeCount = 0;
let bakeSerial = 0;
/** Number of trajectory integrations so far (stage A). / 궤적 적분 횟수 */
export const getBakeCount = () => bakeCount;

function unitVector(rand, dim, mask, out) {
  let n2 = 0;
  for (let i = 0; i < dim; i++) { out[i] = (mask ? mask[i] : 1) * (2 * rand() - 1); n2 += out[i] * out[i]; }
  const n = Math.sqrt(n2) || 1;
  for (let i = 0; i < dim; i++) out[i] /= n;
  if (n2 === 0) out[0] = 1;
  return out;
}

/**
 * Integrate the ensemble (cached by trajectorySignature). Pass { system } to bake a test system
 * (never cached), { noCache } to force a fresh run.
 * 앙상블 적분 (시그니처 캐시). { system }은 테스트 시스템, { noCache }는 강제 재계산.
 */
export function bakeChaosTrajectories(doc, { system = null, noCache = false } = {}) {
  const sig = system ? null : trajectorySignature(doc);
  if (sig && !noCache) {
    const hit = lruGet(trajCache, sig);
    if (hit) return hit;
  }
  const t0 = (globalThis.performance || Date).now();
  bakeCount++;
  const run = resolveRun(doc);
  const sys = system || run.sys;
  const params = system ? resolveSystemParams(sys, doc.params) : run.params;
  const sweep = system ? sweepInfo(sys, doc) : run.sweep;
  const { seed, N, spread, transient, simTime, duration, rate } = run;
  const flow = sys.kind === 'flow';
  const dim = sys.dim;
  let dt = run.dt;
  let dtClamped = false;

  // Step budget / 스텝 예산
  let tSteps = flow ? Math.round(transient / dt) : Math.round(transient);
  let sSteps = flow ? Math.ceil(simTime / dt - 1e-9) : Math.max(2, Math.round(duration * rate));
  if (flow && tSteps + (N + 1) * (sSteps + 2) > MAX_TOTAL_STEPS) {
    dt = (transient + (N + 1) * simTime) / (MAX_TOTAL_STEPS * 0.98);
    dtClamped = true;
    tSteps = Math.round(transient / dt);
    sSteps = Math.ceil(simTime / dt - 1e-9);
  }
  // Samples: flows at BAKE_RATE song-time, maps one per iteration / 샘플 수
  let Ms = flow ? Math.round(duration * BAKE_RATE) + 1 : sSteps;
  let samplesClamped = false;
  if (N * Ms > MAX_TOTAL_SAMPLES) { Ms = Math.floor(MAX_TOTAL_SAMPLES / N); samplesClamped = true; }

  const ref = computeReference(sys, params, sweep, dt);
  const ev = makeSourceEval(sys, ref.center);
  const rand = createSeededRandom((Math.imul(seed, 2654435761) ^ 0x5bd1e995) >>> 0);
  const rk = flow ? createRK4(dim) : null;
  const pp = { ...params };
  const stepOnce = (s, t, n) => (flow ? rk(sys.deriv, s, pp, t, dt, s) : sys.step(s, pp, n, s));
  const clampState = (s) => { if (sys.id === 'logistic') s[0] = clamp(s[0], 1e-12, 1 - 1e-12); };

  // Seeded base IC → transient (shared) / 시드 초기값 → 과도 구간 (공유)
  const base = Float64Array.from(sys.defaultIC);
  const mask = sys.perturbMask;
  for (let i = 0; i < dim; i++) base[i] += (mask ? mask[i] : 1) * (2 * rand() - 1) * 1e-3 * sys.scaleHint;
  clampState(base);
  const lyapDir = unitVector(rand, dim, mask, new Float64Array(dim));
  applySweep(pp, sweep, 0);
  let baseBad = false;
  for (let k = 0; k < tSteps && !baseBad; k++) {
    const prev = Float64Array.from(base);
    stepOnce(base, (k - tSteps) * dt, k);
    if (isBad(base)) { base.set(prev); baseBad = true; }
  }

  const unitTau = flow ? dt : 1; // sim time per step / 스텝당 시뮬 시간
  const sampleTau = (j) => (flow ? (j / Math.max(1, Ms - 1)) * simTime : j);
  const st0 = new Float64Array(Ms * dim); // voice 0 state at samples / 보이스 0 상태
  const voices = [];
  const dirs = [];
  for (let i = 0; i < N; i++) dirs.push(i === 0 ? null : unitVector(rand, dim, mask, new Float64Array(dim)));
  const sweepVals = sweep ? new Float32Array(Ms) : null;
  let lyapunov = NaN;

  const s = new Float64Array(dim);
  const sPrev = new Float64Array(dim);
  const q = new Float64Array(dim);
  const c0 = new Float64Array(3);
  const c1 = new Float64Array(3);
  const c2 = new Float64Array(3);
  const sv = new Float64Array(ev.n);
  const svPrev = new Float64Array(ev.n);
  const stInterp = new Float64Array(dim);

  for (let i = 0; i < N; i++) {
    s.set(base);
    if (dirs[i]) for (let d = 0; d < dim; d++) s[d] += spread * i * dirs[i][d];
    clampState(s);
    const src = {};
    for (const id of ev.ids) src[id] = new Float32Array(Ms);
    const logd = i === 0 ? null : new Float32Array(Ms);
    let diverged = baseBad;
    let divergedAt = baseBad ? 0 : null;
    // Pre-roll two steps so backward differences exist at t = 0 / 후방 차분용 2스텝 선행
    applySweep(pp, sweep, 0);
    coordsOf(sys, s, pp, 0, c2);
    if (!diverged) stepOnce(s, -2 * unitTau, 0);
    coordsOf(sys, s, pp, 0, c1);
    if (!diverged) stepOnce(s, -unitTau, 1);
    if (isBad(s)) { diverged = true; divergedAt = 0; s.set(base); }
    // Benettin partner on voice 0 / 보이스 0의 베네틴 짝
    const lyap = i === 0 && !diverged;
    let lsum = 0;
    let ltime = 0;
    const renorm = flow ? Math.max(1, Math.round(0.5 / dt)) : 1;
    if (lyap) for (let d = 0; d < dim; d++) q[d] = s[d] + LYAP_D0 * lyapDir[d];

    let j = 0;
    for (let k = 0; k <= sSteps && j < Ms; k++) {
      const tk = k * unitTau;
      const u = flow ? tk / simTime : k / Math.max(1, sSteps - 1);
      applySweep(pp, sweep, u);
      coordsOf(sys, s, pp, tk, c0);
      ev.eval(s, pp, tk, c0, c1, c2, unitTau, sv);
      if (diverged) for (let qq = 3; qq < ev.n; qq++) if (ev.ids[qq] === 'speed' || ev.ids[qq] === 'curv') sv[qq] = 0;
      while (j < Ms && (flow ? sampleTau(j) <= tk + 1e-9 : j <= k)) {
        const useCur = !flow || k === 0;
        const frac = useCur ? 1 : clamp((sampleTau(j) - (tk - unitTau)) / unitTau, 0, 1);
        for (let qq = 0; qq < ev.n; qq++) src[ev.ids[qq]][j] = useCur ? sv[qq] : svPrev[qq] + frac * (sv[qq] - svPrev[qq]);
        for (let d = 0; d < dim; d++) stInterp[d] = useCur ? s[d] : sPrev[d] + frac * (s[d] - sPrev[d]);
        if (i === 0) st0.set(stInterp, j * dim);
        else {
          let d2 = 0;
          for (let d = 0; d < dim; d++) d2 += (stInterp[d] - st0[j * dim + d]) ** 2;
          logd[j] = Math.log10(Math.max(Math.sqrt(d2), 1e-300));
        }
        if (sweepVals && i === 0) sweepVals[j] = pp[sweep.param];
        j++;
      }
      if (k === sSteps) break;
      svPrev.set(sv);
      sPrev.set(s);
      c2.set(c1);
      c1.set(c0);
      if (!diverged) {
        stepOnce(s, tk, k + 2);
        clampState(s);
        if (isBad(s)) { s.set(sPrev); diverged = true; divergedAt = flow ? tk : k; }
        if (lyap && !diverged) {
          stepOnce(q, tk, k + 2);
          if ((k + 1) % renorm === 0) {
            let d2 = 0;
            for (let d = 0; d < dim; d++) d2 += (q[d] - s[d]) ** 2;
            const dd = Math.sqrt(d2);
            if (Number.isFinite(dd) && dd > 0) {
              lsum += Math.log(dd / LYAP_D0);
              ltime += renorm * unitTau;
              for (let d = 0; d < dim; d++) q[d] = s[d] + (q[d] - s[d]) * (LYAP_D0 / dd);
            }
          }
        }
      } else {
        c1.set(c0);
        c2.set(c0);
      }
    }
    for (; j < Ms; j++) { // numerical leftovers / 남은 샘플 채우기
      for (const id of ev.ids) src[id][j] = src[id][Math.max(0, j - 1)];
      if (logd) logd[j] = logd[Math.max(0, j - 1)];
      if (i === 0) st0.set(s, j * dim);
    }
    if (i === 0) lyapunov = lyap && ltime > 0 && !diverged ? lsum / ltime : NaN;
    voices.push({ src, logd, diverged, divergedAt });
  }

  // Divergence analysis / 발산 분석
  const thresholdLog10 = Math.log10(0.1 * ref.diam);
  const meanLogd = N > 1 ? new Float32Array(Ms) : null;
  let divergeIdx = -1;
  if (meanLogd) {
    for (let j = 0; j < Ms; j++) {
      let m = 0;
      for (let i = 1; i < N; i++) {
        const v = voices[i].logd[j];
        m += v;
        if (divergeIdx < 0 && v > thresholdLog10) divergeIdx = j;
      }
      meanLogd[j] = m / (N - 1);
    }
  }
  // Least-squares slope of ln d on the exponential window / 지수 성장 구간 기울기
  let fitSlope = NaN;
  let fitWin = null;
  if (meanLogd) {
    const startTau = flow ? Math.min(1, simTime * 0.05) : 1;
    const endLog = Math.log10(0.01 * ref.diam);
    let a = -1;
    let b = -1;
    for (let j = 0; j < Ms; j++) {
      const tau = sampleTau(j);
      if (a < 0 && tau >= startTau) a = j;
      if (a >= 0 && meanLogd[j] > endLog) { b = j; break; }
    }
    if (a >= 0 && b < 0) b = Ms - 1;
    if (a >= 0 && sampleTau(b) - sampleTau(a) >= (flow ? 2 : 3)) {
      let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let n = 0;
      for (let j = a; j <= b; j++) {
        const x = sampleTau(j);
        const y = meanLogd[j] * Math.LN10;
        sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
      }
      const den = n * sxx - sx * sx;
      if (den > 0) { fitSlope = (n * sxy - sx * sy) / den; fitWin = [a, b, (sy - fitSlope * sx) / n]; }
    }
  }
  const songSec = (j) => (flow ? (j / Math.max(1, Ms - 1)) * duration : j / rate);
  const out = Object.freeze({
    sig,
    bakeId: ++bakeSerial,
    sysId: sys.id,
    kind: sys.kind,
    N,
    Ms,
    duration,
    simTime: flow ? simTime : sSteps,
    rate,
    dt,
    dtClamped,
    samplesClamped,
    srcIds: ev.ids,
    voices,
    ref,
    lyapunov,
    fitSlope,
    fitWin,
    meanLogd,
    thresholdLog10,
    divergeSec: divergeIdx >= 0 ? songSec(divergeIdx) : null,
    divergeSim: divergeIdx >= 0 ? sampleTau(divergeIdx) : null,
    anyDiverged: voices.some((v) => v.diverged),
    sweepVals,
    sweep,
    steps: tSteps + (N + 1) * (sSteps + 2),
    bakeMs: (globalThis.performance || Date).now() - t0,
    sampleTau,
    songSec,
  });
  if (sig) lruSet(trajCache, sig, out);
  return out;
}

// ==========================================================================
// Stage B — mapping / 2단계: 매핑
// ==========================================================================

const mapCache = new Map();
let mapCount = 0;
/** Number of mapping passes so far (stage B). / 매핑 계산 횟수 */
export const getMapCount = () => mapCount;

export function shapeCurve(u, curve) {
  switch (curve) {
    case 'expo': return (Math.exp(3 * u) - 1) / (Math.exp(3) - 1);
    case 'log': return Math.log(1 + (Math.exp(3) - 1) * u) / 3;
    case 'smooth': return smoothstep(0, 1, u);
    default: return u;
  }
}

/** Nearest pitch of the scale (root 0–11). / 스케일의 가장 가까운 음 */
export function quantizeToScale(m, scale, root = 0) {
  const deg = SCALES[scale] || SCALES.major;
  const rel = m - root;
  const oct = Math.floor(rel / 12);
  let best = m;
  let bestD = Infinity;
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (const d of deg) {
      const c = root + o * 12 + d;
      const dist = Math.abs(c - m);
      if (dist < bestD) { bestD = dist; best = c; }
    }
  }
  return best;
}

function resolveChannel(sys, ch, fallbackSource, defaults) {
  const ids = systemSources(sys);
  return {
    source: ids.includes(ch?.source) ? ch.source : fallbackSource,
    lo: num(ch?.lo, defaults.lo),
    hi: num(ch?.hi, defaults.hi),
    curve: PITCH_CURVES.includes(ch?.curve) ? ch.curve : 'linear',
    invert: !!ch?.invert,
    quantize: QUANTIZE_MODES.includes(ch?.quantize) ? ch.quantize : 'off',
    scale: SCALES[ch?.scale] ? ch.scale : 'major',
    root: int(ch?.root, 0, 11, 0),
    slewMs: clamp(num(ch?.slewMs, 0), 0, 2000),
    quantAmt: clamp(num(ch?.quantAmt, 1), 0, 1), // 0 = continuous … 1 = fully snapped / 양자화 정도
    sens: clamp(num(ch?.sens, 1), 0, 4), // sensitivity of the output to the source position / 민감도
  };
}

/** Clamped mapping settings (shared with the UI). / 매핑 설정 정리 */
export function resolveMapping(doc) {
  const sys = getChaosSystem(doc.system);
  const m = doc.map || {};
  const out = {
    pitch: resolveChannel(sys, m.pitch, sys.defaultMap.pitch, { lo: 36, hi: 84 }),
    gain: resolveChannel(sys, m.gain, sys.defaultMap.gain, { lo: 0.15, hi: 0.9 }),
    bright: resolveChannel(sys, m.bright, sys.defaultMap.bright, { lo: 0, hi: 1 }),
    discrete: {
      mode: DISCRETE_MODES.includes(doc.discrete?.mode) ? doc.discrete.mode : 'hold',
      glideMs: clamp(num(doc.discrete?.glideMs, 40), 0, 2000),
    },
    normalize: NORMALIZE_MODES.includes(doc.normalize) ? doc.normalize : 'reference',
    axes: resolveAxes(doc),
  };
  // A channel assigned to a 3-D axis reads that axis (first axis wins). / 3D 축 할당이 소스를 대신함
  out.axes.forEach((a, i) => {
    const ch = out[a.target];
    if (ch && !AXIS_IDS.includes(ch.source)) ch.source = AXIS_IDS[i];
  });
  return out;
}

function mapChannel(values, range, ch, isPitch, out) {
  const [r0, r1] = range;
  const span = r1 - r0;
  const lo = Math.min(ch.lo, ch.hi);
  const hi = Math.max(ch.lo, ch.hi);
  for (let j = 0; j < values.length; j++) {
    let u = Math.abs(span) > 1e-12 ? clamp((values[j] - r0) / span, 0, 1) : 0.5;
    if (!Number.isFinite(u)) u = 0.5;
    if (ch.sens !== 1) u = clamp(0.5 + (u - 0.5) * ch.sens, 0, 1); // gain around the range centre / 중심 기준 증폭
    if (ch.invert) u = 1 - u;
    let y = ch.lo + (ch.hi - ch.lo) * shapeCurve(u, ch.curve);
    if (isPitch && ch.quantize !== 'off' && ch.quantAmt > 0) {
      const q = ch.quantize === '12tet' ? Math.round(y) : quantizeToScale(y, ch.scale, ch.root);
      y += ch.quantAmt * (q - y);
    }
    out[j] = clamp(y, lo, hi);
  }
  return out;
}

function slew(arr, ms, rateHz) {
  if (!(ms > 0)) return arr;
  const a = 1 - Math.exp(-1000 / (ms * rateHz));
  let y = arr[0];
  for (let j = 0; j < arr.length; j++) { y += a * (arr[j] - y); arr[j] = y; }
  return arr;
}

/** Expand per-note values to BAKE_RATE samples (hold = 5 ms step, glide = linear ramp). */
function expandNotes(notes, rate, M, ramp, out) {
  const n = notes.length;
  for (let j = 0; j < M; j++) {
    const tau = j / BAKE_RATE;
    const k = Math.min(n - 1, Math.floor(tau * rate + 1e-9));
    const local = tau - k / rate;
    const prev = k > 0 ? notes[k - 1] : notes[0];
    out[j] = local < ramp ? prev + (notes[k] - prev) * (local / ramp) : notes[k];
  }
  return out;
}

export function mappingSignature(doc, A) {
  return `${A.bakeId}|${JSON.stringify(resolveMapping(doc))}`;
}

/**
 * Full bake = stage A (cached) + stage B (cached). Returns
 * { A, M, voices:[{ pitch, gain, bright (Float32Array, BAKE_RATE), notes? }], mapping, ranges, stepMode }.
 * 전체 베이킹 결과 (1·2단계 모두 캐시).
 */
export function bakeChaos(doc, opts = {}) {
  const A = bakeChaosTrajectories(doc, opts);
  const sig = A.sig ? mappingSignature(doc, A) : null;
  if (sig && !opts.noCache) {
    const hit = lruGet(mapCache, sig);
    if (hit) return hit;
  }
  mapCount++;
  const mapping = resolveMapping(doc);
  const flow = A.kind === 'flow';
  const M = flow ? A.Ms : Math.round(A.duration * BAKE_RATE) + 1;
  const ramp = mapping.discrete.mode === 'hold' ? 1 / BAKE_RATE : clamp(mapping.discrete.glideMs / 1000, 1 / BAKE_RATE, 1 / A.rate);
  const chans = ['pitch', 'gain', 'bright'];
  const ranges = {};
  const voices = A.voices.map((v) => {
    const res = { notes: flow ? null : {} };
    for (const c of chans) {
      const ch = mapping[c];
      const ai = AXIS_IDS.indexOf(ch.source);
      const values = ai >= 0 ? axisValues(A, v, mapping.axes[ai]) : v.src[ch.source];
      const range = mapping.normalize === 'reference' ? (ai >= 0 ? [-1, 1] : A.ref.ranges[ch.source]) : percentileRange(values);
      if (!ranges[c]) ranges[c] = range;
      const mapped = mapChannel(values, range, ch, c === 'pitch', new Float32Array(values.length));
      if (flow) {
        res[c] = c === 'pitch' ? slew(mapped, ch.slewMs, BAKE_RATE) : mapped;
      } else {
        res.notes[c] = mapped;
        res[c] = expandNotes(mapped, A.rate, M, ramp, new Float32Array(M));
      }
    }
    return res;
  });
  const stepMode = flow ? mapping.pitch.quantize !== 'off' && mapping.pitch.quantAmt >= 0.999 && mapping.pitch.slewMs < 10 : mapping.discrete.mode === 'hold';
  const out = Object.freeze({ sig, A, M, voices, mapping, ranges, stepMode, ramp });
  if (sig) lruSet(mapCache, sig, out);
  return out;
}

/** Sample index for a song time (clamped). / 곡 시간 → 샘플 인덱스 */
export function sampleIndexAt(B, sec) {
  return clamp(Math.round(sec * BAKE_RATE), 0, B.M - 1);
}

/** Index into stage-A arrays (source / logd) for a song time. / 1단계 배열 인덱스 */
export function stageIndexAt(A, sec) {
  if (A.kind === 'flow') return clamp(Math.round((sec / A.duration) * (A.Ms - 1)), 0, A.Ms - 1);
  return clamp(Math.floor(sec * A.rate + 1e-9), 0, A.Ms - 1);
}

// ==========================================================================
// Bifurcation diagram (maps) / 분기도 (이산 사상)
// ==========================================================================

const bifCache = new Map();

/**
 * Bifurcation diagram of a map: for `cols` values of `paramId` in [from, to], the x coordinate of
 * `plot` iterations after `transient`. Cached. / 분기도 (캐시)
 */
export function computeBifurcation(sysId, params, paramId, from, to, { cols = 220, transient = 300, plot = 90 } = {}) {
  const sys = getChaosSystem(sysId);
  if (sys.kind !== 'map') return null;
  const key = JSON.stringify([sys.id, params, paramId, from, to, cols, transient, plot]);
  const hit = lruGet(bifCache, key);
  if (hit) return hit;
  const xs = new Float32Array(cols * plot);
  const pp = { ...params };
  const s = new Float64Array(sys.dim);
  const c = new Float64Array(3);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < cols; i++) {
    pp[paramId] = from + ((to - from) * i) / Math.max(1, cols - 1);
    s.set(sys.defaultIC);
    let bad = false;
    for (let k = 0; k < transient && !bad; k++) { sys.step(s, pp, k, s); bad = isBad(s); }
    for (let k = 0; k < plot; k++) {
      if (!bad) { sys.step(s, pp, k, s); bad = isBad(s); }
      coordsOf(sys, s, pp, 0, c);
      const x = bad ? NaN : c[0];
      xs[i * plot + k] = x;
      if (Number.isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    }
  }
  const out = Object.freeze({ key, cols, plot, from, to, xs, lo: Number.isFinite(lo) ? lo : 0, hi: Number.isFinite(hi) ? hi : 1 });
  lruSet(bifCache, key, out);
  return out;
}
