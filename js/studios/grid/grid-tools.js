/**
 * Flexatone — studios/grid/grid-tools.js
 * Grid Studio (pure): raster painting operations on a Float32 raster (rows × cols, values 0..1).
 * 그리드 스튜디오 (순수): Float32 래스터(행 × 열, 0..1)에 대한 칠하기 연산.
 *
 * Coordinates / 좌표: continuous "cell space" — x ∈ [0, cols) is time (column c covers [c, c + 1)),
 * y ∈ [0, rows) is pitch (row r covers [r, r + 1), row 0 = lowest pitch). Cell centres are at
 * (c + 0.5, r + 0.5). Index = r · cols + c. No DOM, no audio: the canvases call these on a working
 * copy, the presets and the self-checks call them directly.
 * 셀 공간 좌표: x = 시간(열), y = 음고(행, 0 = 가장 낮은 음). DOM·오디오 없음.
 *
 * Painting model (one stroke) / 한 번의 획:
 *   coverage  cov[i] ∈ [0, 1] accumulated by the stamps: cov ← cov + (1 − cov)·α   (flow)
 *   result    out[i] = base[i] + (target − base[i]) · cov[i] · opacity · selection[i]
 */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Brush fall-off: 1 inside `hardness`, smooth to 0 at d = 1. / 브러시 감쇠 */
export function brushFalloff(d, hardness) {
  if (d >= 1) return 0;
  if (d <= hardness) return 1;
  const u = (d - hardness) / Math.max(1e-6, 1 - hardness);
  return 1 - u * u * (3 - 2 * u);
}

/**
 * One brush stamp into the coverage buffer. `ry` defaults to `rx` (round in cell space).
 * 브러시 한 번 찍기 (커버리지 버퍼에 누적).
 */
export function stampBrush(cov, rows, cols, cx, cy, rx, { ry = rx, hardness = 0.6, flow = 1, shape = 'round' } = {}) {
  const c0 = Math.max(0, Math.floor(cx - rx));
  const c1 = Math.min(cols - 1, Math.ceil(cx + rx));
  const r0 = Math.max(0, Math.floor(cy - ry));
  const r1 = Math.min(rows - 1, Math.ceil(cy + ry));
  for (let r = r0; r <= r1; r++) {
    const dy = (r + 0.5 - cy) / Math.max(0.5, ry);
    for (let c = c0; c <= c1; c++) {
      const dx = (c + 0.5 - cx) / Math.max(0.5, rx);
      const d = shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      const a = flow * brushFalloff(d, hardness);
      if (a <= 0) continue;
      const j = r * cols + c;
      cov[j] += (1 - cov[j]) * a;
    }
  }
}

/** Stamps along a segment, spaced a quarter of the radius. / 선분을 따라 찍기 */
export function strokeSegment(cov, rows, cols, x0, y0, x1, y1, rx, opts = {}) {
  const ry = opts.ry ?? rx;
  const step = Math.max(0.25, Math.min(rx, ry) * 0.25);
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
  // flow per stamp is thinned so a slow and a fast drag build up alike / 간격에 맞춰 흐름 보정
  const flow = 1 - Math.pow(1 - clamp(opts.flow ?? 1, 0, 1), Math.min(1, step / Math.max(0.5, Math.min(rx, ry))) * 2);
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    stampBrush(cov, rows, cols, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, rx, { ...opts, ry, flow: opts.flow >= 1 ? 1 : flow });
  }
}

/** Mirror a coverage buffer in time and / or pitch (symmetry option): cov ← max(cov, mirrored). / 대칭 */
export function mirrorCoverage(cov, rows, cols, { time = false, pitch = false } = {}) {
  if (!time && !pitch) return cov;
  const src = Float32Array.from(cov);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let v = src[r * cols + c];
      if (time) v = Math.max(v, src[r * cols + (cols - 1 - c)]);
      if (pitch) v = Math.max(v, src[(rows - 1 - r) * cols + c]);
      if (time && pitch) v = Math.max(v, src[(rows - 1 - r) * cols + (cols - 1 - c)]);
      cov[r * cols + c] = v;
    }
  }
  return cov;
}

