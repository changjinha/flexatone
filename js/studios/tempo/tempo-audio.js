/**
 * Flexatone — studios/tempo/tempo-audio.js
 * Tempo Studio audio tier: plays / renders the BAKED curves only, plus the pulse layer.
 * 템포 스튜디오 오디오: 베이킹된 곡선만 재생·렌더링 + 펄스 레이어.
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — it imports
 * audio/*, and only ui/workspaces.js (through tempo-panels.js) imports it. The pure files
 * (tempo-studio.js, tempo-engine.js) never import it.
 *
 * Graph per voice / 보이스별 그래프
 *   Oscillator(PeriodicWave 5-wave mix, frequency = ref, detune curve in cents = log pitch)
 *     → Gain (baseGain · note envelope curve) → pass master → output bus (getOutputBus)
 * Curves come straight from bakeTempo() arrays (BAKE_RATE pts/s, setValueCurveAtTime).
 * Pulse: one short click / tick per beat of each voice, scheduled by a look-ahead timer (live)
 * or all at once (offline). Same scheduler for both. / 실시간은 룩어헤드, 오프라인은 일괄 스케줄.
 */

import { clamp, createSeededRandom } from '../../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { timbreSampleSpec } from '../../modules/sample-source.js';
import { createToneSource, skipSampleRead } from '../../audio/sample-voice.js';
import { createVoiceModEvaluator, voiceModCentsCurve, voiceModGainCurve, voiceModIndex } from '../../core/voice-mod.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { getAudioCtx, encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport, soundKey } from '../../audio/live-transport.js';
import { BAKE_RATE, evalS, rateAt } from './tempo-engine.js';
import { getTempoParams, getTempoBake, isTempoVoiceAudible, voicePitchOffset, getActiveTempoVoice } from '../tempo-studio.js';

const LIVE_MASTER = 0.42;
const OFFLINE_MASTER = 0.42;
const PULSE_MASTER = 0.5;
const START_LEAD_SEC = 0.03;
const EDGE_FADE_SEC = 0.008;
const LOOKAHEAD_SEC = 0.15;
const SCHED_MS = 25;

/** Tick / click frequency of voice i (timbre-only distinction, no pan). / 보이스별 틱 주파수 */
export const pulseFreq = (i) => 800 * Math.pow(2, i / 3);

function buildWave(ctx, timbre) {
  return createTimbreWave(ctx, timbre || { sine: 1 }); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
}

/** Voices that sound, and the level normalisation. / 발음 보이스와 음량 정규화 */
export function getTempoTimeline(doc = getTempoParams(), bake = getTempoBake(doc)) {
  const audible = bake.voices.filter((bv) => bv.has && isTempoVoiceAudible(doc.voices[bv.index], doc));
  const pulseOn = !!doc.pulse.audible && doc.pulse.level > 0;
  return { audible, endSec: doc.length, pulseOn, norm: 1 / Math.sqrt(Math.max(1, audible.length)) };
}

/**
 * Schedule the voices from piece time `cueSec` at context time `nowTime`.
 * 큐 지점부터 보이스 곡선을 스케줄.
 */
