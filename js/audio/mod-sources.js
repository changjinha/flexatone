/**
 * Flexatone — audio/mod-sources.js
 * Layer 3 (audio): evaluates the Manager **Modulation** matrix (core/mod-config.js) in cycle time.
 * For a target track it returns what audio/manager-mixer.js folds into the track's Warp hooks:
 *   pitch(T) → semitones, level(T) → dB, trem(T), bright(T)   (added to the Warp of that track)
 *   doc: { 'cloud.density': (T) → fraction of the curve range, … } (applied to the document before render)
 *   retrig: [cycle times]                                        (the clip restarts there)
 * Sources:
 *   pitch → a line of the source track (audio/send-sources.js lines, or their mean) normalised to 0…1
 *   env   → loudness of the source clip as heard (rendered once, 10 ms RMS frames, −60…0 dB → 0…1), follower
 *   trig  → events: onsets of the source's lines, upward crossings of a line's centre, or loudness peaks;
 *           as an attack / decay pulse (0…1), or as restart times for Retrigger
 * Source envelopes are rendered asynchronously; until one is ready its routes read 0 and the target's key says
 * "pending", so the target is re-rendered when it arrives (onReady → syncMixer).
 * 계층 3 (audio): 모듈레이션 매트릭스를 사이클 시간으로 평가. 엔벨로프는 비동기 렌더, 준비되면 대상 재렌더.
 */

import { getInstance, listInstances, channelRates } from '../core/manager-state.js';
import { MOD_TARGETS, MEAN_KEY, usesSound, followEnvelope, dbToUnit, findPeaks, findCrossings, pulseTrain, frameAt } from '../core/mod-config.js';
import { listModStatuses } from '../core/manager-mods.js';
import { listSourceLines } from '../studios/trajectory-link.js';
import { spaceSignalLines, applySpaceDocMods } from './space-mod.js';
import { getInstanceDoc } from '../core/manager-state.js';
import { resolveClipParams } from './studio-clips.js';
import { bakeSpace } from '../studios/space/space-engine.js';
import { isSourceAudible } from '../studios/space/space-doc.js';
import { compileLane, normalizeLane } from '../studios/space/space-lanes.js';
import { t } from '../core/i18n.js';
import './send-sources.js'; // registers the line sources of every studio / 스튜디오별 선 등록

const ENV_SR = 22050;
const DT = 0.01; // envelope frame (s) / 엔벨로프 프레임

let deps = {
  clipLength: () => 0,
  plainLength: () => 0, // one pass in real seconds, without Warp time density / 곡률 시간 밀도 없는 1회 길이
  soundKey: () => '', // what a track's lines depend on / 선이 의존하는 것
  heardKey: () => '', // what a track's sound depends on / 소리가 의존하는 것
  renderHeard: async () => null, // (inst, sampleRate, L) → AudioBuffer of the clip as heard / 들리는 그대로의 클립
  onReady: () => {},
};

/** Wire the mixer in (avoids a circular import). / 믹서 연결 */
export function configureModSources(d) {
  deps = { ...deps, ...d };
}

// --------------------------------------------------------------------------
// Placement: cycle time ↔ the source's own time / 배치: 사이클 시간 ↔ 출처 시간
// --------------------------------------------------------------------------

function placement(inst) {
  const L = deps.clipLength(inst);
  const one = inst.studio === 'risset' ? 0 : deps.plainLength(inst);
  return { start: Number(inst.start) || 0, L, loopP: inst.loop && one > 0.02 && Number.isFinite(one) ? one : 0, rate: channelRates(inst).rate || 1 };
}

/** Document seconds of the source at cycle time T, or null outside its clip. / 사이클 T의 문서 초 */
function docTime(pl, T) {
  let u = T - pl.start;
  if (!(u >= 0) || u > pl.L) return null;
  if (pl.loopP > 0) u %= pl.loopP;
  return u * pl.rate;
}

/** Cycle times of document-time events (every loop pass inside the clip). / 문서 시각 → 사이클 시각 */
function eventTimes(pl, docTimes) {
  const out = [];
  const passes = pl.loopP > 0 ? Math.min(512, Math.ceil(pl.L / pl.loopP)) : 1;
  for (let r = 0; r < passes; r++) {
    for (const t of docTimes) {
      const u = t / pl.rate;
      if (pl.loopP > 0 && u >= pl.loopP - 1e-6) continue;
      const v = r * pl.loopP + u;
      if (v >= 0 && v <= pl.L) out.push(pl.start + v);
    }
  }
  return out.sort((a, b) => a - b);
}

// --------------------------------------------------------------------------
// Lines / 선
// --------------------------------------------------------------------------

