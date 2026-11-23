/**
 * Flexatone — studios/risset/local-particles.js
 * Risset Studio (pure): Local Emergence A_local,i(t) — breathing fragments per voice.
 * 리세 스튜디오 (순수): 로컬 명멸 A_local,i(t) — 보이스별 호흡 입자.
 *
 * Modes / 모드
 *   bypass : A_local = 1 (default — only the Global Envelope is active)
 *   random : smooth value-noise at `rate` Hz; gate = noise > threshold; each gate change starts an
 *            S-curve fade of length fadeMean ± fadeDev (ms).  A = ½ − ½ cos(π·ramp)
 *   sine   : per-voice LFO (rate · random multiplier); A = clamp((s − floor)/(1 − floor), 0, 1)
 * Band masking: outside [bandMin, bandMax] (phase) — and, when set, outside [bandMinHz, bandMaxHz]
 * (frequency) — the voice is not modulated (A = 1). / 위상·주파수 대역 밖에서는 명멸 없음.
 * Particles 2.0 (A-4) — all defaults reproduce the previous behaviour exactly:
 *   S-curve curvature κ ∈ (−1, 1): S = cᵃ/(cᵃ + (1 − c)ᵃ), c = ½ − ½cos(π·ramp), a = 1/(1 − κ) (κ ≥ 0)
 *     or 1 + κ (κ < 0); κ = 0 ⇒ the cosine S-curve.
 *   Fade distribution: uniform mean ± dev (default) · normal N(mean, dev) · log-normal with the same
 *     mean and standard deviation (σ² = ln(1 + dev²/mean²), μ = ln mean − σ²/2).
 *   Mass & buoyancy: gravitational mass Mᵢ = A_global·A_local; inertial mass m₀ + Mᵢ (m₀ > 0, so
 *     a = F/(m₀ + M) never divides by zero); buoyancy Bᵢ = β·A_local·|∂A_global/∂p| (an upward lift,
 *     strongest on the envelope flanks) — inputs of the interaction dynamics (A-5).
 * Runtime only (never saved/undone). Pass a `rng` for deterministic tests.
 */

import { clamp } from '../../core/math-utils.js';

export const LOCAL_MODES = Object.freeze(['bypass', 'random', 'sine']);
export const FADE_DISTS = Object.freeze(['uniform', 'normal', 'lognormal']);
/** Smallest inertial base mass m₀ (keeps 1/(m₀ + M) finite). / 최소 기본 질량 */
export const MIN_M0 = 1e-3;

