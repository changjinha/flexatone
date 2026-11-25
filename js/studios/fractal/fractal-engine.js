/**
 * Flexatone — studios/fractal/fractal-engine.js
 * Layer 2 (studios, pure): Fractal Studio algorithms, edit-time bake and cache.
 * 계층 2 (studios, 순수): 프랙탈 스튜디오 알고리즘, 에디팅 시점 베이킹과 캐시.
 *
 * Six self-similar generators, every one a pure, seed-deterministic function:
 *   fif         Barnsley fractal interpolation function (deterministic Read–Bajraktarević iteration)
 *   fbm         fractional Brownian motion (spectral synthesis or midpoint displacement)
 *   weierstrass Weierstrass Σ aᵏ cos(bᵏπx)  /  Takagi–Landsberg Σ wᵏ s(2ᵏx)
 *   cantor      generalised devil's staircase (m-adic, removal ratio gap)
 *   lsystem     string rewriting → pitch turtle, one voice per branch
 *   canon       Nørgård infinity series as a scale (prolation) canon, one voice per layer
 *
 * bakeFractal(params) turns the document into dense MIDI / gain arrays at `bake.bakeRate`
 * points per second. The result is memoised by a signature of every shape-affecting field,
 * so playback and redraws only read the cache (getFractalBakeCount() exposes misses).
 * bakeFractal은 문서를 조밀한 MIDI/게인 배열로 굽고 시그니처로 캐시 — 재생·그리기는 조회만.
 *
 * No DOM, no Web Audio, no ui/* or audio/* imports.
 */

import { clamp, createSeededRandom, rdpSimplify, roundTo, deepClone } from '../../core/math-utils.js';

