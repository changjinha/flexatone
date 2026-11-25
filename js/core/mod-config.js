/**
 * Flexatone — core/mod-config.js
 * Layer 1 (core, pure): the Manager **Modulation** matrix — routes from a signal of one track to a
 * parameter of another track, in cycle time. Covers three things with one route format:
 *   - parameter modulation (A2): a track's pitch line (normalised 0…1) drives level / tremolo / brightness /
 *     pitch of another track, or a curve of its document (Cloud density · width · collapse · centre)
 *   - sidechain (A3): the loudness envelope of a track (follower: attack / release) drives another track,
 *     e.g. ducking = Level −12 dB × envelope
 *   - triggers (A4): events of a track (line onsets, a line crossing its centre, loudness peaks) as an
 *     attack / decay pulse, or **Retrigger**: every event restarts the target clip from its beginning
 * Evaluation happens at render time (audio/mod-sources.js + audio/manager-mixer.js), so playback, WAV and
 * video hear the same thing. Several routes on one target add up.
 * 계층 1 (core, 순수): 매니저 모듈레이션 매트릭스 — 한 트랙의 신호가 다른 트랙의 파라미터를 사이클 시간 위에서 움직임.
 * 파라미터 합성(A2) · 사이드체인(A3) · 트리거(A4)를 같은 라우트 형식으로.
 *
 * Route / 라우트:
 *   { id, on, src: { inst, kind: 'pitch' | 'env' | 'trig', line, trig: 'onset' | 'cross' | 'peak', thrDb },
 *     dst: { inst, param }, amount, invert, attackMs, releaseMs }
 */

import { clamp, uid } from './math-utils.js';

export const MOD_KINDS = Object.freeze(['pitch', 'env', 'trig']);
export const TRIG_KINDS = Object.freeze(['onset', 'cross', 'peak']);
export const MEAN_KEY = 'mean';

/**
 * Targets: unit, amount range and default. `doc` targets change the target's document before it is rendered.
 * 대상: 단위, 양의 범위, 기본값. doc 대상은 렌더 전에 대상 문서를 바꿈.
 */
export const MOD_TARGETS = Object.freeze({
  gain: { unit: 'dB', min: -48, max: 24, step: 0.5, def: -12 },
  trem: { unit: '', min: -1, max: 1, step: 0.05, def: 0.8 },
  bright: { unit: '', min: -2, max: 2, step: 0.05, def: 1 },
  pitch: { unit: 'st', min: -24, max: 24, step: 0.1, def: 7 },
  retrig: { unit: '', min: 0, max: 1, step: 1, def: 1, trigOnly: true },
  'cloud.density': { unit: '× range', min: -1, max: 1, step: 0.05, def: 0.6, studio: 'cloud', doc: true },
  'cloud.width': { unit: '× range', min: -1, max: 1, step: 0.05, def: 0.5, studio: 'cloud', doc: true },
  'cloud.collapse': { unit: '× range', min: -1, max: 1, step: 0.05, def: 0.8, studio: 'cloud', doc: true },
  'cloud.center': { unit: '× range', min: -1, max: 1, step: 0.05, def: 0.3, studio: 'cloud', doc: true },
  // Space document targets (audio/space-mod.js): written into the clip's document, so the clip re-bakes / 스페이스 문서 대상
  'space.c': { unit: '× c', min: -0.95, max: 0.95, step: 0.01, def: -0.4, studio: 'space', doc: true },
  'space.yaw': { unit: '°', min: -720, max: 720, step: 1, def: 90, studio: 'space', doc: true },
  'space.air': { unit: '×', min: -4, max: 4, step: 0.05, def: 1.5, studio: 'space', doc: true },
  'space.width': { unit: '', min: -1, max: 1, step: 0.05, def: 0.6, studio: 'space', doc: true },
});
export const MOD_TARGET_IDS = Object.freeze(Object.keys(MOD_TARGETS));

