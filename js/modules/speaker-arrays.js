/**
 * Flexatone — modules/speaker-arrays.js
 * Layer 1 (modules, pure): decoding higher-order Ambisonics (modules/ambisonics.js, ambiX) to REAL
 * loudspeaker arrays — layout presets, two decoder designs and their measured quality.
 * 계층 1 (modules, 순수): HOA를 실제 스피커 배열로 디코딩 — 배치 프리셋, 두 가지 디코더, 품질 실측.
 *
 * Angles / 각도: azimuth in degrees, 0 = front, POSITIVE = to the RIGHT (clockwise seen from above,
 *   like the Space studio's `az` read-out); elevation positive = up. ambiX axes: x front, y left, z up.
 * Layout / 배치: { id, speakers: [{ label, az, el, dist, lfe }] } in OUTPUT CHANNEL ORDER. An `lfe`
 *   entry is a channel that stays silent (5.1 / 7.1) — it has no direction and gets no signal.
 * Decoder / 디코더 (same shape as ambisonics.createDecoder, so audio/hoa-bus.js uses either):
 *   { order, speakers: [[x, y, z]], matrix: [Float64Array], weights, labels, chan: [output channel of
 *     speaker k], channels, flat, method, energyNorm, asked, limited }
 *   'modematch' — gains g with  Yᵀ g = b  (re-encoding the speaker signals gives back the sound field),
 *                 least-norm / Tikhonov-regularised pseudo-inverse, then the order weights (max-rE …).
 *                 Exact on regular arrays; on irregular ones (5.1) the loudness varies with direction.
 *   'allrad'    — All-Round Ambisonic Decoding: decode to many virtual speakers (a regular set), then
 *                 pan every virtual speaker to the real ones with VBAP. Robust on irregular arrays.
 *   energyNorm  — per direction, the gains are rescaled to a constant sum of squares (audio/hoa-bus.js
 *                 does it sample by sample: the gain curves are made per source, so this is possible).
 * Every decoder is scaled so that the MEAN energy Σg² over all directions is 1.
 *
 * The order is limited to what the array can carry: (N + 1)² ≤ K in 3-D, 2N + 1 ≤ K on a ring.
 * 차수는 배열이 감당하는 만큼으로 제한: 3D는 (N + 1)² ≤ K, 링은 2N + 1 ≤ K.
 *
 * Imports: core/*, modules/ambisonics.js.
 */

import { clamp } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';
import { shCoeffs, hoaChannels, acnOrder, orderWeights, fibonacciSphere, HOA_MAX_ORDER, HOA_WEIGHTINGS } from './ambisonics.js';

export const ARRAY_METHODS = Object.freeze(['modematch', 'allrad']);
export const ARRAY_LAYOUTS = Object.freeze(['quad', '5.1', '7.1', 'cube', 'octagon', 'custom']);
export const ARRAY_MAX_SPEAKERS = 32;
export const SOUND_SPEED = 343; // m/s, for the delay compensation / 지연 보정용

const DEG = Math.PI / 180;
const sp = (label, az, el = 0, extra = {}) => ({ label, az, el, dist: 2, lfe: false, ...extra });
const LFE = () => ({ label: 'LFE', az: 0, el: 0, dist: 2, lfe: true });
const CUBE_EL = 35.264; // atan(1 / √2): the corners of a cube / 정육면체 꼭짓점의 고도

const PRESETS = {
  quad: () => [sp('L', -45), sp('R', 45), sp('Ls', -135), sp('Rs', 135)],
  '5.1': () => [sp('L', -30), sp('R', 30), sp('C', 0), LFE(), sp('Ls', -110), sp('Rs', 110)],
  '7.1': () => [sp('L', -30), sp('R', 30), sp('C', 0), LFE(), sp('Lrs', -150), sp('Rrs', 150), sp('Lss', -90), sp('Rss', 90)], // WAV order: FL FR FC LFE BL BR SL SR
  cube: () => [sp('FLd', -45, -CUBE_EL), sp('FRd', 45, -CUBE_EL), sp('RLd', -135, -CUBE_EL), sp('RRd', 135, -CUBE_EL), sp('FLu', -45, CUBE_EL), sp('FRu', 45, CUBE_EL), sp('RLu', -135, CUBE_EL), sp('RRu', 135, CUBE_EL)],
  octagon: () => Array.from({ length: 8 }, (_, i) => sp(String(i + 1), i * 45 > 180 ? i * 45 - 360 : i * 45)),
};

