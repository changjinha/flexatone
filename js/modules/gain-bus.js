/**
 * Flexatone — modules/gain-bus.js
 * Layer 1 (modules): per-voice gain envelopes and the master loudness bus (pure math).
 * 계층 1 (modules): 보이스별 게인 엔벨로프와 마스터 라우드니스 버스 (순수 계산).
 *
 * Signal flow / 신호 흐름
 *   envelope y(t) ∈ [0,1]        ← Points spline  |  Engine curve (+ ampMin/ampMax, autoFit)
 *   → envelopeToAmp(y, gainUnit) ← 'amp' linear | 'db' (y spans ENVELOPE_DB_RANGE dB) | 'sone'
 *   → × voice.baseGain            = instantaneous voice amplitude
 *   → evaluateMasterBusGain()     = compensation (Σ / 1/√N / sone-normalize) × master × peak safety
 *
 * Imports: core/*, modules/curve-engine.js. No DOM / Audio APIs.
 */

import { clamp, evalPiecewiseBezierPoints } from '../core/math-utils.js';
import {
  ampToSone,
  dbToAmp,
  soneToAmp,
  convertGain,
  clampBaseGain,
  ampToDb,
  GAIN_UNITS,
  AMP_FLOOR,
  createDbTaper,
  DB_TAPERS,
} from '../core/units.js';
import { createDefaultVoice, registerSelfCheck } from '../core/state.js';
import { clipTnToU, clipFullSpan } from '../core/line-clip.js';
import { evaluateCurveObjectY, regionWindow, regionRampNorm } from './curve-engine.js';

/** dB span represented by an envelope y∈(0,1] when gainUnit = 'db' (y=1 → 0 dB, y→0 → −60 dB). */
export const ENVELOPE_DB_RANGE = 60;

/** Exponent k in sone ∝ amp^k (from +10 dB = ×2 loudness): k = 2·log₁₀2 ≈ 0.602. */
export const SONE_EXPONENT = 2 * Math.log10(2);

// ==========================================================================
// 1. Per-voice envelope / 보이스 엔벨로프
// ==========================================================================

/**
 * Raw min/max of a gain-engine curve, unioned with [0,1]. Used by autoFit so overshooting
 * engines (damped, bounce…) are rescaled into ampMin…ampMax instead of clipping.
 * 게인 엔진 곡선의 원시 범위 ([0,1]과 합집합) — autoFit에서 잘림 대신 재스케일.
 * @returns {{ effMin: number, effMax: number, rawMin: number, rawMax: number }}
 */
export function getGainEngineRange(gainObj, samples = 160) {
  let rawMin = Infinity;
  let rawMax = -Infinity;
  if (gainObj) {
    for (let i = 0; i <= samples; i++) {
      const y = evaluateCurveObjectY(gainObj, i / samples);
      if (y < rawMin) rawMin = y;
      if (y > rawMax) rawMax = y;
    }
  }
  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) return { effMin: 0, effMax: 1, rawMin: 0, rawMax: 1 };
  return { effMin: Math.min(0, rawMin), effMax: Math.max(1, rawMax), rawMin, rawMax };
}

/**
 * Envelope value y∈[0,1] of a voice at normalized time (baseGain NOT applied).
 *   gainMode 'points': piecewise Bézier gainPoints, clamped to [0,1]; no points → 1.
 *   gainMode 'engine': lo + yFit·(hi − lo) where lo/hi = ampMin/ampMax ∈ [0,1] and
 *                      yFit = autoFit ? (y − effMin)/(effMax − effMin) : y.
 * 정규화 시간의 엔벨로프 값 (baseGain 미적용).
 * @param {object} v voice
 * @param {number} tNorm clamped to [0,1]
 * @param {{ range?: {effMin:number, effMax:number} }} [opts] precomputed getGainEngineRange
 */
