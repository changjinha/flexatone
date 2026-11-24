/**
 * Flexatone — core/manager-interpolate.js
 * Layer 0 (core): the Manager's Interpolate tool — pick a range on each side, and the part between
 * them is filled with a smooth transformation from the left state to the right state.
 * Pure data (no DOM, no audio): clip lengths and pitch lines come in through `measure`.
 * 계층 0 (core): 매니저 "보간" 도구 — 양옆 구간을 고르면 그 사이를 왼쪽 상태에서 오른쪽 상태로 매끄럽게 변형해 채움.
 * 순수 데이터 (클립 길이와 음고 선은 measure로 받음).
 *
 * A = the earlier range [A.t0, A.t1), B = the later one [B.t0, B.t1). The gap is [g0, g1) = [A.t1, B.t0).
 * Like Extend (core/manager-extend.js) the tool only ADDS things: new tracks (instance.ext = step id) and
 * one range over the gap (region.ext) that mutes what the source tracks had there. The step is written to
 * manager.extensions, so "Remove last" (removeLastExtension) and Undo restore exactly what was there.
 * 연장과 마찬가지로 "추가"만 함: 새 트랙과, 빈 구간에서 출처 트랙을 뮤트하는 구간 하나. manager.extensions에 기록.
 *
 * Methods / 방법
 *   all    Everything (the default). Pitch is joined as in `glide`, and every other variable is carried
 *          from the left state to the right state as well: each join is played by two layers on the
 *          same pitch curve — one with all the settings of the line on the A side (timbre, tremolo,
 *          gain unit, level … and its track's fader, tremolo, mute / solo), one with those of the B
 *          side — crossfaded linearly. The layers run in step, so the level and the wave mix move in
 *          a straight line from A's values to B's; whatever a voice cannot change over time crosses
 *          over as sound. Tracks without pitch lines (and all tracks when one side has no line) are
 *          dissolved as in `fade`, so nothing in the two ranges is left out.
 *          전체 (기본값). 음고는 glide처럼 잇고, 나머지 모든 변수도 왼쪽 상태에서 오른쪽 상태로 옮김: 연결선마다
 *          같은 음고 곡선 위에 A쪽 설정(음색·트레몰로·음량·트랙 페이더 등)의 층과 B쪽 설정의 층을 두고 선형
 *          크로스페이드. 두 층은 위상이 맞아 음량·파형 혼합이 A 값에서 B 값으로 직선 이동. 음고 선이 없는
 *          트랙은 fade처럼 디졸브.
 *   glide  Pitch interpolation only. Every pitch line that sounds in A is joined to a line that
 *          sounds in B by a cubic Hermite curve in pitch (semitones): it leaves A at A's
 *          pitch and slope and arrives in B at B's pitch and slope — no step and no corner at either
 *          edge. Lines are paired low to low, high to high; with unequal counts a line splits or
 *          several merge. The joins are voices of new Glissando tracks (one per source track on the A
 *          side; a Glissando source lends its voice's timbre).
 *          음고 보간. A에서 울리는 음고 선마다 B의 선과 3차 에르미트 곡선(반음 단위)으로 연결:
 *          양 끝에서 음고와 기울기가 모두 일치 (계단·꺾임 없음). 낮은 선끼리·높은 선끼리 짝짓고, 개수가
 *          다르면 갈라지거나 합쳐짐. 연결선은 새 글리산도 트랙의 보이스.
 *   fade   Sound dissolve, for anything (also tracks without pitch lines). The sound of A (its window,
 *          looped) carries on through the gap and leaves in the second half; the sound of B (its
 *          window, looped so that it runs straight into B) enters in the first half. Takes
 *          (core/take-config.js) of the source clips as they sounded.
 *          소리 디졸브 (음고 선이 없는 트랙도 가능). A의 소리(창을 반복)가 이어지다 후반에 빠지고, B의 소리
 *          (B로 바로 이어지도록 반복)가 전반에 들어옴. 출처 클립이 "들리던 그대로"의 테이크.
 */

import { uid, deepClone, clamp } from './math-utils.js';
import { appState, dispatch, createInstanceDefaults, createDefaultManagerState, createDefaultVoice, createDefaultCurveConfig, registerSelfCheck, withIsolatedState } from './state.js';
import { ensureManager, getInstanceDoc, getFocusedInstance, setInstance, distinctTrackColor, channelRates } from './manager-state.js';
import { createDefaultTake } from './take-config.js';
import { midiToFreq } from './units.js';
import { removeLastExtension } from './manager-extend.js';

