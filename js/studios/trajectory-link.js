/**
 * Flexatone — studios/trajectory-link.js
 * Layer 2 (studios, pure): trajectory **Sends** — a pitch line of one studio used as the base line of
 * another studio (or of every studio: the **Master** destination), the order in which the receiving
 * studios take them, and the link that keeps them connected afterwards.
 * 계층 2 (studios, 순수): 궤적 **보내기(Send)** — 한 스튜디오의 음고 선을 다른 스튜디오(또는 마스터 = 모든 스튜디오)의
 * 기본 선으로 쓰고, 받는 순서를 정하고, 그 뒤에도 연결을 유지.
 *
 * Data / 데이터
 *   Sends (project-wide, saved and undoable with the studio documents):
 *     studioParams._sends = { list: [{ id, from: { studio, line, name, inst }, to: <studio> | 'master',
 *                                       mode: 'replace' | 'add', on, except: [studio], bound: { studio: inst },
 *                                       locked, sig }] }
 *     `_sends` starts with "_" so it can never be a studio id (STUDIO_SLUG starts with a letter).
 *   Receive record in each receiving studio's own document: `doc.trajLink = { sends: [ids], sig, …ids }`
 *     (sig = what was last written; Draw / Field / Space / Glissando keep the id of the line they fill).
 *
 * Order / 순서
 *   1. Every send is expanded into edges (Master → every receiving studio except its own studio and `except`).
 *   2. Edges are taken in list order; an edge that would close a loop (A → B → A) is not applied ("loop").
 *   3. Studios are evaluated by stage (longest path over the applied edges): a studio is always evaluated
 *      after every studio it receives from, so A → B → C sends the B that already took A.
 *   4. Inside one receiving studio its sends are combined in list order:
 *        replace → the line becomes the source line (anything above it is discarded)
 *        add     → the source's contour (its pitch minus its first pitch) is added on top of the line so far
 *      Reordering sends inside a receiver = moving them in the list (`moveInbound`).
 *
 * Instances / 인스턴스: a send reads its source from the instance chosen when it was made (`from.inst`,
 * stored document if that instance is not in the editor) and writes only into the instance of the receiving
 * studio that was in the editor when it first received (`bound`). A send never overwrites another instance.
 *
 * Glissando sources keep their lock / guard (ui/trajectory-ui.js): locked → the voice's shape is protected,
 * `sig` = its trajectorySignature at lock time.
 */

import { clamp, deepClone, rdpSimplify } from '../core/math-utils.js';
import { appState, dispatch, getVoiceById, registerSelfCheck, createDefaultVoice, withIsolatedState, createInitialState } from '../core/state.js';
import { getFocusedId, getInstance, getInstanceDoc, isFocused } from '../core/manager-state.js';
import { getVoiceMidiAtNormT } from '../modules/curve-engine.js';
import { StudioRegistry } from './registry.js';

export const SENDS_KEY = '_sends';
export const MASTER = 'master';
export const SEND_MODES = Object.freeze(['replace', 'add']);
export const MEAN_LINE = 'mean';
/** Display / evaluation tie-break order (= header tabs). / 표시 순서 */
export const SEND_STUDIO_ORDER = Object.freeze(['glissando', 'risset', 'field', 'draw', 'cloud', 'space', 'tempo', 'chaos', 'fractal', 'wave']);
const TRAJ_SAMPLES = 128;

const targets = new Map(); // studio id → { apply(traj, { history, link }) }
const sources = new Map(); // studio id → { lines(doc) → [{ key, name, color?, pts: [{ t, m }] }] }

const orderOf = (id) => { const i = SEND_STUDIO_ORDER.indexOf(id); return i < 0 ? 99 : i; };
const byOrder = (a, b) => orderOf(a) - orderOf(b) || String(a).localeCompare(String(b));
const uid = () => `sd_${Math.random().toString(36).slice(2, 8)}`;

/**
 * Register a studio that can receive a trajectory. `apply` must write the trajectory AND `link`
 * (as `doc.trajLink`) in one edit of the studio's own document.
 * 궤적을 받을 수 있는 스튜디오 등록. apply는 궤적과 link를 한 번의 편집으로 기록.
 */
export function registerTrajectoryTarget(studioId, target) {
  targets.set(studioId, target);
}

/** Register a studio whose pitch lines can be sent. `lines(doc)` gets the studio's (instance) document. */
export function registerTrajectorySource(studioId, source) {
  sources.set(studioId, source);
}

export const isTrajectoryTarget = (studioId) => targets.has(studioId);
export const isTrajectorySource = (studioId) => sources.has(studioId);
export const listSendTargets = () => [...targets.keys()].sort(byOrder);
export const listSendSources = () => [...sources.keys()].sort(byOrder);

// ==========================================================================
// Trajectories / 궤적
// ==========================================================================

