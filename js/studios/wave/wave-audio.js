/**
 * Flexatone — studios/wave/wave-audio.js
 * Wave Studio audio tier: plays and renders the BAKED wave field only.
 * 웨이브 스튜디오 오디오: 베이킹된 파동장만 재생·렌더링.
 *
 * Layer note / 계층 메모: this file lives in the studio folder but belongs to the audio tier — it
 * may import audio/*, and only ui/workspaces.js (and wave-panels.js) import it. The pure files
 * (wave-studio.js, wave-engine.js, wave-bank.js) never import it.
 * 스튜디오 폴더에 있지만 오디오 계층 파일 — ui/workspaces.js와 wave-panels.js만 import함.
 *
 * Three graphs, one transport / 그래프 3종, 트랜스포트 1개
 *   worklet     : AudioWorkletNode(Blob: WaveSpectralBank, stereo) → master fade → output bus.
 *                 The control matrix (frames × bins) is streamed through the port in chunks of
 *                 CHUNK_FRAMES rows (transferred, not copied), starting at the playhead.
 *   oscillators : fallback (no AudioWorklet, or sonify.engine = 'oscillators') — ≤ 64 sine
 *                 oscillators, each with a gain curve from the matrix (neighbouring bins merged).
 *   ridge       : one oscillator per ridge track (PeriodicWave from the 5-wave timbre, frequency /
 *                 gain / pan curves), the Field Studio way.
 * No PDE work at playback: every curve and matrix comes from the caches in wave-engine.js.
 * 재생 중 PDE 연산 없음: 모든 곡선·행렬은 wave-engine.js의 캐시에서 가져옴.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { subscribe, registerSelfCheck } from '../../core/state.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { studioLiveOutput, connectStudioOutput, applyTremoloToSamples } from '../../audio/studio-fx.js';
import { createVoiceModEvaluator, voiceModCentsCurve, voiceModFreqCurve, voiceModGainCurve, voiceModFrame } from '../../core/voice-mod.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { getAudioCtx, encodeWav, triggerDownload, measurePeak, EXPORT_SAMPLE_RATE, TRANSPORT_FADE_SEC } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { buildAmplitude, extractRidges, sampleTrack, sanitizeWaveParams, createDefaultWaveParams, createWavePreset, simulateWave, getWaveBakeCount, retimeWaveBake, waveSignature } from './wave-engine.js';
import { WaveSpectralBank, WAVE_PROCESSOR, buildWaveWorkletSource } from './wave-bank.js';
import { getWaveParams, getWaveBake, resolveWaveDoc, waveBinFrequencies, waveBinPhases, buildWaveExport } from '../wave-studio.js';

const START_LEAD_SEC = 0.04;
const END_FADE_SEC = 0.03;
/** Rows per port message (128 bins → 128 kB). / 포트 메시지당 행 수 */
export const CHUNK_FRAMES = 256;
/** Oscillator fallback: at most this many sine oscillators. / 폴백 오실레이터 상한 */
export const MAX_OSC_BINS = 64;

// --------------------------------------------------------------------------
// Plan: everything a pass needs, from the caches / 패스에 필요한 모든 것 (캐시에서)
// --------------------------------------------------------------------------

/** Equal-power pan gains (×√2 so the centre is 1) for a pitch-ordered bin. / 등전력 팬 게인 */
function panGains(stereo, n) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pan = stereo * (n > 1 ? (2 * i) / (n - 1) - 1 : 0);
    const th = ((pan + 1) * Math.PI) / 4;
    L[i] = Math.SQRT2 * Math.cos(th);
    R[i] = Math.SQRT2 * Math.sin(th);
  }
  return { L, R };
}

/**
 * @param {object} params sanitised Wave document
 * @param {{ bake?: object, engine?: 'worklet'|'osc', timeScale?: number,
 *           ampMask?: ((sec: number, hz: number) => number)|null }} [o]
 *   timeScale = Tempo Manager rate (pitch-preserving: the matrix / tracks are computed on the
 *   baked field as it is and only read faster); ampMask = Manager shape regions (real seconds).
 *   timeScale = 템포 매니저 배속 (음고 유지: 행렬·트랙은 그대로, 읽는 속도만 변경), ampMask = 매니저 도형 영역.
 */
export function buildWavePlan(params = getWaveParams(), { bake = getWaveBake(params), engine = 'worklet', timeScale = 1, ampMask = null, pitchWarp = null } = {}) {
  const so = params.sonify;
  const timed = retimeWaveBake(bake, timeScale); // same field, other frame rate / 같은 장, 다른 프레임 레이트
  if (so.mode === 'ridge') {
    const r = extractRidges(bake, so);
    return {
      kind: 'ridge', bake: timed, params, length: timed.length, tracks: r.tracks, scale: r.scale, ampMask, pitchWarp,
      key: `ridge|${timed.sig}|${r.key}|${so.gain}|${so.stereo}|${JSON.stringify(params.timbre)}`,
    };
  }
  const amp = buildAmplitude(bake, so);
  const pan = panGains(so.stereo, bake.N);
  return {
    kind: engine, bake: timed, params, amp, length: timed.length, panL: pan.L, panR: pan.R, scale: amp.scale, ampMask, pitchWarp,
    key: `${engine}|${timed.sig}|${amp.key}|${so.stereo}`,
    dimKey: `${bake.N}x${bake.frames}@${timed.rate}|${bake.pLo}|${bake.pHi}|${params.seed}`,
  };
}

