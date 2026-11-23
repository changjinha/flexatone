/**
 * Flexatone — studios/field/field-layers.js
 * Layer 2 (studios): Field Studio vector-field layers on the absolute pitch × time plane.
 * 계층 2 (studios): 필드 스튜디오 벡터장 레이어 — 절대 음고 × 시간 평면.
 *
 * Pure: no DOM, no Web Audio. / 순수 모듈: DOM·Web Audio 없음.
 *
 * Coordinates / 좌표
 *   Every layer, node and range lives in absolute (seconds, MIDI) — one field shared by all
 *   particles, exactly what the piano roll shows. Distances use "field units":
 *     u = sec / T_REF,  w = midi / P_REF     (T_REF = 4 s, P_REF = 24 semitones)
 *   모든 레이어·노드·범위는 절대 (초, MIDI). 거리는 필드 단위(u, w)로 계산.
 *
 * Layer / 레이어
 *   { id, name, enabled, mode: 'add' | 'multiply' | 'replace', amount ∈ [−1, 1],
 *     range: { full, t0, t1, m0, m1 }, shape: 'rect' | 'ellipse', invert, feather (field units, 0 = hard),
 *     nodes: [{ id, type, sec, midi, strength, radius }], turbulence, turbFreq, fieldPhase,
 *     flowAngle (deg, +90 = pitch up), flowStrength }
 *
 * Range weight / 범위 가중치
 *   full → 1 everywhere.  Otherwise sdf of the box/ellipse in field units,
 *   w = 1 − smoothstep(0, feather, sdf)   (feather 0 = hard cut);  invert → 1 − w.
 *
 * Stack (bottom → top, list order) / 스택 (아래 → 위, 목록 순서)
 *   acc = 0
 *   add      : acc += w · amount · V_L
 *   multiply : acc *= 1 + w · amount           (−1 = silence below, +1 = double)
 *   replace  : acc  = (1 − w) · acc + w · V_L
 */

import { clamp } from '../../core/math-utils.js';

export const T_REF = 4;
export const P_REF = 24;
export const LAYER_MODES = Object.freeze(['add', 'multiply', 'replace']);
export const LAYER_SHAPES = Object.freeze(['rect', 'ellipse']);
export const NODE_TYPES = Object.freeze(['attractor', 'repeller', 'vortex']);

let seq = 0;
const uid = (p) => { seq += 1; return `${p}_${Date.now().toString(36).slice(-4)}${seq}`; };

export function createForceNode(type = 'vortex', sec = 1.6, midi = 60) {
  return { id: uid('fn'), type: NODE_TYPES.includes(type) ? type : 'vortex', sec, midi, strength: 1.25, radius: 0.28 };
}

/** A field layer. Local layers start with a box range; the main layer covers everything. */
export function createFieldLayer(opts = {}) {
  return {
    id: opts.id || uid('fl'),
    name: opts.name || 'Field',
    enabled: true,
    mode: LAYER_MODES.includes(opts.mode) ? opts.mode : 'add',
    amount: opts.amount ?? 1,
    range: { full: true, t0: 0, t1: 4, m0: 48, m1: 72, ...(opts.range || {}) },
    shape: 'rect',
    invert: false,
    feather: opts.feather ?? 0.08,
    nodes: opts.nodes || [],
    turbulence: opts.turbulence ?? 0,
    turbFreq: opts.turbFreq ?? 3.5,
    fieldPhase: opts.fieldPhase ?? 0,
    flowAngle: opts.flowAngle ?? 0,
    flowStrength: opts.flowStrength ?? 0,
  };
}

const smoothstep = (e0, e1, x) => {
  if (e1 <= e0) return x <= e0 ? 0 : 1;
  const u = clamp((x - e0) / (e1 - e0), 0, 1);
  return u * u * (3 - 2 * u);
};

/** Signed distance (field units, < 0 inside) to a layer's range. / 범위 경계까지 부호 거리 */
export function layerSdf(L, sec, midi) {
  const r = L.range || {};
  const cx = (r.t0 + r.t1) / 2 / T_REF;
  const cy = (r.m0 + r.m1) / 2 / P_REF;
  const hw = Math.max(1e-3, Math.abs(r.t1 - r.t0) / 2 / T_REF);
  const hh = Math.max(1e-3, Math.abs(r.m1 - r.m0) / 2 / P_REF);
  const dx = sec / T_REF - cx;
  const dy = midi / P_REF - cy;
  if (L.shape === 'ellipse') return (Math.hypot(dx / hw, dy / hh) - 1) * Math.min(hw, hh);
  return Math.max(Math.abs(dx) - hw, Math.abs(dy) - hh);
}

