/**
 * Flexatone — studios/field/field-regions.js
 * Layer 2 (studios): Field Studio local regions — spatial masks that scale field components
 * (guide pull, force nodes, turbulence, pitch wells) and add a local flow push inside a shape.
 * 계층 2 (studios): 필드 스튜디오 국소 영역 — 도형 안에서 장 성분(가이드·노드·난류·우물)의
 * 세기를 조절하고 국소 흐름 벡터를 더하는 공간 마스크.
 *
 * Pure: no DOM, no Web Audio. / 순수 모듈: DOM·Web Audio 없음.
 *
 * Region (absolute pitch × time, same frame as field layers) / 영역 (절대 음고 × 시간)
 *   { id, enabled, shape: 'rect' | 'ellipse', x (centre, s), y (centre, MIDI), w (half-width, s),
 *     h (half-height, semitones), feather (soft-edge width, field units), invert,
 *     gain: { guide, nodes, turb, wells }, flowAngle (deg, +90 = pitch up), flowStrength }
 *
 * Weight / 가중치 — distances in field units (s / T_REF, semitones / P_REF)
 *   sdf  rect: max(|dx| − w, |dy| − h)      ellipse: (‖(dx/w, dy/h)‖ − 1) · min(w, h)
 *   w(t, y) = 1 − smoothstep(0, feather, sdf)   (invert → 1 − w)
 * Modulation / 변조
 *   mult_c = Π_regions lerp(1, gain_c, w)      push = Σ_regions w · strength · (cos θ, sin θ)
 * Outside every region mult = 1 and push = 0, so a document without regions is unchanged.
 * 모든 영역 밖에서는 mult = 1, push = 0 → 영역이 없으면 기존 결과와 동일.
 */

import { clamp } from '../../core/math-utils.js';
import { T_REF, P_REF } from './field-layers.js';

export const REGION_SHAPES = Object.freeze(['rect', 'ellipse']);
/** Field components a region can scale. / 영역이 조절할 수 있는 장 성분 */
export const REGION_TARGETS = Object.freeze(['guide', 'nodes', 'turb', 'wells']);
export const REGION_GAIN_MAX = 3;

const NEUTRAL = Object.freeze({ guide: 1, nodes: 1, turb: 1, wells: 1, pushT: 0, pushY: 0, any: false });

let regionSeq = 0;
export function createFieldRegion(shape = 'rect', x = 1.6, y = 60) {
  regionSeq += 1;
  return {
    id: `fr_${Date.now().toString(36).slice(-4)}${regionSeq}`,
    enabled: true,
    shape: REGION_SHAPES.includes(shape) ? shape : 'rect',
    x,
    y,
    w: 0.6,
    h: 5,
    feather: 0.06,
    invert: false,
    // A new region starts as a "calm zone": turbulence off, everything else untouched.
    // 새 영역은 "고요 구역"으로 시작: 난류만 끄고 나머지는 그대로.
    gain: { guide: 1, nodes: 1, turb: 0, wells: 1 },
    flowAngle: 0,
    flowStrength: 0,
  };
}

const smoothstep = (e0, e1, x) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const u = clamp((x - e0) / (e1 - e0), 0, 1);
  return u * u * (3 - 2 * u);
};

/** Approximate signed distance (field units, < 0 inside) at (sec, midi). / 경계까지의 부호 거리 */
export function regionSdf(r, sec, midi) {
  const w = Math.max(1e-3, r.w / T_REF);
  const h = Math.max(1e-3, r.h / P_REF);
  const dx = (sec - r.x) / T_REF;
  const dy = (midi - r.y) / P_REF;
  if (r.shape === 'ellipse') return (Math.hypot(dx / w, dy / h) - 1) * Math.min(w, h);
  return Math.max(Math.abs(dx) - w, Math.abs(dy) - h);
}

/** Influence of one region at (sec, midi) in [0, 1]. / 한 영역의 영향도 */
export function regionWeight(r, t, y) {
  if (!r || r.enabled === false) return 0;
  const w = 1 - smoothstep(0, Math.max(0, r.feather || 0), regionSdf(r, t, y));
  return r.invert ? 1 - w : w;
}

/**
 * Combined modulation of all regions at (sec, midi). / 모든 영역의 합성 변조
 * @returns {{ guide, nodes, turb, wells, pushT, pushY, any }}
 */
export function regionModulation(regions, t, y) {
  if (!regions || regions.length === 0) return NEUTRAL;
  let guide = 1;
  let nodes = 1;
  let turb = 1;
  let wells = 1;
  let pushT = 0;
  let pushY = 0;
  let any = false;
  for (const r of regions) {
    const wt = regionWeight(r, t, y);
    if (wt <= 1e-6) continue;
    any = true;
    const g = r.gain || {};
    guide *= 1 + wt * ((g.guide ?? 1) - 1);
    nodes *= 1 + wt * ((g.nodes ?? 1) - 1);
    turb *= 1 + wt * ((g.turb ?? 1) - 1);
    wells *= 1 + wt * ((g.wells ?? 1) - 1);
    const s = r.flowStrength || 0;
    if (Math.abs(s) > 1e-6) {
      const a = ((r.flowAngle || 0) * Math.PI) / 180;
      pushT += wt * s * Math.cos(a);
      pushY += wt * s * Math.sin(a);
    }
  }
  return any ? { guide, nodes, turb, wells, pushT, pushY, any } : NEUTRAL;
}
