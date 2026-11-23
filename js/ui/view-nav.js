/**
 * Flexatone — ui/view-nav.js
 * Layer 4 (ui): one way to move around a time × pitch canvas, for every studio.
 * 계층 4 (ui): 시간 × 음고 캔버스를 둘러보는 방법을 모든 스튜디오에서 하나로 통일.
 *
 * The grammar is the Glissando editor's / 글리산도 에디터와 같은 문법:
 *   wheel                 scroll the pitch axis            휠 = 음고 스크롤
 *   Shift + wheel, ⇄      scroll the time axis             Shift+휠·가로 휠 = 시간 스크롤
 *   Ctrl / ⌘ + wheel      zoom both axes at the pointer    Ctrl/⌘+휠(핀치) = 포인터 기준 줌
 *   toolbar               Pitch − +, Time − +, X+Y − +, Fit All (F)
 * A view is a plain `{ tMin, tMax, midiMin, midiMax }` (seconds, MIDI). The helpers mutate it in
 * place, so a studio can keep it in its document (history: false) or as local UI state.
 * 뷰는 `{ tMin, tMax, midiMin, midiMax }` 객체이며 헬퍼가 직접 수정 — 문서(history: false)나 UI 지역 상태 어디에 두어도 됨.
 */

import { t, I18N } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, { 'view.navHint': 'wheel = pitch · ⇧ = time · ⌘/Ctrl = zoom · double-click = cue' });
Object.assign(I18N.ko, { 'view.navHint': '휠 = 음고 · ⇧ = 시간 · ⌘/Ctrl = 줌 · 더블클릭 = 큐' });