export const FRACTAL_MODES = Object.freeze(['fif', 'fbm', 'weierstrass', 'cantor', 'lsystem', 'canon']);
export const CURVE_MODES = Object.freeze(['fif', 'fbm', 'weierstrass', 'cantor']);
export const QUANTIZE_MODES = Object.freeze(['off', '12tet', 'scale']);
export const SCALES = Object.freeze({
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  whole: [0, 2, 4, 6, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
});
export const GAIN_SOURCES = Object.freeze(['fixed', 'slope']);
export const FBM_METHODS = Object.freeze(['spectral', 'midpoint']);

export const MAX_LSYS_LENGTH = 200000; // symbols / 기호 수 상한
export const MAX_LSYS_ITER = 8;
export const MAX_REFINE_VOICES = 12;
export const MAX_FRACTAL_VOICES = 64;
export const MAX_VOICE_SAMPLES = 24000;
export const MAX_TOTAL_SAMPLES = 400000;
export const MAX_CANON_NOTES = 4096;
export const STEP_GLIDE_SEC = 0.005; // plateau / note boundary glide / 계단 경계 글라이드
export const FIF_MAX_POINTS = 9;

// --------------------------------------------------------------------------
// Document defaults & normalisation / 문서 기본값과 정규화
// --------------------------------------------------------------------------

export function createDefaultFractalParams() {
  return {
    mode: 'fif',
    preset: 'barnsley',
    seed: 1,
    length: 30,
    lo: 36,
    hi: 84,
    quantize: 'off',
    scale: 'major',
    scaleRoot: 0,
    fif: {
      points: [{ x: 0, y: 0.2 }, { x: 0.3, y: 0.78 }, { x: 0.55, y: 0.35 }, { x: 0.8, y: 0.88 }, { x: 1, y: 0.45 }],
      d: [0.5, -0.4, 0.45, -0.35],
      depth: 6,
    },
    fbm: { H: 0.5, octaves: 8, method: 'spectral' },
    weier: { a: 0.5, b: 3, terms: 10, takagi: false },
    cantor: { div: 3, gap: 1 / 3, depth: 6 },
    lsys: { axiom: 'F', rules: [{ from: 'F', to: 'F[+F]F[-F]F' }], iterations: 3, angleSemitones: 3, stepSec: 0.6, glide: true, startNote: 60 },
    canon: { layers: 5, ratio: 0.5, subject: 'norgard', customIntervals: [0, 2, -1, 3, 1], baseNote: 55, stepSemitones: 2, noteSec: 1.6, layerTranspose: 12 },
    refine: { enabled: false, levels: [0, 2, 4, 6], staggerSec: 1.5 },
    gain: { source: 'fixed', level: 0.7, slopeAmount: 0.6 },
    timbre: { sine: 0.7, tri: 0.3, saw: 0.1, sqr: 0, rich: 0.15 },
    voicesMax: 16,
    bake: { bakeRate: 200, tolerance: 0.004 },
  };
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

/**
 * Deep-merge a saved document over the defaults and clamp every field (old / hand-edited
 * projects stay valid). / 저장된 문서를 기본값 위에 깊게 병합하고 범위 고정
 */
export function normalizeFractalParams(raw = {}) {
  const d = createDefaultFractalParams();
  const src = raw && typeof raw === 'object' ? raw : {};
  const sec = (k) => ({ ...d[k], ...(src[k] && typeof src[k] === 'object' ? deepClone(src[k]) : {}) });
  const p = { ...d, ...src, fif: sec('fif'), fbm: sec('fbm'), weier: sec('weier'), cantor: sec('cantor'), lsys: sec('lsys'), canon: sec('canon'), refine: sec('refine'), gain: sec('gain'), timbre: sec('timbre'), bake: sec('bake') };
  p.mode = pick(p.mode, FRACTAL_MODES, 'fif');
  p.preset = typeof p.preset === 'string' ? p.preset : '';
  p.seed = Math.round(clamp(num(p.seed, 1), 0, 2 ** 31 - 1));
  p.length = clamp(num(p.length, 30), 1, 240);
  p.lo = clamp(num(p.lo, 36), 12, 115);
  p.hi = clamp(num(p.hi, 84), p.lo + 1, 120);
  p.quantize = pick(p.quantize, QUANTIZE_MODES, 'off');
  p.scale = Object.prototype.hasOwnProperty.call(SCALES, p.scale) ? p.scale : 'major';
  p.scaleRoot = Math.round(clamp(num(p.scaleRoot, 0), 0, 11));

  // FIF: x strictly increasing with x0 = 0, xN = 1, |d| < 1 / x 단조, |d| < 1
  let pts = (Array.isArray(p.fif.points) ? p.fif.points : d.fif.points).map((q) => ({ x: clamp(num(q?.x, 0), 0, 1), y: clamp(num(q?.y, 0.5), -0.5, 1.5) }));
  if (pts.length < 2) pts = deepClone(d.fif.points);
  pts = pts.slice(0, FIF_MAX_POINTS).sort((a, b) => a.x - b.x);
  pts[0].x = 0;
  pts[pts.length - 1].x = 1;
  for (let i = 1; i < pts.length - 1; i++) pts[i].x = clamp(pts[i].x, pts[i - 1].x + 0.01, 1 - 0.01 * (pts.length - 1 - i));
  p.fif.points = pts;
  const dd = Array.isArray(p.fif.d) ? p.fif.d : [];
  p.fif.d = Array.from({ length: pts.length - 1 }, (_, i) => clamp(num(dd[i], 0), -0.95, 0.95));
  p.fif.depth = Math.round(clamp(num(p.fif.depth, 6), 0, 14));

  p.fbm.H = clamp(num(p.fbm.H, 0.5), 0.05, 0.95);
  p.fbm.octaves = Math.round(clamp(num(p.fbm.octaves, 8), 1, 12));
  p.fbm.method = pick(p.fbm.method, FBM_METHODS, 'spectral');

  p.weier.a = clamp(num(p.weier.a, 0.5), 0.05, 0.95);
  p.weier.b = clamp(num(p.weier.b, 3), 1.1, 9);
  p.weier.terms = Math.round(clamp(num(p.weier.terms, 10), 1, 24));
  p.weier.takagi = !!p.weier.takagi;

  let div = Math.round(clamp(num(p.cantor.div, 3), 3, 9));
  if (div % 2 === 0) div += 1;
  p.cantor.div = div;
  p.cantor.gap = clamp(num(p.cantor.gap, 1 / 3), 0.02, 0.9);
  p.cantor.depth = Math.round(clamp(num(p.cantor.depth, 6), 0, 12));

  p.lsys.axiom = String(p.lsys.axiom ?? 'F').slice(0, 64) || 'F';
  p.lsys.rules = (Array.isArray(p.lsys.rules) ? p.lsys.rules : [])
    .map((r) => ({ from: String(r?.from ?? '').slice(0, 1), to: String(r?.to ?? '').slice(0, 64) }))
    .filter((r) => r.from && r.from !== '[' && r.from !== ']')
    .slice(0, 8);
  p.lsys.iterations = Math.round(clamp(num(p.lsys.iterations, 3), 0, MAX_LSYS_ITER));
  p.lsys.angleSemitones = clamp(num(p.lsys.angleSemitones, 3), -12, 12);
  p.lsys.stepSec = clamp(num(p.lsys.stepSec, 0.6), 0.02, 4);
  p.lsys.glide = p.lsys.glide !== false;
  p.lsys.startNote = clamp(num(p.lsys.startNote, 60), 12, 120);

  p.canon.layers = Math.round(clamp(num(p.canon.layers, 5), 1, 8));
  p.canon.ratio = clamp(num(p.canon.ratio, 0.5), 0.2, 0.95);
  p.canon.subject = pick(p.canon.subject, ['norgard', 'custom'], 'norgard');
  p.canon.customIntervals = (Array.isArray(p.canon.customIntervals) ? p.canon.customIntervals : [0]).map((x) => clamp(num(x, 0), -24, 24)).slice(0, 64);
  if (!p.canon.customIntervals.length) p.canon.customIntervals = [0];
  p.canon.baseNote = clamp(num(p.canon.baseNote, 55), 12, 115);
  p.canon.stepSemitones = clamp(num(p.canon.stepSemitones, 2), 0.1, 12);
  p.canon.noteSec = clamp(num(p.canon.noteSec, 1.6), 0.05, 8);
  p.canon.layerTranspose = clamp(num(p.canon.layerTranspose, 12), -24, 24);

  p.refine.enabled = !!p.refine.enabled;
  const lv = Array.isArray(p.refine.levels) ? p.refine.levels : [];
  p.refine.levels = [...new Set(lv.map((x) => Math.round(clamp(num(x, 0), 0, 24))))].sort((a, b) => a - b).slice(0, MAX_REFINE_VOICES);
  if (!p.refine.levels.length) p.refine.levels = [0];
  p.refine.staggerSec = clamp(num(p.refine.staggerSec, 1.5), 0, 20);

  p.gain.source = pick(p.gain.source, GAIN_SOURCES, 'fixed');
  p.gain.level = clamp(num(p.gain.level, 0.7), 0, 1.5);
  p.gain.slopeAmount = clamp(num(p.gain.slopeAmount, 0.6), 0, 1);
  for (const w of ['sine', 'tri', 'saw', 'sqr', 'rich']) p.timbre[w] = clamp(num(p.timbre[w], 0), 0, 1);
  p.voicesMax = Math.round(clamp(num(p.voicesMax, 16), 1, MAX_FRACTAL_VOICES));
  p.bake.bakeRate = Math.round(clamp(num(p.bake.bakeRate, 200), 50, 800));
  p.bake.tolerance = clamp(num(p.bake.tolerance, 0.004), 0.0005, 0.05);
  return p;
}

// --------------------------------------------------------------------------
// 1. Fractal interpolation function (Barnsley) / 프랙탈 보간 함수
// --------------------------------------------------------------------------

/**
 * Affine maps wₖ(x, y) = (aₖx + eₖ, cₖx + dₖy + fₖ) fixed by the end-point conditions
 * wₖ(x₀, y₀) = (xₖ₋₁, yₖ₋₁), wₖ(x_N, y_N) = (xₖ, yₖ). / 끝점 조건으로 정해지는 어파인 사상
 */
export function fifMaps(points, d) {
  const N = points.length - 1;
  const x0 = points[0].x;
  const xN = points[N].x;
  const y0 = points[0].y;
  const yN = points[N].y;
  const L = xN - x0 || 1;
  const maps = [];
  for (let k = 1; k <= N; k++) {
    const xa = points[k - 1].x;
    const xb = points[k].x;
    const ya = points[k - 1].y;
    const yb = points[k].y;
    const dk = d[k - 1] || 0;
    maps.push({
      xa, xb, d: dk,
      a: (xb - xa) / L,
      e: (xN * xa - x0 * xb) / L,
      c: (yb - ya - dk * (yN - y0)) / L,
      f: (xN * ya - x0 * yb - dk * (xN * y0 - x0 * yN)) / L,
    });
  }
  return maps;
}

function linearThrough(points, x) {
  if (x <= points[0].x) return points[0].y;
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i].x) {
      const a = points[i - 1];
      const b = points[i];
      return a.y + ((x - a.x) / Math.max(1e-12, b.x - a.x)) * (b.y - a.y);
    }
  }
  return points[points.length - 1].y;
}

