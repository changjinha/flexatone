/**
 * Flexatone — modules/tremolo.js
 * Layer 1 (modules): studio-agnostic tremolo (periodic amplitude modulation) evaluator, pure math.
 * 계층 1 (modules): 스튜디오와 무관한 트레몰로(주기적 진폭 변조) 평가기. 순수 계산.
 *
 *   m(φ)  = (w(φ) + 1) / 2 ∈ [0, 1]            unipolar LFO, w = shape(φ) ∈ [−1, 1]
 *   g     = 1 − d · (1 − m)                    unit 'amp' : g ∈ [1 − d, 1]
 *   g     = 10^(−D · (1 − m) / 20)             unit 'dB'  : dips by up to D dB
 *   φ(t)  = φ₀ + ∫ rate(u) dt                   the rate may sweep rate → rateEnd across the voice
 * The multiplier never exceeds 1, so a tremolo cannot clip. The same evaluator feeds live playback
 * and offline WAV export (curve-sampled backend); studios only call `createTremoloEvaluator`.
 * 배율은 1을 넘지 않으므로 클리핑이 없습니다. 실시간 재생과 WAV 내보내기가 같은 평가기를 씁니다.
 *
 * Imports: core/*, modules/*. No DOM / Audio APIs.
 */

import { clamp } from '../core/math-utils.js';
import { createDefaultCurveParams, registerSelfCheck } from '../core/state.js';
import { normalizeTremolo, isTremoloOn, tremoloHz, TREMOLO_RATE_MAX } from '../core/tremolo-config.js';
import { evalSingleEngine, regionRampNorm, regionWindow } from './curve-engine.js';
import { compileWaveFormula } from './timbre-synth.js';

const TWO_PI = 2 * Math.PI;
const frac = (x) => x - Math.floor(x);
const smoother = (x) => {
  const s = clamp(x, 0, 1);
  return s * s * s * (s * (6 * s - 15) + 10);
};

const ENGINE_PARAMS = createDefaultCurveParams();

/** Easing u ∈ [0,1] → [0,1] for the rate sweep. / 속도 스윕 이징 */
export function tremoloRateEase(engine, u) {
  const x = clamp(u, 0, 1);
  if (!engine || engine === 'linear') return x;
  return clamp(evalSingleEngine(engine, x, ENGINE_PARAMS), 0, 1);
}

