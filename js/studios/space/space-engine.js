/**
 * Flexatone — studios/space/space-engine.js
 * Layer 2 (studios, pure): Space Studio physics — moving sources, retarded time, Doppler,
 * inverse-distance gain, air absorption, equal-power pan. No DOM, no Web Audio.
 * 계층 2 (studios, 순수): 스페이스 스튜디오 물리 — 움직이는 음원, 지연 시간, 도플러,
 * 역거리 게인, 공기 흡수, 등전력 패닝. DOM·Web Audio 없음.
 *
 * Geometry / 좌표
 *   Top view, metres. +x = right (east), +y = up on screen (north). The listener faces
 *   headingDeg (0 = +y, clockwise positive) — the brief's "+z front" is the +y axis here.
 *   Each source may sit at a constant height h above the plane (r includes h).
 *   상단 시점(미터). 청취자 정면 = headingDeg (0 = +y, 시계 방향 +). 높이 h는 거리에 포함.
 *
 * Retarded time / 지연 시간
 *   The listener hears at t what the source emitted at t_e:  g(t_e) = t_e + |X(t_e) − L|/c − t = 0.
 *   dg/dt_e = 1 + v_r/c > 0 while |v| < c, so the root is unique; it is found by Newton steps
 *   kept inside a shrinking bisection bracket (residual < 1e-9 s).
 *   f_obs = f_s(t_e) / (1 + v_r/c),   v_r = (X − L)·v / |X − L|  (positive = receding).
 *   Speeds are clamped to 0.98·c (no sonic boom in this prototype).
 *
 * Baking / 베이킹
 *   bakeSpace(doc) samples every source at `bakeRate` Hz of LISTENER time and returns typed
 *   arrays { t, te, fObs, fs, gain, lp, pan, fwd, up, r, vr, x, y }. Results are cached by a
 *   signature of the physics only (timbre / baseGain / mute / solo / view excluded).
 *   청취자 시간 기준 bakeRate Hz로 샘플링, 물리 시그니처로 캐시 (음색·게인·뷰 제외).
 *
 * Imports: core/*, modules/*.
 */

import { clamp, roundTo, deepClone, createSeededRandom, uid, createMonotoneInterpolator } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { createDefaultCurveParams } from '../../core/state.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { normalizeVoiceMod } from '../../core/voice-mod.js';
import { buildSpline, normalizeSplineNodes, nodesFromPoints } from '../../modules/spline3d.js';
import { SOURCE_LANES, LANE_DEFS, createLane, normalizeLane, compileLane, pointsFromFunction } from './space-lanes.js';
import { buildMotion, pathPosition } from './space-motion.js';
import { ARRAY_LAYOUTS, ARRAY_METHODS, ARRAY_MAX_SPEAKERS, normalizeSpeaker } from '../../modules/speaker-arrays.js';

export const SPACE_PATH_TYPES = Object.freeze(['line', 'orbit', 'lissajous', 'spiral', 'draw', 'static', 'spline']);
export const SPLINE_DIMS = Object.freeze(['2d', '3d']);
export const SPLINE_ENDS = Object.freeze(['stop', 'loop', 'pingpong']);
/** Time modes of a spline path: the speed decides the time, or the duration is fixed. / 시간 모드 */
export const TIME_MODES = Object.freeze(['speed', 'fit', 'pinned']);
export const PROFILE_MODES = Object.freeze(['const', 'curve']);
/** Speed modes: the profile modes + 'rankine' (tangential speed of a Rankine vortex at the orbit radius). */
export const SPEED_MODES = Object.freeze(['const', 'curve', 'rankine', 'env', 'track']);
/** Laps of the path travelled in the duration by the 'track' speed mode. / 'track' 모드의 바퀴 수 */
export const trackLaps = (sp) => clamp(num(sp?.laps, 1), 0.05, 100);
/** Pitch modes: the profile modes + 'env' (envelope lane). / 음고 모드 */
export const PITCH_MODES = Object.freeze(['const', 'curve', 'env']);

/**
 * Rankine vortex tangential speed: solid-body core v = Γ·r/(2π a²) for r ≤ a, irrotational flow
 * v = Γ/(2π r) outside. A tracer riding the flow orbits at radius r with v(r) — inner sources
 * turn faster in angle (ω = Γ/2πa² in the core, Γ/2πr² outside) = differential rotation.
 * 랭킨 소용돌이 접선 속도: 핵 안은 강체 회전, 바깥은 비회전 흐름.
 */
export function rankineSpeed(r, gamma, core) {
  const a = Math.max(1e-6, core);
  const rr = Math.max(0, r);
  const g = Math.max(0, gamma) / (2 * Math.PI);
  return rr <= a ? (g * rr) / (a * a) : g / rr;
}
/** Curve engines offered for speed / pitch profiles (default params). / 프로파일용 곡선 엔진 */
export const PROFILE_ENGINES = Object.freeze(['harmonic', 'expo', 'bezier', 'damped', 'bounce', 'plateau', 'chirp', 'trig']);
export const SPACE_PRESETS = Object.freeze(['passby', 'orbit', 'spiral', 'sirens', 'swarm', 'vortex', 'comet', 'helix', 'flythrough', 'chase', 'openfield', 'hall']);
export const PAN_MODES = Object.freeze(['equalPower', 'hrtf', 'binaural', 'array']); // 'array' = HOA decoded to a loudspeaker array (modules/speaker-arrays.js) / 스피커 배열 디코드
/** Modes that pan through the HOA decoder. / HOA 디코더를 거치는 모드 */
export const isHoaMode = (m) => m === 'binaural' || m === 'array';
/** What a source sounds like: its own oscillator, or the sound of another studio. / 음원의 소리 */
export const INPUT_KINDS = Object.freeze(['synth', 'import', 'track']); // 'track' = a Manager track (Space Master only) / 매니저 트랙 (스페이스 마스터 전용)
export const IMPORT_PLAYS = Object.freeze(['once', 'loop']);
export const IMPORT_CHANNELS = Object.freeze(['mix', 'L', 'R']);
export const GROUP_FRAMES = Object.freeze(['path', 'world']);
export const HOA_ORDERS = Object.freeze([1, 2, 3, 4]);
export const HOA_WEIGHTS = Object.freeze(['maxre', 'basic', 'inphase']);

/** Fill / clamp a source's input (new object). / 음원 입력 보정 */
export function normalizeInput(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    kind: INPUT_KINDS.includes(src.kind) ? src.kind : 'synth',
    target: typeof src.target === 'string' ? src.target : '', // instance id, or '@<studio>' = that studio's editor document / 인스턴스 id 또는 '@<studio>'
    content: src.content === 'heard' ? 'heard' : 'doc',
    trimDb: clamp(num(src.trimDb, 0), -36, 24),
    offset: clamp(num(src.offset, 0), 0, 600),
    play: IMPORT_PLAYS.includes(src.play) ? src.play : 'once',
    frozen: typeof src.frozen === 'string' && src.frozen ? src.frozen : null, // sample-library id of a frozen copy / 고정 사본의 샘플 id
    bypass: !!src.bypass, // Space Master: this track stays dry / 스페이스 마스터: 이 트랙은 그대로 통과
    channel: IMPORT_CHANNELS.includes(src.channel) ? src.channel : 'mix', // stereo split: one channel of the sound / 스테레오 분리: 한 채널만
  };
}

/**
 * Group (formation) of a source: it rides the path of `lead` (null = its own path) at an offset.
 *   frame 'path'  → off = [forward, right, up] in the frame of the motion (right = horizontal),
 *   frame 'world' → off = [x, y, z] in room coordinates.
 * A member's own path / speed / start / duration are ignored while it follows a lead.
 * 그룹(편대): `lead`의 경로(null = 자기 경로)를 오프셋만큼 떨어져 따라감. 따라가는 동안 자기 경로·속도·시작·지속은 무시.
 */
export function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    lead: typeof raw.lead === 'string' && raw.lead ? raw.lead : null,
    frame: GROUP_FRAMES.includes(raw.frame) ? raw.frame : 'path',
    off: [0, 1, 2].map((i) => clamp(num(raw.off?.[i], 0), -500, 500)),
    tag: typeof raw.tag === 'string' ? raw.tag : '', // what made the group ('stereo' | 'stems') / 그룹의 출처
  };
}
export const BAKE_RATES = Object.freeze([100, 200, 400]);
export const SUPERSONIC_FRACTION = 0.98;
export const MAX_RINGS = 24;
export const MAX_BAKE_SAMPLES = 60000;
export const MAX_DRAW_POINTS = 64;
export const SOURCE_COLORS = Object.freeze(['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#34d399', '#fb7185', '#60a5fa']);
export const SOLVER_TOL = 1e-12;

const ARC_N = 2048; // arc-length table resolution / 호 길이 표 해상도
const PROFILE_N = 1024; // speed / pitch profile table resolution / 프로파일 표 해상도
const TAU = Math.PI * 2;
const CURVE_DEFAULTS = Object.freeze(createDefaultCurveParams());
const now = () => (globalThis.performance ? globalThis.performance.now() : Date.now());
const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

// ==========================================================================
// Document factories / 문서 팩토리
// ==========================================================================

/** Curve profile reference (curve-engine object, default params). / 곡선 프로파일 */
export function createProfileCurve(engine = 'harmonic', extra = {}) {
  return { engine, reverse: false, inverse: false, ...extra };
}

/** One moving source with every path field present (switching type keeps the others). */
export function createSource(index = 0, over = {}) {
  const base = {
    id: over.id || uid('s_', 6),
    name: `Source ${index + 1}`,
    color: SOURCE_COLORS[index % SOURCE_COLORS.length],
    muted: false,
    solo: false,
    path: {
      type: 'line',
      x0: -150, y0: 5, x1: 150, y1: 5, // line
      cx: 0, cy: 0, rx: 25, ry: 25, phase: 0, dir: 1, onListener: false, // orbit / spiral / lissajous centre
      ax: 40, ay: 30, a: 1, b: 2, delta: 90, // lissajous
      r0: 80, r1: 4, turns: 2, // spiral
      x: 0, y: 12, // static
      h: 0, // height above the plane / 높이
      ends: { start: { x: null, y: null, z: null }, end: { x: null, y: null, z: null } }, // start / end point overrides (null = natural) / 시작·끝점 (null = 원래)
      hEnv: createLane('height'), // height envelope from start to end (analytic paths; on → replaces h) / 시작→끝 높이 엔벨로프
      points: [], // draw
      spline: { dims: '2d', closed: false, end: 'stop', nodes: [] }, // node spline (modules/spline3d.js) / 노드 스플라인
    },
    speed: { mode: 'const', value: 20, from: 5, to: 30, laps: 1, gamma: 3500, core: 14, curve: createProfileCurve('harmonic'), env: createLane('speed') },
    timeMode: 'speed', // spline paths: 'speed' = the duration is a result, 'fit' = the duration is fixed / 스플라인 시간 모드
    start: 0,
    duration: 15,
    f: { mode: 'const', hz: 440, hz0: 330, hz1: 660, curve: createProfileCurve('harmonic'), env: createLane('pitch') },
    timbre: { sine: 0.6, tri: 0.3, saw: 0.25, sqr: 0.05, rich: 0.2 },
    timbreB: { sine: 0.2, tri: 0.2, saw: 0.8, sqr: 0.3, rich: 0.6 }, // B side of the timbre lane / 음색 레인의 B쪽
    lanes: Object.fromEntries(SOURCE_LANES.map((k) => [k, createLane(k)])),
    input: normalizeInput(null),
    group: null, // formation: follow another source's path at an offset (normalizeGroup) / 편대
    baseGain: 0.6,
    doppler: true,
    distanceGain: true,
    airAbsorb: true,
    pan: true,
  };
  const s = { ...base, ...deepClone(over) };
  s.path = { ...base.path, ...(over.path || {}) };
  s.speed = { ...base.speed, ...(over.speed || {}), curve: { ...base.speed.curve, ...(over.speed?.curve || {}) } };
  s.f = { ...base.f, ...(over.f || {}), curve: { ...base.f.curve, ...(over.f?.curve || {}) } };
  s.timbre = { ...base.timbre, ...(over.timbre || {}) };
  s.timbreB = { ...base.timbreB, ...(over.timbreB || {}) };
  s.path.spline = normalizeSplinePath(over.path?.spline);
  s.path.hEnv = { ...normalizeLane('height', over.path?.hEnv), domain: 'path' };
  s.path.ends = normalizeEnds(over.path?.ends);
  s.speed.env = normalizeLane('speed', over.speed?.env);
  s.f.env = normalizeLane('pitch', over.f?.env);
  s.lanes = Object.fromEntries(SOURCE_LANES.map((k) => [k, normalizeLane(k, over.lanes?.[k])]));
  s.timeMode = TIME_MODES.includes(over.timeMode) ? over.timeMode : 'speed';
  s.input = normalizeInput(over.input);
  s.group = normalizeGroup(over.group);
  return s;
}

/** Fill / clamp a saved spline path (new object). / 저장된 스플라인 경로 보정 */
export function normalizeSplinePath(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    dims: SPLINE_DIMS.includes(src.dims) ? src.dims : '2d',
    closed: !!src.closed,
    end: SPLINE_ENDS.includes(src.end) ? src.end : 'stop',
    run: src.run === 'duration' ? 'duration' : 'scene', // loop / ping-pong: until the scene ends, or for Duration / 순환·왕복: 장면 끝까지 또는 지속시간만큼
    nodes: normalizeSplineNodes(src.nodes).map((n) => ({ ...n, x: roundTo(n.x, 3), y: roundTo(n.y, 3), z: roundTo(n.z, 3), curv: roundTo(n.curv, 3), hin: n.hin.map((v) => roundTo(v, 3)), hout: n.hout.map((v) => roundTo(v, 3)) })),
  };
}

export const ORIENT_MODES = Object.freeze(['fixed', 'lanes', 'velocity', 'lookAt']);

/** Listener with every field present: position, orientation, optional motion along a path. / 청취자 (위치·방향·이동) */
export function normalizeListener(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const L = { x: num(src.x, 0), y: num(src.y, 0), z: num(src.z, 0), headingDeg: num(src.headingDeg, 0), pitchDeg: clamp(num(src.pitchDeg, 0), -90, 90), rollDeg: clamp(num(src.rollDeg, 0), -180, 180) };
  const mv = src.move && typeof src.move === 'object' ? src.move : {};
  // The motion reuses the source model (path, speed, time mode), so it has the same editors / 이동은 음원과 같은 모델
  const model = createSource(0, { id: 'listener', path: mv.path, speed: mv.speed, timeMode: mv.timeMode, start: mv.start, duration: mv.duration });
  if (!SPACE_PATH_TYPES.includes(model.path.type)) model.path.type = 'spline';
  if (!mv.path) model.path.type = 'spline';
  if (!SPEED_MODES.includes(model.speed.mode) || model.speed.mode === 'rankine' || model.speed.mode === 'track') model.speed.mode = 'const';
  if (model.speed.mode === 'env' && model.speed.env.domain === 'distance') model.speed.env.domain = 'path'; // no "distance to itself" / 자기 자신과의 거리는 없음
  L.move = { on: !!mv.on, path: model.path, speed: { ...model.speed, value: num(mv.speed?.value, 6) }, timeMode: model.timeMode, start: clamp(num(mv.start, 0), 0, 300), duration: clamp(num(mv.duration, 15), 0.1, 300) };
  const or = src.orient && typeof src.orient === 'object' ? src.orient : {};
  const ang = (k, lo, hi) => {
    const l = normalizeLane('gain', { ...createLane('gain', { domain: 'time', min: lo, max: hi }), ...(or[k] || {}), domain: 'time', scale: 'lin' });
    // normalizeLane clamps to the gain lane's −60 … 24: put the angle range back (it used to stay clamped) / 게인 레인 범위로 잘리던 각도 범위 복원
    l.min = clamp(num(or[k]?.min, lo), -3600, 3600);
    l.max = clamp(num(or[k]?.max, hi), -3600, 3600);
    return l;
  };
  L.orient = { mode: ORIENT_MODES.includes(or.mode) ? or.mode : 'fixed', lookAt: typeof or.lookAt === 'string' ? or.lookAt : '', yaw: ang('yaw', -180, 180), pitch: ang('pitch', -90, 90), roll: ang('roll', -90, 90) };
  for (const k of ['yaw', 'pitch', 'roll']) { const l = L.orient[k]; l.min = num(or[k]?.min, k === 'yaw' ? -180 : -90); l.max = num(or[k]?.max, k === 'yaw' ? 180 : 90); }
  return L;
}

