/**
 * Flexatone — audio/time-mirror.js
 * Layer 3 (audio): settings retrograde. An offline render whose *score* is mirrored in time while
 * the sound itself still runs forwards: every automation (pitch and gain curves, ramps, masks, warps
 * baked into them) and every start / stop is reflected about a horizon H (t → H − t), but each
 * oscillator, buffer, filter and reverb keeps playing forwards. Unlike a tape reversal
 * (manager-mixer.js reverseBuffer) an attack stays an attack, a release tail still follows its sound
 * and a waveform is not read backwards — the music runs backwards, the sounds do not.
 * 계층 3 (audio): 설정 역행. 악보(자동화·시작/정지)만 시간축에서 H − t로 뒤집고, 소리(발진기·버퍼·필터·잔향)는
 * 앞으로 재생. 테이프 역재생과 달리 어택은 어택으로, 잔향 꼬리는 소리 뒤에 남음.
 *
 * How / 방법
 *   renderMirrored(H, fn) swaps globalThis.OfflineAudioContext for a subclass while fn() runs
 *   synchronously (renderers create their context before their first await), so only the contexts
 *   fn creates are mirrored — a concurrent render of another track is not touched. In a mirrored
 *   context every AudioParam call and every start / stop is recorded instead of scheduled; at
 *   startRendering() the forward automation of each param is evaluated, sampled (1 kHz or the density
 *   of the curves it was given) and scheduled reversed as one value curve. A renderer that does not use
 *   Web Audio automation (the Risset and Wave banks run in JS) calls claimMirror() before it builds
 *   its context and mirrors its own control frames.
 *   fn()이 동기적으로 실행되는 동안만 OfflineAudioContext를 서브클래스로 바꿈 (렌더러는 첫 await 전에 컨텍스트를
 *   만듦) → 다른 트랙의 동시 렌더에는 영향 없음. 자동화와 시작/정지를 기록했다가 startRendering()에서 거꾸로 예약.
 *   JS 뱅크(리세·웨이브)는 claimMirror()로 직접 프레임을 뒤집음.
 */

import { registerSelfCheck } from '../core/state.js';

let active = null; // the session whose fn() is running right now / 지금 fn()이 실행 중인 세션

/**
 * Horizon of the mirrored render running right now, claimed by a renderer that mirrors by itself
 * (its contexts are then left native). Null outside a mirrored render. Call it before creating the
 * context. / 직접 뒤집는 렌더러용: 지금 실행 중인 설정 역행의 H (null = 해당 없음)
 * @returns {{ H: number|null } | null}  H = null → mirror about the render's own length
 */
export function claimMirror() {
  if (!active) return null;
  active.claimed = true;
  return { H: active.H };
}

const PARAM_METHODS = ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime'];
const BASE_RATE = 1000; // automation samples per second / 자동화 표본률
const MAX_RATE = 4000;
const MAX_POINTS = 1 << 21;

/**
 * Forward value function of a recorded automation: segments [{ t0, t1, f(t) }] plus the value before
 * the first event (init) and after the last one (end). / 기록된 자동화의 순방향 값 함수
 */
