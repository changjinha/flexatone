/**
 * Flexatone — studios/field/vector-field-engine.js
 * Layer 2 (studios): Field Studio physics core — vector field + 2nd-order particle integrator.
 * 계층 2 (studios): 필드 스튜디오 물리 코어 — 벡터장과 2차 입자 적분기.
 *
 * Pure: no DOM, no Web Audio. Imports core/* and modules/* only.
 * 순수 모듈: DOM·Web Audio 없음. core/*, modules/*만 import.
 *
 * Edit-time baking / 에디팅 시점 베이킹
 *   `bakeFieldVoices(params)` integrates every particle once and memoises the result by a
 *   signature of the physics inputs. Playback and WAV export only read `bakedPoints`; they
 *   never evaluate the field. / 재생·렌더링은 베이킹된 배열만 읽음.
 *
 * Physics / 물리
 *   The integrator runs in each particle's normalized frame (t: start → end, y: F₀ → F₁), but the
 *   spatial field lives on the ABSOLUTE pitch × time plane (field-layers.js), shared by every
 *   particle. midi = F₀ + y·(F₁ − F₀) and sec = start + t·dur are linear, so a field-unit vector
 *   (du, dw) becomes (du·T_REF/dur, dw·P_REF/(F₁ − F₀)) in the particle frame.
 *   적분은 입자 정규화 좌표에서, 공간 장은 절대 음고 × 시간 평면(모든 입자가 공유)에서 계산.
 *   field  F = 1·t̂ + guide pull (per particle) + layer stack (nodes / turbulence / flow, ordered,
 *              add · multiply · replace, each inside its own range) + region push
 *              + pitch-well force + N-body coupling;  ODE mode pins F_t = 1.
 *   Particles bounce / clamp at the absolute pitch bounds FIELD_PITCH_MIN … FIELD_PITCH_MAX.
 *   particle  a = (F − v)·(γ/m)   (drag-relaxed 2nd order), midpoint (RK2) step, dt = 1/220.
 *   boundary  Elastic Bounce (restitution e) · Soft Clamp · Octave Wrap.
 * Guiding curves reuse modules/curve-engine.js (9 engines, Multi-Morph & Custom excluded).
 */

import { extendSampled } from '../../core/line-clip.js';
import { clamp } from '../../core/math-utils.js';
import { midiToFreq, freqToMidi } from '../../core/units.js';
import { createDefaultCurveParams } from '../../core/state.js';
import { createDefaultTremolo } from '../../core/tremolo-config.js';
import { evaluateCurveObjectY } from '../../modules/curve-engine.js';
import { regionModulation } from './field-regions.js';
import { T_REF, P_REF, NODE_TYPES, createForceNode, createFieldLayer, layerStack } from './field-layers.js';

export { NODE_TYPES, createForceNode, createFieldLayer };
/** Absolute pitch bounds of the field world (particles bounce here). / 장 세계의 음고 경계 */
export const FIELD_PITCH_MIN = 12;
export const FIELD_PITCH_MAX = 120;
export const MAIN_LAYER_ID = 'fl_main';

export const FIELD_STEPS = 220;
/** Guiding engines offered by the Field Studio (Multi-Morph and Custom excluded). */
export const GUIDING_ENGINES = Object.freeze(['harmonic', 'damped', 'anticipation', 'ratchet', 'chirp', 'bounce', 'bezier', 'plateau', 'polynomial']);
export const WELL_GRIDS = Object.freeze(['none', '12tet', '24tet', 'pentatonic', 'overtone']);
export const BOUNDARY_MODES = Object.freeze(['bounce', 'clamp', 'wrap']);
export const RETRO_MODES = Object.freeze(['unfold', 'mirror', 'monotonic']);

