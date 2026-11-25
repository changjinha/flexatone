/**
 * Flexatone — audio/warp-sources.js
 * Layer 3 (audio): what each studio contributes when its Manager track is a Warp source — the
 * studio's own data turned into a displacement table (modules/pitch-warp.js). Read-only: no
 * studio document is changed, no sound is made here.
 * 계층 3 (audio): 매니저 트랙이 곡률 출처일 때 스튜디오마다 무엇을 쓰는지 — 스튜디오 데이터를 변위 표로 변환.
 * 읽기 전용 (문서를 바꾸지 않고 소리도 내지 않음).
 *
 *   Glissando  voices (audible)                                     → lines
 *   Risset     voice positions on S¹, simulated offline (dynamics, grid, automation)
 *              mode 'frame'  : rotating frame (the endless glide removed — only relative motion)
 *              mode 'rotate' : with the rotation, wrapped inside [base, base + span)
 *   Field      mode 'lines'  : particle trajectories (as heard)
 *              mode 'field'  : the vector field itself carries every pitch (reference = active particle)
 *   Draw       strokes; mode 'brush' bends only around each stroke (radius)
 *   Chaos · Tempo · Fractal  the baked pitch lines (same as the Master View)
 *   Space      mode 'obs' : observed pitch (with Doppler) · mode 'src' : source pitch f_s
 *   Cloud      the rules, not the grains: centre c(t) = transposition, width·(1 − collapse) = scale
 *              around the centre, optional pull toward the sieve pitches
 *   Wave       the precomputed field, not the ridges: 'disp' (u as displacement) or 'energy'
 *              (energy density → cumulative map); 'auto' = energy for Gray–Scott, else disp;
 *              both smoothed in time (warp.smooth)
 * Tables are cached by (source key, warp settings, duration). / 표는 (출처 키, 설정, 길이)로 캐시.
 */

import { clamp } from '../core/math-utils.js';
import { freqToMidi } from '../core/units.js';
import { registerSelfCheck, createDefaultVoice } from '../core/state.js';
import { midiToFreq } from '../core/units.js';
import { getVoiceMidiAtNormT } from '../modules/curve-engine.js';
import {
  buildLineWarpTable, buildRuleWarpTable, buildGridWarpTable, buildAdvectionWarpTable, smoothWarpTable, createWarpTable, warpMidi,
} from '../modules/pitch-warp.js';
import { getPlayableTimeline } from './audio-engine.js';
import { clipStudioLines } from './studio-clips.js';
import { lookupBakedSample } from '../studios/field/field-audio.js';
import { getBakedMap, isParticleAudible } from '../studios/field-studio.js';
import { VectorFieldPluginEngine, migrateFieldDoc } from '../studios/field/vector-field-engine.js';
import { createBakedRuntime, createRissetRuntime, stepRuntime, phaseToMidi } from '../studios/risset/risset-core.js';
import { resolveRissetDoc } from '../studios/risset/risset-audio.js';
import { getSpaceTimeline } from '../studios/space/space-audio.js';
import { normalizeCloudParams, evalCloudCurve, getCurve, buildSieveSet, snapToSet } from '../studios/cloud/cloud-engine.js';
import { getWaveBake } from '../studios/wave-studio.js';

const hzToMidi = (hz) => (hz > 0 ? freqToMidi(hz) : NaN);
const wrapSigned = (x) => x - Math.round(x);
const MAX_SOURCE_SEC = 600;
const RISSET_SIM_RATE = 20;

// --------------------------------------------------------------------------
// Lines per studio / 스튜디오별 선
// --------------------------------------------------------------------------

function glissandoLines(doc) {
  const voices = Array.isArray(doc?.voices) ? doc.voices : [];
  return getPlayableTimeline(voices).audible.map((v) => {
    const n = clamp(Math.ceil(v.duration * 20) + 1, 8, 240);
    const pts = [];
    for (let i = 0; i < n; i++) { const u = i / (n - 1); pts.push({ t: v.startTime + u * v.duration, m: getVoiceMidiAtNormT(v, u) }); }
    return { pts };
  });
}

function fieldLines(params) {
  const baked = getBakedMap(params);
  return (params.voices || []).filter((v) => isParticleAudible(v, params) && v.duration > 0.02).map((v) => {
    const pts = [];
    const bp = baked.get(v.id);
    if (!bp) return { pts };
    const n = 120;
    for (let i = 0; i < n; i++) {
      const frac = i / (n - 1);
      const y = lookupBakedSample(v, bp, frac).y;
      pts.push({ t: v.startTime + frac * v.duration, m: v.f0Midi + y * (v.f1Midi - v.f0Midi) });
    }
    return { pts };
  });
}

