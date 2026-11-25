/**
 * Flexatone — studios/field/field-audio.js
 * Field Studio audio tier: plays and renders BAKED particle trajectories only.
 * 필드 스튜디오 오디오: 베이킹된 입자 궤적만 재생·렌더링.
 *
 * Layer note / 계층 메모: this file lives in the studio folder (as requested) but belongs to the
 * audio tier — it may import audio/*, and only ui/studio-host.js (and main.js) import it. The
 * pure plugin files (field-studio.js, vector-field-engine.js) never import it.
 * 요청된 경로에 있지만 오디오 계층 파일 — ui/studio-host.js만 import함.
 *
 * Graph per particle / 입자별 그래프
 *   Oscillator(PeriodicWave = 5-wave mix + Curvature→Bright boost, frequency curve)
 *     → BiquadFilter lowpass (cutoff = f·(1.5 + 8·bright·curv))  → Gain (baseGain · Speed→Gain)
 *     → master (0.35 live / 0.42 offline) → transport fade → destination
 * No field math at playback: every curve comes from lookupBakedSample() over the cached array.
 * 재생 중 벡터장 연산 없음: 모든 곡선은 캐시된 배열 조회로 생성.
 */

import { clipWindow } from '../../core/line-clip.js';
import { applyAdsrToCurve } from '../../core/adsr.js';
import { timbreSpecAdsr } from '../../modules/timbre-spec.js';
import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { createTimbreWave, studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { timbreSampleSpec } from '../../modules/sample-source.js';
import { createToneSource, skipSampleRead } from '../../audio/sample-voice.js';
import { createVoiceModEvaluator, voiceModFreqCurve, voiceModGainCurve, voiceModIndex } from '../../core/voice-mod.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport, soundKey } from '../../audio/live-transport.js';
import { createVoiceTremoloEvaluator, tremoloCurveRate } from '../../modules/tremolo.js';
import { lookupBakedSample, lookupBakedSampleExt } from './vector-field-engine.js';
import { getFieldParams, getBakedMap, getActiveParticle, isParticleAudible } from '../field-studio.js';

export { lookupBakedSample };

const LIVE_MASTER = 0.35;
const OFFLINE_MASTER = 0.42;
const START_LEAD_SEC = 0.03;

/** PeriodicWave from the shared 5-wave mixer, with the Curvature→Bright boost. / 음색 파형 */
export function buildFieldWave(ctx, timbre, brightBoost = 0) {
  // ƒ(x) mode plays the function wave as written; the Bright boost shapes the 5-wave Mix only.
  // ƒ(x) 모드는 함수 파형 그대로, 밝기 부스트는 5파형 믹스에만 적용
  if (timbre?.mode === 'func') return createTimbreWave(ctx, timbre);
  const w = { ...timbre, saw: (timbre?.saw || 0) + brightBoost * 0.45, rich: (timbre?.rich || 0) + brightBoost * 0.45 };
  return createTimbreWave(ctx, w);
}

/**
 * Schedule one particle from `cueSec` onto ctx at context time `nowTime`.
 * 입자 하나를 cueSec부터 ctx의 nowTime에 스케줄.
 * @returns {boolean} true when something was scheduled
 */
export function scheduleBakedVoice(ctx, dest, v, pts, nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null, voiceMod = null) {
  if (v.duration <= 0.02) return false;
  // Play range (core/line-clip.js): only [s0, s1] of the trajectory sounds / 재생 구간만 소리
  const win = clipWindow(v.clip, v.startTime, v.duration);
  const vStart = win.s0;
  const vEnd = win.s1;
  if (vEnd <= cueSec + 1e-4 || vEnd - vStart <= 0.02) return false;
  const delay = Math.max(0, vStart - cueSec);
  const trim = Math.max(0, cueSec - vStart);
  const playDur = vEnd - Math.max(vStart, cueSec);
  if (playDur <= 0.01) return false;

  // Per-particle Sampler (tape) / 입자별 샘플러 (테이프)
  const smp = timbreSampleSpec(v.timbre);
  const osc = createToneSource(ctx, { sample: smp, wave: smp ? null : buildFieldWave(ctx, v.timbre, (v.curvToBright || 0) * 0.5) });
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  const gainNode = ctx.createGain();

  // Tremolo (per particle, null when off): needs a denser curve than the trajectory alone.
  // 파티클별 트레몰로 (꺼짐 = null): 궤적만 있을 때보다 촘촘한 곡선 필요
  const trem = createVoiceTremoloEvaluator(v);
  const samples = trem
    ? Math.max(24, Math.min(16384, Math.ceil(playDur * Math.max(100, tremoloCurveRate([v])))))
    : Math.max(24, Math.min(1024, Math.ceil(playDur * 100)));
  const freqCurve = new Float32Array(samples);
  const gainCurve = new Float32Array(samples);
  const filtCurve = new Float32Array(samples);
  const f0 = midiToFreq(v.f0Midi);
  const f1 = midiToFreq(v.f1Midi);
  const fade = Math.min(0.008, playDur * 0.1);

  for (let i = 0; i < samples; i++) {
    const frac = (vStart - v.startTime + trim + (i / (samples - 1)) * playDur) / v.duration;
    const samp = lookupBakedSampleExt(v, pts, frac);
    const locSec = (i / (samples - 1)) * playDur;
    const hz0 = f0 * Math.pow(f1 / f0, samp.y);
    const hz = clamp(pitchWarp ? pitchWarp(Math.max(v.startTime, cueSec) + locSec, hz0) : hz0, 20, 18000); // Manager Warp / 매니저 곡률
    freqCurve[i] = hz;
    let g = v.baseGain * samp.gainMod;
    if (locSec < fade) g *= locSec / fade;
    if (playDur - locSec < fade) g *= (playDur - locSec) / fade;
    if (trem) g *= trem.gainAtSec(Math.max(v.startTime, cueSec) + locSec);
    if (ampMask) g *= ampMask(Math.max(v.startTime, cueSec) + locSec, hz);
    gainCurve[i] = Math.max(0, g);
    // A sample is not a band-limited wave: its low-pass opens 16× wider so the file keeps its colour
    // 샘플은 대역 제한 파형이 아니므로 로우패스를 16배 넓게 열어 원래 음색 유지
    filtCurve[i] = clamp(hz * (smp ? 16 : 1) * (1.5 + (v.curvToBright || 0) * 8.0 * samp.curv), 180, 18000);
  }
  if (smp) skipSampleRead(osc, (sec) => {
    const s = lookupBakedSampleExt(v, pts, (sec - v.startTime) / v.duration);
    return f0 * Math.pow(f1 / f0, s.y);
  }, vStart, Math.max(vStart, cueSec));

  const t0 = nowTime + delay;
  // Per-voice tremolo / vibrato (core/voice-mod.js), in voice time / 보이스별 트레몰로·비브라토
  const vm = createVoiceModEvaluator(voiceMod, voiceModIndex(v.id), (v.f0Midi + v.f1Midi) / 2);
  osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, freqCurve, trim, playDur), t0, playDur);
  filter.frequency.setValueCurveAtTime(filtCurve, t0, playDur);
  gainNode.gain.setValueAtTime(0, nowTime);
  applyAdsrToCurve(timbreSpecAdsr(v.timbre), gainCurve, trim, playDur, vEnd - vStart); // timbre ADSR over the particle / 음색 ADSR
  gainNode.gain.setValueCurveAtTime(voiceModGainCurve(vm, gainCurve, trim, playDur), t0, playDur);
  let tail = osc.connect(filter);
  if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
    const sh = createBrightShelf(ctx, freqCurve, (i) => Math.max(v.startTime, cueSec) + (i / (samples - 1)) * playDur, brightWarp, t0, playDur);
    tail = tail.connect(sh);
    if (nodeList) nodeList.push(sh);
  }
  tail.connect(gainNode).connect(dest);
  osc.start(t0);
  osc.stop(t0 + playDur + 0.01);
  if (nodeList) nodeList.push(osc, filter, gainNode);
  return true;
}

