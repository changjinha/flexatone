/**
 * Flexatone — modules/sources/pulse-kernel.js
 * Layer 1 (modules, pure DSP): the Pulse voice source — sine → band-limited pulse (duty) morph.
 * 계층 1 (modules, 순수 DSP): 펄스 음원 — 사인 → 대역 제한 펄스(듀티) 모핑.
 *
 * One implementation for every host (ROADMAP D-2):
 *   - worklet / offline banks call `PulseKernel.sample(spec, ψ, dt)` per sample (Risset voice bank);
 *   - native-node studios get the same spectrum as PeriodicWave coefficients (`pulseCoefficients`).
 * 모든 호스트에 구현 하나: 워클릿·오프라인 뱅크는 샘플 단위 호출, 네이티브 스튜디오는 같은 스펙트럼의 PeriodicWave 계수.
 *
 *   spec = { morph,  0 = pure sine … 1 = pulse (×0.8)
 *            duty }  pulse width, clamped to [0.05, 0.95]
 *   y(ψ) = sin 2πψ + (0.8·pulse(ψ) − sin 2πψ)·m,   pulse = ±1 with its mean (2d − 1) removed
 *   Per sample, m fades to 0 as the harmonic headroom H = fs/(2f) = 1/(2·dt) drops from 20 to 4
 *   (the waveform morph *is* the anti-aliasing), and the edges are PolyBLEP-corrected.
 *   배음 여유가 20 → 4로 줄면 모핑이 사인으로 돌아감 (모핑 = 앨리어싱 억제), 모서리는 PolyBLEP 보정.
 *
 * The class is shipped into AudioWorklets with `toString()` (modules/sources/kernel-source.js), so it
 * MUST stay self-contained: no imports, no globals besides Math (a self-check asserts this).
 * 클래스는 toString()으로 워클릿에 들어가므로 자기완결이어야 함.
 *
 * Imports: core/state.js (self-check registry) only, outside the class.
 */

import { registerSelfCheck } from '../../core/state.js';

export class PulseKernel {
  /** Source contract: this source's phase ψ is one waveform cycle, so phase coupling applies. */
  static get phaseKind() {
    return 'cycle';
  }

  /** PolyBLEP residual at ψ for phase increment dt. / PolyBLEP 보정량 */
  static polyBlep(t, dt) {
    if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
    if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
    return 0;
  }

  /** Duty clamped to the playable range. / 재생 가능한 듀티 */
  static duty(spec) {
    return Math.min(0.95, Math.max(0.05, spec.duty));
  }

  /**
   * One sample at oscillator phase ψ ∈ [0, 1) with phase increment dt = f / fs.
   * 오실레이터 위상 ψ, 위상 증분 dt = f/fs에서의 샘플 하나.
   */
  static sample(spec, psi, dt) {
    const s = Math.sin(2 * Math.PI * psi);
    // Frequency-dependent morph: full pulse while ≥ 20 harmonics fit below Nyquist (H = 1/(2·dt)),
    // pure sine at ≤ 4 harmonics. / 나이퀴스트 아래 배음이 20개 이상이면 펄스, 4개 이하면 사인.
    const H = 0.5 / Math.max(1e-9, dt);
    const m = spec.morph * (H >= 20 ? 1 : H <= 4 ? 0 : (H - 4) / 16);
    if (!(m > 0)) return s;
    const d = PulseKernel.duty(spec);
    const ddt = Math.min(0.5, dt);
    // bipolar pulse with DC removed: +1 for ψ < d, −1 otherwise, minus mean (2d − 1)
    let pulse = psi < d ? 1 : -1;
    pulse += PulseKernel.polyBlep(psi, ddt);
    let q = psi - d;
    if (q < 0) q += 1;
    pulse -= PulseKernel.polyBlep(q, ddt);
    pulse -= 2 * d - 1;
    return s + (pulse * 0.8 - s) * m;
  }

