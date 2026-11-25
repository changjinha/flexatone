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
import { toolCategory, CAT_RANK, SIGNAL_CATS, firstHelpKey } from './tool-groups.js';
import { SRC, DST, inputsOf, outputsOf } from '../core/signal-flow.js';
import { resolveEdges, getFlow, flowPortsOpen, setFlowPorts, openFlowPopover, namesLabel, onFlowChange } from './signal-flow.js';

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

Object.assign(I18N.en, {
  'view.rackSize': 'Drag to resize this block · double-click for its natural size',
  'view.winSize': 'Drag to resize the monitor · double-click for the default size',
  'view.winSplit': 'Drag to change the width of the monitor column · double-click for the default',
  'view.rackNav': 'Jump to a toolbox',
});
Object.assign(I18N.ko, {
  'view.rackSize': '끌어서 이 블록 크기 조절 · 더블클릭하면 원래 크기',
  'view.winSize': '끌어서 모니터 크기 조절 · 더블클릭하면 기본 크기',
  'view.winSplit': '끌어서 모니터 열의 폭 조절 · 더블클릭하면 기본 폭',
  'view.rackNav': '툴박스로 이동',
});
HELP_DB['app.rackSize'] = {
  en: { title: 'Resize a block', summary: 'Drag the corner handle (◢) of any block — a toolbox, a monitor, a Manager card — to make it larger or smaller.', detail: 'A monitor keeps its canvas filling the new size; a toolbox that becomes shorter than its content scrolls inside. Double-click the handle to go back to the natural size. Remembered per studio in this browser; “Default layout” resets every size.', formula: '' },
  ko: { title: '블록 크기 조절', summary: '툴박스·모니터·매니저 카드 등 모든 블록의 모서리 손잡이(◢)를 끌어 크기를 바꿉니다.', detail: '모니터는 캔버스가 새 크기를 채우고, 내용보다 짧아진 툴박스는 안에서 스크롤됩니다. 손잡이를 더블클릭하면 원래 크기로. 이 브라우저에 스튜디오별로 기억되며 “기본 레이아웃”이 모두 되돌립니다.', formula: '' },
};
HELP_DB['app.rackNav'] = {
  en: { title: 'Toolbox jump bar', summary: 'Every toolbox of the studio on screen, in the order of the right column and its groups (① Generate · ② Process · ③ Send & export). Click one to scroll to it (a folded one opens).', detail: 'The monitors (main monitor, module list, timeline) stay on the left and follow the page while you scroll the toolboxes on the right. Drag the line between the two columns to change the monitor width.', formula: '' },
  ko: { title: '툴박스 바로가기', summary: '화면 스튜디오의 모든 툴박스가 오른쪽 열의 순서와 묶음(① 생성 · ② 처리 · ③ 후처리)대로 있습니다. 클릭하면 그 툴박스로 스크롤됩니다(접혀 있으면 열림).', detail: '모니터(주 모니터·모듈 리스트·타임라인)는 왼쪽에 남아 오른쪽 툴박스를 스크롤하는 동안 따라옵니다. 두 열 사이의 선을 끌면 모니터 폭이 바뀝니다.', formula: '' },
};

Object.assign(I18N.en, {
  'view.rackUp': 'Move this toolbox above the one before it (inside its group)',
  'view.rackDown': 'Move this toolbox below the one after it (inside its group)',
});
Object.assign(I18N.ko, {
  'view.rackUp': '이 툴박스를 앞(위) 툴박스 위로 (같은 묶음 안)',
  'view.rackDown': '이 툴박스를 뒤(아래) 툴박스 아래로 (같은 묶음 안)',
});
HELP_DB['app.rackOrder'] = {
  en: { title: 'Reorder toolboxes', summary: '▲ / ▼ on the grip of a toolbox swaps it with the toolbox just above or below it in its group of the right column.', detail: 'The jump bar follows the new order. Remembered per studio in this browser; “Default layout” restores the original order. Only the order changes — no parameter values.', formula: '' },
  ko: { title: '툴박스 순서 바꾸기', summary: '툴박스 손잡이의 ▲ / ▼를 누르면 오른쪽 열의 같은 묶음 안에서 바로 위·아래 툴박스와 자리를 바꿉니다.', detail: '바로가기 줄도 새 순서를 따릅니다. 이 브라우저에 스튜디오별로 기억되며, “기본 레이아웃”을 누르면 원래 순서로 돌아갑니다. 순서만 바뀌며 파라미터 값은 그대로입니다.', formula: '' },
};

const ORDER_KEY = 'flexatone.rackOrder.v1'; // { [studio]: [rackKey, …] } toolbox order in the right column / 오른쪽 열 툴박스 순서
let orderStore = {};
function loadOrder() {
  try { const o = JSON.parse(globalThis.localStorage?.getItem(ORDER_KEY) || '{}'); orderStore = o && typeof o === 'object' ? o : {}; } catch { orderStore = {}; }
}
function saveOrder() {
  try { globalThis.localStorage?.setItem(ORDER_KEY, JSON.stringify(orderStore)); } catch { /* session only */ }
}
let lastTools = []; // [{ node, key }] visible toolboxes of the right column, in shown order / 표시 순서의 툴박스
let lastWins = []; // [{ node, key }] the left column (monitors, timelines, voice lists), top to bottom / 왼쪽 열

function setOrdButtons(group) {
  group.forEach(({ node }, i) => {
    const up = node.querySelector(':scope > .fx-rack-grip > .fx-rack-up');
    const down = node.querySelector(':scope > .fx-rack-grip > .fx-rack-down');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === group.length - 1;
  });
}

/**
 * Swap a block with its neighbour in its column (dir −1 = up, +1 = down): a toolbox in the right column, or a
 * monitor / timeline / voice list in the left one. A moved toolbox stays under the pointer (the page scrolls
 * by the distance it moved); the left column is fixed on screen, so it just re-stacks.
 * 같은 열의 이웃과 자리 바꾸기: 오른쪽 툴박스 또는 왼쪽 모니터·타임라인·목록. 툴박스는 포인터 아래 유지.
 */
function moveRack(node, dir) {
  const isWin = lastWins.some((r) => r.node === node);
  const group = isWin ? lastWins : lastTools;
  const list = group.map((r) => r.key);
  const i = group.findIndex((r) => r.node === node);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  if (group[j].cat !== group[i].cat) return; // only inside its group / 같은 묶음 안에서만
  [list[i], list[j]] = [list[j], list[i]];
  const sid = studioId();
  const old = orderStore[sid] || [];
  orderStore[sid] = [...list, ...old.filter((k) => !list.includes(k))]; // keep keys of hidden toolboxes / 숨은 툴박스 키 유지
  saveOrder();
  const y0 = node.getBoundingClientRect().top;
  apply();
  const dy = node.getBoundingClientRect().top - y0;
  if (isWin) globalThis.dispatchEvent(new Event('resize')); // canvases re-measure / 캔버스 재측정
  else if (Math.abs(dy) > 1) globalThis.scrollBy({ top: dy, behavior: 'instant' });
  node.classList.remove('fx-rack-flash');
  void node.offsetWidth;
  node.classList.add('fx-rack-flash');
}

/** Saved order on top of the default one: saved toolboxes fill their own slots in saved order. / 저장된 순서 적용 */
function applySavedOrder(tools) {
  const saved = orderStore[studioId()];
  if (!saved?.length) return tools;
  const rank = new Map(saved.map((k, i) => [k, i]));
  const slots = [];
  const moved = [];
  tools.forEach((r, i) => { if (rank.has(r.key)) { slots.push(i); moved.push(r); } });
  moved.sort((a, b) => rank.get(a.key) - rank.get(b.key));
  const out = tools.slice();
  slots.forEach((s, k) => { out[s] = moved[k]; });
  return out;
}

const VIEW_KEY = 'flexatone.rackView.v1'; // { [studio]: { [rackKey]: { fold?, pin?, size?: { w, h }, ch? } } } / 접기·고정·크기
const WIN_KEY = 'flexatone.winCol.v1'; // { [studio]: window column width px } / 윈도우 열 폭
const SPLIT_MIN_W = 900; // narrower than this: one column as before / 이보다 좁으면 기존 한 열
let winCol = {};
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

