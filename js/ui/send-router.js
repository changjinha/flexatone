/**
 * Flexatone — ui/send-router.js
 * Layer 4 (ui): **⇄ Sends** — the order tool for trajectory sends (logic: studios/trajectory-link.js).
 * One window shows, at a glance:
 *   1. Flow: every studio in its stage (column) and every send as an arrow. A receiving studio is always
 *      in a later column than the studios it receives from, so a chain A → B → C reads left to right.
 *      The number on an arrowhead is that send's place in the receiving studio's order.
 *   2. Receive order: for each receiving studio (in evaluation order) its sends top to bottom — ▲ ▼ move a
 *      send inside that studio, Replace / Add sets how it combines, ● switches it off, × removes it.
 *   3. Send list: every send in list order (this order also decides which send is cut when two close a loop).
 * 계층 4 (ui): 보내기 순서 도구 — 흐름(단계별 열), 받는 순서(스튜디오별), 전체 목록.
 */

import { t, I18N } from '../core/i18n.js';
import { appState, subscribe } from '../core/state.js';
import {
  buildSendPlan, setSend, removeSend, moveInbound, moveSendTo, missingSendEdges, setVoiceLinksLocked, MASTER, MEAN_LINE, SEND_STUDIO_ORDER,
} from '../studios/trajectory-link.js';
import { openSendWindow, onSendsChanged, studioLabel } from './trajectory-ui.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'sends.btn': 'Sends',
  'sends.btnTitle': 'Send / receive order of trajectories between studios',
  'sends.title': 'Send / Receive order',
  'sends.rules': 'Studios are evaluated left to right by stage: a studio always receives after every studio it receives from (A → B → C sends the B that already took A). Inside one studio its sends apply top to bottom — Replace starts again from that line, Add adds its motion on top.',
  'sends.flow': 'Flow',
  'sends.receivers': 'Receive order (per studio)',
  'sends.list': 'All sends (list order)',
  'sends.listHint': 'List order decides which send is cut when two sends would make a loop (the later one).',
  'sends.empty': 'No sends yet. Use ⤴ Send in a studio, ⤵ Receive, or + New send.',
  'sends.new': '+ New send',
  'sends.stage': (k) => `Stage ${k}`,
  'sends.receives': (studio) => `${studio} receives`,
  'sends.viaMaster': 'via Master',
  'sends.up': 'Earlier (applied before the one above)',
  'sends.down': 'Later',
  'sends.on': 'On / off',
  'sends.remove': 'Remove this send (the received line stays)',
  'sends.removeMaster': 'Remove this Master send (every studio stops receiving it)',
  'sends.skipHere': 'Skip this studio (the Master send keeps going to the others)',
  'sends.status.loop': (path) => `⟲ loop — not applied (${path})`,
  'sends.status.off': 'off',
  'sends.status.away': 'bound to another instance — applies when it is in the editor',
  'sends.status.missing': 'source line not found',
  'sends.status.self': 'source itself',
  'sends.result': 'Result',
  'sends.overridden': 'overridden by a later Replace',
  'sends.masterNote': 'Master sends: mode and on/off apply to every studio they reach.',
  'sends.close': 'Close',
});
Object.assign(I18N.ko, {
  'sends.btn': '보내기',
  'sends.btnTitle': '스튜디오 간 궤적 보내기 / 받기 순서',
  'sends.title': '보내기 / 받기 순서',
  'sends.rules': '스튜디오는 단계 순서(왼쪽 → 오른쪽)로 평가됩니다. 받는 스튜디오는 항상 자신에게 보내는 모든 스튜디오보다 뒤에 받습니다 (A → B → C면 C는 A를 이미 받은 B를 받음). 한 스튜디오 안에서는 위에서 아래로 적용됩니다 — 교체는 그 선에서 다시 시작, 윤곽 더하기는 위에 더함.',
  'sends.flow': '흐름',
  'sends.receivers': '받는 순서 (스튜디오별)',
  'sends.list': '전체 보내기 (목록 순서)',
  'sends.listHint': '두 보내기가 순환을 만들면 목록에서 뒤에 있는 것이 잘립니다.',
  'sends.empty': '아직 보내기가 없습니다. 스튜디오의 ⤴ 보내기, ⤵ 받기, 또는 + 새 보내기를 쓰세요.',
  'sends.new': '+ 새 보내기',
  'sends.stage': (k) => `${k}단계`,
  'sends.receives': (studio) => `${studio}가 받는 것`,
  'sends.viaMaster': '마스터 경유',
  'sends.up': '먼저 (위의 것보다 먼저 적용)',
  'sends.down': '나중에',
  'sends.on': '켜기 / 끄기',
  'sends.remove': '이 보내기 삭제 (받은 선은 유지)',
  'sends.removeMaster': '이 마스터 보내기 삭제 (모든 스튜디오가 받지 않게 됨)',
  'sends.skipHere': '이 스튜디오만 건너뛰기 (마스터 보내기는 다른 스튜디오로 계속)',
  'sends.status.loop': (path) => `⟲ 순환 — 적용 안 됨 (${path})`,
  'sends.status.off': '꺼짐',
  'sends.status.away': '다른 인스턴스에 묶임 — 그 인스턴스가 에디터에 있을 때 적용',
  'sends.status.missing': '원본 선을 찾을 수 없음',
  'sends.status.self': '원본 자신',
  'sends.result': '결과',
  'sends.overridden': '뒤의 교체에 덮임',
  'sends.masterNote': '마스터 보내기: 방식과 켜기/끄기는 그것이 닿는 모든 스튜디오에 적용됩니다.',
  'sends.close': '닫기',
});