export function automationSegments(events, init) {
  // cancels first: they drop the events at or after their time (in call order) / 취소 이벤트 처리
  const list = [];
  for (const e of events) {
    if (e.k === 'cancel' || e.k === 'hold') {
      const keep = list.filter((x) => x.t < e.t && !(x.k === 'curve' && x.t + x.d > e.t));
      if (e.k === 'hold') {
        const held = evalAt(automationSegments(list, init), e.t);
        keep.push({ k: 'set', t: e.t, v: held, n: e.n });
      }
      list.length = 0;
      list.push(...keep);
    } else list.push(e);
  }
  list.sort((a, b) => a.t - b.t || a.n - b.n);
  const segs = [];
  let pT = -Infinity;
  let pV = init;
  let target = null; // open setTarget segment / 열린 setTarget 구간
  const closeTarget = (T) => {
    if (!target) return;
    const { t0, v0, v, tau } = target;
    pV = v + (v0 - v) * Math.exp(-(Math.max(t0, T) - t0) / tau);
    segs.push({ t0, t1: T, f: (t) => v + (v0 - v) * Math.exp(-(t - t0) / tau) });
    pT = T;
    target = null;
  };
  for (const e of list) {
    if (e.k === 'lin' || e.k === 'exp') {
      // a ramp runs from the previous event (a setTarget before it is replaced) / 램프는 이전 이벤트부터
      if (target) { pT = target.t0; pV = target.v0; target = null; }
      const t0 = Number.isFinite(pT) ? pT : e.t;
      const v0 = pV;
      const v1 = e.v;
      const T1 = e.t;
      if (T1 > t0) {
        const ex = e.k === 'exp' && v0 * v1 > 0;
        segs.push({ t0, t1: T1, f: ex ? (t) => v0 * Math.pow(v1 / v0, (t - t0) / (T1 - t0)) : (t) => v0 + (v1 - v0) * ((t - t0) / (T1 - t0)) });
      }
      pT = T1;
      pV = v1;
      continue;
    }
    closeTarget(e.t);
    if (e.k === 'set') { pT = e.t; pV = e.v; segs.push({ t0: e.t, t1: e.t, f: () => e.v }); continue; }
    if (e.k === 'curve') {
      const c = e.c;
      const t0 = e.t;
      const d = e.d;
      const m = c.length;
      segs.push({ t0, t1: t0 + d, f: (t) => {
        if (m === 1) return c[0];
        const x = Math.min(m - 1, Math.max(0, ((t - t0) / d) * (m - 1)));
        const k = Math.min(m - 2, Math.floor(x));
        return c[k] + (c[k + 1] - c[k]) * (x - k);
      }, dens: (m - 1) / Math.max(1e-6, d) });
      pT = t0 + d;
      pV = c[m - 1];
      continue;
    }
    if (e.k === 'target') { target = { t0: e.t, v0: pV, v: e.v, tau: Math.max(1e-4, e.tau) }; continue; }
  }
  let tail = null;
  if (target) {
    const t1 = target.t0 + 7 * target.tau; // within 0.1 % of the target / 목표의 0.1 % 이내
    closeTarget(t1);
    tail = t1;
  }
  return { segs, init, end: pV, first: segs.length ? segs[0].t0 : Infinity, last: segs.length ? Math.max(tail ?? -Infinity, ...segs.map((s) => s.t1)) : -Infinity };
}

/** Value of segments at forward time t. / 순방향 시각 t의 값 */
export function evalAt(A, t) {
  if (!A.segs.length || t < A.first) return A.init;
  let v = A.init;
  for (const s of A.segs) {
    if (t < s.t0) break;
    v = t <= s.t1 ? s.f(t) : s.f(s.t1);
  }
  return v;
}

/** Wrap one AudioParam: record calls instead of scheduling them. / 파라미터 호출을 기록 */
function wrapParam(p, rec) {
  if (rec.params.has(p)) return;
  const events = [];
  rec.params.set(p, events);
  const push = (e) => { e.n = rec.seq++; events.push(e); return p; };
  const fin = (x) => (Number.isFinite(x) ? x : 0);
  p.setValueAtTime = (v, t) => push({ k: 'set', v: fin(v), t: Math.max(0, fin(t)) });
  p.linearRampToValueAtTime = (v, t) => push({ k: 'lin', v: fin(v), t: Math.max(0, fin(t)) });
  p.exponentialRampToValueAtTime = (v, t) => push({ k: 'exp', v: fin(v), t: Math.max(0, fin(t)) });
  p.setTargetAtTime = (v, t, tau) => push({ k: 'target', v: fin(v), t: Math.max(0, fin(t)), tau: fin(tau) });
  p.setValueCurveAtTime = (c, t, d) => push({ k: 'curve', c: Float32Array.from(c), t: Math.max(0, fin(t)), d: Math.max(1e-6, fin(d)) });
  p.cancelScheduledValues = (t) => push({ k: 'cancel', t: Math.max(0, fin(t)) });
  p.cancelAndHoldAtTime = (t) => push({ k: 'hold', t: Math.max(0, fin(t)) });
}

function wrapNode(node, rec) {
  if (!node || typeof node !== 'object' || rec.nodes.has(node)) return node;
  rec.nodes.add(node);
  // eslint-disable-next-line guard-for-in
  for (const k in node) {
    let v;
    try { v = node[k]; } catch { continue; }
    if (typeof AudioParam !== 'undefined' && v instanceof AudioParam) wrapParam(v, rec);
  }
  if (typeof node.start === 'function') {
    const src = { node, start: null, offset: 0, dur: null, stop: null };
    rec.sources.push(src);
    node.start = (when = 0, offset = 0, dur) => { src.start = Math.max(0, Number(when) || 0); src.offset = Math.max(0, Number(offset) || 0); src.dur = Number.isFinite(dur) ? dur : null; };
    node.stop = (when = 0) => { src.stop = Math.max(0, Number(when) || 0); };
  }
  return node;
}

