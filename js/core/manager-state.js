/**
 * Flexatone — core/manager-state.js
 * Layer 0 (core): studio *instances* for the Manager (several Glissando / Risset / Field
 * "apps" at once) and the cycle arrangement. Pure data — no DOM, no audio.
 * 계층 0 (core): 매니저용 스튜디오 인스턴스(여러 개의 글리산도·리세·필드 "앱")와 사이클 배치.
 *
 * Model / 모델
 *   appState.manager = {
 *     instances: [{ id, studio, name, color, doc, gainDb, mute, solo, start, length, loop,
 *                   fadeIn, fadeOut, inCycle }],
 *     focus: { glissando: instId, risset: instId, field: instId },  // shown in the editor
 *     cycleLoop: true, open: false,
 *   }
 *   - Each studio has exactly one *focused* instance. Its live document IS the editor's
 *     document (appState.voices for Glissando, appState.studioParams[studio] otherwise), so every
 *     existing editor keeps working unchanged. Other instances keep their document in `doc`.
 *     스튜디오마다 포커스된 인스턴스 1개 = 에디터 문서. 나머지는 doc에 보관.
 *   - focusInstance() swaps documents in one undoable dispatch.
 *     focusInstance()는 문서를 한 번의 실행 취소 단위로 교체.
 */

import { uid, deepClone, clamp } from './math-utils.js';
import { appState, dispatch, createDefaultVoice, createInstanceDefaults, createDefaultManagerState, registerSelfCheck, withIsolatedState, VOICE_COLORS, MAX_TIME } from './state.js';
import { t } from './i18n.js';
import { tempoRate, combineRates, patchTempo, normalizeTempoConfig, splitRates } from './tempo.js';
import { normalizeTremolo } from './tremolo-config.js';
import { patchWarp } from './warp-config.js';
import { normalizeTake, scaleTake } from './take-config.js';

/** Studios that can be instantiated, in Manager order. / 인스턴스화 가능한 스튜디오 */
export const MANAGER_STUDIOS = Object.freeze(['glissando', 'risset', 'field', 'draw', 'chaos', 'cloud', 'tempo', 'space', 'fractal', 'wave', 'grid']);
/**
 * Studios that always have an instance (created by ensureManager). The others get one only when
 * added from the Manager; their first instance takes over the editor's current document.
 * 항상 인스턴스가 있는 스튜디오. 나머지는 매니저에서 추가할 때만 생기며, 첫 인스턴스는 에디터 문서를 이어받음.
 */
export const BASE_MANAGER_STUDIOS = Object.freeze(['glissando', 'risset', 'field']);
const STUDIO_COLORS = {
  glissando: '#38bdf8', risset: '#a78bfa', field: '#34d399', draw: '#f472b6', chaos: '#fb923c',
  cloud: '#94a3b8', tempo: '#facc15', space: '#22d3ee', fractal: '#c084fc', wave: '#2dd4bf',
  grid: '#e879f9',
};

function mgr() {
  if (!appState.manager) appState.manager = createDefaultManagerState();
  return appState.manager;
}

export function listInstances() {
  return mgr().instances;
}

export function getInstance(id) {
  return mgr().instances.find((i) => i.id === id) || null;
}

export function getFocusedId(studio) {
  return mgr().focus[studio] || null;
}

export function getFocusedInstance(studio) {
  return getInstance(getFocusedId(studio));
}

export function isFocused(inst) {
  return !!inst && mgr().focus[inst.studio] === inst.id;
}

/** Short studio label used in default names. / 기본 이름용 짧은 스튜디오 이름 */
export function studioShortName(studio) {
  return t(`mgr.short.${studio}`);
}

function nextName(studio, instances) {
  const base = studioShortName(studio);
  let n = 1;
  const names = new Set(instances.map((i) => i.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

// Track colours never repeat: the studio's own colour for its first track, then the hue furthest from
// every colour already in use (golden-angle candidates, two lightness levels). Hex, for <input type=color>.
// 트랙 색은 반복되지 않음: 첫 트랙은 스튜디오 색, 그다음은 이미 쓰인 모든 색에서 가장 먼 색상.
function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : null;
}
function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (k) => { const x = (k + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(x - 3, 9 - x, 1)))); };
  return `#${((f(0) << 16) | (f(8) << 8) | f(4)).toString(16).padStart(6, '0')}`;
}
function colorDist(a, b) {
  // weighted RGB distance ("redmean"), good enough to tell track colours apart / 가중 RGB 거리
  const r = (a[0] + b[0]) / 2;
  const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return Math.sqrt((2 + r / 256) * d[0] * d[0] + 4 * d[1] * d[1] + (2 + (255 - r) / 256) * d[2] * d[2]);
}

