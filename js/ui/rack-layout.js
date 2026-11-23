/**
 * Flexatone — ui/rack-layout.js
 * Layer 4 (ui): movable racks. Every feature block of a studio ("Curve Engine", "Tremolo", the
 * canvas, …) gets a grip; dragging it lifts the block out of the page into a floating panel that
 * stays where it was dropped while the page scrolls, so a control can sit next to the canvas it
 * changes. "Default layout" puts every block of the studio on screen back in its place.
 * 계층 4 (ui): 이동 가능한 랙. 스튜디오의 기능 블록(곡선 엔진, 트레몰로, 캔버스 …)마다 손잡이가 붙고,
 * 끌면 떠 있는 패널이 되어 페이지를 스크롤해도 제자리에 남습니다. "기본 레이아웃"은 위치만 되돌립니다.
 *
 * How it works / 동작 방식
 *   - A rack is any <section> of the workspace (or an element with data-rack). Nothing is moved in the
 *     DOM: a floating rack only gets `position: fixed` + left / top / width, so the studios keep
 *     rebuilding their own DOM freely. A MutationObserver re-applies the saved places after rebuilds.
 *     랙의 DOM 위치는 그대로 두고 CSS(position: fixed)만 바꾸므로 스튜디오의 DOM 재생성과 충돌하지 않음.
 *   - Key of a rack: data-rack, else its id, else the first data-help inside it (language-independent,
 *     stable across rebuilds); duplicates get #2, #3 in document order.
 *   - Places are a view preference, not part of the document: stored per studio in localStorage,
 *     never in undo history or project files. Only positions are stored — no parameter values.
 *     위치는 문서가 아닌 보기 설정: 스튜디오별로 localStorage에 저장 (실행 취소·프로젝트 파일과 무관).
 */

import { appState } from '../core/state.js';
import { t, I18N } from '../core/i18n.js';
import { StudioRegistry } from '../studios/registry.js';
import { HELP_DB } from './option-inspector.js';

const STORE_KEY = 'flexatone.rackLayout.v1';
const ROOT_IDS = ['studioWorkspace', 'voiceGrapherStrip', 'mainSplitGrid', 'versionGallerySection', 'studioMount'];
const MIN_W = 220;
const KEEP = 48; // px of a floating rack that must stay inside the window / 창 안에 남겨 둘 최소 폭

Object.assign(I18N.en, {
  'view.layoutReset': 'Default layout',
  'view.rackMove': 'Drag to move this block · double-click to put it back',
  'view.rackDock': 'Put back in place',
  'toast.layoutReset': (n) => (n > 0 ? `Default layout restored (${n} block${n === 1 ? '' : 's'} put back). Values are unchanged.` : 'Layout is already the default.'),
});
Object.assign(I18N.ko, {
  'view.layoutReset': '기본 레이아웃',
  'view.rackMove': '끌어서 이 블록 이동 · 더블클릭하면 제자리로',
  'view.rackDock': '제자리로 되돌리기',
  'toast.layoutReset': (n) => (n > 0 ? `기본 레이아웃으로 되돌렸습니다 (블록 ${n}개). 값은 그대로입니다.` : '이미 기본 레이아웃입니다.'),
});

