/**
 * Flexatone — modules/ambisonics.js
 * Layer 1 (modules, pure): higher-order Ambisonics (HOA) mathematics — real spherical harmonics in
 * the **ambiX** convention (ACN channel order, SN3D normalisation), order weights, a source-width
 * blur and a sampling decoder to virtual loudspeakers. No DOM, no Web Audio.
 * 계층 1 (modules, 순수): 고차 앰비소닉스 수학 — ambiX 규약(ACN 순서, SN3D 정규화)의 실수 구면조화,
 * 차수 가중, 음원 폭 블러, 가상 스피커 표본 디코더.
 *
 * Axes / 축 (ambiX): x = front, y = left, z = up. A direction is a vector (x, y, z); it does not
 * need to be normalised. Channel index ACN = l² + l + m, l = 0…order, m = −l…l.
 *   Y_l^m = N_l^|m| · P_l^|m|(sin el) · (cos(|m|·az) for m ≥ 0, sin(|m|·az) for m < 0)
 *   N_l^m = sqrt((2 − δ_m0) · (l − m)! / (l + m)!)         (SN3D, no Condon–Shortley phase)
 * Addition theorem in SN3D: Σ_m Y_l^m(a)·Y_l^m(b) = P_l(cos γ) — this is what makes the sampling
 * decoder a plain weighted sum (no matrix inversion):
 *   g_k = (1 / K) · Σ_l w_l · (2l + 1) · Σ_m Y_l^m(speaker k) · b_l^m
 * 덧셈 정리 덕분에 표본 디코더는 역행렬 없이 가중 합으로 계산됨.
 *
 * Written without any studio dependency (Space uses it now). / 스튜디오 의존 없음.
 * Imports: core/math-utils.js, core/state.js (self-check registration only).
 */

import { clamp } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';

export const HOA_MAX_ORDER = 4;
export const HOA_WEIGHTINGS = Object.freeze(['maxre', 'basic', 'inphase']);

/** Channel count of an order. / 차수의 채널 수 */
export const hoaChannels = (order) => (order + 1) * (order + 1);
/** Order l of an ACN channel. / ACN 채널의 차수 */
export const acnOrder = (acn) => Math.floor(Math.sqrt(acn));

const FACT = [1];
for (let i = 1; i <= 2 * HOA_MAX_ORDER + 1; i++) FACT.push(FACT[i - 1] * i);
const NORM = []; // NORM[l][m] = SN3D factor / SN3D 계수
for (let l = 0; l <= HOA_MAX_ORDER; l++) {
  NORM.push([]);
  for (let m = 0; m <= l; m++) NORM[l].push(Math.sqrt(((m === 0 ? 1 : 2) * FACT[l - m]) / FACT[l + m]));
}

/**
 * Real SN3D spherical harmonics of a direction, ACN order, into `out` (length ≥ (order + 1)²).
 * 방향의 실수 SN3D 구면조화 (ACN 순서).
 */
export function shCoeffs(order, x, y, z, out = new Float64Array(hoaChannels(order))) {
  const N = clamp(Math.floor(order), 0, HOA_MAX_ORDER);
  const r = Math.sqrt(x * x + y * y + z * z);
  if (!(r > 1e-12)) { out.fill(0, 0, hoaChannels(N)); out[0] = 1; return out; }
  const s = clamp(z / r, -1, 1); // sin(elevation)
  const c = Math.sqrt(Math.max(0, 1 - s * s)); // cos(elevation)
  const az = Math.atan2(y, x);
  // Associated Legendre P_l^m(s) without the Condon–Shortley phase / 연관 르장드르 (CS 위상 없음)
  for (let m = 0; m <= N; m++) {
    let pmm = 1;
    for (let k = 1; k <= m; k++) pmm *= (2 * k - 1) * c;
    const cm = Math.cos(m * az);
    const sm = Math.sin(m * az);
    let p0 = pmm; // P_m^m
    let p1 = s * (2 * m + 1) * pmm; // P_{m+1}^m
    for (let l = m; l <= N; l++) {
      let p;
      if (l === m) p = p0;
      else if (l === m + 1) p = p1;
      else { p = ((2 * l - 1) * s * p1 - (l + m - 1) * p0) / (l - m); p0 = p1; p1 = p; }
      const v = NORM[l][m] * p;
      const base = l * l + l;
      if (m === 0) out[base] = v;
      else { out[base + m] = v * cm; out[base - m] = v * sm; }
    }
  }
  return out;
}

