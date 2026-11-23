/**
 * Flexatone — modules/pitch-warp.js
 * Layer 1 (modules, pure): pitch-space warp ("curvature") — the maths behind the Manager's Warp
 * button. A warp source (lines, rules or a field) becomes a displacement table D(t, m) in
 * semitones; target tracks hear m' = m + depth · D(t, m).
 * 계층 1 (순수): 피치 공간 곡률 — 매니저 곡률 버튼의 수학. 곡률 출처(선·규칙·장)를 변위 표 D(t, m)
 * (반음)로 만들고, 대상 트랙은 m' = m + depth·D(t, m)를 듣게 됨.
 *
 * Table / 표
 *   rows = time (≤ MAX_ROWS, DEFAULT_RATE rows per source second), cols = MIDI grid GRID_LO…GRID_HI
 *   (1 semitone), bilinear lookup, constant outside the grid. Every row is made monotone
 *   (m ↦ m + D strictly increasing, slope ≥ MIN_SLOPE) so a warp never swaps the order of two notes —
 *   except "wrap" tables (Risset rotation), which wrap the result inside [lo, lo + span) on purpose.
 *   행마다 단조성 강제 (두 음의 순서가 뒤바뀌지 않음). wrap 표(리세 회전)만 의도적으로 [lo, lo+span) 안에서 순환.
 *
 * Builders / 생성기
 *   buildLineWarpTable      lines {pts:[{t,m}], rest?} → anchors (Rᵢ → Rᵢ + Dᵢ(t)), Fritsch–Carlson
 *                           between anchors, nearest displacement outside; or a Gaussian brush per line
 *                           1 line = transposition curve, ≥ 2 lines = intervals stretch / shrink
 *   buildRuleWarpTable      centre c(t) + scale s(t) around c(0) (+ optional snap) — Cloud rules
 *   buildGridWarpTable      a field on a pitch grid: displacement u (Wave disp) or an energy density
 *                           whose cumulative distribution is the map (Wave energy)
 *   buildAdvectionWarpTable pitch points carried by a velocity field dy/dt (Field "field" mode)
 *   createPitchWarp         stages (one per source track, in track order) → (cycleSec, midi) → midi
 *
 * Imports core/* only. No DOM, no audio.
 */

import { clamp, createMonotoneInterpolator } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';

export const GRID_LO = -24;
export const GRID_HI = 144;
export const GRID_STEP = 1;
export const GRID_COLS = Math.round((GRID_HI - GRID_LO) / GRID_STEP) + 1;
export const DEFAULT_RATE = 25;
export const MAX_ROWS = 4000;
export const MAX_DURATION = 3600;
/** Smallest slope of m ↦ m' (keeps the map strictly increasing). / 최소 기울기 */
export const MIN_SLOPE = 0.05;

// --------------------------------------------------------------------------
// Table / 표
// --------------------------------------------------------------------------

/**
 * Empty table for `duration` source seconds. `wrap` = { lo, span } (Risset rotation) or null.
 * @returns {{ duration, rate, rows, cols, lo, step, data: Float32Array, wrap }}
 */
export function createWarpTable(duration, { rate = DEFAULT_RATE, wrap = null } = {}) {
  const dur = clamp(Number.isFinite(Number(duration)) ? Number(duration) : 0, 0, MAX_DURATION);
  let r = Math.max(0.1, Number(rate) || DEFAULT_RATE);
  let rows = Math.floor(dur * r) + 2;
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS;
    r = (rows - 2) / Math.max(1e-6, dur);
  }
  return { duration: dur, rate: r, rows, cols: GRID_COLS, lo: GRID_LO, step: GRID_STEP, data: new Float32Array(rows * GRID_COLS), wrap: wrap || null };
}

/** MIDI of grid column j. / 격자 열의 MIDI */
export const gridMidi = (table, j) => table.lo + j * table.step;

