/**
 * Flexatone — modules/curve-engine.js
 * Layer 1 (modules): the 11 domain-agnostic curve engines.
 * 계층 1 (modules): 도메인 독립적인 11종 곡선 엔진.
 * Term: this is THE "Curve Engine" (voice.engine, ENGINE_IDS). Not a Studio Engine (studios/<id>/<id>-engine.js)
 * and not the Audio Engine (audio/audio-engine.js). / 용어: 이 파일이 "곡선 엔진(Curve Engine)".
 *
 * Every engine maps normalized time t∈[0,1] → y (nominally 0 → 1, overshoot allowed).
 * The same evaluator drives pitch trajectories, gain-engine envelopes, morph nodes and
 * (later) Risset / Field studio modulators. Nothing here knows about Hz or seconds except
 * the explicit voice helpers in §6.
 * 모든 엔진은 t∈[0,1] → y 를 계산하며 음고·게인·모핑·향후 스튜디오에서 동일하게 사용.
 *
 * Imports: core/* only. / core만 import.
 */

import {
  clamp,
  roundTo,
  deepClone,
  evaluateTimeWarp,
  evalPiecewiseBezierPoints,
  evalSplineSegmentAtFrac,
  analyzeTrajectoryFeatures,
  analyzeAndFitCustomToEngine,
  createSeededRandom,
  createLinearSplinePoints,
} from '../core/math-utils.js';
import { normToFreq, freqToMidi } from '../core/units.js';
import { compileFormula } from '../core/formula.js';
import { t } from '../core/i18n.js';
import {
  ENGINE_IDS,
  MORPH_MODES,
  TRIG_FNS,
  createDefaultCurveParams,
  createDefaultCurveConfig,
  createDefaultMorphNode,
  createDefaultVoice,
  getVoiceHz,
  registerSelfCheck,
} from '../core/state.js';

// ==========================================================================
// 1. Engine definitions & parameter schemas / 엔진 정의 및 파라미터 스키마
// ==========================================================================

/**
 * @typedef {object} EngineDef
 * @property {string} id
 * @property {number} num          UI number 1–11
 * @property {string} nameKey      i18n key (long name)
 * @property {string} shortKey     i18n key (tab label)
 * @property {string} formula      display formula
 * @property {'formula'|'composite'|'spline'} kind
 * @property {boolean} fittable    usable as a target of custom → engine inverse fitting
 */
export const ENGINE_DEFS = Object.freeze(
  [
    ['harmonic', 'formula', true, 'f(t) = ½(1 − cos πφ) + ((tan α − π/2)/2π)·sin 2πφ·sin πφ,  φ = φ(t; x₁, x₂)'],
    ['damped', 'formula', true, 'f(t) = 1 + A·env(τ)·e^(−kτ)·sin(2πNτ),  τ = (t − t₀)/(1 − t₀)'],
    ['anticipation', 'formula', true, 'f(t) = t^p − d·B(t; t_w) + r·9.48·t⁴(1 − t)'],
    ['ratchet', 'formula', true, 'f(t) = (⌊Nt⌋ + smooth_σ({Nt})) / N'],
    ['chirp', 'formula', true, 'f(t) = ½(1 − cos πt) + A·sin²(πt)·sin(2π(f₀t + ½(f₁ − f₀)t²))'],
    ['bounce', 'formula', true, 'f(t) = 1 − e^(−kt)(1 − t⁶)·|cos(½π(2N + 1)t^p)|'],
    ['bezier', 'formula', true, 'B(s) = 3(1−s)²s·P₁ + 3(1−s)s²·P₂ + s³,  Bx(s) = t'],
    ['plateau', 'formula', true, 'C² quintic shelf through (t_m, y_m) with hold width W'],
    ['polynomial', 'formula', false, 'Lagrange P_n(t) = Σ yᵢ · Π_{j≠i} (t − xⱼ)/(xᵢ − xⱼ)'],
    ['morph', 'composite', false, 'F(t) = fold_i( op_i, wᵢ · Engineᵢ(t) )  — Blend / +Add / ×Mul / −Diff'],
    ['custom', 'spline', false, 'Piecewise Bézier spline (editable anchors & handles)'],
    ['expo', 'formula', false, 'exp: (e^(kt) − 1)/(e^k − 1)   ·   log: ln(1 + (e^k − 1)t)/k'],
    ['trig', 'formula', false, 'g ∈ {sin, cos, tan, asin, acos, atan},  x = x₀ + (x₁ − x₀)t,  y = (g(x) − g(x₀))/(g(x₁) − g(x₀))'],
    ['formula', 'formula', false, 'f(t; a, b, c …) — your own expression, optionally normalized to f(0)=0, f(1)=1'],
  ].map(([id, kind, fittable, formula]) =>
    Object.freeze({
      id,
      num: ENGINE_IDS.indexOf(id) + 1,
      nameKey: `engineName.${id}`,
      shortKey: `engineShort.${id}`,
      formula,
      kind,
      fittable,
    }),
  ),
);

const ENGINE_DEF_MAP = new Map(ENGINE_DEFS.map((d) => [d.id, d]));

export function getEngineDef(id) {
  return ENGINE_DEF_MAP.get(id) || null;
}

/** Localised engine label. / 현지화된 엔진 이름 */
export function getEngineLabel(id, { short = false } = {}) {
  const def = getEngineDef(id);
  return def ? t(short ? def.shortKey : def.nameKey) : String(id);
}

const D = createDefaultCurveParams();

/** Numeric range parameter. min/max are hard clamps used by the evaluators; soft* bound UI sliders. */
const range = (key, min, max, step, extra = {}) => ({
  key,
  type: 'range',
  labelKey: `param.${key}`,
  min,
  max,
  step,
  softMin: extra.softMin ?? min,
  softMax: extra.softMax ?? max,
  integer: !!extra.integer,
  default: D[key],
});

/**
 * Parameter schema per engine — rendered automatically by ui/panels.js and used as the
 * single source of truth for evaluator clamps and inverse-fit search ranges.
 * 엔진별 파라미터 스키마 — UI 자동 렌더링, 평가기 범위 제한, 역근사 탐색 범위의 단일 기준.
 */
