/**
 * Flexatone — studios/grid/grid-effects.js
 * Grid Studio (pure): the effect registry and the effects. "Image operation = the same operation
 * on the spectrogram": every effect works on the FINE MATRIX M[frame][bin] (Float32, index f·N + i,
 * bin i = a fixed frequency 1 / binsPerSemi semitones apart, frame = 1 / frameRate seconds).
 * 그리드 스튜디오 (순수): 효과 레지스트리와 효과들. 이미지 연산 = 스펙트로그램 위의 같은 연산.
 * 모든 효과는 미세 행렬 M[프레임][빈]에 작용 (빈 = 고정 주파수, 프레임 = 1/frameRate 초).
 *
 * Adding an effect = one object / 효과 추가 = 객체 하나:
 *   GridEffectRegistry.register({
 *     id, name: { en, ko }, domain: 'matrix' | 'bank',
 *     params: [{ key, type: 'range'|'int'|'select'|'toggle', min, max, step, unit, options, when }],
 *     defaults(): object,
 *     apply(ctx),            matrix effects: read ctx.src, write ctx.dst (same size, pre-zeroed)
 *     matrix?(ctx),          bank effects: optional part that still acts on the matrix (Noise grain)
 *     bank?(params, env),    bank effects: what the synthesis stage needs (noise bus, channels)
 *     sanitize?(params),     extra normalisation of non-schema fields (Liquify strokes)
 *   })
 *   ctx = { src, dst, N, F, rate, bps, pLo, grid: { rowsPerSemi, colsPerSec }, seed, p, alloc, free, info }
 * The pipeline (grid-engine.js) adds on / mix / mask around apply(), so an effect never handles them.
 * on / mix / mask는 파이프라인이 처리.
 *
 * Domains / 영역: 'matrix' effects run in stack order before synthesis; 'bank' effects need exact
 * frequency ratios or a noise source and always come last (Noise, Chromatic Aberration).
 * Determinism: every random number comes from createSeededRandom / hash3 with the document seed.
 */

import { clamp, createSeededRandom } from '../../core/math-utils.js';

// --------------------------------------------------------------------------
// Registry / 레지스트리
// --------------------------------------------------------------------------

const PARAM_TYPES = ['range', 'int', 'select', 'toggle'];

/** Problems of an effect definition (empty = valid). / 효과 정의 검증 (빈 배열 = 유효) */
export function validateGridEffect(fx) {
  const errs = [];
  if (!fx || typeof fx !== 'object') return ['effect must be an object'];
  if (typeof fx.id !== 'string' || !/^[a-z][a-zA-Z0-9]{1,23}$/.test(fx.id)) errs.push('id must be a short camelCase slug');
  if (!fx.name || typeof fx.name.en !== 'string' || typeof fx.name.ko !== 'string') errs.push('name must provide { en, ko }');
  if (fx.domain !== 'matrix' && fx.domain !== 'bank') errs.push("domain must be 'matrix' or 'bank'");
  if (!Array.isArray(fx.params)) errs.push('params must be an array');
  if (typeof fx.defaults !== 'function') errs.push('defaults must be a function');
  if (fx.domain === 'matrix' && typeof fx.apply !== 'function') errs.push('matrix effects need apply(ctx)');
  if (fx.domain === 'bank' && typeof fx.bank !== 'function') errs.push('bank effects need bank(params, env)');
  if (errs.length) return errs;
  let d;
  try { d = fx.defaults(); JSON.stringify(d); } catch (e) { return [`defaults() threw: ${e.message}`]; }
  for (const q of fx.params) {
    if (!q || typeof q.key !== 'string' || !PARAM_TYPES.includes(q.type)) { errs.push(`bad param ${q?.key}`); continue; }
    if (!(q.key in d)) errs.push(`defaults() misses "${q.key}"`);
    if ((q.type === 'range' || q.type === 'int') && !(q.max > q.min)) errs.push(`param ${q.key}: min / max`);
    if (q.type === 'select' && (!Array.isArray(q.options) || !q.options.includes(d[q.key]))) errs.push(`param ${q.key}: options / default`);
  }
  return errs;
}

export function createGridEffectRegistry() {
  const map = new Map();
  return Object.freeze({
    register(fx, { replace = false } = {}) {
      const errs = validateGridEffect(fx);
      if (errs.length) throw new TypeError(`GridEffectRegistry: invalid effect "${fx?.id}": ${errs.join('; ')}`);
      if (map.has(fx.id) && !replace) throw new Error(`GridEffectRegistry: "${fx.id}" already registered`);
      map.set(fx.id, Object.freeze({ ...fx }));
      return map.get(fx.id);
    },
    has: (id) => map.has(id),
    get: (id) => map.get(id) || null,
    list: (domain = null) => [...map.values()].filter((fx) => !domain || fx.domain === domain),
    ids: (domain = null) => [...map.values()].filter((fx) => !domain || fx.domain === domain).map((fx) => fx.id),
  });
}

/** Application-wide registry. / 앱 전역 효과 레지스트리 */
export const GridEffectRegistry = createGridEffectRegistry();

/** Parameters of an effect: defaults overlaid with `raw`, clamped to the schema. / 스키마에 맞춘 파라미터 */
export function sanitizeEffectParams(type, raw) {
  const fx = GridEffectRegistry.get(type);
  if (!fx) return {};
  const out = fx.defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const q of fx.params) {
    const v = src[q.key];
    if (v === undefined) continue;
    if (q.type === 'toggle') out[q.key] = !!v;
    else if (q.type === 'select') { if (q.options.includes(v)) out[q.key] = v; }
    else if (Number.isFinite(Number(v))) out[q.key] = q.type === 'int' ? Math.round(clamp(Number(v), q.min, q.max)) : clamp(Number(v), q.min, q.max);
  }
  return fx.sanitize ? fx.sanitize(out, src) : out;
}

// --------------------------------------------------------------------------
// Shared maths / 공용 수학
// --------------------------------------------------------------------------

/** u ∈ [0, 1) for three integers (avalanche hash). / 정수 셋 → [0, 1) */
export function hash3(a, b, c) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 1, 0x85ebca77) ^ Math.imul((c | 0) + 1, 0xc2b2ae3d)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const sround = (x) => (x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5)); // symmetric rounding / 대칭 반올림
const TINY = 1e-7;

/** Box widths whose three passes approximate a Gaussian of standard deviation σ. / 가우시안 근사 박스 폭 */
function boxSizes(sigma) {
  const n = 3;
  let wl = Math.floor(Math.sqrt((12 * sigma * sigma) / n + 1));
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => (i < m ? wl : wu));
}

/**
 * 1-D blur plan for σ (in samples): exact truncated Gaussian up to σ = 4, three box passes above
 * (O(1) per sample, whatever σ). null = identity. / 1차원 블러 계획 (σ ≤ 4 정확, 그 위는 박스 3패스)
 */
export function makeBlurPlan(sigma, { exact = false } = {}) {
  if (!(sigma > 0.01)) return null;
  if (sigma <= 4 || exact) {
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return { exact: true, r, k, sigma };
  }
  const sizes = boxSizes(sigma);
  return { exact: false, sizes, r: sizes.reduce((a, w) => a + (w - 1) / 2, 0), sigma };
}

function boxPass(src, dst, len, w) {
  const h = (w - 1) / 2;
  const inv = 1 / w;
  let acc = 0;
  for (let i = 0; i < h && i < len; i++) acc += src[i];
  for (let i = 0; i < len; i++) {
    if (i + h < len) acc += src[i + h];
    if (i - h - 1 >= 0) acc -= src[i - h - 1];
    dst[i] = acc * inv;
  }
}