function baseDoc() {
  return {
    c: 343,
    cScale: 1,
    airDist: 40,
    refDist: 1,
    listener: { x: 0, y: 0, z: 0, headingDeg: 0 },
    sources: [],
    activeSourceId: '',
    length: 30,
    bakeRate: 200,
    panMode: 'equalPower',
    seed: 1,
    preset: 'passby',
    tool: 'move',
    view: { cx: 0, cy: 0, span: 120 },
    view3d: { layout: 'top', az: 35, el: 28, dist: 1 }, // view only: 'top' | 'quad', orbit camera / 뷰 전용
    spatial: { order: 3, weighting: 'maxre' }, // HOA settings of panMode 'binaural' and the ambiX export (sound only) / HOA 설정 (소리 전용)
  };
}

/** A preset document (ids are fixed so defaults stay deterministic). / 프리셋 문서 (고정 id) */
export function createSpacePreset(id = 'passby') {
  const d = baseDoc();
  d.preset = SPACE_PRESETS.includes(id) ? id : 'passby';
  const S = (i, over) => createSource(i, { id: `s${i + 1}`, ...over });
  switch (d.preset) {
    case 'orbit':
      d.cScale = 0.4;
      d.refDist = 5;
      d.length = 22;
      d.sources = [S(0, { name: 'Orbiter', path: { type: 'orbit', cx: 14, cy: 8, rx: 26, ry: 26, phase: 0, dir: 1 }, speed: { value: 24 }, duration: 20, f: { hz: 330 } })];
      d.view = { cx: 10, cy: 6, span: 110 };
      break;
    case 'spiral':
      d.cScale = 0.3;
      d.refDist = 3;
      d.length = 26;
      d.sources = [S(0, { name: 'Spiral', path: { type: 'spiral', cx: 15, cy: 10, r0: 120, r1: 3, turns: 2, phase: 0, dir: -1 }, speed: { value: 35 }, duration: 22, f: { hz: 392 } })];
      d.view = { cx: 10, cy: 6, span: 300 };
      break;
    case 'sirens':
      d.cScale = 0.5;
      d.refDist = 6;
      d.length = 20;
      d.sources = [
        S(0, { name: 'Siren A', path: { type: 'line', x0: -150, y0: 6, x1: 150, y1: 6 }, speed: { value: 22 }, duration: 14, f: { mode: 'curve', hz0: 600, hz1: 900, curve: createProfileCurve('trig', { trigFn: 'sin', trigX0: 0, trigX1: 7, trigNorm: true }) } }),
        S(1, { name: 'Siren B', path: { type: 'line', x0: 150, y0: -6, x1: -150, y1: -6 }, speed: { value: 18 }, start: 1.5, duration: 16, f: { mode: 'curve', hz0: 450, hz1: 700, curve: createProfileCurve('trig', { trigFn: 'sin', trigX0: 0, trigX1: 5, trigNorm: true }) }, timbre: { sine: 0.3, tri: 0.6, saw: 0.4, sqr: 0.1, rich: 0.1 } }),
      ];
      d.view = { cx: 0, cy: 0, span: 140 };
      break;
    case 'swarm': {
      d.cScale = 0.35;
      d.refDist = 10;
      d.length = 26;
      const hz = [220, 277.18, 329.63, 440];
      const ab = [[1, 2], [3, 2], [2, 3], [3, 4]];
      d.sources = hz.map((f, i) => S(i, {
        name: `Swarm ${i + 1}`,
        path: { type: 'lissajous', cx: 0, cy: 6, ax: 32 + 6 * i, ay: 24 + 4 * i, a: ab[i][0], b: ab[i][1], delta: 30 + 40 * i },
        speed: { value: 14 + 4 * i },
        start: 0.5 * i,
        duration: 22,
        f: { hz: f },
        baseGain: 0.45,
      }));
      d.view = { cx: 0, cy: 4, span: 130 };
      break;
    }
    case 'vortex': {
      // Rankine vortex: tracers at different radii turn with different angular speeds (core rigid, outside 1/r)
      d.cScale = 0.3;
      d.refDist = 6;
      d.length = 26;
      d.listener = { x: -34, y: 0, z: 0, headingDeg: 0 };
      const radii = [5, 10, 14, 22, 34, 52];
      const hz = [220, 277.18, 329.63, 392, 493.88, 587.33];
      d.sources = radii.map((r, i) => S(i, {
        name: `r = ${r} m`,
        path: { type: 'orbit', cx: 12, cy: 0, rx: r, ry: r, phase: 60 * i, dir: 1 },
        speed: { mode: 'rankine', gamma: 3500, core: 14 },
        duration: 24,
        f: { hz: hz[i] },
        baseGain: 0.4,
      }));
      d.view = { cx: 10, cy: 0, span: 150 };
      break;
    }
    case 'comet': {
      // A comet: faster as it falls towards the listener, slower as it leaves. The speed envelope is
      // drawn against DISTANCE (vis-viva: v(r) = sqrt(v∞² + 2k/r)), so the asymmetry comes from the path.
      // 혜성: 다가올수록 빨라지고 멀어지며 느려짐. 속도 엔벨로프의 x축 = 거리 (vis-viva 식).
      d.cScale = 0.3;
      d.refDist = 4;
      d.length = 22;
      d.panMode = 'hrtf';
      const R0 = 3;
      const R1 = 180;
      const VMAX = 70;
      const vis = (r) => Math.sqrt(12 * 12 + (2 * 6900) / Math.max(R0, r));
      const xs = Array.from({ length: 25 }, (_, i) => (i / 24) ** 3); // dense near the listener / 가까운 쪽을 조밀하게
      d.sources = [S(0, {
        name: 'Comet',
        path: {
          type: 'spline', h: 0,
          spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints([
            { x: -150, y: 80, z: 35 }, { x: -80, y: 34, z: 16 }, { x: -30, y: 11, z: 6 }, { x: -6, y: 4.5, z: 3 },
            { x: 8, y: 2.5, z: 2.5 }, { x: 32, y: -9, z: 6 }, { x: 75, y: -34, z: 16 }, { x: 130, y: -65, z: 32 },
          ]) },
        },
        timeMode: 'speed',
        speed: { mode: 'env', env: createLane('speed', { on: true, domain: 'distance', dom: [R0, R1], min: 0, max: VMAX, curve: { engine: 'custom', reverse: false, inverse: false, customPoints: pointsFromFunction((x) => vis(R0 + (R1 - R0) * x) / VMAX, xs) } }) },
        duration: 18,
        f: { hz: 220 },
        timbre: { sine: 0.4, tri: 0.3, saw: 0.5, sqr: 0.1, rich: 0.4 },
        lanes: { bright: createLane('bright', { on: true, domain: 'distance', dom: [R0, R1], min: -2, max: 2, curve: { engine: 'custom', reverse: false, inverse: false, customPoints: pointsFromFunction((x) => 1 - Math.sqrt(x), xs) } }) },
      })];
      d.view = { cx: -8, cy: 6, span: 320 };
      d.view3d = { layout: 'quad', az: 35, el: 28, dist: 1 };
      break;
    }
    case 'flythrough': {
      // The listener flies between four resting sources: its own speed makes the glissandi
      // 청취자가 정지한 음원 넷 사이를 지나감: 청취자 자신의 속도가 글리산도를 만듦
      d.cScale = 0.25;
      d.refDist = 6;
      d.length = 20;
      d.panMode = 'hrtf';
      const spots = [[-30, 8, 2, 220], [-8, -7, 6, 277.18], [14, 9, 1, 329.63], [36, -6, 8, 415.3]];
      d.sources = spots.map(([x, y, h, hz], i) => S(i, { name: `Beacon ${i + 1}`, path: { type: 'static', x, y, h }, duration: 18, f: { hz }, baseGain: 0.45 }));
      d.listener = { x: -70, y: 0, z: 2, headingDeg: 90, move: { on: true, path: { type: 'spline', spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints([{ x: -70, y: 0, z: 2 }, { x: -25, y: 3, z: 3 }, { x: 5, y: -2, z: 4 }, { x: 30, y: 2, z: 3 }, { x: 75, y: 0, z: 2 }]) } }, speed: { mode: 'const', value: 9 }, start: 0.5 }, orient: { mode: 'velocity' } };
      d.view = { cx: 0, cy: 0, span: 180 };
      d.view3d = { layout: 'quad', az: 30, el: 30, dist: 1 };
      break;
    }
    case 'openfield': {
      // A fly-by 3 m above open ground: the ground reflection combs the sound as the path difference changes
      // 지면 3 m 위의 통과: 경로 차가 변하면서 지면 반사가 콤 필터를 움직임
      d.cScale = 0.6;
      d.refDist = 6;
      d.length = 16;
      d.listener = { x: 0, y: 0, z: 1.7, headingDeg: 0 };
      d.room = { quality: 'ground', floorZ: 0, absorb: { floor: 0.15 }, hfHz: 9000 };
      d.sources = [S(0, { name: 'Low pass', path: { type: 'line', x0: -120, y0: 8, x1: 120, y1: 8, h: 3 }, speed: { value: 20 }, duration: 12, f: { hz: 220 }, timbre: { sine: 0.2, tri: 0.2, saw: 0.9, sqr: 0.2, rich: 0.7 } })];
      break;
    }
    case 'hall': {
      // A source walking away down a hall: first-order reflections and a reverb give the distance
      // 홀 안에서 멀어지는 음원: 1차 반사와 잔향이 거리감을 만듦
      d.cScale = 1;
      d.refDist = 2;
      d.length = 20;
      d.panMode = 'binaural';
      d.listener = { x: 0, y: -14, z: 1.7, headingDeg: 0 };
      d.room = { quality: 'first', floorZ: 0, w: 22, d: 40, h: 11, cx: 0, cy: 0, absorb: { floor: 0.25, ceil: 0.45, xn: 0.35, xp: 0.35, yn: 0.4, yp: 0.4 }, hfHz: 5000, reverb: { on: true, rt60: 2.2, level: 0.3, predelay: 0.03, damp: 0.55, seed: 3, law: 'physical' } };
      d.sources = [S(0, { name: 'Walker', path: { type: 'spline', spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints([{ x: -6, y: -11, z: 1.5 }, { x: 5, y: -4, z: 1.5 }, { x: -4, y: 6, z: 1.5 }, { x: 3, y: 17, z: 1.5 }]) } }, speed: { value: 2.4 }, duration: 16, f: { hz: 330 }, doppler: true })];
      break;
    }
    case 'chase': {
      // The comet again, but the listener keeps facing where it is heard / 혜성을 청취자가 계속 따라 봄
      const comet = createSpacePreset('comet');
      Object.assign(d, comet, { preset: 'chase' });
      d.panMode = 'binaural';
      d.listener = { x: 0, y: 0, z: 0, headingDeg: 0, orient: { mode: 'lookAt', lookAt: 's1' } };
      break;
    }
    case 'helix': {
      // A source climbing around the listener: the elevation is heard in HRTF mode / 청취자 주위를 돌며 올라가는 나선
      d.cScale = 0.4;
      d.refDist = 12;
      d.length = 20;
      d.panMode = 'hrtf';
      const pts = [];
      for (let i = 0; i <= 24; i++) { const a = (i / 8) * TAU; pts.push({ x: roundTo(16 * Math.cos(a), 2), y: roundTo(16 * Math.sin(a), 2), z: roundTo(-4 + (34 * i) / 24, 2) }); }
      d.sources = [S(0, { name: 'Helix', path: { type: 'spline', spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints(pts) } }, speed: { value: 18 }, duration: 17, f: { hz: 330 } })];
      d.view = { cx: 0, cy: 0, span: 70 };
      d.view3d = { layout: 'quad', az: 40, el: 24, dist: 1 };
      break;
    }
    default:
      // refDist = closest approach → the pass peaks at unity distance gain / 최근접 = 기준 거리
      d.cScale = 0.5;
      d.refDist = 5;
      d.length = 17;
      d.sources = [S(0, { name: 'Pass-by', path: { type: 'line', x0: -150, y0: 5, x1: 150, y1: 5 }, speed: { value: 20 }, duration: 15, f: { hz: 440 } })];
      d.view = { cx: 0, cy: 0, span: 120 };
  }
  d.activeSourceId = d.sources[0].id;
  return d;
}

export function createDefaultSpaceParams() {
  return createSpacePreset('passby');
}

/**
 * HOA settings (sound only). `array` and `hrir` are added to the object only when they are set, so
 * documents that never used them keep the keys they had ({ order, weighting }).
 *   array = { layout, method, energyNorm, custom: [{ label, az, el, dist, lfe }], route: [ch], trimDb: [dB], dist: [m] }
 *           (route / trimDb / dist are per loudspeaker, LFE channels not counted; absent = the layout's own)
 *   hrir  = id of a user HRIR set (audio/hrir-store.js), or absent = the browser's HRTF
 * HOA 설정 (소리 전용). array·hrir은 설정된 경우에만 객체에 들어감 (예전 문서의 키는 그대로).
 */
export function normalizeSpatial(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { order: HOA_ORDERS.includes(Number(src.order)) ? Number(src.order) : 3, weighting: HOA_WEIGHTS.includes(src.weighting) ? src.weighting : 'maxre' };
  if (src.array && typeof src.array === 'object') {
    const a = src.array;
    const nums = (x, lo, hi) => (Array.isArray(x) ? x.slice(0, ARRAY_MAX_SPEAKERS).map((v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : clamp(Number(v), lo, hi))) : []);
    out.array = {
      layout: ARRAY_LAYOUTS.includes(a.layout) ? a.layout : 'quad',
      method: ARRAY_METHODS.includes(a.method) ? a.method : 'modematch',
      energyNorm: !!a.energyNorm,
      custom: Array.isArray(a.custom) ? a.custom.slice(0, ARRAY_MAX_SPEAKERS).map(normalizeSpeaker) : [],
      route: nums(a.route, 0, 63).map((v) => (v === null ? null : Math.round(v))),
      trimDb: nums(a.trimDb, -36, 12),
      dist: nums(a.dist, 0.2, 100),
    };
  }
  if (typeof src.hrir === 'string' && src.hrir) out.hrir = src.hrir;
  return out;
}
/** The array settings of a document (defaults when it has none). / 문서의 배열 설정 (없으면 기본값) */
export const arraySettings = (doc) => normalizeSpatial({ ...(doc?.spatial || {}), array: doc?.spatial?.array || {} }).array;

