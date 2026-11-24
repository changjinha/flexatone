/**
 * Flexatone — studios/grid-studio.js
 * Layer 2 (studios): Grid Studio plugin — the studio that deforms the COORDINATE SPACE. It has no
 * lines of its own to edit: it shows the lines of another studio on the time × pitch grid and bends
 * that grid (liquify, lens, twirl, wave, turbulence, pixelate, mirror, glitch, halftone, chromatic
 * copies). The source voices are never touched; they are heard where the warped space puts them.
 * 계층 2 (studios): 그리드 스튜디오 플러그인 — 좌표 공간을 변형하는 스튜디오. 직접 편집하는 선이 없고,
 * 다른 스튜디오의 선을 시간 × 음고 격자 위에 보여 주며 그 격자를 휨. 원본 보이스는 건드리지 않음.
 *
 * Counterpart: the Draw Studio applies the same warps (modules/space-warp.js) to single strokes as
 * OBJECT effects — there the axes stay and the object moves; here the space moves and carries
 * everything in it. / 대응: 드로잉 스튜디오는 같은 변형을 획 하나에 객체 효과로 적용 (축은 그대로).
 *
 * The document (source, space stack, range, sound, view, brush) lives in appState.studioParams.grid.
 * This file stays DOM- and audio-free. Imports: core/*, modules/*, studios/registry.js,
 * studios/trajectory-link.js, studios/grid/grid-engine.js.
 */

import { clamp, roundTo, deepClone } from '../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../core/units.js';
import { appState } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';
import { evaluateVoiceAmplitudeAtTime } from '../modules/gain-bus.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import { registerTrajectorySource, listSourceLines, listSendSources, MEAN_LINE } from './trajectory-link.js';
import './grid/grid-i18n.js'; // merges the EN/KO keys before any tab is drawn / 탭 표시 전에 번역 키 병합
import {
  createDefaultGridParams, sanitizeGridParams, bakeGrid, demoLines, gridPresetSpace, fitGridView, gridDomain, runAt, linesSignature, GRID_OWN, GRID_PRESET_IDS,
} from './grid/grid-engine.js';

export const GRID_ID = 'grid';

const docMemo = new WeakMap();
const resolved = new WeakSet();
let defaultDoc = null;

/** Full, sanitised params of a stored Grid document (null = defaults). Memoised per object. READ-ONLY. */
export function resolveGridDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    if (!defaultDoc) resolved.add(defaultDoc = createDefaultGridParams());
    return defaultDoc;
  }
  if (resolved.has(doc)) return doc;
  let p = docMemo.get(doc);
  if (!p) { p = sanitizeGridParams(doc); docMemo.set(doc, p); resolved.add(p); }
  return p;
}

/** Grid document in the editor (READ-ONLY; use editGrid). / 에디터의 그리드 문서 (읽기 전용) */
export function getGridParams() {
  return resolveGridDoc(appState.studioParams?.[GRID_ID]);
}

/** Edit the document: `fn(draft)`. View / brush edits pass { history: false }. / 문서 편집 */
export function editGrid(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getGridParams());
  fn(draft);
  return StudioRegistry.setParams(GRID_ID, sanitizeGridParams(draft), { history, coalesceKey });
}

/** Replace the space by a preset (the source stays). Undoable. / 프리셋 적용 (소스는 그대로) */
export function applyGridPreset(id) {
  const space = gridPresetSpace(id);
  if (!space) return null;
  return editGrid((d) => { d.space = space; d.preset = id; });
}

/** Studios whose lines the Grid can carry (every trajectory source except itself) + its own demo lines. */
export function gridSourceStudios() {
  return [...listSendSources().filter((s) => s !== GRID_ID), GRID_OWN];
}

const OWN_LINES = Object.freeze(demoLines());
let lineMemo = { studio: null, key: null, lines: [] };

/**
 * The lines the space carries: of the chosen source studio (its editor / focused document, read-only)
 * or the demo lines. Memoised on the source document. / 공간이 옮길 선 (선택한 소스 스튜디오의 선, 읽기 전용)
 */
