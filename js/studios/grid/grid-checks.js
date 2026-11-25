/**
 * Flexatone — studios/grid/grid-checks.js
 * Grid Studio (pure): self-checks of the studio engine, the bake and the window layout. The warps
 * themselves are checked in modules/space-warp.js, the sound in grid-audio.js. Imported by
 * studios/grid-studio.js (its exports are only used inside the check bodies).
 * 그리드 스튜디오 (순수): 스튜디오 엔진·베이킹·윈도우 레이아웃 자가진단.
 */

import { deepClone } from '../../core/math-utils.js';
import { appState, registerSelfCheck, withIsolatedState, createDefaultManagerState } from '../../core/state.js';
import { ensureManager, addInstance, focusInstance, getInstance, MANAGER_STUDIOS } from '../../core/manager-state.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from '../registry.js';
import { sanitizeWarpStack } from '../../modules/space-warp.js';
import { createDefaultGridParams, sanitizeGridParams, bakeGrid, demoLines, gridDomain, gridPresetSpace, warpedGridLines, runAt, getGridBakeCount, withIsolatedGridCache, GRID_PRESET_IDS, GRID_OWN, GRID_MAX_RUNS } from './grid-engine.js';
import { normalizeDual, resizePane, toggleDualLock, setDualLayout, dualSizes, applyDualTotal, serializeDual, parseDual, gridMetrics, metricsKey, DUAL_DEFAULT, DUAL_GAP, DUAL_NARROW_W } from './grid-layout.js';
import { GRID_ID, getGridParams, editGrid, applyGridPreset, getGridLines, resolveGridDoc, gridMasterLines, runToVoice, voicePitchAt, gridBakeRuns, gridResultKey, restoreGridSpace, beginGridPull, writeGridPull } from '../grid-studio.js';

const G = { group: 'studio' };
const own = (space = [], over = {}) => sanitizeGridParams({ ...createDefaultGridParams(), source: { studio: GRID_OWN }, sound: 'grid', space: sanitizeWarpStack(space), ...over });
const LINES = demoLines();

registerSelfCheck('Grid: registered, deterministic defaults, presets, document sanitising', (a) => {
  a.ok(StudioRegistry.has(GRID_ID) && StudioRegistry.get(GRID_ID).order === 110, 'registered (order 110)');
  a.equal(JSON.stringify(createDefaultGridParams()), JSON.stringify(createDefaultGridParams()), 'defaults are deterministic');
  a.equal(GRID_PRESET_IDS.length, 10, 'ten space presets');
  for (const id of GRID_PRESET_IDS) {
    const p = own(gridPresetSpace(id));
    a.equal(JSON.stringify(sanitizeGridParams(deepClone(p))), JSON.stringify(p), `sanitize is idempotent (${id})`);
    const b = bakeGrid(p, LINES, { ns: 'detached' });
    a.ok(b.runs.length >= (id === 'dotted' ? 4 : 4) && b.runs.every((r) => r.pts.every((q, i) => Number.isFinite(q.t) && Number.isFinite(q.m) && (i === 0 || q.t > r.pts[i - 1].t))), `${id}: ${b.runs.length} pieces, finite and forward in time`);
  }
  a.equal(createDefaultGridParams().source.studio, 'glissando', 'the default source is the Glissando Studio');
  a.equal(sanitizeGridParams({ space: [{ type: 'nope' }, { type: 'wave' }] }).space.length, 1, 'unknown effects are dropped');
}, G);

