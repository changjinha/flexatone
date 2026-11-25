/**
 * Flexatone — ui/panels.js
 * Layer 4 (ui): DOM control racks — voice cards (drag-reorder / multi-select), unified matrix,
 * curve-engine tabs + schema-driven parameter rack (incl. morph nodes & custom spline tools),
 * pitch/timing/mapping, timbre mixer & ƒ(x), gain mode/presets, versions, studio generator.
 * 계층 4 (ui): 보이스 카드, 통합 매트릭스, 엔진 탭·파라미터 랙, 음고·타이밍, 음색, 스냅샷, 스튜디오 생성기.
 *
 * Rendering rule: static controls from index.html are only *synced* (values/classes), and
 * a control that currently has focus is never overwritten. Dynamic areas rebuild only when
 * their structure key changes, otherwise they sync in place — so typing and dragging are
 * never interrupted. / 포커스된 입력은 덮어쓰지 않고, 구조가 바뀔 때만 다시 생성.
 */

import { clamp, roundTo, deepClone, createLinearSplinePoints, splitSplineSegmentPreservingShape, removeSplinePoint } from '../core/math-utils.js';
import { midiToNoteName, noteNameToMidi } from '../core/units.js';
import { t, getLang } from '../core/i18n.js';
import {
  appState,
  getActiveVoice,
  getVoiceById,
  getVoiceEnd,
  setVoicePitch,
  setVoiceTiming,
  setPref,
  selectVoice,
  selectAllVoices,
  addVoice,
  duplicateVoice,
  deleteVoices,
  reorderVoice,
  updateVoices,
  restoreVersion,
  removeVersion,
  clearVersions,
  toggleVersionGhost,
  endHistoryGesture,
  ENGINE_IDS,
  MORPH_MODES,
  TIMBRE_WAVES,
  MAX_TIME,
  createDefaultVoice,
  splitVoice,
  setVoiceLink,
} from '../core/state.js';
import { linkFamily, clipOf, isClipped } from '../core/line-clip.js';
import { normalizeAdsr, adsrGainAt } from '../core/adsr.js';
import {
  ENGINE_DEFS,
  PARAM_SCHEMAS,
  schemaVisible,
  getEngineDef,
  getEngineLabel,
  switchCurveEngine,
  captureCurveToCustomPoints,
  fitCurveToEngines,
  createMorphNode,
  evaluateCurveObjectY,
  mapNormYToFreq,
} from '../modules/curve-engine.js';
import { previewTimbreCycle, getTimbreCoefficientsCached } from '../modules/timbre-synth.js';
import { normalizeSampleSpec } from '../modules/sample-source.js';
import { createSampleEditor } from './sample-editor.js';
import { sampleReadSecAt } from '../audio/audio-engine.js';
import { openTimbreGroupDialog } from './timbre-group-dialog.js';
import { compileCurveFormula, analyzeRegionEdge, regionEdgeRamped } from '../modules/curve-engine.js';
import { nextFormulaVarName, MAX_FORMULA_VARS } from '../core/formula.js';
import { StudioRegistry } from '../studios/registry.js';
import { uiState, captureOptions, fitOptions } from './ui-state.js';
import { setSliderDefault } from './slider-reset.js';
import { voiceGainControl } from './voice-gain.js';

let hooks = { showToast: () => {}, fitAll: () => {}, requestRender: () => {} };
const $ = (id) => document.getElementById(id);

// ==========================================================================
// DOM helpers / DOM 헬퍼
// ==========================================================================

/** Tiny element builder: el('button', { class, text, on: { click } }, [children]). */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** Set an input's value unless the user is editing it. / 편집 중이 아니면 값 갱신 */
export function syncValue(input, value) {
  if (!input || document.activeElement === input) return;
  const s = String(value);
  if (input.value !== s) input.value = s;
}

export function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

/** Toggle-button visual state (.is-active + aria-pressed). / 토글 버튼 상태 */
export function setToggle(btn, on) {
  if (!btn) return;
  btn.classList.toggle('is-active', !!on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

const SEG_OFF = ['text-slate-400', 'hover:text-white', 'font-medium'];
/** Two-button segmented control: highlight `onBtn` with bg-{color}-600. / 세그먼트 버튼 */
export function setSegment(onBtn, offBtn, color = 'sky') {
  const on = [`bg-${color}-600`, 'text-white', 'font-semibold'];
  if (onBtn) {
    onBtn.classList.remove(...SEG_OFF);
    onBtn.classList.add(...on);
    onBtn.setAttribute('aria-pressed', 'true');
  }
  if (offBtn) {
    offBtn.classList.remove(...on);
    offBtn.classList.add(...SEG_OFF);
    offBtn.setAttribute('aria-pressed', 'false');
  }
}

// ==========================================================================
// Edit helpers / 편집 헬퍼
// ==========================================================================

const PANEL_SCOPE = ['canvas', 'gain', 'panels', 'matrix', 'timbre'];

/** Selected region of voice v when the rack is in region-curve mode. / 구간 곡선 편집 대상 */
function editedRegion(v) {
  const sel = uiState.regionSel;
  if (!uiState.regionEdit || !v || !sel || sel.voiceId !== v.id) return null;
  return (v.regions || []).find((r) => r.id === sel.regionId) || null;
}

/** The curve object the engine rack edits on a voice. / 엔진 랙 편집 대상 */
const targetObj = (v) => editedRegion(v)?.curve || (appState.engineTarget === 'amp' ? v.gainEngineObj : v);

/** Edit target voices (honours Group Apply; region-curve mode edits the active voice only). */
function editTargets(fn, key = null) {
  if (editedRegion(getActiveVoice())) return editActive(fn, key);
  return updateVoices(fn, { coalesceKey: key, scope: PANEL_SCOPE });
}

/** Edit only the active voice. / 활성 보이스만 편집 */
function editActive(fn, key = null) {
  const v = getActiveVoice();
  if (v) return updateVoices(fn, { ids: [v.id], coalesceKey: key, scope: PANEL_SCOPE });
  return null;
}

export const commitGesture = () => endHistoryGesture();
export const num = (x, fallback = 0) => (Number.isFinite(Number(x)) ? Number(x) : fallback);

/**
 * Labelled slider + number input row. onInput fires while dragging (coalesced into one undo
 * step via `key`); the gesture is closed on change. / 슬라이더 + 숫자 입력 행
 */
export function rangeRow({ label, value, min, max, step, accent = '', key, onInput, compact = false, def }) {
  const number = el('input', {
    type: 'number', min, max, step, value: roundTo(value, 4),
    class: 'w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-right font-mono text-[11px]',
  });
  const slider = el('input', { type: 'range', min, max, step, value, class: `w-full ${accent}` });
  setSliderDefault(slider, def); // double-click → default (ui/slider-reset.js) / 더블클릭 → 기본값
  slider.addEventListener('input', () => { number.value = slider.value; onInput(Number(slider.value), key); });
  slider.addEventListener('change', commitGesture);
  // Live while drag-scrubbing the number box (ui/number-scrub.js) / 숫자 드래그 중 실시간 반영
  number.addEventListener('input', () => { if (number.dataset.scrubbing) { slider.value = number.value; onInput(num(number.value, value), key); } });
  number.addEventListener('change', () => {
    // Typed values may exceed the slider's soft range; evaluators clamp to the hard range.
    // 입력값은 슬라이더 범위를 넘을 수 있으며, 평가기가 하드 범위로 제한함.
    onInput(num(number.value, value), null);
    commitGesture();
  });
  const root = el('div', { class: `flex flex-col ${compact ? 'gap-0.5' : 'gap-1'}` }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('span', { class: `text-slate-300 ${compact ? 'text-[10px]' : 'text-[11px]'}`, text: label }),
      number,
    ]),
    slider,
  ]);
  return {
    root,
    sync(v) {
      syncValue(slider, v);
      syncValue(number, roundTo(v, 4));
    },
  };
}

// ==========================================================================
// Voice cards / 보이스 카드
// ==========================================================================

let dragFromIndex = -1;

/**
 * S on a voice card. Batch (2+ selected, this one among them): only the selection is soloed and
 * every other solo is cleared; pressing it again when exactly the selection is soloed clears all solos.
 * 카드의 S. 일괄: 다른 솔로를 모두 끄고 선택된 보이스만 솔로 (이미 그 상태면 솔로 모두 해제).
 */
function soloClick(id, batch) {
  if (!batch) { updateVoices((vv) => { vv.solo = !vv.solo; }, { ids: [id], scope: PANEL_SCOPE }); return; }
  const set = new Set(batch);
  const exact = appState.voices.every((x) => !!x.solo === set.has(x.id));
  updateVoices((vv) => { vv.solo = !exact && set.has(vv.id); }, { ids: appState.voices.map((x) => x.id), scope: PANEL_SCOPE });
}

/**
 * M on a voice card. Click: mutes the selection (batch) or toggles this voice; when every target is
 * already muted the click unmutes them. Double-click: only the targets stay muted, every other voice
 * is unmuted. The second click of a double-click is caught by time, because the card re-renders after
 * the first one. / 카드의 M. 클릭: 대상 뮤트 (모두 뮤트돼 있으면 해제). 더블클릭: 대상'만' 뮤트.
 */
let lastMuteClick = { id: null, at: 0 };
const MUTE_DBL_MS = 350;
function muteClick(id, batch) {
  const now = performance.now();
  const dbl = lastMuteClick.id === id && now - lastMuteClick.at < MUTE_DBL_MS;
  lastMuteClick = dbl ? { id: null, at: 0 } : { id, at: now };
  const targets = batch || [id];
  const key = `mute:${id}`; // both clicks of a double-click = one undo step / 더블클릭 = 실행 취소 한 단계
  if (dbl) {
    const set = new Set(targets);
    updateVoices((vv) => { vv.muted = set.has(vv.id); }, { ids: appState.voices.map((x) => x.id), scope: PANEL_SCOPE, coalesceKey: key });
    endHistoryGesture();
    return;
  }
  const allMuted = targets.every((x) => getVoiceById(x)?.muted);
  updateVoices((vv) => { vv.muted = !allMuted; }, { ids: targets, scope: PANEL_SCOPE, coalesceKey: key });
  setTimeout(() => { if (lastMuteClick.id === id) endHistoryGesture(); }, MUTE_DBL_MS + 10);
}

/**
 * 🔗 checkbox on a card of a piece cut from a line (core/line-clip.js): ticked = its curve shape stays
 * in sync with the other pieces; unticked = a separate line. Trimmed / extended lines show their range.
 * 잘린 조각 카드의 🔗 체크박스: 체크 = 다른 조각과 곡선 모양 동기화, 해제 = 별개의 선.
 */
function linkBox(v) {
  const fam = linkFamily(appState.voices, v);
  const c = clipOf(v);
  const range = isClipped(v) ? el('span', { class: 'text-[9px] font-mono text-amber-300/80', text: `${Math.round(c.u0 * 100)}–${Math.round(c.u1 * 100)}%`, title: t('clip.range', Math.round(c.u0 * 100), Math.round(c.u1 * 100)), dataset: { help: 'gliss.clip' } }) : null;
  if (!v.link || fam.length < 2) return range;
  const others = fam.length - 1;
  const box = el('input', {
    type: 'checkbox',
    class: 'accent-emerald-500 w-3 h-3 cursor-pointer',
    on: {
      click: (e) => { e.stopPropagation(); setVoiceLink(v.id, e.target.checked); },
      dblclick: (e) => e.stopPropagation(),
      mousedown: (e) => e.stopPropagation(),
    },
  });
  box.checked = v.link.on !== false;
  const tip = v.link.on !== false ? t('clip.link', others) : t('clip.unlinked', others);
  box.setAttribute('aria-label', tip);
  return el('label', { class: `flex items-center gap-0.5 text-[10px] ${v.link.on !== false ? 'text-emerald-300' : 'text-slate-500'}`, title: tip, dataset: { help: 'gliss.clip' } }, [box, '🔗', range]);
}

