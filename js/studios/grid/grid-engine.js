/**
 * Flexatone — studios/grid/grid-engine.js
 * Grid Studio — the STUDIO ENGINE (pure: no DOM, no audio). A painted time × pitch raster goes
 * through a stack of image effects; the result is the amplitude matrix of an additive bank.
 * 그리드 스튜디오의 스튜디오 엔진 (순수). 칠한 시간 × 음고 래스터 → 이미지 효과 스택 → 가산 뱅크의 진폭 행렬.
 *
 *   raster (rows × cols, 0..1, RLE8 in the document)
 *     → FINE MATRIX M[frame][bin]   bin = 1 / binsPerSemi semitones (fixed frequency), frame = 1 / frameRate s
 *     → matrix effects, in stack order (on / mix / mask handled here)
 *     → [Noise grain]               the matrix part of the output-stage Noise effect
 *     → bank effects (Noise bus, Chromatic Aberration) + synthesis: grid-bank.js / grid-audio.js
 *
 * Stage cache / 단계 캐시: key_i = hash(key_{i−1}, effect signature). Changing an effect in the middle
 * recomputes from that stage on; sound-only edits (timbre, gain, pan, bank parameters) recompute
 * nothing. Same signature → the same matrix, bit for bit (every random number is seeded).
 * 중간 효과를 바꾸면 그 단계부터만 재계산, 소리 전용 편집은 재계산 0회. 같은 시그니처 = 같은 행렬.
 *
 * Imports: core/*, modules/timbre-spec.js, grid-effects.js, grid-tools.js.
 */

import { clamp, deepClone } from '../../core/math-utils.js';
import { TIMBRE_WAVES } from '../../core/state.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { timbreSpecExtras } from '../../modules/timbre-spec.js';
import { GridEffectRegistry, sanitizeEffectParams, liquifyMesh } from './grid-effects.js';
import { paintLine, rectCoverage, ellipseCoverage, polygonCoverage, featherCoverage } from './grid-tools.js';

// --------------------------------------------------------------------------
// Limits and options / 한계와 선택지
// --------------------------------------------------------------------------

export const GRID_MAX_CELLS = 200000;
export const GRID_MAX_LAYERS = 4;
export const GRID_MAX_STACK = 12;
export const GRID_QUALITIES = Object.freeze(['draft', 'normal', 'high']);
export const GRID_BINS = Object.freeze([2, 4, 8, 12, 16]);
export const GRID_ROWS_PER_SEMI = Object.freeze([1, 2, 3, 4]);
export const GRID_COLORMAPS = Object.freeze(['layer', 'heat', 'gray']);
export const GRID_TOOLS = Object.freeze(['brush', 'eraser', 'line', 'rect', 'ellipse', 'bucket', 'gradient', 'eyedropper', 'select', 'mask', 'liquify']);
export const GRID_SELECT_KINDS = Object.freeze(['rect', 'ellipse', 'lasso']);
export const GRID_MASKS = Object.freeze(['none', 'selection', 'layerMask']);
export const GRID_LAYER_COLORS = Object.freeze(['#38bdf8', '#f472b6', '#facc15', '#34d399']);
export const GRID_PRESET_IDS = Object.freeze(['pureLines', 'chorusCloud', 'smear', 'focusPull', 'breath', 'stutter', 'dottedLight', 'fifthShimmer', 'wavy', 'everything']);
/** Bank effects, in their fixed order at the end of every stack. / 스택 끝에 고정되는 뱅크 효과 */
export const GRID_BANK_ORDER = Object.freeze(['noise', 'chroma']);
/** Largest matrix (frames × bins) per quality; above it the frame rate, then the bin density, are halved. */
const CELL_BUDGET = Object.freeze({ draft: 0.4e6, normal: 1.6e6, high: 3.2e6, preview: 0.25e6 });

const fin = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

/** Short, stable hash of a string (two 32-bit mixes + length). / 문자열 해시 */
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

// --------------------------------------------------------------------------
// Raster codec: 8-bit quantisation + run-length (sparse rasters are tiny)
// 래스터 코덱: 8비트 양자화 + RLE (희소 래스터는 매우 작음)
//   token 0x00..0x7F  literal run of (token + 1) bytes
//   token 0x80        repeat: LEB128 count, then the byte
// --------------------------------------------------------------------------

function rleEncode(bytes) {
  const out = [];
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(0x80);
      let c = run;
      while (c >= 0x80) { out.push((c & 0x7f) | 0x80); c >>>= 7; }
      out.push(c, bytes[i]);
      i += run;
      continue;
    }
    const start = i;
    while (i < n && i - start < 128) {
      if (i + 2 < n && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break;
      i++;
    }
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(bytes[k]);
  }
  return Uint8Array.from(out);
}

