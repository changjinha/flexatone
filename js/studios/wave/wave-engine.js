/**
 * Flexatone — studios/wave/wave-engine.js
 * Wave Studio (pure): 1-D PDE solvers on the pitch axis, edit-time bake cache, amplitude matrix
 * and ridge tracking. No DOM, no Web Audio, no ui/audio imports (architecture DAG).
 * 웨이브 스튜디오 (순수): 음고 축 위의 1차원 PDE 풀이, 에디팅 시점 베이킹 캐시, 진폭 행렬, 리지 추적.
 *
 * The pitch axis is the medium: x ∈ [pLo, pHi] in semitones (MIDI, linear), Nx grid points,
 * dx = (pHi − pLo)/(Nx − 1) st. Model time = piece time × simSpeed.
 * 음고 축 = 매질. x는 반음 단위(MIDI 선형), 모델 시간 = 곡 시간 × simSpeed.
 *
 *   wave  u_tt = c(x)²·(u_xx − D·u_xxxx) − γ·u_t        D ≥ 0 (stiff-string sign: well-posed)
 *   kg    u_tt = c(x)²·u_xx − m²·u − γ·u_t              Klein–Gordon
 *   sg    u_tt = c(x)²·u_xx − m²·sin u − γ·u_t          sine-Gordon (kink width c/m)
 *   gs    u_t = Du·u_xx − u·v² + F·(1 − u),  v_t = Dv·v_xx + u·v² − (F + k)·v   Gray–Scott
 *
 * Numerics / 수치 방법
 *   wave/kg/sg  Störmer–Verlet (leapfrog), position form, damping centred (half-step correction):
 *                 uⁿ⁺¹ = (2uⁿ − (1 − γΔt/2)·uⁿ⁻¹ + Δt²·F(uⁿ)) / (1 + γΔt/2)
 *               Δt = min(CFL_req, 1)·dx/c_max, further limited by 2/ω_max when D or m are set.
 *               Frames (bakeRate) are linear interpolations between the two leapfrog levels.
 *   gs          explicit Euler, D_max·Δt/dx² ≤ 0.45 and Δt ≤ 1 t.u. (GS_TU_PER_SEC t.u. per second).
 *   Boundaries  fixed (Dirichlet at the initial end values, odd ghost → sign flip),
 *               free (Neumann, even ghost → sign kept), absorbing (Mur 1st order), periodic.
 *
 * Bake result / 베이킹 결과: U[frame·Nx + bin] (signed field; v for gs) and W (local energy
 * ½(u_t² + c²u_x²) + potential; u·v² for gs), both Float32Array — cached by a physics signature
 * (sound and view parameters are NOT part of it). Same input → same output (seeded PRNG).
 */

import { clamp, lerp, roundTo, deepClone, createSeededRandom } from '../../core/math-utils.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { timbreSpecExtras } from '../../modules/timbre-spec.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { normalizeVoiceMod } from '../../core/voice-mod.js';

export const WAVE_EQS = Object.freeze(['wave', 'kg', 'sg', 'gs']);
export const WAVE_BOUNDARIES = Object.freeze(['fixed', 'free', 'absorbing', 'periodic']);
export const WAVE_INIT_KINDS = Object.freeze(['gauss', 'tri', 'box', 'standing', 'kink', 'noise']);
export const WAVE_SONIFY_MODES = Object.freeze(['spectral', 'ridge']);
export const WAVE_SOURCES = Object.freeze(['abs', 'energy']);
export const WAVE_COLORS = Object.freeze(['signed', 'abs', 'energy']);
export const WAVE_ENGINES = Object.freeze(['auto', 'oscillators']);
export const WAVE_NX = Object.freeze([64, 96, 128, 192, 256]);
export const WAVE_PRESET_IDS = Object.freeze(['pulse', 'chord', 'kink', 'medium', 'bloom']);
export const WAVE_TIMBRE_WAVES = Object.freeze(['sine', 'tri', 'saw', 'sqr', 'rich']);

/** Largest baked matrix (frames × Nx); the bake rate is lowered to stay below it. / 행렬 상한 */
export const WAVE_MAX_CELLS = 2400000;
export const WAVE_MAX_INIT = 8;
export const WAVE_MAX_DRIVERS = 6;
export const WAVE_MAX_TRACKS = 64;
/** Gray–Scott time units per model second. / 모델 1초당 Gray–Scott 시간 단위 */
export const GS_TU_PER_SEC = 100;
/** Master level of the additive bank / ridge voices before 1/√Σa² normalisation. / 마스터 레벨 */
export const WAVE_MASTER = 0.25;

const G = 2; // ghost cells on each side / 양쪽 고스트 셀 수
const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// ==========================================================================
// 1. Document / 문서
// ==========================================================================

export function createWaveInit(kind = 'gauss', over = {}) {
  return { kind, x: 0.5, width: 2, amp: 1, mode: 3, velocity: 0, ...over };
}

export function createWaveDriver(over = {}) {
  return { x: 0.5, hz: 1, amp: 0.5, t0: 0, dur: 4, ...over };
}

const flatCurve = (y0, y1) => ({ engine: 'custom', customPoints: [{ x: 0, y: y0, handles: [] }, { x: 1, y: y1, handles: [] }] });

/** Default document = the "Single Pulse" preset. Deterministic (stable bake signature). */
export function createDefaultWaveParams() {
  return {
    preset: 'pulse',
    eq: 'wave',
    Nx: 128,
    pLo: 36,
    pHi: 96,
    length: 30,
    bakeRate: 100,
    simSpeed: 1,
    speed: 12, // st / model second where the medium multiplier is 1 / 매질 배율 1에서의 파속
    cfl: 0.9,
    c: flatCurve(0.5, 0.5), // medium multiplier = lerp(cLo, cHi, y(x)) / 매질 배율 곡선
    cLo: 0.5,
    cHi: 1.5,
    damping: 0,
    dispersion: 0,
    mass: 4,
    boundary: 'fixed',
    init: [createWaveInit('gauss', { x: 0.5, width: 2, amp: 1 })],
    drivers: [],
    gs: { Du: 0.036, Dv: 0.018, F: 0.03, k: 0.057 },
    sonify: {
      mode: 'spectral',
      source: 'abs',
      ampPower: 1,
      gain: 1,
      floor: 1e-3,
      stereo: 0.5,
      engine: 'auto',
      peakThresh: 0.1,
      maxTracks: 16,
      maxJump: 3,
      maxGap: 0.4,
    },
    timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 },
    seed: 1,
    view: { tMin: -0.8, tMax: 30.6, midiMin: 32, midiMax: 100, color: 'signed', showRidges: true, showGrid: true },
  };
}

