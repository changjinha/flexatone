/**
 * Flexatone — studios/space/space-audio.js
 * Space Studio audio tier: plays and renders BAKED source arrays only (stereo).
 * 스페이스 스튜디오 오디오: 베이킹된 음원 배열만 재생·렌더링 (스테레오).
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — it may import
 * audio/*, and only ui/workspaces.js (and space-panels.js) import it. The pure plugin files never do.
 *
 * Graph per source / 음원별 그래프
 *   Oscillator(PeriodicWave, frequency ← f_obs curve)
 *     → BiquadFilter lowpass (frequency ← air-absorption curve)
 *     → Gain (baseGain · distance gain curve, 8 ms edge fades)
 *     → StereoPanner (pan ← sin θ curve)   |  panMode 'hrtf': PannerNode HRTF (direction curves, no rolloff)
 *     → master (0.45, same live and offline) → getOutputBus(ctx) / createOfflineOutput(ctx)
 * Every curve is a slice of the baked Float64 arrays → setValueCurveAtTime. No physics at playback.
 * 모든 곡선은 베이킹 배열을 잘라 setValueCurveAtTime으로 설정 — 재생 중 물리 연산 없음.
 *
 * Live edits while playing: when the bake signature changes (listener drag, slider), the pass is
 * rebuilt from the current playhead with a 12 ms crossfade (the bake itself happened at edit time).
 * 재생 중 편집: 베이킹이 바뀌면 현재 플레이헤드에서 12 ms 크로스페이드로 다시 스케줄.
 */

import { applyAdsrToCurve } from '../../core/adsr.js';
import { timbreSpecAdsr } from '../../modules/timbre-spec.js';
import { clamp } from '../../core/math-utils.js';
import { t } from '../../core/i18n.js';
import { registerSelfCheck } from '../../core/state.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { timbreSampleSpec } from '../../modules/sample-source.js';
import { createToneSource, skipSampleRead } from '../../audio/sample-voice.js';
import { createVoiceModEvaluator, voiceModFreqCurve, voiceModGainCurve, voiceModIndex } from '../../core/voice-mod.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams } from './space-engine.js';
import { getSpaceParams, getSpaceBake, getActiveSource, isSourceAudible } from './space-doc.js'; // the document on screen: studio or Space Master / 화면의 문서
import { dbToAmp } from '../../core/units.js';
import { getFocusedId } from '../../core/manager-state.js';
import { getSample, addSample, MAX_SAMPLE_SEC } from '../../core/sample-library.js';
import { getAudioCtx } from '../../audio/audio-engine.js';
import { createBinauralSpeakers, binauralSupported, speakerCurves, ambixCurves, connectThroughCurves, createAmbixBus, createArrayBus, getCompactDecoder } from '../../audio/hoa-bus.js';
import { isHoaMode, arraySettings, bakeArrivals, boomBake, superMode, playbackMode } from './space-engine.js';
import { getLayout, createArrayDecoder, delayCompensation, channelOrderText, arrayMetrics } from '../../modules/speaker-arrays.js';
import { hrirFor } from '../../audio/hrir-store.js';
import { currentOutputAmp } from '../../audio/output-bus.js';
import { roomOf, roomActive, bakeRoom, roomEndSec, reverbTailSec, reverbImpulse } from './space-room.js';
import { hoaChannels } from '../../modules/ambisonics.js';
import { describeInstance, requestInstanceBuffer, awaitInstanceBuffer, onInstanceBuffer, baseTarget } from '../../audio/instance-source.js';
import { encodeWavFloat, bufferPeak } from '../../audio/wav-multichannel.js';

export const SPACE_MASTER = 0.45;
const START_LEAD_SEC = 0.03;
const EDGE_FADE_SEC = 0.008;
const MAX_CURVE = 32768;
const RESTART_MIN_MS = 45;
const RESTART_SETTLE_MS = 110; // an edit must rest this long before the pass is re-scheduled … / 편집이 이만큼 멈춰야 다시 스케줄
const RESTART_MAX_WAIT_MS = 450; // … but a long drag is still heard every so often / 긴 드래그 중에도 가끔은 들리도록

/** PeriodicWave from the shared 5-wave mixer. / 음색 파형 */
function buildWave(ctx, timbre) {
  return createTimbreWave(ctx, timbre || { sine: 1 }); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
}

/**
 * Heard window of a source after its play range (clip = fraction of the heard span, trim only —
 * a Space source is extended with its own Duration). / 재생 구간을 적용한 들리는 창 (줄이기만)
 */
export function spaceSourceWindow(src, b) {
  const span = b.t1 - b.t0;
  const u0 = clamp(Number.isFinite(src?.clip?.u0) ? src.clip.u0 : 0, 0, 1);
  const u1 = clamp(Number.isFinite(src?.clip?.u1) ? src.clip.u1 : 1, u0, 1);
  return { t0: b.t0 + u0 * span, t1: b.t0 + u1 * span };
}

/** Resample a baked array over [from, to] (listener time) into m points. / 구간 재표본 */
function slice(b, key, from, to, m, map = null) {
  const out = new Float32Array(m);
  const a = b[key];
  for (let i = 0; i < m; i++) {
    const tt = from + ((to - from) * i) / (m - 1);
    const s = clamp((tt - b.t0) / b.dt, 0, b.n - 1);
    const j = Math.min(b.n - 2, Math.floor(s));
    const v = a[j] + (a[j + 1] - a[j]) * (s - j);
    out[i] = map ? map(v, i) : v;
  }
  return out;
}

/**
 * Schedule one baked source from `cueSec` onto ctx at context time `nowTime`.
 * 음원 하나를 cueSec부터 nowTime에 스케줄. @returns {boolean}
 *
 * Sound of the source / 음원의 소리
 *   synth  — oscillator(s) whose frequency follows the baked f_obs curve.
 *   import — an AudioBuffer (the sound of another studio, `importBuffer`) played with
 *            playbackRate = f_obs / f_s = (dτ/dt)^amount: the tape moves exactly as the emission
 *            time τ(t) does, so the Doppler shift and the arrival delay are those of the physics.
 *            The buffer offset at the cue is the emission time heard there.
 *            가져온 소리: playbackRate = f_obs / f_s. 테이프가 방출 시각 τ(t)대로 움직이므로 도플러와 도착 지연이 물리 그대로.
 * Direction stage / 방향 단계
 *   `spatial` null → StereoPanner (equal power) or one HRTF PannerNode per source (panMode);
 *   { mode: 'binaural', speakers } → HOA panning to the shared virtual loudspeakers;
 *   { mode: 'ambix', bus, order } → SN3D coefficient curves into the ambiX bus.
 */