/** Legendre polynomial P_l(x). / 르장드르 다항식 */
export function legendre(l, x) {
  if (l === 0) return 1;
  let a = 1;
  let b = x;
  for (let k = 2; k <= l; k++) { const p = ((2 * k - 1) * x * b - (k - 1) * a) / k; a = b; b = p; }
  return b;
}

/**
 * Per-order decoder weights w_l (w_0 = 1). basic = 1; maxre = P_l(cos(137.9° / (N + 1.51)));
 * inphase = N!(N+1)! / ((N+l+1)!(N−l)!). / 차수별 디코더 가중
 */
export function orderWeights(order, kind = 'maxre') {
  const N = clamp(Math.floor(order), 0, HOA_MAX_ORDER);
  const w = new Float64Array(N + 1);
  for (let l = 0; l <= N; l++) {
    if (kind === 'basic') w[l] = 1;
    else if (kind === 'inphase') w[l] = (FACT[N] * FACT[N + 1]) / (FACT[N + l + 1] * FACT[N - l]);
    else w[l] = legendre(l, Math.cos(((137.9 / (N + 1.51)) * Math.PI) / 180));
  }
  return w;
}

/**
 * Source width as a spherical Gaussian blur: order l is scaled by exp(−l(l+1)σ²/2), σ = width·π/2.
 * width 0 = a point, 1 = almost omnidirectional; the W channel is never scaled.
 * 음원 폭 = 구면 가우시안 블러 (W 채널은 그대로).
 */
export function widthWeights(order, width, out = new Float64Array(order + 1)) {
  const sig = clamp(width, 0, 1) * Math.PI / 2;
  for (let l = 0; l <= order; l++) out[l] = Math.exp((-l * (l + 1) * sig * sig) / 2);
  return out;
}

/** K nearly uniform directions on the sphere (Fibonacci lattice): [[x, y, z], …]. / 구 위의 고른 방향 */
export function fibonacciSphere(count) {
  const K = Math.max(1, Math.floor(count));
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < K; i++) {
    const z = 1 - (2 * i + 1) / K;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out.push([r * Math.cos(i * ga), r * Math.sin(i * ga), z]);
  }
  return out;
}

/**
 * Virtual loudspeaker count used for an order. Measured on the Fibonacci lattice (500 random
 * directions, max-rE): 16 / 24 / 32 / 50 speakers give an energy-vector direction error of
 * 3.0° / 2.6° / 2.9° / 2.2° and a loudness spread of 0.2 / 0.4 / 0.6 / 0.6 dB for orders 1 … 4.
 * 차수별 가상 스피커 수 (피보나치 격자에서 실측한 방향 오차·음량 편차 기준).
 */
export const virtualSpeakerCount = (order) => [8, 16, 24, 32, 50][clamp(Math.floor(order), 0, HOA_MAX_ORDER)];

/**
 * Sampling decoder: matrix D[k][n] so that speaker gains g = D · b for SN3D coefficients b.
 * 표본 디코더 행렬 (스피커 게인 g = D · b).
 * @returns {{ order, speakers: number[][], matrix: Float64Array[], weights: Float64Array }}
 */
export function createDecoder(order, { weighting = 'maxre', speakers = null } = {}) {
  const N = clamp(Math.floor(order), 0, HOA_MAX_ORDER);
  const dirs = speakers || fibonacciSphere(virtualSpeakerCount(N));
  const w = orderWeights(N, weighting);
  const nCh = hoaChannels(N);
  const matrix = dirs.map((d) => {
    const y = shCoeffs(N, d[0], d[1], d[2]);
    const row = new Float64Array(nCh);
    for (let n = 0; n < nCh; n++) { const l = acnOrder(n); row[n] = (w[l] * (2 * l + 1) * y[n]) / dirs.length; }
    return row;
  });
  return { order: N, speakers: dirs, matrix, weights: w };
}

/**
 * Speaker gains of a plane wave from (x, y, z) through a decoder, with an optional source width.
 * 방향 (x, y, z)의 평면파가 디코더를 거친 스피커 게인 (음원 폭 선택).
 */
