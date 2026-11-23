/**
 * Flexatone — studios/cloud-studio.js
 * Layer 2 (studios): Cloud Studio plugin — Xenakis-style stochastic glissando clouds.
 * 계층 2 (studios): 클라우드 스튜디오 플러그인 — 크세나키스식 확률 글리산도 구름.
 *
 * The whole document (seed, density / pitch / glide / duration / gain / timbre, view) lives in
 * appState.studioParams.cloud, so it is saved with the project and undoable. Events are generated
 * once per signature (cloud/cloud-engine.js) and cached; the workspace UI and audio live in
 * studios/cloud/cloud-{panels,canvases,audio}.js and are mounted by ui/studio-host.js.
 * 문서는 appState.studioParams.cloud에 저장. 이벤트는 시그니처당 한 번 생성·캐시.
 *
 * Bake to Glissando Voices: events are coloured into ≤ 64 lanes; each lane (or lane chunk) is one
 * Voice with exact piecewise-linear MIDI points and the envelopes as gain points (pan is lost).
 * Imports: core/*, modules/*, studios/registry.js, studios/cloud/cloud-engine.js, cloud-i18n.js.
 */

import { deepClone } from '../core/math-utils.js';
import { appState, registerSelfCheck, withIsolatedState, createDefaultVoice } from '../core/state.js';
import { findMissingI18nKeys } from '../core/i18n.js';
import { StudioRegistry, MAX_GENERATED_VOICES } from './registry.js';
import './cloud/cloud-i18n.js'; // merges the Cloud strings into I18N before the tabs are drawn / 탭보다 먼저 문자열 병합
import {
  createDefaultCloudParams,
  normalizeCloudParams,
  bakeCloudEvents,
  generateCloudEvents,
  getBakeCount,
  cloudEventsToVoices,
  makeCurve,
  sampleGauss,
  sampleCauchy,
  sampleLevy,
  brownianStep,
  subStream,
  buildSieveSet,
  envelopeCurve,
  ENVELOPES,
  assignLanes,
  maxOverlap,
  voiceMidiAt,
  eventMidiAt,
  LANE_GAP_SEC,
  MAX_BAKE_VOICES,
} from './cloud/cloud-engine.js';

export const CLOUD_ID = 'cloud';

/** Cloud document (defaults deep-merged with the saved params). / 클라우드 문서 */
export function getCloudParams() {
  return normalizeCloudParams(StudioRegistry.has(CLOUD_ID) ? StudioRegistry.getParams(CLOUD_ID) : createDefaultCloudParams());
}

/**
 * Apply an edit: `fn(draft)` mutates a copy. View-only edits pass { history: false }.
 * 문서 편집 (뷰 전용 변경은 history:false).
 */
export function editCloud(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getCloudParams();
  fn(draft);
  return StudioRegistry.setParams(CLOUD_ID, normalizeCloudParams(draft), { history, coalesceKey });
}

/** Cached event list of the current document. / 현재 문서의 이벤트 (캐시) */
export function getCloudEvents(params = getCloudParams()) {
  return bakeCloudEvents(params);
}

// --------------------------------------------------------------------------
// Presets / 프리셋
// --------------------------------------------------------------------------

