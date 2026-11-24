/**
 * Flexatone — studios/grid/grid-canvases.js
 * Grid Studio UI tier: the two windows. EDITOR = the painted Cartesian grid (time → right, pitch ↑,
 * every tool works here and only here). RESULT = the same coordinates after the effect stack — what
 * you will hear; read-only, but it shows the playhead, the cue and the cursor cross-hair.
 * 그리드 스튜디오 UI: 두 윈도우. Editor = 칠하는 직교 격자 (모든 도구는 여기서만), Result = 효과 스택 통과 결과
 * (읽기 전용, 재생헤드·큐·커서 십자선은 표시).
 *
 * Layer note / 계층 메모: lives in the studio folder but is a UI-tier file — only grid-panels.js
 * (mounted through ui/workspaces.js) imports it. It reads baked matrices for display, never for audio.
 *
 * One view (doc.view) serves both windows: wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer
 * (ui/view-nav.js), in either window. Double-click sets the cue (Result: anywhere; Editor: on the
 * time ruler, because a double-click on the picture paints). Middle-button drag pans the Editor;
 * any drag pans the Result. Alt is never bound (the help inspector owns it).
 * 뷰 하나(doc.view)를 두 윈도우가 공유. Alt 제스처는 사용하지 않음.
 *
 * Painting: a stroke edits a working copy of the layer raster and commits it (RLE8) to the document
 * every ~70 ms with one coalesce key, so the Result follows while you draw and a whole stroke is one
 * undo step. / 획은 작업 사본에 그리고 ~70 ms마다 한 병합 키로 커밋 → 그리는 동안 Result가 따라오고 획 전체가 실행 취소 1단계.
 */

import { clamp, lerp } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, panViewTime, panViewPitch } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';
import { triggerDownload } from '../../audio/audio-engine.js';
import {
  decodeRaster, encodeRaster, gridShape, activeLayer, audibleLayers, bankItem, selectionCoverage, createGridLayer, GRID_MAX_LAYERS, createStackItem,
} from './grid-engine.js';
import { GridEffectRegistry, hash3, liquifyMesh, LIQUIFY_MAX_OPS } from './grid-effects.js';
import { stampBrush, strokeSegment, mirrorCoverage, compositeStroke, rectCoverage, ellipseCoverage, floodCoverage, gradientValues } from './grid-tools.js';
import { gridMetrics } from './grid-layout.js';
import { getGridParams, editGrid, getGridResult } from '../grid-studio.js';

/** View limits of the Grid windows. / 그리드 윈도우의 뷰 한계 */
export const GRID_VIEW_LIMITS = Object.freeze({ tLo: -2, pLo: 0, pHi: 128, minPitchSpan: 3, maxPitchSpan: 128, minTimeSpan: 0.25 });

const BLACK = new Set([1, 3, 6, 8, 10]);
const BG = [2, 6, 23];
const COMMIT_MS = 70;
const MAX_RESULT_COLS = 1400;
const CHROMA_TINT = { r: [1, 0.28, 0.28], g: [0.3, 1, 0.42], b: [0.32, 0.5, 1] };

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
const LUT = {
  heat: ramp([[0, BG], [0.35, [88, 28, 135]], [0.7, [219, 39, 119]], [1, [253, 224, 71]]]),
  gray: ramp([[0, BG], [1, [248, 250, 252]]]),
};
const hexRgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

/** Tick spacing in seconds so that labels are at least ~46 px apart. / 라벨 간격 ≥ 46px */
const timeStep = (spanSec, plotW = 600) => {
  const want = (46 * spanSec) / Math.max(60, plotW);
  for (const s of [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60]) if (s >= want) return s;
  return 120;
};

/**
 * Create the two windows inside `els` = { editor, result, hud: { time, note, hz, val }, status }.
 * @returns {{ render: () => void, destroy: () => void, deleteSelection: () => boolean, importImage: (file: File) => Promise<void>, screenshot: (kind: string) => void, metrics: () => object }}
 */
