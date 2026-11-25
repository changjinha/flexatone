/**
 * Flexatone — audio/output-bus.js
 * Audio tier: the end-of-chain output stage shared by every studio.
 * 오디오 계층: 모든 스튜디오가 공유하는 신호 흐름 마지막 출력 단계.
 *
 *   Glissando / Risset / Field / scrub → getOutputBus(ctx) = fader GainNode
 *     fader.gain ← setTargetAtTime(A, t, τ = smoothMs)  (native one-pole: no zipper noise)
 *     fader → destination
 *     fader → [AudioWorklet 'fx-loudness' (Blob)] → silent sink → destination  (analysis tap)
 *   Worklet: modules/loudness-model.js LoudnessAnalyzer (FFT 1024 / hop 512 / 24 Bark / masking /
 *   α = 0.23 Sone), posting ~30 frames/s. Loudness Lock (mode 'sone') steers the fader from it.
 *   Offline renders: createOfflineOutput(ctx) applies the same static gain, so WAV = what you hear.
 *
 * Imports: core/*, modules/*. Browser audio APIs only (no DOM).
 */

import { appState, normalizeOutputConfig } from '../core/state.js';
import { outputAmpFor, ampDb, loudnessLockStep } from '../modules/output-stage.js';
import { LoudnessAnalyzer, decodeLoudnessPacket } from '../modules/loudness-model.js';

export const LOUDNESS_PROCESSOR = 'fx-loudness';
export const METER_FPS = 30;

let bus = null; // { ctx, fader, out, limiter, meter, sink, status, connected }
let lockDb = 0;
let lastMode = null;
let lastStaticAmp = 1; // gain of the last amp / dB setting (Sone Lock starts from it)
let latest = null;
const listeners = new Set();

/**
 * Source of the AudioWorklet module: the self-contained analyzer class + a thin processor.
 * Shipped as a Blob URL (single-file friendly, no extra fetch). / 워클릿 소스 (Blob)
 */
export function buildLoudnessWorkletSource() {
  return `${LoudnessAnalyzer.toString()}
class FxLoudnessProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.an = new LoudnessAnalyzer(sampleRate, o);
    this.packet = new Float32Array(this.an.packetSize);
    this.postEvery = Math.max(1, Math.round(sampleRate / (o.fps || ${METER_FPS}) / 128));
    this.blocks = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'calib') this.an.setCalibration(d.fullScaleDbSpl);
    };
  }
  process(inputs) {
    const inp = inputs[0];
    if (inp && inp.length) this.an.push(inp[0], inp.length > 1 ? inp[1] : null, inp[0].length);
    else this.an.pushSilence(128);
    if (++this.blocks >= this.postEvery) {
      this.blocks = 0;
      this.an.writePacket(this.packet);
      this.port.postMessage(this.packet);
    }
    return true;
  }
}
registerProcessor('${LOUDNESS_PROCESSOR}', FxLoudnessProcessor);
`;
}

/** Current linear gain of the output stage (fader or Loudness Lock). / 현재 출력 게인 */
export function currentOutputAmp(cfg = appState.output) {
  return outputAmpFor(cfg, lockDb);
}

/** Loudness Lock gain in dB (runtime only). / 라우드니스 락 게인 */
export function getLockDb() {
  return lockDb;
}

/** 'off' | 'loading' | 'ready' | 'unsupported' | 'error' | 'idle' (no context yet). */
export function getLoudnessStatus() {
  if (!bus) return 'idle';
  if (!normalizeOutputConfig(appState.output).analyzer) return 'off';
  return bus.status;
}

/** Latest decoded analyzer frame or null. / 최신 분석 프레임 */
export function getLoudnessFrame() {
  return latest;
}

