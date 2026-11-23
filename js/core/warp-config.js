/**
 * Flexatone — core/warp-config.js
 * Layer 0 (core): the "Warp" (pitch-space curvature) setting of a Manager track (pure data).
 * 계층 0 (core): 매니저 트랙의 "곡률"(피치 공간 휘기) 설정 (순수 데이터).
 *
 * A track with warp.on does not sound: its lines (or rules / field) bend the pitch space of the
 * other tracks while its clip [start, start + length) plays in the cycle. The maths is in
 * modules/pitch-warp.js, the per-studio sources in audio/warp-sources.js.
 * 곡률이 켜진 트랙은 소리 내지 않고, 클립 구간 동안 선(또는 규칙·장)으로 다른 트랙의 피치 공간을 휨.
 *
 *   on        true = this track is a warp source (silent)
 *   params    what the bend drives in the target tracks, each { on, sens } (sens −5…5, 1 = default):
 *               pitch   m' = m + sens·D                       (D = displacement in semitones)
 *               level   + sens·D dB                            (−60…+12 dB)
 *               trem    tremolo depth: sens > 0 → |sens·D|/12 (trembles where bent),
 *                       sens < 0 → 1 − |sens·D|/12 (trembles where straight); rate = the track tremolo rate
 *               time    time density: the target plays at r = 2^(sens·D/12) (an octave above the
 *                       line's first pitch = twice as dense); timeMode 'keep' (pitch kept) | 'tape' (speed
 *                       and pitch together); timeClock 'track' (one clock, read at the track's first pitch) |
 *                       'voice' (every voice its own clock, read at its own first pitch)
 *               bright  brightness: high-shelf above the 2nd harmonic, 12·sens·D/12 dB
 *                       (Wave: spectral tilt; Risset: the bank's dB/oct tilt at the bell centre)
 *   targets   [] = every audible track, else the ids of the tracks it bends
 *   rest      'start' (rest pitch = first pitch of a line) | 'mean' (mean pitch of a line)
 *   after     'hold' (keep the last displacement after a line ends) | 'return' (back to 0 in returnSec)
 *   mode      studio option (see WARP_MODES): Risset frame / rotate, Field lines / field,
 *             Draw global / brush, Space obs / src, Wave auto / disp / energy
 *   radius    brush radius in semitones (Draw brush)
 *   amount    semitones of the largest displacement (Wave disp)
 *   smooth    time smoothing in seconds (Wave)
 *   sieve     0…1 pull toward the sieve pitches (Cloud)
 */

import { clamp } from './math-utils.js';

/** Studio-specific options; the first one is the default. / 스튜디오별 모드 (첫 번째가 기본) */
export const WARP_MODES = Object.freeze({
  risset: Object.freeze(['frame', 'rotate']),
  field: Object.freeze(['lines', 'field']),
  draw: Object.freeze(['global', 'brush']),
  space: Object.freeze(['obs', 'src']),
  wave: Object.freeze(['auto', 'disp', 'energy']),
});
export const WARP_RESTS = Object.freeze(['start', 'mean']);
export const WARP_AFTER = Object.freeze(['hold', 'return']);
/** Parameters a warp can drive, in UI order. / 곡률이 움직일 수 있는 매개변수 */
export const WARP_PARAMS = Object.freeze(['pitch', 'time', 'level', 'trem', 'bright']);
export const WARP_TIME_MODES = Object.freeze(['keep', 'tape']);
export const WARP_TIME_CLOCKS = Object.freeze(['track', 'voice']);
export const WARP_SENS_MIN = -5;
export const WARP_SENS_MAX = 5;

function createDefaultWarpParams() {
  const out = {};
  for (const k of WARP_PARAMS) out[k] = { on: k === 'pitch', sens: 1 };
  return out;
}

export function createDefaultWarp(studio = '') {
  return {
    on: false,
    params: createDefaultWarpParams(),
    targets: [],
    timeMode: 'keep',
    timeClock: 'track',
    rest: 'start',
    after: 'hold',
    returnSec: 1,
    mode: WARP_MODES[studio]?.[0] ?? '',
    radius: 3,
    amount: 6,
    smooth: 0.15,
    sieve: 0,
  };
}

const num = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : fb);

/** Sanitize a warp object of a `studio` track. / 곡률 설정 정규화 */
export function normalizeWarp(raw, studio = '') {
  const d = createDefaultWarp(studio);
  const r = raw && typeof raw === 'object' ? raw : {};
  const modes = WARP_MODES[studio];
  // Projects from before params had one pitch `depth` (0…2) / 이전 프로젝트의 depth는 음고 민감도로
  const rp = r.params && typeof r.params === 'object' ? r.params : { pitch: { on: true, sens: num(r.depth, WARP_SENS_MIN, WARP_SENS_MAX, 1) } };
  const params = {};
  for (const k of WARP_PARAMS) {
    const q = rp[k] && typeof rp[k] === 'object' ? rp[k] : {};
    params[k] = { on: q.on === undefined ? d.params[k].on : !!q.on, sens: num(q.sens, WARP_SENS_MIN, WARP_SENS_MAX, 1) };
  }
  return {
    on: !!r.on,
    params,
    targets: Array.isArray(r.targets) ? [...new Set(r.targets.filter((x) => typeof x === 'string'))].slice(0, 64) : [],
    timeMode: WARP_TIME_MODES.includes(r.timeMode) ? r.timeMode : d.timeMode,
    timeClock: WARP_TIME_CLOCKS.includes(r.timeClock) ? r.timeClock : d.timeClock,
    rest: WARP_RESTS.includes(r.rest) ? r.rest : d.rest,
    after: WARP_AFTER.includes(r.after) ? r.after : d.after,
    returnSec: num(r.returnSec, 0.05, 30, d.returnSec),
    mode: modes ? (modes.includes(r.mode) ? r.mode : modes[0]) : '',
    radius: num(r.radius, 0.5, 48, d.radius),
    amount: num(r.amount, 0, 48, d.amount),
    smooth: num(r.smooth, 0, 5, d.smooth),
    sieve: num(r.sieve, 0, 1, d.sieve),
  };
}

/** Merge a patch into a warp object (normalized). / 패치 병합 */
export function patchWarp(warp, patch, studio = '') {
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...(warp || {}), ...p };
  // params merge per parameter: { params: { level: { on: true } } } keeps the others / 매개변수별 병합
  if (p.params && typeof p.params === 'object') {
    merged.params = { ...(warp?.params || {}) };
    for (const [k, v] of Object.entries(p.params)) merged.params[k] = { ...(warp?.params?.[k] || {}), ...(v || {}) };
  }
  return normalizeWarp(merged, studio);
}
