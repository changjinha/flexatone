/**
 * Flexatone — studios/field-studio.js
 * Layer 2 (studios): Field Studio plugin — vector-field particle trajectories.
 * 계층 2 (studios): 필드 스튜디오 플러그인 — 벡터장 입자 궤적.
 *
 * Registers `FieldStudio` with the StudioRegistry. Its whole document (field, guiding curve,
 * force nodes, particle voices, view) lives in appState.studioParams.field, so it is saved
 * with the project and undoable. The workspace UI (canvases, panels, audio) lives in
 * studios/field/field-canvases.js + field-audio.js and is mounted by ui/studio-host.js —
 * this file stays DOM- and audio-free (architecture DAG).
 * 문서는 appState.studioParams.field에 저장(저장·실행 취소 가능). UI/오디오는 별도 파일이며
 * ui/studio-host.js가 마운트 — 이 파일은 DOM·오디오에 의존하지 않음.
 *
 * Bake to Glissando Voices: each particle's baked trajectory becomes a standard Voice
 * (engine 'custom', log pitch F0→F1, Speed→Gain as gain points).
 * Imports: core/*, modules/*, studios/registry.js, studios/field/vector-field-engine.js.
 */

import { clamp, roundTo, deepClone } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { appState, registerSelfCheck, withIsolatedState } from '../core/state.js';
import { captureCurveToCustomPoints } from '../modules/curve-engine.js';
import { normalizeTremolo } from '../core/tremolo-config.js';
import { StudioRegistry } from './registry.js';
import {
  createDefaultFieldParams,
  bakeFieldVoices,
  lookupBakedSample,
  getBakeCount,
  VectorFieldPluginEngine,
  FIELD_STEPS,
  evalGuidingCurve,
  migrateFieldDoc,
  createFieldLayer,
} from './field/vector-field-engine.js';
import { createFieldRegion, regionWeight } from './field/field-regions.js';
import { layerWeight } from './field/field-layers.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const FIELD_ID = 'field';

/** Field document = defaults overlaid with the saved params (deep). / 필드 문서 */
export function getFieldParams() {
  // Pre-layer documents are converted to absolute layers on read / 레이어 이전 문서는 읽을 때 변환
  return StudioRegistry.has(FIELD_ID) ? migrateFieldDoc(StudioRegistry.getParams(FIELD_ID)) : createDefaultFieldParams();
}

/**
 * Apply an edit to the Field document. `fn(doc)` mutates a draft copy; physics edits are
 * undoable, view-only edits pass { history: false }.
 * 필드 문서 편집 (뷰 전용 변경은 history:false).
 */
export function editField(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getFieldParams();
  fn(draft);
  return StudioRegistry.setParams(FIELD_ID, draft, { history, coalesceKey });
}

export function getActiveParticle(params = getFieldParams()) {
  return params.voices.find((v) => v.id === params.activeVoiceId) || params.voices[0] || null;
}

export function isParticleAudible(v, params = getFieldParams()) {
  const anySolo = params.voices.some((x) => x.solo);
  return anySolo ? !!v.solo : !v.muted;
}

/** Baked points of every particle for the current document (memoised). / 현재 베이킹 결과 */
export function getBakedMap(params = getFieldParams()) {
  return bakeFieldVoices(params);
}

/**
 * Convert one particle to a Glissando Voice. The custom spline follows the trajectory as
 * it will be heard (Retrograde Mode honoured); Speed→Gain becomes the gain envelope.
 * 입자 하나를 글리산도 보이스로 변환 (역행 모드·유속→게인 반영).
 */
