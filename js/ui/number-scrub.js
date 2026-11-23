/**
 * Flexatone — ui/number-scrub.js
 * Layer 4 (ui): global helper for every <input type="number"> — type directly, or press and
 * drag up/down to change the value in `step` increments (Glissando, Field, Risset …).
 * 계층 4 (ui): 모든 숫자 입력란 — 직접 타이핑 또는 누른 채 상하 드래그로 step 단위 증감.
 *
 *   drag up = increase · 4 px per step · Shift ×10 · Ctrl/⌘ ×0.1
 *   A click without movement just focuses the box for typing.
 *   While dragging the input carries data-scrubbing="1" and receives `input` events; a single
 *   `change` fires on release (so one drag = one undo step).
 *   드래그 중 input 이벤트, 놓을 때 change 1회 (드래그 1회 = 실행 취소 1단계).
 * Opt out with data-no-scrub. Works for inputs created later (event delegation).
 */

const PX_PER_STEP = 4;
const THRESHOLD = 3;

let active = null; // { input, y0, v0, step, moved, pointerId }

function stepOf(input) {
  const s = Number(input.step);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

function decimals(step) {
  const str = String(step);
  return str.includes('e-') ? Number(str.split('e-')[1]) : (str.split('.')[1] || '').length;
}

function clampToInput(input, v) {
  const min = input.min === '' ? -Infinity : Number(input.min);
  const max = input.max === '' ? Infinity : Number(input.max);
  return Math.min(Number.isFinite(max) ? max : Infinity, Math.max(Number.isFinite(min) ? min : -Infinity, v));
}

function onDown(e) {
  const input = e.target;
  if (e.button !== 0 || e.altKey || !(input instanceof HTMLInputElement) || input.type !== 'number') return;
  if (input.disabled || input.readOnly || input.dataset.noScrub !== undefined) return;
  // Leave the native spinner arrows alone (right ~16 px). / 네이티브 스피너 영역은 제외
  const r = input.getBoundingClientRect();
  if (e.clientX > r.right - 16) return;
  const v0 = Number(input.value);
  active = { input, y0: e.clientY, v0: Number.isFinite(v0) ? v0 : 0, step: stepOf(input), moved: false, pointerId: e.pointerId };
}

function onMove(e) {
  if (!active || e.pointerId !== active.pointerId) return;
  const dy = active.y0 - e.clientY;
  if (!active.moved) {
    if (Math.abs(dy) < THRESHOLD) return;
    active.moved = true;
    active.input.blur();
    active.input.dataset.scrubbing = '1';
    document.body.style.cursor = 'ns-resize';
    try { active.input.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  e.preventDefault();
  const mult = e.shiftKey ? 10 : e.ctrlKey || e.metaKey ? 0.1 : 1;
  const step = active.step * mult;
  const raw = active.v0 + Math.round(dy / PX_PER_STEP) * step;
  const next = clampToInput(active.input, Number(raw.toFixed(Math.min(10, decimals(step) + 1))));
  const str = String(next);
  if (active.input.value !== str) {
    active.input.value = str;
    active.input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function onUp(e) {
  if (!active || (e.pointerId !== undefined && e.pointerId !== active.pointerId)) return;
  const { input, moved } = active;
  active = null;
  if (!moved) return; // plain click → typing / 단순 클릭은 타이핑
  delete input.dataset.scrubbing;
  document.body.style.cursor = '';
  try { input.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

let installed = false;

/** Install the delegated listeners once. / 위임 리스너 1회 설치 */
export function initNumberScrub() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  const style = document.createElement('style');
  style.textContent = 'input[type="number"]:not([data-no-scrub]):not(:focus){cursor:ns-resize}';
  document.head.append(style);
}

/** True while a number box is being dragged. */
export function isScrubbing() {
  return !!active?.moved;
}
