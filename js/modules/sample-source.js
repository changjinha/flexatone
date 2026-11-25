/**
 * Flexatone — modules/sample-source.js
 * Layer 1 (modules, pure): the per-voice Sampler. A voice whose timbre is "Sample" plays a region of a
 * sound file instead of the additive wave; its pitch curve sets the playback rate (tape: pitch and
 * speed move together, rate = f(t) / root).
 * 계층 1 (modules, 순수): 보이스별 샘플러. 음색이 "샘플"인 보이스는 가산 파형 대신 사운드 파일의 구간을
 * 재생하며, 음고 곡선이 재생 속도를 정함 (테이프: 음높이와 속도가 함께, rate = f(t) / 루트).
 *
 *   sample spec = { id,          library entry (core/sample-library.js)
 *                   root,        MIDI note the file sounds at rate 1 (fractional allowed)
 *                   t0, t1,      region in file seconds (t1 = null → end of file)
 *                   loop,        'off' (one shot: silent after the region) | 'loop'
 *                   xfadeMs,     region edge fades; with loop, the loop crossfade
 *                   gainDb,      level trim (the file is played peak-normalised)
 *                   play,        'tape' (pitch and speed together) | 'pitch' (pitch only: the file is read at
 *                                `speed` × its own speed while the pitch curve sets the pitch — granular shift)
 *                   speed,       play speed: 'tape' = rate multiplier on top of the pitch curve (×2 = twice as
 *                                fast and an octave up, at least SAMPLE_TAPE_SPEED_MIN); 'pitch' = read speed
 *                                (1 = original, 0 = freeze), up to 4
 *                   grainMs,     grain length in 'pitch' mode (short = cleaner attacks, long = smoother tone)
 *                   envOn,       fade-in / fade-out envelope over the region on (false = only the short edge fades)
 *                   fadeInMs, fadeOutMs,  envelope lengths (shortened together when they do not fit the region)
 *                   loopOverlap }  loop + envelope: true = the fade-out overlaps the next pass's fade-in
 *                                (a crossfade; the loop is shorter by the fade-out), false = fade out, then fade in
 *
 * Where it is stored / 저장 위치 (always per voice — never studio-wide / 항상 보이스 단위):
 *   - Glissando voice:  voice.timbreMode = 'sample', voice.timbreSample = spec
 *   - studio voices (Draw stroke, Tempo voice, Space source, Field particle):
 *                       voice.timbre.mode = 'sample', voice.timbre.sample = spec
 * Synthesis code that does not know the Sampler reads 'sample' as the 5-wave Mix (old behaviour).
 *
 * Imports: core/*. No DOM / Audio APIs.
 */

import { clamp } from '../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../core/units.js';
import { registerSelfCheck } from '../core/state.js';
import { addSample, getSample, serializeSamples, loadSamples, referencedSampleIds, removeSample, _forgetSample } from '../core/sample-library.js';

export const SAMPLE_LOOP_MODES = Object.freeze(['off', 'loop']);
export const SAMPLE_XFADE_MAX_MS = 500;
export const DEFAULT_SAMPLE_ROOT = 60;
/** 'tape': rate = f / root (pitch and speed together). 'pitch': pitch only, read speed separate. */
export const SAMPLE_PLAY_MODES = Object.freeze(['tape', 'pitch']);
export const SAMPLE_SPEED_MAX = 4;
/** Tape cannot stand still (rate 0 = one frozen sample), so its speed has a floor. / 테이프 속도 하한 */
export const SAMPLE_TAPE_SPEED_MIN = 0.05;
/** Rate multiplier a tape voice plays at. / 테이프 재생 배율 */
export function sampleTapeSpeed(spec) { return Math.max(SAMPLE_TAPE_SPEED_MIN, Number(spec?.speed) || 0); }
export const SAMPLE_GRAIN_MIN_MS = 20;
export const SAMPLE_GRAIN_MAX_MS = 250;
export const SAMPLE_FADE_MAX_MS = 20000;