/** Scope of a rack: the Manager window or the studio on screen. / 랙의 범위: 매니저 창 또는 화면의 스튜디오 */
const MGR_SCOPE = 'manager';
const inManager = (node) => !!node?.closest?.('#managerPanel');
const scopeOf = (node) => (inManager(node) ? MGR_SCOPE : studioId());

function viewOf(key, sid = studioId()) {
  return view[sid]?.[key] || {};
}

function setViewFlag(node, flag, on) {
  const key = keyOf(node);
  if (!key) return;
  const sid = scopeOf(node);
  const cur = { ...(view[sid]?.[key] || {}) };
  if (on === true) cur[flag] = true; else if (on === false || on === undefined || on === null) delete cur[flag]; else cur[flag] = on;
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
      const base = node.dataset.rack || node.id || node.dataset.help || firstHelpKey(node) || 'rack'; // never the grip's own help key / 손잡이의 도움말 키는 제외
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.push({ node, key: n > 1 ? `${base}#${n}` : base });
    }
  }
  // Manager cards (they are rebuilt with the Manager; keys are their data-rack) / 매니저 카드
  for (const node of document.querySelectorAll('#managerPanel .mgr-scroll > section, #managerPanel .mgr-col > section, #managerPanel .mgr-mods-host > section')) {
    const base = node.dataset.rack || node.dataset.help || 'mgr-card';
    const k = `mgr:${base}`;
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    out.push({ node, key: n > 1 ? `${base}#${n}` : base });
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
  const mk = (cls, txt, dir) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `fx-rack-ord ${cls}`;
    b.textContent = txt;
    b.dataset.help = 'app.rackOrder';
    b.title = t(dir < 0 ? 'view.rackUp' : 'view.rackDown');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('dblclick', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); moveRack(node, dir); });
    return b;
  };
  const off = document.createElement('button');
  off.type = 'button';
  off.className = 'fx-rack-off';
  off.textContent = '⏻';
  off.title = t('tray.offBtn');
  off.dataset.help = 'app.modTray';
  off.addEventListener('pointerdown', (e) => e.stopPropagation());
  off.addEventListener('click', (e) => { e.stopPropagation(); setModuleActive(node, false, { reveal: false }); });
  // small "signal flow" button: opens / closes this toolbox's ports (only on signal toolboxes, see layoutChain)
  const flow = document.createElement('button');
  flow.type = 'button';
  flow.className = 'fx-rack-flow';
  flow.textContent = '⇄';
  flow.title = t('sf.toggle');
  flow.dataset.help = 'app.flowToggle';
  flow.addEventListener('pointerdown', (e) => e.stopPropagation());
  flow.addEventListener('dblclick', (e) => e.stopPropagation());
  flow.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = rackKeyOf(node);
    if (k) setFlowPorts(studioId(), k, !flowPortsOpen(studioId(), k));
  });
  grip.append(mk('fx-rack-up', '▲', -1), dots, mk('fx-rack-down', '▼', 1), pin, dock, flow, off);
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
    // in the Manager the cards scroll inside .mgr-scroll: pin to its top, cap by its height
    // 매니저 카드는 .mgr-scroll 안에서 스크롤: 그 위쪽에 고정, 높이는 그 상자 기준
    const mgr = inManager(host);
    let y = mgr ? 0 : top0;
    const boxH = mgr ? Math.round((host.clientHeight || 600) * 0.7) : null;
    for (const n of list) {
      n.style.top = `${y}px`;
      n.style.maxHeight = mgr ? `${Math.max(160, boxH - y)}px` : `calc(100vh - ${y + 8}px)`;
      y += Math.round(n.getBoundingClientRect().height / zoom()) + 6;
    }
  }
}

/**
 * Containing box of a floating rack, in CSS px: the viewport, or the Manager window (its backdrop
 * filter makes it the containing block of position: fixed). / 떠 있는 랙의 기준 상자
 */
function boxOf(node) {
  const z = zoom();
  if (inManager(node)) {
    const r = document.getElementById('managerPanel').getBoundingClientRect();
    return { x: r.left / z, y: r.top / z, w: r.width / z, h: r.height / z, top: 4 };
  }
  return { x: 0, y: 0, w: globalThis.innerWidth / z, h: globalThis.innerHeight / z, top: headerBottom() / z + 4 };
}

/** Keep a floating rack reachable: its grip stays below the header and inside the window. */
function clampPlace(p, node) {
  const b = boxOf(node);
  const w = Math.max(MIN_W, Number(p.w) || MIN_W);
  const vw = b.w;
  const vh = b.h;
  const top = b.top;
  return {
    x: Math.round(Math.max(0, Math.min(p.x, vw - KEEP))),
    y: Math.round(Math.min(Math.max(p.y, top), Math.max(top, vh - KEEP))),
    w: Math.round(Math.min(w, Math.max(MIN_W, vw - 8))),
    h: Number.isFinite(p.h) && p.h > 80 ? Math.round(p.h) : null,
  };
}

function floatRack(node, place) {
  const p = clampPlace(place, node);
  node.classList.add('fx-rack-float');
  node.style.left = `${p.x}px`;
  node.style.top = `${p.y}px`;
  node.style.width = `${p.w}px`;
  node.style.height = p.h ? `${p.h}px` : '';
  // Never taller than the space under its top edge / 위쪽 가장자리 아래 공간보다 크지 않게
  node.style.maxHeight = `${Math.max(120, Math.round(boxOf(node).h - p.y - 8))}px`;
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
  const sid = scopeOf(node);
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
  const b = boxOf(drag.node);
  drag.place = floatRack(drag.node, { x: (e.clientX - drag.dx) / z - b.x, y: (e.clientY - drag.dy) / z - b.y, w: drag.wasFloat ? parseFloat(drag.node.style.width) || drag.w : drag.w, h });
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
  const sid = scopeOf(node);
  store[sid] = { ...(store[sid] || {}), [key]: place };
  saveStore();
  globalThis.dispatchEvent(new Event('resize'));
}

/** A floating rack resized by its corner: remember the new size. / 모서리로 크기를 바꾸면 저장 */
function rememberSizes() {
  if (drag) return;
  let changed = false;
  const z = zoom();
  for (const { node, key } of listRacks()) {
    const places = store[scopeOf(node)];
    const p = places?.[key];
    if (!p || !node.classList.contains('fx-rack-float')) continue;
    const r = node.getBoundingClientRect();
    if (r.width < 1) continue;
    const w = Math.round(r.width / z);
    const h = node.style.height ? Math.round(r.height / z) : p.h;
    if (Math.abs(w - p.w) > 1 || (h && Math.abs(h - (p.h || 0)) > 1)) { places[key] = { ...p, w, h: h || null }; changed = true; }
  }
  if (changed) saveStore();
}

// ==========================================================================
// Sizes: a corner handle on every rack (toolbox, window, Manager card) / 크기: 모든 랙의 모서리 손잡이
// ==========================================================================

/** The canvas that fills a window rack and the box whose height sets it. / 윈도우의 주 캔버스와 높이 상자 */
function canvasHost(node) {
  let best = null;
  let area = 0;
  for (const c of node.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (r.width * r.height > area) { area = r.width * r.height; best = c; }
  }
  return best ? best.parentElement : null;
}

function ensureSizer(node) {
  for (const c of node.children) if (c.classList?.contains('fx-rack-size')) return c;
  const h = document.createElement('div');
  h.className = 'fx-rack-size';
  h.dataset.help = 'app.rackSize';
  h.setAttribute('aria-hidden', 'true');
  h.addEventListener('pointerdown', (e) => onSizeDown(e, node, h));
  h.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.classList.contains('fx-win')) { setViewFlag(node, 'ch', null); const host = canvasHost(node); if (host) { host.style.height = ''; host.style.maxHeight = ''; } }
    setViewFlag(node, 'size', null);
    node.style.height = '';
    node.style.width = '';
    node.classList.remove('fx-rack-sized');
  });
  node.append(h);
  return h;
}

