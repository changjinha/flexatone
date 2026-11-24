/**
 * Flexatone — studios/grid/grid-checks.js
 * Grid Studio (pure): self-checks of the studio engine, the effects, the bake and the window layout.
 * Imported by studios/grid-studio.js (its exports are only used inside the check bodies, so the
 * import cycle is harmless). The audio checks live in grid-audio.js.
 * 그리드 스튜디오 (순수): 스튜디오 엔진·효과·베이킹·윈도우 레이아웃 자가진단. 오디오 검사는 grid-audio.js.
 */

import { deepClone } from '../../core/math-utils.js';
import { appState, registerSelfCheck, withIsolatedState, createDefaultManagerState } from '../../core/state.js';
import { ensureManager, addInstance, focusInstance, getInstance, MANAGER_STUDIOS } from '../../core/manager-state.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from '../registry.js';
import {
  GridEffectRegistry, createGridEffectRegistry, validateGridEffect, sanitizeEffectParams, makeBlurPlan, planKernel, blurMatrix, blurMatrixDirect,
  perspectiveAmount, glitchEvents, halftoneSegments, halftoneOffset, renderGate, liquifyMesh, chromaRatio, GRID_TIER1,
} from './grid-effects.js';
import {
  encodeRaster, decodeRaster, emptyRaster, gridShape, regridRaster, sanitizeGridParams, createDefaultGridParams, createGridPreset, createStackItem,
  gridDims, rasterToMatrix, bakeGrid, bakeGridAsync, gridSignature, getGridBakeCount, withIsolatedGridCache, planVoices, GRID_PRESET_IDS,
} from './grid-engine.js';
import { paintLine, rectCoverage, stampBrush, compositeStroke, floodCoverage, polygonCoverage } from './grid-tools.js';
import {
  normalizeDual, resizePane, toggleDualLock, setDualLayout, dualSizes, applyDualTotal, serializeDual, parseDual, gridMetrics, metricsKey, DUAL_DEFAULT, DUAL_GAP, DUAL_NARROW_W,
} from './grid-layout.js';
import { GRID_ID, getGridParams, editGrid, gridBakeLines, lineToVoice, voicePitchAt, gridBakeLoss, resolveGridDoc, gridMasterLines, linePitch } from '../grid-studio.js';

const G = { group: 'studio' };

/** A small document (C4 – C5, 2 rows / semitone, 8 columns / s). / 작은 테스트 문서 */
function tiny({ grid = {}, render = {}, paint = null, stack = [], layer = {}, selection = null } = {}) {
  const base = createDefaultGridParams();
  const g = sanitizeGridParams({ grid: { pLo: 60, pHi: 72, rowsPerSemi: 2, colsPerSec: 8, length: 2, ...grid } }).grid;
  const { rows, cols } = gridShape(g);
  const ras = new Float32Array(rows * cols);
  if (paint) paint(ras, rows, cols, g);
  return sanitizeGridParams({ ...base, preset: '', grid: g, render: { ...base.render, ...render }, layers: [{ ...base.layers[0], ...layer, raster: encodeRaster(ras, rows, cols), stack }], selection, view: null });
}
const rowOf = (g, midi) => (midi - g.pLo) * g.rowsPerSemi + 0.5;
const held = (midi, v = 1) => (ras, rows, cols, g) => { paintLine(ras, rows, cols, 0, rowOf(g, midi), cols, rowOf(g, midi), v); };
const fxItem = (type, params = {}, over = {}) => createStackItem(type, { params, ...over });

/** Run one effect directly on a matrix. / 효과 하나를 행렬에 직접 실행 */
function runFx(type, params, src, { N, F, rate = 100, bps = 8, rows = 25, cols = 16, rowsPerSemi = 2, colsPerSec = 8, seed = 1 }) {
  const dst = new Float32Array(F * N);
  const info = {};
  const fx = GridEffectRegistry.get(type);
  (fx.apply || fx.matrix)({ src, dst, N, F, rate, bps, pLo: 60, grid: { rowsPerSemi, colsPerSec, rows, cols }, seed, p: sanitizeEffectParams(type, params), alloc: () => new Float32Array(F * N), free() {}, info });
  return { M: dst, info };
}

const sumSq = (M) => { let s = 0; for (let j = 0; j < M.length; j++) s += M[j] * M[j]; return s; };
const same = (A, B) => { if (A.length !== B.length) return false; for (let j = 0; j < A.length; j++) if (A[j] !== B[j]) return false; return true; };
const maxDiff = (A, B) => { let d = 0; for (let j = 0; j < A.length; j++) d = Math.max(d, Math.abs(A[j] - B[j])); return d; };
/** Amplitude-weighted centroid along bins (axis 'i') or frames (axis 'f'). / 진폭 가중 중심 */
function centroid(M, N, F, axis) {
  let s = 0;
  let w = 0;
  for (let f = 0; f < F; f++) for (let i = 0; i < N; i++) { const v = M[f * N + i]; s += v * (axis === 'i' ? i : f); w += v; }
  return s / Math.max(1e-30, w);
}

registerSelfCheck('Grid: registered, deterministic defaults, presets sanitise idempotently, effect registry contract', (a) => {
  a.ok(StudioRegistry.has(GRID_ID) && StudioRegistry.get(GRID_ID).order === 110, 'registered (order 110)');
  a.equal(JSON.stringify(createDefaultGridParams()), JSON.stringify(createDefaultGridParams()), 'defaults are deterministic (stable bake cache)');
  a.equal(GRID_PRESET_IDS.length, 10, 'ten presets');
  for (const id of GRID_PRESET_IDS) {
    const p = sanitizeGridParams(createGridPreset(id));
    a.equal(JSON.stringify(sanitizeGridParams(deepClone(p))), JSON.stringify(p), `sanitize is idempotent (${id})`);
    const types = p.layers[0].stack.map((it) => it.type);
    a.ok(types.slice(-2).join() === 'noise,chroma', `output-stage effects last, in order (${id})`);
  }
  for (const fx of GridEffectRegistry.list()) a.equal(validateGridEffect(fx).join('; '), '', `effect "${fx.id}" valid`);
  a.ok(GRID_TIER1.every((id) => GridEffectRegistry.has(id)), 'the six Tier 1 effects are registered');
  a.ok(GridEffectRegistry.get('noise').domain === 'bank' && GridEffectRegistry.get('chroma').domain === 'bank' && GridEffectRegistry.get('blur').domain === 'matrix', 'domains');
  a.ok(validateGridEffect({ id: 'x', name: { en: 'X' }, domain: 'matrix', params: [], defaults: () => ({}) }).length > 0, 'bad definition rejected');
  a.ok(validateGridEffect({ id: 'ok', name: { en: 'A', ko: 'B' }, domain: 'matrix', params: [{ key: 'k', type: 'range', min: 0, max: 1 }], defaults: () => ({}), apply() {} }).length > 0, 'defaults must cover the schema');
  const reg = createGridEffectRegistry();
  reg.register({ id: 'gainTest', name: { en: 'Gain', ko: '게인' }, domain: 'matrix', params: [{ key: 'g', type: 'range', min: 0, max: 2 }], defaults: () => ({ g: 1 }), apply({ src, dst, p }) { for (let j = 0; j < src.length; j++) dst[j] = src[j] * p.g; } });
  a.ok(reg.has('gainTest') && reg.list('matrix').length === 1, 'a new effect = one object');
  let threw = false;
  try { reg.register({ id: 'gainTest', name: { en: 'G', ko: 'G' }, domain: 'matrix', params: [], defaults: () => ({}), apply() {} }); } catch { threw = true; }
  a.ok(threw, 'duplicate id rejected');
  a.equal(sanitizeEffectParams('blur', { sigmaCents: 9999, mode: 'nope' }).sigmaCents, 400, 'parameters clamped to the schema');
  a.equal(sanitizeEffectParams('blur', { mode: 'nope' }).mode, 'gaussian', 'unknown option → default');
}, G);

