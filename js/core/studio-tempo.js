/**
 * Flexatone — core/studio-tempo.js
 * Layer 1 (core): the Tempo Manager on a **studio's own transport** (header Play of each studio).
 * Same tempo object as the Manager (core/tempo.js), stored per studio in
 * `appState.studioParams._tempo[studio]` — saved with the project, part of undo, never part of the studio
 * document itself (so Manager instance documents and the sound key do not change).
 * 계층 1 (core): 스튜디오 자체 트랜스포트의 템포 매니저. 매니저와 같은 템포 객체를 스튜디오별로
 * studioParams._tempo[studio]에 저장 (프로젝트 저장·실행 취소 포함, 스튜디오 문서와는 분리).
 *
 *   heard rate = studio tempo × (follow ? Manager master × focused track of this studio : 1)
 *   length mode: the studio tempo is solved so the *heard* length is lockSec (the other levels included).
 *   들리는 배속 = 스튜디오 템포 × (따르기면 매니저 마스터 × 이 스튜디오의 포커스 트랙). 길이 모드는 최종 길이를 lockSec로.
 */

import { appState, dispatch, registerSelfCheck, withIsolatedState } from './state.js';
import { normalizeTempoConfig, patchTempo, tempoRate, splitRates, createDefaultTempoConfig } from './tempo.js';

export const STUDIO_TEMPO_KEY = '_tempo';

/** Stored tempo of a studio's own transport, normalised; `follow` defaults to true. / 스튜디오 템포 */
export function getStudioTempo(studio, s = appState) {
  const raw = s.studioParams?.[STUDIO_TEMPO_KEY]?.[studio];
  return { ...normalizeTempoConfig(raw), follow: raw?.follow !== false };
}

/** Manager levels that a following studio hears: [master, focused instance tempo]. / 따르는 매니저 단계 */
function managerLevels(studio, s = appState) {
  const m = s.manager;
  if (!m) return [];
  const id = m.focus?.[studio];
  const inst = id ? (m.instances || []).find((i) => i.id === id) : null;
  return [m.tempo || null, inst?.tempo || null].filter(Boolean);
}

/**
 * Rates of a studio's transport. `naturalSec` = one pass at 1× (resolves the length mode).
 * → { rate, tape, doc, glide, own, track, active } — rate = heard speed, doc = pitch-preserving part,
 * tape = pitch-shifting part, own = this studio's own factor, track = the Manager's factor.
 * 스튜디오 트랜스포트의 배속 (rate = 들리는 속도, doc = 음고 유지분, tape = 음고 동반분).
 */
export function studioRates(studio, naturalSec = null, s = appState) {
  const cfg = getStudioTempo(studio, s);
  const levels = cfg.follow ? managerLevels(studio, s) : [];
  const track = splitRates(...levels);
  let own = tempoRate(cfg, naturalSec);
  // the length is the heard length: divide out what the Manager already does / 최종 길이 기준
  if (cfg.mode === 'length' && cfg.lockSec > 0 && Number(naturalSec) > 0) own = Math.min(8, Math.max(0.1, Number(naturalSec) / cfg.lockSec / track.rate));
  const ownCfg = { ...cfg, mode: 'rate', rate: own };
  const r = splitRates(ownCfg, ...levels);
  return { ...r, own, track: track.rate, active: Math.abs(r.rate - 1) > 1e-9 || Math.abs(r.tape - 1) > 1e-9 };
}

/**
 * Patch the studio's tempo (one undo step; `coalesceKey` merges a drag). `naturalSec` keeps a mode switch
 * from jumping. / 스튜디오 템포 변경 (실행 취소 1단계)
 */
export function setStudioTempo(studio, patch, { naturalSec = null, coalesceKey = null } = {}) {
  return dispatch({
    type: 'studioTempo/set',
    history: true,
    coalesceKey,
    scope: ['tempo', 'transport'],
    mutate: (s) => {
      const cur = getStudioTempo(studio, s);
      const { follow, ...rest } = patch || {};
      const next = { ...patchTempo(cur, rest, naturalSec), follow: follow === undefined ? cur.follow : !!follow };
      const all = { ...(s.studioParams?.[STUDIO_TEMPO_KEY] || {}) };
      all[studio] = next;
      s.studioParams = { ...(s.studioParams || {}), [STUDIO_TEMPO_KEY]: all };
      return next;
    },
  });
}

/** Back to 1× (keeps `follow`). / 1×로 되돌리기 */
export function resetStudioTempo(studio) {
  const follow = getStudioTempo(studio).follow;
  return setStudioTempo(studio, { ...createDefaultTempoConfig(), follow });
}

registerSelfCheck('Studio tempo: own × Manager, length lock solves the heard length, stored apart from the document', (a) => {
  withIsolatedState(() => {
    appState.studioParams = { draw: { strokes: [] } };
    appState.manager = { tempo: { mode: 'rate', rate: 2 }, focus: { draw: 'i1' }, instances: [{ id: 'i1', studio: 'draw', tempo: { mode: 'rate', rate: 1.5 } }] };
    a.near(studioRates('draw').rate, 3, 1e-9, 'follows master × focused track');
    setStudioTempo('draw', { follow: false });
    a.near(studioRates('draw').rate, 1, 1e-9, 'follow off → own tempo only');
    setStudioTempo('draw', { rate: 0.5 });
    a.near(studioRates('draw').rate, 0.5, 1e-9);
    a.ok(!('_tempo' in appState.studioParams.draw), 'the studio document is untouched');
    setStudioTempo('draw', { follow: true, mode: 'length', lockSec: 4 });
    const r = studioRates('draw', 12);
    a.near(12 / r.rate, 4, 1e-9, 'length lock: 12 s plays in 4 s including the Manager levels');
    setStudioTempo('draw', { mode: 'rate', tape: true, rate: 2, follow: false });
    const t = studioRates('draw');
    a.near(t.tape, 2, 1e-9, 'tape part');
    a.near(t.doc, 1, 1e-9, 'no pitch-preserving part left');
    a.equal(getStudioTempo('glissando').follow, true, 'default follows');
    a.near(studioRates('glissando').rate, 2, 1e-9, 'a following studio without a focused track hears the master');
    appState.manager.tempo = { mode: 'rate', rate: 1 };
    a.ok(!studioRates('glissando').active, 'neutral by default');
  });
}, { group: 'tempo' });
