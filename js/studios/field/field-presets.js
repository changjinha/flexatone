/**
 * Flexatone — studios/field/field-presets.js
 * Layer 2 (studios, pure): **Field presets** — whole documents built from the default one, like the presets of
 * the other studios. Applying one replaces the Field document (one undo step).
 * 계층 2 (studios, 순수): 필드 프리셋 — 기본 문서에서 만든 전체 문서. 적용 = 문서 교체 (실행 취소 1단계).
 */

import { deepClone } from '../../core/math-utils.js';
import { I18N } from '../../core/i18n.js';
import { registerSelfCheck } from '../../core/state.js';
import { createDefaultFieldParams, createParticleVoice, MAIN_LAYER_ID } from './vector-field-engine.js';

export const FIELD_PRESET_IDS = Object.freeze(['default', 'vortexChoir', 'gravityWells', 'pureGlide', 'storm', 'mirror']);

Object.assign(I18N.en, {
  'fpreset.label': 'Preset', 'fpreset.custom': '— custom —', 'fpreset.applied': (n) => `Preset: ${n}`,
  'fpreset.default': 'Default (two particles)', 'fpreset.vortexChoir': 'Vortex choir', 'fpreset.gravityWells': 'Gravity wells (overtones)',
  'fpreset.pureGlide': 'Pure glide (no physics)', 'fpreset.storm': 'Storm (turbulence, wrap)', 'fpreset.mirror': 'Mirror (retrograde)',
});
Object.assign(I18N.ko, {
  'fpreset.label': '프리셋', 'fpreset.custom': '— 사용자 —', 'fpreset.applied': (n) => `프리셋: ${n}`,
  'fpreset.default': '기본 (입자 2개)', 'fpreset.vortexChoir': '소용돌이 합창', 'fpreset.gravityWells': '중력 우물 (배음)',
  'fpreset.pureGlide': '순수 글리산도 (물리 없음)', 'fpreset.storm': '폭풍 (난류, 감싸기)', 'fpreset.mirror': '거울 (역행)',
});

const node = (id, type, sec, midi, strength, radius) => ({ id, type, sec, midi, strength, radius });

function particles(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(createParticleVoice(i, `pv_preset_${i + 1}`), i));
}

const BUILD = {
  default: (d) => d,
  // four particles circling one strong vortex, pentatonic wells / 강한 소용돌이를 도는 네 입자
  vortexChoir: (d) => {
    d.wellGrid = 'pentatonic';
    d.wellStrength = 0.35;
    Object.assign(d.layers[0], { turbulence: 0.5, turbFreq: 2.5, nodes: [node('fn_v', 'vortex', 2.2, 62, 2.2, 0.38), node('fn_a', 'attractor', 3.6, 67, 0.8, 0.25)] });
    d.voices = particles(4, (v, i) => Object.assign(v, { f0Midi: 50 + i * 5, f1Midi: 74 - i * 4, startTime: i * 0.25, duration: 4.2, mass: 1.2, drag: 2.4, coupling: i ? -0.25 : 0 }));
    d.view = { ...d.view, tMax: 5, midiMin: 40, midiMax: 84 };
    return d;
  },
  // no turbulence, strong overtone wells, three attractors: glides fall into a chord / 배음 우물로 떨어지는 글리산도
  gravityWells: (d) => {
    d.wellGrid = 'overtone';
    d.wellStrength = 0.8;
    d.guideAttraction = 0.9;
    Object.assign(d.layers[0], { turbulence: 0, nodes: [node('fn_1', 'attractor', 1.2, 55, 1.4, 0.3), node('fn_2', 'attractor', 2.4, 64, 1.4, 0.3), node('fn_3', 'attractor', 3.6, 72, 1.4, 0.3)] });
    d.voices = particles(3, (v, i) => Object.assign(v, { f0Midi: 48 + i * 7, f1Midi: 60 + i * 7, startTime: 0, duration: 4.5, drag: 5, speedToGain: 0.2 }));
    d.view = { ...d.view, tMax: 5, midiMin: 40, midiMax: 84 };
    return d;
  },
  // physics off: each particle is the guiding curve itself (chirp) / 물리 끔: 가이드 곡선 그대로
  pureGlide: (d) => {
    d.fieldEnabled = false;
    d.guiding = { ...d.guiding, engine: 'chirp', chirpA: 0.2, chirpF1: 8 };
    d.voices = particles(3, (v, i) => Object.assign(v, { f0Midi: 45 + i * 12, f1Midi: 57 + i * 12, startTime: i * 0.5, duration: 3.5 }));
    d.view = { ...d.view, tMax: 5, midiMin: 36, midiMax: 84 };
    return d;
  },
  // strong fast turbulence, six short particles that wrap around the range / 강한 난류, 감싸는 여섯 입자
  storm: (d) => {
    d.wellGrid = 'none';
    Object.assign(d.layers[0], { turbulence: 1.3, turbFreq: 6, nodes: [node('fn_r', 'repeller', 2, 64, 1.2, 0.3), node('fn_v', 'vortex', 3.2, 58, 1.6, 0.25)] });
    d.voices = particles(6, (v, i) => Object.assign(v, { f0Midi: 52 + ((i * 5) % 20), f1Midi: 70 - ((i * 7) % 18), startTime: i * 0.4, duration: 1.8, boundaryMode: 'wrap', drag: 1.6, launchSpeed: 1.6 }));
    d.view = { ...d.view, tMax: 4.2, midiMin: 40, midiMax: 84 };
    return d;
  },
  // retrograde mirror: each glide comes back the way it went / 역행 거울: 간 길로 되돌아옴
  mirror: (d) => {
    d.guiding = { ...d.guiding, engine: 'bounce', bounceP: 2 };
    d.voices = particles(2, (v, i) => Object.assign(v, { retroMode: 'mirror', f0Midi: i ? 72 : 48, f1Midi: i ? 55 : 67, duration: 4 }));
    d.view = { ...d.view, tMax: 4.5 };
    return d;
  },
};

/** A fresh document for a preset (unknown id → default). / 프리셋 문서 */
export function createFieldPreset(id) {
  const d = deepClone(createDefaultFieldParams());
  const out = (BUILD[id] || BUILD.default)(d);
  out.activeVoiceId = out.voices[0]?.id || '';
  out.activeLayerId = MAIN_LAYER_ID;
  out.preset = FIELD_PRESET_IDS.includes(id) ? id : 'default';
  return out;
}

registerSelfCheck('Field presets: every preset builds a playable document', (a) => {
  for (const id of FIELD_PRESET_IDS) {
    const d = createFieldPreset(id);
    a.ok(d.voices.length >= 1 && d.voices.every((v) => v.duration > 0), `${id}: particles`);
    a.equal(d.preset, id);
    a.ok(new Set(d.voices.map((v) => v.id)).size === d.voices.length, `${id}: unique ids`);
  }
});