export function getGridLines(params = getGridParams()) {
  const studio = params.source.studio;
  if (studio === GRID_OWN || studio === GRID_ID) return OWN_LINES;
  // identity of what the source reads; the Glissando voices are edited in place, so their text is the key
  // 소스가 읽는 것의 식별값 (글리산도 보이스는 제자리 수정되므로 직렬화한 값이 키)
  const key = studio === 'glissando' ? `g|${JSON.stringify(appState.voices)}` : appState.studioParams?.[studio];
  if (lineMemo.studio === studio && lineMemo.key === key && key !== undefined) return lineMemo.lines;
  let lines = [];
  try { lines = listSourceLines(studio).filter((l) => l.key !== MEAN_LINE); } catch { lines = []; }
  lineMemo = { studio, key, lines };
  return lines;
}

/** Baked runs of a document (memoised by signature). Documents that are not on screen use their own cache. */
export function getGridBake(params = getGridParams()) {
  return bakeGrid(params, getGridLines(params), { ns: params === getGridParams() ? 'edit' : 'detached' });
}

/** View fitted to the domain of the current lines. / 현재 선의 영역에 맞춘 뷰 */
export function fitGridToLines(params = getGridParams()) {
  return fitGridView(gridDomain(params, getGridLines(params)));
}

/** The Glissando voice a run comes from (only when the source is the Glissando Studio). / 조각의 원본 보이스 */
export function runSourceVoice(params, run) {
  return params.source.studio === 'glissando' ? appState.voices.find((v) => v.id === run.key) || null : null;
}

/** Amplitude 0..1 of a run at absolute time: warp gain × (the source voice's own envelope when it is kept). */
export function runAmpAt(params, run, t, voice = runSourceVoice(params, run)) {
  const q = runAt(run, t);
  if (voice && params.sound === 'source') return q.g * clamp(evaluateVoiceAmplitudeAtTime(voice, q.w), 0, 1.5);
  return q.g;
}

/** One run → a Glissando Voice (the warped line as an ordinary voice). / 조각 하나 → 글리산도 보이스 */
export function runToVoice(params, run, helpers, index) {
  const pts = run.pts;
  const t0 = pts[0].t;
  const dur = pts[pts.length - 1].t - t0;
  const n = clamp(Math.ceil(dur * 100), 8, 1200);
  const pitch = Array.from({ length: n }, (_, j) => runAt(run, t0 + (j / (n - 1)) * dur).m);
  let lo = Math.min(...pitch);
  let hi = Math.max(...pitch);
  if (hi - lo < 0.5) { const mid = 0.5 * (lo + hi); lo = mid - 0.5; hi = mid + 0.5; }
  const f0Hz = roundTo(midiToFreq(lo), 3);
  const f1Hz = roundTo(midiToFreq(hi), 3);
  const m0 = freqToMidi(f0Hz);
  const span = Math.max(1e-6, freqToMidi(f1Hz) - m0);
  const dense = pitch.map((v, j) => ({ x: roundTo(j / (n - 1), 5), y: roundTo((v - m0) / span, 5), handles: [] }));
  const customPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.002, maxAnchors: 64, samples: clamp(n, 240, 1200), includeTransforms: true });
  const voice = runSourceVoice(params, run);
  const mg = clamp(Math.ceil(dur * 40), 8, 96);
  const gDense = Array.from({ length: mg }, (_, j) => ({ x: roundTo(j / (mg - 1), 5), y: clamp(runAmpAt(params, run, t0 + (j / (mg - 1)) * dur, voice), 0, 1), handles: [] }));
  const peak = Math.max(1e-6, ...gDense.map((q) => q.y));
  const gainPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: gDense.map((q) => ({ ...q, y: roundTo(q.y / peak, 4) })), reverse: false, inverse: false }, { tolerance: 0.01, maxAnchors: 48, includeTransforms: true })
    .map((q) => ({ ...q, y: roundTo(clamp(q.y, 0, 1), 4) }));
  const keep = voice && params.sound === 'source';
  return helpers.createDefaultVoice(index, {
    name: `${run.name || 'Grid'}${run.ch ? ` ${run.ch.toUpperCase()}` : ''}`.slice(0, 40),
    color: run.color || voice?.color || '#e879f9',
    startTime: roundTo(t0, 4),
    duration: roundTo(Math.max(0.05, dur), 4),
    baseGain: roundTo(clamp(peak * params.gain, 0, 1.5), 3),
    f0Hz, f1Hz, f0Fine: 0, f1Fine: 0,
    logScale: true,
    ...(keep ? { timbre: deepClone(voice.timbre), timbreMode: voice.timbreMode, timbreFunc: deepClone(voice.timbreFunc) } : timbreSpecToVoiceFields(params.timbre)),
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints,
    gainMode: 'points',
    gainPoints,
  });
}