registerSelfCheck('Grid: raster — RLE8 round trip (≤ 1/255), empty raster is a few bytes, resampling keeps ink and position', (a) => {
  const rows = 40;
  const cols = 60;
  const src = new Float32Array(rows * cols);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7919) % 13 < 4 ? ((i * 104729) % 256) / 255 : 0;
  const enc = encodeRaster(src, rows, cols);
  const dec = decodeRaster(enc);
  a.ok(maxDiff(src, dec) <= 0.5 / 255 + 1e-6, `quantisation error ${maxDiff(src, dec).toExponential(2)}`);
  a.equal(encodeRaster(dec, rows, cols).data, enc.data, 'second round trip is exact');
  a.ok(emptyRaster(121, 128).data.length <= 12, `empty 121 × 128 raster = ${emptyRaster(121, 128).data.length} characters`);
  const big = encodeRaster(new Float32Array(200000).fill(1), 400, 500);
  a.ok(big.data.length <= 16 && decodeRaster(big)[199999] === 1, 'a long run of one value stays tiny');
  // a block in the middle: ink (Σ value × cell area) survives a change of resolution / 가운데 블록의 잉크 총량 보존
  const from = { pLo: 48, pHi: 72, rowsPerSemi: 2, colsPerSec: 8, length: 4 };
  const A = gridShape(from);
  const ras = new Float32Array(A.rows * A.cols);
  for (let r = 16; r < 32; r++) for (let c = 8; c < 20; c++) ras[r * A.cols + c] = 0.8;
  const ink = (v, g) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i]; return s / (g.rowsPerSemi * g.colsPerSec); };
  for (const to of [{ ...from, rowsPerSemi: 1, colsPerSec: 4 }, { ...from, rowsPerSemi: 4, colsPerSec: 16 }, { ...from, rowsPerSemi: 3, colsPerSec: 6 }]) {
    const out = regridRaster(ras, from, to, 'area');
    a.near(ink(out, to) / ink(ras, from), 1, 0.02, `ink kept at ${to.rowsPerSemi} rows/st × ${to.colsPerSec} cols/s`);
  }
  // range and length changes keep every cell at its pitch and time / 음역·길이 변경 시 위치 유지
  const wide = { ...from, pLo: 36, pHi: 84, length: 8 };
  const B = gridShape(wide);
  const moved = regridRaster(ras, from, wide, 'area');
  const shift = (from.pLo - wide.pLo) * from.rowsPerSemi;
  a.near(moved[(20 + shift) * B.cols + 10], 0.8, 1e-6, 'same pitch after widening the range');
  a.equal(moved[(20 + shift) * B.cols + 40], 0, 'the new time is empty');
  a.equal(sanitizeGridParams({ grid: { pLo: 0, pHi: 127, rowsPerSemi: 4, colsPerSec: 64, length: 120 } }).grid.colsPerSec < 64, true, 'cell count capped (≤ 200 k)');
}, G);

registerSelfCheck('Grid: fine matrix — a painted row is one bin at its pitch (± ½ bin), energy kept ± 2 %', (a) => {
  const doc = tiny({ paint: (ras, rows, cols, g) => paintLine(ras, rows, cols, 4, rowOf(g, 63), 8, rowOf(g, 63), 1) });
  const dims = gridDims(doc);
  const shape = gridShape(doc.grid);
  const M = rasterToMatrix(decodeRaster(doc.layers[0].raster), shape, doc.grid, dims, doc.render.edgeMs);
  a.near(centroid(M, dims.N, dims.F, 'i'), 3 * dims.bps, 0.5, 'pitch centroid = bin of D#4');
  let nz = 0;
  for (let i = 0; i < dims.N; i++) { let any = false; for (let f = 0; f < dims.F; f++) if (M[f * dims.N + i] > 0) any = true; if (any) nz++; }
  a.equal(nz, 1, 'one painted row → exactly one bin (a pure tone)');
  // 4 cells (columns 4 … 7) of value 1 at 8 cells / s / 값 1인 셀 4개
  a.near(sumSq(M) / dims.rate, 4 / doc.grid.colsPerSec, 0.02 * (4 / 8), 'energy = Σ value² × cell time');
  a.near(centroid(M, dims.N, dims.F, 'f') / dims.rate, 6 / 8, 0.01, 'time centroid = centre of the painted cells');
  // a row between two bins is split power-preservingly / 두 빈 사이의 행은 파워 보존 분할
  const off = tiny({ grid: { rowsPerSemi: 3 }, paint: (ras, rows, cols) => paintLine(ras, rows, cols, 4, 1.5, 8, 1.5, 1) });
  const d2 = gridDims(off);
  const M2 = rasterToMatrix(decodeRaster(off.layers[0].raster), gridShape(off.grid), off.grid, d2, off.render.edgeMs);
  a.near(sumSq(M2) / d2.rate, 4 / 8, 0.02 * (4 / 8), 'energy kept for an off-bin row');
  let s = 0;
  let w = 0;
  for (let f = 0; f < d2.F; f++) for (let i = 0; i < d2.N; i++) { s += M2[f * d2.N + i] ** 2 * i; w += M2[f * d2.N + i] ** 2; }
  a.near(s / w, d2.bps / 3, 0.5, 'power centroid at the row pitch');
  // quality and long pieces stay inside the matrix budget / 긴 곡도 행렬 예산 안
  const long = sanitizeGridParams({ ...createDefaultGridParams(), grid: { pLo: 36, pHi: 96, rowsPerSemi: 2, colsPerSec: 8, length: 60 } });
  const dl = gridDims(long);
  a.ok(dl.N * dl.F <= 1.6e6 && dl.downgraded, `60 s: ${dl.N} × ${dl.F} @ ${dl.rate} Hz (downgraded)`);
  const pv = gridDims(createDefaultGridParams(), { preview: true });
  a.ok(pv.N * pv.F <= 0.25e6, `preview ${pv.N} × ${pv.F}`);
}, G);

