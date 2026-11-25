/**
 * Flexatone — studios/fractal-studio.js
 * Layer 2 (studios): Fractal Studio plugin — self-similar glissando trajectories and voice trees.
 * 계층 2 (studios): 프랙탈 스튜디오 플러그인 — 자기유사 글리산도 궤적과 보이스 트리.
 *
 * The whole document lives in appState.studioParams.fractal (saved, loaded, undoable). The
 * algorithms and the edit-time bake cache are in studios/fractal/fractal-engine.js; the
 * workspace UI and audio (fractal-panels / fractal-canvases / fractal-audio) are mounted by
 * ui/studio-host.js — this file stays DOM- and audio-free (architecture DAG).
 * 문서는 appState.studioParams.fractal에 저장. 알고리즘·캐시는 fractal-engine.js, UI·오디오는
 * ui/studio-host.js가 마운트 — 이 파일은 DOM·오디오에 의존하지 않음.
 *
 * Bake to Glissando Voices: each baked voice (curve, refinement level, L-system branch or canon
 * layer) is reduced with RDP to its meaningful extrema and fitted to a ≤ 64-anchor custom
 * spline. Fine fBm / Weierstrass detail is lost in that fit; the loss is measured and shown.
 * 글리산도 베이킹: RDP로 극값만 남긴 뒤 64 앵커 이하 스플라인으로 근사 — 손실을 측정해 표시.
 *
 * Imports: core/*, modules/*, studios/registry.js, studios/fractal/*.js (pure only).
 */

import { clamp, roundTo, deepClone } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { appState, registerSelfCheck, withIsolatedState } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import './fractal/fractal-i18n.js'; // merges EN/KO strings before the tabs are drawn / 탭 그리기 전 문자열 병합
import {
  createDefaultFractalParams,
  normalizeFractalParams,
  bakeFractal,
  getFractalBakeCount,
  simplifyVoiceForBake,
  fifMaps,
  fifEval,
  fbmSpectralLevels,
  fbmMidpointLevels,
  estimateHurst,
  weierLevels,
  cantorF,
  expandLSystem,
  bracketsBalanced,
  interpretLSystem,
  norgardSeries,
  boxCountDimension,
  rmsDiff,
  sampleCurveLevels,
  retimeFractalBake,
  MAX_LSYS_LENGTH,
} from './fractal/fractal-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const FRACTAL_ID = 'fractal';

/** Fractal document (defaults deep-merged, clamped). / 프랙탈 문서 */
export function getFractalParams() {
  return normalizeFractalParams(StudioRegistry.has(FRACTAL_ID) ? StudioRegistry.getParams(FRACTAL_ID) : createDefaultFractalParams());
}

/**
 * Apply an edit: `fn(draft)` mutates a normalised copy. Undoable unless { history: false }.
 * 프랙탈 문서 편집 (드래그 1회 = coalesceKey로 1단계).
 */
export function editFractal(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getFractalParams();
  fn(draft);
  return StudioRegistry.setParams(FRACTAL_ID, normalizeFractalParams(draft), { history, coalesceKey });
}

/** Baked voices of the current document (memoised). / 현재 베이킹 결과 */
export function getFractalBake(params = getFractalParams()) {
  return bakeFractal(params);
}

// --------------------------------------------------------------------------
// Presets / 프리셋
// --------------------------------------------------------------------------

const D = createDefaultFractalParams();

/** Six presets; each replaces the mode section with defaults + patch. / 프리셋 6종 */
export const FRACTAL_PRESETS = Object.freeze({
  coastline: { mode: 'fbm', fbm: { H: 0.3, octaves: 9, method: 'spectral' }, refine: { ...D.refine, enabled: false }, gain: { ...D.gain, source: 'slope' }, length: 30, lo: 40, hi: 84, quantize: 'off' },
  smoothDrift: { mode: 'fbm', fbm: { H: 0.8, octaves: 7, method: 'spectral' }, refine: { ...D.refine, enabled: false }, gain: { ...D.gain, source: 'fixed' }, length: 40, lo: 43, hi: 79, quantize: 'off' },
  barnsley: { mode: 'fif', fif: deepClone(D.fif), refine: { ...D.refine, enabled: false }, length: 30, lo: 36, hi: 84, quantize: 'off' },
  devilsStair: { mode: 'cantor', cantor: { div: 3, gap: 1 / 3, depth: 6 }, refine: { ...D.refine, enabled: false }, length: 24, lo: 45, hi: 81, quantize: 'off' },
  binaryTree: { mode: 'lsystem', lsys: { axiom: 'X', rules: [{ from: 'X', to: 'F[+FX][-FX]' }, { from: 'F', to: 'FF' }], iterations: 4, angleSemitones: 2, stepSec: 0.6, glide: true, startNote: 60 }, voicesMax: 32, lo: 36, hi: 88, quantize: 'off' },
  infinityCanon: { mode: 'canon', canon: { ...deepClone(D.canon), layers: 5, ratio: 0.5, subject: 'norgard' }, voicesMax: 16, length: 32, lo: 36, hi: 96, quantize: 'off' },
});
export const PRESET_IDS = Object.freeze(Object.keys(FRACTAL_PRESETS));