export const PARAM_SCHEMAS = Object.freeze({
  harmonic: [
    range('alpha', -88, 88, 0.5),
    range('x1', 0.05, 0.48, 0.01),
    range('x2', 0.52, 0.95, 0.01),
    { key: 'symLock', type: 'toggle', labelKey: 'param.symLock', default: D.symLock },
  ],
  damped: [
    { key: 'dampC1', type: 'toggle', labelKey: 'param.dampC1', offLabelKey: 'param.dampC0', default: D.dampC1 },
    range('dampT0', 0.05, 0.92, 0.01),
    range('dampA', -10, 10, 0.01, { softMin: -1.5, softMax: 1.5 }),
    range('dampN', 0.5, 100, 0.1, { softMax: 20 }),
    range('dampK', 0.1, 20, 0.1),
  ],
  anticipation: [
    range('antD', 0, 3, 0.01, { softMax: 1 }),
    range('antTw', 0.05, 0.75, 0.01),
    range('antP', 0.5, 8, 0.05),
    range('antR', 0, 3, 0.01, { softMax: 1 }),
  ],
  ratchet: [range('ratN', 1, 128, 1, { softMax: 32, integer: true }), range('ratSig', 0.01, 1, 0.01)],
  chirp: [
    range('chirpA', -2, 2, 0.005, { softMin: -0.5, softMax: 0.5 }),
    range('chirpF0', 0.1, 100, 0.1, { softMax: 30 }),
    range('chirpF1', 0.1, 100, 0.1, { softMax: 30 }),
  ],
  bounce: [
    range('bounceN', 1, 100, 1, { softMax: 20 }),
    range('bounceK', 0.1, 15, 0.05),
    range('bounceP', 0.4, 5, 0.05),
  ],
  bezier: [
    range('bezX1', 0, 1, 0.01),
    range('bezY1', -5, 5, 0.01, { softMin: -1, softMax: 2 }),
    range('bezX2', 0, 1, 0.01),
    range('bezY2', -5, 5, 0.01, { softMin: -1, softMax: 2 }),
  ],
  plateau: [range('platTm', 0.1, 0.9, 0.01), range('platYm', -1, 2, 0.01), range('platW', 0, 0.7, 0.01)],
  polynomial: [{ key: 'polyPoints', type: 'points', labelKey: 'param.polyDeg', minPoints: 1, maxPoints: 9, yMin: -12, yMax: 12 }],
  morph: [
    {
      key: 'morphMode',
      type: 'select',
      labelKey: 'param.morphMode',
      options: MORPH_MODES.map((m) => ({ value: m, labelKey: `morph.${m}` })),
      default: 'blend',
    },
    { key: 'morphNodes', type: 'nodes', labelKey: 'param.morphAdd', maxNodes: 8, weightMin: -4, weightMax: 4 },
  ],
  custom: [{ key: 'customPoints', type: 'spline', labelKey: 'custom.pointCount', maxHandles: 6 }],
  expo: [
    {
      key: 'expMode',
      type: 'select',
      labelKey: 'param.expMode',
      options: [{ value: 'exp', labelKey: 'expMode.exp' }, { value: 'log', labelKey: 'expMode.log' }],
      default: 'exp',
    },
    range('expK', 0.01, 30, 0.01, { softMin: 0.1, softMax: 12 }),
  ],
  trig: [
    {
      key: 'trigFn',
      type: 'select',
      labelKey: 'param.trigFn',
      options: TRIG_FNS.map((f) => ({ value: f, labelKey: `trigFn.${f}` })),
      default: 'sin',
    },
    range('trigX0', -20, 20, 0.01, { softMin: -2, softMax: 2 }),
    range('trigX1', -20, 20, 0.01, { softMin: -2, softMax: 2 }),
    { key: 'trigNorm', type: 'toggle', labelKey: 'param.trigNorm', offLabelKey: 'param.trigRaw', default: D.trigNorm },
    range('trigAmp', -10, 10, 0.01, { softMin: -2, softMax: 2 }),
    range('trigBias', -10, 10, 0.01, { softMin: -2, softMax: 2 }),
  ],
  formula: [
    { key: 'formulaExpr', type: 'formula', labelKey: 'param.formulaExpr' },
    { key: 'formulaNorm', type: 'toggle', labelKey: 'param.formulaNorm', offLabelKey: 'param.formulaRaw', default: D.formulaNorm },
  ],
});

/** key → numeric range schema (for clamping). / 숫자 파라미터 색인 */
const NUMERIC_PARAMS = {};
for (const list of Object.values(PARAM_SCHEMAS)) {
  for (const s of list) if (s.type === 'range') NUMERIC_PARAMS[s.key] = s;
}

/** Read a numeric engine parameter with default + hard clamp from PARAM_SCHEMAS. */
export function readParam(p, key) {
  const s = NUMERIC_PARAMS[key];
  const raw = Number(p?.[key]);
  const v = Number.isFinite(raw) ? raw : s.default;
  return clamp(s.integer ? Math.round(v) : v, s.min, s.max);
}

// ==========================================================================
// 2. Single-engine evaluators / 단일 엔진 평가기
// ==========================================================================

const quintic = (s) => s * s * s * (s * (6 * s - 15) + 10);

function evalHarmonic(tt, p) {
  const x1 = readParam(p, 'x1');
  const x2 = p?.symLock ? clamp(1 - x1, 0.52, 0.95) : readParam(p, 'x2');
  const u = evaluateTimeWarp(tt, x1, x2);
  const m = Math.tan((readParam(p, 'alpha') * Math.PI) / 180);
  const base = 0.5 * (1 - Math.cos(Math.PI * u));
  const pert = ((m - Math.PI / 2) / (2 * Math.PI)) * Math.sin(2 * Math.PI * u) * Math.sin(Math.PI * u);
  return base + pert;
}

function evalDamped(tt, p) {
  const t0 = readParam(p, 'dampT0');
  const A = readParam(p, 'dampA');
  const N = readParam(p, 'dampN');
  const k = readParam(p, 'dampK');
  if (tt <= t0) return 0.5 * (1 - Math.cos((Math.PI * tt) / t0));
  const tau = (tt - t0) / Math.max(1e-6, 1 - t0);
  const osc = Math.exp(-k * tau) * Math.sin(2 * Math.PI * N * tau);
  if (p?.dampC1 !== false) {
    // C¹ lock: τ²(1−τ)² envelope keeps slope 0 at impact and arrival
    // C¹ 잠금: 충돌·도착 시 기울기 0 유지
    const normScale = 16 * Math.exp(k * 0.15);
    return 1 + A * normScale * tau * tau * (1 - tau) * (1 - tau) * osc;
  }
  return 1 + A * (1 - tau) * (1 - tau) * osc;
}

function evalAnticipation(tt, p) {
  const d = readParam(p, 'antD');
  const tw = readParam(p, 'antTw');
  const pw = readParam(p, 'antP');
  const r = readParam(p, 'antR');
  const expA = 2;
  const expB = expA * ((1 - tw) / Math.max(1e-4, tw)); // peak of t^a(1−t)^b sits at t = tw
  const peakNorm = Math.pow(tw, expA) * Math.pow(1 - tw, expB);
  const windup = peakNorm > 1e-12 ? (d * Math.pow(tt, expA) * Math.pow(1 - tt, expB)) / peakNorm : 0;
  const overshoot = r * 9.48 * Math.pow(tt, 4) * (1 - tt);
  return Math.pow(tt, pw) - windup + overshoot;
}

function evalRatchet(tt, p) {
  const N = readParam(p, 'ratN');
  const sig = readParam(p, 'ratSig');
  const scaled = N * tt;
  const k = Math.min(N - 1, Math.floor(scaled));
  const frac = scaled - k;
  if (frac >= sig) return (k + 1) / N;
  const u = frac / sig;
  return (k + u * u * (3 - 2 * u)) / N;
}

function evalChirp(tt, p) {
  const A = readParam(p, 'chirpA');
  const f0 = readParam(p, 'chirpF0');
  const f1 = readParam(p, 'chirpF1');
  const base = 0.5 * (1 - Math.cos(Math.PI * tt));
  const phase = 2 * Math.PI * (f0 * tt + 0.5 * (f1 - f0) * tt * tt);
  const s = Math.sin(Math.PI * tt);
  return base + A * s * s * Math.sin(phase);
}

function evalBounce(tt, p) {
  const N = readParam(p, 'bounceN');
  const k = readParam(p, 'bounceK');
  const pw = readParam(p, 'bounceP');
  const env = Math.exp(-k * tt) * (1 - Math.pow(tt, 6));
  return 1 - env * Math.abs(Math.cos(0.5 * Math.PI * (2 * N + 1) * Math.pow(tt, pw)));
}

function evalBezier(tt, p) {
  const x1 = readParam(p, 'bezX1');
  const y1 = readParam(p, 'bezY1');
  const x2 = readParam(p, 'bezX2');
  const y2 = readParam(p, 'bezY2');
  const bx = (s) => {
    const u = 1 - s;
    return 3 * u * u * s * x1 + 3 * u * s * s * x2 + s * s * s;
  };
  // Newton–Raphson with bisection safeguard (Bx is monotone because x1, x2 ∈ [0,1])
  // 뉴턴-랩슨 + 이분법 보호
  let lo = 0;
  let hi = 1;
  let s = tt;
  for (let i = 0; i < 12; i++) {
    const u = 1 - s;
    const f = bx(s) - tt;
    if (Math.abs(f) < 1e-9) break;
    if (f > 0) hi = s;
    else lo = s;
    const df = 3 * u * u * x1 + 6 * u * s * (x2 - x1) + 3 * s * s * (1 - x2);
    let next = Math.abs(df) > 1e-9 ? s - f / df : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    s = next;
  }
  const u = 1 - s;
  return 3 * u * u * s * y1 + 3 * u * s * s * y2 + s * s * s;
}

