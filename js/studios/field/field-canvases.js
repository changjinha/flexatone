/**
 * Flexatone — studios/field/field-canvases.js
 * Field Studio UI tier: main piano-roll / vector-field canvas and the baked-profile monitor.
 * 필드 스튜디오 UI: 메인 피아노롤/벡터장 캔버스와 베이킹 프로파일 모니터.
 *
 * Layer note / 계층 메모: lives in the studio folder (as requested) but is a UI-tier file —
 * only ui/studio-host.js imports it (through field-panels.js). It reads baked arrays and only
 * evaluates the field for the quiver arrows and the hover HUD (display, never audio).
 * UI 계층 파일: 화살표·HUD 표시용으로만 벡터장을 평가 (오디오에는 사용 안 함).
 *
 * Main canvas: piano-roll / 0–1 Norm grid, pitch-well lines, quiver arrows over the whole plot
 * (density / size / width from the view), guiding curve, baked trajectories (retrograde loops
 * highlighted), field-layer ranges (drag body = move, drag a corner = resize), draggable Force
 * Nodes of every layer, Local Regions (drag body = move, drag ◢ handle = resize), cue & playhead.
 * Nodes, layer ranges and regions all live in absolute (sec, MIDI).
 * Interaction: drag a node · drag empty space to pan · double-click to set the cue ·
 * wheel = time zoom (Shift = pitch zoom). / 노드 드래그 · 빈 곳 드래그 이동 · 더블클릭 큐 · 휠 줌
 * Monitor: Speed → Gain (green) and Curvature → Bright (rose, dashed) over the baked s-axis.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq, freqToMidi, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { VectorFieldPluginEngine, evalGuidingCurve, lookupBakedSample, hasRetrograde, particleFrame } from './vector-field-engine.js';
import { T_REF, P_REF, layerSdf } from './field-layers.js';
import { regionSdf, REGION_TARGETS } from './field-regions.js';
import { getFieldParams, editField, getActiveParticle, isParticleAudible, getBakedMap } from '../field-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate } from '../../ui/view-nav.js';
import { attachLocate, cueOrAudition } from '../../ui/locate-tool.js';
import { sizeCanvas } from '../../ui/canvas-size.js';

const PAD = { left: 52, right: 16, top: 16, bottom: 24 };
const NODE_COLORS = { attractor: '#10b981', repeller: '#f43f5e', vortex: '#a855f7' };
const LAYER_COLOR = '#a78bfa';
const BLACK = new Set([1, 3, 6, 8, 10]);


/** Coordinate system for the current field view. / 현재 보기의 좌표계 */
export function fieldMetrics(canvas, view) {
  const { dpr, w, h } = sizeCanvas(canvas);
  const m = { dpr, w, h, plotW: w - PAD.left - PAD.right, plotH: h - PAD.top - PAD.bottom, view };
  const tSpan = Math.max(0.1, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  m.timeToX = (sec) => PAD.left + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - PAD.left) / m.plotW) * tSpan;
  m.midiToY = (midi) => PAD.top + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - PAD.top) / m.plotH) * mSpan;
  m.normToScreen = (v, tn, yn) => {
    const px = m.timeToX(v.startTime + tn * v.duration);
    if (view.viewMode === 'norm') return { px, py: PAD.top + (1 - (yn + 0.25) / 1.5) * m.plotH };
    const f0 = midiToFreq(v.f0Midi);
    const f1 = midiToFreq(v.f1Midi);
    return { px, py: m.midiToY(freqToMidi(f0 * Math.pow(f1 / f0, yn))) };
  };
  m.screenToNorm = (v, px, py) => {
    const tn = clamp((m.xToTime(px) - v.startTime) / Math.max(0.05, v.duration), 0.02, 0.98);
    if (view.viewMode === 'norm') return { tn, yn: clamp((1 - (py - PAD.top) / m.plotH) * 1.5 - 0.25, -0.4, 1.4) };
    const f0 = midiToFreq(v.f0Midi);
    const f1 = midiToFreq(v.f1Midi);
    const yn = Math.log(midiToFreq(m.yToMidi(py)) / f0) / Math.max(1e-4, Math.log(f1 / f0));
    return { tn, yn: clamp(yn, -0.4, 1.4) };
  };
  /** Like screenToNorm but without the edge clamps (regions may sit anywhere). / 클램프 없는 변환 */
  m.screenToNormFree = (v, px, py) => {
    const tn = (m.xToTime(px) - v.startTime) / Math.max(0.05, v.duration);
    if (view.viewMode === 'norm') return { tn, yn: (1 - (py - PAD.top) / m.plotH) * 1.5 - 0.25 };
    const f0 = midiToFreq(v.f0Midi);
    const f1 = midiToFreq(v.f1Midi);
    return { tn, yn: Math.log(midiToFreq(m.yToMidi(py)) / f0) / Math.max(1e-4, Math.log(f1 / f0)) };
  };
  /** Absolute (sec, MIDI) ↔ screen. Norm view measures pitch in the active particle's y. / 절대 좌표 ↔ 화면 */
  m.absToScreen = (v, sec, midi) => {
    const px = m.timeToX(sec);
    if (view.viewMode === 'norm') {
      const fr = particleFrame(v);
      return { px, py: PAD.top + (1 - ((midi - fr.m0) / fr.span + 0.25) / 1.5) * m.plotH };
    }
    return { px, py: m.midiToY(midi) };
  };
  m.screenToAbs = (v, px, py) => {
    const sec = m.xToTime(px);
    if (view.viewMode === 'norm') {
      const fr = particleFrame(v);
      return { sec, midi: fr.m0 + ((1 - (py - PAD.top) / m.plotH) * 1.5 - 0.25) * fr.span };
    }
    return { sec, midi: m.yToMidi(py) };
  };
  m.inPlot = (p) => p.x >= PAD.left && p.x <= PAD.left + m.plotW && p.y >= PAD.top && p.y <= PAD.top + m.plotH;
  return m;
}

