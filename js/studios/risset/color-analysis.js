/**
 * Flexatone — studios/risset/color-analysis.js
 * Risset Studio (pure): harmonic-colour analysis of the sounding partials and the optional
 * colour-invariance PI controller.
 * 리세 스튜디오 (순수): 발음 중인 부분음의 화성 색채 분석과 색채 불변성 PI 제어기.
 *
 * Partials: { f (Hz), a (linear amplitude) }.
 *   R_total  Sethares (1993) form of Plomp–Levelt roughness, summed over all pairs
 *            d(Δf) = min(aᵢ, aⱼ)·(e^(−b₁·s·Δf) − e^(−b₂·s·Δf)),  s = x* ÷ (s₁·f_min + s₂)
 *            x* = 0.24, s₁ = 0.0207, s₂ = 18.96, b₁ = 3.51, b₂ = 5.75
 *            (maximum near Δf ≈ 0.25 critical band — about a minor 2nd around 440 Hz)
 *   H(t)     weighted harmonic density: Σ aᵢ·aⱼ over pairs closer than one critical band
 *            CB(f) = 25 + 75·(1 + 1.4·(f/1000)²)^0.69   (Zwicker & Terhardt)
 *   C_spec   amplitude-weighted mean log₂ frequency → reported in Hz (2^C)
 * Controller (colour invariance): PI on e = log₂(target/C) (C_spec) or (target − R)/target (R_total),
 *   u = base + dir·(range/16)·(Kp·e + Ki∫e), followed by a 0.25 s first-order lag (loop stability);
 * the output replaces the actuator's *base* value, then the looping automation adds its ± deviation.
 * 제어기 출력은 기준값을 바꾸고, 그 위에 오토메이션이 ± 편차를 더함.
 * No DOM, no Web Audio. Imports core/* only.
 */

import { clamp } from '../../core/math-utils.js';

export const PL = Object.freeze({ xStar: 0.24, s1: 0.0207, s2: 18.96, b1: 3.51, b2: 5.75 });
export const COLOR_TARGETS = Object.freeze(['cspec', 'rtotal']);
export const COLOR_ACTUATORS = Object.freeze(['envSkew', 'localThreshold', 'spectralTilt']);
/** Actuator ranges and the sign that raises the measured quantity. / 조절 대상 범위·방향 */
export const ACTUATOR_SPECS = Object.freeze({
  envSkew: { min: -0.9, max: 0.9, dir: { cspec: 1, rtotal: 1 } },
  localThreshold: { min: -1, max: 0.95, dir: { cspec: -1, rtotal: -1 } },
  spectralTilt: { min: -12, max: 12, dir: { cspec: 1, rtotal: -1 } },
});
export const COLOR_HISTORY = 600;

/** Plomp–Levelt (Sethares) roughness of one pair. / 한 쌍의 거칠기 */
export function pairRoughness(f1, a1, f2, a2) {
  const lo = Math.min(f1, f2);
  const df = Math.abs(f2 - f1);
  const s = PL.xStar / (PL.s1 * lo + PL.s2);
  return Math.min(a1, a2) * (Math.exp(-PL.b1 * s * df) - Math.exp(-PL.b2 * s * df));
}

/** Critical bandwidth (Hz). / 임계 대역폭 */
export const criticalBandwidth = (f) => 25 + 75 * Math.pow(1 + 1.4 * (f / 1000) ** 2, 0.69);

/**
 * Analyse a partial list. `fs`, `as` = typed arrays (length ≥ n).
 * @returns {{ R: number, H: number, C: number, Chz: number, total: number }}
 * 부분음 목록 분석.
 */
export function analyzeColor(fs, as, n) {
  let R = 0;
  let H = 0;
  let wSum = 0;
  let lSum = 0;
  for (let i = 0; i < n; i++) {
    const ai = as[i];
    if (!(ai > 1e-6)) continue;
    const fi = fs[i];
    wSum += ai;
    lSum += ai * Math.log2(Math.max(1e-3, fi));
    for (let j = i + 1; j < n; j++) {
      const aj = as[j];
      if (!(aj > 1e-6)) continue;
      const fj = fs[j];
      const df = Math.abs(fj - fi);
      const lo = Math.min(fi, fj);
      const s = PL.xStar / (PL.s1 * lo + PL.s2);
      if (df * s < 12) R += Math.min(ai, aj) * (Math.exp(-PL.b1 * s * df) - Math.exp(-PL.b2 * s * df));
      if (df < criticalBandwidth(0.5 * (fi + fj))) H += ai * aj;
    }
  }
  const C = wSum > 0 ? lSum / wSum : 0;
  return { R, H, C, Chz: wSum > 0 ? 2 ** C : 0, total: wSum };
}

