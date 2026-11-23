/**
 * Flexatone — studios/draw/draw-audio.js
 * Draw Studio audio tier: plays and renders the PROCESSED (cached) stroke splines only.
 * 드로잉 스튜디오 오디오: 처리·캐시된 획 스플라인만 재생·렌더링.
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — only
 * ui/workspaces.js (and draw-panels.js) import it. The pure files never import it.
 *
 * Graph per stroke piece / 조각별 그래프
 *   Oscillator (PeriodicWave = 5-wave mix, frequency = setValueCurveAtTime of the fitted spline)
 *     → Gain (baseGain · width→gain, 0 width = silence) → master → output bus (never destination)
 * The frequency curve is sampled from the same customPoints the Bake writes, so the Glissando
 * voices sound like the Draw Studio. No pipeline work at playback: cache lookups only.
 * 주파수 곡선은 베이킹과 같은 customPoints에서 샘플링 — 재생 시 캐시 조회만.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { timbreSampleSpec } from '../../modules/sample-source.js';
import { createToneSource, skipSampleRead } from '../../audio/sample-voice.js';
import { createVoiceModEvaluator, voiceModFreqCurve, voiceModGainCurve, voiceModIndex } from '../../core/voice-mod.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { ensureAudioCtx, getAudioCtx, encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport, fadeOutPass, soundKey } from '../../audio/live-transport.js';
import { piecePitchAt, pieceGainAt } from './draw-engine.js';
import { getDrawParams, getProcessedMap, isStrokeAudible } from '../draw-studio.js';

/** Same master gain live and offline → Export WAV = what you hear. / 실시간·오프라인 동일 */
export const DRAW_MASTER = 0.32;
const START_LEAD_SEC = 0.03;
const F_MIN = 20;
const F_MAX = 20000;

/** Schedule one piece from `cueSec` at context time `nowTime`. / 조각 하나 스케줄 */
export function schedulePiece(ctx, dest, stroke, piece, nowTime, cueSec, nodeList, waveCache, ampMask = null, pitchWarp = null, brightWarp = null, voiceMod = null) {
  const end = piece.t0 + piece.dur;
  if (end <= cueSec + 1e-4) return false;
  const from = Math.max(piece.t0, cueSec);
  const playDur = end - from;
  if (playDur <= 0.01) return false;
  const delay = Math.max(0, piece.t0 - cueSec);
  const key = JSON.stringify(stroke.timbre);
  let wave = waveCache.get(key);
  if (!wave) {
    wave = createTimbreWave(ctx, stroke.timbre); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
    waveCache.set(key, wave);
  }
  // Per-stroke Sampler: the stroke plays its sound-file region along its line (tape)
  // 획별 샘플러: 획이 선을 따라 사운드 파일 구간을 재생 (테이프)
  const osc = createToneSource(ctx, { sample: timbreSampleSpec(stroke.timbre), wave });
  skipSampleRead(osc, (sec) => midiToFreq(piecePitchAt(piece, sec)), piece.t0, from);
  const g = ctx.createGain();
  const n = Math.max(24, Math.min(4096, Math.ceil(playDur * 200)));
  const fc = new Float32Array(n);
  const gc = new Float32Array(n);
  const fade = Math.min(0.008, playDur * 0.1);
  for (let i = 0; i < n; i++) {
    const loc = (i / (n - 1)) * playDur;
    const sec = from + loc;
    const hz = midiToFreq(piecePitchAt(piece, sec));
    fc[i] = clamp(pitchWarp ? pitchWarp(sec, hz) : hz, F_MIN, F_MAX); // Manager Warp / 매니저 곡률
    let gain = stroke.baseGain * pieceGainAt(piece, stroke, sec);
    if (loc < fade) gain *= loc / fade;
    if (playDur - loc < fade) gain *= (playDur - loc) / fade;
    if (ampMask) gain *= ampMask(sec, fc[i]); // Manager shape mask (document sec, Hz) / 매니저 모양 마스크
    gc[i] = Math.max(0, gain);
  }
  const t0 = nowTime + delay;
  // Per-voice tremolo / vibrato on document time, so the pieces of one stroke stay continuous / 보이스별 변조 (문서 시간)
  const vm = createVoiceModEvaluator(voiceMod, voiceModIndex(stroke.id), piecePitchAt(piece, piece.t0));
  osc.frequency.setValueCurveAtTime(voiceModFreqCurve(vm, fc, from, playDur), t0, playDur);
  g.gain.setValueAtTime(0, nowTime);
  g.gain.setValueCurveAtTime(voiceModGainCurve(vm, gc, from, playDur), t0, playDur);
  if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
    const sh = createBrightShelf(ctx, fc, (i) => from + (i / (n - 1)) * playDur, brightWarp, t0, playDur);
    osc.connect(sh).connect(g).connect(dest);
    if (nodeList) nodeList.push(sh);
  } else osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + playDur + 0.01);
  if (nodeList) nodeList.push(osc, g);
  return true;
}

/** Audible pieces and the end of the timeline. / 발음 조각과 타임라인 끝 */
export function getDrawTimeline(params = getDrawParams(), map = getProcessedMap(params)) {
  const items = [];
  let endSec = 0;
  for (const s of params.strokes) {
    if (!isStrokeAudible(s, params)) continue;
    for (const piece of map.get(s.id)?.pieces || []) {
      items.push({ stroke: s, piece });
      endSec = Math.max(endSec, piece.t0 + piece.dur);
    }
  }
  return { items, endSec };
}

