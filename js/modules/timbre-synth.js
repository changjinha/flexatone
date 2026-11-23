/**
 * Flexatone — modules/timbre-synth.js
 * Layer 1 (modules): additive timbre → PeriodicWave Fourier coefficients (pure math).
 * 계층 1 (modules): 가산 음색 → PeriodicWave 푸리에 계수 (순수 계산).
 *
 * Two timbre modes per voice / 보이스별 두 가지 음색 모드
 *   'mix'  : 5 analytic waveforms (Sine, Tri, Saw, Sqr, Rich) weighted and summed.
 *   'func' : ƒ(x) Function Wave — one cycle x∈[0,1) defined either by a formula
 *            (compiled by `compileWaveFormula`, no eval / new Function) or by sampling
 *            another voice's curve (`sampleTimbreFunctionCycle`), then DFT → coefficients.
 *
 * Output contract: `{ real: Float32Array, imag: Float32Array }` (index 0 = DC, always 0),
 * matching `AudioContext.createPeriodicWave(real, imag)`. Creating the wave itself is the
 * audio layer's job. / PeriodicWave 생성은 audio 계층 담당.
 *
 * Imports: core/*, modules/curve-engine.js. No DOM / Audio APIs.
 */

import { clamp } from '../core/math-utils.js';
import { t, getLang, setLang } from '../core/i18n.js';
import { TIMBRE_WAVES, createDefaultVoice, registerSelfCheck } from '../core/state.js';
import { evaluateCurveObjectY } from './curve-engine.js';

export const DEFAULT_HARMONICS = 64;
export const DEFAULT_CYCLE_SAMPLES = 1024;
export const MAX_FORMULA_LENGTH = 500;

// ==========================================================================
// 1. 5-wave additive mixer / 5파형 가산 믹서
// ==========================================================================

/**
 * Sine-series amplitude of each analytic wave at harmonic n (n ≥ 1).
 *   tri : 8/π² · (−1)^((n−1)/2) / n²   (odd n)
 *   sqr : 4/π · 1/n                     (odd n)
 *   saw : 2/π · 1/n                     (all n)
 *   rich: n^−0.75 · (1 + 0.35·sin 1.3n) (bright, slightly irregular spectrum)
 */
function harmonicAmp(n, w) {
  let amp = 0;
  if (n === 1) amp += w.sine;
  if (n % 2 === 1) {
    const sign = ((n - 1) / 2) % 2 === 0 ? 1 : -1;
    amp += (w.tri * (8 / (Math.PI * Math.PI)) * sign) / (n * n);
    amp += (w.sqr * (4 / Math.PI)) / n;
  }
  amp += (w.saw * (2 / Math.PI)) / n;
  amp += w.rich * Math.pow(n, -0.75) * (1 + 0.35 * Math.sin(n * 1.3));
  return amp;
}

/** Read a timbre object (accepts legacy `square`). / 음색 가중치 읽기 */
export function readTimbreWeights(timbre) {
  const src = timbre && typeof timbre === 'object' ? timbre : {}; // null-safe (default params skip null)
  const w = {};
  for (const id of TIMBRE_WAVES) {
    const raw = id === 'sqr' && src.sqr === undefined ? src.square : src[id];
    w[id] = clamp(Number(raw) || 0, 0, 1);
  }
  return w;
}

/**
 * 5-wave weights → PeriodicWave coefficients. All-zero weights fall back to a pure sine.
 * 5파형 가중치 → PeriodicWave 계수 (모두 0이면 사인).
 * @param {{sine?:number,tri?:number,saw?:number,sqr?:number,rich?:number}} timbre
 * @param {number} [harmonics=DEFAULT_HARMONICS] array length (highest partial = harmonics − 1)
 */
export function computeAdditiveCoefficients(timbre, harmonics = DEFAULT_HARMONICS) {
  const H = Math.max(2, Math.floor(harmonics));
  const real = new Float32Array(H);
  const imag = new Float32Array(H);
  const w = readTimbreWeights(timbre);
  const total = TIMBRE_WAVES.reduce((s, id) => s + w[id], 0);
  if (total < 1e-4) {
    imag[1] = 1;
    return { real, imag };
  }
  for (let n = 1; n < H; n++) imag[n] = harmonicAmp(n, w);
  return { real, imag };
}

