/**
 * Flexatone — ui/icon-tooltip.js
 * Layer 4 (ui): hover popup that names what a small icon button does, in every studio.
 * 계층 4 (ui): 작은 아이콘 버튼 위에 마우스를 올리면 기능 이름을 팝업으로 보여 줌 (모든 스튜디오 공용).
 *
 *   Target  = a <button> / [role=button] whose own visible text is at most 3 characters
 *             (−, +, ✕, ⟲, A, dB, an SVG …), or any element with `data-tip`.
 *             대상 = 보이는 글자가 3자 이하인 버튼(아이콘/기호), 또는 data-tip이 있는 요소.
 *   Label   = data-tip → title → aria-label (title is already translated by i18n), then a
 *             localized name for common symbols (✕ S M ▲ ▼), then the data-help entry's title.
 *             라벨 = data-tip → title → aria-label → 기호 이름(✕ S M ▲ ▼) → data-help 제목 순.
 *   The native title tooltip is suppressed while hovering (restored on leave), so only one shows.
 *   Parameters: hovering a parameter's label (or its slider / number / select / checkbox) shows
 *             what that parameter is — resolved by ui/param-help.js, in every studio.
 *             파라미터 라벨(또는 슬라이더·숫자·선택·체크박스)에 올리면 그 파라미터 설명을 표시.
 *   Hidden on pointer leave / press / wheel / scroll / key, and while Option(Alt) is held
 *   (the Option inspector owns that hover).
 */

import { getLang } from '../core/i18n.js';
import { getHelp, ownHelpKey } from './option-inspector.js';
import { paramTargetOf, describeParam } from './param-help.js';

/** Fallback names for symbol-only buttons that carry no label. / 라벨 없는 기호 버튼의 기본 이름 */
const SYMBOLS = {
  '✕': { en: 'Remove', ko: '삭제' },
  '×': { en: 'Remove', ko: '삭제' },
  S: { en: 'Solo', ko: '솔로' },
  M: { en: 'Mute', ko: '뮤트' },
  '▲': { en: 'Increase / move up', ko: '증가 / 위로' },
  '▼': { en: 'Decrease / move down', ko: '감소 / 아래로' },
};

const SHOW_DELAY = 280;
const PARAM_DELAY = 450; // parameter explanations are longer; wait a little more / 파라미터 설명은 조금 더 늦게
const MAX_TEXT = 3;
const GAP = 6;
const EDGE = 4;

let tip = null;
let current = null;
let timer = 0;

function visibleText(el) {
  return (el.textContent || '').replace(/\s+/g, '');
}

function isIconTarget(el) {
  if (el.hasAttribute('data-tip')) return true;
  return visibleText(el).length <= MAX_TEXT;
}

function fallbackLabel(el) {
  const sym = visibleText(el);
  const named = SYMBOLS[sym];
  if (named) return named[getLang()] || named.en;
  const help = getHelp(ownHelpKey(el))?.title;
  if (!help) return '';
  return sym === '−' || sym === '+' ? `${help} ${sym}` : help;
}

function labelOf(el) {
  return (el.getAttribute('data-tip') || el.getAttribute('title') || el.dataset.fxTipTitle
    || el.getAttribute('aria-label') || fallbackLabel(el) || '').trim();
}

/** Hover target → { el, delay, fill(box) } for an icon button or a parameter label/control. */
function findTarget(node) {
  if (!(node instanceof Element) || node.closest('#fxIconTip')) return null;
  const btn = node.closest('button, [role="button"], [data-tip]');
  if (btn) {
    if (!isIconTarget(btn) || !labelOf(btn)) return null;
    return { el: btn, delay: SHOW_DELAY, fill: (box) => { box.textContent = labelOf(btn); } };
  }
  const p = paramTargetOf(node);
  if (!p) return null;
  const d = describeParam(p.ctrl);
  if (!d?.text) return null;
  return {
    el: p.anchor,
    delay: PARAM_DELAY,
    fill: (box) => {
      const b = document.createElement('b');
      b.className = 'fx-icon-tip-title';
      b.textContent = d.title;
      const body = document.createElement('span');
      body.textContent = d.text;
      box.replaceChildren(b, body);
      if (d.helpKey) {
        const hint = document.createElement('span');
        hint.className = 'fx-icon-tip-hint';
        hint.textContent = getLang() === 'ko' ? '⌥ Option + 클릭: 자세한 설명' : '⌥ Option + click: full explanation';
        box.append(hint);
      }
    },
  };
}

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.id = 'fxIconTip';
  tip.className = 'fx-icon-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  return tip;
}

function stealTitle(el) {
  const title = el.getAttribute('title');
  if (title) {
    el.dataset.fxTipTitle = title;
    el.removeAttribute('title');
  }
}

function restoreTitle(el) {
  const saved = el.dataset.fxTipTitle;
  if (saved === undefined) return;
  delete el.dataset.fxTipTitle;
  if (!el.hasAttribute('title')) el.setAttribute('title', saved);
}

function place(target) {
  const el = target.el;
  const box = ensureTip();
  target.fill(box);
  box.classList.toggle('is-param', target.delay === PARAM_DELAY);
  box.classList.add('is-on');
  const r = el.getBoundingClientRect();
  const w = box.offsetWidth;
  const h = box.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let top = r.bottom + GAP;
  if (top + h > vh - EDGE) top = r.top - GAP - h; // flip above when there is no room below
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(Math.max(EDGE, top))}px`;
}

function hide() {
  clearTimeout(timer);
  timer = 0;
  tip?.classList.remove('is-on');
  if (current) restoreTitle(current);
  current = null;
}

function onOver(e) {
  if (e.buttons) return; // dragging a slider / 드래그 중
  const target = findTarget(e.target);
  const el = target?.el || null;
  if (el && el === current) return;
  hide();
  if (!target || e.altKey) return;
  current = el;
  stealTitle(el);
  timer = setTimeout(() => {
    timer = 0;
    if (current === el && el.isConnected) place(target);
  }, target.delay);
}

function onOut(e) {
  if (!current) return;
  if (e.relatedTarget && current.contains(e.relatedTarget)) return;
  hide();
}

export function initIconTooltip() {
  if (tip) return;
  ensureTip();
  document.addEventListener('pointerover', onOver, true);
  document.addEventListener('pointerout', onOut, true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  document.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
}
