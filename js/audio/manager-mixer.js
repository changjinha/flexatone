/**
 * Flexatone — audio/manager-mixer.js
 * Layer 3 (audio): the Manager's multi-instance mixer. Every studio instance is a track that
 * can sound at the same time as the others — like several apps running at once.
 * 계층 3 (audio): 매니저 멀티 인스턴스 믹서. 각 인스턴스는 다른 트랙과 동시에 소리 나는 트랙.
 * Term: a "Track" in the UI and docs is called "channel" in this file's identifiers (channels, chGain,
 * channelRates, …); they were not renamed. Not an audio channel (L/R). / 용어: UI·문서의 "트랙" = 이 파일의 channel 식별자.
 *
 * Track graph / 트랙 그래프
 *   source ─▶ cycleGate ─┐
 *   source ─▶ freeGate  ─┴▶ chGain (fader · mute/solo) ─▶ analyser ─▶ output bus (master fader)
 *   - Glissando / Field: the instance document is rendered offline into an AudioBuffer (cached by
 *     document content, re-rendered ~0.25 s after an edit and hot-swapped while playing).
 *   - Risset: an independent live engine per instance (createRissetEngine), stepped here.
 *   글리산도·필드 = 문서를 버퍼로 렌더링(편집 시 재렌더링·핫스왑), 리세 = 인스턴스별 실시간 엔진.
 *
 * Two ways to play / 두 가지 재생 방식
 *   - Launch (free): one track loops on its own until stopped.              런치: 트랙 단독 반복
 *   - Cycle: every instance with inCycle plays its clip [start, start+length) on a shared clock;
 *     the whole cycle repeats when cycleLoop is on. Serial / parallel = clip placement.
 *     사이클: 공용 시계 위에서 클립 배치대로 재생, cycleLoop면 전체 반복.
 *
 * Tempo Manager: every track plays at master tempo × instance tempo (channelRates). Glissando /
 * Field documents are time-scaled before rendering (pitch is unchanged), Risset's engine clock
 * runs at that rate. Arrangement times (start / length / fades) are real seconds; the master
 * tempo rescales them when it changes (core/manager-state.js setManagerTempo).
 * 템포 매니저: 트랙 재생 배속 = 마스터 × 인스턴스. 글리산도·필드는 문서 시간을 재스케일해 렌더링, 리세는 엔진 시계를 배속.
 *
 * Tape mode (tempo.tape): the tape part of the rate is NOT rendered into the document — the
 * buffer keeps its pitch and AudioBufferSourceNode.playbackRate does the varispeed, so a tempo
 * change just glides playbackRate (τ = glide / 3) with no re-render. Risset shifts baseMidi by
 * 12·log2(tape) and glides its clock. 테이프 모드: 버퍼는 그대로 두고 playbackRate로 속도·음고를 함께 바꿈 (재렌더 없음).
 *
 * The editor transport (header Play) is independent: switching studio tabs only stops the editor
 * preview, never the Manager. / 헤더 재생(에디터 미리듣기)과 독립 — 탭 전환이 매니저를 끄지 않음.
 */

import { clamp } from '../core/math-utils.js';
import { dbToAmp, freqToMidi, midiToFreq } from '../core/units.js';
import { buildShapeMask, shapeMaskKey } from '../core/shape-select.js';
import { t } from '../core/i18n.js';
import { appState } from '../core/state.js';
import { listInstances, getInstance, getInstanceDoc, isInstanceAudible, silencedSpans, listRegions, channelRates, warpSourcesFor } from '../core/manager-state.js';
import { createPitchWarp, createWarpMod, createWarpRate } from '../modules/pitch-warp.js';
import { buildTimeMap, resampleTape, wsolaStretch } from '../modules/time-warp.js';
import { getWarpSourceTable, trackRefPitch, voiceSolos } from './warp-sources.js';
import { tapeSemitones } from '../core/tempo.js';
import { takeLength, takeOffset } from '../core/take-config.js';
import { applyTempoToVoices, applyTempoToFieldParams } from '../modules/tempo-manager.js';
import { StudioRegistry } from '../studios/registry.js';
import { ensureAudioCtx, getAudioCtx, getPlayableTimeline, renderOfflineBuffer, encodeWav, triggerDownload, EXPORT_SAMPLE_RATE } from './audio-engine.js';
import { getOutputBus, createOfflineOutput } from './output-bus.js';
import { renderMirrored } from './time-mirror.js';
import { createTremoloEvaluator } from '../modules/tremolo.js';
import { renderFieldBuffer, getFieldTimeline } from '../studios/field/field-audio.js';
import { createRissetEngine, resolveRissetDoc, renderRissetBuffer } from '../studios/risset/risset-audio.js';
import { isClipStudio, resolveClipParams, clipStudioLength, renderClipStudio, clipStudioScalesTime, clipStudioKey } from './studio-clips.js';

const LEAD_SEC = 0.08;
const LOOKAHEAD_SEC = 0.5;
const SWAP_FADE = 0.025;
export const DEFAULT_RISSET_CLIP = 8;

const channels = new Map(); // instId → channel
let cycle = null; // { t0, nextAt, occ: [{ at, len }], timer }
let cue = 0; // cycle time where Play starts (Master View playhead) / 재생 시작 위치 (마스터 뷰 플레이헤드)
let tickTimer = null;
let lastTick = 0;
let syncTimer = null;
const listeners = new Set();

const notify = () => { for (const fn of listeners) { try { fn(); } catch (err) { console.error(err); } } };

/** Listen for mixer play-state changes. Returns unsubscribe. / 재생 상태 변경 구독 */
export function onMixerChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// --------------------------------------------------------------------------
// Documents & lengths / 문서와 길이
// --------------------------------------------------------------------------

/** Risset params with the spectrum moved by a tape ratio (static, for offline renders). */
function shiftRissetPitch(params, tape) {
  const semis = tapeSemitones(tape);
  return semis ? { ...params, baseMidi: params.baseMidi + semis } : params;
}

/** Full params of a non-Glissando instance. / 인스턴스 전체 파라미터 */
function resolveParams(inst, doc = getInstanceDoc(inst)) {
  if (inst.studio === 'risset') return resolveRissetDoc(doc);
  if (isClipStudio(inst.studio)) return resolveClipParams(inst.studio, doc);
  const plugin = StudioRegistry.get(inst.studio);
  return { ...(plugin ? plugin.defaultParams() : {}), ...(doc && typeof doc === 'object' ? doc : {}) };
}

function glissVoices(doc) {
  return Array.isArray(doc?.voices) ? doc.voices : [];
}

/**
 * Natural (one-pass) length of an instance in seconds; Infinity for Risset (continuous).
 * 인스턴스의 자연 길이 (리세는 연속 음장이므로 Infinity).
 */
export function naturalLength(inst, doc = inst ? getInstanceDoc(inst) : null) {
  if (!inst) return 0;
  if (inst.take?.on) return takeLength(inst.take); // a take is a fixed piece of audio (len / tape ratio) / 테이크는 길이가 정해진 오디오
  if (inst.studio === 'risset') return Infinity;
  let base;
  if (inst.studio === 'glissando') base = getPlayableTimeline(glissVoices(doc)).endSec;
  else if (isClipStudio(inst.studio)) base = clipStudioLength(inst.studio, resolveParams(inst, doc));
  else base = getFieldTimeline(resolveParams(inst, doc)).endSec;
  const real = base / channelRates(inst).rate; // every time field scales by 1 / rate / 모든 시간이 1/배속
  // Warp time density: the content lasts as long as the track clock needs to play it / 곡률 시간 밀도
  const tw = inst.warp?.on ? null : timeOf(inst);
  if (!tw) return real;
  // voice clock: the clip lasts until the slowest voice has played its content / 보이스별 시계: 가장 느린 보이스까지
  const refs = tw.clock === 'voice' ? voiceRefsOf(inst, doc) : null;
  return refs ? Math.max(...refs.map((ref) => timeMapAt(inst, tw, ref).toReal(real))) : trackMap(inst, tw, doc).toReal(real);
}

/**
 * Playback-rate (varispeed) part of a channel: the tape ratio, or the whole rate for studios
 * without pitch-preserving time scaling (studio-clips.js). / 채널의 playbackRate 배율
 */
function varispeed(inst) {
  if (!inst) return 1;
  if (inst.take?.on) return Number(inst.take.rate) > 0 ? Number(inst.take.rate) : 1; // rendered at its real speed; only its own tape ratio remains / 테이크 자체의 테이프 배율만
  const r = channelRates(inst);
  return isClipStudio(inst.studio) && !clipStudioScalesTime(inst.studio) ? r.rate : r.tape; // Wave renders the doc rate itself / 웨이브는 문서 배속을 직접 렌더
}

/** Fixed cycle length in seconds, or null in 'auto' mode. / 고정 사이클 길이 (자동이면 null) */
export function fixedCycleLength() {
  const m = appState.manager;
  if (m?.cycleMode !== 'fixed') return null;
  const L = Number(m.cycleLen);
  return Number.isFinite(L) && L >= 0.1 ? L : null;
}

