/**
 * Flexatone — core/automation.js
 * Layer 0 (core): timeline automation — a parameter of a toolbox moved along the studio's time axis,
 * drawn as an envelope under a module (voice) of the Timeline. Pure data + maths (no DOM, no audio).
 * 계층 0 (core): 타임라인 오토메이션 — 툴박스 파라미터를 스튜디오 시간축을 따라 움직이는 엔벨로프.
 * 순수 데이터·수학.
 *
 * Lane / 레인
 *   { id, mod: module key (line key of the Timeline), tool: rack key of the toolbox, toolTitle,
 *     pid: parameter id inside the toolbox ("<index>|<label>"), label, min, max, step,
 *     on (read during playback), show (lane open under the module),
 *     nodes: [{ t: s, v: value, c: curvature of the segment to the next node }] }
 * Segment shape / 구간 모양 (c = 0 → straight):
 *   f(u) = (e^{c·u} − 1) / (e^{c} − 1),  v = v₀ + (v₁ − v₀)·f(u),  u = (t − t₀)/(t₁ − t₀)
 *   The curve handle sits at u = ½: h = f(½) = 1 / (1 + e^{c/2})  ⇔  c = 2·ln((1 − h) / h).
 *   핸들은 u = ½: h = f(½), 핸들을 끌면 c = 2·ln((1 − h)/h).
 * Before the first node the value holds the first node, after the last node the last one.
 * Storage: studioParams._automation = { [studio]: { lanes: [...] } } ("_" is never a studio id).
 */

import { clamp, uid } from './math-utils.js';
import { registerSelfCheck } from './state.js';

export const AUTOMATION_KEY = '_automation';
export const CURVE_MAX = 12; // |c| limit (handle from ~0.25 % to ~99.75 % of the step) / 곡률 한계
export const MAX_NODES = 256;

const fin = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** Segment shape f(u) for curvature c. / 구간 모양 */
export function shape(u, c) {
  const k = clamp(fin(c), -CURVE_MAX, CURVE_MAX);
  const x = clamp(u, 0, 1);
  if (Math.abs(k) < 1e-4) return x;
  return Math.expm1(k * x) / Math.expm1(k);
}

/** Handle place h = f(½) of a curvature, and back. / 곡률 ↔ 핸들 위치 */
export const handleOf = (c) => shape(0.5, c);
export function curvatureOf(h) {
  const x = clamp(fin(h, 0.5), 0.0025, 0.9975);
  return clamp(2 * Math.log((1 - x) / x), -CURVE_MAX, CURVE_MAX);
}

/** Sorted, clamped node list. / 정렬·제한된 노드 */
export function normalizeNodes(raw, min = -Infinity, max = Infinity) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n) => ({ t: Math.max(0, fin(n?.t)), v: clamp(fin(n?.v, min), min, max), c: clamp(fin(n?.c), -CURVE_MAX, CURVE_MAX) }))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_NODES);
}

/** A lane read from saved data (or null when it is not one). / 저장 데이터에서 레인 */
export function normalizeLane(raw) {
  if (!raw || typeof raw !== 'object' || !raw.tool || !raw.pid) return null;
  let min = fin(raw.min, 0);
  let max = fin(raw.max, 1);
  if (!(max > min)) max = min + 1;
  return {
    id: String(raw.id || uid('auto')),
    mod: String(raw.mod ?? ''),
    tool: String(raw.tool),
    toolTitle: String(raw.toolTitle || raw.tool),
    pid: String(raw.pid),
    label: String(raw.label || raw.pid),
    min,
    max,
    step: fin(raw.step, 0) > 0 ? fin(raw.step) : 0,
    on: raw.on !== false,
    show: raw.show !== false,
    // where the slider writes: keys inside the voice (Glissando) or the studio document; null = drive the slider
    // 슬라이더가 쓰는 위치: 보이스(글리산도) 또는 스튜디오 문서 안의 키 경로; null = 슬라이더로 구동
    path: Array.isArray(raw.path) && raw.path.length ? raw.path.map(String) : null,
    nodes: normalizeNodes(raw.nodes, min, max),
  };
}

