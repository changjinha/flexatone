/**
 * Flexatone — core/state.js
 * Layer 0 (core): single-source application state, voice factories, undo/redo,
 * pub/sub dispatch, project (de)serialisation and the console self-check.
 * 계층 0 (core): 단일 앱 상태, 보이스 팩토리, 실행 취소/다시 실행, Pub/Sub 디스패치,
 * 프로젝트 직렬화, 콘솔 자가진단.
 *
 * Rules / 규칙
 *  - No DOM access. Only `globalThis.runSelfCheck` is attached (console entry point).
 *    DOM 접근 금지. 콘솔 진입점 globalThis.runSelfCheck만 등록.
 *  - All mutations go through `dispatch({ mutate, history, scope })` so history and
 *    scoped re-renders stay in sync. Read freely from `appState`.
 *    모든 변경은 dispatch를 거쳐야 하며, 읽기는 appState에서 자유롭게.
 *  - Higher layers add checks with `registerSelfCheck()` (e.g. curve engines, registry).
 *    상위 계층은 registerSelfCheck()로 검사 항목을 추가.
 *
 * Imports only from core/ (i18n, math-utils, units). / core 내부 모듈만 import.
 */

import { I18N, LANG_TEXT_MAP, setLang, getLang, t, findMissingI18nKeys } from './i18n.js';
import { createDefaultTempoConfig, normalizeTempoConfig } from './tempo.js';
import {
  clamp,
  uid,
  deepClone,
  lerp,
  invLerp,
  roundTo,
  linspace,
  rmse,
  createLinearSplinePoints,
  normalizeSplinePoints,
  evaluateTimeWarp,
  createMonotoneInterpolator,
  evalPiecewiseBezierPoints,
  splitSplineSegmentPreservingShape,
  elevateSplineSegmentHandles,
  sampleFunctionToSplinePoints,
  fitStrokeToSpline,
  nelderMead,
  analyzeTrajectoryFeatures,
  analyzeAndFitCustomToEngine,
  rk4Step,
  integrateRK4,
  traceFieldRK4,
} from './math-utils.js';
import {
  midiToFreq,
  freqToMidi,
  midiToNoteName,
  noteNameToMidi,
  applyCents,
  ampToDb,
  dbToAmp,
  ampToSone,
  soneToAmp,
  convertGain,
  clampBaseGain,
  GAIN_UNITS,
  DB_FLOOR,
} from './units.js';
import { createDefaultTremolo, normalizeTremolo } from './tremolo-config.js';
import { createDefaultWarp, normalizeWarp } from './warp-config.js';
import { createDefaultTake, normalizeTake } from './take-config.js';
import { normalizeMods } from './mod-config.js';
import { normalizeScenes, SCENE_QUANT, SCENE_FOLLOW } from './scene-config.js';
import { serializeSamples, loadSamples, referencedSampleIds } from './sample-library.js';
import { normalizeClip, normalizeLink, splitLineAt, syncLinkedShapes, shapeSignature, linkedPeers } from './line-clip.js';
import { createDefaultAdsr, normalizeAdsr } from './adsr.js';

// ==========================================================================
// Constants / 상수
// ==========================================================================

export const VOICE_COLORS = Object.freeze([
  '#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171',
]);

/** Canonical engine ids (order = UI numbering 1–11). modules/curve-engine.js implements them. */
export const ENGINE_IDS = Object.freeze([
  'harmonic', 'damped', 'anticipation', 'ratchet', 'chirp', 'bounce',
  'bezier', 'plateau', 'polynomial', 'morph', 'custom',
  'expo', 'trig', 'formula', 'flow',
]);
/** Fluid-profile kinds of engine 15 (Flow). / 15번 유체 프로파일 엔진의 종류 */
export const FLOW_KINDS = Object.freeze(['poiseuille', 'blasius', 'rankine', 'stokes']);
/** Functions available to engine 13 (Trig). / 13번 삼각함수 엔진의 함수 */
export const TRIG_FNS = Object.freeze(['sin', 'cos', 'tan', 'asin', 'acos', 'atan']);
/** Region edge ramp policy. / 구간 경계 램프 정책 */
export const REGION_RAMP_MODES = Object.freeze(['auto', 'on', 'off']);
export const REGION_TIME_MODES = Object.freeze(['global', 'local']);
export const MAX_REGIONS_PER_VOICE = 16;
export const MORPH_MODES = Object.freeze(['blend', 'add', 'mul', 'diff']);
export const STUDIO_IDS = Object.freeze(['glissando', 'risset', 'field']);
/** Slug accepted for plugin studios beyond the built-in slots. / 플러그인 스튜디오 id 형식 */
export const STUDIO_SLUG = /^[a-z][a-z0-9-]{1,31}$/;

/** Structurally valid studio id (whether a plugin exists is studios/registry.js's call). */
export function isValidStudioId(id) {
  return typeof id === 'string' && (STUDIO_IDS.includes(id) || STUDIO_SLUG.test(id));
}
export const TIMBRE_WAVES = Object.freeze(['sine', 'tri', 'saw', 'sqr', 'rich']);

export const MIN_DURATION = 0.05;
export const MAX_TIME = 300;
export const HISTORY_LIMIT = 100;
export const UI_ZOOM_MIN = 40;
export const UI_ZOOM_MAX = 200;

export const PROJECT_FORMAT = 'flexatone-project';
export const PROJECT_VERSION = 1;

/** Re-render scopes understood by subscribers. / 구독자가 이해하는 재렌더 범위 */
export const SCOPES = Object.freeze([
  'all', 'voices', 'selection', 'canvas', 'gain', 'panels', 'matrix',
  'timbre', 'transport', 'view', 'history', 'lang', 'layout', 'versions', 'studio',
]);

// ==========================================================================
// Factories / 팩토리
// ==========================================================================

/** Flat parameter set shared by every curve engine (pitch, gain-engine, morph node). */
export function createDefaultCurveParams() {
  return {
    alpha: 57.5, x1: 0.25, x2: 0.75, symLock: true,
    dampC1: true, dampT0: 0.35, dampA: 0.35, dampN: 4.0, dampK: 2.5,
    antD: 0.25, antTw: 0.24, antP: 2.2, antR: 0.1,
    ratN: 8, ratSig: 0.25,
    chirpA: 0.08, chirpF0: 2.0, chirpF1: 12.0,
    bounceN: 5, bounceK: 1.8, bounceP: 1.6,
    bezX1: 0.15, bezY1: 0.85, bezX2: 0.85, bezY2: 0.15,
    platTm: 0.5, platYm: 0.5, platW: 0.25,
    polyPoints: [{ x: 0, y: 0 }, { x: 0.5, y: 0.75 }, { x: 1, y: 1 }],
    // 12. Exp / Log
    expMode: 'exp', expK: 4,
    // 13. Trig (sin · cos · tan · asin · acos · atan) over the input range x₀ → x₁
    trigFn: 'sin', trigX0: 0, trigX1: 0.5, trigNorm: true, trigAmp: 1, trigBias: 0,
    // 14. User formula f(t; a, b, c …)
    formulaExpr: 'a*t^b + (1 - a)*sin(pi*t/2)',
    formulaVars: [{ name: 'a', value: 0.5, min: -2, max: 2 }, { name: 'b', value: 2, min: 0.1, max: 8 }],
    formulaNorm: true,
    // 15. Fluid profile (Poiseuille · Blasius · Rankine · Stokes' 2nd problem)
    flowKind: 'poiseuille', flowP: 2, flowCouette: 0, flowSlip: 0,
    flowEta: 5, flowBlaWarp: 1, flowBlaInt: false,
    flowCore: 0.5, flowDecay: 1, flowSmooth: 0,
    flowStokesEta: 5, flowPhase: 0, flowWaveK: 1, flowDamp: 1,
  };
}

/**
 * A local time region of a voice (Select tool). t0/t1 are the voice's normalized time.
 * Inside the region its own curve config replaces the voice curve with amount `mix`
 * (partial morph), optionally remapped to the region ('local'); solo/mute/gainDb act on
 * amplitude. Edges are ramped (smootherstep) when ramp = 'on', or when 'auto' finds a
 * jump or kink there. / 보이스의 로컬 시간 구간 (선택 도구).
 */
export function createDefaultRegion(t0 = 0.25, t1 = 0.75, curveSrc = null) {
  const curve = createDefaultCurveConfig(curveSrc?.engine || 'harmonic');
  if (curveSrc) {
    for (const k of Object.keys(curve)) if (curveSrc[k] !== undefined) curve[k] = deepClone(curveSrc[k]);
  }
  const lo = clamp(Math.min(t0, t1), 0, 1);
  const hi = clamp(Math.max(t0, t1), 0, 1);
  return {
    id: uid('rg_', 6),
    t0: roundTo(lo, 5),
    t1: roundTo(Math.max(hi, lo + 0.005), 5),
    mute: false,
    solo: false,
    gainDb: 0,
    mix: 1,
    timeMode: 'global',
    ramp: 'auto',
    rampSec: 0.06,
    tremolo: createDefaultTremolo(), // region tremolo (on → replaces the voice tremolo inside the region) / 구간 트레몰로
    curve,
  };
}

/** Clean a region read from a project file / history. / 구간 정규화 */
export function normalizeRegion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const d = createDefaultRegion(Number(raw.t0) || 0, Number(raw.t1) || 1);
  const r = { ...d, ...raw };
  r.id = typeof raw.id === 'string' && raw.id ? raw.id : d.id;
  r.t0 = clamp(Number(r.t0) || 0, 0, 1);
  r.t1 = clamp(Number(r.t1) || 0, 0, 1);
  if (r.t1 < r.t0) [r.t0, r.t1] = [r.t1, r.t0];
  if (r.t1 - r.t0 < 0.002) return null;
  r.mute = !!r.mute;
  r.solo = !!r.solo;
  r.gainDb = clamp(Number(r.gainDb) || 0, -60, 12);
  r.mix = clamp(Number.isFinite(Number(r.mix)) ? Number(r.mix) : 1, 0, 1);
  if (!REGION_TIME_MODES.includes(r.timeMode)) r.timeMode = 'global';
  if (!REGION_RAMP_MODES.includes(r.ramp)) r.ramp = 'auto';
  r.rampSec = clamp(Number.isFinite(Number(r.rampSec)) ? Number(r.rampSec) : 0.06, 0.003, 2);
  r.tremolo = normalizeTremolo(raw.tremolo);
  r.curve = normalizeCurveConfig({ ...createDefaultCurveConfig(), ...(raw.curve || {}) }, createDefaultCurveConfig());
  return r;
}

/**
 * One node of the Multi-Function Morph engine. / 모핑 엔진의 함수 노드
 *  - op: 'blend' | 'add' | 'mul' | 'diff' | null (null = inherit the curve's morphMode)
 *  - solo: when any node is soloed, only soloed nodes are evaluated
 *  - bypass: node is skipped (unless soloed)
 *  op: 노드별 합성 연산 (null이면 곡선의 morphMode 상속), solo: 솔로, bypass: 우회
 */
export function createDefaultMorphNode(engine = 'harmonic', weight = 0.5) {
  return {
    id: uid('mn_', 6),
    engine: ENGINE_IDS.includes(engine) && engine !== 'morph' ? engine : 'harmonic',
    weight: clamp(Number(weight) || 0, -4, 4),
    op: null,
    solo: false,
    bypass: false,
    ...createDefaultCurveParams(),
    customPoints: createLinearSplinePoints(0, 1),
  };
}

/**
 * Domain-agnostic curve config consumed by `evaluateCurve(curveConfig, tNorm)`.
 * 도메인 무관 곡선 설정 (음고 / 게인 엔진 / 모핑 공용).
 */
export function createDefaultCurveConfig(engine = 'harmonic') {
  return {
    engine,
    lastNonCustomEngine: engine === 'custom' ? 'harmonic' : engine,
    reverse: false,
    inverse: false,
    ...createDefaultCurveParams(),
    morphMode: 'blend',
    morphNodes: [createDefaultMorphNode('harmonic', 0.5), createDefaultMorphNode('damped', 0.5)],
    customPoints: createLinearSplinePoints(0, 1),
  };
}

/** Gain-envelope engine object (curve config + amplitude range). */
export function createDefaultGainEngineObj() {
  return { ...createDefaultCurveConfig('harmonic'), ampMin: 0, ampMax: 1, autoFit: true };
}

function nextVoiceColor(voices) {
  const used = new Set(voices.map((v) => v.color));
  return VOICE_COLORS.find((c) => !used.has(c)) || VOICE_COLORS[voices.length % VOICE_COLORS.length];
}

