/**
 * Flexatone — studios/glissando-studio.js
 * Layer 2 (studios): the Glissando Studio plugin (default studio) + registration.
 * 계층 2 (studios): 글리산도 스튜디오 플러그인(기본 스튜디오) 정의 및 등록.
 *
 * Glissando Studio edits voices directly through the shared voice editor panels
 * (usesVoiceEditor: true). On top of that it offers:
 *   - renderOverlay: dashed F₀ / F₁ guide lines for the active voice in piano-roll view
 *   - generateVoices: multi-voice presets (Converging Cluster, Staggered Canon, Mirror Pairs)
 * 공용 보이스 편집기를 사용하며, F₀/F₁ 가이드 오버레이와 다성부 프리셋 생성을 제공.
 *
 * Imports: core/*, studios/registry.js. Never ui/* or audio/*.
 */

import { getVoiceMidi, getVoiceEnd, ENGINE_IDS, appState, createDefaultVoice, registerSelfCheck } from '../core/state.js';
import { noteNameToMidi } from '../core/units.js';
import { StudioRegistry, createStudioRegistry } from './registry.js';

export const GLISSANDO_PRESETS = Object.freeze(['cluster', 'canon', 'mirror']);

/** Engines offered by the generator (composite / hand-edited ones excluded). */
const GENERATOR_ENGINES = ENGINE_IDS.filter((id) => id !== 'morph' && id !== 'custom');

const DEFAULT_PARAMS = Object.freeze({
  preset: 'cluster',
  voiceCount: 4,
  centerNote: 'C4',
  targetNote: 'G4',
  spread: 12,
  stagger: 0.5,
  duration: 4,
  engine: 'harmonic',
});

const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Resolve and clamp raw params (bad notes fall back to defaults). / 파라미터 정규화 */
export function resolveGlissandoParams(params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  return {
    preset: GLISSANDO_PRESETS.includes(p.preset) ? p.preset : DEFAULT_PARAMS.preset,
    voiceCount: Math.round(clampNum(p.voiceCount, 1, 16, DEFAULT_PARAMS.voiceCount)),
    center: noteNameToMidi(p.centerNote) ?? noteNameToMidi(DEFAULT_PARAMS.centerNote),
    target: noteNameToMidi(p.targetNote) ?? noteNameToMidi(DEFAULT_PARAMS.targetNote),
    spread: clampNum(p.spread, 0, 48, DEFAULT_PARAMS.spread),
    stagger: clampNum(p.stagger, 0, 10, DEFAULT_PARAMS.stagger),
    duration: clampNum(p.duration, 0.05, 300, DEFAULT_PARAMS.duration),
    engine: GENERATOR_ENGINES.includes(p.engine) ? p.engine : DEFAULT_PARAMS.engine,
  };
}

/**
 * Pitch/time layout for each preset (pure, testable). / 프리셋별 음고·시간 배치
 * @returns {Array<{ f0: number, f1: number, start: number }>} MIDI (fractional) and seconds
 */
export function layoutGlissandoPreset(r) {
  const N = r.voiceCount;
  const offset = (i) => (N === 1 ? 0 : -r.spread / 2 + (r.spread * i) / (N - 1));
  const out = [];
  if (r.preset === 'cluster') {
    // Spread start pitches converge onto one target / 퍼진 시작음이 하나의 목표로 수렴
    for (let i = 0; i < N; i++) out.push({ f0: r.center + offset(i), f1: r.target, start: 0 });
  } else if (r.preset === 'canon') {
    // Same contour transposed, entering one after another / 같은 윤곽을 이조해 차례로 진입
    for (let i = 0; i < N; i++) {
      const tr = N === 1 ? 0 : (r.spread * i) / (N - 1);
      out.push({ f0: r.center + tr, f1: r.target + tr, start: i * r.stagger });
    }
  } else {
    // Mirror pairs: each original has a partner reflected around the center pitch
    // 거울 쌍: 원본과 중심음 기준으로 반사된 짝
    const pairs = Math.ceil(N / 2);
    for (let k = 0; k < pairs; k++) {
      const tr = pairs === 1 ? 0 : (r.spread * k) / (pairs - 1) / 2;
      out.push({ f0: r.center + tr, f1: r.target + tr, start: k * r.stagger });
      if (out.length < N) out.push({ f0: r.center - tr, f1: 2 * r.center - r.target - tr, start: k * r.stagger });
    }
  }
  const clampMidi = (m) => Math.min(127, Math.max(0, m));
  return out.map((o) => ({ f0: clampMidi(o.f0), f1: clampMidi(o.f1), start: o.start }));
}

