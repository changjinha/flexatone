/**
 * Flexatone — modules/space-warp.js
 * Layer 1 (modules, pure): warps of the time × pitch plane. One set of maps, two uses:
 *   Draw Studio  — an OBJECT effect: the points of a stroke are moved, the axes stay as they are.
 *   Grid Studio  — a SPACE effect: the coordinate grid itself is deformed and every line that lies
 *                  in it is carried along (the lines themselves are not edited).
 * 계층 1 (modules, 순수): 시간 × 음고 평면의 변형. 같은 사상을 두 가지로 사용 —
 *   드로잉 스튜디오 = 객체 효과 (획의 점만 옮기고 축은 그대로), 그리드 스튜디오 = 공간 효과 (좌표 격자 자체를 변형).
 *
 * A point is { t (s), m (MIDI), g (gain 0..1), pan (−1..1), tag }. A warp stage is
 *   { id, type, on, mix, params }  and its definition (SpaceWarpRegistry) provides
 *   map(q, p, env)          moves q in place (may change g; sets q.tag where the map is discontinuous)
 *   variants?(p, env)       several images of the plane (Chromatic copies, Mirror "both"): [(q) => void]
 *   step?(p)                largest sampling step in seconds the stage needs (short gates, grains)
 * env = { seed, ut, um, t0, t1, m0, m1 }: ut / um = seconds / semitones per "cell" (the unit in which
 * brushes are round), [t0, t1] × [m0, m1] = the domain normalised parameters (centres) refer to —
 * a stroke's bounding box in Draw, the grid's range in Grid.
 * Determinism: every random number comes from a seeded hash. Imports core/* only. No DOM, no audio.
 */

import { clamp, createSeededRandom } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';

const PARAM_TYPES = ['range', 'int', 'select', 'toggle'];

/** Problems of a warp definition (empty = valid). / 변형 정의 검증 */
export function validateSpaceWarp(w) {
  const errs = [];
  if (!w || typeof w !== 'object') return ['warp must be an object'];
  if (typeof w.id !== 'string' || !/^[a-z][a-zA-Z0-9]{1,23}$/.test(w.id)) errs.push('id must be a short camelCase slug');
  if (!w.name || typeof w.name.en !== 'string' || typeof w.name.ko !== 'string') errs.push('name must provide { en, ko }');
  if (!Array.isArray(w.params)) errs.push('params must be an array');
  if (typeof w.defaults !== 'function') errs.push('defaults must be a function');
  if (typeof w.map !== 'function' && typeof w.variants !== 'function') errs.push('map(q, p, env) or variants(p, env) is required');
  if (errs.length) return errs;
  const d = w.defaults();
  for (const q of w.params) {
    if (!q || typeof q.key !== 'string' || !PARAM_TYPES.includes(q.type)) { errs.push(`bad param ${q?.key}`); continue; }
    if (!(q.key in d)) errs.push(`defaults() misses "${q.key}"`);
    if (q.type === 'select' && (!Array.isArray(q.options) || !q.options.includes(d[q.key]))) errs.push(`param ${q.key}: options / default`);
  }
  return errs;
}

const defs = new Map();
/** Registry of the warps (a new warp = one object). / 변형 레지스트리 (새 변형 = 객체 하나) */
export const SpaceWarpRegistry = Object.freeze({
  register(w) {
    const errs = validateSpaceWarp(w);
    if (errs.length) throw new TypeError(`SpaceWarpRegistry: invalid warp "${w?.id}": ${errs.join('; ')}`);
    if (defs.has(w.id)) throw new Error(`SpaceWarpRegistry: "${w.id}" already registered`);
    defs.set(w.id, Object.freeze({ ...w }));
    return defs.get(w.id);
  },
  has: (id) => defs.has(id),
  get: (id) => defs.get(id) || null,
  list: () => [...defs.values()],
  ids: () => [...defs.keys()],
});

/** Parameters of a warp: defaults overlaid with `raw`, clamped to the schema. / 스키마에 맞춘 파라미터 */
export function sanitizeWarpParams(type, raw) {
  const w = defs.get(type);
  if (!w) return {};
  const out = w.defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const q of w.params) {
    const v = src[q.key];
    if (v === undefined) continue;
    if (q.type === 'toggle') out[q.key] = !!v;
    else if (q.type === 'select') { if (q.options.includes(v)) out[q.key] = v; }
    else if (Number.isFinite(Number(v))) out[q.key] = q.type === 'int' ? Math.round(clamp(Number(v), q.min, q.max)) : clamp(Number(v), q.min, q.max);
  }
  return w.sanitize ? w.sanitize(out, src) : out;
}

export const WARP_MAX_STACK = 10;

/** A stage with defaults. / 기본값을 채운 단계 */
export function createWarpStage(type, over = {}) {
  if (!defs.has(type)) throw new RangeError(`createWarpStage: unknown warp "${type}"`);
  return { id: over.id || '', type, on: over.on ?? true, mix: over.mix ?? 1, params: sanitizeWarpParams(type, over.params) };
}

/** Normalise a stored stack (unknown types dropped, unique ids). / 스택 정규화 */
export function sanitizeWarpStack(raw) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!defs.has(it?.type) || out.length >= WARP_MAX_STACK) continue;
    let id = typeof it.id === 'string' && it.id ? it.id : `w-${it.type}`;
    for (let n = 2; seen.has(id); n++) id = `w-${it.type}-${n}`;
    seen.add(id);
    const mix = Number.isFinite(Number(it.mix)) ? clamp(Number(it.mix), 0, 1) : 1;
    out.push({ id, type: it.type, on: it.on !== false, mix, params: sanitizeWarpParams(it.type, it.params) });
  }
  return out;
}

/** True when the stack changes nothing. / 아무것도 바꾸지 않는 스택 */
export const isIdentityStack = (stack) => !(stack || []).some((it) => it.on && it.mix > 0);

/** u ∈ [0, 1) for three integers. / 정수 셋 → [0, 1) */
export function hash3(a, b, c) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 1, 0x85ebca77) ^ Math.imul((c | 0) + 1, 0xc2b2ae3d)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const SALT = { glitch: 23, halftone: 37, turbulence: 59 };
const lerp = (a, b, u) => a + (b - a) * u;
const smooth01 = (u) => u * u * (3 - 2 * u);

// --------------------------------------------------------------------------
// Liquify — stored brush strokes → a displacement field / 리퀴파이: 저장된 브러시 스트로크 → 변위장
// --------------------------------------------------------------------------

export const LIQUIFY_TOOLS = Object.freeze(['push', 'twirlCW', 'twirlCCW', 'pinch', 'bloat', 'reconstruct']);
export const LIQUIFY_MAX_OPS = 64;
const LIQ_MAX_PTS = 64;
const prepCache = new WeakMap();

/** Brush samples of the stored strokes, resampled so the result does not depend on the pointer rate. */
function liquifySamples(ops) {
  let hit = prepCache.get(ops);
  if (hit) return hit;
  hit = [];
  for (const op of ops || []) {
    const R = Math.max(0.5, op.size);
    const k = clamp(op.strength, 0, 1);
    const pts = op.pts || [];
    if (!pts.length || !(k > 0)) continue;
    // ellipse of the brush: aspect = width (time) / height (pitch), turned by angle / 브러시 타원
    const asp = Math.sqrt(clamp(op.aspect ?? 1, 0.1, 10));
    const rx = R * asp;
    const ry = R / asp;
    const th = ((op.angle || 0) * Math.PI) / 180;
    const base = { tool: op.tool, rx, ry, ca: Math.cos(th), sa: Math.sin(th), h: clamp(op.hardness || 0, 0, 0.95), ax: op.axis || 'both', k, mask: op.mask || null, reach: Math.max(rx, ry) };
    const path = [pts[0]];
    const step = Math.max(0.25, Math.min(rx, ry) / 4);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = path[path.length - 1];
      const [bx, by] = pts[i];
      const n = Math.max(1, Math.min(24, Math.ceil(Math.hypot(bx - ax, by - ay) / step)));
      for (let q = 1; q <= n; q++) path.push([ax + ((bx - ax) * q) / n, ay + ((by - ay) * q) / n]);
    }
    for (let i = op.tool === 'push' ? 1 : 0; i < path.length; i++) {
      hit.push({ ...base, x: path[i][0], y: path[i][1], dx: i ? path[i][0] - path[i - 1][0] : 0, dy: i ? path[i][1] - path[i - 1][1] : 0 });
    }
  }
  prepCache.set(ops, hit);
  return hit;
}