/** Voice fields that do not change the pitch trajectory. / 궤적 모양과 무관한 보이스 필드 */
const NON_SHAPE = new Set(['id', 'name', 'color', 'solo', 'muted', 'baseGain', 'gainUnit', 'gainMode', 'gainPoints', 'gainEngineObj',
  'timbre', 'timbreMode', 'timbreFunc', 'timbreSample', 'tremolo', 'dbTaper', 'dbMin']);

/** Signature of everything that shapes a voice's trajectory (curve, pitch ends, timing). / 모양 시그니처 */
export function trajectorySignature(voice) {
  if (!voice) return '';
  const o = {};
  for (const k of Object.keys(voice).sort()) if (!NON_SHAPE.has(k)) o[k] = voice[k];
  return JSON.stringify(o);
}

/**
 * Sample a voice into a studio-neutral trajectory (MIDI over normalised time).
 * 보이스를 스튜디오 중립 궤적(정규화 시간 위의 MIDI)으로 표본화.
 * @returns {{ voiceId, voiceIndex, name, color, startTime, duration, pts: {u:number, midi:number}[], midiLo, midiHi }}
 */
export function voiceTrajectory(voice, { samples = TRAJ_SAMPLES, voices = appState.voices } = {}) {
  const pts = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const midi = getVoiceMidiAtNormT(voice, u);
    pts.push({ u, midi });
    lo = Math.min(lo, midi);
    hi = Math.max(hi, midi);
  }
  return {
    voiceId: voice.id,
    voiceIndex: Math.max(0, voices.findIndex((v) => v.id === voice.id)),
    name: voice.name,
    color: voice.color,
    startTime: voice.startTime,
    duration: voice.duration,
    pts,
    midiLo: lo,
    midiHi: hi,
  };
}

/** Pitch at normalised time u (linear between samples). / 정규화 시간 u의 음고 */
export function trajectoryMidiAt(traj, u) {
  const p = traj.pts;
  if (u <= p[0].u) return p[0].midi;
  if (u >= p[p.length - 1].u) return p[p.length - 1].midi;
  let a = 0;
  let b = p.length - 1;
  while (b - a > 1) { const m = (a + b) >> 1; if (p[m].u <= u) a = m; else b = m; }
  const f = (u - p[a].u) / Math.max(1e-12, p[b].u - p[a].u);
  return p[a].midi + f * (p[b].midi - p[a].midi);
}

function withRange(traj) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const q of traj.pts) { lo = Math.min(lo, q.midi); hi = Math.max(hi, q.midi); }
  return { ...traj, midiLo: lo, midiHi: hi };
}

/**
 * A pitch line in document seconds ({ t, m } points, any spacing, NaN gaps allowed) → trajectory.
 * 문서 시간의 음고 선 → 궤적 (균등 표본).
 */
export function lineToTrajectory(line, { samples = TRAJ_SAMPLES } = {}) {
  const raw = (line?.pts || []).filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m)).sort((a, b) => a.t - b.t);
  if (raw.length < 2) return null;
  const t0 = raw[0].t;
  const t1 = raw[raw.length - 1].t;
  if (!(t1 - t0 > 1e-4)) return null;
  const pts = [];
  let j = 0;
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const t = t0 + u * (t1 - t0);
    while (j < raw.length - 2 && raw[j + 1].t < t) j++;
    const a = raw[j];
    const b = raw[j + 1];
    const f = clamp((t - a.t) / Math.max(1e-12, b.t - a.t), 0, 1);
    pts.push({ u, midi: a.m + f * (b.m - a.m) });
  }
  return withRange({ name: line.name || '', color: line.color || null, startTime: Math.max(0, t0), duration: t1 - t0, pts });
}

/** Mean of every line sounding at each moment (union of their spans). / 그 순간 울리는 선들의 평균 */
export function meanLine(lines, { samples = 240 } = {}) {
  const ok = (lines || []).map((l) => (l.pts || []).filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m)).sort((a, b) => a.t - b.t)).filter((p) => p.length >= 2);
  if (!ok.length) return null;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const p of ok) { t0 = Math.min(t0, p[0].t); t1 = Math.max(t1, p[p.length - 1].t); }
  if (!(t1 > t0)) return null;
  const at = (p, t) => {
    if (t < p[0].t || t > p[p.length - 1].t) return NaN;
    let a = 0;
    let b = p.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (p[m].t <= t) a = m; else b = m; }
    const f = (t - p[a].t) / Math.max(1e-12, p[b].t - p[a].t);
    return p[a].m + f * (p[b].m - p[a].m);
  };
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = t0 + (i / samples) * (t1 - t0);
    let s = 0;
    let n = 0;
    for (const p of ok) { const m = at(p, t); if (Number.isFinite(m)) { s += m; n++; } }
    if (n) pts.push({ t, m: s / n });
  }
  return { key: MEAN_LINE, name: null, pts };
}