export const CLOUD_PRESETS = Object.freeze([
  {
    id: 'gaussRain',
    apply: (d) => {
      d.length = 30;
      d.density = makeCurve(30);
      Object.assign(d.pitch, { center: makeCurve(60), width: makeCurve(7), dist: 'gauss' });
      Object.assign(d.glide, { mode: 'slope', slopeMean: 0, slopeSpread: 6, upBias: 0.5 });
      Object.assign(d.duration, { dist: 'exp', mean: 0.8, min: 0.05, max: 4 });
    },
  },
  {
    id: 'levyFlights',
    apply: (d) => {
      d.length = 30;
      d.density = makeCurve(8, 26, 'harmonic');
      Object.assign(d.pitch, { center: makeCurve(64), width: makeCurve(3), dist: 'levy', levyAlpha: 1.3 });
      Object.assign(d.glide, { mode: 'target', slopeMean: 0, slopeSpread: 6, upBias: 0.5 });
      Object.assign(d.duration, { dist: 'lognormal', mean: 0.6, min: 0.08, max: 2.5 });
      Object.assign(d.gain, { envelope: 'tukey', attack: 0.04 });
    },
  },
  {
    id: 'brownianClimb',
    apply: (d) => {
      d.length = 30;
      d.density = makeCurve(40);
      Object.assign(d.pitch, { center: makeCurve(40, 86), width: makeCurve(6), dist: 'brownian', brownStep: 1.2, brownDrift: 0.15 });
      Object.assign(d.glide, { mode: 'slope', slopeMean: 2, slopeSpread: 2, upBias: 0.8 });
      Object.assign(d.duration, { dist: 'exp', mean: 0.35, min: 0.05, max: 2 });
    },
  },
  {
    id: 'ligetiCollapse',
    apply: (d) => {
      d.length = 40;
      d.density = makeCurve(20, 80);
      Object.assign(d.pitch, { center: makeCurve(62), width: makeCurve(24, 0), dist: 'uniform' });
      Object.assign(d.glide, { mode: 'slope', slopeMean: 0, slopeSpread: 1, upBias: 0.5, clusterCollapse: makeCurve(0, 1, 'expo', { expMode: 'exp', expK: 3 }) });
      Object.assign(d.duration, { dist: 'lognormal', mean: 1.5, min: 0.2, max: 4 });
      Object.assign(d.gain, { envelope: 'hann' });
    },
  },
  {
    id: 'sieveGarden',
    apply: (d) => {
      d.length = 30;
      d.density = makeCurve(12);
      Object.assign(d.pitch, {
        center: makeCurve(66), width: makeCurve(10), dist: 'uniform', snapSieve: true,
        sieve: { enabled: true, op: 'union', grid: 'quarter', terms: [{ mod: 3, residues: [0], shift: 0 }, { mod: 5, residues: [0], shift: 0 }] },
      });
      Object.assign(d.glide, { mode: 'slope', slopeMean: 0, slopeSpread: 0.4, upBias: 0.5 });
      Object.assign(d.duration, { dist: 'uniform', mean: 1.2, min: 0.4, max: 2.2 });
      Object.assign(d.gain, { envelope: 'expdecay', attack: 0.01 });
    },
  },
]);

/** Preset document (keeps the seed, timbre and scheduler settings). / 프리셋 문서 */
export function buildPresetParams(presetId, base = getCloudParams()) {
  const p = CLOUD_PRESETS.find((x) => x.id === presetId);
  const d = createDefaultCloudParams();
  d.seed = base.seed;
  d.timbre = deepClone(base.timbre);
  d.sched = deepClone(base.sched);
  if (p) p.apply(d);
  d.view = { ...d.view, tMin: 0, tMax: d.length, curveTab: base.view?.curveTab || 'density' };
  return normalizeCloudParams(d);
}

export function applyCloudPreset(presetId) {
  const next = buildPresetParams(presetId);
  return editCloud((d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, next); });
}

// --------------------------------------------------------------------------
// Bake to Glissando voices / 글리산도 보이스로 베이킹
// --------------------------------------------------------------------------

let lastVoiceReport = null;
/** Report of the last generateVoices call (lanes, dropped events, anchor budget). / 마지막 보고 */
export const getLastVoiceReport = () => lastVoiceReport;

export const CloudStudio = {
  id: CLOUD_ID,
  name: { en: 'Cloud Studio', ko: '클라우드 스튜디오' },
  description: { en: 'Stochastic glissando clouds (Xenakis): density, distributions, sieves', ko: '확률 글리산도 구름 (크세나키스): 밀도·분포·체' },
  order: 60,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'cloud',
  defaultParams: createDefaultCloudParams,
  generateVoices(params, helpers) {
    const doc = normalizeCloudParams(params);
    const ev = bakeCloudEvents(doc);
    const { voices, report } = cloudEventsToVoices(ev, helpers, { maxVoices: MAX_GENERATED_VOICES, timbre: doc.timbre });
    lastVoiceReport = report;
    return voices;
  },
};