/** Brush fall-off at normalised distance² d2 (< 1) with a hard core h: 1 inside h, (1 − s²)² outside. / 브러시 감쇠 */
export function brushFalloff(d2, h = 0) {
  if (!(h > 0)) return (1 - d2) * (1 - d2);
  const d = Math.sqrt(d2);
  if (d <= h) return 1;
  const s = (d - h) / (1 - h);
  return (1 - s * s) * (1 - s * s);
}

/**
 * Displacement (cells) of the liquify strokes at cell position (x, y): the strokes are replayed in
 * order. Push adds the brush movement, twirl / pinch / bloat act around the brush centre,
 * reconstruct scales what is there back towards zero. Fall-off (1 − (d / R)²)² (a hard core keeps
 * full strength inside it); the brush may be an ellipse (aspect, angle), act on one axis only, and
 * be confined to a region (mask).
 * 리퀴파이 스트로크의 변위 (셀 단위): 스트로크를 순서대로 재생. 감쇠 (1 − (d/R)²)² (단단함 = 중심부 100 %),
 * 타원 브러시(비율·각도), 한 축만 (시간/음고), 영역 안에서만 (마스크).
 */
export function liquifyDisplacement(ops, x, y) {
  let dx = 0;
  let dy = 0;
  const list = liquifySamples(ops);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const ex = x - s.x;
    const ey = y - s.y;
    if (Math.abs(ex) >= s.reach || Math.abs(ey) >= s.reach) continue;
    const u = (ex * s.ca + ey * s.sa) / s.rx;
    const v = (ey * s.ca - ex * s.sa) / s.ry;
    const d2 = u * u + v * v;
    if (d2 >= 1) continue;
    let f = brushFalloff(d2, s.h) * s.k;
    if (s.mask) { f *= regionWeight(s.mask, x, y); if (!(f > 0)) continue; }
    let ddx = 0;
    let ddy = 0;
    if (s.tool === 'push') { ddx = f * s.dx; ddy = f * s.dy; }
    else if (s.tool === 'twirlCW' || s.tool === 'twirlCCW') { const th = (s.tool === 'twirlCW' ? -0.12 : 0.12) * f; ddx = -ey * th; ddy = ex * th; }
    else if (s.tool === 'pinch' || s.tool === 'bloat') { const g = (s.tool === 'pinch' ? -0.1 : 0.1) * f; ddx = ex * g; ddy = ey * g; }
    else if (s.tool === 'reconstruct') { if (s.ax !== 'pitch') dx *= 1 - f; if (s.ax !== 'time') dy *= 1 - f; continue; }
    if (s.ax !== 'pitch') dx += ddx;
    if (s.ax !== 'time') dy += ddy;
  }
  return { dx, dy };
}

export const BRUSH_AXES = Object.freeze(['both', 'time', 'pitch']);

/** Brush details of a stored stroke; defaults are left out so older strokes stay byte-identical. / 브러시 상세값 */
export function sanitizeBrushDetail(o) {
  const fin = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = {};
  const h = clamp(fin(o?.hardness, 0), 0, 0.95);
  const a = clamp(fin(o?.aspect, 1), 0.1, 10);
  const ang = clamp(fin(o?.angle, 0), -90, 90);
  if (h > 0) out.hardness = Number(h.toFixed(3));
  if (Math.abs(a - 1) > 1e-6) out.aspect = Number(a.toFixed(3));
  if (ang !== 0) out.angle = Number(ang.toFixed(1));
  if (BRUSH_AXES.includes(o?.axis) && o.axis !== 'both') out.axis = o.axis;
  const mask = sanitizeRegion(o?.mask);
  if (mask) out.mask = mask;
  return out;
}

function sanitizeLiquifyOps(raw) {
  if (!Array.isArray(raw)) return [];
  const fin = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return raw.slice(-LIQUIFY_MAX_OPS).map((o) => ({
    tool: LIQUIFY_TOOLS.includes(o?.tool) ? o.tool : 'push',
    size: clamp(fin(o?.size, 6), 0.5, 5000),
    strength: clamp(fin(o?.strength, 0.6), 0, 1),
    ...sanitizeBrushDetail(o),
    pts: (Array.isArray(o?.pts) ? o.pts : []).slice(0, LIQ_MAX_PTS).map((q) => [Number(fin(q?.[0], 0).toFixed(2)), Number(fin(q?.[1], 0).toFixed(2))]),
  })).filter((o) => o.pts.length);
}

// --------------------------------------------------------------------------
// Regions — a closed polygon in cells with a soft edge / 영역: 셀 단위 닫힌 다각형 + 부드러운 가장자리
// --------------------------------------------------------------------------

export const REGION_MAX_PTS = 160;
/** "Whole range" sides of a band selection (cells). / 띠 선택의 "전체 범위" 변 (셀) */
export const REGION_FAR = 1e6;
const regionCache = new WeakMap();

/** A stored region { poly: [[x, y], …] (≥ 3 points, cells), feather (cells) } or null. / 영역 정규화 */
export function sanitizeRegion(raw) {
  if (!raw || !Array.isArray(raw.poly)) return null;
  const fin = (v) => (Number.isFinite(Number(v)) ? clamp(Number(v), -1e7, 1e7) : null);
  const poly = [];
  for (const q of raw.poly.slice(0, REGION_MAX_PTS)) {
    const x = fin(q?.[0]);
    const y = fin(q?.[1]);
    if (x !== null && y !== null) poly.push([Number(x.toFixed(2)), Number(y.toFixed(2))]);
  }
  if (poly.length < 3) return null;
  const f = Number(raw.feather);
  return { poly, feather: Number.isFinite(f) ? Number(clamp(f, 0, 500).toFixed(2)) : 0 };
}

function regionPrep(r) {
  let p = regionCache.get(r);
  if (p) return p;
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const [x, y] of r.poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  p = { x0, x1, y0, y1, f: r.feather || 0 };
  regionCache.set(r, p);
  return p;
}

/** Signed distance (cells) from (x, y) to the region outline: < 0 inside. / 영역 윤곽까지의 부호 거리 (안 = 음수) */
export function regionDistance(r, x, y) {
  const poly = r.poly;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    const ex = xj - xi;
    const ey = yj - yi;
    const l2 = ex * ex + ey * ey;
    const u = l2 > 0 ? clamp(((x - xi) * ex + (y - yi) * ey) / l2, 0, 1) : 0;
    const d2 = (x - xi - u * ex) ** 2 + (y - yi - u * ey) ** 2;
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return inside ? -d : d;
}

/** Weight 0..1 of a region at (x, y): 1 inside, smooth fall-off over `feather` cells outside. / 영역 가중치 */
export function regionWeight(r, x, y) {
  if (!r) return 1;
  const p = regionPrep(r);
  if (x < p.x0 - p.f || x > p.x1 + p.f || y < p.y0 - p.f || y > p.y1 + p.f) return 0;
  const d = regionDistance(r, x, y);
  if (d <= 0) return 1;
  if (!(p.f > 0) || d >= p.f) return 0;
  return smooth01(1 - d / p.f);
}

/** Point of an image in the ORIGINAL space (before the stack): runPoint stores it on q. / 원래 공간의 위치 */
const origin = (q) => [(q.ot ?? q.t), (q.om ?? q.m)];

SpaceWarpRegistry.register({
  id: 'liquify',
  name: { en: 'Liquify', ko: '리퀴파이' },
  params: [{ key: 'amount', type: 'range', min: 0, max: 1, step: 0.01 }, { key: 'lockTime', type: 'toggle' }],
  defaults: () => ({ amount: 1, lockTime: false, ops: [] }),
  sanitize: (out, src) => ({ ...out, ops: sanitizeLiquifyOps(src.ops) }),
  map(q, p, env) {
    if (!p.ops.length || !(p.amount > 0)) return;
    const d = liquifyDisplacement(p.ops, q.t / env.ut, q.m / env.um);
    if (!p.lockTime) q.t += p.amount * d.dx * env.ut;
    q.m += p.amount * d.dy * env.um;
  },
});