HELP_DB['app.sends'] = {
  en: { title: 'Send / Receive order', summary: 'See and change who receives which trajectory, and in which order.', detail: 'Flow: studios in columns by stage, sends as arrows (dashed = via Master, red = loop, grey = off). Receive order: per receiving studio, its sends top to bottom; ▲ ▼ reorder, Replace / Add sets how a send combines, ● switches it off, × removes it (on a Master send, ⊘ skips only this studio). All sends: the list order, which also decides the loop cut.', formula: 'line(C) = fold over C’s sends: replace → src, add → line + (src − src₀)' },
  ko: { title: '보내기 / 받기 순서', summary: '어떤 스튜디오가 어떤 궤적을 어떤 순서로 받는지 보고 바꿉니다.', detail: '흐름: 단계별 열에 스튜디오, 화살표는 보내기 (점선 = 마스터 경유, 빨강 = 순환, 회색 = 꺼짐). 받는 순서: 받는 스튜디오마다 위에서 아래로; ▲ ▼ 순서 변경, 교체 / 더하기 방식, ● 켜기/끄기, × 삭제 (마스터 보내기는 ⊘로 이 스튜디오만 건너뜀). 전체 보내기: 목록 순서 (순환 시 잘리는 쪽도 이 순서로 결정).', formula: 'line(C) = C가 받는 보내기를 차례로: 교체 → src, 더하기 → line + (src − src₀)' },
};

let hooks = { showToast: () => {} };
let win = null;

const STUDIO_COLOR = { glissando: '#38bdf8', risset: '#a78bfa', field: '#34d399', draw: '#f472b6', chaos: '#fb923c', cloud: '#94a3b8', tempo: '#facc15', space: '#22d3ee', fractal: '#c084fc', wave: '#2dd4bf' };
const lineName = (send) => (send.from.line === MEAN_LINE ? t('traj.mean') : send.from.name || send.from.line);
const statusText = (e, missing) => {
  if (e.status === 'loop') return t('sends.status.loop', (e.path ? [...e.path, e.to] : [e.from, e.to]).map(studioLabel).join(' → '));
  if (e.status !== 'ok') return t(`sends.status.${e.status}`);
  if (missing.has(`${e.sendId}>${e.to}`)) return t('sends.status.missing');
  return '';
};

// ==========================================================================
// Flow diagram (SVG) / 흐름도
// ==========================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  for (const c of children) if (c) n.append(c);
  return n;
}

