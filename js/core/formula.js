/**
 * Flexatone — core/formula.js
 * Layer 0 (core): safe expression compiler for user-typed curve formulas f(t; a, b, c …).
 * 계층 0 (core): 사용자 입력 곡선 수식 f(t; a, b, c …)의 안전한 컴파일러.
 *
 * Recursive-descent parser → closure tree. Never uses eval / new Function; only whitelisted
 * functions, constants and declared variables are accepted.
 * 재귀 하강 파서 → 클로저 트리 (eval / new Function 미사용, 화이트리스트만 허용).
 *
 * Grammar: + − × ÷ % ^ (or **), unary ±, implicit multiplication (2pi t, 3(t+1)), f(args).
 * Variables: `t` (normalized time 0…1, alias `x`) and user variables a, b, c, … (single letters,
 * excluding t, x and e). / 변수: t(=x)와 사용자 변수 a, b, c … (t·x·e 제외 한 글자)
 *
 * Imports: none. No DOM.
 */

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const frac = (v) => v - Math.floor(v);
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const MAX_EXPR_LENGTH = 400;
export const MAX_FORMULA_VARS = 12;

/** Whitelisted constants. / 허용 상수 */
export const FORMULA_CONSTANTS = Object.freeze({ pi: Math.PI, tau: 2 * Math.PI, e: Math.E });

/** Whitelisted functions: [arity (−1 = variadic ≥ 1), impl]. / 허용 함수 */
export const FORMULA_FUNCTIONS = Object.freeze({
  sin: [1, Math.sin], cos: [1, Math.cos], tan: [1, Math.tan],
  asin: [1, (v) => Math.asin(clampNum(v, -1, 1))], acos: [1, (v) => Math.acos(clampNum(v, -1, 1))],
  atan: [1, Math.atan], atan2: [2, Math.atan2],
  sinh: [1, Math.sinh], cosh: [1, Math.cosh], tanh: [1, Math.tanh],
  asinh: [1, Math.asinh], acosh: [1, Math.acosh], atanh: [1, Math.atanh],
  exp: [1, Math.exp], ln: [1, Math.log], log: [1, Math.log], log2: [1, Math.log2], log10: [1, Math.log10],
  sqrt: [1, Math.sqrt], cbrt: [1, Math.cbrt], abs: [1, Math.abs], sign: [1, Math.sign],
  floor: [1, Math.floor], ceil: [1, Math.ceil], round: [1, Math.round], frac: [1, frac],
  pow: [2, Math.pow], mod: [2, (a, b) => a - b * Math.floor(a / b)],
  min: [-1, Math.min], max: [-1, Math.max],
  clamp: [3, (v, lo, hi) => Math.min(hi, Math.max(lo, v))],
  lerp: [3, (a, b, s) => a + (b - a) * s],
  step: [2, (edge, v) => (v < edge ? 0 : 1)],
  smoothstep: [3, (e0, e1, v) => { const s = clampNum((v - e0) / (e1 - e0 || 1e-9), 0, 1); return s * s * (3 - 2 * s); }],
});

/** Letters usable as user variables, in the order the "+ Variable" button creates them. */
export const FORMULA_VAR_LETTERS = Object.freeze('abcdfghijklmnopqrsuvwyz'.split(''));

/** Next unused variable letter (a, b, c, d, f …; skips e, t, x). / 다음 변수 이름 */
export function nextFormulaVarName(vars = []) {
  const used = new Set(vars.map((v) => v?.name));
  return FORMULA_VAR_LETTERS.find((c) => !used.has(c)) || null;
}

export class FormulaError extends Error {
  constructor(code, pos = 0, arg = '', arg2 = '') {
    super(code);
    this.code = code; // 'empty' | 'syntax' | 'unknown' | 'arity'
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
    if (c === '×') { tokens.push({ type: 'op', value: '*', pos: i }); i++; continue; }
    if (c === '÷') { tokens.push({ type: 'op', value: '/', pos: i }); i++; continue; }
    if (c === '−') { tokens.push({ type: 'op', value: '-', pos: i }); i++; continue; }
    if (c === 'π') { tokens.push({ type: 'id', value: 'pi', raw: 'π', pos: i }); i++; continue; }
    if ('+-*/%^(),'.includes(c)) { tokens.push({ type: 'op', value: c, pos: i }); i++; continue; }
    throw new FormulaError('syntax', i + 1);
  }
  tokens.push({ type: 'end', pos: src.length });
  return tokens;
}

/**
 * Split an identifier such as "ab" or "2at" into declared single-letter variables when the
 * whole word is not a function/constant (implicit multiplication "ab" = a·b).
 * 함수·상수가 아닌 여러 글자 식별자는 한 글자 변수의 곱으로 해석 (ab = a·b).
 */
