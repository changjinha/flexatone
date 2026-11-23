/**
 * Flexatone — studios/space/space-canvases.js
 * Space Studio UI tier: top-view scene, observed-pitch piano roll and gain / pan / r lanes.
 * 스페이스 스튜디오 UI: 상단 시점 장면, 관측 음고 피아노롤, 게인·팬·거리 레인.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder — only space-panels.js imports it.
 * It reads baked arrays; the only physics it evaluates is display geometry (source position at the
 * playhead, wavefront ring centres X(t − kΔ)), never audio.
 * 베이킹 배열을 읽고, 표시용 기하(재생헤드 위치, 파면 링 중심)만 계산.
 *
 * Scene interaction (tool Move): drag the listener · drag its nose to turn the heading · drag the
 * active source's handles · click a source to select it · drag empty space to pan · wheel = zoom.
 * Tool Draw: drag a freehand path for the active source (resampled to ≤ 64 points).
 * Time canvases: double-click sets the cue (shared transport).
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { freqToMidi, midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import {
  getKinematics, trajectoryPolyline, wavefrontRings, pathHandles, applyHandleDrag, resampleStroke,
  sampleBake, pathLength, effectiveC, MAX_RINGS, MAX_DRAW_POINTS,
} from './space-engine.js';
import { getSpaceParams, editSpace, getActiveSource, isSourceAudible, getSpaceBake } from '../space-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, zoomViewTime, zoomViewPitch } from '../../ui/view-nav.js';
import { attachLocate, cueOrAudition } from '../../ui/locate-tool.js';
import { sizeCanvas2d } from '../../ui/canvas-size.js';

const PAD = { left: 52, right: 12, top: 10, bottom: 20 };
const BLACK = new Set([1, 3, 6, 8, 10]);
const FONT = '11px ui-monospace, Menlo, monospace';


/** World (m) ↔ screen (px) for the scene view. / 장면 좌표계 */
export function sceneMetrics(w, h, view) {
  const k = w / Math.max(5, view.span);
  return {
    k, w, h,
    wx: (x) => w / 2 + (x - view.cx) * k,
    wy: (y) => h / 2 - (y - view.cy) * k,
    sx: (px) => view.cx + (px - w / 2) / k,
    sy: (py) => view.cy - (py - h / 2) / k,
  };
}

/** Listener time shown on the scene: playhead while playing, else the cue. / 표시 시각 */
export function sceneTime() {
  const tr = appState.transport;
  return tr.playing && tr.playheadSec >= 0 ? tr.playheadSec : tr.cueSec;
}

function niceStep(pxPerUnit, minPx) {
  for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * pxPerUnit >= minPx) return s;
  return 2000;
}

function arrow(ctx, x0, y0, x1, y1, col, width = 1.6) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 2) return;
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 7 * Math.cos(a - 0.4), y1 - 7 * Math.sin(a - 0.4));
  ctx.lineTo(x1 - 7 * Math.cos(a + 0.4), y1 - 7 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Time axis shared by the observed-pitch and lane canvases. / 공용 시간축 */
function timeAxis(w, length, vw = null) {
  const plotW = w - PAD.left - PAD.right;
  const full = Math.max(0.5, length);
  // vw = the shared zoom / scroll view of the time canvases (null = whole piece) / 시간 캔버스 공용 뷰
  const tMin = vw ? vw.tMin : 0;
  const span = vw ? Math.max(1e-6, vw.tMax - vw.tMin) : full;
  return { plotW, tMin, tMax: tMin + span, frac: span / full, timeToX: (s) => PAD.left + ((s - tMin) / span) * plotW, xToTime: (px) => tMin + ((px - PAD.left) / plotW) * span };
}

const rangeCache = new WeakMap();
/** MIDI range covering every f_obs / f_s of a bake (cached per bake). / 음고 표시 범위 */
function pitchRange(bake) {
  let r = rangeCache.get(bake);
  if (r) return r;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bake.sources.values()) { lo = Math.min(lo, b.fMin); hi = Math.max(hi, b.fMax); }
  if (!Number.isFinite(lo)) { lo = 220; hi = 880; }
  let mLo = freqToMidi(lo) - 1.5;
  let mHi = freqToMidi(hi) + 1.5;
  if (mHi - mLo < 4) { const c = 0.5 * (mLo + mHi); mLo = c - 2; mHi = c + 2; }
  r = { mLo, mHi };
  rangeCache.set(bake, r);
  return r;
}

