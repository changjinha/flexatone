/**
 * Flexatone — ui/locate-tool.js
 * Shared Locate tool for every studio with time × pitch objects (same behaviour as the Glissando
 * window's ✥ Locate): drag an object's body to move it in time and pitch, drag its start / end dot
 * to move that end. 🧲 Snap rounds to 0.1 s and whole semitones.
 * 공용 이동(Locate) 도구 — 글리산도 창과 같은 동작: 본체 드래그 = 시간·음고 이동,
 * 시작·끝 점 드래그 = 그 끝을 이동. 🧲 스냅 = 0.1초 / 반음 단위.
 *
 * State: appState.locateMode / appState.locateSnap — the same prefs as the Glissando toolbar, so
 * the tool is on or off everywhere at once. Locate and Glissando's Select stay exclusive.
 * 상태는 글리산도 툴바와 같은 appState.locateMode / locateSnap (모든 창에서 동시에 켜고 끔).
 *
 * Use / 사용
 *   const buttons = createLocateButtons();            // [✥ Locate, 🧲 Snap] + buttons.sync()
 *   const locate = attachLocate(canvas, adapter);     // capture-phase pointer controller
 *   locate.draw(ctx, activeId);                       // start / end dots, at the end of render
 * adapter = {
 *   enabled?(): boolean,                  // extra gate (e.g. field OFF)
 *   items(): [{ id, poly: [{x, y}] | [[{x, y}]], start?: {x, y}, end?: {x, y}, color }],   // canvas-local px
 *   toWorld(p): { sec, midi | null },     // midi null → time only (non-pitch view)
 *   begin(id): snapshot,                  // copy of the object before the drag
 *   apply(id, kind, w),                   // kind 'move' | 'start' | 'end'; w = { orig, dSec, dSemi, sec, midi }
 *   select?(id), commit?(),               // commit defaults to endHistoryGesture()
 *   startOf?(id): sec                     // where the object starts sounding — on drop the studio
 *                                         // plays from here; the cue line does not move
 *   trim?(id, side, w),                   // ⌘ (Ctrl) + drag along x: move that end of the line ALONG its
 *                                         // curve (core/line-clip.js); side 'start' | 'end', w = { orig, sec }.
 *                                         // On the body the nearer end is taken. Pointer y is ignored.
 *   split?(id, sec),                      // double-click a line: cut it there into linked pieces (🔗)
 * }
 * ⌘ + drag / 줄이기·늘리기: 선의 끝을 곡선을 따라 이동 (y 무시). 더블클릭 / 자르기: 그 자리에서 링크된 두 조각으로.
 * The controller listens in the capture phase and only swallows events it handles, so the
 * studio's own tools (pan, nodes, regions, drawing) keep working when Locate is off or nothing
 * is hit. / 캡처 단계에서 처리한 이벤트만 가로채므로 스튜디오 자체 도구는 그대로 동작.
 */

import { appState, setPref, endHistoryGesture, setTransport } from '../core/state.js';
import { t, I18N } from '../core/i18n.js';

// Why Locate is off in a studio whose lines are generated (shown on the disabled buttons).
// 선이 생성되는 스튜디오에서 이동 도구가 꺼져 있는 이유 (비활성 버튼에 표시)
Object.assign(I18N.en, {
  'locate.altDbl': 'Shift + double-click on the timeline: play from there (the cue stays)',
  'locate.na.generated': 'Locate is not available in this studio: its lines are generated from the settings, so there is no single object to move, trim, split or link (🔗). Shift + double-click on the timeline plays from there.',
  'locate.na.wave': 'Locate is not needed in this studio: drag a pulse or a driver directly on the canvas (its lines are generated, so they are not trimmed, split or linked). Shift + double-click on the timeline plays from there.',
});
Object.assign(I18N.ko, {
  'locate.altDbl': '타임라인 Shift + 더블클릭: 그 자리부터 재생 (큐는 그대로)',
  'locate.na.generated': '이 스튜디오에서는 이동 도구를 쓸 수 없습니다: 선이 설정값에서 생성되므로 옮기거나 자르거나 링크(🔗)할 개별 대상이 없습니다. 타임라인을 Shift + 더블클릭하면 그 자리부터 재생합니다.',
  'locate.na.wave': '이 스튜디오에서는 이동 도구가 필요 없습니다: 펄스와 구동원을 캔버스에서 바로 드래그합니다 (선이 생성되므로 자르기·링크는 없음). 타임라인을 Shift + 더블클릭하면 그 자리부터 재생합니다.',
});

const HIT_END = 9;
const HIT_BODY = 7;

/**
 * Play the studio on screen from `sec` without moving the cue (Locate drop, Shift + double-click).
 * The lazy import keeps this shared module free of an import cycle with the studio host.
 * 큐를 옮기지 않고 sec부터 재생 (이동 도구로 놓았을 때, Shift + 더블클릭). 순환 import를 피하려고 지연 import.
 */