/**
 * Master gain with a static headroom guard: the worst-case in-phase sum of every audible piece's
 * amplitude (baseGain · width gain, sampled over the timeline) stays ≤ 0.98 before the output
 * stage. Same value live and offline. / 최악의 동위상 합이 0.98 이하가 되도록 마스터를 낮춤 (실시간·오프라인 동일).
 */
export function drawMasterGain(params = getDrawParams()) {
  const { items, endSec } = getDrawTimeline(params);
  if (!items.length) return DRAW_MASTER;
  const N = 256;
  let peak = 0;
  for (let i = 0; i <= N; i++) {
    const sec = (i / N) * endSec;
    let sum = 0;
    for (const { stroke, piece } of items) if (sec >= piece.t0 && sec <= piece.t0 + piece.dur) sum += Math.abs(stroke.baseGain) * pieceGainAt(piece, stroke, sec);
    if (sum > peak) peak = sum;
  }
  return peak * DRAW_MASTER > 0.98 ? 0.98 / peak : DRAW_MASTER;
}

export function scheduleDraw(ctx, dest, { params = getDrawParams(), nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const waveCache = new Map();
  let n = 0;
  for (const { stroke, piece } of getDrawTimeline(params).items) if (schedulePiece(ctx, dest, stroke, piece, nowTime, cueSec, nodeList, waveCache, ampMask, pitchWarp, brightWarp, params.voiceMod)) n++;
  return n;
}

// --------------------------------------------------------------------------
// Live transport / 실시간 트랜스포트
// --------------------------------------------------------------------------

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  editKey: () => soundKey(getDrawParams()), // edits while playing are heard from the playhead / 재생 중 편집을 플레이헤드부터 반영
  endSec: () => { const { endSec } = getDrawTimeline(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getDrawParams(); return { params, endSec: getDrawTimeline(params).endSec }; },
  masterGain: ({ params }) => drawMasterGain(params),
  output: (ctx) => studioLiveOutput(ctx, 'draw', () => getDrawParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params }, { when, fromSec, nodes }) => { scheduleDraw(ctx, master, { params, nowTime: when, cueSec: fromSec, nodeList: nodes }); },
});

export const isDrawPlaying = transport.isPlaying;
export const getDrawPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startDrawAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopDrawAudio = transport.stop;
export const toggleDrawPause = transport.togglePause;
export const toggleDrawPlay = transport.togglePlay;

// --------------------------------------------------------------------------
// One-shot preview of a single stroke (after drawing) / 획 하나 미리듣기
// --------------------------------------------------------------------------

let preview = null;
/** Audition one stroke right after it is drawn (skipped while the transport plays). / 그린 직후 미리듣기 */
export async function auditionStroke(stroke, result) {
  if (transport.isPlaying() || !result?.pieces?.length) return;
  await ensureAudioCtx();
  const ctx = getAudioCtx();
  if (preview) fadeOutPass(preview, ctx.currentTime);
  const master = ctx.createGain();
  master.gain.value = Math.min(DRAW_MASTER, 0.98 / Math.max(1e-9, Math.abs(stroke.baseGain)));
  master.connect(studioLiveOutput(ctx, 'draw', () => getDrawParams().tremolo, getOutputBus(ctx))); // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  const nodes = [];
  const t0 = Math.min(...result.pieces.map((p) => p.t0));
  const when = ctx.currentTime + START_LEAD_SEC;
  const wc = new Map();
  for (const piece of result.pieces) schedulePiece(ctx, master, stroke, piece, when, t0, nodes, wc, null, null, null, getDrawParams().voiceMod);
  preview = { nodes, master };
  const dur = Math.max(...result.pieces.map((p) => p.t0 + p.dur)) - t0;
  const mine = preview;
  setTimeout(() => { if (preview === mine) { fadeOutPass(mine, 0); preview = null; } }, (dur + 0.3) * 1000);
}

export function stopAudition() {
  if (preview) fadeOutPass(preview, getAudioCtx()?.currentTime ?? 0);
  preview = null;
}

// --------------------------------------------------------------------------
// Offline render, WAV, JSON / 오프라인 렌더, WAV, JSON
// --------------------------------------------------------------------------

export async function renderDrawBuffer({ params = getDrawParams(), sampleRate = EXPORT_SAMPLE_RATE, channels = 2, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const { endSec } = getDrawTimeline(params);
  if (endSec <= 0.02) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(channels, Math.ceil((endSec + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = drawMasterGain(params);
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleDraw(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  return ctx.startRendering();
}

export async function exportDrawWav({ download = true } = {}) {
  const buf = await renderDrawBuffer();
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const filename = `Draw_${getDrawParams().strokes.length}strokes_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, bytes: wav.byteLength, buffer: buf, message: t('toast.wavDone', filename) };
}

/** Export the processed strokes as JSON (raw + fitted spline per piece). / JSON 내보내기 */
export function exportDrawJson({ download = true } = {}) {
  const params = getDrawParams();
  const map = getProcessedMap(params);
  const payload = {
    plugin: 'FlexatoneDrawStudio',
    version: 1,
    strokes: params.strokes.map((s) => ({
      name: s.name,
      raw: s.raw,
      settings: { reversal: s.reversal, smooth: s.smooth, pitchSnap: s.pitchSnap, scaleId: s.scaleId, snapStrength: s.snapStrength, transform: s.transform, direct: s.direct },
      pieces: (map.get(s.id)?.pieces || []).map((p) => ({ startTime: +p.t0.toFixed(4), duration: +p.dur.toFixed(4), f0Midi: +p.pA.toFixed(4), f1Midi: +p.pB.toFixed(4), customPoints: p.customPoints })),
    })),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  if (download) triggerDownload(blob, 'Draw_Strokes.json');
  return payload;
}
