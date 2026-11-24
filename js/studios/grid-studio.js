/**
 * Flexatone — studios/grid-studio.js
 * Layer 2 (studios): Grid Studio plugin — a painted time × pitch raster with image effects that are
 * translated into the matching sound operations ("image operation = the same operation on the
 * spectrogram").
 * 계층 2 (studios): 그리드 스튜디오 플러그인 — 칠하는 시간 × 음고 격자와, 소리 연산으로 번역되는 이미지 효과.
 *
 * Registers `GridStudio` with the StudioRegistry. The whole document (grid, render settings, layers
 * with their rasters and effect stacks, selection, view, tool) lives in appState.studioParams.grid,
 * so it is saved with the project and undoable. The workspace (canvases, panels, audio) lives in
 * studios/grid/grid-canvases.js, grid-panels.js and grid-audio.js — this file stays DOM- and
 * audio-free (architecture DAG).
 * 문서는 appState.studioParams.grid에 저장(저장·실행 취소 가능). UI/오디오는 별도 파일.
 *
 * Bake to Glissando Voices: ridge tracks of the PROCESSED matrix (the Result) become standard Voices.
 * Not carried over (a Voice has no such fields): noise, the fine structure of halftone gates and
 * glitch grains, stereo position; a blurred cluster is reduced to a few detuned voices.
 * 글리산도 보이스로 베이킹: 처리된 행렬(Result)의 리지 트랙 → 보이스. 노이즈·게이트 미세 구조·팬은 옮겨지지 않음.
 *
 * Imports: core/*, modules/*, studios/registry.js, studios/grid/grid-engine.js, grid-effects.js.
 */

import { clamp, roundTo, deepClone } from '../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../core/units.js';
import { appState } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';
import { trackRidges } from '../modules/ridge-tracker.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import { registerTrajectorySource } from './trajectory-link.js';
import './grid/grid-i18n.js'; // merges the EN/KO keys before any tab is drawn / 탭 표시 전에 번역 키 병합
import {
  createDefaultGridParams, createGridPreset, sanitizeGridParams, bakeGrid, bakeGridAsync, peekGridBake, gridSignature, gridDims,
  audibleLayers, bankItem, fitGridView, regridDocument, GRID_PRESET_IDS,
} from './grid/grid-engine.js';
import { GridEffectRegistry } from './grid/grid-effects.js';

export const GRID_ID = 'grid';

const docMemo = new WeakMap(); // stored document object → sanitised full params
const resolved = new WeakSet(); // params objects produced here (already sanitised)
let defaultDoc = null;

/**
 * Full, sanitised params of a stored Grid document (null / undefined = studio defaults). Memoised per
 * document object, so the editor and the Manager share one params object for the same stored
 * document. READ-ONLY. / 저장된 문서 → 정규화된 전체 파라미터 (문서 객체별 메모이즈, 읽기 전용)
 */
export function resolveGridDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    if (!defaultDoc) resolved.add(defaultDoc = sanitizeGridParams(createDefaultGridParams()));
    return defaultDoc;
  }
  if (resolved.has(doc)) return doc;
  let p = docMemo.get(doc);
  if (!p) {
    p = sanitizeGridParams(doc);
    docMemo.set(doc, p);
    resolved.add(p);
  }
  return p;
}

/** Grid document in the editor (READ-ONLY; use editGrid to change it). / 에디터의 그리드 문서 (읽기 전용) */
export function getGridParams() {
  return resolveGridDoc(appState.studioParams?.[GRID_ID]);
}

/**
 * Apply an edit to the Grid document. `fn(doc)` mutates a draft copy; picture and effect edits are
 * undoable, view / tool / selection edits pass { history: false }.
 * 그리드 문서 편집 (보기·도구·선택 변경은 history:false).
 */
export function editGrid(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getGridParams());
  fn(draft);
  return StudioRegistry.setParams(GRID_ID, sanitizeGridParams(draft), { history, coalesceKey });
}

/** Change range / resolution / length and resample every raster (undoable). / 격자 변경 + 래스터 리샘플 */
export function editGridShape(fn, opts = {}) {
  return editGrid((d) => { regridDocument(d, fn); }, opts);
}

