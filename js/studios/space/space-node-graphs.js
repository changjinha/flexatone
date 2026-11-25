/**
 * Flexatone — studios/space/space-node-graphs.js
 * Layer 3 (studio UI): the x, y and z of a spline path's nodes as three envelopes over the path
 * (x axis = fraction of the path length, start → end). The curve between the nodes is the spline
 * itself. Gestures in each graph:
 *   click empty        → add a node on the curve there, its coordinate set to the clicked value
 *   click / drag point → select it and move only that coordinate
 *   shift + click      → add to / remove from the selection; dragging a selection adds the same
 *                        change to every selected node (relative, values are not made equal)
 *   two-finger click   → delete (the selection, if the point is in it; two nodes always stay)
 *   double-click point → type the value, with ▲ ▼ steps (a selection moves by the same change)
 * z on a 2-D spline lifts it to 3-D. The selection is the one of the node views.
 * 계층 3 (스튜디오 UI): 스플라인 노드 x·y·z를 경로(시작→끝) 위 세 엔벨로프로 표시.
 *   빈 곳 클릭 = 노드 추가 · 점 드래그 = 그 좌표만 이동 · 쉬프트+클릭 = 다중 선택 (같은 변화량을 더함, 값 동기화 안 함)
 *   두 손가락 클릭 = 삭제 · 더블클릭 = 숫자 입력 + ▲▼. 2D 스플라인의 z는 3D로 승격.
 *
 * Imports: modules/spline3d.js, ./space-views.js, ui/panels.js, core/math-utils.js.
 */

import { buildSpline } from '../../modules/spline3d.js';
import { worldNodes, splineClosed, insertNode, deleteNodes, liftForZ } from './space-views.js';
import { el } from '../../ui/panels.js';
import { roundTo } from '../../core/math-utils.js';

const AXES = Object.freeze(['x', 'y', 'z']);
const COLORS = Object.freeze({ x: '#f87171', y: '#4ade80', z: '#60a5fa' });
const H = 64; // css px per graph / 그래프 높이
const PAD = 6;
const HIT = 7;
const STEP = 0.1; // m, typed value and ▲ ▼ / 입력·▲▼ 단위
const R = (v) => roundTo(v, 2);

/**
 * @param {object} o
 * @param {() => object|null} o.source          active source with a spline path (or null)
 * @param {(fn: (path) => void, ck?: string) => void} o.mutate   edit the active source's path
 * @param {() => void} o.commit                   end of a gesture (history)
 * @param {() => string[]} o.selection            node selection of the views
 * @param {(ids: string[]) => void} o.select
 * @param {() => number} [o.marker]               progress (0…1) of what is heard now
 * @param {(k) => string} o.label
 */
