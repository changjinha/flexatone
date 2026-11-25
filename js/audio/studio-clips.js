/**
 * Flexatone — audio/studio-clips.js
 * Layer 3 (audio): Manager adapters for the studios that are played as rendered clips but have no
 * Manager-specific path of their own (Draw, Chaos, Cloud, Tempo, Space, Fractal, Wave, Grid).
 * Glissando / Field / Risset keep their dedicated paths in manager-mixer.js.
 * 계층 3 (audio): 전용 경로가 없는 스튜디오(드로잉·카오스·클라우드·템포·스페이스·프랙탈·웨이브)를
 * 매니저에서 렌더된 클립으로 재생하기 위한 어댑터.
 *
 * Each adapter: resolve(doc) → full params, length(params) → seconds, render(params, sr) → AudioBuffer.
 * Optional capabilities (a studio opts in; without them the behaviour below applies):
 *   masks: true + render(params, sr, { ampMask }) → Manager shape masks only (tempo stays varispeed;
 *       no studio uses this any more — kept for a future studio that cannot scale its time)
 *   scalesTime: true + render(params, sr, { rate, ampMask }) → pitch-preserving tempo (the doc part of
 *       the channel rate is rendered, only the tape part is varispeed) and Manager shape masks
 *   key(params) → string the rendered sound depends on (view-only edits do not re-render)
 *   lines(params) → [{ key, name, pts: [{ t, m }] }] pitch lines for the Master View (document time)
 * 선택 기능: scalesTime(음고 유지 템포 + 도형 마스크), key(재렌더 키), lines(마스터 뷰 음고 선).
 * Studio getters read appState.studioParams[studio]; an instance's stored doc is resolved by
 * swapping it in for the duration of the (synchronous) getter call.
 * 스튜디오 getter는 appState.studioParams를 읽으므로, 인스턴스 문서는 동기 호출 동안만 잠시 교체해 해석.
 *
 * Tempo Manager: every studio renders the document part of the channel rate itself (pitch kept);
 * only the Tape part is varispeed (AudioBufferSourceNode.playbackRate). A studio without
 * scalesTime would fall back to whole-rate varispeed.
 * 템포 매니저: 모든 스튜디오가 문서 배속을 직접 렌더 (음고 유지), 테이프 부분만 varispeed.
 */

import { appState, registerSelfCheck } from '../core/state.js';
import { freqToMidi } from '../core/units.js';
import { getDrawParams } from '../studios/draw-studio.js';
import { piecePitchAt } from '../studios/draw/draw-engine.js';
import { BAKE_RATE as CHAOS_RATE } from '../studios/chaos/chaos-engine.js';
import { getCloudEvents } from '../studios/cloud-studio.js';
import { voicePitchOffset } from '../studios/tempo-studio.js';
import { BAKE_RATE as TEMPO_RATE } from '../studios/tempo/tempo-engine.js';
import { getDrawTimeline, renderDrawBuffer } from '../studios/draw/draw-audio.js';
import { getChaosParams, getChaosBake } from '../studios/chaos-studio.js';
import { renderChaosBuffer } from '../studios/chaos/chaos-audio.js';
import { getCloudParams } from '../studios/cloud-studio.js';
import { renderCloudBuffer } from '../studios/cloud/cloud-audio.js';
import { getTempoParams } from '../studios/tempo-studio.js';
import { getTempoTimeline, renderTempoBuffer } from '../studios/tempo/tempo-audio.js';
import { getSpaceParams } from '../studios/space-studio.js';
import { getSpaceTimeline, renderSpaceBuffer, spaceRenderKey } from '../studios/space/space-audio.js';
import { getFractalParams, getFractalBake } from '../studios/fractal-studio.js';
import { renderFractalBuffer } from '../studios/fractal/fractal-audio.js';
import { getWaveParams, waveMasterLines } from '../studios/wave-studio.js';
import { waveTimelineEnd } from '../studios/wave/wave-engine.js';
import { renderWaveBuffer, waveRenderKey } from '../studios/wave/wave-audio.js';
import { getGridParams, gridMasterLines, gridTimelineEnd } from '../studios/grid-studio.js';
import { renderGridBuffer, gridRenderKey } from '../studios/grid/grid-audio.js';

const num = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0);

