/**
 * Flexatone — audio/audio-engine.js
 * Layer 3 (audio): Web Audio playback, Reaper-style transport, live scrub and
 * offline 48 kHz / 16-bit PCM WAV export.
 * 계층 3 (audio): Web Audio 재생, Reaper식 트랜스포트, 실시간 스크럽, 오프라인 WAV 내보내기.
 * Term: the Glissando "Audio Engine" (sound output). Not the Curve Engine (modules/curve-engine.js) and not a
 * Studio Engine (studios/<id>/<id>-engine.js). / 용어: 글리산도의 "오디오 엔진"(소리 출력).
 *
 * Graph per playback pass / 재생 그래프
 *   Oscillator(PeriodicWave, frequency curve) — or, for a Sampler voice, its sound-file region at
 *   playbackRate = frequency / root (audio/sample-voice.js) / 샘플러 보이스는 사운드 파일 구간
 *     → envGain   (voice amplitude curve: baseGain × envelope in gainUnit)
 *     → fadeGain  (5 ms click-guard ramps at the voice's own start/end)
 *     → busGain   (master-bus curve: compensation × master × peak safety)
 *     → outGain   (transport fade in/out on play/stop/pause)
 *     → destination
 * The same `scheduleGraph()` drives the live AudioContext and the OfflineAudioContext, so the
 * exported WAV matches what you hear. / 실시간·오프라인이 같은 스케줄러를 공유.
 *
 * Transport state lives in appState.transport { playing, loop, cueSec, playheadSec } and is
 * updated through core `setTransport()` (scope 'transport').
 * Imports: core/*, modules/*. May use browser audio APIs; DOM only for the file download.
 */

import { clamp } from '../core/math-utils.js';
import { adsrGainAt, adsrKey } from '../core/adsr.js';
import { t } from '../core/i18n.js';
import { appState, setTransport, getActiveVoice, getVoiceEnd, createDefaultVoice, registerSelfCheck } from '../core/state.js';
import { getEngineDef, getVoiceFreqAtNormT, computeDerivativeStats } from '../modules/curve-engine.js';
import { getTimbreCoefficientsCached, toPeriodicWaveArgs } from '../modules/timbre-synth.js';
import { createVoiceTremoloEvaluator, tremoloCurveRate } from '../modules/tremolo.js';
import {
  filterAudibleVoices,
  evaluateVoiceAmplitudeAtNormT,
  evaluateMasterBusGain,
  buildMasterGainCurve,
  precomputeGainRanges,
  createDefaultBusConfig,
} from '../modules/gain-bus.js';
import { attachOutputBus, getOutputBus, createOfflineOutput } from './output-bus.js';
import { voiceSampleSpec, sampleSpecKey, sampleTapeSpeed, integrateReadSec } from '../modules/sample-source.js';
import { createVoiceModEvaluator, voiceModFreqCurve, voiceModGainCurve, voiceModIndex } from '../core/voice-mod.js';
import { createToneSource, skipSampleRead } from './sample-voice.js';
import { addSample, removeSample } from '../core/sample-library.js';

// ==========================================================================
// Constants / 상수
// ==========================================================================

export const EXPORT_SAMPLE_RATE = 48000;
export const EXPORT_BIT_DEPTH = 16;
/** Automation curve density (points per second) and hard cap per curve. / 자동화 곡선 해상도 */
export const CURVE_RATE = 500;
export const MAX_CURVE_POINTS = 65536;
/** Per-voice click guard and transport fade (seconds). / 클릭 방지 페이드 */
export const VOICE_FADE_SEC = 0.005;
export const TRANSPORT_FADE_SEC = 0.012;
/** Scrub smoothing time constants (seconds). / 스크럽 스무딩 */
const SCRUB_FREQ_TC = 0.008;
const SCRUB_GAIN_TC = 0.012;
/** Scheduling lead so the first automation point is never in the past. / 스케줄 선행 시간 */
const START_LEAD_SEC = 0.03;

let busConfig = createDefaultBusConfig();

/** Current master-bus configuration (see modules/gain-bus.js BusConfig). */
export function getBusConfig() {
  return { ...busConfig };
}

// ==========================================================================
// 1. AudioContext & PeriodicWave / 오디오 컨텍스트와 PeriodicWave
// ==========================================================================

let audioCtx = null;
let outGain = null; // transport fade stage, connected to destination

/**
 * Create (once) and resume the shared AudioContext. Must be called from a user gesture the
 * first time (browser autoplay policy). / 공유 AudioContext 생성·재개 (첫 호출은 사용자 제스처에서)
 * @returns {Promise<AudioContext>}
 */
export async function ensureAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not available in this browser');
    audioCtx = new Ctor({ latencyHint: 'interactive' });
    outGain = audioCtx.createGain();
    outGain.gain.value = 0;
    outGain.connect(attachOutputBus(audioCtx)); // → output stage (fader + loudness tap) / 출력 단계
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return audioCtx;
}

/** The shared context, or null before the first ensureAudioCtx(). */
export function getAudioCtx() {
  return audioCtx;
}

const waveCache = new WeakMap(); // ctx → WeakMap(coeffs → PeriodicWave)

/**
 * PeriodicWave for a voice's timbre (5-wave mix or ƒ(x)), cached per context.
 * 보이스 음색의 PeriodicWave (컨텍스트별 캐시).
 * @param {BaseAudioContext} ctx
 * @param {object} voice
 * @param {{ voices?: object[] }} [opts] all voices (needed for ƒ(x) voice-curve sources)
 */
export function createVoicePeriodicWave(ctx, voice, { voices = appState.voices } = {}) {
  const coeffs = getTimbreCoefficientsCached(voice, { voices });
  let perCtx = waveCache.get(ctx);
  if (!perCtx) {
    perCtx = new WeakMap();
    waveCache.set(ctx, perCtx);
  }
  // Error results are re-wrapped on every read, so key on the stable real array.
  // 오류 결과는 매번 새 객체이므로 안정적인 real 배열을 키로 사용.
  const key = coeffs.real;
  let wave = perCtx.get(key);
  if (!wave) {
    wave = ctx.createPeriodicWave(...toPeriodicWaveArgs(coeffs));
    perCtx.set(key, wave);
  }
  return wave;
}

// ==========================================================================
// 2. Shared scheduler (live + offline) / 공용 스케줄러
// ==========================================================================

const curvePoints = (span) => clamp(Math.ceil(span * CURVE_RATE) + 1, 16, MAX_CURVE_POINTS);

/** Audible voices and the end of the audible timeline. / 발음 보이스와 타임라인 끝 */
export function getPlayableTimeline(voices = appState.voices) {
  const audible = filterAudibleVoices(voices).filter((v) => v.duration > 0.002);
  const endSec = audible.reduce((m, v) => Math.max(m, getVoiceEnd(v)), 0);
  return { audible, endSec };
}

/**
 * Schedule every audible voice segment inside [fromSec, toSec) onto `ctx`, starting at
 * context time `when`. Returns the created nodes so the caller can stop them.
 * [fromSec, toSec) 구간의 보이스를 ctx의 when 시각부터 스케줄.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {{ voices?: object[], fromSec: number, toSec: number, when: number, bus?: object }} opts
 * @returns {{ oscillators: OscillatorNode[], nodes: AudioNode[], voiceCount: number }}
 */
/**
 * Manager Warp brightness: a high-shelf above the 2nd harmonic that follows the pitch curve.
 * freq = the oscillator's frequency curve, secAt(k) = document second of sample k,
 * brightWarp(sec, hz) → shelf gain in dB (±24). Neutral (0 dB) where the warp does not reach.
 * 매니저 곡률 밝기: 음고 곡선을 따라가는 2배음 위 하이셸프.
 */
export function createBrightShelf(ctx, freq, secAt, brightWarp, at, dur) {
  const n = freq.length;
  const fc = new Float32Array(n);
  const gd = new Float32Array(n);
  const ny = 0.45 * ctx.sampleRate;
  for (let k = 0; k < n; k++) {
    fc[k] = clamp(2 * freq[k], 40, ny);
    gd[k] = clamp(Number(brightWarp(secAt(k), freq[k])) || 0, -24, 24);
  }
  const f = ctx.createBiquadFilter();
  f.type = 'highshelf';
  f.frequency.setValueCurveAtTime(fc, at, dur);
  f.gain.setValueCurveAtTime(gd, at, dur);
  return f;
}

