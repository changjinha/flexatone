/**
 * Flexatone — studios/cloud/cloud-modules.js
 * Layer 2 (studios, pure): Cloud multi-module — the same model as the Risset region modules
 * (studios/risset/space-regions.js). The cloud is split into modules M1…M6, each a pitch band
 * [lo, hi] of the cloud's pitch range (pitch.min … pitch.max of the document) with its own
 * settings (density, pitch distribution, glide, duration, gain, polyphony, seed), on / S / M / gain,
 * and a voice layout:
 *   'pitch'  (default) the band is the module's own pitch range — its base MIDI = the band's bottom,
 *            its span = the band's height; its grains are drawn inside it.
 *   'fit'    the module's cloud is generated over its full pitch range and squeezed into the band.
 *   'window' the module's cloud is generated as is; only the grains starting inside the band sound.
 * With no modules the cloud is the classic single cloud (the document as it always was).
 * 계층 2 (순수): 클라우드 다중 모듈 — 리세 영역 모듈과 같은 모델. 모듈마다 음고 띠·자체 설정·켜기/S/M/게인·배치.
 *
 * Imports: core/*, cloud-engine.js only. / DOM·오디오 의존 없음.
 */

import { clamp, deepClone, uid } from '../../core/math-utils.js';
import { bakeCloudEvents, normalizeCloudParams, makeCurve, maxOverlap } from './cloud-engine.js';

export const MAX_MODULES = 6;
export const MODULE_LAYOUTS = Object.freeze(['pitch', 'fit', 'window']);
export const MODULE_COLORS = Object.freeze(['#34d399', '#f472b6', '#60a5fa', '#fbbf24', '#a78bfa', '#f87171']);
/** Document keys a module may own (everything that shapes its events). / 모듈이 가질 수 있는 키 */
export const MODULE_OWN_KEYS = Object.freeze(['seed', 'density', 'pitch', 'glide', 'duration', 'gain', 'maxEvents', 'maxPolyphony']);

export function createCloudModule(patch = {}) {
  return { id: uid('cm_', 6), enabled: true, solo: false, mute: false, gain: 1, lo: 0, hi: 1, layout: 'pitch', syncCore: true, own: {}, ...patch };
}

/** Clamp / repair the module list ([] = the classic single cloud). / 모듈 목록 정규화 */
export function sanitizeModules(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, MAX_MODULES).map((m0) => {
    const m = { ...createCloudModule(), ...(m0 && typeof m0 === 'object' ? m0 : {}) };
    if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) m.id = uid('cm_', 6);
    seen.add(m.id);
    m.enabled = m.enabled !== false;
    m.solo = m.solo === true;
    m.mute = m.mute === true;
    m.gain = clamp(Number.isFinite(Number(m.gain)) ? Number(m.gain) : 1, 0, 2);
    let lo = clamp(Number(m.lo) || 0, 0, 1);
    let hi = clamp(Number.isFinite(Number(m.hi)) ? Number(m.hi) : 1, 0, 1);
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi - lo < 0.01) hi = Math.min(1, lo + 0.01);
    m.lo = lo;
    m.hi = hi;
    m.layout = MODULE_LAYOUTS.includes(m.layout) ? m.layout : 'pitch';
    m.syncCore = m.syncCore !== false;
    const own = {};
    if (m.own && typeof m.own === 'object') for (const k of MODULE_OWN_KEYS) if (k in m.own) own[k] = deepClone(m.own[k]);
    m.own = own;
    return m;
  });
}

/** Sounding: on, not muted, and soloed when any module is soloed. / 소리 나는 모듈 (S/M) */
export function moduleAudible(m, mods) {
  if (!m.enabled || m.mute) return false;
  return !mods.some((x) => x.solo && x.enabled) || !!m.solo;
}

/** The band of a module in MIDI, inside the cloud's pitch range. / 모듈 띠 (MIDI) */
export function moduleBand(doc, m) {
  const a = Number(doc.pitch.min);
  const b = Number(doc.pitch.max);
  return { b0: a + m.lo * (b - a), b1: a + m.hi * (b - a) };
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (isObj(v) && isObj(base[k])) merge(base[k], v);
    else base[k] = deepClone(v);
  }
  return base;
}

/**
 * The document as module `m` sees it (what the toolboxes show while it is selected): the shared
 * document + its own settings; with layout 'pitch' its pitch range is its band.
 * 모듈이 보는 문서: 공유 문서 + 자체 설정 ('pitch' 배치면 음고 범위 = 띠).
 */
export function moduleView(doc, m) {
  const v = merge(deepClone(doc), m.own);
  if (m.layout === 'pitch') {
    const { b0, b1 } = moduleBand(doc, m);
    v.pitch.min = Math.round(b0 * 100) / 100;
    v.pitch.max = Math.round(b1 * 100) / 100;
  } else {
    v.pitch.min = 'min' in (m.own.pitch || {}) ? m.own.pitch.min : doc.pitch.min;
    v.pitch.max = 'max' in (m.own.pitch || {}) ? m.own.pitch.max : doc.pitch.max;
  }
  return v;
}

