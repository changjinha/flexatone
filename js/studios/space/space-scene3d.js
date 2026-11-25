/**
 * Flexatone — studios/space/space-scene3d.js
 * Space Studio UI tier: (1) the node editor shared by every orthographic view (select / drag
 * nodes and handles, insert on the curve, append), (2) the three extra views of the quad layout —
 * front (XZ), side (YZ) and the orbit-camera perspective view.
 * 스페이스 스튜디오 UI: (1) 모든 정사영 뷰가 공유하는 노드 편집기 (노드·핸들 선택/드래그, 곡선 위 삽입,
 * 끝에 추가), (2) quad 배치의 추가 뷰 셋 — 정면(XZ)·측면(YZ)·궤도 카메라 원근 뷰.
 *
 * Layer note / 계층 메모: UI-tier file inside the studio folder; only space-panels.js and
 * space-canvases.js import it. The view mathematics is in the pure space-views.js.
 * Editing happens in the orthographic views only (each changes the two coordinates of its plane);
 * the perspective view is for looking: drag = orbit, wheel = distance, click a node = select.
 * 편집은 정사영 뷰에서만 (각 뷰는 자기 평면의 두 좌표만 바꿈). 원근 뷰는 보기 전용.
 */

import { roomOf } from './space-room.js';
import { clamp, roundTo } from '../../core/math-utils.js';
import { t } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { getKinematics, trajectoryPolyline, wavefrontRings, sampleBake, effectiveC, MAX_RINGS, listenerStateAt, getListenerMotion } from './space-engine.js';
import { getSpaceParams, editSpace, getActiveSource, isSourceAudible, getSpaceBake } from './space-doc.js'; // the document on screen: studio or Space Master / 화면의 문서
import { orthoView, perspView, worldNodes, splineClosed, handlePoints, hitNode, hitHandle, nearestOnSpline, moveNode, offsetNodes, moveHandle, insertNode, appendNode, deleteNodes, liftForZ, VIEW_PLANES } from './space-views.js';
import { sizeCanvas2d } from '../../ui/canvas-size.js';
import { sourceLooks, GHOST, getNodeScale } from './space-emphasis.js';

const FONT = '11px ui-monospace, Menlo, monospace';

/**
 * Source-name label next to a source dot; size from doc.view3d.nameSize (0 = hidden, 0.5 = 11 px, 1 = 22 px).
 * Shared by the top view (space-canvases.js) and the front / side / perspective views; the video export
 * (ui/studio-video.js) changes nameSize for the recording only.
 * 음원 점 옆의 이름 라벨. 크기 = view3d.nameSize (0 끔 · 0.5 = 11px · 1 = 22px).
 */
export function drawSourceName(ctx, doc, name, x, y) {
  const k = clamp(Number(doc?.view3d?.nameSize ?? 0.5), 0, 1);
  if (!(k > 0.001) || !name) return;
  const px = Math.max(4, 22 * k);
  const f = px / 11;
  const prev = ctx.font;
  ctx.font = `${px.toFixed(1)}px ui-monospace, Menlo, monospace`;
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(name, x + 9 * Math.max(1, f * 0.8), y - 8 * f);
  ctx.font = prev;
}

