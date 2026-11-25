/**
 * Flexatone — ui/automation.js
 * Layer 4 (ui): timeline automation in the shared Timeline monitor (every studio that uses it).
 *   ◆ Automation (header button, needs a selected module = a lane of the Timeline)
 *     → the toolboxes applied to that module (the switched-on toolboxes of the signal flow)
 *     → the parameters (sliders) of the chosen toolbox
 *     → a parameter opens an envelope lane under the module in the Timeline.
 *   Lane gestures: double-click = add a node · click on the line = curve that segment (its ◇ handle then sets
 *   the curvature) · two-finger click (context click) = remove a node (on a ◇: straighten the segment) ·
 *   drag a node = time + value · drag a ◇ = curvature. The selected node's time / value (and the segment's
 *   curvature) are shown under the Timeline, follow the drag live and can be typed or stepped with ▲ / ▼.
 *   Playback: while the transport plays, every lane that is on writes its value at the playhead into its
 *   slider's place in the document (control rate, ~3 per second, no undo steps), the way a DAW reads automation.
 *   In Glissando the write goes to the lane's own voice. It is heard wherever an edit while playing is heard
 *   (studios on the shared live transport, any studio at tempo ≠ 1); Glissando's own player reads its voices at Play. Model and maths: core/automation.js.
 * 계층 4 (ui): 공용 타임라인 모니터의 오토메이션. ◆ 오토메이션 → 모듈에 적용된 툴박스 → 파라미터 →
 * 타임라인의 모듈 아래 엔벨로프 레인. 더블클릭 = 노드 추가, 선 클릭 = 곡선화(◇ 핸들로 곡률), 두 손가락 클릭 =
 * 노드 제거(◇에서는 직선으로). 선택한 노드의 시간·값은 타임라인 아래에서 실시간으로 보이고 입력·▲▼로 조정.
 * 재생 중에는 켜진 레인이 재생 헤드의 값을 슬라이더에 씁니다 (제어율, 실행 취소 기록 없음).
 */

import { appState, dispatch, endHistoryGesture, withoutHistory, updateVoices } from '../core/state.js';
import { StudioRegistry } from '../studios/registry.js';
import { t, I18N } from '../core/i18n.js';
import { clamp, roundTo, uid } from '../core/math-utils.js';
import { AUTOMATION_KEY, normalizeLane, valueAt, segmentAt, snap, shape, handleOf, curvatureOf, MAX_NODES, diffLeaves, setPath } from '../core/automation.js';
import { getToolChain } from './rack-layout.js';
import { HELP_DB } from './option-inspector.js';