/** Schedule the reflection of every recorded param and source. / 기록된 자동화·시작/정지를 거꾸로 예약 */
function applyMirror(ctx, rec, H, native) {
  const sr = ctx.sampleRate;
  const lenSec = ctx.length / sr;
  for (const [p, events] of rec.params) {
    const P = AudioParam.prototype; // the own-property wrappers shadow these / 래퍼가 가린 원래 메서드
    const init = p.value;
    if (!events.length) continue;
    const A = automationSegments(events, init);
    if (!A.segs.length) continue;
    // mirrored span τ ∈ [τa, τb] ↔ forward t = H − τ ∈ [first, last] / 뒤집힌 구간
    const tauA = Math.max(0, H - A.last);
    const tauB = Math.min(lenSec, H - Math.max(0, A.first));
    if (!(tauB > tauA)) { p.value = evalAt(A, Math.min(H, A.last)); continue; } // nothing of it inside / 범위 밖
    const dens = Math.max(BASE_RATE, ...A.segs.map((s) => s.dens || 0));
    let n = Math.ceil((tauB - tauA) * Math.min(MAX_RATE, dens)) + 1;
    n = Math.max(2, Math.min(MAX_POINTS, n));
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = evalAt(A, H - (tauA + ((tauB - tauA) * i) / (n - 1)));
    try {
      P.setValueAtTime.call(p, curve[0], 0);
      P.setValueCurveAtTime.call(p, curve, tauA + (tauA > 0 ? 1 / sr : 0), Math.max(1 / sr, tauB - tauA - (tauA > 0 ? 1 / sr : 0)));
      if (tauB + 2 / sr < lenSec) P.setValueAtTime.call(p, A.init, tauB + 2 / sr); // before the first event / 첫 이벤트 이전 값
    } catch (err) { console.warn('[Flexatone] mirror automation failed', err); }
  }
  for (const s of rec.sources) {
    if (s.start === null) continue;
    const node = s.node;
    const rate = Number(node.playbackRate?.value) || 1;
    let end = s.stop ?? Infinity;
    if (node.buffer && !node.loop) end = Math.min(end, s.start + (s.dur ?? (node.buffer.duration - s.offset)) / rate);
    else if (s.dur !== null) end = Math.min(end, s.start + s.dur / rate);
    const a = Number.isFinite(end) ? H - end : 0; // mirrored start (never stopped → from 0) / 뒤집힌 시작
    const b = H - s.start; // mirrored stop / 뒤집힌 정지
    if (!(b > 0)) continue; // it only ever played after H / H 이후에만 소리 남
    const st = native.start.get(node);
    const sp = native.stop.get(node);
    try {
      if (node.buffer !== undefined && node.buffer) {
        const skip = Number.isFinite(a) && a < 0 ? -a * rate : 0; // the part before τ = 0 is not heard / τ = 0 이전 부분은 생략
        st.call(node, Math.max(0, a), node.loop ? s.offset : s.offset + skip);
      } else st.call(node, Math.max(0, a));
      if (b < lenSec) sp.call(node, b);
    } catch (err) { console.warn('[Flexatone] mirror start failed', err); }
  }
}

/**
 * Run `fn` (which starts an offline render and returns its promise) with the score mirrored about
 * H seconds of the render (null = the render's own length). Resolves { buffer, mirrored } —
 * mirrored = false when fn created no context synchronously and claimed nothing (the caller
 * should then fall back to a tape reversal). / H를 축으로 악보를 뒤집어 렌더
 * @param {number|null} H
 * @param {() => Promise<AudioBuffer|null>} fn
 * @returns {Promise<{ buffer: AudioBuffer|null, mirrored: boolean }>}
 */