/** Influence of a layer at (sec, midi) in [0, 1]. / 레이어 영향도 */
export function layerWeight(L, sec, midi) {
  if (!L || L.enabled === false) return 0;
  if (L.range?.full !== false) return 1;
  const w = 1 - smoothstep(0, Math.max(0, L.feather || 0), layerSdf(L, sec, midi));
  return L.invert ? 1 - w : w;
}

const hash2 = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
};
function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** Divergence-free turbulence: v = (∂N/∂y, −∂N/∂x). / 발산 없는 컬 노이즈 */
export function curlNoise(u, w, freq, phase) {
  const eps = 0.01;
  const nx = u * freq + phase;
  const ny = w * freq - phase * 0.7;
  const dNdy = (smoothNoise(nx, ny + eps) - smoothNoise(nx, ny - eps)) / (2 * eps);
  const dNdx = (smoothNoise(nx + eps, ny) - smoothNoise(nx - eps, ny)) / (2 * eps);
  return { vt: dNdy, vy: -dNdx };
}

/**
 * A layer's own field (field units per unit time) at (sec, midi), before range and blend.
 * `mod` = region modulation { nodes, turb } (1 = unchanged).
 * 레이어 자체의 장 (범위·블렌드 적용 전).
 */
export function layerVector(L, sec, midi, mod = { nodes: 1, turb: 1 }) {
  const u = sec / T_REF;
  const w = midi / P_REF;
  let vt = 0;
  let vy = 0;
  const phase = (L.fieldPhase || 0) * Math.PI * 2;
  for (const node of L.nodes || []) {
    const s = String(node.id).charCodeAt(2) || 0;
    const nx = node.sec / T_REF + 0.06 * Math.sin(phase + s);
    const ny = node.midi / P_REF + 0.06 * Math.cos(phase + s);
    const dx = nx - u;
    const dy = ny - w;
    const r2 = dx * dx + dy * dy + 0.012;
    const rad = Math.max(0.02, node.radius || 0.28);
    const str = (node.strength || 0) * Math.exp(-r2 / (2 * rad * rad)) * (mod.nodes ?? 1);
    if (node.type === 'attractor') { vt += str * dx * 2.2; vy += str * dy * 2.2; }
    else if (node.type === 'repeller') { vt -= str * dx * 2.5; vy -= str * dy * 2.5; }
    else { vt += -str * dy * 3.2; vy += str * dx * 3.2; }
  }
  const turb = (L.turbulence || 0) * (mod.turb ?? 1);
  if (turb > 0) {
    const cn = curlNoise(u, w, L.turbFreq || 3.5, phase);
    vt += turb * cn.vt * 0.6;
    vy += turb * cn.vy * 0.9;
  }
  const fs = L.flowStrength || 0;
  if (Math.abs(fs) > 1e-6) {
    const a = ((L.flowAngle || 0) * Math.PI) / 180;
    vt += fs * Math.cos(a);
    vy += fs * Math.sin(a);
  }
  return { vt, vy };
}

/**
 * Composite of every layer at (sec, midi), field units. / 모든 레이어의 합성 (필드 단위)
 * @returns {{ vt: number, vy: number }}
 */
export function layerStack(layers, sec, midi, mod) {
  let vt = 0;
  let vy = 0;
  for (const L of layers || []) {
    const wt = layerWeight(L, sec, midi);
    if (wt <= 1e-6) continue;
    const mode = L.mode || 'add';
    if (mode === 'multiply') {
      const f = 1 + wt * clamp(L.amount ?? 0, -1, 1);
      vt *= f;
      vy *= f;
    } else if (mode === 'replace') {
      const V = layerVector(L, sec, midi, mod);
      vt = (1 - wt) * vt + wt * V.vt;
      vy = (1 - wt) * vy + wt * V.vy;
    } else {
      const V = layerVector(L, sec, midi, mod);
      const k = wt * clamp(L.amount ?? 1, -1, 1);
      vt += k * V.vt;
      vy += k * V.vy;
    }
  }
  return { vt, vy };
}

