/**
 * Flexatone — studios/space-studio.js
 * Layer 2 (studios): Space Studio plugin — Doppler glissandi from moving sources.
 * 계층 2 (studios): 스페이스 스튜디오 플러그인 — 움직이는 음원이 만드는 도플러 글리산도.
 *
 * The whole document (medium, listener, sources, view) lives in appState.studioParams.space, so
 * it is saved with the project and undoable. Physics and baking live in space/space-engine.js;
 * the workspace UI / audio (space-panels.js, space-canvases.js, space-audio.js) are mounted by
 * ui/studio-host.js — this file stays DOM- and audio-free (architecture DAG).
 * 문서는 appState.studioParams.space에 저장. 이 파일은 DOM·오디오에 의존하지 않음.
 *
 * Bake to Glissando: each source → one Voice (engine 'custom' = f_obs(t) on a log F0→F1 range,
 * gainPoints = normalised distance gain). Voices have no pan / filter: panning and air
 * absorption are lost (toast + help `space.bakeLoss`).
 * 글리산도 베이킹 시 패닝·고역 감쇠는 손실 (토스트·도움말에 명시).
 * Imports: core/*, modules/*, studios/registry.js, studios/space/*.
 */

import { clamp, roundTo, deepClone } from '../core/math-utils.js';
import { appState, registerSelfCheck, withIsolatedState } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { StudioRegistry } from './registry.js';
import './space/space-i18n.js'; // merges EN/KO strings before the tabs are drawn / 탭 렌더 전 문자열 병합
import {
  createDefaultSpaceParams,
  normalizeSpaceDoc,
  bakeSpace,
  bakeSource,
  sampleBake,
  getSpaceBakeCount,
  getKinematics,
  solveEmission,
  equalPowerGains,
  createSource,
  effectiveC,
  SUPERSONIC_FRACTION,
} from './space/space-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const SPACE_ID = 'space';
const DENSE = 2000;

let memo = { raw: null, doc: null };

/**
 * Space document = defaults overlaid with the saved params, normalised. Memoised on the identity
 * of appState.studioParams.space (setParams / undo / load always swap that object), so the many
 * per-frame readers share one copy — treat the result as read-only.
 * 스페이스 문서 (저장 객체 동일성으로 메모 — 읽기 전용으로 사용).
 */
export function getSpaceParams() {
  if (!StudioRegistry.has(SPACE_ID)) return normalizeSpaceDoc(createDefaultSpaceParams());
  const raw = appState.studioParams?.[SPACE_ID];
  if (memo.doc && memo.raw === raw) return memo.doc; // undefined = untouched defaults / 기본값
  const doc = normalizeSpaceDoc(StudioRegistry.getParams(SPACE_ID));
  memo = { raw, doc };
  return doc;
}

/**
 * Apply an edit to the Space document. `fn(doc)` mutates a draft; view-only edits pass
 * { history: false }. / 스페이스 문서 편집 (뷰 전용은 history:false)
 */
export function editSpace(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getSpaceParams());
  fn(draft);
  return StudioRegistry.setParams(SPACE_ID, draft, { history, coalesceKey });
}

export function getActiveSource(params = getSpaceParams()) {
  return params.sources.find((s) => s.id === params.activeSourceId) || params.sources[0] || null;
}

export function isSourceAudible(s, params = getSpaceParams()) {
  const anySolo = params.sources.some((x) => x.solo);
  return anySolo ? !!s.solo : !s.muted;
}

/** Baked arrays of every source for the current document (memoised). / 현재 베이킹 결과 */
export function getSpaceBake(params = getSpaceParams()) {
  return bakeSpace(params);
}

/**
 * Convert one baked source to a Glissando Voice. Pitch follows f_obs on a log F0→F1 range,
 * gain follows the distance law (normalised; the peak moves into baseGain).
 * 베이킹된 음원 하나를 글리산도 보이스로 변환.
 */
