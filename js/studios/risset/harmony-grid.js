/**
 * Flexatone — studios/risset/harmony-grid.js
 * Risset Studio (pure): harmonic offset grid, Pitch ⇄ Interval parsing, pattern extraction.
 * 리세 스튜디오 (순수): 화성 오프셋 격자, 피치 ⇄ 음정 양방향 파서, 패턴 추출기.
 *
 * Offsets are semitones above the Base MIDI note (0.01 resolution). Each voice i starts at
 * phase offᵢ / span on the circular pitch space S¹. / 오프셋 = Base MIDI 위 반음 (0.01 단위)
 * No DOM. Imports core/* only.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToNoteName } from '../../core/units.js';

export const GRID_MODES = Object.freeze(['equal', 'fixed', 'ratio', 'pattern', 'custom']);
/** Just-ratio presets for the ratio grid (p:q). / 비율 격자 프리셋 */
export const RATIO_PRESETS = Object.freeze(['2:1', '3:2', '4:3', '5:4', '9:8']);
export const OFFSET_MIN = -60;
export const OFFSET_MAX = 144;
const LETTER_TO_SEMI = Object.freeze({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 });

const r2 = (x) => Math.round(Number(x) * 100) / 100;
const r4 = (x) => Math.round(Number(x) * 10000) / 10000;

/** Interval of a frequency ratio in cents: 1200·log₂(p/q) (3:2 → 701.955¢). / 비율 → 센트 */
export const ratioToCents = (p, q = 1) => 1200 * Math.log2(p / q);

/**
 * Parse a ratio list "3:2, 5:4, 7/4, 1.5" → [{ p, q, cents, label }] (null if nothing valid).
 * 비율 목록 파싱.
 */
export function parseRatioSeq(text) {
  const out = [];
  for (const tok of String(text ?? '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const m = tok.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    let p;
    let q;
    if (m) { p = Number(m[1]); q = Number(m[2]); } else if (Number.isFinite(Number(tok))) { p = Number(tok); q = 1; } else continue;
    if (!(p > 0 && q > 0) || p / q > 64 || p / q < 1 / 64) continue;
    out.push({ p, q, cents: ratioToCents(p, q), label: m ? `${p}:${q}` : `${p}` });
  }
  return out.length ? out : null;
}

/** Cent label: 701.955 → "701.96¢". / 센트 표기 */
export const formatCents = (c) => `${(Math.round(c * 100) / 100).toFixed(2)}¢`;

/**
 * 0.01 precision, decimals only when non-zero: 12 → "12", 12.5 → "12.5", 3.14159 → "3.14".
 * 0이 아닌 소수가 있을 때만 소수점 표기.
 */
export function formatClean(num) {
  const r = r2(num);
  if (!Number.isFinite(r) || Math.abs(r) < 1e-6) return '0';
  return String(r);
}

/**
 * Parse one pitch token. The first letter is the pitch class (case-insensitive); the `#` / `b`
 * characters that follow (no comma in between) are accidentals; then an optional octave
 * (default 3). Returns { midi, label } with the canonical label (upper-case letter, e.g. "Bb2").
 * 피치 토큰 파싱: 첫 알파벳 = 음이름(대문자 보정), 이어지는 #/b = 변화표, 그 뒤 옥타브.
 *   "c1" → C1 · "f#2" → F#2 · "bb2" → Bb2 · "Ebb4" → Ebb4
 */
export function parsePitchToken(rawToken) {
  const tok = String(rawToken ?? '').trim();
  if (!tok) return null;
  const letter = tok[0].toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(LETTER_TO_SEMI, letter)) return null;
  let semi = LETTER_TO_SEMI[letter];
  let rest = tok.slice(1);
  let acc = '';
  while (rest.length && (rest[0] === '#' || rest[0] === 'b' || rest[0] === 'B' || rest[0] === '♯' || rest[0] === '♭')) {
    const up = rest[0] === '#' || rest[0] === '♯';
    semi += up ? 1 : -1;
    acc += up ? '#' : 'b';
    rest = rest.slice(1);
  }
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(rest.trim());
  if (rest.trim() && !m) return null;
  const oct = m ? parseInt(m[1], 10) : 3;
  return { midi: (oct + 1) * 12 + semi, label: `${letter}${acc}${oct}` };
}

/** MIDI of a pitch token or null. / 피치 토큰의 MIDI */
export function parseNoteTokenToMidi(token) {
  return parsePitchToken(token)?.midi ?? null;
}

/** Split a comma list into trimmed, non-empty tokens. / 쉼표 목록 분리 */
const tokens = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Absolute pitch name of a fractional MIDI value, with cents when off-grid. / 절대 피치 이름 */
export function absPitchName(midi) {
  // Quarter tones are named from the lower note (C2+50¢, not C#2−50¢). / 사분음은 아래 음 기준
  const r = Math.round(midi - 1e-6);
  const cents = Math.round((midi - r) * 100);
  return cents ? `${midiToNoteName(r)}${cents > 0 ? '+' : ''}${cents}¢` : midiToNoteName(r);
}

/** Offsets → "0, 12, 24.5" (interval text). / 오프셋 → 음정 텍스트 */
export function offsetsToIntervalText(offsets) {
  return offsets.map(formatClean).join(', ');
}

/** Offsets → "C1, C2, G2" (pitch text, relative to base MIDI). / 오프셋 → 피치 텍스트 */
export function offsetsToPitchText(offsets, baseMidi) {
  return offsets.map((o) => absPitchName(baseMidi + Number(o || 0))).join(', ');
}

