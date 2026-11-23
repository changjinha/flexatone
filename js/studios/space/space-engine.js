/**
 * Flexatone — studios/space/space-engine.js
 * Layer 2 (studios, pure): Space Studio physics — moving sources, retarded time, Doppler,
 * inverse-distance gain, air absorption, equal-power pan. No DOM, no Web Audio.
 * 계층 2 (studios, 순수): 스페이스 스튜디오 물리 — 움직이는 음원, 지연 시간, 도플러,
 * 역거리 게인, 공기 흡수, 등전력 패닝. DOM·Web Audio 없음.
 *
 * Geometry / 좌표
 *   Top view, metres. +x = right (east), +y = up on screen (north). The listener faces
 *   headingDeg (0 = +y, clockwise positive) — the brief's "+z front" is the +y axis here.
 *   Each source may sit at a constant height h above the plane (r includes h).
 *   상단 시점(미터). 청취자 정면 = headingDeg (0 = +y, 시계 방향 +). 높이 h는 거리에 포함.
 *
 * Retarded time / 지연 시간
 *   The listener hears at t what the source emitted at t_e:  g(t_e) = t_e + |X(t_e) − L|/c − t = 0.
 *   dg/dt_e = 1 + v_r/c > 0 while |v| < c, so the root is unique; it is found by Newton steps
 *   kept inside a shrinking bisection bracket (residual < 1e-9 s).
 *   f_obs = f_s(t_e) / (1 + v_r/c),   v_r = (X − L)·v / |X − L|  (positive = receding).
 *   Speeds are clamped to 0.98·c (no sonic boom in this prototype).
 *
 * Baking / 베이킹
 *   bakeSpace(doc) samples every source at `bakeRate` Hz of LISTENER time and returns typed
 *   arrays { t, te, fObs, fs, gain, lp, pan, fwd, up, r, vr, x, y }. Results are cached by a
 *   signature of the physics only (timbre / baseGain / mute / solo / view excluded).
 *   청취자 시간 기준 bakeRate Hz로 샘플링, 물리 시그니처로 캐시 (음색·게인·뷰 제외).
 *
 * Imports: core/*, modules/*.
 */

import { clamp, roundTo, deepClone, createSeededRandom, uid } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { createDefaultCurveParams } from '../../core/state.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { normalizeVoiceMod } from '../../core/voice-mod.js';

export const SPACE_PATH_TYPES = Object.freeze(['line', 'orbit', 'lissajous', 'spiral', 'draw', 'static']);
export const PROFILE_MODES = Object.freeze(['const', 'curve']);
/** Curve engines offered for speed / pitch profiles (default params). / 프로파일용 곡선 엔진 */
export const PROFILE_ENGINES = Object.freeze(['harmonic', 'expo', 'bezier', 'damped', 'bounce', 'plateau', 'chirp', 'trig']);
export const SPACE_PRESETS = Object.freeze(['passby', 'orbit', 'spiral', 'sirens', 'swarm']);
export const PAN_MODES = Object.freeze(['equalPower', 'hrtf']);
export const BAKE_RATES = Object.freeze([100, 200, 400]);
export const SUPERSONIC_FRACTION = 0.98;
export const MAX_RINGS = 24;
export const MAX_BAKE_SAMPLES = 60000;
export const MAX_DRAW_POINTS = 64;
export const SOURCE_COLORS = Object.freeze(['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa']);
export const SOLVER_TOL = 1e-12;

const ARC_N = 2048; // arc-length table resolution / 호 길이 표 해상도
const PROFILE_N = 1024; // speed / pitch profile table resolution / 프로파일 표 해상도
const TAU = Math.PI * 2;
const CURVE_DEFAULTS = Object.freeze(createDefaultCurveParams());
const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

// ==========================================================================
// Document factories / 문서 팩토리
// ==========================================================================

/** Curve profile reference (curve-engine object, default params). / 곡선 프로파일 */
export function createProfileCurve(engine = 'harmonic', extra = {}) {
  return { engine, reverse: false, inverse: false, ...extra };
}

/** One moving source with every path field present (switching type keeps the others). */
export function createSource(index = 0, over = {}) {
  const base = {
    id: over.id || uid('s_', 6),
    name: `Source ${index + 1}`,
    color: SOURCE_COLORS[index % SOURCE_COLORS.length],
    muted: false,
    solo: false,
    path: {
      type: 'line',
      x0: -150, y0: 5, x1: 150, y1: 5, // line
      cx: 0, cy: 0, rx: 25, ry: 25, phase: 0, dir: 1, onListener: false, // orbit / spiral / lissajous centre
      ax: 40, ay: 30, a: 1, b: 2, delta: 90, // lissajous
      r0: 80, r1: 4, turns: 2, // spiral
      x: 0, y: 12, // static
      h: 0, // height above the plane / 높이
      points: [], // draw
    },
    speed: { mode: 'const', value: 20, from: 5, to: 30, curve: createProfileCurve('harmonic') },
    start: 0,
    duration: 15,
    f: { mode: 'const', hz: 440, hz0: 330, hz1: 660, curve: createProfileCurve('harmonic') },
    timbre: { sine: 0.6, tri: 0.3, saw: 0.25, sqr: 0.05, rich: 0.2 },
    baseGain: 0.6,
    doppler: true,
    distanceGain: true,
    airAbsorb: true,
    pan: true,
  };
  const s = { ...base, ...deepClone(over) };
  s.path = { ...base.path, ...(over.path || {}) };
  s.speed = { ...base.speed, ...(over.speed || {}), curve: { ...base.speed.curve, ...(over.speed?.curve || {}) } };
  s.f = { ...base.f, ...(over.f || {}), curve: { ...base.f.curve, ...(over.f?.curve || {}) } };
  s.timbre = { ...base.timbre, ...(over.timbre || {}) };
  return s;
}

