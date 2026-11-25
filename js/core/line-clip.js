/**
 * Flexatone — core/line-clip.js
 * Layer 0 (core, pure): the play range of a line inside its own curve, trimming / extending along
 * the curve's shape, splitting a line into pieces, and the link that keeps those pieces in sync.
 * 계층 0 (core, 순수): 곡선 안에서 실제로 재생하는 구간, 곡선 모양을 따라 줄이기·늘리기, 선 자르기,
 * 잘린 조각들의 곡선 동기화 링크.
 *
 * A line (Glissando voice, or any voice-shaped object of another studio) is a curve over the
 * parameter u ∈ [0, 1] laid out over its time span. `clip = { u0, u1, ext }` says which part of
 * that curve sounds: the line's own startTime / duration are the *played* span, and u runs from
 * u0 (at startTime) to u1 (at startTime + duration). Without `clip` (or with 0 → 1) nothing changes.
 *   u0 > 0 / u1 < 1   trimmed: the rest of the curve is not played (drawn faint in the monitor)
 *   u0 < 0 / u1 > 1   extended past the curve's ends: ext 'shape' continues the engine's own
 *                     formula where it is defined beyond 0…1 (else the tangent), ext 'tangent'
 *                     continues in a straight line with the end slope.
 * 선은 매개변수 u ∈ [0, 1] 위의 곡선. clip = { u0, u1, ext }는 그중 소리 나는 부분이며, 선 자체의
 * startTime / duration은 *재생* 구간이다. u0 > 0 / u1 < 1은 잘라낸 것(모니터에 연하게), u0 < 0 / u1 > 1은
 * 곡선 끝 너머로 늘린 것 (ext 'shape' = 엔진 수식 그대로 이어감, 'tangent' = 끝 기울기로 직선 연장).
 *
 * `link = { id, on }`: pieces cut from one line share the id. While `on`, a change of the curve
 * shape of one piece is copied to the others (each keeps its own play range and place in time);
 * `on: false` treats the piece as a separate line. / 같은 선에서 잘린 조각은 id를 공유. on이면 곡선
 * 모양 변경이 다른 조각에 복사되고 (재생 구간·시간 위치는 각자), off면 별개의 선.
 *
 * Imports: core/math-utils.js only.
 */

import { clamp, deepClone, roundTo } from './math-utils.js';

export const CLIP_EXT_MODES = Object.freeze(['shape', 'tangent']);
/** How far a line may be extended past its curve (in curve lengths). / 최대 연장 범위 */
export const CLIP_U_MIN = -3;
export const CLIP_U_MAX = 4;
const MIN_SPAN_U = 0.002;

/** Clean a clip read from a file; null when it is the whole curve or invalid. / 클립 정규화 */
export function normalizeClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let u0 = Number(raw.u0);
  let u1 = Number(raw.u1);
  if (!Number.isFinite(u0)) u0 = 0;
  if (!Number.isFinite(u1)) u1 = 1;
  u0 = clamp(u0, CLIP_U_MIN, CLIP_U_MAX - MIN_SPAN_U);
  u1 = clamp(u1, u0 + MIN_SPAN_U, CLIP_U_MAX);
  const ext = CLIP_EXT_MODES.includes(raw.ext) ? raw.ext : 'shape';
  if (Math.abs(u0) < 1e-9 && Math.abs(u1 - 1) < 1e-9 && ext === 'shape') return null;
  return { u0: roundTo(u0, 6), u1: roundTo(u1, 6), ext };
}

/** The clip of a line with defaults (whole curve). / 기본값을 채운 클립 */
export function clipOf(v) {
  const c = v && v.clip;
  if (!c) return { u0: 0, u1: 1, ext: 'shape' };
  return { u0: Number.isFinite(c.u0) ? c.u0 : 0, u1: Number.isFinite(c.u1) ? c.u1 : 1, ext: c.ext === 'tangent' ? 'tangent' : 'shape' };
}

/** True when only part of the curve sounds, or it is extended. / 잘렸거나 늘린 선 */
export function isClipped(v) {
  const c = clipOf(v);
  return Math.abs(c.u0) > 1e-9 || Math.abs(c.u1 - 1) > 1e-9;
}

