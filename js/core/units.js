/**
 * Flexatone — core/units.js
 * Layer 0 (core): pitch and loudness unit conversions. Pure functions, no DOM.
 * 계층 0 (core): 음고·라우드니스 단위 변환. 순수 함수, DOM 없음.
 *
 * Pitch / 음고
 *   12-TET, A4 = 440 Hz = MIDI 69 (A4 is configurable per call).
 *
 * Loudness / 라우드니스
 *   dBFS   : 20·log10(amp), floored at DB_FLOOR (−96 dBFS ≈ 16-bit noise floor).
 *   Sone   : Stevens' power law via phon. Loudness doubles every +10 phon:
 *              sone = 2^((phon − 40) / 10)
 *            Digital level is mapped to phon by a reference: phon = refPhon + dBFS.
 *            Default refPhon = 40, so 0 dBFS ≡ 1 sone and sone ≈ amp^0.602
 *            (= intensity^0.301, Stevens' exponent ≈ 0.3).
 *            This is a perceptual balancing approximation (no equal-loudness contours).
 *   Sone   : 스티븐스 멱법칙 근사. +10 phon마다 2배. 기본값 0 dBFS = 1 sone.
 */

import { clamp } from './math-utils.js';

// ==========================================================================
// Pitch / 음고
// ==========================================================================

export const A4_HZ = 440;
export const A4_MIDI = 69;
export const MIDI_MIN = 0;
export const MIDI_MAX = 127;
export const FREQ_MIN = 1e-3;

export const NOTE_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
export const NOTE_NAMES_FLAT = Object.freeze(['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']);