export function scheduleSpaceSource(ctx, dest, src, b, { nowTime, cueSec, nodes, panMode = 'equalPower', rate = 200, ampMask = null, pitchWarp = null, brightWarp = null, voiceMod = null, spatial = null, importBuffer = null, stream = null, delayOffset = 0, reverbSend = null, phaseExact = false, timeScale = 1, economy = false }) {
  if (!b) return false;
  // Play range (core/line-clip.js): only [W.t0, W.t1] of the heard span sounds / 들리는 구간 중 재생 구간만
  const W = spaceSourceWindow(src, b);
  if (W.t1 <= cueSec + 1e-3 || W.t1 - W.t0 <= 0.01) return false;
  // Tempo Manager rate (pitch kept): listener second s sounds at s / ts — the scene runs faster, every
  // heard frequency (Doppler included) stays; masks / warps read real time. An imported sound keeps its own speed.
  // 템포 배속 (음고 유지): 청취 s초 → 실제 s/ts초, 들리는 주파수(도플러 포함)는 그대로. 마스크·곡률은 실제 시간. 가져온 소리는 자기 속도.
  const ts = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const isImport = src.input?.kind === 'import' || src.input?.kind === 'track' || !!stream;
  if (isImport && b.reversed) return false; // a supersonic arrival heard backwards: a buffer cannot be played in reverse here / 역행 도착은 버퍼로 재생 불가
  if (isImport && !importBuffer && !stream) return false; // not rendered yet / missing → silent / 아직 없으면 무음
  const from = Math.max(W.t0, cueSec);
  const docDur = W.t1 - from; // listener (document) seconds / 청취(문서) 초
  const playDur = docDur / ts; // real seconds / 실제 초
  if (playDur <= 0.01) return false;
  const t0 = nowTime + Math.max(0, W.t0 - cueSec) / ts;
  const m = clamp(Math.ceil(docDur * rate) + 1, 2, MAX_CURVE);
  const nyq = ctx.sampleRate / 2 - 50;
  const fade = Math.min(EDGE_FADE_SEC, playDur * 0.1);
  const freq = slice(b, 'fObs', from, W.t1, m, (v) => clamp(v, 10, nyq));
  const lp = slice(b, 'lp', from, W.t1, m, (v) => clamp(v, 40, nyq));
  const laneGain = b.gainLane ? slice(b, 'gainLane', from, W.t1, m) : null;
  const trim = isImport ? dbToAmp(src.input.trimDb || 0) : 1;
  const gain = slice(b, 'gain', from, W.t1, m, (v, i) => {
    const loc = (i / (m - 1)) * playDur;
    let g = Math.max(0, v * src.baseGain * trim);
    if (laneGain) g *= laneGain[i]; // gain lane (dB envelope) on top of the distance law / 게인 레인
    if (loc < fade) g *= loc / fade;
    if (playDur - loc < fade) g *= Math.max(0, playDur - loc) / fade;
    return g;
  });
  applyAdsrToCurve(timbreSpecAdsr(src.timbre), gain, from - W.t0, docDur, W.t1 - W.t0); // timbre ADSR over the heard span / 음색 ADSR (들리는 구간)
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.707;
  const amp = ctx.createGain();
  // Light playback: the cutoff moves slowly, so it is computed once per render quantum (≈ 3 ms) instead
  // of per sample — about 40 % less load per voice. Renders keep the sample-accurate filter.
  // 가벼운 재생: 차단 주파수를 렌더 퀀텀(약 3 ms)마다 한 번 계산 → 보이스당 부하 약 40 % 감소. 렌더는 샘플 단위 유지.
  if (economy) filter.frequency.automationRate = 'k-rate';
  filter.frequency.setValueCurveAtTime(lp, t0, playDur);
  amp.gain.setValueAtTime(0, nowTime);

  let head;
  if (stream) {
    // A running signal (a Manager track): the Doppler shift is a variable delay line, D(t) = t − τ(t)
    // (minus a constant `delayOffset`, which moves every source in time without changing any pitch).
    // 흐르는 신호(매니저 트랙): 도플러 = 가변 지연선 D(t) = t − τ(t) (상수 delayOffset을 빼도 음고는 그대로)
    const te = slice(b, 'te', from, W.t1, m);
    const useDoppler = src.doppler !== false;
    const d0 = Math.max(0, from - te[0] - delayOffset);
    const curve = new Float32Array(m);
    let dMax = 0;
    for (let i = 0; i < m; i++) { const d = (useDoppler ? Math.max(0, from + (i / (m - 1)) * docDur - te[i] - delayOffset) : d0) / ts; curve[i] = d; if (d > dMax) dMax = d; } // ÷ ts keeps dD/dt = the Doppler / 도플러 유지
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    const delay = ctx.createDelay(Math.min(170, Math.max(1, dMax + 0.5)));
    delay.delayTime.setValueAtTime(curve[0], nowTime);
    delay.delayTime.setValueCurveAtTime(curve, t0, playDur);
    stream.connect(mono);
    mono.connect(delay);
    amp.gain.setValueCurveAtTime(gain, t0, playDur);
    if (nodes) nodes.push(mono, delay);
    head = delay;
  } else if (isImport) {
    // Pitch-based Manager tools (shape mask, Warp) need a pitch line; an imported sound has none.
    // 음고 기반 매니저 도구(모양 마스크·곡률)는 음고 선이 필요 — 가져온 소리에는 없음
    const node = ctx.createBufferSource();
    node.buffer = importBuffer;
    node.loop = src.input.play === 'loop';
    const fs = slice(b, 'fs', from, W.t1, m);
    const ratio = slice(b, 'fObs', from, W.t1, m, (v, i) => clamp(v / Math.max(1e-9, fs[i]), 0.02, 16));
    node.playbackRate.setValueAtTime(ratio[0], nowTime);
    node.playbackRate.setValueCurveAtTime(ratio, t0, playDur);
    // emission time heard at `from` (the source clock starts at the first baked sample) / from에서 들리는 방출 시각
    const s = clamp((from - b.t0) / b.dt, 0, b.n - 1);
    const k = Math.min(b.n - 2, Math.floor(s));
    const tau = b.te[k] + (b.te[k + 1] - b.te[k]) * (s - k) - (b.teStart ?? b.te[0]);
    let off = Math.max(0, tau + (Number(src.input.offset) || 0));
    if (node.loop) off %= Math.max(1e-3, importBuffer.duration);
    else if (off >= importBuffer.duration - 1e-3) return false; // the sound is over / 소리가 이미 끝남
    const mono = ctx.createGain(); // a point source: stereo material is summed / 점음원: 스테레오는 합침
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    mono.channelInterpretation = 'speakers';
    // Stereo split: this source is one channel of the sound (−3 dB, so L + R is as loud as the mix)
    // 스테레오 분리: 이 음원은 소리의 한 채널 (−3 dB: L + R이 합본과 같은 음량)
    const ch = src.input.channel === 'L' ? 0 : src.input.channel === 'R' ? 1 : -1;
    if (ch >= 0 && importBuffer.numberOfChannels > 1) {
      const split = ctx.createChannelSplitter(2);
      node.connect(split);
      split.connect(mono, ch);
      for (let i = 0; i < m; i++) gain[i] *= Math.SQRT1_2;
      if (nodes) nodes.push(split);
    } else node.connect(mono);
    amp.gain.setValueCurveAtTime(gain, t0, playDur);
    node.start(t0, off);
    node.stop(t0 + playDur + 0.01);
    if (nodes) nodes.push(node, mono);
    head = mono;
  } else {
    if (pitchWarp) {
      // Manager Warp at the heard pitch (listener sec, Hz) / 매니저 곡률 (청취 시간, 들리는 주파수)
      for (let i = 0; i < m; i++) freq[i] = clamp(pitchWarp((from + (i / (m - 1)) * docDur) / ts, freq[i]), 10, nyq);
    }
    if (ampMask) {
      // Manager shape mask at the heard pitch (listener sec, Hz) / 매니저 모양 마스크 (청취 시간, 들리는 주파수)
      for (let i = 0; i < m; i++) gain[i] *= ampMask((from + (i / (m - 1)) * docDur) / ts, freq[i]);
    }
    // Per-source Sampler: the Doppler frequency is the playback rate (tape = physically right)
    // 음원별 샘플러: 도플러 주파수 = 재생 속도 (테이프 방식이 물리적으로 맞음)
    const smp = timbreSampleSpec(src.timbre);
    const osc = createToneSource(ctx, { sample: smp, wave: smp ? null : buildWave(ctx, src.timbre) });
    skipSampleRead(osc, (sec) => { const s = clamp((sec * ts - b.t0) / b.dt, 0, b.n - 1); return b.fObs[Math.round(s)]; }, b.t0 / ts, from / ts); // real time / 실제 시간
    // Per-voice tremolo / vibrato (core/voice-mod.js), on source time / 음원별 트레몰로·비브라토
    const vm = createVoiceModEvaluator(voiceMod, voiceModIndex(src.id), 69 + 12 * Math.log2(Math.max(10, freq[0]) / 440));
    // With reflections the phase between a source and its images is what is heard (the comb), so the
    // frequency must be right from the very first sample: without this the oscillator runs at its
    // default 440 Hz until the automation takes hold (up to one render quantum). Only set when a room
    // is on, so every older render stays sample-identical.
    // 반사가 있으면 음원과 영상 사이의 위상이 곧 소리(콤)이므로 첫 샘플부터 주파수가 맞아야 함. 방이 켜진 경우에만 설정.
    if (phaseExact) osc.frequency.setValueAtTime(freq[0], 0);
    osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, freq, from - b.t0, docDur), t0, playDur);
    amp.gain.setValueCurveAtTime(voiceModGainCurve(vm, gain, from - b.t0, docDur), t0, playDur);
    // Timbre lane: a second oscillator with timbre B, equal-power crossfade A ↔ B (only when the lane is on)
    // 음색 레인: 음색 B의 두 번째 오실레이터, A ↔ B 등전력 크로스페이드 (레인이 켜진 음원만)
    head = osc;
    if (b.morph && !smp) {
      const oscB = ctx.createOscillator();
      oscB.setPeriodicWave(buildWave(ctx, src.timbreB));
      if (phaseExact) oscB.frequency.setValueAtTime(freq[0], 0);
      oscB.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, freq, from - b.t0, docDur), t0, playDur);
      const gA = ctx.createGain();
      const gB = ctx.createGain();
      gA.gain.setValueCurveAtTime(slice(b, 'morph', from, W.t1, m, (v) => Math.cos((clamp(v, 0, 1) * Math.PI) / 2)), t0, playDur);
      gB.gain.setValueCurveAtTime(slice(b, 'morph', from, W.t1, m, (v) => Math.sin((clamp(v, 0, 1) * Math.PI) / 2)), t0, playDur);
      const sum = ctx.createGain();
      osc.connect(gA).connect(sum);
      oscB.connect(gB).connect(sum);
      oscB.start(t0);
      oscB.stop(t0 + playDur + 0.01);
      if (nodes) nodes.push(oscB, gA, gB, sum);
      head = sum;
    }
    osc.start(t0);
    osc.stop(t0 + playDur + 0.01);
    if (nodes) nodes.push(osc);
  }
  if (brightWarp && !isImport) { // Manager Warp brightness / 매니저 곡률 밝기
    const sh = createBrightShelf(ctx, freq, (i) => (from + (i / (m - 1)) * docDur) / ts, brightWarp, t0, playDur);
    head.connect(filter).connect(sh).connect(amp);
    if (nodes) nodes.push(sh);
  } else head.connect(filter).connect(amp);
  if (nodes) nodes.push(filter, amp);
  if (reverbSend && reverbSend.level > 0) {
    // Reverb send (space-room.js). 'physical': the send does NOT follow the distance law — the reverb of a
    // room is about as loud wherever the source is, so the direct / reverb ratio falls with distance.
    // 'follow': the send follows the direct level (constant ratio).
    // 잔향 보내기. 'physical': 거리 법칙을 따르지 않음 (직접음 / 잔향 비가 거리에 따라 감소). 'follow': 직접음 레벨을 따름.
    const amt = reverbSend.level * clamp(Number.isFinite(Number(src.send)) ? Number(src.send) : 1, 0, 4);
    const sc = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const loc = (i / (m - 1)) * playDur;
      let g = reverbSend.law === 'follow' ? gain[i] * amt : Math.max(0, src.baseGain * trim * amt) * (laneGain ? laneGain[i] : 1);
      if (reverbSend.law !== 'follow') { if (loc < fade) g *= loc / fade; if (playDur - loc < fade) g *= Math.max(0, playDur - loc) / fade; }
      sc[i] = g;
    }
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, nowTime);
    sg.gain.setValueCurveAtTime(sc, t0, playDur);
    filter.connect(sg).connect(reverbSend.node);
    if (nodes) nodes.push(sg);
  }

  if (spatial) {
    // HOA: direction arrays in the listener frame → gain curves (audio/hoa-bus.js) / 방향 배열 → 게인 곡선
    const fwd = slice(b, 'fwd', from, W.t1, m);
    const lat = slice(b, 'pan', from, W.t1, m);
    const up = slice(b, 'up', from, W.t1, m);
    const width = b.width ? slice(b, 'width', from, W.t1, m) : null;
    if (spatial.mode === 'ambix') connectThroughCurves(ctx, amp, spatial.bus.inputs, ambixCurves(spatial.order, fwd, lat, up, width), t0, playDur, nodes);
    else connectThroughCurves(ctx, amp, spatial.speakers.inputs, speakerCurves(spatial.speakers.dec, fwd, lat, up, width), t0, playDur, nodes);
    return true;
  }
  let panner;
  if (panMode === 'hrtf' && typeof ctx.createPanner === 'function') {
    panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.rolloffFactor = 0; // distance handled by the baked gain / 거리 감쇠는 베이킹 게인이 담당
    panner.refDistance = 1;
    panner.maxDistance = 10000;
    // Web Audio listener faces −Z: x = right, y = up, z = −forward / 청취자는 −Z를 향함
    panner.positionX.setValueCurveAtTime(slice(b, 'pan', from, W.t1, m), t0, playDur);
    panner.positionY.setValueCurveAtTime(slice(b, 'up', from, W.t1, m), t0, playDur);
    panner.positionZ.setValueCurveAtTime(slice(b, 'fwd', from, W.t1, m, (v) => -v), t0, playDur);
  } else if (typeof ctx.createStereoPanner === 'function') {
    panner = ctx.createStereoPanner();
    panner.pan.setValueCurveAtTime(slice(b, 'pan', from, W.t1, m), t0, playDur);
  } else {
    // Fallback: equal-power PannerNode on the unit circle / StereoPanner 미지원 대체
    panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.rolloffFactor = 0;
    panner.positionX.setValueCurveAtTime(slice(b, 'pan', from, W.t1, m), t0, playDur);
    panner.positionZ.setValueCurveAtTime(slice(b, 'pan', from, W.t1, m, (v) => -Math.sqrt(Math.max(0, 1 - v * v))), t0, playDur);
  }
  amp.connect(panner).connect(dest);
  if (nodes) nodes.push(panner);
  return true;
}

