/**
 * Flexatone — audio/instance-source.js
 * Layer 3 (audio, shared): the sound of a Manager instance (or of a studio's editor document) as an
 * AudioBuffer for another studio to use as its source — Space plays it from a moving point.
 * 계층 3 (audio, 공용): 매니저 인스턴스(또는 스튜디오의 에디터 문서)의 소리를 다른 스튜디오가 음원으로
 * 쓰도록 AudioBuffer로 제공 — 스페이스가 움직이는 점에서 재생.
 *
 * This module imports nothing from the mixer or the studios (they import each other: studio-clips.js
 * → space-audio.js). The renderer is REGISTERED at start-up by audio/instance-render.js
 * (`setInstanceRenderer`), the same hook pattern as mod-sources.js `configureModSources`.
 * 이 모듈은 믹서·스튜디오를 import하지 않음(순환 방지). 렌더러는 시작 시 instance-render.js가 등록.
 *
 * Model / 모델
 *   target  = an instance id, or '@<studio>' = the document open in that studio's editor
 *   content = 'doc' (the document as it is, rate 1, no track effects) | 'heard' (as the Manager track
 *             sounds: fader excluded, tempo / warp / masks / tremolo / take included)
 *   requestInstanceBuffer() answers at once with the cached buffer (or 'rendering') and renders in the
 *   background; the key of the sound decides when to render again (250 ms after the last change).
 *   Subscribers are told when a buffer is ready → the user's studio re-schedules (hot-swap).
 *   대상 = 인스턴스 id 또는 '@<studio>'(에디터 문서). 요청은 즉시 캐시(또는 'rendering')로 답하고 뒤에서 렌더.
 */

export const INSTANCE_CONTENTS = Object.freeze(['doc', 'heard']);
export const STEM_SEP = '#';
/** A target may name one line / voice of an instance: '<target>#<stem key>'. / 대상에 선·보이스 하나를 지정 가능 */
export const baseTarget = (target) => String(target ?? '').split(STEM_SEP)[0];
export const stemOf = (target) => { const s = String(target ?? ''); const i = s.indexOf(STEM_SEP); return i < 0 ? null : s.slice(i + 1); };
export const stemTarget = (target, key) => `${baseTarget(target)}${STEM_SEP}${key}`;
const DEBOUNCE_MS = 250;
const CACHE_MAX_SEC = 900; // total seconds of cached audio (LRU) / 캐시 총 길이 상한

let renderer = null; // { describe(target, content) → { ok, key, name, studio, color, length } | { ok: false, reason }, render(target, content, sampleRate) → Promise<AudioBuffer|null>, list() → [{ target, name, studio, color }] }
const cache = new Map(); // id → { key, buffer, status, pending, timer, renders }
const listeners = new Set();
let renderCount = 0;

const idOf = (target, content, sampleRate) => `${target}|${content}|${sampleRate}`;
const notify = (target) => { for (const fn of listeners) { try { fn(target); } catch (err) { console.error(err); } } };

/** Register the renderer (audio/instance-render.js). / 렌더러 등록 */
export function setInstanceRenderer(r) { renderer = r; }
export const hasInstanceRenderer = () => !!renderer;
/** The registered renderer (tests swap it for a mock and put it back). / 등록된 렌더러 (테스트용) */
export const getInstanceRenderer = () => renderer;