let sizing = null;
function onSizeDown(e, node, handle) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const z = zoom();
  const r = node.getBoundingClientRect();
  const win = node.classList.contains('fx-win') && node.dataset.window !== 'list'; // a voice list resizes like a toolbox / 보이스 목록은 툴박스처럼
  const host = win ? canvasHost(node) : null;
  sizing = { node, win, host, x0: e.clientX, y0: e.clientY, w0: r.width / z, h0: r.height / z, ch0: host ? host.getBoundingClientRect().height / z : 0, winW0: currentWinW() };
  try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  const move = (ev) => {
    if (!sizing) return;
    const dx = (ev.clientX - sizing.x0) / z;
    const dy = (ev.clientY - sizing.y0) / z;
    if (sizing.win) {
      // a window: width = the window column, height = its canvas / 윈도우: 폭 = 윈도우 열, 높이 = 캔버스
      if (sizing.host) { sizing.host.style.height = `${Math.round(Math.max(80, sizing.ch0 + dy))}px`; sizing.host.style.maxHeight = 'none'; }
      // the width of the monitor column is set by the line between the columns (#fxWinSplit) / 폭은 열 사이 선으로
    } else {
      node.classList.add('fx-rack-sized');
      node.style.width = `${Math.round(Math.max(MIN_W, sizing.w0 + dx))}px`;
      node.style.height = `${Math.round(Math.max(60, sizing.h0 + dy))}px`;
    }
    schedule();
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
    const st = sizing;
    sizing = null;
    if (!st) return;
    if (st.win) {
      if (st.host) setViewFlag(node, 'ch', Math.round(parseFloat(st.host.style.height) || st.ch0));
      saveWin();
    } else setViewFlag(node, 'size', { w: Math.round(parseFloat(node.style.width)), h: Math.round(parseFloat(node.style.height)) });
    globalThis.dispatchEvent(new Event('resize')); // canvases re-measure / 캔버스 재측정
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function applySize(node, v, isWin) {
  if (isWin) {
    const host = canvasHost(node);
    // the set height wins over a host's own max-height (e.g. a scrolling timeline) / 지정 높이가 호스트의 max-height보다 우선
    if (host && v.ch && !sizing) { host.style.height = `${v.ch}px`; host.style.maxHeight = 'none'; }
    if (node.classList.contains('fx-rack-sized')) { node.classList.remove('fx-rack-sized'); node.style.height = ''; node.style.width = ''; }
    return;
  }
  if (sizing?.node === node) return;
  const sz = v.size;
  if (sz && sz.w && sz.h && !node.classList.contains('fx-rack-float')) {
    node.classList.add('fx-rack-sized');
    node.style.width = `${sz.w}px`;
    node.style.height = `${sz.h}px`;
  } else if (node.classList.contains('fx-rack-sized')) {
    node.classList.remove('fx-rack-sized');
    node.style.width = '';
    node.style.height = '';
  }
}

// ==========================================================================
// Fullscreen: a ⛶ button at the lower-right of every monitor (the rack holding a studio's main canvas,
// or a second view). The monitor itself goes full screen (Fullscreen API; a full-viewport overlay where
// the API is refused); its canvas host takes the height of the screen. Esc or the button again leaves.
// 전체화면: 모든 모니터(스튜디오 주 캔버스 랙 또는 보조 뷰)의 오른쪽 아래 ⛶ 버튼. 모니터 자체가 전체화면이 되고
// 캔버스 호스트가 화면 높이를 채움 (API가 거부되면 뷰포트 전체 오버레이). Esc 또는 버튼으로 해제.
// ==========================================================================

Object.assign(I18N.en, {
  'view.monFull': 'Full screen (Esc or double-click an empty spot to leave)',
  'view.monFullExit': 'Leave full screen (Esc)',
});
Object.assign(I18N.ko, {
  'view.monFull': '전체화면 (Esc 또는 빈 곳 더블클릭으로 해제)',
  'view.monFullExit': '전체화면 해제 (Esc)',
});
HELP_DB['app.monFull'] = {
  en: { title: 'Full-screen monitor', summary: '⛶ at the lower-right corner of every monitor shows that monitor alone on the whole screen.', detail: 'The canvas fills the screen height and keeps working (playback, drawing, zoom). Double-clicking an empty spot of the monitor (toolbar gaps, legend, margin — not the canvas, where a double-click keeps its own job such as setting the cue) also goes in and out. Press Esc or ⛶ again to go back; the layout and every value stay as they were.', formula: '' },
  ko: { title: '모니터 전체화면', summary: '모든 모니터 오른쪽 아래 모서리의 ⛶를 누르면 그 모니터만 화면 전체에 표시합니다.', detail: '캔버스가 화면 높이를 채우고 그대로 동작합니다(재생·그리기·줌). 모니터의 빈 곳(툴바 틈·범례·여백 — 캔버스는 제외, 캔버스 더블클릭은 큐 설정 등 원래 기능 유지)을 더블클릭해도 전환됩니다. Esc 또는 ⛶를 다시 누르면 돌아오며, 레이아웃과 모든 값은 그대로입니다.', formula: '' },
};

let fsNode = null; // the monitor shown full screen / 전체화면 중인 모니터
let fsHost = null; // { el, h, mh } the element that sets the canvas height + inline sizes to restore / 캔버스 높이 요소와 복원할 크기
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

/** A monitor: the main-canvas rack or a second view (not a voice list, not in the Manager). / 모니터 판정 */
const isMonitor = (node) => !inManager(node) && isWindowRack(node) && node.dataset.window !== 'list';

function fsLabel(btn, on) {
  btn.title = t(on ? 'view.monFullExit' : 'view.monFull');
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.classList.toggle('on', on);
}

function ensureFullBtn(node) {
  let btn = null;
  for (const c of node.children) if (c.classList?.contains('fx-mon-full')) { btn = c; break; }
  if (!isMonitor(node)) { btn?.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fx-mon-full';
    btn.dataset.help = 'app.monFull';
    btn.innerHTML = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path class="fx-fs-in" d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/><path class="fx-fs-out" d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4"/></svg>';
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('dblclick', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleFull(node); });
    node.append(btn);
  }
  if (!node.dataset.fsDbl) {
    node.dataset.fsDbl = '1';
    node.addEventListener('dblclick', (e) => onMonitorDbl(e, node));
  }
  fsLabel(btn, fsNode === node);
}

/**
 * Double-click on a free part of a monitor (toolbar gaps, legends, padding) toggles full screen. Skipped where a
 * double-click already means something: on or over a canvas (cue, paint, reset …), on a control, on the fold title
 * row, the grip and the resize handle, or when another handler took the event.
 * 모니터의 빈 곳(툴바 틈·범례·여백) 더블클릭 = 전체화면 토글. 이미 더블클릭이 쓰이는 곳(캔버스와 그 위 오버레이 = 큐·칠하기 등,
 * 컨트롤, 접기 제목 줄, 손잡이, 크기 손잡이)과 다른 핸들러가 처리한 경우는 제외.
 */
function onMonitorDbl(e, node) {
  if (e.defaultPrevented || e.button !== 0 || !isMonitor(node)) return;
  const tgt = e.target;
  if (!(tgt instanceof Element) || tgt.closest(`${INTERACTIVE}, .fx-rack-head, .fx-rack-size, .fx-mon-full, [data-no-fs]`)) return;
  for (const c of node.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return; // over a canvas / 캔버스 위
  }
  e.preventDefault();
  globalThis.getSelection?.()?.removeAllRanges(); // the double-click selected a word / 더블클릭으로 선택된 단어 해제
  toggleFull(node);
}