/**
 * Reduce a trajectory to at most `maxPoints` breakpoints, normalised to y ∈ [0, 1] between
 * `lo` and `hi` MIDI (a flat line gets a ±6 st range). Ends are always kept (x = 0 and x = 1).
 * 궤적을 최대 maxPoints개의 꺾은점으로 줄이고 lo…hi MIDI 사이 y ∈ [0, 1]로 정규화.
 * @returns {{ lo:number, hi:number, points: {x:number, y:number}[] }}
 */
export function trajectoryBreakpoints(traj, { maxPoints = 32, minGap = 0.01, lo = null, hi = null } = {}) {
  let a = lo ?? traj.midiLo;
  let b = hi ?? traj.midiHi;
  if (b - a < 0.5) { const c = 0.5 * (a + b); a = c - 6; b = c + 6; }
  const span = b - a;
  const raw = traj.pts.map((p) => ({ x: p.u, y: (p.midi - a) / span }));
  let eps = 0.002;
  let out = raw;
  for (let k = 0; k < 40; k++) {
    out = rdpSimplify(raw, eps);
    if (out.length <= maxPoints) break;
    eps *= 1.6;
  }
  if (out.length > maxPoints) out = Array.from({ length: maxPoints }, (_, i) => raw[Math.round((i * (raw.length - 1)) / (maxPoints - 1))]);
  // strictly increasing x with a minimum gap / x는 최소 간격을 둔 단조 증가
  const pts = [];
  for (const p of out) {
    const x = clamp(p.x, 0, 1);
    if (pts.length && x - pts[pts.length - 1].x < minGap && x < 1) continue;
    pts.push({ x: Number(x.toFixed(4)), y: Number(p.y.toFixed(4)) });
  }
  if (pts.length >= 2 && pts[pts.length - 1].x < 1) pts[pts.length - 1] = { x: 1, y: Number(raw[raw.length - 1].y.toFixed(4)) };
  if (pts.length >= 2 && 1 - pts[pts.length - 2].x < minGap && pts.length > 2) pts.splice(pts.length - 2, 1);
  pts[0].x = 0;
  return { lo: a, hi: b, points: pts };
}

/**
 * Combine one more received line into the line so far (see header: replace / add).
 * 받은 선 하나를 지금까지의 선에 합성.
 */
export function composeTrajectory(base, src, mode = 'replace') {
  if (!src) return base;
  if (!base || mode !== 'add') return withRange({ ...src, pts: src.pts.map((p) => ({ ...p })) });
  const s0 = src.pts[0].midi;
  return withRange({ ...base, pts: base.pts.map((p) => ({ u: p.u, midi: p.midi + trajectoryMidiAt(src, p.u) - s0 })) });
}

/** Short hash (FNV-1a, 2 × 32 bit) of what a receiving studio was written with. / 쓴 내용의 짧은 해시 */
function hashText(str) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
const trajSig = (traj, extra = '') => `${extra}#${hashText(`${traj.startTime.toFixed(3)}|${traj.duration.toFixed(3)}|${traj.pts.map((p) => p.midi.toFixed(2)).join(',')}`)}`;

// ==========================================================================
// Source lines / 보낼 수 있는 선
// ==========================================================================

/** Document of a studio for reading lines: an instance's (stored or live) or the editor's. / 선을 읽을 문서 */
export function sourceDoc(studio, instId = null, state = appState) {
  const inst = instId ? getInstance(instId) : null;
  if (inst && inst.studio === studio && !isFocused(inst)) return getInstanceDoc(inst);
  if (studio === 'glissando') return { voices: state.voices, activeVoiceId: state.activeVoiceId };
  return state.studioParams?.[studio] ?? null;
}

/** Pitch lines a studio offers (plus "mean" when it has two or more). / 스튜디오가 내보낼 수 있는 선 */
export function listSourceLines(studio, instId = null) {
  const src = sources.get(studio);
  if (!src) return [];
  let lines = [];
  try {
    lines = (src.lines(sourceDoc(studio, instId)) || []).filter((l) => l && l.key != null && Array.isArray(l.pts) && l.pts.length >= 2);
  } catch (err) {
    console.error(`[Flexatone] send source ${studio} failed:`, err);
    return [];
  }
  if (lines.length >= 2 && !lines.some((l) => l.key === MEAN_LINE)) {
    const mean = meanLine(lines);
    if (mean && mean.pts.length >= 2) lines.push(mean);
  }
  return lines;
}

/** Trajectory of one source line, or null when it no longer exists. / 원본 선의 궤적 (없으면 null) */
export function sourceTrajectory(from) {
  if (!from) return null;
  const line = listSourceLines(from.studio, from.inst).find((l) => String(l.key) === String(from.line));
  return line ? lineToTrajectory(line) : null;
}