export function scheduleGraph(ctx, destination, opts) {
  const { voices = appState.voices, fromSec, toSec, when, bus = busConfig } = opts;
  const { audible } = getPlayableTimeline(voices);
  const span = toSec - fromSec;
  const nodes = [];
  const oscillators = [];
  if (span <= 0.002 || !audible.length) return { oscillators, nodes, voiceCount: 0 };

  const busGain = ctx.createGain();
  const busCurve = buildMasterGainCurve(audible, fromSec, toSec, bus, { points: curvePoints(span) });
  // No other event may share a curve's start time (Chrome throws) / 곡선 시작과 같은 시각의 이벤트 금지
  busGain.gain.setValueCurveAtTime(busCurve, when, span);
  busGain.connect(destination);
  nodes.push(busGain);

  const ranges = precomputeGainRanges(audible);
  const chains = buildLegatoChains(audible, { enabled: opts.legato ?? appState.legatoJoin !== false, sampleJoin: opts.sampleJoin ?? appState.sampleJoin });
  const vmCfg = opts.voiceMod !== undefined ? opts.voiceMod : appState.studioParams?.glissando?.voiceMod; // per-voice mod / 보이스별 변조
  const glideSec = Math.max(0, Number(opts.glideMs ?? appState.joinGlideMs) || 0) / 1000;
  let voiceCount = 0;
  for (const chain of chains) {
    const cStart = chain[0].startTime;
    const cEnd = getVoiceEnd(chain[chain.length - 1]);
    const segStart = Math.max(cStart, fromSec);
    const segEnd = Math.min(cEnd, toSec);
    const segSpan = segEnd - segStart;
    if (segSpan < 0.002) continue;

    const at = when + (segStart - fromSec);
    // Tremolo cycles need a denser curve than the pitch / envelope alone / 트레몰로는 더 촘촘한 곡선 필요
    const n = Math.max(curvePoints(segSpan), clamp(Math.ceil(segSpan * tremoloCurveRate(chain)) + 1, 16, MAX_CURVE_POINTS));
    const curves = sampleChainCurves(chain, segStart, segSpan, n, { ranges, glideSec, ctx, voices });
    // Optional pitch warp (Manager Warp tracks): freq ← warp(sec, freq) / 선택적 곡률 (매니저 곡률 트랙)
    if (typeof opts.pitchWarp === 'function') {
      for (let k = 0; k < n; k++) curves.freq[k] = opts.pitchWarp(segStart + (segSpan * k) / Math.max(1, n - 1), curves.freq[k]);
    }
    // Optional pitch/time mask (Manager shape regions): gain × mask(sec, hz) / 선택적 음고 마스크
    if (typeof opts.ampMask === 'function') {
      for (let k = 0; k < n; k++) {
        const m = opts.ampMask(segStart + (segSpan * k) / Math.max(1, n - 1), curves.freq[k]);
        if (m === 1) continue; // warps may also boost (level) / 곡률은 키울 수도 있음
        for (const g of curves.groups) g.amp[k] *= m;
      }
    }

    // Every oscillator of a chain starts at the same instant with the same frequency curve,
    // so they stay phase-locked; only their timbre (PeriodicWave) differs.
    // 체인의 모든 오실레이터는 같은 시각·같은 주파수 곡선으로 시작 → 위상 고정.
    const fade = Math.min(VOICE_FADE_SEC, segSpan / 3);
    const fadeGain = ctx.createGain();
    fadeGain.gain.setValueAtTime(0, at);
    fadeGain.gain.linearRampToValueAtTime(1, at + fade);
    fadeGain.gain.setValueAtTime(1, at + segSpan - fade);
    fadeGain.gain.linearRampToValueAtTime(0, at + segSpan);
    if (typeof opts.brightWarp === 'function') {
      // Manager Warp brightness / 매니저 곡률 밝기
      const shelf = createBrightShelf(ctx, curves.freq, (k) => segStart + (segSpan * k) / Math.max(1, n - 1), opts.brightWarp, at, segSpan);
      fadeGain.connect(shelf).connect(busGain);
      nodes.push(shelf);
    } else fadeGain.connect(busGain);
    nodes.push(fadeGain);

    // A Sampler chain = voices of one sample spec (see buildLegatoChains): one source reads on through them
    // 샘플러 체인 = 같은 샘플 스펙의 보이스들: 소스 하나가 이어서 읽음
    const sample = voiceSampleSpec(chain[0]);
    // Per-voice tremolo / vibrato (core/voice-mod.js; Glissando document param voiceMod), per chain, on voice time
    // 보이스별 트레몰로·비브라토 (체인 단위, 보이스 시간 기준)
    const vm = createVoiceModEvaluator(vmCfg, voiceModIndex(chain[0].id), Number(chain[0].f0Midi) || 60);
    const vmT = segStart - chain[0].startTime;
    const freqC = voiceModFreqCurve(vm, curves.freq, vmT, segSpan);
    const hzAt = sample ? chainHzAt(chain) : null;
    for (const { wave, amp, first, readStart } of curves.groups) {
      // Sampler: one source per read (a continued run of voices); a restarted read starts at its
      // first voice, just before the join so the equal-gain crossfade has sound on both sides
      // 샘플러: 읽기(이어 읽는 보이스 묶음)마다 소스 하나. 새로 시작하는 읽기는 첫 보이스에서 (교차 페이드 직전부터)
      const gs = sample ? voiceSampleSpec(chain[first]) : null;
      const osc = createToneSource(ctx, { sample: gs, wave });
      let startAt = at;
      if (gs) {
        if (readStart > segStart) startAt = at + (readStart - segStart);
        // Started inside the read: skip what playback has already read / 읽기 중간 시작: 이미 읽은 만큼 건너뜀
        else skipSampleRead(osc, hzAt, readStart, segStart);
      }
      osc.frequency.setValueCurveAtTime(freqC, at, segSpan);
      const envGain = ctx.createGain();
      envGain.gain.setValueCurveAtTime(voiceModGainCurve(vm, amp, vmT, segSpan), at, segSpan);
      osc.connect(envGain).connect(fadeGain);
      osc.start(startAt);
      osc.stop(at + segSpan + 0.001);
      oscillators.push(osc);
      nodes.push(envGain);
    }
    voiceCount += chain.length;
  }
  return { oscillators, nodes, voiceCount, chainCount: chains.length };
}

// ==========================================================================
// 2b. Legato chains — phase-continuous joins / 레가토 체인 — 위상 연속 연결
// ==========================================================================

/** Max gap/overlap (s) between one voice's end and the next one's start to count as a join. */
export const JOIN_TOL_SEC = 0.002;
/** Equal-gain crossfade length (s) between phase-locked voices at a join. */
export const JOIN_XFADE_SEC = 0.006;

const smoother = (x) => {
  const s = clamp(x, 0, 1);
  return s * s * s * (s * (6 * s - 15) + 10);
};

/** Sampler joins: 'restart' = every voice plays its file anew; 'pitch' = continue when the next voice
 *  starts at the pitch the previous one ends on; 'always' = continue at any pitch.
 *  샘플러 잇기: 'restart' 매번 새로 / 'pitch' 끝 음고가 이어질 때만 계속 / 'always' 음고와 무관하게 계속 */
export const SAMPLE_JOIN_MODES = Object.freeze(['restart', 'pitch', 'always']);
/** Max pitch gap (semitones) between one voice's end and the next one's start for 'pitch'. */
export const SAMPLE_JOIN_PITCH_TOL_ST = 0.3;

const endHz = (v, tn) => getVoiceFreqAtNormT(v, tn, { stats: v.audioTarget === 'vel' ? computeDerivativeStats(v) : undefined });

/** Heard frequency of a chain at a document second (the voice that owns it). / 체인의 시각별 주파수 */
export function chainHzAt(chain) {
  const stats = chain.map((v) => (v.audioTarget === 'vel' ? computeDerivativeStats(v) : undefined));
  return (sec) => {
    let k = 0;
    while (k < chain.length - 1 && sec >= chain[k + 1].startTime) k++;
    const v = chain[k];
    return getVoiceFreqAtNormT(v, clamp((sec - v.startTime) / Math.max(1e-9, v.duration), 0, 1), { stats: stats[k] });
  };
}

/** Seconds of the region's own fade-in at its start (envelope fade-in, else the one-shot declick). */
function sampleHeadFadeSec(spec) {
  if (spec.envOn && spec.fadeInMs > 0) return spec.fadeInMs / 1000;
  return spec.loop === 'loop' ? 0 : spec.xfadeMs / 1000;
}