function baseDoc() {
  return {
    c: 343,
    cScale: 1,
    airDist: 40,
    refDist: 1,
    listener: { x: 0, y: 0, headingDeg: 0 },
    sources: [],
    activeSourceId: '',
    length: 30,
    bakeRate: 200,
    panMode: 'equalPower',
    seed: 1,
    preset: 'passby',
    tool: 'move',
    view: { cx: 0, cy: 0, span: 120 },
  };
}

/** A preset document (ids are fixed so defaults stay deterministic). / 프리셋 문서 (고정 id) */
export function createSpacePreset(id = 'passby') {
  const d = baseDoc();
  d.preset = SPACE_PRESETS.includes(id) ? id : 'passby';
  const S = (i, over) => createSource(i, { id: `s${i + 1}`, ...over });
  switch (d.preset) {
    case 'orbit':
      d.cScale = 0.4;
      d.refDist = 5;
      d.length = 22;
      d.sources = [S(0, { name: 'Orbiter', path: { type: 'orbit', cx: 14, cy: 8, rx: 26, ry: 26, phase: 0, dir: 1 }, speed: { value: 24 }, duration: 20, f: { hz: 330 } })];
      d.view = { cx: 10, cy: 6, span: 110 };
      break;
    case 'spiral':
      d.cScale = 0.3;
      d.refDist = 3;
      d.length = 26;
      d.sources = [S(0, { name: 'Spiral', path: { type: 'spiral', cx: 15, cy: 10, r0: 120, r1: 3, turns: 2, phase: 0, dir: -1 }, speed: { value: 35 }, duration: 22, f: { hz: 392 } })];
      d.view = { cx: 10, cy: 6, span: 300 };
      break;
    case 'sirens':
      d.cScale = 0.5;
      d.refDist = 6;
      d.length = 20;
      d.sources = [
        S(0, { name: 'Siren A', path: { type: 'line', x0: -150, y0: 6, x1: 150, y1: 6 }, speed: { value: 22 }, duration: 14, f: { mode: 'curve', hz0: 600, hz1: 900, curve: createProfileCurve('trig', { trigFn: 'sin', trigX0: 0, trigX1: 7, trigNorm: true }) } }),
        S(1, { name: 'Siren B', path: { type: 'line', x0: 150, y0: -6, x1: -150, y1: -6 }, speed: { value: 18 }, start: 1.5, duration: 16, f: { mode: 'curve', hz0: 450, hz1: 700, curve: createProfileCurve('trig', { trigFn: 'sin', trigX0: 0, trigX1: 5, trigNorm: true }) }, timbre: { sine: 0.3, tri: 0.6, saw: 0.4, sqr: 0.1, rich: 0.1 } }),
      ];
      d.view = { cx: 0, cy: 0, span: 140 };
      break;
    case 'swarm': {
      d.cScale = 0.35;
      d.refDist = 10;
      d.length = 26;
      const hz = [220, 277.18, 329.63, 440];
      const ab = [[1, 2], [3, 2], [2, 3], [3, 4]];
      d.sources = hz.map((f, i) => S(i, {
        name: `Swarm ${i + 1}`,
        path: { type: 'lissajous', cx: 0, cy: 6, ax: 32 + 6 * i, ay: 24 + 4 * i, a: ab[i][0], b: ab[i][1], delta: 30 + 40 * i },
        speed: { value: 14 + 4 * i },
        start: 0.5 * i,
        duration: 22,
        f: { hz: f },
        baseGain: 0.45,
      }));
      d.view = { cx: 0, cy: 4, span: 130 };
      break;
    }
    default:
      // refDist = closest approach → the pass peaks at unity distance gain / 최근접 = 기준 거리
      d.cScale = 0.5;
      d.refDist = 5;
      d.length = 17;
      d.sources = [S(0, { name: 'Pass-by', path: { type: 'line', x0: -150, y0: 5, x1: 150, y1: 5 }, speed: { value: 20 }, duration: 15, f: { hz: 440 } })];
      d.view = { cx: 0, cy: 0, span: 120 };
  }
  d.activeSourceId = d.sources[0].id;
  return d;
}

export function createDefaultSpaceParams() {
  return createSpacePreset('passby');
}

