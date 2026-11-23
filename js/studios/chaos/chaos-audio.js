/**
 * Flexatone — studios/chaos/chaos-audio.js
 * Chaos Studio audio tier: plays and renders the BAKED ensemble only (no integration here).
 * 카오스 스튜디오 오디오: 베이킹된 앙상블만 재생·렌더링 (여기서 적분하지 않음).
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — it may import
 * audio/*, and only ui/workspaces.js + chaos-panels.js import it. / 오디오 계층 파일.
 *
 * Graph per voice / 보이스별 그래프
 *   Oscillator(PeriodicWave = 5-wave mix, frequency from the baked pitch curve)
 *     → BiquadFilter lowpass (cutoff = f · (1.5 + 10 · brightAmt · bright))
 *     → Gain (baseGain · gain / √N) → StereoPanner (width · spread across voices)
 *     → master (live 0.5 / offline 0.5) → getOutputBus(ctx) | createOfflineOutput(ctx)
 *   Flows: setValueCurveAtTime straight from the baked arrays (BAKE_RATE samples / s).
 *   Maps : frequency per note — hold = setValueAtTime + 5 ms linear slew, glide = linearRamp.
 * Live and offline share scheduleChaos(), so Export WAV = what you hear (incl. output fader).
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { createVoiceModEvaluator, voiceModCentsCurve, voiceModGainCurve } from '../../core/voice-mod.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { BAKE_RATE, getChaosSystem } from './chaos-engine.js';
import { getChaosParams, getChaosBake } from '../chaos-studio.js';

const MASTER = 0.5;
const START_LEAD_SEC = 0.03;
const HOLD_SLEW_SEC = 0.005;
const EDGE_FADE_SEC = 0.01;

/** Stereo position of voice i (−1…1). / 보이스 i의 팬 */
export const voicePan = (i, N, width) => (N > 1 ? clamp(width, 0, 1) * ((2 * i) / (N - 1) - 1) : 0);

function buildWave(ctx, timbre) {
  return createTimbreWave(ctx, timbre); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
}

/**
 * Schedule the whole ensemble from `cueSec` at context time `nowTime`.
 * 앙상블 전체를 cueSec부터 nowTime에 스케줄.
 * @returns {number} scheduled voice count
 */
export function scheduleChaos(ctx, dest, { doc = getChaosParams(), B = getChaosBake(doc), nowTime, cueSec = 0, nodeList = null, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const A = B.A;
  const endSec = A.duration;
  if (cueSec >= endSec - 0.02) return 0;
  const k0 = clamp(Math.floor(cueSec * BAKE_RATE), 0, B.M - 2);
  const playDur = (B.M - 1 - k0) / BAKE_RATE;
  if (playDur <= 0.02) return 0;
  const tm = doc.timbre;
  const wave = buildWave(ctx, tm);
  const scale = clamp(Number(tm.baseGain) || 0, 0, 1.5) / Math.sqrt(A.N);
  const brightAmt = clamp(Number(tm.brightAmt) || 0, 0, 1);
  const isMap = A.kind === 'map';
  const n = B.M - k0;
  const fade = Math.min(EDGE_FADE_SEC, playDur * 0.1);
  let count = 0;
  B.voices.forEach((v, i) => {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    const g = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const freq = new Float32Array(n);
    const gain = new Float32Array(n);
    const cut = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const hz0 = midiToFreq(v.pitch[k0 + j]);
      const hz = clamp(pitchWarp ? pitchWarp((k0 + j) / BAKE_RATE, hz0) : hz0, 20, 18000); // Manager Warp / 매니저 곡률
      freq[j] = hz;
      let a = scale * v.gain[k0 + j];
      const loc = j / BAKE_RATE;
      if (loc < fade) a *= loc / fade;
      if (playDur - loc < fade) a *= Math.max(0, (playDur - loc) / fade);
      if (ampMask) {
        // Manager shape mask at the sounding pitch (map mode: the held note) / 매니저 모양 마스크 (맵 모드는 현재 음)
        const sec = (k0 + j) / BAKE_RATE;
        const mHz = isMap && !pitchWarp ? midiToFreq(v.notes.pitch[clamp(Math.floor(sec * A.rate + 1e-9), 0, v.notes.pitch.length - 1)]) : hz;
        a *= ampMask(sec, mHz);
      }
      gain[j] = Math.max(0, a);
      cut[j] = clamp(hz * (1.5 + 10 * brightAmt * v.bright[k0 + j]), 120, 18000);
    }
    const t0 = nowTime;
    if (isMap && !pitchWarp) { // warped maps play the (warped) baked curve / 곡률이 있으면 베이킹 곡선으로 재생
      // Per-note frequency events (hold = step + 5 ms slew, glide = linear ramp) / 음 단위 이벤트
      const notes = v.notes.pitch;
      const hold = B.mapping.discrete.mode === 'hold';
      const ramp = hold ? HOLD_SLEW_SEC : B.ramp;
      const n0 = clamp(Math.floor(cueSec * A.rate + 1e-9), 0, notes.length - 1);
      osc.frequency.setValueAtTime(freq[0], t0);
      for (let k = n0 + 1; k < notes.length; k++) {
        const at = t0 + k / A.rate - cueSec;
        if (at <= t0) continue;
        const hz = clamp(midiToFreq(notes[k]), 20, 18000);
        const prev = clamp(midiToFreq(notes[k - 1]), 20, 18000);
        osc.frequency.setValueAtTime(prev, at);
        osc.frequency.linearRampToValueAtTime(hz, at + ramp);
      }
    } else {
      osc.frequency.setValueCurveAtTime(freq, t0, playDur);
    }
    // Per-voice tremolo / vibrato (core/voice-mod.js): vibrato on detune, so map-mode note events stay as they are
    // 보이스별 트레몰로·비브라토: 비브라토는 detune으로 (맵 모드 음 이벤트 유지)
    const vm = createVoiceModEvaluator(doc.voiceMod, i, v.pitch[k0] ?? 60);
    const vib = voiceModCentsCurve(vm, new Float32Array(2), k0 / BAKE_RATE, playDur);
    if (vib.length > 2) osc.detune.setValueCurveAtTime(vib, t0, playDur);
    filter.frequency.setValueCurveAtTime(cut, t0, playDur);
    g.gain.setValueAtTime(0, Math.max(0, nowTime - 0.001));
    g.gain.setValueCurveAtTime(voiceModGainCurve(vm, gain, k0 / BAKE_RATE, playDur), t0, playDur);
    if (pan) pan.pan.value = voicePan(i, A.N, Number(tm.width) || 0);
    if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
      const sh = createBrightShelf(ctx, freq, (j) => (k0 + j) / BAKE_RATE, brightWarp, t0, playDur);
      osc.connect(filter).connect(sh).connect(g);
      if (nodeList) nodeList.push(sh);
    } else osc.connect(filter).connect(g);
    if (pan) g.connect(pan).connect(dest);
    else g.connect(dest);
    osc.start(t0);
    osc.stop(t0 + playDur + 0.02);
    if (nodeList) nodeList.push(osc, filter, g, ...(pan ? [pan] : []));
    count++;
  });
  return count;
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (appState.transport 갱신 → 공용 헤더와 연동)
// --------------------------------------------------------------------------