registerTrajectorySource('glissando', {
  lines: (doc) => (doc?.voices || []).filter((v) => v.duration > 0.02).map((v) => {
    const pts = [];
    for (let i = 0; i <= TRAJ_SAMPLES; i++) pts.push({ t: v.startTime + (i / TRAJ_SAMPLES) * v.duration, m: getVoiceMidiAtNormT(v, i / TRAJ_SAMPLES) });
    return { key: v.id, name: v.name, color: v.color, pts };
  }),
});

// ==========================================================================
// Send list / 보내기 목록
// ==========================================================================

function normalizeSend(raw) {
  if (!raw || typeof raw !== 'object' || !raw.from || typeof raw.from.studio !== 'string') return null;
  const to = raw.to === MASTER || typeof raw.to === 'string' ? raw.to : null;
  if (!to) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    from: { studio: raw.from.studio, line: raw.from.line == null ? '' : String(raw.from.line), name: String(raw.from.name ?? ''), inst: typeof raw.from.inst === 'string' ? raw.from.inst : null },
    to,
    mode: SEND_MODES.includes(raw.mode) ? raw.mode : 'replace',
    on: raw.on !== false,
    except: Array.isArray(raw.except) ? raw.except.filter((x) => typeof x === 'string') : [],
    bound: raw.bound && typeof raw.bound === 'object' ? { ...raw.bound } : {},
    locked: raw.from.studio === 'glissando' ? !!raw.locked : false,
    sig: typeof raw.sig === 'string' ? raw.sig : '',
  };
}

/** The sends of the project, in list order (normalised copies). / 보내기 목록 (정규화 사본) */
export function getSends(state = appState) {
  const list = state.studioParams?.[SENDS_KEY]?.list;
  return Array.isArray(list) ? list.map(normalizeSend).filter(Boolean) : [];
}

function setSendList(list) {
  dispatch({
    type: 'sends/list',
    silent: true,
    mutate: (s) => { s.studioParams = { ...(s.studioParams || {}), [SENDS_KEY]: { list: deepClone(list) } }; },
  });
}

/**
 * Change the send list and re-evaluate in ONE undo step. `fn(list)` edits a copy (may return a value).
 * 보내기 목록 변경 + 재평가를 한 번의 실행 취소 단계로.
 */
export function editSends(fn, { history = true, type = 'sends/edit' } = {}) {
  const list = getSends();
  const result = fn(list);
  setSendList(list.map(normalizeSend).filter(Boolean));
  evaluateSends();
  dispatch({ type, history, scope: ['all', 'sends'] });
  return result;
}

const receiverInst = (studio) => getFocusedId(studio);

/** Expanded receivers of one send (without the loop check). / 보내기 하나의 받는 스튜디오들 */
export function sendReceivers(send) {
  if (send.to === MASTER) return listSendTargets().filter((s) => s !== send.from.studio && !send.except.includes(s));
  return targets.has(send.to) ? [send.to] : [];
}

/**
 * The routing plan: every edge with its status, the stage of every studio and the evaluation order.
 * edge.status: 'ok' | 'loop' (would close a cycle) | 'off' (send switched off) | 'self' | 'away'
 * ('away' = the receiving instance bound to this send is not in the editor).
 * 라우팅 계획: 간선과 상태, 스튜디오별 단계, 평가 순서.
 */
export function buildSendPlan(state = appState) {
  const sends = getSends(state);
  const adj = new Map(); // applied edges: from → Set(to)
  const reach = (a, b) => { // is b reachable from a? / a에서 b로 갈 수 있나
    const seen = new Set();
    const stack = [a];
    while (stack.length) {
      const x = stack.pop();
      if (x === b) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of adj.get(x) || []) stack.push(y);
    }
    return false;
  };
  const edges = [];
  sends.forEach((send, index) => {
    const from = send.from.studio;
    const list = send.to === MASTER ? listSendTargets().filter((s) => s !== from) : [send.to];
    for (const to of list) {
      const e = { send, sendId: send.id, index, from, to, line: send.from.line, mode: send.mode, viaMaster: send.to === MASTER, status: 'ok', path: null };
      if (!targets.has(to)) continue;
      if (to === from) e.status = 'self';
      else if (send.except.includes(to)) continue;
      else if (!send.on) e.status = 'off';
      else if (reach(to, from)) { e.status = 'loop'; e.path = loopPath(adj, to, from); }
      else {
        const bound = send.bound[to];
        const focused = receiverInst(to);
        if (bound && focused && bound !== focused) e.status = 'away';
        if (!adj.has(from)) adj.set(from, new Set());
        adj.get(from).add(to); // the edge still orders the studios / 단계 계산에는 포함
      }
      edges.push(e);
    }
  });
  // stages: longest path over the applied edges / 단계: 적용된 간선 위의 최장 경로
  const nodes = new Set();
  for (const e of edges) { nodes.add(e.from); nodes.add(e.to); }
  const stage = new Map();
  const ins = new Map();
  for (const e of edges) if (e.status === 'ok' || e.status === 'away') { if (!ins.has(e.to)) ins.set(e.to, new Set()); ins.get(e.to).add(e.from); }
  const level = (n, guard = 0) => {
    if (stage.has(n)) return stage.get(n);
    if (guard > 64) return 0;
    let L = 0;
    for (const f of ins.get(n) || []) L = Math.max(L, level(f, guard + 1) + 1);
    stage.set(n, L);
    return L;
  };
  for (const n of nodes) level(n);
  const order = [...nodes].sort((a, b) => stage.get(a) - stage.get(b) || byOrder(a, b));
  const inbound = new Map();
  for (const e of edges) {
    if (!inbound.has(e.to)) inbound.set(e.to, []);
    inbound.get(e.to).push(e);
  }
  return { sends, edges, stage, order, inbound };
}

