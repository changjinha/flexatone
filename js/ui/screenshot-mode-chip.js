/**
 * Flexatone — ui/screenshot-mode-chip.js
 * Layer 4 (ui): a small chip next to the header 📸 Screenshot button that sets the screenshot mode in every
 * studio — Full → Axes + lines (PNG) → Axes + lines (SVG). The Version gallery of the Glissando editor shows
 * the same preference (appState.screenshotMode / screenshotSvg).
 * 계층 4 (ui): 📸 옆의 작은 칩 — 모든 스튜디오에서 스크린샷 모드 전환 (전체 → 축+선 PNG → 축+선 SVG).
 */

import { t, I18N } from '../core/i18n.js';
import { appState, dispatch, subscribe } from '../core/state.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'shotchip.full': 'Full',
  'shotchip.clean': 'Axes+lines',
  'shotchip.svg': 'Axes+lines SVG',
  'shotchip.tip': 'Screenshot mode (click to change): Full = the window as shown · Axes + lines = the pitch lines on white axes · SVG = the same as a vector file',
});
Object.assign(I18N.ko, {
  'shotchip.full': '전체',
  'shotchip.clean': '축+선',
  'shotchip.svg': '축+선 SVG',
  'shotchip.tip': '스크린샷 모드 (클릭해서 변경): 전체 = 보이는 그대로 · 축 + 선 = 흰 축 위의 음고 선 · SVG = 같은 내용을 벡터 파일로',
});
HELP_DB['app.shotMode'] = {
  en: { title: 'Screenshot mode', summary: 'Full saves the window as shown. Axes + lines draws the studio\'s pitch lines on white axes (time in s, pitch as note names) — in every studio that has pitch lines; SVG saves that as a vector file.', detail: 'Risset has no pitch lines, so it always saves the full window. In the Glissando editor each screenshot also stores a Version.', formula: '' },
  ko: { title: '스크린샷 모드', summary: '전체는 창을 보이는 그대로 저장합니다. 축 + 선은 그 스튜디오의 음고 선을 흰 축(시간 초, 음고 음이름) 위에 그립니다 — 음고 선이 있는 모든 스튜디오에서. SVG는 그것을 벡터 파일로 저장합니다.', detail: '리세는 음고 선이 없어 항상 전체 창을 저장합니다. 글리산도 에디터에서는 스크린샷마다 Version도 저장됩니다.', formula: '' },
};

const state = () => (appState.screenshotMode !== 'clean' ? 'full' : appState.screenshotSvg ? 'svg' : 'clean');

export function initScreenshotModeChip() {
  const anchor = document.getElementById('btnScreenshot');
  if (!anchor || document.getElementById('btnShotModeChip')) return;
  const chip = el('button', {
    id: 'btnShotModeChip',
    class: 'px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-800 hover:bg-slate-800 text-[11px] text-violet-200 transition',
    dataset: { help: 'app.shotMode' },
    on: {
      click: () => {
        const next = { full: 'clean', clean: 'svg', svg: 'full' }[state()];
        dispatch({ type: 'pref/screenshot', scope: ['versions'], mutate: (s) => { s.screenshotMode = next === 'full' ? 'full' : 'clean'; s.screenshotSvg = next === 'svg'; } });
      },
    },
  });
  anchor.after(chip);
  const sync = () => { chip.textContent = t(`shotchip.${state()}`); chip.title = t('shotchip.tip'); };
  subscribe((e) => { if (e.scope.has('versions') || e.scope.has('all') || e.scope.has('lang')) sync(); });
  sync();
}