/** @type {import('./registry.js').StudioPlugin} */
export const GlissandoStudio = {
  id: 'glissando',
  name: { en: 'Glissando Studio', ko: '글리산도 스튜디오' },
  description: {
    en: 'Edit continuous pitch & gain trajectories voice by voice.',
    ko: '보이스별 연속 음고·게인 궤적을 편집합니다.',
  },
  order: 0,
  status: 'ready',
  usesVoiceEditor: true,

  schema: [
    {
      key: 'preset',
      type: 'select',
      labelKey: 'glis.preset',
      options: GLISSANDO_PRESETS.map((id) => ({ value: id, labelKey: `glis.preset.${id}` })),
      default: DEFAULT_PARAMS.preset,
    },
    { key: 'voiceCount', type: 'range', labelKey: 'glis.voiceCount', min: 1, max: 16, step: 1, integer: true, default: DEFAULT_PARAMS.voiceCount },
    { key: 'centerNote', type: 'note', labelKey: 'glis.centerNote', default: DEFAULT_PARAMS.centerNote },
    { key: 'targetNote', type: 'note', labelKey: 'glis.targetNote', default: DEFAULT_PARAMS.targetNote },
    { key: 'spread', type: 'range', labelKey: 'glis.spread', min: 0, max: 48, step: 0.5, default: DEFAULT_PARAMS.spread },
    { key: 'stagger', type: 'range', labelKey: 'glis.stagger', min: 0, max: 10, step: 0.05, default: DEFAULT_PARAMS.stagger },
    { key: 'duration', type: 'range', labelKey: 'glis.duration', min: 0.05, max: 300, step: 0.05, default: DEFAULT_PARAMS.duration },
    {
      key: 'engine',
      type: 'select',
      labelKey: 'glis.engine',
      options: GENERATOR_ENGINES.map((id) => ({ value: id, labelKey: `engineName.${id}` })),
      default: DEFAULT_PARAMS.engine,
    },
  ],

  defaultParams: () => ({ ...DEFAULT_PARAMS }),

  /**
   * Dashed F₀ / F₁ guides across the active voice's time span (piano-roll view only).
   * 활성 보이스 구간에 F₀/F₁ 점선 가이드 (피아노롤 보기에서만).
   */
  renderOverlay(ctx, view, params, state) {
    if (!view || view.viewMode !== 'piano' || typeof view.timeToX !== 'function' || typeof view.midiToY !== 'function') return;
    const v = state?.voices?.find((x) => x.id === state.activeVoiceId);
    if (!v) return;
    const x0 = view.timeToX(v.startTime);
    const x1 = view.timeToX(getVoiceEnd(v));
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = v.color || '#38bdf8';
    for (const side of ['f0', 'f1']) {
      const y = view.midiToY(getVoiceMidi(v, side));
      if (!Number.isFinite(y)) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  },

  /** Build preset voices; the registry normalises them. / 프리셋 보이스 생성 */
  generateVoices(params, helpers) {
    const r = resolveGlissandoParams(params);
    const base = helpers.startIndex ?? 0; // append mode continues numbering & colors / 추가 시 번호·색상 이어서
    return layoutGlissandoPreset(r).map((o, i) => {
      const v = helpers.createDefaultVoice(base + i, {
        name: `Voice ${base + i + 1}`,
        startTime: o.start,
        duration: r.duration,
        engine: r.engine,
        lastNonCustomEngine: r.engine,
        f0Hz: helpers.midiToFreq(o.f0),
        f1Hz: helpers.midiToFreq(o.f1),
        f0Fine: 0,
        f1Fine: 0,
      });
      return v;
    });
  },
};

// Register with the app-wide registry (idempotent across hot reloads).
// 전역 레지스트리에 등록 (중복 등록 방지).
if (!StudioRegistry.has(GlissandoStudio.id)) StudioRegistry.register(GlissandoStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Glissando studio registered & schema valid', (a) => {
  a.ok(StudioRegistry.has('glissando'), 'registered');
  const tab = StudioRegistry.listTabs('en')[0];
  a.ok(tab.id === 'glissando' && tab.status === 'ready' && tab.label === 'Glissando Studio', 'first tab ready');
  for (const s of GlissandoStudio.schema) {
    a.ok(s.key in DEFAULT_PARAMS, `schema key ${s.key} has default`);
    a.equal(s.default, DEFAULT_PARAMS[s.key], `schema default ${s.key}`);
  }
  a.ok(GENERATOR_ENGINES.length === ENGINE_IDS.length - 2, 'generator engines (all but morph / custom)');
}, { group: 'studio' });

