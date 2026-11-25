/**
 * Flexatone — studios/tempo/tempo-engine.js
 * Layer 2 (studios, pure): Tempo Studio maths — tempo canons / phasing.
 * 계층 2 (순수): 템포 스튜디오 수학 — 템포 캐논 / 페이징.
 *
 * One subject S(τ), τ ∈ [0, L), is played by several voices at different tempo curves r_i(u):
 *   score position   s_i(u) = s0_i + ∫₀ᵘ r_i(x) dx          (u = piece time 0…T, r = ×speed)
 *   sound            pitch_i(u) = S(s_i(u) mod L)  (loop)  ·  silent while s_i < 0 (not entered yet)
 * `rate` has the same meaning as core/tempo.js `tempoRate` (2 = twice as fast). The Tempo Manager
 * (master × instance) would multiply on top of this: effective = managerRate × r_i(u).
 *
 * Integration: trapezoid on N = 2000 steps per voice, cached as Float64Array; inside a step the
 * rate is linear, so s(u) is the exact quadratic and the inverse (score → time) is closed-form
 * after a binary search. Constant rates take the analytic path s = s0 + r·u.
 * Everything is computed once per *timing signature* (bakeTempo) — playback only reads arrays.
 * 시그니처가 바뀔 때만 한 번 계산하고, 재생은 배열 조회만 함.
 *
 * No DOM / Audio / appState here. / DOM·오디오·appState 사용 안 함.
 */

import { clamp, roundTo, createSeededRandom, rdpSimplify } from '../../core/math-utils.js';
import { evaluateCurveObjectY, PARAM_SCHEMAS } from '../../modules/curve-engine.js';

export const RATE_MIN = 0.01;
export const RATE_MAX = 16;
export const INTEGRATION_STEPS = 2000;
export const BAKE_RATE = 400; // audio curve points per second / 오디오 곡선 샘플 속도
export const MAX_TEMPO_VOICES = 8;
export const MAX_SUBJECT_NOTES = 48;
export const LENGTH_MIN = 2;
export const LENGTH_MAX = 300;
export const ATTACK_SEC = 0.01; // note attack ramp (real seconds) / 어택 램프
export const RELEASE_SEC = 0.008; // note release ramp / 릴리즈 램프
export const STEP_RAMP_SEC = 0.01; // 'steps' bake: pitch ramp at a re-attack
export const LEGATO_RAMP_SEC = 0.06; // 'continuous' bake: glide that joins a re-attack
export const MAX_BEATS_PER_VOICE = 20000;
export const TEMPO_MODES = Object.freeze(['const', 'curve', 'converge']);
export const TEMPO_SCALES = Object.freeze(['lin', 'log']);
export const BAKE_MODES = Object.freeze(['continuous', 'steps']);
export const PULSE_KINDS = Object.freeze(['click', 'tick']);
export const SUBJECT_SOURCES = Object.freeze(['editor', 'glissandoVoice', 'curve']); // curve = a received line (trajectory send) / 받은 선
export const CURVE_ENGINES = Object.freeze(['expo', 'harmonic', 'bezier', 'plateau', 'trig', 'damped']);
export const PRESET_IDS = Object.freeze(['nancarrow', 'reich', 'fan', 'golden', 'stagger']);
export const PHI = (1 + Math.sqrt(5)) / 2;

const COLORS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#facc15', '#fb7185', '#22d3ee'];
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampRate = (r) => clamp(Number.isFinite(r) ? r : 1, RATE_MIN, RATE_MAX);

// ==========================================================================
// Document factories / 문서 팩토리
// ==========================================================================

/** Compact curve object for a tempo curve (engine + only its own params). / 템포 곡선 객체 */
export function createTempoCurve(engine = 'expo', over = {}) {
  const c = { engine: CURVE_ENGINES.includes(engine) ? engine : 'expo', reverse: false, inverse: false };
  for (const s of PARAM_SCHEMAS[c.engine] || []) if ('default' in s) c[s.key] = s.default;
  if (c.engine === 'expo') Object.assign(c, { expMode: 'exp', expK: 3 });
  if (c.engine === 'harmonic') Object.assign(c, { alpha: 57.5, x1: 0.25, x2: 0.75, symLock: true });
  if (c.engine === 'bezier') Object.assign(c, { bezX1: 0.15, bezY1: 0.85, bezX2: 0.85, bezY2: 0.15 });
  if (c.engine === 'plateau') Object.assign(c, { platTm: 0.5, platYm: 0.5, platW: 0.25 });
  if (c.engine === 'trig') Object.assign(c, { trigFn: 'sin', trigX0: 0, trigX1: 0.5, trigNorm: true, trigAmp: 1, trigBias: 0 });
  if (c.engine === 'damped') Object.assign(c, { dampC1: true, dampT0: 0.35, dampA: 0.35, dampN: 4, dampK: 2.5 });
  return Object.assign(c, over);
}