export function auditionFrom(sec) {
  if (!Number.isFinite(sec)) return;
  import('./studio-host.js').then((h) => h.activeTransport()?.playFrom?.(Math.max(0, sec))).catch((err) => console.error(err));
}

/**
 * Double-click on a studio timeline: set the cue there; with Shift, play from there and leave the
 * cue where it is. One rule for every studio. / 타임라인 더블클릭 = 큐 이동, Shift + 더블클릭 = 큐는 두고 그 자리부터 재생
 */
export function cueOrAudition(e, sec) {
  if (e.shiftKey) auditionFrom(sec);
  else setTransport({ cueSec: sec });
}

/** Snap helpers shared with the Glissando canvas rule (0.1 s, 1 semitone). / 스냅 규칙 */
export const locateSnapTime = (sec) => (appState.locateSnap ? Math.round(sec * 10) / 10 : sec);
export const locateSnapSemis = (d) => (appState.locateSnap ? Math.round(d) : d);

/** Toggle Locate (exclusive with Glissando's Select). / 이동 모드 토글 */
export function toggleLocateMode(on = !appState.locateMode) {
  if (on && appState.selectMode) setPref('selectMode', false, ['canvas', 'view', 'panels']);
  setPref('locateMode', !!on, ['canvas', 'view']);
}

/**
 * ✥ Locate and 🧲 Snap buttons for a studio toolbar. Call `buttons.sync()` on render.
 * `unavailable` (an i18n key): the studio has nothing Locate could move — the buttons stay in
 * their usual place, switched off, and say why. / unavailable(번역 키): 옮길 대상이 없는 스튜디오 —
 * 버튼은 제자리에 꺼진 채로 이유를 표시.
 * 스튜디오 툴바용 이동·스냅 버튼.
 */
export function createLocateButtons({ className = 'px-2 py-1 rounded-lg border text-[11px] font-medium transition', unavailable = null } = {}) {
  if (unavailable) {
    const off = (icon, labelKey) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${className} bg-slate-950 border-slate-800 text-slate-600 cursor-not-allowed`;
      b.dataset.help = 'gliss.locate';
      b.dataset.locateOff = unavailable;
      b.setAttribute('aria-disabled', 'true');
      b.title = t(unavailable);
      b.append(`${icon} `, Object.assign(document.createElement('span'), { textContent: t(labelKey) }));
      return b;
    };
    const buttons = [off('✥', 'view.locate'), off('🧲', 'view.snap')];
    buttons.sync = () => {};
    return buttons;
  }
  const mk = (icon, labelKey, help, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.dataset.help = help;
    b.append(`${icon} `, Object.assign(document.createElement('span'), { textContent: t(labelKey) }));
    b.addEventListener('click', onClick);
    return b;
  };
  const locate = mk('✥', 'view.locate', 'gliss.locate', () => toggleLocateMode());
  const snap = mk('🧲', 'view.snap', 'gliss.snap', () => setPref('locateSnap', !appState.locateSnap, ['view']));
  locate.title = `${t('tip.locateStudio')} · ${t('clip.locateHint')} · ${t('locate.altDbl')}`;
  snap.title = t('tip.snap');
  const paint = (b, on, tone) => {
    b.className = `${className} ${on ? tone : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'}`;
    b.setAttribute('aria-pressed', String(on));
  };
  const buttons = [locate, snap];
  buttons.sync = () => {
    paint(locate, !!appState.locateMode, 'bg-sky-600 border-sky-400 text-white');
    paint(snap, !!appState.locateSnap, 'bg-slate-700 border-slate-500 text-white');
  };
  buttons.sync();
  return buttons;
}

function distToPolyline(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const u = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy)));
  }
  return best;
}

/** Hit test against adapter items: end dots first, then bodies (topmost = last). / 히트 테스트 */
export function locateHitTest(items, p) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    for (const kind of ['start', 'end']) {
      const q = it[kind];
      if (q && Math.hypot(p.x - q.x, p.y - q.y) <= HIT_END) return { id: it.id, kind };
    }
  }
  let best = null;
  let bestD = HIT_BODY;
  for (let i = items.length - 1; i >= 0; i--) {
    const poly = items[i].poly || [];
    // poly = one polyline [{x, y}] or several [[{x, y}], …] (pieces with gaps) / 폴리라인 1개 또는 여러 개
    for (const pts of Array.isArray(poly[0]) ? poly : [poly]) {
      if (pts.length < 2) continue;
      const d = distToPolyline(p, pts);
      if (d < bestD) { bestD = d; best = { id: items[i].id, kind: 'move' }; }
    }
  }
  return best;
}

/**
 * Attach the Locate controller to a time × pitch canvas. / 시간 × 음고 캔버스에 이동 컨트롤러 연결
 * @returns {{ draw(ctx, activeId?): void, isDragging(): boolean, destroy(): void }}
 */
