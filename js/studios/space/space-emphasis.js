/**
 * Flexatone — studios/space/space-emphasis.js
 * Layer 2 (studios, view helper): **emphasis** of the sources that sound now — used by the video export so a
 * busy scene stays readable: sources that are silent at the shown time are drawn as faint silhouettes, the
 * sounding ones in full colour, and (sub-option) their brightness follows their level.
 * 계층 2 (studios, 보기 헬퍼): 지금 소리 나는 음원 **강조** — 동영상 내보내기용. 지금 조용한 음원은 흐린 실루엣,
 * 소리 나는 음원은 원래 색, (하위 옵션) 밝기는 음량을 따름.
 *
 *   level(s, T) = distance gain(T) · baseGain · trim · gain lane(T) · fades · content(τ)
 *     content(τ) = RMS envelope (≈ 20 ms) of the source's sound at its emission time τ (import / Manager
 *     track); 1 for synth sources and for a sound that is not rendered yet.
 *   sounding ⇔ level > −60 dB.  brightness = 0.3 + 0.7 · clamp((dB − ref + 36) / 36), ref = max(loudest now, −30 dB).
 *   level = 거리 게인 · 기본 게인 · 트림 · 게인 레인 · 페이드 · 내용(τ의 RMS). −60 dB 초과면 소리 남.
 *
 * View state only (module variable, not in the document): the video dialog switches it on while it is open.
 * 문서가 아닌 보기 상태 — 동영상 대화상자가 열려 있는 동안만 켬.
 */

import { clamp } from '../../core/math-utils.js';
import { sampleBake } from './space-engine.js';
import { spaceSourceWindow, importState } from './space-audio.js';
import { isSourceAudible, getSpaceBake } from './space-doc.js';
import { getInstance, isInstanceAudible } from '../../core/manager-state.js';

const emph = { sound: false, gain: false };
const SILENT_DB = -60;
export const GHOST = 0.14; // alpha of a silent source's silhouette / 조용한 음원 실루엣의 불투명도
const RMS_RATE = 50; // envelope points per second / 초당 엔벨로프 점

// Size of the editing marks (spline nodes, their numbers and handles, path handles) — 1 = as in the editor,
// 0 = hidden. Set by the video export. / 편집 표시(스플라인 노드·번호·핸들, 경로 핸들) 크기 — 1 = 편집기 그대로, 0 = 숨김
let nodeScale = 1;
export const getNodeScale = () => nodeScale;
export function setNodeScale(v) { nodeScale = clamp(Number(v) || 0, 0, 3); }

/** Current emphasis switches. / 현재 강조 설정 */
export function getEmphasis() { return { ...emph }; }
/** patch = { sound?: boolean, gain?: boolean } / 강조 설정 변경 */
export function setEmphasis(patch) {
  if ('sound' in patch) emph.sound = !!patch.sound;
  if ('gain' in patch) emph.gain = !!patch.gain;
}

// RMS envelope per AudioBuffer (mono sum), computed once / 버퍼별 RMS 엔벨로프 (한 번 계산)
const rmsCache = new WeakMap();
function rmsEnvelope(buf) {
  let env = rmsCache.get(buf);
  if (env) return env;
  const hop = Math.max(1, Math.round(buf.sampleRate / RMS_RATE));
  const n = Math.ceil(buf.length / hop);
  const out = new Float32Array(n);
  const ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const k = 1 / ch.length;
  for (let j = 0; j < n; j++) {
    const i0 = j * hop;
    const i1 = Math.min(buf.length, i0 + hop);
    let acc = 0;
    for (let i = i0; i < i1; i++) {
      let x = 0;
      for (const a of ch) x += a[i];
      x *= k;
      acc += x * x;
    }
    out[j] = Math.sqrt(acc / Math.max(1, i1 - i0));
  }
  env = { rate: buf.sampleRate / hop, data: out, dur: buf.duration };
  rmsCache.set(buf, env);
  return env;
}