/** Fill missing / invalid fields (older saves, hand-edited JSON). / 누락 필드 보정 */
export function normalizeSpaceDoc(raw) {
  const d = baseDoc();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const k of ['c', 'cScale', 'airDist', 'refDist', 'length', 'bakeRate', 'seed']) d[k] = num(src[k], d[k]);
  d.c = clamp(d.c, 50, 2000);
  d.cScale = clamp(d.cScale, 0.05, 1);
  d.airDist = clamp(d.airDist, 1, 1000);
  d.refDist = clamp(d.refDist, 0.1, 50);
  d.length = clamp(d.length, 1, 300);
  d.bakeRate = BAKE_RATES.includes(d.bakeRate) ? d.bakeRate : 200;
  d.listener = { ...d.listener, ...(src.listener || {}) };
  for (const k of ['x', 'y', 'headingDeg']) d.listener[k] = num(d.listener[k], 0);
  d.panMode = PAN_MODES.includes(src.panMode) ? src.panMode : 'equalPower';
  d.tremolo = normalizeTremolo(src.tremolo); // studio output tremolo (sound only, never re-bakes) / 스튜디오 출력 트레몰로
  d.voiceMod = normalizeVoiceMod(src.voiceMod); // per-voice tremolo / vibrato (sound only) / 보이스별 변조
  d.trajLink = src.trajLink && typeof src.trajLink === 'object' ? src.trajLink : null; // imported Glissando trajectory link / 불러온 궤적 연결
  d.preset = typeof src.preset === 'string' ? src.preset : '';
  d.tool = src.tool === 'draw' ? 'draw' : 'move';
  d.view = { ...d.view, ...(src.view || {}) };
  const list = Array.isArray(src.sources) && src.sources.length ? src.sources : createDefaultSpaceParams().sources;
  d.sources = list.slice(0, 64).map((s, i) => {
    const n = createSource(i, { ...s, id: typeof s?.id === 'string' && s.id ? s.id : `s${i + 1}` });
    if (!SPACE_PATH_TYPES.includes(n.path.type)) n.path.type = 'line';
    if (!PROFILE_MODES.includes(n.speed.mode)) n.speed.mode = 'const';
    if (!PROFILE_MODES.includes(n.f.mode)) n.f.mode = 'const';
    n.duration = clamp(num(n.duration, 15), 0.1, 300);
    n.start = clamp(num(n.start, 0), 0, 300);
    if (!Array.isArray(n.path.points)) n.path.points = [];
    return n;
  });
  d.activeSourceId = d.sources.some((s) => s.id === src.activeSourceId) ? src.activeSourceId : d.sources[0].id;
  return d;
}

/** Effective (artistic) speed of sound. / 실효 음속 */
export const effectiveC = (doc) => clamp(num(doc.c, 343), 50, 2000) * clamp(num(doc.cScale, 1), 0.05, 1);

// ==========================================================================
// Geometry: analytic paths + arc-length tables / 기하: 해석적 경로 + 호 길이 표
// ==========================================================================

function catmull(p0, p1, p2, p3, f) {
  const f2 = f * f;
  const f3 = f2 * f;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}
function catmullD(p0, p1, p2, p3, f) {
  return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f * f);
}

/**
 * Analytic path P(u), P′(u) for u ∈ [0, 1] plus an arc-length table for S → u.
 * 해석적 경로 P(u), P′(u)와 호 길이 역함수 표.
 */
