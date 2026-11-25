/**
 * Flexatone — studios/grid/grid-canvases.js
 * Grid Studio UI tier: the two windows.
 *   EDITOR  the undeformed Cartesian grid with the source lines as they are. The Liquify brush is
 *           used here: you drag the SPACE (the brush strokes are stored), not the lines.
 *   RESULT  the deformed coordinate grid and the lines as the space carries them = what you hear.
 *           Read-only; it shows the playhead, the cue and the cursor cross-hair.
 * 그리드 스튜디오 UI: 두 윈도우. Editor = 변형 전 직교 격자와 원본 선 (리퀴파이 브러시로 "공간"을 끎),
 * Result = 변형된 좌표 격자와 그 위에 실린 선 = 들리는 소리 (읽기 전용).
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder (imported by grid-panels.js only).
 * One view (doc.view) serves both windows; wheel = pitch, Shift = time, Ctrl/⌘ = zoom (ui/view-nav.js).
 * Double-click sets the cue (in both windows). Middle-button drag pans the Editor, any drag pans
 * the Result. Alt is never bound.
 * Editor tools (doc.tool.mode): brush · selections (pitch band = whole time range, time band = whole
 * pitch range, free box, lasso) · Pull (drag = carry the selected part of the space). A selection is
 * kept in cells of the ORIGINAL space; the Result shows where the space carries it.
 * Editor 도구: 브러시 · 선택 (음고 띠 = 시간 전체, 시간 띠 = 음고 전체, 자유 박스, 올가미) · 당기기.
 * 선택은 원래 공간의 셀 좌표로 저장되며, Result에는 공간이 옮긴 자리로 보임.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, panViewTime, panViewPitch } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';
import { triggerDownload } from '../../audio/audio-engine.js';
import { createWarpStage, warpPoint, stackVariants, sanitizeBrushDetail, LIQUIFY_MAX_OPS, REGION_FAR, REGION_MAX_PTS } from '../../modules/space-warp.js';
import { warpedGridLines, gridEnv, GRID_CELL, GRID_SEL_KINDS } from './grid-engine.js';
import { gridMetrics } from './grid-layout.js';
import { getGridParams, editGrid, getGridBake, getGridLines, beginGridPull, writeGridPull } from '../grid-studio.js';

/** View limits of the Grid windows. / 그리드 윈도우의 뷰 한계 */
export const GRID_VIEW_LIMITS = Object.freeze({ tLo: -4, pLo: -12, pHi: 140, minPitchSpan: 3, maxPitchSpan: 152, minTimeSpan: 0.25 });

const BLACK = new Set([1, 3, 6, 8, 10]);
const LINE_COLORS = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];
const CH_COLOR = { r: '#fb7185', g: '#4ade80', b: '#60a5fa' };
const COMMIT_MS = 60;

const timeStep = (spanSec, plotW = 600) => {
  const want = (46 * spanSec) / Math.max(60, plotW);
  for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60]) if (s >= want) return s;
  return 120;
};

/**
 * @param {{ editor: HTMLCanvasElement, result: HTMLCanvasElement, hud: object }} els
 * @returns {{ render: () => void, destroy: () => void, screenshot: (kind: string) => void }}
 */