/** In-flow content height of the full-screen monitor (its box is the screen, so it cannot be measured). / 내용 높이 */
function fsContentH(z) {
  let top = Infinity;
  let bottom = -Infinity;
  for (const c of fsNode.children) {
    const pos = getComputedStyle(c).position;
    if (pos === 'absolute' || pos === 'fixed' || !c.getClientRects().length) continue;
    const q = c.getBoundingClientRect();
    top = Math.min(top, q.top);
    bottom = Math.max(bottom, q.bottom);
  }
  const cs = getComputedStyle(fsNode);
  const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  return (bottom > top ? (bottom - top) / z : 0) + pad;
}

/**
 * Grow the main canvas so the whole monitor fills the screen. The element that sets the canvas height:
 * the canvas itself when it has a fixed height (h-[…]) or sits directly in the monitor, else its host
 * (h-full canvas in a sized box; the Grid host reads an inline height as a resize request).
 * 주 캔버스를 키워 모니터가 화면을 채우게 함. 높이를 정하는 요소 = 고정 높이 캔버스 자신, 아니면 그 호스트.
 */
function fitFullHost() {
  const el = fsHost?.el;
  if (!fsNode || !el?.isConnected) return;
  const z = zoom();
  const screenH = fsNode.getBoundingClientRect().height / z; // the monitor box = the screen / 모니터 상자 = 화면
  const delta = screenH - fsContentH(z) - 2;
  if (Math.abs(delta) < 2) return;
  const h0 = el.getBoundingClientRect().height / z;
  el.style.maxHeight = 'none';
  el.style.height = `${Math.round(Math.min(screenH, Math.max(80, h0 + delta)))}px`;
}

function enterFull(node) {
  let canvas = null;
  let area = 0;
  for (const c of node.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    if (r.width * r.height > area) { area = r.width * r.height; canvas = c; }
  }
  const el = !canvas ? null : /(^|\s)h-\[/.test(canvas.className) || canvas.parentElement === node ? canvas : canvas.parentElement;
  fsNode = node;
  fsHost = el ? { el, h: el.style.height, mh: el.style.maxHeight } : null;
  node.classList.add('fx-mon-fs');
  const done = () => { fitFullHost(); schedule(); globalThis.dispatchEvent(new Event('resize')); };
  // No API, refused, or no answer within 0.5 s (embedded views): fill the browser view instead.
  // API 없음·거부·0.5초 내 응답 없음(임베디드 뷰): 브라우저 화면 전체 오버레이로 대체
  const overlay = () => { if (fsNode === node && fsElement() !== node && !node.classList.contains('fx-mon-fs-css')) { node.classList.add('fx-mon-fs-css'); done(); } };
  const req = node.requestFullscreen || node.webkitRequestFullscreen;
  let p = null;
  try { p = req?.call(node, { navigationUI: 'hide' }); } catch { p = null; }
  if (p?.then) p.then(() => setTimeout(done, 30), overlay);
  if (!req) overlay();
  else setTimeout(overlay, 500);
}

function leaveFull() {
  const node = fsNode;
  if (!node) return;
  fsNode = null;
  node.classList.remove('fx-mon-fs', 'fx-mon-fs-css');
  if (fsHost?.el) { fsHost.el.style.height = fsHost.h; fsHost.el.style.maxHeight = fsHost.mh; }
  fsHost = null;
  if (fsElement() === node) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)?.catch?.(() => {});
  // the saved monitor height comes back on the next apply / 저장된 모니터 높이는 다음 apply에서 복원
  schedule();
  globalThis.dispatchEvent(new Event('resize'));
}

function toggleFull(node) {
  if (fsNode === node) leaveFull();
  else { if (fsNode) leaveFull(); enterFull(node); }
}

function onFullChange() {
  if (!fsNode) return;
  if (fsElement() === fsNode) { fsNode.classList.remove('fx-mon-fs-css'); fitFullHost(); globalThis.dispatchEvent(new Event('resize')); return; } // a late answer / 늦은 응답
  if (fsNode.classList.contains('fx-mon-fs-css')) return; // overlay mode has no API state / 오버레이는 API 상태 없음
  leaveFull(); // Esc / Esc 키
}

// ==========================================================================
// Split layout: the monitor(s) on the left, following the page; every toolbox on the right (in groups,
// ui/tool-groups.js), with the module tray on top. Nothing moves in the DOM — the column wrappers become display: contents (CSS
// body.fx-split), the window racks become position: fixed, the toolboxes get a CSS order.
// 분할 레이아웃: 왼쪽 = 모니터(스크롤을 따라옴), 오른쪽 = 묶음별 툴박스 + 모듈 트레이. DOM은 그대로 —
// 열 래퍼는 display: contents, 윈도우는 position: fixed, 툴박스는 CSS order.
// ==========================================================================

/**
 * A window = the rack holding the studio's main canvas (the largest one on screen), or a rack marked
 * data-window="1" (a second view, e.g. the Glissando gain envelope); data-window="0" opts out.
 * 윈도우 = 스튜디오의 주 캔버스(화면에서 가장 큰 것)를 담은 랙, 또는 data-window="1"; "0"은 제외.
 */
let mainWin = { sid: null, node: null };
function findMainWindow(racks) {
  const sid = studioId();
  if (mainWin.sid === sid && mainWin.node?.isConnected && !mainWin.node.closest('.hidden, .fx-ws-hidden')) return mainWin.node;
  let best = null;
  let area = 0;
  for (const { node } of racks) {
    if (inManager(node) || node.dataset.window === '0' || node.dataset.sharedMonitor || node.closest('.hidden, .fx-ws-hidden')) continue;
    for (const c of node.querySelectorAll('canvas')) {
      const q = c.getBoundingClientRect();
      if (q.width * q.height > area) { area = q.width * q.height; best = node; }
    }
  }
  mainWin = { sid, node: area > 20000 ? best : null };
  return mainWin.node;
}
function isWindowRack(node) {
  if (node.dataset.window === '1' || node.dataset.window === 'list') return true; // 'list' = a voice list attached under the window / 윈도우 아래 붙는 보이스 목록
  if (node.dataset.window === '0' || inManager(node)) return false;
  return node === mainWin.node;
}

function loadWin() {
  try { const o = JSON.parse(globalThis.localStorage?.getItem(WIN_KEY) || '{}'); winCol = o && typeof o === 'object' ? o : {}; } catch { winCol = {}; }
}
function saveWin() {
  try { globalThis.localStorage?.setItem(WIN_KEY, JSON.stringify(winCol)); } catch { /* session only */ }
}

const container = () => document.getElementById('workspaceContainer');
const BASE_PAD = 16;
const COL_GAP = 14;
let splitState = { on: false, w: 0, left: 0 };

function defaultWinW() {
  const c = container();
  const W = c ? c.getBoundingClientRect().width / zoom() : globalThis.innerWidth / zoom();
  return Math.round((W - 2 * BASE_PAD - COL_GAP) * (2 / 3)); // window : toolboxes ≈ 2 : 1 / 윈도우 : 툴박스 ≈ 2 : 1
}
/** Widest window column the container allows right now (the toolboxes keep ≥ 300 px). / 지금 허용되는 최대 폭 */
function maxWinW() {
  const c = container();
  const W = c ? c.getBoundingClientRect().width / zoom() : 1200;
  return W - 2 * BASE_PAD - COL_GAP - 300;
}
/**
 * Window column width. A saved width is clamped to the current container: after the browser window got
 * narrower, an old (wider) width pushed the toolboxes off screen and the window over them.
 * 윈도우 열 폭. 저장된 폭도 현재 컨테이너에 맞춰 제한 (창을 좁히면 예전 폭이 툴박스를 화면 밖으로 밀던 문제).
 */
function currentWinW() {
  const w = Number(winCol[studioId()]) || defaultWinW();
  return Math.round(Math.max(320, Math.min(w, maxWinW())));
}
/** Window column width (clamped so the right column keeps ≥ 300 px). / 윈도우 열 폭 */
function setWinW(w, save = true) {
  winCol[studioId()] = Math.round(Math.min(Math.max(320, w), maxWinW()));
  if (save) saveWin();
}

const splitWanted = () => appState.layout !== 'portrait' && globalThis.innerWidth / zoom() >= SPLIT_MIN_W;