registerSelfCheck('Grid: Blur — σ 0 identity, spread = σ (± 10 %), power kept, motion trail, perspective, separable = 2-D', (a) => {
  const N = 481;
  const F = 6;
  const line = new Float32Array(N * F);
  for (let f = 0; f < F; f++) line[f * N + 240] = 1;
  const o = { N, F, rate: 100, bps: 8 };
  const id = runFx('blur', { mode: 'gaussian', sigmaCents: 0, sigmaMs: 0, shimmer: 1 }, line, o).M;
  a.ok(same(id, line), 'σ = 0 is the identity, bit for bit');
  let prev = 0;
  for (const cents of [20, 60, 150, 300]) {
    const M = runFx('blur', { mode: 'gaussian', sigmaCents: cents, sigmaMs: 0, shimmer: 0, normalize: 'power' }, line, o).M;
    let s0 = 0;
    let s2 = 0;
    for (let i = 0; i < N; i++) { s0 += M[2 * N + i]; s2 += M[2 * N + i] * (i - 240) ** 2; }
    const std = (Math.sqrt(s2 / s0) / 8) * 100;
    a.near(std, cents, 0.1 * cents, `σ ${cents} ¢: measured spread`);
    a.ok(std > prev, 'spread grows with σ');
    prev = std;
    a.near(sumSq(M) / sumSq(line), 1, 0.05, `σ ${cents} ¢: power kept (Σk² = 1)`);
  }
  const peak = runFx('blur', { mode: 'gaussian', sigmaCents: 100, shimmer: 0, normalize: 'peak' }, line, o).M;
  a.near(peak[2 * N + 240], 1, 0.02, "normalize 'peak' keeps the centre");
  const sum = runFx('blur', { mode: 'gaussian', sigmaCents: 100, shimmer: 0, normalize: 'sum' }, line, o).M;
  let tot = 0;
  for (let i = 0; i < N; i++) tot += sum[2 * N + i];
  a.near(tot, 1, 0.02, "normalize 'sum' keeps the area");
  // box approximation ≈ exact Gaussian / 박스 근사 ≈ 정확한 가우시안
  const kb = planKernel(makeBlurPlan(12));
  const ke = planKernel(makeBlurPlan(12, { exact: true }));
  let dk = 0;
  for (let i = 0; i < Math.min(kb.length, ke.length); i++) dk = Math.max(dk, Math.abs(kb[(kb.length - 1) / 2 + i - Math.floor(Math.min(kb.length, ke.length) / 2)] - ke[(ke.length - 1) / 2 + i - Math.floor(Math.min(kb.length, ke.length) / 2)]));
  a.ok(dk < 0.004, `3 box passes vs Gaussian at σ = 12: max kernel error ${dk.toExponential(2)}`);
  // separable passes = direct 2-D convolution / 분리형 = 2D 직접 컨볼루션
  const n2 = 40;
  const f2 = 30;
  const rnd = new Float32Array(n2 * f2);
  for (let j = 0; j < rnd.length; j++) rnd[j] = (j * 7919) % 17 === 0 ? ((j * 31) % 10) / 10 : 0;
  const sep = new Float32Array(rnd.length);
  blurMatrix(rnd, sep, n2, f2, 2, 1.5, 'power', { exact: true });
  a.ok(maxDiff(sep, blurMatrixDirect(rnd, n2, f2, 2, 1.5, 'power')) < 1e-5, 'separable = direct 2-D');
  // motion: a short event, trail both / after / before / 모션 블러 꼬리 방향
  const Fm = 200;
  const Nm = 97;
  const ev = new Float32Array(Nm * Fm);
  for (let f = 98; f < 102; f++) ev[f * Nm + 48] = 1;
  const om = { N: Nm, F: Fm, rate: 100, bps: 8 };
  const c0 = centroid(ev, Nm, Fm, 'f');
  const both = runFx('blur', { mode: 'motion', lengthMs: 400, lengthSemi: 0, trail: 'both' }, ev, om).M;
  a.near(centroid(both, Nm, Fm, 'f'), c0, 0.5, "trail 'both': the centre of mass stays");
  const after = runFx('blur', { mode: 'motion', lengthMs: 400, lengthSemi: 3, trail: 'after' }, ev, om).M;
  a.ok(centroid(after, Nm, Fm, 'f') > c0 + 5 && centroid(after, Nm, Fm, 'i') > 48 + 4, "trail 'after': later in time, upward in pitch");
  const before = runFx('blur', { mode: 'motion', lengthMs: 400, lengthSemi: 0, trail: 'before' }, ev, om).M;
  a.ok(centroid(before, Nm, Fm, 'f') < c0 - 5, "trail 'before': earlier (pre-echo)");
  // perspective: σ(x, y) formula / 퍼스펙티브 σ(x, y) 공식
  const pp = sanitizeEffectParams('blur', { mode: 'perspective', shape: 'radial', t0: 0.5, p0: 0.5, inner: 0.2, falloff: 2 });
  a.equal(perspectiveAmount(pp, 0.5, 0.5), 0, 'focus is sharp');
  a.equal(perspectiveAmount(pp, 0.55, 0.5), 0, 'inside the inner radius');
  a.near(perspectiveAmount(pp, 1, 1), 1, 1e-9, 'far corner = full blur');
  a.near(perspectiveAmount(pp, 0.5, 0.9), ((0.8 / Math.SQRT2 - 0.2) / 0.8) ** 2, 1e-9, 'radial fall-off with γ = 2');
  const tp = { ...pp, shape: 'tiltShift-pitch' };
  a.equal(perspectiveAmount(tp, 0.1, 0.7), perspectiveAmount(tp, 0.9, 0.7), 'tilt-shift (pitch) ignores time');
  const tt = { ...pp, shape: 'tiltShift-time' };
  a.equal(perspectiveAmount(tt, 0.3, 0.1), perspectiveAmount(tt, 0.3, 0.9), 'tilt-shift (time) ignores pitch');
  const lineP = new Float32Array(Nm * Fm);
  for (let f = 0; f < Fm; f++) lineP[f * Nm + 48] = 1;
  const pm = runFx('blur', { mode: 'perspective', shape: 'tiltShift-time', t0: 0.5, p0: 0.5, inner: 0.1, falloff: 1, maxCents: 100, maxMs: 0, shimmer: 0 }, lineP, om).M;
  const width = (f) => { let n = 0; for (let i = 0; i < Nm; i++) if (pm[f * Nm + i] > 0.01) n++; return n; };
  a.ok(width(100) === 1 && width(2) > 10, `sharp at the focus (${width(100)} bin), a cloud at the edge (${width(2)} bins)`);
}, G);