/** Played normalized time (0…1 over startTime → end) → curve parameter u. / 재생 시간 → 곡선 u */
export function clipTnToU(v, tn) {
  const c = v && v.clip;
  const t = clamp(Number.isFinite(tn) ? tn : 0, 0, 1);
  if (!c) return t;
  const u0 = Number.isFinite(c.u0) ? c.u0 : 0;
  const u1 = Number.isFinite(c.u1) ? c.u1 : 1;
  return u0 + t * (u1 - u0);
}

/**
 * Where the whole curve (u = 0 → 1) lies in time. / 곡선 전체(u 0 → 1)의 시간 위치
 * @returns {{ start: number, dur: number, u0: number, u1: number, ext: string }}
 */
export function clipFullSpan(v) {
  const c = clipOf(v);
  const dur = Math.max(1e-9, Number(v.duration) || 0) / Math.max(MIN_SPAN_U, c.u1 - c.u0);
  return { start: (Number(v.startTime) || 0) - c.u0 * dur, dur, ...c };
}

/** Document second of curve parameter u. / 곡선 u의 시각 */
export function clipUToSec(v, u) {
  const f = clipFullSpan(v);
  return f.start + u * f.dur;
}

/** Curve parameter u at a document second. / 시각의 곡선 u */
export function clipSecToU(v, sec) {
  const f = clipFullSpan(v);
  return (sec - f.start) / f.dur;
}

/** Write a clip back, dropping it when it is the whole curve. / 클립 저장 (전체 곡선이면 삭제) */
function setClip(v, u0, u1, ext) {
  const c = normalizeClip({ u0, u1, ext });
  if (c) v.clip = c;
  else delete v.clip;
}

/**
 * Trim / extend one end of a line along its curve (Locate ⌘ + drag): the curve stays where it is
 * in time and pitch, only the played part moves. `orig` = the line before the drag.
 * 선의 한쪽 끝을 곡선을 따라 줄이거나 늘림 (⌘ + 드래그): 곡선은 그대로, 재생 구간만 이동.
 * @param {object} v       line to change (startTime, duration, clip)
 * @param {object} orig    { startTime, duration, clip } at the start of the drag
 * @param {'start'|'end'} side
 * @param {number} sec     where that end should be (document seconds)
 * @param {{ minDur?: number, maxTime?: number }} [lim]
 */
export function trimLineEdge(v, orig, side, sec, { minDur = 0.05, maxTime = 300 } = {}) {
  const f = clipFullSpan(orig);
  const minU = minDur / f.dur;
  let { u0, u1 } = f;
  const u = (sec - f.start) / f.dur;
  if (side === 'start') {
    const lo = Math.max(CLIP_U_MIN, -f.start / f.dur); // never before 0 s / 0초 이전 금지
    u0 = clamp(u, lo, u1 - minU);
  } else {
    const hi = Math.min(CLIP_U_MAX, (maxTime - f.start) / f.dur);
    u1 = clamp(u, u0 + minU, hi);
  }
  v.startTime = roundTo(f.start + u0 * f.dur, 6);
  v.duration = roundTo((u1 - u0) * f.dur, 6);
  setClip(v, u0, u1, f.ext);
  return v;
}

/**
 * Cut a line at a document second into two pieces that together play exactly what it played.
 * Both share a link id (new, or the line's own) with `on: true`. Returns null when `sec` is too
 * close to an end. / 선을 sec에서 두 조각으로 자름 (합치면 원래 소리). 두 조각은 링크 id를 공유.
 * @param {object} v
 * @param {number} sec
 * @param {{ newId: () => string, linkId?: () => string, minDur?: number }} ids
 * @returns {[object, object] | null}
 */
export function splitLineAt(v, sec, { newId, linkId = newId, minDur = 0.05 } = {}) {
  const start = Number(v.startTime) || 0;
  const end = start + (Number(v.duration) || 0);
  if (!(sec > start + minDur - 1e-9 && sec < end - minDur + 1e-9)) return null;
  const us = clipSecToU(v, sec);
  const c = clipOf(v);
  const link = { id: v.link?.id || linkId(), on: true };
  const a = deepClone(v);
  const b = deepClone(v);
  a.duration = roundTo(sec - start, 6);
  setClip(a, c.u0, us, c.ext);
  a.link = { ...link };
  b.id = newId();
  b.startTime = roundTo(sec, 6);
  b.duration = roundTo(end - sec, 6);
  setClip(b, us, c.u1, c.ext);
  b.link = { ...link };
  return [a, b];
}