function drawGrid(ctx, m, params) {
  const view = params.view;
  if (view.viewMode === 'piano') {
    for (let midi = Math.floor(view.midiMin); midi <= Math.ceil(view.midiMax); midi++) {
      const pc = ((midi % 12) + 12) % 12;
      const yTop = m.midiToY(midi + 0.5);
      const yBot = m.midiToY(midi - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(PAD.left, yTop, m.plotW, Math.max(1, yBot - yTop));
      const g = params.wellGrid;
      const isWell = view.showWells && g !== 'none' && (g === '12tet' || g === '24tet' || (g === 'pentatonic' && [0, 2, 4, 7, 9].includes(pc)));
      ctx.strokeStyle = isWell ? 'rgba(245, 158, 11, 0.24)' : pc === 0 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(51, 65, 85, 0.3)';
      ctx.lineWidth = pc === 0 ? 1.1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(PAD.left, m.midiToY(midi));
      ctx.lineTo(PAD.left + m.plotW, m.midiToY(midi));
      ctx.stroke();
      if (view.showWells && g === '24tet') {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.12)';
        ctx.beginPath();
        ctx.moveTo(PAD.left, m.midiToY(midi + 0.5));
        ctx.lineTo(PAD.left + m.plotW, m.midiToY(midi + 0.5));
        ctx.stroke();
      }
    }
  } else {
    for (const ref of [0, 0.5, 1.0]) {
      const py = PAD.top + (1 - (ref + 0.25) / 1.5) * m.plotH;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + m.plotW, py);
      ctx.stroke();
    }
  }
  // Overtone wells of the active particle / 활성 입자의 배음 우물
  const v = getActiveParticle(params);
  if (view.showWells && params.wellGrid === 'overtone' && v && view.viewMode === 'piano') {
    const fund = Math.min(midiToFreq(v.f0Midi), midiToFreq(v.f1Midi));
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
    for (let n = 1; n <= 32; n++) {
      const y = m.midiToY(freqToMidi(fund * n));
      if (y < PAD.top || y > PAD.top + m.plotH) continue;
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(PAD.left + m.plotW, y);
      ctx.stroke();
    }
  }
}

/**
 * Arrows of F over the whole visible plot (as felt by the active particle).
 * view.arrowDensity = grid spacing (px), arrowSize = length scale, arrowWidth = line width.
 * 보이는 영역 전체에 F 화살표 (밀도 = 격자 간격 px, 크기, 굵기).
 */