/**
 * Manager Warp on the spectral matrix: every frame is resampled along the pitch axis so that the
 * energy at bin pitch m is heard at warp(m). Pitches bent outside [pLo, pHi] are lost and the bend
 * is quantised to the bin spacing (the bins keep their frequencies). Returns a copy.
 * 매니저 곡률 (스펙트럼 행렬): 프레임마다 음고 축을 다시 샘플링 — 빈 음고 m의 에너지가 warp(m)에서 들림.
 * 범위 밖으로 휜 음고는 사라지고, 휘는 정도는 빈 간격으로 양자화됨.
 */
function warpMatrix(plan, A) {
  const { N, frames, rate, pLo, dp } = plan.bake;
  const out = new Float32Array(A.length);
  const hz = waveBinFrequencies(plan.bake);
  const mapped = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const sec = f / rate;
    const row = f * N;
    for (let i = 0; i < N; i++) mapped[i] = (12 * Math.log2(Math.max(1e-6, plan.pitchWarp(sec, hz[i])) / 440) + 69 - pLo) / dp; // bin index of warp(m_i)
    // inverse map: output bin o takes the source between the two mapped bins around it / 역사상
    let k = 0;
    for (let o = 0; o < N; o++) {
      while (k < N - 2 && mapped[k + 1] < o) k++;
      const a = mapped[k];
      const b = mapped[k + 1];
      if (o < a - 0.5 || o > mapped[N - 1] + 0.5) continue;
      const x = b > a ? clamp((o - a) / (b - a), 0, 1) : 0;
      out[row + o] = A[row + k] + (A[row + k + 1] - A[row + k]) * x;
    }
  }
  return out;
}

/** Amplitude matrix of a plan with the Manager warp / mask applied (a copy; the cache stays clean). */
function planMatrix(plan) {
  const A = plan.pitchWarp ? warpMatrix(plan, plan.amp.A) : plan.amp.A;
  if (!plan.ampMask) return A;
  const { N, frames, rate } = plan.bake;
  const hz = waveBinFrequencies(plan.bake);
  const out = new Float32Array(A.length);
  for (let f = 0; f < frames; f++) {
    const sec = f / rate;
    const row = f * N;
    for (let i = 0; i < N; i++) {
      const a = A[row + i];
      if (a > 0) out[row + i] = a * Math.max(0, plan.ampMask(sec, hz[i]));
    }
  }
  return out;
}

function makeBankOptions(plan) {
  const { bake } = plan;
  return {
    bins: bake.N, frames: bake.frames, frameRate: bake.rate,
    freqs: waveBinFrequencies(bake), phases: waveBinPhases(plan.params.seed, bake.N),
    panL: plan.panL, panR: plan.panR, scale: plan.scale,
    mod: voiceModFrame(plan.params.voiceMod), // per-bin tremolo / vibrato / 빈별 변조
  };
}

// --------------------------------------------------------------------------
// AudioWorklet (Blob) + chunk streaming / 워클릿과 청크 스트리밍
// --------------------------------------------------------------------------

const workletState = new WeakMap(); // ctx → { promise, ready, failed }

/** Load the Wave worklet into ctx once (Blob URL, no fetch of a separate file). / 워클릿 로드 */
export function ensureWaveWorklet(ctx) {
  let st = workletState.get(ctx);
  if (st) return st.promise;
  st = { ready: false, failed: false, promise: null };
  workletState.set(ctx, st);
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    st.failed = true;
    st.promise = Promise.resolve(false);
    return st.promise;
  }
  const url = URL.createObjectURL(new Blob([buildWaveWorkletSource()], { type: 'text/javascript' }));
  st.promise = ctx.audioWorklet.addModule(url)
    .then(() => { st.ready = true; return true; })
    .catch((err) => { st.failed = true; console.warn('[Wave] AudioWorklet unavailable → oscillator fallback', err); return false; })
    .finally(() => URL.revokeObjectURL(url));
  return st.promise;
}

const workletReady = (ctx) => !!(ctx && workletState.get(ctx)?.ready);

/** Engine for a spectral pass on this ctx right now. / 지금 사용할 스펙트럴 엔진 */
function pickEngine(params, ctx) {
  if (params.sonify.engine === 'oscillators') return 'osc';
  if (ctx) return workletReady(ctx) ? 'worklet' : 'osc';
  return typeof AudioWorkletNode === 'undefined' ? 'osc' : 'worklet';
}