registerSelfCheck('Grid: Glitch — Poisson count, grain lengths, seeds, rate 0 identity, toPainted lands on painted rows', (a) => {
  const p = sanitizeEffectParams('glitch', { rate: 10, durMin: 5, durMax: 40, jump: 'uniform', rangeSemi: 12, probability: 1 });
  const ev = glitchEvents(p, { length: 60, seed: 1 });
  a.ok(Math.abs(ev.length - 600) <= 3 * Math.sqrt(600), `${ev.length} events in 60 s at 10 / s (600 ± ${Math.round(3 * Math.sqrt(600))})`);
  a.ok(ev.every((e) => e.dur >= 0.005 - 1e-9 && e.dur <= 0.04 + 1e-9), 'grain lengths inside [min, max]');
  a.ok(ev.every((e) => Math.abs(e.jump) <= 12 + 1e-9), 'jumps inside the range');
  a.equal(JSON.stringify(glitchEvents(p, { length: 60, seed: 1 })), JSON.stringify(ev), 'same seed → same events');
  a.ok(JSON.stringify(glitchEvents(p, { length: 60, seed: 2 })) !== JSON.stringify(ev), 'another document seed → other events');
  a.ok(JSON.stringify(glitchEvents({ ...p, seed: 5 }, { length: 60, seed: 1 })) !== JSON.stringify(ev), 'another effect seed → other events');
  const half = glitchEvents({ ...p, probability: 0.5 }, { length: 60, seed: 1 });
  a.ok(half.length === ev.length && half.every((e, k) => e.t === ev[k].t), 'probability thins the same timeline');
  a.near(half.filter((e) => e.keep).length / ev.length, 0.5, 0.08, 'half of the events kept');
  const oct = glitchEvents({ ...p, jump: 'octave', rangeSemi: 24 }, { length: 20, seed: 1 });
  a.ok(oct.every((e) => [12, 24].includes(Math.abs(e.jump))), 'octave jumps are whole octaves');
  a.equal(glitchEvents({ ...p, rate: 0 }, { length: 60, seed: 1 }).length, 0, 'rate 0 → no event');
  const N = 97;
  const F = 400;
  const M = new Float32Array(N * F);
  for (let f = 0; f < F; f++) { M[f * N + 16] = 1; M[f * N + 48] = 0.8; M[f * N + 80] = 0.6; }
  const o = { N, F, rate: 200, bps: 8 };
  a.ok(same(runFx('glitch', { rate: 0 }, M, o).M, M), 'rate 0 is the identity');
  const g = runFx('glitch', { rate: 1.5, jump: 'uniform', rangeSemi: 6, fadeMs: 20, durMin: 60, durMax: 80 }, M, o); // sparse: events do not overlap / 이벤트가 겹치지 않게
  a.ok(!same(g.M, M) && g.info.events.length >= 1, `${g.info.events.length} events applied`);
  let step = 0;
  for (let f = 1; f < F; f++) for (let i = 0; i < N; i++) step = Math.max(step, Math.abs(g.M[f * N + i] - g.M[(f - 1) * N + i]));
  a.ok(step <= 0.45, `no amplitude step at event edges (largest frame-to-frame change ${step.toFixed(3)} with a 20 ms fade)`);
  a.ok(same(runFx('glitch', { rate: 12, jump: 'uniform', rangeSemi: 6 }, M, o).M, runFx('glitch', { rate: 12, jump: 'uniform', rangeSemi: 6 }, M, o).M), 'deterministic');
  const tp = runFx('glitch', { rate: 15, jump: 'toPainted', rangeSemi: 36 }, M, o);
  a.ok(tp.info.events.length > 5 && tp.info.events.every((e) => [16, 48, 80].includes(e.dest)), 'toPainted: every destination is a painted pitch');
  let stray = 0;
  for (let f = 0; f < F; f++) for (let i = 0; i < N; i++) if (tp.M[f * N + i] > 0.05 && ![16, 48, 80].includes(i)) stray++;
  a.equal(stray, 0, 'toPainted: energy only on painted pitches');
  const tj = runFx('glitch', { rate: 10, jump: 'uniform', rangeSemi: 0, timeJumpMs: 500, bandFraction: 0.3 }, M, o);
  a.ok(tj.info.events.every((e) => e.jump === 0 && e.bandHi - e.bandLo < N), 'time glitch on a part of the range');
}, G);

