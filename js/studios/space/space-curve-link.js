/**
 * Flexatone — studios/space/space-curve-link.js
 * Layer 2 (studios, pure): **curve links** — a curve of another studio used as the 3-D path of a
 * Space source. The second kind of Send next to the pitch-line Sends of studios/trajectory-link.js:
 * same instance binding, same loop rule, a signature that keeps the copy in step with its origin.
 * 계층 2 (studios, 순수): **곡선 링크** — 다른 스튜디오의 곡선을 스페이스 음원의 3D 경로로. 음고 선
 * 보내기(trajectory-link.js)에 이은 두 번째 종류: 같은 인스턴스 바인딩·루프 규칙·시그니처.
 *
 * Sources / 원본
 *   registerSpaceCurveSource(studio, { curves(doc) → [{ key, name, pts: [{ x, y, z, t? }] }] })
 *     real space curves (Chaos: the phase-space trajectory of every voice).
 *   Every studio that offers pitch lines to Send (trajectory-link.js) also offers them here as
 *     flat curves: x = time (s), y = pitch (MIDI), z = 0 — key `line:<key>`.
 *
 * Link (stored in the source: `path.link`, the path type stays 'spline') / 링크
 *   { studio, inst, key, name, map, range: [from, to], time: 'shape' | 'pinned', maxNodes, sig, err, n, status }
 *   range = the part of the origin that is used (fractions of its points, default the whole curve);
 *           the scale and the centre are always those of the WHOLE curve, so moving the range does
 *           not move or resize what stays. A long attractor needs a short range to fit 64 nodes.
 *   range = 원본에서 쓰는 구간(점 개수의 비율, 기본 전체). 배율·중심은 항상 전체 곡선 기준.
 *   map = { axes: [ax, ay, az], fit: 'uniform' | 'box' | 'none', size, unit, cx, cy, cz, yaw }
 *     axes[i] = which component of the origin feeds x / y / z of the room: 'x' | 'y' | 'z' | 't' | '0',
 *               with a leading '-' to flip it.
 *     fit 'uniform' → the bounding box fits a sphere of diameter `size` (one scale for all axes),
 *         'box'     → every axis is scaled to `size` on its own (time × pitch has no common unit),
 *         'none'    → `unit` metres per unit of the origin.
 *   Transform (the Transform toolbox, 0.54.0; identity by default) / 변형 (기본 = 항등):
 *     rx, ry = rotation about the room x / y axes (°; yaw above = about z), sx, sy, sz = stretch of the
 *     shape's own axes (× after the fit), keep = the stretches move together (proportions kept),
 *     flip = [x, y, z] mirror of the shape's own axes, rev = the path is travelled backwards.
 *     room point = c + Rz(yaw)·Ry(ry)·Rx(rx)·flip(stretch(fit · (q − mid)))
 *   The mapped curve is simplified (RDP, ≤ maxNodes nodes) into spline nodes; `err` = the largest
 *   distance (m) between the mapped curve and the spline.
 *
 * Loop rule: a studio that receives a pitch line from Space (directly or through other studios)
 * cannot give Space its path — Space's line is the HEARD pitch, which depends on the path.
 * 루프 규칙: 스페이스의 음고 선을 (직접·간접으로) 받는 스튜디오는 스페이스에 경로를 줄 수 없음.
 *
 * Imports: core/*, modules/spline3d.js, studios/trajectory-link.js.
 */

import { clamp } from '../../core/math-utils.js';
import { getFocusedId } from '../../core/manager-state.js';
import { buildSpline, SPLINE_MAX_NODES } from '../../modules/spline3d.js';
import { sourceDoc, listSourceLines, listSendSources, buildSendPlan } from '../trajectory-link.js';

export const CURVE_FITS = Object.freeze(['uniform', 'box', 'none']);
export const CURVE_TIMES = Object.freeze(['shape', 'pinned']);
export const CURVE_AXES = Object.freeze(['x', 'y', 'z', 't', '0', '-x', '-y', '-z', '-t']);
export const CURVE_NODE_COUNTS = Object.freeze([16, 32, SPLINE_MAX_NODES]);
export const LINE_PREFIX = 'line:';
const MAX_INPUT = 2400; // points kept of the origin before simplifying / 단순화 전 원본 점 수 상한
const SELF = 'space';