/** Methods in button order. / 버튼 순서의 방법 목록 */
export const INTERP_METHODS = Object.freeze(['all', 'glide', 'fade']);
/** Methods that need measure.lines (heard pitch lines in cycle time). / 음고 선이 필요한 방법 */
export const INTERP_NEEDS_LINES = Object.freeze(['all', 'glide']);
/** Shortest gap (s) worth filling. / 채울 수 있는 최소 간격 */
export const INTERP_MIN_GAP = 0.1;
/** Most joins one step makes. / 한 번에 만드는 연결선 수 상한 */
export const INTERP_MAX_JOINS = 24;
/** Name of the step in manager.extensions (`method` field): "ip-glide" / "ip-fade". / 기록상의 방법 이름 */
export const interpLogName = (method) => `ip-${method}`;
export const isInterpLog = (x) => typeof x?.method === 'string' && x.method.startsWith('ip-');

const EDGE_FADE = 0.03;
const MIN_WIN = 0.05; // shortest piece of a range a track must sound in / 구간 안에서 울려야 하는 최소 길이
const SPLINE_STEPS = 32;

const r3 = (x) => Math.round(x * 1000) / 1000;
const mgr = () => appState.manager || (appState.manager = createDefaultManagerState());
const suffixName = (name, suffix) => `${String(name).slice(0, 40 - suffix.length)}${suffix}`;

/**
 * The gap two ranges enclose: { A, B, g0, g1, gap } with A the earlier one, or null when they are not
 * two time ranges or overlap. / 두 구간 사이의 간격 (겹치거나 구간이 아니면 null)
 */
export function interpGap(ra, rb) {
  if (!ra || !rb || ra.id === rb.id || ra.kind !== 'range' || rb.kind !== 'range') return null;
  const [A, B] = ra.t0 <= rb.t0 ? [ra, rb] : [rb, ra];
  const gap = B.t0 - A.t1;
  return gap > 1e-6 ? { A, B, g0: A.t1, g1: B.t0, gap } : null;
}

// ==========================================================================
// Glide: pitch lines / 음고 선 보간
// ==========================================================================

/** Pitch of a polyline [{ t, m }] at time x (held outside). / 폴리라인의 x 시각 음고 */
function lineAt(pts, x) {
  if (x <= pts[0].t) return pts[0].m;
  for (let k = 1; k < pts.length; k++) {
    if (x <= pts[k].t) {
      const d = pts[k].t - pts[k - 1].t;
      return d > 1e-9 ? pts[k - 1].m + ((x - pts[k - 1].t) / d) * (pts[k].m - pts[k - 1].m) : pts[k].m;
    }
  }
  return pts[pts.length - 1].m;
}

/**
 * Where a line stands at an edge of the gap: its pitch there and its slope (semitones / s) measured over
 * the last (first) piece of the range. side 'out' = leaving A at g0, 'in' = entering B at g1. A line that
 * stops (starts) inside the range is read where it stops (starts). Null when the line does not sound in
 * the range. / 간격 경계에서의 선의 음고와 기울기 (그 경계에서 울리지 않으면 null)
 */
export function lineEdge(pts, range, side) {
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const first = pts[0].t;
  const last = pts[pts.length - 1].t;
  const h = clamp(0.25 * (range.t1 - range.t0), 0.05, 0.5);
  if (side === 'out') {
    const e = range.t1;
    if (last < range.t0 + 0.02 || first > e - 0.02) return null; // it must sound somewhere in the range / 구간 안 어딘가에서 울려야 함
    const te = Math.min(e, last);
    const tp = Math.max(first, te - h);
    const m = lineAt(pts, te);
    return { t: te, m, slope: te - tp > 1e-3 ? (m - lineAt(pts, tp)) / (te - tp) : 0 };
  }
  const e = range.t0;
  if (first > range.t1 - 0.02 || last < e + 0.02) return null;
  const tb = Math.max(e, first);
  const tn = Math.min(last, tb + h);
  const m = lineAt(pts, tb);
  return { t: tb, m, slope: tn - tb > 1e-3 ? (lineAt(pts, tn) - m) / (tn - tb) : 0 };
}

/**
 * Cubic Hermite pitch curve over a gap of D seconds: from (m0, slope s0) to (m1, slope s1), u ∈ [0, 1].
 * The tangents are limited (≤ 3 × the interval, at least an octave) so a steep edge cannot throw the
 * curve far outside the two pitches. / 3차 에르미트 음고 곡선 (접선은 음정의 3배·최소 1옥타브로 제한)
 */
