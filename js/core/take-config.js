/**
 * Flexatone — core/take-config.js
 * Layer 0 (core): the "take" setting of a Manager track (pure data, no DOM / audio).
 * 계층 0 (core): 매니저 트랙의 "테이크" 설정 (순수 데이터).
 *
 * A track with take.on does not play its document directly. It plays a *take*: the sound a clip made
 * when it sat at cycle time `at` for `len` seconds (looping or not), with the shape masks and Warp
 * tracks that reached the track `as` there — optionally time-reversed (`rev`, the retrograde).
 * The track's own start / length / loop / fades then place that take like a plain audio clip whose
 * natural length is `len`. The Extend tools (core/manager-extend.js) create takes; the mixer renders
 * them (audio/manager-mixer.js renderTake).
 * take.on인 트랙은 문서를 직접 재생하지 않고 "테이크"를 재생: 클립이 사이클 시각 at에 len초 동안 놓였을 때의
 * 소리(트랙 as에 닿던 모양 마스크·곡률 포함)이며, rev면 시간 역행. 트랙의 시작·길이·반복·페이드는 그 테이크를
 * 자연 길이 len인 오디오 클립처럼 배치.
 *
 *   on     true = this track plays a take
 *   rev    true = reversed in time (retrograde) / 시간 역행
 *   mirror true = settings retrograde: the clip is rendered with its score mirrored in time — curves,
 *          envelopes, entries reflected — while every sound still plays forwards (audio/time-mirror.js).
 *          Unlike rev an attack stays an attack. / 설정 역행: 악보만 뒤집고 소리는 순방향 (어택 유지)
 *   as     id of the track whose masks / warps applied (null or missing track = this track itself)
 *   at     cycle time (s) where the forward clip started / 원래 클립 시작 시각
 *   len    length (s) of the forward clip = natural length of the take / 원래 클립 길이
 *   loop   whether the forward clip looped inside `len` / 원래 클립의 반복 여부
 *   inner  the take the forward clip itself played (a take of a take), or null / 원래 클립이 테이크였다면 그 설정
 *   raw    true = without the range solo / mute rules of the cycle (the clip itself, not its place in the
 *          arrangement); shape masks and Warps still apply / 구간 솔로·뮤트 규칙 없이 (모양 마스크·곡률은 적용)
 *   rate   tape ratio the take is played at: speed and pitch together (2 = twice as fast, an octave up);
 *          its natural length is then len / rate / 테이프 배율 (속도·음고 동시 변화), 자연 길이 = len / rate
 *   off    seconds trimmed from the start of the take as it is played (before the tape ratio), so a take can
 *          begin inside the clip; its natural length is then (len − off) / rate. Used by Interpolate
 *          (core/manager-interpolate.js). / 재생되는 테이크의 앞부분에서 잘라낼 초 (클립 중간에서 시작하는 테이크)
 *   warps  ids of the Warp tracks whose bend the take keeps (the Warp tracks that were checked when Extend
 *          ran), or null = every Warp track that reached it / 테이크에 남길 곡률 트랙 id (null = 전체)
 */

import { clamp } from './math-utils.js';

export const TAKE_MAX_DEPTH = 6;
export const TAKE_RATE_MIN = 0.25;
export const TAKE_RATE_MAX = 4;
const TAKE_MAX_SEC = 600;

export function createDefaultTake() {
  return { on: false, rev: false, mirror: false, as: null, at: 0, len: 0, loop: false, inner: null, rate: 1, raw: false, off: 0, warps: null };
}

const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

/** Sanitize a take (off / malformed → the default, off). / 테이크 정규화 */
export function normalizeTake(raw, depth = 0) {
  const d = createDefaultTake();
  if (!raw || typeof raw !== 'object' || raw.on !== true) return d;
  const len = num(raw.len, 0);
  if (!(len >= 0.02)) return d;
  const inner = depth < TAKE_MAX_DEPTH && raw.inner && raw.inner.on === true ? normalizeTake(raw.inner, depth + 1) : null;
  return {
    on: true,
    rev: raw.rev === true,
    mirror: raw.mirror === true && raw.rev !== true,
    as: typeof raw.as === 'string' && raw.as ? raw.as : null,
    at: clamp(num(raw.at, 0), 0, TAKE_MAX_SEC),
    len: clamp(len, 0.02, TAKE_MAX_SEC),
    loop: raw.loop === true,
    inner: inner && inner.on ? inner : null,
    rate: clamp(num(raw.rate, 1) || 1, TAKE_RATE_MIN, TAKE_RATE_MAX),
    raw: raw.raw === true,
    off: clamp(num(raw.off, 0), 0, Math.max(0, Math.min(len, TAKE_MAX_SEC) - 0.02)),
    warps: Array.isArray(raw.warps) ? raw.warps.filter((x) => typeof x === 'string' && x).slice(0, 64) : null,
  };
}

/** Rescale the times of a take (and its inner takes) by `k` — master tempo changes. / 시간 재스케일 */
export function scaleTake(take, k) {
  let tk = take;
  for (let d = 0; tk && tk.on && d <= TAKE_MAX_DEPTH; d++) {
    tk.at = Math.round(tk.at * k * 1e6) / 1e6;
    tk.len = Math.max(0.02, Math.round(tk.len * k * 1e6) / 1e6);
    if (tk.off) tk.off = Math.round(tk.off * k * 1e6) / 1e6;
    tk = tk.inner;
  }
  return take;
}

/** Number of reversals along a take chain (odd = heard backwards). / 역행 횟수 */
export function takeReversals(take) {
  let n = 0;
  let tk = take;
  for (let d = 0; tk && tk.on && d <= TAKE_MAX_DEPTH; d++) { if (tk.rev || tk.mirror) n++; tk = tk.inner; }
  return n;
}

/** Seconds trimmed from the start of the played take (0 … len − 0.02). / 테이크 앞부분에서 잘라낸 초 */
export function takeOffset(take) {
  return take && take.on ? clamp(Number(take.off) || 0, 0, Math.max(0, take.len - 0.02)) : 0;
}

/** Natural length (s) of a take as it is played: (len − off) / rate. / 재생되는 테이크의 자연 길이 */
export function takeLength(take) {
  return take && take.on ? (take.len - takeOffset(take)) / (Number(take.rate) > 0 ? Number(take.rate) : 1) : 0;
}