/** The document a module generates from (its view + its own seed stream). / 모듈 생성용 문서 */
function moduleDoc(doc, m, k) {
  const v = moduleView(doc, m);
  if (!('seed' in m.own)) v.seed = (Number(doc.seed) + 7919 * k) >>> 0; // M1 keeps the cloud's seed / M1은 원래 시드
  return normalizeCloudParams(v);
}

let mergeCache = { key: '', ev: null };

/**
 * Event list of a multi-module cloud: every audible module's events (mapped into its band for 'fit',
 * filtered by it for 'window'), scaled by its gain and its own auto level, merged in time order.
 * Same struct-of-arrays shape as generateCloudEvents. / 다중 모듈 이벤트 (시간순 병합)
 */
export function moduleEvents(doc) {
  const mods = doc.modules || [];
  const key = JSON.stringify([doc.seed, doc.length, doc.density, doc.pitch, doc.glide, doc.duration, doc.gain, doc.maxEvents, doc.maxPolyphony, mods]);
  if (mergeCache.key === key) return mergeCache.ev;
  const parts = [];
  let polyCap = 0;
  mods.forEach((m, k) => {
    if (!moduleAudible(m, mods) || m.gain <= 0) return;
    const md = moduleDoc(doc, m, k);
    const ev = bakeCloudEvents(md);
    const { b0, b1 } = moduleBand(doc, m);
    const a = md.pitch.min;
    const span = Math.max(1e-6, md.pitch.max - md.pitch.min);
    const map = m.layout === 'fit' ? (p) => b0 + ((p - a) / span) * (b1 - b0) : (p) => p;
    const g = m.gain * (ev.levelScale || 1);
    parts.push({ ev, map, g, win: m.layout === 'window' ? [b0, b1] : null, k });
    polyCap += md.maxPolyphony;
  });
  const idx = [];
  for (const P of parts) for (let i = 0; i < P.ev.n; i++) {
    const p0 = P.ev.p0[i];
    if (P.win && (p0 < P.win[0] || p0 > P.win[1])) continue;
    idx.push([P, i]);
  }
  idx.sort((x, y) => x[0].ev.t0[x[1]] - y[0].ev.t0[y[1]] || x[0].k - y[0].k);
  const n = idx.length;
  const out = { n, t0: new Float32Array(n), dur: new Float32Array(n), p0: new Float32Array(n), p1: new Float32Array(n), gain: new Float32Array(n), pan: new Float32Array(n), module: new Uint8Array(n) };
  let maxDur = 0;
  let sumDur = 0;
  idx.forEach(([P, i], j) => {
    const e = P.ev;
    out.t0[j] = e.t0[i]; out.dur[j] = e.dur[i];
    out.p0[j] = P.map(e.p0[i]); out.p1[j] = P.map(e.p1[i]);
    out.gain[j] = clamp(e.gain[i] * P.g, 0, 1); out.pan[j] = e.pan[i]; out.module[j] = P.k;
    maxDur = Math.max(maxDur, e.dur[i]);
    sumDur += e.dur[i];
  });
  const base = normalizeCloudParams(doc);
  out.maxDur = maxDur;
  out.length = base.length;
  out.envelope = base.gain.envelope;
  out.attack = base.gain.attack;
  const sum = (f) => parts.reduce((s, P) => s + (P.ev.stats?.[f] || 0), 0);
  out.stats = { generated: sum('generated'), expected: sum('expected'), truncated: parts.some((P) => P.ev.stats?.truncated), droppedSieve: sum('droppedSieve'), droppedPoly: sum('droppedPoly'), events: n, maxOverlap: maxOverlap(out), meanOverlap: sumDur / Math.max(0.1, base.length), sieveSize: 0 };
  out.levelScale = 1; // each module's own auto level is in its gains / 모듈별 자동 레벨은 이득에 포함
  out.polyCap = Math.max(1, polyCap);
  out.sig = `mods:${key.length}:${hashStr(key)}`;
  mergeCache = { key, ev: out };
  return out;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * The first "+ Module": M1 = the whole cloud as it is (full range, no own settings), M2 = a new band.
 * 처음 "+ 모듈": M1 = 지금 구름 전체, M2 = 새 띠.
 */
export function addModuleTo(doc) {
  if (!Array.isArray(doc.modules)) doc.modules = [];
  if (!doc.modules.length) doc.modules.push(createCloudModule());
  if (doc.modules.length >= MAX_MODULES) return false;
  const m = createCloudModule({ lo: 0.3, hi: 0.7 });
  const { b0, b1 } = moduleBand(doc, m);
  m.own = { pitch: { ...deepClone(doc.pitch), center: makeCurve(Math.round((b0 + b1) / 2)) } }; // centred in its band / 띠 가운데
  delete m.own.pitch.min;
  delete m.own.pitch.max;
  doc.modules.push(m);
  doc.activeModule = doc.modules.length - 1;
  return true;
}