Object.assign(I18N.en, {
  'view.rackFold': 'Click the title to fold / unfold this block',
  'view.rackPin': 'Pin on screen: stays under the header while the page scrolls',
  'view.rackUnpin': 'Unpin',
});
Object.assign(I18N.ko, {
  'view.rackFold': '제목을 클릭하면 이 블록을 접고 엽니다',
  'view.rackPin': '화면에 고정: 페이지를 스크롤해도 헤더 아래에 남습니다',
  'view.rackUnpin': '고정 해제',
});
HELP_DB['app.rackFold'] = {
  en: { title: 'Fold a block', summary: 'Click the title row of a block (its name) to fold it to one line; click again to open it.', detail: 'Buttons and fields in the title row keep working as before — only a click on the name or an empty part of the row folds. Remembered per studio in this browser; “Default layout” opens every block again.', formula: '' },
  ko: { title: '블록 접기', summary: '블록의 제목 줄(이름)을 클릭하면 한 줄로 접히고, 다시 클릭하면 열립니다.', detail: '제목 줄의 버튼과 입력란은 그대로 동작하며, 이름이나 빈 곳을 클릭할 때만 접힙니다. 이 브라우저에 스튜디오별로 기억되며, “기본 레이아웃”을 누르면 모두 다시 열립니다.', formula: '' },
};
HELP_DB['app.rackPin'] = {
  en: { title: 'Pin a block on screen', summary: '📌 keeps this block (for example the simulator canvas) on screen under the header, like the output strip, while you scroll to the controls.', detail: 'Click 📌 again to unpin. Several pinned blocks of one column stack under each other. A very tall block scrolls inside itself. Remembered per studio in this browser; “Default layout” unpins everything.', formula: '' },
  ko: { title: '블록 화면 고정', summary: '📌를 누르면 이 블록(예: 시뮬레이터 캔버스)이 출력 스트립처럼 헤더 아래에 고정되어, 아래 컨트롤로 스크롤해도 보입니다.', detail: '📌를 다시 누르면 해제됩니다. 같은 열의 고정 블록 여러 개는 차례로 쌓입니다. 너무 긴 블록은 안에서 스크롤됩니다. 이 브라우저에 스튜디오별로 기억되며, “기본 레이아웃”은 모든 고정을 해제합니다.', formula: '' },
};

HELP_DB['app.rackMove'] = {
  en: { title: 'Move this block', summary: 'Drag the grip to float this block anywhere in the window; it stays there while the page scrolls.', detail: 'Double-click the grip (or press ⤓) to put it back. Drag the lower-right corner to resize. “Default layout” in the header resets every block of this studio. Only positions change — no parameter values.', formula: '' },
  ko: { title: '블록 이동', summary: '손잡이를 끌어 이 블록을 창 안 어디로든 띄워 놓을 수 있습니다. 페이지를 스크롤해도 그 자리에 남습니다.', detail: '손잡이를 더블클릭하거나 ⤓를 누르면 제자리로 돌아갑니다. 오른쪽 아래 모서리를 끌면 크기가 바뀝니다. 헤더의 “기본 레이아웃”은 이 스튜디오의 모든 블록 위치를 되돌립니다. 위치만 바뀌며 파라미터 값은 그대로입니다.', formula: '' },
};
HELP_DB['app.layoutReset'] = {
  en: { title: 'Default layout', summary: 'Put every moved block of this studio back in its original place.', detail: 'Only the positions are reset. Sliders, curves and every other value stay as they are.', formula: '' },
  ko: { title: '기본 레이아웃', summary: '이 스튜디오에서 옮긴 블록을 모두 원래 자리로 되돌립니다.', detail: '위치만 초기화합니다. 슬라이더·곡선 등 모든 값은 그대로입니다.', formula: '' },
};

const VIEW_KEY = 'flexatone.rackView.v1'; // { [studio]: { [rackKey]: { fold?: true, pin?: true } } } / 접기·고정 상태
let store = {};
let view = {};
let scheduled = false;
let drag = null;
let observer = null;

function loadStore() {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    store = obj && typeof obj === 'object' ? obj : {};
  } catch { store = {}; }
}

function loadView() {
  try {
    const obj = JSON.parse(globalThis.localStorage?.getItem(VIEW_KEY) || '{}');
    view = obj && typeof obj === 'object' ? obj : {};
  } catch { view = {}; }
}

function saveView() {
  try { globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* session only */ }
}

function viewOf(key) {
  return view[studioId()]?.[key] || {};
}

function setViewFlag(node, flag, on) {
  const key = keyOf(node);
  if (!key) return;
  const sid = studioId();
  const cur = { ...(view[sid]?.[key] || {}) };
  if (on) cur[flag] = true; else delete cur[flag];
  view[sid] = { ...(view[sid] || {}), [key]: cur };
  if (!Object.keys(cur).length) delete view[sid][key];
  if (!Object.keys(view[sid]).length) delete view[sid];
  saveView();
  schedule();
  globalThis.dispatchEvent(new Event('resize')); // canvases re-measure / 캔버스 재측정
}

