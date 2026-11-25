/**
 * Flexatone — studios/space/space-views.js
 * Layer 2 (studios, pure): view mathematics of the Space scene — the three orthographic planes
 * (top XY, front XZ, side YZ), the orbit-camera perspective view, node / handle picking and the
 * edits a drag makes to a node spline. No DOM, no Web Audio (the canvases call these).
 * 계층 2 (studios, 순수): 장면 뷰 수학 — 정사영 세 평면(상단 XY·정면 XZ·측면 YZ), 궤도 카메라 원근 뷰,
 * 노드·핸들 피킹, 드래그가 노드 스플라인에 만드는 편집. DOM 없음.
 *
 * World: metres, +x east, +y north, +z up. Screen: +px right, +py down.
 *   top   : px ← x, py ← −y        front : px ← x, py ← −z        side : px ← y, py ← −z
 * Each orthographic view changes only the two world coordinates of its own plane.
 * 각 정사영 뷰는 자기 평면의 두 좌표만 바꿈.
 *
 * Imports: core/math-utils.js, modules/spline3d.js.
 */

import { clamp, roundTo, uid } from '../../core/math-utils.js';
import { buildSpline, effectiveHandles, insertSplineNode, splineTangents, SPLINE_MAX_NODES } from '../../modules/spline3d.js';

export const VIEW_PLANES = Object.freeze({ top: ['x', 'y'], front: ['x', 'z'], side: ['y', 'z'] });
export const VIEW_IDS = Object.freeze(['top', 'front', 'side', 'persp']);
const AX = { x: 0, y: 1, z: 2 };
const R = (v) => roundTo(v, 2);

/**
 * Orthographic view: world ↔ screen for one plane. `centre` = world point in the middle of the
 * canvas, `span` = metres across the canvas width.
 * 정사영 뷰: 한 평면의 세계 ↔ 화면 변환.
 */
export function orthoView(plane, w, h, centre, span) {
  const [a, b] = VIEW_PLANES[plane] || VIEW_PLANES.top;
  const k = w / Math.max(1, span);
  return {
    plane, a, b, k, w, h,
    toPx: (p) => ({ x: w / 2 + (p[a] - centre[a]) * k, y: h / 2 - (p[b] - centre[b]) * k }),
    fromPx: (px, py) => ({ [a]: centre[a] + (px - w / 2) / k, [b]: centre[b] - (py - h / 2) / k }),
  };
}

/**
 * Perspective view from an orbit camera (azimuth / elevation in degrees around `centre`).
 * project(p) → { x, y, depth } (depth grows away from the camera). / 궤도 카메라 원근 투영
 */
export function perspView(w, h, centre, span, cam = {}) {
  const az = (Number(cam.az) || 0) * Math.PI / 180;
  const elv = clamp(Number(cam.el) || 0, -89, 89) * Math.PI / 180;
  const zoom = clamp(Number(cam.dist) || 1, 0.2, 8);
  const k = (w / Math.max(1, span)) / zoom;
  const eye = 2.2 * span * zoom; // camera distance in metres / 카메라 거리
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(elv), se = Math.sin(elv);
  const project = (p) => {
    const x = p.x - centre.x;
    const y = p.y - centre.y;
    const z = (p.z || 0) - centre.z;
    // yaw around z, then tilt: right = (ca, −sa, 0), forward (into the screen) = (sa·ce, ca·ce, −se), up = (sa·se, ca·se, ce)
    const rx = x * ca - y * sa;
    const fy = x * sa + y * ca;
    const depth = fy * ce - z * se;
    const up = fy * se + z * ce;
    const s = eye / Math.max(0.05 * eye, eye + depth);
    return { x: w / 2 + rx * k * s, y: h / 2 - up * k * s, depth, scale: s };
  };
  return { plane: 'persp', k, w, h, project, toPx: project };
}

/** Nodes of a spline path in world coordinates (2-D splines sit at height h). / 세계 좌표 노드 */
export function worldNodes(path) {
  const sp = path?.spline || {};
  const is3 = sp.dims === '3d';
  const h = Number(path?.h) || 0;
  return (sp.nodes || []).map((n) => ({ ...n, z: is3 ? Number(n.z) || 0 : h }));
}

/** Is the spline geometrically closed? / 기하적으로 닫혔는가 */
export const splineClosed = (sp) => !!sp?.closed || sp?.end === 'loop';

