/**
 * Flexatone — studios/wave/wave-canvases.js
 * Wave Studio UI tier: one canvas with three regions that share the pitch (vertical) axis.
 * 웨이브 스튜디오 UI: 세로 음고 축을 공유하는 세 영역을 가진 캔버스.
 *
 * Layer note / 계층 메모: lives in the studio folder but is a UI-tier file — only wave-panels.js
 * (mounted through ui/workspaces.js) imports it. It only reads baked arrays (display, never audio).
 * UI 계층 파일: 베이킹된 배열을 읽기만 함.
 *
 *   heat map   time × pitch (piano-roll coordinates), colour = u (±) / |u| / energy. The baked
 *              matrix is painted once into an offscreen canvas per bake + colour mode; a frame
 *              only blits it and draws the cue, the playhead and the overlays.
 *   profile    the string u(x) at the playhead (or under the pointer / at the cue when stopped)
 *   medium     the medium curve c(x): drag points, double-click to add, Shift+click to remove
 * Editing on the heat map: drag on the t = 0 line = new pulse, ● = move, ▲ = width, amber ring =
 * driver (time + pitch), Shift+click = delete, drag empty space = pan, double-click = cue,
 * wheel = time zoom (Shift = pitch zoom).
 * 히트맵 편집: t = 0 선 드래그 = 새 펄스, ● 이동, ▲ 폭, 주황 고리 = 구동, Shift+클릭 삭제, 더블클릭 큐, 휠 줌.
 */

import { clamp, lerp } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { sourceValue, waveFrameAt, createWaveInit, WAVE_MAX_INIT } from './wave-engine.js';
import { getWaveParams, editWave, getWaveBake, getWaveRidges } from '../wave-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';

/** View limits of the Wave canvas (the medium may reach beyond the MIDI range). / 웨이브 캔버스 뷰 한계 */
export const WAVE_VIEW_LIMITS = Object.freeze({ pLo: -12, pHi: 150, minPitchSpan: 4, maxPitchSpan: 150 });

const PAD = { left: 52, right: 10, top: 18, bottom: 24 };
const GAP = 10;
const BLACK = new Set([1, 3, 6, 8, 10]);
const BG = [2, 6, 23];


/** Coordinate system: heat map plot, profile strip, medium strip. / 좌표계 */
export function waveMetrics(canvas, view) {
  const { dpr, w, h } = sizeCanvas(canvas);
  const profW = clamp(Math.round(w * 0.11), 54, 96);
  const medW = clamp(Math.round(w * 0.09), 46, 76);
  const m = { dpr, w, h, view, plotX: PAD.left, plotY: PAD.top, plotH: h - PAD.top - PAD.bottom, profW, medW };
  m.plotW = Math.max(40, w - PAD.left - PAD.right - profW - medW - 2 * GAP);
  m.profX = m.plotX + m.plotW + GAP;
  m.medX = m.profX + profW + GAP;
  const tSpan = Math.max(0.05, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  m.timeToX = (sec) => m.plotX + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - m.plotX) / m.plotW) * tSpan;
  m.midiToY = (midi) => m.plotY + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - m.plotY) / m.plotH) * mSpan;
  m.inPlot = (p) => p.x >= m.plotX && p.x <= m.plotX + m.plotW && p.y >= m.plotY && p.y <= m.plotY + m.plotH;
  m.inMedium = (p) => p.x >= m.medX - 6 && p.x <= m.medX + medW + 6 && p.y >= m.plotY - 4 && p.y <= m.plotY + m.plotH + 4;
  return m;
}

// --------------------------------------------------------------------------
// Colour maps + offscreen heat map / 컬러맵과 오프스크린 히트맵
// --------------------------------------------------------------------------

