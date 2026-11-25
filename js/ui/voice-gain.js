/**
 * Flexatone — ui/voice-gain.js
 * Layer 4 (ui): the small gain control of one voice in a voice list (Glissando grapher, Field particles,
 * Draw strokes, Tempo voices, Space sources, Risset regions) — next to its S / M buttons.
 * 계층 4 (ui): 보이스 목록 카드의 작은 게인 컨트롤 (S / M 옆). 모든 스튜디오 공용.
 */

import { t, I18N } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';
import { setSliderDefault } from './slider-reset.js';

Object.assign(I18N.en, { 'vgain.label': 'Gain', 'vgain.tip': 'Gain of this voice (double-click = default)' });
Object.assign(I18N.ko, { 'vgain.label': '게인', 'vgain.tip': '이 보이스의 게인 (더블클릭 = 기본값)' });
HELP_DB['vgain'] = {
  en: { title: 'Voice gain', summary: 'Level of this one voice (0 … 1.5 × amplitude), the same value as its Base Gain.', detail: 'S solos the voice, M mutes it. Double-click the slider for the default. Every studio\'s voice list has this control.', formula: '' },
  ko: { title: '보이스 게인', summary: '이 보이스 하나의 레벨(진폭 0 … 1.5배), 기본 게인과 같은 값입니다.', detail: 'S = 솔로, M = 뮤트. 슬라이더 더블클릭 = 기본값. 모든 스튜디오의 보이스 목록에 같은 컨트롤이 있습니다.', formula: '' },
};

/**
 * @param {{ get: () => number, set: (v: number, coalesceKey: string|null) => void, commit: () => void,
 *           push: (fn: () => void) => void, def?: number, max?: number, key?: string }} o
 * @returns {HTMLElement}
 */
export function voiceGainControl({ get, set, commit, push, def = 0.8, max = 1.5, key = 'vgain' }) {
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = String(max);
  range.step = '0.01';
  range.className = 'w-16 accent-emerald-500';
  setSliderDefault(range, def);
  const val = document.createElement('span');
  val.className = 'w-8 text-right font-mono text-[10px] text-emerald-200 tabular-nums';
  const box = document.createElement('span');
  box.className = 'inline-flex items-center gap-1 text-[10px] text-slate-400';
  box.dataset.help = 'vgain';
  box.title = t('vgain.tip');
  box.append(t('vgain.label'), range, val);
  // a card click selects the voice; dragging the gain must not / 카드 클릭(선택)과 분리
  for (const ev of ['pointerdown', 'click']) box.addEventListener(ev, (e) => e.stopPropagation());
  // inside a draggable card (Glissando reorder) the slider must not start a card drag / 드래그 가능한 카드 안에서
  box.draggable = false;
  box.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
  range.addEventListener('input', () => { val.textContent = Number(range.value).toFixed(2); set(Number(range.value), key); });
  range.addEventListener('change', commit);
  push(() => {
    const v = Number(get()) || 0;
    if (document.activeElement !== range) range.value = String(v);
    val.textContent = v.toFixed(2);
  });
  return box;
}