/**
 * A colour for a new track that no existing track has. `used` = colours in use (hex).
 * 기존 트랙 어느 것과도 겹치지 않는 새 트랙 색.
 */
export function distinctTrackColor(studio, used) {
  const usedRgb = [...used].map(hexToRgb).filter(Boolean);
  const own = STUDIO_COLORS[studio];
  const farEnough = (hex, min) => usedRgb.every((u) => colorDist(u, hexToRgb(hex)) >= min);
  if (own && farEnough(own, 60)) return own;
  const cands = [];
  for (let k = 0; k < 48; k++) cands.push(hslHex((k * 137.508 + 20) % 360, 0.78, k % 2 ? 0.58 : 0.68));
  let best = cands[0];
  let bestD = -1;
  for (const c of cands) {
    const d = usedRgb.length ? Math.min(...usedRgb.map((u) => colorDist(u, hexToRgb(c)))) : Infinity;
    if (d > bestD) { best = c; bestD = d; }
  }
  return best;
}

function instanceColor(studio, instances) {
  return distinctTrackColor(studio, new Set(instances.map((i) => String(i.color || '').toLowerCase())));
}

// --------------------------------------------------------------------------
// Documents / 문서
// --------------------------------------------------------------------------

/** Copy of the editor's live document for a studio. / 에디터의 현재 문서 복사 */
export function captureLiveDoc(studio, s = appState) {
  if (studio === 'glissando') {
    return deepClone({ voices: s.voices, activeVoiceId: s.activeVoiceId, params: s.studioParams?.glissando ?? null });
  }
  const p = s.studioParams?.[studio];
  return p && typeof p === 'object' ? deepClone(p) : null;
}

/** Load a document into the editor slot of its studio (inside a mutate). / 에디터 슬롯에 문서 적재 */
function applyLiveDoc(s, studio, doc) {
  if (studio === 'glissando') {
    const voices = doc && Array.isArray(doc.voices) && doc.voices.length ? deepClone(doc.voices) : [createDefaultVoice(0)];
    s.voices = voices;
    s.activeVoiceId = voices.some((v) => v.id === doc?.activeVoiceId) ? doc.activeVoiceId : voices[0].id;
    s.selectedVoiceIds = [s.activeVoiceId];
    const sp = { ...(s.studioParams || {}) };
    if (doc?.params) sp.glissando = deepClone(doc.params);
    else delete sp.glissando;
    s.studioParams = sp;
    return;
  }
  const sp = { ...(s.studioParams || {}) };
  if (doc) sp[studio] = deepClone(doc);
  else delete sp[studio];
  s.studioParams = sp;
}

/**
 * Document of an instance: the live editor document when focused, else its stored doc.
 * null means "studio defaults". / 인스턴스 문서 (포커스 시 에디터 문서, null = 기본값)
 */
export function getInstanceDoc(inst) {
  if (!inst) return null;
  // A take's forward-clip context carries its document explicitly (audio/manager-mixer.js takeContext)
  // 테이크의 원래 클립 컨텍스트는 문서를 직접 들고 있음
  if ('ctxDoc' in inst) return inst.ctxDoc;
  if (isFocused(inst)) {
    if (inst.studio === 'glissando') return { voices: appState.voices, activeVoiceId: appState.activeVoiceId, params: appState.studioParams?.glissando ?? null };
    return appState.studioParams?.[inst.studio] ?? null;
  }
  return inst.doc;
}

// --------------------------------------------------------------------------
// Actions / 액션
// --------------------------------------------------------------------------

function makeInstance(studio, instances, over = {}) {
  return { ...createInstanceDefaults(studio), id: uid('in_', 6), studio, name: nextName(studio, instances), color: instanceColor(studio, instances), doc: null, ...over };
}

/**
 * Make sure every studio has at least one instance and one focus (idempotent, silent).
 * 스튜디오마다 최소 1개 인스턴스와 포커스 보장 (멱등, 알림 없음).
 */
