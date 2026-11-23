/**
 * Flexatone — studios/risset/dynamics.js
 * Risset Studio (pure): interaction dynamics of the voices on S¹ (A-5).
 * 리세 스튜디오 (순수): S¹ 위 보이스 상호작용 동역학.
 *
 * Frame. The macro rotation v₀ is the existing glissando speed v (with its shaping / automation /
 * v = 0 ⇒ y = 0 invariant). The dynamics act on each voice's position xᵢ *relative* to that rotating
 * frame: pᵢ = wrap(φ(t) + xᵢ(t)); xᵢ(0) = offᵢ/span (the harmonic grid). With every coefficient at 0
 * the positions never move, so v = 0 and zero coupling ⇒ phases are invariant.
 * 거시 회전 v₀ = 기존 v. 동역학은 회전 좌표계 안의 상대 위치 xᵢ에 작용.
 * (space-regions.js θ is a different thing: the rotation of the *reading* frame of the time × phase
 *  plane. They stay separate; rotated regions read the current xᵢ.)
 *
 * Forces (all periodic in Δ = xⱼ − xᵢ, so nothing jumps at the wrap) / 힘 (모두 주기 함수)
 *   Kuramoto–Sakaguchi  K/N·Σⱼ sin(2π(Δᵢⱼ − δᵢⱼ) − α)      δᵢⱼ = target spacing (grid), α = frustration
 *   critical-band repulsion  R·Σⱼ −sin(2πΔ)·exp(−(1 − cos 2πΔ)/(2π²w²))   w = CB width in phase units
 *   viscosity μ (neighbour kernel kᵢⱼ = exp(−d²/v²))
 *       laminar   −μ·Σ kᵢⱼ(uᵢ − uⱼ)   (damps relative motion → parallel motion, 병진행)
 *       turbulent −μ·Σ kᵢⱼ(uᵢ + uⱼ)   (damps common motion → contrary motion, 반진행)
 *   Boids (view radius v): alignment A·(ū − uᵢ), cohesion C·⟨sin 2πΔ⟩, separation −S·Σ sin(2πΔ)/(…)
 *   convection  Bᵢ − g·Mᵢ          (buoyancy from A-4 vs. gravity on the gravitational mass)
 *   directional drag  −γ↑·uᵢ (uᵢ > 0) / −γ↓·uᵢ (uᵢ < 0),   noise σ·ξ (seeded, reproducible)
 * Time orders / 시간 차수
 *   static  0th: equilibrium placement (1st-order flow relaxed to rest once per parameter set)
 *   first   1st: ẋᵢ = V·tanh(Fᵢ/((m₀ + Mᵢ)·V))                 (V = 1.5 cycle/s)
 *   second  2nd: ẋᵢ = uᵢ,  u̇ᵢ = A·tanh(Fᵢ/((m₀ + Mᵢ)·A))    (A = 40 cycle/s²)
 *   delay   1st order, coupling read at t − τ (imitative counterpoint / canon)
 * Integration: core/math-utils rk4Step at a fixed 100 Hz control rate.
 * No DOM, no Web Audio.
 */

import { clamp, rk4Step } from '../../core/math-utils.js';
import { inertialMass } from './local-particles.js';

export const DYN_ORDERS = Object.freeze(['off', 'static', 'first', 'second', 'delay']);
export const DYN_RATE = 100;
export const DYN_MAX_DELAY = 4;
const TWO_PI = 2 * Math.PI;
const wrapS = (d) => d - Math.round(d);
/** Smooth saturation of speed (cycles/s) and acceleration (cycles/s²): a light voice (small m₀ + M)
 *  under a strong force stays bounded and the 100 Hz RK4 step stays stable. / 속도·가속도 포화 */
export const V_MAX = 1.5;
export const A_MAX = 40;
export const U_MAX = 6;

/** Default dynamics (off ⇒ the classic rigid grid). / 기본값 (끔) */
export function createDefaultDynamics() {
  return {
    order: 'off',
    K: 0, // Kuramoto attraction toward the grid spacing / 쿠라모토 인력
    frustration: 0, // α (rad) / 좌절
    repulsion: 0, // critical-band repulsion / 임계 대역 척력
    viscosity: 0, // μ
    viscMode: 'laminar', // 'laminar' | 'turbulent'
    view: 0.08, // neighbour radius (phase) for viscosity & Boids / 시야 반경
    align: 0,
    cohesion: 0,
    separation: 0,
    gravity: 0, // g (convection with A-4 buoyancy) / 중력
    dragUp: 0.5, // directional resistance / 방향별 저항
    dragDown: 0.5,
    noise: 0,
    delaySec: 0.5,
    seed: 1,
  };
}