/** Handle end points of node i in world coordinates. / 노드 i의 핸들 끝점 (세계 좌표) */
export function handlePoints(nodes, closed, i) {
  const n = nodes[i];
  const { hin, hout } = effectiveHandles(nodes, closed, i);
  return {
    in: { x: n.x + hin[0], y: n.y + hin[1], z: n.z + hin[2] },
    out: { x: n.x + hout[0], y: n.y + hout[1], z: n.z + hout[2] },
  };
}

/** Index of the node under (px, py), or −1. / 화면 좌표 아래의 노드 */
export function hitNode(nodes, view, px, py, tol = 9) {
  let best = -1;
  let bd = tol;
  nodes.forEach((n, i) => {
    const q = view.toPx(n);
    const d = Math.hypot(q.x - px, q.y - py);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Handle of node i under (px, py): 'in' | 'out' | null. / 화면 좌표 아래의 핸들 */
export function hitHandle(nodes, closed, i, view, px, py, tol = 8) {
  if (i < 0 || i >= nodes.length) return null;
  const hp = handlePoints(nodes, closed, i);
  for (const side of ['out', 'in']) {
    const q = view.toPx(hp[side]);
    if (Math.hypot(q.x - px, q.y - py) < tol && Math.hypot(hp[side].x - nodes[i].x, hp[side].y - nodes[i].y, hp[side].z - nodes[i].z) > 1e-6) return side;
  }
  return null;
}

/**
 * Closest point of the curve to (px, py) on screen → { seg, f, dist }.
 * 화면에서 곡선 위 가장 가까운 점.
 */
export function nearestOnSpline(nodes, closed, view, px, py, perSeg = 48) {
  const spl = buildSpline(nodes, { closed, chords: 16 });
  let best = { seg: -1, f: 0, dist: Infinity };
  if (!spl.segs) return best;
  for (let s = 0; s < spl.segs; s++) {
    for (let k = 0; k <= perSeg; k++) {
      const f = k / perSeg;
      const q = view.toPx(spl.P((s + f) / spl.segs));
      const d = Math.hypot(q.x - px, q.y - py);
      if (d < best.dist) best = { seg: s, f, dist: d };
    }
  }
  return best;
}

// ==========================================================================
// Edits (mutate a spline draft: path.spline) / 편집 (스플라인 초안을 직접 수정)
// ==========================================================================

/** Move node `id` to (va, vb) on the plane of `view`. 2-D splines ignore z. / 노드 이동 */
export function moveNode(sp, id, plane, va, vb) {
  const n = sp.nodes.find((x) => x.id === id);
  if (!n) return false;
  const [a, b] = VIEW_PLANES[plane] || VIEW_PLANES.top;
  for (const [k, v] of [[a, va], [b, vb]]) {
    if (k === 'z' && sp.dims !== '3d') continue;
    n[k] = R(v);
  }
  return true;
}

/** Move several nodes by a world offset on the plane. / 여러 노드를 평면 위 변위만큼 이동 */
export function offsetNodes(sp, ids, plane, da, db, origin) {
  const [a, b] = VIEW_PLANES[plane] || VIEW_PLANES.top;
  for (const n of sp.nodes) {
    if (!ids.includes(n.id)) continue;
    const o = origin[n.id];
    if (!o) continue;
    if (!(a === 'z' && sp.dims !== '3d')) n[a] = R(o[a] + da);
    if (!(b === 'z' && sp.dims !== '3d')) n[b] = R(o[b] + db);
  }
}

/**
 * Drag a handle of node `id` to a world point on the plane. The node becomes 'free'; the opposite
 * handle is mirrored in direction (its own length is kept) unless `broken`.
 * 핸들 드래그: 노드는 free가 되고, 반대쪽 핸들은 방향만 대칭(길이 유지). broken이면 독립.
 */
export function moveHandle(sp, id, side, plane, va, vb, { broken = false } = {}) {
  const i = sp.nodes.findIndex((x) => x.id === id);
  if (i < 0) return false;
  const closed = splineClosed(sp);
  const world = worldNodesOf(sp);
  const n = sp.nodes[i];
  if (n.tangent !== 'free') {
    const eff = effectiveHandles(world, closed, i);
    n.tangent = 'free';
    n.hin = eff.hin.map(R);
    n.hout = eff.hout.map(R);
  }
  const [a, b] = VIEW_PLANES[plane] || VIEW_PLANES.top;
  const key = side === 'in' ? 'hin' : 'hout';
  const other = side === 'in' ? 'hout' : 'hin';
  const h = n[key].slice();
  h[AX[a]] = R(va - n[a]);
  if (!(b === 'z' && sp.dims !== '3d')) h[AX[b]] = R(vb - (b === 'z' ? world[i].z : n[b]));
  if (sp.dims !== '3d') h[2] = 0;
  n[key] = h;
  if (!broken) {
    const len = Math.hypot(...n[other]);
    const hl = Math.hypot(...h) || 1;
    n[other] = h.map((v) => R((-v / hl) * len));
  }
  return true;
}

const worldNodesOf = (sp) => (sp.nodes || []).map((n) => ({ ...n, z: sp.dims === '3d' ? Number(n.z) || 0 : 0 }));

/** Insert a node on the curve (shape kept). Returns the new node id or null. / 곡선 위에 노드 삽입 */
export function insertNode(sp, seg, f) {
  if (sp.nodes.length >= SPLINE_MAX_NODES) return null;
  const id = uid('n_', 5);
  const closed = splineClosed(sp);
  const out = insertSplineNode(worldNodesOf(sp), closed, seg, f, id);
  if (out.length === sp.nodes.length) return null;
  sp.nodes = out.map((n) => ({ ...n, x: R(n.x), y: R(n.y), z: sp.dims === '3d' ? R(n.z) : 0, hin: n.hin.map(R), hout: n.hout.map(R) }));
  return id;
}

/** Append a node after the last one (open curves) at a world point. / 끝에 노드 추가 */
export function appendNode(sp, pt) {
  if (sp.nodes.length >= SPLINE_MAX_NODES) return null;
  const id = uid('n_', 5);
  sp.nodes.push({ id, x: R(pt.x || 0), y: R(pt.y || 0), z: sp.dims === '3d' ? R(pt.z || 0) : 0, curv: 1, tangent: 'auto', hin: [0, 0, 0], hout: [0, 0, 0] });
  return id;
}

/** Delete nodes (at least two stay). Returns how many were removed. / 노드 삭제 (최소 2개 유지) */
export function deleteNodes(sp, ids) {
  let removed = 0;
  for (const id of ids) {
    if (sp.nodes.length <= 2) break;
    const i = sp.nodes.findIndex((n) => n.id === id);
    if (i < 0) continue;
    sp.nodes.splice(i, 1);
    removed++;
  }
  return removed;
}

/** Back to automatic tangents. / 자동 접선으로 되돌림 */
export function resetHandles(sp, ids) {
  for (const n of sp.nodes) if (ids.includes(n.id)) { n.tangent = 'auto'; n.hin = [0, 0, 0]; n.hout = [0, 0, 0]; }
}

/** Switch 2-D ⇄ 3-D. Going 3-D lifts every node to the path height h. / 2D ⇄ 3D 전환 */
export function setSplineDims(path, dims) {
  const sp = path.spline;
  if (dims === '3d' && sp.dims !== '3d') { const h = Number(path.h) || 0; for (const n of sp.nodes) n.z = R(h); }
  if (dims !== '3d') for (const n of sp.nodes) { n.z = 0; n.hin = [n.hin[0], n.hin[1], 0]; n.hout = [n.hout[0], n.hout[1], 0]; }
  sp.dims = dims === '3d' ? '3d' : '2d';
}

/**
 * A z edit on a 2-D spline (path at the constant height h) would be dropped, so the spline is
 * lifted to 3-D first (every node at h) when the new z differs from h. Returns true if lifted.
 * 2D 스플라인에서 z를 바꾸면 버려지므로, h와 다르면 먼저 3D로 승격 (모든 노드 z = h).
 */
export function liftForZ(path, z) {
  const sp = path?.spline;
  if (!sp || sp.dims === '3d' || !Number.isFinite(z)) return false;
  if (Math.abs(z - (Number(path.h) || 0)) < 1e-6) return false;
  setSplineDims(path, '3d');
  return true;
}

/** Bounding box of points. / 경계 상자 */
export function boundsOf(points) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const p of points) {
    b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x);
    b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y);
    b.z0 = Math.min(b.z0, p.z || 0); b.z1 = Math.max(b.z1, p.z || 0);
  }
  return b;
}

/** Tangent directions used for drawing (unit vectors of the out tangents). / 그리기용 접선 방향 */
export function nodeTangents(nodes, closed) {
  return splineTangents(nodes, closed).tout.map((m) => { const l = Math.hypot(...m) || 1; return m.map((v) => v / l); });
}
