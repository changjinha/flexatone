/**
 * Flexatone — ui/slider-reset.js
 * Layer 4 (ui): double-click any slider → its default value. One document-wide listener; the value is
 * set on the range input and an `input` + `change` event is fired, so every slider's own handlers apply
 * it exactly as a drag would (one undo step, linked number box updated).
 * 계층 4 (ui): 어떤 슬라이더든 더블클릭 → 기본값. 문서 전체에 리스너 하나. 값을 넣고 input + change 이벤트를
 * 보내므로 각 슬라이더의 처리기가 드래그와 똑같이 적용(실행 취소 1단계, 숫자 상자 동기화).
 *
 * Where a slider's default comes from / 기본값의 출처 (first that answers)
 *   1. setSliderDefault(range, valueOrFn) — registered by the builder (shared studio controls, Risset,
 *      Glissando racks, timbre editor …).
 *   2. data-default="…" on the element (HTML-string UIs such as the Manager).
 *   A slider with data-no-reset keeps its own double-click (the output fader).
 *
 * probeStudioDefault(get): the value `get()` returns when the studio's document is the default one —
 * the saved params are taken out of appState.studioParams for the call and put back right after, so a
 * builder does not need to know the path of its value. Nothing is dispatched; no listener runs.
 * probeStudioDefault(get): 스튜디오 문서가 기본값일 때 get()이 돌려주는 값 (저장된 파라미터를 잠시 빼고 호출 후 복원).
 */

import { appState } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { StudioRegistry } from '../studios/registry.js';

const defaults = new WeakMap(); // range input → number | () => number | null

/** Register the default of a range input (a number or a function returning one). / 기본값 등록 */
export function setSliderDefault(range, valueOrFn) {
  if (range && valueOrFn !== undefined && valueOrFn !== null) defaults.set(range, valueOrFn);
  return range;
}

/**
 * Run `fn` with the studio's document reset to its defaults (temporarily). / 기본 문서로 잠시 실행
 * @template T @param {() => T} fn @param {string} [studioId] @returns {T}
 */
export function withStudioDefaults(fn, studioId = StudioRegistry.resolveStudioId()) {
  const sp = appState.studioParams;
  if (!sp || !studioId) return fn();
  const had = Object.prototype.hasOwnProperty.call(sp, studioId);
  const saved = sp[studioId];
  delete sp[studioId];
  try {
    return fn();
  } finally {
    if (had) sp[studioId] = saved;
  }
}

/** Numeric value of `get()` on the default document, or null. / 기본 문서에서의 get() 값 */
export function probeStudioDefault(get, studioId) {
  try {
    const v = Number(withStudioDefaults(get, studioId));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function defaultOf(range) {
  let d = defaults.get(range);
  if (typeof d === 'function') {
    try { d = d(); } catch { d = null; }
  }
  if (d === undefined || d === null || d === '') d = range.dataset.default;
  const v = Number(d);
  return d === undefined || d === null || d === '' || !Number.isFinite(v) ? null : v;
}

/** Install the document-wide double-click handler (once). / 문서 전체 더블클릭 처리기 설치 */
let installed = false;
export function initSliderReset() {
  if (installed) return;
  installed = true;
  document.addEventListener('dblclick', (e) => {
    const range = e.target?.closest?.('input[type="range"]');
    if (!range || range.disabled || range.dataset.noReset !== undefined) return;
    const v = defaultOf(range);
    if (v === null) return;
    e.preventDefault();
    const min = Number(range.min);
    const max = Number(range.max);
    range.value = String(clamp(v, Number.isFinite(min) ? min : -Infinity, Number.isFinite(max) ? max : Infinity));
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    range.blur(); // a focused slider is not re-synced from the document / 포커스된 슬라이더는 동기화되지 않음
  });
}
