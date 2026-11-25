/**
 * Flexatone — studios/space/space-groups.js
 * Layer 2 (studios, pure): **groups** of Space sources — several sources that ride one path as a
 * formation (engine: `source.group`, getKinematics) — and the two things that make them:
 *   stereo split — the left and right channel of an imported sound as two sources, ± span / 2 to
 *                  the side of the direction of travel;
 *   stems        — every line / voice of an imported instance as a source of its own, spread on an
 *                  arc in the order of their pitch (lowest on the left).
 * 계층 2 (studios, 순수): 음원 **그룹**(한 경로를 편대로 따라가는 음원들)과 그것을 만드는 두 가지 —
 * 스테레오 분리(좌·우 채널을 진행 방향의 좌우 ± span / 2에), 스템(선·보이스마다 음원 하나, 음고 순서로 호 위에).
 *
 * Every function mutates the document it is given (call inside editSpace). No DOM, no audio.
 */

import { deepClone, uid } from '../../core/math-utils.js';
import { createSource, SOURCE_COLORS } from './space-engine.js';

export const STEM_MAX = 16; // stems made at once (the loudest ones) / 한 번에 만드는 스템 수 (음량 큰 순)
export const SOURCE_MAX = 64;
export const STEREO_SPAN = 4; // m between the two channels / 두 채널 사이 거리
export const STEM_SPAN = 12; // m from the first to the last stem / 첫 스템에서 마지막 스템까지
const ARC_HALF = Math.PI / 3; // the arc covers ± 60° / 호는 ± 60°
const SEP = '#';
const base = (target) => String(target ?? '').split(SEP)[0];
const r2 = (x) => Math.round(x * 100) / 100;

/** Sources that follow `id`. / id를 따르는 음원들 */
export const groupMembers = (doc, id) => (doc?.sources || []).filter((s) => s.group?.lead === id);

/** Offsets [forward, right, up] of n places on the arc (index 0 = left end). / 호 위 n자리의 오프셋 */
export function arcOffsets(n, span = STEM_SPAN) {
  if (n <= 1) return [[0, 0, 0]];
  const R = span / (2 * Math.sin(ARC_HALF));
  return Array.from({ length: n }, (_, i) => {
    const th = -ARC_HALF + (2 * ARC_HALF * i) / (n - 1);
    return [r2(R * (Math.cos(th) - 1)), r2(R * Math.sin(th)), 0]; // the middle leads, the wings trail / 가운데가 앞, 양 끝이 뒤
  });
}

function cloneAfter(doc, a, over) {
  const i = doc.sources.findIndex((s) => s.id === a.id);
  const copy = createSource(doc.sources.length, { ...deepClone(a), id: uid('s_', 6), color: SOURCE_COLORS[doc.sources.length % SOURCE_COLORS.length], solo: false, ...over });
  doc.sources.splice(i + 1 + groupMembers(doc, a.id).length, 0, copy);
  return copy;
}

/**
 * Stereo split of the import source `id`: it becomes the LEFT channel, a new source the RIGHT one.
 * Both ride the same path, `span` metres apart. Returns the new source, or null.
 * 스테레오 분리: 이 음원은 왼쪽 채널, 새 음원이 오른쪽 채널. 같은 경로를 span m 간격으로.
 */
export function stereoSplit(doc, id, span = STEREO_SPAN) {
  const a = doc.sources.find((s) => s.id === id);
  if (!a || a.input?.kind !== 'import' || doc.sources.length >= SOURCE_MAX) return null;
  const g = a.group && a.group.frame === 'path' ? a.group : { lead: a.group?.lead || null, frame: 'path', off: [0, 0, 0] };
  const [f, r, u] = g.off;
  const name = a.name;
  a.input.channel = 'L';
  a.name = `${name} L`;
  a.group = { lead: g.lead, frame: 'path', off: [f, r2(r - span / 2), u], tag: 'stereo' };
  const b = cloneAfter(doc, a, { name: `${name} R`, group: { lead: g.lead || a.id, frame: 'path', off: [f, r2(r + span / 2), u], tag: 'stereo' } });
  b.input.channel = 'R';
  return b;
}

/**
 * Stems of the import source `id`: `list` = [{ key, name, pitch, level }] (audio/instance-source.js).
 * The source itself becomes one stem and leads; the others follow it on the arc. At most STEM_MAX
 * stems (the loudest), and never more than SOURCE_MAX sources. Returns the ids of the stems.
 * 스템: 이 음원이 스템 하나가 되어 리드, 나머지는 호 위에서 따라감. 최대 STEM_MAX개(음량 큰 순).
 */
export function stemSplit(doc, id, list, span = STEM_SPAN) {
  const a = doc.sources.find((s) => s.id === id);
  if (!a || a.input?.kind !== 'import' || !Array.isArray(list) || list.length < 2 || a.group?.lead) return [];
  const room = Math.min(STEM_MAX, SOURCE_MAX - doc.sources.length + 1);
  if (room < 2) return [];
  const kept = list.map((s, i) => ({ ...s, i })).sort((x, y) => (y.level ?? 1) - (x.level ?? 1) || x.i - y.i).slice(0, room).sort((x, y) => x.pitch - y.pitch || x.i - y.i);
  const offs = arcOffsets(kept.length, span);
  const target = base(a.input.target);
  const lead = Math.floor(kept.length / 2); // the middle of the arc leads / 호의 가운데가 리드
  const name = a.name;
  a.input = { ...a.input, target: `${target}${SEP}${kept[lead].key}`, frozen: null, channel: 'mix' };
  a.name = `${name} · ${kept[lead].name}`;
  a.group = { lead: null, frame: 'path', off: offs[lead], tag: 'stems' };
  const ids = [];
  kept.forEach((s, k) => {
    if (k === lead) { ids.push(a.id); return; }
    const b = cloneAfter(doc, a, { name: `${name} · ${s.name}`, group: { lead: a.id, frame: 'path', off: offs[k], tag: 'stems' } });
    b.input = { ...b.input, target: `${target}${SEP}${s.key}` };
    ids.push(b.id);
  });
  return ids;
}

/**
 * Take a source out of its group: a follower gets a copy of the lead's path and timing (so it
 * stays where the group was), then every offset is dropped. Followers of `id` are released too.
 * 그룹 해제: 따라가던 음원은 리드의 경로·시간을 복사해 받고 오프셋을 버림. id를 따르던 음원들도 풀림.
 */
export function ungroupSource(doc, id) {
  const s = doc.sources.find((x) => x.id === id);
  if (!s) return false;
  const release = (m, lead) => {
    if (lead && lead !== m) { m.path = deepClone(lead.path); m.speed = deepClone(lead.speed); m.timeMode = lead.timeMode; m.start = lead.start; m.duration = lead.duration; }
    m.group = null;
  };
  const members = groupMembers(doc, id);
  for (const m of members) release(m, s);
  if (s.group) release(s, s.group.lead ? doc.sources.find((x) => x.id === s.group.lead) : null);
  return true;
}
