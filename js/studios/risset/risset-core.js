/**
 * Flexatone — studios/risset/risset-core.js
 * Risset Studio (pure): circular phase space S¹, 60-voice document, trajectory shaping and the
 * per-frame runtime step (automation → shaped phase advance → local particles).
 * 리세 스튜디오 (순수): 원형 위상 공간 S¹, 60보이스 문서, 궤적 셰이핑, 프레임 단위 런타임 진행.
 *
 * Phase model / 위상 모델
 *   master phase φ(τ) = wrap(φ₀ + y(τ)),   voice phase pᵢ = wrap(φ + offᵢ / span)
 *   frequency fᵢ = midiToFreq(base + pᵢ·span)
 * Trajectory shaping (invariant: v = 0 ⇒ y ≡ 0 for every shape) / 셰이핑 (불변: v = 0이면 y ≡ 0)
 *   y(τ) = v · F(τ),  F(0) = 0,  F(kP) = kP  (same mean speed v; shape only redistributes it)
 *   linear     F = τ
 *   cosine     F = P·(⌊u⌋ + ½(1 − cos π·{u}))          u = τ/P  (eased glides, rests at cycle ends)
 *   sine       F = τ + A·P/(2π)·sin 2πu                 (speed surges v·(1 + A cos 2πu))
 *   polynomial F = P·(⌊u⌋ + {u}^k)                       (accelerating k > 1 / decelerating k < 1)
 *   engine     F = P·(⌊u⌋ + E({u}))                     (E = any curve engine with E(0)=0, E(1)=1)
 *   Live playback integrates dφ = v_eff(τ)·F′(τ)·dτ, so automation of v composes with the shape.
 * Region modules & space rotation (space-regions.js): what sounds is rt.slots — the points where
 * the green line crosses each module's (rotated) trail space. One full-range linked un-rotated
 * module = the classic field (slot i = voice i). / 발음은 rt.slots (모듈별 회전 공간과 초록 선의 교차점).
 * No DOM. Imports core/*, modules/*, risset/* pure siblings.
 */

import { clamp, roundTo, deepClone } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { createDefaultCurveParams } from '../../core/state.js';
import { createDefaultTremolo, normalizeTremolo } from '../../core/tremolo-config.js';
import { createDefaultVoiceMod, normalizeVoiceMod, voiceModFrame } from '../../core/voice-mod.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { compensationForCount } from '../../modules/gain-bus.js';
import { computeOffsets, GRID_MODES } from './harmony-grid.js';
import { evalGlobalEnvelope, envelopeSlope, EQ_PRESETS, sanitizeEqNode, ENV_SHAPES, MAX_EQ_NODES } from './peq-envelope.js';
import { initVoiceParticles, stepLocalParticles, LOCAL_MODES, FADE_DISTS, MIN_M0 } from './local-particles.js';
import { AUTOMATABLE_PARAMS, computeEffective, createLane, normalizeLane, AUTO_LOOP_RANGE } from './loop-automation.js';
import { createDefaultRegion, sanitizeRegions, isClassicField, createRegionState, stepRegionRotation, regionCrossings, assignSlots, edgeFade } from './space-regions.js';
import { createSignalState, defineStage, runStages } from './signal-graph.js';
import { analyzeColor, createColorState, createDefaultColorCtl, sanitizeColorCtl, stepColorController, pushColorHistory } from './color-analysis.js';
import { RissetVoiceBank } from './risset-voicebank.js';
import { createDefaultDynamics, sanitizeDynamics, isDynamicsOn, createDynState, resetDynState, stepDynamics, relaxStatic, seededUniform, DYN_RATE } from './dynamics.js';
import { criticalBandwidth } from './color-analysis.js';

export const MIN_VOICES = 2;
export const MAX_VOICES = 60;
export const SHAPE_KINDS = Object.freeze(['linear', 'cosine', 'sine', 'polynomial', 'engine']);
/** Curve engines usable as a trajectory shape (all with E(0)=0, E(1)=1). / 셰이핑용 엔진 */
export const SHAPE_ENGINES = Object.freeze(['harmonic', 'anticipation', 'ratchet', 'bezier', 'plateau', 'expo', 'trig']);
/** Live/offline output trim: 1/√N compensation × this. / 출력 트림 */
export const OUTPUT_TRIM = 0.65;
/** Base MIDI range: −49 ≈ 0.5 Hz (rhythm band) … 96 (A-3). / 기준 MIDI 범위 */
export const BASE_MIDI_RANGE = Object.freeze([-49, 96]);
/** Span range in semitones (non-octave / polyrhythmic cycles may be < 12, A-2/A-3). / 스팬 범위 */
export const SPAN_RANGE = Object.freeze([1, 144]);

export const wrap01 = (x) => ((x % 1) + 1) % 1;
export { MAX_REGIONS, MAX_SLOTS, createDefaultRegion } from './space-regions.js';

export function voiceColor(i) {
  return `hsl(${Math.round((i * 360) / MAX_VOICES) % 360}, 85%, 64%)`;
}