export function createGridCanvases(els, { requestRender, showToast }) {
  const ctxE = els.editor.getContext('2d');
  const ctxR = els.result.getContext('2d');
  let hover = null; // { t, midi, src }
  let drag = null;
  const last = { editor: null, result: null };
  let gridCache = { key: '', lines: null };

  const pos = (cv, e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * cv.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * cv.clientHeight };
  };
  const setView = (fn) => editGrid((d) => fn(d.view, d), { history: false });

  function backdrop(ctx, m, p) {
    const view = p.view;
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);
    for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const yTop = Math.max(m.plotY, m.midiToY(midi + 0.5));
      const yBot = Math.min(m.plotY + m.plotH, m.midiToY(midi - 0.5));
      if (yBot <= yTop) continue;
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(m.plotX, yTop, m.plotW, yBot - yTop);
    }
  }

  const clip = (ctx, m) => { ctx.save(); ctx.beginPath(); ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH); ctx.clip(); };

  /** Grid spacing that suits the view. / 뷰에 맞는 격자 간격 */
  const spacing = (p, m) => ({ tStep: timeStep(p.view.tMax - p.view.tMin, m.plotW), mStep: m.plotH / (p.view.midiMax - p.view.midiMin) >= 9 ? 1 : m.plotH / (p.view.midiMax - p.view.midiMin) >= 3 ? 3 : 12 });

  /** The straight grid of the Editor (domain only). / Editor의 곧은 격자 (영역 안) */
  function flatGrid(ctx, m, p, dom) {
    const { tStep, mStep } = spacing(p, m);
    clip(ctx, m);
    ctx.lineWidth = 1;
    for (let s = Math.ceil(dom.t0 / tStep) * tStep; s <= dom.t1 + 1e-9; s += tStep) {
      const x = Math.round(m.timeToX(s)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.beginPath(); ctx.moveTo(x, m.midiToY(dom.m1)); ctx.lineTo(x, m.midiToY(dom.m0)); ctx.stroke();
    }
    for (let v = Math.ceil(dom.m0 / mStep) * mStep; v <= dom.m1 + 1e-9; v += mStep) {
      const y = Math.round(m.midiToY(v)) + 0.5;
      ctx.strokeStyle = ((v % 12) + 12) % 12 === 0 ? 'rgba(125, 211, 252, 0.38)' : 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath(); ctx.moveTo(m.timeToX(dom.t0), y); ctx.lineTo(m.timeToX(dom.t1), y); ctx.stroke();
    }
    ctx.restore();
  }

  /** The deformed grid of the Result: the images of the same lines under the space. / Result의 변형 격자 */
  function warpedGrid(ctx, m, p, bake) {
    const { tStep, mStep } = spacing(p, m);
    const key = `${bake.sig}|${tStep}|${mStep}`;
    if (gridCache.key !== key) gridCache = { key, lines: warpedGridLines(p, bake.dom, { tStep, mStep, samples: 72 }) };
    clip(ctx, m);
    ctx.lineWidth = 1;
    const stroke = (paths) => { for (const path of paths) { ctx.beginPath(); path.forEach((q, k) => { const x = m.timeToX(q.t); const y = m.midiToY(q.m); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); } };
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
    for (const g of gridCache.lines.time) stroke(g.paths);
    for (const g of gridCache.lines.pitch) { ctx.strokeStyle = ((g.v % 12) + 12) % 12 === 0 ? 'rgba(240, 171, 252, 0.45)' : 'rgba(148, 163, 184, 0.18)'; stroke(g.paths); }
    ctx.restore();
  }

  function axes(ctx, m, p, label, color) {
    const view = p.view;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(m.plotX + 0.5, m.plotY + 0.5, m.plotW - 1, m.plotH - 1);
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const py = m.midiToY(midi);
      if (py < m.plotY + 6 || py > m.plotY + m.plotH - 6) continue;
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(midiToNoteName(midi), m.plotX - 6, py);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#94a3b8';
    const step = timeStep(view.tMax - view.tMin, m.plotW);
    for (let s = Math.ceil(view.tMin / step) * step; s <= view.tMax; s += step) {
      const px = m.timeToX(s);
      if (px < m.plotX + 12 || px > m.plotX + m.plotW - 14) continue;
      ctx.fillText(`${Number(s.toFixed(2))}s`, px, m.plotY + m.plotH + 5);
    }
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
    ctx.fillRect(m.plotX + m.plotW - tw - 12, m.plotY + 3, tw + 9, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, m.plotX + m.plotW - 7, m.plotY + 5);
  }

  function transportLines(ctx, m) {
    const tr = appState.transport;
    clip(ctx, m);
    drawCueLine(ctx, m.timeToX(tr.cueSec), m.plotY, m.plotY + m.plotH); // shared look (ui/transport-lines.js) / 공용 모양
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), m.plotY, m.plotY + m.plotH);
    ctx.restore();
  }

  function crosshair(ctx, m, t0, midi) {
    const x = m.timeToX(t0);
    const y = m.midiToY(midi);
    if (x < m.plotX || x > m.plotX + m.plotW || y < m.plotY || y > m.plotY + m.plotH) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, m.plotY); ctx.lineTo(Math.round(x) + 0.5, m.plotY + m.plotH);
    ctx.moveTo(m.plotX, Math.round(y) + 0.5); ctx.lineTo(m.plotX + m.plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  const colorOf = (l, i) => l.color || LINE_COLORS[i % LINE_COLORS.length];

  function polyline(ctx, m, pts, color, width, alpha = 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const q of pts) {
      if (!Number.isFinite(q.m)) { pen = false; continue; }
      const x = m.timeToX(q.t);
      const y = m.midiToY(q.m);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function renderEditor(p, lines, bake) {
    const { dpr, w, h } = sizeCanvas(els.editor);
    const m = gridMetrics(w, h, p.view);
    last.editor = m;
    const ctx = ctxE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    backdrop(ctx, m, p);
    if (p.view.showGrid) flatGrid(ctx, m, p, bake.dom);
    clip(ctx, m);
    lines.forEach((l, i) => polyline(ctx, m, l.pts, colorOf(l, i), 2));
    // stored brush strokes of the Liquify stage: where the space was dragged / 저장된 리퀴파이 스트로크 = 공간을 끈 자리
    if (p.view.showStrokes) {
      const liq = p.space.find((it) => it.type === 'liquify' && it.on);
      for (const op of liq?.params.ops || []) {
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        op.pts.forEach(([x, y], k) => { const px = m.timeToX(x * GRID_CELL.ut); const py = m.midiToY(y * GRID_CELL.um); if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.stroke();
        ctx.setLineDash([]);
        const [ex, ey] = op.pts[op.pts.length - 1];
        ctx.fillStyle = 'rgba(167, 139, 250, 0.8)';
        ctx.beginPath(); ctx.arc(m.timeToX(ex * GRID_CELL.ut), m.midiToY(ey * GRID_CELL.um), 2.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
    transportLines(ctx, m);
    axes(ctx, m, p, t('grid.win.editor'), '#7dd3fc');
    if (hover) crosshair(ctx, m, hover.t, hover.midi);
    drawSelection(ctx, m, p, null);
    if (drag?.type === 'select' && drag.preview) outline(ctx, m, drag.preview, { color: '#fde047', fill: 'rgba(253, 224, 71, 0.06)', dash: [4, 3] });
    if (drag?.type === 'pull') pullArrow(ctx, m, drag);
    // brush outline: an ellipse in cells (aspect, angle), dashed core = hardness / 브러시 윤곽 (셀 기준 타원, 점선 = 단단함)
    if (hover && hover.src === 'editor' && p.tool.mode === 'brush') brushOutline(ctx, m, p, hover);
  }

  /** Cell polygon → screen points, sides at "infinity" clamped just outside the plot. / 셀 다각형 → 화면 */
  const screenPoly = (m, poly) => poly.map(([x, y]) => [clamp(m.timeToX(x * GRID_CELL.ut), m.plotX - 50, m.plotX + m.plotW + 50), clamp(m.midiToY(y * GRID_CELL.um), m.plotY - 50, m.plotY + m.plotH + 50)]);

  function outline(ctx, m, poly, { color, fill, dash, warped = null }) {
    const pts = warped || screenPoly(m, poly);
    if (pts.length < 2) return;
    clip(ctx, m);
    ctx.beginPath();
    pts.forEach(([x, y], k) => { if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.lineWidth = 1.25;
    ctx.setLineDash(dash || []);
    ctx.lineDashOffset = -((performance.now() / 60) % 14); // marching ants (redrawn with the hover) / 개미 행렬
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineDashOffset += 3.5;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** The selection: as drawn (Editor) or carried by the space (Result, `bake` given). / 선택 영역 표시 */
  function drawSelection(ctx, m, p, bake) {
    const sel = p.tool.sel;
    if (!sel) return;
    if (!bake || bake.identity) { outline(ctx, m, sel.poly, { color: '#fde047', fill: 'rgba(253, 224, 71, 0.07)', dash: [5, 4] }); return; }
    outline(ctx, m, sel.poly, { color: '#fde047', fill: 'rgba(253, 224, 71, 0.06)', dash: [5, 4], warped: warpedOutline(m, p, bake, sel.poly) });
  }

  /** Outline of a cell polygon under the space (clamped to the view, sampled every ~6 px). / 변형된 윤곽 */
  function warpedOutline(m, p, bake, poly) {
    const v = p.view;
    const cx = (x) => clamp(x, (v.tMin - 1) / GRID_CELL.ut, (v.tMax + 1) / GRID_CELL.ut);
    const cy = (y) => clamp(y, (v.midiMin - 2) / GRID_CELL.um, (v.midiMax + 2) / GRID_CELL.um);
    const env = gridEnv(p, bake.dom);
    const stack = p.space.filter((it) => it.type !== 'chroma' && it.type !== 'halftone');
    const pre = stackVariants(stack, env);
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = [cx(poly[i][0]), cy(poly[i][1])];
      const b = [cx(poly[(i + 1) % poly.length][0]), cy(poly[(i + 1) % poly.length][1])];
      const px = Math.hypot((b[0] - a[0]) * GRID_CELL.ut * (m.plotW / (v.tMax - v.tMin)), (b[1] - a[1]) * GRID_CELL.um * (m.plotH / (v.midiMax - v.midiMin)));
      const n = clamp(Math.ceil(px / 6), 1, 200);
      for (let k = 0; k < n; k++) {
        const u = k / n;
        const q = warpPoint(stack, (a[0] + (b[0] - a[0]) * u) * GRID_CELL.ut, (a[1] + (b[1] - a[1]) * u) * GRID_CELL.um, env, pre);
        out.push([m.timeToX(q.t), m.midiToY(q.m)]);
      }
    }
    return out;
  }

  function brushOutline(ctx, m, p, at) {
    const tl = p.tool;
    const sx = GRID_CELL.ut * (m.plotW / (p.view.tMax - p.view.tMin));
    const sy = GRID_CELL.um * (m.plotH / (p.view.midiMax - p.view.midiMin));
    const x = m.timeToX(at.t);
    const y = m.midiToY(at.midi);
    if (!m.inPlot({ x, y })) return;
    const asp = Math.sqrt(tl.aspect);
    const th = (tl.angle * Math.PI) / 180;
    const ring = (f) => {
      ctx.beginPath();
      for (let k = 0; k <= 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        const u = Math.cos(a) * tl.size * asp * f;
        const w = Math.sin(a) * (tl.size / asp) * f;
        const px = x + (u * Math.cos(th) - w * Math.sin(th)) * sx;
        const py = y - (u * Math.sin(th) + w * Math.cos(th)) * sy;
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    };
    ctx.strokeStyle = '#c4b5fd';
    ctx.lineWidth = 1;
    ring(1);
    if (tl.hardness > 0) { ctx.setLineDash([2, 3]); ring(tl.hardness); ctx.setLineDash([]); }
    if (tl.axis !== 'both') {
      ctx.beginPath();
      if (tl.axis === 'time') { ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); } else { ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); }
      ctx.stroke();
    }
  }

  function pullArrow(ctx, m, d) {
    const [gx, gy] = d.session.grab;
    const x0 = m.timeToX(gx * GRID_CELL.ut);
    const y0 = m.midiToY(gy * GRID_CELL.um);
    const x1 = m.timeToX((gx + d.dx) * GRID_CELL.ut);
    const y1 = m.midiToY((gy + d.dy) * GRID_CELL.um);
    clip(ctx, m);
    ctx.strokeStyle = '#fb923c';
    ctx.fillStyle = '#fb923c';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - 8 * Math.cos(a - 0.4), y1 - 8 * Math.sin(a - 0.4)); ctx.lineTo(x1 - 8 * Math.cos(a + 0.4), y1 - 8 * Math.sin(a + 0.4)); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x0, y0, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function renderResult(p, lines, bake) {
    const { dpr, w, h } = sizeCanvas(els.result);
    const m = gridMetrics(w, h, p.view);
    last.result = m;
    const ctx = ctxR;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    backdrop(ctx, m, p);
    if (p.view.showGrid) warpedGrid(ctx, m, p, bake);
    clip(ctx, m);
    if (p.view.showGhost && !bake.identity) lines.forEach((l, i) => polyline(ctx, m, l.pts, colorOf(l, i), 1, 0.22)); // where the lines were / 원래 자리
    for (const r of bake.runs) {
      const color = r.ch ? CH_COLOR[r.ch] : colorOf(lines[r.line] || {}, r.line);
      // gain as opacity: a gated run is drawn as its dots / 게인 = 불투명도 (게이트된 조각은 점으로 보임)
      let seg = [];
      let on = null;
      for (const q of r.pts) {
        const lit = q.g > 0.02;
        if (on !== null && lit !== on) { if (on && seg.length > 1) polyline(ctx, m, seg, color, 2.2); seg = on ? [] : [q]; }
        if (lit) seg.push(q);
        on = lit;
      }
      if (seg.length > 1) polyline(ctx, m, seg, color, 2.2);
    }
    ctx.restore();
    drawSelection(ctx, m, p, bake);
    transportLines(ctx, m);
    axes(ctx, m, p, t('grid.win.result'), '#f0abfc');
    // the cursor is shown where the space carries the point under it / 커서는 그 아래 점이 공간에 실려 간 자리에 표시
    if (hover) {
      if (hover.src === 'editor' && !bake.identity) {
        const env = gridEnv(p, bake.dom);
        const q = warpPoint(p.space.filter((it) => it.type !== 'chroma' && it.type !== 'halftone'), hover.t, hover.midi, env, stackVariants(p.space.filter((it) => it.type !== 'chroma' && it.type !== 'halftone'), env));
        crosshair(ctx, m, q.t, q.m);
      } else crosshair(ctx, m, hover.t, hover.midi);
    }
  }

  function render() {
    const p = getGridParams();
    const lines = getGridLines(p);
    const bake = getGridBake(p); // memoised by signature / 시그니처로 메모이즈
    renderEditor(p, lines, bake);
    renderResult(p, lines, bake);
    if (hover && els.hud) {
      els.hud.time.textContent = `${hover.t.toFixed(2)}s`;
      els.hud.note.textContent = midiToNoteName(hover.midi);
      els.hud.hz.textContent = `${midiToFreq(hover.midi).toFixed(1)} Hz`;
    }
  }

  // ------------------------------------------------------------------ Editor: the Liquify brush drags the space
  const cellOf = (m, pt) => [m.xToTime(pt.x) / GRID_CELL.ut, m.yToMidi(pt.y) / GRID_CELL.um];

  function commitBrush(final) {
    const d0 = drag;
    const now = performance.now();
    if (!final && now - d0.lastCommit < COMMIT_MS) return;
    d0.lastCommit = now;
    const pts = d0.pts.length > 60 ? d0.pts.filter((_, k) => k % Math.ceil(d0.pts.length / 60) === 0 || k === d0.pts.length - 1) : d0.pts;
    editGrid((d) => {
      let it = d.space.find((x) => x.type === 'liquify');
      if (!it) { it = createWarpStage('liquify', { id: 'w-liquify' }); d.space.unshift(it); }
      it.on = true;
      const tl = d.tool;
      const mask = tl.clip && tl.sel ? { poly: tl.sel.poly, feather: tl.feather } : null; // confined to the selection / 선택 영역 안에서만
      const op = { tool: tl.liq, size: tl.size, strength: tl.strength, ...sanitizeBrushDetail({ ...tl, mask }), pts: pts.map((q) => [q[0], q[1]]) };
      if (d0.opIndex < it.params.ops.length) it.params.ops[d0.opIndex] = op; else it.params.ops.push(op);
      d.preset = '';
    }, { coalesceKey: 'grid-liquify' });
    if (final) endHistoryGesture();
  }

  const onDownE = (e) => {
    const p = getGridParams();
    const m = last.editor || gridMetrics(els.editor.clientWidth, els.editor.clientHeight, p.view);
    const pt = pos(els.editor, e);
    try { els.editor.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    if (e.button === 1 || (e.button === 0 && !m.inPlot(pt))) { drag = { type: 'pan', x: pt.x, y: pt.y, view: { ...p.view }, m }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const mode = p.tool.mode;
    if (GRID_SEL_KINDS.includes(mode)) { drag = { type: 'select', kind: mode, start: cellOf(m, pt), pts: [cellOf(m, pt)], last: pt, x0: pt.x, y0: pt.y, far: 0, preview: null }; return; }
    if (mode === 'pull') {
      const session = beginGridPull(cellOf(m, pt));
      if (!session.ok) { showToast?.(t(`grid.pull.${session.reason}`), 'error'); return; }
      drag = { type: 'pull', session, m, dx: 0, dy: 0, lastCommit: 0 };
      return;
    }
    const n = p.space.find((x) => x.type === 'liquify')?.params.ops.length || 0;
    if (n >= LIQUIFY_MAX_OPS) { showToast?.(t('grid.liqFull', LIQUIFY_MAX_OPS), 'error'); return; }
    const c0 = cellOf(m, pt);
    drag = { type: 'brush', pts: [c0], last: pt, smooth: c0, opIndex: n, lastCommit: 0 };
    if (p.tool.liq !== 'push') commitBrush(false);
  };

  /** Selection polygon (cells) of a drag. / 드래그의 선택 다각형 */
  function selectionPoly(d) {
    const [x0, y0] = d.start;
    const [x1, y1] = d.pts[d.pts.length - 1];
    const F = REGION_FAR;
    if (d.kind === 'selPitch') return [[-F, y0], [F, y0], [F, y1], [-F, y1]];
    if (d.kind === 'selTime') return [[x0, -F], [x1, -F], [x1, F], [x0, F]];
    if (d.kind === 'selBox') return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    let pts = d.pts;
    if (pts.length > REGION_MAX_PTS) { const k = Math.ceil(pts.length / REGION_MAX_PTS); pts = pts.filter((_, i) => i % k === 0); }
    return pts;
  }

  function finishSelect(d) {
    const tiny = d.far < 4; // the farthest the pointer went (a lasso ends where it began) / 포인터가 가장 멀리 간 거리
    const poly = selectionPoly(d);
    // a click (no drag) or a lasso of fewer than 3 points clears the selection / 클릭 = 선택 해제
    const sel = tiny || poly.length < 3 ? null : { kind: d.kind, poly: poly.map((q) => [q[0], q[1]]) };
    editGrid((dd) => { dd.tool.sel = sel; }, { history: false });
  }

  function commitPull(final) {
    const now = performance.now();
    if (!final && now - drag.lastCommit < COMMIT_MS) return;
    drag.lastCommit = now;
    writeGridPull(drag.session, drag.dx, drag.dy);
    if (final) endHistoryGesture();
  }

  const panTo = (pt) => {
    const vp = drag.view;
    setView((vw) => { Object.assign(vw, { tMin: vp.tMin, tMax: vp.tMax, midiMin: vp.midiMin, midiMax: vp.midiMax }); panViewTime(vw, -((pt.x - drag.x) / drag.m.plotW) * (vp.tMax - vp.tMin), GRID_VIEW_LIMITS); panViewPitch(vw, ((pt.y - drag.y) / drag.m.plotH) * (vp.midiMax - vp.midiMin), GRID_VIEW_LIMITS); });
  };

  const onMoveE = (e) => {
    const p = getGridParams();
    const m = last.editor || gridMetrics(els.editor.clientWidth, els.editor.clientHeight, p.view);
    const pt = pos(els.editor, e);
    hover = { t: m.xToTime(pt.x), midi: m.yToMidi(pt.y), src: 'editor' };
    if (drag?.type === 'pan') { panTo(pt); return; }
    if (drag?.type === 'brush' && Math.hypot(pt.x - drag.last.x, pt.y - drag.last.y) >= 3) {
      // smoothing: the brush follows the pointer with a lag (a steadier line) / 손떨림 보정
      const c = cellOf(m, pt);
      const k = 1 - p.tool.smooth;
      drag.smooth = [drag.smooth[0] + (c[0] - drag.smooth[0]) * k, drag.smooth[1] + (c[1] - drag.smooth[1]) * k];
      drag.pts.push(drag.smooth);
      drag.last = pt;
      commitBrush(false);
    }
    if (drag?.type === 'select') {
      const c = cellOf(m, pt);
      drag.far = Math.max(drag.far, Math.hypot(pt.x - drag.x0, pt.y - drag.y0));
      if (drag.kind !== 'selLasso') drag.pts = [drag.start, c];
      else if (Math.hypot(pt.x - drag.last.x, pt.y - drag.last.y) >= 3) drag.pts.push(c);
      drag.last = pt;
      drag.preview = selectionPoly(drag);
    }
    if (drag?.type === 'pull') {
      const c = cellOf(m, pt);
      drag.dx = c[0] - drag.session.grab[0];
      drag.dy = c[1] - drag.session.grab[1];
      commitPull(false);
    }
    const mode = p.tool.mode;
    els.editor.style.cursor = !m.inPlot(pt) ? 'grab' : mode === 'pull' ? (drag?.type === 'pull' ? 'grabbing' : 'move') : 'crosshair';
    requestRender(['grid']);
  };

  const onUpE = (e) => {
    try { els.editor.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (drag?.type === 'brush' && (drag.pts.length >= 2 || getGridParams().tool.liq !== 'push')) commitBrush(true);
    if (drag?.type === 'select') finishSelect(drag);
    if (drag?.type === 'pull') { if (Math.abs(drag.dx) + Math.abs(drag.dy) > 1e-6) commitPull(true); else endHistoryGesture(); }
    drag = null;
    requestRender(['grid']);
  };

  // ------------------------------------------------------------------ Result: read-only (a drag pans)
  const onDownR = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const p = getGridParams();
    const m = last.result || gridMetrics(els.result.clientWidth, els.result.clientHeight, p.view);
    const pt = pos(els.result, e);
    try { els.result.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    drag = { type: 'pan', x: pt.x, y: pt.y, view: { ...p.view }, m };
  };
  const onMoveR = (e) => {
    const p = getGridParams();
    const m = last.result || gridMetrics(els.result.clientWidth, els.result.clientHeight, p.view);
    const pt = pos(els.result, e);
    hover = { t: m.xToTime(pt.x), midi: m.yToMidi(pt.y), src: 'result' };
    if (drag?.type === 'pan') { panTo(pt); return; }
    requestRender(['grid']);
  };
  const onUpR = (e) => {
    drag = null;
    try { els.result.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  };
  const onLeave = () => { if (!drag) { hover = null; requestRender(['grid']); } };

  const onWheel = (cv, which) => (e) => {
    e.preventDefault();
    const p = getGridParams();
    const m = last[which] || gridMetrics(cv.clientWidth, cv.clientHeight, p.view);
    const pt = pos(cv, e);
    editGrid((d) => wheelNavigate(e, d.view, m, pt, GRID_VIEW_LIMITS), { history: false }); // shared wheel grammar / 공용 휠 문법
  };
  const onDbl = (cv, which) => (e) => {
    const m = last[which];
    if (!m) return;
    const pt = pos(cv, e);
    if (pt.x < m.plotX || pt.x > m.plotX + m.plotW) return;
    cueOrAudition(e, Math.max(0, Number(m.xToTime(pt.x).toFixed(2))));
  };
  const handlers = [
    [els.editor, 'pointerdown', onDownE], [els.editor, 'pointermove', onMoveE], [els.editor, 'pointerup', onUpE], [els.editor, 'pointercancel', onUpE], [els.editor, 'pointerleave', onLeave],
    [els.editor, 'dblclick', onDbl(els.editor, 'editor')], [els.editor, 'wheel', onWheel(els.editor, 'editor'), { passive: false }], [els.editor, 'auxclick', (e) => e.preventDefault()],
    [els.result, 'pointerdown', onDownR], [els.result, 'pointermove', onMoveR], [els.result, 'pointerup', onUpR], [els.result, 'pointercancel', onUpR], [els.result, 'pointerleave', onLeave],
    [els.result, 'dblclick', onDbl(els.result, 'result')], [els.result, 'wheel', onWheel(els.result, 'result'), { passive: false }],
  ];
  for (const [node, ev, fn, opt] of handlers) node.addEventListener(ev, fn, opt);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['grid'])) : null;
  ro?.observe(els.editor);
  ro?.observe(els.result);

  return {
    render,
    metrics: () => ({ ...last }),
    /** Save a window as PNG: 'result' (default), 'editor' or 'both' (stacked). / 윈도우를 PNG로 저장 */
    screenshot(kind = 'result') {
      const list = kind === 'both' ? [els.editor, els.result] : [kind === 'editor' ? els.editor : els.result];
      const out = document.createElement('canvas');
      out.width = Math.max(...list.map((c) => c.width));
      out.height = list.reduce((s, c) => s + c.height, 0);
      const g = out.getContext('2d');
      let y = 0;
      for (const c of list) { g.drawImage(c, 0, y); y += c.height; }
      out.toBlob((b) => { if (b) triggerDownload(b, `flexatone_grid_${kind}_${Date.now()}.png`); }, 'image/png');
    },
    destroy() { ro?.disconnect(); },
  };
}
