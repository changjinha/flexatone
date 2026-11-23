/**
 * Flexatone — studios/draw-studio.js
 * Layer 2 (studios): Draw Studio plugin — hand-drawn strokes become glissandi (UPIC-style).
 * 계층 2 (studios): 드로잉 스튜디오 플러그인 — 손으로 그린 획이 곧 글리산도 (UPIC 방식).
 *
 * The whole document (strokes with their raw points, grid, view, tool) lives in
 * appState.studioParams.draw → saved with the project and undoable. The workspace UI / audio
 * live in studios/draw/draw-panels.js, draw-canvases.js, draw-audio.js and are mounted by
 * ui/studio-host.js — this file stays DOM- and audio-free (architecture DAG).
 * 문서는 appState.studioParams.draw에 저장. UI·오디오는 별도 파일 — 이 파일은 DOM·오디오 무의존.
 *
 * Bake to Glissando Voices: each stroke piece (a 'split' stroke may give several) becomes a
 * Voice (engine 'custom', log pitch, F0/F1 = first/last point, width → gainPoints ≤ 17).
 * Lost in the bake: nothing pitch-related; the dense width curve is reduced to 17 gain points.
 * Imports: core/*, modules/*, studios/registry.js, studios/draw/*.js (pure only).
 */

import { roundTo, deepClone } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { appState, registerSelfCheck, withIsolatedState, createInitialState, resetHistory, serializeProject, loadProjectData } from '../core/state.js';
import { evaluateCurveObjectY } from '../modules/curve-engine.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import './draw/draw-i18n.js'; // merges EN/KO strings before the tabs are drawn / 탭 그리기 전에 문자열 병합
import {
  DRAW_ID,
  createDefaultDrawParams,
  normalizeStroke,
  processDoc,
  processStroke,
  computeStroke,
  getProcessCount,
  pieceGainPoints,
  createStroke,
  dropReversals,
  splitReversals,
  arcRetime,
  arcLength,
  snapPitch,
  snapTarget,
  smoothToEpsilon,
  SCALE_IDS,
} from './draw/draw-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export { DRAW_ID };

// Read-only snapshot memoised on the identity of appState.studioParams.draw: every edit, undo and
// load replaces that object, so the UI can call getDrawParams() freely (no clone per call).
// appState.studioParams.draw 객체 동일성으로 캐시한 읽기 전용 스냅샷 (편집·실행 취소·불러오기 시 교체됨).
let snap = { key: undefined, params: null, map: null };

/**
 * Draw document = defaults overlaid with the saved params. READ-ONLY: edit through editDraw().
 * 드로잉 문서 (읽기 전용 — 편집은 editDraw로).
 */
export function getDrawParams() {
  const saved = appState.studioParams?.[DRAW_ID];
  if (snap.params && saved !== undefined && snap.key === saved) return snap.params;
  const p = StudioRegistry.has(DRAW_ID) ? StudioRegistry.getParams(DRAW_ID) : createDefaultDrawParams();
  p.strokes = (p.strokes || []).map((s, i) => normalizeStroke(s, i));
  snap = { key: saved, params: p, map: null };
  return p;
}

/**
 * Edit the Draw document: `fn(draft)` mutates a copy. View / tool / selection edits pass
 * { history: false }. / 드로잉 문서 편집 (보기·도구·선택은 history:false)
 */
export function editDraw(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getDrawParams());
  fn(draft);
  return StudioRegistry.setParams(DRAW_ID, draft, { history, coalesceKey });
}

export function getActiveStroke(params = getDrawParams()) {
  return params.strokes.find((s) => s.id === params.activeStrokeId) || params.strokes[0] || null;
}

export function isStrokeAudible(s, params = getDrawParams()) {
  const anySolo = params.strokes.some((x) => x.solo);
  return anySolo ? !!s.solo : !s.muted;
}

/** Processed (cached) result of every stroke. / 모든 획의 처리 결과 (캐시) */
export function getProcessedMap(params = getDrawParams()) {
  if (params === snap.params) {
    if (!snap.map) snap.map = processDoc(params);
    return snap.map;
  }
  return processDoc(params);
}