function saveStore() {
  try { globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode / quota: layout is session-only */ }
}

const studioId = () => StudioRegistry.resolveStudioId();
const zoom = () => Math.max(0.1, (Number(appState.uiZoom) || 100) / 100);
const headerBottom = () => Math.max(0, document.getElementById('appHeader')?.getBoundingClientRect().bottom || 0);

/** Racks on screen, in document order, with their keys. / 화면의 랙과 키 */
function listRacks() {
  const out = [];
  const seen = new Map();
  for (const id of ROOT_IDS) {
    const root = document.getElementById(id);
    if (!root) continue;
    const nodes = root.matches('section') ? [root] : [...root.querySelectorAll('section, [data-rack]')];
    for (const node of nodes) {
      // A rack inside another rack is part of it (it moves with its parent). / 중첩 블록은 부모와 함께 이동
      if (node.parentElement?.closest('section, [data-rack]')) continue;
      const base = node.dataset.rack || node.id || node.dataset.help || node.querySelector('[data-help]')?.dataset.help || 'rack';
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.push({ node, key: n > 1 ? `${base}#${n}` : base });
    }
  }
  return out;
}

function ensureGrip(node) {
  let grip = null;
  for (const c of node.children) if (c.classList?.contains('fx-rack-grip')) { grip = c; break; }
  if (grip) {
    if (node.firstElementChild !== grip) node.prepend(grip);
    return;
  }
  grip = document.createElement('div');
  grip.className = 'fx-rack-grip';
  grip.dataset.help = 'app.rackMove';
  grip.title = t('view.rackMove');
  const dots = document.createElement('span');
  dots.className = 'fx-rack-dots';
  dots.textContent = '⠿';
  dots.setAttribute('aria-hidden', 'true');
  const dock = document.createElement('button');
  dock.type = 'button';
  dock.className = 'fx-rack-dock';
  dock.textContent = '⤓';
  dock.title = t('view.rackDock');
  dock.addEventListener('pointerdown', (e) => e.stopPropagation());
  dock.addEventListener('click', (e) => { e.stopPropagation(); dockRack(node); });
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.className = 'fx-rack-pin';
  pin.textContent = '📌';
  pin.dataset.help = 'app.rackPin';
  pin.addEventListener('pointerdown', (e) => e.stopPropagation());
  pin.addEventListener('click', (e) => { e.stopPropagation(); setViewFlag(node, 'pin', !node.classList.contains('fx-rack-pinned')); });
  grip.append(dots, pin, dock);
  grip.addEventListener('pointerdown', (e) => onGripDown(e, node, grip));
  grip.addEventListener('dblclick', (e) => { e.preventDefault(); dockRack(node); });
  node.prepend(grip);
}

/**
 * Title row of a rack = its first child after the grip. A click on it (on the name or an empty part, not on
 * a control) folds the rack. / 제목 줄 = 손잡이 다음 첫 자식. 이름·빈 곳 클릭 = 접기
 */
const INTERACTIVE = 'button, input, select, textarea, a, label, summary, details, canvas, svg, [role="button"], [contenteditable="true"], .fx-rack-grip';
function ensureHead(node) {
  const head = [...node.children].find((c) => !c.classList.contains('fx-rack-grip'));
  for (const c of node.children) if (c !== head) c.classList.remove('fx-rack-head');
  if (!head || head.tagName === 'DETAILS' || head.querySelector('canvas') || node.children.length < 3) return null; // nothing to fold / 접을 것이 없음
  head.classList.add('fx-rack-head');
  if (!head.dataset.foldBound) {
    head.dataset.foldBound = '1';
    head.title = head.title || t('view.rackFold');
    head.addEventListener('click', (e) => {
      if (e.target.closest(INTERACTIVE) && e.target.closest(INTERACTIVE) !== head) return;
      if (globalThis.getSelection?.()?.toString()) return; // selecting text is not a click / 텍스트 선택은 제외
      setViewFlag(node, 'fold', !node.classList.contains('fx-rack-collapsed'));
    });
  }
  return head;
}