/**
 * f_n(x) = (T f_{n−1})(x), f₀ = polyline through the points. Every iterate interpolates the
 * points exactly; f_n → FIF as n → ∞ (|dₖ| < 1). / 매 반복이 보간점을 정확히 통과
 */
export function fifEval(points, maps, x, depth) {
  if (depth <= 0) return linearThrough(points, x);
  let k = maps.length - 1;
  for (let i = 0; i < maps.length; i++) if (x <= maps[i].xb) { k = i; break; }
  const m = maps[k];
  const u = clamp((x - m.e) / m.a, points[0].x, points[points.length - 1].x);
  return m.c * u + m.d * fifEval(points, maps, u, depth - 1) + m.f;
}

/** Box dimension of a FIF graph: D solves Σ|dₖ|aₖ^(D−1) = 1 when Σ|dₖ| > 1, else 1. */
export function fifTheoryDimension(points, d) {
  const maps = fifMaps(points, d);
  const s = maps.reduce((acc, m) => acc + Math.abs(m.d), 0);
  if (s <= 1) return 1;
  const g = (D) => maps.reduce((acc, m) => acc + Math.abs(m.d) * Math.pow(m.a, D - 1), 0) - 1;
  let lo = 1;
  let hi = 2;
  if (g(hi) > 0) return 2;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// --------------------------------------------------------------------------
// 2. fBm / 분수 브라운 운동
// --------------------------------------------------------------------------

function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Spectral fBm, cumulative by octave: level j adds harmonics k ∈ [2^j, 2^(j+1)).
 * Aₖ = k^−(H+½), random phase φₖ from the seed (the phase of k never depends on the octave
 * count, so lower levels are exact prefixes of higher ones).
 * 옥타브 누적 스펙트럼 합성: 레벨 j는 k ∈ [2^j, 2^(j+1)) 배음을 더함.
 * @returns {Float64Array[]} one array (n samples over x ∈ [0, 1]) per level 0..levels−1
 */
export function fbmSpectralLevels(H, levels, seed, n, x0 = 0, x1 = 1) {
  const rng = createSeededRandom((seed * 2654435761) >>> 0 || 1);
  const kMax = 2 ** levels - 1;
  const phase = new Float64Array(kMax + 1);
  for (let k = 1; k <= kMax; k++) phase[k] = 2 * Math.PI * rng();
  const acc = new Float64Array(n);
  const out = [];
  for (let j = 0; j < levels; j++) {
    for (let k = 2 ** j; k < 2 ** (j + 1); k++) {
      const A = Math.pow(k, -(H + 0.5));
      const w = 2 * Math.PI * k;
      // rotation recurrence instead of Math.cos per sample (≈10× faster) / 회전 점화식
      const dth = (w * (x1 - x0)) / (n - 1);
      const cd = Math.cos(dth);
      const sd = Math.sin(dth);
      let c = Math.cos(w * x0 + phase[k]);
      let s = Math.sin(w * x0 + phase[k]);
      for (let i = 0; i < n; i++) {
        acc[i] += A * c;
        const c2 = c * cd - s * sd;
        s = s * cd + c * sd;
        c = c2;
      }
    }
    out.push(Float64Array.from(acc));
  }
  return out;
}

/**
 * Midpoint displacement fBm: level j has 2^(j+1) + 1 knots, each new midpoint displaced by
 * σⱼ = 2^(−(j+1)H)·√(1 − 2^(2H−2)). The gaussian stream is consumed in order, so level j+1
 * keeps every knot of level j. / 중점 변위: 레벨 j+1은 레벨 j의 모든 매듭을 유지
 */
export function fbmMidpointLevels(H, levels, seed, n) {
  const rng = createSeededRandom((seed * 2246822519) >>> 0 || 1);
  let knots = [0, gaussian(rng)];
  const out = [];
  const scale = Math.sqrt(Math.max(1e-9, 1 - Math.pow(2, 2 * H - 2)));
  for (let j = 0; j < levels; j++) {
    const sigma = Math.pow(2, -(j + 1) * H) * scale;
    const next = new Array(knots.length * 2 - 1);
    for (let i = 0; i < knots.length - 1; i++) {
      next[2 * i] = knots[i];
      next[2 * i + 1] = 0.5 * (knots[i] + knots[i + 1]) + sigma * gaussian(rng);
    }
    next[next.length - 1] = knots[knots.length - 1];
    knots = next;
    const arr = new Float64Array(n);
    const segs = knots.length - 1;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * segs;
      const s = Math.min(segs - 1, Math.floor(u));
      arr[i] = knots[s] + (u - s) * (knots[s + 1] - knots[s]);
    }
    out.push(arr);
  }
  return out;
}

/**
 * Hurst exponent from the increment variance: Var[y(x+δ) − y(x)] ∝ δ^(2H).
 * 증분 분산 스케일링으로 H 추정.
 */