/** Fill missing / invalid fields (older saves, hand-edited JSON). / 누락 필드 보정 */
export function normalizeSpaceDoc(raw) {
  const d = baseDoc();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const k of ['c', 'cScale', 'airDist', 'refDist', 'length', 'bakeRate', 'seed']) d[k] = num(src[k], d[k]);
  d.c = clamp(d.c, 50, 2000);
  d.cScale = clamp(d.cScale, 0.05, 1);
  d.airDist = clamp(d.airDist, 1, 1000);
  d.refDist = clamp(d.refDist, 0.1, 50);
  d.length = clamp(d.length, 1, 300);
  d.bakeRate = BAKE_RATES.includes(d.bakeRate) ? d.bakeRate : 200;
  d.listener = normalizeListener(src.listener);
  d.panMode = PAN_MODES.includes(src.panMode) ? src.panMode : 'equalPower';
  d.spatial = normalizeSpatial(src.spatial);
  d.tremolo = normalizeTremolo(src.tremolo); // studio output tremolo (sound only, never re-bakes) / 스튜디오 출력 트레몰로
  d.voiceMod = normalizeVoiceMod(src.voiceMod); // per-voice tremolo / vibrato (sound only) / 보이스별 변조
  d.trajLink = src.trajLink && typeof src.trajLink === 'object' ? src.trajLink : null; // imported Glissando trajectory link / 불러온 궤적 연결
  if (PLAYBACK_MODES.includes(src.playback) && src.playback !== 'light') d.playback = src.playback; // live playback mode (absent = 'light'); never part of a render / 실시간 재생 모드
  if (src.cEnv && typeof src.cEnv === 'object') d.cEnv = normalizeLane('cscale', src.cEnv); // speed of sound against time (absent = constant) / 시간에 따른 음속
  if (SUPER_MODES.includes(src.supersonic) && src.supersonic !== 'clamp') d.supersonic = src.supersonic; // 'multi' | 'boom' (absent = clamp) / 초음속 처리
  if (src.room && typeof src.room === 'object') d.room = deepClone(src.room); // room: reflections + reverb (space-room.js); absent = off / 방 (없으면 꺼짐)
  d.preset = typeof src.preset === 'string' ? src.preset : '';
  d.tool = src.tool === 'draw' || src.tool === 'node' ? src.tool : 'move';
  d.view = { ...d.view, ...(src.view || {}) };
  d.view3d = { ...d.view3d, ...(src.view3d || {}) };
  d.view3d.layout = d.view3d.layout === 'quad' ? 'quad' : 'top';
  if (!(typeof d.view3d.cz === 'number' && Number.isFinite(d.view3d.cz))) delete d.view3d.cz;
  d.view3d.timeline = !!d.view3d.timeline; // absent = automatic vertical centre / 없으면 자동
  d.view3d.rings = d.view3d.rings !== false; // wavefront rings shown (view only, default on) / 파면 링 표시 (뷰 전용, 기본 켬)
  d.view3d.nameSize = clamp(num(d.view3d.nameSize, 0.5), 0, 1); // source-name label size: 0 = hidden, 0.5 = 11 px (default), 1 = 22 px (view only) / 음원 이름 크기: 0 끔, 0.5 기본, 1 최대
  for (const [k, lo, hi, def] of [['az', -3600, 3600, 35], ['el', -89, 89, 28], ['dist', 0.4, 8, 1]]) d.view3d[k] = clamp(num(d.view3d[k], def), lo, hi);
  const list = Array.isArray(src.sources) && src.sources.length ? src.sources : createDefaultSpaceParams().sources;
  d.sources = list.slice(0, 64).map((s, i) => {
    const n = createSource(i, { ...s, id: typeof s?.id === 'string' && s.id ? s.id : `s${i + 1}` });
    if (!SPACE_PATH_TYPES.includes(n.path.type)) n.path.type = 'line';
    if (!SPEED_MODES.includes(n.speed.mode)) n.speed.mode = 'const';
    n.speed.gamma = clamp(num(n.speed.gamma, 3500), 0, 50000);
    n.speed.core = clamp(num(n.speed.core, 14), 0.5, 400);
    if (!PITCH_MODES.includes(n.f.mode)) n.f.mode = 'const';
    n.duration = clamp(num(n.duration, 15), 0.1, 300);
    n.start = clamp(num(n.start, 0), 0, 300);
    if (!Array.isArray(n.path.points)) n.path.points = [];
    return n;
  });
  d.activeSourceId = d.sources.some((s) => s.id === src.activeSourceId) ? src.activeSourceId : d.sources[0].id;
  return d;
}

/** Effective (artistic) speed of sound. / 실효 음속 */
export const effectiveC = (doc) => (doc.cEnv?.on ? soundSpeed(doc).min : clamp(num(doc.c, 343), 50, 2000) * clamp(num(doc.cScale, 1), 0.05, 1)); // changing c(t): the slowest (speed clamp, displays) / 변하는 음속: 가장 느린 값

// ==========================================================================
// Geometry: analytic paths + arc-length tables / 기하: 해석적 경로 + 호 길이 표
// ==========================================================================

function catmull(p0, p1, p2, p3, f) {
  const f2 = f * f;
  const f3 = f2 * f;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
}
function catmullD(p0, p1, p2, p3, f) {
  return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * f * f);
}

/**
 * Analytic path P(u), P′(u) for u ∈ [0, 1] plus an arc-length table for S → u.
 * 해석적 경로 P(u), P′(u)와 호 길이 역함수 표.
 */
export function buildGeometry(path, listener = { x: 0, y: 0 }) {
  const p = path || {};
  let type = SPACE_PATH_TYPES.includes(p.type) ? p.type : 'line';
  let P;
  let D;
  let closed = false;
  if (type === 'spline') {
    // Node spline: P / D return {x, y, z}; 2-D splines sit at the constant height h / 2D 스플라인은 높이 h 고정
    const sp = p.spline || {};
    const is3 = sp.dims === '3d';
    const h = num(p.h, 0);
    const end = SPLINE_ENDS.includes(sp.end) ? sp.end : 'stop';
    const nodes = (Array.isArray(sp.nodes) ? sp.nodes : []).map((n) => ({ ...n, x: num(n.x, 0), y: num(n.y, 0), z: is3 ? num(n.z, 0) : h }));
    const isClosed = !!sp.closed || end === 'loop';
    const spl = buildSpline(nodes, { closed: isClosed });
    if (spl.len < 1e-9) {
      const q = spl.P(0);
      return { type: 'static', closed: false, len: 0, is3: true, P: () => ({ x: q.x, y: q.y, z: q.z }), D: () => ({ x: 0, y: 0, z: 0 }), locate: () => ({ u: 0, moving: false }) };
    }
    const locate = (S) => { const q = pathPosition(S, spl.len, end); return { u: spl.uAt(q.pos), moving: q.moving, dir: q.dir, pos: q.pos }; };
    return { type: 'spline', closed: isClosed, end, len: spl.len, is3: true, P: spl.P, D: spl.D, locate, spline: spl };
  }
  if (type === 'draw' && !(Array.isArray(p.points) && p.points.length >= 2)) type = 'static';
  if (type === 'line') {
    const x0 = num(p.x0, 0), y0 = num(p.y0, 0), x1 = num(p.x1, 0), y1 = num(p.y1, 0);
    if (Math.hypot(x1 - x0, y1 - y0) < 1e-9) type = 'static';
    P = (u) => ({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u });
    D = () => ({ x: x1 - x0, y: y1 - y0 });
  }
  if (type === 'orbit') {
    const cx = p.onListener ? num(listener.x, 0) : num(p.cx, 0);
    const cy = p.onListener ? num(listener.y, 0) : num(p.cy, 0);
    const rx = Math.max(0.1, num(p.rx, 20)), ry = Math.max(0.1, num(p.ry, 20));
    const ph = (num(p.phase, 0) * Math.PI) / 180;
    const dir = num(p.dir, 1) < 0 ? -1 : 1;
    closed = true;
    P = (u) => { const a = ph + dir * TAU * u; return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }; };
    D = (u) => { const a = ph + dir * TAU * u; return { x: -dir * TAU * rx * Math.sin(a), y: dir * TAU * ry * Math.cos(a) }; };
  } else if (type === 'lissajous') {
    const cx = num(p.cx, 0), cy = num(p.cy, 0), ax = Math.max(0.1, num(p.ax, 30)), ay = Math.max(0.1, num(p.ay, 20));
    const a = Math.max(1, Math.round(num(p.a, 1))), b = Math.max(1, Math.round(num(p.b, 2)));
    const dl = (num(p.delta, 90) * Math.PI) / 180;
    closed = true;
    P = (u) => ({ x: cx + ax * Math.sin(TAU * a * u + dl), y: cy + ay * Math.sin(TAU * b * u) });
    D = (u) => ({ x: ax * TAU * a * Math.cos(TAU * a * u + dl), y: ay * TAU * b * Math.cos(TAU * b * u) });
  } else if (type === 'spiral') {
    const cx = p.onListener ? num(listener.x, 0) : num(p.cx, 0);
    const cy = p.onListener ? num(listener.y, 0) : num(p.cy, 0);
    const r0 = Math.max(0, num(p.r0, 80)), r1 = Math.max(0, num(p.r1, 4));
    const turns = Math.max(0.05, num(p.turns, 2));
    const ph = (num(p.phase, 0) * Math.PI) / 180;
    const dir = num(p.dir, 1) < 0 ? -1 : 1;
    P = (u) => { const r = r0 + (r1 - r0) * u; const a = ph + dir * TAU * turns * u; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
    D = (u) => {
      const r = r0 + (r1 - r0) * u;
      const a = ph + dir * TAU * turns * u;
      const w = dir * TAU * turns;
      return { x: (r1 - r0) * Math.cos(a) - r * w * Math.sin(a), y: (r1 - r0) * Math.sin(a) + r * w * Math.cos(a) };
    };
  } else if (type === 'draw') {
    const pts = p.points.map((q) => ({ x: num(q.x, 0), y: num(q.y, 0) }));
    const segs = pts.length - 1;
    const seg = (u) => { const s = clamp(u, 0, 1) * segs; const i = Math.min(segs - 1, Math.floor(s)); return [i, s - i]; };
    const quad = (i) => [pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(segs, i + 2)]];
    P = (u) => { const [i, f] = seg(u); const [a, b, c, d] = quad(i); return { x: catmull(a.x, b.x, c.x, d.x, f), y: catmull(a.y, b.y, c.y, d.y, f) }; };
    D = (u) => { const [i, f] = seg(u); const [a, b, c, d] = quad(i); return { x: segs * catmullD(a.x, b.x, c.x, d.x, f), y: segs * catmullD(a.y, b.y, c.y, d.y, f) }; };
  } else if (type === 'static') {
    const x = type === 'static' && p.type === 'draw' && p.points?.[0] ? num(p.points[0].x, 0) : p.type === 'line' ? num(p.x0, 0) : num(p.x, 0);
    const y = type === 'static' && p.type === 'draw' && p.points?.[0] ? num(p.points[0].y, 0) : p.type === 'line' ? num(p.y0, 0) : num(p.y, 0);
    P = () => ({ x, y });
    D = () => ({ x: 0, y: 0 });
  }

  // Height envelope: z(u) from the start (u = 0) to the end (u = 1) of the path; closed paths repeat it every lap.
  // Start / end points (path.ends): x, y, z of the first and last point may be moved; the offset between
  // them is interpolated evenly along the path, so every point follows in proportion.
  // x of both = fraction of the horizontal path length, so a constant speed changes them at a constant rate.
  // 높이 엔벨로프 + 시작·끝점: 두 끝점의 이동량을 경로를 따라 균등 보간. x = 수평 경로 길이 비율.
  const zEnv = heightEnvelope(p);
  const ends = type === 'static' ? null : pathEnds(p);
  let warped = false;
  if (zEnv || ends) {
    const P0 = P;
    const D0 = D;
    const h0 = num(p.h, 0);
    const cxy = new Float64Array(ARC_N + 1);
    let q0 = P0(0);
    for (let i = 1; i <= ARC_N; i++) { const q = P0(i / ARC_N); cxy[i] = cxy[i - 1] + Math.hypot(q.x - q0.x, q.y - q0.y); q0 = q; }
    const tot = cxy[ARC_N];
    const frac = (u) => { if (!(tot > 1e-9)) return clamp(u, 0, 1); const s = clamp(u, 0, 1) * ARC_N; const i = Math.min(ARC_N - 1, Math.floor(s)); return (cxy[i] + (cxy[i + 1] - cxy[i]) * (s - i)) / tot; };
    const zBase = zEnv ? (u) => zEnv(frac(u)) : () => h0;
    let d0 = [0, 0, 0];
    let d1 = [0, 0, 0];
    if (ends) {
      const a = P0(0);
      const b = P0(1);
      const pick = (v, nat) => (Number.isFinite(v) ? v - nat : 0);
      d0 = [pick(ends.start.x, a.x), pick(ends.start.y, a.y), pick(ends.start.z, zBase(0))];
      d1 = [pick(ends.end.x, b.x), pick(ends.end.y, b.y), pick(ends.end.z, zBase(1))];
      if (d0.some((v, i) => Math.abs(v - d1[i]) > 1e-9)) closed = false; // start ≠ end: runs once, start → end / 한 번 진행
    }
    const add = (u) => { const f = frac(u); return [d0[0] + (d1[0] - d0[0]) * f, d0[1] + (d1[1] - d0[1]) * f, zBase(u) + d0[2] + (d1[2] - d0[2]) * f]; };
    P = (u) => { const q = P0(u); const o = add(u); return { x: q.x + o[0], y: q.y + o[1], z: o[2] }; };
    D = (u) => {
      const d = D0(u);
      if (!(u >= 0 && u <= 1)) return { x: d.x, y: d.y, z: 0 };
      const a = clamp(u - 1e-4, 0, 1);
      const b = clamp(u + 1e-4, 0, 1);
      const oa = add(a);
      const ob = add(b);
      const k = b > a ? 1 / (b - a) : 0;
      return { x: d.x + (ob[0] - oa[0]) * k, y: d.y + (ob[1] - oa[1]) * k, z: (ob[2] - oa[2]) * k };
    };
    warped = true;
  }
  // Arc-length table (chords of the analytic curve, z included) / 호 길이 표 (z 포함)
  const cum = new Float64Array(ARC_N + 1);
  let prev = P(0);
  for (let i = 1; i <= ARC_N; i++) {
    const q = P(i / ARC_N);
    cum[i] = cum[i - 1] + Math.hypot(q.x - prev.x, q.y - prev.y, (q.z || 0) - (prev.z || 0));
    prev = q;
  }
  const len = type === 'line' && !warped ? Math.hypot(D(0).x, D(0).y) : cum[ARC_N];
  const invert = (S) => {
    let lo = 0;
    let hi = ARC_N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= S) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    return (lo + (span > 0 ? (S - cum[lo]) / span : 0)) / ARC_N;
  };
  /** Arc distance S → { u, moving }. Lines extrapolate, closed paths wrap, open paths stop at the end. */
  const locate = (S) => {
    if (type === 'static' || len < 1e-9) return { u: 0, moving: false };
    if (type === 'line') return { u: warped && S >= 0 && S <= len ? invert(S) : S / len, moving: true };
    if (closed) return { u: invert(((S % len) + len) % len), moving: true };
    if (S >= len) return { u: 1, moving: false };
    return { u: invert(Math.max(0, S)), moving: true };
  };
  return { type, closed, len, P, D, locate, ...(warped ? { is3: true } : {}) };
}