/**
 * Own length of an instance's clip, ignoring the fixed cycle (arrangement, drag handles).
 * In 'fixed' mode a looping clip with no explicit length fills the cycle from its start.
 * 클립 자체 길이 (고정 사이클로 자르지 않음). 고정 모드에서 길이 미지정 + 반복이면 사이클 끝까지 채움.
 */
export function ownClipLength(inst) {
  if (!inst) return 0;
  const fixed = fixedCycleLength();
  const auto = inst.length === null || inst.length === undefined;
  const fill = fixed !== null && auto && inst.loop ? Math.max(0, fixed - (Number(inst.start) || 0)) : null;
  if (inst.studio === 'risset' && !inst.take?.on) return fill !== null ? fill : Number(inst.length) || DEFAULT_RISSET_CLIP;
  const nat = naturalLength(inst);
  const len = fill !== null ? fill : auto ? nat : Number(inst.length);
  return inst.loop ? len : Math.min(len, nat);
}

/** Played length of an instance's clip in the cycle (cut at a fixed cycle end). / 사이클 안 재생 길이 */
export function clipLength(inst) {
  const own = ownClipLength(inst);
  const fixed = fixedCycleLength();
  if (fixed === null) return own;
  return Math.max(0, Math.min(own, fixed - (Number(inst.start) || 0)));
}

/** Total length = last clip end (≥ 0.5 s), whatever the mode. / 전체 길이 = 마지막 클립 끝 */
export function totalLength(instances = listInstances()) {
  let end = 0;
  for (const i of instances) if (i.inCycle) end = Math.max(end, (Number(i.start) || 0) + ownClipLength(i));
  return Math.max(0.5, end);
}

/** Length of one cycle: the fixed length, or the total length in 'auto' mode. / 사이클 길이 */
export function cycleLength(instances = listInstances()) {
  const fixed = fixedCycleLength();
  return fixed !== null ? fixed : totalLength(instances);
}

function docKey(inst, doc = getInstanceDoc(inst)) {
  if (inst.take?.on) {
    // a take depends on the forward clip it was taken from (rendered as the track `as` at `at`) / 테이크는 원래 클립에 의존
    const fwd = takeContext(inst);
    const r = channelRates(fwd);
    return JSON.stringify(['take', inst.take.rev, !!inst.take.mirror, inst.take.len, takeOffset(inst.take), inst.take.loop, r.rate, r.tape, fwd.start, fwd.noRanges ? 'raw' : silencedSpans(fwd.id, listRegions()), docKey(fwd, doc)]);
  }
  const shapes = shapeMaskKey(inst.id, listRegions());
  // mask is in cycle time; varispeed clips convert it with their rate / 사이클 시간 기준, varispeed 클립은 배속으로 변환
  const maskPart = shapes === '[]' ? '' : `${shapes}@${inst.start}${isClipStudio(inst.studio) ? `×${varispeed(inst)}` : ''}`;
  const rate = channelRates(inst).doc; // pitch-preserving part only; tape is playbackRate / 음고 유지 배속만 버퍼에 반영
  const trem = inst.tremolo?.on ? inst.tremolo : 0; // channel tremolo is baked into the buffer / 채널 트레몰로는 버퍼에 반영
  const w = warpOf(inst).key; // Warp tracks that bend this one / 이 트랙을 휘는 곡률 트랙
  const warp = w && inst.loop ? `${w}|loop ${clipLength(inst)}` : w; // looping + warped clips are unrolled / 반복+곡률 클립은 펼쳐서 렌더
  if (inst.studio === 'glissando') return JSON.stringify([glissVoices(doc), appState.legatoJoin, appState.joinGlideMs, maskPart, rate, trem, warp]);
  // A studio may name what its sound depends on, so view-only edits do not re-render. / 뷰 편집은 재렌더하지 않도록
  const own = isClipStudio(inst.studio) ? clipStudioKey(inst.studio, resolveParams(inst, doc)) : null;
  return JSON.stringify([own ?? doc ?? null, maskPart, rate, trem, warp]);
}

// --------------------------------------------------------------------------
// Warp (pitch-space curvature) / 곡률
// A Warp track is silent; while its clip plays in the cycle it bends the pitch space of its targets
// (modules/pitch-warp.js, audio/warp-sources.js). Warps are in cycle time, like the shape masks.
// 곡률 트랙은 소리 내지 않고, 클립이 재생되는 동안 대상 트랙의 피치 공간을 휨 (사이클 시간 기준).
// --------------------------------------------------------------------------

/** What a source's lines depend on (its document, not its mixer). / 출처 선이 의존하는 것 */
function sourceSoundKey(inst, doc) {
  if (inst.studio === 'glissando') return JSON.stringify(glissVoices(doc));
  const own = isClipStudio(inst.studio) ? clipStudioKey(inst.studio, resolveParams(inst, doc)) : null;
  return own ?? JSON.stringify(doc ?? null);
}

/** One createPitchWarp stage for a Warp source track, or null. / 곡률 출처 트랙의 단계 */
function warpStage(src) {
  const L = clipLength(src);
  if (!(L >= 0.02)) return null;
  const rate = channelRates(src).rate;
  const nat = src.studio === 'risset' ? Infinity : naturalLength(src) * rate; // document seconds / 문서 초
  const loopLen = src.loop && Number.isFinite(nat) && nat > 0.02 ? nat : 0;
  const duration = Math.min(600, loopLen > 0 ? loopLen : L * rate);
  const doc = getInstanceDoc(src);
  const w = src.warp;
  const tableKey = JSON.stringify([src.studio, sourceSoundKey(src, doc), w.mode, w.rest, w.after, w.returnSec, w.radius, w.amount, w.smooth, w.sieve, Math.round(duration * 1000)]);
  const params = src.studio === 'glissando' ? { voices: glissVoices(doc) } : resolveParams(src, doc);
  const table = getWarpSourceTable(tableKey, src.studio, params, w, duration);
  if (!table) return null;
  const start = Number(src.start) || 0;
  const fadeIn = src.fadeIn || 0;
  const fadeOut = src.fadeOut || 0;
  const sens = (k) => (w.params?.[k]?.on ? Number(w.params[k].sens) || 0 : 0);
  const mod = { level: sens('level'), trem: sens('trem'), bright: sens('bright'), time: sens('time') };
  return { table, depth: sens('pitch'), mod, timeMode: w.timeMode, timeClock: w.timeClock, start, length: L, rate, loopLen, fadeIn, fadeOut, key: `${tableKey}|${JSON.stringify(w.params)}|${mod.time ? `${w.timeMode}/${w.timeClock}` : ''}|${start}|${L}|${rate}|${loopLen}|${fadeIn}|${fadeOut}` };
}

/**
 * Warp of a target track: { key, fn: (cycleSec, midi) → midi | null, mod: (cycleSec, midi) →
 * { levelDb, trem, bright } | null }. / 대상 트랙의 곡률 (음고 fn, 그 밖의 구동 mod)
 */
function warpOf(target) {
  if (!target) return { key: '', fn: null, mod: null, rate: null };
  const stages = warpSourcesFor(target).map(warpStage).filter(Boolean);
  if (!stages.length) return { key: '', fn: null, mod: null, rate: null };
  const ts = stages.find((st) => st.mod.time); // the first time-driving source sets mode and clock / 시간 구동 첫 출처가 방식·시계를 정함
  return {
    key: stages.map((st) => st.key).join('§'),
    fn: createPitchWarp(stages),
    mod: createWarpMod(stages),
    rate: createWarpRate(stages),
    timeMode: ts?.timeMode || 'keep',
    timeClock: ts?.timeClock || 'track',
    end: Math.max(...stages.map((st) => st.start + st.length)),
  };
}

// --------------------------------------------------------------------------
// Warp time axis (modules/time-warp.js) / 곡률 시간축
// The target plays at r(T) = 2^(k·D/12): its content time is Φ(u) = ∫ r for real clip time u. Tape =
// resample (pitch × r), keep = WSOLA (pitch kept). Track clock: D read at the track's first pitch;
// voice clock: every voice rendered solo and re-timed at its own first pitch, then summed. The
// other hooks (pitch / level / brightness) read the real time of each sample (Φ⁻¹).
// 대상은 r(T)로 재생: 내용 시간 Φ(u). 테이프 = 재샘플링(음고 × r), 유지 = WSOLA. 트랙 시계 = 첫 음고,
// 보이스별 시계 = 보이스마다 따로 렌더해 자기 첫 음고로 시간 사상 후 합산.
// --------------------------------------------------------------------------

/** Time drive of a target: { rate, mode, clock, end } or null. / 대상의 시간 구동 */
function timeOf(inst) {
  if (!inst || inst.warp?.on || inst.studio === 'risset' && inst.take?.on) return null;
  const w = warpOf(inst);
  return w.rate ? { rate: w.rate, mode: w.timeMode, clock: w.timeClock, end: w.end, key: w.key } : null;
}