// --------------------------------------------------------------------------
// Pull and Restore — operations on a selected region of the ORIGINAL space
// 당기기·복원 — 원래 공간에서 선택한 영역에 대한 조작
// --------------------------------------------------------------------------

export const PULL_MODES = Object.freeze(['move', 'elastic']);
export const PULL_MAX_OPS = 32;
export const RESTORE_MAX_OPS = 16;

function sanitizePullOps(raw) {
  if (!Array.isArray(raw)) return [];
  const fin = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const out = [];
  for (const o of raw.slice(-PULL_MAX_OPS)) {
    const region = sanitizeRegion(o?.region);
    if (!region) continue;
    out.push({
      region,
      mode: PULL_MODES.includes(o?.mode) ? o.mode : 'move',
      dx: Number(clamp(fin(o?.dx, 0), -1e5, 1e5).toFixed(3)),
      dy: Number(clamp(fin(o?.dy, 0), -1e5, 1e5).toFixed(3)),
      gx: Number(clamp(fin(o?.gx, 0), -1e7, 1e7).toFixed(2)),
      gy: Number(clamp(fin(o?.gy, 0), -1e7, 1e7).toFixed(2)),
    });
  }
  return out;
}

const pullPrep = new WeakMap();
/**
 * Weight of a pull at a point of the original space (cells). `box` = the domain in cells: the reach of
 * an elastic pull is measured inside it (a band selection runs to "infinity").
 * 당기기 가중치 (원래 공간 기준). box = 셀 단위 영역 (띠 선택의 탄성 반경은 그 안에서 잼).
 */
export function pullWeight(op, x, y, box = null) {
  if (op.mode !== 'elastic') return regionWeight(op.region, x, y);
  // elastic: the grab point moves fully, the outline stays; fall-off with the distance to the grab point
  // 탄성: 잡은 점은 그대로 따라오고 윤곽은 고정, 잡은 점에서 멀수록 약하게
  const p = regionPrep(op.region);
  if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) return 0;
  const sd = -regionDistance(op.region, x, y);
  if (sd <= 0) return 0;
  const bk = box ? `${box.x0},${box.x1},${box.y0},${box.y1}` : '';
  let hit = pullPrep.get(op);
  if (!hit || hit.bk !== bk) {
    let reach = 1;
    for (const [vx, vy] of op.region.poly) {
      const cx = box ? clamp(vx, Math.min(box.x0, op.gx), Math.max(box.x1, op.gx)) : vx;
      const cy = box ? clamp(vy, Math.min(box.y0, op.gy), Math.max(box.y1, op.gy)) : vy;
      reach = Math.max(reach, Math.hypot(cx - op.gx, cy - op.gy));
    }
    hit = { bk, reach };
    pullPrep.set(op, hit);
  }
  const s = Math.min(1, Math.hypot(x - op.gx, y - op.gy) / hit.reach);
  const edgeW = op.region.feather > 0 ? op.region.feather : 0.25 * hit.reach;
  return smooth01(Math.min(1, sd / edgeW)) * (1 - s * s) * (1 - s * s);
}

SpaceWarpRegistry.register({
  id: 'pull',
  name: { en: 'Pull (region)', ko: '당기기 (영역)' },
  toolOnly: true, // made by the Pull tool on a selection / 선택 영역 + 당기기 도구로 만듦
  params: [{ key: 'amount', type: 'range', min: 0, max: 1, step: 0.01 }, { key: 'lockTime', type: 'toggle' }],
  defaults: () => ({ amount: 1, lockTime: false, ops: [] }),
  sanitize: (out, src) => ({ ...out, ops: sanitizePullOps(src.ops) }),
  /** The selected part of the original space is carried by (dx, dy) cells; a soft edge (move) or a rubber sheet (elastic). */
  map(q, p, env) {
    if (!p.ops.length || !(p.amount > 0)) return;
    const [ot, om] = origin(q);
    const x = ot / env.ut;
    const y = om / env.um;
    const box = { x0: env.t0 / env.ut, x1: env.t1 / env.ut, y0: env.m0 / env.um, y1: env.m1 / env.um };
    for (const op of p.ops) {
      const w = pullWeight(op, x, y, box) * p.amount;
      if (!(w > 0)) continue;
      if (!p.lockTime) q.t += w * op.dx * env.ut;
      q.m += w * op.dy * env.um;
    }
  },
});

SpaceWarpRegistry.register({
  id: 'restore',
  name: { en: 'Restore (region)', ko: '복원 (영역)' },
  toolOnly: true, // made by "Restore" with a selection / 선택 영역 + 복원 버튼으로 만듦
  params: [],
  defaults: () => ({ ops: [] }),
  sanitize: (out, src) => ({ ...out, ops: (Array.isArray(src.ops) ? src.ops : []).slice(-RESTORE_MAX_OPS).map((o) => { const region = sanitizeRegion(o?.region); return region ? { region } : null; }).filter(Boolean) }),
  /** Everything above this stage is undone inside the regions (of the original space): the point goes back, copies fade out. */
  map(q, p, env) {
    if (!p.ops.length) return;
    const [ot, om] = origin(q);
    let keep = 1;
    for (const op of p.ops) keep *= 1 - regionWeight(op.region, ot / env.ut, om / env.um);
    const w = 1 - keep;
    if (!(w > 0)) return;
    q.t = lerp(q.t, ot, w);
    q.m = lerp(q.m, om, w);
    q.g = q.vp === false ? q.g * keep : lerp(q.g, q.og ?? 1, w);
    if (w >= 1) q.tag = 0;
  },
});

// --------------------------------------------------------------------------
// Lens, Twirl, Wave, Turbulence — smooth maps / 매끄러운 사상
// --------------------------------------------------------------------------

const centre = (p, env) => ({ cx: lerp(env.t0, env.t1, p.cx) / env.ut, cy: lerp(env.m0, env.m1, p.cy) / env.um });
const CENTRE_PARAMS = [
  { key: 'cx', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'cy', type: 'range', min: 0, max: 1, step: 0.01 },
  { key: 'radius', type: 'range', min: 1, max: 200, step: 0.5 },
];

SpaceWarpRegistry.register({
  id: 'lens',
  name: { en: 'Lens', ko: '렌즈' },
  params: [...CENTRE_PARAMS, { key: 'strength', type: 'range', min: -1, max: 1, step: 0.01 }, { key: 'lockTime', type: 'toggle' }],
  defaults: () => ({ cx: 0.5, cy: 0.5, radius: 24, strength: 0.5, lockTime: true }),
  /** Inside the radius r → r^e, e = 2^(−1.5·strength): bulge (> 0, intervals widen) or pinch (< 0). Lock time = pitch only. */
  map(q, p, env) {
    const { cx, cy } = centre(p, env);
    const ex = q.t / env.ut - cx;
    const ey = q.m / env.um - cy;
    const r = Math.hypot(ex, ey) / p.radius;
    if (r >= 1 || r < 1e-9) return;
    const f = Math.pow(r, Math.pow(2, -1.5 * p.strength) - 1);
    if (!p.lockTime) q.t = (cx + ex * f) * env.ut;
    q.m = (cy + ey * f) * env.um;
  },
});

SpaceWarpRegistry.register({
  id: 'twirl',
  name: { en: 'Twirl', ko: '비틀기' },
  params: [...CENTRE_PARAMS, { key: 'angle', type: 'range', min: -360, max: 360, step: 1, unit: '°' }],
  defaults: () => ({ cx: 0.5, cy: 0.5, radius: 24, angle: 60 }),
  map(q, p, env) {
    const { cx, cy } = centre(p, env);
    const ex = q.t / env.ut - cx;
    const ey = q.m / env.um - cy;
    const r = Math.hypot(ex, ey) / p.radius;
    if (r >= 1) return;
    const th = ((p.angle * Math.PI) / 180) * (1 - r) * (1 - r);
    q.t = (cx + ex * Math.cos(th) - ey * Math.sin(th)) * env.ut;
    q.m = (cy + ex * Math.sin(th) + ey * Math.cos(th)) * env.um;
  },
});

