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
import { getSpaceParams, getSpaceBake, getActiveSource, isSourceAudible } from '../space-studio.js';

export const SPACE_MASTER = 0.45;
const START_LEAD_SEC = 0.03;
const EDGE_FADE_SEC = 0.008;
const MAX_CURVE = 32768;
const RESTART_MIN_MS = 45;

/** PeriodicWave from the shared 5-wave mixer. / 음색 파형 */
function buildWave(ctx, timbre) {
  return createTimbreWave(ctx, timbre || { sine: 1 }); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
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
 */
export function scheduleSpaceSource(ctx, dest, src, b, { nowTime, cueSec, nodes, panMode = 'equalPower', rate = 200, ampMask = null, pitchWarp = null, brightWarp = null, voiceMod = null }) {
  if (!b || b.t1 <= cueSec + 1e-3) return false;
  const from = Math.max(b.t0, cueSec);
  const playDur = b.t1 - from;
  if (playDur <= 0.01) return false;
  const t0 = nowTime + Math.max(0, b.t0 - cueSec);
  const m = clamp(Math.ceil(playDur * rate) + 1, 2, MAX_CURVE);
  const nyq = ctx.sampleRate / 2 - 50;
  const fade = Math.min(EDGE_FADE_SEC, playDur * 0.1);
  const freq = slice(b, 'fObs', from, b.t1, m, (v) => clamp(v, 10, nyq));
  const lp = slice(b, 'lp', from, b.t1, m, (v) => clamp(v, 40, nyq));
  const gain = slice(b, 'gain', from, b.t1, m, (v, i) => {
    const loc = (i / (m - 1)) * playDur;
    let g = Math.max(0, v * src.baseGain);
    if (loc < fade) g *= loc / fade;
    if (playDur - loc < fade) g *= Math.max(0, playDur - loc) / fade;
    return g;
  });
  if (pitchWarp) {
    // Manager Warp at the heard pitch (listener sec, Hz) / 매니저 곡률 (청취 시간, 들리는 주파수)
    for (let i = 0; i < m; i++) freq[i] = clamp(pitchWarp(from + (i / (m - 1)) * playDur, freq[i]), 10, nyq);
  }
  if (ampMask) {
    // Manager shape mask at the heard pitch (listener sec, Hz) / 매니저 모양 마스크 (청취 시간, 들리는 주파수)
    for (let i = 0; i < m; i++) gain[i] *= ampMask(from + (i / (m - 1)) * playDur, freq[i]);
  }

  // Per-source Sampler: the Doppler frequency is the playback rate (tape = physically right)
  // 음원별 샘플러: 도플러 주파수 = 재생 속도 (테이프 방식이 물리적으로 맞음)
  const smp = timbreSampleSpec(src.timbre);
  const osc = createToneSource(ctx, { sample: smp, wave: smp ? null : buildWave(ctx, src.timbre) });
  skipSampleRead(osc, (sec) => { const s = clamp((sec - b.t0) / b.dt, 0, b.n - 1); return b.fObs[Math.round(s)]; }, b.t0, from);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.707;
  const amp = ctx.createGain();
  // Per-voice tremolo / vibrato (core/voice-mod.js), on source time / 음원별 트레몰로·비브라토
  const vm = createVoiceModEvaluator(voiceMod, voiceModIndex(src.id), 69 + 12 * Math.log2(Math.max(10, freq[0]) / 440));
  osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, freq, from - b.t0, playDur), t0, playDur);
  filter.frequency.setValueCurveAtTime(lp, t0, playDur);
  amp.gain.setValueAtTime(0, nowTime);
  amp.gain.setValueCurveAtTime(voiceModGainCurve(vm, gain, from - b.t0, playDur), t0, playDur);
  if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
    const sh = createBrightShelf(ctx, freq, (i) => from + (i / (m - 1)) * playDur, brightWarp, t0, playDur);
    osc.connect(filter).connect(sh).connect(amp);
    if (nodes) nodes.push(sh);
  } else osc.connect(filter).connect(amp);

  let panner;
  if (panMode === 'hrtf' && typeof ctx.createPanner === 'function') {
    panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.rolloffFactor = 0; // distance handled by the baked gain / 거리 감쇠는 베이킹 게인이 담당
    panner.refDistance = 1;
    panner.maxDistance = 10000;
    // Web Audio listener faces −Z: x = right, y = up, z = −forward / 청취자는 −Z를 향함
    panner.positionX.setValueCurveAtTime(slice(b, 'pan', from, b.t1, m), t0, playDur);
    panner.positionY.setValueCurveAtTime(slice(b, 'up', from, b.t1, m), t0, playDur);
    panner.positionZ.setValueCurveAtTime(slice(b, 'fwd', from, b.t1, m, (v) => -v), t0, playDur);
  } else if (typeof ctx.createStereoPanner === 'function') {
    panner = ctx.createStereoPanner();
    panner.pan.setValueCurveAtTime(slice(b, 'pan', from, b.t1, m), t0, playDur);
  } else {
    // Fallback: equal-power PannerNode on the unit circle / StereoPanner 미지원 대체
    panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.rolloffFactor = 0;
    panner.positionX.setValueCurveAtTime(slice(b, 'pan', from, b.t1, m), t0, playDur);
    panner.positionZ.setValueCurveAtTime(slice(b, 'pan', from, b.t1, m, (v) => -Math.sqrt(Math.max(0, 1 - v * v))), t0, playDur);
  }
  amp.connect(panner).connect(dest);
  osc.start(t0);
  osc.stop(t0 + playDur + 0.01);
  if (nodes) nodes.push(osc, filter, amp, panner);
  return true;
}