export function particleToGlissandoVoice(v, pts, helpers, index) {
  const n = FIELD_STEPS;
  const dense = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    dense.push({ x: roundTo(x, 5), y: roundTo(lookupBakedSample(v, pts, x).y, 5), handles: [] });
  }
  // includeTransforms forces a real adaptive fit (a plain custom source would be copied as-is)
  // includeTransforms: 원본을 그대로 복사하지 않고 실제 적응형 근사 수행
  const customPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.0015, maxAnchors: 64, includeTransforms: true });
  const gainPoints = [];
  for (let i = 0; i <= 16; i++) {
    const x = i / 16;
    gainPoints.push({ x: roundTo(x, 4), y: roundTo(clamp(lookupBakedSample(v, pts, x).gainMod, 0, 1), 4), handles: [] });
  }
  return helpers.createDefaultVoice(index, {
    name: v.name,
    color: v.color,
    solo: !!v.solo,
    muted: !!v.muted,
    startTime: v.startTime,
    duration: v.duration,
    baseGain: v.baseGain,
    f0Hz: roundTo(midiToFreq(v.f0Midi), 2),
    f1Hz: roundTo(midiToFreq(v.f1Midi), 2),
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(v.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints,
    gainMode: 'points',
    gainPoints,
    tremolo: normalizeTremolo(v.tremolo),
  });
}