registerSelfCheck('Grid: Halftone — duty, on / off length distributions, edges, screen angle, dropout', (a) => {
  const p = sanitizeEffectParams('halftone', { periodMs: 200, dutyFrom: 'fixed', duty: 0.4, jitter: 0.3, silenceJitter: 0.5, dropout: 0, edgeMs: 20, shape: 'line' });
  const segs = halftoneSegments(p, 3, { length: 800, seed: 1 });
  const stat = (xs) => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length; return { m, cv: Math.sqrt(v) / m }; };
  const on = stat(segs.map((s) => s.len));
  const off = stat(segs.map((s) => s.gap));
  a.near(on.m, 0.08, 0.008, 'mean on length = period × duty');
  a.near(on.cv, 0.3, 0.03, 'CV of the on length = jitter');
  a.near(off.m, 0.12, 0.012, 'mean off length = period × (1 − duty)');
  a.near(off.cv, 0.5, 0.05, 'CV of the off length = silence jitter (independent)');
  a.near(on.m / (on.m + off.m), 0.4, 0.02, 'mean duty');
  const dr = halftoneSegments({ ...p, dropout: 0.3 }, 3, { length: 800, seed: 1 });
  a.near(dr.filter((s) => s.dropped).length / dr.length, 0.3, 0.03, 'dropout ratio');
  a.ok(JSON.stringify(halftoneSegments(p, 3, { length: 50, seed: 1 })) === JSON.stringify(halftoneSegments(p, 3, { length: 50, seed: 1 })), 'deterministic');
  a.ok(JSON.stringify(halftoneSegments(p, 4, { length: 50, seed: 1 })) !== JSON.stringify(halftoneSegments(p, 3, { length: 50, seed: 1 })), 'gate units are independent');
  // regular gate: edges are ramps of edgeMs, duty exact / 규칙 게이트: 엣지 = edgeMs 램프
  const reg = { ...p, jitter: 0, silenceJitter: 0, duty: 0.5 };
  const rate = 200;
  const F = 2000;
  const gate = renderGate(halftoneSegments(reg, 0, { length: F / rate, seed: 1 }), F, rate, reg);
  let step = 0;
  let mean = 0;
  for (let f = 1; f < F; f++) { step = Math.max(step, Math.abs(gate[f] - gate[f - 1])); mean += gate[f]; }
  a.ok(step <= 1 / (0.02 * rate) + 1e-6, `edge ramp ≥ edgeMs (largest step ${step.toFixed(3)} per 5 ms frame)`);
  a.near(mean / F, 0.5 - 0.02 / 0.2, 0.03, 'gate area = duty minus the two ramps');
  const sq = renderGate(halftoneSegments({ ...reg, shape: 'square' }, 0, { length: F / rate, seed: 1 }), F, rate, { ...reg, shape: 'square' });
  let m2 = 0;
  for (let f = 0; f < F; f++) m2 += sq[f];
  a.near(m2 / F, 0.5, 0.05, 'square dots: duty 0.5');
  // screen angle: phase offset per pitch, exactly / 스크린 각도: 음고별 위상 오프셋
  const grid = { rowsPerSemi: 2, colsPerSec: 8 };
  const ang = { ...reg, angle: 45 };
  a.near(halftoneOffset(ang, 1, grid), 0.25, 1e-12, '45°: one semitone = one cell diagonal = 0.25 s');
  a.equal(halftoneOffset({ ...reg, angle: 0 }, 7, grid), 0, '0°: no offset');
  for (const semis of [0, 1, 2.5]) {
    const offS = halftoneOffset(ang, semis, grid);
    const sg = halftoneSegments(ang, 0, { length: 4, seed: 1, offsetSec: offS });
    a.ok(sg.every((s) => Math.abs((s.on - offS) / 0.2 - Math.round((s.on - offS) / 0.2)) < 1e-9), `rows ${semis} st apart start ${offS.toFixed(3)} s later (mod period)`);
  }
  // apply: two lines 1 semitone apart, 45° → their gates are 0.25 s (mod 0.2 s = 0.05 s) apart / 실제 적용
  const N = 97;
  const M = new Float32Array(N * 800);
  for (let f = 0; f < 800; f++) { M[f * N + 40] = 1; M[f * N + 48] = 1; }
  const out = runFx('halftone', { ...ang, scope: 'perBin' }, M, { N, F: 800, rate: 200, bps: 8 }).M;
  const rise = (i) => { for (let f = 41; f < 800; f++) if (out[(f - 1) * N + i] === 0 && out[f * N + i] > 0) return f; return -1; };
  a.near(((rise(48) - rise(40)) / 200 + 0.2) % 0.2, 0.05, 0.006, 'gate of the upper line is shifted by the angle');
  const amp = runFx('halftone', { ...reg, dutyFrom: 'amplitude', scope: 'layer' }, (() => { const q = new Float32Array(N * 800); for (let f = 0; f < 800; f++) q[f * N + 40] = f < 400 ? 0.25 : 0.9; return q; })(), { N, F: 800, rate: 200, bps: 8 }).M;
  const onShare = (f0, f1) => { let n = 0; for (let f = f0; f < f1; f++) if (amp[f * N + 40] > 0) n++; return n / (f1 - f0); };
  a.ok(onShare(450, 800) > onShare(50, 400) + 0.3, `dot size follows the amplitude (duty ${onShare(50, 400).toFixed(2)} → ${onShare(450, 800).toFixed(2)})`);
}, G);

registerSelfCheck('Grid: Liquify — no strokes = identity, push moves by Δ (± 5 %), replay is deterministic, reconstruct, lockTime, energy', (a) => {
  const rows = 25;
  const cols = 16;
  const N = 97;
  const F = 200;
  const o = { N, F, rate: 100, bps: 8, rows, cols };
  const M = new Float32Array(N * F);
  for (let f = 90; f < 110; f++) for (let i = 44; i < 53; i++) M[f * N + i] = Math.exp(-0.5 * (((f - 100) / 5) ** 2 + ((i - 48) / 2) ** 2));
  a.ok(same(runFx('liquify', { ops: [] }, M, o).M, M), 'no strokes = identity, bit for bit');
  a.ok(same(runFx('liquify', { amount: 0, ops: [{ tool: 'push', size: 20, strength: 1, pts: [[8, 12.5], [8, 15.5]] }] }, M, o).M, M), 'amount 0 = identity');
  const push = [{ tool: 'push', size: 20, strength: 1, pts: [[8, 12.5], [8, 15.5]] }];
  const up = runFx('liquify', { ops: push, jacobian: true }, M, o).M;
  const dBins = centroid(up, N, F, 'i') - centroid(M, N, F, 'i');
  a.near(dBins, 3 * 4, 0.05 * 12, 'push by 3 rows = 1.5 semitones = 12 bins');
  a.near(sumSq(up) / sumSq(M), 1, 0.05, 'energy kept (|det J| correction)');
  a.ok(same(runFx('liquify', { ops: deepClone(push) }, M, o).M, up), 'replaying the strokes is deterministic');
  const m1 = liquifyMesh(sanitizeEffectParams('liquify', { ops: push }).ops, rows, cols);
  a.ok(m1.any && m1.W === cols * 2 + 1 && m1.H === rows * 2 + 1, 'mesh: 2 nodes per editor cell (independent of the render quality)');
  // diagonal push with lockTime: only the pitch moves / lockTime: 음고만 이동
  const diag = [{ tool: 'push', size: 20, strength: 1, pts: [[6, 12.5], [10, 15.5]] }];
  const free = runFx('liquify', { ops: diag, lockTime: false }, M, o).M;
  const lock = runFx('liquify', { ops: diag, lockTime: true }, M, o).M;
  a.ok(Math.abs(centroid(free, N, F, 'f') - centroid(M, N, F, 'f')) > 20, 'without the lock the picture also moves in time');
  a.near(centroid(lock, N, F, 'f'), centroid(M, N, F, 'f'), 0.05, 'lockTime: the time centre does not move (± 0.5 ms)');
  a.ok(centroid(lock, N, F, 'i') > centroid(M, N, F, 'i') + 8, 'lockTime: the pitch still bends');
  // reconstruct brushed over the whole picture restores it / 복원 브러시로 전체를 문지르면 원래대로
  const scrub = Array.from({ length: 48 }, (_, k) => [8 + (k % 2) * 0.5, 12.5]);
  const rec = runFx('liquify', { ops: [...push, { tool: 'reconstruct', size: 40, strength: 1, pts: scrub }] }, M, o).M;
  a.ok(maxDiff(rec, M) < 1e-6, `reconstruct → identity (max |Δ| ${maxDiff(rec, M).toExponential(2)})`);
  const tw = runFx('liquify', { ops: [{ tool: 'twirlCW', size: 10, strength: 1, pts: [[8, 12.5], [8, 12.6], [8, 12.5]] }] }, M, o).M;
  a.ok(!same(tw, M) && Math.abs(centroid(tw, N, F, 'i') - centroid(M, N, F, 'i')) < 1.5, 'twirl turns the picture around the brush centre');
}, G);

