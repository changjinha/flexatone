/**
 * Flexatone — studios/draw/draw-engine.js
 * Layer 2 (studios): Draw Studio core — freehand strokes → glissando splines (UPIC-style).
 * 계층 2 (studios): 드로잉 스튜디오 코어 — 손으로 그린 획 → 글리산도 스플라인 (UPIC 방식).
 *
 * Pure: no DOM, no Web Audio. Imports core/* and modules/* only.
 * 순수 모듈: DOM·Web Audio 없음.
 *
 * Pipeline (per stroke, non-destructive: always recomputed from `raw`)
 * 파이프라인 (획마다, 비파괴: 항상 raw에서 다시 계산)
 *   raw {t (s), p (MIDI), w (0..1)}
 *     → transform (stretch · reverse · invert · transpose)
 *     → time cleanup  'drop' (delete backward points) | 'split' (monotone runs → several voices)
 *                     | 'arc' (re-time by arc length: t = t₀ + s / arcSpeed)
 *     → pitch snap    lerp(p, snap(p), strength) in MIDI (= log-frequency) space
 *     → rdpSimplify + fitStrokeToSpline (core/math-utils.js) → customPoints (x ∈ [0,1] monotone)
 *   Arc length unit: 1 semitone; 1 s of horizontal travel = ARC_TIME_SCALE semitones, so
 *   a flat stroke in 'arc' mode at arcSpeed = ARC_TIME_SCALE plays at its drawn speed.
 *   호 길이 단위: 반음 (가로 1초 = ARC_TIME_SCALE 반음).
 *
 * Edit-time cache: results are memoised by a signature of the geometry inputs (raw, cleanup,
 * snap, smooth, transform). Sound params (timbre, gain) are excluded → no recomputation.
 * 결과는 형상 입력 서명으로 캐시 — 소리 파라미터는 서명에서 제외.
 */

import { clamp, lerp, roundTo, deepClone, createSeededRandom, fitStrokeToSpline } from '../../core/math-utils.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { sanitizeWarpStack, isIdentityStack, warpPolyline } from '../../modules/space-warp.js';

export const DRAW_ID = 'draw';
export const MAX_DRAW_VOICES = 64;
export const MAX_ANCHORS = 64;
export const ARC_TIME_SCALE = 12; // semitones per second of horizontal travel / 가로 1초 = 12반음
export const REVERSAL_MODES = Object.freeze(['drop', 'split', 'arc']);
export const SNAP_MODES = Object.freeze(['off', 'semitone', 'quarter', 'scale']);
export const GAIN_SOURCES = Object.freeze(['width', 'fixed']);
export const TOOLS = Object.freeze(['draw', 'select', 'node', 'erase', 'line', 'warp']);
/** Cell of the object effects (modules/space-warp.js): a brush is round in these units. / 객체 효과의 셀 단위 */
export const DRAW_CELL = Object.freeze({ ut: 0.125, um: 0.5 });
export const TIME_DIVS = Object.freeze([0, 0.25, 0.5, 1]); // 0 = off
export const PRESET_IDS = Object.freeze(['rising', 'swarm', 'mirror']);

/**
 * Scales as cent offsets within the octave (so ratio tunings can be added later as cents).
 * 음계 = 옥타브 내 센트 오프셋 (비율 조율도 센트로 확장 가능).
 */
export const SCALES = Object.freeze({
  major: Object.freeze([0, 200, 400, 500, 700, 900, 1100]),
  minor: Object.freeze([0, 200, 300, 500, 700, 800, 1000]),
  pentatonic: Object.freeze([0, 200, 400, 700, 900]),
  whole: Object.freeze([0, 200, 400, 600, 800, 1000]),
});
export const SCALE_IDS = Object.freeze(Object.keys(SCALES));

export const STROKE_COLORS = Object.freeze(['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171']);

const r4 = (x) => roundTo(x, 4);

// --------------------------------------------------------------------------
// Document / 문서
// --------------------------------------------------------------------------

