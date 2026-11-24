/**
 * Flexatone — audio/tempo-player.js
 * Layer 3 (audio): plays a studio on its **own transport at a tempo** (core/studio-tempo.js). While a
 * studio's tempo is not 1× the header transport is routed here (ui/studio-host.js): the studio document is
 * rendered offline the way the Manager renders a track — pitch-preserving where the studio can scale its time
 * (Glissando, Field, Fractal, Wave), as varispeed otherwise (Draw, Chaos, Cloud, Tempo, Space; the same as in
 * the Manager) — and played from one buffer. The playhead stays in document seconds, so every canvas, cue and
 * loop works unchanged. Edits while playing re-render and cross-fade from the playhead.
 * Risset is a live field: its engine clock is scaled instead (risset-audio.js `setRissetTimeScaleSource`).
 * 계층 3 (audio): 템포가 1×가 아닐 때 스튜디오 문서를 매니저처럼 오프라인 렌더해 한 버퍼로 재생.
 * 플레이헤드는 문서 시간(초)이라 캔버스·큐·루프가 그대로 동작. 재생 중 편집은 다시 렌더해 크로스페이드.
 */

import { appState, setTransport, subscribe } from '../core/state.js';
import { t } from '../core/i18n.js';
import { studioRates } from '../core/studio-tempo.js';
import { applyTempoToVoices, applyTempoToFieldParams } from '../modules/tempo-manager.js';
import { ensureAudioCtx, getAudioCtx, getPlayableTimeline, renderOfflineBuffer, encodeWav, triggerDownload, EXPORT_SAMPLE_RATE, TRANSPORT_FADE_SEC } from './audio-engine.js';
import { getOutputBus, createOfflineOutput } from './output-bus.js';
import { renderFieldBuffer, getFieldTimeline } from '../studios/field/field-audio.js';
import { getFieldParams } from '../studios/field-studio.js';
import { isClipStudio, resolveClipParams, clipStudioLength, renderClipStudio, clipStudioScalesTime } from './studio-clips.js';

const LIVE_RATE = 44100;
const END_GUARD = 0.02;

/** Studios this player can render. / 렌더 가능한 스튜디오 */
export function tempoPlayable(studio) {
  return studio === 'glissando' || studio === 'field' || isClipStudio(studio);
}

const glissParams = () => appState.studioParams?.glissando ?? null;
const clipParams = (studio) => resolveClipParams(studio, appState.studioParams?.[studio]);

/** One pass of the studio at 1×, in document seconds. / 1× 한 회 길이 (문서 초) */
export function studioNaturalSec(studio) {
  try {
    if (studio === 'glissando') return getPlayableTimeline(appState.voices).endSec;
    if (studio === 'field') return getFieldTimeline(getFieldParams()).endSec;
    if (isClipStudio(studio)) return clipStudioLength(studio, clipParams(studio));
  } catch (err) { console.error('[Flexatone] tempo length failed:', err); }
  return 0;
}

/** Can the studio keep its pitch under a tempo? / 음고 유지 렌더 가능? */
export function studioScalesTime(studio) {
  return studio === 'glissando' || studio === 'field' || (isClipStudio(studio) && clipStudioScalesTime(studio));
}

/**
 * Rates split into what is rendered and what the buffer source does:
 * docR = time scale rendered into the buffer (pitch kept), v = playbackRate (pitch follows); docR · v = heard rate.
 * 렌더되는 배율(docR)과 재생 배율(v) 분리.
 */
export function playRates(studio) {
  const nat = studioNaturalSec(studio);
  const r = studioRates(studio, nat);
  const docR = studioScalesTime(studio) ? r.doc : 1;
  return { ...r, nat, docR, v: r.rate / docR };
}

/** What the rendered sound depends on (document + rendered scale). / 렌더 키 */
function renderKey(studio, docR) {
  const doc = studio === 'glissando' ? { v: appState.voices, p: glissParams() } : appState.studioParams?.[studio];
  return `${studio}|${docR.toFixed(6)}|${JSON.stringify(doc ?? null)}`;
}