export function evaluateVoiceGainAtNormT(v, tNorm, opts = {}) {
  // The envelope belongs to the whole curve: a trimmed line plays its part of it (core/line-clip.js)
  // 엔벨로프는 곡선 전체의 것: 잘린 선은 그 부분을 재생
  const tc = clamp(v?.clip ? clipTnToU(v, tNorm) : Number.isFinite(tNorm) ? tNorm : 0, 0, 1);
  if (v?.gainMode === 'engine' && v.gainEngineObj) {
    const g = v.gainEngineObj;
    const lo = clamp(Number.isFinite(Number(g.ampMin)) ? Number(g.ampMin) : 0, 0, 1);
    const hi = clamp(Number.isFinite(Number(g.ampMax)) ? Number(g.ampMax) : 1, 0, 1);
    const y = evaluateCurveObjectY(g, tc);
    let yFit = y;
    if (g.autoFit !== false) {
      const r = opts.range || getGainEngineRange(g);
      const span = r.effMax - r.effMin;
      // clamp: the range is sampled, so peaks between samples could otherwise exceed ampMax
      // 범위는 샘플 기반이므로 샘플 사이 피크가 ampMax를 넘지 않도록 제한
      yFit = clamp(span > 1e-9 ? (y - r.effMin) / span : y, 0, 1);
    }
    return clamp(lo + yFit * (hi - lo), 0, 1);
  }
  const pts = v?.gainPoints;
  if (!Array.isArray(pts) || !pts.length) return 1;
  return clamp(evalPiecewiseBezierPoints(pts, tc), 0, 1);
}

/**
 * Interpret an envelope value in the voice's gain unit and return linear amplitude.
 *   'amp' : y
 *   'db'  : y = 1 → 0 dB, y = 0 → silence, linear in dB in between (−dbRange…0)
 *   'sone': y is loudness in sones (1 sone ≡ 0 dBFS) → perceptually linear fades
 * 엔벨로프 값을 게인 단위에 따라 선형 진폭으로 변환.
 */
const taperCache = new Map();
/** Cached dB taper for an envelope (dbMin, taper mode). / 엔벨로프용 dB 테이퍼 (캐시) */
export function envelopeTaper(dbRange = ENVELOPE_DB_RANGE, taper = 'linear') {
  const key = `${dbRange}|${taper}`;
  let tp = taperCache.get(key);
  if (!tp) {
    tp = createDbTaper({ dbMin: -Math.abs(dbRange), dbMax: 0, mode: DB_TAPERS.includes(taper) ? taper : 'linear' });
    if (taperCache.size > 64) taperCache.clear();
    taperCache.set(key, tp);
  }
  return tp;
}

export function envelopeToAmp(y, unit = 'amp', { dbRange = ENVELOPE_DB_RANGE, dbTaper = 'linear' } = {}) {
  const yc = clamp(Number.isFinite(y) ? y : 0, 0, 1);
  if (unit === 'db') return envelopeTaper(dbRange, dbTaper).normToAmp(yc);
  if (unit === 'sone') return soneToAmp(yc);
  return yc;
}

/** Inverse of envelopeToAmp (amp ≤ 1). / envelopeToAmp의 역함수 */
export function ampToEnvelope(amp, unit = 'amp', { dbRange = ENVELOPE_DB_RANGE, dbTaper = 'linear' } = {}) {
  const a = clamp(Number.isFinite(amp) ? amp : 0, 0, 1);
  if (unit === 'db') return envelopeTaper(dbRange, dbTaper).ampToNorm(a);
  if (unit === 'sone') return clamp(ampToSone(a), 0, 1);
  return a;
}

/** Envelope options of a voice (dB taper A/B, dBmin). / 보이스의 엔벨로프 단위 옵션 */
export function voiceEnvelopeOpts(v) {
  return { dbRange: Math.abs(Number.isFinite(v?.dbMin) ? v.dbMin : -ENVELOPE_DB_RANGE), dbTaper: v?.dbTaper === 'daw' ? 'daw' : 'linear' };
}