const refMemo = new WeakMap();
/** Track first pitch (memo per document object). / 트랙 첫 음고 (문서 객체별 메모) */
function refPitchOf(inst, doc = getInstanceDoc(inst)) {
  const keyObj = inst.studio === 'glissando' ? glissVoices(doc) : doc;
  if (keyObj && typeof keyObj === 'object' && refMemo.has(keyObj)) return refMemo.get(keyObj);
  const params = inst.studio === 'glissando' ? { voices: glissVoices(doc) } : resolveParams(inst, doc);
  const ref = trackRefPitch(inst.studio, params);
  if (keyObj && typeof keyObj === 'object') refMemo.set(keyObj, ref);
  return ref;
}

const voiceRefMemo = new WeakMap();
/** First pitches of the voices for the voice clock (memo per document object), or null. / 보이스 첫 음고 */
function voiceRefsOf(inst, doc = getInstanceDoc(inst)) {
  const keyObj = inst.studio === 'glissando' ? glissVoices(doc) : doc;
  if (keyObj && typeof keyObj === 'object' && voiceRefMemo.has(keyObj)) return voiceRefMemo.get(keyObj);
  const params = inst.studio === 'glissando' ? { voices: glissVoices(doc) } : resolveParams(inst, doc);
  const refs = voiceSolos(inst.studio, params)?.map((x) => x.ref) || null;
  if (keyObj && typeof keyObj === 'object') voiceRefMemo.set(keyObj, refs);
  return refs;
}

const mapMemo = new Map();
/** Time map of a target read at pitch `ref` (real clip seconds from its start). / 기준 음고의 시간 사상 */
function timeMapAt(inst, tw, ref) {
  const start = Number(inst.start) || 0;
  const U = clamp(tw.end - start + 1, 1, 600);
  const key = `${inst.id}|${tw.key}|${Math.round(ref * 100)}|${start}|${U}`;
  let m = mapMemo.get(key);
  if (!m) {
    m = buildTimeMap((u) => tw.rate(start + u, ref), U);
    mapMemo.set(key, m);
    if (mapMemo.size > 64) mapMemo.delete(mapMemo.keys().next().value);
  }
  return m;
}

function trackMap(inst, tw, doc) {
  return timeMapAt(inst, tw, refPitchOf(inst, doc));
}

/**
 * Re-time sample arrays (buffer seconds, played at varispeed v) through a real-time map.
 * 샘플 배열을 시간 사상으로 다시 맞춤 (버퍼 초, varispeed v로 재생).
 */
function retimeArrays(inputs, map, v, outLen, sampleRate, mode) {
  const bufMap = v === 1 ? map : { toContent: (x) => v * map.toContent(x / v) };
  return mode === 'tape' ? resampleTape(inputs, bufMap, outLen, sampleRate) : wsolaStretch(inputs, bufMap, outLen, sampleRate);
}

/** One document (whole track or one solo voice) rendered and re-timed with `map`. / 문서 하나 렌더 후 재시간 */
async function renderRetimed(inst, doc, sampleRate, map, outLen, mode) {
  const start = Number(inst.start) || 0;
  const v = varispeed(inst);
  const L = clipLength(inst);
  const need = map.toContent(L) + 0.05; // content seconds the clip reaches / 클립이 닿는 내용 시간
  const first = await renderPass(inst, doc, sampleRate, start, (sec) => map.toReal(sec));
  if (!first) return null;
  const parts = [first];
  const P = first.duration / v;
  if (inst.loop && P > 0.02) {
    const reps = Math.min(UNROLL_MAX_PASSES, Math.ceil(need / P - 1e-6));
    for (let r = 1; r < reps; r++) parts.push(await renderPass(inst, doc, sampleRate, start, (sec) => map.toReal(r * P + sec)));
  }
  const n = first.length;
  const inputs = Array.from({ length: first.numberOfChannels }, (_, c) => {
    const x = new Float32Array(n * parts.length);
    parts.forEach((b, r) => { if (b) x.set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)).subarray(0, n), r * n); });
    return x;
  });
  return retimeArrays(inputs, map, v, outLen, sampleRate, mode);
}

/**
 * Buffer of a clip whose time a Warp track bends: track clock = one render re-timed at the track's
 * first pitch; voice clock = each voice solo, re-timed at its own first pitch, summed (studios with
 * no separable voices, or too many, use the track clock). / 시간이 휘는 클립의 버퍼
 */
async function renderTimeWarped(inst, sampleRate, doc, tw) {
  const v = varispeed(inst);
  const outLen = Math.max(1, Math.ceil(clipLength(inst) * v * sampleRate));
  const params = inst.studio === 'glissando' ? { voices: glissVoices(doc) } : resolveParams(inst, doc);
  const solos = tw.clock === 'voice' ? voiceSolos(inst.studio, params) : null;
  const items = solos ? solos.map((x) => ({ doc: inst.studio === 'glissando' ? { ...doc, voices: x.params.voices } : x.params, ref: x.ref })) : [{ doc, ref: refPitchOf(inst, doc) }];
  let sum = null;
  for (const it of items) {
    const arr = await renderRetimed(inst, it.doc, sampleRate, timeMapAt(inst, tw, it.ref), outLen, tw.mode);
    if (!arr) continue;
    if (!sum) sum = arr;
    else for (let c = 0; c < sum.length; c++) { const a = sum[c]; const b = arr[Math.min(c, arr.length - 1)]; for (let i = 0; i < a.length; i++) a[i] += b[i]; }
  }
  if (!sum) return null;
  const out = new AudioBuffer({ length: outLen, numberOfChannels: sum.length, sampleRate });
  sum.forEach((x, c) => out.getChannelData(c).set(x));
  return out;
}

/**
 * Track clock of a target for the Master View: { clock, mode, map(ref), ref } or null.
 * 마스터 뷰용 대상 트랙 시계.
 */
export function getTrackTime(id) {
  const inst = getInstance(id);
  const tw = timeOf(inst);
  if (!tw) return null;
  return { clock: tw.clock, mode: tw.mode, ref: refPitchOf(inst), map: (ref) => timeMapAt(inst, tw, ref), voiceClock: tw.clock === 'voice' && !!voiceSolos(inst.studio, inst.studio === 'glissando' ? { voices: glissVoices(getInstanceDoc(inst)) } : resolveParams(inst)) };
}

let viewTime = undefined;
/** Rate field (cycleSec, midi) → r of the warps aimed at every track (else the first bent one), or null. */
export function getMasterViewTime() {
  if (viewTime === undefined) {
    viewTime = warpOf({ id: '\u0000view', warp: { on: false } }).rate;
    if (!viewTime) for (const inst of listInstances()) { if (inst.warp?.on) continue; const r = warpOf(inst).rate; if (r) { viewTime = r; break; } }
  }
  return viewTime;
}

/**
 * Gain of a target at (cycleSec, hz): Manager shape masks × the warp's level, tremolo and — for
 * Wave / Risset, whose sound is a spectrum of plain partials — brightness as a spectral tilt
 * (6 dB / oct per octave of drive, around the Wave range centre / the Risset bell centre).
 * Tremolo rate = the track's tremolo rate (0.5…12 Hz), phase from the cycle clock. Null when nothing applies.
 * 대상의 게인: 모양 마스크 × 곡률의 음량·트레몰로 (웨이브·리세는 밝기를 스펙트럼 기울기로).
 */
function makeGainAt(inst, mod) {
  const shape = buildShapeMask(inst.id, listRegions());
  if (!shape && !mod) return null;
  const rate = clamp(Number(inst.tremolo?.rate) || 5, 0.5, 12);
  let centre = null;
  if (mod && (inst.studio === 'wave' || inst.studio === 'risset')) {
    const p = resolveParams(inst);
    centre = inst.studio === 'wave' ? 0.5 * (p.pLo + p.pHi) : p.baseMidi + p.spanSemitones * (Number(p.envCenter) || 0.5);
  }
  return (T, hz) => {
    const m = freqToMidi(Math.max(1e-3, hz));
    let g = shape ? shape(T, m) : 1;
    if (mod) {
      const r = mod(T, m);
      if (r.levelDb) g *= dbToAmp(r.levelDb);
      if (r.trem > 0) g *= 1 - r.trem * 0.5 * (1 - Math.cos(2 * Math.PI * rate * T));
      if (centre !== null && r.bright) g *= dbToAmp(clamp((6 * r.bright * (m - centre)) / 12, -24, 24));
    }
    return g;
  };
}

/** Gain hook for an offline render of a clip starting at cycle time `start` (replaces the bare mask). */
function renderGain(inst, start = Number(inst.start) || 0, toReal = null) {
  const ga = makeGainAt(inst, warpOf(inst).mod);
  return ga ? (sec, hz) => ga(start + (toReal ? toReal(sec) : sec), hz) : null;
}

/**
 * Brightness hook (high-shelf gain in dB above the 2nd harmonic) for oscillator studios, or null.
 * Wave / Risset get brightness through makeGainAt instead. / 밝기 훅 (2배음 위 하이셸프 dB)
 */
function renderBright(inst, start = Number(inst.start) || 0, toReal = null) {
  if (inst.studio === 'wave' || inst.studio === 'risset') return null;
  const { mod } = warpOf(inst);
  if (!mod) return null;
  return (sec, hz) => clamp(12 * mod(start + (toReal ? toReal(sec) : sec), freqToMidi(Math.max(1e-3, hz))).bright, -24, 24);
}