/** Spec with defaults filled in and values limited. / 기본값을 채우고 범위를 제한한 스펙 */
export function normalizeSampleSpec(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const num = (x, d) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : d);
  const t0 = Math.max(0, num(s.t0, 0));
  const t1raw = s.t1 === null || s.t1 === undefined ? null : num(s.t1, null);
  return {
    id: typeof s.id === 'string' ? s.id : '',
    root: clamp(num(s.root, DEFAULT_SAMPLE_ROOT), 0, 127),
    t0,
    t1: t1raw === null ? null : Math.max(t0, t1raw),
    loop: SAMPLE_LOOP_MODES.includes(s.loop) ? s.loop : 'off',
    xfadeMs: clamp(num(s.xfadeMs, 10), 0, SAMPLE_XFADE_MAX_MS),
    gainDb: clamp(num(s.gainDb, 0), -36, 24),
    play: SAMPLE_PLAY_MODES.includes(s.play) ? s.play : 'tape',
    speed: clamp(num(s.speed, 1), 0, SAMPLE_SPEED_MAX),
    grainMs: clamp(num(s.grainMs, 70), SAMPLE_GRAIN_MIN_MS, SAMPLE_GRAIN_MAX_MS),
    envOn: s.envOn === true,
    fadeInMs: clamp(num(s.fadeInMs, 50), 0, SAMPLE_FADE_MAX_MS),
    fadeOutMs: clamp(num(s.fadeOutMs, 200), 0, SAMPLE_FADE_MAX_MS),
    loopOverlap: s.loopOverlap !== false,
  };
}

/** Sample spec of a Glissando voice, or null when the voice is not a Sampler voice. / 글리산도 보이스 */
export function voiceSampleSpec(voice) {
  return voice && voice.timbreMode === 'sample' ? normalizeSampleSpec(voice.timbreSample) : null;
}

/** Sample spec of a studio timbre object (voice.timbre), or null. / 스튜디오 음색 객체 */
export function timbreSampleSpec(timbre) {
  return timbre && timbre.mode === 'sample' ? normalizeSampleSpec(timbre.sample) : null;
}

/** Short string the sound depends on (render / cache keys). / 오디오 키 */
export function sampleSpecKey(spec) {
  const s = normalizeSampleSpec(spec);
  return `${sampleRegionKey(s)}|${s.root}|${s.play}|${s.speed}|${s.grainMs}`;
}

/** Key of what the region buffer depends on (file, region, loop, fades, gain). / 구간 버퍼 키 */
export function sampleRegionKey(spec) {
  const s = normalizeSampleSpec(spec);
  const env = s.envOn ? `${s.fadeInMs},${s.fadeOutMs},${s.loop === 'loop' && s.loopOverlap ? 'o' : '-'}` : '-';
  return `${s.id}|${s.t0}|${s.t1 ?? 'end'}|${s.loop}|${s.xfadeMs}|${s.gainDb}|${env}`;
}

/** Region [a, b) in file samples, limited to the file. / 파일 샘플 단위 구간 */
export function sampleRegionFrames(spec, length, sampleRate) {
  const s = normalizeSampleSpec(spec);
  const a = clamp(Math.round(s.t0 * sampleRate), 0, Math.max(0, length - 1));
  const b = clamp(s.t1 === null ? length : Math.round(s.t1 * sampleRate), a, length);
  return { a, b };
}

/**
 * The region as a new buffer: peak-normalised (file peak → 1, then gainDb), with click-free edges.
 *  - loop 'off': fade in / out of xfadeMs at the region edges.
 *  - loop 'loop': equal-power loop crossfade — the last X frames are blended into the first X and the
 *    result is X shorter, so wrapping from the end back to the start is continuous.
 * 구간을 새 버퍼로: 파일 피크 정규화 + gainDb, 경계 클릭 제거. 루프는 등전력 크로스페이드(길이 X만큼 짧아짐).
 * @param {{ data: Float32Array, sampleRate: number, peak?: number }} entry
 * @returns {{ data: Float32Array, sampleRate: number, loop: boolean }}
 */
