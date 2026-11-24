/**
 * Flexatone — audio/scene-player.js
 * Layer 3 (audio): launches Manager **Scenes** (core/manager-scenes.js) with the mixer's free launch
 * (manager-mixer.js toggleLaunch): a scene starts its tracks and stops the other launched ones.
 *   quant 'now' — switch at once (each track's own fade in / out); 'end' — wait until the playing scene's length
 *   is over (scenes switch on their boundaries, like clip launch quantize).
 *   follow 'once' / 'loop' — when a scene's length is over the next scene in the list starts (the last one stops,
 *   or goes back to the first).
 * 계층 3 (audio): 매니저 씬 런치. now = 바로, end = 현재 씬 길이가 끝날 때. follow = 길이가 끝나면 다음 씬.
 */

import { getAudioCtx } from './audio-engine.js';
import { isLaunched, toggleLaunch, clipLength, onMixerChange, DEFAULT_RISSET_CLIP } from './manager-mixer.js';
import { listInstances } from '../core/manager-state.js';
import { listScenes, sceneLength, sceneQuant, sceneFollow } from '../core/manager-scenes.js';

let current = null; // { id, t0 (ctx seconds), len } / 재생 중인 씬
let queued = null; // { id, at } / 대기 중인 씬
let timer = null;
const listeners = new Set();

const now = () => getAudioCtx()?.currentTime ?? performance.now() / 1000;
const lengthOf = (inst) => clipLength(inst);
const notify = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } };

export function onScenesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** { current: { id, pos, len } | null, queued: { id, in } | null } for the UI. / UI용 상태 */
export function sceneState() {
  const n = now();
  return {
    current: current ? { id: current.id, pos: Math.max(0, n - current.t0), len: current.len } : null,
    queued: queued ? { id: queued.id, in: Math.max(0, queued.at - n) } : null,
  };
}

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

/** Make exactly `ids` launched (others stopped). / 정확히 ids만 런치 */
async function launchSet(ids) {
  const want = new Set(ids);
  const jobs = [];
  for (const inst of listInstances()) {
    const on = isLaunched(inst.id);
    if (on && !want.has(inst.id)) jobs.push(toggleLaunch(inst.id));
    else if (!on && want.has(inst.id)) jobs.push(toggleLaunch(inst.id));
  }
  await Promise.all(jobs);
}

function schedule() {
  clearTimer();
  if (!current) return;
  const n = now();
  if (queued) { timer = setTimeout(() => { void fire(queued.id); }, Math.max(0, queued.at - n) * 1000); return; }
  const follow = sceneFollow();
  if (follow === 'off') return;
  const list = listScenes();
  const i = list.findIndex((s) => s.id === current.id);
  const end = current.t0 + current.len;
  timer = setTimeout(() => {
    const next = list[i + 1] || (follow === 'loop' ? list[0] : null);
    if (next) void fire(next.id);
    else void stopScenes();
  }, Math.max(0, end - n) * 1000);
}

async function fire(id) {
  queued = null;
  const sc = listScenes().find((s) => s.id === id);
  if (!sc) { await stopScenes(); return; }
  await launchSet(sc.tracks);
  current = { id, t0: now(), len: sceneLength(sc, lengthOf, DEFAULT_RISSET_CLIP) };
  schedule();
  notify();
}

/**
 * Launch a scene. With quantize 'end' and a scene playing, it waits for that scene's boundary; launching the
 * queued one again starts it at once. / 씬 런치 (end면 현재 씬 경계까지 대기, 대기 중인 씬을 다시 누르면 즉시)
 */
export async function launchScene(id) {
  if (current && sceneQuant() === 'end' && !(queued && queued.id === id)) {
    const n = now();
    const k = Math.max(1, Math.ceil((n - current.t0) / Math.max(0.05, current.len) - 1e-6));
    queued = { id, at: current.t0 + k * current.len };
    schedule();
    notify();
    return;
  }
  await fire(id);
}

/** Stop every launched track and the scene sequence. / 모든 런치 정지 */
export async function stopScenes() {
  clearTimer();
  current = null;
  queued = null;
  await launchSet([]);
  notify();
}

export const playingSceneId = () => current?.id || null;

// a track stopped by hand while its scene plays does not stop the scene; a scene whose tracks were all
// stopped by hand ends / 손으로 모든 트랙을 멈추면 씬도 끝
onMixerChange(() => {
  if (!current) return;
  if (!listInstances().some((i) => isLaunched(i.id))) { clearTimer(); current = null; queued = null; notify(); }
});