export function createTempoVoice(index = 0, over = {}) {
  const { tempo, timbre, ...rest } = over;
  return {
    id: `tv${index + 1}`,
    name: `Voice ${index + 1}`,
    color: COLORS[index % COLORS.length],
    muted: false,
    solo: false,
    start: 0,
    transpose: 0,
    octaveShift: 0,
    tempo: { mode: 'const', ratio: 1, curve: createTempoCurve('expo'), lo: 0.5, hi: 2, scale: 'log', ...(tempo || {}) },
    loop: true,
    timbre: { sine: 0.7, tri: 0.3, saw: 0.08, sqr: 0, rich: 0.1, ...(timbre || {}) },
    baseGain: 0.7,
    ...rest,
  };
}

const n = (midi, dur = 1, glide = 0) => ({ midi, dur, glide });

/** Original 12-note subject used by the canon presets (not a quotation). / 캐논용 주제 */
const CANON_SUBJECT = [n(60, 1), n(63, 0.5), n(67, 0.5), n(65, 1), n(70, 1, 0.4), n(68, 0.5), n(67, 0.5), n(63, 1), n(62, 0.5, 0.3), n(60, 0.5), n(67, 1), n(55, 2, 0.25)];
const PHASE_SUBJECT = [n(64, 0.5), n(66, 0.5), n(71, 0.5), n(73, 0.5), n(74, 0.5), n(66, 0.5), n(64, 0.5), n(73, 0.5), n(71, 0.5), n(66, 0.5), n(74, 0.5), n(73, 0.5)];
const FAN_SUBJECT = [n(57, 1), n(60, 1), n(64, 1, 0.5), n(62, 1), n(59, 1), n(55, 1, 0.5), n(57, 2)];

function baseDoc(over) {
  return {
    seed: 1,
    subject: { notes: CANON_SUBJECT.map((x) => ({ ...x })), source: 'editor', voiceIndex: 0, bpmRef: 120 },
    length: 40,
    voices: [],
    activeVoiceId: 'tv1',
    converge: { enabled: false, Tc: 30, sc: 0, ratios: [3, 4, 5], r0: 0.25, preset: 'custom' },
    phasing: { enabled: false, epsilon: 0.01 },
    pulse: { audible: true, kind: 'click', accentFirst: true, level: 0.5 },
    quantizeBake: 'continuous',
    preset: 'custom',
    ...over,
  };
}

/** The five presets. / 프리셋 5종 */
export const TEMPO_PRESETS = Object.freeze({
  nancarrow: () => baseDoc({
    preset: 'nancarrow',
    length: 40,
    // sc = 5·L (L = 5 s): every voice hits its accented loop start together at Tc / Tc에서 모든 루프 시작이 일치
    converge: { enabled: true, Tc: 30, sc: 25, ratios: [3, 4, 5], r0: 0.25, preset: 'nancarrow' },
    voices: [-12, 0, 12].map((tr, i) => createTempoVoice(i, { name: `${[3, 4, 5][i]}`, transpose: tr, tempo: { mode: 'converge' } })),
  }),
  reich: () => baseDoc({
    preset: 'reich',
    length: 45, // 2 voices × 30 loops ≤ 64 baked voices / 베이킹 64개 이내
    subject: { notes: PHASE_SUBJECT.map((x) => ({ ...x })), source: 'editor', voiceIndex: 0, bpmRef: 240 },
    phasing: { enabled: true, epsilon: 0.01 },
    pulse: { audible: true, kind: 'tick', accentFirst: true, level: 0.35 },
    voices: [0, 1].map((i) => createTempoVoice(i, { name: i ? '1+ε' : '1', timbre: { sine: 0.4, tri: 0.6, saw: 0.05, sqr: 0.05, rich: 0.25 } })),
  }),
  fan: () => baseDoc({
    preset: 'fan',
    length: 30,
    subject: { notes: FAN_SUBJECT.map((x) => ({ ...x })), source: 'editor', voiceIndex: 0, bpmRef: 120 },
    voices: [[1, 0.5, 'exp', 2], [1, 1, 'exp', 3], [1, 1.6, 'log', 3], [1, 2.4, 'exp', 5]].map(([lo, hi, mode, k], i) => createTempoVoice(i, {
      name: `→${hi}×`, transpose: [-12, 0, 7, 12][i],
      tempo: { mode: 'curve', lo, hi, scale: 'log', curve: createTempoCurve('expo', { expMode: mode, expK: k }) },
    })),
  }),
  golden: () => baseDoc({
    preset: 'golden',
    length: 30,
    subject: { notes: FAN_SUBJECT.map((x) => ({ ...x })), source: 'editor', voiceIndex: 0, bpmRef: 90 },
    voices: [1, PHI, PHI * PHI].map((r, i) => createTempoVoice(i, { name: ['1', 'φ', 'φ²'][i], transpose: [-12, 0, 12][i], tempo: { mode: 'const', ratio: roundTo(r, 6) } })),
  }),
  stagger: () => baseDoc({
    preset: 'stagger',
    length: 24,
    voices: [0, -2, -4, -6].map((s0, i) => createTempoVoice(i, { name: `+${-s0}s`, start: s0, transpose: [0, 7, 12, -12][i] })),
  }),
});

