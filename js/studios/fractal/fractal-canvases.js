/**
 * Flexatone — studios/fractal/fractal-canvases.js
 * Fractal Studio UI tier: main time × pitch canvas and the zoom lens.
 * 프랙탈 스튜디오 UI: 메인 시간 × 음고 캔버스와 줌 렌즈.
 *
 * Layer note / 계층 메모: lives in the studio folder but is a UI-tier file (imported only by
 * fractal-panels.js). It reads the cached bake; only the zoom lens re-evaluates a curve, and only
 * when its range changes (display only — never used for audio).
 * UI 계층 파일: 캐시된 베이킹을 읽음. 렌즈만 구간이 바뀔 때 곡선을 다시 계산(표시 전용).
 *
 * Main: piano-roll grid, every baked voice drawn with per-pixel min/max (keeps fractal detail),
 * level colours, L-system branch markers, FIF interpolation points (draggable), lens range,
 * cue & playhead. The static layer is cached in an offscreen canvas keyed by the bake signature.
 * Interaction: drag = lens range · FIF point drag · double-click = cue.
 * Lens: auto-fitted pitch range, wheel / Z / X = log zoom ×2, drag = pan.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { CURVE_MODES, sampleCurveLevels, quantizeMidi, normalizeFractalParams } from './fractal-engine.js';
import { getFractalParams, getFractalBake, editFractal } from '../fractal-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, zoomViewTime, zoomViewPitch } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';

const PAD = { left: 46, right: 12, top: 12, bottom: 22 };
const BLACK = new Set([1, 3, 6, 8, 10]);


/** Coordinate system for a time / pitch window. / 시간·음고 좌표계 */
function metrics(canvas, view) {
  const { dpr, w, h } = sizeCanvas(canvas);
  const m = { dpr, w, h, plotW: w - PAD.left - PAD.right, plotH: h - PAD.top - PAD.bottom, view };
  const tSpan = Math.max(1e-6, view.tMax - view.tMin);
  const mSpan = Math.max(1e-6, view.midiMax - view.midiMin);
  m.timeToX = (sec) => PAD.left + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - PAD.left) / m.plotW) * tSpan;
  m.midiToY = (midi) => PAD.top + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - PAD.top) / m.plotH) * mSpan;
  m.inPlot = (p) => p.x >= PAD.left && p.x <= PAD.left + m.plotW && p.y >= PAD.top && p.y <= PAD.top + m.plotH;
  return m;
}

function mainView(params, bake) {
  let lo = params.lo;
  let hi = params.hi;
  for (const v of bake.voices) { lo = Math.min(lo, v.minMidi); hi = Math.max(hi, v.maxMidi); }
  return { tMin: 0, tMax: Math.max(1, bake.endSec) * 1.01, midiMin: Math.max(0, lo - 2), midiMax: Math.min(127, hi + 2) };
}

function drawPianoGrid(ctx, m, fine) {
  const { view } = m;
  const step = view.midiMax - view.midiMin > 60 ? 12 : 1;
  for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
    const pc = ((midi % 12) + 12) % 12;
    if (step === 1 || fine) {
      const yTop = m.midiToY(midi + 0.5);
      const yBot = m.midiToY(midi - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(PAD.left, yTop, m.plotW, Math.max(1, yBot - yTop));
    }
    if (pc === 0 || step === 1) {
      ctx.strokeStyle = pc === 0 ? 'rgba(56, 189, 248, 0.28)' : 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = pc === 0 ? 1 : 0.6;
      ctx.beginPath();
      ctx.moveTo(PAD.left, m.midiToY(midi));
      ctx.lineTo(PAD.left + m.plotW, m.midiToY(midi));
      ctx.stroke();
    }
  }
}

function timeStep(view) {
  const raw = (view.tMax - view.tMin) / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
}

/** Vertical time grid (inside the plot clip). / 시간 격자 */
function drawTimeGrid(ctx, m) {
  const { view } = m;
  const stepT = timeStep(view);
  ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
  ctx.lineWidth = 0.6;
  for (let s = Math.ceil(view.tMin / stepT) * stepT; s <= view.tMax + 1e-9; s += stepT) {
    const x = m.timeToX(s);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + m.plotH);
    ctx.stroke();
  }
}

