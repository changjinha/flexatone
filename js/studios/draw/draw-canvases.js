/**
 * Flexatone — studios/draw/draw-canvases.js
 * Draw Studio UI tier: the main piano-roll drawing canvas and its pointer tools.
 * 드로잉 스튜디오 UI: 메인 피아노롤 드로잉 캔버스와 포인터 도구.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder (imported by draw-panels.js only).
 *
 * Axes: x = time (s), y = pitch (MIDI, i.e. log frequency) — same as the Glissando piano roll.
 * Tools / 도구
 *   Draw (D)    freehand; getCoalescedEvents() points, live preview raw (grey) + processed (colour)
 *   Line (L)    two-point glissando (Shift = semitone snap; time snaps to the grid)
 *   Select (V)  click = select · drag = move (time / pitch) · Shift+drag empty = box select ·
 *               drag empty = pan
 *   Node (N)    drag spline anchors of the active stroke → stroke switches to direct mode
 *   Erase (E)   click a stroke = delete · drag across strokes = cut (splits strokes)
 * Wheel (Glissando semantics): pitch scroll · Shift/horizontal = time pan · Ctrl/⌘ (pinch) = zoom.
 * Double-click = set the cue. / 더블클릭 = 큐 지정
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import {
  computeStroke, createStroke, newStrokeId, thinRaw, roundRaw, offsetRaw, enterDirectMode, pieceAnchors, piecePitchAt,
  pieceWidthAt, applyTransform, cutRaw, STROKE_COLORS, DRAW_CELL,
} from './draw-engine.js';
import { createWarpStage, LIQUIFY_MAX_OPS } from '../../modules/space-warp.js';
import { getDrawParams, editDraw, getActiveStroke, isStrokeAudible, getProcessedMap } from '../draw-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { attachLocate, cueOrAudition } from '../../ui/locate-tool.js';
import { sizeCanvas } from '../../ui/canvas-size.js';

export const PAD = { left: 52, right: 14, top: 14, bottom: 24 };
const BLACK = new Set([1, 3, 6, 8, 10]);
const HIT_PX = 8;
const ERASE_PX = 10;


/** Screen ↔ (seconds, MIDI) for the current view. / 화면 ↔ (초, MIDI) */
export function drawMetrics(canvas, view) {
  const { dpr, w, h } = sizeCanvas(canvas);
  const m = { dpr, w, h, plotW: w - PAD.left - PAD.right, plotH: h - PAD.top - PAD.bottom, view };
  const tSpan = Math.max(0.1, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  m.timeToX = (sec) => PAD.left + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - PAD.left) / m.plotW) * tSpan;
  m.midiToY = (midi) => PAD.top + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - PAD.top) / m.plotH) * mSpan;
  return m;
}

const distSeg = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const u = L > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
};

/** Screen samples (with width) of every piece of a stroke result. / 화면 샘플 */
function piecePolyline(m, piece, n = 0) {
  const k = n || clamp(Math.ceil((m.timeToX(piece.t0 + piece.dur) - m.timeToX(piece.t0)) / 3), 12, 400);
  const out = [];
  for (let i = 0; i <= k; i++) {
    const sec = piece.t0 + (i / k) * piece.dur;
    out.push({ x: m.timeToX(sec), y: m.midiToY(piecePitchAt(piece, sec)), w: pieceWidthAt(piece, sec) });
  }
  return out;
}

function drawGrid(ctx, m, params) {
  const view = params.view;
  const semi = params.grid?.pitchDiv !== 'off';
  for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
    const pc = ((midi % 12) + 12) % 12;
    const yTop = m.midiToY(midi + 0.5);
    const yBot = m.midiToY(midi - 0.5);
    if (semi) {
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(PAD.left, yTop, m.plotW, Math.max(1, yBot - yTop));
    }
    if (semi || pc === 0) {
      ctx.strokeStyle = pc === 0 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = pc === 0 ? 1.1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(PAD.left, m.midiToY(midi));
      ctx.lineTo(PAD.left + m.plotW, m.midiToY(midi));
      ctx.stroke();
    }
  }
  const div = Number(params.grid?.timeDiv) || 0;
  const span = view.tMax - view.tMin;
  const step = div > 0 ? div * Math.max(1, Math.ceil(span / div / 80)) : 0;
  if (step > 0) {
    for (let s = Math.ceil(view.tMin / step) * step; s <= view.tMax + 1e-9; s += step) {
      const x = m.timeToX(s);
      const whole = Math.abs(s - Math.round(s)) < 1e-6;
      ctx.strokeStyle = whole ? 'rgba(100, 116, 139, 0.45)' : 'rgba(51, 65, 85, 0.35)';
      ctx.lineWidth = whole ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, PAD.top + m.plotH);
      ctx.stroke();
    }
  }
}

