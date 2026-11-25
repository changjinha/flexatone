/**
 * Flexatone — ui/signal-flow.js
 * Layer 4 (ui): the editable **Signal flow** of a studio's toolboxes (core/signal-flow.js): where it is stored, the
 * port editor that opens from a toolbox, and the patcher drawing of the Signal flow toolbox (④ Utility).
 * 계층 4 (ui): 툴박스 시그널 플로우의 저장소, 툴박스에서 여는 포트 편집기, 시그널 플로우 툴박스의 패처 그림.
 *
 *   - Per studio, in this browser (localStorage, like the module tray and the toolbox order): the flow and, per toolbox,
 *     whether its ports are open (the small ⇄ "signal flow" button on every toolbox except the Utility one).
 *   - A box can receive from several boxes and send to several (many-to-many). Boxes in the same stage are parallel.
 *   - Editing first turns the shown patch into the user's own (`custom`), so what you see is what you edit. Cords of
 *     switched-off toolboxes are collapsed (bypass) at that moment. "Serial" goes back to the order-derived default.
 *   - The flow is a PATCH RECORD: it is not yet what the studios' sound engines follow (see docs/STUDIO_INTEGRATION_LOG.md).
 * Imports: core/*, ui/option-inspector.js (help).
 */

import { I18N, t } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';
import { SRC, DST, normalizeFlow, createFlow, effectiveEdges, addEdge, removeEdge, inputsOf, outputsOf, isUnpatched, stagesOf, parallelGroups, isSerial } from '../core/signal-flow.js';

const FLOW_KEY = 'flexatone.signalFlow.v1'; // { [studio]: Flow }
const PORTS_KEY = 'flexatone.flowPorts.v1'; // { [studio]: { [rackKey]: false } } — open unless set to false

