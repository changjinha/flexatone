/**
 * Flexatone — studios/wave/wave-bank.js
 * Wave Studio (pure DSP): additive sine bank shared by the AudioWorklet (Blob), the offline WAV
 * render and the main-thread self-checks. No imports, no DOM, no Web Audio — the class source is
 * shipped into the worklet with `WaveSpectralBank.toString()`, so it MUST stay self-contained.
 * 웨이브 스튜디오 (순수 DSP): 워클릿·오프라인 렌더·자가진단이 공유하는 가산 사인 뱅크.
 * import 없이 자기완결이어야 함 (toString()으로 워클릿에 들어감).
 *
 *   bin i          fixed frequency fᵢ, phase accumulator φᵢ kept inside the bank (never reset
 *                  by amplitude changes → phase-continuous)
 *   amplitude      aᵢ(t) = M[frame][i], frame = t·frameRate, linear in time between frames and
 *                  linear inside each block (a0 → a1)
 *   output         L/R = clamp(scale·Σᵢ aᵢ·panᵢ·sin 2πφᵢ, ±0.98)
 *   control matrix M (frames × bins, Float32) is allocated once in the constructor and filled by
 *                  setChunk() — chunks arrive through the worklet port, nothing is allocated in
 *                  process(). / 제어 행렬은 생성자에서 1회 할당, 청크로 채움. process() 내 할당 없음.
 */
export class WaveSpectralBank {
  /**
   * @param {number} sampleRate
   * @param {number} bins
   * @param {number} frames
   * @param {{ frameRate:number, freqs:ArrayLike<number>, phases?:ArrayLike<number>,
   *           panL?:ArrayLike<number>, panR?:ArrayLike<number>, scale?:number }} o
   */
  constructor(sampleRate, bins, frames, o) {
    this.fs = sampleRate;
    this.n = bins;
    this.frames = frames;
    this.rate = o.frameRate;
    this.M = new Float32Array(frames * bins);
    this.inc = new Float64Array(bins);
    this.ph = new Float64Array(bins);
    this.a0 = new Float32Array(bins);
    this.a1 = new Float32Array(bins);
    this.gl = new Float32Array(bins);
    this.gr = new Float32Array(bins);
    this.scale = 1;
    this.fresh = true;
    // 4096-point sine table, linear interpolation (|error| < 3e-7) / 사인 테이블
    this.tab = new Float64Array(4097);
    for (let i = 0; i <= 4096; i++) this.tab[i] = Math.sin((2 * Math.PI * i) / 4096);
    // Per-voice (per-bin) tremolo / vibrato: o.mod = { seed, t / v: [on, rate, depth|cents, rateSpread, depthK, phaseSpread, dist, drift, —], tE / vE }
    // (core/voice-mod.js voiceModFrame; the hash is repeated here — this class must stay self-contained)
    // 빈별 트레몰로·비브라토 (core/voice-mod.js와 같은 해시 — 자기완결 유지)
    this.mod = o.mod || null;
    if (this.mod) {
      this.mT = new Float64Array(bins * 6); // [rate, depth, phase, drift, drift Hz, drift phase] per bin / 빈별 값
      this.mV = new Float64Array(bins * 6);
    }
    for (let i = 0; i < bins; i++) {
      if (this.mod) {
        const m = this.mod;
        const f = o.freqs[i] > 0 ? o.freqs[i] : 440;
        const b01 = Math.min(1, Math.max(0, (69 + 12 * Math.log2(f / 440) - 24) / 84));
        const u = (k) => WaveSpectralBank.voiceRand(m.seed, i, k);
        const put = (dst, q, tab, k0, depthScale) => {
          const d = q[6] === 1 ? u(k0) ** 3 : q[6] === 2 ? (u(k0) < 0 ? -1 : 1) : u(k0);
          dst[i * 6] = q[1] * Math.pow(2, q[3] * d + WaveSpectralBank.env01(tab, b01));
          dst[i * 6 + 1] = q[2] * depthScale * (1 - q[4] * (u(k0 + 1) + 1));
          dst[i * 6 + 2] = q[5] * 0.5 * (u(k0 + 2) + 1);
          dst[i * 6 + 3] = 0.5 * (q[7] || 0);
          dst[i * 6 + 4] = 0.1 * (1 + 0.5 * u(k0 + 7));
          dst[i * 6 + 5] = 0.5 * (u(k0 + 8) + 1);
        };
        if (m.t[0]) put(this.mT, m.t, m.tE, 0, 1);
        if (m.v[0]) put(this.mV, m.v, m.vE, 3, 1 / 1200);
      }
      // Nyquist guard: a bin above 0.45·fs never sounds / 나이퀴스트 보호
      const f = o.freqs[i];
      this.inc[i] = f > 0 && f < 0.45 * sampleRate ? f / sampleRate : 0;
      const p = o.phases ? o.phases[i] : 0;
      this.ph[i] = p - Math.floor(p);
    }
    this.configure(o);
  }