function drawAxes(ctx, m, view) {
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const mStep = view.midiMax - view.midiMin > 40 ? 12 : view.midiMax - view.midiMin > 18 ? 6 : 2;
  for (let midi = Math.ceil(view.midiMin / mStep) * mStep; midi <= view.midiMax; midi += mStep) ctx.fillText(midiToNoteName(midi), PAD.left - 6, m.midiToY(midi));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const span = view.tMax - view.tMin;
  const tStep = span > 24 ? 5 : span > 10 ? 2 : span > 4 ? 1 : 0.5;
  for (let s = Math.ceil(view.tMin / tStep) * tStep; s <= view.tMax + 1e-9; s += tStep) ctx.fillText(`${roundTo(s, 2)}s`, m.timeToX(s), PAD.top + m.plotH + 5);
}

/**
 * Create the Draw canvas inside `els` = { main, hud: { time, note, hz, tool } }.
 * hooks: { requestRender, showToast, onStrokeDrawn(stroke, result) }
 * @returns {{ render: () => void, destroy: () => void, metrics: () => object }}
 */
export function createDrawCanvases(els, hooks) {
  const ctx = els.main.getContext('2d');
  let drag = null;
  let hover = null;
  let polys = new Map(); // stroke id → [[{x,y,w}]] screen polylines of the last render

  const pos = (e) => {
    const r = els.main.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * els.main.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * els.main.clientHeight };
  };
  const rerender = () => hooks.requestRender(['draw']);

  // Shared Locate tool (ui/locate-tool.js). Body drag = move the stroke in time and pitch; start /
  // end dot = stretch the stroke to that time and tilt its pitch toward that end (taper to the other
  // end). End dots only when the transform is transpose-only (they must sit on the drawn line).
  // Only with Select / Node so drawing over a stroke still draws. / 선택·노드 도구에서만 동작
  const plain = (s) => { const tr = s.transform || {}; return (Number(tr.stretch) || 1) === 1 && !tr.reverse && !tr.invert; };
  const locate = attachLocate(els.main, {
    enabled: () => ['select', 'node'].includes(getDrawParams().tool),
    items() {
      const params = getDrawParams();
      return params.strokes.filter((s) => polys.has(s.id)).map((s) => {
        const lines = polys.get(s.id).filter((pl) => pl.length >= 2);
        const ok = lines.length && plain(s) && s.raw.length >= 2 && s.raw[s.raw.length - 1].t > s.raw[0].t;
        const first = lines[0]?.[0];
        const last = lines[lines.length - 1]?.[lines[lines.length - 1].length - 1];
        return { id: s.id, color: s.color, poly: lines, start: ok ? first : null, end: ok ? last : null };
      });
    },
    toWorld(p) {
      const m = drawMetrics(els.main, getDrawParams().view);
      return { sec: m.xToTime(p.x), midi: m.yToMidi(p.y) };
    },
    begin: (id) => { const s = getDrawParams().strokes.find((x) => x.id === id); return { raw: s.raw.map((q) => ({ ...q })), tp: Number(s.transform?.transpose) || 0 }; },
    startOf(id) {
      // First sounding time of the processed stroke / 처리된 획의 첫 소리 시점
      const res = getProcessedMap(getDrawParams()).get(id);
      return res?.pieces?.length ? Math.min(...res.pieces.map((pc) => pc.t0)) : undefined;
    },
    select(id) { editDraw((d) => { d.activeStrokeId = id; if (!(d.selectedIds || []).includes(id)) d.selectedIds = [id]; }, { history: false }); },
    apply(id, kind, w) {
      const raw = w.orig.raw;
      let next;
      if (kind === 'move') {
        const t0 = Math.min(...raw.map((q) => q.t));
        const dt = Math.max(-t0, w.snapTime(t0 + w.dSec) - t0);
        next = offsetRaw(raw, dt, w.dSemi);
      } else {
        const a = raw[0];
        const z = raw[raw.length - 1];
        const span = Math.max(1e-6, z.t - a.t);
        const start = kind === 'start';
        const nt0 = start ? clamp(w.sec, 0, z.t - 0.05) : a.t;
        const nt1 = start ? z.t : Math.max(a.t + 0.05, w.sec);
        const shown = (start ? a.p : z.p) + w.orig.tp;
        const dP = (w.midi ?? shown) - shown;
        next = raw.map((q) => {
          const u = (q.t - a.t) / span;
          return { ...q, t: roundTo(nt0 + u * (nt1 - nt0), 4), p: roundTo(q.p + dP * (start ? 1 - u : u), 4) };
        });
      }
      editDraw((d) => { const s = d.strokes.find((x) => x.id === id); if (s) s.raw = next; }, { coalesceKey: `draw-locate-${kind}` });
    },
  });

  function hitStroke(p) {
    let best = null;
    let bestD = HIT_PX;
    for (const [id, list] of polys) {
      for (const pl of list) {
        for (let i = 1; i < pl.length; i++) {
          const d = distSeg(p, pl[i - 1], pl[i]);
          if (d < bestD) { bestD = d; best = id; }
        }
      }
    }
    return best;
  }

  function strokePath(pl, color, alpha, widthScale = 1) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    for (let i = 1; i < pl.length; i++) {
      const w = 0.5 * (pl[i - 1].w + pl[i].w);
      if (w <= 0.001) continue; // zero width = silence → gap / 두께 0 = 무음
      ctx.lineWidth = (1.2 + 7 * w) * widthScale;
      ctx.beginPath();
      ctx.moveTo(pl[i - 1].x, pl[i - 1].y);
      ctx.lineTo(pl[i].x, pl[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function renderMain() {
    const params = getDrawParams();
    const view = params.view;
    const m = drawMetrics(els.main, view);
    const map = getProcessedMap(params);
    const active = getActiveStroke(params);
    const sel = new Set(params.selectedIds || []);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    drawGrid(ctx, m, params);

    polys = new Map();
    for (const s of params.strokes) {
      const res = map.get(s.id);
      if (!res) continue;
      const lines = res.pieces.map((pc) => piecePolyline(m, pc));
      polys.set(s.id, lines);
      const audible = isStrokeAudible(s, params);
      const isSel = sel.has(s.id);
      if (isSel) for (const pl of lines) strokePath(pl, '#f8fafc', 0.22, 1.9);
      for (const pl of lines) strokePath(pl, s.color, audible ? 0.92 : 0.25);
      if (s.id === active?.id && params.tool === 'node') {
        for (const pc of res.pieces) {
          for (const a of pieceAnchors(pc)) {
            const x = m.timeToX(a.t);
            const y = m.midiToY(a.p);
            ctx.fillStyle = s.direct ? '#f472b6' : '#e2e8f0';
            ctx.strokeStyle = '#020617';
            ctx.lineWidth = 1.5;
            ctx.fillRect(x - 4, y - 4, 8, 8);
            ctx.strokeRect(x - 4, y - 4, 8, 8);
          }
        }
      }
      if (s.id === active?.id && params.tool !== 'node') {
        // raw points of the active stroke (faint) / 활성 획의 원시 점
        const tr = applyTransform(s.raw, s.transform);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.35)';
        for (const q of tr) ctx.fillRect(m.timeToX(q.t) - 1, m.midiToY(q.p) - 1, 2, 2);
      }
    }

    // Live drawing preview: raw (grey) + processed (colour) / 그리는 중 미리보기
    if (drag?.type === 'draw' && drag.raw.length >= 2) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      drag.raw.forEach((q, i) => { const x = m.timeToX(q.t); const y = m.midiToY(q.p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      if (drag.preview) for (const pc of drag.preview.pieces) strokePath(piecePolyline(m, pc), drag.color, 0.9);
    }
    if (drag?.type === 'line' && drag.b) {
      ctx.strokeStyle = drag.color;
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(m.timeToX(drag.a.t), m.midiToY(drag.a.p));
      ctx.lineTo(m.timeToX(drag.b.t), m.midiToY(drag.b.p));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (drag?.type === 'box') {
      ctx.strokeStyle = '#38bdf8';
      ctx.fillStyle = 'rgba(56, 189, 248, 0.08)';
      ctx.setLineDash([4, 3]);
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      ctx.fillRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(x, y, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.setLineDash([]);
    }
    if (drag?.type === 'erase' && drag.path.length > 1) {
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.6)';
      ctx.lineWidth = ERASE_PX * 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      drag.path.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
    }

    locate.draw(ctx, active?.id);

    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    const tr = appState.transport;
    drawCueLine(ctx, m.timeToX(tr.cueSec), PAD.top, PAD.top + m.plotH);
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), PAD.top, PAD.top + m.plotH);
    ctx.restore();
    drawAxes(ctx, m, view);

    if (hover && els.hud) {
      const sec = m.xToTime(hover.x);
      const midi = m.yToMidi(hover.y);
      els.hud.time.textContent = `${sec.toFixed(2)}s`;
      els.hud.note.textContent = midiToNoteName(midi);
      els.hud.hz.textContent = `${midiToFreq(midi).toFixed(1)} Hz`;
    }
    if (locate.isDragging()) { els.main.style.cursor = 'grabbing'; return; }
    els.main.style.cursor = { draw: 'crosshair', line: 'crosshair', warp: 'crosshair', select: drag?.type === 'move' ? 'grabbing' : 'default', node: 'pointer', erase: 'cell' }[params.tool] || 'default';
  }

  // ------------------------------------------------------------------ pointer tools
  const toPt = (m, p, w) => ({ t: Math.max(0, m.xToTime(p.x)), p: m.yToMidi(p.y), w });

  function onDown(e) {
    if (e.button !== 0) return;
    const params = getDrawParams();
    const m = drawMetrics(els.main, params.view);
    const p = pos(e);
    if (p.x < PAD.left || p.y > PAD.top + m.plotH) return;
    try { els.main.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    const tool = params.tool;
    const pen = e.pointerType === 'pen' && e.pressure > 0;
    const width = () => (pen ? clamp(e.pressure, 0, 1) : clamp(Number(params.drawWidth) || 0.7, 0, 1));
    if (tool === 'draw') {
      drag = { type: 'draw', raw: [toPt(m, p, width())], last: p, pen, color: STROKE_COLORS[params.strokes.length % STROKE_COLORS.length], preview: null };
      return;
    }
    if (tool === 'line') {
      drag = { type: 'line', a: lineSnap(m, toPt(m, p, width()), e.shiftKey, params), b: null, color: STROKE_COLORS[params.strokes.length % STROKE_COLORS.length], w: width() };
      return;
    }
    if (tool === 'warp') {
      // Object liquify: the brush moves the points of the active stroke only / 객체 리퀴파이: 활성 획의 점만 옮김
      const act = getActiveStroke(params);
      const n = (act?.fx || []).find((x) => x.type === 'liquify')?.params.ops.length || 0;
      if (!act || n >= LIQUIFY_MAX_OPS) return;
      drag = { type: 'warp', id: act.id, opIndex: n, pts: [[m.xToTime(p.x) / DRAW_CELL.ut, m.yToMidi(p.y) / DRAW_CELL.um]], last: p };
      if (params.liq?.tool !== 'push') commitWarp(drag);
      return;
    }
    if (tool === 'erase') {
      drag = { type: 'erase', path: [p] };
      rerender();
      return;
    }
    if (tool === 'node') {
      const act = getActiveStroke(params);
      const res = act && getProcessedMap(params).get(act.id);
      if (res) {
        for (const pc of res.pieces) {
          const anchors = pieceAnchors(pc);
          const idx = anchors.findIndex((a) => Math.hypot(m.timeToX(a.t) - p.x, m.midiToY(a.p) - p.y) <= 7);
          if (idx >= 0) {
            if (res.pieces.length !== 1) { hooks.showToast(t('draw.toast.nodeSplit'), 'error'); return; }
            if (!act.direct) {
              editDraw((d) => { const s = d.strokes.find((x) => x.id === act.id); if (s) enterDirectMode(s); }, { coalesceKey: 'draw-node' });
              hooks.showToast(t('draw.toast.direct'));
            }
            drag = { type: 'node', id: act.id, idx };
            return;
          }
        }
      }
      const hit = hitStroke(p);
      if (hit) { editDraw((d) => { d.activeStrokeId = hit; d.selectedIds = [hit]; }, { history: false }); return; }
      drag = { type: 'pan', x: p.x, y: p.y, view: { ...params.view } };
      return;
    }
    // select / 선택
    const hit = hitStroke(p);
    if (hit) {
      let ids = params.selectedIds || [];
      if (e.shiftKey) ids = ids.includes(hit) ? ids.filter((x) => x !== hit) : [...ids, hit];
      else if (!ids.includes(hit)) ids = [hit];
      editDraw((d) => { d.selectedIds = ids; d.activeStrokeId = hit; }, { history: false });
      const orig = new Map(params.strokes.filter((s) => ids.includes(s.id)).map((s) => [s.id, s.raw]));
      drag = { type: 'move', x: p.x, y: p.y, orig, moved: false };
      return;
    }
    if (e.shiftKey) { drag = { type: 'box', x0: p.x, y0: p.y, x1: p.x, y1: p.y }; return; }
    if ((params.selectedIds || []).length) editDraw((d) => { d.selectedIds = []; }, { history: false });
    drag = { type: 'pan', x: p.x, y: p.y, view: { ...params.view } };
  }

  function lineSnap(m, q, shift, params) {
    const div = Number(params.grid?.timeDiv) || 0;
    const tt = div > 0 ? Math.round(q.t / div) * div : q.t;
    return { t: Math.max(0, tt), p: shift ? Math.round(q.p) : q.p, w: q.w };
  }

  function onMove(e) {
    const p = pos(e);
    hover = p;
    if (!drag) { rerender(); return; }
    const params = getDrawParams();
    const m = drawMetrics(els.main, params.view);
    if (drag.type === 'draw') {
      const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        const q = pos(ev);
        if (Math.hypot(q.x - drag.last.x, q.y - drag.last.y) < 2) continue; // thin at record / 기록 간인
        const w = drag.pen ? clamp(ev.pressure, 0, 1) : clamp(Number(params.drawWidth) || 0.7, 0, 1);
        drag.raw.push(toPt(m, q, w));
        drag.last = q;
      }
      const act = getActiveStroke(params);
      drag.preview = computeStroke(createStroke(params.strokes.length, drag.raw, act, 'ds_preview'));
    } else if (drag.type === 'line') {
      drag.b = lineSnap(m, toPt(m, p, drag.w), e.shiftKey, params);
    } else if (drag.type === 'warp') {
      if (Math.hypot(p.x - drag.last.x, p.y - drag.last.y) >= 3) {
        drag.pts.push([m.xToTime(p.x) / DRAW_CELL.ut, m.yToMidi(p.y) / DRAW_CELL.um]);
        drag.last = p;
        commitWarp(drag);
      }
    } else if (drag.type === 'erase') {
      drag.path.push(p);
    } else if (drag.type === 'box') {
      drag.x1 = p.x;
      drag.y1 = p.y;
    } else if (drag.type === 'move') {
      const dt = m.xToTime(p.x) - m.xToTime(drag.x);
      const dp = m.yToMidi(p.y) - m.yToMidi(drag.y);
      if (!drag.moved && Math.hypot(p.x - drag.x, p.y - drag.y) < 3) return;
      drag.moved = true;
      const o = drag.orig;
      let minT = Infinity;
      for (const raw of o.values()) for (const q of raw) minT = Math.min(minT, q.t);
      const dtc = Math.max(-minT, dt);
      editDraw((d) => { for (const s of d.strokes) if (o.has(s.id)) s.raw = offsetRaw(o.get(s.id), dtc, dp); }, { coalesceKey: 'draw-move' });
    } else if (drag.type === 'node') {
      const d0 = drag;
      editDraw((d) => {
        const s = d.strokes.find((x) => x.id === d0.id);
        if (!s?.raw[d0.idx]) return;
        const lo = d0.idx > 0 ? s.raw[d0.idx - 1].t + 0.005 : 0;
        const hi = d0.idx < s.raw.length - 1 ? s.raw[d0.idx + 1].t - 0.005 : Infinity;
        s.raw[d0.idx] = { ...s.raw[d0.idx], t: roundTo(clamp(m.xToTime(p.x), lo, hi), 4), p: roundTo(m.yToMidi(p.y), 4) };
      }, { coalesceKey: 'draw-node' });
    } else if (drag.type === 'pan') {
      const vp = drag.view;
      const tSpan = vp.tMax - vp.tMin;
      const mSpan = vp.midiMax - vp.midiMin;
      const tMin = Math.max(0, vp.tMin - ((p.x - drag.x) / m.plotW) * tSpan);
      const midiMin = clamp(vp.midiMin + ((p.y - drag.y) / m.plotH) * mSpan, 0, 127 - mSpan);
      editDraw((d) => { Object.assign(d.view, { tMin, tMax: tMin + tSpan, midiMin, midiMax: midiMin + mSpan }); }, { history: false });
    }
    rerender();
  }

  /** Write the brush stroke being dragged into the active stroke's Liquify effect (one undo step per drag). */
  function commitWarp(d0) {
    const pts = d0.pts.length > 60 ? d0.pts.filter((_, k) => k % Math.ceil(d0.pts.length / 60) === 0 || k === d0.pts.length - 1) : d0.pts;
    editDraw((d) => {
      const s = d.strokes.find((x) => x.id === d0.id);
      if (!s) return;
      s.fx = s.fx || [];
      let it = s.fx.find((x) => x.type === 'liquify');
      if (!it) { it = createWarpStage('liquify', { id: 'w-liquify' }); s.fx.unshift(it); }
      it.on = true;
      const liq = d.liq || {};
      const op = { tool: liq.tool || 'push', size: Number(liq.size) || 8, strength: Number(liq.strength) || 0.6, pts: pts.map((q) => [q[0], q[1]]) };
      if (d0.opIndex < it.params.ops.length) it.params.ops[d0.opIndex] = op; else it.params.ops.push(op);
    }, { coalesceKey: 'draw-warp' });
  }

  function commitStroke(raw) {
    const params = getDrawParams();
    const act = getActiveStroke(params);
    const s = createStroke(params.strokes.length, raw, act);
    s.id = newStrokeId();
    editDraw((d) => { d.strokes.push(s); d.activeStrokeId = s.id; d.selectedIds = [s.id]; });
    endHistoryGesture();
    hooks.onStrokeDrawn?.(s);
  }

  function finishErase(path) {
    const params = getDrawParams();
    const m = drawMetrics(els.main, params.view);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (len < 4) {
      const hit = hitStroke(path[0]);
      if (hit) { editDraw((d) => { d.strokes = d.strokes.filter((s) => s.id !== hit); d.selectedIds = (d.selectedIds || []).filter((x) => x !== hit); if (d.activeStrokeId === hit) d.activeStrokeId = d.strokes[0]?.id || ''; }); endHistoryGesture(); }
      return;
    }
    let changed = false;
    const next = [];
    for (const s of params.strokes) {
      const tr = applyTransform(s.raw, s.transform);
      const n = s.raw.length;
      const mask = new Array(n).fill(false);
      tr.forEach((q, k) => {
        const pt = { x: m.timeToX(q.t), y: m.midiToY(q.p) };
        for (let i = 1; i < path.length; i++) if (distSeg(pt, path[i - 1], path[i]) <= ERASE_PX) { mask[s.transform?.reverse ? n - 1 - k : k] = true; break; }
      });
      if (!mask.some(Boolean)) { next.push(s); continue; }
      changed = true;
      const runs = cutRaw(s.raw, mask);
      runs.forEach((raw, i) => next.push({ ...s, id: i === 0 ? s.id : newStrokeId(), name: i === 0 ? s.name : `${s.name} ${String.fromCharCode(97 + i)}`, raw: roundRaw(raw), direct: false }));
    }
    if (!changed) return;
    editDraw((d) => {
      d.strokes = next;
      const ids = new Set(next.map((s) => s.id));
      d.selectedIds = (d.selectedIds || []).filter((x) => ids.has(x));
      if (!ids.has(d.activeStrokeId)) d.activeStrokeId = next[0]?.id || '';
    });
    endHistoryGesture();
  }

  function onUp(e) {
    const d0 = drag;
    drag = null;
    try { els.main.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (!d0) return;
    if (d0.type === 'draw') {
      const raw = thinRaw(d0.raw, 0.008, 0.1);
      if (raw.length >= 2 && Math.abs(raw[raw.length - 1].t - raw[0].t) + Math.abs(raw[raw.length - 1].p - raw[0].p) > 0.05) commitStroke(raw);
    } else if (d0.type === 'line' && d0.b && Math.abs(d0.b.t - d0.a.t) > 0.02) {
      const [a, b] = d0.a.t <= d0.b.t ? [d0.a, d0.b] : [d0.b, d0.a];
      const raw = Array.from({ length: 25 }, (_, i) => ({ t: a.t + ((b.t - a.t) * i) / 24, p: a.p + ((b.p - a.p) * i) / 24, w: d0.w }));
      commitStroke(raw);
    } else if (d0.type === 'erase') {
      finishErase(d0.path);
    } else if (d0.type === 'box') {
      const x0 = Math.min(d0.x0, d0.x1);
      const x1 = Math.max(d0.x0, d0.x1);
      const y0 = Math.min(d0.y0, d0.y1);
      const y1 = Math.max(d0.y0, d0.y1);
      const ids = [];
      for (const [id, list] of polys) if (list.some((pl) => pl.some((q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1))) ids.push(id);
      editDraw((d) => { d.selectedIds = ids; if (ids.length) d.activeStrokeId = ids[0]; }, { history: false });
    } else if (d0.type === 'move' || d0.type === 'node' || d0.type === 'warp') {
      endHistoryGesture();
    }
    rerender();
  }

  function onDbl(e) {
    const params = getDrawParams();
    const m = drawMetrics(els.main, params.view);
    cueOrAudition(e, Math.max(0, Number(m.xToTime(pos(e).x).toFixed(2))));
  }

  /** Zoom the view around (sec, midi) by factor f. / (초, MIDI) 기준 줌 */
  function zoomAt(vw, f, sec, midi) {
    const tSpan = clamp((vw.tMax - vw.tMin) * f, 0.5, 300);
    const u = (sec - vw.tMin) / Math.max(1e-6, vw.tMax - vw.tMin);
    vw.tMin = Math.max(0, sec - u * tSpan);
    vw.tMax = vw.tMin + tSpan;
    const mSpan = clamp((vw.midiMax - vw.midiMin) * f, 4, 127);
    const v = (midi - vw.midiMin) / Math.max(1e-6, vw.midiMax - vw.midiMin);
    vw.midiMin = clamp(midi - v * mSpan, 0, 127 - mSpan);
    vw.midiMax = vw.midiMin + mSpan;
  }

  function onWheel(e) {
    e.preventDefault();
    const params = getDrawParams();
    const m = drawMetrics(els.main, params.view);
    const p = pos(e);
    const dy = e.deltaY;
    editDraw((d) => {
      const vw = d.view;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(vw, dy > 0 ? 1.12 : 1 / 1.12, m.xToTime(p.x), m.yToMidi(p.y));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(dy)) {
        const span = vw.tMax - vw.tMin;
        const dd = ((e.deltaX || dy) / m.plotW) * span;
        vw.tMin = Math.max(0, vw.tMin + dd);
        vw.tMax = vw.tMin + span;
      } else {
        const span = vw.midiMax - vw.midiMin;
        vw.midiMin = clamp(vw.midiMin - (dy / m.plotH) * span, 0, 127 - span);
        vw.midiMax = vw.midiMin + span;
      }
    }, { history: false });
  }

  const onLeave = () => { hover = null; rerender(); };

  els.main.addEventListener('pointerdown', onDown);
  els.main.addEventListener('pointermove', onMove);
  els.main.addEventListener('pointerup', onUp);
  els.main.addEventListener('pointercancel', onUp);
  els.main.addEventListener('pointerleave', onLeave);
  els.main.addEventListener('dblclick', onDbl);
  els.main.addEventListener('wheel', onWheel, { passive: false });
  const ro = globalThis.ResizeObserver ? new ResizeObserver(rerender) : null;
  ro?.observe(els.main);

  return {
    render: renderMain,
    metrics: () => drawMetrics(els.main, getDrawParams().view),
    zoomAt,
    isDragging: () => !!drag || locate.isDragging(),
    destroy() {
      ro?.disconnect();
      locate.destroy();
    },
  };
}