/**
 * How each join of a chain is crossfaded: { xf, fresh, own } per join (half-width xf in seconds).
 *  - same read / synth: equal-gain smootherstep over ±JOIN_XFADE_SEC/2 (phase-locked, no dip);
 *  - fresh read (a Sampler voice that starts its file anew): the new source starts at join − xf and
 *    the old one fades out with an equal-power cosine. When the region has its own fade-in (`own`),
 *    xf spans that fade at the voice's play rate and the new source is not ramped twice.
 * 체인의 각 접합부 교차 페이드: 같은 읽기·신스 = 등이득, 새 읽기 = 등전력 (구간 자체 페이드인이 있으면 그 길이에 맞춤).
 */
export function chainJoinFades(chain) {
  const out = [];
  for (let j = 0; j + 1 < chain.length; j++) {
    const b = chain[j + 1];
    const fresh = !!chain.reads && chain.reads[j + 1] !== chain.reads[j];
    let xf = 0.5 * JOIN_XFADE_SEC;
    let own = false;
    const sp = fresh ? voiceSampleSpec(b) : null;
    const head = sp ? sampleHeadFadeSec(sp) : 0;
    if (head > 0) {
      const hz = endHz(b, 0);
      const rootHz = 440 * Math.pow(2, (sp.root - 69) / 12);
      const rate = sp.play === 'pitch' ? sp.speed : (sampleTapeSpeed(sp) * hz) / rootHz;
      const cap = 0.25 * Math.min(chain[j].duration, b.duration);
      xf = Math.min(cap, Math.max(0.5 * JOIN_XFADE_SEC, (0.5 * head) / Math.max(0.05, rate)));
      own = true;
    }
    out.push({ xf, fresh, own });
  }
  return out;
}

/** Document second a chain's read k starts (its first voice, minus the crossfade). / 읽기 시작 시각 */
function readStartOf(chain, first, fades) {
  return first > 0 ? chain[first].startTime - (fades[first - 1].fresh ? fades[first - 1].xf : 0) : chain[0].startTime;
}

/**
 * Where a Sampler voice's source is reading at a document second, as region seconds (before the
 * loop wrap), following the same chains and reads as playback; null when the voice is not a
 * Sampler voice, not audible or not sounding at `sec`. For the playhead on the Sampler monitor.
 * 샘플러 보이스의 소스가 sec에서 읽는 위치 (구간 초, 루프 감기 전). 재생과 같은 체인·읽기를 따름.
 */
let readPosCache = null;
export function sampleReadSecAt(voiceId, sec) {
  const voices = appState.voices;
  const legato = appState.legatoJoin !== false;
  const sj = appState.sampleJoin;
  if (!readPosCache || readPosCache.voices !== voices || readPosCache.legato !== legato || readPosCache.sj !== sj) {
    const { audible } = getPlayableTimeline(voices);
    readPosCache = { voices, legato, sj, chains: buildLegatoChains(audible, { enabled: legato, sampleJoin: sj }), hz: new Map() };
  }
  for (const chain of readPosCache.chains) {
    const k = chain.findIndex((v) => v.id === voiceId);
    if (k < 0) continue;
    const v = chain[k];
    const spec = voiceSampleSpec(v);
    if (!spec || sec < v.startTime || sec > getVoiceEnd(v)) return null;
    let first = k;
    while (first > 0 && chain.reads[first - 1] === chain.reads[k]) first--;
    const readStart = readStartOf(chain, first, chainJoinFades(chain));
    if (spec.play === 'pitch') return spec.speed * Math.max(0, sec - readStart);
    let hz = readPosCache.hz.get(chain);
    if (!hz) { hz = chainHzAt(chain); readPosCache.hz.set(chain, hz); }
    return sampleTapeSpeed(spec) * integrateReadSec(hz, readStart, sec, spec.root);
  }
  return null;
}

/**
 * Group audible voices into legato chains: voice B follows A when B starts where A ends
 * (±JOIN_TOL_SEC). Synth voices join when `enabled` (Legato Join). Sampler voices join only other
 * Sampler voices with the same sample settings, by `sampleJoin` (independent of Legato Join):
 * 'pitch' continues when B starts within SAMPLE_JOIN_PITCH_TOL_ST of A's end pitch, 'always' at any
 * pitch. A continued run is played by one source (the file reads on). Sampler voices that do not
 * continue (restart, other file or settings, pitch apart) still join the chain when Legato Join is on,
 * as a new read: a new source starts at B, crossfaded with the equal-gain join instead of two fades.
 * `chain.reads[k]` = the read index of voice k (same index = one source).
 * 레가토 연결이 켜져 있으면 이어 읽지 않는 샘플러 보이스도 체인에 들어가 새 읽기로 시작 (두 번의 페이드 대신 교차 페이드).
 * 레가토 체인 구성: B가 A의 끝에서 시작하면 연결. 신스 보이스는 레가토 연결이 켜져 있을 때, 샘플러 보이스는
 * 같은 샘플 설정의 샘플러 보이스끼리 sampleJoin에 따라 연결 (소스 하나가 이어서 읽음).
 * @returns {object[][]}
 */