export function renderSampleRegion(entry, spec) {
  const s = normalizeSampleSpec(spec);
  const sr = entry.sampleRate;
  const { a, b } = sampleRegionFrames(s, entry.data.length, sr);
  const n = b - a;
  const scale = (entry.peak > 1e-6 ? 1 / entry.peak : 1) * Math.pow(10, s.gainDb / 20);
  const loop = s.loop === 'loop';
  if (n < 2) return { data: new Float32Array(2), sampleRate: sr, loop: false };
  if (s.envOn) return renderEnvelopedRegion(entry.data, a, n, sr, scale, s);
  const X = Math.min(Math.round((s.xfadeMs / 1000) * sr), loop ? Math.floor(n / 2) : Math.floor(n / 2));
  if (loop && X >= 1) {
    const out = new Float32Array(n - X);
    for (let i = 0; i < out.length; i++) out[i] = entry.data[a + i] * scale;
    for (let i = 0; i < X; i++) {
      const w = (i + 0.5) / X; // 0 → 1 across the crossfade
      const gin = Math.sin(0.5 * Math.PI * w);
      const gout = Math.cos(0.5 * Math.PI * w);
      out[i] = entry.data[a + i] * scale * gin + entry.data[a + n - X + i] * scale * gout;
    }
    return { data: out, sampleRate: sr, loop: true };
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = entry.data[a + i] * scale;
  if (!loop) {
    for (let i = 0; i < X; i++) {
      const g = i / X;
      out[i] *= g;
      out[n - 1 - i] *= g;
    }
  }
  return { data: out, sampleRate: sr, loop };
}

/**
 * Envelope lengths in frames for a region of n frames; scaled down together when they do not fit.
 * 구간 n 프레임에 맞춘 엔벨로프 길이 (안 맞으면 함께 줄임).
 */
export function sampleEnvelopeFrames(spec, n, sampleRate) {
  const s = normalizeSampleSpec(spec);
  let A = Math.round((s.fadeInMs / 1000) * sampleRate);
  let R = Math.round((s.fadeOutMs / 1000) * sampleRate);
  if (A + R > n) { const k = n / (A + R); A = Math.floor(A * k); R = Math.floor(R * k); }
  return { A, R };
}

/** Envelope gain at frame i of n (sine fade in, cosine fade out). / 엔벨로프 이득 */
function envGain(i, n, A, R) {
  let g = 1;
  if (i < A) g *= Math.sin(0.5 * Math.PI * ((i + 0.5) / A));
  const j = i - (n - R);
  if (R > 0 && j >= 0) g *= Math.cos(0.5 * Math.PI * ((j + 0.5) / R));
  return g;
}

/**
 * Region with the fade-in / fade-out envelope. Loop + overlap: the fade-out tail is laid over the
 * fade-in head and the buffer is shorter by the fade-out, so each pass crossfades into the next.
 * Loop without overlap: the whole region repeats (it fades out, then the next pass fades in).
 * 엔벨로프 구간. 루프 + 겹침: 페이드아웃 꼬리를 페이드인 머리에 겹치고 그만큼 짧아짐 (다음 회차로 크로스페이드).
 * 겹침 없음: 구간 전체가 반복 (페이드아웃 후 다음 회차 페이드인).
 */
function renderEnvelopedRegion(src, a, n, sr, scale, s) {
  const loop = s.loop === 'loop';
  const { A, R } = sampleEnvelopeFrames(s, n, sr);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = src[a + i] * scale * envGain(i, n, A, R);
  // One shot: keep the short declick on an edge whose fade is 0 / 원샷: 페이드가 0인 쪽은 짧은 클릭 제거
  if (!loop) {
    const X = Math.min(Math.round((s.xfadeMs / 1000) * sr), Math.floor(n / 2));
    for (let i = 0; i < X; i++) {
      const g = i / X;
      if (A === 0) env[i] *= g;
      if (R === 0) env[n - 1 - i] *= g;
    }
    return { data: env, sampleRate: sr, loop: false };
  }
  const O = s.loopOverlap ? Math.min(R, Math.floor(n / 2)) : 0;
  if (O < 1) return { data: env, sampleRate: sr, loop: true };
  const out = env.slice(0, n - O);
  for (let i = 0; i < O; i++) out[i] += env[n - O + i];
  return { data: out, sampleRate: sr, loop: true };
}

/**
 * Buffer seconds read while the voice plays from `fromSec` to `toSec` (document time) in tape mode:
 * ∫ f(t) / f_root dt. Used when playback starts in the middle of a voice.
 * 테이프 모드에서 fromSec→toSec 동안 읽은 버퍼 초 (보이스 중간에서 재생을 시작할 때 사용).
 * `blockSec` models a k-rate playbackRate (Web Audio updates it once per 128-frame block, holding the
 * value from the block start): the reading then lags the exact integral by ½·block·(r(to) − r(from)).
 * blockSec: k-rate 재생 속도(128프레임마다 갱신) 보정 — 정확한 적분보다 ½·block·Δr만큼 덜 읽음.
 * @param {(sec: number) => number} hzAt heard frequency at a document second
 */
export function integrateReadSec(hzAt, fromSec, toSec, rootMidi, { blockSec = 0 } = {}) {
  const span = toSec - fromSec;
  if (!(span > 0)) return 0;
  const inv = 1 / midiToFreq(rootMidi);
  const n = clamp(Math.ceil(span * 200), 4, 4000);
  let sum = 0;
  let prev = Math.max(0, Number(hzAt(fromSec)) || 0) * inv;
  for (let k = 1; k <= n; k++) {
    const r = Math.max(0, Number(hzAt(fromSec + (span * k) / n)) || 0) * inv;
    sum += 0.5 * (prev + r) * (span / n);
    prev = r;
  }
  if (blockSec > 0) sum -= 0.5 * blockSec * (prev - Math.max(0, Number(hzAt(fromSec)) || 0) * inv);
  return Math.max(0, sum);
}

/**
 * Pitch-only playback (granular shift): the file is read by a pointer that moves at `speed` × real time,
 * independent of the pitch; each grain (Hann window, 50 % overlap → the windows sum to 1) is read around
 * the pointer at the pitch ratio of its centre. One shot: silent once the pointer passes the region end;
 * loop: the pointer wraps. Each grain's read start is moved by up to ±alignSec so its waveform lines up
 * with what the previous grain would have read next (WSOLA-style search). Without it the grains overlap
 * at random phases, which smears the tone and pulls the pitch by a few per cent.
 * 각 그레인 읽기 시작점을 ±alignSec 안에서 옮겨 이전 그레인이 이어 읽었을 파형과 맞춤 (WSOLA식).
 * 음높이만 바꾸는 재생(그레인 시프트): 읽기 포인터는 음높이와 무관하게 speed × 실제 시간으로 이동하고,
 * 각 그레인(Hann 창, 50% 겹침 → 합 1)은 중심 시각의 음높이 비율로 포인터 주변을 읽음.
 * @param {{ src: Float32Array, srcRate: number, loop: boolean, outRate: number, n: number,
 *           readStartSec: number, speed: number, ratioAt: (i: number) => number, grainSec: number }} o
 *   ratioAt(i) = pitch ratio (f / f_root) at output sample i
 * @returns {Float32Array} n output samples
 */
export function renderGrainShift({ src, srcRate, loop, outRate, n, readStartSec = 0, speed = 1, ratioAt, grainSec = 0.07, alignSec = 0.015 }) {
  const out = new Float32Array(Math.max(0, n | 0));
  const len = src.length;
  if (!out.length || len < 2) return out;
  const G = Math.max(16, 2 * Math.round((grainSec * outRate) / 2));
  const hop = G / 2;
  const win = new Float32Array(G);
  for (let k = 0; k < G; k++) { const x = Math.sin((Math.PI * k) / G); win[k] = x * x; }
  const srcPerOut = srcRate / outRate;
  const read = (p) => {
    if (loop) { p %= len; if (p < 0) p += len; } else if (p < 0 || p >= len - 1) return 0;
    const j = Math.floor(p);
    const f = p - j;
    const b = j + 1 < len ? src[j + 1] : loop ? src[0] : 0;
    return src[j] + f * (b - src[j]);
  };
  // Alignment search, coarse to fine: every 4th shift on every 4th point, then ±3 on all M points
  // 정렬 탐색 (거친 → 정밀): 4샘플 간격·4점마다 비교 후 ±3을 전체 M점으로 다듬음
  const D = Math.max(0, Math.round(Math.min(alignSec, grainSec / 4) * srcRate));
  const sub = Math.max(1, Math.floor(hop / 192));
  const M = Math.floor(hop / sub);
  const tgt = new Float32Array(M);
  let prevP0 = null;
  let prevStep = 0;
  const score = (p0, step, every = 1) => {
    let c = 0;
    let e = 1e-12;
    for (let m = 0; m < M; m += every) { const x = read(p0 + m * sub * step); c += tgt[m] * x; e += x * x; }
    return c / Math.sqrt(e);
  };
  for (let g0 = -hop; g0 < out.length; g0 += hop) {
    const c = g0 + hop;
    const ptr = (readStartSec + (speed * c) / outRate) * srcRate; // pointer at the grain centre (src samples)
    if (!loop && (ptr < 0 || ptr > len)) continue;
    const r = Math.max(0, Number(ratioAt(clamp(c, 0, out.length - 1))) || 0);
    if (!(r > 0)) continue;
    const step = r * srcPerOut;
    let p0 = ptr - hop * step;
    if (D > 0 && prevP0 !== null) {
      // What the previous grain would read over this overlap / 이전 그레인이 이 겹침 구간에서 읽었을 파형
      const t0 = prevP0 + hop * prevStep;
      let energy = 0;
      for (let m = 0; m < M; m++) { tgt[m] = read(t0 + m * sub * prevStep); energy += tgt[m] * tgt[m]; }
      if (energy > 1e-9) {
        let best = -Infinity;
        let bd = 0;
        for (let d = -D; d <= D; d += 4) { const sc = score(p0 + d, step, 4); if (sc > best) { best = sc; bd = d; } }
        const c0 = bd;
        best = -Infinity;
        for (let d = c0 - 3; d <= c0 + 3; d++) { const sc = score(p0 + d, step); if (sc > best) { best = sc; bd = d; } }
        p0 += bd;
      }
    }
    prevP0 = p0;
    prevStep = step;
    const k0 = Math.max(0, -g0);
    const k1 = Math.min(G, out.length - g0);
    for (let k = k0; k < k1; k++) {
      const x = read(p0 + k * step);
      if (x) out[g0 + k] += win[k] * x;
    }
  }
  return out;
}

/**
 * Start offset inside the region buffer after reading `readSec` seconds: wrapped for a loop,
 * null when a one-shot region is already over. / 구간 버퍼의 시작 위치 (원샷이 끝났으면 null)
 */
export function regionStartOffset(readSec, regionSec, loop) {
  if (!(regionSec > 0)) return null;
  if (!(readSec > 0)) return 0;
  if (loop) return readSec % regionSec;
  return readSec < regionSec ? readSec : null;
}

/**
 * Fundamental of a region (YIN, 50–2000 Hz) as a fractional MIDI note; NaN when unpitched.
 * 구간의 기본 주파수 (YIN) → MIDI. 음고가 없으면 NaN.
 */
export function detectSampleRoot(entry, spec, { threshold = 0.15 } = {}) {
  const sr = entry.sampleRate;
  const { a, b } = sampleRegionFrames(spec, entry.data.length, sr);
  const tauMin = Math.floor(sr / 2000);
  const tauMax = Math.ceil(sr / 50);
  const W = Math.min(4096, Math.max(0, b - a - tauMax));
  if (W < 2 * tauMin + 64) return NaN;
  // Window from the loudest part of the region / 구간에서 가장 큰 부분
  const hop = Math.max(1, Math.floor(W / 2));
  let best = a;
  let bestE = -1;
  for (let s = a; s + W + tauMax <= b; s += hop) {
    let e = 0;
    for (let i = 0; i < W; i += 4) e += entry.data[s + i] * entry.data[s + i];
    if (e > bestE) { bestE = e; best = s; }
  }
  if (!(bestE > 1e-8)) return NaN;
  const x = entry.data;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) { const df = x[best + i] - x[best + i + tau]; sum += df * df; }
    d[tau] = sum;
  }
  // Cumulative mean normalised difference / 누적 평균 정규화 차이
  let run = 0;
  const cm = new Float32Array(tauMax + 1);
  cm[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    cm[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cm[t] < threshold) {
      while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return NaN;
  // Parabolic refinement / 포물선 보간
  const y0 = cm[tau - 1] ?? cm[tau];
  const y1 = cm[tau];
  const y2 = cm[tau + 1] ?? cm[tau];
  const den = y0 - 2 * y1 + y2;
  const t = Math.abs(den) > 1e-12 ? tau + (0.5 * (y0 - y2)) / den : tau;
  return freqToMidi(sr / t);
}

registerSelfCheck('Sampler: spec defaults, region fades, loop crossfade, root detection, read offset', (a) => {
  const s = normalizeSampleSpec({ id: 'x', root: 200, t0: -1, t1: 0.5, loop: 'bogus', xfadeMs: 9999 });
  a.equal(s.root, 127, 'root clamped');
  a.equal(s.t0, 0);
  a.equal(s.loop, 'off', 'bad loop → off');
  a.equal(s.xfadeMs, SAMPLE_XFADE_MAX_MS);
  a.equal(normalizeSampleSpec({}).t1, null, 't1 missing → end of file');
  a.equal(voiceSampleSpec({ timbreMode: 'mix', timbreSample: { id: 'x' } }), null, 'mix voice is not a sampler voice');
  a.equal(timbreSampleSpec({ mode: 'sample', sample: { id: 'y' } }).id, 'y');

  const sr = 48000;
  const hz = 220;
  const data = new Float32Array(sr);
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sr);
  const entry = { data, sampleRate: sr, peak: 0.5 };
  const one = renderSampleRegion(entry, { t0: 0.25, t1: 0.75, xfadeMs: 10 });
  a.equal(one.data.length, sr / 2, 'region length');
  a.equal(one.data[0], 0, 'fade-in starts at 0');
  let pk = 0;
  for (const v of one.data) pk = Math.max(pk, Math.abs(v));
  a.near(pk, 1, 0.01, 'peak-normalised');
  const lp = renderSampleRegion(entry, { t0: 0, t1: 0.5, loop: 'loop', xfadeMs: 20 });
  a.equal(lp.data.length, sr / 2 - Math.round(0.02 * sr), 'loop is shorter by the crossfade');
  // Wrap end → start must be continuous (no jump bigger than one sine step) / 끝 → 처음 연속
  const jump = Math.abs(lp.data[0] - lp.data[lp.data.length - 1]);
  a.ok(jump < 0.1, `loop wrap jump ${jump.toFixed(3)}`);

  const m = detectSampleRoot(entry, {});
  a.near(m, freqToMidi(hz), 0.05, `root ${m}`);
  const noise = { data: new Float32Array(sr / 4), sampleRate: sr, peak: 1 };
  a.ok(Number.isNaN(detectSampleRoot(noise, {})), 'silence → NaN');

  a.near(integrateReadSec(() => midiToFreq(72), 0, 2, 60), 4, 1e-6, 'one octave up reads twice as fast');
  a.equal(regionStartOffset(5, 2, true), 1, 'loop wraps');
  a.equal(regionStartOffset(5, 2, false), null, 'one shot is over');
  a.equal(normalizeSampleSpec({}).play, 'tape', 'old specs stay tape');
  a.ok(sampleRegionKey({ id: 'x', play: 'pitch' }) === sampleRegionKey({ id: 'x' }), 'region key ignores the play mode');

  // Envelope / 엔벨로프
  a.equal(normalizeSampleSpec({}).envOn, false, 'envelope off by default');
  a.ok(sampleRegionKey({ id: 'x', envOn: true }) !== sampleRegionKey({ id: 'x' }), 'region key follows the envelope');
  const env = renderSampleRegion(entry, { t0: 0, t1: 1, envOn: true, fadeInMs: 200, fadeOutMs: 300 });
  a.equal(env.data.length, sr, 'one shot envelope keeps the length');
  const rmsAt = (d, c, w = 480) => { let q = 0; for (let i = c - w; i < c + w; i++) q += d[i] * d[i]; return Math.sqrt(q / (2 * w)); };
  a.ok(rmsAt(env.data, Math.round(0.02 * sr)) < 0.25 * rmsAt(env.data, Math.round(0.5 * sr)), 'fades in');
  a.ok(rmsAt(env.data, sr - 600, 500) < 0.1 * rmsAt(env.data, Math.round(0.5 * sr)), 'fades out');
  const fit = sampleEnvelopeFrames({ fadeInMs: 800, fadeOutMs: 800 }, sr, sr);
  a.equal(fit.A + fit.R <= sr, true, 'fades shortened to fit the region');
  const lo = renderSampleRegion(entry, { t0: 0, t1: 1, loop: 'loop', envOn: true, fadeInMs: 100, fadeOutMs: 100, loopOverlap: true });
  a.equal(lo.data.length, sr - Math.round(0.1 * sr), 'overlapped loop is shorter by the fade-out');
  const ln = renderSampleRegion(entry, { t0: 0, t1: 1, loop: 'loop', envOn: true, fadeInMs: 100, fadeOutMs: 100, loopOverlap: false });
  a.equal(ln.data.length, sr, 'loop without overlap keeps the whole region');
  // Overlap: the level stays up across the wrap; no overlap: it dips / 겹침: 경계에서 레벨 유지, 겹침 없음: 꺼짐
  a.ok(rmsAt(lo.data, 480) > 0.5, `overlap keeps level at the wrap (${rmsAt(lo.data, 480).toFixed(2)})`);
  a.ok(rmsAt(ln.data, 480) < 0.2, 'no overlap dips at the wrap');
}, { group: 'audio' });