export function estimateHurst(y, lags = [8, 16, 32, 64, 128]) {
  const xs = [];
  const ys = [];
  for (const L of lags) {
    if (L >= y.length / 2) continue;
    let s = 0;
    for (let i = 0; i + L < y.length; i++) s += (y[i + L] - y[i]) ** 2;
    xs.push(Math.log(L));
    ys.push(Math.log(s / (y.length - L)));
  }
  return 0.5 * slope(xs, ys);
}

function slope(xs, ys) {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : NaN;
}

// --------------------------------------------------------------------------
// 3. Weierstrass / Takagi / 바이어슈트라스 · 다카기
// --------------------------------------------------------------------------

const tri = (x) => Math.abs(x - Math.round(x)); // distance to the nearest integer / 최근접 정수까지 거리

/** k-th term of the Weierstrass (aᵏcos(bᵏπx)) or Takagi–Landsberg (aᵏ s(2ᵏx)) sum. */
export function weierTerm(k, x, a, b, takagi) {
  return takagi ? Math.pow(a, k) * tri(Math.pow(2, k) * x) : Math.pow(a, k) * Math.cos(Math.pow(b, k) * Math.PI * x);
}

/** Largest usable term count so the finest term still has ≥ 3 samples per half-cycle. */
export function weierUsableTerms(terms, b, takagi, samplesPerUnit) {
  const base = takagi ? 2 : b;
  let k = 0;
  while (k < terms && Math.pow(base, k) <= samplesPerUnit / 3) k++;
  return Math.max(1, k);
}

/** Cumulative partial sums, one Float64Array per level (term count 1..levels). */
export function weierLevels(a, b, takagi, levels, n, x0 = 0, x1 = 1) {
  const acc = new Float64Array(n);
  const out = [];
  for (let k = 0; k < levels; k++) {
    for (let i = 0; i < n; i++) acc[i] += weierTerm(k, x0 + ((x1 - x0) * i) / (n - 1), a, b, takagi);
    out.push(Float64Array.from(acc));
  }
  return out;
}

export function weierTheoryDimension(a, b, takagi) {
  const base = takagi ? 2 : b;
  return a * base > 1 ? 2 + Math.log(a) / Math.log(base) : 1;
}

// --------------------------------------------------------------------------
// 4. Devil's staircase / 악마의 계단
// --------------------------------------------------------------------------

/**
 * Generalised Cantor function: each interval is split into `div` (odd) pieces — (div+1)/2 kept
 * pieces separated by gaps of total width `gap`. F is constant on every gap and the value
 * range is shared equally by the kept pieces. Below `depth`, F is linear (finite stage).
 * 일반화 칸토어 함수: 홀수 div 조각 중 (div+1)/2개 유지, 간격 총폭 gap, 간격에서 상수.
 */
export function cantorF(x, div = 3, gap = 1 / 3, depth = 6) {
  const K = (div + 1) / 2;
  const G = K - 1;
  const w = (1 - gap) / K;
  const gw = G > 0 ? gap / G : 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let u = x;
  let base = 0;
  let scale = 1;
  for (let level = 0; level < depth; level++) {
    let found = false;
    for (let i = 0; i < K; i++) {
      const start = i * (w + gw);
      const end = start + w;
      if (u <= end || i === K - 1) {
        if (u < start) return base + (scale * i) / K; // inside the gap before piece i / 간격 안
        base += (scale * i) / K;
        scale /= K;
        u = clamp((u - start) / w, 0, 1);
        found = true;
        break;
      }
    }
    if (!found) break;
  }
  return base + scale * u;
}

// --------------------------------------------------------------------------
// 5. L-system / L-시스템
// --------------------------------------------------------------------------

/**
 * Rewrite `axiom` `iterations` times. The length of the next string is counted before it is
 * built; if it would exceed maxLen the expansion stops at the last complete (balanced)
 * iteration and `truncated` is set. / 길이 상한 초과 시 직전 완성 반복에서 안전하게 중단
 */
export function expandLSystem(axiom, rules, iterations, maxLen = MAX_LSYS_LENGTH) {
  const map = new Map();
  for (const r of rules || []) if (r && r.from) map.set(r.from, r.to ?? '');
  let s = String(axiom || '');
  const lengths = [s.length];
  let done = 0;
  let truncated = false;
  for (let it = 0; it < iterations; it++) {
    let len = 0;
    for (const ch of s) len += map.has(ch) ? map.get(ch).length : 1;
    if (len > maxLen) { truncated = true; break; }
    let next = '';
    const parts = [];
    for (const ch of s) parts.push(map.has(ch) ? map.get(ch) : ch);
    next = parts.join('');
    s = next;
    lengths.push(s.length);
    done++;
  }
  return { str: s, lengths, iterationsDone: done, truncated };
}

/** True when every ']' closes an earlier '[' and nothing is left open. / 대괄호 균형 */
export function bracketsBalanced(str) {
  let depth = 0;
  for (const ch of str) {
    if (ch === '[') depth++;
    else if (ch === ']' && --depth < 0) return false;
  }
  return depth === 0;
}

const isForward = (ch) => ch >= 'A' && ch <= 'W'; // X, Y, Z are silent variables / X·Y·Z는 무음 변수

/** Reflect a pitch into [lo, hi] (keeps contours continuous). / 음역 안으로 반사 */
export function reflectInto(m, lo, hi) {
  const span = hi - lo;
  if (span <= 0) return lo;
  let u = (m - lo) / span;
  u = ((u % 2) + 2) % 2;
  return lo + (u <= 1 ? u : 2 - u) * span;
}

/**
 * Pitch turtle. Forward letters (A–W) advance time by stepSec and move pitch by the heading h
 * (glide = linear, else a 5 ms jump then hold); '+'/'-' change h by ±angle; '|' reverses h;
 * '[' pushes the state and starts a new voice at the branch point; ']' ends it and restores.
 * Voices beyond `cap` are counted (branches) but not recorded.
 * 음고 거북이: 전진 문자는 시간 전진·음고 이동, +/−는 기울기 변경, [ ]는 분기 → 새 보이스.
 */