Object.assign(I18N.en, {
  'sf.title': 'Signal flow',
  'sf.sub': 'who sends to whom — drag ● bottom → ● top',
  'sf.serial': 'Serial',
  'sf.serialTip': 'Back to the default: the switched-on toolboxes one after another',
  'sf.state.serial': 'serial',
  'sf.state.custom': 'custom patch',
  'sf.state.parallel': 'parallel',
  'sf.in': 'in',
  'sf.out': 'out',
  'sf.from': 'Receives from',
  'sf.to': 'Sends to',
  'sf.none': '—',
  'sf.unpatched': 'unpatched',
  'sf.toggle': 'Signal flow of this toolbox: open / close its ports',
  'sf.hint': 'Drag from a box’s bottom dot to another box’s top dot to patch it · click a cord to cut it · a box may take and give several',
  'sf.err.cycle': 'That cord would close a loop',
  'sf.err.dup': 'Already patched',
  'sf.err.self': 'A box cannot feed itself',
  'sf.err.src-in': 'Nothing goes into the monitors',
  'sf.err.dst-out': 'Nothing leaves the output',
  'sf.close': 'Close',
});
Object.assign(I18N.ko, {
  'sf.title': '시그널 플로우',
  'sf.sub': '누가 누구에게 보내는지 — 출력 ● → 입력 ●로 끌기',
  'sf.serial': '직렬',
  'sf.serialTip': '기본으로: 켜진 툴박스를 차례로 잇기',
  'sf.state.serial': '직렬',
  'sf.state.custom': '사용자 패치',
  'sf.state.parallel': '병렬',
  'sf.in': '입력',
  'sf.out': '출력',
  'sf.from': '받는 곳',
  'sf.to': '보내는 곳',
  'sf.none': '—',
  'sf.unpatched': '연결 없음',
  'sf.toggle': '이 툴박스의 시그널 플로우: 포트 열기 / 닫기',
  'sf.hint': '상자의 아래쪽 점에서 다른 상자의 위쪽 점으로 끌어 연결 · 선을 클릭하면 끊김 · 한 상자가 여러 개를 받고 줄 수 있음',
  'sf.err.cycle': '그 선은 순환(루프)을 만듭니다',
  'sf.err.dup': '이미 연결되어 있습니다',
  'sf.err.self': '상자는 자기 자신에게 보낼 수 없습니다',
  'sf.err.src-in': '모니터로 들어가는 선은 없습니다',
  'sf.err.dst-out': '출력에서 나가는 선은 없습니다',
  'sf.close': '닫기',
});
HELP_DB['app.signalFlow'] = {
  en: { title: 'Signal flow', summary: 'Which toolbox sends its signal to which, patched like Max/MSP: a box can receive from several boxes and send to several; boxes in the same column run side by side (parallel).', detail: 'Default = serial, in the order of the switched-on toolboxes ① → ② → ③ (▲ / ▼ changes it). Drag from a box’s bottom dot to another box’s top dot to add a cord, click a cord to cut it; loops are refused. A switched-off toolbox is bypassed. The small ⇄ button on every toolbox opens / closes its ports; click a port to choose its sources / targets. Remembered per studio in this browser. Today the flow is the patch record of the studio — the sound engines do not yet follow it.', formula: '' },
  ko: { title: '시그널 플로우', summary: '어느 툴박스가 어느 툴박스로 신호를 보내는지를 Max/MSP처럼 연결합니다. 한 상자가 여러 곳에서 받고 여러 곳으로 보낼 수 있고, 같은 열의 상자는 나란히(병렬) 처리됩니다.', detail: '기본은 켜진 툴박스 ① → ② → ③ 순서의 직렬입니다(▲ / ▼로 바꿈). 상자의 아래쪽 점에서 다른 상자의 위쪽 점으로 끌면 선이 생기고, 선을 클릭하면 끊깁니다. 순환(루프)은 거부됩니다. 꺼진 툴박스는 우회됩니다. 모든 툴박스의 작은 ⇄ 버튼은 그 포트를 열고 닫으며, 포트를 클릭하면 받는 곳 / 보내는 곳을 고릅니다. 이 브라우저에 스튜디오별로 기억됩니다. 지금은 스튜디오의 패치 기록이며, 소리 엔진이 아직 이 흐름을 따르지는 않습니다.', formula: '' },
};
HELP_DB['app.flowToggle'] = {
  en: { title: 'Signal flow button', summary: 'Opens / closes the ◀ in and out ▶ ports of this toolbox (who it receives from, who it sends to).', detail: 'Click a port to change it. The Utility toolbox (Signal flow) has no such button.', formula: '' },
  ko: { title: '시그널 플로우 버튼', summary: '이 툴박스의 ◀ 입력 · 출력 ▶ 포트(누구에게서 받고 누구에게 보내는지)를 열고 닫습니다.', detail: '포트를 클릭하면 바꿀 수 있습니다. 유틸리티 툴박스(시그널 플로우)에는 이 버튼이 없습니다.', formula: '' },
};

// ==========================================================================
// Store / 저장소
// ==========================================================================

let flows = {};
let ports = {};
const listeners = new Set();
function load() {
  try { flows = JSON.parse(globalThis.localStorage?.getItem(FLOW_KEY) || '{}') || {}; } catch { flows = {}; }
  try { ports = JSON.parse(globalThis.localStorage?.getItem(PORTS_KEY) || '{}') || {}; } catch { ports = {}; }
}
function save() {
  try { globalThis.localStorage?.setItem(FLOW_KEY, JSON.stringify(flows)); globalThis.localStorage?.setItem(PORTS_KEY, JSON.stringify(ports)); } catch { /* session only */ }
}
load();
const emit = () => { for (const fn of listeners) { try { fn(); } catch (e) { console.error(e); } } };

/** Subscribe to flow / port changes (re-layout). Returns unsubscribe. */
export function onFlowChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const getFlow = (studio) => normalizeFlow(flows[studio]);