export function hermitePitch(m0, s0, m1, s1, D) {
  const lim = Math.max(12, 3 * Math.abs(m1 - m0));
  const T0 = clamp(s0 * D, -lim, lim);
  const T1 = clamp(s1 * D, -lim, lim);
  return (u) => {
    const u2 = u * u;
    const u3 = u2 * u;
    return clamp((2 * u3 - 3 * u2 + 1) * m0 + (u3 - 2 * u2 + u) * T0 + (-2 * u3 + 3 * u2) * m1 + (u3 - u2) * T1, 0, 132);
  };
}

/** Pair n joins between nA and nB edges sorted by pitch: [[ia, ib]]. / 음고순 짝짓기 */
function pairEdges(nA, nB) {
  const n = Math.min(INTERP_MAX_JOINS, Math.max(nA, nB));
  const at = (k, count) => (n > 1 ? Math.round((k * (count - 1)) / (n - 1)) : 0);
  const out = [];
  for (let k = 0; k < n; k++) out.push([at(k, nA), at(k, nB)]);
  return out;
}

/** Voice settings another studio's voice shares with a Glissando voice (level, timbre, tremolo). / 글리산도 보이스와 공유하는 설정 */
const SHARED_VOICE_KEYS = Object.freeze(['baseGain', 'gainUnit', 'dbTaper', 'dbMin', 'timbreMode', 'timbre', 'timbreFunc', 'tremolo']);

/**
 * The settings a join inherits from the line `key` of the track `src`: the whole voice when the source is
 * a Glissando voice, the settings it shares with one otherwise (Field particle …), or null.
 * 연결선이 물려받는 설정: 글리산도 보이스면 전체, 다른 스튜디오면 공유되는 설정만, 없으면 null.
 */
