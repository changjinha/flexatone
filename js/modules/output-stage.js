/**
 * Flexatone — modules/output-stage.js
 * Layer 1 (modules): end-of-chain output stage math (fader taper, Loudness Lock, meter mapping).
 * 계층 1 (modules): 신호 흐름 마지막 출력 단계 계산 (페이더 테이퍼, 라우드니스 락, 미터 매핑).
 *
 *   studios → master/transport → [output fader: dB taper A/B, one-pole τ 5–10 ms]
 *     → destination
 *     ↘ tap → Sone / masking AudioWorklet (audio/loudness-meter.js) → meters / Loudness Lock
 *
 * Imports: core/*, modules/loudness-model.js. No DOM / Audio APIs.
 */

import { createDbTaper, DB_TO_LN, LN_TO_DB } from '../core/units.js';
import { registerSelfCheck, normalizeOutputConfig, createDefaultOutputConfig } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { LoudnessAnalyzer } from './loudness-model.js';

const taperCache = new Map();

/** dB taper of the output fader (cached by dbMin/dbMax/taper). / 출력 페이더 테이퍼 */
export function outputTaper(cfg) {
  const c = normalizeOutputConfig(cfg);
  const key = `${c.dbMin}|${c.dbMax}|${c.taper}`;
  let tp = taperCache.get(key);
  if (!tp) {
    tp = createDbTaper({ dbMin: c.dbMin, dbMax: c.dbMax, mode: c.taper });
    if (taperCache.size > 32) taperCache.clear();
    taperCache.set(key, tp);
  }
  return tp;
}

/** Linear gain of the fader position. / 페이더 위치의 선형 게인 */
export function faderAmp(cfg) {
  return outputTaper(cfg).normToAmp(normalizeOutputConfig(cfg).faderNorm);
}

/**
 * Static output gain for a mode (Loudness Lock passes its runtime gain in dB).
 * amp → ampLevel · db → taper(faderNorm) · sone → 10^(lockDb/20). / 모드별 출력 게인
 */
export function outputAmpFor(cfg, lockDb = 0) {
  const c = normalizeOutputConfig(cfg);
  if (c.mode === 'amp') return c.ampLevel;
  if (c.mode === 'sone') return dbAmp(lockDb);
  return faderAmp(c);
}

/** Fader position for a typed dB value. / 입력한 dB → 페이더 위치 */
export function faderNormForDb(cfg, db) {
  const tp = outputTaper(cfg);
  if (!Number.isFinite(db)) return 0;
  return tp.dbToNorm(clamp(db, tp.dbMin - 40, tp.dbMax));
}

/** dB of the fader position (−Infinity at the bottom). / 페이더 위치의 dB */
export function faderDb(cfg) {
  return outputTaper(cfg).normToDb(normalizeOutputConfig(cfg).faderNorm);
}

/** "−12.3 dB" / "−∞ dB". */
export function formatDb(db, digits = 1) {
  if (!Number.isFinite(db) || db < -199) return '−∞';
  const r = db.toFixed(digits);
  return (db < 0 ? r.replace('-', '−') : `+${r}`).replace('+0.0', '0.0');
}

/** Amplitude → dBFS with precomputed constants (−Infinity for 0). */
export function ampDb(a) {
  return a > 0 ? Math.log(a) * LN_TO_DB : -Infinity;
}

export const LOCK_ALPHA = 0.23; // sone ∝ I^α ⇒ ΔdB = log10(S_t/S_m) / (α/10)
export const LOCK_GATE_SONE = 0.05; // below this the input counts as silence (hold the gain)
export const LOCK_RATE = 0.08; // fraction of the dB error corrected per analyzer frame (~30 fps)

/**
 * One Loudness-Lock step: move the gain (dB) toward the value that would make the measured
 * post-fader Total Sone equal the target. Silence holds the gain. / 라우드니스 락 1스텝
 * @returns {number} new gain in dB, clamped to [dbMin, lockMaxBoostDb]
 */
export function loudnessLockStep(currentDb, measuredSone, cfg) {
  const c = normalizeOutputConfig(cfg);
  const cur = Number.isFinite(currentDb) ? currentDb : 0;
  if (!(measuredSone > LOCK_GATE_SONE)) return clamp(cur, c.dbMin, c.lockMaxBoostDb);
  const err = Math.log10(c.soneTarget / measuredSone) / (LOCK_ALPHA / 10);
  const step = clamp(err, -12, 12) * LOCK_RATE;
  return clamp(cur + step, c.dbMin, c.lockMaxBoostDb);
}

/** dB → amp with precomputed constants. */
export function dbAmp(db) {
  return Number.isFinite(db) ? Math.exp(db * DB_TO_LN) : 0;
}