/** Pitch warp for an offline render of a clip starting at cycle time `start`: (localSec, hz) → hz. */
function renderWarp(inst, start = Number(inst.start) || 0, toReal = null) {
  const { fn } = warpOf(inst);
  return fn ? (sec, hz) => midiToFreq(fn(start + (toReal ? toReal(sec) : sec), freqToMidi(Math.max(1e-3, hz)))) : null;
}

let viewWarp = undefined; // memo for the Master View, cleared by syncMixer / 마스터 뷰용 메모

/**
 * The warp that bends "every track" (sources aimed at all tracks), for drawing the bent grid in
 * the Master View: (cycleSec, midi) → midi, or null. / 마스터 뷰 격자용 곡률 (전체 대상)
 */
export function getMasterViewWarp() {
  if (viewWarp === undefined) {
    // Sources aimed at every track first; otherwise the warp of the first bent track / 전체 대상 곡률 우선, 없으면 처음 휘는 트랙
    viewWarp = warpOf({ id: '\u0000view', warp: { on: false } }).fn;
    if (!viewWarp) for (const inst of listInstances()) { if (inst.warp?.on) continue; const fn = warpOf(inst).fn; if (fn) { viewWarp = fn; break; } }
  }
  return viewWarp;
}

/** Warp that bends one track (cycle time), or null — for the Master View lines. / 트랙의 곡률 */
export function getTrackWarp(id) {
  // an id, or an instance-shaped object (a take context keeps its warpOnly filter) / id 또는 인스턴스 모양 객체
  return warpOf(id && typeof id === 'object' ? id : getInstance(id)).fn;
}

// --------------------------------------------------------------------------
// Tracks (identifiers say "channel") / 트랙
// --------------------------------------------------------------------------

function channelTarget(inst) {
  return isInstanceAudible(inst) ? dbToAmp(inst.gainDb || 0) : 0;
}

function ensureChannel(ctx, inst) {
  let ch = channels.get(inst.id);
  if (ch) return ch;
  const chGain = ctx.createGain();
  chGain.gain.value = channelTarget(inst);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const cycleGate = ctx.createGain();
  cycleGate.gain.value = 0;
  const freeGate = ctx.createGain();
  freeGate.gain.value = 0;
  // Range solo/mute automation (cycle only) / 구간 솔로·뮤트 자동화 (사이클 전용)
  const regionGate = ctx.createGain();
  regionGate.gain.value = 1;
  cycleGate.connect(regionGate).connect(chGain);
  freeGate.connect(chGain);
  chGain.connect(analyser);
  analyser.connect(getOutputBus(ctx));
  ch = {
    id: inst.id,
    studio: inst.studio,
    chGain,
    analyser,
    cycleGate,
    freeGate,
    regionGate,
    scope: new Float32Array(analyser.fftSize),
    buf: { key: null, buffer: null, pending: null },
    free: null, // { src, gain, t0 } | { risset: true }
    cycleSrcs: [], // [{ src, gain, at, end, loop }]
    risset: null, // { engine, bus, memo }
    rt: (({ rate, tape }) => ({ rate, tape }))(channelRates(inst)), // gliding speed / tape ratio (Risset) / 미끄러지는 속도
  };
  channels.set(inst.id, ch);
  return ch;
}

function disposeChannel(ch) {
  stopFree(ch, true);
  ch.cycleSrcs.forEach((s) => stopSource(s, 0));
  ch.cycleSrcs = [];
  stopRisset(ch);
  setTimeout(() => [ch.cycleGate, ch.freeGate, ch.regionGate, ch.chGain, ch.analyser].forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } }), 300);
  channels.delete(ch.id);
}

/**
 * Channel tremolo (instance-level, on top of any per-voice / per-particle tremolo): the rendered
 * clip is multiplied by the tremolo curve over its own length, so live playback, hot-swap and the
 * cycle WAV export all hear the same thing. Returns the input buffer when the tremolo is off.
 * 채널 트레몰로: 렌더된 클립에 클립 길이 기준 트레몰로 곡선을 곱함 (재생·핫스왑·WAV 동일).
 */
export function applyChannelTremolo(buffer, cfg) {
  if (!buffer) return buffer;
  const ev = createTremoloEvaluator({ ...cfg, sync: 'voice' }, { startTime: 0, duration: buffer.duration });
  if (!ev) return buffer;
  const n = buffer.length;
  const gains = new Float32Array(n);
  for (let i = 0; i < n; i++) gains[i] = ev.gainAtSec(i / buffer.sampleRate);
  const out = new AudioBuffer({ length: n, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) dst[i] = src[i] * gains[i];
  }
  return out;
}

/** Buffer of a Glissando / Field instance (rendered when its document changed). / 인스턴스 버퍼 */
const UNROLL_MAX_SEC = 180;
const UNROLL_MAX_PASSES = 64;

/**
 * One pass of a Glissando / Field / clip-studio document whose first sample sits at cycle time
 * `start` (masks and warps are read from there), with the track tremolo. / 사이클 시각 start에서 시작하는 1회 렌더
 */
async function renderPass(inst, doc, sampleRate, start, toReal = null) {
  const ampMask = renderGain(inst, start, toReal);
  const pitchWarp = renderWarp(inst, start, toReal);
  const brightWarp = renderBright(inst, start, toReal);
  const rate = channelRates(inst).doc;
  let buf;
  if (inst.studio === 'glissando') buf = await renderOfflineBuffer({ voices: applyTempoToVoices(glissVoices(doc), rate), sampleRate, ampMask, pitchWarp, brightWarp, voiceMod: doc?.params?.voiceMod ?? null });
  else if (isClipStudio(inst.studio)) buf = await renderClipStudio(inst.studio, resolveParams(inst, doc), sampleRate, { rate, ampMask, pitchWarp, brightWarp, varispeed: varispeed(inst) });
  else buf = await renderFieldBuffer({ params: applyTempoToFieldParams(resolveParams(inst, doc), rate), sampleRate, outputStage: false, ampMask, pitchWarp, brightWarp });
  return applyChannelTremolo(buf, inst.tremolo);
}

/**
 * Buffer of a non-Risset clip. A looping clip that a Warp track bends is unrolled: every pass is
 * rendered at its own cycle time (pass r starts at start + r·P, P = one pass in real seconds) and the
 * passes are joined, so each repeat hears the warp of its own moment. Capped at UNROLL_MAX_SEC /
 * UNROLL_MAX_PASSES — past that the unrolled buffer loops. Without a warp: one pass, looped as before.
 * 반복 클립에 곡률이 걸리면 회차마다 자기 사이클 시각으로 렌더해 이어 붙임 (상한 넘으면 펼친 버퍼를 반복).
 */
async function renderClipBuffer(inst, sampleRate, doc = getInstanceDoc(inst)) {
  const tw = timeOf(inst);
  if (tw) return renderTimeWarped(inst, sampleRate, doc, tw); // Warp time density / 곡률 시간 밀도
  const start = Number(inst.start) || 0;
  const first = await renderPass(inst, doc, sampleRate, start);
  const wo = warpOf(inst);
  if (!first || !inst.loop || !(wo.fn || wo.mod)) return first;
  const P = first.duration / varispeed(inst); // real seconds of one pass (the loop period) / 1회 실제 길이
  if (!(P > 0.02)) return first;
  const total = Math.min(clipLength(inst), UNROLL_MAX_SEC);
  const reps = Math.min(UNROLL_MAX_PASSES, Math.ceil(total / P - 1e-6));
  if (reps <= 1) return first;
  const n = first.length;
  const out = new AudioBuffer({ length: n * reps, numberOfChannels: first.numberOfChannels, sampleRate: first.sampleRate });
  const put = (buf, r) => {
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)).subarray(0, n), r * n);
  };
  put(first, 0);
  for (let r = 1; r < reps; r++) {
    const buf = await renderPass(inst, doc, sampleRate, start + r * P);
    if (buf) put(buf, r);
  }
  return out;
}

// --------------------------------------------------------------------------
// Takes (core/take-config.js): a clip as it sounded, optionally reversed / 테이크: 들리던 그대로의 클립 (역행 가능)
// --------------------------------------------------------------------------

/** Tracks played from a buffer: every studio but live Risset — and Risset too when it plays a take. */
function isBufferClip(inst) {
  return inst.studio !== 'risset' || !!inst.take?.on;
}

/**
 * The forward clip a take was taken from, as an instance-shaped object: this track's own document,
 * tempo and tremolo, placed at take.at for take.len, and carrying the id of the track `as` (so the
 * shape masks and Warp tracks that reached that track apply). Not a stored instance.
 * 테이크의 원래(순행) 클립을 인스턴스 모양 객체로: 문서·템포·트레몰로는 이 트랙의 것, 위치는 take.at / take.len,
 * id는 as 트랙의 것(그 트랙에 닿던 모양 마스크·곡률이 적용되도록). 저장되는 인스턴스가 아님.
 */