function voiceBase(src, key) {
  const v = (getInstanceDoc(src)?.voices || []).find((x) => x && x.id === key);
  if (!v) return null;
  if (src.studio === 'glissando') return v;
  const d = createDefaultVoice(0);
  const out = {};
  for (const k of SHARED_VOICE_KEYS) {
    if (v[k] === undefined || v[k] === null || typeof v[k] !== typeof d[k]) continue;
    if (k === 'timbre' && !Number.isFinite(Number(v[k].sine))) continue;
    if (k === 'timbreMode' && v[k] !== 'mix' && v[k] !== 'func') continue;
    out[k] = v[k];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * A Glissando voice that plays `curve` (u → midi) over `dur` document seconds. `gain` = [y0, y1]: the
 * envelope runs in a straight line from y0 to y1 (default: flat 0.9). / 곡선을 재생하는 글리산도 보이스
 */
function makeJoinVoice(index, base, name, curve, dur, gain = [0.9, 0.9]) {
  const ms = [];
  for (let k = 0; k <= SPLINE_STEPS; k++) ms.push(curve(k / SPLINE_STEPS));
  let lo = Math.min(...ms);
  let hi = Math.max(...ms);
  if (hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; } // a held pitch still needs a range / 같은 음고여도 범위 필요
  const fresh = createDefaultVoice(index);
  const v = base ? { ...fresh, ...deepClone(base), id: fresh.id, color: fresh.color } : fresh;
  Object.assign(v, createDefaultCurveConfig('custom'), {
    name: String(name).slice(0, 40),
    solo: false,
    muted: false,
    startTime: 0,
    duration: dur,
    f0Midi: Math.round(lo), f0Hz: midiToFreq(lo), f0Fine: 0,
    f1Midi: Math.round(hi), f1Hz: midiToFreq(hi), f1Fine: 0,
    logScale: true,
    audioTarget: 'pos',
    customPoints: ms.map((m, k) => ({ x: k / SPLINE_STEPS, y: (m - lo) / (hi - lo), handles: [] })),
    gainMode: 'points',
    gainPoints: [{ x: 0, y: clamp(gain[0], 0, 1), handles: [] }, { x: 1, y: clamp(gain[1], 0, 1), handles: [] }],
    regions: [],
  });
  return v;
}

/** Lines of the source tracks that sound in A (outs) and in B (ins), sorted by pitch, and their pairing. */
function collectJoins({ A, B, sources, lines }) {
  const byId = new Map(sources.map((s) => [s.inst.id, s]));
  const outs = [];
  const ins = [];
  for (const ln of lines || []) {
    const s = byId.get(ln.instId);
    if (!s) continue;
    const eo = lineEdge(ln.pts, A, 'out');
    if (eo) outs.push({ ...eo, ln, s });
    const ei = lineEdge(ln.pts, B, 'in');
    if (ei) ins.push({ ...ei, ln, s });
  }
  outs.sort((x, y) => x.m - y.m);
  ins.sort((x, y) => x.m - y.m);
  const joins = outs.length && ins.length ? pairEdges(outs.length, ins.length).map(([ia, ib]) => ({ a: outs[ia], b: ins[ib] })) : [];
  return { outs, ins, joins };
}

/** A new Glissando track on the gap with the mixer settings of `src` (fader, tremolo, mute / solo). / 간격 위의 새 글리산도 트랙 */
function makeJoinTrack(src, opId, g0, gap) {
  return {
    ...createInstanceDefaults('glissando'),
    id: uid('in_', 6),
    studio: 'glissando',
    name: suffixName(src.name, ' ⇝'),
    color: src.color,
    gainDb: src.gainDb,
    mute: !!src.mute,
    solo: !!src.solo,
    tremolo: deepClone(src.tremolo),
    start: r3(g0),
    length: r3(gap),
    loop: false,
    fadeIn: EDGE_FADE,
    fadeOut: EDGE_FADE,
    inCycle: true,
    ext: opId,
    doc: { voices: [], activeVoiceId: null, params: null },
  };
}

/**
 * Joins as Glissando tracks, one per source track. `layers` false = one voice per join at a flat level
 * (pitch only); true = two voices per join, the A settings fading out and the B settings fading in on
 * the same curve, each on the track made for its own source (so the track settings cross over too).
 * 연결선을 출처 트랙별 글리산도 트랙으로. layers면 연결선마다 A 설정 층(페이드 아웃)과 B 설정 층(페이드 인).
 */
function buildJoinTracks({ g0, g1, gap, opId, voiceGain }, joins, layers) {
  const made = new Map(); // source track id → { after, inst }
  const trackOf = (src) => {
    if (!made.has(src.id)) made.set(src.id, { after: src.id, inst: makeJoinTrack(src, opId, g0, gap) });
    return made.get(src.id).inst;
  };
  // envelope value of the source line where the join takes over (null = unknown → 0.9) / 연결 지점의 엔벨로프 값
  const level = (e, side) => {
    const g = typeof voiceGain === 'function' ? voiceGain(e.s.inst.id, e.ln.key, side === 'out' ? Math.min(e.t, g0) - 0.01 : Math.max(e.t, g1) + 0.01) : null;
    return Number.isFinite(g) ? clamp(g, 0, 1) : 0.9;
  };
  for (const { a, b } of joins) {
    const curve = hermitePitch(a.m, a.slope, b.m, b.slope, gap);
    const name = `${a.ln.name || a.s.inst.name} ⇝ ${b.ln.name || b.s.inst.name}`;
    const put = (src, base, label, gain) => {
      const track = trackOf(src);
      // Glissando documents are time-scaled by the track rate (Tempo Manager): written in document seconds
      // 글리산도 문서는 트랙 배속으로 재스케일되므로 문서 시간으로 기록
      const dur = gap * (Number(channelRates(track).rate) || 1);
      track.doc.voices.push(makeJoinVoice(track.doc.voices.length, base, `${name}${label}`, curve, dur, gain));
    };
    if (layers) {
      put(a.s.inst, voiceBase(a.s.inst, a.ln.key), ' · A', [level(a, 'out'), 0]);
      put(b.s.inst, voiceBase(b.s.inst, b.ln.key), ' · B', [0, level(b, 'in')]);
    } else {
      put(a.s.inst, a.s.inst.studio === 'glissando' && !a.s.inst.take?.on ? voiceBase(a.s.inst, a.ln.key) : null, '', undefined);
    }
  }
  const tracks = [...made.values()];
  for (const { inst } of tracks) inst.doc.activeVoiceId = inst.doc.voices[0].id;
  return tracks;
}

function planGlide(ctx) {
  const { joins } = collectJoins(ctx);
  if (!joins.length) return { tracks: [], muted: [], error: 'lines' };
  const muted = new Set();
  for (const { a, b } of joins) { muted.add(a.s.inst.id); muted.add(b.s.inst.id); }
  return { tracks: buildJoinTracks(ctx, joins, false), muted: [...muted], joins: joins.length };
}

/**
 * Everything: joins in two layers (A settings → B settings) for the tracks with pitch lines; the tracks
 * that are not joined on a side are dissolved there. / 전체: 음고 선은 두 층으로 연결, 연결되지 않은 쪽은 디졸브
 */
function planAll(ctx) {
  const { joins } = collectJoins(ctx);
  const outIds = new Set(joins.map((j) => j.a.s.inst.id));
  const inIds = new Set(joins.map((j) => j.b.s.inst.id));
  const fade = planFade({ ...ctx, skipA: outIds, skipB: inIds });
  return { tracks: [...buildJoinTracks(ctx, joins, true), ...fade.tracks], muted: [...new Set([...outIds, ...inIds, ...fade.muted])], joins: joins.length };
}

// ==========================================================================
// Fade: takes of the two windows / 두 창의 테이크로 디졸브
// ==========================================================================

function makeTake(src, opId, take, over, suffix) {
  return {
    ...createInstanceDefaults(src.studio),
    id: uid('in_', 6),
    studio: src.studio,
    name: suffixName(src.name, suffix),
    color: src.color,
    doc: deepClone(getInstanceDoc(src)),
    gainDb: src.gainDb,
    mute: !!src.mute,
    solo: !!src.solo,
    inCycle: true,
    tempo: deepClone(src.tempo),
    tremolo: deepClone(src.tremolo),
    take: { ...createDefaultTake(), on: true, as: src.id, inner: src.take?.on ? deepClone(src.take) : null, rev: false, loop: !!src.loop, ...take },
    ext: opId,
    ...over,
  };
}

function planFade({ A, B, g0, g1, gap, sources, opId, skipA = null, skipB = null }) {
  const tracks = [];
  const muted = new Set();
  for (const { inst, a, b } of sources) {
    // A side: the part of the clip inside A / A쪽: 클립의 A 안쪽 부분
    const a0 = Math.max(a, A.t0);
    const a1 = Math.min(b, A.t1);
    if (a1 - a0 >= MIN_WIN && !skipA?.has(inst.id)) {
      tracks.push({ after: inst.id, inst: makeTake(inst, opId, { at: r3(a), len: r3(a1 - a), off: r3(a0 - a) },
        { start: r3(g0), length: r3(gap), loop: true, fadeIn: EDGE_FADE, fadeOut: clamp(gap / 2, EDGE_FADE, 10) }, ' ⇝ A') });
      muted.add(inst.id);
    }
    // B side: the part inside B; it ends exactly on g1 so the loop runs straight into B
    // B쪽: 클립의 B 안쪽 부분, g1에서 정확히 끝나 B로 이어짐
    const b0 = Math.max(a, B.t0);
    const b1 = Math.min(b, B.t1);
    const W = b1 - b0;
    if (W >= MIN_WIN && !skipB?.has(inst.id)) {
      const k = Math.floor(gap / W + 1e-6); // whole passes that fit the gap / 간격에 들어가는 온전한 반복 횟수
      const len = k >= 1 ? k * W : gap; // none fits: only the end of the window, as long as the gap / 안 들어가면 창의 끝부분만
      const off = b0 - a + (k >= 1 ? 0 : W - gap);
      tracks.push({ after: inst.id, inst: makeTake(inst, opId, { at: r3(a), len: r3(b1 - a), off: r3(off) },
        { start: r3(g1 - len), length: r3(len), loop: k > 1, fadeIn: clamp(len / 2, EDGE_FADE, 10), fadeOut: EDGE_FADE }, ' ⇝ B') });
      muted.add(inst.id);
    }
  }
  return { tracks, muted: [...muted] };
}

const PLANNERS = { all: planAll, glide: planGlide, fade: planFade };

// ==========================================================================
// Apply / 적용
// ==========================================================================

/**
 * Fill the gap between two ranges with `method`. `measure` = { clipLength(inst), only?: ids of the checked
 * tracks, lines?: [{ instId, key, name, pts: [{ t, m }] }] heard pitch lines in cycle time (all, glide),
 * voiceGain?: (instId, key, cycleSec) → envelope value 0…1 of that line there, or null (all) }.
 * One undoable step. / 두 구간 사이를 method로 채움 (실행 취소 1단계)
 * @returns {{ ok: boolean, error?: 'method'|'gap'|'empty'|'lines', id?: string, added?: number, joins?: number, from?: number, to?: number }}
 */
export function interpolateRanges(method, regionA, regionB, measure) {
  const plan = PLANNERS[method];
  if (!plan) return { ok: false, error: 'method' };
  ensureManager();
  const m = mgr();
  const G = interpGap(regionA, regionB);
  if (!G || G.gap < INTERP_MIN_GAP) return { ok: false, error: 'gap' };
  const { g0, g1 } = G;
  const only = measure.only && measure.only.length ? new Set(measure.only) : null;
  const sources = [];
  for (const inst of m.instances) {
    if (only && !only.has(inst.id)) continue;
    if (!inst.inCycle || inst.warp?.on) continue; // Warp tracks are silent / 곡률 트랙은 소리가 없음
    const a = Number(inst.start) || 0;
    const L = Math.max(0, Number(measure.clipLength(inst)) || 0);
    if (L >= 0.02) sources.push({ inst, a, b: a + L });
  }
  if (!sources.length) return { ok: false, error: 'empty' };
  const opId = uid('x_', 6);
  const out = plan({ ...G, sources, lines: measure.lines || [], voiceGain: measure.voiceGain || null, opId });
  if (!out.tracks.length) return { ok: false, error: out.error || 'empty' };
  const usedColors = new Set(m.instances.map((i) => String(i.color || '').toLowerCase()));
  for (const { inst } of out.tracks) { inst.color = distinctTrackColor(inst.studio, usedColors); usedColors.add(inst.color); }
  // What the joined tracks had inside the gap gives way to the transition / 간격 안에 있던 출처 트랙의 소리는 전환에 자리를 내줌
  const inGap = out.muted.filter((id) => sources.some((s) => s.inst.id === id && s.a < g1 - 1e-3 && s.b > g0 + 1e-3));
  const n = (m.extensions || []).filter(isInterpLog).length + 1;
  const region = inGap.length ? { id: uid('rg_', 6), kind: 'range', name: `⇝ ${n}`, t0: r3(g0), t1: r3(g1), solo: [], mute: inGap, ext: opId } : null;
  dispatch({
    type: 'manager/interpolate',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      const mm = s.manager;
      for (const { after, inst } of out.tracks) {
        let at = mm.instances.findIndex((i) => i.id === after);
        if (at < 0) at = mm.instances.length - 1;
        while (at + 1 < mm.instances.length && mm.instances[at + 1].ext === opId) at++;
        mm.instances.splice(at + 1, 0, inst);
      }
      if (region) mm.regions = [...(mm.regions || []), region];
      if (!Array.isArray(mm.extensions)) mm.extensions = [];
      // the cycle length is not touched: prev = what it is now, so removing the step changes nothing there
      // 사이클 길이는 그대로: prev = 현재 값
      mm.extensions.push({ id: opId, method: interpLogName(method), seconds: r3(G.gap), from: r3(g0), to: r3(g1), prev: { cycleMode: mm.cycleMode === 'fixed' ? 'fixed' : 'auto', cycleLen: mm.cycleLen ?? null }, froze: [] });
    },
  });
  return { ok: true, id: opId, added: out.tracks.length, joins: out.joins || 0, from: r3(g0), to: r3(g1) };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Manager interpolate: Hermite glide joins pitch and slope; pairs low to low', (a) => {
  const f = hermitePitch(60, 2, 67, -1, 4);
  a.near(f(0), 60, 1e-9, 'starts on the A pitch');
  a.near(f(1), 67, 1e-9, 'ends on the B pitch');
  a.near((f(1e-4) - f(0)) / (1e-4 * 4), 2, 1e-2, 'leaves with the A slope (st / s)');
  a.near((f(1) - f(1 - 1e-4)) / (1e-4 * 4), -1, 1e-2, 'arrives with the B slope');
  const e = lineEdge([{ t: 0, m: 60 }, { t: 2, m: 64 }], { t0: 1, t1: 2 }, 'out');
  a.ok(e && Math.abs(e.m - 64) < 1e-9 && Math.abs(e.slope - 2) < 1e-9, 'edge of a rising line: pitch 64, 2 st / s');
  a.equal(lineEdge([{ t: 0, m: 60 }, { t: 0.9, m: 64 }], { t0: 1, t1: 2 }, 'out'), null, 'a line that ended before the range is not joined');
  a.near(lineEdge([{ t: 0, m: 60 }, { t: 1.5, m: 63 }], { t0: 1, t1: 2 }, 'out').m, 63, 1e-9, 'a line that stops inside the range is read where it stops');
  a.equal(interpGap({ id: 'a', kind: 'range', t0: 0, t1: 3 }, { id: 'b', kind: 'range', t0: 2, t1: 4 }), null, 'overlapping ranges have no gap');
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const [g, r, fd] = ['glissando', 'risset', 'field'].map((x) => getFocusedInstance(x));
    setInstance(g.id, { start: 0, length: 10, loop: true });
    setInstance(r.id, { inCycle: false });
    setInstance(fd.id, { inCycle: false });
    const A = { id: 'rg_a', kind: 'range', name: 'A', t0: 1, t1: 2, solo: [], mute: [] };
    const B = { id: 'rg_b', kind: 'range', name: 'B', t0: 6, t1: 7, solo: [], mute: [] };
    appState.manager.regions = [A, B];
    const lines = [
      { instId: g.id, key: 'lo', name: 'lo', pts: [{ t: 0, m: 48 }, { t: 2, m: 50 }] },
      { instId: g.id, key: 'hi', name: 'hi', pts: [{ t: 0, m: 72 }, { t: 2, m: 72 }] },
      { instId: g.id, key: 'b1', name: 'b1', pts: [{ t: 6, m: 60 }, { t: 10, m: 60 }] },
    ];
    const measure = { clipLength: () => 10, lines };
    const res = interpolateRanges('glide', B, A, measure); // order of the two ranges does not matter / 순서 무관
    a.ok(res.ok && res.added === 1 && res.joins === 2 && res.from === 2 && res.to === 6, 'one Glissando track, two joins over [2, 6)');
    const tr = appState.manager.instances.find((i) => i.ext === res.id);
    a.ok(tr.studio === 'glissando' && tr.start === 2 && tr.length === 4 && !tr.take.on, 'placed on the gap');
    const [v0, v1] = tr.doc.voices;
    a.ok(v0.engine === 'custom' && v0.duration === 4 && v0.customPoints.length === SPLINE_STEPS + 1, 'spline voice as long as the gap');
    a.near(v0.f0Hz, midiToFreq(50), 1e-6, 'low join starts at 50');
    a.near(v0.f1Hz, midiToFreq(60), 0.5, 'and ends near 60 (both lines merge into the one B line)');
    a.near(v1.customPoints[0].y, 1, 1e-9, 'high join starts at the top of its range (72)');
    const rg = appState.manager.regions.find((x) => x.ext === res.id);
    a.ok(rg && rg.t0 === 2 && rg.t1 === 6 && rg.mute.includes(g.id), 'the source track is muted inside the gap');
    a.equal(interpolateRanges('glide', A, B, { clipLength: () => 10, lines: lines.slice(0, 2) }).error, 'lines', 'no line on the B side → nothing to join');
    a.equal(removeLastExtension(), true, 'remove');
    a.ok(appState.manager.instances.length === 3 && appState.manager.regions.length === 2 && appState.manager.extensions.length === 0, 'tracks, ranges and log as before');
  });
}, { group: 'state' });