registerSelfCheck('Grid: a flat space is the identity; the source lines are never changed', (a) => {
  const before = JSON.stringify(LINES);
  const flat = bakeGrid(own([]), LINES, { ns: 'detached' });
  a.ok(flat.identity && flat.runs.length === LINES.length, 'flat: one piece per line');
  let worst = 0;
  flat.runs.forEach((r) => { const src = LINES[r.line].pts; for (const q of src) worst = Math.max(worst, Math.abs(runAt(r, q.t).m - q.m)); });
  a.ok(worst < 1e-9, `flat space: every point where it was (max ${worst.toExponential(1)} st)`);
  const off = bakeGrid(own([{ type: 'wave', on: false, params: { ampSemi: 5 } }, { type: 'twirl', mix: 0, params: { angle: 200 } }]), LINES, { ns: 'detached' });
  a.ok(off.identity && Math.abs(runAt(off.runs[0], 3).m - 48) < 1e-9, 'effects that are off or at amount 0 = identity');
  const bent = bakeGrid(own([{ type: 'wave', params: { ampSemi: 3, periodSec: 2 } }, { type: 'glitch', params: { rate: 5 } }, { type: 'chroma', params: {} }]), LINES, { ns: 'detached' });
  a.ok(bent.runs.length > LINES.length, `a bent space: ${bent.runs.length} pieces`);
  a.equal(JSON.stringify(LINES), before, 'the source lines are untouched');
  a.ok(bent.runs.every((r) => r.pts.every((q) => Number.isFinite(q.w))), 'every point remembers its source time');
  const dom = gridDomain(own([]), LINES);
  a.ok(dom.t0 === 0 && dom.t1 >= 15.5 && dom.m0 <= 46 && dom.m1 >= 74 && dom.m0 % 12 === 0, `auto range fits the lines (${dom.m0}–${dom.m1}, ${dom.t1} s)`);
  const fixed = gridDomain(own([], { range: { auto: false, pLo: 40, pHi: 80, length: 20 } }), LINES);
  a.ok(fixed.m0 === 40 && fixed.m1 === 80 && fixed.t1 === 20, 'a manual range is kept');
}, G);

registerSelfCheck('Grid: the whole space moves — every line under the brush, and the grid itself', (a) => {
  // a push that covers everything moves ALL lines by the same amount (not one object) / 전체를 덮는 밀기는 모든 선을 똑같이 옮김
  const push = own([{ type: 'liquify', params: { ops: [{ tool: 'push', size: 4000, strength: 1, pts: [[60, 120], [60, 126]] }] } }]);
  const b = bakeGrid(push, LINES, { ns: 'detached' });
  for (const r of b.runs) {
    const src = LINES[r.line].pts[4];
    a.near(runAt(r, src.t).m - src.m, 3, 0.02, `line ${LINES[r.line].name} moved up by 3 semitones`);
  }
  // the deformed grid: the image of the pitch line C4 lies 3 semitones higher / 변형 격자: C4 격자선의 상이 3반음 위
  const g = warpedGridLines(push, b.dom, { tStep: 4, mStep: 12, samples: 16 });
  const c4 = g.pitch.find((x) => x.v === 60);
  a.ok(c4 && c4.paths.length === 1 && c4.paths[0].every((q) => Math.abs(q.m - 63) < 0.02), 'the grid line of C4 is drawn 3 semitones higher');
  const flatG = warpedGridLines(own([]), b.dom, { tStep: 4, mStep: 12, samples: 8 });
  a.ok(flatG.time.every((x) => x.paths[0].every((q) => Math.abs(q.t - x.v) < 1e-12)) && flatG.pitch.every((x) => x.paths[0].every((q) => q.m === x.v)), 'a flat space draws the straight grid');
  // a local brush moves only what lies under it / 국소 브러시는 그 아래만 옮김
  const local = bakeGrid(own([{ type: 'liquify', params: { ops: [{ tool: 'push', size: 6, strength: 1, pts: [[30, 96], [30, 100]] }] } }]), LINES, { ns: 'detached' });
  const c3 = local.runs.find((r) => r.line === 0);
  a.ok(runAt(c3, 3.75).m > 49 && Math.abs(runAt(c3, 1).m - 48) < 1e-9, 'local push: the line bends under the brush and stays elsewhere');
  a.ok(Math.abs(runAt(local.runs.find((r) => r.line === 3), 12).m - 69) < 1e-9, 'a line outside the brush does not move');
  // pixelate cuts the glide into steps; chromatic copies the whole space / 계단·복제
  const stairs = bakeGrid(own([{ type: 'quantize', params: { stepSemi: 2, strength: 1 } }]), LINES, { ns: 'detached' });
  a.equal(stairs.runs.filter((r) => r.line === 2).length, 5, 'the glide (8 st) becomes 5 steps of 2 st');
  const ch = bakeGrid(own([{ type: 'chroma', params: { link: false, rP: 2, rQ: 3, bP: 3, bQ: 2 } }]), LINES, { ns: 'detached' });
  a.equal(ch.runs.length, 3 * LINES.length, 'three copies of every line');
  const fifth = ch.runs.find((r) => r.line === 0 && r.ch === 'b');
  a.ok(Math.abs(fifth.pts[0].m - (48 + 12 * Math.log2(1.5))) < 1e-9, 'copy exactly 12·log2(3/2) semitones higher');
}, G);