export function createGridCanvases(els, { requestRender, showToast }) {
  const ctxE = els.editor.getContext('2d');
  const ctxR = els.result.getContext('2d');
  let hover = null; // { t, midi, src: 'editor' | 'result' }
  let drag = null;
  let stroke = null; // { target, layerId, base, work, cov, last, rev, rows, cols, timer, dirty }
  let lastMetrics = { editor: null, result: null };
  const layerImages = new Map(); // layerId → { key, canvas }
  let resultImage = { key: '', canvas: null };
  let maskImage = { key: '', canvas: null };

  const pos = (cv, e) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * cv.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * cv.clientHeight };
  };
  const cellOf = (p, m, pt) => ({ x: m.xToTime(pt.x) * p.grid.colsPerSec, y: (m.yToMidi(pt.y) - p.grid.pLo) * p.grid.rowsPerSemi + 0.5 });
  const cellToPx = (p, m, x, y) => ({ x: m.timeToX(x / p.grid.colsPerSec), y: m.midiToY(p.grid.pLo + (y - 0.5) / p.grid.rowsPerSemi) });
  const setView = (fn) => editGrid((d) => fn(d.view, d), { history: false });

  // ------------------------------------------------------------------ images
  /** One layer raster as a small canvas (cols × rows, row 0 at the bottom). / 레이어 래스터 이미지 */
  function rasterImage(id, values, rows, cols, color, map, key) {
    let hit = layerImages.get(id);
    if (hit && hit.key === key) return hit.canvas;
    const cv = hit?.canvas || document.createElement('canvas');
    cv.width = cols;
    cv.height = rows;
    const g = cv.getContext('2d');
    const img = g.createImageData(cols, rows);
    const d = img.data;
    const rgb = hexRgb(color);
    const lut = LUT[map];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = values[r * cols + c];
        if (v <= 0) continue;
        const o = ((rows - 1 - r) * cols + c) * 4;
        if (lut) { const q = Math.min(255, Math.round(v * 255)) * 3; d[o] = lut[q]; d[o + 1] = lut[q + 1]; d[o + 2] = lut[q + 2]; d[o + 3] = 255; } else { d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = Math.round(255 * Math.pow(v, 0.7)); }
      }
    }
    g.putImageData(img, 0, 0);
    hit = { key, canvas: cv };
    layerImages.set(id, hit);
    return cv;
  }

  /**
   * The Result as an image (≤ 1400 columns × bins): every audible layer, every chromatic channel
   * shifted by exactly 12·log2(ratio) semitones and its time offset, noise as grain. Built once per
   * bake + display settings; a frame only blits it. / Result 이미지: 베이킹·표시 설정마다 한 번만 생성.
   */
  function buildResultImage(p, bake, m) {
    const { N, F, rate, bps, pLo } = bake.dims;
    // a line thinner than a pixel would vanish when the image is scaled down: widen it to ≥ ~1.5 px
    // 한 픽셀보다 얇은 선은 축소 시 사라지므로 ≥ 약 1.5 px이 되게 넓힘 (표시 전용)
    const pxPerBin = m.plotH / Math.max(1, (p.view.midiMax - p.view.midiMin) * bps);
    const thick = pxPerBin >= 1.5 ? 0 : Math.min(6, Math.ceil(0.75 / pxPerBin));
    const layers = audibleLayers(p);
    const disp = layers.map((l) => {
      const ch = bankItem(l, 'chroma');
      const nz = bankItem(l, 'noise');
      return [l.id, l.color, l.gain, ch?.on ? ch.params : null, nz?.on && nz.mix > 0 ? nz.params : null];
    });
    const key = `${bake.sig}|${p.view.colorR}|${p.view.showChroma}|${thick}|${JSON.stringify(disp)}`;
    if (resultImage.key === key) return resultImage.canvas;
    const W = Math.min(F, MAX_RESULT_COLS);
    const cv = resultImage.canvas || document.createElement('canvas');
    cv.width = W;
    cv.height = N;
    const acc = new Float32Array(W * N * 3);
    const colBuf = new Float32Array(N);
    let colored = p.view.colorR === 'layer';
    for (const l of layers) {
      const M = bake.mats.get(l.id)?.M;
      if (!M) continue;
      const chromaIt = bankItem(l, 'chroma');
      const chroma = chromaIt && chromaIt.on && p.view.showChroma;
      if (chroma) colored = true;
      const channels = chromaIt && chromaIt.on ? GridEffectRegistry.get('chroma').bank(chromaIt.params).channels : [{ ch: 'g', semis: 0, gain: 1, timeMs: 0 }];
      const noiseIt = bankItem(l, 'noise');
      const noise = noiseIt && noiseIt.on && noiseIt.mix > 0 ? GridEffectRegistry.get('noise').bank(noiseIt.params, { seed: p.render.seed }).noise : null;
      const lc = hexRgb(l.color).map((v) => v / 255);
      for (const c of channels) {
        const tint = chroma ? CHROMA_TINT[c.ch] : p.view.colorR === 'layer' ? lc : [1, 1, 1];
        const shift = Math.round(c.semis * bps);
        const off = Math.round((c.timeMs / 1000) * rate);
        const g = l.gain * c.gain;
        for (let x = 0; x < W; x++) {
          const fA = Math.floor((x * F) / W) - off;
          const fB = Math.max(fA + 1, Math.floor(((x + 1) * F) / W) - off);
          colBuf.fill(0);
          let any = false;
          for (let i = Math.max(0, shift); i < Math.min(N, N + shift); i++) {
            let v = 0;
            for (let f = Math.max(0, fA); f < Math.min(F, fB); f++) { const s = M[f * N + i - shift]; if (s > v) v = s; }
            if (v <= 0) continue;
            // noisy tone: grain on the line itself / 노이지한 톤: 선 위의 입자
            if (noise && noise.n > 0) v *= Math.sqrt(1 - noise.n) + Math.sqrt(noise.n) * 1.6 * hash3(x, i, 7);
            v *= g;
            any = true;
            for (let k = Math.max(0, i - thick); k <= Math.min(N - 1, i + thick); k++) if (v > colBuf[k]) colBuf[k] = v;
          }
          if (!any) continue;
          for (let i = 0; i < N; i++) {
            const v = colBuf[i];
            if (v <= 0) continue;
            const o = ((N - 1 - i) * W + x) * 3;
            acc[o] += v * tint[0]; acc[o + 1] += v * tint[1]; acc[o + 2] += v * tint[2];
          }
        }
      }
      if (noise && noise.floor > 0) {
        // full-band floor: speckle whose density follows the colour slope / 전대역 바닥: 색 기울기를 따르는 점
        const tint = p.view.colorR === 'layer' ? lc : [1, 1, 1];
        for (let i = 0; i < N; i++) {
          const oct = (pLo + i / bps - 69) / 12;
          const amp = clamp(noise.floor * l.gain * Math.pow(10, (noise.slope * oct) / 20) * 1.5, 0, 1);
          if (amp < 0.004) continue;
          for (let x = 0; x < W; x++) {
            const u = hash3(x, i, noise.seed & 0xffff);
            if (u > 0.35) continue;
            const v = amp * (0.4 + 1.7 * u);
            const o = ((N - 1 - i) * W + x) * 3;
            acc[o] += v * tint[0]; acc[o + 1] += v * tint[1]; acc[o + 2] += v * tint[2];
          }
        }
      }
    }
    const g2 = cv.getContext('2d');
    const img = g2.createImageData(W, N);
    const d = img.data;
    const lut = colored ? null : LUT[p.view.colorR] || LUT.heat;
    for (let j = 0, o = 0; j < W * N; j++, o += 4) {
      const r = acc[j * 3];
      const g = acc[j * 3 + 1];
      const b = acc[j * 3 + 2];
      if (lut) {
        const q = Math.min(255, Math.round(Math.max(r, g, b) * 255)) * 3;
        d[o] = lut[q]; d[o + 1] = lut[q + 1]; d[o + 2] = lut[q + 2];
      } else {
        d[o] = BG[0] + (255 - BG[0]) * Math.pow(Math.min(1, r), 0.6);
        d[o + 1] = BG[1] + (255 - BG[1]) * Math.pow(Math.min(1, g), 0.6);
        d[o + 2] = BG[2] + (255 - BG[2]) * Math.pow(Math.min(1, b), 0.6);
      }
      d[o + 3] = r + g + b > 0.002 ? 255 : 0;
    }
    g2.putImageData(img, 0, 0);
    resultImage = { key, canvas: cv };
    return cv;
  }

  // ------------------------------------------------------------------ drawing
  function drawBackdrop(ctx, m, p) {
    const view = p.view;
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);
    for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const yTop = m.midiToY(midi + 0.5);
      const yBot = m.midiToY(midi - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(m.plotX, Math.max(m.plotY, yTop), m.plotW, Math.max(1, Math.min(m.plotY + m.plotH, yBot) - Math.max(m.plotY, yTop)));
    }
    // the document area / 문서 영역
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    const g = p.grid;
    const x0 = m.timeToX(0);
    const x1 = m.timeToX(g.length);
    const y0 = m.midiToY(g.pHi + 0.5 / g.rowsPerSemi);
    const y1 = m.midiToY(g.pLo - 0.5 / g.rowsPerSemi);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, x1 - x0, y1 - y0);
    ctx.restore();
  }

  function drawGrid(ctx, m, p, cells) {
    const view = p.view;
    const g = p.grid;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    ctx.lineWidth = 1;
    // octave lines (C) and time ticks / 옥타브 선과 시간 눈금
    for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
      if (((midi % 12) + 12) % 12 !== 0) continue;
      const y = Math.round(m.midiToY(midi)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.beginPath(); ctx.moveTo(m.plotX, y); ctx.lineTo(m.plotX + m.plotW, y); ctx.stroke();
    }
    const step = timeStep(view.tMax - view.tMin, m.plotW);
    for (let s = Math.ceil(view.tMin / step) * step; s <= view.tMax; s += step) {
      const x = Math.round(m.timeToX(s)) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
      ctx.beginPath(); ctx.moveTo(x, m.plotY); ctx.lineTo(x, m.plotY + m.plotH); ctx.stroke();
    }
    // cell lines only when zoomed in (≥ 7 px per cell) / 셀 격자선은 확대했을 때만
    if (cells) {
      const cw = (m.plotW / (view.tMax - view.tMin)) / g.colsPerSec;
      const ch = (m.plotH / (view.midiMax - view.midiMin)) / g.rowsPerSemi;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
      if (cw >= 7) {
        for (let c = Math.max(0, Math.ceil(view.tMin * g.colsPerSec)); c <= Math.min(g.length * g.colsPerSec, view.tMax * g.colsPerSec); c++) {
          const x = Math.round(m.timeToX(c / g.colsPerSec)) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, m.plotY); ctx.lineTo(x, m.plotY + m.plotH); ctx.stroke();
        }
      }
      if (ch >= 7) {
        const { rows } = gridShape(g);
        for (let r = 0; r <= rows; r++) {
          const midi = g.pLo + (r - 0.5) / g.rowsPerSemi;
          if (midi < view.midiMin || midi > view.midiMax) continue;
          const y = Math.round(m.midiToY(midi)) + 0.5;
          ctx.beginPath(); ctx.moveTo(m.plotX, y); ctx.lineTo(m.plotX + m.plotW, y); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  function drawAxes(ctx, m, p, label, color) {
    const view = p.view;
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(m.plotX + 0.5, m.plotY + 0.5, m.plotW - 1, m.plotH - 1);
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const semiPx = m.plotH / (view.midiMax - view.midiMin);
    for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
      const pc = ((midi % 12) + 12) % 12;
      if (pc !== 0 && !(semiPx >= 12 && !BLACK.has(pc))) continue;
      const py = m.midiToY(midi);
      if (py < m.plotY + 6 || py > m.plotY + m.plotH - 6) continue;
      ctx.fillStyle = pc === 0 ? '#38bdf8' : '#64748b';
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
    // window label, top right / 윈도우 라벨 (우상단)
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
    ctx.fillRect(m.plotX + m.plotW - tw - 12, m.plotY + 3, tw + 9, 16);
    ctx.fillStyle = color;
    ctx.fillText(label, m.plotX + m.plotW - 7, m.plotY + 5);
  }

  function drawTransport(ctx, m) {
    const tr = appState.transport;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    drawCueLine(ctx, m.timeToX(tr.cueSec), m.plotY, m.plotY + m.plotH); // shared look (ui/transport-lines.js) / 공용 모양
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), m.plotY, m.plotY + m.plotH);
    ctx.restore();
  }

  function drawCrosshair(ctx, m) {
    if (!hover) return;
    const x = m.timeToX(hover.t);
    const y = m.midiToY(hover.midi);
    if (x < m.plotX || x > m.plotX + m.plotW || y < m.plotY || y > m.plotY + m.plotH) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, m.plotY); ctx.lineTo(Math.round(x) + 0.5, m.plotY + m.plotH);
    ctx.moveTo(m.plotX, Math.round(y) + 0.5); ctx.lineTo(m.plotX + m.plotW, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  /** Outline of the selection (marching ants in the Editor, static in the Result). / 선택 영역 윤곽선 */
  function drawSelection(ctx, m, p, animated) {
    const s = drag && drag.type === 'select' ? drag.sel : p.selection;
    if (!s || s.kind === 'none') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    ctx.beginPath();
    if (s.kind === 'lasso') {
      s.pts.forEach(([x, y], k) => { const q = cellToPx(p, m, x, y); if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
      ctx.closePath();
    } else {
      const a = cellToPx(p, m, Math.min(s.x0, s.x1), Math.max(s.y0, s.y1));
      const b = cellToPx(p, m, Math.max(s.x0, s.x1), Math.min(s.y0, s.y1));
      if (s.kind === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.9)';
    ctx.stroke();
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = animated ? -((performance.now() / 60) % 9) : 0;
    ctx.strokeStyle = '#f8fafc';
    ctx.stroke();
    ctx.restore();
  }

  function drawPicture(ctx, m, p, cv, smooth, alpha = 1) {
    const g = p.grid;
    const x0 = m.timeToX(0);
    const x1 = m.timeToX(g.length);
    ctx.imageSmoothingEnabled = smooth;
    ctx.globalAlpha = alpha;
    return { x0, x1, draw: (yTop, yBot) => { ctx.drawImage(cv, 0, 0, cv.width, cv.height, x0, yTop, x1 - x0, yBot - yTop); ctx.globalAlpha = 1; } };
  }

  function renderEditor(p) {
    const { dpr, w, h } = sizeCanvas(els.editor);
    const m = gridMetrics(w, h, p.view);
    lastMetrics.editor = m;
    const ctx = ctxE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop(ctx, m, p);
    const g = p.grid;
    const { rows, cols } = gridShape(g);
    const act = activeLayer(p);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    const yTop = m.midiToY(g.pHi + 0.5 / g.rowsPerSemi);
    const yBot = m.midiToY(g.pLo - 0.5 / g.rowsPerSemi);
    for (const l of [...p.layers.filter((q) => q.id !== act.id), act]) {
      const live = stroke && stroke.layerId === l.id && stroke.target === 'raster';
      const values = live ? stroke.work : decodeRaster(l.raster);
      const key = `${live ? `w${stroke.rev}` : l.raster.data}|${l.color}|${p.view.colorE}|${rows}x${cols}`;
      const cv = rasterImage(l.id, values, rows, cols, l.color, l.id === act.id ? p.view.colorE : 'layer', key);
      drawPicture(ctx, m, p, cv, false, l.id === act.id ? 1 : 0.3).draw(yTop, yBot);
    }
    // quick mask of the active layer (where the masked effects act) / 활성 레이어의 퀵 마스크
    const liveMask = stroke && stroke.target === 'mask';
    if (p.view.showMask && (act.maskRaster || liveMask) && (p.tool.id === 'mask' || liveMask)) {
      const values = liveMask ? stroke.work : decodeRaster(act.maskRaster);
      const key = `${liveMask ? `w${stroke.rev}` : act.maskRaster.data}|${rows}x${cols}`;
      if (maskImage.key !== key) {
        const cv = maskImage.canvas || document.createElement('canvas');
        cv.width = cols; cv.height = rows;
        const g2 = cv.getContext('2d');
        const img = g2.createImageData(cols, rows);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const o = ((rows - 1 - r) * cols + c) * 4; img.data[o] = 244; img.data[o + 1] = 63; img.data[o + 2] = 94; img.data[o + 3] = Math.round(120 * (1 - values[r * cols + c])); }
        g2.putImageData(img, 0, 0);
        maskImage = { key, canvas: cv };
      }
      drawPicture(ctx, m, p, maskImage.canvas, false).draw(yTop, yBot);
    }
    ctx.restore();
    if (p.view.showGrid) drawGrid(ctx, m, p, true);
    drawSelection(ctx, m, p, true);
    drawToolPreview(ctx, m, p);
    drawTransport(ctx, m);
    drawAxes(ctx, m, p, t('grid.win.editor'), '#7dd3fc');
    drawCrosshair(ctx, m);
    drawBrushOutline(ctx, m, p);
  }

  function drawToolPreview(ctx, m, p) {
    if (!drag || !drag.a || !drag.b) return;
    const a = cellToPx(p, m, drag.a.x, drag.a.y);
    const b = cellToPx(p, m, drag.b.x, drag.b.y);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    if (drag.type === 'rect') ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    else if (drag.type === 'ellipse') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    else if (drag.type === 'line' || drag.type === 'gradient') { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    if (drag.type === 'gradient' && p.tool.gradient === 'radial') ctx.ellipse(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(b.x - a.x, b.y - a.y), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawBrushOutline(ctx, m, p) {
    if (!hover || hover.src !== 'editor') return;
    const id = p.tool.id;
    if (!['brush', 'eraser', 'mask', 'liquify', 'line'].includes(id)) return;
    const size = id === 'liquify' ? p.tool.liqSize : p.tool.size;
    const rx = (size / p.grid.colsPerSec) * (m.plotW / (p.view.tMax - p.view.tMin));
    const ry = (size / p.grid.rowsPerSemi) * (m.plotH / (p.view.midiMax - p.view.midiMin));
    const x = m.timeToX(hover.t);
    const y = m.midiToY(hover.midi);
    if (!m.inPlot({ x, y })) return;
    ctx.save();
    ctx.strokeStyle = id === 'eraser' ? '#fb7185' : id === 'liquify' ? '#a78bfa' : '#f8fafc';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (p.tool.shape === 'square' && id !== 'liquify') ctx.rect(x - rx, y - ry, 2 * rx, 2 * ry);
    else ctx.ellipse(x, y, Math.max(1.5, rx), Math.max(1.5, ry), 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawOverlays(ctx, m, p, bake) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    const act = activeLayer(p);
    const infos = bake.mats.get(act.id)?.infos || [];
    if (p.view.showEvents) {
      // glitch events: a tick per event on top of the plot / 글리치 이벤트 틱
      ctx.fillStyle = '#f472b6';
      for (const st of infos) {
        if (st.type !== 'glitch' || !st.info.events) continue;
        for (const e of st.info.events) { const x = m.timeToX(e.t); ctx.fillRect(Math.round(x), m.plotY, 1.5, 7); }
      }
    }
    if (p.view.showMesh) {
      const liq = act.stack.find((it) => it.type === 'liquify' && it.on);
      if (liq) {
        const { rows, cols } = gridShape(p.grid);
        const mesh = liquifyMesh(liq.params.ops, rows, cols);
        const am = liq.params.amount;
        ctx.strokeStyle = 'rgba(167, 139, 250, 0.55)';
        ctx.lineWidth = 1;
        const stepN = Math.max(2, Math.round(cols / 16)) * 2;
        const node = (mx, my) => { const j = my * mesh.W + mx; return cellToPx(p, m, mx / 2 + (liq.params.lockTime ? 0 : am * mesh.Dx[j]), my / 2 + am * mesh.Dy[j]); };
        for (let my = 0; my < mesh.H; my += stepN) { ctx.beginPath(); for (let mx = 0; mx < mesh.W; mx += 2) { const q = node(mx, my); if (mx) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.stroke(); }
        for (let mx = 0; mx < mesh.W; mx += stepN) { ctx.beginPath(); for (let my = 0; my < mesh.H; my += 2) { const q = node(mx, my); if (my) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.stroke(); }
      }
    }
    ctx.restore();
    // chromatic offsets as text / 크로매틱 반음 오프셋 텍스트
    const chromaIt = bankItem(act, 'chroma');
    if (p.view.showChroma && chromaIt?.on) {
      const chans = GridEffectRegistry.get('chroma').bank(chromaIt.params).channels;
      ctx.font = '11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      let x = m.plotX + 6;
      for (const c of chans) {
        const txt = `${c.ch.toUpperCase()} ${c.semis >= 0 ? '+' : ''}${c.semis.toFixed(2)} st`;
        const tint = CHROMA_TINT[c.ch].map((v) => Math.round(v * 255));
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.75)';
        ctx.fillRect(x - 3, m.plotY + 3, tw + 6, 16);
        ctx.fillStyle = `rgb(${tint.join(',')})`;
        ctx.fillText(txt, x, m.plotY + 5);
        x += tw + 12;
      }
    }
  }

  function renderResult(p) {
    const { dpr, w, h } = sizeCanvas(els.result);
    const m = gridMetrics(w, h, p.view);
    lastMetrics.result = m;
    const ctx = ctxR;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBackdrop(ctx, m, p);
    const { bake, pending } = getGridResult(p); // full bake when cached, else a preview at once / 캐시된 전체 베이킹, 없으면 즉시 미리보기
    const cv = buildResultImage(p, bake, m);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.plotX, m.plotY, m.plotW, m.plotH);
    ctx.clip();
    const half = 0.5 / bake.dims.bps;
    drawPicture(ctx, m, p, cv, true).draw(m.midiToY(bake.dims.pHi + half), m.midiToY(bake.dims.pLo - half));
    ctx.restore();
    if (p.view.showGrid) drawGrid(ctx, m, p, false);
    drawOverlays(ctx, m, p, bake);
    drawSelection(ctx, m, p, false);
    drawTransport(ctx, m);
    drawAxes(ctx, m, p, t('grid.win.result'), '#f0abfc');
    drawCrosshair(ctx, m);
    if (els.status) {
      els.status.textContent = pending ? t('grid.processing') : '';
      els.status.classList.toggle('hidden', !pending);
    }
    return bake;
  }

  let lastBake = null;
  function render() {
    const p = getGridParams();
    renderEditor(p);
    lastBake = renderResult(p);
    if (hover && els.hud) {
      els.hud.time.textContent = `${hover.t.toFixed(2)}s`;
      els.hud.note.textContent = midiToNoteName(hover.midi);
      els.hud.hz.textContent = `${midiToFreq(hover.midi).toFixed(1)} Hz`;
      let val = '—';
      const g = p.grid;
      if (hover.t >= 0 && hover.t <= g.length) {
        if (hover.src === 'editor') {
          const { rows, cols } = gridShape(g);
          const c = Math.floor(hover.t * g.colsPerSec);
          const r = Math.round((hover.midi - g.pLo) * g.rowsPerSemi);
          if (c >= 0 && c < cols && r >= 0 && r < rows) val = decodeRaster(activeLayer(p).raster)[r * cols + c].toFixed(2);
        } else if (lastBake) {
          const { N, F, rate, bps, pLo } = lastBake.dims;
          const i = Math.round((hover.midi - pLo) * bps);
          const f = Math.min(F - 1, Math.round(hover.t * rate));
          const M = lastBake.mats.get(activeLayer(p).id)?.M;
          if (M && i >= 0 && i < N) val = M[f * N + i].toFixed(3);
        }
      }
      els.hud.val.textContent = val;
    }
  }

  // ------------------------------------------------------------------ strokes
  function beginStroke(p, target) {
    const act = activeLayer(p);
    const { rows, cols } = gridShape(p.grid);
    const src = target === 'mask' ? (act.maskRaster ? decodeRaster(act.maskRaster) : new Float32Array(rows * cols)) : decodeRaster(act.raster);
    stroke = { target, layerId: act.id, base: Float32Array.from(src), work: Float32Array.from(src), cov: new Float32Array(rows * cols), rows, cols, rev: 0, lastCommit: 0, dirty: false };
    return stroke;
  }

  function composite(p, value, opacity) {
    const s = stroke;
    const cov = p.tool.symTime || p.tool.symPitch ? mirrorCoverage(Float32Array.from(s.cov), s.rows, s.cols, { time: p.tool.symTime, pitch: p.tool.symPitch }) : s.cov;
    compositeStroke(s.base, s.work, cov, value, opacity, selectionCoverage(p.selection, { rows: s.rows, cols: s.cols }));
    s.rev++;
    s.dirty = true;
  }

  function commitStroke(final) {
    const s = stroke;
    if (!s) return;
    const now = performance.now();
    if (!final && now - s.lastCommit < COMMIT_MS) return;
    if (s.dirty) {
      s.lastCommit = now;
      s.dirty = false;
      const enc = encodeRaster(s.work, s.rows, s.cols);
      editGrid((d) => {
        const l = d.layers.find((q) => q.id === s.layerId);
        if (!l) return;
        if (s.target === 'mask') l.maskRaster = enc; else l.raster = enc;
      }, { coalesceKey: 'grid-stroke' });
    }
    if (final) { endHistoryGesture(); stroke = null; }
  }

  const strokeValue = (p) => (p.tool.id === 'eraser' ? 0 : p.tool.value);
  const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 1);

  /** Add the stroke being dragged to the layer's Liquify item (created on first use). / 리퀴파이 스트로크 추가 */
  function commitLiquify(p, final) {
    const now = performance.now();
    if (!final && now - drag.lastCommit < COMMIT_MS) return;
    drag.lastCommit = now;
    const pts = drag.pts.length > 90 ? drag.pts.filter((_, k) => k % Math.ceil(drag.pts.length / 90) === 0 || k === drag.pts.length - 1) : drag.pts;
    const op = { tool: p.tool.liq, size: p.tool.liqSize, strength: p.tool.liqStrength, momentum: p.tool.liqMomentum, pts: pts.map((q) => [q.x, q.y]) };
    const layerId = drag.layerId;
    const opIndex = drag.opIndex;
    editGrid((d) => {
      const l = d.layers.find((q) => q.id === layerId);
      if (!l) return;
      let it = l.stack.find((q) => q.type === 'liquify');
      if (!it) { it = createStackItem('liquify', {}); l.stack.unshift(it); }
      it.on = true;
      const ops = it.params.ops;
      if (opIndex < ops.length) ops[opIndex] = op; else ops.push(op);
    }, { coalesceKey: 'grid-liquify' });
    if (final) endHistoryGesture();
  }

  // ------------------------------------------------------------------ pointer: Editor
  const onDownE = (e) => {
    const p = getGridParams();
    const m = lastMetrics.editor || gridMetrics(els.editor.clientWidth, els.editor.clientHeight, p.view);
    const pt = pos(els.editor, e);
    try { els.editor.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    if (e.button === 1 || (e.button === 0 && !m.inPlot(pt))) { drag = { type: 'pan', x: pt.x, y: pt.y, view: { ...p.view }, m }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const c = cellOf(p, m, pt);
    const id = p.tool.id;
    const { rows, cols } = gridShape(p.grid);
    if (id === 'brush' || id === 'eraser' || id === 'mask') {
      const s = beginStroke(p, id === 'mask' ? 'mask' : 'raster');
      stampBrush(s.cov, s.rows, s.cols, c.x, c.y, p.tool.size, { hardness: p.tool.hardness, flow: p.tool.flow * pressureOf(e), shape: p.tool.shape });
      composite(p, strokeValue(p), p.tool.opacity);
      drag = { type: 'stroke', last: c };
      commitStroke(false);
    } else if (id === 'line' || id === 'rect' || id === 'ellipse' || id === 'gradient') {
      const a = id === 'line' && p.tool.snap ? { x: c.x, y: Math.round((c.y - 0.5) / p.grid.rowsPerSemi) * p.grid.rowsPerSemi + 0.5 } : c;
      drag = { type: id, a, b: a };
    } else if (id === 'bucket') {
      const s = beginStroke(p, 'raster');
      s.cov.set(floodCoverage(s.base, rows, cols, Math.floor(c.x), Math.floor(c.y), p.tool.threshold));
      composite(p, p.tool.value, p.tool.opacity);
      commitStroke(true);
    } else if (id === 'eyedropper') {
      const cc = Math.floor(c.x);
      const rr = Math.floor(c.y);
      if (cc >= 0 && cc < cols && rr >= 0 && rr < rows) {
        const v = decodeRaster(activeLayer(p).raster)[rr * cols + cc];
        editGrid((d) => { d.tool.value = Number(v.toFixed(2)); }, { history: false });
      }
    } else if (id === 'select') {
      drag = { type: 'select', a: null, start: c, sel: { kind: 'none', x0: c.x, y0: c.y, x1: c.x, y1: c.y, pts: [[c.x, c.y]], feather: p.tool.feather }, moved: false };
    } else if (id === 'liquify') {
      const act = activeLayer(p);
      const it = act.stack.find((q) => q.type === 'liquify');
      const n = it ? it.params.ops.length : 0;
      if (n >= LIQUIFY_MAX_OPS) { showToast?.(t('grid.liqFull', LIQUIFY_MAX_OPS), 'error'); return; }
      drag = { type: 'liquify', pts: [c], layerId: act.id, opIndex: n, lastCommit: 0 };
    }
    requestRender(['grid']);
  };

  const onMoveE = (e) => {
    const p = getGridParams();
    const m = lastMetrics.editor || gridMetrics(els.editor.clientWidth, els.editor.clientHeight, p.view);
    const pt = pos(els.editor, e);
    hover = { t: m.xToTime(pt.x), midi: m.yToMidi(pt.y), src: 'editor' };
    if (!drag) { els.editor.style.cursor = m.inPlot(pt) ? (p.tool.id === 'eyedropper' ? 'copy' : 'crosshair') : 'grab'; requestRender(['grid']); return; }
    const c = cellOf(p, m, pt);
    if (drag.type === 'pan') {
      const vp = drag.view;
      const tSpan = vp.tMax - vp.tMin;
      const mSpan = vp.midiMax - vp.midiMin;
      setView((vw) => { Object.assign(vw, { tMin: vp.tMin, tMax: vp.tMax, midiMin: vp.midiMin, midiMax: vp.midiMax }); panViewTime(vw, -((pt.x - drag.x) / drag.m.plotW) * tSpan, GRID_VIEW_LIMITS); panViewPitch(vw, ((pt.y - drag.y) / drag.m.plotH) * mSpan, GRID_VIEW_LIMITS); });
      return;
    }
    if (drag.type === 'stroke' && stroke) {
      strokeSegment(stroke.cov, stroke.rows, stroke.cols, drag.last.x, drag.last.y, c.x, c.y, p.tool.size, { hardness: p.tool.hardness, flow: p.tool.flow * pressureOf(e), shape: p.tool.shape });
      drag.last = c;
      composite(p, strokeValue(p), p.tool.opacity);
      commitStroke(false);
    } else if (drag.type === 'line') {
      let b = c;
      if (p.tool.snap) b = { x: c.x, y: Math.round((c.y - 0.5) / p.grid.rowsPerSemi) * p.grid.rowsPerSemi + 0.5 };
      if (e.shiftKey) b = { x: b.x, y: drag.a.y }; // Shift = horizontal / Shift = 수평
      drag.b = b;
    } else if (drag.type === 'rect' || drag.type === 'ellipse' || drag.type === 'gradient') {
      drag.b = c;
    } else if (drag.type === 'select') {
      drag.moved = drag.moved || Math.hypot(c.x - drag.start.x, c.y - drag.start.y) > 0.4;
      const kind = p.tool.select;
      if (kind === 'lasso') drag.sel = { ...drag.sel, kind: drag.sel.pts.length >= 2 ? 'lasso' : 'none', pts: [...drag.sel.pts, [c.x, c.y]] };
      else drag.sel = { ...drag.sel, kind: drag.moved ? kind : 'none', x1: c.x, y1: c.y };
    } else if (drag.type === 'liquify') {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(c.x - last.x, c.y - last.y) >= 0.3) { drag.pts.push(c); if (drag.pts.length >= 2) commitLiquify(p, false); }
    }
    requestRender(['grid']);
  };

  const onUpE = (e) => {
    const p = getGridParams();
    const d = drag;
    drag = null;
    try { els.editor.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    const { rows, cols } = gridShape(p.grid);
    if (d.type === 'stroke') commitStroke(true);
    else if (d.type === 'line') {
      const s = beginStroke(p, 'raster');
      strokeSegment(s.cov, rows, cols, d.a.x, d.a.y, d.b.x, d.b.y, p.tool.size, { hardness: p.tool.hardness, flow: 1, shape: p.tool.shape });
      composite(p, p.tool.value, p.tool.opacity);
      commitStroke(true);
    } else if (d.type === 'rect' || d.type === 'ellipse') {
      if (Math.abs(d.b.x - d.a.x) > 0.3 && Math.abs(d.b.y - d.a.y) > 0.3) {
        const s = beginStroke(p, 'raster');
        s.cov.set((d.type === 'rect' ? rectCoverage : ellipseCoverage)(rows, cols, d.a.x, d.a.y, d.b.x, d.b.y));
        composite(p, p.tool.value, p.tool.opacity);
        commitStroke(true);
      }
    } else if (d.type === 'gradient') {
      if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) > 0.5) {
        const s = beginStroke(p, 'raster');
        const grad = gradientValues(rows, cols, d.a.x, d.a.y, d.b.x, d.b.y, p.tool.gradient);
        for (let i = 0; i < grad.length; i++) grad[i] *= p.tool.value;
        s.cov.fill(1);
        compositeStroke(s.base, s.work, s.cov, grad, p.tool.opacity, selectionCoverage(p.selection, { rows, cols }));
        s.rev++;
        s.dirty = true;
        commitStroke(true);
      }
    } else if (d.type === 'select') {
      // a click without a drag clears the selection / 드래그 없는 클릭은 선택 해제
      const sel = d.moved ? d.sel : { kind: 'none', x0: 0, y0: 0, x1: 0, y1: 0, pts: [], feather: p.tool.feather };
      editGrid((doc) => { doc.selection = { ...sel, feather: p.tool.feather }; }, { history: false });
    } else if (d.type === 'liquify') {
      if (d.pts.length >= 2 || ['twirlCW', 'twirlCCW', 'pinch', 'bloat', 'smooth', 'reconstruct'].includes(p.tool.liq)) { drag = d; commitLiquify(p, true); drag = null; }
    }
    requestRender(['grid']);
  };

  // ------------------------------------------------------------------ pointer: Result (read-only)
  const onDownR = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const p = getGridParams();
    const m = lastMetrics.result || gridMetrics(els.result.clientWidth, els.result.clientHeight, p.view);
    const pt = pos(els.result, e);
    try { els.result.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    drag = { type: 'panR', x: pt.x, y: pt.y, view: { ...p.view }, m }; // the Result never edits: a drag pans / Result는 편집 불가: 드래그 = 이동
  };
  const onMoveR = (e) => {
    const p = getGridParams();
    const m = lastMetrics.result || gridMetrics(els.result.clientWidth, els.result.clientHeight, p.view);
    const pt = pos(els.result, e);
    hover = { t: m.xToTime(pt.x), midi: m.yToMidi(pt.y), src: 'result' };
    if (drag && drag.type === 'panR') {
      const vp = drag.view;
      setView((vw) => { Object.assign(vw, { tMin: vp.tMin, tMax: vp.tMax, midiMin: vp.midiMin, midiMax: vp.midiMax }); panViewTime(vw, -((pt.x - drag.x) / drag.m.plotW) * (vp.tMax - vp.tMin), GRID_VIEW_LIMITS); panViewPitch(vw, ((pt.y - drag.y) / drag.m.plotH) * (vp.midiMax - vp.midiMin), GRID_VIEW_LIMITS); });
      return;
    }
    requestRender(['grid']);
  };
  const onUpR = (e) => {
    if (drag && drag.type === 'panR') drag = null;
    try { els.result.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  };

  const onLeave = () => { if (!drag) { hover = null; requestRender(['grid']); } };

  const onWheel = (cv, which) => (e) => {
    e.preventDefault();
    const p = getGridParams();
    const m = lastMetrics[which] || gridMetrics(cv.clientWidth, cv.clientHeight, p.view);
    const pt = pos(cv, e);
    // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
    editGrid((d) => wheelNavigate(e, d.view, m, pt, GRID_VIEW_LIMITS), { history: false });
  };
  const wheelE = onWheel(els.editor, 'editor');
  const wheelR = onWheel(els.result, 'result');

  const onDbl = (cv, which) => (e) => {
    const p = getGridParams();
    const m = lastMetrics[which];
    if (!m) return;
    const pt = pos(cv, e);
    // Editor: the picture is for painting, so the cue is set on the time ruler (below / above the plot)
    // Editor에서는 그림 위 더블클릭이 칠하기이므로 큐는 시간 눈금(플롯 위·아래)에서 설정
    if (which === 'editor' && m.inPlot(pt)) return;
    if (pt.x < m.plotX || pt.x > m.plotX + m.plotW) return;
    cueOrAudition(e, clamp(Number(m.xToTime(pt.x).toFixed(2)), 0, p.grid.length));
  };
  const dblE = onDbl(els.editor, 'editor');
  const dblR = onDbl(els.result, 'result');
  const noMenu = (e) => e.preventDefault();

  els.editor.addEventListener('pointerdown', onDownE);
  els.editor.addEventListener('pointermove', onMoveE);
  els.editor.addEventListener('pointerup', onUpE);
  els.editor.addEventListener('pointercancel', onUpE);
  els.editor.addEventListener('pointerleave', onLeave);
  els.editor.addEventListener('dblclick', dblE);
  els.editor.addEventListener('wheel', wheelE, { passive: false });
  els.editor.addEventListener('auxclick', noMenu);
  els.result.addEventListener('pointerdown', onDownR);
  els.result.addEventListener('pointermove', onMoveR);
  els.result.addEventListener('pointerup', onUpR);
  els.result.addEventListener('pointercancel', onUpR);
  els.result.addEventListener('pointerleave', onLeave);
  els.result.addEventListener('dblclick', dblR);
  els.result.addEventListener('wheel', wheelR, { passive: false });
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['grid'])) : null;
  ro?.observe(els.editor);
  ro?.observe(els.result);
  // marching ants / 점선 애니메이션
  const ants = setInterval(() => { if (getGridParams().selection.kind !== 'none' && els.editor.isConnected) requestRender(['grid']); }, 180);

  return {
    render,
    metrics: () => ({ ...lastMetrics }),
    /** Delete key: clear the active layer inside the selection (one undo step). / Delete = 선택 영역 지우기 */
    deleteSelection() {
      const p = getGridParams();
      const { rows, cols } = gridShape(p.grid);
      const cov = selectionCoverage(p.selection, { rows, cols });
      if (!cov) { showToast?.(t('grid.noSelection'), 'error'); return false; }
      const act = activeLayer(p);
      const src = decodeRaster(act.raster);
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = src[i] * (1 - cov[i]);
      const enc = encodeRaster(out, rows, cols);
      editGrid((d) => { const l = d.layers.find((q) => q.id === act.id); if (l) l.raster = enc; });
      endHistoryGesture();
      return true;
    },
    /**
     * PNG / JPG → luminance → resampled to the grid → a new layer, or blended (max) into the active
     * one. The top of the image is the highest pitch. / 이미지 → 휘도 → 격자 해상도 → 새 레이어 또는 현재 레이어에 합성
     */
    async importImage(file) {
      const p = getGridParams();
      const { rows, cols } = gridShape(p.grid);
      let bmp;
      try { bmp = await createImageBitmap(file); } catch { showToast?.(t('grid.importFail'), 'error'); return; }
      const cv = document.createElement('canvas');
      cv.width = cols;
      cv.height = rows;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.fillStyle = p.tool.importInvert ? '#fff' : '#000';
      g.fillRect(0, 0, cols, rows);
      g.drawImage(bmp, 0, 0, cols, rows);
      const d = g.getImageData(0, 0, cols, rows).data;
      const ras = new Float32Array(rows * cols);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const o = ((rows - 1 - r) * cols + c) * 4;
          let v = ((0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255) * (d[o + 3] / 255);
          if (p.tool.importInvert) v = 1 - v;
          ras[r * cols + c] = v < 0.02 ? 0 : v;
        }
      }
      const toNew = p.tool.importTarget === 'new' && p.layers.length < GRID_MAX_LAYERS;
      editGrid((doc) => {
        if (toNew) {
          const used = new Set(doc.layers.map((l) => l.id));
          let n = doc.layers.length;
          while (used.has(`L${n + 1}`)) n++;
          const layer = createGridLayer(n, { rows, cols }, { raster: encodeRaster(ras, rows, cols), name: String(file.name || 'Image').replace(/\.[^.]+$/, '').slice(0, 24) });
          doc.layers.push(layer);
          doc.activeLayerId = layer.id;
        } else {
          const l = doc.layers.find((q) => q.id === doc.activeLayerId) || doc.layers[0];
          const cur = decodeRaster(l.raster);
          for (let i = 0; i < ras.length; i++) ras[i] = Math.max(ras[i], cur[i]);
          l.raster = encodeRaster(ras, rows, cols);
        }
      });
      endHistoryGesture();
      showToast?.(t(toNew ? 'grid.importedNew' : 'grid.importedActive', cols, rows));
    },
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
    destroy() {
      ro?.disconnect();
      clearInterval(ants);
    },
  };
}