function nextVoiceName(voices) {
  let max = 0;
  for (const v of voices) {
    const m = /(\d+)\s*$/.exec(v.name || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `Voice ${Math.max(max, voices.length) + 1}`;
}

/**
 * Create a Voice conforming to the architecture contract (§4.1).
 * 아키텍처 계약(§4.1)에 맞는 보이스 생성.
 * @param {number} [index=0] used for default name / color
 * @param {object} [overrides]
 */
export function createDefaultVoice(index = 0, overrides = {}) {
  const voice = {
    id: uid('v_', 7),
    name: `Voice ${index + 1}`,
    color: VOICE_COLORS[index % VOICE_COLORS.length],
    solo: false,
    muted: false,
    startTime: 0,
    duration: 2.5,
    baseGain: 0.85,
    gainUnit: 'amp',
    dbTaper: 'linear', // gainUnit 'db': 'linear' (taper A) | 'daw' (taper B) / dB 테이퍼
    dbMin: -60, // gainUnit 'db': dB at the bottom of the envelope (ε = 10^(dbMin/20)) / 최저 dB
    f0Midi: 48, f0Hz: roundTo(midiToFreq(48), 2), f0Fine: 0,
    f1Midi: 72, f1Hz: roundTo(midiToFreq(72), 2), f1Fine: 0,
    logScale: true,
    audioTarget: 'pos',
    timbreMode: 'mix',
    timbre: { sine: 0.75, tri: 0.25, saw: 0.12, sqr: 0.05, rich: 0.2 },
    timbreFunc: { source: 'formula', expr: 'sin(2*pi*x) + 0.35*sin(6*pi*x)', voiceId: '' },
    ...createDefaultCurveConfig('harmonic'),
    gainMode: 'points',
    gainPoints: [
      { x: 0, y: 0.9, handles: [] },
      { x: 1, y: 0.9, handles: [] },
    ],
    gainEngineObj: createDefaultGainEngineObj(),
    tremolo: createDefaultTremolo(), // periodic amplitude modulation (off by default) / 트레몰로
    adsr: createDefaultAdsr(), // timbre toolbox ADSR (off by default, core/adsr.js) / 음색 ADSR
    regions: [],
    // optional: clip = play range on the curve, link = pieces cut from one line (core/line-clip.js)
    // 선택: clip = 곡선 위 재생 구간, link = 한 선에서 잘린 조각 (core/line-clip.js)
  };
  return Object.assign(voice, overrides);
}

// ==========================================================================
// Voice field helpers (pure) / 보이스 필드 헬퍼
// ==========================================================================

function syncPitchSide(v, side) {
  const hzKey = `${side}Hz`;
  const midiKey = `${side}Midi`;
  const fineKey = `${side}Fine`;
  if (Number.isFinite(v[hzKey]) && v[hzKey] > 0) {
    v[midiKey] = Math.round(freqToMidi(v[hzKey]));
  } else {
    v[midiKey] = clamp(Math.round(Number(v[midiKey]) || 60), 0, 127);
    v[hzKey] = roundTo(midiToFreq(v[midiKey]), 2);
  }
  v[fineKey] = clamp(Math.round(Number(v[fineKey]) || 0), -100, 100);
}

/**
 * Set F0 or F1 from one of: midi (fractional ok) | hz | note | fine. Keeps the
 * Midi/Hz/Fine triple consistent. Returns false for an invalid note name.
 * F0/F1을 midi·hz·note·fine 중 하나로 설정하고 3필드 일관성 유지.
 * @param {object} voice
 * @param {'f0'|'f1'} side
 * @param {{ midi?: number, hz?: number, note?: string, fine?: number }} input
 */
export function setVoicePitch(voice, side, input) {
  if (side !== 'f0' && side !== 'f1') throw new RangeError(`setVoicePitch: side "${side}"`);
  if (input.note !== undefined) {
    const m = noteNameToMidi(input.note);
    if (m === null) return false;
    input = { midi: m };
  }
  if (Number.isFinite(input.midi)) {
    const midi = clamp(input.midi, 0, 127);
    voice[`${side}Hz`] = roundTo(midiToFreq(midi), 4);
    voice[`${side}Midi`] = Math.round(midi);
  } else if (Number.isFinite(input.hz) && input.hz > 0) {
    voice[`${side}Hz`] = clamp(input.hz, 1, 24000);
    voice[`${side}Midi`] = Math.round(freqToMidi(voice[`${side}Hz`]));
  }
  if (Number.isFinite(input.fine)) voice[`${side}Fine`] = clamp(Math.round(input.fine), -100, 100);
  return true;
}

/** Effective frequency of F0/F1 including fine tuning. / 미세조율 포함 실효 주파수 */
export function getVoiceHz(voice, side) {
  return applyCents(voice[`${side}Hz`], voice[`${side}Fine`] || 0);
}

/** Effective fractional MIDI of F0/F1. */
export function getVoiceMidi(voice, side) {
  return freqToMidi(getVoiceHz(voice, side));
}

export function getVoiceEnd(voice) {
  return voice.startTime + voice.duration;
}

/** Set end time (durEditMode = 'end'); start stays fixed. / 끝 시각 설정 (시작은 고정) */
export function setVoiceEnd(voice, endSec) {
  voice.duration = clamp(endSec - voice.startTime, MIN_DURATION, MAX_TIME);
  return voice;
}

export function setVoiceTiming(voice, { start, duration, end } = {}) {
  if (Number.isFinite(start)) voice.startTime = clamp(start, 0, MAX_TIME);
  if (Number.isFinite(duration)) voice.duration = clamp(duration, MIN_DURATION, MAX_TIME);
  if (Number.isFinite(end)) setVoiceEnd(voice, end);
  return voice;
}

function ensurePoints(pts, fallback) {
  if (!Array.isArray(pts) || pts.length < 2) return deepClone(fallback);
  const clean = pts
    .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: clamp(p.x, 0, 1), y: p.y, handles: Array.isArray(p.handles) ? p.handles : undefined, curve: p.curve }));
  if (clean.length < 2) return deepClone(fallback);
  return normalizeSplinePoints(clean);
}

function normalizeCurveConfig(target, defaults) {
  for (const [k, dv] of Object.entries(defaults)) {
    if (target[k] === undefined || typeof target[k] !== typeof dv) target[k] = deepClone(dv);
  }
  if (!ENGINE_IDS.includes(target.engine)) target.engine = 'harmonic';
  if (!ENGINE_IDS.includes(target.lastNonCustomEngine) || target.lastNonCustomEngine === 'custom') {
    target.lastNonCustomEngine = target.engine === 'custom' ? 'harmonic' : target.engine;
  }
  if (!MORPH_MODES.includes(target.morphMode)) target.morphMode = 'blend';
  if (!['exp', 'log'].includes(target.expMode)) target.expMode = 'exp';
  if (!TRIG_FNS.includes(target.trigFn)) target.trigFn = 'sin';
  if (!FLOW_KINDS.includes(target.flowKind)) target.flowKind = 'poiseuille';
  target.formulaVars = (Array.isArray(target.formulaVars) ? target.formulaVars : [])
    .filter((fv) => fv && /^[a-z]$/.test(fv.name) && !['t', 'x', 'e'].includes(fv.name))
    .slice(0, 12)
    .map((fv) => {
      const min = Number.isFinite(Number(fv.min)) ? Number(fv.min) : -2;
      const max = Number.isFinite(Number(fv.max)) && Number(fv.max) > min ? Number(fv.max) : min + 4;
      return { name: fv.name, value: Number.isFinite(Number(fv.value)) ? Number(fv.value) : 0, min, max };
    });
  target.customPoints = ensurePoints(target.customPoints, createLinearSplinePoints(0, 1));
  target.morphNodes = (Array.isArray(target.morphNodes) && target.morphNodes.length ? target.morphNodes : defaults.morphNodes).map(
    (n) => ({ ...createDefaultMorphNode(n.engine, n.weight), ...n, id: n.id || uid('mn_', 6) }),
  );
  return target;
}

/**
 * Fill defaults, clamp ranges and migrate legacy fields (Glissando Master HTML format:
 * volume→baseGain, mapMode→logScale, 'position'→'pos', timbre.square→sqr, ampCurve→gainEngineObj).
 * 기본값 채우기·범위 제한·구버전 필드 마이그레이션.
 */
export function normalizeVoice(raw = {}, index = 0) {
  const d = createDefaultVoice(index);
  const src = deepClone(raw || {});
  const v = { ...d, ...src };

  if (src.baseGain === undefined && Number.isFinite(src.volume)) v.baseGain = src.volume;
  delete v.volume;
  if (src.logScale === undefined && typeof src.mapMode === 'string') v.logScale = !/^lin/.test(src.mapMode);
  delete v.mapMode;
  if (v.audioTarget === 'position') v.audioTarget = 'pos';
  if (v.audioTarget === 'velocity') v.audioTarget = 'vel';
  if (v.audioTarget !== 'pos' && v.audioTarget !== 'vel') v.audioTarget = 'pos';

  const tb = { ...d.timbre, ...(src.timbre || {}) };
  if (src.timbre && src.timbre.sqr === undefined && Number.isFinite(src.timbre.square)) tb.sqr = src.timbre.square;
  v.timbre = {};
  for (const w of TIMBRE_WAVES) v.timbre[w] = clamp(Number(tb[w]) || 0, 0, 1);
  v.timbreFunc = { ...d.timbreFunc, ...(src.timbreFunc || {}) };
  // 'sample' = per-voice Sampler; its spec is normalised where it is used (modules/sample-source.js)
  // 'sample' = 보이스별 샘플러. 스펙은 사용하는 곳에서 정규화
  if (v.timbreMode !== 'mix' && v.timbreMode !== 'func' && v.timbreMode !== 'sample') v.timbreMode = 'mix';
  if (src.timbreSample && typeof src.timbreSample === 'object' && !Array.isArray(src.timbreSample)) v.timbreSample = src.timbreSample;
  else delete v.timbreSample;
  if (v.timbreMode === 'sample' && !v.timbreSample) v.timbreMode = 'mix';

  normalizeCurveConfig(v, createDefaultCurveConfig());
  const gSrc = src.gainEngineObj || src.ampCurve || {};
  v.gainEngineObj = normalizeCurveConfig({ ...createDefaultGainEngineObj(), ...gSrc }, createDefaultGainEngineObj());
  delete v.ampCurve;
  v.tremolo = normalizeTremolo(src.tremolo);
  v.adsr = normalizeAdsr(src.adsr);
  const clip = normalizeClip(src.clip);
  if (clip) v.clip = clip; else delete v.clip;
  const link = normalizeLink(src.link);
  if (link) v.link = link; else delete v.link;
  v.gainPoints = ensurePoints(v.gainPoints, d.gainPoints);
  v.regions = (Array.isArray(src.regions) ? src.regions : []).map(normalizeRegion).filter(Boolean).slice(0, MAX_REGIONS_PER_VOICE);
  if (v.gainMode !== 'points' && v.gainMode !== 'engine') v.gainMode = 'points';
  if (!GAIN_UNITS.includes(v.gainUnit)) v.gainUnit = 'amp';
  if (v.dbTaper !== 'daw') v.dbTaper = 'linear';
  v.dbMin = Number.isFinite(Number(v.dbMin)) ? Math.min(-12, Math.max(-120, Math.round(Number(v.dbMin)))) : -60;

  if (typeof v.id !== 'string' || !v.id) v.id = uid('v_', 7);
  if (typeof v.name !== 'string' || !v.name) v.name = d.name;
  if (typeof v.color !== 'string') v.color = d.color;
  v.solo = !!v.solo;
  v.muted = !!v.muted;
  v.reverse = !!v.reverse;
  v.inverse = !!v.inverse;
  v.logScale = v.logScale !== false;
  v.startTime = clamp(Number(v.startTime) || 0, 0, MAX_TIME);
  v.duration = clamp(Number(v.duration) || d.duration, MIN_DURATION, MAX_TIME);
  v.baseGain = clampBaseGain(Number(v.baseGain));
  syncPitchSide(v, 'f0');
  syncPitchSide(v, 'f1');
  return v;
}

// ==========================================================================
// Application state / 앱 상태
// ==========================================================================

/** Empty manager block; instances are created by core/manager-state.js ensureManager(). */
export function createDefaultManagerState() {
  // extensions: log of the Extend tool (core/manager-extend.js), newest last / 연장 도구 기록 (최신이 마지막)
  return { instances: [], focus: {}, cycleLoop: true, cycleMode: 'auto', cycleLen: null, open: false, regions: [], tempo: createDefaultTempoConfig(), extensions: [], mods: [], scenes: [], sceneQuant: 'now', sceneFollow: 'off', sceneWrite: null }; // mods: Modulation matrix (core/mod-config.js); scenes: core/manager-scenes.js / 모듈레이션·씬
}

/** Manager mixer fields kept across undo/redo (not part of the document). / 실행 취소 대상이 아닌 믹서 필드 */
export const MANAGER_MIXER_KEYS = Object.freeze(['gainDb', 'mute', 'solo', 'start', 'length', 'loop', 'fadeIn', 'fadeOut', 'inCycle', 'tempo', 'tremolo']);