export function buildGeometry(path, listener = { x: 0, y: 0 }) {
  const p = path || {};
  let type = SPACE_PATH_TYPES.includes(p.type) ? p.type : 'line';
  let P;
  let D;
  let closed = false;
  if (type === 'draw' && !(Array.isArray(p.points) && p.points.length >= 2)) type = 'static';
  if (type === 'line') {
    const x0 = num(p.x0, 0), y0 = num(p.y0, 0), x1 = num(p.x1, 0), y1 = num(p.y1, 0);
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) type = 'static';
    P = (u) => ({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u });
    D = () => ({ x: x1 - x0, y: y1 - y0 });
  }
  if (type === 'orbit') {
    const cx = p.onListener ? num(listener.x, 0) : num(p.cx, 0);
    const cy = p.onListener ? num(listener.y, 0) : num(p.cy, 0);
    const rx = Math.max(0.1, num(p.rx, 20)), ry = Math.max(0.1, num(p.ry, 20));
    const ph = (num(p.phase, 0) * Math.PI) / 180;
    const dir = num(p.dir, 1) < 0 ? -1 : 1;
    closed = true;
    P = (u) => { const a = ph + dir * TAU * u; return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; };
    D = (u) => { const a = ph + dir * TAU * u; return { x: -dir * TAU * rx * Math.sin(a), y: dir * TAU * ry * Math.cos(a) }; };
  } else if (type === 'lissajous') {
    const cx = num(p.cx, 0), cy = num(p.cy, 0), ax = Math.max(0.1, num(p.ax, 30)), ay = Math.max(0.1, num(p.ay, 20));
    const a = Math.max(1, Math.round(num(p.a, 1))), b = Math.max(1, Math.round(num(p.b, 2)));
    const dl = (num(p.delta, 90) * Math.PI) / 180;
    closed = true;
    P = (u) => ({ x: cx + ax * Math.sin(TAU * a * u + dl), y: cy + ay * Math.sin(TAU * b * u) });
    D = (u) => ({ x: ax * TAU * a * Math.cos(TAU * a * u + dl), y: ay * TAU * b * Math.cos(TAU * b * u) });
  } else if (type === 'spiral') {
    const cx = p.onListener ? num(listener.x, 0) : num(p.cx, 0);
    const cy = p.onListener ? num(listener.y, 0) : num(p.cy, 0);
    const r0 = Math.max(0, num(p.r0, 80)), r1 = Math.max(0, num(p.r1, 4));
    const turns = Math.max(0.05, num(p.turns, 2));
    const ph = (num(p.phase, 0) * Math.PI) / 180;
    const dir = num(p.dir, 1) < 0 ? -1 : 1;
    P = (u) => { const r = r0 + (r1 - r0) * u; const a = ph + dir * TAU * turns * u; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
    D = (u) => {
      const r = r0 + (r1 - r0) * u;
      const a = ph + dir * TAU * turns * u;
      const w = dir * TAU * turns;
      return { x: (r1 - r0) * Math.cos(a) - r * w * Math.sin(a), y: (r1 - r0) * Math.sin(a) + r * w * Math.cos(a) };
    };
  } else if (type === 'draw') {
    const pts = p.points.map((q) => ({ x: num(q.x, 0), y: num(q.y, 0) }));
    const segs = pts.length - 1;
    const seg = (u) => { const s = clamp(u, 0, 1) * segs; const i = Math.min(segs - 1, Math.floor(s)); return [i, s - i]; };
    const quad = (i) => [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(segs, i + 2)]];
    P = (u) => { const [i, f] = seg(u); const [a, b, c, d] = quad(i); return { x: catmull(a.x, b.x, c.x, d.x, f), y: catmull(a.y, b.y, c.y, d.y, f) }; };
    D = (u) => { const [i, f] = seg(u); const [a, b, c, d] = quad(i); return { x: segs * catmullD(a.x, b.x, c.x, d.x, f), y: segs * catmullD(a.y, b.y, c.y, d.y, f) }; };
  } else if (type === 'static') {
    const x = type === 'static' && p.type === 'draw' && p.points?.[0] ? num(p.points[0].x, 0) : p.type === 'line' ? num(p.x0, 0) : num(p.x, 0);
    const y = type === 'static' && p.type === 'draw' && p.points?.[0] ? num(p.points[0].y, 0) : p.type === 'line' ? num(p.y0, 0) : num(p.y, 0);
    P = () => ({ x, y });
    D = () => ({ x: 0, y: 0 });
  }

  // Arc-length table (chords of the analytic curve) / 호 길이 표
  const cum = new Float64Array(ARC_N + 1);
  let prev = P(0);
  for (let i = 1; i <= ARC_N; i++) {
    const q = P(i / ARC_N);
    cum[i] = cum[i - 1] + Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  const len = type === 'line' ? Math.hypot(D(0).x, D(0).y) : cum[ARC_N];
  const invert = (S) => {
    let lo = 0;
    let hi = ARC_N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= S) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    return (lo + (span > 0 ? (S - cum[lo]) / span : 0)) / ARC_N;
  };
  /** Arc distance S → { u, moving }. Lines extrapolate, closed paths wrap, open paths stop at the end. */
  const locate = (S) => {
    if (type === 'static' || len < 1e-9) return { u: 0, moving: false };
    if (type === 'line') return { u: S / len, moving: true };
    if (closed) return { u: invert(((S % len) + len) % len), moving: true };
    if (S >= len) return { u: 1, moving: false };
    return { u: invert(Math.max(0, S)), moving: true };
  };
  return { type, closed, len, P, D, locate };
}

// ==========================================================================
// Kinematics: speed profile + geometry / 운동학: 속도 프로파일 + 기하
// ==========================================================================

const mergeCurve = (curve) => ({ ...CURVE_DEFAULTS, engine: 'harmonic', reverse: false, inverse: false, ...(curve || {}) });

/** Profile y(x) ∈ [0, 1] sampled into a table (one curve-engine pass at bake time). */
function profileTable(curve) {
  const obj = mergeCurve(curve);
  const tab = new Float64Array(PROFILE_N + 1);
  for (let i = 0; i <= PROFILE_N; i++) {
    const y = evaluateCurveObjectY(obj, i / PROFILE_N, { regions: false });
    tab[i] = Number.isFinite(y) ? clamp(y, -0.5, 1.5) : i / PROFILE_N;
  }
  return tab;
}
const tableAt = (tab, x) => {
  const s = clamp(x, 0, 1) * PROFILE_N;
  const i = Math.min(PROFILE_N - 1, Math.floor(s));
  const f = s - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
};

const kinCache = new Map();
const KIN_CACHE_MAX = 48;

function kinSignature(src, doc) {
  const p = src.path || {};
  const lst = (p.type === 'orbit' || p.type === 'spiral') && p.onListener ? [doc.listener.x, doc.listener.y] : 0;
  return JSON.stringify([p, src.speed, src.start, src.duration, effectiveC(doc), lst]);
}

/**
 * Kinematics of one source: stateAt(τ) for τ ∈ [0, duration] (seconds since its start).
 * 음원 하나의 운동학: stateAt(τ) (시작 후 경과 초).
 */