  /** Band-follow table at b ∈ [0, 1] (core/voice-mod.js envAt01). / 대역 추종 표 */
  static env01(tab, b) {
    if (!tab) return 0;
    const n = tab.length;
    const x = b * (n - 1);
    const k = Math.min(n - 2, Math.floor(x));
    return tab[k] + (tab[k + 1] - tab[k]) * (x - k);
  }

  /** LFO phase with slow drift (core/voice-mod.js lanePhase); m = table, j = bin·6. / 표류 포함 위상 */
  static lanePhase(m, j, t) {
    const a = m[j + 3];
    if (!a) return m[j] * t;
    const w = 2 * Math.PI * m[j + 4];
    const p0 = 2 * Math.PI * m[j + 5];
    return m[j] * (t - (a / w) * (Math.cos(w * t + p0) - Math.cos(p0)));
  }

  /** u ∈ [−1, 1] for (seed, bin, lane) — identical to voiceRand() in core/voice-mod.js. / 결정적 난수 */
  static voiceRand(seed, i, k) {
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 1, 0x85ebca77) ^ Math.imul(k + 1, 0xc2b2ae3d)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295 * 2 - 1;
  }

  /** Update pan gains and the output scale (not called from process). / 팬·스케일 갱신 */
  configure(o) {
    for (let i = 0; i < this.n; i++) {
      this.gl[i] = o.panL ? o.panL[i] : 1;
      this.gr[i] = o.panR ? o.panR[i] : 1;
    }
    if (o.scale !== undefined) this.scale = o.scale;
  }

  /** Copy rows starting at frame0 into the control matrix. / 제어 행렬에 청크 복사 */
  setChunk(frame0, data) {
    const off = frame0 * this.n;
    if (off < 0 || off + data.length > this.M.length) return false;
    this.M.set(data, off);
    return true;
  }

  /** Restart the amplitude interpolation at the next block (after a seek). / 탐색 후 재시작 */
  seek() {
    this.fresh = true;
  }

  /** Target amplitudes at frame position `f` into `dst` (0 outside the matrix). / 목표 진폭 */
  rowAt(f, dst) {
    const n = this.n;
    if (!(f >= 0) || f > this.frames - 1) {
      for (let i = 0; i < n; i++) dst[i] = 0;
      return;
    }
    const fi = Math.floor(f);
    const fr = f - fi;
    const r0 = fi * n;
    const r1 = (fi + 1 < this.frames ? fi + 1 : fi) * n;
    const M = this.M;
    for (let i = 0; i < n; i++) dst[i] = M[r0 + i] + (M[r1 + i] - M[r0 + i]) * fr;
  }

  /**
   * Render `len` samples. f0 / f1 = frame positions at the first sample and one past the last.
   * Allocation-free: only the arrays created in the constructor are touched.
   * len 샘플 렌더. f0 / f1 = 블록 처음과 끝의 프레임 위치. 할당 없음.
   */
  process(outL, outR, len, f0, f1) {
    const n = this.n;
    const tab = this.tab;
    const a0 = this.a0;
    const a1 = this.a1;
    if (this.fresh) {
      this.rowAt(f0, a0);
      this.fresh = false;
    }
    this.rowAt(f1, a1);
    for (let s = 0; s < len; s++) {
      outL[s] = 0;
      outR[s] = 0;
    }
    const inv = 1 / len;
    const mod = this.mod;
    const tSec = mod ? f0 / this.rate : 0; // timeline seconds of this block / 이 블록의 타임라인 시각
    for (let i = 0; i < n; i++) {
      let ga = a0[i];
      let gb = a1[i];
      let inc = this.inc[i];
      if (mod) {
        // held for this block (≤ 128 samples) / 블록 동안 유지
        const rT = this.mT[i * 6];
        if (rT) { const gm = 1 - this.mT[i * 6 + 1] * (0.5 - 0.5 * Math.cos(2 * Math.PI * (WaveSpectralBank.lanePhase(this.mT, i * 6, tSec) + this.mT[i * 6 + 2]))); ga *= gm; gb *= gm; }
        const rV = this.mV[i * 6];
        if (rV) inc *= Math.pow(2, this.mV[i * 6 + 1] * Math.sin(2 * Math.PI * (WaveSpectralBank.lanePhase(this.mV, i * 6, tSec) + this.mV[i * 6 + 2])));
      }
      let ph = this.ph[i];
      if ((ga === 0 && gb === 0) || inc === 0) {
        // Silent: keep the phase moving (no oscillator work) / 무음이어도 위상은 진행
        ph += inc * len;
        this.ph[i] = ph - Math.floor(ph);
        a0[i] = a1[i];
        continue;
      }
      const dg = (gb - ga) * inv;
      const l = this.gl[i];
      const r = this.gr[i];
      for (let s = 0; s < len; s++) {
        const x = ph * 4096;
        const k = x | 0;
        const v = (ga + dg * s) * (tab[k] + (tab[k + 1] - tab[k]) * (x - k));
        outL[s] += v * l;
        outR[s] += v * r;
        ph += inc;
        if (ph >= 1) ph -= 1;
      }
      this.ph[i] = ph;
      a0[i] = a1[i];
    }
    const sc = this.scale;
    for (let s = 0; s < len; s++) {
      const a = outL[s] * sc;
      const b = outR[s] * sc;
      outL[s] = a > 0.98 ? 0.98 : a < -0.98 ? -0.98 : a;
      outR[s] = b > 0.98 ? 0.98 : b < -0.98 ? -0.98 : b;
    }
  }
}