/** Default Risset document (stored in appState.studioParams.risset). / 기본 리세 문서 */
export function createDefaultRissetParams() {
  const doc = {
    rateHz: 0.03,
    lastNonZeroRate: 0.03,
    voiceCount: 8,
    spanSemitones: 96,
    baseMidi: 24,
    masterGain: 0.75,
    // Trajectory shaping / 궤적 셰이핑
    shapeKind: 'linear',
    shapePeriodSec: 4,
    shapeAmount: 0.6,
    shapePower: 2,
    shapeEngine: { ...createDefaultCurveParams(), engine: 'harmonic' },
    // Harmonic offset grid / 화성 오프셋 격자
    gridMode: 'equal',
    ratioText: '3:2', // ratio grid (A-2): p:q list / 비율 격자
    fixedStep: 12,
    patternText: 'G2, B2, D3, F#3',
    patternIntervalMode: false,
    pitchText: '', // last typed pitch list (keeps the user's spelling) / 마지막 입력 피치 목록
    offsets: [],
    // Local Emergence (default Bypass: only the Global Envelope is active) / 기본 바이패스
    localMode: 'bypass',
    localRateHz: 0.35,
    localThreshold: 0.15,
    fadeMeanMs: 1500,
    fadeDevMs: 500,
    bandMin: 0,
    bandMax: 1,
    // Particles 2.0 (A-4) / 입자 2.0
    fadeCurve: 0, // S-curve curvature κ (0 = cosine)
    fadeDist: 'uniform', // 'uniform' | 'normal' | 'lognormal'
    bandMinHz: 0, // frequency band mask (0/0 = off) / 주파수 대역 마스크
    bandMaxHz: 0,
    massM0: 0.05, // inertial base mass m₀ > 0 / 기본 관성 질량
    buoyancy: 0, // β: buoyancy gain / 부력 이득
    // Interaction dynamics (A-5; order 'off' = rigid grid) / 상호작용 동역학
    dyn: createDefaultDynamics(),
    // Global Envelope (Bell-Pass default) & PEQ / 전역 포락선 & PEQ
    globalEnvEnabled: true,
    envShape: 'bellpass',
    envCenter: 0.5,
    envWidth: 0.24,
    envSkew: 0, // σ_left = σ(1 − skew), σ_right = σ(1 + skew) (A-2)
    envGamma: 4, // Bell-Pass kurtosis exponent γ: 1/(1 + |d|^γ) (A-2)
    spectralTilt: 0, // dB/oct re 1 kHz (A-2 colour control) / 음색 기울기
    // Rhythm ↔ tone continuum (A-3) / 리듬 ↔ 톤 연속체
    waveMorph: 0, // 0 = sine … 1 = band-limited pulse (PolyBLEP)
    waveDuty: 0.5,
    oscSyncHz: 0, // Kuramoto coupling K on oscillator phases: > 0 sync, < 0 disperse
    flutterDb: 0, // gain of the 12–30 Hz flutter-band envelope (dB)
    colorCtl: createDefaultColorCtl(),
    eqNodes: EQ_PRESETS.flat(),
    // Looping automation / 루핑 오토메이션
    autoLoopSec: 8,
    activeAutoKey: 'rateHz',
    autoLanes: {
      rateHz: createLane(0.75, false),
      envCenter: createLane(0.65, false),
      envWidth: createLane(0.6, false),
    },
    // Region modules (pitch range + own speed + space rotation) / 영역 모듈 (범위·속도·공간 회전)
    regions: [createDefaultRegion({ id: 'r0' })],
    activeRegion: 0,
    // Audio engine: 'auto' = AudioWorklet when available, else oscillators / 오디오 엔진
    engineMode: 'auto',
    tremolo: createDefaultTremolo(), // studio-level output tremolo (LFO backend); audio-only / 스튜디오 출력 트레몰로
    voiceMod: createDefaultVoiceMod(), // per-voice tremolo + vibrato with randomizer (core/voice-mod.js) / 보이스별 트레몰로·비브라토
    // Export / bake / 내보내기
    exportSec: 15,
    bakeSec: 8,
    // View / 보기
    view: { viewMode: 'piano', showTrails: true, showMaskBand: true, timeWindowSec: 16, offsetsExpanded: false },
  };
  doc.offsets = computeOffsets(doc);
  return doc;
}

/** Clamp/repair a document read from a project or the prototype's JSON. / 문서 정규화 */
export function sanitizeRissetParams(raw) {
  const d = createDefaultRissetParams();
  const p = { ...d, ...deepClone(raw || {}) };
  p.voiceCount = clamp(Math.round(Number(p.voiceCount) || 8), MIN_VOICES, MAX_VOICES);
  p.rateHz = clamp(Number(p.rateHz) || 0, -1, 1);
  // Span may be non-integer (stretched / non-octave cycles, A-2). / 비정수 스팬 허용
  p.spanSemitones = clamp(Math.round((Number(p.spanSemitones) || 96) * 10000) / 10000, SPAN_RANGE[0], SPAN_RANGE[1]);
  p.ratioText = typeof p.ratioText === 'string' && p.ratioText.trim() ? p.ratioText : d.ratioText;
  p.envSkew = clamp(Number(p.envSkew) || 0, -0.9, 0.9);
  p.envGamma = clamp(Number(p.envGamma) || 4, 0.5, 12);
  p.spectralTilt = clamp(Number(p.spectralTilt) || 0, -12, 12);
  p.colorCtl = sanitizeColorCtl(p.colorCtl);
  // Base pitch reaches down into the rhythm band (MIDI −49 ≈ 0.5 Hz, A-3); 0.01 st resolution.
  // 기준 음고는 리듬 대역(≈0.5 Hz)까지 내려감.
  p.baseMidi = clamp(Math.round((Number.isFinite(Number(p.baseMidi)) ? Number(p.baseMidi) : 24) * 100) / 100, BASE_MIDI_RANGE[0], BASE_MIDI_RANGE[1]);
  p.waveMorph = clamp(Number(p.waveMorph) || 0, 0, 1);
  p.waveDuty = clamp(Number(p.waveDuty) || 0.5, 0.05, 0.95);
  p.oscSyncHz = clamp(Number(p.oscSyncHz) || 0, -40, 40);
  p.flutterDb = clamp(Number(p.flutterDb) || 0, -36, 12);
  p.masterGain = clamp(Number(p.masterGain) || 0, 0, 1.5);
  if (!SHAPE_KINDS.includes(p.shapeKind)) p.shapeKind = 'linear';
  p.shapePeriodSec = clamp(Number(p.shapePeriodSec) || 4, 0.25, 120);
  p.shapeAmount = clamp(Number(p.shapeAmount) || 0, 0, 1);
  p.shapePower = clamp(Number(p.shapePower) || 2, 0.25, 6);
  p.shapeEngine = { ...d.shapeEngine, ...(p.shapeEngine || {}) };
  if (!SHAPE_ENGINES.includes(p.shapeEngine.engine)) p.shapeEngine.engine = 'harmonic';
  if (!GRID_MODES.includes(p.gridMode)) p.gridMode = 'equal';
  if (!LOCAL_MODES.includes(p.localMode)) p.localMode = 'bypass';
  p.fadeCurve = clamp(Number(p.fadeCurve) || 0, -0.95, 0.95);
  if (!FADE_DISTS.includes(p.fadeDist)) p.fadeDist = 'uniform';
  p.bandMinHz = clamp(Number(p.bandMinHz) || 0, 0, 20000);
  p.bandMaxHz = clamp(Number(p.bandMaxHz) || 0, 0, 20000);
  p.massM0 = clamp(Number.isFinite(Number(p.massM0)) ? Number(p.massM0) : 0.05, MIN_M0, 10);
  p.buoyancy = clamp(Number(p.buoyancy) || 0, -2, 2);
  p.dyn = sanitizeDynamics(p.dyn);
  if (!ENV_SHAPES.includes(p.envShape)) p.envShape = 'bellpass';
  p.envWidth = clamp(Number(p.envWidth) || 0.24, 0.02, 1);
  p.envCenter = clamp(Number(p.envCenter) || 0.5, 0.05, 0.95);
  p.eqNodes = (Array.isArray(p.eqNodes) && p.eqNodes.length ? p.eqNodes : d.eqNodes).slice(0, MAX_EQ_NODES).map(sanitizeEqNode);
  p.autoLoopSec = clamp(Number(p.autoLoopSec) || 8, AUTO_LOOP_RANGE[0], AUTO_LOOP_RANGE[1]);
  const lanes = {};
  for (const spec of AUTOMATABLE_PARAMS) if (p.autoLanes?.[spec.key]) lanes[spec.key] = normalizeLane(p.autoLanes[spec.key]);
  p.autoLanes = lanes;
  if (!AUTOMATABLE_PARAMS.some((s) => s.key === p.activeAutoKey)) p.activeAutoKey = 'rateHz';
  p.view = { ...d.view, ...(p.view || {}) };
  if (!['auto', 'oscillators'].includes(p.engineMode)) p.engineMode = 'auto';
  p.tremolo = normalizeTremolo(p.tremolo);
  p.voiceMod = normalizeVoiceMod(p.voiceMod);
  p.regions = sanitizeRegions(p.regions);
  for (const r of p.regions) { const own = sanitizeRegionOwn(r.own); if (Object.keys(own).length) r.own = own; else delete r.own; }
  p.activeRegion = clamp(Math.round(Number(p.activeRegion) || 0), 0, p.regions.length - 1);
  p.offsets = computeOffsets(p);
  return p;
}