// --------------------------------------------------------------------------
// Imported sounds (audio/instance-source.js) / 가져온 소리
// --------------------------------------------------------------------------

/** The editor's own Space document as an import target (a source must not import it). / 에디터의 스페이스 문서 */
export const selfSpaceTarget = () => getFocusedId('space') || '@space';

const frozenBuffers = new Map(); // sample id → AudioBuffer / 고정 사본 버퍼
function frozenBuffer(id) {
  const smp = getSample(id);
  if (!smp || typeof AudioBuffer === 'undefined') return null;
  let buf = frozenBuffers.get(id);
  if (!buf) {
    buf = new AudioBuffer({ length: smp.data.length, numberOfChannels: 1, sampleRate: smp.sampleRate });
    buf.getChannelData(0).set(smp.data);
    frozenBuffers.set(id, buf);
    if (frozenBuffers.size > 16) frozenBuffers.delete(frozenBuffers.keys().next().value);
  }
  return buf;
}

/**
 * Status of an import source: { status: 'ready' | 'rendering' | 'missing' | 'cycle' | 'empty' | 'error' | 'none' | 'frozen',
 * buffer, key, length, name, studio }. Starts / refreshes the background render. / 가져온 음원의 상태
 */
export function importState(src, sampleRate = getAudioCtx()?.sampleRate || EXPORT_SAMPLE_RATE, { self = selfSpaceTarget() } = {}) {
  const inp = src.input?.kind === 'track' ? { ...src.input, content: 'heard', frozen: null } : src.input || {}; // a Manager track is heard as the Manager plays it / 매니저 트랙은 매니저에서 들리는 그대로
  if (inp.frozen) {
    const buf = frozenBuffer(inp.frozen);
    if (buf) return { status: 'frozen', buffer: buf, key: `frozen:${inp.frozen}`, length: buf.duration, name: getSample(inp.frozen)?.name || '', studio: '' };
  }
  if (!inp.target) return { status: 'missing', buffer: null, key: '', length: 0, name: '', studio: '' };
  if (baseTarget(inp.target) === self && src.input?.kind !== 'track') return { status: 'cycle', buffer: null, key: 'cycle', length: 0, name: '', studio: 'space' };
  const d = describeInstance(inp.target, inp.content);
  if (!d.ok) return { status: d.reason === 'cycle' ? 'cycle' : d.reason === 'none' ? 'none' : 'missing', buffer: null, key: d.reason, length: 0, name: '', studio: '' };
  const r = requestInstanceBuffer({ target: inp.target, content: inp.content, sampleRate });
  return { ...r, name: d.name, studio: d.studio };
}

/** Buffers of every import source that can sound now (live: whatever is ready). / 지금 낼 수 있는 가져온 소리 */
function liveImports(params, sampleRate) {
  const out = new Map();
  for (const s of params.sources) if (s.input?.kind === 'import' || s.input?.kind === 'track') { const st = importState(s, sampleRate); if (st.buffer) out.set(s.id, st.buffer); }
  return out;
}

/** Wait for every import of the document (offline renders). `chain` = targets being rendered above. */
export async function resolveImports(params, sampleRate, chain = []) {
  const out = new Map();
  for (const s of params.sources) {
    if (s.input?.kind !== 'import' && s.input?.kind !== 'track') continue;
    const inp = s.input.kind === 'track' ? { ...s.input, content: 'heard', frozen: null } : s.input;
    if (inp.frozen) { const buf = frozenBuffer(inp.frozen); if (buf) { out.set(s.id, buf); continue; } }
    if (!inp.target || chain.includes(baseTarget(inp.target))) continue; // missing, or a cycle → silent / 없거나 순환 → 무음
    const d = describeInstance(inp.target, inp.content);
    if (!d.ok) continue;
    const r = await awaitInstanceBuffer({ target: inp.target, content: inp.content, sampleRate, chain });
    if (r.buffer) out.set(s.id, r.buffer);
  }
  return out;
}