/** Short name of a rack for the jump bar: its heading, else the first plain text of its title row. / 바로가기용 이름 */
function rackTitle(node) {
  const head = node.querySelector(':scope > .fx-rack-head') || [...node.children].find((c) => !c.classList.contains('fx-rack-grip')) || node;
  let txt = head.querySelector('h1, h2, h3, h4')?.textContent || '';
  if (!txt.trim()) {
    const walker = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || n.parentElement.closest('button, select, input, label, .fx-rack-grip, option')) continue;
      txt = n.textContent;
      break;
    }
  }
  txt = txt.replace(/\s+/g, ' ').trim();
  return txt.length > 28 ? `${txt.slice(0, 27)}…` : txt;
}

// ==========================================================================
// Toolbox groups (ui/tool-groups.js): a title row above each group of the left column; a click folds the
// whole group. / 툴박스 묶음: 왼쪽 열 각 묶음 위의 제목 줄, 클릭하면 묶음 전체를 접음
// ==========================================================================

const GROUP_CATS = Object.keys(CAT_RANK).sort((a, b) => CAT_RANK[a] - CAT_RANK[b]);
const GROUP_KEY = 'flexatone.toolGroupFold.v1'; // { [studio]: { gen?, proc?, post? } } / 묶음 접기
let groupFold = {};
function loadGroupFold() {
  try { const o = JSON.parse(globalThis.localStorage?.getItem(GROUP_KEY) || '{}'); groupFold = o && typeof o === 'object' ? o : {}; } catch { groupFold = {}; }
}
function setGroupFold(cat, on) {
  const sid = studioId();
  const cur = { ...(groupFold[sid] || {}) };
  if (on) cur[cat] = true; else delete cur[cat];
  if (Object.keys(cur).length) groupFold[sid] = cur; else delete groupFold[sid];
  try { globalThis.localStorage?.setItem(GROUP_KEY, JSON.stringify(groupFold)); } catch { /* session only */ }
  schedule();
  globalThis.dispatchEvent(new Event('resize'));
}

/** Title rows of the three groups, kept as children of the container (not racks). / 세 묶음의 제목 줄 */
function ensureGroupHeads(c) {
  const out = {};
  for (const cat of GROUP_CATS) {
    if (cat === 'top') continue;
    let h = c.querySelector(`:scope > .fx-tg-head[data-cat="${cat}"]`);
    if (!h) {
      h = document.createElement('button');
      h.type = 'button';
      h.className = `fx-tg-head fx-tg-${cat}`;
      h.dataset.cat = cat;
      h.dataset.help = 'app.toolGroups';
      h.addEventListener('click', () => setGroupFold(cat, !groupFold[studioId()]?.[cat]));
      c.append(h);
    }
    const sig = `${appState.lang}`;
    if (h.dataset.sig !== sig) {
      h.dataset.sig = sig;
      h.title = t('tg.fold');
      h.replaceChildren(
        Object.assign(document.createElement('span'), { className: 'fx-tg-caret', textContent: '▾' }),
        Object.assign(document.createElement('span'), { className: 'fx-tg-name', textContent: t(`tg.${cat}`) }),
        Object.assign(document.createElement('span'), { className: 'fx-tg-sub', textContent: t(`tg.${cat}.sub`) }),
      );
    }
    out[cat] = h;
  }
  return out;
}

function ensureNav() {
  let nav = document.getElementById('fxRackNav');
  const c = container();
  if (!c) return null;
  if (!nav) {
    nav = document.createElement('nav');
    nav.id = 'fxRackNav';
    nav.dataset.help = 'app.rackNav';
    nav.setAttribute('aria-label', t('view.rackNav'));
  }
  if (nav.parentElement !== c || c.firstElementChild !== nav) c.prepend(nav);
  return nav;
}

function ensureSplitter() {
  let sp = document.getElementById('fxWinSplit');
  if (sp) return sp;
  sp = document.createElement('div');
  sp.id = 'fxWinSplit';
  sp.title = t('view.winSplit');
  sp.dataset.help = 'app.rackNav';
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const z = zoom();
    const x0 = e.clientX;
    const w0 = currentWinW();
    try { sp.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const move = (ev) => { setWinW(w0 + (ev.clientX - x0) / z, false); schedule(); };
    const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); saveWin(); globalThis.dispatchEvent(new Event('resize')); };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
  sp.addEventListener('dblclick', () => { delete winCol[studioId()]; saveWin(); schedule(); globalThis.dispatchEvent(new Event('resize')); });
  document.body.append(sp);
  return sp;
}

/** Where a toolbox goes in the right column: top blocks, then the right column, then the left one. / 오른쪽 열 순서 */
function orderOf(node, idx) {
  const col = node.parentElement?.closest('[class*="lg:col-span-"]');
  if (col && container()?.contains(col)) {
    const cols = [...col.parentElement.children].filter((c) => /lg:col-span-/.test(c.className));
    const k = cols.indexOf(col);
    return (k === cols.length - 1 ? 200 : 300) + idx;
  }
  // the studio's own two-column grid (not a grid inside a toolbox) / 스튜디오 자체의 두 열 그리드
  const grid = document.querySelector('#studioWorkspace:not(.hidden) > [class*="lg:grid-cols-"], #mainSplitGrid:not(.fx-ws-hidden)');
  const before = grid && grid.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING;
  return (before ? 100 : 400) + idx;
}

// ==========================================================================
// Modules: a toolbox is shown only when it is switched on in the module tray (studios and Manager).
// Monitors, the studio strip and the Manager's core cards are always on. Switching off hides the box
// only — no value changes, and the box keeps working for the signal it already defines.
// 모듈: 툴박스는 모듈 트레이에서 켠 것만 보임 (스튜디오·매니저). 모니터·스튜디오 띠·매니저 핵심 카드는 항상 켜짐.
// 끄기 = 숨기기만 (값은 그대로).
// ==========================================================================

const MOD_KEY = 'flexatone.modActive.v1'; // { [scope]: { [rackKey]: bool } } / 켜짐 여부
const MGR_ALWAYS = new Set(['mgr-master', 'mgr-timeline', 'mgr-channels']);
let modStore = {};
function loadMods() {
  try { const o = JSON.parse(globalThis.localStorage?.getItem(MOD_KEY) || '{}'); modStore = o && typeof o === 'object' ? o : {}; } catch { modStore = {}; }
}
function saveMods() {
  try { globalThis.localStorage?.setItem(MOD_KEY, JSON.stringify(modStore)); } catch { /* session only */ }
}
const modInfo = new WeakMap(); // node → { key, scope, cat, fixed, on } of the last apply / 마지막 적용 정보

/** Switch a toolbox on / off (view only). On = it is also scrolled into view. / 툴박스 켜기·끄기 (보기만) */
export function setModuleActive(node, on, { reveal = true } = {}) {
  const info = modInfo.get(node);
  if (!info || info.fixed) return;
  modStore[info.scope] = { ...(modStore[info.scope] || {}), [info.key]: !!on };
  saveMods();
  apply();
  if (on && reveal) {
    if (!inManager(node) && groupFold[studioId()]?.[info.cat]) setGroupFold(info.cat, false);
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      node.classList.remove('fx-rack-flash');
      void node.offsetWidth;
      node.classList.add('fx-rack-flash');
    });
  }
  globalThis.dispatchEvent(new Event('resize'));
}

/** Every switchable toolbox of a scope on (all) or back to the default set (minimal). / 모두 켜기·기본 */
function setAllModules(scope, all) {
  if (all) {
    const cur = {};
    for (const { node } of listRacks()) { const i = modInfo.get(node); if (i && i.scope === scope && !i.fixed) cur[i.key] = true; }
    modStore[scope] = cur;
  } else delete modStore[scope];
  saveMods();
  schedule();
  globalThis.dispatchEvent(new Event('resize'));
}