/** Guiding curve y(t) through the shared curve engine. / 공용 곡선 엔진으로 가이드 곡선 평가 */
export function evalGuidingCurve(t, guiding) {
  // 'custom' = a guide imported from a Glissando trajectory (breakpoints in guiding.customPoints) / 글리산도 궤적에서 불러온 가이드
  const imported = guiding?.engine === 'custom' && Array.isArray(guiding.customPoints) && guiding.customPoints.length >= 2;
  const engine = imported || GUIDING_ENGINES.includes(guiding?.engine) ? guiding.engine : 'harmonic';
  return evaluateCurveObjectY({ ...guiding, engine, reverse: false, inverse: false }, clamp(t, 0, 1));
}

/** Linear map between a particle's normalized frame and absolute (sec, MIDI). / 입자 좌표 ↔ 절대 좌표 */
export function particleFrame(voice) {
  const dur = Math.max(0.05, voice?.duration || 1);
  const m0 = voice?.f0Midi ?? 60;
  let span = (voice?.f1Midi ?? 72) - m0;
  if (Math.abs(span) < 1e-3) span = span < 0 ? -1e-3 : 1e-3;
  return { start: voice?.startTime || 0, dur, m0, span };
}

const PARTICLE_COLORS = ['#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c'];

/** A particle voice (JSON-safe; bakedPoints are never stored here). / 입자 보이스 */
export function createParticleVoice(idx = 0, id = `pv_${Math.random().toString(36).slice(2, 8)}`) {
  const pairs = [[48, 72], [60, 43], [55, 79], [64, 50]];
  const [m0, m1] = pairs[idx % pairs.length];
  return {
    id,
    name: `Particle ${idx + 1}`,
    color: PARTICLE_COLORS[idx % PARTICLE_COLORS.length],
    solo: false,
    muted: false,
    f0Midi: m0,
    f1Midi: m1,
    startTime: Number((idx * 0.35).toFixed(2)),
    duration: 3.2,
    baseGain: 0.85,
    mass: Number((1.0 + idx * 0.6).toFixed(2)),
    drag: 3.8,
    launchAngle: idx % 2 === 0 ? 15 : -15,
    launchSpeed: 1.0,
    restitution: 0.75,
    boundaryMode: 'bounce',
    coupling: idx === 0 ? 0 : -0.35,
    speedToGain: 0.45,
    curvToBright: 0.6,
    retroMode: 'unfold',
    timbre: { sine: 0.7, tri: 0.25, saw: 0.15, sqr: 0.05, rich: 0.25 },
    tremolo: createDefaultTremolo(), // sonification only; not part of the bake signature / 음향화 전용
  };
}

/** Default Field Studio document (stored in appState.studioParams.field). / 기본 필드 문서 */
export function createDefaultFieldParams() {
  // Fixed ids keep the default document (and its bake signature) identical on every call.
  // 고정 id로 기본 문서(와 베이킹 서명)가 매번 동일하게 유지됨.
  const v0 = createParticleVoice(0, 'pv_default_1');
  const v1 = createParticleVoice(1, 'pv_default_2');
  return {
    flowMode: '2d',
    fieldEnabled: true, // false = pure guiding-curve glissando (no physics) / false = 순수 가이드 곡선
    fieldCoord: 2, // absolute pitch × time layers / 절대 음고 × 시간 레이어
    guideAttraction: 1.6,
    wellGrid: '12tet',
    wellStrength: 0.25,
    // Ordered bottom → top. The main field covers the full pitch / time range by default.
    // 아래 → 위 순서. 메인 장은 기본적으로 음고·시간 전체 범위.
    layers: [createFieldLayer({
      id: MAIN_LAYER_ID,
      name: 'Main field',
      turbulence: 0.35,
      turbFreq: 3.5,
      nodes: [
        { id: 'fn_1', type: 'vortex', sec: 1.44, midi: 61.2, strength: 1.35, radius: 0.28 },
        { id: 'fn_2', type: 'attractor', sec: 2.62, midi: 69.1, strength: 1.1, radius: 0.32 },
      ],
    })],
    activeLayerId: MAIN_LAYER_ID,
    regions: [],
    activeRegionId: '',
    guiding: {
      ...createDefaultCurveParams(),
      engine: 'harmonic',
      alpha: 50, x1: 0.25, x2: 0.75,
      dampA: 0.4, ratN: 6, ratSig: 0.35, chirpA: 0.15, chirpF1: 12, bounceP: 1.5,
      bezX1: 0.25, bezY1: 0, bezX2: 0.75, bezY2: 1,
      polyPoints: [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }],
    },
    voices: [v0, v1],
    activeVoiceId: v0.id,
    view: { viewMode: 'piano', showArrows: true, showWells: true, showGuide: true, showRegions: true, showLayers: true, arrowDensity: 34, arrowSize: 1, arrowWidth: 1.1, tMin: 0, tMax: 4, midiMin: 40, midiMax: 80 },
    cueSec: 0,
  };
}