export function takeContext(inst) {
  const tk = inst.take;
  const as = tk.as && getInstance(tk.as) ? tk.as : inst.id;
  // ctxDoc: getInstanceDoc() returns it for this object, whatever track the borrowed id belongs to / 빌린 id와 무관하게 이 문서를 사용
  return { ...inst, id: as, ctxDoc: getInstanceDoc(inst), start: tk.at, length: tk.len, loop: tk.loop, take: tk.inner && tk.inner.on ? tk.inner : null, inCycle: true, noRanges: !!tk.raw, warpOnly: Array.isArray(tk.warps) ? tk.warps : null };
}

function reverseBuffer(buf) {
  const out = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    d.set(buf.getChannelData(c));
    d.reverse();
  }
  return out;
}

/**
 * The sound the clip `inst` makes over `L` real seconds from its start: its buffer played at its
 * varispeed (looped when the clip loops), or — Risset — an offline render of the field, gated by the
 * range solo / mute rules of its track. Stereo, exactly L seconds. / 클립이 시작부터 L초 동안 내는 소리 (varispeed·반복 포함, 리세는 오프라인 렌더). 정확히 L초.
 */
async function renderHeard(inst, doc, sampleRate, L) {
  let base;
  let rate = 1;
  let loop = false;
  if (inst.take?.on) {
    base = await renderTake(inst, doc, sampleRate);
    rate = varispeed(inst); // the take's own tape ratio / 테이크 자체의 테이프 배율
    loop = !!inst.loop;
  } else if (inst.studio === 'risset') {
    const r = channelRates(inst);
    base = await renderRissetBuffer({ seconds: Math.min(180, Math.max(1, Math.ceil(L))), params: shiftRissetPitch(resolveParams(inst, doc), r.tape), sampleRate, outputStage: false, ampMask: renderGain(inst), pitchWarp: renderWarp(inst), timeScale: r.rate, extraTremolo: inst.tremolo?.on ? inst.tremolo : null });
  } else {
    base = await renderClipBuffer(inst, sampleRate, doc);
    rate = varispeed(inst);
    loop = !!inst.loop;
  }
  if (!base) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.max(1, Math.ceil(L * sampleRate)), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = base;
  src.playbackRate.value = rate;
  src.loop = loop;
  // Range solo / mute rules that silenced the clip are part of how it sounded / 구간 솔로·뮤트도 "들리던 소리"의 일부
  const gate = ctx.createGain();
  gate.gain.value = 1;
  if (!inst.noRanges) scheduleRegionMask(gate.gain, -(Number(inst.start) || 0), silencedSpans(inst.id, listRegions()), 0); // a raw take leaves them out / raw 테이크는 제외
  src.connect(gate).connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}

/**
 * Buffer of a take track: the forward clip as it sounded, reversed when take.rev, or rendered with its
 * score mirrored when take.mirror (settings retrograde). / 테이크 버퍼 (rev면 역행, mirror면 설정 역행)
 */
async function renderTake(inst, doc, sampleRate) {
  const tk = inst.take;
  let buf;
  if (tk.mirror) buf = await renderHeardMirrored(takeContext(inst), doc, sampleRate, tk.len);
  else {
    buf = await renderHeard(takeContext(inst), doc, sampleRate, tk.len);
    if (buf && tk.rev) buf = reverseBuffer(buf);
  }
  return trimBufferStart(buf, takeOffset(tk));
}

/** `buf` without its first `sec` seconds (take.off: a take that begins inside the clip). / 앞 sec초를 잘라낸 버퍼 */
function trimBufferStart(buf, sec) {
  const skip = buf ? Math.min(buf.length - 1, Math.round(sec * buf.sampleRate)) : 0;
  if (!(skip > 0)) return buf;
  const out = new AudioBuffer({ length: buf.length - skip, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(skip));
  return out;
}

/**
 * Settings retrograde of the clip `inst` over its first L real seconds (audio/time-mirror.js): the
 * render's score is mirrored about the end of that window, so the clip runs backwards as music while
 * every sound in it plays forwards; range solo / mute come back mirrored too. A looping clip mirrors
 * one pass and loops it from the phase the reflection lands on. Falls back to a tape reversal where
 * the score cannot be mirrored: a take of a take, a Warp time drive, a looping clip a Warp unrolls.
 * 클립의 처음 L초를 설정 역행으로: 렌더의 악보를 창 끝을 축으로 뒤집음 (소리는 순방향). 구간 솔로·뮤트도 뒤집힘.
 * 반복 클립은 1회분을 뒤집어 반사 위상부터 반복. 뒤집을 수 없는 경우(테이크의 테이크, 곡률 시간 구동, 곡률로
 * 펼친 반복)는 테이프 역행으로 대체.
 */
async function renderHeardMirrored(inst, doc, sampleRate, L) {
  const tape = async () => { const b = await renderHeard(inst, doc, sampleRate, L); return b ? reverseBuffer(b) : b; };
  const wo = inst.take?.on || inst.studio === 'risset' ? null : warpOf(inst);
  if (inst.take?.on || timeOf(inst) || inst.loop && wo && (wo.fn || wo.mod)) return tape();
  let base;
  let rate = 1;
  let loop = false;
  let res;
  if (inst.studio === 'risset') {
    const r = channelRates(inst);
    const sec = Math.min(180, Math.max(1, Math.ceil(L)));
    res = await renderMirrored(L, () => renderRissetBuffer({ seconds: sec, params: shiftRissetPitch(resolveParams(inst, doc), r.tape), sampleRate, outputStage: false, ampMask: renderGain(inst), pitchWarp: renderWarp(inst), timeScale: r.rate, extraTremolo: inst.tremolo?.on ? inst.tremolo : null }));
  } else {
    rate = varispeed(inst);
    loop = !!inst.loop;
    // one pass mirrored about its own length when looping; else about the window the clip plays / 반복이면 1회분 길이, 아니면 재생 창
    res = await renderMirrored(loop ? null : L * rate, () => renderPass(inst, doc, sampleRate, Number(inst.start) || 0));
  }
  if (!res.mirrored) return tape();
  base = res.buffer;
  if (!base) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.max(1, Math.ceil(L * sampleRate)), sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = base;
  src.playbackRate.value = rate;
  src.loop = loop;
  // forward real time u played buffer (u·rate) mod B; mirrored τ reads B − ((L − τ)·rate mod B) / 반사 위상
  const B = base.duration;
  const offset = loop && B > 0 ? ((((-L * rate) % B) + B) % B) : 0;
  const gate = ctx.createGain();
  gate.gain.value = 1;
  if (!inst.noRanges) {
    const a0 = Number(inst.start) || 0;
    const spans = silencedSpans(inst.id, listRegions()).map(([s0, s1]) => [L - (s1 - a0), L - (s0 - a0)]).filter(([s0, s1]) => s1 > 0 && s0 < L).sort((x, y) => x[0] - y[0]);
    scheduleRegionMask(gate.gain, 0, spans, 0);
  }
  src.connect(gate).connect(ctx.destination);
  src.start(0, offset);
  return ctx.startRendering();
}

// Takes made from the same clip (several entries of one track in an extension) share one rendered
// buffer: cached by what the take depends on, least recently used first out, bounded by seconds of audio.
// 같은 클립에서 만든 테이크들은 렌더된 버퍼 하나를 공유 (의존 내용으로 캐시, 오디오 초 단위 상한).
const takeCache = new Map(); // key → { job: Promise<AudioBuffer|null>, sec }
const TAKE_CACHE_SEC = 480;

function cachedTake(inst, doc, sampleRate) {
  const key = `${sampleRate}|${docKey(inst, doc)}`;
  let e = takeCache.get(key);
  if (e) { takeCache.delete(key); takeCache.set(key, e); return e.job; }
  e = { job: renderTake(inst, doc, sampleRate), sec: inst.take.len };
  takeCache.set(key, e);
  e.job.then((buf) => { if (!buf) takeCache.delete(key); }, () => takeCache.delete(key));
  let total = 0;
  for (const v of takeCache.values()) total += v.sec;
  for (const [k, v] of [...takeCache]) {
    if (total <= TAKE_CACHE_SEC || k === key) break;
    takeCache.delete(k);
    total -= v.sec;
  }
  return e.job;
}

/** Buffer a track plays: a take, or one (possibly unrolled) pass of its document. / 트랙이 재생하는 버퍼 */
function renderTrackBuffer(inst, sampleRate) {
  return inst.take?.on ? cachedTake(inst, getInstanceDoc(inst), sampleRate) : renderClipBuffer(inst, sampleRate);
}

/**
 * How loud every clip of the cycle is before its fader: Map id → { level, peak } in dBFS. `level` =
 * mean power of the louder half of its 100 ms windows (so long silences do not count), `peak` =
 * sample peak. Renders every clip once (as heard: masks, warps, tempo). Used by the Extend tools.
 * 사이클의 각 클립이 페이더 전에 얼마나 큰지: level = 100 ms 창 중 큰 절반의 평균 파워, peak = 샘플 피크.
 */
export async function measureClipLevels(sampleRate = EXPORT_SAMPLE_RATE) {
  const out = new Map();
  for (const inst of listInstances()) {
    if (!inst.inCycle || inst.warp?.on) continue;
    const L = clipLength(inst);
    if (L < 0.02) continue;
    let buf = null;
    try { buf = await renderHeard(inst, getInstanceDoc(inst), sampleRate, Math.min(L, 180)); } catch (err) { console.error('[Flexatone] level measure failed:', err); }
    if (!buf) continue;
    const win = Math.max(1, Math.round(0.1 * sampleRate));
    const pw = [];
    let peak = 0;
    for (let s0 = 0; s0 < buf.length; s0 += win) {
      let acc = 0;
      const s1 = Math.min(buf.length, s0 + win);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = s0; i < s1; i++) { const x = d[i]; acc += x * x; const ax = x < 0 ? -x : x; if (ax > peak) peak = ax; }
      }
      pw.push(acc / ((s1 - s0) * buf.numberOfChannels));
    }
    pw.sort((x, y) => y - x);
    const top = pw.slice(0, Math.max(1, Math.ceil(pw.length / 2)));
    const mean = top.reduce((x, y) => x + y, 0) / top.length;
    out.set(inst.id, { level: mean > 1e-12 ? 10 * Math.log10(mean) : -120, peak: peak > 1e-6 ? 20 * Math.log10(peak) : -120 });
  }
  return out;
}