function managerSnapshot() {
  const m = appState.manager || createDefaultManagerState();
  return {
    // warp is part of the undoable snapshot (it changes what the other tracks sound like) / 곡률은 실행 취소 대상
    // `mix` = the mixer fields at snapshot time; used only when undo / redo re-creates a track that no longer exists
    // mix = 스냅샷 시점의 믹서 필드 (실행 취소·다시 실행으로 없어진 트랙을 되살릴 때만 사용)
    instances: m.instances.map((i) => {
      const mix = {};
      for (const k of MANAGER_MIXER_KEYS) if (i[k] !== undefined) mix[k] = i[k];
      return { id: i.id, studio: i.studio, name: i.name, color: i.color, doc: i.doc, warp: i.warp, take: i.take, ext: i.ext, mix };
    }),
    focus: m.focus,
    mods: m.mods || [], // Modulation matrix routes (undoable) / 모듈레이션 라우트
    scenes: m.scenes || [], // Scenes (undoable) / 씬
    sceneOpts: { quant: m.sceneQuant, follow: m.sceneFollow },
    // Extend tool: its log, the regions it made and the cycle length it set (restored only when undo / redo
    // crosses an Extend / Remove step) / 연장 도구: 기록·생성한 구간·사이클 길이 (연장 단계를 넘나들 때만 복원)
    ext: { list: m.extensions || [], regions: (m.regions || []).filter((r) => r.ext), cycleMode: m.cycleMode, cycleLen: m.cycleLen },
  };
}

function restoreManager(snap) {
  if (!snap || !Array.isArray(snap.instances) || !snap.instances.length) return;
  const m = appState.manager || (appState.manager = createDefaultManagerState());
  const prev = new Map(m.instances.map((i) => [i.id, i]));
  m.instances = snap.instances.map((i) => {
    const old = prev.get(i.id);
    const mixer = {};
    const { mix, ...rest } = i;
    for (const k of MANAGER_MIXER_KEYS) {
      if (old && old[k] !== undefined) mixer[k] = old[k];
      else if (!old && mix && mix[k] !== undefined) mixer[k] = mix[k];
    }
    const inst = { ...createInstanceDefaults(i.studio), ...rest, ...mixer };
    inst.take = normalizeTake(inst.take);
    if (typeof inst.ext !== 'string') delete inst.ext;
    return inst;
  });
  m.focus = { ...(snap.focus || {}) };
  m.mods = Array.isArray(snap.mods) ? snap.mods : [];
  m.scenes = Array.isArray(snap.scenes) ? snap.scenes : [];
  if (snap.sceneOpts) { m.sceneQuant = snap.sceneOpts.quant || 'now'; m.sceneFollow = snap.sceneOpts.follow || 'off'; }
  const ids = (list) => (Array.isArray(list) ? list : []).map((x) => x.id).join();
  if (snap.ext && ids(snap.ext.list) !== ids(m.extensions)) {
    // lengths an extension wrote down on looping clips follow it: back to "auto" when it goes, set again when it returns
    // 연장이 반복 클립에 명시한 길이도 함께: 연장이 사라지면 자동으로, 돌아오면 다시 명시
    const setLen = (x, on) => { for (const f of x.froze || []) { const inst = m.instances.find((i) => i.id === f.id); if (inst) inst.length = on ? f.length : null; } };
    const now = new Set((snap.ext.list || []).map((x) => x.id));
    const was = new Set((m.extensions || []).map((x) => x.id));
    for (const x of [...(m.extensions || [])].reverse()) if (!now.has(x.id)) setLen(x, false);
    for (const x of snap.ext.list || []) if (!was.has(x.id)) setLen(x, true);
    m.extensions = snap.ext.list || [];
    m.regions = [...(m.regions || []).filter((r) => !r.ext), ...(snap.ext.regions || [])];
    m.cycleMode = snap.ext.cycleMode === 'fixed' ? 'fixed' : 'auto';
    m.cycleLen = snap.ext.cycleLen ?? null;
  }
}

/** Default mixer/arrangement fields of a new instance. / 새 인스턴스의 기본 믹서 필드 */
export function createInstanceDefaults(studio) {
  return {
    gainDb: 0,
    mute: false,
    solo: false,
    start: 0,
    length: studio === 'risset' ? 8 : null, // null = natural length / 자연 길이
    loop: studio === 'risset',
    fadeIn: studio === 'risset' ? 0.4 : 0.01,
    fadeOut: studio === 'risset' ? 0.6 : 0.03,
    inCycle: true,
    tempo: createDefaultTempoConfig(), // Tempo Manager (per instance) / 인스턴스 템포
    tremolo: createDefaultTremolo(), // track tremolo (Glissando / Field instances) / 트랙 트레몰로
    warp: createDefaultWarp(studio), // pitch-space curvature source (core/warp-config.js) / 곡률 출처
    take: createDefaultTake(), // plays a take of a clip, e.g. its retrograde (core/take-config.js) / 테이크 (역행 등)
  };
}

export function createInitialState() {
  const first = createDefaultVoice(0);
  return {
    // Preferences / 환경설정
    lang: 'en',
    studio: 'glissando',
    layout: 'landscape', // 'landscape' | 'portrait'
    uiZoom: 100,

    // Canvas view / 캔버스 보기
    viewMode: 'piano', // 'piano' | 'norm'
    gridSub: 16,
    screenshotMode: 'full', // 'full' = screen as shown · 'clean' = axes and lines only / 스크린샷 모드
    screenshotSvg: false, // clean mode only: save a vector SVG instead of a PNG / 축+선 모드는 SVG로 저장
    showDeriv: false,
    locateMode: false,
    selectMode: false, // Select tool: drag on the canvas to create local regions / 선택 도구
    locateSnap: true,
    scrubAudio: false,
    customFreehand: false,
    viewport: { midiMin: 42, midiMax: 78, timeMin: 0, timeMax: 3.5, normYMin: -0.1, normYMax: 1.1 },

    // Editing modes / 편집 모드
    engineTarget: 'curve', // 'curve' | 'amp'  (which curve config the engine rack edits)
    durEditMode: 'duration', // 'duration' | 'end'
    groupApplyMode: false, // apply edits to all selected voices
    // How a group edit reaches the other selected voices: 'sync' (same value), 'ratio' (same factor),
    // 'offset' (same amount added). / 그룹 편집 방식: 동기화 · 비율 · 덧셈
    groupEditMode: 'sync',
    multiSelectMode: false, // a plain click on a voice card adds / removes it from the selection / 다중 선택
    legatoJoin: true, // back-to-back voices share one phase-continuous oscillator / 레가토 연결
    sampleJoin: 'pitch', // back-to-back Sampler voices: 'pitch' (continue when pitches meet, default) | 'always' | 'restart' (new read, crossfaded) / 샘플러 잇기
    joinGlideMs: 12, // pitch-slope smoothing window around a junction (0 = off) / 경계 글라이드
    clipGhost: true, // unplayed parts of a trimmed line: faint in the monitor (false = hidden) / 재생하지 않는 부분: 연하게 (false = 숨김)
    output: createDefaultOutputConfig(), // end-of-chain output stage (fader, meters, loudness) / 출력 단계
    matrixOpen: false,

    // Per-studio parameter blocks, keyed by studio id (owned by studios/registry.js)
    // 스튜디오별 파라미터 (studios/registry.js가 관리)
    studioParams: {},

    // Manager: studio instances (tracks) and the cycle arrangement (core/manager-state.js)
    // 매니저: 스튜디오 인스턴스(트랙)와 사이클 배치 (core/manager-state.js가 관리)
    manager: createDefaultManagerState(),

    // Transport (runtime, never serialised to history) / 트랜스포트 (런타임)
    transport: { playing: false, loop: false, cueSec: 0, playheadSec: -1 },

    // Document / 문서
    voices: [first],
    activeVoiceId: first.id,
    selectedVoiceIds: [first.id],
    versions: [], // state backups made with every Screenshot / 스크린샷마다 만드는 상태 백업

    // Undo/Redo — stack of JSON document snapshots / 실행 취소 스택
    history: { stack: [], index: -1, limit: HISTORY_LIMIT, lastCoalesceKey: null },
  };
}

// ==========================================================================
// Output stage config / 출력 단계 설정
// ==========================================================================

export const OUTPUT_MODES = Object.freeze(['amp', 'db', 'sone']);

/**
 * End-of-chain output stage. / 신호 흐름 마지막 출력 단계
 *   mode 'amp' : the fader is the linear amplitude itself (0 … 1), as before the output stage.
 *   mode 'db'  : the fader sets the gain through a dB taper (A 'linear' | B 'daw').
 *   mode 'sone': Loudness Lock — the gain follows the measured Total Sone toward soneTarget.
 */
export function createDefaultOutputConfig() {
  return {
    mode: 'db',
    faderNorm: 1, // fader position x ∈ [0, 1] (1 = dbMax) / 페이더 위치
    ampLevel: 1, // 'amp' mode: linear output amplitude 0 … 1 / 진폭 모드 출력 진폭
    taper: 'daw', // 'linear' (A) | 'daw' (B)
    dbMin: -60,
    dbMax: 0,
    smoothMs: 8, // one-pole smoothing τ (5–10 ms) / 지퍼 노이즈 방지 평활
    analyzer: true, // Sone / masking AudioWorklet on / 라우드니스 분석기
    fullScaleDbSpl: 90, // calibration: a 0 dBFS sine ↔ this dB SPL / 캘리브레이션
    soneTarget: 8, // Loudness Lock target (sone) / 목표 라우드니스
    lockMaxBoostDb: 12, // Loudness Lock ceiling above 0 dB / 최대 부스트
    limiter: false, // end-of-chain limiter button / 끝단 리미터
    limiterCeilDb: -1, // limiter ceiling (dBFS) / 리미터 천장
  };
}

/** Validate an output config (unknown / missing fields → defaults). / 출력 설정 검증 */
export function normalizeOutputConfig(src) {
  const d = createDefaultOutputConfig();
  const o = src && typeof src === 'object' ? src : {};
  const n = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);
  const out = {
    mode: OUTPUT_MODES.includes(o.mode) ? o.mode : d.mode,
    faderNorm: n(o.faderNorm, 0, 1, d.faderNorm),
    ampLevel: n(o.ampLevel, 0, 1, d.ampLevel),
    taper: o.taper === 'linear' ? 'linear' : 'daw',
    dbMin: Math.round(n(o.dbMin, -120, -12, d.dbMin)),
    dbMax: n(o.dbMax, 0, 12, d.dbMax),
    smoothMs: n(o.smoothMs, 5, 10, d.smoothMs),
    analyzer: o.analyzer !== false,
    fullScaleDbSpl: n(o.fullScaleDbSpl, 60, 130, d.fullScaleDbSpl),
    soneTarget: n(o.soneTarget, 0.1, 200, d.soneTarget),
    lockMaxBoostDb: n(o.lockMaxBoostDb, 0, 24, d.lockMaxBoostDb),
    limiter: o.limiter === true,
    limiterCeilDb: n(o.limiterCeilDb, -12, 0, d.limiterCeilDb),
  };
  return out;
}

export const appState = createInitialState();

// ==========================================================================
// Selectors / 셀렉터
// ==========================================================================

export function getVoiceById(id) {
  return appState.voices.find((v) => v.id === id) || null;
}

export function getActiveVoice() {
  return getVoiceById(appState.activeVoiceId) || appState.voices[0] || null;
}

export function getSelectedVoices() {
  const set = new Set(appState.selectedVoiceIds);
  return appState.voices.filter((v) => set.has(v.id));
}

/**
 * Voices an edit should apply to: all selected voices when groupApplyMode is on,
 * otherwise just the active voice. / 편집 대상 보이스 (그룹 적용 모드 반영)
 */
export function getTargetVoices() {
  const active = getActiveVoice();
  if (appState.groupApplyMode) {
    const sel = getSelectedVoices();
    if (sel.length) return active && !sel.includes(active) ? [active, ...sel] : sel;
  }
  return active ? [active] : [];
}

/** Audible voices honouring solo/mute. / 솔로·뮤트 반영한 발음 보이스 */
export function getAudibleVoices() {
  const anySolo = appState.voices.some((v) => v.solo);
  return appState.voices.filter((v) => (anySolo ? v.solo : !v.muted) && v.duration > 0);
}

// ==========================================================================
// Pub/Sub / 발행·구독
// ==========================================================================

const listeners = new Set();
const pendingEvents = [];
let notifying = false;
let notifyMuted = false;

/**
 * Subscribe to state events. / 상태 이벤트 구독
 * @param {(event: {type:string, scope:Set<string>, payload:any, result:any, historyChanged:boolean}, state: object) => void} fn
 * @param {{ scopes?: string[] }} [opts] only receive events touching these scopes ('all' always matches)
 * @returns {() => void} unsubscribe
 */