function ramp(stops) {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = Math.pow(i / 255, 0.6); // lift weak values / 약한 값을 끌어올림
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const a = stops[k];
    const b = stops[k + 1];
    const u = clamp((x - a[0]) / Math.max(1e-9, b[0] - a[0]), 0, 1);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = lerp(a[1][c], b[1][c], u);
  }
  return lut;
}
const LUT_POS = ramp([[0, BG], [0.55, [194, 65, 12]], [1, [254, 226, 180]]]);
const LUT_NEG = ramp([[0, BG], [0.55, [29, 78, 216]], [1, [186, 230, 253]]]);
const LUT_ABS = ramp([[0, BG], [0.35, [88, 28, 135]], [0.7, [219, 39, 119]], [1, [253, 224, 71]]]);

const heatCache = new WeakMap(); // bake → { color, canvas }
const MAX_COLS = 1600;

/** Paint the baked matrix once (per bake + colour mode). / 베이킹 행렬을 한 번만 그림 */
function heatmapFor(bake, color) {
  const hit = heatCache.get(bake);
  if (hit && hit.color === color) return hit.canvas;
  const cols = Math.min(bake.frames, MAX_COLS);
  const N = bake.N;
  const cv = hit?.canvas || document.createElement('canvas');
  cv.width = cols;
  cv.height = N;
  const g = cv.getContext('2d');
  const img = g.createImageData(cols, N);
  const d = img.data;
  const signed = color === 'signed';
  for (let x = 0; x < cols; x++) {
    const fA = Math.floor((x * bake.frames) / cols);
    const fB = Math.max(fA + 1, Math.floor(((x + 1) * bake.frames) / cols));
    for (let i = 0; i < N; i++) {
      let v = 0;
      for (let f = fA; f < fB; f++) {
        const j = f * N + i;
        const s = signed ? bake.U[j] / bake.uMax : sourceValue(bake, color, j);
        if (Math.abs(s) > Math.abs(v)) v = s;
      }
      const lut = signed ? (v < 0 ? LUT_NEG : LUT_POS) : LUT_ABS;
      const q = Math.min(255, Math.round(Math.abs(v) * 255)) * 3;
      const o = ((N - 1 - i) * cols + x) * 4;
      d[o] = lut[q];
      d[o + 1] = lut[q + 1];
      d[o + 2] = lut[q + 2];
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  heatCache.set(bake, { color, canvas: cv });
  return cv;
}

const hasPosition = (it) => it.kind !== 'standing' && it.kind !== 'noise';

/**
 * Create the Wave canvas inside `els` = { main, hud: { time, note, hz, val } }.
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function createWaveCanvases(els, { requestRender, showToast }) {
  const ctx = els.main.getContext('2d');
  let drag = null;
  let hover = null;

  const pos = (e) => {
    const r = els.main.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * els.main.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * els.main.clientHeight };
  };
  const span = (p) => p.pHi - p.pLo;
  const initMidi = (p, it) => p.pLo + it.x * span(p);
  /** Horizontal axis of the medium strip: 0 … cAxis (st/s). / 매질 스트립의 가로축 */
  const cAxis = (p) => p.speed * Math.max(p.cLo, p.cHi) * 1.08;

  function drawBackdrop(m, p) {
    const view = p.view;
    for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const yTop = m.midiToY(midi + 0.5);
      const yBot = m.midiToY(midi - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(m.plotX, yTop, m.plotW, Math.max(1, yBot - yTop));
    }
  }

  function drawGrid(m, p) {
    const view = p.view;
    ctx.lineWidth = 1;
    for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = Math.round(m.midiToY(midi)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.beginPath();
      ctx.moveTo(m.plotX, y);
      ctx.lineTo(m.plotX + m.plotW, y);
      ctx.stroke();
    }
    const step = timeStep(view.tMax - view.tMin, m.plotW);
    for (let s = Math.ceil(view.tMin / step) * step; s <= view.tMax; s += step) {
      const x = Math.round(m.timeToX(s)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.beginPath();
      ctx.moveTo(x, m.plotY);
      ctx.lineTo(x, m.plotY + m.plotH);
      ctx.stroke();
    }
  }

  /** Tick spacing in seconds so that labels are at least ~46 px apart. / 라벨 간격 ≥ 46px */
  const timeStep = (spanSec, plotW = 600) => {
    const want = (46 * spanSec) / Math.max(60, plotW);
    for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60]) if (s >= want) return s;
    return 120;
  };

  function drawRidges(m, p, bake) {
    const { tracks } = getWaveRidges(p);
    const ridgeMode = p.sonify.mode === 'ridge';
    ctx.save();
    ctx.lineWidth = ridgeMode ? 1.8 : 1.1;
    ctx.strokeStyle = ridgeMode ? 'rgba(248, 250, 252, 0.92)' : 'rgba(226, 232, 240, 0.55)';
    if (!ridgeMode) ctx.setLineDash([4, 3]);
    for (const tr of tracks) {
      const n = tr.pitch.length;
      const step = Math.max(1, Math.floor(n / 700));
      ctx.beginPath();
      for (let j = 0; j < n; j += step) {
        const x = m.timeToX((tr.f0 + j) / bake.rate);
        const y = m.midiToY(tr.pitch[j]);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(m.timeToX((tr.f0 + n - 1) / bake.rate), m.midiToY(tr.pitch[n - 1]));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawEditors(m, p) {
    const x0 = m.timeToX(0);
    // t = 0 line: the string at rest / t = 0 선
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, m.midiToY(p.pHi));
    ctx.lineTo(x0, m.midiToY(p.pLo));
    ctx.stroke();
    ctx.setLineDash([]);
    let labelRow = 0;
    p.init.forEach((it, idx) => {
      const col = it.amp < 0 ? '#fb7185' : '#34d399';
      const on = drag && drag.idx === idx && (drag.type === 'init-move' || drag.type === 'init-width');
      if (!hasPosition(it)) {
        ctx.fillStyle = col;
        ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(it.kind === 'standing' ? `n=${it.mode}` : '~', x0 + 6, m.midiToY(p.pHi) + 3 + 12 * labelRow++);
        return;
      }
      const y = m.midiToY(initMidi(p, it));
      const kinkSg = it.kind === 'kink' && p.eq === 'sg';
      const yW = m.midiToY(initMidi(p, it) + it.width);
      ctx.strokeStyle = col;
      ctx.lineWidth = on ? 2.4 : 1.6;
      if (!kinkSg) {
        // width whisker ± width with a ▲ handle on top / 폭 표시와 ▲ 핸들
        ctx.beginPath();
        ctx.moveTo(x0, yW);
        ctx.lineTo(x0, 2 * y - yW);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x0, yW - 6);
        ctx.lineTo(x0 - 5, yW + 2);
        ctx.lineTo(x0 + 5, yW + 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      if (it.kind === 'kink') { ctx.moveTo(x0, y - 6); ctx.lineTo(x0 + 6, y); ctx.lineTo(x0, y + 6); ctx.lineTo(x0 - 6, y); ctx.closePath(); }
      else ctx.arc(x0, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (it.velocity !== 0 && p.eq !== 'gs') {
        // launch direction arrow / 발사 방향 화살표
        const dir = it.velocity > 0 ? -1 : 1;
        ctx.beginPath();
        ctx.moveTo(x0 + 9, y);
        ctx.lineTo(x0 + 9, y + dir * 11);
        ctx.lineTo(x0 + 6, y + dir * 7);
        ctx.moveTo(x0 + 9, y + dir * 11);
        ctx.lineTo(x0 + 12, y + dir * 7);
        ctx.stroke();
      }
    });
    p.drivers.forEach((d, idx) => {
      const x = m.timeToX(d.t0);
      const y = m.midiToY(p.pLo + d.x * span(p));
      const xEnd = m.timeToX(d.dur > 0 ? Math.min(p.length, d.t0 + d.dur) : p.length);
      const on = drag && drag.type === 'driver' && drag.idx === idx;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = on ? 2.4 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(xEnd, y);
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#f59e0b';
      ctx.fill();
    });
  }

  function showTime(p, m) {
    const tr = appState.transport;
    if (tr.playing && tr.playheadSec >= 0) return tr.playheadSec;
    if (hover && m.inPlot(hover) && !drag) return clamp(m.xToTime(hover.x), 0, p.length);
    return clamp(tr.cueSec || 0, 0, p.length);
  }

  function drawProfile(m, p, bake) {
    const x0 = m.profX;
    const w = m.profW;
    const cx = x0 + w / 2;
    const half = w / 2 - 4;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(x0, m.plotY, w, m.plotH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, m.plotY, w, m.plotH);
    ctx.clip();
    const f = waveFrameAt(bake, showTime(p, m));
    const row = f * bake.N;
    // audible level (sonification source) as a mirrored fill / 들리는 레벨을 대칭 채움으로
    ctx.fillStyle = 'rgba(167, 139, 250, 0.22)';
    ctx.beginPath();
    for (let i = 0; i < bake.N; i++) {
      const s = sourceValue(bake, p.sonify.source, row + i);
      const y = m.midiToY(bake.pLo + i * bake.dp);
      if (i === 0) ctx.moveTo(cx + s * half, y);
      else ctx.lineTo(cx + s * half, y);
    }
    for (let i = bake.N - 1; i >= 0; i--) ctx.lineTo(cx - sourceValue(bake, p.sonify.source, row + i) * half, m.midiToY(bake.pLo + i * bake.dp));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, m.midiToY(p.pHi));
    ctx.lineTo(cx, m.midiToY(p.pLo));
    ctx.stroke();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < bake.N; i++) {
      const x = cx + (bake.U[row + i] / bake.uMax) * half;
      const y = m.midiToY(bake.pLo + i * bake.dp);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(x0 + 0.5, m.plotY + 0.5, w - 1, m.plotH - 1);
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('u(x)', cx, m.plotY - 4);
    ctx.fillStyle = '#94a3b8';
    ctx.textBaseline = 'top';
    ctx.fillText(`${(f / bake.rate).toFixed(2)}s`, cx, m.plotY + m.plotH + 6);
  }

  function drawMedium(m, p, bake) {
    const x0 = m.medX;
    const w = m.medW;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fillRect(x0, m.plotY, w, m.plotH);
    ctx.fillStyle = '#fcd34d';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('c(x)', x0 + w / 2, m.plotY - 4);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(x0 + 0.5, m.plotY + 0.5, w - 1, m.plotH - 1);
    if (p.eq === 'gs') {
      ctx.fillStyle = '#475569';
      ctx.textBaseline = 'middle';
      ctx.fillText('—', x0 + w / 2, m.plotY + m.plotH / 2);
      return;
    }
    const axis = cAxis(p);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, m.plotY, w, m.plotH);
    ctx.clip();
    // reference: multiplier 1 / 기준선: 배율 1
    const xRef = x0 + (p.speed / axis) * w;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(xRef, m.midiToY(p.pHi));
    ctx.lineTo(xRef, m.midiToY(p.pLo));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < bake.N; i++) {
      const x = x0 + (bake.c[i] / axis) * w;
      const y = m.midiToY(bake.pLo + i * bake.dp);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    p.c.customPoints.forEach((pt, idx) => {
      const h = mediumHandle(m, p, pt);
      ctx.fillStyle = drag && drag.type === 'medium' && drag.idx === idx ? '#fbbf24' : '#0f172a';
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(h.x, h.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < bake.N; i++) { lo = Math.min(lo, bake.c[i]); hi = Math.max(hi, bake.c[i]); }
    ctx.fillStyle = '#94a3b8';
    ctx.textBaseline = 'top';
    ctx.fillText(hi - lo < 0.05 ? `${lo.toFixed(1)}` : `${lo.toFixed(1)}–${hi.toFixed(1)}`, x0 + w / 2, m.plotY + m.plotH + 6);
  }

  function mediumHandle(m, p, pt) {
    const mult = lerp(p.cLo, p.cHi, pt.y);
    return { x: clamp(m.medX + ((p.speed * mult) / cAxis(p)) * m.medW, m.medX + 3, m.medX + m.medW - 3), y: m.midiToY(p.pLo + pt.x * span(p)) };
  }

  function render() {
    const p = getWaveParams();
    const bake = getWaveBake(p); // memoised: simulates only when the physics signature changed / 캐시
    const view = p.view;
    const m = waveMetrics(els.main, view);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    drawBackdrop(m, p);
    const cv = heatmapFor(bake, view.color);
    const hx0 = m.timeToX(0);
    const hx1 = m.timeToX(bake.length);
    const hy0 = m.midiToY(bake.pHi + bake.dp / 2);
    const hy1 = m.midiToY(bake.pLo - bake.dp / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cv, 0, 0, cv.width, cv.height, hx0, hy0, hx1 - hx0, hy1 - hy0);
    if (view.showGrid) drawGrid(m, p);
    if (view.showRidges) drawRidges(m, p, bake);
    drawEditors(m, p);

    const tr = appState.transport;
    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    drawCueLine(ctx, m.timeToX(tr.cueSec), m.plotY, m.plotY + m.plotH);
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), m.plotY, m.plotY + m.plotH);
    ctx.restore();

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(m.plotX + 0.5, m.plotY + 0.5, m.plotW - 1, m.plotH - 1);
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const py = m.midiToY(midi);
      if (py < m.plotY + 7 || py > m.plotY + m.plotH - 7) continue;
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
      ctx.fillText(`${Number(s.toFixed(2))}s`, px, m.plotY + m.plotH + 6);
    }
    drawProfile(m, p, bake);
    drawMedium(m, p, bake);

    if (hover && m.inPlot(hover)) {
      const sec = m.xToTime(hover.x);
      const midi = m.yToMidi(hover.y);
      if (els.hud.time) els.hud.time.textContent = `${sec.toFixed(2)}s`;
      if (els.hud.note) els.hud.note.textContent = midiToNoteName(midi);
      if (els.hud.hz) els.hud.hz.textContent = `${midiToFreq(midi).toFixed(1)} Hz`;
      if (els.hud.val) {
        const inside = sec >= 0 && sec <= bake.length && midi >= bake.pLo - bake.dp / 2 && midi <= bake.pHi + bake.dp / 2;
        const bin = clamp(Math.round((midi - bake.pLo) / bake.dp), 0, bake.N - 1);
        els.hud.val.textContent = inside ? bake.U[waveFrameAt(bake, sec) * bake.N + bin].toFixed(3) : '—';
      }
    }
  }

  // ------------------------------------------------------------------ hit tests
  function hitPlot(p, m, pt) {
    const x0 = m.timeToX(0);
    for (let idx = p.drivers.length - 1; idx >= 0; idx--) {
      const d = p.drivers[idx];
      if (Math.hypot(pt.x - m.timeToX(d.t0), pt.y - m.midiToY(p.pLo + d.x * span(p))) < 9) return { type: 'driver', idx };
    }
    for (let idx = p.init.length - 1; idx >= 0; idx--) {
      const it = p.init[idx];
      if (!hasPosition(it)) continue;
      const y = m.midiToY(initMidi(p, it));
      if (!(it.kind === 'kink' && p.eq === 'sg')) {
        const yW = m.midiToY(initMidi(p, it) + it.width);
        if (Math.abs(pt.x - x0) < 8 && Math.abs(pt.y - (yW - 2)) < 7) return { type: 'init-width', idx };
      }
      if (Math.hypot(pt.x - x0, pt.y - y) < 9) return { type: 'init-move', idx };
    }
    const midi = m.yToMidi(pt.y);
    if (Math.abs(pt.x - x0) < 9 && midi >= p.pLo && midi <= p.pHi) return { type: 'init-new', midi };
    return null;
  }

  function hitMedium(p, m, pt) {
    if (p.eq === 'gs') return null;
    let best = null;
    p.c.customPoints.forEach((q, idx) => {
      const h = mediumHandle(m, p, q);
      const d = Math.hypot(pt.x - h.x, pt.y - h.y);
      if (d < 10 && (!best || d < best.d)) best = { type: 'medium', idx, d };
    });
    return best;
  }

  /** Medium-curve value (0…1) for a pointer x. / 포인터 x에 해당하는 곡선 값 */
  function mediumY(p, m, px) {
    const mult = (((px - m.medX) / m.medW) * cAxis(p)) / p.speed;
    return clamp((mult - p.cLo) / Math.max(1e-6, p.cHi - p.cLo), 0, 1);
  }

  const onDown = (e) => {
    if (e.button !== 0) return;
    const p = getWaveParams();
    const m = waveMetrics(els.main, p.view);
    const pt = pos(e);
    try { els.main.setPointerCapture?.(e.pointerId); } catch { /* synthetic / inactive pointer */ }
    if (m.inMedium(pt)) {
      const hit = hitMedium(p, m, pt);
      if (hit && e.shiftKey) {
        if (p.c.customPoints.length > 2 && hit.idx > 0 && hit.idx < p.c.customPoints.length - 1) { editWave((d) => { d.c.customPoints.splice(hit.idx, 1); }); endHistoryGesture(); }
      } else if (hit) drag = hit;
      return;
    }
    if (!m.inPlot(pt)) return;
    const hit = hitPlot(p, m, pt);
    if (hit && e.shiftKey && hit.type !== 'init-new') {
      editWave((d) => { if (hit.type === 'driver') d.drivers.splice(hit.idx, 1); else d.init.splice(hit.idx, 1); });
      endHistoryGesture();
      return;
    }
    if (hit && hit.type === 'init-new') {
      if (p.init.length >= WAVE_MAX_INIT) { showToast?.(t('wave.maxInit', WAVE_MAX_INIT), 'error'); return; }
      drag = { type: 'init-new', midi: hit.midi, y: pt.y };
      return;
    }
    if (hit) { drag = hit; return; }
    drag = { type: 'pan', x: pt.x, y: pt.y, view: { ...p.view } };
  };

  const onMove = (e) => {
    const pt = pos(e);
    hover = pt;
    const p = getWaveParams();
    const m = waveMetrics(els.main, p.view);
    if (!drag) {
      const hit = m.inMedium(pt) ? hitMedium(p, m, pt) : m.inPlot(pt) ? hitPlot(p, m, pt) : null;
      els.main.style.cursor = !hit ? (m.inPlot(pt) ? 'grab' : 'default') : hit.type === 'init-new' ? 'crosshair' : hit.type === 'driver' ? 'move' : hit.type === 'medium' ? 'move' : 'ns-resize';
      requestRender(['wave']);
      return;
    }
    const midi = m.yToMidi(pt.y);
    if (drag.type === 'init-new') {
      if (Math.abs(pt.y - drag.y) < 4) return;
      // the drag distance becomes the width / 드래그 거리가 폭이 됨
      const idx = p.init.length;
      const x = clamp((drag.midi - p.pLo) / span(p), 0, 1);
      editWave((d) => { d.init.push(createWaveInit(d.eq === 'sg' ? 'kink' : 'gauss', { x, width: clamp(Math.abs(midi - drag.midi), 0.25, 24), velocity: d.eq === 'sg' ? 0.4 : 0 })); }, { coalesceKey: 'wave-init-drag' });
      drag = { type: 'init-width', idx };
    } else if (drag.type === 'init-move') {
      const x = clamp((midi - p.pLo) / span(p), 0, 1);
      editWave((d) => { if (d.init[drag.idx]) d.init[drag.idx].x = Number(x.toFixed(4)); }, { coalesceKey: 'wave-init-drag' });
    } else if (drag.type === 'init-width') {
      const it = p.init[drag.idx];
      if (!it) return;
      const w = clamp(Math.abs(midi - initMidi(p, it)), 0.25, 24);
      editWave((d) => { if (d.init[drag.idx]) d.init[drag.idx].width = Number(w.toFixed(3)); }, { coalesceKey: 'wave-init-drag' });
    } else if (drag.type === 'driver') {
      const x = clamp((midi - p.pLo) / span(p), 0, 1);
      const t0 = clamp(m.xToTime(pt.x), 0, p.length);
      editWave((d) => { const q = d.drivers[drag.idx]; if (q) { q.x = Number(x.toFixed(4)); q.t0 = Number(t0.toFixed(3)); } }, { coalesceKey: 'wave-driver-drag' });
    } else if (drag.type === 'medium') {
      const y = mediumY(p, m, pt.x);
      const xn = clamp((midi - p.pLo) / span(p), 0, 1);
      editWave((d) => {
        const pts = d.c.customPoints;
        const q = pts[drag.idx];
        if (!q) return;
        q.y = Number(y.toFixed(4));
        if (drag.idx > 0 && drag.idx < pts.length - 1) q.x = Number(clamp(xn, pts[drag.idx - 1].x + 0.01, pts[drag.idx + 1].x - 0.01).toFixed(4));
      }, { coalesceKey: 'wave-medium-drag' });
    } else {
      const vp = drag.view;
      const tSpan = vp.tMax - vp.tMin;
      const mSpan = vp.midiMax - vp.midiMin;
      const tMin = clamp(vp.tMin - ((pt.x - drag.x) / m.plotW) * tSpan, -0.25 * tSpan, Math.max(0, p.length - 0.25 * tSpan));
      const midiMin = clamp(vp.midiMin + ((pt.y - drag.y) / m.plotH) * mSpan, -12, 140 - mSpan);
      editWave((d) => { Object.assign(d.view, { tMin, tMax: tMin + tSpan, midiMin, midiMax: midiMin + mSpan }); }, { history: false });
    }
  };

  const onUp = (e) => {
    if (drag && drag.type !== 'pan') endHistoryGesture();
    drag = null;
    try { els.main.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['wave']);
  };

  const onDbl = (e) => {
    const p = getWaveParams();
    const m = waveMetrics(els.main, p.view);
    const pt = pos(e);
    if (m.inMedium(pt)) {
      if (p.eq === 'gs' || p.c.customPoints.length >= 12) return;
      const xn = clamp((m.yToMidi(pt.y) - p.pLo) / span(p), 0.01, 0.99);
      const y = mediumY(p, m, pt.x);
      editWave((d) => { d.c.customPoints.push({ x: Number(xn.toFixed(4)), y: Number(y.toFixed(4)), handles: [] }); });
      endHistoryGesture();
      return;
    }
    if (m.inPlot(pt)) cueOrAudition(e, clamp(Number(m.xToTime(pt.x).toFixed(2)), 0, p.length));
  };

  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // 공용 휠 문법: 휠 = 음고, Shift = 시간, Ctrl/⌘ = 포인터 기준 줌
  const onWheel = (e) => {
    e.preventDefault();
    const m = waveMetrics(els.main, getWaveParams().view);
    const pt = pos(e);
    editWave((d) => wheelNavigate(e, d.view, m, pt, WAVE_VIEW_LIMITS), { history: false });
  };

  const onLeave = () => { hover = null; requestRender(['wave']); };

  els.main.addEventListener('pointerdown', onDown);
  els.main.addEventListener('pointermove', onMove);
  els.main.addEventListener('pointerup', onUp);
  els.main.addEventListener('pointercancel', onUp);
  els.main.addEventListener('pointerleave', onLeave);
  els.main.addEventListener('dblclick', onDbl);
  els.main.addEventListener('wheel', onWheel, { passive: false });
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['wave'])) : null;
  ro?.observe(els.main);

  return {
    render,
    destroy() {
      ro?.disconnect();
    },
  };
}