function evalPlateau(tt, p) {
  const tm = readParam(p, 'platTm');
  const ym = readParam(p, 'platYm');
  const w = readParam(p, 'platW');
  const tStart = Math.max(0.02, tm - w * 0.5);
  const tEnd = Math.min(0.98, tm + w * 0.5);
  if (tt <= tStart) return ym * quintic(tt / tStart);
  if (tt <= tEnd) return ym;
  return ym + (1 - ym) * quintic((tt - tEnd) / Math.max(1e-5, 1 - tEnd));
}

function evalPolynomial(tt, p) {
  const pts = Array.isArray(p?.polyPoints) && p.polyPoints.length ? p.polyPoints : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  if (pts.length === 1) return Number(pts[0].y) || 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    let li = 1;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const denom = pts[i].x - pts[j].x;
      if (Math.abs(denom) < 1e-5) continue; // duplicate x → ignore that factor
      li *= (tt - pts[j].x) / denom;
    }
    sum += pts[i].y * li;
  }
  return clamp(sum, -12, 12);
}

function evalCustom(tt, p) {
  const pts = p?.customPoints;
  if (!Array.isArray(pts) || pts.length < 2) return tt;
  return evalPiecewiseBezierPoints(pts, tt);
}

const Y_LIMIT = 12;

/** 12. Exp / Log — exp: convex (e^(kt)−1)/(e^k−1); log: its exact inverse ln(1+(e^k−1)t)/k. */
function evalExpo(tt, p) {
  const k = readParam(p, 'expK');
  const em1 = Math.expm1(k);
  if (p?.expMode === 'log') return Math.log1p(em1 * tt) / k;
  return Math.expm1(k * tt) / em1;
}

const TRIG_IMPL = {
  sin: (x) => Math.sin(Math.PI * x),
  cos: (x) => Math.cos(Math.PI * x),
  tan: (x) => clamp(Math.tan(Math.PI * x), -50, 50),
  asin: (x) => Math.asin(clamp(x, -1, 1)),
  acos: (x) => Math.acos(clamp(x, -1, 1)),
  atan: (x) => Math.atan(x),
};

/**
 * 13. Trig — g(x) over x = x₀ + (x₁ − x₀)t. sin/cos/tan take x in units of π (x = 0.5 → π/2);
 * asin/acos take x ∈ [−1, 1]; atan takes any x (−5 → 5 is a sigmoid).
 * Normalized: endpoints mapped to 0 → 1; if g(x₀) = g(x₁) (e.g. whole sine cycles) the
 * shape rides on a linear ramp instead: y = t + A·(g(x) − g(x₀))/2.
 * Raw: y = A·g(x) + bias. / 삼각·역삼각 함수 엔진
 */
function evalTrig(tt, p) {
  const g = TRIG_IMPL[p?.trigFn] || TRIG_IMPL.sin;
  const x0 = readParam(p, 'trigX0');
  const x1 = readParam(p, 'trigX1');
  const A = readParam(p, 'trigAmp');
  const gx = g(x0 + (x1 - x0) * tt);
  if (p?.trigNorm === false) return clamp(A * gx + readParam(p, 'trigBias'), -Y_LIMIT, Y_LIMIT);
  const g0 = g(x0);
  const g1 = g(x1);
  if (Math.abs(g1 - g0) > 1e-9) return clamp((gx - g0) / (g1 - g0), -Y_LIMIT, Y_LIMIT);
  return clamp(tt + 0.5 * A * (gx - g0), -Y_LIMIT, Y_LIMIT);
}

/** Compile an object's formula with its variable list (cached in core/formula.js). */
export function compileCurveFormula(p) {
  const vars = Array.isArray(p?.formulaVars) ? p.formulaVars : [];
  return compileFormula(p?.formulaExpr, vars.map((v) => v.name));
}

/**
 * 14. User formula f(t; a, b, c …). Normalized mode maps f(0) → 0 and f(1) → 1 (skipped
 * when f(0) = f(1)); invalid formulas fall back to y = t. / 사용자 수식 엔진
 */
function evalFormula(tt, p) {
  const c = compileCurveFormula(p);
  if (!c.ok) return tt;
  const vars = Array.isArray(p.formulaVars) ? p.formulaVars : [];
  const scope = [tt];
  for (const v of vars) scope.push(Number(v.value) || 0);
  const at = (x) => { scope[0] = x; return c.fn(scope); };
  const y = at(tt);
  if (!Number.isFinite(y)) return tt;
  if (p.formulaNorm !== false) {
    const f0 = at(0);
    const f1 = at(1);
    if (Number.isFinite(f0) && Number.isFinite(f1) && Math.abs(f1 - f0) > 1e-9) return clamp((y - f0) / (f1 - f0), -Y_LIMIT, Y_LIMIT);
  }
  return clamp(y, -Y_LIMIT, Y_LIMIT);
}

/** id → (t, params) => y for every non-composite engine. / 단일 엔진 평가 함수 표 */
export const ENGINE_EVALUATORS = Object.freeze({
  harmonic: evalHarmonic,
  damped: evalDamped,
  anticipation: evalAnticipation,
  ratchet: evalRatchet,
  chirp: evalChirp,
  bounce: evalBounce,
  bezier: evalBezier,
  plateau: evalPlateau,
  polynomial: evalPolynomial,
  custom: evalCustom,
  expo: evalExpo,
  trig: evalTrig,
  formula: evalFormula,
});

/**
 * Evaluate one engine (no reverse/inverse, no morph recursion). Unknown ids → identity.
 * 단일 엔진 평가 (반전 없음, 모핑 재귀 없음). 알 수 없는 id는 항등함수.
 */
export function evalSingleEngine(engineId, tt, params) {
  const fn = ENGINE_EVALUATORS[engineId];
  const y = fn ? fn(tt, params) : tt;
  return Number.isFinite(y) ? y : tt;
}

// ==========================================================================
// 3. Multi-Function Morph (engine 10) / 다중 함수 모핑
// ==========================================================================

/** Nodes that are audible in the morph fold (solo beats bypass). / 실제 합성에 쓰이는 노드 */
export function getActiveMorphNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  const anySolo = nodes.some((n) => n && n.solo);
  return nodes.filter((n) => n && (anySolo ? n.solo : !n.bypass));
}

/** Effective op of a node: its own op, else the curve's morphMode. */
export function getMorphNodeOp(node, curveObj) {
  const op = node?.op || curveObj?.morphMode || 'blend';
  return MORPH_MODES.includes(op) ? op : 'blend';
}

/**
 * Fold the active morph nodes. / 활성 노드 합성
 *   1. All Blend nodes form a weighted average  Σwᵢvᵢ / Σ|wᵢ|  (order-independent).
 *   2. Remaining nodes are applied in list order on top of that base:
 *        +Add : acc = acc + w·v            (acc starts at 0)
 *        −Diff: acc = acc − w·v            (first term with no base is taken positively)
 *        ×Mul : acc = acc · ((1−w) + w·v)  (acc starts at 1; w = 0 → no effect)
 *   With every node sharing one op this reduces exactly to the classic global modes.
 *   No active nodes → identity f(t) = t.
 */