// ==========================================================================
// 2. ƒ(x) formula compiler (recursive descent, no eval) / 수식 컴파일러
// ==========================================================================

const frac = (v) => v - Math.floor(v);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Whitelisted constants. x / t are the cycle position 0 ≤ x < 1. */
const CONSTANTS = Object.freeze({ pi: Math.PI, tau: 2 * Math.PI, e: Math.E });

/** Whitelisted functions: [arity (−1 = variadic ≥ 1), impl]. Periodic helpers have period 1. */
const FUNCTIONS = Object.freeze({
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
  asin: [1, Math.asin], acos: [1, Math.acos], atan: [1, Math.atan], atan2: [2, Math.atan2],
  sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
  exp: [1, Math.exp], log: [1, Math.log], log2: [1, Math.log2], log10: [1, Math.log10],
  sqrt: [1, Math.sqrt], abs: [1, Math.abs], sign: [1, Math.sign],
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], frac: [1, frac],
  pow: [2, Math.pow], mod: [2, (a, b) => a - b * Math.floor(a / b)],
  min: [-1, Math.min], max: [-1, Math.max],
  clamp: [3, (v, lo, hi) => Math.min(hi, Math.max(lo, v))],
  step: [2, (edge, v) => (v < edge ? 0 : 1)],
  smoothstep: [3, (e0, e1, v) => { const s = clamp((v - e0) / (e1 - e0 || 1e-9), 0, 1); return s * s * (3 - 2 * s); }],
  saw: [1, (p) => 2 * frac(p) - 1],
  tri: [1, (p) => 1 - 4 * Math.abs(frac(p + 0.25) - 0.5)],
  sqr: [1, (p) => (frac(p) < 0.5 ? 1 : -1)],
  pulse: [2, (p, width) => (frac(p) < clamp(width, 0, 1) ? 1 : -1)],
});