/** Blur `len` samples of src into dst (sum-normalised kernel, zero outside). tmp: scratch ≥ len. / 한 줄 블러 */
export function blurLine(src, dst, len, plan, tmp) {
  if (plan.exact) {
    const { r, k } = plan;
    for (let i = 0; i < len; i++) dst[i] = 0;
    for (let i = 0; i < len; i++) {
      const v = src[i];
      if (v === 0) continue;
      const lo = Math.max(0, i - r);
      const hi = Math.min(len - 1, i + r);
      for (let j = lo; j <= hi; j++) dst[j] += v * k[j - i + r];
    }
    return;
  }
  boxPass(src, dst, len, plan.sizes[0]);
  boxPass(dst, tmp, len, plan.sizes[1]);
  boxPass(tmp, dst, len, plan.sizes[2]);
}

/** The kernel a plan really applies (impulse response). / 계획이 실제로 적용하는 커널 */
export function planKernel(plan) {
  const len = 2 * (plan.r + 2) + 1;
  const a = new Float64Array(len);
  const b = new Float64Array(len);
  const c = new Float64Array(len);
  a[(len - 1) / 2] = 1;
  blurLine(a, b, len, plan, c);
  return b;
}

/**
 * Gain that turns the sum-normalised kernel into the requested normalisation:
 *   'sum'   Σk = 1    (a flat area keeps its level)
 *   'power' Σk² = 1   (one line keeps its power while it spreads — the default: a chorus, not a fade)
 *   'peak'  max k = 1 (the centre keeps its level, the total gets louder)
 * 정규화 이득: sum(면 유지) / power(한 줄의 파워 유지 = 기본) / peak(중심 레벨 유지).
 */
export function kernelGain(plan, normalize) {
  if (!plan || normalize === 'sum') return 1;
  const k = planKernel(plan);
  let s2 = 0;
  let mx = 0;
  for (let i = 0; i < k.length; i++) { s2 += k[i] * k[i]; if (k[i] > mx) mx = k[i]; }
  return normalize === 'peak' ? 1 / Math.max(1e-9, mx) : 1 / Math.sqrt(Math.max(1e-18, s2));
}

/**
 * Separable Gaussian blur of a matrix: σb bins along pitch (normalised as asked), σf frames along
 * time (always sum-normalised: a sustained tone keeps its level). src and dst must differ.
 * 분리형 가우시안: 음고 방향 σb(요청한 정규화), 시간 방향 σf(항상 합 정규화).
 */
export function blurMatrix(src, dst, N, F, sb, sf, normalize = 'power', { exact = false } = {}) {
  const pb = makeBlurPlan(sb, { exact });
  const pf = makeBlurPlan(sf, { exact });
  if (!pb && !pf) { dst.set(src); return dst; }
  const tmp = new Float64Array(Math.max(N, F));
  // time first: it only touches the bins the picture uses (a sparse picture has few); the pitch pass
  // then spreads them. The two passes commute. / 시간 방향 먼저 (그림이 쓰는 빈만 처리) → 음고 방향. 두 패스는 교환 가능
  if (pf) {
    const a = new Float64Array(F);
    const b = new Float64Array(F);
    for (let i = 0; i < N; i++) {
      let any = false;
      for (let f = 0; f < F; f++) { const v = src[f * N + i]; a[f] = v; if (v !== 0) any = true; }
      if (!any) { for (let f = 0; f < F; f++) dst[f * N + i] = 0; continue; }
      blurLine(a, b, F, pf, tmp);
      for (let f = 0; f < F; f++) dst[f * N + i] = b[f] < TINY ? 0 : b[f];
    }
  } else dst.set(src);
  if (pb) {
    const g = kernelGain(pb, normalize);
    const row = new Float64Array(N);
    const line = new Float64Array(N);
    for (let f = 0; f < F; f++) {
      const o = f * N;
      let any = false;
      for (let i = 0; i < N; i++) { const v = dst[o + i]; row[i] = v; if (v !== 0) any = true; }
      if (!any) continue;
      blurLine(row, line, N, pb, tmp);
      for (let i = 0; i < N; i++) { const v = line[i] * g; dst[o + i] = v < TINY ? 0 : v; }
    }
  }
  return dst;
}

/** Direct 2-D convolution with the outer product of two exact kernels (self-check reference). / 2D 직접 컨볼루션 (검증용) */
export function blurMatrixDirect(src, N, F, sb, sf, normalize = 'power') {
  const pb = makeBlurPlan(sb, { exact: true });
  const pf = makeBlurPlan(sf, { exact: true });
  const g = kernelGain(pb, normalize);
  const out = new Float32Array(src.length);
  const rb = pb ? pb.r : 0;
  const rf = pf ? pf.r : 0;
  for (let f = 0; f < F; f++) {
    for (let i = 0; i < N; i++) {
      const v = src[f * N + i];
      if (v === 0) continue;
      for (let df = -rf; df <= rf; df++) {
        const ff = f + df;
        if (ff < 0 || ff >= F) continue;
        const kf = pf ? pf.k[df + rf] : 1;
        for (let db = -rb; db <= rb; db++) {
          const ii = i + db;
          if (ii < 0 || ii >= N) continue;
          out[ff * N + ii] += v * kf * (pb ? pb.k[db + rb] : 1) * g;
        }
      }
    }
  }
  return out;
}

/** Bins that carry energy anywhere in the matrix → Uint8Array(N). / 에너지가 있는 빈 */
export function activeBins(M, N, F, eps = 1e-5) {
  const on = new Uint8Array(N);
  for (let f = 0; f < F; f++) {
    const o = f * N;
    for (let i = 0; i < N; i++) if (M[o + i] > eps) on[i] = 1;
  }
  return on;
}

// --------------------------------------------------------------------------
// 1) Blur — image blur = pitch (and time) blur = chorus / 블러 = 음고(·시간) 번짐 = 코러스
// --------------------------------------------------------------------------

/** Slow seeded amplitude wobble per bin, so a blurred cluster does not beat statically. / 빈별 느린 진폭 워블 */
function applyShimmer(M, N, F, rate, amount, seed) {
  if (!(amount > 0)) return;
  const on = activeBins(M, N, F);
  for (let i = 0; i < N; i++) {
    if (!on[i]) continue;
    const hz = 0.1 * Math.pow(20, hash3(seed, i, 11)); // 0.1 … 2 Hz
    const w = (2 * Math.PI * hz) / rate;
    const ph = 2 * Math.PI * hash3(seed, i, 12);
    const k = 2 * Math.cos(w);
    let c1 = Math.cos(ph - w); // cos at frame −1
    let c0 = Math.cos(ph);
    for (let f = 0; f < F; f++) {
      M[f * N + i] *= 1 - amount * 0.5 * (1 - c0);
      const c2 = k * c0 - c1;
      c1 = c0;
      c0 = c2;
    }
  }
}

/** Blur amount 0..1 of the perspective mode at normalised time tn and pitch pn. / 퍼스펙티브 블러 양 */
export function perspectiveAmount(p, tn, pn) {
  const dt = (tn - p.t0) / 0.5;
  const dp = (pn - p.p0) / 0.5;
  const d = Math.min(1, p.shape === 'tiltShift-pitch' ? Math.abs(dp) : p.shape === 'tiltShift-time' ? Math.abs(dt) : Math.hypot(dt, dp) / Math.SQRT2);
  if (d <= p.inner) return 0;
  return Math.pow((d - p.inner) / Math.max(1e-6, 1 - p.inner), p.falloff);
}

const PERSPECTIVE_LEVELS = 5;