export function createDefaultTempoParams() {
  return TEMPO_PRESETS.nancarrow();
}

const SCALE_STEPS = [0, 2, 3, 5, 7, 8, 10, 12];

/** Seeded random subject (deterministic per seed). / 시드 기반 무작위 주제 */
export function randomSubjectNotes(seed = 1, count = 10) {
  const rnd = createSeededRandom(seed);
  const durs = [0.5, 0.5, 1, 1, 1, 1.5, 2];
  const out = [];
  let deg = 0;
  for (let i = 0; i < count; i++) {
    deg = clamp(deg + Math.round((rnd() - 0.5) * 5), -4, 9);
    const oct = Math.floor(deg / 7);
    const midi = 60 + 12 * oct + SCALE_STEPS[((deg % 7) + 7) % 7];
    out.push({ midi, dur: durs[Math.floor(rnd() * durs.length)], glide: rnd() < 0.25 ? roundTo(0.2 + rnd() * 0.5, 2) : 0 });
  }
  return out;
}

/** Validate a document (missing / bad fields → defaults, numbers clamped). / 문서 검증 */
export function normalizeTempoDoc(raw) {
  const d = createDefaultTempoParams();
  const o = raw && typeof raw === 'object' ? raw : {};
  const subj = { ...d.subject, ...(o.subject || {}) };
  const notes = (Array.isArray(subj.notes) ? subj.notes : d.subject.notes).slice(0, MAX_SUBJECT_NOTES).map((x) => ({
    midi: clamp(num(x?.midi, 60), 12, 120),
    dur: clamp(num(x?.dur, 1), 0.0625, 32),
    glide: clamp(num(x?.glide, 0), 0, 1),
  }));
  const voicesSrc = Array.isArray(o.voices) && o.voices.length ? o.voices : d.voices;
  const voices = voicesSrc.slice(0, MAX_TEMPO_VOICES).map((v, i) => {
    const base = createTempoVoice(i);
    const tp = { ...base.tempo, ...(v?.tempo || {}) };
    return {
      ...base,
      ...v,
      id: typeof v?.id === 'string' && v.id ? v.id : base.id,
      start: clamp(num(v?.start, 0), -LENGTH_MAX, LENGTH_MAX),
      transpose: clamp(num(v?.transpose, 0), -48, 48),
      octaveShift: clamp(Math.round(num(v?.octaveShift, 0)), -4, 4),
      baseGain: clamp(num(v?.baseGain, 0.7), 0, 1.5),
      loop: v?.loop !== false,
      muted: !!v?.muted,
      solo: !!v?.solo,
      timbre: { ...base.timbre, ...(v?.timbre || {}) },
      tempo: {
        ...tp,
        mode: TEMPO_MODES.includes(tp.mode) ? tp.mode : 'const',
        ratio: clampRate(num(tp.ratio, 1)),
        lo: clampRate(num(tp.lo, 0.5)),
        hi: clampRate(num(tp.hi, 2)),
        scale: TEMPO_SCALES.includes(tp.scale) ? tp.scale : 'log',
        curve: tp.curve && typeof tp.curve === 'object' && CURVE_ENGINES.includes(tp.curve.engine) ? tp.curve : createTempoCurve('expo'),
      },
    };
  });
  const cv = { ...d.converge, ...(o.converge || {}) };
  const ratios = (Array.isArray(cv.ratios) && cv.ratios.length ? cv.ratios : [3, 4, 5]).slice(0, MAX_TEMPO_VOICES).map((r) => clamp(num(r, 1), 0.01, 64));
  const length = clamp(num(o.length, d.length), LENGTH_MIN, LENGTH_MAX);
  return {
    ...d,
    ...o,
    seed: Math.max(1, Math.round(num(o.seed, 1))) >>> 0,
    subject: {
      notes: notes.length ? notes : d.subject.notes,
      source: SUBJECT_SOURCES.includes(subj.source) ? subj.source : 'editor',
      voiceIndex: Math.max(0, Math.round(num(subj.voiceIndex, 0))),
      bpmRef: clamp(num(subj.bpmRef, 120), 20, 480),
      curve: Array.isArray(subj.curve) ? subj.curve.filter((p) => p && Number.isFinite(Number(p.s)) && Number.isFinite(Number(p.midi))).slice(0, 512).map((p) => ({ s: Number(p.s), midi: Number(p.midi) })) : [],
      curveLen: clamp(num(subj.curveLen, 0), 0, LENGTH_MAX),
    },
    length,
    voices,
    activeVoiceId: voices.some((v) => v.id === o.activeVoiceId) ? o.activeVoiceId : voices[0].id,
    converge: { ...cv, enabled: !!cv.enabled, Tc: clamp(num(cv.Tc, 30), 0, length), sc: clamp(num(cv.sc, 0), -LENGTH_MAX * 4, LENGTH_MAX * 4), r0: clamp(num(cv.r0, 0.25), 0.001, 16), ratios },
    phasing: { enabled: !!o.phasing?.enabled, epsilon: clamp(num(o.phasing?.epsilon, 0.01), -0.2, 0.2) },
    pulse: { ...d.pulse, ...(o.pulse || {}), kind: PULSE_KINDS.includes(o.pulse?.kind) ? o.pulse.kind : d.pulse.kind, level: clamp(num(o.pulse?.level, d.pulse.level), 0, 1.5) },
    quantizeBake: BAKE_MODES.includes(o.quantizeBake) ? o.quantizeBake : 'continuous',
  };
}