/** Render the studio at its pitch-preserving scale (no output stage). / 음고 유지 배율로 렌더 */
async function renderAt(studio, docR, sampleRate) {
  if (studio === 'glissando') {
    return renderOfflineBuffer({ voices: applyTempoToVoices(appState.voices, docR), sampleRate, voiceMod: glissParams()?.voiceMod ?? null, legato: appState.legatoJoin, glideMs: appState.joinGlideMs });
  }
  if (studio === 'field') return renderFieldBuffer({ params: applyTempoToFieldParams(getFieldParams(), docR), sampleRate, outputStage: false });
  if (isClipStudio(studio)) return renderClipStudio(studio, clipParams(studio), sampleRate, { rate: docR });
  return null;
}

// --------------------------------------------------------------------------
// Player / 재생기
// --------------------------------------------------------------------------

let studioId = null;
let live = null; // { src, gain, ctxStart, fromSec, endSec, R, token }
let token = 0;
let rafId = null;
let endTimer = null;
let cache = null; // { key, buffer }
let rendering = null; // Promise of the render in flight / 진행 중 렌더
let editTimer = null;
let lastKey = '';

async function bufferFor(studio, docR) {
  const key = renderKey(studio, docR);
  if (cache?.key === key) return cache.buffer;
  const job = renderAt(studio, docR, getAudioCtx()?.sampleRate || LIVE_RATE);
  rendering = job;
  const buffer = await job;
  if (rendering === job) rendering = null;
  cache = { key, buffer };
  return buffer;
}

export function isTempoPlaying() {
  return !!live;
}

/** Studio the player is playing (null when stopped). / 재생 중인 스튜디오 */
export function tempoPlayingStudio() {
  return live ? studioId : null;
}

function playheadSec() {
  const ctx = getAudioCtx();
  if (live && ctx) return live.fromSec + Math.max(0, ctx.currentTime - live.ctxStart) * live.R;
  return appState.transport.playheadSec;
}

function clearTimers() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  if (endTimer !== null) clearTimeout(endTimer);
  rafId = null;
  endTimer = null;
}

function fadeOut(p, at) {
  const ctx = getAudioCtx();
  if (!p || !ctx) return;
  const now = ctx.currentTime;
  const tA = Math.max(now, at || now);
  try {
    p.gain.gain.cancelScheduledValues(now);
    p.gain.gain.setValueAtTime(p.gain.gain.value, now);
    p.gain.gain.setValueAtTime(p.gain.gain.value, tA);
    p.gain.gain.linearRampToValueAtTime(0, tA + TRANSPORT_FADE_SEC);
    p.src.stop(tA + TRANSPORT_FADE_SEC + 0.01);
  } catch { /* already stopped */ }
  setTimeout(() => { try { p.src.disconnect(); p.gain.disconnect(); } catch { /* ignore */ } }, (tA - now + TRANSPORT_FADE_SEC + 0.1) * 1000);
}

function onEnd(tk) {
  if (!live || live.token !== tk) return;
  if (appState.transport.loop) {
    const cue = appState.transport.cueSec;
    void startPass(cue >= live.endSec - END_GUARD ? 0 : cue);
  } else stop();
}

function tick(tk) {
  if (!live || live.token !== tk) return;
  const sec = playheadSec();
  if (sec >= live.endSec) { onEnd(tk); return; }
  setTransport({ playheadSec: sec });
  rafId = requestAnimationFrame(() => tick(tk));
}