registerSelfCheck('Manager interpolate: dissolve places takes of both windows on the gap', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const [g, r, fd] = ['glissando', 'risset', 'field'].map((x) => getFocusedInstance(x));
    setInstance(g.id, { start: 0, length: 2, loop: true }); // sounds in A only / A에서만 울림
    setInstance(fd.id, { start: 6, length: 3, loop: true }); // sounds in B only / B에서만 울림
    setInstance(r.id, { inCycle: false });
    const lens = { [g.id]: 2, [fd.id]: 3 };
    const A = { id: 'rg_a', kind: 'range', name: 'A', t0: 1, t1: 2, solo: [], mute: [] };
    const B = { id: 'rg_b', kind: 'range', name: 'B', t0: 6, t1: 7.5, solo: [], mute: [] };
    appState.manager.regions = [A, B];
    const res = interpolateRanges('fade', A, B, { clipLength: (i) => lens[i.id] ?? 0 });
    a.ok(res.ok && res.added === 2, 'one take per side');
    const made = appState.manager.instances.filter((i) => i.ext === res.id);
    const out = made.find((i) => i.take.as === g.id);
    const inn = made.find((i) => i.take.as === fd.id);
    a.ok(out.take.on && out.take.at === 0 && out.take.len === 2 && out.take.off === 1, 'A take = the clip from 0, trimmed to the window [1, 2)');
    a.ok(out.start === 2 && out.length === 4 && out.loop && out.fadeOut === 2, 'loops through the gap, leaves in the second half');
    a.ok(inn.take.at === 6 && inn.take.len === 1.5 && inn.take.off === 0, 'B take = the window [6, 7.5)');
    a.ok(inn.start === 3 && inn.length === 3 && inn.loop && inn.fadeIn === 1.5, 'two whole passes end exactly on B (3 → 6)');
    a.equal(appState.manager.regions.length, 2, 'nothing of the sources lies in the gap → no mute range');
    a.ok(isInterpLog(appState.manager.extensions[0]) && appState.manager.cycleMode === 'auto', 'logged; the cycle length is not fixed');
    // A window longer than the gap: only its end, without a loop / 간격보다 긴 창은 끝부분만
    const B2 = { ...B, id: 'rg_b2', t1: 9 };
    setInstance(g.id, { inCycle: false });
    const res2 = interpolateRanges('fade', { ...A, t0: 4.5, t1: 5 }, B2, { clipLength: (i) => lens[i.id] ?? 0 });
    const in2 = appState.manager.instances.find((i) => i.ext === res2.id && i.take.as === fd.id);
    a.ok(in2 && in2.start === 5 && in2.length === 1 && !in2.loop && in2.take.off === 2, 'end of the 3 s window on the 1 s gap');
    a.equal(interpolateRanges('fade', A, { ...A, id: 'x', t0: 2.02, t1: 3 }, { clipLength: () => 2 }).error, 'gap', 'gap too short');
  });
}, { group: 'state' });