export function subscribe(fn, opts = {}) {
  const entry = { fn, scopes: opts.scopes ? new Set(opts.scopes) : null };
  listeners.add(entry);
  return () => listeners.delete(entry);
}

function deliver(event) {
  for (const entry of [...listeners]) {
    if (entry.scopes && !event.scope.has('all')) {
      let hit = false;
      for (const s of event.scope) if (entry.scopes.has(s)) { hit = true; break; }
      if (!hit) continue;
    }
    try {
      entry.fn(event, appState);
    } catch (err) {
      console.error('[Flexatone] subscriber error:', err);
    }
  }
}

function notify(event) {
  if (notifyMuted) return;
  if (notifying) {
    pendingEvents.push(event); // nested dispatch → deliver after current round
    return;
  }
  notifying = true;
  try {
    deliver(event);
    while (pendingEvents.length) deliver(pendingEvents.shift());
  } finally {
    notifying = false;
  }
}

/**
 * The single mutation entry point. / 단일 변경 진입점
 * @param {{
 *   type?: string,                                   // label for subscribers / debugging
 *   mutate?: (state: object, payload: any) => any,   // performs the mutation
 *   payload?: any,
 *   history?: boolean,                               // push an undo snapshot afterwards
 *   coalesceKey?: string|null,                       // merge consecutive pushes (drags)
 *   scope?: string|string[],                         // re-render scopes (default 'all')
 *   silent?: boolean                                 // mutate without notifying
 * }} opts
 * @returns {{type:string, scope:Set<string>, payload:any, result:any, historyChanged:boolean}}
 */
export function dispatch(opts = {}) {
  const { type = 'update', mutate, payload, history = false, coalesceKey = null, scope = 'all', silent = false } = opts;
  const result = typeof mutate === 'function' ? mutate(appState, payload) : undefined;
  const historyChanged = history ? pushHistory({ coalesceKey }) : false;
  const scopeSet = new Set(Array.isArray(scope) ? scope : [scope]);
  if (historyChanged) scopeSet.add('history');
  const event = { type, scope: scopeSet, payload, result, historyChanged };
  if (!silent) notify(event);
  return event;
}

// ==========================================================================
// Undo / Redo / 실행 취소 · 다시 실행
// ==========================================================================

let historyMuted = 0;
/**
 * Run `fn` without recording undo steps (timeline automation writing values during playback).
 * 실행 취소 기록 없이 fn 실행 (재생 중 오토메이션이 값을 쓸 때)
 */
export function withoutHistory(fn) {
  historyMuted++;
  try { return fn(); } finally { historyMuted--; }
}

function documentSnapshot() {
  return JSON.stringify({
    voices: appState.voices,
    activeVoiceId: appState.activeVoiceId,
    selectedVoiceIds: appState.selectedVoiceIds,
    studioParams: appState.studioParams,
    manager: managerSnapshot(),
  });
}

/**
 * Push the current document onto the history stack. Identical states are skipped;
 * consecutive pushes with the same coalesceKey replace the top entry.
 * 현재 문서를 히스토리에 기록. 동일 상태는 무시, 같은 coalesceKey 연속 기록은 병합.
 * @returns {boolean} whether the stack changed
 */
export function pushHistory({ coalesceKey = null } = {}) {
  if (historyMuted > 0) return false;
  const h = appState.history;
  const snap = documentSnapshot();
  if (h.index >= 0 && h.stack[h.index] === snap) return false;
  const canCoalesce = coalesceKey && coalesceKey === h.lastCoalesceKey && h.index > 0 && h.index === h.stack.length - 1;
  if (canCoalesce) {
    h.stack[h.index] = snap;
  } else {
    h.stack.splice(h.index + 1);
    h.stack.push(snap);
    if (h.stack.length > h.limit) h.stack.splice(0, h.stack.length - h.limit);
    h.index = h.stack.length - 1;
  }
  h.lastCoalesceKey = coalesceKey;
  return true;
}

/** Clear history and record the current document as the baseline. / 히스토리 초기화 */
export function resetHistory() {
  const h = appState.history;
  h.stack = [documentSnapshot()];
  h.index = 0;
  h.lastCoalesceKey = null;
}

/** End a coalescing gesture so the next push starts a new entry (call on pointerup). */
export function endHistoryGesture() {
  appState.history.lastCoalesceKey = null;
  groupGesture = null;
}

export function canUndo() {
  return appState.history.index > 0;
}

export function canRedo() {
  const h = appState.history;
  return h.index < h.stack.length - 1;
}

function restoreDocument(json) {
  const doc = JSON.parse(json);
  appState.voices = doc.voices;
  appState.activeVoiceId = doc.activeVoiceId;
  const ids = new Set(doc.voices.map((v) => v.id));
  appState.selectedVoiceIds = (doc.selectedVoiceIds || []).filter((id) => ids.has(id));
  if (!ids.has(appState.activeVoiceId)) appState.activeVoiceId = doc.voices[0]?.id ?? null;
  const sp = doc.studioParams;
  appState.studioParams = sp && typeof sp === 'object' && !Array.isArray(sp) ? sp : {};
  restoreManager(doc.manager);
}

export function undo() {
  if (!canUndo()) return false;
  const h = appState.history;
  h.index -= 1;
  h.lastCoalesceKey = null;
  restoreDocument(h.stack[h.index]);
  dispatch({ type: 'history/undo', scope: ['all', 'history'] });
  return true;
}

export function redo() {
  if (!canRedo()) return false;
  const h = appState.history;
  h.index += 1;
  h.lastCoalesceKey = null;
  restoreDocument(h.stack[h.index]);
  dispatch({ type: 'history/redo', scope: ['all', 'history'] });
  return true;
}

// ==========================================================================
// Actions (thin wrappers around dispatch) / 액션
// ==========================================================================

/** Generic preference setter for non-document UI state (no history). / UI 설정 변경 */
export function setPref(key, value, scope = 'view') {
  if (!(key in appState) || key === 'voices' || key === 'history') throw new RangeError(`setPref: "${key}"`);
  return dispatch({ type: `pref/${key}`, scope, mutate: (s) => { s[key] = value; } });
}

export function setLanguage(lang) {
  return dispatch({ type: 'pref/lang', scope: ['lang'], mutate: (s) => { s.lang = setLang(lang); } });
}

export function setUiZoom(percent) {
  return dispatch({
    type: 'pref/uiZoom',
    scope: ['layout'],
    mutate: (s) => { s.uiZoom = clamp(Math.round(Number(percent) || 100), UI_ZOOM_MIN, UI_ZOOM_MAX); },
  });
}

export function setStudio(studio) {
  return dispatch({
    type: 'pref/studio',
    scope: ['studio', 'all'],
    mutate: (s) => { if (isValidStudioId(studio)) s.studio = studio; },
  });
}

export function setViewport(patch) {
  return dispatch({ type: 'view/viewport', scope: ['canvas'], mutate: (s) => { Object.assign(s.viewport, patch); } });
}

export function setTransport(patch) {
  return dispatch({ type: 'transport', scope: ['transport'], mutate: (s) => { Object.assign(s.transport, patch); } });
}

/**
 * Select a voice. additive = toggle in selection (Ctrl/⌘), range = extend (Shift).
 * 보이스 선택. additive=토글, range=범위 선택.
 */
export function selectVoice(id, { additive = false, range = false, keep = false } = {}) {
  return dispatch({
    type: 'voice/select',
    scope: ['selection', 'panels', 'canvas', 'gain', 'matrix', 'timbre'],
    mutate: (s) => {
      if (!getVoiceById(id)) return;
      // keep: make a voice of the selection the active one, selection unchanged / 선택은 그대로, 활성만 변경
      if (keep && s.selectedVoiceIds.includes(id)) { s.activeVoiceId = id; return; }
      if (range && s.activeVoiceId) {
        const ids = s.voices.map((v) => v.id);
        const a = ids.indexOf(s.activeVoiceId);
        const b = ids.indexOf(id);
        const [lo, hi] = a < b ? [a, b] : [b, a];
        s.selectedVoiceIds = [...new Set([...s.selectedVoiceIds, ...ids.slice(lo, hi + 1)])];
      } else if (additive) {
        const set = new Set(s.selectedVoiceIds);
        if (set.has(id) && set.size > 1) set.delete(id);
        else set.add(id);
        s.selectedVoiceIds = [...set];
      } else {
        s.selectedVoiceIds = [id];
      }
      s.activeVoiceId = s.selectedVoiceIds.includes(id) ? id : s.selectedVoiceIds[0];
    },
  });
}

/** Select every voice (the active voice stays active). / 모든 보이스 선택 */
export function selectAllVoices() {
  return dispatch({
    type: 'voice/select',
    scope: ['selection', 'panels', 'canvas', 'gain', 'matrix', 'timbre'],
    mutate: (s) => {
      s.selectedVoiceIds = s.voices.map((v) => v.id);
      if (!s.selectedVoiceIds.includes(s.activeVoiceId)) s.activeVoiceId = s.selectedVoiceIds[0];
    },
  });
}

export function addVoice(overrides = {}) {
  return dispatch({
    type: 'voice/add',
    history: true,
    scope: 'all',
    mutate: (s) => {
      const v = createDefaultVoice(s.voices.length, overrides);
      v.color = overrides.color || nextVoiceColor(s.voices);
      v.name = overrides.name || nextVoiceName(s.voices);
      s.voices.push(v);
      s.activeVoiceId = v.id;
      s.selectedVoiceIds = [v.id];
      return v;
    },
  });
}

/**
 * Duplicate a voice right after it in the list. With { afterEnd: true } the copy starts where
 * the original ends (Shift+R). / 보이스 복제 (afterEnd: 원본 끝 지점에서 시작)
 */
export function duplicateVoice(id = appState.activeVoiceId, { afterEnd = false } = {}) {
  return dispatch({
    type: 'voice/duplicate',
    history: true,
    scope: 'all',
    mutate: (s) => {
      const idx = s.voices.findIndex((v) => v.id === id);
      if (idx < 0) return null;
      const copy = deepClone(s.voices[idx]);
      copy.id = uid('v_', 7);
      copy.name = `${s.voices[idx].name} copy`;
      copy.color = nextVoiceColor(s.voices);
      copy.solo = false;
      if (afterEnd) copy.startTime = clamp(getVoiceEnd(s.voices[idx]), 0, MAX_TIME);
      delete copy.link; // a copy is a line of its own / 복제본은 별개의 선
      for (const n of copy.morphNodes || []) n.id = uid('mn_', 6);
      for (const n of copy.gainEngineObj?.morphNodes || []) n.id = uid('mn_', 6);
      s.voices.splice(idx + 1, 0, copy);
      s.activeVoiceId = copy.id;
      s.selectedVoiceIds = [copy.id];
      return copy;
    },
  });
}

/**
 * Fields that make up a line's curve shape — what linked pieces (🔗) share. Timing, play range,
 * timbre, gain, name and colour stay each piece's own. / 링크된 조각이 공유하는 곡선 모양 필드.
 */
export const LINK_SHAPE_KEYS = Object.freeze([
  ...Object.keys(createDefaultCurveConfig()),
  'f0Hz', 'f0Midi', 'f0Fine', 'f1Hz', 'f1Midi', 'f1Fine', 'logScale', 'audioTarget', 'regions',
]);

/**
 * Cut a voice at `sec` into two linked pieces (✂ — Locate double-click on a line, or the grapher's
 * Split at cue). Together they play exactly what the voice played. / 보이스를 sec에서 링크된 두 조각으로 자름.
 * @returns {object} event; `result` = the new second piece, or null when `sec` is too close to an end
 */
export function splitVoice(id = appState.activeVoiceId, sec = appState.transport.cueSec) {
  return dispatch({
    type: 'voice/split',
    history: true,
    scope: 'all',
    mutate: (s) => {
      const idx = s.voices.findIndex((v) => v.id === id);
      if (idx < 0) return null;
      const pieces = splitLineAt(s.voices[idx], sec, { newId: () => uid('v_', 7), linkId: () => uid('ln_', 6), minDur: MIN_DURATION });
      if (!pieces) return null;
      const [a, b] = pieces;
      b.name = `${String(a.name).replace(/ ✂\d+$/, '')} ✂${Math.max(1, s.voices.filter((v) => v.link?.id === a.link.id).length) + 1}`.slice(0, 40);
      b.solo = false;
      for (const n of b.morphNodes || []) n.id = uid('mn_', 6);
      for (const n of b.gainEngineObj?.morphNodes || []) n.id = uid('mn_', 6);
      for (const r of b.regions || []) r.id = uid('rg_', 6);
      s.voices.splice(idx, 1, a, b);
      s.activeVoiceId = b.id;
      s.selectedVoiceIds = [b.id];
      return b;
    },
  });
}