StudioRegistry.register(CloudStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

const constDoc = (over = {}) => {
  const d = createDefaultCloudParams();
  Object.assign(d, over);
  return normalizeCloudParams(d);
};
const sameArrays = (a, b) => a.n === b.n && ['t0', 'dur', 'p0', 'p1', 'gain', 'pan'].every((k) => a[k].every((x, i) => x === b[k][i]));

registerSelfCheck('Cloud: determinism, signature cache, Poisson counts', (a) => {
  a.ok(StudioRegistry.has(CLOUD_ID), 'registered');
  const p = createDefaultCloudParams();
  const before = getBakeCount();
  const e1 = bakeCloudEvents(p);
  const e2 = bakeCloudEvents(deepClone(p));
  a.ok(e1 === e2, 'same signature → cached object');
  a.ok(getBakeCount() - before <= 1, 'generated at most once');
  a.ok(sameArrays(generateCloudEvents(p), e1), 'uncached regeneration is identical');
  const timbreOnly = deepClone(p);
  timbreOnly.timbre.saw = 1;
  timbreOnly.view.tMax = 7;
  a.ok(bakeCloudEvents(timbreOnly) === e1, 'timbre / view edits keep the cache');
  const other = bakeCloudEvents({ ...deepClone(p), seed: 2 });
  a.ok(other !== e1 && !sameArrays(other, e1), 'different seed → different events');
  // Constant λ = 20, T = 60: N ~ Poisson(1200), σ ≈ 34.6 / 상수 강도
  const counts = [];
  for (let s = 1; s <= 5; s++) {
    const r = generateCloudEvents(constDoc({ seed: s, length: 60, density: makeCurve(20), maxEvents: 20000, maxPolyphony: 256 }));
    counts.push(r.stats.generated);
    a.ok(Math.abs(r.stats.generated - 1200) <= 3 * Math.sqrt(1200), `seed ${s}: ${r.stats.generated} within 1200 ± 3σ`);
    a.near(r.stats.expected, 1200, 1e-6, 'Λ(T) = λT');
  }
  const mean = counts.reduce((s, x) => s + x, 0) / counts.length;
  a.ok(Math.abs(mean - 1200) <= (3 * Math.sqrt(1200)) / Math.sqrt(5), `mean ${mean} within 1200 ± 3σ/√5`);
  // Linear ramp λ: 2 → 40 over 60 s; N(second half)/N(first half) = (a+3b)/(3a+b) / 선형 램프
  const ramp = generateCloudEvents(constDoc({ seed: 7, length: 60, density: makeCurve(2, 40), maxEvents: 20000, maxPolyphony: 256 }));
  let first = 0;
  let second = 0;
  // Count generated onsets (before any drop) from the raw times: rebuild with no cap on polyphony.
  for (let i = 0; i < ramp.n; i++) (ramp.t0[i] < 30 ? first++ : second++);
  const theory = (2 + 3 * 40) / (3 * 2 + 40);
  a.ok(Math.abs(second / first - theory) / theory <= 0.15, `ramp ratio ${(second / first).toFixed(3)} vs ${theory.toFixed(3)} (±15%)`);
  a.equal(ramp.stats.droppedPoly, 0, 'ramp check is not affected by the polyphony cap');
}, { group: 'studio' });

registerSelfCheck('Cloud: distribution samplers (gauss, cauchy, lévy α=2, brownian)', (a) => {
  const N = 100000;
  const r = subStream(42, 9);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < N; i++) { const x = sampleGauss(r); s += x; s2 += x * x; }
  const m = s / N;
  a.ok(Math.abs(m) <= 0.03, `gauss mean ${m.toFixed(4)} ≈ 0 (±3% σ)`);
  a.ok(Math.abs(Math.sqrt(s2 / N - m * m) - 1) <= 0.03, 'gauss σ ≈ 1 (±3%)');
  const c = Float64Array.from({ length: N }, () => sampleCauchy(r)).sort();
  a.ok(Math.abs(c[N >> 1]) <= 0.02, `cauchy median ${c[N >> 1].toFixed(4)} ≈ 0`);
  a.ok(Math.abs(c[Math.floor(0.75 * N)] - 1) <= 0.03, 'cauchy upper quartile ≈ γ');
  let l2 = 0;
  for (let i = 0; i < N; i++) { const x = sampleLevy(r, 2); l2 += x * x; }
  a.ok(Math.abs(Math.sqrt(l2 / N) - Math.SQRT2) / Math.SQRT2 <= 0.03, `lévy α=2 σ ${Math.sqrt(l2 / N).toFixed(4)} ≈ √2`);
  let b2 = 0;
  let bm = 0;
  for (let i = 0; i < N; i++) { const d = brownianStep(r, 2, 0.1); bm += d; b2 += (d - 0.1) * (d - 0.1); }
  a.ok(Math.abs(b2 / N - 4) / 4 <= 0.03, `brownian increment variance ${(b2 / N).toFixed(3)} ≈ step² = 4`);
  a.ok(Math.abs(bm / N - 0.1) <= 0.03, 'brownian drift');
  // In a generated cloud with a wide band the walk's increments keep that variance / 생성 구름에서도 확인
  const w = generateCloudEvents(constDoc({ seed: 3, length: 60, density: makeCurve(30), pitch: { ...createDefaultCloudParams().pitch, dist: 'brownian', brownStep: 0.5, center: makeCurve(66), width: makeCurve(48), min: 12, max: 120 }, maxPolyphony: 256 }));
  let v = 0;
  for (let i = 1; i < w.n; i++) v += (w.p0[i] - w.p0[i - 1]) ** 2;
  a.ok(Math.abs(v / (w.n - 1) - 0.25) / 0.25 <= 0.15, `cloud brownian increments ${(v / (w.n - 1)).toFixed(3)} ≈ 0.25`);
}, { group: 'studio' });