// --------------------------------------------------------------------------
// Phase space / 위상 공간
// --------------------------------------------------------------------------

export function voiceOffset(params, i) {
  const off = params.offsets?.[i];
  return off !== undefined ? Number(off) : (i * params.spanSemitones) / params.voiceCount;
}

export function computeVoicePhase(params, phi, i) {
  return wrap01(phi + voiceOffset(params, i) / Math.max(1, params.spanSemitones));
}

export function phaseToMidi(params, p) {
  return params.baseMidi + p * params.spanSemitones;
}

export function phaseToFreq(params, p) {
  return midiToFreq(phaseToMidi(params, p));
}

/** Global-envelope parameters with (automated) center/width. / 전역 포락선 파라미터 */
export function envOf(params, eff = params) {
  return { enabled: params.globalEnvEnabled, shape: params.envShape, center: eff.envCenter, width: eff.envWidth, skew: eff.envSkew ?? params.envSkew ?? 0, gamma: params.envGamma ?? 4 };
}

/** Output scale = masterGain · 1/√N · trim (gain-bus equal-power rule). / 출력 스케일 */
export function outputScale(params, eff = params) {
  return eff.masterGain * compensationForCount(params.voiceCount, 'equalPower') * OUTPUT_TRIM;
}

// --------------------------------------------------------------------------
// Trajectory shaping / 궤적 셰이핑
// --------------------------------------------------------------------------

function shapeUnit(params, frac, eff = params) {
  switch (params.shapeKind) {
    case 'cosine': return 0.5 * (1 - Math.cos(Math.PI * frac));
    case 'polynomial': return Math.pow(frac, params.shapePower);
    case 'engine': return evaluateCurveObjectY({ ...params.shapeEngine, reverse: false, inverse: false }, frac);
    default: return frac;
  }
}

/**
 * Shaped time F(τ) (seconds). Linear → τ. Always F(0) = 0 and F(kP) = kP.
 * 셰이핑된 시간 F(τ). 항상 F(0)=0, F(kP)=kP.
 */
export function shapedTime(params, tau, eff = params) {
  const P = params.shapePeriodSec;
  if (params.shapeKind === 'linear') return tau;
  if (params.shapeKind === 'sine') return tau + ((eff.shapeAmount ?? params.shapeAmount) * P) / (2 * Math.PI) * Math.sin((2 * Math.PI * tau) / P);
  const u = tau / P;
  const k = Math.floor(u);
  return P * (k + shapeUnit(params, u - k, eff));
}

/** Trajectory displacement y(τ) = v·F(τ) — identically 0 when v = 0. / 궤적 변위 */
export function trajectoryDisplacement(params, tau, v = params.rateHz, eff = params) {
  if (Math.abs(v) < 1e-12) return 0;
  return v * shapedTime(params, tau, eff);
}

/** Instantaneous shape speed F′(τ) (dimensionless, mean 1). / 순간 셰이프 속도 */
export function shapeSpeed(params, tau, eff = params) {
  if (params.shapeKind === 'linear') return 1;
  const h = Math.min(1e-3, params.shapePeriodSec * 1e-3);
  return (shapedTime(params, tau + h, eff) - shapedTime(params, tau - h, eff)) / (2 * h);
}

// --------------------------------------------------------------------------
// Runtime (never saved) / 런타임 (저장 안 함)
// --------------------------------------------------------------------------

