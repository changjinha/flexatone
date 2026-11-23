/**
 * Flexatone — studios/risset/risset-audio.js
 * Risset Studio audio tier (added file): runtime clock, live 2–60 voice engine with the PEQ chain,
 * and offline 48 kHz WAV rendering. Only ui/workspaces.js / risset-panels.js import it.
 * 리세 스튜디오 오디오 계층 (추가 파일): 런타임 시계, 실시간 2–60 보이스 엔진(PEQ 체인),
 * 오프라인 48 kHz WAV.
 *
 * Engines / 엔진 (params.engineMode: 'auto' | 'oscillators')
 *   worklet     : AudioWorkletNode(Blob: RissetVoiceBank) → EQ biquads → transport fade → output bus
 *                 sample-accurate S¹ phase per slot, control frames (p, ω, g) via port, gains
 *                 interpolated per block, envelope evaluated per sample (risset-voicebank.js)
 *   oscillators : fallback when AudioWorklet is unavailable or still loading —
 *                 S × Oscillator(sine) → Gain(A·W(f)) → master (masterGain·1/√N·0.65) → EQ → fade
 *   offline WAV : the same RissetVoiceBank on the main thread, control frame every 64 samples
 * A slot = one sounding point (classic field: slot i = voice i; region modules / rotation: every
 * crossing of the green line, see space-regions.js).
 * The runtime (master phase, automation clock, local particles) advances once per animation
 * frame while the workspace is mounted — also when silent, so the canvases animate.
 */

import { clamp } from '../../core/math-utils.js';
import { freqToMidi } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { setTransport, registerSelfCheck } from '../../core/state.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { ensureAudioCtx, getAudioCtx, encodeWav, triggerDownload, TRANSPORT_FADE_SEC } from '../../audio/audio-engine.js';
import { getRissetParams } from '../risset-studio.js';
import { runtimeStepScale } from '../../modules/tempo-manager.js';
import { createRissetRuntime, stepRuntime, phaseToFreq, outputScale, createDefaultRissetParams, sanitizeRissetParams, cloneRuntime, buildControlFrame, weightOf, createBakedRuntime, MAX_SLOTS } from './risset-core.js';
import { RissetVoiceBank, buildRissetWorkletSource, RISSET_PROCESSOR } from './risset-voicebank.js';
import { sanitizeEqNode } from './peq-envelope.js';
import { createTremoloNode } from '../../audio/tremolo-node.js';

const runtimeBox = { rt: null, scrubbing: false };
let live = null; // { master, eq: BiquadFilterNode[], out, voices: [{ osc, gain }] }
let loopId = null;
let lastTs = 0;
let frameListener = null;

/** Shared runtime (created lazily). / 공유 런타임 */
export function getRissetRuntime() {
  if (!runtimeBox.rt) runtimeBox.rt = createRissetRuntime(getRissetParams());
  return runtimeBox.rt;
}

/** Drop the editor runtime (used when the Manager focuses another Risset instance). / 런타임 초기화 */
export function resetRissetRuntime() {
  runtimeBox.rt = null;
}

export function setPhaseScrubbing(on) {
  runtimeBox.scrubbing = !!on;
}

export function resetRissetPhase() {
  const rt = getRissetRuntime();
  rt.masterPhase = 0;
  rt.autoTimeSec = 0;
  rt.shapeTimeSec = 0;
  rt.regionStates = {};
}

export function isRissetPlaying() {
  return !!live;
}

function frame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - lastTs) / 1000));
  lastTs = now;
  const params = getRissetParams();
  const rt = getRissetRuntime();
  stepRuntime(params, rt, dt, { running: !!live, scrubbing: runtimeBox.scrubbing });
  if (live) updateLive(params, rt, live);
  frameListener?.(rt);
  loopId = requestAnimationFrame(frame);
}

/** Run the runtime clock while the workspace is mounted. / 작업 공간이 열려 있는 동안 런타임 실행 */
export function startRissetLoop(onFrame) {
  frameListener = onFrame;
  if (loopId !== null) return;
  lastTs = performance.now();
  loopId = requestAnimationFrame(frame);
}

