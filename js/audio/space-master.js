/**
 * Flexatone — audio/space-master.js
 * Layer 3 (audio): the **Space Master** — the Manager's spatial master track. When it is on, the
 * output of every Manager track (after its fader and meter) is a moving source of the Space Master
 * scene: delay line (Doppler + arrival delay) → low-pass (air) → gain (distance, lanes) →
 * direction stage (stereo pan · HRTF · HOA binaural) → output bus. Off = the mixer graph is untouched.
 * 계층 3 (audio): **스페이스 마스터** — 매니저의 공간 마스터 트랙. 켜면 각 트랙 출력(페이더·미터 뒤)이
 * 마스터 장면의 움직이는 음원이 됨: 지연선(도플러·도착 지연) → 로우패스 → 게인 → 방향 단계 → 출력 버스.
 * 끄면 믹서 그래프는 그대로.
 *
 *   track analyser ─┬─ mono ─ delay ─ low-pass ─ gain ─ direction ─┐
 *                   └─ dry (1 − wet) ──────────────────────────────┴─ output bus
 *
 * Live: the tracks are running signals, so the baked arrays of the master scene are FOLLOWED at
 * control rate (every 50 ms the parameters glide to the values of the master clock a little ahead).
 * Master clock = the cycle position while the cycle plays, else a free clock that wraps at the
 * scene length. Offline (cycle export): the same chain with exact curves over the whole cycle.
 * 라이브: 트랙은 흐르는 신호이므로 마스터 장면의 베이킹 배열을 제어 주기(50 ms)로 따라감. 마스터 시계 = 사이클 위치
 * (사이클이 멈춰 있으면 장면 길이에서 되감기는 자유 시계). 오프라인(사이클 내보내기): 같은 체인을 전체 곡선으로.
 *
 * Arrival-delay compensation (on by default): the smallest delay of the scene is subtracted from
 * every track, so the nearest moment has no latency; a constant offset changes no pitch.
 * 도착 지연 보정(기본 켬): 장면의 최소 지연을 모든 트랙에서 뺌 — 상수이므로 음고는 변하지 않음.
 *
 * Imports: core/*, studios/space/* (pure), audio/manager-mixer.js, audio/output-bus.js, audio/hoa-bus.js.
 */

import { clamp } from '../core/math-utils.js';
import { registerSelfCheck } from '../core/state.js';
import { bakeSpace, sampleBake } from '../studios/space/space-engine.js';
import { getSpaceMaster } from '../studios/space/space-master-doc.js';
import { scheduleSpaceSource, hoaMonitorOptions } from '../studios/space/space-audio.js';
import { isHoaMode } from '../studios/space/space-engine.js';
import { setTrackRouter, rerouteTracks, getCyclePosition, activeChannelCount } from './manager-mixer.js';
import { getOutputBus } from './output-bus.js';
import { createBinauralSpeakers, binauralSupported } from './hoa-bus.js';
import { panGains } from '../modules/ambisonics.js';

const TICK_MS = 50;
const AHEAD = 0.1; // seconds the followers look ahead / 추종 선행 시간
const TAU = 0.035; // glide time constant / 글라이드 시상수
const chains = new Map(); // track id → chain / 트랙 id → 체인
let speakers = null; // shared virtual loudspeakers of the binaural mode { ctx, key, set } / 공유 가상 스피커
let timer = null;
let freeT0 = null;
let graphKey = '';

/** Master source of a Manager track, or null. / 매니저 트랙의 마스터 음원 */
export function masterSourceOf(master, id) {
  return master.doc.sources.find((s) => s.input?.kind === 'track' && s.input.target === id) || null;
}

/** Smallest arrival delay of the scene (seconds); 0 when compensation is off. / 장면의 최소 도착 지연 */
export function masterDelayOffset(master, bake = bakeSpace(master.doc)) {
  if (!master.compensate) return 0;
  let lo = Infinity;
  for (const s of master.doc.sources) {
    if (s.input?.kind !== 'track' || s.input.bypass) continue;
    const b = bake.sources.get(s.id);
    if (!b) continue;
    for (let i = 0; i < b.n; i += 4) lo = Math.min(lo, b.t[i] - b.te[i]);
  }
  return Number.isFinite(lo) ? Math.max(0, lo) : 0;
}

/** What decides the shape of the live graph (not its parameter values). / 라이브 그래프의 모양을 정하는 것 */
function shapeKey(m) {
  return m.on ? `${m.doc.panMode}|${isHoaMode(m.doc.panMode) ? JSON.stringify(m.doc.spatial) : ''}|${m.doc.sources.filter((s) => s.input?.kind === 'track').map((s) => `${s.input.target}:${s.input.bypass ? 0 : 1}`).join(',')}` : 'off';
}