/** Fresh runtime: master phase, clocks, particles, effective params. / 새 런타임 */
export function createRissetRuntime(params, rng = Math.random) {
  const rt = {
    masterPhase: 0,
    autoTimeSec: 0,
    shapeTimeSec: 0,
    eff: computeEffective(params, 0),
    particles: initVoiceParticles(null, params.voiceCount, params, rng),
    sig: null,
    phases: null, // alias of sig.phase (kept for older callers) / sig.phase 별칭
    regionStates: {}, // region id → { phase, shapeTimeSec, spinDeg, swingTimeSec, angleDeg, v }
    slots: [], // sounding points on the green line / 초록 선 위 발음점
    classic: true,
    frameVel: 0,
    color: createColorState(),
    partF: new Float64Array(1024),
    partA: new Float64Array(1024),
    dyn: createDynState(MAX_VOICES, params.dyn?.seed || 1),
    dynKey: '',
    dynBake: null, // { data: Float32Array, N, steps } — pre-integrated x (export / bake) / 사전 적분 배열
    dynClock: 0,
  };
  rt.sig = createSignalState(MAX_VOICES);
  rt.phases = rt.sig.phase;
  return rt;
}

/** Deep copy of a runtime (offline render starts from the live state). / 런타임 복제 */
export function cloneRuntime(rt) {
  const regionStates = {};
  for (const [k, v] of Object.entries(rt.regionStates || {})) regionStates[k] = { ...v };
  const sig = createSignalState(MAX_VOICES);
  for (const k of ['phase', 'vel', 'amp', 'ampGlobal', 'aLocal', 'mass', 'buoy']) sig[k].set(rt.sig[k]);
  sig.N = rt.sig.N;
  return {
    ...rt,
    eff: { ...rt.eff },
    particles: rt.particles.map((p) => ({ ...p })),
    sig,
    phases: sig.phase,
    regionStates,
    slots: (rt.slots || []).map((sl) => ({ ...sl })),
    color: { ...createColorState(), integ: rt.color?.integ ?? 0, out: rt.color?.out ? { ...rt.color.out } : null },
    dyn: rt.dyn ? { ...rt.dyn, x: new Float64Array(rt.dyn.x), u: new Float64Array(rt.dyn.u), grid: new Float64Array(rt.dyn.grid), hist: new Float64Array(rt.dyn.hist) } : createDynState(MAX_VOICES),
    partF: new Float64Array(1024),
    partA: new Float64Array(1024),
  };
}

/** Region runtime state (created on first use). / 영역 상태 */
export function regionState(rt, region) {
  if (!rt.regionStates[region.id]) rt.regionStates[region.id] = { ...createRegionState(), phase: rt.masterPhase, shapeTimeSec: rt.shapeTimeSec, v: 0 };
  return rt.regionStates[region.id];
}

/**
 * Unwrapped phase of a region at relative time τ (current speed, shaped):
 * φᵣ(τ) = φᵣ + v·(F(T₀ + τ) − F(T₀)). / 영역 위상 함수
 */
export function regionPhiFn(params, rt, region) {
  const st = regionState(rt, region);
  const v = st.v;
  if (Math.abs(v) < 1e-12) return () => st.phase;
  if (params.shapeKind === 'linear') return (tau) => st.phase + v * tau;
  const F0 = shapedTime(params, st.shapeTimeSec, rt.eff);
  return (tau) => st.phase + v * (shapedTime(params, st.shapeTimeSec + tau, rt.eff) - F0);
}

/** Current voice positions relative to the frame: dynamics xᵢ when on, else offᵢ/span. / 상대 위치 */
export function relOffsets(params, rt) {
  if (!rt || !isDynamicsOn(params.dyn) || rt.dyn.N !== params.voiceCount) return phaseOffsets(params);
  const out = new Float64Array(params.voiceCount);
  for (let i = 0; i < params.voiceCount; i++) out[i] = rt.dyn.x[i];
  return out;
}

/** Voice offsets as phase (offᵢ / span). / 위상 단위 오프셋 */
export function phaseOffsets(params) {
  const span = Math.max(1, params.spanSemitones);
  const out = new Float64Array(params.voiceCount);
  for (let i = 0; i < params.voiceCount; i++) out[i] = voiceOffset(params, i) / span;
  return out;
}

// --------------------------------------------------------------------------
// Region overrides (region.own) — the toolboxes act on the selected region / 영역별 덮어쓰기
// A region may keep its own value of these document fields; everything else is shared. Speed is the
// region's existing rateHz / linkRate (the Core "Glissando rate" edits it while a region is selected).
// 영역은 아래 필드를 자기 값으로 가질 수 있음. 속도는 기존 rateHz / linkRate (영역 선택 중 코어 "글리산도 속도"가 편집).
// --------------------------------------------------------------------------

export const REGION_OWN_KEYS = Object.freeze([
  'voiceCount',
  'globalEnvEnabled', 'envShape', 'envCenter', 'envWidth', 'envSkew', 'envGamma',
  'shapeKind', 'shapePeriodSec', 'shapeAmount', 'shapePower',
]);
const OWN_ENV_KEYS = ['globalEnvEnabled', 'envShape', 'envCenter', 'envWidth', 'envSkew', 'envGamma'];

/** Keep only known keys with values of the right kind. / 알려진 키만 유지 */
export function sanitizeRegionOwn(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of REGION_OWN_KEYS) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (k === 'globalEnvEnabled') out[k] = v !== false;
    else if (k === 'envShape' || k === 'shapeKind') { if (typeof v === 'string' && v) out[k] = v; }
    else if (Number.isFinite(Number(v))) out[k] = Number(v);
  }
  if ('voiceCount' in out) out.voiceCount = clamp(Math.round(out.voiceCount), MIN_VOICES, MAX_VOICES);
  return out;
}

/** Evenly spaced voice offsets (semitones) for a document's voice count. / 균등 보이스 오프셋 */
export function evenOffsets(params) {
  const n = Math.max(1, params.voiceCount);
  return Array.from({ length: n }, (_, i) => (i * params.spanSemitones) / n);
}

export const hasRegionOwn = (r) => !!(r && r.own && Object.keys(r.own).length);

/**
 * The document as one region sees it: shared fields + its own ones. A region with its own voice count
 * spaces its voices evenly (offsets of the shared grid are for the shared count).
 * 한 영역이 보는 문서: 공유 필드 + 자기 필드. 자기 보이스 수가 있으면 균등 간격.
 */
