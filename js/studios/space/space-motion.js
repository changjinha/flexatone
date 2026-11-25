/**
 * Flexatone — studios/space/space-motion.js
 * Layer 2 (studios, pure): how far along its path a Space source is at source time τ, for speed
 * profiles drawn against time, path progress or distance to the listener. No DOM, no Web Audio.
 * 계층 2 (studios, 순수): 음원 시계 τ에서의 경로 위 위치 — 속도 프로파일의 x축이 시간 / 경로 진행도 /
 * 청취자와의 거리인 경우를 모두 다룸.
 *
 * Time modes / 시간 모드
 *   'speed' — the profile is in m/s; the time to traverse the path is the RESULT.
 *   'fit'   — the profile is relative; it is scaled so one traversal takes exactly `userDur`.
 *
 * Position-domain profiles v(pos) (constant speed, path and distance domains) are tabulated over
 * one period of the path. Between two table points v is linear in S, so
 *   dS/dτ = v_k + a·(S − S_k)   →   S(τ) = S_k + (v_k / a)·(exp(a·Δτ) − 1),  v(τ) = v_k·exp(a·Δτ)
 * which makes position and speed exactly consistent (the Doppler ratio uses the speed).
 * Time-domain profiles v(τ) are piecewise linear in τ and integrated exactly (trapezoid).
 * 위치 도메인: 구간 안에서 v가 S에 대해 선형 → 지수 해로 위치와 속도가 정확히 일치.
 *
 * Imports: core/math-utils.js.
 */

import { clamp } from '../../core/math-utils.js';

export const MOTION_N = 2048; // table resolution / 표 해상도
export const V_FLOOR = 0.05; // m/s floor of position-domain profiles (no division by zero) / 속도 하한
export const MAX_SOURCE_SEC = 300;

/**
 * @param {{ len: number, period: number, posOf: (S: number) => number }} path  period = len, or 2·len for ping-pong
 * @param {{ kind: 'pos', v: (pos: number) => number } | { kind: 'time', v: (tau: number) => number, ext: number }} spec
 * @param {{ timeMode: 'speed' | 'fit', userDur: number, wraps: boolean, vMax: number }} opts
 * @returns {{ dur, lapSec, rawMax, distAt(tau), speedAt(tau), scale }}
 */