/** Grapher controls of the play range: ✂ Split, ◌ Unplayed parts, Extend. / 재생 구간 컨트롤 동기화 */
function renderClipControls() {
  setToggle($('btnClipGhost'), appState.clipGhost !== false);
  const ext = $('selectClipExt');
  const v = getActiveVoice();
  if (ext && v && document.activeElement !== ext) ext.value = clipOf(v).ext;
  const split = $('btnSplitVoice');
  if (split && v) {
    const cue = Number(appState.transport?.cueSec) || 0;
    const ok = cue > v.startTime + 0.05 && cue < getVoiceEnd(v) - 0.05;
    split.classList.toggle('opacity-40', !ok);
    split.title = ok ? t('clip.splitTip') : `${t('clip.splitTip')} — ${t('clip.splitNa')}`;
  }
  $('btnClipGhost')?.setAttribute('title', t('clip.ghostTip'));
  ext?.setAttribute('title', t('clip.extTip'));
}

function bindClipControls() {
  $('btnSplitVoice')?.addEventListener('click', () => {
    const v = getActiveVoice();
    if (!v) return;
    const ev = splitVoice(v.id, Number(appState.transport?.cueSec) || 0);
    if (ev?.result) hooks.showToast(t('clip.splitDone', v.name));
    else hooks.showToast(t('clip.splitNa'), 'error');
  });
  $('btnClipGhost')?.addEventListener('click', () => setPref('clipGhost', appState.clipGhost === false, ['canvas', 'panels']));
  $('selectClipExt')?.addEventListener('change', (e) => {
    const ext = e.target.value === 'tangent' ? 'tangent' : 'shape';
    editTargets((vv) => {
      const c = clipOf(vv);
      if (ext === 'shape' && !isClipped(vv)) delete vv.clip;
      else vv.clip = { u0: c.u0, u1: c.u1, ext };
    });
    commitGesture();
  });
}

function renderVoiceCards() {
  renderClipControls();
  const box = $('voiceCardsContainer');
  if (!box) return;
  if (box.contains(document.activeElement) && document.activeElement.type === 'range') return; // a gain slider is being dragged / 게인 드래그 중
  setText($('voiceCountBadge'), t('grapher.voiceCount', appState.voices.length));
  const selected = new Set(appState.selectedVoiceIds);
  const anySolo = appState.voices.some((v) => v.solo);
  box.replaceChildren(
    ...appState.voices.map((v, index) => {
      const active = v.id === appState.activeVoiceId;
      const silent = v.muted || (anySolo && !v.solo);
      const cls = active
        ? 'border-sky-400 bg-slate-800 shadow shadow-sky-500/20'
        : selected.has(v.id)
          ? 'border-sky-600/80 bg-sky-950/60'
          : 'border-slate-700 bg-slate-900 hover:border-slate-500';
      // Batch target: the whole selection when this voice is one of 2+ selected voices
      // 일괄 대상: 이 보이스가 2개 이상 선택에 들어 있으면 선택 전체
      const batch = selected.size > 1 && selected.has(v.id) ? [...selected] : null;
      const sm = (label, on, onCls, title, field) =>
        el('button', {
          class: `w-5 h-5 rounded text-[10px] font-bold transition ${on ? onCls : 'bg-slate-800 text-slate-400 hover:text-white'}`,
          text: label,
          title,
          dataset: { help: 'gliss.soloMute' },
          on: {
            click: (e) => {
              e.stopPropagation();
              if (field === 'solo') soloClick(v.id, batch);
              else muteClick(v.id, batch);
            },
            dblclick: (e) => e.stopPropagation(), // not the card rename / 카드 이름 바꾸기 아님
          },
        });
      // Selection checkbox: tick to add / untick to remove, no modifier keys needed
      // 선택 체크박스: 체크하면 더하고 해제하면 뺌 (보조 키 불필요)
      const check = el('input', {
        type: 'checkbox',
        class: 'accent-sky-500 w-3.5 h-3.5 shrink-0 cursor-pointer',
        title: t('grapher.tip.check'),
        dataset: { help: 'gliss.multiSelect' },
        on: {
          click: (e) => {
            e.stopPropagation();
            selectVoice(v.id, { additive: true });
            if (appState.selectedVoiceIds.length > 1 && !appState.groupApplyMode) setPref('groupApplyMode', true, GROUP_SCOPE);
          },
          dblclick: (e) => e.stopPropagation(),
          mousedown: (e) => e.stopPropagation(),
        },
      });
      check.checked = selected.has(v.id);
      check.setAttribute('aria-label', t('grapher.tip.check'));
      const nameSpan = el('span', { class: `font-semibold truncate max-w-[110px] ${silent ? 'text-slate-500 line-through' : 'text-slate-100'}`, text: v.name });
      const card = el(
        'div',
        {
          class: `flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg border text-xs cursor-pointer select-none transition ${cls}`,
          draggable: true,
          dataset: { id: v.id, help: 'gliss.voiceCard' },
          title: `${v.name} — ${getEngineLabel(targetObj(v).engine)}`,
          on: {
            click: (e) => selectVoice(v.id, { additive: e.metaKey || e.ctrlKey, range: e.shiftKey }),
            dblclick: () => {
              const input = el('input', { value: v.name, class: 'w-28 px-1 rounded bg-slate-950 border border-sky-500 text-xs' });
              const done = (commit) => {
                if (commit && input.value.trim() && input.value.trim() !== v.name) {
                  updateVoices((vv) => { vv.name = input.value.trim().slice(0, 40); }, { ids: [v.id], scope: PANEL_SCOPE });
                } else hooks.requestRender(['panels']);
              };
              input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') done(false);
              });
              input.addEventListener('blur', () => done(true));
              nameSpan.replaceWith(input);
              input.focus();
              input.select();
            },
            dragstart: (e) => { dragFromIndex = index; e.dataTransfer.effectAllowed = 'move'; },
            dragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
            drop: (e) => {
              e.preventDefault();
              if (dragFromIndex >= 0 && dragFromIndex !== index) reorderVoice(dragFromIndex, index);
              dragFromIndex = -1;
            },
          },
        },
        [
          check,
          el('span', { class: 'text-slate-500 cursor-grab text-[11px] leading-none tracking-tighter', text: '⋮⋮', title: t('ui.dragToReorder'), dataset: { help: 'gliss.voiceReorder' } }),
          el('span', { class: 'w-2.5 h-2.5 rounded-full shrink-0', style: `background:${v.color}` }),
          nameSpan,
          linkBox(v),
          el('span', { class: 'text-[10px] text-slate-500 font-mono', text: String(getEngineDef(v.engine)?.num ?? '') }),
          voiceGainControl({ get: () => v.baseGain, set: (val, ck) => updateVoices((vv) => { vv.baseGain = val; }, { ids: [v.id], scope: ['canvas', 'gain', 'matrix'], coalesceKey: `${ck}:${v.id}` }), commit: () => endHistoryGesture(), push: (fn) => fn(), def: 0.85 }),
          sm(t('morph.soloShort'), v.solo, 'bg-amber-500 text-slate-950', batch ? t('grapher.tip.soloMulti', batch.length) : t('grapher.tip.solo'), 'solo'),
          sm('M', v.muted, 'bg-rose-600 text-white', batch ? t('grapher.tip.muteMulti', batch.length) : t('grapher.tip.mute'), 'muted'),
        ],
      );
      return card;
    }),
  );
}

/**
 * Grapher header: selection badge, Multi-select toggle, group edit mode (Active only / Sync /
 * Ratio / Offset). 'Active only' = groupApplyMode off; the others set appState.groupEditMode.
 * 그래퍼 머리줄: 선택 배지, 다중 선택, 그룹 편집 방식 (활성만 / 동기화 / 비율 / 덧셈).
 */
function renderGrapherHeader() {
  const n = appState.selectedVoiceIds.length;
  const multi = n > 1;
  const badge = $('voiceSelBadge');
  if (badge) { badge.classList.toggle('hidden', !multi); setText(badge, t('grapher.selectedCount', n)); }
  const all = $('btnSelectAllVoices');
  if (all) all.title = t('grapher.tip.selectAll');
  const cur = appState.groupApplyMode ? (['ratio', 'offset'].includes(appState.groupEditMode) ? appState.groupEditMode : 'sync') : 'off';
  const seg = $('groupEditSeg');
  if (!seg) return;
  seg.classList.toggle('opacity-50', !multi); // takes effect with 2+ selected voices / 2개 이상 선택 시 작동
  for (const b of seg.querySelectorAll('button[data-mode]')) {
    const on = b.dataset.mode === cur;
    b.className = `px-2 py-0.5 rounded transition ${on ? (cur === 'off' ? 'bg-slate-700 text-white font-semibold' : 'bg-sky-600 text-white font-semibold') : 'text-slate-400 hover:text-white font-medium'}`;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = `${t(`grapher.tip.edit.${b.dataset.mode}`)}${multi ? '' : ` — ${t('ui.groupNeedsMulti')}`}`;
  }
}

const GROUP_SCOPE = ['panels', 'selection', 'canvas'];
function setGroupEdit(mode) {
  endHistoryGesture();
  if (mode !== 'off') setPref('groupEditMode', mode, GROUP_SCOPE);
  setPref('groupApplyMode', mode !== 'off', GROUP_SCOPE);
}

// ==========================================================================
// Unified matrix / 통합 매트릭스
// ==========================================================================

let matrixKey = '';
const matrixSyncers = [];

