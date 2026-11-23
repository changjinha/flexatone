/**
 * Flexatone — modules/loudness-model.js
 * Layer 1 (modules): real-time Sone loudness + narrow-band masking analyzer (pure DSP).
 * 계층 1 (modules): 실시간 Sone 라우드니스 + 협대역 마스킹 분석기 (순수 DSP).
 *
 *   samples → ring(1024) ─every 512─▶ Hann · radix-2 FFT (sin/cos LUT, in place)
 *     → outer/middle-ear weight per bin (3–4 kHz resonance boost, low-end roll-off)
 *     → 24 Bark bands (sparse startBin…endBin loops) → band level L_b [dB SPL]
 *     → spreading: lower slope −27 dB/Bark; upper slope level dependent
 *         Low (40 dB) −25 · Mid (60 dB) −17.5 · High (80 dB) −10 dB/Bark → 3 × 24×24 matrices, lerp by L_j
 *     → excitation E_i, masking threshold M_i = E_i − (6 + 0.25·i) dB
 *     → specific loudness N'_i = 0.08·E_TQ^α·[(0.5 + 0.5·E_i/E_TQ)^α − 1], α = 0.23 (LUT + lerp)
 *     → Total Sone = scale·Σ N'_i  (scale calibrated so a 1 kHz tone at 40 dB SPL = 1 sone)
 *   Calibration: a 0 dBFS sine ↔ fullScaleDbSpl dB SPL.
 *
 * Zero-GC: every buffer is a typed array allocated once in the constructor; push()/analyze()
 * allocate nothing. / 생성자에서 한 번만 할당, push()/analyze()는 할당 0.
 *
 * IMPORTANT: the class is fully self-contained (no imports, no outer references) because
 * audio/loudness-meter.js ships `LoudnessAnalyzer.toString()` into an AudioWorklet Blob.
 * 클래스는 외부 참조가 없어야 함 (toString()으로 워클릿 Blob에 그대로 들어감).
 */