function rleDecode(bytes, total) {
  const out = new Uint8Array(total);
  let i = 0;
  let o = 0;
  while (i < bytes.length && o < total) {
    const tk = bytes[i++];
    if (tk === 0x80) {
      let c = 0;
      let shift = 0;
      let b;
      do { b = bytes[i++]; c |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      const v = bytes[i++];
      out.fill(v, o, Math.min(total, o + c));
      o += c;
    } else {
      for (let k = 0; k <= tk && o < total; k++) out[o++] = bytes[i++];
    }
  }
  return out;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(s);
}

function fromBase64(str) {
  const s = globalThis.atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const decodeCache = new Map(); // "rows x cols : data" → Float32Array (read-only) / 디코드 캐시

/** Float32 raster (rows × cols, 0..1) → document form { enc: 'rle8', rows, cols, data }. / 래스터 인코딩 */
export function encodeRaster(values, rows, cols) {
  const bytes = new Uint8Array(rows * cols);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(clamp(values[i] || 0, 0, 1) * 255);
  return { enc: 'rle8', rows, cols, data: toBase64(rleEncode(bytes)) };
}

/** Document raster → Float32Array (cached; treat as READ-ONLY, copy before painting). / 디코딩 (읽기 전용) */
export function decodeRaster(raster) {
  const key = `${raster.rows}x${raster.cols}:${raster.data}`;
  let hit = decodeCache.get(key);
  if (hit) return hit;
  const total = raster.rows * raster.cols;
  hit = new Float32Array(total);
  try {
    const bytes = rleDecode(fromBase64(raster.data), total);
    for (let i = 0; i < total; i++) hit[i] = bytes[i] / 255;
  } catch { /* unreadable data → empty raster / 읽을 수 없는 데이터는 빈 래스터 */ }
  if (decodeCache.size > 24) decodeCache.delete(decodeCache.keys().next().value);
  decodeCache.set(key, hit);
  return hit;
}

export const emptyRaster = (rows, cols) => encodeRaster(new Float32Array(rows * cols), rows, cols);

/** Rows and columns of a grid: row r = pLo + r / rowsPerSemi (so painted rows are in tune). / 격자 모양 */
export function gridShape(grid) {
  return { rows: (grid.pHi - grid.pLo) * grid.rowsPerSemi + 1, cols: Math.max(1, Math.round(grid.length * grid.colsPerSec)) };
}

/**
 * Resample a raster from one grid to another on physical coordinates (seconds, MIDI pitch), so a
 * resolution, range or length change keeps every sound where it was. mode 'area' = area average
 * (keeps the total ink), 'nearest' = nearest cell (keeps hard edges).
 * 물리 좌표(초·음고) 기준 리샘플 — 해상도·음역·길이를 바꿔도 소리의 위치 유지. area = 면적 평균, nearest = 최근접.
 */
export function regridRaster(src, from, to, mode = 'area') {
  const a = gridShape(from);
  const b = gridShape(to);
  const sample = (get, len, lo, hi) => {
    if (mode === 'nearest' || hi - lo < 1e-9) { const k = Math.floor(0.5 * (lo + hi)); return k >= 0 && k < len ? get(k) : 0; }
    let s = 0;
    for (let k = Math.max(0, Math.floor(lo)); k < Math.min(len, Math.ceil(hi)); k++) s += get(k) * (Math.min(hi, k + 1) - Math.max(lo, k));
    return s / (hi - lo);
  };
  const tmp = new Float32Array(a.rows * b.cols);
  const kx = from.colsPerSec / to.colsPerSec;
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < b.cols; c++) tmp[r * b.cols + c] = sample((k) => src[r * a.cols + k], a.cols, c * kx, (c + 1) * kx);
  const out = new Float32Array(b.rows * b.cols);
  const ky = from.rowsPerSemi / to.rowsPerSemi;
  for (let r = 0; r < b.rows; r++) {
    const yc = (to.pLo + r / to.rowsPerSemi - from.pLo) * from.rowsPerSemi + 0.5; // centre in source row space / 원본 행 공간의 중심
    for (let c = 0; c < b.cols; c++) out[r * b.cols + c] = sample((k) => tmp[k * b.cols + c], a.rows, yc - ky / 2, yc + ky / 2);
  }
  return out;
}

// --------------------------------------------------------------------------
// Document / 문서
// --------------------------------------------------------------------------

const DEFAULT_TIMBRE = Object.freeze({ sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 });

function sanitizeTimbre(raw) {
  const out = {};
  for (const k of TIMBRE_WAVES) out[k] = clamp(fin(raw?.[k], DEFAULT_TIMBRE[k] ?? 0), 0, 1);
  const extras = timbreSpecExtras(raw);
  // one timbre serves a whole layer: the per-voice Sampler is not offered / 레이어 전체에 음색 하나 — 샘플러 없음
  return { ...out, mode: extras.mode === 'func' ? 'func' : 'mix', func: extras.func };
}

function sanitizeRaster(raw, shape, emptyOk = true) {
  const ok = raw && raw.enc === 'rle8' && typeof raw.data === 'string' && Number.isInteger(raw.rows) && Number.isInteger(raw.cols) && raw.rows > 0 && raw.cols > 0;
  if (!ok) return emptyOk ? emptyRaster(shape.rows, shape.cols) : null;
  if (raw.rows === shape.rows && raw.cols === shape.cols) return { enc: 'rle8', rows: raw.rows, cols: raw.cols, data: raw.data };
  // shape mismatch (hand-edited file): stretch onto the grid / 모양이 다르면 격자에 맞춰 늘림
  const fake = (s) => ({ pLo: 0, pHi: s.rows - 1, rowsPerSemi: 1, colsPerSec: s.cols, length: 1 });
  const src = decodeRaster(raw);
  const out = new Float32Array(shape.rows * shape.cols);
  for (let r = 0; r < shape.rows; r++) {
    const sr = Math.min(raw.rows - 1, Math.floor(((r + 0.5) / shape.rows) * raw.rows));
    for (let c = 0; c < shape.cols; c++) out[r * shape.cols + c] = src[sr * raw.cols + Math.min(raw.cols - 1, Math.floor(((c + 0.5) / shape.cols) * raw.cols))];
  }
  void fake;
  return encodeRaster(out, shape.rows, shape.cols);
}

/** A stack item with defaults. / 스택 항목 */
export function createStackItem(type, over = {}) {
  const fx = GridEffectRegistry.get(type);
  if (!fx) throw new RangeError(`createStackItem: unknown effect "${type}"`);
  return { id: over.id || `fx-${type}`, type, on: over.on ?? true, mix: over.mix ?? 1, mask: over.mask || 'none', params: sanitizeEffectParams(type, over.params) };
}

function sanitizeStack(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const matrix = [];
  const bank = new Map();
  for (const it of list) {
    const fx = GridEffectRegistry.get(it?.type);
    if (!fx) continue;
    let id = typeof it.id === 'string' && it.id ? it.id : `fx-${it.type}`;
    for (let n = 2; seen.has(id); n++) id = `fx-${it.type}-${n}`;
    seen.add(id);
    const item = { id, type: it.type, on: it.on !== false, mix: clamp(fin(it.mix, 1), 0, 1), mask: oneOf(it.mask, GRID_MASKS, 'none'), params: sanitizeEffectParams(it.type, it.params) };
    if (fx.domain === 'bank') { if (!bank.has(it.type)) bank.set(it.type, item); } else if (matrix.length < GRID_MAX_STACK) matrix.push(item);
  }
  // the output-stage effects always exist, once, last, in a fixed order / 출력 단계 효과는 항상 한 번씩, 맨 끝, 고정 순서
  for (const type of GRID_BANK_ORDER) matrix.push(bank.get(type) || createStackItem(type, { on: false }));
  return matrix;
}

export function createGridLayer(index, shape, over = {}) {
  return {
    id: over.id || `L${index + 1}`,
    name: over.name || `Layer ${index + 1}`,
    color: over.color || GRID_LAYER_COLORS[index % GRID_LAYER_COLORS.length],
    muted: false, solo: false, gain: 1, pan: 0,
    raster: over.raster || emptyRaster(shape.rows, shape.cols),
    maskRaster: null,
    timbre: sanitizeTimbre(over.timbre),
    stack: sanitizeStack(over.stack),
  };
}

function sanitizeLayer(raw, index, shape, ids) {
  let id = typeof raw?.id === 'string' && raw.id ? raw.id : `L${index + 1}`;
  for (let n = 1; ids.has(id); n++) id = `L${index + 1 + n}`;
  ids.add(id);
  return {
    id,
    name: typeof raw?.name === 'string' && raw.name ? raw.name.slice(0, 40) : `Layer ${index + 1}`,
    color: /^#[0-9a-fA-F]{6}$/.test(raw?.color || '') ? raw.color : GRID_LAYER_COLORS[index % GRID_LAYER_COLORS.length],
    muted: !!raw?.muted,
    solo: !!raw?.solo,
    gain: clamp(fin(raw?.gain, 1), 0, 2),
    pan: clamp(fin(raw?.pan, 0), -1, 1),
    raster: sanitizeRaster(raw?.raster, shape),
    maskRaster: sanitizeRaster(raw?.maskRaster, shape, false),
    timbre: sanitizeTimbre(raw?.timbre),
    stack: sanitizeStack(raw?.stack),
  };
}

function sanitizeGrid(raw) {
  const pLo = Math.round(clamp(fin(raw?.pLo, 36), 0, 115));
  const pHi = Math.round(clamp(fin(raw?.pHi, 96), pLo + 6, 127));
  const rowsPerSemi = oneOf(Math.round(fin(raw?.rowsPerSemi, 2)), GRID_ROWS_PER_SEMI, 2);
  const length = clamp(Math.round(fin(raw?.length, 16) * 4) / 4, 1, 120);
  let colsPerSec = Math.round(clamp(fin(raw?.colsPerSec, 8), 1, 64));
  const rows = (pHi - pLo) * rowsPerSemi + 1;
  while (colsPerSec > 1 && rows * Math.round(length * colsPerSec) > GRID_MAX_CELLS) colsPerSec--;
  return { pLo, pHi, rowsPerSemi, colsPerSec, length };
}

function sanitizeSelection(raw, shape) {
  const kind = oneOf(raw?.kind, ['none', ...GRID_SELECT_KINDS], 'none');
  const out = { kind, x0: 0, y0: 0, x1: 0, y1: 0, pts: [], feather: clamp(fin(raw?.feather, 0), 0, 40) };
  if (kind === 'none') return out;
  out.x0 = clamp(fin(raw.x0, 0), 0, shape.cols);
  out.x1 = clamp(fin(raw.x1, 0), 0, shape.cols);
  out.y0 = clamp(fin(raw.y0, 0), 0, shape.rows);
  out.y1 = clamp(fin(raw.y1, 0), 0, shape.rows);
  if (kind === 'lasso') {
    out.pts = (Array.isArray(raw.pts) ? raw.pts : []).slice(0, 400).map((q) => [Number(clamp(fin(q?.[0], 0), 0, shape.cols).toFixed(2)), Number(clamp(fin(q?.[1], 0), 0, shape.rows).toFixed(2))]);
    if (out.pts.length < 3) out.kind = 'none';
  } else if (Math.abs(out.x1 - out.x0) < 0.25 || Math.abs(out.y1 - out.y0) < 0.25) out.kind = 'none';
  return out;
}

const DEFAULT_TOOL = Object.freeze({
  id: 'brush', size: 1.5, hardness: 0.8, opacity: 1, flow: 1, value: 1, shape: 'round', symTime: false, symPitch: false, snap: true,
  threshold: 0.1, gradient: 'linear', select: 'rect', feather: 0, liq: 'push', liqSize: 8, liqStrength: 0.6, liqMomentum: 0,
  resample: 'area', importInvert: false, importTarget: 'new', shot: 'result',
});

function sanitizeTool(raw) {
  const d = DEFAULT_TOOL;
  return {
    id: oneOf(raw?.id, GRID_TOOLS, d.id),
    size: clamp(fin(raw?.size, d.size), 0.5, 60),
    hardness: clamp(fin(raw?.hardness, d.hardness), 0, 1),
    opacity: clamp(fin(raw?.opacity, d.opacity), 0.01, 1),
    flow: clamp(fin(raw?.flow, d.flow), 0.01, 1),
    value: clamp(fin(raw?.value, d.value), 0, 1),
    shape: oneOf(raw?.shape, ['round', 'square'], d.shape),
    symTime: !!raw?.symTime,
    symPitch: !!raw?.symPitch,
    snap: raw?.snap !== false,
    threshold: clamp(fin(raw?.threshold, d.threshold), 0, 1),
    gradient: oneOf(raw?.gradient, ['linear', 'radial'], d.gradient),
    select: oneOf(raw?.select, GRID_SELECT_KINDS, d.select),
    feather: clamp(fin(raw?.feather, d.feather), 0, 40),
    liq: oneOf(raw?.liq, ['push', 'twirlCW', 'twirlCCW', 'pinch', 'bloat', 'smooth', 'reconstruct'], d.liq),
    liqSize: clamp(fin(raw?.liqSize, d.liqSize), 1, 80),
    liqStrength: clamp(fin(raw?.liqStrength, d.liqStrength), 0.01, 1),
    liqMomentum: clamp(fin(raw?.liqMomentum, d.liqMomentum), 0, 0.95),
    resample: oneOf(raw?.resample, ['area', 'nearest'], d.resample),
    importInvert: !!raw?.importInvert,
    importTarget: oneOf(raw?.importTarget, ['new', 'active'], d.importTarget),
    shot: oneOf(raw?.shot, ['result', 'editor', 'both'], d.shot),
  };
}

/** View that shows the whole piece and range. / 전체가 보이는 뷰 */
export function fitGridView(grid) {
  return { tMin: Number((-0.02 * grid.length).toFixed(3)), tMax: Number((grid.length * 1.02).toFixed(3)), midiMin: grid.pLo - 2, midiMax: grid.pHi + 2 };
}

function sanitizeView(raw, grid) {
  const fit = fitGridView(grid);
  const tMin = fin(raw?.tMin, fit.tMin);
  const tMax = Math.max(tMin + 0.25, fin(raw?.tMax, fit.tMax));
  const midiMin = fin(raw?.midiMin, fit.midiMin);
  const midiMax = Math.max(midiMin + 3, fin(raw?.midiMax, fit.midiMax));
  return {
    tMin, tMax, midiMin, midiMax,
    colorE: oneOf(raw?.colorE, GRID_COLORMAPS, 'layer'),
    colorR: oneOf(raw?.colorR, GRID_COLORMAPS, 'heat'),
    showGrid: raw?.showGrid !== false,
    showMesh: !!raw?.showMesh,
    showEvents: raw?.showEvents !== false,
    showChroma: raw?.showChroma !== false,
    showMask: raw?.showMask !== false,
  };
}

function sanitizeRender(raw) {
  return {
    binsPerSemi: oneOf(Math.round(fin(raw?.binsPerSemi, 8)), GRID_BINS, 8),
    frameRate: Math.round(clamp(fin(raw?.frameRate, 200), 50, 400) / 50) * 50,
    quality: oneOf(raw?.quality, GRID_QUALITIES, 'normal'),
    maxActive: Math.round(clamp(fin(raw?.maxActive, 600), 16, 2000)),
    seed: Math.round(clamp(fin(raw?.seed, 1), 0, 999999)),
    edgeMs: clamp(fin(raw?.edgeMs, 8), 0, 60),
    gainDb: clamp(fin(raw?.gainDb, 0), -24, 12),
  };
}

/** Normalise any stored document into full, safe params (idempotent). / 문서 정규화 (멱등) */
export function sanitizeGridParams(raw) {
  const grid = sanitizeGrid(raw?.grid);
  const shape = gridShape(grid);
  const ids = new Set();
  let layers = (Array.isArray(raw?.layers) ? raw.layers : []).slice(0, GRID_MAX_LAYERS).map((l, i) => sanitizeLayer(l, i, shape, ids));
  if (!layers.length) layers = [createGridLayer(0, shape)];
  const out = {
    preset: typeof raw?.preset === 'string' ? raw.preset : '',
    grid,
    render: sanitizeRender(raw?.render),
    layers,
    activeLayerId: layers.some((l) => l.id === raw?.activeLayerId) ? raw.activeLayerId : layers[0].id,
    selection: sanitizeSelection(raw?.selection, shape),
    view: sanitizeView(raw?.view, grid),
    tool: sanitizeTool(raw?.tool),
    tremolo: normalizeTremolo(raw?.tremolo),
  };
  if (raw?.voiceMod) out.voiceMod = deepClone(raw.voiceMod); // kept untouched (the per-voice rack is off here) / 그대로 보존
  return out;
}

/** Layers that sound (solo wins over mute). / 소리 나는 레이어 */
export function audibleLayers(doc) {
  const solo = doc.layers.some((l) => l.solo);
  return doc.layers.filter((l) => (solo ? l.solo : !l.muted) && l.gain > 0);
}

export const activeLayer = (doc) => doc.layers.find((l) => l.id === doc.activeLayerId) || doc.layers[0];
export const matrixItems = (layer) => layer.stack.filter((it) => GridEffectRegistry.get(it.type)?.domain === 'matrix');
export const bankItem = (layer, type) => layer.stack.find((it) => it.type === type) || null;

/**
 * Change the grid (range, resolution, length) and resample every raster onto it, so the sounds stay
 * at their time and pitch. `fn(grid)` mutates a draft grid. Mutates `doc`.
 * 격자 변경 + 모든 래스터 리샘플 (소리의 시간·음고 위치 유지).
 */
export function regridDocument(doc, fn) {
  const from = { ...doc.grid };
  const draft = { ...doc.grid };
  fn(draft);
  const to = sanitizeGrid(draft);
  const a = gridShape(from);
  const b = gridShape(to);
  const mode = doc.tool?.resample || 'area';
  const conv = (ras) => encodeRaster(regridRaster(decodeRaster(ras), from, to, mode), b.rows, b.cols);
  for (const l of doc.layers) {
    l.raster = conv(l.raster);
    if (l.maskRaster) l.maskRaster = conv(l.maskRaster);
    // Liquify strokes live in cell space: rescale them / 리퀴파이 스트로크는 셀 공간 좌표 → 함께 변환
    for (const it of l.stack) {
      if (it.type !== 'liquify') continue;
      const sx = to.colsPerSec / from.colsPerSec;
      const sy = to.rowsPerSemi / from.rowsPerSemi;
      const oy = (from.pLo - to.pLo) * to.rowsPerSemi;
      for (const op of it.params.ops) {
        op.size *= Math.sqrt(sx * sy);
        op.pts = op.pts.map(([x, y]) => [x * sx, (y - 0.5) * sy + oy + 0.5]);
      }
    }
  }
  if (doc.selection.kind !== 'none') doc.selection = { kind: 'none', x0: 0, y0: 0, x1: 0, y1: 0, pts: [], feather: doc.selection.feather };
  doc.grid = to;
  Object.assign(doc.view, fitGridView(to));
  void a;
  return doc;
}

// --------------------------------------------------------------------------
// Fine matrix / 미세 행렬
// --------------------------------------------------------------------------

/**
 * Matrix dimensions actually used: the document's render settings, scaled by the quality, then
 * halved (frame rate first, bin density second) until frames × bins fits the quality's budget —
 * so a long piece or a wide range never exceeds the memory bound. preview = drag resolution.
 * 실제 행렬 크기: 품질 배율 적용 후 예산에 들어올 때까지 프레임율 → 빈 밀도 순으로 절반씩 낮춤.
 */
export function gridDims(doc, { preview = false } = {}) {
  const g = doc.grid;
  const r = doc.render;
  let bps = r.binsPerSemi;
  let rate = r.frameRate;
  if (r.quality === 'draft') { bps = Math.max(2, Math.round(bps / 4)); rate = Math.max(25, rate / 4); }
  else if (r.quality === 'high') rate = Math.min(400, rate * 2);
  const wanted = `${bps}@${rate}`;
  if (preview) { bps = Math.max(2, Math.round(bps / 2)); rate = Math.max(25, rate / 4); }
  const span = g.pHi - g.pLo;
  const budget = preview ? CELL_BUDGET.preview : CELL_BUDGET[r.quality];
  const cells = () => (span * bps + 1) * Math.round(g.length * rate);
  for (let guard = 0; guard < 12 && cells() > budget; guard++) {
    if (rate > 50) rate /= 2;
    else if (bps > 2) bps = Math.max(2, Math.round(bps / 2));
    else if (rate > 12.5) rate /= 2;
    else break;
  }
  const N = span * bps + 1;
  const F = Math.max(2, Math.round(g.length * rate));
  return { N, F, rate, bps, pLo: g.pLo, pHi: g.pHi, length: g.length, downgraded: !preview && wanted !== `${bps}@${rate}`, key: `${N}x${F}@${rate}|${g.pLo}|${bps}` };
}

/**
 * Raster → fine matrix. Pitch: row r sits exactly on the bin of its pitch (one sine per painted row —
 * a painted row is a pure tone; a thick stroke is a cluster of rows). A row between two bins is split
 * power-preservingly. Time: a column is held for 1 / colsPerSec s and cross-faded into its neighbours
 * over `edgeMs` (no step, so no click).
 * 래스터 → 미세 행렬. 음고: 행 하나 = 그 음고의 빈 하나(순음). 시간: 열을 유지하고 이웃 열과 edgeMs 동안 교차 페이드.
 */
export function rasterToMatrix(ras, shape, grid, dims, edgeMs = 8) {
  const { N, F, rate, bps } = dims;
  const { rows, cols } = shape;
  const out = new Float32Array(F * N);
  const i0 = new Int32Array(rows);
  const w0 = new Float32Array(rows);
  const w1 = new Float32Array(rows);
  const live = [];
  for (let r = 0; r < rows; r++) {
    let any = false;
    for (let c = 0; c < cols; c++) if (ras[r * cols + c] > 0) { any = true; break; }
    if (!any) continue;
    const pos = (r * bps) / grid.rowsPerSemi;
    const k = Math.min(N - 1, Math.floor(pos + 1e-9));
    const fr = pos - k;
    i0[r] = k;
    if (fr < 1e-6 || k >= N - 1) { w0[r] = 1; w1[r] = 0; } else { w0[r] = Math.sqrt(1 - fr); w1[r] = Math.sqrt(fr); }
    live.push(r);
  }
  const e = clamp((edgeMs / 1000) * grid.colsPerSec, 0, 1);
  for (let f = 0; f < F; f++) {
    const u = (f / rate) * grid.colsPerSec;
    const c = Math.min(cols - 1, Math.floor(u + 1e-9));
    const fr = u - c;
    let cA = c;
    let cB = c;
    let w = 0;
    if (e > 0) {
      if (fr < e / 2 && c > 0) { cA = c - 1; w = 0.5 + fr / e; } else if (fr > 1 - e / 2 && c < cols - 1) { cB = c + 1; w = (fr - (1 - e / 2)) / e; }
    }
    const o = f * N;
    for (let q = 0; q < live.length; q++) {
      const r = live[q];
      const v = w > 0 ? ras[r * cols + cA] * (1 - w) + ras[r * cols + cB] * w : ras[r * cols + c];
      if (v <= 0) continue;
      out[o + i0[r]] += v * w0[r];
      if (w1[r] > 0) out[o + i0[r] + 1] += v * w1[r];
    }
  }
  return out;
}

/** A cell-space coverage (rows × cols, 0..1) sampled bilinearly at every matrix element. / 셀 커버리지 → 행렬 마스크 */
export function coverageToMatrix(cov, shape, grid, dims) {
  const { N, F, rate, bps } = dims;
  const { rows, cols } = shape;
  const out = new Float32Array(F * N);
  const r0 = new Int32Array(N);
  const ay = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const y = clamp((i / bps) * grid.rowsPerSemi, 0, rows - 1);
    r0[i] = Math.min(rows - 2 < 0 ? 0 : rows - 2, Math.floor(y));
    ay[i] = y - r0[i];
  }
  for (let f = 0; f < F; f++) {
    const x = clamp((f / rate) * grid.colsPerSec - 0.5, 0, cols - 1);
    const c0 = Math.min(Math.max(0, cols - 2), Math.floor(x));
    const ax = x - c0;
    const c1 = Math.min(cols - 1, c0 + 1);
    for (let i = 0; i < N; i++) {
      const ra = r0[i] * cols;
      const rb = Math.min(rows - 1, r0[i] + 1) * cols;
      out[f * N + i] = (cov[ra + c0] * (1 - ax) + cov[ra + c1] * ax) * (1 - ay[i]) + (cov[rb + c0] * (1 - ax) + cov[rb + c1] * ax) * ay[i];
    }
  }
  return out;
}