export function scheduleTempoVoices(ctx, dest, { doc, bake, nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, brightWarp = null }) {
  const voiceMod = doc.voiceMod; // per-voice tremolo / vibrato (core/voice-mod.js) / 보이스별 변조
  const { audible, norm } = getTempoTimeline(doc, bake);
  let count = 0;
  for (const bv of audible) {
    const v = doc.voices[bv.index];
    const from = Math.max(cueSec, bv.uOn);
    const to = bv.uOff;
    if (to - from < 0.02) continue;
    const j0 = Math.ceil(from * BAKE_RATE - 1e-9);
    const j1 = Math.min(bake.samples - 1, Math.floor(to * BAKE_RATE + 1e-9));
    if (j1 - j0 < 2) continue;
    const off = voicePitchOffset(v);
    const ref = Math.round((Number.isFinite(bv.midiLo) ? bv.midiLo : 60) + off);
    const m = j1 - j0 + 1;
    const cents = new Float32Array(m);
    const gain = new Float32Array(m);
    const fadeN = Math.max(1, Math.round(EDGE_FADE_SEC * BAKE_RATE));
    const g0 = v.baseGain * norm;
    for (let j = 0; j < m; j++) {
      const mm = bv.midi[j0 + j] + off;
      const mw = pitchWarp ? freqToMidi(Math.max(1e-3, pitchWarp((j0 + j) / BAKE_RATE, midiToFreq(mm)))) : mm; // Manager Warp / 매니저 곡률
      cents[j] = (mw - ref) * 100;
      let g = bv.gain[j0 + j] * g0;
      if (j < fadeN && from > bv.uOn + 1e-6) g *= j / fadeN; // started mid-note / 중간 시작 페이드
      if (m - 1 - j < fadeN) g *= (m - 1 - j) / fadeN;
      if (ampMask) g *= ampMask((j0 + j) / BAKE_RATE, midiToFreq(mw)); // Manager shape mask / 매니저 모양 마스크
      gain[j] = g;
    }
    const tStart = nowTime + (j0 / BAKE_RATE - cueSec);
    const dur = (m - 1) / BAKE_RATE;
    // Per-voice Sampler: rate = ref / root, the cent curve goes to detune as for the oscillator
    // 보이스별 샘플러: rate = ref / 루트, 센트 곡선은 오실레이터처럼 detune으로
    const smp = timbreSampleSpec(v.timbre);
    const osc = createToneSource(ctx, { sample: smp, wave: smp ? null : buildWave(ctx, v.timbre) });
    skipSampleRead(osc, (sec) => midiToFreq(bv.midi[clamp(Math.round(sec * BAKE_RATE), 0, bv.midi.length - 1)] + off), bv.uOn, j0 / BAKE_RATE);
    osc.frequency.value = clamp(midiToFreq(ref), 10, 20000);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0, nowTime);
    const vm = createVoiceModEvaluator(voiceMod, voiceModIndex(v.id ?? bv.index), ref);
    const vt = j0 / BAKE_RATE - bv.uOn; // voice time of the first point / 첫 점의 보이스 시간
    osc.detune.setValueAtTime(cents[0], nowTime);
    osc.detune.setValueCurveAtTime(voiceModCentsCurve(vm, cents, vt, dur), Math.max(nowTime, tStart), dur);
    gn.gain.setValueCurveAtTime(voiceModGainCurve(vm, gain, vt, dur), Math.max(nowTime, tStart), dur);
    if (brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
      const f0 = clamp(midiToFreq(ref), 10, 20000);
      const fq = Float32Array.from(cents, (c) => f0 * Math.pow(2, c / 1200));
      const sh = createBrightShelf(ctx, fq, (j) => (j0 + j) / BAKE_RATE, brightWarp, Math.max(nowTime, tStart), dur);
      osc.connect(sh).connect(gn).connect(dest);
      if (nodeList) nodeList.push(sh);
    } else osc.connect(gn).connect(dest);
    osc.start(Math.max(nowTime, tStart));
    osc.stop(Math.max(nowTime, tStart) + dur + 0.02);
    if (nodeList) nodeList.push(osc, gn);
    count++;
  }
  return count;
}

/** Sorted pulse events in piece time [from, to). / 펄스 이벤트 목록 */
export function buildPulseEvents(doc, bake, from, to) {
  const { audible, pulseOn } = getTempoTimeline(doc, bake);
  if (!pulseOn) return [];
  const ev = [];
  for (const bv of audible) {
    for (let j = 0; j < bv.beats.length; j++) {
      const u = bv.beats[j];
      if (u >= from - 1e-9 && u < to) ev.push({ u, i: bv.index, accent: doc.pulse.accentFirst ? bv.accents[j] === 1 : true });
    }
  }
  ev.sort((a, b) => a.u - b.u || a.i - b.i);
  return ev;
}

const noiseBuffers = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseBuffers.get(ctx);
  if (b) return b;
  const n = Math.ceil(ctx.sampleRate * 0.04);
  b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  const rnd = createSeededRandom(4242); // deterministic noise → identical exports / 결정적 노이즈
  for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  noiseBuffers.set(ctx, b);
  return b;
}

/** One click / tick at context time `when`. / 클릭·틱 하나 */
export function scheduleClick(ctx, dest, when, voiceIndex, accent, doc) {
  const f = pulseFreq(voiceIndex);
  const amp = PULSE_MASTER * doc.pulse.level * (doc.pulse.accentFirst ? (accent ? 1 : 0.42) : 0.6);
  if (amp <= 0) return;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  let src;
  if (doc.pulse.kind === 'tick') {
    src = ctx.createOscillator();
    src.frequency.value = f * (accent && doc.pulse.accentFirst ? 2 : 1);
    g.gain.linearRampToValueAtTime(amp * 0.6, when + 0.001);
    g.gain.exponentialRampToValueAtTime(1e-4, when + 0.045);
    src.connect(g);
  } else {
    src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 6;
    g.gain.linearRampToValueAtTime(amp * 2.2, when + 0.0005);
    g.gain.exponentialRampToValueAtTime(1e-4, when + 0.03);
    src.connect(bp).connect(g);
  }
  g.connect(dest);
  src.start(when);
  src.stop(when + 0.05);
  src.onended = () => { try { g.disconnect(); } catch { /* ignore */ } };
}

// --------------------------------------------------------------------------
// Live transport (drives appState.transport so the shared header works)
// 실시간 트랜스포트 (공용 헤더와 연동)
// --------------------------------------------------------------------------

let schedTimer = null;

