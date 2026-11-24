/**
 * Flexatone — studios/grid/grid-audio.js
 * Grid Studio — the AUDIO ENGINE tier: plays and renders the BAKED matrices only.
 * 그리드 스튜디오의 오디오 엔진 계층: 베이킹된 행렬만 재생·렌더링.
 *
 * Layer note / 계층 메모: this file lives in the studio folder but belongs to the audio tier — it
 * may import audio/*, and only ui/workspaces.js, audio/studio-clips.js and grid-panels.js import it.
 * The pure files (grid-studio.js, grid-engine.js, grid-effects.js, grid-bank.js) never import it.
 *
 * Two graphs, one transport / 그래프 2종, 트랜스포트 1개
 *   worklet     : AudioWorkletNode(Blob: GridBank, stereo) → master fade → studio tremolo → output bus.
 *                 One control matrix per layer is streamed through the port in chunks (transferred,
 *                 not copied), starting at the playhead; an edit while playing re-streams only the
 *                 layers whose matrix changed, the rest is one 'config' message.
 *   oscillators : fallback without AudioWorklet — the ≤ 96 strongest partials as oscillators with gain
 *                 curves read from the matrices (no noise; shown on the engine badge).
 * No effect is computed at playback: the matrices come from the stage cache in grid-engine.js.
 * 재생 중 효과 연산 없음: 행렬은 grid-engine.js의 단계 캐시에서 가져옴.
 */

import { clamp } from '../../core/math-utils.js';
import { t } from '../../core/i18n.js';
import { appState, subscribe, registerSelfCheck } from '../../core/state.js';
import { timbreSpecCoefficients, timbreSpecKey } from '../../modules/timbre-spec.js';
import { createTimbreWave, studioLiveOutput, connectStudioOutput, applyTremoloToSamples } from '../../audio/studio-fx.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { getAudioCtx, encodeWav, triggerDownload, measurePeak, EXPORT_SAMPLE_RATE, TRANSPORT_FADE_SEC } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { planVoices, layerBinMax, estimatePeak, gridSignature, peekGridBake, sanitizeGridParams, createDefaultGridParams, createGridPreset, createStackItem, encodeRaster, gridShape, bakeGrid, getGridBakeCount } from './grid-engine.js';
import { paintLine } from './grid-tools.js';
import { GridBank, GRID_PROCESSOR, buildGridWorkletSource } from './grid-bank.js';
import { getGridParams, getGridBake, resolveGridDoc, gridBakeReady, requestGridBake, onGridBake, gridBinFrequencies, buildGridExport } from '../grid-studio.js';

// Settings retrograde (audio/time-mirror.js, Manager Extend): loaded when present, so this studio does
// not depend on it. Without it a render is simply never mirrored.
// 설정 역행 모듈은 있으면 사용 (없어도 이 스튜디오는 동작) — 없으면 렌더가 뒤집히지 않을 뿐
let claimMirror = () => null;
import('../../audio/time-mirror.js').then((m) => { if (typeof m.claimMirror === 'function') claimMirror = m.claimMirror; }).catch(() => {});

const START_LEAD_SEC = 0.04;
const END_FADE_SEC = 0.03;
/** Rows per port message. / 포트 메시지당 행 수 */
export const CHUNK_FRAMES = 256;
/** Oscillator fallback: at most this many oscillators. / 폴백 오실레이터 상한 */
export const MAX_OSC_PARTIALS = 96;
/** Level of one full-amplitude line before the output gain (−14 dBFS). / 진폭 1인 선 하나의 레벨 */
export const GRID_LINE_LEVEL = 0.2;
/** Estimated peak the automatic headroom aims at (−1 dBFS). / 자동 헤드룸의 목표 피크 */
export const GRID_HEADROOM = 0.89;

const MIPS = GridBank.MIPS;
const TL = GridBank.TL;
const TL1 = TL + 1;

// --------------------------------------------------------------------------
// Single-cycle tables: per wave set 6 mip levels (≤ 32, 16, 8, 4, 2, 1 harmonics)
// 단일 주기 테이블: 파형 세트마다 밉 6단계
// --------------------------------------------------------------------------

/** Fourier coefficients (index = harmonic) of the synth waves of the chromatic channels. / 신스 파형 계수 */
function synthCoefficients(kind, harmonics) {
  const real = new Float32Array(32);
  const imag = new Float32Array(32);
  const K = kind === 'sine' ? 1 : clamp(Math.round(harmonics), 1, 8);
  for (let h = 1; h <= K; h++) {
    if (kind === 'sine') imag[h] = 1;
    else if (kind === 'tri') imag[h] = h % 2 ? ((h - 1) / 2) % 2 ? -1 / (h * h) : 1 / (h * h) : 0;
    else if (kind === 'saw') imag[h] = (h % 2 ? 1 : -1) / h;
    else if (kind === 'square') imag[h] = h % 2 ? 1 / h : 0;
    else real[h] = Math.sin(Math.PI * h * 0.25) / h; // pulse, 25 % duty / 펄스 (듀티 25 %)
  }
  return { real, imag };
}

function fillWaveSet(buf, set, real, imag) {
  let peak = 0;
  for (let m = 0; m < MIPS; m++) {
    const H = Math.min(real.length - 1, 32 >> m);
    const off = (set * MIPS + m) * TL1;
    for (let j = 0; j <= TL; j++) {
      let v = 0;
      const w = (2 * Math.PI * j) / TL;
      for (let h = 1; h <= H; h++) if (real[h] !== 0 || imag[h] !== 0) v += real[h] * Math.cos(h * w) + imag[h] * Math.sin(h * w);
      buf[off + j] = v;
      if (m === 0 && Math.abs(v) > peak) peak = Math.abs(v);
    }
  }
  // peak-normalised on the full table (like a PeriodicWave) / 전체 테이블 기준 피크 정규화
  const g = peak > 1e-9 ? 1 / peak : 1;
  for (let j = set * MIPS * TL1; j < (set + 1) * MIPS * TL1; j++) buf[j] *= g;
}

/** Wave sets of a voice list (deduplicated) → { buf, setOf: number[], key }. / 보이스 목록의 파형 세트 */
export function buildWaveSets(voices) {
  const keys = [];
  const setOf = voices.map((v) => {
    const k = v.wave.kind === 'layer' ? `layer:${timbreSpecKey(v.wave.timbre)}` : `${v.wave.kind}:${v.wave.kind === 'sine' ? 1 : v.wave.harmonics}`;
    let idx = keys.indexOf(k);
    if (idx < 0) { idx = keys.length; keys.push(k); }
    return idx;
  });
  const buf = new Float32Array(Math.max(1, keys.length) * MIPS * TL1);
  keys.forEach((k, s) => {
    const v = voices[setOf.indexOf(s)];
    const c = v.wave.kind === 'layer' ? timbreSpecCoefficients(v.wave.timbre, { voices: appState.voices, harmonics: 32 }) : synthCoefficients(v.wave.kind, v.wave.harmonics);
    fillWaveSet(buf, s, c.real, c.imag);
  });
  return { buf, setOf, key: keys.join('§'), count: keys.length };
}

// --------------------------------------------------------------------------
// Plan: everything a pass needs, from the caches / 패스에 필요한 모든 것 (캐시에서)
// --------------------------------------------------------------------------

/**
 * @param {object} params sanitised Grid document
 * @param {{ bake?: object, engine?: 'worklet'|'osc', timeScale?: number,
 *           ampMask?: ((sec: number, hz: number) => number)|null, pitchWarp?: ((sec: number, hz: number) => number)|null }} [o]
 *   timeScale = Tempo Manager rate (pitch-preserving: the matrices are read faster, the bins keep
 *   their frequencies); ampMask / pitchWarp = Manager shape regions and Warp tracks (real seconds).
 *   timeScale = 템포 매니저 배속 (음고 유지: 행렬을 빠르게 읽을 뿐, 빈 주파수는 그대로).
 */
