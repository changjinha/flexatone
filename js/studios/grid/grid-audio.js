/**
 * Flexatone — studios/grid/grid-audio.js
 * Grid Studio — the AUDIO ENGINE tier: plays and renders the BAKED runs (the lines as the warped
 * space carries them). One oscillator per run: frequency / gain / pan curves read from the run.
 * 그리드 스튜디오의 오디오 엔진 계층: 베이킹된 조각(변형된 공간이 옮긴 선)만 재생·렌더링.
 * 조각마다 오실레이터 하나 (주파수·게인·팬 곡선).
 *
 * Layer note / 계층 메모: lives in the studio folder but belongs to the audio tier — only
 * ui/workspaces.js, audio/studio-clips.js and grid-panels.js import it.
 *
 * Sound of a run: when the source is the Glissando Studio and sound = 'source', the voice keeps its
 * own timbre and gain envelope (read at the SOURCE time of every point, so the envelope bends with
 * the space); otherwise the studio's own timbre (shared timbre editor) and a flat level.
 * 소리: 소스가 글리산도이고 sound = 'source'이면 보이스가 자기 음색·포락선을 유지 (각 점의 원본 시각에서 읽으므로
 * 포락선도 공간과 함께 휨). 그 외에는 스튜디오 자체 음색과 일정한 레벨.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToFreq } from '../../core/units.js';
import { t } from '../../core/i18n.js';
import { appState, registerSelfCheck, withIsolatedState } from '../../core/state.js';
import { createTimbreWave, studioLiveOutput, connectStudioOutput } from '../../audio/studio-fx.js';
import { getOutputBus, createOfflineOutput } from '../../audio/output-bus.js';
import { encodeWav, triggerDownload, measurePeak, EXPORT_SAMPLE_RATE, createVoicePeriodicWave } from '../../audio/audio-engine.js';
import { createLiveTransport } from '../../audio/live-transport.js';
import { sanitizeWarpStack } from '../../modules/space-warp.js';
import { runAt, sanitizeGridParams, createDefaultGridParams, getGridBakeCount, GRID_OWN } from './grid-engine.js';
import { getGridParams, getGridBake, resolveGridDoc, runSourceVoice, runAmpAt, gridResultKey, buildGridExport } from '../grid-studio.js';

/** Same master gain live and offline → Export WAV = what you hear. / 실시간·오프라인 동일 */
export const GRID_MASTER = 0.32;
const START_LEAD_SEC = 0.03;
const F_MIN = 20;
const F_MAX = 20000;

/** Audible runs of a document and the end of the timeline. / 발음 조각과 타임라인 끝 */
export function getGridTimeline(params = getGridParams()) {
  const bake = getGridBake(params);
  const anySolo = params.source.studio === 'glissando' && appState.voices.some((v) => v.solo);
  const items = [];
  for (const run of bake.runs) {
    const voice = runSourceVoice(params, run);
    if (voice && (anySolo ? !voice.solo : voice.muted)) continue;
    items.push({ run, voice });
  }
  return { bake, items, endSec: bake.endSec };
}

/**
 * Master gain with a static headroom guard: the worst-case in-phase sum of the audible runs stays
 * ≤ 0.98 before the output stage. Same value live and offline.
 * 최악의 동위상 합이 0.98 이하가 되도록 마스터를 낮춤 (실시간·오프라인 동일).
 */
export function gridMasterGain(params = getGridParams(), tl = getGridTimeline(params)) {
  if (!tl.items.length) return GRID_MASTER;
  const N = 200;
  let peak = 0;
  for (let i = 0; i <= N; i++) {
    const sec = (i / N) * tl.endSec;
    let sum = 0;
    for (const { run, voice } of tl.items) if (sec >= run.pts[0].t && sec <= run.pts[run.pts.length - 1].t) sum += params.gain * runAmpAt(params, run, sec, voice);
    if (sum > peak) peak = sum;
  }
  return peak * GRID_MASTER > 0.98 ? 0.98 / peak : GRID_MASTER;
}

/**
 * Schedule one run from `cueSec` at context time `nowTime`. timeScale = Tempo Manager rate (pitch
 * kept): document second s sounds at s / timeScale; masks and warps are read in that real time.
 * 조각 하나 스케줄. timeScale = 템포 배속 (음고 유지).
 */