const providers = new Map(); // studio → { curves(doc) }
const fin = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const r3 = (x) => Math.round(x * 1e3) / 1e3;

/** Register a studio that has real space curves. / 공간 곡선을 가진 스튜디오 등록 */
export function registerSpaceCurveSource(studio, provider) {
  if (provider) providers.set(studio, provider);
  else providers.delete(studio); // null removes it (tests) / null이면 제거 (테스트)
}

/** Studios whose curves can become a path (space curves first). / 경로로 쓸 수 있는 스튜디오 */
export function listCurveStudios() {
  const out = [...providers.keys()];
  for (const s of listSendSources()) if (!out.includes(s)) out.push(s);
  return out.filter((s) => s !== SELF);
}

/**
 * Curves of a studio (instance `inst`, or its editor document): [{ key, name, kind: '3d' | 'line', pts }].
 * 스튜디오의 곡선 목록 (인스턴스 또는 에디터 문서).
 */
export function listCurves(studio, inst = null) {
  if (!studio || studio === SELF) return [];
  const out = [];
  const p = providers.get(studio);
  if (p) {
    try {
      for (const c of p.curves(sourceDoc(studio, inst)) || []) {
        const pts = (c?.pts || []).filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y) && Number.isFinite(q?.z));
        if (c?.key != null && pts.length >= 2) out.push({ key: String(c.key), name: String(c.name ?? c.key), kind: '3d', pts });
      }
    } catch (err) {
      console.error(`[Flexatone] space curve source ${studio} failed:`, err);
    }
  }
  for (const l of listSourceLines(studio, inst)) {
    const pts = l.pts.filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m)).map((q) => ({ x: q.t, y: q.m, z: 0, t: q.t }));
    if (pts.length >= 2) out.push({ key: `${LINE_PREFIX}${l.key}`, name: String(l.name ?? l.key), kind: 'line', pts });
  }
  return out;
}

/** Default mapping: a 60 m sphere around `centre` (space curves) or a 60 × 60 m sheet (pitch lines). */
export function defaultCurveMap(kind = '3d', centre = { x: 0, y: 0, z: 0 }) {
  return {
    axes: kind === 'line' ? ['x', 'y', '0'] : ['x', 'y', 'z'],
    fit: kind === 'line' ? 'box' : 'uniform',
    size: 60,
    unit: 1,
    cx: r3(fin(centre.x)), cy: r3(fin(centre.y)), cz: r3(fin(centre.z)),
    yaw: 0,
    ...CURVE_XF_IDENTITY, flip: [false, false, false],
  };
}

/** The transform part of a mapping at rest (the toolbox's Reset). / 변형의 항등값 (툴박스의 초기화) */
export const CURVE_XF_IDENTITY = Object.freeze({ rx: 0, ry: 0, sx: 1, sy: 1, sz: 1, keep: true, rev: false });
export const STRETCH_MIN = 0.05;
export const STRETCH_MAX = 20;

/** Back to no transform; fit, axes and centre stay (mutates `map`). / 변형만 초기화 (맞춤·축·중심은 유지) */
export function resetCurveXf(map) {
  Object.assign(map, CURVE_XF_IDENTITY, { yaw: 0, flip: [false, false, false] });
  return map;
}

/**
 * Set the stretch of one axis (mutates `map`). With `map.keep` the other two follow by the same
 * factor, so the proportions stay; each clamps to [STRETCH_MIN, STRETCH_MAX] and the factor is
 * limited so that none of them clips (the ratio really stays).
 * 한 축의 늘이기 (map 변경). keep이면 나머지 두 축도 같은 배수로 따라가며, 어느 축도 한계에 걸리지 않도록 배수를 제한.
 */
export function setCurveStretch(map, axis, value) {
  const keys = ['sx', 'sy', 'sz'];
  const k = keys[axis];
  if (!k) return map;
  const cur = [0, 1, 2].map((i) => clamp(fin(map[keys[i]], 1), STRETCH_MIN, STRETCH_MAX));
  const v = clamp(fin(value, 1), STRETCH_MIN, STRETCH_MAX);
  if (map.keep === false) { map[k] = r3(v); return map; }
  let f = v / cur[axis];
  const hi = Math.min(...cur.map((c) => STRETCH_MAX / c));
  const lo = Math.max(...cur.map((c) => STRETCH_MIN / c));
  f = clamp(f, lo, hi);
  for (let i = 0; i < 3; i++) map[keys[i]] = Math.round(cur[i] * f * 1e4) / 1e4;
  return map;
}