function motionTaps(p, rate, bps) {
  const lt = (p.lengthMs / 1000) * rate;
  const lb = p.lengthSemi * bps;
  const T = clamp(Math.ceil(Math.max(Math.abs(lt), Math.abs(lb))) + 1, 1, 64);
  const merged = new Map();
  let sum = 0;
  for (let k = 0; k < T; k++) {
    const u = T > 1 ? k / (T - 1) : 0;
    const s = p.trail === 'both' ? u - 0.5 : p.trail === 'after' ? u : -u;
    const w = p.trail === 'both' ? 1 : 1 - 0.85 * u;
    const df = sround(s * lt);
    const db = sround(s * lb);
    const key = df * 4096 + db;
    const hit = merged.get(key);
    if (hit) hit.w += w;
    else merged.set(key, { df, db, w });
    sum += w;
  }
  const taps = [...merged.values()];
  // normalisation on the pitch projection: taps in the same bin add coherently (same sine)
  // 음고 사영 기준 정규화: 같은 빈의 탭은 같은 사인이므로 위상이 맞게 더해짐
  const proj = new Map();
  for (const q of taps) { q.w /= sum; proj.set(q.db, (proj.get(q.db) || 0) + q.w); }
  let s2 = 0;
  let mx = 0;
  for (const v of proj.values()) { s2 += v * v; mx = Math.max(mx, v); }
  const g = p.normalize === 'sum' ? 1 : p.normalize === 'peak' ? 1 / mx : 1 / Math.sqrt(s2);
  for (const q of taps) q.w *= g;
  return taps;
}

GridEffectRegistry.register({
  id: 'blur',
  name: { en: 'Blur', ko: '블러' },
  domain: 'matrix',
  params: [
    { key: 'mode', type: 'select', options: ['gaussian', 'motion', 'perspective'] },
    { key: 'sigmaCents', type: 'range', min: 0, max: 400, step: 1, unit: '¢', when: (p) => p.mode === 'gaussian' },
    { key: 'sigmaMs', type: 'range', min: 0, max: 500, step: 1, unit: 'ms', when: (p) => p.mode === 'gaussian' },
    { key: 'lengthMs', type: 'range', min: 0, max: 2000, step: 5, unit: 'ms', when: (p) => p.mode === 'motion' },
    { key: 'lengthSemi', type: 'range', min: -24, max: 24, step: 0.25, unit: 'st', when: (p) => p.mode === 'motion' },
    { key: 'trail', type: 'select', options: ['both', 'after', 'before'], when: (p) => p.mode === 'motion' },
    { key: 'shape', type: 'select', options: ['radial', 'tiltShift-pitch', 'tiltShift-time'], when: (p) => p.mode === 'perspective' },
    { key: 't0', type: 'range', min: 0, max: 1, step: 0.01, when: (p) => p.mode === 'perspective' },
    { key: 'p0', type: 'range', min: 0, max: 1, step: 0.01, when: (p) => p.mode === 'perspective' },
    { key: 'inner', type: 'range', min: 0, max: 0.9, step: 0.01, when: (p) => p.mode === 'perspective' },
    { key: 'falloff', type: 'range', min: 0.25, max: 4, step: 0.05, when: (p) => p.mode === 'perspective' },
    { key: 'maxCents', type: 'range', min: 0, max: 400, step: 1, unit: '¢', when: (p) => p.mode === 'perspective' },
    { key: 'maxMs', type: 'range', min: 0, max: 500, step: 1, unit: 'ms', when: (p) => p.mode === 'perspective' },
    { key: 'normalize', type: 'select', options: ['power', 'peak', 'sum'] },
    { key: 'shimmer', type: 'range', min: 0, max: 1, step: 0.01, when: (p) => p.mode !== 'motion' },
  ],
  defaults: () => ({ mode: 'gaussian', sigmaCents: 60, sigmaMs: 0, lengthMs: 300, lengthSemi: 3, trail: 'after', shape: 'radial', t0: 0.5, p0: 0.5, inner: 0.15, falloff: 1, maxCents: 150, maxMs: 60, normalize: 'power', shimmer: 0.4 }),
  apply(c) {
    const { src, dst, N, F, rate, bps, p } = c;
    if (p.mode === 'gaussian') {
      const sb = (p.sigmaCents / 100) * bps;
      const sf = (p.sigmaMs / 1000) * rate;
      blurMatrix(src, dst, N, F, sb, sf, p.normalize);
      if (sb > 0.01 || sf > 0.01) applyShimmer(dst, N, F, rate, p.shimmer, c.seed);
      return;
    }
    if (p.mode === 'motion') {
      const taps = motionTaps(p, rate, bps);
      if (taps.length <= 1) { dst.set(src); return; }
      for (let f = 0; f < F; f++) {
        const o = f * N;
        for (let i = 0; i < N; i++) {
          const v = src[o + i];
          if (v === 0) continue;
          for (let k = 0; k < taps.length; k++) {
            const ff = f + taps[k].df;
            const ii = i + taps[k].db;
            if (ff >= 0 && ff < F && ii >= 0 && ii < N) dst[ff * N + ii] += v * taps[k].w;
          }
        }
      }
      return;
    }
    // perspective: σ grows away from the focus. The spatially varying kernel is built from
    // PERSPECTIVE_LEVELS uniform blurs, linearly blended between neighbouring levels.
    // 퍼스펙티브: 초점에서 멀수록 σ 증가. 균일 블러 여러 단계를 만들어 이웃 단계 사이를 선형 보간.
    const L = PERSPECTIVE_LEVELS;
    const sbMax = (p.maxCents / 100) * bps;
    const sfMax = (p.maxMs / 1000) * rate;
    if (!(sbMax > 0.01 || sfMax > 0.01)) { dst.set(src); return; }
    // blur amount per element, computed once: separable shapes need one value per frame or per bin
    // 요소별 블러 양은 한 번만 계산 (틸트시프트는 프레임·빈별 값 하나로 충분)
    const amt = c.alloc();
    for (let f = 0; f < F; f++) {
      const tn = F > 1 ? f / (F - 1) : 0;
      const o = f * N;
      if (p.shape === 'tiltShift-time') { amt.fill(perspectiveAmount(p, tn, 0) * (L - 1), o, o + N); continue; }
      for (let i = 0; i < N; i++) amt[o + i] = perspectiveAmount(p, tn, N > 1 ? i / (N - 1) : 0) * (L - 1);
    }
    let prev = src;
    for (let k = 1; k < L; k++) {
      const cur = c.alloc();
      blurMatrix(src, cur, N, F, (sbMax * k) / (L - 1), (sfMax * k) / (L - 1), p.normalize);
      for (let f = 0; f < F; f++) {
        const o = f * N;
        for (let i = 0; i < N; i++) {
          if (prev[o + i] === 0 && cur[o + i] === 0) continue;
          const x = amt[o + i];
          if (x < k - 1 || x > k) continue;
          if (x === k - 1 && k > 1) continue; // already written by the level below / 아래 단계에서 이미 기록
          const fr = x - (k - 1);
          dst[o + i] = prev[o + i] * (1 - fr) + cur[o + i] * fr;
        }
      }
      if (prev !== src) c.free(prev);
      prev = cur;
    }
    if (prev !== src) c.free(prev);
    c.free(amt);
    applyShimmer(dst, N, F, rate, p.shimmer, c.seed);
  },
});

// --------------------------------------------------------------------------
// 3) Glitch — short, random pitch (and time) jumps / 글리치 = 아주 짧은 랜덤 음고·시간 점프
// --------------------------------------------------------------------------

/** Just-intonation jump sizes in semitones (9:8 … 2:1). / 순정 음정 점프 (반음) */
export const GLITCH_INTERVALS = Object.freeze([[9, 8], [6, 5], [5, 4], [4, 3], [3, 2], [5, 3], [7, 4], [2, 1]].map(([a, b]) => 12 * Math.log2(a / b)));

/**
 * Seeded Poisson events of the glitch effect over `length` seconds. Every event draws the same
 * number of random values whether it is kept or not, so `probability` thins the same timeline.
 * 글리치 이벤트 (시드 포아송). 이벤트마다 같은 수의 난수를 소비 → probability는 같은 타임라인을 솎아냄.
 * @returns {Array<{ t, dur, keep, jump, dt, bandLo, bandHi, stutter, uPick }>} jump in semitones
 */