registerSelfCheck('Glissando presets layout & generated voices', (a) => {
  const base = resolveGlissandoParams({ voiceCount: 3, centerNote: 'C4', targetNote: 'G4', spread: 12, stagger: 1 });
  const cluster = layoutGlissandoPreset({ ...base, preset: 'cluster' });
  a.equal(cluster.map((o) => o.f0).join(), '54,60,66', 'cluster starts');
  a.ok(cluster.every((o) => o.f1 === 67 && o.start === 0), 'cluster converges');
  const canon = layoutGlissandoPreset({ ...base, preset: 'canon' });
  a.equal(canon.map((o) => o.start).join(), '0,1,2', 'canon stagger');
  a.equal(canon[2].f1 - canon[2].f0, 7, 'canon keeps contour');
  const mirror = layoutGlissandoPreset({ ...base, preset: 'mirror', voiceCount: 4 });
  a.equal(mirror.length, 4);
  a.equal(mirror[1].f1, 53, 'mirror reflects target around center');
  a.equal(layoutGlissandoPreset({ ...base, preset: 'mirror', voiceCount: 3 }).length, 3, 'odd mirror count');
  a.equal(resolveGlissandoParams({ centerNote: 'zz', voiceCount: 99, engine: 'morph' }).center, 60, 'bad note → default');
  a.equal(resolveGlissandoParams({ voiceCount: 99 }).voiceCount, 16, 'count clamped');
  a.equal(resolveGlissandoParams({ engine: 'morph' }).engine, 'harmonic', 'morph not offered');

  const reg = createStudioRegistry({ state: { ...appState, voices: [createDefaultVoice(0)], studioParams: {} } });
  reg.register(GlissandoStudio);
  const voices = reg.generateVoices('glissando', { preset: 'canon', voiceCount: 5, engine: 'bounce', duration: 3 });
  a.equal(voices.length, 5);
  a.ok(voices.every((v) => v.engine === 'bounce' && v.duration === 3), 'engine & duration applied');
  a.near(getVoiceMidi(voices[0], 'f1') - getVoiceMidi(voices[0], 'f0'), 7, 1e-9, 'interval preserved');
  a.equal(new Set(voices.map((v) => v.id)).size, 5, 'unique ids');
}, { group: 'studio' });

registerSelfCheck('Glissando overlay draws only in piano view', (a) => {
  const ops = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'setLineDash' || k === 'beginPath' || k === 'moveTo' || k === 'lineTo' || k === 'stroke' || k === 'save' || k === 'restore'
      ? (...args) => ops.push(k + (k === 'moveTo' || k === 'lineTo' ? `(${args.map((n) => Math.round(n)).join(',')})` : ''))
      : undefined),
    set: () => true,
  });
  const v = createDefaultVoice(0, { startTime: 1, duration: 2 });
  const state = { voices: [v], activeVoiceId: v.id };
  const view = { viewMode: 'piano', timeToX: (s) => s * 100, midiToY: (m) => 1000 - m * 10 };
  GlissandoStudio.renderOverlay(ctx, view, {}, state);
  a.equal(ops.filter((o) => o === 'stroke').length, 2, 'two guides');
  a.ok(ops.includes('moveTo(100,520)') && ops.includes('lineTo(300,280)'), 'F0 at 48, F1 at 72 across 1–3 s');
  ops.length = 0;
  GlissandoStudio.renderOverlay(ctx, { ...view, viewMode: 'norm' }, {}, state);
  a.equal(ops.length, 0, 'no drawing in norm view');
}, { group: 'studio' });