/** Fill / clamp a mapping (new object). / 매핑 보정 */
export function normalizeCurveMap(raw, kind = '3d') {
  const d = defaultCurveMap(kind);
  const src = raw && typeof raw === 'object' ? raw : {};
  const axes = [0, 1, 2].map((i) => (CURVE_AXES.includes(src.axes?.[i]) ? src.axes[i] : d.axes[i]));
  return {
    axes,
    fit: CURVE_FITS.includes(src.fit) ? src.fit : d.fit,
    size: clamp(fin(src.size, d.size), 0.5, 1000),
    unit: clamp(fin(src.unit, 1), 1e-4, 1e4),
    cx: clamp(fin(src.cx, d.cx), -1000, 1000),
    cy: clamp(fin(src.cy, d.cy), -1000, 1000),
    cz: clamp(fin(src.cz, d.cz), -1000, 1000),
    yaw: clamp(fin(src.yaw, 0), -360, 360),
    rx: clamp(fin(src.rx, 0), -360, 360),
    ry: clamp(fin(src.ry, 0), -360, 360),
    sx: clamp(fin(src.sx, 1), STRETCH_MIN, STRETCH_MAX),
    sy: clamp(fin(src.sy, 1), STRETCH_MIN, STRETCH_MAX),
    sz: clamp(fin(src.sz, 1), STRETCH_MIN, STRETCH_MAX),
    keep: src.keep !== false,
    flip: [0, 1, 2].map((i) => !!src.flip?.[i]),
    rev: !!src.rev,
  };
}

/** Does the mapping carry a transform (anything but the identity)? / 변형이 있는가 */
export function curveXfActive(rawMap) {
  const m = normalizeCurveMap(rawMap);
  return m.yaw !== 0 || m.rx !== 0 || m.ry !== 0 || m.sx !== 1 || m.sy !== 1 || m.sz !== 1 || m.flip.some(Boolean) || m.rev;
}

/** [from, to] fractions of the origin, at least 1 % apart. / 원본 구간 (최소 1 %) */
export function normalizeRange(raw) {
  let a = clamp(fin(raw?.[0], 0), 0, 0.99);
  let b = clamp(fin(raw?.[1], 1), 0.01, 1);
  if (b - a < 0.01) { if (a + 0.01 <= 1) b = a + 0.01; else a = b - 0.01; }
  return [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4];
}

/** Fill / clamp a link (new object), or null. / 링크 보정 */
export function normalizeCurveLink(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.studio !== 'string' || raw.key == null) return null;
  const kind = String(raw.key).startsWith(LINE_PREFIX) ? 'line' : '3d';
  return {
    studio: raw.studio,
    inst: typeof raw.inst === 'string' && raw.inst ? raw.inst : null,
    key: String(raw.key),
    name: String(raw.name ?? ''),
    map: normalizeCurveMap(raw.map, kind),
    range: normalizeRange(raw.range),
    time: CURVE_TIMES.includes(raw.time) ? raw.time : 'shape',
    maxNodes: clamp(Math.round(fin(raw.maxNodes, SPLINE_MAX_NODES)), 4, SPLINE_MAX_NODES),
    sig: typeof raw.sig === 'string' ? raw.sig : '',
    err: fin(raw.err, 0),
    n: Math.round(fin(raw.n, 0)),
    status: typeof raw.status === 'string' ? raw.status : '',
  };
}

const comp = (p, a) => {
  const neg = a[0] === '-';
  const k = neg ? a.slice(1) : a;
  const v = k === '0' ? 0 : fin(p[k], 0);
  return neg ? -v : v;
};

/** Evenly thin a point list to at most `max` points (ends kept). / 점 목록 솎기 */
function thin(pts, max = MAX_INPUT) {
  if (pts.length <= max) return pts;
  const out = [];
  for (let i = 0; i < max; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (max - 1))]);
  return out;
}

/**
 * Origin coordinates → metres in the room: [{ x, y, z, t? }]. / 원본 좌표 → 방의 m 좌표
 * `scale` is returned on the array (`out.scale = [kx, ky, kz]`) for the read-out and the round trip.
 */