/** The five presets (full documents). / 프리셋 5종 */
export function createWavePreset(id) {
  const d = createDefaultWaveParams();
  d.preset = WAVE_PRESET_IDS.includes(id) ? id : 'pulse';
  if (id === 'chord') {
    d.init = [
      createWaveInit('standing', { mode: 3, amp: 0.8 }),
      createWaveInit('standing', { mode: 5, amp: 0.6 }),
      createWaveInit('standing', { mode: 8, amp: 0.5 }),
    ];
  } else if (id === 'kink') {
    d.eq = 'sg';
    d.Nx = 192;
    d.mass = 4;
    d.init = [
      createWaveInit('kink', { x: 0.25, amp: 1, velocity: 0.4 }),
      createWaveInit('kink', { x: 0.75, amp: -1, velocity: -0.4 }),
    ];
    d.sonify.source = 'energy';
    d.view.color = 'energy';
  } else if (id === 'medium') {
    d.speed = 10;
    d.c = flatCurve(0, 1);
    d.cLo = 0.5;
    d.cHi = 2;
    d.init = [
      createWaveInit('gauss', { x: 0.12, width: 1.5, amp: 1, velocity: 1 }),
      createWaveInit('gauss', { x: 0.6, width: 1.5, amp: -0.7, velocity: -1 }),
    ];
  } else if (id === 'bloom') {
    d.eq = 'gs';
    d.boundary = 'free';
    d.init = [createWaveInit('gauss', { x: 0.5, width: 2, amp: 1 })];
    d.sonify.ampPower = 1.5;
    d.view.color = 'abs';
  }
  return d;
}

function sanitizeCurve(c, dflt) {
  const src = Array.isArray(c?.customPoints) ? c.customPoints : dflt.customPoints;
  let pts = src
    .filter((q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)))
    .map((q) => ({ x: roundTo(clamp(Number(q.x), 0, 1), 4), y: roundTo(clamp(Number(q.y), 0, 1), 4), handles: [] }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 2) pts = deepClone(dflt.customPoints);
  if (pts.length > 12) pts = [...pts.slice(0, 11), pts[pts.length - 1]];
  pts[0].x = 0;
  pts[pts.length - 1].x = 1;
  for (let i = 1; i < pts.length - 1; i++) pts[i].x = roundTo(clamp(pts[i].x, pts[i - 1].x + 0.002, 0.998), 4);
  return { engine: 'custom', customPoints: pts };
}

/** Fill defaults and clamp every field (old / partial documents load safely). / 문서 정규화 */
export function sanitizeWaveParams(raw) {
  const d = createDefaultWaveParams();
  const s = raw && typeof raw === 'object' ? raw : {};
  const pick = (v, list, dv) => (list.includes(v) ? v : dv);
  const p = {};
  p.preset = typeof s.preset === 'string' ? s.preset.slice(0, 24) : d.preset;
  p.eq = pick(s.eq, WAVE_EQS, d.eq);
  p.Nx = Math.round(num(s.Nx, d.Nx, 16, 256));
  p.pLo = roundTo(num(s.pLo, d.pLo, 0, 116), 3);
  p.pHi = roundTo(num(s.pHi, d.pHi, 4, 124), 3);
  if (p.pHi < p.pLo + 4) p.pHi = Math.min(124, p.pLo + 4);
  if (p.pHi < p.pLo + 4) p.pLo = p.pHi - 4;
  p.length = roundTo(num(s.length, d.length, 1, 120), 3);
  p.bakeRate = roundTo(num(s.bakeRate, d.bakeRate, 10, 200), 3);
  p.simSpeed = roundTo(num(s.simSpeed, d.simSpeed, 0.05, 8), 4);
  p.speed = roundTo(num(s.speed, d.speed, 0.5, 120), 4);
  p.cfl = roundTo(num(s.cfl, d.cfl, 0.05, 2), 4);
  p.c = sanitizeCurve(s.c, d.c);
  p.cLo = roundTo(num(s.cLo, d.cLo, 0.1, 4), 4);
  p.cHi = roundTo(num(s.cHi, d.cHi, 0.1, 4), 4);
  p.damping = roundTo(num(s.damping, d.damping, 0, 5), 4);
  p.dispersion = roundTo(num(s.dispersion, d.dispersion, 0, 4), 4);
  p.mass = roundTo(num(s.mass, d.mass, 0, 40), 4);
  p.boundary = pick(s.boundary, WAVE_BOUNDARIES, d.boundary);
  p.init = (Array.isArray(s.init) ? s.init : d.init).slice(0, WAVE_MAX_INIT).map((it) => ({
    kind: pick(it?.kind, WAVE_INIT_KINDS, 'gauss'),
    x: roundTo(num(it?.x, 0.5, 0, 1), 4),
    width: roundTo(num(it?.width, 2, 0.25, 24), 3),
    amp: roundTo(num(it?.amp, 1, -1, 1), 4),
    mode: Math.round(num(it?.mode, 3, 1, 32)),
    velocity: roundTo(num(it?.velocity, 0, -1, 1), 4),
  }));
  p.drivers = (Array.isArray(s.drivers) ? s.drivers : d.drivers).slice(0, WAVE_MAX_DRIVERS).map((it) => ({
    x: roundTo(num(it?.x, 0.5, 0, 1), 4),
    hz: roundTo(num(it?.hz, 1, 0.05, 30), 4),
    amp: roundTo(num(it?.amp, 0.5, -1, 1), 4),
    t0: roundTo(num(it?.t0, 0, 0, 120), 3),
    dur: roundTo(num(it?.dur, 4, 0, 120), 3),
  }));
  const g = s.gs || {};
  p.gs = {
    Du: roundTo(num(g.Du, d.gs.Du, 0.001, 5), 5),
    Dv: roundTo(num(g.Dv, d.gs.Dv, 0.001, 5), 5),
    F: roundTo(num(g.F, d.gs.F, 0.001, 0.12), 5),
    k: roundTo(num(g.k, d.gs.k, 0.01, 0.08), 5),
  };
  const so = s.sonify || {};
  p.sonify = {
    mode: pick(so.mode, WAVE_SONIFY_MODES, d.sonify.mode),
    source: pick(so.source, WAVE_SOURCES, d.sonify.source),
    ampPower: roundTo(num(so.ampPower, d.sonify.ampPower, 0.25, 4), 3),
    gain: roundTo(num(so.gain, d.sonify.gain, 0, 4), 3),
    floor: num(so.floor, d.sonify.floor, 0, 0.5),
    stereo: roundTo(num(so.stereo, d.sonify.stereo, 0, 1), 3),
    engine: pick(so.engine, WAVE_ENGINES, d.sonify.engine),
    peakThresh: roundTo(num(so.peakThresh, d.sonify.peakThresh, 0.01, 0.95), 3),
    maxTracks: Math.round(num(so.maxTracks, d.sonify.maxTracks, 1, WAVE_MAX_TRACKS)),
    maxJump: roundTo(num(so.maxJump, d.sonify.maxJump, 0.1, 12), 3),
    maxGap: roundTo(num(so.maxGap, d.sonify.maxGap, 0, 2), 3),
  };
  p.timbre = {};
  for (const w of WAVE_TIMBRE_WAVES) p.timbre[w] = roundTo(num(s.timbre?.[w], d.timbre[w], 0, 1), 3);
  Object.assign(p.timbre, timbreSpecExtras(s.timbre)); // Mix | ƒ(x) (shared timbre synthesis) / 믹스 | ƒ(x)
  p.seed = Math.round(num(s.seed, d.seed, 0, 4294967295));
  p.tremolo = normalizeTremolo(s.tremolo); // studio output tremolo (sound only, never re-bakes) / 스튜디오 출력 트레몰로
  p.voiceMod = normalizeVoiceMod(s.voiceMod); // per-voice tremolo / vibrato (sound only) / 보이스별 변조
  const vw = s.view || {};
  p.view = {
    tMin: num(vw.tMin, d.view.tMin, -30, 300),
    tMax: num(vw.tMax, d.view.tMax, -29, 301),
    midiMin: num(vw.midiMin, d.view.midiMin, -12, 140),
    midiMax: num(vw.midiMax, d.view.midiMax, -11, 141),
    color: pick(vw.color, WAVE_COLORS, d.view.color),
    showRidges: vw.showRidges !== false,
    showGrid: vw.showGrid !== false,
  };
  if (p.view.tMax < p.view.tMin + 0.25) p.view.tMax = p.view.tMin + 0.25;
  if (p.view.midiMax < p.view.midiMin + 2) p.view.midiMax = p.view.midiMin + 2;
  return p;
}