export class VectorFieldPluginEngine {
  static hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  static smoothNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = this.hash2(ix, iy);
    const b = this.hash2(ix + 1, iy);
    const c = this.hash2(ix, iy + 1);
    const d = this.hash2(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  /** Divergence-free turbulence: v = (∂N/∂y, −∂N/∂x). / 발산 없는 컬 노이즈 */
  static curlNoise(t, y, freq, phase) {
    const eps = 0.01;
    const nx = t * freq + phase;
    const ny = y * freq - phase * 0.7;
    const dNdy = (this.smoothNoise(nx, ny + eps) - this.smoothNoise(nx, ny - eps)) / (2 * eps);
    const dNdx = (this.smoothNoise(nx + eps, ny) - this.smoothNoise(nx - eps, ny)) / (2 * eps);
    return { vt: dNdy, vy: -dNdx };
  }

  /** Target pitch of the nearest well for a given grid (MIDI). / 가장 가까운 음정 우물 */
  static wellTargetMidi(midi, hz, gridType, f0, f1) {
    if (gridType === '12tet') return Math.round(midi);
    if (gridType === '24tet') return Math.round(midi * 2) / 2;
    if (gridType === 'pentatonic') {
      const PENTA = [0, 2, 4, 7, 9];
      const oct = Math.floor(midi / 12);
      const pc = ((midi % 12) + 12) % 12;
      let best = 0;
      let bestD = 99;
      for (const p of PENTA) {
        const d = Math.abs(pc - p);
        if (d < bestD) { bestD = d; best = p; }
      }
      return oct * 12 + best;
    }
    if (gridType === 'overtone') {
      const fund = Math.min(f0, f1);
      return freqToMidi(fund * Math.max(1, Math.round(hz / fund)));
    }
    return midi;
  }

  /** Gaussian-windowed restoring force toward the nearest pitch well. / 음정 우물 복원력 */
  static evalPitchWellForce(yNorm, voice, fieldCfg, scale = 1) {
    const strength = (fieldCfg.wellStrength || 0) * scale;
    const gridType = fieldCfg.wellGrid || 'none';
    if (strength <= 1e-4 || gridType === 'none') return 0;
    const f0 = midiToFreq(voice.f0Midi);
    const f1 = midiToFreq(voice.f1Midi);
    const hz = clamp(f0 * Math.pow(f1 / f0, yNorm), 20, 20000);
    const midi = freqToMidi(hz);
    const targetHz = midiToFreq(this.wellTargetMidi(midi, hz, gridType, f0, f1));
    const targetY = Math.log(targetHz / f0) / Math.max(1e-4, Math.log(f1 / f0));
    const dy = targetY - yNorm;
    const width = 0.035;
    return strength * 12.0 * dy * Math.exp(-(dy * dy) / (2 * width * width));
  }

  /** Field velocity (vt, vy) at normalized (t, y) for one voice. / 정규화 좌표의 장 속도 */
  static evaluateFieldAt(t, y, voice, fieldCfg, guidingCfg, allBakedVoices = []) {
    if (fieldCfg?.fieldEnabled === false) return { vt: 1, vy: 0 };
    let vt = 1.0;
    let vy = 0.0;
    const fr = particleFrame(voice);
    const sec = fr.start + t * fr.dur;
    const midi = fr.m0 + y * fr.span;
    const mod = regionModulation(fieldCfg.regions, sec, midi);

    // Guide pull: toward this particle's own glissando shape / 가이드 인력: 입자 자신의 글리산도 모양
    const guidePull = (fieldCfg.guideAttraction ?? 1.8) * mod.guide;
    if (guidePull > 0) {
      const yTarget = evalGuidingCurve(t, guidingCfg);
      const eps = 1e-3;
      const dYdt = (evalGuidingCurve(Math.min(1, t + eps), guidingCfg) - evalGuidingCurve(Math.max(0, t - eps), guidingCfg)) / (2 * eps);
      vy += dYdt * Math.min(1, guidePull * 0.5) + guidePull * 3.5 * (yTarget - y);
    }

    // Shared absolute field (layers + region push), field units → particle frame
    // 공유 절대 장 (레이어 + 영역 흐름), 필드 단위 → 입자 좌표
    const L = layerStack(fieldCfg.layers, sec, midi, mod);
    vt += (L.vt + mod.pushT) * (T_REF / fr.dur);
    vy += (L.vy + mod.pushY) * (P_REF / fr.span);

    vy += this.evalPitchWellForce(y, voice, fieldCfg, mod.wells);

    const coupling = voice.coupling || 0;
    if (Math.abs(coupling) > 1e-3 && allBakedVoices.length > 0) {
      for (const other of allBakedVoices) {
        if (other.id === voice.id || !other.bakedPoints || other.bakedPoints.length === 0) continue;
        const idx = Math.min(other.bakedPoints.length - 1, Math.max(0, Math.round(t * (other.bakedPoints.length - 1))));
        const dy = other.bakedPoints[idx].y - y;
        const dist = Math.abs(dy) + 0.04;
        vy += (coupling * 1.4 * Math.sign(dy)) / (dist * 4.0);
      }
    }

    if (fieldCfg.flowMode === 'ode') vt = 1.0;
    else vt = clamp(vt, -1.6, 2.4);
    return { vt, vy };
  }

  /**
   * Integrate one particle (midpoint / RK2, 220 steps) and return its baked points
   * { s, t, y, vt, vy, speed, curv, normSpeed, normCurv }. Does not mutate `voice`.
   * 입자 하나를 적분해 베이킹된 점 배열을 반환 (voice는 변경하지 않음).
   */
  static bakeVoice(voice, fieldCfg, guidingCfg, otherVoices = []) {
    if (fieldCfg?.fieldEnabled === false) return this.bakePureGuide(guidingCfg);
    const steps = FIELD_STEPS;
    const dt = 1.0 / steps;
    const mass = clamp(voice.mass || 1.0, 0.1, 8.0);
    const drag = clamp(voice.drag || 3.5, 0.2, 15.0);
    const restitution = clamp(voice.restitution ?? 0.75, 0, 1.0);
    const bMode = voice.boundaryMode || 'bounce';

    let t = 0.0;
    let y = 0.0;
    const rad = ((voice.launchAngle || 0) * Math.PI) / 180;
    const v0 = voice.launchSpeed || 1.0;
    let vt = Math.cos(rad) * v0;
    let vy = Math.sin(rad) * v0 * 2.0;

    // Absolute pitch bounds of the field world, in this particle's y / 장 세계 음고 경계 (입자 y 기준)
    const fr = particleFrame(voice);
    const ya = (FIELD_PITCH_MIN - fr.m0) / fr.span;
    const yb = (FIELD_PITCH_MAX - fr.m0) / fr.span;
    const yMinBound = Math.min(ya, yb);
    const yMaxBound = Math.max(ya, yb);

    const pts = [];
    let maxSpeed = 1e-4;
    let maxCurv = 1e-4;

    for (let i = 0; i <= steps; i++) {
      const field = this.evaluateFieldAt(t, y, voice, fieldCfg, guidingCfg, otherVoices);
      const speed = Math.hypot(vt, vy);
      if (speed > maxSpeed) maxSpeed = speed;
      pts.push({ s: i / steps, t, y, vt, vy, speed, curv: 0 });
      if (i === steps) break;

      const accelScale = drag / mass;
      const at = (field.vt - vt) * accelScale;
      const ay = (field.vy - vy) * accelScale;
      const vtMid = vt + 0.5 * at * dt;
      const vyMid = vy + 0.5 * ay * dt;
      const tMid = t + 0.5 * vt * dt;
      const yMid = y + 0.5 * vy * dt;
      const fieldMid = this.evaluateFieldAt(tMid, yMid, voice, fieldCfg, guidingCfg, otherVoices);
      const atMid = (fieldMid.vt - vtMid) * accelScale;
      const ayMid = (fieldMid.vy - vyMid) * accelScale;

      vt += atMid * dt;
      vy += ayMid * dt;
      if (fieldCfg.flowMode === 'ode') {
        vt = 1.0;
        t = (i + 1) * dt;
      } else {
        t = clamp(t + vtMid * dt, 0, 1.25);
      }
      y += vyMid * dt;

      if (bMode === 'bounce') {
        if (y > yMaxBound) {
          y = yMaxBound - (y - yMaxBound) * restitution;
          vy = -Math.abs(vy) * restitution;
        } else if (y < yMinBound) {
          y = yMinBound + (yMinBound - y) * restitution;
          vy = Math.abs(vy) * restitution;
        }
      } else if (bMode === 'wrap') {
        if (y > 1.0) y -= 1.0;
        else if (y < 0.0) y += 1.0;
      } else {
        y = clamp(y, yMinBound, yMaxBound);
      }
    }

    return this.finishPoints(pts, dt, maxSpeed, maxCurv);
  }

  /**
   * Vector field OFF: the trajectory is the guiding curve itself, y = g(t), t = s.
   * Same point shape as the physics bake, so playback / export / Bake-to-Glissando are unchanged.
   * 벡터장 OFF: 궤적 = 가이드 곡선 그대로 (물리 없음). 점 형식은 동일.
   */
  static bakePureGuide(guidingCfg) {
    const steps = FIELD_STEPS;
    const dt = 1.0 / steps;
    const pts = [];
    let maxSpeed = 1e-4;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = evalGuidingCurve(t, guidingCfg);
      const vy = (evalGuidingCurve(Math.min(1, t + dt), guidingCfg) - evalGuidingCurve(Math.max(0, t - dt), guidingCfg)) / ((Math.min(1, t + dt) - Math.max(0, t - dt)) || dt);
      const speed = Math.hypot(1, vy);
      if (speed > maxSpeed) maxSpeed = speed;
      pts.push({ s: t, t, y, vt: 1, vy, speed, curv: 0 });
    }
    return this.finishPoints(pts, dt, maxSpeed, 1e-4);
  }