export function regionParams(params, r) {
  if (!hasRegionOwn(r)) return params;
  const q = { ...params, ...r.own };
  if ('voiceCount' in r.own && r.own.voiceCount !== params.voiceCount) q.offsets = evenOffsets(q);
  return q;
}

/** Effective (automated) values of a region: its own envelope / shape fields win over the lanes. */
function regionEff(eff, r) {
  if (!hasRegionOwn(r)) return eff;
  const e = { ...eff };
  for (const k of ['envCenter', 'envWidth', 'envSkew', 'shapeAmount']) if (k in r.own) e[k] = r.own[k];
  return e;
}

function stepRegions(params, rt, dt, scrubbing) {
  const regions = params.regions || [];
  const anyOwn = regions.some(hasRegionOwn);
  rt.classic = isClassicField(regions) && !anyOwn;
  // A region with its own envelope: the envelope goes into each point's gain and the bank's shared
  // envelope is switched off (frame env.enabled = false) / 영역별 포락선은 점 이득에 넣고 뱅크 공용 포락선은 끔
  rt.envInGain = anyOwn && regions.some((r) => hasRegionOwn(r) && OWN_ENV_KEYS.some((k) => k in r.own));
  const N = params.voiceCount;
  if (rt.classic) {
    // Classic field: slot i = voice i, always sounding / 기존 음장
    const st = regionState(rt, regions[0]);
    Object.assign(st, { phase: rt.masterPhase, shapeTimeSec: rt.shapeTimeSec, v: rt.eff.rateHz, angleDeg: 0 });
    if (rt.slots.length !== N) rt.slots = Array.from({ length: N }, (_, i) => ({ active: true, region: 0, voice: i, s: 0, amp: 0, gain: 0, vel: 0, idle: 0, fresh: rt.slots[i] === undefined, matched: true }));
    const sig = rt.sig;
    for (let i = 0; i < N; i++) {
      const sl = rt.slots[i];
      sl.active = true;
      sl.region = 0;
      sl.voice = i;
      sl.s = sig.phase[i];
      sl.vel = sig.vel[i];
      sl.amp = sig.amp[i];
      sl.gain = sig.aLocal[i];
    }
    return;
  }
  const offs = relOffsets(params, rt);
  const env = envOf(params, rt.eff);
  const points = [];
  const live = new Set();
  regions.forEach((r, ri) => {
    const st = regionState(rt, r);
    live.add(r.id);
    const own = hasRegionOwn(r);
    const pr = own ? regionParams(params, r) : params; // this region's view of the document / 이 영역이 보는 문서
    const er = own ? regionEff(rt.eff, r) : rt.eff;
    if (r.linkRate) {
      st.phase = rt.masterPhase;
      st.shapeTimeSec = rt.shapeTimeSec;
      st.v = rt.eff.rateHz;
    } else {
      st.v = r.rateHz;
      if (!scrubbing && Math.abs(st.v) > 1e-6) {
        st.phase = wrap01(st.phase + st.v * shapeSpeed(pr, st.shapeTimeSec, er) * dt);
        st.shapeTimeSec += dt;
      }
    }
    stepRegionRotation(r, st, dt);
    if (!r.enabled || r.gain <= 0) return;
    const Nr = pr.voiceCount;
    const offsR = pr === params || Nr === N ? offs : phaseOffsets(pr);
    const envR = own ? envOf(pr, er) : env;
    const pts = regionCrossings(r, st.angleDeg, regionPhiFn(pr, rt, r), offsR, Nr);
    // Un-rotated points move with the region speed (+ dynamics drift); rotated ones get a finite difference.
    // 회전 없는 점은 영역 속도(+동역학)로, 회전된 점은 차분으로 속도 추정.
    const rotated = Math.abs(((st.angleDeg % 360) + 360) % 360) > 1e-9;
    const vReg = st.v * (Math.abs(st.v) > 1e-12 ? shapeSpeed(pr, st.shapeTimeSec, er) : 0);
    for (const pt of pts) {
      const shared = pt.voice < N; // voices beyond the shared count have no local-particle / dynamics state / 공유 수 밖의 보이스
      let gain = (shared ? rt.sig.aLocal[pt.voice] : 1) * r.gain * edgeFade(r, pt.s);
      const envA = evalGlobalEnvelope(envR, pt.s);
      if (rt.envInGain) gain *= envA;
      const amp = (rt.envInGain ? 1 : envA) * gain;
      points.push({ region: ri, voice: pt.voice, s: pt.s, amp, gain, vel: rotated ? undefined : vReg + (shared ? rt.sig.vel[pt.voice] - rt.frameVel : 0) });
    }
  });
  for (const k of Object.keys(rt.regionStates)) if (!live.has(k)) delete rt.regionStates[k];
  assignSlots(rt.slots, points, dt);
}

// --------------------------------------------------------------------------
// Signal-graph stages (signal-graph.js contract) / 신호 그래프 단계
//   phaseCore → grid → envelope → local → dynamics → output
// --------------------------------------------------------------------------

/** 1. Phase core: automation clock → effective params → shaped master phase φ. / 위상 코어 */
const STAGE_PHASE = defineStage('phaseCore', (st, dt) => {
  const { params, rt, running, scrubbing } = st.ctx;
  if (running || Math.abs(params.rateHz) > 1e-5) rt.autoTimeSec += dt;
  rt.eff = computeEffective(params, rt.autoTimeSec, params.colorCtl.enabled ? rt.color.out : null);
  const v = rt.eff.rateHz;
  rt.frameVel = 0;
  if (!scrubbing && Math.abs(v) > 1e-6) {
    rt.frameVel = v * shapeSpeed(params, rt.shapeTimeSec, rt.eff);
    rt.masterPhase = wrap01(rt.masterPhase + rt.frameVel * dt);
    rt.shapeTimeSec += dt;
  }
});