export function ensureManager() {
  const m = mgr();
  let changed = false;
  for (const studio of MANAGER_STUDIOS) {
    const base = BASE_MANAGER_STUDIOS.includes(studio);
    if (base && !m.instances.some((i) => i.studio === studio)) {
      m.instances.push(makeInstance(studio, m.instances));
      changed = true;
    }
    const first = m.instances.find((i) => i.studio === studio);
    const f = m.focus[studio];
    if (first && !m.instances.some((i) => i.id === f && i.studio === studio)) {
      m.focus[studio] = first.id;
      changed = true;
    } else if (!first && f) {
      delete m.focus[studio];
      changed = true;
    }
  }
  return changed;
}

/**
 * Add an instance. `from` = instance id to duplicate (document + mixer), otherwise defaults.
 * 인스턴스 추가 (from = 복제할 인스턴스 id).
 * @returns {object} the new instance
 */
export function addInstance(studio, { from = null } = {}) {
  if (!MANAGER_STUDIOS.includes(studio)) throw new RangeError(`addInstance: "${studio}"`);
  const src = from ? getInstance(from) : null;
  let created = null;
  dispatch({
    type: 'manager/add',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      const m = s.manager;
      const over = {};
      if (src) {
        over.doc = deepClone(getInstanceDoc(src));
        for (const k of ['gainDb', 'start', 'length', 'loop', 'fadeIn', 'fadeOut', 'inCycle']) over[k] = src[k];
        over.tempo = deepClone(src.tempo);
        if (src.warp) over.warp = deepClone(src.warp);
        if (src.take?.on) over.take = deepClone(src.take); // a duplicate of a take plays the same take / 테이크의 복제는 같은 테이크
        over.name = nextName(studio, m.instances);
      } else if (studio === 'glissando') {
        over.doc = { voices: [createDefaultVoice(0)], activeVoiceId: null, params: null };
      }
      const first = !m.instances.some((i) => i.studio === studio);
      if (first && !src) delete over.doc; // it shows the editor's live document / 에디터 문서를 그대로 사용
      created = makeInstance(studio, m.instances, over);
      const at = src ? m.instances.indexOf(src) + 1 : m.instances.length;
      m.instances.splice(at, 0, created);
      if (first) m.focus[studio] = created.id;
    },
  });
  return created;
}

/**
 * Remove an instance. The last instance of a base studio cannot be removed (the editor needs one);
 * removing the last instance of another studio leaves its editor document as it is.
 * 인스턴스 삭제 (기본 스튜디오의 마지막 인스턴스는 삭제 불가, 그 외 스튜디오는 에디터 문서 유지).
 * @returns {boolean}
 */
export function removeInstance(id) {
  const inst = getInstance(id);
  if (!inst) return false;
  const same = listInstances().filter((i) => i.studio === inst.studio);
  if (same.length <= 1 && BASE_MANAGER_STUDIOS.includes(inst.studio)) return false;
  if (isFocused(inst) && same.length > 1) focusInstance(same.find((i) => i.id !== id).id);
  dispatch({
    type: 'manager/remove',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      s.manager.instances = s.manager.instances.filter((i) => i.id !== id);
      if (s.manager.focus[inst.studio] === id) delete s.manager.focus[inst.studio];
    },
  });
  return true;
}

/**
 * Show an instance in its studio's editor: store the editor document into the previously
 * focused instance and load this one's. Undoable. / 인스턴스를 에디터에 표시 (문서 교체)
 * @returns {boolean} true when the focus changed
 */
export function focusInstance(id) {
  const inst = getInstance(id);
  if (!inst || isFocused(inst)) return false;
  dispatch({
    type: 'manager/focus',
    history: true,
    scope: ['all', 'manager'],
    mutate: (s) => {
      const m = s.manager;
      const prev = m.instances.find((i) => i.id === m.focus[inst.studio]);
      if (prev) prev.doc = captureLiveDoc(inst.studio, s);
      applyLiveDoc(s, inst.studio, inst.doc);
      m.focus[inst.studio] = inst.id;
    },
  });
  return true;
}

const MIXER_LIMITS = {
  gainDb: [-60, 12],
  start: [0, MAX_TIME],
  length: [0.1, MAX_TIME],
  fadeIn: [0, 10],
  fadeOut: [0, 10],
};

/**
 * Change mixer / arrangement fields (name, color, gainDb, mute, solo, start, length, loop,
 * fadeIn, fadeOut, inCycle). Not undoable — like moving a fader. / 믹서 필드 변경 (실행 취소 없음)
 */
