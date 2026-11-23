/**
 * Flexatone — core/math-utils.js
 * Layer 0 (core): pure numeric helpers. Zero DOM / Audio / app-state dependencies.
 * 계층 0 (core): 순수 수치 헬퍼. DOM·오디오·앱 상태 의존성 없음.
 *
 * Contents / 구성
 *   1. Scalar basics            clamp, lerp, invLerp, smoothstep, roundTo …
 *   2. Fritsch–Carlson          monotone cubic interpolation & evaluateTimeWarp
 *   3. Piecewise Bézier spline  evaluate · split (shape-preserving) · degree elevation
 *   4. Sampling / fitting       sampleFunctionToSplinePoints, fitStrokeToSpline, RDP
 *   5. Optimisation / analysis  nelderMead, analyzeTrajectoryFeatures,
 *                               analyzeAndFitCustomToEngine (custom ↔ formula inverse fit)
 *   6. ODE integration          rk4Step, integrateRK4, traceFieldRK4
 *
 * Spline point contract / 스플라인 점 규약
 *   { x: number∈[0,1], y: number, handles: Array<{ u: number∈(0,1), y: number }> }
 *   `handles` on point i are the inner Bézier control points of segment i → i+1,
 *   with `u` the fraction of the segment's x-span. 0 handles = straight line,
 *   1 = quadratic, 2 = cubic, n = degree n+1.
 *   점 i의 handles는 구간 i→i+1의 내부 베지에 제어점이며 u는 구간 x폭 대비 비율.
 */

// ==========================================================================
// 1. Scalar basics / 기본 스칼라 함수
// ==========================================================================

export const EPS = 1e-9;

export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