SpaceWarpRegistry.register({
  id: 'wave',
  name: { en: 'Wave', ko: '물결' },
  params: [
    { key: 'ampSemi', type: 'range', min: 0, max: 12, step: 0.05, unit: 'st' },
    { key: 'periodSec', type: 'range', min: 0.05, max: 20, step: 0.05, unit: 's' },
    { key: 'ampMs', type: 'range', min: 0, max: 1000, step: 5, unit: 'ms' },
    { key: 'periodSemi', type: 'range', min: 1, max: 48, step: 0.5, unit: 'st' },
    { key: 'phase', type: 'range', min: 0, max: 1, step: 0.01 },
  ],
  defaults: () => ({ ampSemi: 1, periodSec: 2, ampMs: 0, periodSemi: 12, phase: 0 }),
  /** m += A·sin 2π(t / T + φ) (a vibrato written into space); t += B·sin 2π(m / P + φ) (a time ripple along pitch). */
  map(q, p) {
    const t0 = q.t;
    const m0 = q.m;
    q.m = m0 + p.ampSemi * Math.sin(2 * Math.PI * (t0 / p.periodSec + p.phase));
    q.t = t0 + (p.ampMs / 1000) * Math.sin(2 * Math.PI * (m0 / p.periodSemi + p.phase));
  },
});

function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const ax = smooth01(x - xi);
  const ay = smooth01(y - yi);
  const v = (i, j) => hash3(xi + i, yi + j, seed) * 2 - 1;
  return lerp(lerp(v(0, 0), v(1, 0), ax), lerp(v(0, 1), v(1, 1), ax), ay);
}

SpaceWarpRegistry.register({
  id: 'turbulence',
  name: { en: 'Turbulence', ko: '난류' },
  params: [
    { key: 'ampSemi', type: 'range', min: 0, max: 12, step: 0.05, unit: 'st' },
    { key: 'ampMs', type: 'range', min: 0, max: 1000, step: 5, unit: 'ms' },
    { key: 'scaleSec', type: 'range', min: 0.05, max: 10, step: 0.05, unit: 's' },
    { key: 'scaleSemi', type: 'range', min: 0.5, max: 48, step: 0.5, unit: 'st' },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ ampSemi: 0.7, ampMs: 0, scaleSec: 0.8, scaleSemi: 12, seed: 1 }),
  /** Smooth seeded noise as displacement: the noise of a picture, as noise of the space. / 공간의 노이즈 */
  map(q, p, env) {
    const x = q.t / p.scaleSec;
    const y = q.m / p.scaleSemi;
    const s = (env.seed * 131 + p.seed * 7 + SALT.turbulence) | 0;
    const dm = p.ampSemi * valueNoise(x, y, s);
    const dt = (p.ampMs / 1000) * valueNoise(x + 31.7, y - 17.3, s + 1);
    q.m += dm;
    q.t += dt;
  },
});

// --------------------------------------------------------------------------
// Quantize, Mirror, Glitch — maps with breaks (q.tag marks the piece) / 끊김이 있는 사상
// --------------------------------------------------------------------------

SpaceWarpRegistry.register({
  id: 'quantize',
  name: { en: 'Pixelate', ko: '픽셀레이트' },
  params: [
    { key: 'stepSemi', type: 'range', min: 0.25, max: 12, step: 0.25, unit: 'st' },
    { key: 'strength', type: 'range', min: 0, max: 1, step: 0.01 },
  ],
  defaults: () => ({ stepSemi: 1, strength: 1 }),
  /** Pitch pulled onto steps: a glissando becomes a staircase (at strength 1 each step is its own piece). */
  map(q, p) {
    const k = Math.round(q.m / p.stepSemi);
    q.m = lerp(q.m, k * p.stepSemi, p.strength);
    if (p.strength >= 1) q.tag = q.tag * 131 + k;
  },
});

SpaceWarpRegistry.register({
  id: 'mirror',
  name: { en: 'Mirror', ko: '미러' },
  params: [
    { key: 'axis', type: 'select', options: ['pitch', 'time'] },
    { key: 'centre', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'mode', type: 'select', options: ['flip', 'fold', 'both'] },
  ],
  defaults: () => ({ axis: 'pitch', centre: 0.5, mode: 'both' }),
  /** flip = inversion / retrograde about the axis, fold = one side folded onto the other, both = original + flip. */
  variants(p, env) {
    const axisAt = () => (p.axis === 'pitch' ? lerp(env.m0, env.m1, p.centre) : lerp(env.t0, env.t1, p.centre));
    const flip = (q) => { const c = axisAt(); if (p.axis === 'pitch') q.m = 2 * c - q.m; else q.t = 2 * c - q.t; };
    const fold = (q) => { const c = axisAt(); if (p.axis === 'pitch') { if (q.m > c) q.m = 2 * c - q.m; } else if (q.t > c) q.t = 2 * c - q.t; };
    if (p.mode === 'flip') return [flip];
    if (p.mode === 'fold') return [fold];
    return [() => {}, flip];
  },
});

/** Seeded Poisson events of the glitch warp over [t0, t1]. / 글리치 이벤트 (시드 포아송) */
export function glitchEvents(p, { seed, t0, t1 }) {
  const out = [];
  if (!(p.rate > 0) || !(t1 > t0)) return out;
  // an avalanche hash per (event, draw): independent of how the seeds were combined / (이벤트, 추출)별 해시
  const sd = (Math.imul(seed | 0, 7919) ^ Math.imul(p.seed | 0, 104729) ^ SALT.glitch) | 0;
  const lo = Math.min(p.durMin, p.durMax);
  const hi = Math.max(p.durMin, p.durMax);
  let t = t0;
  for (let guard = 0; guard < 20000; guard++) {
    t += -Math.log(1 - hash3(sd, guard, 0) * 0.999999) / p.rate;
    if (t >= t1) break;
    const u = [hash3(sd, guard, 1), hash3(sd, guard, 2), hash3(sd, guard, 3), hash3(sd, guard, 4)];
    out.push({ t, dur: (lo + u[0] * (hi - lo)) / 1000, keep: u[3] < p.probability, jump: (2 * u[1] - 1) * p.rangeSemi, dt: ((2 * u[2] - 1) * p.timeJumpMs) / 1000 });
  }
  return out;
}
const glitchMemo = new Map();

SpaceWarpRegistry.register({
  id: 'glitch',
  name: { en: 'Glitch', ko: '글리치' },
  params: [
    { key: 'rate', type: 'range', min: 0, max: 30, step: 0.1, unit: '/s' },
    { key: 'durMin', type: 'range', min: 5, max: 400, step: 1, unit: 'ms' },
    { key: 'durMax', type: 'range', min: 5, max: 400, step: 1, unit: 'ms' },
    { key: 'rangeSemi', type: 'range', min: 0, max: 36, step: 0.5, unit: 'st' },
    { key: 'timeJumpMs', type: 'range', min: 0, max: 2000, step: 5, unit: 'ms' },
    { key: 'probability', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ rate: 4, durMin: 30, durMax: 90, rangeSemi: 7, timeJumpMs: 0, probability: 1, seed: 1 }),
  /** Short tiles of the plane are displaced in pitch (and time): the line jumps for a grain, then returns. */
  map(q, p, env) {
    const key = `${env.seed}|${env.t0}|${env.t1}|${JSON.stringify(p)}`;
    let ev = glitchMemo.get(key);
    if (!ev) { ev = glitchEvents(p, env).filter((e) => e.keep); if (glitchMemo.size > 16) glitchMemo.clear(); glitchMemo.set(key, ev); }
    // the last event that covers t wins (events are sorted by start) / t를 덮는 마지막 이벤트
    let lo = 0;
    let hi = ev.length - 1;
    let idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (ev[mid].t <= q.t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let k = idx; k >= 0 && k > idx - 6; k--) {
      const e = ev[k];
      if (q.t < e.t + e.dur) { q.m += e.jump; q.t += e.dt; q.tag = q.tag * 131 + k + 1; return; }
    }
  },
  step: (p) => Math.max(0.002, Math.min(p.durMin, p.durMax) / 4000),
});

