/**
 * Flexatone — studios/wave-studio.js
 * Layer 2 (studios): Wave Studio plugin — the pitch axis as a medium carrying 1-D waves.
 * 계층 2 (studios): 웨이브 스튜디오 플러그인 — 음고 축을 매질로 보는 1차원 파동.
 *
 * Registers `WaveStudio` with the StudioRegistry. The whole document (equation, grid, medium,
 * initial conditions, drivers, sonification, view) lives in appState.studioParams.wave, so it is
 * saved with the project and undoable. The workspace (canvases, panels, audio) lives in
 * studios/wave/wave-canvases.js, wave-panels.js and wave-audio.js and is mounted by
 * ui/studio-host.js — this file stays DOM- and audio-free (architecture DAG).
 * 문서는 appState.studioParams.wave에 저장(저장·실행 취소 가능). UI/오디오는 별도 파일.
 *
 * Bake to Glissando Voices: every ridge track (a followed local maximum) becomes a standard
 * Voice (engine 'custom', log pitch, amplitude as gain points). Stereo position and the dense
 * spectral texture are NOT carried over (a Voice has no pan; the cloud is reduced to its ridges).
 * 글리산도 보이스로 베이킹: 리지 트랙 하나 = 보이스 하나. 스테레오 위치와 스펙트럴 질감은 옮겨지지 않음.
 *
 * Imports: core/*, modules/*, studios/registry.js, studios/wave/wave-engine.js, wave-bank.js.
 */

import { clamp, roundTo, deepClone, createSeededRandom } from '../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../core/units.js';
import { appState, registerSelfCheck, withIsolatedState, createDefaultManagerState } from '../core/state.js';
import { ensureManager, addInstance, focusInstance, getInstance } from '../core/manager-state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import './wave/wave-i18n.js'; // merges the EN/KO keys before any tab is drawn / 탭 표시 전에 번역 키 병합
import {
  createDefaultWaveParams,
  createWavePreset,
  sanitizeWaveParams,
  bakeWave,
  bakeWaveDetached,
  simulateWave,
  getWaveBakeCount,
  withIsolatedWaveCache,
  buildAmplitude,
  extractRidges,
  createWaveSim,
  createGsSim,
  createSchrodSim,
  createDiffSim,
  harmonicLength,
  hermiteFunction,
  buildInitialState,
  mediumProfile,
  waveTimelineEnd,
  retimeWaveBake,
  WAVE_PRESET_IDS,
  WAVE_MAX_TRACKS,
} from './wave/wave-engine.js';
import { WaveSpectralBank } from './wave/wave-bank.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const WAVE_ID = 'wave';

const docMemo = new WeakMap(); // stored document object → sanitised full params
const resolved = new WeakSet(); // params objects produced here (already sanitised)
let defaultDoc = null;

/**
 * Full, sanitised params of a stored Wave document (null / undefined = studio defaults).
 * Memoised per document object, so the editor and the Manager share one params object for the
 * same stored document. READ-ONLY. / 저장된 문서 → 정규화된 전체 파라미터 (문서 객체별 메모이즈, 읽기 전용)
 */
export function resolveWaveDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    if (!defaultDoc) resolved.add(defaultDoc = sanitizeWaveParams(createDefaultWaveParams()));
    return defaultDoc;
  }
  if (resolved.has(doc)) return doc; // already full params / 이미 정규화된 파라미터
  let p = docMemo.get(doc);
  if (!p) {
    p = sanitizeWaveParams({ ...createDefaultWaveParams(), ...doc });
    docMemo.set(doc, p);
    resolved.add(p);
  }
  return p;
}

/**
 * Wave document in the editor = defaults overlaid with appState.studioParams.wave, sanitised.
 * READ-ONLY (use editWave to change it). / 에디터의 웨이브 문서 (읽기 전용)
 */
export function getWaveParams() {
  return resolveWaveDoc(appState.studioParams?.[WAVE_ID]);
}

/**
 * Apply an edit to the Wave document. `fn(doc)` mutates a draft copy; physics edits are
 * undoable, view-only edits pass { history: false }.
 * 웨이브 문서 편집 (뷰 전용 변경은 history:false).
 */
export function editWave(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getWaveParams());
  fn(draft);
  return StudioRegistry.setParams(WAVE_ID, sanitizeWaveParams(draft), { history, coalesceKey });
}

/** Baked simulation of the current document (memoised by physics signature). / 현재 베이킹 결과 */
export function getWaveBake(params = getWaveParams()) {
  // Documents that are not on screen (Manager instances) bake into a separate cache, so they
  // neither evict the editor's bake nor raise its bake counter. / 화면 밖 문서는 별도 캐시 사용
  return params === getWaveParams() ? bakeWave(params) : bakeWaveDetached(params);
}

/** Ridge tracks of the current document (cached per bake + ridge parameters). / 현재 리지 트랙 */
export function getWaveRidges(params = getWaveParams()) {
  return extractRidges(getWaveBake(params), params.sonify);
}

/**
 * Ridge tracks of a stored document as polylines in document time for the Manager's Master
 * View: [{ key, name, pts: [{ t (s), m (MIDI) }] }]. / 매니저 마스터 뷰용 리지 폴리라인 (문서 시간)
 */
export function waveMasterLines(doc) {
  const p = resolveWaveDoc(doc);
  const bake = getWaveBake(p);
  const { tracks } = extractRidges(bake, p.sonify);
  return tracks.map((tr, i) => {
    const n = tr.pitch.length;
    const step = Math.max(1, Math.floor(n / 240));
    const pts = [];
    for (let j = 0; j < n; j += step) pts.push({ t: (tr.f0 + j) / bake.rate, m: tr.pitch[j] });
    pts.push({ t: (tr.f0 + n - 1) / bake.rate, m: tr.pitch[n - 1] });
    return { key: `w${i}`, name: `Wave ${i + 1}`, pts };
  });
}