const selCache = new Map();

/** Coverage (rows × cols) of the selection, feathered; null = no selection. Cached. / 선택 영역 커버리지 */
export function selectionCoverage(sel, shape) {
  if (!sel || sel.kind === 'none') return null;
  const key = `${shape.rows}x${shape.cols}|${JSON.stringify(sel)}`;
  let cov = selCache.get(key);
  if (cov) return cov;
  const { rows, cols } = shape;
  cov = sel.kind === 'rect' ? rectCoverage(rows, cols, sel.x0, sel.y0, sel.x1, sel.y1)
    : sel.kind === 'ellipse' ? ellipseCoverage(rows, cols, sel.x0, sel.y0, sel.x1, sel.y1)
      : polygonCoverage(rows, cols, sel.pts);
  if (sel.feather > 0) featherCoverage(cov, rows, cols, sel.feather);
  if (selCache.size > 8) selCache.delete(selCache.keys().next().value);
  selCache.set(key, cov);
  return cov;
}

// --------------------------------------------------------------------------
// Pipeline + stage cache / 파이프라인과 단계 캐시
// --------------------------------------------------------------------------

/** A stage is skipped (exact identity, nothing computed) when it is off or mixed to 0. / 꺼진 효과 = 항등 */
const stageActive = (it) => it.on && it.mix > 0;
const SALT = { blur: 11, glitch: 23, halftone: 37, liquify: 41, noise: 53 };

