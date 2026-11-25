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
 *  - `askSaveBeforeLoad()` runs before the Load button opens its file picker: with changes that are
 *    not in a saved file it shows Save, then load · Load without saving · Cancel. Both dialogs are the
 *    same `openSaveFirstDialog()`.
 *    불러오기 전에 파일에 없는 변경이 있으면 "저장 후 불러오기 · 저장하지 않고 불러오기 · 취소" 창을 띄움.
 */

import { t } from '../core/i18n.js';
import { serializeProject } from '../core/state.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { markFileSaved, hasUnsavedFileChanges, saveNow } from '../core/autosave.js';
import { setProjectFileName } from './file-name-chip.js';

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
      setProjectFileName(handle.name || name);
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
  setProjectFileName(name);
  return 'downloaded';
}

// ==========================================================================
// "Save first?" dialog (reload, load) / "먼저 저장할까요?" 창 (새로고침, 불러오기)
// ==========================================================================

let dialog = null;

function closeDialog() {
  dialog?.remove();
  dialog = null;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `px-3 py-1.5 rounded-lg text-xs font-semibold transition ${cls}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const BTN_PRIMARY = 'bg-sky-600 hover:bg-sky-500 text-white';
const BTN_PLAIN = 'bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700';

/**
 * Save · Continue without saving · Cancel. `proceed()` runs after a successful save or on "without
 * saving". With `needsGesture` (proceed opens a file picker, which browsers allow only right after a
 * click) and no click left after a slow save, the dialog turns into a one-button step instead.
 * 저장 · 저장하지 않고 진행 · 취소. 저장이 오래 걸려 클릭 권한이 사라지면 버튼 하나짜리 단계로 바뀜.
 * @param {{ showToast: Function, keys: { title: string, body: string, save: string, discard: string, cancel: string,
 *           saved?: string, next?: string }, proceed: () => void|Promise<void>, needsGesture?: boolean }} o
 */
function openSaveFirstDialog({ showToast, keys, proceed, needsGesture = false }) {
  if (dialog) return;
  dialog = document.createElement('div');
  dialog.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'saveFirstDialogTitle');
  const card = document.createElement('div');
  card.className = 'w-full max-w-md rounded-2xl bg-slate-900 border border-sky-500/50 shadow-2xl p-5 flex flex-col gap-3';
  const title = document.createElement('h3');
  title.id = 'saveFirstDialogTitle';
  title.className = 'text-base font-bold text-sky-200';
  title.textContent = t(keys.title);
  const body = document.createElement('p');
  body.className = 'text-[13px] leading-relaxed text-slate-300';
  body.textContent = t(keys.body);
  const row = document.createElement('div');
  row.className = 'flex flex-wrap justify-end gap-2 pt-1';
  const go = () => { closeDialog(); proceed(); };
  const save = button(t(keys.save), BTN_PRIMARY, async () => {
    save.disabled = true;
    const res = await saveProjectToFile();
    save.disabled = false;
    if (res === 'cancelled') return; // stay in the dialog / 창 유지
    if (res === 'error') {
      showToast(t('toast.saveError'), 'error');
      return;
    }
    if (res === 'downloaded') await new Promise((r) => setTimeout(r, 600)); // let the download start / 다운로드 시작 대기
    const active = globalThis.navigator?.userActivation?.isActive;
    if (needsGesture && active === false) {
      // The browser no longer counts this as a click: ask for one more / 클릭 권한 만료 → 한 번 더 클릭
      body.textContent = t(keys.saved);
      const next = button(t(keys.next), BTN_PRIMARY, go);
      row.replaceChildren(button(t(keys.cancel), BTN_PLAIN, closeDialog), next);
      next.focus();
      return;
    }
    go();
  });
  const discard = button(t(keys.discard), BTN_PLAIN, go);
  const cancel = button(t(keys.cancel), 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700', closeDialog);
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

async function reloadNow() {
  await saveNow(); // keep the browser copy current / 브라우저 자동 저장본 최신화
  globalThis.location.reload();
}

function openReloadDialog({ showToast }) {
  openSaveFirstDialog({
    showToast,
    keys: { title: 'reload.title', body: 'reload.body', save: 'reload.save', discard: 'reload.discard', cancel: 'reload.cancel' },
    proceed: reloadNow,
  });
}

/**
 * Before loading a project: offer to save the current one when it has changes not in a saved file,
 * then call `pickFile()` (which opens the file picker). Without such changes `pickFile()` runs at once.
 * 프로젝트를 불러오기 전에, 파일에 없는 변경이 있으면 먼저 저장할지 묻고 pickFile()을 호출.
 * @param {{ showToast: Function, pickFile: () => void }} o
 */
export function askSaveBeforeLoad({ showToast, pickFile }) {
  if (!hasUnsavedFileChanges()) { pickFile(); return; }
  openSaveFirstDialog({
    showToast,
    keys: { title: 'loadAsk.title', body: 'loadAsk.body', save: 'loadAsk.save', discard: 'loadAsk.discard', cancel: 'reload.cancel', saved: 'loadAsk.saved', next: 'loadAsk.choose' },
    proceed: pickFile,
    needsGesture: true,
  });
}

/**
 * "Which studios to load?" — one checkbox per studio found in the file (all ticked). Resolves to the
 * ticked studio ids, or null on Cancel / Esc / click outside.
 * 어느 스튜디오를 불러올지 체크박스로 선택. 취소하면 null.
 * @param {string[]} studios
 * With `modes: true` it also asks Add (to the current work, default) or Replace, and resolves to
 * `{ studios, mode: 'add' | 'replace' }`. / modes: 추가(기본)·교체 선택도 함께
 * @param {{ titleKey?: string, bodyKey?: string, okKey?: string, summary?: (id: string) => string, modes?: boolean }} [opts]
 * @returns {Promise<string[]|{ studios: string[], mode: string }|null>}
 */
export function askLoadStudios(studios, opts = {}) {
  const { titleKey = 'loadStudios.title', bodyKey = 'loadStudios.body', okKey = 'loadStudios.load', summary = null, modes = false } = opts;
  closeDialog();
  return new Promise((resolve) => {
    const box = document.createElement('div');
    dialog = box;
    box.className = 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'loadStudiosTitle');
    const card = document.createElement('div');
    card.className = 'w-full max-w-md rounded-2xl bg-slate-900 border border-sky-500/50 shadow-2xl p-5 flex flex-col gap-3';
    const title = document.createElement('h3');
    title.id = 'loadStudiosTitle';
    title.className = 'text-base font-bold text-sky-200';
    title.textContent = t(titleKey);
    const body = document.createElement('p');
    body.className = 'text-[13px] leading-relaxed text-slate-300';
    body.textContent = t(bodyKey);

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1 max-h-64 overflow-y-auto rounded-lg border border-slate-700 p-2';
    const checks = [];
    for (const id of studios) {
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-800 cursor-pointer text-sm text-slate-200';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.value = id;
      cb.className = 'accent-sky-500';
      const name = t(`studio.${id}`);
      label.append(cb, document.createTextNode(name === `studio.${id}` ? id : name));
      const info = summary?.(id); // preview line, e.g. "3 voices · now: 1" / 미리보기 한 줄
      if (info) {
        const sm = document.createElement('span');
        sm.className = 'ml-auto text-[11px] text-slate-400';
        sm.textContent = info;
        label.append(sm);
      }
      list.append(label);
      checks.push(cb);
    }

    // Add to the current work (default) or replace it / 현재 작업에 추가(기본) 또는 교체
    let mode = 'add';
    const modeBox = document.createElement('div');
    if (modes) {
      modeBox.className = 'flex flex-col gap-1 rounded-lg border border-slate-700 p-2';
      modeBox.dataset.help = 'app.loadMode';
      for (const m of ['add', 'replace']) {
        const label = document.createElement('label');
        label.className = 'flex items-start gap-2 px-2 py-1 rounded hover:bg-slate-800 cursor-pointer text-sm text-slate-200';
        const rb = document.createElement('input');
        rb.type = 'radio';
        rb.name = 'loadStudiosMode';
        rb.value = m;
        rb.checked = m === mode;
        rb.className = 'accent-sky-500 mt-1';
        rb.addEventListener('change', () => { if (rb.checked) mode = m; });
        const txt = document.createElement('span');
        txt.className = 'flex flex-col';
        const head = document.createElement('span');
        head.textContent = t(`loadStudios.mode.${m}`);
        const sub = document.createElement('span');
        sub.className = 'text-[11px] text-slate-400';
        sub.textContent = t(`loadStudios.mode.${m}Hint`);
        txt.append(head, sub);
        label.append(rb, txt);
        modeBox.append(label);
      }
    }

    const tools = document.createElement('div');
    tools.className = 'flex gap-2';
    const setAll = (on) => { for (const c of checks) c.checked = on; sync(); };
    tools.append(button(t('loadStudios.all'), BTN_PLAIN, () => setAll(true)), button(t('loadStudios.none'), BTN_PLAIN, () => setAll(false)));

    const row = document.createElement('div');
    row.className = 'flex flex-wrap justify-end gap-2 pt-1';
    const done = (v) => { closeDialog(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    const ok = button(t(okKey), BTN_PRIMARY, () => {
      const picked = checks.filter((c) => c.checked).map((c) => c.value);
      done(modes ? { studios: picked, mode } : picked);
    });
    const sync = () => { ok.disabled = !checks.some((c) => c.checked); ok.classList.toggle('opacity-50', ok.disabled); };
    for (const c of checks) c.addEventListener('change', sync);
    row.append(button(t('reload.cancel'), BTN_PLAIN, () => done(null)), ok);
    document.addEventListener('keydown', onKey, true);
    box.addEventListener('mousedown', (e) => { if (e.target === box) done(null); });
    card.append(title, body, ...(modes ? [modeBox] : []), tools, list, row);
    box.append(card);
    document.body.append(box);
    ok.focus();
  });
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