/** Mono copy of an import's current sound for the sample library (≤ 60 s). / 현재 소리의 모노 사본 */
export async function freezeImportSound(src) {
  const inp = src.input || {};
  const r = await awaitInstanceBuffer({ target: inp.target, content: inp.content, sampleRate: EXPORT_SAMPLE_RATE, chain: [selfSpaceTarget()] });
  if (!r.buffer) return null;
  const n = r.buffer.length;
  const data = new Float32Array(n);
  for (let c = 0; c < r.buffer.numberOfChannels; c++) { const x = r.buffer.getChannelData(c); for (let i = 0; i < n; i++) data[i] += x[i] / r.buffer.numberOfChannels; }
  const d = describeInstance(inp.target, inp.content);
  return { entry: addSample({ name: `Space ← ${d.ok ? d.name : inp.target}`, sampleRate: r.buffer.sampleRate, data }), truncated: r.buffer.duration > MAX_SAMPLE_SEC + 1e-6 };
}

/** Audible sources and the end of the Space timeline (listener time). / 발음 음원과 끝 시각 */
export function getSpaceTimeline(params = getSpaceParams()) {
  const bake = getSpaceBake(params);
  const audible = params.sources.filter((s) => isSourceAudible(s, params));
  let endSec = audible.reduce((m, s) => { const b = bake.sources.get(s.id); return Math.max(m, b ? spaceSourceWindow(s, b).t1 : 0); }, 0);
  if (endSec > 0 && roomActive(params)) { // reflections arrive later, the reverb rings on / 반사는 더 늦게 도착하고 잔향은 이어짐
    const room = roomOf(params);
    endSec = Math.max(endSec, roomEndSec(params, audible.map((s) => s.id))) + reverbTailSec(room);
  }
  return { bake, audible, endSec };
}

// --------------------------------------------------------------------------
// Loudspeaker arrays and user HRIR (modules/speaker-arrays.js, audio/hrir-store.js)
// 스피커 배열과 사용자 HRIR
// --------------------------------------------------------------------------

/**
 * Everything the array output of a document needs at a sample rate:
 * { layout, dec, route, trimDb, dists, delays (samples), channels }.
 * 문서의 배열 출력에 필요한 것 (배치·디코더·라우팅·트림·지연).
 */
export function arraySetup(params, sampleRate = EXPORT_SAMPLE_RATE) {
  const a = arraySettings(params);
  const layout = getLayout(a.layout, a.custom);
  const dec = createArrayDecoder(layout, { order: params.spatial?.order || 3, weighting: params.spatial?.weighting, method: a.method, energyNorm: a.energyNorm });
  const dists = dec.dist.map((d, k) => (Number.isFinite(a.dist[k]) && a.dist[k] !== null ? a.dist[k] : d));
  const route = dec.chan.map((c, k) => (Number.isInteger(a.route[k]) ? a.route[k] : c));
  const trimDb = dec.chan.map((_, k) => Number(a.trimDb[k]) || 0);
  return { layout, dec, route, trimDb, dists, delays: delayCompensation(dists, sampleRate), channels: Math.max(dec.channels, ...route.map((c) => c + 1)) };
}

/** Can the device play the array? { ok, need, have }. / 장치가 배열을 낼 수 있는가 */
export function arrayLiveSupport(maxChannels, need) {
  const have = Math.max(0, Math.floor(Number(maxChannels) || 0));
  return { ok: have > 2 && have >= need, need, have };
}

/**
 * Options of the HOA monitor on two channels (createBinauralSpeakers): the virtual loudspeakers of
 * the Binaural mode, or — in Array mode — the loudspeakers of the array, heard over headphones.
 * A user HRIR set replaces the browser's HRTF in both.
 * 2채널 HOA 모니터 옵션: 바이노럴 모드의 가상 스피커, 또는 배열 모드에서는 배열의 스피커를 헤드폰으로.
 */
export function hoaMonitorOptions(params, sampleRate = EXPORT_SAMPLE_RATE) {
  const hrir = params.spatial?.hrir ? hrirFor(params.spatial.hrir) : null;
  if (params.panMode === 'array') return { dec: arraySetup(params, sampleRate).dec, hrir };
  return { order: params.spatial?.order, weighting: params.spatial?.weighting, hrir };
}

const boomCache = new Map();
/** N-wave: a pressure jump, a linear fall through zero and a jump back (the signature of a sonic boom). / N파 */
function boomBuffer(ctx, lead, seconds = 0.03) {
  const key = `${ctx.sampleRate}|${lead.toFixed(6)}`;
  let buf = boomCache.get(key);
  if (!buf) {
    const n = Math.max(8, Math.round(seconds * ctx.sampleRate));
    const pre = Math.round(lead * ctx.sampleRate); // silence up to the moment of the shock / 충격 순간까지의 무음
    buf = new AudioBuffer({ length: pre + n + 2, numberOfChannels: 1, sampleRate: ctx.sampleRate });
    const x = buf.getChannelData(0);
    for (let i = 0; i < n; i++) x[pre + i] = 1 - (2 * i) / (n - 1);
    boomCache.set(key, buf);
    if (boomCache.size > 8) boomCache.delete(boomCache.keys().next().value);
  }
  return buf;
}
export const BOOM_GAIN = 4; // × the source's own level at that distance / 그 거리에서 음원 레벨의 배수
/** The sonic boom of an arrival that begins at a caustic: an N-wave from where the source is heard then. / 소닉 붐 */
function scheduleBoom(ctx, dest, src, arrival, common) {
  const bb = boomBake(arrival);
  if (!bb) return false;
  const boomSrc = { ...src, baseGain: src.baseGain * BOOM_GAIN, doppler: false, input: { kind: 'import', target: 'boom', content: 'doc', trimDb: 0, offset: 0, play: 'once', frozen: null, bypass: false, channel: 'mix' } };
  return scheduleSpaceSource(ctx, dest, boomSrc, bb, { ...common, importBuffer: boomBuffer(ctx, bb.lead), ampMask: null, pitchWarp: null, brightWarp: null });
}

/** Loudest moment of a baked voice (distance law × gain lane). / 베이킹된 보이스의 가장 큰 순간 */
const loudestOf = (b) => { let m = 0; for (let i = 0; i < b.n; i++) { const g = b.gain[i] * (b.gainLane ? b.gainLane[i] : 1); if (g > m) m = g; } return m; };
export const LIGHT_FLOOR_DB = -50; // 'light' playback: reflections this far below the loudest source are left out / 가벼운 재생에서 생략하는 반사
export const LIGHT_REFLECTION_ORDER = 1;
let boundMemo = { key: '', value: 0 };
/**
 * Upper bound of the output level of a scene (1 = full scale): every voice — sources, their extra
 * arrivals, reflections, the reverb send — at its loudest moment, all at once and in phase, times the
 * studio's master gain. Above 1 the output can clip (a crackling distortion) unless the limiter is on.
 * 장면 출력 레벨의 상한 (1 = 풀 스케일): 모든 보이스가 가장 큰 순간에 동시에·동위상으로 겹친 경우. 1을 넘으면 리미터가 꺼져 있을 때 클리핑(지직거림) 가능.
 */
export function spaceLevelBound(params = getSpaceParams()) {
  const { bake, audible } = getSpaceTimeline(params);
  const room = roomActive(params) ? roomOf(params) : null;
  const key = `${bake.sig}|${audible.map((s) => `${s.id}:${s.baseGain}:${s.input?.trimDb || 0}:${s.send ?? 1}`).join(',')}|${room ? JSON.stringify(room) : ''}`;
  if (boundMemo.key === key) return boundMemo.value;
  const images = room && room.quality !== 'off' ? bakeRoom(params).images : null;
  const loudest = loudestOf;
  let sum = 0;
  for (const s of audible) {
    const own = s.baseGain * (s.input?.kind === 'import' ? dbToAmp(s.input.trimDb || 0) : 1);
    for (const arr of bakeArrivals(bake.sources.get(s.id))) sum += own * loudest(arr);
    if (images) for (const im of images.get(s.id) || []) for (const arr of bakeArrivals(im.bake)) sum += own * loudest(arr);
    if (room?.reverb.on) sum += own * room.reverb.level * clamp(Number.isFinite(Number(s.send)) ? Number(s.send) : 1, 0, 4);
  }
  boundMemo = { key, value: SPACE_MASTER * sum };
  return boundMemo.value;
}

const irCache = new Map(); // `${rate}|${channels}|${settings}` → AudioBuffer[] (mono) or one stereo buffer / 임펄스 캐시
function reverbBuffers(ctx, room, channels) {
  const key = `${ctx.sampleRate}|${channels}|${JSON.stringify([room.reverb.rt60, room.reverb.predelay, room.reverb.damp, room.reverb.seed])}`;
  let hit = irCache.get(key);
  if (!hit) {
    const ir = reverbImpulse(room.reverb, ctx.sampleRate, channels);
    if (channels === 2) {
      const buf = new AudioBuffer({ length: ir[0].length, numberOfChannels: 2, sampleRate: ctx.sampleRate });
      buf.getChannelData(0).set(ir[0]);
      buf.getChannelData(1).set(ir[1]);
      hit = [buf];
    } else hit = ir.map((x) => { const buf = new AudioBuffer({ length: x.length, numberOfChannels: 1, sampleRate: ctx.sampleRate }); buf.getChannelData(0).set(x); return buf; });
    irCache.set(key, hit);
    if (irCache.size > 8) irCache.delete(irCache.keys().next().value);
  }
  return hit;
}