registerSelfCheck('Grid: pipeline — stage cache, off / mix 0 identity, mask, stable signature, bit-exact determinism', async (a) => {
  const paint = (ras, rows, cols, g) => { held(64)(ras, rows, cols, g); held(69, 0.7)(ras, rows, cols, g); };
  const stack = () => [fxItem('blur', { mode: 'gaussian', sigmaCents: 40 }), fxItem('glitch', { rate: 6 }), fxItem('halftone', { periodMs: 100 })];
  const doc = tiny({ paint, stack: stack() });
  await withIsolatedGridCache(async () => {
    const count = getGridBakeCount();
    const b1 = bakeGrid(doc);
    a.equal(b1.stats.recomputed, 4, 'first bake: base + 3 stages');
    a.equal(getGridBakeCount(), count + 1, 'one bake counted');
    a.ok(bakeGrid(sanitizeGridParams(deepClone(doc))) === b1 && getGridBakeCount() === count + 1, 'same document → the same result object, 0 stages');
    // sound-only edits / 소리 전용 편집
    const snd = deepClone(doc);
    Object.assign(snd.layers[0], { gain: 0.4, pan: -0.5, muted: true });
    snd.layers[0].timbre.saw = 1;
    snd.layers[0].stack.find((it) => it.type === 'chroma').on = true;
    Object.assign(snd.layers[0].stack.find((it) => it.type === 'noise'), { on: true, params: { ...snd.layers[0].stack.find((it) => it.type === 'noise').params, levelDb: -10, follow: 0.5 } });
    snd.view.colorR = 'gray';
    snd.tool.size = 12;
    snd.render.maxActive = 99;
    a.ok(bakeGrid(sanitizeGridParams(snd)) === b1 && getGridBakeCount() === count + 1, 'timbre / gain / pan / bank effects / view / tool: 0 stages recomputed');
    // a later effect changes → earlier stages are reused / 뒤 효과만 바뀌면 앞 단계 재사용
    const last = deepClone(doc);
    last.layers[0].stack[2].params.periodMs = 180;
    const b2 = bakeGrid(sanitizeGridParams(last));
    a.equal(b2.stats.recomputed, 1, 'last effect edited → 1 stage recomputed');
    const mid = deepClone(last);
    mid.layers[0].stack[1].params.rate = 9;
    a.equal(bakeGrid(sanitizeGridParams(mid)).stats.recomputed, 2, 'middle effect edited → 2 stages recomputed');
    const pic = deepClone(mid);
    pic.layers[0].raster = tiny({ paint: held(62) }).layers[0].raster;
    a.equal(bakeGrid(sanitizeGridParams(pic)).stats.recomputed, 4, 'picture edited → everything recomputed');
    a.equal(getGridBakeCount(), count + 4, 'four bakes with work');
    const asyncBake = await bakeGridAsync(sanitizeGridParams(deepClone(pic)));
    a.ok(asyncBake && asyncBake.sig === gridSignature(sanitizeGridParams(pic)), 'the sliced bake gives the same signature');
  });
  const plain = bakeGrid(tiny({ paint }), { ns: 'detached' }).mats.values().next().value.M;
  const offDoc = tiny({ paint, stack: stack().map((it) => ({ ...it, on: false })) });
  a.ok(same(bakeGrid(offDoc, { ns: 'detached' }).mats.values().next().value.M, plain), 'effects switched off = identity');
  const mix0 = tiny({ paint, stack: stack().map((it) => ({ ...it, mix: 0 })) });
  a.ok(same(bakeGrid(mix0, { ns: 'detached' }).mats.values().next().value.M, plain), 'mix 0 = identity');
  a.equal(gridSignature(offDoc), gridSignature(mix0), 'both have the signature of the bare picture');
  // mask: outside the selection nothing changes / 마스크 밖은 불변
  const shape = gridShape(doc.grid);
  const sel = { kind: 'rect', x0: 0, y0: 0, x1: shape.cols / 2, y1: shape.rows, feather: 0 };
  const masked = tiny({ paint, selection: sel, stack: [fxItem('blur', { mode: 'gaussian', sigmaCents: 80, shimmer: 0 }, { mask: 'selection' })] });
  const bm = bakeGrid(masked, { ns: 'detached' });
  const Mm = bm.mats.values().next().value.M;
  const { N, F } = bm.dims;
  let outside = 0;
  let inside = 0;
  for (let f = 0; f < F; f++) for (let i = 0; i < N; i++) { const d = Math.abs(Mm[f * N + i] - plain[f * N + i]); if (f > F * 0.56) outside = Math.max(outside, d); else if (f < F * 0.44) inside = Math.max(inside, d); }
  a.ok(outside === 0 && inside > 0.1, `masked blur: inside changed (${inside.toFixed(2)}), outside untouched (${outside})`);
  a.ok(gridSignature(masked) !== gridSignature(sanitizeGridParams({ ...masked, selection: { ...sel, x1: 3 } })), 'a selection used as a mask is part of the signature');
  const noMask = tiny({ paint, selection: sel, stack: [fxItem('blur', { mode: 'gaussian', sigmaCents: 80, shimmer: 0 })] });
  a.equal(gridSignature(noMask), gridSignature(sanitizeGridParams({ ...noMask, selection: null })), 'an unused selection is not');
  // determinism / 결정론
  const A = withIsolatedGridCache(() => Float32Array.from(bakeGrid(doc).mats.values().next().value.M));
  const B = withIsolatedGridCache(() => Float32Array.from(bakeGrid(sanitizeGridParams(deepClone(doc))).mats.values().next().value.M));
  a.ok(same(A, B), 'same signature → the same matrix, bit for bit');
  const other = sanitizeGridParams({ ...deepClone(doc), render: { ...doc.render, seed: 77 } });
  a.ok(!same(A, withIsolatedGridCache(() => Float32Array.from(bakeGrid(other).mats.values().next().value.M))), 'another seed → another result');
  // the plan: one voice per layer × chromatic channel / 보이스 = 레이어 × 크로매틱 채널
  const ch = tiny({ paint, stack: [fxItem('chroma', { link: false, rP: 2, rQ: 3, bP: 3, bQ: 2 })] });
  const pv = planVoices(ch, gridDims(ch));
  a.equal(pv.voices.length, 3, 'three channels → three voices on one matrix');
  a.ok(pv.voices.every((v) => v.layer === 0), 'all read the same layer matrix');
  for (const [k, r] of [[0, 2 / 3], [1, 1], [2, 3 / 2]]) a.ok(Math.abs(pv.voices[k].ratio / r - 1) < 1e-12, `ratio ${r.toFixed(4)} exact`);
  a.near(chromaRatio(sanitizeEffectParams('chroma', { link: false, bP: 3, bQ: 2, bCents: 5 }), 'b'), 1.5 * Math.pow(2, 5 / 1200), 1e-12, 'cents trim multiplies the ratio');
  const linked = sanitizeEffectParams('chroma', { link: true, bP: 5, bQ: 4, bPan: 0.6, bTimeMs: 12 });
  a.ok(linked.rP === 4 && linked.rQ === 5 && linked.rPan === -0.6 && linked.rTimeMs === -12, 'link: R mirrors B');
}, G);

