/**
 * Flexatone — ui/file-name-chip.js
 * Layer 4 (ui): the name of the loaded (or last saved) project / preset file, shown at the right end of
 * the header (#lblProjectFile). Kept in localStorage so it survives a reload (the autosave brings the
 * project back too); "New project" clears it. A dot marks changes that are not in that file yet.
 * 계층 4 (ui): 불러온(또는 마지막으로 저장한) 프로젝트·프리셋 파일 이름을 헤더 오른쪽 끝에 표시.
 * 새로고침 후에도 유지(localStorage), 새 프로젝트에서 지움. 파일에 없는 변경이 있으면 점(•) 표시.
 */

import { t, I18N } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';
import { hasUnsavedFileChanges } from '../core/autosave.js';

Object.assign(I18N.en, {
  'file.chipTip': (name) => `Loaded file: ${name}`,
  'file.chipDirty': 'changed since it was loaded or saved',
});
Object.assign(I18N.ko, {
  'file.chipTip': (name) => `불러온 파일: ${name}`,
  'file.chipDirty': '불러오거나 저장한 뒤 바뀜',
});

HELP_DB['app.fileName'] = {
  en: { title: 'File name', summary: 'The project or preset file that was loaded (or last saved). An amber dot means there are changes that are not in that file yet.', detail: 'Kept across a reload; New project clears it.', formula: '' },
  ko: { title: '파일 이름', summary: '불러온(또는 마지막으로 저장한) 프로젝트·프리셋 파일. 주황색 점은 그 파일에 아직 없는 변경이 있다는 뜻입니다.', detail: '새로고침해도 남고, 새 프로젝트에서 지워집니다.', formula: '' },
};

const KEY = 'flexatone.fileName';
let current = '';
let timer = null;

function read() { try { return globalThis.localStorage?.getItem(KEY) || ''; } catch { return ''; } }
function write(v) { try { if (v) globalThis.localStorage?.setItem(KEY, v); else globalThis.localStorage?.removeItem(KEY); } catch { /* storage blocked */ } }

/** Set (or clear with '') the file name shown in the header. / 헤더의 파일 이름 설정 (빈 문자열 = 지움) */
export function setProjectFileName(name) {
  current = String(name || '');
  write(current);
  render();
}

export const getProjectFileName = () => current;

function render() {
  const el = document.getElementById('lblProjectFile');
  if (!el) return;
  el.classList.toggle('hidden', !current);
  if (!current) return;
  let dirty = false;
  try { dirty = hasUnsavedFileChanges(); } catch { /* autosave not ready */ }
  const label = el.querySelector('[data-file-name]');
  if (label && label.textContent !== current) label.textContent = current;
  const dot = el.querySelector('[data-file-dirty]');
  if (dot) dot.classList.toggle('hidden', !dirty);
  el.title = `${t('file.chipTip', current)}${dirty ? ` · ${t('file.chipDirty')}` : ''}`;
}

/** Restore the name after a reload (cleared by ?new). / 새로고침 후 복원 (?new 이면 지움) */
export function initFileNameChip() {
  const fresh = new URL(location.href).searchParams.has('new');
  current = fresh ? '' : read();
  if (fresh) write('');
  render();
  clearInterval(timer);
  timer = setInterval(render, 1000); // the unsaved-changes dot / 저장 안 된 변경 점
}