export function stopRissetLoop() {
  if (loopId !== null) cancelAnimationFrame(loopId);
  loopId = null;
  frameListener = null;
}

function buildEq(ctx, nodes, input, output) {
  const eq = [];
  let prev = input;
  for (const b of nodes) {
    const n = sanitizeEqNode(b);
    const biq = ctx.createBiquadFilter();
    biq.type = 'peaking';
    biq.frequency.value = n.freq;
    biq.gain.value = n.gain;
    biq.Q.value = n.q;
    prev.connect(biq);
    prev = biq;
    eq.push(biq);
  }
  prev.connect(output);
  return eq;
}

function syncEq(ctx, params, live) {
  const nodes = params.eqNodes;
  if (live.eq.length !== nodes.length) {
    try { live.master.disconnect(); } catch { /* ignore */ }
    live.eq.forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } });
    live.eq = buildEq(ctx, nodes, live.master, live.out);
    return;
  }
  const now = ctx.currentTime;
  nodes.forEach((b, i) => {
    const n = sanitizeEqNode(b);
    live.eq[i].frequency.setTargetAtTime(n.freq, now, 0.02);
    live.eq[i].gain.setTargetAtTime(n.gain, now, 0.02);
    live.eq[i].Q.setTargetAtTime(n.q, now, 0.02);
  });
}

// ---------------------------------------------------------------- AudioWorklet (Blob)
const workletState = new WeakMap(); // ctx → { promise, ready, failed }

/** Load the Risset worklet into ctx once (Blob URL, no fetch of a separate file). / 워클릿 로드 */
export function ensureRissetWorklet(ctx) {
  let st = workletState.get(ctx);
  if (st) return st.promise;
  st = { ready: false, failed: false, promise: null };
  workletState.set(ctx, st);
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
    st.failed = true;
    st.promise = Promise.resolve(false);
    return st.promise;
  }
  const url = URL.createObjectURL(new Blob([buildRissetWorkletSource()], { type: 'text/javascript' }));
  st.promise = ctx.audioWorklet.addModule(url)
    .then(() => { st.ready = true; return true; })
    .catch((err) => { st.failed = true; console.warn('[Risset] AudioWorklet unavailable → oscillator fallback', err); return false; })
    .finally(() => URL.revokeObjectURL(url));
  return st.promise;
}

const workletReady = (ctx) => !!workletState.get(ctx)?.ready;

/** Which engine the params ask for on this ctx right now. / 사용할 엔진 */
function pickEngine(params, ctx) {
  if (params.engineMode === 'oscillators') return 'oscillators';
  return workletReady(ctx) ? 'worklet' : 'oscillators';
}

let lastEngine = null;
/** Engine of the editor's live pass ('worklet' | 'oscillators' | null when stopped). / 현재 엔진 */
export function rissetEngineKind() {
  return live ? live.kind : null;
}
export const lastRissetEngine = () => lastEngine;
/** Kuramoto order parameter r of the live worklet (null = unknown). / 실시간 질서 매개변수 */
export const rissetSyncR = () => (live && live.kind === 'worklet' && live.syncR !== undefined ? live.syncR : null);

/** Build a live pass (worklet or oscillators) into dest. / 실시간 패스 생성 */
function createPass(ctx, params, rt, dest, getExtraTremolo = null) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, ctx.currentTime);
  out.gain.linearRampToValueAtTime(1, ctx.currentTime + TRANSPORT_FADE_SEC);
  // Tremolo stages after the transport fade: the studio's own, then (Manager) the channel's.
  // 트레몰로 단계: 스튜디오 자체 → (매니저) 트랙 트레몰로
  const trem = createTremoloNode(ctx, params.tremolo);
  const extra = getExtraTremolo ? createTremoloNode(ctx, getExtraTremolo()) : null;
  out.connect(trem.node);
  if (extra) { trem.node.connect(extra.node); extra.node.connect(dest); } else trem.node.connect(dest);
  const master = ctx.createGain();
  const kind = pickEngine(params, ctx);
  const pass = { kind, master, out, eq: [], voices: [], node: null, trem, extra, getExtraTremolo };
  if (kind === 'worklet') {
    master.gain.value = 1; // the bank applies masterGain·1/√N·0.65 itself / 스케일은 뱅크 안에서
    const initial = buildControlFrame(params, rt);
    pass.node = new AudioWorkletNode(ctx, RISSET_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maxSlots: MAX_SLOTS, initial } });
    pass.node.connect(master);
    pass.node.port.onmessage = (e) => { if (e.data?.type === 'r') pass.syncR = e.data.r; };
  } else {
    master.gain.value = outputScale(params, rt.eff);
  }
  pass.eq = buildEq(ctx, params.eqNodes, master, out);
  lastEngine = kind;
  updatePass(params, rt, pass);
  return pass;
}

