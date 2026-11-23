/**
 * Flexatone — studios/fractal/fractal-audio.js
 * Fractal Studio audio tier: plays and renders the BAKED voices only.
 * 프랙탈 스튜디오 오디오: 베이킹된 보이스만 재생·렌더링.
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — it may import
 * audio/*, and only ui/workspaces.js (via fractal-panels.js) imports it. The pure plugin files
 * never import it. / 오디오 계층 파일 — 순수 파일은 이 파일을 import하지 않음.
 *
 * Graph per voice / 보이스별 그래프
 *   Oscillator(PeriodicWave = 5-wave mix, frequency = baked Hz curve via setValueCurveAtTime)
 *     → Gain (baked gain curve) → Gain (8 ms fade in/out) → master (0.42/√maxConcurrent)
 *     → transport fade → getOutputBus(ctx)   (offline: createOfflineOutput(ctx))
 * No fractal math at playback: the curves are subarrays of the cached bake.
 * 재생 중 프랙탈 연산 없음: 곡선은 캐시된 베이킹 배열의 부분 배열.
 */

import { t } from '../../core/i18n.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { createVoiceModEvaluator, voiceModFreqCurve, voiceModGainCurve } from '../../core/voice-mod.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport, soundKey } from '../../audio/live-transport.js';
import { getFractalParams, getFractalBake } from '../fractal-studio.js';

const MASTER = 0.42;
const START_LEAD_SEC = 0.03;
const FADE_SEC = 0.008;

const HEADROOM = 0.89; // −1 dBFS / 헤드룸
/**
 * Mix gain: 1/√N loudness scaling, but never more than HEADROOM / (N · max gain) — L-system
 * siblings start at the same pitch and phase and sum coherently, so this bound keeps the
 * pre-output peak ≤ −1 dBFS. / 1/√N 스케일 + 동위상 합에 대한 상한 (출력 단계 전 ≤ −1 dBFS)
 */
export const masterFor = (bake) => {
  const n = Math.max(1, bake.maxConcurrent);
  return Math.min(MASTER / Math.sqrt(n), HEADROOM / (n * Math.max(1e-3, bake.gainMax || 1)));
};

/**
 * Schedule one baked voice from `cueSec` on ctx at context time `nowTime`.
 * 베이킹 보이스 하나를 cueSec부터 nowTime에 스케줄.
 * @returns {boolean} true when something was scheduled
 */
export function scheduleBakedFractalVoice(ctx, dest, v, wave, nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null, voiceMod = null, voiceIndex = 0) {
  const end = v.startSec + v.durSec;
  if (v.durSec <= 0.02 || end <= cueSec + 0.01) return false;
  const n = v.hz.length;
  // first sample at or after the cue / 큐 이후 첫 샘플
  const i0 = Math.max(0, Math.ceil((cueSec - v.startSec) * v.rate - 1e-9));
  if (n - i0 < 3) return false;
  const t0 = nowTime + Math.max(0, v.startSec + i0 / v.rate - cueSec);
  const dur = (n - 1 - i0) / v.rate;
  if (dur <= 0.02) return false;

  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  const env = ctx.createGain();
  const fade = ctx.createGain();
  // Manager Warp: a warped copy (the cached bake stays untouched) / 매니저 곡률: 복사본만 휨 (베이크 캐시는 그대로)
  const hz = pitchWarp ? Float32Array.from(v.hz.subarray(i0), (f, k) => pitchWarp(v.startSec + (i0 + k) / v.rate, f)) : v.hz.subarray(i0);
  // Per-voice tremolo / vibrato (core/voice-mod.js), on voice time / 보이스별 트레몰로·비브라토
  const vm = createVoiceModEvaluator(voiceMod, voiceIndex, 69 + 12 * Math.log2(Math.max(10, hz[0]) / 440));
  const vt = i0 / v.rate;
  osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, hz, vt, dur), t0, dur);
  // no other event inside the curve span (the fade gain is 0 before t0) / 곡선 구간에 다른 이벤트 없음
  let gc = v.gain.subarray(i0);
  if (ampMask) {
    // Manager shape mask (document sec, Hz); copy so the cached bake stays untouched / 매니저 모양 마스크 (베이크 캐시는 그대로)
    gc = Float32Array.from(gc, (g, k) => g * ampMask(v.startSec + (i0 + k) / v.rate, hz[k]));
  }
  env.gain.setValueCurveAtTime(voiceModGainCurve(vm, gc, vt, dur), t0, dur);
  const f = Math.min(FADE_SEC, dur * 0.25);
  fade.gain.setValueAtTime(0, nowTime);
  fade.gain.setValueAtTime(0, t0);
  fade.gain.linearRampToValueAtTime(1, t0 + f);
  fade.gain.setValueAtTime(1, t0 + dur - f);
  fade.gain.linearRampToValueAtTime(0, t0 + dur);
  if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
    const sh = createBrightShelf(ctx, hz, (k) => v.startSec + (i0 + k) / v.rate, brightWarp, t0, dur);
    osc.connect(sh).connect(env).connect(fade).connect(dest);
    if (nodeList) nodeList.push(sh);
  } else osc.connect(env).connect(fade).connect(dest);
  osc.start(t0);
  osc.stop(t0 + dur + 0.01);
  if (nodeList) nodeList.push(osc, env, fade);
  return true;
}