export function setFlow(studio, flow) {
  if (flow.custom) flows[studio] = { custom: true, edges: flow.edges }; else delete flows[studio];
  save();
  emit();
}

/** Back to the default serial patch. / 기본 직렬로 */
export function resetFlow(studio) { setFlow(studio, createFlow()); }

export const flowPortsOpen = (studio, key) => ports[studio]?.[key] !== false;
export function setFlowPorts(studio, key, on) {
  ports[studio] = { ...(ports[studio] || {}) };
  if (on) delete ports[studio][key]; else ports[studio][key] = false;
  save();
  emit();
}

/**
 * The patch as drawn now: stored cords between the switched-on boxes (off boxes bypassed) — or the serial default.
 * @param {string} studio @param {string[]} onKeys switched-on signal toolboxes in group order
 */
export function resolveEdges(studio, onKeys) {
  return effectiveEdges(getFlow(studio), onKeys);
}

/**
 * Edit the patch. The shown patch becomes the user's own first; `fn(flow)` returns { ok, flow, reason? } (addEdge /
 * removeEdge) or a Flow. Returns { ok, reason? }. 편집: 보이는 패치를 사용자 패치로 만든 뒤 적용
 */
export function editFlow(studio, onKeys, fn) {
  const cur = { custom: true, edges: resolveEdges(studio, onKeys) };
  const r = fn(cur);
  const next = r && 'flow' in r ? r.flow : r;
  if (r && r.ok === false) return { ok: false, reason: r.reason };
  setFlow(studio, normalizeFlow(next));
  return { ok: true };
}

export const connect = (studio, onKeys, from, to) => editFlow(studio, onKeys, (f) => addEdge(f, from, to));
export const disconnect = (studio, onKeys, from, to) => editFlow(studio, onKeys, (f) => removeEdge(f, from, to));