Object.assign(I18N.en, {
  'au.btn': '◆ Automation',
  'au.btnTip': 'Automate a toolbox parameter of the selected module along the timeline',
  'au.needMod': 'Select a module first (click its lane in the Timeline or its card in the Module List)',
  'au.mod': (name) => `Module: ${name}`,
  'au.tools': 'Toolboxes applied',
  'au.noTools': 'No toolbox is switched on — switch one on in the module tray.',
  'au.params': 'Parameters',
  'au.noParams': 'This toolbox has no continuous parameter (slider).',
  'au.lanes': 'Lanes',
  'au.noLanes': 'No automation on this module yet — pick a parameter above.',
  'au.show': 'Show / hide the lane under the module',
  'au.on': 'Read: on = the lane drives the parameter while playing',
  'au.del': 'Delete this lane (undo brings it back)',
  'au.node': (i, n) => `Node ${i} / ${n}`,
  'au.time': 'time (s)',
  'au.value': 'value',
  'au.curve': 'curve',
  'au.seg': (i) => `Segment ${i}`,
  'au.hint': 'Double-click: add node · click the line: curve it (drag ◇) · two-finger click: remove · drag: move',
  'au.empty': 'Double-click to add a node',
  'au.moved': (name) => `This studio-wide parameter was automated under “${name}” — its lane moved here.`,
  'au.missing': 'parameter not found (toolbox off or changed)',
});
Object.assign(I18N.ko, {
  'au.btn': '◆ 오토메이션',
  'au.btnTip': '선택한 모듈의 툴박스 파라미터를 타임라인을 따라 자동으로 움직입니다',
  'au.needMod': '먼저 모듈을 선택하세요 (타임라인의 줄 또는 모듈 리스트의 카드를 클릭)',
  'au.mod': (name) => `모듈: ${name}`,
  'au.tools': '적용된 툴박스',
  'au.noTools': '켜진 툴박스가 없습니다 — 모듈 트레이에서 켜세요.',
  'au.params': '파라미터',
  'au.noParams': '이 툴박스에는 연속 파라미터(슬라이더)가 없습니다.',
  'au.lanes': '레인',
  'au.noLanes': '이 모듈에는 아직 오토메이션이 없습니다 — 위에서 파라미터를 고르세요.',
  'au.show': '모듈 아래 레인 보이기 / 숨기기',
  'au.on': '읽기: 켜짐 = 재생 중 이 레인이 파라미터를 움직임',
  'au.del': '이 레인 삭제 (실행 취소로 복구)',
  'au.node': (i, n) => `노드 ${i} / ${n}`,
  'au.time': '시간 (초)',
  'au.value': '값',
  'au.curve': '곡률',
  'au.seg': (i) => `구간 ${i}`,
  'au.hint': '더블클릭: 노드 추가 · 선 클릭: 곡선화 (◇ 드래그) · 두 손가락 클릭: 제거 · 드래그: 이동',
  'au.empty': '더블클릭으로 노드 추가',
  'au.moved': (name) => `스튜디오 전체 파라미터라 “${name}” 아래에 있던 레인을 이 모듈로 옮겼습니다.`,
  'au.missing': '파라미터를 찾을 수 없음 (툴박스가 꺼졌거나 바뀜)',
});
HELP_DB['app.automation'] = {
  en: { title: 'Automation', summary: 'Move a toolbox parameter along the timeline: select a module, press ◆ Automation, pick one of the toolboxes applied to it, then a parameter — an envelope lane opens under the module in the Timeline.', detail: 'Double-click the lane to add a node, click the line to curve that segment (drag its ◇ handle to set how much), two-finger click (right click) a node to remove it (on a ◇: straight again), drag a node to move it in time and value. The selected node\'s time and value are shown under the Timeline while you drag; type them or use ▲ / ▼ (Shift = ×10). While playing, every lane that is on (●) writes its value at the playhead into the parameter about three times a second, without undo steps — like reading automation in a DAW. It is heard wherever an edit made while playing is heard (Draw, Field, Fractal, Grid, Tempo, and any studio played at a tempo other than 1); Glissando\'s normal player reads its voices when Play starts. In Glissando each lane drives its own voice; in the other studios most toolboxes are studio-wide, so one lane per parameter. Saved with the project.', formula: 'v = v₀ + (v₁ − v₀)·(e^{c·u} − 1)/(e^{c} − 1)' },
  ko: { title: '오토메이션', summary: '툴박스 파라미터를 타임라인을 따라 움직입니다: 모듈을 선택하고 ◆ 오토메이션을 누른 뒤, 그 모듈에 적용된 툴박스와 파라미터를 고르면 타임라인의 모듈 아래에 엔벨로프 레인이 열립니다.', detail: '레인을 더블클릭하면 노드 추가, 선을 클릭하면 그 구간이 곡선이 되고(◇ 핸들을 끌어 곡률 조절), 노드를 두 손가락 클릭(오른쪽 클릭)하면 제거(◇에서는 다시 직선), 노드를 끌면 시간·값 이동. 선택한 노드의 시간과 값은 드래그하는 동안 타임라인 아래에 실시간으로 표시되며, 직접 입력하거나 ▲ / ▼로 조정합니다(Shift = ×10). 재생 중에는 켜진(●) 레인이 재생 헤드 위치의 값을 초당 약 3번 파라미터에 씁니다(실행 취소 기록 없음) — DAW의 오토메이션 읽기와 같습니다. 재생 중 편집이 들리는 곳에서 들립니다(드로우·필드·프랙탈·그리드·템포, 그리고 템포 1이 아닌 모든 스튜디오). 글리산도의 기본 플레이어는 재생을 시작할 때 보이스를 읽습니다. 글리산도에서는 레인마다 자기 보이스를 움직이고, 다른 스튜디오는 대부분 스튜디오 전체 툴박스라 파라미터마다 레인 하나입니다. 프로젝트에 저장됩니다.', formula: 'v = v₀ + (v₁ − v₀)·(e^{c·u} − 1)/(e^{c} − 1)' },
};

const CHIP = 'px-2 py-0.5 rounded-md text-[10.5px] border transition';
const CHIP_OFF = `${CHIP} bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800`;
const CHIP_ON = `${CHIP} bg-violet-600/30 border-violet-400/60 text-violet-100`;
const NUM = 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-violet-200';
const STEP_BTN = 'px-1 leading-none rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[9px] text-slate-200';
const HIT = 7; // px / 노드·핸들 클릭 반경

const ui = { open: false, tool: null, lane: null, node: -1, seg: -1 };
let hooks = { redraw: () => {}, toast: () => {}, pos: null };
let els = null;

const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// ==========================================================================
// Data / 데이터
// ==========================================================================

const normCache = new WeakMap();
/** Lanes of a studio (normalized, cached per stored array). / 스튜디오의 레인 */
export function lanesOf(studio) {
  const raw = appState.studioParams?.[AUTOMATION_KEY]?.[studio]?.lanes;
  if (!Array.isArray(raw)) return [];
  let hit = normCache.get(raw);
  if (!hit) { hit = raw.map(normalizeLane).filter(Boolean); normCache.set(raw, hit); }
  return hit;
}

/** Edit the lanes of a studio. history: an undo step; silent: no app render (live drag). / 레인 편집 */
function editLanes(studio, fn, { history = true, silent = false, coalesceKey = null } = {}) {
  dispatch({
    type: 'automation/set',
    history,
    coalesceKey,
    silent,
    scope: ['automation'],
    mutate: (st) => {
      const all = { ...(st.studioParams?.[AUTOMATION_KEY] || {}) };
      const lanes = lanesOf(studio).map((l) => ({ ...l, nodes: l.nodes.map((n) => ({ ...n })) }));
      fn(lanes);
      all[studio] = { lanes };
      st.studioParams = { ...(st.studioParams || {}), [AUTOMATION_KEY]: all };
    },
  });
  if (silent) hooks.redraw();
}