export const FieldStudio = {
  id: FIELD_ID,
  name: { en: 'Field Studio', ko: '필드 스튜디오' },
  description: { en: 'Vector-field particle trajectories baked at edit time', ko: '에디팅 시점에 베이킹되는 벡터장 입자 궤적' },
  order: 30,
  status: 'ready',
  usesVoiceEditor: false,
  /** Rendered by its own workspace, not by the generic studio panel. / 전용 작업 공간 사용 */
  schema: [],
  workspace: 'field',
  defaultParams: createDefaultFieldParams,
  generateVoices(params, helpers) {
    params = migrateFieldDoc(params);
    const baked = bakeFieldVoices(params);
    return params.voices.map((v, i) => particleToGlissandoVoice(v, baked.get(v.id), helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(FieldStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Field studio: physics, edit-time bake cache, bake to Glissando', (a) => {
  a.ok(StudioRegistry.has(FIELD_ID), 'registered');
  const p = createDefaultFieldParams();
  a.equal(JSON.stringify(createDefaultFieldParams()), JSON.stringify(createDefaultFieldParams()), 'defaults are deterministic (stable bake cache)');
  const before = getBakeCount();
  const m1 = bakeFieldVoices(p);
  const m2 = bakeFieldVoices(deepClone(p));
  a.ok(m1 === m2, 'same physics → cached (no re-integration)');
  a.equal(getBakeCount() - before <= 1, true, 'integrated at most once');
  const pts = m1.get(p.voices[0].id);
  a.equal(pts.length, FIELD_STEPS + 1, 'baked sample count');
  a.ok(pts.every((q) => Number.isFinite(q.y) && Number.isFinite(q.t)), 'finite trajectory');
  a.near(pts[0].y, 0, 1e-12, 'starts at y = 0');
  // Sonification edits never re-bake / 음향화 파라미터는 다시 베이킹하지 않음
  const q = deepClone(p);
  q.voices[0].speedToGain = 0.9;
  q.voices[0].timbre.saw = 1;
  a.ok(bakeFieldVoices(q) === m2, 'sonification change keeps the cache');
  q.voices[0].mass = 3.3;
  a.ok(bakeFieldVoices(q) !== m2, 'physics change re-bakes');
  // ODE mode marches t linearly / ODE 모드는 t가 선형 진행
  const ode = { ...deepClone(p), flowMode: 'ode' };
  const op = VectorFieldPluginEngine.bakeVoice(ode.voices[0], ode, ode.guiding, []);
  a.near(op[110].t, 0.5, 1e-12, 'ODE t = s');
  // Bake to Glissando voices (isolated) / 글리산도 보이스로 베이킹 (격리 상태)
  withIsolatedState(() => {
    const voices = StudioRegistry.generateVoices(FIELD_ID, p);
    a.equal(voices.length, p.voices.length, 'one voice per particle');
    const v = voices[0];
    a.ok(v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.length <= 64, `adaptive spline (${v.customPoints.length} anchors)`);
    a.near(v.f0Hz, midiToFreq(p.voices[0].f0Midi), 0.01, 'F0 from particle');
    a.equal(appState.voices.length >= 1, true, 'state untouched by generateVoices');
  });
}, { group: 'studio' });

registerSelfCheck('Field studio: local regions modulate the field only inside', (a) => {
  const p = createDefaultFieldParams();
  a.ok(Array.isArray(p.regions) && p.regions.length === 0, 'no regions by default');
  const v = p.voices[0];
  const base = VectorFieldPluginEngine.evaluateFieldAt(0.5, 0.5, v, p, p.guiding, []);
  // Particle 1 = 0 → 3.2 s, C3 → C5, so (t, y) = (0.5, 0.5) is (1.6 s, MIDI 60) / 입자 1 기준
  const r = createFieldRegion('rect', 1.6, 60);
  Object.assign(r, { w: 0.4, h: 2.4, feather: 0, gain: { guide: 0, nodes: 0, turb: 0, wells: 0 } });
  const q = { ...deepClone(p), regions: [r] };
  a.near(regionWeight(r, 1.6, 60), 1, 1e-12, 'weight 1 inside');
  a.near(regionWeight(r, 3.0, 60), 0, 1e-12, 'weight 0 outside');
  a.near(regionWeight({ ...r, invert: true }, 3.0, 60), 1, 1e-12, 'invert flips');
  const inside = VectorFieldPluginEngine.evaluateFieldAt(0.5, 0.5, v, q, q.guiding, []);
  a.ok(Math.abs(inside.vy) < 1e-9, `all components off → vy = 0 inside (${inside.vy})`);
  const out0 = VectorFieldPluginEngine.evaluateFieldAt(0.05, 0.1, v, p, p.guiding, []);
  const out1 = VectorFieldPluginEngine.evaluateFieldAt(0.05, 0.1, v, q, q.guiding, []);
  a.near(out1.vy, out0.vy, 1e-12, 'unchanged outside');
  a.ok(Math.abs(base.vy - inside.vy) > 1e-6, 'region changes the field inside');
  a.ok(bakeFieldVoices(q) !== bakeFieldVoices(p), 'regions are part of the bake signature');
  const pushR = { ...r, gain: { guide: 1, nodes: 1, turb: 1, wells: 1 }, flowAngle: 90, flowStrength: 2 };
  const pushed = VectorFieldPluginEngine.evaluateFieldAt(0.5, 0.5, v, { ...p, regions: [pushR] }, p.guiding, []);
  a.near(pushed.vy - base.vy, 2, 1e-9, 'flow push adds (cos θ, sin θ)·s');
}, { group: 'studio' });

registerSelfCheck('Field studio: vector field OFF = pure guiding curve', (a) => {
  const p = { ...createDefaultFieldParams(), fieldEnabled: false };
  const map = bakeFieldVoices(p);
  for (const v of p.voices) {
    const pts = map.get(v.id);
    a.equal(pts.length, FIELD_STEPS + 1, 'baked sample count');
    a.ok(pts.every((q, i) => Math.abs(q.t - i / FIELD_STEPS) < 1e-12), 't = s (no retrograde)');
    a.ok(pts.every((q) => Math.abs(q.y - evalGuidingCurve(q.t, p.guiding)) < 1e-12), 'y = guiding curve exactly');
  }
  const q = deepClone(p);
  q.turbulence = 2; q.nodes = []; q.guideAttraction = 0;
  a.ok(bakeFieldVoices(q) === bakeFieldVoices(p), 'field settings ignored while OFF (cached)');
  const r = deepClone(p);
  r.guiding.alpha = 10;
  a.ok(bakeFieldVoices(r) !== bakeFieldVoices(p), 'guide edits re-bake while OFF');
  a.ok(bakeFieldVoices({ ...deepClone(p), fieldEnabled: true }) !== bakeFieldVoices(p), 'ON vs OFF bake differ');
}, { group: 'studio' });

registerSelfCheck('Field studio: absolute layer stack — modes, order, range edge, migration', (a) => {
  const p = createDefaultFieldParams();
  const v = p.voices[0];
  const main = p.layers[0];
  a.ok(main.range.full !== false && layerWeight(main, 0, 12) === 1 && layerWeight(main, 30, 120) === 1, 'main field covers the full range');
  const at = (layers, t, y) => VectorFieldPluginEngine.evaluateFieldAt(t, y, v, { ...p, layers }, p.guiding, []);
  const box = { full: false, t0: 1.2, t1: 2.0, m0: 56, m1: 64 }; // (t, y) = (0.5, 0.5) is inside
  const hardEmpty = (mode, amount) => ({ ...createFieldLayer({ mode, amount, range: box, feather: 0 }) });
  const none = at([], 0.5, 0.5);
  const base = at([main], 0.5, 0.5);
  a.ok(Math.abs(base.vy - none.vy) > 1e-6, 'main field acts at the centre');
  a.near(at([main, hardEmpty('replace')], 0.5, 0.5).vy, none.vy, 1e-12, 'replace with an empty field clears what is below (inside)');
  a.near(at([main, hardEmpty('replace')], 0.1, 0.1).vy, at([main], 0.1, 0.1).vy, 1e-12, 'hard edge: unchanged outside');
  a.near(at([main, hardEmpty('multiply', -1)], 0.5, 0.5).vy, none.vy, 1e-12, 'multiply −1 silences below');
  a.near(at([hardEmpty('multiply', -1), main], 0.5, 0.5).vy, base.vy, 1e-12, 'order: multiply below main has no effect');
  const twice = at([main, hardEmpty('multiply', 1)], 0.5, 0.5);
  a.near(twice.vy - none.vy, 2 * (base.vy - none.vy), 1e-9, 'multiply +1 doubles');
  const half = at([main, { ...deepClone(main), id: 'copy', amount: 0.5 }], 0.5, 0.5);
  a.near(half.vy - none.vy, 1.5 * (base.vy - none.vy), 1e-9, 'add × amount');
  const neg = at([main, { ...deepClone(main), id: 'neg', amount: -1 }], 0.5, 0.5);
  a.near(neg.vy, none.vy, 1e-9, 'add −1 cancels an identical layer');
  const soft = { ...hardEmpty('replace'), feather: 0.2 };
  const wMid = layerWeight(soft, 2.0 + 0.1 * 4, 60); // halfway through the feather (0.1 field units = 0.4 s)
  a.ok(wMid > 0.1 && wMid < 0.9, `soft edge blends (w = ${wMid.toFixed(3)})`);
  a.near(layerWeight({ ...soft, invert: true }, 1.6, 60), 0, 1e-12, 'invert: no effect inside');
  // Migration of a pre-layer document / 레이어 이전 문서 변환
  const old = { ...deepClone(p), layers: undefined, nodes: [{ id: 'fn_x', type: 'vortex', x: 0.5, y: 0.25, strength: 1, radius: 0.3 }], turbulence: 0.5, turbFreq: 4, fieldPhase: 0.2,
    regions: [{ id: 'r1', enabled: true, shape: 'rect', x: 0.5, y: 0.5, w: 0.1, h: 0.1, feather: 0, invert: false, gain: { guide: 1, nodes: 1, turb: 0, wells: 1 }, flowAngle: 0, flowStrength: 0 }] };
  const mig = migrateFieldDoc(old);
  const n = mig.layers[0].nodes[0];
  a.ok(mig.nodes === null && mig.layers.length === 1 && mig.layers[0].turbulence === 0.5, 'old field → one main layer');
  a.near(n.sec, 1.6, 1e-9, 'node t → seconds');
  a.near(n.midi, 54, 1e-9, 'node y → MIDI');
  a.ok(Math.abs(mig.regions[0].x - 1.6) < 1e-9 && Math.abs(mig.regions[0].h - 2.4) < 1e-9, 'region → absolute');
  a.ok(migrateFieldDoc(mig) === mig, 'migration runs once');
  a.ok(bakeFieldVoices(old).size === p.voices.length, 'old documents still bake');
}, { group: 'studio' });