export function setInstance(id, patch) {
  return dispatch({
    type: 'manager/set',
    scope: ['manager'],
    mutate: (s) => {
      const inst = s.manager.instances.find((i) => i.id === id);
      if (!inst) return;
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'length' && v === null) inst.length = null;
        else if (MIXER_LIMITS[k]) { if (Number.isFinite(Number(v))) inst[k] = clamp(Number(v), ...MIXER_LIMITS[k]); }
        else if (k === 'name') inst.name = String(v).slice(0, 40) || inst.name;
        else if (k === 'color') inst.color = String(v);
        else if (k === 'tempo') inst.tempo = patchTempo(inst.tempo, v);
        else if (k === 'tremolo') inst.tremolo = normalizeTremolo({ ...inst.tremolo, ...(v && typeof v === 'object' ? v : {}) });
        else if (['mute', 'solo', 'loop', 'inCycle'].includes(k)) inst[k] = !!v;
      }
    },
  });
}

// --------------------------------------------------------------------------
// Tempo Manager / 템포 매니저
// --------------------------------------------------------------------------

/** Master tempo config (normalized). / 마스터 템포 */
export function getMasterTempo() {
  return normalizeTempoConfig(mgr().tempo);
}

/** Speed factor of the master tempo. / 마스터 배속 */
export function masterRate() {
  return tempoRate(mgr().tempo);
}

/** Speed the instance's *content* plays at: master × instance. / 콘텐츠 재생 배속 = 마스터 × 인스턴스 */
export function contentRate(inst) {
  return combineRates(mgr().tempo, inst?.tempo);
}

/** { rate, tape, doc, glide } of a track: master × instance, split into tape and pitch-preserving parts. */
export function channelRates(inst) {
  return splitRates(mgr().tempo, inst?.tempo);
}

const rnd = (x) => Math.round(x * 1e6) / 1e6;

/** Cycle-time rescale of a region (range or shape) by `k`. / 구간 시간 재스케일 */
function scaleRegionTime(r, k) {
  r.t0 = rnd(r.t0 * k);
  r.t1 = rnd(r.t1 * k);
  if (r.kind === 'shape') {
    for (const b of r.lobes || []) {
      b.t = b.t.map((x) => x * k);
      if (Number.isFinite(b.t0)) b.t0 *= k;
      if (Number.isFinite(b.t1)) b.t1 *= k;
    }
  }
}

/**
 * Change the master tempo. Like a DAW tempo change, the whole arrangement follows: every start,
 * explicit length, fade and range is rescaled by oldRate / newRate (instances keep their own
 * tempo), so the cycle gets shorter / longer by the same factor. `scaleArrangement: false`
 * changes only the content speed. Not undoable — like moving a fader.
 * 마스터 템포 변경. DAW처럼 배치(시작·길이·페이드·구간)도 oldRate/newRate로 함께 재스케일.
 * @returns {number} the new master rate
 */
export function setManagerTempo(patch, { scaleArrangement = true } = {}) {
  dispatch({
    type: 'manager/tempo',
    scope: ['manager'],
    mutate: (s) => {
      const m = s.manager;
      const oldRate = tempoRate(m.tempo);
      m.tempo = patchTempo(m.tempo, patch);
      const k = oldRate / tempoRate(m.tempo);
      if (!scaleArrangement || Math.abs(k - 1) < 1e-9) return;
      for (const inst of m.instances) {
        inst.start = rnd(clamp(inst.start * k, 0, MAX_TIME));
        if (inst.length !== null && inst.length !== undefined) inst.length = rnd(clamp(inst.length * k, MIXER_LIMITS.length[0], MAX_TIME));
        inst.fadeIn = rnd(clamp(inst.fadeIn * k, ...MIXER_LIMITS.fadeIn));
        inst.fadeOut = rnd(clamp(inst.fadeOut * k, ...MIXER_LIMITS.fadeOut));
        if (inst.take?.on) scaleTake(inst.take, k); // takes are arrangement times too / 테이크도 배치 시간
      }
      for (const r of m.regions || []) scaleRegionTime(r, k);
      if (Number.isFinite(m.cycleLen)) m.cycleLen = rnd(clamp(m.cycleLen * k, CYCLE_LEN_LIMITS[0], CYCLE_LEN_LIMITS[1]));
    },
  });
  return masterRate();
}