export function evalMorph(tt, curveObj) {
  const nodes = getActiveMorphNodes(curveObj?.morphNodes);
  if (!nodes.length) return tt;

  let sumW = 0;
  let sumWV = 0;
  let firstBlend = null;
  const chain = [];
  for (const n of nodes) {
    const engine = n.engine === 'morph' ? 'harmonic' : n.engine;
    const v = evalSingleEngine(engine, tt, n);
    const w = Number.isFinite(Number(n.weight)) ? Number(n.weight) : 0;
    const op = getMorphNodeOp(n, curveObj);
    if (op === 'blend') {
      if (firstBlend === null) firstBlend = v;
      sumW += Math.abs(w);
      sumWV += w * v;
    } else {
      chain.push({ op, w, v });
    }
  }

  let acc = null;
  if (firstBlend !== null) acc = sumW > 1e-9 ? sumWV / sumW : firstBlend;
  for (const { op, w, v } of chain) {
    if (op === 'add') acc = (acc ?? 0) + w * v;
    else if (op === 'diff') acc = acc === null ? w * v : acc - w * v;
    else if (op === 'mul') acc = (acc ?? 1) * (1 - w + w * v);
  }
  return acc ?? tt;
}

// ==========================================================================
// 4. Domain-agnostic curve-object evaluation / 곡선 객체 평가
// ==========================================================================

/**
 * Evaluate any curve config (voice, gainEngineObj, morph node) at tNorm∈[0,1].
 * Applies reverse f(1 − t) then inverse 1 − f. Always finite.
 * 모든 곡선 설정을 평가 (reverse → inverse 순서 적용, 항상 유한값).
 * @param {object} obj  { engine, reverse?, inverse?, ...params, morphNodes?, customPoints? }
 * @param {number} tNorm
 * @param {{ raw?: boolean }} [opts] raw = ignore reverse/inverse
 */
export function evaluateCurveObjectY(obj, tNorm, opts = {}) {
  if (!obj) return clamp(tNorm, 0, 1);
  const tc = clamp(Number.isFinite(tNorm) ? tNorm : 0, 0, 1);
  const raw = !!opts.raw;
  const te = !raw && obj.reverse ? 1 - tc : tc;
  let y = obj.engine === 'morph' ? evalMorph(te, obj) : evalSingleEngine(obj.engine, te, obj);
  if (!Number.isFinite(y)) y = te;
  if (!raw && obj.inverse) y = 1 - y;
  if (!raw && opts.regions !== false && Array.isArray(obj.regions) && obj.regions.length) y = applyRegionsY(obj, tc, y);
  return y;
}

// ==========================================================================
// 4b. Local regions (Select tool) / 로컬 구간 (선택 도구)
// ==========================================================================

/** C² smootherstep 0 → 1. / C² 스무더스텝 */
export const smootherstep = (s) => {
  const x = clamp(s, 0, 1);
  return x * x * x * (x * (6 * x - 15) + 10);
};

const baseY = (obj, tn) => evaluateCurveObjectY(obj, tn, { regions: false });

/**
 * The value a region asks for at tn (before mix / ramps).
 *   global: the region's own curve evaluated on the voice's time axis.
 *   local : the region's curve squeezed into [t0, t1] and spanned between the voice's own
 *           values at the two edges (so values always meet; slopes may not).
 * 구간 목표값: global = 보이스 시간축 그대로, local = 구간 안으로 압축해 양 끝값을 이음.
 */
export function regionTargetY(obj, r, tn) {
  if (r.timeMode === 'local') {
    const a = baseY(obj, r.t0);
    const b = baseY(obj, r.t1);
    const u = (tn - r.t0) / Math.max(1e-9, r.t1 - r.t0);
    return a + (b - a) * evaluateCurveObjectY(r.curve, u);
  }
  return evaluateCurveObjectY(r.curve, tn);
}

const EDGE_EPS = 1e-3;
const EDGE_JUMP_TOL = 2e-3;
const EDGE_KINK_TOL = 0.08;

/**
 * Smoothness of a region edge after mixing: value jump and slope jump (kink) between the
 * curve just outside and just inside. / 구간 경계의 값 점프·기울기 꺾임 분석
 * @returns {{ jump: number, kink: number, smooth: boolean }}
 */
export function analyzeRegionEdge(obj, r, side) {
  const mix = clamp(Number(r.mix) || 0, 0, 1);
  const te = side === 'in' ? r.t0 : r.t1;
  if (te <= 1e-6 || te >= 1 - 1e-6 || mix <= 0) return { jump: 0, kink: 0, smooth: true };
  const dir = side === 'in' ? 1 : -1; // +1: inside lies to the right
  const inner = (x) => { const b = baseY(obj, x); return b + mix * (regionTargetY(obj, r, x) - b); };
  const outerV = baseY(obj, te);
  const innerV = inner(te);
  const outerSlope = (baseY(obj, te) - baseY(obj, te - dir * EDGE_EPS)) / (dir * EDGE_EPS);
  const innerSlope = (inner(te + dir * EDGE_EPS) - innerV) / (dir * EDGE_EPS);
  const jump = innerV - outerV;
  const kink = innerSlope - outerSlope;
  return { jump, kink, smooth: Math.abs(jump) < EDGE_JUMP_TOL && Math.abs(kink) < EDGE_KINK_TOL };
}

/** Whether an edge gets a ramp under the region's policy. / 경계 램프 적용 여부 */
export function regionEdgeRamped(obj, r, side) {
  if (r.ramp === 'on') return true;
  if (r.ramp === 'off') return false;
  return !analyzeRegionEdge(obj, r, side).smooth;
}

/** Ramp length in normalized voice time (≤ half the region). / 정규화 램프 길이 */
export function regionRampNorm(r, durationSec, minSec = 0) {
  const sec = Math.max(minSec, Number(r.rampSec) || 0);
  return Math.min(sec / Math.max(1e-6, durationSec || 1), 0.5 * (r.t1 - r.t0));
}

/**
 * Window weight 0…1 of a region at tn with smootherstep ramps on the chosen edges.
 * 구간 창 가중치 (선택된 경계에 스무더스텝 램프).
 */
export function regionWindow(r, tn, rampNorm, rampIn, rampOut) {
  if (tn < r.t0 || tn > r.t1) return 0;
  let w = 1;
  if (rampIn && rampNorm > 0 && tn < r.t0 + rampNorm) w = smootherstep((tn - r.t0) / rampNorm);
  if (rampOut && rampNorm > 0 && tn > r.t1 - rampNorm) w = Math.min(w, smootherstep((r.t1 - tn) / rampNorm));
  return w;
}

/**
 * Blend every region of a voice into its curve value y at tn (list order; later regions
 * act on the result of earlier ones). Edge smoothness is analysed only inside ramp zones.
 * 보이스 곡선값 y에 구간들을 순서대로 혼합.
 */
export function applyRegionsY(obj, tn, y) {
  for (const r of obj.regions) {
    if (!r || !r.curve || tn < r.t0 || tn > r.t1) continue;
    const mix = clamp(Number(r.mix) || 0, 0, 1);
    if (mix <= 0) continue;
    const rn = regionRampNorm(r, obj.duration);
    const nearIn = tn < r.t0 + rn;
    const nearOut = tn > r.t1 - rn;
    const w = regionWindow(r, tn, rn, nearIn && regionEdgeRamped(obj, r, 'in'), nearOut && regionEdgeRamped(obj, r, 'out'));
    if (w <= 0) continue;
    const target = regionTargetY(obj, r, tn);
    if (Number.isFinite(target)) y += w * mix * (target - y);
  }
  return y;
}

/** Sample a curve object at n+1 uniform points. / 균등 샘플링 */
export function sampleCurveObject(obj, n = 256, opts = {}) {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = evaluateCurveObjectY(obj, i / n, opts);
  return out;
}

/** Shape features (retrograde, extrema, overshoot) for HUD badges. / 궤적 특징 */
export function analyzeCurveFeatures(obj, samples = 200) {
  return analyzeTrajectoryFeatures(sampleCurveObject(obj, samples));
}