  /** Curvature + normalisation shared by both bakes. / 곡률·정규화 (공용) */
  static finishPoints(pts, dt, maxSpeed, maxCurv) {
    for (let i = 1; i < pts.length - 1; i++) {
      const d1x = pts[i].t - pts[i - 1].t;
      const d1y = pts[i].y - pts[i - 1].y;
      const d2x = pts[i + 1].t - pts[i].t;
      const d2y = pts[i + 1].y - pts[i].y;
      const angleDiff = Math.abs(Math.atan2(d2y, d2x) - Math.atan2(d1y, d1x));
      const curv = Math.min(Math.PI, angleDiff) / dt;
      pts[i].curv = curv;
      if (curv > maxCurv) maxCurv = curv;
    }
    for (const p of pts) {
      p.normSpeed = clamp(p.speed / maxSpeed, 0, 1);
      p.normCurv = clamp(p.curv / maxCurv, 0, 1);
    }
    return pts;
  }
}

// --------------------------------------------------------------------------
// Edit-time bake cache / 에디팅 시점 베이크 캐시
// --------------------------------------------------------------------------

const PHYSICS_KEYS = ['id', 'f0Midi', 'f1Midi', 'startTime', 'duration', 'mass', 'drag', 'launchAngle', 'launchSpeed', 'restitution', 'boundaryMode', 'coupling'];
let bakeCache = { key: '', map: new Map(), bakeCount: 0 };