export function buildGridPlan(params = getGridParams(), { bake = getGridBake(params), engine = 'worklet', timeScale = 1, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const rate = bake.dims.rate * timeScale;
  const dims = { ...bake.dims, rate, length: bake.dims.length / timeScale };
  const pv = planVoices(params, dims);
  const waves = buildWaveSets(pv.voices);
  const voices = pv.voices.map((v, k) => ({ layer: v.layer, ratio: v.ratio, gl: v.gl, gr: v.gr, off: v.offFrames, set: waves.setOf[k], n: v.n, bw: v.bandCents, layerId: v.layerId, wave: v.wave }));
  // Level: one full-amplitude line = GRID_LINE_LEVEL × output gain. Automatic headroom: when the
  // loudest moment of the piece is estimated above HEADROOM, the whole piece is turned down by one
  // static factor (no pumping; the soft clip stays a safety net, not a sound).
  // 레벨: 진폭 1인 선 = GRID_LINE_LEVEL × 출력 게인. 자동 헤드룸: 가장 큰 순간의 추정 피크가 HEADROOM을 넘으면 곡 전체를 한 계수로 낮춤.
  const wanted = GRID_LINE_LEVEL * Math.pow(10, params.render.gainDb / 20);
  const est = wanted * estimatePeak(bake, voices, pv.layers);
  const scale = est > GRID_HEADROOM ? (wanted * GRID_HEADROOM) / est : wanted;
  const layers = pv.layers.map((l) => ({ ...l, M: bake.mats.get(l.id).M, matKey: `${l.id}:${bake.mats.get(l.id).key}` }));
  const sound = JSON.stringify([voices.map((v) => [v.layer, v.ratio, v.gl, v.gr, v.off, v.set, v.n, v.bw]), layers.map((l) => [l.gl, l.gr, l.noise]), scale, params.render.maxActive]);
  return {
    kind: engine, params, bake, dims, length: dims.length, layers, voices, waves, scale, trimDb: 20 * Math.log10(scale / wanted), maxActive: params.render.maxActive, ampMask, pitchWarp, brightWarp,
    key: `${engine}|${bake.sig}|${timeScale}|${waves.key}|${sound}`,
    soundKey: sound,
    dimKey: `${dims.N}x${dims.F}@${rate}|${dims.pLo}|${dims.bps}|${params.render.seed}`,
  };
}

/**
 * Manager Warp on a matrix: every frame is resampled along the pitch axis so that the energy at bin
 * pitch m is heard at warp(m). Pitches bent outside the range are lost and the bend is quantised to
 * the bin spacing (the bins keep their frequencies). Returns a copy.
 * 매니저 곡률: 프레임마다 음고 축을 다시 샘플링. 범위 밖으로 휜 음고는 사라지고, 휘는 정도는 빈 간격으로 양자화됨.
 */
function warpMatrix(plan, A) {
  const { N, F, rate, pLo, bps } = plan.dims;
  const out = new Float32Array(A.length);
  const hz = gridBinFrequencies(plan.dims);
  const mapped = new Float64Array(N);
  for (let f = 0; f < F; f++) {
    const sec = f / rate;
    const row = f * N;
    for (let i = 0; i < N; i++) mapped[i] = (12 * Math.log2(Math.max(1e-6, plan.pitchWarp(sec, hz[i])) / 440) + 69 - pLo) * bps;
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

/** Matrices of a plan with the Manager warp / mask applied (copies; the cache stays clean). / 매니저 곡률·마스크 적용 행렬 */
function planMatrices(plan) {
  if (plan.mats) return plan.mats;
  const { N, F, rate } = plan.dims;
  const shaped = plan.ampMask || plan.brightWarp;
  const hz = shaped ? gridBinFrequencies(plan.dims) : null;
  // Warp "bright": a spectral tilt around the centre of the pitch range (the Wave Studio's law:
  // brightWarp dB per 24 semitones from the centre, ± 24 dB) / 밝기 = 음역 중심 기준 스펙트럼 기울기
  const centre = 0.5 * (plan.dims.pLo + plan.dims.pHi);
  plan.mats = plan.layers.map((l) => {
    let A = plan.pitchWarp ? warpMatrix(plan, l.M) : l.M;
    if (shaped) {
      const out = new Float32Array(A.length);
      for (let f = 0; f < F; f++) {
        const sec = f / rate;
        const row = f * N;
        for (let i = 0; i < N; i++) {
          let a = A[row + i];
          if (!(a > 0)) continue;
          if (plan.ampMask) a *= Math.max(0, plan.ampMask(sec, hz[i]));
          if (plan.brightWarp && a > 0) a *= Math.pow(10, clamp((plan.brightWarp(sec, hz[i]) * (plan.dims.pLo + i / plan.dims.bps - centre)) / 24, -24, 24) / 20);
          out[row + i] = a;
        }
      }
      A = out;
    }
    return A;
  });
  return plan.mats;
}

/** Candidate bins per layer: bins that are non-zero somewhere (ascending). / 레이어별 후보 빈 */
function planCandidates(plan) {
  if (plan.cands) return plan.cands;
  const { N, F } = plan.dims;
  const mats = planMatrices(plan);
  plan.cands = plan.layers.map((l, k) => {
    let mx = mats[k] === l.M ? layerBinMax(plan.bake, l.id) : null; // bake-level memo when nothing reshaped the matrix
    if (!mx) {
      mx = new Float32Array(N);
      for (let f = 0; f < F; f++) { const o = f * N; for (let i = 0; i < N; i++) if (mats[k][o + i] > mx[i]) mx[i] = mats[k][o + i]; }
    }
    const list = [];
    for (let i = 0; i < N; i++) if (mx[i] > 1e-6) list.push(i);
    return Int32Array.from(list);
  });
  return plan.cands;
}

function bankConfig(plan) {
  return {
    voices: plan.voices.map((v) => ({ layer: v.layer, ratio: v.ratio, gl: v.gl, gr: v.gr, off: v.off, set: v.set, n: v.n, bw: v.bw })),
    layers: plan.layers.map((l) => ({ gl: l.gl, gr: l.gr, noise: l.noise })),
    scale: plan.scale,
    maxActive: plan.maxActive,
  };
}

function makeBankOptions(plan) {
  return { bins: plan.dims.N, frames: plan.dims.F, frameRate: plan.dims.rate, nSets: plan.waves.count, freqs: Array.from(gridBinFrequencies(plan.dims)), seed: plan.params.render.seed, ...bankConfig(plan) };
}

/** The bank class on the main thread, loaded with a plan (offline render, self-checks). / 메인 스레드 뱅크 */
export function createPlanBank(plan, sampleRate, { dense = false, matrices = null } = {}) {
  const bank = new GridBank(sampleRate, makeBankOptions(plan));
  bank.setWaves(plan.waves.buf);
  const mats = matrices || planMatrices(plan);
  const cands = planCandidates(plan);
  const all = dense ? Int32Array.from({ length: plan.dims.N }, (_, i) => i) : null;
  mats.forEach((M, l) => { bank.setChunk(l, 0, M); bank.setCand(l, all || cands[l], false); });
  return bank;
}

// --------------------------------------------------------------------------
// AudioWorklet (Blob) + chunk streaming / 워클릿과 청크 스트리밍
// --------------------------------------------------------------------------

const workletState = new WeakMap(); // ctx → { promise, ready, failed }

/** Load the Grid worklet into ctx once (Blob URL, no fetch of a separate file). / 워클릿 로드 */
export function ensureGridWorklet(ctx) {
  let st = workletState.get(ctx);
  if (st) return st.promise;
  st = { ready: false, failed: false, promise: null };
  workletState.set(ctx, st);
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    st.failed = true;
    st.promise = Promise.resolve(false);
    return st.promise;
  }
  const url = URL.createObjectURL(new Blob([buildGridWorkletSource()], { type: 'text/javascript' }));
  st.promise = ctx.audioWorklet.addModule(url)
    .then(() => { st.ready = true; return true; })
    .catch((err) => { st.failed = true; console.warn('[Grid] AudioWorklet unavailable → oscillator fallback', err); return false; })
    .finally(() => URL.revokeObjectURL(url));
  return st.promise;
}

const pickEngine = (ctx) => (ctx && workletState.get(ctx)?.ready ? 'worklet' : 'osc');
const offlineEngine = (ctx) => (typeof AudioWorkletNode === 'undefined' || (ctx && workletState.get(ctx)?.failed) ? 'osc' : 'worklet');

function createGridNode(ctx, plan, { fromSec = 0, startTime = 0, matrices = null } = {}) {
  const cands = planCandidates(plan);
  return new AudioWorkletNode(ctx, GRID_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { ...makeBankOptions(plan), waves: plan.waves.buf.slice(), cands: cands.map((c) => c.slice()), fromFrame: fromSec * plan.dims.rate, startTime, ...(matrices ? { matrices } : {}) },
  });
}

let streamStats = { chunks: 0, bytes: 0, ms: 0 };
let streamId = 0;
/** Size and main-thread cost of the last matrix stream. / 마지막 행렬 스트림의 크기·비용 */
export const getGridStreamStats = () => ({ ...streamStats });

/**
 * Stream the matrices of the given layer slots to the worklet in chunks, the chunk under
 * `startFrame` first (so the part about to sound arrives first). Each chunk is a fresh copy whose
 * buffer is transferred. / 행렬을 청크로 스트리밍 (재생 위치의 청크부터, 버퍼는 transfer)
 */
function postMatrices(node, plan, startFrame = 0, slots = null) {
  const t0 = performance.now();
  const mats = planMatrices(plan);
  const cands = planCandidates(plan);
  const n = plan.dims.N;
  const frames = plan.dims.F;
  const total = Math.ceil(frames / CHUNK_FRAMES);
  const first = clamp(Math.floor(startFrame / CHUNK_FRAMES), 0, total - 1);
  const list = slots || mats.map((_, l) => l);
  const id = ++streamId;
  let bytes = 0;
  // the old candidates stay valid until the last chunk has arrived / 마지막 청크가 올 때까지 이전 후보 유지
  for (const l of list) node.port.postMessage({ type: 'cand', layer: l, list: cands[l].slice(), union: true });
  for (let q = 0; q < total; q++) {
    const c = (first + q) % total;
    const f0 = c * CHUNK_FRAMES;
    const f1 = Math.min(frames, f0 + CHUNK_FRAMES);
    list.forEach((l, k) => {
      const data = mats[l].slice(f0 * n, f1 * n);
      bytes += data.byteLength;
      node.port.postMessage({ type: 'chunk', layer: l, frame0: f0, data, last: q === total - 1 && k === list.length - 1, id }, [data.buffer]);
    });
  }
  for (const l of list) node.port.postMessage({ type: 'cand', layer: l, list: cands[l].slice(), union: false });
  streamStats = { chunks: total * list.length, bytes, ms: performance.now() - t0 };
  return id;
}

// --------------------------------------------------------------------------
// Oscillator fallback (live and offline) / 오실레이터 폴백
// --------------------------------------------------------------------------

const OSC_TYPE = { sine: 'sine', tri: 'triangle', saw: 'sawtooth', square: 'square', pulse: 'square' };

/**
 * Fallback without AudioWorklet: the ≤ MAX_OSC_PARTIALS strongest partials (voice × bin) as
 * oscillators with gain curves read from the matrices. No noise bus, no noise bands.
 * 워클릿 없는 폴백: 가장 센 부분음 ≤ 96개를 오실레이터로. 노이즈 없음.
 * @returns {number} oscillators scheduled
 */
export function scheduleGridOsc(ctx, dest, plan, nowTime, cueSec, nodeList) {
  const { N, F, rate } = plan.dims;
  const playDur = plan.length - cueSec;
  if (playDur <= 0.02) return 0;
  const mats = planMatrices(plan);
  const cands = planCandidates(plan);
  const hz = gridBinFrequencies(plan.dims);
  const picks = [];
  plan.voices.forEach((v, vi) => {
    const M = mats[v.layer];
    const mx = new Float32Array(N);
    for (let f = 0; f < F; f++) { const o = f * N; for (const i of cands[v.layer]) if (M[o + i] > mx[i]) mx[i] = M[o + i]; }
    for (const i of cands[v.layer]) picks.push({ vi, i, w: mx[i] * Math.max(v.gl, v.gr) });
  });
  picks.sort((a, b) => b.w - a.w);
  const master = ctx.createGain();
  master.gain.value = plan.scale;
  master.connect(dest);
  if (nodeList) nodeList.push(master);
  const samples = clamp(Math.ceil(playDur * Math.min(rate, 50)) + 1, 2, 6000);
  let made = 0;
  for (const pk of picks.slice(0, MAX_OSC_PARTIALS)) {
    const v = plan.voices[pk.vi];
    const freq = hz[pk.i] * v.ratio;
    if (!(pk.w > 1e-5) || freq >= 0.45 * ctx.sampleRate) continue;
    const M = mats[v.layer];
    const curve = new Float32Array(samples);
    for (let j = 0; j < samples; j++) {
      const pos = (cueSec + (j / (samples - 1)) * playDur) * rate + v.off;
      if (pos < 0 || pos > F - 1) continue;
      const f = Math.min(F - 2, Math.floor(pos));
      curve[j] = M[f * N + pk.i] + (M[(f + 1) * N + pk.i] - M[f * N + pk.i]) * (pos - f);
    }
    const osc = ctx.createOscillator();
    if (v.wave.kind === 'layer') osc.setPeriodicWave(createTimbreWave(ctx, v.wave.timbre));
    else osc.type = OSC_TYPE[v.wave.kind] || 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueCurveAtTime(curve, nowTime, playDur);
    const g = Math.hypot(v.gl, v.gr) / Math.SQRT2;
    const trim = ctx.createGain();
    trim.gain.value = g;
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (panner) { panner.pan.value = clamp((4 / Math.PI) * Math.atan2(v.gr, v.gl) - 1, -1, 1); panner.connect(master); }
    osc.connect(gain).connect(trim).connect(panner || master);
    osc.start(nowTime);
    osc.stop(nowTime + playDur + 0.02);
    if (nodeList) nodeList.push(osc, gain, trim, ...(panner ? [panner] : []));
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
let liveStat = { active: 0, count: 0, ms: 0 };
const statListeners = new Set();

/** Sounding partials / candidates of the live pass (from the worklet, ~3 times a second). / 실시간 활성 부분음 수 */
export const getGridLiveStat = () => ({ ...liveStat });
export function onGridLiveStat(fn) { statListeners.add(fn); return () => statListeners.delete(fn); }

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  wrapStart: true,
  cueDigits: 3,
  endSec: () => getGridParams().grid.length,
  beforeStart: async (ctx) => { await Promise.all([gridBakeReady(), ensureGridWorklet(ctx)]); },
  plan: (ctx) => {
    const params = getGridParams();
    const plan = buildGridPlan(params, { engine: pickEngine(ctx) }); // memoised: no stage runs unless the picture changed
    return { plan, endSec: plan.length };
  },
  fadeIn: (gain, { when, now, playDur }) => scheduleEdgeFades(gain, when, playDur, now),
  output: (ctx) => studioLiveOutput(ctx, 'grid', () => getGridParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { plan }, { when, fromSec, nodes }) => {
    let node = null;
    if (plan.kind === 'worklet') {
      node = createGridNode(ctx, plan, { fromSec, startTime: when });
      node.port.onmessage = (e) => {
        if (e.data?.type !== 'stat') return;
        liveStat = { active: e.data.active, count: e.data.count, ms: 0 };
        for (const fn of [...statListeners]) fn(liveStat);
      };
      node.connect(master);
      postMatrices(node, plan, fromSec * plan.dims.rate);
    } else {
      liveStat = { active: scheduleGridOsc(ctx, master, plan, when, fromSec, nodes), count: 0, ms: 0 };
    }
    lastEngine = plan.kind;
    return { kind: plan.kind, node, planKey: plan.key, soundKey: plan.soundKey, wavesKey: plan.waves.key, dimKey: plan.dimKey, layerKeys: plan.layers.map((l) => l.matKey) };
  },
  release: (pass) => {
    try { pass.node?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    try { pass.node?.disconnect(); } catch { /* ignore */ }
  },
  onClear: () => { if (restartTimer !== null) clearTimeout(restartTimer); restartTimer = null; },
});

export const isGridPlaying = transport.isPlaying;
export const getGridPlayheadSec = transport.playheadSec;
/** Play from the shared cue, or from `fromSec` without moving the cue. / 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 */
export const startGridAudio = transport.start;
export const stopGridAudio = transport.stop;
export const pauseGridAtPlayhead = transport.pauseAtPlayhead;
export const toggleGridPause = transport.togglePause;
export const toggleGridPlay = transport.togglePlay;

/** Engine of the live pass ('worklet' | 'osc'), or the last one used. / 현재 엔진 */
export const getGridEngineKind = () => transport.pass()?.kind ?? null;
export const lastGridEngine = () => lastEngine;

/**
 * Follow document edits while playing. Needs the full-resolution bake of the current document: while
 * it is still being computed the pass keeps playing the previous picture. With the same matrix shape
 * a worklet pass is updated in place (config message + only the changed layers re-streamed);
 * anything else restarts at the playhead, debounced.
 * 재생 중 편집 반영: 현재 문서의 전체 베이킹이 끝난 뒤, 행렬 모양이 같으면 제자리 갱신(바뀐 레이어만 재전송), 아니면 재시작.
 */
export function refreshGridLive() {
  const live = transport.pass();
  if (!live) return;
  const params = getGridParams();
  const bake = peekGridBake(params);
  if (!bake) { requestGridBake(params); return; }
  const ctx = getAudioCtx();
  const plan = buildGridPlan(params, { bake, engine: pickEngine(ctx) });
  if (plan.key === live.planKey) return;
  if (plan.kind === 'worklet' && live.kind === 'worklet' && plan.dimKey === live.dimKey && Math.abs(plan.length - live.endSec) < 1e-9) {
    const slots = [];
    plan.layers.forEach((l, k) => { if (live.layerKeys[k] !== l.matKey) slots.push(k); });
    if (plan.waves.key !== live.wavesKey) { const buf = plan.waves.buf.slice(); live.node.port.postMessage({ type: 'waves', buf }, [buf.buffer]); }
    live.node.port.postMessage({ type: 'config', ...bankConfig(plan) });
    if (slots.length) postMatrices(live.node, plan, transport.playheadSec() * plan.dims.rate, slots);
    Object.assign(live, { planKey: plan.key, soundKey: plan.soundKey, wavesKey: plan.waves.key, layerKeys: plan.layers.map((l) => l.matKey) });
    return;
  }
  if (restartTimer !== null) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (!transport.isPlaying()) return;
    await ensureGridWorklet(getAudioCtx());
    transport.restart();
  }, 90);
}

