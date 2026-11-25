/**
 * Flexatone — studios/space/space-lanes.js
 * Layer 2 (studios, pure): parameter **lanes** of a Space source — an envelope (curve-engine
 * object) that draws one quantity against the source's own time, its progress along the path or
 * its distance to the listener. No DOM, no Web Audio.
 * 계층 2 (studios, 순수): 음원의 파라미터 **레인** — 음원 시계 / 경로 진행도 / 청취자와의 거리를
 * x축으로 하는 엔벨로프(곡선 엔진 객체). DOM·Web Audio 없음.
 *
 * Lane = { on, domain: 'time' | 'path' | 'distance', dom: null | [a, b], min, max,
 *          scale: 'lin' | 'log', curve: CurveObj }
 *   x axis: time → seconds of the source's clock, path → fraction of the path length (0…1),
 *           distance → metres between the EMISSION position and the listener.
 *   dom = null → automatic range (time: [0, duration], path: [0, 1], distance: [r min, r max]).
 *   y = curve(x01) ∈ [0, 1] mapped onto [min, max] (linear or logarithmic).
 * Every lane is evaluated with emission-time quantities and baked into listener-time arrays.
 * 모든 레인은 방출 시각의 양으로 평가되어 청취 시간 배열로 베이킹됨.
 *
 * Imports: core/*, modules/curve-engine.js.
 */

import { clamp } from '../../core/math-utils.js';
import { createDefaultCurveParams } from '../../core/state.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';

export const LANE_DOMAINS = Object.freeze(['time', 'path', 'distance']);
export const LANE_SCALES = Object.freeze(['lin', 'log']);
export const LANE_N = 1024; // lane table resolution / 레인 표 해상도

/**
 * Lane definitions: unit, default range, scale, default domain, neutral value and hard limits.
 * `speed` and `pitch` live in source.speed.env / source.f.env; the others in source.lanes.
 * 레인 정의. 속도·음고는 source.speed.env / source.f.env, 나머지는 source.lanes.
 */
export const LANE_DEFS = Object.freeze({
  speed: { unit: 'm/s', min: 0.5, max: 60, lo: 0, hi: 400, scale: 'lin', domain: 'path', neutral: 20, start: [0.3, 0.3] },
  pitch: { unit: 'Hz', min: 110, max: 880, lo: 10, hi: 20000, scale: 'log', domain: 'time', neutral: 440, start: [0.5, 0.5] },
  gain: { unit: 'dB', min: -24, max: 12, lo: -60, hi: 24, scale: 'lin', domain: 'time', neutral: 0, start: [2 / 3, 2 / 3] },
  bright: { unit: 'oct', min: -3, max: 3, lo: -6, hi: 6, scale: 'lin', domain: 'time', neutral: 0, start: [0.5, 0.5] },
  timbre: { unit: '', min: 0, max: 1, lo: 0, hi: 1, scale: 'lin', domain: 'time', neutral: 0, start: [0, 1] },
  air: { unit: '×', min: 0, max: 2, lo: 0, hi: 8, scale: 'lin', domain: 'time', neutral: 1, start: [0.5, 0.5] },
  dopplerAmt: { unit: '', min: 0, max: 1, lo: 0, hi: 2, scale: 'lin', domain: 'time', neutral: 1, start: [1, 1] },
  width: { unit: '', min: 0, max: 1, lo: 0, hi: 1, scale: 'lin', domain: 'distance', neutral: 0, start: [0.6, 0] }, // HOA source width / HOA 음원 폭
  height: { unit: 'm', min: 0, max: 20, lo: -500, hi: 500, scale: 'lin', domain: 'path', neutral: 0, start: [0, 1] }, // path: z from start to end (analytic paths) / 경로: 시작→끝 높이
  cscale: { unit: '× c', min: 0.05, max: 1, lo: 0.05, hi: 1, scale: 'lin', domain: 'time', neutral: 1, start: [1, 0.3] }, // document: speed of sound against time / 문서: 시간에 따른 음속
});
/** Lanes kept in source.lanes (speed / pitch are profile modes). / source.lanes에 두는 레인 */
export const SOURCE_LANES = Object.freeze(['gain', 'bright', 'timbre', 'air', 'dopplerAmt', 'width']);

