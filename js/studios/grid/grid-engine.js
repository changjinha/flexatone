/**
 * Flexatone — studios/grid/grid-engine.js
 * Grid Studio — the STUDIO ENGINE (pure: no DOM, no audio). The studio does not make lines: it takes
 * the lines of another studio (or its own demo lines) and deforms the COORDINATE SPACE they lie in.
 * The lines themselves are never edited — every point (t, pitch) is carried to where the warped space
 * puts it.
 * 그리드 스튜디오의 스튜디오 엔진 (순수). 선을 만들지 않고, 다른 스튜디오의 선(또는 자체 데모 선)이 놓인
 * 좌표 공간 자체를 변형. 선은 편집하지 않으며, 각 점 (t, 음고)이 변형된 공간이 가리키는 곳으로 옮겨짐.
 *
 *   source lines [{ key, name, color, pts: [{ t, m }] }]      (read-only)
 *     → space stack (modules/space-warp.js, the same maps the Draw Studio applies to single strokes)
 *     → runs [{ line, ch, pts: [{ t, m, g, pan, w = source time }] }]   each strictly forward in time
 * Baked at edit time and cached by signature (lines + stack + range + seed); playback only reads runs.
 * Imports: core/*, modules/*.
 */

import { clamp } from '../../core/math-utils.js';
import { TIMBRE_WAVES } from '../../core/state.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { timbreSpecExtras } from '../../modules/timbre-spec.js';
import { sanitizeWarpStack, createWarpStage, warpPolyline, stackVariants, stackStep, isIdentityStack, sanitizeRegion, LIQUIFY_TOOLS, BRUSH_AXES, PULL_MODES } from '../../modules/space-warp.js';

export const GRID_PRESET_IDS = Object.freeze(['flat', 'lens', 'ripple', 'twirl', 'stairs', 'stutter', 'dotted', 'fifths', 'rough', 'everything']);
export const GRID_OWN = 'own';
export const GRID_MAX_RUNS = 600;
/** One cell = 125 ms × 0.5 semitone: the unit in which brushes are round. / 셀 = 125 ms × 0.5 반음 (브러시가 원형인 단위) */
export const GRID_CELL = Object.freeze({ ut: 0.125, um: 0.5 });
/** Tools of the Editor monitor: the brush, four selections (pitch band = whole time range, time band =
 * whole pitch range, free box, lasso) and Pull. / Editor 모니터의 도구: 브러시, 선택 4종, 당기기 */
export const GRID_TOOLS = Object.freeze(['brush', 'selPitch', 'selTime', 'selBox', 'selLasso', 'pull']);
export const GRID_SEL_KINDS = Object.freeze(['selPitch', 'selTime', 'selBox', 'selLasso']);

const fin = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

