/**
 * Flexatone — studios/grid/grid-layout.js
 * Grid Studio (pure): the geometry of the two windows — Editor (the painted Cartesian grid) and
 * Result (what comes out of the effect stack) — and the resize lock between them. No DOM: the panels
 * apply these numbers, the self-checks test them directly.
 * 그리드 스튜디오 (순수): Editor / Result 두 윈도우의 기하와 리사이즈 락. DOM 없음.
 *
 *   one view        { tMin, tMax, midiMin, midiMax } is shared: both windows always show the same time
 *                   and pitch range (zoom, pan, playhead, cue, cursor cross-hair), locked or not.
 *   same metrics    gridMetrics(w, h, view) gives the plot rectangle and the value ↔ pixel maps; equal
 *                   window sizes → identical metrics.
 *   resize lock     locked (default): resizing either window sets both to the same size.
 *                   unlocked: each window keeps its own height. Locking again makes both the size of
 *                   the window adjusted last, at once.
 *   layout          'stack' (Editor above Result: the same time is at the same x) or 'side'
 *                   (Editor | Result). A narrow container falls back to 'stack'. Widths are always
 *                   equal; the lock is about the heights.
 * The state is a view preference (localStorage), never part of the document or of undo.
 * 상태는 보기 설정(localStorage)이며 문서·실행 취소에 들어가지 않음.
 */

export const DUAL_MIN_H = 120;
export const DUAL_MAX_H = 1400;
export const DUAL_GAP = 8;
/** Container width below which 'side' is shown stacked. / 이보다 좁으면 가로 배치를 세로로 전환 */
export const DUAL_NARROW_W = 760;
export const DUAL_DEFAULT = Object.freeze({ lock: true, layout: 'stack', hE: 280, hR: 280, last: 'editor' });
/** Margins around the plot (axis labels). The same for both windows. / 플롯 주변 여백 (두 윈도우 공통) */
export const PLOT_PAD = Object.freeze({ left: 46, right: 8, top: 16, bottom: 20 });

const clampH = (h) => Math.round(Math.min(DUAL_MAX_H, Math.max(DUAL_MIN_H, Number.isFinite(Number(h)) ? Number(h) : DUAL_DEFAULT.hE)));

/** Valid state from anything (a stored string's parse result, a partial object). / 상태 정규화 */
export function normalizeDual(raw) {
  const st = {
    lock: raw?.lock !== false,
    layout: raw?.layout === 'side' ? 'side' : 'stack',
    hE: clampH(raw?.hE),
    hR: clampH(raw?.hR),
    last: raw?.last === 'result' ? 'result' : 'editor',
  };
  if (st.lock) st.hR = st.hE = st.last === 'result' ? st.hR : st.hE;
  return st;
}

/** Resize one window. Locked: both get the size. Unlocked: only that window. / 윈도우 하나 크기 변경 */
export function resizePane(st, pane, h) {
  const v = clampH(h);
  const next = { ...st, last: pane === 'result' ? 'result' : 'editor' };
  if (st.lock) { next.hE = v; next.hR = v; } else if (next.last === 'result') next.hR = v; else next.hE = v;
  return next;
}

/** Toggle the lock. Locking again syncs both to the window adjusted last, at once. / 락 토글 (재잠금 시 즉시 동기화) */
export function toggleDualLock(st) {
  if (st.lock) return { ...st, lock: false };
  const h = st.last === 'result' ? st.hR : st.hE;
  return { ...st, lock: true, hE: h, hR: h };
}

export const setDualLayout = (st, layout) => ({ ...st, layout: layout === 'side' ? 'side' : 'stack' });

/** Layout actually shown for a container width. / 컨테이너 폭에 따른 실제 배치 */
export const effectiveLayout = (st, containerW) => (st.layout === 'side' && containerW >= DUAL_NARROW_W ? 'side' : 'stack');

/**
 * CSS sizes of the two windows inside a container of width `containerW`.
 * 컨테이너 폭에 대한 두 윈도우의 CSS 크기.
 * @returns {{ layout: 'stack'|'side', editor: { w: number, h: number }, result: { w: number, h: number }, total: number }}
 */
export function dualSizes(st, containerW) {
  const layout = effectiveLayout(st, containerW);
  const w = Math.max(120, Math.floor(layout === 'side' ? (containerW - DUAL_GAP) / 2 : containerW));
  const total = layout === 'side' ? Math.max(st.hE, st.hR) : st.hE + st.hR + DUAL_GAP;
  return { layout, editor: { w, h: st.hE }, result: { w, h: st.hR }, total };
}

/**
 * A new total height of the pair (the shared ◢ corner handle of the window rack). Locked: both
 * windows share it equally. Unlocked: the window adjusted last takes the change.
 * 한 쌍의 전체 높이 변경 (랙의 공용 ◢ 손잡이). 잠금: 똑같이 나눔. 해제: 마지막에 조정한 윈도우가 변화를 받음.
 */
export function applyDualTotal(st, total, containerW) {
  const layout = effectiveLayout(st, containerW);
  if (layout === 'side') {
    if (st.lock) return resizePane(st, st.last, total);
    return resizePane(st, st.last, total);
  }
  if (st.lock) return resizePane(st, st.last, (total - DUAL_GAP) / 2);
  const other = st.last === 'result' ? st.hE : st.hR;
  return resizePane(st, st.last, total - DUAL_GAP - other);
}

/** Stored form (string) and back. / 저장 형식 */
export const serializeDual = (st) => JSON.stringify({ lock: st.lock, layout: st.layout, hE: st.hE, hR: st.hR, last: st.last });
export function parseDual(str) {
  try { return normalizeDual(JSON.parse(str || '{}')); } catch { return normalizeDual(null); }
}

/**
 * Coordinate system of one window: plot rectangle + value ↔ pixel maps. Depends only on the CSS size
 * and the shared view, so two windows of the same size have identical metrics.
 * 윈도우 하나의 좌표계 (플롯 사각형 + 값 ↔ 픽셀). CSS 크기와 공유 뷰에만 의존.
 */
export function gridMetrics(w, h, view) {
  const m = { w, h, view, plotX: PLOT_PAD.left, plotY: PLOT_PAD.top, plotW: Math.max(40, w - PLOT_PAD.left - PLOT_PAD.right), plotH: Math.max(30, h - PLOT_PAD.top - PLOT_PAD.bottom) };
  const tSpan = Math.max(0.05, view.tMax - view.tMin);
  const mSpan = Math.max(1, view.midiMax - view.midiMin);
  m.timeToX = (sec) => m.plotX + ((sec - view.tMin) / tSpan) * m.plotW;
  m.xToTime = (px) => view.tMin + ((px - m.plotX) / m.plotW) * tSpan;
  m.midiToY = (midi) => m.plotY + (1 - (midi - view.midiMin) / mSpan) * m.plotH;
  m.yToMidi = (py) => view.midiMin + (1 - (py - m.plotY) / m.plotH) * mSpan;
  m.inPlot = (p) => p.x >= m.plotX && p.x <= m.plotX + m.plotW && p.y >= m.plotY && p.y <= m.plotY + m.plotH;
  return m;
}

/** The comparable part of metrics (for "the two windows are identical"). / 비교용 수치 */
export const metricsKey = (m) => `${m.w}x${m.h}|${m.plotX},${m.plotY},${m.plotW},${m.plotH}`;