/** 2. Harmonic grid: pᵢ = wrap(φ + offᵢ/span), ṗᵢ = frame speed. / 화성 격자 */
const STAGE_GRID = defineStage('grid', (st) => {
  const { params, rt } = st.ctx;
  st.N = params.voiceCount;
  // With dynamics on, the grid only seeds xᵢ; the current positions come from the last step.
  // 동역학이 켜지면 격자는 초기 위치만, 현재 위치는 직전 스텝의 xᵢ.
  const dynX = isDynamicsOn(params.dyn) && rt.dyn.N === st.N ? rt.dyn.x : null;
  for (let i = 0; i < st.N; i++) {
    st.phase[i] = dynX ? wrap01(rt.masterPhase + dynX[i]) : computeVoicePhase(params, rt.masterPhase, i);
    st.vel[i] = rt.frameVel + (dynX ? rt.dyn.u[i] : 0);
  }
});

/** 3. Global envelope A_global(pᵢ). / 전역 포락선 */
const STAGE_ENVELOPE = defineStage('envelope', (st) => {
  const { params, rt } = st.ctx;
  const env = envOf(params, rt.eff);
  for (let i = 0; i < st.N; i++) st.ampGlobal[i] = evalGlobalEnvelope(env, st.phase[i]);
});

/** 4. Local emergence A_local; amp = A_global·A_local, mass Mᵢ = amp, buoyancy Bᵢ (A-4). / 로컬 명멸·질량·부력 */
const STAGE_LOCAL = defineStage('local', (st, dt) => {
  const { params, rt, rng } = st.ctx;
  if (rt.particles.length !== params.voiceCount) rt.particles = initVoiceParticles(rt.particles, params.voiceCount, params, rng);
  let freqs = null;
  if (params.bandMaxHz > params.bandMinHz) {
    freqs = rt.freqScratch || (rt.freqScratch = new Float64Array(MAX_VOICES));
    for (let i = 0; i < st.N; i++) freqs[i] = phaseToFreq(params, st.phase[i]);
  }
  stepLocalParticles(rt.particles, params, rt.eff, st.phase, dt, rng, freqs);
  const env = envOf(params, rt.eff);
  const beta = params.buoyancy;
  for (let i = 0; i < st.N; i++) {
    st.aLocal[i] = rt.particles[i]?.aLocal ?? 1;
    st.amp[i] = st.ampGlobal[i] * st.aLocal[i];
    // A-4: gravitational mass M = A_global·A_local; buoyancy B = β·A_local·|∂A_global/∂p| (a lift:
    // always upward, strongest on the envelope flanks; with gravity −g·M it drives a convection cycle)
    st.mass[i] = st.amp[i];
    st.buoy[i] = beta ? beta * st.aLocal[i] * Math.abs(envelopeSlope(env, st.phase[i])) : 0;
  }
});

/** Critical-band width per voice in phase units (for the repulsion term). / 임계 대역 폭 (위상 단위) */
function cbWidths(params, st, out) {
  for (let i = 0; i < st.N; i++) {
    const f = Math.max(1, phaseToFreq(params, st.phase[i]));
    out[i] = (12 * Math.log2((f + criticalBandwidth(f)) / f)) / Math.max(1, params.spanSemitones);
  }
  return out;
}

/**
 * 5. Dynamics (A-5): positions xᵢ relative to the rotating frame φ (v₀ = v). Live: integrated in
 * real time (never baked). Export / bake: read from a pre-integrated array (rt.dynBake).
 * 동역학: 실시간은 적분, 내보내기·베이킹은 사전 적분 배열 사용.
 */
const STAGE_DYNAMICS = defineStage('dynamics', (st, dt) => {
  const { params, rt } = st.ctx;
  const d = params.dyn;
  if (!isDynamicsOn(d)) { rt.dyn.N = 0; return; }
  const ds = rt.dyn;
  const N = st.N;
  const grid = phaseOffsets(params);
  const key = `${N}|${Array.from(grid).map((g) => g.toFixed(6)).join(',')}`;
  if (rt.dynKey !== key || ds.N !== N) { resetDynState(ds, grid, N); rt.dynKey = key; ds.staticKey = ''; }
  const env = { mass: st.mass, buoy: st.buoy, grid: ds.grid, cbw: cbWidths(params, st, rt.cbwScratch || (rt.cbwScratch = new Float64Array(MAX_VOICES))) };
  if (rt.dynBake) {
    const b = rt.dynBake;
    const pos = Math.min(b.steps, rt.dynClock * DYN_RATE);
    const k0 = Math.floor(pos);
    const k1 = Math.min(b.steps, k0 + 1);
    const fr = pos - k0;
    for (let i = 0; i < N; i++) {
      const x0 = b.data[k0 * b.N + i];
      const x1 = b.data[k1 * b.N + i];
      const nx = x0 + (x1 - x0) * fr;
      ds.u[i] = dt > 0 ? (nx - ds.x[i]) / dt : ds.u[i];
      ds.x[i] = nx;
    }
    rt.dynClock += dt;
  } else if (d.order === 'static') {
    const sk = `${key}|${JSON.stringify(d)}|${params.massM0}`;
    if (ds.staticKey !== sk) { resetDynState(ds, grid, N); relaxStatic(d, ds, env, params.massM0); ds.staticKey = sk; }
  } else {
    stepDynamics(d, ds, env, params.massM0, dt);
  }
  // pᵢ = wrap(φ + xᵢ), ṗᵢ = frame speed + ẋᵢ; refresh the amplitudes for the moved phases
  const genv = envOf(params, rt.eff);
  for (let i = 0; i < N; i++) {
    st.phase[i] = wrap01(rt.masterPhase + ds.x[i]);
    st.vel[i] = rt.frameVel + ds.u[i];
    st.ampGlobal[i] = evalGlobalEnvelope(genv, st.phase[i]);
    st.amp[i] = st.ampGlobal[i] * st.aLocal[i];
    st.mass[i] = st.amp[i];
  }
});

// --------------------------------------------------------------------------
// Edit-time dynamics bake (deterministic, cached by physics signature) / 편집 시점 베이킹
// --------------------------------------------------------------------------

const DYN_CACHE = new Map(); // signature → { data, N, steps }
let dynBakeCount = 0;
export const getDynBakeCount = () => dynBakeCount;

/** Physics signature: every field that changes the trajectories (no view / export settings). */
export function dynSignature(params) {
  const { view, exportSec, bakeSec, activeRegion, activeAutoKey, engineMode, eqNodes, masterGain, pitchText, tremolo, voiceMod, ...rest } = params;
  return JSON.stringify(rest);
}