/** Make one row monotone in place (m + D[j] strictly increasing). / 행 단조화 */
export function enforceMonotoneRow(D, lo = GRID_LO, step = GRID_STEP, offset = 0, cols = D.length - offset) {
  let prev = -Infinity;
  for (let j = 0; j < cols; j++) {
    const m = lo + j * step;
    let mapped = m + D[offset + j];
    if (mapped < prev + MIN_SLOPE * step) {
      mapped = prev + MIN_SLOPE * step;
      D[offset + j] = mapped - m;
    }
    prev = mapped;
  }
}

/**
 * Fill every row: fn(tSec, midis: Float64Array, out: Float64Array) writes D for each grid pitch.
 * 모든 행 채우기 (fn이 격자 음고마다 변위를 기록).
 */
export function fillWarpTable(table, fn) {
  const mids = new Float64Array(table.cols);
  for (let j = 0; j < table.cols; j++) mids[j] = gridMidi(table, j);
  const out = new Float64Array(table.cols);
  for (let k = 0; k < table.rows; k++) {
    out.fill(0);
    fn(k / table.rate, mids, out);
    const off = k * table.cols;
    for (let j = 0; j < table.cols; j++) table.data[off + j] = Number.isFinite(out[j]) ? out[j] : 0;
    if (!table.wrap) enforceMonotoneRow(table.data, table.lo, table.step, off, table.cols);
  }
  return table;
}

/** Zero-phase time smoothing (forward + backward one-pole), τ = sec. / 시간 평활 (영위상) */
export function smoothWarpTable(table, sec) {
  if (!(sec > 0) || table.rows < 3) return table;
  const a = Math.exp(-1 / (sec * table.rate));
  const { data, cols, rows } = table;
  for (let j = 0; j < cols; j++) {
    let y = data[j];
    for (let k = 1; k < rows; k++) { y = a * y + (1 - a) * data[k * cols + j]; data[k * cols + j] = y; }
    y = data[(rows - 1) * cols + j];
    for (let k = rows - 2; k >= 0; k--) { y = a * y + (1 - a) * data[k * cols + j]; data[k * cols + j] = y; }
  }
  return table; // convex combinations of monotone rows stay monotone / 단조 행의 볼록 결합은 단조
}

/** Displacement D(t, m) in semitones (bilinear). / 변위 조회 */
export function warpShift(table, t, m) {
  if (!table || !(table.rows >= 2)) return 0;
  const tt = clamp(Number(t) || 0, 0, table.duration) * table.rate;
  let k = Math.floor(tt);
  if (k > table.rows - 2) k = table.rows - 2;
  const f = clamp(tt - k, 0, 1);
  const x = clamp((m - table.lo) / table.step, 0, table.cols - 1);
  let j = Math.floor(x);
  if (j > table.cols - 2) j = table.cols - 2;
  const g = x - j;
  const d = table.data;
  const c = table.cols;
  const a0 = d[k * c + j] + (d[k * c + j + 1] - d[k * c + j]) * g;
  const a1 = d[(k + 1) * c + j] + (d[(k + 1) * c + j + 1] - d[(k + 1) * c + j]) * g;
  return a0 + (a1 - a0) * f;
}

/** Warped pitch m' = m + depth·D(t, m) (wrapped for rotation tables). / 휘어진 음고 */
export function warpMidi(table, t, m, depth = 1) {
  if (!table || !Number.isFinite(m) || depth === 0) return m;
  let out = m + depth * warpShift(table, t, m);
  const w = table.wrap;
  if (w && w.span > 0 && m >= w.lo && m < w.lo + w.span) out = w.lo + ((((out - w.lo) % w.span) + w.span) % w.span);
  return out;
}

// --------------------------------------------------------------------------
// Lines → table / 선 → 표
// --------------------------------------------------------------------------

function prepareLine(line, rest) {
  const pts = (line?.pts || []).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.m)).sort((a, b) => a.t - b.t);
  if (!pts.length) return null;
  const T = Float64Array.from(pts, (p) => p.t);
  const M = Float64Array.from(pts, (p) => p.m);
  let R = Number(line.rest);
  if (!Number.isFinite(R)) R = rest === 'mean' ? M.reduce((s, x) => s + x, 0) / M.length : M[0];
  return { T, M, R, radius: Number(line.radius) > 0 ? Number(line.radius) : null };
}