export function interpretLSystem(str, { stepSec = 0.6, angle = 3, glide = true, startNote = 60, lo = 36, hi = 84, cap = MAX_FRACTAL_VOICES } = {}) {
  const voices = [{ pts: [{ t: 0, m: startNote }], depth: 0, forward: 0 }];
  const branchPoints = [];
  let st = { t: 0, m: startNote, h: 0, v: 0 };
  const stack = [];
  let branches = 0;
  let maxT = 0;
  const rec = (vi) => vi >= 0 && vi < cap;
  for (const ch of str) {
    if (isForward(ch)) {
      const target = reflectInto(st.m + st.h, lo, hi);
      const t1 = st.t + stepSec;
      if (rec(st.v)) {
        const pts = voices[st.v].pts;
        if (!glide) pts.push({ t: st.t + Math.min(STEP_GLIDE_SEC, stepSec * 0.5), m: target });
        pts.push({ t: t1, m: target });
        voices[st.v].forward++;
      }
      st.t = t1;
      st.m = target;
      if (t1 > maxT) maxT = t1;
    } else if (ch === '+') st.h += angle;
    else if (ch === '-') st.h -= angle;
    else if (ch === '|') st.h = -st.h;
    else if (ch === '[') {
      stack.push(st);
      branches++;
      const vi = voices.length < cap ? voices.length : -1;
      if (vi >= 0) {
        voices.push({ pts: [{ t: st.t, m: st.m }], depth: stack.length, forward: 0 });
        if (branchPoints.length < 4096) branchPoints.push({ t: st.t, m: st.m });
      }
      st = { ...st, v: vi };
    } else if (ch === ']') {
      if (stack.length) st = stack.pop();
    }
  }
  return { voices, branches, voiceCount: branches + 1, branchPoints, endSec: maxT, recorded: voices.length };
}

// --------------------------------------------------------------------------
// 6. Nørgård infinity series & scale canon / 노르고르 무한 급수 · 스케일 캐논
// --------------------------------------------------------------------------

/** a(0)=0, a(2n) = −a(n), a(2n+1) = a(n) + 1 → 0, 1, −1, 2, 1, 0, −2, 3, … */
export function norgardSeries(count) {
  const a = new Array(Math.max(0, count)).fill(0);
  for (let i = 1; i < count; i++) a[i] = i % 2 === 0 ? 0 - a[i / 2] : a[(i - 1) / 2] + 1; // 0 − x avoids −0 / −0 방지
  return a;
}

/**
 * Layer k plays the subject with durations ×r^k and intervals ×r^k (prolation canon),
 * transposed by k·layerTranspose. Each layer fills `length` seconds.
 * 층 k: 시간 ×r^k, 음정 ×r^k, k·layerTranspose 이조. 각 층은 length초를 채움.
 */
export function buildCanonLayers(c, length) {
  const layers = [];
  for (let k = 0; k < c.layers; k++) {
    const rk = Math.pow(c.ratio, k);
    const dur = c.noteSec * rk;
    const count = Math.max(1, Math.min(MAX_CANON_NOTES, Math.ceil(length / dur)));
    const series = c.subject === 'custom' ? Array.from({ length: count }, (_, i) => c.customIntervals[i % c.customIntervals.length]) : norgardSeries(count);
    const base = c.baseNote + k * c.layerTranspose;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const t0 = i * dur;
      const t1 = Math.min(length, (i + 1) * dur);
      const m = base + c.stepSemitones * rk * series[i];
      if (i === 0) pts.push({ t: 0, m });
      else pts.push({ t: Math.min(t1, t0 + Math.min(STEP_GLIDE_SEC, dur * 0.25)), m });
      pts.push({ t: t1, m });
      if (t1 >= length) break;
    }
    layers.push({ pts, layer: k, notes: count, noteSec: dur });
  }
  return layers;
}

// --------------------------------------------------------------------------
// Pitch / gain mapping & analysis / 음고·게인 매핑과 분석
// --------------------------------------------------------------------------

/** Nearest pitch for the quantizer. / 양자화 */
export function quantizeMidi(m, mode, scale = 'major', root = 0) {
  if (mode === '12tet') return Math.round(m);
  if (mode !== 'scale') return m;
  const pcs = SCALES[scale] || SCALES.major;
  let best = Math.round(m);
  let bestD = Infinity;
  for (let c = Math.floor(m) - 6; c <= Math.ceil(m) + 6; c++) {
    const pc = (((c - root) % 12) + 12) % 12;
    if (!pcs.includes(pc)) continue;
    const dd = Math.abs(c - m);
    if (dd < bestD) { bestD = dd; best = c; }
  }
  return best;
}

/**
 * Box-counting dimension of a sampled graph y(x), x ∈ [0,1] (y rescaled to [0,1]).
 * For ε = 2^−j: N(ε) = Σ columns (⌊max/ε⌋ − ⌊min/ε⌋ + 1); D = slope of log N vs log 1/ε.
 * 박스 카운팅 차원 (그래프를 단위 정사각형으로 정규화).
 */
export function boxCountDimension(y, { jMin = 2, jMax = null } = {}) {
  const n = y.length;
  if (n < 16) return { D: NaN, pts: [] };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) { if (y[i] < lo) lo = y[i]; if (y[i] > hi) hi = y[i]; }
  const span = hi - lo || 1;
  const J = Math.min(jMax ?? 99, Math.floor(Math.log2(n / 4)));
  const xs = [];
  const ys = [];
  for (let j = jMin; j <= J; j++) {
    const cols = 2 ** j;
    const eps = 1 / cols;
    let N = 0;
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((c * (n - 1)) / cols);
      const i1 = Math.min(n - 1, Math.ceil(((c + 1) * (n - 1)) / cols));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const v = (y[i] - lo) / span;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      N += Math.floor(Math.min(mx, 1 - 1e-12) / eps) - Math.floor(Math.min(mn, 1 - 1e-12) / eps) + 1;
    }
    xs.push(Math.log(cols));
    ys.push(Math.log(N));
  }
  return { D: slope(xs, ys), pts: xs.map((x, i) => ({ x, y: ys[i] })) };
}

