/**
 * Flexatone — studios/registry.js
 * Layer 2 (studios): plugin registry for sub-studios (Glissando, Risset, Field, …).
 * 계층 2 (studios): 하위 스튜디오 플러그인 레지스트리.
 *
 * A studio plugin is a plain object (contract below). The registry validates it, stores its
 * parameters in `appState.studioParams[id]` (so they are saved, loaded and undoable), and
 * exposes safe hooks the UI calls: renderOverlay (draw guides on mainCanvas) and
 * generateVoices / bakeVoices (emit standard Voice objects into the shared voice list).
 * 스튜디오 플러그인을 검증·보관하고, 파라미터는 appState.studioParams에 저장하며,
 * UI가 호출하는 안전한 훅(renderOverlay, generateVoices, bakeVoices)을 제공.
 *
 * Imports: core/*, modules/*. Never ui/* or audio/*.
 */

import { clamp, lerp, deepClone } from '../core/math-utils.js';
import { midiToFreq, freqToMidi, noteNameToMidi } from '../core/units.js';
import { pickLocalized } from '../core/i18n.js';
import {
  appState,
  dispatch,
  setStudio,
  createDefaultVoice,
  normalizeVoice,
  ENGINE_IDS,
  STUDIO_IDS,
  STUDIO_SLUG,
  registerSelfCheck,
  withIsolatedState,
  createInitialState,
  resetHistory,
  canUndo,
  undo,
} from '../core/state.js';
import { evaluateCurveObjectY, captureCurveToCustomPoints, createMorphNode } from '../modules/curve-engine.js';

export const MAX_GENERATED_VOICES = 64;

/**
 * @typedef {object} StudioPlugin
 * @property {string} id                                 unique slug, e.g. 'risset'
 * @property {{en:string, ko:string}} name               bilingual display name
 * @property {{en:string, ko:string}} [description]
 * @property {number} [order]                            tab order (lower first)
 * @property {'ready'|'planned'} [status]
 * @property {boolean} [usesVoiceEditor]                 true → show the shared voice editor panels
 * @property {Array<object>} schema                      parameter schema (same shape as PARAM_SCHEMAS)
 * @property {() => object} defaultParams
 * @property {(ctx: CanvasRenderingContext2D, view: StudioView, params: object, state: object) => void} [renderOverlay]
 * @property {(params: object, helpers: StudioHelpers) => Array<object>} [generateVoices]
 * @property {(helpers: StudioHelpers) => void} [onActivate]
 * @property {(helpers: StudioHelpers) => void} [onDeactivate]
 *
 * @typedef {object} StudioView   supplied by ui/canvases.js
 * @property {object} viewport    appState.viewport
 * @property {'piano'|'norm'} viewMode
 * @property {(sec:number) => number} timeToX
 * @property {(midi:number) => number} midiToY
 * @property {object} m           canvas metrics { width, height, plotX, plotY, plotW, plotH, … }
 */

const HOOKS = ['renderOverlay', 'generateVoices', 'onActivate', 'onDeactivate'];

/**
 * Validate a plugin against the contract. Returns a list of problems (empty = valid).
 * 플러그인 계약 검증 (빈 배열 = 유효).
 */
export function validateStudioPlugin(plugin) {
  const errs = [];
  if (!plugin || typeof plugin !== 'object') return ['plugin must be an object'];
  if (typeof plugin.id !== 'string' || !STUDIO_SLUG.test(plugin.id)) errs.push('id must be a lowercase slug');
  if (!plugin.name || typeof plugin.name.en !== 'string' || typeof plugin.name.ko !== 'string') {
    errs.push('name must provide { en, ko } strings');
  }
  if (!Array.isArray(plugin.schema)) errs.push('schema must be an array');
  if (typeof plugin.defaultParams !== 'function') errs.push('defaultParams must be a function');
  for (const h of HOOKS) {
    if (plugin[h] !== undefined && typeof plugin[h] !== 'function') errs.push(`${h} must be a function`);
  }
  if (plugin.status !== undefined && plugin.status !== 'ready' && plugin.status !== 'planned') {
    errs.push("status must be 'ready' or 'planned'");
  }
  if (!errs.length) {
    try {
      const p = plugin.defaultParams();
      if (!p || typeof p !== 'object' || Array.isArray(p)) errs.push('defaultParams() must return an object');
      else JSON.stringify(p);
    } catch (e) {
      errs.push(`defaultParams() threw or is not JSON-safe: ${e.message}`);
    }
  }
  return errs;
}

