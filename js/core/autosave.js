/**
 * Autosave / 자동 저장
 *
 *  - Keeps the current project in the browser so a refresh or an accidental tab close
 *    brings the work back. The stored object is exactly what "Save project" downloads
 *    (`serializeProject()`), and it is restored with `loadProjectData()`. Sampler sound files are
 *    stored under their own key (written when the library changes), not with every project save.
 *    새로고침·탭 닫힘 후에도 작업이 돌아오도록 현재 프로젝트를 브라우저에 보관.
 *    저장 내용은 "프로젝트 저장" 파일과 동일하며 loadProjectData()로 복원.
 *  - Primary store: IndexedDB (no ~5 MB localStorage cap). On `pagehide` the same data is
 *    also written synchronously to localStorage, because an async IndexedDB write may not
 *    finish while the page unloads. Restore picks whichever copy is newer.
 *    기본 저장소는 IndexedDB. 페이지가 내려갈 때는 비동기 쓰기가 끝나지 않을 수 있어
 *    localStorage에도 동기 저장하고, 복원 시 더 최신 쪽을 사용.
 *  - Nothing is saved until the restore attempt has finished, so the default document
 *    created at boot never overwrites the stored work.
 *    복원 시도가 끝나기 전에는 저장하지 않음 (시작 시 기본 문서가 덮어쓰지 않도록).
 *  - Open the app with `?new` to skip the restore once and start from the default document.
 *    `?new`로 열면 복원을 건너뛰고 기본 문서로 시작.
 *  - Also remembers the document as of the last file Save / Load / New, so the app can tell
 *    whether there are changes that exist only in the browser (`hasUnsavedFileChanges()`).
 *    마지막 파일 저장·불러오기·새 프로젝트 시점의 문서를 기억해, 파일에 없는 변경이 있는지 판단.
 *  - Every storage call is wrapped: private mode / blocked storage / full quota simply
 *    turns autosave off (and the leave-page warning on).
 *    저장소 오류 시 자동 저장만 꺼지고(이탈 경고 켜짐) 앱은 그대로 동작.
 */

import { subscribe, serializeProject, loadProjectData } from './state.js';
import { serializeSamples, loadSamples, onSampleLibraryChange } from './sample-library.js';

const DB_NAME = 'flexatone';
const DB_STORE = 'autosave';
const DB_KEY = 'current';
/** Sampler sound files, stored apart from the project so the frequent project save stays small. */
const DB_SAMPLES_KEY = 'samples';
const DB_BASELINE_KEY = 'fileBaseline';
const LS_KEY = 'flexatone.autosave.unload';
const DEBOUNCE_MS = 800;

let ready = false; // restore attempt finished / 복원 시도 완료
let healthy = true; // last write succeeded / 마지막 저장 성공 여부
let lastKey = null; // content of the last stored document (without savedAt) / 마지막 저장 내용
let timer = null;
let dbPromise = null;
let fileBaseline = null; // docKey at the last file Save / Load / New / 마지막 파일 기준 문서

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = globalThis.indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function idb(mode, op) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = op(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function contentKey(data) {
  return JSON.stringify({ ...data, savedAt: null });
}

/** JSON with object keys sorted, so key order never counts as a change. / 키 순서 무관 JSON */
function stableStringify(v) {
  return JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x));
}

/** The document part of a project (no view prefs, viewport or selection). / 문서 부분만 */
function docKey(data = serializeProject({ samples: false })) {
  return stableStringify([data.voices, data.studioParams, data.versions, data.manager]);
}

/** Record the current document as matching a file (Save / Load / New). / 현재 문서를 파일 기준으로 기록 */
export function markFileSaved() {
  fileBaseline = docKey();
  idb('readwrite', (s) => s.put(fileBaseline, DB_BASELINE_KEY)).catch(() => { /* in-memory only */ });
}

/** Whether the document has changes not in the last saved/loaded file. / 파일에 없는 변경 여부 */
export function hasUnsavedFileChanges() {
  return fileBaseline !== docKey();
}

function parseLocal() {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.savedAt) > Date.parse(a.savedAt) ? b : a;
}