/** Targets offered for a studio (doc targets only for their studio, retrigger only for buffer clips). */
export function targetsFor(studio) {
  return MOD_TARGET_IDS.filter((id) => {
    const s = MOD_TARGETS[id];
    if (s.studio && s.studio !== studio) return false;
    if (id === 'retrig' && studio === 'risset') return false; // live engine, no clip to restart / 실시간 엔진
    return true;
  });
}

/** Does a source depend on the rendered sound of its track (→ ordering / loops)? / 렌더된 소리에 의존? */
export const usesSound = (src) => src.kind === 'env' || (src.kind === 'trig' && src.trig === 'peak');

const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

export function createMod({ srcInst, dstInst, kind = 'pitch', param = 'gain' } = {}) {
  const spec = MOD_TARGETS[param] || MOD_TARGETS.gain;
  return normalizeMod({
    id: uid('md_', 6),
    on: true,
    src: { inst: srcInst, kind, line: MEAN_KEY, trig: 'onset', thrDb: -24 },
    dst: { inst: dstInst, param },
    amount: spec.def,
    invert: false,
    attackMs: kind === 'env' ? 10 : 5,
    releaseMs: kind === 'env' ? 250 : 180,
  });
}

export function normalizeMod(raw, instIds = null) {
  if (!raw || typeof raw !== 'object' || !raw.src || !raw.dst) return null;
  if (typeof raw.src.inst !== 'string' || typeof raw.dst.inst !== 'string') return null;
  if (instIds && (!instIds.has(raw.src.inst) || !instIds.has(raw.dst.inst))) return null;
  const param = MOD_TARGETS[raw.dst.param] ? raw.dst.param : 'gain';
  const spec = MOD_TARGETS[param];
  let kind = MOD_KINDS.includes(raw.src.kind) ? raw.src.kind : 'pitch';
  if (spec.trigOnly) kind = 'trig';
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid('md_', 6),
    on: raw.on !== false,
    src: {
      inst: raw.src.inst,
      kind,
      line: raw.src.line == null || raw.src.line === '' ? MEAN_KEY : String(raw.src.line),
      trig: TRIG_KINDS.includes(raw.src.trig) ? raw.src.trig : 'onset',
      thrDb: clamp(num(raw.src.thrDb, -24), -80, 0),
    },
    dst: { inst: raw.dst.inst, param },
    amount: clamp(num(raw.amount, spec.def), spec.min, spec.max),
    invert: !!raw.invert,
    attackMs: clamp(num(raw.attackMs, 5), 0, 2000),
    releaseMs: clamp(num(raw.releaseMs, 180), 1, 10000),
  };
}

export function normalizeMods(list, instIds = null) {
  return (Array.isArray(list) ? list : []).map((m) => normalizeMod(m, instIds)).filter(Boolean);
}

/**
 * Status of every route in list order: 'ok' | 'off' | 'self' (a track listening to its own sound) |
 * 'loop' (would close a cycle through sound-dependent sources) | 'kind' (retrigger needs a trigger source).
 * Only sound-dependent sources (envelope, peaks) can form a loop; pitch lines and onsets read documents.
 * 각 라우트 상태. 소리에 의존하는 출처(엔벨로프·피크)만 순환을 만들 수 있음.
 */
export function modStatuses(mods) {
  const adj = new Map();
  const reach = (a, b) => {
    const seen = new Set();
    const st = [a];
    while (st.length) {
      const x = st.pop();
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of adj.get(x) || []) st.push(y);
    }
    return false;
  };
  // any route that changes a track's sound makes its sound depend on the route's source / 소리를 바꾸는 라우트
  return mods.map((m) => {
    if (!m.on) return 'off';
    if (MOD_TARGETS[m.dst.param]?.trigOnly && m.src.kind !== 'trig') return 'kind';
    const sound = usesSound(m.src);
    if (sound && m.src.inst === m.dst.inst) return 'self';
    // edge src → dst exists for every route (dst's sound depends on src); a loop matters only when a
    // sound-dependent route closes it / 모든 라우트가 src → dst 간선, 순환은 소리 의존 라우트가 닫을 때만 문제
    if (sound && reach(m.dst.inst, m.src.inst)) return 'loop';
    if (!adj.has(m.src.inst)) adj.set(m.src.inst, new Set());
    adj.get(m.src.inst).add(m.dst.inst);
    return 'ok';
  });
}