export function sanitizeDynamics(raw) {
  const d = createDefaultDynamics();
  const o = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!DYN_ORDERS.includes(o.order)) o.order = 'off';
  if (!['laminar', 'turbulent'].includes(o.viscMode)) o.viscMode = 'laminar';
  const num = (k, lo, hi) => { o[k] = clamp(Number.isFinite(Number(o[k])) ? Number(o[k]) : d[k], lo, hi); };
  num('K', -5, 5);
  num('frustration', -Math.PI, Math.PI);
  num('repulsion', 0, 5);
  num('viscosity', 0, 20);
  num('view', 0.005, 0.5);
  num('align', 0, 10);
  num('cohesion', 0, 5);
  num('separation', 0, 5);
  num('gravity', -2, 2);
  num('dragUp', 0, 20);
  num('dragDown', 0, 20);
  num('noise', 0, 1);
  num('delaySec', 0.01, DYN_MAX_DELAY);
  o.seed = Math.max(1, Math.round(Number(o.seed) || 1));
  return o;
}

export const isDynamicsOn = (d) => !!d && d.order !== 'off';

/** Seeded uniform RNG in [0, 1) (mulberry32). / 결정적 균등 난수 */
export function seededUniform(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Seeded normal noise (Box–Muller). / 결정적 정규 잡음 */
function makeNoise(seed) {
  const uni = seededUniform(seed * 7919 + 17);
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, uni()))) * Math.cos(TWO_PI * uni());
}

/** Fresh dynamics state starting on the grid. / 격자에서 시작하는 상태 */
export function createDynState(maxVoices, seed = 1) {
  const histLen = Math.ceil(DYN_MAX_DELAY * DYN_RATE) + 2;
  return {
    N: 0,
    x: new Float64Array(maxVoices),
    u: new Float64Array(maxVoices),
    grid: new Float64Array(maxVoices),
    acc: 0,
    t: 0,
    hist: new Float64Array(histLen * maxVoices),
    histLen,
    histHead: 0,
    histCount: 0,
    maxVoices,
    noise: makeNoise(seed),
    seed,
    staticKey: '',
    energy: 0,
    steps: 0,
  };
}

/** Put every voice back on the grid (x = off/span, u = 0). / 격자로 재배치 */
export function resetDynState(st, grid, N) {
  st.N = N;
  for (let i = 0; i < N; i++) { st.grid[i] = grid[i]; st.x[i] = grid[i]; st.u[i] = 0; }
  st.histCount = 0;
  st.histHead = 0;
  st.t = 0;
  st.acc = 0;
}

function histPush(st) {
  const base = st.histHead * st.maxVoices;
  for (let i = 0; i < st.N; i++) st.hist[base + i] = st.x[i];
  st.histHead = (st.histHead + 1) % st.histLen;
  st.histCount = Math.min(st.histLen, st.histCount + 1);
}

/** x_i(t − lag) from the 100 Hz history (nearest older sample; current x if not enough history). */
export function dynHistoryAt(st, i, lagSec) {
  const back = Math.round(lagSec * DYN_RATE);
  if (back <= 0 || st.histCount === 0) return st.x[i];
  const k = Math.min(back, st.histCount) ;
  const idx = (st.histHead - k + st.histLen * 2) % st.histLen;
  return st.hist[idx * st.maxVoices + i];
}

/**
 * Net force on every voice. env = { mass[], buoy[], cbw[] } (A-4 masses, buoyancy, critical-band
 * width per voice in phase units). xs/us = state, xd = delayed positions (or null).
 * 각 보이스의 알짜 힘.
 */
export function dynForces(d, N, xs, us, xd, env, out) {
  const kN = N > 1 ? d.K / N : 0;
  const view2 = d.view * d.view;
  const visc = d.viscosity;
  const turbulent = d.viscMode === 'turbulent';
  for (let i = 0; i < N; i++) {
    let F = 0;
    let alignSum = 0;
    let cohSum = 0;
    let sepSum = 0;
    let wSum = 0;
    const xi = xs[i];
    const ui = us ? us[i] : 0;
    const w = Math.max(1e-3, env.cbw ? env.cbw[i] : 0.02);
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const xj = xd ? xd[j] : xs[j];
      const dlt = wrapS(xj - xi);
      if (kN) F += kN * Math.sin(TWO_PI * (dlt - wrapS(env.grid[j] - env.grid[i])) - d.frustration);
      if (d.repulsion) F -= d.repulsion * Math.sin(TWO_PI * dlt) * Math.exp(-(1 - Math.cos(TWO_PI * dlt)) / (2 * Math.PI * Math.PI * w * w));
      const k = Math.exp(-(dlt * dlt) / view2);
      if (k > 1e-4) {
        const uj = us ? us[j] : 0;
        if (visc) F -= visc * k * (turbulent ? ui + uj : ui - uj);
        wSum += k;
        alignSum += k * uj;
        cohSum += k * Math.sin(TWO_PI * dlt);
        if (d.separation) sepSum -= k * Math.sin(TWO_PI * dlt) / Math.max(1e-3, Math.abs(dlt) / d.view);
      }
    }
    if (wSum > 1e-6) {
      if (d.align) F += d.align * (alignSum / wSum - ui);
      if (d.cohesion) F += d.cohesion * (cohSum / wSum);
      if (d.separation) F += d.separation * 0.01 * sepSum;
    }
    F += (env.buoy ? env.buoy[i] : 0) - d.gravity * (env.mass ? env.mass[i] : 0);
    F -= (ui > 0 ? d.dragUp : d.dragDown) * ui;
    out[i] = F;
  }
  return out;
}