/** Pitch / time labels (outside the plot clip). / 음고·시간 라벨 */
function drawLabels(ctx, m) {
  const { view } = m;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const span = view.midiMax - view.midiMin;
  const stepM = span > 48 ? 12 : span > 20 ? 6 : span > 8 ? 2 : span > 3 ? 1 : span > 1 ? 0.25 : 0.05;
  for (let midi = Math.ceil(view.midiMin / stepM) * stepM; midi <= view.midiMax + 1e-9; midi += stepM) {
    const y = m.midiToY(midi);
    ctx.fillText(stepM >= 1 ? midiToNoteName(Math.round(midi)) : midi.toFixed(2), PAD.left - 4, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const stepT = timeStep(view);
  const digits = stepT >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(stepT) - 1e-9));
  for (let s = Math.ceil(view.tMin / stepT) * stepT; s <= view.tMax + 1e-9; s += stepT) ctx.fillText(`${s.toFixed(digits)}s`, m.timeToX(s), PAD.top + m.plotH + 4);
}

/** Polyline of a sampled curve with per-column min/max (detail survives at any zoom). */
function strokeSamples(ctx, m, get, count, tAt) {
  const x0 = m.timeToX(tAt(0));
  const x1 = m.timeToX(tAt(count - 1));
  const cols = Math.max(1, Math.ceil(Math.abs(x1 - x0)));
  ctx.beginPath();
  if (count <= cols * 2) {
    for (let i = 0; i < count; i++) {
      const x = m.timeToX(tAt(i));
      const y = m.midiToY(get(i));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    let first = true;
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((c * (count - 1)) / cols);
      const i1 = Math.max(i0, Math.floor(((c + 1) * (count - 1)) / cols));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = i0; i <= i1; i++) { const v = get(i); if (v < mn) mn = v; if (v > mx) mx = v; }
      const x = x0 + c;
      if (first) { ctx.moveTo(x, m.midiToY(get(i0))); first = false; }
      ctx.lineTo(x, m.midiToY(mx));
      ctx.lineTo(x, m.midiToY(mn));
    }
  }
  ctx.stroke();
}

/**
 * Create the canvases. `els` = { main, lens, hud: { time, note, hz }, lensInfo }.
 * @returns {{ render: (opts?) => void, destroy: () => void, resetLens: () => void }}
 */