/** Move an instance up (-1) or down (+1) in the list (= serial order). / 순서 이동 */
export function moveInstance(id, dir) {
  return dispatch({
    type: 'manager/move',
    scope: ['manager'],
    mutate: (s) => {
      const list = s.manager.instances;
      const i = list.findIndex((x) => x.id === id);
      const j = i + Math.sign(dir);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    },
  });
}

const CYCLE_LEN_LIMITS = [0.1, MAX_TIME];

/**
 * Manager-level prefs: { cycleLoop, open, cycleMode, cycleLen }.
 *   cycleMode 'auto'  = the cycle is as long as the whole arrangement (last clip end).
 *   cycleMode 'fixed' = the cycle is `cycleLen` seconds: clips are cut there, and looping clips
 *                       without their own length repeat up to it.
 * 매니저 설정. cycleMode 'auto' = 전체 길이, 'fixed' = cycleLen 초 (클립을 자르고, 길이 미지정 반복 클립은 끝까지 채움).
 */
export function setManagerPref(patch) {
  return dispatch({
    type: 'manager/pref',
    scope: ['manager'],
    mutate: (s) => {
      if ('cycleLoop' in patch) s.manager.cycleLoop = !!patch.cycleLoop;
      if ('open' in patch) s.manager.open = !!patch.open;
      if ('cycleMode' in patch) s.manager.cycleMode = patch.cycleMode === 'fixed' ? 'fixed' : 'auto';
      if ('cycleLen' in patch && Number.isFinite(Number(patch.cycleLen))) s.manager.cycleLen = rnd(clamp(Number(patch.cycleLen), ...CYCLE_LEN_LIMITS));
    },
  });
}

/**
 * Arrange the cycle. 'parallel' = every clip starts at 0. 'serial' = clips follow each other in
 * list order (only instances in the cycle), `lengthOf(inst)` gives each clip's played length.
 * 사이클 배치: parallel = 모두 0초 시작, serial = 목록 순서대로 이어서.
 */
export function arrangeCycle(mode, lengthOf, { gap = 0 } = {}) {
  return dispatch({
    type: 'manager/arrange',
    scope: ['manager'],
    mutate: (s) => {
      let at = 0;
      for (const inst of s.manager.instances) {
        if (!inst.inCycle) continue;
        if (mode === 'parallel') { inst.start = 0; continue; }
        inst.start = Math.round(at * 1000) / 1000;
        at += Math.max(0, Number(lengthOf(inst)) || 0) + gap;
      }
    },
  });
}

// --------------------------------------------------------------------------
// Ranges (local solo / mute) / 구간 (로컬 솔로·뮤트)
// --------------------------------------------------------------------------

export function listRegions() {
  const m = mgr();
  if (!Array.isArray(m.regions)) m.regions = [];
  return m.regions;
}

/** Add a cycle-time range [t0, t1). Returns the region. / 사이클 구간 추가 */
export function addRegion(t0, t1) {
  const a = clamp(Math.min(t0, t1), 0, MAX_TIME);
  const b = clamp(Math.max(t0, t1), 0, MAX_TIME);
  if (b - a < 0.01) return null;
  const r = { id: uid('rg_', 6), kind: 'range', name: `${t('mgr.range')} ${listRegions().length + 1}`, t0: a, t1: b, solo: [], mute: [] };
  dispatch({ type: 'manager/region-add', scope: ['manager'], mutate: (s) => { s.manager.regions = [...listRegions(), r]; } });
  return r;
}

/**
 * Add a non-rectangular region made of enclosed lobes (core/shape-select.js). / 비사각형 영역 추가
 * @param {Array<{t:number[],lo:number[],hi:number[]}>} lobes
 */
export function addShapeRegion(lobes) {
  const list = (lobes || []).filter((b) => b && b.t?.length >= 2);
  if (!list.length) return null;
  const t0 = Math.min(...list.map((b) => b.t[0]));
  const t1 = Math.max(...list.map((b) => b.t[b.t.length - 1]));
  const n = listRegions().filter((r) => r.kind === 'shape').length + 1;
  const r = { id: uid('rg_', 6), kind: 'shape', name: `${t('mgr.shape')} ${n}`, t0, t1, lobes: deepClone(list), solo: [], mute: [] };
  dispatch({ type: 'manager/region-add', scope: ['manager'], mutate: (s) => { s.manager.regions = [...listRegions(), r]; } });
  return r;
}