registerSelfCheck('Grid: painting tools — brush, selection, flood fill, lasso', (a) => {
  const rows = 20;
  const cols = 30;
  const cov = new Float32Array(rows * cols);
  stampBrush(cov, rows, cols, 10.5, 8.5, 3, { hardness: 1, flow: 1 });
  a.ok(cov[8 * cols + 10] === 1 && cov[8 * cols + 20] === 0, 'a stamp covers its centre only');
  const base = new Float32Array(rows * cols).fill(0.2);
  const out = new Float32Array(rows * cols);
  compositeStroke(base, out, cov, 1, 0.5);
  a.near(out[8 * cols + 10], 0.6, 1e-6, 'opacity 0.5: half-way to the brush value');
  a.near(out[0], 0.2, 1e-6, 'untouched outside');
  const sel = rectCoverage(rows, cols, 0, 0, 5, rows);
  compositeStroke(base, out, cov, 1, 1, sel);
  a.near(out[8 * cols + 10], 0.2, 1e-6, 'a selection confines painting');
  const pic = new Float32Array(rows * cols);
  for (let r = 5; r < 10; r++) for (let c = 5; c < 12; c++) pic[r * cols + c] = 1;
  const flood = floodCoverage(pic, rows, cols, 6, 6, 0.1);
  let n = 0;
  for (let i = 0; i < flood.length; i++) n += flood[i];
  a.equal(n, 35, 'flood fill stays inside the block');
  const tri = polygonCoverage(rows, cols, [[2, 2], [12, 2], [2, 12]]);
  a.ok(tri[3 * cols + 3] === 1 && tri[11 * cols + 11] === 0, 'lasso: inside / outside');
}, G);

registerSelfCheck('Grid: bake to Glissando — ≤ 64 voices, ridge on the painted pitch, chromatic copies exactly 12·log2(ratio), state untouched', (a) => {
  const doc = tiny({ grid: { length: 3 }, paint: (ras, rows, cols, g) => { held(69)(ras, rows, cols, g); paintLine(ras, rows, cols, 2, rowOf(g, 61), cols - 2, rowOf(g, 66), 0.8); }, stack: [fxItem('chroma', { link: false, rP: 2, rQ: 3, bP: 3, bQ: 2 })] });
  const bake = bakeGrid(doc, { ns: 'detached' });
  const { lines } = gridBakeLines(doc, bake);
  a.equal(lines.length, 6, 'two ridges × three channels');
  const baseLine = lines.find((l) => l.kind === 'ridge' && Math.abs(linePitch(l, bake.dims, 5) - 69) < 1);
  a.ok(!!baseLine, 'the held A4 is a ridge');
  let worst = 0;
  for (let j = 0; j < baseLine.track.bin.length; j++) worst = Math.max(worst, Math.abs(baseLine.track.bin[j] - 9 * bake.dims.bps));
  a.ok(worst <= 1, `ridge pitch within ± 1 fine bin (${worst.toFixed(3)})`);
  const semis = lines.filter((l) => l.track === baseLine.track).map((l) => l.semis).sort((x, y) => x - y);
  a.ok(Math.abs(semis[0] - 12 * Math.log2(2 / 3)) < 1e-9 && semis[1] === 0 && Math.abs(semis[2] - 12 * Math.log2(3 / 2)) < 1e-9, `chromatic copies at exactly ${semis[0].toFixed(6)} / 0 / ${semis[2].toFixed(6)} st`);
  const helpers = { createDefaultVoice: (i, o) => ({ index: i, ...o }), startIndex: 0 };
  const glide = lines.find((l) => l.kind === 'ridge' && l.track !== baseLine.track);
  const v = lineToVoice(glide, bake.dims, helpers, 0);
  a.ok(v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.every((q, i, arr) => i === 0 || q.x > arr[i - 1].x), `adaptive spline (${v.customPoints.length} anchors, x strictly increasing)`);
  let err = 0;
  const n = glide.track.bin.length;
  for (let j = 0; j < n; j++) err = Math.max(err, Math.abs(voicePitchAt(v, j / (n - 1)) - linePitch(glide, bake.dims, j)));
  a.ok(err < 0.3, `voice curve follows the ridge (worst ${err.toFixed(3)} st)`);
  a.ok(v.gainPoints.every((q) => q.y >= 0 && q.y <= 1), 'gain points in [0, 1]');
  const fifth = lines.find((l) => l.track === baseLine.track && l.semis > 6);
  const vb = lineToVoice(baseLine, bake.dims, helpers, 0);
  const vf = lineToVoice(fifth, bake.dims, helpers, 1);
  a.near(voicePitchAt(vf, 0.5) - voicePitchAt(vb, 0.5), 12 * Math.log2(1.5), 0.03, 'baked fifth above (Hz are stored with 2 decimals)');
  withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    const params = JSON.stringify(appState.studioParams);
    const voices = StudioRegistry.generateVoices(GRID_ID, doc);
    a.ok(voices.length === 6 && voices.every((x) => x.engine === 'custom' && x.duration >= 0.05 && /^v_/.test(x.id)), `${voices.length} contract-conforming voices`);
    a.equal(JSON.stringify(appState.voices), before, 'voices untouched by generateVoices');
    a.equal(JSON.stringify(appState.studioParams), params, 'studio params untouched');
    const many = tiny({ grid: { pLo: 36, pHi: 96, length: 2 }, paint: (ras, rows, cols) => { for (let r = 0; r < rows; r += 2) paintLine(ras, rows, cols, 0, r + 0.5, cols, r + 0.5, 0.5 + (r % 7) / 14); }, stack: [fxItem('chroma', {})] });
    a.ok(gridBakeLines(many).total > MAX_GENERATED_VOICES, 'more lines than voices');
    a.equal(StudioRegistry.generateVoices(GRID_ID, many).length, MAX_GENERATED_VOICES, 'cut to 64, strongest first');
  });
  // a blurred line is a cluster: a few detuned voices / 번진 선 = 디튠 보이스 몇 개
  const cloud = tiny({ paint: held(66), stack: [fxItem('blur', { mode: 'gaussian', sigmaCents: 60, shimmer: 0 })] });
  const cl = gridBakeLines(cloud, bakeGrid(cloud, { ns: 'detached' })).lines;
  a.ok(cl.length === 3 && cl.filter((l) => l.kind === 'detune').length === 2, 'cluster → centre + two detuned companions');
  a.equal(gridBakeLoss(cloud).join(), 'pan,blur', 'loss list names what a Voice cannot carry');
  a.ok(gridBakeLoss(createGridPreset('everything')).includes('noise') && gridBakeLoss(createGridPreset('everything')).includes('glitch'), 'loss list of a busy document');
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
  a.ok(narrow.layout === 'stack' && narrow.editor.w === DUAL_NARROW_W - 1 && same2(st, DUAL_NARROW_W - 1), 'narrow container: stacked automatically, still identical');
  st = applyDualTotal(setDualLayout(st, 'stack'), 2 * 300 + DUAL_GAP, 900);
  a.ok(st.hE === 300 && st.hR === 300, 'the shared corner handle splits its height equally while locked');
  // unlock: only one window changes / 해제: 한쪽만 변경
  st = toggleDualLock(st);
  a.ok(!st.lock && st.hE === 300 && st.hR === 300, 'unlocking changes no size');
  st = resizePane(st, 'result', 180);
  a.ok(st.hE === 300 && st.hR === 180 && !same2(st, 900), 'unlocked: only the Result changed');
  st = resizePane(st, 'editor', 520);
  a.ok(st.hE === 520 && st.hR === 180 && st.last === 'editor', 'unlocked: only the Editor changed');
  const restored = parseDual(serializeDual(st));
  a.equal(serializeDual(restored), serializeDual(st), 'lock state and both sizes are stored and restored');
  // re-lock: both take the size of the window adjusted last, at once / 재잠금: 마지막 조정 윈도우 기준 즉시 동기화
  st = toggleDualLock(st);
  a.ok(st.lock && st.hE === 520 && st.hR === 520 && same2(st, 900), 're-lock → both = the Editor (adjusted last)');
  st = resizePane(toggleDualLock(st), 'result', 240);
  st = toggleDualLock(st);
  a.ok(st.hE === 240 && st.hR === 240, 're-lock → both = the Result when it was adjusted last');
  a.ok(parseDual(serializeDual(st)).lock && parseDual('not json').lock, 'stored lock survives; broken storage → default');
  a.equal(normalizeDual({ lock: true, hE: 200, hR: 400, last: 'result' }).hE, 400, 'a locked state is always equal');
  a.equal(normalizeDual({ hE: 5 }).hE, 120, 'sizes are clamped');
  // one view: the same (time, pitch) ↔ pixel on both windows / 같은 (시간, 음고) ↔ 픽셀
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

