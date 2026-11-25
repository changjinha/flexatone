/**
 * Flexatone — studios/tempo-studio.js
 * Layer 2 (studios): Tempo Studio plugin — tempo canons / phasing ("템포 캐논").
 * 계층 2 (studios): 템포 스튜디오 플러그인 — 템포 캐논 / 페이징.
 *
 * Not the Tempo Manager (core/tempo.js): that one scales the playback speed of whole tracks;
 * this studio builds relative tempo structure between voices inside a piece. Both use the same
 * meaning of `rate` (× speed) and multiply when combined.
 * 템포 매니저(트랙 재생 속도)와 다름 — 보이스 간 상대 템포 구조를 생성. 배속 의미는 동일하며 곱해짐.
 *
 * The whole document lives in appState.studioParams.tempo (saved, undoable). This file reads
 * appState only to resolve a Glissando voice used as the subject (read-only) and hands plain
 * values to the pure engine. UI / audio live in studios/tempo/* and are mounted by ui/studio-host.js.
 * Imports: core/*, modules/*, studios/registry.js, studios/tempo/tempo-engine.js, tempo-i18n.js.
 */

import { splitClip, syncLinkedAfterEdit } from '../core/line-clip.js';
import { deepClone } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { findMissingI18nKeys, I18N } from '../core/i18n.js';
import { appState, registerSelfCheck, withIsolatedState } from '../core/state.js';
import { getVoiceMidiAtNormT, evaluateCurveObjectY } from '../modules/curve-engine.js';
import { MAX_GENERATED_VOICES, StudioRegistry } from './registry.js';
import { TEMPO_HELP, TEMPO_I18N_KEYS } from './tempo/tempo-i18n.js';
import {
  createDefaultTempoParams,
  normalizeTempoDoc,
  buildSubjectFromNotes,
  buildSubjectFromCurve,
  bakeTempo,
  getTempoBakeCount,
  getLastBakeMs,
  listBakeSegments,
  segmentToVoiceCurves,
  buildTrack,
  integrateRate,
  evalS,
  invertS,
  rateAt,
  readCurve,
  voiceRateFn,
  randomSubjectNotes,
  createTempoCurve,
  TEMPO_PRESETS,
  PRESET_IDS,
  RATE_MIN,
  BAKE_RATE,
  MAX_TEMPO_VOICES,
} from './tempo/tempo-engine.js';
import { timbreSpecToVoiceFields } from '../modules/timbre-spec.js';

export const TEMPO_ID = 'tempo';
const GLISS_SUBJECT_SAMPLES = 96;

/** Tempo document = defaults overlaid with the saved params, normalized. / 템포 문서 */
export function getTempoParams() {
  return normalizeTempoDoc(StudioRegistry.has(TEMPO_ID) ? StudioRegistry.getParams(TEMPO_ID) : createDefaultTempoParams());
}

/**
 * Apply an edit: `fn(draft)` mutates a copy. View-only edits pass { history: false }.
 * 템포 문서 편집.
 */
export function editTempo(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getTempoParams();
  const before = draft.voices.some((v) => v.link?.on) ? JSON.parse(JSON.stringify(draft.voices)) : null;
  fn(draft);
  // 🔗 linked pieces of one voice keep one tempo line (core/line-clip.js) / 링크된 조각은 같은 템포 선
  if (before) syncLinkedAfterEdit(before, draft.voices, TEMPO_LINK_KEYS, draft.activeVoiceId);
  return StudioRegistry.setParams(TEMPO_ID, draft, { history, coalesceKey });
}

/** What linked pieces of a voice share (🔗): its tempo line, loop and transposition. / 링크된 조각이 공유하는 필드 */
export const TEMPO_LINK_KEYS = Object.freeze(['tempo', 'loop', 'transpose', 'octaveShift']);

/**
 * ✂ Cut a voice at `sec` into two linked voices (Locate double-click on the timeline): both keep the
 * whole tempo line, their play ranges split the audible window. / 보이스를 sec에서 링크된 두 보이스로 자르기
 */