export function createNodeGraphs(o) {
  const graphs = AXES.map((k) => {
    const cv = el('canvas', { class: 'w-full rounded bg-slate-950 border border-slate-800 cursor-crosshair touch-none' });
    cv.style.height = `${H}px`;
    const cap = el('span', { class: 'font-mono text-[10px]', text: o.label(k) });
    cap.style.color = COLORS[k];
    const val = el('span', { class: 'font-mono text-[10px] text-slate-400' });
    const box = el('div', { class: 'relative' }, [cv]);
    return { k, cv, cap, val, box, range: null, pts: [], geo: null };
  });
  let drag = null;
  let pop = null; // open value editor / 열린 값 편집기

  /** Set coordinate k of every node in `ids` to origin + delta (relative move). / 상대 이동 */
  const moveBy = (k, origin, delta, ck) => o.mutate((path) => {
    const ids = Object.keys(origin);
    if (k === 'z' && ids.length) liftForZ(path, origin[ids[0]] + delta);
    const is3 = path.spline.dims === '3d';
    if (k === 'z' && !is3) return;
    for (const n of path.spline.nodes) if (n.id in origin) n[k] = R(origin[n.id] + delta);
  }, ck);

  /** Current world values of coordinate k for `ids`. / 현재 좌표값 */
  const originOf = (k, ids) => {
    const s = o.source();
    if (!s) return {};
    const out = {};
    for (const n of worldNodes(s.path)) if (ids.includes(n.id)) out[n.id] = n[k];
    return out;
  };

  /** Geometry of the current spline: node fractions + sampled coordinates. / 현재 스플라인 기하 */
  const model = () => {
    const s = o.source();
    if (!s) return null;
    const nodes = worldNodes(s.path);
    if (nodes.length < 2) return null;
    const closed = splineClosed(s.path.spline);
    const spl = buildSpline(nodes, { closed });
    const len = Math.max(1e-9, spl.len);
    const fr = nodes.map((_, i) => spl.nodeS[i] / len);
    const curve = [];
    for (let i = 0; i <= 160; i++) curve.push({ f: i / 160, ...spl.P(spl.uAt((i / 160) * spl.len)) });
    if (closed) fr.push(1); // the closing point is node 1 again / 닫는 점 = 노드 1
    return { s, nodes, fr, curve, closed, spl, is3: s.path.spline.dims === '3d' };
  };

  const rangeOf = (m, k) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const q of m.curve) { lo = Math.min(lo, q[k]); hi = Math.max(hi, q[k]); }
    for (const n of m.nodes) { lo = Math.min(lo, n[k]); hi = Math.max(hi, n[k]); }
    const span = Math.max(2, hi - lo);
    const mid = (lo + hi) / 2;
    return [mid - span * 0.6, mid + span * 0.6];
  };

  const draw = () => {
    const m = model();
    const sel = new Set(o.selection());
    const mark = o.marker ? o.marker() : NaN;
    for (const g of graphs) {
      const { cv, k } = g;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(40, cv.clientWidth || 240);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(H * dpr); }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, H);
      g.pts = [];
      g.geo = m;
      if (!m) { g.val.textContent = ''; continue; }
      if (!(drag && drag.k === k) && !(pop && pop.k === k)) g.range = rangeOf(m, k); // frozen while editing / 편집 중 고정
      const [lo, hi] = g.range;
      const X = (f) => PAD + f * (w - 2 * PAD);
      const Y = (v) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
      g.toVal = (py) => lo + ((H - PAD - py) / (H - 2 * PAD)) * (hi - lo);
      g.toFrac = (px) => Math.min(1, Math.max(0, (px - PAD) / Math.max(1, w - 2 * PAD)));
      ctx.strokeStyle = 'rgba(148,163,184,0.18)';
      ctx.lineWidth = 1;
      if (lo < 0 && hi > 0) { ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke(); }
      for (const f of m.fr) { ctx.beginPath(); ctx.moveTo(X(f), 0); ctx.lineTo(X(f), H); ctx.stroke(); }
      ctx.strokeStyle = COLORS[k];
      ctx.globalAlpha = k === 'z' && !m.is3 ? 0.45 : 1;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      m.curve.forEach((q, i) => { if (i) ctx.lineTo(X(q.f), Y(q[k])); else ctx.moveTo(X(q.f), Y(q[k])); });
      ctx.stroke();
      ctx.globalAlpha = 1;
      m.fr.forEach((f, i) => {
        const n = m.nodes[i % m.nodes.length];
        const px = X(f);
        const py = Y(n[k]);
        g.pts.push({ id: n.id, px, py });
        const on = sel.has(n.id);
        ctx.fillStyle = on ? '#f8fafc' : '#0f172a';
        ctx.strokeStyle = COLORS[k];
        ctx.lineWidth = on ? 2 : 1.5;
        ctx.beginPath();
        ctx.arc(px, py, on ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      });
      if (Number.isFinite(mark)) {
        ctx.strokeStyle = 'rgba(250,204,21,0.8)';
        ctx.beginPath(); ctx.moveTo(X(mark), 0); ctx.lineTo(X(mark), H); ctx.stroke();
      }
      const chosen = m.nodes.filter((n) => sel.has(n.id));
      g.val.textContent = chosen.length > 1 ? `${chosen.length} · ${chosen[0][k].toFixed(2)} m…` : chosen.length ? `${chosen[0][k].toFixed(2)} m` : `${lo.toFixed(0)}…${hi.toFixed(0)} m`;
    }
  };

  const hitPoint = (g, p) => {
    let best = null;
    let bd = HIT;
    for (const q of g.pts) { const d = Math.hypot(q.px - p.x, q.py - p.y); if (d < bd) { bd = d; best = q; } }
    return best;
  };

  /** Add a node on the curve at the clicked path fraction; its coordinate k = the clicked value. */
  const addAt = (g, p) => {
    const m = g.geo;
    if (!m || !g.toVal) return;
    const u = m.spl.uAt(g.toFrac(p.x) * m.spl.len);
    const segs = m.spl.segs;
    const seg = Math.min(segs - 1, Math.floor(u * segs));
    const f = u * segs - seg;
    const v = g.toVal(p.y);
    let made = null;
    o.mutate((path) => {
      made = insertNode(path.spline, seg, f);
      if (!made) return;
      if (g.k === 'z') liftForZ(path, v);
      const n = path.spline.nodes.find((x) => x.id === made);
      if (n && !(g.k === 'z' && path.spline.dims !== '3d')) n[g.k] = R(v);
    });
    o.commit();
    if (made) o.select([made]);
  };

  const removeAt = (id) => {
    const sel = o.selection();
    const ids = sel.includes(id) ? sel : [id];
    o.mutate((path) => { deleteNodes(path.spline, ids); });
    o.commit();
    o.select([]);
  };

  // ---------------------------------------------------------------- value editor (double-click)
  const closePop = (keep = true) => {
    if (!pop) return;
    const p = pop;
    pop = null;
    p.root.remove();
    document.removeEventListener('pointerdown', p.outside, true);
    if (keep && p.dirty) o.commit();
    draw();
  };
  const openPop = (g, q) => {
    closePop();
    const ids = o.selection().includes(q.id) ? o.selection() : [q.id];
    if (!ids.includes(q.id)) return;
    const origin = originOf(g.k, ids);
    const base = origin[q.id];
    if (!Number.isFinite(base)) return;
    const input = el('input', { type: 'number', step: String(STEP), class: 'w-20 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 font-mono text-[11px] text-slate-100' });
    input.value = String(R(base));
    const state = { k: g.k, dirty: false, root: null };
    const apply = (v) => {
      if (!Number.isFinite(v)) return;
      input.value = String(R(v));
      state.dirty = true;
      moveBy(g.k, origin, v - base, `space-node-graph-type-${g.k}`); // the selection moves by the same change / 선택은 같은 변화량
    };
    const repeat = (dir) => {
      let timer = null;
      const stepOnce = () => apply((Number(input.value) || 0) + dir * STEP);
      const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
      return el('button', {
        class: 'px-1.5 py-0.5 rounded bg-slate-800 border border-slate-600 text-[10px] text-slate-200 hover:bg-slate-700',
        text: dir > 0 ? '▲' : '▼',
        on: {
          pointerdown: (e) => { e.preventDefault(); stepOnce(); timer = setTimeout(() => { timer = setInterval(stepOnce, 60); }, 350); },
          pointerup: stop, pointerleave: stop, pointercancel: stop,
        },
      });
    };
    input.addEventListener('input', () => apply(Number(input.value)));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closePop(true); }
      else if (e.key === 'Escape') { e.preventDefault(); if (state.dirty) moveBy(g.k, origin, 0, `space-node-graph-type-${g.k}`); closePop(true); }
      e.stopPropagation(); // keep Delete / Backspace etc. out of the studio shortcuts / 스튜디오 단축키로 새지 않게
    });
    const root = el('div', { class: 'absolute z-20 flex items-center gap-1 p-1 rounded-md bg-slate-950 border border-slate-500 shadow-lg' }, [
      input, repeat(1), repeat(-1),
      el('span', { class: 'font-mono text-[10px] text-slate-400', text: ids.length > 1 ? `m · ${ids.length}` : 'm' }),
      el('button', { class: 'px-1.5 py-0.5 rounded bg-violet-600/60 border border-violet-400/60 text-[10px] text-white', text: '✓', on: { click: () => closePop(true) } }),
    ]);
    const w = g.cv.clientWidth || 240;
    root.style.left = `${Math.max(0, Math.min(w - 190, q.px - 40))}px`;
    root.style.top = `${q.py > H / 2 ? Math.max(0, q.py - 34) : q.py + 8}px`;
    state.root = root;
    state.outside = (e) => { if (!root.contains(e.target)) closePop(true); }; // click outside closes / 바깥 클릭 = 닫기
    document.addEventListener('pointerdown', state.outside, true);
    pop = state;
    g.box.append(root);
    input.focus();
    input.select();
  };

  // ---------------------------------------------------------------- pointer gestures
  for (const g of graphs) {
    const { cv, k } = g;
    const at = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => { // two-finger click / right click → delete / 두 손가락 클릭 = 삭제
      e.preventDefault();
      const q = hitPoint(g, at(e));
      if (q) removeAt(q.id);
    });
    cv.addEventListener('dblclick', (e) => {
      const q = hitPoint(g, at(e));
      if (q) { e.preventDefault(); openPop(g, q); }
    });
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.ctrlKey) return; // ctrl-click is a secondary click on macOS / 보조 클릭
      const p = at(e);
      const q = hitPoint(g, p);
      if (!q) { if (!e.shiftKey) addAt(g, p); return; }
      let sel = o.selection();
      if (e.shiftKey) { // toggle, no drag / 토글만
        o.select(sel.includes(q.id) ? sel.filter((x) => x !== q.id) : [...sel, q.id]);
        return;
      }
      if (!sel.includes(q.id)) { sel = [q.id]; o.select(sel); }
      drag = { k, ids: sel.slice(), origin: originOf(k, sel), v0: g.toVal(p.y), moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || drag.k !== k || !g.toVal) return;
      const delta = g.toVal(at(e).y) - drag.v0;
      if (!drag.moved && Math.abs(delta) < 1e-6) return;
      drag.moved = true;
      moveBy(k, drag.origin, delta, `space-node-graph-${k}`); // same change for every selected node / 같은 변화량
    });
    const end = () => { if (!drag) return; const moved = drag.moved; drag = null; if (moved) o.commit(); draw(); };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
  }

  const root = el('div', { class: 'flex flex-col gap-1' }, graphs.map((g) => el('div', { class: 'flex flex-col gap-0.5' }, [
    el('div', { class: 'flex items-center justify-between' }, [g.cap, g.val]),
    g.box,
  ])));
  return { root, sync: draw };
}