export function buildLegatoChains(voices, { enabled = true, sampleJoin = 'restart' } = {}) {
  const sorted = [...voices].sort((a, b) => a.startTime - b.startTime);
  const sj = SAMPLE_JOIN_MODES.includes(sampleJoin) ? sampleJoin : 'restart';
  const keyOf = new Map(sorted.map((v) => { const sp = voiceSampleSpec(v); return [v.id, sp ? sampleSpecKey(sp) : null]; }));
  // 'continue' = same read (one source), 'new' = joined as a new read, false = not joined
  // 'continue' = 같은 읽기, 'new' = 새 읽기로 연결, false = 연결 안 함
  const canContinue = (a, b) => {
    const ka = keyOf.get(a.id);
    if (ka !== keyOf.get(b.id) || sj === 'restart') return false;
    if (sj === 'always') return true;
    const fa = endHz(a, 1);
    const fb = endHz(b, 0);
    return fa > 0 && fb > 0 && Math.abs(12 * Math.log2(fb / fa)) <= SAMPLE_JOIN_PITCH_TOL_ST;
  };
  const canJoin = (a, b) => {
    const ka = keyOf.get(a.id);
    const kb = keyOf.get(b.id);
    if (ka === null && kb === null) return enabled ? 'continue' : false;
    if (ka === null || kb === null) return false;
    if (canContinue(a, b)) return 'continue';
    return enabled ? 'new' : false;
  };
  const used = new Set();
  const chains = [];
  for (const v of sorted) {
    if (used.has(v.id)) continue;
    const chain = [v];
    chain.reads = [0];
    used.add(v.id);
    for (;;) {
      const last = chain[chain.length - 1];
      const end = getVoiceEnd(last);
      let how = false;
      const next = sorted.find((w) => !used.has(w.id) && Math.abs(w.startTime - end) <= JOIN_TOL_SEC && (how = canJoin(last, w)));
      if (!next) break;
      chain.reads.push(how === 'continue' ? chain.reads[chain.reads.length - 1] : chain.reads[chain.reads.length - 1] + 1);
      chain.push(next);
      used.add(next.id);
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * Sample one chain into a shared frequency curve and one amplitude curve per timbre.
 *  - Frequency: the owning voice's curve; within ±glide of a join the two voices' log-frequencies
 *    are smootherstep-blended (removes the slope kink; a pitch step becomes a short glide).
 *  - Amplitude: voices meet with an equal-gain smootherstep crossfade (weights sum to 1). Because
 *    the oscillators are phase-locked this crossfade has no dip and no phase jump.
 * 체인 샘플링: 공유 주파수 곡선 + 음색별 진폭 곡선.
 */
export function sampleChainCurves(chain, segStart, segSpan, n, { ranges, glideSec = 0, ctx = null, voices = appState.voices } = {}) {
  const joins = chain.slice(1).map((v) => v.startTime);
  const stats = chain.map((v) => (v.audioTarget === 'vel' ? computeDerivativeStats(v) : undefined));
  const tnOf = (v, sec) => (sec - v.startTime) / Math.max(1e-9, v.duration);
  const freqOf = (k, sec) => getVoiceFreqAtNormT(chain[k], clamp(tnOf(chain[k], sec), 0, 1), { stats: stats[k] });
  const glides = joins.map((_, j) => Math.min(glideSec, 0.25 * chain[j].duration, 0.25 * chain[j + 1].duration));
  const xf = 0.5 * JOIN_XFADE_SEC;
  const fades = chainJoinFades(chain);
  const ramp = (sec, j) => clamp((sec - (joins[j] - fades[j].xf)) / (2 * fades[j].xf), 0, 1);
  const weightIn = (sec, k) => {
    if (k === 0) return 1;
    const f = fades[k - 1];
    if (!f.fresh) return smoother((sec - (joins[k - 1] - xf)) / (2 * xf));
    return f.own ? 1 : Math.sin(0.5 * Math.PI * ramp(sec, k - 1)); // own fade-in = the file's / 파일 자체의 페이드인
  };
  const weightOut = (sec, k) => {
    if (k === chain.length - 1) return 1;
    const f = fades[k];
    if (!f.fresh) return 1 - smoother((sec - (joins[k] - xf)) / (2 * xf));
    return Math.cos(0.5 * Math.PI * ramp(sec, k));
  };
  // Per-voice tremolo (null when off). Applied to the voice's own amplitude before the join
  // crossfade, so it never touches the master-bus compensation. / 보이스별 트레몰로 (꺼짐 = null)
  const trem = chain.map((v) => createVoiceTremoloEvaluator(v));
  // Timbre ADSR (core/adsr.js): joined voices with the same envelope share one run, unless a
  // voice has ↻ Restart on → a new run (attack) starts there. / 이어진 보이스는 같은 ADSR이면 하나의
  // 엔벨로프, ↻ 새로 시작이면 그 보이스에서 다시 어택.
  const envRun = adsrRunsOf(chain);

  const groupOf = [];
  const groups = [];
  const byWave = new Map();
  chain.forEach((v, k) => {
    // Sampler: one group (= one source) per read of the chain / 샘플러: 체인의 읽기마다 그룹(소스) 하나
    const sp = voiceSampleSpec(v);
    const key = sp ? `sample:${chain.reads ? chain.reads[k] : 0}:${sampleSpecKey(sp)}` : ctx ? createVoicePeriodicWave(ctx, v, { voices }) : `w${k}`;
    if (!byWave.has(key)) {
      byWave.set(key, groups.length);
      groups.push({ wave: key, amp: new Float32Array(n), first: k });
    }
    groupOf[k] = byWave.get(key);
  });

  const freq = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const sec = segStart + (segSpan * i) / Math.max(1, n - 1);
    let owner = 0;
    while (owner < joins.length && sec >= joins[owner]) owner++;
    let f = freqOf(owner, sec);
    for (let j = 0; j < joins.length; j++) {
      const g = glides[j];
      if (g > 0 && Math.abs(sec - joins[j]) < g) {
        const s = smoother((sec - (joins[j] - g)) / (2 * g));
        f = Math.exp((1 - s) * Math.log(freqOf(j, sec)) + s * Math.log(freqOf(j + 1, sec)));
      }
    }
    freq[i] = f;

    for (let k = 0; k < chain.length; k++) {
      const w = weightIn(sec, k) * weightOut(sec, k);
      if (w <= 0) continue;
      const v = chain[k];
      const tg = trem[k] ? trem[k].gainAtSec(sec) : 1;
      const run = envRun[k];
      const eg = run ? adsrGainAt(run.adsr, sec - run.start, run.end - run.start) : 1;
      groups[groupOf[k]].amp[i] += w * tg * eg * evaluateVoiceAmplitudeAtNormT(v, clamp(tnOf(v, sec), 0, 1), { range: ranges?.get(v.id) });
    }
  }
  for (const g of groups) g.readStart = readStartOf(chain, g.first, fades);
  return { freq, groups };
}

/**
 * ADSR runs of a chain: run k = { adsr, start, end } for each voice (null when its ADSR is off).
 * A new run starts at the first voice, at a voice with ↻ Restart (retrig), and where the envelope
 * settings change. / 체인의 ADSR 구간: 첫 보이스, ↻ 새로 시작, 설정이 바뀌는 곳에서 새 구간.
 */
export function adsrRunsOf(chain) {
  const out = new Array(chain.length).fill(null);
  let k = 0;
  while (k < chain.length) {
    const head = chain[k];
    const key = adsrKey(head.adsr);
    let j = k;
    while (j + 1 < chain.length && !chain[j + 1].adsr?.retrig && adsrKey(chain[j + 1].adsr) === key) j++;
    if (key !== 'off') {
      const run = { adsr: head.adsr, start: head.startTime, end: getVoiceEnd(chain[j]) };
      for (let q = k; q <= j; q++) out[q] = run;
    }
    k = j + 1;
  }
  return out;
}

function teardown(pass, stopAt) {
  if (!pass) return;
  for (const osc of pass.oscillators) {
    try {
      osc.stop(stopAt);
    } catch {
      /* already stopped / 이미 정지됨 */
    }
  }
  const nodes = [...pass.oscillators, ...pass.nodes];
  const delayMs = Math.max(0, (stopAt - (audioCtx?.currentTime ?? 0)) * 1000) + 50;
  setTimeout(() => nodes.forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } }), delayMs);
}

// ==========================================================================
// 3. Transport: play / stop / pause / loop / 트랜스포트
// ==========================================================================

let pass = null; // { oscillators, nodes, voiceCount, ctxStart, fromSec, endSec, token }
let passToken = 0;
let rafId = null;
let endTimer = null;
const playheadListeners = new Set();

const raf = (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : setTimeout(() => fn(), 16));
const cancelRaf = (id) => (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame(id) : clearTimeout(id));

export function isPlaying() {
  return !!pass;
}

export function isLooping() {
  return !!appState.transport.loop;
}

export function setLooping(on) {
  setTransport({ loop: !!on });
  return isLooping();
}

/** Toggle loop (Loop button / L key). / 반복 토글 */
export function toggleLooping() {
  return setLooping(!isLooping());
}

/** Current playhead in seconds (live while playing, else −1 or the last pause point). */
export function getPlayheadSec() {
  if (pass && audioCtx) return pass.fromSec + Math.max(0, audioCtx.currentTime - pass.ctxStart);
  return appState.transport.playheadSec;
}

/**
 * Low-overhead per-frame playhead callback (in addition to state 'transport' events).
 * 프레임 단위 플레이헤드 콜백. @returns unsubscribe
 */
export function onPlayheadTick(fn) {
  playheadListeners.add(fn);
  return () => playheadListeners.delete(fn);
}

function clearTimers() {
  if (rafId !== null) cancelRaf(rafId);
  rafId = null;
  if (endTimer !== null) clearTimeout(endTimer);
  endTimer = null;
}

function tick(token) {
  if (!pass || pass.token !== token) return;
  const sec = getPlayheadSec();
  if (sec >= pass.endSec) {
    handleReachedEnd(token);
    return;
  }
  setTransport({ playheadSec: sec });
  for (const fn of [...playheadListeners]) {
    try { fn(sec); } catch (err) { console.error('[Flexatone] playhead listener error:', err); }
  }
  rafId = raf(() => tick(token));
}

function handleReachedEnd(token) {
  if (!pass || pass.token !== token) return;
  if (isLooping()) {
    startPass(appState.transport.cueSec, { fadeIn: false }); // restart at the cue / 시작점부터 다시
  } else {
    stopAudio();
  }
}

function startPass(fromSec, { fadeIn = true } = {}) {
  const ctx = audioCtx;
  const { endSec } = getPlayableTimeline();
  const prev = pass;
  const now = ctx.currentTime;
  const when = now + START_LEAD_SEC;
  if (prev) teardown(prev, when); // loop restart: old pass ends exactly where the new one begins
  clearTimers();

  const token = ++passToken;
  const graph = scheduleGraph(ctx, outGain, { fromSec, toSec: endSec, when });
  pass = { ...graph, ctxStart: when, fromSec, endSec, token };

  const g = outGain.gain;
  g.cancelScheduledValues(now);
  if (fadeIn) {
    g.setValueAtTime(0, now);
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(1, when + TRANSPORT_FADE_SEC);
  } else {
    g.setValueAtTime(1, now);
  }

  setTransport({ playing: true, playheadSec: fromSec });
  // rAF pauses in background tabs; the timer guarantees end/loop handling.
  // 백그라운드 탭에서는 rAF가 멈추므로 타이머로 종료/반복 보장.
  endTimer = setTimeout(() => handleReachedEnd(token), (endSec - fromSec + START_LEAD_SEC) * 1000 + 20);
  rafId = raf(() => tick(token));
  return pass;
}

/**
 * Start playback from transport.cueSec (Solo/Mute honoured). A cue at/after the end
 * rewinds to 0. Resolves false when nothing is audible.
 * cueSec부터 재생 (솔로/뮤트 반영). 시작점이 끝 이후면 0부터. 발음할 보이스가 없으면 false.
 * @returns {Promise<boolean>}
 */