function syncOscillators(ctx, params, rt, pass) {
  const now = ctx.currentTime;
  const want = rt.slots.length;
  while (pass.voices.length > want) {
    const v = pass.voices.pop();
    v.gain.gain.setTargetAtTime(0, now, 0.015);
    v.osc.stop(now + 0.08);
  }
  while (pass.voices.length < want) {
    const j = pass.voices.length;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(phaseToFreq(params, rt.slots[j].s), now);
    gain.gain.setValueAtTime(0, now);
    osc.connect(gain).connect(pass.master);
    osc.start(now);
    pass.voices.push({ osc, gain });
  }
}

/**
 * Manager Warp: per-slot pitch shift (semitones) of a control frame — warpHz(hz) → warped hz.
 * 매니저 곡률: 제어 프레임의 슬롯별 음고 이동 (반음).
 */
function warpShiftFrame(params, frame, warpHz) {
  const shift = new Float32Array(Math.max(1, frame.n));
  for (let j = 0; j < frame.n; j++) {
    const hz = phaseToFreq(params, frame.slots[j * 4]);
    const w = warpHz(hz);
    shift[j] = w > 0 && hz > 0 ? freqToMidi(w) - freqToMidi(hz) : 0;
  }
  frame.shift = shift;
  return frame;
}

/**
 * Push the current runtime into a pass. ampMul(j, hz) = extra per-slot gain (Manager masks),
 * warpHz(hz) = warped frequency (Manager Warp) or null.
 */
function updatePass(params, rt, pass, ampMul = null, warpHz = null) {
  const ctx = getAudioCtx();
  if (!ctx || !pass) return;
  syncEq(ctx, params, pass);
  pass.trem?.update(params.tremolo);
  if (pass.extra) pass.extra.update(pass.getExtraTremolo?.());
  if (pass.kind === 'worklet') {
    const frame = buildControlFrame(params, rt);
    if (warpHz) warpShiftFrame(params, frame, warpHz);
    if (ampMul) for (let j = 0; j < frame.n; j++) frame.slots[j * 4 + 2] *= ampMul(j, phaseToFreq(params, frame.slots[j * 4]) * (frame.shift ? Math.pow(2, frame.shift[j] / 12) : 1));
    pass.node.port.postMessage({ type: 'control', frame }, [frame.slots.buffer]);
    return;
  }
  syncOscillators(ctx, params, rt, pass);
  const now = ctx.currentTime;
  const weight = weightOf(params, rt.eff);
  const useW = !!(weight.tilt || weight.flutterDb);
  pass.master.gain.setTargetAtTime(outputScale(params, rt.eff), now, 0.02);
  rt.slots.forEach((sl, j) => {
    const v = pass.voices[j];
    const f0 = phaseToFreq(params, sl.s);
    const f = warpHz ? warpHz(f0) || f0 : f0;
    // A slot that just started sounding jumps to its pitch (its gain is ~0 after the cooldown).
    // 막 시작한 슬롯은 음고로 바로 이동 (쿨다운 후 게인 ≈ 0).
    if (sl.fresh) { v.osc.frequency.cancelScheduledValues(now); v.osc.frequency.setValueAtTime(f, now); }
    else v.osc.frequency.setTargetAtTime(f, now, 0.012);
    let m = sl.active && ampMul ? ampMul(j, f) : 1;
    if (useW) m *= RissetVoiceBank.freqWeight(weight, f);
    v.gain.gain.setTargetAtTime(sl.active ? sl.amp * m : 0, now, 0.012);
  });
}