const fin = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);

/** Fill / clamp one speaker of a custom table. / 사용자 표의 스피커 하나 보정 */
export function normalizeSpeaker(raw, i = 0) {
  return {
    label: typeof raw?.label === 'string' && raw.label ? raw.label.slice(0, 8) : String(i + 1),
    az: clamp(fin(raw?.az), -180, 180),
    el: clamp(fin(raw?.el), -90, 90),
    dist: clamp(fin(raw?.dist, 2), 0.2, 100),
    lfe: !!raw?.lfe,
  };
}

/** The layout of an id (a preset, or the custom table). / 배치 (프리셋 또는 사용자 표) */
export function getLayout(id = 'quad', custom = null) {
  if (id === 'custom') {
    const list = (Array.isArray(custom) ? custom : []).slice(0, ARRAY_MAX_SPEAKERS).map(normalizeSpeaker);
    return { id: 'custom', speakers: list.length >= 2 ? list : PRESETS.quad() };
  }
  const make = PRESETS[id] || PRESETS.quad;
  return { id: PRESETS[id] ? id : 'quad', speakers: make() };
}

/** Unit vector (ambiX axes) of an azimuth (right-positive) and elevation in degrees. / 방위·고도 → 단위 벡터 */
export function dirOf(az, el = 0) {
  const a = az * DEG;
  const e = el * DEG;
  return [Math.cos(e) * Math.cos(a), -Math.cos(e) * Math.sin(a), Math.sin(e)];
}

/** Is every loudspeaker in the horizontal plane (a ring)? / 모든 스피커가 수평면에 있는가 */
export const isFlat = (layout) => layout.speakers.filter((s) => !s.lfe).every((s) => Math.abs(s.el) < 1);

/** Highest order the array can carry. / 배열이 감당하는 최대 차수 */
export function maxArrayOrder(layout) {
  const K = layout.speakers.filter((s) => !s.lfe).length;
  const n = isFlat(layout) ? Math.floor((K - 1) / 2) : Math.floor(Math.sqrt(K)) - 1;
  return clamp(n, 1, HOA_MAX_ORDER);
}

/** Channel order as text: "1 L · 2 R · 3 C · 4 LFE …". / 채널 순서 표기 */
export const channelOrderText = (layout) => layout.speakers.map((s, i) => `${i + 1} ${s.label}`).join(' · ');

/** Delay (samples) that makes every speaker arrive with the farthest one. / 가장 먼 스피커에 맞추는 지연 (샘플) */
export function delayCompensation(dists, sampleRate, c = SOUND_SPEED) {
  const far = Math.max(...dists);
  return dists.map((d) => Math.round(((far - d) / c) * sampleRate));
}

// --------------------------------------------------------------------------
// Linear algebra / 선형대수
// --------------------------------------------------------------------------