/** Replace the document by a preset (undoable). / 프리셋 적용 (실행 취소 가능) */
export function applyGridPreset(id) {
  const doc = createGridPreset(id);
  Object.assign(doc.view, fitGridView(doc.grid));
  return StudioRegistry.setParams(GRID_ID, sanitizeGridParams(doc));
}

// --------------------------------------------------------------------------
// Bakes: full resolution (heard), preview (seen while dragging) / 베이킹: 전체 해상도(소리), 미리보기(드래그 중 화면)
// --------------------------------------------------------------------------

/**
 * Full-resolution bake, synchronously (memoised). Documents that are not on screen (Manager
 * instances) use a separate cache, so they neither evict the editor's bake nor raise its counter.
 * 전체 해상도 베이킹 (동기, 메모이즈). 화면 밖 문서는 별도 캐시 사용.
 */
export function getGridBake(params = getGridParams()) {
  return bakeGrid(params, { ns: params === getGridParams() ? 'edit' : 'detached' });
}

const bakeListeners = new Set();
let pendingTimer = null;
let pendingToken = 0;
let pendingSig = '';
let lastEditAt = 0;
let lastLatencyMs = 0;

/** Called with the finished full-resolution bake of the editor document. Returns unsubscribe. / 전체 베이킹 완료 알림 */
export function onGridBake(fn) {
  bakeListeners.add(fn);
  return () => bakeListeners.delete(fn);
}

/** Milliseconds from the last edit to its full-resolution bake (edit → sound latency). / 편집 → 소리 반영 지연 */
export const getGridEditLatency = () => lastLatencyMs;

function emitBake(bake) {
  for (const fn of [...bakeListeners]) { try { fn(bake); } catch (err) { console.error('[Grid] bake listener failed:', err); } }
}

/**
 * Make sure the full-resolution bake of the editor document gets computed: `delay` ms after the last
 * change (a slider drag bakes once it pauses), in slices. No-op when it is cached already.
 * 에디터 문서의 전체 해상도 베이킹 예약: 마지막 변경 후 delay ms 뒤, 조각으로 실행.
 */
export function requestGridBake(doc = getGridParams(), { delay = 150 } = {}) {
  const sig = gridSignature(doc);
  if (peekGridBake(doc)) { pendingSig = ''; return false; }
  if (sig === pendingSig) return true;
  pendingSig = sig;
  lastEditAt = (globalThis.performance || Date).now();
  const token = ++pendingToken;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    pendingTimer = null;
    const bake = await bakeGridAsync(doc, { ns: 'edit', shouldAbort: () => token !== pendingToken });
    if (!bake || token !== pendingToken) return;
    pendingSig = '';
    lastLatencyMs = (globalThis.performance || Date).now() - lastEditAt;
    emitBake(bake);
  }, delay);
  return true;
}

/**
 * What the Result window shows right now: the full-resolution bake when it is cached, else a
 * low-resolution preview computed at once (and the full bake is scheduled).
 * Result 윈도우가 지금 보여줄 것: 캐시된 전체 베이킹, 없으면 즉시 계산한 저해상도 미리보기 (+ 전체 베이킹 예약).
 * @returns {{ bake: object, pending: boolean }}
 */
export function getGridResult(doc = getGridParams()) {
  const full = peekGridBake(doc);
  if (full) return { bake: full, pending: false };
  requestGridBake(doc);
  return { bake: bakeGrid(doc, { ns: 'preview' }), pending: true };
}

/** Resolve with the full-resolution bake of the editor document (now, without the idle delay). / 지금 전체 베이킹 */
export async function gridBakeReady(doc = getGridParams()) {
  const hit = peekGridBake(doc);
  if (hit) return hit;
  const token = ++pendingToken;
  if (pendingTimer !== null) { clearTimeout(pendingTimer); pendingTimer = null; }
  pendingSig = '';
  const bake = await bakeGridAsync(doc, { ns: 'edit', shouldAbort: () => token !== pendingToken });
  if (bake) emitBake(bake);
  return bake || bakeGrid(doc);
}