// ==========================================================================
// 5. Derivative / 도함수
// ==========================================================================

const DERIV_EPS = 1 / 512;

/** Raw dy/dt (central difference, one-sided at the edges). / 원시 도함수 */
export function evaluateCurveDerivative(obj, tNorm) {
  const t0 = clamp(tNorm - DERIV_EPS, 0, 1);
  const t1 = clamp(tNorm + DERIV_EPS, 0, 1);
  return (evaluateCurveObjectY(obj, t1) - evaluateCurveObjectY(obj, t0)) / Math.max(1e-9, t1 - t0);
}

/**
 * Min/max of f′(t) over [0,1] for normalisation. Pass the result to
 * evaluateVoiceDerivativeNorm in tight loops (audio scheduling) to avoid recomputing.
 * f′(t) 최솟값/최댓값 — 반복 루프에서는 결과를 재사용할 것.
 */
export function computeDerivativeStats(obj, samples = 128) {
  let dMin = Infinity;
  let dMax = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = evaluateCurveDerivative(obj, i / samples);
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) return { dMin: -0.5, dMax: 0.5 };
  if (dMax - dMin < 1e-6) {
    dMin -= 0.5;
    dMax += 0.5;
  }
  return { dMin, dMax };
}

/**
 * Normalized derivative of a voice curve: (f′(t) − min f′) / (max f′ − min f′) ∈ [0,1].
 * A constant slope maps to 0.5. Used when voice.audioTarget === 'vel' and for the f′ overlay.
 * 정규화된 도함수 ∈ [0,1] (기울기 일정 → 0.5). audioTarget='vel' 및 f′ 오버레이에 사용.
 * @param {object} v  voice (or any curve object)
 * @param {number} tNorm
 * @param {{dMin:number, dMax:number}} [stats] precomputed computeDerivativeStats(v)
 */
export function evaluateVoiceDerivativeNorm(v, tNorm, stats = null) {
  const st = stats || computeDerivativeStats(v);
  const d = evaluateCurveDerivative(v, tNorm);
  return clamp((d - st.dMin) / Math.max(1e-9, st.dMax - st.dMin), 0, 1);
}

// ==========================================================================
// 6. Voice → frequency mapping / 보이스 주파수 매핑
// ==========================================================================

export const FREQ_CLAMP_MIN = 15;
export const FREQ_CLAMP_MAX = 19500;

/** Map a normalized y onto the voice's F0→F1 range (log or linear). Extrapolates, then clamps. */
export function mapNormYToFreq(v, yNorm) {
  const f0 = clamp(getVoiceHz(v, 'f0'), FREQ_CLAMP_MIN, 18000);
  const f1 = clamp(getVoiceHz(v, 'f1'), FREQ_CLAMP_MIN, 18000);
  return clamp(normToFreq(yNorm, f0, f1, v.logScale !== false), FREQ_CLAMP_MIN, FREQ_CLAMP_MAX);
}

/**
 * Instantaneous frequency of a voice at normalized time. Honours audioTarget
 * ('pos' → f(t), 'vel' → normalized f′(t)).
 * 정규화 시간에서의 순간 주파수 (audioTarget 반영).
 * @param {object} v voice
 * @param {number} tNorm
 * @param {{ stats?: {dMin:number,dMax:number}, target?: 'pos'|'vel' }} [opts]
 */
export function getVoiceFreqAtNormT(v, tNorm, opts = {}) {
  const target = opts.target || v.audioTarget || 'pos';
  const y = target === 'vel' ? evaluateVoiceDerivativeNorm(v, tNorm, opts.stats) : evaluateCurveObjectY(v, tNorm);
  return mapNormYToFreq(v, y);
}

/** Fractional MIDI of a voice at normalized time. */
export function getVoiceMidiAtNormT(v, tNorm, opts = {}) {
  return freqToMidi(getVoiceFreqAtNormT(v, tNorm, opts));
}

/** Absolute seconds → normalized time of a voice (unclamped; check 0…1 for activity). */
export function absTimeToNormT(v, sec) {
  return (sec - v.startTime) / Math.max(1e-9, v.duration);
}

// ==========================================================================
// 7. Adaptive capture → custom spline / 적응형 커스텀 스플라인 변환
// ==========================================================================

/**
 * Least-squares cubic Bézier for one segment with handles at u = ⅓, ⅔ (so Bx(s) = s).
 * 구간별 최소제곱 3차 베지에 (핸들 u = ⅓, ⅔ 고정 → x 매개변수 = s).
 */
function fitSegmentHandles(fn, x0, x1, y0, y1, n = 16) {
  let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
  for (let k = 1; k < n; k++) {
    const s = k / n;
    const u = 1 - s;
    const b0 = u * u * u, b1 = 3 * u * u * s, b2 = 3 * u * s * s, b3 = s * s * s;
    const r = fn(x0 + s * (x1 - x0)) - b0 * y0 - b3 * y1;
    a11 += b1 * b1; a12 += b1 * b2; a22 += b2 * b2;
    r1 += b1 * r; r2 += b2 * r;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return [];
  const c1 = (r1 * a22 - r2 * a12) / det;
  const c2 = (a11 * r2 - a12 * r1) / det;
  const l1 = y0 + (y1 - y0) / 3;
  const l2 = y0 + (2 * (y1 - y0)) / 3;
  if (Math.abs(c1 - l1) < 1e-5 && Math.abs(c2 - l2) < 1e-5) return []; // straight
  return [{ u: 0.3333, y: roundTo(c1, 5) }, { u: 0.6667, y: roundTo(c2, 5) }];
}

function segmentError(fn, p0, p1, n = 24) {
  let maxErr = 0;
  let worstX = 0.5 * (p0.x + p1.x);
  for (let k = 1; k < n; k++) {
    const fr = k / n;
    const x = p0.x + fr * (p1.x - p0.x);
    const e = Math.abs(evalSplineSegmentAtFrac(p0, p1, fr) - fn(x));
    if (e > maxErr) {
      maxErr = e;
      worstX = x;
    }
  }
  return { maxErr, worstX };
}

/** Anchor budget for captureCurveToCustomPoints. / 기준점 예산 */
const ANCHOR_HARD_CAP = 160;
const REFINE_HEADROOM = 12;

/**
 * Convert any curve object into editable custom spline points by adaptive refinement:
 * start from endpoints + local extrema, fit cubic handles per segment, then keep splitting
 * the worst segment until max error ≤ tolerance·range or maxAnchors is reached.
 * By default the raw shape is captured (reverse/inverse NOT baked in) so that switching the
 * same object to engine 'custom' keeps its flags and looks identical.
 * 적응형 샘플링으로 곡선을 커스텀 스플라인으로 변환. 기본적으로 reverse/inverse는 굽지 않음.
 * @param {object} obj curve object
 * @param {{ tolerance?: number, maxAnchors?: number, samples?: number, includeTransforms?: boolean }} [opts]
 * @returns {Array<{x:number,y:number,handles:Array}>}
 */
export function captureCurveToCustomPoints(obj, opts = {}) {
  const { tolerance = 0.003, maxAnchors = 40, samples = 480, includeTransforms = false } = opts;
  if (obj?.engine === 'custom' && !includeTransforms && Array.isArray(obj.customPoints) && obj.customPoints.length >= 2) {
    return deepClone(obj.customPoints);
  }
  const fn = (x) => evaluateCurveObjectY(obj, x, { raw: !includeTransforms, regions: false });

  // Dense scan: range + extrema / 조밀 스캔: 범위와 극값
  const ys = new Float64Array(samples + 1);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i <= samples; i++) {
    ys[i] = fn(i / samples);
    if (ys[i] < yMin) yMin = ys[i];
    if (ys[i] > yMax) yMax = ys[i];
  }
  const tol = tolerance * Math.max(0.1, yMax - yMin);
  const minGap = 0.01;
  const xs = [0, 1];
  for (let i = 1; i < samples; i++) {
    const dl = ys[i] - ys[i - 1];
    const dr = ys[i + 1] - ys[i];
    if ((dl > 0 && dr <= 0) || (dl < 0 && dr >= 0)) {
      const x = i / samples;
      if (xs.every((a) => Math.abs(a - x) > minGap)) xs.push(x);
    }
  }
  xs.sort((a, b) => a - b);
  // Every extremum is worth an anchor, so the anchor budget grows with the oscillation
  // count (up to ANCHOR_HARD_CAP), leaving REFINE_HEADROOM anchors for refinement. Only
  // beyond the hard cap are extrema thinned — evenly, never as one contiguous hole.
  // 극값마다 기준점을 두도록 예산을 늘리고, 상한 초과 시에만 균등하게 솎아냄 (중간 구멍 방지).
  const budget = clamp(xs.length + REFINE_HEADROOM, maxAnchors, Math.max(maxAnchors, ANCHOR_HARD_CAP));
  if (xs.length > budget - REFINE_HEADROOM) {
    const interior = xs.slice(1, -1);
    const keep = Math.max(0, budget - REFINE_HEADROOM - 2);
    const step = interior.length / Math.max(1, keep);
    const thinned = [];
    for (let k = 0; k < keep; k++) thinned.push(interior[Math.floor(k * step)]);
    xs.length = 0;
    xs.push(0, ...thinned, 1);
  }

  const pts = xs.map((x) => ({ x: roundTo(x, 4), y: roundTo(fn(x), 5), handles: [] }));
  const refit = (i) => {
    pts[i].handles = fitSegmentHandles(fn, pts[i].x, pts[i + 1].x, pts[i].y, pts[i + 1].y);
  };
  for (let i = 0; i < pts.length - 1; i++) refit(i);

  // Adaptive refinement / 적응형 세분화
  for (let guard = 0; pts.length < budget && guard < 400; guard++) {
    let worst = -1;
    let worstErr = tol;
    let worstX = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      if (pts[i + 1].x - pts[i].x < 2 * minGap * 0.25) continue;
      const { maxErr, worstX: wx } = segmentError(fn, pts[i], pts[i + 1]);
      if (maxErr > worstErr) {
        worstErr = maxErr;
        worst = i;
        worstX = wx;
      }
    }
    if (worst < 0) break;
    const a = pts[worst].x;
    const b = pts[worst + 1].x;
    const margin = 0.15 * (b - a);
    const x = roundTo(clamp(worstX, a + margin, b - margin), 4);
    if (x <= a || x >= b) break;
    pts.splice(worst + 1, 0, { x, y: roundTo(fn(x), 5), handles: [] });
    refit(worst);
    refit(worst + 1);
  }
  return pts;
}