/** Root-mean-square difference of two equal-length arrays. */
export function rmsDiff(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s / Math.max(1, n));
}

/** Maximum refinement level of the current mode (fif depth, fBm octaves−1, terms−1, cantor depth). */
export function maxLevelFor(p) {
  switch (p.mode) {
    case 'fif': return p.fif.depth;
    case 'fbm': return p.fbm.octaves - 1;
    case 'weierstrass': return p.weier.terms - 1;
    case 'cantor': return p.cantor.depth;
    default: return 0;
  }
}

/** Refinement levels actually used (clamped, unique, ≤ 12, ≤ voicesMax). / 실제 사용 레벨 */
export function activeLevels(p) {
  const maxL = maxLevelFor(p);
  if (!CURVE_MODES.includes(p.mode) || !p.refine.enabled) return [maxL];
  const lv = [...new Set(p.refine.levels.map((l) => clamp(l, 0, maxL)))].sort((a, b) => a - b);
  return lv.slice(0, Math.min(MAX_REFINE_VOICES, p.voicesMax));
}

/** Colour for level i of n (cool outline → warm detail). / 레벨 색 그라데이션 */
export function levelColor(i, n) {
  const u = n <= 1 ? 1 : i / (n - 1);
  const hue = 205 - 175 * u;
  return hslHex(hue, 0.85, 0.6);
}

function hslHex(h, s, l) {
  const k = (nn) => (nn + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (nn) => l - a * Math.max(-1, Math.min(k(nn) - 3, Math.min(9 - k(nn), 1)));
  const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

const VOICE_PALETTE = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#22d3ee', '#a3e635'];

// --------------------------------------------------------------------------
// Curve sampling (shared by bake and the zoom lens) / 곡선 샘플링 (베이킹·줌 렌즈 공용)
// --------------------------------------------------------------------------

/**
 * Raw curve values (before normalisation) of `levels` over x ∈ [x0, x1], n samples each.
 * `samplesPerUnit` caps the Weierstrass/fBm detail to what the resolution can show.
 * @returns {{ arrays: Float64Array[], used: number }}
 */
export function sampleCurveLevels(p, levels, n, x0 = 0, x1 = 1) {
  const spu = (n - 1) / Math.max(1e-9, x1 - x0);
  const maxLevel = Math.max(...levels);
  if (p.mode === 'fif') {
    const maps = fifMaps(p.fif.points, p.fif.d);
    const arrays = levels.map((L) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = fifEval(p.fif.points, maps, x0 + ((x1 - x0) * i) / (n - 1), L);
      return a;
    });
    return { arrays, used: maxLevel + 1 };
  }
  if (p.mode === 'cantor') {
    const arrays = levels.map((L) => {
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = cantorF(x0 + ((x1 - x0) * i) / (n - 1), p.cantor.div, p.cantor.gap, L);
      return a;
    });
    return { arrays, used: maxLevel + 1 };
  }
  if (p.mode === 'fbm') {
    if (p.fbm.method === 'midpoint') {
      const all = fbmMidpointLevels(p.fbm.H, maxLevel + 1, p.seed, n);
      return { arrays: levels.map((L) => all[L]), used: maxLevel + 1 };
    }
    // highest harmonic 2^(L+1) − 1 must fit the resolution / 최고 배음은 해상도 안에
    let usable = maxLevel + 1;
    while (usable > 1 && 2 ** usable > spu / 3) usable--;
    const all = fbmSpectralLevels(p.fbm.H, usable, p.seed, n, x0, x1);
    return { arrays: levels.map((L) => all[Math.min(L, usable - 1)]), used: usable };
  }
  // weierstrass / takagi
  const usable = weierUsableTerms(maxLevel + 1, p.weier.b, p.weier.takagi, spu);
  const all = weierLevels(p.weier.a, p.weier.b, p.weier.takagi, usable, n, x0, x1);
  return { arrays: levels.map((L) => all[Math.min(L, usable - 1)]), used: usable };
}

// --------------------------------------------------------------------------
// Bake / 베이킹
// --------------------------------------------------------------------------

/** Every field that changes what is baked (timbre and bake tolerance excluded). / 베이킹 시그니처 */
export function fractalSignature(p) {
  const sec = { fif: p.fif, fbm: p.fbm, weierstrass: p.weier, cantor: p.cantor, lsystem: p.lsys, canon: p.canon }[p.mode];
  return JSON.stringify([p.mode, p.seed, p.length, p.lo, p.hi, p.quantize, p.scale, p.scaleRoot, sec, CURVE_MODES.includes(p.mode) ? p.refine : null, p.gain, p.voicesMax, p.bake.bakeRate]);
}

function resamplePolyline(pts, rate, startT) {
  const endT = pts[pts.length - 1].t;
  const dur = Math.max(0, endT - startT);
  const n = Math.max(2, Math.round(dur * rate) + 1);
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const tt = startT + (dur * i) / (n - 1);
    while (j < pts.length - 2 && pts[j + 1].t < tt) j++;
    const a = pts[j];
    const b = pts[Math.min(pts.length - 1, j + 1)];
    const span = b.t - a.t;
    out[i] = span > 1e-12 ? a.m + clamp((tt - a.t) / span, 0, 1) * (b.m - a.m) : b.m;
  }
  return { midi: out, dur };
}