const ENDS_AXES = Object.freeze(['x', 'y', 'z']);
/** Start / end point overrides of an analytic path: { start: {x,y,z}, end } (null = natural), or null when none. */
export function normalizeEnds(raw) {
  const side = (o) => Object.fromEntries(ENDS_AXES.map((k) => [k, o && o[k] !== null && o[k] !== '' && Number.isFinite(Number(o[k])) ? roundTo(Number(o[k]), 3) : null]));
  return { start: side(raw?.start), end: side(raw?.end) };
}
export function pathEnds(path) {
  if (!path?.ends || path.type === 'spline' || path.type === 'static') return null;
  const e = normalizeEnds(path.ends);
  return ENDS_AXES.some((k) => e.start[k] !== null || e.end[k] !== null) ? e : null;
}
/** Actual and natural (no overrides) start / end points of an analytic path. / 실제·원래 시작·끝점 */
export function pathEndpoints(path, listener) {
  const pt = (geo, u) => { const q = geo.P(u); return { x: q.x, y: q.y, z: q.z === undefined ? num(path.h, 0) : q.z }; };
  const g = buildGeometry(path, listener);
  const g0 = buildGeometry({ ...path, ends: null }, listener);
  return { start: pt(g, 0), end: pt(g, 1), natural: { start: pt(g0, 0), end: pt(g0, 1) } };
}

/** z(u) of an analytic path's height envelope (null when off; splines use their nodes). / 높이 엔벨로프 z(u) */
export function heightEnvelope(path) {
  if (!path?.hEnv?.on || path.type === 'spline') return null;
  return compileLane(normalizeLane('height', { ...path.hEnv, domain: 'path' }), [0, 1]);
}

// ==========================================================================
// Kinematics: speed profile + geometry / 운동학: 속도 프로파일 + 기하
// ==========================================================================

const mergeCurve = (curve) => ({ ...CURVE_DEFAULTS, engine: 'harmonic', reverse: false, inverse: false, ...(curve || {}) });

/** Profile y(x) ∈ [0, 1] sampled into a table (one curve-engine pass at bake time). */
function profileTable(curve) {
  const obj = mergeCurve(curve);
  const tab = new Float64Array(PROFILE_N + 1);
  for (let i = 0; i <= PROFILE_N; i++) {
    const y = evaluateCurveObjectY(obj, i / PROFILE_N, { regions: false });
    tab[i] = Number.isFinite(y) ? clamp(y, -0.5, 1.5) : i / PROFILE_N;
  }
  return tab;
}
const tableAt = (tab, x) => {
  const s = clamp(x, 0, 1) * PROFILE_N;
  const i = Math.min(PROFILE_N - 1, Math.floor(s));
  const f = s - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
};

/**
 * Time mode 'pinned': nodes carry a time (node.t, seconds of the source clock). The first node is at
 * 0 and the last at `dur` unless they are pinned themselves; nodes without a pin are passed at the
 * arc-length proportion between their pinned neighbours. s(τ) is the monotone cubic (Fritsch–Carlson)
 * through the pins, so the speed is continuous and never negative. Pins that do not increase are
 * ignored. If the result is faster than vMax the whole time axis is stretched (flagged as clamped).
 * 시간 모드 'pinned': 노드가 시각을 가짐. 핀 사이는 단조 큐빅으로 이어 속도가 연속·비음수. 증가하지 않는 핀은 무시.
 */
export function pinnedProfile(geo, nodes, dur, vMax) {
  const nodeS = geo.spline.nodeS;
  const last = nodeS.length - 1;
  let xs = [];
  let ys = [];
  for (let i = 0; i <= last; i++) {
    const n = nodes[i % nodes.length];
    let t = i === 0 ? 0 : i === last ? dur : NaN;
    if (i < nodes.length && Number.isFinite(Number(n?.t)) && n.t !== null) t = Math.max(0, Number(n.t));
    if (i === last && geo.closed) t = dur; // the closing point is the first node again / 닫는 점은 첫 노드
    if (!Number.isFinite(t)) continue;
    if (xs.length && !(t > xs[xs.length - 1] + 1e-3)) { if (i === last) { xs.pop(); ys.pop(); } else continue; }
    if (!xs.length && i > 0) { xs.push(0); ys.push(0); if (!(t > 1e-3)) continue; }
    xs.push(t);
    ys.push(nodeS[i]);
  }
  if (xs.length < 2 || xs.some((x, i) => i > 0 && !(x > xs[i - 1])) || ys.some((y, i) => i > 0 && y < ys[i - 1])) { xs = [0, Math.max(0.05, dur)]; ys = [0, geo.len]; }
  let total = xs[xs.length - 1];
  let sOf = createMonotoneInterpolator(xs, ys);
  const speedOf = (f, tau, T) => { const h = Math.min(1e-4, T * 1e-5); const a = Math.max(0, tau - h); const b = Math.min(T, tau + h); return Math.max(0, (f(b) - f(a)) / (b - a)); };
  let rawMax = 0;
  for (let k = 0; k <= 2000; k++) rawMax = Math.max(rawMax, speedOf(sOf, (k / 2000) * total, total));
  if (rawMax > vMax) { // stretch time so the fastest moment is vMax / 가장 빠른 순간이 vMax가 되도록 시간 늘림
    const k = rawMax / vMax;
    xs = xs.map((x) => x * k);
    total *= k;
    sOf = createMonotoneInterpolator(xs, ys);
  }
  const T = total;
  return {
    dur: clamp(T, 0.05, 300), lapSec: T, rawMax, scale: 1, pins: xs,
    distAt: (tau) => clamp(sOf(clamp(tau, 0, T)), 0, geo.len),
    speedAt: (tau) => (tau >= T ? 0 : speedOf(sOf, clamp(tau, 0, T), T)),
  };
}

const kinCache = new Map();
const KIN_CACHE_MAX = 48;

function kinSignature(src, doc) {
  const p = src.path || {};
  const lst = (p.type === 'orbit' || p.type === 'spiral') && p.onListener ? [doc.listener.x, doc.listener.y] : 0;
  // A distance-domain speed envelope depends on where the listener is / 거리 도메인 속도는 청취자 위치에 의존
  const env = src.speed?.mode === 'env' && src.speed.env?.domain === 'distance' ? [doc.listener.x, doc.listener.y, num(doc.listener.z, 0), doc.listener.move?.on ? doc.listener.move : 0] : 0;
  const runs = p.type === 'spline' && p.spline?.end !== 'stop' && p.spline?.run !== 'duration' ? [num(doc.length, 30)] : []; // life = the scene's length / 수명 = 장면 길이
  return JSON.stringify([p, src.speed, src.start, src.duration, effectiveC(doc), lst, src.timeMode, env, ...(superMode(doc) !== 'clamp' ? ['super'] : []), ...runs]);
}

/**
 * Kinematics of one source: stateAt(τ) for τ ∈ [0, duration] (seconds since its start).
 * 음원 하나의 운동학: stateAt(τ) (시작 후 경과 초).
 */
export function getKinematics(src, doc) {
  const g = src.group;
  if (!g) return baseKinematics(src, doc);
  // Formation: the lead's motion (or the source's own) displaced by the group offset / 편대: 리드의 운동 + 오프셋
  let lead = g.lead ? (doc.sources || []).find((s) => s.id === g.lead) : src;
  if (!lead || (lead !== src && lead.group?.lead)) lead = src; // a missing lead, or a chain → own path / 리드가 없거나 사슬이면 자기 경로
  const base = baseKinematics(lead, doc);
  const [a, b, c] = [num(g.off?.[0], 0), num(g.off?.[1], 0), num(g.off?.[2], 0)];
  if (!a && !b && !c) return base;
  const sig = `${base.sig}|group${JSON.stringify([g.frame, a, b, c])}`;
  const hit = kinCache.get(sig);
  if (hit) return hit;
  let stateAt;
  if (g.frame === 'world') stateAt = (tau) => { const st = base.stateAt(tau); return { ...st, x: st.x + a, y: st.y + b, z: st.z + c }; };
  else {
    const H = 1e-3;
    /** Direction of travel at τ (looks ahead / behind where the source stands still). / τ에서의 진행 방향 */
    const heading = (tau, st) => {
      let { vx, vy, vz } = st;
      if (vx * vx + vy * vy + vz * vz < 1e-12) {
        const p1 = base.stateAt(Math.min(base.dur, tau + 0.05));
        const p0 = base.stateAt(Math.max(0, tau - 0.05));
        vx = p1.x - p0.x; vy = p1.y - p0.y; vz = p1.z - p0.z;
      }
      const l = Math.sqrt(vx * vx + vy * vy + vz * vz);
      return l < 1e-9 ? [0, 1, 0] : [vx / l, vy / l, vz / l];
    };
    const posAt = (tau) => {
      const st = base.stateAt(tau);
      const f = heading(tau, st);
      const hl = Math.hypot(f[0], f[1]);
      const r = hl < 1e-9 ? [1, 0, 0] : [f[1] / hl, -f[0] / hl, 0]; // to the right of the motion, horizontal / 진행 방향의 오른쪽 (수평)
      const u = [r[1] * f[2], -r[0] * f[2], r[0] * f[1] - r[1] * f[0]]; // r × f
      return [st.x + a * f[0] + b * r[0] + c * u[0], st.y + a * f[1] + b * r[1] + c * u[1], st.z + a * f[2] + b * r[2] + c * u[2]];
    };
    stateAt = (tau) => {
      const tt = clamp(tau, 0, base.dur);
      const p = posAt(tt);
      const t1 = Math.min(base.dur, tt + H);
      const t0 = Math.max(0, tt - H);
      if (t1 - t0 < 1e-9) return { x: p[0], y: p[1], z: p[2], vx: 0, vy: 0, vz: 0, speed: 0 };
      const p1 = posAt(t1);
      const p0 = posAt(t0);
      const k = 1 / (t1 - t0); // the frame turns with the path: the velocity is that of the displaced point / 좌표계가 경로와 함께 돌므로 속도는 오프셋 점의 것
      const vx = (p1[0] - p0[0]) * k, vy = (p1[1] - p0[1]) * k, vz = (p1[2] - p0[2]) * k;
      return { x: p[0], y: p[1], z: p[2], vx, vy, vz, speed: Math.sqrt(vx * vx + vy * vy + vz * vz) };
    };
  }
  const kin = { ...base, sig, stateAt, rRange: null, poly: null, lead: lead === src ? null : lead.id };
  kinCache.set(sig, kin);
  if (kinCache.size > KIN_CACHE_MAX) kinCache.delete(kinCache.keys().next().value);
  return kin;
}