/** Value of a lane's nodes at time t (null without nodes). / t에서의 값 */
export function valueAt(nodes, t) {
  if (!nodes?.length) return null;
  if (t <= nodes[0].t) return nodes[0].v;
  for (let i = 1; i < nodes.length; i++) {
    const b = nodes[i];
    if (t <= b.t) {
      const a = nodes[i - 1];
      const span = b.t - a.t;
      if (span <= 1e-9) return b.v;
      return a.v + (b.v - a.v) * shape((t - a.t) / span, a.c);
    }
  }
  return nodes[nodes.length - 1].v;
}

/** Index of the segment [i, i + 1] that contains t, or -1. / t가 들어 있는 구간 */
export function segmentAt(nodes, t) {
  for (let i = 0; i < (nodes?.length || 0) - 1; i++) if (t >= nodes[i].t && t <= nodes[i + 1].t && nodes[i + 1].t > nodes[i].t) return i;
  return -1;
}

/** Snap a value to the parameter's step (from min). / 스텝에 맞추기 */
export function snap(v, lane) {
  const x = clamp(v, lane.min, lane.max);
  if (!(lane.step > 0)) return x;
  const n = Math.round((x - lane.min) / lane.step);
  return clamp(Number((lane.min + n * lane.step).toFixed(6)), lane.min, lane.max);
}

/** Numeric leaves that differ between two documents (at most `cap`). / 두 문서에서 달라진 숫자 값 */
export function diffLeaves(a, b, path = [], out = [], cap = 6) {
  if (out.length >= cap) return out;
  if (typeof a === 'number' || typeof b === 'number') {
    if (a !== b) out.push({ path, val: b });
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffLeaves(a[k], b[k], [...path, k], out, cap);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, val: b });
  return out;
}

/** Write v at a key path of obj (only when the path exists and holds a number). / 경로에 값 쓰기 */
export function setPath(obj, path, v) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) { o = o?.[path[i]]; if (!o || typeof o !== 'object') return false; }
  const k = path[path.length - 1];
  if (!o || typeof o[k] !== 'number') return false;
  o[k] = v;
  return true;
}

registerSelfCheck('Automation: segment curvature, handle round trip, hold past the ends, snapping', (a) => {
  const nodes = normalizeNodes([{ t: 2, v: 1 }, { t: 0, v: 0, c: 0 }, { t: 4, v: 1 }]);
  a.equal(nodes[0].t, 0, 'nodes sorted by time');
  a.near(valueAt(nodes, 1), 0.5, 1e-9, 'straight segment = linear');
  a.equal(valueAt(nodes, -1), 0, 'held before the first node');
  a.equal(valueAt(nodes, 9), 1, 'held after the last node');
  const curved = [{ t: 0, v: 0, c: 4 }, { t: 1, v: 10, c: 0 }];
  a.ok(valueAt(curved, 0.5) < 5, 'c > 0 bends the segment below the straight line');
  a.near(valueAt(curved, 0), 0, 1e-9, 'curved segment starts at v₀');
  a.near(valueAt(curved, 1), 10, 1e-9, 'curved segment ends at v₁');
  for (const c of [-8, -1.5, 0.7, 6]) a.near(curvatureOf(handleOf(c)), c, 1e-6, `handle ↔ curvature round trip (c = ${c})`);
  a.equal(segmentAt(nodes, 3), 1, 'segment lookup');
  a.equal(snap(0.237, { min: 0, max: 1, step: 0.05 }), 0.25, 'value snapped to the step');
  a.equal(normalizeLane({ tool: 'x' }), null, 'a lane needs a parameter');
  const d = diffLeaves({ p: { k: 2, s: 'a' }, n: 1 }, { p: { k: 3, s: 'a' }, n: 1 });
  a.equal(JSON.stringify(d), JSON.stringify([{ path: ['p', 'k'], val: 3 }]), 'probe finds the one changed number');
  const doc = { p: { k: 2 } };
  a.ok(setPath(doc, ['p', 'k'], 5) && doc.p.k === 5, 'write at a path');
  a.ok(!setPath(doc, ['p', 'zz', 'k'], 5), 'a missing path is not created');
});