/** L-system rule presets (rack buttons). / L-시스템 규칙 프리셋 */
export const LSYS_PRESETS = Object.freeze({
  algae: { axiom: 'A', rules: [{ from: 'A', to: 'A+B' }, { from: 'B', to: 'A-' }], iterations: 7, angleSemitones: 2, stepSec: 0.25, glide: false },
  koch: { axiom: 'F', rules: [{ from: 'F', to: 'F+F-F-F+F' }], iterations: 3, angleSemitones: 3, stepSec: 0.12, glide: true },
  binary: { axiom: 'X', rules: [{ from: 'X', to: 'F[+FX][-FX]' }, { from: 'F', to: 'FF' }], iterations: 4, angleSemitones: 2, stepSec: 0.6, glide: true },
});

export function applyPresetTo(draft, id) {
  const patch = FRACTAL_PRESETS[id];
  if (!patch) return draft;
  Object.assign(draft, deepClone(patch));
  draft.preset = id;
  return draft;
}

// --------------------------------------------------------------------------
// Bake → Glissando / 글리산도 보이스로 변환
// --------------------------------------------------------------------------

const customObj = (pts) => ({ engine: 'custom', customPoints: pts, reverse: false, inverse: false });

/**
 * Fit one baked voice to a ≤ 64-anchor custom spline and measure the loss in semitones.
 * 베이킹 보이스 하나를 64 앵커 이하 스플라인으로 근사하고 손실(반음)을 측정.
 */
export function fitBakedVoice(v, tolerance) {
  const s = simplifyVoiceForBake(v, tolerance, 48);
  let customPoints = captureCurveToCustomPoints(customObj(s.pts.map((q) => ({ x: q.x, y: q.y, handles: [] }))), { tolerance, maxAnchors: 64, includeTransforms: true });
  if (customPoints.length > MAX_GENERATED_VOICES) customPoints = s.pts.map((q) => ({ x: q.x, y: q.y, handles: [] })); // safety net / 안전망
  const n = v.midi.length;
  const stride = Math.max(1, Math.floor(n / 2000));
  const span = s.m1 - s.m0;
  const obj = customObj(customPoints);
  let maxErr = 0;
  let sq = 0;
  let cnt = 0;
  for (let i = 0; i < n; i += stride) {
    const x = i / (n - 1);
    const e = Math.abs(evaluateCurveObjectY(obj, x, { raw: true }) * span + s.m0 - v.midi[i]);
    if (e > maxErr) maxErr = e;
    sq += e * e;
    cnt++;
  }
  return { customPoints, m0: s.m0, m1: s.m1, anchors: customPoints.length, maxErrSt: maxErr, rmsErrSt: Math.sqrt(sq / Math.max(1, cnt)) };
}

const lossCache = new Map();

/** Bake-to-Glissando loss summary for the current document (memoised). / 근사 손실 요약 */
export function getBakeLoss(params = getFractalParams()) {
  const p = normalizeFractalParams(params);
  const bake = bakeFractal(p);
  const key = `${bake.sig}|${p.bake.tolerance}`;
  if (lossCache.has(key)) return lossCache.get(key);
  const fits = bake.voices.slice(0, MAX_GENERATED_VOICES).map((v) => fitBakedVoice(v, p.bake.tolerance));
  const res = {
    voices: fits.length,
    anchorsMax: fits.reduce((m, f) => Math.max(m, f.anchors), 0),
    maxErrSt: fits.reduce((m, f) => Math.max(m, f.maxErrSt), 0),
    rmsErrSt: fits.length ? Math.sqrt(fits.reduce((s, f) => s + f.rmsErrSt ** 2, 0) / fits.length) : 0,
  };
  lossCache.set(key, res);
  if (lossCache.size > 8) lossCache.delete(lossCache.keys().next().value);
  return res;
}