export function buildMotion(path, spec, { timeMode = 'speed', userDur = 15, wraps = false, vMax = Infinity, life = null } = {}) {
  const len = Math.max(0, path.len);
  const period = Math.max(len, path.period || len);
  const N = MOTION_N;
  const fit = timeMode === 'fit';
  const want = clamp(userDur, 0.05, MAX_SOURCE_SEC);
  // `life`: how long a wrapping path keeps going (null = userDur). In 'fit' mode userDur is ONE lap. / 순환 경로의 지속 (fit 모드에서 userDur는 한 바퀴)
  const total = wraps && Number.isFinite(life) && life > 0 ? clamp(life, 0.05, MAX_SOURCE_SEC) : want;
  if (len < 1e-9) return { dur: want, lapSec: want, rawMax: 0, scale: 1, distAt: () => 0, speedAt: () => 0 };

  if (spec.kind === 'time') {
    const ext = Math.max(0.05, fit ? want : spec.ext);
    const raw = new Float64Array(N + 1);
    const dt = ext / N;
    let area = 0;
    for (let i = 0; i <= N; i++) {
      raw[i] = Math.max(0, spec.v(fit ? (i / N) * spec.ext : i * dt));
      if (i) area += 0.5 * (raw[i] + raw[i - 1]) * dt;
    }
    const scale = fit ? (area > 1e-9 ? len / area : 0) : 1;
    const vt = new Float64Array(N + 1);
    const cs = new Float64Array(N + 1);
    let rawMax = 0;
    for (let i = 0; i <= N; i++) {
      const v = raw[i] * scale;
      rawMax = Math.max(rawMax, v);
      vt[i] = Math.min(v, vMax);
      if (i) cs[i] = cs[i - 1] + 0.5 * (vt[i] + vt[i - 1]) * dt;
    }
    const vEnd = vt[N];
    const distAt = (tau) => {
      if (tau >= ext) return cs[N] + vEnd * (tau - ext);
      const s = clamp(tau / ext, 0, 1) * N;
      const i = Math.min(N - 1, Math.floor(s));
      const f = s - i;
      const v1 = vt[i] + (vt[i + 1] - vt[i]) * f;
      return cs[i] + 0.5 * (vt[i] + v1) * f * dt;
    };
    const speedAt = (tau) => {
      if (tau >= ext) return vEnd;
      const s = clamp(tau / ext, 0, 1) * N;
      const i = Math.min(N - 1, Math.floor(s));
      return vt[i] + (vt[i + 1] - vt[i]) * (s - i);
    };
    // Time at which one traversal (len) is complete / 한 번 주행이 끝나는 시각
    let lapSec;
    if (cs[N] >= len) {
      let lo = 0;
      let hi = N;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cs[mid] <= len) lo = mid; else hi = mid; }
      // solve the quadratic of the linear-speed segment / 구간의 2차식 풀이
      const a = (vt[hi] - vt[lo]) / dt;
      const need = len - cs[lo];
      const x = Math.abs(a) < 1e-12 ? (vt[lo] > 0 ? need / vt[lo] : dt) : (-vt[lo] + Math.sqrt(Math.max(0, vt[lo] * vt[lo] + 2 * a * need))) / a;
      lapSec = lo * dt + clamp(x, 0, dt);
    } else lapSec = vEnd > 1e-6 ? ext + (len - cs[N]) / vEnd : Infinity;
    const dur = wraps ? total : clamp(Number.isFinite(lapSec) ? lapSec : ext, 0.05, MAX_SOURCE_SEC);
    return { dur, lapSec, rawMax, scale, distAt, speedAt };
  }

  // Position domain / 위치 도메인
  const dS = period / N;
  const raw = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) raw[i] = Math.max(0, spec.v(path.posOf(Math.min(period, i * dS))));
  const table = (scale) => {
    const v = new Float64Array(N + 1);
    const tt = new Float64Array(N + 1);
    let rawMax = 0;
    for (let i = 0; i <= N; i++) {
      const x = raw[i] * scale;
      rawMax = Math.max(rawMax, x);
      v[i] = clamp(x, V_FLOOR, Math.max(V_FLOOR, vMax));
    }
    for (let i = 0; i < N; i++) {
      const a = (v[i + 1] - v[i]) / dS;
      tt[i + 1] = tt[i] + (Math.abs(a) < 1e-12 ? dS / v[i] : Math.log(v[i + 1] / v[i]) / a);
    }
    return { v, tt, rawMax };
  };
  /** Time of the first traversal of `len` (the period may be 2·len). / len 한 번 주행 시간 */
  const lapOf = (tab) => {
    const s = (len / period) * N;
    const i = Math.min(N - 1, Math.floor(s));
    return tab.tt[i] + (tab.tt[i + 1] - tab.tt[i]) * (s - i);
  };
  let tab = table(1);
  let scale = 1;
  if (fit) {
    scale = lapOf(tab) / want;
    tab = table(scale);
  }
  const { v, tt } = tab;
  const T = tt[N];
  const lapSec = lapOf(tab);
  const seg = (rem) => {
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tt[mid] <= rem) lo = mid; else hi = mid; }
    return lo;
  };
  const local = (tau) => {
    if (!wraps && tau >= lapSec) return [0, len, 0, true];
    const lap = wraps ? Math.floor(tau / T) : 0;
    const rem = Math.max(0, tau - lap * T);
    const i = seg(rem);
    const a = (v[i + 1] - v[i]) / dS;
    const d = rem - tt[i];
    const e = Math.abs(a) < 1e-12 ? 1 : Math.exp(a * d);
    const S = Math.min(dS, Math.abs(a) < 1e-12 ? v[i] * d : (v[i] / a) * (e - 1));
    return [lap, i * dS + S, v[i] * e, false];
  };
  const distAt = (tau) => { const [lap, S] = local(tau); return lap * period + S; };
  const speedAt = (tau) => { const [, , spd, done] = local(tau); return done ? 0 : spd; };
  const dur = wraps ? total : clamp(lapSec, 0.05, MAX_SOURCE_SEC);
  return { dur, lapSec, rawMax: tab.rawMax, scale, distAt, speedAt };
}

/** Position along the path for an unbounded distance S. / 누적 거리 S → 경로 위 위치 */
export function pathPosition(S, len, end) {
  if (len <= 0) return { pos: 0, dir: 1, moving: false };
  if (end === 'loop') return { pos: ((S % len) + len) % len, dir: 1, moving: true };
  if (end === 'pingpong') {
    const m = ((S % (2 * len)) + 2 * len) % (2 * len);
    return m <= len ? { pos: m, dir: 1, moving: true } : { pos: 2 * len - m, dir: -1, moving: true };
  }
  if (S >= len) return { pos: len, dir: 1, moving: false };
  return { pos: Math.max(0, S), dir: 1, moving: true };
}