/** Interval text → N offsets (cycled). Null when nothing parses. / 음정 텍스트 → 오프셋 */
export function parseIntervalSeq(text, N) {
  const nums = tokens(text).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  return Array.from({ length: N }, (_, i) => clamp(r2(nums[i % nums.length]), OFFSET_MIN, OFFSET_MAX));
}

/**
 * Pitch text → { offsets, normalizedText }. Tokens are canonicalised (c1, g1, f#2, bb2 →
 * C1, G1, F#2, Bb2); invalid tokens are dropped. / 피치 텍스트 → 오프셋 + 정규화 텍스트
 */
export function parsePitchSeq(text, baseMidi, N) {
  const parsed = tokens(text).map(parsePitchToken).filter(Boolean);
  if (!parsed.length) return null;
  return {
    offsets: Array.from({ length: N }, (_, i) => clamp(r2(parsed[i % parsed.length].midi - baseMidi), OFFSET_MIN, OFFSET_MAX)),
    normalizedText: parsed.map((p) => p.label).join(', '),
  };
}

/**
 * Pattern → offsets. Interval mode: comma list of successive steps (semitones) repeated.
 * Pitch mode: the pitch list's successive intervals, anchored at its highest note.
 * 패턴 → 오프셋 (음정 모드: 연속 간격 반복 / 피치 모드: 피치 간 간격 추출, 최고음 기준).
 */
export function offsetsFromPattern(patternText, intervalMode, baseMidi, N) {
  if (intervalMode) {
    const steps = tokens(patternText).map(Number).filter(Number.isFinite);
    const safe = steps.length ? steps : [12];
    const out = [0];
    for (let i = 1; i < N; i++) out.push(r2(out[i - 1] + safe[(i - 1) % safe.length]));
    return out.map((o) => clamp(o, OFFSET_MIN, OFFSET_MAX));
  }
  const midis = tokens(patternText).map(parseNoteTokenToMidi).filter((m) => m !== null);
  if (!midis.length) return null;
  const sorted = [...midis].sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < sorted.length; i++) if (sorted[i] - sorted[i - 1] > 0) intervals.push(sorted[i] - sorted[i - 1]);
  if (!intervals.length) intervals.push(12);
  const out = [r2(Math.max(...midis) - baseMidi)];
  for (let i = 1; i < N; i++) out.push(r2(out[i - 1] + intervals[(i - 1) % intervals.length]));
  return out.map((o) => clamp(o, OFFSET_MIN, OFFSET_MAX));
}

/** Canonical pattern text (pitch tokens upper-cased). / 패턴 텍스트 정규화 */
export function normalizePatternText(text, intervalMode) {
  if (intervalMode) return tokens(text).map((t) => (Number.isFinite(Number(t)) ? formatClean(t) : t)).join(', ');
  return tokens(text).map((t) => parsePitchToken(t)?.label ?? t).join(', ');
}

/**
 * Offsets for the current grid mode. 'custom' keeps existing values (extends/truncates to N).
 * 현재 격자 모드의 오프셋 ('custom'은 기존 값 유지).
 */
export function computeOffsets(g) {
  const N = g.voiceCount;
  const span = g.spanSemitones;
  if (g.gridMode === 'equal') return Array.from({ length: N }, (_, i) => r2((i * span) / N));
  if (g.gridMode === 'fixed') return Array.from({ length: N }, (_, i) => r2((i * g.fixedStep) % span));
  if (g.gridMode === 'ratio') {
    // Stack the ratio steps (cycling), wrap into the (possibly stretched) span; 1e-4 st precision.
    // 비율 간격을 반복해 쌓고 스팬 안으로 래핑 (0.0001반음 정밀도).
    const steps = (parseRatioSeq(g.ratioText) || [{ cents: 1200 }]).map((r) => r.cents / 100);
    let acc = 0;
    return Array.from({ length: N }, (_, i) => {
      if (i > 0) acc += steps[(i - 1) % steps.length];
      return r4(((acc % span) + span) % span);
    });
  }
  if (g.gridMode === 'pattern') {
    const p = offsetsFromPattern(g.patternText, g.patternIntervalMode, g.baseMidi, N);
    if (p) return p;
  }
  return Array.from({ length: N }, (_, i) => (g.offsets?.[i] !== undefined ? clamp(Math.abs(g.offsets[i] * 100 - Math.round(g.offsets[i] * 100)) > 1e-6 ? r4(g.offsets[i]) : r2(g.offsets[i]), OFFSET_MIN, OFFSET_MAX) : r2((i * span) / N)));
}

/** Harmonic presets. / 화성 프리셋 */
export const GRID_PRESETS = Object.freeze(['octaves', 'fifths', 'fourths', 'majorThirds', 'cluster', 'overtone']);

/** Apply a preset → { gridMode, fixedStep?, offsets? }. / 프리셋 적용 */
export function presetPatch(preset, N, span) {
  const fixed = { octaves: 12, fifths: 7, fourths: 5, majorThirds: 4 }[preset];
  if (fixed) return { gridMode: 'fixed', fixedStep: fixed };
  if (preset === 'cluster') {
    const pat = [2, 4, 3, 5, 2, 6];
    let acc = 0;
    return { gridMode: 'custom', offsets: Array.from({ length: N }, (_, i) => { if (i === 0) return 0; acc = (acc + pat[(i - 1) % pat.length]) % span; return acc; }) };
  }
  if (preset === 'overtone') return { gridMode: 'custom', offsets: Array.from({ length: N }, (_, i) => r2((12 * Math.log2(i + 1)) % span)) };
  return {};
}