/** View that shows the whole piece and pitch range (with a margin for the t = 0 editor). */
export function fitWaveView(p) {
  return { tMin: roundTo(-0.028 * p.length, 3), tMax: roundTo(p.length * 1.02, 3), midiMin: p.pLo - 4, midiMax: p.pHi + 4 };
}

/** Replace the document by a preset (undoable). / 프리셋 적용 (실행 취소 가능) */
export function applyWavePreset(id) {
  const doc = createWavePreset(id);
  Object.assign(doc.view, fitWaveView(doc));
  return StudioRegistry.setParams(WAVE_ID, sanitizeWaveParams(doc));
}

/** Frequency of every bin: fᵢ = midiToFreq(pLo + i·Δp). / 빈별 주파수 */
export function waveBinFrequencies(bake) {
  const f = new Float32Array(bake.N);
  for (let i = 0; i < bake.N; i++) f[i] = midiToFreq(bake.pLo + i * bake.dp);
  return f;
}

/** Seeded start phases (cycles) so the bins do not start in phase (no onset burst). / 시드 초기 위상 */
export function waveBinPhases(seed, n) {
  const rng = createSeededRandom((seed ^ 0x9e3779b9) >>> 0);
  const ph = new Float32Array(n);
  for (let i = 0; i < n; i++) ph[i] = rng();
  return ph;
}

function resample(src, m) {
  const n = src.length;
  const out = new Array(m);
  for (let j = 0; j < m; j++) {
    const pos = (j / (m - 1)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(pos));
    out[j] = src[i] + (src[i + 1] - src[i]) * (pos - i);
  }
  return out;
}

/**
 * Convert one ridge track to a Glissando Voice. Pitch: F0 = lowest, F1 = highest pitch of the
 * track, custom spline y(x) = (pitch − F0)/(F1 − F0); amplitude → gain points.
 * 리지 트랙 하나를 글리산도 보이스로 변환 (F0 = 최저, F1 = 최고 음고, 진폭 → 게인 포인트).
 */
export function trackToVoice(tr, bake, params, helpers, index) {
  const n = tr.pitch.length;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < n; j++) {
    if (tr.pitch[j] < lo) lo = tr.pitch[j];
    if (tr.pitch[j] > hi) hi = tr.pitch[j];
  }
  if (hi - lo < 0.5) {
    const mid = 0.5 * (lo + hi);
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  // Hz are stored with 2 decimals; derive the mapping from the rounded values so it is exact.
  // Hz는 소수 2자리로 저장되므로, 반올림된 값에서 매핑을 유도해 오차를 없앰.
  const f0Hz = roundTo(midiToFreq(lo), 2);
  const f1Hz = roundTo(midiToFreq(hi), 2);
  const m0 = freqToMidi(f0Hz);
  const span = Math.max(1e-6, freqToMidi(f1Hz) - m0);
  const m = clamp(n, 2, 1600); // keep the corners of a reflecting ridge sharp / 반사 지점의 모서리 유지
  const pitch = resample(tr.pitch, m);
  const dense = pitch.map((v, j) => ({ x: roundTo(j / (m - 1), 5), y: roundTo((v - m0) / span, 5), handles: [] }));
  // includeTransforms forces a real adaptive fit (a plain custom source would be copied as-is)
  // includeTransforms: 원본을 그대로 복사하지 않고 실제 적응형 근사 수행
  const customPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.002, maxAnchors: 64, samples: clamp(n, 480, 1600), includeTransforms: true });
  const mg = clamp(n, 2, 240);
  const amp = resample(tr.amp, mg);
  const gDense = amp.map((v, j) => ({ x: roundTo(j / (mg - 1), 5), y: roundTo(clamp(v, 0, 1), 4), handles: [] }));
  const gainPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: gDense, reverse: false, inverse: false }, { tolerance: 0.01, maxAnchors: 32, includeTransforms: true })
    .map((q) => ({ ...q, y: roundTo(clamp(q.y, 0, 1), 4) }));
  return helpers.createDefaultVoice(index, {
    name: `Wave ${index + 1}`,
    startTime: roundTo(tr.f0 / bake.rate, 4),
    duration: roundTo(Math.max(0.05, (n - 1) / bake.rate), 4),
    baseGain: roundTo(clamp(0.85 * params.sonify.gain, 0, 1.5), 3),
    f0Hz,
    f1Hz,
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(params.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints,
    gainMode: 'points',
    gainPoints,
  });
}

/** Pitch (MIDI) of a baked voice at normalised time x — used to check bake fidelity. */
export function voicePitchAt(voice, x) {
  const m0 = freqToMidi(voice.f0Hz);
  return m0 + (freqToMidi(voice.f1Hz) - m0) * evaluateCurveObjectY(voice, x);
}

/** Worst pitch error (semitones) between a ridge track and the voice baked from it. */
export function trackVoiceError(tr, voice, samples = 200) {
  let worst = 0;
  const n = tr.pitch.length;
  for (let j = 0; j <= samples; j++) {
    const x = j / samples;
    const pos = x * (n - 1);
    const i = Math.min(n - 2, Math.floor(pos));
    const want = tr.pitch[i] + (tr.pitch[i + 1] - tr.pitch[i]) * (pos - i);
    worst = Math.max(worst, Math.abs(voicePitchAt(voice, x) - want));
  }
  return worst;
}