/**
 * Engine for an offline render: the bank class runs on the main thread, so it does not need the
 * worklet module to be loaded yet — only an environment where the live pass would use the bank.
 * 오프라인 렌더용 엔진: 뱅크 클래스는 메인 스레드에서 돌므로 워클릿 로드 여부와 무관.
 */
function offlineEngine(params, ctx) {
  if (params.sonify.engine === 'oscillators' || typeof AudioWorkletNode === 'undefined') return 'osc';
  return ctx && workletState.get(ctx)?.failed ? 'osc' : 'worklet';
}

function createWaveNode(ctx, plan, { fromSec = 0, startTime = 0, matrix = null } = {}) {
  const o = makeBankOptions(plan);
  return new AudioWorkletNode(ctx, WAVE_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { ...o, fromFrame: fromSec * plan.bake.rate, startTime, ...(matrix ? { matrix } : {}) },
  });
}

let streamStats = { chunks: 0, bytes: 0, ms: 0 };
let streamId = 0;
/** Size and main-thread cost of the last matrix stream. / 마지막 행렬 스트림의 크기·비용 */
export const getWaveStreamStats = () => ({ ...streamStats });

/**
 * Stream the amplitude matrix to the worklet in chunks, starting with the chunk under
 * `startFrame` (so the part about to sound arrives first). Each chunk is a fresh copy whose
 * buffer is transferred (no structured clone of the data). Returns the id of the 'loaded' ack.
 * 진폭 행렬을 청크로 스트리밍 (재생 위치의 청크부터). 각 청크의 버퍼는 전송(transfer)됨.
 */
function postMatrix(node, plan, startFrame = 0) {
  const t0 = performance.now();
  const { A } = plan.amp;
  const n = plan.bake.N;
  const frames = plan.bake.frames;
  const total = Math.ceil(frames / CHUNK_FRAMES);
  const first = clamp(Math.floor(startFrame / CHUNK_FRAMES), 0, total - 1);
  const id = ++streamId;
  let bytes = 0;
  for (let q = 0; q < total; q++) {
    const c = (first + q) % total;
    const f0 = c * CHUNK_FRAMES;
    const f1 = Math.min(frames, f0 + CHUNK_FRAMES);
    const data = A.slice(f0 * n, f1 * n);
    bytes += data.byteLength;
    node.port.postMessage({ type: 'chunk', frame0: f0, data, last: q === total - 1, id }, [data.buffer]);
  }
  streamStats = { chunks: total, bytes, ms: performance.now() - t0 };
  return id;
}

// --------------------------------------------------------------------------
// Oscillator graphs (live and offline) / 오실레이터 그래프 (실시간·오프라인 공용)
// --------------------------------------------------------------------------

function makePanner(ctx, dest) {
  if (typeof ctx.createStereoPanner !== 'function') return null;
  const p = ctx.createStereoPanner();
  p.connect(dest);
  return p;
}

/**
 * Spectral fallback: ≤ MAX_OSC_BINS sine oscillators (bins merged in groups, power-preserving
 * √Σa²), each with a gain curve read from the matrix. Seeded start phases via PeriodicWave.
 * 스펙트럴 폴백: 사인 오실레이터 ≤ 64개 (이웃 빈을 묶어 파워 보존), 게인 곡선은 행렬에서 읽음.
 * @returns {number} oscillators scheduled
 */
