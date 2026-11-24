/**
 * Flexatone — core/scene-config.js
 * Layer 0 (core, pure): data contract of the Manager Scenes (actions: core/manager-scenes.js).
 *   scene = { id, name, tracks: [instId], lenSec (0 = auto), color }
 * 계층 0 (core, 순수): 매니저 씬의 데이터 규약.
 */

import { uid, clamp } from './math-utils.js';
import { t, I18N } from './i18n.js';

const MAX_TIME = 300; // = state.js MAX_TIME (no import: state.js imports this file) / state.js와 같은 값

export const SCENE_QUANT = Object.freeze(['now', 'end']);
export const SCENE_FOLLOW = Object.freeze(['off', 'once', 'loop']);
export const SCENE_COLORS = ['#f472b6', '#38bdf8', '#facc15', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];
export const MAX_SCENES = 32;

Object.assign(I18N.en, { 'scene.name': (n) => `Scene ${n}`, 'scene.region': (n) => `▶ ${n}` });
Object.assign(I18N.ko, { 'scene.name': (n) => `씬 ${n}`, 'scene.region': (n) => `▶ ${n}` });


/** Validated scenes (tracks that still exist). / 검증된 씬 목록 */
export function normalizeScenes(list, ids = null) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const tracks = [...new Set((Array.isArray(s.tracks) ? s.tracks : []).filter((x) => typeof x === 'string' && (!ids || ids.has(x))))];
    const len = Number(s.lenSec);
    out.push({
      id: typeof s.id === 'string' && s.id ? s.id : uid('sc_', 6),
      name: String(s.name || t('scene.name', out.length + 1)).slice(0, 40),
      tracks,
      lenSec: Number.isFinite(len) && len > 0 ? clamp(len, 0.05, MAX_TIME) : 0,
      color: typeof s.color === 'string' && /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : SCENE_COLORS[out.length % SCENE_COLORS.length],
    });
    if (out.length >= MAX_SCENES) break;
  }
  return out;
}