registerSelfCheck('Manager interpolate: "all" joins in two layers (A settings out, B settings in) and dissolves the rest', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const [g, r, fd] = ['glissando', 'risset', 'field'].map((x) => getFocusedInstance(x));
    const va = createDefaultVoice(0, { baseGain: 0.5, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 } });
    const vb = createDefaultVoice(1, { baseGain: 0.8, timbre: { sine: 0, tri: 0, saw: 1, sqr: 0, rich: 0 } });
    appState.voices = [va, vb];
    setInstance(g.id, { start: 0, length: 10, loop: true, gainDb: -6 });
    setInstance(r.id, { start: 0, length: 2 }); // no pitch line: sounds in A only / 음고 선 없음, A에서만 울림
    setInstance(fd.id, { inCycle: false });
    const A = { id: 'rg_a', kind: 'range', name: 'A', t0: 1, t1: 2, solo: [], mute: [] };
    const B = { id: 'rg_b', kind: 'range', name: 'B', t0: 6, t1: 7, solo: [], mute: [] };
    const lines = [
      { instId: g.id, key: va.id, name: 'a', pts: [{ t: 0, m: 60 }, { t: 2, m: 60 }] },
      { instId: g.id, key: vb.id, name: 'b', pts: [{ t: 6, m: 67 }, { t: 10, m: 67 }] },
    ];
    const lens = { [g.id]: 10, [r.id]: 2 };
    const res = interpolateRanges('all', A, B, { clipLength: (i) => lens[i.id] ?? 0, lines, voiceGain: (id, key) => (key === va.id ? 0.6 : 0.3) });
    a.ok(res.ok && res.joins === 1 && res.added === 2, 'one join track + one dissolve take (Risset)');
    const made = appState.manager.instances.filter((i) => i.ext === res.id);
    const jt = made.find((i) => i.studio === 'glissando');
    a.ok(jt && jt.gainDb === -6 && jt.doc.voices.length === 2, 'both layers on the track of their (shared) source, with its fader');
    const [la, lb] = jt.doc.voices;
    a.ok(la.baseGain === 0.5 && la.timbre.sine === 1 && lb.baseGain === 0.8 && lb.timbre.saw === 1, 'layer A keeps the A voice settings, layer B the B voice settings');
    a.ok(la.gainPoints[0].y === 0.6 && la.gainPoints[1].y === 0 && lb.gainPoints[0].y === 0 && lb.gainPoints[1].y === 0.3, 'A fades from its level to 0, B from 0 to its level');
    a.ok(JSON.stringify(la.customPoints) === JSON.stringify(lb.customPoints) && la.f0Hz === lb.f0Hz && la.f1Hz === lb.f1Hz, 'both layers follow the same pitch curve');
    const tk = made.find((i) => i.take.on);
    a.ok(tk && tk.take.as === r.id && tk.start === 2, 'the track without pitch lines is dissolved from A');
    // no line on the B side → no join, everything dissolves / B쪽에 선이 없으면 전부 디졸브
    removeLastExtension();
    const res2 = interpolateRanges('all', A, B, { clipLength: (i) => lens[i.id] ?? 0, lines: lines.slice(0, 1) });
    a.ok(res2.ok && res2.joins === 0 && appState.manager.instances.filter((i) => i.ext === res2.id).every((i) => i.take.on), 'falls back to takes');
  });
}, { group: 'state' });