/** Displacement of one prepared line at source time t. / 선 하나의 변위 */
export function lineDisplacement(L, t, { after = 'hold', returnSec = 1 } = {}) {
  const n = L.T.length;
  if (t < L.T[0]) return 0;
  if (t >= L.T[n - 1]) {
    const d = L.M[n - 1] - L.R;
    return after === 'return' ? d * Math.max(0, 1 - (t - L.T[n - 1]) / Math.max(1e-3, returnSec)) : d;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L.T[mid] <= t) lo = mid; else hi = mid; }
  const f = (t - L.T[lo]) / Math.max(1e-9, L.T[hi] - L.T[lo]);
  return L.M[lo] + (L.M[hi] - L.M[lo]) * f - L.R;
}

/** Anchors (rest → displaced) to a displacement row. / 기준점 → 변위 행 */
export function anchorsToRow(anchors, mids, out, { brush = false, radius = 3 } = {}) {
  if (!anchors.length) return out;
  if (brush) {
    for (let j = 0; j < mids.length; j++) {
      let num = 0;
      let den = 0;
      for (const a of anchors) {
        const r = a.radius || radius;
        const z = (mids[j] - a.R) / r;
        if (z * z > 36) continue;
        const g = Math.exp(-0.5 * z * z);
        num += g * a.D;
        den += g;
      }
      out[j] = num / Math.max(1, den);
    }
    return out;
  }
  // merge anchors with the same rest pitch (mean displacement) / 같은 기준 음고는 평균
  const sorted = anchors.slice().sort((a, b) => a.R - b.R);
  const xs = [];
  const ds = [];
  const cnt = [];
  for (const a of sorted) {
    const k = xs.length - 1;
    if (k >= 0 && a.R - xs[k] < 1e-3) { ds[k] += a.D; cnt[k]++; } else { xs.push(a.R); ds.push(a.D); cnt.push(1); }
  }
  for (let k = 0; k < xs.length; k++) ds[k] /= cnt[k];
  const n = xs.length;
  if (n === 1) { out.fill(ds[0]); return out; }
  const interp = createMonotoneInterpolator(xs, xs.map((x, k) => x + ds[k]));
  for (let j = 0; j < mids.length; j++) {
    const m = mids[j];
    out[j] = m <= xs[0] ? ds[0] : m >= xs[n - 1] ? ds[n - 1] : interp(m) - m;
  }
  return out;
}

/**
 * Lines → table. lines: [{ pts: [{ t (source s), m (MIDI) }], rest?: MIDI, radius?: st }].
 * opts: { duration, rest: 'start'|'mean', after: 'hold'|'return', returnSec, brush, radius, rate, wrap }
 * 선 → 표.
 */
export function buildLineWarpTable(lines, { duration, rest = 'start', after = 'hold', returnSec = 1, brush = false, radius = 3, rate = DEFAULT_RATE, wrap = null } = {}) {
  const prepared = (lines || []).map((l) => prepareLine(l, rest)).filter(Boolean);
  let dur = Number(duration);
  if (!Number.isFinite(dur)) dur = prepared.reduce((m, L) => Math.max(m, L.T[L.T.length - 1]), 0);
  const table = createWarpTable(dur, { rate, wrap });
  if (!prepared.length) return table;
  const anchors = prepared.map((L) => ({ R: L.R, D: 0, radius: L.radius }));
  return fillWarpTable(table, (t, mids, out) => {
    for (let i = 0; i < prepared.length; i++) anchors[i].D = lineDisplacement(prepared[i], t, { after, returnSec });
    anchorsToRow(anchors, mids, out, { brush, radius });
  });
}

// --------------------------------------------------------------------------
// Rules, grids, flows → table / 규칙·격자·흐름 → 표
// --------------------------------------------------------------------------

/**
 * Centre + scale rule: m' = c(t) + (m − c(0))·s(t), then an optional pull toward snap(m').
 * 중심·배율 규칙 (+ 선택적 스냅).
 */