export function scheduleRun(ctx, dest, params, item, nowTime, cueSec, nodeList, waveCache, { ampMask = null, pitchWarp = null, timeScale = 1 } = {}) {
  const { run, voice } = item;
  const k = timeScale > 0 ? timeScale : 1;
  const start = run.pts[0].t;
  const end = run.pts[run.pts.length - 1].t;
  if (end <= cueSec + 1e-4) return false;
  const from = Math.max(start, cueSec);
  const playDur = end - from;
  if (playDur <= 0.01) return false;
  const keep = voice && params.sound === 'source';
  const wkey = keep ? `v:${voice.id}` : 'grid';
  let wave = waveCache.get(wkey);
  if (!wave) {
    wave = keep ? createVoicePeriodicWave(ctx, voice) : createTimbreWave(ctx, params.timbre); // the voice's own timbre, or the studio's / 보이스 자신의 음색 또는 스튜디오 음색
    waveCache.set(wkey, wave);
  }
  const n = Math.max(16, Math.min(4096, Math.ceil(playDur * 200)));
  const fc = new Float32Array(n);
  const gc = new Float32Array(n);
  const pc = new Float32Array(n);
  const realDur = playDur / k;
  const fade = Math.min(0.006, realDur * 0.2);
  let pan = false;
  for (let i = 0; i < n; i++) {
    const loc = (i / (n - 1)) * playDur;
    const sec = from + loc;
    const real = sec / k;
    const rloc = loc / k;
    const q = runAt(run, sec);
    const hz = midiToFreq(q.m);
    fc[i] = clamp(pitchWarp ? pitchWarp(real, hz) : hz, F_MIN, F_MAX); // Manager Warp / 매니저 곡률
    let g = params.gain * runAmpAt(params, run, sec, voice);
    if (rloc < fade) g *= rloc / fade;
    if (realDur - rloc < fade) g *= (realDur - rloc) / fade;
    if (ampMask && g > 0) g *= Math.max(0, ampMask(real, fc[i])); // Manager shape mask / 매니저 모양 마스크
    gc[i] = Math.max(0, g);
    pc[i] = q.pan;
    if (q.pan !== 0) pan = true;
  }
  const t0 = nowTime + Math.max(0, start - cueSec) / k;
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  const gain = ctx.createGain();
  osc.frequency.setValueCurveAtTime(fc, t0, realDur);
  gain.gain.setValueAtTime(0, nowTime);
  gain.gain.setValueCurveAtTime(gc, t0, realDur);
  let last = gain;
  if (pan && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.setValueCurveAtTime(pc, t0, realDur);
    gain.connect(p);
    last = p;
    if (nodeList) nodeList.push(p);
  }
  osc.connect(gain);
  last.connect(dest);
  osc.start(t0);
  osc.stop(t0 + realDur + 0.01);
  if (nodeList) nodeList.push(osc, gain);
  return true;
}

export function scheduleGrid(ctx, dest, { params = getGridParams(), nowTime, cueSec, nodeList, ampMask = null, pitchWarp = null, timeScale = 1 }) {
  const waveCache = new Map();
  let n = 0;
  for (const item of getGridTimeline(params).items) if (scheduleRun(ctx, dest, params, item, nowTime, cueSec, nodeList, waveCache, { ampMask, pitchWarp, timeScale })) n++;
  return n;
}

// --------------------------------------------------------------------------
// Live transport / 실시간 트랜스포트
// --------------------------------------------------------------------------

const transport = createLiveTransport({
  leadSec: START_LEAD_SEC,
  wrapStart: true,
  cueDigits: 3,
  // edits of the space, the sound or the SOURCE lines are heard from the playhead / 공간·소리·원본 선의 편집을 플레이헤드부터 반영
  editKey: () => gridResultKey(getGridParams()),
  endSec: () => { const { endSec } = getGridTimeline(); return endSec > 0.02 ? endSec : null; },
  plan: () => { const params = getGridParams(); const tl = getGridTimeline(params); return { params, endSec: tl.endSec, tl }; },
  masterGain: ({ params, tl }) => gridMasterGain(params, tl),
  output: (ctx) => studioLiveOutput(ctx, 'grid', () => getGridParams().tremolo, getOutputBus(ctx)), // → studio output tremolo → bus / 스튜디오 출력 트레몰로 경유
  schedule: (ctx, master, { params }, { when, fromSec, nodes }) => { scheduleGrid(ctx, master, { params, nowTime: when, cueSec: fromSec, nodeList: nodes }); },
});

