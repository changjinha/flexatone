/**
 * Flexatone — core/manager-scenes.js
 * Layer 1 (core): Manager **Scenes** (roadmap M5). A scene is a named set of tracks that are launched together
 * (free play, like ▶ Launch on a track): launching a scene stops the launched tracks that are not in it and starts
 * the ones that are. Scenes can follow each other in list order (each lasts its length) and can be written into the
 * cycle as range solos — the same tool the Extend Ritornello uses — so a live scene sequence becomes an arrangement.
 * Data: `appState.manager.scenes = [{ id, name, tracks: [instId], lenSec (0 = auto), color }]`,
 * `manager.sceneQuant: 'now' | 'end'` (switch at once, or when the current scene's length is over),
 * `manager.sceneFollow: 'off' | 'once' | 'loop'`. Every edit is one undo step.
 * 계층 1 (core): 매니저 씬 — 함께 런치되는 트랙 묶음. 순서대로 이어 재생, 사이클(구간 솔로)로 쓰기.
 */

import { uid } from './math-utils.js';
import { appState, dispatch, registerSelfCheck, withIsolatedState } from './state.js';
import { t } from './i18n.js';
import { normalizeScenes, SCENE_QUANT, SCENE_FOLLOW, SCENE_COLORS, MAX_SCENES } from './scene-config.js';

export { normalizeScenes, SCENE_QUANT, SCENE_FOLLOW };

const mgr = () => appState.manager;

export function listScenes() {
  const m = mgr();
  if (!m) return [];
  const ids = new Set((m.instances || []).map((i) => i.id));
  return normalizeScenes(m.scenes, ids);
}

export const sceneQuant = () => (SCENE_QUANT.includes(mgr()?.sceneQuant) ? mgr().sceneQuant : 'now');
export const sceneFollow = () => (SCENE_FOLLOW.includes(mgr()?.sceneFollow) ? mgr().sceneFollow : 'off');

function commit(type, fn, { history = true, coalesceKey = null } = {}) {
  return dispatch({
    type,
    history,
    coalesceKey,
    scope: ['manager'],
    mutate: (s) => {
      const list = listScenes();
      const res = fn(list, s.manager);
      s.manager.scenes = list;
      return res;
    },
  }).result;
}

/** Add a scene (tracks = given ids, e.g. the launched ones). Returns its id. / 씬 추가 */
export function addScene(tracks = []) {
  return commit('scenes/add', (list) => {
    if (list.length >= MAX_SCENES) return null;
    const used = new Set(list.map((s) => s.name));
    let n = list.length + 1;
    while (used.has(t('scene.name', n))) n++;
    const sc = normalizeScenes([{ tracks, name: t('scene.name', n), color: SCENE_COLORS[list.length % SCENE_COLORS.length] }])[0];
    list.push(sc);
    return sc.id;
  });
}

/** Patch a scene: { name, tracks, lenSec, color }. / 씬 변경 */
export function setScene(id, patch, opts = {}) {
  return commit('scenes/set', (list) => {
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) return false;
    list[i] = normalizeScenes([{ ...list[i], ...patch, id }])[0];
    return true;
  }, opts);
}

/** Add / remove one track from a scene. / 씬에 트랙 넣기·빼기 */
export function toggleSceneTrack(id, instId) {
  const sc = listScenes().find((s) => s.id === id);
  if (!sc) return false;
  const tracks = sc.tracks.includes(instId) ? sc.tracks.filter((x) => x !== instId) : [...sc.tracks, instId];
  return setScene(id, { tracks });
}

export function removeScene(id) {
  return commit('scenes/remove', (list) => { const i = list.findIndex((s) => s.id === id); if (i >= 0) list.splice(i, 1); return i >= 0; });
}

export function moveScene(id, dir) {
  return commit('scenes/move', (list) => {
    const i = list.findIndex((s) => s.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    return true;
  });
}

export function setSceneOptions({ quant, follow } = {}) {
  return dispatch({
    type: 'scenes/options',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      if (quant !== undefined && SCENE_QUANT.includes(quant)) s.manager.sceneQuant = quant;
      if (follow !== undefined && SCENE_FOLLOW.includes(follow)) s.manager.sceneFollow = follow;
    },
  });
}

/**
 * Length of a scene: its own, or (auto) the longest one-pass length of its tracks. `lengthOf(inst)` = seconds
 * (Infinity for a continuous Risset → `fallback`). / 씬 길이 (자동 = 트랙 중 가장 긴 1회 길이)
 */
export function sceneLength(scene, lengthOf, fallback = 8) {
  if (scene.lenSec > 0) return scene.lenSec;
  let L = 0;
  for (const id of scene.tracks) {
    const inst = (mgr()?.instances || []).find((i) => i.id === id);
    if (!inst) continue;
    const x = Number(lengthOf(inst));
    L = Math.max(L, Number.isFinite(x) && x > 0 ? x : fallback);
  }
  return L > 0.05 ? L : fallback;
}

/**
 * Write the scene sequence into the cycle: every track of any scene loops from 0 for the whole sequence, and each
 * scene gets a range [T, T + L) that solos its tracks (tracks in no scene are left alone but silenced by the solos).
 * Older scene ranges are replaced. The cycle becomes fixed at the total length. One undo step.
 * 씬 순서를 사이클로: 씬 트랙은 0부터 전체 길이 동안 반복, 씬마다 그 트랙을 솔로하는 구간. 사이클 길이 고정.
 * @returns {{ total: number, ranges: number }}
 */