/** Kinetic energy ½Σ(m₀ + M)u² (2nd order) or ½Σẋ² proxy. / 운동 에너지 */
export function kineticEnergy(st, m0, mass) {
  let e = 0;
  for (let i = 0; i < st.N; i++) e += 0.5 * inertialMass(m0, mass ? mass[i] : 0) * st.u[i] * st.u[i];
  return e;
}

/**
 * Advance the dynamics by dt (substeps of 1/DYN_RATE with RK4). `env` carries mass, buoyancy,
 * critical-band widths and the grid (target spacing). Returns the number of substeps taken.
 * dt만큼 진행 (100 Hz RK4 하위 스텝).
 */
export function stepDynamics(d, st, env, m0, dt) {
  const N = st.N;
  if (!isDynamicsOn(d) || N === 0) return 0;
  if (d.order === 'static') return 0; // placement is solved by relaxStatic / 정적 배치는 별도
  st.acc += Math.max(0, dt);
  const h = 1 / DYN_RATE;
  let n = 0;
  const F = new Float64Array(N);
  const minv = new Float64Array(N);
  for (let i = 0; i < N; i++) minv[i] = 1 / inertialMass(m0, env.mass ? env.mass[i] : 0);
  const xd = d.order === 'delay' ? new Float64Array(N) : null;
  while (st.acc >= h - 1e-12 && n < 400) {
    st.acc -= h;
    if (xd) for (let i = 0; i < N; i++) xd[i] = dynHistoryAt(st, i, d.delaySec);
    const sig = d.noise ? d.noise * Math.sqrt(DYN_RATE) : 0;
    const kick = new Float64Array(N);
    if (sig) for (let i = 0; i < N; i++) kick[i] = sig * st.noise();
    if (d.order === 'second') {
      const y0 = new Array(2 * N);
      for (let i = 0; i < N; i++) { y0[i] = st.x[i]; y0[N + i] = st.u[i]; }
      const f = (t, y) => {
        const xs = y.slice(0, N);
        const us = y.slice(N);
        dynForces(d, N, xs, us, null, env, F);
        const dy = new Array(2 * N);
        for (let i = 0; i < N; i++) { dy[i] = us[i]; dy[N + i] = A_MAX * Math.tanh(((F[i] + kick[i]) * minv[i]) / A_MAX); }
        return dy;
      };
      const y1 = rk4Step(f, st.t, y0, h);
      for (let i = 0; i < N; i++) { st.x[i] = y1[i]; st.u[i] = clamp(y1[N + i], -U_MAX, U_MAX); }
    } else {
      const y0 = Array.from(st.x.subarray(0, N));
      const f = (t, y) => {
        dynForces(d, N, y, null, xd, env, F);
        const dy = new Array(N);
        for (let i = 0; i < N; i++) dy[i] = V_MAX * Math.tanh(((F[i] + kick[i]) * minv[i]) / V_MAX);
        return dy;
      };
      const y1 = rk4Step(f, st.t, y0, h);
      for (let i = 0; i < N; i++) {
        st.u[i] = (y1[i] - st.x[i]) / h; // velocity estimate (for display / slots) / 속도 추정
        st.x[i] = y1[i];
      }
    }
    // keep x bounded (it lives on S¹) without touching the phase / 원 위 좌표 정규화
    for (let i = 0; i < N; i++) if (st.x[i] > 4 || st.x[i] < -4) st.x[i] -= Math.floor(st.x[i]);
    st.t += h;
    histPush(st);
    n++;
  }
  st.steps += n;
  return n;
}

/**
 * 0th order (static): relax the 1st-order flow to rest (no time), i.e. the equilibrium placement.
 * 0차: 1차 흐름을 정지까지 이완한 평형 배치 (시간 없음).
 */
export function relaxStatic(d, st, env, m0, { iters = 1500, tol = 1e-7 } = {}) {
  const N = st.N;
  const F = new Float64Array(N);
  const h = 1 / DYN_RATE;
  for (let k = 0; k < iters; k++) {
    dynForces({ ...d, viscosity: 0, align: 0, noise: 0 }, N, st.x, null, null, env, F);
    let mx = 0;
    for (let i = 0; i < N; i++) {
      const dx = h * V_MAX * Math.tanh(F[i] / inertialMass(m0, env.mass ? env.mass[i] : 0) / V_MAX);
      st.x[i] += dx;
      mx = Math.max(mx, Math.abs(dx));
    }
    if (mx < tol) break;
  }
  for (let i = 0; i < N; i++) st.u[i] = 0;
}
