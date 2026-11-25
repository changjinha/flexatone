/**
 * Flexatone — modules/spline3d.js
 * Layer 1 (modules, pure): 3-D node splines — cubic Hermite segments between nodes that each
 * carry a position and a tangent rule, with an arc-length table. No DOM, no audio.
 * 계층 1 (modules, 순수): 3D 노드 스플라인 — 노드마다 위치와 접선 규칙을 가진 큐빅 Hermite 구간 + 호 길이 표.
 *
 * Node / 노드
 *   { x, y, z, curv = 1, tangent: 'auto' | 'free', hin: [dx, dy, dz], hout: [dx, dy, dz] }
 *   auto: tangent m = curv · (P[i+1] − P[i−1]) / 2 (Catmull–Rom; one-sided at the ends of an open
 *         curve). curv 1 = standard, 0 = corner (straight segments meet at the node), > 1 = bulges.
 *   free: Bézier handles relative to the node — hout is the outgoing control point, hin the
 *         incoming one (it normally points backwards). Tangents: out = 3·hout, in = −3·hin.
 *   Segment i (node i → i+1) = Hermite(P_i, out_i, P_{i+1}, in_{i+1}) = Bézier(P_i, P_i + hout_i,
 *   P_{i+1} + hin_{i+1}, P_{i+1}). With auto nodes in = out, so the curve is C1 there.
 *   자동: Catmull–Rom 접선 × curv. 자유: 노드 기준 베지에 핸들 (hout = 나가는 쪽, hin = 들어오는 쪽).
 *
 * Parameter / 매개변수: u ∈ [0, 1] over the whole curve, segment = floor(u · segs).
 * Used by the Space Studio paths (sources now, the listener later); written without any studio
 * dependency so other studios can adopt it. / 스페이스 스튜디오 경로용이지만 스튜디오 의존 없음.
 *
 * Imports: core/math-utils.js, core/state.js (self-check registration only).
 */

import { clamp } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';

export const SPLINE_CHORDS = 256; // chords per segment in the arc-length table / 구간당 현 개수
export const SPLINE_MAX_NODES = 64;
export const CURV_MIN = 0;
export const CURV_MAX = 2;

const n3 = (v, i) => (Array.isArray(v) && Number.isFinite(Number(v[i])) ? Number(v[i]) : 0);
const fin = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** A node with every field present. / 모든 필드를 가진 노드 */
export function createSplineNode(x = 0, y = 0, z = 0, over = {}) {
  return { id: over.id || '', x, y, z, curv: 1, tangent: 'auto', hin: [0, 0, 0], hout: [0, 0, 0], ...over };
}