export function scheduleSpectralOsc(ctx, dest, plan, nowTime, cueSec, nodeList) {
  const { bake, amp } = plan;
  const N = bake.N;
  const playDur = plan.length - cueSec;
  if (playDur <= 0.02) return 0;
  const group = Math.ceil(N / MAX_OSC_BINS);
  const count = Math.ceil(N / group);
  const samples = clamp(Math.ceil(playDur * Math.min(bake.rate, 50)) + 1, 2, 8000);
  const master = ctx.createGain();
  master.gain.value = plan.scale * Math.SQRT2;
  master.connect(dest);
  if (nodeList) nodeList.push(master);
  const phases = waveBinPhases(plan.params.seed, count);
  const A = plan.pitchWarp ? warpMatrix(plan, amp.A) : amp.A; // Manager Warp / 매니저 곡률
  const mask = plan.ampMask;
  const curve = new Float32Array(samples);
  let made = 0;
  for (let g = 0; g < count; g++) {
    const i0 = g * group;
    const i1 = Math.min(N, i0 + group);
    const hzG = midiToFreq(bake.pLo + (i0 + (i1 - 1 - i0) / 2) * bake.dp);
    let peak = 0;
    for (let j = 0; j < samples; j++) {
      const pos = clamp((cueSec + (j / (samples - 1)) * playDur) * bake.rate, 0, bake.frames - 1);
      const f = Math.min(bake.frames - 2, Math.floor(pos));
      const a = pos - f;
      let ss = 0;
      for (let i = i0; i < i1; i++) {
        const v = A[f * N + i] + (A[(f + 1) * N + i] - A[f * N + i]) * a;
        ss += v * v;
      }
      curve[j] = Math.min(1, Math.sqrt(ss));
      if (mask && curve[j] > 0) curve[j] *= Math.max(0, mask(cueSec + (j / (samples - 1)) * playDur, hzG));
      if (curve[j] > peak) peak = curve[j];
    }
    if (peak <= 0) continue;
    const hz = hzG;
    if (hz >= 0.45 * ctx.sampleRate) continue; // Nyquist guard / 나이퀴스트 보호
    const osc = ctx.createOscillator();
    const ph = 2 * Math.PI * phases[g];
    osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array([0, Math.sin(ph)]), new Float32Array([0, Math.cos(ph)]), { disableNormalization: true }));
    osc.frequency.value = hz;
    const gain = ctx.createGain();
    // Per-voice (per-bin group) tremolo / vibrato (core/voice-mod.js) / 빈 그룹별 트레몰로·비브라토
    const vm = createVoiceModEvaluator(plan.params.voiceMod, g, 69 + 12 * Math.log2(Math.max(10, hz) / 440));
    gain.gain.setValueCurveAtTime(voiceModGainCurve(vm, Float32Array.from(curve), cueSec, playDur), nowTime, playDur);
    const vib = voiceModCentsCurve(vm, new Float32Array(2), cueSec, playDur);
    if (vib.length > 2) osc.detune.setValueCurveAtTime(vib, nowTime, playDur);
    const panner = makePanner(ctx, master);
    if (panner) panner.pan.value = plan.params.sonify.stereo * (count > 1 ? (2 * g) / (count - 1) - 1 : 0);
    osc.connect(gain).connect(panner || master);
    osc.start(nowTime);
    osc.stop(nowTime + playDur + 0.02);
    if (nodeList) nodeList.push(osc, gain, ...(panner ? [panner] : []));
    made++;
  }
  return made;
}

/**
 * Ridge mode: one oscillator per track with frequency / gain / pan curves from the track.
 * 리지 모드: 트랙마다 오실레이터 1개 (주파수·게인·팬 곡선).
 * @returns {number} tracks scheduled
 */
export function scheduleRidges(ctx, dest, plan, nowTime, cueSec, nodeList) {
  const { bake, tracks, params } = plan;
  const so = params.sonify;
  const master = ctx.createGain();
  master.gain.value = plan.scale * Math.SQRT2;
  master.connect(dest);
  if (nodeList) nodeList.push(master);
  const wave = createTimbreWave(ctx, params.timbre); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
  const span = Math.max(1e-6, bake.pHi - bake.pLo);
  let made = 0;
  for (const tr of tracks) {
    const tStart = tr.f0 / bake.rate;
    const tEnd = (tr.f0 + tr.pitch.length - 1) / bake.rate;
    if (tEnd <= cueSec + 1e-3) continue;
    const from = Math.max(tStart, cueSec);
    const playDur = tEnd - from;
    if (playDur < 0.02) continue;
    const t0 = nowTime + (from - cueSec);
    const samples = clamp(Math.ceil(playDur * Math.min(bake.rate, 100)) + 1, 3, 12000);
    const freqCurve = new Float32Array(samples);
    const gainCurve = new Float32Array(samples);
    const panCurve = new Float32Array(samples);
    const fade = Math.min(0.008, playDur * 0.1);
    for (let j = 0; j < samples; j++) {
      const loc = (j / (samples - 1)) * playDur;
      const s = sampleTrack(tr, bake, Math.min(tEnd, from + loc)) || { pitch: tr.pitch[0], amp: 0 };
      const hz0 = midiToFreq(s.pitch);
      freqCurve[j] = clamp(plan.pitchWarp ? plan.pitchWarp(from + loc, hz0) : hz0, 20, 0.45 * ctx.sampleRate); // Manager Warp / 매니저 곡률
      let g = clamp(so.gain * s.amp, 0, 1);
      if (plan.ampMask && g > 0) g *= Math.max(0, plan.ampMask(from + loc, freqCurve[j]));
      if (loc < fade) g *= loc / fade;
      if (playDur - loc < fade) g *= (playDur - loc) / fade;
      gainCurve[j] = g;
      panCurve[j] = clamp(so.stereo * ((2 * (s.pitch - bake.pLo)) / span - 1), -1, 1);
    }
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    const gain = ctx.createGain();
    // Per-voice (per-ridge) tremolo / vibrato (core/voice-mod.js), on track time / 리지별 트레몰로·비브라토
    const vm = createVoiceModEvaluator(params.voiceMod, tracks.indexOf(tr), tr.pitch[0]);
    osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, freqCurve, from - tStart, playDur), t0, playDur);
    gain.gain.value = 0;
    gain.gain.setValueCurveAtTime(voiceModGainCurve(vm, gainCurve, from - tStart, playDur), t0, playDur);
    const panner = makePanner(ctx, master);
    if (panner) panner.pan.setValueCurveAtTime(panCurve, t0, playDur);
    osc.connect(gain).connect(panner || master);
    osc.start(t0);
    osc.stop(t0 + playDur + 0.01);
    if (nodeList) nodeList.push(osc, gain, ...(panner ? [panner] : []));
    made++;
  }
  return made;
}