function spaceSourceLines(params) {
  const { bake, audible } = getSpaceTimeline(params);
  const out = [];
  for (const src of audible) {
    const b = bake.sources.get(src.id);
    if (!b || !b.fs) continue;
    const step = Math.max(1, Math.floor(b.n / 240));
    const pts = [];
    for (let i = 0; i < b.n; i += step) pts.push({ t: b.t0 + i * b.dt, m: hzToMidi(b.fs[i]) });
    out.push({ pts });
  }
  return out;
}

/**
 * Risset voices on S¹ over `seconds` of runtime time (deterministic: baked dynamics, fixed rng).
 * Each sounding slot is a line; its rest pitch is where it starts. In 'frame' mode the master
 * rotation φ is removed. / 리세 보이스 위치를 오프라인으로 시뮬레이션 (frame 모드는 회전 제거).
 */
export function rissetLines(params, seconds, mode = 'frame') {
  const sec = clamp(Number(seconds) || 0, 0.1, MAX_SOURCE_SEC);
  const rng = () => 0.5;
  const rt = createBakedRuntime(params, sec + 0.1) || createRissetRuntime(params, rng);
  const n = Math.max(2, Math.ceil(sec * RISSET_SIM_RATE));
  const dt = sec / n;
  const span = params.spanSemitones;
  const tracks = [];
  let phiU = 0;
  let lastPhi = null;
  for (let k = 0; k <= n; k++) {
    stepRuntime(params, rt, k > 0 ? dt : 0, { running: true, rng });
    const phi = Number(rt.masterPhase) || 0;
    if (lastPhi !== null) phiU += wrapSigned(phi - lastPhi);
    lastPhi = phi;
    rt.slots.forEach((sl, j) => {
      let tr = tracks[j];
      if (!tr) { tr = { s0: sl.s, u: 0, last: sl.s, phi0: phiU, rest: phaseToMidi(params, sl.s), pts: [] }; tracks[j] = tr; } else { tr.u += wrapSigned(sl.s - tr.last); tr.last = sl.s; }
      const rel = tr.u - (mode === 'frame' ? phiU - tr.phi0 : 0);
      tr.pts.push({ t: k * dt, m: tr.rest + rel * span });
    });
  }
  return tracks.filter(Boolean).map((tr) => ({ pts: tr.pts, rest: tr.rest }));
}

// --------------------------------------------------------------------------
// Table builders / 표 생성
// --------------------------------------------------------------------------

function lineTable(lines, warp, duration, extra = {}) {
  return buildLineWarpTable(lines, { duration, rest: warp.rest, after: warp.after, returnSec: warp.returnSec, ...extra });
}

function cloudTable(params, warp, duration) {
  const p = normalizeCloudParams(params);
  const len = Math.max(0.1, p.length);
  const centre = getCurve(p, 'center');
  const width = getCurve(p, 'width');
  const collapse = getCurve(p, 'collapse');
  const w = (t) => evalCloudCurve(width, clamp(t / len, 0, 1), 'width') * (1 - clamp(evalCloudCurve(collapse, clamp(t / len, 0, 1), 'collapse'), 0, 1));
  let w0 = w(0);
  if (!(w0 > 0.05)) { w0 = 0; for (let i = 0; i <= 64; i++) w0 = Math.max(w0, w((i / 64) * len)); w0 = w0 > 0.05 ? w0 : 1; }
  const set = warp.sieve > 0 && p.pitch?.sieve?.enabled ? buildSieveSet(p.pitch.sieve, p.pitch.min, p.pitch.max) : null;
  return buildRuleWarpTable({
    duration,
    centerAt: (t) => evalCloudCurve(centre, clamp(t / len, 0, 1), 'center'),
    scaleAt: (t) => w(t) / w0,
    snap: set && set.length ? (m) => snapToSet(set, m) : null,
    snapStrength: warp.sieve,
  });
}