export function glitchEvents(p, { length, seed }) {
  const out = [];
  if (!(p.rate > 0) || !(length > 0)) return out;
  const rng = createSeededRandom(((seed * 7919) ^ (p.seed * 104729) ^ 0x51ed27) >>> 0);
  const dMin = Math.min(p.durMin, p.durMax);
  const dMax = Math.max(p.durMin, p.durMax);
  let t = 0;
  for (let guard = 0; guard < 20000; guard++) {
    t += -Math.log(1 - rng()) / p.rate;
    if (t >= length) break;
    const u = [rng(), rng(), rng(), rng(), rng(), rng(), rng(), rng()];
    const dur = (dMin + u[0] * (dMax - dMin)) / 1000;
    let jump = 0;
    const R = p.rangeSemi;
    if (p.jump === 'uniform') jump = (2 * u[1] - 1) * R;
    else if (p.jump === 'gauss') jump = clamp(Math.sqrt(-2 * Math.log(1 - u[1] * 0.999999)) * Math.cos(2 * Math.PI * u[2]) * (R / 2), -R, R);
    else if (p.jump === 'octave') { const n = Math.floor(R / 12); jump = n < 1 ? 0 : 12 * (1 + Math.floor(u[1] * n)) * (u[2] < 0.5 ? -1 : 1); }
    else if (p.jump === 'interval') { const list = GLITCH_INTERVALS.filter((s) => s <= R + 1e-9); jump = list.length ? list[Math.floor(u[1] * list.length)] * (u[2] < 0.5 ? -1 : 1) : 0; }
    const width = p.bandFraction >= 0.999 ? 1 : Math.max(0.03, p.bandFraction * (0.5 + 0.5 * u[4]));
    const lo = width >= 1 ? 0 : u[3] * (1 - width);
    out.push({ t, dur, keep: u[7] < p.probability, jump, dt: ((2 * u[5] - 1) * p.timeJumpMs) / 1000, bandLo: lo, bandHi: lo + width, stutter: p.stutter, uPick: u[6] });
  }
  return out;
}

GridEffectRegistry.register({
  id: 'glitch',
  name: { en: 'Glitch', ko: '글리치' },
  domain: 'matrix',
  params: [
    { key: 'rate', type: 'range', min: 0, max: 30, step: 0.1, unit: '/s' },
    { key: 'durMin', type: 'range', min: 3, max: 80, step: 1, unit: 'ms' },
    { key: 'durMax', type: 'range', min: 3, max: 80, step: 1, unit: 'ms' },
    { key: 'jump', type: 'select', options: ['uniform', 'gauss', 'octave', 'interval', 'toPainted'] },
    { key: 'rangeSemi', type: 'range', min: 0, max: 36, step: 0.5, unit: 'st' },
    { key: 'timeJumpMs', type: 'range', min: 0, max: 2000, step: 5, unit: 'ms' },
    { key: 'bandFraction', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'stutter', type: 'int', min: 1, max: 8, step: 1 },
    { key: 'probability', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'fadeMs', type: 'range', min: 2, max: 20, step: 0.5, unit: 'ms' },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ rate: 6, durMin: 15, durMax: 50, jump: 'uniform', rangeSemi: 12, timeJumpMs: 0, bandFraction: 1, stutter: 1, probability: 1, fadeMs: 3, seed: 1 }),
  apply(c) {
    const { src, dst, N, F, rate, bps, p } = c;
    dst.set(src);
    const events = glitchEvents(p, { length: F / rate, seed: c.seed }).filter((e) => e.keep);
    c.info.events = [];
    if (!events.length) return;
    let painted = null;
    if (p.jump === 'toPainted') {
      const on = activeBins(src, N, F, 1e-4);
      painted = [];
      for (let i = 0; i < N; i++) if (on[i]) painted.push(i);
    }
    const fadeF = Math.max(1, (Math.max(2, p.fadeMs) / 1000) * rate);
    for (const e of events) {
      const fa = Math.min(F - 1, Math.round(e.t * rate));
      const durF = Math.max(2, Math.round(e.dur * rate));
      const fb = Math.min(F, fa + durF * e.stutter);
      const b0 = Math.floor(e.bandLo * N);
      const b1 = Math.min(N, Math.ceil(e.bandHi * N));
      let db = sround(e.jump * bps);
      let dest = -1;
      if (painted) {
        // toPainted: the strongest bin of the band jumps onto another painted pitch / 대역에서 가장 센 빈이 다른 칠해진 음고로
        let s = -1;
        let best = 1e-4;
        for (let i = b0; i < b1; i++) if (src[fa * N + i] > best) { best = src[fa * N + i]; s = i; }
        if (s < 0) continue;
        const maxB = p.rangeSemi * bps;
        let cand = painted.filter((d) => d !== s && Math.abs(d - s) <= maxB);
        if (!cand.length) cand = painted.filter((d) => d !== s);
        if (!cand.length) continue;
        dest = cand[Math.min(cand.length - 1, Math.floor(e.uPick * cand.length))];
        db = dest - s;
      }
      const dtF = sround(e.dt * rate);
      if (db === 0 && dtF === 0) continue;
      c.info.events.push({ t: fa / rate, dur: (fb - fa) / rate, jump: db / bps, dt: dtF / rate, bandLo: b0, bandHi: b1, dest });
      for (let f = fa; f < fb; f++) {
        const pos = (f - fa) % durF;
        // per-grain raised-cosine window: no step at the event edges or at a stutter repeat
        // 그레인별 raised-cosine 창: 이벤트 경계와 스터터 반복 지점에 단차 없음
        const edge = Math.min(pos + 0.5, durF - pos - 0.5) / fadeF;
        const w = edge >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, edge));
        const sf = fa + pos + dtF;
        const o = f * N;
        const so = sf * N;
        const srcOk = sf >= 0 && sf < F;
        // the band leaves its place … / 대역은 제자리에서 사라지고
        if (db !== 0) for (let i = b0; i < b1; i++) dst[o + i] = dst[o + i] * (1 - w);
        // … and lands shifted (overwriting what is there) / 옮겨진 자리에 덮어씀
        const lo = Math.max(0, b0 + db);
        const hi = Math.min(N, b1 + db);
        for (let i = lo; i < hi; i++) {
          const g = srcOk ? src[so + i - db] : 0;
          dst[o + i] = dst[o + i] * (1 - w) + g * w;
        }
      }
    }
  },
});

// --------------------------------------------------------------------------
// 4) Halftone — random tremolo (dot size = duty cycle) / 할프톤 = 랜덤 트레몰로 (점 크기 = 듀티비)
// --------------------------------------------------------------------------

/** Log-normal sample with mean m and coefficient of variation cv (cv = 0 → exactly m). / 로그정규 표본 */
function logNormal(rng, m, cv) {
  if (!(cv > 0) || !(m > 0)) { rng(); rng(); return Math.max(0, m); }
  const s2 = Math.log(1 + cv * cv);
  const z = Math.sqrt(-2 * Math.log(1 - rng() * 0.999999)) * Math.cos(2 * Math.PI * rng());
  return Math.exp(Math.log(m) - s2 / 2 + Math.sqrt(s2) * z);
}

/** Time offset (s) of the gate pattern at `semis` above the lowest pitch for the screen angle. / 스크린 각도의 시간 오프셋 */
export function halftoneOffset(p, semis, grid) {
  // 45° runs along the cell diagonal of the editor grid / 45° = 편집 격자의 셀 대각선
  return semis * (grid.rowsPerSemi / grid.colsPerSec) * Math.tan((p.angle * Math.PI) / 180);
}

