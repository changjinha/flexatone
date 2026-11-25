/**
 * Flexatone — audio/space-mod.js
 * Layer 3 (audio): Space Studio in the Manager **Modulation** matrix (core/mod-config.js,
 * audio/mod-sources.js) — as a source of signals and as a target of document modulation.
 * 계층 3 (audio): 매니저 모듈레이션 매트릭스 안의 스페이스 스튜디오 — 신호의 출처이자 문서 모듈레이션의 대상.
 *
 * Signals (offered as extra lines of a Space track, next to its heard-pitch lines; a route reads a
 * line normalised to 0…1 over its own range) / 신호 (트랙의 추가 선):
 *   <source>:r         distance to the listener (m)
 *   <source>:vr        radial speed (m/s; negative = approaching)
 *   <source>:az        azimuth (°, positive = right)        <source>:el   elevation (°)
 *   <source>:shift     Doppler shift (semitones) = 12·log₂(f_obs / f_s)
 *   <source>:approach  −1 while the source comes nearer, +1 while it recedes. With the trigger
 *                      "crossing" it fires at the closest approach (the moment the radial speed
 *                      heard at the listener changes sign), placed between two bake samples.
 * All in LISTENER time (what is heard when), like the pitch lines.
 *
 * Document targets (written into the document before it is rendered, so they re-bake that clip —
 * never the live graph) / 문서 대상 (렌더 전에 문서에 기록 → 그 클립만 재베이킹):
 *   space.c      the speed-of-sound scale against time (document `cEnv`)
 *   space.yaw    the listener's yaw against time (orientation envelopes)
 *   space.air    air-absorption amount of every source      space.width   HOA source width
 * Level, tremolo, brightness and pitch of a Space track are the ordinary bake-free targets.
 */

import { I18N } from '../core/i18n.js';

const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r4 = (x) => Number(x.toFixed(4));
export const SPACE_SIGNALS = Object.freeze(['r', 'vr', 'az', 'el', 'shift', 'approach']);
export const SPACE_DOC_TARGETS = Object.freeze(['space.c', 'space.yaw', 'space.air', 'space.width']);

Object.assign(I18N.en, {
  'mods.param.space.c': 'Space: speed of sound', 'mods.param.space.yaw': 'Space: listener yaw', 'mods.param.space.air': 'Space: air absorption', 'mods.param.space.width': 'Space: source width',
  'space.sig.r': 'distance', 'space.sig.vr': 'radial speed', 'space.sig.az': 'azimuth', 'space.sig.el': 'elevation', 'space.sig.shift': 'Doppler shift', 'space.sig.approach': 'approach → recede',
});
Object.assign(I18N.ko, {
  'mods.param.space.c': '스페이스: 음속', 'mods.param.space.yaw': '스페이스: 청취자 방위', 'mods.param.space.air': '스페이스: 공기 흡수', 'mods.param.space.width': '스페이스: 음원 폭',
  'space.sig.r': '거리', 'space.sig.vr': '시선 속도', 'space.sig.az': '방위', 'space.sig.el': '고도', 'space.sig.shift': '도플러 편이', 'space.sig.approach': '접근 → 이탈',
});

/**
 * Signal lines of a baked Space document: [{ key, name, pts: [{ t, m }] }].
 * `sources` = [{ id, name }] in the order wanted, `bake` = bakeSpace(doc), `label(kind)` = display name.
 * 베이킹된 스페이스 문서의 신호 선.
 */
export function spaceSignalLines(sources, bake, label = (k) => k) {
  const out = [];
  for (const s of sources) {
    const b = bake.sources.get(s.id);
    if (!b || b.n < 2) continue;
    const step = Math.max(1, Math.floor(b.n / 600));
    const line = (kind, fn) => {
      const pts = [];
      for (let i = 0; i < b.n; i += step) pts.push({ t: b.t[i], m: fn(i) });
      if ((b.n - 1) % step) pts.push({ t: b.t[b.n - 1], m: fn(b.n - 1) });
      out.push({ key: `${s.id}:${kind}`, name: `${s.name} · ${label(kind)}`, pts });
    };
    line('r', (i) => b.r[i]);
    line('vr', (i) => b.vr[i]);
    line('az', (i) => b.az[i]);
    line('el', (i) => (Math.asin(clamp(b.up[i], -1, 1)) * 180) / Math.PI);
    line('shift', (i) => 12 * Math.log2(Math.max(1e-9, b.fObs[i]) / Math.max(1e-9, b.fs[i])));
    // approach: a step at every sign change of the radial speed, at the interpolated time / 시선 속도의 부호가 바뀌는 보간 시각마다 계단
    const pts = [{ t: b.t[0], m: b.vr[0] < 0 ? -1 : 1 }];
    for (let i = 1; i < b.n; i++) {
      const a = b.vr[i - 1], c = b.vr[i];
      if ((a < 0) === (c < 0)) continue;
      const tc = b.t[i - 1] + ((b.t[i] - b.t[i - 1]) * a) / (a - c);
      pts.push({ t: tc - 1e-6, m: a < 0 ? -1 : 1 }, { t: tc + 1e-6, m: c < 0 ? -1 : 1 });
    }
    pts.push({ t: b.t[b.n - 1], m: b.vr[b.n - 1] < 0 ? -1 : 1 });
    out.push({ key: `${s.id}:approach`, name: `${s.name} · ${label('approach')}`, pts });
  }
  return out;
}