// ==========================================================================
// 8. Custom → engine inverse fit / 커스텀 → 수식 역근사
// ==========================================================================

/**
 * Build fit candidates for core/analyzeAndFitCustomToEngine from PARAM_SCHEMAS
 * (soft ranges as search bounds). / 역근사 후보 생성
 * @param {object} [baseParams] starting parameters (default: createDefaultCurveParams())
 * @param {string[]} [engines]  restrict to these engine ids
 */
export function buildEngineFitCandidates(baseParams = createDefaultCurveParams(), engines = null) {
  const out = [];
  for (const def of ENGINE_DEFS) {
    if (!def.fittable || (engines && !engines.includes(def.id))) continue;
    const fit = {};
    for (const s of PARAM_SCHEMAS[def.id]) {
      if (s.type === 'range') fit[s.key] = { min: s.softMin, max: s.softMax, integer: s.integer };
    }
    const params = { ...createDefaultCurveParams(), ...baseParams, symLock: false };
    if (def.id === 'damped') {
      out.push({ id: 'damped', evaluate: (tt, p) => evalSingleEngine('damped', tt, p), params: { ...params, dampC1: true }, fit });
      out.push({ id: 'damped', evaluate: (tt, p) => evalSingleEngine('damped', tt, p), params: { ...params, dampC1: false }, fit });
      continue;
    }
    out.push({ id: def.id, evaluate: (tt, p) => evalSingleEngine(def.id, tt, p), params, fit });
  }
  return out;
}

/**
 * Find the formula engine that best reproduces a curve (e.g. a hand-edited custom curve).
 * Result `best.params` can be spread onto the curve object with `engine = best.id`.
 * 커스텀 곡선을 가장 잘 재현하는 수식 엔진 탐색. best.params를 곡선 객체에 적용 가능.
 * @param {object|Function|Array|ArrayLike<number>} target curve object, fn(t), spline points
 *        or uniform samples (Array / typed array, e.g. sampleCurveObject output)
 * @param {{ engines?: string[], samples?: number, maxIter?: number, restarts?: number }} [opts]
 */
export function fitCurveToEngines(target, opts = {}) {
  const isSamples = typeof target === 'function' || Array.isArray(target) || ArrayBuffer.isView(target);
  const fn = isSamples ? target : (x) => evaluateCurveObjectY(target, x, { raw: true });
  // Only a real curve object seeds the search parameters / 실제 곡선 객체만 초기 파라미터로 사용
  const base = !isSamples && target && typeof target.engine === 'string' ? target : undefined;
  const candidates = buildEngineFitCandidates(base, opts.engines || null);
  return analyzeAndFitCustomToEngine(fn, candidates, opts);
}

// ==========================================================================
// 9. Small factories re-exported for UI convenience / UI 편의 팩토리
// ==========================================================================

/** New morph node with sensible defaults. / 새 모핑 노드 */
export function createMorphNode(engine = 'harmonic', weight = 0.5, op = null) {
  const n = createDefaultMorphNode(engine, weight);
  n.op = op && MORPH_MODES.includes(op) ? op : null;
  return n;
}

/** Switch a curve object's engine, capturing the previous shape when entering 'custom'. */
export function switchCurveEngine(obj, engineId, { captureOpts } = {}) {
  if (!ENGINE_IDS.includes(engineId) || obj.engine === engineId) return obj;
  if (engineId === 'custom') {
    // Remember the engine being left (it may have been set without this helper)
    // 떠나는 엔진을 기억 (이 헬퍼 없이 설정되었을 수도 있음)
    obj.lastNonCustomEngine = obj.engine;
    obj.customPoints = captureCurveToCustomPoints(obj, captureOpts);
  } else {
    obj.lastNonCustomEngine = engineId;
  }
  obj.engine = engineId;
  return obj;
}

// ==========================================================================
// 10. Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('ENGINE_DEFS & PARAM_SCHEMAS consistent', (a) => {
  a.equal(ENGINE_DEFS.map((d) => d.id).join(), ENGINE_IDS.join(), 'engine order');
  ENGINE_DEFS.forEach((d, i) => a.equal(d.num, i + 1, d.id));
  for (const id of ENGINE_IDS) a.ok(Array.isArray(PARAM_SCHEMAS[id]), `schema ${id}`);
  for (const [key, s] of Object.entries(NUMERIC_PARAMS)) {
    a.ok(s.min <= s.softMin && s.softMin < s.softMax && s.softMax <= s.max, `range order ${key}`);
    a.ok(s.default >= s.softMin && s.default <= s.softMax, `default in soft range ${key}=${s.default}`);
    a.ok(key in D, `default exists ${key}`);
  }
  const prev = t('engineName.harmonic');
  a.ok(prev && prev !== 'engineName.harmonic', 'engine label i18n');
}, { group: 'engine' });

registerSelfCheck('All engines: f(0)=0, f(1)=1 at defaults', (a) => {
  for (const id of ENGINE_IDS) {
    const obj = createDefaultCurveConfig(id);
    a.near(evaluateCurveObjectY(obj, 0), 0, 1e-9, `${id} f(0)`);
    a.near(evaluateCurveObjectY(obj, 1), 1, 1e-9, `${id} f(1)`);
  }
}, { group: 'engine' });

