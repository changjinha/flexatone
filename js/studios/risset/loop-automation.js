/**
 * Flexatone — studios/risset/loop-automation.js
 * Risset Studio (pure): looping automation engine (Vital modulation matrix excluded).
 * 리세 스튜디오 (순수): 루핑 오토메이션 엔진 (Vital 모듈레이션 매트릭스 제외).
 *
 * Each automatable parameter owns a lane { enabled, points } whose points are standard Flexatone
 * spline points { x, y, handles } (x = loop position 0…1, y = normalised value 0…1) evaluated with
 * core/math-utils.js (evalPiecewiseBezierPoints) — the same spline utilities as 11. Custom, so
 * splitting, bending and deleting behave identically.
 * 레인 점은 Flexatone 표준 스플라인 점 — 11. Custom과 같은 유틸로 평가·분할·벤딩·삭제.
 *
 * Effective value (bipolar around the knob): eff = clamp(base + (y − ½)·(max − min)·depth, min, max)
 * with depth = ½ (prototype) — y = ½ means "no change". / y = ½이면 변화 없음.
 */

import { clamp, evalPiecewiseBezierPoints, normalizeSplinePoints } from '../../core/math-utils.js';

/** Parameters the automation window can drive (key, range, step). / 오토메이션 가능 파라미터 */
export const AUTOMATABLE_PARAMS = Object.freeze([
  { key: 'rateHz', labelKey: 'risset.rate', min: -1, max: 1, step: 0.01 },
  { key: 'envCenter', labelKey: 'risset.envCenter', min: 0.05, max: 0.95, step: 0.01 },
  { key: 'envWidth', labelKey: 'risset.envWidth', min: 0.02, max: 1, step: 0.01 },
  { key: 'localRateHz', labelKey: 'risset.localRate', min: 0.01, max: 10, step: 0.05 },
  { key: 'localThreshold', labelKey: 'risset.localThreshold', min: -1, max: 0.95, step: 0.05 },
  { key: 'masterGain', labelKey: 'risset.masterGain', min: 0, max: 1.5, step: 0.01 },
  { key: 'shapeAmount', labelKey: 'risset.shapeAmount', min: 0, max: 1, step: 0.01 },
  { key: 'envSkew', labelKey: 'risset.envSkew', min: -0.9, max: 0.9, step: 0.01 },
  { key: 'spectralTilt', labelKey: 'risset.spectralTilt', min: -12, max: 12, step: 0.1 },
]);
export const AUTO_DEPTH = 0.5;
export const AUTO_LOOP_RANGE = Object.freeze([0.5, 120]);

const SPEC = new Map(AUTOMATABLE_PARAMS.map((p) => [p.key, p]));
export const getAutomatableSpec = (key) => SPEC.get(key) || null;

/** A lane with three points (flat → bump → flat). / 기본 레인 */
export function createLane(peak = 0.75, enabled = true) {
  return {
    enabled,
    points: [
      { x: 0, y: 0.5, handles: [] },
      { x: 0.5, y: peak, handles: [] },
      { x: 1, y: 0.5, handles: [] },
    ],
  };
}

/** Flat lane (no modulation). / 평탄 레인 */
export function createFlatLane(enabled = true) {
  return { enabled, points: [{ x: 0, y: 0.5, handles: [] }, { x: 1, y: 0.5, handles: [] }] };
}

/** Accept prototype lanes ({ t, v }) and Flexatone lanes ({ x, y, handles }). / 레인 정규화 */
export function normalizeLane(lane) {
  const raw = Array.isArray(lane?.points) ? lane.points : [];
  const pts = raw
    .map((p) => ({ x: clamp(Number(p.x ?? p.t), 0, 1), y: clamp(Number(p.y ?? p.v), 0, 1), handles: Array.isArray(p.handles) ? p.handles : [] }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 2) return { enabled: !!lane?.enabled, points: createFlatLane().points };
  pts.sort((a, b) => a.x - b.x);
  pts[0].x = 0;
  pts[pts.length - 1].x = 1;
  return { enabled: !!lane?.enabled, points: normalizeSplinePoints(pts) };
}

/** Normalised lane value at loop position u ∈ [0, 1]. / 레인 값 */
export function evalLane(lane, u) {
  const pts = lane?.points;
  if (!pts || pts.length < 2) return 0.5;
  return clamp(evalPiecewiseBezierPoints(pts, clamp(u, 0, 1)), 0, 1);
}

/** Loop position of an automation clock. / 루프 위치 */
export function loopPosition(autoTimeSec, loopSec) {
  const L = clamp(Number(loopSec) || 8, AUTO_LOOP_RANGE[0], AUTO_LOOP_RANGE[1]);
  return { u: (((autoTimeSec % L) + L) % L) / L, loopSec: L };
}

/** Effective value of one automated parameter. / 오토메이션 반영값 */
export function automatedValue(spec, base, laneValue) {
  return clamp(base + (laneValue - 0.5) * (spec.max - spec.min) * AUTO_DEPTH, spec.min, spec.max);
}

/**
 * Effective parameters at an automation clock time: `base` values with every enabled lane applied.
 * `baseOverride` = { key, value } from the colour controller replaces one base value first.
 * 오토메이션 시각의 유효 파라미터 (활성 레인 적용).
 * @returns {Record<string, number>}
 */
export function computeEffective(params, autoTimeSec, baseOverride = null) {
  const { u } = loopPosition(autoTimeSec, params.autoLoopSec);
  const eff = {};
  for (const spec of AUTOMATABLE_PARAMS) {
    // Composition order: controller → base value, then automation → ± deviation.
    // 합성 순서: 제어기 → 기준값, 오토메이션 → ± 편차.
    const base = baseOverride && baseOverride.key === spec.key ? baseOverride.value : Number(params[spec.key]) || 0;
    const lane = params.autoLanes?.[spec.key];
    eff[spec.key] = lane && lane.enabled ? automatedValue(spec, base, evalLane(lane, u)) : clamp(base, spec.min, spec.max);
  }
  return eff;
}

/** Index of the anchor nearest to (x, y) within `tol` (normalised), or −1. / 가까운 점 */
export function nearestAnchor(points, x, y, tolX = 0.025, tolY = 0.08) {
  let best = -1;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const dx = Math.abs(p.x - x);
    const dy = Math.abs(p.y - y);
    if (dx <= tolX && dy <= tolY && dx + dy < bestD) { bestD = dx + dy; best = i; }
  });
  return best;
}