/** Clean a link read from a file. / 링크 정규화 */
export function normalizeLink(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  return { id: raw.id.slice(0, 40), on: raw.on !== false };
}

/** Other lines linked to `v` (same id, both on). / v와 링크된 다른 선 */
export function linkedPeers(lines, v) {
  if (!v?.link?.on || !v.link.id) return [];
  return lines.filter((w) => w !== v && w.link?.on && w.link.id === v.link.id);
}

/** All lines carrying the same link id, on or off (for the grapher badge). / 같은 링크 id의 모든 선 */
export function linkFamily(lines, v) {
  if (!v?.link?.id) return [];
  return lines.filter((w) => w.link?.id === v.link.id);
}

/** Signature of a line's shape fields. / 모양 필드 서명 */
export function shapeSignature(v, keys) {
  const o = {};
  for (const k of keys) o[k] = v[k];
  return JSON.stringify(o);
}

/**
 * Copy shape changes of edited lines onto their linked peers. `before` = Map(id → signature
 * taken before the edit). A peer that was itself edited in the same step is left alone.
 * 편집된 선의 모양 변경을 링크된 조각에 복사. 같은 단계에서 직접 편집된 조각은 건드리지 않음.
 * @returns {number} lines changed by the sync
 */
export function syncLinkedShapes(lines, edited, before, keys) {
  const editedIds = new Set(edited.map((v) => v.id));
  const done = new Set();
  let n = 0;
  for (const src of edited) {
    if (!src.link?.on || done.has(src.link.id)) continue;
    if (before && before.get(src.id) === shapeSignature(src, keys)) continue;
    done.add(src.link.id);
    for (const peer of linkedPeers(lines, src)) {
      if (editedIds.has(peer.id)) continue;
      for (const k of keys) {
        if (src[k] === undefined) delete peer[k];
        else peer[k] = deepClone(src[k]);
      }
      n++;
    }
  }
  return n;
}

// ==========================================================================
// Full-span lines (Field, Draw, Space): the object keeps its whole curve span and `clip` says which
// part plays, so a studio whose curve depends on its span (Field physics, Space propagation) never
// re-bakes when a line is trimmed. / 전체 구간을 유지하는 선 (필드·드로잉·스페이스): 객체는 곡선 전체 구간을
// 그대로 두고 clip이 재생 부분을 정함 → 구간에 의존하는 곡선(필드 물리, 스페이스 전파)이 다시 베이킹되지 않음.
// ==========================================================================

/** Played window [s0, s1] (document seconds) of a full-span line starting at `start`, `dur` long. / 재생 창 */
export function clipWindow(clip, start, dur) {
  const u0 = clip && Number.isFinite(clip.u0) ? clip.u0 : 0;
  const u1 = clip && Number.isFinite(clip.u1) ? clip.u1 : 1;
  return { s0: start + u0 * dur, s1: start + u1 * dur, u0, u1 };
}

/**
 * New clip after dragging one end of a full-span line to `sec` (⌘ + drag). `uMin` / `uMax` bound
 * the range (a studio that cannot extend passes 0 / 1). Returns null for the whole curve.
 * 전체 구간 선의 한쪽 끝을 sec로 옮긴 뒤의 클립 (연장할 수 없는 스튜디오는 uMin 0 / uMax 1).
 */
export function trimClip(clip, start, dur, side, sec, { minDur = 0.05, uMin = CLIP_U_MIN, uMax = CLIP_U_MAX } = {}) {
  const c = { ...clipOf({ clip }), ...(clip || {}) };
  const D = Math.max(1e-9, dur);
  const minU = minDur / D;
  const u = (sec - start) / D;
  let { u0, u1 } = c;
  if (side === 'start') u0 = clamp(u, Math.max(uMin, -start / D), u1 - minU);
  else u1 = clamp(u, u0 + minU, uMax);
  return normalizeClip({ u0, u1, ext: c.ext });
}

