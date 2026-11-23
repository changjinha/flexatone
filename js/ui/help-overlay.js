/**
 * Flexatone — ui/help-overlay.js
 * Layer 4 (ui): full-screen Help mode (H). Dims the app, outlines every documented control, and
 * explains it on hover (popover) or click (detailed modal).
 * 계층 4 (ui): 전체 화면 도움말 모드 (H). 화면을 어둡게 하고 설명이 있는 모든 컨트롤에 상자를
 * 그린 뒤, 마우스 오버(팝오버)·클릭(상세 모달)으로 역할을 보여 줌.
 *
 * How it works / 동작
 *   - Targets = visible elements whose own data-help / id resolves in HELP_DB (option-inspector).
 *     A target is skipped when its nearest documented ancestor has the same key, and neighbouring
 *     boxes with the same key (gap < 10 px) are merged into one.
 *   - A canvas dims the viewport and clears a hole over each target, so controls stay readable.
 *   - Boxes are real DOM elements above the app, so hover works on every control — including
 *     disabled buttons and canvases — and the app underneath never receives the clicks.
 *   - Wheel events are forwarded to the scroll container under the pointer; boxes are re-measured
 *     on scroll / resize / DOM changes.
 *   H toggles · Esc closes (after a detail modal, if one is open) · click empty space closes.
 */

import { t } from '../core/i18n.js';
import { getHelp, ownHelpKey, openHelpModal, isHelpModalOpen } from './option-inspector.js';

const MERGE_GAP = 10;
const HOLE_PAD = 3;

let active = false;
let root = null;
let canvas = null;
let layer = null;
let pop = null;
let hint = null;
let boxes = [];
let raf = 0;
let mo = null;
let hoverBox = null;
let moTimer = 0;

const isTyping = (el) => {
  const tag = el?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable;
};

/** Visible rect of `el` after clipping by overflow ancestors and the viewport. / 보이는 영역 */
function visibleRect(el) {
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
  const r = el.getBoundingClientRect();
  let l = r.left;
  let tp = r.top;
  let rt = r.right;
  let b = r.bottom;
  for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const ar = a.getBoundingClientRect();
      l = Math.max(l, ar.left);
      tp = Math.max(tp, ar.top);
      rt = Math.min(rt, ar.right);
      b = Math.min(b, ar.bottom);
    }
  }
  // Content scrolled under a sticky / fixed bar is hidden by it / 고정 바 아래로 스크롤된 내용은 가림
  for (const bar of stickyBars) {
    if (bar.el.contains(el)) continue;
    if (bar.r.top <= 0 + 1 && tp < bar.r.bottom) tp = Math.max(tp, bar.r.bottom);
  }
  l = Math.max(l, 0);
  tp = Math.max(tp, 0);
  rt = Math.min(rt, window.innerWidth);
  b = Math.min(b, window.innerHeight);
  if (rt - l < 4 || b - tp < 4) return null;
  // Skip controls covered by something else (menus, modals of the app) / 다른 요소에 가려진 컨트롤 제외
  const cx = (l + rt) / 2;
  const cy = (tp + b) / 2;
  const top = document.elementsFromPoint(cx, cy).find((n) => !root?.contains(n));
  if (top && top !== el && !el.contains(top) && !top.contains(el)) return null;
  return { l, t: tp, r: rt, b };
}

function nearestDocumentedAncestorKey(el) {
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const k = ownHelpKey(a);
    if (k) return k;
  }
  return null;
}

let stickyBars = [];

/** Top-level sticky / fixed bars pinned to the top edge (e.g. the header). / 위쪽 고정 바 */
function findStickyBars() {
  const out = [];
  for (const el of document.body.querySelectorAll('header, [data-sticky], body > *, body > * > *')) {
    if (root?.contains(el)) continue;
    const pos = getComputedStyle(el).position;
    if (pos !== 'sticky' && pos !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top <= 1 && r.height < window.innerHeight * 0.6) out.push({ el, r });
  }
  return out;
}