class FormulaError extends Error {
  constructor(code, pos, arg, arg2) {
    super(code);
    this.code = code;
    this.pos = pos;
    this.arg = arg;
    this.arg2 = arg2;
  }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { tokens.push({ type: 'num', value: parseFloat(num[0]), pos: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { tokens.push({ type: 'id', value: id[0].toLowerCase(), raw: id[0], pos: i }); i += id[0].length; continue; }
    if (c === '*' && src[i + 1] === '*') { tokens.push({ type: 'op', value: '^', pos: i }); i += 2; continue; }
    if ('+-*/%^(),'.includes(c)) { tokens.push({ type: 'op', value: c, pos: i }); i++; continue; }
    throw new FormulaError('syntax', i + 1);
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
}

function parse(tokens) {
  let k = 0;
  let depth = 0;
  const peek = () => tokens[k];
  const isOp = (v) => tokens[k].type === 'op' && tokens[k].value === v;
  const expect = (v) => {
    if (!isOp(v)) throw new FormulaError('syntax', tokens[k].pos + 1);
    k++;
  };
  const enter = () => { if (++depth > 64) throw new FormulaError('syntax', peek().pos + 1); };

  function additive() {
    let node = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = tokens[k++].value;
      const l = node;
      const r = multiplicative();
      node = op === '+' ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
    }
    return node;
  }
  function startsPrimary() {
    const tk = peek();
    return tk.type === 'num' || tk.type === 'id' || (tk.type === 'op' && tk.value === '(');
  }
  function multiplicative() {
    let node = unary();
    for (;;) {
      if (isOp('*') || isOp('/') || isOp('%')) {
        const op = tokens[k++].value;
        const l = node;
        const r = unary();
        if (op === '*') node = (x) => l(x) * r(x);
        else if (op === '/') node = (x) => l(x) / r(x);
        else node = (x) => { const a = l(x); const b = r(x); return a - b * Math.floor(a / b); }; // each operand once
      } else if (startsPrimary()) {
        const l = node; // implicit multiplication: 2pi x, 3(x+1) / 암시적 곱셈
        const r = power();
        node = (x) => l(x) * r(x);
      } else {
        return node;
      }
    }
  }
  function unary() {
    if (isOp('-')) { k++; enter(); const u = unary(); depth--; return (x) => -u(x); }
    if (isOp('+')) { k++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (isOp('^')) {
      k++;
      enter();
      const ex = unary(); // right-associative; allows 2^-x / 오른쪽 결합
      depth--;
      return (x) => Math.pow(base(x), ex(x));
    }
    return base;
  }
  function primary() {
    const tk = peek();
    if (tk.type === 'num') { k++; const v = tk.value; return () => v; }
    if (tk.type === 'op' && tk.value === '(') {
      k++;
      enter();
      const e = additive();
      depth--;
      expect(')');
      return e;
    }
    if (tk.type === 'id') {
      k++;
      const name = tk.value;
      if (name === 'x' || name === 't') return (x) => x;
      if (own(FUNCTIONS, name) && isOp('(')) {
        k++;
        enter();
        const args = [];
        if (!isOp(')')) {
          args.push(additive());
          while (isOp(',')) { k++; args.push(additive()); }
        }
        depth--;
        expect(')');
        const [arity, impl] = FUNCTIONS[name];
        if ((arity >= 0 && args.length !== arity) || (arity < 0 && args.length < 1)) {
          throw new FormulaError('arity', tk.pos + 1, tk.raw, arity < 0 ? '1+' : arity);
        }
        if (args.length === 1) { const a0 = args[0]; return (x) => impl(a0(x)); }
        if (args.length === 2) { const [a0, a1] = args; return (x) => impl(a0(x), a1(x)); }
        return (x) => impl(...args.map((a) => a(x)));
      }
      if (own(CONSTANTS, name)) { const v = CONSTANTS[name]; return () => v; }
      throw new FormulaError('unknown', tk.pos + 1, tk.raw);
    }
    throw new FormulaError('syntax', tk.pos + 1);
  }

  const fn = additive();
  if (peek().type !== 'end') throw new FormulaError('syntax', peek().pos + 1);
  return fn;
}

function formulaErrorMessage(err) {
  switch (err.code) {
    case 'voice': return t('timbre.err.voice');
    case 'empty': return t('timbre.err.empty');
    case 'unknown': return t('timbre.err.unknown', err.arg);
    case 'arity': return t('timbre.err.arity', err.arg, err.arg2);
    default: return t('timbre.err.syntax', err.pos ?? 0);
  }
}

/**
 * Rebuild an error's message in the current language from its language-neutral fields.
 * 오류 메시지를 현재 언어로 다시 생성 (code/pos/arg 기반).
 */
export function localizeTimbreError(err) {
  return err ? { ...err, message: formulaErrorMessage(err) } : null;
}

const formulaCache = new Map();
const FORMULA_CACHE_MAX = 48;

/**
 * Compile a waveform expression of x (cycle position, 0 ≤ x < 1) into a JS function.
 * Supports + − × ÷ % ^ (**), unary ±, implicit multiplication (2pi x), whitelisted
 * functions/constants only. Never uses eval / new Function.
 * 파형 수식을 함수로 컴파일 (화이트리스트 함수·상수만, eval 미사용).
 * @param {string} expr e.g. 'sin(2*pi*x) + 0.35*sin(6*pi*x)'
 * @returns {{ ok: true, fn: (x:number)=>number, error: null } |
 *           { ok: false, fn: null, error: { code: string, pos?: number, message: string } }}
 */
export function compileWaveFormula(expr) {
  const src = String(expr ?? '').trim();
  const cached = formulaCache.get(src);
  if (cached) {
    // Re-localise error message in the current language / 현재 언어로 메시지 갱신
    return cached.ok ? cached : { ...cached, error: { ...cached.error, message: formulaErrorMessage(cached.error) } };
  }
  let result;
  try {
    if (!src) throw new FormulaError('empty', 0);
    if (src.length > MAX_FORMULA_LENGTH) throw new FormulaError('syntax', MAX_FORMULA_LENGTH);
    const fn = parse(tokenize(src));
    result = { ok: true, fn, error: null };
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    result = { ok: false, fn: null, error: { code: err.code, pos: err.pos, arg: err.arg, arg2: err.arg2, message: formulaErrorMessage(err) } };
  }
  if (formulaCache.size >= FORMULA_CACHE_MAX) formulaCache.delete(formulaCache.keys().next().value);
  formulaCache.set(src, result);
  return result;
}

// ==========================================================================
// 3. One-cycle sampling & DFT / 한 주기 샘플링 및 DFT
// ==========================================================================

function removeDcAndNormalize(buf, { removeDC = true, normalize = true } = {}) {
  const n = buf.length;
  if (removeDC) {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n;
    for (let i = 0; i < n; i++) buf[i] -= mean;
  }
  if (normalize) {
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
    if (peak > 1e-12) for (let i = 0; i < n; i++) buf[i] /= peak;
  }
  return buf;
}

/**
 * Sample one waveform cycle for the ƒ(x) Function Wave.
 *   source 'formula': evaluate the compiled expression at x = k/N.
 *   source 'voice'  : read another voice's normalized curve y(x) (Multi-Voice cross-modulation).
 * Non-finite samples become 0. DC is removed and peak normalized to 1 by default.
 * ƒ(x) 함수 파형 한 주기 샘플링 (수식 또는 다른 보이스 곡선).
 * @param {{ source: 'formula'|'voice', expr?: string, voiceId?: string }} timbreFunc
 * @param {{ voices?: object[], samples?: number, removeDC?: boolean, normalize?: boolean }} [opts]
 * @returns {{ ok: boolean, samples: Float64Array, error: object|null }}
 */
export function sampleTimbreFunctionCycle(timbreFunc, opts = {}) {
  const { voices = [], samples = DEFAULT_CYCLE_SAMPLES } = opts;
  const N = Math.max(16, Math.floor(samples));
  const buf = new Float64Array(N);
  let evalAt;
  if (timbreFunc?.source === 'voice') {
    const src = voices.find((v) => v && v.id === timbreFunc.voiceId);
    if (!src) return { ok: false, samples: buf, error: { code: 'voice', message: t('timbre.err.voice') } };
    evalAt = (x) => evaluateCurveObjectY(src, x);
  } else {
    const compiled = compileWaveFormula(timbreFunc?.expr);
    if (!compiled.ok) return { ok: false, samples: buf, error: compiled.error };
    evalAt = compiled.fn;
  }
  for (let k = 0; k < N; k++) {
    const y = evalAt(k / N);
    buf[k] = Number.isFinite(y) ? y : 0;
  }
  removeDcAndNormalize(buf, opts);
  return { ok: true, samples: buf, error: null };
}

/**
 * Real DFT of one cycle → PeriodicWave coefficients:
 *   w(x) ≈ Σₙ realₙ·cos(2πnx) + imagₙ·sin(2πnx),  realₙ = (2/N)Σ w cos,  imagₙ = (2/N)Σ w sin.
 * 한 주기 실수 DFT → PeriodicWave 계수.
 */
export function dftToPeriodicCoefficients(cycle, harmonics = DEFAULT_HARMONICS) {
  const N = cycle.length;
  const H = Math.max(2, Math.min(Math.floor(harmonics), Math.floor(N / 2)));
  const real = new Float32Array(H);
  const imag = new Float32Array(H);
  for (let n = 1; n < H; n++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * n) / N;
    for (let k = 0; k < N; k++) {
      re += cycle[k] * Math.cos(w * k);
      im += cycle[k] * Math.sin(w * k);
    }
    real[n] = (2 / N) * re;
    imag[n] = (2 / N) * im;
  }
  return { real, imag };
}

/** Inverse: resynthesize one cycle from coefficients (previews & tests). / 계수 → 파형 복원 */
export function synthesizeCycle(real, imag, points = 256) {
  const out = new Float64Array(points);
  const H = Math.min(real.length, imag.length);
  for (let i = 0; i < points; i++) {
    const x = i / points;
    let s = 0;
    for (let n = 1; n < H; n++) s += real[n] * Math.cos(2 * Math.PI * n * x) + imag[n] * Math.sin(2 * Math.PI * n * x);
    out[i] = s;
  }
  return out;
}

/** ƒ(x) Function Wave → coefficients. / 함수 파형 계수 */
export function computeFunctionCoefficients(timbreFunc, opts = {}) {
  const res = sampleTimbreFunctionCycle(timbreFunc, opts);
  if (!res.ok) return { ok: false, real: null, imag: null, error: res.error };
  return { ok: true, ...dftToPeriodicCoefficients(res.samples, opts.harmonics ?? DEFAULT_HARMONICS), error: null };
}

// ==========================================================================
// 4. Voice-level API / 보이스 단위 API
// ==========================================================================

/**
 * Coefficients for a voice according to its timbreMode. A failing ƒ(x) falls back to the
 * 5-wave mix and reports the error so the UI can show it.
 * 보이스 음색 모드에 따른 계수 (ƒ(x) 실패 시 믹스로 대체하고 오류 보고).
 * @param {object} voice
 * @param {{ voices?: object[], harmonics?: number }} [opts] voices = all voices (for 'voice' source)
 * @returns {{ real: Float32Array, imag: Float32Array, mode: 'mix'|'func', error: object|null }}
 */
export function computeTimbreCoefficients(voice, opts = {}) {
  const harmonics = opts.harmonics ?? DEFAULT_HARMONICS;
  if (voice?.timbreMode === 'func') {
    const res = computeFunctionCoefficients(voice.timbreFunc, { ...opts, harmonics });
    if (res.ok) return { real: res.real, imag: res.imag, mode: 'func', error: null };
    return { ...computeAdditiveCoefficients(voice.timbre, harmonics), mode: 'mix', error: res.error };
  }
  return { ...computeAdditiveCoefficients(voice?.timbre, harmonics), mode: 'mix', error: null };
}

const coeffCache = new Map();
const COEFF_CACHE_MAX = 48;

function timbreCacheKey(voice, opts) {
  const h = opts.harmonics ?? DEFAULT_HARMONICS;
  const mix = JSON.stringify(readTimbreWeights(voice?.timbre));
  if (voice?.timbreMode === 'func') {
    const tf = voice.timbreFunc || {};
    // Sampling options change the coefficients; the voice's own mix is the fallback on error.
    // 샘플링 옵션은 계수를 바꾸며, 오류 시 대체값은 해당 보이스의 믹스임.
    const sampling = `${opts.samples ?? DEFAULT_CYCLE_SAMPLES}|${opts.removeDC !== false}|${opts.normalize !== false}`;
    if (tf.source === 'voice') {
      const src = (opts.voices || []).find((v) => v && v.id === tf.voiceId);
      if (!src) return `func|voice-missing|${tf.voiceId}|${h}|${mix}`;
      // The source voice's whole curve config determines the waveform / 소스 보이스 곡선 전체가 키
      const { timbre, timbreFunc, timbreMode, name, color, solo, muted, ...curve } = src;
      return `func|voice|${h}|${sampling}|${mix}|${JSON.stringify(curve)}`;
    }
    return `func|formula|${h}|${sampling}|${mix}|${tf.expr}`;
  }
  return `mix|${h}|${mix}`;
}

/** Memoised computeTimbreCoefficients (LRU). Treat the returned arrays as read-only. */
export function getTimbreCoefficientsCached(voice, opts = {}) {
  const key = timbreCacheKey(voice, opts);
  let res = coeffCache.get(key);
  if (res) {
    coeffCache.delete(key);
  } else {
    res = computeTimbreCoefficients(voice, opts);
    if (coeffCache.size >= COEFF_CACHE_MAX) coeffCache.delete(coeffCache.keys().next().value);
  }
  coeffCache.set(key, res);
  // Errors are stored language-neutral and localised on read / 오류는 읽을 때 현지화
  return res.error ? { ...res, error: localizeTimbreError(res.error) } : res;
}

/** Arguments for ctx.createPeriodicWave(real, imag, options). / PeriodicWave 인자 */
export function toPeriodicWaveArgs(coeffs, { disableNormalization = false } = {}) {
  return [coeffs.real, coeffs.imag, { disableNormalization }];
}

/** Peak-normalized single-cycle preview of a voice's timbre (for timbreFuncCanvas). */
export function previewTimbreCycle(voice, opts = {}) {
  const { real, imag, error, mode } = getTimbreCoefficientsCached(voice, opts);
  const wave = synthesizeCycle(real, imag, opts.points ?? 256);
  removeDcAndNormalize(wave, { removeDC: false, normalize: true });
  return { wave, error, mode };
}

// ==========================================================================
// 5. Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('5-wave additive coefficients', (a) => {
  const sine = computeAdditiveCoefficients({ sine: 0.75 });
  a.near(sine.imag[1], 0.75, 1e-7);
  for (let n = 2; n < sine.imag.length; n++) a.near(sine.imag[n], 0, 1e-12, `sine h${n}`);
  a.equal(sine.real[0], 0);
  const tri = computeAdditiveCoefficients({ tri: 1 });
  a.ok(tri.imag[3] < 0 && tri.imag[5] > 0 && tri.imag[2] === 0, 'triangle alternating odd harmonics');
  const sq = computeAdditiveCoefficients({ sqr: 1 }, 16);
  a.near(sq.imag[3] / sq.imag[1], 1 / 3, 1e-6, 'square 1/n');
  a.equal(computeAdditiveCoefficients({ square: 1 }).imag[1], sq.imag[1], 'legacy "square" key');
  const silent = computeAdditiveCoefficients({});
  a.equal(silent.imag[1], 1, 'all-zero → sine fallback');
  a.equal(computeAdditiveCoefficients(null, 8).imag.length, 8);
}, { group: 'timbre' });