registerSelfCheck('Grid: bake cache — sound / view / brush edits recompute nothing, same input = same result', (a) => {
  withIsolatedGridCache(() => {
    const p = own([{ type: 'glitch', params: { rate: 4 } }, { type: 'turbulence', params: {} }]);
    const c0 = getGridBakeCount();
    const b1 = bakeGrid(p, LINES);
    a.equal(getGridBakeCount(), c0 + 1, 'one bake');
    const q = deepClone(p);
    Object.assign(q, { gain: 0.3, sound: 'source' });
    q.timbre.saw = 1;
    q.view.tMin = 2;
    q.tool.size = 40;
    a.ok(bakeGrid(sanitizeGridParams(q), LINES) === b1 && getGridBakeCount() === c0 + 1, 'gain / sound / timbre / view / brush: the same result object, 0 bakes');
    const r = deepClone(p);
    r.space[1].params.ampSemi = 2;
    const b2 = bakeGrid(sanitizeGridParams(r), LINES);
    a.ok(b2 !== b1 && getGridBakeCount() === c0 + 2, 'a space edit bakes once');
    const moved = LINES.map((l, i) => (i ? l : { ...l, pts: l.pts.map((x) => ({ t: x.t, m: x.m + 1 })) }));
    a.ok(bakeGrid(sanitizeGridParams(r), moved) !== b2, 'a change of the source lines bakes again');
  });
  const A = bakeGrid(own([{ type: 'glitch', params: { rate: 6 } }, { type: 'halftone', params: {} }]), LINES, { ns: 'detached' });
  const txt = JSON.stringify(A.runs.map((r) => r.pts.slice(0, 20)));
  const B = withIsolatedGridCache(() => bakeGrid(own([{ type: 'glitch', params: { rate: 6 } }, { type: 'halftone', params: {} }]), LINES, { ns: 'detached' }));
  a.equal(JSON.stringify(B.runs.map((r) => r.pts.slice(0, 20))), txt, 'same input → the same pieces');
  const C = withIsolatedGridCache(() => bakeGrid(own([{ type: 'glitch', params: { rate: 6 } }, { type: 'halftone', params: {} }], { seed: 9 }), LINES, { ns: 'detached' }));
  a.ok(JSON.stringify(C.runs.map((r) => r.pts.slice(0, 20))) !== txt, 'another seed → another result');
  const many = bakeGrid(own([{ type: 'glitch', params: { rate: 30, durMin: 5, durMax: 10 } }, { type: 'chroma', params: {} }]), LINES, { ns: 'detached' });
  a.ok(many.runs.length <= GRID_MAX_RUNS && many.cut > 0, `piece limit: ${many.runs.length} kept, ${many.cut} cut`);
}, G);

