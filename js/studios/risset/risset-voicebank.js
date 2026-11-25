/**
 * Flexatone — studios/risset/risset-voicebank.js
 * Risset Studio (pure DSP): sample-accurate voice bank shared by the AudioWorklet (Blob), the
 * offline WAV render and the main-thread self-checks. No DOM, no Web Audio — the class source is
 * shipped into the worklet with `toString()`, so it MUST stay self-contained (a self-check asserts
 * this). Its only outside name is the voice-source kernel it delegates the waveform to (PulseKernel,
 * modules/sources/pulse-kernel.js, ROADMAP D-2): imported here for the main thread, composed into
 * the worklet source next to the bank (modules/sources/kernel-source.js).
 * 리세 스튜디오 (순수 DSP): 워클릿·오프라인·자가진단이 공유하는 샘플 정확 보이스 뱅크.
 * 자기완결이어야 함 (toString()으로 워클릿에 들어감). 외부 이름은 파형을 맡기는 음원 커널(PulseKernel) 하나:
 * 메인 스레드는 import, 워클릿은 뱅크 옆에 함께 조립.
 *
 * Per slot s (a sounding point; classic field: slot i = voice i):
 *   S¹ phase      pₛ[n+1] = wrap(pₛ[n] + (ωₛ + corrₛ)/fs)        ω = dp/dt from the control frame
 *   pitch         fₛ = 440 · 2^((base + pₛ·span − 69)/12)       (sample-accurate wrap)
 *   amplitude     aₛ = scale · gₛ · A_global(pₛ) · W(fₛ)         gₛ linearly interpolated per block
 *   oscillator    ψₛ += fₛ/fs + (K/fs)·r·sin 2π(Ψ − ψₛ)    (Kuramoto mean field weighted by the
 *                 audible amplitude g·A_global; locks only rates within ≈ ±K Hz of each other, A-3)
 *                 y += aₛ · wave(ψₛ),  wave = sine → PolyBLEP pulse (duty) morph, faded back to a
 *                 sine as the harmonic headroom fs/(2f) drops from 20 to 4 (anti-aliasing)
 *   guards        aₛ ·= W(f) (tilt, 12–30 Hz flutter band) · fade above 0.4·fs (Nyquist)
 * Control frames (≈ frame rate live, every 64 samples offline) carry p, ω, g, flags per slot.
 * The bank does not jump to the control phase: the error e = wrapSigned(p_ctrl − p) is spread over
 * CORR_SEC (phase-continuous); |e| > 0.25 or a RESET flag hard-sets p (gain is ~0 then).
 * 제어 위상으로 바로 점프하지 않고 오차를 CORR_SEC 동안 분산 (위상 연속).
 *
 * Global envelope A_global (also used by peq-envelope.js — one implementation):
 *   d = (p − c)/σ_side,  σ_left = σ·(1 − skew), σ_right = σ·(1 + skew)
 *   Bell-Pass 1/(1 + |d|^γ) (γ = 4 default) · Gaussian e^(−d²/2) · Raised Cosine ½ − ½cos(2π·clamp(½ + d/2))
 */
import { PulseKernel } from '../../modules/sources/pulse-kernel.js';
import { composeKernelSource } from '../../modules/sources/kernel-source.js';