function loopPath(adj, a, b) {
  // a → … → b over applied edges (for the warning text) / 경고 문구용 경로
  const prev = new Map([[a, null]]);
  const queue = [a];
  while (queue.length) {
    const x = queue.shift();
    if (x === b) break;
    for (const y of adj.get(x) || []) if (!prev.has(y)) { prev.set(y, x); queue.push(y); }
  }
  if (!prev.has(b)) return null;
  const path = [];
  for (let x = b; x != null; x = prev.get(x)) path.unshift(x);
  return path;
}

// ==========================================================================
// Receive records / 받기 기록
// ==========================================================================

/** The receive record stored in a studio's document, or null. / 스튜디오 문서의 받기 기록 */
export function getTrajLink(studioId, state = appState) {
  const link = state.studioParams?.[studioId]?.trajLink;
  return link && typeof link === 'object' && (Array.isArray(link.sends) || typeof link.voiceId === 'string') ? link : null;
}

function writeLink(studioId, link) {
  if (studioId === 'glissando') {
    dispatch({ type: 'sends/link', mutate: (s) => { s.studioParams = { ...(s.studioParams || {}), glissando: { ...(s.studioParams?.glissando || {}), trajLink: link } }; } });
    return;
  }
  StudioRegistry.setParams(studioId, { trajLink: link }, { history: false });
}

/** Id of the Glissando voice that is written by sends (not protected by a lock). / 보내기가 쓰는 보이스 */
export function receivedVoiceId(state = appState) {
  return getTrajLink('glissando', state)?.voiceId || null;
}

// ==========================================================================
// Evaluation / 평가
// ==========================================================================

let evaluating = false;
let lastMissing = new Set();
/** True while sends are being written (subscribers should not react). / 평가 중 */
export const isEvaluatingSends = () => evaluating;
/** Edges whose source line did not exist at the last evaluation ("sendId>to"). / 원본 선이 없는 간선 */
export const missingSendEdges = () => lastMissing;

/** Old projects: `trajLink = { voiceId, locked, sig }` in a receiving doc → a Glissando send. */
function migrateLegacyLinks() {
  const adopt = [];
  let list = null;
  for (const to of targets.keys()) {
    const link = getTrajLink(to);
    if (!link || Array.isArray(link.sends) || typeof link.voiceId !== 'string') continue;
    list = list || getSends();
    const send = normalizeSend({ from: { studio: 'glissando', line: link.voiceId, name: link.voiceName || '' }, to, mode: 'replace', locked: !!link.locked, sig: link.sig || '', bound: { [to]: receiverInst(to) } });
    list.push(send);
    adopt.push({ to, send, link });
  }
  if (!list) return null;
  setSendList(list);
  return adopt;
}

function composeInbound(edges, missing) {
  let traj = null;
  for (const e of edges) {
    const src = sourceTrajectory(e.send.from);
    if (!src) { missing.add(`${e.sendId}>${e.to}`); continue; }
    traj = composeTrajectory(traj, src, e.mode);
  }
  return traj;
}

/**
 * Write every receiving studio whose combined line changed, in stage order. No undo step of its own
 * (`sig` makes it self-healing after undo / redo). Returns the studios written.
 * 단계 순서대로, 합성 선이 바뀐 받는 스튜디오를 다시 씀 (자체 실행 취소 단계 없음).
 */