/** Frequency of every bin: fᵢ = midiToFreq(pLo + i / binsPerSemi). / 빈별 주파수 */
export function gridBinFrequencies(dims) {
  const f = new Float64Array(dims.N);
  for (let i = 0; i < dims.N; i++) f[i] = midiToFreq(dims.pLo + i / dims.bps);
  return f;
}

// --------------------------------------------------------------------------
// Ridge tracks of the Result → Voices / Result의 리지 트랙 → 보이스
// --------------------------------------------------------------------------

/** Analysis rate of the ridge tracker (frames per second). / 리지 트래커 분석 속도 */
const TRACK_RATE = 50;
/** A ridge wider than this (cents, 1 σ) is a cluster: it gets two detuned companions. / 이보다 넓은 리지 = 클러스터 */
export const CLUSTER_CENTS = 18;

const trackMemo = new WeakMap(); // bake → Map(layerId → tracks)

/** Ridge tracks of one layer's processed matrix (cached per bake). / 레이어 하나의 리지 트랙 */
export function layerTracks(bake, layerId, smooth = 0) {
  let per = trackMemo.get(bake);
  if (!per) { per = new Map(); trackMemo.set(bake, per); }
  const memoKey = `${layerId}|${Math.round(smooth)}`;
  let hit = per.get(memoKey);
  if (hit) return hit;
  const m = bake.mats.get(layerId);
  const { N, F, rate, bps } = bake.dims;
  const step = Math.max(1, Math.round(rate / TRACK_RATE));
  hit = m ? trackRidges(m.M, N, F, { thresh: 0.06, maxJump: Math.max(2, bps * 1.5), maxGap: Math.round(0.12 * (rate / step)), minLen: 3, maxTracks: 4 * MAX_GENERATED_VOICES, step, smooth }) : { tracks: [], total: 0, peak: 0 };
  per.set(memoKey, hit);
  return hit;
}

/**
 * Every line a document would bake, strongest first, before the 64-voice cut: per audible layer the
 * ridge tracks, × the chromatic channels (each an exact 12·log2(ratio) semitones away), + two
 * detuned companions for clusters. / 문서가 베이킹할 모든 선 (에너지 순, 64 컷 이전)
 * @returns {{ lines: Array<{ layer, track, semis, gain, timeSec, weight, kind }>, total: number }}
 */
export function gridBakeLines(params, bake = getGridBake(params)) {
  const { bps } = bake.dims;
  const lines = [];
  for (const layer of audibleLayers(params)) {
    const chromaIt = bankItem(layer, 'chroma');
    const channels = chromaIt && chromaIt.on ? GridEffectRegistry.get('chroma').bank(chromaIt.params).channels : [{ ch: 'g', semis: 0, gain: 1, timeMs: 0 }];
    // a blurred layer is searched for ridges on a pitch-smoothed copy (the shimmer makes a cluster uneven)
    // 블러가 걸린 레이어는 음고 방향으로 평활한 뒤 리지를 찾음 (시머 때문에 클러스터가 고르지 않음)
    let smooth = 0;
    for (const it of layer.stack) {
      if (it.type !== 'blur' || !it.on || !(it.mix > 0)) continue;
      const cents = it.params.mode === 'gaussian' ? it.params.sigmaCents : it.params.mode === 'perspective' ? it.params.maxCents / 2 : 0;
      smooth = Math.max(smooth, Math.min(3 * bps, 1.5 * (cents / 100) * bps));
    }
    for (const tr of layerTracks(bake, layer.id, smooth).tracks) {
      const widthCents = (tr.width / bps) * 100;
      const spread = widthCents > CLUSTER_CENTS ? [[0, 0.75], [0.8 * widthCents / 100, 0.5], [-0.8 * widthCents / 100, 0.5]] : [[0, 1]];
      for (const c of channels) {
        for (const [detune, g] of spread) {
          const gain = layer.gain * c.gain * g;
          if (!(gain > 0)) continue;
          lines.push({ layer, track: tr, semis: c.semis + detune, chroma: c.semis, gain, timeSec: c.timeMs / 1000, weight: tr.energy * gain * gain, kind: detune ? 'detune' : c.semis ? 'chroma' : 'ridge' });
        }
      }
    }
  }
  lines.sort((a, b) => b.weight - a.weight);
  return { lines, total: lines.length };
}