/** Instantaneous linear amplitude of a voice: baseGain × envelopeToAmp(envelope). */
export function evaluateVoiceAmplitudeAtNormT(v, tNorm, opts = {}) {
  const env = evaluateVoiceGainAtNormT(v, tNorm, opts);
  const unit = GAIN_UNITS.includes(v?.gainUnit) ? v.gainUnit : 'amp';
  const amp = clampBaseGain(Number(v?.baseGain)) * envelopeToAmp(env, unit, { ...voiceEnvelopeOpts(v), ...opts });
  return opts.regions === false ? amp : amp * evaluateRegionAmpFactor(v, v?.clip ? clamp(clipTnToU(v, tNorm), 0, 1) : tNorm);
}

/** Shortest amplitude edge fade of a region, even with ramp 'off' (click guard). */
export const REGION_MIN_FADE_SEC = 0.004;

/** True when any region of the voice is soloed. / 솔로 구간 보유 여부 */
export function voiceHasSoloRegion(v) {
  return Array.isArray(v?.regions) && v.regions.some((r) => r && r.solo);
}

/**
 * Amplitude factor of a voice's regions at tNorm: Mute → ×(1 − w), Gain dB → ×lerp(1, gain, w),
 * Solo → only soloed regions sound. Edges always fade (≥ 4 ms) so mute/solo never click.
 * 구간 진폭 계수: 뮤트·게인·솔로 (경계는 항상 최소 4 ms 페이드).
 */
export function evaluateRegionAmpFactor(v, tNorm) {
  const regions = Array.isArray(v?.regions) ? v.regions : null;
  if (!regions || !regions.length) return 1;
  let factor = 1;
  let soloMask = 0;
  let anySolo = false;
  for (const r of regions) {
    if (!r) continue;
    const fadeSec = r.ramp === 'off' ? REGION_MIN_FADE_SEC : Math.max(REGION_MIN_FADE_SEC, Number(r.rampSec) || 0);
    const rn = regionRampNorm(r, v.clip ? clipFullSpan(v).dur : v.duration, fadeSec);
    const w = regionWindow(r, tNorm, rn, r.t0 > 1e-6, r.t1 < 1 - 1e-6);
    if (r.solo) {
      anySolo = true;
      soloMask = Math.max(soloMask, w);
    }
    if (w <= 0) continue;
    if (r.mute) factor *= 1 - w;
    const g = Number(r.gainDb) || 0;
    if (g !== 0) factor *= 1 + w * (dbToAmp(g) - 1);
  }
  return anySolo ? factor * soloMask : factor;
}

/**
 * Half-open span [start, end): back-to-back voices never both count at the seam
 * (which would dip equal-power compensation and trigger peak safety there).
 * 반열린 구간 [시작, 끝) — 맞닿은 보이스가 경계에서 동시에 집계되지 않음.
 */
export function isVoiceActiveAt(v, sec) {
  return sec >= v.startTime && sec < v.startTime + v.duration;
}

/** Amplitude at absolute time (0 outside the voice's span). / 절대 시각의 진폭 */
export function evaluateVoiceAmplitudeAtTime(v, sec, opts = {}) {
  if (!isVoiceActiveAt(v, sec)) return 0;
  return evaluateVoiceAmplitudeAtNormT(v, (sec - v.startTime) / Math.max(1e-9, v.duration), opts);
}

/**
 * Amplitude curve over the voice's normalized span (for AudioParam.setValueCurveAtTime).
 * 보이스 구간의 진폭 곡선 (setValueCurveAtTime용).
 */
export function buildVoiceAmplitudeCurve(v, { points = 256, range } = {}) {
  const n = Math.max(2, Math.floor(points));
  const r = range || (v?.gainMode === 'engine' ? getGainEngineRange(v.gainEngineObj) : undefined);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = evaluateVoiceAmplitudeAtNormT(v, i / (n - 1), { range: r });
  return out;
}

/** Precompute autoFit ranges once per render pass: Map(voiceId → range). / 범위 사전 계산 */
export function precomputeGainRanges(voices) {
  const m = new Map();
  for (const v of voices || []) {
    if (v?.gainMode === 'engine' && v.gainEngineObj && v.gainEngineObj.autoFit !== false) {
      m.set(v.id, getGainEngineRange(v.gainEngineObj));
    }
  }
  return m;
}

// ==========================================================================
// 2. Master bus / 마스터 버스
// ==========================================================================