/** Deterministic hash of (seed, n) → [0, 1). / 결정적 해시 */
function hash01(seed, n) {
  let h = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul((seed | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Build the bipolar wave function w(φ) ∈ [−1, 1] of a (normalized) config. */
function buildWave(cfg) {
  switch (cfg.shape) {
    case 'tri':
      return (p) => 1 - 4 * Math.abs(frac(p + 0.25) - 0.5);
    case 'square': {
      const k = 1 + 40 * (1 - cfg.smooth) * (1 - cfg.smooth);
      const nrm = Math.tanh(k);
      return (p) => Math.tanh(k * Math.sin(TWO_PI * p)) / nrm;
    }
    case 'saw': {
      const ww = Math.max(0.002, 0.25 * cfg.smooth);
      const top = 1 - 2 * ww;
      return (p) => {
        const f = frac(p);
        if (f < 1 - ww) return 2 * f - 1;
        return top + (-1 - top) * smoother((f - (1 - ww)) / ww);
      };
    }
    case 'random': {
      const seed = cfg.seed;
      return (p) => {
        const c = Math.floor(p);
        const a = hash01(seed, c) * 2 - 1;
        const b = hash01(seed, c + 1) * 2 - 1;
        return a + (b - a) * 0.5 * (1 - Math.cos(Math.PI * (p - c)));
      };
    }
    case 'formula': {
      const compiled = compileWaveFormula(cfg.formula);
      if (!compiled.ok) return (p) => Math.sin(TWO_PI * p);
      const fn = compiled.fn;
      let lo = Infinity;
      let hi = -Infinity;
      const N = 256;
      for (let i = 0; i < N; i++) {
        const y = fn(i / N);
        if (!Number.isFinite(y)) continue;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      if (!(hi - lo > 1e-9)) return () => 0; // flat formula → no modulation / 평탄 수식
      const mid = 0.5 * (hi + lo);
      const half = 0.5 * (hi - lo);
      return (p) => {
        const y = fn(frac(p));
        return Number.isFinite(y) ? clamp((y - mid) / half, -1, 1) : 0;
      };
    }
    default:
      return (p) => Math.sin(TWO_PI * p);
  }
}

/**
 * Evaluator of one tremolo over one voice (or any timed object).
 * @param {object} rawCfg tremolo config (normalized internally)
 * @param {{ startTime?: number, duration?: number }} [span] absolute start and length in seconds
 * @returns {null | { cfg: object, gainAtSec(sec:number):number, phaseAtSec(sec:number):number, maxRate:number }}
 *   null when the tremolo is off (callers skip it entirely) / 꺼져 있으면 null
 */
export function createTremoloEvaluator(rawCfg, { startTime = 0, duration = 1 } = {}) {
  const cfg = normalizeTremolo(rawCfg);
  if (!isTremoloOn(cfg)) return null;
  const dur = Math.max(1e-6, duration);
  const hz0 = tremoloHz(cfg, 'rate'); // effective Hz (tempo sync resolved) / 실효 Hz
  const hz1 = tremoloHz(cfg, 'rateEnd');
  const rateAt = (u) => hz0 + (hz1 - hz0) * tremoloRateEase(cfg.rateEngine, u);

  // Cumulative phase (cycles) at LUT nodes: φ(u) = ∫ rate dt, trapezoid rule.
  const N = clamp(Math.ceil(dur * 100), 64, 4096);
  const cum = new Float64Array(N + 1);
  let prev = rateAt(0);
  for (let k = 1; k <= N; k++) {
    const r = rateAt(k / N);
    cum[k] = cum[k - 1] + 0.5 * (prev + r) * (dur / N);
    prev = r;
  }
  const origin = cfg.phase + (cfg.sync === 'global' ? hz0 * startTime : 0);
  const wave = buildWave(cfg);

  const phaseAtSec = (sec) => {
    const x = clamp((sec - startTime) / dur, 0, 1) * N;
    const i = Math.min(N - 1, Math.floor(x));
    return origin + cum[i] + (x - i) * (cum[i + 1] - cum[i]);
  };
  const gainAtSec = (sec) => {
    const m = 0.5 * (wave(phaseAtSec(sec)) + 1);
    const fade = cfg.fadeIn > 0 ? smoother((sec - startTime) / cfg.fadeIn) : 1;
    if (cfg.depthUnit === 'db') return Math.pow(10, (-cfg.depthDb * fade * (1 - m)) / 20);
    return 1 - cfg.depth * fade * (1 - m);
  };
  return { cfg, gainAtSec, phaseAtSec, maxRate: Math.max(hz0, hz1) };
}

/** Region edge fade floor (s), same as the gain regions (modules/gain-bus.js). / 구간 경계 최소 페이드 */
const REGION_FADE_MIN = 0.004;

/**
 * Tremolo of one voice including its regions. A region whose own tremolo is on REPLACES the voice
 * tremolo inside it: g = (1 − w)·g_voice + w·g_region, where w is the region window (the same edge
 * fade as the region gain / mute). The region tremolo runs over the region's own span (phase and
 * fade-in restart at the region start, a sweep spans the region). Returns null when nothing
 * modulates. / 보이스 트레몰로 + 구간 오버라이드: 구간 창 w로 보이스 트레몰로와 크로스페이드
 * @param {object} v voice-like { startTime, duration, tremolo?, regions? }
 */
export function createVoiceTremoloEvaluator(v) {
  const start = Number(v?.startTime) || 0;
  const dur = Math.max(1e-6, Number(v?.duration) || 1);
  const base = createTremoloEvaluator(v?.tremolo, { startTime: start, duration: dur });
  const regs = [];
  for (const r of Array.isArray(v?.regions) ? v.regions : []) {
    if (!r || !isTremoloOn(r.tremolo)) continue;
    const t0 = start + r.t0 * dur;
    const ev = createTremoloEvaluator(r.tremolo, { startTime: t0, duration: Math.max(1e-6, (r.t1 - r.t0) * dur) });
    if (!ev) continue;
    const fadeSec = r.ramp === 'off' ? REGION_FADE_MIN : Math.max(REGION_FADE_MIN, Number(r.rampSec) || 0);
    regs.push({ r, ev, rn: regionRampNorm(r, dur, fadeSec) });
  }
  if (!base && !regs.length) return null;
  const gainAtSec = (sec) => {
    let g = base ? base.gainAtSec(sec) : 1;
    if (!regs.length) return g;
    const tn = (sec - start) / dur;
    for (const { r, ev, rn } of regs) {
      const w = regionWindow(r, tn, rn, r.t0 > 1e-6, r.t1 < 1 - 1e-6);
      if (w > 0) g += w * (ev.gainAtSec(sec) - g);
    }
    return g;
  };
  return { gainAtSec, hasRegions: regs.length > 0 };
}

// --------------------------------------------------------------------------
// LFO backend spec (free-running oscillator, for engines without a fixed timeline)
// LFO 백엔드 명세 (고정된 시간축이 없는 엔진용: Risset 등)
// --------------------------------------------------------------------------

const LFO_RANDOM_CYCLES = 16; // random shape: one table period holds this many cycles / 랜덤: 표 한 주기의 사이클 수

/**
 * Everything an LFO-driven gain stage needs, as plain data:
 *   gain(t) = offset + depthGain · w(2π · frequency · t),  w = the periodic table (real / imag).
 * The same g = 1 − d(1 − m) as the curve backend; the dB unit maps to its amp-equivalent depth
 * (same trough, linear-in-amp flanks). Rate sweep, fade-in and global sync need a timeline, so the
 * LFO backend ignores them. The random shape repeats a 16-cycle pattern.
 * LFO 게인 단계 명세: gain(t) = offset + depthGain · w(2π·frequency·t). 스윕·페이드인·전역 동기는 시간축이
 * 필요하므로 무시하고, 랜덤 파형은 16주기 패턴을 반복합니다.
 * @returns {{ on: boolean, frequency: number, offset: number, depthGain: number, real: Float32Array,
 *             imag: Float32Array, waveKey: string }}
 */
export function tremoloLfoSpec(rawCfg, { harmonics = 64 } = {}) {
  const cfg = normalizeTremolo(rawCfg);
  const on = isTremoloOn(cfg);
  const waveKey = `${cfg.shape}|${cfg.phase}|${cfg.smooth}|${cfg.seed}|${cfg.shape === 'formula' ? cfg.formula : ''}`;
  const cycles = cfg.shape === 'random' ? LFO_RANDOM_CYCLES : 1;
  const H = cycles === 1 ? harmonics : Math.min(512, harmonics * 3);
  const real = new Float32Array(H + 1);
  const imag = new Float32Array(H + 1);
  if (!on) return { on: false, frequency: tremoloHz(cfg) / cycles, offset: 1, depthGain: 0, real, imag, waveKey };

  const wave = buildWave(cfg);
  const N = cycles === 1 ? 2048 : 4096;
  const w = new Float64Array(N);
  let mean = 0;
  for (let n = 0; n < N; n++) { w[n] = wave((n / N) * cycles + cfg.phase); mean += w[n]; }
  mean /= N;
  for (let k = 1; k <= H; k++) {
    let a = 0;
    let b = 0;
    for (let n = 0; n < N; n++) {
      const th = (TWO_PI * k * n) / N;
      const v = w[n] - mean;
      a += v * Math.cos(th);
      b += v * Math.sin(th);
    }
    real[k] = (2 * a) / N;
    imag[k] = (2 * b) / N;
  }
  const d = cfg.depthUnit === 'db' ? 1 - Math.pow(10, -cfg.depthDb / 20) : cfg.depth;
  return { on: true, frequency: tremoloHz(cfg) / cycles, offset: 1 - d / 2 + (d / 2) * mean, depthGain: d / 2, real, imag, waveKey };
}

/** Curve samples per LFO cycle needed to draw a shape faithfully. / 파형별 필요한 사이클당 샘플 수 */
const SAMPLES_PER_CYCLE = { sine: 24, tri: 24, square: 40, saw: 40, random: 32, formula: 40 };

/**
 * Automation density (points/s) a set of voices needs so every tremolo cycle is well sampled;
 * 0 when none of them uses a tremolo. / 필요한 자동화 곡선 밀도 (없으면 0)
 */
export function tremoloCurveRate(voices) {
  let need = 0;
  const consider = (raw) => {
    if (!isTremoloOn(raw)) return;
    const cfg = normalizeTremolo(raw);
    need = Math.max(need, Math.max(tremoloHz(cfg, 'rate'), tremoloHz(cfg, 'rateEnd')) * (SAMPLES_PER_CYCLE[cfg.shape] || 40));
  };
  for (const v of voices) {
    consider(v?.tremolo);
    for (const r of Array.isArray(v?.regions) ? v.regions : []) consider(r?.tremolo);
  }
  return need;
}

/** Plain sampled preview of a tremolo over its voice for UI drawing. / UI 미리보기용 샘플 */
export function sampleTremoloPreview(rawCfg, duration, n = 240) {
  const ev = createTremoloEvaluator(rawCfg, { startTime: 0, duration });
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ev ? ev.gainAtSec((duration * i) / Math.max(1, n - 1)) : 1;
  return out;
}

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Tremolo evaluator (range, rate, depth, fade, sync)', (a) => {
  a.equal(createTremoloEvaluator({ on: false }), null, 'off → null');
  a.equal(createTremoloEvaluator({ on: true, depth: 0 }), null, 'zero depth → null');
  a.equal(createTremoloEvaluator(undefined), null, 'missing config → null');

  // Range: g ∈ [1 − depth, 1] for every shape; the extremes are reached.
  for (const shape of ['sine', 'tri', 'square', 'saw', 'random', 'formula']) {
    const ev = createTremoloEvaluator({ on: true, shape, rate: 7, rateEnd: 7, depth: 0.6, seed: 3 }, { startTime: 0, duration: 4 });
    let lo = 2;
    let hi = -1;
    for (let i = 0; i <= 4000; i++) {
      const g = ev.gainAtSec((4 * i) / 4000);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    a.ok(lo >= 0.4 - 1e-9 && hi <= 1 + 1e-9, `${shape}: g within [0.4, 1] (got ${lo.toFixed(3)}…${hi.toFixed(3)})`);
    a.ok(hi - lo > 0.35, `${shape}: modulates (${(hi - lo).toFixed(3)})`);
  }

  // Rate: a fixed 5 Hz tremolo completes 5 cycles per second; a linear 2 → 10 Hz sweep integrates
  // to the mean rate × duration.
  const fixed = createTremoloEvaluator({ on: true, rate: 5, rateEnd: 5, depth: 0.5 }, { startTime: 0, duration: 3 });
  a.near(fixed.phaseAtSec(1) - fixed.phaseAtSec(0), 5, 1e-9, 'fixed rate → 5 cycles / s');
  const sweep = createTremoloEvaluator({ on: true, rate: 2, rateEnd: 10, rateEngine: 'linear', depth: 0.5 }, { startTime: 0, duration: 5 });
  a.near(sweep.phaseAtSec(5) - sweep.phaseAtSec(0), 30, 0.02, 'linear sweep integrates to mean rate × duration');

  // Depth units and phase.
  const amp = createTremoloEvaluator({ on: true, shape: 'sine', rate: 1, rateEnd: 1, depth: 0.5, phase: 0.75 }, { startTime: 0, duration: 2 });
  a.near(amp.gainAtSec(0), 0.5, 1e-9, 'phase 0.75: trough = 1 − depth');
  a.near(amp.gainAtSec(0.5), 1, 1e-9, 'half a cycle later: peak = 1');
  const db = createTremoloEvaluator({ on: true, shape: 'sine', depthUnit: 'db', depthDb: 12, rate: 1, rateEnd: 1, phase: 0.75 }, { startTime: 0, duration: 2 });
  a.near(db.gainAtSec(0), Math.pow(10, -12 / 20), 1e-9, 'dB unit: trough = −depthDb');

  // Fade-in: depth ramps from 0, so the start is unmodulated.
  const fade = createTremoloEvaluator({ on: true, shape: 'sine', rate: 1, rateEnd: 1, depth: 1, phase: 0.75, fadeIn: 2 }, { startTime: 0, duration: 4 });
  a.near(fade.gainAtSec(0), 1, 1e-9, 'fadeIn: no modulation at t = 0');
  a.near(fade.gainAtSec(2), 0, 1e-9, 'fadeIn: full depth after the fade (trough = 0)');

  // Sync: 'global' follows the timeline, 'voice' restarts at the voice start.
  const g1 = createTremoloEvaluator({ on: true, rate: 3, rateEnd: 3, depth: 0.5, sync: 'global' }, { startTime: 1.3, duration: 2 });
  const g2 = createTremoloEvaluator({ on: true, rate: 3, rateEnd: 3, depth: 0.5, sync: 'global' }, { startTime: 5.1, duration: 2 });
  // Phases are compared on the circle (0.99999… ≡ 0). / 위상은 원형 거리로 비교
  const cdist = (x, y) => { const d = Math.abs(frac(x) - frac(y)); return Math.min(d, 1 - d); };
  a.near(cdist(g1.phaseAtSec(2), 3 * 2), 0, 1e-9, 'global: φ = rate · t on the timeline');
  a.near(cdist(g2.phaseAtSec(6), 3 * 6), 0, 1e-9, 'global: same phase at the same absolute time for any voice');
  const v1 = createTremoloEvaluator({ on: true, rate: 3, rateEnd: 3, depth: 0.5, sync: 'voice' }, { startTime: 1.3, duration: 2 });
  a.near(v1.phaseAtSec(1.3), 0, 1e-9, 'voice: φ = 0 at the voice start');

  // Random shape is deterministic per seed; density helper.
  const r1 = createTremoloEvaluator({ on: true, shape: 'random', seed: 9, rate: 4, depth: 1 }, { duration: 2 });
  const r2 = createTremoloEvaluator({ on: true, shape: 'random', seed: 9, rate: 4, depth: 1 }, { duration: 2 });
  a.equal(r1.gainAtSec(0.77), r2.gainAtSec(0.77), 'random: same seed → same values');
  a.equal(tremoloCurveRate([{ tremolo: { on: false } }]), 0, 'density: none');
  a.ok(tremoloCurveRate([{ tremolo: { on: true, rate: 10, rateEnd: 20, shape: 'square', depth: 1 } }]) >= 800, 'density follows rate × samples per cycle');

  // Normalization clamps and tolerates garbage.
  const n = normalizeTremolo({ on: true, rate: 999, depth: 9, shape: 'nope', phase: -0.25, sync: 'x' });
  a.ok(n.rate <= TREMOLO_RATE_MAX && n.depth === 1 && n.shape === 'sine' && n.sync === 'voice', 'normalize clamps / defaults');
  a.near(n.phase, 0.75, 1e-9, 'normalize wraps phase');
}, { group: 'tremolo' });

registerSelfCheck('Tremolo LFO spec reproduces the curve backend (offset + depth · Fourier series)', (a) => {
  const cases = [
    { shape: 'sine', depth: 0.5, rate: 3, phase: 0.1 },
    { shape: 'tri', depth: 0.8, rate: 4, phase: 0.6 },
    { shape: 'square', depth: 1, rate: 2, phase: 0, smooth: 0.8 },
    { shape: 'formula', depth: 0.6, rate: 5, phase: 0.2, formula: 'sin(2*pi*x)+0.5*sin(4*pi*x)' },
    { shape: 'sine', depthUnit: 'db', depthDb: 18, rate: 6, phase: 0.25 },
  ];
  for (const c of cases) {
    const cfg = { on: true, rateEnd: c.rate, ...c };
    const spec = tremoloLfoSpec(cfg);
    const ev = createTremoloEvaluator({ ...cfg, depthUnit: c.depthUnit || 'amp' }, { startTime: 0, duration: 4 });
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      const t = (4 * i) / 400;
      let x = 0;
      const th = TWO_PI * spec.frequency * t;
      for (let k = 1; k < spec.real.length; k++) x += spec.real[k] * Math.cos(k * th) + spec.imag[k] * Math.sin(k * th);
      const g = spec.offset + spec.depthGain * x;
      // The dB unit maps to its amp-equivalent depth, so compare against that curve. / dB는 진폭 환산 깊이로 비교
      const ref = c.depthUnit === 'db'
        ? 1 - (1 - Math.pow(10, -c.depthDb / 20)) * (1 - 0.5 * (Math.sin(TWO_PI * (c.rate * t + c.phase)) + 1))
        : ev.gainAtSec(t);
      worst = Math.max(worst, Math.abs(g - ref));
    }
    a.ok(worst < (c.shape === 'square' ? 0.1 : 0.02), `${c.shape}${c.depthUnit ? '/dB' : ''}: max |Δg| = ${worst.toFixed(4)}`);
  }
  a.equal(tremoloLfoSpec({ on: false }).offset, 1, 'off → unity gain');
  a.equal(tremoloLfoSpec({ on: false }).depthGain, 0, 'off → no modulation');
  const r = tremoloLfoSpec({ on: true, shape: 'random', depth: 1, rate: 8, seed: 4 });
  a.near(r.frequency, 0.5, 1e-9, 'random: table holds 16 cycles → LFO runs at rate / 16');
}, { group: 'tremolo' });

registerSelfCheck('Tremolo tempo sync, region override and Manager tempo scaling', (a) => {
  // Beat sync: 90 BPM × 2 cycles / beat = 3 Hz.
  const beat = createTremoloEvaluator({ on: true, rateUnit: 'beat', bpm: 90, rate: 2, rateEnd: 2, depth: 0.5 }, { startTime: 0, duration: 4 });
  a.near(beat.phaseAtSec(1) - beat.phaseAtSec(0), 3, 1e-9, 'beat sync → bpm / 60 × cycles per beat');
  a.near(tremoloHz({ rateUnit: 'hz', rate: 7 }), 7, 1e-12, 'Hz unit is the rate itself');
  a.near(tremoloHz({ rateUnit: 'beat', rate: 100, bpm: 960 }), TREMOLO_RATE_MAX, 1e-12, 'effective Hz is clamped');

  // Region override: outside the region the voice tremolo (here off) is untouched; inside, the
  // region's tremolo applies, blended in over the region ramp.
  const v = { startTime: 0, duration: 10, tremolo: { on: false },
    regions: [{ id: 'r', t0: 0.4, t1: 0.8, ramp: 'on', rampSec: 0.5, tremolo: { on: true, shape: 'sine', rate: 2, rateEnd: 2, depth: 1, phase: 0.75 } }] };
  const ev = createVoiceTremoloEvaluator(v);
  a.ok(ev && ev.hasRegions, 'a region tremolo alone is enough');
  a.near(ev.gainAtSec(1), 1, 1e-12, 'before the region: unmodulated');
  a.near(ev.gainAtSec(9), 1, 1e-12, 'after the region: unmodulated');
  let lo = 2;
  for (let t = 4.6; t < 7.4; t += 0.01) lo = Math.min(lo, ev.gainAtSec(t));
  a.ok(lo < 0.05, `inside the region the full depth is reached (min ${lo.toFixed(3)})`);
  a.ok(ev.gainAtSec(4.05) > 0.9, 'the region fades in over its ramp (no step at the edge)');
  a.equal(createVoiceTremoloEvaluator({ startTime: 0, duration: 4, tremolo: { on: false }, regions: [{ t0: 0, t1: 1, tremolo: { on: false } }] }), null, 'nothing on → null');
  a.ok(tremoloCurveRate([v]) >= 2 * 24, 'curve density accounts for region tremolos');

  // Legacy configs (no rateUnit / bpm) default to Hz at 120 BPM.
  const n = normalizeTremolo({ on: true, rate: 6, depth: 0.3 });
  a.ok(n.rateUnit === 'hz' && n.bpm === 120, 'legacy defaults');
}, { group: 'tremolo' });