/** Transport fade envelope shared by the live pass and the offline graph. / 공용 페이드 */
function scheduleEdgeFades(param, when, playDur, now = when) {
  param.setValueAtTime(0, now);
  if (when > now) param.setValueAtTime(0, when);
  param.linearRampToValueAtTime(1, when + TRANSPORT_FADE_SEC);
  const end = when + playDur;
  if (end - END_FADE_SEC > when + TRANSPORT_FADE_SEC) {
    param.setValueAtTime(1, end - END_FADE_SEC);
    param.linearRampToValueAtTime(0, end);
  }
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (appState.transport를 갱신해 공용 헤더와 연동)
// --------------------------------------------------------------------------

let restartTimer = null;
let lastEngine = null;

const needsWorklet = (params) => params.sonify.mode === 'spectral' && params.sonify.engine !== 'oscillators';

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  wrapStart: true,
  cueDigits: 3,
  endSec: () => getWaveBake(getWaveParams()).length,
  beforeStart: async (ctx) => { if (needsWorklet(getWaveParams())) await ensureWaveWorklet(ctx); },
  plan: (ctx) => {
    const params = getWaveParams();
    const plan = buildWavePlan(params, { engine: pickEngine(params, ctx) }); // memoised: no simulation unless physics changed
    return { plan, endSec: plan.length };
  },
  fadeIn: (gain, { when, now, playDur }) => scheduleEdgeFades(gain, when, playDur, now),
  output: (ctx) => studioLiveOutput(ctx, 'wave', () => getWaveParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { plan }, { when, fromSec, nodes }) => {
    let node = null;
    if (plan.kind === 'worklet') {
      node = createWaveNode(ctx, plan, { fromSec, startTime: when });
      node.connect(master);
      postMatrix(node, plan, fromSec * plan.bake.rate);
    } else if (plan.kind === 'osc') {
      scheduleSpectralOsc(ctx, master, plan, when, fromSec, nodes);
    } else {
      scheduleRidges(ctx, master, plan, when, fromSec, nodes);
    }
    lastEngine = plan.kind;
    return { kind: plan.kind, node, planKey: plan.key, dimKey: plan.dimKey || '' };
  },
  release: (pass) => {
    try { pass.node?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    try { pass.node?.disconnect(); } catch { /* ignore */ }
  },
  onClear: () => { if (restartTimer !== null) clearTimeout(restartTimer); restartTimer = null; },
});

export const isWavePlaying = transport.isPlaying;
export const getWavePlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startWaveAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopWaveAudio = transport.stop;
/** Pause: stop and pin the cue at the playhead. / 플레이헤드에 큐 고정 후 정지 */
export const pauseWaveAtPlayhead = transport.pauseAtPlayhead;
export const toggleWavePause = transport.togglePause;
export const toggleWavePlay = transport.togglePlay;

/** Engine of the live pass ('worklet' | 'osc' | 'ridge'), or the last one used. / 현재 엔진 */
export const getWaveEngineKind = () => transport.pass()?.kind ?? null;
export const lastWaveEngine = () => lastEngine;

/**
 * Follow document edits while playing. A sound-only change of a worklet pass with the same
 * matrix shape is streamed in place (no restart); anything else restarts at the playhead,
 * debounced so a slider drag restarts once it pauses.
 * 재생 중 편집 반영: 행렬 모양이 같은 음향 변경은 제자리 스트리밍, 그 외는 플레이헤드에서 재시작(디바운스).
 */
export function refreshWaveLive() {
  const live = transport.pass();
  if (!live) return;
  const ctx = getAudioCtx();
  const params = getWaveParams();
  const plan = buildWavePlan(params, { engine: pickEngine(params, ctx) });
  if (plan.key === live.planKey) return;
  if (plan.kind === 'worklet' && live.kind === 'worklet' && plan.dimKey === live.dimKey && Math.abs(plan.length - live.endSec) < 1e-9) {
    live.node.port.postMessage({ type: 'config', panL: plan.panL, panR: plan.panR, scale: plan.scale });
    postMatrix(live.node, plan, transport.playheadSec() * plan.bake.rate);
    live.planKey = plan.key;
    return;
  }
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!transport.isPlaying()) return;
    if (needsWorklet(getWaveParams())) await ensureWaveWorklet(getAudioCtx());
    transport.restart();
  }, 90);
}