export function splitTempoVoice(id, sec) {
  const doc = getTempoParams();
  const bv = getTempoBake(doc)?.map?.get(id);
  if (!bv || doc.voices.length >= MAX_TEMPO_VOICES) return false;
  let ok = false;
  editTempo((d) => {
    const i = d.voices.findIndex((x) => x.id === id);
    const v = d.voices[i];
    if (!v) return;
    const cl = splitClip(v.clip, bv.uOn0, Math.max(1e-6, bv.uOff0 - bv.uOn0), sec);
    if (!cl) return;
    const linkId = v.link?.id || `ln_${Math.random().toString(36).slice(2, 8)}`;
    const b = JSON.parse(JSON.stringify(v));
    b.id = `tv_${Math.random().toString(36).slice(2, 8)}`;
    b.name = `${String(v.name || 'Voice').replace(/ ✂\d+$/, '')} ✂${Math.max(1, d.voices.filter((x) => x.link?.id === linkId).length) + 1}`.slice(0, 40);
    b.solo = false;
    v.link = { id: linkId, on: true };
    b.link = { id: linkId, on: true };
    if (cl[0]) v.clip = cl[0]; else delete v.clip;
    if (cl[1]) b.clip = cl[1]; else delete b.clip;
    d.voices.splice(i + 1, 0, b);
    d.activeVoiceId = b.id;
    ok = true;
  });
  return ok;
}

export function getActiveTempoVoice(doc = getTempoParams()) {
  return doc.voices.find((v) => v.id === doc.activeVoiceId) || doc.voices[0];
}

export function isTempoVoiceAudible(v, doc = getTempoParams()) {
  return doc.voices.some((x) => x.solo) ? !!v.solo : !v.muted;
}

/**
 * Subject for the engine. 'glissandoVoice' reads appState.voices[voiceIndex] (read-only).
 * @returns {{ sub: object, fallback: boolean }}
 */
export function resolveSubject(doc, state = appState) {
  const s = doc.subject;
  if (s.source === 'glissandoVoice') {
    const v = state.voices?.[s.voiceIndex];
    if (v && v.duration > 0.05) {
      const pts = [];
      for (let i = 0; i <= GLISS_SUBJECT_SAMPLES; i++) {
        const x = i / GLISS_SUBJECT_SAMPLES;
        pts.push({ s: x * v.duration, midi: getVoiceMidiAtNormT(v, x) });
      }
      return { sub: buildSubjectFromCurve(pts, v.duration, s.bpmRef), fallback: false };
    }
    return { sub: buildSubjectFromNotes(s.notes, s.bpmRef), fallback: true };
  }
  if (s.source === 'curve') { // a received line (trajectory send) / 받은 선
    if (Array.isArray(s.curve) && s.curve.length >= 2 && s.curveLen > 0.05) return { sub: buildSubjectFromCurve(s.curve, s.curveLen, s.bpmRef), fallback: false };
    return { sub: buildSubjectFromNotes(s.notes, s.bpmRef), fallback: true };
  }
  return { sub: buildSubjectFromNotes(s.notes, s.bpmRef), fallback: false };
}

/** Baked timing + audio curves for the current document (memoised). / 현재 베이킹 결과 */
export function getTempoBake(doc = getTempoParams(), state = appState) {
  return bakeTempo(doc, resolveSubject(doc, state).sub);
}

/** Pitch offset of a voice (transpose + octaves), applied after the bake. / 음고 이동 */
export const voicePitchOffset = (v) => (Number(v.transpose) || 0) + 12 * (Number(v.octaveShift) || 0);

/** Loop segments that would become Glissando voices (≤ 64) and the overflow info. / 베이킹 계획 */
export function getBakePlan(doc = getTempoParams(), bake = getTempoBake(doc)) {
  const all = listBakeSegments(bake, doc);
  const kept = all.slice(0, MAX_GENERATED_VOICES);
  return { all, kept, total: all.length, over: all.length > MAX_GENERATED_VOICES, cutSec: kept.length ? kept[kept.length - 1].seg.u1 : 0 };
}

/** One loop segment → one Glissando Voice (engine custom). / 루프 구간 → 글리산도 보이스 */
export function segmentToGlissandoVoice(bake, item, doc, helpers, index) {
  const { bv, seg, voice } = item;
  const c = segmentToVoiceCurves(bake, bv, seg, doc.quantizeBake);
  const off = voicePitchOffset(voice);
  return helpers.createDefaultVoice(index, {
    name: `${voice.name} · ${seg.k + 1}`,
    color: voice.color,
    solo: !!voice.solo,
    muted: !!voice.muted,
    startTime: seg.u0,
    duration: seg.u1 - seg.u0,
    baseGain: voice.baseGain,
    f0Hz: midiToFreq(c.mLo + off),
    f1Hz: midiToFreq(c.mHi + off),
    f0Fine: 0,
    f1Fine: 0,
    logScale: true,
    ...timbreSpecToVoiceFields(voice.timbre), // Mix or ƒ(x) carried into the baked voice / 믹스·ƒ(x)를 베이킹 보이스에 그대로
    engine: 'custom',
    lastNonCustomEngine: 'harmonic',
    customPoints: c.customPoints,
    gainMode: 'points',
    gainPoints: c.gainPoints,
  });
}