/** The fields that decide the simulation (cache signature). Sound / view fields are excluded. */
export function wavePhysics(p) {
  return {
    eq: p.eq, Nx: p.Nx, pLo: p.pLo, pHi: p.pHi, length: p.length, bakeRate: p.bakeRate, simSpeed: p.simSpeed,
    speed: p.speed, cfl: p.cfl, c: p.c.customPoints.map((q) => [q.x, q.y]), cLo: p.cLo, cHi: p.cHi,
    damping: p.damping, dispersion: p.dispersion, mass: p.mass, boundary: p.boundary,
    init: p.init, drivers: p.drivers, gs: p.gs, seed: p.seed,
  };
}

export const waveSignature = (p) => JSON.stringify(wavePhysics(p));

// ==========================================================================
// 2. Medium and initial state / 매질과 초기 상태
// ==========================================================================

/** c(x) per grid point in st / model second. / 격자점별 파속 */
export function mediumProfile(p, N = p.Nx) {
  const c = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const y = clamp(evaluateCurveObjectY(p.c, N > 1 ? i / (N - 1) : 0, { raw: true }), 0, 1);
    c[i] = Math.max(0.05, p.speed * lerp(p.cLo, p.cHi, y));
  }
  return c;
}

function smoothNoise(N, sigmaBins, rng, out) {
  const raw = new Float64Array(N);
  for (let i = 0; i < N; i++) raw[i] = rng() * 2 - 1;
  const s = Math.max(0.5, sigmaBins);
  const K = Math.min(N, Math.ceil(3 * s));
  let peak = 1e-12;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    let wsum = 0;
    for (let j = -K; j <= K; j++) {
      const q = i + j;
      if (q < 0 || q >= N) continue;
      const w = Math.exp(-0.5 * (j / s) * (j / s));
      acc += w * raw[q];
      wsum += w;
    }
    out[i] = acc / wsum;
    if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]);
  }
  for (let i = 0; i < N; i++) out[i] /= peak;
}

/** Shape of one initial-condition item on the grid (amplitude included). / 초기 조건 한 항목 */
function initShape(it, p, N, dx, c, rng, f) {
  const L = (N - 1) * dx;
  const x0 = it.x * L;
  const w = Math.max(0.25, it.width);
  const A = it.amp;
  const i0 = clamp(Math.round(it.x * (N - 1)), 0, N - 1);
  if (it.kind === 'noise') {
    smoothNoise(N, w / dx, rng, f);
    for (let i = 0; i < N; i++) f[i] *= A;
    return 0;
  }
  let vel = clamp(it.velocity, -1, 1);
  let wk = w;
  if (it.kind === 'kink') {
    vel = clamp(it.velocity, -0.95, 0.95);
    if (p.eq === 'sg' && p.mass > 1e-6) wk = Math.max(dx, (c[i0] / p.mass) * Math.sqrt(1 - vel * vel));
  }
  for (let i = 0; i < N; i++) {
    const x = i * dx;
    const r = x - x0;
    let v = 0;
    switch (it.kind) {
      case 'tri': v = A * Math.max(0, 1 - Math.abs(r) / w); break;
      case 'box': {
        const e = Math.max(dx, 0.3);
        v = A * 0.5 * (Math.tanh((r + w) / e) - Math.tanh((r - w) / e));
        break;
      }
      case 'standing': {
        const xi = N > 1 ? i / (N - 1) : 0;
        if (p.boundary === 'free') v = A * Math.cos(it.mode * Math.PI * xi);
        else if (p.boundary === 'periodic') v = A * Math.sin((2 * Math.PI * it.mode * i) / N);
        else v = A * Math.sin(it.mode * Math.PI * xi);
        break;
      }
      case 'kink': {
        const a = 4 * Math.atan(Math.exp(clamp(r / wk, -40, 40)));
        v = p.eq === 'sg' ? Math.sign(A || 1) * a : (A * a) / (2 * Math.PI);
        break;
      }
      default: v = A * Math.exp(-0.5 * (r / w) * (r / w));
    }
    f[i] = v;
  }
  return it.kind === 'standing' ? 0 : vel;
}

/**
 * Initial displacement u₀ and velocity v₀ (one-way launch: v₀ = −vel·c·∂f/∂x). For Gray–Scott:
 * the shapes seed the activator, v = ¼|f|, u = 1 − ½|f|.
 * 초기 변위·속도 (한 방향 발사: v₀ = −vel·c·f′). Gray–Scott은 활성자 씨앗으로 사용.
 */
export function buildInitialState(p, N, dx, c) {
  const rng = createSeededRandom(p.seed);
  const u0 = new Float64Array(N);
  const v0 = new Float64Array(N);
  const f = new Float64Array(N);
  const gs = p.eq === 'gs';
  if (gs) u0.fill(1);
  for (const it of p.init) {
    const vel = initShape(it, p, N, dx, c, rng, f);
    if (gs) {
      for (let i = 0; i < N; i++) {
        const a = Math.min(1, Math.abs(f[i]));
        v0[i] = Math.min(1, v0[i] + 0.25 * a);
        u0[i] = Math.max(0, u0[i] - 0.5 * a);
      }
      continue;
    }
    for (let i = 0; i < N; i++) {
      u0[i] += f[i];
      if (vel !== 0) {
        const l = i > 0 ? f[i - 1] : f[i];
        const r = i < N - 1 ? f[i + 1] : f[i];
        const span = (i > 0 ? 1 : 0) + (i < N - 1 ? 1 : 0);
        v0[i] -= (vel * c[i] * (r - l)) / Math.max(1, span) / dx;
      }
    }
  }
  return { u0, v0 };
}