/**
 * The diffuse reverb of a pass: returns the node the sources send to.
 *   stereo modes → one convolver with a decorrelated left / right response;
 *   HOA modes    → a first-order diffuse field: four decorrelated responses as W, Y, Z, X (the three
 *                  directional ones at 1 / √3), decoded to the loudspeakers or written to the ambiX bus.
 * 확산 잔향. 스테레오: 좌우 비상관 컨볼버 하나. HOA: 1차 확산장 (W, Y, Z, X 네 개의 비상관 응답)을 스피커로 디코드하거나 ambiX 버스로.
 */
function createReverb(ctx, dest, room, spatial, nodes) {
  const input = ctx.createGain();
  input.channelCount = 1;
  input.channelCountMode = 'explicit';
  if (nodes) nodes.push(input);
  if (!spatial) {
    const cv = ctx.createConvolver();
    cv.normalize = false;
    cv.buffer = reverbBuffers(ctx, room, 2)[0];
    input.connect(cv).connect(dest);
    if (nodes) nodes.push(cv);
    return input;
  }
  // Headphone monitor (binaural, or an array heard over headphones): the two ears only need two
  // decorrelated tails, so the stereo convolver goes straight to the output. Decoding a first-order
  // field through every virtual loudspeaker cost as much as the whole rest of a scene. The diffuse
  // field proper is kept for what is written for loudspeakers: ambiX and array feeds.
  // 헤드폰 모니터: 두 귀에는 비상관 꼬리 두 개면 충분 → 스테레오 컨볼버를 출력으로 바로. 1차 확산장은 ambiX·배열 피드에만.
  if (spatial.mode !== 'ambix' && !spatial.speakers.merger) {
    const cv = ctx.createConvolver();
    cv.normalize = false;
    cv.buffer = reverbBuffers(ctx, room, 2)[0];
    input.connect(cv).connect(dest);
    if (nodes) nodes.push(cv);
    return input;
  }
  const irs = reverbBuffers(ctx, room, 4);
  const order = spatial.mode === 'ambix' ? spatial.order : spatial.speakers.dec.order;
  const comps = Math.min(4, hoaChannels(order));
  for (let c = 0; c < comps; c++) {
    const cv = ctx.createConvolver();
    cv.normalize = false;
    cv.buffer = irs[c];
    input.connect(cv);
    if (nodes) nodes.push(cv);
    const w = c === 0 ? 1 : 1 / Math.sqrt(3);
    if (spatial.mode === 'ambix') {
      const g = ctx.createGain();
      g.gain.value = w;
      cv.connect(g).connect(spatial.bus.inputs[c][0], 0, spatial.bus.inputs[c][1]);
      if (nodes) nodes.push(g);
    } else {
      spatial.speakers.inputs.forEach((inp, k) => {
        const v = spatial.speakers.dec.matrix[k][c] * w;
        if (Math.abs(v) < 1e-9) return;
        const g = ctx.createGain();
        g.gain.value = v;
        cv.connect(g).connect(inp);
        if (nodes) nodes.push(g);
      });
    }
  }
  return input;
}

