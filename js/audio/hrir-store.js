/**
 * Flexatone — audio/hrir-store.js
 * Layer 3 (audio, shared): user HRIR sets for the binaural HOA decoder (audio/hoa-bus.js).
 * A set = measured head-related impulse responses, one stereo pair per direction. The decoder puts
 * a ConvolverNode with the nearest measured pair at every virtual loudspeaker instead of the
 * browser's HRTF panner.
 * 계층 3 (audio, 공용): 바이노럴 HOA 디코더용 사용자 HRIR 세트. 세트 = 방향마다 스테레오 쌍 하나인
 * 측정 임펄스 응답. 디코더는 가상 스피커마다 가장 가까운 측정 쌍의 ConvolverNode를 둠.
 *
 * Input: a bundle of STEREO WAV files (left ear, right ear), one per direction, whose file names
 * carry the direction. Recognised names / 인식하는 파일 이름:
 *   azi_45,0_ele_-15,0.wav    (SADIE II)           azimuth counter-clockwise
 *   H-10e045a.wav             (MIT KEMAR, full)    elevation first, azimuth clockwise
 *   az45_el-15.wav, az045el10.wav, 45_-15.wav      generic: azimuth, then elevation
 * SOFA files (HDF5 containers) are not read: there is no dependency-free parser here.
 * SOFA 파일(HDF5)은 읽지 않음.
 *
 * Storage: sets live outside the project — in memory and, best effort, in IndexedDB — under an id
 * that is a hash of their content. A project stores only that id (studio `spatial.hrir`); a project
 * opened where the set is missing falls back to the browser HRTF and says so.
 * 저장: 세트는 프로젝트 밖(메모리 + 가능하면 IndexedDB)에 내용 해시 id로 보관. 프로젝트에는 id만 저장.
 *
 * Browser APIs only (no DOM).
 */

const DB_NAME = 'flexatone-hrir';
const STORE = 'sets';
export const HRIR_MAX_SEC = 0.5; // longer responses are cut (they would be room responses) / 이보다 긴 응답은 자름
export const HRIR_MAX_DIRS = 3000;

const sets = new Map(); // id → { id, name, sampleRate, dirs: [[x, y, z]], L: [Float32Array], R: [Float32Array] }
const listeners = new Set();
const buffers = new WeakMap(); // set → Map(`${rate}|${index}` → AudioBuffer)
const notify = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } };

export function onHrirChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const listHrirSets = () => [...sets.values()].map((s) => ({ id: s.id, name: s.name, count: s.dirs.length, sampleRate: s.sampleRate, length: s.L[0]?.length || 0 }));
export const getHrirSet = (id) => (id ? sets.get(id) || null : null);

/**
 * Direction in a file name: { az, el } in degrees with az POSITIVE TO THE RIGHT, or null.
 * `ccw` = the generic patterns count the azimuth counter-clockwise (to the left), as SOFA does.
 * 파일 이름의 방향 (az는 오른쪽이 +). ccw = 일반 패턴의 방위가 반시계(왼쪽) 방향.
 */
export function parseHrirName(name, { ccw = true } = {}) {
  const base = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const num = (x) => Number(String(x).replace(',', '.'));
  const wrap = (a) => { let v = ((a % 360) + 360) % 360; if (v > 180) v -= 360; return v; };
  let m = base.match(/azi_(-?\d+(?:[.,]\d+)?)_ele_(-?\d+(?:[.,]\d+)?)/i);
  if (m) return { az: wrap(-num(m[1])), el: num(m[2]) }; // SADIE: counter-clockwise / 반시계
  m = base.match(/^[HLR]?(-?\d+)e(\d+)a$/i);
  if (m) return { az: wrap(num(m[2])), el: num(m[1]) }; // KEMAR: clockwise / 시계
  m = base.match(/az[a-z_]*?(-?\d+(?:[.,]\d+)?)[ _-]*el[a-z_]*?(-?\d+(?:[.,]\d+)?)/i) || base.match(/^(-?\d+(?:[.,]\d+)?)[ _](-?\d+(?:[.,]\d+)?)$/);
  if (m) return { az: wrap(ccw ? -num(m[1]) : num(m[1])), el: num(m[2]) };
  return null;
}