function buildGain(midi, rate, g) {
  const n = midi.length;
  const out = new Float32Array(n);
  if (g.source !== 'slope' || n < 3) { out.fill(g.level); return out; }
  const sl = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) sl[i] = Math.abs(midi[i + 1] - midi[i - 1]) * 0.5 * rate;
  sl[0] = sl[1];
  sl[n - 1] = sl[n - 2];
  const sorted = Float64Array.from(sl).sort();
  const ref = Math.max(1e-6, sorted[Math.floor(0.95 * (n - 1))]);
  const win = Math.max(1, Math.round(rate * 0.04)); // 40 ms smoothing / 평활
  let acc = 0;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { acc += Math.min(1, sl[i] / ref); pre[i + 1] = acc; }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win + 1);
    const s = (pre[b] - pre[a]) / (b - a);
    out[i] = g.level * (1 - g.slopeAmount + g.slopeAmount * s);
  }
  return out;
}

let bakeCount = 0;
const cache = new Map(); // sig → result (LRU, 6 entries)

export const getFractalBakeCount = () => bakeCount;

/**
 * Bake the document into playable voices (memoised by signature).
 * 문서를 재생 가능한 보이스로 베이킹 (시그니처 캐시).
 * @returns {{ sig, mode, voices: Array<{name, level, color, startSec, durSec, rate, midi: Float32Array, gain: Float32Array, y?: Float64Array, minMidi, maxMidi}>,
 *            endSec, info: object, analysis: { D, Dtheory, H? }, branchPoints: Array }}
 */
export function bakeFractal(raw) {
  const p = normalizeFractalParams(raw);
  const sig = fractalSignature(p);
  const hit = cache.get(sig);
  if (hit) {
    cache.delete(sig);
    cache.set(sig, hit);
    return hit;
  }
  bakeCount++;
  const res = computeBake(p, sig);
  cache.set(sig, res);
  while (cache.size > 6) cache.delete(cache.keys().next().value);
  return res;
}

function finishMidi(arr, p) {
  const out = new Float32Array(arr.length);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    const m = clamp(quantizeMidi(arr[i], p.quantize, p.scale, p.scaleRoot), 0, 127);
    out[i] = m;
    if (m < mn) mn = m;
    if (m > mx) mx = m;
  }
  return { midi: out, minMidi: mn, maxMidi: mx };
}

function computeBake(p, sig) {
  const info = { warnings: [], rate: p.bake.bakeRate };
  const voices = [];
  let branchPoints = [];
  const analysis = { D: NaN, Dtheory: null };
  const rate0 = p.bake.bakeRate;

  if (CURVE_MODES.includes(p.mode)) {
    const levels = activeLevels(p);
    const maxL = maxLevelFor(p);
    const totalDur = levels.length * p.length;
    const rate = Math.min(rate0, MAX_TOTAL_SAMPLES / Math.max(1, totalDur), (MAX_VOICE_SAMPLES - 1) / p.length);
    const n = Math.max(64, Math.round(p.length * rate) + 1);
    info.rate = (n - 1) / p.length;
    // the full-detail curve sets the shared normalisation / 전체 세부 곡선으로 공통 정규화
    const want = [...new Set([...levels, maxL])].sort((a, b) => a - b);
    const { arrays, used } = sampleCurveLevels(p, want, n);
    const full = arrays[want.indexOf(maxL)];
    let lo = 0;
    let hi = 1;
    if (p.mode === 'fbm' || p.mode === 'weierstrass') {
      lo = Infinity; hi = -Infinity;
      for (const v of full) { if (v < lo) lo = v; if (v > hi) hi = v; }
      if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
    }
    info.norm = { lo, hi };
    info.levelsUsed = used;
    info.maxLevel = maxL;
    if ((p.mode === 'weierstrass' || p.mode === 'fbm') && used < maxL + 1) info.warnings.push({ key: 'fractal.warn.resolution', args: [used, maxL + 1] });
    levels.forEach((L, idx) => {
      const raw = arrays[want.indexOf(L)];
      const y = new Float64Array(n);
      const mm = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        y[i] = (raw[i] - lo) / (hi - lo);
        mm[i] = p.lo + y[i] * (p.hi - p.lo);
      }
      const fin = finishMidi(mm, p);
      const refine = p.refine.enabled;
      voices.push({
        name: refine ? `L${L}` : modeShort(p.mode),
        level: L,
        color: refine ? levelColor(idx, levels.length) : VOICE_PALETTE[0],
        startSec: refine ? idx * p.refine.staggerSec : 0,
        durSec: p.length,
        rate: info.rate,
        y,
        ...fin,
        gain: buildGain(fin.midi, info.rate, p.gain),
      });
    });
    const yFull = new Float64Array(n);
    for (let i = 0; i < n; i++) yFull[i] = (full[i] - lo) / (hi - lo);
    const jMax = p.mode === 'fbm' ? used + 1 : p.mode === 'weierstrass' ? Math.ceil(Math.log2(Math.pow(p.weier.takagi ? 2 : p.weier.b, used))) + 1 : null;
    analysis.D = boxCountDimension(yFull, { jMax: jMax ? Math.max(4, jMax) : null }).D;
    if (p.mode === 'fbm') { analysis.Dtheory = 2 - p.fbm.H; analysis.H = estimateHurst(yFull, [2, 4, 8, 16].map((k) => Math.max(1, Math.round((k * (n - 1)) / 2 ** (used + 2))))); }
    else if (p.mode === 'weierstrass') analysis.Dtheory = weierTheoryDimension(p.weier.a, p.weier.b, p.weier.takagi);
    else if (p.mode === 'cantor') analysis.Dtheory = 1;
    else analysis.Dtheory = fifTheoryDimension(p.fif.points, p.fif.d);
  } else if (p.mode === 'lsystem') {
    const L = p.lsys;
    const ex = expandLSystem(L.axiom, L.rules, L.iterations);
    info.stringLength = ex.str.length;
    info.iterationsDone = ex.iterationsDone;
    info.balanced = bracketsBalanced(ex.str);
    if (ex.truncated) info.warnings.push({ key: 'fractal.warn.lsysLength', args: [ex.iterationsDone, MAX_LSYS_LENGTH] });
    if (!info.balanced) info.warnings.push({ key: 'fractal.warn.brackets', args: [] });
    const cap = p.voicesMax;
    const tur = interpretLSystem(ex.str, { stepSec: L.stepSec, angle: L.angleSemitones, glide: L.glide, startNote: L.startNote, lo: p.lo, hi: p.hi, cap });
    info.branches = tur.branches;
    info.voiceCount = tur.voiceCount;
    if (tur.voiceCount > cap) info.warnings.push({ key: tur.voiceCount > MAX_FRACTAL_VOICES ? 'fractal.warn.lsysVoices64' : 'fractal.warn.lsysVoices', args: [tur.voiceCount, cap] });
    branchPoints = tur.branchPoints;
    const sounding = tur.voices.filter((v) => v.forward > 0);
    info.sounding = sounding.length;
    const totalDur = sounding.reduce((s, v) => s + (v.pts[v.pts.length - 1].t - v.pts[0].t), 0);
    const rate = Math.min(rate0, MAX_TOTAL_SAMPLES / Math.max(1, totalDur));
    info.rate = rate;
    sounding.forEach((v, i) => {
      const startSec = v.pts[0].t;
      const rs = resamplePolyline(v.pts, rate, startSec);
      const fin = finishMidi(rs.midi, p);
      voices.push({ name: i === 0 ? 'Trunk' : `B${i}`, level: v.depth, color: levelColor(Math.min(v.depth, 6), 7), startSec, durSec: rs.dur, rate: (rs.midi.length - 1) / Math.max(1e-9, rs.dur), ...fin, gain: buildGain(fin.midi, rate, p.gain) });
    });
    if (voices[0]) analysis.D = boxCountDimension(voices[0].midi).D;
  } else {
    const layers = buildCanonLayers(p.canon, p.length).slice(0, p.voicesMax);
    info.layers = layers.length;
    const rate = Math.min(rate0, MAX_TOTAL_SAMPLES / Math.max(1, layers.length * p.length));
    info.rate = rate;
    layers.forEach((ly, i) => {
      const rs = resamplePolyline(ly.pts, rate, 0);
      const fin = finishMidi(rs.midi, p);
      voices.push({ name: `Layer ${i + 1}`, level: i, color: levelColor(i, layers.length), startSec: 0, durSec: rs.dur, rate: (rs.midi.length - 1) / Math.max(1e-9, rs.dur), notes: ly.notes, noteSec: ly.noteSec, ...fin, gain: buildGain(fin.midi, rate, p.gain) });
    });
    if (voices[0]) analysis.D = boxCountDimension(voices[0].midi).D;
  }

  for (const v of voices) {
    const hz = new Float32Array(v.midi.length);
    for (let i = 0; i < hz.length; i++) hz[i] = 440 * Math.pow(2, (v.midi[i] - 69) / 12);
    v.hz = hz;
  }
  const endSec = voices.reduce((m, v) => Math.max(m, v.startSec + v.durSec), 0);
  const maxConcurrent = maxOverlap(voices);
  let gainMax = 0;
  for (const v of voices) for (let i = 0; i < v.gain.length; i++) if (v.gain[i] > gainMax) gainMax = v.gain[i];
  return Object.freeze({ sig, mode: p.mode, voices, endSec, info, analysis, branchPoints, maxConcurrent, gainMax });
}