/** Stack the pinned racks of each column under the header. / 고정 블록을 열마다 헤더 아래에 쌓음 */
function layoutPins() {
  const top0 = Math.round(document.getElementById('appHeader')?.offsetHeight || 0) + 6;
  const byParent = new Map();
  for (const n of document.querySelectorAll('.fx-rack-pinned')) {
    if (!byParent.has(n.parentElement)) byParent.set(n.parentElement, []);
    byParent.get(n.parentElement).push(n);
  }
  for (const host of document.querySelectorAll('.fx-pin-host')) if (!byParent.has(host)) host.classList.remove('fx-pin-host');
  for (const [host, list] of byParent) {
    host?.classList.add('fx-pin-host');
    let y = top0;
    for (const n of list) {
      n.style.top = `${y}px`;
      n.style.maxHeight = `calc(100vh - ${y + 8}px)`;
      y += Math.round(n.getBoundingClientRect().height / zoom()) + 6;
    }
  }
}

/** Keep a floating rack reachable: its grip stays below the header and inside the window. */
function clampPlace(p) {
  const z = zoom();
  const w = Math.max(MIN_W, Number(p.w) || MIN_W);
  const vw = globalThis.innerWidth / z;
  const vh = globalThis.innerHeight / z;
  const top = headerBottom() / z + 4;
  return {
    x: Math.round(Math.max(0, Math.min(p.x, vw - KEEP))),
    y: Math.round(Math.min(Math.max(p.y, top), Math.max(top, vh - KEEP))),
    w: Math.round(Math.min(w, Math.max(MIN_W, vw - 8))),
    h: Number.isFinite(p.h) && p.h > 80 ? Math.round(p.h) : null,
  };
}

function floatRack(node, place) {
  const p = clampPlace(place);
  node.classList.add('fx-rack-float');
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
  node.style.width = `${p.w}px`;
  node.style.height = p.h ? `${p.h}px` : '';
  // Never taller than the space under its top edge / 위쪽 가장자리 아래 공간보다 크지 않게
  node.style.maxHeight = `${Math.max(120, Math.round(globalThis.innerHeight / zoom() - p.y - 8))}px`;
  return p;
}

function unfloat(node) {
  node.classList.remove('fx-rack-float', 'fx-rack-dragging');
  for (const k of ['left', 'top', 'width', 'height', 'maxHeight']) node.style[k] = '';
}

function keyOf(node) {
  return listRacks().find((r) => r.node === node)?.key || null;
}

function dockRack(node) {
  const key = keyOf(node);
  const sid = studioId();
  if (key && store[sid]) {
    delete store[sid][key];
    if (!Object.keys(store[sid]).length) delete store[sid];
    saveStore();
  }
  unfloat(node);
  globalThis.dispatchEvent(new Event('resize')); // canvases re-measure / 캔버스 재측정
}

function onGripDown(e, node, grip) {
  if (e.button !== 0) return;
  e.preventDefault();
  const z = zoom();
  const r = node.getBoundingClientRect();
  drag = { node, grip, id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width / z, moved: false, startX: e.clientX, startY: e.clientY, wasFloat: node.classList.contains('fx-rack-float') };
  try { grip.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  grip.addEventListener('pointermove', onGripMove);
  grip.addEventListener('pointerup', onGripUp);
  grip.addEventListener('pointercancel', onGripUp);
}

function onGripMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return; // a click is not a drag / 클릭은 이동 아님
  drag.moved = true;
  const z = zoom();
  const h = drag.wasFloat && drag.node.style.height ? parseFloat(drag.node.style.height) : null;
  drag.place = floatRack(drag.node, { x: (e.clientX - drag.dx) / z, y: (e.clientY - drag.dy) / z, w: drag.wasFloat ? parseFloat(drag.node.style.width) || drag.w : drag.w, h });
  drag.node.classList.add('fx-rack-dragging');
}

function onGripUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { node, grip, place, moved } = drag;
  grip.removeEventListener('pointermove', onGripMove);
  grip.removeEventListener('pointerup', onGripUp);
  grip.removeEventListener('pointercancel', onGripUp);
  try { grip.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  drag = null;
  node.classList.remove('fx-rack-dragging');
  if (!moved || !place) return;
  const key = keyOf(node);
  if (!key) return;
  const sid = studioId();
  store[sid] = { ...(store[sid] || {}), [key]: place };
  saveStore();
  globalThis.dispatchEvent(new Event('resize'));
}

/** A floating rack resized by its corner: remember the new size. / 모서리로 크기를 바꾸면 저장 */
function rememberSizes() {
  const sid = studioId();
  const places = store[sid];
  if (!places || drag) return;
  let changed = false;
  const z = zoom();
  for (const { node, key } of listRacks()) {
    const p = places[key];
    if (!p || !node.classList.contains('fx-rack-float')) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1) continue;
    const w = Math.round(r.width / z);
    const h = node.style.height ? Math.round(r.height / z) : p.h;
    if (Math.abs(w - p.w) > 1 || (h && Math.abs(h - (p.h || 0)) > 1)) { places[key] = { ...p, w, h: h || null }; changed = true; }
  }
  if (changed) saveStore();
}

/** Decorate every rack and apply the saved places of the studio on screen. / 손잡이 부착 + 위치 적용 */
function apply() {
  scheduled = false;
  const places = store[studioId()] || {};
  for (const { node, key } of listRacks()) {
    ensureGrip(node);
    node.classList.add('fx-rack');
    const head = ensureHead(node);
    const v = viewOf(key);
    node.classList.toggle('fx-rack-collapsed', !!(v.fold && head));
    if (drag?.node === node) continue;
    const p = places[key];
    if (p) floatRack(node, p);
    else if (node.classList.contains('fx-rack-float')) unfloat(node);
    const pinned = !!v.pin && !p; // a floating rack is already fixed on screen / 떠 있는 블록은 이미 고정
    if (!pinned && node.classList.contains('fx-rack-pinned')) { node.style.top = ''; node.style.maxHeight = ''; }
    node.classList.toggle('fx-rack-pinned', pinned);
    const pinBtn = node.querySelector(':scope > .fx-rack-grip > .fx-rack-pin');
    if (pinBtn) { pinBtn.classList.toggle('on', pinned); pinBtn.title = t(pinned ? 'view.rackUnpin' : 'view.rackPin'); pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false'); }
  }
  layoutPins();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  if (document.hidden) setTimeout(apply, 16);
  else requestAnimationFrame(apply);
}

/**
 * Default layout: forget the places of the studio on screen (positions only — no parameter values).
 * 기본 레이아웃: 화면의 스튜디오에서 옮긴 위치만 초기화 (파라미터 값은 그대로).
 * @returns {number} how many racks were put back
 */
export function resetRackLayout() {
  const sid = studioId();
  const n = Object.keys(store[sid] || {}).length;
  delete store[sid];
  saveStore();
  delete view[sid]; // folded / pinned blocks open and unpin too / 접기·고정도 해제
  saveView();
  for (const { node } of listRacks()) { unfloat(node); node.classList.remove('fx-rack-collapsed', 'fx-rack-pinned'); node.style.top = ''; node.style.maxHeight = ''; }
  layoutPins();
  globalThis.dispatchEvent(new Event('resize'));
  return n;
}

/** Re-apply after a render (studio switch, language change). / 렌더 후 재적용 */
export function syncRackLayout() {
  schedule();
}

export function initRackLayout() {
  loadStore();
  loadView();
  const main = document.getElementById('workspaceContainer') || document.body;
  observer = new MutationObserver(schedule);
  observer.observe(main, { childList: true, subtree: true });
  globalThis.addEventListener('resize', schedule);
  globalThis.addEventListener('pointerup', () => setTimeout(rememberSizes, 0)); // after a corner resize / 모서리 크기 조절 후
  schedule();
}
