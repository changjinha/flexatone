/**
 * Flexatone — studios/space/space-timeline.js
 * Space Studio UI tier: the timeline — one row per source (and one for a moving listener) on the
 * document's time axis. A block is the source's own clock (start … start + duration); the lighter
 * tail is when its sound is still arriving. Time pins of a 'pinned' spline are diamonds on the block.
 * 스페이스 스튜디오 UI: 타임라인 — 문서 시간축 위에 음원마다 한 줄(움직이는 청취자도 한 줄). 블록 = 음원 자체
 * 시계(시작 … 시작 + 지속시간), 옅은 꼬리 = 소리가 아직 도착하는 구간. 'pinned' 스플라인의 시각 핀 = 마름모.
 *
 * Gestures / 조작: drag a block = start · drag its right edge = duration · drag a pin = node time
 * (kept between its neighbours) · click a row = select the source · double-click = cue.
 * One drag = one undo step. Shares the cue / playhead look with the other time canvases.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { getKinematics, getListenerMotion } from './space-engine.js';
import { getSpaceParams, editSpace, getSpaceBake, isSourceAudible } from './space-doc.js'; // the document on screen: studio or Space Master / 화면의 문서
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { cueOrAudition } from '../../ui/locate-tool.js';
import { sizeCanvas2d } from '../../ui/canvas-size.js';

const PAD = { left: 96, right: 12, top: 18, bottom: 6 };
const ROW = 22;
const FONT = '11px ui-monospace, Menlo, monospace';
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

/** Rows of the timeline: [{ id, name, color, start, dur, t1, pins: [{ id, t }], listener }] (pure). / 타임라인 행 */
export function timelineRows(doc) {
  const bake = getSpaceBake(doc);
  const rows = doc.sources.map((s) => {
    const kin = getKinematics(s, doc);
    const pinned = s.path.type === 'spline' && s.timeMode === 'pinned';
    return {
      id: s.id, name: s.name, color: s.color, start: kin.start, dur: kin.dur, t1: bake.sources.get(s.id)?.t1 ?? kin.start + kin.dur, audible: isSourceAudible(s, doc),
      pins: pinned ? s.path.spline.nodes.filter((n) => Number.isFinite(Number(n.t)) && n.t !== null).map((n) => ({ id: n.id, t: Number(n.t) })) : [],
      durFixed: !(s.path.type === 'spline' && s.timeMode === 'speed' && s.path.spline.end === 'stop'), // false = the duration is a result / 지속시간이 결과값
    };
  });
  const lm = getListenerMotion(doc);
  if (lm) rows.unshift({ id: '@listener', name: t('space.tlListener'), color: '#e2e8f0', start: lm.kin.start, dur: lm.kin.dur, t1: lm.kin.start + lm.kin.dur, audible: true, pins: [], durFixed: false, listener: true });
  return rows;
}

/** Height (px) the canvas needs for a document. / 문서에 필요한 캔버스 높이 */
export const timelineHeight = (doc) => PAD.top + PAD.bottom + ROW * (doc.sources.length + (doc.listener.move?.on ? 1 : 0));