// Document edits reach the live pass through the state bus (not through the render loop, which
// the browser throttles in a background tab). / 문서 편집은 상태 버스를 통해 실시간 패스에 전달
subscribe(() => { if (transport.isPlaying()) refreshWaveLive(); }, { scopes: ['studio'] });

// --------------------------------------------------------------------------
// Offline render, WAV and JSON / 오프라인 렌더링, WAV, JSON
// --------------------------------------------------------------------------

/** Render the bank on the main thread in 128-sample blocks (same class as the worklet). */
async function renderBank(plan, fs, len, { yieldEvery = 400 } = {}) {
  const o = makeBankOptions(plan);
  const bank = new WaveSpectralBank(fs, o.bins, o.frames, o);
  bank.setChunk(0, planMatrix(plan));
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  const k = plan.bake.rate / fs;
  for (let s0 = 0, blk = 0; s0 < len; s0 += 128, blk++) {
    const n = Math.min(128, len - s0);
    bank.process(bl, br, n, s0 * k, (s0 + n) * k);
    L.set(n < 128 ? bl.subarray(0, n) : bl, s0);
    R.set(n < 128 ? br.subarray(0, n) : br, s0);
    if (yieldEvery && blk % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r)); // keep the UI alive
  }
  return { L, R };
}

function applyEdgeFades(chans, fs, playDur) {
  const nIn = Math.round(TRANSPORT_FADE_SEC * fs);
  const end = Math.round(playDur * fs);
  const nOut = Math.round(END_FADE_SEC * fs);
  for (const d of chans) {
    for (let i = 0; i < nIn && i < d.length; i++) d[i] *= i / nIn;
    for (let i = Math.max(0, end - nOut); i < d.length; i++) d[i] *= i >= end ? 0 : (end - i) / nOut;
  }
}

/**
 * Render the whole piece offline with the engine the live pass would use (worklet → the same
 * bank class on the main thread; oscillators / ridge → the same schedulers in an offline
 * context). outputStage applies the Loudness Manager fader + limiter (Export WAV = what you hear).
 * 실시간과 같은 엔진으로 전체를 오프라인 렌더. outputStage = 출력 단계(페이더·리미터) 적용.
 * @returns {Promise<AudioBuffer|null>}
 */