/**
 * Pre-integrate xᵢ(t) for `seconds` at 100 Hz from the grid with a seeded RNG (deterministic), or
 * reuse a cached bake with the same signature that is long enough.
 * 격자에서 결정적으로 사전 적분 (같은 시그니처면 캐시 재사용).
 */
export function bakeDynamics(params, seconds) {
  const sig = dynSignature(params);
  const hit = DYN_CACHE.get(sig);
  const steps = Math.ceil(seconds * DYN_RATE) + 2;
  if (hit && hit.steps >= steps) return hit;
  dynBakeCount++;
  const rng = seededUniform(params.dyn.seed * 104729 + 3);
  const rt = createRissetRuntime(params, rng);
  const N = params.voiceCount;
  const data = new Float32Array((steps + 1) * N);
  const dt = 1 / DYN_RATE;
  for (let k = 0; k <= steps; k++) {
    stepRuntime(params, rt, k === 0 ? 0 : dt, { running: true, rng });
    for (let i = 0; i < N; i++) data[k * N + i] = rt.dyn.x[i];
  }
  const out = { data, N, steps };
  DYN_CACHE.set(sig, out);
  if (DYN_CACHE.size > 8) DYN_CACHE.delete(DYN_CACHE.keys().next().value);
  return out;
}

/**
 * Runtime for a reproducible render/bake: fresh, seeded, reading the pre-integrated dynamics
 * (only when dynamics are on; otherwise null → callers keep their usual runtime).
 * 재현 가능한 렌더용 런타임 (동역학이 켜진 경우).
 */
export function createBakedRuntime(params, seconds) {
  if (!isDynamicsOn(params.dyn)) return null;
  const bake = bakeDynamics(params, seconds);
  const rt = createRissetRuntime(params, seededUniform(params.dyn.seed * 104729 + 3));
  rt.dynBake = bake;
  rt.dynClock = 0;
  return rt;
}

/** 6. Output: region modules / rotation → sounding slots. / 출력: 영역·회전 → 발음 슬롯 */
const STAGE_OUTPUT = defineStage('output', (st, dt) => {
  const { params, rt, scrubbing } = st.ctx;
  stepRegions(params, rt, dt, scrubbing);
});

/** Partials (f, a) actually sounding: slot pitch × A × frequency weight. / 발음 부분음 */
export function collectPartials(params, rt) {
  const weight = weightOf(params, rt.eff);
  const useW = !!(weight.tilt || weight.flutterDb);
  let n = 0;
  for (const sl of rt.slots) {
    if (!sl.active || !(sl.amp > 1e-6) || n >= rt.partF.length) continue;
    const f = phaseToFreq(params, sl.s);
    const a = sl.amp * (useW ? RissetVoiceBank.freqWeight(weight, f) : 1);
    rt.partF[n] = f;
    rt.partA[n] = a;
    n++;
    n = addWaveHarmonics(params, rt, f, a, n);
  }
  return n;
}

/** Harmonics of the pulse waveform (A-3) for the colour analysis. / 펄스 배음 */
function addWaveHarmonics(params, rt, f, a, n) {
  const m = Number(params.waveMorph) || 0;
  if (!(m > 0)) return n;
  const d = Number(params.waveDuty) || 0.5;
  // Bipolar pulse with duty d: |cₖ| = (4/(πk))·|sin(πkd)|·0.8, mixed with the sine by `m`.
  for (let k = 2; k <= 8 && n < rt.partF.length; k++) {
    const fk = f * k;
    if (fk > 16000) break;
    const ak = a * m * 0.8 * (4 / (Math.PI * k)) * Math.abs(Math.sin(Math.PI * k * d)) * 0.5;
    if (ak < 1e-5) continue;
    rt.partF[n] = fk;
    rt.partA[n] = ak;
    n++;
  }
  return n;
}

/** 7. Analysis: R_total, H, C_spec (~60 Hz) → colour controller. / 분석 → 색채 제어기 */
const STAGE_ANALYSIS = defineStage('analysis', (st, dt) => {
  const { params, rt } = st.ctx;
  const c = rt.color;
  c.tick = (c.tick || 0) + dt;
  if (c.tick < 1 / 60 && dt > 0) return;
  const step = c.tick;
  c.tick = 0;
  const n = collectPartials(params, rt);
  const m = analyzeColor(rt.partF, rt.partA, n);
  pushColorHistory(c, m, step);
  const ctl = params.colorCtl;
  stepColorController(ctl, c, Number(params[ctl.actuator]) || 0, m, step);
});

export const RISSET_STAGES = Object.freeze([STAGE_PHASE, STAGE_GRID, STAGE_ENVELOPE, STAGE_LOCAL, STAGE_DYNAMICS, STAGE_OUTPUT, STAGE_ANALYSIS]);

/**
 * Advance the runtime by dt seconds through the signal graph.
 * `running` = audio on or v ≠ 0 (the automation clock pauses when frozen and silent).
 * 런타임을 dt초 진행 (신호 그래프 순서대로).
 */
export function stepRuntime(params, rt, dt, { running = true, scrubbing = false, rng = Math.random } = {}) {
  const st = rt.sig;
  st.ctx = { params, rt, running, scrubbing, rng };
  runStages(RISSET_STAGES, st, dt);
  st.ctx = null;
  return rt;
}