function updateLive(params, rt, pass) {
  updatePass(params, rt, pass);
}

/** Start the live engine. / 실시간 엔진 시작 */
export async function startRissetAudio() {
  const ctx = await ensureAudioCtx();
  if (live) return true;
  const params = getRissetParams();
  if (params.engineMode !== 'oscillators') await ensureRissetWorklet(ctx);
  if (live) return true;
  live = createPass(ctx, params, getRissetRuntime(), getOutputBus(ctx));
  setTransport({ playing: true });
  return true;
}

/** Stop with a short fade. / 짧은 페이드로 정지 */
export function stopRissetAudio() {
  const ctx = getAudioCtx();
  const pass = live;
  live = null;
  releaseLive(ctx, pass);
  setTransport({ playing: false, playheadSec: -1 });
}

/** Restart the live pass (engine mode changed while playing). / 엔진 전환 시 재시작 */
export async function restartRissetAudio() {
  if (!live) return false;
  stopRissetAudio();
  return startRissetAudio();
}

function releaseLive(ctx, pass) {
  if (!pass || !ctx) return;
  const now = ctx.currentTime;
  pass.out.gain.cancelScheduledValues(now);
  pass.out.gain.setValueAtTime(pass.out.gain.value, now);
  pass.out.gain.linearRampToValueAtTime(0, now + TRANSPORT_FADE_SEC);
  pass.voices.forEach((v) => { try { v.osc.stop(now + TRANSPORT_FADE_SEC + 0.02); } catch { /* stopped */ } });
  setTimeout(() => {
    try { pass.node?.port.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    [pass.out, pass.master, pass.node, ...pass.eq, ...pass.voices.flatMap((v) => [v.osc, v.gain])].forEach((n) => { try { n?.disconnect(); } catch { /* ignore */ } });
    pass.trem?.dispose();
    pass.extra?.dispose();
  }, 200);
}

/** Full Risset params from a stored document (null = defaults). / 저장 문서 → 전체 파라미터 */
export function resolveRissetDoc(doc) {
  return sanitizeRissetParams({ ...createDefaultRissetParams(), ...(doc && typeof doc === 'object' ? doc : {}) });
}

/**
 * Independent live Risset engine (one per Manager instance): own runtime, own oscillators,
 * output into `dest`. The caller advances it with step(dt). Does not touch appState.transport.
 * 매니저 인스턴스용 독립 리세 엔진 (자체 런타임·오실레이터, dest로 출력, step(dt)로 진행).
 * @param {{ getParams: () => object }} opts
 */
export function createRissetEngine({ getParams, getMask = null, getExtraTremolo = null, getWarp = null }) {
  const rt = createRissetRuntime(getParams());
  let pass = null;
  return {
    runtime: rt,
    isRunning: () => !!pass,
    engineKind: () => pass?.kind ?? null,
    /** @param {BaseAudioContext} ctx @param {AudioNode} dest — sync: uses the worklet once it is loaded */
    start(ctx, dest) {
      if (pass) return;
      const params = getParams();
      if (params.engineMode !== 'oscillators') ensureRissetWorklet(ctx); // ready from the next start / 다음 시작부터 워클릿
      pass = createPass(ctx, params, rt, dest, getExtraTremolo);
    },
    /** @param {number} dt real seconds @param {number} [timeScale] Tempo Manager rate (runtime clock = dt · rate) */
    step(dt, timeScale = 1) {
      const params = getParams();
      rt.timeScale = timeScale;
      stepRuntime(params, rt, runtimeStepScale(dt, timeScale), { running: !!pass });
      // getMask() → (hz) → gain, or null (Manager shape regions) / 음고 마스크
      const mask = getMask ? getMask() : null;
      // getWarp() → (hz) → warped hz, or null (Manager Warp) / 매니저 곡률
      const warp = getWarp ? getWarp() : null;
      if (pass) updatePass(params, rt, pass, mask ? (i, hz) => mask(hz) : null, warp);
    },
    stop() {
      const p = pass;
      pass = null;
      releaseLive(getAudioCtx(), p);
    },
  };
}

export async function toggleRissetAudio() {
  if (live) { stopRissetAudio(); return false; }
  return startRissetAudio();
}

/**
 * Render `seconds` offline at 48 kHz from the current state with the same RissetVoiceBank as the
 * worklet (control frame every 64 samples: automation, shaping, local particles, regions), then
 * through the PEQ chain. / 워클릿과 같은 보이스 뱅크로 오프라인 렌더 (64샘플마다 제어 프레임).
 */
export async function renderRissetBuffer({ seconds, sampleRate = 48000, params: paramsIn = null, runtime = null, outputStage = true, ampMask = null, pitchWarp = null, timeScale = 1, extraTremolo = null } = {}) {
  const params = paramsIn || getRissetParams();
  const dur = clamp(Number(seconds ?? params.exportSec) || 15, 1, 180);
  const frames = Math.ceil(dur * sampleRate);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(1, frames, sampleRate);
  const buf = ctx.createBuffer(1, frames, sampleRate);
  // Dynamics on → reproducible render from the pre-integrated (cached) trajectories; else from now.
  // 동역학이 켜지면 사전 적분 배열로 재현 가능한 렌더, 아니면 현재 상태부터.
  const baked = runtime ? null : createBakedRuntime(params, (dur + 0.1) * timeScale); // Tempo Manager: runtime time = real × rate
  const live0 = baked || runtime || (paramsIn ? createRissetRuntime(params) : getRissetRuntime());
  renderBankInto(params, baked || cloneRuntime(live0), buf.getChannelData(0), sampleRate, { ampMask, pitchWarp, timeScale });
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Same LFO graph as the live pass (studio tremolo, then the Manager channel's) / 실시간과 같은 LFO 그래프
  const trem = createTremoloNode(ctx, params.tremolo);
  const extra = extraTremolo ? createTremoloNode(ctx, extraTremolo) : null;
  buildEq(ctx, params.eqNodes, src, trem.node);
  if (extra) { trem.node.connect(extra.node); extra.node.connect(outputStage ? createOfflineOutput(ctx) : ctx.destination); } else trem.node.connect(outputStage ? createOfflineOutput(ctx) : ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/**
 * Drive a RissetVoiceBank from a runtime into `out` (Float32Array): runtime step + control frame
 * every `block` samples. Shared by the offline render and the self-checks.
 * 런타임 → 보이스 뱅크 → 출력 배열 (오프라인·자가진단 공용).
 */
export function renderBankInto(params, rt, out, sampleRate, { block = 64, ampMask = null, pitchWarp = null, step = true, timeScale = 1 } = {}) {
  const bank = new RissetVoiceBank(sampleRate, MAX_SLOTS);
  const tmp = new Float32Array(block);
  const dtBlock = runtimeStepScale(block / sampleRate, timeScale); // runtime clock per block (Tempo Manager) / 블록당 런타임 시간
  rt.timeScale = timeScale;
  for (let s0 = 0; s0 < out.length; s0 += block) {
    if (step) stepRuntime(params, rt, s0 === 0 ? 0 : dtBlock, { running: true });
    const frame = buildControlFrame(params, rt);
    if (pitchWarp) warpShiftFrame(params, frame, (hz) => pitchWarp(s0 / sampleRate, hz));
    if (ampMask) for (let j = 0; j < frame.n; j++) frame.slots[j * 4 + 2] *= ampMask(s0 / sampleRate, phaseToFreq(params, frame.slots[j * 4]) * (frame.shift ? Math.pow(2, frame.shift[j] / 12) : 1));
    bank.setControl(frame);
    const len = Math.min(block, out.length - s0);
    bank.process(tmp, len);
    out.set(len === block ? tmp : tmp.subarray(0, len), s0);
  }
  return bank;
}

/** Render and download Risset_{N}v_T{sec}s.wav. / WAV 내보내기 */
export async function exportRissetWav({ download = true } = {}) {
  const params = getRissetParams();
  const buffer = await renderRissetBuffer();
  const wav = encodeWav(buffer);
  const filename = `Risset_${params.voiceCount}v_T${(buffer.length / buffer.sampleRate).toFixed(2)}s.wav`;
  if (download) triggerDownload(new Blob([wav], { type: 'audio/wav' }), filename);
  return { ok: true, filename, bytes: wav.byteLength, message: t('toast.wavDone', filename) };
}

// ==========================================================================
// Self-checks (audio tier) / 자가진단 (오디오 계층)
// ==========================================================================

const rmsOf = (a, from = 0) => { let e = 0; for (let i = from; i < a.length; i++) e += a[i] * a[i]; return Math.sqrt(e / Math.max(1, a.length - from)); };

registerSelfCheck('Risset A-1: voice bank is self-contained (worklet Blob source)', (a) => {
  const src = RissetVoiceBank.toString();
  a.ok(!/\bimport\b|\brequire\(|\bdocument\b|\bwindow\b/.test(src), 'no imports / DOM in the class');
  a.ok(buildRissetWorkletSource().includes('registerProcessor'), 'processor registered');
  a.ok(new Function(`${src}; return new RissetVoiceBank(48000, 4);`)() !== null, 'class compiles standalone');
}, { group: 'audio' });

registerSelfCheck('Risset A-1: wrap continuity, 1/√N level, v = 0 phase', (a) => {
  const fs = 48000;
  // Fast glide (v = 0.5 cycle/s, 4 voices) → many wraps in 1 s. The largest sample step must stay
  // within the sine slope bound 2π·f_max/fs·A (no jump at the wrap). / 래핑 지점 점프 없음
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 4, rateHz: 0.5, spanSemitones: 48, baseMidi: 48, envWidth: 0.3 });
  const rt = createRissetRuntime(p, () => 0.5);
  const out = new Float32Array(fs);
  renderBankInto(p, rt, out, fs);
  const fMax = 440 * 2 ** ((p.baseMidi + p.spanSemitones - 69) / 12);
  let maxStep = 0;
  for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
  const bound = (2 * Math.PI * fMax / fs) * outputScale(p) * p.voiceCount * 1.05;
  a.ok(maxStep <= bound, `max step ${maxStep.toFixed(4)} ≤ ${bound.toFixed(4)}`);
  // Phase continuity of the bank itself at the wrap: p goes 0.999… → 0.000… in one sample.
  const bank = new RissetVoiceBank(fs, 2);
  bank.setControl({ n: 1, scale: 1, base: 48, span: 24, env: { enabled: false }, slots: [0.9999, 48, 1, 1] });
  bank.process(new Float32Array(8), 8);
  a.ok(bank.p[0] < 0.01, `wrapped p = ${bank.p[0].toFixed(5)}`);
  // 1/√N: envelope off, unit gains → RMS = masterGain·0.65/√2 for any N / 보이스 수와 무관한 레벨
  const lvl = (N) => {
    const q = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: N, rateHz: 0, globalEnvEnabled: false, masterGain: 0.75, spanSemitones: 36, baseMidi: 60 });
    const r = createRissetRuntime(q, () => 0.5);
    const o = new Float32Array(fs / 2);
    renderBankInto(q, r, o, fs);
    return rmsOf(o, 2400);
  };
  const expect = (0.75 * 0.65) / Math.SQRT2;
  for (const N of [4, 16]) a.near(lvl(N), expect, expect * 0.12, `RMS N=${N}`);
  // v = 0 ⇒ the S¹ phase never moves (runtime + bank) / v = 0이면 위상 불변
  const z = sanitizeRissetParams({ ...createDefaultRissetParams(), rateHz: 0 });
  const rz = createRissetRuntime(z, () => 0.5);
  const oz = new Float32Array(4800);
  const bz = renderBankInto(z, rz, oz, fs);
  const p0 = rz.sig.phase.slice(0, z.voiceCount);
  a.equal(rz.masterPhase, 0, 'master phase');
  for (let i = 0; i < z.voiceCount; i++) a.near(bz.p[i], p0[i], 1e-9, `bank phase ${i}`);
}, { group: 'audio' });

registerSelfCheck('Risset A-1: offline render = AudioWorklet output', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline || typeof AudioWorkletNode === 'undefined') { a.ok(true, 'AudioWorklet unavailable — skipped'); return; }
  const fs = 48000;
  const len = 128 * 150;
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 6, rateHz: 0.2, envWidth: 0.5 });
  const rt = createRissetRuntime(p, () => 0.5);
  stepRuntime(p, rt, 0, { running: true, rng: () => 0.5 });
  const frame = buildControlFrame(p, rt);
  // Same frame, no further control: the worklet and the main-thread bank must agree sample-for-sample.
  const ref = new RissetVoiceBank(fs, MAX_SLOTS);
  ref.setControl({ ...frame, slots: Float32Array.from(frame.slots) });
  const want = new Float32Array(len);
  for (let s0 = 0; s0 < len; s0 += 128) ref.process(want.subarray(s0, s0 + 128), 128);
  const ctx = new Offline(1, len, fs);
  const ok = await ensureRissetWorklet(ctx);
  a.ok(ok, 'worklet module loaded');
  const node = new AudioWorkletNode(ctx, RISSET_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maxSlots: MAX_SLOTS, initial: frame } });
  node.connect(ctx.destination);
  const got = (await ctx.startRendering()).getChannelData(0);
  let maxErr = 0;
  for (let i = 0; i < len; i++) maxErr = Math.max(maxErr, Math.abs(got[i] - want[i]));
  a.ok(rmsOf(want) > 1e-3, 'signal present');
  a.ok(maxErr < 1e-6, `max |worklet − offline| = ${maxErr.toExponential(2)}`);
}, { group: 'audio' });