export function getKinematics(src, doc) {
  const sig = kinSignature(src, doc);
  const hit = kinCache.get(sig);
  if (hit) return hit;
  const cEff = effectiveC(doc);
  const vMax = SUPERSONIC_FRACTION * cEff;
  const geo = buildGeometry(src.path, doc.listener);
  const dur = Math.max(0.05, num(src.duration, 15));
  const start = Math.max(0, num(src.start, 0));
  const h = num(src.path?.h, 0);
  const sp = src.speed || {};
  let rawMax = 0;
  let speedAt;
  let distAt;
  if (geo.type === 'static') {
    speedAt = () => 0;
    distAt = () => 0;
  } else if (sp.mode === 'curve') {
    const yt = profileTable(sp.curve);
    const a = Math.max(0, num(sp.from, 5));
    const b = Math.max(0, num(sp.to, 30));
    const vt = new Float64Array(PROFILE_N + 1);
    const cs = new Float64Array(PROFILE_N + 1);
    const dtau = dur / PROFILE_N;
    for (let i = 0; i <= PROFILE_N; i++) {
      const raw = Math.max(0, a + (b - a) * yt[i]);
      rawMax = Math.max(rawMax, raw);
      vt[i] = Math.min(raw, vMax);
      if (i) cs[i] = cs[i - 1] + 0.5 * (vt[i] + vt[i - 1]) * dtau;
    }
    speedAt = (tau) => tableAt(vt, tau / dur);
    distAt = (tau) => {
      // exact integral of the piecewise-linear speed / 구간 선형 속도의 정확한 적분
      const s = clamp(tau / dur, 0, 1) * PROFILE_N;
      const i = Math.min(PROFILE_N - 1, Math.floor(s));
      const f = s - i;
      const v1 = vt[i] + (vt[i + 1] - vt[i]) * f;
      return cs[i] + 0.5 * (vt[i] + v1) * f * dtau;
    };
  } else {
    rawMax = Math.max(0, num(sp.value, 20));
    const v = Math.min(rawMax, vMax);
    speedAt = () => v;
    distAt = (tau) => v * tau;
  }
  const stateAt = (tau) => {
    const tt = clamp(tau, 0, dur);
    const S = distAt(tt);
    const loc = geo.locate(S);
    const q = geo.P(loc.u);
    const spd = loc.moving ? speedAt(tt) : 0;
    if (spd <= 0) return { x: q.x, y: q.y, vx: 0, vy: 0, speed: 0 };
    let d = geo.D(loc.u);
    let dl = Math.hypot(d.x, d.y);
    if (dl < 1e-12) { // cusp: one-sided tangent / 첨점: 한쪽 접선
      const q2 = geo.P(loc.u + 1e-6);
      d = { x: q2.x - q.x, y: q2.y - q.y };
      dl = Math.hypot(d.x, d.y) || 1;
    }
    return { x: q.x, y: q.y, vx: (spd * d.x) / dl, vy: (spd * d.y) / dl, speed: spd };
  };
  const kin = { sig, geo, dur, start, h, cEff, vMax, rawMax, clamped: rawMax > vMax + 1e-12, maxVc: rawMax / cEff, stateAt, speedAt, distAt, poly: null };
  kinCache.set(sig, kin);
  if (kinCache.size > KIN_CACHE_MAX) kinCache.delete(kinCache.keys().next().value);
  return kin;
}

/** Source pitch f_s(τ) as a function (table-based for curves). / 음원 자체 음고 */
export function sourcePitchFn(src) {
  const f = src.f || {};
  if (f.mode === 'curve') {
    const yt = profileTable(f.curve);
    const a = clamp(num(f.hz0, 330), 10, 20000);
    const b = clamp(num(f.hz1, 660), 10, 20000);
    const dur = Math.max(0.05, num(src.duration, 15));
    return (tau) => a * Math.pow(b / a, tableAt(yt, tau / dur));
  }
  const hz = clamp(num(f.hz, 440), 10, 20000);
  return () => hz;
}

// ==========================================================================
// Retarded-time solver / 지연 시간 솔버
// ==========================================================================

/**
 * Solve g(τ) = start + τ + r(τ)/c − t = 0 for the emission time τ ∈ [0, dur].
 * Newton inside a bisection bracket (g is strictly increasing for |v| < c).
 * Returns null when nothing emitted is audible at t.
 * 방출 시각 τ 풀이 (이분 구간 안의 뉴턴). t에 들리는 소리가 없으면 null.
 */
export function solveEmission(kin, listener, t, guess = NaN) {
  const c = kin.cEff;
  const lx = listener.x;
  const ly = listener.y;
  const h2 = kin.h * kin.h;
  const g = (tau, st) => kin.start + tau + Math.sqrt((st.x - lx) ** 2 + (st.y - ly) ** 2 + h2) / c - t;
  let lo = 0;
  let hi = Math.min(kin.dur, t - kin.start);
  if (hi < 0) return null;
  let st = kin.stateAt(lo);
  let glo = g(lo, st);
  if (glo > SOLVER_TOL) return null; // not heard yet / 아직 도달 안 함
  if (glo >= -SOLVER_TOL) return { tau: lo, st, residual: glo, iters: 0 };
  st = kin.stateAt(hi);
  const ghi = g(hi, st);
  if (ghi < -SOLVER_TOL) return null; // already passed / 이미 지나감
  if (ghi <= SOLVER_TOL) return { tau: hi, st, residual: ghi, iters: 0 };
  let tau = Number.isFinite(guess) && guess > lo && guess < hi ? guess : 0.5 * (lo + hi);
  let res = 0;
  let it = 0;
  for (; it < 80; it++) {
    st = kin.stateAt(tau);
    const dx = st.x - lx;
    const dy = st.y - ly;
    const r = Math.sqrt(dx * dx + dy * dy + h2);
    res = kin.start + tau + r / c - t;
    if (Math.abs(res) <= SOLVER_TOL) break;
    if (res > 0) hi = tau; else lo = tau;
    const vr = r > 1e-12 ? (dx * st.vx + dy * st.vy) / r : 0;
    let next = tau - res / (1 + vr / c);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (hi - lo < 1e-14) { tau = next; break; }
    tau = next;
  }
  st = kin.stateAt(tau);
  return { tau, st, residual: g(tau, st), iters: it };
}