/** Start (or cross-fade to) a pass at document second `fromSec`. / 패스 시작 */
async function startPass(fromSec) {
  const ctx = getAudioCtx();
  const pr = playRates(studioId);
  const buffer = await bufferFor(studioId, pr.docR);
  if (!buffer || buffer.duration < 0.02) { stop(); return false; }
  const endSec = Math.min(pr.nat || Infinity, buffer.duration * pr.docR);
  if (!(fromSec >= 0) || fromSec >= endSec - END_GUARD) fromSec = 0;
  const prev = live;
  clearTimers();
  const when = ctx.currentTime + 0.03;
  if (prev) fadeOut(prev, when);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(1, when + TRANSPORT_FADE_SEC);
  gain.connect(getOutputBus(ctx));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = pr.v;
  src.connect(gain);
  src.start(when, fromSec / pr.docR);
  const tk = ++token;
  live = { src, gain, ctxStart: when, fromSec, endSec, R: pr.rate, token: tk };
  lastKey = renderKey(studioId, pr.docR) + `|${pr.v}`;
  setTransport({ playing: true, playheadSec: fromSec });
  endTimer = setTimeout(() => onEnd(tk), ((endSec - fromSec) / pr.rate + 0.03) * 1000 + 30);
  rafId = requestAnimationFrame(() => tick(tk));
  return true;
}

/** Play `studio` from the cue, or from `fromSec` (cue untouched). / 큐(또는 fromSec)부터 재생 */
export async function startTempo(studio, fromSec = null) {
  if (live && studioId !== studio) stop();
  studioId = studio;
  await ensureAudioCtx();
  const cue = Number.isFinite(fromSec) ? fromSec : appState.transport.cueSec;
  return startPass(Math.max(0, cue));
}

export function stop() {
  clearTimers();
  const p = live;
  live = null;
  if (p) fadeOut(p, 0);
  if (p || appState.transport.playing) setTransport({ playing: false, playheadSec: -1 });
}

export function pauseTempo() {
  const sec = playheadSec();
  stop();
  if (sec >= 0) setTransport({ cueSec: Math.max(0, sec) });
}

/** Re-start from the playhead with the current document and rates (tempo or edit while playing). / 재시작 */
export function restartTempo() {
  if (live) void startPass(playheadSec());
}

// Edit while playing: re-render once the edits settle, then cross-fade from the playhead.
// 재생 중 편집: 편집이 멈추면 다시 렌더해 플레이헤드부터 크로스페이드
subscribe((e) => {
  if (!live) return;
  if (![...e.scope].some((x) => x !== 'transport' && x !== 'view')) return; // the playhead clock itself / 플레이헤드 갱신은 무시
  if (editTimer !== null) clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    editTimer = null;
    if (!live) return;
    let pr;
    try { pr = playRates(studioId); } catch { return; }
    if (renderKey(studioId, pr.docR) + `|${pr.v}` === lastKey) return;
    restartTempo();
  }, 220);
});

/** Header transport object for a studio at tempo. / 템포 재생용 헤더 트랜스포트 */
export function tempoTransport(studio) {
  return {
    isPlaying: () => isTempoPlaying() && studioId === studio,
    playFrom: (sec) => startTempo(studio, sec),
    togglePlay: async () => { if (live) { stop(); return false; } return startTempo(studio); },
    togglePause: async () => { if (live) { pauseTempo(); return false; } return startTempo(studio); },
    stop,
    exportWav: () => exportTempoWav(studio),
  };
}

/** WAV of the studio at its tempo (output stage included). / 템포가 적용된 WAV */
export async function exportTempoWav(studio, { download = true } = {}) {
  const pr = playRates(studio);
  const buf = await renderAt(studio, pr.docR, EXPORT_SAMPLE_RATE);
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const len = Math.ceil((buf.duration / pr.v + 0.05) * EXPORT_SAMPLE_RATE);
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, len, EXPORT_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = pr.v;
  src.connect(createOfflineOutput(ctx));
  src.start(0);
  const out = await ctx.startRendering();
  const wav = encodeWav(out);
  const filename = `${studio}_x${pr.rate.toFixed(2)}_T${out.duration.toFixed(2)}s.wav`;
  const blob = new Blob([wav], { type: 'audio/wav' });
  if (download) triggerDownload(blob, filename);
  return { ok: true, filename, blob, bytes: wav.byteLength, durationSec: out.duration, message: t('toast.wavDone', filename) };
}