function buildFlow(plan) {
  const nodes = plan.order;
  if (!nodes.length) return el('p', { class: 'text-xs text-slate-500', text: t('sends.empty') });
  const maxStage = Math.max(0, ...nodes.map((n) => plan.stage.get(n) || 0));
  const cols = maxStage + 1;
  const NW = 118;
  const NH = 30;
  const GAPX = 70;
  const GAPY = 16;
  const byCol = Array.from({ length: cols }, () => []);
  for (const n of nodes) byCol[plan.stage.get(n) || 0].push(n);
  const rows = Math.max(...byCol.map((c) => c.length));
  const W = cols * NW + (cols - 1) * GAPX + 40;
  const H = rows * NH + (rows - 1) * GAPY + 46;
  const pos = new Map();
  byCol.forEach((col, ci) => {
    const x = 20 + ci * (NW + GAPX);
    const top = 30 + ((rows - col.length) * (NH + GAPY)) / 2;
    col.forEach((n, ri) => pos.set(n, { x, y: top + ri * (NH + GAPY) }));
  });
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'fx-sends-flow' });
  root.append(svg('defs', {}, [
    ...[['ok', '#38bdf8'], ['add', '#fbbf24'], ['bad', '#f87171'], ['off', '#475569']].map(([id, c]) => svg('marker', { id: `fxArrow-${id}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, [svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: c })])),
  ]));
  for (let ci = 0; ci < cols; ci++) {
    const lbl = svg('text', { x: 20 + ci * (NW + GAPX) + NW / 2, y: 16, 'text-anchor': 'middle', class: 'fx-sends-stage' });
    lbl.textContent = t('sends.stage', ci + 1);
    root.append(lbl);
  }
  // edges / 간선
  const missing = missingSendEdges();
  const slot = new Map(); // per target: running index of inbound / 받는 순서 번호
  for (const e of plan.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const list = plan.inbound.get(e.to) || [];
    const k = list.indexOf(e) + 1;
    const n = list.length;
    const i = slot.get(e.to) || 0;
    slot.set(e.to, i + 1);
    const bad = e.status === 'loop' || missing.has(`${e.sendId}>${e.to}`);
    const kind = bad ? 'bad' : e.status === 'ok' ? (e.mode === 'add' ? 'add' : 'ok') : 'off';
    const color = { ok: '#38bdf8', add: '#fbbf24', bad: '#f87171', off: '#475569' }[kind];
    const ya = a.y + NH / 2;
    const yb = b.y + 6 + ((NH - 12) * (n > 1 ? i / (n - 1) : 0.5));
    let d;
    if (b.x > a.x) {
      const x0 = a.x + NW;
      const x1 = b.x - 2;
      const mid = (x0 + x1) / 2;
      d = `M${x0},${ya} C${mid},${ya} ${mid},${yb} ${x1},${yb}`;
    } else { // backwards (loop / off): an arc below / 역방향: 아래로 돌아감
      const x0 = a.x + NW / 2;
      const x1 = b.x + NW / 2;
      const yy = Math.max(a.y, b.y) + NH + 22;
      d = `M${x0},${a.y + NH} C${x0},${yy} ${x1},${yy} ${x1},${b.y + NH + 2}`;
    }
    const path = svg('path', { d, fill: 'none', stroke: color, 'stroke-width': e.status === 'ok' ? 2 : 1.5, 'stroke-dasharray': e.viaMaster ? '6 4' : e.status === 'off' || e.status === 'away' ? '2 4' : null, 'marker-end': `url(#fxArrow-${kind})`, opacity: e.status === 'ok' ? 0.95 : 0.7 });
    const tip = svg('title');
    tip.textContent = `${studioLabel(e.from)} ▸ ${lineName(e.send)} → ${studioLabel(e.to)} · ${t(`traj.mode.${e.mode}`)}${e.viaMaster ? ` · ${t('sends.viaMaster')}` : ''}${statusText(e, missing) ? ` · ${statusText(e, missing)}` : ''}`;
    path.append(tip);
    root.append(path);
    if (k > 0 && b.x > a.x) {
      root.append(svg('circle', { cx: b.x - 14, cy: yb, r: 7, fill: '#0f172a', stroke: color, 'stroke-width': 1.2 }));
      const num = svg('text', { x: b.x - 14, y: yb + 3.5, 'text-anchor': 'middle', class: 'fx-sends-num', fill: color });
      num.textContent = String(k);
      root.append(num);
    }
  }
  // nodes / 노드
  for (const n of nodes) {
    const p = pos.get(n);
    const g = svg('g', { class: 'fx-sends-node', 'data-studio': n });
    g.append(svg('rect', { x: p.x, y: p.y, width: NW, height: NH, rx: 8, fill: '#0f172a', stroke: STUDIO_COLOR[n] || '#64748b', 'stroke-width': 1.5 }));
    g.append(svg('rect', { x: p.x, y: p.y, width: 5, height: NH, rx: 2, fill: STUDIO_COLOR[n] || '#64748b' }));
    const txt = svg('text', { x: p.x + 12, y: p.y + NH / 2 + 4, class: 'fx-sends-label' });
    txt.textContent = studioLabel(n).replace(/ Studio$| 스튜디오$/, '');
    g.append(txt);
    root.append(g);
  }
  return el('div', { class: 'fx-sends-flowbox' }, [root]);
}

// ==========================================================================
// Receive order + list / 받는 순서와 전체 목록
// ==========================================================================

const IBTN = 'fx-sends-ibtn';

function modeToggle(send) {
  return el('span', { class: 'fx-traj-segs' }, ['replace', 'add'].map((m) => el('button', {
    class: `fx-traj-seg ${send.mode === m ? 'is-on' : ''}`,
    text: t(`traj.mode.${m}`),
    on: { click: () => { if (send.mode !== m) setSend(send.id, { mode: m }); } },
  })));
}

function receiverCard(plan, to, missing) {
  const list = plan.inbound.get(to) || [];
  // which sends end up in the result: everything after the last applied Replace / 결과에 남는 것
  let lastReplace = -1;
  list.forEach((e, i) => { if (e.status === 'ok' && !missing.has(`${e.sendId}>${e.to}`) && e.mode === 'replace') lastReplace = i; });
  const rows = list.map((e, i) => {
    const s = e.send;
    const st = statusText(e, missing);
    const overridden = e.status === 'ok' && !st && i < lastReplace;
    return el('div', { class: `fx-sends-row ${e.status !== 'ok' || st ? 'is-dim' : ''} ${overridden ? 'is-over' : ''}` }, [
      el('span', { class: 'fx-sends-k', text: String(i + 1) }),
      el('span', { class: 'flex flex-col min-w-[150px] flex-1' }, [
        el('span', { class: 'truncate' }, [
          el('span', { class: 'fx-sends-dot', style: `background:${STUDIO_COLOR[e.from] || '#64748b'}` }),
          el('b', { text: studioLabel(e.from) }), ` ▸ ${lineName(s)}`,
          e.viaMaster ? el('span', { class: 'fx-sends-badge', text: t('sends.viaMaster') }) : null,
          e.from === 'glissando' ? el('button', { class: 'fx-sends-lock', text: s.locked ? '🔒' : '🔓', title: t(s.locked ? 'traj.lockTitleLocked' : 'traj.lockTitleLinked', studioLabel(e.to)), on: { click: () => setVoiceLinksLocked(s.from.line, !s.locked) } }) : null,
        ]),
        st ? el('span', { class: e.status === 'loop' || st === t('sends.status.missing') ? 'text-rose-300 text-[10px]' : 'text-slate-500 text-[10px]', text: st }) : null,
        overridden ? el('span', { class: 'text-slate-500 text-[10px]', text: t('sends.overridden') }) : null,
      ]),
      modeToggle(s),
      el('button', { class: `${IBTN} ${s.on ? 'text-emerald-300' : 'text-slate-500'}`, text: s.on ? '●' : '○', title: t('sends.on'), on: { click: () => setSend(s.id, { on: !s.on }) } }),
      el('button', { class: IBTN, text: '▲', title: t('sends.up'), disabled: i === 0, on: { click: () => moveInbound(to, s.id, -1) } }),
      el('button', { class: IBTN, text: '▼', title: t('sends.down'), disabled: i === list.length - 1, on: { click: () => moveInbound(to, s.id, +1) } }),
      e.viaMaster
        ? el('button', { class: `${IBTN} hover:text-amber-300`, text: '⊘', title: t('sends.skipHere'), on: { click: () => setSend(s.id, { except: [...new Set([...s.except, to])] }) } })
        : el('button', { class: `${IBTN} hover:text-rose-300`, text: '×', title: t('sends.remove'), on: { click: () => removeSend(s.id) } }),
    ]);
  });
  return el('div', { class: 'fx-sends-card' }, [
    el('div', { class: 'flex items-center gap-2' }, [
      el('span', { class: 'fx-sends-stagechip', text: t('sends.stage', (plan.stage.get(to) || 0) + 1) }),
      el('span', { class: 'fx-sends-dot', style: `background:${STUDIO_COLOR[to] || '#64748b'}` }),
      el('b', { class: 'text-slate-100 text-xs', text: t('sends.receives', studioLabel(to)) }),
    ]),
    ...rows,
  ]);
}

function sendListCard(plan) {
  const sends = plan.sends;
  return el('div', { class: 'fx-sends-card' }, [
    el('p', { class: 'text-[10px] text-slate-500', text: t('sends.listHint') }),
    ...sends.map((s, i) => {
      const edges = plan.edges.filter((e) => e.sendId === s.id);
      const to = s.to === MASTER ? `${t('traj.masterShort')}${s.except.length ? ` − ${s.except.map(studioLabel).join(', ')}` : ''}` : studioLabel(s.to);
      const loops = edges.filter((e) => e.status === 'loop').length;
      return el('div', { class: `fx-sends-row ${s.on ? '' : 'is-dim'}` }, [
        el('span', { class: 'fx-sends-k', text: String(i + 1) }),
        el('span', { class: 'truncate flex-1 min-w-0' }, [
          el('span', { class: 'fx-sends-dot', style: `background:${STUDIO_COLOR[s.from.studio] || '#64748b'}` }),
          el('b', { text: studioLabel(s.from.studio) }), ` ▸ ${lineName(s)} → `, el('b', { text: to }),
          loops ? el('span', { class: 'text-rose-300 text-[10px] ml-1', text: `⟲ ${loops}` }) : null,
        ]),
        el('span', { class: 'text-[10px] text-slate-400', text: t(`traj.mode.${s.mode}`) }),
        el('button', { class: IBTN, text: '▲', title: t('sends.up'), disabled: i === 0, on: { click: () => moveSendTo(s.id, i - 1) } }),
        el('button', { class: IBTN, text: '▼', title: t('sends.down'), disabled: i === sends.length - 1, on: { click: () => moveSendTo(s.id, i + 1) } }),
        el('button', { class: `${IBTN} hover:text-rose-300`, text: '×', title: s.to === MASTER ? t('sends.removeMaster') : t('sends.remove'), on: { click: () => removeSend(s.id) } }),
      ]);
    }),
  ]);
}

function render() {
  if (!win) return;
  const plan = buildSendPlan();
  const missing = missingSendEdges();
  const receivers = plan.order.filter((n) => (plan.inbound.get(n) || []).length);
  const key = JSON.stringify([plan.sends, [...missing], appState.lang, receivers]);
  if (win.key === key) return;
  win.key = key;
  const H = (text) => el('h3', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400', text });
  win.body.replaceChildren(
    el('p', { class: 'text-[11px] text-slate-400', text: t('sends.rules') }),
    H(t('sends.flow')),
    buildFlow(plan),
    ...(plan.sends.length ? [
      H(t('sends.receivers')),
      el('div', { class: 'fx-sends-grid' }, receivers.map((to) => receiverCard(plan, to, missing))),
      plan.sends.some((s) => s.to === MASTER) ? el('p', { class: 'text-[10px] text-slate-500', text: t('sends.masterNote') }) : null,
      H(t('sends.list')),
      sendListCard(plan),
    ] : []),
  );
}

function closeWindow() {
  win?.root.remove();
  win = null;
  syncButton();
}

/** Open the order tool. / 순서 도구 열기 */
export function openSendRouter() {
  if (win) { render(); return; }
  const body = el('div', { class: 'fx-sends-body flex flex-col gap-2 min-h-0 overflow-auto pr-1' });
  const dialog = el('div', { class: 'fx-traj-dialog fx-sends-dialog', role: 'dialog', 'aria-modal': 'true', dataset: { help: 'app.sends' } }, [
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('h2', { class: 'text-sm font-bold text-emerald-200', text: `⇄ ${t('sends.title')}` }),
      el('div', { class: 'flex items-center gap-2' }, [
        el('button', { class: 'fx-traj-btn primary', text: t('sends.new'), on: { click: () => openSendWindow({}) } }),
        el('button', { class: 'text-slate-400 hover:text-white text-lg leading-none', text: '×', title: t('sends.close'), on: { click: closeWindow } }),
      ]),
    ]),
    body,
  ]);
  const root = el('div', { class: 'fx-traj-root fx-sends-root', on: { pointerdown: (e) => { if (e.target === root) closeWindow(); } } }, [dialog]);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeWindow(); }
  });
  document.body.append(root);
  win = { root, body, key: '' };
  render();
  syncButton();
}

// ==========================================================================
// Header button / 헤더 버튼
// ==========================================================================

let button = null;

function syncButton() {
  if (!button) return;
  const n = buildSendPlan().sends.length;
  button.querySelector('.fx-sends-count').textContent = n ? String(n) : '';
  button.setAttribute('aria-pressed', win ? 'true' : 'false');
  button.querySelector('.fx-sends-txt').textContent = t('sends.btn');
  button.title = t('sends.btnTitle');
}

export function initSendRouter(h = {}) {
  hooks = { ...hooks, ...h };
  const anchor = document.getElementById('btnManager');
  if (anchor && !document.getElementById('btnSends')) {
    button = el('button', {
      id: 'btnSends',
      class: 'fx-sends-btn',
      dataset: { help: 'app.sends' },
      on: { click: () => (win ? closeWindow() : openSendRouter()) },
    }, [el('span', { text: '⇄' }), el('span', { class: 'fx-sends-txt', text: t('sends.btn') }), el('span', { class: 'fx-sends-count' })]);
    anchor.before(button);
  }
  onSendsChanged(() => { render(); syncButton(); });
  subscribe((e) => { if (e.scope.has('lang') || e.scope.has('all')) { render(); syncButton(); } });
  syncButton();
}

export { SEND_STUDIO_ORDER };