/** Kinematics of a source on its own path (no formation offset). / 자기 경로 위의 운동학 (편대 오프셋 없음) */
function baseKinematics(src, doc) {
  const sig = kinSignature(src, doc);
  const hit = kinCache.get(sig);
  if (hit) return hit;
  const cEff = effectiveC(doc);
  const vMax = (superMode(doc) === 'clamp' ? SUPERSONIC_FRACTION : 50) * cEff; // clamp off: sources may outrun their sound / 클램프 해제
  const geo = buildGeometry(src.path, doc.listener);
  let dur = Math.max(0.05, num(src.duration, 15));
  const start = Math.max(0, num(src.start, 0));
  const h = num(src.path?.h, 0);
  let sp = src.speed || {};
  // 'track': the path (× laps) is travelled in exactly the duration — in the Manager the duration follows
  // the track's length (space-panels syncs it). A constant speed v = laps · L / duration.
  // 'track': 경로(× 바퀴)를 지속시간에 정확히 주행 — 매니저에서는 지속시간이 트랙 길이를 따름. v = 바퀴 · L / 지속시간
  if (sp.mode === 'track') sp = { ...sp, mode: 'const', value: geo.len > 1e-9 ? (trackLaps(sp) * geo.len) / dur : 0 };
  let rawMax = 0;
  let speedAt;
  let distAt;
  let lapSec = NaN;
  let rRange = null;
  if (geo.type === 'static') {
    speedAt = () => 0;
    distAt = () => 0;
  } else if (geo.type === 'spline' || sp.mode === 'env') {
    // Spline paths and envelope speeds: tabulated motion (space-motion.js) / 스플라인·엔벨로프 속도: 표 기반 운동
    const L = doc.listener;
    const Lz = num(L.z, 0);
    const end = geo.type === 'spline' ? geo.end : geo.closed ? 'loop' : 'stop';
    const period = end === 'pingpong' ? 2 * geo.len : geo.len;
    const posOf = (S) => pathPosition(S, geo.len, end).pos;
    const pointAt = geo.type === 'spline' ? (pos) => geo.P(geo.spline.uAt(pos)) : (pos) => geo.P(geo.locate(pos).u);
    const rAt = (pos) => { const q = pointAt(pos); const z = q.z === undefined ? h : q.z; return Math.sqrt((q.x - L.x) ** 2 + (q.y - L.y) ** 2 + (z - Lz) ** 2); };
    let spec;
    if (sp.mode === 'env') {
      const lane = normalizeLane('speed', sp.env);
      if (lane.domain === 'time') {
        const fn = compileLane(lane, [0, dur]);
        spec = { kind: 'time', v: fn, ext: Math.max(dur, fn.range[1]) };
      } else if (lane.domain === 'distance') {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i <= 256; i++) { const r = rAt((i / 256) * geo.len); lo = Math.min(lo, r); hi = Math.max(hi, r); }
        rRange = [lo, Math.max(lo + 1e-6, hi)];
        const fn = compileLane(lane, rRange);
        const lmot = getListenerMotion(doc);
        if (!lmot) spec = { kind: 'pos', v: (pos) => fn(rAt(pos)) };
        else {
          // Moving listener: the distance depends on time as well, so ds/dτ = v(|P(s) − L(start + τ)|) is
          // integrated forward (midpoint rule) and handed over as a time-domain profile. The distance is
          // measured to where the listener is at the moment of EMISSION.
          // 움직이는 청취자: 거리가 시간에도 의존 → ds/dτ를 전진 적분해 시간 도메인 프로파일로 넘김 (방출 시점의 청취자 위치 기준).
          const hStep = 1 / 200;
          const limit = geo.type === 'spline' && end === 'stop' ? 300 : dur;
          const rNow = (S, tau) => { const q = pointAt(posOf(S)); const z = q.z === undefined ? h : q.z; const Lt = lmot.at(start + tau); return Math.sqrt((q.x - Lt.x) ** 2 + (q.y - Lt.y) ** 2 + (z - Lt.z) ** 2); };
          const vs = [];
          let S = 0;
          for (let k = 0; k * hStep <= limit + hStep; k++) {
            const tau = k * hStep;
            const v0 = Math.max(0.05, Math.min(vMax, fn(rNow(S, tau))));
            vs.push(v0);
            S += hStep * Math.max(0.05, Math.min(vMax, fn(rNow(S + 0.5 * hStep * v0, tau + 0.5 * hStep))));
            if (geo.type === 'spline' && end === 'stop' && S >= geo.len) { vs.push(Math.max(0.05, Math.min(vMax, fn(rNow(geo.len, tau + hStep))))); break; }
          }
          const ext = Math.max(hStep, (vs.length - 1) * hStep);
          spec = { kind: 'time', v: (tau) => { const x = clamp(tau / hStep, 0, vs.length - 1); const i = Math.min(vs.length - 2, Math.floor(x)); return vs.length < 2 ? vs[0] : vs[i] + (vs[i + 1] - vs[i]) * (x - i); }, ext };
        }
      } else {
        const fn = compileLane(lane, [0, 1]);
        spec = { kind: 'pos', v: (pos) => fn(pos / geo.len) };
      }
    } else if (sp.mode === 'curve') {
      const yt = profileTable(sp.curve);
      const a = Math.max(0, num(sp.from, 5));
      const b = Math.max(0, num(sp.to, 30));
      spec = { kind: 'time', v: (tau) => a + (b - a) * tableAt(yt, tau / dur), ext: dur };
    } else {
      const v0 = Math.max(0, num(sp.value, 20)); // 'rankine' needs an orbit: constant value here / 랭킨은 궤도 전용
      spec = { kind: 'pos', v: () => v0 };
    }
    // Legacy path types keep their own duration (the path wraps or extrapolates) / 기존 경로는 지속시간 유지
    const isSpline = geo.type === 'spline';
    const pins = isSpline && src.timeMode === 'pinned' ? pinnedProfile(geo, src.path.spline?.nodes || [], dur, vMax) : null;
    // A looping / ping-pong spline keeps going until the end of the scene's time axis (run 'scene', the
    // default) instead of stopping after Duration (run 'duration'). / 순환·왕복 스플라인은 장면 끝까지 계속 (기본)
    const life = isSpline && end !== 'stop' && src.path.spline?.run !== 'duration' ? Math.max(0.05, num(doc.length, 30) - start) : null;
    const m = pins || buildMotion({ len: geo.len, period, posOf }, spec, { timeMode: isSpline && src.timeMode === 'fit' ? 'fit' : 'speed', userDur: dur, wraps: !isSpline || end !== 'stop', vMax, life });
    rawMax = m.rawMax;
    speedAt = m.speedAt;
    distAt = m.distAt;
    dur = m.dur;
    lapSec = m.lapSec;
  } else if (sp.mode === 'curve') {
    const yt = profileTable(sp.curve);
    const a = Math.max(0, num(sp.from, 5));
    const b = Math.max(0, num(sp.to, 30));
    const vt = new Float64Array(PROFILE_N + 1);
    const cs = new Float64Array(PROFILE_N + 1);
    const dtau = dur / PROFILE_N;
    for (let i = 0; i <= PROFILE_N; i++) {
      const raw = Math.max(0, a + (b - a) * yt[i]);
      rawMax = Math.max(rawMax, raw);
      vt[i] = Math.min(raw, vMax);
      if (i) cs[i] = cs[i - 1] + 0.5 * (vt[i] + vt[i - 1]) * dtau;
    }
    speedAt = (tau) => tableAt(vt, tau / dur);
    distAt = (tau) => {
      // exact integral of the piecewise-linear speed / 구간 선형 속도의 정확한 적분
      const s = clamp(tau / dur, 0, 1) * PROFILE_N;
      const i = Math.min(PROFILE_N - 1, Math.floor(s));
      const f = s - i;
      const v1 = vt[i] + (vt[i + 1] - vt[i]) * f;
      return cs[i] + 0.5 * (vt[i] + v1) * f * dtau;
    };
  } else {
    // Rankine: the orbit radius decides the speed; other paths fall back to the constant value / 랭킨: 궤도 반지름이 속도 결정
    const orbitR = geo.type === 'orbit' ? Math.sqrt(Math.max(0.1, num(src.path.rx, 20)) * Math.max(0.1, num(src.path.ry, 20))) : NaN;
    rawMax = sp.mode === 'rankine' && Number.isFinite(orbitR) ? rankineSpeed(orbitR, num(sp.gamma, 3500), num(sp.core, 14)) : Math.max(0, num(sp.value, 20));
    const v = Math.min(rawMax, vMax);
    speedAt = () => v;
    distAt = (tau) => v * tau;
  }
  const stateAt = (tau) => {
    const tt = clamp(tau, 0, dur);
    const S = distAt(tt);
    const loc = geo.locate(S);
    const q = geo.P(loc.u);
    const z = q.z === undefined ? h : q.z; // analytic paths sit at the constant height h / 해석적 경로는 높이 h
    const spd = loc.moving ? speedAt(tt) : 0;
    if (spd <= 0) return { x: q.x, y: q.y, z, vx: 0, vy: 0, vz: 0, speed: 0 };
    let d = geo.D(loc.u);
    if (geo.is3) {
      let dl3 = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
      if (dl3 < 1e-12) { // zero tangent (corner node): one-sided chord / 접선 0 (모서리 노드): 한쪽 현
        const q2 = geo.P(Math.min(1, loc.u + 1e-6));
        const q1 = geo.P(Math.max(0, loc.u + 1e-6 > 1 ? loc.u - 1e-6 : loc.u));
        d = { x: q2.x - q1.x, y: q2.y - q1.y, z: q2.z - q1.z };
        dl3 = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1;
      }
      const k = ((loc.dir || 1) * spd) / dl3;
      return { x: q.x, y: q.y, z, vx: k * d.x, vy: k * d.y, vz: k * d.z, speed: spd };
    }
    let dl = Math.hypot(d.x, d.y);
    if (dl < 1e-12) { // cusp: one-sided tangent / 첨점: 한쪽 접선
      const q2 = geo.P(loc.u + 1e-6);
      d = { x: q2.x - q.x, y: q2.y - q.y };
      dl = Math.hypot(d.x, d.y) || 1;
    }
    return { x: q.x, y: q.y, z, vx: (spd * d.x) / dl, vy: (spd * d.y) / dl, vz: 0, speed: spd };
  };
  /** Fraction of the path length at τ (0…1; wraps on closed paths). / 경로 진행도 */
  const progAt = (tau) => {
    if (geo.len < 1e-9) return 0;
    const S = distAt(clamp(tau, 0, dur));
    if (geo.type === 'spline') return pathPosition(S, geo.len, geo.end).pos / geo.len;
    return geo.closed ? (((S % geo.len) + geo.len) % geo.len) / geo.len : clamp(S / geo.len, 0, 1);
  };
  const kin = { sig, geo, dur, start, h, cEff, vMax, rawMax, clamped: rawMax > vMax + 1e-12, maxVc: rawMax / cEff, stateAt, speedAt, distAt, progAt, lapSec, rRange, poly: null };
  kinCache.set(sig, kin);
  if (kinCache.size > KIN_CACHE_MAX) kinCache.delete(kinCache.keys().next().value);
  return kin;
}

// ==========================================================================
// Moving listener / 움직이는 청취자
// ==========================================================================

const DEG = Math.PI / 180;
const listenerCache = new Map();

/**
 * Listener motion: null for a static listener, else { at(t) → {x, y, z, vx, vy, vz}, kin, t0, t1 }.
 * The listener follows its own path in LISTENER time t (it rests at the path start before
 * move.start and at its end afterwards). Speeds are clamped to 0.98·c like the sources'.
 * 청취자 이동: 정지면 null. 청취 시간 t에서 자기 경로를 따라감 (시작 전에는 출발점, 끝난 뒤에는 도착점).
 */
export function getListenerMotion(doc) {
  const L = doc.listener;
  if (!L?.move?.on) return null;
  const mv = L.move;
  const sig = JSON.stringify([mv, effectiveC(doc)]);
  const hit = listenerCache.get(sig);
  if (hit) return hit;
  // the path model of a source, seen from a fixed origin (a listener has no "distance to the listener")
  const kin = getKinematics({ id: 'listener', path: mv.path, speed: mv.speed, timeMode: mv.timeMode, start: mv.start, duration: mv.duration }, { ...doc, listener: { x: 0, y: 0, z: 0, headingDeg: 0 } });
  const at = (t) => {
    const tau = t - kin.start;
    if (tau <= 0) { const st = kin.stateAt(0); return { x: st.x, y: st.y, z: st.z, vx: 0, vy: 0, vz: 0 }; }
    if (tau >= kin.dur) { const st = kin.stateAt(kin.dur); return { x: st.x, y: st.y, z: st.z, vx: 0, vy: 0, vz: 0 }; }
    return kin.stateAt(tau);
  };
  const m = { at, kin, t0: kin.start, t1: kin.start + kin.dur, sig };
  listenerCache.set(sig, m);
  if (listenerCache.size > 8) listenerCache.delete(listenerCache.keys().next().value);
  return m;
}

/** Listener position (and velocity) at listener time t. / 청취 시각 t의 청취자 위치·속도 */
export function listenerAt(doc, t) {
  const m = getListenerMotion(doc);
  const L = doc.listener;
  return m ? m.at(t) : { x: L.x, y: L.y, z: num(L.z, 0), vx: 0, vy: 0, vz: 0 };
}

/**
 * Listener frame from yaw (0 = +y, clockwise +), pitch (up +) and roll (right ear down +), degrees:
 * { f: front, r: right, u: up } unit vectors. / 청취자 좌표계 (앞·오른쪽·위 단위벡터)
 */
export function listenerFrame(yawDeg, pitchDeg = 0, rollDeg = 0) {
  const a = yawDeg * DEG, p = pitchDeg * DEG, q = rollDeg * DEG;
  const sa = Math.sin(a), ca = Math.cos(a), sp = Math.sin(p), cp = Math.cos(p), sq = Math.sin(q), cq = Math.cos(q);
  const f = [sa * cp, ca * cp, sp];
  const r0 = [ca, -sa, 0];
  const u0 = [-sa * sp, -ca * sp, cp];
  return {
    f,
    r: [r0[0] * cq - u0[0] * sq, r0[1] * cq - u0[1] * sq, r0[2] * cq - u0[2] * sq],
    u: [u0[0] * cq + r0[0] * sq, u0[1] * cq + r0[1] * sq, u0[2] * cq + r0[2] * sq],
  };
}

/**
 * Orientation of the listener as a function of listener time: (t, Lt) → { yaw, pitch, roll } in
 * degrees, or null when it is the fixed heading with no pitch / roll (the older fast path).
 *   fixed    — headingDeg / pitchDeg / rollDeg
 *   lanes    — three envelopes against listener time (0 … document length)
 *   velocity — faces where it is going (keeps the last direction while resting)
 *   lookAt   — faces the HEARD position of a source (the emission position that is audible at t)
 * 청취자 방향 함수 (도). 고정 헤딩이고 피치·롤이 없으면 null (기존 경로).
 */
export function listenerOrientation(doc) {
  const L = doc.listener;
  const or = L.orient || { mode: 'fixed' };
  const fixed = { yaw: num(L.headingDeg, 0), pitch: num(L.pitchDeg, 0), roll: num(L.rollDeg, 0) };
  if (or.mode === 'lanes') {
    const span = [0, Math.max(1, num(doc.length, 30))];
    const fn = { yaw: compileLane(or.yaw, span), pitch: compileLane(or.pitch, span), roll: compileLane(or.roll, span) };
    return (t) => ({ yaw: fn.yaw(t), pitch: fn.pitch(t), roll: fn.roll(t) });
  }
  if (or.mode === 'velocity' && L.move?.on) {
    let last = { yaw: fixed.yaw, pitch: 0 };
    return (t, Lt) => {
      const h = Math.hypot(Lt.vx, Lt.vy);
      if (h > 1e-6 || Math.abs(Lt.vz) > 1e-6) last = { yaw: h > 1e-9 ? Math.atan2(Lt.vx, Lt.vy) / DEG : last.yaw, pitch: Math.atan2(Lt.vz, h) / DEG };
      return { yaw: last.yaw, pitch: last.pitch, roll: fixed.roll };
    };
  }
  if (or.mode === 'lookAt') {
    const target = (doc.sources || []).find((s) => s.id === or.lookAt);
    if (target) {
      const kin = getKinematics(target, doc);
      let guess = NaN;
      return (t, Lt) => {
        const sol = solveEmission(kin, Lt, t, guess);
        const st = sol ? sol.st : kin.stateAt(t < kin.start ? 0 : kin.dur);
        if (sol) guess = sol.tau;
        const dx = st.x - Lt.x, dy = st.y - Lt.y, dz = st.z - Lt.z;
        const h = Math.hypot(dx, dy);
        return { yaw: h > 1e-9 ? Math.atan2(dx, dy) / DEG : fixed.yaw, pitch: Math.atan2(dz, h) / DEG, roll: fixed.roll };
      };
    }
  }
  if (fixed.pitch === 0 && fixed.roll === 0) return null;
  return () => fixed;
}

/** Listener position, velocity and orientation at t (display helper). / 표시용: t 시점의 청취자 상태 */
export function listenerStateAt(doc, t) {
  const Lt = listenerAt(doc, t);
  const or = listenerOrientation(doc);
  const o = or ? or(t, Lt) : { yaw: num(doc.listener.headingDeg, 0), pitch: 0, roll: 0 };
  return { ...Lt, headingDeg: o.yaw, pitchDeg: o.pitch, rollDeg: o.roll };
}

/** [min, max] distance between the path and the listener over the source's life. / 경로와 청취자 사이 거리 범위 */
export function distanceRange(kin, listener) {
  const Lz = num(listener.z, 0);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 256; i++) {
    const st = kin.stateAt((i / 256) * kin.dur);
    const r = Math.sqrt((st.x - listener.x) ** 2 + (st.y - listener.y) ** 2 + (st.z - Lz) ** 2);
    lo = Math.min(lo, r);
    hi = Math.max(hi, r);
  }
  return [lo, Math.max(lo + 1e-6, hi)];
}

/**
 * Compile a lane into value(τ, r): τ = seconds of the source clock, r = distance of the emission
 * position to the listener. / 레인 → 값(τ, r) 함수 (τ = 음원 시계, r = 방출 위치의 거리)
 */
export function laneEvaluator(kind, rawLane, kin, listener) {
  const lane = normalizeLane(kind, rawLane);
  if (lane.domain === 'path') { const fn = compileLane(lane, [0, 1]); return (tau) => fn(kin.progAt(tau)); }
  if (lane.domain === 'distance') { const fn = compileLane(lane, distanceRange(kin, listener)); return (tau, r) => fn(r); }
  const fn = compileLane(lane, [0, kin.dur]);
  return (tau) => fn(tau);
}