// --------------------------------------------------------------------------
// Master View pitch lines / 마스터 뷰 음고 선
// Each studio's baked pitch is sampled into ≤ MAX_PTS points per line, in document seconds.
// 각 스튜디오의 베이킹된 음고를 선마다 최대 MAX_PTS 점으로 표본화 (문서 시간 기준).
// --------------------------------------------------------------------------

const MAX_PTS = 240;
const MAX_LINES = 600;
const hzToMidi = (hz) => (hz > 0 ? freqToMidi(hz) : NaN);

/** Sample `n` indices of a baked array: at(i) → { t, m }. Always keeps the last sample. / 배열 표본화 */
function sampleLine(n, at) {
  const pts = [];
  if (!(n >= 2)) return pts;
  const step = Math.max(1, Math.floor(n / MAX_PTS));
  for (let i = 0; i < n; i += step) pts.push(at(i));
  if ((n - 1) % step) pts.push(at(n - 1));
  return pts.filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m));
}

function drawLines(p) {
  const out = [];
  getDrawTimeline(p).items.forEach(({ stroke, piece }, k) => {
    const n = Math.max(2, Math.min(MAX_PTS, Math.ceil(piece.dur * 60)));
    const pts = sampleLine(n, (i) => { const t = piece.t0 + (piece.dur * i) / (n - 1); return { t, m: piecePitchAt(piece, t) }; });
    out.push({ key: `${stroke.id}_${k}`, name: stroke.name, pts });
  });
  return out;
}

function chaosLines(p) {
  const B = getChaosBake(p);
  return B.voices.map((v, i) => ({ key: `c${i}`, name: `Chaos ${i + 1}`, pts: sampleLine(Math.min(B.M, v.pitch.length), (j) => ({ t: j / CHAOS_RATE, m: v.pitch[j] })) }));
}

function cloudLines(p) {
  const ev = getCloudEvents(p);
  const out = [];
  const step = Math.max(1, Math.ceil(ev.n / MAX_LINES)); // thin very dense clouds / 너무 촘촘하면 솎아냄
  for (let i = 0; i < ev.n; i += step) {
    const t0 = ev.t0[i];
    const t1 = t0 + ev.dur[i];
    out.push({ key: `g${i}`, name: `Grain ${i + 1}`, pts: [{ t: t0, m: ev.p0[i] }, { t: t1, m: ev.p1[i] }] });
  }
  return out;
}

function tempoLines(p) {
  const { audible } = getTempoTimeline(p);
  return audible.map((bv) => {
    const v = p.voices[bv.index];
    const off = voicePitchOffset(v);
    const j0 = Math.max(0, Math.ceil(bv.uOn * TEMPO_RATE - 1e-9));
    const j1 = Math.min(bv.midi.length - 1, Math.floor(bv.uOff * TEMPO_RATE + 1e-9));
    return { key: `t${bv.index}`, name: v?.name || `Voice ${bv.index + 1}`, pts: sampleLine(j1 - j0 + 1, (i) => ({ t: (j0 + i) / TEMPO_RATE, m: bv.midi[j0 + i] + off })) };
  });
}

function spaceLines(p) {
  const { bake, audible } = getSpaceTimeline(p);
  const out = [];
  for (const src of audible) {
    const b = bake.sources.get(src.id);
    if (!b || !b.fObs) continue;
    out.push({ key: src.id, name: src.name, pts: sampleLine(b.n, (i) => ({ t: b.t0 + i * b.dt, m: hzToMidi(b.fObs[i]) })) });
  }
  return out;
}

function fractalLines(p) {
  return getFractalBake(p).voices.map((v, k) => ({
    key: v.id ?? `f${k}`,
    name: v.name || `Fractal ${k + 1}`,
    pts: sampleLine(v.hz.length, (i) => ({ t: v.startSec + i / v.rate, m: hzToMidi(v.hz[i]) })),
  }));
}

