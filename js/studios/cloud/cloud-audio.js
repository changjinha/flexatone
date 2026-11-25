/**
 * Flexatone — studios/cloud/cloud-audio.js
 * Cloud Studio audio tier: plays and renders the CACHED event list (no generation here).
 * 클라우드 스튜디오 오디오: 캐시된 이벤트 목록만 재생·렌더링 (여기서는 생성 안 함).
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — it imports
 * audio/*, and only ui/workspaces.js and cloud-panels.js import it. The pure files
 * (cloud-studio.js, cloud-engine.js) never import it.
 *
 * Graph / 그래프
 *   per event: Oscillator (shared PeriodicWave, exponentialRamp f0→f1 = straight MIDI glide)
 *     → strip (Gain: envelope value curve → StereoPanner)  → master (level × √overlap scale)
 *     → getOutputBus(ctx)  (live)   |   createOfflineOutput(ctx)  (WAV)
 *   Strips are pooled (≤ maxPolyphony + 8) and reused once their last envelope has ended, so a
 *   cloud of thousands of events only ever creates one short-lived Oscillator per event.
 *   스트립(게인+팬)은 풀에서 재사용, 이벤트마다 짧은 오실레이터 하나만 생성.
 * Live scheduling: a setInterval look-ahead window (default 0.5 s / 25 ms) walks the sorted
 * t0 array with a cursor — O(events in window) per tick, no allocation besides the nodes.
 * 실시간: 정렬된 t0 배열을 커서로 훑는 룩어헤드 창 (틱당 창 안의 이벤트만 처리).
 */