// --------------------------------------------------------------------------
// Halftone (gain) and Chromatic (copies) / 할프톤(게인)과 크로매틱(복제)
// --------------------------------------------------------------------------

function logNormal(rng, m, cv) {
  if (!(cv > 0) || !(m > 0)) { rng(); rng(); return Math.max(0, m); }
  const s2 = Math.log(1 + cv * cv);
  const z = Math.sqrt(-2 * Math.log(1 - rng() * 0.999999)) * Math.cos(2 * Math.PI * rng());
  return Math.exp(Math.log(m) - s2 / 2 + Math.sqrt(s2) * z);
}

/** On-segments [{ on, off, len, gap, dropped }] of one gate unit over [t0, t1] (log-normal lengths). */
export function halftoneSegments(p, unit, { seed, t0, t1, offsetSec = 0 }) {
  const period = Math.max(0.005, p.periodMs / 1000);
  const rng = createSeededRandom(((seed * 2654435761) ^ (p.seed * 40503) ^ Math.imul(unit + 1, 0x9e3779b1) ^ SALT.halftone) >>> 0);
  const segs = [];
  let t = t0 + offsetSec - Math.ceil(offsetSec / period) * period - period;
  for (let guard = 0; guard < 100000 && t < t1; guard++) {
    const len = logNormal(rng, period * p.duty, p.jitter);
    const gap = logNormal(rng, period * (1 - p.duty), p.silenceJitter);
    const dropped = rng() < p.dropout;
    segs.push({ on: t, off: t + len, len, gap, dropped });
    t += Math.max(1e-4, len + gap);
  }
  return segs;
}
const gateMemo = new Map();

SpaceWarpRegistry.register({
  id: 'halftone',
  name: { en: 'Halftone', ko: '할프톤' },
  params: [
    { key: 'periodMs', type: 'range', min: 20, max: 1000, step: 1, unit: 'ms' },
    { key: 'duty', type: 'range', min: 0.02, max: 1, step: 0.01 },
    { key: 'jitter', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'silenceJitter', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'dropout', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'angle', type: 'range', min: -80, max: 80, step: 1, unit: '°' },
    { key: 'bandSemi', type: 'range', min: 0, max: 24, step: 0.5, unit: 'st' },
    { key: 'edgeMs', type: 'range', min: 2, max: 50, step: 0.5, unit: 'ms' },
    { key: 'seed', type: 'int', min: 0, max: 9999, step: 1 },
  ],
  defaults: () => ({ periodMs: 140, duty: 0.5, jitter: 0.4, silenceJitter: 0.4, dropout: 0, angle: 0, bandSemi: 0, edgeMs: 6, seed: 1 }),
  /**
   * Dots instead of a line = a random tremolo: gain gate with log-normal on / off lengths. The screen
   * angle shifts the gate with the pitch; bandSemi > 0 gives every pitch band its own gate.
   * 선 대신 점 = 랜덤 트레몰로 (켜짐·꺼짐 길이 로그정규). 스크린 각도 = 음고에 따른 게이트 이동.
   */
  map(q, p, env) {
    const unit = p.bandSemi > 0 ? Math.floor(q.m / p.bandSemi) : 0;
    const key = `${env.seed}|${env.t0}|${env.t1}|${unit}|${JSON.stringify(p)}`;
    let segs = gateMemo.get(key);
    if (!segs) { segs = halftoneSegments(p, unit, env).filter((s) => !s.dropped); if (gateMemo.size > 256) gateMemo.clear(); gateMemo.set(key, segs); }
    // 45° = one cell diagonal: a semitone up starts um/ut·… later / 45° = 셀 대각선
    const tt = q.t - (q.m - env.m0) * (env.ut / env.um) * Math.tan((p.angle * Math.PI) / 180);
    let lo = 0;
    let hi = segs.length - 1;
    let idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (segs[mid].on <= tt) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    let g = 0;
    if (idx >= 0 && tt < segs[idx].off) {
      const s = segs[idx];
      const edge = Math.min(s.len / 2, Math.max(0.002, p.edgeMs / 1000));
      g = Math.min(1, Math.min(tt - s.on, s.off - tt) / edge);
    }
    q.g *= g;
  },
  step: (p) => Math.max(0.002, Math.min(p.edgeMs / 2000, p.periodMs / 8000)),
});

/** Ratio presets p:q of the chromatic copies. / 크로매틱 비율 프리셋 */
export const CHROMA_RATIOS = Object.freeze([[1, 1], [9, 8], [6, 5], [5, 4], [4, 3], [3, 2], [8, 5], [5, 3], [7, 4], [2, 1], [3, 1], [5, 1]]);
export const CHROMA_CHANNELS = Object.freeze(['r', 'g', 'b']);
/** Exact interval of a channel in semitones: 12·log2((p / q)·2^(cents / 1200)). / 채널의 정확한 음정 (반음) */
export const chromaSemis = (p, ch) => 12 * Math.log2(p[`${ch}P`] / p[`${ch}Q`]) + p[`${ch}Cents`] / 100;

const chromaParams = () => {
  const out = [{ key: 'link', type: 'toggle' }];
  for (const ch of CHROMA_CHANNELS) {
    out.push(
      { key: `${ch}On`, type: 'toggle', channel: ch },
      { key: `${ch}P`, type: 'int', min: 1, max: 32, step: 1, channel: ch },
      { key: `${ch}Q`, type: 'int', min: 1, max: 32, step: 1, channel: ch },
      { key: `${ch}Cents`, type: 'range', min: -100, max: 100, step: 0.1, unit: '¢', channel: ch },
      { key: `${ch}Gain`, type: 'range', min: 0, max: 1.5, step: 0.01, channel: ch },
      { key: `${ch}TimeMs`, type: 'range', min: -500, max: 500, step: 1, unit: 'ms', channel: ch },
      { key: `${ch}Pan`, type: 'range', min: -1, max: 1, step: 0.01, channel: ch },
    );
  }
  return out;
};

SpaceWarpRegistry.register({
  id: 'chroma',
  name: { en: 'Chromatic Aberration', ko: '크로매틱 애버레이션' },
  params: chromaParams(),
  defaults: () => ({
    link: true,
    rOn: true, rP: 2, rQ: 3, rCents: 0, rGain: 0.7, rTimeMs: -8, rPan: -0.8,
    gOn: true, gP: 1, gQ: 1, gCents: 0, gGain: 1, gTimeMs: 0, gPan: 0,
    bOn: true, bP: 3, bQ: 2, bCents: 0, bGain: 0.7, bTimeMs: 8, bPan: 0.8,
  }),
  sanitize(out) {
    if (out.link) Object.assign(out, { rP: out.bQ, rQ: out.bP, rCents: -out.bCents, rPan: -out.bPan, rTimeMs: -out.bTimeMs, rGain: out.bGain });
    return out;
  },
  /** Three images of the plane on exact just ratios (R / G / B): pitch + 12·log2(p / q), own gain, time, pan. */
  variants(p) {
    const out = [];
    for (const ch of CHROMA_CHANNELS) {
      if (!p[`${ch}On`]) continue;
      const semis = chromaSemis(p, ch);
      const dt = p[`${ch}TimeMs`] / 1000;
      const gain = p[`${ch}Gain`];
      const pan = p[`${ch}Pan`];
      const fn = (q) => { q.m += semis; q.t += dt; q.g *= gain; q.pan = clamp(q.pan + pan, -1, 1); };
      fn.ch = ch;
      fn.semis = semis;
      out.push(fn);
    }
    return out;
  },
});

// --------------------------------------------------------------------------
// Applying a stack / 스택 적용
// --------------------------------------------------------------------------

const MAX_VARIANTS = 12;