export async function renderWaveBuffer({ params = getWaveParams(), bake = null, sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, engine = null, timeScale = 1, ampMask = null, pitchWarp = null } = {}) {
  const b = bake || getWaveBake(params);
  const plan = buildWavePlan(params, { bake: b, engine: engine || offlineEngine(params, getAudioCtx()), timeScale, ampMask, pitchWarp });
  if (plan.length <= 0.02) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const len = Math.ceil((plan.length + 0.05) * sampleRate);
  const ctx = new Offline(2, len, sampleRate);
  const dest = outputStage ? createOfflineOutput(ctx) : ctx.destination;
  if (plan.kind === 'worklet') {
    const { L, R } = await renderBank(plan, sampleRate, len);
    applyEdgeFades([L, R], sampleRate, plan.length);
    applyTremoloToSamples([L, R], sampleRate, params.tremolo); // studio output tremolo (bank renders in JS) / 스튜디오 출력 트레몰로
    const buf = ctx.createBuffer(2, len, sampleRate);
    buf.getChannelData(0).set(L);
    buf.getChannelData(1).set(R);
    if (!outputStage) return buf;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    src.start(0);
    return ctx.startRendering();
  }
  const master = ctx.createGain();
  scheduleEdgeFades(master.gain, 0, plan.length);
  connectStudioOutput(ctx, master, dest, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  if (plan.kind === 'osc') scheduleSpectralOsc(ctx, master, plan, 0, 0, null);
  else scheduleRidges(ctx, master, plan, 0, 0, null);
  return ctx.startRendering();
}

/**
 * What the rendered sound of a document depends on (physics signature + sound parameters).
 * View-only edits do not change it — the Manager uses it as its re-render key.
 * 렌더 결과를 결정하는 키 (물리 시그니처 + 음향 파라미터). 뷰 편집에는 변하지 않음 — 매니저의 재렌더 키.
 */
export function waveRenderKey(doc) {
  const p = resolveWaveDoc(doc);
  return `${waveSignature(p)}|${JSON.stringify(p.sonify)}|${JSON.stringify(p.timbre)}|${JSON.stringify(p.tremolo || null)}|${JSON.stringify(p.voiceMod || null)}`;
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportWaveWav({ download = true } = {}) {
  const params = getWaveParams();
  const buf = await renderWaveBuffer({ params });
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const peak = measurePeak(buf);
  const safe = String(params.preset || params.eq).replace(/[^A-Za-z0-9_-]+/g, '-');
  const filename = `Wave_${safe}_${params.sonify.mode}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, bytes: wav.byteLength, peak, durationSec: buf.length / buf.sampleRate, message: t('toast.wavDone', filename) };
}

/** Export the document, bake facts, ridge tracks and a decimated field as JSON. / JSON 내보내기 */
export function exportWaveJson({ download = true } = {}) {
  const payload = buildWaveExport();
  if (download) triggerDownload(new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'Wave_Baked_Data.json');
  return payload;
}

// ==========================================================================
// Self-checks (audio tier) / 자가진단 (오디오 계층)
// ==========================================================================

function correlation(x, y, n) {
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
  return sxy / Math.sqrt(Math.max(1e-30, sxx * syy));
}

const rmsOf = (d) => {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, d.length));
};

/** Result of the chunk-stream part of the last worklet self-check ('ok' | 'skipped' | null). */
let lastChunkCheck = null;
export const getWaveChunkCheck = () => lastChunkCheck;

registerSelfCheck('Wave: offline render = AudioWorklet output (correlation > 0.99, matrix and chunk stream)', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline || typeof AudioWorkletNode === 'undefined') { a.ok(true, 'AudioWorklet unavailable — skipped'); return; }
  const p = sanitizeWaveParams({ ...createDefaultWaveParams(), Nx: 32, length: 1, bakeRate: 50 });
  const plan = buildWavePlan(p, { bake: simulateWave(p), engine: 'worklet' });
  const fs = 48000;
  const len = 128 * 300;
  const want = await renderBank(plan, fs, len, { yieldEvery: 0 });
  a.ok(rmsOf(want.L) > 1e-3, 'signal present');
  // (1) whole matrix in processorOptions / 행렬 전체를 processorOptions로
  const ctx = new Offline(2, len, fs);
  a.ok(await ensureWaveWorklet(ctx), 'worklet module loaded');
  const node = createWaveNode(ctx, plan, { matrix: plan.amp.A });
  node.connect(ctx.destination);
  const got = await ctx.startRendering();
  for (const [ch, ref] of [[0, want.L], [1, want.R]]) {
    const d = got.getChannelData(ch);
    let maxErr = 0;
    for (let i = 0; i < len; i++) maxErr = Math.max(maxErr, Math.abs(d[i] - ref[i]));
    const corr = correlation(d, ref, len);
    a.ok(corr > 0.99 && maxErr < 1e-4, `channel ${ch}: correlation ${corr.toFixed(6)}, max |Δ| ${maxErr.toExponential(2)}`);
  }
  // (2) the live path: chunks through the port, wait for the worklet's 'loaded' ack, then render
  //     실시간 경로: 포트로 청크 전송 → 워클릿의 'loaded' 응답 대기 → 렌더
  const ctx2 = new Offline(2, len, fs);
  await ensureWaveWorklet(ctx2);
  const node2 = createWaveNode(ctx2, plan, {});
  node2.connect(ctx2.destination);
  const acked = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    node2.port.onmessage = (e) => { if (e.data?.type === 'loaded') { clearTimeout(timer); resolve(true); } };
  });
  postMatrix(node2, plan, 0);
  lastChunkCheck = 'skipped';
  if (await acked) {
    const got2 = (await ctx2.startRendering()).getChannelData(0);
    const corr = correlation(got2, want.L, len);
    a.ok(corr > 0.99, `chunk stream: correlation ${corr.toFixed(6)}`);
    lastChunkCheck = 'ok';
  }
}, { group: 'audio' });

registerSelfCheck('Wave: oscillator fallback and ridge mode render, peak ≤ 0 dBFS, 0 bakes while rendering', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  const p = sanitizeWaveParams({ ...createDefaultWaveParams(), Nx: 96, length: 1.5, bakeRate: 50 });
  const bake = simulateWave(p);
  const before = getWaveBakeCount();
  const opts = { params: p, bake, sampleRate: 24000, outputStage: false };
  const bank = await renderWaveBuffer({ ...opts, engine: 'worklet' });
  const osc = await renderWaveBuffer({ ...opts, engine: 'osc' });
  const q = sanitizeWaveParams({ ...p, sonify: { ...p.sonify, mode: 'ridge' } });
  const ridge = await renderWaveBuffer({ ...opts, params: q });
  const dense = sanitizeWaveParams({ ...createWavePreset('chord'), Nx: 96, length: 1.5, bakeRate: 50, sonify: { ...p.sonify, gain: 4 } });
  const loud = await renderWaveBuffer({ ...opts, params: dense, bake: simulateWave(dense), engine: 'worklet' });
  a.equal(getWaveBakeCount(), before, 'rendering never simulates');
  for (const [name, buf] of [['bank', bank], ['oscillators', osc], ['ridge', ridge], ['bank, gain ×4', loud]]) {
    const peak = measurePeak(buf);
    const rms = rmsOf(buf.getChannelData(0));
    a.ok(rms > 1e-3 && peak <= 1, `${name}: rms ${rms.toFixed(4)}, peak ${peak.toFixed(3)}`);
  }
  const ratio = rmsOf(osc.getChannelData(0)) / rmsOf(bank.getChannelData(0));
  a.ok(ratio > 0.5 && ratio < 2, `fallback level matches the bank (×${ratio.toFixed(2)})`);
  // Stereo: low bins left, high bins right at stereo = 1 / 스테레오: 낮은 빈은 왼쪽
  const wide = sanitizeWaveParams({ ...p, init: [{ kind: 'gauss', x: 0.1, width: 1.5, amp: 1, velocity: 0 }], boundary: 'absorbing', length: 0.4, sonify: { ...p.sonify, stereo: 1 } });
  const st = await renderWaveBuffer({ ...opts, params: wide, bake: simulateWave(wide), engine: 'worklet' });
  a.ok(rmsOf(st.getChannelData(0)) > 1.5 * rmsOf(st.getChannelData(1)), 'low pitches sit on the left');
}, { group: 'audio' });

/** Power of a sinusoid at f in d[i0, i1) (Goertzel). / 주파수 f의 파워 */
function tonePower(d, f, fs, i0 = 0, i1 = d.length) {
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = i0; i < i1; i++) { const s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / Math.max(1, i1 - i0);
}

registerSelfCheck('Wave: Manager render — tempo ×2 halves the clip at the same pitch, shape mask silences, view edits keep the key', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  // Gray–Scott seed: one stationary lump at the centre pitch (F#4 ≈ 370 Hz) for the first second.
  const doc = { ...createWavePreset('bloom'), Nx: 64, length: 1.2, bakeRate: 50 };
  const p = resolveWaveDoc(doc);
  const bake = simulateWave(p);
  const fs = 24000;
  const opts = { params: p, bake, sampleRate: fs, outputStage: false, engine: 'worklet' };
  const before = getWaveBakeCount();
  const one = await renderWaveBuffer(opts);
  const two = await renderWaveBuffer({ ...opts, timeScale: 2 });
  a.near(two.length / fs - 0.05, (one.length / fs - 0.05) / 2, 0.01, 'clip is half as long at ×2');
  // probe the exact bin frequencies around the centre, and one octave above them / 중심 빈 주파수와 그 한 옥타브 위
  const bins = waveBinFrequencies(bake);
  const mid = bake.N >> 1;
  const band = (buf, mul) => { let e = 0; for (let i = mid - 5; i <= mid + 5; i++) e += tonePower(buf.getChannelData(0), bins[i] * mul, fs, Math.round(0.05 * fs), Math.round(0.5 * fs)); return e; };
  const f0 = bins[mid];
  for (const [name, buf] of [['×1', one], ['×2', two]]) {
    const here = band(buf, 1);
    const octaveUp = band(buf, 2);
    a.ok(here > 30 * octaveUp && here > 1e-6, `${name}: energy stays at the document pitch (${(10 * Math.log10(here / Math.max(1e-30, octaveUp))).toFixed(0)} dB above the octave)`);
  }
  const ridge = resolveWaveDoc({ ...doc, sonify: { ...p.sonify, mode: 'ridge' } });
  const r2 = await renderWaveBuffer({ ...opts, params: ridge, timeScale: 2 });
  a.near(r2.length, two.length, 2, 'ridge mode is re-timed the same way');
  // Shape mask (sec, hz) → gain: silence everything / only the second half. / 도형 마스크
  const none = await renderWaveBuffer({ ...opts, ampMask: () => 0 });
  a.ok(rmsOf(none.getChannelData(0)) < 1e-6, 'mask 0 → silence');
  const half = await renderWaveBuffer({ ...opts, ampMask: (sec) => (sec < 0.6 ? 1 : 0) });
  const d = half.getChannelData(0);
  a.ok(rmsOf(d.subarray(Math.round(0.1 * fs), Math.round(0.5 * fs))) > 1e-3 && rmsOf(d.subarray(Math.round(0.7 * fs), Math.round(1.1 * fs))) < 1e-5, 'mask in time: first half sounds, second half is silent');
  const lowOnly = await renderWaveBuffer({ ...opts, ampMask: (sec, hz) => (hz < 0.5 * f0 ? 1 : 0) });
  a.ok(rmsOf(lowOnly.getChannelData(0)) < 0.05 * rmsOf(one.getChannelData(0)), 'mask in pitch: the lump above the band is removed');
  a.equal(getWaveBakeCount(), before, 'no bake while rendering');
  // Re-render key: sound edits change it, view edits do not. / 재렌더 키
  const k0 = waveRenderKey(doc);
  a.equal(waveRenderKey({ ...doc, view: { ...p.view, tMin: 3, color: 'energy' } }), k0, 'view edit keeps the key');
  a.ok(waveRenderKey({ ...doc, sonify: { ...p.sonify, gain: 2 } }) !== k0 && waveRenderKey({ ...doc, damping: 0.4 }) !== k0, 'sound / physics edits change it');
}, { group: 'audio' });