/** Solve A X = B (A: n × n, B: n × m) by Gauss–Jordan with partial pivoting. / 가우스–조르당 */
function solve(A, B) {
  const n = A.length;
  const m = B[0].length;
  const M = A.map((r, i) => [...r, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-300;
    for (let k = c; k < n + m; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r) => r.slice(n));
}

// --------------------------------------------------------------------------
// VBAP (vector base amplitude panning) / 벡터 기반 진폭 패닝
// --------------------------------------------------------------------------

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * VBAP gains of direction p over the loudspeakers `dirs` (unit energy, all ≥ 0).
 * Ring: the adjacent pair that holds the azimuth of p. 3-D: the tightest triplet that holds p; a
 * direction no triplet holds (below a dome) goes to the nearest loudspeaker.
 * VBAP 게인 (에너지 1, 음수 없음). 링은 인접한 쌍, 3D는 p를 포함하는 가장 좁은 삼각형.
 */
export function vbapGains(dirs, p, flat = false) {
  const K = dirs.length;
  const g = new Float64Array(K);
  if (flat) {
    const az = Math.atan2(p[1], p[0]);
    const order = dirs.map((d, k) => [Math.atan2(d[1], d[0]), k]).sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < K; i++) {
      const [a0, k0] = order[i];
      const [a1raw, k1] = order[(i + 1) % K];
      const a1 = i === K - 1 ? a1raw + 2 * Math.PI : a1raw;
      let a = az;
      while (a < a0) a += 2 * Math.PI;
      while (a >= a0 + 2 * Math.PI) a -= 2 * Math.PI;
      if (a > a1 + 1e-12) continue;
      const span = a1 - a0;
      if (span >= Math.PI - 1e-9) { g[a - a0 < a1 - a ? k0 : k1] = 1; return g; } // a gap of half a circle or more: no phantom source / 반원 이상의 틈
      // 2 × 2 vector base in the plane / 평면의 2 × 2 벡터 기저
      const d0 = [Math.cos(a0), Math.sin(a0)];
      const d1 = [Math.cos(a1), Math.sin(a1)];
      const det = d0[0] * d1[1] - d0[1] * d1[0];
      const q = [Math.cos(a), Math.sin(a)];
      const g0 = Math.max(0, (q[0] * d1[1] - q[1] * d1[0]) / det);
      const g1 = Math.max(0, (d0[0] * q[1] - d0[1] * q[0]) / det);
      const n = Math.hypot(g0, g1) || 1;
      g[k0] = g0 / n;
      g[k1] = g1 / n;
      return g;
    }
    return g;
  }
  let best = null;
  let bestSpread = Infinity;
  for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) for (let k = j + 1; k < K; k++) {
    const a = dirs[i], b = dirs[j], c = dirs[k];
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    if (Math.abs(det) < 1e-6) continue;
    // p = gi a + gj b + gk c  (Cramer) / 크라메르 공식
    const gi = (p[0] * (b[1] * c[2] - b[2] * c[1]) - p[1] * (b[0] * c[2] - b[2] * c[0]) + p[2] * (b[0] * c[1] - b[1] * c[0])) / det;
    const gj = (a[0] * (p[1] * c[2] - p[2] * c[1]) - a[1] * (p[0] * c[2] - p[2] * c[0]) + a[2] * (p[0] * c[1] - p[1] * c[0])) / det;
    const gk = (a[0] * (b[1] * p[2] - b[2] * p[1]) - a[1] * (b[0] * p[2] - b[2] * p[0]) + a[2] * (b[0] * p[1] - b[1] * p[0])) / det;
    if (gi < -1e-9 || gj < -1e-9 || gk < -1e-9) continue;
    const spread = -Math.min(dot(a, b), dot(a, c), dot(b, c)); // the widest side of the triangle / 삼각형의 가장 넓은 변
    if (spread < bestSpread - 1e-12) { bestSpread = spread; best = [i, j, k, Math.max(0, gi), Math.max(0, gj), Math.max(0, gk)]; }
  }
  if (!best) {
    let near = 0;
    for (let k = 1; k < K; k++) if (dot(dirs[k], p) > dot(dirs[near], p)) near = k;
    g[near] = 1;
    return g;
  }
  const n = Math.hypot(best[3], best[4], best[5]) || 1;
  g[best[0]] = best[3] / n;
  g[best[1]] = best[4] / n;
  g[best[2]] = best[5] / n;
  return g;
}

// --------------------------------------------------------------------------
// Decoders / 디코더
// --------------------------------------------------------------------------