function gaussian(rng) {
  // Box–Muller (two draws) / 박스-뮬러
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Fade length (s) drawn from the selected distribution. / 페이드 길이 표본 */
export function fadeDur(local, rng) {
  const mean = local.fadeMeanMs;
  const dev = local.fadeDevMs;
  let ms;
  if (local.fadeDist === 'normal') ms = mean + dev * gaussian(rng);
  else if (local.fadeDist === 'lognormal') {
    const s2 = Math.log(1 + (dev * dev) / Math.max(1, mean * mean));
    ms = Math.exp(Math.log(Math.max(1, mean)) - s2 / 2 + Math.sqrt(s2) * gaussian(rng));
  } else ms = mean + (rng() * 2 - 1) * dev;
  return Math.max(0.12, ms / 1000);
}

/** Variable sigmoid S-curve; κ = 0 ⇒ ½ − ½cos(πx). / 가변 시그모이드 */
export function sCurve(x, kappa = 0) {
  const c = 0.5 - 0.5 * Math.cos(Math.PI * x);
  if (!kappa) return c;
  const k = Math.max(-0.95, Math.min(0.95, kappa));
  const a = k >= 0 ? 1 / (1 - k) : 1 + k;
  const ca = Math.pow(c, a);
  const cb = Math.pow(1 - c, a);
  return ca + cb > 0 ? ca / (ca + cb) : c;
}

/** Inertial mass m₀ + M (never below MIN_M0). / 관성 질량 */
export const inertialMass = (m0, M) => Math.max(MIN_M0, Number(m0) || 0) + Math.max(0, Number.isFinite(M) ? M : 0);

/** Create / resize the particle array (keeps existing particles). / 입자 배열 생성·크기 조정 */
export function initVoiceParticles(prev, N, local, rng = Math.random) {
  const next = [];
  for (let i = 0; i < N; i++) {
    const p = prev?.[i];
    next.push(p ? { ...p } : {
      noiseCur: rng() * 2 - 1,
      noiseTarget: rng() * 2 - 1,
      noisePhase: rng(),
      lfoPhase: (i / N + rng() * 0.25) % 1,
      lfoFreqMult: 0.75 + rng() * 0.55,
      gate: rng() > 0.35 ? 1 : 0,
      rampLinear: rng() > 0.35 ? 1 : 0,
      fadeDurSec: fadeDur(local, rng),
      aLocal: 1,
    });
  }
  return next;
}

/**
 * Advance every particle by dt seconds. `phases[i]` = current voice phase; `eff` holds the
 * (automated) localRateHz / localThreshold. Mutates and returns `particles`.
 * 모든 입자를 dt초 진행 (phases[i] = 현재 보이스 위상, eff = 오토메이션 반영값).
 */
export function stepLocalParticles(particles, local, eff, phases, dt, rng = Math.random, freqs = null) {
  const bMin = Math.min(local.bandMin, local.bandMax);
  const bMax = Math.max(local.bandMin, local.bandMax);
  const hzLo = Number(local.bandMinHz) || 0;
  const hzHi = Number(local.bandMaxHz) || 0;
  const hzMask = freqs && hzHi > hzLo && hzLo >= 0;
  const kappa = Number(local.fadeCurve) || 0;
  // The Risset document names the mode `localMode` (older callers passed `mode`). Reading only
  // `mode` made Bypass/Random unreachable (everything ran the Sine branch) — fixed in the A-1 upgrade.
  // 문서 필드는 localMode — 예전에는 mode만 읽어 바이패스/랜덤이 동작하지 않았음.
  const mode = local.localMode ?? local.mode;
  for (let i = 0; i < particles.length; i++) {
    const vp = particles[i];
    if (mode === 'bypass') { vp.aLocal = 1; continue; }
    const p = phases[i] ?? 0;
    const inBand = p >= bMin - 1e-5 && p <= bMax + 1e-5 && (!hzMask || (freqs[i] >= hzLo && freqs[i] <= hzHi));
    let aRaw = 1;
    if (mode === 'random') {
      vp.noisePhase += eff.localRateHz * dt;
      if (vp.noisePhase >= 1) {
        vp.noisePhase -= Math.floor(vp.noisePhase);
        vp.noiseCur = vp.noiseTarget;
        vp.noiseTarget = rng() * 2 - 1;
      }
      const mu = 0.5 - 0.5 * Math.cos(Math.PI * vp.noisePhase);
      const rVal = vp.noiseCur + (vp.noiseTarget - vp.noiseCur) * mu;
      const newGate = rVal > eff.localThreshold ? 1 : 0;
      if (newGate !== vp.gate) {
        vp.gate = newGate;
        vp.fadeDurSec = fadeDur(local, rng);
      }
      const stepAmt = dt / Math.max(0.05, vp.fadeDurSec);
      vp.rampLinear = vp.gate > 0.5 ? Math.min(1, vp.rampLinear + stepAmt) : Math.max(0, vp.rampLinear - stepAmt);
      aRaw = sCurve(vp.rampLinear, kappa);
    } else {
      vp.lfoPhase = (vp.lfoPhase + eff.localRateHz * vp.lfoFreqMult * dt) % 1;
      const sVal = 0.5 + 0.5 * Math.sin(2 * Math.PI * vp.lfoPhase);
      const floor = clamp((eff.localThreshold + 0.8) / 1.65, 0, 0.85);
      aRaw = clamp((sVal - floor) / Math.max(0.15, 1 - floor), 0, 1);
    }
    vp.aLocal = inBand ? aRaw : 1;
  }
  return particles;
}
