/**
 * Flexatone — studios/chaos/chaos-canvases.js
 * Chaos Studio UI tier: phase portrait, pitch curves (Glissando piano-roll coordinates),
 * divergence graph (log d) and the bifurcation mini-map.
 * 카오스 스튜디오 UI: 위상 초상, 음고 곡선(글리산도 피아노롤 좌표), 발산 그래프, 분기도.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder (imported only through
 * chaos-panels.js). Everything static is drawn once per baked result into an offscreen canvas;
 * each frame only blits it and draws the cue / playhead / trails. / 정적 레이어는 베이킹마다 1회.
 *
 * Interaction: double-click the pitch or divergence canvas to set the cue; drag the portrait in
 * 3-D view to rotate it. / 더블클릭 = 큐 지점, 3D 보기에서 드래그 = 회전.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToNoteName } from '../../core/units.js';
import { t, getLang } from '../../core/i18n.js';
import { appState } from '../../core/state.js';
import { BAKE_RATE, stageIndexAt, sampleIndexAt, computeBifurcation, getChaosSystem, refFrame, resolveAxes, axisDirection, AXIS_LEN_RANGE, AXIS_CENTER_RANGE } from './chaos-engine.js';
import { CHAOS_COLORS } from '../chaos-studio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, zoomViewTime, zoomViewPitch } from '../../ui/view-nav.js';
import { sizeCanvas } from '../../ui/canvas-size.js';
import { cueOrAudition } from '../../ui/locate-tool.js';

const BG = '#020617';
const GRID = '#1e293b';
const GRID_HI = '#334155';
const LABEL = '#94a3b8';
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
const PAD = { left: 46, right: 12, top: 12, bottom: 22 };
/** 3-D mapping axis colours by target channel (match the mapping rack). / 축 색 = 대상 채널 색 */
export const AXIS_COLORS = Object.freeze({ pitch: '#34d399', gain: '#fbbf24', bright: '#fb7185', none: '#64748b' });
const AXIS_LETTERS = ['A', 'B', 'C'];
const HANDLE_R = 9;


/** Offscreen layer cache: redraw only when `key` changes. / 키가 바뀔 때만 다시 그림 */
function makeLayer() {
  const off = document.createElement('canvas');
  let key = '';
  return {
    get(w, h, dpr, k, draw) {
      const full = `${k}|${w}x${h}@${dpr}`;
      if (full !== key) {
        off.width = Math.floor(w * dpr);
        off.height = Math.floor(h * dpr);
        const c = off.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        draw(c);
        key = full;
      }
      return off;
    },
    reset() { key = ''; },
  };
}

const alpha = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function playheadSec() {
  const tr = appState.transport;
  return tr.playing && tr.playheadSec >= 0 ? tr.playheadSec : null;
}

// --------------------------------------------------------------------------
// Projection / 투영
// --------------------------------------------------------------------------

function makeProjector(A, view, m) {
  const ax = refFrame(A);
  const proj = view.proj;
  const yaw = Number(view.yaw) || 0;
  const tilt = Number(view.tilt) || 0;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const ext = proj === '3d' ? 1.9 : 1.35;
  const s = Math.min(m.pw, m.ph) / (2 * ext);
  const ox = m.px + m.pw / 2;
  const oy = m.py + m.ph / 2;
  const sx = proj === '3d' ? s : m.pw / (2 * ext);
  const syS = proj === '3d' ? s : m.ph / (2 * ext);
  // Screen right / up as vectors of the normalised state space (inverse of the projection).
  // 정규화 상태 공간에서 본 화면 오른쪽·위쪽 벡터
  const R = proj === 'xy' || proj === 'xz' ? [1, 0, 0] : proj === 'yz' ? [0, 1, 0] : [cy, -sy, 0];
  const U = proj === 'xy' ? [0, 1, 0] : proj === 'xz' || proj === 'yz' ? [0, 0, 1] : [-sy * st, -cy * st, ct];
  /** Normalised (≈ −1…1) coordinates → screen. / 정규화 좌표 → 화면 */
  const projN = (X, Y, Z, out) => {
    out[0] = ox + (X * R[0] + Y * R[1] + Z * R[2]) * sx;
    out[1] = oy - (X * U[0] + Y * U[1] + Z * U[2]) * syS;
    return out;
  };
  const P = (x, y, z, out) => projN((x - ax[0].mid) / ax[0].half, (y - ax[1].mid) / ax[1].half, (z - ax[2].mid) / ax[2].half, out);
  P.projN = projN;
  /** Screen delta (px) → normalised state-space delta in the screen plane. / 화면 이동 → 상태 공간 이동 */
  P.unproject = (dx, dy) => [0, 1, 2].map((k) => (dx / sx) * R[k] - (dy / syS) * U[k]);
  P.frame = ax;
  return P;
}