/** "A, B" or "A, B +2" for a port label. / 포트 이름 목록 */
export function namesLabel(names, max = 2) {
  if (!names.length) return t('sf.none');
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

// ==========================================================================
// Port editor: a small popover opened from a port / 포트 편집기
// ==========================================================================

let pop = null;
export function closeFlowPopover() {
  pop?.remove();
  pop = null;
}

/**
 * @param {HTMLElement} anchor the port button
 * @param {{ studio: string, dir: 'in'|'out', key: string, steps: Array<{key:string,title:string}>, labels: {src:string,dst:string} }} o
 */
export function openFlowPopover(anchor, o) {
  closeFlowPopover();
  const onKeys = o.steps.map((s) => s.key);
  const title = (k) => (k === SRC ? o.labels.src : k === DST ? o.labels.dst : o.steps.find((s) => s.key === k)?.title || k);
  const box = document.createElement('div');
  box.className = 'fx-flow-pop';
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  const paint = (msg = '') => {
    const edges = resolveEdges(o.studio, onKeys);
    const cands = o.dir === 'in' ? [SRC, ...onKeys.filter((k) => k !== o.key)] : [...onKeys.filter((k) => k !== o.key), DST];
    box.replaceChildren();
    const h = document.createElement('div');
    h.className = 'fx-flow-pop-h';
    h.textContent = `${title(o.key)} — ${t(o.dir === 'in' ? 'sf.from' : 'sf.to')}`;
    box.append(h);
    for (const c of cands) {
      const on = o.dir === 'in' ? edges.some((e) => e[0] === c && e[1] === o.key) : edges.some((e) => e[0] === o.key && e[1] === c);
      const row = document.createElement('label');
      row.className = 'fx-flow-pop-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.addEventListener('change', () => {
        const [from, to] = o.dir === 'in' ? [c, o.key] : [o.key, c];
        const r = cb.checked ? connect(o.studio, onKeys, from, to) : disconnect(o.studio, onKeys, from, to);
        paint(r.ok ? '' : t(`sf.err.${r.reason}`));
      });
      row.append(cb, Object.assign(document.createElement('span'), { textContent: title(c) }));
      box.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'fx-flow-pop-f';
    foot.textContent = msg;
    const serial = Object.assign(document.createElement('button'), { type: 'button', className: 'fx-tray-btn', textContent: t('sf.serial'), title: t('sf.serialTip') });
    serial.addEventListener('click', () => { resetFlow(o.studio); paint(); });
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'fx-tray-btn', textContent: t('sf.close') });
    close.addEventListener('click', closeFlowPopover);
    foot.append(serial, close);
    box.append(foot);
  };
  paint();
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 250, r.left))}px`;
  box.style.top = `${Math.min(window.innerHeight - 40 - box.offsetHeight, r.bottom + 4)}px`;
  setTimeout(() => {
    const off = (e) => { if (!pop || pop.contains(e.target) || anchor.contains(e.target)) return; closeFlowPopover(); document.removeEventListener('pointerdown', off, true); };
    document.addEventListener('pointerdown', off, true);
  }, 0);
  pop = box;
}

// ==========================================================================
// Patcher drawing (Signal flow toolbox) / 패처 그림
// ==========================================================================

const CAT_COLOR = { src: '#f8fafc', gen: '#38bdf8', proc: '#a78bfa', post: '#34d399', dst: '#fbbf24', space: '#f472b6' };
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Signature of what the patcher shows (to skip redraws). / 다시 그릴지 판단용 서명 */
export function patcherSig(studio, chain, width) {
  return `${width}|${JSON.stringify(resolveEdges(studio, chain.steps.map((s) => s.key)))}|${chain.steps.map((s) => `${s.key}:${s.title}`).join('|')}|${chain.dest.label}|${chain.dest.space ? 1 : 0}`;
}

/**
 * Draw the patcher into `box` and wire its mouse handling.
 * @param {HTMLElement} box
 * @param {{ studio: string, chain: { source: string, steps: Array<{key,title,cat,node}>, dest: {label:string,space:boolean} }, jump: (node) => void, notify: (msg: string) => void }} o
 */
export function renderPatcher(box, o) {
  const { studio, chain } = o;
  const keys = chain.steps.map((s) => s.key);
  const edges = resolveEdges(studio, keys);
  const stage = stagesOf(edges, keys);
  const info = new Map([[SRC, { title: chain.source, cat: 'src' }], [DST, { title: chain.dest.label, cat: chain.dest.space ? 'space' : 'dst' }]]);
  for (const s of chain.steps) info.set(s.key, { title: s.title, cat: s.cat, node: s.node });
  // rows = stages, top → bottom like a Max patcher (inlet on top, outlet at the bottom); boxes of one stage stand side by
  // side = parallel. Unpatched boxes wait in the first row next to the monitors. 행 = 단계 (위 → 아래), 같은 행 = 병렬
  const last = Math.max(1, ...keys.map((k) => stage.get(k) ?? 0), 1);
  const rowOf = (k) => (k === SRC ? 0 : k === DST ? last + 1 : stage.get(k) > 0 ? stage.get(k) : 0);
  const rows = new Map();
  for (const k of [SRC, ...keys, DST]) { const c = rowOf(k); rows.set(c, [...(rows.get(c) || []), k]); }
  const NW = 118;
  const NH = 22;
  const GX = 10;
  const GY = 24;
  const pos = new Map();
  let W = 0;
  for (const [rIdx, list] of rows) list.forEach((k, c) => { pos.set(k, { x: 6 + c * (NW + GX), y: 6 + rIdx * (NH + GY) }); W = Math.max(W, 6 + (c + 1) * (NW + GX)); });
  const H = 6 + (last + 2) * (NH + GY) - GY + 6;
  const outP = (k) => ({ x: pos.get(k).x + NW / 2, y: pos.get(k).y + NH });
  const inP = (k) => ({ x: pos.get(k).x + NW / 2, y: pos.get(k).y });
  const cord = (a, b) => { const dy = Math.max(14, Math.abs(b.y - a.y) / 2); return `M${a.x} ${a.y} C${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`; };
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">`;
  for (const [a, b] of edges) {
    const d = cord(outP(a), inP(b));
    const col = CAT_COLOR[info.get(b).cat] || '#64748b';
    svg += `<path d="${d}" fill="none" stroke="${col}" stroke-opacity=".8" stroke-width="1.6"/><path d="${d}" fill="none" stroke="transparent" stroke-width="9" data-pf-edge="${esc(a)}>${esc(b)}" style="cursor:pointer"><title>${esc(info.get(a).title)} → ${esc(info.get(b).title)}</title></path>`;
  }
  for (const k of [SRC, ...keys, DST]) {
    const { x, y } = pos.get(k);
    const n = info.get(k);
    const c = CAT_COLOR[n.cat] || '#64748b';
    const dim = k !== SRC && k !== DST && isUnpatched(edges, k);
    const label = n.title.length > 15 ? `${n.title.slice(0, 14)}…` : n.title;
    svg += `<g ${k !== SRC && k !== DST ? `data-pf-box="${esc(k)}"` : ''} opacity="${dim ? 0.55 : 1}"><title>${esc(n.title)}${dim ? ` (${esc(t('sf.unpatched'))})` : ''}</title>`
      + `<rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="3" fill="#020617" stroke="${c}" stroke-width="1.2" ${dim ? 'stroke-dasharray="3 3"' : ''}/>`
      + `<text x="${x + 9}" y="${y + 15}" fill="#e2e8f0" font-size="10.5" font-family="ui-monospace, monospace" style="pointer-events:none">${esc(label)}</text>`
      + (k !== SRC ? `<circle cx="${x + NW / 2}" cy="${y}" r="4.5" fill="${c}" stroke="#020617" data-pf-in="${esc(k)}" style="cursor:crosshair"/>` : '')
      + (k !== DST ? `<circle cx="${x + NW / 2}" cy="${y + NH}" r="4.5" fill="${c}" stroke="#020617" data-pf-out="${esc(k)}" style="cursor:crosshair"/>` : '')
      + '</g>';
  }
  svg += '</svg>';
  const par = parallelGroups(edges, keys).length;
  const state = !isSerial(edges, keys) ? (par ? 'parallel' : 'custom') : 'serial';
  box.innerHTML = `<div class="fx-pf-scroll">${svg}</div>`;
  box.dataset.pfState = state;

  const svgEl = box.querySelector('svg');
  const toLocal = (e) => { const r = svgEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  box.onpointerdown = (e) => {
    const out = e.target.closest?.('[data-pf-out]');
    if (!out) return;
    e.preventDefault();
    const from = out.dataset.pfOut;
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('fill', 'none');
    tmp.setAttribute('stroke', '#e2e8f0');
    tmp.setAttribute('stroke-dasharray', '4 3');
    tmp.setAttribute('stroke-width', '1.4');
    svgEl.append(tmp);
    const move = (ev) => tmp.setAttribute('d', cord(outP(from), toLocal(ev)));
    const up = (ev) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      tmp.remove();
      const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-pf-in]');
      if (!hit) return;
      const r = connect(studio, keys, from, hit.dataset.pfIn);
      if (!r.ok) o.notify(t(`sf.err.${r.reason}`));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    move(e);
  };
  box.onclick = (e) => {
    const edge = e.target.closest?.('[data-pf-edge]');
    if (edge) { const [a, b] = edge.dataset.pfEdge.split('>'); disconnect(studio, keys, a, b); return; }
    const b = e.target.closest?.('[data-pf-box]');
    if (b && !e.target.closest('[data-pf-in],[data-pf-out]')) o.jump(info.get(b.dataset.pfBox)?.node);
  };
  return { state, edges };
}