export function buildRuleWarpTable({ duration, centerAt, scaleAt = () => 1, snap = null, snapStrength = 0, rate = DEFAULT_RATE }) {
  const table = createWarpTable(duration, { rate });
  const c0 = centerAt(0);
  const k = clamp(Number(snapStrength) || 0, 0, 1);
  return fillWarpTable(table, (t, mids, out) => {
    const c = centerAt(t);
    const s = Math.max(0.02, scaleAt(t));
    for (let j = 0; j < mids.length; j++) {
      let mapped = c + (mids[j] - c0) * s;
      if (snap && k > 0) mapped += k * (snap(mapped) - mapped);
      out[j] = mapped - mids[j];
    }
  });
}

/**
 * A field on a pitch grid (bins pLo + i·dp, frames at `frameRate`):
 *   'disp'   D = amount · u / max|u|             (u = value(f, i), signed)
 *   'energy' map = pLo + (pHi − pLo)·CDF(ρ),  ρ = value / mean + floor  (value ≥ 0; floor 1 = half
 *            uniform, so a narrow peak widens its band without squeezing the rest to nothing)
 * 음고 격자 위의 장 → 표 (변위 또는 에너지 밀도의 누적 분포).
 */
export function buildGridWarpTable({ duration, frames, frameRate, N, pLo, dp, value, mode = 'disp', amount = 6, rate = DEFAULT_RATE, floor = 1 }) {
  const table = createWarpTable(duration, { rate });
  if (!(frames >= 1 && N >= 2)) return table;
  const pHi = pLo + (N - 1) * dp;
  let scale = 0;
  if (mode === 'disp') {
    let mx = 0;
    for (let f = 0; f < frames; f++) for (let i = 0; i < N; i++) mx = Math.max(mx, Math.abs(value(f, i)));
    scale = mx > 1e-12 ? amount / mx : 0;
  }
  const row = new Float64Array(N);
  const cdf = new Float64Array(N);
  const frameRow = (f) => {
    if (mode === 'disp') { for (let i = 0; i < N; i++) row[i] = scale * value(f, i); return; }
    let sum = 0;
    for (let i = 0; i < N; i++) { row[i] = Math.max(0, value(f, i)); sum += row[i]; }
    const mean = sum / N;
    cdf[0] = 0;
    for (let i = 1; i < N; i++) {
      const a = (mean > 1e-12 ? row[i - 1] / mean : 0) + floor;
      const b = (mean > 1e-12 ? row[i] / mean : 0) + floor;
      cdf[i] = cdf[i - 1] + 0.5 * (a + b);
    }
    const tot = cdf[N - 1] || 1;
    for (let i = 0; i < N; i++) row[i] = pLo + (pHi - pLo) * (cdf[i] / tot) - (pLo + i * dp); // displacement at bin i
  };
  let lastF = -1;
  return fillWarpTable(table, (t, mids, out) => {
    const f = clamp(Math.round(t * frameRate), 0, frames - 1);
    if (f !== lastF) { frameRow(f); lastF = f; }
    for (let j = 0; j < mids.length; j++) {
      const x = (mids[j] - pLo) / dp;
      if (mode === 'energy' && (x < 0 || x > N - 1)) { out[j] = 0; continue; }
      const xc = clamp(x, 0, N - 1);
      const i = Math.min(N - 2, Math.floor(xc));
      const g = xc - i;
      out[j] = row[i] + (row[i + 1] - row[i]) * g;
    }
  });
}

/**
 * Pitch points carried by a 1-D velocity field. Source time [t0, t1] ↔ normalised tn ∈ [0, 1];
 * pitch m ↔ y = (m − m0)/(m1 − m0); velocity(tn, y) = dy/dtn. Before t0: 0, after t1: held.
 * 1차원 속도장이 음고 점들을 실어 나름 (장 모드).
 */