export function clamp01(val) {
  return clamp(val, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Inverse lerp: where `v` lies between a and b (unclamped). */
export function invLerp(a, b, v) {
  const d = b - a;
  return Math.abs(d) < EPS ? 0 : (v - a) / d;
}

export function smoothstep(edge0, edge1, x) {
  const s = clamp01(invLerp(edge0, edge1, x));
  return s * s * (3 - 2 * s);
}

export function roundTo(val, digits = 4) {
  const k = 10 ** digits;
  return Math.round(val * k) / k;
}

/** n+1 evenly spaced values from a to b inclusive. / a~b 균등 분할 */
export function linspace(a, b, n) {
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) out[i] = a + ((b - a) * i) / n;
  return out;
}

/** Root-mean-square error between two equal-length arrays. */
export function rmse(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/** Deterministic PRNG (mulberry32) → () => [0,1). / 결정적 난수 생성기 */
export function createSeededRandom(seed = 1) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short random id with prefix, e.g. uid('v_') → 'v_k3j9x2a'. */
export function uid(prefix = '', len = 7) {
  let s = '';
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return prefix + s.slice(0, len);
}

/** Structured deep clone for plain JSON-safe data. / JSON 호환 데이터 깊은 복사 */
export function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

// ==========================================================================
// 2. Fritsch–Carlson monotone cubic interpolation / 단조 3차 보간
// ==========================================================================

/**
 * Compute Fritsch–Carlson tangents guaranteeing monotonicity between knots.
 * 단조성을 보장하는 Fritsch–Carlson 접선 계산.
 * @param {number[]} xs strictly increasing
 * @param {number[]} ys
 * @returns {number[]} tangents m_i
 */
export function monotoneCubicTangents(xs, ys) {
  const n = xs.length;
  if (n < 2) return new Array(n).fill(0);
  const deltas = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    deltas[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  }
  const m = new Array(n).fill(0);
  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = deltas[i - 1] * deltas[i] <= 0 ? 0 : (deltas[i - 1] + deltas[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(deltas[i]) < 1e-8) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / deltas[i];
      const b = m[i + 1] / deltas[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * a * deltas[i];
        m[i + 1] = tau * b * deltas[i];
      }
    }
  }
  return m;
}

/** Evaluate a cubic Hermite spline with tangents `ms` at x (clamped to the knot range). */
export function evalMonotoneCubic(xs, ys, ms, x) {
  const n = xs.length;
  if (n === 0) return 0;
  if (n === 1 || x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  // Binary search for segment / 이진 탐색으로 구간 찾기
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const h = xs[hi] - xs[lo];
  const s = (x - xs[lo]) / Math.max(1e-6, h);
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * ys[lo] + h10 * h * ms[lo] + h01 * ys[hi] + h11 * h * ms[hi];
}

/** Build a reusable monotone interpolator fn(x). / 재사용 가능한 단조 보간 함수 생성 */
export function createMonotoneInterpolator(xs, ys) {
  const X = xs.slice();
  const Y = ys.slice();
  const M = monotoneCubicTangents(X, Y);
  return (x) => evalMonotoneCubic(X, Y, M, x);
}

const timeWarpCache = new Map();
const TIME_WARP_CACHE_MAX = 64;

/**
 * Monotone time-warp φ(t; x₁, x₂) used by the Harmonic S-Rotation engine.
 * Knots: (0,0) (x₁,¼) (½,½) (x₂,¾) (1,1); x₁∈[.05,.48], x₂∈[.52,.95].
 * 조화 S-회전 엔진용 단조 시간 왜곡 φ(t). φ(0)=0, φ(1)=1, 단조 증가.
 */
export function evaluateTimeWarp(t, x1 = 0.25, x2 = 0.75) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const a = clamp(x1, 0.05, 0.48);
  const b = clamp(x2, 0.52, 0.95);
  const key = `${a}|${b}`;
  let spline = timeWarpCache.get(key);
  if (!spline) {
    const xs = [0, a, 0.5, b, 1];
    const ys = [0, 0.25, 0.5, 0.75, 1];
    spline = { xs, ys, ms: monotoneCubicTangents(xs, ys) };
    if (timeWarpCache.size >= TIME_WARP_CACHE_MAX) {
      timeWarpCache.delete(timeWarpCache.keys().next().value);
    }
    timeWarpCache.set(key, spline);
  }
  return evalMonotoneCubic(spline.xs, spline.ys, spline.ms, t);
}

// ==========================================================================
// 3. Piecewise Bézier spline / 조각별 베지에 스플라인
// ==========================================================================

/** Linear spline [(0,y0) → (1,y1)]. / 기본 직선 스플라인 */
export function createLinearSplinePoints(y0 = 0, y1 = 1) {
  return [
    { x: 0, y: y0, handles: [] },
    { x: 1, y: y1, handles: [] },
  ];
}

/**
 * Sort by x and migrate legacy `{curve}` points to `handles` (in place).
 * x 기준 정렬, 구버전 curve 필드를 handles로 변환 (제자리 수정).
 */
export function normalizeSplinePoints(pts) {
  if (!Array.isArray(pts)) return pts;
  pts.sort((a, b) => a.x - b.x);
  for (let i = 0; i < pts.length; i++) {
    const pt = pts[i];
    if (!Array.isArray(pt.handles)) {
      pt.handles = [];
      if (typeof pt.curve === 'number' && Math.abs(pt.curve) > 1e-4 && i < pts.length - 1) {
        const p1 = pts[i + 1];
        pt.handles.push({ u: 0.5, y: 0.5 * (pt.y + p1.y) + pt.curve });
      }
    }
    delete pt.curve;
  }
  return pts;
}

/** Evaluate a 1-D Bézier with control values `vals` at parameter s∈[0,1] (de Casteljau). */
export function evalBezier1D(vals, s) {
  const n = vals.length;
  if (n === 0) return 0;
  if (n === 1) return vals[0];
  if (n === 2) return vals[0] + s * (vals[1] - vals[0]);
  if (n === 3) {
    const u = 1 - s;
    return u * u * vals[0] + 2 * u * s * vals[1] + s * s * vals[2];
  }
  if (n === 4) {
    const u = 1 - s;
    return u * u * u * vals[0] + 3 * u * u * s * vals[1] + 3 * u * s * s * vals[2] + s * s * s * vals[3];
  }
  const tmp = vals.slice();
  for (let r = 1; r < n; r++) {
    for (let i = 0; i < n - r; i++) tmp[i] = (1 - s) * tmp[i] + s * tmp[i + 1];
  }
  return tmp[0];
}

/** Segment control polygons in local coords: xs (0…1 fractions) and ys. */
export function getSegmentControlArrays(p0, p1) {
  const hs = Array.isArray(p0.handles) ? p0.handles : [];
  const xs = [0];
  const ys = [p0.y];
  for (const h of hs) {
    xs.push(clamp(Number(h.u) || 0.5, 0.005, 0.995));
    ys.push(Number(h.y) || 0);
  }
  xs.push(1);
  ys.push(p1.y);
  return { xs, ys };
}

/** Solve Bx(s) = tx by bisection (Bx is monotone because handle u's lie in (0,1)). */
export function solveSegmentParamS(xs, tx, iterations = 24) {
  if (tx <= 0) return 0;
  if (tx >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < iterations; i++) {
    const mid = 0.5 * (lo + hi);
    if (evalBezier1D(xs, mid) < tx) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** y on segment p0→p1 at local x-fraction tx∈[0,1]. */
export function evalSplineSegmentAtFrac(p0, p1, tx) {
  const hs = Array.isArray(p0.handles) ? p0.handles : [];
  if (!hs.length) return p0.y + tx * (p1.y - p0.y);
  const { xs, ys } = getSegmentControlArrays(p0, p1);
  return evalBezier1D(ys, solveSegmentParamS(xs, clamp01(tx)));
}

/** Index of the segment containing x (−1 if pts has < 2 points). */
export function findSplineSegmentIndex(pts, x) {
  if (!Array.isArray(pts) || pts.length < 2) return -1;
  if (x <= pts[0].x) return 0;
  const last = pts.length - 2;
  if (x >= pts[last + 1].x) return last;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].x <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Evaluate a piecewise Bézier spline at tNorm; holds end values outside the range. */
export function evalPiecewiseBezierPoints(pts, tNorm) {
  if (!Array.isArray(pts) || !pts.length) return tNorm;
  if (pts.length === 1) return pts[0].y;
  if (tNorm <= pts[0].x) return pts[0].y;
  if (tNorm >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  const i = findSplineSegmentIndex(pts, tNorm);
  const span = Math.max(1e-6, pts[i + 1].x - pts[i].x);
  return evalSplineSegmentAtFrac(pts[i], pts[i + 1], (tNorm - pts[i].x) / span);
}

/** de Casteljau subdivision of a 1-D control polygon at s → { left, right }. */
export function deCasteljauSplit1D(vals, s) {
  const n = vals.length;
  const left = [vals[0]];
  const right = new Array(n);
  right[n - 1] = vals[n - 1];
  let cur = vals.slice();
  for (let r = 1; r < n; r++) {
    const next = new Array(n - r);
    for (let i = 0; i < n - r; i++) next[i] = (1 - s) * cur[i] + s * cur[i + 1];
    left.push(next[0]);
    right[n - 1 - r] = next[next.length - 1];
    cur = next;
  }
  return { left, right };
}

/**
 * Insert a new anchor into segment `segIdx` at absolute x `targetX` without changing
 * the curve shape (exact de Casteljau split of both x and y polygons). Mutates `pts`.
 * 곡선 형태를 유지한 채 segIdx 구간의 targetX 위치에 새 기준점을 삽입 (pts 제자리 수정).
 * @returns {{x:number,y:number,handles:Array}|null} the inserted point
 */
export function splitSplineSegmentPreservingShape(pts, segIdx, targetX) {
  if (!Array.isArray(pts) || segIdx < 0 || segIdx >= pts.length - 1) return null;
  const p0 = pts[segIdx];
  const p1 = pts[segIdx + 1];
  const span = Math.max(1e-6, p1.x - p0.x);
  const tx = clamp((targetX - p0.x) / span, 0.01, 0.99);
  const hs = Array.isArray(p0.handles) ? p0.handles : [];

  if (!hs.length) {
    const newPt = { x: roundTo(p0.x + tx * span), y: roundTo(p0.y + tx * (p1.y - p0.y)), handles: [] };
    pts.splice(segIdx + 1, 0, newPt);
    return newPt;
  }

  const { xs, ys } = getSegmentControlArrays(p0, p1);
  const s = solveSegmentParamS(xs, tx);
  const splitX = deCasteljauSplit1D(xs, s);
  const splitY = deCasteljauSplit1D(ys, s);

  const midFrac = clamp(splitX.left[splitX.left.length - 1], 0.005, 0.995);
  const midY = splitY.left[splitY.left.length - 1];

  const leftHandles = [];
  for (let i = 1; i < splitX.left.length - 1; i++) {
    leftHandles.push({
      u: roundTo(clamp(splitX.left[i] / midFrac, 0.01, 0.99)),
      y: roundTo(splitY.left[i]),
    });
  }
  const rightSpan = Math.max(1e-6, 1 - midFrac);
  const rightHandles = [];
  for (let i = 1; i < splitX.right.length - 1; i++) {
    rightHandles.push({
      u: roundTo(clamp((splitX.right[i] - midFrac) / rightSpan, 0.01, 0.99)),
      y: roundTo(splitY.right[i]),
    });
  }

  p0.handles = leftHandles;
  const newPt = { x: roundTo(p0.x + midFrac * span), y: roundTo(midY), handles: rightHandles };
  pts.splice(segIdx + 1, 0, newPt);
  return newPt;
}

/**
 * Add one curvature handle to segment p0→p1 (mutates p0.handles).
 * 0 handles → place one on the straight line at clickU (shape unchanged).
 * n handles → exact Bézier degree elevation n+1 → n+2 (shape unchanged).
 * 구간에 곡률 핸들 1개 추가: 직선이면 clickU 위치에, 아니면 정확한 차수 상승 (형태 불변).
 * @returns {boolean} true if a handle was added
 */
export function elevateSplineSegmentHandles(p0, p1, clickU = 0.5, maxHandles = 6) {
  if (!Array.isArray(p0.handles)) p0.handles = [];
  if (p0.handles.length >= maxHandles) return false;
  if (p0.handles.length === 0) {
    const u = roundTo(clamp(clickU, 0.05, 0.95));
    p0.handles.push({ u, y: roundTo(p0.y + u * (p1.y - p0.y)) });
    return true;
  }
  const { xs, ys } = getSegmentControlArrays(p0, p1);
  const n = xs.length - 1; // current degree
  const newHandles = [];
  for (let i = 1; i <= n; i++) {
    const a = i / (n + 1);
    newHandles.push({
      u: roundTo(clamp(a * xs[i - 1] + (1 - a) * xs[i], 0.01, 0.99)),
      y: roundTo(a * ys[i - 1] + (1 - a) * ys[i]),
    });
  }
  p0.handles = newHandles;
  return true;
}

/** Remove the anchor at index (never the first/last). Returns true on success. */
export function removeSplinePoint(pts, index) {
  if (!Array.isArray(pts) || index <= 0 || index >= pts.length - 1) return false;
  pts.splice(index, 1);
  return true;
}

// ==========================================================================
// 4. Sampling & stroke fitting / 샘플링 및 스트로크 근사
// ==========================================================================

/** Sample fn on [0,1] → Float64Array of n+1 values (non-finite → NaN-safe fallback t). */
export function sampleFunction(fn, n = 128) {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = fn(t);
    out[i] = Number.isFinite(y) ? y : t;
  }
  return out;
}

/** Ramer–Douglas–Peucker polyline simplification. / RDP 폴리라인 단순화 */
export function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const a = points[0];
  const b = points[points.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy || 1e-9;
  let maxD = -1;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const tp = ((points[i].x - a.x) * dx + (points[i].y - a.y) * dy) / lenSq;
    const d = Math.hypot(points[i].x - (a.x + tp * dx), points[i].y - (a.y + tp * dy));
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > epsilon) {
    const left = rdpSimplify(points.slice(0, idx + 1), epsilon);
    const right = rdpSimplify(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/**
 * Convert any evaluator fn(t) into editable spline points: anchors at local extrema plus
 * an even grid (≤ maxAnchors), one quadratic handle per segment through the true midpoint.
 * 임의의 함수를 편집 가능한 스플라인으로 변환 (극값 + 균등 격자 기준점, 구간당 2차 핸들).
 */
export function sampleFunctionToSplinePoints(fn, opts = {}) {
  const { samples = 240, gridDivs = 8, maxAnchors = 16, minGap = 0.045 } = opts;
  const ys = sampleFunction(fn, samples);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const y of ys) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const ampSpan = Math.max(0.1, yMax - yMin);

  const anchors = [0, 1];
  for (let i = 2; i < samples - 1; i++) {
    const dPrev = ys[i] - ys[i - 1];
    const dNext = ys[i + 1] - ys[i];
    if ((dPrev > 0 && dNext <= 0) || (dPrev < 0 && dNext >= 0)) {
      const tc = i / samples;
      if (anchors.every((a) => Math.abs(a - tc) > minGap)) anchors.push(tc);
    }
  }
  for (let k = 1; k < gridDivs; k++) {
    const tk = k / gridDivs;
    if (anchors.every((a) => Math.abs(a - tk) > minGap * 1.2)) anchors.push(tk);
  }
  anchors.sort((a, b) => a - b);
  while (anchors.length > maxAnchors) {
    let best = Infinity;
    let drop = 1;
    for (let i = 1; i < anchors.length - 1; i++) {
      const gap = anchors[i + 1] - anchors[i - 1];
      if (gap < best) {
        best = gap;
        drop = i;
      }
    }
    anchors.splice(drop, 1);
  }

  const safe = (x) => {
    const y = fn(x);
    return Number.isFinite(y) ? y : x;
  };
  const pts = anchors.map((x) => ({ x: roundTo(x), y: roundTo(safe(x)), handles: [] }));
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const ym = safe(0.5 * (p0.x + p1.x));
    const yLin = 0.5 * (p0.y + p1.y);
    // Quadratic Bézier through midpoint: B(½) = ¼y0 + ½c + ¼y1 = ym → c = 2ym − yLin
    if (Math.abs(ym - yLin) > ampSpan * 0.004) p0.handles = [{ u: 0.5, y: roundTo(2 * ym - yLin) }];
  }
  return pts;
}

/**
 * Fit a raw freehand stroke [{x,y}] (normalized coords) to spline points.
 * 자유 그리기 스트로크를 스플라인 점으로 근사.
 * @returns {Array|null}
 */
export function fitStrokeToSpline(rawPts, opts = {}) {
  const { minDx = 0.008, epsilon = 0.035, curveThreshold = 0.015 } = opts;
  if (!Array.isArray(rawPts) || rawPts.length < 2) return null;
  const sorted = rawPts.slice().sort((a, b) => a.x - b.x);
  // Thin out samples closer than minDx, always keeping the first and last sample.
  // (Replacing instead of skipping would let dense strokes collapse to one point.)
  // minDx보다 가까운 샘플은 건너뛰되 첫/마지막 샘플은 항상 유지.
  const clean = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x - clean[clean.length - 1].x > minDx) clean.push(sorted[i]);
  }
  const lastRaw = sorted[sorted.length - 1];
  if (clean[clean.length - 1] !== lastRaw && lastRaw.x > clean[0].x) {
    if (clean.length > 1 && lastRaw.x - clean[clean.length - 1].x <= minDx) clean[clean.length - 1] = lastRaw;
    else clean.push(lastRaw);
  }
  if (clean.length < 2) return null;

  const simp = rdpSimplify(clean, epsilon).map((p) => ({ x: p.x, y: p.y }));
  if (simp[0].x > 0.02) simp.unshift({ x: 0, y: simp[0].y });
  else simp[0].x = 0;
  const last = simp[simp.length - 1];
  if (last.x < 0.98) simp.push({ x: 1, y: last.y });
  else last.x = 1;

  const out = simp.map((p) => ({ x: roundTo(clamp01(p.x)), y: roundTo(p.y), handles: [] }));
  for (let i = 0; i < out.length - 1; i++) {
    const p0 = out[i];
    const p1 = out[i + 1];
    const xm = 0.5 * (p0.x + p1.x);
    let best = null;
    let bestDx = Infinity;
    for (const r of clean) {
      const d = Math.abs(r.x - xm);
      if (d < bestDx) {
        bestDx = d;
        best = r;
      }
    }
    if (best) {
      const yLin = 0.5 * (p0.y + p1.y);
      if (Math.abs(best.y - yLin) > curveThreshold) p0.handles = [{ u: 0.5, y: roundTo(2 * best.y - yLin) }];
    }
  }
  return out;
}

// ==========================================================================
// 5. Optimisation & analysis / 최적화 및 분석
// ==========================================================================

/**
 * Nelder–Mead simplex minimiser.
 * @param {(x:number[]) => number} f
 * @param {number[]} x0
 * @param {{ step?: number|number[], maxIter?: number, tol?: number }} [opts]
 * @returns {{ x: number[], fx: number, iterations: number }}
 */
export function nelderMead(f, x0, opts = {}) {
  const { maxIter = 300, tol = 1e-8 } = opts;
  const n = x0.length;
  const steps = Array.isArray(opts.step) ? opts.step : new Array(n).fill(opts.step ?? 0.1);
  if (n === 0) return { x: [], fx: f([]), iterations: 0 };

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += steps[i] || 0.1;
    simplex.push(p);
  }
  let values = simplex.map(f);
  let iter = 0;

  for (; iter < maxIter; iter++) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) < tol) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const along = (k) => centroid.map((c, j) => c + k * (simplex[n][j] - c));

    const xr = along(-1);
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = along(-2);
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        values[n] = fe;
      } else {
        simplex[n] = xr;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr;
      values[n] = fr;
    } else {
      const xc = fr < values[n] ? along(-0.5) : along(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, values[n])) {
        simplex[n] = xc;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i;
  return { x: simplex[best], fx: values[best], iterations: iter };
}