export async function startAudio() {
  await ensureAudioCtx();
  const { audible, endSec } = getPlayableTimeline();
  if (!audible.length || endSec <= 0) return false;
  let cue = clamp(Number(appState.transport.cueSec) || 0, 0, endSec);
  if (cue >= endSec - 0.01) {
    cue = 0;
    setTransport({ cueSec: 0 });
  }
  startPass(cue);
  return true;
}

function fadeOutAndRelease() {
  if (!pass || !audioCtx) return;
  const now = audioCtx.currentTime;
  const g = outGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + TRANSPORT_FADE_SEC);
  teardown(pass, now + TRANSPORT_FADE_SEC + 0.005);
  pass = null;
  clearTimers();
}

/**
 * Stop and return to the cue (Reaper "Stop"). The cue itself is not changed.
 * 정지 후 시작점으로 복귀 (시작점은 유지).
 */
export function stopAudio() {
  fadeOutAndRelease();
  setTransport({ playing: false, playheadSec: -1 });
}

/**
 * Pause: stop at the current playhead and move the cue there, so the next play resumes
 * from the same spot (Reaper "Pause"). Returns the pause position, or null if not playing.
 * 일시정지: 현재 위치에서 멈추고 시작점을 그 위치로 고정 → 다음 재생은 이어서.
 */
export function pauseAtPlayhead() {
  if (!pass) return null;
  const sec = clamp(getPlayheadSec(), 0, pass.endSec);
  fadeOutAndRelease();
  setTransport({ playing: false, cueSec: sec, playheadSec: sec });
  return sec;
}

/** Play ⇄ Stop (return to cue). / 재생 ⇄ 정지 */
export async function togglePlay() {
  if (isPlaying()) {
    stopAudio();
    return false;
  }
  return startAudio();
}

/** Play ⇄ Pause (resume where stopped). / 재생 ⇄ 일시정지 */
export async function togglePause() {
  if (isPlaying()) {
    pauseAtPlayhead();
    return false;
  }
  return startAudio();
}

/** Move the cue (start offset). Restarts playback from there if playing. / 시작점 이동 */
export function setCueSec(sec) {
  const cue = Math.max(0, Number(sec) || 0);
  setTransport({ cueSec: cue });
  if (pass && audioCtx) startPass(cue, { fadeIn: false });
  return cue;
}

/** Cue reset button (⏮): cue → 0. / 시작점 0으로 */
export function resetCue() {
  return setCueSec(0);
}

// ==========================================================================
// 4. Live scrub / 실시간 스크럽
// ==========================================================================

let scrub = null; // { out: GainNode, voices: Map(id → { osc, gain, stats }) }

function ensureScrubVoice(ctx, v) {
  let entry = scrub.voices.get(v.id);
  if (!entry) {
    const sample = voiceSampleSpec(v);
    // tape: the scrub voice is open-ended (no stop time to render pitch-only grains) / 스크럽은 끝 시각이 없어 테이프
    const osc = createToneSource(ctx, { sample, wave: sample ? null : createVoicePeriodicWave(ctx, v), tape: true });
    if (osc.isSample && osc.node.buffer) osc.node.loop = true; // scrub keeps sounding / 스크럽 동안 계속 발음
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(scrub.out);
    osc.start();
    entry = { osc, gain, stats: v.audioTarget === 'vel' ? computeDerivativeStats(v) : undefined };
    scrub.voices.set(v.id, entry);
  }
  return entry;
}

/**
 * Begin auditioning pitch & volume at `sec` while the playhead is dragged. Ignored while
 * the transport is playing. / 플레이헤드 드래그 중 해당 시각의 음고·볼륨 청취 시작.
 * @returns {Promise<boolean>}
 */
export async function startScrubAudio(sec) {
  if (isPlaying()) return false;
  const ctx = await ensureAudioCtx();
  if (!scrub) {
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(getOutputBus(ctx));
    scrub = { out, voices: new Map() };
  }
  const now = ctx.currentTime;
  scrub.out.gain.cancelScheduledValues(now);
  scrub.out.gain.setValueAtTime(scrub.out.gain.value, now);
  scrub.out.gain.linearRampToValueAtTime(1, now + TRANSPORT_FADE_SEC);
  updateScrubAudio(sec);
  return true;
}

/** Glide every scrub voice to its pitch/amplitude at `sec`. / 스크럽 위치로 음고·진폭 이동 */
export function updateScrubAudio(sec) {
  if (!scrub || !audioCtx) return;
  const ctx = audioCtx;
  const now = ctx.currentTime;
  const { audible } = getPlayableTimeline();
  const bus = evaluateMasterBusGain(audible, sec, busConfig, { ranges: precomputeGainRanges(audible) });
  const ampById = new Map(bus.voices.map((x) => [x.id, x.amp]));
  const live = new Set();
  for (const v of audible) {
    const entry = ensureScrubVoice(ctx, v);
    live.add(v.id);
    const amp = (ampById.get(v.id) || 0) * bus.master;
    if (amp > 0) {
      const tn = (sec - v.startTime) / Math.max(1e-9, v.duration);
      entry.osc.frequency.setTargetAtTime(getVoiceFreqAtNormT(v, tn, { stats: entry.stats }), now, SCRUB_FREQ_TC);
    }
    entry.gain.gain.setTargetAtTime(amp, now, SCRUB_GAIN_TC);
  }
  // Voices muted/removed mid-scrub fade out / 스크럽 중 뮤트·삭제된 보이스는 페이드아웃
  for (const [id, entry] of scrub.voices) {
    if (!live.has(id)) entry.gain.gain.setTargetAtTime(0, now, SCRUB_GAIN_TC);
  }
}

/** End the scrub with a short fade. / 짧은 페이드로 스크럽 종료 */
export function stopScrubAudio() {
  if (!scrub || !audioCtx) return;
  const now = audioCtx.currentTime;
  const s = scrub;
  scrub = null;
  s.out.gain.cancelScheduledValues(now);
  s.out.gain.setValueAtTime(s.out.gain.value, now);
  s.out.gain.linearRampToValueAtTime(0, now + TRANSPORT_FADE_SEC * 2);
  const stopAt = now + TRANSPORT_FADE_SEC * 2 + 0.01;
  for (const { osc } of s.voices.values()) {
    try { osc.stop(stopAt); } catch { /* ignore */ }
  }
  setTimeout(() => {
    for (const { osc, gain } of s.voices.values()) { try { osc.disconnect(); gain.disconnect(); } catch { /* ignore */ } }
    try { s.out.disconnect(); } catch { /* ignore */ }
  }, (stopAt - now) * 1000 + 50);
}

export function isScrubbing() {
  return !!scrub;
}

// ==========================================================================
// 5. Offline render & WAV export / 오프라인 렌더링과 WAV 내보내기
// ==========================================================================

/**
 * Render [fromSec, toSec) offline. / 오프라인 렌더링
 * @param {{ voices?: object[], fromSec?: number, toSec?: number, sampleRate?: number,
 *           channels?: number, bus?: object }} [opts]
 * @returns {Promise<AudioBuffer|null>} null when nothing is audible
 */
export async function renderOfflineBuffer(opts = {}) {
  const { voices = appState.voices, fromSec = 0, sampleRate = EXPORT_SAMPLE_RATE, channels = 2, bus = busConfig } = opts;
  const { audible, endSec } = getPlayableTimeline(voices);
  const toSec = opts.toSec ?? endSec;
  if (!audible.length || toSec - fromSec <= 0.002) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('OfflineAudioContext is not available in this browser');
  const span = toSec - fromSec;
  const ctx = new Offline(channels, Math.ceil(span * sampleRate), sampleRate);
  scheduleGraph(ctx, opts.outputStage ? createOfflineOutput(ctx) : ctx.destination, { voices, fromSec, toSec, when: 0, bus, legato: opts.legato, sampleJoin: opts.sampleJoin, glideMs: opts.glideMs, ampMask: opts.ampMask, pitchWarp: opts.pitchWarp, brightWarp: opts.brightWarp, voiceMod: opts.voiceMod });
  return ctx.startRendering();
}

/**
 * Encode PCM WAV (16-bit by default, little-endian, interleaved).
 * Accepts an AudioBuffer or { sampleRate, channels: Float32Array[] }.
 * PCM WAV 인코딩 (기본 16-bit).
 * @returns {ArrayBuffer}
 */