// ==========================================================================
// Subject / 주제 선율
// ==========================================================================

/**
 * Subject from the note editor. dur is in beats at bpmRef; glide = fraction of the note spent
 * gliding from the previous pitch (0 = re-attack). / 노트 열 → 주제
 * @returns {{ kind:'notes', L:number, beat:number, notes:Array, attacks:number[] }}
 */
export function buildSubjectFromNotes(notes, bpmRef = 120) {
  const beat = 60 / clamp(num(bpmRef, 120), 1, 2000);
  let s = 0;
  const out = [];
  for (const x of notes || []) {
    const d = Math.max(1e-3, num(x.dur, 1) * beat);
    out.push({ s0: s, s1: s + d, midi: num(x.midi, 60), glide: clamp(num(x.glide, 0), 0, 1) });
    s += d;
  }
  if (!out.length) out.push({ s0: 0, s1: beat, midi: 60, glide: 0 });
  const L = out[out.length - 1].s1;
  // Attack onsets in a looped context (note 0 glides from the last note when glide > 0)
  const attacks = out.filter((x) => x.glide <= 0).map((x) => x.s0);
  return { kind: 'notes', L, beat, notes: out, attacks };
}

/**
 * Subject from sampled pitch points (e.g. a Glissando voice). One attack per loop at τ = 0.
 * pts: [{ s, midi }] with s ∈ [0, L]. / 샘플 곡선 → 주제
 */
export function buildSubjectFromCurve(pts, L, bpmRef = 120) {
  const beat = 60 / clamp(num(bpmRef, 120), 1, 2000);
  const len = Math.max(0.05, num(L, 1));
  const clean = (pts || []).filter((p) => Number.isFinite(p.s) && Number.isFinite(p.midi)).sort((a, b) => a.s - b.s);
  if (clean.length < 2) clean.splice(0, clean.length, { s: 0, midi: 60 }, { s: len, midi: 60 });
  return { kind: 'curve', L: len, beat, pts: clean, attacks: [0] };
}

/** MIDI of the subject at τ ∈ [0, L). `firstLoop` = no glide from a previous loop. / 주제 음고 */
export function subjectMidiAt(sub, tau, firstLoop = true) {
  if (sub.kind === 'curve') {
    const p = sub.pts;
    if (tau <= p[0].s) return p[0].midi;
    if (tau >= p[p.length - 1].s) return p[p.length - 1].midi;
    let lo = 0;
    let hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].s <= tau) lo = m; else hi = m; }
    const f = (tau - p[lo].s) / Math.max(1e-12, p[hi].s - p[lo].s);
    return p[lo].midi + f * (p[hi].midi - p[lo].midi);
  }
  const ns = sub.notes;
  const j = noteIndexAt(sub, tau);
  const nt = ns[j];
  const hasPrev = j > 0 || !firstLoop;
  if (!hasPrev || nt.glide <= 0) return nt.midi;
  const prev = j > 0 ? ns[j - 1].midi : ns[ns.length - 1].midi;
  const gl = nt.glide * (nt.s1 - nt.s0);
  const into = tau - nt.s0;
  return into >= gl ? nt.midi : prev + (into / gl) * (nt.midi - prev);
}

export function noteIndexAt(sub, tau) {
  const ns = sub.notes;
  let lo = 0;
  let hi = ns.length - 1;
  if (tau >= ns[hi].s0) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ns[m].s0 <= tau) lo = m; else hi = m; }
  return tau < ns[lo].s0 ? 0 : lo;
}

/**
 * Score distance from the last attack onset and to the next one around absolute score s.
 * loop:false → the subject end counts as the next "onset" (release). / 직전·다음 어택까지의 거리
 */
