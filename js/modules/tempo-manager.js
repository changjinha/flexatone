/**
 * Flexatone — modules/tempo-manager.js
 * Layer 1 (modules): Tempo Manager — pitch-preserving time scaling of studio documents.
 * The time counterpart of the Loudness Manager (modules/output-stage.js · modules/gain-bus.js).
 * 계층 1 (modules): Tempo Manager — 스튜디오 문서의 시간 재스케일 (음고 유지).
 *
 * Contract (core/tempo.js): rate r > 0, 2 = twice as fast. Every time field of a document is
 * divided by r; normalized curves (t ∈ [0, 1]) are untouched, so pitch and shape stay exactly
 * the same and only the clock moves. 문서의 모든 시간 필드를 r로 나누고, 정규화된 곡선은 그대로 둡니다.
 *
 *   Glissando  voices[].startTime / duration                → applyTempoToVoices
 *   Field      params.voices[].startTime / duration         → applyTempoToFieldParams
 *   Risset     continuous: the engine clock runs r× faster  → runtimeStepScale (dt · r)
 *
 * Because the helpers take a plain rate, the same functions serve the Manager (master ×
 * instance) and — the end goal — any single studio's own transport.
 * 순수 함수라 매니저(마스터 × 인스턴스)와 개별 스튜디오 트랜스포트 양쪽에서 그대로 쓸 수 있습니다.
 *
 * Imports: core/* only. No DOM, no audio.
 */

import { splitRates, tapeSemitones, tempoRate, combineRates, isNeutralTempo, scaleSeconds, patchTempo, normalizeTempoConfig, createDefaultTempoConfig } from '../core/tempo.js';
import { registerSelfCheck } from '../core/state.js';

/** Voices with startTime / duration divided by `rate` (new objects, input untouched). */
export function applyTempoToVoices(voices, rate) {
  const list = Array.isArray(voices) ? voices : [];
  if (Math.abs(rate - 1) < 1e-9) return list;
  // Time is rescaled inside the document, so tremolo rates (and tempo-sync BPM) speed up with it.
  // 문서 시간을 재스케일하므로 트레몰로 속도(와 템포 동기 BPM)도 함께 빨라짐.
  const scaleTrem = (tr) => {
    if (!tr || !tr.on) return tr;
    // beat unit: the rate is cycles per beat (unchanged), only the BPM moves; Hz unit: the rate moves.
    // 박 단위는 BPM만, Hz 단위는 속도를 스케일
    if (tr.rateUnit === 'beat') return { ...tr, bpm: (tr.bpm ?? 120) * rate };
    return { ...tr, rate: tr.rate * rate, rateEnd: (tr.rateEnd ?? tr.rate) * rate };
  };
  return list.map((v) => {
    const out = { ...v, startTime: scaleSeconds(v.startTime || 0, rate), duration: scaleSeconds(v.duration || 0, rate) };
    if (v.tremolo) out.tremolo = scaleTrem(v.tremolo);
    if (Array.isArray(v.regions) && v.regions.some((r) => r?.tremolo?.on)) out.regions = v.regions.map((r) => (r?.tremolo?.on ? { ...r, tremolo: scaleTrem(r.tremolo) } : r));
    return out;
  });
}

/** Field params with every particle's time scaled (baked trajectories are normalized → reused). */
export function applyTempoToFieldParams(params, rate) {
  if (!params || Math.abs(rate - 1) < 1e-9) return params;
  return { ...params, voices: applyTempoToVoices(params.voices, rate) };
}

/**
 * Seconds the Risset runtime clock advances for `dt` of real time. / 리세 런타임 시계 증가량
 */
export function runtimeStepScale(dt, rate) {
  return dt * rate;
}

export { tempoRate, combineRates, isNeutralTempo, patchTempo, normalizeTempoConfig, createDefaultTempoConfig };

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Tempo Manager: config, rate maths, document scaling', (a) => {
  const d = createDefaultTempoConfig();
  a.equal(tempoRate(d), 1, 'default is neutral');
  a.ok(isNeutralTempo(d), 'neutral');
  a.equal(tempoRate({ mode: 'bpm', bpm: 180, refBpm: 120 }), 1.5, 'BPM → ratio');
  a.equal(tempoRate({ mode: 'rate', rate: 99 }), 8, 'rate clamped to 8');
  a.equal(tempoRate({ mode: 'rate', rate: 0 }), 0.1, 'rate clamped to 0.1');
  a.equal(tempoRate({ mode: 'bogus', rate: 'x' }), 1, 'garbage → default');
  a.near(combineRates({ rate: 2 }, { mode: 'bpm', bpm: 60, refBpm: 120 }), 1, 1e-12, 'master × instance multiply');
  // switching mode keeps the value / 모드 전환 시 값 유지
  const p = patchTempo({ mode: 'rate', rate: 1.5, refBpm: 100 }, { mode: 'bpm' });
  a.near(tempoRate(p), 1.5, 1e-9, 'mode switch keeps the rate');
  const q = patchTempo(p, { rate: 0.5 });
  a.near(q.bpm, 50, 1e-9, 'rate edit keeps bpm in step');
  // Glissando voices / 글리산도 보이스
  const voices = [{ id: 'a', startTime: 1, duration: 4, f0Midi: 48 }, { id: 'b', startTime: 0, duration: 2, f0Midi: 60 }];
  const fast = applyTempoToVoices(voices, 2);
  a.equal(fast[0].startTime, 0.5, 'start / 2');
  a.equal(fast[0].duration, 2, 'duration / 2');
  a.equal(fast[0].f0Midi, 48, 'pitch untouched');
  a.equal(voices[0].duration, 4, 'input not mutated');
  a.ok(applyTempoToVoices(voices, 1) === voices, 'rate 1 returns the same array');
  const end = (vs) => vs.reduce((m, v) => Math.max(m, v.startTime + v.duration), 0);
  a.near(end(applyTempoToVoices(voices, 0.5)), end(voices) * 2, 1e-9, 'half speed doubles the length');
  // Field params / 필드 파라미터
  const fp = applyTempoToFieldParams({ x: 1, voices: [{ startTime: 0.7, duration: 3.2 }] }, 4);
  a.near(fp.voices[0].duration, 0.8, 1e-12, 'field duration / 4');
  a.equal(fp.x, 1, 'other params kept');
  a.near(runtimeStepScale(0.025, 3), 0.075, 1e-12, 'risset clock × rate');
  // Tape mode / 테이프 모드
  const sp = splitRates({ rate: 0.5, tape: true, glideSec: 2 }, { rate: 2 });
  a.near(sp.rate, 1, 1e-12, 'total rate');
  a.near(sp.tape, 0.5, 1e-12, 'only the tape level moves pitch');
  a.near(sp.doc, 2, 1e-12, 'rest is rendered into the document');
  a.equal(sp.glide, 2, 'glide of the tape level');
  a.near(tapeSemitones(0.5), -12, 1e-9, '0.5× tape = −1 octave');
  a.near(tapeSemitones(2), 12, 1e-9, '2× tape = +1 octave');
  a.equal(splitRates({ rate: 3 }).tape, 1, 'no tape → pitch kept');
  a.equal(patchTempo({ rate: 1.5 }, { tape: true }).tape, true, 'patch sets tape');
  a.equal(normalizeTempoConfig({ tape: 'yes' }).tape, false, 'tape must be boolean true');
}, { group: 'studio' });