export function sourceToGlissandoVoice(src, b, helpers, index) {
  const at = (key, x) => sampleBake(b, key, b.t0 + clamp(x, 0, 1) * (b.t1 - b.t0));
  let lo = Infinity;
  let hi = -Infinity;
  let gMax = 0;
  for (let i = 0; i < b.n; i++) {
    lo = Math.min(lo, b.fObs[i]);
    hi = Math.max(hi, b.fObs[i]);
    gMax = Math.max(gMax, b.gain[i]);
  }
  const f0 = Math.max(1, Math.floor(lo * 100) / 100);
  let f1 = Math.ceil(hi * 100) / 100;
  const flat = f1 / f0 < 1.0002;
  if (flat) f1 = f0;
  const span = flat ? 1 : Math.log(f1 / f0);
  const dense = [];
  const gDense = [];
  for (let i = 0; i <= DENSE; i++) {
    const x = i / DENSE;
    dense.push({ x: roundTo(x, 5), y: flat ? 0 : roundTo(clamp(Math.log(at('fObs', x) / f0) / span, 0, 1), 6), handles: [] });
    gDense.push({ x: roundTo(x, 5), y: roundTo(gMax > 0 ? at('gain', x) / gMax : 0, 6), handles: [] });
  }
  // includeTransforms forces a real adaptive fit (a plain custom source would be copied as-is)
  // samples = DENSE: the fit sees every dense point (long, wiggly Doppler curves need it)
  // samples = DENSE: 길고 굴곡 많은 도플러 곡선을 위해 조밀 점 전부를 근사에 사용
  const customPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: dense, reverse: false, inverse: false }, { tolerance: 0.0015, maxAnchors: 64, includeTransforms: true, samples: DENSE });
  let gainPoints = captureCurveToCustomPoints({ engine: 'custom', customPoints: gDense, reverse: false, inverse: false }, { tolerance: 0.002, maxAnchors: 48, includeTransforms: true, samples: DENSE });
  if (gainPoints.length < 17) {
    gainPoints = [];
    for (let i = 0; i <= 16; i++) gainPoints.push({ x: roundTo(i / 16, 4), y: roundTo(clamp(at('gain', i / 16) / (gMax || 1), 0, 1), 4), handles: [] });
  }
  return helpers.createDefaultVoice(index, {
    name: src.name,
    color: src.color,
    solo: !!src.solo,
    muted: !!src.muted,
    startTime: roundTo(b.t0, 4),
    duration: roundTo(b.t1 - b.t0, 4),
    baseGain: roundTo(clamp(src.baseGain * gMax, 0, 2), 4),
    f0Hz: f0,
    f1Hz: f1,
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(src.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints,
    gainMode: 'points',
    gainPoints,
  });
}