/** Helpers handed to plugin hooks (frozen). / 플러그인 훅에 전달되는 헬퍼 */
export function createStudioHelpers(state = appState, { startIndex = state.voices.length } = {}) {
  return Object.freeze({
    createDefaultVoice,
    normalizeVoice,
    createMorphNode,
    captureCurveToCustomPoints,
    evaluateCurveObjectY,
    midiToFreq,
    freqToMidi,
    noteNameToMidi,
    clamp,
    lerp,
    deepClone,
    ENGINE_IDS,
    existingVoiceCount: state.voices.length,
    /** Index the first generated voice will occupy (0 for replace, voice count for append). */
    startIndex,
  });
}

/**
 * Create an independent registry (the app uses the `StudioRegistry` singleton; tests use
 * their own instance). Each registry binds to a state object (default: appState).
 * 독립 레지스트리 생성 (앱은 싱글턴 StudioRegistry 사용).
 */
export function createStudioRegistry({ state = appState } = {}) {
  const plugins = new Map();
  const listeners = new Set();
  const overlayErrorsLogged = new Set();

  const emit = (type, id) => {
    for (const fn of [...listeners]) {
      try {
        fn({ type, id });
      } catch (err) {
        console.error('[Flexatone] studio registry listener error:', err);
      }
    }
  };

  // A registry bound to a scratch state must never write into the real appState.
  // 임시 상태에 묶인 레지스트리는 실제 appState에 쓰지 않음.
  const commit = (opts) => {
    if (state === appState) return dispatch(opts);
    const result = opts.mutate(state, opts.payload);
    return { type: opts.type, scope: new Set(), payload: opts.payload, result, historyChanged: false };
  };
  let activeId = null;

  const requirePlugin = (id) => {
    const p = plugins.get(id);
    if (!p) throw new RangeError(`StudioRegistry: unknown studio "${id}"`);
    return p;
  };

  const api = {
    /**
     * Register a plugin. Throws on an invalid contract or duplicate id (unless replace).
     * @returns {StudioPlugin} the stored (frozen) plugin
     */
    register(plugin, { replace = false } = {}) {
      const errs = validateStudioPlugin(plugin);
      if (errs.length) throw new TypeError(`StudioRegistry: invalid plugin "${plugin?.id}": ${errs.join('; ')}`);
      if (plugins.has(plugin.id) && !replace) throw new Error(`StudioRegistry: "${plugin.id}" already registered`);
      const stored = Object.freeze({
        order: 100,
        status: 'ready',
        usesVoiceEditor: false,
        description: { en: '', ko: '' },
        ...plugin,
      });
      plugins.set(stored.id, stored);
      emit('register', stored.id);
      return stored;
    },

    unregister(id) {
      const ok = plugins.delete(id);
      if (ok) emit('unregister', id);
      return ok;
    },

    has: (id) => plugins.has(id),
    get: (id) => plugins.get(id) || null,

    /** Registered plugins sorted by order, then id. */
    list() {
      return [...plugins.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    },

    /**
     * Tabs for the header: built-in slots (STUDIO_IDS) first — 'planned' when nothing is
     * registered for them — then any extra registered studios.
     * 헤더 탭 목록: 기본 슬롯(미등록 시 planned) + 추가 등록 스튜디오.
     */
    listTabs(lang) {
      const tabs = STUDIO_IDS.map((id) => {
        const p = plugins.get(id);
        return {
          id,
          plugin: p || null,
          status: p ? p.status : 'planned',
          label: p ? pickLocalized(p.name, lang) : null, // null → UI falls back to i18n `studio.<id>`
        };
      });
      for (const p of api.list()) {
        if (!STUDIO_IDS.includes(p.id)) tabs.push({ id: p.id, plugin: p, status: p.status, label: pickLocalized(p.name, lang) });
      }
      return tabs;
    },

    /** Current params = defaultParams() overlaid with saved state.studioParams[id]. */
    getParams(id) {
      const p = plugins.get(id);
      if (!p) return {}; // planned slot or stale id: nothing to edit / 미등록 스튜디오
      const saved = state.studioParams?.[id];
      return { ...p.defaultParams(), ...(saved && typeof saved === 'object' ? deepClone(saved) : {}) };
    },

    /** Merge a patch into the studio's params (undoable). / 파라미터 변경 (실행 취소 가능) */
    setParams(id, patch, { history = true, coalesceKey = null } = {}) {
      requirePlugin(id);
      const next = { ...api.getParams(id), ...deepClone(patch) };
      return commit({
        type: 'studio/params',
        history,
        coalesceKey,
        scope: ['studio', 'panels', 'canvas'],
        payload: { id, patch },
        mutate: (s) => {
          s.studioParams = { ...(s.studioParams || {}), [id]: next };
          return next;
        },
      });
    },

    resetParams(id) {
      const p = requirePlugin(id);
      return commit({
        type: 'studio/params-reset',
        history: true,
        scope: ['studio', 'panels', 'canvas'],
        payload: { id },
        mutate: (s) => {
          s.studioParams = { ...(s.studioParams || {}), [id]: p.defaultParams() };
        },
      });
    },

    /**
     * Draw the studio's overlay. Errors are caught (logged once per studio) so a faulty
     * plugin never breaks canvas rendering. Returns true if the hook ran successfully.
     * 오버레이 그리기 (오류는 격리, 스튜디오당 1회 로그).
     */
    renderOverlay(id, ctx, view, opts = {}) {
      const p = plugins.get(id);
      if (!p || typeof p.renderOverlay !== 'function' || !ctx) return false;
      try {
        if (typeof ctx.save === 'function') ctx.save();
        p.renderOverlay(ctx, view, opts.params || api.getParams(id), opts.state || state);
        return true;
      } catch (err) {
        if (!overlayErrorsLogged.has(id)) {
          overlayErrorsLogged.add(id);
          console.error(`[Flexatone] studio "${id}" renderOverlay failed:`, err);
        }
        return false;
      } finally {
        if (typeof ctx.restore === 'function') ctx.restore();
      }
    },

    /**
     * Run the plugin's generateVoices and normalise the result into contract-conforming
     * voices (unique ids, clamped ranges). Does NOT modify state.
     * generateVoices 실행 후 결과를 계약에 맞게 정규화 (상태 변경 없음).
     * @returns {object[]}
     */
    generateVoices(id, params, { mode = 'replace' } = {}) {
      const p = requirePlugin(id);
      if (typeof p.generateVoices !== 'function') return [];
      const startIndex = mode === 'append' ? state.voices.length : 0;
      const out = p.generateVoices(params || api.getParams(id), createStudioHelpers(state, { startIndex }));
      if (!Array.isArray(out)) throw new TypeError(`StudioRegistry: "${id}".generateVoices must return an array`);
      const seen = new Set(mode === 'append' ? state.voices.map((v) => v.id) : []);
      return out.slice(0, MAX_GENERATED_VOICES).map((raw, i) => {
        const v = normalizeVoice(raw, startIndex + i);
        while (seen.has(v.id)) v.id = createDefaultVoice().id;
        seen.add(v.id);
        return v;
      });
    },

    /**
     * Generate and write voices into the document (undoable). mode 'replace' swaps the
     * whole voice list; 'append' adds after existing voices. New voices become selected.
     * 보이스를 생성해 문서에 반영 (replace: 교체, append: 추가). 실행 취소 가능.
     */
    bakeVoices(id, { mode = 'replace', params } = {}) {
      const voices = api.generateVoices(id, params, { mode });
      if (!voices.length) return { type: 'studio/bake', scope: new Set(), result: [], historyChanged: false };
      return commit({
        type: 'studio/bake',
        history: true,
        scope: 'all',
        payload: { id, mode },
        mutate: (s) => {
          s.voices = mode === 'append' ? [...s.voices, ...voices] : voices;
          s.selectedVoiceIds = voices.map((v) => v.id);
          s.activeVoiceId = voices[0].id;
          return voices;
        },
      });
    },

    /** Switch the active studio, calling onDeactivate / onActivate hooks. / 스튜디오 전환 */
    activate(id) {
      const next = requirePlugin(id);
      if (next.status !== 'ready') throw new Error(`StudioRegistry: "${id}" is not ready`);
      if (activeId === id && state.studio === id) return null; // already active: no duplicate hooks
      const ev = state === appState ? setStudio(id) : ((state.studio = id), null);
      if (state.studio !== id) throw new Error(`StudioRegistry: state refused studio "${id}"`);
      const prev = activeId && activeId !== id ? plugins.get(activeId) : null;
      if (prev && typeof prev.onDeactivate === 'function') prev.onDeactivate(createStudioHelpers(state));
      activeId = id;
      if (typeof next.onActivate === 'function') next.onActivate(createStudioHelpers(state));
      emit('activate', id);
      return ev;
    },

    /** The studio that should actually be shown: state.studio if a ready plugin exists, else the fallback. */
    resolveStudioId(id = state.studio, fallback = 'glissando') {
      const p = plugins.get(id);
      return p && p.status === 'ready' ? id : fallback;
    },

    /** Listen for register / unregister / activate. Returns unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return Object.freeze(api);
}

/** Application-wide singleton. / 앱 전역 레지스트리 */
export const StudioRegistry = createStudioRegistry();

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const testPlugin = (over = {}) => ({
  id: 'test-studio',
  name: { en: 'Test', ko: '테스트' },
  schema: [],
  defaultParams: () => ({ n: 2, base: 60 }),
  generateVoices: (p, h) =>
    Array.from({ length: p.n }, (_, i) => h.createDefaultVoice(h.existingVoiceCount + i, { f0Midi: p.base + i, f0Hz: h.midiToFreq(p.base + i) })),
  ...over,
});

registerSelfCheck('Plugin validation & registration', (a) => {
  a.ok(validateStudioPlugin(testPlugin()).length === 0, 'valid plugin');
  a.ok(validateStudioPlugin({ ...testPlugin(), id: 'Bad Id' }).length > 0, 'bad id');
  a.ok(validateStudioPlugin({ ...testPlugin(), name: { en: 'x' } }).length > 0, 'missing ko name');
  a.ok(validateStudioPlugin({ ...testPlugin(), renderOverlay: 3 }).length > 0, 'hook type');
  a.ok(validateStudioPlugin({ ...testPlugin(), defaultParams: () => null }).length > 0, 'defaultParams object');
  a.ok(validateStudioPlugin(null).length > 0);
  const reg = createStudioRegistry();
  const stored = reg.register(testPlugin());
  a.ok(Object.isFrozen(stored) && stored.status === 'ready' && stored.order === 100, 'defaults applied');
  let threw = false;
  try { reg.register(testPlugin()); } catch { threw = true; }
  a.ok(threw, 'duplicate rejected');
  reg.register(testPlugin({ order: 1 }), { replace: true });
  a.equal(reg.get('test-studio').order, 1, 'replace');
  const tabs = reg.listTabs('ko');
  a.equal(tabs.slice(0, 3).map((x) => x.id).join(), STUDIO_IDS.join(), 'built-in slots first');
  a.ok(tabs.slice(0, 3).every((x) => x.status === 'planned'), 'unregistered slots are planned');
  a.equal(tabs[3].label, '테스트', 'localized extra tab');
  const events = [];
  const off = reg.onChange((e) => events.push(e.type));
  a.ok(reg.unregister('test-studio') && !reg.has('test-studio'));
  off();
  a.equal(events.join(), 'unregister');
}, { group: 'studio' });

registerSelfCheck('Params, overlay isolation, generate & bake (undoable)', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    const reg = createStudioRegistry();
    reg.register(testPlugin({ renderOverlay: () => { throw new Error('boom'); } }));
    a.equal(reg.getParams('test-studio').n, 2, 'defaults');
    reg.setParams('test-studio', { n: 3 });
    a.equal(reg.getParams('test-studio').n, 3, 'saved param');
    a.equal(appState.studioParams['test-studio'].base, 60, 'stored in appState');
    const calls = [];
    const ctx = { save: () => calls.push('save'), restore: () => calls.push('restore') };
    const prevErr = console.error;
    console.error = () => {};
    try {
      a.equal(reg.renderOverlay('test-studio', ctx, {}), false, 'overlay error isolated');
    } finally {
      console.error = prevErr;
    }
    a.equal(calls.join(), 'save,restore', 'ctx state balanced');
    a.equal(reg.renderOverlay('nope', ctx, {}), false, 'unknown studio');

    const gen = reg.generateVoices('test-studio');
    a.equal(gen.length, 3);
    a.ok(gen.every((v) => /^v_/.test(v.id) && v.duration >= 0.05 && 'gainEngineObj' in v), 'normalized voices');
    a.equal(gen[1].f0Midi, 61);
    a.equal(appState.voices.length, 1, 'generate does not mutate');
    reg.bakeVoices('test-studio', { mode: 'append' });
    a.equal(appState.voices.length, 4, 'append');
    a.equal(appState.selectedVoiceIds.length, 3, 'new voices selected');
    reg.bakeVoices('test-studio', { mode: 'replace', params: { n: 2, base: 40 } });
    a.equal(appState.voices.length, 2, 'replace');
    a.equal(appState.voices[0].f0Midi, 40);
    a.ok(canUndo() && undo(), 'undo bake');
    a.equal(appState.voices.length, 4);
    const big = createStudioRegistry();
    big.register(testPlugin({ id: 'big', defaultParams: () => ({ n: 500, base: 30 }) }));
    a.equal(big.generateVoices('big').length, MAX_GENERATED_VOICES, 'generation capped');
  });
}, { group: 'studio' });