/** Signature of every input the integrator reads (sonification params excluded). */
export function fieldPhysicsSignature(params) {
  const p = params || {};
  if (p.fieldEnabled === false) return JSON.stringify(['pure', p.guiding, (p.voices || []).map((v) => v.id)]);
  return JSON.stringify([
    p.flowMode, p.guideAttraction, p.wellGrid, p.wellStrength,
    p.layers || [], p.guiding, p.regions || [],
    (p.voices || []).map((v) => [...PHYSICS_KEYS.map((k) => v[k]), v.link?.on ? v.link.id : 0]),
  ]);
}

/**
 * Bake all particle voices in order (each later voice feels the earlier ones through
 * N-body coupling). Memoised: re-integrates only when the physics signature changes.
 * 모든 입자를 순서대로 베이킹 (물리 서명이 바뀔 때만 다시 적분).
 * @returns {Map<string, object[]>} voice id → baked points
 */
export function bakeFieldVoices(params) {
  params = migrateFieldDoc(params);
  const key = fieldPhysicsSignature(params);
  if (key === bakeCache.key) return bakeCache.map;
  const map = new Map();
  const bakedSoFar = [];
  const linkBake = new Map(); // link id → baked points: linked pieces are one trajectory (core/line-clip.js) / 링크 조각 = 같은 궤적
  for (const v of params.voices || []) {
    const shared = v.link?.on ? linkBake.get(v.link.id) : null;
    if (shared) { map.set(v.id, shared); continue; } // not integrated again, not felt twice by coupling / 다시 적분하지 않음
    const pts = VectorFieldPluginEngine.bakeVoice(v, params, params.guiding, bakedSoFar);
    map.set(v.id, pts);
    if (v.link?.on) linkBake.set(v.link.id, pts);
    bakedSoFar.push({ id: v.id, bakedPoints: pts });
  }
  bakeCache = { key, map, bakeCount: bakeCache.bakeCount + 1 };
  return map;
}