import { applyAdsrToCurve } from '../../core/adsr.js';
import { timbreSpecAdsr } from '../../modules/timbre-spec.js';
import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { createTimbreWave } from '../../audio/studio-fx.js';
import { studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { createVoiceModEvaluator, voiceModCentsCurve, voiceModGainCurve } from '../../core/voice-mod.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, measurePeak, EXPORT_SAMPLE_RATE, createBrightShelf } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { lowerBound, envelopeAt } from './cloud-engine.js';
import { getCloudParams, getCloudEvents } from '../cloud-studio.js';
import { createToneSource } from '../../audio/sample-voice.js'; // the shared voice-source seam (D-1) / 공용 음원 이식점

const LIVE_MASTER = 0.6;
const OFFLINE_MASTER = 0.6;
const START_LEAD_SEC = 0.06;
const STRIP_GUARD_SEC = 0.004;
const OFFLINE_CHUNK_SEC = 2;

const timbreKey = (tb) => JSON.stringify(tb || {});

/** PeriodicWave from the shared 5-wave mixer. / 공용 5파형 음색 */
export function buildCloudWave(ctx, timbre) {
  return createTimbreWave(ctx, timbre || {}); // Mix or ƒ(x) (shared timbre synthesis) / 믹스 또는 ƒ(x)
}

/** Fresh scheduling state for one context (pool, counters). / 스케줄 상태 */
function createPlayer(ctx, master, { ev, params, maxStrips, ampMask = null, pitchWarp = null, brightWarp = null, timeScale = 1 }) {
  return {
    ctx, master, ev, params, ampMask, pitchWarp, brightWarp,
    // Tempo Manager rate (pitch kept): document second s sounds at s / ts / 템포 배속 (음고 유지)
    ts: Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1,
    wave: buildCloudWave(ctx, params.timbre),
    wKey: timbreKey(params.timbre),
    strips: [],
    maxStrips,
    oscs: new Set(),
    stats: { scheduled: 0, skipped: 0, peakActive: 0 },
  };
}

function takeStrip(pl, at) {
  for (const s of pl.strips) if (s.freeAt + STRIP_GUARD_SEC <= at) return s;
  if (pl.strips.length >= pl.maxStrips) return null;
  const gain = pl.ctx.createGain();
  gain.gain.value = 0;
  const pan = pl.ctx.createStereoPanner ? pl.ctx.createStereoPanner() : null;
  if (pan) gain.connect(pan).connect(pl.master);
  else gain.connect(pl.master);
  const s = { gain, pan, freeAt: -1 };
  pl.strips.push(s);
  return s;
}

/**
 * Schedule event i at context time `at`, skipping its first `offset` seconds (cue inside an
 * event). Frequencies stay strictly positive for exponentialRamp. / 이벤트 하나 스케줄
 */
function playEvent(pl, i, at, offset = 0) {
  const { ev, ctx, ts } = pl;
  const dur = ev.dur[i];
  const docRem = dur - offset;
  const rem = docRem / ts; // real seconds / 실제 초
  if (rem < 0.01) return false;
  const strip = takeStrip(pl, at);
  if (!strip) { pl.stats.skipped++; return false; }
  const u0 = offset / dur;
  const hzLin = (u) => midiToFreq(ev.p0[i] + (ev.p1[i] - ev.p0[i]) * u);
  // Manager Warp: the grain glide follows the bent space (then it is a curve) / 매니저 곡률: 그레인 글리산도가 휜 공간을 따름
  const hzAt = pl.pitchWarp ? (u) => clamp(pl.pitchWarp((ev.t0[i] + u * dur) / ts, hzLin(u)), 20, 18000) : (u) => clamp(hzLin(u), 20, 18000);
  const n = clamp(Math.ceil(rem * 200), 16, 256);
  let curve = new Float32Array(n);
  const amp = ev.gain[i];
  for (let k = 0; k < n; k++) curve[k] = amp * envelopeAt(ev.envelope, u0 + ((1 - u0) * k) / (n - 1), dur, ev.attack);
  if (pl.ampMask) {
    // Manager shape mask (real sec, Hz) / 매니저 모양 마스크 (실제 시간)
    for (let k = 0; k < n; k++) { const u = u0 + ((1 - u0) * k) / (n - 1); curve[k] *= pl.ampMask((ev.t0[i] + u * dur) / ts, hzAt(u)); }
  }
  // Per-voice (per-grain) tremolo / vibrato (core/voice-mod.js), on grain time / 그레인별 트레몰로·비브라토
  const vm = createVoiceModEvaluator(pl.params.voiceMod, i, ev.p0[i]);
  applyAdsrToCurve(timbreSpecAdsr(pl.params.timbre), curve, offset, docRem, dur); // timbre ADSR per grain / 그레인별 음색 ADSR
  curve = voiceModGainCurve(vm, curve, offset, docRem); // grain time (document), like Fractal / 그레인 시간 (문서)
  curve[curve.length - 1] = 0;
  if (offset > 0) curve[0] = 0; // join mid-event without a click / 중간 진입도 0에서 시작
  const osc = createToneSource(ctx, { wave: pl.wave });
  const vib = voiceModCentsCurve(vm, new Float32Array(2), offset, docRem);
  if (vib.length > 2) osc.detune.setValueCurveAtTime(vib, at, rem);
  if (pl.pitchWarp) {
    const fc = new Float32Array(n);
    for (let k = 0; k < n; k++) fc[k] = hzAt(u0 + ((1 - u0) * k) / (n - 1));
    osc.frequency.setValueCurveAtTime(fc, at, rem);
  } else {
    osc.frequency.setValueAtTime(hzAt(u0), at);
    osc.frequency.exponentialRampToValueAtTime(hzAt(1), at + rem);
  }
  strip.gain.gain.setValueCurveAtTime(curve, at, rem);
  if (strip.pan) strip.pan.pan.setValueAtTime(clamp(ev.pan[i] * (pl.params.timbre?.stereo ?? 0.6), -1, 1), at);
  strip.freeAt = at + rem;
  if (pl.brightWarp) { // Manager Warp brightness / 매니저 곡률 밝기
    const fq = new Float32Array(n);
    for (let k = 0; k < n; k++) fq[k] = hzAt(u0 + ((1 - u0) * k) / (n - 1));
    const sh = createBrightShelf(ctx, fq, (k) => (ev.t0[i] + (u0 + ((1 - u0) * k) / (n - 1)) * dur) / ts, pl.brightWarp, at, rem);
    osc.connect(sh).connect(strip.gain);
    osc.onended = () => { try { sh.disconnect(); } catch { /* ignore */ } };
  } else osc.connect(strip.gain);
  osc.start(at);
  osc.stop(at + rem + 0.005);
  pl.oscs.add(osc);
  osc.onended = () => { pl.oscs.delete(osc); try { osc.disconnect(); } catch { /* gone */ } };
  pl.stats.scheduled++;
  if (pl.oscs.size > pl.stats.peakActive) pl.stats.peakActive = pl.oscs.size;
  return true;
}

/** Events already sounding at `cueSec` (joined mid-way). / 큐 시점에 이미 울리는 이벤트 */
function scheduleOngoing(pl, cueSec, at) {
  const { ev } = pl;
  const a = lowerBound(ev.t0, ev.n, cueSec - ev.maxDur - 1e-6);
  const b = lowerBound(ev.t0, ev.n, cueSec);
  for (let i = a; i < b; i++) if (ev.t0[i] + ev.dur[i] > cueSec + 0.02) playEvent(pl, i, at, cueSec - ev.t0[i]);
  return b;
}

// --------------------------------------------------------------------------
// Live transport / 실시간 트랜스포트
// --------------------------------------------------------------------------

const perf = { ticks: 0, sumMs: 0, maxMs: 0, lastScheduled: 0 };
let tickTimer = null;

/** Look-ahead scheduler: schedules every event that starts before the horizon. / 선행 스케줄러 */
function tick(pass) {
  if (transport.pass() !== pass) return;
  const t0 = performance.now();
  const { pl } = pass;
  const ctx = pl.ctx;
  const look = clamp(Number(pl.params.sched?.lookahead) || 0.5, 0.05, 3);
  const horizon = pass.fromSec + (ctx.currentTime + look - pass.ctxStart);
  const ev = pl.ev;
  while (pass.cursor < ev.n && ev.t0[pass.cursor] < horizon) {
    const i = pass.cursor++;
    const at = pass.ctxStart + (ev.t0[i] - pass.fromSec);
    if (at < ctx.currentTime + 0.005) { pl.stats.skipped++; continue; } // late (tab throttled) / 지연
    playEvent(pl, i, at);
  }
  pass.horizonSec = Math.max(pass.horizonSec, horizon);
  const ms = performance.now() - t0;
  perf.ticks++;
  perf.sumMs += ms;
  if (ms > perf.maxMs) perf.maxMs = ms;
}

// The shared transport (audio/live-transport.js) owns play / stop / pause / loop / playhead; a
// Cloud pass schedules itself (event player + look-ahead), so its nodes are reported through
// `dynamicNodes`. / 공용 트랜스포트 사용. 클라우드 패스는 스스로 스케줄하므로 노드를 dynamicNodes로 알림.
const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  endSec: () => { const params = getCloudParams(); return getCloudEvents(params).n ? params.length : null; },
  plan: () => { const params = getCloudParams(); return { params, ev: getCloudEvents(params), endSec: params.length }; }, // cache hit unless the document changed / 캐시 조회
  masterGain: ({ ev }) => LIVE_MASTER * ev.levelScale,
  output: (ctx) => studioLiveOutput(ctx, 'cloud', () => getCloudParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params, ev }, { when, fromSec }) => {
    const pl = createPlayer(ctx, master, { ev, params, maxStrips: Math.max(params.maxPolyphony, ev.polyCap || 0) + 8 });
    return { pl, cursor: scheduleOngoing(pl, fromSec, when), horizonSec: fromSec, dynamicNodes: () => [...pl.oscs, ...pl.strips.flatMap((s) => [s.gain, s.pan])] };
  },
  onPass: (pass) => {
    perf.ticks = 0;
    perf.sumMs = 0;
    perf.maxMs = 0;
    tick(pass);
    tickTimer = setInterval(() => tick(pass), clamp(Number(pass.pl.params.sched?.interval) || 25, 5, 200));
  },
  onClear: () => { if (tickTimer !== null) clearInterval(tickTimer); tickTimer = null; },
  release: (pass) => { perf.lastScheduled = pass.pl.stats.scheduled; pass.pl.oscs.clear(); },
});