export function buildAdvectionWarpTable({ duration, t0 = 0, t1 = duration, m0, m1, velocity, rate = DEFAULT_RATE, substeps = 2, yLimit = [-1, 2] }) {
  const table = createWarpTable(duration, { rate });
  let span = m1 - m0;
  if (!(Math.abs(span) > 1e-3)) span = 12;
  const len = Math.max(1e-3, t1 - t0);
  const cols = table.cols;
  const y0 = new Float64Array(cols);
  const y = new Float64Array(cols);
  for (let j = 0; j < cols; j++) { y0[j] = (gridMidi(table, j) - m0) / span; y[j] = y0[j]; }
  let tn = 0;
  return fillWarpTable(table, (t, mids, out) => {
    const target = clamp((t - t0) / len, 0, 1);
    while (tn < target - 1e-9) {
      const h = Math.min(target - tn, 1 / (table.rate * len * substeps));
      for (let j = 0; j < cols; j++) {
        const k1 = velocity(tn, y[j]);
        const ym = y[j] + 0.5 * h * k1;
        y[j] = clamp(y[j] + h * velocity(tn + 0.5 * h, ym), yLimit[0], yLimit[1]);
      }
      tn += h;
    }
    for (let j = 0; j < cols; j++) out[j] = (y[j] - y0[j]) * span;
  });
}

// --------------------------------------------------------------------------
// Composition / 합성
// --------------------------------------------------------------------------

function gateAt(local, length, fadeIn, fadeOut) {
  const fi = clamp(Number(fadeIn) || 0, 0, length / 2);
  const fo = clamp(Number(fadeOut) || 0, 0, length / 2);
  if (fi > 0 && local < fi) return local / fi;
  if (fo > 0 && local > length - fo) return Math.max(0, (length - local) / fo);
  return 1;
}

/**
 * Stages (one per source track, applied in track order) → warp(cycleSec, midi) → midi, or null.
 * stage = { table, depth, start, length, rate, loopLen, fadeIn, fadeOut }: active on the clip
 * [start, start + length), source time τ = (T − start)·rate (mod loopLen when > 0), the depth fades
 * with the clip's fades so the space never jumps at a clip edge.
 * 단계(출처 트랙마다, 트랙 순서) → 곡률 함수. 클립 페이드에 맞춰 깊이가 변해 경계에서 튀지 않음.
 */
export function createPitchWarp(stages) {
  const list = (stages || []).filter((s) => s && s.table && s.length > 0 && s.depth !== 0);
  if (!list.length) return null;
  return (T, midi) => {
    let m = midi;
    for (const s of list) {
      const local = T - s.start;
      if (!(local >= 0 && local < s.length)) continue;
      let tau = local * (s.rate || 1);
      if (s.loopLen > 0) tau %= s.loopLen;
      const g = gateAt(local, s.length, s.fadeIn, s.fadeOut);
      if (g > 0) m = warpMidi(s.table, tau, m, s.depth * g);
    }
    return m;
  };
}

/**
 * The other drives of the same stages (stage.mod = { level, trem, bright } sensitivities, −5…5):
 * (cycleSec, midi) → { levelDb, trem, bright } or null when no stage drives anything but pitch.
 *   levelDb = Σ k·D dB (−60…+12) · trem = max over stages of depth (k > 0: |k·D|/12, k < 0:
 *   1 − |k·D|/12; ×clip gate) · bright = Σ k·D/12 octaves (−2…2). D is read at the given pitch
 *   (rotation tables wrapped), times the clip gate. / 같은 단계의 다른 구동 (음량·트레몰로·밝기)
 */
export function createWarpMod(stages) {
  const list = (stages || []).filter((s) => s && s.table && s.length > 0 && s.mod && (s.mod.level || s.mod.trem || s.mod.bright));
  if (!list.length) return null;
  return (T, m) => {
    let levelDb = 0;
    let trem = 0;
    let bright = 0;
    for (const s of list) {
      const local = T - s.start;
      if (!(local >= 0 && local < s.length)) continue;
      let tau = local * (s.rate || 1);
      if (s.loopLen > 0) tau %= s.loopLen;
      const g = gateAt(local, s.length, s.fadeIn, s.fadeOut);
      if (!(g > 0)) continue;
      const D = warpMidi(s.table, tau, m, 1) - m;
      const { level = 0, trem: kt = 0, bright: kb = 0 } = s.mod;
      if (level) levelDb += level * D * g;
      if (kt) {
        const a = Math.abs(kt * D) / 12;
        trem = Math.max(trem, (kt > 0 ? Math.min(1, a) : Math.max(0, 1 - a)) * g);
      }
      if (kb) bright += (kb * D * g) / 12;
    }
    return { levelDb: clamp(levelDb, -60, 12), trem: clamp(trem, 0, 1), bright: clamp(bright, -2, 2) };
  };
}