export function attackDistances(sub, s, loop) {
  const L = sub.L;
  const k = Math.floor(s / L);
  const tau = s - k * L;
  const at = sub.attacks;
  // In the first loop note 0 is always an attack (the entry). / 첫 루프의 0번 음 = 진입 어택
  const here = k === 0 && at[0] !== 0 ? [0, ...at] : at;
  let since = Infinity;
  for (let i = here.length - 1; i >= 0; i--) if (here[i] <= tau + 1e-12) { since = tau - here[i]; break; }
  if (!(since < Infinity) && at.length) since = tau + L - at[at.length - 1]; // previous loop's last attack
  let to = Infinity;
  for (let i = 0; i < here.length; i++) if (here[i] > tau + 1e-12) { to = here[i] - tau; break; }
  if (!(to < Infinity)) to = loop ? (at.length ? L + at[0] - tau : Infinity) : L - tau;
  return { since, to };
}

// ==========================================================================
// Tempo tracks: s(u) and its inverse / 악보 위치 s(u)와 역변환
// ==========================================================================

/** Rate function of one voice (×speed, clamped ≥ RATE_MIN). / 보이스 i의 템포 곡선 r_i(u) */
/**
 * Position of voice i among the lines of the document: linked pieces (🔗, core/line-clip.js) of one voice
 * count once, so cutting a voice changes neither its own tempo nor the phasing / convergence of the
 * others. / 줄 번호: 링크된 조각은 한 번만 세므로 자르기가 템포·위상·수렴을 바꾸지 않음
 */
export function voiceLineIndex(doc, i) {
  const seen = new Map();
  let n = -1;
  for (let j = 0; j <= i && j < doc.voices.length; j++) {
    const l = doc.voices[j]?.link;
    if (l?.on && seen.has(l.id)) { if (j === i) return seen.get(l.id); continue; }
    n++;
    if (l?.on) seen.set(l.id, n);
  }
  return Math.max(0, n);
}

export function voiceRateFn(doc, i) {
  const v = doc.voices[i];
  const tp = v.tempo;
  const T = doc.length;
  const li = voiceLineIndex(doc, i);
  const phase = doc.phasing?.enabled ? 1 + li * num(doc.phasing.epsilon, 0) : 1;
  if (tp.mode === 'curve') {
    const lo = clampRate(tp.lo);
    const hi = clampRate(tp.hi);
    const curve = tp.curve;
    const log = tp.scale === 'log';
    return { constRate: null, fn: (u) => {
      const c = evaluateCurveObjectY(curve, clamp(u / T, 0, 1));
      return clampRate((log ? lo * Math.pow(hi / lo, c) : lo + (hi - lo) * c) * phase);
    } };
  }
  const base = tp.mode === 'converge'
    ? convergeRatio(doc, li) * num(doc.converge?.r0, 0.25)
    : num(tp.ratio, 1);
  const r = clampRate(base * phase);
  return { constRate: r, fn: () => r };
}

/** ρ_i of the convergence canon (ratios cycle when there are more voices). */
export function convergeRatio(doc, i) {
  const rs = doc.converge?.ratios || [1];
  return num(rs[i % rs.length], 1);
}

/**
 * Integrate a rate function over [0, T] (trapezoid, N steps). cum[k] = ∫₀^{u_k} r.
 * 사다리꼴 적분.
 */
export function integrateRate(rateFn, T, N = INTEGRATION_STEPS) {
  const h = T / N;
  const r = new Float64Array(N + 1);
  const cum = new Float64Array(N + 1);
  for (let k = 0; k <= N; k++) r[k] = clampRate(rateFn(k * h));
  for (let k = 0; k < N; k++) cum[k + 1] = cum[k] + 0.5 * h * (r[k] + r[k + 1]);
  return { T, N, h, r, cum };
}

/** Build a track { s0, constRate, T, N, h, r, cum } for voice i (s0 solved for convergence). */
export function buildTrack(doc, i, { numeric = false } = {}) {
  const T = doc.length;
  const { constRate, fn } = voiceRateFn(doc, i);
  const tr = integrateRate(fn, T);
  tr.constRate = numeric ? null : constRate; // numeric: force the integrated path (self-check)
  tr.s0 = 0;
  const cv = doc.converge;
  if (cv?.enabled) {
    // Nancarrow convergence: s_i(Tc) = sc  ⇒  s0_i = sc − ∫₀^Tc r_i   (analytic for constant r)
    tr.s0 = cv.sc - (constRate !== null ? constRate * cv.Tc : integralAt(tr, cv.Tc));
  } else {
    tr.s0 = num(doc.voices[i].start, 0);
  }
  return tr;
}