/** Power of a sinusoid at `f` in `x` (Goertzel, exact when the window holds whole periods). */
function goertzelPower(x, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * (re * re + im * im)) / (x.length * x.length); // = A²/2·… normalised to mean power
}

/** One fixed-pitch slot of the bank (for DSP measurements). / 고정 음고 슬롯 하나 렌더 */
export function renderFixedTone(hz, { morph = 1, duty = 0.5, fs = 48000, len = 9600, warm = 4800 } = {}) {
  const bank = new RissetVoiceBank(fs, 2);
  bank.setControl({ n: 1, scale: 0.5, base: 69 + 12 * Math.log2(hz / 440), span: 12, env: { enabled: false }, wave: { morph, duty }, slots: [0, 0, 1, 1] });
  const warmBuf = new Float32Array(warm);
  bank.process(warmBuf, warm);
  const out = new Float32Array(len);
  for (let s0 = 0; s0 < len; s0 += 128) bank.process(out.subarray(s0, s0 + 128), Math.min(128, len - s0));
  return out;
}

/** Aliased (non-harmonic) power relative to the total, in dB. / 앨리어싱 비율 (dB) */
export function aliasingDb(x, f0, fs) {
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let total = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) { y[i] = x[i] - mean; total += y[i] * y[i]; }
  total /= x.length;
  let harm = 0;
  for (let k = 1; k * f0 < fs / 2; k++) harm += goertzelPower(y, k * f0, fs);
  return 10 * Math.log10(Math.max(1e-12, total - harm) / total);
}