export const SpaceStudio = {
  id: SPACE_ID,
  name: { en: 'Space Studio', ko: '스페이스 스튜디오' },
  description: { en: 'Doppler glissandi from sources moving past a listener (retarded time)', ko: '청취자 곁을 움직이는 음원의 도플러 글리산도 (지연 시간)' },
  order: 80,
  status: 'ready',
  usesVoiceEditor: false,
  /** Rendered by its own workspace, not by the generic studio panel. / 전용 작업 공간 사용 */
  schema: [],
  workspace: 'space',
  defaultParams: createDefaultSpaceParams,
  generateVoices(params, helpers) {
    const doc = normalizeSpaceDoc(params);
    const baked = bakeSpace(doc);
    return doc.sources.slice(0, 64).map((s, i) => sourceToGlissandoVoice(s, baked.sources.get(s.id), helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(SpaceStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, ...over, sources });
const lineSrc = (over = {}) => createSource(0, { id: 'chk', path: { type: 'line', x0: -3000, y0: 5, x1: 3000, y1: 5 }, speed: { value: 20 }, duration: 300, f: { hz: 440 }, ...over });

registerSelfCheck('Space studio: retarded-time solver residual |g| < 1e-9', (a) => {
  const cases = [
    lineSrc({ duration: 30, path: { type: 'line', x0: -300, y0: 5, x1: 300, y1: 5 } }),
    createSource(0, { id: 'o', path: { type: 'orbit', cx: 10, cy: 4, rx: 25, ry: 15 }, speed: { value: 60 }, duration: 12 }),
    createSource(0, { id: 'l', path: { type: 'lissajous', ax: 30, ay: 20, a: 3, b: 2, delta: 40 }, speed: { value: 90 }, duration: 10 }),
    createSource(0, { id: 'sp', path: { type: 'spiral', cx: 5, cy: 5, r0: 90, r1: 3, turns: 2, h: 4 }, speed: { mode: 'curve', from: 5, to: 80, curve: { engine: 'expo' } }, duration: 14 }),
    createSource(0, { id: 'd', path: { type: 'draw', points: [{ x: -40, y: 10 }, { x: 0, y: 30 }, { x: 30, y: -5 }, { x: 60, y: 20 }] }, speed: { value: 25 }, duration: 6 }),
  ];
  for (const cScale of [1, 0.25]) {
    const doc = docWith(cases, { cScale });
    let worst = 0;
    let count = 0;
    for (const s of doc.sources) {
      const kin = getKinematics(s, doc);
      const b = bakeSource(s, doc);
      worst = Math.max(worst, b.maxResidual);
      for (let k = 1; k < 40; k++) {
        const t = b.t0 + (k / 40) * (b.t1 - b.t0);
        const sol = solveEmission(kin, doc.listener, t);
        a.ok(sol, `solution exists inside the audible window (${s.id}, t=${t.toFixed(3)})`);
        worst = Math.max(worst, Math.abs(sol.residual));
        count++;
      }
    }
    a.ok(worst < 1e-9, `max residual ${worst.toExponential(2)} at cScale ${cScale} (${count} probes)`);
  }
}, { group: 'studio' });

registerSelfCheck('Space studio: Doppler limits, centred orbit, static, supersonic clamp', (a) => {
  // Far straight pass-by / 먼 직선 통과
  const doc = docWith([lineSrc()]);
  const c = effectiveC(doc);
  const b = bakeSource(doc.sources[0], doc);
  const v = 20;
  a.ok(Math.abs(b.fObs[1] / (440 * c / (c - v)) - 1) < 0.005, `approach ≈ f·c/(c−v): ${b.fObs[1].toFixed(3)}`);
  a.ok(Math.abs(b.fObs[b.n - 2] / (440 * c / (c + v)) - 1) < 0.005, `recede ≈ f·c/(c+v): ${b.fObs[b.n - 2].toFixed(3)}`);
  a.ok(b.pan[1] < -0.99 && b.pan[b.n - 2] > 0.99, 'pans left → right');
  // Orbit centred on the listener: v_r = 0 → f_obs = f_s / 청취자 중심 원 궤도
  const orb = docWith([createSource(0, { id: 'o', path: { type: 'orbit', onListener: true, rx: 30, ry: 30 }, speed: { value: 120 }, duration: 8, f: { hz: 500 } })], { listener: { x: 3, y: -2, headingDeg: 0 } });
  const ob = bakeSource(orb.sources[0], orb);
  let worst = 0;
  for (let i = 0; i < ob.n; i++) worst = Math.max(worst, Math.abs(ob.fObs[i] / 500 - 1), Math.abs(ob.vr[i]) / 120);
  a.ok(worst < 1e-6, `centred orbit f_obs = f_s (worst ${worst.toExponential(2)})`);
  // Static source / 정지 음원
  const st = docWith([createSource(0, { id: 's', path: { type: 'static', x: 7, y: 9 }, duration: 3, f: { hz: 330 } })]);
  const sb = bakeSource(st.sources[0], st);
  a.ok(Array.from(sb.fObs).every((f) => f === 330), 'static f_obs = f_s');
  a.near(sb.t0, Math.hypot(7, 9) / effectiveC(st), 1e-12, 'arrival delay = r/c');
  // Supersonic input clamps to 0.98c / 초음속 입력 클램프
  const sup = docWith([lineSrc({ speed: { value: 900 }, duration: 6 })]);
  const kb = bakeSource(sup.sources[0], sup);
  a.ok(kb.clamped && kb.maxVc > 1, `clamp flagged (max v/c ${kb.maxVc.toFixed(2)})`);
  a.near(getKinematics(sup.sources[0], sup).stateAt(1).speed, SUPERSONIC_FRACTION * effectiveC(sup), 1e-9, '|v| = 0.98c');
  a.ok(['fObs', 'gain', 'pan', 'lp', 'r'].every((k) => Array.from(kb[k]).every(Number.isFinite)), 'finite output');
  a.ok(Math.max(...kb.fObs) <= 440 / (1 - SUPERSONIC_FRACTION) + 1e-6, 'bounded by 1/(1 − 0.98)');
}, { group: 'studio' });

registerSelfCheck('Space studio: inverse distance, equal-power pan, air cutoff', (a) => {
  const at = (x, y, heading = 0) => {
    const d = docWith([createSource(0, { id: 'p', path: { type: 'static', x, y }, duration: 1 })], { listener: { x: 0, y: 0, headingDeg: heading } });
    return bakeSource(d.sources[0], d);
  };
  a.near(at(0, 20).gain[0] / at(0, 10).gain[0], 0.5, 1e-12, 'distance ×2 → gain ½');
  a.near(at(0, 0.3).gain[0], 1, 1e-12, 'near clamp inside refDist');
  for (let p = -1; p <= 1.0001; p += 0.125) {
    const g = equalPowerGains(p);
    a.near(g.L * g.L + g.R * g.R, 1, 1e-9, `L² + R² = 1 at pan ${p}`);
  }
  a.near(at(0, 10).pan[0], 0, 1e-12, 'front → pan 0');
  a.near(at(10, 0).pan[0], 1, 1e-12, 'right 90° → pan 1');
  a.near(at(-10, 0).pan[0], -1, 1e-12, 'left 90° → pan −1');
  a.near(at(0, -10, 90).pan[0], 1, 1e-12, 'heading 90°: −y is on the right');
  a.near(at(0, 10).lp[0], 18000 / (1 + 10 / 40), 1e-9, 'air cutoff 18k/(1 + r/airDist)');
  a.near(at(0, 5000).lp[0], 800, 1e-9, 'cutoff floor 800 Hz');
}, { group: 'studio' });

registerSelfCheck('Space studio: bake cache signature & Glissando voices', (a) => {
  const p = createDefaultSpaceParams();
  a.equal(JSON.stringify(createDefaultSpaceParams()), JSON.stringify(createDefaultSpaceParams()), 'defaults are deterministic');
  const doc = normalizeSpaceDoc(deepClone(p));
  const first = bakeSpace(doc);
  const c0 = getSpaceBakeCount();
  a.ok(bakeSpace(normalizeSpaceDoc(deepClone(p))) === first, 'same physics → cached');
  const q = deepClone(doc);
  q.sources[0].timbre.saw = 0.9;
  q.sources[0].baseGain = 0.1;
  q.sources[0].muted = true;
  q.sources[0].name = 'renamed';
  q.view.span = 400;
  q.panMode = 'hrtf';
  a.ok(bakeSpace(q) === first, 'timbre / baseGain / mute / view → no re-bake');
  a.equal(getSpaceBakeCount() - c0, 0, 'bake count unchanged');
  // Unique per run (the bake cache keeps several entries) / 실행마다 고유한 값 (캐시가 여러 항목 보관)
  q.cScale = 0.6 + Math.random() * 0.2;
  bakeSpace(q);
  a.equal(getSpaceBakeCount() - c0, 1, 'cScale change → 1 bake');
  q.listener.x = 3.5;
  bakeSpace(q);
  bakeSpace(q);
  a.equal(getSpaceBakeCount() - c0, 2, 'listener change → 1 bake');
  withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    const swarm = normalizeSpaceDoc({ ...createDefaultSpaceParams(), sources: [0, 1, 2].map((i) => createSource(i, { id: `g${i}`, path: { type: 'lissajous', a: i + 1, b: 2 }, speed: { value: 15 + 5 * i }, f: { hz: 220 * (i + 1) }, duration: 10 })), cScale: 0.35 });
    const voices = StudioRegistry.generateVoices(SPACE_ID, swarm);
    a.equal(voices.length, 3, 'one voice per source');
    a.equal(JSON.stringify(appState.voices), before, 'state untouched by generateVoices');
    const bake = bakeSpace(swarm);
    for (let k = 0; k < voices.length; k++) {
      const v = voices[k];
      const b = bake.sources.get(swarm.sources[k].id);
      // capture grows past maxAnchors only for many extrema (hard cap 160) / 극값이 많을 때만 64 초과
      a.ok(v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.length <= 160, `adaptive spline (${v.customPoints.length} anchors)`);
      a.ok(v.gainPoints.length >= 17, `gain points ${v.gainPoints.length} ≥ 17`);
      a.near(v.startTime, b.t0, 1e-3, 'starts at the arrival time');
      let worst = 0;
      for (let i = 0; i <= 64; i++) {
        const x = i / 64;
        const y = evaluateCurveObjectY(v, x, { regions: false });
        const hz = v.f0Hz * Math.pow(v.f1Hz / v.f0Hz, y);
        worst = Math.max(worst, Math.abs(hz / sampleBake(b, 'fObs', b.t0 + x * (b.t1 - b.t0)) - 1));
      }
      a.ok(worst < 0.003, `f_obs samples match (worst ${(worst * 100).toFixed(3)}%)`);
    }
  });
}, { group: 'studio' });