/** Audible sources and the end of the Space timeline (listener time). / 발음 음원과 끝 시각 */
export function getSpaceTimeline(params = getSpaceParams()) {
  const bake = getSpaceBake(params);
  const audible = params.sources.filter((s) => isSourceAudible(s, params));
  const endSec = audible.reduce((m, s) => Math.max(m, bake.sources.get(s.id)?.t1 || 0), 0);
  return { bake, audible, endSec };
}

/** Schedule every audible source (live or offline). / 모든 발음 음원 스케줄 */
export function scheduleSpace(ctx, dest, { params = getSpaceParams(), nowTime, cueSec, nodes, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const { bake, audible } = getSpaceTimeline(params);
  let n = 0;
  for (const s of audible) if (scheduleSpaceSource(ctx, dest, s, bake.sources.get(s.id), { nowTime, cueSec, nodes, panMode: params.panMode, rate: params.bakeRate, ampMask, pitchWarp, brightWarp, voiceMod: params.voiceMod })) n++;
  return n;
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (appState.transport를 갱신해 공용 헤더와 연동)
// --------------------------------------------------------------------------

let lastRestart = 0;
let pendingRestart = null;
let restarts = 0;

/** Number of live re-schedules caused by edits (diagnostics). / 편집으로 인한 재스케줄 횟수 */
export const getSpaceRestartCount = () => restarts;

/** What the live pass depends on: physics bake + sonification + audibility. / 재스케줄 판단 키 */
function audioKey(params, bake) {
  return `${bake.sig}|${params.panMode}|${JSON.stringify(params.sources.map((s) => [s.id, s.baseGain, s.timbre, isSourceAudible(s, params)]))}`;
}

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  endSec: () => { const { endSec } = getSpaceTimeline(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getSpaceParams(); const { bake, endSec } = getSpaceTimeline(params); return { params, bake, endSec }; },
  masterGain: () => SPACE_MASTER,
  output: (ctx) => studioLiveOutput(ctx, 'space', () => getSpaceParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params, bake }, { when, fromSec, nodes }) => {
    scheduleSpace(ctx, master, { params, nowTime: when, cueSec: fromSec, nodes });
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
  if (key === live.key) return false;
  const wait = RESTART_MIN_MS - ((globalThis.performance?.now() ?? Date.now()) - lastRestart);
  if (wait > 0) {
    if (pendingRestart === null) pendingRestart = setTimeout(() => { pendingRestart = null; refreshSpaceAudio(); }, wait);
    return false;
  }
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
export async function renderSpaceBuffer({ params = getSpaceParams(), sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const { endSec } = getSpaceTimeline(params);
  if (endSec <= 0.02) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = SPACE_MASTER;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleSpace(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  return ctx.startRendering();
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