/**
 * 🔗 checkbox of a voice card: off = a separate line from now on; on again = take the shape of the
 * other linked pieces. / 🔗 체크박스: 끄면 별개의 선, 다시 켜면 다른 링크 조각의 모양을 따름.
 */
export function setVoiceLink(id, on) {
  return dispatch({
    type: 'voice/link',
    history: true,
    scope: ['canvas', 'gain', 'panels', 'matrix'],
    mutate: (s) => {
      const v = s.voices.find((x) => x.id === id);
      if (!v?.link) return false;
      v.link.on = !!on;
      if (on) {
        const src = linkedPeers(s.voices, v)[0];
        if (src) for (const k of LINK_SHAPE_KEYS) { if (src[k] === undefined) delete v[k]; else v[k] = deepClone(src[k]); }
      }
      return true;
    },
  });
}

/**
 * Delete voices (default: current selection). At least one voice always remains;
 * returns an event whose `result` is false when the deletion was refused.
 * 보이스 삭제 (최소 1개 유지; 거부 시 result=false).
 */
export function deleteVoices(ids = appState.selectedVoiceIds.length ? appState.selectedVoiceIds : [appState.activeVoiceId]) {
  const kill = new Set(ids);
  if (appState.voices.every((v) => kill.has(v.id))) {
    return { type: 'voice/delete', scope: new Set(), payload: ids, result: false, historyChanged: false };
  }
  return dispatch({
    type: 'voice/delete',
    history: true,
    scope: 'all',
    payload: ids,
    mutate: (s) => {
      const firstIdx = s.voices.findIndex((v) => kill.has(v.id));
      s.voices = s.voices.filter((v) => !kill.has(v.id));
      const fallback = s.voices[Math.min(Math.max(0, firstIdx), s.voices.length - 1)];
      s.selectedVoiceIds = s.selectedVoiceIds.filter((id) => !kill.has(id));
      if (!s.selectedVoiceIds.length) s.selectedVoiceIds = [fallback.id];
      if (kill.has(s.activeVoiceId)) s.activeVoiceId = s.selectedVoiceIds[0];
      return true;
    },
  });
}

export function reorderVoice(fromIndex, toIndex) {
  return dispatch({
    type: 'voice/reorder',
    history: true,
    scope: ['panels', 'matrix', 'canvas'],
    mutate: (s) => {
      const n = s.voices.length;
      if (fromIndex < 0 || fromIndex >= n) return false;
      const [v] = s.voices.splice(fromIndex, 1);
      s.voices.splice(clamp(toIndex, 0, n - 1), 0, v);
      return true;
    },
  });
}

/**
 * Apply an edit to voices. Defaults to getTargetVoices() (honours groupApplyMode).
 * `edit` is a patch object or a function (voice) => void.
 * 보이스 편집 적용 (기본: 그룹 적용 모드를 반영한 대상).
 * @param {object|((voice:object) => void)} edit
 * @param {{ ids?: string[], history?: boolean, coalesceKey?: string, scope?: string|string[], type?: string }} [opts]
 */
export function updateVoices(edit, opts = {}) {
  const { ids, history = true, coalesceKey = null, scope = ['canvas', 'gain', 'panels', 'matrix'], type = 'voice/update' } = opts;
  return dispatch({
    type,
    history,
    coalesceKey,
    scope,
    mutate: () => {
      const targets = ids ? ids.map(getVoiceById).filter(Boolean) : getTargetVoices();
      const apply = (v) => {
        if (typeof edit === 'function') edit(v);
        else Object.assign(v, deepClone(edit));
      };
      // Linked pieces (🔗): note their shape before the edit / 링크된 조각: 편집 전 모양 기록
      const linked = targets.filter((v) => v.link?.on);
      const before = linked.length ? new Map(linked.map((v) => [v.id, shapeSignature(v, LINK_SHAPE_KEYS)])) : null;
      const lead = getActiveVoice();
      const mode = appState.groupEditMode;
      const relative = !ids && appState.groupApplyMode && (mode === 'ratio' || mode === 'offset') && targets.length > 1 && targets.includes(lead);
      if (relative) applyGroupRelative(targets, lead, apply, mode, coalesceKey);
      else for (const v of targets) apply(v);
      // the active voice leads when several pieces of one line were edited / 여러 조각 편집 시 활성 보이스 우선
      if (before) syncLinkedShapes(appState.voices, [...linked].sort((a, b) => (b === lead) - (a === lead)), before, LINK_SHAPE_KEYS);
      return targets.length;
    },
  });
}

// ---- Group edit: ratio / offset / 그룹 편집: 비율 · 덧셈 ---------------------
// 'sync' runs the edit on every selected voice, so they all get the same value. 'ratio' and
// 'offset' keep the voices different: the edit is measured on the active voice (before → after)
// and every other voice gets the same factor / the same amount on its own value. Values are
// measured from the start of the gesture (one slider drag), so a drag never drifts and going
// back to the start restores every voice. Settings that are not plain numbers (engine, modes,
// point lists) are synced. Pitch is moved in semitones — in both modes a transposition.
// 'sync'는 모든 선택 보이스에 같은 값을 넣는다. 'ratio'·'offset'은 활성 보이스의 변화(전 → 후)를
// 재서, 다른 보이스의 자기 값에 같은 배율 / 같은 양을 적용한다. 제스처 시작 시점 기준이라 드래그가
// 누적 오차 없이 되돌아온다. 숫자가 아닌 설정(엔진·모드·점 목록)은 동기화. 음고는 반음 단위 이조.

let groupGesture = null; // { key, sig, base: Map(id → voice clone at the start of the gesture) }
const GROUP_PITCH_KEYS = new Set(['f0Midi', 'f0Hz', 'f0Fine', 'f1Midi', 'f1Hz', 'f1Fine']);
const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

/** One value of another voice after the active voice went a0 → a1. / 다른 보이스의 값 */
export function groupRelativeValue(mode, b0, a0, a1) {
  if (a1 === a0) return b0;
  const out = mode === 'ratio' && Math.abs(a0) > 1e-9 ? b0 * (a1 / a0) : b0 + (a1 - a0);
  return Number.isFinite(out) ? out : b0;
}

function groupRelativeWalk(mode, v, v0, a0, a1, top = false) {
  for (const k of Object.keys(v0)) {
    if (top && GROUP_PITCH_KEYS.has(k)) continue;
    const b0 = v0[k];
    if (typeof b0 === 'number') {
      if (typeof a0[k] === 'number' && typeof a1[k] === 'number' && typeof v[k] === 'number') v[k] = groupRelativeValue(mode, b0, a0[k], a1[k]);
    } else if (isPlainObject(b0) && isPlainObject(a0[k]) && isPlainObject(a1[k]) && isPlainObject(v[k])) {
      groupRelativeWalk(mode, v[k], b0, a0[k], a1[k]);
    }
  }
}

function applyGroupRelative(targets, lead, apply, mode, coalesceKey) {
  const sig = `${mode}|${lead.id}|${targets.map((v) => v.id).join(',')}`;
  if (!coalesceKey || !groupGesture || groupGesture.key !== coalesceKey || groupGesture.sig !== sig) {
    groupGesture = { key: coalesceKey, sig, base: new Map(targets.map((v) => [v.id, deepClone(v)])) };
  }
  const { base } = groupGesture;
  for (const v of targets) apply(v);
  const lead0 = base.get(lead.id);
  for (const v of targets) {
    if (v === lead) continue;
    const v0 = base.get(v.id);
    groupRelativeWalk(mode, v, v0, lead0, lead, true);
    for (const side of ['f0', 'f1']) {
      const d = getVoiceMidi(lead, side) - getVoiceMidi(lead0, side);
      for (const f of ['Hz', 'Midi', 'Fine']) v[`${side}${f}`] = v0[`${side}${f}`];
      if (Math.abs(d) > 1e-9) setVoicePitch(v, side, { hz: v0[`${side}Hz`] * 2 ** (d / 12) });
    }
    // Keep the result inside the hard ranges / 하드 범위 안으로
    v.startTime = clamp(v.startTime, 0, MAX_TIME);
    v.duration = clamp(v.duration, MIN_DURATION, MAX_TIME);
    v.baseGain = clampBaseGain(v.baseGain);
    for (const w of TIMBRE_WAVES) v.timbre[w] = clamp(Number(v.timbre[w]) || 0, 0, 1);
    v.dbMin = Math.min(-12, Math.max(-120, Math.round(v.dbMin)));
    if (v.gainEngineObj) {
      v.gainEngineObj.ampMin = clamp(Number(v.gainEngineObj.ampMin) || 0, 0, 1);
      v.gainEngineObj.ampMax = clamp(Number.isFinite(v.gainEngineObj.ampMax) ? v.gainEngineObj.ampMax : 1, 0, 1);
    }
    v.tremolo = normalizeTremolo(v.tremolo);
  }
}

// ---- Versions / 버전 -------------------------------------------------------
// A Version is a restorable backup of the Glissando document (voices). One is made with every
// Screenshot (ui/screenshot.js), and the screenshot image is its thumbnail. It is not a preset
// and not the undo stack. / Version = 글리산도 문서(voices)의 복원 가능한 백업. 스크린샷마다 하나씩
// 만들어지며 스크린샷 이미지가 썸네일. 프리셋·undo 스택과는 별개.

/**
 * @param {{ label?: string, thumb?: string|null, mode?: 'full'|'clean' }} [info]
 *   thumb = small image data URL of the screenshot (null → the gallery draws a vector sketch)
 */
export function captureVersion({ label = '', thumb = null, mode = 'full' } = {}) {
  return dispatch({
    type: 'version/capture',
    scope: ['versions', 'canvas'],
    mutate: (s) => {
      const ver = {
        id: uid('ver_', 6),
        label,
        createdAt: Date.now(),
        ghost: false,
        mode,
        thumb,
        voices: deepClone(s.voices),
        activeVoiceId: s.activeVoiceId,
      };
      s.versions.push(ver);
      return ver;
    },
  });
}

export function restoreVersion(id) {
  const ver = appState.versions.find((x) => x.id === id);
  if (!ver) return null;
  return dispatch({
    type: 'version/restore',
    history: true,
    scope: 'all',
    mutate: (s) => {
      s.voices = deepClone(ver.voices);
      s.activeVoiceId = ver.activeVoiceId;
      s.selectedVoiceIds = [ver.activeVoiceId];
    },
  });
}

export function toggleVersionGhost(id) {
  return dispatch({
    type: 'version/ghost',
    scope: ['versions', 'canvas'],
    mutate: (s) => { const x = s.versions.find((y) => y.id === id); if (x) x.ghost = !x.ghost; },
  });
}

export function removeVersion(id) {
  return dispatch({
    type: 'version/remove',
    scope: ['versions', 'canvas'],
    mutate: (s) => { s.versions = s.versions.filter((x) => x.id !== id); },
  });
}

export function clearVersions() {
  return dispatch({ type: 'version/clear', scope: ['versions', 'canvas'], mutate: (s) => { s.versions = []; } });
}

// ==========================================================================
// Project (de)serialisation / 프로젝트 저장·불러오기
// ==========================================================================

const SERIALIZED_PREFS = ['lang', 'studio', 'layout', 'uiZoom', 'viewMode', 'gridSub', 'showDeriv', 'locateSnap', 'durEditMode', 'groupApplyMode', 'groupEditMode', 'legatoJoin', 'sampleJoin', 'joinGlideMs', 'clipGhost', 'screenshotMode', 'screenshotSvg', 'output'];

/**
 * Plain JSON-safe project object (caller stringifies / downloads).
 * `samples`: the sound files the project refers to (per-voice Sampler) are embedded as 16-bit PCM.
 * Autosave passes { samples: false } and keeps them in its own store.
 * 프로젝트가 참조하는 사운드 파일을 16비트 PCM으로 포함. 자동 저장은 별도 저장소에 보관.
 */
export function serializeProject({ samples = true } = {}) {
  const prefs = {};
  for (const k of SERIALIZED_PREFS) prefs[k] = appState[k];
  const out = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    prefs,
    viewport: deepClone(appState.viewport),
    voices: deepClone(appState.voices),
    activeVoiceId: appState.activeVoiceId,
    versions: deepClone(appState.versions),
    studioParams: deepClone(appState.studioParams),
    manager: deepClone({ ...appState.manager, open: false }),
  };
  if (samples) {
    const ids = referencedSampleIds(JSON.stringify(out));
    if (ids.length) out.samples = serializeSamples(ids);
  }
  return out;
}

/**
 * Load a project object (or JSON string). Also accepts the legacy Glissando Master
 * format (has `voices` but no `format`). Resets undo history on success.
 * 프로젝트 불러오기 (구버전 형식 호환, 성공 시 히스토리 초기화).
 * @returns {{ ok: boolean, error?: string }}
 */