/** Decide on / off of every rack (called from apply). / 모든 랙의 켜짐 결정 */
function applyModules(racks) {
  const sid = studioId();
  const rows = [];
  racks.forEach(({ node, key }, i) => {
    const mgr = inManager(node);
    if (!mgr && (node.closest('.hidden, .fx-ws-hidden') || !container()?.contains(node))) return;
    const win = !mgr && isWindowRack(node);
    rows.push({ node, key, mgr, win, cat: mgr || win ? null : toolCategory(node, rackTitle(node)), o: mgr || win ? 0 : orderOf(node, i) });
  });
  // the first ① toolbox (in group order) is on by default / 묶음 순서로 첫 ① 툴박스는 기본 켜짐
  const firstGen = rows.filter((r) => r.cat === 'gen').sort((a, b) => a.o - b.o)[0]?.key || null;
  for (const { node, key, mgr, win, cat } of rows) {
    const scope = mgr ? MGR_SCOPE : sid;
    const fixed = win || (mgr ? MGR_ALWAYS.has(key) : cat === 'top');
    const saved = modStore[scope]?.[key];
    const def = mgr ? false : key === firstGen;
    const on = fixed || (typeof saved === 'boolean' ? saved : def);
    modInfo.set(node, { key, scope, cat, fixed, on });
    node.classList.toggle('fx-mod-off', !on);
    node.classList.toggle('fx-mod-fixed', fixed);
  }
}

// ==========================================================================
// Chain: the signal of the monitors runs through the switched-on toolboxes of ① → ② → ③, then to the
// destination (Output, or the Space Studio when "Send to Space Studio" is on). Each box shows where it
// receives from (◀ in) and sends to (out ▶), like the cords of a patcher.
// 체인: 모니터의 신호가 켜진 ① → ② → ③ 툴박스를 지나 목적지(출력, 또는 스페이스 스튜디오)로. 상자마다
// 어디서 받고(◀ 입력) 어디로 보내는지(출력 ▶)를 패처의 선처럼 표시.
// ==========================================================================

let chainDest = () => ({ label: t('chain.output'), space: false });
/** The module that knows the destination registers it here (ui/studio-monitors.js). / 목적지 제공 함수 등록 */
export function setChainDestination(fn) { chainDest = fn; }
let lastChain = { source: '', steps: [], off: [], dest: { label: '', space: false } };
/** The chain of the studio on screen (for the Chain toolbox). / 화면 스튜디오의 체인 */
export function getToolChain() { return lastChain; }

Object.assign(I18N.en, {
  'chain.source': 'Monitors',
  'chain.output': 'Output',
  'chain.in': 'in',
  'chain.out': 'out',
  'tray.title': 'Modules',
  'tray.all': 'All on',
  'tray.min': 'Minimal',
  'tray.on': 'Click: show / jump · × switches it off',
  'tray.off': 'Click: switch this toolbox on',
  'tray.offBtn': 'Switch this toolbox off (hide it; values stay)',
});
Object.assign(I18N.ko, {
  'chain.source': '모니터',
  'chain.output': '출력',
  'chain.in': '입력',
  'chain.out': '출력',
  'tray.title': '모듈',
  'tray.all': '모두 켜기',
  'tray.min': '최소',
  'tray.on': '클릭: 보이기 / 이동 · ×로 끄기',
  'tray.off': '클릭: 이 툴박스 켜기',
  'tray.offBtn': '이 툴박스 끄기 (숨김, 값은 그대로)',
});
HELP_DB['app.modTray'] = {
  en: { title: 'Module tray', summary: 'Every toolbox of the studio (or of the Manager) as a chip. Lit chips are switched on and shown; dim chips are off. Click a dim chip to switch it on, × on a lit chip (or ⏻ on the box) to switch it off.', detail: 'A new studio opens with its strip and its first ① Generate toolbox only. “All on” shows everything, “Minimal” goes back to that default. Switching off only hides a toolbox — its values and its effect on the sound stay. Remembered per studio in this browser.', formula: '' },
  ko: { title: '모듈 트레이', summary: '스튜디오(또는 매니저)의 모든 툴박스가 칩으로 있습니다. 밝은 칩 = 켜져 보이는 툴박스, 흐린 칩 = 꺼짐. 흐린 칩을 클릭하면 켜지고, 밝은 칩의 ×(또는 상자의 ⏻)로 끕니다.', detail: '스튜디오는 띠와 첫 ① 생성 툴박스만 켠 채 열립니다. “모두 켜기”는 전부, “최소”는 이 기본으로. 끄기는 숨기기만 하며 값과 소리에 대한 효과는 그대로입니다. 이 브라우저에 스튜디오별로 기억됩니다.', formula: '' },
};
HELP_DB['app.chainPort'] = {
  en: { title: 'Signal flow ports', summary: '◀ in lists the boxes this toolbox receives from, out ▶ the boxes it sends to. By default that is the order of the switched-on toolboxes ① → ② → ③, from the monitors to the destination.', detail: 'Click a port to choose its sources / targets (several are allowed). The destination is Output, or the Space Studio when “Send to Space Studio” is on. The ⇄ button on the toolbox closes its ports; the Signal flow toolbox (④ Utility) shows and edits the whole patch.', formula: '' },
  ko: { title: '시그널 플로우 포트', summary: '◀ 입력은 이 툴박스가 받는 상자들, 출력 ▶은 보내는 상자들입니다. 기본은 모니터에서 목적지까지 켜진 툴박스 ① → ② → ③의 순서입니다.', detail: '포트를 클릭하면 받는 곳 / 보내는 곳을 고릅니다(여러 개 가능). 목적지는 출력, “스페이스 스튜디오로 보내기”가 켜져 있으면 스페이스 스튜디오입니다. 툴박스의 ⇄ 버튼은 그 포트를 닫고, 시그널 플로우 툴박스(④ 유틸리티)는 패치 전체를 보여 주고 편집합니다.', formula: '' },
};

function jumpTo(node) {
  if (!node?.isConnected) return;
  node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  node.classList.remove('fx-rack-flash');
  void node.offsetWidth;
  node.classList.add('fx-rack-flash');
}

function ensurePort(node, cls) {
  let p = null;
  for (const c of node.children) if (c.classList?.contains(cls)) { p = c; break; }
  if (!p) {
    p = document.createElement('button');
    p.type = 'button';
    p.className = `fx-port ${cls}`;
    p.dataset.help = 'app.chainPort';
    p.addEventListener('pointerdown', (e) => e.stopPropagation());
    p.addEventListener('click', (e) => { e.stopPropagation(); p._open?.(); }); // choose sources / targets / 받는 곳·보내는 곳 선택
    node.append(p);
  }
  return p;
}

/** Rack key of a node as the layout knows it. / 노드의 랙 키 */
function rackKeyOf(node) { return modInfo.get(node)?.key || null; }

/**
 * Ports on the switched-on signal toolboxes, and the chain record. The cords come from the Signal flow
 * (core/signal-flow.js): by default the serial order ① → ② → ③, or the user's own patch with several inputs / outputs
 * per box. A box whose ports are closed (its ⇄ button) shows none. / 켜진 신호 툴박스의 포트 + 체인 기록 (시그널 플로우 기준)
 */