registerSelfCheck('compileWaveFormula: grammar & safety', (a) => {
  const val = (e, x = 0.25) => compileWaveFormula(e).fn(x);
  a.near(val('2^3^2'), 512, 1e-9, 'right-assoc power');
  a.near(val('-x^2', 3), -9, 1e-9, 'unary minus binds looser than ^');
  a.near(val('2pi x', 0.5), Math.PI, 1e-12, 'implicit multiplication');
  a.near(val('3(x+1)', 1), 6, 1e-12);
  a.near(val('max(1, x, 7) + min(2,3)'), 9, 1e-12, 'variadic');
  a.near(val('sqr(x) + saw(0.75) + tri(0)'), 1 + 0.5 + 0, 1e-12, 'periodic helpers');
  a.near(val('7 % 3'), 1, 1e-12);
  a.near(val('2**3'), 8, 1e-12);
  a.near(val('SIN(PI/2)'), 1, 1e-12, 'case-insensitive');
  a.equal(compileWaveFormula('sin(').ok, false);
  a.equal(compileWaveFormula('alert(1)').error.code, 'unknown');
  a.equal(compileWaveFormula('constructor').error.code, 'unknown');
  a.equal(compileWaveFormula('pow(2)').error.code, 'arity');
  a.equal(compileWaveFormula('   ').error.code, 'empty');
  a.equal(compileWaveFormula('x $ 2').error.code, 'syntax');
  a.equal(compileWaveFormula('('.repeat(200) + 'x' + ')'.repeat(200)).ok, false, 'depth guard');
  a.ok(compileWaveFormula('x').error === null);
}, { group: 'timbre' });