export function createFractalCanvases(els, { requestRender }) {
  const mainCtx = els.main.getContext('2d');
  const lensCtx = els.lens.getContext('2d');
  const staticMain = document.createElement('canvas');
  const staticLens = document.createElement('canvas');
  let staticKey = '';
  let lensKey = '';
  let lens = null; // { a, b } seconds
  // Zoom / scroll of the main canvas (shared view-nav). UI-local like the lens: null = the fitted view.
  // 메인 캔버스 줌·스크롤 (공용 view-nav). 렌즈처럼 UI 지역 상태이며 null = 전체 맞춤
  let userView = null;
  const viewLimits = (full) => ({ tHi: full.tMax, maxTimeSpan: full.tMax, minTimeSpan: 0.02 });
  const curView = (params, bake) => {
    const full = mainView(params, bake);
    if (userView && (userView.tMax > full.tMax + 1e-6 || userView.tMax - userView.tMin < 0.01)) userView = null;
    return userView || full;
  };
  let lensSig = '';
  let drag = null;
  let hover = null;

  const pos = (canvas, e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.clientHeight };
  };

  function ensureLens(bake) {
    const end = Math.max(0.5, bake.endSec);
    if (!lens || lensSig !== bake.mode) {
      lens = { a: end * 0.25, b: end * 0.25 + end / 8 };
      lensSig = bake.mode;
    }
    const w = clamp(lens.b - lens.a, 0.002, end);
    lens.a = clamp(lens.a, 0, Math.max(0, end - w));
    lens.b = lens.a + w;
    return lens;
  }

  // ---------------------------------------------------------------- main
  function fifHandles(params, m) {
    if (params.mode !== 'fif') return [];
    return params.fif.points.map((q, i) => ({ i, px: m.timeToX(q.x * params.length), py: m.midiToY(params.lo + q.y * (params.hi - params.lo)) }));
  }

  function drawStaticMain(params, bake, m) {
    staticMain.width = els.main.width;
    staticMain.height = els.main.height;
    const ctx = staticMain.getContext('2d');
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    drawPianoGrid(ctx, m, false);
    // pitch range band / 음역 띠
    ctx.fillStyle = 'rgba(167, 139, 250, 0.05)';
    ctx.fillRect(PAD.left, m.midiToY(params.hi), m.plotW, m.midiToY(params.lo) - m.midiToY(params.hi));
    drawTimeGrid(ctx, m);
    ctx.lineJoin = 'round';
    bake.voices.forEach((v, idx) => {
      ctx.strokeStyle = v.color;
      ctx.globalAlpha = bake.voices.length > 1 ? 0.88 : 1;
      ctx.lineWidth = bake.voices.length > 12 ? 1.1 : idx === bake.voices.length - 1 ? 1.6 : 1.3;
      strokeSamples(ctx, m, (i) => v.midi[i], v.midi.length, (i) => v.startSec + i / v.rate);
    });
    ctx.globalAlpha = 1;
    if (params.mode === 'lsystem') {
      ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
      for (const b of bake.branchPoints) {
        const x = m.timeToX(b.t);
        const y = m.midiToY(b.m);
        ctx.beginPath();
        ctx.moveTo(x, y - 3.5);
        ctx.lineTo(x + 3.5, y);
        ctx.lineTo(x, y + 3.5);
        ctx.lineTo(x - 3.5, y);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (params.mode === 'fif') {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      fifHandles(params, m).forEach((h, i) => (i ? ctx.lineTo(h.px, h.py) : ctx.moveTo(h.px, h.py)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
    drawLabels(ctx, m);
  }

  function renderMain(params, bake) {
    const view = curView(params, bake);
    const m = metrics(els.main, view);
    const key = [bake.sig, els.main.width, els.main.height, view.midiMin, view.midiMax, view.tMin, view.tMax].join('|');
    if (key !== staticKey) { drawStaticMain(params, bake, m); staticKey = key; }
    const ctx = mainCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticMain, 0, 0);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    const ln = ensureLens(bake);
    const la = m.timeToX(ln.a);
    const lb = m.timeToX(ln.b);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
    ctx.fillRect(la, PAD.top, Math.max(1, lb - la), m.plotH);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(la, PAD.top + 0.5, Math.max(1, lb - la), m.plotH - 1);
    for (const h of fifHandles(params, m)) {
      const active = (drag?.type === 'fif' && drag.i === h.i) || (hover && Math.hypot(hover.x - h.px, hover.y - h.py) < 9);
      ctx.fillStyle = active ? '#f0abfc' : '#e879f9';
      ctx.strokeStyle = '#020617';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(h.px, h.py, active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    const tr = appState.transport;
    drawCueLine(ctx, m.timeToX(tr.cueSec), PAD.top, PAD.top + m.plotH);
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), PAD.top, PAD.top + m.plotH);
    ctx.restore();
    if (hover && m.inPlot(hover) && els.hud) {
      const sec = m.xToTime(hover.x);
      const midi = m.yToMidi(hover.y);
      els.hud.time.textContent = `${sec.toFixed(2)}s`;
      els.hud.note.textContent = `${midiToNoteName(Math.round(midi))} ${midi.toFixed(2)}`;
      els.hud.hz.textContent = `${midiToFreq(midi).toFixed(1)} Hz`;
    }
    return m;
  }

  // ---------------------------------------------------------------- lens
  /** Lens traces: baked voices cropped, plus the finest curve re-evaluated at lens resolution. */
  function lensTraces(params, bake, ln, cols) {
    const traces = [];
    for (const v of bake.voices) {
      const i0 = Math.max(0, Math.floor((ln.a - v.startSec) * v.rate));
      const i1 = Math.min(v.midi.length - 1, Math.ceil((ln.b - v.startSec) * v.rate));
      if (i1 - i0 < 1) continue;
      traces.push({ color: v.color, start: v.startSec + i0 / v.rate, step: 1 / v.rate, data: v.midi.subarray(i0, i1 + 1), width: 1.1, alpha: 0.55 });
    }
    if (CURVE_MODES.includes(params.mode) && bake.info.norm) {
      const p = normalizeFractalParams(params);
      const v = bake.voices[bake.voices.length - 1];
      const x0 = clamp((ln.a - v.startSec) / p.length, 0, 1);
      const x1 = clamp((ln.b - v.startSec) / p.length, 0, 1);
      if (x1 - x0 > 1e-7) {
        const n = Math.max(64, Math.min(1600, Math.round(cols * 2)));
        const { arrays } = sampleCurveLevels(p, [v.level], n, x0, x1);
        const { lo, hi } = bake.info.norm;
        const data = new Float32Array(n);
        for (let i = 0; i < n; i++) data[i] = clamp(quantizeMidi(p.lo + ((arrays[0][i] - lo) / (hi - lo)) * (p.hi - p.lo), p.quantize, p.scale, p.scaleRoot), 0, 127);
        traces.push({ color: '#f0abfc', start: v.startSec + x0 * p.length, step: ((x1 - x0) * p.length) / (n - 1), data, width: 1.6, alpha: 1, hiRes: true });
      }
    }
    return traces;
  }

  function renderLens(params, bake) {
    const ln = ensureLens(bake);
    const { w } = sizeCanvas(els.lens);
    const key = [bake.sig, ln.a.toFixed(6), ln.b.toFixed(6), els.lens.width, els.lens.height].join('|');
    let m;
    if (key !== lensKey) {
      const traces = lensTraces(params, bake, ln, w - PAD.left - PAD.right);
      let mn = Infinity;
      let mx = -Infinity;
      for (const tr of traces) for (const v of tr.data) { if (v < mn) mn = v; if (v > mx) mx = v; }
      if (!Number.isFinite(mn)) { mn = params.lo; mx = params.hi; }
      const pad = Math.max(0.05, (mx - mn) * 0.08);
      m = metrics(els.lens, { tMin: ln.a, tMax: ln.b, midiMin: mn - pad, midiMax: mx + pad });
      staticLens.width = els.lens.width;
      staticLens.height = els.lens.height;
      const ctx = staticLens.getContext('2d');
      ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, m.w, m.h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
      ctx.clip();
      if (mx - mn < 30) drawPianoGrid(ctx, m, true);
      drawTimeGrid(ctx, m);
      ctx.lineJoin = 'round';
      for (const tr of traces) {
        ctx.strokeStyle = tr.color;
        ctx.globalAlpha = tr.alpha;
        ctx.lineWidth = tr.width;
        strokeSamples(ctx, m, (i) => tr.data[i], tr.data.length, (i) => tr.start + i * tr.step);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      drawLabels(ctx, m);
      lensKey = key;
      els.lens._m = m;
      const zoom = Math.max(1, bake.endSec / Math.max(1e-9, ln.b - ln.a));
      if (els.lensInfo) els.lensInfo.textContent = t('fractal.lensInfo', ln.a.toFixed(3), ln.b.toFixed(3), zoom >= 100 ? zoom.toFixed(0) : zoom.toFixed(1));
    }
    m = els.lens._m || metrics(els.lens, { tMin: ln.a, tMax: ln.b, midiMin: params.lo, midiMax: params.hi });
    const ctx = lensCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticLens, 0, 0);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    const tr = appState.transport;
    if (tr.playing && tr.playheadSec >= ln.a && tr.playheadSec <= ln.b) {
      drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), PAD.top, PAD.top + m.plotH);
    }
  }

  /** Log zoom ×2 about `centerSec` (default: lens centre). / 중심 기준 ×2 로그 줌 */
  function zoomLens(factor, centerSec = null) {
    const bake = getFractalBake();
    const ln = ensureLens(bake);
    const c = centerSec ?? 0.5 * (ln.a + ln.b);
    const w = clamp((ln.b - ln.a) * factor, 1e-4, Math.max(0.5, bake.endSec));
    const frac = (c - ln.a) / Math.max(1e-12, ln.b - ln.a);
    lens = { a: c - frac * w, b: c - frac * w + w };
    requestRender(['fractal']);
  }

  // ---------------------------------------------------------------- pointer
  const onMainDown = (e) => {
    if (e.button !== 0) return;
    const params = getFractalParams();
    const bake = getFractalBake(params);
    const m = metrics(els.main, curView(params, bake));
    const p = pos(els.main, e);
    try { els.main.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    const hit = fifHandles(params, m).find((h) => Math.hypot(p.x - h.px, p.y - h.py) < 9);
    if (hit) { drag = { type: 'fif', i: hit.i, m }; return; }
    if (!m.inPlot(p)) return;
    drag = { type: 'lens', t0: m.xToTime(p.x), m };
  };
  const onMainMove = (e) => {
    const p = pos(els.main, e);
    hover = p;
    if (!drag) { requestRender(['fractal']); return; }
    const m = drag.m;
    if (drag.type === 'fif') {
      const i = drag.i;
      const sec = m.xToTime(p.x);
      const midi = m.yToMidi(p.y);
      editFractal((d) => {
        const pts = d.fif.points;
        const q = pts[i];
        if (!q) return;
        if (i > 0 && i < pts.length - 1) q.x = Number(clamp(sec / d.length, pts[i - 1].x + 0.01, pts[i + 1].x - 0.01).toFixed(4));
        q.y = Number(clamp((midi - d.lo) / (d.hi - d.lo), -0.25, 1.25).toFixed(4));
      }, { coalesceKey: 'fractal-fif-drag' });
    } else if (drag.type === 'lens') {
      const t1 = m.xToTime(p.x);
      if (Math.abs(m.timeToX(t1) - m.timeToX(drag.t0)) > 3) {
        lens = { a: Math.max(0, Math.min(drag.t0, t1)), b: Math.max(drag.t0, t1) };
        requestRender(['fractal']);
      }
    }
  };
  const onMainUp = (e) => {
    if (drag?.type === 'fif') endHistoryGesture();
    drag = null;
    try { els.main.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['fractal']);
  };
  const onMainDbl = (e) => {
    const params = getFractalParams();
    const m = metrics(els.main, curView(params, getFractalBake(params)));
    cueOrAudition(e, Math.max(0, Number(m.xToTime(pos(els.main, e).x).toFixed(2))));
  };
  const onLeave = () => { hover = null; requestRender(['fractal']); };

  const onLensDown = (e) => {
    if (e.button !== 0 || !lens) return;
    try { els.lens.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    drag = { type: 'pan', x: pos(els.lens, e).x, lens: { ...lens }, m: els.lens._m };
  };
  const onLensMove = (e) => {
    if (drag?.type !== 'pan' || !drag.m) return;
    const dx = pos(els.lens, e).x - drag.x;
    const dt = (dx / drag.m.plotW) * (drag.lens.b - drag.lens.a);
    lens = { a: drag.lens.a - dt, b: drag.lens.b - dt };
    requestRender(['fractal']);
  };
  const onLensUp = (e) => {
    if (drag?.type === 'pan') drag = null;
    try { els.lens.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  };
  const onLensWheel = (e) => {
    e.preventDefault();
    const m = els.lens._m;
    const c = m ? m.xToTime(pos(els.lens, e).x) : null;
    zoomLens(e.deltaY > 0 ? 2 : 0.5, c);
  };
  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); zoomLens(0.5); }
    else if (e.key === 'x' || e.key === 'X') { e.preventDefault(); zoomLens(2); }
  };

  els.main.addEventListener('pointerdown', onMainDown);
  els.main.addEventListener('pointermove', onMainMove);
  els.main.addEventListener('pointerup', onMainUp);
  els.main.addEventListener('pointercancel', onMainUp);
  els.main.addEventListener('pointerleave', onLeave);
  els.main.addEventListener('dblclick', onMainDbl);
  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // 공용 휠 문법: 휠 = 음고, Shift = 시간, Ctrl/⌘ = 포인터 기준 줌
  els.main.addEventListener('wheel', (e) => {
    e.preventDefault();
    const params = getFractalParams();
    const bake = getFractalBake(params);
    const nv = { ...curView(params, bake) };
    wheelNavigate(e, nv, metrics(els.main, nv), pos(els.main, e), viewLimits(mainView(params, bake)));
    userView = nv;
    requestRender(['fractal']);
  }, { passive: false });
  els.lens.addEventListener('pointerdown', onLensDown);
  els.lens.addEventListener('pointermove', onLensMove);
  els.lens.addEventListener('pointerup', onLensUp);
  els.lens.addEventListener('pointercancel', onLensUp);
  els.lens.addEventListener('wheel', onLensWheel, { passive: false });
  document.addEventListener('keydown', onKey);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['fractal'])) : null;
  ro?.observe(els.main);
  ro?.observe(els.lens);

  return {
    render() {
      const params = getFractalParams();
      const bake = getFractalBake(params);
      renderMain(params, bake);
      renderLens(params, bake);
    },
    resetLens() { lens = null; requestRender(['fractal']); },
    /** Toolbar zoom of the main canvas: axis 'pitch' | 'time' | 'both'. / 메인 캔버스 툴바 줌 */
    zoomMain(axis, f) {
      const params = getFractalParams();
      const bake = getFractalBake(params);
      const nv = { ...curView(params, bake) };
      if (axis !== 'pitch') zoomViewTime(nv, f, null, viewLimits(mainView(params, bake)));
      if (axis !== 'time') zoomViewPitch(nv, f);
      userView = nv;
      requestRender(['fractal']);
    },
    /** Fit All: the whole piece again (the lens keeps its range). / 전체 맞춤 (렌즈 구간은 유지) */
    fitMain() { userView = null; requestRender(['fractal']); },
    zoomLens,
    getLens: () => (lens ? { ...lens } : null),
    destroy() {
      ro?.disconnect();
      document.removeEventListener('keydown', onKey);
    },
  };
}
