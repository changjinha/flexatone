/**
 * Flexatone — ui/shortcut-help.js
 * Layer 4 (ui): the keyboard shortcut list (the ⌨ button in the header, or the ? key). One window for
 * the whole app: keys that work everywhere, then mouse gestures, then the keys of single studios.
 * 계층 4 (ui): 단축키 목록 (헤더의 ⌨ 버튼 또는 ? 키). 앱 전체 공통 키, 마우스 동작, 스튜디오별 키 순.
 */

import { t, getLang, I18N } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';

Object.assign(I18N.en, { 'keys.button': 'Keys', 'keys.title': 'Keyboard shortcuts', 'keys.close': 'Close', 'keys.tip': 'Keyboard shortcuts (?)' });
Object.assign(I18N.ko, { 'keys.button': '단축키', 'keys.title': '단축키 목록', 'keys.close': '닫기', 'keys.tip': '단축키 목록 (?)' });
HELP_DB['app.keys'] = {
  en: { title: 'Keyboard shortcuts', summary: 'Opens the list of every keyboard shortcut and mouse gesture (also with the ? key).', detail: 'Shortcuts never fire while you type in a field.', formula: '' },
  ko: { title: '단축키 목록', summary: '모든 단축키와 마우스 동작 목록을 엽니다 (? 키로도).', detail: '입력란에 타이핑하는 동안에는 단축키가 동작하지 않습니다.', formula: '' },
};

/** [keys, English, Korean] per group. / 그룹별 [키, 영어, 한국어] */
const GROUPS = [
  ['Transport · 재생', [
    ['Space', 'Play ⇄ stop (back to the cue). While the Manager is open: the Manager cycle', '재생 ⇄ 정지 (큐로 복귀). 매니저가 열려 있으면 매니저 사이클'],
    ['Enter', 'Pause and pin the playhead / resume', '일시정지·플레이헤드 고정 / 재개'],
    ['L', 'Loop on / off', '반복 켜기 / 끄기'],
    ['Esc', 'Stop everything (studio + every Manager track), clear the point selection', '전체 정지 (스튜디오 + 매니저 모든 트랙), 점 선택 해제'],
  ]],
  ['Edit · 편집', [
    ['Ctrl/⌘ + Z', 'Undo', '실행 취소'],
    ['Ctrl/⌘ + Shift + Z · Ctrl/⌘ + Y', 'Redo', '다시 실행'],
    ['Delete · Backspace', 'Delete what is selected (point, region, object of the studio on screen)', '선택한 것 삭제 (점, 구간, 화면 스튜디오의 대상)'],
    ['← → ↑ ↓', 'Nudge the selected point / handle / Locate end / voice (Glissando)', '선택한 점·핸들·Locate 끝점·보이스 이동 (글리산도)'],
    ['Shift + arrows', 'Coarse nudge', '크게 이동'],
    ['Shift + R', 'Duplicate the active voice after its end (Glissando)', '활성 보이스를 끝점 뒤에 복제 (글리산도)'],
  ]],
  ['View · 보기', [
    ['F', 'Fit all', '전체 맞춤'],
    ['M', 'Manager window open / close', '매니저 창 열기 / 닫기'],
    ['H', 'Help mode (labels on every control)', '도움말 모드 (모든 컨트롤에 설명)'],
    ['?', 'This list', '이 목록'],
    ['Alt (hold) + hover', 'Help card of the control under the pointer; Alt + click = full help', '포인터 아래 컨트롤의 설명 카드, Alt + 클릭 = 전체 도움말'],
  ]],
  ['Mouse · 마우스', [
    ['Wheel · Shift + wheel · Ctrl/⌘ + wheel', 'Scroll pitch · scroll time · zoom at the pointer (every studio monitor)', '음고 스크롤 · 시간 스크롤 · 포인터 기준 줌 (모든 스튜디오 모니터)'],
    ['Double-click a slider', 'Back to its default value', '슬라이더 기본값으로'],
    ['Double-click the monitor', 'Set the cue there', '그 위치로 큐 설정'],
    ['Shift + double-click (Locate)', 'Audition from there', '그 위치부터 미리 듣기'],
    ['Click a toolbox title', 'Fold / unfold it', '툴박스 접기 / 열기'],
    ['Drag ⠿ · double-click ⠿', 'Float a toolbox anywhere · put it back', '툴박스 띄우기 · 제자리로'],
    ['⛶ · double-click an empty spot of a monitor', 'Monitor full screen on / off (Esc leaves)', '모니터 전체화면 켜기 / 끄기 (Esc로 해제)'],
    ['Drag ◢ · double-click ◢', 'Resize a toolbox / monitor · natural size', '툴박스·모니터 크기 조절 · 원래 크기'],
    ['Drag the line between the columns', 'Width of the monitor column', '모니터 열 폭'],
    ['Double-click the output line', 'Fold / unfold the output controls', '출력 컨트롤 접기 / 열기'],
    ['Click “⧉ Manager” (its name) · click the studio behind', 'Close the Manager', '매니저 닫기'],
  ]],
  ['Studios · 스튜디오별', [
    ['Z · X (Fractal)', 'Lens zoom in · out', '렌즈 확대 · 축소'],
    ['W (Draw)', 'Warp tool: a liquify brush for the active stroke (object effect)', '변형 도구: 활성 획을 위한 리퀴파이 브러시 (객체 효과)'],
    ['[ · ] (Grid)', 'Space brush smaller · larger', '공간 브러시 작게 · 크게'],
    ['\\ (Grid)', 'Editor / Result windows: stacked ⇄ side by side', 'Editor / Result 윈도우: 세로 적층 ⇄ 가로 나란히'],
    ['B · S · V (Grid)', 'Brush · selection tools in turn (pitch band, time band, box, lasso) · Pull', '브러시 · 선택 도구 순환 (음고 띠, 시간 띠, 박스, 올가미) · 당기기'],
    ['Esc (Grid)', 'Also clears the selection', '선택 해제도 함께'],
  ]],
];