/** Pitch (MIDI) of a baked voice at normalised time x. / 베이킹 보이스의 음고 */
export function voicePitchAt(voice, x) {
  const m0 = freqToMidi(voice.f0Hz);
  return m0 + (freqToMidi(voice.f1Hz) - m0) * evaluateCurveObjectY(voice, x);
}

/** Runs ordered for baking: the longest / loudest first. / 베이킹 순서: 길고 큰 것부터 */
export function gridBakeRuns(bake) {
  const w = (r) => (r.pts[r.pts.length - 1].t - r.pts[0].t) * (r.pts.reduce((s, q) => s + q.g, 0) / r.pts.length) ** 2;
  return bake.runs.filter((r) => r.pts[r.pts.length - 1].t - r.pts[0].t >= 0.05).map((r) => ({ r, w: w(r) })).filter((x) => x.w > 1e-6).sort((a, b) => b.w - a.w).map((x) => x.r);
}

/** The warped lines of a stored document as polylines for the Manager's Master View. / 마스터 뷰용 변형된 선 */
export function gridMasterLines(doc) {
  const p = resolveGridDoc(doc);
  return getGridBake(p).runs.slice(0, 400).map((r, i) => {
    const step = Math.max(1, Math.floor(r.pts.length / 240));
    const pts = [];
    for (let j = 0; j < r.pts.length; j += step) pts.push({ t: r.pts[j].t, m: r.pts[j].m });
    const last = r.pts[r.pts.length - 1];
    if (pts[pts.length - 1].t !== last.t) pts.push({ t: last.t, m: last.m });
    return { key: `g${i}`, name: r.name || `Grid ${i + 1}`, color: r.color || undefined, pts };
  });
}

/** Clip length of a document. / 클립 길이 */
export const gridTimelineEnd = (params) => getGridBake(params).endSec;

/** What the result depends on (lines + space + sound); view and brush edits keep it. / 결과를 결정하는 키 */
export function gridResultKey(doc) {
  const p = resolveGridDoc(doc);
  const snd = p.source.studio === 'glissando' && p.sound === 'source' ? JSON.stringify(appState.voices.map((v) => [v.id, v.timbre, v.timbreMode, v.timbreFunc, v.baseGain, v.gainMode, v.gainPoints, v.gainEngineObj, v.muted, v.solo])) : '';
  return `${linesSignature(getGridLines(p))}|${p.seed}|${JSON.stringify([p.space, p.range, p.sound, p.timbre, p.gain, p.tremolo, p.source])}|${snd}`;
}

/** Document + runs as plain JSON. / 내보내기 JSON */
export function buildGridExport(params = getGridParams()) {
  const bake = getGridBake(params);
  const { view, tool, ...doc } = params;
  return {
    plugin: 'FlexatoneGridStudio',
    version: '0.2',
    document: doc,
    domain: bake.dom,
    runs: bake.runs.map((r) => ({ line: r.key, name: r.name, channel: r.ch, points: r.pts.filter((_, j) => j % Math.max(1, Math.ceil(r.pts.length / 200)) === 0).map((q) => ({ t: Number(q.t.toFixed(4)), midi: Number(q.m.toFixed(4)), gain: Number(q.g.toFixed(3)), pan: Number(q.pan.toFixed(2)) })) })),
  };
}

export const GridStudio = {
  id: GRID_ID,
  name: { en: 'Grid Studio', ko: '그리드 스튜디오' },
  description: { en: 'Deforms the time × pitch space the voices of another studio lie in', ko: '다른 스튜디오의 보이스가 놓인 시간 × 음고 공간을 변형' },
  order: 110,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'grid',
  defaultParams: createDefaultGridParams,
  generateVoices(params, helpers) {
    const p = sanitizeGridParams(params);
    const bake = bakeGrid(p, getGridLines(p), { ns: 'detached' });
    return gridBakeRuns(bake).slice(0, MAX_GENERATED_VOICES).map((r, i) => runToVoice(p, r, helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(GridStudio);

// Trajectory Sends: the warped lines can be sent on to another studio or to the Master.
// 궤적 보내기: 변형된 선을 다른 스튜디오·마스터로 보낼 수 있음
registerTrajectorySource(GRID_ID, { lines: (doc) => gridMasterLines(doc) });

export { GRID_PRESET_IDS, GRID_OWN };

import './grid/grid-checks.js'; // self-checks of the studio engine / 스튜디오 엔진 자가진단