/** Lines a track offers (its studio's send lines, plus 'mean'). / 트랙이 내놓는 선 */
export function modLinesOf(inst) {
  if (!inst || inst.studio === 'risset') return [];
  const lines = listSourceLines(inst.studio, inst.id);
  if (inst.studio !== 'space') return lines;
  // Space: distance, radial speed, direction, Doppler shift and the approach gate of every source (space-mod.js)
  // 스페이스: 음원마다 거리·시선 속도·방향·도플러 편이·접근 게이트
  try {
    const p = resolveClipParams('space', getInstanceDoc(inst));
    return [...lines, ...spaceSignalLines(p.sources.filter((s) => isSourceAudible(s, p)), bakeSpace(p), (k) => t(`space.sig.${k}`))];
  } catch (err) {
    console.error('[Flexatone] space signals failed:', err);
    return lines;
  }
}

function pickLine(inst, key) {
  const lines = modLinesOf(inst);
  return lines.find((l) => String(l.key) === String(key)) || lines.find((l) => l.key === MEAN_KEY) || lines[0] || null;
}

/** Normalised table of a line over its own span: { t0, t1, v: Float32Array } (v ∈ 0…1). / 정규화 표 */
function lineTable(line, n = 512) {
  const pts = line.pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.m)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) { lo = Math.min(lo, p.m); hi = Math.max(hi, p.m); }
  if (hi - lo < 0.5) { const c = 0.5 * (lo + hi); lo = c - 0.25; hi = c + 0.25; }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const v = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const f = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-9, b.t - a.t)));
    v[i] = (a.m + f * (b.m - a.m) - lo) / (hi - lo);
  }
  return { t0, t1, v };
}

function tableAt(tab, t) {
  if (t <= tab.t0) return tab.v[0];
  if (t >= tab.t1) return tab.v[tab.v.length - 1];
  const x = ((t - tab.t0) / (tab.t1 - tab.t0)) * (tab.v.length - 1);
  const i = Math.floor(x);
  return tab.v[i] + (x - i) * (tab.v[i + 1] - tab.v[i]);
}

// --------------------------------------------------------------------------
// Envelopes (async) / 엔벨로프 (비동기)
// --------------------------------------------------------------------------

const envCache = new Map(); // key → { db: Float32Array | null, pending: Promise | null }

function envKey(inst) {
  const pl = placement(inst);
  return `${inst.id}|${deps.heardKey(inst)}|${pl.L.toFixed(3)}`;
}

function envOf(inst) {
  const e = envCache.get(envKey(inst));
  return e && e.db ? e.db : null;
}

async function renderEnv(inst, key) {
  const L = Math.min(180, deps.clipLength(inst));
  let db = new Float32Array(0);
  if (L >= 0.02) {
    let buf = null;
    try { buf = await deps.renderHeard(inst, ENV_SR, L); } catch (err) { console.error('[Flexatone] modulation envelope failed:', err); }
    if (buf) {
      const win = Math.max(1, Math.round(DT * buf.sampleRate));
      const frames = Math.ceil(buf.length / win);
      db = new Float32Array(frames);
      const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
      for (let f = 0; f < frames; f++) {
        let acc = 0;
        const s0 = f * win;
        const s1 = Math.min(buf.length, s0 + win);
        for (const d of chans) for (let i = s0; i < s1; i++) acc += d[i] * d[i];
        const ms = acc / Math.max(1, (s1 - s0) * chans.length);
        db[f] = ms > 1e-12 ? 10 * Math.log10(ms) + 3.01 : -120; // RMS of a sine at 0 dBFS reads 0 dB / 사인 0 dBFS = 0 dB
      }
    }
  }
  envCache.set(key, { db, pending: null });
  if (envCache.size > 64) envCache.delete(envCache.keys().next().value);
  return db;
}

/** Sources whose sound a route needs, in order (their own sound-deps first). / 필요한 엔벨로프 출처 */
function neededEnvSources() {
  const ids = new Set();
  for (const { mod, status } of listModStatuses()) if (status === 'ok' && usesSound(mod.src)) ids.add(mod.src.inst);
  return [...ids].map(getInstance).filter(Boolean);
}

/**
 * Render every envelope a route needs. A source whose own sound depends on another envelope waits for it
 * (passes repeat until nothing is missing). Resolves true when something new was rendered.
 * 필요한 엔벨로프를 모두 렌더 (출처가 다른 엔벨로프에 의존하면 그 다음 차례).
 */