export function loadProjectData(data) {
  let obj = data;
  try {
    if (typeof obj === 'string') obj = JSON.parse(obj);
  } catch (e) {
    return { ok: false, error: 'parse' };
  }
  if (!obj || !Array.isArray(obj.voices) || !obj.voices.length) return { ok: false, error: 'no-voices' };
  if (obj.format && obj.format !== PROJECT_FORMAT) return { ok: false, error: 'format' };
  // Legacy Glissando Master files have no `format` and their own version string (e.g. '2.0')
  // 구버전 파일은 format이 없고 자체 버전 문자열을 가지므로 네이티브 파일만 버전 검사
  if (obj.format === PROJECT_FORMAT && Number(obj.version) > PROJECT_VERSION) return { ok: false, error: 'version' };

  // Sound files first, so Sampler voices find them / 샘플러 보이스가 찾도록 사운드 파일 먼저
  if (Array.isArray(obj.samples)) loadSamples(obj.samples);
  let voices;
  try {
    voices = obj.voices.map((v, i) => normalizeVoice(v, i));
  } catch (e) {
    return { ok: false, error: 'voice' };
  }
  const seen = new Set();
  for (const v of voices) {
    if (seen.has(v.id)) v.id = uid('v_', 7);
    seen.add(v.id);
  }

  dispatch({
    type: 'project/load',
    scope: 'all',
    mutate: (s) => {
      s.voices = voices;
      s.activeVoiceId = seen.has(obj.activeVoiceId) ? obj.activeVoiceId : voices[0].id;
      s.selectedVoiceIds = [s.activeVoiceId];
      const prefs = obj.prefs || {};
      for (const k of SERIALIZED_PREFS) if (prefs[k] !== undefined && typeof prefs[k] === typeof s[k]) s[k] = prefs[k];
      if (!isValidStudioId(s.studio)) s.studio = 'glissando';
      s.output = normalizeOutputConfig(prefs.output);
      s.lang = setLang(s.lang);
      const vp = obj.viewport || {};
      for (const k of Object.keys(s.viewport)) if (Number.isFinite(vp[k])) s.viewport[k] = vp[k];
      // `snapshots` is the pre-Screenshot name of `versions` (older projects) / 구버전 키 호환
      s.versions = Array.isArray(obj.versions) ? obj.versions : Array.isArray(obj.snapshots) ? obj.snapshots : [];
      s.studioParams = obj.studioParams && typeof obj.studioParams === 'object' && !Array.isArray(obj.studioParams) ? obj.studioParams : {};
      s.manager = normalizeManagerState(obj.manager, s.manager?.open);
      resetHistory();
    },
  });
  return { ok: true };
}

/** Parse a project file's JSON text (or pass an object through); null when it is not JSON. / 프로젝트 JSON 파싱 */
export function parseProjectData(data) {
  if (typeof data !== 'string') return data && typeof data === 'object' ? data : null;
  try { return JSON.parse(data); } catch (e) { return null; }
}

/**
 * Studios that hold content in a project file, in Manager order. Glissando counts whenever the file has
 * voices (every project does). / 프로젝트 파일에 내용이 있는 스튜디오 (매니저 순서)
 * @returns {string[]}
 */
export function listProjectStudios(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const found = new Set();
  if (Array.isArray(obj.voices) && obj.voices.length) found.add('glissando');
  const sp = obj.studioParams;
  if (sp && typeof sp === 'object' && !Array.isArray(sp)) for (const k of Object.keys(sp)) if (isValidStudioId(k)) found.add(k);
  for (const i of Array.isArray(obj.manager?.instances) ? obj.manager.instances : []) if (i && isValidStudioId(i.studio)) found.add(i.studio);
  const order = ['glissando', 'risset', 'field', 'draw', 'chaos', 'cloud', 'tempo', 'space', 'fractal', 'wave', 'grid'];
  return [...found].sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
  });
}

/**
 * Copy of a project object that keeps only the chosen studios. A studio left out comes back at its
 * defaults: its instances, saved document and (Glissando) voices and Versions are dropped, and the
 * active studio moves to the first chosen one. The project-wide parts (output, tempo, regions of the
 * Manager, samples) stay. / 선택한 스튜디오만 남긴 프로젝트 복사본 (제외한 스튜디오는 기본값)
 * @param {object} obj parsed project
 * @param {string[]} keep studio ids to keep
 */
export function filterProjectStudios(obj, keep) {
  const keepSet = new Set(keep);
  const out = { ...obj };
  if (!keepSet.has('glissando')) {
    out.voices = [{}]; // normalizeVoice fills in the defaults / 기본 보이스
    delete out.activeVoiceId;
    out.versions = [];
    delete out.snapshots;
  }
  if (obj.studioParams && typeof obj.studioParams === 'object' && !Array.isArray(obj.studioParams)) {
    out.studioParams = Object.fromEntries(Object.entries(obj.studioParams).filter(([k]) => keepSet.has(k)));
  }
  if (obj.manager && typeof obj.manager === 'object') {
    const m = { ...obj.manager };
    m.instances = (Array.isArray(m.instances) ? m.instances : []).filter((i) => i && keepSet.has(i.studio));
    if (m.focus && typeof m.focus === 'object') m.focus = Object.fromEntries(Object.entries(m.focus).filter(([k]) => keepSet.has(k)));
    out.manager = m;
  }
  const cur = obj.prefs?.studio;
  if (!keepSet.has(cur)) {
    const first = keep[0];
    out.prefs = { ...(obj.prefs || {}), studio: first || 'glissando' };
  }
  return out;
}

/**
 * Short preview line for one studio of a project object, e.g. "3 voices" or "2 instances".
 * 프로젝트의 한 스튜디오 내용 요약 (미리보기용)
 * @returns {{ count: number, kind: 'voices'|'instances', names: string[] }}
 */
export function summarizeProjectStudio(obj, studio) {
  const inst = (Array.isArray(obj?.manager?.instances) ? obj.manager.instances : []).filter((i) => i && i.studio === studio);
  const names = inst.map((i) => String(i.name || studio)).slice(0, 4);
  if (studio === 'glissando' && Array.isArray(obj?.voices)) return { count: obj.voices.length, kind: 'voices', names };
  return { count: inst.length || (obj?.studioParams?.[studio] ? 1 : 0), kind: 'instances', names };
}

/**
 * Current project with the chosen studios replaced by their versions from `prev` (the other studios
 * stay as they are now). Used to go back to earlier work studio by studio.
 * 선택한 스튜디오만 이전 작업으로 바꾼 프로젝트 (나머지는 현재 그대로)
 * @param {object} cur  serializeProject() of the current work
 * @param {object} prev serializeProject() of the earlier work
 * @param {string[]} keep studio ids taken from prev
 */
export function mergeProjectStudios(cur, prev, keep) {
  const keepSet = new Set(keep);
  const out = { ...cur };
  if (keepSet.has('glissando')) {
    out.voices = prev.voices;
    out.activeVoiceId = prev.activeVoiceId;
    out.versions = prev.versions || [];
  }
  const sp = { ...(cur.studioParams || {}) };
  for (const k of keepSet) {
    if (prev.studioParams && k in prev.studioParams) sp[k] = prev.studioParams[k];
    else delete sp[k];
  }
  out.studioParams = sp;
  const pm = prev.manager || {};
  const cm = cur.manager || {};
  const prevInst = (Array.isArray(pm.instances) ? pm.instances : []).filter((i) => i && keepSet.has(i.studio));
  const prevIds = new Set(prevInst.map((i) => i.id));
  const rest = (Array.isArray(cm.instances) ? cm.instances : []).filter((i) => i && !keepSet.has(i.studio) && !prevIds.has(i.id));
  const focus = { ...(cm.focus || {}) };
  for (const k of keepSet) { if (pm.focus && pm.focus[k]) focus[k] = pm.focus[k]; else delete focus[k]; }
  out.manager = { ...cm, instances: [...rest, ...prevInst], focus };
  return out;
}

/** Saved instance document; Glissando voices are normalized like top-level voices. / 인스턴스 문서 정규화 */
function normalizeInstanceDoc(studio, doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (studio !== 'glissando' || !Array.isArray(doc.voices)) return doc;
  const seen = new Set();
  const voices = doc.voices.map((v, i) => {
    const n = normalizeVoice(v, i);
    while (seen.has(n.id)) n.id = uid('v_', 7);
    seen.add(n.id);
    return n;
  });
  if (!voices.length) return null;
  return { ...doc, voices, activeVoiceId: seen.has(doc.activeVoiceId) ? doc.activeVoiceId : voices[0].id };
}

function normalizeBandRaw(b) {
  if (!b || !Array.isArray(b.t) || b.t.length < 2) return null;
  const n = Math.min(b.t.length, Array.isArray(b.lo) ? b.lo.length : 0, Array.isArray(b.hi) ? b.hi.length : 0);
  if (n < 2) return null;
  const num = (arr) => arr.slice(0, n).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  const t = num(b.t);
  return { t, lo: num(b.lo), hi: num(b.hi), t0: t[0], t1: t[n - 1], closed: !!b.closed, area: Number(b.area) || 0 };
}

/** Sanitize a saved manager block (old projects have none → empty; ensureManager fills it). */
export function normalizeManagerState(raw, open = false) {
  const m = createDefaultManagerState();
  m.open = !!open;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.instances)) return m;
  const seen = new Set();
  for (const i of raw.instances) {
    if (!i || !isValidStudioId(i.studio) || typeof i.id !== 'string' || seen.has(i.id)) continue;
    seen.add(i.id);
    const d = createInstanceDefaults(i.studio);
    const num = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : fb);
    m.instances.push({
      ...d,
      id: i.id,
      studio: i.studio,
      name: String(i.name || i.studio).slice(0, 40),
      color: typeof i.color === 'string' ? i.color : VOICE_COLORS[m.instances.length % VOICE_COLORS.length],
      doc: normalizeInstanceDoc(i.studio, i.doc),
      gainDb: num(i.gainDb, -60, 12, 0),
      mute: !!i.mute,
      solo: !!i.solo,
      start: num(i.start, 0, MAX_TIME, 0),
      length: i.length === null || i.length === undefined ? d.length : num(i.length, 0.1, MAX_TIME, d.length),
      loop: i.loop === undefined ? d.loop : !!i.loop,
      fadeIn: num(i.fadeIn, 0, 10, d.fadeIn),
      fadeOut: num(i.fadeOut, 0, 10, d.fadeOut),
      inCycle: i.inCycle === undefined ? true : !!i.inCycle,
      tempo: normalizeTempoConfig(i.tempo),
      tremolo: normalizeTremolo(i.tremolo),
      warp: normalizeWarp(i.warp, i.studio),
      take: normalizeTake(i.take),
      ...(typeof i.ext === 'string' && i.ext ? { ext: i.ext } : {}),
    });
  }
  for (const [studio, id] of Object.entries(raw.focus || {})) {
    if (m.instances.some((i) => i.id === id && i.studio === studio)) m.focus[studio] = id;
  }
  m.cycleLoop = raw.cycleLoop === undefined ? true : !!raw.cycleLoop;
  m.cycleMode = raw.cycleMode === 'fixed' ? 'fixed' : 'auto';
  if (Number.isFinite(Number(raw.cycleLen)) && raw.cycleLen !== null) m.cycleLen = clamp(Number(raw.cycleLen), 0.1, MAX_TIME);
  m.tempo = normalizeTempoConfig(raw.tempo);
  const ids = new Set(m.instances.map((i) => i.id));
  for (const r of Array.isArray(raw.regions) ? raw.regions : []) {
    const t0 = Number(r?.t0);
    const t1 = Number(r?.t1);
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || Math.abs(t1 - t0) < 0.01) continue;
    const kind = r.kind === 'shape' ? 'shape' : 'range';
    const lobes = kind === 'shape' ? (Array.isArray(r.lobes) ? r.lobes : []).map(normalizeBandRaw).filter(Boolean) : undefined;
    if (kind === 'shape' && !lobes.length) continue;
    m.regions.push({
      kind,
      ...(lobes ? { lobes } : {}),
      id: typeof r.id === 'string' ? r.id : uid('rg_', 6),
      name: String(r.name || '').slice(0, 40),
      t0: clamp(Math.min(t0, t1), 0, MAX_TIME),
      t1: clamp(Math.max(t0, t1), 0, MAX_TIME),
      solo: (Array.isArray(r.solo) ? r.solo : []).filter((id) => ids.has(id)),
      mute: (Array.isArray(r.mute) ? r.mute : []).filter((id) => ids.has(id)),
      ...(typeof r.ext === 'string' && r.ext ? { ext: r.ext } : {}),
      ...(typeof r.scene === 'string' && r.scene ? { scene: r.scene } : {}), // written by Scenes / 씬이 쓴 구간
    });
  }
  m.mods = normalizeMods(raw.mods, ids); // Modulation matrix / 모듈레이션 매트릭스
  m.scenes = normalizeScenes(raw.scenes, ids); // Scenes / 씬
  m.sceneQuant = SCENE_QUANT.includes(raw.sceneQuant) ? raw.sceneQuant : 'now';
  m.sceneFollow = SCENE_FOLLOW.includes(raw.sceneFollow) ? raw.sceneFollow : 'off';
  m.sceneWrite = raw.sceneWrite && Array.isArray(raw.sceneWrite.prev) ? raw.sceneWrite : null;
  // Extend log: { id, method, seconds, from, to, prev: { cycleMode, cycleLen }, froze: [{ id, length }] } / 연장 기록
  for (const x of Array.isArray(raw.extensions) ? raw.extensions : []) {
    if (!x || typeof x.id !== 'string' || !x.id) continue;
    m.extensions.push({
      id: x.id,
      method: String(x.method || ''),
      seconds: Number(x.seconds) || 0,
      from: Number(x.from) || 0,
      to: Number(x.to) || 0,
      prev: { cycleMode: x.prev?.cycleMode === 'fixed' ? 'fixed' : 'auto', cycleLen: Number.isFinite(Number(x.prev?.cycleLen)) && x.prev?.cycleLen !== null ? Number(x.prev.cycleLen) : null },
      froze: (Array.isArray(x.froze) ? x.froze : []).filter((f) => f && ids.has(f.id) && Number(f.length) >= 0.1).map((f) => ({ id: f.id, length: Number(f.length) })),
    });
  }
  return m;
}