export const isCloudPlaying = transport.isPlaying;
export const getCloudPlayheadSec = transport.playheadSec;
/**
 * Play from the shared cue, or from `fromSec` without moving the cue.
 * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생.
 */
export const startCloudAudio = transport.start;
export const stopCloudAudio = transport.stop;
export const pauseCloudAtPlayhead = transport.pauseAtPlayhead;
export const toggleCloudPause = transport.togglePause;
export const toggleCloudPlay = transport.togglePlay;

/** Scheduler / node counters for the status badge. / 스케줄러 계측값 */
export function getCloudAudioStats() {
  const pl = transport.pass()?.pl;
  return {
    playing: transport.isPlaying(),
    scheduled: pl?.stats.scheduled ?? perf.lastScheduled,
    skipped: pl?.stats.skipped ?? 0,
    active: pl?.oscs.size ?? 0,
    peakActive: pl?.stats.peakActive ?? 0,
    pool: pl?.strips.length ?? 0,
    ticks: perf.ticks,
    tickAvgMs: perf.ticks ? perf.sumMs / perf.ticks : 0,
    tickMaxMs: perf.maxMs,
  };
}

/**
 * The document changed while playing: switch to the new (already baked) event list from the
 * scheduled horizon on, keeping what is already scheduled. No generation happens here.
 * 재생 중 문서 변경: 이미 베이킹된 새 목록으로 예약 지평 이후부터 전환 (여기서 생성 없음).
 */
