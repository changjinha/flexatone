/**
 * Flexatone — modules/time-warp.js
 * Layer 1 (modules, pure): the time axis of a Warp — a monotone time map built from a playback
 * rate r(u) > 0 and the two ways of applying it to rendered sample arrays. No DOM, no Web Audio
 * (arrays in, arrays out; the mixer wraps them in AudioBuffers).
 * 계층 1 (순수): 곡률의 시간축 — 재생 속도 r(u)로 만든 단조 시간 사상과, 렌더된 샘플 배열에 적용하는 두 방식.
 *
 *   Φ(u) = ∫₀ᵘ r(u′) du′      real seconds u → content seconds Φ(u)   (r > 0 ⇒ never runs backwards)
 *   tape  out(u) = in(Φ(u))   resampling: speed and pitch change together (pitch × r)
 *   keep  WSOLA (waveform-similarity overlap-add): grains of the input taken at Φ(u), aligned by
 *         cross-correlation and overlap-added at u — the speed changes, the pitch stays
 */

import { clamp } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';

export const MAP_RATE = 200; // map samples per real second / 사상 샘플 속도
export const RATE_MIN = 0.125;
export const RATE_MAX = 8;

/**
 * Time map over [0, U] real seconds: { U, dt, phi: Float64Array, toContent(u), toReal(s), rateAt(u) }.
 * Past U the last rate continues. / 시간 사상 (U 이후는 마지막 속도로 연장)
 */
export function buildTimeMap(rateAt, U, { rate = MAP_RATE } = {}) {
  const n = Math.max(2, Math.ceil(Math.max(0.01, U) * rate) + 1);
  const dt = Math.max(0.01, U) / (n - 1);
  const phi = new Float64Array(n);
  const r = new Float64Array(n);
  for (let k = 0; k < n; k++) r[k] = clamp(Number(rateAt(k * dt)) || 1, RATE_MIN, RATE_MAX);
  for (let k = 1; k < n; k++) phi[k] = phi[k - 1] + 0.5 * (r[k - 1] + r[k]) * dt;
  const last = n - 1;
  const toContent = (u) => {
    if (!(u > 0)) return u * r[0];
    const x = u / dt;
    if (x >= last) return phi[last] + (u - last * dt) * r[last];
    const k = Math.floor(x);
    const f = x - k;
    return phi[k] + (phi[k + 1] - phi[k]) * f;
  };
  const toReal = (s) => {
    if (!(s > 0)) return s / r[0];
    if (s >= phi[last]) return last * dt + (s - phi[last]) / r[last];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (phi[mid] <= s) lo = mid; else hi = mid; }
    const span = phi[hi] - phi[lo];
    return (lo + (span > 0 ? (s - phi[lo]) / span : 0)) * dt;
  };
  const rateAtU = (u) => r[clamp(Math.round(u / dt), 0, last)];
  return { U: (n - 1) * dt, dt, phi, toContent, toReal, rateAt: rateAtU };
}

/**
 * Tape: out[n] = in(Φ(n / sr)) with linear interpolation. `scale` converts real seconds of the
 * map to sample positions of the arrays (sample rate × varispeed). / 테이프 재샘플링
 */
export function resampleTape(inputs, map, outLen, sampleRate) {
  return inputs.map((x) => {
    const out = new Float32Array(outLen);
    for (let n = 0; n < outLen; n++) {
      const p = map.toContent(n / sampleRate) * sampleRate;
      const i = Math.floor(p);
      if (i < 0 || i >= x.length - 1) continue;
      out[n] = x[i] + (x[i + 1] - x[i]) * (p - i);
    }
    return out;
  });
}

/**
 * Pitch-preserving time map (WSOLA). Frame N = 2048 (at 48 kHz, scaled with the rate), output hop
 * N/4, search ±N/5 around Φ(u) for the best continuation of the previous grain (correlation on every
 * 4th sample of channel 0), Hann overlap-add, normalised by the summed window.
 * 음고 유지 시간 사상 (WSOLA): 이전 그레인과 가장 잘 이어지는 위치를 Φ(u) 주변에서 찾아 겹쳐 더함.
 */
export function wsolaStretch(inputs, map, outLen, sampleRate) {
  const N = Math.max(256, Math.round((2048 * sampleRate) / 48000 / 2) * 2);
  const hop = N >> 2;
  const tol = Math.round(N / 5);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const outs = inputs.map(() => new Float32Array(outLen + N));
  const wsum = new Float32Array(outLen + N);
  const x0 = inputs[0];
  const len = x0.length;
  let prev = -1;
  for (let o = 0; o < outLen; o += hop) {
    const centre = Math.round(map.toContent((o + N / 2) / sampleRate) * sampleRate);
    let pos = centre - N / 2;
    if (pos >= len) break;
    if (prev >= 0) {
      const nat = prev + hop; // natural continuation of the previous grain / 이전 그레인의 자연스러운 이음
      let best = pos;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const p = pos + d;
        if (p < 0 || p + N >= len) continue;
        let c = 0;
        for (let i = 0; i < N / 2; i += 4) c += x0[nat + i] * x0[p + i] || 0;
        if (c > bestC) { bestC = c; best = p; }
      }
      pos = best;
    }
    pos = clamp(pos, 0, Math.max(0, len - 1));
    for (let ch = 0; ch < inputs.length; ch++) {
      const x = inputs[ch];
      const y = outs[ch];
      for (let i = 0; i < N && pos + i < len; i++) y[o + i] += x[pos + i] * win[i];
    }
    for (let i = 0; i < N; i++) wsum[o + i] += win[i];
    prev = pos;
  }
  return outs.map((y) => {
    const out = new Float32Array(outLen);
    for (let n = 0; n < outLen; n++) out[n] = wsum[n] > 1e-3 ? y[n] / wsum[n] : 0;
    return out;
  });
}

registerSelfCheck('Time warp: map is monotone and invertible, tape doubles pitch, WSOLA keeps it', (a) => {
  const map = buildTimeMap((u) => (u < 1 ? 1 : 2), 3);
  a.near(map.toContent(1), 1, 1e-2, 'Φ(1) = 1 at rate 1');
  a.near(map.toContent(2), 3, 2e-2, 'Φ(2) = 3 (rate 2 after 1 s)');
  a.near(map.toReal(map.toContent(2.4)), 2.4, 1e-6, 'inverse');
  const sr = 8000;
  const tone = Float32Array.from({ length: sr * 3 }, (_, n) => Math.sin((2 * Math.PI * 200 * n) / sr));
  const freq = (x, t) => { let z = 0; let f = -1; let l = -1; for (let i = Math.floor(t * sr) + 1; i < Math.floor((t + 0.25) * sr); i++) if (x[i - 1] <= 0 && x[i] > 0) { if (f < 0) f = i; l = i; z++; } return ((z - 1) * sr) / (l - f); };
  const fast = buildTimeMap(() => 2, 1.4);
  const [tp] = resampleTape([tone], fast, Math.round(1.4 * sr), sr);
  a.near(freq(tp, 0.5), 400, 4, 'tape at ×2: an octave up');
  const [ks] = wsolaStretch([tone], fast, Math.round(1.4 * sr), sr);
  a.near(freq(ks, 0.5), 200, 4, 'keep at ×2: same pitch');
}, { group: 'math' });