/** Worklet source: the bank class + a thin processor (Blob). / 워클릿 소스 */
export const WAVE_PROCESSOR = 'fx-wave-bank';
export function buildWaveWorkletSource() {
  return `${WaveSpectralBank.toString()}
class FxWaveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.bank = new WaveSpectralBank(sampleRate, o.bins, o.frames, o);
    if (o.matrix) this.bank.setChunk(0, o.matrix);
    this.from = o.fromFrame || 0;
    this.t0 = o.startTime || 0;
    this.k = o.frameRate / sampleRate;
    this.scratch = new Float32Array(128);
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'chunk') { this.bank.setChunk(m.frame0, m.data); if (m.last) this.port.postMessage({ type: 'loaded', id: m.id }); }
      else if (m.type === 'config') this.bank.configure(m);
      else if (m.type === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out.length > 1 ? out[1] : (this.scratch.length >= L.length ? this.scratch : L);
    const rel = currentFrame - this.t0 * sampleRate;
    const f0 = rel < 0 ? -1 : this.from + rel * this.k;
    this.bank.process(L, R, L.length, f0, rel < 0 ? -1 : f0 + L.length * this.k);
    return this.alive;
  }
}
registerProcessor('${WAVE_PROCESSOR}', FxWaveProcessor);
`;
}