function contentAt(s, b, T) {
  if (s.input?.kind !== 'import' && s.input?.kind !== 'track') return 1;
  let st;
  try { st = importState(s); } catch (e) { return 1; }
  if (!st?.buffer) return 1; // not rendered yet: assume it sounds / 아직 렌더 전: 소리 난다고 봄
  const te = sampleBake(b, 'te', T);
  if (!Number.isFinite(te)) return 0;
  const env = rmsEnvelope(st.buffer);
  let off = te - (b.teStart ?? b.te[0]) + (Number(s.input.offset) || 0);
  if (s.input.play === 'loop') off = ((off % env.dur) + env.dur) % env.dur;
  if (off < 0 || off >= env.dur) return 0;
  const x = off * env.rate;
  const i = Math.min(env.data.length - 1, Math.floor(x));
  const j = Math.min(env.data.length - 1, i + 1);
  // ×√2: a full-scale sine reads 1 / 정현파 최대값 기준
  return (env.data[i] + (env.data[j] - env.data[i]) * (x - i)) * Math.SQRT2;
}

/** Linear level of source s at listener time T (0 = silent). / T 시점 음원의 선형 음량 */
export function sourceLevel(s, doc, bake, T) {
  if (!isSourceAudible(s, doc)) return 0;
  if (s.input?.kind === 'track') { // a muted / warp / out-of-cycle Manager track is silent / 음소거·곡률·사이클 밖 트랙은 무음
    const inst = getInstance(s.input.target);
    if (!inst || !isInstanceAudible(inst) || inst.inCycle === false) return 0;
  }
  const b = bake.sources.get(s.id);
  if (!b) return 0;
  const W = spaceSourceWindow(s, b);
  if (!(T >= W.t0 && T <= W.t1)) return 0;
  const g0 = sampleBake(b, 'gain', T);
  if (!Number.isFinite(g0)) return 0;
  const isImport = s.input?.kind === 'import' || s.input?.kind === 'track';
  let g = Math.max(0, g0 * (Number(s.baseGain) || 0) * (isImport ? Math.pow(10, (Number(s.input.trimDb) || 0) / 20) : 1));
  if (b.gainLane) g *= sampleBake(b, 'gainLane', T) || 0;
  return g * contentAt(s, b, T);
}

const toDb = (a) => (a > 1e-9 ? 20 * Math.log10(a) : -200);

let memo = { doc: null, T: NaN, emph: '', map: null };
/**
 * Look of every source at T: Map id → { lit, a } (a = alpha factor 0…1). With emphasis off every source is
 * { lit: true, a: 1 }, so the views draw as before. / T 시점 음원별 표시 (강조가 꺼져 있으면 모두 a = 1)
 */
export function sourceLooks(doc, T, bake = getSpaceBake(doc)) {
  const key = `${emph.sound}${emph.gain}`;
  if (memo.doc === doc && memo.T === T && memo.emph === key) return memo.map;
  const map = new Map();
  if (!emph.sound) {
    for (const s of doc.sources) map.set(s.id, { lit: true, a: 1 });
  } else {
    const db = new Map();
    let top = -200;
    for (const s of doc.sources) { const d = toDb(sourceLevel(s, doc, bake, T)); db.set(s.id, d); if (d > top) top = d; }
    const ref = Math.max(top, -30);
    for (const s of doc.sources) {
      const d = db.get(s.id);
      const lit = d > SILENT_DB;
      const a = !lit ? GHOST : emph.gain ? 0.3 + 0.7 * clamp((d - ref + 36) / 36, 0, 1) : 1;
      map.set(s.id, { lit, a });
    }
  }
  memo = { doc, T, emph: key, map };
  return map;
}

/** Look of one source (see sourceLooks). / 음원 하나의 표시 */
export function sourceLook(doc, s, T, bake) {
  return sourceLooks(doc, T, bake).get(s.id) || { lit: true, a: 1 };
}