/** Audible particles and the end of the field timeline. / 발음 입자와 타임라인 끝 */
export function getFieldTimeline(params = getFieldParams()) {
  const audible = params.voices.filter((v) => isParticleAudible(v, params));
  const endSec = audible.reduce((m, v) => Math.max(m, clipWindow(v.clip, v.startTime, v.duration).s1), 0);
  return { audible, endSec };
}

/** Schedule every audible particle (live or offline). / 모든 발음 입자 스케줄 */
export function scheduleField(ctx, dest, { params = getFieldParams(), nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const baked = getBakedMap(params); // memoised: no integration unless physics changed / 캐시 사용
  let n = 0;
  for (const v of getFieldTimeline(params).audible) if (scheduleBakedVoice(ctx, dest, v, baked.get(v.id), nowTime, cueSec, nodeList, ampMask, pitchWarp, brightWarp, params.voiceMod)) n++;
  return n;
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (appState.transport를 갱신해 공용 헤더와 연동)
// --------------------------------------------------------------------------

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  editKey: () => soundKey(getFieldParams()), // edits while playing are heard from the playhead / 재생 중 편집을 플레이헤드부터 반영
  endSec: () => { const { endSec } = getFieldTimeline(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getFieldParams(); return { params, endSec: getFieldTimeline(params).endSec }; },
  masterGain: () => LIVE_MASTER,
  output: (ctx) => studioLiveOutput(ctx, 'field', () => getFieldParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params }, { when, fromSec, nodes }) => { scheduleField(ctx, master, { params, nowTime: when, cueSec: fromSec, nodeList: nodes }); },
});