/** Baked result as plain JSON (document, bake facts, ridge tracks, decimated field). / 내보내기 JSON */
export function buildWaveExport(params = getWaveParams()) {
  const bake = bakeWave(params);
  const ridges = extractRidges(bake, params.sonify);
  const { view, ...doc } = params;
  const stepF = Math.max(1, Math.ceil(bake.frames / 240));
  const rows = [];
  for (let f = 0; f < bake.frames; f += stepF) {
    const row = new Array(bake.N);
    for (let i = 0; i < bake.N; i++) row[i] = Number(bake.U[f * bake.N + i].toFixed(4));
    rows.push(row);
  }
  return {
    plugin: 'FlexatoneWaveStudio',
    version: '0.1',
    document: doc,
    bake: {
      Nx: bake.N, frames: bake.frames, frameRate: Number(bake.rate.toFixed(4)), lengthSec: Number(bake.length.toFixed(4)),
      pLo: bake.pLo, pHi: bake.pHi, semitonesPerBin: Number(bake.dp.toFixed(6)),
      cfl: Number(bake.cfl.toFixed(4)), dt: Number(bake.dt.toFixed(6)), steps: bake.steps,
      energyError: bake.energyErr === null ? null : Number(bake.energyErr.toExponential(3)),
    },
    tracks: ridges.tracks.map((tr) => {
      const step = Math.max(1, Math.ceil(tr.pitch.length / 400));
      const pts = [];
      for (let j = 0; j < tr.pitch.length; j += step) pts.push({ t: Number(((tr.f0 + j) / bake.rate).toFixed(3)), midi: Number(tr.pitch[j].toFixed(3)), amp: Number(tr.amp[j].toFixed(3)) });
      return { startSec: Number((tr.f0 / bake.rate).toFixed(3)), durSec: Number(((tr.pitch.length - 1) / bake.rate).toFixed(3)), points: pts };
    }),
    field: { frameStep: stepF, rows },
  };
}