function waveTable(params, warp, duration) {
  const bake = getWaveBake(params);
  const mode = warp.mode === 'auto' || !warp.mode ? (bake.eq === 'gs' || bake.eq === 'schrod' || bake.eq === 'diffusion' ? 'energy' : 'disp') : warp.mode;
  const arr = mode === 'energy' ? bake.W : bake.U;
  const table = buildGridWarpTable({
    duration, frames: bake.frames, frameRate: bake.rate, N: bake.N, pLo: bake.pLo, dp: bake.dp,
    value: (f, i) => arr[f * bake.N + i], mode, amount: warp.amount,
  });
  return smoothWarpTable(table, warp.smooth);
}

function fieldFlowTable(params, duration) {
  params = migrateFieldDoc(params); // pre-layer documents → absolute layers / 레이어 이전 문서 변환
  const audible = (params.voices || []).filter((v) => isParticleAudible(v, params) && v.duration > 0.02);
  const ref = audible.find((v) => v.id === params.activeVoiceId) || audible[0];
  if (!ref) return createWarpTable(duration);
  return buildAdvectionWarpTable({
    duration, t0: ref.startTime, t1: ref.startTime + ref.duration, m0: ref.f0Midi, m1: ref.f1Midi,
    velocity: (tn, y) => VectorFieldPluginEngine.evaluateFieldAt(tn, y, ref, params, params.guiding, []).vy,
  });
}

/**
 * Displacement table of one source track over `duration` seconds of its own (document) time.
 * `params` = the studio's resolved document (Glissando: { voices }).
 * 출처 트랙 하나의 변위 표 (자체 문서 시간 기준).
 */
export function buildWarpSourceTable(studio, params, warp, duration) {
  const dur = clamp(Number(duration) || 0, 0, MAX_SOURCE_SEC);
  switch (studio) {
    case 'glissando': return lineTable(glissandoLines(params), warp, dur);
    case 'risset': {
      const rotate = warp.mode === 'rotate';
      return lineTable(rissetLines(params, dur, rotate ? 'rotate' : 'frame'), warp, dur, rotate ? { wrap: { lo: params.baseMidi, span: params.spanSemitones } } : {});
    }
    case 'field': return warp.mode === 'field' ? fieldFlowTable(params, dur) : lineTable(fieldLines(params), warp, dur);
    case 'draw': return lineTable(clipStudioLines('draw', params) || [], warp, dur, warp.mode === 'brush' ? { brush: true, radius: warp.radius } : {});
    case 'space': return lineTable(warp.mode === 'src' ? spaceSourceLines(params) : clipStudioLines('space', params) || [], warp, dur);
    case 'cloud': return cloudTable(params, warp, dur);
    case 'wave': return waveTable(params, warp, dur);
    default: return lineTable(clipStudioLines(studio, params) || [], warp, dur); // chaos, tempo, fractal
  }
}

// --------------------------------------------------------------------------
// Time axis: reference pitches and per-voice documents / 시간축: 기준 음고와 보이스별 문서
// --------------------------------------------------------------------------

/** Lines a target studio plays (for reference pitches), or []. / 대상 스튜디오의 선 */
function targetLines(studio, params) {
  if (studio === 'glissando') return glissandoLines(params);
  if (studio === 'field') return fieldLines(params);
  return clipStudioLines(studio, params) || [];
}

/** First pitch of the earliest line. / 가장 먼저 시작하는 선의 첫 음고 */
function firstPitch(lines) {
  let best = null;
  for (const l of lines) {
    const p = (l.pts || []).find((q) => Number.isFinite(q.m) && Number.isFinite(q.t));
    if (p && (!best || p.t < best.t)) best = p;
  }
  return best ? best.m : null;
}

/**
 * The pitch a track clock reads the warp at: the track's first pitch (Cloud: its centre at the
 * start, Risset: the bell centre, nothing found: 60). / 트랙 시계가 곡률을 읽는 음고
 */
export function trackRefPitch(studio, params) {
  try {
    if (studio === 'risset') return params.baseMidi + params.spanSemitones * (Number(params.envCenter) || 0.5);
    if (studio === 'cloud') { const p = normalizeCloudParams(params); return evalCloudCurve(getCurve(p, 'center'), 0, 'center'); }
    return firstPitch(targetLines(studio, params)) ?? 60;
  } catch (err) {
    console.error('[Flexatone] warp reference pitch failed:', err);
    return 60;
  }
}

/** Studios whose voices can each get their own clock (rendered solo, one by one). / 보이스별 시계 지원 */
export const VOICE_CLOCK_STUDIOS = Object.freeze(['glissando', 'field', 'draw', 'tempo', 'space']);
export const MAX_VOICE_CLOCKS = 24;