  /**
   * Fourier coefficients of 0.8·pulse at harmonic k ≥ 1 (cos part a, sin part b) — the band-unlimited
   * spectrum the sample() morph tends to: a = (2/πk)·sin 2πkd, b = (2/πk)·(1 − cos 2πkd),
   * |c| = (4/πk)·|sin πkd|. / 0.8·펄스의 k차 푸리에 계수
   */
  static harmonic(spec, k) {
    const d = PulseKernel.duty(spec);
    const g = (0.8 * 2) / (Math.PI * k);
    return { a: g * Math.sin(2 * Math.PI * k * d), b: g * (1 - Math.cos(2 * Math.PI * k * d)) };
  }
}

/** Normalised pulse spec. / 정규화한 펄스 스펙 */
export function normalizePulseSpec(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const morph = Number(s.morph);
  const duty = Number(s.duty);
  return {
    morph: Number.isFinite(morph) ? Math.min(1, Math.max(0, morph)) : 1,
    duty: Number.isFinite(duty) ? Math.min(0.95, Math.max(0.05, duty)) : 0.5,
  };
}

/**
 * PeriodicWave coefficients of the pulse source (the shape `ctx.createPeriodicWave(real, imag)` takes):
 * the browser band-limits a PeriodicWave itself, so there is no per-frequency morph here.
 * 펄스 음원의 PeriodicWave 계수 (대역 제한은 브라우저가 처리).
 * @returns {{ real: Float32Array, imag: Float32Array }}
 */
export function pulseCoefficients(spec, harmonics = 32) {
  const s = normalizePulseSpec(spec);
  const n = Math.max(2, harmonics | 0) + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    const h = PulseKernel.harmonic(s, k);
    real[k] = s.morph * h.a;
    imag[k] = s.morph * h.b + (k === 1 ? 1 - s.morph : 0);
  }
  return { real, imag };
}

registerSelfCheck('Pulse kernel: self-contained, sine at morph 0, sample spectrum = PeriodicWave coefficients', (a) => {
  const src = PulseKernel.toString();
  a.ok(!/\bimport\b|\brequire\(|\bdocument\b|\bwindow\b|\bregisterSelfCheck\b/.test(src), 'no imports / DOM in the class');
  a.ok(new Function(`${src}; return PulseKernel.sample({ morph: 1, duty: 0.3 }, 0.1, 0.001);`)() !== undefined, 'class runs standalone');
  for (const psi of [0, 0.13, 0.5, 0.77]) a.near(PulseKernel.sample({ morph: 0, duty: 0.5 }, psi, 0.001), Math.sin(2 * Math.PI * psi), 1e-12, `morph 0 = sine at ψ ${psi}`);
  // High harmonic headroom (dt tiny) → the morph is full; the DFT of one cycle must match the coefficients.
  // 배음 여유가 크면 완전한 펄스 → 한 주기의 DFT가 계수와 일치
  const N = 4096;
  const spec = { morph: 0.7, duty: 0.3 };
  const cyc = new Float64Array(N);
  for (let i = 0; i < N; i++) cyc[i] = PulseKernel.sample(spec, i / N, 1 / N);
  const co = pulseCoefficients(spec, 8);
  let worst = 0;
  for (let k = 1; k <= 8; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < N; i++) { re += cyc[i] * Math.cos((2 * Math.PI * k * i) / N); im += cyc[i] * Math.sin((2 * Math.PI * k * i) / N); }
    worst = Math.max(worst, Math.abs((2 * re) / N - co.real[k]), Math.abs((2 * im) / N - co.imag[k]));
  }
  a.ok(worst < 0.01, `harmonics 1–8 match (worst ${worst.toExponential(2)})`);
  // Low headroom (H ≤ 4) → pure sine / 배음 여유 4 이하 → 사인
  a.near(PulseKernel.sample(spec, 0.2, 0.2), Math.sin(2 * Math.PI * 0.2), 1e-12, 'fades to a sine near Nyquist');
  a.equal(PulseKernel.phaseKind, 'cycle', 'phase kind');
}, { group: 'timbre' });