function layoutChain(ordered) {
  const steps = ordered.filter((r) => SIGNAL_CATS.includes(r.cat) && modInfo.get(r.node)?.on && !r.node.classList.contains('hidden'));
  const dest = chainDest() || { label: t('chain.output'), space: false };
  const source = t('chain.source');
  const sid = studioId();
  const keys = steps.map((r) => r.key);
  const edges = resolveEdges(sid, keys);
  const title = (k) => (k === SRC ? source : k === DST ? dest.label : rackTitle(steps.find((r) => r.key === k)?.node));
  const catOf = (k) => (k === SRC ? 'src' : k === DST ? (dest.space ? 'space' : 'dst') : steps.find((r) => r.key === k)?.cat || 'gen');
  const flowable = new Set();
  steps.forEach((r) => {
    flowable.add(r.node);
    r.node.classList.add('fx-flow-able');
    const open = flowPortsOpen(sid, r.key);
    r.node.classList.toggle('fx-flow-open', open);
    const btn = r.node.querySelector(':scope > .fx-rack-grip > .fx-rack-flow');
    btn?.classList.toggle('is-on', open);
    if (!open) return;
    const ins = inputsOf(edges, r.key);
    const outs = outputsOf(edges, r.key);
    for (const [dir, list, cls] of [['in', ins, 'fx-port-in'], ['out', outs, 'fx-port-out']]) {
      const p = ensurePort(r.node, cls);
      const names = list.map(title);
      const txt = dir === 'in' ? `◀ ${t('chain.in')} · ${namesLabel(names)}` : `${t('chain.out')} · ${namesLabel(names)} ▶`;
      if (p.textContent !== txt) p.textContent = txt;
      p.title = names.join(', ');
      const c = list.length ? catOf(list[0]) : dir === 'in' ? 'src' : dest.space ? 'space' : 'dst';
      p.className = `fx-port ${cls} fx-tg-${c}`;
      p._open = () => openFlowPopover(p, { studio: sid, dir, key: r.key, steps: steps.map((x) => ({ key: x.key, title: rackTitle(x.node) })), labels: { src: source, dst: dest.label } });
    }
    // a closed side that no longer applies (never happens while open) stays untouched / 열린 상태에서는 양쪽 모두 유지
  });
  for (const p of document.querySelectorAll('.fx-port')) {
    const owner = p.parentElement;
    const r = steps.find((x) => x.node === owner);
    if (!r || !flowPortsOpen(sid, r.key)) p.remove();
  }
  for (const n of document.querySelectorAll('.fx-flow-able')) if (!flowable.has(n)) n.classList.remove('fx-flow-able', 'fx-flow-open');
  lastChain = {
    source,
    steps: steps.map((r) => ({ key: r.key, title: rackTitle(r.node), cat: r.cat, node: r.node, ins: inputsOf(edges, r.key), outs: outputsOf(edges, r.key) })),
    off: ordered.filter((r) => SIGNAL_CATS.includes(r.cat) && !modInfo.get(r.node)?.on).map((r) => ({ key: r.key, title: rackTitle(r.node), cat: r.cat, node: r.node })),
    dest,
    studio: sid,
    edges,
    flow: getFlow(sid),
  };
}

/** Chips of a tray: one per toolbox, lit when on. / 트레이 칩 */
function trayChips(items, scope) {
  const parts = [];
  let lastCat = null;
  const ttl = document.createElement('span');
  ttl.className = 'fx-tray-title';
  ttl.textContent = t('tray.title');
  ttl.dataset.help = 'app.modTray';
  parts.push(ttl);
  for (const { node, cat } of items) {
    const info = modInfo.get(node);
    if (!info) continue;
    if (cat && cat !== lastCat && cat !== 'top') parts.push(Object.assign(document.createElement('span'), { className: `fx-nav-cat fx-tg-${cat}`, textContent: t(`tg.${cat}`) }));
    lastCat = cat;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `fx-nav-chip fx-tg-${cat || 'mgr'}${info.on ? ' is-on' : ' is-off'}${info.fixed ? ' is-fixed' : ''}`;
    b.dataset.help = 'app.modTray';
    b.title = info.fixed ? '' : t(info.on ? 'tray.on' : 'tray.off');
    b.append(Object.assign(document.createElement('span'), { textContent: rackTitle(node) || '…' }));
    if (info.on && !info.fixed) {
      const x = document.createElement('span');
      x.className = 'fx-chip-x';
      x.textContent = '×';
      x.title = t('tray.offBtn');
      x.addEventListener('click', (e) => { e.stopPropagation(); setModuleActive(node, false); });
      b.append(x);
    }
    b.addEventListener('click', () => {
      if (!modInfo.get(node)?.on) { setModuleActive(node, true); return; }
      if (cat && groupFold[studioId()]?.[cat]) setGroupFold(cat, false);
      if (node.classList.contains('fx-rack-collapsed')) setViewFlag(node, 'fold', false);
      jumpTo(node);
    });
    parts.push(b);
  }
  const all = Object.assign(document.createElement('button'), { type: 'button', className: 'fx-tray-btn', textContent: t('tray.all') });
  all.addEventListener('click', () => setAllModules(scope, true));
  const min = Object.assign(document.createElement('button'), { type: 'button', className: 'fx-tray-btn', textContent: t('tray.min') });
  min.addEventListener('click', () => setAllModules(scope, false));
  parts.push(Object.assign(document.createElement('span'), { className: 'flex-1' }), all, min);
  return parts;
}

function renderTray(nav, items, scope) {
  const sig = `${appState.lang}|${items.map(({ key, node, cat }) => `${cat}:${key}:${modInfo.get(node)?.on ? 1 : 0}=${rackTitle(node)}`).join('|')}`;
  if (nav.dataset.sig === sig) return;
  nav.dataset.sig = sig;
  nav.replaceChildren(...trayChips(items, scope));
}

/** The Manager's own tray, under its bar. / 매니저 트레이 (바 아래) */
function layoutManagerTray(racks) {
  const panel = document.getElementById('managerPanel');
  const bar = panel?.querySelector(':scope > .mgr-bar');
  if (!panel || !bar || panel.classList.contains('mgr-hidden')) return;
  let tray = panel.querySelector(':scope > #fxMgrTray');
  if (!tray) {
    tray = document.createElement('nav');
    tray.id = 'fxMgrTray';
    tray.className = 'fx-tray';
    tray.dataset.help = 'app.modTray';
  }
  if (bar.nextElementSibling !== tray) bar.after(tray);
  const items = racks.filter(({ node }) => inManager(node)).map((r) => ({ ...r, cat: null }));
  renderTray(tray, items, MGR_SCOPE);
}

