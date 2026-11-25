/**
 * Flexatone — studios/space/space-doc.js
 * Layer 2 (studios, pure): which Space document the Space workspace shows and edits — the studio's
 * own document (default) or the Space Master (the Manager's spatial master track).
 * 계층 2 (studios, 순수): 스페이스 작업 공간이 보여 주고 편집하는 문서 — 스튜디오 문서(기본) 또는 스페이스 마스터.
 *
 * The workspace files (panels, canvases, views, timeline, the editor transport) import their
 * accessors from here; everything else (the plugin, the Manager clip adapter, trajectory sends)
 * keeps importing studios/space-studio.js and always sees the studio document.
 * 작업 공간 파일은 여기서 접근자를 가져오고, 그 밖의 모든 곳은 space-studio.js를 그대로 써서 항상 스튜디오 문서를 봄.
 *
 * The target is UI state (not saved). / 대상은 UI 상태 (저장하지 않음)
 */

import { bakeSpace } from './space-engine.js';
import { splitClip, syncLinkedAfterEdit } from '../../core/line-clip.js';
import * as studio from '../space-studio.js';
import { getSpaceMaster, editSpaceMaster } from './space-master-doc.js';

let target = 'studio';
const listeners = new Set();

/** 'studio' | 'master'. / 편집 대상 */
export const getSpaceDocTarget = () => target;
export function setSpaceDocTarget(v) {
  const next = v === 'master' ? 'master' : 'studio';
  if (next === target) return;
  target = next;
  for (const fn of listeners) { try { fn(target); } catch (err) { console.error(err); } }
}
export function onSpaceDocTarget(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function getSpaceParams() {
  return target === 'master' ? getSpaceMaster().doc : studio.getSpaceParams();
}

export function editSpace(fn, opts = {}) {
  // 🔗 linked pieces of one source keep one motion (core/line-clip.js) / 링크된 조각은 같은 움직임 유지
  const linked = (d) => {
    const before = (d.sources || []).some((x) => x.link?.on) ? JSON.parse(JSON.stringify(d.sources)) : null;
    fn(d);
    if (before) syncLinkedAfterEdit(before, d.sources, SPACE_LINK_KEYS, d.activeSourceId);
  };
  if (target !== 'master') return studio.editSpace(linked, opts);
  return editSpaceMaster((m) => { linked(m.doc); }, opts);
}

/**
 * What linked pieces of a source share (🔗): its path, speed, emitted frequency and lanes. Start,
 * duration, play range, timbre and gain stay each piece's own. / 링크된 조각이 공유하는 필드.
 */
export const SPACE_LINK_KEYS = Object.freeze(['path', 'speed', 'timeMode', 'f', 'lanes', 'doppler', 'distanceGain', 'airAbsorb', 'group']);

/**
 * ✂ Cut a source at heard second `sec` into two linked pieces (Locate double-click on the observed
 * pitch). Both keep the whole motion; their play ranges split the heard span. / 음원 자르기
 */
export function splitSource(id, sec) {
  const b = getSpaceBake(getSpaceParams()).sources.get(id);
  if (!b) return false;
  let ok = false;
  editSpace((d) => {
    const i = d.sources.findIndex((x) => x.id === id);
    const src = d.sources[i];
    if (!src) return;
    const cl = splitClip(src.clip, b.t0, b.t1 - b.t0, sec);
    if (!cl) return;
    const linkId = src.link?.id || `ln_${Math.random().toString(36).slice(2, 8)}`;
    const nb = JSON.parse(JSON.stringify(src));
    nb.id = `src_${Math.random().toString(36).slice(2, 8)}`;
    nb.name = `${String(src.name || 'Source').replace(/ ✂\d+$/, '')} ✂${Math.max(1, d.sources.filter((x) => x.link?.id === linkId).length) + 1}`.slice(0, 40);
    nb.solo = false;
    src.link = { id: linkId, on: true };
    nb.link = { id: linkId, on: true };
    if (cl[0]) src.clip = cl[0]; else delete src.clip;
    if (cl[1]) nb.clip = cl[1]; else delete nb.clip;
    d.sources.splice(i + 1, 0, nb);
    d.activeSourceId = nb.id;
    ok = true;
  });
  return ok;
}

export function getActiveSource(params = getSpaceParams()) {
  return params.sources.find((s) => s.id === params.activeSourceId) || params.sources[0] || null;
}

export function isSourceAudible(s, params = getSpaceParams()) {
  const anySolo = params.sources.some((x) => x.solo);
  return anySolo ? !!s.solo : !s.muted;
}

export function getSpaceBake(params = getSpaceParams()) {
  return bakeSpace(params);
}

export const SPACE_ID = studio.SPACE_ID;