/** ∫₀ᵘ r for a numeric track (exact for the piecewise-linear rate). / 구간 내 정확한 2차식 */
export function integralAt(tr, u) {
  if (tr.constRate !== null && tr.constRate !== undefined) return tr.constRate * u;
  const { N, h, r, cum } = tr;
  if (u <= 0) return u * r[0];
  if (u >= tr.T) return cum[N] + (u - tr.T) * r[N];
  const k = Math.min(N - 1, Math.floor(u / h));
  const tau = u - k * h;
  return cum[k] + tau * r[k] + (tau * tau * (r[k + 1] - r[k])) / (2 * h);
}

/** Score position s(u). / 악보 위치 */
export function evalS(tr, u) {
  return tr.s0 + integralAt(tr, u);
}

/** Rate at u. / u에서의 배속 */
export function rateAt(tr, u) {
  if (tr.constRate !== null && tr.constRate !== undefined) return tr.constRate;
  const { N, h, r } = tr;
  if (u <= 0) return r[0];
  if (u >= tr.T) return r[N];
  const k = Math.min(N - 1, Math.floor(u / h));
  return r[k] + ((u - k * h) / h) * (r[k + 1] - r[k]);
}

/** Inverse: time u at which s(u) = s (monotone, r > 0). Extrapolates outside [0, T]. / 역변환 */
export function invertS(tr, s) {
  const c = s - tr.s0;
  if (tr.constRate !== null && tr.constRate !== undefined) return c / tr.constRate;
  const { N, h, r, cum } = tr;
  if (c <= 0) return c / r[0];
  if (c >= cum[N]) return tr.T + (c - cum[N]) / r[N];
  let lo = 0;
  let hi = N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= c) lo = m; else hi = m; }
  const rem = c - cum[lo];
  const a = (r[lo + 1] - r[lo]) / (2 * h);
  const b = r[lo];
  // a τ² + b τ − rem = 0, stable root / 안정적인 근
  const tau = Math.abs(a) < 1e-15 ? rem / b : (2 * rem) / (b + Math.sqrt(Math.max(0, b * b + 4 * a * rem)));
  return lo * h + tau;
}

/** Times u ∈ [uFrom, uTo] where s(u) = k·step (k integer, s ≥ sMin). / s(u) = k·step 가 되는 시각 */
export function gridCrossings(tr, step, uFrom, uTo, { sMin = 0, sMax = Infinity, limit = MAX_BEATS_PER_VOICE } = {}) {
  const out = [];
  if (!(step > 0)) return out;
  const s0 = Math.max(sMin, evalS(tr, uFrom));
  const s1 = Math.min(sMax, evalS(tr, uTo));
  for (let k = Math.ceil(s0 / step - 1e-9); k * step <= s1 + 1e-9 && out.length < limit; k++) {
    const u = invertS(tr, k * step);
    if (u >= uFrom - 1e-9 && u <= uTo + 1e-9) out.push({ u, k });
  }
  return out;
}

// ==========================================================================
// Edit-time bake (cached by timing signature) / 에디팅 시점 베이킹 (시그니처 캐시)
// ==========================================================================

const TIMING_KEYS = ['id', 'start', 'loop'];
let cache = { key: '', result: null, count: 0, ms: 0 };

function subjectSignature(sub) {
  return sub.kind === 'curve'
    ? ['c', roundTo(sub.L, 6), sub.beat, sub.pts.map((p) => [roundTo(p.s, 5), roundTo(p.midi, 4)])]
    : ['n', sub.beat, sub.notes.map((x) => [roundTo(x.s0, 9), roundTo(x.s1, 9), x.midi, x.glide])];
}

/** Signature of every input the bake reads (timbre / gain / mute / pulse / transpose excluded). */
export function tempoSignature(doc, sub) {
  return JSON.stringify([
    doc.length, subjectSignature(sub), doc.converge, doc.phasing,
    doc.voices.map((v) => [...TIMING_KEYS.map((k) => v[k]), v.tempo, v.clip || 0]),
  ]);
}

/**
 * Bake every voice: track, audible window, loop segments, beat / loop-start times and the audio
 * curves (MIDI without transpose, gain envelope 0…1) at BAKE_RATE over [0, T].
 * 모든 보이스 베이킹 (재생은 이 배열만 읽음).
 * @param {object} doc normalized document
 * @param {object} sub subject from buildSubjectFrom*
 */