export function mapCurve(pts, rawMap, kind = '3d', { ref = null } = {}) {
  const map = normalizeCurveMap(rawMap, kind);
  const src = thin(pts || []);
  const pick = (p) => [comp(p, map.axes[0]), comp(p, map.axes[1]), comp(p, map.axes[2])];
  const raw = src.map(pick);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  // `ref` = the whole curve when `pts` is a part of it: scale and centre come from the whole / 전체 곡선 기준의 배율·중심
  for (const q of ref ? thin(ref).map(pick) : raw) for (let i = 0; i < 3; i++) { if (q[i] < lo[i]) lo[i] = q[i]; if (q[i] > hi[i]) hi[i] = q[i]; }
  const span = [0, 1, 2].map((i) => (raw.length ? hi[i] - lo[i] : 0));
  const mid = [0, 1, 2].map((i) => (raw.length ? 0.5 * (lo[i] + hi[i]) : 0));
  let k;
  if (map.fit === 'none') k = [map.unit, map.unit, map.unit];
  else if (map.fit === 'box') k = span.map((s) => (s > 1e-9 ? map.size / s : 0));
  else { const diag = Math.hypot(span[0], span[1], span[2]); const u = diag > 1e-9 ? map.size / diag : 0; k = [u, u, u]; }
  const yaw = (map.yaw * Math.PI) / 180;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Transform toolbox: stretch + mirror of the shape's own axes, then Rx · Ry before the yaw / 변형: 늘이기·거울 → Rx·Ry → 요
  const g = [map.sx * (map.flip[0] ? -1 : 1), map.sy * (map.flip[1] ? -1 : 1), map.sz * (map.flip[2] ? -1 : 1)];
  const ax = (map.rx * Math.PI) / 180;
  const ay = (map.ry * Math.PI) / 180;
  const cX = Math.cos(ax), sX = Math.sin(ax), cY = Math.cos(ay), sY = Math.sin(ay);
  const tilt = map.rx !== 0 || map.ry !== 0;
  const out = raw.map((q, i) => {
    let x = (q[0] - mid[0]) * k[0] * g[0];
    let y = (q[1] - mid[1]) * k[1] * g[1];
    let z = (q[2] - mid[2]) * k[2] * g[2];
    if (tilt) {
      const y1 = y * cX - z * sX; const z1 = y * sX + z * cX; // about x / x축
      const x2 = x * cY + z1 * sY; const z2 = -x * sY + z1 * cY; // about y / y축
      x = x2; y = y1; z = z2;
    }
    const o = { x: map.cx + x * c - y * s, y: map.cy + x * s + y * c, z: map.cz + z };
    if (Number.isFinite(src[i].t)) o.t = src[i].t;
    return o;
  });
  out.scale = k;
  out.mid = mid;
  return out;
}

const segDist = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  const f = l2 > 1e-18 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + f * dx), p.y - (a.y + f * dy), p.z - (a.z + f * dz));
};

/** Indices kept by Ramer–Douglas–Peucker in 3-D (iterative). / 3D RDP가 남기는 인덱스 */
function rdpIndices(pts, eps) {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) { const d = segDist(pts[i], pts[a], pts[b]); if (d > worst) { worst = d; at = i; } }
    if (at >= 0 && worst > eps) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * Simplify a mapped curve into spline nodes (auto tangents) with at most `maxNodes` nodes.
 * @returns {{ nodes, err, dims, eps, idx }} err = largest distance curve ↔ spline (m)
 * 매핑된 곡선 → 스플라인 노드 (최대 maxNodes개). err = 곡선과 스플라인의 최대 거리 (m).
 */