/**
 * @typedef {object} BusConfig
 * @property {'sum'|'equalPower'|'soneNormalize'} mode
 * @property {number} masterGain       in masterUnit
 * @property {'amp'|'db'|'sone'} masterUnit
 * @property {number} ceilingDb        peak-safety ceiling (dBFS)
 * @property {boolean} limitPeaks      scale down when the worst-case coherent sum exceeds the ceiling
 * @property {number|null} targetSones soneNormalize target (null = loudest single voice)
 */
/**
 * Level compensation for N simultaneous voices (shared by the master bus and studios such as
 * Risset): 'equalPower' → 1/√N, 'sum' → 1. / N개 동시 보이스 레벨 보정 (equalPower = 1/√N)
 */
export function compensationForCount(n, mode = 'equalPower') {
  const count = Math.max(1, Math.round(Number(n) || 1));
  return mode === 'sum' ? 1 : 1 / Math.sqrt(count);
}

export function createDefaultBusConfig() {
  return { mode: 'equalPower', masterGain: 1, masterUnit: 'amp', ceilingDb: -1, limitPeaks: true, targetSones: null };
}

/** Solo/mute-aware audible subset of a voice list. / 솔로·뮤트 반영 */
export function filterAudibleVoices(voices) {
  const list = (voices || []).filter(Boolean);
  // A soloed region counts as a solo for its voice. / 솔로 구간은 보이스 솔로로 간주
  const anySolo = list.some((v) => v.solo || voiceHasSoloRegion(v));
  return list.filter((v) => (anySolo ? v.solo || voiceHasSoloRegion(v) : !v.muted) && v.duration > 0);
}

/**
 * Master-bus gain at an absolute time. Multiply each voice's amplitude by `master` to get
 * its contribution to the output. Interface is stable for the audio layer and WAV export.
 * 절대 시각의 마스터 버스 게인. 각 보이스 진폭에 master를 곱해 출력 기여도를 얻음.
 *
 * Compensation / 보정
 *   sum          : 1
 *   equalPower   : 1/√N  (N = voices currently sounding)
 *   soneNormalize: c = (target / Σ sones)^(1/k) if Σ sones > target, else 1,
 *                  so the ensemble is perceived about as loud as `target` (k = SONE_EXPONENT)
 * Peak safety: if limitPeaks and master·Σ amps > ceiling, scale down to the ceiling.
 *
 * @param {object[]} voices
 * @param {number} absTimeSec
 * @param {Partial<BusConfig>} [busConfig]
 * @param {{ ranges?: Map<string, object>, audibleOnly?: boolean }} [opts]
 * @returns {{
 *   master: number, masterAmp: number, compensation: number, safety: number,
 *   activeCount: number, totalSones: number, peakEstimate: number, outputPeakDb: number,
 *   voices: Array<{ id: string, amp: number, sones: number }>
 * }}
 */
export function evaluateMasterBusGain(voices, absTimeSec, busConfig = {}, opts = {}) {
  const cfg = { ...createDefaultBusConfig(), ...busConfig };
  const list = opts.audibleOnly === false ? (voices || []).filter(Boolean) : filterAudibleVoices(voices);
  const ranges = opts.ranges || null;

  const perVoice = [];
  let sumAmp = 0;
  let totalSones = 0;
  let maxSones = 0;
  let activeCount = 0;
  for (const v of list) {
    const amp = evaluateVoiceAmplitudeAtTime(v, absTimeSec, { range: ranges?.get(v.id) });
    const sones = ampToSone(amp);
    perVoice.push({ id: v.id, amp, sones });
    if (amp > AMP_FLOOR) {
      activeCount++;
      sumAmp += amp;
      totalSones += sones;
      maxSones = Math.max(maxSones, sones);
    }
  }

  let compensation = 1;
  if (cfg.mode === 'equalPower') {
    compensation = 1 / Math.sqrt(Math.max(1, activeCount));
  } else if (cfg.mode === 'soneNormalize') {
    const target = Number.isFinite(cfg.targetSones) && cfg.targetSones > 0 ? cfg.targetSones : maxSones;
    if (totalSones > target && target > 0) compensation = Math.pow(target / totalSones, 1 / SONE_EXPONENT);
  }

  const masterAmp = Math.max(0, convertGain(Number(cfg.masterGain) || 0, GAIN_UNITS.includes(cfg.masterUnit) ? cfg.masterUnit : 'amp', 'amp'));
  const pre = masterAmp * compensation;
  const ceiling = dbToAmp(Math.min(0, Number(cfg.ceilingDb) || 0)) || 1;
  const prePeak = pre * sumAmp;
  const safety = cfg.limitPeaks && prePeak > ceiling ? ceiling / prePeak : 1;
  const master = pre * safety;
  const peakEstimate = master * sumAmp;

  return {
    master,
    masterAmp,
    compensation,
    safety,
    activeCount,
    totalSones,
    peakEstimate,
    outputPeakDb: ampToDb(peakEstimate),
    voices: perVoice,
  };
}