registerSelfCheck('Cloud: sieves, polyphony cap, envelopes, event cap', (a) => {
  const sieve = { enabled: true, op: 'union', grid: 'quarter', terms: [{ mod: 3, residues: [0] }, { mod: 5, residues: [0] }] };
  const U = buildSieveSet(sieve, 24, 108);
  const I = buildSieveSet({ ...sieve, op: 'inter' }, 24, 108);
  const T3 = buildSieveSet(sieve, 24, 108, [sieve.terms[0]]);
  const T5 = buildSieveSet(sieve, 24, 108, [sieve.terms[1]]);
  const has = (set, x) => set.some((y) => Math.abs(y - x) < 1e-9);
  a.ok([...T3, ...T5].every((x) => has(U, x)), 'union ⊇ each term');
  a.ok([...I].every((x) => has(T3, x) && has(T5, x)), 'intersection ⊆ each term');
  a.ok(I.length > 0 && I.length < T3.length && U.length > T3.length, 'sizes ordered');
  for (const snap of [true, false]) {
    const d = createDefaultCloudParams();
    d.pitch.sieve = sieve;
    d.pitch.snapSieve = snap;
    d.glide.mode = snap ? 'slope' : 'target';
    const ev = generateCloudEvents(d);
    a.ok(ev.n > 50, `sieve cloud has events (${ev.n})`);
    let bad = 0;
    for (let i = 0; i < ev.n; i++) if (!has(U, ev.p0[i]) || !has(U, ev.p1[i])) bad++;
    a.equal(bad, 0, `every pitch ∈ sieve (snap=${snap})`);
  }
  // Polyphony / 폴리포니
  const dense = generateCloudEvents(constDoc({ density: makeCurve(150), maxPolyphony: 16, length: 20 }));
  a.ok(dense.stats.droppedPoly > 0, 'cap engaged');
  a.ok(maxOverlap(dense) <= 16, `max simultaneous ${maxOverlap(dense)} ≤ 16`);
  // Event cap / 이벤트 상한
  const capped = generateCloudEvents(constDoc({ density: makeCurve(200), maxEvents: 500, length: 60 }));
  a.ok(capped.n <= 500 && capped.stats.truncated, `event cap (${capped.n})`);
  // Envelopes are 0 at both ends / 포락선 양끝 0
  for (const e of ENVELOPES) for (const dur of [0.05, 0.8, 4]) {
    const c = envelopeCurve(e, dur, 0.02, 64);
    a.ok(c[0] === 0 && c[63] === 0 && c.every((x) => x >= 0 && x <= 1.000001), `${e} ${dur}s ends at 0`);
  }
}, { group: 'studio' });

