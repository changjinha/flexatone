/**
 * Flexatone — studios/cloud/cloud-canvases.js
 * Cloud Studio UI tier: event scatter (time × pitch), side histogram vs theoretical PDF, and the
 * time-curve strip editor (density / center / width / collapse).
 * 클라우드 스튜디오 UI: 이벤트 산점도, 옆 히스토그램(이론 PDF 비교), 시간 곡선 편집 스트립.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder; only cloud-panels.js imports it.
 * Performance: all events are drawn ONCE into an offscreen layer (batched by gain bucket) keyed by
 * signature + view + size; each frame only blits it and highlights the events under the playhead.
 * 모든 이벤트는 오프스크린에 한 번만 그리고(게인 구간별 일괄), 프레임마다 블릿 + 재생 중 이벤트만 강조.
 * Interaction: drag = pan · wheel = time zoom (Shift = pitch) · double-click = cue.
 * Strip: Custom engine → drag points, click empty space to add, Alt/right-click a point to delete.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { lowerBound, eventMidiAt, curveTable, getCurve, evalCloudCurve, distributionPdf, pitchHistogram, buildSieveSet, CURVE_RANGES } from './cloud-engine.js';
import { editCloud } from '../cloud-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';

const PAD = { left: 52, right: 12, top: 14, bottom: 22 };
const BLACK = new Set([1, 3, 6, 8, 10]);
const BUCKETS = 6;


function metrics(canvas, view, pad = PAD) {
  const { dpr, w, h } = sizeCanvas(canvas, 60, 40);
  const m = { dpr, w, h, plotW: Math.max(10, w - pad.left - pad.right), plotH: Math.max(10, h - pad.top - pad.bottom) };
  const tSpan = Math.max(0.1, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  m.timeToX = (sec) => pad.left + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - pad.left) / m.plotW) * tSpan;
  m.midiToY = (midi) => pad.top + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - pad.top) / m.plotH) * mSpan;
  return m;
}

const pos = (canvas, e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function drawPianoGrid(ctx, m, view) {
  for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
    const pc = ((midi % 12) + 12) % 12;
    const yTop = m.midiToY(midi + 0.5);
    const yBot = m.midiToY(midi - 0.5);
    ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.3)';
    ctx.fillRect(PAD.left, yTop, m.plotW, Math.max(1, yBot - yTop));
    if (pc === 0) {
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, m.midiToY(midi));
      ctx.lineTo(PAD.left + m.plotW, m.midiToY(midi));
      ctx.stroke();
    }
  }
}

function drawAxes(ctx, m, view, length) {
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const step = view.midiMax - view.midiMin > 48 ? 12 : 6;
  for (let midi = Math.ceil(view.midiMin / step) * step; midi <= view.midiMax; midi += step) ctx.fillText(midiToNoteName(midi), PAD.left - 6, m.midiToY(midi));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const span = view.tMax - view.tMin;
  const ts = span > 60 ? 10 : span > 20 ? 5 : span > 8 ? 2 : span > 3 ? 1 : 0.5;
  for (let s = Math.ceil(view.tMin / ts) * ts; s <= view.tMax + 1e-6; s += ts) {
    const x = m.timeToX(s);
    ctx.fillText(`${roundTo(s, 1)}s`, x, PAD.top + m.plotH + 5);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + m.plotH);
    ctx.stroke();
  }
  // document end / 문서 끝
  const ex = m.timeToX(length);
  if (ex > PAD.left && ex < PAD.left + m.plotW) {
    ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
    ctx.fillRect(ex, PAD.top, PAD.left + m.plotW - ex, m.plotH);
  }
}

/**
 * @param {{ main: HTMLCanvasElement, hist: HTMLCanvasElement, strip: HTMLCanvasElement, hud: object }} els
 * @param {{ requestRender: Function, onHover?: Function }} opts
 */