/** How many times the integrator actually ran (for diagnostics / self-check). */
export function getBakeCount() {
  return bakeCache.bakeCount;
}

/**
 * Read a baked trajectory at fraction `frac` of the voice's duration.
 *  unfold   : parametric — the s-axis is time, so retrograde loops are heard in order.
 *  mirror   : retrograde about the reversal start — wherever time runs backwards the path is reflected
 *             (t' = 2·T₀ − t, T₀ = time where the reversal began), so the whole path is heard forwards on the
 *             time axis; the output time is the cumulative Σ|Δt|, clipped at the voice's end.
 *  monotonic: first sample whose field time t ≥ frac (loops are skipped).
 * Pure array lookup (no field math). / 베이킹 배열 조회 (벡터장 연산 없음)
 * @returns {{ y: number, gainMod: number, curv: number }}
 */
/**
 * lookupBakedSample that also reads past the trajectory's ends (an extended particle, core/line-clip.js):
 * pitch goes on with the end tangent, speed / curvature hold their end values. / 끝 너머까지 읽기 (접선 연장)
 */
export function lookupBakedSampleExt(v, pts, frac) {
  if (frac >= 0 && frac <= 1) return lookupBakedSample(v, pts, frac);
  const edge = lookupBakedSample(v, pts, frac < 0 ? 0 : 1);
  return { ...edge, y: extendSampled((f) => lookupBakedSample(v, pts, f).y, frac) };
}