function layoutSplit(racks) {
  const c = container();
  const on = !!c && splitWanted();
  const body = document.body;
  const was = splitState.on;
  body.classList.toggle('fx-split', on);
  const sp = document.getElementById('fxWinSplit');
  if (!c) return;
  // every rack of the studio on screen (switched-off ones included, for the tray) / 화면 스튜디오의 모든 랙 (꺼진 것 포함)
  const studioRacks = racks.filter(({ node }) => !inManager(node) && c.contains(node) && !node.closest('.hidden, .fx-ws-hidden')
    && (node.offsetParent !== null || node.classList.contains('fx-win') || node.classList.contains('fx-mod-off') || node.classList.contains('fx-tg-hidden')));
  const wins = [];
  const tools = [];
  studioRacks.forEach(({ node, key }) => {
    if (node.classList.contains('fx-rack-float')) { node.classList.remove('fx-win', 'fx-tg-hidden'); if (!isWindowRack(node)) tools.push({ node, key, floating: true }); return; }
    if (node === fsNode) return; // full screen: out of the column / 전체화면: 열에서 제외
    if (isWindowRack(node)) { node.classList.remove('fx-tg-hidden'); wins.push({ node, key }); } else tools.push({ node, key });
  });
  const byDefault = tools.map((r, i) => ({ ...r, o: orderOf(r.node, i), cat: modInfo.get(r.node)?.cat || toolCategory(r.node, rackTitle(r.node)) }));
  const ordered = [];
  for (const cat of GROUP_CATS) ordered.push(...applySavedOrder(byDefault.filter((r) => r.cat === cat).sort((a, b) => a.o - b.o)));
  layoutChain(ordered);
  const nav = ensureNav();
  if (nav) { nav.style.order = '0'; renderTray(nav, ordered, studioId()); }
  if (!on) {
    if (was) {
      for (const { node } of racks) { node.classList.remove('fx-win'); node.style.order = ''; if (!node.classList.contains('fx-rack-float')) { node.style.left = ''; node.style.top = ''; if (!node.classList.contains('fx-rack-sized')) node.style.width = ''; } }
      c.style.paddingLeft = ''; c.style.paddingRight = ''; c.style.minHeight = '';
      for (const h of document.querySelectorAll('.fx-tg-head')) h.remove();
      for (const n of document.querySelectorAll('.fx-tg-hidden')) n.classList.remove('fx-tg-hidden');
      sp?.remove();
      splitState = { on: false, w: 0, left: 0 };
      globalThis.dispatchEvent(new Event('resize'));
    }
    lastTools = ordered.filter(({ node }) => modInfo.get(node)?.on && !node.classList.contains('hidden'));
    lastWins = [];
    return;
  }
  const z = zoom();
  // the main monitor, the module list, the timeline, then other views / 주 모니터 · 모듈 리스트 · 타임라인 · 기타 뷰
  const rank = (n) => (n === mainWin.node ? 0 : n.dataset.window === 'list' ? 1 : n.dataset.monitor === 'timeline' ? 2 : 3);
  wins.sort((a, b) => rank(a.node) - rank(b.node));
  const winsOrdered = applySavedOrder(wins);
  wins.splice(0, wins.length, ...winsOrdered);
  lastWins = wins.slice();
  setOrdButtons(lastWins);
  for (const { node } of tools) node.classList.remove('fx-win');
  // left column: the monitors / 왼쪽 열: 모니터
  const cr = c.getBoundingClientRect();
  const w = currentWinW();
  const left = Math.round(cr.left / z + BASE_PAD);
  c.style.paddingRight = '';
  c.style.paddingLeft = `${BASE_PAD + w + COL_GAP}px`;
  const top0 = headerBottom() / z + 8;
  document.documentElement.style.setProperty('--fx-hdr-h', `${Math.round(headerBottom() / z)}px`);
  const avail = globalThis.innerHeight / z - top0 - 8;
  let total = 0;
  for (const { node } of wins) total += node.getBoundingClientRect().height / z + 10;
  const over = Math.max(0, total - avail);
  // The page must be long enough to scroll the whole monitor column into view. / 모니터 열 끝까지 스크롤 가능하게
  c.style.minHeight = over > 0 ? `${Math.ceil(total + 24)}px` : '';
  // a column taller than the screen scrolls with the page until its end, then stays / 화면보다 길면 끝까지 함께 스크롤
  let y = top0 - Math.min(over, globalThis.scrollY / z);
  for (const { node } of wins) {
    node.classList.add('fx-win');
    node.style.left = `${left}px`;
    node.style.top = `${Math.round(y)}px`;
    node.style.width = `${w}px`;
    y += node.getBoundingClientRect().height / z + 10;
  }
  splitState.over = over;
  if (sp || wins.length) {
    const s = ensureSplitter();
    s.style.left = `${left + w + COL_GAP / 2 - 3}px`;
    s.style.top = `${top0}px`;
    s.style.height = `${Math.max(60, Math.min(avail, total))}px`;
    s.classList.toggle('hidden', !wins.length);
  }
  // right column: studio strip, then ① → ② → ③ → ④, each group in its own (saved) order
  // 오른쪽 열: 스튜디오 띠, ① → ② → ③ → ④ (묶음마다 저장된 순서)
  const heads = ensureGroupHeads(c);
  let n = 100;
  for (const cat of GROUP_CATS) {
    const list = ordered.filter((r) => r.cat === cat);
    const shown = list.filter(({ node }) => modInfo.get(node)?.on && !node.classList.contains('hidden'));
    const head = heads[cat];
    const folded = !!groupFold[studioId()]?.[cat];
    if (head) {
      head.classList.toggle('hidden', !shown.length);
      head.classList.toggle('fx-tg-folded', folded);
      head.setAttribute('aria-expanded', folded ? 'false' : 'true');
      head.style.order = String(n++);
    }
    for (const r of list) { if (!r.floating) r.node.style.order = String(n++); r.node.classList.toggle('fx-tg-hidden', folded && !!head && !r.floating); }
  }
  lastTools = ordered.filter(({ node, floating }) => !floating && modInfo.get(node)?.on && !node.classList.contains('hidden'));
  lastTools.forEach(({ node, cat }, i) => {
    const up = node.querySelector(':scope > .fx-rack-grip > .fx-rack-up');
    const down = node.querySelector(':scope > .fx-rack-grip > .fx-rack-down');
    if (up) up.disabled = i === 0 || lastTools[i - 1].cat !== cat;
    if (down) down.disabled = i === lastTools.length - 1 || lastTools[i + 1].cat !== cat;
  });
  if (nav) document.documentElement.style.setProperty('--fx-scroll-top', `${Math.round(headerBottom() / z + nav.getBoundingClientRect().height / z + 12)}px`);
  const changed = !was || splitState.w !== w || splitState.left !== left;
  splitState = { ...splitState, on: true, w, left };
  if (changed && !sizing) globalThis.dispatchEvent(new Event('resize')); // canvases re-measure once / 캔버스 재측정 (한 번)
}

/** Decorate every rack and apply the saved places of the studio on screen. / 손잡이 부착 + 위치 적용 */
function apply() {
  scheduled = false;
  const sid = studioId();
  const mgrPanel = document.getElementById('managerPanel');
  if (mgrPanel && observer && !mgrPanel.dataset.rackObserved) { mgrPanel.dataset.rackObserved = '1'; observer.observe(mgrPanel, { childList: true, subtree: true }); }
  const racks = listRacks();
  findMainWindow(racks);
  for (const { node, key } of racks) {
    const scope = inManager(node) ? MGR_SCOPE : sid;
    const places = store[scope] || {};
    ensureGrip(node);
    node.classList.add('fx-rack');
    const head = ensureHead(node);
    ensureSizer(node);
    const v = viewOf(key, scope);
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
    ensureFullBtn(node);
    if (fsNode === node) continue; // full screen: the layout leaves it alone / 전체화면 중에는 레이아웃이 건드리지 않음
    applySize(node, v, !inManager(node) && isWindowRack(node) && node.dataset.window !== 'list' && !p);
  }
  applyModules(racks);
  layoutManagerTray(racks);
  if (fsNode && (!fsNode.isConnected || fsNode.closest('.hidden, .fx-ws-hidden'))) leaveFull(); // studio switched / 스튜디오 전환
  else if (fsNode) fitFullHost();
  layoutSplit(racks);
  layoutPins();
}

onFlowChange(() => schedule());

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
  const n = Object.keys(store[sid] || {}).length + Object.keys(view[sid] || {}).length;
  delete store[sid];
  saveStore();
  delete view[sid]; // folded / pinned / resized blocks too / 접기·고정·크기도 해제
  saveView();
  delete winCol[sid];
  saveWin();
  if (orderStore[sid]) { delete orderStore[sid]; saveOrder(); }
  if (groupFold[sid]) { delete groupFold[sid]; try { globalThis.localStorage?.setItem(GROUP_KEY, JSON.stringify(groupFold)); } catch { /* session only */ } }
  for (const { node } of listRacks()) {
    if (inManager(node)) continue;
    unfloat(node);
    node.classList.remove('fx-rack-collapsed', 'fx-rack-pinned', 'fx-rack-sized');
    node.style.maxHeight = '';
    node.style.height = '';
    if (!node.classList.contains('fx-win')) { node.style.top = ''; node.style.width = ''; }
    const host = isWindowRack(node) ? canvasHost(node) : null;
    if (host) { host.style.height = ''; host.style.maxHeight = ''; }
  }
  schedule();
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
  loadWin();
  loadOrder();
  loadGroupFold();
  loadMods();
  const main = document.getElementById('workspaceContainer') || document.body;
  observer = new MutationObserver(schedule);
  observer.observe(main, { childList: true, subtree: true });
  globalThis.addEventListener('resize', () => { if (!scheduled) schedule(); });
  // the window column follows the page; a tall one scrolls with it until its end / 윈도우 열이 스크롤을 따라감
  globalThis.addEventListener('scroll', () => { if (splitState.on && splitState.over > 0) schedule(); }, { passive: true });
  globalThis.addEventListener('pointerup', () => setTimeout(rememberSizes, 0)); // after a corner resize / 모서리 크기 조절 후
  document.addEventListener('fullscreenchange', onFullChange);
  document.addEventListener('webkitfullscreenchange', onFullChange);
  // Esc also leaves the overlay mode (no Fullscreen API) / 오버레이 모드도 Esc로 해제
  globalThis.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fsNode?.classList.contains('fx-mon-fs-css')) leaveFull(); });
  schedule();
}