let refreshTimer = null;

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  endSec: () => getChaosBake().A.duration,
  plan: () => { const doc = getChaosParams(); const B = getChaosBake(doc); return { doc, B, endSec: B.A.duration }; }, // memoised: no integration unless the signature changed / 캐시
  masterGain: () => MASTER,
  output: (ctx) => studioLiveOutput(ctx, 'chaos', () => getChaosParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { doc, B }, { when, fromSec, nodes }) => {
    scheduleChaos(ctx, master, { doc, B, nowTime: when, cueSec: fromSec, nodeList: nodes });
    return { B };
  },
  onClear: () => { if (refreshTimer !== null) clearTimeout(refreshTimer); refreshTimer = null; },
});

export const isChaosPlaying = transport.isPlaying;
export const getChaosPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startChaosAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopChaosAudio = transport.stop;
export const toggleChaosPause = transport.togglePause;
export const toggleChaosPlay = transport.togglePlay;

/** Baked result currently sounding (null when stopped). / 현재 재생 중인 베이킹 결과 */
export function getLiveBake() {
  return transport.pass()?.B || null;
}

/**
 * The document changed while playing: once edits settle (debounced), re-schedule from the
 * playhead with the new bake (cross-fade). Never integrates by itself — it reads the cache the
 * edit already filled. / 재생 중 편집: 디바운스 후 플레이헤드부터 새 베이킹으로 재스케줄.
 */
export function refreshChaosLive(B) {
  const live = transport.pass();
  if (!live || live.B === B) return;
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const pass = transport.pass();
    if (!pass || pass.B === getChaosBake()) return;
    const sec = transport.playheadSec();
    if (sec < pass.endSec - 0.05) transport.restart(sec);
  }, 140);
}

// --------------------------------------------------------------------------
// Offline render, WAV and baked JSON / 오프라인 렌더링, WAV, 베이킹 JSON
// --------------------------------------------------------------------------

export async function renderChaosBuffer({ doc = getChaosParams(), sampleRate = EXPORT_SAMPLE_RATE, channels = 2, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const B = getChaosBake(doc);
  const endSec = B.A.duration;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(channels, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = MASTER;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, doc.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleChaos(ctx, master, { doc, B, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  return ctx.startRendering();
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportChaosWav({ download = true } = {}) {
  const doc = getChaosParams();
  const buf = await renderChaosBuffer({ doc });
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const filename = `Chaos_${getChaosSystem(doc.system).id}_N${doc.voices}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
  return { ok: true, filename, bytes: wav.byteLength, peak, message: t('toast.wavDone', filename) };
}

/** Export the baked curves + analysis as JSON. / 베이킹 곡선·분석 JSON 내보내기 */
export function exportChaosJson({ download = true } = {}) {
  const doc = getChaosParams();
  const B = getChaosBake(doc);
  const A = B.A;
  const stride = 4; // 50 pts / s / 초당 50점
  const r = (x, d = 4) => Number(x.toFixed(d));
  const payload = {
    plugin: 'FlexatoneChaosStudio',
    version: '0.1',
    document: { ...doc, view: undefined },
    analysis: { lyapunov: A.lyapunov, fitSlope: A.fitSlope, divergeSec: A.divergeSec, divergeSim: A.divergeSim, attractorDiameter: A.ref.diam, dt: A.dt, steps: A.steps },
    sampleRate: BAKE_RATE / stride,
    voices: B.voices.map((v, i) => {
      const pick = (arr) => Array.from({ length: Math.ceil(arr.length / stride) }, (_, k) => r(arr[k * stride]));
      return { index: i, pan: voicePan(i, A.N, Number(doc.timbre.width) || 0), pitchMidi: pick(v.pitch), gain: pick(v.gain), bright: pick(v.bright), diverged: A.voices[i].diverged };
    }),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  if (download) triggerDownload(blob, `Chaos_${A.sysId}_Baked.json`);
  return payload;
}