const ADAPTERS = {
  draw: {
    get: getDrawParams,
    length: (p) => getDrawTimeline(p).endSec,
    scalesTime: true, // pitch-preserving tempo / 음고 유지 템포
    render: (p, sampleRate, o = {}) => renderDrawBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    lines: drawLines,
  },
  chaos: {
    get: getChaosParams,
    length: (p) => getChaosBake(p).A.duration,
    scalesTime: true, // pitch-preserving tempo / 음고 유지 템포
    render: (p, sampleRate, o = {}) => renderChaosBuffer({ doc: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    lines: chaosLines,
  },
  cloud: {
    get: getCloudParams,
    length: (p) => p.length,
    scalesTime: true, // pitch-preserving tempo / 음고 유지 템포
    render: (p, sampleRate, o = {}) => renderCloudBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    lines: cloudLines,
  },
  tempo: {
    get: getTempoParams,
    length: (p) => getTempoTimeline(p).endSec,
    scalesTime: true, // pitch-preserving tempo / 음고 유지 템포
    render: (p, sampleRate, o = {}) => renderTempoBuffer({ doc: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    lines: tempoLines,
  },
  space: {
    get: getSpaceParams,
    length: (p) => getSpaceTimeline(p).endSec,
    scalesTime: true, // pitch-preserving tempo (an imported sound keeps its own speed) / 음고 유지 템포 (가져온 소리는 자기 속도)
    render: (p, sampleRate, o = {}) => renderSpaceBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null, importChain: o.importChain || [] }),
    key: (p) => spaceRenderKey(p), // physics + sound + the sounds it imports (view edits do not re-render) / 뷰 편집은 재렌더하지 않음
    lines: spaceLines,
  },
  fractal: {
    get: getFractalParams,
    length: (p) => getFractalBake(p).endSec,
    // Pitch-preserving tempo: the bake is read faster / slower (fractal-engine retimeFractalBake).
    // 음고 유지 템포: 베이크를 빠르게/느리게 읽음
    scalesTime: true,
    render: (p, sampleRate, o = {}) => renderFractalBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    lines: fractalLines,
  },
  // Wave opts into the optional capabilities below: its baked field can be read at any speed
  // without changing pitch, masked by pitch × time, and drawn as ridge lines.
  // 웨이브는 아래 선택 기능을 사용: 음고 유지 템포, 음고×시간 마스크, 리지 선 표시.
  wave: {
    get: getWaveParams,
    length: (p) => waveTimelineEnd(p), // no simulation needed / 시뮬레이션 불필요
    scalesTime: true,
    render: (p, sampleRate, o = {}) => renderWaveBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    key: (p) => waveRenderKey(p),
    lines: (p) => waveMasterLines(p),
  },
  // Grid: the baked matrices are read at any speed without changing pitch (the bins keep their
  // frequencies), masked and warped per frame × bin, and drawn as the ridge lines of the Result.
  // 그리드: 베이킹된 행렬을 음고 변화 없이 임의 속도로 읽고, 프레임 × 빈 단위로 마스크·곡률을 적용, Result의 리지 선으로 표시.
  grid: {
    get: getGridParams,
    length: (p) => gridTimelineEnd(p), // no bake needed / 베이킹 불필요
    scalesTime: true,
    render: (p, sampleRate, o = {}) => renderGridBuffer({ params: p, sampleRate, outputStage: false, timeScale: o.rate || 1, ampMask: o.ampMask || null, pitchWarp: o.pitchWarp || null, brightWarp: o.brightWarp || null }),
    key: (p) => gridRenderKey(p),
    lines: (p) => gridMasterLines(p),
  },
};

export function isClipStudio(studio) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, studio);
}

/**
 * Full params of a stored instance document (null = studio defaults).
 * 인스턴스 문서 → 전체 파라미터 (null = 기본값).
 */
export function resolveClipParams(studio, doc) {
  const a = ADAPTERS[studio];
  if (!a) return null;
  const prev = appState.studioParams;
  const sp = { ...(prev || {}) };
  if (doc && typeof doc === 'object') sp[studio] = doc;
  else delete sp[studio];
  appState.studioParams = sp;
  try {
    return a.get();
  } finally {
    appState.studioParams = prev;
  }
}

/** One-pass length (document seconds) of resolved params. / 1회 재생 길이 */
export function clipStudioLength(studio, params) {
  try {
    return num(ADAPTERS[studio]?.length(params));
  } catch (err) {
    console.error(`[Flexatone] ${studio} length failed:`, err);
    return 0;
  }
}

/**
 * Offline render without the output stage (the Manager adds its own).
 * `opts` = { rate, ampMask, varispeed }:
 *   - scalesTime studios get { rate, ampMask } as is (they render in real time and real pitch);
 *   - masks studios get only the mask, converted to buffer time and buffer pitch: the buffer is
 *     played at `varispeed`, so buffer second s is heard at s / v and buffer Hz f is heard at f · v.
 * 출력단 없이 오프라인 렌더. scalesTime 스튜디오는 opts 그대로, masks 스튜디오는 마스크만
 * 버퍼 시간·음고로 변환해 전달 (버퍼 s초 → 실제 s/v초, f Hz → 실제 f·v Hz).
 */