/**
 * Keys of every stage of a document at given dimensions (no matrix work): per layer the base key and
 * the chained stage keys. The overall signature identifies the processed result.
 * 문서의 모든 단계 키 (행렬 연산 없음). 전체 시그니처 = 처리 결과의 식별값.
 */
export function planStages(doc, dims) {
  const shape = gridShape(doc.grid);
  const selKey = doc.selection.kind === 'none' ? '' : hashString(JSON.stringify(doc.selection));
  const layers = doc.layers.map((layer, li) => {
    const baseKey = hashString(`${dims.key}|${doc.render.edgeMs}|${doc.grid.colsPerSec}|${doc.grid.rowsPerSemi}|${layer.raster.rows}x${layer.raster.cols}|${layer.raster.data}`);
    let prev = baseKey;
    const stages = [];
    layer.stack.forEach((it, idx) => {
      const fx = GridEffectRegistry.get(it.type);
      if (!fx || !stageActive(it)) return;
      if (fx.domain === 'bank' && !(fx.matrix && it.type === 'noise' && it.params.grain > 0)) return;
      const maskKey = it.mask === 'selection' ? selKey : it.mask === 'layerMask' && layer.maskRaster ? hashString(layer.maskRaster.data) : '';
      const seed = (doc.render.seed * 9973 + (SALT[it.type] || 7) + idx * 131 + li * 1009) >>> 0;
      prev = hashString(`${prev}>${it.type}|${it.mix}|${maskKey ? it.mask : 'none'}|${maskKey}|${seed}|${JSON.stringify(it.params)}`);
      stages.push({ it, fx, key: prev, seed, masked: !!maskKey });
    });
    return { layer, baseKey, stages, finalKey: prev };
  });
  return { shape, layers, sig: `${dims.key}#${layers.map((l) => `${l.layer.id}:${l.finalKey}`).join(',')}` };
}