function axisNames(proj, sysId) {
  if (proj === '3d') return ['', ''];
  const names = getChaosSystem(sysId).id === 'dpend' ? { x: 'tip x', y: 'tip y', z: 'ω₂' } : getChaosSystem(sysId).id === 'duffing' ? { x: 'x', y: 'v', z: 'cos ωt' } : getChaosSystem(sysId).id === 'logistic' ? { x: 'xₙ', y: 'xₙ₋₁', z: 'r' } : { x: 'x', y: 'y', z: 'z' };
  const [a, b] = proj === 'xy' ? ['x', 'y'] : proj === 'yz' ? ['y', 'z'] : ['x', 'z'];
  return [names[a], names[b]];
}

// --------------------------------------------------------------------------
// Canvases / 캔버스
// --------------------------------------------------------------------------

/**
 * @param {{ portrait: HTMLCanvasElement, pitch: HTMLCanvasElement, diverge: HTMLCanvasElement, bif: HTMLCanvasElement }} els
 * @param {{ requestRender: Function, onRotate: (dyaw:number, dtilt:number, done:boolean) => void,
 *   onAxis?: (index:number|null, patch:object|null, done:boolean) => void }} hooks
 * @returns {{ render: (doc: object, B: object) => void, destroy: () => void }}
 */