/**
 * Shape features of a sampled trajectory (y over uniform t).
 * 궤적 특징 분석: 단조성, 역행, 극값 수, 오버슈트 등.
 * @param {ArrayLike<number>} ys
 */
export function analyzeTrajectoryFeatures(ys) {
  const n = ys.length;
  if (!n) return null;
  const start = ys[0];
  const end = ys[n - 1];
  let yMin = Infinity;
  let yMax = -Infinity;
  let extremaCount = 0;
  let prevSign = 0;
  for (let i = 0; i < n; i++) {
    if (ys[i] < yMin) yMin = ys[i];
    if (ys[i] > yMax) yMax = ys[i];
    if (i > 0) {
      const d = ys[i] - ys[i - 1];
      const sign = Math.abs(d) < 1e-9 ? 0 : Math.sign(d);
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) extremaCount++;
        prevSign = sign;
      }
    }
  }
  const direction = Math.sign(end - start); // +1 rising, −1 falling, 0 flat
  const hi = Math.max(start, end);
  const lo = Math.min(start, end);
  return {
    start,
    end,
    yMin,
    yMax,
    range: yMax - yMin,
    direction,
    extremaCount,
    monotonic: extremaCount === 0,
    hasRetrograde: direction !== 0 && extremaCount > 0,
    overshoot: Math.max(0, yMax - hi),
    undershoot: Math.max(0, lo - yMin),
  };
}