registerSelfCheck('Sampler pitch only: octave up keeps the length, level stays even, speed 0.5 doubles it', (a) => {
  const sr = 48000;
  const src = new Float32Array(sr); // 1 s, 220 Hz / 1초, 220 Hz
  for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * 220 * i) / sr);
  const n = Math.round(1.5 * sr);
  const out = renderGrainShift({ src, srcRate: sr, loop: false, outRate: sr, n, speed: 1, ratioAt: () => 2, grainSec: 0.07 });
  let last = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > 0.01) last = i;
  a.near(last / sr, 1, 0.05, `ends at ${(last / sr).toFixed(3)} s (tape would end at 0.5 s)`);
  // Pitch: autocorrelation peak near 48000 / 440 ≈ 109 samples / 음높이
  const W = 4096;
  const at = Math.round(0.4 * sr);
  let best = -1;
  let bt = 0;
  for (let tau = 60; tau < 300; tau++) { let c = 0; for (let i = 0; i < W; i++) c += out[at + i] * out[at + i + tau]; if (c > best) { best = c; bt = tau; } }
  a.near(sr / bt, 440, 6, `pitch ${(sr / bt).toFixed(1)} Hz`);
  const rms = (a0, b0) => { let s = 0; for (let i = a0; i < b0; i++) s += out[i] * out[i]; return Math.sqrt(s / (b0 - a0)); };
  const r1 = rms(Math.round(0.2 * sr), Math.round(0.4 * sr));
  const r2 = rms(Math.round(0.6 * sr), Math.round(0.8 * sr));
  a.ok(Math.abs(r1 / r2 - 1) < 0.15 && r1 > 0.4, `even level ${r1.toFixed(3)} / ${r2.toFixed(3)}`);
  const slow = renderGrainShift({ src, srcRate: sr, loop: false, outRate: sr, n: Math.round(2.5 * sr), speed: 0.5, ratioAt: () => 1, grainSec: 0.07 });
  let last2 = 0;
  for (let i = 0; i < slow.length; i++) if (Math.abs(slow[i]) > 0.01) last2 = i;
  a.near(last2 / sr, 2, 0.06, `speed 0.5 ends at ${(last2 / sr).toFixed(3)} s`);
  const frozen = renderGrainShift({ src, srcRate: sr, loop: false, outRate: sr, n: sr, readStartSec: 0.5, speed: 0, ratioAt: () => 1, grainSec: 0.07 });
  a.ok(Math.abs(frozen[sr - 100]) > 0 || Math.abs(frozen[sr - 200]) > 0, 'speed 0 = freeze keeps sounding');
}, { group: 'audio' });

registerSelfCheck('Sample library: 16-bit round trip, content id, dedupe, reference scan', (a) => {
  const sr = 48000;
  const data = new Float32Array(4800);
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr);
  const e = addSample({ name: 'check-sine', sampleRate: sr, data });
  a.ok(/^smp_[0-9a-f]{8}$/.test(e.id), `id ${e.id}`);
  a.equal(addSample({ name: 'again', sampleRate: sr, data }).id, e.id, 'same content → same entry');
  a.near(e.peak, 0.5, 1e-3, 'peak');
  const saved = serializeSamples([e.id]);
  a.equal(saved.length, 1);
  _forgetSample(e.id);
  a.equal(loadSamples(saved), 1, 'reload');
  const back = getSample(e.id);
  let err = 0;
  for (let i = 0; i < data.length; i++) err = Math.max(err, Math.abs(back.data[i] - data[i]));
  a.ok(err < 1e-4, `16-bit error ${err}`);
  a.ok(referencedSampleIds(`{"id":"${e.id}"}`).includes(e.id), 'reference scan');
  removeSample(e.id);
}, { group: 'audio' });