export class RissetVoiceBank {
  constructor(sampleRate, maxSlots = 128) {
    this.fs = sampleRate;
    this.max = maxSlots;
    this.p = new Float64Array(maxSlots);
    this.w = new Float64Array(maxSlots);
    this.corr = new Float64Array(maxSlots);
    this.corrLeft = new Int32Array(maxSlots);
    this.g0 = new Float64Array(maxSlots);
    this.g1 = new Float64Array(maxSlots);
    this.psi = new Float64Array(maxSlots);
    // Manager Warp: per-slot pitch shift in semitones (target, smoothed ≈ 10 ms) / 매니저 곡률: 슬롯별 음고 이동
    this.sh = new Float64Array(maxSlots);
    this.shT = new Float64Array(maxSlots);
    this.n = 0;
    this.scale0 = 0;
    this.scale1 = 0;
    this.base = 24;
    this.span = 96;
    this.env = { enabled: true, shape: 'bellpass', center: 0.5, width: 0.24, skew: 0, gamma: 4 };
    this.wave = { morph: 0, duty: 0.5 };
    this.weight = { tilt: 0, flutterDb: 0 };
    this.syncHz = 0; // Kuramoto coupling K on oscillator phases ψ (A-3): > 0 sync, < 0 disperse
    this.r = 0; // measured order parameter |⟨e^{2πiψ}⟩| over sounding slots / 질서 매개변수
    this.fresh = true;
    // Per-voice tremolo / vibrato (core/voice-mod.js; the hash is repeated here — this class must stay self-contained)
    // 보이스별 트레몰로·비브라토 (core/voice-mod.js와 같은 해시를 여기 다시 둠 — 이 클래스는 자기완결이어야 함)
    // { seed, t / v: [on, rate, depth|cents, rateSpread, depthK, phaseSpread, dist, drift, —], tE / vE: band table }
    this.mod = null;
    this.phT = new Float64Array(maxSlots);
    this.phV = new Float64Array(maxSlots);
    this.ru = new Float64Array(maxSlots * 12); // 12 draws per slot: trem 0 1 2 7 8, vib 3 4 5 10 11 / 슬롯당 난수 12개
    this.tSec = 0; // bank clock for the slow rate drift / 표류용 시계
    // per-region modulation: mods[k] for region k, slotReg[i] = region of slot i; ruSlot[i] = seed its draws are for
    // 영역별 변조: 영역 k의 mods[k], 슬롯 i의 영역 slotReg[i], ruSlot[i] = 난수표의 시드
    this.mods = null;
    // per-region waveform / weighting / oscillator sync (null = the shared ones) and the region mean fields
    // 영역별 파형·가중·발진기 동기화 (null = 공유)와 영역별 평균장
    this.regWave = null;
    this.regWeight = null;
    this.regSync = null;
    this.zcR = new Float64Array(8);
    this.zsR = new Float64Array(8);
    this.cntR = new Float64Array(8);
    this.wR = new Float64Array(8);
    this.slotReg = new Uint8Array(maxSlots);
    this.ruSlot = new Float64Array(maxSlots).fill(NaN);
    this.ruSeed = NaN;
    // 4096-point sine table, linear interpolation (|error| < 3e-7) / 사인 테이블
    this.tab = new Float64Array(4097);
    for (let i = 0; i <= 4096; i++) this.tab[i] = Math.sin((2 * Math.PI * i) / 4096);
  }

  sin01(psi) {
    const x = psi * 4096;
    const i = x | 0;
    const t = this.tab;
    return t[i] + (t[i + 1] - t[i]) * (x - i);
  }

  /** Distribution of the rate draw (core/voice-mod.js distU): 0 uniform, 1 center u³, 2 split ±1. / 분포 */
  static distU(d, u) {
    return d === 1 ? u * u * u : d === 2 ? (u < 0 ? -1 : 1) : u;
  }

  /** Band-follow table at band place b ∈ [0, 1] (core/voice-mod.js envAt01). / 대역 추종 표 */
  static env01(tab, b) {
    if (!tab) return 0;
    const n = tab.length;
    const x = (b < 0 ? 0 : b > 1 ? 1 : b) * (n - 1);
    const k = Math.min(n - 2, Math.floor(x));
    return tab[k] + (tab[k + 1] - tab[k]) * (x - k);
  }

