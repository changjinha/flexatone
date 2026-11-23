/**
 * ui/studio-controls.js
 * Shared control builders for the studio racks: labelled slider + number box, toggle button,
 * select, segmented buttons, labelled row. One implementation, so the controls look and behave the same in
 * every studio (one drag = one undo step, values not overwritten while being edited).
 * 스튜디오 랙 공용 컨트롤 (슬라이더 + 숫자, 토글, 선택, 라벨 행). 모든 스튜디오가 같은 구현을 사용.
 */

import { clamp, roundTo } from '../core/math-utils.js';
import { t } from '../core/i18n.js';
import { el, setToggle, num } from './panels.js';
import { setSliderDefault, probeStudioDefault } from './slider-reset.js';

/** Neutral rack button. / 랙 기본 버튼 */
export const STUDIO_BTN = 'px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 transition';
export const STUDIO_SELECT = 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200';
const SEG_BTN = 'px-2 py-0.5 rounded text-[11px]';

// Colour rules (the same in every studio) / 색 규칙 (모든 스튜디오 공통)
//   slider   — the app accent (sky) unless a slider names its own accent to mark a group
//   select   — slate-200 text
//   segment  — the chosen button is sky unless the call names a colour that carries a meaning
//   슬라이더 = 앱 강조색(하늘), 선택 상자 = slate-200, 세그먼트 = 하늘 (의미가 있을 때만 다른 색 지정)

/**
 * @param {object} o
 * @param {(fn: () => void) => void} o.push   registers a "sync from the document" callback / 동기화 콜백 등록
 * @param {() => void} o.commit               closes the undo gesture / 실행 취소 제스처 종료
 * @param {(label: string, help: string, opts: object) => string} o.keyOf  coalesce key of a slider / 슬라이더 병합 키
 * @param {string} [o.accent]        default range accent class / 기본 슬라이더 색
 * @param {string} [o.selectClass]
 * @param {boolean} [o.narrow]       controls may shrink inside narrow cards / 좁은 카드에서 줄어듦
 * @param {(get: () => number) => number|null} [o.probe] value of a slider's getter on the default document
 *   (double-click → default, ui/slider-reset.js); a studio whose getters read a local copy of its document
 *   passes its own. Default: probeStudioDefault. / 기본 문서에서의 값 (더블클릭 → 기본값)
 */
export function createStudioControls({ push, commit, keyOf, accent: defaultAccent = '', selectClass = STUDIO_SELECT, narrow = false, probe = probeStudioDefault }) {
  /**
   * Labelled slider + number box bound to a getter / editor. `set(value, coalesceKey)`.
   * opts: min, max, step, unit, accent, raw (label is text, not an i18n key), integer, compact,
   * def (default value for double-click; otherwise read from the default document).
   * 슬라이더 + 숫자 입력.
   */
  function slider(label, help, get, set, opts) {
    const { min, max, step, unit = '', accent = defaultAccent, raw = false, integer = false, compact = false, def } = opts;
    const number = el('input', { type: 'number', min, max, step, class: `w-16${narrow ? ' shrink-0' : ''} px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200` });
    const range = el('input', { type: 'range', min, max, step, class: `w-full${narrow ? ' min-w-0' : ''} ${accent}` });
    setSliderDefault(range, def !== undefined ? def : () => probe(get));
    const ckey = keyOf(label, help, opts);
    const fix = (v) => (integer ? Math.round(v) : v);
    range.addEventListener('input', () => { number.value = range.value; set(fix(Number(range.value)), ckey); });
    range.addEventListener('change', commit);
    number.addEventListener('input', () => { if (number.dataset.scrubbing) set(fix(clamp(num(number.value, get()), min, max)), ckey); });
    number.addEventListener('change', () => { set(fix(clamp(num(number.value, get()), min, max)), number.dataset.scrubbing ? ckey : null); commit(); });
    push(() => {
      const v = get();
      if (document.activeElement !== range) range.value = String(v);
      if (document.activeElement !== number) number.value = String(roundTo(v, 4));
    });
    const caption = el('span', { class: 'text-[11px] text-slate-300 truncate', text: `${raw ? label : t(label)}${unit ? ` (${unit})` : ''}` });
    const box = `flex flex-col gap-0.5${narrow ? ' min-w-0' : ''}`;
    // compact: label on its own line, then range + number (narrow cards) / 좁은 카드용 배치
    if (compact) return el('div', { class: box, dataset: { help } }, [caption, el('div', { class: 'flex items-center gap-1.5' }, [range, number])]);
    return el('div', { class: box, dataset: { help } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [caption, number]),
      range,
    ]);
  }

  /** Toggle button that follows `get()`. / 토글 버튼 */
  function toggle(labelKey, help, get, onClick) {
    const b = el('button', { class: `fx-toggle ${STUDIO_BTN}`, text: t(labelKey), dataset: { help }, on: { click: onClick } });
    push(() => setToggle(b, get()));
    return b;
  }

  /** Select; options: [value, label text]. / 선택 상자 */
  function select(help, options, get, set) {
    const s = el('select', { class: selectClass, dataset: { help }, on: { change: (e) => { set(e.target.value); commit(); } } },
      options.map(([value, label]) => el('option', { value, text: label })));
    s.addEventListener('keydown', (e) => e.stopPropagation()); // keys typed in a select never reach the app shortcuts / 선택 상자의 키 입력은 앱 단축키로 가지 않음
    push(() => { if (document.activeElement !== s) s.value = String(get()); });
    return s;
  }

  /**
   * Segmented buttons (one of several). options: [value, label text, help key?]; the row wraps
   * in a narrow card. `color` = Tailwind colour name of the chosen button.
   * 세그먼트 버튼 (여러 개 중 하나). 좁은 카드에서는 줄바꿈.
   */
  function segment(help, options, get, set, color = 'sky') {
    return el('div', { class: 'flex flex-wrap gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5', dataset: help ? { help } : undefined }, options.map(([value, label, itemHelp]) => {
      const h = itemHelp || help;
      const b = el('button', { class: SEG_BTN, text: label, dataset: h ? { help: h } : undefined, on: { click: () => { set(value); commit(); } } });
      push(() => { b.className = `${SEG_BTN} ${get() === value ? `bg-${color || 'sky'}-600 text-white font-semibold` : 'text-slate-400 hover:text-white'}`; });
      return b;
    }));
  }

  /** Label on the left, control on the right. / 왼쪽 라벨, 오른쪽 컨트롤 */
  const labelled = (labelKey, control, help) => el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', dataset: { help } }, [t(labelKey), control]);

  return { slider, toggle, select, segment, labelled };
}
