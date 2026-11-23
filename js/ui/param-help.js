/**
 * Flexatone — ui/param-help.js
 * Layer 4 (ui): resolves "what exactly is this parameter?" for any labelled control in any studio.
 * 계층 4 (ui): 모든 스튜디오의 라벨 달린 컨트롤에 대해 "이 파라미터가 정확히 무엇인가"를 찾아 줌.
 *
 * No studio panel needs to change: the label's on-screen text is mapped back to its i18n key
 * (every studio merges its strings into core I18N), then looked up in this order:
 *   1. PARAM_HELP["<helpKey>><labelKey>"], PARAM_HELP[labelKey], PARAM_HELP["<helpKey>><text>"]
 *                                                 — one-parameter description (param-help-entries.js)
 *   2. the nearest data-help entry (HELP_DB), when that block holds only this one parameter
 *   3. the nearest data-help entry of a group block — its summary, marked as the group's
 * 패널 수정 없이: 화면 라벨 텍스트 → i18n 키 → (1) 파라미터 전용 설명 → (2) 이 파라미터만 감싼
 * data-help 항목 → (3) 그룹 data-help 항목 요약 순으로 찾음.
 */

import { I18N, getLang } from '../core/i18n.js';
import { getHelp, ownHelpKey } from './option-inspector.js';
import { PARAM_HELP } from './param-help-entries.js';

export const CONTROL_SEL = 'input[type="range"], input[type="number"], input[type="checkbox"], select';
const MAX_LABEL = 60;
const UP_LEVELS = 4;

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const isNumberish = (s) => /^[-+−±]?[\d.,]*\s*(%|°|¢|s|ms|Hz|dB|st|×)?$/.test(s);

// --------------------------------------------------------------------------
// Label text → i18n key (rebuilt when the dictionary size changes, per language)
// 라벨 텍스트 → i18n 키 역색인
// --------------------------------------------------------------------------
const reverse = { lang: '', size: 0, map: new Map() };

function reverseIndex() {
  const lang = getLang();
  const dict = I18N[lang] || I18N.en;
  const size = Object.keys(dict).length;
  if (reverse.lang === lang && reverse.size === size) return reverse.map;
  const map = new Map();
  const add = (d) => {
    for (const [k, v] of Object.entries(d || {})) {
      if (typeof v !== 'string') continue;
      const n = norm(v);
      if (!n || n.length > MAX_LABEL) continue;
      // Prefer a key that has its own description. / 설명이 있는 키 우선
      if (!map.has(n) || (PARAM_HELP[k] && !PARAM_HELP[map.get(n)])) map.set(n, k);
    }
  };
  add(dict);
  if (lang !== 'en') { // English labels left untranslated still resolve / 미번역 영어 라벨도 해석
    for (const [k, v] of Object.entries(I18N.en)) {
      if (typeof v === 'string' && !map.has(norm(v)) && norm(v).length <= MAX_LABEL) map.set(norm(v), k);
    }
  }
  Object.assign(reverse, { lang, size, map });
  return map;
}

/** i18n key for an on-screen label, tolerating a trailing "(unit)" / ":" . / 단위 괄호 허용 */
export function keyForLabel(text) {
  const map = reverseIndex();
  let s = norm(text).replace(/[:：]$/, '');
  for (let i = 0; i < 3 && s; i++) {
    const k = map.get(s);
    if (k) return k;
    const cut = s.replace(/\s*\([^()]*\)\s*$/, '');
    if (cut === s) break;
    s = cut;
  }
  return null;
}

// --------------------------------------------------------------------------
// DOM: control ⇄ label element / 컨트롤 ⇄ 라벨 요소
// --------------------------------------------------------------------------
const SKIP_TAGS = /^(INPUT|SELECT|OPTION|TEXTAREA|BUTTON|CANVAS|SVG)$/i;

function ownText(el) {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
  return norm(s);
}

/** Text of a <label>, without the text of the controls/options inside it. */
function labelElementText(label) {
  let s = '';
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) s += ` ${n.textContent}`;
      else if (n.nodeType === 1 && !SKIP_TAGS.test(n.tagName)) walk(n);
    }
  };
  walk(label);
  return norm(s);
}

/** A label sits just above or on the same line as its control. / 라벨은 컨트롤 바로 위나 같은 줄 */
function isNear(labelEl, ctrl) {
  const a = labelEl.getBoundingClientRect();
  const b = ctrl.getBoundingClientRect();
  const dy = Math.max(0, b.top - a.bottom, a.top - b.bottom);
  const dx = Math.max(0, b.left - a.right, a.left - b.right);
  if (dy <= 8 && Math.abs((a.top + a.bottom) - (b.top + b.bottom)) < 24) return true; // same line, any distance / 같은 줄
  return dy <= 36 && dx <= 260;
}