/** Source pitch f_s(τ, r) as a function (table-based for curves). / 음원 자체 음고 */
export function sourcePitchFn(src, kin = null, listener = null) {
  const f = src.f || {};
  if (f.mode === 'env' && kin && listener) {
    const fn = laneEvaluator('pitch', f.env, kin, listener);
    return (tau, r) => clamp(fn(tau, r), 10, 20000);
  }
  if (f.mode === 'curve') {
    const yt = profileTable(f.curve);
    const a = clamp(num(f.hz0, 330), 10, 20000);
    const b = clamp(num(f.hz1, 660), 10, 20000);
    const dur = Math.max(0.05, num(src.duration, 15));
    return (tau) => a * Math.pow(b / a, tableAt(yt, tau / dur));
  }
  const hz = clamp(num(f.hz, 440), 10, 20000);
  return () => hz;
}

// ==========================================================================
// Retarded-time solver / 지연 시간 솔버
// ==========================================================================

/**
 * Solve g(τ) = start + τ + r(τ)/c − t = 0 for the emission time τ ∈ [0, dur].
 * Newton inside a bisection bracket (g is strictly increasing for |v| < c).
 * Returns null when nothing emitted is audible at t.
 * 방출 시각 τ 풀이 (이분 구간 안의 뉴턴). t에 들리는 소리가 없으면 null.
 */
export function solveEmission(kin, listener, t, guess = NaN) {
  const c = kin.cEff;
  const lx = listener.x;
  const ly = listener.y;
  const lz = num(listener.z, 0);
  const g = (tau, st) => { const dz = st.z - lz; return kin.start + tau + Math.sqrt((st.x - lx) ** 2 + (st.y - ly) ** 2 + dz * dz) / c - t; };
  let lo = 0;
  let hi = Math.min(kin.dur, t - kin.start);
  if (hi < 0) return null;
  let st = kin.stateAt(lo);
  let glo = g(lo, st);
  if (glo > SOLVER_TOL) return null; // not heard yet / 아직 도달 안 함
  if (glo >= -SOLVER_TOL) return { tau: lo, st, residual: glo, iters: 0 };
  st = kin.stateAt(hi);
  const ghi = g(hi, st);
  if (ghi < -SOLVER_TOL) return null; // already passed / 이미 지나감
  if (ghi <= SOLVER_TOL) return { tau: hi, st, residual: ghi, iters: 0 };
  let tau = Number.isFinite(guess) && guess > lo && guess < hi ? guess : 0.5 * (lo + hi);
  let res = 0;
  let it = 0;
  for (; it < 80; it++) {
    st = kin.stateAt(tau);
    const dx = st.x - lx;
    const dy = st.y - ly;
    const dz = st.z - lz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    res = kin.start + tau + r / c - t;
    if (Math.abs(res) <= SOLVER_TOL) break;
    if (res > 0) hi = tau; else lo = tau;
    let dot = dx * st.vx + dy * st.vy;
    if (st.vz) dot += dz * st.vz;
    const vr = r > 1e-12 ? dot / r : 0;
    let next = tau - res / (1 + vr / c);
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (hi - lo < 1e-14) { tau = next; break; }
    tau = next;
  }
  st = kin.stateAt(tau);
  return { tau, st, residual: g(tau, st), iters: it };
}

// ==========================================================================
// Bake / 베이킹
// ==========================================================================

/** Equal-power gains of Web Audio's StereoPannerNode for a mono input. / 등전력 팬 게인 */
export function equalPowerGains(pan) {
  const x = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return { L: Math.cos(x), R: Math.sin(x) };
}

/** Inverse-distance gain with a near clamp. / 역거리 게인 (근접 클램프) */
export const distanceGain = (r, refDist) => refDist / Math.max(r, refDist);
/** Air-absorption low-pass cutoff. / 공기 흡수 로우패스 컷오프 */
export const airCutoff = (r, airDist) => clamp(18000 / (1 + r / Math.max(1e-6, airDist)), 800, 20000);

/** Bake one source over the listener-time window it is audible in. / 음원 하나 베이킹 */
export function bakeSource(src, doc, kinOverride = null) {
  const kin = kinOverride || getKinematics(src, doc); // an override = an image source of the room (space-room.js) / 방의 영상 음원
  if (needsGeneralBake(doc, kin)) return bakeGeneral(src, doc, kin); // changing c(t) or a supersonic source (below) / 변하는 음속·초음속
  const L = doc.listener;
  const c = kin.cEff;
  const fs = sourcePitchFn(src, kin, L);
  const Lz = num(L.z, 0);
  const lm = getListenerMotion(doc); // null = static listener (the older code path, bit-identical) / null = 정지 청취자
  const orient = listenerOrientation(doc);
  const dist = (st) => { const dz = st.z - Lz; return Math.sqrt((st.x - L.x) ** 2 + (st.y - L.y) ** 2 + dz * dz); };
  /** Arrival time of what is emitted at source time τ: t = start + τ + |X(τ) − L(t)| / c (fixed point). */
  const arrival = (tau) => {
    const st = kin.stateAt(tau);
    let t = kin.start + tau + dist(st) / c;
    if (!lm) return t;
    for (let k = 0; k < 60; k++) {
      const Lt = lm.at(t);
      const next = kin.start + tau + Math.sqrt((st.x - Lt.x) ** 2 + (st.y - Lt.y) ** 2 + (st.z - Lt.z) ** 2) / c;
      if (Math.abs(next - t) < 1e-13) { t = next; break; }
      t = next;
    }
    return t;
  };
  // Lanes that are switched on (evaluated at the emission time) / 켜진 레인 (방출 시각 기준)
  const ln = src.lanes || {};
  const lane = (k) => (ln[k]?.on ? laneEvaluator(k, ln[k], kin, L) : null);
  const gainLane = lane('gain');
  const brightLane = lane('bright');
  const morphLane = lane('timbre');
  const airLane = lane('air');
  const dopLane = lane('dopplerAmt');
  const widthLane = lane('width');
  const t0 = lm ? arrival(0) : kin.start + dist(kin.stateAt(0)) / c;
  const t1 = lm ? arrival(kin.dur) : kin.start + kin.dur + dist(kin.stateAt(kin.dur)) / c;
  const rate = BAKE_RATES.includes(doc.bakeRate) ? doc.bakeRate : 200;
  const n = clamp(Math.ceil((t1 - t0) * rate) + 1, 2, MAX_BAKE_SAMPLES);
  const dt = (t1 - t0) / (n - 1);
  const F = () => new Float64Array(n);
  const b = { id: src.id, n, t0, t1, dt, t: F(), te: F(), fObs: F(), fs: F(), gain: F(), lp: F(), pan: F(), fwd: F(), up: F(), r: F(), vr: F(), x: F(), y: F(), z: F(), az: F() };
  if (gainLane) b.gainLane = F(); // linear factor on top of the distance law / 거리 법칙 위에 곱하는 선형 계수
  if (morphLane) b.morph = F(); // timbre A ↔ B, 0…1 / 음색 모핑
  if (widthLane) b.width = F(); // HOA source width, 0…1 / HOA 음원 폭
  const hd = (num(L.headingDeg, 0) * Math.PI) / 180;
  const ch = Math.cos(hd);
  const sh = Math.sin(hd);
  let guess = NaN;
  let maxRes = 0;
  let rMin = Infinity;
  /**
   * One sample with a moving and / or tilted listener. The listener is at L(t) when it hears the
   * sample, so the emission time solves τ + |X(τ) − L(t)| / c = t (L fixed for this t → same solver).
   *   dτ/dt = (1 + n̂·v_L / c) / (1 + n̂·v_S / c),  n̂ = (X(τ) − L(t)) / r   (implicit differentiation)
   * 움직이거나 기울어진 청취자의 표본 하나. dτ/dt = (1 + n̂·v_L/c) / (1 + n̂·v_S/c).
   */
  const bakeMoving = (i, t) => {
    const Lt = lm ? lm.at(t) : { x: L.x, y: L.y, z: Lz, vx: 0, vy: 0, vz: 0 };
    const sol = solveEmission(kin, Lt, t, guess);
    const tau = sol ? sol.tau : i === 0 ? 0 : kin.dur;
    const st = sol ? sol.st : kin.stateAt(tau);
    if (sol) { guess = tau; maxRes = Math.max(maxRes, Math.abs(sol.residual)); }
    const dx = st.x - Lt.x;
    const dy = st.y - Lt.y;
    const dz = st.z - Lt.z;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const vr = r > 1e-12 ? (dx * st.vx + dy * st.vy + dz * st.vz) / r : 0; // n̂·v_S
    const vl = r > 1e-12 ? (dx * Lt.vx + dy * Lt.vy + dz * Lt.vz) / r : 0; // n̂·v_L
    const o = orient ? orient(t, Lt) : { yaw: num(L.headingDeg, 0), pitch: 0, roll: 0 };
    const fr = listenerFrame(o.yaw, o.pitch, o.roll);
    const lat = dx * fr.r[0] + dy * fr.r[1] + dz * fr.r[2];
    const fwd = dx * fr.f[0] + dy * fr.f[1] + dz * fr.f[2];
    const up = dx * fr.u[0] + dy * fr.u[1] + dz * fr.u[2];
    const fsrc = fs(tau, r);
    const ratio = (1 + vl / c) / (1 + vr / c);
    b.t[i] = t;
    b.te[i] = kin.start + tau;
    b.fs[i] = fsrc;
    if (src.doppler === false) b.fObs[i] = fsrc;
    else b.fObs[i] = fsrc * (dopLane ? Math.pow(ratio, clamp(dopLane(tau, r), 0, 2)) : ratio);
    b.r[i] = r;
    b.vr[i] = vr;
    b.x[i] = st.x;
    b.y[i] = st.y;
    b.z[i] = st.z;
    b.pan[i] = src.pan !== false && r > 1e-9 ? clamp(lat / r, -1, 1) : 0;
    b.fwd[i] = src.pan !== false && r > 1e-9 ? fwd / r : 1;
    b.up[i] = src.pan !== false && r > 1e-9 ? up / r : 0;
    b.az[i] = (Math.atan2(lat, fwd) * 180) / Math.PI;
    if (src.airAbsorb === false) b.lp[i] = 20000;
    else if (airLane) b.lp[i] = airCutoff(r, doc.airDist / Math.max(1e-9, airLane(tau, r)));
    else b.lp[i] = airCutoff(r, doc.airDist);
    if (brightLane) b.lp[i] = clamp(b.lp[i] * Math.pow(2, brightLane(tau, r)), 200, 20000);
    if (gainLane) b.gainLane[i] = Math.pow(10, gainLane(tau, r) / 20);
    if (morphLane) b.morph[i] = clamp(morphLane(tau, r), 0, 1);
    if (widthLane) b.width[i] = clamp(widthLane(tau, r), 0, 1);
    if (r < rMin) rMin = r;
  };
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? t1 : t0 + i * dt;
    if (lm || orient) { bakeMoving(i, t); continue; }
    const sol = solveEmission(kin, L, t, guess);
    const tau = sol ? sol.tau : i === 0 ? 0 : kin.dur;
    const st = sol ? sol.st : kin.stateAt(tau);
    if (sol) { guess = tau; maxRes = Math.max(maxRes, Math.abs(sol.residual)); }
    const dx = st.x - L.x;
    const dy = st.y - L.y;
    const dz = st.z - Lz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let dot = dx * st.vx + dy * st.vy;
    if (st.vz) dot += dz * st.vz;
    const vr = r > 1e-12 ? dot / r : 0;
    const lat = dx * ch - dy * sh;
    const fwd = dx * sh + dy * ch;
    const fsrc = fs(tau, r);
    b.t[i] = t;
    b.te[i] = kin.start + tau;
    b.fs[i] = fsrc;
    if (src.doppler === false) b.fObs[i] = fsrc;
    else if (dopLane) b.fObs[i] = fsrc * Math.pow(1 / (1 + vr / c), clamp(dopLane(tau, r), 0, 2)); // f_s · ratio^amount
    else b.fObs[i] = fsrc / (1 + vr / c);
    b.r[i] = r;
    b.vr[i] = vr;
    b.x[i] = st.x;
    b.y[i] = st.y;
    b.z[i] = st.z;
    b.pan[i] = src.pan !== false && r > 1e-9 ? clamp(lat / r, -1, 1) : 0;
    b.fwd[i] = src.pan !== false && r > 1e-9 ? fwd / r : 1;
    b.up[i] = src.pan !== false && r > 1e-9 ? dz / r : 0;
    b.az[i] = (Math.atan2(lat, fwd) * 180) / Math.PI;
    if (src.airAbsorb === false) b.lp[i] = 20000;
    else if (airLane) b.lp[i] = airCutoff(r, doc.airDist / Math.max(1e-9, airLane(tau, r))); // amount 0 = no absorption / 0이면 흡수 없음
    else b.lp[i] = airCutoff(r, doc.airDist);
    if (brightLane) b.lp[i] = clamp(b.lp[i] * Math.pow(2, brightLane(tau, r)), 200, 20000);
    if (gainLane) b.gainLane[i] = Math.pow(10, gainLane(tau, r) / 20);
    if (morphLane) b.morph[i] = clamp(morphLane(tau, r), 0, 1);
    if (widthLane) b.width[i] = clamp(widthLane(tau, r), 0, 1);
    if (r < rMin) rMin = r;
  }
  const ref = clamp(num(doc.refDist, 1), 0.1, 50);
  const flat = distanceGain(rMin, ref); // distanceGain off → constant closest-approach level / 끄면 최근접 레벨 고정
  for (let i = 0; i < n; i++) b.gain[i] = src.distanceGain !== false ? distanceGain(b.r[i], ref) : flat;
  b.rMin = rMin;
  b.maxResidual = maxRes;
  b.clamped = kin.clamped;
  b.maxVc = kin.maxVc;
  b.fMin = Math.min(...minMax(b.fObs), ...minMax(b.fs));
  b.fMax = Math.max(...minMax(b.fObs), ...minMax(b.fs));
  return b;
}


// ==========================================================================
// Changing speed of sound and supersonic sources (follow-up F4-b) / 변하는 음속과 초음속 음원
// ==========================================================================

export const SUPER_MODES = Object.freeze(['clamp', 'multi', 'boom']);
/**
 * How the studio PLAYS a scene (exports and Manager clips are always rendered in full):
 *   'light'     — live graph, tuned not to stutter: reflections are decoded at first order and the
 *                 ones that cannot be heard are left out (default)
 *   'full'      — live graph, everything at the chosen order
 *   'prerender' — the scene is rendered in the background and played as one buffer (no load while
 *                 playing; an edit is heard in 'light' until the new render is ready)
 * 스튜디오가 장면을 재생하는 방식 (내보내기·매니저 클립은 항상 전체 품질).
 */
export const PLAYBACK_MODES = Object.freeze(['light', 'full', 'prerender']);
export const playbackMode = (doc) => (PLAYBACK_MODES.includes(doc?.playback) ? doc.playback : 'light');
/** Is the supersonic clamp switched off? / 초음속 클램프가 꺼져 있는가 */
export const superMode = (doc) => (SUPER_MODES.includes(doc?.supersonic) ? doc.supersonic : 'clamp');

const soundCache = new Map();
/**
 * The speed of sound of a document as functions of time:
 *   { varying, at(t), C(t) = ∫₀ᵗ c, Cinv(x), min, max }.
 * With `cEnv` on, c(t) = c · scale(t) where the envelope draws the artistic scale against listener
 * time (0 … document length; constant before and after). c(t) is piecewise linear on a 2 ms grid and
 * C is its exact integral, so the two are consistent to rounding.
 * 문서의 음속을 시간 함수로. cEnv가 켜지면 c(t) = c · scale(t) (2 ms 격자의 구간 선형, C는 그 정확한 적분).
 */