function resample(src, m) {
  const n = src.length;
  const out = new Array(m);
  for (let j = 0; j < m; j++) {
    const pos = n > 1 ? (j / (m - 1)) * (n - 1) : 0;
    const i = Math.min(Math.max(0, n - 2), Math.floor(pos));
    out[j] = n > 1 ? src[i] + (src[i + 1] - src[i]) * (pos - i) : src[0];
  }
  return out;
}

/** Pitch (MIDI) of a line at sample j of its track. / 선의 음고 */
export const linePitch = (line, dims, j) => dims.pLo + line.track.bin[j] / dims.bps + line.semis;

/**
 * Convert one line to a Glissando Voice. Pitch: F0 = lowest, F1 = highest pitch of the line, custom
 * spline y(x) = (pitch − F0) / (F1 − F0); amplitude → gain points.
 * 선 하나를 글리산도 보이스로 변환 (F0 = 최저, F1 = 최고 음고, 진폭 → 게인 포인트).
 */
export function lineToVoice(line, dims, helpers, index) {
  const tr = line.track;
  const n = tr.bin.length;
  const pitchAll = Array.from({ length: n }, (_, j) => linePitch(line, dims, j));
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pitchAll) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 0.5) { const mid = 0.5 * (lo + hi); lo = mid - 0.5; hi = mid + 0.5; }
  // Hz are stored with 2 decimals; derive the mapping from the rounded values so it is exact.
  // Hz는 소수 2자리로 저장되므로, 반올림된 값에서 매핑을 유도해 오차를 없앰.
  const f0Hz = roundTo(midiToFreq(lo), 2);
  const f1Hz = roundTo(midiToFreq(hi), 2);
  const m0 = freqToMidi(f0Hz);
  const span = Math.max(1e-6, freqToMidi(f1Hz) - m0);
  const m = clamp(n, 2, 1200);
  const pitch = resample(pitchAll, m);
  const dense = pitch.map((v, j) => ({ x: roundTo(j / (m - 1), 5), y: roundTo((v - m0) / span, 5), handles: [] }));
  const customPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.002, maxAnchors: 64, samples: clamp(n, 240, 1200), includeTransforms: true });
  const mg = clamp(n, 2, 240);
  const amp = resample(Array.from(tr.amp), mg);
  const gDense = amp.map((v, j) => ({ x: roundTo(j / (mg - 1), 5), y: roundTo(clamp(v, 0, 1), 4), handles: [] }));
  const gainPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: gDense, reverse: false, inverse: false }, { tolerance: 0.01, maxAnchors: 48, includeTransforms: true })
    .map((q) => ({ ...q, y: roundTo(clamp(q.y, 0, 1), 4) }));
  const dt = tr.step / dims.rate;
  return helpers.createDefaultVoice(index, {
    name: `Grid ${index + 1}`,
    color: line.layer.color,
    startTime: roundTo(Math.max(0, tr.f0 / dims.rate + line.timeSec), 4),
    duration: roundTo(Math.max(0.05, (n - 1) * dt), 4),
    baseGain: roundTo(clamp(0.6 * line.gain, 0, 1.5), 3),
    f0Hz, f1Hz, f0Fine: 0, f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(line.layer.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints,
    gainMode: 'points',
    gainPoints,
  });
}

/** Pitch (MIDI) of a baked voice at normalised time x — used to check bake fidelity. / 베이킹 보이스의 음고 */
export function voicePitchAt(voice, x) {
  const m0 = freqToMidi(voice.f0Hz);
  return m0 + (freqToMidi(voice.f1Hz) - m0) * evaluateCurveObjectY(voice, x);
}

/** What "Bake to Glissando Voices" cannot carry over, for this document (i18n keys). / 이 문서에서 베이킹으로 잃는 것 */
export function gridBakeLoss(params = getGridParams()) {
  const out = ['pan'];
  const has = (type, fn = () => true) => audibleLayers(params).some((l) => l.stack.some((it) => it.type === type && it.on && it.mix > 0 && fn(it)));
  if (has('noise')) out.push('noise');
  if (has('blur')) out.push('blur');
  if (has('halftone')) out.push('halftone');
  if (has('glitch')) out.push('glitch');
  return out;
}