/** Write the current project now (async, IndexedDB). / 지금 저장 */
export async function saveNow() {
  clearTimeout(timer);
  timer = null;
  if (!ready) return false;
  const data = serializeProject({ samples: false });
  const key = contentKey(data);
  if (key === lastKey) return true;
  try {
    await idb('readwrite', (s) => s.put(data, DB_KEY));
    lastKey = key;
    healthy = true;
    try { globalThis.localStorage?.removeItem(LS_KEY); } catch { /* ignore */ }
    return true;
  } catch (err) {
    console.warn('[Flexatone] autosave failed:', err);
    healthy = false;
    return false;
  }
}

function scheduleSave() {
  // Keep a pending save instead of restarting it, so a stream of events (playback,
  // long drags) cannot postpone saving forever. / 연속 이벤트가 저장을 무한히 미루지 않도록
  if (!ready || timer !== null) return;
  timer = setTimeout(saveNow, DEBOUNCE_MS);
}

/** Synchronous last-chance copy while the page goes away. / 페이지 이탈 시 동기 저장 */
function saveOnUnload() {
  if (!ready) return;
  const data = serializeProject({ samples: false });
  const key = contentKey(data);
  if (key === lastKey && timer === null) return;
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(data));
    healthy = true;
  } catch {
    healthy = false;
  }
  saveNow(); // also try IndexedDB; it may or may not finish / IndexedDB도 시도
}

/** Write the whole sound-file library (after an import). / 사운드 파일 모음 저장 */
async function saveSamplesNow() {
  try {
    await idb('readwrite', (s) => s.put(serializeSamples(), DB_SAMPLES_KEY));
  } catch (err) {
    console.warn('[Flexatone] sample autosave failed:', err);
    healthy = false;
  }
}

/**
 * Restore the stored project (if any) and start autosaving.
 * Call once at boot, after the UI has subscribed to state.
 * 저장된 프로젝트를 복원하고 자동 저장 시작 (시작 시 한 번 호출).
 * @returns {Promise<{ restored: boolean, savedAt?: string }>}
 */
export async function initAutosave() {
  let result = { restored: false };
  const skip = new URLSearchParams(globalThis.location?.search || '').has('new');
  if (skip) {
    // Drop `?new` so the next refresh restores again / 다음 새로고침부터는 다시 복원
    try {
      const url = new URL(globalThis.location.href);
      url.searchParams.delete('new');
      globalThis.history?.replaceState(null, '', url);
    } catch { /* ignore */ }
  } else {
    let stored = null;
    try {
      loadSamples(await idb('readonly', (s) => s.get(DB_SAMPLES_KEY))); // before the voices that use them / 보이스보다 먼저
    } catch (err) {
      console.warn('[Flexatone] stored samples unavailable:', err);
    }
    try {
      stored = await idb('readonly', (s) => s.get(DB_KEY));
    } catch (err) {
      console.warn('[Flexatone] autosave unavailable:', err);
      healthy = false;
    }
    const data = newer(stored || null, parseLocal());
    if (data) {
      const res = loadProjectData(data);
      if (res.ok) {
        result = { restored: true, savedAt: data.savedAt };
        if (data === stored) lastKey = contentKey(serializeProject({ samples: false }));
        try {
          const b = await idb('readonly', (s) => s.get(DB_BASELINE_KEY));
          // Compare with the stored data as written, before loading normalized it; if it matched
          // the file then, the restored document matches it now. / 정규화 전 저장본으로 비교
          if (typeof b === 'string') fileBaseline = b === docKey(data) ? docKey() : b;
        } catch { /* unknown → treated as unsaved */ }
      } else {
        console.warn('[Flexatone] stored project could not be restored:', res.error);
      }
    }
  }

  ready = true;
  // A fresh document (first visit, `?new`) counts as matching a file / 새 문서는 저장된 것으로 간주
  if (!result.restored) markFileSaved();
  subscribe(scheduleSave);
  onSampleLibraryChange(() => { saveSamplesNow(); });
  globalThis.addEventListener?.('pagehide', saveOnUnload);
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (globalThis.document.visibilityState === 'hidden') saveNow();
  });
  // Warn before leaving only when the work could not be kept / 저장 실패 시에만 이탈 경고
  globalThis.addEventListener?.('beforeunload', (e) => {
    if (healthy) return;
    e.preventDefault();
    e.returnValue = '';
  });
  saveNow();
  return result;
}

/** Whether the last autosave write succeeded. / 마지막 자동 저장 성공 여부 */
export function isAutosaveHealthy() {
  return healthy;
}