// Document edits reach the live pass through the state bus and through the bake notifications
// (not through the render loop, which the browser throttles in a background tab).
// 문서 편집은 상태 버스와 베이킹 완료 알림을 통해 실시간 패스에 전달
subscribe(() => { if (transport.isPlaying()) refreshGridLive(); }, { scopes: ['studio'] });
onGridBake(() => { if (transport.isPlaying()) refreshGridLive(); });

// --------------------------------------------------------------------------
// Offline render, WAV and JSON / 오프라인 렌더링, WAV, JSON
// --------------------------------------------------------------------------

let renderStats = { blockMs: 0, maxActive: 0, maxCount: 0, realtime: 0 };
/** Cost of the last offline bank render: ms per 128-sample block, most partials in a block. / 마지막 오프라인 렌더의 비용 */
export const getGridRenderStats = () => ({ ...renderStats });

/** Settings retrograde of a matrix (audio/time-mirror.js): frame j ← forward frame at H·rate − j. / 설정 역행 */
function mirrorMatrix(A, N, frames, rate, H) {
  const F = Math.max(2, Math.ceil(H * rate) + 1);
  const out = new Float32Array(F * N);
  for (let j = 0; j < F; j++) {
    const f = H * rate - j;
    if (f < 0 || f > frames - 1) continue;
    const k = Math.min(frames - 2, Math.floor(f));
    const x = f - k;
    const r0 = k * N;
    const r1 = Math.min(frames - 1, k + 1) * N;
    for (let i = 0; i < N; i++) out[j * N + i] = A[r0 + i] + (A[r1 + i] - A[r0 + i]) * x;
  }
  return { A: out, frames: F };
}