// Baseline history entry for the initial document / 초기 문서 기록
resetHistory();
setLang(appState.lang);

// ==========================================================================
// Self-check / 자가진단  —  run `await runSelfCheck()` in the browser console
// ==========================================================================

const selfChecks = [];

/**
 * Register a check. `fn(assert)` may be async; throw or use assert.* to fail.
 * 검사 항목 등록 (async 가능, 실패 시 throw 또는 assert 사용).
 * @param {string} name
 * @param {(assert: SelfCheckAssert) => void|Promise<void>} fn
 * @param {{ group?: string }} [opts]
 */
export function registerSelfCheck(name, fn, opts = {}) {
  selfChecks.push({ name, fn, group: opts.group || 'misc' });
}

/**
 * @typedef {object} SelfCheckAssert
 * @property {(cond: any, msg?: string) => void} ok
 * @property {(a: number, b: number, tol?: number, msg?: string) => void} near
 * @property {(a: any, b: any, msg?: string) => void} equal
 */
function createAssert() {
  const fail = (msg) => { throw new Error(msg); };
  return {
    ok: (cond, msg = 'assertion failed') => { if (!cond) fail(msg); },
    near: (a, b, tol = 1e-6, msg = '') => {
      if (!(Math.abs(a - b) <= tol)) fail(`${msg} expected ≈${b} (±${tol}), got ${a}`.trim());
    },
    equal: (a, b, msg = '') => {
      if (!Object.is(a, b)) fail(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`.trim());
    },
  };
}

/** Run fn against a throw-away copy of the document; real state & listeners untouched. */
export function withIsolatedState(fn) {
  const backup = deepClone({ ...appState, history: appState.history });
  const savedListeners = [...listeners];
  const savedLang = getLang();
  listeners.clear();
  try {
    return fn();
  } finally {
    for (const k of Object.keys(appState)) delete appState[k];
    Object.assign(appState, backup);
    listeners.clear();
    for (const l of savedListeners) listeners.add(l);
    setLang(savedLang);
  }
}

/**
 * Run every registered check and print a summary table.
 * 등록된 모든 검사를 실행하고 요약 표를 출력.
 * @param {{ verbose?: boolean, filter?: string }} [opts]
 * @returns {Promise<{ ok: boolean, passed: number, failed: number, total: number, results: Array }>}
 */
export async function runSelfCheck(opts = {}) {
  const { verbose = true, filter = '' } = opts;
  const results = [];
  for (const c of selfChecks) {
    if (filter && !`${c.group}/${c.name}`.includes(filter)) continue;
    const t0 = (globalThis.performance || Date).now();
    try {
      await c.fn(createAssert());
      results.push({ group: c.group, check: c.name, status: 'PASS', ms: +((globalThis.performance || Date).now() - t0).toFixed(1), detail: '' });
    } catch (err) {
      results.push({ group: c.group, check: c.name, status: 'FAIL', ms: +((globalThis.performance || Date).now() - t0).toFixed(1), detail: String(err?.message || err) });
    }
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const summary = { ok: failed === 0, passed: results.length - failed, failed, total: results.length, results };
  if (verbose && typeof console !== 'undefined') {
    const head = `[Flexatone] Self-check: ${summary.passed}/${summary.total} passed`;
    if (failed) console.warn(head);
    else console.info(head);
    if (console.table) console.table(results);
  }
  return summary;
}

// ---- Core checks / 핵심 검사 ----------------------------------------------

registerSelfCheck('EN/KO key parity', (a) => {
  const { missingInEn, missingInKo } = findMissingI18nKeys();
  a.ok(!missingInKo.length, `missing in ko: ${missingInKo.join(', ')}`);
  a.ok(!missingInEn.length, `missing in en: ${missingInEn.join(', ')}`);
}, { group: 'i18n' });

registerSelfCheck('t() fallback, functions, placeholders', (a) => {
  const prev = getLang();
  try {
    setLang('ko');
    a.equal(t('transport.play'), '재생');
    a.equal(t('grapher.voiceCount', 3), '보이스 3개');
    a.equal(t('no.such.key'), 'no.such.key');
    setLang('en');
    a.equal(t('grapher.voiceCount', 1), '1 Voice');
    I18N.en.__tmp = 'A{0}B{1}';
    a.equal(t('__tmp', 'x', 'y'), 'AxBy');
  } finally {
    delete I18N.en.__tmp;
    setLang(prev);
  }
}, { group: 'i18n' });

registerSelfCheck('LANG_TEXT_MAP references valid keys', (a) => {
  for (const [id, attrs] of Object.entries(LANG_TEXT_MAP)) {
    for (const key of Object.values(attrs)) a.ok(key in I18N.en && key in I18N.ko, `${id} → ${key}`);
  }
}, { group: 'i18n' });

registerSelfCheck('MIDI ↔ Hz', (a) => {
  a.near(midiToFreq(69), 440, 1e-9);
  a.near(midiToFreq(60), 261.6255653, 1e-6);
  a.near(midiToFreq(81), 880, 1e-9);
  for (let m = 0; m <= 127; m += 0.37) a.near(freqToMidi(midiToFreq(m)), m, 1e-9, `m=${m}`);
}, { group: 'units' });

registerSelfCheck('Note names ↔ MIDI', (a) => {
  a.equal(noteNameToMidi('C4'), 60);
  a.equal(noteNameToMidi('A4'), 69);
  a.equal(noteNameToMidi('Bb2'), 46);
  a.equal(noteNameToMidi('f#3'), 54);
  a.equal(noteNameToMidi('C-1'), 0);
  a.near(noteNameToMidi('A4+25'), 69.25, 1e-9);
  a.near(noteNameToMidi('A4 -30c'), 68.7, 1e-9);
  a.equal(noteNameToMidi('H2'), null);
  a.equal(noteNameToMidi(''), null);
  a.equal(midiToNoteName(60), 'C4');
  a.equal(midiToNoteName(60.25, { cents: true }), 'C4 +25¢');
  a.equal(midiToNoteName(59.75, { cents: true }), 'C4 −25¢');
  a.equal(midiToNoteName(70, { flats: true }), 'Bb4');
  for (let m = 21; m <= 108; m++) a.equal(noteNameToMidi(midiToNoteName(m)), m, `round-trip ${m}`);
}, { group: 'units' });

registerSelfCheck('Amp ↔ dB ↔ Sone', (a) => {
  a.near(ampToDb(1), 0, 1e-12);
  a.near(ampToDb(0.5), -6.0206, 1e-4);
  a.equal(ampToDb(0), DB_FLOOR);
  a.equal(dbToAmp(DB_FLOOR), 0);
  a.near(dbToAmp(-6.0206), 0.5, 1e-4);
  a.near(ampToSone(1), 1, 1e-12);
  a.near(ampToSone(dbToAmp(10)), 2, 1e-9, '+10 dB doubles loudness');
  a.near(ampToSone(dbToAmp(-10)), 0.5, 1e-9, '−10 dB halves loudness');
  a.equal(ampToSone(0), 0);
  a.equal(soneToAmp(0), 0);
  for (const amp of [0.001, 0.01, 0.1, 0.5, 0.85, 1, 1.5]) {
    a.near(soneToAmp(ampToSone(amp)), amp, 1e-9, `sone rt ${amp}`);
    a.near(dbToAmp(ampToDb(amp)), amp, 1e-9, `dB rt ${amp}`);
    a.near(convertGain(convertGain(amp, 'amp', 'sone'), 'sone', 'db'), ampToDb(amp), 1e-9);
  }
}, { group: 'units' });

registerSelfCheck('clamp / lerp / invLerp', (a) => {
  a.equal(clamp(5, 0, 1), 1);
  a.equal(clamp(-5, 0, 1), 0);
  a.equal(clamp(0.3, 0, 1), 0.3);
  a.near(lerp(2, 4, 0.25), 2.5);
  a.near(invLerp(2, 4, 2.5), 0.25);
}, { group: 'math' });

registerSelfCheck('Fritsch–Carlson time warp: endpoints & monotone', (a) => {
  for (const [x1, x2] of [[0.25, 0.75], [0.05, 0.95], [0.48, 0.52], [0.1, 0.6]]) {
    a.equal(evaluateTimeWarp(0, x1, x2), 0);
    a.equal(evaluateTimeWarp(1, x1, x2), 1);
    a.near(evaluateTimeWarp(0.5, x1, x2), 0.5, 1e-12);
    let prev = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const y = evaluateTimeWarp(i / 400, x1, x2);
      a.ok(y >= prev - 1e-12, `non-monotone at t=${i / 400} (x1=${x1}, x2=${x2})`);
      prev = y;
    }
  }
  const f = createMonotoneInterpolator([0, 0.1, 0.2, 1], [0, 0.9, 1, 1]);
  for (let i = 0; i <= 200; i++) a.ok(f(i / 200) <= 1 + 1e-12, 'monotone interpolator overshoot');
}, { group: 'math' });

function maxSplineDiff(ptsA, ptsB, n = 200) {
  let m = 0;
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    m = Math.max(m, Math.abs(evalPiecewiseBezierPoints(ptsA, x) - evalPiecewiseBezierPoints(ptsB, x)));
  }
  return m;
}

registerSelfCheck('Spline split & degree elevation preserve shape', (a) => {
  const base = [
    { x: 0, y: 0, handles: [{ u: 0.2, y: 0.9 }, { u: 0.7, y: -0.3 }] },
    { x: 0.6, y: 0.5, handles: [{ u: 0.5, y: 1.2 }] },
    { x: 1, y: 1, handles: [] },
  ];
  const split = deepClone(base);
  const inserted = splitSplineSegmentPreservingShape(split, 0, 0.23);
  a.ok(inserted && split.length === 4, 'point inserted');
  a.ok(maxSplineDiff(base, split) < 2e-3, `split drift ${maxSplineDiff(base, split)}`);

  const lin = createLinearSplinePoints(0, 1);
  splitSplineSegmentPreservingShape(lin, 0, 0.4);
  a.near(evalPiecewiseBezierPoints(lin, 0.4), 0.4, 1e-9, 'linear split');

  const elev = deepClone(base);
  a.ok(elevateSplineSegmentHandles(elev[0], elev[1]), 'elevated');
  a.equal(elev[0].handles.length, 3);
  a.ok(maxSplineDiff(base, elev) < 2e-3, `elevation drift ${maxSplineDiff(base, elev)}`);
  const straight = createLinearSplinePoints(0, 1);
  elevateSplineSegmentHandles(straight[0], straight[1], 0.3);
  a.near(evalPiecewiseBezierPoints(straight, 0.77), 0.77, 1e-6, 'first handle keeps line');
}, { group: 'math' });

registerSelfCheck('Function → spline capture & stroke fit', (a) => {
  const fn = (x) => 0.5 - 0.5 * Math.cos(Math.PI * x) + 0.1 * Math.sin(6 * Math.PI * x);
  const pts = sampleFunctionToSplinePoints(fn);
  a.ok(pts.length >= 2 && pts.length <= 16, 'anchor count');
  a.equal(pts[0].x, 0);
  a.equal(pts[pts.length - 1].x, 1);
  const xs = linspace(0, 1, 200);
  const err = rmse(xs.map(fn), xs.map((x) => evalPiecewiseBezierPoints(pts, x)));
  a.ok(err < 0.02, `capture RMSE ${err}`);

  const stroke = xs.map((x) => ({ x: 0.05 + 0.9 * x, y: x * x }));
  const fit = fitStrokeToSpline(stroke);
  a.ok(fit && fit[0].x === 0 && fit[fit.length - 1].x === 1, 'stroke spans 0…1');
}, { group: 'math' });

registerSelfCheck('Nelder–Mead & custom → engine inverse fit', (a) => {
  const nm = nelderMead(([x, y]) => (x - 1) ** 2 + (y + 2) ** 2, [0, 0], { step: 0.5, maxIter: 500 });
  a.near(nm.x[0], 1, 1e-3);
  a.near(nm.x[1], -2, 1e-3);

  const target = (tt) => Math.pow(tt, 2.5);
  const fit = analyzeAndFitCustomToEngine(target, [
    { id: 'linear', evaluate: (tt) => tt, params: {}, fit: {} },
    { id: 'power', evaluate: (tt, p) => Math.pow(tt, p.p), params: { p: 1 }, fit: { p: [0.5, 5] } },
    { id: 'steps', evaluate: (tt, p) => Math.floor(tt * p.n) / p.n, params: { n: 4 }, fit: { n: [1, 16, true] } },
  ]);
  a.equal(fit.best.id, 'power');
  a.near(fit.best.params.p, 2.5, 0.02);
  a.ok(fit.features.monotonic && !fit.features.hasRetrograde, 'features');
  a.ok(Number.isInteger(fit.ranking.find((r) => r.id === 'steps').params.n), 'integer param');

  const over = analyzeTrajectoryFeatures(linspace(0, 1, 100).map((x) => x + 0.6 * Math.sin(Math.PI * x)));
  a.ok(over.hasRetrograde && over.overshoot > 0.1, 'overshoot / retrograde detected');
}, { group: 'math' });

registerSelfCheck('RK4 integrators', (a) => {
  const decay = integrateRK4((tt, y) => -y, 1, { t0: 0, t1: 1, steps: 20 });
  a.near(decay[decay.length - 1].y, Math.exp(-1), 1e-6, 'dy/dt = −y');
  let y = [1, 0];
  const osc = (tt, s) => [s[1], -s[0]];
  for (let i = 0; i < 628; i++) y = rk4Step(osc, i * 0.01, y, 0.01);
  a.near(Math.hypot(y[0], y[1]), 1, 1e-6, 'oscillator energy');
  const path = traceFieldRK4((x, yy) => [-(yy - 0.5), x - 0.5], { x: 0.8, y: 0.5 }, { h: 0.01, maxSteps: 300 });
  a.ok(path.length > 100, 'traced');
  for (const p of path) a.near(Math.hypot(p.x - 0.5, p.y - 0.5), 0.3, 1e-5, 'vortex radius');
}, { group: 'math' });

registerSelfCheck('Voice & MorphNode factories match contract', (a) => {
  const v = createDefaultVoice(2);
  a.ok(/^v_[a-z0-9]{7}$/.test(v.id), `id ${v.id}`);
  a.equal(v.name, 'Voice 3');
  a.equal(v.color, VOICE_COLORS[2]);
  for (const k of ['solo', 'muted', 'startTime', 'duration', 'baseGain', 'gainUnit', 'dbTaper', 'dbMin', 'f0Midi', 'f0Hz', 'f0Fine',
    'f1Midi', 'f1Hz', 'f1Fine', 'logScale', 'audioTarget', 'timbreMode', 'timbre', 'timbreFunc', 'engine',
    'reverse', 'inverse', 'customPoints', 'morphNodes', 'gainMode', 'gainPoints', 'gainEngineObj']) {
    a.ok(k in v, `missing ${k}`);
  }
  a.ok(v.duration >= MIN_DURATION && v.baseGain >= 0 && v.baseGain <= 1.5, 'ranges');
  a.near(v.f0Hz, 130.81, 0.005);
  a.near(v.f1Hz, 523.25, 0.005);
  a.equal(Object.keys(v.timbre).join(), TIMBRE_WAVES.join());
  a.ok(ENGINE_IDS.includes(v.engine), 'engine id');
  for (const k of ['ampMin', 'ampMax', 'autoFit', 'engine', 'customPoints']) a.ok(k in v.gainEngineObj, `gainEngineObj.${k}`);
  const n = createDefaultMorphNode('damped', 0.3);
  a.ok(/^mn_/.test(n.id) && n.engine === 'damped' && n.weight === 0.3 && 'dampK' in n, 'morph node');
  a.equal(createDefaultMorphNode('morph').engine, 'harmonic', 'no recursive morph nodes');
  a.ok(createDefaultVoice().id !== createDefaultVoice().id, 'unique ids');
}, { group: 'state' });

registerSelfCheck('Pitch helpers keep Midi/Hz/Fine consistent', (a) => {
  const v = createDefaultVoice();
  a.ok(setVoicePitch(v, 'f0', { note: 'A4' }));
  a.equal(v.f0Midi, 69);
  a.near(v.f0Hz, 440, 1e-9);
  setVoicePitch(v, 'f0', { hz: 450 });
  a.equal(v.f0Midi, 69);
  setVoicePitch(v, 'f0', { fine: 250 });
  a.equal(v.f0Fine, 100);
  a.near(getVoiceHz(v, 'f0'), 450 * 2 ** (100 / 1200), 1e-9);
  a.equal(setVoicePitch(v, 'f1', { note: 'xyz' }), false);
  setVoiceTiming(v, { start: 1, duration: 2 });
  setVoiceEnd(v, 1.01);
  a.near(v.duration, MIN_DURATION, 1e-12, 'min duration');
}, { group: 'state' });

registerSelfCheck('dispatch / subscribe / undo / redo / coalesce', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    const seen = [];
    const off = subscribe((e) => seen.push(e.type), { scopes: ['matrix'] });
    const onlyLang = [];
    subscribe((e) => onlyLang.push(e.type), { scopes: ['lang'] });

    addVoice();
    a.equal(appState.voices.length, 2);
    a.ok(canUndo() && !canRedo(), 'undo available');
    a.equal(seen[seen.length - 1], 'voice/add', 'scope "all" reaches scoped listener');

    const id = appState.activeVoiceId;
    for (let i = 1; i <= 5; i++) updateVoices({ duration: i }, { coalesceKey: 'drag' });
    endHistoryGesture();
    a.equal(appState.history.stack.length, 3, 'drag coalesced into one entry');
    a.ok(undo());
    a.equal(getVoiceById(id).duration, 2.5, 'undo drag');
    a.ok(undo());
    a.equal(appState.voices.length, 1, 'undo add');
    a.ok(!canUndo(), 'at baseline');
    a.ok(redo() && redo());
    a.equal(getVoiceById(id).duration, 5, 'redo drag');
    dispatch({ type: 'probe', scope: 'canvas' });
    a.ok(seen.includes('probe') === false && !onlyLang.includes('probe'), 'scoped listeners filtered');

    off();
    const before = seen.length;
    setTransport({ playing: true });
    a.equal(seen.length, before, 'unsubscribed');

    let nestedOrder = [];
    subscribe((e) => {
      nestedOrder.push(e.type);
      if (e.type === 'outer') dispatch({ type: 'inner', scope: 'view' });
    }, { scopes: ['view'] });
    dispatch({ type: 'outer', scope: 'view' });
    a.equal(nestedOrder.join(), 'outer,inner', 'nested dispatch queued');
  });
}, { group: 'state' });

registerSelfCheck('Selection, group apply, delete guard', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    const v1 = appState.voices[0].id;
    const v2 = addVoice().result.id;
    const v3 = addVoice().result.id;
    selectVoice(v1);
    selectVoice(v3, { range: true });
    a.equal(appState.selectedVoiceIds.length, 3, 'range select');
    appState.groupApplyMode = false;
    updateVoices({ baseGain: 0.3 });
    a.equal(getVoiceById(v3).baseGain, 0.3);
    a.equal(getVoiceById(v1).baseGain, 0.85, 'group off → active only');
    appState.groupApplyMode = true;
    updateVoices((v) => { v.muted = true; });
    a.ok([v1, v2, v3].every((id) => getVoiceById(id).muted), 'group on → all selected');
    a.equal(getAudibleVoices().length, 0);
    // Group edit modes: ratio / offset keep the voices different / 그룹 편집 방식
    getVoiceById(v1).duration = 4; getVoiceById(v2).duration = 1; getVoiceById(v3).duration = 2;
    appState.groupEditMode = 'offset';
    updateVoices({ duration: 2.5 }, { coalesceKey: 'g' });
    updateVoices({ duration: 3 }, { coalesceKey: 'g' });
    a.equal([v1, v2, v3].map((id) => getVoiceById(id).duration).join(), '5,2,3', 'offset: same amount, measured from the gesture start');
    updateVoices({ duration: 2 }, { coalesceKey: 'g' });
    a.equal([v1, v2, v3].map((id) => getVoiceById(id).duration).join(), '4,1,2', 'back to the start restores every voice');
    endHistoryGesture();
    appState.groupEditMode = 'ratio';
    updateVoices({ duration: 3 });
    a.equal([v1, v2, v3].map((id) => getVoiceById(id).duration).join(), '6,1.5,3', 'ratio: same factor');
    setVoicePitch(getVoiceById(v1), 'f0', { midi: 60 });
    updateVoices((v) => { setVoicePitch(v, 'f0', { midi: 50 }); v.audioTarget = 'vel'; });
    a.near(getVoiceMidi(getVoiceById(v1), 'f0'), 62, 1e-3, 'pitch moves by the same interval');
    a.equal(getVoiceById(v1).audioTarget, 'vel', 'non-numeric settings are synced');
    appState.groupEditMode = 'sync';
    selectVoice(v1, { keep: true });
    a.ok(appState.activeVoiceId === v1 && appState.selectedVoiceIds.length === 3, 'keep: active changes, selection stays');
    selectVoice(v3, { keep: true });
    a.equal(deleteVoices([v1, v2, v3]).result, false, 'cannot delete all');
    deleteVoices([v2]);
    a.equal(appState.voices.length, 2);
    a.ok(!appState.selectedVoiceIds.includes(v2), 'selection pruned');
    const dup = duplicateVoice(v1).result;
    a.ok(dup.id !== v1 && appState.voices[1].id === dup.id, 'duplicate inserted after source');
  });
}, { group: 'state' });

registerSelfCheck('Project save → load round-trip & legacy migration', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    addVoice();
    updateVoices({ engine: 'custom', duration: 4.2 });
    const saved = JSON.stringify(serializeProject());
    Object.assign(appState, createInitialState());
    const res = loadProjectData(saved);
    a.ok(res.ok, res.error);
    a.equal(appState.voices.length, 2);
    a.equal(appState.voices[1].engine, 'custom');
    a.near(appState.voices[1].duration, 4.2, 1e-12);
    a.ok(!canUndo(), 'history reset after load');

    const legacy = {
      version: '2.0',
      voices: [{
        id: 'v_legacy1', name: 'Old', volume: 0.6, mapMode: 'lin', audioTarget: 'velocity',
        timbre: { sine: 1, square: 0.4 }, ampCurve: { engine: 'bounce', ampMin: 0.1, ampMax: 0.9, autoFit: false },
        f0Midi: 50, f0Hz: 146.83, f1Midi: 62, f1Hz: 293.66, startTime: 0, duration: 3,
        customPoints: [{ x: 0, y: 0, curve: 0.2 }, { x: 1, y: 1 }],
      }],
    };
    a.ok(loadProjectData(legacy).ok, 'legacy accepted');
    a.equal(loadProjectData({ format: PROJECT_FORMAT, version: PROJECT_VERSION + 1, voices: [{}] }).error, 'version', 'newer native file rejected');
    const v = appState.voices[0];
    a.equal(v.baseGain, 0.6);
    a.equal(v.logScale, false);
    a.equal(v.audioTarget, 'vel');
    a.equal(v.timbre.sqr, 0.4);
    a.ok(!('square' in v.timbre) && !('volume' in v) && !('ampCurve' in v), 'legacy fields removed');
    a.equal(v.gainEngineObj.engine, 'bounce');
    a.equal(v.gainEngineObj.autoFit, false);
    a.equal(v.customPoints[0].handles.length, 1, 'legacy curve → handle');
    a.equal(loadProjectData('{bad json').ok, false);
    a.equal(loadProjectData({ format: 'other', voices: [{}] }).ok, false);
  });
}, { group: 'state' });

// Console entry point (globalThis === window in browsers; no DOM access).
// 콘솔 진입점 — 브라우저에서 globalThis는 window.
if (typeof globalThis === 'object' && globalThis) {
  globalThis.runSelfCheck = runSelfCheck;
}