registerSelfCheck('Risset A-3: PolyBLEP pulse — aliasing limit, 50% duty has no even harmonics', (a) => {
  const fs = 48000;
  // 5 kHz pulse, duty 0.3: 9600 samples = exactly 1000 periods (harmonics fall on bins).
  const x = renderFixedTone(5000, { morph: 1, duty: 0.3 });
  const db = aliasingDb(x, 5000, fs);
  a.ok(db < -35, `aliased power ${db.toFixed(1)} dB re total at 5 kHz (limit −35 dB)`);
  for (const f of [1000, 2500, 12000]) {
    const d = aliasingDb(renderFixedTone(f, { morph: 1, duty: 0.3 }), f, fs);
    a.ok(d < -35, `aliased power ${d.toFixed(1)} dB at ${f} Hz`);
  }
  // 1 kHz, duty 0.5 → even harmonics ≈ 0 / 듀티 50% → 짝수 배음 ≈ 0
  const y = renderFixedTone(1000, { morph: 1, duty: 0.5 });
  const h1 = goertzelPower(y, 1000, fs);
  const h2 = goertzelPower(y, 2000, fs);
  const h4 = goertzelPower(y, 4000, fs);
  const h3 = goertzelPower(y, 3000, fs);
  const ev = 10 * Math.log10(Math.max(h2, h4, 1e-20) / h1);
  a.ok(ev < -60, `even harmonics ${ev.toFixed(1)} dB re fundamental`);
  a.near(Math.sqrt(h3 / h1), 1 / 3, 0.05, 'odd harmonic 3 ≈ 1/3');
}, { group: 'audio' });