/** Subscribe to analyzer frames (~30/s). Returns an unsubscribe function. */
export function onLoudnessFrame(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function handlePacket(data) {
  const c = normalizeOutputConfig(appState.output);
  if (!c.analyzer) {
    latest = null;
    return;
  }
  latest = decodeLoudnessPacket(data);
  if (c.mode === 'sone' && bus) {
    lockDb = loudnessLockStep(lockDb, latest.totalSone, c);
    setFaderGain(c, 0.05);
  }
  for (const fn of listeners) {
    try { fn(latest); } catch (e) { console.error(e); }
  }
}

function setFaderGain(c, tauSec) {
  if (!bus) return;
  const now = bus.ctx.currentTime;
  const p = bus.fader.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(p.value, now);
  p.setTargetAtTime(currentOutputAmp(c), now, tauSec);
}

async function loadAnalyzer(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    bus.status = 'unsupported';
    return;
  }
  bus.status = 'loading';
  const url = URL.createObjectURL(new Blob([buildLoudnessWorkletSource()], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    const c = normalizeOutputConfig(appState.output);
    const meter = new AudioWorkletNode(ctx, LOUDNESS_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { fullScaleDbSpl: c.fullScaleDbSpl, fps: METER_FPS },
    });
    meter.port.onmessage = (e) => handlePacket(e.data);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    meter.connect(sink);
    sink.connect(ctx.destination);
    bus.meter = meter;
    bus.sink = sink;
    bus.status = 'ready';
    applyOutputConfig();
  } catch (e) {
    console.error('[output-bus] loudness worklet failed', e);
    bus.status = 'error';
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Limiter section between the fader and the destination: bypass path + (compressor → hard
 * ceiling clamp) path, switched by two gains. The compressor (ratio 20, knee 0, 2 ms attack)
 * brings peaks down smoothly, the 2×-oversampled clamp guarantees nothing exceeds the ceiling.
 * 페이더와 출력 사이 리미터: 바이패스 경로 + (컴프레서 → 하드 천장) 경로. 컴프레서가 부드럽게 줄이고, 클램프가 천장을 보장.
 * @returns {{ input: AudioNode, output: AudioNode, comp: DynamicsCompressorNode, set: (on: boolean, ceilDb: number) => void }}
 */
export function createLimiterSection(ctx, cfg = appState.output) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const bypass = ctx.createGain();
  const lim = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = 0;
  comp.ratio.value = 20;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const clamp = ctx.createWaveShaper();
  clamp.oversample = '2x';
  input.connect(bypass).connect(output);
  input.connect(comp).connect(clamp).connect(lim).connect(output);
  let lastCeil = null;
  const set = (on, ceilDb) => {
    const t = ctx.currentTime;
    bypass.gain.setTargetAtTime(on ? 0 : 1, t, 0.005);
    lim.gain.setTargetAtTime(on ? 1 : 0, t, 0.005);
    if (ceilDb !== lastCeil) {
      lastCeil = ceilDb;
      const c = Math.pow(10, ceilDb / 20);
      const N = 2049;
      const curve = new Float32Array(N);
      for (let i = 0; i < N; i++) curve[i] = Math.max(-c, Math.min(c, (i / (N - 1)) * 2 - 1));
      clamp.curve = curve;
      comp.threshold.value = ceilDb - 1.5;
    }
  };
  const c = normalizeOutputConfig(cfg);
  set(c.limiter, c.limiterCeilDb);
  return { input, output, comp, set };
}

/** Current gain reduction of the live limiter in dB (≤ 0), 0 when off. / 현재 리미터 게인 감소 */
export function getLimiterReductionDb() {
  if (!bus?.limiter || !normalizeOutputConfig(appState.output).limiter) return 0;
  return Math.min(0, bus.limiter.comp.reduction);
}

/** Build the output stage on a freshly created live context (called by ensureAudioCtx). */
export function attachOutputBus(ctx) {
  const fader = ctx.createGain();
  fader.gain.value = currentOutputAmp();
  const limiter = createLimiterSection(ctx);
  fader.connect(limiter.input);
  limiter.output.connect(ctx.destination);
  bus = { ctx, fader, out: limiter.output, limiter, meter: null, sink: null, status: 'loading', connected: false };
  latest = null;
  loadAnalyzer(ctx);
  return fader;
}

/** Post-limiter master output (what the speakers get), or null before the first live context. Tapped by the
 * studio video export (ui/studio-video.js). / 리미터 뒤 마스터 출력 (스튜디오 동영상 내보내기가 녹음) */
export function getMasterOutput() {
  return bus?.out || null;
}

/** Node every live studio connects to instead of ctx.destination. / 실시간 출력 입력 노드 */
export function getOutputBus(ctx) {
  return bus && bus.ctx === ctx ? bus.fader : ctx.destination;
}

/**
 * Analyser on the post-fader master output (everything you hear: editor + Manager), created on
 * first use. Used by the Manager's Master View. / 마스터 출력(페이더 후) 분석기 — 마스터 뷰용
 * @returns {AnalyserNode|null}
 */
export function getMasterTap() {
  if (!bus) return null;
  if (!bus.tap) {
    bus.tap = bus.ctx.createAnalyser();
    bus.tap.fftSize = 4096;
    bus.tap.smoothingTimeConstant = 0.72;
    bus.out.connect(bus.tap);
  }
  return bus.tap;
}

/** Offline equivalent: static output gain → destination. / 오프라인 출력 (정적 게인) */
export function createOfflineOutput(ctx, cfg = appState.output) {
  const g = ctx.createGain();
  g.gain.value = currentOutputAmp(cfg);
  const lim = createLimiterSection(ctx, cfg); // same limiter as live → WAV = what you hear / 실시간과 동일
  g.connect(lim.input);
  lim.output.connect(ctx.destination);
  return g;
}

/**
 * Push appState.output to the live graph: fader target (one-pole τ), analyzer on/off,
 * calibration. Cheap; call on every output-config change. / 출력 설정 반영
 */
export function applyOutputConfig(cfg = appState.output) {
  const c = normalizeOutputConfig(cfg);
  if (c.mode !== 'sone') lastStaticAmp = outputAmpFor(c);
  if (c.mode !== lastMode) {
    if (c.mode === 'sone') {
      // Lock starts from what you were hearing (amp or dB setting). / 직전 게인에서 시작
      const d = ampDb(lastStaticAmp);
      lockDb = Number.isFinite(d) ? Math.max(d, c.dbMin) : c.dbMin;
    }
    lastMode = c.mode;
  }
  if (!bus) return;
  setFaderGain(c, c.smoothMs / 1000);
  bus.limiter?.set(c.limiter, c.limiterCeilDb);
  if (bus.meter) {
    if (c.analyzer && !bus.connected) {
      bus.out.connect(bus.meter);
      bus.connected = true;
    } else if (!c.analyzer && bus.connected) {
      try { bus.out.disconnect(bus.meter); } catch { /* already disconnected */ }
      bus.connected = false;
      latest = null;
    }
    bus.meter.port.postMessage({ type: 'calib', fullScaleDbSpl: c.fullScaleDbSpl });
  }
}
