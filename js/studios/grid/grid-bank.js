/**
 * Flexatone — studios/grid/grid-bank.js
 * Grid Studio (pure DSP): the additive bank shared by the AudioWorklet (Blob), the offline WAV render
 * and the main-thread self-checks. No imports, no DOM, no Web Audio — the class source is shipped into
 * the worklet with `GridBank.toString()`, so it MUST stay self-contained.
 * 그리드 스튜디오 (순수 DSP): 워클릿·오프라인 렌더·자가진단이 공유하는 가산 뱅크. import 없이 자기완결
 * (toString()으로 워클릿에 들어감).
 *
 *   voice v        = one layer × one chromatic channel: it reads its layer's amplitude matrix
 *                    M[frame][bin] (shared between the channels of a layer) with ITS OWN frequency
 *                    table f_bin · ratio_v and its own time offset (a shift of the read index).
 *                    보이스 = 레이어 × 크로매틱 채널: 같은 행렬을 자기 주파수 표(f_bin·ratio)와 시간 오프셋으로 읽음.
 *   partial (v, i) fixed frequency, phase accumulator kept inside the bank (never reset by amplitude
 *                    changes → phase-continuous), amplitude linear inside a block (a0 → a1), waveform =
 *                    a single-cycle table (per wave set: 6 mip levels of 32, 16, … 1 harmonics, chosen
 *                    so that every harmonic stays below 0.45·fs).
 *   sparse         only the candidate bins of a layer (bins that are non-zero somewhere, sent from the
 *                    main thread) are visited; silent partials cost one comparison.
 *   budget         more than `maxActive` sounding partials in a block → the weakest are faded out
 *                    (amplitude histogram, no sorting, no allocation).
 *   noise          per layer a coloured noise bus (seeded xorshift → 11 pole/zero sections, any slope
 *                    in dB/oct, unit RMS) and per partial a narrow-band part: amplitude · (√(1 − n) +
 *                    √n · m(t)), m = low-passed noise of unit RMS (DSB sidebands of ± bandwidth).
 *   output         L/R = softclip(scale · Σ), |out| ≤ 0.98
 * Nothing is allocated in process(): every buffer is created in the constructor.
 * process() 안에서는 할당 없음 — 모든 버퍼는 생성자에서 만듦.
 */
export class GridBank {
  static get MAXV() { return 12; }
  static get MAXL() { return 4; }
  static get MIPS() { return 6; }
  static get TL() { return 2048; }
  static get SECTIONS() { return 11; }

  /**
   * @param {number} sampleRate
   * @param {{ bins:number, frames:number, frameRate:number, nSets?:number }} o plus everything configure() takes
   */
  constructor(sampleRate, o) {
    const N = o.bins;
    const V = GridBank.MAXV;
    const Lm = GridBank.MAXL;
    this.fs = sampleRate;
    this.N = N;
    this.frames = o.frames;
    this.rate = o.frameRate;
    this.M = [];
    this.cand = [];
    this.nc = new Int32Array(Lm);
    for (let l = 0; l < Lm; l++) { this.M.push(new Float32Array(o.frames * N)); this.cand.push(new Int32Array(N)); }
    this.inc = new Float64Array(V * N);
    this.ph = new Float64Array(V * N);
    this.a0 = new Float32Array(V * N);
    this.a1 = new Float32Array(V * N);
    this.tabOff = new Int32Array(V * N);
    this.amC = new Float32Array(V * N);
    this.amS = new Float32Array(V * N);
    this.am = new Float32Array(V * N);
    this.vLayer = new Int32Array(V);
    this.vGl = new Float32Array(V);
    this.vGr = new Float32Array(V);
    this.vOff = new Float64Array(V);
    this.vTone = new Float32Array(V);
    this.vNz = new Float32Array(V);
    this.nV = 0;
    this.nL = 0;
    this.hist = new Int32Array(64);
    this.nSets = Math.max(1, o.nSets || 1);
    const TL1 = GridBank.TL + 1;
    this.wav = new Float32Array(GridBank.MAXV * GridBank.MIPS * TL1);
    for (let k = 0; k < GridBank.MAXV * GridBank.MIPS; k++) for (let j = 0; j < TL1; j++) this.wav[k * TL1 + j] = Math.sin((2 * Math.PI * j) / GridBank.TL);
    // noise buses / 노이즈 버스
    const S = GridBank.SECTIONS;
    this.nAmp = new Float32Array(Lm);
    this.nGl = new Float32Array(Lm);
    this.nGr = new Float32Array(Lm);
    this.nA = new Float64Array(Lm * S);
    this.nB = new Float64Array(Lm * S);
    this.nZ = new Float64Array(Lm * 2 * S);
    this.nRng = new Int32Array(Lm * 2);
    this.amRng = 0x2545f491;
    this.scale = 0.2;
    this.maxActive = 600;
    this.fresh = true;
    this.lastActive = 0;
    this.lastCount = 0;
    this.started = false;
    this.configure(o);
    this.started = true;
  }

