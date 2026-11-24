/**
 * Flexatone — ui/line-mix-rack.js
 * Layer 4 (ui): the **Lines** rack — S / M / gain per generated line in Chaos, Fractal and Wave (ridge mode), the
 * same controls as the voice lists of the other studios (ui/voice-gain.js). Data: core/line-mix.js.
 * 계층 4 (ui): 선 랙 — 카오스·프랙탈·웨이브(리지)의 선별 S / M / 게인. 다른 스튜디오 보이스 목록과 같은 컨트롤.
 */

import { t, I18N } from '../core/i18n.js';
import { endHistoryGesture } from '../core/state.js';
import { lineMixOf, lineMixAnySolo, lineMixGain, patchLineMix, LINE_GAIN_MAX } from '../core/line-mix.js';
import { listSourceLines, MEAN_LINE } from '../studios/trajectory-link.js';
import { voiceGainControl } from './voice-gain.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'lmix.title': 'Lines — S / M / gain',
  'lmix.solo': 'Solo this line (only soloed lines sound)',
  'lmix.mute': 'Mute this line',
  'lmix.none': 'No lines to list (Wave: switch Sonify to Ridge).',
  'lmix.more': (n) => `+ ${n} more lines (first 48 listed)`,
  'lmix.reset': 'Clear S / M / gain',
});
Object.assign(I18N.ko, {
  'lmix.title': '선 — S / M / 게인',
  'lmix.solo': '이 선 솔로 (솔로된 선만 소리남)',
  'lmix.mute': '이 선 뮤트',
  'lmix.none': '나열할 선이 없습니다 (웨이브: 소리화를 리지로).',
  'lmix.more': (n) => `+ ${n}개 더 (처음 48개만 표시)`,
  'lmix.reset': 'S / M / 게인 초기화',
});
HELP_DB['app.lineMix'] = {
  en: { title: 'Lines: solo / mute / gain', summary: 'Every line this studio makes (Chaos voices, Fractal voices, Wave ridges) can be soloed, muted or turned down, like the voices of the other studios.', detail: 'S = only soloed lines sound; M = this line is silent; the slider is its gain (0 … 1.5). It is saved with the document, so playback, WAV and the Manager hear the same thing. Lines are found by their number: when an edit changes how many lines there are (more voices, other ridges), the settings stay with the numbers.', formula: '' },
  ko: { title: '선: 솔로 / 뮤트 / 게인', summary: '이 스튜디오가 만드는 선(카오스 보이스, 프랙탈 보이스, 웨이브 리지)마다 다른 스튜디오의 보이스처럼 솔로·뮤트·게인을 줄 수 있습니다.', detail: 'S = 솔로된 선만 소리남, M = 이 선은 무음, 슬라이더 = 게인 (0 … 1.5). 문서에 저장되므로 재생·WAV·매니저가 같은 소리를 냅니다. 선은 번호로 찾습니다: 편집으로 선의 수가 바뀌면(보이스 수, 다른 리지) 설정은 번호를 따라갑니다.', formula: '' },
};

const MAX_ROWS = 48;
const SM = 'px-1.5 py-0.5 rounded border text-[10px] font-bold';

/**
 * @param {{ studio: string, get: () => object, edit: (fn: (d: object) => void, opts?: object) => void, onChange?: () => void }} o
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createLineMixRack({ studio, get, edit, onChange = null }) {
  const list = el('div', { class: 'flex flex-col gap-1 max-h-[260px] overflow-auto pr-1' });
  const resetBtn = el('button', { class: 'text-[10px] text-slate-400 hover:text-white', text: `↺ ${t('lmix.reset')}`, on: { click: () => { edit((d) => { d.lineMix = {}; }); onChange?.(); } } });
  const root = el('section', { class: 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2', dataset: { help: 'app.lineMix', rack: `lineMix.${studio}` } }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('lmix.title') }),
      resetBtn,
    ]),
    list,
  ]);
  let rowSync = [];
  let shape = '';
  const set = (key, patch, coalesceKey = null) => { edit((d) => { d.lineMix = patchLineMix(d.lineMix, key, patch); }, { coalesceKey }); onChange?.(); };

  function rebuild(lines) {
    rowSync = [];
    list.replaceChildren();
    if (!lines.length) { list.append(el('p', { class: 'text-[11px] text-slate-500', text: t('lmix.none') })); return; }
    for (const ln of lines.slice(0, MAX_ROWS)) {
      const key = String(ln.key);
      const btn = (kind, label, onCls) => {
        const b = el('button', { class: SM, text: label, title: t(`lmix.${kind}`), on: { click: () => set(key, { [kind]: !lineMixOf(get(), key)[kind] }) } });
        rowSync.push(() => {
          const on = lineMixOf(get(), key)[kind];
          b.className = `${SM} ${on ? onCls : 'border-slate-700 text-slate-400 hover:text-white'}`;
        });
        return b;
      };
      const name = el('span', { class: 'flex-1 truncate text-[11px]', text: ln.name || key });
      const dot = el('span', { class: 'w-2 h-2 rounded-full shrink-0', style: `background:${ln.color || '#94a3b8'}` });
      const gain = voiceGainControl({
        get: () => lineMixOf(get(), key).gain,
        set: (v, ck) => set(key, { gain: v }, `${ck}:${studio}:${key}`),
        commit: () => endHistoryGesture(),
        push: (fn) => rowSync.push(fn),
        def: 1,
        max: LINE_GAIN_MAX,
      });
      const row = el('div', { class: 'flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-950/60' }, [
        dot, name,
        btn('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'),
        btn('mute', 'M', 'bg-rose-600 text-white border-rose-500'),
        gain,
      ]);
      rowSync.push(() => { row.style.opacity = lineMixGain(get(), key) > 0 ? '1' : '0.45'; });
      list.append(row);
    }
    if (lines.length > MAX_ROWS) list.append(el('p', { class: 'text-[10px] text-slate-500', text: t('lmix.more', lines.length - MAX_ROWS) }));
  }

  function sync() {
    let lines = [];
    try { lines = listSourceLines(studio).filter((l) => l.key !== MEAN_LINE); } catch { lines = []; }
    const s = lines.map((l) => `${l.key}:${l.name}`).join('|');
    if (s !== shape) { shape = s; rebuild(lines); }
    resetBtn.classList.toggle('hidden', !Object.keys(get()?.lineMix || {}).length && !lineMixAnySolo(get()));
    for (const fn of rowSync) fn();
  }
  sync();
  return { root, sync };
}