/** Signature of the processed result of a document (cheap; memoised per document object). / 결과 시그니처 */
const sigMemo = new WeakMap();
export function gridSignature(doc, { preview = false } = {}) {
  let m = sigMemo.get(doc);
  if (!m) { m = {}; sigMemo.set(doc, m); }
  const k = preview ? 'p' : 'f';
  if (!m[k]) m[k] = planStages(doc, gridDims(doc, { preview })).sig;
  return m[k];
}

const caches = new Map(); // namespace → { layers: Map(layerId → { baseKey, base, stages: [{ key, M, info }] }), last }
let bakeCount = 0;
let lastStats = { recomputed: 0, total: 0, ms: 0, sig: '' };

const cacheOf = (ns) => {
  let c = caches.get(ns);
  if (!c) { c = { layers: new Map(), last: null }; caches.set(ns, c); }
  return c;
};

/** Scratch matrices for the temporaries of one effect run (the stage results themselves are never reused). */
function scratchPool(size) {
  const free = [];
  return {
    alloc() { const a = free.pop() || new Float32Array(size); a.fill(0); return a; },
    free(a) { if (a && a.length === size && free.length < 4) free.push(a); },
  };
}

function runStage(st, src, doc, layer, dims, shape, pool) {
  const { N, F, rate, bps, pLo } = dims;
  const dst = new Float32Array(F * N);
  const info = {};
  const ctx = { src, dst, N, F, rate, bps, pLo, grid: { rowsPerSemi: doc.grid.rowsPerSemi, colsPerSec: doc.grid.colsPerSec, rows: shape.rows, cols: shape.cols }, seed: st.seed, p: st.it.params, alloc: pool.alloc, free: pool.free, info };
  if (st.fx.domain === 'bank') st.fx.matrix(ctx);
  else st.fx.apply(ctx);
  let mask = null;
  if (st.masked) {
    const cov = st.it.mask === 'selection' ? selectionCoverage(doc.selection, shape) : decodeRaster(layer.maskRaster);
    if (cov) mask = coverageToMatrix(cov, shape, doc.grid, dims);
  }
  const mix = st.it.mix;
  if (mix < 1 || mask) for (let j = 0; j < dst.length; j++) dst[j] = src[j] + (dst[j] - src[j]) * mix * (mask ? mask[j] : 1);
  return { key: st.key, M: dst, info };
}