async function getBuffer(ctx, inst) {
  const ch = ensureChannel(ctx, inst);
  const key = docKey(inst);
  if (ch.buf.key === key && !ch.buf.pending) return ch.buf.buffer;
  if (ch.buf.pending && ch.buf.pendingKey === key) return ch.buf.pending;
  const job = (async () => {
    try {
      return await renderTrackBuffer(inst, ctx.sampleRate);
    } catch (err) {
      console.error('[Flexatone] manager render failed:', err);
      return null;
    }
  })();
  ch.buf.pending = job;
  ch.buf.pendingKey = key;
  const buffer = await job;
  if (ch.buf.pending === job) {
    ch.buf = { key, buffer, pending: null };
  }
  return buffer;
}

function playSource(ctx, ch, buffer, dest, { at, offset = 0, end = null, loop = false, fade = SWAP_FADE }) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const tape = varispeed(getInstance(ch.id));
  src.playbackRate.value = tape; // tape = varispeed / 테이프 = 속도·음고 동시 변화
  offset *= tape; // offset is in real seconds, the buffer in buffer seconds / 실제 초 → 버퍼 초
  src.loop = !!loop;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(1, at + fade);
  src.connect(gain).connect(dest);
  const off = loop ? offset % buffer.duration : Math.min(offset, buffer.duration);
  src.start(at, off);
  if (end !== null) src.stop(end + 0.01);
  return { src, gain };
}

function stopSource(s, fade = SWAP_FADE) {
  const ctx = getAudioCtx();
  if (!s || !ctx) return;
  const now = ctx.currentTime;
  try {
    s.gain.gain.cancelScheduledValues(now);
    s.gain.gain.setValueAtTime(s.gain.gain.value, now);
    s.gain.gain.linearRampToValueAtTime(0, now + Math.max(0.005, fade));
    s.src.stop(now + Math.max(0.005, fade) + 0.02);
  } catch { /* already stopped */ }
  setTimeout(() => { try { s.src.disconnect(); s.gain.disconnect(); } catch { /* ignore */ } }, (fade + 0.1) * 1000);
}

// --------------------------------------------------------------------------
// Risset engines / 리세 엔진
// --------------------------------------------------------------------------

function ensureRisset(ctx, ch) {
  if (ch.risset) return ch.risset;
  const memo = { doc: undefined, params: null };
  const getParams = () => {
    const inst = getInstance(ch.id);
    const doc = inst ? getInstanceDoc(inst) : memo.doc;
    if (doc !== memo.doc || !memo.params) {
      memo.doc = doc;
      memo.params = resolveRissetDoc(doc);
      memo.shifted = null;
    }
    // Tape: the whole spectrum moves with the (gliding) tape ratio / 테이프: 스펙트럼 전체가 이동
    const semis = Math.round(tapeSemitones(ch.rt.tape) * 1000) / 1000;
    if (!semis) return memo.params;
    if (!memo.shifted || memo.shifted.semis !== semis) memo.shifted = { semis, params: { ...memo.params, baseMidi: memo.params.baseMidi + semis } };
    return memo.shifted.params;
  };
  const bus = ctx.createGain();
  bus.connect(ch.cycleGate);
  bus.connect(ch.freeGate);
  // Shape regions mask Risset voices by pitch at the current cycle time / 사이클 시각 기준 음고 마스크
  // + Warp level / tremolo / brightness (memo cleared by syncMixer) / 곡률 음량·트레몰로·밝기 포함
  const getMask = () => {
    const pos = cycle ? getCyclePosition() : null;
    if (!pos) return null;
    if (ch.gainAt === undefined) { const inst = getInstance(ch.id); ch.gainAt = inst ? makeGainAt(inst, warpOf(inst).mod) : null; }
    const ga = ch.gainAt;
    return ga ? (hz) => ga(pos.pos, hz) : null;
  };
  // Warp tracks bend the Risset voices at the current cycle time (memo cleared by syncMixer) / 곡률 (syncMixer가 메모 초기화)
  const getWarp = () => {
    const pos = cycle ? getCyclePosition() : null;
    if (!pos) return null;
    if (ch.warpFn === undefined) ch.warpFn = warpOf(getInstance(ch.id)).fn;
    const fn = ch.warpFn;
    // tape time density also moves the pitch by r / 테이프 시간 밀도는 음고도 r배
    const r = ch.timeR && ch.timeR.mode === 'tape' ? ch.timeR.r : 1;
    if (!fn && r === 1) return null;
    return (hz) => (fn ? midiToFreq(fn(pos.pos, freqToMidi(Math.max(1e-3, hz)))) : hz) * r;
  };
  const engine = createRissetEngine({ getParams, getMask, getWarp, getExtraTremolo: () => getInstance(ch.id)?.tremolo });
  engine.start(ctx, bus);
  ch.risset = { engine, bus };
  startTick();
  return ch.risset;
}

function stopRisset(ch) {
  if (!ch.risset) return;
  const r = ch.risset;
  ch.risset = null;
  r.engine.stop();
  setTimeout(() => { try { r.bus.disconnect(); } catch { /* ignore */ } }, 300);
}

/** Risset engines run only while their channel is launched or part of a playing cycle. */
function rissetNeeded(ch) {
  const inst = getInstance(ch.id);
  if (inst && isBufferClip(inst)) return false; // a Risset take plays from a buffer / 리세 테이크는 버퍼 재생
  return !!ch.free || (!!cycle && !!inst?.inCycle);
}

function startTick() {
  if (tickTimer !== null) return;
  lastTick = performance.now();
  // setInterval (not rAF) so engines keep running in a background tab / 백그라운드 탭에서도 동작
  tickTimer = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    let any = false;
    for (const ch of channels.values()) {
      if (!ch.risset) continue;
      any = true;
      const inst = getInstance(ch.id);
      if (inst) {
        // exponential glide in log space (tape machine spool) / 로그 공간 지수 평활
        const tg = channelRates(inst);
        const k = tg.glide > 0 ? 1 - Math.exp(-dt / (tg.glide / 3)) : 1;
        ch.rt.rate *= Math.pow(tg.rate / ch.rt.rate, k);
        ch.rt.tape *= Math.pow(tg.tape / ch.rt.tape, k);
      }
      // Warp time density: the runtime clock runs r(T) times faster during the cycle / 곡률 시간 밀도: 런타임 시계 × r(T)
      let r = 1;
      const pos = cycle ? getCyclePosition() : null;
      if (pos && inst) {
        if (ch.timeFn === undefined) { const tw = timeOf(inst); ch.timeFn = tw ? { ...tw, ref: refPitchOf(inst) } : null; }
        if (ch.timeFn) r = ch.timeFn.rate(pos.pos, ch.timeFn.ref);
        ch.timeR = ch.timeFn ? { r, mode: ch.timeFn.mode } : null;
      }
      try { ch.risset.engine.step(dt, ch.rt.rate * r); } catch (err) { console.error(err); }
    }
    if (!any) { clearInterval(tickTimer); tickTimer = null; }
  }, 25);
}

// --------------------------------------------------------------------------
// Gates / 게이트
// --------------------------------------------------------------------------

function rampGate(param, to, sec) {
  const ctx = getAudioCtx();
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(to, now + Math.max(0.01, sec));
}

const REGION_RAMP = 0.012;

/** Silence the given cycle-time spans of one occurrence starting at `at`. / 구간 무음 스케줄 */
function scheduleRegionMask(param, at, spans, begin = -Infinity) {
  for (const [s0, s1] of spans) {
    const a = at + s0;
    const b = at + s1;
    if (b <= begin) continue;
    if (a < begin) { param.setValueAtTime(0, begin); param.setValueAtTime(0, b); param.linearRampToValueAtTime(1, b + REGION_RAMP); continue; }
    param.setValueAtTime(1, a);
    param.linearRampToValueAtTime(0, a + Math.min(REGION_RAMP, (b - a) / 2));
    param.setValueAtTime(0, b);
    param.linearRampToValueAtTime(1, b + REGION_RAMP);
  }
}