// ==========================================================================
// Bake / 베이킹
// ==========================================================================

/** Equal-power gains of Web Audio's StereoPannerNode for a mono input. / 등전력 팬 게인 */
export function equalPowerGains(pan) {
  const x = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return { L: Math.cos(x), R: Math.sin(x) };
}

/** Inverse-distance gain with a near clamp. / 역거리 게인 (근접 클램프) */
export const distanceGain = (r, refDist) => refDist / Math.max(r, refDist);
/** Air-absorption low-pass cutoff. / 공기 흡수 로우패스 컷오프 */
export const airCutoff = (r, airDist) => clamp(18000 / (1 + r / Math.max(1e-6, airDist)), 800, 20000);

/** Bake one source over the listener-time window it is audible in. / 음원 하나 베이킹 */
export function bakeSource(src, doc) {
  const kin = getKinematics(src, doc);
  const L = doc.listener;
  const c = kin.cEff;
  const fs = sourcePitchFn(src);
  const h = kin.h;
  const dist = (st) => Math.sqrt((st.x - L.x) ** 2 + (st.y - L.y) ** 2 + h * h);
  const t0 = kin.start + dist(kin.stateAt(0)) / c;
  const t1 = kin.start + kin.dur + dist(kin.stateAt(kin.dur)) / c;
  const rate = BAKE_RATES.includes(doc.bakeRate) ? doc.bakeRate : 200;
  const n = clamp(Math.ceil((t1 - t0) * rate) + 1, 2, MAX_BAKE_SAMPLES);
  const dt = (t1 - t0) / (n - 1);
  const F = () => new Float64Array(n);
  const b = { id: src.id, n, t0, t1, dt, t: F(), te: F(), fObs: F(), fs: F(), gain: F(), lp: F(), pan: F(), fwd: F(), up: F(), r: F(), vr: F(), x: F(), y: F(), az: F() };
  const hd = (num(L.headingDeg, 0) * Math.PI) / 180;
  const ch = Math.cos(hd);
  const sh = Math.sin(hd);
  let guess = NaN;
  let maxRes = 0;
  let rMin = Infinity;
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? t1 : t0 + i * dt;
    const sol = solveEmission(kin, L, t, guess);
    const tau = sol ? sol.tau : i === 0 ? 0 : kin.dur;
    const st = sol ? sol.st : kin.stateAt(tau);
    if (sol) { guess = tau; maxRes = Math.max(maxRes, Math.abs(sol.residual)); }
    const dx = st.x - L.x;
    const dy = st.y - L.y;
    const r = Math.sqrt(dx * dx + dy * dy + h * h);
    const vr = r > 1e-12 ? (dx * st.vx + dy * st.vy) / r : 0;
    const lat = dx * ch - dy * sh;
    const fwd = dx * sh + dy * ch;
    const fsrc = fs(tau);
    b.t[i] = t;
    b.te[i] = kin.start + tau;
    b.fs[i] = fsrc;
    b.fObs[i] = src.doppler !== false ? fsrc / (1 + vr / c) : fsrc;
    b.r[i] = r;
    b.vr[i] = vr;
    b.x[i] = st.x;
    b.y[i] = st.y;
    b.pan[i] = src.pan !== false && r > 1e-9 ? clamp(lat / r, -1, 1) : 0;
    b.fwd[i] = src.pan !== false && r > 1e-9 ? fwd / r : 1;
    b.up[i] = src.pan !== false && r > 1e-9 ? h / r : 0;
    b.az[i] = (Math.atan2(lat, fwd) * 180) / Math.PI;
    b.lp[i] = src.airAbsorb !== false ? airCutoff(r, doc.airDist) : 20000;
    if (r < rMin) rMin = r;
  }
  const ref = clamp(num(doc.refDist, 1), 0.1, 50);
  const flat = distanceGain(rMin, ref); // distanceGain off → constant closest-approach level / 끄면 최근접 레벨 고정
  for (let i = 0; i < n; i++) b.gain[i] = src.distanceGain !== false ? distanceGain(b.r[i], ref) : flat;
  b.rMin = rMin;
  b.maxResidual = maxRes;
  b.clamped = kin.clamped;
  b.maxVc = kin.maxVc;
  b.fMin = Math.min(...minMax(b.fObs), ...minMax(b.fs));
  b.fMax = Math.max(...minMax(b.fObs), ...minMax(b.fs));
  return b;
}

function minMax(arr) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
  return [lo, hi];
}