/**
 * On-segments [{ on, off, len, gap, dropped }] of one gate unit over [0, length]. On / off lengths are
 * log-normal (means period·duty and period·(1 − duty), CV = jitter / silenceJitter, independent).
 * 게이트 단위 하나의 켜짐 구간. 켜짐·꺼짐 길이는 각각 독립 로그정규.
 * @param {(sec: number) => number} [dutyAt] duty for a cycle starting at `sec` (dutyFrom = 'amplitude')
 */
export function halftoneSegments(p, unit, { length, seed, offsetSec = 0, dutyAt = null }) {
  const period = Math.max(0.005, p.periodMs / 1000);
  const rng = createSeededRandom(((seed * 2654435761) ^ (p.seed * 40503) ^ Math.imul(unit + 1, 0x9e3779b1)) >>> 0);
  const segs = [];
  let t = offsetSec - Math.ceil(offsetSec / period) * period - period; // one cycle of lead-in / 한 주기 앞에서 시작
  for (let guard = 0; guard < 200000 && t < length; guard++) {
    const duty = clamp(dutyAt ? dutyAt(Math.max(0, t)) : p.duty, 0, 1);
    const len = logNormal(rng, period * duty, p.jitter);
    const gap = logNormal(rng, period * (1 - duty), p.silenceJitter);
    const dropped = rng() < p.dropout;
    if (t + len > 0 && len > 0) segs.push({ on: t, off: t + len, len, gap, dropped });
    t += Math.max(1e-4, len + gap);
  }
  return segs;
}

/** Render segments to a gate curve of F frames (edge ramps ≥ 2 ms, never a step). / 구간 → 게이트 곡선 */
export function renderGate(segs, F, rate, p, gate = new Float32Array(F)) {
  gate.fill(0);
  const edgeBase = Math.max(0.002, (p.shape === 'square' ? 2 : p.edgeMs) / 1000);
  for (const s of segs) {
    if (s.dropped) continue;
    const edge = p.shape === 'round' ? Math.min(s.len / 2, Math.max(edgeBase, 0.35 * s.len)) : Math.min(s.len / 2, edgeBase);
    const f0 = Math.max(0, Math.ceil(s.on * rate));
    const f1 = Math.min(F - 1, Math.floor(s.off * rate));
    for (let f = f0; f <= f1; f++) {
      const tt = f / rate;
      const d = Math.min(tt - s.on, s.off - tt);
      let g = edge > 0 ? Math.min(1, d / edge) : 1;
      if (p.shape === 'round') g = 0.5 - 0.5 * Math.cos(Math.PI * g);
      if (g > gate[f]) gate[f] = g;
    }
  }
  return gate;
}

GridEffectRegistry.register({
  id: 'halftone',
  name: { en: 'Halftone', ko: '할프톤' },
  domain: 'matrix',
  params: [
    { key: 'periodMs', type: 'range', min: 20, max: 400, step: 1, unit: 'ms' },
    { key: 'dutyFrom', type: 'select', options: ['amplitude', 'fixed'] },
    { key: 'duty', type: 'range', min: 0.02, max: 1, step: 0.01, when: (p) => p.dutyFrom === 'fixed' },
    { key: 'jitter', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'silenceJitter', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'dropout', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'angle', type: 'range', min: -80, max: 80, step: 1, unit: '°' },
    { key: 'shape', type: 'select', options: ['round', 'square', 'line'] },
    { key: 'edgeMs', type: 'range', min: 2, max: 50, step: 0.5, unit: 'ms', when: (p) => p.shape !== 'square' },
    { key: 'scope', type: 'select', options: ['perBin', 'perBand', 'layer'] },
    { key: 'bandSemi', type: 'range', min: 1, max: 24, step: 1, unit: 'st', when: (p) => p.scope === 'perBand' },
    { key: 'compensate', type: 'toggle' },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ periodMs: 120, dutyFrom: 'fixed', duty: 0.5, jitter: 0.3, silenceJitter: 0.3, dropout: 0, angle: 0, shape: 'round', edgeMs: 6, scope: 'perBand', bandSemi: 12, compensate: false, seed: 1 }),
  apply(c) {
    const { src, dst, N, F, rate, bps, p } = c;
    const on = activeBins(src, N, F);
    const length = F / rate;
    const unitOf = (i) => (p.scope === 'layer' ? 0 : p.scope === 'perBand' ? Math.floor(i / (bps * p.bandSemi)) : i);
    const gate = new Float32Array(F);
    let lastUnit = -1;
    let comp = 1;
    for (let i = 0; i < N; i++) {
      if (!on[i]) continue;
      const u = unitOf(i);
      if (u !== lastUnit) {
        lastUnit = u;
        // bins of this unit (for the amplitude → duty reading) / 이 단위에 속한 빈
        let i1 = i;
        while (i1 + 1 < N && unitOf(i1 + 1) === u) i1++;
        const i0 = i;
        const semis = p.scope === 'perBin' ? i / bps : p.scope === 'perBand' ? u * p.bandSemi : 0;
        const dutyAt = p.dutyFrom === 'amplitude' ? (sec) => {
          const f = Math.min(F - 1, Math.max(0, Math.round(sec * rate)));
          let m = 0;
          for (let k = i0; k <= i1; k++) if (src[f * N + k] > m) m = src[f * N + k];
          return clamp(m, 0.05, 1);
        } : null;
        renderGate(halftoneSegments(p, u, { length, seed: c.seed, offsetSec: halftoneOffset(p, semis, c.grid), dutyAt }), F, rate, p, gate);
        comp = 1;
        if (p.compensate) {
          let s2 = 0;
          for (let f = 0; f < F; f++) s2 += gate[f] * gate[f];
          comp = s2 > 0 ? Math.min(4, 1 / Math.sqrt(s2 / F)) : 1;
        }
      }
      for (let f = 0; f < F; f++) dst[f * N + i] = src[f * N + i] * gate[f] * comp;
    }
  },
});

// --------------------------------------------------------------------------
// 6) Liquify — curvature (push a line and it bends) / 리퀴파이 = 곡률 (선을 밀어 휘게 함)
// --------------------------------------------------------------------------

export const LIQUIFY_TOOLS = Object.freeze(['push', 'twirlCW', 'twirlCCW', 'pinch', 'bloat', 'smooth', 'reconstruct']);
export const LIQUIFY_MAX_OPS = 64;
const LIQ_MAX_PTS = 96;

const meshCache = new Map(); // key → mesh (small LRU) / 메시 캐시

/**
 * Replay the stored strokes into a displacement field on a mesh of 2 nodes per editor cell
 * (independent of the render quality): Dx (columns), Dy (rows) in cell units, node (mx, my) at
 * cell-space (mx / 2, my / 2). Non-destructive: the strokes are the document, the field is derived.
 * 저장된 스트로크를 재생해 변위장을 만듦 (편집 셀당 노드 2개, 렌더 품질과 무관). 비파괴.
 */