/** Collect, dedupe and merge help targets. / 도움말 대상 수집·병합 */
export function collectHelpTargets() {
  stickyBars = findStickyBars();
  const byKey = new Map();
  for (const el of document.querySelectorAll('[data-help], [id]')) {
    if (root?.contains(el)) continue;
    const key = ownHelpKey(el);
    if (!key || !getHelp(key)) continue;
    if (nearestDocumentedAncestorKey(el) === key) continue;
    const rect = visibleRect(el);
    if (!rect) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rect);
  }
  const out = [];
  for (const [key, rects] of byKey) {
    // Merge neighbours with the same key until stable / 같은 키의 인접 상자 병합
    let list = rects.slice();
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const c = list[j];
          if (a.l - MERGE_GAP <= c.r && c.l - MERGE_GAP <= a.r && a.t - MERGE_GAP <= c.b && c.t - MERGE_GAP <= a.b) {
            list[i] = { l: Math.min(a.l, c.l), t: Math.min(a.t, c.t), r: Math.max(a.r, c.r), b: Math.max(a.b, c.b) };
            list.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    for (const r of list) out.push({ key, ...r });
  }
  // Larger first so smaller (nested) boxes sit on top / 작은 상자가 위에 오도록
  out.sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t));
  return out;
}

// --------------------------------------------------------------------------
// Rendering / 렌더링
// --------------------------------------------------------------------------

function drawDim(targets) {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(2, 6, 23, 0.74)';
  ctx.fillRect(0, 0, w, h);
  for (const r of targets) ctx.clearRect(r.l - HOLE_PAD, r.t - HOLE_PAD, r.r - r.l + 2 * HOLE_PAD, r.b - r.t + 2 * HOLE_PAD);
}

function render() {
  raf = 0;
  if (!active) return;
  const targets = collectHelpTargets();
  drawDim(targets);
  const hoveredKey = hoverBox?.dataset.key;
  layer.replaceChildren();
  boxes = targets.map((r) => {
    const b = document.createElement('div');
    b.className = 'fx-help-box';
    b.dataset.key = r.key;
    Object.assign(b.style, { left: `${r.l - HOLE_PAD}px`, top: `${r.t - HOLE_PAD}px`, width: `${r.r - r.l + 2 * HOLE_PAD}px`, height: `${r.b - r.t + 2 * HOLE_PAD}px` });
    b.addEventListener('pointerenter', () => showPop(b));
    b.addEventListener('pointerleave', () => { if (hoverBox === b) hidePop(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); openHelpModal(r.key); });
    layer.append(b);
    return b;
  });
  hint.textContent = t('help.hint', boxes.length);
  // Keep the popover on the same control after a re-measure / 재측정 후에도 팝오버 유지
  if (hoveredKey) {
    const again = boxes.find((b) => b.dataset.key === hoveredKey);
    if (again) showPop(again);
    else hidePop();
  }
}

const schedule = () => { if (active && !raf) raf = requestAnimationFrame(render); };

function showPop(box) {
  const h = getHelp(box.dataset.key);
  if (!h) return;
  hoverBox?.classList.remove('is-hover');
  hoverBox = box;
  box.classList.add('is-hover');
  pop.replaceChildren();
  const title = document.createElement('div');
  title.className = 'text-[13px] font-bold text-violet-200';
  title.textContent = h.title;
  const sum = document.createElement('div');
  sum.className = 'text-[12px] text-slate-100';
  sum.textContent = h.summary;
  pop.append(title, sum);
  if (h.detail) {
    const d = document.createElement('div');
    d.className = 'text-[11px] leading-relaxed text-slate-400';
    d.textContent = h.detail;
    pop.append(d);
  }
  if (h.formula) {
    const f = document.createElement('code');
    f.className = 'block px-2 py-1 rounded bg-slate-950 border border-slate-800 font-mono text-[11px] text-sky-200 whitespace-pre-wrap';
    f.textContent = h.formula;
    pop.append(f);
  }
  const more = document.createElement('div');
  more.className = 'text-[10px] text-violet-300/80';
  more.textContent = t('help.clickMore');
  pop.append(more);
  pop.classList.remove('hidden');
  // Place below the box, else above, clamped to the viewport / 아래, 안 되면 위
  const r = box.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 8) top = r.top - ph - 8;
  if (top < 8) top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.top + 8));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hidePop() {
  hoverBox?.classList.remove('is-hover');
  hoverBox = null;
  pop?.classList.add('hidden');
}