function drawCueAndPlayhead(ctx, ax, top, bottom) {
  // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
  const tr = appState.transport;
  drawCueLine(ctx, ax.timeToX(tr.cueSec), top, bottom);
  if (tr.playing && tr.playheadSec >= 0) drawPlayheadLine(ctx, ax.timeToX(tr.playheadSec), top, bottom);
}

/** Polyline of a baked array against listener time, decimated to ~1 point / px. / 감축 폴리라인 */
function plotSeries(ctx, b, key, ax, toY, plotW) {
  const step = Math.max(1, Math.floor((b.n * (ax.frac || 1)) / Math.max(50, plotW)));
  ctx.beginPath();
  for (let i = 0; i < b.n; i += step) {
    const x = ax.timeToX(b.t[i]);
    const y = toY(b[key][i]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineTo(ax.timeToX(b.t[b.n - 1]), toY(b[key][b.n - 1]));
  ctx.stroke();
}

export function createSpaceCanvases(els, { requestRender }) {
  // Zoom / scroll of the time canvases (shared view-nav). UI-local: null = whole piece / fitted pitch.
  // 시간 캔버스 줌·스크롤 (공용 view-nav). UI 지역 상태: null = 전체 길이 / 자동 음고 범위
  let timeView = null; // { tMin, tMax }
  let obsPitch = null; // { midiMin, midiMax }
  let obsAuto = { midiMin: 48, midiMax: 84 };
  let obsM = null;
  let obsPolys = new Map(); // source id → [{x, y}] observed-pitch polyline of the last render / 관측 음고 폴리라인
  let lanesM = null;
  const tv = (doc) => {
    if (timeView && (timeView.tMax > Math.max(0.5, doc.length) + 1e-6 || timeView.tMax - timeView.tMin < 0.02)) timeView = null;
    return timeView;
  };
  const navView = (doc) => {
    const v = tv(doc);
    return { tMin: v ? v.tMin : 0, tMax: v ? v.tMax : Math.max(0.5, doc.length), midiMin: (obsPitch || obsAuto).midiMin, midiMax: (obsPitch || obsAuto).midiMax };
  };
  const navLimits = (doc) => ({ tHi: Math.max(0.5, doc.length), maxTimeSpan: Math.max(0.5, doc.length), minTimeSpan: 0.05, minPitchSpan: 1 });
  const setNavView = (nv, before) => {
    timeView = { tMin: nv.tMin, tMax: nv.tMax };
    if (before !== `${nv.midiMin}|${nv.midiMax}`) obsPitch = { midiMin: nv.midiMin, midiMax: nv.midiMax };
    requestRender(['space']);
  };
  let drag = null;
  let stroke = null;
  const pos = (e, c) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // ---------------------------------------------------------------- scene
  function renderScene() {
    const { ctx, w, h } = sizeCanvas2d(els.scene);
    const doc = getSpaceParams();
    const bake = getSpaceBake(doc);
    const m = sceneMetrics(w, h, doc.view);
    const L = doc.listener;
    const T = sceneTime();
    const cEff = effectiveC(doc);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);

    // grid / 격자
    const step = niceStep(m.k, 46);
    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.fillStyle = '#64748b';
    const x0 = Math.floor(m.sx(0) / step) * step;
    for (let x = x0; m.wx(x) <= w; x += step) {
      ctx.strokeStyle = Math.abs(x) < 1e-9 ? 'rgba(56, 189, 248, 0.28)' : 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath(); ctx.moveTo(m.wx(x), 0); ctx.lineTo(m.wx(x), h); ctx.stroke();
      ctx.fillText(`${roundTo(x, 1)}`, m.wx(x) + 3, h - 5);
    }
    const y0 = Math.floor(m.sy(h) / step) * step;
    for (let y = y0; m.wy(y) >= 0; y += step) {
      ctx.strokeStyle = Math.abs(y) < 1e-9 ? 'rgba(56, 189, 248, 0.28)' : 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath(); ctx.moveTo(0, m.wy(y)); ctx.lineTo(w, m.wy(y)); ctx.stroke();
      ctx.fillText(`${roundTo(y, 1)}`, 4, m.wy(y) - 3);
    }
    ctx.fillText(`${t('space.unitM')} · ${t('space.gridStep', step)}`, w - 120, 14);

    // air-absorption distance circle / 공기 흡수 거리 원
    ctx.strokeStyle = 'rgba(45, 212, 191, 0.35)';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.arc(m.wx(L.x), m.wy(L.y), doc.airDist * m.k, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(45, 212, 191, 0.7)';
    ctx.fillText(`airDist ${doc.airDist} m`, m.wx(L.x) + doc.airDist * m.k * 0.71 + 4, m.wy(L.y) - doc.airDist * m.k * 0.71);

    const active = getActiveSource(doc);
    // paths / 경로
    for (const s of doc.sources) {
      const poly = trajectoryPolyline(s, doc);
      const on = s.id === active?.id;
      const aud = isSourceAudible(s, doc);
      ctx.strokeStyle = alpha(s.color, aud ? (on ? 0.85 : 0.45) : 0.18);
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.setLineDash(aud ? [] : [4, 4]);
      ctx.beginPath();
      poly.forEach((q, i) => (i ? ctx.lineTo(m.wx(q.x), m.wy(q.y)) : ctx.moveTo(m.wx(q.x), m.wy(q.y))));
      ctx.stroke();
      ctx.setLineDash([]);
      if (poly.length > 1) { // start marker / 출발 표시
        ctx.fillStyle = alpha(s.color, 0.6);
        ctx.fillRect(m.wx(poly[0].x) - 2.5, m.wy(poly[0].y) - 2.5, 5, 5);
      }
    }

    // wavefront rings + sources at T / 파면 링과 T 시점 음원
    const ringDt = Math.max(0.01, doc.view.span / cEff / 14);
    for (const s of doc.sources) {
      if (!isSourceAudible(s, doc)) continue;
      const kin = getKinematics(s, doc);
      for (const ring of wavefrontRings(s, doc, T, ringDt, MAX_RINGS)) {
        ctx.strokeStyle = alpha(s.color, 0.5 * (1 - ring.k / (MAX_RINGS + 1)));
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(m.wx(ring.x), m.wy(ring.y), ring.radius * m.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      const tau = T - kin.start;
      if (tau < 0 || tau > kin.dur) continue;
      const st = kin.stateAt(tau);
      const px = m.wx(st.x);
      const py = m.wy(st.y);
      const sc = Math.min(1, 70 / Math.max(1e-6, st.speed * m.k)); // 1 s of motion, ≤ 70 px / 1초 이동량
      arrow(ctx, px, py, px + st.vx * m.k * sc, py - st.vy * m.k * sc, '#e2e8f0', 1.4);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(px, py, s.id === active?.id ? 7 : 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(s.name, px + 9, py - 8);
    }
    // heard (emission) position, sound ray and v_r / 들리는 방출 위치, 음선, v_r
    for (const s of doc.sources) {
      if (!isSourceAudible(s, doc)) continue;
      const b = bake.sources.get(s.id);
      const hx = sampleBake(b, 'x', T);
      if (!Number.isFinite(hx)) continue;
      const hy = sampleBake(b, 'y', T);
      const r = sampleBake(b, 'r', T);
      const vr = sampleBake(b, 'vr', T);
      ctx.strokeStyle = alpha(s.color, 0.55);
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(m.wx(hx), m.wy(hy)); ctx.lineTo(m.wx(L.x), m.wy(L.y)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(m.wx(hx), m.wy(hy), 6, 0, Math.PI * 2); ctx.stroke();
      if (r > 1e-6) {
        const ux = (hx - L.x) / r;
        const uy = (hy - L.y) / r;
        const len = clamp(Math.abs(vr) * m.k, 0, 60) * Math.sign(vr);
        arrow(ctx, m.wx(hx), m.wy(hy), m.wx(hx) + ux * len, m.wy(hy) - uy * len, '#f59e0b', 2);
      }
    }

    // listener / 청취자
    const lx = m.wx(L.x);
    const ly = m.wy(L.y);
    const hd = (L.headingDeg * Math.PI) / 180;
    const fx = Math.sin(hd);
    const fy = -Math.cos(hd);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(lx + fx * 22, ly + fy * 22);
    ctx.lineTo(lx - fy * 8, ly + fx * 8);
    ctx.lineTo(lx + fy * 8, ly - fx * 8);
    ctx.closePath();
    ctx.globalAlpha = 0.55;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(lx, ly, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('L', lx + fy * 14, ly - fx * 14 + 3.5);
    ctx.fillText('R', lx - fy * 14, ly + fx * 14 + 3.5);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText('L', lx + fy * 14, ly - fx * 14 + 3.5);
    ctx.fillText('R', lx - fy * 14, ly + fx * 14 + 3.5);
    ctx.textAlign = 'left';
    ctx.font = FONT;

    // handles of the active source / 활성 음원 제어점
    if (active && doc.tool === 'move') {
      for (const hnd of pathHandles(active, L)) {
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = active.color;
        ctx.lineWidth = 2;
        ctx.fillRect(m.wx(hnd.x) - 5, m.wy(hnd.y) - 5, 10, 10);
        ctx.strokeRect(m.wx(hnd.x) - 5, m.wy(hnd.y) - 5, 10, 10);
      }
    }
    if (stroke && stroke.length > 1) {
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      stroke.forEach((q, i) => (i ? ctx.lineTo(m.wx(q.x), m.wy(q.y)) : ctx.moveTo(m.wx(q.x), m.wy(q.y))));
      ctx.stroke();
    }
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`t = ${T.toFixed(2)} s · c = ${cEff.toFixed(1)} m/s`, 8, 16);
  }

  function hitScene(p, doc, m) {
    const L = doc.listener;
    const hd = (L.headingDeg * Math.PI) / 180;
    const nx = m.wx(L.x) + Math.sin(hd) * 22;
    const ny = m.wy(L.y) - Math.cos(hd) * 22;
    if (Math.hypot(p.x - nx, p.y - ny) < 8) return { type: 'heading' };
    if (Math.hypot(p.x - m.wx(L.x), p.y - m.wy(L.y)) < 12) return { type: 'listener' };
    const active = getActiveSource(doc);
    if (active) for (const hnd of pathHandles(active, L)) if (Math.abs(p.x - m.wx(hnd.x)) < 8 && Math.abs(p.y - m.wy(hnd.y)) < 8) return { type: 'handle', key: hnd.key };
    const T = sceneTime();
    for (const s of doc.sources) {
      const kin = getKinematics(s, doc);
      const st = kin.stateAt(clamp(T - kin.start, 0, kin.dur));
      if (Math.hypot(p.x - m.wx(st.x), p.y - m.wy(st.y)) < 10) return { type: 'select', id: s.id };
    }
    return null;
  }

  const onDown = (e) => {
    if (e.button !== 0) return;
    const doc = getSpaceParams();
    const { w, h } = { w: els.scene.clientWidth, h: els.scene.clientHeight };
    const m = sceneMetrics(w, h, doc.view);
    const p = pos(e, els.scene);
    try { els.scene.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    if (doc.tool === 'draw') {
      stroke = [{ x: m.sx(p.x), y: m.sy(p.y), px: p.x, py: p.y }];
      drag = { type: 'draw' };
      return;
    }
    const hit = hitScene(p, doc, m);
    if (hit?.type === 'select') { editSpace((d) => { d.activeSourceId = hit.id; }, { history: false }); drag = null; return; }
    drag = hit || { type: 'pan', x: p.x, y: p.y, view: { ...doc.view } };
  };
  const onMove = (e) => {
    if (!drag) return;
    const doc = getSpaceParams();
    const m = sceneMetrics(els.scene.clientWidth, els.scene.clientHeight, doc.view);
    const p = pos(e, els.scene);
    const wx = m.sx(p.x);
    const wy = m.sy(p.y);
    if (drag.type === 'draw') {
      const last = stroke[stroke.length - 1];
      if (Math.hypot(p.x - last.px, p.y - last.py) >= 3) stroke.push({ x: wx, y: wy, px: p.x, py: p.y });
      requestRender(['space']);
    } else if (drag.type === 'listener') {
      // Each move re-bakes at edit time and merges into one undo step / 이동마다 재베이킹, 실행 취소 1단계
      editSpace((d) => { d.listener.x = roundTo(wx, 1); d.listener.y = roundTo(wy, 1); }, { coalesceKey: 'space-listener' });
    } else if (drag.type === 'heading') {
      const L = doc.listener;
      const deg = Math.round((Math.atan2(wx - L.x, wy - L.y) * 180) / Math.PI);
      editSpace((d) => { d.listener.headingDeg = deg; }, { coalesceKey: 'space-heading' });
    } else if (drag.type === 'handle') {
      const key = drag.key;
      editSpace((d) => { const s = getActiveSource(d); if (s) applyHandleDrag(s.path, key, wx, wy, d.listener); }, { coalesceKey: `space-handle-${key}` });
    } else if (drag.type === 'pan') {
      const vw = drag.view;
      const k = els.scene.clientWidth / Math.max(5, vw.span);
      editSpace((d) => { d.view.cx = roundTo(vw.cx - (p.x - drag.x) / k, 2); d.view.cy = roundTo(vw.cy + (p.y - drag.y) / k, 2); }, { history: false });
    }
  };
  const onUp = (e) => {
    if (drag?.type === 'draw' && stroke) {
      const pts = resampleStroke(stroke, MAX_DRAW_POINTS, 1);
      if (pts.length >= 2) {
        editSpace((d) => {
          const s = getActiveSource(d);
          if (!s) return;
          s.path.type = 'draw';
          s.path.points = pts;
          const len = pathLength(s, d.listener);
          const v = s.speed.mode === 'const' ? s.speed.value : 0.5 * (s.speed.from + s.speed.to);
          if (v > 0.1 && len > 0) s.duration = roundTo(clamp(len / v, 0.5, 300), 2); // traverse once / 한 번 주행
        });
        endHistoryGesture();
      }
      stroke = null;
    } else if (drag && drag.type !== 'pan') endHistoryGesture();
    drag = null;
    try { els.scene.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['space']);
  };
  const onWheel = (e) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    editSpace((d) => { d.view.span = roundTo(clamp(d.view.span * f, 10, 3000), 2); }, { history: false });
  };

  // ---------------------------------------------------------------- observed pitch
  function renderObs() {
    const { ctx, w, h } = sizeCanvas2d(els.obs);
    const doc = getSpaceParams();
    const bake = getSpaceBake(doc);
    const ax = timeAxis(w, doc.length, tv(doc));
    let { mLo, mHi } = pitchRange(bake);
    obsAuto = { midiMin: mLo, midiMax: mHi };
    if (obsPitch) { mLo = obsPitch.midiMin; mHi = obsPitch.midiMax; }
    obsM = { plotW: ax.plotW, plotH: h - PAD.top - PAD.bottom, xToTime: ax.xToTime, yToMidi: (py) => mLo + (1 - (py - PAD.top) / Math.max(1, h - PAD.top - PAD.bottom)) * (mHi - mLo) };
    const plotH = h - PAD.top - PAD.bottom;
    const midiToY = (mi) => PAD.top + (1 - (mi - mLo) / (mHi - mLo)) * plotH;
    const hzToY = (hz) => midiToY(freqToMidi(Math.max(1, hz)));
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    for (let mi = Math.floor(mLo); mi <= Math.ceil(mHi); mi++) { // piano roll / 피아노롤
      const pc = ((mi % 12) + 12) % 12;
      const yt = midiToY(mi + 0.5);
      const yb = midiToY(mi - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(PAD.left, yt, ax.plotW, Math.max(1, yb - yt));
      ctx.strokeStyle = pc === 0 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(51, 65, 85, 0.3)';
      ctx.beginPath(); ctx.moveTo(PAD.left, midiToY(mi)); ctx.lineTo(PAD.left + ax.plotW, midiToY(mi)); ctx.stroke();
      if ((mHi - mLo < 14 || pc === 0) && midiToY(mi) > PAD.top + 4 && midiToY(mi) < h - PAD.bottom) {
        ctx.fillStyle = '#64748b';
        ctx.fillText(midiToNoteName(mi), 6, midiToY(mi) + 4);
      }
    }
    const tStep = niceStep(ax.plotW / Math.max(1e-6, ax.tMax - ax.tMin), 50);
    ctx.fillStyle = '#64748b';
    for (let s = Math.ceil(ax.tMin / tStep - 1e-9) * tStep; s <= Math.min(doc.length, ax.tMax) + 1e-9; s += tStep) {
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath(); ctx.moveTo(ax.timeToX(s), PAD.top); ctx.lineTo(ax.timeToX(s), h - PAD.bottom); ctx.stroke();
      ctx.fillText(`${roundTo(s, 1)}s`, ax.timeToX(s) + 2, h - 6);
    }
    const active = getActiveSource(doc);
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.left, PAD.top, ax.plotW, plotH); ctx.clip();
    obsPolys = new Map();
    for (const s of doc.sources) {
      const b = bake.sources.get(s.id);
      if (!b) continue;
      const step = Math.max(1, Math.floor(b.n / 400));
      const pl = [];
      for (let i = 0; i < b.n; i += step) pl.push({ x: ax.timeToX(b.t[i]), y: hzToY(b.fObs[i]) });
      pl.push({ x: ax.timeToX(b.t[b.n - 1]), y: hzToY(b.fObs[b.n - 1]) });
      obsPolys.set(s.id, pl);
      const aud = isSourceAudible(s, doc);
      const on = s.id === active?.id;
      ctx.strokeStyle = alpha(s.color, aud ? 0.6 : 0.2);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      plotSeries(ctx, b, 'fs', ax, hzToY, ax.plotW);
      ctx.setLineDash([]);
      ctx.strokeStyle = alpha(s.color, aud ? 1 : 0.3);
      ctx.lineWidth = on ? 2.2 : 1.3;
      plotSeries(ctx, b, 'fObs', ax, hzToY, ax.plotW);
    }
    locate.draw(ctx, active?.id);
    ctx.restore();
    drawCueAndPlayhead(ctx, ax, PAD.top, h - PAD.bottom);
  }

  // Shared Locate tool (ui/locate-tool.js) on the observed-pitch roll: drag a source's line = move
  // its start and transpose its emitted frequency; drag its start / end dot = move that end in time
  // (the pitch at the ends is set by the physics). The fitted pitch range freezes while dragging.
  // 관측 음고 롤 이동 도구: 선 드래그 = 시작 시간·방출 주파수 이동, 시작/끝 점 = 그 끝의 시간.
  const locate = attachLocate(els.obs, {
    items() {
      const doc = getSpaceParams();
      return doc.sources.filter((s) => obsPolys.get(s.id)?.length >= 2).map((s) => {
        const pl = obsPolys.get(s.id);
        return { id: s.id, color: s.color, poly: pl, start: pl[0], end: pl[pl.length - 1] };
      });
    },
    toWorld: (p) => (obsM ? { sec: obsM.xToTime(p.x), midi: obsM.yToMidi(p.y) } : { sec: 0, midi: null }),
    begin(id) {
      if (!obsPitch) obsPitch = { ...obsAuto };
      const s = getSpaceParams().sources.find((x) => x.id === id);
      return { start: Number(s.start) || 0, duration: Number(s.duration) || 1, f: { ...s.f } };
    },
    // Observed sound starts after the propagation delay: the bake's t0 / 관측음은 전파 지연 후 시작
    startOf: (id) => getSpaceBake(getSpaceParams()).sources.get(id)?.t0,
    select(id) { if (getActiveSource(getSpaceParams())?.id !== id) editSpace((d) => { d.activeSourceId = id; }, { history: false }); },
    apply(id, kind, w) {
      const o = w.orig;
      const r3 = (x) => Number(x.toFixed(3));
      editSpace((d) => {
        const s = d.sources.find((x) => x.id === id);
        if (!s) return;
        if (kind === 'move') {
          s.start = r3(Math.max(0, w.snapTime(o.start + w.dSec)));
          if (w.midi != null) {
            const k = 2 ** (w.dSemi / 12);
            const hz = (x) => Number(clamp(x * k, 10, 20000).toFixed(2));
            s.f = { ...s.f, hz: hz(o.f.hz), hz0: hz(o.f.hz0), hz1: hz(o.f.hz1) };
          }
        } else if (kind === 'start') {
          const end = o.start + o.duration;
          s.start = r3(clamp(w.snapTime(o.start + w.dSec), 0, end - 0.1));
          s.duration = r3(end - s.start);
        } else {
          s.duration = r3(clamp(w.snapTime(o.start + o.duration + w.dSec) - o.start, 0.1, 300));
        }
      }, { coalesceKey: `space-locate-${kind}` });
    },
  });

  // ---------------------------------------------------------------- lanes
  function renderLanes() {
    const { ctx, w, h } = sizeCanvas2d(els.lanes);
    const doc = getSpaceParams();
    const bake = getSpaceBake(doc);
    const ax = timeAxis(w, doc.length, tv(doc));
    lanesM = { plotW: ax.plotW, plotH: h - PAD.top - PAD.bottom, xToTime: ax.xToTime };
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    const laneH = (h - PAD.top - PAD.bottom) / 3;
    let rMax = 10;
    for (const b of bake.sources.values()) for (let i = 0; i < b.n; i += 8) rMax = Math.max(rMax, b.r[i]);
    const lanes = [
      { key: 'gain', label: t('space.laneGain'), map: (g) => clamp((20 * Math.log10(Math.max(1e-6, g)) + 60) / 60, 0, 1), ticks: [[1, '0'], [0, '−60']] },
      { key: 'pan', label: t('space.lanePan'), map: (p) => 0.5 + 0.5 * p, ticks: [[1, 'R'], [0, 'L']], mid: true },
      { key: 'r', label: t('space.laneR'), map: (r) => clamp(r / rMax, 0, 1), ticks: [[1, `${Math.round(rMax)}m`], [0, '0']] },
    ];
    const active = getActiveSource(doc);
    lanes.forEach((ln, li) => {
      const top = PAD.top + li * laneH;
      const bot = top + laneH - 4;
      const toY = (v) => bot - ln.map(v) * (bot - top);
      ctx.fillStyle = 'rgba(30, 41, 59, 0.35)';
      ctx.fillRect(PAD.left, top, ax.plotW, bot - top);
      // Lane name inside the plot, end ticks right-aligned in the gutter (short lanes) / 레인 이름은 안쪽, 눈금은 여백
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      for (const [v, s] of ln.ticks) ctx.fillText(s, PAD.left - 4, v ? top + 9 : bot);
      ctx.textAlign = 'left';
      if (ln.mid) {
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.5)';
        ctx.beginPath(); ctx.moveTo(PAD.left, 0.5 * (top + bot)); ctx.lineTo(PAD.left + ax.plotW, 0.5 * (top + bot)); ctx.stroke();
      }
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(ln.label, PAD.left + 4, top + 11);
      ctx.save();
      ctx.beginPath(); ctx.rect(PAD.left, top, ax.plotW, bot - top); ctx.clip();
      for (const s of doc.sources) {
        const b = bake.sources.get(s.id);
        if (!b) continue;
        ctx.strokeStyle = alpha(s.color, isSourceAudible(s, doc) ? 0.95 : 0.3);
        ctx.lineWidth = s.id === active?.id ? 1.8 : 1;
        plotSeries(ctx, b, ln.key, ax, toY, ax.plotW);
      }
      ctx.restore();
    });
    drawCueAndPlayhead(ctx, ax, PAD.top, h - PAD.bottom);
  }

  const onDblTime = (canvas) => (e) => {
    const doc = getSpaceParams();
    const ax = timeAxis(canvas.clientWidth, doc.length, tv(doc));
    cueOrAudition(e, Math.max(0, Number(ax.xToTime(pos(e, canvas).x).toFixed(2))));
  };
  const dblObs = onDblTime(els.obs);
  const dblLanes = onDblTime(els.lanes);

  els.scene.addEventListener('pointerdown', onDown);
  els.scene.addEventListener('pointermove', onMove);
  els.scene.addEventListener('pointerup', onUp);
  els.scene.addEventListener('pointercancel', onUp);
  els.scene.addEventListener('wheel', onWheel, { passive: false });
  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // The gain / pan / distance lanes have no pitch axis, so the wheel moves time there.
  // 공용 휠 문법. 음량·팬·거리 레인에는 음고 축이 없어 시간만 움직임
  const wheelTime = (canvas, getM, pitch) => (e) => {
    const m = getM();
    if (!m) return;
    e.preventDefault();
    const doc = getSpaceParams();
    const nv = navView(doc);
    const before = `${nv.midiMin}|${nv.midiMax}`;
    wheelNavigate(e, nv, m, pos(e, canvas), { ...navLimits(doc), pitch });
    setNavView(nv, before);
  };
  els.obs.addEventListener('wheel', wheelTime(els.obs, () => obsM, true), { passive: false });
  els.lanes.addEventListener('wheel', wheelTime(els.lanes, () => lanesM, false), { passive: false });
  els.obs.addEventListener('dblclick', dblObs);
  els.lanes.addEventListener('dblclick', dblLanes);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['space'])) : null;
  ro?.observe(els.scene);
  ro?.observe(els.obs);
  ro?.observe(els.lanes);

  return {
    render() {
      renderScene();
      renderObs();
      renderLanes();
    },
    /** Toolbar zoom of the observed-pitch roll (time is shared with the lanes). / 관측 음고 롤 툴바 줌 */
    zoomTimeCanvases(axis, f) {
      const doc = getSpaceParams();
      const nv = navView(doc);
      const before = `${nv.midiMin}|${nv.midiMax}`;
      if (axis !== 'pitch') zoomViewTime(nv, f, null, navLimits(doc));
      if (axis !== 'time') zoomViewPitch(nv, f, null, navLimits(doc));
      setNavView(nv, before);
    },
    /** Fit All for the time canvases. / 시간 캔버스 전체 맞춤 */
    fitTimeCanvases() {
      timeView = null;
      obsPitch = null;
      requestRender(['space']);
    },
    destroy() {
      ro?.disconnect();
      locate.destroy();
    },
  };
}