export const TempoStudio = {
  id: TEMPO_ID,
  name: { en: 'Tempo Studio', ko: '템포 스튜디오' },
  description: { en: 'Tempo canons: one subject at several tempo curves (convergence, phasing)', ko: '템포 캐논: 하나의 주제를 여러 템포 곡선으로 (수렴, 페이징)' },
  order: 70,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'tempo',
  defaultParams: createDefaultTempoParams,
  generateVoices(params, helpers) {
    const doc = normalizeTempoDoc(params);
    const bake = getTempoBake(doc);
    return getBakePlan(doc, bake).kept.map((item, i) => segmentToGlissandoVoice(bake, item, doc, helpers, helpers.startIndex + i));
  },
};

StudioRegistry.register(TempoStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Tempo studio: convergence canon (analytic < 1e-9, numeric < 1e-6)', (a) => {
  a.ok(StudioRegistry.has(TEMPO_ID), 'registered');
  const doc = normalizeTempoDoc(TEMPO_PRESETS.nancarrow());
  const { Tc, sc } = doc.converge;
  const bake = getTempoBake(doc);
  for (const bv of bake.voices) {
    a.ok(bv.track.constRate !== null, 'constant rates take the analytic path');
    a.near(evalS(bv.track, Tc), sc, 1e-9, `analytic s_${bv.index}(Tc)`);
    a.near(evalS(buildTrack(doc, bv.index, { numeric: true }), Tc), sc, 1e-6, `numeric s_${bv.index}(Tc)`);
  }
  const rates = bake.voices.map((b) => b.track.constRate);
  a.near(rates[0] / rates[1], 3 / 4, 1e-12, 'ratio 3:4');
  a.near(rates[2] / rates[1], 5 / 4, 1e-12, 'ratio 5:4');
  // converge with curved tempo voices (numeric integral path) / 곡선 템포 보이스 수렴
  const cur = deepClone(doc);
  cur.voices[1].tempo = { ...cur.voices[1].tempo, mode: 'curve', lo: 0.6, hi: 1.8, scale: 'log', curve: createTempoCurve('expo', { expK: 4 }) };
  const tr = buildTrack(cur, 1);
  a.ok(tr.constRate === null, 'curve → numeric');
  a.near(evalS(tr, Tc), sc, 1e-6, 'curve voice converges');
}, { group: 'studio' });

registerSelfCheck('Tempo studio: integral vs closed form, inverse round trip, monotone, r ≤ 0 guard', (a) => {
  // exp rate r = e^{ku} → s = (e^{ku} − 1)/k
  for (const [k, T] of [[0.05, 40], [0.2, 10], [-0.08, 30]]) {
    const tr = { ...integrateRate((u) => Math.exp(k * u), T), constRate: null, s0: 0 };
    for (const u of [0.37, T / 3, T / 2, T * 0.9, T]) {
      const exact = (Math.exp(k * u) - 1) / k;
      a.ok(Math.abs(evalS(tr, u) - exact) / Math.abs(exact) < 1e-6, `exp k=${k} u=${u}: rel err ${(Math.abs(evalS(tr, u) - exact) / Math.abs(exact)).toExponential(2)}`);
    }
  }
  const lin = { ...integrateRate(() => 1.7, 20), constRate: null, s0: 3 };
  a.near(evalS(lin, 12.3), 3 + 1.7 * 12.3, 1e-9, 'constant rate numeric = s0 + r·u');
  // curve track: inverse round trip + monotone / 역변환 왕복 + 단조성
  const doc = normalizeTempoDoc(TEMPO_PRESETS.fan());
  for (let i = 0; i < doc.voices.length; i++) {
    const tr = buildTrack(doc, i);
    let prev = -Infinity;
    for (let j = 0; j <= 400; j++) {
      const u = (j / 400) * doc.length;
      const s = evalS(tr, u);
      a.ok(s > prev, `monotone v${i} u=${u}`);
      prev = s;
      a.near(invertS(tr, s), u, 1e-6, `round trip v${i} u=${u}`);
    }
  }
  // r ≤ 0 is floored / r ≤ 0 방어
  const bad = normalizeTempoDoc({ ...TEMPO_PRESETS.stagger(), voices: [{ tempo: { mode: 'const', ratio: -3 } }, { tempo: { mode: 'curve', lo: 0, hi: -2, scale: 'lin', curve: createTempoCurve('expo') } }] });
  a.ok(bad.voices[0].tempo.ratio >= RATE_MIN, 'negative ratio clamped');
  const fnR = voiceRateFn(bad, 1).fn;
  for (let u = 0; u <= bad.length; u += 1) a.ok(fnR(u) >= RATE_MIN, 'curve rate floored');
  const z = integrateRate(() => -5, 10);
  a.ok(z.r.every((x) => x >= RATE_MIN), 'integrator floors rate');
}, { group: 'studio' });