export function setRegion(id, patch) {
  return dispatch({
    type: 'manager/region-set',
    scope: ['manager'],
    mutate: () => {
      const r = listRegions().find((x) => x.id === id);
      if (!r) return;
      if ('name' in patch) r.name = String(patch.name).slice(0, 40);
      if (r.kind === 'shape') return; // shapes are moved only by re-selecting / 모양 영역은 시간 편집 불가
      if ('t0' in patch && Number.isFinite(Number(patch.t0))) r.t0 = clamp(Number(patch.t0), 0, MAX_TIME);
      if ('t1' in patch && Number.isFinite(Number(patch.t1))) r.t1 = clamp(Number(patch.t1), 0, MAX_TIME);
      if (r.t1 < r.t0) [r.t0, r.t1] = [r.t1, r.t0];
      if (r.t1 - r.t0 < 0.01) r.t1 = r.t0 + 0.01;
    },
  });
}

export function removeRegion(id) {
  return dispatch({ type: 'manager/region-remove', scope: ['manager'], mutate: (s) => { s.manager.regions = listRegions().filter((r) => r.id !== id); } });
}

/** Rule of an instance inside a region: 'solo' | 'mute' | null. / 구간 안 인스턴스 규칙 */
export function regionRule(region, instId) {
  if (region.solo.includes(instId)) return 'solo';
  if (region.mute.includes(instId)) return 'mute';
  return null;
}

/** Set the rule ('solo' | 'mute' | null), or cycle none → solo → mute → none when rule is undefined. */
export function setRegionRule(regionId, instId, rule) {
  return dispatch({
    type: 'manager/region-rule',
    scope: ['manager'],
    mutate: () => {
      const r = listRegions().find((x) => x.id === regionId);
      if (!r) return;
      const cur = regionRule(r, instId);
      const next = rule === undefined ? (cur === null ? 'solo' : cur === 'solo' ? 'mute' : null) : rule;
      r.solo = r.solo.filter((x) => x !== instId);
      r.mute = r.mute.filter((x) => x !== instId);
      if (next === 'solo') r.solo.push(instId);
      if (next === 'mute') r.mute.push(instId);
    },
  });
}

/**
 * Cycle-time spans in which an instance is silenced by the ranges (sorted, merged):
 * muted in a range, or a range has solos that do not include it.
 * 구간 규칙으로 인스턴스가 무음이 되는 사이클 시간 구간 (정렬·병합).
 * @returns {Array<[number, number]>}
 */