const laneById = (studio, id) => lanesOf(studio).find((l) => l.id === id) || null;

/** Lanes shown under a module in the Timeline. / 모듈 아래에 보이는 레인 */
export function shownLanes(studio, mod) {
  return lanesOf(studio).filter((l) => l.mod === mod && l.show);
}

// ==========================================================================
// Toolboxes and their parameters (read from the toolbox's sliders) / 툴박스와 파라미터
// ==========================================================================

/** The caption of a slider: the nearest text label before it (a bare number is a value, not a label). / 슬라이더 이름 */
function captionOf(range) {
  let p = range.parentElement;
  for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
    const before = [...p.querySelectorAll('span, label')].filter((s) => !s.contains(range) && !s.querySelector('input, select, button')
      && (s.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING));
    for (const s of before.reverse()) {
      const txt = s.textContent.replace(/\s+/g, ' ').trim();
      if (txt && !/^[-+]?[\d.,]+\s*\S{0,3}$/.test(txt)) return txt.length > 32 ? `${txt.slice(0, 31)}…` : txt;
    }
  }
  return '';
}

/** Sliders of a toolbox: [{ pid, label, min, max, step, range }]. / 툴박스의 슬라이더 */
export function paramsOf(node) {
  if (!node) return [];
  const out = [];
  [...node.querySelectorAll('input[type="range"]')].forEach((r, i) => {
    const hidden = r.closest('.hidden');
    if (hidden && hidden !== node && node.contains(hidden)) return;
    const min = Number(r.min || 0);
    const max = Number(r.max || 100);
    if (!(max > min)) return;
    const label = captionOf(r) || `#${i + 1}`;
    out.push({ pid: `${i}|${label}`, label, min, max, step: Number(r.step) > 0 ? Number(r.step) : 0, range: r });
  });
  return out;
}

/** The switched-on toolboxes of the studio on screen (what a module's signal runs through). / 적용된 툴박스 */
function appliedTools(studio) {
  const ch = getToolChain();
  if (!ch || ch.studio !== studio) return [];
  return ch.steps.filter((s) => s.node?.isConnected);
}

function toolNode(studio, key) {
  const step = appliedTools(studio).find((s) => s.key === key);
  if (step) return step.node;
  return [...document.querySelectorAll(`[data-rack="${CSS.escape(key)}"]`)].find((n) => !n.closest('.fx-ws-hidden')) || null;
}

/** The slider a lane drives (exact id, else the same label, else the same place). / 레인이 움직이는 슬라이더 */
function findParam(studio, lane) {
  const list = paramsOf(toolNode(studio, lane.tool));
  const [idx] = lane.pid.split('|');
  return list.find((p) => p.pid === lane.pid) || list.find((p) => p.label === lane.label) || list[Number(idx)] || null;
}

function currentValue(studio, lane) {
  const p = findParam(studio, lane);
  return p ? Number(p.range.value) : null;
}

// ==========================================================================
// Writing a value into the parameter / 파라미터에 값 쓰기
// ==========================================================================

/** The document a lane's value lives in: its voice (Glissando) or the studio document. / 레인 값이 있는 문서 */
function docOf(studio, mod) {
  // a studio document is only stored once edited: read it through the registry (defaults merged)
  // 스튜디오 문서는 편집해야 저장됨: 레지스트리로 읽음 (기본값 포함)
  return studio === 'glissando' ? appState.voices.find((v) => v.id === mod) || null : StudioRegistry.getParams(studio);
}