export function evaluateSends({ force = false } = {}) {
  if (evaluating) return [];
  evaluating = true;
  const done = [];
  try {
    const adopted = migrateLegacyLinks();
    const plan = buildSendPlan();
    const missing = new Set();
    const bindings = [];
    for (const to of plan.order) {
      const target = targets.get(to);
      if (!target) continue;
      const edges = (plan.inbound.get(to) || []).filter((e) => e.status === 'ok');
      const link = getTrajLink(to);
      if (!edges.length) {
        const stillAway = (plan.inbound.get(to) || []).some((e) => e.status === 'away');
        if (link && Array.isArray(link.sends) && !stillAway) { writeLink(to, null); done.push(to); }
        continue;
      }
      const traj = composeInbound(edges, missing);
      if (!traj) continue;
      const ids = edges.map((e) => `${e.sendId}:${e.mode}`).join(',');
      const sig = trajSig(traj, ids);
      const legacy = adopted?.find((x) => x.to === to);
      if (legacy) { // keep what an old project shows; follow from now on / 예전 프로젝트는 그대로 두고 이후부터 따라감
        const { voiceId, voiceName, locked, sig: _old, ...keep } = legacy.link;
        writeLink(to, { ...keep, sends: edges.map((e) => e.sendId), sig });
        continue;
      }
      for (const e of edges) if (!e.send.bound[to]) bindings.push({ id: e.sendId, to, inst: receiverInst(to) });
      if (!force && link && link.sig === sig) continue;
      const keep = link && Array.isArray(link.sends) ? link : {};
      target.apply(traj, { history: false, link: { ...keep, sends: edges.map((e) => e.sendId), sig } });
      done.push(to);
    }
    if (bindings.some((b) => b.inst)) { // first write binds the receiving instance / 처음 쓴 인스턴스에 묶음
      const list = getSends();
      for (const b of bindings) { const s = list.find((x) => x.id === b.id); if (s && b.inst) s.bound[b.to] = b.inst; }
      setSendList(list);
    }
    lastMissing = missing;
  } catch (err) {
    console.error('[Flexatone] send evaluation failed:', err);
  } finally {
    evaluating = false;
  }
  return done;
}

/** Kept name (older callers). / 예전 이름 */
export const syncTrajectoryLinks = () => evaluateSends();

// ==========================================================================
// Actions / 액션
// ==========================================================================

/**
 * Add a send. Returns { ok, id, reason?, loops? }. A direct send that would close a loop is refused;
 * a Master send skips the receivers that would (they show as "loop").
 * 보내기 추가. 순환을 만드는 직접 보내기는 거부, 마스터 보내기는 해당 대상만 건너뜀.
 */
export function addSend({ from, to, mode = 'replace', locked } = {}) {
  if (!from || !sources.has(from.studio)) return { ok: false, reason: 'source' };
  if (to !== MASTER && !targets.has(to)) return { ok: false, reason: 'target' };
  if (to === from.studio) return { ok: false, reason: 'self' };
  const send = normalizeSend({
    from: { ...from, inst: from.inst || getFocusedId(from.studio) || null },
    to, mode,
    locked: from.studio === 'glissando' && from.line !== receivedVoiceId() ? (locked ?? true) : false,
  });
  if (send.locked) send.sig = trajectorySignature(getVoiceById(send.from.line));
  const trial = buildSendPlan({ ...appState, studioParams: { ...appState.studioParams, [SENDS_KEY]: { list: [...getSends(), send] } } });
  const mine = trial.edges.filter((e) => e.sendId === send.id);
  const loops = mine.filter((e) => e.status === 'loop');
  if (to !== MASTER && loops.length) return { ok: false, reason: 'loop', path: loops[0].path };
  editSends((list) => { list.push(send); }, { type: 'sends/add' });
  return { ok: true, id: send.id, loops: loops.map((e) => e.to) };
}

/** Change mode / on / to / except of a send. / 보내기 설정 변경 */
export function setSend(id, patch) {
  return editSends((list) => {
    const s = list.find((x) => x.id === id);
    if (!s) return false;
    if (patch.mode && SEND_MODES.includes(patch.mode)) s.mode = patch.mode;
    if (patch.on !== undefined) s.on = !!patch.on;
    if (Array.isArray(patch.except)) s.except = patch.except;
    return true;
  }, { type: 'sends/set' });
}

export function removeSend(id) {
  return editSends((list) => {
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list.splice(i, 1);
    return i >= 0;
  }, { type: 'sends/remove' });
}

/**
 * Move a send one place up (dir −1) or down (+1) among the sends a studio receives: it is moved in the
 * list to just before / after its neighbour there. / 받는 스튜디오 안에서 한 칸 위·아래로
 */
export function moveInbound(to, sendId, dir) {
  const plan = buildSendPlan();
  const ids = (plan.inbound.get(to) || []).map((e) => e.sendId);
  const i = ids.indexOf(sendId);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= ids.length) return false;
  const other = ids[j];
  return editSends((list) => {
    const from = list.findIndex((x) => x.id === sendId);
    const [s] = list.splice(from, 1);
    const at = list.findIndex((x) => x.id === other);
    list.splice(dir < 0 ? at : at + 1, 0, s);
    return true;
  }, { type: 'sends/move' });
}