/** Sone → phon (Stevens, 1 sone = 40 phon) for the readout. / sone → phon */
export function soneToPhonValue(s) {
  return s > 0 ? 40 + 10 * Math.log2(s) : -Infinity;
}

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Output: dB taper A/B, meter mapping, one-pole constants', (a) => {
  const A = createDbTaper({ dbMin: -60, mode: 'linear' });
  a.equal(A.normToAmp(0), 0, 'A: x=0 → silence');
  a.near(A.normToAmp(1), 1, 1e-12, 'A: x=1 → 0 dB');
  a.near(A.normToDb(0.5), -30, 1e-9, 'A: linear dB');
  a.near(A.ampToNorm(A.normToAmp(0.37)), 0.37, 1e-9, 'A: round trip');
  a.equal(A.ampToNorm(1e-4), 0, 'A: below ε → 0');
  const Bt = createDbTaper({ dbMin: -60, mode: 'daw', knee: 0.15 });
  a.near(Bt.normToAmp(0.15), Bt.eps, 1e-12, 'B: knee amplitude = ε');
  a.near(Bt.normToAmp(0.075), Bt.eps / 2, 1e-12, 'B: linear below knee');
  a.near(Bt.normToDb(0.15 + 0.85 / 2), -30, 1e-9, 'B: dB linear above knee');
  for (const x of [0.03, 0.1, 0.2, 0.6, 0.99]) a.near(Bt.ampToNorm(Bt.normToAmp(x)), x, 1e-9, `B: round trip ${x}`);
  let mono = true;
  for (let x = 0.001, prev = 0; x <= 1; x += 0.001) { const v = Bt.normToAmp(x); if (v < prev) mono = false; prev = v; }
  a.ok(mono, 'B: monotonic');
  const ticks = A.meterTicks(15).map((t) => t.x);
  a.equal(ticks.map((x) => x.toFixed(2)).join(), '0.00,0.25,0.50,0.75,1.00', 'meter ticks equally spaced');
  a.near(A.meterNorm(Math.pow(10, -45 / 20)), 0.25, 1e-9, 'meter −45 dB');
  a.near(LN_TO_DB * DB_TO_LN, 1, 1e-15, 'LN10 constants');
  const d = createDefaultOutputConfig();
  a.near(faderAmp(d), 1, 1e-12, 'default fader = unity');
  a.near(faderDb({ ...d, faderNorm: faderNormForDb(d, -18) }), -18, 1e-9, 'typed dB → fader');
  a.near(outputAmpFor({ ...d, mode: 'amp', ampLevel: 0.25 }), 0.25, 1e-12, 'amp mode = linear amplitude');
  a.near(outputAmpFor({ ...d, mode: 'sone' }, -6), Math.pow(10, -6 / 20), 1e-12, 'sone mode uses lock gain');
  a.equal(normalizeOutputConfig({ mode: 'amp', ampLevel: 3 }).ampLevel, 1, 'amp clamps to 1');
}, { group: 'math' });

registerSelfCheck('Output: Sone analyzer calibration, masking, zero-GC buffers, Loudness Lock', (a) => {
  const fs = 48000;
  const an = new LoudnessAnalyzer(fs, { fullScaleDbSpl: 90 });
  const buf = new Float32Array(128);
  let n = 0;
  const feed = (freq, dbSpl, blocks = 120) => {
    const amp = Math.pow(10, (dbSpl - 90) / 20);
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 128; i++, n++) buf[i] = amp * Math.sin((2 * Math.PI * freq * n) / fs);
      an.push(buf, null, 128);
    }
    return an.totalSone;
  };
  const refs = [an.ring, an.re, an.im, an.bandI, an.excI, an.specific];
  const s40 = feed(1000, 40);
  a.near(s40, 1, 0.15, `1 kHz @ 40 dB SPL ≈ 1 sone (${s40.toFixed(3)})`);
  const s50 = feed(1000, 50);
  // ISO 532B / Stevens: +10 phon ≈ ×2 (α = 0.23 + level-dependent spreading) / 10 dB ≈ 2배
  a.ok(s50 / s40 > 1.7 && s50 / s40 < 2.6, `+10 dB ≈ ×2: ${(s50 / s40).toFixed(2)}`);
  const s100 = feed(100, 40);
  a.ok(s100 < s40, `100 Hz quieter than 1 kHz at the same SPL (${s100.toFixed(2)})`);
  const s3k = feed(3300, 40);
  a.ok(s3k > s40, `3.3 kHz ear-canal resonance louder (${s3k.toFixed(2)})`);
  feed(1000, 80);
  const b1k = 8;
  a.ok(an.maskDb[b1k + 3] > an.maskDb[b1k - 3], 'upward masking spreads further at 80 dB');
  a.ok(refs.every((r, i) => r === [an.ring, an.re, an.im, an.bandI, an.excI, an.specific][i]), 'buffers never reallocated');
  an.pushSilence(4096);
  a.ok(an.totalSone < 1e-3, 'silence → 0 sone');
  const pkt = new Float32Array(an.packetSize);
  an.writePacket(pkt);
  a.equal(pkt.length, 101, 'packet size');
  // Loudness Lock converges toward the target / 라우드니스 락 수렴
  const cfg = { ...createDefaultOutputConfig(), mode: 'sone', soneTarget: 4 };
  let db = 0;
  for (let k = 0; k < 200; k++) db = loudnessLockStep(db, 8 * Math.pow(10, (LOCK_ALPHA / 10) * db), cfg);
  a.near(8 * Math.pow(10, (LOCK_ALPHA / 10) * db), 4, 0.05, 'lock reaches target');
  a.equal(loudnessLockStep(-3, 0, cfg), -3, 'silence holds gain');
  a.ok(LoudnessAnalyzer.toString().indexOf('import') < 0, 'self-contained (Blob-safe)');
}, { group: 'audio' });