registerSelfCheck('Reverse / inverse / clamping', (a) => {
  const obj = createDefaultCurveConfig('anticipation');
  const r = { ...obj, reverse: true };
  const inv = { ...obj, inverse: true };
  for (const x of [0, 0.13, 0.5, 0.77, 1]) {
    a.near(evaluateCurveObjectY(r, x), evaluateCurveObjectY(obj, 1 - x), 1e-12, 'reverse');
    a.near(evaluateCurveObjectY(inv, x), 1 - evaluateCurveObjectY(obj, x), 1e-12, 'inverse');
  }
  a.equal(evaluateCurveObjectY(obj, -3), evaluateCurveObjectY(obj, 0), 't clamped low');
  a.equal(evaluateCurveObjectY(obj, 7), evaluateCurveObjectY(obj, 1), 't clamped high');
  a.near(evaluateCurveObjectY({ ...obj, reverse: true, inverse: true }, 0.3, { raw: true }), evaluateCurveObjectY(obj, 0.3), 1e-12, 'raw');
}, { group: 'engine' });

registerSelfCheck('Engines finite for random params within hard ranges', (a) => {
  const rand = createSeededRandom(42);
  for (const id of ENGINE_IDS) {
    for (let trial = 0; trial < 25; trial++) {
      const obj = createDefaultCurveConfig(id);
      for (const s of PARAM_SCHEMAS[id]) {
        if (s.type === 'range') obj[s.key] = s.min + rand() * (s.max - s.min);
        if (s.type === 'toggle') obj[s.key] = rand() < 0.5;
      }
      obj.reverse = rand() < 0.5;
      obj.inverse = rand() < 0.5;
      for (let i = 0; i <= 64; i++) a.ok(Number.isFinite(evaluateCurveObjectY(obj, i / 64)), `${id} non-finite (trial ${trial})`);
    }
  }
  a.ok(Number.isFinite(evaluateCurveObjectY({ engine: 'harmonic', alpha: 'abc', x1: null }, 0.4)), 'garbage params');
  a.near(evaluateCurveObjectY({ engine: 'nope' }, 0.4), 0.4, 1e-12, 'unknown engine → identity');
}, { group: 'engine' });

registerSelfCheck('Harmonic symLock & damped C¹ continuity at t₀', (a) => {
  const h = createDefaultCurveConfig('harmonic');
  const locked = { ...h, x1: 0.2, x2: 0.9, symLock: true };
  const manual = { ...h, x1: 0.2, x2: 0.8, symLock: false };
  a.near(evaluateCurveObjectY(locked, 0.63), evaluateCurveObjectY(manual, 0.63), 1e-12, 'symLock → x2 = 1 − x1');
  const d = createDefaultCurveConfig('damped');
  const t0 = d.dampT0;
  const slopeL = (evaluateCurveObjectY(d, t0) - evaluateCurveObjectY(d, t0 - 1e-5)) / 1e-5;
  const slopeR = (evaluateCurveObjectY(d, t0 + 1e-5) - evaluateCurveObjectY(d, t0)) / 1e-5;
  a.near(slopeL, 0, 1e-3, 'left slope at impact');
  a.near(slopeR, 0, 1e-3, 'right slope at impact');
}, { group: 'engine' });

registerSelfCheck('Morph: per-node ops reduce to global modes; solo & bypass', (a) => {
  const mk = (mode, ops) => {
    const o = createDefaultCurveConfig('morph');
    o.morphMode = mode;
    o.morphNodes = [createMorphNode('bezier', 0.7, ops?.[0]), createMorphNode('ratchet', 0.4, ops?.[1]), createMorphNode('chirp', 0.25, ops?.[2])];
    return o;
  };
  const x = 0.37;
  const o = mk('blend');
  const v = o.morphNodes.map((n) => evalSingleEngine(n.engine, x, n));
  const w = [0.7, 0.4, 0.25];
  a.near(evaluateCurveObjectY(mk('blend'), x), (w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / (w[0] + w[1] + w[2]), 1e-12, 'blend');
  a.near(evaluateCurveObjectY(mk('add'), x), w[0] * v[0] + w[1] * v[1] + w[2] * v[2], 1e-12, 'add');
  a.near(evaluateCurveObjectY(mk('diff'), x), w[0] * v[0] - w[1] * v[1] - w[2] * v[2], 1e-12, 'diff');
  a.near(evaluateCurveObjectY(mk('mul'), x), [0, 1, 2].reduce((acc, i) => acc * (1 - w[i] + w[i] * v[i]), 1), 1e-12, 'mul');
  // Node op overrides global / 노드 연산이 전역 모드보다 우선
  a.near(evaluateCurveObjectY(mk('blend', [null, 'add', 'mul']), x), (v[0] + w[1] * v[1]) * (1 - w[2] + w[2] * v[2]), 1e-12, 'mixed');
  const s = mk('add');
  s.morphNodes[1].solo = true;
  a.near(evaluateCurveObjectY(s, x), w[1] * v[1], 1e-12, 'solo');
  const b = mk('add');
  b.morphNodes[0].bypass = true;
  a.near(evaluateCurveObjectY(b, x), w[1] * v[1] + w[2] * v[2], 1e-12, 'bypass');
  b.morphNodes.forEach((n) => { n.bypass = true; });
  a.near(evaluateCurveObjectY(b, x), x, 1e-12, 'all bypassed → identity');
  const sb = mk('add');
  sb.morphNodes[2].solo = true;
  sb.morphNodes[2].bypass = true;
  a.near(evaluateCurveObjectY(sb, x), w[2] * v[2], 1e-12, 'solo beats bypass');
  const rec = mk('blend');
  rec.morphNodes[0].engine = 'morph';
  a.ok(Number.isFinite(evaluateCurveObjectY(rec, x)), 'no recursion');
}, { group: 'engine' });

registerSelfCheck('Derivative & frequency mapping', (a) => {
  const v = createDefaultVoice(0, { engine: 'custom', customPoints: createLinearSplinePoints(0, 1) });
  a.near(evaluateCurveDerivative(v, 0.5), 1, 1e-9, 'linear slope');
  a.near(evaluateVoiceDerivativeNorm(v, 0.3), 0.5, 1e-9, 'constant slope → 0.5');
  const h = createDefaultVoice(0);
  const st = computeDerivativeStats(h);
  for (const x of [0, 0.25, 0.5, 1]) {
    const dn = evaluateVoiceDerivativeNorm(h, x, st);
    a.ok(dn >= 0 && dn <= 1, 'norm derivative in [0,1]');
  }
  a.near(getVoiceFreqAtNormT(h, 0), getVoiceHz(h, 'f0'), 1e-6, 'f(0) → F0');
  a.near(getVoiceFreqAtNormT(h, 1), getVoiceHz(h, 'f1'), 1e-6, 'f(1) → F1');
  const lin = { ...v, logScale: false };
  a.near(getVoiceFreqAtNormT(lin, 0.5), 0.5 * (getVoiceHz(v, 'f0') + getVoiceHz(v, 'f1')), 1e-6, 'linear Hz midpoint');
  a.near(getVoiceMidiAtNormT(v, 0.5), 0.5 * (freqToMidi(getVoiceHz(v, 'f0')) + freqToMidi(getVoiceHz(v, 'f1'))), 1e-6, 'log midpoint');
  const vel = { ...h, audioTarget: 'vel' };
  const f = getVoiceFreqAtNormT(vel, 0.5);
  a.ok(f >= FREQ_CLAMP_MIN && f <= FREQ_CLAMP_MAX, 'vel target in range');
  a.near(absTimeToNormT({ startTime: 1, duration: 2 }, 2), 0.5, 1e-12);
}, { group: 'engine' });

registerSelfCheck('Adaptive capture → custom spline fidelity', (a) => {
  for (const id of ENGINE_IDS) {
    if (id === 'custom') continue;
    const obj = createDefaultCurveConfig(id);
    obj.reverse = id === 'bounce'; // capture is raw by default
    const pts = captureCurveToCustomPoints(obj);
    a.ok(pts.length >= 2 && pts.length <= 40, `${id} anchor count ${pts.length}`);
    a.equal(pts[0].x, 0);
    a.equal(pts[pts.length - 1].x, 1);
    const custom = { ...obj, engine: 'custom', customPoints: pts };
    let maxErr = 0;
    for (let i = 0; i <= 400; i++) {
      maxErr = Math.max(maxErr, Math.abs(evaluateCurveObjectY(custom, i / 400) - evaluateCurveObjectY(obj, i / 400)));
    }
    a.ok(maxErr < 0.03, `${id} capture max error ${maxErr.toFixed(4)}`);
  }
  const c = createDefaultCurveConfig('custom');
  c.customPoints = [{ x: 0, y: 0.2, handles: [] }, { x: 1, y: 0.4, handles: [] }];
  a.equal(captureCurveToCustomPoints(c)[1].y, 0.4, 'custom passthrough copy');
  const sw = createDefaultCurveConfig('bezier');
  switchCurveEngine(sw, 'custom');
  a.ok(sw.engine === 'custom' && sw.lastNonCustomEngine === 'bezier' && sw.customPoints.length >= 2, 'switch to custom');
}, { group: 'engine' });

registerSelfCheck('Custom → engine inverse fit finds the source engine', (a) => {
  const src = createDefaultCurveConfig('plateau');
  Object.assign(src, { platTm: 0.4, platYm: 0.7, platW: 0.2 });
  const pts = captureCurveToCustomPoints(src);
  const res = fitCurveToEngines(pts, { engines: ['plateau', 'harmonic', 'bezier'], restarts: 2 });
  a.equal(res.best.id, 'plateau');
  a.ok(res.best.rmse < 0.01, `rmse ${res.best.rmse}`);
  a.near(res.best.params.platYm, 0.7, 0.03, 'recovered y_m');
  a.ok(buildEngineFitCandidates().every((c) => c.id !== 'morph' && c.id !== 'custom' && c.id !== 'polynomial'), 'fittable only');
}, { group: 'engine' });

registerSelfCheck('Regression: capture keeps every oscillation; typed-array fit; lastNonCustomEngine', (a) => {
  const cases = [
    ['damped', { dampN: 20 }],
    ['bounce', { bounceN: 20 }],
    ['chirp', { chirpF0: 30, chirpF1: 30, chirpA: 0.5 }],
    ['damped', { dampC1: false, dampA: 1.5, dampK: 0.5, dampN: 20 }],
  ];
  for (const [id, over] of cases) {
    const obj = Object.assign(createDefaultCurveConfig(id), over);
    const pts = captureCurveToCustomPoints(obj);
    const custom = { ...obj, engine: 'custom', customPoints: pts };
    let maxErr = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const y = evaluateCurveObjectY(obj, i / 2000);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
      maxErr = Math.max(maxErr, Math.abs(evaluateCurveObjectY(custom, i / 2000) - y));
    }
    a.ok(maxErr < 0.03 * (hi - lo), `${id} ${JSON.stringify(over)}: max error ${maxErr.toFixed(4)} on range ${(hi - lo).toFixed(3)} with ${pts.length} anchors`);
  }
  const src = Object.assign(createDefaultCurveConfig('plateau'), { platTm: 0.4, platYm: 0.7, platW: 0.2 });
  const res = fitCurveToEngines(sampleCurveObject(src, 96), { engines: ['plateau'], restarts: 2 });
  a.near(res.best.params.platYm, 0.7, 0.03, 'typed-array samples fitted');
  a.ok(!('0' in res.best.params), 'no array indices leaked into params');
  const v = createDefaultVoice(0, { engine: 'bezier' });
  switchCurveEngine(v, 'custom');
  a.equal(v.lastNonCustomEngine, 'bezier', 'engine left behind is remembered');
}, { group: 'engine' });