function renderMatrix() {
  const panel = $('unifiedMatrixPanel');
  const body = $('unifiedMatrixBody');
  if (!panel || !body) return;
  panel.classList.toggle('hidden', !appState.matrixOpen);
  setToggle($('btnToggleMatrix'), appState.matrixOpen);
  $('btnToggleMatrix')?.setAttribute('aria-expanded', appState.matrixOpen ? 'true' : 'false');
  if (!appState.matrixOpen) return;

  const key = `${getLang()}|${appState.voices.map((v) => v.id).join(',')}`;
  if (key !== matrixKey) {
    matrixKey = key;
    matrixSyncers.length = 0;
    const cell = (child) => el('td', { class: 'py-1 px-2' }, [child]);
    const inp = (attrs) => el('input', { class: 'w-full min-w-[56px] px-1 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-[11px]', ...attrs });
    body.replaceChildren(
      ...appState.voices.map((v) => {
        const edit = (fn) => updateVoices(fn, { ids: [v.id], scope: PANEL_SCOPE });
        const name = inp({ type: 'text', on: { change: (e) => edit((vv) => { vv.name = e.target.value.trim().slice(0, 40) || vv.name; }) } });
        const engine = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-[11px]', on: { change: (e) => edit((vv) => switchCurveEngine(vv, e.target.value, { captureOpts: captureOptions() })) } },
          ENGINE_IDS.map((id) => el('option', { value: id, text: getEngineLabel(id, { short: true }) })));
        const noteInput = (side) => inp({
          type: 'text',
          on: {
            change: (e) => {
              if (noteNameToMidi(e.target.value) === null) {
                hooks.showToast(t('pitch.invalidNote', e.target.value), 'error');
                hooks.requestRender(['matrix']);
                return;
              }
              edit((vv) => setVoicePitch(vv, side, { note: e.target.value }));
            },
          },
        });
        const f0 = noteInput('f0');
        const f1 = noteInput('f1');
        const start = inp({ type: 'number', min: 0, max: MAX_TIME, step: 0.1, on: { change: (e) => edit((vv) => setVoiceTiming(vv, { start: num(e.target.value) })) } });
        const dur = inp({ type: 'number', min: 0.05, max: MAX_TIME, step: 0.1, on: { change: (e) => edit((vv) => setVoiceTiming(vv, { duration: num(e.target.value, vv.duration) })) } });
        const gain = inp({ type: 'number', min: 0, max: 1.5, step: 0.01, on: { change: (e) => edit((vv) => { vv.baseGain = clamp(num(e.target.value, vv.baseGain), 0, 1.5); }) } });
        const sBtn = el('button', { class: 'w-6 h-6 rounded text-[10px] font-bold', text: 'S', on: { click: () => edit((vv) => { vv.solo = !vv.solo; }) } });
        const mBtn = el('button', { class: 'w-6 h-6 rounded text-[10px] font-bold', text: 'M', on: { click: () => edit((vv) => { vv.muted = !vv.muted; }) } });
        const dot = el('span', { class: 'inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle' });
        matrixSyncers.push(() => {
          const vv = getVoiceById(v.id);
          if (!vv) return;
          dot.style.background = vv.color;
          syncValue(name, vv.name);
          syncValue(engine, vv.engine);
          syncValue(f0, midiToNoteName(vv.f0Midi));
          syncValue(f1, midiToNoteName(vv.f1Midi));
          syncValue(start, roundTo(vv.startTime, 3));
          syncValue(dur, roundTo(vv.duration, 3));
          syncValue(gain, roundTo(vv.baseGain, 3));
          sBtn.className = `w-6 h-6 rounded text-[10px] font-bold ${vv.solo ? 'bg-amber-500 text-slate-950' : 'bg-slate-800 text-slate-400'}`;
          mBtn.className = `w-6 h-6 rounded text-[10px] font-bold ${vv.muted ? 'bg-rose-600 text-white' : 'bg-slate-800 text-slate-400'}`;
        });
        return el('tr', { class: v.id === appState.activeVoiceId ? 'bg-slate-800/60' : '', dataset: { id: v.id } }, [
          el('td', { class: 'py-1 px-2 whitespace-nowrap' }, [dot, name]),
          cell(engine), cell(f0), cell(f1), cell(start), cell(dur), cell(gain),
          el('td', { class: 'py-1 px-2 text-center whitespace-nowrap' }, [sBtn, ' ', mBtn]),
        ]);
      }),
    );
  }
  for (const row of body.children) row.classList.toggle('bg-slate-800/60', row.dataset.id === appState.activeVoiceId);
  matrixSyncers.forEach((fn) => fn());
}

// ==========================================================================
// Engine tabs & parameter rack / 엔진 탭과 파라미터 랙
// ==========================================================================