registerSelfCheck('Tempo studio: phasing Δs(L/ε) = L, loop starts satisfy s(u) = kL', (a) => {
  const base = normalizeTempoDoc(TEMPO_PRESETS.reich());
  const { sub } = resolveSubject(base);
  const eps = base.phasing.epsilon;
  const doc = normalizeTempoDoc({ ...base, length: Math.min(300, sub.L / eps) });
  const T = sub.L / eps;
  a.ok(doc.length >= T - 1e-9, `length covers L/ε (${T})`);
  const t0 = buildTrack(doc, 0);
  const t1 = buildTrack(doc, 1);
  a.near(evalS(t1, T) - evalS(t0, T), sub.L, 1e-6, 'one loop of drift');
  a.near(evalS(t1, T / 2) - evalS(t0, T / 2), sub.L / 2, 1e-6, 'half way');
  for (const key of ['nancarrow', 'fan', 'golden']) {
    const d = normalizeTempoDoc(TEMPO_PRESETS[key]());
    const b = getTempoBake(d);
    for (const bv of b.voices) {
      a.ok(bv.loopStarts.length > 0 || !bv.has, `${key}: loop starts exist`);
      for (const u of bv.loopStarts) {
        const q = evalS(bv.track, u) / b.L;
        a.near(q, Math.round(q), 1e-6, `${key} v${bv.index}: s(${u.toFixed(3)}) = kL`);
      }
    }
  }
}, { group: 'studio' });

registerSelfCheck('Tempo studio: signature cache (sound edits = 0 re-bakes), determinism, bake < 100 ms', (a) => {
  const doc = normalizeTempoDoc(TEMPO_PRESETS.golden());
  const b1 = getTempoBake(doc);
  const n0 = getTempoBakeCount();
  a.ok(getTempoBake(deepClone(doc)) === b1, 'same timing → cached');
  const q = deepClone(doc);
  q.voices[0].timbre.saw = 1;
  q.voices[1].baseGain = 0.1;
  q.voices[2].muted = true;
  q.voices[0].transpose = 7;
  q.voices[1].octaveShift = 1;
  q.pulse = { ...q.pulse, level: 1.2, kind: 'tick' };
  a.ok(getTempoBake(normalizeTempoDoc(q)) === b1, 'sound-only edits keep the cache');
  a.equal(getTempoBakeCount(), n0, 'no re-bake for sound edits');
  q.voices[1].tempo.ratio = 1.5;
  const b2 = getTempoBake(normalizeTempoDoc(q));
  a.ok(b2 !== b1 && getTempoBakeCount() === n0 + 1, 'timing edit re-bakes once');
  a.ok(getLastBakeMs() < 100, `bake took ${getLastBakeMs().toFixed(1)} ms`);
  const b3 = getTempoBake(doc);
  a.equal(b3.voices.length, b1.voices.length);
  for (let i = 0; i < b1.voices.length; i++) {
    a.ok(b3.voices[i].midi.every((x, j) => x === b1.voices[i].midi[j]) && b3.voices[i].gain.every((x, j) => x === b1.voices[i].gain[j]), `deterministic v${i}`);
  }
  a.equal(JSON.stringify(createDefaultTempoParams()), JSON.stringify(createDefaultTempoParams()), 'defaults deterministic');
  a.equal(JSON.stringify(randomSubjectNotes(7)), JSON.stringify(randomSubjectNotes(7)), 'seeded subject deterministic');
  a.ok(JSON.stringify(randomSubjectNotes(7)) !== JSON.stringify(randomSubjectNotes(8)), 'seed changes subject');
  for (const id of PRESET_IDS) a.ok(normalizeTempoDoc(TEMPO_PRESETS[id]()).voices.length >= 2, `preset ${id}`);
}, { group: 'studio' });