/** Variant functions of every active stage: [[fn, …] per stage]. / 활성 단계별 변형 함수 */
function stagePlans(stack, env) {
  const out = [];
  (stack || []).forEach((it, idx) => {
    const def = defs.get(it.type);
    if (!def || !it.on || !(it.mix > 0)) return;
    const stageEnv = { ...env, seed: (env.seed * 9973 + idx * 131) >>> 0 };
    const fns = def.variants ? def.variants(it.params, stageEnv) : [(q) => def.map(q, it.params, stageEnv)];
    if (fns.length) out.push({ it, def, fns });
    else out.push({ it, def, fns: [(q) => { q.g = 0; }] }); // every image switched off = nothing / 모든 상이 꺼짐
  });
  return out;
}

/** Index tuples of the images a stack produces (product of the stage variants, ≤ 12). / 스택이 만드는 상의 조합 */
export function stackVariants(stack, env) {
  const plans = stagePlans(stack, env);
  let combos = [[]];
  for (const pl of plans) {
    const next = [];
    for (const c of combos) for (let k = 0; k < pl.fns.length && next.length < MAX_VARIANTS; k++) next.push([...c, k]);
    combos = next;
  }
  return { plans, combos };
}

function runPoint(q, plans, combo) {
  // the original position (Pull / Restore select in the original space) and whether this is the first image
  // 원래 위치 (당기기·복원은 원래 공간에서 선택) 와 첫 번째 상인지
  q.ot = q.t; q.om = q.m; q.og = q.g; q.vp = !combo.some((k) => k > 0);
  for (let s = 0; s < plans.length; s++) {
    const { it, fns } = plans[s];
    const mix = it.mix;
    if (mix >= 1) { fns[combo[s]](q); continue; }
    const t0 = q.t;
    const m0 = q.m;
    const g0 = q.g;
    fns[combo[s]](q);
    q.t = lerp(t0, q.t, mix);
    q.m = lerp(m0, q.m, mix);
    q.g = lerp(g0, q.g, mix);
  }
  return q;
}

/** Image of one point under the first image of the stack: { t, m, g, pan, tag }. / 점 하나의 상 (첫 번째 상) */
export function warpPoint(stack, t, m, env, prepared = null) {
  const pre = prepared || stackVariants(stack, env);
  return runPoint({ t, m, g: 1, pan: 0, tag: 0 }, pre.plans, pre.combos[0] || []);
}

/** Largest sampling step (s) a stack needs. / 스택이 요구하는 최대 표본 간격 */
export function stackStep(stack, base = 0.02) {
  let s = base;
  for (const it of stack || []) { const def = defs.get(it.type); if (def?.step && it.on && it.mix > 0) s = Math.min(s, def.step(it.params)); }
  return Math.max(0.002, s);
}

/**
 * Warp a polyline [{ t, m, w?, g? }] (m = NaN marks a gap). The line is sampled densely, every point is
 * mapped, and the result is cut where the map breaks (tag change), at gaps, and where time turns
 * back: each run is strictly increasing in time (a backward run is reversed).
 * 폴리라인 변형: 촘촘히 표본화 → 점마다 사상 → 사상이 끊기는 곳·틈·시간이 되돌아가는 곳에서 자름 (각 조각은 시간 단조 증가).
 * @returns {Array<{ variant: number, ch: string|null, pts: Array<{ t, m, w, g, pan }> }>}
 */
export function warpPolyline(pts, stack, env, { step = stackStep(stack), maxPoints = 4000, monotone = true } = {}) {
  const pre = stackVariants(stack, env);
  // dense source samples / 촘촘한 원본 표본
  const src = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    if (!Number.isFinite(a.m) || !Number.isFinite(a.t)) { src.push(null); continue; }
    const b = pts[i + 1];
    src.push(a);
    if (!b || !Number.isFinite(b.m)) continue;
    const n = Math.min(4000, Math.floor(Math.abs(b.t - a.t) / step));
    for (let k = 1; k <= n; k++) { const u = k / (n + 1); src.push({ t: lerp(a.t, b.t, u), m: lerp(a.m, b.m, u), w: lerp(a.w ?? 0.7, b.w ?? 0.7, u), g: lerp(a.g ?? 1, b.g ?? 1, u) }); }
  }
  const stride = Math.max(1, Math.ceil(src.length / maxPoints));
  const out = [];
  pre.combos.forEach((combo, vi) => {
    const last = pre.plans.length ? pre.plans.map((pl, s) => pl.fns[combo[s]]).reverse().find((fn) => fn.ch) : null;
    let run = [];
    let tag = null;
    const flush = () => {
      if (run.length >= 2) {
        if (!monotone) out.push({ variant: vi, ch: last?.ch || null, pts: run });
        else for (const r of monotoneRuns(run)) out.push({ variant: vi, ch: last?.ch || null, pts: r });
      }
      run = [];
      tag = null;
    };
    for (let i = 0; i < src.length; i += stride) {
      const a = src[i];
      if (!a) { flush(); continue; }
      const q = runPoint({ t: a.t, m: a.m, g: a.g ?? 1, pan: 0, tag: 0 }, pre.plans, combo);
      if (tag !== null && q.tag !== tag) flush();
      tag = q.tag;
      run.push({ t: q.t, m: q.m, w: a.w ?? 0.7, g: q.g, pan: q.pan });
    }
    flush();
  });
  return out;
}

/** Maximal runs of strictly increasing time (backward runs reversed, standing points dropped). / 시간 단조 구간 */
export function monotoneRuns(pts) {
  const runs = [];
  let cur = [pts[0]];
  let dir = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - cur[cur.length - 1].t;
    const d = Math.abs(dt) < 1e-7 ? 0 : Math.sign(dt);
    if (d === 0) continue;
    if (dir === 0 || d === dir) { cur.push(pts[i]); dir = d; continue; }
    runs.push(dir < 0 ? cur.reverse() : cur);
    cur = [cur[dir < 0 ? 0 : cur.length - 1], pts[i]];
    dir = d;
  }
  runs.push(dir < 0 ? cur.reverse() : cur);
  return runs.filter((r) => r.length >= 2 && r[r.length - 1].t - r[0].t > 0.01);
}

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const ENV = { seed: 1, ut: 0.125, um: 0.5, t0: 0, t1: 8, m0: 48, m1: 72 };
const stage = (type, params, over) => sanitizeWarpStack([{ type, params, ...over }]);

registerSelfCheck('Space warp: registry contract, identity cases, mix', (a) => {
  for (const w of SpaceWarpRegistry.list()) a.equal(validateSpaceWarp(w).join('; '), '', `warp "${w.id}" valid`);
  a.ok(['liquify', 'lens', 'twirl', 'wave', 'turbulence', 'quantize', 'mirror', 'glitch', 'halftone', 'chroma'].every((id) => SpaceWarpRegistry.has(id)), 'ten warps registered');
  a.ok(validateSpaceWarp({ id: 'x', name: { en: 'X', ko: 'X' }, params: [], defaults: () => ({}) }).length > 0, 'a warp needs a map');
  const id = [...stage('liquify', { ops: [] }), ...stage('wave', { ampSemi: 0, ampMs: 0 }), ...stage('twirl', { angle: 0 }), ...stage('glitch', { rate: 0 }), ...stage('lens', { strength: 0 })];
  const q = warpPoint(sanitizeWarpStack(id), 3.3, 61.7, ENV);
  a.ok(Math.abs(q.t - 3.3) < 1e-12 && Math.abs(q.m - 61.7) < 1e-12 && q.g === 1, 'neutral parameters = identity');
  a.ok(isIdentityStack(stage('wave', {}, { on: false })) && isIdentityStack(stage('wave', {}, { mix: 0 })) && !isIdentityStack(stage('wave', {})), 'off / mix 0 = identity stack');
  const full = warpPoint(stage('wave', { ampSemi: 4, periodSec: 4, phase: 0.25 }), 0, 60, ENV);
  const half = warpPoint(stage('wave', { ampSemi: 4, periodSec: 4, phase: 0.25 }, { mix: 0.5 }), 0, 60, ENV);
  a.near(full.m, 64, 1e-9, 'wave: m + A·sin');
  a.near(half.m, 62, 1e-9, 'mix 0.5 = half the displacement');
  a.equal(sanitizeWarpParams('wave', { ampSemi: 999 }).ampSemi, 12, 'parameters clamped');
}, { group: 'modules' });