function resolveTargetSampler(target) {
  if (typeof target === 'function') return target;
  if (Array.isArray(target) && target.length && typeof target[0] === 'object') {
    return (t) => evalPiecewiseBezierPoints(target, t);
  }
  if (target && typeof target.length === 'number') {
    // Uniform samples → linear interpolation / 균등 샘플 → 선형 보간
    const arr = Array.from(target);
    const last = arr.length - 1;
    return (t) => {
      const f = clamp01(t) * last;
      const i = Math.min(last - 1, Math.floor(f));
      return lerp(arr[i], arr[i + 1], f - i);
    };
  }
  throw new TypeError('analyzeAndFitCustomToEngine: unsupported target');
}

function normalizeRange(spec) {
  if (Array.isArray(spec)) return { min: spec[0], max: spec[1], integer: !!spec[2] };
  return { min: spec.min, max: spec.max, integer: !!spec.integer };
}

/**
 * Inverse fit: find which formula engine (and parameters) best reproduces a custom
 * trajectory. Engine evaluators are injected, keeping core free of modules/ imports.
 * 역근사: 커스텀 궤적을 가장 잘 재현하는 수식 엔진·파라미터를 탐색.
 * 엔진 평가 함수는 주입받으므로 core가 modules/를 import하지 않음.
 *
 * @param {Function|Array|ArrayLike<number>} target  fn(t) | spline points | uniform samples
 * @param {Array<{
 *   id: string,
 *   evaluate: (t:number, params:object) => number,
 *   params: object,                                   // full initial params (non-fitted kept)
 *   fit: Record<string, [number, number, boolean?] | {min,max,integer?}>
 * }>} candidates
 * @param {{ samples?: number, maxIter?: number, restarts?: number, seed?: number }} [opts]
 * @returns {{ features: object, best: object|null, ranking: Array<{id, params, rmse, maxError}> }}
 */