function splitVarWord(word, slots) {
  if (word.length < 2) return null;
  const parts = word.split('');
  return parts.every((ch) => own(slots, ch) || own(FORMULA_CONSTANTS, ch)) ? parts : null;
}

function parse(tokens, slots) {
  let k = 0;
  let depth = 0;
  const peek = () => tokens[k];
  const isOp = (v) => tokens[k].type === 'op' && tokens[k].value === v;
  const expect = (v) => {
    if (!isOp(v)) throw new FormulaError('syntax', tokens[k].pos + 1);
    k++;
  };
  const enter = () => { if (++depth > 64) throw new FormulaError('syntax', peek().pos + 1); };

  const leaf = (name) => {
    if (own(slots, name)) { const i = slots[name]; return (s) => s[i]; }
    if (own(FORMULA_CONSTANTS, name)) { const v = FORMULA_CONSTANTS[name]; return () => v; }
    return null;
  };

  function additive() {
    let node = multiplicative();
    while (isOp('+') || isOp('-')) {
      const op = tokens[k++].value;
      const l = node;
      const r = multiplicative();
      node = op === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
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
        if (op === '*') node = (s) => l(s) * r(s);
        else if (op === '/') node = (s) => l(s) / r(s);
        else node = (s) => { const a = l(s); const b = r(s); return a - b * Math.floor(a / b); };
      } else if (startsPrimary()) {
        const l = node;
        const r = power();
        node = (s) => l(s) * r(s);
      } else {
        return node;
      }
    }
  }
  function unary() {
    if (isOp('-')) { k++; enter(); const u = unary(); depth--; return (s) => -u(s); }
    if (isOp('+')) { k++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (isOp('^')) {
      k++;
      enter();
      const ex = unary();
      depth--;
      return (s) => Math.pow(base(s), ex(s));
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
      if (own(FORMULA_FUNCTIONS, name) && isOp('(')) {
        k++;
        enter();
        const args = [];
        if (!isOp(')')) {
          args.push(additive());
          while (isOp(',')) { k++; args.push(additive()); }
        }
        depth--;
        expect(')');
        const [arity, impl] = FORMULA_FUNCTIONS[name];
        if ((arity >= 0 && args.length !== arity) || (arity < 0 && args.length < 1)) {
          throw new FormulaError('arity', tk.pos + 1, tk.raw, arity < 0 ? '1+' : arity);
        }
        if (args.length === 1) { const a0 = args[0]; return (s) => impl(a0(s)); }
        if (args.length === 2) { const [a0, a1] = args; return (s) => impl(a0(s), a1(s)); }
        return (s) => impl(...args.map((a) => a(s)));
      }
      const direct = leaf(name);
      if (direct) return direct;
      const parts = splitVarWord(name, slots);
      if (parts) {
        const fns = parts.map(leaf);
        return (s) => fns.reduce((acc, f) => acc * f(s), 1);
      }
      throw new FormulaError('unknown', tk.pos + 1, tk.raw);
    }
    throw new FormulaError('syntax', tk.pos + 1);
  }

  const fn = additive();
  if (peek().type !== 'end') throw new FormulaError('syntax', peek().pos + 1);
  return fn;
}

const cache = new Map();
const CACHE_MAX = 64;

/**
 * Compile an expression of t (and user variables) into fn(scope) where
 * scope = [t, var0, var1, …] in the order of `varNames`.
 * t(와 사용자 변수)의 수식을 fn(scope)로 컴파일. scope = [t, 변수0, 변수1, …].
 * @param {string} expr e.g. 'a*sin(pi*t/2) + (1-a)*t^b'
 * @param {string[]} [varNames] e.g. ['a', 'b']
 * @returns {{ ok: true, fn: (scope: ArrayLike<number>) => number, error: null } |
 *           { ok: false, fn: null, error: FormulaError }}
 */
export function compileFormula(expr, varNames = []) {
  const src = String(expr ?? '').trim();
  const names = varNames.filter((n) => typeof n === 'string' && /^[a-z]$/.test(n) && n !== 't' && n !== 'x' && n !== 'e');
  const key = `${names.join(',')}|${src}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let result;
  try {
    if (!src) throw new FormulaError('empty');
    if (src.length > MAX_EXPR_LENGTH) throw new FormulaError('syntax', MAX_EXPR_LENGTH);
    const slots = { t: 0, x: 0 };
    names.forEach((n, i) => { slots[n] = i + 1; });
    result = { ok: true, fn: parse(tokenize(src), slots), error: null };
  } catch (err) {
    if (!(err instanceof FormulaError)) throw err;
    result = { ok: false, fn: null, error: err };
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}