registerSelfCheck('Space warp: liquify push / reconstruct / lockTime, lens, twirl, quantize, mirror', (a) => {
  const push = [{ tool: 'push', size: 120, strength: 1, pts: [[20, 120], [20, 126]] }];
  const st = stage('liquify', { ops: push });
  const q = warpPoint(st, 2.5, 60, ENV); // cell (20, 120)
  a.near(q.m - 60, 6 * ENV.um, 0.05 * 3, 'push by 6 cells = 3 semitones at the brush centre (± 5 %)');
  a.near(q.t, 2.5, 1e-9, 'a vertical push does not move time');
  const far = warpPoint(st, 30, 50, ENV);
  a.ok(Math.abs(far.m - 50) < 1e-9, 'outside the brush nothing moves');
  const diag = stage('liquify', { lockTime: true, ops: [{ tool: 'push', size: 30, strength: 1, pts: [[18, 120], [24, 124]] }] });
  const d = warpPoint(diag, 2.5, 60, ENV);
  a.ok(d.t === 2.5 && d.m > 60.5, 'lockTime: only the pitch moves');
  const scrub = Array.from({ length: 40 }, (_, k) => [20 + (k % 2), 120]);
  const rec = warpPoint(stage('liquify', { ops: [...push, { tool: 'reconstruct', size: 240, strength: 1, pts: scrub }] }), 2.5, 60, ENV);
  a.ok(Math.abs(rec.m - 60) < 1e-6, 'reconstruct brushed over it restores the place');
  a.equal(JSON.stringify(warpPoint(st, 2.4, 61, ENV)), JSON.stringify(warpPoint(sanitizeWarpStack(JSON.parse(JSON.stringify(st))), 2.4, 61, ENV)), 'replay is deterministic');
  const lens = stage('lens', { cx: 0.5, cy: 0.5, radius: 24, strength: 1, lockTime: true });
  const up = warpPoint(lens, 4, 63, ENV);
  const dn = warpPoint(lens, 4, 57, ENV);
  a.ok(up.m > 63 && dn.m < 57 && Math.abs((up.m - 60) + (dn.m - 60)) < 1e-9, `bulge widens intervals symmetrically (${up.m.toFixed(2)} / ${dn.m.toFixed(2)})`);
  a.near(warpPoint(lens, 4, 60, ENV).m, 60, 1e-9, 'the centre stays');
  a.ok(warpPoint(stage('lens', { cx: 0.5, cy: 0.5, radius: 24, strength: -1, lockTime: true }), 4, 63, ENV).m < 63, 'pinch narrows them');
  const tw = warpPoint(stage('twirl', { cx: 0.5, cy: 0.5, radius: 40, angle: 90 }), 4, 60, ENV);
  a.ok(Math.abs(tw.t - 4) < 1e-9 && Math.abs(tw.m - 60) < 1e-9, 'twirl: the centre stays');
  const tw2 = warpPoint(stage('twirl', { cx: 0.5, cy: 0.5, radius: 40, angle: 90 }), 5, 60, ENV);
  a.ok(tw2.m > 60.5 && tw2.t < 5, 'twirl turns a point on the time axis towards pitch');
  a.near(warpPoint(stage('quantize', { stepSemi: 2, strength: 1 }), 1, 60.9, ENV).m, 60, 1e-9, 'pixelate: pitch on the step');
  a.near(warpPoint(stage('quantize', { stepSemi: 2, strength: 0.5 }), 1, 60.8, ENV).m, 60.4, 1e-9, 'pixelate strength 0.5: half-way');
  a.near(warpPoint(stage('mirror', { axis: 'pitch', centre: 0.5, mode: 'flip' }), 1, 65, ENV).m, 55, 1e-9, 'mirror flip about the centre (inversion)');
  a.near(warpPoint(stage('mirror', { axis: 'time', centre: 0.5, mode: 'flip' }), 1, 65, ENV).t, 7, 1e-9, 'mirror in time (retrograde)');
  a.near(warpPoint(stage('mirror', { axis: 'pitch', centre: 0.5, mode: 'fold' }), 1, 55, ENV).m, 55, 1e-9, 'fold leaves the lower side');
}, { group: 'modules' });

registerSelfCheck('Space warp: polylines — glissando staircase, glitch grains, halftone gates, chromatic copies, time reversal', (a) => {
  const gliss = [{ t: 0, m: 60 }, { t: 4, m: 68 }];
  a.equal(warpPolyline(gliss, [], ENV).length, 1, 'empty stack: one run');
  const stairs = warpPolyline(gliss, stage('quantize', { stepSemi: 2, strength: 1 }), ENV);
  a.equal(stairs.length, 5, 'pixelate 2 st on an 8 st glissando = 5 steps');
  a.ok(stairs.every((r) => r.pts.every((q) => Math.abs(q.m - r.pts[0].m) < 1e-9)), 'every step is level');
  const held = [{ t: 0, m: 60 }, { t: 8, m: 60 }];
  const gp = sanitizeWarpParams('glitch', { rate: 3, durMin: 40, durMax: 80, rangeSemi: 7 });
  const ev = glitchEvents(gp, ENV);
  a.ok(Math.abs(ev.length - 24) <= 3 * Math.sqrt(24), `${ev.length} events in 8 s at 3 / s`);
  a.equal(JSON.stringify(glitchEvents(gp, ENV)), JSON.stringify(ev), 'same seed → same events');
  a.ok(JSON.stringify(glitchEvents(gp, { ...ENV, seed: 2 })) !== JSON.stringify(ev), 'another seed → other events');
  const gl = warpPolyline(held, stage('glitch', gp), ENV);
  const jumped = gl.filter((r) => Math.abs(r.pts[0].m - 60) > 1e-6);
  const evStage = glitchEvents(gp, { ...ENV, seed: ENV.seed * 9973 }); // the seed stage 0 of a stack gets / 스택 0번 단계가 받는 시드
  a.ok(jumped.length <= evStage.length && jumped.length >= evStage.length - 4 && jumped.every((r) => { const d = r.pts[r.pts.length - 1].t - r.pts[0].t; return d <= 0.085 && Math.abs(r.pts[0].m - 60) <= 7 + 1e-9; }), `${jumped.length} grains, each ≤ 80 ms and inside the range`);
  a.equal(warpPolyline(held, stage('glitch', { rate: 0 }), ENV).length, 1, 'rate 0 = one unbroken line');
  // halftone: mean gain ≈ duty (minus the edge ramps), regular gate at jitter 0 / 평균 게인 ≈ 듀티
  const hp = { periodMs: 200, duty: 0.5, jitter: 0, silenceJitter: 0, edgeMs: 2 };
  const ht = warpPolyline(held, stage('halftone', hp), ENV)[0];
  const mean = ht.pts.reduce((s, q) => s + q.g, 0) / ht.pts.length;
  a.near(mean, 0.5, 0.03, 'gate area = duty');
  const segs = halftoneSegments(sanitizeWarpParams('halftone', { ...hp, jitter: 0.3, silenceJitter: 0.5, duty: 0.4 }), 0, { seed: 1, t0: 0, t1: 800 });
  const stat = (xs) => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; return { m, cv: Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) / m }; };
  const on = stat(segs.map((s) => s.len));
  const off = stat(segs.map((s) => s.gap));
  a.ok(Math.abs(on.m - 0.08) < 0.008 && Math.abs(on.cv - 0.3) < 0.03 && Math.abs(off.m - 0.12) < 0.012 && Math.abs(off.cv - 0.5) < 0.05, 'on / off lengths follow their log-normal distributions');
  // chromatic: three images exactly 12·log2(ratio) apart / 정확한 비율의 세 상
  const ch = warpPolyline(held, stage('chroma', { link: false, rP: 2, rQ: 3, bP: 3, bQ: 2, rTimeMs: 0, bTimeMs: 100 }), ENV);
  a.equal(ch.map((r) => r.ch).join(), 'r,g,b', 'three copies');
  a.ok(Math.abs(ch[0].pts[0].m - (60 + 12 * Math.log2(2 / 3))) < 1e-9 && ch[1].pts[0].m === 60 && Math.abs(ch[2].pts[0].m - (60 + 12 * Math.log2(3 / 2))) < 1e-9, 'copies at exactly 12·log2(p / q)');
  a.near(ch[2].pts[0].t, 0.1, 1e-9, 'time offset of a channel');
  a.ok(ch[0].pts[0].pan < 0 && ch[2].pts[0].pan > 0 && Math.abs(ch[0].pts[0].g - 0.7) < 1e-9, 'pan and gain per channel');
  a.equal(warpPolyline(held, [...stage('chroma', {}), ...stage('mirror', { mode: 'both' })].map((s, i) => ({ ...s, id: `s${i}` })), ENV).length, 6, 'copies multiply (3 × 2)');
  // a strong twirl turns time back: the line is cut into forward runs / 시간이 되돌아가면 전진 구간으로 자름
  const tw = warpPolyline([{ t: 0, m: 60 }, { t: 8, m: 60 }], stage('twirl', { cx: 0.5, cy: 0.5, radius: 30, angle: 300 }), ENV);
  a.ok(tw.length >= 2 && tw.every((r) => r.pts.every((q, i) => i === 0 || q.t > r.pts[i - 1].t)), `${tw.length} runs, each strictly forward in time`);
  const gap = warpPolyline([{ t: 0, m: 60 }, { t: 1, m: 60 }, { t: 1, m: NaN }, { t: 2, m: 64 }, { t: 3, m: 64 }], [], ENV);
  a.equal(gap.length, 2, 'a NaN point is a gap');
}, { group: 'modules' });