function driverEnv(t, d) {
  const s = t - d.t0;
  if (s < 0) return 0;
  let e = s < d.ramp ? 0.5 - 0.5 * Math.cos((Math.PI * s) / d.ramp) : 1;
  if (d.dur > 0) {
    const r = d.t0 + d.dur - t;
    if (r <= 0) return 0;
    if (r < d.ramp) e *= 0.5 - 0.5 * Math.cos((Math.PI * r) / d.ramp);
  }
  return e;
}

/** Drivers in grid form: bin weights, angular frequency, model-time window. / 구동 지점 전처리 */
function prepareDrivers(drivers, N) {
  return (drivers || []).map((d) => {
    const pos = clamp(d.x, 0, 1) * (N - 1);
    const i0 = Math.min(N - 2, Math.floor(pos));
    const dur = Math.max(0, d.dur || 0);
    return { i0, w1: pos - i0, w0: 1 - (pos - i0), omega: 2 * Math.PI * d.hz, amp: d.amp, t0: d.t0 || 0, dur, ramp: dur > 0 ? Math.min(0.1, dur / 4) : 0.1 };
  });
}

// ==========================================================================
// 3. Solvers / 풀이기
// ==========================================================================

/**
 * Leapfrog solver for wave / kg / sg. Arrays are padded with 2 ghost cells per side
 * (index = bin + sim.G). `u` is the level at time t, `up` the level at t − dt.
 * wave/kg/sg용 leapfrog 풀이기 (양쪽 고스트 2칸). u = 시각 t, up = t − dt.
 * @param {{ eq?: string, N: number, dx: number, c: Float64Array, boundary?: string, cfl?: number,
 *   damping?: number, dispersion?: number, mass?: number, u0: Float64Array, v0?: Float64Array,
 *   drivers?: Array<{x:number,hz:number,amp:number,t0:number,dur:number}> }} cfg  (times in model seconds)
 */
export function createWaveSim(cfg) {
  const N = cfg.N;
  const dx = cfg.dx;
  const eq = cfg.eq || 'wave';
  const boundary = cfg.boundary || 'fixed';
  const periodic = boundary === 'periodic';
  const c = cfg.c;
  const cc = new Float64Array(N);
  let cmax = 1e-9;
  for (let i = 0; i < N; i++) {
    cc[i] = c[i] * c[i];
    if (c[i] > cmax) cmax = c[i];
  }
  const disp = eq === 'wave' ? Math.max(0, cfg.dispersion || 0) : 0;
  const m2 = eq === 'kg' || eq === 'sg' ? (cfg.mass || 0) * (cfg.mass || 0) : 0;
  const sg = eq === 'sg';
  const gamma = Math.max(0, cfg.damping || 0);
  const idx2 = 1 / (dx * dx);
  const idx4 = idx2 * idx2;

  // Stability: Δt ≤ 2/ω_max, ω_max² = 4c²/dx²·(1 + 4D/dx²) + m². With D = m = 0 this is CFL ≤ 1.
  // 안정 조건: Δt ≤ 2/ω_max. D = m = 0이면 CFL ≤ 1.
  const wmax2 = 4 * cmax * cmax * idx2 * (1 + 4 * disp * idx2) + m2;
  const dtLimit = (2 / Math.sqrt(wmax2)) * (disp > 0 || m2 > 0 ? 0.98 : 1);
  const cflReq = Number.isFinite(cfg.cfl) ? cfg.cfl : 0.9;
  const dtReq = (Math.max(0.02, cflReq) * dx) / cmax;
  const dt = Math.min(dtReq, dtLimit, (1 * dx) / cmax);
  const clamped = dtReq > dt * (1 + 1e-9);
  const dt2 = dt * dt;
  const g = (gamma * dt) / 2;
  const ig = 1 / (1 + g);
  const gm = 1 - g;

  let u = new Float64Array(N + 2 * G);
  let up = new Float64Array(N + 2 * G);
  let un = new Float64Array(N + 2 * G);
  const drv = prepareDrivers(cfg.drivers, N);
  const b0 = cfg.u0[0];
  const b1 = cfg.u0[N - 1];
  const kL = (c[0] * dt - dx) / (c[0] * dt + dx);
  const kR = (c[N - 1] * dt - dx) / (c[N - 1] * dt + dx);

  function ghosts(a) {
    const e = N + G - 1; // last real index
    if (boundary === 'free') {
      a[1] = a[3]; a[0] = a[4]; a[e + 1] = a[e - 1]; a[e + 2] = a[e - 2];
    } else if (periodic) {
      a[1] = a[e]; a[0] = a[e - 1]; a[e + 1] = a[G]; a[e + 2] = a[G + 1];
    } else if (boundary === 'absorbing') {
      a[1] = 2 * a[2] - a[3]; a[0] = 2 * a[1] - a[2]; a[e + 1] = 2 * a[e] - a[e - 1]; a[e + 2] = 2 * a[e + 1] - a[e];
    } else {
      a[1] = 2 * a[2] - a[3]; a[0] = 2 * a[2] - a[4]; a[e + 1] = 2 * a[e] - a[e - 1]; a[e + 2] = 2 * a[e] - a[e - 2];
    }
  }

  /** Right-hand side F(u) at bin i (ghosts must be current). / 우변 F(u) */
  function force(a, i) {
    const k = i + G;
    let F = cc[i] * (a[k - 1] - 2 * a[k] + a[k + 1]) * idx2;
    if (disp > 0) F -= cc[i] * disp * (a[k - 2] - 4 * a[k - 1] + 6 * a[k] - 4 * a[k + 1] + a[k + 2]) * idx4;
    if (m2 > 0) F -= m2 * (sg ? Math.sin(a[k]) : a[k]);
    return F;
  }

  // Level 0 and the Taylor back-step u(−dt) = u₀ − dt·v₀ + ½dt²·(F(u₀) − γv₀). / 첫 스텝
  for (let i = 0; i < N; i++) u[i + G] = cfg.u0[i];
  ghosts(u);
  for (let i = 0; i < N; i++) {
    const v = cfg.v0 ? cfg.v0[i] : 0;
    up[i + G] = u[i + G] - dt * v + 0.5 * dt2 * (force(u, i) - gamma * v);
  }
  const hold = boundary === 'fixed';
  if (hold) { up[G] = b0; up[N + G - 1] = b1; }

  const sim = {
    N, dx, dt, G, clamped,
    /** Courant number c_max·Δt/dx actually used. / 실제 쿠랑 수 */
    cfl: (cmax * dt) / dx,
    t: 0,
    steps: 0,
    get u() { return u; },
    get up() { return up; },
    step() {
      ghosts(u);
      const lo = hold || boundary === 'absorbing' ? 1 : 0;
      const hi = hold || boundary === 'absorbing' ? N - 2 : N - 1;
      for (let i = lo; i <= hi; i++) {
        const k = i + G;
        un[k] = (2 * u[k] - gm * up[k] + dt2 * force(u, i)) * ig;
      }
      for (let j = 0; j < drv.length; j++) {
        const d = drv[j];
        const e = driverEnv(sim.t, d);
        if (e === 0) continue;
        // point source s(t)·δ(x − x₀): radiates amplitude S/(2cω) → S = amp·2cω / 점 파원
        const S = (d.amp * 2 * c[d.i0] * d.omega * e * Math.cos(d.omega * (sim.t - d.t0)) * dt2 * ig) / dx;
        if (d.i0 >= lo && d.i0 <= hi) un[d.i0 + G] += S * d.w0;
        if (d.i0 + 1 >= lo && d.i0 + 1 <= hi) un[d.i0 + 1 + G] += S * d.w1;
      }
      if (hold) {
        un[G] = b0;
        un[N + G - 1] = b1;
      } else if (boundary === 'absorbing') {
        // Mur 1st-order absorbing boundary / Mur 1차 흡수 경계
        un[G] = u[G + 1] + kL * (un[G + 1] - u[G]);
        un[N + G - 1] = u[N + G - 2] + kR * (un[N + G - 2] - u[N + G - 1]);
      }
      const tmp = up;
      up = u;
      u = un;
      un = tmp;
      sim.t += dt;
      sim.steps++;
    },
    /**
     * Discrete energy of the staggered pair (up, u) in the weighted norm Σ u_t²/c² + u_x²
     * (exactly conserved by the scheme for the linear, undamped, undriven problem).
     * 엇갈린 쌍 (up, u)의 이산 에너지 — 선형·무감쇠·무구동 문제에서 스킴이 정확히 보존.
     */
    energy() {
      ghosts(u);
      ghosts(up);
      let e = 0;
      for (let i = 0; i < N; i++) {
        const k = i + G;
        const wk = periodic || (i > 0 && i < N - 1) ? 1 : 0.5;
        const v = (u[k] - up[k]) / dt;
        e += (0.5 * wk * v * v) / cc[i];
        if (m2 > 0) e += sg ? (wk * m2 * (1 - Math.cos(0.5 * (u[k] + up[k])))) / cc[i] : (0.5 * wk * m2 * u[k] * up[k]) / cc[i];
        if (disp > 0) e += 0.5 * wk * disp * (u[k - 1] - 2 * u[k] + u[k + 1]) * (up[k - 1] - 2 * up[k] + up[k + 1]) * idx4;
        if (i < N - 1 || periodic) e += 0.5 * (u[k + 1] - u[k]) * (up[k + 1] - up[k]) * idx2;
      }
      return e * dx;
    },
  };
  return sim;
}