function soloList(list, id, idOf = (x) => x.id) {
  return list.map((x) => ({ ...x, solo: idOf(x) === id, muted: idOf(x) === id ? false : x.muted }));
}

/**
 * Per-voice documents for the voice clock: [{ params, ref }] (each = the document with only that
 * voice audible, ref = its first pitch), or null when the studio has no separable voices or more
 * than MAX_VOICE_CLOCKS of them (→ track clock). / 보이스별 시계용 문서 (보이스 하나만 들리는 문서와 첫 음고)
 */
export function voiceSolos(studio, params) {
  if (!VOICE_CLOCK_STUDIOS.includes(studio)) return null;
  let ids = [];
  let make;
  if (studio === 'glissando') {
    const voices = getPlayableTimeline(params.voices || []).audible;
    ids = voices.map((v) => v.id);
    make = (id) => ({ ...params, voices: soloList(params.voices, id) });
  } else if (studio === 'field') {
    ids = (params.voices || []).filter((v) => isParticleAudible(v, params) && v.duration > 0.02).map((v) => v.id);
    make = (id) => ({ ...params, voices: soloList(params.voices, id) });
  } else if (studio === 'draw') {
    const anySolo = (params.strokes || []).some((x) => x.solo);
    ids = (params.strokes || []).filter((x) => (anySolo ? x.solo : !x.muted)).map((x) => x.id);
    make = (id) => ({ ...params, strokes: soloList(params.strokes, id) });
  } else if (studio === 'tempo') {
    const anySolo = (params.voices || []).some((x) => x.solo);
    ids = (params.voices || []).map((x, i) => (anySolo ? x.solo : !x.muted) ? i : -1).filter((i) => i >= 0);
    // the pulse track stays with the first voice only / 펄스는 첫 보이스에만
    make = (id, k) => ({ ...params, voices: params.voices.map((x, i) => ({ ...x, solo: i === id, muted: i === id ? false : x.muted })), pulse: k === 0 ? params.pulse : { ...params.pulse, audible: false } });
  } else if (studio === 'space') {
    const anySolo = (params.sources || []).some((x) => x.solo);
    ids = (params.sources || []).filter((x) => (anySolo ? x.solo : !x.muted)).map((x) => x.id);
    make = (id) => ({ ...params, sources: soloList(params.sources, id) });
  }
  if (!ids.length || ids.length > MAX_VOICE_CLOCKS) return null;
  return ids.map((id, k) => {
    const doc = make(id, k);
    return { params: doc, ref: firstPitch(targetLines(studio, doc)) ?? 60 };
  });
}

const cache = new Map();
const CACHE_MAX = 12;

/** Cached buildWarpSourceTable; `key` must name everything the table depends on. / 캐시된 표 */
export function getWarpSourceTable(key, studio, params, warp, duration) {
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  let table;
  try {
    table = buildWarpSourceTable(studio, params, warp, duration);
  } catch (err) {
    console.error(`[Flexatone] warp source (${studio}) failed:`, err);
    table = null;
  }
  cache.set(key, table);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return table;
}

registerSelfCheck('Warp sources: a Glissando voice bends a drone, Risset frame mode removes the rotation', (a) => {
  const voice = createDefaultVoice(0, { f0Midi: 48, f0Hz: midiToFreq(48), f1Midi: 72, f1Hz: midiToFreq(72), startTime: 0, duration: 4 });
  // linear-ish check only at the ends (the curve shape is the voice's own) / 끝점만 확인
  const tab = buildWarpSourceTable('glissando', { voices: [voice] }, { rest: 'start', after: 'hold', returnSec: 1 }, 4);
  a.near(warpMidi(tab, 0, 60), 60, 0.05, 'drone unchanged at the start');
  a.near(warpMidi(tab, 4, 60), 84, 0.05, 'drone follows the voice to +24');
  const rp = resolveRissetDoc({ rateHz: 0.05 });
  const w = { rest: 'start', after: 'hold', returnSec: 1, mode: 'frame' };
  a.near(warpMidi(buildWarpSourceTable('risset', rp, w, 8), 8, 60), 60, 0.01, 'frame: the endless glide alone does not bend');
  a.near(warpMidi(buildWarpSourceTable('risset', rp, { ...w, mode: 'rotate' }, 8), 8, 60), 60 + 0.05 * 8 * rp.spanSemitones, 0.05, 'rotate: the glide transposes (v·t·span)');
}, { group: 'audio' });