/** Test / virtual directions: a circle for a ring, a sphere otherwise. / 시험·가상 방향 */
function probeDirs(flat, count) {
  if (!flat) return fibonacciSphere(count);
  return Array.from({ length: count }, (_, i) => { const a = (2 * Math.PI * i) / count; return [Math.cos(a), Math.sin(a), 0]; });
}

const cache = new Map();

/**
 * Decoder of an array. `order` is what was asked for; the result's `order` may be lower (`limited`).
 * 배열 디코더. 요청 차수보다 낮아질 수 있음 (limited).
 */
export function createArrayDecoder(layout, { order = 3, weighting = 'maxre', method = 'modematch', energyNorm = false } = {}) {
  const key = JSON.stringify([layout.speakers, order, weighting, method, energyNorm]);
  const hit = cache.get(key);
  if (hit) return hit;
  const real = layout.speakers.map((s, i) => ({ ...s, i })).filter((s) => !s.lfe);
  const dirs = real.map((s) => dirOf(s.az, s.el));
  const K = dirs.length;
  const flat = isFlat(layout);
  const asked = clamp(Math.floor(Number(order) || 1), 1, HOA_MAX_ORDER);
  const N = Math.min(asked, maxArrayOrder(layout));
  const nCh = hoaChannels(N);
  const wKind = HOA_WEIGHTINGS.includes(weighting) ? weighting : 'maxre';
  const w = orderWeights(N, wKind);
  const meth = ARRAY_METHODS.includes(method) ? method : 'modematch';
  let matrix;
  if (meth === 'allrad') {
    const J = flat ? 72 : 240;
    const virt = probeDirs(flat, J);
    const V = virt.map((p) => vbapGains(dirs, p, flat)); // J × K
    matrix = dirs.map(() => new Float64Array(nCh));
    virt.forEach((p, j) => {
      const y = shCoeffs(N, p[0], p[1], p[2]);
      for (let n = 0; n < nCh; n++) {
        const l = acnOrder(n);
        const dv = (w[l] * (flat ? (l === 0 ? 1 : 2) : 2 * l + 1) * y[n]) / J; // sampling decoder (circle / sphere quadrature) / 표본화 디코더
        if (dv) for (let k = 0; k < K; k++) matrix[k][n] += V[j][k] * dv;
      }
    });
  } else {
    // g = Y (YᵀY + λI)⁻¹ b = (YYᵀ + λI)⁻¹ Y b : solve the K × K system / K × K 계 풀이
    // A ring cannot reproduce the harmonics that vary with height: only the sectoral ones (m = ±l,
    // ACN l² and l² + 2l) are matched there, the others get no gain. / 링은 섹토럴 조화(m = ±l)만 맞춤
    const used = (n) => { if (!flat) return true; const l = acnOrder(n); return n === l * l || n === l * l + 2 * l; };
    const Y = dirs.map((d) => Array.from(shCoeffs(N, d[0], d[1], d[2]), (v, n) => (used(n) ? v : 0)));
    const A = Y.map((r, i) => Y.map((q, j) => r.reduce((s, v, n) => s + v * q[n], 0) + (i === j ? 1e-6 : 0)));
    const X = solve(A, Y);
    matrix = X.map((row) => Float64Array.from(row, (v, n) => v * w[acnOrder(n)]));
  }
  // Scale: mean energy over all directions = 1 / 모든 방향의 평균 에너지 = 1
  const probe = probeDirs(flat, flat ? 180 : 600);
  let mean = 0;
  for (const p of probe) {
    const y = shCoeffs(N, p[0], p[1], p[2]);
    for (let k = 0; k < K; k++) { let g = 0; for (let n = 0; n < nCh; n++) g += matrix[k][n] * y[n]; mean += g * g; }
  }
  mean /= probe.length;
  const scale = mean > 1e-18 ? 1 / Math.sqrt(mean) : 1;
  for (const row of matrix) for (let n = 0; n < nCh; n++) row[n] *= scale;
  const dec = Object.freeze({
    order: N, asked, limited: N < asked, speakers: dirs, matrix, weights: w, weighting: wKind, method: meth, energyNorm: !!energyNorm, flat,
    labels: real.map((s) => s.label), chan: real.map((s) => s.i), dist: real.map((s) => s.dist), channels: layout.speakers.length,
  });
  cache.set(key, dec);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return dec;
}