export function createCloudCanvases(els, { requestRender }) {
  const layer = document.createElement('canvas');
  let layerKey = '';
  let cur = { params: null, ev: null };
  let hoverSec = null;
  let drag = null;
  let stripDrag = null;

  // ------------------------------------------------------------------ main layer
  function buildLayer(m, params, ev) {
    layer.width = Math.floor(m.w * m.dpr);
    layer.height = Math.floor(m.h * m.dpr);
    const ctx = layer.getContext('2d');
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);
    const view = params.view;
    drawPianoGrid(ctx, m, view);
    // sieve lines / 체 음고선
    if (params.pitch.sieve.enabled) {
      const set = buildSieveSet(params.pitch.sieve, Math.max(params.pitch.min, view.midiMin), Math.min(params.pitch.max, view.midiMax));
      if (set.length < 400) {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.2)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        for (const p of set) { const y = m.midiToY(p); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + m.plotW, y); }
        ctx.stroke();
      }
    }
    // center ± effective width band / 중심 ± 유효 폭 띠
    const cT = curveTable(params.pitch.center, 'center', 256);
    const wT = curveTable(params.pitch.width, 'width', 256);
    const kT = curveTable(params.glide.clusterCollapse, 'collapse', 256);
    const L = params.length;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) { const s = (i / 255) * L; const y = m.midiToY(cT[i] + wT[i] * (1 - kT[i])); i ? ctx.lineTo(m.timeToX(s), y) : ctx.moveTo(m.timeToX(s), y); }
    for (let i = 255; i >= 0; i--) { const s = (i / 255) * L; ctx.lineTo(m.timeToX(s), m.midiToY(cT[i] - wT[i] * (1 - kT[i]))); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(167, 139, 250, 0.07)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.35)';
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    for (let i = 0; i < 256; i++) { const s = (i / 255) * L; const y = m.midiToY(cT[i]); i ? ctx.lineTo(m.timeToX(s), y) : ctx.moveTo(m.timeToX(s), y); }
    ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // events, batched by gain bucket / 게인 구간별 일괄 그리기
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    const a = lowerBound(ev.t0, ev.n, view.tMin - ev.maxDur);
    const b = lowerBound(ev.t0, ev.n, view.tMax);
    for (let k = 0; k < BUCKETS; k++) {
      const g = (k + 0.5) / BUCKETS;
      ctx.strokeStyle = `rgba(56, 189, 248, ${(0.22 + 0.7 * g).toFixed(3)})`;
      ctx.lineWidth = 0.6 + 2 * g;
      ctx.beginPath();
      for (let i = a; i < b; i++) {
        if (Math.min(BUCKETS - 1, Math.floor(ev.gain[i] * BUCKETS)) !== k) continue;
        ctx.moveTo(m.timeToX(ev.t0[i]), m.midiToY(ev.p0[i]));
        ctx.lineTo(m.timeToX(ev.t0[i] + ev.dur[i]), m.midiToY(ev.p1[i]));
      }
      ctx.stroke();
    }
    ctx.restore();
    drawAxes(ctx, m, view, L);
  }

  function renderMain(params, ev) {
    const canvas = els.main;
    const m = metrics(canvas, params.view);
    const key = [ev.sig, JSON.stringify(params.view), m.w, m.h, m.dpr, params.pitch.sieve.enabled].join('|');
    if (key !== layerKey) { buildLayer(m, params, ev); layerKey = key; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    const tr = appState.transport;
    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    drawCueLine(ctx, m.timeToX(tr.cueSec), PAD.top, PAD.top + m.plotH);
    if (tr.playing && tr.playheadSec >= 0) {
      const ph = tr.playheadSec;
      const x = m.timeToX(ph);
      drawPlayheadLine(ctx, x, PAD.top, PAD.top + m.plotH);
      // highlight sounding events / 울리는 이벤트 강조
      const a = lowerBound(ev.t0, ev.n, ph - ev.maxDur);
      const b = lowerBound(ev.t0, ev.n, ph);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.95)';
      ctx.fillStyle = '#fde68a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let lit = 0;
      for (let i = a; i < b; i++) {
        if (ev.t0[i] + ev.dur[i] < ph) continue;
        ctx.moveTo(m.timeToX(ev.t0[i]), m.midiToY(ev.p0[i]));
        ctx.lineTo(x, m.midiToY(eventMidiAt(ev, i, ph)));
        lit++;
      }
      ctx.stroke();
      els.hud.active.textContent = String(lit);
    } else els.hud.active.textContent = '0';
    return m;
  }

  // ------------------------------------------------------------------ histogram (pitch axis aligned)
  function histCenterSec(params) {
    const tr = appState.transport;
    if (tr.playing && tr.playheadSec >= 0) return tr.playheadSec;
    if (hoverSec !== null) return hoverSec;
    return clamp(tr.cueSec || params.length / 2, 0, params.length);
  }

  function renderHist(params, ev) {
    const canvas = els.hist;
    const view = params.view;
    const m = metrics(canvas, view, { left: 4, right: 4, top: PAD.top, bottom: PAD.bottom });
    const ctx = canvas.getContext('2d');
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(4, PAD.top, m.plotW, m.plotH);
    const win = clamp(Number(view.histWin) || 4, 0.5, 60);
    const tc = histCenterSec(params);
    const tA = Math.max(0, tc - win / 2);
    const tB = Math.min(params.length, tc + win / 2);
    const binW = view.midiMax - view.midiMin > 60 ? 1 : 0.5;
    const h = pitchHistogram(ev, tA, tB, view.midiMin, view.midiMax, binW);
    let peak = 1;
    for (const c of h.counts) peak = Math.max(peak, c);
    // theory at the window centre (pre-sieve, before range clipping) / 이론 PDF (체·범위 적용 전)
    const tn = clamp(tc / params.length, 0, 1);
    const c = evalCloudCurve(params.pitch.center, tn, 'center');
    const w = evalCloudCurve(params.pitch.width, tn, 'width') * (1 - evalCloudCurve(params.glide.clusterCollapse, tn, 'collapse'));
    const dist = params.pitch.dist;
    const theory = [];
    if (dist !== 'brownian' && h.total > 0) {
      for (let k = 0; k <= 200; k++) {
        const midi = view.midiMin + ((view.midiMax - view.midiMin) * k) / 200;
        const pdf = distributionPdf(dist, midi, c, w, params.pitch.levyAlpha);
        theory.push([midi, pdf * h.total * binW]);
        if (dist !== 'uniform') peak = Math.max(peak, pdf * h.total * binW);
      }
    }
    const xOf = (count) => 4 + (count / peak) * m.plotW;
    ctx.fillStyle = 'rgba(56, 189, 248, 0.55)';
    for (let b = 0; b < h.bins; b++) {
      if (!h.counts[b]) continue;
      const y0 = m.midiToY(view.midiMin + (b + 1) * binW);
      const y1 = m.midiToY(view.midiMin + b * binW);
      ctx.fillRect(4, y0, xOf(h.counts[b]) - 4, Math.max(1, y1 - y0 - 0.5));
    }
    if (theory.length) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.4;
      if (params.pitch.sieve.enabled) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      theory.forEach(([midi, v], i) => { const x = Math.min(4 + m.plotW, xOf(v)); const y = m.midiToY(midi); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    els.hud.hist.textContent = t('cloud.histLegend', h.total, roundTo(tA, 1), roundTo(tB, 1));
  }

  // ------------------------------------------------------------------ curve strip
  const STRIP_PAD = { left: PAD.left, right: PAD.right, top: 10, bottom: 18 };
  function stripRange(params, key) {
    const curve = getCurve(params, key);
    const r = CURVE_RANGES[key];
    if (key === 'collapse') return [0, 1];
    if (key === 'center') return [params.view.midiMin, params.view.midiMax];
    const top = Math.max(1, Number(curve.lo) || 0, Number(curve.hi) || 0) * 1.2;
    return [0, Math.min(r.max * 1.05, top)];
  }

  function stripMetrics(params, key) {
    const m = metrics(els.strip, params.view, STRIP_PAD);
    const [ymin, ymax] = stripRange(params, key);
    m.ymin = ymin;
    m.ymax = ymax;
    m.valToY = (v) => STRIP_PAD.top + (1 - (v - ymin) / Math.max(1e-9, ymax - ymin)) * m.plotH;
    m.yToVal = (py) => ymin + (1 - (py - STRIP_PAD.top) / m.plotH) * (ymax - ymin);
    return m;
  }

  function renderStrip(params) {
    const key = params.view.curveTab;
    const curve = getCurve(params, key);
    const m = stripMetrics(params, key);
    const ctx = els.strip.getContext('2d');
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.clearRect(0, 0, m.w, m.h);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(STRIP_PAD.left, STRIP_PAD.top, m.plotW, m.plotH);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const fmt = (v) => (key === 'center' ? midiToNoteName(Math.round(v)) : String(roundTo(v, key === 'collapse' ? 2 : 1)));
    ctx.fillText(fmt(m.ymax), STRIP_PAD.left - 6, STRIP_PAD.top + 4);
    ctx.fillText(fmt(m.ymin), STRIP_PAD.left - 6, STRIP_PAD.top + m.plotH - 2);
    const L = params.length;
    const x0 = Math.max(STRIP_PAD.left, m.timeToX(0));
    const x1 = Math.min(STRIP_PAD.left + m.plotW, m.timeToX(L));
    ctx.save();
    ctx.beginPath();
    ctx.rect(STRIP_PAD.left, 0, m.plotW, m.h);
    ctx.clip();
    ctx.beginPath();
    const steps = 300;
    for (let i = 0; i <= steps; i++) {
      const px = x0 + ((x1 - x0) * i) / steps;
      const v = evalCloudCurve(curve, clamp(m.xToTime(px) / L, 0, 1), key);
      const y = m.valToY(v);
      i ? ctx.lineTo(px, y) : ctx.moveTo(px, y);
    }
    ctx.strokeStyle = { density: '#38bdf8', center: '#a78bfa', width: '#34d399', collapse: '#f472b6' }[key];
    ctx.lineWidth = 2;
    ctx.stroke();
    if (curve.engine === 'custom') {
      for (const p of curve.customPoints) {
        const px = m.timeToX(p.x * L);
        const py = m.valToY(curve.lo + p.y * (curve.hi - curve.lo));
        ctx.fillStyle = '#f8fafc';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const tr = appState.transport;
    const sec = tr.playing && tr.playheadSec >= 0 ? tr.playheadSec : tr.cueSec;
    ctx.strokeStyle = tr.playing ? '#f8fafc' : '#fbbf24'; // playhead white / cue amber (shared look)
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(m.timeToX(sec), STRIP_PAD.top);
    ctx.lineTo(m.timeToX(sec), STRIP_PAD.top + m.plotH);
    ctx.stroke();
    ctx.restore();
    els.hud.curveVal.textContent = `${fmt(evalCloudCurve(curve, clamp(sec / L, 0, 1), key))}${CURVE_RANGES[key].unit ? ` ${CURVE_RANGES[key].unit}` : ''}`;
  }

  /** Make a custom curve editable when lo = hi (keeps the drawn value). / lo=hi일 때 편집 가능하게 */
  function ensureEditableRange(curve, m) {
    if (Math.abs(curve.hi - curve.lo) > 1e-9) return;
    const v = curve.lo;
    curve.lo = roundTo(m.ymin, 3);
    curve.hi = roundTo(m.ymax, 3);
    const y = (v - curve.lo) / (curve.hi - curve.lo);
    for (const p of curve.customPoints) p.y = roundTo(y, 5);
  }

  function stripHit(params, p) {
    const key = params.view.curveTab;
    const curve = getCurve(params, key);
    if (curve.engine !== 'custom') return { key, m: stripMetrics(params, key), idx: -1 };
    const m = stripMetrics(params, key);
    let idx = -1;
    let best = 9;
    curve.customPoints.forEach((q, i) => {
      const d = Math.hypot(m.timeToX(q.x * params.length) - p.x, m.valToY(curve.lo + q.y * (curve.hi - curve.lo)) - p.y);
      if (d < best) { best = d; idx = i; }
    });
    return { key, m, idx };
  }

  function onStripDown(e) {
    const params = cur.params;
    if (!params) return;
    const p = pos(els.strip, e);
    const { key, m, idx } = stripHit(params, p);
    if (getCurve(params, key).engine !== 'custom') return;
    const L = params.length;
    const toPoint = (pp, curve) => ({
      x: clamp(m.xToTime(pp.x) / L, 0, 1),
      y: clamp((clamp(m.yToVal(pp.y), CURVE_RANGES[key].min, CURVE_RANGES[key].max) - curve.lo) / Math.max(1e-9, curve.hi - curve.lo), -0.5, 1.5),
    });
    if (idx >= 0 && (e.altKey || e.button === 2)) {
      e.preventDefault();
      editCloud((d) => { const c = getCurve(d, key); if (idx > 0 && idx < c.customPoints.length - 1) c.customPoints.splice(idx, 1); });
      endHistoryGesture();
      return;
    }
    let target = idx;
    if (target < 0) {
      editCloud((d) => {
        const c = getCurve(d, key);
        ensureEditableRange(c, m);
        const q = toPoint(p, c);
        const pts = c.customPoints;
        let at = pts.findIndex((x) => x.x > q.x);
        if (at <= 0) at = pts.length - 1;
        pts.splice(at, 0, { x: roundTo(q.x, 4), y: roundTo(clamp(q.y, 0, 1), 4), handles: [] });
        target = at;
      }, { coalesceKey: `cloud:strip:${key}` });
    }
    stripDrag = { key, idx: target, m };
    try { els.strip.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
  }

  function onStripMove(e) {
    if (!stripDrag || !cur.params) return;
    const p = pos(els.strip, e);
    const { key, idx, m } = stripDrag;
    const L = cur.params.length;
    editCloud((d) => {
      const c = getCurve(d, key);
      ensureEditableRange(c, m);
      const pts = c.customPoints;
      const q = pts[idx];
      if (!q) return;
      const v = clamp(m.yToVal(p.y), CURVE_RANGES[key].min, CURVE_RANGES[key].max);
      q.y = roundTo(clamp((v - c.lo) / Math.max(1e-9, c.hi - c.lo), 0, 1), 4);
      if (idx > 0 && idx < pts.length - 1) q.x = roundTo(clamp(m.xToTime(p.x) / L, pts[idx - 1].x + 0.002, pts[idx + 1].x - 0.002), 4);
    }, { coalesceKey: `cloud:strip:${key}` });
  }

  function onStripUp(e) {
    if (!stripDrag) return;
    stripDrag = null;
    try { els.strip.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    endHistoryGesture();
  }

  // ------------------------------------------------------------------ main interaction
  function onDown(e) {
    if (!cur.params) return;
    drag = { p: pos(els.main, e), view: { ...cur.params.view } };
    try { els.main.setPointerCapture?.(e.pointerId); } catch { /* synthetic */ }
  }
  function onMove(e) {
    if (!cur.params) return;
    const p = pos(els.main, e);
    const m = metrics(els.main, cur.params.view);
    const sec = m.xToTime(p.x);
    const midi = m.yToMidi(p.y);
    els.hud.time.textContent = `${roundTo(sec, 2).toFixed(2)}s`;
    els.hud.note.textContent = midiToNoteName(Math.round(midi));
    els.hud.hz.textContent = `${midiToFreq(midi).toFixed(1)} Hz`;
    hoverSec = sec >= 0 && sec <= cur.params.length ? sec : null;
    if (drag) {
      const v0 = drag.view;
      const dt = ((p.x - drag.p.x) / m.plotW) * (v0.tMax - v0.tMin);
      const dm = ((p.y - drag.p.y) / m.plotH) * (v0.midiMax - v0.midiMin);
      editCloud((d) => { Object.assign(d.view, { tMin: v0.tMin - dt, tMax: v0.tMax - dt, midiMin: v0.midiMin + dm, midiMax: v0.midiMax + dm }); }, { history: false });
    } else requestRender(['studio']);
  }
  function onUp(e) {
    drag = null;
    try { els.main.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  }
  function onLeave() { hoverSec = null; requestRender(['studio']); }
  function onDbl(e) {
    if (!cur.params) return;
    const m = metrics(els.main, cur.params.view);
    cueOrAudition(e, clamp(Number(m.xToTime(pos(els.main, e).x).toFixed(2)), 0, cur.params.length));
  }
  function onWheel(e) {
    if (!cur.params) return;
    e.preventDefault();
    const m = metrics(els.main, cur.params.view);
    const p = pos(els.main, e);
    // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
    // 공용 휠 문법: 휠 = 음고, Shift = 시간, Ctrl/⌘ = 포인터 기준 줌
    editCloud((d) => wheelNavigate(e, d.view, m, p), { history: false });
  }

  const on = (node, ev, fn, o) => { node.addEventListener(ev, fn, o); return () => node.removeEventListener(ev, fn, o); };
  const offs = [
    on(els.main, 'pointerdown', onDown), on(els.main, 'pointermove', onMove), on(els.main, 'pointerup', onUp),
    on(els.main, 'pointercancel', onUp), on(els.main, 'pointerleave', onLeave), on(els.main, 'dblclick', onDbl),
    on(els.main, 'wheel', onWheel, { passive: false }),
    on(els.strip, 'pointerdown', onStripDown), on(els.strip, 'pointermove', onStripMove), on(els.strip, 'pointerup', onStripUp),
    on(els.strip, 'pointercancel', onStripUp), on(els.strip, 'contextmenu', (e) => e.preventDefault()),
  ];
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['studio'])) : null;
  ro?.observe(els.main);
  ro?.observe(els.strip);

  return {
    render(params, ev) {
      cur = { params, ev };
      renderMain(params, ev);
      renderHist(params, ev);
      renderStrip(params);
    },
    destroy() {
      offs.forEach((f) => f());
      ro?.disconnect();
    },
  };
}