let modal = null;

export function closeShortcutHelp() {
  modal?.remove();
  modal = null;
}

/** Open (or close, when open) the shortcut list. / 단축키 목록 열기·닫기 */
export function toggleShortcutHelp() {
  if (modal) { closeShortcutHelp(); return; }
  const ko = getLang() === 'ko';
  modal = document.createElement('div');
  modal.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', t('keys.title'));
  const card = document.createElement('div');
  card.className = 'w-full max-w-2xl max-h-[85vh] overflow-auto custom-scroll rounded-xl border border-slate-700 bg-slate-900 p-4 text-slate-200 shadow-2xl';
  const head = document.createElement('div');
  head.className = 'flex items-center justify-between gap-2 mb-2';
  head.innerHTML = `<h2 class="text-sm font-bold text-white">⌨ ${t('keys.title')}</h2>`;
  const close = document.createElement('button');
  close.className = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs';
  close.textContent = `✕ ${t('keys.close')}`;
  close.addEventListener('click', closeShortcutHelp);
  head.append(close);
  card.append(head);
  for (const [title, rows] of GROUPS) {
    const h = document.createElement('h3');
    h.className = 'mt-3 mb-1 text-[11px] font-bold uppercase tracking-wider text-sky-300';
    h.textContent = title;
    card.append(h);
    const table = document.createElement('div');
    table.className = 'grid grid-cols-[minmax(150px,auto)_1fr] gap-x-3 gap-y-1 text-[12px]';
    for (const [keys, en, k] of rows) {
      const kc = document.createElement('div');
      kc.className = 'font-mono text-amber-200 whitespace-nowrap';
      kc.textContent = keys;
      const d = document.createElement('div');
      d.className = 'text-slate-300';
      d.textContent = ko ? k : en;
      table.append(kc, d);
    }
    card.append(table);
  }
  modal.append(card);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeShortcutHelp(); });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeShortcutHelp(); } });
  document.body.append(modal);
  close.focus();
}

/** Header button (⌨) next to Help. / 헤더 버튼 */
export function initShortcutHelp() {
  const help = document.getElementById('btnHelpMode');
  if (!help || document.getElementById('btnShortcuts')) return;
  const b = document.createElement('button');
  b.id = 'btnShortcuts';
  b.type = 'button';
  b.dataset.help = 'app.keys';
  b.className = 'px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold transition';
  b.title = t('keys.tip');
  b.textContent = `⌨ ${t('keys.button')}`;
  b.addEventListener('click', toggleShortcutHelp);
  help.after(b);
}

/** Re-label after a language change. / 언어 변경 후 라벨 */
export function renderShortcutButton() {
  const b = document.getElementById('btnShortcuts');
  if (b) { b.textContent = `⌨ ${t('keys.button')}`; b.title = t('keys.tip'); }
}