registerSelfCheck('ƒ(x) DFT round-trip & default formula', (a) => {
  const res = computeFunctionCoefficients({ source: 'formula', expr: 'sin(2*pi*x) + 0.35*sin(6*pi*x)' }, { normalize: false });
  a.ok(res.ok);
  a.near(res.imag[1], 1, 1e-6);
  a.near(res.imag[3], 0.35, 1e-6);
  a.near(res.imag[2], 0, 1e-6);
  a.near(res.real[1], 0, 1e-6);
  const cosr = computeFunctionCoefficients({ source: 'formula', expr: 'cos(2 pi x)' }, { normalize: false });
  a.near(cosr.real[1], 1, 1e-6, 'cos → real');
  const back = synthesizeCycle(res.real, res.imag, 64);
  for (let i = 0; i < 64; i++) {
    const x = i / 64;
    a.near(back[i], Math.sin(2 * Math.PI * x) + 0.35 * Math.sin(6 * Math.PI * x), 1e-5, 'resynthesis');
  }
}, { group: 'timbre' });

registerSelfCheck('Voice-curve wave source & fallbacks', (a) => {
  const src = createDefaultVoice(0, { engine: 'custom', customPoints: [{ x: 0, y: 0, handles: [] }, { x: 1, y: 1, handles: [] }] });
  const user = createDefaultVoice(1, { timbreMode: 'func', timbreFunc: { source: 'voice', expr: '', voiceId: src.id } });
  const c = computeTimbreCoefficients(user, { voices: [src, user] });
  a.equal(c.mode, 'func');
  a.ok(c.imag[1] < 0, 'rising ramp → negative sine series');
  a.near(c.imag[2] / c.imag[1], 0.5, 0.01, 'saw 1/n');
  const missing = computeTimbreCoefficients({ ...user, timbreFunc: { source: 'voice', voiceId: 'v_nope' } }, { voices: [src] });
  a.ok(missing.mode === 'mix' && missing.error?.code === 'voice', 'missing voice → mix fallback');
  const bad = computeTimbreCoefficients({ ...user, timbreFunc: { source: 'formula', expr: 'sin(' } });
  a.ok(bad.mode === 'mix' && bad.error, 'bad formula → mix fallback');
  const nan = sampleTimbreFunctionCycle({ source: 'formula', expr: '1/(x-0.5)' }, { samples: 64 });
  a.ok(nan.ok && [...nan.samples].every(Number.isFinite), 'division by zero sanitized');
  const c1 = getTimbreCoefficientsCached(user, { voices: [src, user] });
  a.ok(c1 === getTimbreCoefficientsCached(user, { voices: [src, user] }), 'cache hit');
  const src2 = { ...src, customPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 0, handles: [] }] };
  a.ok(c1 !== getTimbreCoefficientsCached(user, { voices: [src2, user] }), 'source edit invalidates cache');
  const pv = previewTimbreCycle(createDefaultVoice(0), { points: 128 });
  a.ok(pv.wave.length === 128 && Math.max(...pv.wave.map(Math.abs)) <= 1 + 1e-9, 'preview normalized');
  const args = toPeriodicWaveArgs(c1);
  a.ok(args[0] === c1.real && args[2].disableNormalization === false, 'createPeriodicWave args');
}, { group: 'timbre' });