registerSelfCheck('Grid: bake to Glissando — ≤ 64 voices that follow the warped lines; the document and the source are untouched', (a) => {
  const p = own([{ type: 'wave', params: { ampSemi: 2, periodSec: 3 } }]);
  const bake = bakeGrid(p, LINES, { ns: 'detached' });
  const helpers = { createDefaultVoice: (i, o) => ({ index: i, ...o }), startIndex: 0 };
  const run = bake.runs.find((r) => r.line === 2);
  const v = runToVoice(p, run, helpers, 0);
  a.ok(v.engine === 'custom' && v.customPoints.every((q, i, arr) => i === 0 || q.x > arr[i - 1].x), `adaptive spline (${v.customPoints.length} anchors)`);
  const t0 = run.pts[0].t;
  const dur = run.pts[run.pts.length - 1].t - t0;
  let err = 0;
  for (let j = 0; j <= 100; j++) err = Math.max(err, Math.abs(voicePitchAt(v, j / 100) - runAt(run, t0 + (j / 100) * dur).m));
  a.ok(err < 0.15, `the voice follows the warped line (worst ${err.toFixed(3)} st)`);
  a.near(v.startTime, t0, 1e-3, 'start time');
  withIsolatedState(() => {
    const voices0 = JSON.stringify(appState.voices);
    const params0 = JSON.stringify(appState.studioParams);
    const out = StudioRegistry.generateVoices(GRID_ID, p);
    a.equal(out.length, LINES.length, 'one voice per piece');
    a.ok(out.every((x) => x.engine === 'custom' && x.duration >= 0.05 && /^v_/.test(x.id)), 'contract-conforming voices');
    a.equal(JSON.stringify(appState.voices), voices0, 'voices untouched by generateVoices');
    a.equal(JSON.stringify(appState.studioParams), params0, 'studio params untouched');
    const many = own([{ type: 'glitch', params: { rate: 12 } }, { type: 'chroma', params: {} }]);
    a.ok(gridBakeRuns(bakeGrid(many, LINES, { ns: 'detached' })).length > MAX_GENERATED_VOICES, 'more pieces than voices');
    a.equal(StudioRegistry.generateVoices(GRID_ID, many).length, MAX_GENERATED_VOICES, 'cut to 64');
  });
}, G);

registerSelfCheck('Grid: Glissando source — lines follow the voices, edits and presets are undoable, Manager instances', (a) => {
  a.ok(MANAGER_STUDIOS.includes(GRID_ID), 'Grid can be added in the Manager');
  withIsolatedState(() => {
    appState.studioParams = { ...(appState.studioParams || {}) };
    delete appState.studioParams[GRID_ID];
    const p0 = getGridParams();
    a.ok(getGridParams() === p0 && p0.source.studio === 'glissando', 'memoised default document');
    const lines = getGridLines();
    a.equal(lines.length, appState.voices.filter((v) => v.duration > 0.02).length, 'one line per Glissando voice');
    a.ok(lines.every((l) => appState.voices.some((v) => v.id === l.key)), 'line keys are the voice ids');
    const key0 = gridResultKey(getGridParams());
    applyGridPreset('ripple');
    a.ok(getGridParams().preset === 'ripple' && getGridParams().space[0].type === 'wave', 'preset applied');
    a.ok(gridResultKey(getGridParams()) !== key0, 'a space edit changes the render key');
    const key1 = gridResultKey(getGridParams());
    editGrid((d) => { d.view.tMin = 1; d.tool.size = 33; }, { history: false });
    a.equal(gridResultKey(getGridParams()), key1, 'view / brush edits keep it');
    a.equal(appState.studioParams[GRID_ID].space.length, 1, 'stored in appState.studioParams.grid');
    a.ok(gridMasterLines(null).length >= 1, 'Master View lines of the default document');
    // Manager: two instances keep separate documents / 인스턴스별 문서 분리
    appState.manager = createDefaultManagerState();
    ensureManager();
    const g1 = addInstance(GRID_ID);
    focusInstance(g1.id);
    a.equal(getGridParams().preset, 'ripple', 'first instance shows the editor document');
    const g2 = addInstance(GRID_ID);
    focusInstance(g2.id);
    a.equal(getGridParams().preset, 'flat', 'second instance starts from the defaults');
    editGrid((d) => { d.gain = 0.3; });
    focusInstance(g1.id);
    a.equal(getGridParams().preset, 'ripple', 'first document restored');
    a.equal(resolveGridDoc(getInstance(g2.id).doc).gain, 0.3, 'second document kept its edit');
  });
  a.ok(resolveGridDoc(null) === resolveGridDoc(undefined), 'null = studio defaults');
}, G);