registerSelfCheck('Risset A-3: Kuramoto coupling syncs (K > 0) and disperses (K < 0)', (a) => {
  const fs = 48000;
  const run = (K) => {
    const bank = new RissetVoiceBank(fs, 4);
    // three pulse trains near 2 Hz with spread phases / 2 Hz 근처 펄스열 셋
    bank.psi.set([0, 0.33, 0.66]);
    bank.setControl({ n: 3, scale: 0.3, base: 69 + 12 * Math.log2(2 / 440), span: 12, env: { enabled: false }, syncHz: K, slots: [0, 0, 1, 1, 0.03, 0, 1, 1, 0.06, 0, 1, 1] });
    const buf = new Float32Array(128);
    for (let k = 0; k < fs * 3 / 128; k++) bank.process(buf, 128);
    return bank.r;
  };
  const rFree = run(0);
  const rSync = run(8);
  const rDisp = run(-8);
  a.ok(rSync > 0.95, `K = +8 Hz → r ${rSync.toFixed(3)}`);
  a.ok(rDisp < 0.2, `K = −8 Hz → r ${rDisp.toFixed(3)}`);
  a.ok(rSync > rFree && rDisp <= rFree + 0.05, `free r ${rFree.toFixed(3)}`);
}, { group: 'audio' });