export function encodeWav(buffer, { bitDepth = EXPORT_BIT_DEPTH } = {}) {
  // 16 / 24-bit PCM, or 32-bit float (format 3) / 16·24비트 PCM 또는 32비트 float
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) throw new RangeError('encodeWav: 16, 24 or 32 (float) bits');
  const chans = Array.isArray(buffer.channels)
    ? buffer.channels
    : Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const sampleRate = buffer.sampleRate;
  const numCh = chans.length;
  const frames = chans.reduce((m, c) => Math.max(m, c.length), 0);
  const bytes = bitDepth / 8;
  const blockAlign = numCh * bytes;
  const dataBytes = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, bitDepth === 32 ? 3 : 1, true); // PCM or IEEE float
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitDepth, true);
  str(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const raw = chans[c][i] ?? 0;
      if (bitDepth === 32) { dv.setFloat32(off, Number.isFinite(raw) ? raw : 0, true); off += 4; continue; }
      const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      if (bitDepth === 16) { dv.setInt16(off, Math.round(s < 0 ? s * 32768 : s * 32767), true); off += 2; continue; }
      const v = Math.round(s < 0 ? s * 8388608 : s * 8388607);
      dv.setUint8(off, v & 0xff); dv.setUint8(off + 1, (v >> 8) & 0xff); dv.setUint8(off + 2, (v >> 16) & 0xff);
      off += 3;
    }
  }
  return ab;
}

/**
 * `Gliss_{engine number}_{voice name}_T{length}s.wav`, e.g. Gliss_07_Voice-1_T3.50s.wav.
 * Unsafe filename characters are removed; letters in any script (e.g. 한글) are kept.
 * 파일명 규칙: Gliss_{엔진번호}_{보이스명}_T{길이}s.wav
 */
export function buildWavFilename(voice, lengthSec) {
  const num = String(getEngineDef(voice?.engine)?.num ?? 0).padStart(2, '0');
  const name = String(voice?.name || 'Voice')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 48) || 'Voice';
  const len = Number.isFinite(lengthSec) ? lengthSec : voice?.duration ?? 0;
  return `Gliss_${num}_${name}_T${len.toFixed(2)}s.wav`;
}

/** Peak |sample| of an AudioBuffer. / 최대 절댓값 */
export function measurePeak(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/** Save a Blob through a temporary <a download> link. / 임시 링크로 파일 저장 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Render the audible voices offline at 48 kHz, encode 16-bit PCM WAV and download it.
 * Filename uses the active voice: Gliss_{engine}_{name}_T{rendered length}s.wav.
 * 발음 보이스를 48 kHz로 오프라인 렌더링해 16-bit WAV로 저장.
 * @param {{ voices?: object[], fromSec?: number, toSec?: number, channels?: number,
 *           download?: boolean, filename?: string }} [opts]
 * @returns {Promise<{ ok: boolean, reason?: string, message?: string, filename?: string,
 *           blob?: Blob, bytes?: number, durationSec?: number, peak?: number, peakDb?: number }>}
 */
export async function exportWavFile(opts = {}) {
  const { voices = appState.voices, fromSec = 0, channels = 2, download = true } = opts;
  const buffer = await renderOfflineBuffer({ voices, fromSec, toSec: opts.toSec, channels, sampleRate: EXPORT_SAMPLE_RATE, outputStage: true });
  if (!buffer) return { ok: false, reason: 'noAudio', message: t('toast.noAudio') };
  const wav = encodeWav(buffer);
  const durationSec = buffer.length / buffer.sampleRate;
  const named = voices === appState.voices ? getActiveVoice() : voices.find((v) => v && !v.muted) || voices[0];
  const filename = opts.filename || buildWavFilename(named, durationSec);
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  const peak = measurePeak(buffer);
  return {
    ok: true,
    filename,
    blob,
    bytes: wav.byteLength,
    durationSec,
    peak,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    message: t('toast.wavDone', filename),
  };
}

// ==========================================================================
// 6. Self-checks / 자가진단 (offline only — live audio needs a user gesture)
// ==========================================================================

const steadyVoice = (i, hz, over = {}) =>
  createDefaultVoice(i, {
    engine: 'custom',
    customPoints: [{ x: 0, y: 0, handles: [] }, { x: 1, y: 1, handles: [] }],
    f0Hz: hz,
    f1Hz: hz,
    duration: 0.25,
    baseGain: 0.8,
    timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 },
    gainPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }],
    ...over,
  });

/** Frequency estimate from positive-going zero crossings in the middle half. */
function estimateHz(data, sampleRate) {
  const a = Math.floor(data.length * 0.25);
  const b = Math.floor(data.length * 0.75);
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = a + 1; i < b; i++) {
    if (data[i - 1] < 0 && data[i] >= 0) {
      if (first < 0) first = i;
      last = i;
      count++;
    }
  }
  return count > 1 ? ((count - 1) * sampleRate) / (last - first) : 0;
}

registerSelfCheck('WAV filename & 16-bit encoder', (a) => {
  a.equal(buildWavFilename(createDefaultVoice(0, { engine: 'bezier', name: 'Voice 1' }), 3.5), 'Gliss_07_Voice-1_T3.50s.wav');
  a.equal(buildWavFilename(createDefaultVoice(0, { engine: 'custom', name: '보이스 2/test?' }), 12), 'Gliss_11_보이스-2test_T12.00s.wav');
  a.equal(buildWavFilename(createDefaultVoice(0, { name: '  ' }), 1), 'Gliss_01_Voice_T1.00s.wav');

  const ab = encodeWav({ sampleRate: 48000, channels: [new Float32Array([0, 0.5, -1, 1.2])] });
  const dv = new DataView(ab);
  const tag = (o) => String.fromCharCode(...new Uint8Array(ab, o, 4));
  a.equal(tag(0), 'RIFF');
  a.equal(tag(8), 'WAVE');
  a.equal(tag(36), 'data');
  a.equal(dv.getUint16(20, true), 1, 'PCM');
  a.equal(dv.getUint32(24, true), 48000, 'sample rate');
  a.equal(dv.getUint32(28, true), 96000, 'byte rate');
  a.equal(dv.getUint16(34, true), 16, 'bit depth');
  a.equal(dv.getUint32(40, true), 8, 'data bytes');
  a.equal([0, 1, 2, 3].map((i) => dv.getInt16(44 + 2 * i, true)).join(), '0,16384,-32768,32767', 'samples & clipping');
  const st = encodeWav({ sampleRate: 44100, channels: [new Float32Array([0.25]), new Float32Array([-0.25])] });
  a.equal(new DataView(st).getUint16(32, true), 4, 'stereo block align');
}, { group: 'audio' });

registerSelfCheck('Offline render: pitch, solo/mute, cue offset, export', async (a) => {
  if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) return; // non-browser env
  const v440 = steadyVoice(0, 440);
  const buf = await renderOfflineBuffer({ voices: [v440], channels: 1 });
  a.equal(buf.sampleRate, EXPORT_SAMPLE_RATE);
  a.equal(buf.length, Math.ceil(0.25 * EXPORT_SAMPLE_RATE), 'length = timeline');
  a.near(estimateHz(buf.getChannelData(0), buf.sampleRate), 440, 2, 'rendered pitch');
  const pk = measurePeak(buf);
  a.ok(pk > 0.3 && pk <= 1, `peak ${pk}`);
  const d = buf.getChannelData(0);
  a.ok(Math.abs(d[0]) < 0.05 && Math.abs(d[d.length - 1]) < 0.05, 'click guard at both ends');

  const soloed = await renderOfflineBuffer({ voices: [v440, steadyVoice(1, 880, { solo: true })], channels: 1 });
  a.near(estimateHz(soloed.getChannelData(0), soloed.sampleRate), 880, 3, 'solo isolates the soloed voice');
  const muted = await renderOfflineBuffer({ voices: [v440, steadyVoice(1, 660, { muted: true })], channels: 1 });
  a.near(estimateHz(muted.getChannelData(0), muted.sampleRate), 440, 2, 'muted voice silent');

  const glide = steadyVoice(0, 220, { f1Hz: 880, duration: 0.4 });
  const late = await renderOfflineBuffer({ voices: [glide], fromSec: 0.2, channels: 1 });
  a.equal(late.length, Math.ceil(0.2 * EXPORT_SAMPLE_RATE), 'cue offset shortens render');
  a.near(estimateHz(late.getChannelData(0), late.sampleRate), 440 * Math.SQRT2, 25, 'render starts mid-glide');

  const res = await exportWavFile({ voices: [v440], download: false });
  a.ok(res.ok && /^Gliss_11_Voice-1_T0\.25s\.wav$/.test(res.filename), res.filename);
  a.equal(res.bytes, 44 + Math.ceil(0.25 * EXPORT_SAMPLE_RATE) * 2 * 2, 'stereo 16-bit size');
  const none = await exportWavFile({ voices: [steadyVoice(0, 440, { muted: true })], download: false });
  a.ok(!none.ok && none.reason === 'noAudio', 'nothing audible');
}, { group: 'audio' });