registerSelfCheck('Grid: windows — identical metrics, one view, resize lock (sync, unlock, re-lock), stored state', (a) => {
  const view = { tMin: -0.3, tMax: 16.3, midiMin: 34, midiMax: 98 };
  let st = normalizeDual(null);
  a.ok(st.lock && st.layout === 'stack' && st.hE === st.hR, 'default: locked, stacked, equal sizes');
  const same2 = (s, w) => { const d = dualSizes(s, w); return metricsKey(gridMetrics(d.editor.w, d.editor.h, view)) === metricsKey(gridMetrics(d.result.w, d.result.h, view)); };
  a.ok(same2(st, 900), 'stacked: identical metrics');
  st = resizePane(st, 'result', 410);
  a.ok(st.hE === 410 && st.hR === 410 && same2(st, 900), 'locked: resizing the Result resizes both');
  st = resizePane(st, 'editor', 333);
  a.ok(st.hE === 333 && st.hR === 333 && same2(st, 1200), 'locked: resizing the Editor resizes both');
  st = setDualLayout(st, 'side');
  const side = dualSizes(st, 1200);
  a.ok(side.layout === 'side' && side.editor.w === side.result.w && side.editor.w === Math.floor((1200 - DUAL_GAP) / 2) && same2(st, 1200), 'side by side: identical metrics');
  const narrow = dualSizes(st, DUAL_NARROW_W - 1);
  a.ok(narrow.layout === 'stack' && same2(st, DUAL_NARROW_W - 1), 'narrow container: stacked automatically, still identical');
  st = applyDualTotal(setDualLayout(st, 'stack'), 2 * 300 + DUAL_GAP, 900);
  a.ok(st.hE === 300 && st.hR === 300, 'a total height is split equally while locked');
  st = toggleDualLock(st);
  a.ok(!st.lock && st.hE === 300 && st.hR === 300, 'unlocking changes no size');
  st = resizePane(st, 'result', 180);
  a.ok(st.hE === 300 && st.hR === 180 && !same2(st, 900), 'unlocked: only the Result changed');
  st = resizePane(st, 'editor', 520);
  a.ok(st.hE === 520 && st.hR === 180 && st.last === 'editor', 'unlocked: only the Editor changed');
  a.equal(serializeDual(parseDual(serializeDual(st))), serializeDual(st), 'lock state and both sizes are stored and restored');
  st = toggleDualLock(st);
  a.ok(st.lock && st.hE === 520 && st.hR === 520 && same2(st, 900), 're-lock → both = the Editor (adjusted last)');
  st = toggleDualLock(resizePane(toggleDualLock(st), 'result', 240));
  a.ok(st.hE === 240 && st.hR === 240, 're-lock → both = the Result when it was adjusted last');
  a.ok(parseDual('not json').lock && normalizeDual({ lock: true, hE: 200, hR: 400, last: 'result' }).hE === 400 && normalizeDual({ hE: 5 }).hE === 120, 'broken storage → default; a locked state is equal; sizes are clamped');
  const d = dualSizes(normalizeDual(DUAL_DEFAULT), 1000);
  const mE = gridMetrics(d.editor.w, d.editor.h, view);
  const mR = gridMetrics(d.result.w, d.result.h, view);
  for (const [sec, midi] of [[0, 36], [7.25, 61.5], [16, 96]]) {
    a.ok(mE.timeToX(sec) === mR.timeToX(sec) && mE.midiToY(midi) === mR.midiToY(midi), `(${sec} s, ${midi}) is at the same pixel in both windows`);
    a.near(mE.xToTime(mR.timeToX(sec)), sec, 1e-9, 'time round trip');
    a.near(mR.yToMidi(mE.midiToY(midi)), midi, 1e-9, 'pitch round trip');
  }
  a.ok(mE.view === mR.view, 'both windows read one view object');
}, G);