export function analyzeAndFitCustomToEngine(target, candidates, opts = {}) {
  const { samples = 96, maxIter = 250, restarts = 3, seed = 7 } = opts;
  const targetFn = resolveTargetSampler(target);
  const ts = linspace(0, 1, samples);
  const ty = ts.map((t) => {
    const y = targetFn(t);
    return Number.isFinite(y) ? y : 0;
  });
  const features = analyzeTrajectoryFeatures(ty);
  const rand = createSeededRandom(seed);
  const ranking = [];

  for (const cand of candidates || []) {
    if (!cand || typeof cand.evaluate !== 'function') continue;
    const keys = Object.keys(cand.fit || {});
    const ranges = keys.map((k) => normalizeRange(cand.fit[k]));
    const base = { ...(cand.params || {}) };

    // Optimise in unit cube u∈[0,1]^n, mapped to [min,max] / 단위 큐브에서 최적화
    const decode = (u) => {
      const p = { ...base };
      keys.forEach((k, i) => {
        const r = ranges[i];
        let v = r.min + clamp01(u[i]) * (r.max - r.min);
        if (r.integer) v = Math.round(v);
        p[k] = v;
      });
      return p;
    };
    const errorOf = (params) => {
      let s = 0;
      for (let i = 0; i < ts.length; i++) {
        const y = cand.evaluate(ts[i], params);
        const d = (Number.isFinite(y) ? y : 1e3) - ty[i];
        s += d * d;
      }
      return Math.sqrt(s / ts.length);
    };
    const objective = (u) => {
      // Soft penalty outside the cube keeps the simplex inside / 범위 밖 패널티
      let pen = 0;
      for (const v of u) if (v < 0 || v > 1) pen += (v < 0 ? -v : v - 1) * 10;
      return errorOf(decode(u)) + pen;
    };

    const u0 = keys.map((k, i) => {
      const r = ranges[i];
      const v = Number.isFinite(base[k]) ? base[k] : 0.5 * (r.min + r.max);
      return clamp01(invLerp(r.min, r.max, v));
    });

    let bestU = u0;
    let bestF = objective(u0);
    if (keys.length) {
      const starts = [u0];
      for (let r = 1; r < restarts; r++) starts.push(keys.map(() => rand()));
      for (const s of starts) {
        const res = nelderMead(objective, s, { step: 0.15, maxIter });
        if (res.fx < bestF) {
          bestF = res.fx;
          bestU = res.x;
        }
      }
    }

    const params = decode(bestU);
    let maxError = 0;
    for (let i = 0; i < ts.length; i++) {
      maxError = Math.max(maxError, Math.abs(cand.evaluate(ts[i], params) - ty[i]));
    }
    ranking.push({ id: cand.id, params, rmse: errorOf(params), maxError });
  }

  ranking.sort((a, b) => a.rmse - b.rmse);
  return { features, best: ranking[0] || null, ranking };
}