registerSelfCheck('Cloud: lanes (greedy optimal) and bake to ≤ 64 Glissando voices', (a) => {
  const p = createDefaultCloudParams();
  const ev = bakeCloudEvents(p);
  const { lane, laneCount } = assignLanes(ev);
  a.equal(laneCount, maxOverlap(ev, LANE_GAP_SEC), 'lane count = max overlap (greedy is optimal)');
  const lastEnd = new Map();
  let clash = 0;
  for (let i = 0; i < ev.n; i++) {
    const prev = lastEnd.get(lane[i]);
    if (prev !== undefined && prev > ev.t0[i] + 1e-6) clash++;
    lastEnd.set(lane[i], ev.t0[i] + ev.dur[i] + LANE_GAP_SEC);
  }
  a.equal(clash, 0, 'no overlap inside a lane');
  withIsolatedState(() => {
    const snapshot = JSON.stringify(appState.studioParams?.[CLOUD_ID] ?? null);
    const before = JSON.stringify(p);
    const voices = StudioRegistry.generateVoices(CLOUD_ID, p);
    const rep = getLastVoiceReport();
    a.ok(voices.length >= 1 && voices.length <= MAX_GENERATED_VOICES, `voice count ${voices.length} ≤ 64`);
    a.ok(rep.lanes <= MAX_BAKE_VOICES, `lanes ${rep.lanes} ≤ 64 (dropped ${rep.dropped})`);
    a.ok(voices.every((v) => v.engine === 'custom' && v.customPoints.every((q, i, arr) => i === 0 || q.x > arr[i - 1].x)), 'custom anchors strictly increasing in x');
    a.ok(voices.every((v) => v.gainPoints.every((q, i, arr) => i === 0 || q.x > arr[i - 1].x) && v.gainPoints[0].y === 0), 'gain anchors increasing, start silent');
    a.equal(JSON.stringify(p), before, 'document unchanged');
    a.equal(JSON.stringify(appState.studioParams?.[CLOUD_ID] ?? null), snapshot, 'state unchanged by generateVoices');
    // Pitch is exact: compare each lane voice against its events at their midpoints / 음고 정확도
    const helpers = { createDefaultVoice, startIndex: 0 };
    const { voices: raw } = cloudEventsToVoices(ev, helpers, {});
    // Each event is tested against the voice of its own lane chunk / 각 이벤트를 자기 레인 보이스와 비교
    let worst = 0;
    let tested = 0;
    if (laneCount <= MAX_BAKE_VOICES) {
      const ownVoice = (i) => raw.find((x) => {
        const base = `Cloud L${lane[i] + 1}`;
        const named = x.name === base || x.name.startsWith(`${base}·`);
        return named && ev.t0[i] >= x.startTime - 1e-5 && ev.t0[i] + ev.dur[i] <= x.startTime + x.duration + 1e-5;
      });
      for (let i = 0; i < ev.n; i += 3) {
        const v = ownVoice(i);
        if (!v) continue;
        const mid = ev.t0[i] + 0.5 * ev.dur[i];
        worst = Math.max(worst, Math.abs(voiceMidiAt(v, mid) - eventMidiAt(ev, i, mid)));
        tested++;
      }
      a.ok(tested > 20, `pitch comparison ran (${tested} events)`);
      a.ok(worst < 0.02, `lane voice pitch matches events (max err ${worst.toFixed(4)} st)`);
    }
    // A dense cloud is thinned to 64 lanes / 조밀한 구름은 64 레인으로 솎음
    const big = bakeCloudEvents(constDoc({ density: makeCurve(120), length: 20, maxPolyphony: 200 }));
    const out = cloudEventsToVoices(big, helpers, {});
    a.ok(out.voices.length <= 64 && out.report.lanes <= 64 && out.report.dropped > 0, `dense: ${out.report.lanes} lanes, ${out.report.dropped} dropped, ${out.voices.length} voices`);
  });
  const { missingInEn, missingInKo } = findMissingI18nKeys();
  a.ok(!missingInEn.some((k) => k.startsWith('cloud.')) && !missingInKo.some((k) => k.startsWith('cloud.')), 'cloud i18n parity');
}, { group: 'studio' });