  /** u ∈ [−1, 1] for (seed, slot, lane) — identical to voiceRand() in core/voice-mod.js. / 결정적 난수 */
  static voiceRand(seed, i, k) {
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((i | 0) + 1, 0x85ebca77) ^ Math.imul(k + 1, 0xc2b2ae3d)) >>> 0;
    h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295 * 2 - 1;
  }

  static wrapSigned(x) {
    return x - Math.round(x);
  }

  /** Global envelope A_global(p). / 전역 포락선 */
  static envelope(env, p) {
    if (!env || env.enabled === false) return 1;
    const u = p < 0 ? 0 : p > 1 ? 1 : p;
    const c = Math.min(0.95, Math.max(0.05, env.center));
    const w = Math.min(1, Math.max(0.02, env.width));
    const sk = Math.min(0.9, Math.max(-0.9, env.skew || 0));
    const side = u < c ? w * (1 - sk) : w * (1 + sk);
    const d = (u - c) / side;
    if (env.shape === 'gaussian') return Math.exp(-0.5 * d * d);
    if (env.shape === 'cosine') {
      const nu = Math.min(1, Math.max(0, 0.5 + (u - c) / Math.max(0.05, side * 2)));
      return 0.5 - 0.5 * Math.cos(2 * Math.PI * nu);
    }
    const g = env.gamma === undefined ? 4 : env.gamma;
    const ad = Math.abs(d);
    return 1 / (1 + (g === 4 ? ad * ad * ad * ad : Math.pow(ad, g)));
  }

  /** Frequency weight W(f): spectral tilt (dB/oct re 1 kHz) × 12–30 Hz flutter band. / 주파수 가중 */
  static freqWeight(weight, f) {
    let wgt = 1;
    if (weight.tilt) wgt *= Math.pow(2, (weight.tilt / 6.020599913) * Math.log2(Math.max(1e-3, f) / 1000));
    if (weight.flutterDb) {
      // smooth bump over 12–30 Hz in log frequency (1 inside, 0 outside 8–45 Hz)
      const l = Math.log2(Math.max(1e-3, f));
      const lo = Math.log2(12);
      const hi = Math.log2(30);
      const e = 0.585; // ≈ log2(1.5) skirt
      let b = 0;
      if (l >= lo && l <= hi) b = 1;
      else if (l > lo - e && l < lo) b = 0.5 - 0.5 * Math.cos(Math.PI * (l - (lo - e)) / e);
      else if (l > hi && l < hi + e) b = 0.5 + 0.5 * Math.cos(Math.PI * (l - hi) / e);
      if (b > 0) wgt *= Math.pow(10, (weight.flutterDb * b) / 20);
    }
    return wgt;
  }

  /** Fade partials out between 0.40·fs and 0.47·fs (no sine above Nyquist). / 나이퀴스트 보호 */
  static nyquistGuard(f, fs) {
    const lo = 0.4 * fs;
    if (f <= lo) return 1;
    const hi = 0.47 * fs;
    if (f >= hi) return 0;
    return 0.5 + 0.5 * Math.cos(Math.PI * (f - lo) / (hi - lo));
  }

  static polyBlep(t, dt) {
    return PulseKernel.polyBlep(t, dt);
  }

  /**
   * Waveform: sine → band-limited pulse (duty) morph, PolyBLEP — delegated to the shared Pulse source
   * kernel (one implementation for the worklet, the offline render and the native PeriodicWave).
   * 파형: 공용 펄스 음원 커널에 위임 (워클릿·오프라인·네이티브 PeriodicWave가 같은 구현).
   */
  static waveSample(wave, psi, dt) {
    return PulseKernel.sample(wave, psi, dt);
  }

  /**
   * Apply a control frame.
   * frame = { n, scale, base, span, env, wave?, weight?, slots: Float32Array/Array (4 per slot:
   *   p, ω, g, flags) }   flags: 1 = active, 2 = reset (new sounding point)
   */
  setControl(frame) {
    const n = Math.min(this.max, frame.n | 0);
    const corrN = Math.max(1, Math.round(0.05 * this.fs));
    this.base = frame.base;
    this.span = frame.span;
    if (frame.env) this.env = frame.env;
    if (frame.wave) this.wave = frame.wave;
    if (frame.weight) this.weight = frame.weight;
    if (frame.syncHz !== undefined) this.syncHz = frame.syncHz;
    if (frame.mod !== undefined) this.mod = frame.mod || null;
    this.mods = frame.mods || null;
    // per-region output tremolo: { rate Hz, tab: 65-point gain table of one cycle } per region / 영역별 출력 트레몰로
    this.regTrem = frame.regTrem || null;
    this.regWave = frame.regWave || null;
    this.regWeight = frame.regWeight || null;
    this.regSync = frame.regSync || null;
    if (frame.slotRegion) { const sr = frame.slotRegion; for (let i = 0; i < this.max; i++) this.slotReg[i] = i < sr.length ? sr[i] : 0; }
    this.scale1 = frame.scale;
    if (this.fresh) this.scale0 = frame.scale;
    const sl = frame.slots;
    const shift = frame.shift || null;
    for (let i = 0; i < this.max; i++) {
      if (i >= n) { this.g1[i] = 0; this.w[i] = 0; this.shT[i] = 0; continue; }
      this.shT[i] = shift ? +shift[i] || 0 : 0;
      const pc = sl[i * 4];
      const flags = sl[i * 4 + 3];
      this.w[i] = sl[i * 4 + 1];
      this.g1[i] = flags & 1 ? sl[i * 4 + 2] : 0;
      const e = RissetVoiceBank.wrapSigned(pc - this.p[i]);
      if (this.fresh || flags & 2 || Math.abs(e) > 0.25) {
        this.p[i] = pc - Math.floor(pc);
        this.corrLeft[i] = 0;
        this.sh[i] = this.shT[i];
        if (this.fresh) this.g0[i] = this.g1[i];
      } else {
        this.corr[i] = e / corrN;
        this.corrLeft[i] = corrN;
      }
    }
    this.n = Math.max(this.n, n);
    this.fresh = false;
  }

  /** Render `len` samples into out (Float32Array, overwritten). / len 샘플 렌더 */
  process(out, len) {
    const fs = this.fs;
    const inv = 1 / fs;
    const n = this.n;
    const env = this.env;
    const k = Math.log(2) / 12;
    for (let s = 0; s < len; s++) out[s] = 0;
    const sc0 = this.scale0;
    const dsc = (this.scale1 - sc0) / len;
    // Kuramoto mean field over the sounding slots (held for this block) / 블록 단위 평균장
    // weighted by audible amplitude g·A_global(p), so near-silent voices do not dominate r
    // 들리는 진폭으로 가중 (거의 무음인 보이스가 r을 좌우하지 않게)
    let zc = 0;
    let zs = 0;
    let wsum = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      const wgt = this.g1[i] * RissetVoiceBank.envelope(env, this.p[i]);
      if (!(wgt > 1e-4)) continue;
      zs += wgt * this.sin01(this.psi[i]);
      let c = this.psi[i] + 0.25;
      if (c >= 1) c -= 1;
      zc += wgt * this.sin01(c);
      wsum += wgt;
      cnt++;
    }
    if (wsum > 0) { zc /= wsum; zs /= wsum; }
    this.r = cnt > 1 ? Math.sqrt(zc * zc + zs * zs) : cnt;
    const kc0 = cnt > 1 ? this.syncHz * inv : 0;
    const zc0 = zc;
    const zs0 = zs;
    if (this.regSync) {
      // each region's own mean field: its slots sync among themselves / 영역마다 자기 슬롯끼리 동기화
      const zcR = this.zcR;
      const zsR = this.zsR;
      const cntR = this.cntR;
      const wR = this.wR;
      for (let q = 0; q < 8; q++) { zcR[q] = 0; zsR[q] = 0; cntR[q] = 0; wR[q] = 0; }
      for (let i = 0; i < n; i++) {
        const wgt = this.g1[i] * RissetVoiceBank.envelope(env, this.p[i]);
        if (!(wgt > 1e-4)) continue;
        const r = this.slotReg[i] & 7;
        zsR[r] += wgt * this.sin01(this.psi[i]);
        let c = this.psi[i] + 0.25;
        if (c >= 1) c -= 1;
        zcR[r] += wgt * this.sin01(c);
        wR[r] += wgt;
        cntR[r] += 1;
      }
      for (let q = 0; q < 8; q++) if (wR[q] > 0) { zcR[q] /= wR[q]; zsR[q] /= wR[q]; }
    }
    const shA = 1 - Math.exp(-len / (0.01 * fs));
    const TAU = 2 * Math.PI;
    for (let i = 0; i < n; i++) {
      // this slot's timbre and sync: its region's, else the shared ones / 이 슬롯의 음색·동기화: 영역 것, 없으면 공유
      const sr = this.slotReg[i];
      const wave = this.regWave ? this.regWave[sr] || this.wave : this.wave;
      const weight = this.regWeight ? this.regWeight[sr] || this.weight : this.weight;
      const useW = !!(weight.tilt || weight.flutterDb);
      const zc = this.regSync ? this.zcR[sr & 7] : zc0;
      const zs = this.regSync ? this.zsR[sr & 7] : zs0;
      const kc = this.regSync ? (this.cntR[sr & 7] > 1 ? (this.regSync[sr] || 0) * inv : 0) : kc0;
      // this slot's modulation: its region's, else the shared one / 이 슬롯의 변조: 영역 것, 없으면 공유
      const mod = this.mods ? this.mods[this.slotReg[i]] || null : this.mod;
      const rtr = this.regTrem ? this.regTrem[this.slotReg[i]] || null : null; // its region's output tremolo / 영역 출력 트레몰로
      const tOn = !!(mod && mod.t[0]);
      const vOn = !!(mod && mod.v[0]);
      if ((tOn || vOn) && this.ruSlot[i] !== mod.seed) {
        this.ruSlot[i] = mod.seed;
        for (let k = 0; k < 12; k++) this.ru[i * 12 + k] = RissetVoiceBank.voiceRand(mod.seed, i, k);
      }
      const ga = this.g0[i];
      this.sh[i] += (this.shT[i] - this.sh[i]) * shA;
      const base0 = this.base + this.sh[i];
      const gb = this.g1[i];
      // Per-voice modulation of this slot (rate follows the band through p) / 이 슬롯의 보이스별 변조
      let rT = 0; let dT = 0; let oT = 0; let rV = 0; let cV = 0; let oV = 0;
      let aT = 0; let fT = 0; let pT0 = 0; let aV = 0; let fV = 0; let pV0 = 0; // slow rate drift / 속도 표류
      if (tOn || vOn) {
        const u = this.ru;
        const j = i * 12;
        const b01 = this.p[i];
        if (tOn) {
          const q = mod.t;
          rT = q[1] * Math.pow(2, q[3] * RissetVoiceBank.distU(q[6], u[j]) + RissetVoiceBank.env01(mod.tE, b01));
          dT = q[2] * (1 - q[4] * (u[j + 1] + 1));
          oT = q[5] * 0.5 * (u[j + 2] + 1);
          aT = 0.5 * (q[7] || 0);
          fT = 0.1 * (1 + 0.5 * u[j + 7]);
          pT0 = 0.5 * (u[j + 8] + 1);
        }
        if (vOn) {
          const q = mod.v;
          rV = q[1] * Math.pow(2, q[3] * RissetVoiceBank.distU(q[6], u[j + 3]) + RissetVoiceBank.env01(mod.vE, b01));
          cV = (q[2] / 100) * (1 - q[4] * (u[j + 4] + 1));
          oV = q[5] * 0.5 * (u[j + 5] + 1);
          aV = 0.5 * (q[7] || 0);
          fV = 0.1 * (1 + 0.5 * u[j + 10]);
          pV0 = 0.5 * (u[j + 11] + 1);
        }
      }
      const t0s = this.tSec;
      if (ga === 0 && gb === 0) {
        // Silent: keep the S¹ phase moving (no oscillator work) / 무음이어도 위상은 진행
        const used = Math.min(len, this.corrLeft[i]);
        const q = this.p[i] + this.w[i] * inv * len + this.corr[i] * used;
        this.p[i] = q - Math.floor(q);
        this.corrLeft[i] -= used;
        const tm = t0s + 0.5 * len * inv;
        if (rT) { const x = this.phT[i] + rT * (aT ? 1 + aT * Math.sin(TAU * (fT * tm + pT0)) : 1) * inv * len; this.phT[i] = x - Math.floor(x); }
        if (rV) { const x = this.phV[i] + rV * (aV ? 1 + aV * Math.sin(TAU * (fV * tm + pV0)) : 1) * inv * len; this.phV[i] = x - Math.floor(x); }
        continue;
      }
      let phT = this.phT[i];
      let phV = this.phV[i];
      const dg = (gb - ga) / len;
      let p = this.p[i];
      let psi = this.psi[i];
      const w = this.w[i] * inv;
      let cl = this.corrLeft[i];
      const cr = this.corr[i];
      const sineOnly = !(wave.morph > 0);
      // Sub-blocks of ≤ 16 samples with a constant phase increment: frequency steps geometrically,
      // envelope/weight interpolate linearly. A sub-block that crosses the wrap is done per sample.
      // ≤16샘플 하위 블록: 주파수는 기하 보간, 포락선은 선형 보간. 래핑이 있는 하위 블록은 샘플 단위.
      let s = 0;
      while (s < len) {
        let m = Math.min(16, len - s);
        if (cl > 0 && cl < m) m = cl;
        const inc = w + (cl > 0 ? cr : 0);
        // tremolo gain and vibrato shift, held for this sub-block (≤ 16 samples) / 하위 블록 동안 유지
        let tg = 1;
        let base = base0;
        const tm = t0s + s * inv;
        if (rtr) {
          const x = rtr.rate * tm;
          const u = (x - Math.floor(x)) * 64;
          const k = u | 0;
          tg = rtr.tab[k] + (rtr.tab[k + 1] - rtr.tab[k]) * (u - k);
        }
        if (rT) { tg *= 1 - dT * (0.5 - 0.5 * Math.cos(TAU * (phT + oT))); phT += rT * (aT ? 1 + aT * Math.sin(TAU * (fT * tm + pT0)) : 1) * inv * m; phT -= Math.floor(phT); }
        if (rV) { base = base0 + cV * Math.sin(TAU * (phV + oV)); phV += rV * (aV ? 1 + aV * Math.sin(TAU * (fV * tm + pV0)) : 1) * inv * m; phV -= Math.floor(phV); }
        const pEnd = p + inc * m;
        if (pEnd >= 1 || pEnd < 0) {
          for (let q = 0; q < m; q++, s++) {
            p += inc;
            if (p >= 1) p -= Math.floor(p);
            else if (p < 0) p -= Math.floor(p);
            const f = 440 * Math.exp((base + p * this.span - 69) * k);
            const dt = f * inv;
            psi += dt;
            if (psi >= 1) psi -= Math.floor(psi);
            if (kc !== 0) {
              // dψ/dt = f + K·(Zs·cos 2πψ − Zc·sin 2πψ) = f + K·r·sin 2π(Ψ − ψ)
              let c = psi + 0.25;
              if (c >= 1) c -= 1;
              psi += kc * (zs * this.sin01(c) - zc * this.sin01(psi));
              if (psi < 0) psi += 1;
              else if (psi >= 1) psi -= 1;
            }
            let a = tg * (ga + dg * s) * (sc0 + dsc * s) * RissetVoiceBank.envelope(env, p) * RissetVoiceBank.nyquistGuard(f, fs);
            if (useW) a *= RissetVoiceBank.freqWeight(weight, f);
            if (a !== 0) out[s] += a * (sineOnly ? this.sin01(psi) : RissetVoiceBank.waveSample(wave, psi, dt));
          }
        } else {
          const fA = 440 * Math.exp((base + (p + inc) * this.span - 69) * k);
          const ratio = Math.exp(inc * this.span * k);
          const fB = 440 * Math.exp((base + pEnd * this.span - 69) * k);
          let eA = RissetVoiceBank.envelope(env, p + inc) * RissetVoiceBank.nyquistGuard(fA, fs);
          let eB = RissetVoiceBank.envelope(env, pEnd) * RissetVoiceBank.nyquistGuard(fB, fs);
          if (useW) {
            eA *= RissetVoiceBank.freqWeight(weight, fA);
            eB *= RissetVoiceBank.freqWeight(weight, fB);
          }
          const de = m > 1 ? (eB - eA) / (m - 1) : 0;
          let f = fA;
          let e = eA;
          for (let q = 0; q < m; q++, s++) {
            const dt = f * inv;
            psi += dt;
            if (psi >= 1) psi -= Math.floor(psi);
            if (kc !== 0) {
              // dψ/dt = f + K·(Zs·cos 2πψ − Zc·sin 2πψ) = f + K·r·sin 2π(Ψ − ψ)
              let c = psi + 0.25;
              if (c >= 1) c -= 1;
              psi += kc * (zs * this.sin01(c) - zc * this.sin01(psi));
              if (psi < 0) psi += 1;
              else if (psi >= 1) psi -= 1;
            }
            const a = tg * (ga + dg * s) * (sc0 + dsc * s) * e;
            if (a !== 0) out[s] += a * (sineOnly ? this.sin01(psi) : RissetVoiceBank.waveSample(wave, psi, dt));
            f *= ratio;
            e += de;
          }
          p = pEnd;
        }
        if (cl > 0) cl = Math.max(0, cl - m);
      }
      this.p[i] = p;
      this.psi[i] = psi;
      this.phT[i] = phT;
      this.phV[i] = phV;
      this.corrLeft[i] = cl;
      this.g0[i] = gb;
    }
    for (let i = n; i < this.max; i++) this.g0[i] = this.g1[i];
    this.tSec += len * inv;
    this.scale0 = this.scale1;
    for (let s = 0; s < len; s++) out[s] = out[s] > 0.98 ? 0.98 : out[s] < -0.98 ? -0.98 : out[s];
  }
}

/** Classes the worklet needs: the bank + the source kernels it calls. / 워클릿에 필요한 클래스 */
export const RISSET_KERNELS = Object.freeze([RissetVoiceBank, PulseKernel]);

/** Worklet source: the bank class + its kernels + a thin processor (Blob). / 워클릿 소스 */
export const RISSET_PROCESSOR = 'fx-risset-bank';
export function buildRissetWorkletSource() {
  return `${composeKernelSource(RISSET_KERNELS)}
class FxRissetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.bank = new RissetVoiceBank(sampleRate, o.maxSlots || 128);
    if (o.initial) this.bank.setControl(o.initial);
    this.queue = [];
    this.tick = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'control') this.queue.push(m.frame);
      else if (m && m.type === 'stop') this.alive = false;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (this.queue.length) { this.bank.setControl(this.queue[this.queue.length - 1]); this.queue.length = 0; }
    this.bank.process(out, out.length);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    if (++this.tick >= 40) { this.tick = 0; this.port.postMessage({ type: 'r', r: this.bank.r }); }
    return this.alive;
  }
}
registerProcessor('${RISSET_PROCESSOR}', FxRissetProcessor);
`;
}