/** Physics-only signature (timbre, baseGain, mute/solo, names, view, panMode excluded). */
export function spaceSignature(doc) {
  const L = doc.listener || {};
  return JSON.stringify([
    doc.c, doc.cScale, doc.airDist, doc.refDist, doc.bakeRate, [L.x, L.y, L.headingDeg],
    (doc.sources || []).map((s) => [s.id, s.path, s.speed, s.start, s.duration, s.f, s.doppler !== false, s.distanceGain !== false, s.airAbsorb !== false, s.pan !== false]),
  ]);
}

const bakeCache = new Map();
const BAKE_CACHE_MAX = 6;
let bakeCount = 0;

/** Number of real (non-cached) document bakes so far. / 실제 베이킹 횟수 */
export const getSpaceBakeCount = () => bakeCount;

/**
 * Bake every source of the document (memoised by physics signature).
 * 문서의 모든 음원 베이킹 (물리 시그니처로 캐시).
 * @returns {{ sig, sources: Map<string, object>, count, ms, maxVc, clamped, endSec }}
 */
export function bakeSpace(doc) {
  const sig = spaceSignature(doc);
  const hit = bakeCache.get(sig);
  if (hit) {
    bakeCache.delete(sig);
    bakeCache.set(sig, hit);
    return hit;
  }
  const t0 = now();
  const sources = new Map();
  let maxVc = 0;
  let clamped = false;
  let endSec = 0;
  for (const s of doc.sources || []) {
    const b = bakeSource(s, doc);
    sources.set(s.id, b);
    maxVc = Math.max(maxVc, b.maxVc);
    clamped = clamped || b.clamped;
    endSec = Math.max(endSec, b.t1);
  }
  const result = Object.freeze({ sig, sources, count: ++bakeCount, ms: now() - t0, maxVc, clamped, endSec });
  bakeCache.set(sig, result);
  if (bakeCache.size > BAKE_CACHE_MAX) bakeCache.delete(bakeCache.keys().next().value);
  return result;
}

/** Linear lookup of a baked array at listener time t (NaN outside). / 베이킹 배열 선형 조회 */
export function sampleBake(b, key, t) {
  if (!b) return NaN;
  const eps = 1e-9 * Math.max(1, Math.abs(b.t1)); // t0 + x·(t1 − t0) may round past the ends / 끝점 반올림 허용
  if (t > b.t1 && t - b.t1 <= eps) t = b.t1;
  if (t < b.t0 && b.t0 - t <= eps) t = b.t0;
  if (!(t >= b.t0) || !(t <= b.t1)) return NaN;
  const s = (t - b.t0) / b.dt;
  const i = Math.min(b.n - 2, Math.floor(s));
  const f = s - i;
  const a = b[key];
  return a[i] + (a[i + 1] - a[i]) * f;
}

// ==========================================================================
// Display helpers (UI reads these; still pure) / 표시용 헬퍼
// ==========================================================================

/** Actual trajectory polyline over [0, dur] (cached on the kinematics). / 실제 궤적 */
export function trajectoryPolyline(src, doc, steps = 240) {
  const kin = getKinematics(src, doc);
  if (kin.poly && kin.poly.length === steps + 1) return kin.poly;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const st = kin.stateAt((i / steps) * kin.dur);
    pts.push({ x: st.x, y: st.y });
  }
  kin.poly = pts;
  return pts;
}

/**
 * Wavefront rings at listener time t: emitted at t − kΔ, radius c·kΔ (k = 1…count).
 * 청취자 시각 t의 파면 링: t − kΔ에 방출, 반지름 c·kΔ.
 */
export function wavefrontRings(src, doc, t, spacingSec, count = MAX_RINGS) {
  const kin = getKinematics(src, doc);
  const out = [];
  const n = Math.min(MAX_RINGS, count);
  for (let k = 1; k <= n; k++) {
    const te = t - k * spacingSec;
    const tau = te - kin.start;
    if (tau < 0) break;
    if (tau > kin.dur) continue;
    const st = kin.stateAt(tau);
    out.push({ x: st.x, y: st.y, radius: kin.cEff * k * spacingSec, k });
  }
  return out;
}

/** Drag handles of a path (world coordinates). / 경로 제어점 */
export function pathHandles(src, listener) {
  const p = src.path;
  const cx = p.onListener ? listener.x : p.cx;
  const cy = p.onListener ? listener.y : p.cy;
  switch (p.type) {
    case 'line': return [{ key: 'a', x: p.x0, y: p.y0 }, { key: 'b', x: p.x1, y: p.y1 }];
    case 'orbit': return [...(p.onListener ? [] : [{ key: 'c', x: cx, y: cy }]), { key: 'rx', x: cx + p.rx, y: cy }, { key: 'ry', x: cx, y: cy + p.ry }];
    case 'lissajous': return [{ key: 'c', x: cx, y: cy }, { key: 'axy', x: cx + p.ax, y: cy + p.ay }];
    case 'spiral': {
      const a0 = (p.phase * Math.PI) / 180;
      const a1 = a0 + (p.dir < 0 ? -1 : 1) * TAU * p.turns;
      return [...(p.onListener ? [] : [{ key: 'c', x: cx, y: cy }]), { key: 'r0', x: cx + p.r0 * Math.cos(a0), y: cy + p.r0 * Math.sin(a0) }, { key: 'r1', x: cx + p.r1 * Math.cos(a1), y: cy + p.r1 * Math.sin(a1) }];
    }
    case 'draw': return p.points.length ? [{ key: 'move', x: p.points[0].x, y: p.points[0].y }] : [];
    default: return [{ key: 'xy', x: p.x, y: p.y }];
  }
}