export function createSpaceTimeline(canvas, { requestRender }) {
  let drag = null;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const axis = (w, doc) => {
    const pw = Math.max(10, w - PAD.left - PAD.right);
    const len = Math.max(0.5, doc.length);
    return { pw, len, X: (s) => PAD.left + (s / len) * pw, T: (px) => ((px - PAD.left) / pw) * len };
  };

  function render() {
    const doc = getSpaceParams();
    canvas.style.height = `${timelineHeight(doc)}px`;
    const { ctx, w, h } = sizeCanvas2d(canvas);
    const ax = axis(w, doc);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    const step = [0.5, 1, 2, 5, 10, 20, 50].find((s) => (s / ax.len) * ax.pw >= 46) || 100;
    for (let s = 0; s <= ax.len + 1e-9; s += step) {
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.4)';
      ctx.beginPath(); ctx.moveTo(ax.X(s), PAD.top - 4); ctx.lineTo(ax.X(s), h); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(`${roundTo(s, 1)}s`, ax.X(s) + 2, 11);
    }
    timelineRows(doc).forEach((r, i) => {
      const y = PAD.top + i * ROW;
      const on = r.id === doc.activeSourceId;
      ctx.fillStyle = on ? '#e2e8f0' : '#94a3b8';
      ctx.fillText(r.name.slice(0, 13), 6, y + 15);
      const x0 = ax.X(r.start);
      const x1 = ax.X(r.start + r.dur);
      ctx.fillStyle = alpha(r.color, 0.14); // sound still arriving / 소리가 아직 도착하는 구간
      ctx.fillRect(x0, y + 5, Math.max(1, ax.X(r.t1) - x0), ROW - 10);
      ctx.fillStyle = alpha(r.color, r.audible ? (on ? 0.75 : 0.5) : 0.2);
      ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0), ROW - 6);
      if (r.durFixed) { ctx.fillStyle = '#f8fafc'; ctx.fillRect(x1 - 2, y + 3, 2, ROW - 6); } // draggable end / 끌 수 있는 끝
      for (const p of r.pins) {
        const px = ax.X(r.start + p.t);
        ctx.fillStyle = '#fbbf24';
        ctx.save(); ctx.translate(px, y + ROW / 2); ctx.rotate(Math.PI / 4); ctx.fillRect(-4, -4, 8, 8); ctx.restore();
      }
    });
    const tr = appState.transport;
    drawCueLine(ctx, ax.X(tr.cueSec), PAD.top - 4, h);
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, ax.X(tr.playheadSec), PAD.top - 4, h);
  }

  function hit(p, doc) {
    const ax = axis(canvas.clientWidth, doc);
    const rows = timelineRows(doc);
    const i = Math.floor((p.y - PAD.top) / ROW);
    const r = rows[i];
    if (!r) return null;
    for (const pin of r.pins) if (Math.abs(p.x - ax.X(r.start + pin.t)) < 7) return { type: 'pin', row: r, pin };
    const x0 = ax.X(r.start);
    const x1 = ax.X(r.start + r.dur);
    if (r.durFixed && Math.abs(p.x - x1) < 6) return { type: 'end', row: r };
    if (p.x >= x0 - 2 && p.x <= x1 + 2) return { type: 'block', row: r };
    return { type: 'row', row: r };
  }
  const editRow = (id, fn, ck) => editSpace((d) => { if (id === '@listener') fn(d.listener.move, d); else { const s = d.sources.find((x) => x.id === id); if (s) fn(s, d); } }, { coalesceKey: ck });

  const onDown = (e) => {
    if (e.button !== 0 || e.altKey) return;
    const doc = getSpaceParams();
    const p = pos(e);
    const h = hit(p, doc);
    if (!h) return;
    if (!h.row.listener && doc.activeSourceId !== h.row.id) editSpace((d) => { d.activeSourceId = h.row.id; }, { history: false });
    if (h.type === 'row') return;
    drag = { ...h, x: p.x, start: h.row.start, dur: h.row.dur, pinT: h.pin?.t };
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
  };
  const onMove = (e) => {
    if (!drag) return;
    const doc = getSpaceParams();
    const ax = axis(canvas.clientWidth, doc);
    const dSec = ((pos(e).x - drag.x) / ax.pw) * ax.len;
    const id = drag.row.id;
    if (drag.type === 'block') editRow(id, (s) => { s.start = roundTo(clamp(drag.start + dSec, 0, 300), 2); }, 'space-tl-start');
    else if (drag.type === 'end') editRow(id, (s) => { s.duration = roundTo(clamp(drag.dur + dSec, 0.1, 300), 2); }, 'space-tl-dur');
    else if (drag.type === 'pin') {
      const pinId = drag.pin.id;
      editRow(id, (s) => {
        const nodes = s.path.spline.nodes;
        const k = nodes.findIndex((n) => n.id === pinId);
        if (k < 0) return;
        // a pin stays between the pinned nodes around it / 핀은 앞뒤 핀 사이에 머묾
        let lo = 0.01;
        let hi = 300;
        for (let j = k - 1; j >= 0; j--) if (Number.isFinite(Number(nodes[j].t)) && nodes[j].t !== null) { lo = Number(nodes[j].t) + 0.02; break; }
        for (let j = k + 1; j < nodes.length; j++) if (Number.isFinite(Number(nodes[j].t)) && nodes[j].t !== null) { hi = Number(nodes[j].t) - 0.02; break; }
        nodes[k].t = roundTo(clamp(drag.pinT + dSec, lo, Math.max(lo, hi)), 2);
      }, 'space-tl-pin');
    }
  };
  const onUp = (e) => {
    if (drag) endHistoryGesture();
    drag = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['space']);
  };
  const onDbl = (e) => {
    if (e.altKey) return;
    const doc = getSpaceParams();
    cueOrAudition(e, Math.max(0, Number(axis(canvas.clientWidth, doc).T(pos(e).x).toFixed(2))));
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDbl);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['space'])) : null;
  ro?.observe(canvas);
  return { render, destroy() { ro?.disconnect(); } };
}