export function lookupBakedSample(v, pts, frac) {
  if (!pts || pts.length === 0) return { y: frac, gainMod: 1, curv: 0 };
  const s2g = v.speedToGain ?? 0;
  if (v.retroMode === 'mirror') {
    // Output time τ_i = t₀ + Σ|Δt|: a backwards stretch is reflected about the point where it began.
    // 출력 시간 τ = t₀ + Σ|Δt| — 역행이 시작된 점을 기준으로 뒤로 가는 구간을 반사
    let tau = pts[0].t;
    let i1 = 0;
    for (let i = 1; i < pts.length; i++) {
      const nt = tau + Math.abs(pts[i].t - pts[i - 1].t);
      if (nt >= frac) {
        const span = nt - tau;
        const a = span > 1e-9 ? (frac - tau) / span : 0;
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const spd = p0.normSpeed + a * (p1.normSpeed - p0.normSpeed);
        return { y: p0.y + a * (p1.y - p0.y), gainMod: clamp(1 - s2g * 0.65 + s2g * spd, 0.05, 1.4), curv: p0.normCurv + a * (p1.normCurv - p0.normCurv) };
      }
      tau = nt;
      i1 = i;
    }
    const last = pts[i1];
    return { y: last.y, gainMod: clamp(1 - s2g * 0.65 + s2g * last.normSpeed, 0.05, 1.4), curv: last.normCurv };
  }
  if (v.retroMode !== 'monotonic') {
    const idxFloat = clamp(frac, 0, 1) * (pts.length - 1);
    const i0 = Math.floor(idxFloat);
    const i1 = Math.min(pts.length - 1, i0 + 1);
    const a = idxFloat - i0;
    const p0 = pts[i0];
    const p1 = pts[i1];
    const y = p0.y + a * (p1.y - p0.y);
    const spd = p0.normSpeed + a * (p1.normSpeed - p0.normSpeed);
    const curv = p0.normCurv + a * (p1.normCurv - p0.normCurv);
    return { y, gainMod: clamp(1 - s2g * 0.65 + s2g * spd, 0.05, 1.4), curv };
  }
  let best = pts[0];
  for (let i = 0; i < pts.length; i++) {
    best = pts[i];
    if (pts[i].t >= frac) break;
  }
  return { y: best.y, gainMod: clamp(1 - s2g * 0.65 + s2g * best.normSpeed, 0.05, 1.4), curv: best.normCurv };
}

/** True when a baked trajectory moves backwards in time anywhere (2D flow loops). */
export function hasRetrograde(pts) {
  for (let i = 1; i < (pts?.length || 0); i++) if (pts[i].t < pts[i - 1].t - 1e-5) return true;
  return false;
}

/**
 * One-time conversion of a pre-layer document (per-particle normalized nodes / regions,
 * top-level turbulence) to absolute layers, mapped through the active particle.
 * Pure and deterministic, so an unedited old document converts identically on every read.
 * 레이어 이전 문서(입자 정규화 좌표)를 활성 입자 기준으로 절대 좌표 레이어로 변환 (결정적).
 */
export function migrateFieldDoc(p) {
  if (!p || !Array.isArray(p.nodes)) return p;
  const v = (p.voices || []).find((x) => x.id === p.activeVoiceId) || (p.voices || [])[0];
  const fr = particleFrame(v);
  const toSec = (x) => Number((fr.start + x * fr.dur).toFixed(3));
  const toMidi = (y) => Number((fr.m0 + y * fr.span).toFixed(2));
  const main = createFieldLayer({
    id: MAIN_LAYER_ID,
    name: 'Main field',
    turbulence: p.turbulence ?? 0,
    turbFreq: p.turbFreq ?? 3.5,
    fieldPhase: p.fieldPhase ?? 0,
    nodes: p.nodes.map((n) => ({ id: n.id, type: n.type, sec: toSec(n.x), midi: toMidi(n.y), strength: n.strength, radius: n.radius })),
  });
  const regions = (p.regions || []).map((r) => ({
    ...r,
    x: toSec(r.x),
    y: toMidi(r.y),
    w: Number((r.w * fr.dur).toFixed(3)),
    h: Number(Math.abs(r.h * fr.span).toFixed(2)),
  }));
  return { ...p, fieldCoord: 2, layers: [main], activeLayerId: MAIN_LAYER_ID, regions, nodes: null, turbulence: null, turbFreq: null, fieldPhase: null };
}