/**
 * Gray–Scott explicit-Euler solver (time in t.u.). `dtReq` is the frame step; it is split into
 * sub-steps so that D_max·Δt/dx² ≤ 0.45 and Δt ≤ 1. Fixed / absorbing = Dirichlet (u = 1, v = 0),
 * free = no flux, periodic = wrap. / Gray–Scott 양해 오일러 풀이기 (안정 조건 자동 클램프).
 */
export function createGsSim(cfg) {
  const { N, dx, Du, Dv, F, k } = cfg;
  const boundary = cfg.boundary || 'free';
  const Dmax = Math.max(Du, Dv, 1e-9);
  const dtReq = Math.max(1e-6, cfg.dtReq || 1);
  const dtLimit = Math.min(1, (0.45 * dx * dx) / Dmax);
  const sub = Math.max(1, Math.ceil(dtReq / dtLimit - 1e-9));
  const dt = dtReq / sub;
  let u = Float64Array.from(cfg.u0);
  let v = Float64Array.from(cfg.v0);
  let un = new Float64Array(N);
  let vn = new Float64Array(N);
  const drv = prepareDrivers(cfg.drivers, N);
  const idx2 = 1 / (dx * dx);
  const dirichlet = boundary === 'fixed' || boundary === 'absorbing';
  const periodic = boundary === 'periodic';
  const sim = {
    N, dx, dt, sub,
    /** Diffusion number D_max·Δt/dx². / 확산 수 */
    cfl: (Dmax * dt) / (dx * dx),
    clamped: sub > 1,
    t: 0,
    steps: 0,
    get u() { return u; },
    get v() { return v; },
    step() {
      for (let i = 0; i < N; i++) {
        const l = i > 0 ? i - 1 : periodic ? N - 1 : 1;
        const r = i < N - 1 ? i + 1 : periodic ? 0 : N - 2;
        const uvv = u[i] * v[i] * v[i];
        let a = u[i] + dt * (Du * (u[l] - 2 * u[i] + u[r]) * idx2 - uvv + F * (1 - u[i]));
        let b = v[i] + dt * (Dv * (v[l] - 2 * v[i] + v[r]) * idx2 + uvv - (F + k) * v[i]);
        if (!(a >= 0)) a = 0; else if (a > 1.1) a = 1.1;
        if (!(b >= 0)) b = 0; else if (b > 1.1) b = 1.1;
        un[i] = a;
        vn[i] = b;
      }
      for (let j = 0; j < drv.length; j++) {
        const d = drv[j];
        const e = driverEnv(sim.t, d);
        if (e === 0) continue;
        const s = dt * 0.05 * Math.abs(d.amp) * e * (0.5 + 0.5 * Math.cos(d.omega * (sim.t - d.t0)));
        vn[d.i0] = Math.min(1.1, vn[d.i0] + s * d.w0);
        vn[d.i0 + 1] = Math.min(1.1, vn[d.i0 + 1] + s * d.w1);
      }
      if (dirichlet) { un[0] = 1; un[N - 1] = 1; vn[0] = 0; vn[N - 1] = 0; }
      let tmp = u; u = un; un = tmp;
      tmp = v; v = vn; vn = tmp;
      sim.t += dt;
      sim.steps++;
    },
  };
  return sim;
}

// ==========================================================================
// 4. Edit-time bake + signature cache / 에디팅 시점 베이킹과 시그니처 캐시
// ==========================================================================

const bakeCache = new Map(); // signature → result (insertion order = LRU)
const BAKE_CACHE_SIZE = 4;
let bakeCount = 0;

/** Number of real simulations so far (cache hits do not count). / 실제 베이킹 횟수 */
export function getWaveBakeCount() {
  return bakeCount;
}

export function clearWaveBakeCache() {
  bakeCache.clear();
}

/**
 * Run fn with a scratch cache and counter, then restore both (self-checks must not evict the
 * document on screen or change the bake badge). / 자가진단용: 캐시·횟수를 임시로 바꿨다가 복원
 */
export function withIsolatedWaveCache(fn) {
  const saved = [...bakeCache.entries()];
  const count = bakeCount;
  bakeCache.clear();
  try {
    return fn();
  } finally {
    bakeCache.clear();
    for (const [k, v] of saved) bakeCache.set(k, v);
    bakeCount = count;
  }
}