/** One stroke piece → Glissando Voice. / 획 조각 → 글리산도 보이스 */
export function pieceToGlissandoVoice(stroke, piece, pieceIndex, pieceCount, helpers, index) {
  return helpers.createDefaultVoice(index, {
    name: pieceCount > 1 ? `${stroke.name} ${pieceIndex + 1}` : stroke.name,
    color: stroke.color,
    solo: !!stroke.solo,
    muted: !!stroke.muted,
    startTime: roundTo(piece.t0, 4),
    duration: roundTo(Math.max(0.05, piece.dur), 4),
    baseGain: stroke.baseGain,
    f0Hz: roundTo(midiToFreq(piece.pA), 3),
    f1Hz: roundTo(midiToFreq(piece.pB), 3),
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(stroke.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    reverse: false,
    inverse: false,
    customPoints: deepClone(piece.customPoints),
    gainMode: 'points',
    gainPoints: pieceGainPoints(piece, stroke, 16),
  });
}

/** Every voice the document bakes (≤ 64). / 문서가 베이킹하는 모든 보이스 */
export function drawDocToVoices(params, helpers) {
  const map = processDoc(params);
  const out = [];
  for (const s of params.strokes) {
    const res = map.get(s.id);
    if (!res) continue;
    res.pieces.forEach((piece, k) => {
      if (out.length < MAX_GENERATED_VOICES) out.push(pieceToGlissandoVoice(s, piece, k, res.pieces.length, helpers, helpers.startIndex + out.length));
    });
  }
  return out;
}

export const DrawStudio = {
  id: DRAW_ID,
  name: { en: 'Draw Studio', ko: '드로잉 스튜디오' },
  description: { en: 'Hand-drawn strokes become glissandi (UPIC-style)', ko: '손으로 그린 획이 글리산도가 됩니다 (UPIC 방식)' },
  order: 40,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'draw',
  defaultParams: createDefaultDrawParams,
  generateVoices(params, helpers) {
    const p = { ...params, strokes: (params.strokes || []).map((s, i) => normalizeStroke(s, i)) };
    return drawDocToVoices(p, helpers);
  },
};

StudioRegistry.register(DrawStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const wobbleRaw = (n = 160, back = false) => {
  const raw = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    let t = 0.5 + u * 3;
    if (back && u > 0.4 && u < 0.6) t = 0.5 + 1.2 - (u - 0.4) * 3; // goes back in time / 시간 역행
    raw.push({ t, p: 55 + 10 * Math.sin(2 * Math.PI * u * 1.5) + 6 * u, w: 0.5 + 0.4 * Math.sin(Math.PI * u) });
  }
  return raw;
};

registerSelfCheck('Draw studio: spline fit RMSE within the smooth tolerance', (a) => {
  for (const smooth of [0, 0.2, 0.35, 0.6, 1]) {
    const s = createStroke(0, wobbleRaw(), null, 'ds_chk');
    s.smooth = smooth;
    const res = computeStroke(s);
    a.equal(res.pieces.length, 1, `one piece (smooth ${smooth})`);
    const pc = res.pieces[0];
    const tol = smoothToEpsilon(smooth);
    a.ok(pc.rmse <= tol, `RMSE ${pc.rmse.toFixed(4)} st ≤ ${tol.toFixed(3)} (smooth ${smooth})`);
    a.ok(pc.customPoints.length >= 2 && pc.customPoints.length <= 64, `anchors ${pc.customPoints.length}`);
  }
  const lo = computeStroke({ ...createStroke(0, wobbleRaw(), null, 'x'), smooth: 0 }).pieces[0].customPoints.length;
  const hi = computeStroke({ ...createStroke(0, wobbleRaw(), null, 'x'), smooth: 1 }).pieces[0].customPoints.length;
  a.ok(hi < lo, `more smoothing → fewer anchors (${lo} → ${hi})`);
}, { group: 'studio' });

registerSelfCheck('Draw studio: time cleanup drop / split / arc', (a) => {
  const raw = wobbleRaw(120, true);
  const drop = dropReversals(raw);
  a.ok(drop.every((q, i) => i === 0 || q.t > drop[i - 1].t), 'drop: t strictly increasing');
  a.ok(drop.length < raw.length, 'drop removed backward points');
  const runs = splitReversals(raw);
  a.ok(runs.length >= 3, `split pieces ${runs.length}`);
  a.ok(runs.every((r) => r.every((q, i) => i === 0 || q.t >= r[i - 1].t)), 'split: every piece monotone');
  a.equal(runs.reduce((n, r) => n + r.length, 0), raw.length, 'split: total point count preserved');
  const s = createStroke(0, raw, null, 'ds_chk');
  s.reversal = 'split';
  const res = computeStroke(s);
  a.ok(res.pieces.length >= 2, `split → several voices (${res.pieces.length})`);
  for (const speed of [6, 12, 30]) {
    const arc = arcRetime(raw, speed);
    const len = arcLength(raw);
    a.near(arc[arc.length - 1].t - arc[0].t, len / speed, 1e-9, `arc duration = L / speed (${speed})`);
  }
}, { group: 'studio' });

registerSelfCheck('Draw studio: pitch snap idempotent, strength 0 / 1', (a) => {
  const ps = [40.13, 52.49, 52.51, 60, 61.74, 66.25, 71.9];
  for (const mode of ['semitone', 'quarter', 'scale']) {
    for (const scaleId of mode === 'scale' ? SCALE_IDS : ['major']) {
      for (const p of ps) {
        const once = snapPitch(p, mode, 1, scaleId, 2);
        a.equal(snapPitch(once, mode, 1, scaleId, 2), once, `${mode}/${scaleId} idempotent at ${p}`);
        a.equal(snapPitch(p, mode, 0, scaleId, 2), p, 'strength 0 = untouched');
        a.equal(once, snapTarget(p, mode, scaleId, 2), 'strength 1 = grid value');
        const half = snapPitch(p, mode, 0.5, scaleId, 2);
        a.near(half, (p + once) / 2, 1e-12, 'strength 0.5 = halfway');
      }
    }
  }
  a.equal(snapTarget(60.8, 'scale', 'major', 0), 60, 'C major: 60.8 → C');
  a.equal(snapTarget(61.2, 'scale', 'major', 0), 62, 'C major: 61.2 → D');
  a.equal(snapTarget(66.25, 'quarter'), 66.5, 'quarter tone');
}, { group: 'studio' });

registerSelfCheck('Draw studio: signature cache (sound edits never re-process)', (a) => {
  const s = createStroke(0, wobbleRaw(), null, `ds_cache_${Math.random()}`);
  const r1 = processStroke(s);
  const before = getProcessCount();
  const sound = deepClone(s);
  sound.timbre.saw = 1;
  sound.baseGain = 0.2;
  sound.widthDepth = 0.1;
  sound.gainSource = 'fixed';
  sound.name = 'renamed';
  sound.color = '#ffffff';
  sound.muted = true;
  a.ok(processStroke(sound) === r1, 'same result object');
  a.equal(getProcessCount() - before, 0, 'zero recomputations for sound edits');
  const geo = deepClone(s);
  // Unique per run: the cache keeps many entries, so a fixed value would hit a previous run's result.
  // 실행마다 고유한 값: 캐시가 여러 항목을 보관하므로 고정값이면 이전 실행 결과에 적중함.
  geo.smooth = 0.5 + Math.random() * 0.4;
  a.ok(processStroke(geo) !== r1, 'geometry edit recomputes');
  a.equal(getProcessCount() - before, 1, 'exactly one recomputation');
}, { group: 'studio' });

registerSelfCheck('Draw studio: bake to Glissando voices (≤ 64, monotone x, isolated)', (a) => {
  a.ok(StudioRegistry.has(DRAW_ID), 'registered');
  withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    const p = createDefaultDrawParams();
    const s = createStroke(1, wobbleRaw(120, true), null, 'ds_split');
    s.reversal = 'split';
    p.strokes.push(s);
    const voices = StudioRegistry.generateVoices(DRAW_ID, p);
    const pieces = processDoc(p);
    a.equal(voices.length, pieces.get(p.strokes[0].id).pieces.length + pieces.get('ds_split').pieces.length, 'one voice per piece');
    a.ok(voices.length <= 64, 'cap');
    for (const v of voices) {
      a.ok(v.engine === 'custom', 'custom engine');
      const xs = v.customPoints.map((c) => c.x);
      a.ok(xs[0] === 0 && xs[xs.length - 1] === 1 && xs.every((x, i) => i === 0 || x > xs[i - 1]), 'x monotone in [0,1]');
      a.ok(v.gainPoints.length === 17, '17 gain points');
    }
    const v0 = voices[0];
    const pc = pieces.get(p.strokes[0].id).pieces[0];
    a.near(v0.f0Hz, midiToFreq(pc.pA), 0.01, 'F0 = first point');
    a.near(v0.startTime, pc.t0, 1e-3, 'start time');
    // Pitch at mid-time matches the drawn curve / 중간 음고가 그린 곡선과 일치
    const y = evaluateCurveObjectY(v0, 0.5);
    const midi = 69 + 12 * Math.log2((v0.f0Hz * Math.pow(v0.f1Hz / v0.f0Hz, y)) / 440);
    a.near(midi, 48 + 24 * 0.75, 0.6, 'voice follows the stroke');
    const big = createDefaultDrawParams();
    big.strokes = Array.from({ length: 70 }, (_, i) => createStroke(i, [{ t: 0, p: 60, w: 1 }, { t: 1, p: 62, w: 1 }], null, `ds_b${i}`));
    a.equal(StudioRegistry.generateVoices(DRAW_ID, big).length, 64, 'capped at 64');
    a.equal(JSON.stringify(appState.voices), before, 'state untouched');
  });
}, { group: 'studio' });

registerSelfCheck('Draw studio: save → load round trip keeps raw', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    const p = createDefaultDrawParams();
    p.strokes.push(createStroke(1, wobbleRaw(40), null, 'ds_rt'));
    StudioRegistry.setParams(DRAW_ID, p);
    const json = JSON.stringify(serializeProject());
    const raw0 = JSON.stringify(getDrawParams().strokes.map((s) => s.raw));
    StudioRegistry.setParams(DRAW_ID, { strokes: [] });
    a.equal(getDrawParams().strokes.length, 0, 'changed');
    a.ok(loadProjectData(json).ok, 'loaded');
    a.equal(JSON.stringify(getDrawParams().strokes.map((s) => s.raw)), raw0, 'raw identical after load');
  });
}, { group: 'studio' });