export function silencedSpans(instId, regions = listRegions(), cycleLen = Infinity) {
  const spans = [];
  for (const r of regions) {
    if (r.kind === 'shape') continue; // pitch masks: core/shape-select.js / 음고 마스크는 별도
    const off = r.mute.includes(instId) || (r.solo.length > 0 && !r.solo.includes(instId));
    if (!off) continue;
    const a = Math.max(0, r.t0);
    const b = Math.min(cycleLen, r.t1);
    if (b - a > 1e-4) spans.push([a, b]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

/** Solo-aware audibility. / 솔로를 고려한 발음 여부 */
export function isInstanceAudible(inst, instances = listInstances()) {
  if (inst.mute || inst.warp?.on) return false; // a warp track bends the others instead of sounding / 곡률 트랙은 소리 내지 않음
  const anySolo = instances.some((i) => i.solo && !i.warp?.on);
  return anySolo ? !!inst.solo : true;
}

// --------------------------------------------------------------------------
// Warp (pitch-space curvature) / 곡률
// --------------------------------------------------------------------------

/** Is this track a working warp source? (on, not muted — M switches the bend off). / 곡률 출처인가 */
export function isWarpSource(inst) {
  return !!(inst && inst.warp?.on && !inst.mute);
}

/**
 * Warp sources that bend `target`, in track order: on, not muted, in the cycle, and either aimed at
 * every track (targets = []) or at this one. A warp track is never a target.
 * 대상 트랙을 휘는 곡률 출처 (트랙 순서). 곡률 트랙은 대상이 되지 않음.
 */
export function warpSourcesFor(target, instances = listInstances()) {
  if (!target || target.warp?.on) return [];
  // A take made by Extend may keep only the bend of the Warp tracks that were checked (take.warps) / 테이크는 선택된 곡률만 유지할 수 있음
  const only = Array.isArray(target.warpOnly) ? new Set(target.warpOnly) : null;
  return instances.filter((i) => i.id !== target.id && isWarpSource(i) && i.inCycle && (!only || only.has(i.id)) && (!i.warp.targets.length || i.warp.targets.includes(target.id)));
}

/**
 * Change the warp setting of a track (undoable; drags of one field coalesce).
 * 트랙 곡률 설정 변경 (실행 취소 가능, 같은 필드 드래그는 병합).
 */
export function setInstanceWarp(id, patch, { coalesce = null } = {}) {
  return dispatch({
    type: 'manager/warp',
    history: true,
    coalesceKey: coalesce ? `warp:${id}:${coalesce}` : null,
    scope: ['manager'],
    mutate: (s) => {
      const inst = s.manager.instances.find((i) => i.id === id);
      if (inst) inst.warp = patchWarp(inst.warp, patch, inst.studio);
    },
  });
}

// --------------------------------------------------------------------------
// Take (a clip as it sounded, optionally reversed) / 테이크
// --------------------------------------------------------------------------

/**
 * Change the take setting of a track (undoable): e.g. { rev: false } to hear a retrograde forwards.
 * 트랙의 테이크 설정 변경 (실행 취소 가능).
 */
export function setInstanceTake(id, patch) {
  return dispatch({
    type: 'manager/take',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      const inst = s.manager.instances.find((i) => i.id === id);
      if (inst) inst.take = normalizeTake({ ...(inst.take || {}), ...(patch || {}) });
    },
  });
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Manager: instances, focus swap, arrange', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    a.equal(listInstances().length, 3, 'one instance per studio');
    a.ok(BASE_MANAGER_STUDIOS.every((s) => getFocusedInstance(s)?.studio === s), 'every base studio focused');
    // Two Risset docs swap cleanly / 리세 문서 2개가 교체됨
    appState.studioParams = { ...appState.studioParams, risset: { voiceCount: 7 } };
    const r1 = getFocusedInstance('risset');
    const r2 = addInstance('risset');
    a.ok(r2 && r2.studio === 'risset' && r2.id !== r1.id, 'added');
    a.equal(getInstanceDoc(r2), null, 'new instance uses defaults');
    focusInstance(r2.id);
    a.equal(appState.studioParams.risset, undefined, 'editor shows r2 defaults');
    a.equal(getInstance(r1.id).doc.voiceCount, 7, 'r1 doc stored');
    appState.studioParams = { ...appState.studioParams, risset: { voiceCount: 3 } };
    focusInstance(r1.id);
    a.equal(appState.studioParams.risset.voiceCount, 7, 'r1 restored');
    a.equal(getInstance(r2.id).doc.voiceCount, 3, 'r2 edits kept');
    // Glissando swap keeps voices apart / 글리산도 보이스 분리
    const g1 = getFocusedInstance('glissando');
    const before = appState.voices.length;
    const g2 = addInstance('glissando', { from: g1.id });
    focusInstance(g2.id);
    a.equal(appState.voices.length, before, 'duplicate copies voices');
    appState.voices = [...appState.voices, createDefaultVoice(5)];
    focusInstance(g1.id);
    a.equal(appState.voices.length, before, 'g1 voices untouched');
    a.equal(getInstance(g2.id).doc.voices.length, before + 1, 'g2 has its extra voice');
    // Cannot remove the last instance of a studio / 마지막 인스턴스는 삭제 불가
    const f = getFocusedInstance('field');
    a.equal(removeInstance(f.id), false, 'last field kept');
    a.equal(removeInstance(g1.id), true, 'focused glissando removed');
    a.equal(getFocusedId('glissando'), g2.id, 'focus moved');
    // Arrange / 배치
    arrangeCycle('serial', () => 2);
    const starts = listInstances().filter((i) => i.inCycle).map((i) => i.start);
    a.equal(starts.join(), starts.map((_, k) => k * 2).join(), 'serial starts');
    arrangeCycle('parallel', () => 2);
    a.ok(listInstances().every((i) => i.start === 0), 'parallel starts');
    const rg = addRegion(1, 3);
    setRegionRule(rg.id, r1.id); // → solo
    a.equal(regionRule(listRegions()[0], r1.id), 'solo', 'rule cycles to solo');
    a.equal(silencedSpans(r1.id).length, 0, 'soloed instance sounds');
    a.equal(JSON.stringify(silencedSpans(r2.id)), '[[1,3]]', 'others silenced in the range');
    setRegionRule(rg.id, r1.id); // → mute
    a.equal(JSON.stringify(silencedSpans(r1.id)), '[[1,3]]', 'muted in the range');
    a.equal(silencedSpans(r2.id).length, 0, 'no solo → others sound');
    addRegion(2, 5);
    setRegionRule(listRegions()[1].id, r1.id, 'mute');
    a.equal(JSON.stringify(silencedSpans(r1.id, listRegions(), 4)), '[[1,4]]', 'merged and clipped to the cycle');
    setInstance(r1.id, { solo: true });
    a.ok(isInstanceAudible(getInstance(r1.id)) && !isInstanceAudible(getInstance(r2.id)), 'solo');
  });
}, { group: 'state' });

