/**
 * Flexatone — core/manager-mods.js
 * Layer 1 (core): actions on the Manager Modulation matrix (`appState.manager.mods`, route format in
 * core/mod-config.js). Every action is one undo step. / 매니저 모듈레이션 매트릭스 액션 (각각 실행 취소 1단계).
 */

import { clamp } from './math-utils.js';
import { appState, dispatch, registerSelfCheck } from './state.js';
import { createMod, normalizeMod, modStatuses, MOD_TARGETS, targetsFor, pulseTrain, followEnvelope, findPeaks, findCrossings, frameAt } from './mod-config.js';

const mgr = () => appState.manager;

/** Routes whose tracks still exist, in list order (normalised copies). / 존재하는 트랙의 라우트 */
export function listMods() {
  const m = mgr();
  if (!m || !Array.isArray(m.mods)) return [];
  const ids = new Set((m.instances || []).map((i) => i.id));
  return m.mods.map((x) => normalizeMod(x, ids)).filter(Boolean);
}

/** [{ mod, status }] in list order. / 상태와 함께 */
export function listModStatuses() {
  const mods = listMods();
  const st = modStatuses(mods);
  return mods.map((mod, i) => ({ mod, status: st[i] }));
}

function commit(type, fn) {
  return dispatch({
    type,
    history: true,
    scope: ['manager', 'all'],
    mutate: (s) => {
      const list = listMods();
      const res = fn(list);
      s.manager.mods = list;
      return res;
    },
  });
}

/**
 * Add a route. Returns { ok, id, status }. A route that would close a loop is still added but
 * reported (it stays inactive until the loop is broken). / 라우트 추가 (순환이면 상태로 알림)
 */
export function addMod(opts) {
  const mod = createMod(opts);
  if (!mod) return { ok: false };
  const param = MOD_TARGETS[mod.dst.param];
  if (param?.trigOnly) mod.src.kind = 'trig';
  const ev = commit('mods/add', (list) => { list.push(mod); return mod.id; });
  const status = listModStatuses().find((x) => x.mod.id === ev.result)?.status || 'ok';
  return { ok: true, id: mod.id, status };
}

/** Patch a route: { on, amount, invert, attackMs, releaseMs, src: {…}, dst: {…} }. / 라우트 변경 */
export function setMod(id, patch, { coalesceKey = null } = {}) {
  return dispatch({
    type: 'mods/set',
    history: true,
    coalesceKey,
    scope: ['manager', 'all'],
    mutate: (s) => {
      const list = listMods();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return false;
      const cur = list[i];
      const next = { ...cur, ...patch, src: { ...cur.src, ...(patch.src || {}) }, dst: { ...cur.dst, ...(patch.dst || {}) } };
      // a new target resets the amount to that target's default / 대상이 바뀌면 양은 그 대상의 기본값
      if (patch.dst?.param && patch.dst.param !== cur.dst.param && patch.amount === undefined) next.amount = MOD_TARGETS[patch.dst.param]?.def ?? cur.amount;
      if (patch.dst?.inst && patch.dst.inst !== cur.dst.inst) {
        const studio = s.manager.instances.find((x) => x.id === patch.dst.inst)?.studio;
        if (studio && !targetsFor(studio).includes(next.dst.param)) { next.dst.param = 'gain'; next.amount = MOD_TARGETS.gain.def; }
      }
      list[i] = normalizeMod(next) || cur;
      s.manager.mods = list;
      return true;
    },
  });
}

export function removeMod(id) {
  return commit('mods/remove', (list) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); return i >= 0; });
}

/** Move a route up (−1) / down (+1) in the list (decides which route of a loop is cut). / 순서 이동 */
export function moveMod(id, dir) {
  return commit('mods/move', (list) => {
    const i = list.findIndex((x) => x.id === id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    return true;
  });
}

registerSelfCheck('Modulation: route statuses (self, loop, retrigger needs a trigger), pulses, follower, peaks, crossings', (a) => {
  const R = (src, dst, kind = 'env', param = 'gain', extra = {}) => normalizeMod({ src: { inst: src, kind, trig: extra.trig }, dst: { inst: dst, param }, ...extra });
  a.equal(modStatuses([R('A', 'A')]).join(), 'self', 'a track cannot hear its own envelope');
  a.equal(modStatuses([R('A', 'A', 'pitch')]).join(), 'ok', 'its own pitch line is fine (document, not sound)');
  a.equal(modStatuses([R('A', 'B'), R('B', 'A')]).join(), 'ok,loop', 'A ducks B, B ducks A → the later is cut');
  a.equal(modStatuses([R('A', 'B', 'pitch'), R('B', 'A', 'pitch')]).join(), 'ok,ok', 'pitch lines never loop');
  a.equal(modStatuses([R('A', 'B', 'env'), R('B', 'C', 'pitch'), R('C', 'A', 'env')]).join(), 'ok,ok,loop', 'a loop through three tracks');
  a.equal(modStatuses([normalizeMod({ src: { inst: 'A', kind: 'pitch' }, dst: { inst: 'B', param: 'retrig' } })]).join(), 'ok', 'retrigger forces a trigger source');
  a.equal(normalizeMod({ src: { inst: 'A', kind: 'pitch' }, dst: { inst: 'B', param: 'retrig' } }).src.kind, 'trig', 'kind becomes trig');
  a.equal(modStatuses([{ ...R('A', 'B'), on: false }]).join(), 'off');
  const p = pulseTrain([1, 2], 0, 100);
  a.near(p(1), 1, 1e-9, 'pulse peak at the event');
  a.near(p(1.1), Math.exp(-1), 1e-6, 'decays with the release time constant');
  a.near(p(0.5), 0, 1e-9, 'nothing before the first event');
  const pa = pulseTrain([1], 50, 100);
  a.near(pa(1.025), 0.5, 1e-9, 'linear attack');
  const env = followEnvelope(new Float32Array([0, 1, 1, 1, 0, 0]), 0.01, 0, 10);
  a.near(env[1], 1, 1e-9, 'instant attack');
  a.near(env[4], Math.exp(-1), 1e-6, 'release time constant');
  a.equal(findPeaks(new Float32Array([-60, -10, -10, -40, -10]), 0.1, -20).map((x) => +x.toFixed(2)).join(), '0.1,0.4', 'peaks re-arm 3 dB below');
  a.equal(findCrossings([{ t: 0, m: 0 }, { t: 1, m: 10 }, { t: 2, m: 0 }, { t: 3, m: 10 }]).map((x) => +x.toFixed(2)).join(), '0.5,2.5', 'upward crossings of the centre');
  a.near(frameAt(new Float32Array([0, 1]), 0.1, 0.05), 0.5, 1e-9, 'frame lookup');
  a.ok(clamp(1, 0, 1) === 1);
}, { group: 'manager' });