function renderEngineTabs() {
  const box = $('engineTabs');
  const v = getActiveVoice();
  if (!box || !v) return;
  const current = targetObj(v).engine;
  if (box.dataset.lang !== getLang() || box.children.length !== ENGINE_DEFS.length) {
    box.dataset.lang = getLang();
    box.replaceChildren(
      ...ENGINE_DEFS.map((d) =>
        el('button', {
          class: 'px-1.5 py-1 rounded-md border text-[11px] font-medium truncate transition',
          dataset: { engine: d.id, help: `engine.${d.id}` },
          role: 'tab',
          title: getEngineLabel(d.id),
          text: getEngineLabel(d.id, { short: true }),
          on: { click: () => { editTargets((vv) => switchCurveEngine(targetObj(vv), d.id, { captureOpts: captureOptions() })); commitGesture(); } },
        }),
      ),
    );
  }
  for (const b of box.children) {
    const on = b.dataset.engine === current;
    b.className = `px-1.5 py-1 rounded-md border text-[11px] truncate transition ${on ? 'bg-sky-600 border-sky-500 text-white font-semibold' : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-white hover:border-slate-600 font-medium'}`;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

let rackKey = '';
let rackSyncers = [];

function schemaControl(s, getObj, applyEdit, compact = false) {
  if (s.type === 'range') {
    const row = rangeRow({
      label: t(s.labelKey),
      value: num(getObj()?.[s.key], s.default),
      min: s.softMin,
      max: s.softMax,
      step: s.step,
      compact,
      def: s.default,
      key: `param:${s.key}`,
      onInput: (val, key) => applyEdit((o) => {
        o[s.key] = s.integer ? Math.round(val) : val;
        if (o.symLock && s.key === 'x1') o.x2 = clamp(1 - o.x1, 0.52, 0.95);
        if (o.symLock && s.key === 'x2') o.x1 = clamp(1 - o.x2, 0.05, 0.48);
      }, key),
    });
    rackSyncers.push(() => row.sync(num(getObj()?.[s.key], s.default)));
    return row.root;
  }
  if (s.type === 'toggle') {
    const btn = el('button', {
      class: 'fx-toggle self-start px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-[11px] transition',
      on: {
        click: () => {
          applyEdit((o) => {
            o[s.key] = !(o[s.key] ?? s.default);
            if (s.key === 'symLock' && o.symLock) o.x2 = clamp(1 - num(o.x1, 0.25), 0.52, 0.95);
          });
          commitGesture();
        },
      },
    });
    rackSyncers.push(() => {
      const on = !!(getObj()?.[s.key] ?? s.default);
      setToggle(btn, on);
      setText(btn, s.offLabelKey && !on ? t(s.offLabelKey) : t(s.labelKey));
    });
    return btn;
  }
  if (s.type === 'formula') return formulaEditor(getObj, applyEdit);
  if (s.type === 'select') {
    const sel = el('select', {
      class: 'bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px]',
      on: { change: (e) => { applyEdit((o) => { o[s.key] = e.target.value; }); commitGesture(); } },
    }, s.options.map((o) => el('option', { value: o.value, text: t(o.labelKey) })));
    rackSyncers.push(() => syncValue(sel, getObj()?.[s.key] ?? s.default));
    return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300' }, [t(s.labelKey), sel]);
  }
  return null;
}

/**
 * 14. User formula: expression input with live validation, and variables a, b, c … each with
 * value slider + min/max (“+ Variable” adds the next letter). / 사용자 수식 편집기
 */
function formulaEditor(getObj, applyEdit) {
  const status = el('div', { class: 'text-[10px] font-mono' });
  const input = el('input', {
    type: 'text',
    spellcheck: false,
    value: getObj()?.formulaExpr ?? '',
    class: 'w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-[12px] text-sky-200',
  });
  input.addEventListener('keydown', (e) => e.stopPropagation()); // no global shortcuts while typing
  input.addEventListener('input', () => applyEdit((o) => { o.formulaExpr = input.value; }, 'formula-expr'));
  input.addEventListener('change', commitGesture);
  const errText = (err) => {
    if (!err) return t('formula.ok');
    if (err.code === 'unknown') return t('formula.err.unknown', err.arg);
    if (err.code === 'arity') return t('formula.err.arity', err.arg, err.arg2);
    if (err.code === 'empty') return t('formula.err.empty');
    return t('formula.err.syntax', err.pos);
  };
  rackSyncers.push(() => {
    const o = getObj();
    if (!o) return;
    syncValue(input, o.formulaExpr ?? '');
    const c = compileCurveFormula(o);
    setText(status, errText(c.error));
    status.className = `text-[10px] font-mono ${c.ok ? 'text-emerald-400' : 'text-rose-400'}`;
    input.classList.toggle('border-rose-500', !c.ok);
  });
  const vars = getObj()?.formulaVars || [];
  const varRows = vars.map((fv, i) => {
    const getVar = () => getObj()?.formulaVars?.[i];
    const row = rangeRow({
      label: fv.name, value: num(fv.value), min: fv.min, max: fv.max, step: Math.max(0.001, roundTo((fv.max - fv.min) / 200, 4)), compact: true,
      key: `fvar:${i}`, onInput: (val, key) => applyEdit((o) => { if (o.formulaVars[i]) o.formulaVars[i].value = val; }, key),
    });
    const bound = (field) => {
      const b = el('input', { type: 'number', step: 'any', value: fv[field], title: t(`formula.${field}`), class: 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[10px]' });
      b.addEventListener('change', () => {
        applyEdit((o) => {
          const x = o.formulaVars[i];
          if (!x) return;
          const val = num(b.value, x[field]);
          if (field === 'min' && val < x.max) x.min = val;
          if (field === 'max' && val > x.min) x.max = val;
          x.value = clamp(x.value, x.min, x.max);
        });
        commitGesture();
      });
      return b;
    };
    rackSyncers.push(() => { const x = getVar(); if (x) row.sync(num(x.value)); });
    return el('div', { class: 'flex flex-col gap-0.5 rounded border border-slate-800 p-1.5' }, [
      row.root,
      el('div', { class: 'flex items-center justify-end gap-1 text-[10px] text-slate-500' }, [
        t('formula.min'), bound('min'), t('formula.max'), bound('max'),
        el('button', { class: 'text-slate-500 hover:text-rose-400 px-1', text: '✕', on: { click: () => { applyEdit((o) => { o.formulaVars.splice(i, 1); }); commitGesture(); } } }),
      ]),
    ]);
  });
  const canAdd = vars.length < MAX_FORMULA_VARS && nextFormulaVarName(vars);
  return el('div', { class: 'flex flex-col gap-1.5' }, [
    el('label', { class: 'text-[11px] text-slate-300', text: t('param.formulaExpr') }),
    input,
    status,
    el('p', { class: 'text-[10px] text-slate-500', text: t('formula.hint') }),
    ...varRows,
    canAdd && el('button', {
      class: 'self-start px-2 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 text-[11px] font-semibold',
      text: `${t('formula.addVar')} (${nextFormulaVarName(vars)})`,
      on: { click: () => {
        applyEdit((o) => {
          const name = nextFormulaVarName(o.formulaVars || []);
          if (name) (o.formulaVars ||= []).push({ name, value: 1, min: -2, max: 2 });
        });
        commitGesture();
      } },
    }),
  ].filter(Boolean));
}

function polynomialEditor(getObj, applyEdit) {
  const obj = getObj();
  const pts = Array.isArray(obj.polyPoints) ? obj.polyPoints : [];
  const rows = pts.map((p, i) => {
    const mk = (field) => {
      const input = el('input', {
        type: 'number', step: 0.01,
        class: 'w-full px-1 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-[11px]',
        on: { change: (e) => { applyEdit((o) => { o.polyPoints[i][field] = clamp(num(e.target.value), field === 'x' ? 0 : -12, field === 'x' ? 1 : 12); }); commitGesture(); } },
      });
      rackSyncers.push(() => syncValue(input, roundTo(getObj()?.polyPoints?.[i]?.[field] ?? 0, 4)));
      return input;
    };
    return el('div', { class: 'grid grid-cols-[1.5rem_1fr_1fr_1.5rem] gap-1 items-center' }, [
      el('span', { class: 'text-[10px] text-slate-500 font-mono', text: `P${i}` }),
      mk('x'), mk('y'),
      pts.length > 1
        ? el('button', { class: 'text-slate-500 hover:text-rose-400 text-xs', text: '✕', on: { click: () => { applyEdit((o) => o.polyPoints.splice(i, 1)); commitGesture(); } } })
        : el('span'),
    ]);
  });
  return el('div', { class: 'flex flex-col gap-1.5' }, [
    el('span', { class: 'text-[11px] text-slate-300', text: t('param.polyDeg', Math.max(0, pts.length - 1)) }),
    ...rows,
    el('div', { class: 'flex gap-1.5' }, [
      pts.length < 9 && el('button', {
        class: 'px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px]',
        text: t('param.polyAdd'),
        on: {
          click: () => {
            applyEdit((o) => {
              const ps = o.polyPoints.slice().sort((a, b) => a.x - b.x);
              let gap = -1;
              let at = 0.5;
              for (let i = 0; i < ps.length - 1; i++) if (ps[i + 1].x - ps[i].x > gap) { gap = ps[i + 1].x - ps[i].x; at = (ps[i].x + ps[i + 1].x) / 2; }
              o.polyPoints = [...ps, { x: roundTo(at, 3), y: roundTo(evaluateCurveObjectY({ ...o, engine: 'polynomial', reverse: false, inverse: false }, at), 3) }].sort((a, b) => a.x - b.x);
            });
            commitGesture();
          },
        },
      }),
      el('button', { class: 'px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px]', text: t('param.polyReset'), on: { click: () => { applyEdit((o) => { o.polyPoints = [{ x: 0, y: 0 }, { x: 1, y: 1 }]; }); commitGesture(); } } }),
    ]),
  ]);
}

/**
 * Editable (x, y) table for a Custom spline: type coordinates, add a point in the widest gap
 * (shape-preserving split), delete interior points. Used by 11. Custom and Custom morph nodes.
 * 커스텀 스플라인 좌표 표: 직접 입력, 가장 넓은 구간에 점 추가(형태 유지), 내부 점 삭제.
 */
function customPointsTable(getObj, applyEdit) {
  const pts = getObj()?.customPoints || [];
  const rows = pts.map((p, i) => {
    const last = pts.length - 1;
    const mk = (field) => {
      const fixedX = field === 'x' && (i === 0 || i === last);
      const input = el('input', {
        type: 'number', step: 0.01, disabled: fixedX,
        class: 'w-full px-1 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-[11px] disabled:opacity-50',
        on: {
          change: (e) => {
            applyEdit((o) => {
              const ps = o.customPoints;
              if (!ps?.[i]) return;
              if (field === 'x') ps[i].x = roundTo(clamp(num(e.target.value, ps[i].x), ps[i - 1].x + 0.002, ps[i + 1].x - 0.002), 4);
              else ps[i].y = roundTo(num(e.target.value, ps[i].y), 4);
            });
            commitGesture();
          },
        },
      });
      rackSyncers.push(() => syncValue(input, roundTo(getObj()?.customPoints?.[i]?.[field] ?? 0, 4)));
      return input;
    };
    return el('div', { class: 'grid grid-cols-[1.5rem_1fr_1fr_1.5rem] gap-1 items-center' }, [
      el('span', { class: 'text-[10px] text-slate-500 font-mono', text: `${i}` }),
      mk('x'), mk('y'),
      i > 0 && i < last
        ? el('button', { class: 'text-slate-500 hover:text-rose-400 text-xs', text: '✕', on: { click: () => { applyEdit((o) => removeSplinePoint(o.customPoints, i)); commitGesture(); } } })
        : el('span'),
    ]);
  });
  return el('details', { class: 'text-[11px]' }, [
    el('summary', { class: 'cursor-pointer select-none text-slate-400', text: `${t('ui.pointsTable')} · ${t('custom.pointCount', pts.length)}` }),
    el('div', { class: 'flex flex-col gap-1 pt-1.5' }, [
      ...rows,
      el('button', {
        class: 'self-start px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px]',
        text: t('ui.addPoint'),
        on: {
          click: () => {
            applyEdit((o) => {
              const ps = o.customPoints;
              let gi = 0;
              for (let i = 1; i < ps.length - 1; i++) if (ps[i + 1].x - ps[i].x > ps[gi + 1].x - ps[gi].x) gi = i;
              splitSplineSegmentPreservingShape(ps, gi, (ps[gi].x + ps[gi + 1].x) / 2);
            });
            commitGesture();
          },
        },
      }),
    ]),
  ]);
}

const MORPH_OP_LABELS = { blend: 'Blend', add: '+Add', mul: '×Mul', diff: '−Diff' };

function morphEditor(getObj) {
  const obj = getObj();
  const nodes = obj.morphNodes || [];
  const editNode = (id, fn, key) => editActive((v) => { const n = targetObj(v).morphNodes.find((x) => x.id === id); if (n) fn(n); }, key);
  const modeSchema = PARAM_SCHEMAS.morph.find((s) => s.key === 'morphMode');
  const cards = nodes.map((n) => {
    const getNode = () => getObj()?.morphNodes?.find((x) => x.id === n.id);
    const nodeEdit = (fn, key) => editNode(n.id, fn, key);
    const engineSel = el('select', { class: 'bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] min-w-0 flex-1', on: { change: (e) => { nodeEdit((x) => { x.engine = e.target.value; }); commitGesture(); } } },
      ENGINE_IDS.filter((id) => id !== 'morph').map((id) => el('option', { value: id, text: getEngineLabel(id, { short: true }) })));
    // Blend / +Add / ×Mul / −Diff — clicking the active op again returns to "inherit"
    // 연산 버튼 — 활성 연산을 다시 누르면 상속으로
    const opBtns = MORPH_MODES.map((op) => {
      const b = el('button', {
        class: 'px-1.5 py-0.5 rounded text-[10px] font-semibold transition',
        text: MORPH_OP_LABELS[op],
        title: t(`morph.${op}`),
        on: { click: () => { nodeEdit((x) => { x.op = x.op === op ? null : op; }); commitGesture(); } },
      });
      rackSyncers.push(() => {
        const x = getNode();
        const own = x?.op === op;
        const inherited = !x?.op && (getObj()?.morphMode || 'blend') === op;
        b.className = `px-1.5 py-0.5 rounded text-[10px] font-semibold transition ${own ? 'bg-sky-600 text-white' : inherited ? 'bg-sky-900/60 text-sky-200 ring-1 ring-sky-700' : 'bg-slate-800 text-slate-400 hover:text-white'}`;
      });
      return b;
    });
    const flag = (field, label, onCls, title) => {
      const b = el('button', { class: 'w-6 h-6 rounded text-[10px] font-bold', text: label, title, on: { click: () => { nodeEdit((x) => { x[field] = !x[field]; }); commitGesture(); } } });
      rackSyncers.push(() => { const x = getNode(); b.className = `w-6 h-6 rounded text-[10px] font-bold ${x?.[field] ? onCls : 'bg-slate-800 text-slate-400 hover:text-white'}`; });
      return b;
    };
    const editing = uiState.morphEditNodeId === n.id;
    const editBtn = el('button', {
      class: `px-1.5 py-0.5 rounded text-[10px] font-semibold ${editing ? 'bg-fuchsia-600 text-white' : 'bg-slate-800 text-slate-300 hover:text-white'}`,
      text: t('ui.editNode'),
      on: { click: () => { uiState.morphEditNodeId = editing ? null : n.id; uiState.selection = null; hooks.requestRender(['panels', 'canvas']); } },
    });
    const weight = rangeRow({ label: t('param.morphWeight'), value: num(n.weight), min: -2, max: 2, step: 0.01, compact: true, def: 1, key: `w:${n.id}`, onInput: (val, key) => nodeEdit((x) => { x.weight = val; }, key) });
    rackSyncers.push(() => { const x = getNode(); if (!x) return; syncValue(engineSel, x.engine); weight.sync(num(x.weight)); });

    // ⚙ Edit: the node's own engine parameters incl. Symmetry Lock / C¹·C⁰ toggles,
    // polynomial points and Custom node coordinates. / 노드 세부 편집
    let detail = null;
    if (editing) {
      const parts = [];
      for (const s of PARAM_SCHEMAS[n.engine] || []) {
        if (!schemaVisible(s, n)) continue;
        if (s.type === 'points') parts.push(polynomialEditor(getNode, nodeEdit));
        else if (s.type === 'spline') {
          parts.push(el('p', { class: 'text-[10px] text-fuchsia-300', text: t('hint.custom') }));
          parts.push(customPointsTable(getNode, nodeEdit));
        } else {
          const c = schemaControl(s, getNode, nodeEdit, true);
          if (c) parts.push(c);
        }
      }
      detail = el('div', { class: 'flex flex-col gap-1.5 border-t border-slate-800 pt-1.5' }, parts);
    }
    return el('div', { class: `flex flex-col gap-1.5 rounded-lg border ${editing ? 'border-fuchsia-500/60' : 'border-slate-800'} bg-slate-900/70 p-2` }, [
      el('div', { class: 'flex items-center gap-1' }, [
        engineSel,
        flag('solo', t('morph.soloShort'), 'bg-amber-500 text-slate-950', t('morph.solo')),
        flag('bypass', t('morph.bypassShort'), 'bg-slate-500 text-white', t('morph.bypass')),
        editBtn,
        el('button', { class: 'text-slate-500 hover:text-rose-400 text-xs px-1', text: '✕', title: t('morph.remove'), on: { click: () => {
          if (uiState.morphEditNodeId === n.id) uiState.morphEditNodeId = null;
          editActive((v) => { const o = targetObj(v); o.morphNodes = o.morphNodes.filter((x) => x.id !== n.id); });
          commitGesture();
        } } }),
      ]),
      el('div', { class: 'flex gap-1' }, opBtns),
      weight.root,
      detail,
    ]);
  });
  return el('div', { class: 'flex flex-col gap-2' }, [
    modeSchema ? schemaControl(modeSchema, getObj, (fn, k) => editTargets((vv) => fn(targetObj(vv)), k)) : null,
    ...cards,
    nodes.length < 8 && el('button', {
      class: 'px-2 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 text-[11px] font-semibold',
      text: t('param.morphAdd'),
      on: { click: () => { editActive((v) => { targetObj(v).morphNodes.push(createMorphNode('harmonic', 0.5)); }); commitGesture(); } },
    }),
  ].filter(Boolean));
}

function customEditor(getObj) {
  const count = el('span', { class: 'text-[11px] text-slate-300' });
  rackSyncers.push(() => setText(count, t('custom.pointCount', getObj()?.customPoints?.length ?? 0)));
  const freehand = el('button', {
    class: 'fx-toggle px-2 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-[11px]',
    text: t('custom.freehand'),
    on: { click: () => setPref('customFreehand', !appState.customFreehand, ['canvas', 'panels']) },
  });
  rackSyncers.push(() => setToggle(freehand, appState.customFreehand));
  const btn = (label, onClick, cls = 'bg-slate-800 hover:bg-slate-700 border border-slate-700') => el('button', { class: `px-2 py-1 rounded-lg ${cls} text-[11px]`, text: label, on: { click: onClick } });

  // Capture fidelity (UI-only) drives Recapture and switching into Custom / 캡처 정밀도
  const fidelity = rangeRow({ label: t('ui.captureFidelity'), value: uiState.captureFidelity, min: 1, max: 10, step: 1, compact: true, def: 8, onInput: (val) => { uiState.captureFidelity = Math.round(val); } });
  const precision = rangeRow({ label: t('ui.fitPrecision'), value: uiState.fitPrecision, min: 1, max: 5, step: 1, compact: true, def: 3, onInput: (val) => { uiState.fitPrecision = Math.round(val); } });
  return el('div', { class: 'flex flex-col gap-2' }, [
    count,
    el('p', { class: 'text-[10px] text-slate-500', text: t('hint.custom') }),
    el('div', { class: 'flex flex-wrap gap-1.5' }, [
      freehand,
      btn(t('custom.recapture'), () => {
        editActive((v) => {
          const o = targetObj(v);
          const src = { ...o, engine: o.lastNonCustomEngine && o.lastNonCustomEngine !== 'custom' ? o.lastNonCustomEngine : 'harmonic' };
          o.customPoints = captureCurveToCustomPoints(src, captureOptions());
        });
        commitGesture();
      }),
      btn(t('custom.resetLinear'), () => { editActive((v) => { targetObj(v).customPoints = createLinearSplinePoints(0, 1); }); commitGesture(); }),
    ]),
    fidelity.root,
    el('div', { class: 'flex flex-col gap-1.5 rounded-lg border border-slate-800 p-2' }, [
      precision.root,
      btn(t('ui.reverseFit'), () => {
        const pts = getObj()?.customPoints;
        if (!pts) return;
        const res = fitCurveToEngines(pts, fitOptions());
        if (!res.best) return;
        editActive((v) => {
          const o = targetObj(v);
          Object.assign(o, res.best.params, { engine: res.best.id, lastNonCustomEngine: res.best.id });
        });
        commitGesture();
        hooks.showToast(t('engine.fitResult', getEngineLabel(res.best.id), res.best.rmse.toFixed(4)));
      }, 'bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 font-semibold'),
    ]),
    customPointsTable(getObj, (fn, k) => editActive((v) => fn(targetObj(v)), k)),
  ]);
}

function renderParamRack() {
  const box = $('paramRack');
  const v = getActiveVoice();
  if (!box || !v) return;
  const obj = targetObj(v);
  box.dataset.help = `engine.${obj.engine}`; // Help mode / Alt inspector / 도움말 모드
  const region = editedRegion(v);
  const key = [getLang(), v.id, appState.engineTarget, region?.id || '', obj.engine,
    obj.engine === 'formula' ? (obj.formulaVars || []).map((fv) => `${fv.name}:${fv.min}:${fv.max}`).join(',') : '',
    obj.engine === 'morph' ? obj.morphNodes.map((n) => `${n.id}:${n.engine}:${n.flowKind || ''}:${(n.polyPoints || []).length}:${(n.customPoints || []).length}`).join(',') : '',
    obj.engine === 'morph' ? uiState.morphEditNodeId : '',
    obj.engine === 'flow' ? obj.flowKind : '',
    obj.engine === 'custom' ? (obj.customPoints || []).length : '',
    obj.engine === 'polynomial' ? (obj.polyPoints || []).length : ''].join('|');
  if (key !== rackKey) {
    rackKey = key;
    rackSyncers = [];
    const getObj = () => { const vv = getActiveVoice(); return vv ? targetObj(vv) : null; };
    const applyEdit = (fn, k) => editTargets((vv) => fn(targetObj(vv)), k);
    const def = getEngineDef(obj.engine);
    const children = [
      el('div', { class: 'flex items-baseline justify-between gap-2' }, [
        el('span', { class: 'text-xs font-semibold text-sky-300', text: `${def.num}. ${getEngineLabel(obj.engine)}` }),
        region && el('span', { class: 'px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-semibold', text: `⬚ ${t('region.rackTag')}` }),
      ]),
      el('code', { class: 'font-mono text-[10px] text-slate-400 break-words', text: def.formula }),
    ];
    for (const s of PARAM_SCHEMAS[obj.engine] || []) {
      if (!schemaVisible(s, obj)) continue;
      if (s.type === 'points') children.push(polynomialEditor(getObj, applyEdit));
      else if (s.type === 'nodes') children.push(morphEditor(getObj));
      else if (obj.engine === 'morph' && s.key === 'morphMode') continue;
      else if (s.type === 'spline') children.push(customEditor(getObj));
      else children.push(schemaControl(s, getObj, applyEdit));
    }
    box.replaceChildren(...children.filter(Boolean));
  }
  rackSyncers.forEach((fn) => fn());
}

// ==========================================================================
// Engine target, symmetry, amplitude range / 편집 대상·반전·진폭 범위
// ==========================================================================

function renderEngineHeader() {
  const v = getActiveVoice();
  if (!v) return;
  const amp = appState.engineTarget === 'amp';
  setSegment(amp ? $('btnTargetAmp') : $('btnTargetCurve'), amp ? $('btnTargetCurve') : $('btnTargetAmp'), amp ? 'emerald' : 'sky');
  const o = targetObj(v);
  setToggle($('btnReverse'), o.reverse);
  setToggle($('btnInverse'), o.inverse);
  $('ampRangeControls')?.classList.toggle('hidden', !amp);
  if (amp) {
    syncValue($('inputAmpMin'), roundTo(num(v.gainEngineObj.ampMin), 3));
    syncValue($('inputAmpMax'), roundTo(num(v.gainEngineObj.ampMax, 1), 3));
    setToggle($('btnAmpAutoFit'), v.gainEngineObj.autoFit !== false);
  }
}

// ==========================================================================
// Pitch, timing & mapping / 음고·타이밍·매핑
// ==========================================================================

function renderPitchTiming() {
  const v = getActiveVoice();
  if (!v) return;
  for (const side of ['f0', 'f1']) {
    const S = side.toUpperCase();
    syncValue($(`input${S}Note`), midiToNoteName(v[`${side}Midi`]));
    syncValue($(`slider${S}Midi`), v[`${side}Midi`]);
    syncValue($(`input${S}Hz`), num(v[`${side}Hz`]).toFixed(2));
    syncValue($(`input${S}Fine`), v[`${side}Fine`]);
  }
  syncValue($('inputStart'), roundTo(v.startTime, 3));
  syncValue($('sliderStart'), v.startTime);
  const endMode = appState.durEditMode === 'end';
  setText($('lblDurMode'), t(endMode ? 'timing.end' : 'timing.duration'));
  const dv = endMode ? getVoiceEnd(v) : v.duration;
  syncValue($('inputDuration'), roundTo(dv, 3));
  syncValue($('sliderDuration'), dv);
  syncValue($('inputBaseGain'), roundTo(v.baseGain, 3));
  syncValue($('sliderBaseGain'), v.baseGain);
  const multi = appState.selectedVoiceIds.length > 1;
  const groupBtn = $('btnGroupApply');
  setToggle(groupBtn, appState.groupApplyMode && multi);
  if (groupBtn) {
    groupBtn.disabled = !multi;
    groupBtn.classList.toggle('opacity-40', !multi);
    groupBtn.title = multi ? t('tip.groupApply') : t('ui.groupNeedsMulti');
  }
  setSegment(v.logScale !== false ? $('btnScaleLog') : $('btnScaleLin'), v.logScale !== false ? $('btnScaleLin') : $('btnScaleLog'), 'amber');
  setSegment(v.audioTarget === 'vel' ? $('btnAudioVel') : $('btnAudioPos'), v.audioTarget === 'vel' ? $('btnAudioPos') : $('btnAudioVel'), 'sky');
}

function bindPitchTiming() {
  for (const side of ['f0', 'f1']) {
    const S = side.toUpperCase();
    const note = $(`input${S}Note`);
    note.addEventListener('change', () => {
      if (noteNameToMidi(note.value) === null) {
        hooks.showToast(t('pitch.invalidNote', note.value), 'error');
        note.blur();
        hooks.requestRender(['panels']);
        return;
      }
      editTargets((v) => setVoicePitch(v, side, { note: note.value }));
      commitGesture();
    });
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') note.blur(); });
    $(`slider${S}Midi`).addEventListener('input', (e) => editTargets((v) => setVoicePitch(v, side, { midi: Number(e.target.value) }), `${side}-midi`));
    $(`slider${S}Midi`).addEventListener('change', commitGesture);
    $(`input${S}Hz`).addEventListener('change', (e) => { editTargets((v) => setVoicePitch(v, side, { hz: num(e.target.value, v[`${side}Hz`]) })); commitGesture(); });
    $(`input${S}Fine`).addEventListener('change', (e) => { editTargets((v) => setVoicePitch(v, side, { fine: num(e.target.value) })); commitGesture(); });
  }
  const timing = (val, key) => editTargets((v) => {
    if (appState.durEditMode === 'end') setVoiceTiming(v, { end: val });
    else setVoiceTiming(v, { duration: val });
  }, key);
  $('inputStart').addEventListener('change', (e) => { editTargets((v) => setVoiceTiming(v, { start: num(e.target.value) })); commitGesture(); });
  $('sliderStart').addEventListener('input', (e) => editTargets((v) => setVoiceTiming(v, { start: Number(e.target.value) }), 'start'));
  $('sliderStart').addEventListener('change', commitGesture);
  $('inputDuration').addEventListener('change', (e) => { timing(num(e.target.value, 1)); commitGesture(); });
  $('sliderDuration').addEventListener('input', (e) => timing(Number(e.target.value), 'duration'));
  $('sliderDuration').addEventListener('change', commitGesture);
  $('btnToggleDurMode').addEventListener('click', () => setPref('durEditMode', appState.durEditMode === 'end' ? 'duration' : 'end', 'panels'));
  const gain = (val, key) => editTargets((v) => { v.baseGain = clamp(val, 0, 1.5); }, key);
  $('inputBaseGain').addEventListener('change', (e) => { gain(num(e.target.value, 0.85)); commitGesture(); });
  $('sliderBaseGain').addEventListener('input', (e) => gain(Number(e.target.value), 'gain'));
  $('sliderBaseGain').addEventListener('change', commitGesture);

  // Double-click → a new voice's defaults (ui/slider-reset.js) / 더블클릭 → 새 보이스의 기본값
  const dv0 = createDefaultVoice(0);
  setSliderDefault($('sliderF0Midi'), dv0.f0Midi);
  setSliderDefault($('sliderF1Midi'), dv0.f1Midi);
  setSliderDefault($('sliderStart'), dv0.startTime);
  setSliderDefault($('sliderDuration'), () => (appState.durEditMode === 'end' ? (getActiveVoice()?.startTime ?? dv0.startTime) + dv0.duration : dv0.duration));
  setSliderDefault($('sliderBaseGain'), dv0.baseGain);

  $('btnGroupApply').addEventListener('click', () => setPref('groupApplyMode', !appState.groupApplyMode, 'panels'));
  $('btnScaleLog').addEventListener('click', () => editTargets((v) => { v.logScale = true; }));
  $('btnScaleLin').addEventListener('click', () => editTargets((v) => { v.logScale = false; }));
  $('btnAudioPos').addEventListener('click', () => editTargets((v) => { v.audioTarget = 'pos'; }));
  $('btnAudioVel').addEventListener('click', () => editTargets((v) => { v.audioTarget = 'vel'; }));
}

// ==========================================================================
// Timbre / 음색
// ==========================================================================

let sampleEd = null; // per-voice Sampler panel (mounted in bindTimbre) / 보이스별 샘플러 패널

function renderTimbre() {
  const v = getActiveVoice();
  if (!v) return;
  const func = v.timbreMode === 'func';
  const smp = v.timbreMode === 'sample';
  const btns = { mix: $('btnTimbreMix'), func: $('btnTimbreFunc'), sample: $('btnTimbreSample') };
  const cur = smp ? 'sample' : func ? 'func' : 'mix';
  for (const [k, b] of Object.entries(btns)) if (k !== cur) setSegment(null, b, 'violet');
  setSegment(btns[cur], null, 'violet');
  $('timbreMixPanel')?.classList.toggle('hidden', func || smp);
  $('timbreFuncPanel')?.classList.toggle('hidden', !func);
  $('timbreSamplePanel')?.classList.toggle('hidden', !smp);
  if (smp && sampleEd) sampleEd.sync();
  const gb = $('btnTimbreGroup');
  if (gb) {
    const multi = appState.selectedVoiceIds.length > 1;
    gb.disabled = !multi;
    gb.classList.toggle('opacity-40', !multi);
    gb.title = multi ? t('timbreGroup.tip', appState.selectedVoiceIds.length) : t('ui.groupNeedsMulti');
  }
  for (const w of TIMBRE_WAVES) {
    const S = w[0].toUpperCase() + w.slice(1);
    syncValue($(`sliderTimbre${S}`), v.timbre[w]);
    setText($(`valTimbre${S}`), num(v.timbre[w]).toFixed(2));
  }
  renderAdsr(v);
  if (!func) return;
  const tf = v.timbreFunc;
  syncValue($('selectTimbreSource'), tf.source);
  const voiceSel = $('selectTimbreVoice');
  voiceSel.classList.toggle('hidden', tf.source !== 'voice');
  $('inputTimbreExpr').classList.toggle('hidden', tf.source === 'voice');
  const opts = appState.voices.map((x) => `${x.id}:${x.name}`).join('|');
  if (voiceSel.dataset.opts !== opts) {
    voiceSel.dataset.opts = opts;
    voiceSel.replaceChildren(el('option', { value: '', text: '—' }), ...appState.voices.map((x) => el('option', { value: x.id, text: x.name })));
  }
  syncValue(voiceSel, tf.voiceId || '');
  syncValue($('inputTimbreExpr'), tf.expr);
  const { error } = getTimbreCoefficientsCached(v, { voices: appState.voices });
  const errEl = $('timbreFuncError');
  errEl.classList.toggle('hidden', !error);
  setText(errEl, error ? t('timbre.exprError', error.message) : '');
  drawTimbrePreview(v);
}

/** ADSR block of the timbre toolbox (core/adsr.js). / 음색 툴박스의 ADSR */
function renderAdsr(v) {
  const a = normalizeAdsr(v.adsr);
  const on = $('chkAdsrOn');
  if (!on) return;
  on.checked = a.on;
  $('chkAdsrRetrig').checked = a.retrig;
  $('lblAdsrRetrig').title = t('adsr.retrigTip');
  $('adsrSliders').classList.toggle('opacity-40', !a.on);
  for (const k of ['a', 'd', 's', 'r']) {
    const K = k.toUpperCase();
    syncValue($(`sliderAdsr${K}`), a[k]);
    setText($(`valAdsr${K}`), k === 's' ? a[k].toFixed(2) : `${a[k].toFixed(k === 'a' ? 3 : 2)} s`);
  }
  // little picture of the envelope over the voice / 보이스 위의 엔벨로프 그림
  const c = $('adsrCanvas');
  if (!c || c.clientWidth === 0) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = a.on ? '#a78bfa' : '#475569';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const dur = Math.max(0.05, v.duration);
  for (let i = 0; i <= w; i++) {
    const y = h - 2 - (h - 4) * adsrGainAt({ ...a, on: true }, (i / w) * dur, dur);
    if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  }
  ctx.stroke();
}

function bindAdsr() {
  const on = $('chkAdsrOn');
  if (!on) return;
  const edit = (fn, key) => editTargets((vv) => { vv.adsr = normalizeAdsr(vv.adsr); fn(vv.adsr); }, key);
  on.addEventListener('change', (e) => { edit((a) => { a.on = e.target.checked; }); commitGesture(); });
  $('chkAdsrRetrig').addEventListener('change', (e) => { edit((a) => { a.retrig = e.target.checked; }); commitGesture(); });
  const def = createDefaultVoice(0).adsr;
  for (const k of ['a', 'd', 's', 'r']) {
    const sl = $(`sliderAdsr${k.toUpperCase()}`);
    setSliderDefault(sl, def[k]); // double-click → default / 더블클릭 → 기본값
    // moving a slider switches the envelope on / 슬라이더를 움직이면 엔벨로프가 켜짐
    sl.addEventListener('input', () => edit((a) => { a[k] = Number(sl.value); a.on = true; }, `adsr-${k}`));
    sl.addEventListener('change', commitGesture);
  }
}

function drawTimbrePreview(v) {
  const c = $('timbreFuncCanvas');
  if (!c || c.clientWidth === 0) return;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(148,163,184,0.2)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
  const { wave } = previewTimbreCycle(v, { voices: appState.voices, points: 256 });
  ctx.strokeStyle = '#a78bfa';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i <= wave.length; i++) {
    const y = h / 2 - wave[i % wave.length] * (h / 2 - 4);
    const x = (i / wave.length) * w;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function bindTimbre() {
  $('btnTimbreMix').addEventListener('click', () => editTargets((v) => { v.timbreMode = 'mix'; }));
  $('btnTimbreFunc').addEventListener('click', () => editTargets((v) => { v.timbreMode = 'func'; }));
  // Sampler: always the active voice only (individual voice), never Group Apply
  // 샘플러: 항상 활성 보이스만 (개별 보이스), 그룹 적용 안 함
  $('btnTimbreSample')?.addEventListener('click', () => {
    editActive((v) => { v.timbreMode = 'sample'; v.timbreSample = normalizeSampleSpec(v.timbreSample); });
    commitGesture();
  });
  // Group Apply: pick one of the selected voices' timbres (or import a file) for all of them
  // 그룹 적용: 선택된 보이스들의 음색 중 하나(또는 새 파일)를 모두에게
  $('btnTimbreGroup')?.addEventListener('click', () => openTimbreGroupDialog({ toast: (m, k) => hooks.showToast(m, k) }));
  const mount = $('timbreSamplePanel');
  if (mount) {
    sampleEd = createSampleEditor({
      get: () => getActiveVoice()?.timbreSample,
      edit: (fn, k) => editActive((v) => { v.timbreSample = normalizeSampleSpec(v.timbreSample); fn(v.timbreSample); }, k),
      toast: (m) => hooks.showToast(m),
      readPos: (sec) => { const v = getActiveVoice(); return v ? sampleReadSecAt(v.id, sec) : null; },
    });
    mount.replaceChildren(sampleEd.root);
  }
  for (const w of TIMBRE_WAVES) {
    const S = w[0].toUpperCase() + w.slice(1);
    const s = $(`sliderTimbre${S}`);
    setSliderDefault(s, createDefaultVoice(0).timbre[w]); // double-click → default / 더블클릭 → 기본값
    s.addEventListener('input', () => editTargets((v) => { v.timbre[w] = clamp(Number(s.value), 0, 1); }, `timbre-${w}`));
    s.addEventListener('change', commitGesture);
  }
  $('selectTimbreSource').addEventListener('change', (e) => { editTargets((v) => { v.timbreFunc.source = e.target.value; }); commitGesture(); });
  $('selectTimbreVoice').addEventListener('change', (e) => { editTargets((v) => { v.timbreFunc.voiceId = e.target.value; }); commitGesture(); });
  const expr = $('inputTimbreExpr');
  expr.addEventListener('input', () => editTargets((v) => { v.timbreFunc.expr = expr.value; }, 'timbre-expr'));
  expr.addEventListener('change', commitGesture);
  expr.addEventListener('keydown', (e) => e.stopPropagation());
}

// ==========================================================================
// Gain mode & presets / 게인 모드와 프리셋
// ==========================================================================

const GAIN_PRESETS = {
  btnGainReset: () => [{ x: 0, y: 0.9, handles: [] }, { x: 1, y: 0.9, handles: [] }],
  btnGainCresc: () => [{ x: 0, y: 0.05, handles: [{ u: 0.5, y: 0.12 }] }, { x: 1, y: 1, handles: [] }],
  btnGainDecresc: () => [{ x: 0, y: 1, handles: [{ u: 0.5, y: 0.12 }] }, { x: 1, y: 0.05, handles: [] }],
  btnGainSwell: () => [
    { x: 0, y: 0.05, handles: [{ u: 0.6, y: 0.1 }] },
    { x: 0.5, y: 1, handles: [{ u: 0.4, y: 0.1 }] },
    { x: 1, y: 0.05, handles: [] },
  ],
};

function renderGainHeader() {
  const v = getActiveVoice();
  if (!v) return;
  const eng = v.gainMode === 'engine';
  setSegment(eng ? $('btnGainModeEngine') : $('btnGainModePoints'), eng ? $('btnGainModePoints') : $('btnGainModeEngine'), eng ? 'violet' : 'emerald');
  const unitBtns = { amp: $('btnGainUnitAmp'), db: $('btnGainUnitDb'), sone: $('btnGainUnitSone') };
  for (const [u, btn] of Object.entries(unitBtns)) {
    if (!btn) continue;
    if (u === v.gainUnit) setSegment(btn, null, 'emerald');
    else setSegment(null, btn, 'emerald');
  }
  const dbOpts = $('gainDbOpts');
  dbOpts?.classList.toggle('hidden', v.gainUnit !== 'db');
  const taperBtn = $('btnGainTaper');
  if (taperBtn) {
    setText(taperBtn, `${t('gain.taper')} ${v.dbTaper === 'daw' ? 'B' : 'A'}`);
    taperBtn.title = t('out.taper.title');
  }
  syncValue($('inputGainDbMin'), Number.isFinite(v.dbMin) ? v.dbMin : -60);
}

function bindGain() {
  $('btnGainModePoints').addEventListener('click', () => editTargets((v) => { v.gainMode = 'points'; }));
  $('btnGainModeEngine').addEventListener('click', () => editTargets((v) => { v.gainMode = 'engine'; }));
  for (const [id, unit] of [['btnGainUnitAmp', 'amp'], ['btnGainUnitDb', 'db'], ['btnGainUnitSone', 'sone']]) {
    $(id)?.addEventListener('click', () => { editTargets((v) => { v.gainUnit = unit; }); commitGesture(); });
  }
  $('btnGainTaper')?.addEventListener('click', () => {
    const next = getActiveVoice()?.dbTaper === 'daw' ? 'linear' : 'daw';
    editTargets((v) => { v.dbTaper = next; });
    commitGesture();
  });
  $('inputGainDbMin')?.addEventListener('change', (e) => {
    editTargets((v) => { v.dbMin = clamp(Math.round(num(e.target.value, -60)), -120, -12); });
    commitGesture();
  });
  for (const [id, make] of Object.entries(GAIN_PRESETS)) {
    $(id).addEventListener('click', () => { editTargets((v) => { v.gainMode = 'points'; v.gainPoints = make(); }); commitGesture(); });
  }
}

// ==========================================================================
// Versions (screenshot backups) / 버전 (스크린샷 백업)
// ==========================================================================

/** Vector sketch of a version's curves; used when it has no screenshot thumbnail (older projects). */
function versionSvg(ver) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 60');
  svg.setAttribute('class', 'w-full h-16 rounded bg-slate-950');
  let tMin = Infinity;
  let tMax = -Infinity;
  let mMin = Infinity;
  let mMax = -Infinity;
  const lines = ver.voices.map((v) => {
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const midi = Math.log2(mapNormYToFreq(v, evaluateCurveObjectY(v, i / 48)) / 440) * 12 + 69;
      const sec = v.startTime + (v.duration * i) / 48;
      pts.push([sec, midi]);
      tMin = Math.min(tMin, sec); tMax = Math.max(tMax, sec);
      mMin = Math.min(mMin, midi); mMax = Math.max(mMax, midi);
    }
    return { color: v.color, pts };
  });
  const tS = Math.max(1e-6, tMax - tMin);
  const mS = Math.max(1, mMax - mMin);
  for (const l of lines) {
    const path = document.createElementNS(NS, 'polyline');
    path.setAttribute('points', l.pts.map(([s, m]) => `${(4 + ((s - tMin) / tS) * 112).toFixed(1)},${(56 - ((m - mMin) / mS) * 52).toFixed(1)}`).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', l.color);
    path.setAttribute('stroke-width', '1.6');
    svg.append(path);
  }
  return svg;
}

let verKey = '';

function renderVersions() {
  const grid = $('versionGrid');
  if (!grid) return;
  const list = appState.versions;
  setText($('verCountBadge'), t('ver.count', list.length));
  const clean = appState.screenshotMode === 'clean';
  setSegment(clean ? $('btnShotClean') : $('btnShotFull'), clean ? $('btnShotFull') : $('btnShotClean'), 'violet');
  const svgBtn = $('btnShotSvg');
  if (svgBtn) {
    const on = clean && appState.screenshotSvg;
    svgBtn.classList.toggle('hidden', !clean);
    svgBtn.classList.toggle('bg-violet-600', on);
    svgBtn.classList.toggle('text-white', on);
    svgBtn.classList.toggle('bg-slate-800', !on);
    svgBtn.classList.toggle('text-slate-300', !on);
    svgBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    svgBtn.title = t('ver.svgTitle');
  }
  const key = `${getLang()}|${list.map((v) => `${v.id}:${v.ghost}`).join(',')}`;
  if (key === verKey) return;
  verKey = key;
  if (!list.length) {
    grid.replaceChildren(el('p', { id: 'versionEmpty', class: 'col-span-full text-xs text-slate-500 py-3 px-1', text: t('ver.empty') }));
    return;
  }
  grid.replaceChildren(
    ...list.map((v, i) => {
      const time = new Date(v.createdAt).toLocaleTimeString(getLang() === 'ko' ? 'ko-KR' : 'en-US', { hour12: false });
      const small = (text, onClick, extra = '', help = '') => el('button', { class: `px-1.5 py-0.5 rounded text-[10px] transition ${extra || 'bg-slate-800 hover:bg-slate-700 text-slate-200'}`, text, dataset: help ? { help } : undefined, on: { click: onClick } });
      const thumb = v.thumb
        ? el('img', { src: v.thumb, alt: '', draggable: false, class: 'w-full h-16 rounded object-cover bg-slate-950' })
        : versionSvg(v);
      return el('div', { class: 'flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-900 p-1.5', dataset: { help: 'ver.item' } }, [
        thumb,
        el('div', { class: 'flex items-center justify-between text-[10px] text-slate-400 font-mono' }, [`#${i + 1}${v.mode === 'clean' ? ` · ${t('ver.modeCleanShort')}` : ''}`, time]),
        el('div', { class: 'flex flex-wrap gap-1' }, [
          small(t('ver.restore'), () => { restoreVersion(v.id); hooks.showToast(t('toast.versionRestored')); }, '', 'ver.restore'),
          small(v.ghost ? t('ver.ghostOn') : t('ver.ghostOff'), () => toggleVersionGhost(v.id), v.ghost ? 'bg-violet-600 text-white' : '', 'ver.ghost'),
          small('✕', () => removeVersion(v.id), 'bg-slate-800 hover:bg-rose-600 text-slate-300', 'ver.delete'),
        ]),
      ]);
    }),
  );
}

// ==========================================================================
// Studio generator panel (schema-driven) / 스튜디오 생성기 패널
// ==========================================================================

let studioKey = '';
let studioSyncers = [];

function renderStudioPanel() {
  const mount = $('studioMount');
  if (!mount) return;
  const id = StudioRegistry.resolveStudioId();
  const plugin = StudioRegistry.get(id);
  const show = !!(plugin && plugin.schema.length && typeof plugin.generateVoices === 'function');
  mount.classList.toggle('hidden', !show);
  if (!show) { mount.replaceChildren(); studioKey = ''; return; }
  const key = `${id}|${getLang()}`;
  if (key !== studioKey) {
    studioKey = key;
    studioSyncers = [];
    const params = () => StudioRegistry.getParams(id);
    const set = (patch, k) => StudioRegistry.setParams(id, patch, { coalesceKey: k });
    const controls = plugin.schema.map((s) => {
      if (s.type === 'range') {
        const row = rangeRow({ label: t(s.labelKey), value: num(params()[s.key], s.default), min: s.min, max: s.max, step: s.step, compact: true, def: s.default, key: `studio:${s.key}`, onInput: (val, k) => set({ [s.key]: s.integer ? Math.round(val) : val }, k) });
        studioSyncers.push(() => row.sync(num(params()[s.key], s.default)));
        row.root.dataset.help = `gen.${id}.${s.key}`;
        return row.root;
      }
      if (s.type === 'select') {
        const sel = el('select', { class: 'bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px]', on: { change: (e) => { set({ [s.key]: e.target.value }); commitGesture(); } } }, s.options.map((o) => el('option', { value: o.value, text: t(o.labelKey) })));
        studioSyncers.push(() => syncValue(sel, params()[s.key]));
        return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', 'data-help': `gen.${id}.${s.key}` }, [t(s.labelKey), sel]);
      }
      if (s.type === 'note') {
        const inp = el('input', { type: 'text', class: 'w-16 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-center font-mono text-xs', on: { change: (e) => {
          if (noteNameToMidi(e.target.value) === null) { hooks.showToast(t('pitch.invalidNote', e.target.value), 'error'); hooks.requestRender(['studio']); return; }
          set({ [s.key]: e.target.value.trim() }); commitGesture();
        } } });
        studioSyncers.push(() => syncValue(inp, params()[s.key]));
        return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', 'data-help': `gen.${id}.${s.key}` }, [t(s.labelKey), inp]);
      }
      return null;
    }).filter(Boolean);
    // ☑ toolboxes (plugin.toolboxes): the checked ones are copied from the active voice as it is at
    // the moment of generation (params.toolSource) / 체크한 툴박스 = 생성 직전의 활성 보이스 설정 그대로
    const toolList = Array.isArray(plugin.toolboxes) ? plugin.toolboxes : [];
    const toolRow = toolList.length ? el('div', { class: 'flex flex-col gap-1.5 pt-3', 'data-help': `gen.${id}.tools` }, [
      el('span', { class: 'text-[11px] font-semibold text-fuchsia-200', text: t('glis.tools') }),
      el('div', { class: 'flex flex-wrap gap-x-4 gap-y-1' }, toolList.map((tb) => {
        const box = el('input', { type: 'checkbox', class: 'accent-fuchsia-500', on: { change: () => { set({ tools: { ...(params().tools || {}), [tb.key]: box.checked } }); commitGesture(); } } });
        studioSyncers.push(() => { box.checked = !!params().tools?.[tb.key]; });
        return el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-200 cursor-pointer select-none', dataset: { tool: tb.key } }, [box, t(tb.labelKey)]);
      })),
      el('p', { class: 'text-[10px] text-slate-500', text: t('glis.tools.hint') }),
    ]) : null;
    const bake = (mode) => {
      const p = params();
      const useTools = toolList.some((tb) => p.tools?.[tb.key]);
      StudioRegistry.bakeVoices(id, { mode, params: useTools ? { ...p, toolSource: deepClone(getActiveVoice()) } : undefined });
      hooks.fitAll();
      hooks.showToast(`${t('studio.generate')} · ${t(mode === 'append' ? 'studio.append' : 'studio.replace')}`);
    };
    mount.className = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3';
    mount.replaceChildren(el('details', { class: 'group' }, [
      el('summary', { class: 'cursor-pointer select-none text-xs font-bold uppercase tracking-wider text-fuchsia-300', 'data-help': `gen.${id}.panel`, text: `${t(`studio.${id}`) === `studio.${id}` ? plugin.name.en : t(`studio.${id}`)} · ${t('studio.generate')}` }),
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-3' }, controls),
      toolRow,
      el('div', { class: 'flex gap-2 pt-3' }, [
        el('button', { class: 'px-3 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-semibold', 'data-help': `gen.${id}.replace`, text: t('studio.replace'), on: { click: () => bake('replace') } }),
        el('button', { class: 'px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs', 'data-help': `gen.${id}.append`, text: t('studio.append'), on: { click: () => bake('append') } }),
      ]),
    ]));
  }
  studioSyncers.forEach((fn) => fn());
}

// ==========================================================================
// Public API / 공개 API
// ==========================================================================

/** Wire static controls once. / 정적 컨트롤 바인딩 (1회) */
export function initPanels(h) {
  hooks = { ...hooks, ...h };
  $('btnAddVoice').addEventListener('click', () => addVoice());
  $('btnDupVoice').addEventListener('click', () => duplicateVoice());
  $('btnDelVoice').addEventListener('click', () => {
    if (deleteVoices().result === false) hooks.showToast(t('toast.lastVoice'), 'error');
  });
  $('btnToggleMatrix').addEventListener('click', () => setPref('matrixOpen', !appState.matrixOpen, 'matrix'));
  // Selection & group edit mode. Asking for several voices means editing them together, so a card
  // checkbox that makes 2+ selected and Select all switch group edit on (in the mode last used).
  // 선택 · 그룹 편집 방식. 카드 체크박스로 2개 이상이 되거나 모두 선택하면 그룹 편집을 켠다.
  $('btnSelectAllVoices')?.addEventListener('click', () => {
    selectAllVoices();
    if (!appState.groupApplyMode) setPref('groupApplyMode', true, GROUP_SCOPE);
  });
  for (const b of document.querySelectorAll('#groupEditSeg button[data-mode]')) b.addEventListener('click', () => setGroupEdit(b.dataset.mode));
  $('btnClearVersions').addEventListener('click', () => { clearVersions(); hooks.showToast(t('toast.versionsCleared')); });
  $('btnShotFull').addEventListener('click', () => setPref('screenshotMode', 'full', ['versions']));
  $('btnShotClean').addEventListener('click', () => setPref('screenshotMode', 'clean', ['versions']));
  $('btnShotSvg').addEventListener('click', () => setPref('screenshotSvg', !appState.screenshotSvg, ['versions']));

  $('btnTargetCurve').addEventListener('click', () => setPref('engineTarget', 'curve', ['panels', 'canvas']));
  $('btnTargetAmp').addEventListener('click', () => {
    setPref('engineTarget', 'amp', ['panels', 'canvas']);
    // Editing the amplitude engine only makes sense audibly in Engine gain mode.
    // 진폭 엔진 편집은 Engine 게인 모드에서만 들리므로 자동 전환.
    if (getActiveVoice()?.gainMode !== 'engine') editTargets((v) => { v.gainMode = 'engine'; });
  });
  $('btnReverse').addEventListener('click', () => {
    const on = !targetObj(getActiveVoice()).reverse;
    editTargets((v) => { targetObj(v).reverse = on; });
  });
  $('btnInverse').addEventListener('click', () => {
    const on = !targetObj(getActiveVoice()).inverse;
    editTargets((v) => { targetObj(v).inverse = on; });
  });
  $('inputAmpMin').addEventListener('change', (e) => { editTargets((v) => { v.gainEngineObj.ampMin = clamp(num(e.target.value), 0, 1); }); commitGesture(); });
  $('inputAmpMax').addEventListener('change', (e) => { editTargets((v) => { v.gainEngineObj.ampMax = clamp(num(e.target.value, 1), 0, 1); }); commitGesture(); });
  $('btnAmpAutoFit').addEventListener('click', () => {
    const on = getActiveVoice()?.gainEngineObj.autoFit === false;
    editTargets((v) => { v.gainEngineObj.autoFit = on; });
  });

  bindPitchTiming();
  bindTimbre();
  bindAdsr();
  bindClipControls();
  bindGain();
}

/** Re-render panels for a set of dirty scopes (or everything). / 변경 범위에 맞춰 패널 갱신 */
export function renderPanels(scopes = new Set(['all'])) {
  const all = scopes.has('all') || scopes.has('lang');
  const any = (...names) => all || names.some((n) => scopes.has(n));
  if (any('voices', 'selection', 'panels', 'matrix', 'history')) {
    renderVoiceCards();
    renderGrapherHeader();
    renderMatrix();
  }
  if (any('voices', 'selection', 'panels', 'history', 'timbre')) {
    renderEngineTabs();
    renderEngineHeader();
    renderParamRack();
    renderPitchTiming();
    renderGainHeader();
    renderTimbre();
  }
  if (any('voices', 'selection', 'panels', 'history', 'canvas', 'view')) renderRegionPanel();
  if (any('versions')) renderVersions();
  if (any('studio', 'panels', 'history')) renderStudioPanel();
}

// ==========================================================================
// Local region panel (Select tool) / 로컬 구간 패널
// ==========================================================================

let regionKey = '';
let regionSyncers = [];

function regionChip(labelKey, getOn, onClick, onCls) {
  const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px] font-semibold', text: t(labelKey), on: { click: onClick } });
  regionSyncers.push(() => { b.className = `px-2 py-0.5 rounded text-[11px] font-semibold transition ${getOn() ? onCls : 'bg-slate-800 text-slate-400 hover:text-white'}`; });
  return b;
}

function renderRegionPanel() {
  const box = $('regionPanel');
  if (!box) return;
  const v = getActiveVoice();
  const regions = v?.regions || [];
  const sel = uiState.regionSel;
  let r = sel && v && sel.voiceId === v.id ? regions.find((x) => x.id === sel.regionId) : null;
  if (!r && sel) { uiState.regionSel = null; uiState.regionEdit = false; }
  const visible = !!(appState.selectMode || regions.length);
  box.classList.toggle('hidden', !visible);
  if (!visible) return;
  const key = [getLang(), v?.id, r?.id || '', regions.length, uiState.regionEdit].join('|');
  if (key !== regionKey) {
    regionKey = key;
    regionSyncers = [];
    box.replaceChildren(...buildRegionPanel(v, r, regions));
  }
  regionSyncers.forEach((fn) => fn());
}

// Region tremolo block, registered by ui/tremolo-panel.js (avoids a circular import).
// 구간 트레몰로 블록 — ui/tremolo-panel.js가 등록 (순환 import 방지)
let regionTremoloBuilder = null;
export function setRegionTremoloBuilder(fn) { regionTremoloBuilder = fn; }

function buildRegionPanel(v, r, regions) {
  const head = el('div', { class: 'flex items-center justify-between gap-2' }, [
    el('span', { class: 'text-xs font-semibold text-amber-300', text: `⬚ ${t('region.title')}` }),
    el('span', { class: 'text-[10px] text-slate-500', text: t('region.count', regions.length) }),
  ]);
  // Region chips: select any region of the active voice / 구간 칩
  const chips = el('div', { class: 'flex flex-wrap gap-1' }, regions.map((x, i) => el('button', {
    class: `px-1.5 py-0.5 rounded text-[10px] font-mono ${r && x.id === r.id ? 'bg-amber-500 text-slate-950 font-semibold' : 'bg-slate-800 text-slate-300 hover:text-white'}`,
    text: `R${i + 1}`,
    on: { click: () => { uiState.regionSel = { voiceId: v.id, regionId: x.id }; hooks.requestRender(['canvas', 'panels']); } },
  })));
  if (!r) return [head, regions.length ? chips : null, el('p', { class: 'text-[11px] text-slate-400', text: t('region.none') })].filter(Boolean);

  const getR = () => { const vv = getActiveVoice(); return (vv?.regions || []).find((x) => x.id === r.id) || null; };
  const editR = (fn, k = null) => editActive((vv) => { const x = (vv.regions || []).find((y) => y.id === r.id); if (x) fn(x); }, k);
  const click = (fn) => () => { editR(fn); commitGesture(); };

  const secRow = (labelKey, field) => {
    const inp = el('input', { type: 'number', step: 0.01, class: 'w-20 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-right font-mono text-[11px]' });
    inp.addEventListener('change', () => {
      const vv = getActiveVoice();
      const tn = clamp((num(inp.value) - vv.startTime) / Math.max(1e-9, vv.duration), 0, 1);
      editR((x) => { if (field === 't0') x.t0 = roundTo(Math.min(tn, x.t1 - 0.005), 5); else x.t1 = roundTo(Math.max(tn, x.t0 + 0.005), 5); });
      commitGesture();
    });
    regionSyncers.push(() => { const x = getR(); const vv = getActiveVoice(); if (x && vv) syncValue(inp, roundTo(vv.startTime + x[field] * vv.duration, 3)); });
    return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300' }, [t(labelKey), inp]);
  };

  const seg = (field, options) => el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5' }, options.map(([value, labelKey]) => {
    const b = el('button', { class: 'flex-1 px-1.5 py-0.5 rounded text-[10px]', text: t(labelKey), on: { click: click((x) => { x[field] = value; }) } });
    regionSyncers.push(() => { const on = getR()?.[field] === value; b.className = `flex-1 px-1.5 py-0.5 rounded text-[10px] transition ${on ? 'bg-amber-500 text-slate-950 font-semibold' : 'text-slate-400 hover:text-white'}`; });
    return b;
  }));

  const mix = rangeRow({ label: t('region.mix'), value: r.mix, min: 0, max: 1, step: 0.01, compact: true, key: 'region-mix', onInput: (val, k) => editR((x) => { x.mix = val; }, k) });
  const ramp = rangeRow({ label: t('region.rampMs'), value: r.rampSec * 1000, min: 3, max: 500, step: 1, compact: true, key: 'region-ramp', onInput: (val, k) => editR((x) => { x.rampSec = val / 1000; }, k) });
  const gain = rangeRow({ label: t('region.gainDb'), value: r.gainDb, min: -40, max: 12, step: 0.5, compact: true, key: 'region-gain', onInput: (val, k) => editR((x) => { x.gainDb = val; }, k) });
  regionSyncers.push(() => { const x = getR(); if (!x) return; mix.sync(x.mix); ramp.sync(x.rampSec * 1000); gain.sync(x.gainDb); });

  // Edge smoothness badges (jump / kink / smooth, and whether a ramp is applied)
  // 경계 매끄러움 배지 (점프 / 꺾임 / 매끄러움, 램프 적용 여부)
  const edgeBadge = (side) => {
    const s = el('span', { class: 'px-1.5 py-0.5 rounded text-[10px] font-mono' });
    regionSyncers.push(() => {
      const vv = getActiveVoice();
      const x = getR();
      if (!vv || !x) return;
      const e = analyzeRegionEdge(vv, x, side);
      const ramped = regionEdgeRamped(vv, x, side);
      const what = e.smooth ? t('region.smooth') : Math.abs(e.jump) >= 2e-3 ? t('region.jump', `${e.jump > 0 ? '+' : ''}${roundTo(e.jump, 3)}`) : t('region.kink');
      setText(s, `${t(side === 'in' ? 'region.edgeIn' : 'region.edgeOut')}: ${what}${ramped ? ` → ${t('region.ramped')}` : ''}`);
      s.className = `px-1.5 py-0.5 rounded text-[10px] font-mono ${e.smooth ? 'bg-emerald-900/40 text-emerald-300' : ramped ? 'bg-sky-900/40 text-sky-300' : 'bg-rose-900/40 text-rose-300'}`;
    });
    return s;
  };

  const editBtn = el('button', {
    class: 'px-2 py-1 rounded-lg text-[11px] font-semibold',
    text: t('region.edit'),
    on: { click: () => { uiState.regionEdit = !uiState.regionEdit; hooks.requestRender(['panels', 'canvas']); } },
  });
  regionSyncers.push(() => { editBtn.className = `px-2 py-1 rounded-lg text-[11px] font-semibold transition ${uiState.regionEdit ? 'bg-amber-500 text-slate-950' : 'bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30'}`; });

  return [
    head,
    chips,
    el('div', { class: 'flex flex-wrap items-center gap-1' }, [
      regionChip('region.solo', () => getR()?.solo, click((x) => { x.solo = !x.solo; }), 'bg-yellow-400 text-slate-950'),
      regionChip('region.mute', () => getR()?.mute, click((x) => { x.mute = !x.mute; }), 'bg-rose-500 text-white'),
      el('button', { class: 'ml-auto px-2 py-0.5 rounded text-[11px] text-slate-400 hover:text-rose-400', text: `✕ ${t('region.delete')}`, on: { click: () => {
        editActive((vv) => { vv.regions = (vv.regions || []).filter((x) => x.id !== r.id); });
        commitGesture();
        uiState.regionSel = null;
        uiState.regionEdit = false;
        hooks.requestRender(['canvas', 'panels']);
      } } }),
    ]),
    el('div', { class: 'grid grid-cols-2 gap-2' }, [secRow('region.start', 't0'), secRow('region.end', 't1')]),
    mix.root,
    el('div', { class: 'flex flex-col gap-1' }, [el('span', { class: 'text-[11px] text-slate-300', text: t('region.timeMode') }), seg('timeMode', [['global', 'region.global'], ['local', 'region.local']])]),
    el('div', { class: 'flex flex-col gap-1' }, [
      el('span', { class: 'text-[11px] text-slate-300', text: t('region.ramp') }),
      seg('ramp', [['auto', 'region.rampAuto'], ['on', 'region.rampOn'], ['off', 'region.rampOff']]),
      el('div', { class: 'flex flex-wrap gap-1' }, [edgeBadge('in'), edgeBadge('out')]),
    ]),
    ramp.root,
    gain.root,
    ...(regionTremoloBuilder ? [regionTremoloBuilder({ getR, editR, syncers: regionSyncers })] : []),
    el('div', { class: 'flex flex-wrap gap-1.5' }, [
      editBtn,
      el('button', { class: 'px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px]', text: t('region.copyVoice'), on: { click: () => {
        editActive((vv) => {
          const x = (vv.regions || []).find((y) => y.id === r.id);
          if (!x) return;
          for (const k of Object.keys(x.curve)) if (vv[k] !== undefined) x.curve[k] = JSON.parse(JSON.stringify(vv[k]));
        });
        commitGesture();
      } } }),
    ]),
    uiState.regionEdit && el('p', { class: 'text-[10px] text-amber-300/80', text: t('region.editing') }),
  ].filter(Boolean);
}