export function syncCloudLive(ev, params) {
  const live = transport.pass();
  if (!live) return;
  const { pl } = live;
  if (ev !== pl.ev) {
    pl.ev = ev;
    live.cursor = lowerBound(ev.t0, ev.n, live.horizonSec);
    try {
      const now = pl.ctx.currentTime;
      pl.master.gain.setTargetAtTime(LIVE_MASTER * ev.levelScale, now, 0.05);
    } catch { /* ignore */ }
  }
  pl.params = params;
  pl.maxStrips = Math.max(params.maxPolyphony, ev.polyCap || 0) + 8;
  const k = timbreKey(params.timbre);
  if (k !== pl.wKey) { pl.wave = buildCloudWave(pl.ctx, params.timbre); pl.wKey = k; }
  live.endSec = params.length;
}

// --------------------------------------------------------------------------
// Offline render, WAV, JSON / 오프라인 렌더링, WAV, JSON
// --------------------------------------------------------------------------

const progressListeners = new Set();
let renderState = { active: false, frac: 0 };
export const getCloudRenderState = () => renderState;
export function onCloudRenderProgress(fn) {
  progressListeners.add(fn);
  return () => progressListeners.delete(fn);
}
function setProgress(active, frac) {
  renderState = { active, frac };
  for (const fn of [...progressListeners]) { try { fn(renderState); } catch (e) { console.error(e); } }
}

/**
 * Render the cloud with the same scheduler on an OfflineAudioContext. Events are fed in
 * 2-second chunks at ctx.suspend() points (bounded node count + progress callbacks).
 * 동일한 스케줄러로 오프라인 렌더링 (2초 단위 suspend로 노드 수 제한 + 진행률).
 */
export async function renderCloudBuffer({ params = getCloudParams(), sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, onProgress = null, ampMask = null, pitchWarp = null, brightWarp = null, timeScale = 1 } = {}) {
  const ev = getCloudEvents(params);
  if (!ev.n) return null;
  const ts = Number.isFinite(timeScale) && timeScale > 0 ? timeScale : 1; // Tempo Manager rate (pitch kept) / 템포 배속 (음고 유지)
  const T = params.length / ts + 0.1;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil(T * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = OFFLINE_MASTER * ev.levelScale;
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  const pl = createPlayer(ctx, master, { ev, params, maxStrips: Math.max(params.maxPolyphony, ev.polyCap || 0) + 8, ampMask, pitchWarp, brightWarp, timeScale: ts });
  let cursor = 0;
  const feed = (untilSec) => { // untilSec in real time / 실제 시간
    while (cursor < ev.n && ev.t0[cursor] / ts < untilSec) { playEvent(pl, cursor, ev.t0[cursor] / ts); cursor++; }
  };
  feed(OFFLINE_CHUNK_SEC + 0.25);
  const canSuspend = typeof ctx.suspend === 'function';
  if (canSuspend) {
    for (let k = 1; k * OFFLINE_CHUNK_SEC < T; k++) {
      const at = k * OFFLINE_CHUNK_SEC;
      ctx.suspend(at).then(() => {
        feed(at + OFFLINE_CHUNK_SEC + 0.25);
        onProgress?.(at / T);
        ctx.resume();
      });
    }
  } else feed(Infinity);
  const buf = await ctx.startRendering();
  onProgress?.(1);
  buf.cloudStats = { ...pl.stats };
  return buf;
}

/** Render at 48 kHz / 16-bit and download. / 48 kHz WAV 내보내기 */
export async function exportCloudWav({ download = true } = {}) {
  const params = getCloudParams();
  setProgress(true, 0);
  let buf;
  try {
    buf = await renderCloudBuffer({ params, onProgress: (f) => setProgress(true, f) });
  } finally {
    setProgress(false, 1);
  }
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const filename = `Cloud_seed${params.seed}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  const peak = measurePeak(buf);
  return { ok: true, filename, bytes: wav.byteLength, peak, stats: buf.cloudStats, message: t('toast.wavDone', filename) };
}

/** Export the cached event list as JSON (prototype format). / 이벤트 JSON 내보내기 */
export function exportCloudJson({ download = true } = {}) {
  const params = getCloudParams();
  const ev = getCloudEvents(params);
  const r = (x, d = 4) => Number(x.toFixed(d));
  const { view, sched, ...doc } = params;
  const payload = {
    plugin: 'FlexatoneCloudStudio',
    version: '0.1',
    params: doc,
    stats: ev.stats,
    events: Array.from({ length: ev.n }, (_, i) => ({ t0: r(ev.t0[i]), dur: r(ev.dur[i]), p0: r(ev.p0[i], 3), p1: r(ev.p1[i], 3), gain: r(ev.gain[i], 3), pan: r(ev.pan[i], 3) })),
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  if (download) triggerDownload(blob, `Cloud_seed${params.seed}_events.json`);
  return payload;
}