function drawQuiver(ctx, m, params, v) {
  const view = params.view;
  const gap = clamp(Number(view.arrowDensity) || 34, 12, 120);
  const size = clamp(Number(view.arrowSize) || 1, 0.2, 4);
  const width = clamp(Number(view.arrowWidth) || 1.1, 0.3, 6);
  const fr = particleFrame(v);
  const tSpan = Math.max(0.1, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  const pxPerSec = m.plotW / tSpan;
  const pxPerMidi = view.viewMode === 'norm' ? m.plotH / 1.5 / Math.abs(fr.span) : m.plotH / mSpan;
  const head = clamp(2.5 + width * 1.6, 3, 14);
  ctx.save();
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  for (let px = PAD.left + gap / 2; px < PAD.left + m.plotW; px += gap) {
    for (let py = PAD.top + gap / 2; py < PAD.top + m.plotH; py += gap) {
      const abs = m.screenToAbs(v, px, py);
      const tn = (abs.sec - fr.start) / fr.dur;
      const yn = (abs.midi - fr.m0) / fr.span;
      const vec = VectorFieldPluginEngine.evaluateFieldAt(tn, yn, v, params, params.guiding, []);
      // particle-frame velocity → absolute (s, semitone) → screen direction / 화면 방향
      const dSec = vec.vt * fr.dur;
      const dMidi = vec.vy * fr.span;
      const sx = dSec * pxPerSec;
      const sy = -dMidi * pxPerMidi * Math.sign(view.viewMode === 'norm' ? fr.span : 1);
      if (Math.hypot(sx, sy) < 1e-9) continue;
      const ang = Math.atan2(sy, sx);
      const mag = clamp(Math.hypot(dSec / T_REF, dMidi / P_REF), 0, 3);
      const len = gap * 0.62 * size * clamp(0.3 + mag * 0.35, 0.3, 1.25);
      ctx.strokeStyle = `rgba(167, 139, 250, ${clamp(0.2 + mag * 0.18, 0.2, 0.62)})`;
      ctx.beginPath();
      const x0 = px - Math.cos(ang) * len * 0.45;
      const y0 = py - Math.sin(ang) * len * 0.45;
      const tx = px + Math.cos(ang) * len * 0.55;
      const ty = py + Math.sin(ang) * len * 0.55;
      ctx.moveTo(x0, y0);
      ctx.lineTo(tx, ty);
      const h = Math.min(head, len * 0.6);
      ctx.moveTo(tx - h * Math.cos(ang - 0.5), ty - h * Math.sin(ang - 0.5));
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - h * Math.cos(ang + 0.5), ty - h * Math.sin(ang + 0.5));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Trace a layer's range (box / ellipse) grown by `grow` field units. / 레이어 범위 외곽 */
function traceLayer(ctx, m, v, L, grow = 0) {
  const r = L.range;
  const cs = (r.t0 + r.t1) / 2;
  const cm = (r.m0 + r.m1) / 2;
  const hw = Math.abs(r.t1 - r.t0) / 2 + grow * T_REF;
  const hh = Math.abs(r.m1 - r.m0) / 2 + grow * P_REF;
  traceShape(ctx, m, v, L.shape, cs, cm, hw, hh);
}

/** Box / ellipse outline in absolute coords, sampled so log / norm mappings stay exact. */
function traceShape(ctx, m, v, shape, cs, cm, hw, hh) {
  ctx.beginPath();
  if (shape === 'ellipse') {
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const sc = m.absToScreen(v, cs + hw * Math.cos(a), cm + hh * Math.sin(a));
      if (i === 0) ctx.moveTo(sc.px, sc.py);
      else ctx.lineTo(sc.px, sc.py);
    }
  } else {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c];
      const [bx, by] = corners[c + 1];
      for (let i = 0; i <= 8; i++) {
        const u = i / 8;
        const sc = m.absToScreen(v, cs + hw * (ax + (bx - ax) * u), cm + hh * (ay + (by - ay) * u));
        if (c === 0 && i === 0) ctx.moveTo(sc.px, sc.py);
        else ctx.lineTo(sc.px, sc.py);
      }
    }
  }
  ctx.closePath();
}

/** Corner handles of a layer range: lo = (t0, m0), hi = (t1, m1). / 범위 모서리 핸들 */
function layerHandles(m, v, L) {
  const r = L.range;
  return {
    lo: m.absToScreen(v, Math.min(r.t0, r.t1), Math.min(r.m0, r.m1)),
    hi: m.absToScreen(v, Math.max(r.t0, r.t1), Math.max(r.m0, r.m1)),
  };
}