export function liquifyMesh(ops, rows, cols) {
  const key = `${rows}x${cols}|${JSON.stringify(ops)}`;
  const hit = meshCache.get(key);
  if (hit) return hit;
  const W = cols * 2 + 1;
  const H = rows * 2 + 1;
  const Dx = new Float32Array(W * H);
  const Dy = new Float32Array(W * H);
  let any = false;
  const brush = (cx, cy, R, fn) => {
    const x0 = Math.max(0, Math.floor((cx - R) * 2));
    const x1 = Math.min(W - 1, Math.ceil((cx + R) * 2));
    const y0 = Math.max(0, Math.floor((cy - R) * 2));
    const y1 = Math.min(H - 1, Math.ceil((cy + R) * 2));
    for (let my = y0; my <= y1; my++) {
      for (let mx = x0; mx <= x1; mx++) {
        const dx = mx / 2 - cx;
        const dy = my / 2 - cy;
        const d2 = (dx * dx + dy * dy) / (R * R);
        if (d2 >= 1) continue;
        const fall = (1 - d2) * (1 - d2);
        fn(my * W + mx, fall, dx, dy);
      }
    }
  };
  for (const op of ops || []) {
    const R = Math.max(0.5, op.size);
    const k = clamp(op.strength, 0, 1);
    const pts = op.pts || [];
    if (!pts.length || !(k > 0)) continue;
    // resample the path at R / 4 so the result does not depend on the pointer rate / 포인터 속도와 무관하게 재표본
    const path = [pts[0]];
    const step = Math.max(0.25, R / 4);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = path[path.length - 1];
      const [bx, by] = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let q = 1; q <= n; q++) path.push([ax + ((bx - ax) * q) / n, ay + ((by - ay) * q) / n]);
    }
    // momentum: the stroke coasts on after the pointer is lifted / 관성: 손을 뗀 뒤에도 잠시 이어짐
    if (op.tool === 'push' && op.momentum > 0 && path.length > 1) {
      const [ax, ay] = path[path.length - 2];
      const [bx, by] = path[path.length - 1];
      let vx = bx - ax;
      let vy = by - ay;
      for (let q = 0; q < 12; q++) {
        vx *= op.momentum;
        vy *= op.momentum;
        if (Math.hypot(vx, vy) < 0.01) break;
        const [lx, ly] = path[path.length - 1];
        path.push([lx + vx, ly + vy]);
      }
    }
    for (let i = op.tool === 'push' ? 1 : 0; i < path.length; i++) {
      const [cx, cy] = path[i];
      if (op.tool === 'push') {
        const ddx = cx - path[i - 1][0];
        const ddy = cy - path[i - 1][1];
        brush(cx, cy, R, (j, fall) => { Dx[j] += k * fall * ddx; Dy[j] += k * fall * ddy; });
      } else if (op.tool === 'twirlCW' || op.tool === 'twirlCCW') {
        const th = (op.tool === 'twirlCW' ? -1 : 1) * 0.12 * k;
        brush(cx, cy, R, (j, fall, dx, dy) => { Dx[j] += -dy * th * fall; Dy[j] += dx * th * fall; });
      } else if (op.tool === 'pinch' || op.tool === 'bloat') {
        const g = (op.tool === 'pinch' ? -1 : 1) * 0.1 * k;
        brush(cx, cy, R, (j, fall, dx, dy) => { Dx[j] += dx * g * fall; Dy[j] += dy * g * fall; });
      } else if (op.tool === 'reconstruct') {
        brush(cx, cy, R, (j, fall) => { Dx[j] *= 1 - k * fall; Dy[j] *= 1 - k * fall; });
      } else if (op.tool === 'smooth') {
        brush(cx, cy, R, (j, fall) => {
          const mx = j % W;
          const my = (j - mx) / W;
          if (mx < 1 || my < 1 || mx >= W - 1 || my >= H - 1) return;
          const ax = (Dx[j - 1] + Dx[j + 1] + Dx[j - W] + Dx[j + W]) / 4;
          const ay = (Dy[j - 1] + Dy[j + 1] + Dy[j - W] + Dy[j + W]) / 4;
          Dx[j] += (ax - Dx[j]) * k * fall;
          Dy[j] += (ay - Dy[j]) * k * fall;
        });
      }
      any = true;
    }
  }
  let peak = 0;
  for (let j = 0; j < Dx.length; j++) peak = Math.max(peak, Math.abs(Dx[j]), Math.abs(Dy[j]));
  const mesh = { W, H, Dx, Dy, any: any && peak > 1e-9, peak };
  if (meshCache.size > 6) meshCache.delete(meshCache.keys().next().value);
  meshCache.set(key, mesh);
  return mesh;
}

/** Normalise the strokes of a Liquify item (bounded count, finite numbers). / 스트로크 정규화 */
function sanitizeLiquifyOps(raw) {
  if (!Array.isArray(raw)) return [];
  const fin = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
  return raw.slice(-LIQUIFY_MAX_OPS).map((o) => ({
    tool: LIQUIFY_TOOLS.includes(o?.tool) ? o.tool : 'push',
    size: clamp(fin(o?.size, 6), 0.5, 200),
    strength: clamp(fin(o?.strength, 0.6), 0, 1),
    momentum: clamp(fin(o?.momentum, 0), 0, 0.95),
    pts: (Array.isArray(o?.pts) ? o.pts : []).slice(0, LIQ_MAX_PTS).map((q) => [Number(fin(q?.[0], 0).toFixed(2)), Number(fin(q?.[1], 0).toFixed(2))]),
  })).filter((o) => o.pts.length);
}

GridEffectRegistry.register({
  id: 'liquify',
  name: { en: 'Liquify', ko: '리퀴파이' },
  domain: 'matrix',
  params: [
    { key: 'amount', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'lockTime', type: 'toggle' },
    { key: 'jacobian', type: 'toggle' },
  ],
  defaults: () => ({ amount: 1, lockTime: false, jacobian: true, ops: [] }),
  sanitize: (out, src) => ({ ...out, ops: sanitizeLiquifyOps(src.ops) }),
  apply(c) {
    const { src, dst, N, F, rate, bps, p } = c;
    const rows = c.grid.rows;
    const cols = c.grid.cols;
    const mesh = liquifyMesh(p.ops, rows, cols);
    c.info.mesh = mesh;
    if (!mesh.any || !(p.amount > 0)) { dst.set(src); return; }
    const { W, H, Dx, Dy } = mesh;
    const am = p.amount;
    const xPerF = c.grid.colsPerSec / rate; // columns per frame / 프레임당 열
    const yPerB = c.grid.rowsPerSemi / bps; // rows per bin / 빈당 행
    // inverse mapping: Result(x) = Src(x − D(x)), bilinear in the mesh and in the matrix
    // 역방향 매핑: Result(x) = Src(x − D(x)), 메시와 행렬에서 쌍선형 보간
    for (let f = 0; f < F; f++) {
      const x = f * xPerF;
      const gx = Math.min(W - 1.001, x * 2);
      const mx = Math.floor(gx);
      const ax = gx - mx;
      const o = f * N;
      for (let i = 0; i < N; i++) {
        const y = i * yPerB + 0.5;
        const gy = Math.min(H - 1.001, y * 2);
        const my = Math.floor(gy);
        const ay = gy - my;
        const j = my * W + mx;
        const w00 = (1 - ax) * (1 - ay);
        const w10 = ax * (1 - ay);
        const w01 = (1 - ax) * ay;
        const w11 = ax * ay;
        const dx = p.lockTime ? 0 : am * (Dx[j] * w00 + Dx[j + 1] * w10 + Dx[j + W] * w01 + Dx[j + W + 1] * w11);
        const dy = am * (Dy[j] * w00 + Dy[j + 1] * w10 + Dy[j + W] * w01 + Dy[j + W + 1] * w11);
        if (dx === 0 && dy === 0) { dst[o + i] = src[o + i]; continue; }
        const sf = f - dx / xPerF;
        const sb = i - dy / yPerB;
        if (sf < 0 || sf > F - 1 || sb < 0 || sb > N - 1) continue;
        const f0 = Math.min(F - 2, Math.floor(sf));
        const b0 = Math.min(N - 2, Math.floor(sb));
        const uf = sf - f0;
        const ub = sb - b0;
        const q = f0 * N + b0;
        let v = (src[q] * (1 - ub) + src[q + 1] * ub) * (1 - uf) + (src[q + N] * (1 - ub) + src[q + N + 1] * ub) * uf;
        if (p.jacobian && v > 0) {
          // energy conservation: × √|det(I − ∇D)| (compression gets louder, stretching quieter)
          // 에너지 보존: × √|det(I − ∇D)|
          const ddxX = p.lockTime ? 0 : am * ((Dx[j + 1] - Dx[j]) * (1 - ay) + (Dx[j + W + 1] - Dx[j + W]) * ay) * 2;
          const ddxY = p.lockTime ? 0 : am * ((Dx[j + W] - Dx[j]) * (1 - ax) + (Dx[j + W + 1] - Dx[j + 1]) * ax) * 2;
          const ddyX = am * ((Dy[j + 1] - Dy[j]) * (1 - ay) + (Dy[j + W + 1] - Dy[j + W]) * ay) * 2;
          const ddyY = am * ((Dy[j + W] - Dy[j]) * (1 - ax) + (Dy[j + W + 1] - Dy[j + 1]) * ax) * 2;
          v *= Math.sqrt(clamp(Math.abs((1 - ddxX) * (1 - ddyY) - ddxY * ddyX), 0.0625, 16));
        }
        dst[o + i] = v < TINY ? 0 : v;
      }
    }
  },
});