function nudgeSlider(range, value) {
  range.value = String(value);
  range.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Find where a slider writes: move it one step, see which number of the document changed, put it back.
 * Only a slider that writes its own value into exactly one place gets a path (otherwise the slider is driven).
 * 슬라이더가 쓰는 위치 찾기: 한 칸 움직여 문서에서 바뀐 숫자를 보고 되돌림. 값을 그대로 한 곳에 쓰는 경우만 경로.
 */
function probePath(studio, mod, p) {
  const before = JSON.parse(JSON.stringify(docOf(studio, mod)));
  if (!before) return null;
  const old = Number(p.range.value);
  const d = p.step > 0 ? p.step : (p.max - p.min) / 100;
  let path = null;
  withoutHistory(() => {
    nudgeSlider(p.range, old + d <= p.max ? old + d : old - d);
    const probe = Number(p.range.value);
    const diffs = diffLeaves(before, docOf(studio, mod));
    if (diffs.length === 1 && typeof diffs[0].val === 'number' && Math.abs(diffs[0].val - probe) <= Math.max(1e-9, Math.abs(probe) * 1e-6)) path = diffs[0].path;
    nudgeSlider(p.range, old);
  });
  endHistoryGesture();
  return path;
}

function writeParam(studio, lane, value) {
  if (lane.path) {
    let ok = false;
    withoutHistory(() => {
      if (studio === 'glissando') {
        if (!appState.voices.some((v) => v.id === lane.mod)) return;
        updateVoices((v) => { ok = setPath(v, lane.path, value); }, { ids: [lane.mod], history: false, type: 'automation/write' });
      } else {
        const next = StudioRegistry.getParams(studio);
        if (!setPath(next, lane.path, value)) return;
        StudioRegistry.setParams(studio, next, { history: false });
        ok = true;
      }
    });
    return ok;
  }
  // no path: drive the slider (in Glissando only while the lane's voice is the one the toolbox shows)
  // 경로 없음: 슬라이더를 움직임 (글리산도는 레인의 보이스가 툴박스에 보일 때만)
  if (studio === 'glissando' && appState.activeVoiceId !== lane.mod) return false;
  const p = findParam(studio, lane);
  if (!p) return false;
  withoutHistory(() => nudgeSlider(p.range, value));
  return true;
}

const applied = new Map(); // lane id → last written value / 마지막으로 쓴 값
let tickAt = 0;
let wasPlaying = false;

/** Called every frame: while playing, lanes that are on drive their parameter. / 재생 중 레인이 파라미터를 움직임 */
export function tickAutomation(studio) {
  const tr = appState.transport || {};
  if (!tr.playing) {
    if (wasPlaying) { applied.clear(); endHistoryGesture(); }
    wasPlaying = false;
    return;
  }
  const now = performance.now();
  // ~3 writes per second: slower than the edit-while-playing debounce (140 ms live transport, 220 ms tempo
  // player), so each step is re-scheduled and heard / 초당 약 3번: 재생 중 편집 대기보다 느려 단계마다 반영
  if (wasPlaying && now - tickAt < 300) return;
  wasPlaying = true;
  tickAt = now;
  const sec = Math.max(0, Number(tr.playheadSec) || 0);
  for (const lane of lanesOf(studio)) {
    if (!lane.on || !lane.nodes.length) continue;
    const v = snap(valueAt(lane.nodes, sec), lane);
    const last = applied.get(lane.id);
    if (last !== undefined && Math.abs(last - v) < Math.max(1e-9, (lane.max - lane.min) * 1e-4)) continue;
    if (writeParam(studio, lane, v)) applied.set(lane.id, v);
  }
}

// ==========================================================================
// Lane drawing / 레인 그리기
// ==========================================================================

/**
 * Draw one lane row. geo = { x0, x1, y0, h, X(t), T }.
 * 레인 한 줄 그리기
 */
export function drawLane(g, studio, lane, color, geo) {
  const { x0, x1, y0, h, X } = geo;
  const sel = ui.lane === lane.id;
  const Y = (v) => y0 + h - 4 - ((v - lane.min) / (lane.max - lane.min)) * (h - 8);
  g.save();
  g.fillStyle = sel ? 'rgba(76, 29, 149, .22)' : 'rgba(15, 23, 42, .85)';
  g.fillRect(0, y0, x1 + 8, h);
  g.strokeStyle = sel ? 'rgba(167, 139, 250, .6)' : '#1e293b';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y0 + 0.5); g.lineTo(x1 + 8, y0 + 0.5); g.stroke();
  // centre guide + labels / 가운데 선 + 라벨
  g.setLineDash([2, 4]);
  g.strokeStyle = '#334155';
  g.beginPath(); g.moveTo(x0, Y((lane.min + lane.max) / 2) + 0.5); g.lineTo(x1, Y((lane.min + lane.max) / 2) + 0.5); g.stroke();
  g.setLineDash([]);
  g.font = '9.5px ui-monospace, monospace';
  g.fillStyle = lane.on ? '#c4b5fd' : '#64748b';
  const missing = !lane.path && !findParam(studio, lane);
  g.fillText(`◆ ${lane.toolTitle} › ${lane.label}${lane.on ? '' : ' (off)'}${missing ? ` — ${t('au.missing')}` : ''}`, x0 + 3, y0 + 10);
  g.fillStyle = '#475569';
  const fmt = (v) => `${+roundTo(v, 3)}`;
  g.fillText(fmt(lane.max), x1 - g.measureText(fmt(lane.max)).width - 2, y0 + 10);
  g.fillText(fmt(lane.min), x1 - g.measureText(fmt(lane.min)).width - 2, y0 + h - 3);
  const nodes = lane.nodes;
  g.strokeStyle = color;
  g.lineWidth = sel ? 1.8 : 1.3;
  g.globalAlpha = lane.on ? 1 : 0.45;
  if (!nodes.length) {
    const cur = currentValue(studio, lane);
    if (cur != null) {
      g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(x0, Y(cur)); g.lineTo(x1, Y(cur)); g.stroke();
      g.setLineDash([]);
    }
    g.fillStyle = '#94a3b8';
    g.fillText(t('au.empty'), (x0 + x1) / 2 - 50, y0 + h / 2 + 3);
    g.restore();
    return;
  }
  g.beginPath();
  g.moveTo(x0, Y(nodes[0].v));
  g.lineTo(X(nodes[0].t), Y(nodes[0].v));
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const n = Math.abs(a.c) > 1e-4 ? Math.max(8, Math.min(48, Math.round((X(b.t) - X(a.t)) / 3))) : 1;
    for (let k = 1; k <= n; k++) {
      const u = k / n;
      g.lineTo(X(a.t + (b.t - a.t) * u), Y(a.v + (b.v - a.v) * shape(u, a.c)));
    }
  }
  g.lineTo(x1, Y(nodes[nodes.length - 1].v));
  g.stroke();
  // curve handles ◇ / 곡률 핸들
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (Math.abs(b.v - a.v) < 1e-12 || X(b.t) - X(a.t) < 14) continue;
    const curved = Math.abs(a.c) > 1e-4;
    const on = sel && ui.seg === i;
    if (!curved && !on && !sel) continue;
    const hx = X((a.t + b.t) / 2);
    const hy = Y(a.v + (b.v - a.v) * handleOf(a.c));
    g.globalAlpha = (curved || on ? 1 : 0.5) * (lane.on ? 1 : 0.45);
    g.fillStyle = on ? '#fde68a' : '#0f172a';
    g.strokeStyle = on ? '#f59e0b' : color;
    g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(hx, hy - 4.5); g.lineTo(hx + 4.5, hy); g.lineTo(hx, hy + 4.5); g.lineTo(hx - 4.5, hy); g.closePath();
    g.fill(); g.stroke();
  }
  // nodes / 노드
  g.globalAlpha = lane.on ? 1 : 0.45;
  nodes.forEach((n, i) => {
    const on = sel && ui.node === i;
    g.fillStyle = on ? '#ffffff' : color;
    g.strokeStyle = on ? '#a78bfa' : '#0f172a';
    g.lineWidth = on ? 2 : 1;
    g.beginPath(); g.arc(X(n.t), Y(n.v), on ? 4.5 : 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
  });
  // value now (while playing) / 재생 중 현재 값
  const tr = appState.transport || {};
  if (tr.playing && Number.isFinite(tr.playheadSec)) {
    const v = valueAt(nodes, tr.playheadSec);
    g.fillStyle = '#f43f5e';
    g.beginPath(); g.arc(X(Math.min(geo.T, tr.playheadSec)), Y(v), 2.5, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

// ==========================================================================
// Gestures on a lane / 레인 조작
// ==========================================================================

function geoFns(row) {
  const { lane, geo } = row;
  const Y = (v) => geo.y0 + geo.h - 4 - ((v - lane.min) / (lane.max - lane.min)) * (geo.h - 8);
  const V = (y) => lane.min + ((geo.y0 + geo.h - 4 - y) / Math.max(1, geo.h - 8)) * (lane.max - lane.min);
  const Tof = (x) => clamp(((x - geo.x0) / Math.max(1, geo.x1 - geo.x0)) * geo.T, 0, geo.T);
  return { Y, V, Tof, X: geo.X };
}

function hitNode(row, x, y) {
  const { Y, X } = geoFns(row);
  let best = -1;
  let bd = HIT;
  row.lane.nodes.forEach((n, i) => { const d = Math.hypot(X(n.t) - x, Y(n.v) - y); if (d <= bd) { bd = d; best = i; } });
  return best;
}

function hitHandle(row, x, y) {
  const { Y, X } = geoFns(row);
  const ns = row.lane.nodes;
  for (let i = 0; i < ns.length - 1; i++) {
    const a = ns[i];
    const b = ns[i + 1];
    if (Math.abs(b.v - a.v) < 1e-12 || X(b.t) - X(a.t) < 14) continue;
    if (Math.abs(a.c) < 1e-4 && !(ui.lane === row.lane.id)) continue;
    if (Math.hypot(X((a.t + b.t) / 2) - x, Y(a.v + (b.v - a.v) * handleOf(a.c)) - y) <= HIT) return i;
  }
  return -1;
}

function selectLane(lane, node = -1, seg = -1) {
  ui.lane = lane?.id || null;
  ui.node = node;
  ui.seg = seg;
  if (lane) ui.tool = lane.tool;
}

let click = null; // pending single click on the line (curving waits for a possible double-click) / 대기 중인 단일 클릭
let drag = null;

/** Pointer down on a lane row. Returns true when handled. / 레인 위 포인터 다운 */
export function lanePointerDown(e, row, x, y, studio) {
  if (e.button !== 0) return true;
  if (click && performance.now() - click.at < 450 && Math.hypot(click.x - x, click.y - y) < 8) { clearTimeout(click.timer); click = null; return true; } // second click of a double-click / 더블클릭의 두 번째
  const lane = row.lane;
  const ni = hitNode(row, x, y);
  if (ni >= 0) {
    selectLane(lane, ni, ni < lane.nodes.length - 1 ? ni : ni - 1);
    drag = { kind: 'node', studio, id: lane.id, i: ni, row, moved: false };
  } else {
    const hi = hitHandle(row, x, y);
    if (hi >= 0) {
      selectLane(lane, -1, hi);
      drag = { kind: 'handle', studio, id: lane.id, i: hi, row, moved: false };
    } else {
      selectLane(lane, ui.lane === lane.id ? ui.node : -1, ui.lane === lane.id ? ui.seg : -1);
      const at = performance.now();
      click = { at, x, y, timer: setTimeout(() => { click = null; curveAt(studio, row, x); }, 260) };
      drag = null;
    }
  }
  hooks.redraw();
  renderReadout(studio);
  if (drag) {
    const move = (ev) => onDragMove(ev);
    const up = () => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
      if (drag?.moved) editLanes(drag.studio, () => {}, { history: true }); // one undo step per drag / 드래그 하나 = 실행 취소 하나
      endHistoryGesture();
      drag = null;
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  }
  return true;
}

function onDragMove(ev) {
  if (!drag || !hooks.pos) return;
  const { x, y } = hooks.pos(ev);
  const { Tof, V } = geoFns(drag.row);
  const { studio, id, i } = drag;
  drag.moved = true;
  editLanes(studio, (lanes) => {
    const l = lanes.find((q) => q.id === id);
    if (!l) return;
    if (drag.kind === 'node') {
      const lo = i > 0 ? l.nodes[i - 1].t : 0;
      const hi = i < l.nodes.length - 1 ? l.nodes[i + 1].t : drag.row.geo.T;
      l.nodes[i].t = roundTo(clamp(Tof(x), lo, hi), 4);
      l.nodes[i].v = snap(V(y), l);
    } else {
      const a = l.nodes[i];
      const b = l.nodes[i + 1];
      if (!a || !b || Math.abs(b.v - a.v) < 1e-12) return;
      a.c = roundTo(curvatureOf((V(y) - a.v) / (b.v - a.v)), 3);
    }
  }, { history: false, silent: true });
  drag.row = { ...drag.row, lane: laneById(studio, id) || drag.row.lane };
  renderReadout(studio);
}

/** Single click on the line: curve the segment under the pointer (then its ◇ sets how much). / 선 클릭 = 곡선화 */
function curveAt(studio, row, x) {
  const { Tof } = geoFns(row);
  const lane = laneById(studio, row.lane.id);
  if (!lane) return;
  const s = segmentAt(lane.nodes, Tof(x));
  if (s < 0) return;
  selectLane(lane, -1, s);
  const a = lane.nodes[s];
  const b = lane.nodes[s + 1];
  if (Math.abs(a.c) < 1e-4 && Math.abs(b.v - a.v) > 1e-12) editLanes(studio, (lanes) => { const l = lanes.find((q) => q.id === lane.id); if (l) l.nodes[s].c = 4; });
  hooks.redraw();
  renderReadout(studio);
}

/** Double-click: add a node there. / 더블클릭 = 노드 추가 */
export function laneDblClick(row, x, y, studio) {
  if (click) { clearTimeout(click.timer); click = null; }
  if (hitNode(row, x, y) >= 0 || row.lane.nodes.length >= MAX_NODES) return;
  const { Tof, V } = geoFns(row);
  const tt = roundTo(Tof(x), 4);
  const lane = row.lane;
  const v = snap(V(y), lane);
  let at = 0;
  editLanes(studio, (lanes) => {
    const l = lanes.find((q) => q.id === lane.id);
    if (!l) return;
    at = l.nodes.findIndex((n) => n.t > tt);
    if (at < 0) at = l.nodes.length;
    // the new node splits a curved segment: both halves keep its bend direction / 곡선 구간을 나누면 양쪽이 같은 방향
    const c = at > 0 ? l.nodes[at - 1].c : 0;
    l.nodes.splice(at, 0, { t: tt, v, c });
  });
  selectLane(laneById(studio, lane.id), at, at);
  hooks.redraw();
  renderReadout(studio);
}

/** Two-finger click (context click): remove a node, or straighten a segment on its ◇. / 두 손가락 클릭 = 제거 */
export function laneContext(row, x, y, studio) {
  const ni = hitNode(row, x, y);
  const lane = row.lane;
  if (ni >= 0) {
    editLanes(studio, (lanes) => { const l = lanes.find((q) => q.id === lane.id); if (l) l.nodes.splice(ni, 1); });
    selectLane(laneById(studio, lane.id), -1, -1);
  } else {
    const hi = hitHandle(row, x, y);
    if (hi < 0) return;
    editLanes(studio, (lanes) => { const l = lanes.find((q) => q.id === lane.id); if (l) l.nodes[hi].c = 0; });
    selectLane(laneById(studio, lane.id), -1, hi);
  }
  hooks.redraw();
  renderReadout(studio);
}

// ==========================================================================
// Panel: button, toolbox / parameter picker, lanes, node readout / 패널
// ==========================================================================

/** Header button + picker (goes under the Timeline header) and the readout (under the canvas). / 패널 요소 */
export function buildAutomationUI(h) {
  hooks = { ...hooks, ...h };
  const btn = mk('button', `fx-toggle ${CHIP_OFF}`, t('au.btn'));
  btn.type = 'button';
  btn.dataset.help = 'app.automation';
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true') { hooks.toast(t('au.needMod')); return; }
    ui.open = !ui.open;
    hooks.redraw();
  });
  const picker = mk('div', 'flex flex-col gap-1.5 rounded-lg border border-violet-500/30 bg-slate-950/70 p-2 hidden');
  picker.dataset.noFs = '1';
  picker.dataset.help = 'app.automation';
  const readout = mk('div', 'flex flex-wrap items-center gap-2 text-[10.5px] text-slate-400 hidden');
  readout.dataset.noFs = '1';
  readout.dataset.help = 'app.automation';
  els = { btn, picker, readout, sig: '' };
  return els;
}

function row(label, children) {
  const r = mk('div', 'flex flex-wrap items-center gap-1');
  r.append(mk('span', 'text-[10px] uppercase tracking-wider text-violet-300/80 mr-1', label), ...children);
  return r;
}

/** Pick a parameter: open (or create) its lane under the module. / 파라미터 선택 → 레인 */
function pickParam(studio, mod, modName, tool, p) {
  const wide = studio !== 'glissando'; // other studios: toolboxes are studio-wide / 다른 스튜디오: 스튜디오 전체
  const same = lanesOf(studio).find((l) => l.tool === tool.key && l.pid === p.pid && (wide || l.mod === mod));
  if (same) {
    const from = same.mod;
    editLanes(studio, (lanes) => { const l = lanes.find((q) => q.id === same.id); if (l) { l.mod = mod; l.show = true; } });
    if (from !== mod && hooks.nameOf) hooks.toast(t('au.moved', hooks.nameOf(from) || from));
    selectLane(laneById(studio, same.id));
  } else {
    const path = probePath(studio, mod, p);
    const lane = { id: uid('auto'), mod, tool: tool.key, toolTitle: tool.title, pid: p.pid, label: p.label, min: p.min, max: p.max, step: p.step, on: true, show: true, path, nodes: [] };
    editLanes(studio, (lanes) => lanes.push(lane));
    selectLane(lane);
  }
  hooks.redraw();
}

/** Render button, picker and readout for the module `mod` (null = none selected). / 패널 그리기 */
export function renderAutomationUI(studio, mod, modName) {
  if (!els) return;
  const { btn, picker } = els;
  const can = !!mod;
  btn.setAttribute('aria-disabled', can ? 'false' : 'true');
  btn.title = can ? t('au.btnTip') : t('au.needMod');
  btn.className = `fx-toggle ${ui.open && can ? CHIP_ON : CHIP_OFF}${can ? '' : ' opacity-60'}`;
  btn.textContent = t('au.btn');
  const open = ui.open && can;
  picker.classList.toggle('hidden', !open);
  if (ui.lane && !laneById(studio, ui.lane)) selectLane(null);
  if (open) {
    const tools = appliedTools(studio);
    if (ui.tool && !tools.some((x) => x.key === ui.tool)) ui.tool = null;
    if (!ui.tool && tools.length) ui.tool = tools[0].key;
    const lanes = lanesOf(studio).filter((l) => l.mod === mod);
    const tool = tools.find((x) => x.key === ui.tool);
    const params = tool ? paramsOf(tool.node) : [];
    const sig = [studio, mod, appState.lang, ui.tool, ui.lane, tools.map((x) => `${x.key}:${x.title}`).join(','), params.map((p) => p.pid).join(','), lanes.map((l) => `${l.id}:${l.pid}:${l.on}:${l.show}:${l.nodes.length}`).join(',')].join('§');
    if (els.sig !== sig) {
      els.sig = sig;
      const toolChips = tools.map((x) => {
        const b = mk('button', x.key === ui.tool ? CHIP_ON : CHIP_OFF, x.title || x.key);
        b.type = 'button';
        const n = lanes.filter((l) => l.tool === x.key).length;
        if (n) b.textContent += ` ·${n}`;
        b.addEventListener('click', () => { ui.tool = x.key; hooks.redraw(); });
        return b;
      });
      const paramChips = params.map((p) => {
        const has = lanes.find((l) => l.tool === ui.tool && l.pid === p.pid);
        const b = mk('button', has ? CHIP_ON : CHIP_OFF, `${has ? '◆ ' : ''}${p.label}`);
        b.type = 'button';
        b.title = `${p.min} … ${p.max}${p.step ? ` (step ${p.step})` : ''}`;
        b.addEventListener('click', () => pickParam(studio, mod, modName, tool, p));
        return b;
      });
      const laneChips = lanes.map((l) => {
        const box = mk('span', `inline-flex items-center gap-0.5 rounded-md border px-1 ${l.id === ui.lane ? 'border-violet-400/70 bg-violet-600/20' : 'border-slate-700 bg-slate-900'}`);
        const name = mk('button', 'text-[10.5px] text-slate-200 px-0.5', `${l.toolTitle} › ${l.label}`);
        name.type = 'button';
        name.addEventListener('click', () => { selectLane(l); if (!l.show) editLanes(studio, (ls) => { const q = ls.find((z) => z.id === l.id); if (q) q.show = true; }); hooks.redraw(); });
        const on = mk('button', `text-[10px] px-0.5 ${l.on ? 'text-rose-300' : 'text-slate-500'}`, l.on ? '●' : '○');
        on.type = 'button';
        on.title = t('au.on');
        on.addEventListener('click', () => editLanes(studio, (ls) => { const q = ls.find((z) => z.id === l.id); if (q) q.on = !q.on; }));
        const eye = mk('button', `text-[10px] px-0.5 ${l.show ? 'text-sky-300' : 'text-slate-500'}`, l.show ? '◉' : '◎');
        eye.type = 'button';
        eye.title = t('au.show');
        eye.addEventListener('click', () => editLanes(studio, (ls) => { const q = ls.find((z) => z.id === l.id); if (q) q.show = !q.show; }));
        const del = mk('button', 'text-[11px] px-0.5 text-slate-400 hover:text-rose-300', '×');
        del.type = 'button';
        del.title = t('au.del');
        del.addEventListener('click', () => { editLanes(studio, (ls) => { const k = ls.findIndex((z) => z.id === l.id); if (k >= 0) ls.splice(k, 1); }); if (ui.lane === l.id) selectLane(null); });
        box.append(on, name, eye, del);
        return box;
      });
      picker.replaceChildren(
        row(t('au.mod', modName || mod), []),
        row(t('au.tools'), toolChips.length ? toolChips : [mk('span', 'text-[10.5px] text-slate-500', t('au.noTools'))]),
        row(t('au.params'), tool ? (paramChips.length ? paramChips : [mk('span', 'text-[10.5px] text-slate-500', t('au.noParams'))]) : []),
        row(t('au.lanes'), laneChips.length ? laneChips : [mk('span', 'text-[10.5px] text-slate-500', t('au.noLanes'))]),
        mk('div', 'text-[10px] text-slate-500', t('au.hint')),
      );
    }
  } else els.sig = '';
  renderReadout(studio);
}

/** Number box + ▲ ▼ for one coordinate. / 좌표 하나의 숫자 입력 + ▲▼ */
function coord(label, value, step, digits, onSet) {
  const wrap = mk('span', 'inline-flex items-center gap-1');
  const n = mk('input', NUM);
  n.type = 'number';
  n.step = String(step);
  n.value = String(roundTo(value, digits));
  n.dataset.auCoord = label;
  n.addEventListener('keydown', (e) => e.stopPropagation()); // typing never reaches the app shortcuts / 단축키로 가지 않음
  n.addEventListener('change', () => { const v = Number(n.value); if (Number.isFinite(v)) onSet(v); });
  const arrows = mk('span', 'inline-flex flex-col gap-px');
  const up = mk('button', STEP_BTN, '▲');
  const dn = mk('button', STEP_BTN, '▼');
  for (const [b, sgn] of [[up, 1], [dn, -1]]) {
    b.type = 'button';
    b.addEventListener('click', (e) => { const v = Number(n.value); onSet((Number.isFinite(v) ? v : value) + sgn * step * (e.shiftKey ? 10 : 1)); });
  }
  arrows.append(up, dn);
  wrap.append(mk('span', 'text-slate-400', label), n, arrows);
  return wrap;
}

function setNode(studio, laneId, i, patch) {
  editLanes(studio, (lanes) => {
    const l = lanes.find((q) => q.id === laneId);
    const n = l?.nodes[i];
    if (!n) return;
    if (patch.t !== undefined) {
      const lo = i > 0 ? l.nodes[i - 1].t : 0;
      const hi = i < l.nodes.length - 1 ? l.nodes[i + 1].t : Infinity;
      n.t = roundTo(clamp(patch.t, lo, hi), 4);
    }
    if (patch.v !== undefined) n.v = snap(patch.v, l);
    if (patch.c !== undefined) n.c = clamp(roundTo(patch.c, 3), -12, 12);
  }, { coalesceKey: `au:${laneId}:${i}:${Object.keys(patch).join()}` });
}

/** The selected node (or segment) under the Timeline; follows drags live. / 선택한 노드 표시 */
export function renderReadout(studio) {
  if (!els) return;
  const box = els.readout;
  const lane = ui.lane ? laneById(studio, ui.lane) : null;
  const show = !!lane && ui.open;
  box.classList.toggle('hidden', !show);
  if (!show) return;
  const i = ui.node;
  const n = lane.nodes[i];
  const s = ui.seg >= 0 && ui.seg < lane.nodes.length - 1 ? ui.seg : -1;
  const vStep = lane.step > 0 ? lane.step : roundTo((lane.max - lane.min) / 100, 6);
  const vDig = Math.max(0, Math.min(6, Math.ceil(-Math.log10(vStep)) + 1));
  const sig = `${lane.id}|${i}|${s}|${lane.nodes.length}`;
  // same layout: only update the numbers (keeps focus while typing) / 같은 배치면 숫자만 갱신
  if (box.dataset.sig === sig) {
    for (const inp of box.querySelectorAll('[data-au-coord]')) {
      if (document.activeElement === inp) continue;
      const k = inp.dataset.auCoord;
      const val = k === t('au.time') ? n?.t : k === t('au.value') ? n?.v : lane.nodes[s]?.c;
      if (val !== undefined) inp.value = String(roundTo(val, k === t('au.time') ? 3 : k === t('au.value') ? vDig : 2));
    }
    const lbl = box.querySelector('[data-au-cur]');
    if (lbl && n) lbl.textContent = `${t('au.node', i + 1, lane.nodes.length)}`;
    return;
  }
  box.dataset.sig = sig;
  const parts = [mk('span', 'font-semibold text-violet-200', `◆ ${lane.toolTitle} › ${lane.label}`)];
  if (n) {
    const lbl = mk('span', 'font-mono text-slate-300', t('au.node', i + 1, lane.nodes.length));
    lbl.dataset.auCur = '1';
    parts.push(lbl,
      coord(t('au.time'), n.t, 0.01, 3, (v) => setNode(studio, lane.id, i, { t: v })),
      coord(t('au.value'), n.v, vStep, vDig, (v) => setNode(studio, lane.id, i, { v })));
  }
  if (s >= 0) {
    parts.push(mk('span', 'font-mono text-slate-500', t('au.seg', s + 1)),
      coord(t('au.curve'), lane.nodes[s].c, 0.25, 2, (v) => setNode(studio, lane.id, s, { c: v })));
  }
  if (!n && s < 0) parts.push(mk('span', 'text-slate-500', t('au.hint')));
  box.replaceChildren(...parts);
}

/** Forget the selection when the module changes. / 모듈이 바뀌면 선택 해제 */
export function automationModuleChanged() {
  selectLane(null);
}