registerSelfCheck('Regression: modulo cost, per-voice fallback cache, re-localised errors', (a) => {
  const chained = compileWaveFormula('x' + '%2'.repeat(25));
  a.ok(chained.ok, 'chained modulo compiles');
  const t0 = (globalThis.performance || Date).now();
  for (let i = 0; i < 1024; i++) chained.fn(i / 1024);
  a.ok((globalThis.performance || Date).now() - t0 < 200, 'chained modulo evaluates in linear time');

  const broken = { source: 'formula', expr: 'sin(' };
  const sineV = createDefaultVoice(0, { timbreMode: 'func', timbreFunc: broken, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 } });
  const sqrV = createDefaultVoice(1, { timbreMode: 'func', timbreFunc: broken, timbre: { sine: 0, tri: 0, saw: 0, sqr: 1, rich: 0 } });
  const cs = getTimbreCoefficientsCached(sineV);
  const cq = getTimbreCoefficientsCached(sqrV);
  a.ok(cs.imag[3] === 0 && cq.imag[3] > 0, 'each voice falls back to its own mix');

  const prev = getLang();
  try {
    setLang('en');
    const en = getTimbreCoefficientsCached(sineV).error.message;
    setLang('ko');
    const ko = getTimbreCoefficientsCached(sineV).error.message;
    a.ok(en !== ko && ko === t('timbre.err.syntax', cs.error.pos), 'cached error re-localised');
  } finally {
    setLang(prev);
  }

  const fv = createDefaultVoice(2, { timbreMode: 'func', timbreFunc: { source: 'formula', expr: 'saw(x)' } });
  const lo = getTimbreCoefficientsCached(fv, { samples: 32 });
  const hi = getTimbreCoefficientsCached(fv, {});
  a.ok(lo !== hi && hi.imag.length > lo.imag.length - 1 && Math.abs(hi.imag[10] - lo.imag[10]) > 1e-6, 'sampling options are part of the key');
}, { group: 'timbre' });