const CURVE_DEFAULTS = Object.freeze(createDefaultCurveParams());
const fin = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** Two-point envelope (the neutral value, or a ramp for the timbre morph). / 기본 엔벨로프 */
export function createLane(kind = 'gain', over = {}) {
  const def = LANE_DEFS[kind] || LANE_DEFS.gain;
  return {
    on: false,
    domain: def.domain,
    dom: null,
    min: def.min,
    max: def.max,
    scale: def.scale,
    curve: { engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y: r4(def.start[0]), handles: [] }, { x: 1, y: r4(def.start[1]), handles: [] }] },
    ...over,
  };
}

/** Fill / clamp a saved lane (new object). / 저장된 레인 보정 */
export function normalizeLane(kind, raw) {
  const def = LANE_DEFS[kind] || LANE_DEFS.gain;
  const base = createLane(kind);
  const src = raw && typeof raw === 'object' ? raw : {};
  const lane = { ...base, ...src };
  lane.on = !!src.on;
  lane.domain = LANE_DOMAINS.includes(src.domain) ? src.domain : def.domain;
  lane.scale = LANE_SCALES.includes(src.scale) ? src.scale : def.scale;
  lane.min = clamp(fin(src.min, def.min), def.lo, def.hi);
  lane.max = clamp(fin(src.max, def.max), def.lo, def.hi);
  if (lane.scale === 'log') { lane.min = Math.max(lane.min, 1e-3); lane.max = Math.max(lane.max, 1e-3); }
  lane.dom = Array.isArray(src.dom) && src.dom.length === 2 && Number.isFinite(Number(src.dom[0])) && Number.isFinite(Number(src.dom[1])) && Number(src.dom[1]) - Number(src.dom[0]) > 1e-6
    ? [Number(src.dom[0]), Number(src.dom[1])]
    : null;
  lane.curve = src.curve && typeof src.curve === 'object' ? { ...src.curve } : base.curve;
  if (typeof lane.curve.engine !== 'string') lane.curve.engine = 'custom';
  if (lane.curve.engine === 'custom' && !(Array.isArray(lane.curve.customPoints) && lane.curve.customPoints.length >= 2)) lane.curve.customPoints = base.curve.customPoints;
  return lane;
}

/** y(x) ∈ [0, 1] of a lane's curve sampled into a table. / 레인 곡선 표 */
export function laneTable(curve) {
  const obj = { ...CURVE_DEFAULTS, engine: 'custom', reverse: false, inverse: false, ...(curve || {}) };
  const tab = new Float64Array(LANE_N + 1);
  for (let i = 0; i <= LANE_N; i++) {
    const y = evaluateCurveObjectY(obj, i / LANE_N, { regions: false });
    tab[i] = Number.isFinite(y) ? clamp(y, 0, 1) : 0;
  }
  return tab;
}

const tabAt = (tab, x) => {
  const s = clamp(x, 0, 1) * LANE_N;
  const i = Math.min(LANE_N - 1, Math.floor(s));
  return tab[i] + (tab[i + 1] - tab[i]) * (s - i);
};

/** Map y ∈ [0, 1] onto the lane's value range. / y → 값 */
export function laneValue(lane, y) {
  const a = lane.min;
  const b = lane.max;
  if (lane.scale === 'log' && a > 0 && b > 0) return a * Math.pow(b / a, y);
  return a + (b - a) * y;
}

/** Value → y ∈ [0, 1] (inverse of laneValue). / 값 → y */
export function laneNorm(lane, v) {
  const a = lane.min;
  const b = lane.max;
  if (Math.abs(b - a) < 1e-12) return 0;
  if (lane.scale === 'log' && a > 0 && b > 0) return clamp(Math.log(Math.max(1e-9, v) / a) / Math.log(b / a), 0, 1);
  return clamp((v - a) / (b - a), 0, 1);
}

/**
 * Compile a lane into value(x) where x is in the lane's own domain units (seconds, 0…1, metres).
 * `auto` = the automatic range used when lane.dom is null.
 * 레인을 값(x) 함수로 (x는 도메인 단위). auto = dom이 null일 때의 자동 범위.
 */
export function compileLane(lane, auto) {
  const tab = laneTable(lane.curve);
  const d = lane.dom || auto || [0, 1];
  const a = d[0];
  const span = Math.max(1e-9, d[1] - d[0]);
  const fn = (x) => laneValue(lane, tabAt(tab, (x - a) / span));
  fn.range = [a, a + span];
  return fn;
}

/** Envelope points sampled from a function y01(x01) at the given x positions. / 함수 → 엔벨로프 점 */
export function pointsFromFunction(fn, xs) {
  return xs.map((x) => ({ x: r4(x), y: r4(clamp(fn(x), 0, 1)), handles: [] }));
}