registerSelfCheck('Regression: undoable params, sandboxed writes, studio switching, append numbering', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    resetHistory();
    const reg = createStudioRegistry();
    const hooks = [];
    reg.register(testPlugin({ onActivate: () => hooks.push('A+'), onDeactivate: () => hooks.push('A-') }));
    reg.register(testPlugin({ id: 'other-studio', onActivate: () => hooks.push('B+'), onDeactivate: () => hooks.push('B-') }));

    const voiceCount = appState.voices.length;
    reg.setParams('test-studio', { n: 9 });
    a.ok(undo(), 'param change is undoable');
    a.equal(reg.getParams('test-studio').n, 2, 'undo restores the param');
    a.equal(appState.voices.length, voiceCount, 'undo did not touch voices');

    reg.activate('test-studio');
    reg.activate('test-studio');
    reg.activate('other-studio');
    a.equal(appState.studio, 'other-studio', 'extra studio becomes active in state');
    a.equal(hooks.join(), 'A+,A-,B+', 'one hook pair per real switch');
    a.equal(reg.resolveStudioId('risset'), 'glissando', 'planned slot resolves to fallback');
    a.equal(JSON.stringify(reg.getParams('risset')), '{}', 'planned slot has no params');

    reg.bakeVoices('test-studio', { mode: 'append' });
    const names = appState.voices.map((v) => v.name);
    a.equal(new Set(names).size, names.length, `append keeps names unique: ${names.join(', ')}`);

    const scratch = { ...createInitialState(), studioParams: {} };
    const sandbox = createStudioRegistry({ state: scratch });
    sandbox.register(testPlugin());
    const before = JSON.stringify(appState.voices);
    sandbox.setParams('test-studio', { n: 4 });
    sandbox.bakeVoices('test-studio', { mode: 'replace' });
    a.equal(JSON.stringify(appState.voices), before, 'sandbox registry leaves appState alone');
    a.equal(scratch.voices.length, 4, 'sandbox wrote its own state');
  });
}, { group: 'studio' });