/** Apply a handle drag to a path draft (mutates). / 제어점 드래그 적용 */
export function applyHandleDrag(path, key, x, y, listener) {
  const p = path;
  const R = (v) => roundTo(v, 1);
  const cx = p.onListener ? listener.x : p.cx;
  const cy = p.onListener ? listener.y : p.cy;
  if (key === 'a') { p.x0 = R(x); p.y0 = R(y); }
  else if (key === 'b') { p.x1 = R(x); p.y1 = R(y); }
  else if (key === 'xy') { p.x = R(x); p.y = R(y); }
  else if (key === 'c') { p.cx = R(x); p.cy = R(y); }
  else if (key === 'rx') p.rx = R(Math.max(0.5, Math.abs(x - cx)));
  else if (key === 'ry') p.ry = R(Math.max(0.5, Math.abs(y - cy)));
  else if (key === 'axy') { p.ax = R(Math.max(0.5, Math.abs(x - cx))); p.ay = R(Math.max(0.5, Math.abs(y - cy))); }
  else if (key === 'r0') p.r0 = R(Math.hypot(x - cx, y - cy));
  else if (key === 'r1') p.r1 = R(Math.hypot(x - cx, y - cy));
  else if (key === 'move' && p.points.length) {
    const dx = x - p.points[0].x;
    const dy = y - p.points[0].y;
    p.points = p.points.map((q) => ({ x: R(q.x + dx), y: R(q.y + dy) }));
  }
}

/** Resample a freehand stroke to ≤ maxPts equally spaced points. / 자유 경로 등간격 재표본 */
export function resampleStroke(raw, maxPts = MAX_DRAW_POINTS, minSpacing = 1) {
  const pts = (raw || []).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (pts.length < 2) return pts.map((q) => ({ x: roundTo(q.x, 1), y: roundTo(q.y, 1) }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [{ x: roundTo(pts[0].x, 1), y: roundTo(pts[0].y, 1) }];
  const m = clamp(Math.round(total / minSpacing) + 1, 2, maxPts);
  const out = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = (k / (m - 1)) * total;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const f = clamp((s - cum[j]) / span, 0, 1);
    out.push({ x: roundTo(pts[j].x + (pts[j + 1].x - pts[j].x) * f, 1), y: roundTo(pts[j].y + (pts[j + 1].y - pts[j].y) * f, 1) });
  }
  return out;
}

/** Arc length of a source's path (metres; 0 for static). / 경로 길이 */
export const pathLength = (src, listener) => buildGeometry(src.path, listener).len;

/**
 * Deterministic random scene from a seed (seeded PRNG). / 시드 기반 결정론적 랜덤 장면
 */
export function createRandomScene(seed = 1) {
  const rng = createSeededRandom(Math.max(1, Math.floor(seed)));
  const R = (a, b) => a + (b - a) * rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const d = baseDoc();
  d.seed = seed;
  d.preset = '';
  d.cScale = roundTo(R(0.3, 0.8), 2);
  d.refDist = 5;
  d.length = 24;
  const PENTA = [0, 2, 4, 7, 9];
  const n = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const type = pick(['line', 'orbit', 'lissajous', 'spiral']);
    const midi = 55 + 12 * Math.floor(rng() * 2) + pick(PENTA);
    const ang = R(0, TAU);
    const off = R(3, 15);
    const path = {
      type,
      x0: roundTo(-120 * Math.cos(ang) - off * Math.sin(ang), 1), y0: roundTo(-120 * Math.sin(ang) + off * Math.cos(ang), 1),
      x1: roundTo(120 * Math.cos(ang) - off * Math.sin(ang), 1), y1: roundTo(120 * Math.sin(ang) + off * Math.cos(ang), 1),
      cx: roundTo(R(-20, 20), 1), cy: roundTo(R(-15, 25), 1), rx: roundTo(R(12, 40), 1), ry: roundTo(R(12, 40), 1), phase: Math.round(R(0, 360)), dir: rng() < 0.5 ? -1 : 1,
      ax: roundTo(R(20, 45), 1), ay: roundTo(R(15, 35), 1), a: 1 + Math.floor(rng() * 3), b: 1 + Math.floor(rng() * 4), delta: Math.round(R(0, 180)),
      r0: roundTo(R(50, 110), 1), r1: roundTo(R(2, 10), 1), turns: roundTo(R(1, 3), 1),
    };
    d.sources.push(createSource(i, {
      id: `r${seed}_${i + 1}`,
      name: `Random ${i + 1}`,
      path,
      speed: { value: roundTo(R(10, 32), 1) },
      start: roundTo(R(0, 4), 1),
      duration: roundTo(R(12, 20), 1),
      f: { hz: roundTo(midiToFreq(midi), 2) },
      baseGain: roundTo(0.6 / Math.sqrt(n), 2),
    }));
  }
  d.activeSourceId = d.sources[0].id;
  d.view = { cx: 0, cy: 4, span: 160 };
  return d;
}