/** Control frame for RissetVoiceBank (p, ω, g, flags per slot). / 보이스 뱅크 제어 프레임 */
export function buildControlFrame(params, rt, { scale = outputScale(params, rt.eff), into = null } = {}) {
  const n = rt.slots.length;
  const slots = into && into.length >= n * 4 ? into : new Float32Array(Math.max(4, n * 4));
  const ts = Number(rt.timeScale) > 0 ? Number(rt.timeScale) : 1; // Tempo Manager: runtime s → real s / 템포: 런타임 초 → 실제 초
  for (let j = 0; j < n; j++) {
    const sl = rt.slots[j];
    slots[j * 4] = sl.s;
    slots[j * 4 + 1] = sl.active ? (sl.vel || 0) * ts : 0; // ω in cycles per REAL second / 실제 초당 사이클
    slots[j * 4 + 2] = sl.active ? sl.gain ?? sl.amp : 0;
    slots[j * 4 + 3] = (sl.active ? 1 : 0) | (sl.fresh ? 2 : 0);
  }
  const env = envOf(params, rt.eff);
  return {
    n,
    scale,
    base: params.baseMidi,
    span: params.spanSemitones,
    env: { enabled: env.enabled && !rt.envInGain, shape: env.shape, center: env.center, width: env.width, skew: env.skew ?? 0, gamma: env.gamma ?? 4 },
    wave: waveOf(params),
    weight: weightOf(params, rt.eff),
    syncHz: Number(params.oscSyncHz) || 0,
    mod: voiceModFrame(params.voiceMod), // per-voice tremolo / vibrato (null = off) / 보이스별 변조
    slots,
  };
}

/** Waveform morph (A-3; sine by default). / 파형 모핑 */
export function waveOf(params) {
  return { morph: Number(params.waveMorph) || 0, duty: Number(params.waveDuty) || 0.5 };
}

/** Frequency weighting (A-2 tilt, A-3 flutter; flat by default). / 주파수 가중 */
export function weightOf(params, eff = params) {
  return { tilt: Number(eff.spectralTilt ?? params.spectralTilt) || 0, flutterDb: Number(params.flutterDb) || 0 };
}

/** Amplitude of voice i in the current runtime: A_global(p) · A_local. / 보이스 진폭 */
export function voiceAmplitude(params, rt, i) {
  if (rt.sig && i < rt.sig.N) return rt.sig.amp[i];
  const p = rt.phases[i];
  return evalGlobalEnvelope(envOf(params, rt.eff), p) * (rt.particles[i]?.aLocal ?? 1);
}

// --------------------------------------------------------------------------
// Bake to Glissando voices / 글리산도 보이스로 베이킹
// --------------------------------------------------------------------------

/**
 * Simulate `bakeSec` seconds and cut each voice's pitch path at its wrap points (0 ↔ 1).
 * Returns segments { voice, t0, t1, midi: Float64Array, amp: Float64Array } sampled at `rate` Hz.
 * bakeSec초를 시뮬레이션하고 각 보이스를 래핑 지점에서 분할.
 */
export function simulateSegments(params, { bakeSec = params.bakeSec, rate = 100, startPhase = 0, rng = () => 0.5 } = {}) {
  const rt = createBakedRuntime(params, bakeSec + 0.1) || createRissetRuntime(params, rng);
  rt.masterPhase = startPhase;
  const n = Math.max(2, Math.round(bakeSec * rate));
  const dt = bakeSec / n;
  // One open track per slot; a track closes when its slot stops sounding or jumps (wrap).
  // 슬롯마다 열린 트랙 하나 — 슬롯이 멈추거나 (래핑으로) 점프하면 닫힘.
  const open = [];
  const segments = [];
  const close = (j) => {
    const tr = open[j];
    if (tr && tr.midi.length >= 3) segments.push({ voice: tr.voice, t0: tr.t[0], t1: tr.t[tr.t.length - 1], midi: tr.midi, amp: tr.amp });
    open[j] = null;
  };
  for (let k = 0; k <= n; k++) {
    stepRuntime(params, rt, k > 0 ? dt : 0, { running: true, rng });
    rt.slots.forEach((sl, j) => {
      if (!sl.active) { close(j); return; }
      const midi = phaseToMidi(params, sl.s);
      let tr = open[j];
      if (tr && (tr.voice !== sl.voice || Math.abs(midi - tr.midi[tr.midi.length - 1]) > params.spanSemitones * 0.5)) { close(j); tr = null; }
      if (!tr) { tr = { voice: sl.voice, midi: [], amp: [], t: [] }; open[j] = tr; }
      tr.midi.push(midi);
      tr.amp.push(sl.amp);
      tr.t.push(k * dt);
    });
  }
  open.forEach((_, j) => close(j));
  segments.sort((a, b) => a.voice - b.voice || a.t0 - b.t0);
  return segments;
}

/** Segments → Glissando voices (engine 'custom', log pitch, envelope as gain points). */
export function segmentsToGlissandoVoices(params, segments, helpers) {
  const scale = outputScale(params);
  return segments.map((seg, j) => {
    const lo = seg.midi[0];
    const hi = seg.midi[seg.midi.length - 1];
    const span = hi - lo;
    const m = seg.midi.length - 1;
    const dense = seg.midi.map((mm, k) => ({ x: roundTo(k / m, 5), y: roundTo(Math.abs(span) > 1e-6 ? (mm - lo) / span : 0, 5), handles: [] }));
    const customPoints = helpers.captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.0015, maxAnchors: 48, includeTransforms: true });
    const peak = Math.max(1e-6, ...seg.amp);
    const gainPoints = [];
    for (let g = 0; g <= 16; g++) {
      const k = Math.round((g / 16) * m);
      gainPoints.push({ x: roundTo(g / 16, 4), y: roundTo(clamp(seg.amp[k] / peak, 0, 1), 4), handles: [] });
    }
    return helpers.createDefaultVoice(helpers.startIndex + j, {
      name: `Risset ${seg.voice + 1}${segments.filter((s) => s.voice === seg.voice).length > 1 ? `·${segments.filter((s, q) => s.voice === seg.voice && q <= j).length}` : ''}`,
      color: voiceColor(seg.voice),
      startTime: roundTo(seg.t0, 4),
      duration: Math.max(0.05, roundTo(seg.t1 - seg.t0, 4)),
      baseGain: roundTo(clamp(peak * scale * 2, 0, 1.5), 4),
      f0Hz: roundTo(midiToFreq(lo), 3),
      f1Hz: roundTo(midiToFreq(Math.abs(span) > 1e-6 ? hi : lo), 3),
      f0Fine: 0,
      f1Fine: 0,
      logScale: true,
      timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 },
      engine: 'custom',
      lastNonCustomEngine: 'harmonic',
      customPoints,
      gainMode: 'points',
      gainPoints,
    });
  });
}