/** Default controller settings (off). / 제어기 기본값 */
export function createDefaultColorCtl() {
  return { enabled: false, target: 'cspec', setpointHz: 440, setpointR: 0.05, actuator: 'envSkew', kp: 0.6, ki: 0.25 };
}

export function sanitizeColorCtl(raw) {
  const d = createDefaultColorCtl();
  const c = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  c.enabled = !!c.enabled;
  if (!COLOR_TARGETS.includes(c.target)) c.target = d.target;
  if (!COLOR_ACTUATORS.includes(c.actuator)) c.actuator = d.actuator;
  c.setpointHz = clamp(Number(c.setpointHz) || d.setpointHz, 20, 12000);
  c.setpointR = clamp(Number(c.setpointR) || d.setpointR, 0.001, 5);
  c.kp = clamp(Number.isFinite(Number(c.kp)) ? Number(c.kp) : d.kp, 0, 5);
  c.ki = clamp(Number.isFinite(Number(c.ki)) ? Number(c.ki) : d.ki, 0, 5);
  return c;
}

/** Controller runtime state. / 제어기 런타임 */
export function createColorState() {
  return {
    integ: 0,
    out: null, // { key, value } — base override for the actuator / 기준값 덮어쓰기
    last: { R: 0, H: 0, C: 0, Chz: 0, total: 0 },
    hist: { R: new Float32Array(COLOR_HISTORY), H: new Float32Array(COLOR_HISTORY), C: new Float32Array(COLOR_HISTORY), head: 0, count: 0, acc: 0 },
  };
}

/** Normalised control error (positive ⇒ the measured value must rise). / 정규화 오차 */
export function colorError(ctl, m) {
  if (ctl.target === 'rtotal') return clamp((ctl.setpointR - m.R) / Math.max(1e-3, ctl.setpointR), -2, 2);
  if (!(m.Chz > 0)) return 0;
  return clamp(Math.log2(ctl.setpointHz / m.Chz), -3, 3);
}

/**
 * One PI step. base = the document value of the actuator; returns the new base override.
 * Anti-windup: the integrator only accumulates while the output is not saturated.
 * PI 한 단계 (포화 시 적분 정지).
 */
export function stepColorController(ctl, st, base, m, dt) {
  if (!ctl.enabled) { st.integ = 0; st.out = null; return null; }
  const spec = ACTUATOR_SPECS[ctl.actuator];
  const span = spec.max - spec.min;
  const dir = spec.dir[ctl.target] || 1;
  const e = colorError(ctl, m);
  const trial = st.integ + e * dt;
  const raw = base + dir * (span / 16) * (ctl.kp * e + ctl.ki * trial);
  const cmd = clamp(raw, spec.min, spec.max);
  if (cmd === raw) st.integ = trial; // anti-windup / 포화 시 적분 정지
  // First-order lag (τ = 0.25 s) on the actuator keeps the sampled loop stable. / 출력 지연으로 안정화
  const prev = st.out && st.out.key === ctl.actuator ? st.out.value : base;
  const value = prev + (cmd - prev) * (1 - Math.exp(-dt / 0.25));
  st.out = { key: ctl.actuator, value };
  return st.out;
}

/** Push one analysis sample into the history ring (decimated to ~30 Hz). / 이력 기록 */
export function pushColorHistory(st, m, dt) {
  const h = st.hist;
  h.acc += dt;
  st.last = m;
  if (h.acc < 1 / 30) return;
  h.acc = 0;
  h.R[h.head] = m.R;
  h.H[h.head] = m.H;
  h.C[h.head] = m.Chz;
  h.head = (h.head + 1) % COLOR_HISTORY;
  h.count = Math.min(COLOR_HISTORY, h.count + 1);
}