registerSelfCheck('Tempo studio: bake to Glissando (≤ 64, timing, pitch, state untouched)', (a) => {
  withIsolatedState(() => {
    const before = JSON.stringify(appState.voices);
    for (const mode of ['continuous', 'steps']) {
      const doc = normalizeTempoDoc({ ...TEMPO_PRESETS.nancarrow(), quantizeBake: mode });
      const bake = getTempoBake(doc);
      const plan = getBakePlan(doc, bake);
      const voices = StudioRegistry.generateVoices(TEMPO_ID, doc);
      a.equal(JSON.stringify(appState.voices), before, 'generateVoices does not touch state');
      a.equal(voices.length, Math.min(MAX_GENERATED_VOICES, plan.total), `${mode}: one voice per loop (${voices.length})`);
      a.ok(voices.length <= MAX_GENERATED_VOICES, '≤ 64');
      voices.forEach((v, i) => {
        const { seg, bv, voice } = plan.kept[i];
        a.near(v.startTime, seg.u0, 1e-9, 'start time');
        a.near(v.duration, seg.u1 - seg.u0, 1e-9, 'duration');
        a.ok(v.engine === 'custom' && v.customPoints.length >= 2 && v.customPoints.length <= 64, `anchors ${v.customPoints.length}`);
        // pitch at hold mid-points / 음 중앙에서 음고 일치
        for (let j = 1; j < 8; j++) {
          const x = j / 8;
          const u = seg.u0 + x * (seg.u1 - seg.u0);
          if (readCurve(bv.gain, u) < 0.999) continue;
          const want = readCurve(bv.midi, u) + voicePitchOffset(voice);
          const sNear = Math.abs(rateAt(bv.track, u)) * 0.07;
          const tau = (evalS(bv.track, u) % bake.L + bake.L) % bake.L;
          const nearEdge = bake.subject.notes.some((nt) => Math.abs(tau - nt.s0) < sNear || Math.abs(tau - (nt.s0 + nt.glide * (nt.s1 - nt.s0))) < sNear);
          if (nearEdge) continue;
          a.near(getVoiceMidiAtNormT(v, x), want, 0.15, `${mode} v${i} x=${x} pitch`);
        }
      });
      if (mode === 'steps') a.ok(voices.some((v) => v.gainPoints.some((p) => p.y < 0.5)), 'steps: gain dips at attacks');
    }
    // overflow: > 64 loops → capped, earliest kept / 64개 초과 시 앞에서부터
    const big = normalizeTempoDoc({ ...TEMPO_PRESETS.stagger(), length: 120 });
    const plan = getBakePlan(big);
    a.ok(plan.over && plan.kept.length === MAX_GENERATED_VOICES, `overflow capped (${plan.total})`);
    a.equal(StudioRegistry.generateVoices(TEMPO_ID, big).length, MAX_GENERATED_VOICES);
    // Glissando voice as subject (read-only) / 글리산도 보이스를 주제로
    const src = appState.voices[0];
    const gd = normalizeTempoDoc({ ...TEMPO_PRESETS.stagger(), subject: { ...TEMPO_PRESETS.stagger().subject, source: 'glissandoVoice', voiceIndex: 0 } });
    const r = resolveSubject(gd);
    a.ok(!r.fallback && r.sub.kind === 'curve', 'glissando subject');
    a.near(r.sub.L, src.duration, 1e-9, 'L = voice duration');
    a.near(r.sub.pts[0].midi, getVoiceMidiAtNormT(src, 0), 1e-9, 'start pitch');
    a.equal(JSON.stringify(appState.voices), before, 'subject read is read-only');
    const miss = resolveSubject({ ...gd, subject: { ...gd.subject, voiceIndex: 999 } });
    a.ok(miss.fallback && miss.sub.kind === 'notes', 'missing voice → note editor');
  });
}, { group: 'studio' });

registerSelfCheck('Tempo studio: i18n tab label + help entries (EN/KO)', (a) => {
  a.ok(I18N.en['studio.tempo'] && I18N.ko['studio.tempo'], 'studio.tempo label');
  for (const k of TEMPO_I18N_KEYS) a.ok(k in I18N.ko, `ko: ${k}`);
  const miss = findMissingI18nKeys();
  a.ok(!miss.missingInKo.length && !miss.missingInEn.length, 'parity');
  for (const [k, v] of Object.entries(TEMPO_HELP)) a.ok(v.en?.title && v.ko?.title && v.en.summary && v.ko.summary, `help ${k}`);
  a.ok(Number.isFinite(evaluateCurveObjectY(createTempoCurve('expo'), 0.5)), 'tempo curve evaluates');
  a.equal(BAKE_RATE >= 200, true, 'bake rate ≥ 200 pts/s');
}, { group: 'studio' });