/**
 * Tempo Manager (pitch-preserving): the same bake read `rate`× faster. Every voice's start,
 * length and sample spacing are divided by the rate; the Hz / gain arrays are shared, not copied,
 * so pitch and shape stay exactly the same. `timeScale` lets the player keep per-voice vibrato /
 * tremolo on document time. Rate 1 returns the bake itself.
 * 템포 매니저 (음고 유지): 같은 베이크를 rate배 빠르게 읽기 — 시간만 1/rate, Hz·게인 배열은 공유.
 */
export function retimeFractalBake(bake, rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (Math.abs(r - 1) < 1e-9) return bake;
  return Object.freeze({
    ...bake,
    sig: `${bake.sig}@x${Math.round(r * 1e6) / 1e6}`,
    endSec: bake.endSec / r,
    timeScale: r,
    voices: bake.voices.map((v) => ({ ...v, startSec: v.startSec / r, durSec: v.durSec / r, rate: v.rate * r, timeScale: r })),
  });
}

function modeShort(mode) {
  return { fif: 'FIF', fbm: 'fBm', weierstrass: 'Weierstrass', cantor: 'Cantor' }[mode] || mode;
}

/** Largest number of simultaneously sounding voices. / 최대 동시 발음 수 */
export function maxOverlap(voices) {
  const ev = [];
  for (const v of voices) { ev.push([v.startSec, 1]); ev.push([v.startSec + v.durSec, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0;
  let m = 0;
  for (const [, d] of ev) { c += d; if (c > m) m = c; }
  return Math.max(1, m);
}

// --------------------------------------------------------------------------
// Bake → Glissando conversion helpers / 글리산도 변환 헬퍼
// --------------------------------------------------------------------------

/**
 * Reduce a baked voice to ≤ maxPts meaningful extrema with RDP (epsilon grows until it fits),
 * so the adaptive spline fit stays within the 64-anchor budget.
 * RDP로 의미 있는 극값만 남겨(점 수 ≤ maxPts) 64 앵커 예산 안에서 근사.
 * @returns {{ pts: Array<{x,y}>, epsilon: number, m0: number, m1: number }}
 */
export function simplifyVoiceForBake(v, tolerance = 0.004, maxPts = 48) {
  const n = v.midi.length;
  const m0 = v.minMidi;
  const m1 = v.maxMidi > m0 + 1e-6 ? v.maxMidi : m0 + 1;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = { x: i / (n - 1), y: (v.midi[i] - m0) / (m1 - m0) };
  let eps = tolerance;
  let pts = rdpSimplify(raw, eps);
  for (let guard = 0; pts.length > maxPts && guard < 40; guard++) {
    eps *= 1.35;
    pts = rdpSimplify(raw, eps);
  }
  return { pts: pts.map((q) => ({ x: roundTo(q.x, 6), y: roundTo(q.y, 6) })), epsilon: eps, m0, m1 };
}