export async function renderClipStudio(studio, params, sampleRate, opts = {}) {
  const a = ADAPTERS[studio];
  if (!a) return null;
  if (a.scalesTime) return a.render(params, sampleRate, opts);
  if (a.masks && (opts.ampMask || opts.pitchWarp || opts.brightWarp)) {
    const v = Number(opts.varispeed) > 0 ? Number(opts.varispeed) : 1;
    const mask = opts.ampMask;
    const warp = opts.pitchWarp;
    const bright = opts.brightWarp;
    // buffer (s, f) is heard at (s / v, f · v): warp the heard pitch, render it back at 1 / v
    // 버퍼 (s, f)는 (s/v, f·v)로 들림: 들리는 음고를 휜 뒤 버퍼 음고로 되돌림
    return a.render(params, sampleRate, {
      ampMask: !mask ? null : v === 1 ? mask : (sec, hz) => mask(sec / v, hz * v),
      pitchWarp: !warp ? null : v === 1 ? warp : (sec, hz) => warp(sec / v, hz * v) / v,
      brightWarp: !bright ? null : v === 1 ? bright : (sec, hz) => bright(sec / v, hz * v),
      importChain: opts.importChain,
    });
  }
  return a.render(params, sampleRate, { importChain: opts.importChain });
}

/** True when the studio renders the pitch-preserving part of the tempo itself. / 음고 유지 템포를 직접 렌더하는가 */
export function clipStudioScalesTime(studio) {
  return !!ADAPTERS[studio]?.scalesTime;
}

/** Re-render key of resolved params, or null (= use the whole document). / 재렌더 키 (없으면 null) */
export function clipStudioKey(studio, params) {
  const a = ADAPTERS[studio];
  if (!a || typeof a.key !== 'function') return null;
  try {
    return a.key(params);
  } catch (err) {
    console.error(`[Flexatone] ${studio} key failed:`, err);
    return null;
  }
}

/** Pitch lines of resolved params for the Master View, or null (= draw a block). / 마스터 뷰 음고 선 (없으면 null) */
export function clipStudioLines(studio, params) {
  const a = ADAPTERS[studio];
  if (!a || typeof a.lines !== 'function') return null;
  try {
    return a.lines(params);
  } catch (err) {
    console.error(`[Flexatone] ${studio} lines failed:`, err);
    return null;
  }
}

/** Zero crossings per second over the samples that sound (a pitch proxy). / 발음 구간의 초당 영교차 (음고 지표) */
function crossingRate(buf) {
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const floor = peak * 0.02;
  let zc = 0;
  let live = 0;
  for (let i = 1; i < d.length; i++) {
    if (Math.abs(d[i]) < floor && Math.abs(d[i - 1]) < floor) continue;
    live++;
    if ((d[i - 1] < 0) !== (d[i] < 0)) zc++;
  }
  return live ? (zc * buf.sampleRate) / live : 0;
}

registerSelfCheck('Clip studios: tempo ×2 halves the clip at the same pitch (Draw, Chaos, Cloud, Tempo, Space)', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  const fs = 22050;
  for (const studio of ['draw', 'chaos', 'cloud', 'tempo', 'space']) {
    a.ok(clipStudioScalesTime(studio), `${studio}: renders the tempo itself`);
    const params = resolveClipParams(studio, null);
    const one = await renderClipStudio(studio, params, fs, { rate: 1 });
    if (!one) { a.ok(true, `${studio}: no sound in the current document — skipped`); continue; }
    const two = await renderClipStudio(studio, params, fs, { rate: 2 });
    const len = (b) => b.length / fs;
    a.ok(two && len(two) < 0.6 * len(one) + 0.1, `${studio}: ×2 is about half as long (${len(one).toFixed(2)} → ${len(two).toFixed(2)} s)`);
    const z1 = crossingRate(one);
    const z2 = crossingRate(two);
    a.ok(z1 > 0 && z2 / z1 > 0.75 && z2 / z1 < 1.33, `${studio}: same pitch at ×2 (crossings ${z1.toFixed(0)} → ${z2.toFixed(0)} /s)`);
  }
}, { group: 'audio' });