/**
 * Sample the master multiplier over [t0, t1] (n points) for scheduling an AudioParam.
 * Steps occur where voices enter/leave; the audio layer should smooth (setTargetAtTime).
 * 구간 [t0,t1]의 마스터 배율 샘플 (오디오 계층에서 스무딩 권장).
 */
export function buildMasterGainCurve(voices, t0, t1, busConfig = {}, { points = 512 } = {}) {
  const n = Math.max(2, Math.floor(points));
  const ranges = precomputeGainRanges(voices);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = evaluateMasterBusGain(voices, t0 + ((t1 - t0) * i) / (n - 1), busConfig, { ranges }).master;
  }
  return out;
}

// ==========================================================================
// 3. Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Points & Engine envelopes', (a) => {
  const v = createDefaultVoice(0);
  a.near(evaluateVoiceGainAtNormT(v, 0.4), 0.9, 1e-12, 'default flat 0.9');
  v.gainPoints = [{ x: 0, y: 0, handles: [] }, { x: 1, y: 2, handles: [] }];
  a.near(evaluateVoiceGainAtNormT(v, 0.25), 0.5, 1e-12, 'points linear');
  a.equal(evaluateVoiceGainAtNormT(v, 0.9), 1, 'clamped to 1');
  v.gainPoints = [];
  a.equal(evaluateVoiceGainAtNormT(v, 0.5), 1, 'no points → 1');

  const e = createDefaultVoice(0, { gainMode: 'engine' });
  Object.assign(e.gainEngineObj, { engine: 'damped', dampA: 1.2, ampMin: 0.2, ampMax: 0.8, autoFit: true });
  let lo = Infinity;
  let hi = -Infinity;
  const r = getGainEngineRange(e.gainEngineObj);
  a.ok(r.rawMax > 1, 'damped overshoots');
  for (let i = 0; i <= 200; i++) {
    const y = evaluateVoiceGainAtNormT(e, i / 200, { range: r });
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  a.ok(lo >= 0.2 - 1e-9 && hi <= 0.8 + 1e-9, `autoFit stays in [ampMin, ampMax]: ${lo}…${hi}`);
  a.near(hi, 0.8, 1e-3, 'autoFit reaches ampMax');
  e.gainEngineObj.autoFit = false;
  a.near(evaluateVoiceGainAtNormT(e, 0), 0.2, 1e-12, 'no autoFit: y=0 → ampMin');
  Object.assign(e.gainEngineObj, { ampMin: 0.5, ampMax: 0.5 });
  a.near(evaluateVoiceGainAtNormT(e, 0.7), 0.5, 1e-12, 'ampMin = ampMax → constant');
  Object.assign(e.gainEngineObj, { ampMin: 1, ampMax: 0, engine: 'custom' });
  a.near(evaluateVoiceGainAtNormT(e, 0.25), 0.75, 1e-12, 'inverted range');
}, { group: 'gain' });