registerSelfCheck('New engines: Exp/Log inverse pair, Trig, user formula with variables', (a) => {
  const ex = { ...createDefaultCurveConfig('expo'), expK: 5 };
  const lg = { ...ex, expMode: 'log' };
  for (const x of [0.1, 0.37, 0.8]) a.near(evaluateCurveObjectY(lg, evaluateCurveObjectY(ex, x)), x, 1e-9, `log∘exp ${x}`);
  const tr = { ...createDefaultCurveConfig('trig'), trigFn: 'sin', trigX0: 0, trigX1: 0.5 };
  a.near(evaluateCurveObjectY(tr, 0.5), Math.sin(Math.PI / 4), 1e-12, 'quarter sine');
  const at = { ...tr, trigFn: 'atan', trigX0: -5, trigX1: 5 };
  a.near(evaluateCurveObjectY(at, 0.5), 0.5, 1e-9, 'atan sigmoid midpoint');
  const full = { ...tr, trigX0: 0, trigX1: 2, trigAmp: 0.2 };
  a.near(evaluateCurveObjectY(full, 1), 1, 1e-9, 'degenerate cycle keeps endpoints');
  const fo = { ...createDefaultCurveConfig('formula'), formulaExpr: 'a*t^2 + b', formulaVars: [{ name: 'a', value: 3, min: 0, max: 5 }, { name: 'b', value: 1, min: 0, max: 2 }], formulaNorm: false };
  a.near(evaluateCurveObjectY(fo, 0.5), 3 * 0.25 + 1, 1e-12, 'raw formula');
  a.near(evaluateCurveObjectY({ ...fo, formulaNorm: true }, 0.5), 0.25, 1e-12, 'normalized formula');
  a.near(evaluateCurveObjectY({ ...fo, formulaExpr: 'sin(' }, 0.3), 0.3, 1e-12, 'bad formula → identity');
  a.near(evaluateCurveObjectY({ ...fo, formulaExpr: '2ab t', formulaNorm: false }, 0.5), 2 * 3 * 1 * 0.5, 1e-12, 'implicit products');
}, { group: 'engine' });

registerSelfCheck('Regions: partial override, mix, ramps and edge analysis', (a) => {
  const v = createDefaultVoice(0);
  const base = (x) => evaluateCurveObjectY(v, x, { regions: false });
  const r = { id: 'r1', t0: 0.4, t1: 0.6, mix: 1, timeMode: 'global', ramp: 'off', rampSec: 0.05, mute: false, solo: false, gainDb: 0, curve: createDefaultCurveConfig('expo') };
  v.regions = [r];
  a.near(evaluateCurveObjectY(v, 0.2), base(0.2), 1e-12, 'outside untouched');
  a.near(evaluateCurveObjectY(v, 0.5), evaluateCurveObjectY(r.curve, 0.5), 1e-12, 'inside replaced');
  r.mix = 0.5;
  a.near(evaluateCurveObjectY(v, 0.5), 0.5 * (base(0.5) + evaluateCurveObjectY(r.curve, 0.5)), 1e-12, 'mix = partial morph');
  r.mix = 1;
  a.ok(!analyzeRegionEdge(v, r, 'in').smooth, 'jump detected');
  r.ramp = 'auto';
  a.near(evaluateCurveObjectY(v, 0.4 + 1e-7), base(0.4 + 1e-7), 1e-4, 'auto ramp removes the jump');
  r.timeMode = 'local';
  a.near(evaluateCurveObjectY(v, 0.6), base(0.6), 1e-9, 'local mode meets the edge value');
  a.near(evaluateCurveObjectY(v, 0.5, { regions: false }), base(0.5), 1e-12, 'regions:false bypass');
}, { group: 'engine' });