/**
 * Time-density drive of the same stages (stage.mod.time = sensitivity): (cycleSec, midi) → playback
 * rate r = Π 2^(k·D·gate / 12) (0.125…8), or null when no stage drives time. D is read at `midi` —
 * the track's first pitch (track clock) or a voice's first pitch (voice clock).
 * 시간 밀도 구동: 재생 속도 r = Π 2^(k·D·게이트/12) (선이 첫 음보다 한 옥타브 위면 2배 촘촘).
 */
export function createWarpRate(stages) {
  const list = (stages || []).filter((s) => s && s.table && s.length > 0 && s.mod && s.mod.time);
  if (!list.length) return null;
  return (T, m) => {
    let oct = 0;
    for (const s of list) {
      const local = T - s.start;
      if (!(local >= 0 && local < s.length)) continue;
      let tau = local * (s.rate || 1);
      if (s.loopLen > 0) tau %= s.loopLen;
      const g = gateAt(local, s.length, s.fadeIn, s.fadeOut);
      if (!(g > 0)) continue;
      oct += (s.mod.time * (warpMidi(s.table, tau, m, 1) - m) * g) / 12;
    }
    return Math.pow(2, clamp(oct, -3, 3));
  };
}

// --------------------------------------------------------------------------
// Self-check / 자가진단
// --------------------------------------------------------------------------