function scheduleGate(param, at, end, fadeIn, fadeOut, begin = -Infinity) {
  const len = end - at;
  const fi = clamp(fadeIn, 0.005, len / 2);
  const fo = clamp(fadeOut, 0.005, len / 2);
  if (at < begin) {
    // Entered mid-clip (seek): start from the gate value at `begin` / 클립 중간에서 시작
    const g = begin < at + fi ? (begin - at) / fi : begin < end - fo ? 1 : (end - begin) / fo;
    param.setValueAtTime(0, begin);
    param.linearRampToValueAtTime(clamp(g, 0, 1), begin + 0.01);
    if (begin + 0.01 < at + fi) param.linearRampToValueAtTime(1, at + fi);
    if (begin + 0.01 < end - fo) param.setValueAtTime(1, end - fo);
    param.linearRampToValueAtTime(0, end);
    return;
  }
  param.setValueAtTime(0, at);
  param.linearRampToValueAtTime(1, at + fi);
  param.setValueAtTime(1, end - fo);
  param.linearRampToValueAtTime(0, end);
}

// --------------------------------------------------------------------------
// Launch (free play) / 런치 (단독 반복)
// --------------------------------------------------------------------------

export function isLaunched(id) {
  return !!channels.get(id)?.free;
}

/** Launch / stop one channel (loops by itself). Resolves false when it has nothing to play. */
export async function toggleLaunch(id) {
  const ch0 = channels.get(id);
  if (ch0?.free) { stopFree(ch0); notify(); return false; }
  const inst = getInstance(id);
  if (!inst || inst.warp?.on) return false; // a Warp track has nothing to play / 곡률 트랙은 재생할 소리가 없음
  const ctx = await ensureAudioCtx();
  const ch = ensureChannel(ctx, inst);
  if (!isBufferClip(inst)) {
    ensureRisset(ctx, ch);
    ch.free = { risset: true };
  } else {
    const buffer = await getBuffer(ctx, inst);
    if (!buffer || buffer.duration < 0.02) { notify(); return false; }
    if (ch.free) return true; // launched meanwhile / 그 사이 시작됨
    const at = ctx.currentTime + 0.02;
    ch.free = { ...playSource(ctx, ch, buffer, ch.freeGate, { at, loop: true }), t0: at };
  }
  rampGate(ch.freeGate.gain, 1, inst.fadeIn || 0.01);
  notify();
  return true;
}

function stopFree(ch, immediate = false) {
  if (!ch.free) return;
  const inst = getInstance(ch.id);
  const fade = immediate ? 0.02 : Math.max(0.02, inst?.fadeOut || 0.03);
  const f = ch.free;
  ch.free = null;
  if (getAudioCtx()) rampGate(ch.freeGate.gain, 0, fade);
  if (f.src) setTimeout(() => stopSource(f, 0.01), fade * 1000);
  if (!rissetNeeded(ch)) setTimeout(() => { if (!rissetNeeded(ch)) stopRisset(ch); }, fade * 1000 + 30);
}

// --------------------------------------------------------------------------
// Cycle / 사이클
// --------------------------------------------------------------------------

export function isCyclePlaying() {
  return !!cycle;
}

/** { pos, len, index } of the playing cycle, or null. / 재생 중 사이클 위치 */
export function getCyclePosition() {
  const ctx = getAudioCtx();
  if (!cycle || !ctx) return null;
  const now = ctx.currentTime;
  let cur = cycle.occ[0];
  for (const o of cycle.occ) if (o.at <= now) cur = o;
  return { pos: clamp(now - cur.at, 0, cur.len), len: cur.len, index: cur.index };
}

/** Cue = where the cycle starts playing (and where the playhead rests when stopped). / 큐 위치 */
export function getCycleCue() {
  const C = cycleLength();
  return C > 0 && cue < C ? cue : 0;
}

export function setCycleCue(sec) {
  const C = cycleLength();
  cue = clamp(Number(sec) || 0, 0, Math.max(0, C - 0.01));
  notify();
}

/**
 * Move the cycle playhead: sets the cue and, while the cycle plays, jumps there (restart from `sec`).
 * 플레이헤드 이동: 큐를 옮기고, 재생 중이면 그 위치에서 다시 재생.
 */
export async function seekCycle(sec) {
  setCycleCue(sec);
  if (!cycle) return true;
  stopCycle();
  return startCycle();
}

async function prepareBuffers(ctx) {
  const jobs = [];
  for (const inst of listInstances()) {
    if (!inst.inCycle || !isBufferClip(inst) || inst.warp?.on) continue;
    jobs.push(getBuffer(ctx, inst));
  }
  await Promise.all(jobs);
}

/**
 * Schedule one pass of the cycle that starts at ctx time `at`. `begin` (≥ at) is when sound may
 * actually start — after a seek the pass started in the past and clips are entered mid-way.
 * 사이클 1회 스케줄. 탐색 후에는 `at`이 과거이고 `begin`부터 클립 중간에서 시작.
 */
function scheduleOccurrence(ctx, at, begin = at) {
  const instances = listInstances();
  const len = cycleLength(instances);
  const index = cycle.occ.length ? cycle.occ[cycle.occ.length - 1].index + 1 : 0;
  for (const inst of instances) {
    if (!inst.inCycle || inst.warp?.on) continue; // Warp tracks are silent / 곡률 트랙은 무음
    const L = clipLength(inst);
    if (L < 0.02) continue;
    const ch = ensureChannel(ctx, inst);
    const a = at + (Number(inst.start) || 0);
    const b = a + L;
    if (b <= begin + 0.01) continue; // already over (seek) / 이미 지난 클립
    if (!isBufferClip(inst)) {
      ensureRisset(ctx, ch);
    } else {
      const buffer = ch.buf.buffer;
      if (!buffer || buffer.duration < 0.02) continue;
      const late = a < begin;
      const s = playSource(ctx, ch, buffer, ch.cycleGate, { at: late ? begin : a, offset: late ? begin - a : 0, end: b, loop: !!inst.loop, fade: late ? 0.01 : 0.003 });
      const rec = { ...s, at: a, end: b, loop: !!inst.loop };
      ch.cycleSrcs.push(rec);
      s.src.onended = () => { ch.cycleSrcs = ch.cycleSrcs.filter((x) => x !== rec); };
    }
    scheduleGate(ch.cycleGate.gain, a, b, inst.fadeIn || 0, inst.fadeOut || 0, begin);
    scheduleRegionMask(ch.regionGate.gain, at, silencedSpans(inst.id, listRegions(), len), begin);
  }
  cycle.occ.push({ at, len, index });
  if (cycle.occ.length > 4) cycle.occ.shift();
  cycle.nextAt = at + len;
}

function lookahead() {
  const ctx = getAudioCtx();
  if (!cycle || !ctx) return;
  const now = ctx.currentTime;
  if (appState.manager?.cycleLoop) {
    if (cycle.nextAt - now < LOOKAHEAD_SEC) scheduleOccurrence(ctx, cycle.nextAt);
  } else if (now > cycle.nextAt + 0.05) {
    stopCycle();
  }
}

/** Play the cycle from the cue (playhead). Resolves false when no clip is in the cycle. / 큐 위치부터 사이클 재생 */
export async function startCycle() {
  if (cycle) return true;
  if (!listInstances().some((i) => i.inCycle && clipLength(i) >= 0.02)) return false;
  const ctx = await ensureAudioCtx();
  await prepareBuffers(ctx);
  if (cycle) return true;
  const begin = ctx.currentTime + LEAD_SEC;
  const from = getCycleCue();
  cycle = { t0: begin - from, nextAt: 0, occ: [], timer: null };
  scheduleOccurrence(ctx, cycle.t0, begin);
  cycle.timer = setInterval(lookahead, 50);
  notify();
  return true;
}

export function stopCycle() {
  const c = cycle;
  if (!c) return;
  cycle = null;
  clearInterval(c.timer);
  const ctx = getAudioCtx();
  for (const ch of channels.values()) {
    if (ctx) {
      rampGate(ch.cycleGate.gain, 0, 0.04);
      ch.regionGate.gain.cancelScheduledValues(ctx.currentTime);
      ch.regionGate.gain.setValueAtTime(1, ctx.currentTime + 0.05);
    }
    ch.cycleSrcs.forEach((s) => stopSource(s, 0.04));
    ch.cycleSrcs = [];
    if (!rissetNeeded(ch)) setTimeout(() => { if (!rissetNeeded(ch)) stopRisset(ch); }, 80);
  }
  notify();
}

export async function toggleCycle() {
  if (cycle) { stopCycle(); return false; }
  return startCycle();
}

/** Stop everything the Manager plays (Esc, project load). / 매니저 전체 정지 */
export function stopAllManager() {
  stopCycle();
  for (const ch of channels.values()) stopFree(ch, true);
  notify();
}

/** Number of channels currently sounding (launched or in a playing cycle). */
export function activeChannelCount() {
  let n = 0;
  for (const inst of listInstances()) {
    const ch = channels.get(inst.id);
    if (inst.warp?.on) continue;
    if (ch?.free || (cycle && inst.inCycle)) n++;
  }
  return n;
}

