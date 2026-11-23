/**
 * Flexatone — core/sample-library.js
 * Layer 0 (core, pure): the project's sound files for the per-voice Sampler. Each entry is mono PCM
 * (Float32Array) plus its metadata; the decoded AudioBuffers live in audio/sample-voice.js.
 * 계층 0 (core, 순수): 보이스별 샘플러가 쓰는 프로젝트 사운드 파일 모음. 항목마다 모노 PCM과 메타데이터.
 *
 *   entry = { id, name, sampleRate, length, peak, data: Float32Array }
 *   id    = content hash ('smp_' + 8 hex) → the same file imported twice is stored once.
 *
 * The library lives outside appState on purpose: undo snapshots deep-copy the documents, and
 * copying seconds of PCM on every edit would be slow. A voice refers to an entry by id only.
 * 라이브러리는 appState 밖에 둠: 실행 취소 스냅샷이 문서를 깊은 복사하므로 PCM을 넣으면 느려짐. 보이스는 id로만 참조.
 *
 * Saved form (project file `samples`): [{ id, name, sampleRate, length, peak, pcm16 }] where pcm16 is
 * base64 little-endian 16-bit mono. / 저장 형식: 16비트 모노 PCM의 base64.
 *
 * Imports: nothing (core/state.js imports this file). Its self-check lives in modules/sample-source.js.
 * No DOM / Audio APIs (btoa / atob are plain globals).
 */

/** Longest file kept (seconds); longer files are cut. / 최대 길이 */
export const MAX_SAMPLE_SEC = 60;

const entries = new Map();
const listeners = new Set();
let revision = 0;

function changed() {
  revision++;
  for (const fn of listeners) {
    try { fn(revision); } catch (err) { console.error('[Flexatone] sample library listener failed:', err); }
  }
}

/** FNV-1a over the 16-bit PCM and the rate. / 내용 해시 */
function contentId(pcm16, sampleRate) {
  let h = 0x811c9dc5 ^ sampleRate;
  const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return `smp_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function toPcm16(data) {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
  }
  return out;
}

function fromPcm16(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / (pcm[i] < 0 ? 32768 : 32767);
  return out;
}

function peakOf(data) {
  let p = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > p) p = a; }
  return p;
}

function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return globalThis.btoa(s);
}

function base64ToBytes(b64) {
  const s = globalThis.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Little-endian Int16 view regardless of platform. / 리틀엔디언 16비트 */
function pcmToBytes(pcm) {
  const out = new Uint8Array(pcm.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
  return out;
}

function bytesToPcm(bytes) {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/**
 * Add mono PCM to the library (quantised to 16 bit, the saved precision, so a reload sounds the same).
 * Returns the entry (an existing one when the content is already there).
 * 모노 PCM 추가 (저장 정밀도인 16비트로 양자화). 같은 내용이면 기존 항목 반환.
 * @param {{ name: string, sampleRate: number, data: Float32Array }} input
 */
export function addSample({ name, sampleRate, data }) {
  const sr = Math.round(Number(sampleRate));
  if (!(sr >= 8000 && sr <= 192000)) throw new Error('sample rate');
  if (!(data instanceof Float32Array) || data.length < 16) throw new Error('empty');
  const n = Math.min(data.length, Math.round(MAX_SAMPLE_SEC * sr));
  const pcm = toPcm16(data.subarray(0, n));
  const id = contentId(pcm, sr);
  const have = entries.get(id);
  if (have) return have;
  const pcmData = fromPcm16(pcm);
  const entry = { id, name: String(name || 'Sample').slice(0, 80), sampleRate: sr, length: n, peak: peakOf(pcmData), data: pcmData };
  entries.set(id, entry);
  changed();
  return entry;
}

export const getSample = (id) => (id ? entries.get(id) || null : null);
export const listSamples = () => [...entries.values()];
export const sampleLibraryRevision = () => revision;

/** Rename an entry (names are labels only). / 이름 바꾸기 */
export function renameSample(id, name) {
  const e = entries.get(id);
  if (!e || !name) return;
  e.name = String(name).slice(0, 80);
  changed();
}

/** Remove an entry (voices that refer to it go silent). / 항목 제거 (참조하는 보이스는 무음) */
export function removeSample(id) {
  if (entries.delete(id)) changed();
}

/** Call `fn(revision)` after every change; returns an unsubscribe. / 변경 구독 */
export function onSampleLibraryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Saved form of the entries (all, or the given ids). / 저장 형식으로 변환
 * @param {Iterable<string>} [ids]
 */
export function serializeSamples(ids = null) {
  const pick = ids ? [...ids].map((id) => entries.get(id)).filter(Boolean) : [...entries.values()];
  return pick.map((e) => ({ id: e.id, name: e.name, sampleRate: e.sampleRate, length: e.length, peak: e.peak, pcm16: bytesToBase64(pcmToBytes(toPcm16(e.data))) }));
}

/**
 * Ids of library entries that appear in `text` (a serialised document). / 문서에서 참조하는 항목
 */
export function referencedSampleIds(text) {
  const out = [];
  if (typeof text !== 'string' || !entries.size) return out;
  for (const id of entries.keys()) if (text.includes(id)) out.push(id);
  return out;
}

/**
 * Add saved entries (from a project file or the autosave store). Bad items are skipped.
 * Existing entries are kept. Returns the number added.
 * 저장된 항목 불러오기 (잘못된 항목은 건너뜀). 기존 항목은 유지.
 */
export function loadSamples(list) {
  if (!Array.isArray(list)) return 0;
  let added = 0;
  for (const it of list) {
    try {
      if (!it || typeof it.pcm16 !== 'string' || typeof it.id !== 'string' || entries.has(it.id)) continue;
      const sr = Math.round(Number(it.sampleRate));
      if (!(sr >= 8000 && sr <= 192000)) continue;
      const data = fromPcm16(bytesToPcm(base64ToBytes(it.pcm16)));
      if (data.length < 16) continue;
      // Keep the saved id so voices still find it / 저장된 id 유지 (보이스 참조)
      entries.set(it.id, { id: it.id, name: String(it.name || 'Sample').slice(0, 80), sampleRate: sr, length: data.length, peak: peakOf(data), data });
      added++;
    } catch (err) {
      console.warn('[Flexatone] sample skipped:', err);
    }
  }
  if (added) changed();
  return added;
}

/** Drop an entry without notifying (self-check use). / 알림 없이 제거 (점검용) */
export function _forgetSample(id) {
  entries.delete(id);
}
