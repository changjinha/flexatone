/**
 * Flexatone — ui/midi-learn.js
 * Layer 4 (ui): **Web MIDI input + Learn**. Connect a controller, press Learn, click any control of the app
 * (slider, number box, checkbox, select, button — in a studio, the Manager or the header), then move a knob or
 * press a key: that control now follows the controller.
 *   CC / pitch bend → value across the control's range (lo … hi of the mapping, optionally inverted)
 *   note on        → buttons are clicked, checkboxes toggled, sliders set by velocity
 * Controls are found again by id, or by their help key (`data-help`) + position, so studios that rebuild their
 * panels keep working; a mapping made in a studio acts only while that studio is on screen.
 * Mappings are a setting of this browser (localStorage), like a DAW's controller map — not part of the project.
 * 계층 4 (ui): Web MIDI 입력 + Learn. 컨트롤 클릭 → 노브/건반 → 매핑. 매핑은 이 브라우저의 설정(localStorage).
 */

import { t, I18N } from '../core/i18n.js';
import { StudioRegistry } from '../studios/registry.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';
import { setMidiActivity, rerenderMidiWindow, openMidiWindow, midiWindowRoot } from './midi-window.js';

Object.assign(I18N.en, {
  'mlearn.connect': 'Connect MIDI input',
  'mlearn.unsupported': 'This browser has no Web MIDI (use Chrome or Edge).',
  'mlearn.denied': (m) => `MIDI access was refused: ${m}`,
  'mlearn.input': 'Input',
  'mlearn.all': 'All inputs',
  'mlearn.none': 'No MIDI inputs found — plug a controller in.',
  'mlearn.learn': '🎯 Learn',
  'mlearn.learnHint': 'Learn: click a control, then move a knob / fader or press a key. Repeat for more. Esc or Done to finish.',
  'mlearn.done': 'Done',
  'mlearn.picked': (n) => `Selected: ${n} — now move a control on the device`,
  'mlearn.mapped': (n, m) => `${n} ← ${m}`,
  'mlearn.last': 'Last message',
  'mlearn.maps': 'Mappings',
  'mlearn.empty': 'No mappings yet.',
  'mlearn.lo': 'lo',
  'mlearn.hi': 'hi',
  'mlearn.inv': 'invert',
  'mlearn.remove': 'Remove',
  'mlearn.clear': 'Clear all',
  'mlearn.here': 'active here',
  'mlearn.away': (s) => `acts in ${s}`,
  'mlearn.missing': 'control not on screen',
  'mlearn.note': 'Mappings are saved in this browser (not in the project).',
});
Object.assign(I18N.ko, {
  'mlearn.connect': 'MIDI 입력 연결',
  'mlearn.unsupported': '이 브라우저에는 Web MIDI가 없습니다 (Chrome이나 Edge를 쓰세요).',
  'mlearn.denied': (m) => `MIDI 접근이 거부됨: ${m}`,
  'mlearn.input': '입력',
  'mlearn.all': '모든 입력',
  'mlearn.none': 'MIDI 입력이 없습니다 — 컨트롤러를 연결하세요.',
  'mlearn.learn': '🎯 Learn',
  'mlearn.learnHint': 'Learn: 컨트롤을 클릭한 뒤 장치의 노브·페이더를 움직이거나 건반을 누르세요. 여러 개 반복 가능. Esc 또는 완료로 끝.',
  'mlearn.done': '완료',
  'mlearn.picked': (n) => `선택됨: ${n} — 이제 장치의 컨트롤을 움직이세요`,
  'mlearn.mapped': (n, m) => `${n} ← ${m}`,
  'mlearn.last': '마지막 메시지',
  'mlearn.maps': '매핑',
  'mlearn.empty': '아직 매핑이 없습니다.',
  'mlearn.lo': '최소',
  'mlearn.hi': '최대',
  'mlearn.inv': '반전',
  'mlearn.remove': '삭제',
  'mlearn.clear': '모두 삭제',
  'mlearn.here': '여기서 동작',
  'mlearn.away': (s) => `${s}에서 동작`,
  'mlearn.missing': '화면에 컨트롤이 없음',
  'mlearn.note': '매핑은 이 브라우저에 저장됩니다 (프로젝트에는 저장되지 않음).',
});
HELP_DB['app.midiLearn'] = {
  en: { title: 'MIDI Learn', summary: 'Map a knob, fader or key of a MIDI controller to any control of the app.', detail: 'Connect, press Learn, click a control, move the device. CC and pitch bend sweep the control between lo and hi; a note clicks a button, toggles a checkbox or sets a slider by velocity. A mapping made inside a studio only acts while that studio is shown; header and Manager controls act everywhere.', formula: 'value = min + (lo + (hi − lo) · v) · (max − min),  v = CC / 127' },
  ko: { title: 'MIDI Learn', summary: 'MIDI 컨트롤러의 노브·페이더·건반을 앱의 아무 컨트롤에 연결합니다.', detail: '연결 → Learn → 컨트롤 클릭 → 장치를 움직임. CC와 피치벤드는 최소~최대 사이를 움직이고, 노트는 버튼을 누르고 체크박스를 토글하고 슬라이더를 벨로시티로 맞춥니다. 스튜디오 안에서 만든 매핑은 그 스튜디오가 화면에 있을 때만, 헤더와 매니저의 컨트롤은 어디서나 동작합니다.', formula: '값 = min + (lo + (hi − lo) · v) · (max − min),  v = CC / 127' },
};