/** out = base + (target − base)·cov·opacity·sel. `target` is a number or a Float32Array. / 합성 */
export function compositeStroke(base, out, cov, target, opacity = 1, sel = null) {
  const arr = typeof target !== 'number';
  for (let i = 0; i < base.length; i++) {
    const a = cov[i] * opacity * (sel ? sel[i] : 1);
    if (a <= 0) { out[i] = base[i]; continue; }
    const tv = arr ? target[i] : target;
    out[i] = clamp(base[i] + (tv - base[i]) * Math.min(1, a), 0, 1);
  }
  return out;
}

/** Coverage of an axis-aligned rectangle (fractional edges). / 사각형 커버리지 */
export function rectCoverage(rows, cols, x0, y0, x1, y1) {
  const cov = new Float32Array(rows * cols);
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  for (let r = Math.max(0, Math.floor(ya)); r < Math.min(rows, Math.ceil(yb)); r++) {
    const wy = Math.min(yb, r + 1) - Math.max(ya, r);
    for (let c = Math.max(0, Math.floor(xa)); c < Math.min(cols, Math.ceil(xb)); c++) {
      const wx = Math.min(xb, c + 1) - Math.max(xa, c);
      // a cell that is at least half covered counts as inside (crisp cells) / 절반 이상 덮인 셀
      cov[r * cols + c] = wx * wy >= 0.25 ? 1 : 0;
    }
  }
  return cov;
}

/** Coverage of the ellipse inscribed in the rectangle (3 × 3 supersampling). / 타원 커버리지 */
export function ellipseCoverage(rows, cols, x0, y0, x1, y1) {
  const cov = new Float32Array(rows * cols);
  const cx = 0.5 * (x0 + x1);
  const cy = 0.5 * (y0 + y1);
  const rx = Math.max(0.5, Math.abs(x1 - x0) / 2);
  const ry = Math.max(0.5, Math.abs(y1 - y0) / 2);
  for (let r = Math.max(0, Math.floor(cy - ry)); r < Math.min(rows, Math.ceil(cy + ry)); r++) {
    for (let c = Math.max(0, Math.floor(cx - rx)); c < Math.min(cols, Math.ceil(cx + rx)); c++) {
      let hit = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const dx = (c + (sx + 0.5) / 3 - cx) / rx;
          const dy = (r + (sy + 0.5) / 3 - cy) / ry;
          if (dx * dx + dy * dy <= 1) hit++;
        }
      }
      cov[r * cols + c] = hit / 9;
    }
  }
  return cov;
}

/** Coverage of a closed polygon [[x, y], …] (even–odd, sampled at cell centres). / 올가미 커버리지 */
export function polygonCoverage(rows, cols, pts) {
  const cov = new Float32Array(rows * cols);
  const n = pts.length;
  if (n < 3) return cov;
  const xs = [];
  for (let r = 0; r < rows; r++) {
    const y = r + 0.5;
    xs.length = 0;
    for (let k = 0; k < n; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[(k + 1) % n];
      if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const c1 = Math.min(cols - 1, Math.floor(xs[k + 1] - 0.5));
      for (let c = c0; c <= c1; c++) cov[r * cols + c] = 1;
    }
  }
  return cov;
}