// --------------------------------------------------------------------------
// State sync / 상태 동기화
// --------------------------------------------------------------------------

/**
 * Apply state to the audio graph: remove deleted channels, update faders, and (debounced)
 * re-render + hot-swap edited Glissando / Field documents. Call after every state change.
 * 상태 → 오디오 그래프 반영 (삭제·페이더, 편집된 문서는 지연 재렌더링 후 핫스왑).
 */
export function syncMixer() {
  viewWarp = undefined;
  viewTime = undefined;
  for (const ch of channels.values()) { ch.warpFn = undefined; ch.gainAt = undefined; ch.timeFn = undefined; }
  const ctx = getAudioCtx();
  if (!ctx) return;
  const ids = new Set(listInstances().map((i) => i.id));
  for (const ch of [...channels.values()]) if (!ids.has(ch.id)) disposeChannel(ch);
  for (const inst of listInstances()) {
    const ch = channels.get(inst.id);
    if (ch) {
      ch.chGain.gain.setTargetAtTime(channelTarget(inst), ctx.currentTime, 0.01);
      // Tape: glide the sources' playbackRate, no re-render / 테이프: 재생 속도만 미끄러뜨림
      const tg = channelRates(inst);
      const tau = Math.max(0.005, tg.glide / 3);
      const vs = varispeed(inst);
      for (const src of [ch.free?.src, ...ch.cycleSrcs.map((x) => x.src)]) if (src) src.playbackRate.setTargetAtTime(vs, ctx.currentTime, tau);
    }
  }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(refreshBuffers, 250);
}

async function refreshBuffers() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  for (const inst of listInstances()) {
    if (!isBufferClip(inst) || inst.warp?.on) continue;
    const ch = channels.get(inst.id);
    if (!ch) continue;
    const playing = ch.free || ch.cycleSrcs.length || (cycle && inst.inCycle);
    if (!playing || ch.buf.key === docKey(inst)) continue;
    const buffer = await getBuffer(ctx, inst);
    if (!buffer) continue;
    hotSwap(ctx, ch, buffer);
  }
}

/** Replace the buffer under playing sources at the same position. / 같은 위치에서 버퍼 교체 */
function hotSwap(ctx, ch, buffer) {
  const now = ctx.currentTime + 0.01;
  if (ch.free?.src) {
    const old = ch.free;
    const pos = now - old.t0;
    const tape = varispeed(getInstance(ch.id));
    ch.free = { ...playSource(ctx, ch, buffer, ch.freeGate, { at: now, offset: pos, loop: true }), t0: now - (pos % (buffer.duration / tape)) };
    stopSource(old);
  }
  const next = [];
  for (const rec of ch.cycleSrcs) {
    if (rec.end <= now) continue;
    if (rec.at > now) {
      // not started yet: restart at the same time with the new buffer / 아직 시작 전: 새 버퍼로 교체
      stopSource(rec, 0.002);
      const s = playSource(ctx, ch, buffer, ch.cycleGate, { at: rec.at, end: rec.end, loop: rec.loop, fade: 0.003 });
      next.push({ ...s, at: rec.at, end: rec.end, loop: rec.loop });
      continue;
    }
    const pos = now - rec.at;
    if (!rec.loop && pos >= buffer.duration) { next.push(rec); continue; }
    const s = playSource(ctx, ch, buffer, ch.cycleGate, { at: now, offset: pos, end: rec.end, loop: rec.loop });
    stopSource(rec);
    next.push({ ...s, at: rec.at, end: rec.end, loop: rec.loop });
  }
  ch.cycleSrcs = next;
}

// --------------------------------------------------------------------------
// Meters / 미터
// --------------------------------------------------------------------------

/** Peak level of a channel in dBFS (−Infinity when silent or not created). / 채널 피크 */
export function channelPeakDb(id) {
  const ch = channels.get(id);
  if (!ch) return -Infinity;
  ch.analyser.getFloatTimeDomainData(ch.scope);
  let peak = 0;
  for (let i = 0; i < ch.scope.length; i++) { const a = Math.abs(ch.scope[i]); if (a > peak) peak = a; }
  return peak > 1e-6 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Live Risset state of a channel for the Master View: { params, runtime } while its engine runs,
 * else null. / 실행 중인 리세 엔진의 파라미터·런타임 (마스터 뷰용)
 */
export function getRissetLive(id) {
  const ch = channels.get(id);
  if (!ch?.risset) return null;
  const inst = getInstance(id);
  return { params: resolveParams(inst), runtime: ch.risset.engine.runtime };
}

/** Is a channel sounding right now (launched, or its clip is under the cycle playhead)? */
export function isChannelActive(id) {
  const ch = channels.get(id);
  if (!ch) return false;
  if (ch.free) return true;
  const inst = getInstance(id);
  const pos = getCyclePosition();
  if (!pos || !inst?.inCycle) return false;
  const a = Number(inst.start) || 0;
  return pos.pos >= a && pos.pos < a + clipLength(inst);
}

// --------------------------------------------------------------------------
// Offline cycle export / 사이클 오프라인 내보내기
// --------------------------------------------------------------------------

/**
 * Render one cycle (every audible instance in the cycle, with faders and fades) through the
 * output stage at 48 kHz and download it. / 사이클 1회를 48 kHz로 렌더링해 다운로드
 */
export async function exportCycleWav({ download = true } = {}) {
  const instances = listInstances().filter((i) => i.inCycle && isInstanceAudible(i) && clipLength(i) >= 0.02);
  if (!instances.length) return { ok: false, message: t('toast.noAudio') };
  const sr = EXPORT_SAMPLE_RATE;
  const C = cycleLength(listInstances());
  const parts = [];
  for (const inst of instances) {
    const L = clipLength(inst);
    const doc = getInstanceDoc(inst);
    let buffer = null;
    const ampMask = renderGain(inst);
    const pitchWarp = renderWarp(inst);
    const { rate, tape } = channelRates(inst);
    if (isBufferClip(inst)) buffer = await renderTrackBuffer(inst, sr);
    else {
      const tw = timeOf(inst);
      if (!tw) buffer = await renderRissetBuffer({ seconds: Math.min(180, Math.max(1, Math.ceil(L))), params: shiftRissetPitch(resolveParams(inst, doc), tape), sampleRate: sr, outputStage: false, ampMask, pitchWarp, timeScale: rate, extraTremolo: inst.tremolo?.on ? inst.tremolo : null });
      else {
        // Warp time density: render the content the clip reaches, then re-time it / 곡률 시간 밀도: 닿는 내용만큼 렌더 후 재시간
        const map = trackMap(inst, tw, doc);
        const start = Number(inst.start) || 0;
        const content = await renderRissetBuffer({ seconds: Math.min(180, Math.max(1, Math.ceil(map.toContent(L) + 0.1))), params: shiftRissetPitch(resolveParams(inst, doc), tape), sampleRate: sr, outputStage: false, ampMask: renderGain(inst, start, map.toReal), pitchWarp: renderWarp(inst, start, map.toReal), timeScale: rate, extraTremolo: inst.tremolo?.on ? inst.tremolo : null });
        const outLen = Math.ceil(L * sr);
        const arr = retimeArrays(Array.from({ length: content.numberOfChannels }, (_, c) => content.getChannelData(c)), map, 1, outLen, sr, tw.mode);
        buffer = new AudioBuffer({ length: outLen, numberOfChannels: arr.length, sampleRate: sr });
        arr.forEach((x, c) => buffer.getChannelData(c).set(x));
      }
    }
    if (buffer) parts.push({ inst, buffer, L, tape: isBufferClip(inst) ? varispeed(inst) : 1 });
  }
  if (!parts.length) return { ok: false, message: t('toast.noAudio') };
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(2, Math.ceil(C * sr), sr);
  const out = createOfflineOutput(ctx);
  for (const { inst, buffer, L, tape } of parts) {
    const a = Number(inst.start) || 0;
    const b = a + L;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = tape; // tape mode / varispeed / 테이프 모드
    src.loop = isBufferClip(inst) && !!inst.loop;
    const g = ctx.createGain();
    g.gain.value = 0;
    scheduleGate(g.gain, a, b, inst.fadeIn || 0, inst.fadeOut || 0);
    const fader = ctx.createGain();
    fader.gain.value = dbToAmp(inst.gainDb || 0);
    const mask = ctx.createGain();
    mask.gain.value = 1;
    scheduleRegionMask(mask.gain, 0, silencedSpans(inst.id, listRegions(), C));
    src.connect(g).connect(mask).connect(fader).connect(out);
    src.start(a);
    src.stop(b);
  }
  const rendered = await ctx.startRendering();
  const wav = encodeWav(rendered);
  const filename = `Flexatone_Cycle_${parts.length}ch_T${C.toFixed(2)}s.wav`;
  if (download) triggerDownload(new Blob([wav], { type: 'audio/wav' }), filename);
  return { ok: true, filename, bytes: wav.byteLength, buffer: rendered, message: t('toast.wavDone', filename) };
}