/** Two clips cutting a full-span line at `sec` (null when too close to a played end). / 자르기 */
export function splitClip(clip, start, dur, sec, minDur = 0.05) {
  const w = clipWindow(clip, start, dur);
  if (!(sec > w.s0 + minDur - 1e-9 && sec < w.s1 - minDur + 1e-9)) return null;
  const us = (sec - start) / Math.max(1e-9, dur);
  const ext = clip?.ext || 'shape';
  return [normalizeClip({ u0: w.u0, u1: us, ext }), normalizeClip({ u0: us, u1: w.u1, ext })];
}

/**
 * Read a sampled curve fn(u) (defined on 0…1) anywhere: inside as is, past the ends with the end
 * tangent (a sampled line has no formula to continue). / 샘플 곡선을 0…1 밖에서는 끝 접선으로 연장해 읽기
 */
export function extendSampled(fn, u, eps = 1e-3) {
  if (u >= 0 && u <= 1) return fn(u);
  const edge = u < 0 ? 0 : 1;
  const inner = u < 0 ? eps : 1 - eps;
  const yE = fn(edge);
  return yE + ((yE - fn(inner)) / (edge - inner)) * (u - edge);
}

/** Pieces of a polyline [{x, y, u}] split into played and unplayed parts by u. / u로 재생·비재생 부분 나누기 */
export function splitByClip(pts, clip) {
  const u0 = clip && Number.isFinite(clip.u0) ? clip.u0 : 0;
  const u1 = clip && Number.isFinite(clip.u1) ? clip.u1 : 1;
  const played = [];
  const ghost = [];
  let curP = null;
  let curG = null;
  for (const p of pts) {
    const inside = p.u >= u0 - 1e-9 && p.u <= u1 + 1e-9;
    if (inside) { if (!curP) { curP = []; played.push(curP); if (curG && curG.length) curP.push(curG[curG.length - 1]); } curP.push(p); curG = null; }
    else { if (!curG) { curG = []; ghost.push(curG); if (curP && curP.length) curG.push(curP[curP.length - 1]); } curG.push(p); curP = null; }
  }
  return { played: played.filter((l) => l.length > 1), ghost: ghost.filter((l) => l.length > 1) };
}

/**
 * Link sync around a studio edit: shape fields of a linked piece that changed in `after` are copied
 * to its linked peers (the piece the user is editing — `leadId` — wins). Pure on the two line arrays.
 * 스튜디오 편집 뒤 링크 동기화: 바뀐 조각의 모양 필드를 링크된 조각에 복사 (편집 중인 조각 우선).
 * @returns {number} lines changed
 */
export function syncLinkedAfterEdit(before, after, keys, leadId = null) {
  if (!Array.isArray(after) || !after.some((v) => v?.link?.on)) return 0;
  const sig0 = new Map((before || []).map((v) => [v.id, shapeSignature(v, keys)]));
  const changed = after.filter((v) => v.link?.on && sig0.has(v.id) && sig0.get(v.id) !== shapeSignature(v, keys));
  changed.sort((a, b) => (b.id === leadId) - (a.id === leadId));
  const done = new Set();
  let n = 0;
  // one source per link group (the lead first): the whole group takes its shape / 그룹마다 원본 하나
  for (const src of changed) {
    if (done.has(src.link.id)) continue;
    done.add(src.link.id);
    for (const peer of linkedPeers(after, src)) {
      for (const k of keys) { if (src[k] === undefined) delete peer[k]; else peer[k] = deepClone(src[k]); }
      n++;
    }
  }
  return n;
}

/** Turn a piece's 🔗 on / off; on again → take the shape of a linked peer. / 🔗 켜기·끄기 */
export function setLineLink(lines, id, on, keys) {
  const v = lines.find((x) => x.id === id);
  if (!v?.link) return false;
  v.link.on = !!on;
  if (on) {
    const src = linkedPeers(lines, v)[0];
    if (src) for (const k of keys) { if (src[k] === undefined) delete v[k]; else v[k] = deepClone(src[k]); }
  }
  return true;
}