registerSelfCheck('Manager: tempo rescales the arrangement, instance tempo multiplies', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const [g, r] = [getFocusedInstance('glissando'), getFocusedInstance('risset')];
    setInstance(g.id, { start: 2, length: 4, fadeIn: 0.2, fadeOut: 0.4 });
    const rg = addRegion(1, 3);
    a.equal(masterRate(), 1, 'master neutral');
    setManagerTempo({ rate: 2 });
    a.equal(masterRate(), 2, 'master rate set');
    a.equal(getInstance(g.id).start, 1, 'start halves');
    a.equal(getInstance(g.id).length, 2, 'explicit length halves');
    a.equal(getInstance(g.id).fadeIn, 0.1, 'fade halves');
    a.equal(getInstance(r.id).length, 4, 'risset clip length halves (8 → 4)');
    a.equal(JSON.stringify([listRegions()[0].t0, listRegions()[0].t1]), '[0.5,1.5]', 'ranges halve');
    a.equal(getInstance(g.id).length === null, false, 'explicit length kept');
    setInstance(g.id, { tempo: { rate: 1.5 } });
    a.near(contentRate(getInstance(g.id)), 3, 1e-12, 'content rate = master × instance');
    a.equal(getInstance(g.id).start, 1, 'instance tempo never moves the arrangement');
    setManagerTempo({ rate: 1 });
    a.equal(getInstance(g.id).start, 2, 'back to 1× restores start');
    a.equal(getInstance(g.id).length, 4, 'back to 1× restores length');
    setManagerTempo({ mode: 'bpm', bpm: 60 }, { scaleArrangement: false });
    a.equal(masterRate(), 0.5, '60 / 120 BPM = 0.5×');
    a.equal(getInstance(g.id).start, 2, 'scaleArrangement:false leaves the arrangement');
    a.ok(rg && listRegions()[0].t1 === 3, 'region untouched');
    const dup = addInstance('glissando', { from: g.id });
    a.near(tempoRate(dup.tempo), 1.5, 1e-12, 'duplicate keeps its tempo');
  });
}, { group: 'state' });

registerSelfCheck('Manager: every studio can be added, cycle length mode', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    a.equal(listInstances().length, BASE_MANAGER_STUDIOS.length, 'only base studios are created');
    a.equal(getFocusedId('chaos'), null, 'no chaos instance yet');
    appState.studioParams = { ...appState.studioParams, chaos: { voices: 5 } };
    const c1 = addInstance('chaos');
    a.equal(getFocusedId('chaos'), c1.id, 'first chaos instance is focused');
    a.equal(getInstanceDoc(c1).voices, 5, 'it shows the editor document');
    const c2 = addInstance('chaos');
    a.ok(getFocusedId('chaos') === c1.id && getInstanceDoc(c2) === null, 'second one uses defaults');
    focusInstance(c2.id);
    a.equal(getInstance(c1.id).doc.voices, 5, 'c1 doc stored on swap');
    a.equal(removeInstance(c2.id), true, 'focused chaos removed');
    a.equal(removeInstance(c1.id), true, 'last chaos removed (not a base studio)');
    a.equal(getFocusedId('chaos'), null, 'focus cleared');
    setManagerPref({ cycleMode: 'fixed', cycleLen: 6 });
    a.ok(appState.manager.cycleMode === 'fixed' && appState.manager.cycleLen === 6, 'fixed length stored');
    setManagerTempo({ rate: 2 });
    a.equal(appState.manager.cycleLen, 3, 'master tempo rescales the fixed length');
    setManagerPref({ cycleMode: 'bogus' });
    a.equal(appState.manager.cycleMode, 'auto', 'unknown mode → auto');
  });
}, { group: 'state' });