/**
 * Loudness dip at the join of two back-to-back voices: min / median of 6 ms RMS windows
 * (0.5 ms hop) within ±20 ms of the join (1 = no dip, 0 = silence gap). / 경계 음량 함몰 측정
 */
export function measureJoinDip(buffer, joinSec) {
  const d = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const win = Math.round(sr * 0.006); // ≥ one cycle down to ~170 Hz / 한 주기 이상
  const hop = Math.round(sr * 0.0005);
  const rms = [];
  for (let c = Math.round((joinSec - 0.02) * sr); c + win < (joinSec + 0.02) * sr; c += hop) {
    let acc = 0;
    for (let i = c; i < c + win; i++) acc += d[i] * d[i];
    rms.push(Math.sqrt(acc / win));
  }
  const sorted = [...rms].sort((x, y) => x - y);
  return sorted[0] / Math.max(1e-9, sorted[Math.floor(sorted.length / 2)]);
}

registerSelfCheck('Legato join: no dip / click between two functions at the same pitch', async (a) => {
  if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) return;
  const A = steadyVoice(0, 330, { duration: 0.3 });
  const B = steadyVoice(1, 330, { startTime: 0.3, duration: 0.3, engine: 'harmonic' });
  B.f0Hz = 330; B.f1Hz = 330;
  a.equal(buildLegatoChains([B, A]).length, 1, 'back-to-back voices form one chain');
  a.equal(buildLegatoChains([A, B], { enabled: false }).length, 2, 'disabled → separate');
  const off = await renderOfflineBuffer({ voices: [A, B], channels: 1, legato: false });
  const on = await renderOfflineBuffer({ voices: [A, B], channels: 1, legato: true });
  const dipOff = measureJoinDip(off, 0.3);
  const dipOn = measureJoinDip(on, 0.3);
  a.ok(dipOff < 0.5, `separate oscillators dip at the join (${dipOff.toFixed(3)})`);
  a.ok(dipOn > 0.9, `legato join keeps level (${dipOn.toFixed(3)})`);
}, { group: 'audio' });

registerSelfCheck('Sampler join: restart / continue when pitches meet / always continue', async (a) => {
  const sr = 48000;
  // 1 s file whose level rises 0 → 1, so a restart is quiet and a continuation is loud
  // 0 → 1로 커지는 1초 파일: 새로 시작하면 작고, 이어 읽으면 큼
  const data = new Float32Array(sr);
  for (let i = 0; i < sr; i++) data[i] = Math.sin((2 * Math.PI * 261.63 * i) / sr) * (i / sr);
  const entry = addSample({ name: 'check-join', sampleRate: sr, data });
  try {
    const smp = { id: entry.id, root: 60, xfadeMs: 2 };
    const mk = (i, hz, start) => { const v = steadyVoice(i, hz, { startTime: start, duration: 0.3, timbreMode: 'sample', timbreSample: smp }); v.f0Hz = hz; v.f1Hz = hz; return v; };
    const A = mk(0, 261.63, 0);
    const B = mk(1, 261.63, 0.3);
    const C = mk(2, 392, 0.3);
    const rc = buildLegatoChains([A, B], { sampleJoin: 'restart' });
    a.ok(rc.length === 1 && rc[0].reads.join() === '0,1', 'restart → one chain, two reads (crossfaded)');
    a.equal(buildLegatoChains([A, B], { sampleJoin: 'restart', enabled: false }).length, 2, 'restart without Legato Join → separate');
    a.equal(buildLegatoChains([A, B], { sampleJoin: 'pitch' }).length, 1, 'same pitch → joined');
    a.equal(buildLegatoChains([A, C], { sampleJoin: 'pitch' })[0].reads.join(), '0,1', 'pitch apart → new read in "pitch"');
    a.equal(buildLegatoChains([A, C], { sampleJoin: 'always' })[0].reads.join(), '0,0', 'pitch apart → same read in "always"');
    a.equal(buildLegatoChains([A, B], { sampleJoin: 'pitch' })[0].reads.join(), '0,0', 'same pitch → same read');
    a.equal(buildLegatoChains([A, B], { sampleJoin: 'always', enabled: false }).length, 1, 'independent of Legato Join');
    const synth = steadyVoice(3, 261.63, { startTime: 0.3, duration: 0.3 });
    a.equal(buildLegatoChains([A, synth], { sampleJoin: 'always' }).length, 2, 'sampler never joins a synth voice');
    if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext) || typeof globalThis.AudioBuffer !== 'function') return;
    const rms = (buf, t0, t1) => { const d = buf.getChannelData(0); let q = 0; const i0 = Math.round(t0 * buf.sampleRate); const i1 = Math.round(t1 * buf.sampleRate); for (let i = i0; i < i1; i++) q += d[i] * d[i]; return Math.sqrt(q / (i1 - i0)); };
    const re = await renderOfflineBuffer({ voices: [A, B], channels: 1, sampleRate: sr, sampleJoin: 'restart' });
    const jo = await renderOfflineBuffer({ voices: [A, B], channels: 1, sampleRate: sr, sampleJoin: 'pitch' });
    const r0 = rms(re, 0.36, 0.42);
    const r1 = rms(jo, 0.36, 0.42);
    a.ok(r1 > 2.5 * r0, `continued read is louder after the join (${r1.toFixed(3)} vs ${r0.toFixed(3)})`);
    a.ok(rms(jo, 0.295, 0.305) > 0.5 * rms(jo, 0.25, 0.29), 'no dip at the join');
    // Restart: the file starts again at B (quiet) but crossfades — no gap of silence at the join
    // 새로 재생: B에서 파일이 다시 시작(작음)하지만 교차 페이드 — 경계에 무음 구간 없음
    const dAt = (buf, t) => { const d = buf.getChannelData(0); const i0 = Math.round((t - 0.004) * buf.sampleRate); let m = 0; for (let i = i0; i < i0 + Math.round(0.008 * buf.sampleRate); i++) m = Math.max(m, Math.abs(d[i])); return m; };
    a.ok(dAt(re, 0.3) > 0.8 * Math.min(dAt(re, 0.29), dAt(re, 0.31)) || dAt(re, 0.3) > 0.2, `restart join keeps sounding (peak ${dAt(re, 0.3).toFixed(3)})`);
  } finally {
    removeSample(entry.id);
  }
}, { group: 'audio' });

registerSelfCheck('Transport state helpers (no audio device needed)', (a) => {
  const prevLoop = appState.transport.loop;
  try {
    setLooping(false);
    a.equal(toggleLooping(), true);
    a.equal(isLooping(), true);
    a.equal(toggleLooping(), false);
  } finally {
    setLooping(prevLoop);
  }
  a.equal(isPlaying(), false);
  a.equal(pauseAtPlayhead(), null, 'pause when stopped is a no-op');
  const { endSec, audible } = getPlayableTimeline([steadyVoice(0, 440, { startTime: 1 }), steadyVoice(1, 440, { muted: true, startTime: 5 })]);
  a.near(endSec, 1.25, 1e-12, 'timeline ignores muted voices');
  a.equal(audible.length, 1);
}, { group: 'audio' });