function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function niceStep(pxPerUnit, minPx) {
  for (const s of [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * pxPerUnit >= minPx) return s;
  return 2000;
}

/** Vertical centre of the front / side views: stored, or the middle of everything. / z 중심 */
export function viewCentre(doc) {
  let cz = typeof doc.view3d?.cz === 'number' ? doc.view3d.cz : NaN;
  if (!Number.isFinite(cz)) {
    let lo = Math.min(0, Number(doc.listener.z) || 0);
    let hi = Math.max(0, Number(doc.listener.z) || 0);
    for (const s of doc.sources) for (const q of trajectoryPolyline(s, doc)) { lo = Math.min(lo, q.z || 0); hi = Math.max(hi, q.z || 0); }
    cz = 0.5 * (lo + hi);
  }
  return { x: doc.view.cx, y: doc.view.cy, z: cz };
}

/** The box of the room (its 12 edges) when box reflections are on. `toPx(point) → {x, y}`. / 방의 상자 (모서리 12개) */
export function drawRoomBox(ctx, doc, toPx) {
  const q = doc.room?.quality;
  if (q !== 'first' && q !== 'second') return;
  const r = roomOf(doc);
  const X = [r.cx - r.w / 2, r.cx + r.w / 2], Y = [r.cy - r.d / 2, r.cy + r.d / 2], Z = [r.floorZ, r.floorZ + r.h];
  ctx.save();
  ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([]);
  const edge = (a, b) => { const p = toPx(a); const s = toPx(b); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(s.x, s.y); ctx.stroke(); };
  for (const i of [0, 1]) for (const j of [0, 1]) {
    edge({ x: X[0], y: Y[i], z: Z[j] }, { x: X[1], y: Y[i], z: Z[j] });
    edge({ x: X[i], y: Y[0], z: Z[j] }, { x: X[i], y: Y[1], z: Z[j] });
    edge({ x: X[i], y: Y[j], z: Z[0] }, { x: X[i], y: Y[j], z: Z[1] });
  }
  ctx.restore();
}

/** The listener's path (dashed) when the listener moves. `toPx(point) → {x, y}`. / 청취자 경로 (점선) */
export function drawListenerPath(ctx, doc, toPx) {
  const lm = getListenerMotion(doc);
  if (!lm) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(226, 232, 240, 0.7)';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  for (let i = 0; i <= 160; i++) {
    const st = lm.kin.stateAt((i / 160) * lm.kin.dur);
    const p = toPx(st);
    if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

// ==========================================================================
// Node editor (one per workspace) / 노드 편집기 (작업 공간당 하나)
// ==========================================================================

/**
 * @param {{ requestRender: (scopes: string[]) => void, sceneTime: () => number }} o
 */
export function createNodeEditor({ requestRender }) {
  let sel = []; // selected node ids of the active source / 활성 음원의 선택된 노드 id
  let drag = null;
  let target = 'source'; // 'source' = the active source's path, 'listener' = the listener's path / 편집 대상
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(); requestRender(['space']); };
  const activeSpline = (doc = getSpaceParams()) => {
    if (target === 'listener') { // the listener's path as a pseudo-source / 청취자 경로를 유사 음원으로
      const mv = doc.listener.move;
      return mv?.on && mv.path.type === 'spline' ? { id: 'listener', color: '#e2e8f0', path: mv.path } : null;
    }
    const s = getActiveSource(doc);
    return s && s.path.type === 'spline' ? s : null;
  };
  const cleanSel = (src) => { const ids = new Set((src?.path.spline.nodes || []).map((n) => n.id)); sel = sel.filter((id) => ids.has(id)); return sel; };
  const editSpline = (fn, ck) => editSpace((d) => {
    if (target === 'listener') { const p = d.listener.move?.path; if (p?.type === 'spline') fn(p.spline, p, d); return; }
    const s = getActiveSource(d);
    if (s?.path.type === 'spline') fn(s.path.spline, s.path, d);
  }, { coalesceKey: ck });

  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Which path the views edit: 'source' (active source) or 'listener'. / 뷰가 편집하는 경로 */
    target: () => target,
    setTarget(v) { target = v === 'listener' ? 'listener' : 'source'; sel = []; changed(); },
    activePath: () => activeSpline()?.path || null,
    selection() { return cleanSel(activeSpline()).slice(); },
    select(ids) { sel = ids.slice(); changed(); },
    isDragging: () => !!drag,
    /** Delete the selected nodes; false when nothing was selected. / 선택 노드 삭제 */
    deleteSelection() {
      const src = activeSpline();
      if (!src || !cleanSel(src).length) return false;
      const ids = sel.slice();
      editSpline((sp) => { deleteNodes(sp, ids); });
      endHistoryGesture();
      sel = [];
      changed();
      return true;
    },

    /** Draw nodes, the control polygon and the handles of selected nodes on an ortho / persp view. */
    draw(ctx, view) {
      const src = activeSpline();
      const k = getNodeScale(); // 0 = hidden (video export) / 0이면 숨김
      if (!src || k <= 0) return;
      const nodes = worldNodes(src.path);
      const closed = splineClosed(src.path.spline);
      cleanSel(src);
      ctx.save();
      ctx.font = k === 1 ? FONT : `${Math.max(4, Math.round(11 * k))}px ui-monospace, Menlo, monospace`;
      nodes.forEach((n, i) => {
        const q = view.toPx(n);
        const on = sel.includes(n.id);
        if (on) {
          const hp = handlePoints(nodes, closed, i);
          for (const side of ['in', 'out']) {
            const e = view.toPx(hp[side]);
            if (Math.hypot(e.x - q.x, e.y - q.y) < 1) continue;
            ctx.strokeStyle = 'rgba(248, 250, 252, 0.6)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(e.x, e.y); ctx.stroke();
            ctx.fillStyle = n.tangent === 'free' ? '#fbbf24' : '#94a3b8';
            ctx.beginPath(); ctx.arc(e.x, e.y, 4 * k, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.fillStyle = on ? src.color : '#0f172a';
        ctx.strokeStyle = on ? '#f8fafc' : src.color;
        ctx.lineWidth = Math.max(0.75, 2 * k);
        ctx.fillRect(q.x - 5 * k, q.y - 5 * k, 10 * k, 10 * k);
        ctx.strokeRect(q.x - 5 * k, q.y - 5 * k, 10 * k, 10 * k);
        ctx.fillStyle = '#cbd5e1';
        ctx.fillText(String(i + 1), q.x + 8 * k, q.y - 7 * k);
      });
      ctx.restore();
    },

    /** Pointer down on an orthographic view. Returns true when the node editor took the gesture. */
    down(e, view, p, tool) {
      const doc = getSpaceParams();
      const src = activeSpline(doc);
      if (!src) return false;
      const nodes = worldNodes(src.path);
      const closed = splineClosed(src.path.spline);
      cleanSel(src);
      const w = view.fromPx(p.x, p.y);
      if (tool === 'node') { // append after the last node; the third coordinate follows it / 끝에 추가
        const last = nodes[nodes.length - 1] || { x: 0, y: 0, z: 0 };
        const pt = { x: last.x, y: last.y, z: last.z, ...w };
        let made = null;
        editSpline((sp, path) => { if (view.plane !== 'top') liftForZ(path, pt.z); made = appendNode(sp, pt); });
        endHistoryGesture();
        if (made) sel = [made];
        changed();
        return true;
      }
      for (const id of sel) { // handles of the selected nodes first / 선택 노드의 핸들 먼저
        const i = nodes.findIndex((n) => n.id === id);
        const side = hitHandle(nodes, closed, i, view, p.x, p.y);
        if (side) { drag = { type: 'handle', id, side, plane: view.plane }; return true; }
      }
      const hit = hitNode(nodes, view, p.x, p.y);
      if (hit < 0) return false;
      const id = nodes[hit].id;
      if (e.shiftKey) sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      else if (!sel.includes(id)) sel = [id];
      const origin = Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y, z: n.z }])); // world z (2-D: h) / 세계 z
      drag = { type: 'node', id, plane: view.plane, start: w, origin, moved: false };
      changed();
      return true;
    },
    move(e, view, p) {
      if (!drag) return false;
      const w = view.fromPx(p.x, p.y);
      const [a, b] = VIEW_PLANES[drag.plane];
      if (drag.type === 'node') {
        const ids = sel.includes(drag.id) ? sel.slice() : [drag.id];
        const da = w[a] - drag.start[a];
        const db = w[b] - drag.start[b];
        const origin = drag.origin;
        const plane = drag.plane;
        drag.moved = true;
        editSpline((sp, path) => {
          if (b === 'z' && Math.abs(db) > 1e-6) liftForZ(path, origin[ids[0]].z + db); // vertical drag on a 2-D path → 3-D / 수직 드래그 → 3D
          if (ids.length === 1) moveNode(sp, ids[0], plane, origin[ids[0]][a] + da, origin[ids[0]][b] + db); else offsetNodes(sp, ids, plane, da, db, origin);
        }, 'space-node-drag');
      } else {
        const { id, side, plane } = drag;
        editSpline((sp) => { moveHandle(sp, id, side, plane, w[a], w[b], { broken: e.shiftKey }); }, 'space-handle-drag');
      }
      return true;
    },
    up() {
      if (!drag) return false;
      if (drag.type !== 'node' || drag.moved) endHistoryGesture();
      drag = null;
      return true;
    },
    /** Double-click: insert a node on the curve under the pointer. / 더블클릭: 곡선 위에 노드 삽입 */
    dbl(view, p) {
      const src = activeSpline();
      if (!src) return false;
      const nodes = worldNodes(src.path);
      if (hitNode(nodes, view, p.x, p.y) >= 0) return true;
      const near = nearestOnSpline(nodes, splineClosed(src.path.spline), view, p.x, p.y);
      if (near.seg < 0 || near.dist > 10) return false;
      let made = null;
      editSpline((sp) => { made = insertNode(sp, near.seg, near.f); });
      endHistoryGesture();
      if (made) sel = [made];
      changed();
      return true;
    },
  };
}

