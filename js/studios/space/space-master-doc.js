/**
 * Flexatone — studios/space/space-master-doc.js
 * Layer 2 (studios, pure): the **Space Master** document — a Space scene whose sources are the
 * Manager's tracks. It lives apart from the studio documents (like `_sends` and `_tempo`):
 *   appState.studioParams._spaceMaster = { on, wet, compensate, doc: <Space document> }
 * so it is saved with the project and undoable, and no instance list has to skip it.
 * 계층 2 (studios, 순수): **스페이스 마스터** 문서 — 음원이 매니저 트랙인 스페이스 장면. 스튜디오 문서와 분리 저장
 * (`_sends`, `_tempo`와 같은 방식): 프로젝트 저장·실행 취소에 포함되고, 인스턴스 목록에는 나타나지 않음.
 *
 * A master source has `input = { kind: 'track', target: <instance id> }`. `syncMasterSources` keeps
 * one source per Manager track (new tracks get a resting place on an arc in front of the listener,
 * removed tracks lose their source, names and colours follow the tracks).
 * 마스터 음원 = 매니저 트랙 하나. 새 트랙은 청취자 앞 호 위의 정지 위치를 받고, 삭제된 트랙의 음원은 제거됨.
 *
 * Imports: core/*, studios/space/space-engine.js.
 */

import { clamp, deepClone, roundTo } from '../../core/math-utils.js';
import { appState, dispatch } from '../../core/state.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams } from './space-engine.js';

export const SPACE_MASTER_KEY = '_spaceMaster';
const ARC_DEG = 60; // tracks are spread over ±60° in front / 정면 ±60°에 펼침
const ARC_R = 8; // metres / 미터

/** An empty master: off, fully wet, a scene with no sources yet. / 빈 마스터 */
export function createSpaceMaster() {
  const doc = normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: ARC_R, preset: '', length: 30, view: { cx: 0, cy: 4, span: 40 } });
  doc.sources = [];
  doc.activeSourceId = '';
  return { on: false, wet: 1, compensate: true, doc };
}

export function normalizeSpaceMaster(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = createSpaceMaster();
  let doc = base.doc;
  if (src.doc && typeof src.doc === 'object') {
    const had = Array.isArray(src.doc.sources) ? src.doc.sources.length : 0;
    doc = normalizeSpaceDoc(src.doc);
    if (!had) { doc.sources = []; doc.activeSourceId = ''; } // normalizeSpaceDoc would add a default source / 기본 음원이 추가되지 않게
  }
  return { on: !!src.on, wet: clamp(Number.isFinite(Number(src.wet)) ? Number(src.wet) : 1, 0, 1), compensate: src.compensate !== false, doc };
}

let memo = { raw: undefined, value: null };
/** The master (normalised, memoised on the stored object — treat as read-only). / 마스터 (읽기 전용) */
export function getSpaceMaster() {
  const raw = appState.studioParams?.[SPACE_MASTER_KEY];
  if (memo.value && memo.raw === raw) return memo.value;
  memo = { raw, value: normalizeSpaceMaster(raw) };
  return memo.value;
}

/** Apply an edit to the master: fn(master) mutates a draft. / 마스터 편집 */
export function editSpaceMaster(fn, { history = true, coalesceKey = null } = {}) {
  const draft = deepClone(getSpaceMaster());
  fn(draft);
  const next = normalizeSpaceMaster(draft);
  return dispatch({
    type: 'space/master',
    history,
    coalesceKey,
    scope: ['studio', 'panels', 'canvas'],
    mutate: (s) => { s.studioParams = { ...(s.studioParams || {}), [SPACE_MASTER_KEY]: next }; },
  });
}

/** Resting place of track i of n on the arc in front of the listener. / 호 위의 정지 위치 */
export function arcPlace(i, n) {
  const a = n <= 1 ? 0 : (-ARC_DEG + (2 * ARC_DEG * i) / (n - 1)) * (Math.PI / 180);
  return { x: roundTo(ARC_R * Math.sin(a), 2), y: roundTo(ARC_R * Math.cos(a), 2) };
}

/**
 * Sources of a master document brought in line with the track list (pure: returns a new source
 * array, or null when nothing changes). `tracks` = [{ id, name, color }], `length` = seconds every
 * resting source lasts (the cycle length).
 * 마스터 음원을 트랙 목록에 맞춤 (바뀔 것이 없으면 null).
 */
export function syncMasterSources(doc, tracks, length = 30) {
  const have = new Map(doc.sources.filter((s) => s.input?.kind === 'track').map((s) => [s.input.target, s]));
  const others = doc.sources.filter((s) => s.input?.kind !== 'track');
  const ids = new Set(tracks.map((x) => x.id));
  let changed = false;
  const fresh = tracks.filter((x) => !have.has(x.id)).length;
  const next = [];
  let k = 0;
  tracks.forEach((trk, i) => {
    const cur = have.get(trk.id);
    if (cur) {
      if (cur.name !== trk.name || cur.color !== trk.color) { changed = true; next.push({ ...cur, name: trk.name, color: trk.color }); } else next.push(cur);
      return;
    }
    changed = true;
    // new tracks take the free places of the arc in order / 새 트랙은 호의 자리를 차례로 받음
    const p = arcPlace(fresh === tracks.length ? i : have.size + k, Math.max(tracks.length, have.size + fresh));
    k++;
    next.push(createSource(i, {
      id: `trk_${trk.id}`, name: trk.name, color: trk.color, path: { type: 'static', x: p.x, y: p.y, h: 0 }, start: 0, duration: clamp(length, 0.1, 300),
      baseGain: 1, airAbsorb: false, input: { kind: 'track', target: trk.id, content: 'heard' },
    }));
  });
  for (const s of have.values()) if (!ids.has(s.input.target)) changed = true;
  return changed ? [...next, ...others] : null;
}