export const WaveStudio = {
  id: WAVE_ID,
  name: { en: 'Wave Studio', ko: '웨이브 스튜디오' },
  description: { en: 'Wave equations on the pitch axis, baked at edit time', ko: '음고 축 위의 파동 방정식 — 에디팅 시점 베이킹' },
  order: 100,
  status: 'ready',
  usesVoiceEditor: false,
  /** Rendered by its own workspace, not by the generic studio panel. / 전용 작업 공간 사용 */
  schema: [],
  workspace: 'wave',
  defaultParams: createDefaultWaveParams,
  generateVoices(params, helpers) {
    const p = sanitizeWaveParams(params);
    const bake = bakeWave(p);
    const { tracks } = extractRidges(bake, p.sonify);
    return tracks.slice(0, MAX_GENERATED_VOICES).map((tr, i) => trackToVoice(tr, bake, p, helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(WaveStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const doc = (over = {}) => sanitizeWaveParams({ ...createDefaultWaveParams(), ...over });
const pulse = (over = {}) => ({ kind: 'gauss', x: 0.5, width: 2, amp: 1, mode: 3, velocity: 0, ...over });

/** Sub-bin position of the maximum of fn(i) over [lo, hi]. / 최댓값의 보간 위치 */
function peakPos(fn, lo, hi) {
  let best = lo;
  for (let i = lo; i <= hi; i++) if (fn(i) > fn(best)) best = i;
  if (best <= lo || best >= hi) return best;
  const l = fn(best - 1);
  const s = fn(best);
  const r = fn(best + 1);
  const den = l - 2 * s + r;
  return den < 0 ? best + clamp((0.5 * (l - r)) / den, -0.5, 0.5) : best;
}

registerSelfCheck('Wave: registered, deterministic defaults, CFL violation clamped → finite', (a) => {
  a.ok(StudioRegistry.has(WAVE_ID), 'registered');
  a.equal(JSON.stringify(createDefaultWaveParams()), JSON.stringify(createDefaultWaveParams()), 'defaults are deterministic (stable bake cache)');
  for (const id of WAVE_PRESET_IDS) {
    const p = sanitizeWaveParams(createWavePreset(id));
    a.equal(JSON.stringify(sanitizeWaveParams(p)), JSON.stringify(p), `sanitize is idempotent (${id})`);
  }
  const finite = (b) => b.finite && b.U.every((v) => Number.isFinite(v)) && b.W.every((v) => Number.isFinite(v));
  const b1 = simulateWave(doc({ cfl: 2, length: 3 }));
  a.ok(b1.clamped && b1.cfl <= 1 + 1e-9, `CFL 2 → ${b1.cfl.toFixed(3)}`);
  a.ok(finite(b1) && b1.uMax < 2.5, `finite, bounded (max |u| ${b1.uMax.toFixed(3)})`);
  const b2 = simulateWave(doc({ cfl: 2, length: 3, dispersion: 2, speed: 60 }));
  a.ok(b2.clamped && finite(b2) && b2.uMax < 2.5, `stiff string stays finite (CFL ${b2.cfl.toFixed(3)})`);
  const b3 = simulateWave(doc({ eq: 'kg', cfl: 2, length: 3, mass: 40 }));
  a.ok(finite(b3) && b3.uMax < 2.5, 'Klein–Gordon stays finite');
}, { group: 'studio' });

registerSelfCheck('Wave: energy conserved over 10⁴ leapfrog steps (undamped, fixed / free / graded medium)', (a) => {
  const N = 128;
  const dx = 60 / (N - 1);
  const run = (boundary, graded) => {
    const c = new Float64Array(N);
    const u0 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      c[i] = graded ? 8 + (12 * i) / (N - 1) : 12;
      u0[i] = Math.exp(-0.5 * ((i * dx - 30) / 2) ** 2);
    }
    const sim = createWaveSim({ eq: 'wave', N, dx, c, boundary, cfl: 0.9, u0 });
    const e0 = sim.energy();
    let worst = 0;
    for (let s = 1; s <= 10000; s++) {
      sim.step();
      if (s % 40 === 0) worst = Math.max(worst, Math.abs(sim.energy() - e0) / e0);
    }
    return worst;
  };
  const fixed = run('fixed', false);
  a.ok(fixed < 0.01, `fixed: relative energy error ${fixed.toExponential(2)}`);
  const free = run('free', true);
  a.ok(free < 0.01, `free + graded c(x): ${free.toExponential(2)}`);
  const per = run('periodic', false);
  a.ok(per < 0.01, `periodic: ${per.toExponential(2)}`);
}, { group: 'studio' });

registerSelfCheck('Wave: pulse speed = c ± 2 % (uniform medium)', (a) => {
  const p = doc({ boundary: 'absorbing', length: 3, init: [pulse({ x: 0.2, velocity: 1 })] });
  const b = simulateWave(p);
  const at = (sec) => peakPos((i) => b.U[Math.round(sec * b.rate) * b.N + i], 0, b.N - 1) * b.dp;
  const v = (at(2.5) - at(0.5)) / 2;
  a.near(v, p.speed, 0.02 * p.speed, 'measured speed (st/s)');
  // graded medium: the local speed follows c(x) / 매질 경사에서는 국소 속도가 c(x)를 따름
  const q = doc({ boundary: 'absorbing', length: 3, c: { engine: 'custom', customPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, cLo: 0.5, cHi: 2, init: [pulse({ x: 0.1, velocity: 1, width: 1.5 })] });
  const g = simulateWave(q);
  const gat = (sec) => peakPos((i) => g.U[Math.round(sec * g.rate) * g.N + i], 0, g.N - 1) * g.dp;
  const vLow = (gat(0.6) - gat(0.2)) / 0.4;
  const vHigh = (gat(2.6) - gat(2.2)) / 0.4;
  a.ok(vHigh > vLow * 1.3, `pulse accelerates in the faster medium (${vLow.toFixed(2)} → ${vHigh.toFixed(2)} st/s)`);
}, { group: 'studio' });

registerSelfCheck('Wave: reflection — fixed inverts, free keeps the sign, absorbing leaves < 5 % energy', (a) => {
  const run = (boundary) => simulateWave(doc({ boundary, length: 2.2, init: [pulse({ x: 0.8, velocity: 1 })] }));
  const peakValue = (b, sec) => {
    const row = Math.round(sec * b.rate) * b.N;
    let best = 0;
    for (let i = 0; i < b.N; i++) if (Math.abs(b.U[row + i]) > Math.abs(b.U[row + best])) best = i;
    return b.U[row + best];
  };
  const fixed = peakValue(run('fixed'), 2);
  a.ok(fixed < -0.8, `fixed: reflected pulse is inverted (${fixed.toFixed(3)})`);
  const free = peakValue(run('free'), 2);
  a.ok(free > 0.8, `free: reflected pulse keeps its sign (${free.toFixed(3)})`);
  const ab = run('absorbing');
  const energy = (sec) => {
    const row = Math.round(sec * ab.rate) * ab.N;
    let e = 0;
    for (let i = 0; i < ab.N; i++) e += ab.W[row + i];
    return e;
  };
  const left = energy(2) / energy(0);
  a.ok(left < 0.05, `absorbing: residual energy ${(left * 100).toFixed(2)} %`);
}, { group: 'studio' });

registerSelfCheck('Wave: standing mode n oscillates with period 2L/(n·c)', (a) => {
  for (const n of [3, 5]) {
    const p = doc({ length: 4, init: [{ kind: 'standing', x: 0.5, width: 2, amp: 1, mode: n, velocity: 0 }] });
    const b = simulateWave(p);
    const bin = Math.round((b.N - 1) / (2 * n)); // first antinode / 첫 배
    const s = (f) => b.U[f * b.N + bin];
    const zeros = [];
    for (let f = 1; f < b.frames && zeros.length < 2; f++) {
      if ((s(f - 1) > 0) !== (s(f) > 0)) zeros.push((f - 1 + s(f - 1) / (s(f - 1) - s(f))) / b.rate);
    }
    a.equal(zeros.length, 2, `two zero crossings (n = ${n})`);
    const T = 2 * (zeros[1] - zeros[0]);
    const want = (2 * (p.pHi - p.pLo)) / (n * p.speed);
    a.near(T, want, 0.01 * want, `period n = ${n}`);
  }
}, { group: 'studio' });

registerSelfCheck('Wave: sine-Gordon kinks travel at v and keep it through a collision (± 5 %)', (a) => {
  const mk = (x, amp, velocity) => ({ kind: 'kink', x, width: 2, amp, mode: 3, velocity });
  const p = doc({ eq: 'sg', Nx: 256, mass: 4, length: 5, init: [mk(0.25, 1, 0.5), mk(0.75, -1, -0.5)] });
  const b = simulateWave(p);
  const half = b.N >> 1;
  const lump = (sec) => peakPos((i) => b.W[Math.round(sec * b.rate) * b.N + i], half, b.N - 2) * b.dp;
  const want = 0.5 * p.speed;
  const before = (lump(1.4) - lump(0.4)) / 1.0;
  const after = (lump(4.6) - lump(3.6)) / 1.0;
  a.near(-before, want, 0.05 * want, 'speed before the collision (moving down)');
  a.near(after, want, 0.05 * want, 'speed after the collision (moving up)');
  // Pass-through, not a bounce: the plateau between the kinks flips 2π → −2π. / 통과 (반사 아님)
  const mid = (sec) => b.U[Math.round(sec * b.rate) * b.N + half];
  a.ok(mid(0.4) > 5.5 && mid(4.6) < -5.5, `plateau ${mid(0.4).toFixed(2)} → ${mid(4.6).toFixed(2)}`);
  a.ok(b.energyErr !== null && b.energyErr < 0.02, `energy drift ${(b.energyErr * 100).toFixed(3)} %`);
}, { group: 'studio' });

registerSelfCheck('Wave: Gray–Scott stability clamp, u and v stay in [0, 1.1], pattern forms', (a) => {
  const p = sanitizeWaveParams(createWavePreset('bloom'));
  const N = 128;
  const dx = (p.pHi - p.pLo) / (N - 1);
  const { u0, v0 } = buildInitialState(p, N, dx, mediumProfile(p, N));
  const sim = createGsSim({ N, dx, boundary: 'free', Du: 5, Dv: 2.5, F: 0.03, k: 0.057, dtReq: 1, u0, v0 });
  a.ok(sim.clamped && sim.cfl <= 0.5, `diffusion number ${sim.cfl.toFixed(3)} (${sim.sub} sub-steps)`);
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s < 4000; s++) sim.step();
  for (let i = 0; i < N; i++) {
    lo = Math.min(lo, sim.u[i], sim.v[i]);
    hi = Math.max(hi, sim.u[i], sim.v[i]);
  }
  a.ok(Number.isFinite(lo) && lo >= 0 && hi <= 1.1, `range [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  const b = simulateWave(p);
  let peaks = 0;
  const row = (b.frames - 1) * b.N;
  for (let i = 1; i < b.N - 1; i++) if (b.U[row + i] > 0.1 && b.U[row + i] > b.U[row + i - 1] && b.U[row + i] >= b.U[row + i + 1]) peaks++;
  a.ok(b.finite && b.uMax <= 1.1 && peaks >= 4, `bloom preset: ${peaks} pulses at the end, max v ${b.uMax.toFixed(3)}`);
}, { group: 'studio' });

registerSelfCheck('Wave: ridge tracking — one moving pulse = one continuous track; crossing keeps the count', (a) => {
  const p = doc({ boundary: 'absorbing', length: 3, init: [pulse({ x: 0.2, velocity: 1 })] });
  const b = simulateWave(p);
  const { tracks } = extractRidges(b, p.sonify);
  a.equal(tracks.length, 1, 'single pulse → one track');
  const tr = tracks[0];
  let jump = 0;
  for (let j = 1; j < tr.pitch.length; j++) jump = Math.max(jump, Math.abs(tr.pitch[j] - tr.pitch[j - 1]));
  a.ok(jump <= p.sonify.maxJump && jump < 0.5, `continuous (largest step ${jump.toFixed(3)} st / frame)`);
  a.ok(tr.pitch.length >= 0.95 * b.frames, 'covers the whole piece');
  a.near((tr.pitch[250] - tr.pitch[50]) / 2, p.speed, 0.03 * p.speed, 'track slope = wave speed');
  // Policy: two pulses crossing within maxGap keep the track count (2 → 2). / 교차 정책
  const q = doc({ boundary: 'absorbing', length: 3, init: [pulse({ x: 0.3, velocity: 1, width: 1.5 }), pulse({ x: 0.7, velocity: -1, width: 1.5 })] });
  const cross = extractRidges(simulateWave(q), q.sonify).tracks;
  a.equal(cross.length, 2, 'crossing pulses → still two tracks');
  a.ok(cross.every((t) => t.pitch.length >= 0.9 * b.frames), 'both tracks survive the crossing');
  const up = cross.find((t) => t.pitch[0] < 60);
  a.ok(up && up.pitch[up.pitch.length - 1] > 75, 'identity follows the motion (the rising pulse keeps rising)');
  // maxTracks caps the result / 트랙 수 상한
  const chord = sanitizeWaveParams(createWavePreset('chord'));
  chord.sonify.maxTracks = 3;
  a.ok(extractRidges(simulateWave(chord), chord.sonify).tracks.length <= 3, 'maxTracks respected');
}, { group: 'studio' });

registerSelfCheck('Wave: determinism (seed) and bake cache (sound parameters never re-bake)', (a) => {
  const noise = (seed) => doc({ length: 2.37, seed, init: [{ kind: 'noise', x: 0.5, width: 2, amp: 1, mode: 3, velocity: 0 }] });
  const b1 = simulateWave(noise(7));
  const b2 = simulateWave(noise(7));
  let same = b1.U.length === b2.U.length;
  for (let j = 0; same && j < b1.U.length; j++) same = b1.U[j] === b2.U[j];
  a.ok(same, 'same seed → bit-identical field');
  const b3 = simulateWave(noise(8));
  let differs = false;
  for (let j = 0; !differs && j < b1.U.length; j++) differs = b1.U[j] !== b3.U[j];
  a.ok(differs, 'different seed → different field');
  withIsolatedWaveCache(() => {
  const p = noise(7);
  const before = getWaveBakeCount();
  const m1 = bakeWave(p);
  const m2 = bakeWave(deepClone(p));
  a.ok(m1 === m2, 'same physics → cached (no re-simulation)');
  a.ok(getWaveBakeCount() - before <= 1, 'simulated at most once');
  const count = getWaveBakeCount();
  const q = deepClone(p);
  Object.assign(q.sonify, { mode: 'ridge', source: 'energy', gain: 2.5, ampPower: 2, peakThresh: 0.3, stereo: 1 });
  q.timbre.saw = 1;
  q.view.color = 'energy';
  a.ok(bakeWave(q) === m1 && getWaveBakeCount() === count, 'sonification / view edits keep the cache (0 re-bakes)');
  a.ok(buildAmplitude(m1, p.sonify) === buildAmplitude(m1, deepClone(p.sonify)), 'amplitude matrix cached per sound setting');
  a.ok(buildAmplitude(m1, q.sonify) !== undefined && getWaveBakeCount() === count, 'new sound setting → new matrix, still 0 re-bakes');
  q.damping = 0.3;
  a.ok(bakeWave(q) !== m1 && getWaveBakeCount() === count + 1, 'physics change re-bakes once');
  });
}, { group: 'studio' });

registerSelfCheck('Wave: spectral bank — self-contained, no allocation in process(), phase-continuous', (a) => {
  const src = WaveSpectralBank.toString();
  a.ok(!/\bimport\b|\bdocument\b|\bwindow\b|AudioContext/.test(src), 'no imports / DOM / Web Audio in the class');
  const body = WaveSpectralBank.prototype.process.toString() + WaveSpectralBank.prototype.rowAt.toString();
  a.ok(!/\bnew\b|\[\s*\]|\.slice\(|\.map\(|\.concat\(|Array\(|\{\s*\}/.test(body), 'process() / rowAt() source allocates nothing');
  const fs = 48000;
  const bins = 6;
  const frames = 12;
  const freqs = [220, 277.18, 330, 440, 554.37, 30000];
  const bank = new WaveSpectralBank(fs, bins, frames, { frameRate: 100, freqs, phases: [0.25, 0, 0, 0, 0, 0], scale: 1 });
  const M = new Float32Array(frames * bins);
  for (let f = 0; f < frames; f++) { M[f * bins] = 0.5; M[f * bins + 5] = 1; }
  a.ok(bank.setChunk(0, M) && !bank.setChunk(frames, M), 'chunk bounds checked');
  const keep = [bank.M, bank.inc, bank.ph, bank.a0, bank.a1, bank.gl, bank.gr, bank.tab];
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  const out = new Float32Array(128 * 30);
  for (let blk = 0; blk < 30; blk++) {
    bank.process(L, R, 128, (blk * 128 * 100) / fs, ((blk + 1) * 128 * 100) / fs);
    out.set(L, blk * 128);
  }
  const now = [bank.M, bank.inc, bank.ph, bank.a0, bank.a1, bank.gl, bank.gr, bank.tab];
  a.ok(keep.every((arr, i) => arr === now[i]), 'buffers are reused (same array objects after 30 blocks)');
  // bin 0 = 0.5·sin(2π(220·t + 0.25)) across block borders; bin 5 (30 kHz) is muted by the Nyquist guard.
  let worst = 0;
  for (let s = 0; s < out.length; s++) worst = Math.max(worst, Math.abs(out[s] - 0.5 * Math.sin(2 * Math.PI * ((220 * s) / fs + 0.25))));
  a.ok(worst < 1e-4, `phase-continuous sine, Nyquist bin silent (max error ${worst.toExponential(2)})`);
  bank.process(L, R, 128, frames + 5, frames + 6);
  bank.process(L, R, 128, frames + 6, frames + 7);
  a.ok(L.every((v) => v === 0), 'silent past the last frame');
}, { group: 'studio' });

registerSelfCheck('Wave: bake to Glissando — ≤ 64 voices, curve follows the ridge, state untouched', (a) => {
  const p = doc({ length: 6 }); // single pulse: splits, reflects at both walls / 갈라져 양쪽 벽에서 반사
  const bake = simulateWave(p);
  const { tracks } = extractRidges(bake, p.sonify);
  a.ok(tracks.length >= 2 && tracks.length <= p.sonify.maxTracks, `${tracks.length} tracks`);
  const helpers = { createDefaultVoice: (i, o) => ({ index: i, ...o }), startIndex: 0 };
  const v = trackToVoice(tracks[0], bake, p, helpers, 0);
  a.ok(v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.length <= 160, `adaptive spline (${v.customPoints.length} anchors)`);
  a.ok(v.customPoints.every((q, i, arr) => i === 0 || q.x > arr[i - 1].x), 'anchors strictly increasing in x');
  const err = trackVoiceError(tracks[0], v);
  a.ok(err < 0.25, `worst pitch error ${err.toFixed(3)} st`);
  a.ok(v.gainPoints.every((q) => q.y >= 0 && q.y <= 1), 'gain points in [0, 1]');
  withIsolatedWaveCache(() => withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    const params = JSON.stringify(appState.studioParams);
    const voices = StudioRegistry.generateVoices(WAVE_ID, p);
    a.ok(voices.length >= 1 && voices.length <= MAX_GENERATED_VOICES, `${voices.length} voices`);
    a.ok(voices.every((x) => x.engine === 'custom' && x.duration >= 0.05 && /^v_/.test(x.id)), 'contract-conforming voices');
    a.equal(JSON.stringify(appState.voices), before, 'voices untouched by generateVoices');
    a.equal(JSON.stringify(appState.studioParams), params, 'studio params untouched');
    const many = sanitizeWaveParams(createWavePreset('bloom'));
    many.sonify.maxTracks = WAVE_MAX_TRACKS;
    many.sonify.peakThresh = 0.02;
    a.ok(StudioRegistry.generateVoices(WAVE_ID, many).length <= MAX_GENERATED_VOICES, 'never more than 64 voices');
  }));
}, { group: 'studio' });

registerSelfCheck('Wave: Manager — documents resolve apart, detached bake, tempo re-timing keeps the field, Master View lines', (a) => {
  const docA = { ...createWavePreset('pulse'), length: 4 };
  const pA = resolveWaveDoc(docA);
  a.ok(resolveWaveDoc(docA) === pA && resolveWaveDoc(pA) === pA, 'memoised per stored document, idempotent on full params');
  a.ok(resolveWaveDoc(null) === resolveWaveDoc(undefined) && resolveWaveDoc(null).length === 30, 'null = studio defaults');
  a.equal(pA.length, 4, 'stored fields win over defaults');
  const b = simulateWave(pA);
  a.near(waveTimelineEnd(pA), b.length, 1e-9, 'clip length without simulating');
  const long = sanitizeWaveParams({ ...createDefaultWaveParams(), Nx: 256, length: 120, bakeRate: 200 });
  a.near(waveTimelineEnd(long), 120, 1e-9, 'rate-clamped documents keep their length');
  // A document that is not on screen never raises the editor's bake counter. / 화면 밖 문서는 베이킹 횟수 불변
  withIsolatedState(() => {
    appState.studioParams = { ...(appState.studioParams || {}) };
    delete appState.studioParams[WAVE_ID];
    a.ok(getWaveParams() !== pA, 'docA is not the editor document');
    const count = getWaveBakeCount();
    const d1 = getWaveBake(pA);
    a.ok(getWaveBake(pA) === d1 && getWaveBakeCount() === count, 'detached cache, counter untouched');
  });
  // Tempo: same matrix, other frame rate → same pitches, time ÷ rate. / 템포: 행렬 공유, 시간만 ÷ 배속
  const fast = retimeWaveBake(b, 2);
  a.ok(fast.U === b.U && fast.frames === b.frames && fast.dp === b.dp, 'matrix and pitch grid shared');
  a.near(fast.length, b.length / 2, 1e-12, 'half as long at ×2');
  a.near(fast.rate, 2 * b.rate, 1e-12, 'frame rate ×2');
  a.ok(retimeWaveBake(b, 1) === b && fast.sig !== b.sig, 'rate 1 is the identity; other rates get their own key');
  const lines = waveMasterLines(docA);
  a.ok(lines.length >= 2, `${lines.length} ridge lines`);
  a.ok(lines.every((l) => l.pts.length >= 2 && l.pts.every((q) => q.t >= 0 && q.t <= 4 + 1e-6 && q.m >= pA.pLo - 1 && q.m <= pA.pHi + 1)), 'lines stay inside the clip and the pitch range');
}, { group: 'studio' });

registerSelfCheck('Wave: Manager — two instances keep separate documents through focus swaps', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    appState.studioParams = { ...(appState.studioParams || {}), [WAVE_ID]: createWavePreset('kink') };
    const w1 = addInstance(WAVE_ID); // the first instance takes over the editor document / 첫 인스턴스 = 에디터 문서
    focusInstance(w1.id);
    a.equal(getWaveParams().eq, 'sg', 'first instance shows the editor document');
    const w2 = addInstance(WAVE_ID);
    a.ok(focusInstance(w2.id), 'focus moved to the second instance');
    a.equal(getWaveParams().eq, 'wave', 'second instance starts from the defaults');
    a.equal(resolveWaveDoc(getInstance(w1.id).doc).eq, 'sg', 'first document stored in its instance');
    editWave((d) => { d.length = 7; });
    focusInstance(w1.id);
    a.equal(getWaveParams().eq, 'sg', 'first document restored');
    a.equal(resolveWaveDoc(getInstance(w2.id).doc).length, 7, 'second document kept its edit');
    a.near(waveTimelineEnd(resolveWaveDoc(getInstance(w2.id).doc)), 7, 1e-9, 'clip length follows the stored document');
  });
}, { group: 'studio' });

// --- Schrödinger / diffusion (quantum + fluid presets) -------------------------------------

/** Mean and standard deviation (in st) of one baked row of a density field. / 밀도 행의 평균·표준편차 */
function rowMoments(b, sec) {
  const r = Math.round(sec * b.rate) * b.N;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < b.N; i++) { const w = b.U[r + i]; const x = i * b.dp; s0 += w; s1 += w * x; s2 += w * x * x; }
  const m = s1 / s0;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / s0 - m * m)), mass: s0 * b.dp };
}

registerSelfCheck('Wave: Schrödinger — norm conserved (Crank–Nicolson), free packet spreads as σ₀·√(1 + (D t/σ₀²)²)', (a) => {
  const base = { eq: 'schrod', boundary: 'fixed', length: 3, qm: { D: 2 }, init: [pulse({ x: 0.5, width: 1.5 })] };
  const b = simulateWave(doc(base));
  const m0 = rowMoments(b, 0);
  const m3 = rowMoments(b, 3);
  a.near(m3.mass / m0.mass, 1, 1e-3, 'norm after 3 s');
  const s0 = 1.5 / Math.SQRT2;
  a.near(m3.std, s0 * Math.sqrt(1 + ((2 * 3) / (s0 * s0)) ** 2), 0.04 * m3.std, 'σ(3 s)');
  const bf = simulateWave(doc({ ...base, boundary: 'free' }));
  a.near(rowMoments(bf, 3).mass / rowMoments(bf, 0).mass, 1, 1e-3, 'norm with Neumann ends');
  const pk = simulateWave(doc({ ...base, boundary: 'absorbing', init: [pulse({ x: 0.2, width: 1.5, velocity: 1 })], length: 12 }));
  a.near(rowMoments(pk, 1).mean - rowMoments(pk, 0).mean, 6, 0.4, 'group velocity = velocity·vmax');
  a.ok(rowMoments(pk, 12).mass < 0.1 * rowMoments(pk, 0).mass, 'absorbing ends swallow the packet');
}, { group: 'studio' });

registerSelfCheck('Wave: Schrödinger — infinite-well revival and harmonic coherent state', (a) => {
  // Well: E_n = D(nπ/L)², modes 1 + 2 + 3 → exact revival at t = 2π/E₁ (E_n/E₁ = n²)
  const w = sanitizeWaveParams(createWavePreset('well'));
  const L = w.pHi - w.pLo;
  const E1 = w.qm.D * (Math.PI / L) ** 2;
  const T = (2 * Math.PI) / E1;
  a.ok(T < w.length, `revival time ${T.toFixed(2)} s fits the preset`);
  const b = simulateWave({ ...w, length: Math.ceil(T) + 1 });
  const row = (sec) => Array.from(b.U.subarray(Math.round(sec * b.rate) * b.N, (Math.round(sec * b.rate) + 1) * b.N));
  const diff = (x, y) => Math.sqrt(x.reduce((q, v, i) => q + (v - y[i]) ** 2, 0) / x.reduce((q, v) => q + v * v, 0));
  a.ok(diff(row(0), row(T)) < 0.06, `|ψ|² returns after T (${diff(row(0), row(T)).toFixed(3)})`);
  a.ok(diff(row(0), row(T / 3)) > 0.3, '… and differs in between');
  // Harmonic oscillator: a Gaussian of width ℓ = √(2D/Ω) oscillates without changing its width, period 2π/Ω
  const h = sanitizeWaveParams(createWavePreset('oscillator'));
  a.near(harmonicLength(h.qm), h.init[0].width, 1e-9, 'preset width = ground-state length ℓ');
  const hb = simulateWave({ ...h, boundary: 'fixed', length: 14 });
  const P = (2 * Math.PI) / h.qm.omega;
  const m0 = rowMoments(hb, 0);
  const mHalf = rowMoments(hb, P / 2);
  const mFull = rowMoments(hb, P);
  const centre = 0.5 * (h.pHi - h.pLo);
  a.near(mHalf.mean - centre, -(m0.mean - centre), 0.8, 'half period: mirrored about the centre');
  a.near(mFull.mean, m0.mean, 0.8, 'full period: back to the start');
  a.near(mFull.std, m0.std, 0.06 * m0.std, 'coherent state keeps its width');
  a.near(hermiteFunction(0, 0), 1, 1e-12, 'Hermite n = 0');
  a.near(hermiteFunction(2, 0), -2 / Math.sqrt(8), 1e-9, 'Hermite n = 2 at 0: H₂(0) = −2, scaled');
}, { group: 'studio' });

registerSelfCheck('Wave: Schrödinger — tunnelling splits the packet; a lower barrier transmits more', (a) => {
  const frac = (V0) => {
    const p = sanitizeWaveParams(createWavePreset('tunnel'));
    p.boundary = 'fixed';
    p.qm.V0 = V0;
    p.length = 16;
    const b = simulateWave(p);
    const r = Math.round(16 * b.rate) * b.N;
    const ib = Math.round(((p.qm.vx * (p.pHi - p.pLo)) / b.dp));
    let left = 0;
    let right = 0;
    for (let i = 0; i < b.N; i++) { if (i < ib - 4) left += b.U[r + i]; else if (i > ib + 4) right += b.U[r + i]; }
    return { T: right / (left + right), norm: (left + right) * b.dp };
  };
  const hi = frac(4);
  const lo = frac(1.6);
  a.ok(lo.T > 0.02 && lo.T < 0.6, `partial transmission T = ${lo.T.toFixed(3)}`);
  a.ok(lo.T > hi.T * 2, `lower barrier transmits more (${lo.T.toFixed(3)} vs ${hi.T.toFixed(3)})`);
}, { group: 'studio' });

registerSelfCheck('Wave: diffusion — Stokes layer decays as e^(−y/δ); Poiseuille start-up → parabola G·y(L−y)/2ν', (a) => {
  const s = sanitizeWaveParams(createWavePreset('stokes'));
  const delta = Math.sqrt((2 * s.dif.nu) / (2 * Math.PI * s.dif.wallHz));
  const b = simulateWave({ ...s, length: 12 });
  const amp = (y) => {
    const i = Math.round(y / b.dp);
    let m = 0;
    for (let f = Math.round(6 * b.rate); f < b.frames; f++) m = Math.max(m, Math.abs(b.U[f * b.N + i]));
    return m;
  };
  a.near(amp(0), 1, 1e-6, 'wall amplitude');
  a.near(amp(delta) / amp(0), Math.exp(-1), 0.04, 'amplitude at y = δ is e⁻¹');
  a.near(amp(2 * delta) / amp(0), Math.exp(-2), 0.03, 'amplitude at y = 2δ is e⁻²');
  const q = sanitizeWaveParams(createWavePreset('poiseuille'));
  const L = q.pHi - q.pLo;
  const pb = simulateWave({ ...q, length: 60 });
  const mid = Math.round((pb.N - 1) / 2);
  const last = (pb.frames - 1) * pb.N;
  a.near(pb.U[last + mid], (q.dif.force * (0.5 * L) * (0.5 * L)) / (2 * q.dif.nu), 0.02, 'centre-line velocity G·L²/8ν');
  const i4 = Math.round((pb.N - 1) / 4);
  a.near(pb.U[last + i4] / pb.U[last + mid], 0.75, 0.02, 'quarter-width ratio 3/4 (parabola)');
  a.near(pb.U[last], 0, 1e-12, 'no slip at the wall');
}, { group: 'studio' });