/**
 * Simulate the document (or return the cached result for the same physics signature).
 * 문서를 시뮬레이션 (같은 물리 시그니처면 캐시 반환).
 * @returns {ReturnType<typeof simulateWave>}
 */
export function bakeWave(p) {
  const sig = waveSignature(p);
  const hit = bakeCache.get(sig);
  if (hit) {
    bakeCache.delete(sig);
    bakeCache.set(sig, hit);
    return hit;
  }
  const result = simulateWave(p, sig);
  bakeCount++;
  bakeCache.set(sig, result);
  while (bakeCache.size > BAKE_CACHE_SIZE) bakeCache.delete(bakeCache.keys().next().value);
  return result;
}

/**
 * Run the simulation without touching the cache or the bake counter (self-checks use this).
 * 캐시·베이킹 횟수를 건드리지 않고 시뮬레이션 실행 (자가진단용).
 * @returns {{ sig:string, eq:string, boundary:string, N:number, frames:number, rate:number, length:number,
 *   pLo:number, pHi:number, dp:number, U:Float32Array, W:Float32Array, uMax:number, wMax:number,
 *   c:Float64Array, cfl:number, dt:number, steps:number, clamped:boolean, rateClamped:boolean,
 *   energyErr:number|null, finite:boolean, ms:number }}
 */
export function simulateWave(p, sig = waveSignature(p)) {
  const t0 = now();
  const N = p.Nx;
  const dx = (p.pHi - p.pLo) / (N - 1);
  const maxFrames = Math.max(2, Math.floor(WAVE_MAX_CELLS / N));
  let frames = Math.round(p.length * p.bakeRate) + 1;
  let rate = p.bakeRate;
  const rateClamped = frames > maxFrames;
  if (rateClamped) {
    frames = maxFrames;
    rate = (frames - 1) / p.length;
  }
  const U = new Float32Array(frames * N);
  const W = new Float32Array(frames * N);
  const c = mediumProfile(p, N);
  const { u0, v0 } = buildInitialState(p, N, dx, c);
  const dtau = p.simSpeed / rate; // model seconds per frame / 프레임당 모델 시간
  const drivers = p.drivers.map((d) => ({ ...d, t0: d.t0 * p.simSpeed, dur: d.dur * p.simSpeed }));
  let uMax = 1e-12;
  let wMax = 1e-12;
  let energyErr = null;
  let finite = true;
  let sim;

  if (p.eq === 'gs') {
    const tu = GS_TU_PER_SEC;
    sim = createGsSim({
      N, dx, boundary: p.boundary, Du: p.gs.Du, Dv: p.gs.Dv, F: p.gs.F, k: p.gs.k, dtReq: dtau * tu, u0, v0,
      drivers: drivers.map((d) => ({ ...d, hz: d.hz / tu, t0: d.t0 * tu, dur: d.dur * tu })),
    });
    for (let f = 0; f < frames; f++) {
      if (f > 0) for (let s = 0; s < sim.sub; s++) sim.step();
      const row = f * N;
      const su = sim.u;
      const sv = sim.v;
      for (let i = 0; i < N; i++) {
        const val = sv[i];
        const w = su[i] * val * val;
        U[row + i] = val;
        W[row + i] = w;
        if (val > uMax) uMax = val;
        if (w > wMax) wMax = w;
      }
    }
  } else {
    sim = createWaveSim({ eq: p.eq, N, dx, c, boundary: p.boundary, cfl: p.cfl, damping: p.damping, dispersion: p.dispersion, mass: p.mass, u0, v0, drivers });
    const conservative = p.damping === 0 && !p.drivers.length && p.boundary !== 'absorbing';
    const e0 = conservative ? sim.energy() : 0;
    let lastSteps = -1;
    const m2 = p.eq === 'kg' || p.eq === 'sg' ? p.mass * p.mass : 0;
    const periodic = p.boundary === 'periodic';
    for (let f = 0; f < frames; f++) {
      const tau = f * dtau;
      while (sim.t < tau - 1e-12) sim.step();
      const u = sim.u;
      const up = sim.up;
      const a = clamp(1 - (sim.t - tau) / sim.dt, 0, 1);
      const row = f * N;
      for (let i = 0; i < N; i++) U[row + i] = up[i + G] + (u[i + G] - up[i + G]) * a;
      for (let i = 0; i < N; i++) {
        const val = U[row + i];
        const il = i > 0 ? i - 1 : periodic ? N - 1 : 0;
        const ir = i < N - 1 ? i + 1 : periodic ? 0 : N - 1;
        const span = i > 0 && i < N - 1 ? 2 : periodic ? 2 : 1;
        const ux = (U[row + ir] - U[row + il]) / (span * dx);
        const v = (u[i + G] - up[i + G]) / sim.dt;
        let w = 0.5 * (v * v + c[i] * c[i] * ux * ux);
        if (m2 > 0) w += p.eq === 'sg' ? m2 * (1 - Math.cos(val)) : 0.5 * m2 * val * val;
        W[row + i] = w;
        const av = val < 0 ? -val : val;
        if (av > uMax) uMax = av;
        if (w > wMax) wMax = w;
      }
      if (conservative && e0 > 0 && sim.steps !== lastSteps) {
        lastSteps = sim.steps;
        const err = Math.abs(sim.energy() - e0) / e0;
        if (energyErr === null || err > energyErr) energyErr = err;
      }
    }
  }
  if (!Number.isFinite(uMax) || !Number.isFinite(wMax)) {
    // Should never happen (stability clamps); keep the app alive. / 발생하면 안 됨 — 안전 처리
    finite = false;
    uMax = 1;
    wMax = 1;
    for (let j = 0; j < U.length; j++) {
      if (!Number.isFinite(U[j])) U[j] = 0;
      if (!Number.isFinite(W[j])) W[j] = 0;
    }
  }
  return {
    sig, eq: p.eq, boundary: p.boundary, N, frames, rate, length: (frames - 1) / rate, pLo: p.pLo, pHi: p.pHi, dp: dx,
    U, W, uMax, wMax, c, cfl: sim.cfl, dt: sim.dt, steps: sim.steps, clamped: sim.clamped, rateClamped,
    energyErr, finite, ms: now() - t0,
  };
}

/**
 * Length of the baked timeline in seconds without simulating (same rule as simulateWave).
 * 시뮬레이션 없이 베이킹 타임라인 길이 계산 (simulateWave와 같은 규칙).
 */
export function waveTimelineEnd(p) {
  const maxFrames = Math.max(2, Math.floor(WAVE_MAX_CELLS / p.Nx));
  const frames = Math.round(p.length * p.bakeRate) + 1;
  return frames > maxFrames ? p.length : (frames - 1) / p.bakeRate;
}

const detachedCache = new Map(); // signature → result, for documents that are not on screen
const DETACHED_CACHE_SIZE = 6;

