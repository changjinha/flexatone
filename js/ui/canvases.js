/**
 * Flexatone — ui/canvases.js
 * Layer 4 (ui): main piano-roll / 0–1 Norm canvas, [function] gain canvas, HUD and all
 * pointer editing on them.
 * 계층 4 (ui): 메인 피아노롤/정규화 캔버스, 게인 캔버스, HUD, 포인터 편집.
 *
 * Every edit goes through core actions (updateVoices / setViewport / setPref …) so undo and
 * re-rendering stay consistent. Drags use a coalesceKey and end with endHistoryGesture(),
 * so one gesture = one undo step. / 모든 편집은 core 액션을 거치며, 드래그 1회 = 실행 취소 1단계.
 */

import { clamp, roundTo, getSegmentControlArrays, solveSegmentParamS, findSplineSegmentIndex, splitSplineSegmentPreservingShape, elevateSplineSegmentHandles, removeSplinePoint, fitStrokeToSpline } from '../core/math-utils.js';
import { midiToFreq, freqToMidi, freqToNorm, midiToNoteName, ampToDb } from '../core/units.js';
import { t } from '../core/i18n.js';
import {
  appState,
  getActiveVoice,
  getVoiceById,
  getVoiceEnd,
  getVoiceHz,
  setVoicePitch,
  setViewport,
  setPref,
  selectVoice,
  updateVoices,
  endHistoryGesture,
  createDefaultRegion,
  MAX_REGIONS_PER_VOICE,
  MIN_DURATION,
  MAX_TIME,
  splitVoice,
} from '../core/state.js';
import { isClipped, clipFullSpan, trimLineEdge } from '../core/line-clip.js';
import {
  evaluateCurveObjectY,
  mapNormYToFreq,
  computeDerivativeStats,
  evaluateVoiceDerivativeNorm,
  analyzeCurveFeatures,
  evalSingleEngine,
  regionTargetY,
  regionEdgeRamped,
  regionRampNorm,
} from '../modules/curve-engine.js';
import { evaluateVoiceGainAtNormT, getGainEngineRange, envelopeToAmp, voiceEnvelopeOpts, envelopeTaper } from '../modules/gain-bus.js';
import { StudioRegistry } from '../studios/registry.js';
import { uiState } from './ui-state.js';
import { drawCueLine, drawPlayheadLine } from './transport-lines.js';
import { setCueSec, startScrubAudio, updateScrubAudio, stopScrubAudio, isPlaying } from '../audio/audio-engine.js';

const MPAD = { left: 46, right: 10, top: 18, bottom: 20 };
const GPAD = { left: 34, right: 10, top: 8, bottom: 16 };
const COLORS = {
  bg: '#020617',
  plot: '#0b1222',
  black: '#070d1a',
  grid: 'rgba(148,163,184,0.10)',
  gridStrong: 'rgba(148,163,184,0.22)',
  label: '#64748b',
  ruler: '#0f172a',
  cue: '#fbbf24',
  playhead: '#f8fafc',
  deriv: '#f59e0b',
  ghost: 'rgba(148,163,184,0.45)',
  gain: '#34d399',
};
const HIT_ANCHOR = 9;
const HIT_CURVE = 10;

const mainView = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1 };
const gainView = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1 };
let renderedCurves = []; // [{ id, pts: [[x,y], …] }] in CSS px, for hit-testing
let renderedNodeCurve = null; // screen polyline of the Custom morph node being edited
let hover = null; // { x, y } in main canvas CSS px
let drag = null; // main canvas gesture state
let gainHover = null;
let gainDrag = null;
let requestRender = () => {};
let showToastFn = () => {};

// ==========================================================================
// Geometry / 좌표 변환
// ==========================================================================

function sizeCanvas(view) {
  const c = view.canvas;
  const w = Math.max(1, c.clientWidth);
  const h = Math.max(1, c.clientHeight);
  const dpr = globalThis.devicePixelRatio || 1;
  if (view.w !== w || view.h !== h || view.dpr !== dpr) {
    view.w = w;
    view.h = h;
    view.dpr = dpr;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
}

/** Pointer position in the canvas's own CSS pixels (robust to CSS zoom). / CSS 줌에 강인한 좌표 */
function pointerPos(evt, view) {
  const r = view.canvas.getBoundingClientRect();
  return {
    x: ((evt.clientX - r.left) / Math.max(1, r.width)) * view.w,
    y: ((evt.clientY - r.top) / Math.max(1, r.height)) * view.h,
  };
}

/** Main-canvas metrics & mapping functions for the current viewport. / 메인 캔버스 좌표계 */
export function getMainMetrics() {
  const vp = appState.viewport;
  const piano = appState.viewMode === 'piano';
  const plotX = MPAD.left;
  const plotY = MPAD.top;
  const plotW = Math.max(10, mainView.w - MPAD.left - MPAD.right);
  const plotH = Math.max(10, mainView.h - MPAD.top - MPAD.bottom);
  const tSpan = Math.max(1e-6, vp.timeMax - vp.timeMin);
  const yMin = piano ? vp.midiMin : vp.normYMin;
  const yMax = piano ? vp.midiMax : vp.normYMax;
  const ySpan = Math.max(1e-6, yMax - yMin);
  const m = { w: mainView.w, h: mainView.h, plotX, plotY, plotW, plotH, piano, vp };
  m.timeToX = (sec) => plotX + ((sec - vp.timeMin) / tSpan) * plotW;
  m.xToTime = (x) => vp.timeMin + ((x - plotX) / plotW) * tSpan;
  m.valToY = (val) => plotY + ((yMax - val) / ySpan) * plotH; // midi (piano) or norm y
  m.yToVal = (y) => yMax - ((y - plotY) / plotH) * ySpan;
  m.midiToY = (midi) => m.valToY(midi);
  return m;
}

/** Plot y of a voice-normalized value (applies F0/F1 mapping in piano view). */
function voiceNormToPlotY(v, yNorm, m) {
  return m.piano ? m.valToY(freqToMidi(mapNormYToFreq(v, yNorm))) : m.valToY(yNorm);
}

/** Inverse of voiceNormToPlotY. / 화면 y → 보이스 정규화 값 */
function plotYToVoiceNorm(v, py, m) {
  if (!m.piano) return m.yToVal(py);
  const hz = midiToFreq(m.yToVal(py));
  const f0 = clamp(getVoiceHz(v, 'f0'), 15, 18000);
  const f1 = clamp(getVoiceHz(v, 'f1'), 15, 18000);
  return freqToNorm(hz, f0, f1, v.logScale !== false);
}

/** Pointer capture can throw for inactive pointers (pen hover, synthetic events). / 포인터 캡처 예외 방지 */
function capture(canvas, id) {
  try { canvas.setPointerCapture(id); } catch { /* capture is a nicety, not required */ }
}

const inPlot = (p, m) => p.x >= m.plotX && p.x <= m.plotX + m.plotW && p.y >= m.plotY && p.y <= m.plotY + m.plotH;
const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1e-9;
    const tt = clamp(((p.x - ax) * dx + (p.y - ay) * dy) / len, 0, 1);
    best = Math.min(best, dist2(p.x, p.y, ax + tt * dx, ay + tt * dy));
  }
  return Math.sqrt(best);
}

/** Display ↔ raw transforms for a curve's reverse/inverse flags. / 표시 ↔ 원본 변환 */
const dispX = (obj, x) => (obj.reverse ? 1 - x : x);
const dispY = (obj, y) => (obj.inverse ? 1 - y : y);
const NO_FLAGS = Object.freeze({ reverse: false, inverse: false });

/**
 * The spline the main canvas can edit: the active voice's 11. Custom curve, or the Custom
 * node of a 10. Multi-Morph voice opened with ⚙ Edit (shown in its own raw 0–1 space).
 * 캔버스에서 편집 가능한 스플라인: 11. Custom 곡선 또는 ⚙ Edit로 연 모핑 Custom 노드.
 * @returns {{ v: object, nodeId: string|null, flags: object, pts: Array }|null}
 */
function getCustomEditCtx(v = getActiveVoice()) {
  if (!v || appState.engineTarget !== 'curve' || (uiState.regionEdit && getSelectedRegion(v))) return null;
  if (v.engine === 'custom' && Array.isArray(v.customPoints) && v.customPoints.length >= 2) {
    return { v, nodeId: null, flags: v, pts: v.customPoints };
  }
  if (v.engine === 'morph' && uiState.morphEditNodeId) {
    const n = (v.morphNodes || []).find((x) => x.id === uiState.morphEditNodeId);
    if (n && n.engine === 'custom' && Array.isArray(n.customPoints) && n.customPoints.length >= 2) {
      return { v, nodeId: n.id, flags: NO_FLAGS, pts: n.customPoints };
    }
  }
  return null;
}
const isCustomEditable = (v) => !!getCustomEditCtx(v);

/** Points array inside a (mutable, being-edited) voice for an edit context. / 편집 대상 점 배열 */
function ptsOf(vv, ctx) {
  if (!ctx?.nodeId) return vv.customPoints;
  return (vv.morphNodes || []).find((n) => n.id === ctx.nodeId)?.customPoints || [];
}

/** Screen positions of the editable spline's anchors and handles. */
function customHandlesOnScreen(v, m, ctx = getCustomEditCtx(v)) {
  const anchors = [];
  const handles = [];
  if (!ctx) return { anchors, handles };
  const { pts, flags } = ctx;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    anchors.push({ i, x: m.timeToX(v.startTime + dispX(flags, p.x) * v.duration), y: voiceNormToPlotY(v, dispY(flags, p.y), m) });
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      (p.handles || []).forEach((h, k) => {
        const hx = p.x + h.u * (q.x - p.x);
        handles.push({ i, k, x: m.timeToX(v.startTime + dispX(flags, hx) * v.duration), y: voiceNormToPlotY(v, dispY(flags, h.y), m), ax: anchors[i] });
      });
    }
  }
  return { anchors, handles };
}

// ==========================================================================
// Viewport helpers / 뷰포트
// ==========================================================================

/** Fit time & pitch (or norm) ranges to all voices. / 모든 보이스에 맞춤 */
export function fitAllViewport() {
  const voices = appState.voices;
  let tMin = Infinity;
  let tMax = -Infinity;
  let mMin = Infinity;
  let mMax = -Infinity;
  let nMin = 0;
  let nMax = 1;
  for (const v of voices) {
    tMin = Math.min(tMin, v.startTime);
    tMax = Math.max(tMax, getVoiceEnd(v));
    for (let i = 0; i <= 64; i++) {
      const y = evaluateCurveObjectY(v, i / 64);
      nMin = Math.min(nMin, y);
      nMax = Math.max(nMax, y);
      const midi = freqToMidi(mapNormYToFreq(v, y));
      mMin = Math.min(mMin, midi);
      mMax = Math.max(mMax, midi);
    }
  }
  if (!Number.isFinite(tMin)) { tMin = 0; tMax = 4; mMin = 48; mMax = 72; }
  const tSpan = Math.max(1, tMax - tMin);
  let lo = mMin - 2;
  let hi = mMax + 2;
  if (hi - lo < 12) { const c = (lo + hi) / 2; lo = c - 6; hi = c + 6; }
  setViewport({
    timeMin: Math.max(0, tMin - tSpan * 0.04),
    timeMax: tMax + tSpan * 0.04,
    midiMin: clamp(lo, 0, 126),
    midiMax: clamp(hi, 1, 127),
    normYMin: nMin - 0.08,
    normYMax: nMax + 0.08,
  });
}