export const isGridPlaying = transport.isPlaying;
export const getGridPlayheadSec = transport.playheadSec;
/** Play from the shared cue, or from `fromSec` without moving the cue. / 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 */
export const startGridAudio = transport.start;
export const stopGridAudio = transport.stop;
export const toggleGridPause = transport.togglePause;
export const toggleGridPlay = transport.togglePlay;

// --------------------------------------------------------------------------
// Offline render, WAV, JSON / 오프라인 렌더, WAV, JSON
// --------------------------------------------------------------------------

/** Offline render (the same scheduler as live). timeScale = Tempo Manager rate (pitch kept). / 오프라인 렌더 */
export async function renderGridBuffer({ params = getGridParams(), sampleRate = EXPORT_SAMPLE_RATE, outputStage = true, ampMask = null, pitchWarp = null, timeScale = 1 } = {}) {
  const tl = getGridTimeline(params);
  if (tl.endSec <= 0.02 || !tl.items.length) return null;
  const k = timeScale > 0 ? timeScale : 1;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil((tl.endSec / k + 0.05) * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = gridMasterGain(params, tl);
  connectStudioOutput(ctx, master, outputStage ? createOfflineOutput(ctx) : ctx.destination, params.tremolo); // same tremolo as live / 실시간과 같은 트레몰로
  scheduleGrid(ctx, master, { params, nowTime: 0, cueSec: 0, ampMask, pitchWarp, timeScale: k });
  return ctx.startRendering();
}

/** Re-render key for the Manager (view / brush edits keep it). / 매니저의 재렌더 키 */
export const gridRenderKey = (doc) => gridResultKey(resolveGridDoc(doc));

export async function exportGridWav({ download = true } = {}) {
  const params = getGridParams();
  const buf = await renderGridBuffer({ params });
  if (!buf) return { ok: false, message: t('toast.noAudio') };
  const wav = encodeWav(buf);
  const filename = `Grid_${String(params.preset || 'space').replace(/[^A-Za-z0-9_-]+/g, '-')}_T${(buf.length / buf.sampleRate).toFixed(2)}s.wav`;
  if (download) triggerDownload(new Blob([wav], { type: 'audio/wav' }), filename);
  return { ok: true, filename, bytes: wav.byteLength, peak: measurePeak(buf), durationSec: buf.length / buf.sampleRate, message: t('toast.wavDone', filename) };
}

export function exportGridJson({ download = true } = {}) {
  const payload = buildGridExport();
  if (download) triggerDownload(new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'Grid_Space.json');
  return payload;
}

// ==========================================================================
// Self-checks (audio tier) / 자가진단 (오디오 계층)
// ==========================================================================

/** Power of a sinusoid at f in d[i0, i1) (Goertzel). / 주파수 f의 파워 */
function tonePower(d, f, fs, i0 = 0, i1 = d.length) {
  const c = 2 * Math.cos((2 * Math.PI * f) / fs);
  let s1 = 0;
  let s2 = 0;
  for (let i = i0; i < i1; i++) { const s0 = d[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / Math.max(1, i1 - i0);
}
const rmsOf = (d, i0 = 0, i1 = d.length) => { let s = 0; for (let i = i0; i < i1; i++) s += d[i] * d[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
const own = (space, over = {}) => sanitizeGridParams({ ...createDefaultGridParams(), source: { studio: GRID_OWN }, sound: 'grid', timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, space: sanitizeWarpStack(space), ...over });

registerSelfCheck('Grid: render — a warped space moves the pitch that is heard, chromatic copies at exact ratios, peak ≤ 1, 0 bakes while rendering', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  const fs = 24000;
  const seg = [Math.round(1.5 * fs), Math.round(2.5 * fs)]; // only the C3 demo line (130.81 Hz) sounds here / 이 구간에는 C3 선만
  const f0 = midiToFreq(48);
  const flat = await renderGridBuffer({ params: own([]), sampleRate: fs, outputStage: false });
  const d0 = flat.getChannelData(0);
  a.ok(tonePower(d0, f0, fs, ...seg) > 1e-4, 'flat space: the line sounds at its own pitch');
  a.ok(measurePeak(flat) <= 1, `peak ${measurePeak(flat).toFixed(3)} ≤ 1`);
  // the whole space pushed up by 2 semitones around the line / 선 주변 공간을 2반음 위로 밀기
  const push = own([{ type: 'liquify', params: { ops: [{ tool: 'push', size: 400, strength: 1, pts: [[16, 96], [16, 100]] }] } }]);
  const count = getGridBakeCount();
  const up = (await renderGridBuffer({ params: push, sampleRate: fs, outputStage: false })).getChannelData(0);
  const f2 = midiToFreq(50);
  a.ok(tonePower(up, f2, fs, ...seg) > 30 * tonePower(up, f0, fs, ...seg), 'pushed space: the same line is heard 2 semitones higher');
  a.equal(getGridBakeCount(), count, 'a document that is not on screen never raises the editor bake count');
  // chromatic copies: energy at exactly 2:3 and 3:2 / 정확히 2:3, 3:2 위치의 에너지
  const ch = (await renderGridBuffer({ params: own([{ type: 'chroma', params: { link: false, rP: 2, rQ: 3, bP: 3, bQ: 2, rTimeMs: 0, bTimeMs: 0, rPan: 0, bPan: 0 } }]), sampleRate: fs, outputStage: false })).getChannelData(0);
  for (const r of [2 / 3, 1, 3 / 2]) a.ok(tonePower(ch, f0 * r, fs, ...seg) > 50 * tonePower(ch, f0 * r * 1.03, fs, ...seg), `copy at f·${r.toFixed(4)}`);
  // halftone gates the level, tempo ×2 halves the clip at the same pitch, mask and Manager warp act
  const dots = (await renderGridBuffer({ params: own([{ type: 'halftone', params: { periodMs: 200, duty: 0.3, jitter: 0, silenceJitter: 0 } }]), sampleRate: fs, outputStage: false })).getChannelData(0);
  a.ok(rmsOf(dots, ...seg) < 0.75 * rmsOf(d0, ...seg) && rmsOf(dots, ...seg) > 0.3 * rmsOf(d0, ...seg), 'halftone lowers the mean level (duty 0.3)');
  const fast = await renderGridBuffer({ params: own([]), sampleRate: fs, outputStage: false, timeScale: 2 });
  a.near(fast.length / fs - 0.05, (flat.length / fs - 0.05) / 2, 0.01, 'tempo ×2: half as long');
  a.ok(tonePower(fast.getChannelData(0), f0, fs, Math.round(0.75 * fs), Math.round(1.25 * fs)) > 1e-4, 'tempo ×2: same pitch');
  const none = await renderGridBuffer({ params: own([]), sampleRate: fs, outputStage: false, ampMask: () => 0 });
  a.ok(rmsOf(none.getChannelData(0)) < 1e-6, 'shape mask 0 → silence');
  const mw = (await renderGridBuffer({ params: own([]), sampleRate: fs, outputStage: false, pitchWarp: (sec, hz) => hz * 2 })).getChannelData(0);
  a.ok(tonePower(mw, 2 * f0, fs, ...seg) > 30 * tonePower(mw, f0, fs, ...seg), 'Manager warp is applied on top');
}, { group: 'audio' });

registerSelfCheck('Grid: Glissando source — the voice keeps its own envelope and is not edited', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  const out = await withIsolatedState(async () => {
    const before = JSON.stringify(appState.voices);
    const params = sanitizeGridParams({ ...createDefaultGridParams(), source: { studio: 'glissando' }, space: sanitizeWarpStack([{ type: 'wave', params: { ampSemi: 2, periodSec: 1 } }]) });
    const tl = getGridTimeline(params);
    const buf = await renderGridBuffer({ params, sampleRate: 24000, outputStage: false });
    return { runs: tl.items.length, voices: appState.voices.length, same: JSON.stringify(appState.voices) === before, rms: buf ? rmsOf(buf.getChannelData(0)) : 0, keyA: gridResultKey(params), keyB: gridResultKey(sanitizeGridParams({ ...params, view: { ...params.view, tMin: 1 } })) };
  });
  a.ok(out.runs >= 1 && out.runs >= out.voices, `${out.voices} voice(s) → ${out.runs} run(s)`);
  a.ok(out.rms > 1e-4, 'the warped voice sounds');
  a.ok(out.same, 'the source voices are untouched');
  a.equal(out.keyA, out.keyB, 'a view edit keeps the render key');
}, { group: 'audio' });