/** MIDI (fractional allowed) → Hz. */
export function midiToFreq(midi, a4 = A4_HZ) {
  return a4 * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Hz → fractional MIDI. Non-positive input is floored to FREQ_MIN. */
export function freqToMidi(hz, a4 = A4_HZ) {
  return A4_MIDI + 12 * Math.log2(Math.max(FREQ_MIN, hz) / a4);
}

/** Apply a cents offset to a frequency. / 센트 오프셋 적용 */
export function applyCents(hz, cents) {
  return hz * Math.pow(2, cents / 1200);
}

/**
 * Split fractional MIDI into nearest note + cents. / 가장 가까운 음 + 센트로 분해
 * @returns {{ midi:number, cents:number, pitchClass:number, octave:number, name:string }}
 */
export function splitMidi(midiFloat, { flats = false } = {}) {
  let midi = Math.round(midiFloat);
  let cents = Math.round((midiFloat - midi) * 100);
  if (cents >= 100) { midi += 1; cents -= 100; }
  if (cents <= -100) { midi -= 1; cents += 100; }
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = (flats ? NOTE_NAMES_FLAT : NOTE_NAMES)[pitchClass] + octave;
  return { midi, cents, pitchClass, octave, name };
}

/**
 * MIDI → note name. 60 → 'C4'. With { cents: true }: 60.25 → 'C4 +25¢'.
 * MIDI → 음이름. cents 옵션 시 센트 표기 추가.
 * @param {number} midiFloat
 * @param {{ cents?: boolean, flats?: boolean, centSymbol?: string }} [opts]
 */
export function midiToNoteName(midiFloat, opts = {}) {
  const { cents = false, flats = false, centSymbol = '¢' } = opts;
  if (!Number.isFinite(midiFloat)) return '—';
  const s = splitMidi(midiFloat, { flats });
  if (!cents) return s.name;
  const sign = s.cents >= 0 ? '+' : '−';
  return `${s.name} ${sign}${Math.abs(s.cents)}${centSymbol}`;
}

/**
 * Note name → fractional MIDI, or null if invalid.
 * Accepts: 'C4', 'c#3', 'Db5', 'F♯2', 'B♭-1', 'A4+25', 'A4 -30c', 'A4+12¢'.
 * 음이름 → MIDI (잘못된 입력은 null). 센트 접미사 지원.
 */
export function noteNameToMidi(str) {
  const m = String(str ?? '')
    .trim()
    .replace(/−/g, '-')
    .match(/^([A-Ga-g])\s*(#|b|♯|♭|x|bb|##)?\s*(-?\d{1,2})\s*(?:([+-]\s*\d+(?:\.\d+)?)\s*(?:c|ct|cents?|¢)?)?$/i);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const accMap = { '#': 1, '♯': 1, b: -1, '♭': -1, x: 2, '##': 2, bb: -2 };
  const acc = m[2] ? accMap[m[2]] ?? accMap[m[2].toLowerCase()] ?? 0 : 0;
  const octave = parseInt(m[3], 10);
  const cents = m[4] ? parseFloat(m[4].replace(/\s+/g, '')) : 0;
  const midi = (octave + 1) * 12 + base + acc + cents / 100;
  if (!Number.isFinite(midi) || midi < MIDI_MIN || midi > MIDI_MAX) return null;
  return midi;
}

/**
 * Map normalized y∈[0,1] (extrapolates outside) to Hz between f0 and f1.
 * log: equal-semitone spacing; linear: equal-Hz spacing.
 * 정규화 y를 F0~F1 사이 주파수로 매핑 (log=반음 등간격, linear=Hz 등간격).
 */
export function normToFreq(y, f0Hz, f1Hz, logScale = true) {
  if (logScale) {
    const m0 = freqToMidi(f0Hz);
    const m1 = freqToMidi(f1Hz);
    return midiToFreq(m0 + y * (m1 - m0));
  }
  return Math.max(FREQ_MIN, f0Hz + y * (f1Hz - f0Hz));
}

/** Inverse of normToFreq. / normToFreq의 역함수 */
export function freqToNorm(hz, f0Hz, f1Hz, logScale = true) {
  if (logScale) {
    const m0 = freqToMidi(f0Hz);
    const m1 = freqToMidi(f1Hz);
    const d = m1 - m0;
    return Math.abs(d) < 1e-9 ? 0 : (freqToMidi(hz) - m0) / d;
  }
  const d = f1Hz - f0Hz;
  return Math.abs(d) < 1e-9 ? 0 : (hz - f0Hz) / d;
}

// ==========================================================================
// Loudness / 라우드니스
// ==========================================================================

export const DB_FLOOR = -96;
export const AMP_FLOOR = Math.pow(10, DB_FLOOR / 20); // ≈ 1.585e-5
export const SONE_REF_PHON = 40;
export const GAIN_UNITS = Object.freeze(['amp', 'db', 'sone']);

/** Linear amplitude → dBFS (floored at DB_FLOOR). */
export function ampToDb(amp) {
  const a = Math.abs(amp);
  if (!(a > AMP_FLOOR)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(a));
}

/** dBFS → linear amplitude. Values at/below DB_FLOOR return exact 0 (silence). */
export function dbToAmp(db) {
  if (!Number.isFinite(db) || db <= DB_FLOOR) return 0;
  return Math.pow(10, db / 20);
}

/** phon → sone (Stevens). / phon → sone */
export function phonToSone(phon) {
  return Math.pow(2, (phon - 40) / 10);
}

/** sone → phon. */
export function soneToPhon(sone) {
  return 40 + 10 * Math.log2(Math.max(1e-12, sone));
}

/**
 * Linear amplitude → sone (0 at/below the dB floor).
 * @param {number} amp
 * @param {number} [refPhon=SONE_REF_PHON] phon level that 0 dBFS represents
 */
export function ampToSone(amp, refPhon = SONE_REF_PHON) {
  const db = ampToDb(amp);
  if (db <= DB_FLOOR) return 0;
  return phonToSone(refPhon + db);
}

/** Sone → linear amplitude (exact inverse of ampToSone above the floor). */
export function soneToAmp(sone, refPhon = SONE_REF_PHON) {
  if (!(sone > 0)) return 0;
  return dbToAmp(soneToPhon(sone) - refPhon);
}

/**
 * Convert a gain value between 'amp' | 'db' | 'sone'.
 * 게인 값을 amp / db / sone 간 변환.
 */
export function convertGain(value, from, to, refPhon = SONE_REF_PHON) {
  if (from === to) return value;
  let amp;
  switch (from) {
    case 'db': amp = dbToAmp(value); break;
    case 'sone': amp = soneToAmp(value, refPhon); break;
    case 'amp': amp = value; break;
    default: throw new RangeError(`convertGain: unknown unit "${from}"`);
  }
  switch (to) {
    case 'db': return ampToDb(amp);
    case 'sone': return ampToSone(amp, refPhon);
    case 'amp': return amp;
    default: throw new RangeError(`convertGain: unknown unit "${to}"`);
  }
}

/** Clamp a base gain to the voice contract range [0, 1.5]. */
export function clampBaseGain(amp) {
  return clamp(Number.isFinite(amp) ? amp : 0, 0, 1.5);
}

// ==========================================================================
// dB taper (fader / envelope / meter mapping) / dB 테이퍼 (페이더·엔벨로프·미터)
// ==========================================================================

/** Precomputed constants: dB = ln(A)·LN_TO_DB, A = exp(dB·DB_TO_LN). Only Math.log / Math.exp at runtime. */
export const LN_TO_DB = 20 / Math.LN10;
export const DB_TO_LN = Math.LN10 / 20;
export const DB_TAPERS = Object.freeze(['linear', 'daw']);

/**
 * dB taper between a normalized control x ∈ [0, 1] and a linear amplitude A.
 *   ε = 10^(dBmin/20) is the quietest non-zero amplitude (A < ε ⇒ x = 0 ⇒ silence).
 *   'linear' (A): x = 0 → A = 0; else dB = dBmin + x·(dBmax − dBmin).
 *   'daw'    (B): x < knee → A = A_knee·(x / knee) (linear fade to true 0, no "−60 dB cliff");
 *                 x ≥ knee → dB linear from dBmin … dBmax over [knee, 1].
 * Meter mapping (meterNorm) is always linear in dB, so the ticks −60, −45, −30, −15, 0 are equally spaced.
 * dB 테이퍼: 방식 A(선형 dB) / 방식 B(DAW: 하단 knee 구간 선형). 미터는 항상 dB 등간격.
 * @param {{dbMin?:number, dbMax?:number, mode?:'linear'|'daw', knee?:number}} [o]
 */
export function createDbTaper({ dbMin = -60, dbMax = 0, mode = 'linear', knee = 0.15 } = {}) {
  const lo = Math.min(Number(dbMin) || -60, (Number(dbMax) || 0) - 1);
  const hi = Number.isFinite(dbMax) ? dbMax : 0;
  const span = hi - lo;
  const daw = mode === 'daw';
  const k = daw ? clamp(Number(knee) || 0.15, 0.01, 0.5) : 0;
  const eps = Math.exp(lo * DB_TO_LN);
  const aKnee = eps; // amplitude at the knee = ε (curve is continuous at x = knee)
  const dbToNorm = (db) => {
    if (!(db > lo)) return daw && Number.isFinite(db) ? clamp((Math.exp(db * DB_TO_LN) / aKnee) * k, 0, k) : 0;
    return clamp(daw ? k + ((db - lo) / span) * (1 - k) : (db - lo) / span, 0, 1);
  };
  const normToDb = (x) => {
    const xc = clamp(Number.isFinite(x) ? x : 0, 0, 1);
    if (daw) {
      if (xc < k) return xc <= 0 ? -Infinity : Math.log(aKnee * (xc / k)) * LN_TO_DB;
      return lo + ((xc - k) / (1 - k)) * span;
    }
    return xc <= 0 ? -Infinity : lo + xc * span;
  };
  const normToAmp = (x) => {
    const xc = clamp(Number.isFinite(x) ? x : 0, 0, 1);
    if (xc <= 0) return 0;
    if (daw && xc < k) return aKnee * (xc / k);
    return Math.exp(normToDb(xc) * DB_TO_LN);
  };
  const ampToNorm = (amp) => {
    const a = Math.abs(Number.isFinite(amp) ? amp : 0);
    if (daw) {
      if (a < aKnee) return clamp((a / aKnee) * k, 0, k);
      return dbToNorm(Math.log(a) * LN_TO_DB);
    }
    if (a < eps) return 0;
    return dbToNorm(Math.log(a) * LN_TO_DB);
  };
  /** Meter position: always linear in dB over [dbMin, dbMax] (A < ε → 0). / 미터 위치 */
  const meterNorm = (amp) => {
    const a = Math.abs(amp);
    if (!(a > eps)) return 0;
    return clamp((Math.log(a) * LN_TO_DB - lo) / span, 0, 1);
  };
  const meterTicks = (step = 15) => {
    const out = [];
    for (let db = hi; db >= lo - 1e-9; db -= step) out.push({ db, x: (db - lo) / span });
    return out.reverse();
  };
  return Object.freeze({ dbMin: lo, dbMax: hi, mode: daw ? 'daw' : 'linear', knee: k, eps, dbToNorm, normToDb, normToAmp, ampToNorm, meterNorm, meterTicks });
}