/** Move a send to a list position (the order tool's drag). / 목록 위치로 이동 */
export function moveSendTo(sendId, index) {
  return editSends((list) => {
    const from = list.findIndex((x) => x.id === sendId);
    if (from < 0) return false;
    const [s] = list.splice(from, 1);
    list.splice(clamp(index, 0, list.length), 0, s);
    return true;
  }, { type: 'sends/move' });
}

/**
 * Import (receive) a Glissando voice into a studio: a send voice → studio. New links start locked.
 * 글리산도 보이스를 스튜디오로 불러오기 (= 보이스 → 스튜디오 보내기). 새 연결은 잠금 상태.
 */
export function importTrajectory(studioId, voice, { locked = true } = {}) {
  if (!targets.has(studioId)) return { ok: false, reason: 'target' };
  if (!voice) return { ok: false, reason: 'voice' };
  return addSend({ from: { studio: 'glissando', line: voice.id, name: voice.name }, to: studioId, mode: 'replace', locked });
}

/** Stop a studio from receiving: direct sends go, Master sends skip it. Its line stays. / 받기 해제 */
export function unlinkTrajectory(studioId) {
  const plan = buildSendPlan();
  const ids = new Set((plan.inbound.get(studioId) || []).map((e) => e.sendId));
  if (!ids.size && !getTrajLink(studioId)) return false;
  editSends((list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (!ids.has(s.id)) continue;
      if (s.to === MASTER) s.except = [...new Set([...s.except, studioId])];
      else list.splice(i, 1);
    }
  }, { type: 'sends/unlink' });
  return true;
}

// --- Glissando voice locks / 글리산도 보이스 잠금 ---------------------------

/** Every studio that receives this Glissando voice: [{ studio, link: send }]. / 이 보이스를 받는 스튜디오 */
export function linksOfVoice(voiceId, state = appState) {
  const out = [];
  const seen = new Set();
  for (const e of buildSendPlan(state).edges) {
    if (e.from !== 'glissando' || e.line !== voiceId || e.status === 'loop' || e.status === 'self' || seen.has(e.to)) continue;
    seen.add(e.to);
    out.push({ studio: e.to, link: e.send });
  }
  return out;
}

/** Ids of the Glissando voices that are sent somewhere. / 보내지고 있는 보이스 id */
export function linkedVoiceIds(state = appState) {
  const ids = new Set();
  for (const s of getSends(state)) if (s.from.studio === 'glissando' && sendReceivers(s).length) ids.add(s.from.line);
  return ids;
}

/** Lock (protect) or unlock (linked editing) every send of a voice. / 보이스의 모든 보내기 잠금·해제 */
export function setVoiceLinksLocked(voiceId, locked) {
  const sig = trajectorySignature(getVoiceById(voiceId));
  if (voiceId === receivedVoiceId()) return 0;
  return editSends((list) => {
    let n = 0;
    for (const s of list) {
      if (s.from.studio !== 'glissando' || s.from.line !== voiceId || !!s.locked === !!locked) continue;
      s.locked = !!locked;
      s.sig = sig || s.sig; // re-locking adopts the current shape / 다시 잠그면 현재 모양이 보호 대상
      n++;
    }
    return n;
  }, { type: 'sends/lock' });
}

/** Locked sends whose voice no longer matches its protected shape: [{ studio, link, voice }]. */
export function findLockedViolations(state = appState) {
  const out = [];
  const managed = receivedVoiceId(state);
  for (const s of getSends(state)) {
    if (s.from.studio !== 'glissando' || !s.locked || s.from.line === managed) continue;
    if (s.from.inst && getFocusedId('glissando') && s.from.inst !== getFocusedId('glissando')) continue; // another instance / 다른 인스턴스
    const voice = state.voices.find((v) => v.id === s.from.line);
    if (voice && trajectorySignature(voice) !== s.sig) out.push({ studio: sendReceivers(s)[0] || s.to, link: s, voice });
  }
  return out;
}