export function curveToNodes(pts, { maxNodes = SPLINE_MAX_NODES, tol = null, pin = false } = {}) {
  const P = thin(pts || []);
  if (P.length < 2) return { nodes: [], err: 0, dims: '2d', eps: 0, idx: [] };
  const cap = clamp(Math.round(maxNodes), 2, SPLINE_MAX_NODES);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const q of P) { lo = [Math.min(lo[0], q.x), Math.min(lo[1], q.y), Math.min(lo[2], q.z)]; hi = [Math.max(hi[0], q.x), Math.max(hi[1], q.y), Math.max(hi[2], q.z)]; }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let eps = tol ?? Math.max(1e-6, diag / 2000);
  let idx = rdpIndices(P, eps);
  if (idx.length > cap) {
    // the smallest tolerance that fits the node budget (bisection on a monotone count) / 노드 예산에 맞는 최소 허용 오차
    let a = eps;
    let b = Math.max(eps * 2, diag);
    for (let i = 0; i < 24; i++) {
      const m = Math.sqrt(a * b);
      if (rdpIndices(P, m).length > cap) a = m; else b = m;
    }
    eps = b;
    idx = rdpIndices(P, eps);
  }
  const dims = hi[2] - lo[2] > 1e-6 ? '3d' : '2d';
  const t0 = Number.isFinite(P[0].t) ? P[0].t : NaN;
  const nodes = idx.map((i, k) => {
    const n = { id: `k${k + 1}`, x: r3(P[i].x), y: r3(P[i].y), z: r3(P[i].z), curv: 1, tangent: 'auto', hin: [0, 0, 0], hout: [0, 0, 0] };
    if (pin && Number.isFinite(t0) && Number.isFinite(P[i].t)) n.t = r3(P[i].t - t0);
    return n;
  });
  if (pin) for (let k = 1; k < nodes.length; k++) if (!(nodes[k].t > nodes[k - 1].t)) { for (const n of nodes) delete n.t; break; } // pins must rise / 시각은 증가해야 함
  // error: every origin point against the chords of ITS spline segment / 오차: 각 원본 점 ↔ 해당 구간의 현
  const sp = buildSpline(nodes, { closed: false, chords: 32 });
  const segs = Math.max(1, nodes.length - 1);
  const C = 12;
  let err = 0;
  for (let k = 0; k < segs; k++) {
    const chord = [];
    for (let j = 0; j <= C; j++) chord.push(sp.P((k + j / C) / segs));
    for (let i = idx[k]; i <= idx[k + 1]; i++) {
      let best = Infinity;
      for (let j = 0; j < C; j++) best = Math.min(best, segDist(P[i], chord[j], chord[j + 1]));
      if (best > err) err = best;
    }
  }
  return { nodes, err, dims, eps, idx };
}

function hashText(str) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Does the origin studio receive Space's pitch line (directly or not)? / 원본이 스페이스의 선을 받는가 */
export function curveLinkLoops(studio, plan = buildSendPlan()) {
  const adj = new Map();
  for (const e of plan.edges) if (e.status === 'ok' || e.status === 'away') { if (!adj.has(e.from)) adj.set(e.from, new Set()); adj.get(e.from).add(e.to); }
  const seen = new Set();
  const stack = [SELF];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    for (const y of adj.get(x) || []) { if (y === studio) return true; stack.push(y); }
  }
  return false;
}

/**
 * Evaluate a link now: its origin curve mapped and simplified.
 * @returns {{ status: 'ok' | 'missing' | 'loop', sig, nodes?, err?, dims?, n?, dur?, name? }}
 * 링크 평가: 원본 곡선을 매핑·단순화.
 */