// --------------------------------------------------------------------------
// Tier 2 — cheap matrix effects / 저렴한 행렬 효과
// --------------------------------------------------------------------------

GridEffectRegistry.register({
  id: 'pixelate',
  name: { en: 'Pixelate', ko: '픽셀레이트' },
  domain: 'matrix',
  params: [
    { key: 'timeMs', type: 'range', min: 5, max: 1000, step: 5, unit: 'ms' },
    { key: 'semis', type: 'range', min: 0.125, max: 12, step: 0.125, unit: 'st' },
  ],
  defaults: () => ({ timeMs: 125, semis: 1 }),
  apply({ src, dst, N, F, rate, bps, p }) {
    const bf = Math.max(1, Math.round((p.timeMs / 1000) * rate));
    const bb = Math.max(1, Math.round(p.semis * bps));
    for (let f0 = 0; f0 < F; f0 += bf) {
      for (let i0 = 0; i0 < N; i0 += bb) {
        // block power → one sine at the block centre (a staircase in time and pitch) / 블록 파워 → 블록 중심의 사인 하나
        let s2 = 0;
        const f1 = Math.min(F, f0 + bf);
        const i1 = Math.min(N, i0 + bb);
        for (let f = f0; f < f1; f++) for (let i = i0; i < i1; i++) s2 += src[f * N + i] * src[f * N + i];
        if (s2 <= 0) continue;
        const v = Math.sqrt(s2 / (f1 - f0));
        const ic = Math.min(N - 1, i0 + Math.floor((i1 - i0) / 2));
        for (let f = f0; f < f1; f++) dst[f * N + ic] = Math.min(1.5, v);
      }
    }
  },
});

GridEffectRegistry.register({
  id: 'posterize',
  name: { en: 'Posterize', ko: '포스터라이즈' },
  domain: 'matrix',
  params: [{ key: 'levels', type: 'int', min: 2, max: 16, step: 1 }],
  defaults: () => ({ levels: 4 }),
  apply({ src, dst, p }) {
    const n = p.levels - 1;
    for (let j = 0; j < src.length; j++) if (src[j] > 0) dst[j] = Math.round(Math.min(1, src[j]) * n) / n;
  },
});

GridEffectRegistry.register({
  id: 'sharpen',
  name: { en: 'Sharpen', ko: '샤픈' },
  domain: 'matrix',
  params: [
    { key: 'amount', type: 'range', min: 0, max: 4, step: 0.05 },
    { key: 'radiusCents', type: 'range', min: 5, max: 200, step: 1, unit: '¢' },
  ],
  defaults: () => ({ amount: 1, radiusCents: 40 }),
  apply(c) {
    const { src, dst, N, F, bps, p } = c;
    blurMatrix(src, dst, N, F, (p.radiusCents / 100) * bps, 0, 'sum');
    // unsharp mask: src + amount·(src − blur), never negative / 언샤프 마스크
    for (let j = 0; j < src.length; j++) dst[j] = Math.max(0, src[j] + p.amount * (src[j] - dst[j]));
  },
});

GridEffectRegistry.register({
  id: 'bloom',
  name: { en: 'Bloom', ko: '블룸' },
  domain: 'matrix',
  params: [
    { key: 'threshold', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'sigmaCents', type: 'range', min: 5, max: 400, step: 1, unit: '¢' },
    { key: 'sigmaMs', type: 'range', min: 0, max: 500, step: 1, unit: 'ms' },
    { key: 'amount', type: 'range', min: 0, max: 2, step: 0.01 },
  ],
  defaults: () => ({ threshold: 0.5, sigmaCents: 120, sigmaMs: 40, amount: 0.6 }),
  apply(c) {
    const { src, dst, N, F, rate, bps, p } = c;
    const hi = c.alloc();
    for (let j = 0; j < src.length; j++) hi[j] = src[j] > p.threshold ? src[j] - p.threshold : 0;
    blurMatrix(hi, dst, N, F, (p.sigmaCents / 100) * bps, (p.sigmaMs / 1000) * rate, 'power');
    c.free(hi);
    for (let j = 0; j < src.length; j++) dst[j] = src[j] + p.amount * dst[j];
  },
});

GridEffectRegistry.register({
  id: 'levels',
  name: { en: 'Levels', ko: '레벨' },
  domain: 'matrix',
  params: [
    { key: 'black', type: 'range', min: 0, max: 0.95, step: 0.01 },
    { key: 'white', type: 'range', min: 0.05, max: 1, step: 0.01 },
    { key: 'gamma', type: 'range', min: 0.2, max: 5, step: 0.05 },
    { key: 'invert', type: 'toggle' },
  ],
  defaults: () => ({ black: 0, white: 1, gamma: 1, invert: false }),
  apply({ src, dst, p }) {
    const span = Math.max(0.01, p.white - p.black);
    for (let j = 0; j < src.length; j++) {
      let v = Math.pow(clamp((src[j] - p.black) / span, 0, 1), p.gamma);
      if (p.invert) v = 1 - v;
      dst[j] = v < TINY ? 0 : v;
    }
  },
});

GridEffectRegistry.register({
  id: 'threshold',
  name: { en: 'Threshold', ko: '임계값' },
  domain: 'matrix',
  params: [
    { key: 'level', type: 'range', min: 0.01, max: 1, step: 0.01 },
    { key: 'soft', type: 'range', min: 0, max: 0.5, step: 0.01 },
  ],
  defaults: () => ({ level: 0.5, soft: 0.05 }),
  apply({ src, dst, p }) {
    for (let j = 0; j < src.length; j++) {
      const v = src[j];
      if (v <= 0) continue;
      const u = p.soft > 0 ? clamp((v - (p.level - p.soft)) / (2 * p.soft), 0, 1) : (v >= p.level ? 1 : 0);
      dst[j] = u * u * (3 - 2 * u);
    }
  },
});

GridEffectRegistry.register({
  id: 'mirror',
  name: { en: 'Mirror', ko: '미러' },
  domain: 'matrix',
  params: [
    { key: 'axis', type: 'select', options: ['time', 'pitch', 'both'] },
    { key: 'blend', type: 'select', options: ['replace', 'add'] },
  ],
  defaults: () => ({ axis: 'time', blend: 'add' }),
  apply({ src, dst, N, F, p }) {
    for (let f = 0; f < F; f++) {
      const sf = p.axis === 'pitch' ? f : F - 1 - f;
      for (let i = 0; i < N; i++) {
        const si = p.axis === 'time' ? i : N - 1 - i;
        const m = src[sf * N + si];
        dst[f * N + i] = p.blend === 'add' ? Math.max(src[f * N + i], m) : m;
      }
    }
  },
});