/** Fill / clamp the fields of a node list (new array, ids kept or made from the index). */
export function normalizeSplineNodes(nodes, { idPrefix = 'n' } = {}) {
  const list = Array.isArray(nodes) ? nodes.slice(0, SPLINE_MAX_NODES) : [];
  const seen = new Set();
  return list.map((n, i) => {
    let id = typeof n?.id === 'string' && n.id && !seen.has(n.id) ? n.id : `${idPrefix}${i + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    const out = {
      id,
      x: fin(n?.x), y: fin(n?.y), z: fin(n?.z),
      curv: clamp(fin(n?.curv, 1), CURV_MIN, CURV_MAX),
      tangent: n?.tangent === 'free' ? 'free' : 'auto',
      hin: [n3(n?.hin, 0), n3(n?.hin, 1), n3(n?.hin, 2)],
      hout: [n3(n?.hout, 0), n3(n?.hout, 1), n3(n?.hout, 2)],
    };
    if (Number.isFinite(Number(n?.t))) out.t = Number(n.t); // optional time pin (timeline) / 시각 고정 (타임라인)
    return out;
  });
}

/**
 * Tangents (derivative with respect to the local segment parameter) of every node.
 * @returns {{ tin: number[][], tout: number[][] }}
 */
export function splineTangents(nodes, closed = false) {
  const n = nodes.length;
  const tin = [];
  const tout = [];
  for (let i = 0; i < n; i++) {
    const p = nodes[i];
    if (p.tangent === 'free') {
      tin.push([-3 * n3(p.hin, 0), -3 * n3(p.hin, 1), -3 * n3(p.hin, 2)]);
      tout.push([3 * n3(p.hout, 0), 3 * n3(p.hout, 1), 3 * n3(p.hout, 2)]);
      continue;
    }
    const a = closed ? nodes[(i - 1 + n) % n] : nodes[Math.max(0, i - 1)];
    const b = closed ? nodes[(i + 1) % n] : nodes[Math.min(n - 1, i + 1)];
    // one-sided difference at the ends of an open curve / 열린 곡선의 끝은 한쪽 차분
    const k = (!closed && (i === 0 || i === n - 1) ? 1 : 0.5) * fin(p.curv, 1);
    const m = [k * (b.x - a.x), k * (b.y - a.y), k * (b.z - a.z)];
    tin.push(m);
    tout.push(m);
  }
  return { tin, tout };
}

/** Bézier handles actually in effect at a node (auto nodes: derived). / 실제 적용되는 핸들 */
export function effectiveHandles(nodes, closed, i) {
  const { tin, tout } = splineTangents(nodes, closed);
  return { hin: tin[i].map((v) => -v / 3), hout: tout[i].map((v) => v / 3) };
}

/**
 * Build the evaluators of a node spline.
 * @returns {{ segs, closed, len, P(u), D(u), sAt(u), uAt(s), nodeS: number[], cum: Float64Array }}
 *   P → {x, y, z}; D → dP/du {x, y, z}; sAt / uAt convert between u and arc length (metres).
 */
export function buildSpline(rawNodes, { closed = false, chords = SPLINE_CHORDS } = {}) {
  const nodes = rawNodes || [];
  const n = nodes.length;
  const segs = n < 2 ? 0 : closed ? n : n - 1;
  if (!segs) {
    const p = nodes[0] || { x: 0, y: 0, z: 0 };
    const pt = { x: fin(p.x), y: fin(p.y), z: fin(p.z) };
    return { segs: 0, closed: false, len: 0, P: () => ({ ...pt }), D: () => ({ x: 0, y: 0, z: 0 }), sAt: () => 0, uAt: () => 0, nodeS: [0], cum: new Float64Array(1) };
  }
  const { tin, tout } = splineTangents(nodes, closed);
  const X = nodes.map((p) => [fin(p.x), fin(p.y), fin(p.z)]);
  const at = (u) => {
    const s = clamp(u, 0, 1) * segs;
    const i = Math.min(segs - 1, Math.floor(s));
    return [i, s - i];
  };
  const P = (u) => {
    const [i, f] = at(u);
    const j = (i + 1) % n;
    const f2 = f * f;
    const f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1;
    const h10 = f3 - 2 * f2 + f;
    const h01 = -2 * f3 + 3 * f2;
    const h11 = f3 - f2;
    const a = X[i];
    const b = X[j];
    const m0 = tout[i];
    const m1 = tin[j];
    return {
      x: h00 * a[0] + h10 * m0[0] + h01 * b[0] + h11 * m1[0],
      y: h00 * a[1] + h10 * m0[1] + h01 * b[1] + h11 * m1[1],
      z: h00 * a[2] + h10 * m0[2] + h01 * b[2] + h11 * m1[2],
    };
  };
  const D = (u) => {
    const [i, f] = at(u);
    const j = (i + 1) % n;
    const f2 = f * f;
    const d00 = 6 * f2 - 6 * f;
    const d10 = 3 * f2 - 4 * f + 1;
    const d01 = -6 * f2 + 6 * f;
    const d11 = 3 * f2 - 2 * f;
    const a = X[i];
    const b = X[j];
    const m0 = tout[i];
    const m1 = tin[j];
    return {
      x: segs * (d00 * a[0] + d10 * m0[0] + d01 * b[0] + d11 * m1[0]),
      y: segs * (d00 * a[1] + d10 * m0[1] + d01 * b[1] + d11 * m1[1]),
      z: segs * (d00 * a[2] + d10 * m0[2] + d01 * b[2] + d11 * m1[2]),
    };
  };
  // Arc-length table / 호 길이 표
  const N = segs * Math.max(8, Math.floor(chords));
  const cum = new Float64Array(N + 1);
  let prev = P(0);
  for (let k = 1; k <= N; k++) {
    const q = P(k / N);
    cum[k] = cum[k - 1] + Math.sqrt((q.x - prev.x) ** 2 + (q.y - prev.y) ** 2 + (q.z - prev.z) ** 2);
    prev = q;
  }
  const len = cum[N];
  const sAt = (u) => {
    const s = clamp(u, 0, 1) * N;
    const i = Math.min(N - 1, Math.floor(s));
    return cum[i] + (cum[i + 1] - cum[i]) * (s - i);
  };
  const uAt = (S) => {
    if (S <= 0) return 0;
    if (S >= len) return 1;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= S) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    return (lo + (span > 0 ? (S - cum[lo]) / span : 0)) / N;
  };
  const per = N / segs;
  const nodeS = [];
  for (let i = 0; i <= segs; i++) nodeS.push(cum[Math.round(i * per)]);
  return { segs, closed, len, P, D, sAt, uAt, nodeS, cum };
}

/**
 * Insert a node inside segment `seg` at local fraction f without changing the curve (exact
 * de Casteljau split). The two neighbours and the new node become 'free'. Returns a new array.
 * 곡선 모양을 바꾸지 않고 seg 구간의 f 위치에 노드 삽입 (양옆 노드와 새 노드는 free가 됨).
 */
export function insertSplineNode(nodes, closed, seg, f, id = '') {
  const n = nodes.length;
  const segs = closed ? n : n - 1;
  if (n < 2 || seg < 0 || seg >= segs || n >= SPLINE_MAX_NODES) return nodes.map((p) => ({ ...p }));
  const s = clamp(f, 0.02, 0.98);
  const i = seg;
  const j = (seg + 1) % n;
  const { tin, tout } = splineTangents(nodes, closed);
  const out = nodes.map((p, k) => {
    // freeze the effective handles of the nodes we touch / 건드리는 노드의 현재 핸들을 고정
    if (k !== i && k !== j) return { ...p };
    return { ...p, tangent: 'free', hin: tin[k].map((v) => -v / 3), hout: tout[k].map((v) => v / 3) };
  });
  const A = [nodes[i].x, nodes[i].y, nodes[i].z];
  const B = [nodes[j].x, nodes[j].y, nodes[j].z];
  const c0 = A;
  const c1 = A.map((v, d) => v + out[i].hout[d]);
  const c2 = B.map((v, d) => v + out[j].hin[d]);
  const c3 = B;
  const L = (a, b) => a.map((v, d) => v + (b[d] - v) * s);
  const q0 = L(c0, c1);
  const q1 = L(c1, c2);
  const q2 = L(c2, c3);
  const r0 = L(q0, q1);
  const r1 = L(q1, q2);
  const m = L(r0, r1);
  // Each half is re-parametrised over [0, 1], so its handles are the split control points as they are.
  out[i].hout = q0.map((v, d) => v - A[d]);
  out[j].hin = q2.map((v, d) => v - B[d]);
  const node = { id, x: m[0], y: m[1], z: m[2], curv: 1, tangent: 'free', hin: r0.map((v, d) => v - m[d]), hout: r1.map((v, d) => v - m[d]) };
  out.splice(i + 1, 0, node);
  return out;
}

/** Nodes of a straight polyline through `pts` (auto tangents). / 점 배열 → 자동 접선 노드 */
export function nodesFromPoints(pts, over = {}) {
  return (pts || []).map((p, i) => createSplineNode(fin(p.x), fin(p.y), fin(p.z), { id: `n${i + 1}`, ...over }));
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('spline3d: lengths, C1 at auto nodes, corners, arc-length inverse, shape-preserving insert', (a) => {
  const line = buildSpline(nodesFromPoints([{ x: -150, y: 5, z: 0 }, { x: 150, y: 5, z: 0 }]));
  a.near(line.len, 300, 1e-9, 'two-node spline = straight line');
  const mid = line.P(0.5);
  a.ok(Math.abs(mid.x) < 1e-9 && Math.abs(mid.y - 5) < 1e-12, 'uniform parameter on a straight line');
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 30, y: 20, z: 5 }, { x: 60, y: -10, z: 12 }, { x: 100, y: 15, z: 3 }, { x: 140, y: 0, z: 0 }];
  const nodes = nodesFromPoints(pts);
  const sp = buildSpline(nodes);
  const dir = (d) => { const l = Math.hypot(d.x, d.y, d.z) || 1; return [d.x / l, d.y / l, d.z / l]; };
  let worst = 0;
  for (let i = 1; i < 4; i++) {
    const u = i / 4;
    const d0 = dir(sp.D(u - 1e-9));
    const d1 = dir(sp.D(u + 1e-9));
    worst = Math.max(worst, Math.acos(clamp(d0[0] * d1[0] + d0[1] * d1[1] + d0[2] * d1[2], -1, 1)));
  }
  a.ok(worst < 1e-6, `tangent direction continuous at auto nodes (${worst.toExponential(1)} rad)`);
  const corner = nodes.map((p, i) => (i === 2 ? { ...p, curv: 0 } : p));
  const cs = buildSpline(corner);
  const e0 = dir({ x: cs.P(0.5).x - cs.P(0.5 - 1e-4).x, y: cs.P(0.5).y - cs.P(0.5 - 1e-4).y, z: cs.P(0.5).z - cs.P(0.5 - 1e-4).z });
  const e1 = dir({ x: cs.P(0.5 + 1e-4).x - cs.P(0.5).x, y: cs.P(0.5 + 1e-4).y - cs.P(0.5).y, z: cs.P(0.5 + 1e-4).z - cs.P(0.5).z });
  a.ok(Math.acos(clamp(e0[0] * e1[0] + e0[1] * e1[1] + e0[2] * e1[2], -1, 1)) > 0.2, 'curv = 0 makes a corner');
  let inv = 0;
  for (let k = 0; k <= 50; k++) { const u = k / 50; inv = Math.max(inv, Math.abs(sp.uAt(sp.sAt(u)) - u)); }
  a.ok(inv < 1e-6, `u(s(u)) = u (${inv.toExponential(1)})`);
  a.near(sp.nodeS[sp.nodeS.length - 1], sp.len, 1e-9, 'last node at the full length');
  // Shape-preserving insert / 모양 보존 삽입
  const ins = insertSplineNode(nodes, false, 1, 0.37, 'new');
  a.equal(ins.length, nodes.length + 1, 'one node added');
  const sp2 = buildSpline(ins);
  let dev = 0;
  for (let k = 0; k <= 200; k++) {
    const S = (k / 200) * sp.len;
    const p = sp.P(sp.uAt(S));
    const q = sp2.P(sp2.uAt(S));
    dev = Math.max(dev, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  a.near(sp2.len, sp.len, 1e-3, 'length unchanged by the insert');
  a.ok(dev < 2e-3, `curve unchanged by the insert (${dev.toExponential(1)} m at equal arc length)`);
  const p0 = sp.P((1 + 0.37) / 4);
  a.ok(Math.hypot(p0.x - ins[2].x, p0.y - ins[2].y, p0.z - ins[2].z) < 1e-9, 'new node lies on the old curve');
  // Closed curve / 닫힌 곡선
  const ring = [];
  for (let i = 0; i < 16; i++) ring.push({ x: 20 * Math.cos((i / 16) * 2 * Math.PI), y: 20 * Math.sin((i / 16) * 2 * Math.PI), z: 0 });
  const rs = buildSpline(nodesFromPoints(ring), { closed: true });
  const s0 = rs.P(0);
  const s1 = rs.P(1);
  a.ok(Math.hypot(s0.x - s1.x, s0.y - s1.y) < 1e-9, 'closed curve: start = end');
  a.ok(Math.abs(rs.len / (2 * Math.PI * 20) - 1) < 0.005, `16-node ring ≈ circle (${rs.len.toFixed(3)} m)`);
  const norm = normalizeSplineNodes([{ x: 1 }, { x: 2, id: 'n1', curv: 9, tangent: 'free', hout: [1, 'x', 3] }]);
  a.ok(norm[0].id !== norm[1].id && norm[1].curv === CURV_MAX && norm[1].hout[1] === 0, 'normalize: unique ids, clamped curvature, numeric handles');
}, { group: 'module' });
