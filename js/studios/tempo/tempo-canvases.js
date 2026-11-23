/**
 * Flexatone — studios/tempo/tempo-canvases.js
 * Tempo Studio UI tier: timeline (time × pitch), score-position graph s(u), phase view and the
 * subject roll. Reads baked arrays only (no integration while drawing).
 * 템포 스튜디오 UI: 타임라인, 악보 위치 그래프, 위상차 보기, 주제 롤. 베이킹 배열만 읽음.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder; only tempo-panels.js imports it.
 * Interaction: double-click (timeline / score) = cue · wheel = time zoom · drag ◆ in the score
 * graph = convergence point (Tc, sc), one undo step per drag.
 * 더블클릭 = 큐 · 휠 = 시간 줌 · ◆ 드래그 = 수렴점 (드래그 1회 = 실행 취소 1단계).
 */

import { clamp } from '../../core/math-utils.js';
import { midiToNoteName } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { readCurve, evalS, phaseMatrix, syncDistance, subjectMidiAt } from './tempo-engine.js';
import { getTempoParams, editTempo, getTempoBake, isTempoVoiceAudible, voicePitchOffset } from '../tempo-studio.js';
import { getTempoPlayheadSec, isTempoPlaying } from './tempo-audio.js';
import { drawCueLine, drawPlayheadLine } from '../../ui/transport-lines.js';
import { wheelNavigate, zoomViewTime, zoomViewPitch } from '../../ui/view-nav.js';
import { attachLocate, cueOrAudition } from '../../ui/locate-tool.js';
import { sizeCanvas } from '../../ui/canvas-size.js';

const PAD = { left: 46, right: 12, top: 12, bottom: 20 };
const BLACK = new Set([1, 3, 6, 8, 10]);
const MONO = '10px ui-monospace, Menlo, monospace';


function begin(canvas, ctx) {
  const { dpr, w, h } = sizeCanvas(canvas);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  return { w, h, plotW: w - PAD.left - PAD.right, plotH: h - PAD.top - PAD.bottom };
}

/** The time the matrix / roll describe: playhead while playing, else the cue. / 선택 시각 */
export function selectedTime() {
  const tr = appState.transport;
  return isTempoPlaying() && tr.playheadSec >= 0 ? getTempoPlayheadSec() : tr.cueSec || 0;
}

function timeTicks(ctx, m, tMin, tMax) {
  const span = tMax - tMin;
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => span / s <= 10) || 60;
  ctx.font = MONO;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let s = Math.ceil(tMin / step) * step; s <= tMax + 1e-9; s += step) {
    const x = m.timeToX(s);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + m.plotH);
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.fillText(`${Number(s.toFixed(1))}s`, x, PAD.top + m.plotH + 4);
  }
}

function vline(ctx, m, x, color, width = 1.5, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, PAD.top);
  ctx.lineTo(x, PAD.top + m.plotH);
  ctx.stroke();
  ctx.restore();
}

function cueAndPlayhead(ctx, m) {
  const tr = appState.transport;
  // Shared cue / playhead look (ui/transport-lines.js) / 공용 큐·플레이헤드 모양
  drawCueLine(ctx, m.timeToX(tr.cueSec || 0), PAD.top, PAD.top + m.plotH);
  if (isTempoPlaying() && tr.playheadSec >= 0) drawPlayheadLine(ctx, m.timeToX(getTempoPlayheadSec()), PAD.top, PAD.top + m.plotH);
}

/**
 * Create the canvases. els = { timeline, score, phase, roll, hud: { time, info } }.
 * @returns {{ render: () => void, destroy: () => void, fit: () => void }}
 */