export async function ensureModEnvelopes({ notify = true } = {}) {
  let any = false;
  for (let pass = 0; pass < 8; pass++) {
    const jobs = [];
    for (const inst of neededEnvSources()) {
      const key = envKey(inst); // includes the source's own modulation key / 출처 자신의 모듈레이션 포함
      const e = envCache.get(key);
      if (e?.db) continue;
      if (e?.pending) { jobs.push(e.pending); continue; }
      if (modKey(inst).includes('pending')) continue; // waits for its own sources / 자기 출처를 기다림
      const pending = renderEnv(inst, key);
      envCache.set(key, { db: null, pending });
      jobs.push(pending);
    }
    if (!jobs.length) break;
    await Promise.all(jobs);
    any = true;
  }
  if (any && notify) deps.onReady();
  return any;
}

let readyTimer = null;
function scheduleEnvRender() {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => { ensureModEnvelopes().catch((err) => console.error(err)); }, 60);
}

// --------------------------------------------------------------------------
// Route signals / 라우트 신호
// --------------------------------------------------------------------------

/** { key, fn: (T) → 0…1, times: [cycle s] | null } of one route, or null. / 라우트 하나의 신호 */
function routeSignal(mod) {
  const src = getInstance(mod.src.inst);
  if (!src) return null;
  const pl = placement(src);
  const base = JSON.stringify([mod.src, mod.invert, mod.attackMs, mod.releaseMs, pl]);
  let fn = null;
  let times = null;
  let key;
  if (mod.src.kind === 'env' || (mod.src.kind === 'trig' && mod.src.trig === 'peak')) {
    const ek = envKey(src);
    const db = envOf(src);
    key = `${base}|${ek}|${db ? 'ready' : 'pending'}`;
    if (!db) { scheduleEnvRender(); return { key, fn: () => 0, times: [] }; }
    if (mod.src.kind === 'env') {
      const unit = new Float32Array(db.length);
      for (let i = 0; i < db.length; i++) unit[i] = dbToUnit(db[i]);
      const f = followEnvelope(unit, DT, mod.attackMs, mod.releaseMs);
      fn = (T) => { const u = T - pl.start; return u >= 0 && u <= pl.L ? frameAt(f, DT, u) : 0; };
    } else {
      times = findPeaks(db, DT, mod.src.thrDb).map((u) => pl.start + u).filter((T) => T <= pl.start + pl.L);
    }
  } else {
    key = `${base}|${deps.soundKey(src)}`;
    if (mod.src.kind === 'pitch') {
      const line = pickLine(src, mod.src.line);
      const tab = line ? lineTable(line) : null;
      if (!tab) return { key, fn: () => 0, times: null };
      fn = (T) => { const t = docTime(pl, T); return t === null ? 0 : tableAt(tab, t); };
    } else if (mod.src.trig === 'cross') {
      const line = pickLine(src, mod.src.line);
      times = eventTimes(pl, line ? findCrossings(line.pts) : []);
    } else { // onset: the first point of every line / 모든 선의 시작
      const docT = [];
      for (const l of modLinesOf(src)) {
        if (l.key === MEAN_KEY) continue;
        const p = l.pts.find((q) => Number.isFinite(q.t) && Number.isFinite(q.m));
        if (p) docT.push(p.t);
      }
      times = eventTimes(pl, docT);
    }
  }
  if (times) fn = pulseTrain(times, mod.attackMs, mod.releaseMs);
  const out = mod.invert ? (T) => 1 - fn(T) : fn;
  return { key, fn: out, times };
}

const memo = new Map(); // target id → { key, value } / 대상별 메모
const building = new Set(); // re-entrancy guard / 재진입 방지

function routesTo(inst) {
  return listModStatuses().filter(({ mod, status }) => status === 'ok' && mod.dst.inst === inst.id && getInstance(mod.src.inst));
}

/** Key of everything that modulates a track ('' = nothing). / 트랙을 움직이는 모든 것의 키 */
export function modKey(inst) {
  return modOfTrack(inst)?.key || '';
}

/**
 * The modulation of a target track, or null. / 대상 트랙의 모듈레이션 (없으면 null)
 * @returns {null | { key, pitch, level, trem, bright, doc, retrig }}
 */