export function hashString(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13)) | 0;
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length.toString(36)}`;
}

/** Demo lines of the studio itself: three held notes and one glide. / 자체 데모 선 */
export function demoLines() {
  const mk = (key, name, color, a, b) => ({ key, name, color, pts: Array.from({ length: 33 }, (_, i) => ({ t: a[0] + ((b[0] - a[0]) * i) / 32, m: a[1] + ((b[1] - a[1]) * i) / 32 })) });
  return [
    mk('d1', 'C3', '#38bdf8', [0.5, 48], [7, 48]),
    mk('d2', 'G3', '#34d399', [3, 55], [11, 55]),
    mk('d3', 'Glide', '#f472b6', [6, 64], [12, 72]),
    mk('d4', 'A4', '#fbbf24', [10, 69], [15.5, 69]),
  ];
}

const DEFAULT_TIMBRE = Object.freeze({ sine: 0.75, tri: 0.2, saw: 0.1, sqr: 0, rich: 0.15 });
function sanitizeTimbre(raw) {
  const out = {};
  for (const k of TIMBRE_WAVES) out[k] = clamp(fin(raw?.[k], DEFAULT_TIMBRE[k] ?? 0), 0, 1);
  const x = timbreSpecExtras(raw);
  return { ...out, mode: x.mode === 'func' ? 'func' : 'mix', func: x.func, ...(x.adsr ? { adsr: x.adsr } : {}) };
}

/** View that shows a range. / 범위 전체가 보이는 뷰 */
export function fitGridView(r) {
  const span = Math.max(1, r.t1 - r.t0);
  return { tMin: Number((r.t0 - 0.03 * span).toFixed(3)), tMax: Number((r.t1 + 0.03 * span).toFixed(3)), midiMin: r.m0 - 3, midiMax: r.m1 + 3 };
}

export function createDefaultGridParams() {
  return sanitizeGridParams({ preset: 'flat' });
}

/** Normalise any stored document into full, safe params (idempotent). / 문서 정규화 (멱등) */
export function sanitizeGridParams(raw) {
  const r = raw?.range || {};
  const pLo = Math.round(clamp(fin(r.pLo, 36), 0, 120));
  const range = { auto: r.auto !== false, pLo, pHi: Math.round(clamp(fin(r.pHi, 84), pLo + 6, 132)), length: clamp(fin(r.length, 16), 1, 600) };
  const v = raw?.view || {};
  const fit = fitGridView({ t0: 0, t1: range.length, m0: range.pLo, m1: range.pHi });
  const tMin = fin(v.tMin, fit.tMin);
  const midiMin = fin(v.midiMin, fit.midiMin);
  const tl = raw?.tool || {};
  const out = {
    preset: typeof raw?.preset === 'string' ? raw.preset : '',
    source: { studio: typeof raw?.source?.studio === 'string' && raw.source.studio ? raw.source.studio : 'glissando' },
    space: sanitizeWarpStack(raw?.space),
    range,
    sound: oneOf(raw?.sound, ['source', 'grid'], 'source'), // 'source' = a Glissando voice keeps its own timbre and envelope / 원본 음색·포락선 유지
    timbre: sanitizeTimbre(raw?.timbre),
    gain: clamp(fin(raw?.gain, 0.8), 0, 2),
    seed: Math.round(clamp(fin(raw?.seed, 1), 0, 999999)),
    view: {
      tMin, tMax: Math.max(tMin + 0.25, fin(v.tMax, fit.tMax)), midiMin, midiMax: Math.max(midiMin + 3, fin(v.midiMax, fit.midiMax)),
      showGrid: v.showGrid !== false, showGhost: v.showGhost !== false, showStrokes: v.showStrokes !== false,
    },
    tool: {
      mode: oneOf(tl.mode, GRID_TOOLS, 'brush'),
      liq: oneOf(tl.liq, LIQUIFY_TOOLS, 'push'), size: clamp(fin(tl.size, 10), 1, 120), strength: clamp(fin(tl.strength, 0.6), 0.01, 1),
      // brush details (defaults = the round brush of 0.44) / 브러시 상세값 (기본값 = 0.44의 둥근 브러시)
      hardness: clamp(fin(tl.hardness, 0), 0, 0.95), aspect: clamp(fin(tl.aspect, 1), 0.1, 10), angle: clamp(fin(tl.angle, 0), -90, 90),
      axis: oneOf(tl.axis, BRUSH_AXES, 'both'), smooth: clamp(fin(tl.smooth, 0), 0, 0.95), clip: tl.clip !== false,
      // selection (cells, original space) + Pull / 선택 영역 (셀, 원래 공간) + 당기기
      sel: sanitizeSelection(tl.sel), feather: clamp(fin(tl.feather, 4), 0, 200), pullMode: oneOf(tl.pullMode, PULL_MODES, 'move'),
      shot: oneOf(tl.shot, ['result', 'editor', 'both'], 'result'),
    },
    tremolo: normalizeTremolo(raw?.tremolo),
  };
  if (raw?.voiceMod) out.voiceMod = JSON.parse(JSON.stringify(raw.voiceMod));
  return out;
}

/** A stored selection { kind, poly } (cells) or null. / 저장된 선택 영역 */
export function sanitizeSelection(raw) {
  if (!raw || !GRID_SEL_KINDS.includes(raw.kind)) return null;
  const r = sanitizeRegion({ poly: raw.poly, feather: 0 });
  return r ? { kind: raw.kind, poly: r.poly } : null;
}

/** Domain of the space for a set of lines: the manual range, or the lines' extent rounded outwards. / 공간의 영역 */
export function gridDomain(doc, lines) {
  let t1 = 0;
  let m0 = Infinity;
  let m1 = -Infinity;
  for (const l of lines) for (const q of l.pts) { if (!Number.isFinite(q.m)) continue; if (q.t > t1) t1 = q.t; if (q.m < m0) m0 = q.m; if (q.m > m1) m1 = q.m; }
  if (!doc.range.auto || !Number.isFinite(m0)) return { t0: 0, t1: doc.range.length, m0: doc.range.pLo, m1: doc.range.pHi };
  return { t0: 0, t1: Math.max(1, Math.ceil(t1 * 2) / 2), m0: Math.floor((m0 - 2) / 12) * 12, m1: Math.ceil((m1 + 2) / 12) * 12 };
}

export const gridEnv = (doc, dom) => ({ seed: doc.seed, ut: GRID_CELL.ut, um: GRID_CELL.um, ...dom });

/** Signature of a set of lines (pitch points only). / 선 집합의 시그니처 */
export function linesSignature(lines) {
  let s = '';
  for (const l of lines) { s += `|${l.key}:`; for (const q of l.pts) s += `${Math.round(q.t * 1000)},${Number.isFinite(q.m) ? Math.round(q.m * 1000) : 'x'};`; }
  return hashString(s);
}

let bakeCount = 0;
const cache = new Map(); // namespace → last result
export const getGridBakeCount = () => bakeCount;

/**
 * Carry the lines through the warped space. Memoised by signature per namespace ('edit' counts).
 * 선을 변형된 공간으로 옮김. 네임스페이스별로 시그니처 메모이즈 ('edit'만 횟수 집계).
 * @returns {{ sig, env, dom, runs: Array<{ line, key, name, color, ch, variant, pts }>, endSec, cut, ms }}
 */
export function bakeGrid(doc, lines, { ns = 'edit' } = {}) {
  const dom = gridDomain(doc, lines);
  const sig = hashString(`${linesSignature(lines)}|${doc.seed}|${JSON.stringify(dom)}|${JSON.stringify(doc.space)}`);
  const hit = cache.get(ns);
  if (hit && hit.sig === sig) return hit;
  const t0 = (globalThis.performance || Date).now();
  const env = gridEnv(doc, dom);
  const step = stackStep(doc.space);
  let runs = [];
  lines.forEach((l, li) => {
    // w carries the source time, so a sound that belongs to the line (a voice envelope) can follow it
    // w에 원본 시각을 실어 보냄 → 선에 속한 소리(보이스 포락선)가 따라올 수 있음
    const src = l.pts.map((q) => ({ t: q.t, m: q.m, w: q.t }));
    for (const r of warpPolyline(src, doc.space, env, { step })) {
      const pts = r.pts.filter((q) => q.t >= 0);
      if (pts.length >= 2) runs.push({ line: li, key: l.key, name: l.name, color: l.color || null, ch: r.ch, variant: r.variant, pts });
    }
  });
  let cut = 0;
  if (runs.length > GRID_MAX_RUNS) {
    const weight = (r) => (r.pts[r.pts.length - 1].t - r.pts[0].t) * (r.pts.reduce((s, q) => s + q.g, 0) / r.pts.length);
    cut = runs.length - GRID_MAX_RUNS;
    runs = runs.map((r) => ({ r, w: weight(r) })).sort((a, b) => b.w - a.w).slice(0, GRID_MAX_RUNS).map((x) => x.r);
  }
  let endSec = 0;
  for (const r of runs) endSec = Math.max(endSec, r.pts[r.pts.length - 1].t);
  const res = { sig, env, dom, runs, endSec, cut, identity: isIdentityStack(doc.space), ms: (globalThis.performance || Date).now() - t0 };
  cache.set(ns, res);
  if (ns === 'edit') bakeCount++;
  return res;
}

/** Run fn with an empty cache and counter, then restore them (self-checks). / 캐시를 비운 상태로 실행 후 복원 */
export function withIsolatedGridCache(fn) {
  const saved = new Map(cache);
  const c = bakeCount;
  cache.clear();
  try { return fn(); } finally { cache.clear(); for (const [k, v] of saved) cache.set(k, v); bakeCount = c; }
}

/** Pitch / gain / pan / source time of a run at absolute time (linear between its points). / 조각의 값 */
export function runAt(run, t) {
  const pts = run.pts;
  let lo = 0;
  let hi = pts.length - 1;
  if (t <= pts[0].t) return pts[0];
  if (t >= pts[hi].t) return pts[hi];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
  const a = pts[lo];
  const b = pts[hi];
  const u = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return { t, m: a.m + (b.m - a.m) * u, g: a.g + (b.g - a.g) * u, pan: a.pan + (b.pan - a.pan) * u, w: a.w + (b.w - a.w) * u };
}

/**
 * The deformed coordinate grid for display: images of the lines t = const and pitch = const of the
 * domain, each a list of polylines (broken where the map breaks). / 화면용 변형 격자
 */
export function warpedGridLines(doc, dom, { tStep = 1, mStep = 12, samples = 64 } = {}) {
  const env = gridEnv(doc, dom);
  const pre = stackVariants(doc.space, env);
  const combo = pre.combos[0] || [];
  const one = (t, m) => {
    const q = { t, m, g: 1, pan: 0, tag: 0, ot: t, om: m, og: 1, vp: true };
    for (let s = 0; s < pre.plans.length; s++) {
      const { it, fns } = pre.plans[s];
      if (it.type === 'halftone' || it.type === 'chroma') continue; // gain and copies do not bend the grid / 게인·복제는 격자를 휘지 않음
      const t0 = q.t;
      const m0 = q.m;
      fns[combo[s]](q);
      if (it.mix < 1) { q.t = t0 + (q.t - t0) * it.mix; q.m = m0 + (q.m - m0) * it.mix; }
    }
    return q;
  };
  const trace = (at) => {
    const out = [];
    let cur = [];
    let tag = null;
    for (let k = 0; k <= samples; k++) {
      const q = at(k / samples);
      if (tag !== null && q.tag !== tag) { if (cur.length > 1) out.push(cur); cur = []; }
      tag = q.tag;
      cur.push({ t: q.t, m: q.m });
    }
    if (cur.length > 1) out.push(cur);
    return out;
  };
  const time = [];
  const pitch = [];
  for (let t = Math.ceil(dom.t0 / tStep) * tStep; t <= dom.t1 + 1e-9; t += tStep) time.push({ v: t, paths: trace((u) => one(t, dom.m0 + (dom.m1 - dom.m0) * u)) });
  for (let m = Math.ceil(dom.m0 / mStep) * mStep; m <= dom.m1 + 1e-9; m += mStep) pitch.push({ v: m, paths: trace((u) => one(dom.t0 + (dom.t1 - dom.t0) * u, m)) });
  return { time, pitch };
}

/** Presets: a space each (the source is kept). / 프리셋: 공간만 바꿈 (소스는 그대로) */
export function gridPresetSpace(id) {
  const st = (type, params = {}, over = {}) => createWarpStage(type, { params, ...over });
  return {
    flat: [],
    lens: [st('lens', { cx: 0.5, cy: 0.5, radius: 40, strength: 0.7, lockTime: true })],
    ripple: [st('wave', { ampSemi: 1.2, periodSec: 1.5, ampMs: 0 })],
    twirl: [st('twirl', { cx: 0.5, cy: 0.5, radius: 48, angle: 50 })],
    stairs: [st('quantize', { stepSemi: 2, strength: 1 })],
    stutter: [st('glitch', { rate: 5, durMin: 40, durMax: 110, rangeSemi: 7 })],
    dotted: [st('halftone', { periodMs: 160, duty: 0.45, jitter: 0.6, silenceJitter: 0.6, bandSemi: 6 })],
    fifths: [st('chroma', {})],
    rough: [st('turbulence', { ampSemi: 0.8, scaleSec: 0.6, scaleSemi: 9 })],
    everything: [st('lens', { strength: 0.4, radius: 40 }), st('wave', { ampSemi: 0.5, periodSec: 2 }), st('glitch', { rate: 1.5 }), st('halftone', { duty: 0.7, jitter: 0.3 }, { mix: 0.6 }), st('chroma', { rGain: 0.4, bGain: 0.4 })],
  }[id] || null;
}