/** Soften a coverage buffer (two box passes ≈ triangle of radius `radius` cells). / 페더 */
export function featherCoverage(cov, rows, cols, radius) {
  const h = Math.round(radius);
  if (h < 1) return cov;
  const tmp = new Float32Array(cov.length);
  const pass = (src, dst, horizontal) => {
    const len = horizontal ? cols : rows;
    const lines = horizontal ? rows : cols;
    const stride = horizontal ? 1 : cols;
    for (let l = 0; l < lines; l++) {
      const off = horizontal ? l * cols : l;
      let acc = 0;
      for (let i = 0; i < Math.min(h, len); i++) acc += src[off + i * stride];
      for (let i = 0; i < len; i++) {
        if (i + h < len) acc += src[off + (i + h) * stride];
        if (i - h - 1 >= 0) acc -= src[off + (i - h - 1) * stride];
        dst[off + i * stride] = acc / (2 * h + 1);
      }
    }
  };
  pass(cov, tmp, true);
  pass(tmp, cov, false);
  for (let i = 0; i < cov.length; i++) cov[i] = clamp(cov[i], 0, 1);
  return cov;
}

/** Flood fill from cell (c, r): cells whose value is within `threshold` of the seed (4-neighbours). / 버킷 */
export function floodCoverage(src, rows, cols, c, r, threshold = 0.1) {
  const cov = new Float32Array(rows * cols);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return cov;
  const v0 = src[r * cols + c];
  const stack = [r * cols + c];
  cov[r * cols + c] = 1;
  while (stack.length) {
    const j = stack.pop();
    const cc = j % cols;
    const rr = (j - cc) / cols;
    const push = (k) => { if (!cov[k] && Math.abs(src[k] - v0) <= threshold) { cov[k] = 1; stack.push(k); } };
    if (cc > 0) push(j - 1);
    if (cc < cols - 1) push(j + 1);
    if (rr > 0) push(j - cols);
    if (rr < rows - 1) push(j + cols);
  }
  return cov;
}

/** Gradient values 1 → 0 from a to b (linear) or from the centre a to the radius |b − a| (radial). / 그라데이션 */
export function gradientValues(rows, cols, ax, ay, bx, by, kind = 'linear') {
  const out = new Float32Array(rows * cols);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = Math.max(1e-6, dx * dx + dy * dy);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px = c + 0.5 - ax;
      const py = r + 0.5 - ay;
      const u = kind === 'radial' ? Math.sqrt((px * px + py * py) / len2) : (px * dx + py * dy) / len2;
      out[r * cols + c] = 1 - clamp(u, 0, 1);
    }
  }
  return out;
}

/**
 * Paint a straight line of constant value (presets, self-checks): exactly one cell per column for a
 * shallow line (one tone at a time — a staircase glissando), one per row for a steep one. `half` > 0.5
 * thickens it (rows). / 직선 그리기: 완만한 선은 열마다 셀 하나(한 번에 음 하나 = 계단형 글리산도), 가파른 선은 행마다 하나.
 */
export function paintLine(ras, rows, cols, x0, y0, x1, y1, value = 1, half = 0.5) {
  const put = (c, r) => {
    if (c < 0 || c >= cols) return;
    const extra = Math.max(0, Math.round(half - 0.5));
    for (let q = Math.max(0, r - extra); q <= Math.min(rows - 1, r + extra); q++) if (value > ras[q * cols + c]) ras[q * cols + c] = value;
  };
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const ca = Math.max(0, Math.floor(Math.min(x0, x1)));
    const cb = Math.min(cols - 1, Math.ceil(Math.max(x0, x1)) - 1);
    for (let c = ca; c <= Math.max(ca, cb); c++) {
      const u = Math.abs(dx) < 1e-9 ? 0 : clamp((c + 0.5 - x0) / dx, 0, 1);
      put(c, clamp(Math.floor(y0 + dy * u), 0, rows - 1));
    }
  } else {
    const ra = Math.max(0, Math.floor(Math.min(y0, y1)));
    const rb = Math.min(rows - 1, Math.ceil(Math.max(y0, y1)) - 1);
    for (let r = ra; r <= Math.max(ra, rb); r++) {
      const u = clamp((r + 0.5 - y0) / dy, 0, 1);
      put(clamp(Math.floor(x0 + dx * u), 0, cols - 1), r);
    }
  }
  return ras;
}