registerSelfCheck('Tempo Manager: Risset at rate r for T/r seconds = rate 1 for T seconds (ω in real time)', (a) => {
  const params = resolveRissetDoc({ rateHz: 0.2 });
  const run = (secs, ts) => {
    const rt = createRissetRuntime(params);
    rt.timeScale = ts;
    for (let t = 0; t < secs - 1e-9; t += 0.01) stepRuntime(params, rt, runtimeStepScale(0.01, ts), { running: true });
    return buildControlFrame(params, rt);
  };
  const A = run(2, 1);
  const B = run(1, 2);
  let dPhase = 0;
  let ratio = 0;
  for (let j = 0; j < A.n; j++) {
    dPhase = Math.max(dPhase, Math.abs(A.slots[j * 4] - B.slots[j * 4]));
    if (Math.abs(A.slots[j * 4 + 1]) > 1e-6) ratio = B.slots[j * 4 + 1] / A.slots[j * 4 + 1];
  }
  a.ok(dPhase < 1e-9, `same S¹ positions (Δ ${dPhase})`);
  a.near(ratio, 2, 1e-9, 'control-frame ω is ×rate per real second');
}, { group: 'audio' });

registerSelfCheck('Risset voice bank: Manager Warp shift moves the slot pitch (semitones)', (a) => {
  const pitchOf = (shift) => {
    const b = new RissetVoiceBank(48000, 4);
    b.setControl({ n: 1, scale: 1, base: 48, span: 24, env: { enabled: false }, slots: [0, 0, 1, 1], shift });
    const out = new Float32Array(128 * 188);
    const tmp = new Float32Array(128);
    for (let s = 0; s < out.length; s += 128) { b.process(tmp, 128); out.set(tmp, s); }
    let z = 0;
    let first = -1;
    let last = -1;
    for (let i = 12001; i < out.length; i++) if (out[i - 1] <= 0 && out[i] > 0) { if (first < 0) first = i; last = i; z++; }
    return freqToMidi(((z - 1) * 48000) / (last - first));
  };
  a.near(pitchOf(null), 48, 0.05, 'no shift');
  a.near(pitchOf([12]), 60, 0.05, '+12 st');
  a.near(pitchOf([-5]), 43, 0.05, '−5 st');
}, { group: 'audio' });