export function resolveCurveLink(rawLink, { curves = null, plan = undefined } = {}) {
  const link = normalizeCurveLink(rawLink);
  if (!link) return { status: 'missing', sig: '' };
  if (link.studio === SELF || curveLinkLoops(link.studio, plan)) return { status: 'loop', sig: 'loop' };
  const curve = (curves || listCurves(link.studio, link.inst)).find((c) => c.key === link.key);
  if (!curve) return { status: 'missing', sig: 'missing' };
  const whole = thin(curve.pts);
  const full = link.range[0] <= 0 && link.range[1] >= 1;
  const i0 = Math.round(link.range[0] * (curve.pts.length - 1));
  const i1 = Math.max(i0 + 1, Math.round(link.range[1] * (curve.pts.length - 1)));
  const P0 = full ? whole : thin(curve.pts.slice(i0, i1 + 1));
  // Reverse: travelled backwards; times mirrored so that they still rise / 역방향: 시각도 뒤집어 증가하게
  const P = link.map.rev ? P0.map((p, i, arr) => { const q = arr[arr.length - 1 - i]; const o = { ...q }; if (Number.isFinite(q.t) && Number.isFinite(arr[0].t) && Number.isFinite(arr[arr.length - 1].t)) o.t = arr[0].t + arr[arr.length - 1].t - q.t; return o; }) : P0;
  const sig = hashText(`${JSON.stringify([link.map, link.time, link.maxNodes, link.range, full ? 0 : [whole.length, whole[0], whole[whole.length >> 1], whole[whole.length - 1]]])}|${P.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${Number.isFinite(p.t) ? p.t.toFixed(3) : ''}`).join(';')}`);
  if (sig === link.sig && link.status === 'ok') return { status: 'ok', sig, same: true, name: curve.name };
  const mapped = mapCurve(P, link.map, curve.kind, { ref: full ? null : whole });
  const pin = link.time === 'pinned' && P.every((p) => Number.isFinite(p.t));
  const res = curveToNodes(mapped, { maxNodes: link.maxNodes, pin });
  const pinned = pin && res.nodes.length >= 2 && res.nodes.every((n) => Number.isFinite(n.t));
  return { status: 'ok', sig, nodes: res.nodes, err: res.err, dims: res.dims, n: res.nodes.length, dur: pinned ? res.nodes[res.nodes.length - 1].t : NaN, pinned, name: curve.name, scale: mapped.scale };
}

/** A new link to a curve of `studio` (bound to the instance in its editor). / 새 링크 */
export function createCurveLink(studio, curve, centre = { x: 0, y: 0, z: 0 }) {
  return normalizeCurveLink({ studio, inst: getFocusedId(studio) || null, key: curve.key, name: curve.name, map: defaultCurveMap(curve.kind, centre), time: 'shape' });
}

/**
 * Write a resolved link into a source (mutates `src`): nodes, dimensions, the receive record and —
 * with pinned times — the time mode and the duration. Returns true when something was written.
 * 평가 결과를 음원에 기록 (노드·차원·기록, 시각 고정이면 시간 모드와 지속시간).
 */
export function applyCurveLink(src, res) {
  const link = normalizeCurveLink(src?.path?.link);
  if (!link) return false;
  if (res.status !== 'ok') {
    if (link.status === res.status) return false;
    src.path.link = { ...link, status: res.status }; // the nodes it had stay / 있던 노드는 그대로
    return true;
  }
  if (res.same) return false;
  src.path.type = 'spline';
  src.path.spline = { ...(src.path.spline || {}), dims: res.dims, closed: false, end: src.path.spline?.end === 'pingpong' ? 'pingpong' : 'stop', nodes: res.nodes };
  if (res.pinned) { src.timeMode = 'pinned'; src.duration = clamp(r3(res.dur), 0.1, 300); }
  else if (src.timeMode === 'pinned') src.timeMode = 'speed'; // the pins are gone / 핀이 없어졌으므로
  src.path.link = { ...link, name: res.name || link.name, sig: res.sig, err: r3(res.err), n: res.n, status: 'ok' };
  return true;
}

/**
 * Bring every linked source of a document up to date (mutates `doc`). Returns the ids written.
 * 문서의 모든 링크 음원을 최신으로 (doc 변경). 기록한 음원 id 반환.
 */
export function updateCurveLinks(doc) {
  const done = [];
  let plan;
  const curvesOf = curveCache();
  for (const s of doc?.sources || []) {
    if (!s.path?.link || s.path.type !== 'spline') continue;
    plan = plan || buildSendPlan();
    if (applyCurveLink(s, resolveCurveLink(s.path.link, { plan, curves: curvesOf(s.path.link) }))) done.push(s.id);
  }
  return done;
}

/** One read of every origin per pass (several sources may share one). / 한 번의 패스에서 원본은 한 번만 읽음 */
function curveCache() {
  const seen = new Map();
  return (link) => {
    const k = `${link.studio}|${link.inst || ''}`;
    if (!seen.has(k)) seen.set(k, link.studio === SELF ? [] : listCurves(link.studio, typeof link.inst === 'string' && link.inst ? link.inst : null));
    return seen.get(k);
  };
}

/** Would `updateCurveLinks` write anything? (No mutation.) / 갱신할 것이 있는가 */
export function curveLinksStale(doc) {
  let plan;
  const curvesOf = curveCache();
  for (const s of doc?.sources || []) {
    const link = s.path?.link;
    if (!link || s.path.type !== 'spline') continue;
    plan = plan || buildSendPlan();
    const res = resolveCurveLink(link, { plan, curves: curvesOf(link) });
    if (res.status !== 'ok' ? link.status !== res.status : !res.same) return true;
  }
  return false;
}