/** One baked fractal voice → Glissando Voice (custom spline + gain points). / 글리산도 보이스 변환 */
export function fractalVoiceToGlissando(v, p, bake, helpers, index) {
  const fit = fitBakedVoice(v, p.bake.tolerance);
  const n = v.gain.length;
  const gMax = Math.max(1e-6, ...v.gain);
  const gainPoints = [];
  for (let i = 0; i <= 24; i++) {
    const x = i / 24;
    gainPoints.push({ x: roundTo(x, 4), y: roundTo(clamp(v.gain[Math.round(x * (n - 1))] / gMax, 0, 1), 4), handles: [] });
  }
  return helpers.createDefaultVoice(index, {
    name: `Fractal ${v.name}`,
    color: v.color,
    startTime: roundTo(v.startSec, 4),
    duration: Math.max(0.05, roundTo(v.durSec, 4)),
    baseGain: roundTo(clamp((gMax * 0.85) / Math.sqrt(bake.maxConcurrent), 0.02, 1.5), 3),
    f0Hz: roundTo(midiToFreq(fit.m0), 4),
    f1Hz: roundTo(midiToFreq(fit.m1), 4),
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(p.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints: fit.customPoints,
    gainMode: 'points',
    gainPoints,
  });
}

export const FractalStudio = {
  id: FRACTAL_ID,
  name: { en: 'Fractal Studio', ko: '프랙탈 스튜디오' },
  description: { en: 'Self-similar glissandi: FIF, fBm, Weierstrass, Cantor, L-system trees, Nørgård canon', ko: '자기유사 글리산도: FIF, fBm, 바이어슈트라스, 칸토어, L-시스템 트리, 노르고르 캐논' },
  order: 90,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'fractal',
  defaultParams: createDefaultFractalParams,
  generateVoices(params, helpers) {
    const p = normalizeFractalParams(params);
    const bake = bakeFractal(p);
    return bake.voices.slice(0, MAX_GENERATED_VOICES).map((v, i) => fractalVoiceToGlissando(v, p, bake, helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(FractalStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Fractal: FIF interpolates its points; d = 0 is the polyline', (a) => {
  const p = createDefaultFractalParams();
  const pts = p.fif.points;
  const maps = fifMaps(pts, p.fif.d);
  for (const depth of [1, 4, 8]) for (const q of pts) a.near(fifEval(pts, maps, q.x, depth), q.y, 1e-9, `depth ${depth} at x=${q.x}`);
  const flat = fifMaps(pts, pts.slice(1).map(() => 0));
  for (let i = 0; i <= 50; i++) {
    const x = i / 50;
    let lin = pts[0].y;
    for (let k = 1; k < pts.length; k++) if (x <= pts[k].x) { lin = pts[k - 1].y + ((x - pts[k - 1].x) / (pts[k].x - pts[k - 1].x)) * (pts[k].y - pts[k - 1].y); break; }
    a.near(fifEval(pts, flat, x, 7), lin, 1e-9, `d=0 piecewise linear at ${x}`);
  }
}, { group: 'studio' });

registerSelfCheck('Fractal: fBm deterministic, Hurst from increment variance ≈ H', (a) => {
  const A = fbmSpectralLevels(0.5, 6, 7, 1025);
  const B = fbmSpectralLevels(0.5, 6, 7, 1025);
  a.equal(rmsDiff(A[5], B[5]), 0, 'same seed/H → identical');
  a.ok(rmsDiff(A[5], fbmSpectralLevels(0.5, 6, 8, 1025)[5]) > 1e-3, 'other seed differs');
  for (const H of [0.3, 0.5, 0.8]) {
    const y = fbmSpectralLevels(H, 10, 3, 8193)[9];
    const est = estimateHurst(y, [8, 16, 32, 64, 128]);
    a.near(est, H, 0.1, `spectral H=${H}`);
  }
  const m = fbmMidpointLevels(0.5, 8, 3, 513);
  a.equal(rmsDiff(m[7], fbmMidpointLevels(0.5, 8, 3, 513)[7]), 0, 'midpoint deterministic');
}, { group: 'studio' });

registerSelfCheck('Fractal: Weierstrass bounded |y| ≤ 1/(1−a) and continuous', (a) => {
  for (const [aa, b] of [[0.5, 3], [0.7, 2], [0.9, 1.5]]) {
    const y = weierLevels(aa, b, false, 12, 4097)[11];
    const bound = 1 / (1 - aa);
    let maxAbs = 0;
    let maxStep = 0;
    for (let i = 0; i < y.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(y[i]));
      if (i) maxStep = Math.max(maxStep, Math.abs(y[i] - y[i - 1]));
      a.ok(Number.isFinite(y[i]), 'finite');
    }
    a.ok(maxAbs <= bound + 1e-9, `bounded a=${aa}`);
    a.ok(maxStep < 2 * bound, `finite adjacent differences (${maxStep.toFixed(3)})`);
  }
  const tk = weierLevels(0.5, 2, true, 14, 2049)[13];
  a.ok(Math.max(...tk) <= 2 / 3 + 1e-9 && Math.min(...tk) >= -1e-12, 'Takagi in [0, 2/3]');
}, { group: 'studio' });

registerSelfCheck("Fractal: devil's staircase F(0)=0, F(1)=1, monotone, plateau 1/2", (a) => {
  a.equal(cantorF(0, 3, 1 / 3, 8), 0, 'F(0)');
  a.equal(cantorF(1, 3, 1 / 3, 8), 1, 'F(1)');
  a.near(cantorF(0.5, 3, 1 / 3, 8), 0.5, 1e-12, 'F(1/2)');
  for (let i = 0; i <= 20; i++) a.near(cantorF(1 / 3 + (i / 20) / 3, 3, 1 / 3, 8), 0.5, 1e-9, 'constant on [1/3, 2/3]');
  for (const [div, gap] of [[3, 1 / 3], [5, 0.5], [7, 0.2]]) {
    let prev = -1;
    for (let i = 0; i <= 2000; i++) {
      const v = cantorF(i / 2000, div, gap, 6);
      a.ok(v >= prev - 1e-12, `monotone div=${div}`);
      prev = v;
    }
  }
}, { group: 'studio' });

registerSelfCheck('Fractal: L-system Fibonacci lengths, brackets, voices = branches + 1, length guard', (a) => {
  const algae = [{ from: 'A', to: 'AB' }, { from: 'B', to: 'A' }];
  a.equal([0, 1, 2, 3, 4, 5].map((i) => expandLSystem('A', algae, i).str.length).join(), '1,2,3,5,8,13', 'Fibonacci');
  const tree = expandLSystem('F', [{ from: 'F', to: 'F[+F]F[-F]F' }], 3);
  a.ok(bracketsBalanced(tree.str), 'balanced');
  a.ok(!bracketsBalanced('F]F[') && !bracketsBalanced('[F'), 'unbalanced detected');
  const branches = [...tree.str].filter((c) => c === '[').length;
  const tur = interpretLSystem(tree.str, { cap: 999 });
  a.equal(tur.voiceCount, branches + 1, 'voice count');
  a.equal(tur.recorded, branches + 1, 'all branches recorded');
  const big = expandLSystem('F', [{ from: 'F', to: 'FFFFFFFFFF' }], 8);
  a.ok(big.truncated && big.str.length <= MAX_LSYS_LENGTH && big.iterationsDone === 5, `length guard (${big.str.length})`);
  const capped = interpretLSystem(tree.str, { cap: 64 });
  a.ok(capped.recorded <= 64, 'voice cap');
}, { group: 'studio' });

registerSelfCheck('Fractal: Nørgård infinity series a(0..7)', (a) => {
  a.equal(norgardSeries(8).join(), '0,1,-1,2,1,0,-2,3');
  const s = norgardSeries(64);
  for (let n = 1; n < 32; n++) a.ok(s[2 * n] + s[n] === 0, `a(2n) = −a(n) at ${n}`);
  for (let n = 0; n < 31; n++) a.equal(s[2 * n + 1], s[n] + 1, `a(2n+1) = a(n) + 1 at ${n}`);
}, { group: 'studio' });

registerSelfCheck('Fractal: box-counting D (line ≈ 1, higher H → lower D)', (a) => {
  const line = Float64Array.from({ length: 4097 }, (_, i) => 0.2 + (0.6 * i) / 4096);
  a.near(boxCountDimension(line).D, 1, 0.05, 'straight line');
  const dLow = boxCountDimension(fbmSpectralLevels(0.2, 10, 5, 8193)[9], { jMax: 11 }).D;
  const dHigh = boxCountDimension(fbmSpectralLevels(0.8, 10, 5, 8193)[9], { jMax: 11 }).D;
  a.ok(dLow > dHigh + 0.15, `D(H=0.2)=${dLow.toFixed(3)} > D(H=0.8)=${dHigh.toFixed(3)}`);
}, { group: 'studio' });

registerSelfCheck('Fractal: progressive refinement — RMS(level k+1 − k) decreases', (a) => {
  for (const mode of ['fbm', 'weierstrass', 'fif']) {
    const p = normalizeFractalParams({ mode, fbm: { H: 0.5, octaves: 8 }, weier: { a: 0.6, b: 2.5, terms: 8 }, fif: { ...createDefaultFractalParams().fif, depth: 7 } });
    const levels = [0, 1, 2, 3, 4, 5, 6, 7];
    const { arrays } = sampleCurveLevels(p, levels, 4097);
    const r = arrays.slice(1).map((arr, i) => rmsDiff(arr, arrays[i]));
    for (let i = 1; i < r.length; i++) a.ok(r[i] < r[i - 1], `${mode}: ${r.map((x) => x.toFixed(4)).join(' > ')}`);
  }
}, { group: 'studio' });

registerSelfCheck('Fractal: bake cache, Glissando conversion (≤ 64 voices/anchors), state untouched', (a) => {
  a.ok(StudioRegistry.has(FRACTAL_ID), 'registered');
  const p = createDefaultFractalParams();
  const before = getFractalBakeCount();
  const b1 = bakeFractal(p);
  const b2 = bakeFractal(deepClone(p));
  a.ok(b1 === b2, 'same document → cached');
  a.ok(getFractalBakeCount() - before <= 1, 'baked at most once');
  a.ok(bakeFractal({ ...deepClone(p), timbre: { ...p.timbre, saw: 1 }, bake: { ...p.bake, tolerance: 0.02 } }) === b1, 'timbre / tolerance keep the cache');
  a.ok(bakeFractal({ ...deepClone(p), seed: 2, mode: 'fbm' }) !== b1, 'shape change re-bakes');
  withIsolatedState(() => {
    const snap = JSON.stringify(appState.voices);
    for (const id of PRESET_IDS) {
      const doc = applyPresetTo(createDefaultFractalParams(), id);
      const voices = StudioRegistry.generateVoices(FRACTAL_ID, doc);
      a.ok(voices.length >= 1 && voices.length <= MAX_GENERATED_VOICES, `${id}: ${voices.length} voices`);
      a.ok(voices.every((v) => v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.length <= 64), `${id}: ≤ 64 anchors`);
      a.ok(voices.every((v) => v.customPoints.every((q, i, arr) => !i || q.x > arr[i - 1].x)), `${id}: monotone x`);
    }
    const tree = StudioRegistry.generateVoices(FRACTAL_ID, applyPresetTo(createDefaultFractalParams(), 'binaryTree'));
    a.ok(tree.length > 16 && tree.length <= 32, `binary tree: every branch sounds, ≤ 32 voices (${tree.length})`);
    a.equal(JSON.stringify(appState.voices), snap, 'generateVoices leaves state alone');
  });
}, { group: 'studio' });

registerSelfCheck('Fractal: presets bake finite pitches inside the MIDI range', (a) => {
  for (const id of PRESET_IDS) {
    const b = bakeFractal(applyPresetTo(createDefaultFractalParams(), id));
    a.ok(b.voices.length >= 1, `${id} has voices`);
    a.ok(b.voices.every((v) => v.midi.every((m) => Number.isFinite(m) && m >= 0 && m <= 127) && v.gain.every((g) => g >= 0 && g <= 1.5)), `${id} finite`);
    a.ok(b.endSec > 0.5 && Number.isFinite(b.analysis.D), `${id} timeline & D`);
  }
}, { group: 'studio' });

registerSelfCheck('Fractal: Tempo Manager retime keeps pitch, divides every time by the rate', (a) => {
  for (const id of ['coastline', 'binaryTree', 'infinityCanon']) {
    const b = bakeFractal(applyPresetTo(createDefaultFractalParams(), id));
    const f = retimeFractalBake(b, 2);
    a.near(f.endSec, b.endSec / 2, 1e-9, `${id}: length ÷ 2`);
    a.equal(f.voices.length, b.voices.length, `${id}: same voices`);
    a.ok(f.voices.every((v, i) => v.hz === b.voices[i].hz && v.gain === b.voices[i].gain), `${id}: Hz / gain arrays shared (pitch kept)`);
    a.ok(f.voices.every((v, i) => Math.abs(v.startSec - b.voices[i].startSec / 2) < 1e-9 && Math.abs(v.rate - b.voices[i].rate * 2) < 1e-6), `${id}: start ÷ 2, sample rate × 2`);
    a.near(retimeFractalBake(b, 0.5).endSec, b.endSec * 2, 1e-9, `${id}: half speed doubles the length`);
    a.equal(f.maxConcurrent, b.maxConcurrent, `${id}: same polyphony (same mix gain)`);
    a.ok(retimeFractalBake(b, 1) === b && retimeFractalBake(b, NaN) === b, `${id}: rate 1 / bad rate → the bake itself`);
    a.ok(f.sig !== b.sig, `${id}: retimed signature differs`);
  }
}, { group: 'studio' });