/** Schedule every audible source (live or offline). / 모든 발음 음원 스케줄 */
export function scheduleSpace(ctx, dest, { params = getSpaceParams(), nowTime, cueSec, nodes, ampMask = null, pitchWarp = null, brightWarp = null, imports = null, ambix = null, arrayBus = null, liveArray = false, timeScale = 1 }) {
  const { bake, audible } = getSpaceTimeline(params);
  const bufs = imports || liveImports(params, ctx.sampleRate);
  // Direction stage shared by every source: ambiX bus (export) or the virtual loudspeakers of the
  // binaural mode; null = one panner per source as before. / 모든 음원이 공유하는 방향 단계
  let spatial = null;
  if (ambix) spatial = { mode: 'ambix', bus: ambix.bus, order: ambix.order };
  else if (arrayBus) spatial = { mode: 'binaural', speakers: arrayBus }; // loudspeaker feeds (export) / 스피커 피드
  else if (liveArray && params.panMode === 'array' && arrayLiveSupport(ctx.destination?.maxChannelCount, arraySetup(params, ctx.sampleRate).channels).ok) {
    // Live on a multichannel device: loudspeaker feeds straight to the device channels. The stereo
    // output stage (Loudness Manager) is not in this path — only its fader level is applied.
    // 다채널 장치에서의 실시간: 스피커 피드를 장치 채널로 바로. 스테레오 출력 단계는 거치지 않고 페이더 레벨만 적용.
    const set = arraySetup(params, ctx.sampleRate);
    const bus = createArrayBus(ctx, set.dec, set);
    const out = ctx.createGain();
    out.gain.value = SPACE_MASTER * currentOutputAmp();
    if (ctx.destination.channelCount < bus.channels) ctx.destination.channelCount = bus.channels;
    bus.merger.connect(out).connect(ctx.destination);
    if (nodes) nodes.push(out, ...bus.nodes);
    spatial = { mode: 'binaural', speakers: bus };
  } else if (isHoaMode(params.panMode) && binauralSupported(ctx)) {
    const speakers = createBinauralSpeakers(ctx, dest, hoaMonitorOptions(params, ctx.sampleRate));
    if (nodes) nodes.push(...speakers.nodes);
    spatial = { mode: 'binaural', speakers };
  }
  // Room (space-room.js): a diffuse reverb fed by every source, and the image sources / 방: 확산 잔향 + 영상 음원
  const active = roomActive(params);
  const room = active ? roomOf(params) : null;
  const reverbSend = room && room.reverb.on && room.reverb.level > 0 ? { node: createReverb(ctx, dest, room, spatial, nodes), level: room.reverb.level, law: room.reverb.law } : null;
  const baked = room && room.quality !== 'off' ? bakeRoom(params).images : null;
  const images = baked && [...baked.values()].some((l) => l.length) ? baked : null; // every surface fully absorbing = no room / 모든 면이 완전 흡수면 방 없음
  const boom = superMode(params) === 'boom';
  // 'light' playback (live only; space-engine.js PLAYBACK_MODES): reflections go through a small set of
  // first-order virtual loudspeakers of their own, and reflections nobody can hear are not scheduled.
  // 가벼운 재생 (실시간 전용): 반사는 자체의 1차 가상 스피커 세트로, 들리지 않는 반사는 스케줄하지 않음.
  const light = liveArray && playbackMode(params) !== 'full';
  let imageSpatial = spatial;
  let floor = 0;
  if (light && images) {
    if (spatial?.mode === 'binaural' && !spatial.speakers.merger && spatial.speakers.inputs.length > 6) {
      // six virtual loudspeakers on the axes: first order, direction in all three dimensions / 축 위 6개: 1차, 3차원 방향 유지
      const low = createBinauralSpeakers(ctx, dest, { dec: getCompactDecoder(params.spatial?.weighting), hrir: hoaMonitorOptions(params, ctx.sampleRate).hrir });
      if (nodes) nodes.push(...low.nodes);
      imageSpatial = { mode: 'binaural', speakers: low };
    }
    let top = 0;
    for (const s of audible) { const b = bake.sources.get(s.id); if (b) top = Math.max(top, s.baseGain * loudestOf(b)); }
    floor = top * Math.pow(10, LIGHT_FLOOR_DB / 20);
  }
  let n = 0;
  for (const s of audible) {
    const common = { nowTime, cueSec, nodes, panMode: params.panMode, rate: params.bakeRate, ampMask, pitchWarp, brightWarp, voiceMod: params.voiceMod, spatial, importBuffer: bufs.get(s.id) || null, phaseExact: !!images, timeScale, economy: light };
    const main = bake.sources.get(s.id);
    if (scheduleSpaceSource(ctx, dest, s, main, reverbSend ? { ...common, reverbSend } : common)) n++;
    // Supersonic source: its other arrivals (space-engine.js bakeGeneral) are voices of their own / 초음속 음원의 다른 도착들
    for (const extra of main?.more || []) scheduleSpaceSource(ctx, dest, s, extra, common);
    if (boom) for (const arr of bakeArrivals(main)) scheduleBoom(ctx, dest, s, arr, common);
    if (images) for (const im of images.get(s.id) || []) for (const arr of bakeArrivals(im.bake)) {
      if (floor > 0 && s.baseGain * loudestOf(arr) < floor) continue;
      scheduleSpaceSource(ctx, dest, s, arr, imageSpatial === spatial ? common : { ...common, spatial: imageSpatial });
    } // a reflection: its own delay, Doppler, direction / 반사: 고유의 지연·도플러·방향
  }
  return n;
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (appState.transport를 갱신해 공용 헤더와 연동)
// --------------------------------------------------------------------------

let lastRestart = 0;
let pendingRestart = null;
let seenKey = null; // the newest sound key that is waiting to be heard / 반영을 기다리는 최신 키
let lastChange = 0;
let changedSince = null;
let restarts = 0;

/** Number of live re-schedules caused by edits (diagnostics). / 편집으로 인한 재스케줄 횟수 */
export const getSpaceRestartCount = () => restarts;

/** What the live pass depends on: physics bake + sonification + audibility. / 재스케줄 판단 키 */
const bufferIds = new WeakMap();
let bufferSeq = 0;
function bufferId(buf) {
  if (!buf) return 0;
  if (!bufferIds.has(buf)) bufferIds.set(buf, ++bufferSeq);
  return bufferIds.get(buf);
}
function soundKey(params, bake, importKey) {
  return `${bake.sig}|${params.panMode}|${isHoaMode(params.panMode) ? `${JSON.stringify(params.spatial)}${params.spatial?.hrir && hrirFor(params.spatial.hrir) ? '+' : ''}` : ''}|${JSON.stringify(params.sources.map((s) => [s.id, s.baseGain, s.timbre, s.lanes?.timbre?.on ? s.timbreB : 0, isSourceAudible(s, params), s.input?.kind === 'import' || s.input?.kind === 'track' ? [s.input, importKey(s)] : 0]))}${roomActive(params) ? `|room${JSON.stringify([roomOf(params), params.sources.map((s) => s.send ?? 1)])}` : ''}`;
}
/** Live pass key: an import contributes its status, so a finished render re-schedules. / 라이브 키 */
function audioKey(params, bake) {
  // the identity of the buffer that would play: 'rendering' with the previous buffer changes nothing yet
  // 재생될 버퍼의 동일성: 이전 버퍼로 계속 재생 중인 'rendering'은 아직 아무것도 바꾸지 않음
  // the playback mode shapes the LIVE graph only, so it is part of this key and not of the render key / 재생 모드는 라이브 키에만
  const key = `${playbackMode(params)}|${soundKey(params, bake, (s) => bufferId(importState(s).buffer))}`;
  return playbackMode(params) === 'prerender' ? `${key}|pre:${prerenderStatus(params)}` : key;
}

// --------------------------------------------------------------------------
// Pre-rendered playback (playback mode 'prerender') / 미리 렌더한 재생
// --------------------------------------------------------------------------

let pre = { key: '', buffer: null, pendingKey: '' };
const preListeners = new Set();
/** Told when a background render of the scene has finished. Returns unsubscribe. / 장면 렌더 완료 알림 */
export function onSpacePrerender(fn) { preListeners.add(fn); return () => preListeners.delete(fn); }
const preKeyOf = (params, sampleRate) => `${sampleRate}|${soundKey(params, getSpaceBake(params), (s) => bufferId(importState(s, sampleRate).buffer))}`;
const liveRate = () => getAudioCtx()?.sampleRate || EXPORT_SAMPLE_RATE;

/** 'off' | 'rendering' | 'ready' for the scene on screen. / 화면의 장면에 대한 상태 */
export function prerenderStatus(params = getSpaceParams()) {
  if (playbackMode(params) !== 'prerender') return 'off';
  return pre.buffer && pre.key === preKeyOf(params, liveRate()) ? 'ready' : 'rendering';
}

/** The scene without the studio's master gain and output stage (the live chain adds them). / 마스터 게인·출력 단계 없는 장면 렌더 */
async function renderSpaceDry(params, sampleRate) {
  const { endSec } = getSpaceTimeline(params);
  if (endSec <= 0.02) return null;
  const imports = await resolveImports(params, sampleRate, [selfSpaceTarget()]);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  scheduleSpace(ctx, ctx.destination, { params, nowTime: 0, cueSec: 0, imports });
  return ctx.startRendering();
}

/** The rendered scene if it is ready; otherwise starts the render and returns null. / 준비된 렌더 (없으면 렌더 시작) */
function prerendered(params, sampleRate) {
  const key = preKeyOf(params, sampleRate);
  if (pre.buffer && pre.key === key) return pre.buffer;
  if (pre.pendingKey !== key) {
    pre.pendingKey = key;
    renderSpaceDry(params, sampleRate).then((buffer) => {
      if (pre.pendingKey !== key) return; // a newer edit is being rendered / 더 새로운 편집을 렌더 중
      pre = { key, buffer, pendingKey: '' };
      for (const fn of preListeners) { try { fn(); } catch (err) { console.error(err); } }
      try { refreshSpaceAudio(); } catch (err) { console.error(err); }
    }).catch((err) => { console.error('[Flexatone] space pre-render failed:', err); if (pre.pendingKey === key) pre.pendingKey = ''; });
  }
  return null;
}
/**
 * What the rendered sound of a Space document depends on (Manager clip key): physics, sound and the
 * keys of the sounds it imports — never the view. Starts no render. / 렌더된 소리가 의존하는 것 (뷰 제외)
 */
export function spaceRenderKey(params = getSpaceParams()) {
  return soundKey(params, getSpaceBake(params), (s) => (s.input.frozen ? `frozen:${s.input.frozen}` : (() => { const d = describeInstance(s.input.target, s.input.content); return d.ok ? d.key : d.reason; })()));
}
// A finished background render re-schedules the playing pass / 뒤에서 렌더가 끝나면 재생 중인 패스를 다시 스케줄
onInstanceBuffer(() => { try { refreshSpaceAudio(); } catch (err) { console.error(err); } });

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  endSec: () => { const { endSec } = getSpaceTimeline(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getSpaceParams(); const { bake, endSec } = getSpaceTimeline(params); return { params, bake, endSec }; },
  masterGain: () => SPACE_MASTER,
  output: (ctx) => studioLiveOutput(ctx, 'space', () => getSpaceParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params, bake }, { when, fromSec, nodes }) => {
    // Playback mode 'prerender': one buffer instead of the live graph, once it is ready (until then,
    // and right after an edit, the light live graph plays). / 미리 렌더 모드: 준비되면 버퍼 하나로 재생
    const buf = playbackMode(params) === 'prerender' ? prerendered(params, ctx.sampleRate) : null;
    if (buf && fromSec < buf.duration - 0.01) {
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(master);
      node.start(when, Math.max(0, fromSec));
      if (nodes) nodes.push(node);
    } else scheduleSpace(ctx, master, { params, nowTime: when, cueSec: fromSec, nodes, liveArray: true });
    return { key: audioKey(params, bake) };
  },
  onClear: () => { if (pendingRestart !== null) clearTimeout(pendingRestart); pendingRestart = null; },
});

export const isSpacePlaying = transport.isPlaying;
export const getSpacePlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startSpaceAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopSpaceAudio = transport.stop;
/** Pause: stop and pin the cue at the playhead. / 플레이헤드에 큐 고정 후 정지 */
export const pauseSpaceAtPlayhead = transport.pauseAtPlayhead;
export const toggleSpacePause = transport.togglePause;
export const toggleSpacePlay = transport.togglePlay;

/**
 * Called on every workspace render: if the document's sound changed while playing, re-schedule
 * from the playhead (throttled). The bake is cached, so idle renders cost one signature string.
 * 렌더마다 호출: 재생 중 소리가 바뀌었으면 플레이헤드에서 다시 스케줄 (스로틀).
 */
export function refreshSpaceAudio() {
  const live = transport.pass();
  if (!live) return false;
  const params = getSpaceParams();
  const key = audioKey(params, getSpaceBake(params));
  if (key === live.key) { seenKey = null; return false; }
  // Every re-schedule rebuilds the whole graph and restarts the oscillators (a cross-fade between two
  // phases). While a slider is dragged that used to happen 20 times a second — a tearing sound and,
  // with many voices, drop-outs. Now the pass is re-scheduled once the edit has rested.
  // 재스케줄은 그래프 전체를 다시 만들고 오실레이터를 재시작함. 슬라이더를 끄는 동안 초당 20번 일어나 찢어지는 소리와 끊김의 원인이었음 → 편집이 멈춘 뒤 한 번만.
  const nowMs = globalThis.performance?.now() ?? Date.now();
  if (key !== seenKey) { seenKey = key; if (changedSince === null) changedSince = nowMs; lastChange = nowMs; }
  const settled = nowMs - lastChange >= RESTART_SETTLE_MS || nowMs - changedSince >= RESTART_MAX_WAIT_MS;
  const wait = Math.max(RESTART_MIN_MS - (nowMs - lastRestart), settled ? 0 : RESTART_SETTLE_MS - (nowMs - lastChange));
  if (wait > 0) {
    if (pendingRestart !== null) clearTimeout(pendingRestart);
    pendingRestart = setTimeout(() => { pendingRestart = null; refreshSpaceAudio(); }, wait + 2);
    return false;
  }
  changedSince = null;
  seenKey = null;
  lastRestart = globalThis.performance?.now() ?? Date.now();
  restarts++;
  const at = transport.playheadSec();
  const { endSec } = getSpaceTimeline(params);
  if (at >= endSec - 0.02) { live.key = key; return false; }
  transport.restart(Math.max(0, at + START_LEAD_SEC));
  return true;
}