export async function renderMirrored(H, fn) {
  const Native = globalThis.OfflineAudioContext;
  if (!Native) return { buffer: await fn(), mirrored: false };
  const session = { H: Number.isFinite(H) && H > 0 ? H : null, claimed: false, made: 0 };
  class MirrorOfflineAudioContext extends Native {
    constructor(a, b, c) {
      const opt = a && typeof a === 'object' ? { ...a } : { numberOfChannels: a, length: b, sampleRate: c };
      if (!session.claimed && session.H) opt.length = Math.max(opt.length, Math.ceil(session.H * opt.sampleRate) + 2); // room for the reflection / 반사 공간
      super(opt);
      if (session.claimed) return;
      session.made++;
      const H0 = session.H ?? opt.length / opt.sampleRate;
      const rec = { params: new Map(), nodes: new Set(), sources: [], seq: 0 };
      const native = { start: new Map(), stop: new Map() };
      const wrap = (node) => {
        if (node && typeof node.start === 'function' && !native.start.has(node)) { native.start.set(node, node.start); native.stop.set(node, node.stop); }
        return wrapNode(node, rec);
      };
      wrap(this.destination);
      wrap(this.listener);
      const proto = Object.getPrototypeOf(Native.prototype);
      for (const name of new Set([...Object.getOwnPropertyNames(Native.prototype), ...Object.getOwnPropertyNames(proto)])) {
        if (!/^create/.test(name) || name === 'createBuffer' || name === 'createPeriodicWave') continue;
        const f = this[name];
        if (typeof f !== 'function') continue;
        this[name] = (...args) => wrap(f.apply(this, args));
      }
      this.suspend = undefined; // chunked feeders schedule everything up front / 청크 공급기는 한 번에 예약
      const startRendering = this.startRendering;
      this.startRendering = () => {
        applyMirror(this, rec, H0, native);
        return startRendering.call(this);
      };
    }
  }
  globalThis.OfflineAudioContext = MirrorOfflineAudioContext;
  active = session;
  let job;
  try { job = fn(); } finally { globalThis.OfflineAudioContext = Native; active = null; }
  const buffer = await job;
  return { buffer, mirrored: session.made > 0 || session.claimed };
}

/**
 * Settings mirror of a recorded control sequence for the JS banks: frame i of `count` mirrored
 * about H seconds reads the forward frame at H − t. / JS 뱅크용 프레임 순서 뒤집기
 */
export function mirrorFrameIndex(i, count, blockSec, H) {
  const t = H - (i + 1) * blockSec;
  return Math.max(0, Math.min(count - 1, Math.round(t / blockSec)));
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Time mirror: automation reflected, sources keep playing forwards', async (a) => {
  // pure: a ramp 0 → 1 over [1, 2] and a hold / 순수: 램프
  const A = automationSegments([{ k: 'set', v: 0, t: 1, n: 0 }, { k: 'lin', v: 1, t: 2, n: 1 }], 0.5);
  a.near(evalAt(A, 0.5), 0.5, 1e-9, 'before = init');
  a.near(evalAt(A, 1.5), 0.5, 1e-9, 'mid ramp');
  a.near(evalAt(A, 3), 1, 1e-9, 'after = end');
  const B = automationSegments([{ k: 'curve', c: Float32Array.from([0, 1, 0]), t: 0, d: 2, n: 0 }, { k: 'cancel', t: 1.5, n: 1 }], 0);
  a.equal(B.segs.length, 0, 'cancel drops a curve that runs past it');
  const Off = globalThis.OfflineAudioContext;
  if (!Off) { a.ok(true, 'OfflineAudioContext unavailable — skipped'); return; }
  const sr = 8000;
  // gain envelope rising 0 → 1 over 0…1 s on a DC source; mirrored about 2 s: falls 1 → 0 over 1…2 s
  const render = () => {
    const ctx = new globalThis.OfflineAudioContext(1, sr * 2, sr);
    const src = ctx.createConstantSource();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(1, 1);
    src.connect(g).connect(ctx.destination);
    src.start(0);
    src.stop(1.5);
    return ctx.startRendering();
  };
  const { buffer, mirrored } = await renderMirrored(2, render);
  a.ok(mirrored, 'mirrored context used');
  const d = buffer.getChannelData(0);
  const at = (s) => d[Math.min(d.length - 1, Math.round(s * sr))];
  a.near(at(0.25), 0, 0.02, 'silent before the mirrored start (2 − 1.5)');
  a.near(at(0.75), 1, 0.02, 'held end value after the start');
  a.near(at(1.25), 0.75, 0.03, 'ramp reflected: 1 → 0 over 1…2 s');
  a.near(at(1.75), 0.25, 0.03, 'ramp reflected (late)');
  // outside a mirrored render nothing changes / 범위 밖에서는 그대로
  a.equal(globalThis.OfflineAudioContext, Off, 'constructor restored');
  const plain = await render();
  a.near(plain.getChannelData(0)[Math.round(0.25 * sr)], 0.25, 0.03, 'plain render untouched');
});