export class LoudnessAnalyzer {
  constructor(sampleRate, opts) {
    const o = opts || {};
    const N = 1024;
    const hop = 512;
    const B = 24;
    this.fs = sampleRate || 48000;
    this.N = N;
    this.hop = hop;
    this.B = B;
    this.fullScaleDbSpl = Number.isFinite(o.fullScaleDbSpl) ? o.fullScaleDbSpl : 90;

    // Ring buffer + FFT work arrays / 링 버퍼 + FFT 작업 배열
    this.ring = new Float32Array(N);
    this.writePos = 0;
    this.sinceHop = 0;
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.win = new Float64Array(N);
    let wp = 0;
    for (let n = 0; n < N; n++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N);
      this.win[n] = w;
      wp += w * w;
    }
    // Σ_{k>0}|X_k|² · powNorm = mean square of the frame; ÷ 0.5 → relative to a full-scale sine
    this.powNorm = 2 / (N * wp);
    this.cosT = new Float64Array(N / 2);
    this.sinT = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) {
      this.cosT[k] = Math.cos((2 * Math.PI * k) / N);
      this.sinT[k] = -Math.sin((2 * Math.PI * k) / N);
    }
    this.bitrev = new Uint16Array(N);
    const bits = Math.round(Math.log2(N));
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.bitrev[i] = r;
    }

    // Outer/middle-ear weight per bin (power) / 외이·중이 보정 (빈별 파워 가중치)
    const half = N / 2;
    const df = this.fs / N;
    this.binW = new Float64Array(half + 1);
    const res1k = 6.5 * Math.exp(-0.6 * (1 - 3.3) * (1 - 3.3));
    for (let k = 1; k <= half; k++) {
      const f = Math.max(0.02, (k * df) / 1000);
      let wDb = 6.5 * Math.exp(-0.6 * (f - 3.3) * (f - 3.3)) - res1k
        - 0.25 * 3.64 * Math.max(0, Math.pow(f, -0.8) - 1)
        - 1e-3 * (Math.pow(f, 4) - 1);
      if (wDb < -60) wDb = -60;
      this.binW[k] = Math.pow(10, wDb / 10);
    }

    // 24 Bark bands (Zwicker edges) → sparse bin ranges / Bark 대역 희소 매핑
    const edges = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
    this.bandStart = new Int16Array(B);
    this.bandEnd = new Int16Array(B); // exclusive
    this.bandCenterHz = new Float32Array(B);
    this.thqDb = new Float64Array(B);
    for (let b = 0; b < B; b++) {
      const lo = Math.max(1, Math.ceil(edges[b] / df));
      const hiEdge = Math.min(edges[b + 1], this.fs / 2);
      const hi = Math.max(lo + 1, Math.min(half + 1, Math.ceil(hiEdge / df)));
      this.bandStart[b] = lo;
      this.bandEnd[b] = hi;
      const fc = (edges[b] + edges[b + 1]) / 2;
      this.bandCenterHz[b] = fc;
      const fk = Math.max(0.05, fc / 1000);
      // Terhardt threshold in quiet / 최소 가청 역치
      let t = 3.64 * Math.pow(fk, -0.8) - 6.5 * Math.exp(-0.6 * (fk - 3.3) * (fk - 3.3)) + 1e-3 * Math.pow(fk, 4);
      if (t > 80) t = 80;
      if (t < -5) t = -5;
      this.thqDb[b] = t;
    }

    // Spreading matrices Low / Mid / High (row = maskee i, col = masker j) / 확산 행렬 3단
    const ups = [25, 17.5, 10];
    this.spread = new Float64Array(3 * B * B);
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < B; i++) {
        for (let j = 0; j < B; j++) {
          const dz = i - j;
          const att = dz < 0 ? 27 * -dz : ups[m] * dz;
          this.spread[m * B * B + i * B + j] = Math.pow(10, -att / 10);
        }
      }
    }

    // α = 0.23 power LUT over dB: (10^(d/10))^α = 10^(α·d/10) / 지수 LUT
    this.alpha = 0.23;
    this.lutMin = -40;
    this.lutStep = 0.25;
    this.lutSize = 801; // −40 … +160 dB
    this.powLut = new Float64Array(this.lutSize);
    for (let i = 0; i < this.lutSize; i++) this.powLut[i] = Math.pow(10, (this.alpha * (this.lutMin + i * this.lutStep)) / 10);
    this.etqPow = new Float64Array(B);
    for (let b = 0; b < B; b++) this.etqPow[b] = this.powAlphaDb(this.thqDb[b]);

    // Per-frame results / 프레임 결과
    this.bandI = new Float64Array(B); // band intensity re 0 dB SPL
    this.levelDb = new Float32Array(B);
    this.excI = new Float64Array(B);
    this.excDb = new Float32Array(B);
    this.maskDb = new Float32Array(B);
    this.specific = new Float32Array(B);
    this.totalSone = 0;
    this.peak = 0;
    this.sumSq = 0;
    this.nSq = 0;
    this.frames = 0;
    this.packetSize = 4 * B + 5;

    // Calibrate: 1 kHz tone at 40 dB SPL ≡ 1 sone / 1 kHz 40 dB SPL = 1 sone 보정
    this.soneScale = 1;
    let b1k = 0;
    for (let b = 0; b < B; b++) if (edges[b] <= 1000 && edges[b + 1] > 1000) b1k = b;
    for (let b = 0; b < B; b++) this.bandI[b] = 0;
    this.bandI[b1k] = Math.pow(10, 40 / 10);
    this.loudnessFromBands();
    this.soneScale = this.totalSone > 0 ? 1 / this.totalSone : 1;
    for (let b = 0; b < B; b++) this.bandI[b] = 0;
    this.loudnessFromBands();
  }

  /** (10^(d/10))^α via LUT + linear interpolation. / LUT 보간 */
  powAlphaDb(d) {
    let x = (d - this.lutMin) / this.lutStep;
    if (x <= 0) return this.powLut[0];
    if (x >= this.lutSize - 1) return this.powLut[this.lutSize - 1];
    const i = x | 0;
    x -= i;
    return this.powLut[i] + (this.powLut[i + 1] - this.powLut[i]) * x;
  }

  setCalibration(fullScaleDbSpl) {
    if (Number.isFinite(fullScaleDbSpl)) this.fullScaleDbSpl = fullScaleDbSpl;
  }

  /** Feed n samples (mono, or the mean of two channels when `b` is given). / 샘플 입력 */
  push(a, b, n) {
    const N1 = this.N - 1;
    const len = n === undefined ? a.length : n;
    for (let i = 0; i < len; i++) {
      const x = b ? 0.5 * (a[i] + b[i]) : a[i];
      const ax = x < 0 ? -x : x;
      if (ax > this.peak) this.peak = ax;
      this.sumSq += x * x;
      this.ring[this.writePos] = x;
      this.writePos = (this.writePos + 1) & N1;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this.analyze();
      }
    }
    this.nSq += len;
  }

  /** Feed n zeros (no input connected). / 무음 입력 */
  pushSilence(n) {
    const N1 = this.N - 1;
    for (let i = 0; i < n; i++) {
      this.ring[this.writePos] = 0;
      this.writePos = (this.writePos + 1) & N1;
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this.analyze();
      }
    }
    this.nSq += n;
  }

  /** Window → FFT → Bark band intensities → loudness. / 분석 1회 */
  analyze() {
    const N = this.N;
    const N1 = N - 1;
    const re = this.re;
    const im = this.im;
    const rev = this.bitrev;
    // windowed copy, oldest sample first, bit-reversed order / 창 적용 + 비트 역순 복사
    for (let n = 0; n < N; n++) {
      const r = rev[n];
      re[r] = this.ring[(this.writePos + n) & N1] * this.win[n];
      im[r] = 0;
    }
    // in-place radix-2 butterflies / 제자리 radix-2
    for (let size = 2; size <= N; size <<= 1) {
      const halfSize = size >> 1;
      const step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0; k < halfSize; k++) {
          const c = this.cosT[k * step];
          const s = this.sinT[k * step];
          const i = start + k;
          const j = i + halfSize;
          const tr = re[j] * c - im[j] * s;
          const ti = re[j] * s + im[j] * c;
          re[j] = re[i] - tr;
          im[j] = im[i] - ti;
          re[i] += tr;
          im[i] += ti;
        }
      }
    }
    // band intensity re 0 dB SPL / 대역 세기 (0 dB SPL 기준)
    const cal = Math.pow(10, this.fullScaleDbSpl / 10) * this.powNorm * 2; // ÷ 0.5 (full-scale sine ms)
    for (let b = 0; b < this.B; b++) {
      let acc = 0;
      for (let k = this.bandStart[b]; k < this.bandEnd[b]; k++) acc += (re[k] * re[k] + im[k] * im[k]) * this.binW[k];
      this.bandI[b] = acc * cal;
    }
    this.loudnessFromBands();
    this.frames++;
  }

  /** Spreading (lerped Low/Mid/High matrices) → masking → specific loudness → Total Sone. */
  loudnessFromBands() {
    const B = this.B;
    const BB = B * B;
    const LN10_10 = 10 / Math.LN10;
    for (let b = 0; b < B; b++) {
      const I = this.bandI[b];
      this.levelDb[b] = I > 1e-12 ? Math.log(I) * LN10_10 : -120;
      this.excI[b] = 0;
    }
    for (let j = 0; j < B; j++) {
      const Ij = this.bandI[j];
      if (!(Ij > 1e-12)) continue;
      let t = (this.levelDb[j] - 40) / 20; // 40 → Low, 60 → Mid, 80 → High
      if (t < 0) t = 0;
      if (t > 2) t = 2;
      const m0 = t >= 1 ? 1 : 0;
      const f = t - m0;
      const o0 = m0 * BB;
      const o1 = o0 + BB;
      for (let i = 0; i < B; i++) {
        const s0 = this.spread[o0 + i * B + j];
        const s1 = this.spread[o1 + i * B + j];
        this.excI[i] += (s0 + (s1 - s0) * f) * Ij;
      }
    }
    let total = 0;
    for (let i = 0; i < B; i++) {
      const E = this.excI[i];
      const eDb = E > 1e-12 ? Math.log(E) * LN10_10 : -120;
      this.excDb[i] = eDb;
      this.maskDb[i] = eDb - (6 + 0.25 * i);
      const ratio = E / Math.pow(10, this.thqDb[i] / 10);
      const inner = 0.5 + 0.5 * ratio;
      const innerPow = this.powAlphaDb(Math.log(inner) * LN10_10);
      let ns = 0.08 * this.etqPow[i] * (innerPow - 1);
      if (!(ns > 0)) ns = 0;
      this.specific[i] = ns * this.soneScale;
      total += ns;
    }
    this.totalSone = total * this.soneScale;
  }

  /**
   * Write the latest frame into `out` (length ≥ packetSize) and reset the peak/RMS window.
   * Layout: [totalSone, peak, rms, fullScaleDbSpl, frames, levelDb×B, excDb×B, maskDb×B, specific×B].
   */
  writePacket(out) {
    const B = this.B;
    out[0] = this.totalSone;
    out[1] = this.peak;
    out[2] = this.nSq > 0 ? Math.sqrt(this.sumSq / this.nSq) : 0;
    out[3] = this.fullScaleDbSpl;
    out[4] = this.frames;
    for (let b = 0; b < B; b++) {
      out[5 + b] = this.levelDb[b];
      out[5 + B + b] = this.excDb[b];
      out[5 + 2 * B + b] = this.maskDb[b];
      out[5 + 3 * B + b] = this.specific[b];
    }
    this.peak = 0;
    this.sumSq = 0;
    this.nSq = 0;
  }
}

/** Decode a packet written by writePacket(). / 패킷 해석 */
export function decodeLoudnessPacket(p, B = 24) {
  return {
    totalSone: p[0],
    peak: p[1],
    rms: p[2],
    fullScaleDbSpl: p[3],
    frames: p[4],
    levelDb: p.subarray(5, 5 + B),
    excDb: p.subarray(5 + B, 5 + 2 * B),
    maskDb: p.subarray(5 + 2 * B, 5 + 3 * B),
    specific: p.subarray(5 + 3 * B, 5 + 4 * B),
  };
}