function drawLayers(ctx, m, params, v) {
  const layers = params.layers || [];
  layers.forEach((L, idx) => {
    if (L.range?.full !== false) return;
    const on = L.id === params.activeLayerId;
    const off = L.enabled === false;
    ctx.save();
    ctx.globalAlpha = off ? 0.3 : on ? 1 : 0.6;
    traceLayer(ctx, m, v, L);
    ctx.fillStyle = L.invert ? 'rgba(167, 139, 250, 0.02)' : on ? 'rgba(167, 139, 250, 0.09)' : 'rgba(167, 139, 250, 0.04)';
    ctx.fill();
    ctx.strokeStyle = LAYER_COLOR;
    ctx.lineWidth = on ? 2 : 1.2;
    ctx.setLineDash(on ? [] : [6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    if ((L.feather || 0) > 1e-3) {
      traceLayer(ctx, m, v, L, L.feather);
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.5)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const hd = layerHandles(m, v, L);
    const amt = L.mode === 'replace' ? '' : ` ${(L.amount ?? 1) >= 0 ? '+' : ''}${Number((L.amount ?? 1).toFixed(2))}`;
    const tag = `${idx + 1}. ${L.id === 'fl_main' ? t('field.layer.main') : (L.name || t('field.layer'))} · ${t(`field.layer.mode.${L.mode || 'add'}`)}${amt}${L.invert ? ' · INV' : ''}${(L.feather || 0) <= 1e-3 ? ' · HARD' : ''}`;
    ctx.fillStyle = LAYER_COLOR;
    ctx.font = 'bold 9.5px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(tag, Math.min(hd.lo.px, hd.hi.px) + 4, Math.min(hd.lo.py, hd.hi.py) + 11);
    if (on) {
      for (const h of [hd.lo, hd.hi]) {
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = LAYER_COLOR;
        ctx.lineWidth = 1.6;
        ctx.fillRect(h.px - 5, h.py - 5, 10, 10);
        ctx.strokeRect(h.px - 5, h.py - 5, 10, 10);
      }
    }
    ctx.restore();
  });
}

const REGION_COLOR = '#22d3ee';
const REGION_TAGS = { guide: 'G', nodes: 'N', turb: 'T', wells: 'W' };

/** Trace a region outline grown by `grow` field units. / 영역 외곽 경로 */
function traceRegion(ctx, m, v, r, grow = 0) {
  traceShape(ctx, m, v, r.shape, r.x, r.y, Math.max(1e-3, r.w + grow * T_REF), Math.max(1e-3, r.h + grow * P_REF));
}

/** Screen position of a region's resize handle (top-right). / 크기 조절 핸들 위치 */
function regionHandle(m, v, r) {
  const k = r.shape === 'ellipse' ? Math.SQRT1_2 : 1;
  return m.absToScreen(v, r.x + r.w * k, r.y + r.h * k);
}

function drawRegions(ctx, m, params, v, activeId) {
  for (const r of params.regions || []) {
    const on = r.id === activeId;
    const off = r.enabled === false;
    ctx.save();
    ctx.globalAlpha = off ? 0.35 : 1;
    traceRegion(ctx, m, v, r);
    ctx.fillStyle = r.invert ? 'rgba(34, 211, 238, 0.03)' : on ? 'rgba(34, 211, 238, 0.10)' : 'rgba(34, 211, 238, 0.05)';
    ctx.fill();
    ctx.strokeStyle = REGION_COLOR;
    ctx.lineWidth = on ? 2 : 1.2;
    ctx.stroke();
    if ((r.feather || 0) > 1e-3) {
      traceRegion(ctx, m, v, r, r.feather);
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.45)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const c = m.absToScreen(v, r.x, r.y);
    // Local flow arrow / 국소 흐름 화살표
    if (Math.abs(r.flowStrength || 0) > 1e-3) {
      const a = ((r.flowAngle || 0) * Math.PI) / 180;
      const sgn = Math.sign(r.flowStrength);
      const len = clamp(14 + Math.abs(r.flowStrength) * 12, 14, 48);
      const probe = m.absToScreen(v, r.x + 0.04 * T_REF * Math.cos(a) * sgn, r.y + 0.04 * P_REF * Math.sin(a) * sgn);
      const ang = Math.atan2(probe.py - c.py, probe.px - c.px);
      const tx = c.px + Math.cos(ang) * len;
      const ty = c.py + Math.sin(ang) * len;
      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(c.px, c.py);
      ctx.lineTo(tx, ty);
      ctx.lineTo(tx - 6 * Math.cos(ang - 0.45), ty - 6 * Math.sin(ang - 0.45));
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 6 * Math.cos(ang + 0.45), ty - 6 * Math.sin(ang + 0.45));
      ctx.stroke();
    }
    // Modifier label: only components that differ from ×1 / ×1이 아닌 성분만 표시
    const g = r.gain || {};
    const tags = REGION_TARGETS.filter((k) => Math.abs((g[k] ?? 1) - 1) > 1e-3).map((k) => `${REGION_TAGS[k]}×${Number((g[k] ?? 1).toFixed(2))}`);
    if (r.invert) tags.unshift('INV');
    if (off) tags.unshift('OFF');
    ctx.fillStyle = REGION_COLOR;
    ctx.font = 'bold 9.5px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(tags.join(' ') || t('field.region'), c.px, c.py - 6);
    if (on) {
      const hd = regionHandle(m, v, r);
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = REGION_COLOR;
      ctx.lineWidth = 1.6;
      ctx.fillRect(hd.px - 5, hd.py - 5, 10, 10);
      ctx.strokeRect(hd.px - 5, hd.py - 5, 10, 10);
    }
    ctx.restore();
  }
}

/**
 * Create the Field canvases inside `els` = { main, monitor, hud: { time, note, hz, vec, retro } }.
 * @returns {{ render: () => void, destroy: () => void }}
 */
export function createFieldCanvases(els, { requestRender }) {
  const mainCtx = els.main.getContext('2d');
  const monCtx = els.monitor.getContext('2d');
  let drag = null; // { type: 'node' | 'region-move' | 'region-size', id, ... } | { type: 'pan', x, y, view }
  let hover = null;

  const pos = (e) => {
    const r = els.main.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * els.main.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * els.main.clientHeight };
  };

  // Shared Locate tool (ui/locate-tool.js): drag a particle's trajectory = move start time and
  // F₀/F₁ together; drag its start / end dot = move that end (time + F₀ or F₁).
  // 공용 이동 도구: 궤적 드래그 = 시작 시간·F₀/F₁ 함께 이동, 시작/끝 점 = 그 끝의 시간·음고
  const r3 = (x) => Number(x.toFixed(3));
  const clampMidi = (x) => Number(clamp(x, 21, 108).toFixed(2));
  const locate = attachLocate(els.main, {
    items() {
      const params = getFieldParams();
      const m = fieldMetrics(els.main, params.view);
      const baked = getBakedMap(params);
      return params.voices.map((pv) => {
        const pts = baked.get(pv.id) || [];
        const poly = [];
        for (let i = 0; i < pts.length; i += 3) { const q = m.normToScreen(pv, pts[i].t, pts[i].y); poly.push({ x: q.px, y: q.py }); }
        const a = m.normToScreen(pv, 0, 0);
        const b = m.normToScreen(pv, 1, 1);
        return { id: pv.id, color: pv.color, poly, start: { x: a.px, y: a.py }, end: { x: b.px, y: b.py } };
      });
    },
    toWorld(p) {
      const params = getFieldParams();
      const m = fieldMetrics(els.main, params.view);
      const a = m.screenToAbs(getActiveParticle(params), p.x, p.y);
      return { sec: a.sec, midi: params.view.viewMode === 'piano' ? a.midi : null };
    },
    begin: (id) => ({ ...getFieldParams().voices.find((x) => x.id === id) }),
    startOf: (id) => getFieldParams().voices.find((x) => x.id === id)?.startTime,
    select(id) { if (getFieldParams().activeVoiceId !== id) editField((d) => { d.activeVoiceId = id; }, { history: false }); },
    apply(id, kind, w) {
      const o = w.orig;
      editField((d) => {
        const v = d.voices.find((x) => x.id === id);
        if (!v) return;
        if (kind === 'move') {
          v.startTime = r3(Math.max(0, w.snapTime(o.startTime + w.dSec)));
          if (w.midi != null) { v.f0Midi = clampMidi(o.f0Midi + w.dSemi); v.f1Midi = clampMidi(o.f1Midi + w.dSemi); }
        } else if (kind === 'start') {
          const end = o.startTime + o.duration;
          v.startTime = r3(clamp(w.sec, 0, end - 0.1));
          v.duration = r3(end - v.startTime);
          if (w.midi != null) v.f0Midi = clampMidi(w.midi);
        } else {
          v.duration = r3(Math.max(0.1, w.sec - o.startTime));
          if (w.midi != null) v.f1Midi = clampMidi(w.midi);
        }
      }, { coalesceKey: `field-locate-${kind}` });
    },
  });

  function renderMain() {
    const params = getFieldParams();
    const view = params.view;
    const m = fieldMetrics(els.main, view);
    const ctx = mainCtx;
    const v = getActiveParticle(params);
    const baked = getBakedMap(params);
    ctx.setTransform(m.dpr, 0, 0, m.dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, m.w, m.h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    drawGrid(ctx, m, params);
    // Vector field OFF → no arrows / regions / nodes: only the pure glissando shape / 벡터장 OFF → 순수 글리산도만
    const fieldOn = params.fieldEnabled !== false;
    if (fieldOn && view.showArrows && v) drawQuiver(ctx, m, params, v);
    if (fieldOn && view.showLayers !== false && v) drawLayers(ctx, m, params, v);
    if (fieldOn && view.showRegions !== false && v) drawRegions(ctx, m, params, v, params.activeRegionId);

    if (view.showGuide && v) {
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.42)';
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let i = 0; i <= 80; i++) {
        const tn = i / 80;
        const pt = m.normToScreen(v, tn, evalGuidingCurve(tn, params.guiding));
        if (i === 0) ctx.moveTo(pt.px, pt.py);
        else ctx.lineTo(pt.px, pt.py);
      }
      ctx.stroke();
      ctx.restore();
    }

    let retro = false;
    for (const pv of params.voices) {
      const pts = baked.get(pv.id) || [];
      if (!pts.length) continue;
      const isAct = v && pv.id === v.id;
      ctx.save();
      ctx.globalAlpha = isParticleAudible(pv, params) ? (isAct ? 1 : 0.55) : 0.22;
      ctx.strokeStyle = pv.color;
      ctx.lineWidth = isAct ? 3 : 1.8;
      if (isAct) { ctx.shadowColor = pv.color; ctx.shadowBlur = 8; }
      ctx.beginPath();
      pts.forEach((p, i) => {
        const sc = m.normToScreen(pv, p.t, p.y);
        if (i === 0) ctx.moveTo(sc.px, sc.py);
        else ctx.lineTo(sc.px, sc.py);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (isAct) {
        // Retrograde loops (time running backwards) in magenta / 시간 역행 구간 강조
        ctx.strokeStyle = '#e879f9';
        ctx.lineWidth = 3.4;
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].t < pts[i - 1].t - 1e-5) {
            retro = true;
            const s0 = m.normToScreen(pv, pts[i - 1].t, pts[i - 1].y);
            const s1 = m.normToScreen(pv, pts[i].t, pts[i].y);
            ctx.beginPath();
            ctx.moveTo(s0.px, s0.py);
            ctx.lineTo(s1.px, s1.py);
            ctx.stroke();
          }
        }
      }
      const p0 = m.normToScreen(pv, pts[0].t, pts[0].y);
      ctx.fillStyle = '#0f172a';
      ctx.strokeStyle = pv.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p0.px, p0.py, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pv.color;
      ctx.font = 'bold 10px Inter, sans-serif';
      ctx.fillText(pv.name, p0.px + 7, p0.py - 5);
      ctx.restore();
    }
    els.hud.retro?.classList.toggle('hidden', !retro);
    locate.draw(ctx, v?.id);

    if (v && fieldOn) {
      for (const layer of params.layers || []) for (const node of layer.nodes || []) {
        const sc = m.absToScreen(v, node.sec, node.midi);
        const col = NODE_COLORS[node.type] || '#a855f7';
        const on = drag?.type === 'node' && drag.id === node.id;
        ctx.save();
        ctx.globalAlpha = layer.enabled === false ? 0.25 : layer.id === params.activeLayerId ? 1 : 0.5;
        ctx.strokeStyle = col;
        ctx.fillStyle = `${col}22`;
        ctx.lineWidth = on ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.arc(sc.px, sc.py, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#0f172a';
        ctx.beginPath();
        ctx.arc(sc.px, sc.py, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.font = 'bold 9.5px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(t(`field.node.${node.type}`).toUpperCase(), sc.px, sc.py - 10);
        ctx.restore();
      }
    }

    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    const tr = appState.transport;
    drawCueLine(ctx, m.timeToX(tr.cueSec), PAD.top, PAD.top + m.plotH);
    if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(tr.playheadSec), PAD.top, PAD.top + m.plotH);
    ctx.restore();

    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (view.viewMode === 'piano') {
      for (let midi = Math.ceil(view.midiMin); midi <= Math.floor(view.midiMax); midi++) {
        if (((midi % 12) + 12) % 12 !== 0) continue;
        const py = m.midiToY(midi);
        if (py < PAD.top + 8 || py > PAD.top + m.plotH - 8) continue;
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(midiToNoteName(midi), PAD.left - 6, py);
      }
    } else {
      ctx.fillStyle = '#94a3b8';
      for (const r of [0, 0.5, 1.0]) ctx.fillText(r.toFixed(1), PAD.left - 6, PAD.top + (1 - (r + 0.25) / 1.5) * m.plotH);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#94a3b8';
    const span = view.tMax - view.tMin;
    const step = span > 12 ? 2 : span > 5 ? 1 : 0.5;
    for (let s = Math.ceil(view.tMin / step) * step; s <= view.tMax; s += step) {
      const px = m.timeToX(s);
      if (px < PAD.left + 12 || px > PAD.left + m.plotW - 12) continue;
      ctx.fillText(`${s.toFixed(1)}s`, px, PAD.top + m.plotH + 6);
    }

    if (hover && v && m.inPlot(hover)) {
      const norm = m.screenToNormFree(v, hover.x, hover.y);
      const vec = VectorFieldPluginEngine.evaluateFieldAt(norm.tn, norm.yn, v, params, params.guiding, []);
      const hz = view.viewMode === 'piano' ? midiToFreq(m.yToMidi(hover.y)) : midiToFreq(v.f0Midi) * Math.pow(midiToFreq(v.f1Midi) / midiToFreq(v.f0Midi), norm.yn);
      if (els.hud.time) els.hud.time.textContent = `${m.xToTime(hover.x).toFixed(2)}s`;
      if (els.hud.note) els.hud.note.textContent = midiToNoteName(freqToMidi(hz));
      if (els.hud.hz) els.hud.hz.textContent = `${hz.toFixed(1)} Hz`;
      if (els.hud.vec) els.hud.vec.textContent = fieldOn ? `(${vec.vt.toFixed(2)}, ${vec.vy.toFixed(2)})` : 'off';
    }
  }

  function renderMonitor() {
    const { dpr, w, h } = sizeCanvas(els.monitor);
    const ctx = monCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    const params = getFieldParams();
    const v = getActiveParticle(params);
    const pts = v ? getBakedMap(params).get(v.id) : null;
    if (!pts || !pts.length) return;
    const pL = 40;
    const pR = 16;
    const pT = 12;
    const pB = 18;
    const pw = w - pL - pR;
    const ph = h - pT - pB;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const g = clamp(1 - v.speedToGain * 0.65 + v.speedToGain * p.normSpeed, 0, 1);
      const x = pL + p.s * pw;
      const y = pT + (1 - g) * ph;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = pL + p.s * pw;
      const y = pT + (1 - p.normCurv * v.curvToBright) * ph;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(pL, pT, pw, ph);
    ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', pL - 6, pT);
    ctx.fillText('0', pL - 6, pT + ph);
    // Playhead on the s-axis / s축 플레이헤드
    const tr = appState.transport;
    if (tr.playing && tr.playheadSec >= v.startTime && tr.playheadSec <= v.startTime + v.duration) {
      const x = pL + ((tr.playheadSec - v.startTime) / v.duration) * pw;
      ctx.strokeStyle = '#f8fafc';
      ctx.beginPath();
      ctx.moveTo(x, pT);
      ctx.lineTo(x, pT + ph);
      ctx.stroke();
      const s = lookupBakedSample(v, pts, (tr.playheadSec - v.startTime) / v.duration);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#10b981';
      ctx.fillText(`g ${s.gainMod.toFixed(2)}`, x + 4, pT + 8);
    }
  }

  /** Node under the pointer (active layer first, then top → bottom). / 포인터 아래 노드 */
  function hitNode(p, m, params, v) {
    if (params.fieldEnabled === false) return null;
    const layers = [...(params.layers || [])].reverse().sort((a, b) => (b.id === params.activeLayerId) - (a.id === params.activeLayerId));
    for (const layer of layers) {
      if (layer.enabled === false) continue;
      for (const node of layer.nodes || []) {
        const sc = m.absToScreen(v, node.sec, node.midi);
        if (Math.hypot(p.x - sc.px, p.y - sc.py) < 20) return { node, layer };
      }
    }
    return null;
  }

  /** Active layer's corner handle, then the topmost layer range under the pointer. / 레이어 범위 */
  function hitLayer(p, m, params, v) {
    if (params.fieldEnabled === false || params.view.showLayers === false) return null;
    const layers = params.layers || [];
    const act = layers.find((L) => L.id === params.activeLayerId);
    if (act && act.range?.full === false) {
      const hd = layerHandles(m, v, act);
      for (const k of ['lo', 'hi']) if (Math.abs(p.x - hd[k].px) < 9 && Math.abs(p.y - hd[k].py) < 9) return { layer: act, part: k };
    }
    const abs = m.screenToAbs(v, p.x, p.y);
    const inside = layers.filter((L) => L.enabled !== false && L.range?.full === false && layerSdf(L, abs.sec, abs.midi) <= 0);
    const L = inside.find((x) => x.id === params.activeLayerId) || inside[inside.length - 1];
    return L ? { layer: L, part: 'move', abs } : null;
  }

  /** Region under the pointer: active region's handle first, then bodies (active wins). */
  function hitRegion(p, m, params, v) {
    if (params.view.showRegions === false || params.fieldEnabled === false) return null;
    const regions = params.regions || [];
    const act = regions.find((r) => r.id === params.activeRegionId);
    if (act) {
      const hd = regionHandle(m, v, act);
      if (Math.abs(p.x - hd.px) < 9 && Math.abs(p.y - hd.py) < 9) return { region: act, part: 'size' };
    }
    const abs = m.screenToAbs(v, p.x, p.y);
    const inside = regions.filter((r) => regionSdf(r, abs.sec, abs.midi) <= 0);
    const r = inside.find((x) => x.id === params.activeRegionId) || inside[inside.length - 1];
    return r ? { region: r, part: 'move', abs } : null;
  }

  const onDown = (e) => {
    if (e.button !== 0) return;
    const params = getFieldParams();
    const v = getActiveParticle(params);
    const m = fieldMetrics(els.main, params.view);
    const p = pos(e);
    try { els.main.setPointerCapture?.(e.pointerId); } catch { /* synthetic / inactive pointer */ }
    const nh = v && hitNode(p, m, params, v);
    if (nh) {
      if (nh.layer.id !== params.activeLayerId) editField((d) => { d.activeLayerId = nh.layer.id; }, { history: false });
      drag = { type: 'node', id: nh.node.id };
      return;
    }
    const lh = v && hitLayer(p, m, params, v);
    if (lh && lh.part !== 'move') { drag = { type: 'layer-corner', id: lh.layer.id, corner: lh.part }; return; }
    const hit = v && hitRegion(p, m, params, v);
    if (hit) {
      if (hit.region.id !== params.activeRegionId) editField((d) => { d.activeRegionId = hit.region.id; }, { history: false });
      drag = hit.part === 'size'
        ? { type: 'region-size', id: hit.region.id }
        : { type: 'region-move', id: hit.region.id, dx: hit.region.x - hit.abs.sec, dy: hit.region.y - hit.abs.midi };
      return;
    }
    if (lh) {
      if (lh.layer.id !== params.activeLayerId) editField((d) => { d.activeLayerId = lh.layer.id; }, { history: false });
      drag = { type: 'layer-move', id: lh.layer.id, sec: lh.abs.sec, midi: lh.abs.midi, range: { ...lh.layer.range } };
      return;
    }
    drag = { type: 'pan', x: p.x, y: p.y, view: { ...params.view } };
  };
  const onMove = (e) => {
    const p = pos(e);
    hover = p;
    if (!drag) { requestRender(['field']); return; }
    const params = getFieldParams();
    const m = fieldMetrics(els.main, params.view);
    if (drag.type === 'node') {
      const v = getActiveParticle(params);
      const abs = m.screenToAbs(v, p.x, p.y);
      // Each move re-bakes (edit-time) and merges into one undo step / 이동마다 재베이킹, 실행 취소 1단계
      editField((d) => {
        for (const L of d.layers || []) {
          const n = (L.nodes || []).find((x) => x.id === drag.id);
          if (n) { n.sec = Number(Math.max(0, abs.sec).toFixed(3)); n.midi = Number(clamp(abs.midi, 0, 127).toFixed(2)); }
        }
      }, { coalesceKey: 'field-node-drag' });
    } else if (drag.type === 'layer-move' || drag.type === 'layer-corner') {
      const v = getActiveParticle(params);
      const abs = m.screenToAbs(v, p.x, p.y);
      const d0 = drag;
      editField((d) => {
        const L = (d.layers || []).find((x) => x.id === d0.id);
        if (!L) return;
        const r = L.range;
        if (d0.type === 'layer-move') {
          const ds = Math.max(-Math.min(d0.range.t0, d0.range.t1), abs.sec - d0.sec);
          const dm = abs.midi - d0.midi;
          r.t0 = Number((d0.range.t0 + ds).toFixed(3));
          r.t1 = Number((d0.range.t1 + ds).toFixed(3));
          r.m0 = Number((d0.range.m0 + dm).toFixed(2));
          r.m1 = Number((d0.range.m1 + dm).toFixed(2));
        } else {
          // lo corner = (min t, min midi), hi corner = (max t, max midi) / 모서리 드래그
          const lo = d0.corner === 'lo';
          const tA = Math.min(r.t0, r.t1);
          const tB = Math.max(r.t0, r.t1);
          const mA = Math.min(r.m0, r.m1);
          const mB = Math.max(r.m0, r.m1);
          if (lo) {
            r.t0 = Number(clamp(abs.sec, 0, tB - 0.05).toFixed(3)); r.t1 = tB;
            r.m0 = Number(clamp(abs.midi, 0, mB - 0.5).toFixed(2)); r.m1 = mB;
          } else {
            r.t0 = tA; r.t1 = Number(Math.max(tA + 0.05, abs.sec).toFixed(3));
            r.m0 = mA; r.m1 = Number(clamp(abs.midi, mA + 0.5, 127).toFixed(2));
          }
        }
      }, { coalesceKey: 'field-layer-drag' });
    } else if (drag.type === 'region-move' || drag.type === 'region-size') {
      const v = getActiveParticle(params);
      const abs = m.screenToAbs(v, p.x, p.y);
      const d0 = drag;
      editField((d) => {
        const r = (d.regions || []).find((x) => x.id === d0.id);
        if (!r) return;
        if (d0.type === 'region-move') {
          r.x = Number(Math.max(0, abs.sec + d0.dx).toFixed(3));
          r.y = Number(clamp(abs.midi + d0.dy, 0, 127).toFixed(2));
        } else {
          const k = r.shape === 'ellipse' ? Math.SQRT1_2 : 1;
          r.w = Number(clamp(Math.abs(abs.sec - r.x) / k, 0.05, 30).toFixed(3));
          r.h = Number(clamp(Math.abs(abs.midi - r.y) / k, 0.25, 60).toFixed(2));
        }
      }, { coalesceKey: 'field-region-drag' });
    } else {
      const vp = drag.view;
      const tSpan = vp.tMax - vp.tMin;
      const mSpan = vp.midiMax - vp.midiMin;
      const tMin = Math.max(0, vp.tMin - ((p.x - drag.x) / m.plotW) * tSpan);
      const midiMin = clamp(vp.midiMin + ((p.y - drag.y) / m.plotH) * mSpan, 12, 120 - mSpan);
      editField((d) => { Object.assign(d.view, { tMin, tMax: tMin + tSpan, midiMin, midiMax: midiMin + mSpan }); }, { history: false });
    }
  };
  const onUp = (e) => {
    if (drag && drag.type !== 'pan') endHistoryGesture();
    drag = null;
    try { els.main.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['field']);
  };
  const onDbl = (e) => {
    const params = getFieldParams();
    const m = fieldMetrics(els.main, params.view);
    cueOrAudition(e, Math.max(0, Number(m.xToTime(pos(e).x).toFixed(2))));
  };
  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // 공용 휠 문법: 휠 = 음고, Shift = 시간, Ctrl/⌘ = 포인터 기준 줌
  const onWheel = (e) => {
    e.preventDefault();
    const m = fieldMetrics(els.main, getFieldParams().view);
    const p = pos(e);
    editField((d) => wheelNavigate(e, d.view, m, p), { history: false });
  };
  const onLeave = () => { hover = null; requestRender(['field']); };

  els.main.addEventListener('pointerdown', onDown);
  els.main.addEventListener('pointermove', onMove);
  els.main.addEventListener('pointerup', onUp);
  els.main.addEventListener('pointercancel', onUp);
  els.main.addEventListener('pointerleave', onLeave);
  els.main.addEventListener('dblclick', onDbl);
  els.main.addEventListener('wheel', onWheel, { passive: false });
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['field'])) : null;
  ro?.observe(els.main);
  ro?.observe(els.monitor);

  return {
    render() {
      renderMain();
      renderMonitor();
    },
    destroy() {
      ro?.disconnect();
      locate.destroy();
    },
    hasRetrograde: () => {
      const params = getFieldParams();
      const v = getActiveParticle(params);
      return v ? hasRetrograde(getBakedMap(params).get(v.id)) : false;
    },
  };
}