export function panGains(dec, x, y, z, width = 0, out = new Float64Array(dec.speakers.length), scratch = null) {
  const nCh = hoaChannels(dec.order);
  const b = shCoeffs(dec.order, x, y, z, scratch || new Float64Array(nCh));
  if (width > 0) { const ww = widthWeights(dec.order, width); for (let n = 1; n < nCh; n++) b[n] *= ww[acnOrder(n)]; }
  for (let k = 0; k < dec.speakers.length; k++) {
    const row = dec.matrix[k];
    let g = 0;
    for (let n = 0; n < nCh; n++) g += row[n] * b[n];
    out[k] = g;
  }
  return out;
}

/** Energy vector of speaker gains: { x, y, z, len, energy } (direction of the perceived source). */
export function energyVector(dec, gains) {
  let e = 0, x = 0, y = 0, z = 0;
  dec.speakers.forEach((d, k) => { const p = gains[k] * gains[k]; e += p; x += p * d[0]; y += p * d[1]; z += p * d[2]; });
  if (e <= 0) return { x: 0, y: 0, z: 0, len: 0, energy: 0 };
  return { x: x / e, y: y / e, z: z / e, len: Math.hypot(x, y, z) / e, energy: e };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('ambisonics: ambiX first order, closed forms, SN3D orthogonality, addition theorem', (a) => {
  const near = (v, w, msg) => { for (let i = 0; i < w.length; i++) a.near(v[i], w[i], 1e-12, `${msg} [${i}]`); };
  near(shCoeffs(1, 1, 0, 0), [1, 0, 0, 1], 'front → [W, Y, Z, X] = [1, 0, 0, 1]');
  near(shCoeffs(1, 0, 1, 0), [1, 1, 0, 0], 'left → Y = 1');
  near(shCoeffs(1, 0, 0, 1), [1, 0, 1, 0], 'up → Z = 1');
  near(shCoeffs(1, -3, 0, 0), [1, 0, 0, -1], 'behind (not normalised) → X = −1');
  // Closed forms of order 2 and two of order 3 at a general direction / 2차 전체와 3차 일부의 닫힌 식
  const az = 0.7;
  const el = -0.4;
  const [x, y, z] = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  const b = shCoeffs(3, x, y, z);
  const S3 = Math.sqrt(3);
  a.near(b[4], (S3 / 2) * Math.sin(2 * az) * Math.cos(el) ** 2, 1e-12, 'ACN 4 (V)');
  a.near(b[5], (S3 / 2) * Math.sin(az) * Math.sin(2 * el), 1e-12, 'ACN 5 (T)');
  a.near(b[6], 0.5 * (3 * Math.sin(el) ** 2 - 1), 1e-12, 'ACN 6 (R)');
  a.near(b[7], (S3 / 2) * Math.cos(az) * Math.sin(2 * el), 1e-12, 'ACN 7 (S)');
  a.near(b[8], (S3 / 2) * Math.cos(2 * az) * Math.cos(el) ** 2, 1e-12, 'ACN 8 (U)');
  a.near(b[12], 0.5 * Math.sin(el) * (5 * Math.sin(el) ** 2 - 3), 1e-12, 'ACN 12 (K)');
  a.near(b[15], Math.sqrt(5 / 8) * Math.cos(3 * az) * Math.cos(el) ** 3, 1e-12, 'ACN 15 (P)');
  // Orthogonality on a dense lattice: (1/K) Σ Y_i Y_j = δ_ij / (2l + 1) / 직교성
  const pts = fibonacciSphere(6000);
  const nCh = hoaChannels(4);
  const G = Array.from({ length: nCh }, () => new Float64Array(nCh));
  const tmp = new Float64Array(nCh);
  for (const p of pts) { shCoeffs(4, p[0], p[1], p[2], tmp); for (let i = 0; i < nCh; i++) for (let j = i; j < nCh; j++) G[i][j] += tmp[i] * tmp[j] / pts.length; }
  let worst = 0;
  for (let i = 0; i < nCh; i++) for (let j = i; j < nCh; j++) worst = Math.max(worst, Math.abs(G[i][j] - (i === j ? 1 / (2 * acnOrder(i) + 1) : 0)));
  a.ok(worst < 2e-3, `SN3D orthogonality up to order 4 (worst ${worst.toExponential(1)})`);
  // Addition theorem: Σ_m Y(a) Y(b) = P_l(cos γ) / 덧셈 정리
  const u = [0.2, -0.5, 0.84];
  const v = [-0.6, 0.3, 0.1];
  const cg = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
  const yu = shCoeffs(4, ...u);
  const yv = shCoeffs(4, ...v);
  for (let l = 0; l <= 4; l++) { let sum = 0; for (let n = l * l; n < (l + 1) * (l + 1); n++) sum += yu[n] * yv[n]; a.near(sum, legendre(l, cg), 1e-12, `addition theorem, order ${l}`); }
}, { group: 'math' });

registerSelfCheck('ambisonics: decoder round trip (direction, loudness), weights, source width', (a) => {
  const rnd = (() => { let s = 12345; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  for (const [order, maxDeg] of [[1, 5], [2, 5], [3, 5], [4, 5]]) {
    const dec = createDecoder(order, { weighting: 'maxre' });
    let worstAng = 0, sumLo = Infinity, sumHi = -Infinity, eLo = Infinity, eHi = -Infinity;
    const g = new Float64Array(dec.speakers.length);
    for (let i = 0; i < 500; i++) {
      const z = 2 * rnd() - 1;
      const ph = 2 * Math.PI * rnd();
      const d = [Math.sqrt(1 - z * z) * Math.cos(ph), Math.sqrt(1 - z * z) * Math.sin(ph), z];
      panGains(dec, d[0], d[1], d[2], 0, g);
      const ev = energyVector(dec, g);
      worstAng = Math.max(worstAng, (Math.acos(clamp((ev.x * d[0] + ev.y * d[1] + ev.z * d[2]) / Math.max(1e-12, Math.hypot(ev.x, ev.y, ev.z)), -1, 1)) * 180) / Math.PI);
      let sum = 0;
      for (const v of g) sum += v;
      sumLo = Math.min(sumLo, sum); sumHi = Math.max(sumHi, sum);
      eLo = Math.min(eLo, ev.energy); eHi = Math.max(eHi, ev.energy);
    }
    a.ok(worstAng <= maxDeg, `order ${order}: energy-vector direction error ${worstAng.toFixed(2)}° ≤ ${maxDeg}° (${dec.speakers.length} speakers)`);
    a.ok(Math.abs(sumLo - 1) < 0.07 && Math.abs(sumHi - 1) < 0.07, `order ${order}: Σ gains ≈ 1 (${sumLo.toFixed(4)}…${sumHi.toFixed(4)})`);
    a.ok(10 * Math.log10(eHi / eLo) < 1, `order ${order}: loudness within ${(10 * Math.log10(eHi / eLo)).toFixed(2)} dB over all directions`);
  }
  const w = orderWeights(3, 'maxre');
  a.ok(w[0] === 1 && w[1] > w[2] && w[2] > w[3] && w[3] > 0, 'max-rE weights fall with the order');
  a.near(orderWeights(3, 'inphase')[1], 0.6, 1e-12, 'in-phase weight of order 1 at N = 3 (3!·4! / (5!·2!))');
  a.ok(Array.from(orderWeights(4, 'basic')).every((v) => v === 1), 'basic weights are 1');
  // Width: 0 = unchanged, the energy vector shrinks monotonically, W stays / 폭: 0이면 그대로, 커질수록 퍼짐
  const dec = createDecoder(3);
  const g0 = panGains(dec, 1, 0.3, 0.2, 0);
  let prev = energyVector(dec, g0).len;
  a.ok(Array.from(panGains(dec, 1, 0.3, 0.2, 0)).every((v, i) => v === g0[i]), 'width 0 leaves the gains unchanged');
  for (const wd of [0.2, 0.4, 0.6, 0.8, 1]) {
    const gw = panGains(dec, 1, 0.3, 0.2, wd);
    const len = energyVector(dec, gw).len;
    a.ok(len < prev + 1e-9, `width ${wd}: energy vector ${len.toFixed(3)} ≤ ${prev.toFixed(3)}`);
    prev = len;
    let sum = 0;
    for (const v of gw) sum += v;
    a.near(sum, 1, 0.07, `width ${wd}: the omnidirectional part is kept`);
  }
  a.equal(widthWeights(3, 0.5)[0], 1, 'W is never scaled');
}, { group: 'math' });