// ==========================================================================
// Extra views of the quad layout / quad 배치의 추가 뷰
// ==========================================================================

/**
 * @param {{ front: HTMLCanvasElement, side: HTMLCanvasElement, persp: HTMLCanvasElement }} els
 * @param {{ requestRender, nodeEditor, sceneTime: () => number }} o
 */
export function createExtraViews(els, { requestRender, nodeEditor, sceneTime }) {
  let drag = null;
  const pos = (e, c) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const setView = (fn) => editSpace((d) => fn(d), { history: false });

  function sourcesAt(doc, T) {
    const out = [];
    const looks = sourceLooks(doc, T);
    for (const s of doc.sources) {
      if (!isSourceAudible(s, doc) || !looks.get(s.id).lit) continue;
      const kin = getKinematics(s, doc);
      const tau = T - kin.start;
      if (tau < 0 || tau > kin.dur) continue;
      out.push({ s, st: kin.stateAt(tau), a: looks.get(s.id).a });
    }
    return out;
  }
  // Emphasis (video export): silent sources as faint rings where they are / 강조: 조용한 음원은 흐린 고리
  function drawGhosts(ctx, doc, T, toPx, r = 5) {
    const looks = sourceLooks(doc, T);
    ctx.globalAlpha = GHOST * 1.6;
    ctx.lineWidth = 1.2;
    for (const s of doc.sources) {
      if (looks.get(s.id).lit) continue;
      const kin = getKinematics(s, doc);
      const p = toPx(kin.stateAt(clamp(T - kin.start, 0, kin.dur)));
      ctx.strokeStyle = s.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const heardAt = (doc, bake, s, T) => {
    const b = bake.sources.get(s.id);
    const x = sampleBake(b, 'x', T);
    return Number.isFinite(x) ? { x, y: sampleBake(b, 'y', T), z: sampleBake(b, 'z', T) } : null;
  };

  function renderOrtho(canvas, plane) {
    const { ctx, w, h } = sizeCanvas2d(canvas);
    const doc = getSpaceParams();
    const bake = getSpaceBake(doc);
    const c = viewCentre(doc);
    const v = orthoView(plane, w, h, c, doc.view.span);
    const [a, b] = VIEW_PLANES[plane];
    const T = sceneTime();
    const L = listenerStateAt(doc, T); // where the listener is now / 지금의 청취자 위치
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    const step = niceStep(v.k, 46);
    const w0 = v.fromPx(0, h);
    const w1 = v.fromPx(w, 0);
    ctx.lineWidth = 1;
    for (let x = Math.floor(w0[a] / step) * step; x <= w1[a]; x += step) {
      const px = v.toPx({ [a]: x, [b]: 0 }).x;
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(`${roundTo(x, 1)}`, px + 3, h - 5);
    }
    for (let z = Math.floor(w0[b] / step) * step; z <= w1[b]; z += step) {
      const py = v.toPx({ [a]: 0, [b]: z }).y;
      ctx.strokeStyle = Math.abs(z) < 1e-9 ? 'rgba(45, 212, 191, 0.55)' : 'rgba(51, 65, 85, 0.35)'; // ground z = 0 / 지면
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w, py); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(`${roundTo(z, 1)}`, 4, py - 3);
    }
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(t(`space.view.${plane}`), 8, 14);
    const active = getActiveSource(doc);
    const looks = sourceLooks(doc, T, bake);
    for (const s of doc.sources) {
      const poly = trajectoryPolyline(s, doc);
      const on = s.id === active?.id;
      const aud = isSourceAudible(s, doc);
      ctx.globalAlpha = looks.get(s.id).a;
      ctx.strokeStyle = alpha(s.color, aud ? (on ? 0.85 : 0.45) : 0.18);
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.beginPath();
      poly.forEach((q, i) => { const p = v.toPx(q); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawGhosts(ctx, doc, T, (q) => v.toPx(q), 4.5);
    const cEff = effectiveC(doc);
    const ringDt = Math.max(0.01, doc.view.span / cEff / 14);
    const third = plane === 'front' ? 'y' : 'x'; // coordinate normal to the view plane / 뷰 평면에 수직인 좌표
    const showRings = doc.view3d?.rings !== false; // ◎ toggle in the monitor toolbar / 모니터 툴바의 ◎ 토글
    for (const { s, st, a } of sourcesAt(doc, T)) {
      ctx.globalAlpha = a;
      if (showRings) for (const ring of wavefrontRings(s, doc, T, ringDt, MAX_RINGS)) {
        // cross-section of the sphere with the view plane through the listener / 청취자를 지나는 뷰 평면과 구의 단면
        const d = ring[third] - L[third];
        const rr = ring.radius * ring.radius - d * d;
        if (rr <= 0) continue;
        const p = v.toPx(ring);
        ctx.strokeStyle = alpha(s.color, 0.45 * (1 - ring.k / (MAX_RINGS + 1)));
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.sqrt(rr) * v.k, 0, Math.PI * 2); ctx.stroke();
      }
      const p = v.toPx(st);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, s.id === active?.id ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
      const hp = heardAt(doc, bake, s, T);
      if (hp) {
        const q = v.toPx(hp);
        const l = v.toPx(L);
        ctx.strokeStyle = alpha(s.color, 0.5);
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(l.x, l.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    drawRoomBox(ctx, doc, (q) => v.toPx(q));
    drawListenerPath(ctx, doc, (q) => v.toPx(q));
    const l = v.toPx(L);
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath(); ctx.arc(l.x, l.y, 7, 0, Math.PI * 2); ctx.fill();
    nodeEditor.draw(ctx, v);
    return v;
  }

  function renderPersp() {
    const { ctx, w, h } = sizeCanvas2d(els.persp);
    const doc = getSpaceParams();
    const bake = getSpaceBake(doc);
    const c = viewCentre(doc);
    const v = perspView(w, h, c, doc.view.span, doc.view3d);
    const T = sceneTime();
    const L = listenerStateAt(doc, T);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.font = FONT;
    const line = (p, q) => { const a = v.project(p); const b = v.project(q); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    // ground grid (z = 0) / 바닥 격자
    const half = doc.view.span * 0.6;
    const step = niceStep(v.k, 40);
    ctx.lineWidth = 1;
    for (let g = Math.ceil((c.x - half) / step) * step; g <= c.x + half; g += step) {
      ctx.strokeStyle = Math.abs(g) < 1e-9 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(51, 65, 85, 0.3)';
      line({ x: g, y: c.y - half, z: 0 }, { x: g, y: c.y + half, z: 0 });
    }
    for (let g = Math.ceil((c.y - half) / step) * step; g <= c.y + half; g += step) {
      ctx.strokeStyle = Math.abs(g) < 1e-9 ? 'rgba(56, 189, 248, 0.3)' : 'rgba(51, 65, 85, 0.3)';
      line({ x: c.x - half, y: g, z: 0 }, { x: c.x + half, y: g, z: 0 });
    }
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(t('space.view.persp'), 8, 14);
    const active = getActiveSource(doc);
    const looks = sourceLooks(doc, T, bake);
    for (const s of doc.sources) {
      const poly = trajectoryPolyline(s, doc);
      const on = s.id === active?.id;
      const aud = isSourceAudible(s, doc);
      ctx.globalAlpha = looks.get(s.id).a;
      // shadow on the ground and drop lines give the depth / 바닥 그림자와 수직 낙하선으로 깊이 표시
      ctx.strokeStyle = alpha(s.color, 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      poly.forEach((q, i) => { const p = v.project({ x: q.x, y: q.y, z: 0 }); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke();
      const drops = s.path.type === 'spline' ? worldNodes(s.path) : poly.filter((_, i) => i % 30 === 0);
      ctx.strokeStyle = alpha(s.color, 0.3);
      ctx.setLineDash([2, 3]);
      for (const q of drops) if (Math.abs(q.z || 0) > 1e-6) line(q, { x: q.x, y: q.y, z: 0 });
      ctx.setLineDash([]);
      ctx.strokeStyle = alpha(s.color, aud ? (on ? 0.9 : 0.5) : 0.2);
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.beginPath();
      poly.forEach((q, i) => { const p = v.project(q); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    drawGhosts(ctx, doc, T, (q) => v.project(q), 5);
    for (const { s, st, a } of sourcesAt(doc, T)) {
      ctx.globalAlpha = a;
      const p = v.project(st);
      ctx.strokeStyle = alpha(s.color, 0.5);
      ctx.lineWidth = 1;
      line(st, { x: st.x, y: st.y, z: 0 });
      const sc = Math.min(1, 60 / Math.max(1e-6, st.speed * v.k));
      const tip = v.project({ x: st.x + st.vx * sc, y: st.y + st.vy * sc, z: st.z + st.vz * sc });
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, (s.id === active?.id ? 7 : 5.5) * clamp(p.scale, 0.6, 1.6), 0, Math.PI * 2); ctx.fill();
      drawSourceName(ctx, doc, s.name, p.x, p.y);
      const hp = heardAt(doc, bake, s, T);
      if (hp) {
        const q = v.project(hp);
        const l = v.project(L);
        ctx.strokeStyle = alpha(s.color, 0.55);
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(l.x, l.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // listener with its facing direction / 청취자와 정면 방향
    drawRoomBox(ctx, doc, (q) => v.project(q));
    drawListenerPath(ctx, doc, (q) => v.project(q));
    const hd = (L.headingDeg * Math.PI) / 180;
    const pt = (L.pitchDeg * Math.PI) / 180;
    const nl = 4 * (doc.view.span / 120);
    const nose = { x: L.x + nl * Math.sin(hd) * Math.cos(pt), y: L.y + nl * Math.cos(hd) * Math.cos(pt), z: L.z + nl * Math.sin(pt) };
    const l = v.project(L);
    const nz = v.project(nose);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(nz.x, nz.y); ctx.stroke();
    if (Math.abs(L.z) > 1e-6) { ctx.lineWidth = 1; ctx.setLineDash([2, 3]); line(L, { x: L.x, y: L.y, z: 0 }); ctx.setLineDash([]); }
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath(); ctx.arc(l.x, l.y, 7, 0, Math.PI * 2); ctx.fill();
    nodeEditor.draw(ctx, v);
    return v;
  }

  const views = {};
  const wire = (canvas, plane) => {
    const down = (e) => {
      if (e.button !== 0 || e.altKey) return;
      const doc = getSpaceParams();
      const v = views[plane];
      if (!v) return;
      const p = pos(e, canvas);
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
      if (plane !== 'persp') {
        if (nodeEditor.down(e, v, p, doc.tool)) { drag = { type: 'node' }; return; }
        drag = { type: 'pan', x: p.x, y: p.y, centre: viewCentre(doc), k: v.k };
        return;
      }
      const src = getActiveSource(doc);
      if (src?.path.type === 'spline') {
        const hit = hitNode(worldNodes(src.path), v, p.x, p.y);
        if (hit >= 0) { nodeEditor.select([src.path.spline.nodes[hit].id]); return; }
      }
      drag = { type: 'orbit', x: p.x, y: p.y, az: doc.view3d.az, el: doc.view3d.el };
    };
    const move = (e) => {
      if (!drag) return;
      const p = pos(e, canvas);
      if (drag.type === 'node') nodeEditor.move(e, views[plane], p);
      else if (drag.type === 'pan') {
        const [a, b] = VIEW_PLANES[plane];
        const da = -(p.x - drag.x) / drag.k;
        const db = (p.y - drag.y) / drag.k;
        setView((d) => {
          const set = (axis, val) => { if (axis === 'x') d.view.cx = roundTo(val, 2); else if (axis === 'y') d.view.cy = roundTo(val, 2); else d.view3d.cz = roundTo(val, 2); };
          set(a, drag.centre[a] + da);
          set(b, drag.centre[b] + db);
        });
      } else if (drag.type === 'orbit') {
        setView((d) => { d.view3d.az = roundTo(drag.az + (p.x - drag.x) * 0.5, 1); d.view3d.el = clamp(roundTo(drag.el + (p.y - drag.y) * 0.4, 1), -5, 89); });
      }
    };
    const up = (e) => {
      if (drag?.type === 'node') nodeEditor.up();
      drag = null;
      try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
      requestRender(['space']);
    };
    const wheel = (e) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      if (plane === 'persp') setView((d) => { d.view3d.dist = clamp(roundTo(d.view3d.dist * f, 3), 0.4, 8); });
      else setView((d) => { d.view.span = roundTo(clamp(d.view.span * f, 10, 3000), 2); });
    };
    const dbl = (e) => { if (plane !== 'persp' && !e.altKey && views[plane]) nodeEditor.dbl(views[plane], pos(e, canvas)); };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('dblclick', dbl);
  };
  wire(els.front, 'front');
  wire(els.side, 'side');
  wire(els.persp, 'persp');
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => requestRender(['space'])) : null;
  for (const c of [els.front, els.side, els.persp]) ro?.observe(c);

  return {
    render() {
      if (!els.front.isConnected || els.front.clientWidth < 4) return;
      views.front = renderOrtho(els.front, 'front');
      views.side = renderOrtho(els.side, 'side');
      views.persp = renderPersp();
    },
    destroy() { ro?.disconnect(); },
  };
}