export function soundSpeed(doc) {
  const c0 = clamp(num(doc.c, 343), 50, 2000);
  if (!doc.cEnv?.on) {
    const c = c0 * clamp(num(doc.cScale, 1), 0.05, 1);
    return { varying: false, at: () => c, C: (t) => c * t, Cinv: (x) => x / c, min: c, max: c };
  }
  const len = Math.max(1, num(doc.length, 30));
  const key = JSON.stringify([c0, doc.cEnv, len]);
  const hit = soundCache.get(key);
  if (hit) return hit;
  const fn = compileLane(normalizeLane('cscale', doc.cEnv), [0, len]);
  const H = 0.002;
  const N = Math.ceil(len / H);
  const cs = new Float64Array(N + 1);
  const cum = new Float64Array(N + 1);
  let lo = Infinity, hi = 0;
  for (let i = 0; i <= N; i++) {
    cs[i] = c0 * clamp(fn(Math.min(len, i * H)), 0.05, 1);
    if (cs[i] < lo) lo = cs[i];
    if (cs[i] > hi) hi = cs[i];
    if (i) cum[i] = cum[i - 1] + 0.5 * (cs[i] + cs[i - 1]) * H;
  }
  const T = N * H;
  const at = (t) => { if (t <= 0) return cs[0]; if (t >= T) return cs[N]; const s = t / H; const i = Math.min(N - 1, Math.floor(s)); return cs[i] + (cs[i + 1] - cs[i]) * (s - i); };
  const C = (t) => {
    if (t <= 0) return cs[0] * t;
    if (t >= T) return cum[N] + cs[N] * (t - T);
    const i = Math.min(N - 1, Math.floor(t / H));
    const d = t - i * H;
    return cum[i] + cs[i] * d + (0.5 * (cs[i + 1] - cs[i]) * d * d) / H;
  };
  const Cinv = (x) => {
    if (x <= 0) return x / cs[0];
    if (x >= cum[N]) return T + (x - cum[N]) / cs[N];
    let a = 0, b = N;
    while (b - a > 1) { const m = (a + b) >> 1; if (cum[m] <= x) a = m; else b = m; }
    const k = (cs[a + 1] - cs[a]) / H;
    const rest = x - cum[a];
    const d = Math.abs(k) < 1e-9 ? rest / cs[a] : (-cs[a] + Math.sqrt(Math.max(0, cs[a] * cs[a] + 2 * k * rest))) / k;
    return a * H + d;
  };
  const res = { varying: true, at, C, Cinv, min: lo, max: hi };
  soundCache.set(key, res);
  if (soundCache.size > 6) soundCache.delete(soundCache.keys().next().value);
  return res;
}

/** Does this source need the general baker (changing c, or faster than sound with the clamp off)? */
const needsGeneralBake = (doc, kin) => !!doc.cEnv?.on || (superMode(doc) !== 'clamp' && kin.rawMax >= 0.98 * kin.cEff);

/**
 * General baker, parametrised by the EMISSION time: the arrival time
 *     A(τ) :  C(A) − C(start + τ) = |X(τ) − L(A)|          (C = ∫ c dt)
 * is computed on a dense τ grid and cut into monotone pieces. Every piece is one **arrival** of the
 * source: a subsonic source has one (A rises), a supersonic one has more — on a piece where A FALLS
 * the sound is heard backwards (what was emitted later arrives earlier). Each piece is inverted by
 * bisection onto a uniform listener-time grid and filled like the classic bake, with
 *     dτ/dt = (c(t) + n̂·v_L) / (c(τ) + n̂·v_S)             (derivative of the condition above)
 * A piece that begins at a minimum of A begins with a caustic — the Mach cone reaching the listener
 * (`born`): that is where the sonic boom is.
 * Returns the main arrival (the longest forward piece) with the others in `.more`.
 * 일반 베이커 (방출 시각으로 매개화): 도착 시각 A(τ)를 조밀한 τ 격자에서 구해 단조 구간으로 나눔. 구간 하나가 도착 하나.
 * A가 감소하는 구간에서는 소리가 거꾸로 들림. A의 극소에서 시작하는 구간은 마하 원뿔이 청취자를 지나는 순간(born).
 */
function bakeGeneral(src, doc, kin) {
  const snd = soundSpeed(doc);
  const L = doc.listener;
  const Lz = num(L.z, 0);
  const lm = getListenerMotion(doc);
  const orient = listenerOrientation(doc);
  const fs = sourcePitchFn(src, kin, L);
  const ln = src.lanes || {};
  const lane = (k) => (ln[k]?.on ? laneEvaluator(k, ln[k], kin, L) : null);
  const gainLane = lane('gain'), brightLane = lane('bright'), morphLane = lane('timbre'), airLane = lane('air'), dopLane = lane('dopplerAmt'), widthLane = lane('width');
  const still = { x: L.x, y: L.y, z: Lz, vx: 0, vy: 0, vz: 0 };
  const Lat = (t) => (lm ? lm.at(t) : still);
  const rOf = (st, Lt) => Math.sqrt((st.x - Lt.x) ** 2 + (st.y - Lt.y) ** 2 + (st.z - Lt.z) ** 2);
  const arrive = (tau) => {
    const st = kin.stateAt(tau);
    const Ce = snd.C(kin.start + tau);
    let t = snd.Cinv(Ce + rOf(st, Lat(kin.start + tau)));
    if (lm) for (let k = 0; k < 80; k++) { const next = snd.Cinv(Ce + rOf(st, lm.at(t))); if (Math.abs(next - t) < 1e-13) { t = next; break; } t = next; }
    return t;
  };
  const M = clamp(Math.ceil(kin.dur * 400), 64, 40000);
  const tauAt = (i) => (i / M) * kin.dur;
  const A = new Float64Array(M + 1);
  for (let i = 0; i <= M; i++) A[i] = arrive(tauAt(i));
  // Turning points of A, refined by golden-section search / A의 전환점 (황금 분할로 정밀화)
  const cuts = [{ tau: 0, interior: false }];
  for (let i = 1; i < M; i++) {
    const d0 = A[i] - A[i - 1], d1 = A[i + 1] - A[i];
    if (d0 === 0 || d0 * d1 >= 0) continue;
    const sign = d0 < 0 ? 1 : -1; // +1: a minimum of A / A의 극소
    let a = tauAt(i - 1), b = tauAt(i + 1);
    const g = 0.6180339887498949;
    let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = sign * arrive(x1), f2 = sign * arrive(x2);
    for (let k = 0; k < 60 && b - a > 1e-12; k++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = sign * arrive(x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = sign * arrive(x2); }
    }
    cuts.push({ tau: 0.5 * (a + b), interior: true, min: sign > 0 });
  }
  cuts.push({ tau: kin.dur, interior: false });
  const rate = BAKE_RATES.includes(doc.bakeRate) ? doc.bakeRate : 200;
  const ref = clamp(num(doc.refDist, 1), 0.1, 50);
  const pieces = [];
  for (let s = 0; s + 1 < cuts.length; s++) {
    const ta = cuts[s].tau, tb = cuts[s + 1].tau;
    const Aa = arrive(ta), Ab = arrive(tb);
    const forward = Ab > Aa;
    const t0 = Math.min(Aa, Ab), t1 = Math.max(Aa, Ab);
    if (t1 - t0 < 2 / rate) continue;
    const n = clamp(Math.ceil((t1 - t0) * rate) + 1, 2, MAX_BAKE_SAMPLES);
    const dt = (t1 - t0) / (n - 1);
    const F = () => new Float64Array(n);
    const b = { id: src.id, n, t0, t1, dt, t: F(), te: F(), fObs: F(), fs: F(), gain: F(), lp: F(), pan: F(), fwd: F(), up: F(), r: F(), vr: F(), x: F(), y: F(), z: F(), az: F() };
    if (gainLane) b.gainLane = F();
    if (morphLane) b.morph = F();
    if (widthLane) b.width = F();
    b.teStart = kin.start; // the source clock starts here (the first sample of a late piece does not) / 음원 시계의 시작
    b.reversed = !forward;
    b.born = forward ? cuts[s].interior && cuts[s].min : cuts[s + 1].interior && cuts[s + 1].min; // begins (in listener time) at a caustic / 코스틱에서 시작
    let rMin = Infinity, maxRes = 0;
    for (let i = 0; i < n; i++) {
      const t = i === n - 1 ? t1 : t0 + i * dt;
      // invert A on this monotone piece / 이 단조 구간에서 A의 역
      let lo = ta, hi = tb;
      if (t <= t0) { lo = hi = forward ? ta : tb; }
      else if (t >= t1) { lo = hi = forward ? tb : ta; }
      else for (let k = 0; k < 64 && hi - lo > 1e-13; k++) { const mid = 0.5 * (lo + hi); if ((arrive(mid) < t) === forward) lo = mid; else hi = mid; }
      const tau = 0.5 * (lo + hi);
      maxRes = Math.max(maxRes, Math.abs(arrive(tau) - t));
      const st = kin.stateAt(tau);
      const Lt = Lat(t);
      const dx = st.x - Lt.x, dy = st.y - Lt.y, dz = st.z - Lt.z;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const vr = r > 1e-12 ? (dx * st.vx + dy * st.vy + dz * st.vz) / r : 0;
      const vl = r > 1e-12 ? (dx * Lt.vx + dy * Lt.vy + dz * Lt.vz) / r : 0;
      const o = orient ? orient(t, Lt) : { yaw: num(L.headingDeg, 0), pitch: 0, roll: 0 };
      const fr = listenerFrame(o.yaw, o.pitch, o.roll);
      const lat = dx * fr.r[0] + dy * fr.r[1] + dz * fr.r[2];
      const fwd = dx * fr.f[0] + dy * fr.f[1] + dz * fr.f[2];
      const up = dx * fr.u[0] + dy * fr.u[1] + dz * fr.u[2];
      const fsrc = fs(tau, r);
      const den = snd.at(kin.start + tau) + vr;
      const ratio = Math.abs(den) < 1e-9 ? 1e9 : Math.abs((snd.at(t) + vl) / den); // |dτ/dt|: a reversed piece sounds at a positive pitch / 역행 구간도 양의 음고
      b.t[i] = t;
      b.te[i] = kin.start + tau;
      b.fs[i] = fsrc;
      b.fObs[i] = src.doppler === false ? fsrc : clamp(fsrc * (dopLane ? Math.pow(ratio, clamp(dopLane(tau, r), 0, 2)) : ratio), 0, 96000);
      b.r[i] = r; b.vr[i] = vr; b.x[i] = st.x; b.y[i] = st.y; b.z[i] = st.z;
      b.pan[i] = src.pan !== false && r > 1e-9 ? clamp(lat / r, -1, 1) : 0;
      b.fwd[i] = src.pan !== false && r > 1e-9 ? fwd / r : 1;
      b.up[i] = src.pan !== false && r > 1e-9 ? up / r : 0;
      b.az[i] = (Math.atan2(lat, fwd) * 180) / Math.PI;
      if (src.airAbsorb === false) b.lp[i] = 20000;
      else b.lp[i] = airCutoff(r, airLane ? doc.airDist / Math.max(1e-9, airLane(tau, r)) : doc.airDist);
      if (brightLane) b.lp[i] = clamp(b.lp[i] * Math.pow(2, brightLane(tau, r)), 200, 20000);
      if (gainLane) b.gainLane[i] = Math.pow(10, gainLane(tau, r) / 20);
      if (morphLane) b.morph[i] = clamp(morphLane(tau, r), 0, 1);
      if (widthLane) b.width[i] = clamp(widthLane(tau, r), 0, 1);
      if (r < rMin) rMin = r;
    }
    const flat = distanceGain(rMin, ref);
    for (let i = 0; i < n; i++) b.gain[i] = src.distanceGain !== false ? distanceGain(b.r[i], ref) : flat;
    b.rMin = rMin;
    b.maxResidual = maxRes;
    b.clamped = kin.clamped;
    b.maxVc = kin.rawMax / snd.min;
    b.fMin = Math.min(...minMax(b.fObs), ...minMax(b.fs));
    b.fMax = Math.max(...minMax(b.fObs), ...minMax(b.fs));
    pieces.push(b);
  }
  if (!pieces.length) { // nothing long enough to hear: a silent two-sample bake keeps every reader happy / 들을 것이 없음
    const t0 = arrive(0);
    const F = () => new Float64Array(2);
    return { id: src.id, n: 2, t0, t1: t0 + 1e-3, dt: 1e-3, t: Float64Array.of(t0, t0 + 1e-3), te: F(), fObs: Float64Array.of(440, 440), fs: Float64Array.of(440, 440), gain: F(), lp: Float64Array.of(20000, 20000), pan: F(), fwd: Float64Array.of(1, 1), up: F(), r: Float64Array.of(1, 1), vr: F(), x: F(), y: F(), z: F(), az: F(), rMin: 1, maxResidual: 0, clamped: false, maxVc: 0, fMin: 440, fMax: 440, teStart: kin.start, general: true };
  }
  const main = pieces.filter((p) => !p.reversed).sort((p, q) => (q.t1 - q.t0) - (p.t1 - p.t0))[0] || pieces[0];
  main.general = true;
  main.more = pieces.filter((p) => p !== main);
  return main;
}

/** Every arrival of a baked source: the main one and, for a supersonic source, the others. / 음원의 모든 도착 */
export const bakeArrivals = (b) => (b ? [b, ...(b.more || [])] : []);

/**
 * A short bake for the sonic boom of an arrival that is `born` at a caustic: the first 80 ms of the
 * arrival's direction and distance, to play an N-wave from there (space-audio.js).
 * 코스틱에서 시작하는 도착의 소닉 붐용 짧은 베이킹 (처음 80 ms의 방향·거리).
 */
export function boomBake(b, seconds = 0.08) {
  if (!b?.born || b.n < 3) return null;
  const m = Math.max(2, Math.min(b.n, Math.ceil(seconds / b.dt) + 1));
  const pad = Math.max(1, Math.ceil(0.012 / b.dt)); // lead-in before the shock, so the edge fade of a voice does not soften it / 충격 앞의 여유 (가장자리 페이드가 충격을 무디게 하지 않도록)
  const n = m + pad;
  const cut = (k) => Float64Array.from({ length: n }, (_, i) => b[k][Math.max(0, i - pad)]);
  const t0 = b.t0 - pad * b.dt;
  return { id: b.id, n, t0, t1: t0 + (n - 1) * b.dt, dt: b.dt, lead: pad * b.dt, shockAt: b.t0, t: Float64Array.from({ length: n }, (_, i) => t0 + i * b.dt), te: Float64Array.from({ length: n }, (_, i) => i * b.dt), fObs: new Float64Array(n).fill(1), fs: new Float64Array(n).fill(1), gain: cut('gain'), lp: new Float64Array(n).fill(20000), pan: cut('pan'), fwd: cut('fwd'), up: cut('up'), r: cut('r'), vr: cut('vr'), x: cut('x'), y: cut('y'), z: cut('z'), az: cut('az'), teStart: 0 };
}