// --------------------------------------------------------------------------
// Signal helpers (pure) / 신호 도우미
// --------------------------------------------------------------------------

/** One-pole follower over a frame series (dt seconds per frame): attack / release in ms. / 엔벨로프 팔로워 */
export function followEnvelope(values, dt, attackMs, releaseMs) {
  const out = new Float32Array(values.length);
  const ka = attackMs > 0 ? 1 - Math.exp(-dt / (attackMs / 1000)) : 1;
  const kr = releaseMs > 0 ? 1 - Math.exp(-dt / (releaseMs / 1000)) : 1;
  let y = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    y += (x - y) * (x > y ? ka : kr);
    out[i] = y;
  }
  return out;
}

/** dBFS → 0…1 (−60 dB → 0, 0 dB → 1). / dB → 0…1 */
export const dbToUnit = (db) => clamp((db + 60) / 60, 0, 1);

/**
 * Peaks of a dB series: a peak starts when the level rises above `thrDb` (re-armed 3 dB below), at least
 * `minGap` seconds apart. Returns times in seconds (frame times × dt). / 피크 시각
 */
export function findPeaks(dbFrames, dt, thrDb, minGap = 0.06) {
  const out = [];
  let armed = true;
  let last = -Infinity;
  for (let i = 0; i < dbFrames.length; i++) {
    const v = dbFrames[i];
    if (armed && v >= thrDb && i * dt - last >= minGap) { out.push(i * dt); last = i * dt; armed = false; }
    else if (!armed && v < thrDb - 3) armed = true;
  }
  return out;
}

/** Upward crossings of a line's centre (mean of min and max): times. / 선이 중심을 위로 지나는 시각 */
export function findCrossings(pts) {
  const ok = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.m));
  if (ok.length < 2) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of ok) { lo = Math.min(lo, p.m); hi = Math.max(hi, p.m); }
  const c = 0.5 * (lo + hi);
  const out = [];
  for (let i = 1; i < ok.length; i++) {
    const a = ok[i - 1];
    const b = ok[i];
    if (a.m < c && b.m >= c) out.push(a.t + ((c - a.m) / Math.max(1e-9, b.m - a.m)) * (b.t - a.t));
  }
  return out;
}

/**
 * Attack / decay pulse train from sorted event times: value(T) = max over events of the pulse
 * (linear rise over attack, exponential decay with time constant release). / 이벤트 → 펄스열
 */
export function pulseTrain(times, attackMs, releaseMs) {
  const ts = [...times].filter(Number.isFinite).sort((a, b) => a - b);
  const A = Math.max(0, attackMs) / 1000;
  const R = Math.max(1e-3, releaseMs) / 1000;
  const reach = A + 6 * R;
  return (T) => {
    // binary search the last event ≤ T, then look back while it can still matter / 이분 탐색 후 영향 범위만
    let lo = 0;
    let hi = ts.length - 1;
    let k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= T) { k = m; lo = m + 1; } else hi = m - 1; }
    let v = 0;
    for (let i = k; i >= 0 && T - ts[i] <= reach; i--) {
      const d = T - ts[i];
      const p = d < A ? d / A : Math.exp(-(d - A) / R);
      if (p > v) v = p;
      if (v >= 1) break;
    }
    return v;
  };
}

/** Linear lookup in a frame series (dt per frame, starting at t0); outside → 0. / 프레임 열 보간 */
export function frameAt(frames, dt, t) {
  if (!(t >= 0)) return 0;
  const x = t / dt;
  const i = Math.floor(x);
  if (i >= frames.length - 1) return i === frames.length - 1 ? frames[i] : 0;
  const f = x - i;
  return frames[i] + f * (frames[i + 1] - frames[i]);
}