function* bakeSteps(doc, ns, preview) {
  const t0 = (globalThis.performance || Date).now();
  const dims = gridDims(doc, { preview });
  const plan = planStages(doc, dims);
  const cache = cacheOf(ns);
  if (cache.last && cache.last.sig === plan.sig) return cache.last;
  const pool = scratchPool(dims.F * dims.N);
  let recomputed = 0;
  let total = 0;
  const mats = new Map();
  for (const pl of plan.layers) {
    let entry = cache.layers.get(pl.layer.id);
    if (!entry) { entry = { baseKey: '', base: null, stages: [] }; cache.layers.set(pl.layer.id, entry); }
    total++;
    if (entry.baseKey !== pl.baseKey) {
      entry.base = rasterToMatrix(decodeRaster(pl.layer.raster), plan.shape, doc.grid, dims, doc.render.edgeMs);
      entry.baseKey = pl.baseKey;
      entry.stages = [];
      recomputed++;
      yield;
    }
    let M = entry.base;
    const infos = [];
    for (let s = 0; s < pl.stages.length; s++) {
      const st = pl.stages[s];
      total++;
      if (!entry.stages[s] || entry.stages[s].key !== st.key) {
        entry.stages.length = s; // this stage and everything after it is stale / 이 단계부터 뒤는 무효
        entry.stages[s] = runStage(st, M, doc, pl.layer, dims, plan.shape, pool);
        recomputed++;
        yield;
      }
      M = entry.stages[s].M;
      infos.push({ id: st.it.id, type: st.it.type, info: entry.stages[s].info });
    }
    entry.stages.length = pl.stages.length;
    mats.set(pl.layer.id, { M, key: pl.finalKey, infos });
  }
  for (const id of [...cache.layers.keys()]) if (!mats.has(id)) cache.layers.delete(id);
  const ms = (globalThis.performance || Date).now() - t0;
  const result = { sig: plan.sig, dims, shape: plan.shape, mats, preview, stats: { recomputed, total, ms } };
  cache.last = result;
  if (ns === 'edit') { if (recomputed) bakeCount++; lastStats = { recomputed, total, ms, sig: plan.sig }; }
  return result;
}

