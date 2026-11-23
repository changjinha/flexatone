/**
 * Flexatone — modules/timbre-spec.js
 * Layer 1 (modules, pure): the "timbre spec" every studio stores, so all of them offer the same
 * timbre synthesis as the Glissando Studio (5-wave Mix **and** ƒ(x) Function Wave).
 * 계층 1 (modules, 순수): 모든 스튜디오가 저장하는 "음색 스펙" — 글리산도 스튜디오와 같은 음색 합성
 * (5파형 믹스 + ƒ(x) 함수 파형)을 어디서나 쓰기 위한 공용 형식.
 *
 *   spec = { sine, tri, saw, sqr, rich,            5-wave weights (as before)
 *            mode?: 'mix' | 'func',                 missing = 'mix' (old documents load unchanged)
 *            func?: { source: 'formula' | 'voice', expr, voiceId } }
 * The extra fields live *inside* the studio's existing `timbre` object on purpose: every studio
 * already keeps `timbre` out of its bake signature and inside its audio key, so a mode / formula
 * edit never re-bakes and is picked up by live playback without new plumbing.
 * mode / func를 기존 `timbre` 객체 안에 둔 이유: 각 스튜디오가 이미 `timbre`를 베이킹 시그니처에서 빼고
 * 오디오 키에는 넣고 있어서, 재베이킹 없이 실시간 재생에 바로 반영됨.
 *
 * Imports: core/*, modules/timbre-synth.js. No DOM / Audio APIs.
 */

import { TIMBRE_WAVES, registerSelfCheck } from '../core/state.js';
import { readTimbreWeights, getTimbreCoefficientsCached, previewTimbreCycle } from './timbre-synth.js';
import { normalizeSampleSpec, sampleSpecKey } from './sample-source.js';

/** 'sample' = per-voice Sampler (modules/sample-source.js); synthesis reads it as the Mix. / 보이스별 샘플러 */
export const TIMBRE_MODES = Object.freeze(['mix', 'func', 'sample']);
export const TIMBRE_FUNC_SOURCES = Object.freeze(['formula', 'voice']);
export const DEFAULT_TIMBRE_FUNC = Object.freeze({ source: 'formula', expr: 'sin(2*pi*x) + 0.35*sin(6*pi*x)', voiceId: '' });
/** Harmonics the studios have always used for their PeriodicWave (Glissando uses 64). */
export const STUDIO_TIMBRE_HARMONICS = 32;

export const timbreSpecMode = (spec) => (spec && (spec.mode === 'func' || spec.mode === 'sample') ? spec.mode : 'mix');

/** The ƒ(x) block of a spec with defaults filled in. / 기본값을 채운 ƒ(x) 블록 */
export function timbreSpecFunc(spec) {
  const f = spec && spec.func && typeof spec.func === 'object' ? spec.func : {};
  return {
    source: TIMBRE_FUNC_SOURCES.includes(f.source) ? f.source : DEFAULT_TIMBRE_FUNC.source,
    expr: typeof f.expr === 'string' ? f.expr : DEFAULT_TIMBRE_FUNC.expr,
    voiceId: typeof f.voiceId === 'string' ? f.voiceId : '',
  };
}

/**
 * Normalised copy of the mode / func part only (merge it into a studio's own timbre normaliser).
 * 스튜디오의 음색 정규화에 합쳐 쓰는 mode / func 부분.
 */
export function timbreSpecExtras(spec) {
  const out = { mode: timbreSpecMode(spec), func: timbreSpecFunc(spec) };
  if (spec && spec.sample) out.sample = normalizeSampleSpec(spec.sample); // kept even when switched back to Mix / 믹스로 바꿔도 유지
  return out;
}

/** View a spec as the voice-shaped object the voice-level timbre API expects. / 보이스 형태로 보기 */
export function timbreSpecAsVoice(spec) {
  return { timbre: spec && typeof spec === 'object' ? spec : {}, timbreMode: timbreSpecMode(spec), timbreFunc: timbreSpecFunc(spec), timbreSample: normalizeSampleSpec(spec?.sample) };
}