function hash(parts) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const x of parts) {
    const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
    const step = Math.max(1, Math.floor(u.length / 4096));
    for (let i = 0; i < u.length; i += step) { a = Math.imul(a ^ u[i], 0x01000193); b = Math.imul(b ^ u[i], 0x5bd1e995) + i; }
  }
  return `hrir_${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

function persist(set) {
  try {
    const rq = globalThis.indexedDB?.open(DB_NAME, 1);
    if (!rq) return;
    rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
    rq.onsuccess = () => { try { rq.result.transaction(STORE, 'readwrite').objectStore(STORE).put(set, set.id); } catch (err) { console.warn('[Flexatone] HRIR set not cached:', err); } };
  } catch (err) { console.warn('[Flexatone] HRIR cache unavailable:', err); }
}

/** Read the cached sets back (start-up; resolves to the number restored). / 캐시된 세트 복원 */
export function restoreHrirSets() {
  return new Promise((resolve) => {
    try {
      const rq = globalThis.indexedDB?.open(DB_NAME, 1);
      if (!rq) { resolve(0); return; }
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE);
      rq.onerror = () => resolve(0);
      rq.onsuccess = () => {
        try {
          const all = rq.result.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          all.onsuccess = () => { let n = 0; for (const s of all.result || []) if (s?.id && !sets.has(s.id)) { sets.set(s.id, s); n++; } if (n) notify(); resolve(n); };
          all.onerror = () => resolve(0);
        } catch { resolve(0); }
      };
    } catch { resolve(0); }
  });
}

/**
 * Add a set from decoded pairs: items = [{ az, el, L: Float32Array, R: Float32Array }] (az right-positive).
 * Returns { id, name, count } — the same content always gets the same id.
 * 디코딩된 쌍으로 세트 추가. 같은 내용은 항상 같은 id.
 */
export function addHrirSet(name, items, sampleRate, { cache = true } = {}) {
  const list = (items || []).filter((x) => x && Number.isFinite(x.az) && Number.isFinite(x.el) && x.L?.length && x.R?.length).slice(0, HRIR_MAX_DIRS);
  if (!list.length) return null;
  const cut = Math.round(HRIR_MAX_SEC * sampleRate);
  const D = Math.PI / 180;
  const set = {
    name: String(name || 'HRIR').slice(0, 60),
    sampleRate,
    dirs: list.map((x) => [Math.cos(x.el * D) * Math.cos(x.az * D), -Math.cos(x.el * D) * Math.sin(x.az * D), Math.sin(x.el * D)]),
    L: list.map((x) => Float32Array.from(x.L.subarray(0, cut))),
    R: list.map((x) => Float32Array.from(x.R.subarray(0, cut))),
  };
  set.id = hash([...set.L, ...set.R, Float64Array.from(set.dirs.flat())]);
  sets.set(set.id, set);
  if (cache) persist(set);
  notify();
  return { id: set.id, name: set.name, count: set.dirs.length };
}

export function removeHrirSet(id) {
  if (!sets.delete(id)) return false;
  try { const rq = globalThis.indexedDB?.open(DB_NAME, 1); if (rq) rq.onsuccess = () => { try { rq.result.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); } catch { /* cache only */ } }; } catch { /* cache only */ }
  notify();
  return true;
}

/** Index of the measured direction nearest to `dir` and the angle between them (degrees). / 가장 가까운 측정 방향 */
export function nearestHrir(set, dir) {
  let best = 0;
  let bd = -Infinity;
  for (let i = 0; i < set.dirs.length; i++) { const d = set.dirs[i]; const v = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]; if (v > bd) { bd = v; best = i; } }
  return { index: best, angle: (Math.acos(Math.max(-1, Math.min(1, bd))) * 180) / Math.PI };
}

/** Linear resampling (HRIRs are short; the convolver needs the context's rate). / 선형 리샘플 */
function resample(x, from, to) {
  if (from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from));
  const out = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) { const s = i * k; const j = Math.min(x.length - 1, Math.floor(s)); const f = s - j; out[i] = x[j] + ((x[Math.min(x.length - 1, j + 1)] || 0) - x[j]) * f; }
  if (to < from) return out;
  return out;
}

/**
 * The decoder's view of a set: { id, bufferFor(ctx, dir) → stereo AudioBuffer of the nearest pair }.
 * null when the set is not here (the decoder then uses the browser HRTF).
 * 디코더가 쓰는 세트 인터페이스. 세트가 없으면 null (브라우저 HRTF 사용).
 */
export function hrirFor(id) {
  const set = getHrirSet(id);
  if (!set) return null;
  return {
    id: set.id,
    bufferFor(ctx, dir) {
      let map = buffers.get(set);
      if (!map) { map = new Map(); buffers.set(set, map); }
      const { index } = nearestHrir(set, dir);
      const key = `${ctx.sampleRate}|${index}`;
      let buf = map.get(key);
      if (!buf) {
        const L = resample(set.L[index], set.sampleRate, ctx.sampleRate);
        const R = resample(set.R[index], set.sampleRate, ctx.sampleRate);
        buf = new AudioBuffer({ length: Math.max(L.length, R.length), numberOfChannels: 2, sampleRate: ctx.sampleRate });
        buf.getChannelData(0).set(L);
        buf.getChannelData(1).set(R);
        map.set(key, buf);
      }
      return buf;
    },
  };
}

/**
 * Decode a bundle of WAV files into a set. files = [{ name, data: ArrayBuffer }].
 * @returns {Promise<{ ok, id?, name?, count?, skipped: string[], reason? }>}
 * WAV 파일 묶음 → 세트. 방향을 알 수 없거나 스테레오가 아닌 파일은 건너뜀.
 */
export async function importHrirFiles(files, { name = '', ccw = true } = {}) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) return { ok: false, skipped: [], reason: 'noaudio' };
  const skipped = [];
  const items = [];
  let rate = 0;
  for (const f of files || []) {
    if (/\.sofa$/i.test(f.name)) { skipped.push(f.name); continue; }
    const dir = parseHrirName(f.name, { ccw });
    if (!dir) { skipped.push(f.name); continue; }
    try {
      const ctx = new Offline(2, 1, rate || 48000);
      const buf = await ctx.decodeAudioData(f.data.slice(0));
      if (buf.numberOfChannels < 2) { skipped.push(f.name); continue; }
      rate = rate || buf.sampleRate;
      items.push({ ...dir, L: Float32Array.from(buf.getChannelData(0)), R: Float32Array.from(buf.getChannelData(1)) });
    } catch (err) {
      skipped.push(f.name);
    }
  }
  if (!items.length) return { ok: false, skipped, reason: (files || []).some((f) => /\.sofa$/i.test(f.name)) ? 'sofa' : 'nodirs' };
  const made = addHrirSet(name || `HRIR (${items.length})`, items, rate);
  return { ok: !!made, ...made, skipped };
}