export function attachLocate(canvas, adapter) {
  let drag = null;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.clientWidth, y: ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.clientHeight };
  };
  const live = () => !!appState.locateMode && (adapter.enabled ? adapter.enabled() !== false : true);
  const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };

  const onDown = (e) => {
    if (e.button !== 0 || !live()) return;
    const p = pos(e);
    const items = adapter.items() || [];
    const hit = locateHitTest(items, p);
    if (!hit) return;
    swallow(e);
    adapter.select?.(hit.id);
    const w0 = adapter.toWorld(p);
    let kind = hit.kind;
    let side = null;
    if ((e.metaKey || e.ctrlKey) && adapter.trim) {
      // ⌘ + drag: trim / extend along the curve; on the body, the nearer end / 몸통이면 가까운 끝
      const it = items.find((x) => x.id === hit.id);
      let ends = it?.start && it?.end ? [it.start.x, it.end.x] : null;
      if (!ends && it?.poly?.length) { // no end dots: the drawn extent / 끝 점이 없으면 그린 범위
        const xs = (Array.isArray(it.poly[0]) ? it.poly.flat() : it.poly).map((q) => q.x);
        ends = [Math.min(...xs), Math.max(...xs)];
      }
      side = hit.kind !== 'move' ? hit.kind : ends ? (Math.abs(p.x - ends[0]) <= Math.abs(p.x - ends[1]) ? 'start' : 'end') : 'end';
      kind = 'trim';
    }
    drag = { id: hit.id, kind, side, w0, orig: adapter.begin(hit.id), moved: false, p0: p };
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    canvas.style.cursor = hit.kind === 'move' ? 'grabbing' : 'ew-resize';
  };
  const onMove = (e) => {
    if (!drag) {
      if (!live()) return;
      const hit = locateHitTest(adapter.items() || [], pos(e));
      if (hit) {
        // Let the studio update its HUD first, then show the Locate cursor / HUD 갱신 후 커서
        const cur = hit.kind === 'move' ? 'move' : 'ew-resize';
        requestAnimationFrame(() => { if (appState.locateMode) canvas.style.cursor = cur; });
      }
      return;
    }
    swallow(e);
    const p = pos(e);
    if (!drag.moved && Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) < 2) return;
    drag.moved = true;
    const w = adapter.toWorld(p);
    if (drag.kind === 'trim') { adapter.trim(drag.id, drag.side, { orig: drag.orig, sec: locateSnapTime(w.sec) }); return; }
    const pitch = w.midi != null && drag.w0.midi != null;
    adapter.apply(drag.id, drag.kind, {
      orig: drag.orig,
      dSec: w.sec - drag.w0.sec,
      dSemi: pitch ? locateSnapSemis(w.midi - drag.w0.midi) : 0,
      sec: locateSnapTime(w.sec),
      midi: pitch ? locateSnapSemis(w.midi) : null,
      snapTime: locateSnapTime,
    });
  };
  const onUp = (e) => {
    if (!drag) return;
    swallow(e);
    const moved = drag.moved;
    const id = drag.id;
    drag = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    canvas.style.cursor = '';
    if (!moved) return;
    (adapter.commit || endHistoryGesture)();
    // Audition: play the studio from the dropped object's start, cue untouched / 놓은 대상의 시작부터 재생 (큐는 그대로)
    auditionFrom(adapter.startOf?.(id));
  };
  // Double-click a line: ✂ split it there (only when the studio supports it) / 선 더블클릭: 자르기
  const onDbl = (e) => {
    if (!live() || !adapter.split) return;
    const p = pos(e);
    const hit = locateHitTest(adapter.items() || [], p);
    if (!hit || hit.kind !== 'move') return;
    swallow(e);
    endHistoryGesture();
    adapter.split(hit.id, locateSnapTime(adapter.toWorld(p).sec));
    endHistoryGesture();
  };
  canvas.addEventListener('dblclick', onDbl, true);
  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointercancel', onUp, true);

  return {
    /** Start / end dots in the Glissando Locate style (only while Locate is on). / 시작·끝 점 */
    draw(ctx, activeId = null) {
      if (!live()) return;
      for (const it of adapter.items() || []) {
        const on = it.id === activeId;
        for (const q of [it.start, it.end]) {
          if (!q) continue;
          ctx.save();
          ctx.fillStyle = '#f8fafc';
          ctx.strokeStyle = it.color || '#38bdf8';
          ctx.lineWidth = on ? 2.4 : 1.6;
          ctx.globalAlpha = on ? 1 : 0.75;
          ctx.beginPath();
          ctx.arc(q.x, q.y, on ? 5.5 : 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
    },
    isDragging: () => !!drag,
    /** True while a ⌘-drag trim is running. / ⌘ 드래그 중 */
    isTrimming: () => drag?.kind === 'trim',
    destroy() {
      canvas.removeEventListener('dblclick', onDbl, true);
      canvas.removeEventListener('pointerdown', onDown, true);
      canvas.removeEventListener('pointermove', onMove, true);
      canvas.removeEventListener('pointerup', onUp, true);
      canvas.removeEventListener('pointercancel', onUp, true);
    },
  };
}