export function bakeTempo(doc, sub) {
  const key = tempoSignature(doc, sub);
  if (key === cache.key && cache.result) return cache.result;
  const t0 = (globalThis.performance || Date).now();
  const T = doc.length;
  const L = sub.L;
  const nS = Math.ceil(T * BAKE_RATE) + 1;
  const voices = doc.voices.map((v, i) => {
    const tr = buildTrack(doc, i);
    // audible window: s ≥ 0 and (loop or s < L), u ∈ [0, T] / 발음 구간
    const uOn0 = clamp(invertS(tr, 0), 0, T);
    const uOff0 = v.loop ? T : clamp(invertS(tr, L), 0, T);
    // Play range (core/line-clip.js): a part of the audible window, trim only / 재생 구간 (줄이기만)
    const cu0 = clamp(Number.isFinite(v.clip?.u0) ? v.clip.u0 : 0, 0, 1);
    const cu1 = clamp(Number.isFinite(v.clip?.u1) ? v.clip.u1 : 1, cu0, 1);
    const clipped = !!v.clip && (cu0 > 1e-9 || cu1 < 1 - 1e-9);
    const uOn = uOn0 + cu0 * (uOff0 - uOn0);
    const uOff = uOn0 + cu1 * (uOff0 - uOn0);
    const sOn = evalS(tr, uOn0);
    const sOff = evalS(tr, uOff0);
    const has = uOff - uOn > 1e-4 && sOff > 0;
    const segments = [];
    if (has) {
      for (let k = Math.max(0, Math.floor(sOn / L)); k * L < sOff - 1e-9; k++) {
        const a = Math.max(uOn0, invertS(tr, k * L));
        const b = Math.min(uOff0, invertS(tr, (k + 1) * L));
        if (b - a > 1e-6) segments.push({ k, u0: a, u1: b });
        if (!v.loop) break;
      }
    }
    const loopStarts = has ? gridCrossings(tr, L, uOn, uOff, { sMin: 0, sMax: v.loop ? Infinity : L - 1e-9 }).map((c) => c.u) : [];
    const beatCross = has ? gridCrossings(tr, sub.beat, uOn, uOff, { sMin: 0, sMax: v.loop ? Infinity : L - 1e-9 }) : [];
    const beats = new Float64Array(beatCross.length);
    const accents = new Uint8Array(beatCross.length);
    beatCross.forEach((c, j) => {
      beats[j] = c.u;
      const sc = c.k * sub.beat;
      const m = sc / L;
      accents[j] = Math.abs(m - Math.round(m)) * L < 1e-6 ? 1 : 0;
    });
    // audio curves / 오디오 곡선
    const midi = new Float32Array(nS);
    const gain = new Float32Array(nS);
    const gainAll = clipped ? new Float32Array(nS) : gain; // whole window, for the faint drawing / 연한 그리기용 전체
    let first = -1;
    for (let j = 0; j < nS; j++) {
      const u = Math.min(T, j / BAKE_RATE);
      const s = evalS(tr, u);
      if (!has || u < uOn0 - 1e-9 || u > uOff0 + 1e-9 || s < 0) { gain[j] = 0; midi[j] = NaN; continue; }
      const k = Math.floor(s / L);
      const tau = s - k * L;
      midi[j] = subjectMidiAt(sub, tau, k === 0);
      const r = rateAt(tr, u);
      const { since, to } = attackDistances(sub, s, v.loop);
      const g = Math.min(1, since / r / ATTACK_SEC) * Math.min(1, to / r / RELEASE_SEC);
      gainAll[j] = clamp(g, 0, 1);
      gain[j] = u < uOn - 1e-9 || u > uOff + 1e-9 ? 0 : gainAll[j];
      if (first < 0) first = j;
    }
    // hold pitch where silent (no glide into an entry) / 무음 구간은 음고 유지
    let last = first >= 0 ? midi[first] : 60;
    for (let j = 0; j < nS; j++) { if (Number.isNaN(midi[j])) midi[j] = last; else last = midi[j]; }
    if (first > 0) for (let j = 0; j < first; j++) midi[j] = midi[first];
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < nS; j++) if (gainAll[j] > 0) { lo = Math.min(lo, midi[j]); hi = Math.max(hi, midi[j]); }
    return { id: v.id, index: i, track: tr, uOn, uOff, uOn0, uOff0, clipped, has, segments, loopStarts, beats, accents, midi, gain, gainAll, midiLo: lo, midiHi: hi };
  });
  const result = { key, T, L, beat: sub.beat, rate: BAKE_RATE, samples: nS, voices, subject: sub, map: new Map(voices.map((b) => [b.id, b])) };
  cache = { key, result, count: cache.count + 1, ms: (globalThis.performance || Date).now() - t0 };
  return result;
}

/** How many times the bake actually ran / last bake time (ms). / 베이킹 횟수·시간 */
export function getTempoBakeCount() { return cache.count; }
export function getLastBakeMs() { return cache.ms; }

/** Linear read of a baked curve at time u. / 베이킹 곡선 선형 조회 */
export function readCurve(arr, u, rate = BAKE_RATE) {
  const x = clamp(u * rate, 0, arr.length - 1);
  const i = Math.min(arr.length - 2, Math.floor(x));
  if (i < 0) return arr[0];
  return arr[i] + (x - i) * (arr[i + 1] - arr[i]);
}