registerSelfCheck('Pitch warp: one line transposes, two lines stretch, order is kept, brush is local, clips gate', (a) => {
  const rise = { pts: [{ t: 0, m: 48 }, { t: 4, m: 72 }] };
  const one = buildLineWarpTable([rise], { duration: 4 });
  a.near(warpMidi(one, 0, 60), 60, 1e-4, 'no bend at the start');
  a.near(warpMidi(one, 2, 60), 72, 1e-3, 'drone follows the line (+12 at t = 2)');
  a.near(warpMidi(one, 4, 60), 84, 1e-3, '+24 at the end');
  a.near(warpMidi(one, 2, 60, 0.5), 66, 1e-3, 'depth 0.5 = half the bend');

  const two = buildLineWarpTable([{ pts: [{ t: 0, m: 48 }, { t: 4, m: 48 }] }, { pts: [{ t: 0, m: 72 }, { t: 4, m: 84 }] }], { duration: 4 });
  a.near(warpMidi(two, 4, 48), 48, 1e-3, 'lower line stays');
  a.near(warpMidi(two, 4, 72), 84, 1e-3, 'upper line moves');
  a.near(warpMidi(two, 4, 60), 66, 0.05, 'interval between the lines is stretched (×1.5)');
  a.near(warpMidi(two, 4, 90), 102, 1e-3, 'above the top line: its displacement');

  const cross = buildLineWarpTable([{ pts: [{ t: 0, m: 50 }, { t: 1, m: 80 }] }, { pts: [{ t: 0, m: 70 }, { t: 1, m: 40 }] }], { duration: 1 });
  let ok = true;
  let prev = -Infinity;
  for (let m = 30; m <= 100; m += 0.5) { const w = warpMidi(cross, 1, m); if (w <= prev) ok = false; prev = w; }
  a.ok(ok, 'crossing lines never swap two notes (monotone map)');

  const brush = buildLineWarpTable([{ pts: [{ t: 0, m: 60 }, { t: 1, m: 67 }] }], { duration: 1, brush: true, radius: 2 });
  a.near(warpMidi(brush, 1, 60), 67, 0.01, 'brush moves its own pitch');
  a.near(warpMidi(brush, 1, 30), 30, 1e-3, 'brush leaves far pitches alone');

  const ret = buildLineWarpTable([{ pts: [{ t: 0, m: 60 }, { t: 1, m: 62 }] }], { duration: 3, after: 'return', returnSec: 1 });
  a.near(warpMidi(ret, 1.5, 60), 61, 0.02, 'return: halfway back after 0.5 s');
  a.near(warpMidi(ret, 2.5, 60), 60, 1e-3, 'return: back to rest');

  const wrap = buildLineWarpTable([{ pts: [{ t: 0, m: 24 }, { t: 1, m: 24 + 120 }] }], { duration: 1, wrap: { lo: 24, span: 96 } });
  a.near(warpMidi(wrap, 1, 30), 54, 1e-3, 'rotation wraps inside the span');

  const rule = buildRuleWarpTable({ duration: 2, centerAt: (t) => 60 + 6 * t, scaleAt: (t) => 1 + t / 2 });
  a.near(warpMidi(rule, 2, 60), 72, 1e-3, 'rule: centre moves');
  a.near(warpMidi(rule, 2, 66), 84, 1e-3, 'rule: scale ×2 around the centre');

  const grid = buildGridWarpTable({ duration: 1, frames: 1, frameRate: 1, N: 3, pLo: 48, dp: 12, value: (f, i) => (i === 1 ? 1 : 0), mode: 'disp', amount: 4 });
  a.near(warpMidi(grid, 0, 60), 64, 1e-3, 'grid disp: peak bin moves by `amount`');
  const en = buildGridWarpTable({ duration: 1, frames: 1, frameRate: 1, N: 5, pLo: 48, dp: 6, value: () => 1, mode: 'energy' });
  a.near(warpMidi(en, 0, 57), 57, 1e-3, 'grid energy: uniform density = identity');

  const adv = buildAdvectionWarpTable({ duration: 1, m0: 48, m1: 72, velocity: () => 0.5 });
  a.near(warpMidi(adv, 1, 60), 72, 0.01, 'advection: constant flow carries every pitch (+0.5·24)');

  const w = createPitchWarp([{ table: one, depth: 1, start: 10, length: 4, rate: 1 }]);
  a.near(w(9, 60), 60, 1e-9, 'before the clip: identity');
  a.near(w(12, 60), 72, 1e-3, 'inside the clip: source time = T − start');
  a.near(w(14.5, 60), 60, 1e-9, 'after the clip: identity');
  a.equal(createPitchWarp([]), null, 'no stage → null');

  const mod = createWarpMod([{ table: one, start: 0, length: 4, rate: 1, mod: { level: -0.5, trem: 1, bright: 2 } }]);
  const r2 = mod(2, 60); // D = +12 at t = 2
  a.near(r2.levelDb, -6, 1e-3, 'level: −0.5 × 12 st = −6 dB');
  a.near(r2.trem, 1, 1e-6, 'tremolo: |1 × 12| / 12 = full depth');
  a.near(r2.bright, 2, 1e-6, 'brightness: 2 × 12 / 12 = +2 oct (clamped)');
  const inv = createWarpMod([{ table: one, start: 0, length: 4, rate: 1, mod: { trem: -1 } }]);
  a.near(inv(0, 60).trem, 1, 1e-6, 'negative sensitivity: trembles where straight');
  a.near(inv(2, 60).trem, 0, 1e-6, 'negative sensitivity: still where bent');
  a.equal(createWarpMod([{ table: one, start: 0, length: 4, rate: 1, mod: {} }]), null, 'pitch-only stages → no mod');
  const rateFn = createWarpRate([{ table: one, start: 0, length: 4, rate: 1, mod: { time: 1 } }]);
  a.near(rateFn(0, 60), 1, 1e-6, 'time: no bend → normal speed');
  a.near(rateFn(2, 60), 2, 1e-3, 'time: an octave above the first pitch → twice as dense');
  a.near(createWarpRate([{ table: one, start: 0, length: 4, rate: 1, mod: { time: -1 } }])(2, 60), 0.5, 1e-3, 'time: negative sensitivity → half as dense');
}, { group: 'math' });