export function createChaosCanvases(els, { requestRender, onRotate, onAxis = () => {} }) {
  const layers = { portrait: makeLayer(), pitch: makeLayer(), diverge: makeLayer(), bif: makeLayer() };
  let last = { doc: null, B: null };
  const tmp = new Float64Array(2);
  const tmp2 = new Float64Array(2);
  let lastP = null; // portrait projector of the last frame (axis dragging) / 마지막 투영기
  let axisHandles = []; // [{ i, kind: 'tip' | 'center', x, y }]

  const metrics = (w, h, pad = PAD) => ({ w, h, px: pad.left, py: pad.top, pw: w - pad.left - pad.right, ph: h - pad.top - pad.bottom });

  // ------------------------------------------------------------ portrait
  function drawPortrait(doc, B) {
    const cv = els.portrait;
    const { dpr, w, h } = sizeCanvas(cv, 120, 60);
    const ctx = cv.getContext('2d');
    const A = B.A;
    const m = metrics(w, h, { left: 10, right: 10, top: 10, bottom: 10 });
    const view = doc.view;
    const P = makeProjector(A, view, m);
    const isMap = A.kind === 'map';
    const key = `${getLang()}|${A.bakeId}|${view.proj}|${view.yaw}|${view.tilt}`;
    const layer = layers.portrait.get(w, h, dpr, key, (c) => {
      c.fillStyle = BG;
      c.fillRect(0, 0, w, h);
      // axes cross / 축
      c.strokeStyle = GRID;
      c.lineWidth = 1;
      P(A.ref.center[0], A.ref.center[1], A.ref.center[2], tmp);
      c.beginPath();
      c.moveTo(m.px, tmp[1]); c.lineTo(m.px + m.pw, tmp[1]);
      c.moveTo(tmp[0], m.py); c.lineTo(tmp[0], m.py + m.ph);
      c.stroke();
      const [ha, va] = axisNames(view.proj, A.sysId);
      c.fillStyle = LABEL;
      c.font = FONT;
      if (ha) { c.fillText(`→ ${ha}`, m.px + m.pw - 60, m.py + m.ph - 4); c.fillText(`↑ ${va}`, m.px + 4, m.py + 12); } else c.fillText(t('chaos.rotateHint'), m.px + 4, m.py + 12);
      const stride = Math.max(1, Math.floor(A.Ms / 3000));
      A.voices.forEach((v, i) => {
        const col = CHAOS_COLORS[i % CHAOS_COLORS.length];
        const { x, y, z } = v.src;
        if (isMap) {
          c.fillStyle = alpha(col, A.N > 4 ? 0.25 : 0.4);
          for (let j = 0; j < A.Ms; j += stride) { P(x[j], y[j], z[j], tmp); c.fillRect(tmp[0] - 1, tmp[1] - 1, 2, 2); }
        } else {
          c.strokeStyle = alpha(col, A.N > 4 ? 0.16 : 0.28);
          c.lineWidth = 1;
          c.beginPath();
          for (let j = 0; j < A.Ms; j += stride) { P(x[j], y[j], z[j], tmp); if (j === 0) c.moveTo(tmp[0], tmp[1]); else c.lineTo(tmp[0], tmp[1]); }
          c.stroke();
        }
      });
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(layer, 0, 0, w, h);
    // trail + current state (the dot is what sounds now) / 꼬리와 현재 상태 점
    const ph = playheadSec();
    const sec = ph ?? clamp(appState.transport.cueSec || 0, 0, A.duration);
    const jEnd = stageIndexAt(A, sec);
    const trail = clamp(Number(view.trailSec) || 2.5, 0.2, 20);
    const jStart = stageIndexAt(A, Math.max(0, sec - trail));
    const chunks = 10;
    A.voices.forEach((v, i) => {
      const col = CHAOS_COLORS[i % CHAOS_COLORS.length];
      const { x, y, z } = v.src;
      if (ph !== null && jEnd > jStart) {
        const per = Math.max(1, Math.ceil((jEnd - jStart) / chunks));
        for (let c0 = jStart, ci = 0; c0 < jEnd; c0 += per, ci++) {
          const c1 = Math.min(jEnd, c0 + per);
          const a = 0.15 + (0.85 * (ci + 1)) / chunks;
          if (isMap) {
            ctx.fillStyle = alpha(col, a);
            for (let j = c0; j <= c1; j++) { P(x[j], y[j], z[j], tmp); ctx.fillRect(tmp[0] - 1.5, tmp[1] - 1.5, 3, 3); }
          } else {
            ctx.strokeStyle = alpha(col, a);
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            const st = Math.max(1, Math.floor((c1 - c0) / 60));
            for (let j = c0; j <= c1; j += st) { P(x[j], y[j], z[j], tmp); if (j === c0) ctx.moveTo(tmp[0], tmp[1]); else ctx.lineTo(tmp[0], tmp[1]); }
            P(x[c1], y[c1], z[c1], tmp);
            ctx.lineTo(tmp[0], tmp[1]);
            ctx.stroke();
          }
        }
      }
      P(x[jEnd], y[jEnd], z[jEnd], tmp);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(tmp[0], tmp[1], i === 0 ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = BG;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    lastP = P;
    drawAxes(ctx, doc, B, P, jEnd, m);
  }

  // ------------------------------------------------------------ 3-D mapping axes
  /**
   * Each assigned axis = a segment from −1 (Low) to +1 (High) through its centre. The diamond on
   * it is where voice 1 projects now (= the value that sounds); the dotted line shows that
   * projection. In edit mode every axis shows a tip handle (angle + length) and a centre handle.
   * 할당된 축 = 중심을 지나는 −1(하한)…+1(상한) 선분. 마름모 = 보이스 1의 현재 투영값.
   */
  function drawAxes(ctx, doc, B, P, j, m) {
    const edit = !!doc.view?.axesEdit;
    const axes = resolveAxes(doc);
    axisHandles = [];
    const A = B.A;
    const f = P.frame;
    const v0 = A.voices[0];
    const S = v0 ? [(v0.src.x[j] - f[0].mid) / f[0].half, (v0.src.y[j] - f[1].mid) / f[1].half, (v0.src.z[j] - f[2].mid) / f[2].half] : null;
    const a2 = new Float64Array(2);
    const b2 = new Float64Array(2);
    const c2 = new Float64Array(2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.px, m.py, m.pw, m.ph);
    ctx.clip();
    ctx.font = FONT;
    axes.forEach((a, i) => {
      if (!edit && a.target === 'none') return;
      const d = axisDirection(a);
      const L = a.len;
      const col = AXIS_COLORS[a.target] || AXIS_COLORS.none;
      const at = (u, out) => P.projN(a.c[0] + d[0] * u * L, a.c[1] + d[1] * u * L, a.c[2] + d[2] * u * L, out);
      at(-1, a2);
      at(1, b2);
      at(0, c2);
      ctx.strokeStyle = alpha(col, a.target === 'none' ? 0.55 : 0.95);
      ctx.lineWidth = a.target === 'none' ? 1.2 : 2;
      ctx.setLineDash(a.target === 'none' ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(a2[0], a2[1]); ctx.lineTo(b2[0], b2[1]); ctx.stroke();
      ctx.setLineDash([]);
      // arrow head at High / 상한 쪽 화살촉
      const ang = Math.atan2(b2[1] - a2[1], b2[0] - a2[0]);
      if (Math.hypot(b2[0] - a2[0], b2[1] - a2[1]) > 6) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(b2[0], b2[1]);
        ctx.lineTo(b2[0] - 9 * Math.cos(ang - 0.4), b2[1] - 9 * Math.sin(ang - 0.4));
        ctx.lineTo(b2[0] - 9 * Math.cos(ang + 0.4), b2[1] - 9 * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
      // Low end tick / 하한 눈금
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a2[0] - 5 * Math.sin(ang), a2[1] + 5 * Math.cos(ang));
      ctx.lineTo(a2[0] + 5 * Math.sin(ang), a2[1] - 5 * Math.cos(ang));
      ctx.stroke();
      const label = `${AXIS_LETTERS[i]} · ${a.target === 'none' ? t('chaos.axis.none') : t(`chaos.ch.${a.target}`)}`;
      ctx.fillStyle = col;
      ctx.fillText(label, clamp(b2[0] + 8, m.px + 2, m.px + m.pw - 7 * label.length), clamp(b2[1] - 6, m.py + 12, m.py + m.ph - 4));
      // projection of voice 1 → foot point on the axis / 보이스 1의 투영점
      if (S && a.target !== 'none') {
        const u = clamp(((S[0] - a.c[0]) * d[0] + (S[1] - a.c[1]) * d[1] + (S[2] - a.c[2]) * d[2]) / L, -1, 1);
        const foot = at(u, new Float64Array(2));
        const st = P.projN(S[0], S[1], S[2], new Float64Array(2));
        ctx.strokeStyle = alpha(col, 0.5);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(st[0], st[1]); ctx.lineTo(foot[0], foot[1]); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(foot[0], foot[1] - 5); ctx.lineTo(foot[0] + 5, foot[1]); ctx.lineTo(foot[0], foot[1] + 5); ctx.lineTo(foot[0] - 5, foot[1]);
        ctx.closePath();
        ctx.fill();
      }
      if (edit) {
        ctx.fillStyle = col;
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(b2[0], b2[1], 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = BG;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(c2[0], c2[1], 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        axisHandles.push({ i, kind: 'tip', x: b2[0], y: b2[1] }, { i, kind: 'center', x: c2[0], y: c2[1] });
      }
    });
    if (edit) {
      ctx.fillStyle = LABEL;
      ctx.fillText(t('chaos.axis.editHint'), m.px + 4, m.py + m.ph - 6);
    }
    ctx.restore();
  }

  function hitAxis(e) {
    const r = els.portrait.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let bd = HANDLE_R;
    // tips first (they sit on top of the centre when an axis is short) / 끝 핸들 우선
    for (const h of [...axisHandles].sort((p, q) => (p.kind === 'tip' ? -1 : 1) - (q.kind === 'tip' ? -1 : 1))) {
      const dd = Math.hypot(h.x - x, h.y - y);
      if (dd < bd) { bd = dd; best = h; }
    }
    return best;
  }

  // ------------------------------------------------------------ pitch
  let pitchView = null; // { tMin, tMax, midiMin, midiMax } — UI-local, never in the document / 문서에 저장하지 않음
  let pitchFull = { tMin: 0, tMax: 1, midiMin: 36, midiMax: 84 };
  function pitchFrame(doc, B, w, h) {
    const mp = B.mapping.pitch;
    const lo = Math.floor(Math.min(mp.lo, mp.hi) - 3);
    const hi = Math.ceil(Math.max(mp.lo, mp.hi) + 3);
    const m = metrics(w, h);
    const dur = B.A.duration;
    // Local view (shared zoom / scroll, ui/view-nav.js); null = the whole piece and the mapped range.
    // 지역 뷰 (공용 줌·스크롤); null = 전체 길이와 매핑 범위
    pitchFull = { tMin: 0, tMax: dur, midiMin: lo, midiMax: hi };
    if (pitchView && (pitchView.tMax > dur + 1e-6 || pitchView.tMax - pitchView.tMin < 0.05)) pitchView = null;
    const vw = pitchView || pitchFull;
    const tSpan = Math.max(1e-6, vw.tMax - vw.tMin);
    const mSpan = Math.max(1e-6, vw.midiMax - vw.midiMin);
    m.timeToX = (s) => m.px + ((s - vw.tMin) / tSpan) * m.pw;
    m.xToTime = (x) => clamp(vw.tMin + ((x - m.px) / m.pw) * tSpan, 0, dur);
    m.midiToY = (mm) => m.py + (1 - (mm - vw.midiMin) / mSpan) * m.ph;
    m.yToMidi = (y) => vw.midiMin + (1 - (y - m.py) / m.ph) * mSpan;
    m.plotW = m.pw;
    m.plotH = m.ph;
    m.lo = vw.midiMin;
    m.hi = vw.midiMax;
    m.t0 = vw.tMin;
    m.t1 = vw.tMax;
    m.viewKey = pitchView ? `${vw.tMin.toFixed(4)},${vw.tMax.toFixed(4)},${vw.midiMin.toFixed(3)},${vw.midiMax.toFixed(3)}` : 'fit';
    return m;
  }

  function timeGrid(c, m, dur, t0 = 0, t1 = dur) {
    if (t1 - t0 < dur - 1e-9) {
      // zoomed view: steps follow the visible span / 줌 상태: 보이는 구간에 맞춘 눈금
      const span = t1 - t0;
      const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 60].find((s) => span / s <= 10) || 120;
      c.font = FONT;
      c.fillStyle = LABEL;
      c.strokeStyle = GRID;
      c.lineWidth = 1;
      c.beginPath();
      for (let s = Math.ceil(t0 / step - 1e-9) * step; s <= t1 + 1e-9; s += step) {
        const x = m.timeToX(s);
        c.moveTo(x, m.py);
        c.lineTo(x, m.py + m.ph);
        c.fillText(`${Number(s.toFixed(2))}s`, x + 2, m.py + m.ph + 14);
      }
      c.stroke();
      return;
    }
    const step = dur > 120 ? 20 : dur > 60 ? 10 : dur > 20 ? 5 : dur > 8 ? 2 : 1;
    c.font = FONT;
    c.fillStyle = LABEL;
    c.strokeStyle = GRID;
    c.lineWidth = 1;
    c.beginPath();
    for (let s = 0; s <= dur + 1e-9; s += step) {
      const x = m.timeToX(s);
      c.moveTo(x, m.py);
      c.lineTo(x, m.py + m.ph);
      c.fillText(`${s}s`, x + 2, m.py + m.ph + 14);
    }
    c.stroke();
  }

  function drawPitch(doc, B) {
    const cv = els.pitch;
    const { dpr, w, h } = sizeCanvas(cv, 120, 60);
    const ctx = cv.getContext('2d');
    const A = B.A;
    const m = pitchFrame(doc, B, w, h);
    const layer = layers.pitch.get(w, h, dpr, `${getLang()}|${B.sig || ''}|${A.bakeId}|${m.viewKey}`, (c) => {
      c.fillStyle = BG;
      c.fillRect(0, 0, w, h);
      c.font = FONT;
      const black = new Set([1, 3, 6, 8, 10]);
      const rowH = m.ph / (m.hi - m.lo);
      c.save();
      c.beginPath();
      c.rect(m.px, m.py, m.pw, m.ph);
      c.clip();
      for (let mm = Math.floor(m.lo); mm < m.hi; mm++) {
        if (black.has(((mm % 12) + 12) % 12) && rowH > 3) { c.fillStyle = 'rgba(15,23,42,0.9)'; c.fillRect(m.px, m.midiToY(mm + 1), m.pw, rowH); }
      }
      c.restore();
      c.strokeStyle = GRID;
      c.lineWidth = 1;
      for (let mm = Math.ceil(m.lo - 1e-9); mm <= m.hi; mm++) {
        const isC = ((mm % 12) + 12) % 12 === 0;
        if (!isC && rowH < 5) continue;
        c.strokeStyle = isC ? GRID_HI : GRID;
        c.beginPath();
        c.moveTo(m.px, m.midiToY(mm));
        c.lineTo(m.px + m.pw, m.midiToY(mm));
        c.stroke();
        if (isC || rowH >= 11) { c.fillStyle = isC ? '#cbd5e1' : LABEL; c.fillText(midiToNoteName(mm), 4, m.midiToY(mm) + 4); }
      }
      timeGrid(c, m, A.duration, m.t0, m.t1);
      c.save();
      c.beginPath();
      c.rect(m.px, m.py, m.pw, m.ph);
      c.clip();
      // mapping range band / 매핑 범위
      c.strokeStyle = 'rgba(56,189,248,0.25)';
      c.setLineDash([4, 4]);
      for (const mm of [B.mapping.pitch.lo, B.mapping.pitch.hi]) { c.beginPath(); c.moveTo(m.px, m.midiToY(mm)); c.lineTo(m.px + m.pw, m.midiToY(mm)); c.stroke(); }
      c.setLineDash([]);
      const j0 = clamp(Math.floor(m.t0 * BAKE_RATE) - 1, 0, B.M - 1);
      const j1 = clamp(Math.ceil(m.t1 * BAKE_RATE) + 1, 0, B.M - 1);
      const stride = Math.max(1, Math.floor((j1 - j0 + 1) / (m.pw * 2)));
      for (let i = B.voices.length - 1; i >= 0; i--) {
        const v = B.voices[i];
        c.strokeStyle = alpha(CHAOS_COLORS[i % CHAOS_COLORS.length], i === 0 ? 1 : 0.85);
        c.lineWidth = i === 0 ? 2 : 1.3;
        c.beginPath();
        for (let j = j0; j <= j1; j += stride) {
          const x = m.timeToX(j / BAKE_RATE);
          const y = m.midiToY(v.pitch[j]);
          if (j === j0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
      if (A.divergeSec !== null) {
        const x = m.timeToX(A.divergeSec);
        c.strokeStyle = 'rgba(244,63,94,0.8)';
        c.setLineDash([5, 4]);
        c.beginPath(); c.moveTo(x, m.py); c.lineTo(x, m.py + m.ph); c.stroke();
        c.setLineDash([]);
        c.fillStyle = '#fda4af';
        c.fillText(t('chaos.divergeMark'), Math.min(x + 4, m.px + m.pw - 90), m.py + 12);
      }
      c.restore();
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(layer, 0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.px, m.py, m.pw, m.ph);
    ctx.clip();
    drawCueAndPlayhead(ctx, m, B, true);
    ctx.restore();
  }

  function drawCueAndPlayhead(ctx, m, B, dots) {
    const tr = appState.transport;
    const cx = m.timeToX(clamp(tr.cueSec || 0, 0, B.A.duration));
    // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
    drawCueLine(ctx, cx, m.py, m.py + m.ph);
    const ph = playheadSec();
    if (ph === null) return;
    const x = m.timeToX(ph);
    drawPlayheadLine(ctx, x, m.py, m.py + m.ph);
    if (dots) {
      const j = sampleIndexAt(B, ph);
      B.voices.forEach((v, i) => {
        ctx.fillStyle = CHAOS_COLORS[i % CHAOS_COLORS.length];
        ctx.beginPath(); ctx.arc(x, m.midiToY(v.pitch[j]), 3.5, 0, Math.PI * 2); ctx.fill();
      });
    }
  }

  // ------------------------------------------------------------ divergence
  function divergeFrame(B, w, h) {
    const A = B.A;
    const m = metrics(w, h);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < A.N; i++) {
      const d = A.voices[i].logd;
      for (let j = 0; j < A.Ms; j++) if (Number.isFinite(d[j])) { lo = Math.min(lo, d[j]); hi = Math.max(hi, d[j]); }
    }
    if (!Number.isFinite(lo)) { lo = -8; hi = 2; }
    lo = Math.floor(Math.max(-16, lo) - 0.5);
    hi = Math.ceil(Math.max(hi, A.thresholdLog10) + 0.5);
    const dur = A.duration;
    m.timeToX = (s) => m.px + (s / dur) * m.pw;
    m.xToTime = (x) => clamp(((x - m.px) / m.pw) * dur, 0, dur);
    m.logToY = (l) => m.py + (1 - (l - lo) / (hi - lo)) * m.ph;
    m.lo = lo;
    m.hi = hi;
    return m;
  }

  function drawDiverge(doc, B) {
    const cv = els.diverge;
    const { dpr, w, h } = sizeCanvas(cv, 120, 60);
    const ctx = cv.getContext('2d');
    const A = B.A;
    const m = divergeFrame(B, w, h);
    const layer = layers.diverge.get(w, h, dpr, `${getLang()}|${A.bakeId}`, (c) => {
      c.fillStyle = BG;
      c.fillRect(0, 0, w, h);
      c.font = FONT;
      c.strokeStyle = GRID;
      c.fillStyle = LABEL;
      const ystep = m.hi - m.lo > 12 ? 4 : 2;
      for (let l = Math.ceil(m.lo / ystep) * ystep; l <= m.hi; l += ystep) {
        const y = m.logToY(l);
        c.beginPath(); c.moveTo(m.px, y); c.lineTo(m.px + m.pw, y); c.stroke();
        c.fillText(`1e${l}`, 4, y + 4);
      }
      timeGrid(c, m, A.duration);
      if (A.N < 2) {
        c.fillStyle = LABEL;
        c.fillText(t('chaos.needTwo'), m.px + 10, m.py + m.ph / 2);
        return;
      }
      // threshold 0.1 · diameter / 임계선
      const ty = m.logToY(A.thresholdLog10);
      c.strokeStyle = 'rgba(244,63,94,0.55)';
      c.setLineDash([3, 4]);
      c.beginPath(); c.moveTo(m.px, ty); c.lineTo(m.px + m.pw, ty); c.stroke();
      c.setLineDash([]);
      c.fillStyle = '#fda4af';
      c.fillText(t('chaos.threshold'), m.px + 4, ty - 4);
      const stride = Math.max(1, Math.floor(A.Ms / (m.pw * 2)));
      for (let i = 1; i < A.N; i++) {
        const d = A.voices[i].logd;
        c.strokeStyle = alpha(CHAOS_COLORS[i % CHAOS_COLORS.length], 0.8);
        c.lineWidth = 1.2;
        c.beginPath();
        for (let j = 0; j < A.Ms; j += stride) {
          const x = m.timeToX(A.songSec(j));
          const y = m.logToY(clamp(d[j], m.lo, m.hi));
          if (j === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
      // fitted slope on the exponential window / 지수 구간 근사 직선
      if (A.fitWin && Number.isFinite(A.fitSlope)) {
        const [a, b, icpt] = A.fitWin;
        c.strokeStyle = '#fbbf24';
        c.lineWidth = 2;
        c.setLineDash([6, 4]);
        c.beginPath();
        for (const j of [a, b]) {
          const l = (icpt + A.fitSlope * A.sampleTau(j)) / Math.LN10;
          const x = m.timeToX(A.songSec(j));
          if (j === a) c.moveTo(x, m.logToY(l)); else c.lineTo(x, m.logToY(l));
        }
        c.stroke();
        c.setLineDash([]);
      }
      if (A.divergeSec !== null) {
        const x = m.timeToX(A.divergeSec);
        c.strokeStyle = 'rgba(244,63,94,0.8)';
        c.beginPath(); c.moveTo(x, m.py); c.lineTo(x, m.py + m.ph); c.stroke();
      }
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(layer, 0, 0, w, h);
    drawCueAndPlayhead(ctx, m, B, false);
  }

  // ------------------------------------------------------------ bifurcation
  function drawBif(doc, B) {
    const cv = els.bif;
    if (!cv || cv.offsetParent === null) return;
    const { dpr, w, h } = sizeCanvas(cv, 120, 60);
    const ctx = cv.getContext('2d');
    const A = B.A;
    const sys = getChaosSystem(A.sysId);
    const pid = A.sweep ? A.sweep.param : sys.params[0].id;
    const def = sys.params.find((p) => p.id === pid);
    const from = A.sweep ? Math.min(A.sweep.from, A.sweep.to) : def.min;
    const to = A.sweep ? Math.max(A.sweep.from, A.sweep.to) : def.max;
    const params = { ...doc.params };
    const bif = computeBifurcation(sys.id, params, pid, from, to, { cols: Math.min(320, Math.max(80, Math.floor(w))) });
    const m = metrics(w, h, { left: 36, right: 8, top: 8, bottom: 18 });
    const pToX = (p) => m.px + ((p - from) / Math.max(1e-9, to - from)) * m.pw;
    const span = Math.max(1e-9, bif.hi - bif.lo);
    const layer = layers.bif.get(w, h, dpr, bif.key, (c) => {
      c.fillStyle = BG;
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(167,139,250,0.55)';
      for (let i = 0; i < bif.cols; i++) {
        const x = m.px + (i / Math.max(1, bif.cols - 1)) * m.pw;
        for (let k = 0; k < bif.plot; k++) {
          const v = bif.xs[i * bif.plot + k];
          if (Number.isFinite(v)) c.fillRect(x, m.py + (1 - (v - bif.lo) / span) * m.ph, 1, 1);
        }
      }
      c.font = FONT;
      c.fillStyle = LABEL;
      c.fillText(`${pid} ${from.toFixed(2)}`, m.px, m.py + m.ph + 13);
      const lab = to.toFixed(2);
      c.fillText(lab, m.px + m.pw - 7 * lab.length, m.py + m.ph + 13);
      c.fillText('x', 8, m.py + 10);
    });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(layer, 0, 0, w, h);
    const ph = playheadSec();
    const sec = ph ?? clamp(appState.transport.cueSec || 0, 0, A.duration);
    const pv = A.sweepVals ? A.sweepVals[stageIndexAt(A, sec)] : Number(doc.params[pid]);
    const x = pToX(pv);
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, m.py); ctx.lineTo(x, m.py + m.ph); ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(`${pid} = ${pv.toFixed(3)}`, clamp(x + 4, m.px, m.px + m.pw - 90), m.py + 12);
  }

  // ------------------------------------------------------------ pointer
  const onDbl = (cv, frame) => (e) => {
    const { B } = last;
    if (!B) return;
    const r = cv.getBoundingClientRect();
    const m = frame(B, r.width, r.height);
    cueOrAudition(e, Number(m.xToTime(e.clientX - r.left).toFixed(2)));
  };
  const dblPitch = onDbl(els.pitch, (B, w, h) => pitchFrame(last.doc, B, w, h));
  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // 공용 휠 문법: 휠 = 음고, Shift = 시간, Ctrl/⌘ = 포인터 기준 줌
  const pitchLimits = () => ({ tHi: pitchFull.tMax, maxTimeSpan: pitchFull.tMax, minTimeSpan: 0.05 });
  const wheelPitch = (e) => {
    const { B } = last;
    if (!B) return;
    e.preventDefault();
    const r = els.pitch.getBoundingClientRect();
    const m = pitchFrame(last.doc, B, r.width, r.height);
    const nv = { ...(pitchView || pitchFull) };
    wheelNavigate(e, nv, m, { x: e.clientX - r.left, y: e.clientY - r.top }, pitchLimits());
    pitchView = nv;
    requestRender(['chaos']);
  };
  els.pitch.addEventListener('wheel', wheelPitch, { passive: false });
  const dblDiv = onDbl(els.diverge, (B, w, h) => divergeFrame(B, w, h));
  els.pitch.addEventListener('dblclick', dblPitch);
  els.diverge.addEventListener('dblclick', dblDiv);

  let drag = null;
  let axisDrag = null;
  const onDown = (e) => {
    const h = last.doc?.view.axesEdit && lastP ? hitAxis(e) : null;
    if (h) {
      // Drag a handle: tip = angle + length (how strongly the axis applies), centre = position.
      // 핸들 드래그: 끝 = 각도 + 길이(적용 정도), 중심 = 위치
      const a = resolveAxes(last.doc)[h.i];
      const d = axisDirection(a);
      axisDrag = { h, x0: e.clientX, y0: e.clientY, a, vec: d.map((q) => q * a.len), P: lastP };
      els.portrait.setPointerCapture?.(e.pointerId);
      els.portrait.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
    if (last.doc?.view.proj !== '3d') return;
    drag = { x: e.clientX, y: e.clientY };
    els.portrait.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (axisDrag) {
      const { h, a, vec, P } = axisDrag;
      const dv = P.unproject(e.clientX - axisDrag.x0, e.clientY - axisDrag.y0);
      if (h.kind === 'tip') {
        const w = vec.map((q, k) => q + dv[k]);
        const len = clamp(Math.hypot(w[0], w[1], w[2]), AXIS_LEN_RANGE[0], AXIS_LEN_RANGE[1]);
        const az = Math.hypot(w[0], w[1]) > 1e-6 ? (Math.atan2(w[1], w[0]) * 180) / Math.PI : a.az;
        const el = (Math.asin(clamp(w[2] / Math.max(1e-9, Math.hypot(w[0], w[1], w[2])), -1, 1)) * 180) / Math.PI;
        onAxis(h.i, { az: Math.round(az * 10) / 10, el: Math.round(el * 10) / 10, len: Math.round(len * 1000) / 1000 }, false);
      } else {
        const c = a.c.map((q, k) => Math.round(clamp(q + dv[k], -AXIS_CENTER_RANGE, AXIS_CENTER_RANGE) * 1000) / 1000);
        onAxis(h.i, { c }, false);
      }
      return;
    }
    if (!drag) {
      if (last.doc?.view.axesEdit) els.portrait.style.cursor = hitAxis(e) ? 'grab' : '';
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    onRotate(dx * 0.01, dy * 0.01, false);
  };
  const onUp = () => {
    if (axisDrag) { axisDrag = null; els.portrait.style.cursor = ''; onAxis(null, null, true); return; }
    if (drag) { drag = null; onRotate(0, 0, true); }
  };
  els.portrait.addEventListener('pointerdown', onDown);
  els.portrait.addEventListener('pointermove', onMove);
  els.portrait.addEventListener('pointerup', onUp);
  els.portrait.addEventListener('pointercancel', onUp);

  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['chaos'])) : null;
  for (const cv of Object.values(els)) if (cv) ro?.observe(cv);

  return {
    render(doc, B) {
      last = { doc, B };
      drawPortrait(doc, B);
      drawPitch(doc, B);
      drawDiverge(doc, B);
      if (B.A.kind === 'map') drawBif(doc, B);
    },
    /** Toolbar zoom of the pitch canvas: axis 'pitch' | 'time' | 'both'. / 음고 캔버스 툴바 줌 */
    zoomPitchCanvas(axis, f) {
      const nv = { ...(pitchView || pitchFull) };
      if (axis !== 'pitch') zoomViewTime(nv, f, null, pitchLimits());
      if (axis !== 'time') zoomViewPitch(nv, f);
      pitchView = nv;
      requestRender(['chaos']);
    },
    /** Fit All: back to the whole piece and the mapped range. / 전체 맞춤 */
    fit() {
      pitchView = null;
      requestRender(['chaos']);
    },
    destroy() {
      ro?.disconnect();
      els.pitch.removeEventListener('wheel', wheelPitch);
      els.pitch.removeEventListener('dblclick', dblPitch);
      els.diverge.removeEventListener('dblclick', dblDiv);
      els.portrait.removeEventListener('pointerdown', onDown);
      els.portrait.removeEventListener('pointermove', onMove);
      els.portrait.removeEventListener('pointerup', onUp);
      els.portrait.removeEventListener('pointercancel', onUp);
      for (const l of Object.values(layers)) l.reset();
    },
  };
}