/** A time envelope (Space lane object) through `vals` sampled evenly over `span` seconds. / 값 목록을 지나는 시간 엔벨로프 */
function timeLane(vals, span) {
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-9) hi = lo + 1e-6;
  const n = vals.length;
  return {
    on: true, domain: 'time', dom: [0, span], min: r4(lo), max: r4(hi), scale: 'lin',
    curve: { engine: 'custom', reverse: false, inverse: false, customPoints: vals.map((v, i) => ({ x: r4(i / (n - 1)), y: r4((v - lo) / (hi - lo)), handles: [] })) },
  };
}

/**
 * Write the document modulation of a Space clip into (a copy of) its params.
 * `fns` = { 'space.c': (T) → amount·signal, … } in cycle time; the clip's first sample sits at cycle
 * time `start`, `rate` = document seconds per real second. `laneAt(lane, kind, x01)` evaluates an
 * existing Space lane at a position 0…1 of its range (studios/space/space-lanes.js).
 * 스페이스 클립의 문서 모듈레이션을 파라미터 사본에 기록.
 */
export function applySpaceDocMods(fns, params, start, rate, laneAt, N = 64) {
  if (!fns || !params) return params;
  const out = { ...params };
  const len = Math.max(1, num(params.length, 30));
  const T = (docSec) => start + docSec / Math.max(1e-6, rate);
  const grid = (span, base, fn, lo, hi, offset = 0) => Array.from({ length: N }, (_, i) => { const x = i / (N - 1); return clamp(base(x) + fn(T(offset + x * span)), lo, hi); });
  if (fns['space.c']) {
    const cur = params.cEnv?.on ? params.cEnv : null;
    const flat = clamp(num(params.cScale, 1), 0.05, 1);
    out.cEnv = timeLane(grid(len, (x) => (cur ? laneAt(cur, 'cscale', x) : flat), fns['space.c'], 0.05, 1), len);
    out.cEnv.dom = null; // the document's own span / 문서 길이
  }
  if (fns['space.yaw']) {
    const L = params.listener || {};
    const or = L.orient || { mode: 'fixed' };
    if (or.mode === 'fixed' || or.mode === 'lanes' || !or.mode) {
      const lanes = or.mode === 'lanes';
      const constLane = (v) => ({ ...timeLane([v, v], len), dom: null });
      const yaw = { ...timeLane(grid(len, (x) => (lanes && or.yaw ? laneAt(or.yaw, 'yaw', x) : num(L.headingDeg, 0)), fns['space.yaw'], -3600, 3600), len), dom: null };
      out.listener = { ...L, orient: { ...or, mode: 'lanes', yaw, pitch: lanes && or.pitch ? or.pitch : constLane(num(L.pitchDeg, 0)), roll: lanes && or.roll ? or.roll : constLane(num(L.rollDeg, 0)) } };
    }
  }
  for (const [target, kind, lo, hi, neutral] of [['space.air', 'air', 0, 8, 1], ['space.width', 'width', 0, 1, 0]]) {
    const fn = fns[target];
    if (!fn) continue;
    out.sources = (out.sources || []).map((s) => {
      const cur = s.lanes?.[kind];
      if (cur?.on && cur.domain !== 'time') return s; // an envelope against path / distance keeps its meaning / 경로·거리 도메인 엔벨로프는 그대로
      const span = Math.max(0.05, num(s.duration, 15));
      const vals = grid(span, (x) => (cur?.on ? laneAt(cur, kind, x) : neutral), fn, lo, hi, num(s.start, 0));
      return { ...s, lanes: { ...(s.lanes || {}), [kind]: timeLane(vals, span) } };
    });
  }
  return out;
}