export function modOfTrack(inst) {
  if (!inst || building.has(inst.id)) return null;
  const routes = routesTo(inst);
  if (!routes.length) { memo.delete(inst.id); return null; }
  building.add(inst.id);
  try {
    const sigs = routes.map(({ mod }) => ({ mod, sig: routeSignal(mod) })).filter((x) => x.sig);
    const key = `mod:${sigs.map((x) => `${x.mod.id}:${x.mod.amount}:${x.mod.dst.param}:${x.sig.key}`).join('§')}`;
    const hit = memo.get(inst.id);
    if (hit && hit.key === key) return hit.value;
    const by = {};
    let retrig = null;
    for (const { mod, sig } of sigs) {
      const p = mod.dst.param;
      if (p === 'retrig') { if (sig.times) retrig = [...(retrig || []), ...sig.times]; continue; }
      (by[p] = by[p] || []).push((T) => mod.amount * sig.fn(T));
    }
    const sum = (list) => (list && list.length ? (T) => { let v = 0; for (const f of list) v += f(T); return v; } : null);
    const doc = {};
    for (const p of Object.keys(by)) if (MOD_TARGETS[p]?.doc) doc[p] = sum(by[p]);
    const value = {
      key: key + (retrig ? `|rt:${retrig.map((x) => x.toFixed(3)).join(',')}` : ''),
      pitch: sum(by.pitch),
      level: sum(by.gain),
      trem: sum(by.trem),
      bright: sum(by.bright),
      doc: Object.keys(doc).length ? doc : null,
      retrig: retrig ? retrig.sort((a, b) => a - b) : null,
    };
    memo.set(inst.id, { key, value });
    return value;
  } finally {
    building.delete(inst.id);
  }
}

/**
 * Sampled signal of one route over [0, C] for the matrix card (n points, values after invert, before
 * amount). Envelopes that are not ready read 0. / 라우트 신호 미리보기
 */
export function routePreview(mod, C, n = 160) {
  const sig = routeSignal(mod);
  if (!sig) return null;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = sig.fn((C * i) / (n - 1));
  return { v, times: sig.times, pending: sig.key.endsWith('pending') };
}

/** Tracks that could be a source or a target (every track that is not a Warp-only source). / 후보 트랙 */
export function modTracks() {
  return listInstances().filter((i) => !i.warp?.on);
}

// --------------------------------------------------------------------------
// Document targets (Cloud curves) / 문서 대상 (클라우드 곡선)
// --------------------------------------------------------------------------

const CLOUD_RANGE = { density: [0.2, 200], width: [0, 48], collapse: [0, 1], center: [12, 120] }; // = cloud-engine CURVE_RANGES
// amount unit: × the curve's own range (hi − lo); flat curve: density × its value, width / centre ±12 st, collapse ±1

/**
 * Apply document modulation to resolved params of a clip whose first sample sits at cycle time `start`
 * (rate = document seconds per real second). Returns new params (or the same). / 문서 모듈레이션 적용
 * `evalCurve(curve, tn, key)` = the studio's curve evaluator (cloud-engine evalCloudCurve).
 */
export function applyDocMods(inst, params, start, rate, evalCurve) {
  const m = modOfTrack(inst);
  if (m?.doc && inst.studio === 'space' && params) {
    // a Space lane at x ∈ 0…1 of its range / 스페이스 레인의 x ∈ 0…1 값
    const laneAt = (lane, kind, x) => compileLane(kind === 'yaw' ? { ...lane, dom: null } : normalizeLane(kind, { ...lane, dom: null }), [0, 1])(x);
    return applySpaceDocMods(m.doc, params, start, rate, laneAt);
  }
  if (!m?.doc || inst.studio !== 'cloud' || !params || !evalCurve) return params;
  const out = { ...params, pitch: { ...params.pitch }, glide: { ...params.glide } };
  const L = Math.max(0.05, Number(params.length) || 1);
  const N = 64;
  const slot = { density: [out, 'density'], width: [out.pitch, 'width'], collapse: [out.glide, 'clusterCollapse'], center: [out.pitch, 'center'] };
  for (const [p, fn] of Object.entries(m.doc)) {
    const name = p.split('.')[1];
    const [holder, field] = slot[name] || [];
    if (!holder || !fn || !holder[field]) continue;
    const curve = holder[field];
    const [rmin, rmax] = CLOUD_RANGE[name];
    // amount × the curve's range; a flat curve uses a span of its own kind / 평평한 곡선은 종류별 기본 폭
    const range = Math.abs((Number(curve.hi) || 0) - (Number(curve.lo) || 0));
    const flat = { density: Math.max(1, evalCurve(curve, 0.5, name)), width: 12, collapse: 1, center: 12 }[name];
    const span = range > 1e-6 ? range : flat;
    const vals = [];
    for (let i = 0; i < N; i++) {
      const tn = i / (N - 1);
      const T = start + (tn * L) / Math.max(1e-6, rate);
      vals.push(Math.min(rmax, Math.max(rmin, evalCurve(curve, tn, name) + fn(T) * span)));
    }
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    if (hi - lo < 1e-6) hi = lo + 1e-6;
    holder[field] = { ...curve, engine: 'custom', reverse: false, inverse: false, lo: Number(lo.toFixed(4)), hi: Number(hi.toFixed(4)), customPoints: vals.map((v, i) => ({ x: Number((i / (N - 1)).toFixed(4)), y: Number(((v - lo) / (hi - lo)).toFixed(4)), handles: [] })) };
  }
  return out;
}