HELP_DB['app.viewNav'] = {
  en: { title: 'Zoom & scroll', summary: 'Pitch (Y), time (X) and proportional (X+Y) zoom. Fit All shows everything (F).', detail: 'On the canvas: the wheel scrolls the pitch axis, Shift + wheel (or a sideways swipe) scrolls time, Ctrl/⌘ + wheel (pinch) zooms both axes around the pointer. The same in every studio. View changes are never recorded in undo.', formula: '' },
  ko: { title: '줌과 스크롤', summary: '음고(Y)·시간(X)·비례(X+Y) 줌입니다. 전체 맞춤(F)은 모두 보이게 합니다.', detail: '캔버스 위에서: 휠은 음고 축 스크롤, Shift+휠(또는 가로 스와이프)은 시간 스크롤, Ctrl/⌘+휠(핀치)은 포인터를 중심으로 두 축을 함께 줌합니다. 모든 스튜디오에서 같습니다. 보기 변경은 실행 취소에 기록되지 않습니다.', formula: '' },
};
// The Glissando toolbar shares the same text (its old entry described a different wheel behaviour).
// 글리산도 툴바도 같은 설명을 사용 (예전 항목은 실제와 다른 휠 동작을 설명했음).
HELP_DB['gliss.zoom'] = HELP_DB['app.viewNav'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const DEFAULT_VIEW_LIMITS = Object.freeze({
  tLo: 0, // earliest visible time / 가장 이른 시각
  tHi: Infinity, // latest visible time / 가장 늦은 시각
  minTimeSpan: 0.25,
  maxTimeSpan: 600,
  pLo: 0,
  pHi: 127,
  minPitchSpan: 3,
  maxPitchSpan: 127,
});

const lim = (limits) => ({ ...DEFAULT_VIEW_LIMITS, ...(limits || {}) });

/** Zoom the time axis by `factor` (< 1 = in) around `anchor` seconds (default: centre). / 시간 줌 */
export function zoomViewTime(vw, factor, anchor = null, limits = null) {
  const L = lim(limits);
  const old = Math.max(1e-6, vw.tMax - vw.tMin);
  const c = anchor ?? 0.5 * (vw.tMin + vw.tMax);
  const span = clamp(old * factor, L.minTimeSpan, Math.min(L.maxTimeSpan, Number.isFinite(L.tHi) ? Math.max(L.minTimeSpan, L.tHi - L.tLo) : L.maxTimeSpan));
  let lo = c - (c - vw.tMin) * (span / old);
  lo = Math.max(L.tLo, lo);
  if (Number.isFinite(L.tHi)) lo = Math.min(lo, Math.max(L.tLo, L.tHi - span));
  vw.tMin = lo;
  vw.tMax = lo + span;
}

/** Zoom the pitch axis by `factor` around `anchor` MIDI (default: centre). / 음고 줌 */
export function zoomViewPitch(vw, factor, anchor = null, limits = null) {
  const L = lim(limits);
  const old = Math.max(1e-6, vw.midiMax - vw.midiMin);
  const c = anchor ?? 0.5 * (vw.midiMin + vw.midiMax);
  const span = clamp(old * factor, L.minPitchSpan, Math.min(L.maxPitchSpan, L.pHi - L.pLo));
  let lo = c - (c - vw.midiMin) * (span / old);
  lo = clamp(lo, L.pLo, L.pHi - span);
  vw.midiMin = lo;
  vw.midiMax = lo + span;
}

/** Scroll the time axis by `dSec`. / 시간 스크롤 */
export function panViewTime(vw, dSec, limits = null) {
  const L = lim(limits);
  const span = vw.tMax - vw.tMin;
  let lo = Math.max(L.tLo, vw.tMin + dSec);
  if (Number.isFinite(L.tHi)) lo = Math.min(lo, Math.max(L.tLo, L.tHi - span));
  vw.tMin = lo;
  vw.tMax = lo + span;
}

/** Scroll the pitch axis by `dMidi`. / 음고 스크롤 */
export function panViewPitch(vw, dMidi, limits = null) {
  const L = lim(limits);
  const span = vw.midiMax - vw.midiMin;
  const lo = clamp(vw.midiMin + dMidi, L.pLo, Math.max(L.pLo, L.pHi - span));
  vw.midiMin = lo;
  vw.midiMax = lo + span;
}

/**
 * Apply a wheel event to a view (the caller has already called preventDefault and decides how the
 * change is stored). `m` supplies the plot size and the pointer → value maps.
 * 휠 이벤트를 뷰에 적용 (preventDefault와 저장 방식은 호출자 담당).
 * @param {WheelEvent} e
 * @param {{tMin:number,tMax:number,midiMin?:number,midiMax?:number}} vw
 * @param {{ plotW:number, plotH:number, xToTime:(px:number)=>number, yToMidi?:(py:number)=>number }} m
 * @param {{x:number,y:number}} p pointer in canvas pixels
 * @param {object} [limits] see DEFAULT_VIEW_LIMITS; `pitch: false` for a canvas without a pitch axis
 */
export function wheelNavigate(e, vw, m, p, limits = null) {
  const hasPitch = limits?.pitch !== false && typeof m.yToMidi === 'function' && Number.isFinite(vw.midiMin);
  const dy = e.deltaY;
  if (e.ctrlKey || e.metaKey) {
    const f = dy > 0 ? 1.12 : 1 / 1.12;
    zoomViewTime(vw, f, m.xToTime(p.x), limits);
    if (hasPitch) zoomViewPitch(vw, f, m.yToMidi(p.y), limits);
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(dy) || !hasPitch) {
    panViewTime(vw, ((e.deltaX || dy) / Math.max(1, m.plotW)) * (vw.tMax - vw.tMin), limits);
  } else {
    panViewPitch(vw, -(dy / Math.max(1, m.plotH)) * (vw.midiMax - vw.midiMin), limits);
  }
}

const BOX = 'flex items-center rounded-lg bg-slate-950 border border-slate-800 px-1.5 py-0.5 gap-1';
const SQ = 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 font-bold leading-none transition text-slate-200';

/**
 * The zoom toolbar (same look and order as the Glissando editor): Pitch − +, Time − +, X+Y − +, Fit All.
 * Handlers get a factor (1.25 = out, 0.8 = in). Leave `onPitch` out for a canvas without a pitch axis.
 * 줌 툴바 (글리산도 에디터와 같은 모양·순서). 핸들러는 배율을 받음 (1.25 = 축소, 0.8 = 확대).
 * @param {{ onPitch?: (f:number)=>void, onTime?: (f:number)=>void, onBoth?: (f:number)=>void, onFit?: ()=>void }} h
 */
export function createZoomBar(h) {
  const group = (labelKey, color, fn) => el('div', { class: BOX, dataset: { help: 'app.viewNav' } }, [
    el('span', { class: `text-[10px] font-semibold ${color}`, text: t(labelKey) }),
    el('button', { class: SQ, text: '−', title: `${t(labelKey)} −`, on: { click: () => fn(1.25) } }),
    el('button', { class: SQ, text: '+', title: `${t(labelKey)} +`, on: { click: () => fn(0.8) } }),
  ]);
  return el('div', { class: 'flex flex-wrap items-center gap-1.5 text-xs' }, [
    h.onPitch ? group('zoom.pitch', 'text-sky-400', h.onPitch) : null,
    h.onTime ? group('zoom.time', 'text-emerald-400', h.onTime) : null,
    h.onBoth ? group('zoom.both', 'text-violet-400', h.onBoth) : null,
    h.onFit ? el('button', { class: 'px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 font-semibold transition', text: t('zoom.fit'), title: 'F', dataset: { help: 'app.viewNav' }, on: { click: () => h.onFit() } }) : null,
  ]);
}