registerSelfCheck('Grid: document — edits are undoable, view / tool edits are not, Manager documents resolve apart', (a) => {
  withIsolatedState(() => {
    appState.studioParams = { ...(appState.studioParams || {}) };
    delete appState.studioParams[GRID_ID];
    const p0 = getGridParams();
    a.ok(getGridParams() === p0, 'memoised: the same params object for the same stored document');
    editGrid((d) => { d.layers[0].gain = 0.5; });
    a.equal(getGridParams().layers[0].gain, 0.5, 'edit applied');
    a.equal(appState.studioParams[GRID_ID].layers[0].gain, 0.5, 'stored in appState.studioParams.grid');
    const sig = gridSignature(getGridParams());
    editGrid((d) => { d.view.tMin = 2; d.tool.size = 9; }, { history: false });
    a.equal(gridSignature(getGridParams()), sig, 'a view / tool edit keeps the signature');
    a.equal(getGridParams().view.tMin, 2, 'view stored');
  });
  const docA = { ...createGridPreset('chorusCloud'), grid: { pLo: 60, pHi: 72, rowsPerSemi: 2, colsPerSec: 8, length: 2 } };
  const pA = resolveGridDoc(docA);
  a.ok(resolveGridDoc(docA) === pA && resolveGridDoc(pA) === pA, 'memoised per stored document, idempotent on full params');
  a.ok(resolveGridDoc(null) === resolveGridDoc(undefined) && resolveGridDoc(null).grid.length === 16, 'null = studio defaults');
  a.equal(pA.grid.length, 2, 'stored fields win over defaults');
  const lines = gridMasterLines(tiny({ paint: held(64) }));
  a.ok(lines.length === 1 && lines[0].pts.length >= 2 && lines[0].pts.every((q) => Math.abs(q.m - 64) < 0.2 && q.t >= 0 && q.t <= 2.01), 'Master View line follows the painted pitch');
}, G);

registerSelfCheck('Grid: Manager — listed, two instances keep separate documents through focus swaps', (a) => {
  a.ok(MANAGER_STUDIOS.includes(GRID_ID), 'Grid can be added in the Manager');
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    appState.studioParams = { ...(appState.studioParams || {}), [GRID_ID]: createGridPreset('chorusCloud') };
    const g1 = addInstance(GRID_ID); // the first instance takes over the editor document / 첫 인스턴스 = 에디터 문서
    focusInstance(g1.id);
    a.equal(getGridParams().preset, 'chorusCloud', 'first instance shows the editor document');
    const g2 = addInstance(GRID_ID);
    a.ok(focusInstance(g2.id), 'focus moved to the second instance');
    a.equal(getGridParams().preset, 'pureLines', 'second instance starts from the defaults');
    a.equal(resolveGridDoc(getInstance(g1.id).doc).preset, 'chorusCloud', 'first document stored in its instance');
    editGrid((d) => { d.layers[0].gain = 0.3; });
    focusInstance(g1.id);
    a.equal(getGridParams().preset, 'chorusCloud', 'first document restored');
    a.equal(resolveGridDoc(getInstance(g2.id).doc).layers[0].gain, 0.3, 'second document kept its edit');
  });
}, G);