/** Speaker gains of a plane wave from p (with the decoder's energy normalisation). / 방향 p의 스피커 게인 */
export function arrayGains(dec, p, out = new Float64Array(dec.speakers.length)) {
  const y = shCoeffs(dec.order, p[0], p[1], p[2]);
  const nCh = y.length;
  let e = 0;
  for (let k = 0; k < out.length; k++) { let g = 0; for (let n = 0; n < nCh; n++) g += dec.matrix[k][n] * y[n]; out[k] = g; e += g * g; }
  if (dec.energyNorm && e > 1e-18) { const s = 1 / Math.sqrt(e); for (let k = 0; k < out.length; k++) out[k] *= s; }
  return out;
}

/**
 * Measured quality over all directions (a circle for a ring): the angle between the source and the
 * energy vector r_E (where it is heard at mid / high frequencies) and the spread of the loudness.
 * @returns {{ errMean, errMax, energyMinDb, energyMaxDb, rEMean }}
 * 모든 방향에서의 실측 품질: 음원 방향과 에너지 벡터 r_E의 각도, 음량의 퍼짐.
 */
export function arrayMetrics(dec, count = null) {
  const probe = probeDirs(dec.flat, count || (dec.flat ? 180 : 400));
  const g = new Float64Array(dec.speakers.length);
  let errSum = 0, errMax = 0, eMin = Infinity, eMax = 0, rSum = 0;
  for (const p of probe) {
    arrayGains(dec, p, g);
    let e = 0, x = 0, y = 0, z = 0;
    dec.speakers.forEach((d, k) => { const q = g[k] * g[k]; e += q; x += q * d[0]; y += q * d[1]; z += q * d[2]; });
    const len = Math.hypot(x, y, z);
    const err = len > 1e-12 ? Math.acos(clamp((x * p[0] + y * p[1] + z * p[2]) / len, -1, 1)) / DEG : 180;
    errSum += err;
    errMax = Math.max(errMax, err);
    eMin = Math.min(eMin, e);
    eMax = Math.max(eMax, e);
    rSum += e > 0 ? len / e : 0;
  }
  return { errMean: errSum / probe.length, errMax, energyMinDb: 10 * Math.log10(Math.max(1e-12, eMin)), energyMaxDb: 10 * Math.log10(Math.max(1e-12, eMax)), rEMean: rSum / probe.length };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('speaker arrays: layouts, order limit, direction error + loudness per layout, VBAP, delays', (a) => {
  a.equal(getLayout('5.1').speakers.map((s) => s.label).join(' '), 'L R C LFE Ls Rs', '5.1 channel order');
  a.equal(getLayout('7.1').speakers.map((s) => s.label).join(' '), 'L R C LFE Lrs Rrs Lss Rss', '7.1 channel order (WAV: FL FR FC LFE BL BR SL SR)');
  const right = dirOf(90);
  a.ok(Math.abs(right[0]) < 1e-12 && Math.abs(right[1] + 1) < 1e-12, 'azimuth +90° = right = ambiX −y');
  a.ok(maxArrayOrder(getLayout('quad')) === 1 && maxArrayOrder(getLayout('octagon')) === 3 && maxArrayOrder(getLayout('cube')) === 1 && maxArrayOrder(getLayout('5.1')) === 2, 'order limits: quad 1, octagon 3, cube 1, 5.1 → 2');
  const limited = createArrayDecoder(getLayout('quad'), { order: 4 });
  a.ok(limited.order === 1 && limited.limited && limited.chan.join() === '0,1,2,3', 'a higher order is limited to what the array carries');
  const d51 = createArrayDecoder(getLayout('5.1'), { order: 2 });
  a.ok(d51.channels === 6 && d51.speakers.length === 5 && d51.chan.join() === '0,1,2,4,5', '5.1: five loudspeakers on six channels, the LFE channel is skipped');
  // Regular arrays: mode matching points where the source is, at even loudness / 정규 배열: 방향 일치, 균일한 음량
  for (const [id, order, errMax, spread] of [['quad', 1, 0.5, 0.05], ['octagon', 3, 0.5, 0.05], ['cube', 1, 0.5, 0.05]]) {
    const m = arrayMetrics(createArrayDecoder(getLayout(id), { order }));
    a.ok(m.errMax < errMax, `${id}: r_E points at the source (max ${m.errMax.toFixed(3)}°)`);
    a.ok(m.energyMaxDb - m.energyMinDb < spread, `${id}: loudness even within ${(m.energyMaxDb - m.energyMinDb).toFixed(3)} dB`);
    a.ok(Math.abs(10 ** (m.energyMinDb / 10) - 1) < 0.02, `${id}: mean energy = 1`);
  }
  // Irregular 5.1: AllRAD localises better than mode matching; energy normalisation flattens the loudness
  // 불규칙한 5.1: AllRAD가 모드 매칭보다 방향이 정확하고, 에너지 정규화는 음량을 평탄하게 함
  const mm = arrayMetrics(createArrayDecoder(getLayout('5.1'), { order: 2 }));
  const ar = arrayMetrics(createArrayDecoder(getLayout('5.1'), { order: 2, method: 'allrad' }));
  const en = arrayMetrics(createArrayDecoder(getLayout('5.1'), { order: 2, method: 'allrad', energyNorm: true }));
  a.ok(ar.errMean < mm.errMean, `5.1 mean direction error: AllRAD ${ar.errMean.toFixed(1)}° < mode matching ${mm.errMean.toFixed(1)}°`);
  a.ok(ar.errMax < 40, `5.1 AllRAD max direction error ${ar.errMax.toFixed(1)}° (the rear gap is 140° wide)`);
  a.ok(en.energyMaxDb - en.energyMinDb < 1e-6 && ar.energyMaxDb - ar.energyMinDb > 0.1, `energy normalisation: ${(ar.energyMaxDb - ar.energyMinDb).toFixed(2)} dB → flat`);
  // VBAP / VBAP
  const ring = getLayout('octagon').speakers.map((s) => dirOf(s.az, s.el));
  const on = vbapGains(ring, dirOf(45), true);
  a.ok(Math.abs(on[1] - 1) < 1e-9 && on.reduce((s, v) => s + v * v, 0) > 0.999, 'VBAP on a loudspeaker = that loudspeaker alone');
  const mid = vbapGains(ring, dirOf(22.5), true);
  a.ok(Math.abs(mid[0] - mid[1]) < 1e-9 && Math.abs(mid[0] - Math.SQRT1_2) < 1e-9 && mid.filter((v) => v > 1e-9).length === 2, 'VBAP half-way = the adjacent pair at −3 dB each');
  const cube = getLayout('cube').speakers.map((s) => dirOf(s.az, s.el));
  const up = vbapGains(cube, [0, 0, 1]);
  a.ok(up.slice(0, 4).every((v) => v < 1e-9) && up.reduce((s, v) => s + v * v, 0) > 0.999 && up.every((v) => v >= 0), 'VBAP straight up on a cube: upper loudspeakers only, no negative gains');
  // Delay compensation / 지연 보정
  a.equal(delayCompensation([2, 3, 2.5], 48000).join(), `${Math.round((1 / 343) * 48000)},0,${Math.round((0.5 / 343) * 48000)}`, 'nearer loudspeakers wait: (far − d) / c · rate samples');
  a.ok(getLayout('custom', [{ az: 0 }]).speakers.length === 4, 'a custom table needs two loudspeakers (else the quad)');
  a.equal(channelOrderText(getLayout('quad')), '1 L · 2 R · 3 Ls · 4 Rs', 'channel order text');
});