/** Zoom the pitch (or norm) axis around its centre (or an anchor value). factor < 1 zooms in. */
export function zoomPitch(factor, anchor) {
  const vp = appState.viewport;
  if (appState.viewMode === 'piano') {
    const c = anchor ?? (vp.midiMin + vp.midiMax) / 2;
    const span = clamp((vp.midiMax - vp.midiMin) * factor, 3, 127);
    let lo = c - (c - vp.midiMin) * (span / (vp.midiMax - vp.midiMin));
    lo = clamp(lo, 0, 127 - span);
    setViewport({ midiMin: lo, midiMax: lo + span });
  } else {
    const c = anchor ?? (vp.normYMin + vp.normYMax) / 2;
    const span = clamp((vp.normYMax - vp.normYMin) * factor, 0.05, 20);
    const lo = c - (c - vp.normYMin) * (span / (vp.normYMax - vp.normYMin));
    setViewport({ normYMin: lo, normYMax: lo + span });
  }
}

/** Zoom the time axis around its centre (or an anchor time). */
export function zoomTime(factor, anchor) {
  const vp = appState.viewport;
  const c = anchor ?? (vp.timeMin + vp.timeMax) / 2;
  const old = vp.timeMax - vp.timeMin;
  const span = clamp(old * factor, 0.05, MAX_TIME * 2);
  const lo = Math.max(-span * 0.1, c - (c - vp.timeMin) * (span / old));
  setViewport({ timeMin: lo, timeMax: lo + span });
}

/** Proportional (corner) zoom on both axes. / 비례 줌 */
export function zoomBoth(factor) {
  zoomTime(factor);
  zoomPitch(factor);
}

// ==========================================================================
// Main canvas rendering / 메인 캔버스 그리기
// ==========================================================================

function niceStep(span, px, minPx) {
  const raw = (span * minPx) / Math.max(1, px);
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((s) => s >= raw) || 300;
}