/** Voice fields for "Bake to Glissando Voices": the baked voice keeps the same timbre synthesis. */
export function timbreSpecToVoiceFields(spec) {
  const out = { timbre: readTimbreWeights(spec), timbreMode: timbreSpecMode(spec), timbreFunc: timbreSpecFunc(spec) };
  if (spec && spec.sample) out.timbreSample = normalizeSampleSpec(spec.sample); // the baked voice keeps its sample / 샘플 유지
  return out;
}

/**
 * PeriodicWave coefficients of a spec (memoised). `voices` are the Glissando voices a
 * 'voice' source may read. A failing ƒ(x) falls back to the mix and reports `error`.
 */
export function timbreSpecCoefficients(spec, { voices = [], harmonics = STUDIO_TIMBRE_HARMONICS } = {}) {
  return getTimbreCoefficientsCached(timbreSpecAsVoice(spec), { voices, harmonics });
}

/** One normalised cycle for the editor preview. / 편집기 미리보기용 한 주기 */
export function timbreSpecPreview(spec, { voices = [], points = 256 } = {}) {
  return previewTimbreCycle(timbreSpecAsVoice(spec), { voices, points, harmonics: STUDIO_TIMBRE_HARMONICS });
}

/** Short string the sound depends on (for audio / render keys). / 오디오 키 */
export function timbreSpecKey(spec) {
  const w = readTimbreWeights(spec);
  const f = timbreSpecFunc(spec);
  const mode = timbreSpecMode(spec);
  const smp = mode === 'sample' ? `|${sampleSpecKey(spec.sample)}` : '';
  return `${mode}|${TIMBRE_WAVES.map((k) => w[k]).join(',')}|${f.source}|${f.source === 'voice' ? f.voiceId : f.expr}${smp}`;
}

registerSelfCheck('Timbre spec: Mix = old 5-wave result, ƒ(x) changes the wave, bad formula falls back', (a) => {
  const mix = { sine: 0.7, tri: 0.3, saw: 0.1, sqr: 0, rich: 0.15 };
  const c0 = timbreSpecCoefficients(mix);
  a.equal(c0.real.length, STUDIO_TIMBRE_HARMONICS, 'studio harmonic count kept');
  a.ok(c0.mode === 'mix' && !c0.error, 'no mode field = mix (old documents)');
  const fn = { ...mix, mode: 'func', func: { source: 'formula', expr: 'saw(x)' } };
  const c1 = timbreSpecCoefficients(fn);
  a.ok(c1.mode === 'func' && !c1.error, 'formula compiles');
  let diff = 0;
  for (let i = 1; i < c0.imag.length; i++) diff += Math.abs(c0.imag[i] - c1.imag[i]) + Math.abs(c0.real[i] - c1.real[i]);
  a.ok(diff > 0.1, 'ƒ(x) gives a different spectrum');
  const bad = timbreSpecCoefficients({ ...mix, mode: 'func', func: { source: 'formula', expr: 'sin(' } });
  a.ok(bad.mode === 'mix' && !!bad.error, 'broken formula → mix + error');
  const vf = timbreSpecToVoiceFields(fn);
  a.equal(Object.keys(vf.timbre).join(), TIMBRE_WAVES.join(), 'baked voice timbre = 5 weights only');
  a.ok(vf.timbreMode === 'func' && vf.timbreFunc.expr === 'saw(x)', 'baked voice keeps ƒ(x)');
  a.ok(timbreSpecKey(mix) !== timbreSpecKey(fn), 'key follows the mode');
  const smp = { ...mix, mode: 'sample', sample: { id: 'smp_x', root: 57 } };
  a.ok(timbreSpecCoefficients(smp).mode === 'mix', 'sample mode → synthesis falls back to the Mix');
  const vs = timbreSpecToVoiceFields(smp);
  a.ok(vs.timbreMode === 'sample' && vs.timbreSample.id === 'smp_x' && vs.timbreSample.root === 57, 'baked voice keeps its sample');
  a.ok(timbreSpecKey(smp) !== timbreSpecKey({ ...smp, sample: { id: 'smp_x', root: 58 } }), 'key follows the sample');
}, { group: 'timbre' });