/** Schedule every baked voice (live or offline). / 모든 베이킹 보이스 스케줄 */
export function scheduleFractal(ctx, dest, { params = getFractalParams(), nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const bake = getFractalBake(params); // memoised: no re-bake unless the shape changed / 캐시 사용
  const wave = createTimbreWave(ctx, params.timbre); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
  let count = 0;
  bake.voices.forEach((v, i) => { if (scheduleBakedFractalVoice(ctx, dest, v, wave, nowTime, cueSec, nodeList, ampMask, pitchWarp, brightWarp, params.voiceMod, i)) count++; });
  return count;
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (공용 헤더와 연동)
// --------------------------------------------------------------------------

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  editKey: () => soundKey(getFractalParams()), // edits while playing are heard from the playhead / 재생 중 편집을 플레이헤드부터 반영
  endSec: () => { const { endSec } = getFractalBake(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getFractalParams(); const bake = getFractalBake(params); return { params, bake, endSec: bake.endSec }; },
  masterGain: ({ bake }) => masterFor(bake),
  output: (ctx) => studioLiveOutput(ctx, 'fractal', () => getFractalParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params }, { when, fromSec, nodes }) => { scheduleFractal(ctx, master, { params, nowTime: when, cueSec: fromSec, nodeList: nodes }); },
});

export const isFractalPlaying = transport.isPlaying;
export const getFractalPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startFractalAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopFractalAudio = transport.stop;
/** Pause: stop and pin the cue at the playhead. / 플레이헤드에 큐 고정 후 정지 */
export const pauseFractalAtPlayhead = transport.pauseAtPlayhead;
export const toggleFractalPause = transport.togglePause;
export const toggleFractalPlay = transport.togglePlay;

// --------------------------------------------------------------------------
// Offline render, WAV and JSON / 오프라인 렌더링, WAV, JSON
// --------------------------------------------------------------------------

/**
 * Render the baked voices offline. outputStage:false is for internal checks only (skips the
 * Loudness Manager fader/limiter). / 오프라인 렌더 (outputStage:false = 내부 점검용)
 */
export async function renderFractalBuffer({ params = getFractalParams(), sampleRate = EXPORT_SAMPLE_RATE, channels = 2, outputStage = true, maxSec = Infinity, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const bake = getFractalBake(params);
  const endSec = Math.min(bake.endSec, maxSec);
  if (endSec <= 0.02) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(channels, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = masterFor(bake);
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleFractal(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  return ctx.startRendering();
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportFractalWav({ download = true } = {}) {
  const params = getFractalParams();
  const buf = await renderFractalBuffer({ params });
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const filename = `Fractal_${params.mode}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, bytes: wav.byteLength, buffer: buf, message: t('toast.wavDone', filename) };
}

/** Export the document + baked voices (decimated to 50 pts/s). / 문서와 베이킹 보이스 JSON */
export function exportFractalJson({ download = true } = {}) {
  const params = getFractalParams();
  const bake = getFractalBake(params);
  const payload = {
    plugin: 'FlexatoneFractalStudio',
    version: '0.1',
    document: params,
    analysis: bake.analysis,
    info: bake.info,
    voices: bake.voices.map((v) => {
      const step = Math.max(1, Math.round(v.rate / 50));
      const pts = [];
      for (let i = 0; i < v.midi.length; i += step) pts.push({ t: Number((v.startSec + i / v.rate).toFixed(4)), midi: Number(v.midi[i].toFixed(3)), gain: Number(v.gain[i].toFixed(3)) });
      return { name: v.name, level: v.level, startSec: v.startSec, durSec: v.durSec, points: pts };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  if (download) triggerDownload(blob, `Fractal_${params.mode}_baked.json`);
  return payload;
}
