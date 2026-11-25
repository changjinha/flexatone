/**
 * Flexatone — core/adsr.js
 * Layer 0 (core, pure): the ADSR envelope of the timbre toolbox. / 음색 툴박스의 ADSR 엔벨로프.
 *
 *   adsr = { on, a, d, s, r, retrig }   a / d / r in seconds, s = sustain level 0…1
 * The envelope lives inside the line's own span: attack from its start, release ending at its end
 * (a line never gets longer). Lines joined back to back (Legato Join, or a Sampler chain) with the
 * same ADSR share **one** envelope over the whole run — unless the later line has `retrig` on, then
 * the envelope starts again there (attack) and the earlier line releases into the join.
 * 엔벨로프는 선 자신의 구간 안에서: 시작에서 어택, 끝에서 릴리스가 끝남 (선이 길어지지 않음). 이어 붙은
 * 선(레가토 연결·샘플러 체인)이 같은 ADSR이면 전체를 **하나의** 엔벨로프로 보고, 뒤 선의 retrig가 켜져
 * 있으면 그 자리에서 새로 시작 (앞 선은 릴리스).
 *
 * Imports: core/math-utils.js only.
 */

import { clamp, roundTo } from './math-utils.js';

export const ADSR_MAX_SEC = 10;

/** Default envelope: off; the values are what you get when you switch it on. / 기본값 (꺼짐) */
export function createDefaultAdsr() {
  return { on: false, a: 0.02, d: 0.15, s: 0.7, r: 0.2, retrig: false };
}

/** Clean an ADSR read from a file. / ADSR 정규화 */
export function normalizeAdsr(raw) {
  const d = createDefaultAdsr();
  const src = raw && typeof raw === 'object' ? raw : {};
  const sec = (x, def) => (Number.isFinite(Number(x)) ? roundTo(clamp(Number(x), 0, ADSR_MAX_SEC), 4) : def);
  return {
    on: !!src.on,
    a: sec(src.a, d.a),
    d: sec(src.d, d.d),
    s: Number.isFinite(Number(src.s)) ? roundTo(clamp(Number(src.s), 0, 1), 4) : d.s,
    r: sec(src.r, d.r),
    retrig: !!src.retrig,
  };
}

/** Sound-relevant key (on + values, not retrig): equal keys may share one envelope. / 같은 엔벨로프 판정 키 */
export function adsrKey(adsr) {
  if (!adsr || !adsr.on) return 'off';
  return `${adsr.a}|${adsr.d}|${adsr.s}|${adsr.r}`;
}

/**
 * Gain 0…1 at `t` seconds into a run of length `dur`. Attack and decay are squeezed when the run
 * is shorter than a + d; the release starts at dur − r from whatever level the envelope has there.
 * 길이 dur인 구간의 t초 지점 게인. a + d가 구간보다 길면 압축, 릴리스는 dur − r 지점의 레벨에서 시작.
 */
export function adsrGainAt(adsr, t, dur) {
  if (!adsr || !adsr.on) return 1;
  const D = Math.max(1e-6, dur);
  const r = Math.min(Math.max(0, adsr.r), D);
  const relAt = D - r;
  const ad = Math.max(0, adsr.a) + Math.max(0, adsr.d);
  const k = ad > relAt && ad > 0 ? Math.max(0, relAt) / ad : 1; // squeeze A + D into the hold part / 압축
  const a = Math.max(0, adsr.a) * k;
  const d = Math.max(0, adsr.d) * k;
  const s = clamp(adsr.s, 0, 1);
  const ads = (x) => {
    if (x <= 0) return a > 0 ? 0 : 1;
    if (x < a) return x / a;
    if (x < a + d) return 1 + (s - 1) * ((x - a) / Math.max(1e-9, d));
    return a + d > 0 || s < 1 ? s : 1;
  };
  const x = clamp(t, 0, D);
  if (x <= relAt || r <= 0) return ads(x);
  return ads(relAt) * (1 - (x - relAt) / r);
}

/**
 * Multiply a gain curve in place by the ADSR of a line. Sample i sits `offsetSec + i / (n − 1) · playDur`
 * seconds into a run of `runDur` seconds (the line, or the joined run it belongs to). Off → untouched.
 * Every studio's scheduler calls this next to voiceModGainCurve. / 게인 곡선에 ADSR 곱하기 (모든 스튜디오 공용)
 */
export function applyAdsrToCurve(adsr, curve, offsetSec, playDur, runDur) {
  if (!adsr || !adsr.on || !curve || !curve.length) return curve;
  const n = curve.length;
  for (let i = 0; i < n; i++) curve[i] *= adsrGainAt(adsr, offsetSec + (n > 1 ? i / (n - 1) : 0) * playDur, runDur);
  return curve;
}

/**
 * Runs of back-to-back spans for one envelope ([{ t0, t1 }] sorted by t0): spans that touch (gap ≤ tol)
 * share one run, unless `retrig` — then every span is its own run. Returns { start, end } per span.
 * 맞닿은 구간을 하나의 엔벨로프 구간으로 묶음 (retrig이면 구간마다 따로).
 */
export function adsrSpanRuns(spans, retrig = false, tol = 0.002) {
  const out = spans.map((s) => ({ start: s.t0, end: s.t1 }));
  if (retrig) return out;
  let k = 0;
  while (k < spans.length) {
    let j = k;
    while (j + 1 < spans.length && Math.abs(spans[j + 1].t0 - spans[j].t1) <= tol) j++;
    for (let q = k; q <= j; q++) out[q] = { start: spans[k].t0, end: spans[j].t1 };
    k = j + 1;
  }
  return out;
}