export function writeScenesToCycle(lengthOf, fallback = 8) {
  const scenes = listScenes().filter((s) => s.tracks.length);
  if (!scenes.length) return { total: 0, ranges: 0 };
  const lens = scenes.map((s) => sceneLength(s, lengthOf, fallback));
  const total = lens.reduce((a, b) => a + b, 0);
  const used = new Set(scenes.flatMap((s) => s.tracks));
  dispatch({
    type: 'scenes/write',
    history: true,
    scope: ['manager', 'all'],
    mutate: (s) => {
      const m = s.manager;
      // the arrangement before the first write, so "Undo write" can put it back (arrangement fields are not in
      // the undo history) / 처음 쓰기 전 배치 (배치 필드는 실행 취소 대상이 아니므로 직접 보관)
      if (!m.sceneWrite) {
        m.sceneWrite = {
          prev: m.instances.map((i) => ({ id: i.id, start: i.start, length: i.length, loop: i.loop, inCycle: i.inCycle })),
          cycleMode: m.cycleMode, cycleLen: m.cycleLen ?? null,
        };
      }
      for (const inst of m.instances) {
        if (!used.has(inst.id)) continue;
        inst.inCycle = true;
        inst.start = 0;
        inst.loop = true;
        inst.length = Math.round(total * 1000) / 1000;
      }
      m.regions = (m.regions || []).filter((r) => !r.scene);
      let T = 0;
      scenes.forEach((sc, k) => {
        m.regions.push({ id: uid('rg_', 6), kind: 'range', name: t('scene.region', sc.name), t0: Math.round(T * 1000) / 1000, t1: Math.round((T + lens[k]) * 1000) / 1000, solo: [...sc.tracks], mute: [], scene: sc.id });
        T += lens[k];
      });
      m.cycleMode = 'fixed';
      m.cycleLen = Math.round(total * 1000) / 1000;
    },
  });
  return { total, ranges: scenes.length };
}

/** Has the scene sequence been written into the cycle? / 사이클에 쓰였나 */
export const scenesWritten = () => !!mgr()?.sceneWrite;

/** Put the arrangement back as it was before the first write and remove the scene ranges. / 쓰기 되돌리기 */
export function unwriteScenes() {
  const w = mgr()?.sceneWrite;
  if (!w) return false;
  dispatch({
    type: 'scenes/unwrite',
    history: true,
    scope: ['manager', 'all'],
    mutate: (s) => {
      const m = s.manager;
      for (const p of w.prev || []) {
        const inst = m.instances.find((i) => i.id === p.id);
        if (inst) Object.assign(inst, { start: p.start, length: p.length, loop: p.loop, inCycle: p.inCycle });
      }
      m.regions = (m.regions || []).filter((r) => !r.scene);
      m.cycleMode = w.cycleMode === 'fixed' ? 'fixed' : 'auto';
      m.cycleLen = w.cycleLen ?? null;
      m.sceneWrite = null;
    },
  });
  return true;
}

registerSelfCheck('Manager scenes: add / toggle / move, auto length, written to the cycle as range solos', (a) => {
  withIsolatedState(() => {
    appState.manager = { instances: [{ id: 'A', studio: 'draw', length: 4 }, { id: 'B', studio: 'chaos', length: 6 }, { id: 'C', studio: 'risset' }], focus: {}, regions: [], scenes: [], sceneWrite: null };
    const s1 = addScene(['A']);
    const s2 = addScene([]);
    toggleSceneTrack(s2, 'B');
    toggleSceneTrack(s2, 'C');
    a.equal(listScenes().map((s) => s.tracks.join('+')).join(), 'A,B+C', 'membership');
    const len = (inst) => (inst.studio === 'risset' ? Infinity : inst.length);
    a.equal(sceneLength(listScenes()[1], len, 8), 8, 'auto length: the longest track, a continuous Risset counts as 8 s');
    a.equal(sceneLength(listScenes()[0], len, 8), 4);
    setScene(s1, { lenSec: 2 });
    moveScene(s2, -1);
    a.equal(listScenes()[0].id, s2, 'moved up');
    const w = writeScenesToCycle(len, 8);
    a.equal(w.total, 10, '8 + 2 s');
    const rg = appState.manager.regions.filter((r) => r.scene);
    a.equal(rg.map((r) => `${r.t0}-${r.t1}:${r.solo.join('+')}`).join(), '0-8:B+C,8-10:A', 'one solo range per scene');
    a.equal(appState.manager.instances.find((i) => i.id === 'A').loop, true, 'scene tracks loop');
    writeScenesToCycle(len, 8);
    a.equal(appState.manager.regions.filter((r) => r.scene).length, 2, 'writing again replaces the scene ranges');
    a.ok(scenesWritten());
    unwriteScenes();
    a.equal(appState.manager.regions.filter((r) => r.scene).length, 0, 'undo write removes the ranges');
    a.equal(appState.manager.instances.find((i) => i.id === 'A').loop, undefined, 'and restores the arrangement');
    removeScene(s1);
    a.equal(listScenes().length, 1);
  });
}, { group: 'manager' });