let strokeSeq = 0;
export function newStrokeId() {
  strokeSeq += 1;
  return `ds_${Date.now().toString(36).slice(-5)}${strokeSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Round raw points for storage (4 decimals). / 저장용 소수 4자리 반올림 */
export function roundRaw(raw) {
  return (raw || []).map((q) => ({ t: r4(Math.max(0, Number(q.t) || 0)), p: r4(clamp(Number(q.p) || 60, 0, 135)), w: r4(clamp(Number.isFinite(Number(q.w)) ? Number(q.w) : 0.7, 0, 1)) }));
}

/** A stroke (JSON-safe). `template` copies drawing/sound settings. / 획 객체 */
export function createStroke(index = 0, raw = [], template = null, id = newStrokeId()) {
  const base = {
    id,
    name: `Stroke ${index + 1}`,
    color: STROKE_COLORS[index % STROKE_COLORS.length],
    muted: false,
    solo: false,
    raw: roundRaw(raw),
    reversal: 'drop',
    timeMode: 'x',
    arcSpeed: 12,
    smooth: 0.35,
    pitchSnap: 'off',
    scaleId: 'major',
    scaleRoot: 0,
    snapStrength: 1,
    gainSource: 'width',
    widthDepth: 1,
    baseGain: 0.8,
    timbre: { sine: 0.75, tri: 0.2, saw: 0.1, sqr: 0, rich: 0.15 },
    transform: { transpose: 0, stretch: 1, reverse: false, invert: false },
    direct: false, // Node-tool edited: raw = anchors, no simplify / snap / 노드 편집 직접 모드
    fx: [], // object effects: a space-warp stack that moves this stroke only (axes untouched) / 객체 효과: 이 획만 움직이는 변형 스택
  };
  if (template) {
    for (const k of ['reversal', 'timeMode', 'arcSpeed', 'smooth', 'pitchSnap', 'scaleId', 'scaleRoot', 'snapStrength', 'gainSource', 'widthDepth', 'baseGain']) base[k] = template[k] ?? base[k];
    base.timbre = { ...base.timbre, ...(template.timbre || {}) };
  }
  return base;
}

/** Stroke settings repaired to the contract. / 계약에 맞게 정규화 */
export function normalizeStroke(s, index = 0) {
  const d = createStroke(index, [], null, s?.id || newStrokeId());
  const v = { ...d, ...(s || {}) };
  v.raw = Array.isArray(s?.raw) ? s.raw : [];
  if (!REVERSAL_MODES.includes(v.reversal)) v.reversal = 'drop';
  v.timeMode = v.reversal === 'arc' ? 'arc' : 'x';
  if (!SNAP_MODES.includes(v.pitchSnap)) v.pitchSnap = 'off';
  if (!SCALE_IDS.includes(v.scaleId)) v.scaleId = 'major';
  if (!GAIN_SOURCES.includes(v.gainSource)) v.gainSource = 'width';
  v.transform = { ...d.transform, ...(s?.transform || {}) };
  v.timbre = { ...d.timbre, ...(s?.timbre || {}) };
  v.fx = sanitizeWarpStack(s?.fx);
  return v;
}

/** Built-in "Rising Arc" stroke raw. / 기본 호 */
function risingArcRaw() {
  const raw = [];
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    raw.push({ t: 0.5 + u * 4, p: 48 + 24 * (1 - (1 - u) * (1 - u)), w: 0.35 + 0.6 * Math.sin(Math.PI * u) });
  }
  return raw;
}

/** Default Draw document (stored in appState.studioParams.draw). Deterministic. / 기본 문서 */
export function createDefaultDrawParams() {
  const s = createStroke(0, risingArcRaw(), null, 'ds_default_1');
  s.name = 'Rising Arc';
  return {
    version: 1,
    strokes: [s],
    grid: { timeDiv: 0.5, pitchDiv: 'semitone' },
    view: { tMin: 0, tMax: 6, midiMin: 40, midiMax: 84 },
    activeStrokeId: s.id,
    selectedIds: [s.id],
    tool: 'draw',
    drawWidth: 0.7,
    seed: 1,
    echo: { count: 3, dt: 0.5, dp: -3, decay: 0.8 },
    importScale: 0.6,
    liq: { tool: 'push', size: 8, strength: 0.6 }, // brush of the Warp tool (object liquify) / 변형 도구의 브러시
  };
}

// --------------------------------------------------------------------------
// Stage 1 — transform / 변환
// --------------------------------------------------------------------------

export function isIdentityTransform(tr) {
  return !tr || ((tr.transpose || 0) === 0 && (tr.stretch ?? 1) === 1 && !tr.reverse && !tr.invert);
}

/** Apply stretch · reverse · invert · transpose to [{t,p,w}]. / 비파괴 변환 */
export function applyTransform(points, tr) {
  if (!points.length || isIdentityTransform(tr)) return points.map((q) => ({ ...q }));
  let tMin = Infinity;
  let tMax = -Infinity;
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const q of points) {
    if (q.t < tMin) tMin = q.t;
    if (q.t > tMax) tMax = q.t;
    if (q.p < pMin) pMin = q.p;
    if (q.p > pMax) pMax = q.p;
  }
  const k = clamp(Number(tr.stretch) || 1, 0.05, 20);
  let out = points.map((q) => {
    let t = q.t;
    let p = q.p;
    if (tr.reverse) t = tMin + tMax - t;
    if (tr.invert) p = pMin + pMax - p;
    t = tMin + (t - tMin) * k;
    return { t, p: p + (Number(tr.transpose) || 0), w: q.w };
  });
  if (tr.reverse) out = out.reverse();
  return out;
}

// --------------------------------------------------------------------------
// Stage 2 — time cleanup / 시간 정리
// --------------------------------------------------------------------------

/** 'drop': keep only points that move forward in time. / 뒤로 가는 점 삭제 */
export function dropReversals(points) {
  if (!points.length) return [];
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) if (points[i].t > out[out.length - 1].t + 1e-6) out.push(points[i]);
  return out;
}

/**
 * 'split': partition into maximal monotone runs; backward runs are time-reversed so every piece
 * is non-decreasing in t. The partition keeps every point exactly once.
 * 'split': 단조 구간으로 분할 (역행 구간은 시간 반전) — 모든 점은 정확히 한 번 포함.
 */
export function splitReversals(points) {
  const runs = [];
  let cur = [];
  let dir = 0;
  for (let i = 0; i < points.length; i++) {
    if (!cur.length) { cur.push(points[i]); dir = 0; continue; }
    const dt = points[i].t - cur[cur.length - 1].t;
    const d = Math.abs(dt) < 1e-9 ? 0 : Math.sign(dt);
    if (d === 0 || dir === 0 || d === dir) {
      cur.push(points[i]);
      if (dir === 0) dir = d;
    } else {
      runs.push({ pts: cur, dir });
      cur = [points[i]];
      dir = 0;
    }
  }
  if (cur.length) runs.push({ pts: cur, dir });
  return runs.map((r) => (r.dir < 0 ? r.pts.slice().reverse() : r.pts));
}

/** Arc length (semitone units) of a polyline. / 호 길이 (반음 단위) */
export function arcLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot((points[i].t - points[i - 1].t) * ARC_TIME_SCALE, points[i].p - points[i - 1].p);
  return s;
}

/** 'arc': t = t₀ + s / arcSpeed (curve may go backwards on screen). / 호 길이로 재생 */
export function arcRetime(points, arcSpeed = 12) {
  if (!points.length) return [];
  const sp = Math.max(0.1, Number(arcSpeed) || 12);
  const t0 = points[0].t;
  let s = 0;
  const out = [{ ...points[0], t: t0 }];
  for (let i = 1; i < points.length; i++) {
    s += Math.hypot((points[i].t - points[i - 1].t) * ARC_TIME_SCALE, points[i].p - points[i - 1].p);
    out.push({ ...points[i], t: t0 + s / sp });
  }
  return dropReversals(out); // removes zero-length steps only / 길이 0 단계만 제거
}

export function cleanupTime(points, reversal = 'drop', arcSpeed = 12) {
  if (reversal === 'split') return splitReversals(points);
  if (reversal === 'arc') return [arcRetime(points, arcSpeed)];
  return [dropReversals(points)];
}

// --------------------------------------------------------------------------
// Stage 3 — pitch snap (MIDI = log-frequency space) / 음고 스냅
// --------------------------------------------------------------------------

/** Nearest grid pitch for a snap mode. / 가장 가까운 격자 음고 */
export function snapTarget(p, mode, scaleId = 'major', scaleRoot = 0) {
  if (mode === 'semitone') return Math.round(p);
  if (mode === 'quarter') return Math.round(p * 2) / 2;
  if (mode === 'scale') {
    const cents = SCALES[scaleId] || SCALES.major;
    const root = ((Math.round(Number(scaleRoot) || 0) % 12) + 12) % 12;
    const base = Math.floor((p - root) / 12) * 12 + root;
    let best = p;
    let bestD = Infinity;
    for (let o = -12; o <= 12; o += 12) {
      for (const c of cents) {
        const q = base + o + c / 100;
        const d = Math.abs(q - p);
        if (d < bestD - 1e-12) { bestD = d; best = q; }
      }
    }
    return best;
  }
  return p;
}

/** lerp(p, snap(p), strength): 0 = untouched, 1 = on the grid. / 스냅 강도 */
export function snapPitch(p, mode, strength = 1, scaleId = 'major', scaleRoot = 0) {
  if (mode === 'off' || !(strength > 0)) return p;
  const s = snapTarget(p, mode, scaleId, scaleRoot);
  return strength >= 1 ? s : lerp(p, s, strength);
}

// --------------------------------------------------------------------------
// Stage 4 — simplify + spline fit / 단순화 + 스플라인 근사
// --------------------------------------------------------------------------

/** smooth 0..1 → tolerance in semitones. / 허용오차 (반음) */
export function smoothToEpsilon(smooth) {
  const s = clamp(Number(smooth) || 0, 0, 1);
  return 0.04 + 2.0 * Math.pow(s, 1.5);
}

const lerpW = (pts, t) => {
  if (!pts.length) return 0;
  if (t <= pts[0].t) return pts[0].w;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].t >= t) {
      const a = pts[i - 1];
      const b = pts[i];
      const u = b.t - a.t > 1e-9 ? (t - a.t) / (b.t - a.t) : 1;
      return a.w + (b.w - a.w) * u;
    }
  }
  return pts[pts.length - 1].w;
};

/** Pitch of a piece at absolute time (from its fitted customPoints). / 조각의 음고 */
export function piecePitchAt(piece, t) {
  // x is the played time; a clipped piece's curve maps it onto its part of the curve (core/line-clip.js)
  const x = clamp((t - piece.t0) / Math.max(1e-9, piece.dur), 0, 1);
  return piece.pA + evaluateCurveObjectY(piece.curve, x) * (piece.pB - piece.pA);
}

/** Width (0..1) of a piece at absolute time. / 조각의 두께 */
export function pieceWidthAt(piece, t) {
  return lerpW(piece.pts, t);
}

/** Gain factor written by the object effects (Halftone gate, Chromatic copy gain) at absolute time; 1 without effects. */
export function pieceFxGainAt(piece, t) {
  if (!piece.fxGain) return 1;
  const pts = piece.pts;
  if (t <= pts[0].t) return pts[0].g ?? 1;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
  const a = pts[lo];
  const b = pts[hi];
  const u = b.t - a.t > 1e-9 ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 1;
  return (a.g ?? 1) + ((b.g ?? 1) - (a.g ?? 1)) * u;
}

/**
 * Least-squares quadratic handle per segment (control at u = ½ → x(s) = s, so
 * y(s) = (1−s)²y₀ + 2s(1−s)c + s²y₁ and c = Σb(y − a) / Σb²). Replaces the nearest-sample
 * handle of fitStrokeToSpline; kept only where it beats the straight line by `minGain`.
 * 구간별 최소제곱 2차 핸들 (직선보다 minGain 이상 좋을 때만 유지).
 */
function refineHandles(fit, norm, minGain) {
  let j = 0;
  for (let i = 0; i < fit.length - 1; i++) {
    const p0 = fit[i];
    const p1 = fit[i + 1];
    const dx = p1.x - p0.x;
    let sbb = 0;
    let sby = 0;
    let lin = 0;
    const seg = [];
    while (j < norm.length && norm[j].x < p0.x) j++;
    for (let k = j; k < norm.length && norm[k].x <= p1.x; k++) seg.push(norm[k]);
    for (const q of seg) {
      const s = dx > 0 ? (q.x - p0.x) / dx : 0;
      const a = (1 - s) * (1 - s) * p0.y + s * s * p1.y;
      const b = 2 * s * (1 - s);
      sbb += b * b;
      sby += b * (q.y - a);
      const dl = q.y - (p0.y + s * (p1.y - p0.y));
      lin += dl * dl;
    }
    p0.handles = [];
    if (sbb < 1e-12 || seg.length < 3) continue;
    const c = sby / sbb;
    let quad = 0;
    for (const q of seg) {
      const s = (q.x - p0.x) / dx;
      const d = q.y - ((1 - s) * (1 - s) * p0.y + 2 * s * (1 - s) * c + s * s * p1.y);
      quad += d * d;
    }
    if (Math.sqrt(lin / seg.length) - Math.sqrt(quad / seg.length) > minGain) p0.handles = [{ u: 0.5, y: roundTo(c, 6) }];
  }
}

/**
 * Fit one monotone run to a custom spline. y is scaled so x and y share one metric
 * (semitone-equivalents), making the RDP tolerance isotropic.
 * 단조 구간 하나를 스플라인으로 근사 (x·y 동일 척도로 RDP 허용오차를 등방성으로 유지).
 */
export function fitPiece(pts, { smooth = 0.35, direct = false } = {}) {
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const dur = pts[pts.length - 1].t - t0;
  if (!(dur > 0.02)) return null;
  const pA = pts[0].p;
  let pB = pts[pts.length - 1].p;
  const refOnly = Math.abs(pB - pA) < 1;
  if (refOnly) pB = pA + 12; // flat stroke: F1 is only a reference / 평탄한 획: F1은 기준값
  const span = pB - pA;
  const S = Math.max(1e-3, dur * ARC_TIME_SCALE);
  const eps = smoothToEpsilon(smooth);
  let customPoints;
  if (direct) {
    customPoints = pts.map((q, i) => ({ x: i === 0 ? 0 : i === pts.length - 1 ? 1 : roundTo((q.t - t0) / dur, 5), y: roundTo((q.p - pA) / span, 5), handles: [] }));
  } else {
    const norm = pts.map((q) => ({ x: (q.t - t0) / dur, y: (q.p - pA) / S }));
    let e = eps / S;
    let fit = null;
    for (let guard = 0; guard < 24; guard++) {
      fit = fitStrokeToSpline(norm, { minDx: 0.004, epsilon: e, curveThreshold: e * 0.5 });
      if (!fit || fit.length <= MAX_ANCHORS) break;
      e *= 1.4;
    }
    if (!fit) return null;
    refineHandles(fit, norm, e * 0.25);
    const k = S / span;
    customPoints = fit.map((q) => ({ x: q.x, y: roundTo(q.y * k, 5), handles: (q.handles || []).map((h) => ({ u: h.u, y: roundTo(h.y * k, 5) })) }));
  }
  const curve = { engine: 'custom', customPoints, reverse: false, inverse: false };
  const piece = { pts, t0, dur, pA, pB, refOnly, curve, customPoints, eps };
  let se = 0;
  for (const q of pts) {
    const d = piecePitchAt(piece, q.t) - q.p;
    se += d * d;
  }
  piece.rmse = Math.sqrt(se / pts.length);
  return piece;
}

// --------------------------------------------------------------------------
// Whole stroke + signature cache / 획 전체 + 서명 캐시
// --------------------------------------------------------------------------

export const GEOMETRY_KEYS = ['raw', 'reversal', 'arcSpeed', 'smooth', 'pitchSnap', 'scaleId', 'scaleRoot', 'snapStrength', 'transform', 'direct', 'fx'];

/** Signature of every geometry input (sound params excluded). / 형상 입력 서명 */
export function strokeSignature(s) {
  return JSON.stringify(GEOMETRY_KEYS.map((k) => s?.[k]));
}

let processCount = 0;
const cache = new Map(); // signature → result (LRU-ish) / 서명 → 결과
const CACHE_LIMIT = 400;

/** Number of real (uncached) stroke computations so far. / 실제 계산 횟수 */
export function getProcessCount() {
  return processCount;
}

/** Environment of a stroke's object effects: its bounding box is the domain. / 획 객체 효과의 환경 (경계 상자 = 영역) */
export function strokeWarpEnv(points) {
  let t0 = Infinity;
  let t1 = -Infinity;
  let m0 = Infinity;
  let m1 = -Infinity;
  for (const q of points) { if (q.t < t0) t0 = q.t; if (q.t > t1) t1 = q.t; if (q.p < m0) m0 = q.p; if (q.p > m1) m1 = q.p; }
  return { seed: 1, ut: DRAW_CELL.ut, um: DRAW_CELL.um, t0, t1: Math.max(t1, t0 + 0.05), m0, m1: Math.max(m1, m0 + 0.5) };
}

/** Uncached pipeline. / 캐시 없는 파이프라인 */
export function computeStroke(s) {
  const raw = (s.raw || []).map((q) => ({ t: Number(q.t), p: Number(q.p), w: Number(q.w) }));
  const tr = applyTransform(raw, s.transform);
  // Object effects (modules/space-warp.js): the points of THIS stroke are moved — the axes and the
  // other strokes stay where they are. Normalised centres refer to the stroke's own bounding box.
  // 객체 효과: 이 획의 점만 옮김 (축과 다른 획은 그대로). 정규화된 중심은 획 자신의 경계 상자 기준.
  let lines = [tr];
  const fx = !isIdentityStack(s.fx) && tr.length >= 2;
  if (fx) lines = warpPolyline(tr.map((q) => ({ t: q.t, m: q.p, w: q.w })), s.fx, strokeWarpEnv(tr), { monotone: false }).map((r) => r.pts.map((q) => ({ t: Math.max(0, q.t), p: clamp(q.m, 0, 135), w: q.w, g: q.g })));
  const runs = [];
  for (const ln of lines) runs.push(...(s.direct ? [dropReversals(ln)] : cleanupTime(ln, s.reversal, s.arcSpeed)));
  const pieces = [];
  let dropped = 0;
  for (const run of runs) {
    const snapped = s.direct ? run : run.map((q) => ({ ...q, p: snapPitch(q.p, s.pitchSnap, s.snapStrength, s.scaleId, s.scaleRoot) }));
    const piece = fitPiece(snapped, { smooth: s.smooth, direct: !!s.direct && !fx });
    if (piece) { piece.fxGain = fx && snapped.some((q) => q.g !== undefined && q.g < 0.999); pieces.push(piece); }
    else dropped += 1;
  }
  return { pieces, runs: runs.length, dropped, rawCount: raw.length };
}

/** Cached pipeline result for a stroke. / 캐시된 결과 */
export function processStroke(s) {
  const sig = strokeSignature(s);
  const hit = cache.get(sig);
  if (hit) {
    cache.delete(sig);
    cache.set(sig, hit);
    return hit;
  }
  processCount += 1;
  const res = Object.freeze(computeStroke(s));
  cache.set(sig, res);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return res;
}

/** id → result for every stroke (its play range applied). / 모든 획의 결과 (재생 구간 적용) */
export function processDoc(doc) {
  const m = new Map();
  for (const s of doc?.strokes || []) m.set(s.id, s.clip ? clipStrokeResult(processStroke(s), s.clip) : processStroke(s));
  return m;
}

/** Time span of a processed stroke (first piece start → last piece end). / 처리된 획의 시간 구간 */
export function strokeSpan(res) {
  const ps = res?.pieces || [];
  if (!ps.length) return null;
  let S0 = Infinity;
  let S1 = -Infinity;
  for (const pc of ps) { S0 = Math.min(S0, pc.t0); S1 = Math.max(S1, pc.t0 + pc.dur); }
  return { S0, S1, D: Math.max(1e-6, S1 - S0) };
}

/**
 * Apply a stroke's play range (core/line-clip.js, u over the processed span) to its pieces: the played
 * parts become pieces whose curve carries a clip (extensions past the first / last piece follow its end
 * tangent), the cut-off parts are kept in `ghost` for the faint drawing. / 획의 재생 구간을 조각에 적용
 */
export function clipStrokeResult(res, clip) {
  const sp = strokeSpan(res);
  if (!sp) return res;
  const u0 = Number.isFinite(clip?.u0) ? clip.u0 : 0;
  const u1 = Number.isFinite(clip?.u1) ? clip.u1 : 1;
  const W0 = sp.S0 + u0 * sp.D;
  const W1 = sp.S0 + u1 * sp.D;
  const pieces = [];
  const ghost = [];
  for (const pc of res.pieces) {
    const a = pc.t0;
    const b = pc.t0 + pc.dur;
    let lo = Math.max(a, W0);
    let hi = Math.min(b, W1);
    if (Math.abs(a - sp.S0) < 1e-9 && W0 < a) lo = W0; // extended before the first piece / 첫 조각 앞으로 연장
    if (Math.abs(b - sp.S1) < 1e-9 && W1 > b) hi = W1; // extended past the last piece / 마지막 조각 뒤로 연장
    if (hi - lo > 1e-3) {
      const D = Math.max(1e-9, pc.dur);
      pieces.push({ ...pc, t0: lo, dur: hi - lo, full: { t0: a, dur: pc.dur }, curve: { ...pc.curve, clip: { u0: (lo - a) / D, u1: (hi - a) / D, ext: 'tangent' } } });
    }
    if (W0 > a + 1e-6) ghost.push({ piece: pc, a, b: Math.min(b, W0) });
    if (W1 < b - 1e-6) ghost.push({ piece: pc, a: Math.max(a, W1), b });
  }
  return { ...res, pieces, ghost };
}

/** Voices the document would bake (pieces over all strokes). / 베이킹될 보이스 수 */
export function countPieces(doc, map = processDoc(doc)) {
  let n = 0;
  for (const s of doc?.strokes || []) n += map.get(s.id)?.pieces.length || 0;
  return n;
}

/** Gain envelope sampled at n+1 points (width → gain). / 두께 → 게인 */
export function pieceGainPoints(piece, stroke, n = 16) {
  const out = [];
  if (piece.fxGain) n = Math.max(n, Math.min(64, Math.ceil(piece.dur * 40))); // gates need more points / 게이트는 점이 더 필요
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const w = pieceWidthAt(piece, piece.t0 + x * piece.dur);
    const g = (stroke.gainSource === 'fixed' ? 1 : lerp(1, clamp(w, 0, 1), clamp(Number(stroke.widthDepth) || 0, 0, 1))) * pieceFxGainAt(piece, piece.t0 + x * piece.dur);
    out.push({ x: roundTo(x, 4), y: roundTo(clamp(g, 0, 1), 4), handles: [] });
  }
  return out;
}

/** Instantaneous gain multiplier (0..1) from width. / 순간 게인 계수 */
export function pieceGainAt(piece, stroke, t) {
  const fxg = pieceFxGainAt(piece, t);
  if (stroke.gainSource === 'fixed') return fxg;
  return fxg * lerp(1, clamp(pieceWidthAt(piece, t), 0, 1), clamp(Number(stroke.widthDepth) || 0, 0, 1));
}

/** Absolute anchors of a piece (for the Node tool). / 조각의 절대 앵커 */
export function pieceAnchors(piece) {
  return piece.customPoints.map((c) => ({ t: piece.t0 + c.x * piece.dur, p: piece.pA + evaluateCurveObjectY(piece.curve, c.x) * (piece.pB - piece.pA) }));
}

/**
 * Switch a stroke to direct (Node) mode: bake transform/snap/simplify into anchors, which
 * become the new raw (width sampled from the old result). Returns false if not possible.
 * 직접 모드 전환: 변환·스냅·단순화를 앵커에 굽고 raw를 앵커 샘플로 교체.
 */
export function enterDirectMode(stroke) {
  const res = computeStroke(stroke);
  if (res.pieces.length !== 1) return false;
  const piece = res.pieces[0];
  stroke.raw = roundRaw(pieceAnchors(piece).map((a) => ({ t: a.t, p: a.p, w: pieceWidthAt(piece, a.t) })));
  stroke.transform = { transpose: 0, stretch: 1, reverse: false, invert: false };
  stroke.direct = true;
  return true;
}

// --------------------------------------------------------------------------
// Editing helpers (pure) / 편집 헬퍼
// --------------------------------------------------------------------------

/** Move a stroke's raw by (dt, dp). / 획 이동 */
export function offsetRaw(raw, dt, dp) {
  return roundRaw(raw.map((q) => ({ t: q.t + dt, p: q.p + dp, w: q.w })));
}

/** Echo canon: N delayed / transposed copies with gain decay. / 에코 캐논 복제 */
export function echoCanon(stroke, { count = 3, dt = 0.5, dp = -3, decay = 0.8 } = {}, startIndex = 0) {
  const out = [];
  const n = clamp(Math.round(count), 1, 16);
  for (let k = 1; k <= n; k++) {
    const c = deepClone(stroke);
    c.id = newStrokeId();
    c.name = `${stroke.name} ·${k}`;
    c.color = STROKE_COLORS[(startIndex + k) % STROKE_COLORS.length];
    c.raw = offsetRaw(stroke.raw, dt * k, dp * k);
    c.baseGain = roundTo(clamp(stroke.baseGain * Math.pow(decay, k), 0, 1.5), 4);
    c.solo = false;
    out.push(c);
  }
  return out;
}

/** Erase: remove masked raw points and return the remaining runs (≥ 2 points). / 구간 지우기 */
export function cutRaw(raw, removeMask) {
  const runs = [];
  let cur = [];
  raw.forEach((q, i) => {
    if (removeMask[i]) { if (cur.length) runs.push(cur); cur = []; } else cur.push(q);
  });
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

/**
 * Normalised 2-D points (SVG user space, y down) → raw strokes placed in a target box.
 * All paths share one bounding box so the drawing keeps its proportions.
 * 2D 점 배열(SVG, y 아래) → 대상 상자에 맞춘 raw 획 (모든 경로가 하나의 경계 상자 공유).
 * @param {Array<Array<{x:number,y:number}>>} paths
 * @param {{t0:number,t1:number,p0:number,p1:number}} box   p0 = bottom pitch, p1 = top pitch
 */
export function pathsToRaw(paths, box, w = 0.7) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const path of paths) for (const q of path) {
    if (q.x < x0) x0 = q.x;
    if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.y > y1) y1 = q.y;
  }
  if (!Number.isFinite(x0)) return [];
  const sx = Math.max(1e-9, x1 - x0);
  const sy = Math.max(1e-9, y1 - y0);
  return paths.filter((p) => p.length >= 2).map((path) => roundRaw(path.map((q) => ({
    t: box.t0 + ((q.x - x0) / sx) * (box.t1 - box.t0),
    p: box.p1 - ((q.y - y0) / sy) * (box.p1 - box.p0),
    w,
  }))));
}

/** Thin raw points closer than (dtMin s, dpMin st) to the last kept point. / 기록 간인 */
export function thinRaw(raw, dtMin = 0.01, dpMin = 0.12) {
  if (raw.length <= 2) return raw.slice();
  const out = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const a = out[out.length - 1];
    if (Math.abs(raw[i].t - a.t) >= dtMin || Math.abs(raw[i].p - a.p) >= dpMin) out.push(raw[i]);
  }
  out.push(raw[raw.length - 1]);
  return out;
}

// --------------------------------------------------------------------------
// Presets (seeded, deterministic) / 프리셋 (시드 결정론)
// --------------------------------------------------------------------------

/** Strokes for a preset. / 프리셋 획 */
export function createPresetStrokes(presetId, seed = 1) {
  if (presetId === 'swarm') {
    const rnd = createSeededRandom(seed);
    const out = [];
    for (let k = 0; k < 12; k++) {
      const t0 = rnd() * 5;
      const dur = 0.8 + rnd() * 2.4;
      const p0 = 42 + rnd() * 40;
      const slope = (rnd() - 0.5) * 16;
      const amp = rnd() * 4;
      const f = 0.5 + rnd() * 3;
      const ph = rnd() * Math.PI * 2;
      const raw = [];
      const n = 30;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        raw.push({ t: t0 + u * dur, p: p0 + slope * u + amp * Math.sin(2 * Math.PI * f * u + ph), w: 0.25 + 0.7 * Math.sin(Math.PI * u) * (0.6 + 0.4 * rnd()) });
      }
      const s = createStroke(k, raw, null, `ds_swarm_${seed}_${k}`);
      s.name = `Swarm ${k + 1}`;
      s.baseGain = 0.45;
      s.timbre = { sine: 0.5, tri: 0.3, saw: 0.25 * rnd(), sqr: 0, rich: 0.3 * rnd() };
      out.push(s);
    }
    return out;
  }
  if (presetId === 'mirror') {
    const raw = [];
    for (let i = 0; i <= 48; i++) {
      const u = i / 48;
      raw.push({ t: 0.4 + u * 3.6, p: 60 + 9 * Math.sin(2 * Math.PI * u * 1.25) + 4 * u, w: 0.4 + 0.5 * Math.sin(Math.PI * u) });
    }
    const a = createStroke(0, raw, null, 'ds_mirror_a');
    a.name = 'Theme';
    const b = createStroke(1, offsetRaw(a.raw, 1, 0), a, 'ds_mirror_b');
    b.name = 'Mirror';
    b.transform = { transpose: 0, stretch: 1, reverse: false, invert: true };
    b.timbre = { sine: 0.4, tri: 0.5, saw: 0.2, sqr: 0, rich: 0.1 };
    return [a, b];
  }
  const s = createStroke(0, risingArcRaw(), null, 'ds_default_1');
  s.name = 'Rising Arc';
  return [s];
}