function minMax(arr) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < arr.length; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
  return [lo, hi];
}

/** Physics-only signature (timbre, baseGain, mute/solo, names, view, panMode excluded). */
export function spaceSignature(doc) {
  const L = doc.listener || {};
  return JSON.stringify([
    doc.c, doc.cScale, doc.airDist, doc.refDist, doc.bakeRate, [L.x, L.y, L.headingDeg, num(L.z, 0), num(L.pitchDeg, 0), num(L.rollDeg, 0), L.move?.on ? L.move : 0, L.orient && L.orient.mode !== 'fixed' ? [L.orient, doc.length] : 0],
    (doc.sources || []).map((s) => [s.id, s.path, s.speed, s.start, s.duration, s.f, s.doppler !== false, s.distanceGain !== false, s.airAbsorb !== false, s.pan !== false, s.timeMode, s.lanes, ...(s.group ? [s.group] : [])]),
    ...(doc.cEnv?.on ? [doc.cEnv, doc.length] : []), ...((doc.sources || []).some((s) => s.path?.type === 'spline' && s.path.spline?.end !== 'stop' && s.path.spline?.run !== 'duration') ? [doc.length] : []), ...(superMode(doc) !== 'clamp' ? [superMode(doc)] : []),
  ]);
}

const bakeCache = new Map();
const BAKE_CACHE_MAX = 6;
let bakeCount = 0;

/** Number of real (non-cached) document bakes so far. / 실제 베이킹 횟수 */
export const getSpaceBakeCount = () => bakeCount;

/**
 * Bake every source of the document (memoised by physics signature).
 * 문서의 모든 음원 베이킹 (물리 시그니처로 캐시).
 * @returns {{ sig, sources: Map<string, object>, count, ms, maxVc, clamped, endSec }}
 */
export function bakeSpace(doc) {
  const sig = spaceSignature(doc);
  const hit = bakeCache.get(sig);
  if (hit) {
    bakeCache.delete(sig);
    bakeCache.set(sig, hit);
    return hit;
  }
  const t0 = now();
  const sources = new Map();
  let maxVc = 0;
  let clamped = false;
  let endSec = 0;
  for (const s of doc.sources || []) {
    const b = bakeSource(s, doc);
    sources.set(s.id, b);
    maxVc = Math.max(maxVc, b.maxVc);
    clamped = clamped || b.clamped;
    endSec = Math.max(endSec, b.t1);
    for (const m of b.more || []) endSec = Math.max(endSec, m.t1);
  }
  const result = Object.freeze({ sig, sources, count: ++bakeCount, ms: now() - t0, maxVc, clamped, endSec });
  bakeCache.set(sig, result);
  if (bakeCache.size > BAKE_CACHE_MAX) bakeCache.delete(bakeCache.keys().next().value);
  return result;
}

/** Linear lookup of a baked array at listener time t (NaN outside). / 베이킹 배열 선형 조회 */
export function sampleBake(b, key, t) {
  if (!b) return NaN;
  const eps = 1e-9 * Math.max(1, Math.abs(b.t1)); // t0 + x·(t1 − t0) may round past the ends / 끝점 반올림 허용
  if (t > b.t1 && t - b.t1 <= eps) t = b.t1;
  if (t < b.t0 && b.t0 - t <= eps) t = b.t0;
  if (!(t >= b.t0) || !(t <= b.t1)) return NaN;
  const s = (t - b.t0) / b.dt;
  const i = Math.min(b.n - 2, Math.floor(s));
  const f = s - i;
  const a = b[key];
  return a[i] + (a[i + 1] - a[i]) * f;
}

// ==========================================================================
// Display helpers (UI reads these; still pure) / 표시용 헬퍼
// ==========================================================================

/** Actual trajectory polyline over [0, dur] (cached on the kinematics). / 실제 궤적 */
export function trajectoryPolyline(src, doc, steps = 240) {
  const kin = getKinematics(src, doc);
  if (kin.poly && kin.poly.length === steps + 1) return kin.poly;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const st = kin.stateAt((i / steps) * kin.dur);
    pts.push({ x: st.x, y: st.y, z: st.z });
  }
  kin.poly = pts;
  return pts;
}

/**
 * Wavefront rings at listener time t: emitted at t − kΔ, radius c·kΔ (k = 1…count).
 * 청취자 시각 t의 파면 링: t − kΔ에 방출, 반지름 c·kΔ.
 */
export function wavefrontRings(src, doc, t, spacingSec, count = MAX_RINGS) {
  const kin = getKinematics(src, doc);
  const out = [];
  const n = Math.min(MAX_RINGS, count);
  for (let k = 1; k <= n; k++) {
    const te = t - k * spacingSec;
    const tau = te - kin.start;
    if (tau < 0) break;
    if (tau > kin.dur) continue;
    const st = kin.stateAt(tau);
    out.push({ x: st.x, y: st.y, z: st.z, radius: kin.cEff * k * spacingSec, k });
  }
  return out;
}

/** Drag handles of a path (world coordinates). / 경로 제어점 */
export function pathHandles(src, listener) {
  const p = src.path;
  const cx = p.onListener ? listener.x : p.cx;
  const cy = p.onListener ? listener.y : p.cy;
  switch (p.type) {
    case 'line': return [{ key: 'a', x: p.x0, y: p.y0 }, { key: 'b', x: p.x1, y: p.y1 }];
    case 'orbit': return [...(p.onListener ? [] : [{ key: 'c', x: cx, y: cy }]), { key: 'rx', x: cx + p.rx, y: cy }, { key: 'ry', x: cx, y: cy + p.ry }];
    case 'lissajous': return [{ key: 'c', x: cx, y: cy }, { key: 'axy', x: cx + p.ax, y: cy + p.ay }];
    case 'spiral': {
      const a0 = (p.phase * Math.PI) / 180;
      const a1 = a0 + (p.dir < 0 ? -1 : 1) * TAU * p.turns;
      return [...(p.onListener ? [] : [{ key: 'c', x: cx, y: cy }]), { key: 'r0', x: cx + p.r0 * Math.cos(a0), y: cy + p.r0 * Math.sin(a0) }, { key: 'r1', x: cx + p.r1 * Math.cos(a1), y: cy + p.r1 * Math.sin(a1) }];
    }
    case 'draw': return p.points.length ? [{ key: 'move', x: p.points[0].x, y: p.points[0].y }] : [];
    case 'spline': return []; // nodes are edited by the view code (space-views.js) / 노드는 뷰 코드가 편집
    default: return [{ key: 'xy', x: p.x, y: p.y }];
  }
}

/** Apply a handle drag to a path draft (mutates). / 제어점 드래그 적용 */
export function applyHandleDrag(path, key, x, y, listener) {
  const p = path;
  const R = (v) => roundTo(v, 1);
  const cx = p.onListener ? listener.x : p.cx;
  const cy = p.onListener ? listener.y : p.cy;
  if (key === 'a') { p.x0 = R(x); p.y0 = R(y); }
  else if (key === 'b') { p.x1 = R(x); p.y1 = R(y); }
  else if (key === 'xy') { p.x = R(x); p.y = R(y); }
  else if (key === 'c') { p.cx = R(x); p.cy = R(y); }
  else if (key === 'rx') p.rx = R(Math.max(0.5, Math.abs(x - cx)));
  else if (key === 'ry') p.ry = R(Math.max(0.5, Math.abs(y - cy)));
  else if (key === 'axy') { p.ax = R(Math.max(0.5, Math.abs(x - cx))); p.ay = R(Math.max(0.5, Math.abs(y - cy))); }
  else if (key === 'r0') p.r0 = R(Math.hypot(x - cx, y - cy));
  else if (key === 'r1') p.r1 = R(Math.hypot(x - cx, y - cy));
  else if (key === 'move' && p.points.length) {
    const dx = x - p.points[0].x;
    const dy = y - p.points[0].y;
    p.points = p.points.map((q) => ({ x: R(q.x + dx), y: R(q.y + dy) }));
  }
}

/** Resample a freehand stroke to ≤ maxPts equally spaced points. / 자유 경로 등간격 재표본 */
export function resampleStroke(raw, maxPts = MAX_DRAW_POINTS, minSpacing = 1) {
  const pts = (raw || []).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (pts.length < 2) return pts.map((q) => ({ x: roundTo(q.x, 1), y: roundTo(q.y, 1) }));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (total < 1e-6) return [{ x: roundTo(pts[0].x, 1), y: roundTo(pts[0].y, 1) }];
  const m = clamp(Math.round(total / minSpacing) + 1, 2, maxPts);
  const out = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = (k / (m - 1)) * total;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const span = cum[j + 1] - cum[j] || 1;
    const f = clamp((s - cum[j]) / span, 0, 1);
    out.push({ x: roundTo(pts[j].x + (pts[j + 1].x - pts[j].x) * f, 1), y: roundTo(pts[j].y + (pts[j + 1].y - pts[j].y) * f, 1) });
  }
  return out;
}

/**
 * The source's current path as a node spline (2-D, same shape within max(0.5 m, 0.5 % of the
 * length); node count adapts up to 64). Lines → 2 nodes, drawn paths → their points.
 * 현재 경로를 노드 스플라인으로 변환 (오차 ≤ max(0.5 m, 길이의 0.5%), 노드 수 적응).
 * @returns {{ dims, closed, end, nodes, error }}
 */
export function convertPathToSpline(src, listener) {
  const p = src.path || {};
  if (p.type === 'spline') return { ...normalizeSplinePath(p.spline), error: 0 };
  const geo = buildGeometry(p, listener);
  const R = (v) => roundTo(v, 2);
  const lifted = !!geo.is3; // a height envelope / moved z ends become a 3-D spline / 높이가 변하면 3D 스플라인
  const mk = (pts, closed) => ({ dims: lifted ? '3d' : '2d', closed, end: closed ? 'loop' : 'stop', nodes: nodesFromPoints(pts.map((q) => ({ x: R(q.x), y: R(q.y), z: lifted ? R(q.z || 0) : 0 }))) });
  if (geo.type === 'static') { const q = geo.P(0); return { ...mk([q, { x: q.x + 10, y: q.y }], false), error: 0 }; }
  if (geo.type === 'line' && !lifted) return { ...mk([geo.P(0), geo.P(1)], false), error: 0 };
  if (geo.type === 'draw' && !lifted) return { ...mk(p.points, false), error: 0 };
  const tol = Math.max(0.5, 0.005 * geo.len);
  let best = null;
  for (const n of [8, 12, 16, 24, 32, 48, 64]) {
    const pts = [];
    const count = geo.closed ? n : n + 1;
    for (let i = 0; i < count; i++) pts.push(geo.P(geo.locate(Math.min(geo.len * (1 - 1e-12), (i / n) * geo.len)).u));
    if (!geo.closed) pts[pts.length - 1] = geo.P(1);
    if (pts.length > 64) break;
    const out = mk(pts, geo.closed);
    const spl = buildSpline(out.nodes, { closed: geo.closed });
    let err = 0;
    let ang = 0; // direction error: the Doppler ratio depends on the direction of travel / 방향 오차 (도플러는 진행 방향에 의존)
    for (let k = 0; k <= 400; k++) {
      const f = Math.min(1 - 1e-9, k / 400);
      const ua = geo.locate(f * geo.len).u;
      const ub = spl.uAt(f * spl.len);
      const a = geo.P(ua);
      const q = spl.P(ub);
      err = Math.max(err, Math.hypot(a.x - q.x, a.y - q.y, lifted ? (a.z || 0) - q.z : 0));
      const da = geo.D(ua);
      const dq = spl.D(ub);
      const la = Math.hypot(da.x, da.y);
      const lq = Math.hypot(dq.x, dq.y);
      if (la > 1e-9 && lq > 1e-9) ang = Math.max(ang, Math.acos(clamp((da.x * dq.x + da.y * dq.y) / (la * lq), -1, 1)));
    }
    best = { ...out, error: err, angle: ang };
    if (err <= tol && ang <= 0.01) break;
  }
  return best;
}

/** Traversal summary of a source for the UI: path length, duration, mean / max speed. / 주행 요약 */
export function motionSummary(src, doc) {
  const kin = getKinematics(src, doc);
  let vMaxSeen = 0;
  for (let i = 0; i <= 200; i++) vMaxSeen = Math.max(vMaxSeen, kin.speedAt((i / 200) * kin.dur));
  const travelled = kin.distAt(kin.dur);
  return { len: kin.geo.len, dur: kin.dur, lapSec: kin.lapSec, mean: kin.dur > 0 ? Math.min(travelled, kin.geo.type === 'spline' && kin.geo.end === 'stop' ? kin.geo.len : travelled) / kin.dur : 0, max: vMaxSeen, maxVc: kin.maxVc, clamped: kin.clamped };
}

/** Arc length of a source's path (metres; 0 for static). / 경로 길이 */
export const pathLength = (src, listener) => buildGeometry(src.path, listener).len;

/**
 * Deterministic random scene from a seed (seeded PRNG). / 시드 기반 결정론적 랜덤 장면
 */
export function createRandomScene(seed = 1) {
  const rng = createSeededRandom(Math.max(1, Math.floor(seed)));
  const R = (a, b) => a + (b - a) * rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  const d = baseDoc();
  d.seed = seed;
  d.preset = '';
  d.cScale = roundTo(R(0.3, 0.8), 2);
  d.refDist = 5;
  d.length = 24;
  const PENTA = [0, 2, 4, 7, 9];
  const n = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const type = pick(['line', 'orbit', 'lissajous', 'spiral']);
    const midi = 55 + 12 * Math.floor(rng() * 2) + pick(PENTA);
    const ang = R(0, TAU);
    const off = R(3, 15);
    const path = {
      type,
      x0: roundTo(-120 * Math.cos(ang) - off * Math.sin(ang), 1), y0: roundTo(-120 * Math.sin(ang) + off * Math.cos(ang), 1),
      x1: roundTo(120 * Math.cos(ang) - off * Math.sin(ang), 1), y1: roundTo(120 * Math.sin(ang) + off * Math.cos(ang), 1),
      cx: roundTo(R(-20, 20), 1), cy: roundTo(R(-15, 25), 1), rx: roundTo(R(12, 40), 1), ry: roundTo(R(12, 40), 1), phase: Math.round(R(0, 360)), dir: rng() < 0.5 ? -1 : 1,
      ax: roundTo(R(20, 45), 1), ay: roundTo(R(15, 35), 1), a: 1 + Math.floor(rng() * 3), b: 1 + Math.floor(rng() * 4), delta: Math.round(R(0, 180)),
      r0: roundTo(R(50, 110), 1), r1: roundTo(R(2, 10), 1), turns: roundTo(R(1, 3), 1),
    };
    d.sources.push(createSource(i, {
      id: `r${seed}_${i + 1}`,
      name: `Random ${i + 1}`,
      path,
      speed: { value: roundTo(R(10, 32), 1) },
      start: roundTo(R(0, 4), 1),
      duration: roundTo(R(12, 20), 1),
      f: { hz: roundTo(midiToFreq(midi), 2) },
      baseGain: roundTo(0.6 / Math.sqrt(n), 2),
    }));
  }
  d.activeSourceId = d.sources[0].id;
  d.view = { cx: 0, cy: 4, span: 160 };
  return d;
}