registerSelfCheck('Trajectory link: signature ignores sound fields, breakpoints keep the ends and the budget', (a) => {
  const v = createDefaultVoice(0, { f0Midi: 48, f1Midi: 72 });
  const s0 = trajectorySignature(v);
  const sound = deepClone(v);
  sound.name = 'renamed';
  sound.baseGain = 0.3;
  sound.timbre.saw = 1;
  sound.muted = true;
  a.equal(trajectorySignature(sound), s0, 'name / gain / timbre / mute do not count as a shape change');
  const shape = deepClone(v);
  shape.duration += 1;
  a.ok(trajectorySignature(shape) !== s0, 'duration is part of the shape');
  const traj = voiceTrajectory(v, { voices: [v] });
  a.equal(traj.pts.length, 129);
  a.near(traj.pts[0].midi, 48, 0.01, 'starts at F0');
  a.near(traj.pts[128].midi, 72, 0.01, 'ends at F1');
  for (const max of [9, 32]) {
    const bp = trajectoryBreakpoints(traj, { maxPoints: max });
    a.ok(bp.points.length >= 2 && bp.points.length <= max, `≤ ${max} breakpoints (${bp.points.length})`);
    a.ok(bp.points[0].x === 0 && bp.points[bp.points.length - 1].x === 1, 'ends kept');
    a.ok(bp.points.every((p, i) => i === 0 || p.x > bp.points[i - 1].x), 'x strictly increasing');
    a.near(bp.lo + bp.points[0].y * (bp.hi - bp.lo), 48, 0.05, 'first breakpoint = F0');
    a.near(bp.lo + bp.points[bp.points.length - 1].y * (bp.hi - bp.lo), 72, 0.05, 'last breakpoint = F1');
  }
  const flat = trajectoryBreakpoints({ pts: [{ u: 0, midi: 60 }, { u: 1, midi: 60 }], midiLo: 60, midiHi: 60 });
  a.ok(flat.hi - flat.lo >= 1 && Math.abs(flat.points[0].y - 0.5) < 1e-6, 'flat line gets a range around it');
  // lines → trajectory, mean, compose / 선 → 궤적, 평균, 합성
  const ln = lineToTrajectory({ pts: [{ t: 2, m: 60 }, { t: 3, m: NaN }, { t: 4, m: 64 }] });
  a.ok(ln && ln.pts.length === 129, 'line resampled');
  a.near(ln.startTime, 2, 1e-9, 'line start');
  a.near(ln.duration, 2, 1e-9, 'line length');
  a.near(trajectoryMidiAt(ln, 0.5), 62, 1e-6, 'NaN gap bridged');
  const mean = meanLine([{ pts: [{ t: 0, m: 60 }, { t: 2, m: 60 }] }, { pts: [{ t: 1, m: 70 }, { t: 2, m: 70 }] }]);
  a.near(mean.pts[0].m, 60, 1e-9, 'mean = the only sounding line');
  a.near(mean.pts[mean.pts.length - 1].m, 65, 1e-9, 'mean of two');
  const rise = lineToTrajectory({ pts: [{ t: 0, m: 50 }, { t: 1, m: 62 }] });
  const add = composeTrajectory(ln, rise, 'add');
  a.near(add.pts[0].midi, 60, 1e-6, 'add keeps the base start');
  a.near(add.pts[128].midi, 76, 1e-6, 'add = base + contour (64 + 12)');
  a.near(add.duration, 2, 1e-9, 'add keeps the base timing');
  a.near(composeTrajectory(add, rise, 'replace').pts[0].midi, 50, 1e-6, 'replace discards what came before');
}, { group: 'studio' });

registerSelfCheck('Sends: master expands, loops are cut in list order, stages put A → B before B → C, inbound order is the list order', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    const T = (to, from, extra = {}) => ({ id: `${from}>${to}`, from: { studio: from, line: 'x' }, to, ...extra });
    const plan = (list) => buildSendPlan({ ...appState, studioParams: { [SENDS_KEY]: { list } } });
    if (!['cloud', 'fractal', 'draw'].every((s) => targets.has(s))) { a.ok(true, 'targets not registered in this build'); return; }
    // A = glissando, B = cloud, C = fractal: A → B, A → C, B → C, and C listed before B → C
    let p = plan([T('cloud', 'glissando'), T('fractal', 'glissando'), T('fractal', 'cloud')]);
    a.ok(p.stage.get('glissando') === 0 && p.stage.get('cloud') === 1 && p.stage.get('fractal') === 2, 'stages 0 / 1 / 2');
    a.ok(p.order.indexOf('cloud') < p.order.indexOf('fractal'), 'B is evaluated before C');
    a.equal(p.inbound.get('fractal').map((e) => e.from).join(), 'glissando,cloud', 'C receives in list order');
    // loop: B → C then C → B → the second is cut / 순환: 뒤의 것이 잘림
    p = plan([T('fractal', 'cloud'), T('cloud', 'fractal')]);
    a.equal(p.edges.map((e) => e.status).join(), 'ok,loop', 'loop cut in list order');
    a.equal(p.edges[1].path.join('>'), 'cloud>fractal', 'loop path');
    // master: every target except the source and `except` / 마스터: 원본·제외 대상 빼고 전부
    p = plan([T(MASTER, 'cloud', { except: ['draw'] })]);
    const tos = p.edges.map((e) => e.to);
    a.ok(!tos.includes('cloud') && !tos.includes('draw') && tos.includes('fractal'), 'master expansion');
    a.ok(p.edges.every((e) => e.viaMaster), 'flagged via master');
    p = plan([T('fractal', 'cloud', { on: false })]);
    a.equal(p.edges[0].status, 'off', 'switched off');
  });
}, { group: 'studio' });