registerSelfCheck('Gain units: amp / dB / sone', (a) => {
  a.equal(envelopeToAmp(0.5, 'amp'), 0.5);
  a.equal(envelopeToAmp(1, 'db'), 1);
  a.equal(envelopeToAmp(0, 'db'), 0);
  a.near(ampToDb(envelopeToAmp(0.5, 'db')), -30, 1e-9);
  a.near(envelopeToAmp(1, 'sone'), 1, 1e-12);
  a.near(ampToDb(envelopeToAmp(0.5, 'sone')), -10, 1e-9, '½ sone = −10 dB');
  for (const unit of GAIN_UNITS) {
    for (const y of [0.1, 0.42, 0.9]) a.near(ampToEnvelope(envelopeToAmp(y, unit), unit), y, 1e-9, `${unit} round-trip`);
  }
  const v = createDefaultVoice(0, { baseGain: 0.5, gainUnit: 'db', gainPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }] });
  a.near(evaluateVoiceAmplitudeAtNormT(v, 0.3), 0.5, 1e-12, 'baseGain × env');
  a.equal(evaluateVoiceAmplitudeAtTime(v, v.startTime + v.duration + 0.01), 0, 'silent after end');
  const curve = buildVoiceAmplitudeCurve(v, { points: 8 });
  a.ok(curve.length === 8 && Math.abs(curve[7] - 0.5) < 1e-6, 'amplitude curve');
}, { group: 'gain' });

registerSelfCheck('Master bus modes & peak safety', (a) => {
  const mk = (i) => createDefaultVoice(i, { baseGain: 1, gainPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }] });
  const four = [mk(0), mk(1), mk(2), mk(3)];
  const sum = evaluateMasterBusGain(four, 1, { mode: 'sum', limitPeaks: false });
  a.equal(sum.master, 1);
  a.equal(sum.activeCount, 4);
  a.near(evaluateMasterBusGain(four, 1, { mode: 'equalPower', limitPeaks: false }).master, 0.5, 1e-12, '1/√4');
  const sn = evaluateMasterBusGain(four, 1, { mode: 'soneNormalize', limitPeaks: false });
  a.near(sn.totalSones * Math.pow(sn.compensation, SONE_EXPONENT), 1, 1e-9, 'ensemble loudness → loudest voice');
  const safe = evaluateMasterBusGain(four, 1, { mode: 'sum', limitPeaks: true, ceilingDb: -1 });
  a.near(safe.peakEstimate, dbToAmp(-1), 1e-9, 'peak limited to ceiling');
  a.near(evaluateMasterBusGain(four, 1, { mode: 'sum', masterGain: -6.0206, masterUnit: 'db', limitPeaks: false }).master, 0.5, 1e-4, 'master in dB');
  four[0].solo = true;
  a.equal(evaluateMasterBusGain(four, 1, { mode: 'sum' }).voices.length, 1, 'solo respected');
  a.equal(evaluateMasterBusGain(four, 99, {}).activeCount, 0, 'nothing sounding');
  a.equal(evaluateMasterBusGain([], 0).master, 1, 'empty bus');
  const curve = buildMasterGainCurve([mk(0), { ...mk(1), startTime: 1 }], 0, 2, { mode: 'equalPower', limitPeaks: false }, { points: 5 });
  a.near(curve[0], 1, 1e-6, 't=0: one voice (Float32)');
  a.near(curve[4], 1 / Math.SQRT2, 1e-6, 't=2: two overlapping voices (Float32)');
}, { group: 'gain' });

registerSelfCheck('Regression: abutting voices do not double-count at the seam', (a) => {
  const flat = (i, start) => createDefaultVoice(i, { startTime: start, duration: 2, baseGain: 1, gainPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }] });
  const pair = [flat(0, 0), flat(1, 2)];
  const curve = buildMasterGainCurve(pair, 0, 3.99, { mode: 'equalPower', limitPeaks: false }, { points: 5 });
  for (const g of curve) a.near(g, 1, 1e-6, 'no equal-power dip');
  const seam = evaluateMasterBusGain(pair, 2, { mode: 'sum', limitPeaks: true, ceilingDb: -1 });
  a.equal(seam.activeCount, 1, 'one voice at t = 2');
  a.near(seam.master, dbToAmp(-1), 1e-9, 'peak safety not halved at the seam');
}, { group: 'gain' });