/** Render the bank on the main thread in 128-sample blocks (same class as the worklet). / 메인 스레드 뱅크 렌더 */
export async function renderBank(plan, fs, len, { yieldEvery = 400, mirrorH = null, dense = false } = {}) {
  let bank;
  if (mirrorH !== null) {
    const src = planMatrices(plan);
    const mir = src.map((M) => mirrorMatrix(M, plan.dims.N, plan.dims.F, plan.dims.rate, mirrorH));
    const p2 = { ...plan, dims: { ...plan.dims, F: mir[0]?.frames || plan.dims.F }, mats: mir.map((m) => m.A), cands: null, voices: plan.voices.map((v) => ({ ...v, off: -v.off })) };
    bank = createPlanBank(p2, fs, { dense });
  } else bank = createPlanBank(plan, fs, { dense });
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  const k = plan.dims.rate / fs;
  const t0 = performance.now();
  let maxActive = 0;
  let maxCount = 0;
  let work = 0;
  let blocks = 0;
  for (let s0 = 0, blk = 0; s0 < len; s0 += 128, blk++) {
    const n = Math.min(128, len - s0);
    const tb = performance.now();
    bank.process(bl, br, n, s0 * k, (s0 + n) * k);
    work += performance.now() - tb;
    blocks++;
    if (bank.lastActive > maxActive) maxActive = bank.lastActive;
    if (bank.lastCount > maxCount) maxCount = bank.lastCount;
    L.set(n < 128 ? bl.subarray(0, n) : bl, s0);
    R.set(n < 128 ? br.subarray(0, n) : br, s0);
    if (yieldEvery && blk % yieldEvery === yieldEvery - 1) await new Promise((r) => setTimeout(r)); // keep the UI alive
  }
  renderStats = { blockMs: work / Math.max(1, blocks), maxActive, maxCount, realtime: (len / fs) / Math.max(1e-6, (performance.now() - t0) / 1000) };
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
 * Render the whole piece offline with the engine, budget and settings the live pass uses (worklet →
 * the same bank class on the main thread; fallback → the same oscillator scheduler in an offline
 * context). outputStage applies the Loudness Manager fader + limiter (Export WAV = what you hear).
 * 실시간과 같은 엔진·예산으로 전체를 오프라인 렌더. outputStage = 출력 단계(페이더·리미터) 적용.
 * @returns {Promise<AudioBuffer|null>}
 */
export async function renderGridBuffer({ params = getGridParams(), bake = null, sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, engine = null, timeScale = 1, ampMask = null, pitchWarp = null, brightWarp = null, fades = true } = {}) {
  const b = bake || getGridBake(params);
  const plan = buildGridPlan(params, { bake: b, engine: engine || offlineEngine(getAudioCtx()), timeScale, ampMask, pitchWarp, brightWarp });
  if (plan.length <= 0.02 || !plan.voices.length) return null;
  // settings retrograde: the bank mirrors its own frames / 설정 역행: 뱅크는 프레임을 직접 뒤집음
  const mir = plan.kind === 'worklet' ? claimMirror() : null;
  const mirrorH = mir ? (mir.H ?? plan.length) : null;
  const playLen = mirrorH ?? plan.length;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const len = Math.ceil((playLen + 0.05) * sampleRate);
  const ctx = new Offline(2, len, sampleRate);
  const dest = outputStage ? createOfflineOutput(ctx) : ctx.destination;
  if (plan.kind === 'worklet') {
    const { L, R } = await renderBank(plan, sampleRate, len, { mirrorH });
    if (fades) applyEdgeFades([L, R], sampleRate, playLen);
    applyTremoloToSamples([L, R], sampleRate, params.tremolo); // studio output tremolo (the bank renders in JS) / 스튜디오 출력 트레몰로
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
  scheduleGridOsc(ctx, master, plan, 0, 0, null);
  return ctx.startRendering();
}

/**
 * What the rendered sound of a document depends on (matrix signature + sound parameters). View, tool
 * and selection-only edits do not change it — the Manager uses it as its re-render key.
 * 렌더 결과를 결정하는 키. 보기·도구 편집에는 변하지 않음 — 매니저의 재렌더 키.
 */
export function gridRenderKey(doc) {
  const p = resolveGridDoc(doc);
  const snd = p.layers.map((l) => [l.id, l.muted, l.solo, l.gain, l.pan, timbreSpecKey(l.timbre), l.stack.filter((it) => it.type === 'noise' || it.type === 'chroma').map((it) => [it.on, it.mix, it.params])]);
  return `${gridSignature(p)}|${JSON.stringify(snd)}|${p.render.maxActive}|${p.render.gainDb}|${JSON.stringify(p.tremolo || null)}`;
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportGridWav({ download = true } = {}) {
  const params = getGridParams();
  const buf = await renderGridBuffer({ params, bake: await gridBakeReady(params) });
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const peak = measurePeak(buf);
  const safe = String(params.preset || 'grid').replace(/[^A-Za-z0-9_-]+/g, '-');
  const filename = `Grid_${safe}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  if (download) triggerDownload(new Blob([wav], { type: 'audio/wav' }), filename);
  return { ok: true, filename, bytes: wav.byteLength, peak, durationSec: buf.length / buf.sampleRate, message: t('toast.wavDone', filename) };
}

/** Export the document, bake facts and ridge lines as JSON. / JSON 내보내기 */
export function exportGridJson({ download = true } = {}) {
  const payload = buildGridExport();
  if (download) triggerDownload(new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'Grid_Baked_Data.json');
  return payload;
}

// ==========================================================================
// Self-checks (audio tier) / 자가진단 (오디오 계층)
// ==========================================================================

/** A small document: `paint(ras, rows, cols, grid)` fills the raster, `stack` = stack items. / 작은 테스트 문서 */
export function tinyGridDoc({ grid = {}, render = {}, paint = null, stack = [], layer = {} } = {}) {
  const base = createDefaultGridParams();
  const g = sanitizeGridParams({ ...base, grid: { pLo: 60, pHi: 72, rowsPerSemi: 2, colsPerSec: 8, length: 1, ...grid }, layers: [] }).grid;
  const { rows, cols } = gridShape(g);
  const ras = new Float32Array(rows * cols);
  if (paint) paint(ras, rows, cols, g);
  return sanitizeGridParams({ ...base, preset: '', grid: g, render: { ...base.render, ...render }, layers: [{ ...base.layers[0], ...layer, raster: encodeRaster(ras, rows, cols), stack }], selection: null, view: null });
}

/** One held note at `midi` over the whole document. / 문서 전체에 걸친 지속음 하나 */
export const heldNote = (midi, value = 1) => (ras, rows, cols, g) => { paintLine(ras, rows, cols, 0, (midi - g.pLo) * g.rowsPerSemi + 0.5, cols, (midi - g.pLo) * g.rowsPerSemi + 0.5, value); };

function correlation(x, y, n) {
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
  return sxy / Math.sqrt(Math.max(1e-30, sxx * syy));
}

const rmsOf = (d, i0 = 0, i1 = d.length) => {
  let s = 0;
  for (let i = i0; i < i1; i++) s += d[i] * d[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

/** Power of a sinusoid at f in d[i0, i1) (Goertzel). / 주파수 f의 파워 */
function tonePower(d, f, fs, i0 = 0, i1 = d.length) {
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = i0; i < i1; i++) { const s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / Math.max(1, i1 - i0);
}

/** Frequency of the strongest sinusoid near f (Hann-weighted DFT scan + parabola), in cents from f. / f 근처 최강 정현파의 위치 (센트) */
function peakCents(d, f, fs, i0, i1) {
  const n = i1 - i0;
  const mag = (c) => {
    const w = (2 * Math.PI * f * Math.pow(2, c / 1200)) / fs;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); re += d[i0 + i] * h * Math.cos(w * i); im -= d[i0 + i] * h * Math.sin(w * i); }
    return Math.hypot(re, im);
  };
  let best = 0;
  let bm = -1;
  for (let c = -3; c <= 3; c += 0.25) { const m = mag(c); if (m > bm) { bm = m; best = c; } }
  const l = mag(best - 0.25);
  const r = mag(best + 0.25);
  const den = l - 2 * bm + r;
  return best + (den < 0 ? (0.125 * (l - r)) / den : 0);
}

/** In-place radix-2 FFT (re, im of length 2^k). / 제자리 FFT */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const a = re[i]; re[i] = re[j]; re[j] = a; const b = im[i]; im[i] = im[j]; im[j] = b; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/** Power per semitone band [pLo, pHi] and STFT frame (Hann, hop = win / 2). / 반음 대역별 STFT 파워 */
export function stftSemitoneBands(d, fs, pLo, pHi, win = 4096) {
  const hop = win / 2;
  const frames = Math.max(1, Math.floor((d.length - win) / hop) + 1);
  const bands = pHi - pLo + 1;
  const out = new Float32Array(frames * bands);
  const re = new Float64Array(win);
  const im = new Float64Array(win);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < win; i++) { re[i] = (d[f * hop + i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1))); im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < win / 2; k++) {
      const midi = 69 + 12 * Math.log2((k * fs) / win / 440);
      const b = Math.round(midi) - pLo;
      if (b >= 0 && b < bands) out[f * bands + b] += re[k] * re[k] + im[k] * im[k];
    }
  }
  return { out, frames, bands, hop };
}

/**
 * Correlation between the spectrogram of the offline render and the Result (the processed matrix
 * read with every voice's frequency ratio), both as √power per semitone band and STFT frame.
 * 오프라인 렌더의 스펙트로그램과 Result(처리된 행렬)의 상관 — 반음 대역·STFT 프레임별 √파워.
 */
export async function spectrogramCorrelation(params, { sampleRate = 24000, win = 4096 } = {}) {
  const bake = bakeGrid(params, { ns: 'detached' });
  const plan = buildGridPlan(params, { bake, engine: 'worklet' });
  const len = Math.ceil(plan.length * sampleRate);
  const { L, R } = await renderBank(plan, sampleRate, len, { yieldEvery: 0 });
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) mono[i] = 0.5 * (L[i] + R[i]);
  const pLo = plan.dims.pLo - 8;
  const pHi = plan.dims.pHi + 8;
  const S = stftSemitoneBands(mono, sampleRate, pLo, pHi, win);
  const want = new Float32Array(S.out.length);
  const { N, F, rate, bps } = plan.dims;
  for (const v of plan.voices) {
    const M = plan.layers[v.layer].M;
    const g2 = 0.25 * (v.gl + v.gr) ** 2;
    const shift = 12 * Math.log2(v.ratio);
    for (let f = 0; f < S.frames; f++) {
      const fa = Math.max(0, Math.round(((f * S.hop) / sampleRate) * rate + v.off));
      const fb = Math.min(F, Math.round(((f * S.hop + win) / sampleRate) * rate + v.off));
      for (let q = fa; q < fb; q++) {
        const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * (q - fa)) / Math.max(1, fb - fa - 1));
        for (let i = 0; i < N; i++) {
          const a = M[q * N + i];
          if (a <= 0) continue;
          const b = Math.round(plan.dims.pLo + i / bps + shift) - pLo;
          if (b >= 0 && b < S.bands) want[f * S.bands + b] += a * a * g2 * h * h;
        }
      }
    }
  }
  for (let j = 0; j < want.length; j++) { want[j] = Math.sqrt(want[j]); S.out[j] = Math.sqrt(S.out[j]); }
  return correlation(S.out, want, want.length);
}

registerSelfCheck('Grid: bank — self-contained, no allocation in process(), sparse = dense, phase-continuous sine, peak ≤ 0.98', async (a) => {
  const src = GridBank.toString();
  a.ok(!/\bimport\b|\bdocument\b|\bwindow\b|AudioContext/.test(src), 'no imports / DOM / Web Audio in the class');
  a.ok(!/\bnew\b|\[\s*\]|\.slice\(|\.map\(|\.concat\(|Array\(|\{\s*\}/.test(GridBank.prototype.process.toString()), 'process() source allocates nothing');
  const fs = 24000;
  const doc = tinyGridDoc({ grid: { length: 0.5 }, paint: (ras, rows, cols, g) => { heldNote(69)(ras, rows, cols, g); heldNote(64, 0.6)(ras, rows, cols, g); }, stack: [createStackItem('blur', { params: { mode: 'gaussian', sigmaCents: 30, shimmer: 0 } })] });
  const plan = buildGridPlan(doc, { bake: bakeGrid(doc, { ns: 'detached' }), engine: 'worklet' });
  const len = 128 * 60;
  const sparse = await renderBank(plan, fs, len, { yieldEvery: 0 });
  const dense = await renderBank(plan, fs, len, { yieldEvery: 0, dense: true });
  let worst = 0;
  for (let i = 0; i < len; i++) worst = Math.max(worst, Math.abs(sparse.L[i] - dense.L[i]), Math.abs(sparse.R[i] - dense.R[i]));
  a.ok(worst < 1e-6 && rmsOf(sparse.L) > 1e-3, `sparse = dense (max |Δ| ${worst.toExponential(2)})`);
  // buffers are reused across blocks / 버퍼 재사용
  const bank = createPlanBank(plan, fs);
  const keep = [bank.M[0], bank.inc, bank.ph, bank.a0, bank.a1, bank.wav, bank.hist, bank.cand[0], bank.nZ];
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  for (let blk = 0; blk < 20; blk++) bank.process(bl, br, 128, (blk * 128 * plan.dims.rate) / fs, ((blk + 1) * 128 * plan.dims.rate) / fs);
  a.ok(keep.every((arr, i) => arr === [bank.M[0], bank.inc, bank.ph, bank.a0, bank.a1, bank.wav, bank.hist, bank.cand[0], bank.nZ][i]), 'same array objects after 20 blocks');
  // a single held A4: one phase-continuous sine at 440 Hz / 지속음 A4 하나 = 위상 연속 사인
  const one = tinyGridDoc({ grid: { length: 0.5 }, render: { edgeMs: 0 }, paint: heldNote(69) });
  const p1 = buildGridPlan(one, { bake: bakeGrid(one, { ns: 'detached' }), engine: 'worklet' });
  const r1 = await renderBank(p1, fs, len, { yieldEvery: 0 });
  const i0 = 1000;
  const amp = Math.sqrt(2) * rmsOf(r1.L, i0, len);
  a.near(amp, GRID_LINE_LEVEL, 0.002, 'a full-amplitude line has the documented level');
  // least-squares fit of one 440 Hz sinusoid over 50 blocks: a phase step at a block border would leave a residual
  // 440 Hz 정현파 하나의 최소제곱 근사: 블록 경계에 위상 단차가 있으면 잔차가 남음
  let ss = 0;
  let sc = 0;
  const w440 = (2 * Math.PI * 440) / fs;
  for (let i = i0; i < len; i++) { ss += r1.L[i] * Math.sin(w440 * i); sc += r1.L[i] * Math.cos(w440 * i); }
  const fa = (2 * ss) / (len - i0);
  const fb = (2 * sc) / (len - i0);
  let err = 0;
  for (let i = i0; i < len; i++) err = Math.max(err, Math.abs(r1.L[i] - fa * Math.sin(w440 * i) - fb * Math.cos(w440 * i)));
  a.ok(err < 2e-3, `phase-continuous across blocks (max residual ${err.toExponential(2)})`);
  // overload: many full lines stay below the soft-clip ceiling / 과부하에서도 소프트 클립 상한 이하
  const loud = tinyGridDoc({ grid: { length: 0.3 }, render: { gainDb: 12 }, paint: (ras, rows, cols) => { for (let r = 0; r < rows; r++) paintLine(ras, rows, cols, 0, r + 0.5, cols, r + 0.5, 1); } });
  const pl = buildGridPlan(loud, { bake: bakeGrid(loud, { ns: 'detached' }), engine: 'worklet' });
  a.ok(pl.trimDb < -6, `automatic headroom turns an overloaded piece down (${pl.trimDb.toFixed(1)} dB)`);
  const rl = await renderBank(pl, fs, 128 * 40, { yieldEvery: 0 });
  let peak = 0;
  for (let i = 0; i < rl.L.length; i++) peak = Math.max(peak, Math.abs(rl.L[i]), Math.abs(rl.R[i]));
  a.ok(peak <= GRID_HEADROOM + 0.05 && peak > 0.2, `headroom: peak ${peak.toFixed(3)}`);
  const hot = createPlanBank(pl, fs);
  hot.configure({ scale: 4 }); // force the overload: the soft clip is the safety net / 강제 과부하: 소프트 클립이 안전망
  peak = 0;
  for (let blk = 0; blk < 30; blk++) { hot.process(bl, br, 128, (blk * 128 * pl.dims.rate) / fs, ((blk + 1) * 128 * pl.dims.rate) / fs); for (let i = 0; i < 128; i++) peak = Math.max(peak, Math.abs(bl[i]), Math.abs(br[i])); }
  a.ok(peak <= 0.98 && peak > 0.9, `soft clip: peak ${peak.toFixed(4)} ≤ 0.98`);
  // budget: the weakest partials are the ones cut / 예산 컷은 약한 것부터
  const two = tinyGridDoc({ grid: { length: 0.3 }, render: { maxActive: 16, edgeMs: 0 }, paint: (ras, rows, cols) => { for (let r = 0; r < rows; r++) paintLine(ras, rows, cols, 0, r + 0.5, cols, r + 0.5, r < 4 ? 1 : 0.1); } });
  const pb = buildGridPlan(two, { bake: bakeGrid(two, { ns: 'detached' }), engine: 'worklet' });
  const bb = createPlanBank(pb, fs);
  for (let blk = 0; blk < 12; blk++) bb.process(bl, br, 128, (blk * 128 * pb.dims.rate) / fs, ((blk + 1) * 128 * pb.dims.rate) / fs);
  a.ok(bb.lastCount > 16 && bb.lastActive <= 16 && bb.lastActive >= 4, `${bb.lastCount} partials wanted, ${bb.lastActive} kept (budget 16)`);
  const strong = [0, 1, 2, 3].every((r) => bb.a0[(r * pb.dims.bps) / 2] > 0.9);
  a.ok(strong, 'the four strong lines survive the cut');
  // candidate merge (union) keeps an ascending, duplicate-free list / 후보 병합
  const m = createPlanBank(pb, fs);
  m.setCand(0, Int32Array.from([2, 5, 9]), false);
  m.setCand(0, Int32Array.from([1, 5, 12]), true);
  a.equal(Array.from(m.cand[0].subarray(0, m.nc[0])).join(), '1,2,5,9,12', 'union of candidate lists');
}, { group: 'audio' });

registerSelfCheck('Grid: offline render = AudioWorklet output (correlation > 0.99, options and chunk stream)', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline || typeof AudioWorkletNode === 'undefined') { a.ok(true, 'AudioWorklet unavailable — skipped'); return; }
  const doc = tinyGridDoc({ grid: { length: 0.75 }, paint: (ras, rows, cols, g) => { heldNote(64)(ras, rows, cols, g); paintLine(ras, rows, cols, 0, 4, cols, rows - 3, 0.8); }, stack: [createStackItem('chroma', { params: {} })] });
  const plan = buildGridPlan(doc, { bake: bakeGrid(doc, { ns: 'detached' }), engine: 'worklet' });
  const fs = 48000;
  const len = 128 * 280;
  const want = await renderBank(plan, fs, len, { yieldEvery: 0 });
  a.ok(rmsOf(want.L) > 1e-3, 'signal present');
  const ctx = new Offline(2, len, fs);
  a.ok(await ensureGridWorklet(ctx), 'worklet module loaded');
  const node = createGridNode(ctx, plan, { matrices: plan.layers.map((l) => l.M) });
  node.connect(ctx.destination);
  const got = await ctx.startRendering();
  for (const [ch, ref] of [[0, want.L], [1, want.R]]) {
    const d = got.getChannelData(ch);
    let maxErr = 0;
    for (let i = 0; i < len; i++) maxErr = Math.max(maxErr, Math.abs(d[i] - ref[i]));
    const corr = correlation(d, ref, len);
    a.ok(corr > 0.99 && maxErr < 1e-4, `channel ${ch}: correlation ${corr.toFixed(6)}, max |Δ| ${maxErr.toExponential(2)}`);
  }
  // the live path: chunks through the port, wait for the 'loaded' ack, then render / 실시간 경로 (청크 → ack → 렌더)
  const ctx2 = new Offline(2, len, fs);
  await ensureGridWorklet(ctx2);
  const node2 = createGridNode(ctx2, plan, {});
  node2.connect(ctx2.destination);
  const acked = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    node2.port.onmessage = (e) => { if (e.data?.type === 'loaded') { clearTimeout(timer); resolve(true); } };
  });
  postMatrices(node2, plan, 0);
  if (await acked) {
    const got2 = (await ctx2.startRendering()).getChannelData(0);
    const corr = correlation(got2, want.L, len);
    a.ok(corr > 0.99, `chunk stream: correlation ${corr.toFixed(6)}`);
  }
}, { group: 'audio' });

registerSelfCheck('Grid: Chromatic — channel peaks at f·ratio within 0.1 cent, time offset, pan L² + R² = const, channel off = silent', async (a) => {
  const fs = 24000;
  const len = fs; // 1 s
  const f0 = 440;
  const mk = (over) => tinyGridDoc({ grid: { length: 1.1 }, render: { edgeMs: 0 }, paint: heldNote(69), stack: [createStackItem('chroma', { params: { link: false, rOn: false, gOn: false, bOn: false, rP: 2, rQ: 3, bP: 3, bQ: 2, ...over } })] });
  const render = async (doc) => { const plan = buildGridPlan(doc, { bake: bakeGrid(doc, { ns: 'detached' }), engine: 'worklet' }); return { plan, ...(await renderBank(plan, fs, len, { yieldEvery: 0 })) }; };
  for (const [name, over, ratio] of [['R 2:3', { rOn: true, rPan: 0, rTimeMs: 0, rGain: 1 }, 2 / 3], ['G 1:1', { gOn: true }, 1], ['B 3:2', { bOn: true, bPan: 0, bTimeMs: 0, bGain: 1 }, 3 / 2]]) {
    const r = await render(mk(over));
    const c = peakCents(r.L, f0 * ratio, fs, 2000, len - 100);
    a.ok(Math.abs(c) < 0.1, `${name}: peak ${c.toFixed(4)} cents from f·${ratio.toFixed(4)}`);
    const table = r.plan.voices[0].ratio;
    a.ok(Math.abs(table / ratio - 1) < 1e-9, `${name}: frequency table ratio exact (${(table / ratio - 1).toExponential(1)})`);
  }
  // a custom ratio with a cents trim / 센트 보정이 있는 임의 비율
  const cust = await render(mk({ gOn: true, gP: 7, gQ: 4, gCents: 3 }));
  a.ok(Math.abs(peakCents(cust.L, f0 * (7 / 4) * Math.pow(2, 3 / 1200), fs, 2000, len - 100)) < 0.1, '7:4 + 3 cents');
  // pan: equal power / 팬: 등전력
  let ref = 0;
  for (const pan of [-1, -0.5, 0, 0.5, 1]) {
    const r = await render(mk({ gOn: true, gPan: pan }));
    const p = rmsOf(r.L, 2000) ** 2 + rmsOf(r.R, 2000) ** 2;
    if (!ref) ref = p;
    a.ok(Math.abs(p / ref - 1) < 1e-3, `pan ${pan}: L² + R² constant (${(p / ref).toFixed(5)})`);
    if (pan === -1) a.ok(rmsOf(r.R, 2000) < 1e-6, 'hard left: right channel silent');
  }
  // time offset: the channel starts timeMs later / 시간 오프셋
  const late = tinyGridDoc({ grid: { length: 1.1 }, render: { edgeMs: 0 }, paint: (ras, rows, cols, g) => paintLine(ras, rows, cols, 4, (69 - g.pLo) * g.rowsPerSemi + 0.5, cols, (69 - g.pLo) * g.rowsPerSemi + 0.5, 1), stack: [createStackItem('chroma', { params: { link: false, rOn: false, bOn: false, gOn: true, gTimeMs: 100 } })] });
  const rl = await render(late);
  const onset = (d) => { for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 0.01) return i / fs; return -1; };
  a.near(onset(rl.L), 0.5 + 0.1, 0.012, 'onset moved by +100 ms');
  // all channels off = silence / 모든 채널 끔 = 무음
  const off = mk({});
  const po = buildGridPlan(off, { bake: bakeGrid(off, { ns: 'detached' }), engine: 'worklet' });
  a.equal(po.voices.length, 0, 'no channel on → no bank');
  const two = await render(mk({ gOn: true, bOn: true, bGain: 1, bPan: 0 }));
  const one = await render(mk({ gOn: true }));
  a.ok(tonePower(two.L, 660, fs, 2000) > 1e-4 && tonePower(one.L, 660, fs, 2000) < 1e-3 * tonePower(two.L, 660, fs, 2000), 'B off → nothing at 660 Hz');
}, { group: 'audio' });

registerSelfCheck('Grid: Noise — slope white 0 / pink −3 / brown −6 dB/oct, level, follow band, seed', async (a) => {
  const fs = 48000;
  const len = fs * 2;
  const mk = (params, paint = null) => tinyGridDoc({ grid: { length: 2.1 }, paint, stack: [createStackItem('noise', { params: { levelDb: -12, slope: 0, follow: 0, grain: 0, ...params } })] });
  const render = async (doc) => { const plan = buildGridPlan(doc, { bake: bakeGrid(doc, { ns: 'detached' }), engine: 'worklet' }); return renderBank(plan, fs, len, { yieldEvery: 0 }); };
  const octaveDb = (d) => {
    // mean FFT power in octave bands 125 … 8000 Hz, per Hz → fitted slope (dB / octave) / 옥타브 대역 파워 밀도의 기울기
    const win = 8192;
    const acc = new Float64Array(win / 2);
    const re = new Float64Array(win);
    const im = new Float64Array(win);
    let nf = 0;
    for (let s = 0; s + win <= d.length; s += win) {
      for (let i = 0; i < win; i++) { re[i] = d[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1))); im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < win / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
      nf++;
    }
    const xs = [];
    const ys = [];
    for (let fc = 125; fc <= 8000; fc *= 2) {
      let p = 0;
      let n = 0;
      for (let k = Math.ceil((fc / Math.SQRT2) * win / fs); k < (fc * Math.SQRT2 * win) / fs; k++) { p += acc[k] / nf; n++; }
      xs.push(Math.log2(fc));
      ys.push(10 * Math.log10(p / n));
    }
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    return sxy / sxx;
  };
  for (const [name, slope] of [['white', 0], ['pink', -3], ['brown', -6], ['blue', 3]]) {
    const r = await render(mk({ slope }));
    const got = octaveDb(r.L);
    a.near(got, slope, 0.7, `${name}: measured slope (dB/oct)`);
    const lvl = 20 * Math.log10(rmsOf(r.L, 4000) / GRID_LINE_LEVEL);
    a.near(lvl, -12, 1, `${name}: level re a full-scale line (dB)`);
  }
  const s1 = await render(mk({ seed: 3 }));
  const s2 = await render(mk({ seed: 3 }));
  const s3 = await render(mk({ seed: 4 }));
  let same = true;
  let differs = false;
  for (let i = 0; i < 4000; i++) { if (s1.L[i] !== s2.L[i]) same = false; if (s1.L[i] !== s3.L[i]) differs = true; }
  a.ok(same && differs, 'same seed → identical noise, other seed → different');
  // follow = 1: the noise sits around the painted pitch only / follow = 1: 칠한 음고 주변에만
  const fol = await render(mk({ levelDb: 0, follow: 1, bandCents: 60 }, heldNote(69)));
  const band = (d, lo, hi) => { let p = 0; for (let f = lo; f <= hi; f += 4) p += tonePower(d, f, fs, 4000, 4000 + 16384); return p / ((hi - lo) / 4 + 1); };
  const near = band(fol.L, 428, 452);
  const far = band(fol.L, 800, 1600);
  a.ok(10 * Math.log10(near / Math.max(1e-30, far)) >= 10, `band around the painted pitch ${(10 * Math.log10(near / Math.max(1e-30, far))).toFixed(1)} dB above the rest`);
  const carrier = tonePower(fol.L, 440, fs, 4000, 4000 + 16384);
  const tone = await render(tinyGridDoc({ grid: { length: 2.1 }, paint: heldNote(69) }));
  a.ok(carrier < 0.05 * tonePower(tone.L, 440, fs, 4000, 4000 + 16384), 'follow 1 at 0 dB: the tone itself is gone (noise band only)');
  a.near(rmsOf(fol.L, 4000) / rmsOf(tone.L, 4000), 1, 0.25, 'the noisy tone keeps the power of the tone');
}, { group: 'audio' });

registerSelfCheck('Grid: spectrogram of the render ≈ Result (Chorus Cloud / Wavy / Fifth Shimmer, correlation > 0.8)', async (a) => {
  // the picture of the presets on a short, high grid (C5 – C7), so the STFT resolves semitones
  // 프리셋의 효과 스택을 짧고 높은 격자(C5 – C7)에 적용 — STFT가 반음을 분해할 수 있도록
  const paint = (ras, rows, cols, g) => {
    const row = (m) => (m - g.pLo) * g.rowsPerSemi + 0.5;
    paintLine(ras, rows, cols, 1, row(76), cols * 0.6, row(76), 1);
    paintLine(ras, rows, cols, cols * 0.2, row(84), cols - 1, row(84), 0.8);
    paintLine(ras, rows, cols, cols * 0.3, row(88), cols * 0.9, row(93), 0.9);
  };
  for (const id of ['chorusCloud', 'wavy', 'fifthShimmer']) {
    const pre = createGridPreset(id);
    const doc = tinyGridDoc({ grid: { pLo: 72, pHi: 96, length: 3 }, paint, stack: pre.layers[0].stack.map((it) => (it.type === 'liquify' ? { ...it, params: { ...it.params, ops: [{ tool: 'push', size: 8, strength: 0.9, pts: [[8, 24], [8, 30]] }, { tool: 'push', size: 8, strength: 0.9, pts: [[16, 30], [16, 22]] }] } } : it)) });
    const corr = await spectrogramCorrelation(doc);
    a.ok(corr > 0.8, `${id}: correlation ${corr.toFixed(3)}`);
  }
}, { group: 'audio' });

registerSelfCheck('Grid: Manager render — tempo ×2 halves the clip at the same pitch, shape mask and warp act, view edits keep the key, 0 bakes while playing', async (a) => {
  const doc = tinyGridDoc({ grid: { length: 1.2 }, paint: heldNote(69) });
  const fs = 24000;
  const bake = bakeGrid(doc, { ns: 'detached' });
  const opts = { params: doc, bake, sampleRate: fs, outputStage: false, engine: 'worklet' };
  const count = getGridBakeCount();
  const one = await renderGridBuffer(opts);
  const two = await renderGridBuffer({ ...opts, timeScale: 2 });
  a.near(two.length / fs - 0.05, (one.length / fs - 0.05) / 2, 0.01, 'clip is half as long at ×2');
  for (const [name, buf] of [['×1', one], ['×2', two]]) {
    const d = buf.getChannelData(0);
    const i1 = Math.min(d.length, Math.round(0.5 * fs));
    a.ok(tonePower(d, 440, fs, 1200, i1) > 100 * tonePower(d, 880, fs, 1200, i1), `${name}: energy stays at 440 Hz`);
  }
  const none = await renderGridBuffer({ ...opts, ampMask: () => 0 });
  a.ok(rmsOf(none.getChannelData(0)) < 1e-6, 'mask 0 → silence');
  const half = await renderGridBuffer({ ...opts, ampMask: (sec) => (sec < 0.6 ? 1 : 0) });
  const d = half.getChannelData(0);
  a.ok(rmsOf(d, Math.round(0.1 * fs), Math.round(0.5 * fs)) > 1e-3 && rmsOf(d, Math.round(0.7 * fs), Math.round(1.1 * fs)) < 1e-5, 'mask in time: first half sounds, second half is silent');
  const up = await renderGridBuffer({ ...opts, pitchWarp: (sec, hz) => hz * Math.pow(2, 2 / 12) });
  const du = up.getChannelData(0);
  a.ok(tonePower(du, 440 * Math.pow(2, 2 / 12), fs, 1200, 12000) > 30 * tonePower(du, 440, fs, 1200, 12000), 'warp +2 st moves the line');
  a.equal(getGridBakeCount(), count, 'rendering never bakes the editor document');
  const k0 = gridRenderKey(doc);
  a.equal(gridRenderKey(sanitizeGridParams({ ...doc, view: { ...doc.view, tMin: 0.3, colorR: 'gray' }, tool: { ...doc.tool, size: 9 } })), k0, 'view / tool edits keep the key');
  a.ok(gridRenderKey(sanitizeGridParams({ ...doc, layers: [{ ...doc.layers[0], gain: 0.5 }] })) !== k0, 'a sound edit changes it');
  a.ok(gridRenderKey(tinyGridDoc({ grid: { length: 1.2 }, paint: heldNote(70) })) !== k0, 'a picture edit changes it');
}, { group: 'audio' });
