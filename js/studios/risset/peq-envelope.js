/**
 * Flexatone — studios/risset/peq-envelope.js
 * Risset Studio (pure): Global spectral envelope A_global(p) and multi-node parametric EQ.
 * 리세 스튜디오 (순수): 전역 스펙트럼 포락선 A_global(p)와 다중 노드 파라메트릭 EQ.
 *
 *   Bell-Pass (default) : 1 / (1 + d⁴),            d = (p − c)/σ
 *   Gaussian            : exp(−d²/2)
 *   Raised Cosine       : ½ − ½ cos 2π·clamp(½ + (p − c)/(2σ), 0, 1)
 *   σ (Bell Width) ∈ [0.02, 1.00]; c (center) ∈ [0.05, 0.95].
 * EQ response uses the exact RBJ peaking-biquad magnitude (what the BiquadFilterNodes do).
 * EQ 응답은 실제 BiquadFilter(RBJ peaking) 크기 응답으로 계산.
 * No DOM. Imports core/* only.
 */

import { clamp } from '../../core/math-utils.js';
import { RissetVoiceBank } from './risset-voicebank.js';

export const ENV_SHAPES = Object.freeze(['bellpass', 'gaussian', 'cosine']);
export const EQ_LIMITS = Object.freeze({ freq: [20, 18000], gain: [-18, 18], q: [0.1, 14] });
export const MAX_EQ_NODES = 12;

/**
 * Global envelope at phase p ∈ [0, 1). `env` = { enabled, shape, center, width, skew?, gamma? }.
 * One implementation shared with the audio worklet (RissetVoiceBank.envelope).
 * 위상 p에서의 전역 포락선 (워클릿과 같은 구현).
 */
export function evalGlobalEnvelope(env, p) {
  return RissetVoiceBank.envelope(env, p);
}

/** dA_global/dp (central difference; used for buoyancy). / 포락선 기울기 */
export function envelopeSlope(env, p, h = 1e-3) {
  return (RissetVoiceBank.envelope(env, Math.min(1, p + h)) - RissetVoiceBank.envelope(env, Math.max(0, p - h))) / (Math.min(1, p + h) - Math.max(0, p - h));
}

export const createBellNode = (freq = 2400, gain = 3, q = 1.5) => ({ type: 'peaking', freq, gain, q });

/** Clamp one EQ node to safe ranges. / EQ 노드 범위 제한 */
export function sanitizeEqNode(b) {
  return {
    type: 'peaking',
    freq: clamp(Number(b?.freq) || 1000, ...EQ_LIMITS.freq),
    gain: clamp(Number(b?.gain) || 0, ...EQ_LIMITS.gain),
    q: clamp(Number(b?.q) || 1.2, ...EQ_LIMITS.q),
  };
}

/** EQ presets (multi-node). / 다중 노드 EQ 프리셋 */
export const EQ_PRESETS = Object.freeze({
  flat: () => [createBellNode(180, 0, 1.2), createBellNode(1200, 0, 1.4), createBellNode(4800, 0, 1.2)],
  comb: () => [createBellNode(220, 7.5, 6), createBellNode(440, -6.5, 6), createBellNode(880, 7.5, 6), createBellNode(1760, -6.5, 6), createBellNode(3520, 7, 6)],
  formant: () => [createBellNode(420, 8.5, 3.2), createBellNode(1350, 6, 2.8), createBellNode(2900, 7.5, 3.5)],
  air: () => [createBellNode(120, 4.5, 0.9), createBellNode(850, -2, 1.2), createBellNode(7200, 5.5, 1.1)],
});

/** Magnitude (dB) of one RBJ peaking biquad at `hz`. / 피킹 바이쿼드 크기 응답 (dB) */
export function peakingResponseDb(node, hz, sampleRate = 48000) {
  const b = sanitizeEqNode(node);
  const A = Math.pow(10, b.gain / 40);
  const w0 = (2 * Math.PI * b.freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * b.q);
  const cw = Math.cos(w0);
  const b0 = 1 + alpha * A;
  const b1 = -2 * cw;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cw;
  const a2 = 1 - alpha / A;
  const w = (2 * Math.PI * hz) / sampleRate;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -(b1 * s1 + b2 * s2);
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -(a1 * s1 + a2 * s2);
  const mag = Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
  return 20 * Math.log10(Math.max(1e-12, mag));
}

/** Summed EQ response (dB) of the whole chain. / 전체 EQ 체인 응답 (dB) */
export function eqChainResponseDb(nodes, hz, sampleRate = 48000) {
  let db = 0;
  for (const n of nodes || []) db += peakingResponseDb(n, hz, sampleRate);
  return db;
}