/** Look-ahead pulse scheduler (cheap: walks a pre-sorted list). / 룩어헤드 펄스 스케줄러 */
function pumpPulses(pass) {
  const ctx = getAudioCtx();
  if (transport.pass() !== pass || !ctx) return;
  const horizon = ctx.currentTime + LOOKAHEAD_SEC;
  const ev = pass.events;
  while (pass.next < ev.length) {
    const e = ev[pass.next];
    const when = pass.ctxStart + (e.u - pass.fromSec);
    if (when > horizon) break;
    if (when >= ctx.currentTime - 0.005) scheduleClick(ctx, pass.master, Math.max(ctx.currentTime, when), e.i, e.accent, pass.doc);
    pass.next++;
  }
}

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  editKey: () => soundKey(getTempoParams()), // edits while playing are heard from the playhead / 재생 중 편집을 플레이헤드부터 반영
  quietStop: true,
  endSec: () => { const { audible, pulseOn, endSec } = getTempoTimeline(getTempoParams()); return audible.length || pulseOn ? endSec : null; },
  plan: () => { const doc = getTempoParams(); const bake = getTempoBake(doc); return { doc, bake, endSec: getTempoTimeline(doc, bake).endSec }; }, // memoised: no bake unless timing changed / 캐시 조회만
  masterGain: () => LIVE_MASTER,
  output: (ctx) => studioLiveOutput(ctx, 'tempo', () => getTempoParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { doc, bake, endSec }, { when, fromSec, nodes }) => {
    scheduleTempoVoices(ctx, master, { doc, bake, nowTime: when, cueSec: fromSec, nodeList: nodes });
    return { events: buildPulseEvents(doc, bake, fromSec, endSec), next: 0, doc };
  },
  onPass: (pass) => {
    pumpPulses(pass);
    schedTimer = setInterval(() => pumpPulses(pass), SCHED_MS);
  },
  onClear: () => { if (schedTimer !== null) clearInterval(schedTimer); schedTimer = null; },
});

export const isTempoPlaying = transport.isPlaying;
export const getTempoPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생 (이동 도구로 놓았을 때).
 */
export const startTempoAudio = transport.start;
/** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지 */
export const stopTempoAudio = transport.stop;
/** Pause: stop and pin the cue at the playhead. / 플레이헤드에 큐 고정 후 정지 */
export const pauseTempoAtPlayhead = transport.pauseAtPlayhead;
export const toggleTempoPause = transport.togglePause;
export const toggleTempoPlay = transport.togglePlay;

// --------------------------------------------------------------------------
// Offline render, WAV and JSON / 오프라인 렌더링, WAV, JSON
// --------------------------------------------------------------------------

export async function renderTempoBuffer({ doc = getTempoParams(), sampleRate = EXPORT_SAMPLE_RATE, channels = 2, outputStage = true, ampMask = null, pitchWarp = null, brightWarp = null } = {}) {
  const bake = getTempoBake(doc);
  const { audible, pulseOn, endSec } = getTempoTimeline(doc, bake);
  if (!audible.length && !pulseOn) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(channels, Math.ceil((endSec + 0.1) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = OFFLINE_MASTER;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, doc.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleTempoVoices(ctx, master, { doc, bake, nowTime: 0, cueSec: 0, ampMask, pitchWarp, brightWarp });
  for (const e of buildPulseEvents(doc, bake, 0, endSec)) scheduleClick(ctx, master, e.u, e.i, e.accent, doc);
  return ctx.startRendering();
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportTempoWav({ download = true } = {}) {
  const buf = await renderTempoBuffer();
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const doc = getTempoParams();
  const safe = String(t(`tempo.preset.${doc.preset}`) || 'Tempo').replace(/[^A-Za-z0-9_-]+/g, '-');
  const filename = `TempoCanon_${safe}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  if (download) triggerDownload(new Blob([wav], { type: 'audio/wav' }), filename);
  return { ok: true, filename, bytes: wav.byteLength, buffer: buf, message: t('toast.wavDone', filename) };
}

/** Document + baked timing as JSON (prototype format). / 문서 + 베이킹 타이밍 JSON */
export function exportTempoJson({ download = true } = {}) {
  const doc = getTempoParams();
  const bake = getTempoBake(doc);
  const r4 = (x) => Number(x.toFixed(4));
  const payload = {
    plugin: 'FlexatoneTempoCanon',
    version: '0.1',
    document: doc,
    subjectLengthSec: r4(bake.L),
    beatSec: r4(bake.beat),
    voices: bake.voices.map((bv) => ({
      name: doc.voices[bv.index].name,
      s0: r4(bv.track.s0),
      enterSec: r4(bv.uOn),
      exitSec: r4(bv.uOff),
      rate: Array.from({ length: 65 }, (_, k) => r4(rateAt(bv.track, (k / 64) * doc.length))),
      scorePos: Array.from({ length: 65 }, (_, k) => r4(evalS(bv.track, (k / 64) * doc.length))),
      loopStarts: bv.loopStarts.map(r4),
    })),
    active: getActiveTempoVoice(doc)?.id,
  };
  if (download) triggerDownload(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'TempoCanon_Baked.json');
  return payload;
}