/**
 * Bake for a document that is NOT the one in the editor (Manager instances): reuses the editor
 * cache when it already holds the signature, otherwise simulates into a separate small cache and
 * never touches the editor's bake counter. / 에디터에 없는 문서(매니저 인스턴스)용 베이킹 —
 * 에디터 캐시에 있으면 재사용, 없으면 별도 캐시에 시뮬레이션하며 베이킹 횟수는 건드리지 않음.
 */
export function bakeWaveDetached(p) {
  const sig = waveSignature(p);
  const hit = bakeCache.get(sig) || detachedCache.get(sig);
  if (hit) {
    if (detachedCache.has(sig)) {
      detachedCache.delete(sig);
      detachedCache.set(sig, hit);
    }
    return hit;
  }
  const result = simulateWave(p, sig);
  detachedCache.set(sig, result);
  while (detachedCache.size > DETACHED_CACHE_SIZE) detachedCache.delete(detachedCache.keys().next().value);
  return result;
}

/**
 * The same baked field read at another speed: rate × faster, length / rate, identical pitches
 * (the matrix is shared, only the frame rate changes). This is the Tempo Manager's
 * pitch-preserving time scaling for Wave — no re-simulation.
 * 같은 베이킹 장을 다른 속도로 읽음: 행렬은 공유, 프레임 레이트만 변경 (음고 유지 템포, 재시뮬레이션 없음).
 */
export function retimeWaveBake(bake, rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (Math.abs(r - 1) < 1e-9) return bake;
  return { ...bake, rate: bake.rate * r, length: bake.length / r, sig: `${bake.sig}@x${Math.round(r * 1e6) / 1e6}` };
}

/** Frame index for a piece time. / 곡 시각의 프레임 인덱스 */
export function waveFrameAt(bake, sec) {
  return clamp(Math.round(sec * bake.rate), 0, bake.frames - 1);
}

/** Normalised sonification source in [0, 1]: |u|/max or √(W/max). / 정규화된 음향화 원천 */
export function sourceValue(bake, source, j) {
  if (source === 'energy') return Math.sqrt(bake.W[j] / bake.wMax);
  const v = bake.U[j] / bake.uMax;
  return v < 0 ? -v : v;
}

// ==========================================================================
// 5. Spectral amplitude matrix / 스펙트럴 진폭 행렬
// ==========================================================================

const ampCache = new WeakMap(); // bake → { key, result }

/**
 * Amplitude matrix for the additive bank: a = clamp(gain·s^ampPower, 0, 1), 0 below `floor`.
 * `scale` = WAVE_MASTER / √max(1, max_t Σ_i ā²) (ā at gain 1) keeps the level independent of
 * how many bins sound. Cached per bake + sound parameters (never re-bakes).
 * 가산 뱅크용 진폭 행렬. scale은 발음 빈 수와 무관하게 레벨을 유지. 물리 재베이킹 없음.
 */
export function buildAmplitude(bake, sonify) {
  const key = `${sonify.source}|${sonify.ampPower}|${sonify.gain}|${sonify.floor}`;
  const hit = ampCache.get(bake);
  if (hit && hit.key === key) return hit.result;
  const { N, frames } = bake;
  const A = new Float32Array(frames * N);
  const pow = sonify.ampPower;
  const gain = sonify.gain;
  const floor = sonify.floor;
  let maxSumSq = 0;
  for (let f = 0; f < frames; f++) {
    const row = f * N;
    let ss = 0;
    for (let i = 0; i < N; i++) {
      let s = sourceValue(bake, sonify.source, row + i);
      if (pow !== 1) s = Math.pow(s, pow);
      if (s < floor) continue;
      ss += s * s;
      const a = gain * s;
      A[row + i] = a > 1 ? 1 : a;
    }
    if (ss > maxSumSq) maxSumSq = ss;
  }
  const result = { key, A, bins: N, frames, rate: bake.rate, scale: WAVE_MASTER / Math.sqrt(Math.max(1, maxSumSq)) };
  ampCache.set(bake, { key, result });
  return result;
}

// ==========================================================================
// 6. Ridge tracking / 리지(극대점) 추적
// ==========================================================================

const ridgeCache = new WeakMap(); // bake → { key, result }