const STORE = 'flexatone.midi.maps.v1';
const CONTROL_SEL = 'input[type=range], input[type=number], input[type=checkbox], select, button';

let access = null;
let inputId = 'all';
let maps = loadMaps();
let learn = null; // { target: { key, label } | null, banner }
let last = null; // { text, at }
let status = '';
let hooks = { showToast: () => {}, rerender: () => {} };

function loadMaps() {
  try { const v = JSON.parse(localStorage.getItem(STORE) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveMaps() {
  try { localStorage.setItem(STORE, JSON.stringify(maps)); } catch { /* storage blocked */ }
}

// --------------------------------------------------------------------------
// Finding controls / 컨트롤 찾기
// --------------------------------------------------------------------------

const kindOf = (node) => (node.tagName === 'INPUT' ? `input:${node.type}` : node.tagName.toLowerCase());
const inStudioArea = (node) => !node.closest('header, #transportBar, #viewPrefsBar, .mgr-panel, [class*="mgr-"]');

/** Human label of a control: its help title, aria / title, or nearby text. / 컨트롤 이름 */
function labelOf(node) {
  const help = node.closest('[data-help]')?.dataset.help;
  const lang = document.documentElement.lang?.startsWith('ko') ? 'ko' : 'en';
  const h = help && HELP_DB[help]?.[lang]?.title;
  const own = node.getAttribute('aria-label') || node.title || (node.tagName === 'BUTTON' ? node.textContent.trim() : '');
  const near = node.closest('label, .fx-row, div')?.textContent?.trim().slice(0, 32);
  return (h && own && h !== own ? `${h} · ${own}` : h || own || near || kindOf(node)).replace(/\s+/g, ' ').slice(0, 60);
}

/** Stable key of a control (survives a rebuilt panel). / 다시 그려져도 유지되는 키 */
function keyOf(node) {
  const kind = kindOf(node);
  const scope = inStudioArea(node) ? StudioRegistry.resolveStudioId() : '*';
  if (node.id) return { scope, id: node.id, kind };
  const host = node.closest('[data-help]');
  const help = host?.dataset.help || null;
  const hosts = help ? [...document.querySelectorAll(`[data-help="${CSS.escape(help)}"]`)] : [document.body];
  const root = host || document.body;
  const same = [...root.querySelectorAll(CONTROL_SEL)].filter((x) => kindOf(x) === kind);
  return { scope, help, hIdx: Math.max(0, hosts.indexOf(host)), cIdx: Math.max(0, same.indexOf(node)), kind };
}

function resolve(key) {
  if (key.scope !== '*' && key.scope !== StudioRegistry.resolveStudioId()) return null;
  if (key.id) { const n = document.getElementById(key.id); return n && kindOf(n) === key.kind ? n : null; }
  const hosts = key.help ? [...document.querySelectorAll(`[data-help="${CSS.escape(key.help)}"]`)] : [document.body];
  const host = hosts[key.hIdx];
  if (!host) return null;
  const same = [host, ...host.querySelectorAll(CONTROL_SEL)].filter((x) => x.matches?.(CONTROL_SEL) && kindOf(x) === key.kind);
  // the host itself can be the control / 호스트 자체가 컨트롤일 수 있음
  const list = host.matches(CONTROL_SEL) ? same : same.filter((x) => x !== host);
  const n = list[key.cIdx];
  return n && n.offsetParent !== null ? n : null;
}

// --------------------------------------------------------------------------
// Messages / 메시지
// --------------------------------------------------------------------------

function describe(msg) {
  const ch = msg.ch + 1;
  if (msg.type === 'cc') return `CC ${msg.num} · ch ${ch}`;
  if (msg.type === 'note') return `Note ${msg.num} · ch ${ch}`;
  return `Pitch bend · ch ${ch}`;
}

/** Bytes → { type, ch, num, v (0…1), on } or null. / 바이트 해석 */
function parse(data) {
  const st = data[0] & 0xf0;
  const ch = data[0] & 0x0f;
  if (st === 0xb0) return { type: 'cc', ch, num: data[1], v: data[2] / 127, on: data[2] >= 64 };
  if (st === 0x90 && data[2] > 0) return { type: 'note', ch, num: data[1], v: data[2] / 127, on: true };
  if (st === 0x80 || (st === 0x90 && data[2] === 0)) return { type: 'note', ch, num: data[1], v: 0, on: false, off: true };
  if (st === 0xe0) return { type: 'bend', ch, num: 0, v: ((data[2] << 7) | data[1]) / 16383, on: true };
  return null;
}

const sameMsg = (m, x) => m.type === x.type && m.ch === x.ch && (m.type === 'bend' || m.num === x.num);
const changeTimers = new WeakMap();

function fire(node, type) {
  node.dispatchEvent(new Event(type, { bubbles: true }));
}

/** Apply one message to a mapped control. / 매핑된 컨트롤에 적용 */
function apply(map, node, msg) {
  let v = msg.v;
  if (map.inv) v = 1 - v;
  v = map.lo + (map.hi - map.lo) * v;
  const kind = kindOf(node);
  if (kind === 'button') { if (msg.on && !msg.off && (msg.type === 'note' || !map.wasOn)) node.click(); map.wasOn = msg.on; return; }
  if (kind === 'input:checkbox') {
    if (msg.type === 'note') { if (msg.on && !msg.off) node.click(); return; }
    if (msg.on !== node.checked) node.click();
    return;
  }
  if (msg.off) return; // note-off does not move a value / 노트오프는 값을 바꾸지 않음
  if (kind === 'select') {
    const opts = [...node.options].filter((o) => !o.disabled);
    const o = opts[Math.round(v * (opts.length - 1))];
    if (o && node.value !== o.value) { node.value = o.value; fire(node, 'change'); }
    return;
  }
  // range / number: min … max of the control (a number box without bounds uses the bounds seen when learned)
  // 범위: 컨트롤의 min … max (경계가 없는 숫자 칸은 Learn 때의 경계)
  const min = node.min !== '' ? Number(node.min) : map.min ?? 0;
  const max = node.max !== '' ? Number(node.max) : map.max ?? 1;
  const step = node.step && node.step !== 'any' ? Number(node.step) : 0;
  let x = min + v * (max - min);
  if (step > 0) x = min + Math.round((x - min) / step) * step;
  const s = String(+x.toFixed(6));
  if (node.value === s) return;
  node.value = s;
  fire(node, 'input');
  clearTimeout(changeTimers.get(node));
  changeTimers.set(node, setTimeout(() => fire(node, 'change'), 160));
}

/** Handle raw MIDI bytes (also used by tests). / MIDI 바이트 처리 (테스트에도 사용) */
export function handleMidiMessage(data) {
  const msg = parse(data);
  if (!msg) return;
  last = { text: `${describe(msg)} = ${msg.type === 'bend' ? Math.round(msg.v * 16383) : Math.round(msg.v * 127)}`, at: performance.now() };
  setMidiActivity(true, true);
  if (learn?.target && !msg.off) {
    const tg = learn.target;
    maps = maps.filter((m) => !(m.key.id ? m.key.id === tg.key.id && m.key.scope === tg.key.scope : JSON.stringify(m.key) === JSON.stringify(tg.key)));
    maps.push({ key: tg.key, label: tg.label, msg: { type: msg.type, ch: msg.ch, num: msg.num }, lo: 0, hi: 1, inv: false, min: tg.min, max: tg.max });
    saveMaps();
    setBanner(t('mlearn.mapped', tg.label, describe(msg)));
    tg.node?.classList.remove('fx-mlearn-pick');
    learn.target = null;
    return;
  }
  for (const m of maps) {
    if (!sameMsg(m.msg, msg)) continue;
    const node = resolve(m.key);
    if (node) { try { apply(m, node, msg); } catch (err) { console.error('[Flexatone] MIDI apply failed:', err); } }
  }
  if (document.querySelector('.fx-mlearn-last')) document.querySelector('.fx-mlearn-last').textContent = last.text;
}

function onInputMessage(e) {
  if (inputId !== 'all' && e.target?.id !== inputId) return;
  handleMidiMessage(e.data);
}

function bindInputs() {
  if (!access) return;
  for (const inp of access.inputs.values()) inp.onmidimessage = onInputMessage;
  setMidiActivity(access.inputs.size > 0);
}

async function connect() {
  if (!navigator.requestMIDIAccess) { status = t('mlearn.unsupported'); hooks.rerender(); return; }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => { bindInputs(); rerenderMidiWindow(); };
    bindInputs();
    status = '';
  } catch (err) {
    status = t('mlearn.denied', err.message || String(err));
  }
  hooks.rerender();
}

// --------------------------------------------------------------------------
// Learn mode / Learn 모드
// --------------------------------------------------------------------------

function setBanner(text) {
  const b = learn?.banner?.querySelector('.fx-mlearn-msg');
  if (b) b.textContent = text;
}

function onPick(e) {
  if (!learn) return;
  if (learn.banner.contains(e.target)) return;
  const node = e.target.closest?.(CONTROL_SEL);
  e.preventDefault();
  e.stopPropagation();
  if (!node) return;
  learn.target?.node?.classList.remove('fx-mlearn-pick');
  const key = keyOf(node);
  const label = labelOf(node);
  const cur = Number(node.value);
  const min = node.min !== '' ? Number(node.min) : Number.isFinite(cur) ? Math.min(0, cur) : 0;
  const max = node.max !== '' ? Number(node.max) : Number.isFinite(cur) ? Math.max(1, cur * 2 || 1) : 1;
  learn.target = { key, label, node, min, max };
  node.classList.add('fx-mlearn-pick');
  setBanner(t('mlearn.picked', label));
}

const swallow = (e) => { if (learn && !learn.banner.contains(e.target)) { e.preventDefault(); e.stopPropagation(); } };
const onKey = (e) => { if (learn && e.key === 'Escape') { e.preventDefault(); stopLearn(); } };

export function startLearn() {
  if (learn) return;
  midiWindowRoot()?.remove(); // the window steps aside while picking / 고르는 동안 창은 비킴
  const banner = el('div', { class: 'fx-mlearn-banner' }, [
    el('span', { class: 'fx-mlearn-msg', text: t('mlearn.learnHint') }),
    el('button', { class: 'fx-traj-btn primary', text: t('mlearn.done'), on: { click: () => stopLearn() } }),
  ]);
  document.body.append(banner);
  learn = { target: null, banner };
  document.addEventListener('pointerdown', onPick, true);
  document.addEventListener('click', swallow, true);
  document.addEventListener('input', swallow, true);
  document.addEventListener('change', swallow, true);
  document.addEventListener('keydown', onKey, true);
  document.body.classList.add('fx-mlearn-on');
}

export function stopLearn() {
  if (!learn) return;
  learn.target?.node?.classList.remove('fx-mlearn-pick');
  learn.banner.remove();
  learn = null;
  document.removeEventListener('pointerdown', onPick, true);
  document.removeEventListener('click', swallow, true);
  document.removeEventListener('input', swallow, true);
  document.removeEventListener('change', swallow, true);
  document.removeEventListener('keydown', onKey, true);
  document.body.classList.remove('fx-mlearn-on');
  openMidiWindow('device');
}

/** Learn without a device (tests / scripts): pick `node` as the next target. / 장치 없이 대상 지정 */
export function learnTarget(node) {
  if (!learn) startLearn();
  onPick({ target: node, preventDefault() {}, stopPropagation() {} });
}

export const listMidiMaps = () => maps.map((m) => ({ ...m }));
export function clearMidiMaps() { maps = []; saveMaps(); }

// --------------------------------------------------------------------------
// Device pane / 장치 탭
// --------------------------------------------------------------------------

export function mountDevicePane(h = {}) {
  hooks = { ...hooks, ...h };
  const studio = StudioRegistry.resolveStudioId();
  const inputs = access ? [...access.inputs.values()] : [];
  const head = el('section', { class: 'fx-midi-card', dataset: { help: 'app.midiLearn' } }, [
    el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
      access ? null : el('button', { class: 'fx-traj-btn primary', text: t('mlearn.connect'), on: { click: connect } }),
      access ? el('span', { class: 'fx-midi-lbl', text: t('mlearn.input') }) : null,
      access ? el('select', { class: 'fx-midi-select', on: { change: (e) => { inputId = e.target.value; } } }, [
        el('option', { value: 'all', selected: inputId === 'all', text: t('mlearn.all') }),
        ...inputs.map((i) => el('option', { value: i.id, selected: inputId === i.id, text: i.name || i.id })),
      ]) : null,
      el('button', { class: 'fx-traj-btn', text: t('mlearn.learn'), on: { click: startLearn } }),
    ]),
    status ? el('p', { class: 'fx-midi-note text-rose-300', text: status }) : null,
    access && !inputs.length ? el('p', { class: 'fx-midi-note', text: t('mlearn.none') }) : null,
    el('p', { class: 'fx-midi-info' }, [`${t('mlearn.last')}: `, el('span', { class: 'fx-mlearn-last font-mono', text: last?.text || '—' })]),
  ]);
  const list = el('section', { class: 'fx-midi-card' }, [
    el('div', { class: 'flex items-center justify-between' }, [
      el('h3', { text: t('mlearn.maps') }),
      maps.length ? el('button', { class: 'fx-traj-btn', text: t('mlearn.clear'), on: { click: () => { clearMidiMaps(); hooks.rerender(); } } }) : null,
    ]),
    maps.length ? null : el('p', { class: 'fx-midi-note', text: t('mlearn.empty') }),
    ...maps.map((m, i) => {
      const here = m.key.scope === '*' || m.key.scope === studio;
      const found = here && !!resolve(m.key);
      const num = (k, val) => el('input', {
        type: 'number', min: '0', max: '1', step: '0.05', value: String(val), class: 'fx-midi-num w-12',
        title: t(`mlearn.${k}`),
        on: { change: (e) => { m[k] = Math.max(0, Math.min(1, Number(e.target.value) || 0)); saveMaps(); }, keydown: (e) => e.stopPropagation() },
      });
      return el('div', { class: 'fx-mlearn-map' }, [
        el('span', { class: 'fx-mlearn-msgtag', text: describe(m.msg) }),
        el('span', { class: 'flex-1 truncate', text: m.label, title: m.label }),
        el('span', { class: `text-[10px] ${found ? 'text-emerald-300' : 'text-slate-500'}`, text: !here ? t('mlearn.away', m.key.scope) : found ? t('mlearn.here') : t('mlearn.missing') }),
        num('lo', m.lo), num('hi', m.hi),
        el('label', { class: 'fx-stempo-check text-[10px]' }, [el('input', { type: 'checkbox', checked: m.inv, on: { change: (e) => { m.inv = e.target.checked; saveMaps(); } } }), el('span', { text: t('mlearn.inv') })]),
        el('button', { class: 'text-slate-400 hover:text-rose-300', text: '×', title: t('mlearn.remove'), on: { click: () => { maps.splice(i, 1); saveMaps(); hooks.rerender(); } } }),
      ]);
    }),
    el('p', { class: 'fx-midi-note', text: t('mlearn.note') }),
  ]);
  return el('div', { class: 'flex flex-col gap-2' }, [head, list]);
}
