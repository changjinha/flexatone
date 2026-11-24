/**
 * Flexatone — core/line-mix.js
 * Layer 0 (core, pure): **S / M / gain per line** for studios whose voices are generated (Chaos voices,
 * Fractal voices, Wave ridges) and therefore have no voice objects of their own to carry mute / solo.
 * Stored in the studio document as `lineMix: { [lineKey]: { mute, solo, gain } }` (keys = the studio's
 * Master View line keys: Chaos `c0…`, Fractal `f0…`, Wave `w0…`), so playback, WAV, the Manager and
 * undo all follow it. Same rule as every other studio: a muted line is silent; when any line is soloed,
 * only soloed lines sound. / 생성되는 보이스(카오스·프랙탈·웨이브 리지)의 선별 S / M / 게인. 문서의 lineMix에 저장.
 */

import { registerSelfCheck } from './state.js';

export const LINE_MIX_KEY = 'lineMix';
export const LINE_GAIN_MAX = 1.5;

const entry = (raw) => {
  const g = Number(raw?.gain);
  return { mute: raw?.mute === true, solo: raw?.solo === true, gain: Number.isFinite(g) ? Math.min(LINE_GAIN_MAX, Math.max(0, g)) : 1 };
};

/** Validated mix; neutral entries are dropped. / 검증 (기본값 항목은 버림) */
export function normalizeLineMix(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    const e = entry(v);
    if (e.mute || e.solo || e.gain !== 1) out[String(k).slice(0, 40)] = e;
  }
  return out;
}

/** Entry of one line (defaults when absent). / 선 하나의 설정 */
export function lineMixOf(doc, key) {
  return entry(doc?.[LINE_MIX_KEY]?.[key]);
}

export function lineMixAnySolo(doc) {
  const m = doc?.[LINE_MIX_KEY];
  return !!m && Object.values(m).some((e) => e?.solo === true);
}

/** Gain factor of a line: 0 when silent by S / M, else its gain. / 선의 게인 배율 (S / M으로 꺼지면 0) */
export function lineMixGain(doc, key) {
  const e = lineMixOf(doc, key);
  if (e.mute) return 0;
  if (lineMixAnySolo(doc) && !e.solo) return 0;
  return e.gain;
}

/** New mix with one line patched (pure; for an edit function). / 선 하나를 바꾼 새 믹스 */
export function patchLineMix(mix, key, patch) {
  const all = { ...normalizeLineMix(mix) };
  all[key] = entry({ ...lineMixOf({ [LINE_MIX_KEY]: all }, key), ...patch });
  return normalizeLineMix(all);
}

registerSelfCheck('Line mix: mute, solo, gain per generated line (Chaos · Fractal · Wave)', (a) => {
  const doc = { lineMix: { c0: { mute: true }, c2: { gain: 0.5 } } };
  a.equal(lineMixGain(doc, 'c0'), 0, 'muted');
  a.equal(lineMixGain(doc, 'c1'), 1, 'untouched line');
  a.equal(lineMixGain(doc, 'c2'), 0.5, 'gain');
  const solo = { lineMix: patchLineMix(doc.lineMix, 'c1', { solo: true }) };
  a.equal(lineMixGain(solo, 'c2'), 0, 'not soloed → silent');
  a.equal(lineMixGain(solo, 'c1'), 1, 'soloed');
  a.equal(Object.keys(patchLineMix({}, 'x', { gain: 1 })).length, 0, 'neutral entries are dropped');
  a.equal(lineMixGain({}, 'c9'), 1, 'no mix = all sound');
});