registerSelfCheck('Play range: trim / extend along the curve, split into linked pieces, ADSR runs', async (a) => {
  const { evaluateCurveObjectY } = await import('../modules/curve-engine.js');
  const { trimLineEdge, splitLineAt, clipFullSpan, syncLinkedShapes, shapeSignature } = await import('../core/line-clip.js');
  const { adsrGainAt } = await import('../core/adsr.js');
  const { LINK_SHAPE_KEYS, normalizeVoice } = await import('../core/state.js');
  const ySec = (v, sec) => evaluateCurveObjectY(v, (sec - v.startTime) / v.duration);
  const v0 = createDefaultVoice(0, { startTime: 1, duration: 2, engine: 'expo' });
  // trim the end to 2.5 s: the curve stays where it was in time / 끝을 2.5초로: 곡선은 제자리
  const tr = trimLineEdge({ ...v0 }, v0, 'end', 2.5);
  a.near(tr.duration, 1.5, 1e-9, 'trimmed duration');
  a.near(tr.clip.u1, 0.75, 1e-9, 'u1');
  a.near(ySec(tr, 2.2), ySec(v0, 2.2), 1e-9, 'same curve value inside the kept part');
  const st = trimLineEdge({ ...v0 }, v0, 'start', 1.5);
  a.near(st.startTime, 1.5, 1e-9, 'start moved');
  a.near(ySec(st, 2), ySec(v0, 2), 1e-9, 'start trim keeps the curve');
  a.near(clipFullSpan(st).start, 1, 1e-9, 'whole curve still starts at 1 s');
  // extend past the end: shape (formula) vs straight (tangent) / 끝 너머 연장
  const ex = trimLineEdge({ ...v0 }, v0, 'end', 4);
  a.near(ex.clip.u1, 1.5, 1e-9, 'extended u1');
  a.ok(ySec(ex, 4) > 1.05, 'exp keeps rising past its end (shape)');
  const exT = { ...ex, clip: { ...ex.clip, ext: 'tangent' } };
  const slope = (evaluateCurveObjectY(v0, 1) - evaluateCurveObjectY(v0, 1 - 1e-3)) / 1e-3;
  a.near(evaluateCurveObjectY(exT, 1), 1 + 0.5 * slope, 1e-6, 'straight = end tangent');
  const h = createDefaultVoice(0, { startTime: 0, duration: 1 });
  const hx = trimLineEdge({ ...h }, h, 'end', 1.5);
  a.near(evaluateCurveObjectY(hx, 2 / 3), evaluateCurveObjectY(h, 1), 1e-6, 'continuous at the old end');
  // split: two pieces, same sound, linked / 자르기: 두 조각, 같은 소리, 링크
  const [p, q] = splitLineAt(v0, 2.2, { newId: () => 'v_b', linkId: () => 'ln_x' });
  a.ok(p.link.id === 'ln_x' && q.link.id === 'ln_x' && q.id === 'v_b', 'linked ids');
  a.near(p.duration + q.duration, 2, 1e-9, 'durations add up');
  a.near(ySec(p, 2), ySec(v0, 2), 1e-9, 'first piece = original');
  a.near(ySec(q, 2.7), ySec(v0, 2.7), 1e-9, 'second piece = original');
  a.equal(splitLineAt(v0, 1.01, { newId: () => 'x' }), null, 'too close to an end');
  a.ok(normalizeVoice(q).clip && normalizeVoice(q).link.on === true, 'clip and link survive normalize');
  // link sync: a shape edit on one piece reaches the other; timing does not / 링크 동기화
  const before = new Map([[p.id, shapeSignature(p, LINK_SHAPE_KEYS)]]);
  p.expK = 7;
  p.startTime = 0.5;
  syncLinkedShapes([p, q], [p], before, LINK_SHAPE_KEYS);
  a.ok(q.expK === 7 && q.startTime === 2.2, 'shape copied, timing kept');
  q.link.on = false;
  p.expK = 2;
  syncLinkedShapes([p, q], [p], new Map([[p.id, 'x']]), LINK_SHAPE_KEYS);
  a.equal(q.expK, 7, 'unlinked piece stays');
  // ADSR / ADSR
  const env = { on: true, a: 0.1, d: 0.1, s: 0.5, r: 0.2, retrig: false };
  a.near(adsrGainAt(env, 0.05, 2), 0.5, 1e-9, 'attack half way');
  a.near(adsrGainAt(env, 1, 2), 0.5, 1e-9, 'sustain');
  a.near(adsrGainAt(env, 1.9, 2), 0.25, 1e-9, 'release half way');
  a.near(adsrGainAt(env, 2, 2), 0, 1e-9, 'silent at the end');
  const A = createDefaultVoice(0, { startTime: 0, duration: 1, adsr: { ...env } });
  const B = createDefaultVoice(1, { startTime: 1, duration: 1, adsr: { ...env } });
  const runs = adsrRunsOf([A, B]);
  a.ok(runs[0] === runs[1] && runs[0].end === 2, 'joined voices: one envelope (default)');
  B.adsr.retrig = true;
  const runs2 = adsrRunsOf([A, B]);
  a.ok(runs2[0] !== runs2[1] && runs2[1].start === 1, 'Restart at joins: new envelope');
  a.equal(adsrRunsOf([createDefaultVoice(0)])[0], null, 'ADSR off → no envelope');
}, { group: 'audio' });

registerSelfCheck('Play range in every studio: full-span trim / split, link sync, Draw pieces, ADSR on curves', async (a) => {
  const L = await import('../core/line-clip.js');
  const { applyAdsrToCurve, adsrSpanRuns } = await import('../core/adsr.js');
  const { clipStrokeResult, piecePitchAt } = await import('../studios/draw/draw-engine.js');
  const { lookupBakedSampleExt } = await import('../studios/field/vector-field-engine.js');
  // full-span trim keeps the span, moves only u / 전체 구간 유지, u만 이동
  const c1 = L.trimClip(null, 2, 4, 'end', 5);
  a.near(c1.u1, 0.75, 1e-9, 'end trimmed to 75 %');
  a.near(L.clipWindow(c1, 2, 4).s1, 5, 1e-9, 'window end');
  a.equal(L.trimClip(c1, 2, 4, 'end', 9, { uMax: 1 }), null, 'trim-only studio: back to the whole line');
  a.near(L.trimClip(null, 2, 4, 'end', 8).u1, 1.5, 1e-9, 'extendable studio');
  const [s0, s1] = L.splitClip(c1, 2, 4, 3);
  a.ok(s0.u0 === 0 && Math.abs(s0.u1 - 0.25) < 1e-9 && Math.abs(s1.u1 - 0.75) < 1e-9, 'split clips meet');
  a.near(L.extendSampled((u) => 2 * u, 1.5), 3, 1e-9, 'tangent extension of a sampled line');
  // link sync after a studio edit / 스튜디오 편집 뒤 링크 동기화
  const before = [{ id: 'a', link: { id: 'l', on: true }, mass: 1, start: 0 }, { id: 'b', link: { id: 'l', on: true }, mass: 1, start: 3 }, { id: 'c', link: { id: 'l', on: false }, mass: 1 }];
  const after = JSON.parse(JSON.stringify(before));
  after[1].mass = 5;
  after[1].start = 4;
  L.syncLinkedAfterEdit(before, after, ['mass'], 'b');
  a.ok(after[0].mass === 5 && after[0].start === 0 && after[2].mass === 1, 'shape synced to linked, timing and unlinked kept');
  L.setLineLink(after, 'c', true, ['mass']);
  a.equal(after[2].mass, 5, 're-link takes the shape');
  // Draw: a clipped stroke plays its part of the same line / 드로잉: 잘린 획은 같은 선의 일부
  const curve = { engine: 'expo', expK: 3, expMode: 'exp', reverse: false, inverse: false };
  const pc = { t0: 1, dur: 2, pA: 60, pB: 72, curve, pts: [{ t: 1, w: 1 }, { t: 3, w: 1 }] };
  const res = clipStrokeResult({ pieces: [pc] }, { u0: 0.25, u1: 1.25 });
  a.near(res.pieces[0].t0, 1.5, 1e-9, 'played start');
  a.near(res.pieces[0].dur, 2, 1e-9, 'played length incl. extension');
  a.near(piecePitchAt(res.pieces[0], 2.2), piecePitchAt(pc, 2.2), 1e-6, 'same pitch inside');
  a.ok(piecePitchAt(res.pieces[0], 3.4) > 72, 'extension goes on past the end');
  a.equal(res.ghost.length, 1, 'the cut-off start is kept for the faint drawing');
  // Field: reading past the bake follows the end tangent / 필드: 끝 너머 접선
  const pts = [{ t: 0, y: 0, normSpeed: 0, normCurv: 0 }, { t: 0.5, y: 0.5, normSpeed: 0, normCurv: 0 }, { t: 1, y: 1, normSpeed: 0, normCurv: 0 }];
  a.near(lookupBakedSampleExt({ retroMode: 'unfold' }, pts, 1.5).y, 1.5, 1e-6, 'field extension');
  // ADSR on any studio's gain curve / 모든 스튜디오의 게인 곡선에 ADSR
  const g = applyAdsrToCurve({ on: true, a: 0.5, d: 0, s: 1, r: 0.5, retrig: false }, new Float32Array(5).fill(1), 0, 2, 2);
  a.ok(g[0] === 0 && Math.abs(g[2] - 1) < 1e-9 && g[4] === 0, 'attack from 0, release to 0');
  const runs = adsrSpanRuns([{ t0: 0, t1: 1 }, { t0: 1, t1: 2 }, { t0: 3, t1: 4 }]);
  a.ok(runs[0].end === 2 && runs[1].start === 0 && runs[2].start === 3, 'touching spans share a run');
}, { group: 'audio' });