/** Forward the wheel to whatever would have scrolled under the pointer. / 휠 전달 */
function onWheel(e) {
  e.preventDefault();
  const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => !root.contains(el));
  for (let a = under; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    const canY = /(auto|scroll)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1;
    const canX = /(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1;
    if ((canY && e.deltaY) || (canX && e.deltaX)) { a.scrollBy(e.deltaX, e.deltaY); return; }
  }
  window.scrollBy(e.deltaX, e.deltaY);
}

// --------------------------------------------------------------------------
// Open / close / 열기·닫기
// --------------------------------------------------------------------------

// Collapsed <details> panels that help mode expanded (restored on close). / 도움말 모드가 펼친 접힌 패널
let expanded = [];

function expandCollapsedPanels() {
  expanded = [];
  for (const d of document.querySelectorAll('details:not([open])')) {
    if (d.querySelector('[data-help]')) { d.open = true; expanded.push(d); }
  }
}

export function openHelpOverlay() {
  if (active) return;
  active = true;
  expandCollapsedPanels();
  root = document.createElement('div');
  root.className = 'fx-help-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('help.title'));
  canvas = document.createElement('canvas');
  canvas.className = 'fx-help-dim';
  layer = document.createElement('div');
  layer.className = 'fx-help-layer';
  pop = document.createElement('div');
  pop.className = 'fx-help-pop hidden';
  hint = document.createElement('div');
  hint.className = 'fx-help-hint';
  root.append(canvas, layer, pop, hint);
  root.addEventListener('click', (e) => { if (e.target === root || e.target === layer || e.target === hint) closeHelpOverlay(); });
  root.addEventListener('wheel', onWheel, { passive: false });
  document.body.append(root);
  document.getElementById('btnHelpMode')?.setAttribute('aria-pressed', 'true');
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  // DOM changes (re-renders, playback readouts) are debounced; scroll / resize are per frame.
  // DOM 변경은 디바운스, 스크롤·리사이즈는 프레임 단위.
  mo = new MutationObserver((list) => {
    if (!list.some((m) => !root.contains(m.target))) return;
    clearTimeout(moTimer);
    moTimer = setTimeout(schedule, 120);
  });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  render();
}

export function closeHelpOverlay() {
  if (!active) return;
  active = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  mo?.disconnect();
  clearTimeout(moTimer);
  mo = null;
  window.removeEventListener('scroll', schedule, true);
  window.removeEventListener('resize', schedule);
  root?.remove();
  for (const d of expanded) d.open = false;
  expanded = [];
  root = canvas = layer = pop = hint = null;
  boxes = [];
  hoverBox = null;
  document.getElementById('btnHelpMode')?.setAttribute('aria-pressed', 'false');
}

export function toggleHelpOverlay() {
  if (active) closeHelpOverlay();
  else openHelpOverlay();
}

let installed = false;

/** Install the H shortcut (and swallow other shortcuts while help mode is open). / H 단축키 설치 */
export function initHelpOverlay() {
  if (installed) return;
  installed = true;
  // Window capture runs before the app's document-level shortcut handlers.
  // window 캡처 단계가 앱 단축키(document)보다 먼저 실행됨.
  window.addEventListener('keydown', (e) => {
    const plainH = (e.key === 'h' || e.key === 'H') && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!active) {
      if (plainH && !isTyping(e.target) && !e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); openHelpOverlay(); }
      return;
    }
    if (isHelpModalOpen()) return; // the inspector closes its modal on Esc / 인스펙터가 모달을 닫음
    e.preventDefault();
    e.stopImmediatePropagation();
    if ((plainH || e.key === 'Escape') && !e.repeat) closeHelpOverlay();
  }, true);
  document.getElementById('btnHelpMode')?.addEventListener('click', () => toggleHelpOverlay());
}