GridEffectRegistry.register({
  id: 'edge',
  name: { en: 'Edge', ko: '엣지' },
  domain: 'matrix',
  params: [
    { key: 'amount', type: 'range', min: 0, max: 8, step: 0.05 },
    { key: 'windowMs', type: 'range', min: 5, max: 200, step: 1, unit: 'ms' },
  ],
  defaults: () => ({ amount: 2, windowMs: 30 }),
  apply({ src, dst, N, F, rate, p }) {
    // gradient magnitude along time = onsets and releases only / 시간 방향 기울기 = 온셋·릴리스 윤곽
    const h = Math.max(1, Math.round((p.windowMs / 1000) * rate));
    for (let f = 0; f < F; f++) {
      const fa = Math.max(0, f - h);
      const fb = Math.min(F - 1, f + h);
      for (let i = 0; i < N; i++) {
        const d = Math.abs(src[fb * N + i] - src[fa * N + i]);
        if (d > 0) dst[f * N + i] = Math.min(1, d * p.amount * 0.5);
      }
    }
  },
});

// --------------------------------------------------------------------------
// Output-stage (bank) effects / 출력 단계(뱅크) 효과
// --------------------------------------------------------------------------

/** Noise colour presets: slope in dB / octave. / 노이즈 색 프리셋 (dB/oct) */
export const NOISE_COLORS = Object.freeze({ brown: -6, pink: -3, white: 0, blue: 3, violet: 6 });

// 2) Noise — level and colour / 노이즈 레벨·색
GridEffectRegistry.register({
  id: 'noise',
  name: { en: 'Noise', ko: '노이즈' },
  domain: 'bank',
  params: [
    { key: 'levelDb', type: 'range', min: -80, max: 0, step: 0.5, unit: 'dB' },
    { key: 'slope', type: 'range', min: -9, max: 6, step: 0.1, unit: 'dB/oct' },
    { key: 'follow', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'bandCents', type: 'range', min: 5, max: 200, step: 1, unit: '¢' },
    { key: 'grain', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ levelDb: -30, slope: -3, follow: 0, bandCents: 40, grain: 0, seed: 1 }),
  /** Image grain: a random amplitude per editor cell (coarse AM texture). / 이미지 그레인: 편집 셀별 랜덤 진폭 */
  matrix({ src, dst, N, F, rate, bps, grid, p, seed }) {
    if (!(p.grain > 0)) { dst.set(src); return; }
    const rowOf = new Int32Array(N);
    for (let i = 0; i < N; i++) rowOf[i] = Math.round((i / bps) * grid.rowsPerSemi);
    for (let f = 0; f < F; f++) {
      const col = Math.floor((f / rate) * grid.colsPerSec);
      const o = f * N;
      for (let i = 0; i < N; i++) {
        const v = src[o + i];
        if (v > 0) dst[o + i] = v * (1 - p.grain * hash3(seed * 31 + p.seed, col, rowOf[i]));
      }
    }
  },
  /**
   * Synthesis part, a = 10^(levelDb / 20): `floor` = a·(1 − follow) = RMS of the full-band coloured
   * noise relative to a full-scale line (the part that ignores the picture); `n` = follow·a = share of
   * each partial's power that becomes a narrow noise band around it (tone √(1 − n), noise √n);
   * `bandCents` = width of that band.
   * 합성 부분: floor = 그림과 무관한 전대역 노이즈 RMS, n = 각 부분음 파워 중 좁은 대역 노이즈가 되는 비율.
   */
  bank(p, env = {}) {
    const a = Math.pow(10, p.levelDb / 20);
    return { noise: { floor: a * (1 - p.follow), slope: p.slope, n: clamp(p.follow * a, 0, 1), bandCents: p.bandCents, seed: ((env.seed || 1) * 131 + p.seed) >>> 0 } };
  },
});

/** Ratio presets p:q (upward; the reciprocal gives the same interval downward). / 비율 프리셋 */
export const CHROMA_RATIOS = Object.freeze([[1, 1], [9, 8], [6, 5], [5, 4], [4, 3], [3, 2], [8, 5], [5, 3], [7, 4], [2, 1], [3, 1], [5, 1]]);
export const CHROMA_CHANNELS = Object.freeze(['r', 'g', 'b']);
export const CHROMA_WAVES = Object.freeze(['layer', 'sine', 'tri', 'saw', 'square', 'pulse']);

/** Exact frequency ratio of a channel: (p / q)·2^(cents / 1200). / 채널의 정확한 주파수 비율 */
export function chromaRatio(p, ch) {
  return (p[`${ch}P`] / p[`${ch}Q`]) * Math.pow(2, p[`${ch}Cents`] / 1200);
}

const chromaParams = () => {
  const out = [{ key: 'link', type: 'toggle' }];
  for (const ch of CHROMA_CHANNELS) {
    out.push(
      { key: `${ch}On`, type: 'toggle', channel: ch },
      { key: `${ch}P`, type: 'int', min: 1, max: 32, step: 1, channel: ch },
      { key: `${ch}Q`, type: 'int', min: 1, max: 32, step: 1, channel: ch },
      { key: `${ch}Cents`, type: 'range', min: -100, max: 100, step: 0.1, unit: '¢', channel: ch },
      { key: `${ch}Gain`, type: 'range', min: 0, max: 1.5, step: 0.01, channel: ch },
      { key: `${ch}TimeMs`, type: 'range', min: -200, max: 200, step: 1, unit: 'ms', channel: ch },
      { key: `${ch}Pan`, type: 'range', min: -1, max: 1, step: 0.01, channel: ch },
      { key: `${ch}Wave`, type: 'select', options: [...CHROMA_WAVES], channel: ch },
      { key: `${ch}Harm`, type: 'int', min: 1, max: 8, step: 1, channel: ch },
    );
  }
  return out;
};

// 5) Chromatic Aberration — the same picture on exact just ratios / 크로매틱 = 같은 그림을 정확한 순정 비율 위에 복제
GridEffectRegistry.register({
  id: 'chroma',
  name: { en: 'Chromatic Aberration', ko: '크로매틱 애버레이션' },
  domain: 'bank',
  params: chromaParams(),
  defaults: () => ({
    link: true,
    rOn: true, rP: 2, rQ: 3, rCents: 0, rGain: 0.7, rTimeMs: -8, rPan: -0.8, rWave: 'layer', rHarm: 6,
    gOn: true, gP: 1, gQ: 1, gCents: 0, gGain: 1, gTimeMs: 0, gPan: 0, gWave: 'layer', gHarm: 6,
    bOn: true, bP: 3, bQ: 2, bCents: 0, bGain: 0.7, bTimeMs: 8, bPan: 0.8, bWave: 'layer', bHarm: 6,
  }),
  /** link: R is the mirror of B (ratio 1 / B, opposite pan and time). / 대칭 연결: R = 1/B */
  sanitize(out) {
    if (out.link) Object.assign(out, { rP: out.bQ, rQ: out.bP, rCents: -out.bCents, rPan: -out.bPan, rTimeMs: -out.bTimeMs, rGain: out.bGain });
    return out;
  },
  /**
   * One bank per channel: the SAME amplitude matrix read with another frequency table f_bin·ratio
   * (never a bin shift — an integer bin shift could not be an exact 3:2).
   * 채널마다 뱅크 하나: 같은 진폭 행렬을 다른 주파수 표 f_bin·ratio로 읽음 (빈 이동이 아님).
   */
  bank(p) {
    const channels = [];
    for (const ch of CHROMA_CHANNELS) {
      if (!p[`${ch}On`]) continue;
      const ratio = chromaRatio(p, ch);
      channels.push({ ch, ratio, semis: 12 * Math.log2(ratio), gain: p[`${ch}Gain`], timeMs: p[`${ch}TimeMs`], pan: p[`${ch}Pan`], wave: p[`${ch}Wave`], harmonics: p[`${ch}Harm`] });
    }
    return { channels };
  },
});

/** Ids of the Tier 1 effects (the six the studio was asked for). / 1군 효과 */
export const GRID_TIER1 = Object.freeze(['blur', 'noise', 'glitch', 'halftone', 'chroma', 'liquify']);
