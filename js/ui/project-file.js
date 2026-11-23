/**
 * Project file saving + reload guard / 프로젝트 파일 저장 + 새로고침 확인 창
 *
 *  - `saveProjectToFile()` is what the Save button does. Where the browser supports it
 *    (Chrome / Edge: `showSaveFilePicker`) it opens a Save As window to pick the folder and
 *    name; elsewhere (Safari / Firefox) it downloads the .json as before.
 *    저장 버튼 동작. 지원 브라우저(Chrome/Edge)는 "다른 이름으로 저장" 창, 그 외는 다운로드.
 *  - `initReloadGuard()` catches Cmd/Ctrl+R and F5. When the document has changes that are not
 *    in the last saved/loaded file it shows an app dialog: Save and reload · Reload without
 *    saving · Cancel. With no such changes the browser reloads as usual.
 *    The browser's own reload button and tab close cannot be caught this way: browsers do not
 *    let a page change their leave-page dialog or open a save window from it.
 *    Cmd/Ctrl+R·F5를 가로채, 파일에 없는 변경이 있으면 앱 확인 창을 띄움.
 *    브라우저 새로고침 버튼·탭 닫기는 브라우저 정책상 가로챌 수 없음.
 */

import { t } from '../core/i18n.js';
import { serializeProject } from '../core/state.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { markFileSaved, hasUnsavedFileChanges, saveNow } from '../core/autosave.js';

let lastHandle = null; // last picked file, so the next Save As opens in the same folder / 마지막 저장 위치

/**
 * Save the project as .json (Save As window where supported).
 * @returns {Promise<'saved'|'downloaded'|'cancelled'|'error'>}
 */
export async function saveProjectToFile() {
  const data = serializeProject();
  const text = JSON.stringify(data, null, 2);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const name = `Flexatone_${stamp}.json`;
  if (typeof globalThis.showSaveFilePicker === 'function') {
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: name,
        startIn: lastHandle || 'documents',
        types: [{ description: 'Flexatone project', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      lastHandle = handle;
      markFileSaved();
      return 'saved';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // SecurityError (no user gesture, iframe) etc. → fall back to a download / 다운로드로 대체
      if (err?.name !== 'SecurityError' && err?.name !== 'NotAllowedError') {
        console.error(err);
        return 'error';
      }
    }
  }
  triggerDownload(new Blob([text], { type: 'application/json' }), name);
  markFileSaved();
  return 'downloaded';
}

// ==========================================================================
// Reload dialog / 새로고침 확인 창
// ==========================================================================

let dialog = null;

function closeDialog() {
  dialog?.remove();
  dialog = null;
}

async function reloadNow() {
  closeDialog();
  await saveNow(); // keep the browser copy current / 브라우저 자동 저장본 최신화
  globalThis.location.reload();
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `px-3 py-1.5 rounded-lg text-xs font-semibold transition ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function openReloadDialog({ showToast }) {
  if (dialog) return;
  dialog = document.createElement('div');
  dialog.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'reloadDialogTitle');
  const card = document.createElement('div');
  card.className = 'w-full max-w-md rounded-2xl bg-slate-900 border border-sky-500/50 shadow-2xl p-5 flex flex-col gap-3';
  const title = document.createElement('h3');
  title.id = 'reloadDialogTitle';
  title.className = 'text-base font-bold text-sky-200';
  title.textContent = t('reload.title');
  const body = document.createElement('p');
  body.className = 'text-[13px] leading-relaxed text-slate-300';
  body.textContent = t('reload.body');
  const row = document.createElement('div');
  row.className = 'flex flex-wrap justify-end gap-2 pt-1';
  const save = button(t('reload.save'), 'bg-sky-600 hover:bg-sky-500 text-white', async () => {
    save.disabled = true;
    const res = await saveProjectToFile();
    save.disabled = false;
    if (res === 'cancelled') return; // stay in the dialog / 창 유지
    if (res === 'error') {
      showToast(t('toast.saveError'), 'error');
      return;
    }
    if (res === 'downloaded') await new Promise((r) => setTimeout(r, 600)); // let the download start / 다운로드 시작 대기
    reloadNow();
  });
  const discard = button(t('reload.discard'), 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700', reloadNow);
  const cancel = button(t('reload.cancel'), 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700', closeDialog);
  row.append(cancel, discard, save);
  card.append(title, body, row);
  dialog.append(card);
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(); });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeDialog();
    }
  });
  document.body.append(dialog);
  save.focus();
}

function isReloadKey(e) {
  if (e.key === 'F5') return true;
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'r' || e.key === 'R');
}

/** Install the Cmd/Ctrl+R · F5 guard once. / 새로고침 단축키 가로채기 설치 */
export function initReloadGuard({ showToast }) {
  globalThis.addEventListener('keydown', (e) => {
    if (!isReloadKey(e)) return;
    if (dialog) { // a second press inside the dialog does nothing / 창이 열려 있으면 무시
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!hasUnsavedFileChanges()) return; // let the browser reload / 그대로 새로고침
    e.preventDefault();
    e.stopImmediatePropagation();
    openReloadDialog({ showToast });
  }, { capture: true });
}