// ==========================================================================
// 6. ODE integration (RK4) / 4차 룽게-쿠타 적분
// ==========================================================================

const addScaled = (y, k, h) => (typeof y === 'number' ? y + h * k : y.map((v, i) => v + h * k[i]));

/**
 * One classical RK4 step for dy/dt = f(t, y). `y` may be a number or number[].
 * 고전 RK4 1스텝. y는 스칼라 또는 배열.
 */
export function rk4Step(f, t, y, h) {
  const k1 = f(t, y);
  const k2 = f(t + h / 2, addScaled(y, k1, h / 2));
  const k3 = f(t + h / 2, addScaled(y, k2, h / 2));
  const k4 = f(t + h, addScaled(y, k3, h));
  if (typeof y === 'number') return y + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  return y.map((v, i) => v + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

/**
 * Integrate from t0 to t1 in fixed steps. Returns [{ t, y }] including the start.
 * @param {(t:number, y:number|number[]) => number|number[]} f
 * @param {number|number[]} y0
 * @param {{ t0?: number, t1?: number, steps?: number, stopWhen?: (t, y) => boolean }} [opts]
 */
export function integrateRK4(f, y0, opts = {}) {
  const { t0 = 0, t1 = 1, steps = 100, stopWhen } = opts;
  const h = (t1 - t0) / Math.max(1, steps);
  const out = [{ t: t0, y: y0 }];
  let t = t0;
  let y = y0;
  for (let i = 0; i < steps; i++) {
    y = rk4Step(f, t, y, h);
    t = t0 + (i + 1) * h;
    out.push({ t, y });
    if (stopWhen && stopWhen(t, y)) break;
  }
  return out;
}

/**
 * Trace a particle through a 2-D velocity field with RK4 (for vector-field studios).
 * 2D 벡터장에서 입자 경로를 RK4로 추적 (필드 스튜디오용).
 * @param {(x:number, y:number, t:number) => [number, number] | {vx:number, vy:number}} field
 * @param {{x:number, y:number}} seed
 * @param {{ h?: number, maxSteps?: number,
 *           bounds?: {xMin:number,xMax:number,yMin:number,yMax:number},
 *           minSpeed?: number }} [opts]
 * @returns {Array<{x:number, y:number, t:number}>}
 */
export function traceFieldRK4(field, seed, opts = {}) {
  const { h = 0.01, maxSteps = 2000, bounds = { xMin: 0, xMax: 1, yMin: -0.5, yMax: 1.5 }, minSpeed = 1e-7 } = opts;
  const vel = (t, p) => {
    const v = field(p[0], p[1], t);
    return Array.isArray(v) ? v : [v.vx, v.vy];
  };
  const pts = [{ x: seed.x, y: seed.y, t: 0 }];
  let p = [seed.x, seed.y];
  let t = 0;
  for (let i = 0; i < maxSteps; i++) {
    const v = vel(t, p);
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || Math.hypot(v[0], v[1]) < minSpeed) break;
    p = rk4Step(vel, t, p, h);
    t += h;
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) break;
    if (p[0] < bounds.xMin || p[0] > bounds.xMax || p[1] < bounds.yMin || p[1] > bounds.yMax) break;
    pts.push({ x: p[0], y: p[1], t });
  }
  return pts;
}