function dispose(id) {
  const c = chains.get(id);
  if (!c) return;
  chains.delete(id);
  setTimeout(() => { for (const n of c.nodes) { try { n.disconnect(); } catch { /* ignore */ } } }, 250);
}

function sharedSpeakers(ctx, m) {
  const key = `${m.doc.panMode}|${JSON.stringify(m.doc.spatial)}`;
  if (speakers && speakers.ctx === ctx && speakers.key === key) return speakers.set;
  if (speakers) for (const n of speakers.set.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
  speakers = { ctx, key, set: createBinauralSpeakers(ctx, getOutputBus(ctx), hoaMonitorOptions(m.doc, ctx.sampleRate)) };
  return speakers.set;
}

/** Router given to the mixer: takes a track when the master is on and has a source for it. */
function route(ctx, id, node) {
  if (!ctx) { dispose(id); return false; }
  dispose(id);
  const m = getSpaceMaster();
  const src = m.on ? masterSourceOf(m, id) : null;
  if (!src || src.input.bypass) return false;
  const bus = getOutputBus(ctx);
  const mono = ctx.createGain();
  mono.channelCount = 1;
  mono.channelCountMode = 'explicit';
  mono.channelInterpretation = 'speakers';
  const delay = ctx.createDelay(20);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 0.707;
  filter.frequency.value = 20000;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dry = ctx.createGain();
  dry.gain.value = 1 - m.wet;
  node.connect(mono);
  mono.connect(delay).connect(filter).connect(gain);
  node.connect(dry).connect(bus);
  const c = { id, ctx, mono, delay, filter, gain, dry, nodes: [mono, delay, filter, gain, dry], mode: m.doc.panMode };
  if (isHoaMode(m.doc.panMode) && binauralSupported(ctx)) {
    const set = sharedSpeakers(ctx, m);
    c.feeds = set.inputs.map((inp, k) => { const g = ctx.createGain(); g.gain.value = 1 / set.inputs.length; gain.connect(g).connect(inp); c.nodes.push(g); return g; });
    c.dec = set.dec;
  } else if (m.doc.panMode === 'hrtf' && typeof ctx.createPanner === 'function') {
    c.panner = ctx.createPanner();
    c.panner.panningModel = 'HRTF';
    c.panner.distanceModel = 'linear';
    c.panner.rolloffFactor = 0;
    c.panner.positionZ.value = -1;
    gain.connect(c.panner).connect(bus);
    c.nodes.push(c.panner);
  } else {
    c.stereo = ctx.createStereoPanner();
    gain.connect(c.stereo).connect(bus);
    c.nodes.push(c.stereo);
  }
  chains.set(id, c);
  start();
  follow(true);
  return true;
}

/** Master clock (seconds in the master scene). / 마스터 시계 */
export function masterClock(ctx, length) {
  let cp = null;
  try { cp = getCyclePosition(); } catch { cp = null; } // the cycle exists before its first occurrence is scheduled / 첫 회차 스케줄 전
  if (cp) { freeT0 = null; return cp.pos; }
  if (!ctx) return 0;
  if (freeT0 === null) freeT0 = ctx.currentTime;
  const len = Math.max(0.5, length);
  return (ctx.currentTime - freeT0) % len;
}

const at = (b, key, T) => sampleBake(b, key, clamp(T, b.t0, b.t1));

/** Move every chain towards the values of the master scene at the master clock. / 모든 체인이 마스터 장면을 따라감 */
function follow(jump = false) {
  if (!chains.size) return;
  const m = getSpaceMaster();
  const bake = bakeSpace(m.doc);
  const offset = masterDelayOffset(m, bake);
  const scratch = { g: null };
  for (const c of chains.values()) {
    const src = masterSourceOf(m, c.id);
    const b = src && bake.sources.get(src.id);
    if (!b) continue;
    const now = c.ctx.currentTime;
    const T = masterClock(c.ctx, m.doc.length) + (jump ? 0 : AHEAD);
    const set = (param, v) => { if (jump) { param.cancelScheduledValues(now); param.setValueAtTime(v, now); } else param.setTargetAtTime(v, now, TAU); };
    const audible = !src.muted && (!m.doc.sources.some((x) => x.solo) || src.solo);
    const g = audible ? m.wet * src.baseGain * at(b, 'gain', T) * (b.gainLane ? at(b, 'gainLane', T) : 1) : 0;
    set(c.gain.gain, Math.max(0, g));
    set(c.dry.gain, 1 - m.wet);
    set(c.filter.frequency, clamp(at(b, 'lp', T), 40, c.ctx.sampleRate / 2 - 50));
    const d = src.doppler === false ? Math.max(0, b.t[0] - b.te[0] - offset) : Math.max(0, clamp(T, b.t0, b.t1) - at(b, 'te', T) - offset);
    set(c.delay.delayTime, Math.min(19.5, d));
    const lat = at(b, 'pan', T);
    const fwd = at(b, 'fwd', T);
    const up = at(b, 'up', T);
    if (c.feeds) {
      scratch.g = panGains(c.dec, fwd, -lat, up, b.width ? at(b, 'width', T) : 0, scratch.g && scratch.g.length === c.feeds.length ? scratch.g : new Float64Array(c.feeds.length));
      for (let k = 0; k < c.feeds.length; k++) set(c.feeds[k].gain, scratch.g[k]);
    } else if (c.panner) {
      set(c.panner.positionX, lat);
      set(c.panner.positionY, up);
      set(c.panner.positionZ, -fwd);
    } else set(c.stereo.pan, clamp(lat, -1, 1));
  }
}

function start() {
  if (timer !== null) return;
  timer = setInterval(() => {
    refreshSpaceMaster();
    if (!chains.size) { clearInterval(timer); timer = null; freeT0 = null; return; }
    if (activeChannelCount() === 0) freeT0 = null; // nothing sounds: the free clock starts again with the next launch / 무음이면 자유 시계 초기화
    follow();
  }, TICK_MS);
}

/**
 * Called after the master was edited (UI) and on every tick: rebuilds the routing when its shape
 * changed (on / off, output mode, track list, bypass). / 마스터 편집 뒤·매 틱 호출: 모양이 바뀌면 라우팅을 다시 구성
 */
export function refreshSpaceMaster() {
  const key = shapeKey(getSpaceMaster());
  if (key === graphKey) return false;
  graphKey = key;
  rerouteTracks();
  return true;
}

/** Number of tracks the master holds now (diagnostics). / 현재 마스터가 받은 트랙 수 */
export const spaceMasterTrackCount = () => chains.size;

/**
 * Offline router (cycle export): the track's fader output through the same spatial chain, with exact
 * curves over the whole cycle (cycle time = master time). Returns false → the track goes out dry.
 * 오프라인 라우터 (사이클 내보내기): 전체 사이클에 대한 정확한 곡선으로 같은 체인을 통과.
 */
function routeOffline(ctx, id, node, out, cycleLen) {
  const m = getSpaceMaster();
  const src = m.on ? masterSourceOf(m, id) : null;
  if (!src || src.input.bypass) return false;
  const bake = bakeSpace(m.doc);
  const b = bake.sources.get(src.id);
  if (!b) return false;
  const anySolo = m.doc.sources.some((x) => x.solo);
  if (src.muted || (anySolo && !src.solo)) { if (m.wet < 1) { const dry = ctx.createGain(); dry.gain.value = 1 - m.wet; node.connect(dry).connect(out); } return true; }
  if (m.wet < 1) { const dry = ctx.createGain(); dry.gain.value = 1 - m.wet; node.connect(dry).connect(out); }
  let spatial = null;
  if (isHoaMode(m.doc.panMode) && binauralSupported(ctx)) {
    ctx.__spaceMasterSpeakers = ctx.__spaceMasterSpeakers || createBinauralSpeakers(ctx, out, hoaMonitorOptions(m.doc, ctx.sampleRate));
    spatial = { mode: 'binaural', speakers: ctx.__spaceMasterSpeakers };
  }
  const wetSrc = { ...src, baseGain: src.baseGain * m.wet };
  return scheduleSpaceSource(ctx, out, wetSrc, b, { nowTime: 0, cueSec: 0, panMode: m.doc.panMode, rate: m.doc.bakeRate, spatial, stream: node, delayOffset: masterDelayOffset(m, bake) }) || (node.connect(out), true);
}

setTrackRouter(route, routeOffline);

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('space-c: Space Master — delay offset, track lookup, off = no routing', (a) => {
  const m = getSpaceMaster();
  a.ok(typeof m.on === 'boolean' && m.wet >= 0 && m.wet <= 1, 'master document is readable');
  a.equal(masterSourceOf({ doc: { sources: [{ id: 'x', input: { kind: 'track', target: 'T1' } }, { id: 'y', input: { kind: 'synth' } }] } }, 'T1')?.id, 'x', 'a track finds its master source');
  a.equal(masterSourceOf({ doc: { sources: [] } }, 'T1'), null, 'no source → not routed');
  if (!m.on) a.equal(route({ currentTime: 0 }, '__none__', null), false, 'master off → the router leaves every track to the output bus');
  a.equal(masterDelayOffset({ compensate: false, doc: { sources: [] } }, { sources: new Map() }), 0, 'compensation off → no offset');
}, { group: 'audio' });