export function createTempoCanvases(els, { requestRender }) {
  const c = {
    timeline: els.timeline.getContext('2d'),
    score: els.score.getContext('2d'),
    phase: els.phase.getContext('2d'),
    roll: els.roll.getContext('2d'),
  };
  let view = null; // { tMin, tMax, midiMin?, midiMax? } (local, not part of the document) / 문서에 저장하지 않음
  let pitchAuto = { lo: 48, hi: 72 }; // fitted pitch range of the timeline / 타임라인 자동 음고 범위
  let drag = null; // { yLo, yHi } while dragging the convergence marker
  let scoreM = null;
  let tlM = null;
  let lastRange = null;
  let tlPolys = new Map(); // voice id → [[{x, y}]] timeline polylines of the last render / 마지막 렌더의 폴리라인

  const ensureView = (doc) => {
    if (!view || view.tMax > doc.length + 1e-6 || view.tMax - view.tMin < 0.25) view = { tMin: 0, tMax: doc.length, midiMin: view?.midiMin ?? null, midiMax: view?.midiMax ?? null };
    return view;
  };
  const metrics = (base, vw) => {
    const m = { ...base };
    const span = Math.max(0.1, vw.tMax - vw.tMin);
    m.timeToX = (s) => PAD.left + ((s - vw.tMin) / span) * m.plotW;
    m.xToTime = (x) => vw.tMin + ((x - PAD.left) / Math.max(1, m.plotW)) * span;
    return m;
  };
  const pos = (canvas, e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.clientHeight };
  };

  // ------------------------------------------------------------------ timeline
  function renderTimeline(doc, bake) {
    const ctx = c.timeline;
    const vw = ensureView(doc);
    const m = metrics(begin(els.timeline, ctx), vw);
    let lo = Infinity;
    let hi = -Infinity;
    for (const bv of bake.voices) {
      if (!bv.has) continue;
      const off = voicePitchOffset(doc.voices[bv.index]);
      lo = Math.min(lo, bv.midiLo + off);
      hi = Math.max(hi, bv.midiHi + off);
    }
    if (!Number.isFinite(lo)) { lo = 48; hi = 72; }
    lo = Math.floor(lo - 3);
    hi = Math.ceil(hi + 3);
    pitchAuto = { lo, hi };
    // Pitch zoom / scroll (shared view-nav): a manual range replaces the fitted one until Fit All.
    // 음고 줌·스크롤: 전체 맞춤 전까지 수동 범위가 자동 범위를 대신함
    if (Number.isFinite(vw.midiMin) && Number.isFinite(vw.midiMax)) { lo = vw.midiMin; hi = vw.midiMax; }
    m.yToMidi = (py) => lo + (1 - (py - PAD.top) / Math.max(1, m.plotH)) * (hi - lo);
    const midiToY = (mm) => PAD.top + (1 - (mm - lo) / Math.max(1, hi - lo)) * m.plotH;
    m.range = { lo, hi };
    tlPolys = new Map();
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    for (let mm = Math.floor(lo); mm <= Math.ceil(hi); mm++) {
      const pc = ((mm % 12) + 12) % 12;
      const yT = midiToY(mm + 0.5);
      const yB = midiToY(mm - 0.5);
      ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.32)';
      ctx.fillRect(PAD.left, yT, m.plotW, Math.max(1, yB - yT));
      if (pc === 0) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
        ctx.beginPath();
        ctx.moveTo(PAD.left, midiToY(mm));
        ctx.lineTo(PAD.left + m.plotW, midiToY(mm));
        ctx.stroke();
      }
    }
    timeTicks(ctx, m, vw.tMin, vw.tMax);
    if (doc.converge.enabled) vline(ctx, m, m.timeToX(doc.converge.Tc), 'rgba(244, 114, 182, 0.8)', 1.2, [6, 4]);
    const act = doc.activeVoiceId;
    for (const bv of bake.voices) {
      const v = doc.voices[bv.index];
      const audible = isTempoVoiceAudible(v, doc);
      if (bv.loopStarts.length < 400) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        for (const u of bv.loopStarts) if (u >= vw.tMin && u <= vw.tMax) vline(ctx, m, m.timeToX(u), v.color, 1);
        ctx.restore();
      }
      if (!bv.has) continue;
      const off = voicePitchOffset(v);
      ctx.save();
      ctx.globalAlpha = audible ? (v.id === act ? 1 : 0.7) : 0.2;
      ctx.strokeStyle = v.color;
      ctx.lineWidth = v.id === act ? 2.4 : 1.6;
      ctx.beginPath();
      let pen = false;
      const lines = [];
      for (let x = PAD.left; x <= PAD.left + m.plotW; x += 1.5) {
        const u = m.xToTime(x);
        if (u < 0 || u > doc.length || readCurve(bv.gain, u) < 0.05) { pen = false; continue; }
        const y = midiToY(readCurve(bv.midi, u) + off);
        if (!pen) { ctx.moveTo(x, y); lines.push([]); }
        else ctx.lineTo(x, y);
        lines[lines.length - 1].push({ x, y });
        pen = true;
      }
      tlPolys.set(v.id, lines);
      ctx.stroke();
      ctx.restore();
    }
    cueAndPlayhead(ctx, m);
    ctx.restore();
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.font = MONO;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#38bdf8';
    for (let mm = Math.ceil(lo); mm <= hi; mm++) {
      if (((mm % 12) + 12) % 12 !== 0) continue;
      ctx.fillText(midiToNoteName(mm), PAD.left - 5, midiToY(mm));
    }
    return m;
  }

  // ------------------------------------------------------------------ score graph
  function renderScore(doc, bake) {
    const ctx = c.score;
    const vw = ensureView(doc);
    const m = metrics(begin(els.score, ctx), vw);
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const bv of bake.voices) {
      yLo = Math.min(yLo, evalS(bv.track, vw.tMin), evalS(bv.track, vw.tMax));
      yHi = Math.max(yHi, evalS(bv.track, vw.tMin), evalS(bv.track, vw.tMax));
    }
    if (doc.converge.enabled) { yLo = Math.min(yLo, doc.converge.sc); yHi = Math.max(yHi, doc.converge.sc); }
    if (drag) ({ yLo, yHi } = drag);
    else {
      const padY = 0.06 * Math.max(1, yHi - yLo);
      yLo -= padY;
      yHi += padY;
    }
    lastRange = { yLo, yHi };
    const sToY = (s) => PAD.top + (1 - (s - yLo) / Math.max(1e-6, yHi - yLo)) * m.plotH;
    m.sToY = sToY;
    m.yToS = (y) => yLo + (1 - (y - PAD.top) / Math.max(1, m.plotH)) * (yHi - yLo);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.clip();
    timeTicks(ctx, m, vw.tMin, vw.tMax);
    // loop boundaries k·L / 루프 경계
    const L = bake.L;
    const k0 = Math.ceil(yLo / L);
    const k1 = Math.floor(yHi / L);
    ctx.font = MONO;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (k1 - k0 < 80) {
      for (let k = k0; k <= k1; k++) {
        const y = sToY(k * L);
        ctx.strokeStyle = k === 0 ? 'rgba(148, 163, 184, 0.55)' : 'rgba(71, 85, 105, 0.45)';
        ctx.setLineDash(k === 0 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + m.plotW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (k1 - k0 < 24) { ctx.fillStyle = '#475569'; ctx.fillText(`${k}L`, PAD.left + 3, y - 1); }
      }
    }
    // s < 0 shading (not entered) / 진입 전 영역
    const y0 = sToY(0);
    if (y0 < PAD.top + m.plotH) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
      ctx.fillRect(PAD.left, Math.max(PAD.top, y0), m.plotW, PAD.top + m.plotH - Math.max(PAD.top, y0));
    }
    for (const bv of bake.voices) {
      const v = doc.voices[bv.index];
      ctx.save();
      ctx.strokeStyle = v.color;
      ctx.globalAlpha = isTempoVoiceAudible(v, doc) ? (v.id === doc.activeVoiceId ? 1 : 0.75) : 0.25;
      ctx.lineWidth = v.id === doc.activeVoiceId ? 2.4 : 1.6;
      ctx.beginPath();
      for (let x = PAD.left; x <= PAD.left + m.plotW; x += 2) {
        const y = sToY(evalS(bv.track, m.xToTime(x)));
        if (x === PAD.left) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }
    if (doc.converge.enabled) {
      const cx = m.timeToX(doc.converge.Tc);
      const cy = sToY(doc.converge.sc);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = drag ? '#f9a8d4' : '#f472b6';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
      ctx.fillStyle = '#f9a8d4';
      ctx.font = 'bold 10px ui-monospace, Menlo, monospace';
      const label = `Tc ${doc.converge.Tc.toFixed(2)}s · sc ${doc.converge.sc.toFixed(2)}`;
      ctx.textAlign = cx + 12 + ctx.measureText(label).width > PAD.left + m.plotW ? 'right' : 'left';
      ctx.textBaseline = cy - 20 < PAD.top ? 'top' : 'bottom';
      ctx.fillText(label, cx + (ctx.textAlign === 'right' ? -10 : 10), cy + (ctx.textBaseline === 'top' ? 8 : -6));
    }
    cueAndPlayhead(ctx, m);
    ctx.restore();
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(PAD.left, PAD.top, m.plotW, m.plotH);
    ctx.fillStyle = '#94a3b8';
    ctx.font = MONO;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const f of [0, 0.5, 1]) {
      const s = yLo + f * (yHi - yLo);
      ctx.fillText(`${s.toFixed(1)}`, PAD.left - 5, sToY(s));
    }
    scoreM = m;
    return m;
  }

  // ------------------------------------------------------------------ phase view
  function renderPhase(doc, bake) {
    const ctx = c.phase;
    const { w, h } = begin(els.phase, ctx);
    const nV = bake.voices.length;
    const u = selectedTime();
    const P = phaseMatrix(bake, u);
    const cell = Math.max(10, Math.min(28, (h - 26) / Math.max(1, nV)));
    const mx = 26;
    const my = 16;
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    for (let i = 0; i < nV; i++) {
      const col = doc.voices[i].color;
      ctx.fillStyle = col;
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), mx - 4, my + (i + 0.5) * cell);
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), mx + (i + 0.5) * cell, my - 7);
      for (let j = 0; j < nV; j++) {
        const d = syncDistance(P[i][j]);
        const bright = i === j ? 0.08 : Math.pow(1 - 2 * d, 6);
        ctx.fillStyle = i === j ? '#0f172a' : `rgba(${Math.round(60 + 190 * bright)}, ${Math.round(70 + 140 * bright)}, ${Math.round(110 + 100 * bright)}, 1)`;
        ctx.fillRect(mx + j * cell + 1, my + i * cell + 1, cell - 2, cell - 2);
        if (i !== j && cell >= 22) {
          ctx.fillStyle = bright > 0.5 ? '#0f172a' : '#cbd5e1';
          ctx.font = '9px ui-monospace, Menlo, monospace';
          ctx.fillText(P[i][j].toFixed(2), mx + (j + 0.5) * cell, my + (i + 0.5) * cell);
          ctx.font = MONO;
        }
      }
    }
    // phase vs voice 1 over time / 시간에 따른 보이스 1 대비 위상
    const gx = mx + nV * cell + 18;
    const gw = w - gx - 10;
    const gy = my - 4;
    const gh = h - gy - 16;
    if (gw > 40) {
      ctx.strokeStyle = '#1e293b';
      ctx.strokeRect(gx, gy, gw, gh);
      const T = doc.length;
      const yOf = (p) => gy + (1 - p) * gh;
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.35)';
      for (const p of [0, 1]) { ctx.beginPath(); ctx.moveTo(gx, yOf(p)); ctx.lineTo(gx + gw, yOf(p)); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.4)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(gx, yOf(0.5)); ctx.lineTo(gx + gw, yOf(0.5)); ctx.stroke();
      ctx.setLineDash([]);
      const b0 = bake.voices[0];
      for (let i = 1; i < nV; i++) {
        const bi = bake.voices[i];
        ctx.strokeStyle = doc.voices[i].color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let prev = null;
        for (let x = 0; x <= gw; x += 1.5) {
          const uu = (x / gw) * T;
          let p = (evalS(bi.track, uu) - evalS(b0.track, uu)) / bake.L;
          p -= Math.floor(p);
          const y = yOf(p);
          if (prev === null || Math.abs(p - prev) > 0.5) ctx.moveTo(gx + x, y);
          else ctx.lineTo(gx + x, y);
          prev = p;
        }
        ctx.stroke();
      }
      const ux = gx + clamp(u / T, 0, 1) * gw;
      ctx.strokeStyle = isTempoPlaying() ? '#f8fafc' : '#fbbf24'; // playhead white / cue amber (shared look)
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ux, gy); ctx.lineTo(ux, gy + gh); ctx.stroke();
      if (doc.converge.enabled) {
        const tx = gx + clamp(doc.converge.Tc / T, 0, 1) * gw;
        ctx.strokeStyle = 'rgba(244, 114, 182, 0.7)';
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(tx, gy); ctx.lineTo(tx, gy + gh); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('0', gx - 9, yOf(0) - 6);
      ctx.fillText('1', gx - 9, yOf(1) - 1);
      ctx.textAlign = 'right';
      ctx.fillText(`${T.toFixed(0)}s`, gx + gw, gy + gh + 2);
    }
    if (els.hud?.phaseAt) els.hud.phaseAt.textContent = t('tempo.phaseAt', u.toFixed(2));
  }

  // ------------------------------------------------------------------ subject roll
  function renderRoll(doc, bake) {
    const ctx = c.roll;
    const { w, h } = begin(els.roll, ctx);
    const sub = bake.subject;
    const L = sub.L;
    const px = (tau) => 30 + (tau / L) * (w - 40);
    let lo = Infinity;
    let hi = -Infinity;
    const N = 240;
    const ys = [];
    for (let i = 0; i <= N; i++) { const mm = subjectMidiAt(sub, (i / N) * L * 0.99999, true); ys.push(mm); lo = Math.min(lo, mm); hi = Math.max(hi, mm); }
    lo -= 2;
    hi += 2;
    const yOf = (mm) => 8 + (1 - (mm - lo) / Math.max(1, hi - lo)) * (h - 16);
    if (sub.kind === 'notes') {
      for (const nt of sub.notes) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.fillRect(px(nt.s0), yOf(nt.midi) - 3, Math.max(1, px(nt.s1) - px(nt.s0) - 1), 6);
      }
    }
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ys.forEach((mm, i) => { const x = px((i / N) * L); if (i) ctx.lineTo(x, yOf(mm)); else ctx.moveTo(x, yOf(mm)); });
    ctx.stroke();
    ctx.fillStyle = '#64748b';
    ctx.font = MONO;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(midiToNoteName(Math.round(hi - 2)), 27, yOf(hi - 2));
    ctx.fillText(midiToNoteName(Math.round(lo + 2)), 27, yOf(lo + 2));
    const u = selectedTime();
    for (const bv of bake.voices) {
      const v = doc.voices[bv.index];
      const s = evalS(bv.track, u);
      if (s < 0 || (!v.loop && s >= L) || u > doc.length) continue;
      const k = Math.floor(s / L);
      const tau = s - k * L;
      const x = px(tau);
      ctx.fillStyle = v.color;
      ctx.globalAlpha = isTempoVoiceAudible(v, doc) ? 1 : 0.3;
      ctx.beginPath();
      ctx.arc(x, yOf(subjectMidiAt(sub, tau, k === 0)), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------ events
  const onDbl = (canvas) => (e) => {
    const m = canvas === els.score ? scoreM : tlM;
    if (!m) return;
    cueOrAudition(e, clamp(Number(m.xToTime(pos(canvas, e).x).toFixed(2)), 0, getTempoParams().length));
  };
  /** The local view with its pitch range filled in (fitted range when none was set). / 음고 범위를 채운 뷰 */
  const navView = (doc) => {
    const vw = ensureView(doc);
    return { tMin: vw.tMin, tMax: vw.tMax, midiMin: vw.midiMin ?? pitchAuto.lo, midiMax: vw.midiMax ?? pitchAuto.hi };
  };
  const navLimits = (doc) => ({ tHi: doc.length, maxTimeSpan: doc.length });
  const setNavView = (nv, keepPitch) => {
    view = { tMin: nv.tMin, tMax: nv.tMax, midiMin: keepPitch ? view?.midiMin ?? null : nv.midiMin, midiMax: keepPitch ? view?.midiMax ?? null : nv.midiMax };
    requestRender(['tempo']);
  };
  // Shared wheel grammar (ui/view-nav.js): wheel = pitch, Shift = time, Ctrl/⌘ = zoom at the pointer.
  // The score graph has no pitch axis, so every wheel move there is a time move.
  // 공용 휠 문법. 악보 위치 그래프에는 음고 축이 없으므로 시간만 움직임
  const onWheel = (e) => {
    e.preventDefault();
    const doc = getTempoParams();
    const onScore = e.currentTarget === els.score;
    const m = onScore ? scoreM : tlM;
    if (!m) return;
    const nv = navView(doc);
    const before = `${nv.midiMin}|${nv.midiMax}`;
    wheelNavigate(e, nv, m, pos(e.currentTarget, e), { ...navLimits(doc), pitch: !onScore });
    setNavView(nv, before === `${nv.midiMin}|${nv.midiMax}`);
  };
  const markerHit = (p) => {
    const doc = getTempoParams();
    if (!doc.converge.enabled || !scoreM) return false;
    return Math.hypot(p.x - scoreM.timeToX(doc.converge.Tc), p.y - scoreM.sToY(doc.converge.sc)) < 12;
  };
  const onDown = (e) => {
    const p = pos(els.score, e);
    if (!markerHit(p)) return;
    drag = { ...lastRange };
    try { els.score.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  };
  const onMove = (e) => {
    const p = pos(els.score, e);
    if (!drag) { els.score.style.cursor = markerHit(p) ? 'grab' : 'crosshair'; return; }
    const doc = getTempoParams();
    const Tc = clamp(Number(scoreM.xToTime(p.x).toFixed(2)), 0, doc.length);
    const sc = Number(scoreM.yToS(p.y).toFixed(2));
    editTempo((d) => { d.converge.Tc = Tc; d.converge.sc = sc; }, { coalesceKey: 'tempo:converge-drag' });
  };
  const onUp = (e) => {
    if (!drag) return;
    drag = null;
    endHistoryGesture();
    try { els.score.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    requestRender(['tempo']);
  };
  // Shared Locate tool (ui/locate-tool.js) on the timeline: drag a voice = move its start (time)
  // and transpose (pitch). Voices loop to the end of the piece, so there are no end dots.
  // The fitted pitch range is frozen while dragging so the axis does not move under the pointer.
  // 타임라인 이동 도구: 보이스 드래그 = 시작 시간·조옮김. 드래그 중 음고 범위 고정.
  const locate = attachLocate(els.timeline, {
    items() {
      const doc = getTempoParams();
      return doc.voices.filter((v) => tlPolys.has(v.id)).map((v) => ({ id: v.id, color: v.color, poly: tlPolys.get(v.id) }));
    },
    toWorld: (p) => (tlM ? { sec: tlM.xToTime(p.x), midi: tlM.yToMidi(p.y) } : { sec: 0, midi: null }),
    begin(id) {
      const vw = ensureView(getTempoParams());
      if (!(Number.isFinite(vw.midiMin) && Number.isFinite(vw.midiMax)) && tlM?.range) { vw.midiMin = tlM.range.lo; vw.midiMax = tlM.range.hi; }
      const v = getTempoParams().voices.find((x) => x.id === id);
      return { start: Number(v.start) || 0, transpose: Number(v.transpose) || 0 };
    },
    startOf: (id) => Math.max(0, Number(getTempoParams().voices.find((x) => x.id === id)?.start) || 0),
    select(id) { if (getTempoParams().activeVoiceId !== id) editTempo((d) => { d.activeVoiceId = id; }, { history: false }); },
    apply(id, kind, w) {
      const o = w.orig;
      editTempo((d) => {
        const v = d.voices.find((x) => x.id === id);
        if (!v) return;
        v.start = Number(clamp(w.snapTime(o.start + w.dSec), -d.length, d.length).toFixed(3));
        if (w.midi != null) v.transpose = Number(clamp(o.transpose + w.dSemi, -48, 48).toFixed(2));
      }, { coalesceKey: 'tempo:locate' });
    },
  });

  const dblT = onDbl(els.timeline);
  const dblS = onDbl(els.score);
  els.timeline.addEventListener('dblclick', dblT);
  els.score.addEventListener('dblclick', dblS);
  els.timeline.addEventListener('wheel', onWheel, { passive: false });
  els.score.addEventListener('wheel', onWheel, { passive: false });
  els.score.addEventListener('pointerdown', onDown);
  els.score.addEventListener('pointermove', onMove);
  els.score.addEventListener('pointerup', onUp);
  els.score.addEventListener('pointercancel', onUp);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['tempo'])) : null;
  for (const k of ['timeline', 'score', 'phase', 'roll']) ro?.observe(els[k]);

  return {
    render() {
      const doc = getTempoParams();
      const bake = getTempoBake(doc);
      tlM = renderTimeline(doc, bake);
      renderScore(doc, bake);
      renderPhase(doc, bake);
      renderRoll(doc, bake);
      if (els.hud?.time) els.hud.time.textContent = `${selectedTime().toFixed(2)} s`;
    },
    fit() {
      view = null;
      requestRender(['tempo']);
    },
    /** Toolbar zoom: axis 'pitch' | 'time' | 'both', factor < 1 = in. / 툴바 줌 */
    zoom(axis, f) {
      const doc = getTempoParams();
      const nv = navView(doc);
      if (axis !== 'pitch') zoomViewTime(nv, f, null, navLimits(doc));
      if (axis !== 'time') zoomViewPitch(nv, f);
      setNavView(nv, axis === 'time');
    },
    destroy() {
      ro?.disconnect();
      locate.destroy();
    },
  };
}