  /** u ∈ [0, 1) for (seed, a, b). / 결정적 난수 */
  static hash(seed, a, b) {
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((a | 0) + 1, 0x85ebca77) ^ Math.imul((b | 0) + 1, 0xc2b2ae3d)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /**
   * Voices, noise buses, level and budget (not called from process). Phases are seeded once, at
   * construction, and kept across later calls (an edit while playing never clicks).
   * 보이스·노이즈·레벨·예산 설정 (process에서 호출하지 않음). 위상은 생성 시 한 번만 시드.
   * @param {{ freqs?:ArrayLike<number>, voices?:Array<{layer:number, ratio:number, gl:number, gr:number, off:number, set:number, n:number, bw:number}>,
   *           layers?:Array<{gl:number, gr:number, noise:{floor:number, slope:number, seed:number}|null}>, scale?:number, maxActive?:number, seed?:number }} o
   */
  configure(o) {
    const N = this.N;
    const fs = this.fs;
    const TL1 = GridBank.TL + 1;
    if (o.freqs) this.freqs = Float64Array.from(o.freqs);
    if (o.scale !== undefined) this.scale = o.scale;
    if (o.maxActive !== undefined) this.maxActive = o.maxActive;
    if (o.voices && this.freqs) {
      const nV = Math.min(GridBank.MAXV, o.voices.length);
      const blockRate = fs / 128;
      for (let v = 0; v < nV; v++) {
        const q = o.voices[v];
        this.vLayer[v] = q.layer;
        this.vGl[v] = q.gl;
        this.vGr[v] = q.gr;
        this.vOff[v] = q.off || 0;
        const n = Math.min(1, Math.max(0, q.n || 0));
        this.vTone[v] = Math.sqrt(1 - n);
        this.vNz[v] = Math.sqrt(n);
        const set = Math.min(GridBank.MAXV - 1, Math.max(0, q.set | 0));
        const bw = Math.pow(2, (q.bw || 40) / 1200) - 1;
        for (let i = 0; i < N; i++) {
          const j = v * N + i;
          const f = this.freqs[i] * q.ratio;
          const maxH = Math.floor((0.45 * fs) / Math.max(1e-9, f));
          if (!(f > 0) || maxH < 1) { this.inc[j] = 0; continue; }
          this.inc[j] = f / fs;
          // mip level: the most harmonics that still fit below 0.45·fs / 0.45·fs 아래에 들어가는 최대 배음 수
          let m = 0;
          while (m < GridBank.MIPS - 1 && (32 >> m) > maxH) m++;
          this.tabOff[j] = (set * GridBank.MIPS + m) * TL1;
          const c = Math.exp((-2 * Math.PI * Math.min(f * bw, blockRate / 4)) / blockRate);
          this.amC[j] = c;
          this.amS[j] = Math.sqrt(1 - c * c);
          if (!this.started) this.ph[j] = GridBank.hash(o.seed || 1, v, i);
        }
      }
      // voices that disappeared stop at once (their amplitudes are cleared) / 사라진 보이스는 즉시 정지
      for (let v = nV; v < this.nV; v++) for (let i = 0; i < N; i++) { this.a0[v * N + i] = 0; this.a1[v * N + i] = 0; }
      this.nV = nV;
    }
    if (o.layers) {
      const S = GridBank.SECTIONS;
      this.nL = Math.min(GridBank.MAXL, o.layers.length);
      for (let l = 0; l < GridBank.MAXL; l++) {
        const q = l < this.nL ? o.layers[l] : null;
        const nz = q && q.noise && q.noise.floor > 0 ? q.noise : null;
        this.nAmp[l] = 0;
        if (!nz) continue;
        this.nGl[l] = q.gl;
        this.nGr[l] = q.gr;
        // slope s dB/oct → power ∝ f^(−γ), γ = −s / 3.0103. One pole per octave from 15 Hz, each
        // followed by a zero γ/2 octaves above it: the staircase follows the slope within ±0.3 dB.
        // 기울기 s dB/oct: 옥타브마다 극 하나, 그 γ/2 옥타브 위에 영점 → 계단이 기울기를 ±0.3 dB 안에서 따라감
        const gamma = -nz.slope / 3.0103;
        for (let k = 0; k < S; k++) {
          const fp = 15 * Math.pow(2, k);
          const fz = Math.min(0.49 * fs, fp * Math.pow(2, gamma / 2));
          this.nA[l * S + k] = Math.exp((-2 * Math.PI * Math.min(0.49 * fs, fp)) / fs);
          this.nB[l * S + k] = Math.exp((-2 * Math.PI * fz) / fs);
        }
        // unit RMS for white input: 1 / √(mean |H|²) / 백색 입력에 대해 RMS 1
        let acc = 0;
        const P = 2048;
        for (let w = 0; w < P; w++) {
          const co = Math.cos((Math.PI * (w + 0.5)) / P);
          let h2 = 1;
          for (let k = 0; k < S; k++) {
            const a = this.nA[l * S + k];
            const b = this.nB[l * S + k];
            h2 *= (1 - 2 * b * co + b * b) / (1 - 2 * a * co + a * a);
          }
          acc += h2;
        }
        this.nAmp[l] = nz.floor / Math.sqrt(acc / P);
        if (!this.started || this.nRng[l * 2] === 0) {
          this.nRng[l * 2] = (Math.imul((nz.seed | 0) + 1, 0x9e3779b1) ^ 0x1234567) | 1;
          this.nRng[l * 2 + 1] = (Math.imul((nz.seed | 0) + 7, 0x85ebca77) ^ 0x7654321) | 1;
        }
      }
    }
  }

  /** Replace the single-cycle tables (sets × 6 mip levels × 2049 samples). / 파형 테이블 교체 */
  setWaves(buf) {
    this.wav.set(buf.length > this.wav.length ? buf.subarray(0, this.wav.length) : buf);
  }

  /** Copy rows starting at frame0 into a layer's control matrix. / 레이어 제어 행렬에 청크 복사 */
  setChunk(layer, frame0, data) {
    const M = this.M[layer];
    const off = frame0 * this.N;
    if (!M || off < 0 || off + data.length > M.length) return false;
    M.set(data, off);
    return true;
  }

  /** Candidate bins of a layer (bins that are non-zero somewhere). union = keep the old ones too. / 후보 빈 목록 */
  setCand(layer, list, union) {
    const c = this.cand[layer];
    if (!c) return;
    if (!union) { c.set(list); this.nc[layer] = list.length; return; }
    // merge two ascending lists in place from the back (no allocation) / 뒤에서부터 제자리 병합
    let a = this.nc[layer] - 1;
    let b = list.length - 1;
    let total = 0;
    for (let x = a, y = b; x >= 0 || y >= 0;) { if (x >= 0 && y >= 0 && c[x] === list[y]) { x--; y--; } else if (y < 0 || (x >= 0 && c[x] > list[y])) x--; else y--; total++; }
    let w = total - 1;
    while (w >= 0) {
      if (a >= 0 && b >= 0 && c[a] === list[b]) { c[w--] = c[a]; a--; b--; } else if (b < 0 || (a >= 0 && c[a] > list[b])) c[w--] = c[a--]; else c[w--] = list[b--];
    }
    this.nc[layer] = total;
  }

  /** Restart the amplitude interpolation at the next block (after a seek). / 탐색 후 재시작 */
  seek() {
    this.fresh = true;
  }

  /**
   * Render `len` samples. f0 / f1 = frame positions at the first sample and one past the last.
   * Allocation-free: only the arrays created in the constructor are touched.
   * len 샘플 렌더. f0 / f1 = 블록 처음과 끝의 프레임 위치. 할당 없음.
   */
  process(outL, outR, len, f0, f1) {
    const N = this.N;
    const frames = this.frames;
    const a0 = this.a0;
    const a1 = this.a1;
    const inc = this.inc;
    const hist = this.hist;
    const TL = 2048;
    for (let s = 0; s < len; s++) { outL[s] = 0; outR[s] = 0; }
    for (let b = 0; b < 64; b++) hist[b] = 0;
    // 1) target amplitudes of every candidate partial + how many sound / 목표 진폭과 소리 나는 부분음 수
    let count = 0;
    for (let v = 0; v < this.nV; v++) {
      const L = this.vLayer[v];
      const M = this.M[L];
      const cand = this.cand[L];
      const nc = this.nc[L];
      const base = v * N;
      const g = this.vGl[v] > this.vGr[v] ? this.vGl[v] : this.vGr[v];
      if (this.fresh) {
        const fa = f0 + this.vOff[v];
        if (fa >= 0 && fa <= frames - 1) {
          const fi = Math.floor(fa);
          const fr = fa - fi;
          const r0 = fi * N;
          const r1 = (fi + 1 < frames ? fi + 1 : fi) * N;
          for (let c = 0; c < nc; c++) { const i = cand[c]; a0[base + i] = M[r0 + i] + (M[r1 + i] - M[r0 + i]) * fr; }
        } else for (let c = 0; c < nc; c++) a0[base + cand[c]] = 0;
      }
      const fb = f1 + this.vOff[v];
      const ok = fb >= 0 && fb <= frames - 1;
      const fi = ok ? Math.floor(fb) : 0;
      const fr = fb - fi;
      const r0 = fi * N;
      const r1 = (fi + 1 < frames ? fi + 1 : fi) * N;
      for (let c = 0; c < nc; c++) {
        const i = cand[c];
        const a = ok ? M[r0 + i] + (M[r1 + i] - M[r0 + i]) * fr : 0;
        a1[base + i] = a;
        const w = (a0[base + i] > a ? a0[base + i] : a) * g;
        if (w > 1e-6 && inc[base + i] > 0) {
          count++;
          let b = Math.floor((Math.log2(w) + 20) * 3);
          b = b < 0 ? 0 : b > 63 ? 63 : b;
          hist[b]++;
        }
      }
    }
    this.fresh = false;
    // 2) budget: weakest first / 예산: 약한 것부터 제외
    let thr = 0;
    if (count > this.maxActive) {
      let acc = 0;
      for (let b = 63; b >= 0; b--) {
        acc += hist[b];
        if (acc > this.maxActive) { thr = Math.pow(2, (b + 1) / 3 - 20); break; }
      }
    }
    // 3) synthesis / 합성
    const wav = this.wav;
    const inv = 1 / len;
    let kept = 0;
    for (let v = 0; v < this.nV; v++) {
      const L = this.vLayer[v];
      const cand = this.cand[L];
      const nc = this.nc[L];
      const base = v * N;
      const gl = this.vGl[v];
      const gr = this.vGr[v];
      const g = gl > gr ? gl : gr;
      const tone = this.vTone[v];
      const nz = this.vNz[v];
      for (let c = 0; c < nc; c++) {
        const j = base + cand[c];
        const ga = a0[j];
        let gb = a1[j];
        const dph = inc[j];
        if (dph === 0 || (ga <= 1e-6 && gb <= 1e-6)) { a0[j] = gb <= 1e-6 ? 0 : gb; continue; }
        if ((ga > gb ? ga : gb) * g < thr) {
          gb = 0; // over budget: fade out inside this block (never a step) / 예산 초과: 이 블록 안에서 페이드아웃
          if (ga <= 1e-6) { a0[j] = 0; continue; }
        } else kept++;
        const dg = (gb - ga) * inv;
        const off = this.tabOff[j];
        let ph = this.ph[j];
        if (nz > 0) {
          const m0 = this.am[j];
          let r = this.amRng;
          r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
          this.amRng = r;
          const m1 = this.amC[j] * m0 + this.amS[j] * (((r >>> 0) * 2.3283064365386963e-10) * 2 - 1) * 1.7320508;
          this.am[j] = m1;
          const dm = (m1 - m0) * inv;
          for (let s = 0; s < len; s++) {
            const x = ph * TL;
            const k = x | 0;
            const t = wav[off + k];
            const val = (ga + dg * s) * (tone + nz * (m0 + dm * s)) * (t + (wav[off + k + 1] - t) * (x - k));
            outL[s] += val * gl;
            outR[s] += val * gr;
            ph += dph;
            if (ph >= 1) ph -= 1;
          }
        } else {
          for (let s = 0; s < len; s++) {
            const x = ph * TL;
            const k = x | 0;
            const t = wav[off + k];
            const val = (ga + dg * s) * (t + (wav[off + k + 1] - t) * (x - k));
            outL[s] += val * gl;
            outR[s] += val * gr;
            ph += dph;
            if (ph >= 1) ph -= 1;
          }
        }
        this.ph[j] = ph;
        a0[j] = gb;
      }
    }
    this.lastActive = kept;
    this.lastCount = count;
    // 4) coloured noise buses, only inside the timeline / 색 노이즈 버스 (타임라인 안에서만)
    if (f1 >= 0 && f0 <= frames - 1) {
      const S = 11;
      for (let l = 0; l < this.nL; l++) {
        const amp = this.nAmp[l];
        if (!(amp > 0)) continue;
        const nA = this.nA;
        const nB = this.nB;
        const nZ = this.nZ;
        for (let ch = 0; ch < 2; ch++) {
          const out = ch === 0 ? outL : outR;
          const gch = amp * (ch === 0 ? this.nGl[l] : this.nGr[l]);
          const zo = (l * 2 + ch) * S;
          let r = this.nRng[l * 2 + ch];
          for (let s = 0; s < len; s++) {
            r ^= r << 13; r ^= r >>> 17; r ^= r << 5;
            let x = (((r >>> 0) * 2.3283064365386963e-10) * 2 - 1) * 1.7320508;
            for (let k = 0; k < S; k++) {
              // direct form II transposed: y = x + z; z = a·y − b·x / 1차 섹션
              const y = x + nZ[zo + k];
              nZ[zo + k] = nA[l * S + k] * y - nB[l * S + k] * x;
              x = y;
            }
            out[s] += x * gch;
          }
          this.nRng[l * 2 + ch] = r;
        }
      }
    }
    // 5) level + soft clip (linear below 0.8, tanh knee, never above 0.98) / 레벨과 소프트 클립
    const sc = this.scale;
    for (let s = 0; s < len; s++) {
      let a = outL[s] * sc;
      let b = outR[s] * sc;
      if (a > 0.8) a = 0.8 + 0.1799 * Math.tanh((a - 0.8) / 0.18); else if (a < -0.8) a = -0.8 - 0.1799 * Math.tanh((-a - 0.8) / 0.18);
      if (b > 0.8) b = 0.8 + 0.1799 * Math.tanh((b - 0.8) / 0.18); else if (b < -0.8) b = -0.8 - 0.1799 * Math.tanh((-b - 0.8) / 0.18);
      outL[s] = a;
      outR[s] = b;
    }
  }
}

/** Worklet source: the bank class + a thin processor (Blob). / 워클릿 소스 */
export const GRID_PROCESSOR = 'fx-grid-bank';
export function buildGridWorkletSource() {
  return `${GridBank.toString()}
class FxGridProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.bank = new GridBank(sampleRate, o);
    if (o.waves) this.bank.setWaves(o.waves);
    if (o.matrices) for (let l = 0; l < o.matrices.length; l++) this.bank.setChunk(l, 0, o.matrices[l]);
    if (o.cands) for (let l = 0; l < o.cands.length; l++) this.bank.setCand(l, o.cands[l], false);
    this.from = o.fromFrame || 0;
    this.t0 = o.startTime || 0;
    this.k = o.frameRate / sampleRate;
    this.scratch = new Float32Array(128);
    this.alive = true;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'chunk') { this.bank.setChunk(m.layer, m.frame0, m.data); if (m.last) this.port.postMessage({ type: 'loaded', id: m.id }); }
      else if (m.type === 'cand') this.bank.setCand(m.layer, m.list, !!m.union);
      else if (m.type === 'config') this.bank.configure(m);
      else if (m.type === 'waves') this.bank.setWaves(m.buf);
      else if (m.type === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out.length > 1 ? out[1] : (this.scratch.length >= L.length ? this.scratch : L);
    const rel = currentFrame - this.t0 * sampleRate;
    const f0 = rel < 0 ? -1e9 : this.from + rel * this.k;
    this.bank.process(L, R, L.length, f0, rel < 0 ? -1e9 : f0 + L.length * this.k);
    if (++this.blocks % 96 === 0) this.port.postMessage({ type: 'stat', active: this.bank.lastActive, count: this.bank.lastCount });
    return this.alive;
  }
}
registerProcessor('${GRID_PROCESSOR}', FxGridProcessor);
`;
}