function drawMainGrid(ctx, m) {
  const { plotX, plotY, plotW, plotH, vp } = m;
  ctx.fillStyle = COLORS.plot;
  ctx.fillRect(plotX, plotY, plotW, plotH);
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  if (m.piano) {
    const pxPerSemi = plotH / Math.max(1e-6, vp.midiMax - vp.midiMin);
    for (let midi = Math.floor(vp.midiMin); midi <= Math.ceil(vp.midiMax); midi++) {
      const yTop = m.valToY(midi + 0.5);
      const yBot = m.valToY(midi - 0.5);
      const pc = ((midi % 12) + 12) % 12;
      if ([1, 3, 6, 8, 10].includes(pc) && pxPerSemi >= 3) {
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(plotX, Math.max(plotY, yTop), plotW, Math.min(plotY + plotH, yBot) - Math.max(plotY, yTop));
      }
      const y = m.valToY(midi);
      if (y < plotY || y > plotY + plotH) continue;
      if (pc === 0 || pxPerSemi >= 6) {
        ctx.strokeStyle = pc === 0 ? COLORS.gridStrong : COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(plotX, y);
        ctx.lineTo(plotX + plotW, y);
        ctx.stroke();
      }
      if (pc === 0 || pxPerSemi >= 12) {
        ctx.fillStyle = pc === 0 ? '#94a3b8' : COLORS.label;
        ctx.textAlign = 'right';
        ctx.fillText(midiToNoteName(midi), plotX - 5, y);
      }
    }
  } else {
    const step = niceStep(vp.normYMax - vp.normYMin, plotH, 28);
    for (let v = Math.ceil(vp.normYMin / step) * step; v <= vp.normYMax + 1e-9; v += step) {
      const y = m.valToY(v);
      const strong = Math.abs(v) < 1e-9 || Math.abs(v - 1) < 1e-9;
      ctx.strokeStyle = strong ? COLORS.gridStrong : COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      ctx.stroke();
      ctx.fillStyle = strong ? '#94a3b8' : COLORS.label;
      ctx.textAlign = 'right';
      ctx.fillText(roundTo(v, 2).toFixed(2), plotX - 5, y);
    }
  }

  // Time grid + ruler / 시간 격자와 눈금자
  ctx.fillStyle = COLORS.ruler;
  ctx.fillRect(plotX, 0, plotW, plotY);
  const tStep = niceStep(vp.timeMax - vp.timeMin, plotW, 70);
  ctx.textAlign = 'center';
  for (let s = Math.ceil(vp.timeMin / tStep) * tStep; s <= vp.timeMax + 1e-9; s += tStep) {
    const x = m.timeToX(s);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(x, plotY);
    ctx.lineTo(x, plotY + plotH);
    ctx.stroke();
    ctx.fillStyle = COLORS.label;
    ctx.fillText(`${roundTo(s, 2)}s`, x, plotY + plotH + 10);
    ctx.fillRect(x - 0.5, plotY - 5, 1, 5);
  }

  // Grid subdivisions of the active voice span / 활성 보이스 구간 분할선
  const v = getActiveVoice();
  const sub = Number(appState.gridSub) || 0;
  if (v && sub > 0) {
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(56,189,248,0.12)';
    for (let k = 0; k <= sub; k++) {
      const x = m.timeToX(v.startTime + (v.duration * k) / sub);
      if (x < plotX || x > plotX + plotW) continue;
      ctx.beginPath();
      ctx.moveTo(x, plotY);
      ctx.lineTo(x, plotY + plotH);
      ctx.stroke();
    }
    if (!m.piano) {
      for (let k = 0; k <= sub; k++) {
        const y = m.valToY(k / sub);
        ctx.beginPath();
        ctx.moveTo(plotX, y);
        ctx.lineTo(plotX + plotW, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}

/** Sample a voice's displayed trajectory as screen points (only the visible part). */
function voicePolyline(v, m, valueAt = (tn) => evaluateCurveObjectY(v, tn)) {
  const vp = m.vp;
  const s0 = Math.max(v.startTime, vp.timeMin);
  const s1 = Math.min(getVoiceEnd(v), vp.timeMax);
  if (s1 <= s0) return [];
  const pxSpan = m.timeToX(s1) - m.timeToX(s0);
  const n = clamp(Math.ceil(pxSpan / 1.5), 24, 2400);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const sec = s0 + ((s1 - s0) * i) / n;
    const tn = (sec - v.startTime) / Math.max(1e-9, v.duration);
    pts.push([m.timeToX(sec), voiceNormToPlotY(v, valueAt(tn), m)]);
  }
  return pts;
}

/**
 * The parts of a trimmed line's curve that are not played (u ∈ [0, u0) and (u1, 1]) as screen
 * polylines — drawn faint, or not at all when ◌ Unplayed parts is off. / 잘린 선의 재생하지 않는 부분
 */
function voiceGhostPolylines(v, m) {
  if (!isClipped(v)) return [];
  const f = clipFullSpan(v);
  const out = [];
  const piece = (ua, ub) => {
    const s0 = Math.max(f.start + ua * f.dur, m.vp.timeMin);
    const s1 = Math.min(f.start + ub * f.dur, m.vp.timeMax);
    if (s1 <= s0) return;
    const n = clamp(Math.ceil((m.timeToX(s1) - m.timeToX(s0)) / 2), 8, 1200);
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const sec = s0 + ((s1 - s0) * i) / n;
      pts.push([m.timeToX(sec), voiceNormToPlotY(v, evaluateCurveObjectY(v, (sec - f.start) / f.dur, { u: true }), m)]);
    }
    out.push(pts);
  };
  if (f.u0 > 0) piece(0, Math.min(1, f.u0));
  if (f.u1 < 1) piece(Math.max(0, f.u1), 1);
  return out;
}

function strokePolyline(ctx, pts) {
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/**
 * @param {{ capture?: boolean }} [opts] capture: draw for a Screenshot — no editing aids (handles,
 *   start/end dots, freehand stroke) and no change to the live hit-test state. / 스크린샷용 그리기
 */
function drawVoices(ctx, m, opts = {}) {
  const cap = !!opts.capture;
  const active = getActiveVoice();
  const selected = new Set(appState.selectedVoiceIds);
  const anySolo = appState.voices.some((v) => v.solo);
  if (!cap) renderedCurves = [];

  ctx.save();
  ctx.beginPath();
  ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
  ctx.clip();

  // Ghost versions / 고스트 버전
  for (const ver of appState.versions) {
    if (!ver.ghost) continue;
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = COLORS.ghost;
    for (const v of ver.voices) strokePolyline(ctx, voicePolyline(v, m));
  }
  ctx.setLineDash([]);

  const order = appState.voices.filter((v) => v !== active).concat(active ? [active] : []);
  // Unplayed parts of trimmed lines: faint, thin, dotted (◌ Unplayed parts off → left out)
  // 잘린 선의 재생하지 않는 부분: 연하게 (◌ 끄면 표시 안 함)
  if (appState.clipGhost !== false) {
    ctx.setLineDash([2, 4]);
    for (const v of order) {
      const ghosts = voiceGhostPolylines(v, m);
      if (!ghosts.length) continue;
      ctx.globalAlpha = v === active ? 0.32 : 0.18;
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = v.color;
      for (const g of ghosts) strokePolyline(ctx, g);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  for (const v of order) {
    const pts = voicePolyline(v, m);
    if (!cap) renderedCurves.push({ id: v.id, pts });
    const silent = v.muted || (anySolo && !v.solo);
    ctx.globalAlpha = v === active ? 1 : silent ? 0.25 : selected.has(v.id) ? 0.85 : 0.55;
    ctx.setLineDash(silent ? [5, 5] : []);
    ctx.lineWidth = v === active ? 2.6 : selected.has(v.id) ? 2 : 1.5;
    ctx.strokeStyle = v.color;
    strokePolyline(ctx, pts);
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // f′(t) overlay for the active voice / 도함수 오버레이
  if (active && appState.showDeriv) {
    const stats = computeDerivativeStats(active);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = COLORS.deriv;
    strokePolyline(ctx, voicePolyline(active, m, (tn) => evaluateVoiceDerivativeNorm(active, tn, stats)));
    ctx.setLineDash([]);
  }

  // Studio overlay (e.g. Glissando F₀/F₁ guides) / 스튜디오 오버레이
  StudioRegistry.renderOverlay(StudioRegistry.resolveStudioId(), ctx, { viewport: m.vp, viewMode: appState.viewMode, timeToX: m.timeToX, midiToY: m.midiToY, m }, { state: appState });

  // Freehand stroke in progress / 자유 그리기 진행 중
  if (!cap && drag?.type === 'freehand' && drag.screen.length > 1) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e879f9';
    strokePolyline(ctx, drag.screen);
  }
  ctx.restore();

  if (!active || cap) return;
  // Start / end dots / 시작·끝 점
  for (const tn of [0, 1]) {
    const x = m.timeToX(active.startTime + tn * active.duration);
    const y = voiceNormToPlotY(active, evaluateCurveObjectY(active, tn), m);
    ctx.fillStyle = appState.locateMode ? '#f8fafc' : active.color;
    ctx.strokeStyle = COLORS.bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, appState.locateMode ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Editable spline: 11. Custom, or a Custom morph node opened with ⚙ Edit
  // 편집 가능한 스플라인: 11. Custom 또는 ⚙ Edit로 연 모핑 Custom 노드
  const ectx = getCustomEditCtx(active);
  renderedNodeCurve = null;
  if (ectx) {
    if (ectx.nodeId) {
      const node = active.morphNodes.find((n) => n.id === ectx.nodeId);
      renderedNodeCurve = voicePolyline(active, m, (tn) => evalSingleEngine('custom', tn, node));
      ctx.save();
      ctx.beginPath();
      ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
      ctx.clip();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#e879f9';
      strokePolyline(ctx, renderedNodeCurve);
      ctx.restore();
    }
    const sel = uiState.selection;
    const isSel = (kind, i, k) => sel && sel.voiceId === active.id && sel.kind === kind && sel.i === i && (kind !== 'handle' || sel.k === k) && (sel.nodeId || null) === ectx.nodeId;
    const { anchors, handles } = customHandlesOnScreen(active, m, ectx);
    ctx.lineWidth = 1;
    for (const h of handles) {
      ctx.strokeStyle = 'rgba(232,121,249,0.5)';
      ctx.beginPath();
      ctx.moveTo(h.ax.x, h.ax.y);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      const r = isSel('handle', h.i, h.k) ? 7 : 5;
      ctx.fillStyle = isSel('handle', h.i, h.k) ? '#fde047' : '#e879f9';
      ctx.beginPath();
      ctx.moveTo(h.x, h.y - r);
      ctx.lineTo(h.x + r, h.y);
      ctx.lineTo(h.x, h.y + r);
      ctx.lineTo(h.x - r, h.y);
      ctx.closePath();
      ctx.fill();
    }
    for (const a of anchors) {
      const on = isSel('anchor', a.i);
      ctx.fillStyle = on ? '#fde047' : '#f8fafc';
      ctx.strokeStyle = ectx.nodeId ? '#e879f9' : active.color;
      ctx.lineWidth = 2;
      const r = on ? 5.5 : 4;
      ctx.fillRect(a.x - r, a.y - r, 2 * r, 2 * r);
      ctx.strokeRect(a.x - r, a.y - r, 2 * r, 2 * r);
    }
  }
  // Selected start/end dot ring / 선택된 시작·끝 점 표시
  const sel = uiState.selection;
  if (sel && sel.voiceId === active.id && (sel.kind === 'start' || sel.kind === 'end')) {
    const tn = sel.kind === 'start' ? 0 : 1;
    ctx.strokeStyle = '#fde047';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(m.timeToX(active.startTime + tn * active.duration), voiceNormToPlotY(active, evaluateCurveObjectY(active, tn), m), 9, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * Axis-edge tracking badges (pitch/value on the Y axis, time on the X axis) and a
 * semi-transparent floating tooltip next to the cursor with t, Note, Hz and y.
 * 축 테두리 추적 배지와 커서 옆 반투명 좌표 툴팁 (t, Note, Hz, y).
 */
function drawPointerOverlay(ctx, m) {
  if (!hover || !inPlot(hover, m) || (drag && drag.type !== 'pan' && drag.type !== 'axis')) return;
  const p = hover;
  const sec = m.xToTime(p.x);
  const val = m.yToVal(p.y);
  const v = getActiveVoice();
  let midi = null;
  let y = null;
  if (m.piano) {
    midi = val;
    if (v) y = plotYToVoiceNorm(v, p.y, m);
  } else {
    y = val;
    if (v) midi = freqToMidi(mapNormYToFreq(v, val));
  }
  ctx.save();
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  // Crosshair / 십자선
  ctx.strokeStyle = 'rgba(148,163,184,0.25)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(m.plotX, p.y);
  ctx.lineTo(m.plotX + m.plotW, p.y);
  ctx.moveTo(p.x, m.plotY);
  ctx.lineTo(p.x, m.plotY + m.plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  const badge = (text, cx, cy, align) => {
    const w = ctx.measureText(text).width + 8;
    const x = align === 'right' ? cx - w : align === 'center' ? cx - w / 2 : cx;
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(x, cy - 7, w, 14);
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    ctx.fillText(text, x + 4, cy);
  };
  badge(m.piano ? midiToNoteName(val) : val.toFixed(2), m.plotX - 2, p.y, 'right');
  badge(`${sec.toFixed(2)}s`, clamp(p.x, m.plotX + 24, m.plotX + m.plotW - 24), m.plotY + m.plotH + 10, 'center');

  const lines = [
    `t    ${sec.toFixed(3)} s`,
    `Note ${midi === null ? '—' : midiToNoteName(midi, { cents: true })}`,
    `Hz   ${midi === null ? '—' : midiToFreq(midi).toFixed(2)}`,
    `y    ${y === null || !Number.isFinite(y) ? '—' : y.toFixed(3)}`,
  ];
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
  const h = lines.length * 13 + 8;
  let tx = p.x + 14;
  let ty = p.y + 14;
  if (tx + w > m.plotX + m.plotW) tx = p.x - 14 - w;
  if (ty + h > m.plotY + m.plotH) ty = p.y - 14 - h;
  ctx.fillStyle = 'rgba(2,6,23,0.72)';
  ctx.strokeStyle = 'rgba(56,189,248,0.45)';
  ctx.lineWidth = 1;
  ctx.fillRect(tx, ty, w, h);
  ctx.strokeRect(tx + 0.5, ty + 0.5, w - 1, h - 1);
  ctx.fillStyle = '#e2e8f0';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, tx + 7, ty + 10 + i * 13));
  ctx.restore();
}

function drawTransportLines(ctx, m) {
  // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
  const tr = appState.transport;
  const span = { left: m.plotX, right: m.plotX + m.plotW };
  drawCueLine(ctx, m.timeToX(tr.cueSec || 0), m.plotY, m.plotY + m.plotH, span);
  if (tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), m.plotY, m.plotY + m.plotH, span);
}

/** Redraw the main canvas. / 메인 캔버스 다시 그리기 */
export function renderMainCanvas() {
  if (!mainView.canvas) return;
  sizeCanvas(mainView);
  const ctx = mainView.ctx;
  ctx.setTransform(mainView.dpr, 0, 0, mainView.dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, mainView.w, mainView.h);
  const m = getMainMetrics();
  drawMainGrid(ctx, m);
  drawRegions(ctx, m);
  drawVoices(ctx, m);
  drawTransportLines(ctx, m);
  drawPointerOverlay(ctx, m);
  updateHud(m);
  mainView.canvas.style.cursor = cursorFor(hover, m);
}

// ==========================================================================
// Screenshot rendering / 스크린샷 렌더링
// ==========================================================================

/** Darken a voice colour (#rrggbb) so it prints on white. / 흰 배경에서 읽히도록 어둡게 */
function inkColor(hex) {
  const n = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!n) return '#111827';
  const v = parseInt(n[1], 16);
  const f = 0.62;
  return `rgb(${Math.round(((v >> 16) & 255) * f)},${Math.round(((v >> 8) & 255) * f)},${Math.round((v & 255) * f)})`;
}

/** Make sure the main canvas has been sized (it may not have painted yet); false if it is hidden. */
function readyForExport() {
  const c = mainView.canvas;
  if (!c || c.clientWidth < 20 || c.clientHeight < 20) return false;
  sizeCanvas(mainView);
  return true;
}

const CLEAN_INK = '#111827';
const CLEAN_FONT = '"JetBrains Mono", ui-monospace, monospace';
const CLEAN_FONT_PX = 10;

/**
 * Geometry of the "axes and lines only" chart as plain primitives, so the same drawing feeds both
 * the canvas (PNG) and the SVG export. / 축+선 차트의 도형 목록 (PNG·SVG 공용)
 * @returns {{ w:number, h:number, plot:{x:number,y:number,w:number,h:number},
 *   curves:Array<{pts:number[][], color:string}>, lines:Array<[number,number,number,number]>,
 *   texts:Array<{x:number,y:number,text:string,align:'left'|'center'|'right',base:'top'|'middle'|'bottom'}> }}
 */
function cleanChartPrimitives(m) {
  const { plotX, plotY, plotW, plotH, vp } = m;
  const lines = [];
  const texts = [];
  const curves = appState.voices.map((v) => ({ color: inkColor(v.color), pts: voicePolyline(v, m) }));

  // Axes (L-shaped) / 축
  lines.push([plotX + 0.5, plotY, plotX + 0.5, plotY + plotH + 0.5], [plotX + 0.5, plotY + plotH + 0.5, plotX + plotW, plotY + plotH + 0.5]);

  // Time ticks / 시간 눈금
  const tStep = niceStep(vp.timeMax - vp.timeMin, plotW, 70);
  for (let s = Math.ceil(vp.timeMin / tStep) * tStep; s <= vp.timeMax + 1e-9; s += tStep) {
    const x = Math.round(m.timeToX(s)) + 0.5;
    lines.push([x, plotY + plotH, x, plotY + plotH + 4]);
    texts.push({ x, y: plotY + plotH + 6, text: `${roundTo(s, 2)}`, align: 'center', base: 'top' });
  }

  // Value ticks (note names in piano view) / 값 눈금 (피아노 뷰는 음이름)
  if (m.piano) {
    const pxPerSemi = plotH / Math.max(1e-6, vp.midiMax - vp.midiMin);
    for (let midi = Math.floor(vp.midiMin); midi <= Math.ceil(vp.midiMax); midi++) {
      const y = Math.round(m.valToY(midi)) + 0.5;
      if (y < plotY || y > plotY + plotH) continue;
      const major = ((midi % 12) + 12) % 12 === 0 || pxPerSemi >= 12;
      if (!major && pxPerSemi < 3) continue;
      lines.push([plotX, y, plotX - (major ? 4 : 2), y]);
      if (major) texts.push({ x: plotX - 6, y, text: midiToNoteName(midi), align: 'right', base: 'middle' });
    }
  } else {
    const step = niceStep(vp.normYMax - vp.normYMin, plotH, 28);
    for (let v = Math.ceil(vp.normYMin / step) * step; v <= vp.normYMax + 1e-9; v += step) {
      const y = Math.round(m.valToY(v)) + 0.5;
      lines.push([plotX, y, plotX - 4, y]);
      texts.push({ x: plotX - 6, y, text: roundTo(v, 2).toFixed(2), align: 'right', base: 'middle' });
    }
  }

  // Axis titles / 축 이름
  texts.push({ x: plotX + plotW - 4, y: plotY + plotH - 4, text: 't (s)', align: 'right', base: 'bottom' });
  texts.push({ x: 4, y: 3, text: m.piano ? 'pitch' : 'y', align: 'left', base: 'top' });
  return { w: m.w, h: m.h, plot: { x: plotX, y: plotY, w: plotW, h: plotH }, curves, lines, texts };
}

/** Axes and lines only: white page, L-shaped axes with ticks, the voice curves. / 축과 선만 */
function drawCleanChart(ctx, m) {
  const g = cleanChartPrimitives(m);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.font = `${CLEAN_FONT_PX}px ${CLEAN_FONT}`;

  ctx.save();
  ctx.beginPath();
  ctx.rect(g.plot.x, g.plot.y, g.plot.w, g.plot.h);
  ctx.clip();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  for (const c of g.curves) {
    ctx.strokeStyle = c.color;
    strokePolyline(ctx, c.pts);
  }
  ctx.restore();

  ctx.strokeStyle = CLEAN_INK;
  ctx.fillStyle = CLEAN_INK;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of g.lines) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  ctx.stroke();
  for (const tx of g.texts) {
    ctx.textAlign = tx.align;
    ctx.textBaseline = tx.base;
    ctx.fillText(tx.text, tx.x, tx.y);
  }
}

function svgEsc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The "axes and lines only" chart as an SVG document string (vector, for papers and score
 * editors). Same geometry as the clean PNG; text baselines are converted to plain `y` offsets
 * because editors (Illustrator, Inkscape) ignore `dominant-baseline`.
 * 축+선 차트를 SVG 문자열로 (논문·악보 편집기용 벡터). 텍스트 기준선은 y 오프셋으로 환산.
 * @returns {string|null}
 */
export function renderMainSvg() {
  if (!readyForExport()) return null;
  const g = cleanChartPrimitives(getMainMetrics());
  const f = (n) => Number(n.toFixed(2));
  const dy = { top: 0.8 * CLEAN_FONT_PX, middle: 0.35 * CLEAN_FONT_PX, bottom: -0.2 * CLEAN_FONT_PX };
  const anchor = { left: 'start', center: 'middle', right: 'end' };
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${f(g.w)}" height="${f(g.h)}" viewBox="0 0 ${f(g.w)} ${f(g.h)}">`);
  out.push(`<rect width="${f(g.w)}" height="${f(g.h)}" fill="#ffffff"/>`);
  out.push(`<clipPath id="plot"><rect x="${f(g.plot.x)}" y="${f(g.plot.y)}" width="${f(g.plot.w)}" height="${f(g.plot.h)}"/></clipPath>`);
  out.push('<g clip-path="url(#plot)" fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">');
  for (const c of g.curves) {
    if (c.pts.length < 2) continue;
    out.push(`<polyline stroke="${c.color}" points="${c.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}"/>`);
  }
  out.push('</g>');
  out.push(`<path fill="none" stroke="${CLEAN_INK}" stroke-width="1" d="${g.lines.map(([x1, y1, x2, y2]) => `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`).join('')}"/>`);
  out.push(`<g fill="${CLEAN_INK}" font-family='${svgEsc(CLEAN_FONT)}' font-size="${CLEAN_FONT_PX}">`);
  for (const tx of g.texts) out.push(`<text x="${f(tx.x)}" y="${f(tx.y + dy[tx.base])}" text-anchor="${anchor[tx.align]}">${svgEsc(tx.text)}</text>`);
  out.push('</g>', '</svg>');
  return out.join('\n');
}

/**
 * Draw the main graph onto a NEW offscreen canvas for a Screenshot. The live canvas and its
 * hit-test state are not touched. 'full' = the screen as shown minus editing aids (handles,
 * cursor tooltip, playhead); 'clean' = axes and lines only on white.
 * 스크린샷용 오프스크린 캔버스에 메인 그래프를 그림. 'full' = 편집 보조물 제외한 화면 그대로,
 * 'clean' = 흰 배경에 축과 선만.
 * @param {'full'|'clean'} [mode]
 * @param {number} [scale] pixel multiplier over the on-screen CSS size
 * @returns {HTMLCanvasElement|null}
 */
export function renderMainScreenshot(mode = 'full', scale = 2) {
  if (!readyForExport()) return null;
  const out = document.createElement('canvas');
  out.width = Math.round(mainView.w * scale);
  out.height = Math.round(mainView.h * scale);
  const ctx = out.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const m = getMainMetrics();
  if (mode === 'clean') {
    drawCleanChart(ctx, m);
  } else {
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, m.w, m.h);
    drawMainGrid(ctx, m);
    drawRegions(ctx, m);
    drawVoices(ctx, m, { capture: true });
  }
  return out;
}

// ==========================================================================
// HUD / 실시간 HUD
// ==========================================================================

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

function updateHud(m) {
  const v = getActiveVoice();
  const playing = appState.transport.playheadSec >= 0;
  let sec = null;
  if (playing) sec = appState.transport.playheadSec;
  else if (hover && inPlot(hover, m)) sec = m.xToTime(hover.x);

  let midi = null;
  let norm = null;
  if (v && sec !== null && sec >= v.startTime && sec <= getVoiceEnd(v)) {
    const tn = (sec - v.startTime) / Math.max(1e-9, v.duration);
    norm = evaluateCurveObjectY(v, tn);
    midi = freqToMidi(mapNormYToFreq(v, norm));
  } else if (!playing && hover && inPlot(hover, m)) {
    if (m.piano) midi = m.yToVal(hover.y);
    else norm = m.yToVal(hover.y);
  }
  setText('hudTime', sec === null ? '—' : `${sec.toFixed(2)}s`);
  setText('hudNote', midi === null ? '—' : midiToNoteName(midi, { cents: true }));
  setText('hudHz', midi === null ? '—' : midiToFreq(midi).toFixed(2));
  setText('hudNorm', norm === null ? '—' : norm.toFixed(3));
  const badge = document.getElementById('hudRetroBadge');
  if (badge && v) badge.classList.toggle('hidden', !analyzeCurveFeatures(v, 120).hasRetrograde);
}

// ==========================================================================
// Main canvas interaction / 메인 캔버스 상호작용
// ==========================================================================

function hitTest(p, m) {
  const v = getActiveVoice();
  if (p.y < m.plotY && p.x >= m.plotX) return { type: 'ruler' };
  if (p.x < m.plotX && p.y >= m.plotY && p.y <= m.plotY + m.plotH) return { type: 'axis', axis: 'y' };
  if (p.y > m.plotY + m.plotH && p.x >= m.plotX) return { type: 'axis', axis: 'x' };
  const ectx = getCustomEditCtx(v);
  if (ectx && !appState.customFreehand) {
    const { anchors, handles } = customHandlesOnScreen(v, m, ectx);
    for (const h of handles) if (dist2(p.x, p.y, h.x, h.y) <= HIT_ANCHOR ** 2) return { type: 'handle', i: h.i, k: h.k };
    for (const a of anchors) if (dist2(p.x, p.y, a.x, a.y) <= HIT_ANCHOR ** 2) return { type: 'anchor', i: a.i };
  }
  if (v && appState.locateMode) {
    for (const tn of [0, 1]) {
      const x = m.timeToX(v.startTime + tn * v.duration);
      const y = voiceNormToPlotY(v, evaluateCurveObjectY(v, tn), m);
      if (dist2(p.x, p.y, x, y) <= (HIT_ANCHOR + 2) ** 2) return { type: tn === 0 ? 'start' : 'end' };
    }
  }
  if (!inPlot(p, m)) return { type: 'none' };
  // The editable spline's own curve (for bending / splitting) / 편집 스플라인 곡선
  if (ectx && !appState.locateMode) {
    const pts = ectx.nodeId ? renderedNodeCurve : renderedCurves.find((c) => c.id === v.id)?.pts;
    if (pts && distToPolyline(p, pts) < HIT_CURVE) return { type: 'customCurve' };
  }
  // Active voice first, then others (top-most drawn last) / 활성 보이스 우선
  let best = null;
  let bestD = HIT_CURVE;
  for (let i = renderedCurves.length - 1; i >= 0; i--) {
    const d = distToPolyline(p, renderedCurves[i].pts);
    if (d < bestD) {
      bestD = d;
      best = renderedCurves[i].id;
    }
  }
  if (best) return { type: 'curve', id: best };
  return { type: 'empty' };
}

function cursorFor(p, m) {
  if (drag) return drag.type === 'freehand' || drag.type === 'regionNew' ? 'crosshair' : drag.type === 'regionEdge' || drag.type === 'trim' ? 'ew-resize' : drag.type === 'bend' ? 'ns-resize' : 'grabbing';
  if (!p) return 'default';
  if (appState.selectMode && inPlot(p, m)) {
    const hit = regionHit(p, m, getActiveVoice());
    return hit ? (hit.part === 'body' ? 'grab' : 'ew-resize') : 'crosshair';
  }
  if (appState.customFreehand && isCustomEditable(getActiveVoice()) && inPlot(p, m)) return 'crosshair';
  const h = hitTest(p, m);
  if (h.type === 'ruler') return 'col-resize';
  if (h.type === 'axis') return h.axis === 'y' ? 'ns-resize' : 'ew-resize';
  if (h.type === 'anchor' || h.type === 'handle') return 'move';
  if (h.type === 'start' || h.type === 'end') return 'ew-resize';
  if (h.type === 'customCurve') return 'grab';
  if (h.type === 'curve') return appState.locateMode ? 'move' : 'pointer';
  if (h.type === 'empty') return 'grab';
  return 'default';
}

/**
 * Which pitch side (F₀ or F₁) a start/end dot displays: the curve's displayed value there is
 * ≈0 → F₀, ≈1 → F₁ (reverse/inverse can swap them); anything else → no repitch.
 * 시작/끝 점이 표시하는 음고 쪽 (reverse/inverse 반영), 0·1이 아니면 음고 변경 안 함.
 */
function pitchSideAtDot(v, tn) {
  const y = evaluateCurveObjectY(v, tn);
  if (Math.abs(y) < 0.05) return 'f0';
  if (Math.abs(y - 1) < 0.05) return 'f1';
  return null;
}

const snapTime = (sec) => (appState.locateSnap ? Math.round(sec * 10) / 10 : sec);
const snapSemis = (d) => (appState.locateSnap ? Math.round(d) : d);
const CANVAS_SCOPE = ['canvas', 'gain', 'panels', 'matrix'];

function editActive(fn, key) {
  const v = getActiveVoice();
  if (!v) return;
  updateVoices(fn, { ids: [v.id], coalesceKey: key, scope: CANVAS_SCOPE });
}

/**
 * Locate start / end dot edits: the active voice, or — with group edit on and 2+ voices selected —
 * the whole selection in the grapher's group edit mode (Sync / Ratio / Offset, core/state.js).
 * 이동 도구의 시작·끝 점 편집: 활성 보이스, 또는 그룹 편집이 켜져 있으면 선택 전체 (동기화·비율·덧셈).
 */
function editLocate(fn, key) {
  if (appState.groupApplyMode && appState.selectedVoiceIds.length > 1) updateVoices(fn, { coalesceKey: key, scope: CANVAS_SCOPE });
  else editActive(fn, key);
}

/** Raw (pre-reverse/inverse) normalized coordinates of a pointer for voice v. */
function pointerToRaw(v, p, m, flags = getCustomEditCtx(v)?.flags ?? v) {
  const xd = clamp((m.xToTime(p.x) - v.startTime) / Math.max(1e-9, v.duration), 0, 1);
  const yd = plotYToVoiceNorm(v, p.y, m);
  return { x: dispX(flags, xd), y: dispY(flags, yd) };
}

/**
 * Influence of handle k on segment p0→p1 at local x-fraction tx (Bernstein weight). Dividing a
 * vertical drag by it makes the curve point under the cursor follow the cursor.
 * 핸들 k의 영향도(번스타인 가중치) — 드래그량을 나눠 커서 아래 곡선 점이 커서를 따라가게 함.
 */
function bendWeight(p0, p1, k, tx) {
  const { xs } = getSegmentControlArrays(p0, p1);
  const n = xs.length - 1;
  const j = k + 1;
  const sp = solveSegmentParamS(xs, clamp(tx, 0, 1));
  let binom = 1;
  for (let q = 1; q <= j; q++) binom = (binom * (n - j + q)) / q;
  return Math.max(0.12, binom * sp ** j * (1 - sp) ** (n - j));
}

function setSelection(sel) {
  uiState.selection = sel;
  requestRender(['canvas']);
}

async function beginRulerDrag(p, m) {
  const sec = Math.max(0, m.xToTime(p.x));
  drag = { type: 'ruler', scrub: appState.scrubAudio && !isPlaying() };
  setCueSec(snapTime(sec));
  if (drag.scrub) await startScrubAudio(sec);
}

function onMainPointerDown(evt) {
  if (evt.button !== 0) return;
  const m = getMainMetrics();
  const p = pointerPos(evt, mainView);
  capture(mainView.canvas, evt.pointerId);
  const v = getActiveVoice();
  const ectx = getCustomEditCtx(v);

  if (appState.customFreehand && ectx && inPlot(p, m)) {
    drag = { type: 'freehand', raw: [], screen: [], nodeId: ectx.nodeId };
    drag.raw.push(pointerToRaw(v, p, m));
    drag.screen.push([p.x, p.y]);
    return;
  }
  const h = hitTest(p, m);
  if (h.type === 'ruler') { beginRulerDrag(p, m); return; }
  if (h.type === 'axis') {
    drag = { type: 'axis', axis: h.axis, p0: p, vp0: { ...appState.viewport } };
    return;
  }
  if (selectToolDown(evt, p, m, h)) return;
  if (h.type === 'anchor' || h.type === 'handle') {
    setSelection({ kind: h.type, voiceId: v.id, nodeId: ectx.nodeId, i: h.i, k: h.k });
    if (evt.shiftKey && h.type === 'anchor' && h.i < ectx.pts.length - 1) {
      editActive((vv) => { const pts = ptsOf(vv, ectx); elevateSplineSegmentHandles(pts[h.i], pts[h.i + 1], 0.5); }, 'elevate');
      endHistoryGesture();
      return;
    }
    drag = { ...h, nodeId: ectx.nodeId };
    return;
  }
  if (h.type === 'start' || h.type === 'end') {
    setSelection({ kind: h.type, voiceId: v.id });
    // ⌘ + drag: trim / extend along the curve (core/line-clip.js) / ⌘ + 드래그: 곡선을 따라 줄이기·늘리기
    if (evt.metaKey || evt.ctrlKey) drag = { type: 'trim', side: h.type, id: v.id, orig: trimOrig(v), moved: true };
    else drag = { type: h.type, orig: { start: v.startTime, end: getVoiceEnd(v) } };
    return;
  }
  if (h.type === 'customCurve') {
    // Bend the segment under the pointer: Shift adds a handle; otherwise drag the nearest
    // handle (creating one on a straight segment). / 선분 벤딩: Shift는 핸들 추가, 아니면 가장 가까운 핸들 드래그
    const raw = pointerToRaw(v, p, m);
    const i = findSplineSegmentIndex(ectx.pts, raw.x);
    const p0 = ectx.pts[i];
    const p1 = ectx.pts[i + 1];
    const u = clamp((raw.x - p0.x) / Math.max(1e-9, p1.x - p0.x), 0.05, 0.95);
    if (evt.shiftKey) {
      editActive((vv) => { const pts = ptsOf(vv, ectx); elevateSplineSegmentHandles(pts[i], pts[i + 1], u); }, 'elevate');
      endHistoryGesture();
      return;
    }
    if (!(p0.handles || []).length) {
      editActive((vv) => { const pts = ptsOf(vv, ectx); elevateSplineSegmentHandles(pts[i], pts[i + 1], u); }, 'custom-bend');
    }
    const now = getCustomEditCtx(getActiveVoice());
    const q0 = now.pts[i];
    const q1 = now.pts[i + 1];
    let k = 0;
    let best = Infinity;
    q0.handles.forEach((hh, kk) => { if (Math.abs(hh.u - u) < best) { best = Math.abs(hh.u - u); k = kk; } });
    const tx = (raw.x - q0.x) / Math.max(1e-9, q1.x - q0.x);
    setSelection({ kind: 'handle', voiceId: v.id, nodeId: ectx.nodeId, i, k });
    drag = { type: 'bend', i, k, nodeId: ectx.nodeId, raw0: raw.y, y0: q0.handles[k].y, w: bendWeight(q0, q1, k, tx) };
    return;
  }
  if (h.type === 'curve' && appState.locateMode && (evt.metaKey || evt.ctrlKey) && !evt.shiftKey) {
    // Locate + ⌘ + drag along x: trim / extend the nearer end along the curve; a ⌘-click without
    // moving keeps its old meaning (add to the selection, on pointer up).
    // 이동 + ⌘ + x 드래그: 가까운 끝을 곡선을 따라 줄이기·늘리기. 움직이지 않은 ⌘ 클릭은 기존대로 선택 추가.
    const target = getVoiceById(h.id);
    if (target) {
      const sec = m.xToTime(p.x);
      drag = { type: 'trim', side: sec < target.startTime + target.duration / 2 ? 'start' : 'end', id: h.id, orig: trimOrig(target), p0: p, moved: false };
      return;
    }
  }
  if (h.type === 'curve') {
    const mod = evt.shiftKey || evt.metaKey || evt.ctrlKey;
    const inSel = appState.selectedVoiceIds.length > 1 && appState.selectedVoiceIds.includes(h.id);
    if (mod) selectVoice(h.id, { additive: evt.metaKey || evt.ctrlKey, range: evt.shiftKey });
    // a line of the selection: it becomes the active voice, the selection stays (so the group can
    // be dragged by any of its lines) / 선택된 선: 활성만 바꾸고 선택은 유지
    else if (inSel) { if (h.id !== appState.activeVoiceId) selectVoice(h.id, { keep: true }); }
    else if (h.id !== appState.activeVoiceId || appState.selectedVoiceIds.length > 1) selectVoice(h.id, { additive: !!appState.multiSelectMode });
    setSelection(null);
    const target = getVoiceById(h.id);
    if (appState.locateMode && target) {
      // Group edit on: the whole selection moves with the dragged line / 그룹 편집: 선택 전체가 함께 이동
      const sel = appState.selectedVoiceIds;
      const group = (appState.groupApplyMode && sel.length > 1 && sel.includes(h.id) ? sel.map(getVoiceById).filter(Boolean) : [target])
        .map((g) => ({ id: g.id, start: g.startTime, f0: g.f0Hz, f1: g.f1Hz }));
      drag = { type: 'move', id: h.id, p0: p, orig: { start: target.startTime, f0: target.f0Hz, f1: target.f1Hz }, group, midi0: m.piano ? m.yToVal(p.y) : 0 };
    }
    return;
  }
  if (h.type === 'empty') {
    setSelection(null);
    drag = { type: 'pan', p0: p, vp0: { ...appState.viewport } };
  }
}

function panViewport(m, vp, dx, dy, { time = true, value = true } = {}) {
  const patch = {};
  if (time) {
    const dSec = (dx / m.plotW) * (vp.timeMax - vp.timeMin);
    Object.assign(patch, { timeMin: vp.timeMin - dSec, timeMax: vp.timeMax - dSec });
  }
  if (value) {
    const span = m.piano ? vp.midiMax - vp.midiMin : vp.normYMax - vp.normYMin;
    const dVal = (dy / m.plotH) * span;
    if (m.piano) {
      const lo = clamp(vp.midiMin + dVal, 0, 127 - span);
      Object.assign(patch, { midiMin: lo, midiMax: lo + span });
    } else {
      Object.assign(patch, { normYMin: vp.normYMin + dVal, normYMax: vp.normYMax + dVal });
    }
  }
  setViewport(patch);
}

function onMainPointerMove(evt) {
  const m = getMainMetrics();
  const p = pointerPos(evt, mainView);
  hover = p;
  if (!drag) {
    requestRender(['canvas']);
    return;
  }
  const v = getActiveVoice();
  const ectx = { nodeId: drag.nodeId ?? null };
  if (drag.type === 'regionNew' || drag.type === 'regionEdge' || drag.type === 'regionMove') {
    selectToolMove(p, m);
    return;
  }
  switch (drag.type) {
    case 'ruler': {
      const sec = Math.max(0, m.xToTime(p.x));
      setCueSec(snapTime(sec));
      if (drag.scrub) updateScrubAudio(sec);
      break;
    }
    case 'pan':
      panViewport(m, drag.vp0, p.x - drag.p0.x, p.y - drag.p0.y);
      break;
    case 'axis':
      panViewport(m, drag.vp0, p.x - drag.p0.x, p.y - drag.p0.y, { time: drag.axis === 'x', value: drag.axis === 'y' });
      break;
    case 'anchor': {
      const raw = pointerToRaw(v, p, m);
      editActive((vv) => {
        const pts = ptsOf(vv, ectx);
        const i = drag.i;
        const last = pts.length - 1;
        if (!pts[i]) return;
        const x = i === 0 ? 0 : i === last ? 1 : clamp(raw.x, pts[i - 1].x + 0.002, pts[i + 1].x - 0.002);
        pts[i].x = roundTo(x, 4);
        pts[i].y = roundTo(raw.y, 4);
      }, 'custom-anchor');
      break;
    }
    case 'handle': {
      const raw = pointerToRaw(v, p, m);
      editActive((vv) => {
        const pts = ptsOf(vv, ectx);
        const p0 = pts[drag.i];
        const p1 = pts[drag.i + 1];
        const h = p0?.handles?.[drag.k];
        if (!h || !p1) return;
        h.u = roundTo(clamp((raw.x - p0.x) / Math.max(1e-9, p1.x - p0.x), 0.01, 0.99), 4);
        h.y = roundTo(raw.y, 4);
      }, drag.key || 'custom-handle');
      break;
    }
    case 'bend': {
      const raw = pointerToRaw(v, p, m);
      editActive((vv) => {
        const h = ptsOf(vv, ectx)[drag.i]?.handles?.[drag.k];
        if (h) h.y = roundTo(drag.y0 + (raw.y - drag.raw0) / drag.w, 4);
      }, 'custom-bend');
      break;
    }
    case 'start':
    case 'end': {
      const sec = snapTime(clamp(m.xToTime(p.x), 0, MAX_TIME));
      const midi = m.piano ? snapSemis(m.yToVal(p.y)) : null;
      editLocate((vv) => {
        const side = pitchSideAtDot(vv, drag.type === 'start' ? 0 : 1);
        if (drag.type === 'start') {
          const start = Math.min(sec, drag.orig.end - MIN_DURATION);
          vv.startTime = Math.max(0, start);
          vv.duration = clamp(drag.orig.end - vv.startTime, MIN_DURATION, MAX_TIME);
        } else {
          vv.duration = clamp(sec - vv.startTime, MIN_DURATION, MAX_TIME);
        }
        if (midi !== null && side) setVoicePitch(vv, side, { midi });
      }, `locate-${drag.type}`);
      break;
    }
    case 'trim': {
      if (!drag.moved && Math.abs(p.x - drag.p0.x) < 3) break;
      drag.moved = true;
      const sec = snapTime(clamp(m.xToTime(p.x), 0, MAX_TIME));
      // y is ignored on purpose: the line keeps its own shape / y는 무시 — 선은 자기 모양 그대로
      updateVoices((vv) => trimLineEdge(vv, drag.orig, drag.side, sec, { minDur: MIN_DURATION, maxTime: MAX_TIME }), { ids: [drag.id], coalesceKey: `locate-trim-${drag.side}`, scope: CANVAS_SCOPE });
      break;
    }
    case 'move': {
      const target = getVoiceById(drag.id);
      if (!target) break;
      const dSec = m.xToTime(p.x) - m.xToTime(drag.p0.x);
      const dSemi = m.piano ? snapSemis(m.yToVal(p.y) - drag.midi0) : 0;
      // The dragged line snaps; the other selected lines follow it: by the same time shift (Sync /
      // Offset — a rigid move) or with their start scaled by the same factor (Ratio). Pitch always
      // moves by the same interval. / 끄는 선이 스냅되고 나머지 선택 선이 따라감: 같은 시간 이동(동기화·
      // 덧셈) 또는 시작 시각에 같은 배율(비율). 음고는 항상 같은 음정.
      const leadStart = clamp(snapTime(drag.orig.start + dSec), 0, MAX_TIME);
      const ratio = appState.groupEditMode === 'ratio' && drag.orig.start > 1e-6 ? leadStart / drag.orig.start : null;
      const by = new Map(drag.group.map((g) => [g.id, g]));
      updateVoices((vv) => {
        const g = by.get(vv.id);
        if (!g) return;
        vv.startTime = clamp(vv.id === drag.id ? leadStart : ratio !== null ? g.start * ratio : g.start + (leadStart - drag.orig.start), 0, MAX_TIME);
        if (m.piano) {
          setVoicePitch(vv, 'f0', { hz: g.f0 * 2 ** (dSemi / 12) });
          setVoicePitch(vv, 'f1', { hz: g.f1 * 2 ** (dSemi / 12) });
        }
      }, { ids: drag.group.map((g) => g.id), coalesceKey: 'locate-move', scope: CANVAS_SCOPE });
      break;
    }
    case 'freehand': {
      drag.raw.push(pointerToRaw(v, p, m));
      drag.screen.push([p.x, p.y]);
      requestRender(['canvas']);
      break;
    }
    default:
      break;
  }
}

function onMainPointerUp(evt) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try { mainView.canvas.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
  if (d.type === 'ruler' && d.scrub) stopScrubAudio();
  if (d.type === 'trim' && !d.moved) selectVoice(d.id, { additive: true }); // plain ⌘-click / 그냥 ⌘ 클릭
  selectToolUp(d);
  if (d.type === 'freehand') {
    const pts = fitStrokeToSpline(d.raw);
    if (pts) {
      editActive((vv) => {
        if (!d.nodeId) vv.customPoints = pts;
        else { const n = vv.morphNodes.find((x) => x.id === d.nodeId); if (n) n.customPoints = pts; }
      }, 'freehand');
      setPref('customFreehand', false, ['canvas', 'panels']);
    }
  }
  endHistoryGesture();
  requestRender(['canvas']);
}

function onMainDblClick(evt) {
  const m = getMainMetrics();
  const p = pointerPos(evt, mainView);
  const v = getActiveVoice();
  const ectx = getCustomEditCtx(v);
  const h = hitTest(p, m);
  if (ectx && (h.type === 'customCurve' || h.type === 'handle')) {
    // Double-click on the spline (or a handle that a click just created) splits there
    // 스플라인 더블클릭: 해당 위치 분할
    const raw = pointerToRaw(v, p, m);
    endHistoryGesture();
    editActive((vv) => {
      const pts = ptsOf(vv, ectx);
      const i = findSplineSegmentIndex(pts, raw.x);
      splitSplineSegmentPreservingShape(pts, i, raw.x);
    }, 'custom-split');
    endHistoryGesture();
    setSelection(null);
    return;
  }
  if (h.type === 'empty' || h.type === 'ruler') {
    const sec = Math.max(0, snapTime(m.xToTime(p.x)));
    setCueSec(sec);
    showToastFn(t('toast.cueSet', sec.toFixed(2)));
    return;
  }
  // Locate + double-click on a line: ✂ split it there into two linked pieces / 이동 + 선 더블클릭: 그 자리에서 자르기
  if (h.type === 'curve' && appState.locateMode) {
    const target = getVoiceById(h.id);
    endHistoryGesture();
    const ev = target ? splitVoice(h.id, snapTime(m.xToTime(p.x))) : null;
    endHistoryGesture();
    if (ev?.result) showToastFn(t('clip.splitDone', target.name));
    else showToastFn(t('clip.splitNa'));
  }
}

/** Snapshot of a line before a ⌘-drag trim. / ⌘ 드래그 전 스냅샷 */
function trimOrig(v) {
  return { startTime: v.startTime, duration: v.duration, clip: v.clip ? { ...v.clip } : undefined };
}

function onMainContextMenu(evt) {
  const m = getMainMetrics();
  const p = pointerPos(evt, mainView);
  const v = getActiveVoice();
  const ectx = getCustomEditCtx(v);
  const h = hitTest(p, m);
  if (!ectx) return;
  if (h.type === 'anchor') {
    evt.preventDefault();
    editActive((vv) => removeSplinePoint(ptsOf(vv, ectx), h.i), 'custom-remove');
    endHistoryGesture();
    setSelection(null);
  } else if (h.type === 'handle') {
    evt.preventDefault();
    editActive((vv) => ptsOf(vv, ectx)[h.i]?.handles?.splice(h.k, 1), 'custom-remove-handle');
    endHistoryGesture();
    setSelection(null);
  }
}

/**
 * Arrow-key nudge (main.js). With a selected custom point/handle → move it in raw 0–1 space;
 * with a selected Locate start/end dot → move that end in time and pitch; otherwise move the
 * whole target voice(s). dx/dy are −1/0/+1; coarse = Shift. One key-hold = one undo step
 * (the caller ends the gesture on keyup). Returns true when something moved.
 * 방향키 미세 이동: 선택 점/핸들 → 0–1 공간, Locate 끝점 → 시간·음고, 그 외 → 보이스 전체.
 */
export function nudgeSelection(dx, dy, coarse = false) {
  const v = getActiveVoice();
  if (!v) return false;
  const sel = uiState.selection && uiState.selection.voiceId === v.id ? uiState.selection : null;
  const ectx = getCustomEditCtx(v);
  if (sel && (sel.kind === 'anchor' || sel.kind === 'handle') && ectx && (sel.nodeId || null) === ectx.nodeId) {
    const step = coarse ? 0.05 : 0.005;
    // dx/dy are on screen; convert to raw space through the display flags / 화면 → 원본 방향
    const rx = (ectx.flags.reverse ? -dx : dx) * step;
    const ry = (ectx.flags.inverse ? -dy : dy) * step;
    editActive((vv) => {
      const pts = ptsOf(vv, ectx);
      if (sel.kind === 'anchor') {
        const pt = pts[sel.i];
        if (!pt) return;
        const last = pts.length - 1;
        if (sel.i > 0 && sel.i < last) pt.x = roundTo(clamp(pt.x + rx, pts[sel.i - 1].x + 0.002, pts[sel.i + 1].x - 0.002), 4);
        pt.y = roundTo(pt.y + ry, 4);
      } else {
        const h = pts[sel.i]?.handles?.[sel.k];
        if (!h) return;
        h.u = roundTo(clamp(h.u + rx, 0.01, 0.99), 4);
        h.y = roundTo(h.y + ry, 4);
      }
    }, 'nudge');
    return true;
  }
  if (sel && (sel.kind === 'start' || sel.kind === 'end') && appState.locateMode) {
    const dt = dx * (coarse ? 0.1 : 0.01);
    const dSemi = dy * (coarse ? 1 : 0.1);
    editLocate((vv) => {
      if (sel.kind === 'start') {
        const end = getVoiceEnd(vv);
        vv.startTime = clamp(vv.startTime + dt, 0, end - MIN_DURATION);
        vv.duration = clamp(end - vv.startTime, MIN_DURATION, MAX_TIME);
      } else {
        vv.duration = clamp(vv.duration + dt, MIN_DURATION, MAX_TIME);
      }
      const side = pitchSideAtDot(vv, sel.kind === 'start' ? 0 : 1);
      if (side && dSemi) setVoicePitch(vv, side, { hz: vv[`${side}Hz`] * 2 ** (dSemi / 12) });
    }, 'nudge');
    return true;
  }
  // Whole voice(s): time ← →, transpose ↑ ↓ (honours Group Apply) / 보이스 전체 이동
  const dt = dx * (coarse ? 0.1 : 0.01);
  const dSemi = dy * (coarse ? 1 : 0.1);
  updateVoices((vv) => {
    vv.startTime = clamp(vv.startTime + dt, 0, MAX_TIME);
    if (dSemi) {
      setVoicePitch(vv, 'f0', { hz: vv.f0Hz * 2 ** (dSemi / 12) });
      setVoicePitch(vv, 'f1', { hz: vv.f1Hz * 2 ** (dSemi / 12) });
    }
  }, { coalesceKey: 'nudge', scope: CANVAS_SCOPE });
  return true;
}

/** Clear the canvas point selection (Escape). / 선택 해제 */
export function clearCanvasSelection() {
  setSelection(null);
  if (uiState.regionSel) selectRegion(null);
}

// ==========================================================================
// Local regions (Select tool) / 로컬 구간 (선택 도구)
// ==========================================================================

const REGION_EDGE_HIT = 6;
const tnToSec = (v, tn) => v.startTime + tn * v.duration;
const secToTn = (v, sec) => clamp((sec - v.startTime) / Math.max(1e-9, v.duration), 0, 1);

/** Currently selected region of the active voice, or null. / 선택된 구간 */
export function getSelectedRegion(v = getActiveVoice()) {
  const sel = uiState.regionSel;
  if (!v || !sel || sel.voiceId !== v.id) return null;
  return (v.regions || []).find((r) => r.id === sel.regionId) || null;
}

/** Select a region (null clears; also leaves region-curve editing). / 구간 선택 */
export function selectRegion(sel) {
  uiState.regionSel = sel;
  if (!sel) uiState.regionEdit = false;
  requestRender(['canvas', 'panels']);
}

/** Delete the selected region; returns true when one was deleted. / 선택 구간 삭제 */
export function deleteSelectedRegion() {
  const v = getActiveVoice();
  const r = getSelectedRegion(v);
  if (!r) return false;
  updateVoices((vv) => { vv.regions = (vv.regions || []).filter((x) => x.id !== r.id); }, { ids: [v.id], scope: CANVAS_SCOPE });
  selectRegion(null);
  showToastFn(t('toast.regionDeleted'));
  return true;
}

function regionHit(p, m, v) {
  if (!v || !Array.isArray(v.regions)) return null;
  for (let k = v.regions.length - 1; k >= 0; k--) {
    const r = v.regions[k];
    const x0 = m.timeToX(tnToSec(v, r.t0));
    const x1 = m.timeToX(tnToSec(v, r.t1));
    if (Math.abs(p.x - x0) <= REGION_EDGE_HIT) return { region: r, part: 't0' };
    if (Math.abs(p.x - x1) <= REGION_EDGE_HIT) return { region: r, part: 't1' };
    if (p.x > x0 && p.x < x1) return { region: r, part: 'body' };
  }
  return null;
}

/**
 * Region bands of the active voice: amber (normal), rose (mute), yellow (solo); ramp zones
 * as gradients, the selected region's own target curve dashed.
 * 활성 보이스의 구간 띠, 램프 구간 그라디언트, 선택 구간의 목표 곡선(점선).
 */
function drawRegions(ctx, m) {
  const v = getActiveVoice();
  const list = v?.regions || [];
  const pending = drag?.type === 'regionNew' ? drag : null;
  if (!list.length && !pending) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
  ctx.clip();
  const selR = getSelectedRegion(v);
  list.forEach((r, idx) => {
    const x0 = m.timeToX(tnToSec(v, r.t0));
    const x1 = m.timeToX(tnToSec(v, r.t1));
    const rgb = r.solo ? '250,204,21' : r.mute ? '244,63,94' : '245,158,11';
    const on = r === selR;
    ctx.fillStyle = `rgba(${rgb},${on ? 0.13 : 0.07})`;
    ctx.fillRect(x0, m.plotY, x1 - x0, m.plotH);
    const rn = regionRampNorm(r, v.duration);
    const rw = (rn * v.duration * m.plotW) / Math.max(1e-6, m.vp.timeMax - m.vp.timeMin);
    for (const side of ['in', 'out']) {
      if (rw < 1 || !regionEdgeRamped(v, r, side)) continue;
      const xa = side === 'in' ? x0 : x1 - rw;
      const g = ctx.createLinearGradient(xa, 0, xa + rw, 0);
      g.addColorStop(side === 'in' ? 0 : 1, `rgba(${rgb},0)`);
      g.addColorStop(side === 'in' ? 1 : 0, `rgba(${rgb},0.22)`);
      ctx.fillStyle = g;
      ctx.fillRect(xa, m.plotY, rw, m.plotH);
    }
    ctx.strokeStyle = `rgba(${rgb},${on ? 0.95 : 0.5})`;
    ctx.lineWidth = on ? 2 : 1;
    ctx.setLineDash(on ? [] : [4, 3]);
    for (const x of [x0, x1]) {
      ctx.beginPath();
      ctx.moveTo(x, m.plotY);
      ctx.lineTo(x, m.plotY + m.plotH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const tags = [`R${idx + 1}`, `${Math.round(r.mix * 100)}%`, r.solo ? 'S' : '', r.mute ? 'M' : '', r.gainDb ? `${r.gainDb > 0 ? '+' : ''}${r.gainDb}dB` : ''].filter(Boolean).join(' · ');
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = `rgba(${rgb},0.95)`;
    ctx.fillText(tags, x0 + 4, m.plotY + 12);
    if (on && r.mix > 0) {
      // The region's own target curve (before mix / ramps) / 구간 목표 곡선
      const pts = [];
      const n = clamp(Math.ceil((x1 - x0) / 2), 8, 600);
      for (let i = 0; i <= n; i++) {
        const tn = r.t0 + ((r.t1 - r.t0) * i) / n;
        pts.push([m.timeToX(tnToSec(v, tn)), voiceNormToPlotY(v, regionTargetY(v, r, tn), m)]);
      }
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(253,224,71,0.85)';
      strokePolyline(ctx, pts);
      ctx.setLineDash([]);
    }
  });
  if (pending) {
    const a = m.timeToX(tnToSec(v, Math.min(pending.t0, pending.t1)));
    const b = m.timeToX(tnToSec(v, Math.max(pending.t0, pending.t1)));
    ctx.fillStyle = 'rgba(56,189,248,0.15)';
    ctx.fillRect(a, m.plotY, b - a, m.plotH);
    ctx.strokeStyle = 'rgba(56,189,248,0.9)';
    ctx.strokeRect(a + 0.5, m.plotY + 0.5, b - a - 1, m.plotH - 1);
  }
  ctx.restore();
}

/** Select-tool pointer down; returns true when it handled the gesture. / 선택 도구 포인터 다운 */
function selectToolDown(evt, p, m, h) {
  if (!appState.selectMode || !inPlot(p, m)) return false;
  if (h.type === 'curve' && h.id !== appState.activeVoiceId) return false; // let it switch voice
  const v = getActiveVoice();
  if (!v) return false;
  const hit = regionHit(p, m, v);
  const tn = secToTn(v, m.xToTime(p.x));
  if (hit) {
    selectRegion({ voiceId: v.id, regionId: hit.region.id });
    drag = hit.part === 'body'
      ? { type: 'regionMove', regionId: hit.region.id, grab: tn, t0: hit.region.t0, t1: hit.region.t1 }
      : { type: 'regionEdge', regionId: hit.region.id, part: hit.part };
    return true;
  }
  drag = { type: 'regionNew', voiceId: v.id, t0: tn, t1: tn, p0: p };
  return true;
}

function selectToolMove(p, m) {
  const v = getActiveVoice();
  if (!v) return;
  const sec = clamp(m.xToTime(p.x), v.startTime, getVoiceEnd(v));
  const tn = secToTn(v, appState.locateSnap ? clamp(snapTime(sec), v.startTime, getVoiceEnd(v)) : sec);
  if (drag.type === 'regionNew') {
    drag.t1 = tn;
    requestRender(['canvas']);
    return;
  }
  const edit = (fn) => updateVoices((vv) => { const r = (vv.regions || []).find((x) => x.id === drag.regionId); if (r) fn(r); }, { ids: [v.id], coalesceKey: `region-${drag.type}`, scope: CANVAS_SCOPE });
  if (drag.type === 'regionEdge') {
    edit((r) => {
      if (drag.part === 't0') r.t0 = roundTo(clamp(tn, 0, r.t1 - 0.005), 5);
      else r.t1 = roundTo(clamp(tn, r.t0 + 0.005, 1), 5);
    });
  } else if (drag.type === 'regionMove') {
    const w = drag.t1 - drag.t0;
    const t0 = clamp(drag.t0 + (secToTn(v, sec) - drag.grab), 0, 1 - w);
    edit((r) => { r.t0 = roundTo(t0, 5); r.t1 = roundTo(t0 + w, 5); });
  }
}

function selectToolUp(d) {
  if (d.type !== 'regionNew') return;
  const v = getVoiceById(d.voiceId);
  if (!v) return;
  const lo = Math.min(d.t0, d.t1);
  const hi = Math.max(d.t0, d.t1);
  if ((hi - lo) * v.duration < 0.01) { selectRegion(null); return; } // a click clears / 클릭은 선택 해제
  if ((v.regions || []).length >= MAX_REGIONS_PER_VOICE) return;
  const region = createDefaultRegion(lo, hi, v);
  updateVoices((vv) => { vv.regions = [...(vv.regions || []), region]; }, { ids: [v.id], scope: CANVAS_SCOPE });
  selectRegion({ voiceId: v.id, regionId: region.id });
}

function onMainWheel(evt) {
  evt.preventDefault();
  const m = getMainMetrics();
  const p = pointerPos(evt, mainView);
  const dy = evt.deltaY;
  if (evt.ctrlKey || evt.metaKey) {
    const f = dy > 0 ? 1.12 : 1 / 1.12;
    zoomTime(f, m.xToTime(p.x));
    zoomPitch(f, m.yToVal(p.y));
  } else if (evt.shiftKey || Math.abs(evt.deltaX) > Math.abs(dy)) {
    const vp = appState.viewport;
    const d = ((evt.deltaX || dy) / m.plotW) * (vp.timeMax - vp.timeMin);
    setViewport({ timeMin: vp.timeMin + d, timeMax: vp.timeMax + d });
  } else {
    const vp = appState.viewport;
    if (m.piano) {
      const span = vp.midiMax - vp.midiMin;
      const lo = clamp(vp.midiMin - (dy / m.plotH) * span, 0, 127 - span);
      setViewport({ midiMin: lo, midiMax: lo + span });
    } else {
      const span = vp.normYMax - vp.normYMin;
      const d = -(dy / m.plotH) * span;
      setViewport({ normYMin: vp.normYMin + d, normYMax: vp.normYMax + d });
    }
  }
}

// ==========================================================================
// Gain canvas / 게인 캔버스
// ==========================================================================

function gainMetrics() {
  const plotX = GPAD.left;
  const plotY = GPAD.top;
  const plotW = Math.max(10, gainView.w - GPAD.left - GPAD.right);
  const plotH = Math.max(10, gainView.h - GPAD.top - GPAD.bottom);
  return {
    plotX, plotY, plotW, plotH,
    tToX: (tn) => plotX + tn * plotW,
    xToT: (x) => (x - plotX) / plotW,
    yToEnv: (y) => 1 - (y - plotY) / plotH,
    envToY: (e) => plotY + (1 - e) * plotH,
  };
}

const gainPointsEditable = (v) => v && v.gainMode !== 'engine' && Array.isArray(v.gainPoints);

function gainHandlesOnScreen(v, g) {
  const anchors = [];
  const handles = [];
  const pts = v.gainPoints;
  pts.forEach((p, i) => {
    anchors.push({ i, x: g.tToX(p.x), y: g.envToY(p.y) });
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      (p.handles || []).forEach((h, k) => handles.push({ i, k, x: g.tToX(p.x + h.u * (q.x - p.x)), y: g.envToY(h.y), ax: anchors[i] }));
    }
  });
  return { anchors, handles };
}

/** Redraw the [function] gain-envelope canvas for the active voice. / 게인 캔버스 다시 그리기 */
export function renderGainCanvas() {
  if (!gainView.canvas) return;
  sizeCanvas(gainView);
  const ctx = gainView.ctx;
  const g = gainMetrics();
  ctx.setTransform(gainView.dpr, 0, 0, gainView.dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, gainView.w, gainView.h);
  ctx.fillStyle = COLORS.plot;
  ctx.fillRect(g.plotX, g.plotY, g.plotW, g.plotH);
  ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  // dB unit: label the grid in dB through the voice's taper (A/B) / dB 단위는 dB 눈금
  const unitVoice = getActiveVoice();
  const dbAxis = unitVoice?.gainUnit === 'db' ? envelopeTaper(voiceEnvelopeOpts(unitVoice).dbRange, unitVoice.dbTaper) : null;
  for (const e of [0, 0.25, 0.5, 0.75, 1]) {
    const y = g.envToY(e);
    ctx.strokeStyle = e === 0 || e === 1 ? COLORS.gridStrong : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(g.plotX, y);
    ctx.lineTo(g.plotX + g.plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.label;
    let label = e.toFixed(2);
    if (dbAxis) {
      const d = dbAxis.normToDb(e);
      label = Number.isFinite(d) ? `${Math.round(d)}` : '−∞';
    } else if (unitVoice?.gainUnit === 'sone') label = `${e.toFixed(2)}s`;
    ctx.fillText(label, g.plotX - 4, y);
  }
  const sub = Number(appState.gridSub) || 0;
  for (let k = 0; sub > 0 && k <= sub; k++) {
    const x = g.tToX(k / sub);
    ctx.strokeStyle = k === 0 || k === sub ? COLORS.gridStrong : COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(x, g.plotY);
    ctx.lineTo(x, g.plotY + g.plotH);
    ctx.stroke();
  }
  const v = getActiveVoice();
  if (!v) return;
  const range = v.gainMode === 'engine' ? getGainEngineRange(v.gainEngineObj) : undefined;
  const n = clamp(Math.ceil(g.plotW / 1.5), 32, 1600);
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const tn = i / n;
    const y = g.envToY(evaluateVoiceGainAtNormT(v, tn, { range }));
    if (i === 0) ctx.moveTo(g.tToX(tn), y);
    else ctx.lineTo(g.tToX(tn), y);
  }
  ctx.strokeStyle = v.gainMode === 'engine' ? '#a78bfa' : COLORS.gain;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(g.tToX(1), g.envToY(0));
  ctx.lineTo(g.tToX(0), g.envToY(0));
  ctx.closePath();
  ctx.fillStyle = v.gainMode === 'engine' ? 'rgba(167,139,250,0.10)' : 'rgba(52,211,153,0.10)';
  ctx.fill();

  if (gainPointsEditable(v)) {
    const { anchors, handles } = gainHandlesOnScreen(v, g);
    for (const h of handles) {
      ctx.strokeStyle = 'rgba(52,211,153,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(h.ax.x, h.ax.y);
      ctx.lineTo(h.x, h.y);
      ctx.stroke();
      ctx.fillStyle = '#6ee7b7';
      ctx.beginPath();
      ctx.moveTo(h.x, h.y - 5);
      ctx.lineTo(h.x + 5, h.y);
      ctx.lineTo(h.x, h.y + 5);
      ctx.lineTo(h.x - 5, h.y);
      ctx.closePath();
      ctx.fill();
    }
    for (const a of anchors) {
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = COLORS.gain;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  const ph = appState.transport.playheadSec;
  if (ph >= v.startTime && ph <= getVoiceEnd(v)) {
    drawPlayheadLine(ctx, g.tToX((ph - v.startTime) / v.duration), g.plotY, g.plotY + g.plotH);
  }
  updateGainHud(v, g, range);
}

function updateGainHud(v, g, range) {
  const el = document.getElementById('gainHoverHud');
  if (!el) return;
  if (!gainHover || gainHover.x < g.plotX || gainHover.x > g.plotX + g.plotW) {
    const blank = t('gain.hud', '--.--', '-.--', '--.-');
    if (el.textContent !== blank) el.textContent = blank;
    return;
  }
  const tn = clamp(g.xToT(gainHover.x), 0, 1);
  const env = evaluateVoiceGainAtNormT(v, tn, { range });
  const db = ampToDb(envelopeToAmp(env, v.gainUnit, voiceEnvelopeOpts(v)));
  el.textContent = t('gain.hud', (v.startTime + tn * v.duration).toFixed(2), env.toFixed(2), db <= -96 ? '−∞' : db.toFixed(1));
}

function gainHit(p, v, g) {
  if (!gainPointsEditable(v)) return null;
  const { anchors, handles } = gainHandlesOnScreen(v, g);
  for (const h of handles) if (dist2(p.x, p.y, h.x, h.y) <= HIT_ANCHOR ** 2) return { type: 'handle', i: h.i, k: h.k };
  for (const a of anchors) if (dist2(p.x, p.y, a.x, a.y) <= HIT_ANCHOR ** 2) return { type: 'anchor', i: a.i };
  return null;
}

function editGain(fn, key) {
  const v = getActiveVoice();
  if (v) updateVoices(fn, { ids: [v.id], coalesceKey: key, scope: ['gain', 'canvas'] });
}

function onGainPointerDown(evt) {
  if (evt.button !== 0) return;
  const v = getActiveVoice();
  const g = gainMetrics();
  const p = pointerPos(evt, gainView);
  const h = gainHit(p, v, g);
  if (!h) {
    if (!gainPointsEditable(v)) return;
    const tn = clamp(g.xToT(p.x), 0, 1);
    const i = findSplineSegmentIndex(v.gainPoints, tn);
    const p0 = v.gainPoints[i];
    const p1 = v.gainPoints[i + 1];
    if (!p0 || !p1) return;
    const u = clamp((tn - p0.x) / Math.max(1e-9, p1.x - p0.x), 0.05, 0.95);
    if (evt.shiftKey) {
      editGain((vv) => elevateSplineSegmentHandles(vv.gainPoints[i], vv.gainPoints[i + 1], u), 'gain-elevate');
      endHistoryGesture();
      return;
    }
    // Segment bending: drag on the envelope line bends that segment (creates a handle on a
    // straight segment, otherwise drags the nearest handle). / 선분 벤딩
    const onLine = Math.abs(g.envToY(evaluateVoiceGainAtNormT(v, tn)) - p.y) <= HIT_CURVE;
    if (!onLine) return;
    if (!(p0.handles || []).length) {
      editGain((vv) => elevateSplineSegmentHandles(vv.gainPoints[i], vv.gainPoints[i + 1], u), 'gain-bend');
    }
    const cur = getActiveVoice().gainPoints;
    const q0 = cur[i];
    const q1 = cur[i + 1];
    let k = 0;
    let best = Infinity;
    q0.handles.forEach((hh, kk) => { if (Math.abs(hh.u - u) < best) { best = Math.abs(hh.u - u); k = kk; } });
    capture(gainView.canvas, evt.pointerId);
    gainDrag = { type: 'bend', i, k, env0: g.yToEnv(p.y), y0: q0.handles[k].y, w: bendWeight(q0, q1, k, (tn - q0.x) / Math.max(1e-9, q1.x - q0.x)) };
    return;
  }
  capture(gainView.canvas, evt.pointerId);
  gainDrag = h;
}

function onGainPointerMove(evt) {
  const g = gainMetrics();
  const p = pointerPos(evt, gainView);
  gainHover = p;
  const v = getActiveVoice();
  if (!gainDrag || !v) {
    gainView.canvas.style.cursor = gainHit(p, v, g) ? 'move' : gainPointsEditable(v) ? 'crosshair' : 'default';
    requestRender(['gain']);
    return;
  }
  const tn = clamp(g.xToT(p.x), 0, 1);
  const env = clamp(g.yToEnv(p.y), 0, 1);
  if (gainDrag.type === 'bend') {
    editGain((vv) => {
      const h = vv.gainPoints[gainDrag.i]?.handles?.[gainDrag.k];
      if (h) h.y = roundTo(clamp(gainDrag.y0 + (g.yToEnv(p.y) - gainDrag.env0) / gainDrag.w, -0.5, 1.5), 4);
    }, 'gain-bend');
  } else if (gainDrag.type === 'anchor') {
    editGain((vv) => {
      const pts = vv.gainPoints;
      const i = gainDrag.i;
      const last = pts.length - 1;
      pts[i].x = roundTo(i === 0 ? 0 : i === last ? 1 : clamp(tn, pts[i - 1].x + 0.002, pts[i + 1].x - 0.002), 4);
      pts[i].y = roundTo(env, 4);
    }, 'gain-anchor');
  } else {
    editGain((vv) => {
      const p0 = vv.gainPoints[gainDrag.i];
      const p1 = vv.gainPoints[gainDrag.i + 1];
      const h = p0.handles[gainDrag.k];
      if (!h) return;
      h.u = roundTo(clamp((tn - p0.x) / Math.max(1e-9, p1.x - p0.x), 0.01, 0.99), 4);
      h.y = roundTo(clamp(g.yToEnv(p.y), -0.5, 1.5), 4);
    }, 'gain-handle');
  }
}

function onGainPointerUp(evt) {
  if (!gainDrag) return;
  gainDrag = null;
  try { gainView.canvas.releasePointerCapture(evt.pointerId); } catch { /* not captured */ }
  endHistoryGesture();
}

function onGainDblClick(evt) {
  const v = getActiveVoice();
  if (!gainPointsEditable(v)) return;
  const g = gainMetrics();
  const p = pointerPos(evt, gainView);
  if (gainHit(p, v, g)) return;
  const tn = clamp(g.xToT(p.x), 0.001, 0.999);
  editGain((vv) => {
    const i = findSplineSegmentIndex(vv.gainPoints, tn);
    splitSplineSegmentPreservingShape(vv.gainPoints, i, tn);
  }, 'gain-split');
  endHistoryGesture();
}

function onGainContextMenu(evt) {
  const v = getActiveVoice();
  const g = gainMetrics();
  const h = gainHit(pointerPos(evt, gainView), v, g);
  if (!h) return;
  evt.preventDefault();
  if (h.type === 'anchor') editGain((vv) => removeSplinePoint(vv.gainPoints, h.i), 'gain-remove');
  else editGain((vv) => vv.gainPoints[h.i].handles.splice(h.k, 1), 'gain-remove-handle');
  endHistoryGesture();
}

// ==========================================================================
// Init / 초기화
// ==========================================================================

/**
 * Attach canvases, observers and pointer handlers.
 * @param {{ requestRender: (scopes: string[]) => void, showToast: (msg: string) => void }} hooks
 */
export function initCanvases(hooks) {
  requestRender = hooks.requestRender;
  showToastFn = hooks.showToast;
  mainView.canvas = document.getElementById('mainCanvas');
  mainView.ctx = mainView.canvas.getContext('2d');
  gainView.canvas = document.getElementById('gainCanvas');
  gainView.ctx = gainView.canvas.getContext('2d');

  const mc = mainView.canvas;
  mc.addEventListener('pointerdown', onMainPointerDown);
  mc.addEventListener('pointermove', onMainPointerMove);
  mc.addEventListener('pointerup', onMainPointerUp);
  mc.addEventListener('pointercancel', onMainPointerUp);
  mc.addEventListener('pointerleave', () => { if (!drag) { hover = null; requestRender(['canvas']); } });
  mc.addEventListener('dblclick', onMainDblClick);
  mc.addEventListener('contextmenu', onMainContextMenu);
  mc.addEventListener('wheel', onMainWheel, { passive: false });

  const gc = gainView.canvas;
  gc.addEventListener('pointerdown', onGainPointerDown);
  gc.addEventListener('pointermove', onGainPointerMove);
  gc.addEventListener('pointerup', onGainPointerUp);
  gc.addEventListener('pointercancel', onGainPointerUp);
  gc.addEventListener('pointerleave', () => { gainHover = null; requestRender(['gain']); });
  gc.addEventListener('dblclick', onGainDblClick);
  gc.addEventListener('contextmenu', onGainContextMenu);

  if (globalThis.ResizeObserver) {
    const ro = new ResizeObserver(() => requestRender(['canvas', 'gain']));
    ro.observe(mc);
    ro.observe(gc);
  } else {
    globalThis.addEventListener('resize', () => requestRender(['canvas', 'gain']));
  }
}