export const isFieldPlaying = transport.isPlaying;
export const getFieldPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startFieldAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopFieldAudio = transport.stop;
/** Pause: stop and pin the cue at the playhead. / 플레이헤드에 큐 고정 후 정지 */
export const pauseFieldAtPlayhead = transport.pauseAtPlayhead;
export const toggleFieldPause = transport.togglePause;
export const toggleFieldPlay = transport.togglePlay;

// --------------------------------------------------------------------------
// Offline render, WAV and baked JSON / 오프라인 렌더링, WAV, 베이킹 JSON
// --------------------------------------------------------------------------

export async function renderFieldBuffer({ params = getFieldParams(), sampleRate = EXPORT_SAMPLE_RATE, channels = 2, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const { endSec } = getFieldTimeline(params);
  if (endSec <= 0.02) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(channels, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = OFFLINE_MASTER;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleField(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  return ctx.startRendering();
}

/** Render the baked field at 48 kHz / 16-bit and download it. / 48 kHz WAV 내보내기 */
export async function exportFieldWav({ download = true } = {}) {
  const buf = await renderFieldBuffer();
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const active = getActiveParticle();
  const safe = String(active?.name || 'Field').replace(/[^A-Za-z0-9_-]+/g, '-');
  const filename = `Field_${safe}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, bytes: wav.byteLength, message: t('toast.wavDone', filename) };
}

/** Export the baked trajectories as plugin JSON (prototype format). / 베이킹 JSON 내보내기 */
export function exportBakedJson({ download = true } = {}) {
  const params = getFieldParams();
  const baked = getBakedMap(params);
  const { voices, view, activeVoiceId, cueSec, ...field } = params;
  const payload = {
    plugin: 'VectorFieldGlissandoPlugin',
    version: '1.1',
    field,
    guiding: params.guiding,
    voices: voices.map((v) => ({
      name: v.name, f0Midi: v.f0Midi, f1Midi: v.f1Midi, startTime: v.startTime, duration: v.duration, baseGain: v.baseGain,
      bakedPoints: (baked.get(v.id) || []).map((p) => ({ x: Number(p.t.toFixed(4)), y: Number(p.y.toFixed(4)), gain: Number(p.normSpeed.toFixed(3)) })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  if (download) triggerDownload(blob, 'VectorField_Baked_PluginData.json');
  return payload;
}