/** The element that names a control, plus its text. / 컨트롤의 이름표 요소와 텍스트 */
export function labelOfControl(ctrl) {
  if (!ctrl) return null;
  const lab = ctrl.closest('label') || (ctrl.id && document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`));
  if (lab) {
    // Prefer an inner text element so the hover target is the words themselves.
    const inner = [...lab.querySelectorAll('span, b, div')].find((e) => !e.contains(ctrl) && ownText(e) && !isNumberish(ownText(e)));
    const text = inner ? ownText(inner) : labelElementText(lab);
    if (text && text.length <= MAX_LABEL && !isNumberish(text)) return { el: inner || lab, text };
  }
  const aria = ctrl.getAttribute('aria-label');
  let cur = ctrl;
  for (let i = 0; i < UP_LEVELS && cur.parentElement; i++) {
    cur = cur.parentElement;
    const walker = document.createTreeWalker(cur, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === ctrl || n.contains(ctrl)) break;
      if (SKIP_TAGS.test(n.tagName) || n.closest('select, button')) continue;
      const tx = ownText(n);
      if (tx && tx.length <= MAX_LABEL && !isNumberish(tx) && isNear(n, ctrl)) return { el: n, text: tx };
    }
    if (cur.querySelectorAll(CONTROL_SEL).length > 2) break; // left the row / 행을 벗어남
  }
  return aria ? { el: ctrl, text: norm(aria) } : null;
}

/** If `el` is the label of a nearby control, return that control. / 라벨이면 그 컨트롤 */
export function controlOfLabel(el) {
  const tx = ownText(el) || (el.tagName === 'LABEL' ? labelElementText(el) : '');
  if (!tx || tx.length > MAX_LABEL || isNumberish(tx)) return null;
  let cur = el;
  for (let i = 0; i < UP_LEVELS && cur.parentElement; i++) {
    cur = cur.parentElement;
    for (const c of cur.querySelectorAll(CONTROL_SEL)) {
      if (!c.offsetParent || managerFieldHelp(c)) continue; // a track name is not a parameter label
      if (labelOfControl(c)?.el === el) return c;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Resolution / 해석
// --------------------------------------------------------------------------
function nearestHelp(node) {
  let cur = node;
  while (cur && cur !== document.body) {
    const k = ownHelpKey(cur);
    if (k) return { key: k, el: cur };
    cur = cur.parentElement;
  }
  return null;
}

/** Is this help key used by just one named parameter anywhere on screen? / 이 키를 쓰는 파라미터가 하나뿐인가 */
function isSingleParamKey(key, ctrl) {
  const own = labelOfControl(ctrl)?.text;
  const blocks = [...document.querySelectorAll(`[data-help="${CSS.escape(key)}"]`)];
  for (const block of blocks) {
    for (const c of block.querySelectorAll(CONTROL_SEL)) {
      const l = labelOfControl(c)?.text;
      if (l && l !== own) return false;
    }
  }
  return true;
}

const pick = (entry) => (entry ? entry[getLang()] || entry.en : '');

/**
 * Describe the parameter a control belongs to.
 * @returns {{ title: string, text: string, key: string|null, helpKey: string|null, exact: boolean } | null}
 */
export function describeParam(ctrl) {
  const mgr = managerFieldHelp(ctrl);
  if (mgr) return mgr;
  const label = labelOfControl(ctrl);
  if (!label) return null;
  const key = keyForLabel(label.text);
  const help = nearestHelp(ctrl);
  const title = label.text;
  const entry = findEntry(key, label.text, help?.key);
  if (entry) return { title, text: pick(entry), key, helpKey: help?.key || null, exact: true };
  if (help) {
    const h = getHelp(help.key);
    if (h) {
      const single = help.key === key || isSingleParamKey(help.key, ctrl);
      return { title, text: single ? h.summary : `${h.title}: ${h.summary}`, key, helpKey: help.key, exact: single };
    }
  }
  return null;
}

/**
 * Manager track-header controls have no text label (the track name sits beside them), so they
 * are recognised by their data-field and explained by their Manager help entry.
 * 매니저 트랙 헤더 컨트롤은 텍스트 라벨이 없어 data-field로 알아보고 매니저 도움말로 설명.
 */
const MGR_FIELD_HELP = { gainDb: 'mgr.gain', rate: 'mgr.tempo', bpm: 'mgr.tempo', start: 'mgr.start' };

function managerFieldHelp(ctrl) {
  if (!ctrl.closest('[class*="mgr-"]')) return null;
  const field = ctrl.dataset.field || ctrl.dataset.tempoField || (ctrl.dataset.gainBox !== undefined ? 'gainDb' : '');
  const helpKey = MGR_FIELD_HELP[field];
  const h = helpKey && getHelp(helpKey);
  return h ? { title: h.title, text: h.summary, key: null, helpKey, exact: true } : null;
}

/** "d1 (vertical scale)" → "d#" : label text as a lookup key when it has no i18n key. */
const textKey = (text) => norm(text).replace(/\s*\([^()]*\)\s*$/, '').replace(/\d+/g, '#');

/**
 * PARAM_HELP lookup: "<helpKey>><labelKey>" (a generic label in a given block, e.g. "Start (s)"
 * inside Field timing) → "<labelKey>" → "<helpKey>><label text>" (symbols such as σ, y#).
 * 문맥 키 "<도움말 키>><라벨 키>" → 라벨 키 → "<도움말 키>><라벨 텍스트>" 순.
 */
function findEntry(key, text, helpKey) {
  if (helpKey && key && PARAM_HELP[`${helpKey}>${key}`]) return PARAM_HELP[`${helpKey}>${key}`];
  if (key && PARAM_HELP[key]) return PARAM_HELP[key];
  if (helpKey && PARAM_HELP[`${helpKey}>${textKey(text)}`]) return PARAM_HELP[`${helpKey}>${textKey(text)}`];
  return null;
}

/** Hover target → { ctrl, anchor } when it is a parameter label or control. */
export function paramTargetOf(node) {
  if (!(node instanceof Element)) return null;
  const ctrl = node.closest(CONTROL_SEL);
  if (ctrl) return { ctrl, anchor: labelOfControl(ctrl)?.el && ctrl.type === 'checkbox' ? labelOfControl(ctrl).el : ctrl };
  const textEl = node.closest('span, label, div, b, p, h3, h4, legend');
  if (!textEl) return null;
  const c = controlOfLabel(textEl);
  return c ? { ctrl: c, anchor: textEl } : null;
}