/** Told when a buffer became ready or a target changed. Returns unsubscribe. / 버퍼 준비 알림 구독 */
export function onInstanceBuffer(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Number of real renders so far (diagnostics / self-checks). / 실제 렌더 횟수 */
export const getInstanceRenderCount = () => renderCount;

/** Targets that can be imported: [{ target, name, studio, color }]. / 가져올 수 있는 대상 목록 */
export function listInstanceTargets() {
  try { return renderer ? renderer.list() : []; } catch (err) { console.error(err); return []; }
}

/**
 * Lines / voices of a target that can be rendered one by one:
 * { ok: true, list: [{ key, name, pitch }] } or { ok: false, reason: 'unsupported' | 'missing' | 'single' | 'none' }.
 * 대상에서 하나씩 렌더할 수 있는 선·보이스 목록.
 */
export function listInstanceStems(target) {
  if (!renderer?.stems) return { ok: false, reason: 'none' };
  try { return renderer.stems(baseTarget(target)) || { ok: false, reason: 'missing' }; } catch (err) { console.error(err); return { ok: false, reason: 'missing' }; }
}

/** { ok, key, name, studio, color, length } of a target, or { ok: false, reason: 'missing' | 'none' }. */
export function describeInstance(target, content = 'doc') {
  if (!renderer) return { ok: false, reason: 'none' };
  try { return renderer.describe(target, content) || { ok: false, reason: 'missing' }; } catch (err) { console.error(err); return { ok: false, reason: 'missing' }; }
}

function trim() {
  let total = 0;
  for (const e of cache.values()) total += e.buffer ? e.buffer.duration : 0;
  for (const [id, e] of cache) {
    if (total <= CACHE_MAX_SEC) break;
    if (e.pending || !e.buffer) continue;
    total -= e.buffer.duration;
    cache.delete(id);
  }
}

async function run(id, target, content, sampleRate, key, chain = []) {
  const e = cache.get(id);
  if (!e || e.pending) return;
  e.pending = true;
  try {
    renderCount++;
    e.renders++;
    const buffer = await renderer.render(target, content, sampleRate, chain);
    e.buffer = buffer || null;
    e.key = key;
    e.status = buffer ? 'ready' : 'empty';
  } catch (err) {
    console.error('[Flexatone] instance render failed:', err);
    e.status = 'error';
    e.key = key;
  } finally {
    e.pending = false;
  }
  cache.delete(id); // most recently used last / 최근 사용을 뒤로
  cache.set(id, e);
  trim();
  notify(target);
}

/**
 * The buffer of a target, as far as it is known now.
 * @returns {{ status: 'ready' | 'rendering' | 'missing' | 'empty' | 'error' | 'none', buffer: AudioBuffer|null, key: string, length: number, stale: boolean }}
 *   'rendering' may still carry the previous buffer (stale = true) so playback continues until the
 *   new one is ready. / 'rendering'이어도 이전 버퍼(stale)를 계속 쓸 수 있음.
 */
export function requestInstanceBuffer({ target, content = 'doc', sampleRate = 48000, immediate = false, chain = [] }) {
  if (chain.includes(baseTarget(target))) return { status: 'cycle', buffer: null, key: 'cycle', length: 0, stale: false }; // A imports B imports A / 순환
  const d = describeInstance(target, content);
  if (!d.ok) return { status: d.reason === 'none' ? 'none' : 'missing', buffer: null, key: '', length: 0, stale: false };
  const id = idOf(target, content, sampleRate);
  let e = cache.get(id);
  if (!e) { e = { key: null, buffer: null, status: 'rendering', pending: false, timer: null, renders: 0 }; cache.set(id, e); }
  if (e.key === d.key && !e.pending) return { status: e.status, buffer: e.buffer, key: d.key, length: e.buffer ? e.buffer.duration : d.length, stale: false };
  if (!e.pending) {
    if (e.timer) clearTimeout(e.timer);
    const first = e.key === null;
    const go = () => { e.timer = null; const now = describeInstance(target, content); if (now.ok) run(id, target, content, sampleRate, now.key, chain); };
    if (first || immediate) go(); else e.timer = setTimeout(go, DEBOUNCE_MS); // edits: wait for the gesture to settle / 편집 중에는 잠시 대기
  }
  return { status: 'rendering', buffer: e.buffer, key: d.key, length: e.buffer ? e.buffer.duration : d.length, stale: !!e.buffer };
}

/** Wait until the buffer of a target is rendered for its current key (offline renders). / 렌더 완료까지 대기 */
export async function awaitInstanceBuffer({ target, content = 'doc', sampleRate = 48000, chain = [] }) {
  for (let i = 0; i < 400; i++) {
    const r = requestInstanceBuffer({ target, content, sampleRate, immediate: true, chain });
    if (r.status !== 'rendering') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  return requestInstanceBuffer({ target, content, sampleRate, immediate: true, chain });
}

/** Forget cached buffers (tests, memory). / 캐시 비우기 */
export function clearInstanceBuffers() {
  for (const e of cache.values()) if (e.timer) clearTimeout(e.timer);
  cache.clear();
}