// --------------------------------------------------------------------------
// Offline render, WAV and baked JSON / 오프라인 렌더링, WAV, 베이킹 JSON
// --------------------------------------------------------------------------

/** Stereo offline render; outputStage false for internal checks. / 스테레오 오프라인 렌더 */
/** timeScale = Tempo Manager rate (pitch kept; masks / warps in real time). / timeScale = 음고 유지 배속 */
export async function renderSpaceBuffer({ params = getSpaceParams(), sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null, importChain = null, timeScale = 1 } = {}) {
  const ts = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1;
  const endSec = getSpaceTimeline(params).endSec / ts;
  if (endSec <= 0.02) return null;
  // Imported sounds are rendered first (importChain = targets above this render; null = the editor document)
  // 가져온 소리를 먼저 렌더 (importChain = 이 렌더 위의 대상들, null = 에디터 문서)
  const imports = await resolveImports(params, sampleRate, importChain || [selfSpaceTarget()]);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = SPACE_MASTER;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleSpace(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp, imports, timeScale: ts });
  return ctx.startRendering();
}

/**
 * Offline render of the scene as an ambiX sound field: (order + 1)² channels, ACN order, SN3D.
 * Scene-referred: no output fader, no studio tremolo (both are stereo monitoring stages).
 * 장면을 ambiX 음장으로 오프라인 렌더 ((차수 + 1)² 채널, ACN, SN3D). 출력 페이더·트레몰로 없음.
 */
export async function renderSpaceAmbix({ params = getSpaceParams(), sampleRate = EXPORT_SAMPLE_RATE, order = params.spatial?.order || 3, importChain = null } = {}) {
  const { endSec } = getSpaceTimeline(params);
  if (endSec <= 0.02) return null;
  const imports = await resolveImports(params, sampleRate, importChain || [selfSpaceTarget()]);
  const nCh = hoaChannels(order);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(nCh, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const bus = createAmbixBus(ctx, order);
  const master = ctx.createGain();
  master.gain.value = SPACE_MASTER;
  master.channelCountMode = 'explicit';
  master.channelCount = nCh;
  master.channelInterpretation = 'discrete';
  ctx.destination.channelCount = nCh;
  ctx.destination.channelInterpretation = 'discrete';
  bus.merger.connect(master).connect(ctx.destination);
  scheduleSpace(ctx, master, { params, nowTime: 0, cueSec: 0, imports, ambix: { bus, order } });
  return ctx.startRendering();
}

/**
 * Offline render of the loudspeaker feeds of the array (one channel per output channel; an LFE
 * channel stays silent). Trims, routing and the delay compensation are part of the render.
 * 배열의 스피커 피드 오프라인 렌더 (출력 채널마다 한 채널, LFE는 무음). 트림·라우팅·지연 보정 포함.
 */
export async function renderSpaceArray({ params = getSpaceParams(), sampleRate = EXPORT_SAMPLE_RATE, importChain = null } = {}) {
  const { endSec } = getSpaceTimeline(params);
  if (endSec <= 0.02) return null;
  const imports = await resolveImports(params, sampleRate, importChain || [selfSpaceTarget()]);
  const set = arraySetup(params, sampleRate);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const tail = Math.max(0, ...set.delays) / sampleRate;
  const ctx = new Offline(set.channels, Math.ceil((endSec + 0.05 + tail) * sampleRate), sampleRate);
  const bus = createArrayBus(ctx, set.dec, set);
  const master = ctx.createGain();
  master.gain.value = SPACE_MASTER;
  master.channelCountMode = 'explicit';
  master.channelCount = set.channels;
  master.channelInterpretation = 'discrete';
  ctx.destination.channelCount = set.channels;
  ctx.destination.channelInterpretation = 'discrete';
  bus.merger.connect(master).connect(ctx.destination);
  scheduleSpace(ctx, master, { params, nowTime: 0, cueSec: 0, imports, arrayBus: bus });
  return ctx.startRendering();
}

/** Export the loudspeaker feeds as a multichannel WAV (32-bit float) + a JSON sidecar. / 배열용 다채널 WAV 내보내기 */
export async function exportSpaceArray({ download = true, normalize = false } = {}) {
  const params = getSpaceParams();
  const set = arraySetup(params);
  let buf;
  try { buf = await renderSpaceArray({ params }); } catch (err) { console.error(err); return { ok: false, message: t('space.arrayFail', set.channels) }; }
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const peak = bufferPeak(buf);
  const gain = normalize && peak > 0 ? 0.98 / peak : 1;
  const wav = encodeWavFloat(buf, { gain });
  const safe = String(getActiveSource()?.name || 'Space').replace(/[^A-Za-z0-9_-]+/g, '-');
  const base = `Space_${safe}_${set.layout.id.replace('.', '-')}_${buf.numberOfChannels}ch_T${(buf.length / buf.sampleRate).toFixed(2)}s`;
  const q = arrayMetrics(set.dec);
  const meta = {
    plugin: 'FlexatoneSpaceStudio', format: 'loudspeaker feeds', layout: set.layout.id, channels: buf.numberOfChannels, channelOrder: channelOrderText(set.layout),
    speakers: set.layout.speakers.map((s, i) => ({ channel: i + 1, label: s.label, azimuthRightDeg: s.az, elevationDeg: s.el, lfe: s.lfe })),
    route: set.route.map((c) => c + 1), trimDb: set.trimDb, distanceM: set.dists, delaySamples: set.delays,
    decoder: { order: set.dec.order, askedOrder: set.dec.asked, method: set.dec.method, weighting: set.dec.weighting, energyNorm: set.dec.energyNorm, meanDirectionErrorDeg: Number(q.errMean.toFixed(2)), maxDirectionErrorDeg: Number(q.errMax.toFixed(2)), loudnessSpreadDb: Number((q.energyMaxDb - q.energyMinDb).toFixed(2)) },
    sampleRate: buf.sampleRate, sampleFormat: 'float32', peak: Number((peak * gain).toFixed(6)),
  };
  if (download) {
    triggerDownload(new Blob([wav], { type: 'audio/wav' }), `${base}.wav`);
    triggerDownload(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }), `${base}.json`);
  }
  return { ok: true, filename: `${base}.wav`, bytes: wav.byteLength, channels: buf.numberOfChannels, peak: peak * gain, over: peak * gain > 1, wav, meta, message: t('space.arrayDone', `${base}.wav`, channelOrderText(set.layout)) };
}

let testNodes = [];
/**
 * Test tone: a pink-noise burst from one loudspeaker after the other (channel order). On a device
 * with enough channels it goes to the loudspeakers, otherwise to the headphone monitor.
 * 테스트 톤: 스피커를 하나씩 차례로 울리는 핑크 노이즈 버스트. 채널이 모자라면 헤드폰 모니터로.
 * @returns {{ ok, seconds, live }}
 */
export function playArrayTest(params = getSpaceParams(), { burst = 0.35, gap = 0.2, level = 0.2 } = {}) {
  const ctx = getAudioCtx();
  if (!ctx) return { ok: false, seconds: 0, live: false };
  for (const n of testNodes) { try { n.stop?.(); n.disconnect(); } catch { /* already gone */ } }
  testNodes = [];
  const set = arraySetup(params, ctx.sampleRate);
  const live = arrayLiveSupport(ctx.destination.maxChannelCount, set.channels).ok;
  let speakers;
  if (live) {
    speakers = createArrayBus(ctx, set.dec, set);
    const out = ctx.createGain();
    out.gain.value = currentOutputAmp();
    if (ctx.destination.channelCount < speakers.channels) ctx.destination.channelCount = speakers.channels;
    speakers.merger.connect(out).connect(ctx.destination);
    testNodes.push(out);
  } else speakers = createBinauralSpeakers(ctx, getOutputBus(ctx), hoaMonitorOptions({ ...params, panMode: 'array' }, ctx.sampleRate));
  testNodes.push(...speakers.nodes);
  // Pink noise (Paul Kellet's filter) / 핑크 노이즈
  const len = Math.ceil(burst * ctx.sampleRate);
  const noise = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: ctx.sampleRate });
  const x = noise.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const fade = Math.min(1, i / 240, (len - i) / 240);
    x[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2 * fade;
  }
  const t0 = ctx.currentTime + 0.08;
  speakers.inputs.forEach((inp, k) => {
    const node = ctx.createBufferSource();
    node.buffer = noise;
    const g = ctx.createGain();
    g.gain.value = level;
    node.connect(g).connect(inp);
    node.start(t0 + k * (burst + gap));
    testNodes.push(node, g);
  });
  return { ok: true, seconds: speakers.inputs.length * (burst + gap), live, count: speakers.inputs.length };
}