/**
 * Ridge tracks of a stored document as polylines in document time for the Manager's Master View:
 * [{ key, name, pts: [{ t (s), m (MIDI) }] }]. / 매니저 마스터 뷰용 폴리라인 (문서 시간)
 */
export function gridMasterLines(doc) {
  const p = resolveGridDoc(doc);
  const bake = getGridBake(p);
  const { lines } = gridBakeLines(p, bake);
  return lines.filter((l) => l.kind !== 'detune').slice(0, 200).map((l, i) => {
    const n = l.track.bin.length;
    const step = Math.max(1, Math.floor(n / 240));
    const pts = [];
    const at = (j) => ({ t: (l.track.f0 + j * l.track.step) / bake.dims.rate + l.timeSec, m: linePitch(l, bake.dims, j) });
    for (let j = 0; j < n; j += step) pts.push(at(j));
    if ((n - 1) % step) pts.push(at(n - 1));
    return { key: `g${i}`, name: `Grid ${i + 1}`, pts };
  });
}

/** Document + bake facts + ridge lines as plain JSON. / 내보내기 JSON */
export function buildGridExport(params = getGridParams()) {
  const bake = getGridBake(params);
  const { view, tool, selection, ...doc } = params;
  const { lines, total } = gridBakeLines(params, bake);
  return {
    plugin: 'FlexatoneGridStudio',
    version: '0.1',
    document: doc,
    bake: { bins: bake.dims.N, frames: bake.dims.F, frameRate: bake.dims.rate, binsPerSemi: bake.dims.bps, pLo: bake.dims.pLo, pHi: bake.dims.pHi, lengthSec: bake.dims.length, signature: bake.sig },
    lines: { total, list: lines.slice(0, MAX_GENERATED_VOICES).map((l) => {
      const n = l.track.bin.length;
      const step = Math.max(1, Math.ceil(n / 200));
      const pts = [];
      for (let j = 0; j < n; j += step) pts.push({ t: Number(((l.track.f0 + j * l.track.step) / bake.dims.rate + l.timeSec).toFixed(3)), midi: Number(linePitch(l, bake.dims, j).toFixed(3)), amp: Number(l.track.amp[j].toFixed(3)) });
      return { layer: l.layer.id, kind: l.kind, semis: Number(l.semis.toFixed(6)), gain: Number(l.gain.toFixed(3)), points: pts };
    }) },
  };
}

/** Clip length of a document without baking. / 베이킹 없이 구하는 클립 길이 */
export const gridTimelineEnd = (params) => params.grid.length;

export const GridStudio = {
  id: GRID_ID,
  name: { en: 'Grid Studio', ko: '그리드 스튜디오' },
  description: { en: 'A painted time × pitch grid with image effects that become sound operations', ko: '칠하는 시간 × 음고 격자 — 이미지 효과가 소리 연산이 되는 스튜디오' },
  order: 110,
  status: 'ready',
  usesVoiceEditor: false,
  /** Rendered by its own workspace, not by the generic studio panel. / 전용 작업 공간 사용 */
  schema: [],
  workspace: 'grid',
  defaultParams: createDefaultGridParams,
  generateVoices(params, helpers) {
    const p = resolveGridDoc(sanitizeGridParams(params));
    const bake = bakeGrid(p, { ns: gridSignature(p) === gridSignature(getGridParams()) ? 'edit' : 'detached' });
    const { lines } = gridBakeLines(p, bake);
    return lines.slice(0, MAX_GENERATED_VOICES).map((l, i) => lineToVoice(l, bake.dims, helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(GridStudio);

// Trajectory Sends: the ridge lines of the Result can be sent to another studio or to the Master
// (studios/trajectory-link.js). Grid cannot receive: its lines are painted.
// 궤적 보내기: Result의 리지 선을 다른 스튜디오·마스터로 보낼 수 있음. 받기는 불가 (선을 직접 칠하는 스튜디오).
registerTrajectorySource(GRID_ID, { lines: (doc) => gridMasterLines(doc) });

export { GRID_PRESET_IDS, gridDims };

import './grid/grid-checks.js'; // self-checks of the studio engine / 스튜디오 엔진 자가진단