/**
 * Bake the document: every layer's processed matrix. Memoised by signature (same signature → the same
 * result object), stage by stage. ns: 'edit' (the editor's full-resolution bake, counted),
 * 'preview' (drag resolution), 'detached' (documents that are not on screen: Manager instances).
 * 문서 베이킹 (레이어별 처리된 행렬). 시그니처로 메모이즈, 단계별 캐시.
 * @returns {{ sig, dims, shape, mats: Map<string, { M: Float32Array, key: string, infos: object[] }>, preview, stats }}
 */
export function bakeGrid(doc, { ns = 'edit', preview = ns === 'preview' } = {}) {
  const it = bakeSteps(doc, ns, preview);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}

/**
 * The same bake in slices: after every stage the event loop may run (≥ 10 ms of work between two
 * pauses). Resolves null when `shouldAbort()` says the document moved on — the finished stages stay
 * cached. / 같은 베이킹을 조각으로 실행 (단계마다 이벤트 루프에 양보). 중단되면 null, 끝난 단계는 캐시에 남음.
 */
export async function bakeGridAsync(doc, { ns = 'edit', preview = false, shouldAbort = null } = {}) {
  const it = bakeSteps(doc, ns, preview);
  let last = (globalThis.performance || Date).now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    const now = (globalThis.performance || Date).now();
    if (now - last >= 10) {
      await new Promise((res) => setTimeout(res, 0));
      if (shouldAbort && shouldAbort()) return null;
      last = (globalThis.performance || Date).now();
    }
  }
}

/** The cached full-resolution result if it matches the document, else null (never computes). / 캐시된 결과 (없으면 null) */
export function peekGridBake(doc, ns = 'edit') {
  const last = caches.get(ns)?.last;
  return last && last.sig === gridSignature(doc, { preview: ns === 'preview' }) ? last : null;
}

/** Full-resolution bakes of the editor document that computed at least one stage. / 실제로 계산이 일어난 베이킹 횟수 */
export const getGridBakeCount = () => bakeCount;
export const getGridBakeStats = () => ({ ...lastStats });

/** Run fn with empty caches and counters, then restore them (self-checks). / 캐시를 비운 상태로 실행 후 복원 */
export function withIsolatedGridCache(fn) {
  const saved = new Map(caches);
  const c = bakeCount;
  const s = lastStats;
  caches.clear();
  try { return fn(); } finally {
    caches.clear();
    for (const [k, v] of saved) caches.set(k, v);
    bakeCount = c;
    lastStats = s;
  }
}

/** Largest amplitude of every bin over the whole matrix (memoised on the bake). / 빈별 최대 진폭 */
export function layerBinMax(bake, layerId) {
  const m = bake.mats.get(layerId);
  if (!m) return null;
  if (!m.binMax) {
    const { N, F } = bake.dims;
    const mx = new Float32Array(N);
    for (let f = 0; f < F; f++) {
      const o = f * N;
      for (let i = 0; i < N; i++) if (m.M[o + i] > mx[i]) mx[i] = m.M[o + i];
    }
    m.binMax = mx;
  }
  return m.binMax;
}

/**
 * Level profile of a layer: per analysed frame (every 4th) the sum of its amplitudes (the worst case
 * when all partials are in phase) and the sum of their squares (their power). Memoised on the bake.
 * 레이어의 레벨 프로필: 분석 프레임마다 진폭 합(위상이 모두 맞을 때의 최악)과 제곱 합(파워). 베이킹에 메모이즈.
 */
export function layerLevelProfile(bake, layerId) {
  const m = bake.mats.get(layerId);
  if (!m) return null;
  if (!m.level) {
    const { N, F } = bake.dims;
    const step = 4;
    const n = Math.ceil(F / step);
    const s1 = new Float32Array(n);
    const s2 = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const o = k * step * N;
      let a = 0;
      let b = 0;
      for (let i = 0; i < N; i++) { const v = m.M[o + i]; if (v > 0) { a += v; b += v * v; } }
      s1[k] = a;
      s2[k] = b;
    }
    m.level = { s1, s2, step };
  }
  return m.level;
}

/**
 * Peak estimate of a voice set per unit of bank scale: per frame min(Σ a·g, 3·√Σ (a·g)²) — few
 * partials can line up (linear sum), many behave like noise (3 × RMS) — maximised over the piece and
 * the two channels. / 뱅크 스케일 1당 피크 추정: 프레임별 min(선형 합, 3 × RMS)의 최댓값
 */
export function estimatePeak(bake, voices, layers) {
  let worst = 0;
  const prof = layers.map((l) => layerLevelProfile(bake, l.id));
  const n = prof.reduce((mx, p) => Math.max(mx, p ? p.s1.length : 0), 0);
  for (let k = 0; k < n; k++) {
    for (const side of ['gl', 'gr']) {
      let lin = 0;
      let pow = 0;
      for (const v of voices) {
        const p = prof[v.layer];
        if (!p) continue;
        lin += v[side] * p.s1[k];
        pow += v[side] * v[side] * p.s2[k];
      }
      const est = Math.min(lin, 3 * Math.sqrt(pow));
      if (est > worst) worst = est;
    }
  }
  return worst;
}

// --------------------------------------------------------------------------
// Synthesis plan (pure part): voices = layer × chromatic channel / 합성 계획: 보이스 = 레이어 × 크로매틱 채널
// --------------------------------------------------------------------------

/** Equal-power pan, centre = 1 on both sides. / 등전력 팬 (가운데 = 양쪽 1) */
export function panGains(pan) {
  const th = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return { l: Math.SQRT2 * Math.cos(th), r: Math.SQRT2 * Math.sin(th) };
}

/**
 * What the bank plays: one voice per audible layer × chromatic channel (the same matrix, another
 * frequency table), plus one noise bus per layer.
 * 뱅크가 연주할 것: 들리는 레이어 × 크로매틱 채널마다 보이스 하나(같은 행렬, 다른 주파수 표) + 레이어별 노이즈 버스.
 */