/** Pairwise phase (s_i − s_j) mod L / L ∈ [0, 1) at time u. / 위상차 */
export function phaseMatrix(bake, u) {
  const L = bake.L;
  const s = bake.voices.map((b) => evalS(b.track, u));
  return s.map((si) => s.map((sj) => { const d = (si - sj) / L; return d - Math.floor(d); }));
}

/** Circular distance of a phase to sync (0 … 0.5). / 동기까지의 원형 거리 */
export const syncDistance = (p) => Math.min(p, 1 - p);

// ==========================================================================
// Bake → Glissando voices (one per loop segment) / 루프 구간당 글리산도 보이스 하나
// ==========================================================================

/**
 * Pitch used for the Glissando conversion: 'steps' joins a re-attack with a 10 ms ramp, 'continuous'
 * with a 60 ms glide (no gap). Score ramps are converted from real seconds by the local rate.
 */
function bakeMidiAt(sub, tr, u, s, mode) {
  const L = sub.L;
  const k = Math.floor(s / L);
  const tau = s - k * L;
  const m = subjectMidiAt(sub, tau, k === 0);
  if (sub.kind !== 'notes') return m;
  const j = noteIndexAt(sub, tau);
  const nt = sub.notes[j];
  if (nt.glide > 0 || (j === 0 && k === 0)) return m;
  const prev = j > 0 ? sub.notes[j - 1].midi : sub.notes[sub.notes.length - 1].midi;
  const rampScore = (mode === 'steps' ? STEP_RAMP_SEC : LEGATO_RAMP_SEC) * rateAt(tr, u);
  const ramp = Math.min(rampScore, 0.5 * (nt.s1 - nt.s0));
  const into = tau - nt.s0;
  return into >= ramp ? m : prev + (into / Math.max(1e-9, ramp)) * (m - prev);
}

function simplifyTo(points, maxN) {
  let eps = 0.0008;
  let out = rdpSimplify(points, eps);
  while (out.length > maxN && eps < 0.5) { eps *= 1.6; out = rdpSimplify(points, eps); }
  return out;
}

/**
 * Curves of one loop segment as Glissando spline data (piecewise linear, ≤ 64 anchors).
 * @returns {{ u0, u1, mLo, mHi, customPoints, gainPoints }}
 */
export function segmentToVoiceCurves(bake, bv, seg, mode = 'continuous') {
  const sub = bake.subject;
  const tr = bv.track;
  const dur = seg.u1 - seg.u0;
  const n = clamp(Math.ceil(dur * 1000), 64, 20000);
  const raw = [];
  let mLo = Infinity;
  let mHi = -Infinity;
  for (let j = 0; j <= n; j++) {
    const u = seg.u0 + (j / n) * dur;
    const s = Math.max(seg.k * bake.L, Math.min((seg.k + 1) * bake.L - 1e-9, evalS(tr, u)));
    const m = bakeMidiAt(sub, tr, u, s, mode);
    raw.push({ x: j / n, m, s, u });
    mLo = Math.min(mLo, m);
    mHi = Math.max(mHi, m);
  }
  if (mHi - mLo < 0.5) { mHi = mLo + 1; }
  const span = mHi - mLo;
  const pitch = simplifyTo(raw.map((p) => ({ x: p.x, y: (p.m - mLo) / span })), 64);
  const customPoints = pitch.map((p) => ({ x: roundTo(p.x, 6), y: roundTo(p.y, 6), handles: [] }));
  let gainPoints;
  if (mode === 'steps' && sub.kind === 'notes') {
    const g = raw.map((p) => {
      const { since, to } = attackDistances(sub, p.s, true);
      const r = rateAt(tr, p.u);
      const atSegStart = p.u - seg.u0 < ATTACK_SEC; // the Glissando engine fades voice edges itself
      const gg = (atSegStart ? 1 : Math.min(1, since / r / ATTACK_SEC)) * (seg.u1 - p.u < RELEASE_SEC ? 1 : Math.min(1, to / r / RELEASE_SEC));
      return { x: p.x, y: clamp(gg, 0, 1) };
    });
    gainPoints = simplifyTo(g, 64).map((p) => ({ x: roundTo(p.x, 6), y: roundTo(p.y, 4), handles: [] }));
  } else {
    gainPoints = [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }];
  }
  return { u0: seg.u0, u1: seg.u1, mLo, mHi, customPoints, gainPoints };
}

/** All loop segments of all voices, in time order. / 모든 루프 구간 (시간순) */
export function listBakeSegments(bake, doc) {
  const out = [];
  for (const bv of bake.voices) for (const seg of bv.segments) if (seg.u1 - seg.u0 >= 0.05) out.push({ bv, seg, voice: doc.voices[bv.index] });
  out.sort((a, b) => a.seg.u0 - b.seg.u0 || a.bv.index - b.bv.index);
  return out;
}