registerSelfCheck('Space warp: brush details, regions, Pull (move / elastic), Restore (region)', (a) => {
  // brush details: defaults = the round brush of 0.44 (byte-identical strokes) / 기본값 = 기존 둥근 브러시
  const base = { tool: 'push', size: 20, strength: 1, pts: [[20, 120], [20, 126]] };
  a.equal(JSON.stringify(sanitizeWarpParams('liquify', { ops: [base] }).ops[0]), JSON.stringify(sanitizeWarpParams('liquify', { ops: [{ ...base, hardness: 0, aspect: 1, angle: 0, axis: 'both' }] }).ops[0]), 'default details are not stored');
  a.near(brushFalloff(0.25, 0), 0.5625, 1e-12, 'hardness 0 = (1 − d²)²');
  a.equal(brushFalloff(0.16, 0.5), 1, 'inside the hard core = full strength');
  const at = (op, t, m) => warpPoint(stage('liquify', { ops: [op] }), t, m, ENV);
  const soft = at(base, 2.5, 60 + 12 * ENV.um).m - 60 - 12 * ENV.um;
  const hard = at({ ...base, hardness: 0.8 }, 2.5, 60 + 12 * ENV.um).m - 60 - 12 * ENV.um;
  a.ok(hard > soft + 0.5 && Math.abs(hard - 6 * ENV.um) < 1e-6, `hardness keeps more strength off-centre (${soft.toFixed(3)} → ${hard.toFixed(3)})`);
  const wide = { ...base, size: 10, aspect: 4 }; // rx = 20 cells, ry = 5 cells / 시간으로 넓은 타원
  a.ok(Math.abs(at(wide, 2.5 + 15 * ENV.ut, 60).m - 60) > 0.05 && Math.abs(at(wide, 2.5, 60 + 14 * ENV.um).m - 60 - 14 * ENV.um) < 1e-9, 'aspect 4: reaches far in time, not in pitch');
  const diag = { tool: 'push', size: 30, strength: 1, pts: [[18, 120], [24, 126]] };
  const tOnly = at({ ...diag, axis: 'time' }, 2.5, 60);
  const pOnly = at({ ...diag, axis: 'pitch' }, 2.5, 60);
  a.ok(tOnly.m === 60 && tOnly.t > 2.5 && pOnly.t === 2.5 && pOnly.m > 60, 'axis: time only / pitch only');
  // regions / 영역
  const box = sanitizeRegion({ poly: [[0, 100], [40, 100], [40, 140], [0, 140]], feather: 10 });
  a.equal(regionWeight(box, 20, 120), 1, 'inside = 1');
  a.equal(regionWeight(box, 60, 120), 0, 'beyond the soft edge = 0');
  a.near(regionWeight(box, 45, 120), 0.5, 1e-9, 'half-way through the soft edge = 0.5');
  a.ok(regionDistance(box, 20, 120) < 0 && Math.abs(regionDistance(box, 50, 120) - 10) < 1e-9, 'signed distance');
  a.equal(sanitizeRegion({ poly: [[0, 0], [1, 1]] }), null, 'fewer than 3 points = no region');
  const masked = at({ ...base, size: 120, mask: { poly: [[0, 0], [10, 0], [10, 1000], [0, 1000]], feather: 0 } }, 2.5, 60);
  a.ok(Math.abs(masked.m - 60) < 1e-9, 'a brush confined to a region does not move what lies outside it');
  // Pull: move / 이동
  const band = { poly: [[-REGION_FAR, 116], [REGION_FAR, 116], [REGION_FAR, 124], [-REGION_FAR, 124]], feather: 0 }; // 58 – 62 st
  const pull = (ops, extra = {}) => sanitizeWarpStack([{ type: 'pull', params: { ops, ...extra } }]);
  const mv = pull([{ region: band, mode: 'move', dx: 0, dy: 8 }]);
  a.near(warpPoint(mv, 3, 60, ENV).m, 64, 1e-9, 'move: a pitch band carried up by 8 cells = 4 st');
  a.near(warpPoint(mv, 3, 70, ENV).m, 70, 1e-9, 'outside the band nothing moves');
  a.near(warpPoint(pull([{ region: band, mode: 'move', dx: 8, dy: 0 }], { lockTime: true }), 3, 60, ENV).t, 3, 1e-9, 'lock time');
  // Pull: elastic — grab point moves fully, outline stays / 탄성
  const el2 = pull([{ region: box, mode: 'elastic', dx: 0, dy: 6, gx: 20, gy: 120 }]);
  a.near(warpPoint(el2, 20 * ENV.ut, 60, ENV).m, 63, 1e-6, 'elastic: the grabbed point moves fully');
  a.near(warpPoint(el2, 0.01 * ENV.ut, 60, ENV).m, 60, 0.02, 'elastic: the outline stays');
  // the selection is taken in the ORIGINAL space, whatever comes before it / 선택은 원래 공간 기준
  const after = sanitizeWarpStack([{ type: 'wave', params: { ampSemi: 5, periodSec: 4, phase: 0.25 } }, { type: 'pull', params: { ops: [{ region: band, mode: 'move', dx: 0, dy: 8 }] } }]);
  a.near(warpPoint(after, 0, 60, ENV).m, 69, 1e-9, 'pull after wave: the band is still selected where the point was');
  // Restore (region) / 영역 복원
  const warped = sanitizeWarpStack([{ type: 'wave', params: { ampSemi: 3, periodSec: 4, phase: 0.25 } }, { type: 'restore', params: { ops: [{ region: band }] } }]);
  a.near(warpPoint(warped, 0, 60, ENV).m, 60, 1e-9, 'restore: inside the region the point goes back');
  a.near(warpPoint(warped, 0, 70, ENV).m, 73, 1e-9, 'restore: outside the region the warp stays');
  const copies = warpPolyline([{ t: 0, m: 60 }, { t: 2, m: 60 }], sanitizeWarpStack([{ type: 'chroma', params: {} }, { type: 'restore', params: { ops: [{ region: band }] } }]), ENV);
  a.ok(copies.length === 3 && copies[0].pts.every((q) => Math.abs(q.m - 60) < 1e-9 && Math.abs(q.g - 1) < 1e-9) && copies.slice(1).every((r) => r.pts.every((q) => q.g < 1e-9)), 'restore: one copy back at the original, the others silent');
  a.ok(!SpaceWarpRegistry.list().filter((w) => w.toolOnly).some((w) => !['pull', 'restore'].includes(w.id)), 'only Pull and Restore are tool-made');
}, { group: 'modules' });