registerSelfCheck('Grid: tools, selections, Restore (all / selection), Pull', (a) => {
  withIsolatedState(() => {
    const d0 = createDefaultGridParams();
    a.ok(d0.tool.mode === 'brush' && d0.tool.sel === null && d0.tool.hardness === 0 && d0.tool.aspect === 1 && d0.tool.axis === 'both', 'default tool = the round brush, no selection');
    const sel = { kind: 'selPitch', poly: [[-1e6, 116], [1e6, 116], [1e6, 124], [-1e6, 124]] };
    const withSel = sanitizeGridParams({ ...d0, tool: { ...d0.tool, sel } });
    a.equal(JSON.stringify(sanitizeGridParams(deepClone(withSel))), JSON.stringify(withSel), 'a document with a selection sanitises idempotently');
    a.equal(sanitizeGridParams({ tool: { sel: { kind: 'nope', poly: sel.poly } } }).tool.sel, null, 'unknown selection kinds are dropped');
    appState.studioParams[GRID_ID] = own(gridPresetSpace('ripple'));
    const key0 = gridResultKey(appState.studioParams[GRID_ID]);
    editGrid((d) => { d.tool.sel = sel; d.tool.feather = 0; }, { history: false });
    a.equal(gridResultKey(appState.studioParams[GRID_ID]), key0, 'a selection does not change the sound');
    // restore only the selection: a Restore stage at the end / 선택 영역 복원 = 스택 끝의 복원 단계
    let res = restoreGridSpace();
    a.ok(res.ok && res.scope === 'selection', 'restore with a selection');
    const p1 = getGridParams();
    a.equal(p1.space[p1.space.length - 1].type, 'restore', 'the Restore stage is last');
    const b1 = bakeGrid(p1, LINES, { ns: 'detached' });
    const c3 = b1.runs.find((r) => r.key === 'd1'); // C3 = 48, outside the band (58 – 62) / 띠 밖
    a.ok(b1.runs.filter((r) => r.key === 'd1').some((r) => r.pts.some((q) => Math.abs(q.m - 48) > 0.2)) && c3, 'outside the selection the ripple stays');
    // a line inside the band: G3 = 55 is outside, so check with a band around 55 / 띠 안의 선
    editGrid((d) => { d.tool.sel = { kind: 'selPitch', poly: [[-1e6, 106], [1e6, 106], [1e6, 114], [-1e6, 114]] }; }, { history: false });
    restoreGridSpace();
    const g3 = bakeGrid(getGridParams(), LINES, { ns: 'detached' }).runs.filter((r) => r.key === 'd2');
    a.ok(g3.every((r) => r.pts.every((q) => Math.abs(q.m - 55) < 1e-6)), 'inside the selection the line is back where it was');
    a.equal(getGridParams().space.filter((it) => it.type === 'restore').length, 1, 'regions collect in one Restore stage');
    // restore all = flat / 전체 복원 = 평평
    editGrid((d) => { d.tool.sel = null; }, { history: false });
    res = restoreGridSpace();
    a.ok(res.ok && res.scope === 'all' && getGridParams().space.length === 0 && getGridParams().preset === 'flat', 'restore without a selection = flat space');
    a.equal(restoreGridSpace().reason, 'flat', 'nothing to restore on a flat space');
    // pull / 당기기
    a.equal(beginGridPull([0, 0], { region: null }).reason, 'nosel', 'pull needs a selection');
    const region = { poly: sel.poly, feather: 0 };
    let s = beginGridPull([40, 120], { region, mode: 'move' });
    writeGridPull(s, 0, 8);
    s = beginGridPull([40, 120], { region, mode: 'move' });
    a.ok(s.opIndex === 0 && s.base[1] === 8, 'grabbing the same selection again continues the last pull');
    writeGridPull(s, 0, 4);
    const pl = getGridParams().space.find((it) => it.type === 'pull');
    a.ok(pl && pl.params.ops.length === 1 && pl.params.ops[0].dy === 12, 'one pull of 12 cells');
  });
}, G);