export function planVoices(doc, dims) {
  const layers = [];
  const voices = [];
  for (const layer of audibleLayers(doc)) {
    const noiseIt = bankItem(layer, 'noise');
    const chromaIt = bankItem(layer, 'chroma');
    const noise = noiseIt && stageActive(noiseIt) ? GridEffectRegistry.get('noise').bank(noiseIt.params, { seed: doc.render.seed }).noise : null;
    const channels = chromaIt && chromaIt.on ? GridEffectRegistry.get('chroma').bank(chromaIt.params).channels : [{ ch: 'g', ratio: 1, semis: 0, gain: 1, timeMs: 0, pan: 0, wave: 'layer', harmonics: 1 }];
    const li = layers.length;
    const lp = panGains(layer.pan);
    layers.push({ id: layer.id, gl: lp.l * layer.gain, gr: lp.r * layer.gain, noise: noise && noise.floor > 0 ? { floor: noise.floor * (noiseIt.mix ?? 1), slope: noise.slope, seed: noise.seed + li * 17 } : null });
    for (const c of channels) {
      const g = panGains(layer.pan + c.pan);
      voices.push({
        layer: li, layerId: layer.id, ch: c.ch, ratio: c.ratio, semis: c.semis,
        gl: g.l * layer.gain * c.gain, gr: g.r * layer.gain * c.gain,
        offFrames: -(c.timeMs / 1000) * dims.rate, // positive timeMs = later: the matrix is read earlier / 양수 = 늦게
        wave: c.wave === 'layer' ? { kind: 'layer', timbre: layer.timbre } : { kind: c.wave, harmonics: c.harmonics },
        n: noise ? noise.n * (noiseIt.mix ?? 1) : 0,
        bandCents: noise ? noise.bandCents : 40,
      });
    }
  }
  return { layers, voices };
}

// --------------------------------------------------------------------------
// Presets / 프리셋
// --------------------------------------------------------------------------

/** Demo picture: three held notes and one glide. / 데모 그림: 지속음 셋과 글리산도 하나 */
function demoRaster(grid) {
  const { rows, cols } = gridShape(grid);
  const ras = new Float32Array(rows * cols);
  const row = (midi) => (midi - grid.pLo) * grid.rowsPerSemi + 0.5;
  const col = (sec) => sec * grid.colsPerSec;
  paintLine(ras, rows, cols, col(0.5), row(48), col(7), row(48), 0.9);
  paintLine(ras, rows, cols, col(3), row(55), col(11), row(55), 0.8);
  paintLine(ras, rows, cols, col(6), row(64), col(12), row(72), 1);
  paintLine(ras, rows, cols, col(10), row(69), col(15.5), row(69), 0.85);
  return encodeRaster(ras, rows, cols);
}

let defaultMemo = null;

/** Default document = the "Pure Lines" preset. A fresh object every call; the raster is built once. */
export function createDefaultGridParams() {
  if (!defaultMemo) {
    const grid = sanitizeGrid(null);
    const shape = gridShape(grid);
    defaultMemo = JSON.stringify(sanitizeGridParams({ preset: 'pureLines', grid, layers: [createGridLayer(0, shape, { raster: demoRaster(grid) })] }));
  }
  return JSON.parse(defaultMemo);
}

/** Sine-shaped curvature as Liquify push strokes. / 사인 모양 곡률 (리퀴파이 푸시 스트로크) */
function wavyOps(grid) {
  const { rows, cols } = gridShape(grid);
  const ops = [];
  for (let k = 0; k < 8; k++) {
    const x = (cols * (k + 0.5)) / 8;
    const dir = k % 2 ? -1 : 1;
    ops.push({ tool: 'push', size: cols / 14, strength: 0.9, momentum: 0, pts: [[x, rows / 2], [x, rows / 2 + dir * 10]] });
  }
  return ops;
}

export function createGridPreset(id) {
  const doc = createDefaultGridParams();
  const layer = doc.layers[0];
  const fx = (type, params = {}, over = {}) => createStackItem(type, { params, ...over });
  const stack = {
    pureLines: [],
    chorusCloud: [fx('blur', { mode: 'gaussian', sigmaCents: 60, sigmaMs: 0, shimmer: 0.6 })],
    smear: [fx('blur', { mode: 'motion', lengthMs: 700, lengthSemi: 5, trail: 'after' })],
    focusPull: [fx('blur', { mode: 'perspective', shape: 'radial', t0: 0.5, p0: 0.5, inner: 0.12, falloff: 1.2, maxCents: 220, maxMs: 80, shimmer: 0.5 })],
    breath: [fx('noise', { levelDb: -2, slope: -3, follow: 0.7, bandCents: 60, grain: 0.2 })],
    stutter: [fx('glitch', { rate: 8, jump: 'toPainted', durMin: 20, durMax: 60, rangeSemi: 36, stutter: 2 })],
    dottedLight: [fx('halftone', { periodMs: 140, dutyFrom: 'fixed', duty: 0.45, jitter: 0.6, silenceJitter: 0.6, scope: 'perBand', bandSemi: 6, shape: 'round' })],
    fifthShimmer: [fx('chroma', {})],
    wavy: [fx('liquify', { amount: 1, lockTime: true, jacobian: true, ops: wavyOps(doc.grid) })],
    everything: [
      fx('liquify', { amount: 0.5, lockTime: true, ops: wavyOps(doc.grid) }),
      fx('blur', { mode: 'gaussian', sigmaCents: 25, sigmaMs: 10, shimmer: 0.3 }, { mix: 0.6 }),
      fx('glitch', { rate: 2, jump: 'interval', rangeSemi: 12 }),
      fx('halftone', { periodMs: 180, duty: 0.7, jitter: 0.3, dropout: 0.05 }, { mix: 0.5 }),
      fx('noise', { levelDb: -34, slope: -3, follow: 0.3, grain: 0.1 }),
      fx('chroma', { rGain: 0.35, bGain: 0.35 }),
    ],
  }[id];
  if (!stack) return doc;
  layer.stack = sanitizeStack(stack);
  doc.preset = id;
  return sanitizeGridParams(doc);
}

export { liquifyMesh };