function median(arr) {
  if (!arr.length) return 0;
  const s = Array.from(arr).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/**
 * Follow the local maxima of the sonification source through time.
 *   peaks      s[i] > s[i−1], s[i] ≥ s[i+1], s[i] ≥ peakThresh; position refined by a parabola
 *   matching   greedy nearest pairs between predicted track positions and peaks, |Δ| ≤ maxJump
 *              semitones. Prediction: last + velocity; while coasting: position one history
 *              window (0.3 s) earlier + median velocity·elapsed, mirrored at non-periodic walls
 *   gaps       an unmatched track coasts for up to maxGap seconds (frames spent hidden behind a
 *              peak that another track owns are not counted, up to 0.75 s); when it finds a peak
 *              again the hole is filled linearly, otherwise the track ends at its last real point
 *   crossing   POLICY: two ridges that merge and separate again within maxGap keep their count
 *              (2 before → 2 after; identities follow the predicted motion). A longer overlap ends
 *              the coasting track and a fresh one starts after the crossing.
 *   selection  tracks shorter than 60 ms are dropped; the maxTracks strongest (Σ amplitude) remain.
 * 리지 추적: 예측 위치 기반 최근접 매칭, maxGap 이내의 공백은 선형 보간, 교차 후에도 트랙 수 유지(정책).
 * @returns {{ key:string, tracks: Array<{ f0:number, pitch:Float32Array, amp:Float32Array, score:number }>, scale:number, found:number }}
 */
export function extractRidges(bake, sonify) {
  const key = `${sonify.source}|${sonify.ampPower}|${sonify.peakThresh}|${sonify.maxTracks}|${sonify.maxJump}|${sonify.maxGap}`;
  const hit = ridgeCache.get(bake);
  if (hit && hit.key === key) return hit.result;
  const { N, frames, rate, dp } = bake;
  const src = sonify.source;
  const thr = clamp(sonify.peakThresh, 0.005, 0.95);
  const jump = Math.max(0.05, sonify.maxJump) / dp; // bins per frame
  const gapFrames = Math.max(0, Math.round(sonify.maxGap * rate));
  const periodic = bake.boundary === 'periodic';
  const pow = sonify.ampPower;
  const MAX_ACTIVE = 32;
  const histLen = Math.max(4, Math.round(0.3 * rate));
  const hiddenCap = Math.round(0.75 * rate);
  const active = [];
  const done = [];
  const peaks = [];
  const pairs = [];
  const val = (row, i) => sourceValue(bake, src, row + i);

  for (let f = 0; f < frames; f++) {
    const row = f * N;
    peaks.length = 0;
    for (let i = 0; i < N; i++) {
      const s = val(row, i);
      if (s < thr) continue;
      const l = i > 0 ? val(row, i - 1) : periodic ? val(row, N - 1) : -1;
      const r = i < N - 1 ? val(row, i + 1) : periodic ? val(row, 0) : -1;
      if (!(s > l && s >= r)) continue;
      let pos = i;
      let h = s;
      if (l >= 0 && r >= 0) {
        const den = l - 2 * s + r;
        if (den < 0) {
          const d = clamp((0.5 * (l - r)) / den, -0.5, 0.5);
          pos = i + d;
          h = s - 0.25 * (l - r) * d;
        }
      }
      peaks.push({ pos, h, used: false });
    }
    if (peaks.length > MAX_ACTIVE) {
      peaks.sort((a, b) => b.h - a.h);
      peaks.length = MAX_ACTIVE;
    }
    pairs.length = 0;
    for (let ti = 0; ti < active.length; ti++) {
      const tr = active[ti];
      const k = f - tr.lastF;
      // Coasting starts: freeze a robust velocity (median of the recent per-frame steps), so the
      // short acceleration of a peak just before two ridges merge does not throw the prediction off.
      // 공백 시작 시 최근 속도의 중앙값으로 고정 (병합 직전의 순간 가속에 흔들리지 않게).
      // The extrapolation starts from the position one history window earlier: just before a merge
      // the visible peak leaves the true pulse centre, so the last point itself is a poor anchor.
      // 외삽은 히스토리 한 구간 전의 위치에서 시작 (병합 직전의 피크는 실제 펄스 중심에서 벗어남).
      if (k === 2) {
        tr.coast = median(tr.hist);
        tr.back = Math.min(tr.hist.length, tr.pos.length - 1);
        tr.anchor = tr.pos[tr.pos.length - 1 - tr.back];
      }
      let pred = k > 1 ? tr.anchor + tr.coast * (k + tr.back) : tr.lastPos + tr.vel;
      tr.flip = false;
      if (!periodic) {
        if (pred < 0) { pred = -pred; tr.flip = true; }
        else if (pred > N - 1) { pred = 2 * (N - 1) - pred; tr.flip = true; }
        pred = clamp(pred, 0, N - 1);
      }
      tr.matched = false;
      tr.pred = pred;
      for (let pi = 0; pi < peaks.length; pi++) {
        const d = Math.abs(peaks[pi].pos - pred);
        if (d <= jump) pairs.push({ d, ti, pi });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (let q = 0; q < pairs.length; q++) {
      const tr = active[pairs[q].ti];
      const pk = peaks[pairs[q].pi];
      if (tr.matched || pk.used) continue;
      tr.matched = true;
      pk.used = true;
      const k = f - tr.lastF;
      const lastAmp = tr.amp[tr.amp.length - 1];
      for (let j = 1; j < k; j++) {
        const a = j / k;
        tr.pos.push(tr.lastPos + (pk.pos - tr.lastPos) * a);
        tr.amp.push(lastAmp + (pk.h - lastAmp) * a);
      }
      tr.pos.push(pk.pos);
      tr.amp.push(pk.h);
      if (k > 1) {
        // back from a gap: keep the coasting velocity (mirrored if the prediction hit a wall)
        tr.vel = tr.flip ? -tr.coast : tr.coast;
        tr.hist.length = 0;
        tr.hist.push(tr.vel);
      } else {
        const nv = pk.pos - tr.lastPos;
        tr.vel = tr.hist.length ? 0.6 * tr.vel + 0.4 * nv : nv;
        tr.hist.push(nv);
        if (tr.hist.length > histLen) tr.hist.shift();
      }
      tr.lastPos = pk.pos;
      tr.lastF = f;
      tr.hidden = 0;
    }
    for (let ti = active.length - 1; ti >= 0; ti--) {
      const tr = active[ti];
      if (tr.matched) continue;
      // A coasting track whose prediction sits on a peak owned by another track is hidden behind
      // that ridge (two ridges merged): those frames do not use up the gap allowance.
      // 다른 트랙이 차지한 피크 위에 예측 위치가 있으면(두 리지가 합쳐짐) 공백 허용치를 쓰지 않음.
      for (let pi = 0; pi < peaks.length; pi++) {
        if (peaks[pi].used && Math.abs(peaks[pi].pos - tr.pred) <= jump) { tr.hidden++; break; }
      }
      if (f - tr.lastF - Math.min(tr.hidden, hiddenCap) > gapFrames) {
        done.push(tr);
        active.splice(ti, 1);
      }
    }
    for (let pi = 0; pi < peaks.length && active.length < MAX_ACTIVE; pi++) {
      const pk = peaks[pi];
      if (pk.used) continue;
      active.push({ f0: f, pos: [pk.pos], amp: [pk.h], lastPos: pk.pos, lastF: f, vel: 0, coast: 0, back: 0, anchor: pk.pos, hist: [], hidden: 0, pred: pk.pos, matched: true, flip: false });
    }
  }
  done.push(...active);

  const minFrames = Math.max(3, Math.round(0.06 * rate));
  let tracks = [];
  for (const tr of done) {
    if (tr.pos.length < minFrames) continue;
    const n = tr.pos.length;
    const pitch = new Float32Array(n);
    const amp = new Float32Array(n);
    let score = 0;
    for (let j = 0; j < n; j++) {
      pitch[j] = bake.pLo + tr.pos[j] * dp;
      const a = clamp(pow !== 1 ? Math.pow(Math.max(0, tr.amp[j]), pow) : tr.amp[j], 0, 1);
      amp[j] = a;
      score += a;
    }
    tracks.push({ f0: tr.f0, pitch, amp, score });
  }
  const found = tracks.length;
  tracks.sort((a, b) => b.score - a.score);
  tracks = tracks.slice(0, clamp(Math.round(sonify.maxTracks), 1, WAVE_MAX_TRACKS));
  tracks.sort((a, b) => a.f0 - b.f0 || a.pitch[0] - b.pitch[0]);

  // Level normalisation: loudest simultaneous Σ amp² / 동시 발음 Σ amp² 최댓값으로 정규화
  const sumSq = new Float32Array(frames);
  for (const tr of tracks) for (let j = 0; j < tr.amp.length; j++) sumSq[tr.f0 + j] += tr.amp[j] * tr.amp[j];
  let maxSumSq = 0;
  for (let f = 0; f < frames; f++) if (sumSq[f] > maxSumSq) maxSumSq = sumSq[f];
  const result = { key, tracks, found, scale: WAVE_MASTER / Math.sqrt(Math.max(1, maxSumSq)) };
  ridgeCache.set(bake, { key, result });
  return result;
}

/** Linear lookup of a track at a piece time (null outside the track). / 트랙 시각 조회 */
export function sampleTrack(tr, bake, sec) {
  const pos = sec * bake.rate - tr.f0;
  const n = tr.pitch.length;
  if (pos < 0 || pos > n - 1) return null;
  const i = Math.min(n - 2, Math.floor(pos));
  const a = pos - i;
  return { pitch: tr.pitch[i] + (tr.pitch[i + 1] - tr.pitch[i]) * a, amp: tr.amp[i] + (tr.amp[i + 1] - tr.amp[i]) * a };
}