/** Export the scene as an ambiX WAV (32-bit float, WAVE_FORMAT_EXTENSIBLE) + a JSON sidecar. / ambiX WAV 내보내기 */
export async function exportSpaceAmbix({ download = true, normalize = false } = {}) {
  const params = getSpaceParams();
  const order = params.spatial?.order || 3;
  let buf;
  try { buf = await renderSpaceAmbix({ params, order }); } catch (err) { console.error(err); return { ok: false, message: t('space.ambixFail', order) }; }
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const peak = bufferPeak(buf);
  const gain = normalize && peak > 0 ? 0.98 / peak : 1;
  const wav = encodeWavFloat(buf, { gain });
  const active = getActiveSource();
  const safe = String(active?.name || 'Space').replace(/[^A-Za-z0-9_-]+/g, '-');
  const base = `Space_${safe}_HOA${order}_ACN_SN3D_T${(buf.length / buf.sampleRate).toFixed(2)}s`;
  const meta = { plugin: 'FlexatoneSpaceStudio', format: 'ambiX', order, channels: buf.numberOfChannels, channelOrder: 'ACN', normalization: 'SN3D', axes: 'x front, y left, z up', sampleRate: buf.sampleRate, sampleFormat: 'float32', peak: Number((peak * gain).toFixed(6)), gain: Number(gain.toFixed(6)), outputFader: 'not applied (scene-referred)', listener: params.listener, c: params.c, cScale: params.cScale };
  if (download) {
    triggerDownload(new Blob([wav], { type: 'audio/wav' }), `${base}.wav`);
    triggerDownload(new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' }), `${base}.json`);
  }
  return { ok: true, filename: `${base}.wav`, bytes: wav.byteLength, channels: buf.numberOfChannels, peak: peak * gain, over: peak * gain > 1, wav, meta, message: peak * gain > 1 ? t('space.ambixOver', `${base}.wav`, (20 * Math.log10(peak)).toFixed(1)) : t('toast.wavDone', `${base}.wav`) };
}

/** Render the baked scene at 48 kHz / 16-bit stereo and download it. / 스테레오 WAV 내보내기 */
export async function exportSpaceWav({ download = true } = {}) {
  const buf = await renderSpaceBuffer();
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf); // audio-engine encodeWav interleaves N channels / N채널 인터리브 지원
  const active = getActiveSource();
  const safe = String(active?.name || 'Space').replace(/[^A-Za-z0-9_-]+/g, '-');
  const filename = `Space_${safe}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, bytes: wav.byteLength, channels: buf.numberOfChannels, message: t('toast.wavDone', filename) };
}

/** Export the baked arrays as JSON (decimated to 50 Hz). / 베이킹 JSON 내보내기 (50 Hz) */
export function exportSpaceJson({ download = true } = {}) {
  const params = getSpaceParams();
  const bake = getSpaceBake(params);
  const r4 = (x) => Number(x.toFixed(4));
  const { view, tool, ...scene } = params;
  const payload = {
    plugin: 'FlexatoneSpaceStudio',
    version: '0.1',
    scene,
    sources: params.sources.map((s) => {
      const b = bake.sources.get(s.id);
      const step = Math.max(1, Math.round(params.bakeRate / 50));
      const pick = (k) => Array.from(b[k]).filter((_, i) => i % step === 0 || i === b.n - 1).map(r4);
      return { id: s.id, name: s.name, t0: r4(b.t0), t1: r4(b.t1), clamped: b.clamped, maxVc: r4(b.maxVc), t: pick('t'), fObs: pick('fObs'), fs: pick('fs'), gain: pick('gain'), lp: pick('lp'), pan: pick('pan'), r: pick('r'), vr: pick('vr') };
    }),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  if (download) triggerDownload(blob, 'Space_Baked.json');
  return payload;
}

// --------------------------------------------------------------------------
// Audio self-check (offline, no output stage) / 오디오 자가진단
// --------------------------------------------------------------------------

const rms = (a, i0, i1) => {
  let s = 0;
  for (let i = i0; i < i1; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, i1 - i0));
};

registerSelfCheck('Space studio: stereo offline render (pan L→R, right-only static)', async (a) => {
  if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) return;
  const base = createDefaultSpaceParams();
  const pass = normalizeSpaceDoc({ ...base, cScale: 0.5, sources: [createSource(0, { id: 'a', path: { type: 'line', x0: -40, y0: 4, x1: 40, y1: 4 }, speed: { value: 40 }, duration: 2, f: { hz: 440 } })] });
  const buf = await renderSpaceBuffer({ params: pass, sampleRate: 16000, outputStage: false });
  a.equal(buf.numberOfChannels, 2, 'stereo buffer');
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  // Windows away from the heard closest approach (t = 1 s + 4 m / c) / 최근접 시각을 피한 구간
  const tc = 1 + 4 / (343 * 0.5);
  const i0 = Math.floor((tc - 0.15) * buf.sampleRate);
  const i1 = Math.floor((tc + 0.15) * buf.sampleRate);
  a.ok(rms(L, 0, i0) > 4 * rms(R, 0, i0), 'approach louder on the left');
  a.ok(rms(R, i1, L.length) > 4 * rms(L, i1, L.length), 'recede louder on the right');
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  a.ok(peak > 0.005 && peak <= 1, `peak in range (${peak.toFixed(3)})`);
  const right = normalizeSpaceDoc({ ...base, sources: [createSource(0, { id: 'r', path: { type: 'static', x: 10, y: 0 }, duration: 0.5, f: { hz: 300 } })] });
  const rb = await renderSpaceBuffer({ params: right, sampleRate: 16000, outputStage: false });
  const lr = rms(rb.getChannelData(0), 0, rb.length);
  const rr = rms(rb.getChannelData(1), 0, rb.length);
  a.ok(rr > 0.01 && lr < rr * 1e-3, `pan = 1 → left silent (L ${lr.toExponential(1)}, R ${rr.toFixed(3)})`);
}, { group: 'studio' });

registerSelfCheck('space-a: timbre lane crossfades A → B (offline); sources without the lane keep one oscillator', async (a) => {
  if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) return;
  const ramp = { engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y: 0, handles: [] }, { x: 1, y: 1, handles: [] }] };
  const mk = (on) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, sources: [createSource(0, {
    id: on ? 'm1' : 'm0', path: { type: 'static', x: 0, y: 5 }, duration: 2, f: { hz: 220 },
    timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, timbreB: { sine: 0, tri: 0, saw: 1, sqr: 0, rich: 0 },
    airAbsorb: false, lanes: { timbre: { on, domain: 'time', min: 0, max: 1, scale: 'lin', curve: ramp } },
  })] });
  // brightness proxy: RMS of the first difference over the RMS / 밝기 대용값: 1차 차분 RMS ÷ RMS
  const bright = (x, i0, i1) => { let d = 0, e = 0; for (let i = i0 + 1; i < i1; i++) { d += (x[i] - x[i - 1]) ** 2; e += x[i] * x[i]; } return Math.sqrt(d / Math.max(1e-12, e)); };
  const buf = await renderSpaceBuffer({ params: mk(true), sampleRate: 16000, outputStage: false });
  const x = buf.getChannelData(0);
  const n = x.length;
  const head = bright(x, Math.floor(0.05 * n), Math.floor(0.2 * n));
  const tail = bright(x, Math.floor(0.75 * n), Math.floor(0.9 * n));
  a.ok(tail > 2 * head, `brighter at the end (A sine → B saw): ${head.toFixed(3)} → ${tail.toFixed(3)}`);
  const count = (doc) => { const nodes = []; const ctx = new (globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)(2, 1600, 16000); scheduleSpace(ctx, ctx.destination, { params: doc, nowTime: 0, cueSec: 0, nodes }); return nodes.length; };
  a.equal(count(mk(false)), 4, 'lane off → oscillator, filter, gain, panner only');
  a.equal(count(mk(true)), 8, 'lane on → + second oscillator, two crossfade gains and their sum');
}, { group: 'studio' });
