/**
 * Flexatone — studios/space/space-checks-f1.js
 * Self-checks of the Space follow-up F1: curve links (a curve of another studio as a path),
 * groups (formation offsets), stems and the stereo split of imported sounds.
 * 스페이스 후속 F1 자가진단: 곡선 링크(다른 스튜디오의 곡선을 경로로), 그룹(편대 오프셋), 스템, 스테레오 분리.
 *
 * Imported by space-panels.js (registration only). The audio checks render offline; no sound is played.
 */

import { registerSelfCheck, appState } from '../../core/state.js';
import { buildSpline } from '../../modules/spline3d.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams, bakeSource, getKinematics, effectiveC } from './space-engine.js';
import {
  registerSpaceCurveSource, listCurves, mapCurve, curveToNodes, createCurveLink, resolveCurveLink, applyCurveLink, updateCurveLinks, curveLinksStale, normalizeCurveLink,
} from './space-curve-link.js';
import { stereoSplit, stemSplit, ungroupSource, arcOffsets, groupMembers, STEM_MAX, STEREO_SPAN } from './space-groups.js';
import { renderSpaceBuffer } from './space-audio.js';
import { getInstanceRenderer, setInstanceRenderer, clearInstanceBuffers, listInstanceStems, baseTarget, stemOf, stemTarget, describeInstance } from '../../audio/instance-source.js';

const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const SR = 48000;
const TEST = 'zz_curve_test';
const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: 5, ...over, sources });
const helix = (n = 600, turns = 3, wob = 0) => Array.from({ length: n }, (_, i) => {
  const u = i / (n - 1);
  return { x: Math.cos(2 * Math.PI * turns * u) * (1 + wob), y: Math.sin(2 * Math.PI * turns * u), z: 2 * u, t: 12 * u };
});

registerSelfCheck('space-f1: curve links — mapping, node budget + error bound, one update per change, missing, loop, pins', (a) => {
  // Mapping: the bounding box fits the sphere, centred / 매핑: 경계 상자가 구에 맞고 중심에 놓임
  const H = helix();
  const m = mapCurve(H, { axes: ['x', 'y', 'z'], fit: 'uniform', size: 60, cx: 10, cy: -5, cz: 2, yaw: 0 });
  const box = (pts) => { const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9]; for (const p of pts) { [p.x, p.y, p.z].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); }); } return { lo, hi }; };
  const b = box(m);
  a.near(Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]), 60, 1e-9, 'uniform fit: box diagonal = size');
  a.ok(Math.abs((b.lo[0] + b.hi[0]) / 2 - 10) < 1e-9 && Math.abs((b.lo[1] + b.hi[1]) / 2 + 5) < 1e-9 && Math.abs((b.lo[2] + b.hi[2]) / 2 - 2) < 1e-9, 'centred on the mapping centre');
  // Round trip with fixed units, swapped / flipped axes and a rotation / 고정 단위·축 교환·회전의 왕복
  const map2 = { axes: ['y', '-x', 'z'], fit: 'none', unit: 2, cx: 3, cy: 4, cz: 5, yaw: 90 };
  const m2 = mapCurve(H, map2);
  let worst = 0;
  H.forEach((p, i) => {
    const q = m2[i];
    // inverse: un-centre, rotate back by −90°, divide by the unit, undo the axis choice / 역변환
    const x = q.x - 3, y = q.y - 4;
    const rx = y, ry = -x; // rotation by −90°
    const u = [rx / 2 + m2.mid[0], ry / 2 + m2.mid[1], (q.z - 5) / 2 + m2.mid[2]];
    worst = Math.max(worst, Math.abs(u[0] - p.y), Math.abs(u[1] + p.x), Math.abs(u[2] - p.z));
  });
  a.ok(worst < 1e-9, `mapping round trip (${worst.toExponential(1)})`);
  const box2 = mapCurve([{ x: 0, y: 60, z: 0 }, { x: 10, y: 72, z: 0 }], { axes: ['x', 'y', '0'], fit: 'box', size: 40 });
  a.ok(Math.abs(box2[1].x - box2[0].x - 40) < 1e-9 && Math.abs(box2[1].y - box2[0].y - 40) < 1e-9, 'box fit: every axis reaches the size on its own');
  // Node budget and the reported error (measured again here, independently) / 노드 예산과 오차 (독립 재측정)
  for (const cap of [64, 16]) {
    const res = curveToNodes(m, { maxNodes: cap });
    a.ok(res.nodes.length <= cap && res.nodes.length >= 2, `≤ ${cap} nodes (${res.nodes.length})`);
    const sp = buildSpline(res.nodes);
    const dense = Array.from({ length: 4001 }, (_, i) => sp.P(i / 4000));
    let err = 0;
    for (let i = 0; i < m.length; i += 7) { let best = Infinity; for (const d of dense) best = Math.min(best, Math.hypot(d.x - m[i].x, d.y - m[i].y, d.z - m[i].z)); err = Math.max(err, best); }
    a.ok(err <= res.err + 0.05, `reported error bounds the real one (${err.toFixed(3)} ≤ ${res.err.toFixed(3)} m, ${cap} nodes)`);
    if (cap === 64) a.ok(res.err < 0.6, `64 nodes follow a 3-turn helix of 60 m within ${res.err.toFixed(2)} m`);
  }
  a.equal(curveToNodes(mapCurve([{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }], {})).dims, '2d', 'a flat curve gives a 2-D spline');
  // Link bookkeeping with a test source / 테스트 원본으로 링크 동작
  let pts = helix();
  registerSpaceCurveSource(TEST, { curves: () => (pts ? [{ key: 'h', name: 'Helix', pts }] : []) });
  try {
    const curve = listCurves(TEST).find((c) => c.key === 'h');
    a.ok(curve && curve.kind === '3d', 'a registered studio lists its curve');
    const doc = docWith([createSource(0, { id: 'a' }), createSource(1, { id: 'b' })]);
    doc.sources[0].path.link = createCurveLink(TEST, curve);
    doc.sources[0].path.type = 'spline';
    a.ok(curveLinksStale(doc), 'a new link is stale');
    a.equal(updateCurveLinks(doc).join(), 'a', 'first update writes the linked source');
    const n1 = doc.sources[0].path.spline.nodes.length;
    a.ok(n1 >= 8 && doc.sources[0].path.spline.dims === '3d' && doc.sources[0].path.link.status === 'ok', `nodes written (${n1}, 3-D)`);
    a.ok(!curveLinksStale(doc) && updateCurveLinks(doc).length === 0, 'nothing to do while the original is unchanged');
    const kept = JSON.stringify(normalizeSpaceDoc(doc).sources[0].path.link);
    a.ok(kept === JSON.stringify(normalizeCurveLink(doc.sources[0].path.link)), 'the link survives document normalisation');
    pts = helix(600, 3, 0.4);
    a.equal(updateCurveLinks(doc).length, 1, 'an edit of the original = exactly one update');
    a.equal(updateCurveLinks(doc).length, 0, '… and none after it');
    const before = JSON.stringify(doc.sources[0].path.spline.nodes);
    doc.sources[0].path.link.map.size = 30;
    a.ok(updateCurveLinks(doc).length === 1 && JSON.stringify(doc.sources[0].path.spline.nodes) !== before, 'a mapping change re-reads the curve');
    // A part of the curve: fewer turns → smaller error, same scale and place / 일부 구간: 오차 감소, 배율·위치 유지
    pts = helix(2400, 40);
    doc.sources[0].path.link.map.size = 60;
    updateCurveLinks(doc);
    const errAll = doc.sources[0].path.link.err;
    doc.sources[0].path.link.range = [0.25, 0.3];
    a.equal(updateCurveLinks(doc).length, 1, 'a range change re-reads the curve');
    const part = doc.sources[0].path.spline.nodes;
    const ref = mapCurve(pts, doc.sources[0].path.link.map);
    a.ok(doc.sources[0].path.link.err < 0.5 && errAll > 2, `40 turns: ±${errAll.toFixed(1)} m as a whole, ±${doc.sources[0].path.link.err.toFixed(2)} m for 5 % of it`);
    a.ok(Math.hypot(part[0].x - ref[600].x, part[0].y - ref[600].y, part[0].z - ref[600].z) < 1e-3, 'the part sits where it sits in the whole curve');
    doc.sources[0].path.link.range = [0, 1];
    pts = helix(600, 3, 0.4);
    updateCurveLinks(doc);
    // Missing original: status only, the nodes stay / 원본 없음: 상태만 바뀌고 노드는 유지
    const nodes = JSON.stringify(doc.sources[0].path.spline.nodes);
    pts = null;
    a.equal(updateCurveLinks(doc).length, 1, 'a vanished original is recorded once');
    a.ok(doc.sources[0].path.link.status === 'missing' && JSON.stringify(doc.sources[0].path.spline.nodes) === nodes && updateCurveLinks(doc).length === 0, 'missing: nodes kept, no further writes');
    pts = helix();
    a.ok(updateCurveLinks(doc).length === 1 && doc.sources[0].path.link.status === 'ok', 'it heals when the original is back');
    // Loop: the origin receives Space's pitch line / 루프: 원본이 스페이스의 선을 받음
    const loop = resolveCurveLink(doc.sources[0].path.link, { plan: { edges: [{ from: 'space', to: 'mid', status: 'ok' }, { from: 'mid', to: TEST, status: 'ok' }] } });
    a.equal(loop.status, 'loop', 'a studio fed by Space (through another) is refused');
    a.equal(resolveCurveLink({ ...doc.sources[0].path.link, sig: '' }, { plan: { edges: [{ from: TEST, to: 'space', status: 'ok' }] } }).status, 'ok', 'the other direction is fine');
    // Node times / 노드 시각
    const s2 = doc.sources[1];
    s2.path.type = 'spline';
    s2.path.link = { ...createCurveLink(TEST, curve), time: 'pinned' };
    applyCurveLink(s2, resolveCurveLink(s2.path.link));
    const ts = s2.path.spline.nodes.map((n) => n.t);
    a.ok(ts.every((t, i) => Number.isFinite(t) && (i === 0 ? t === 0 : t > ts[i - 1])), 'pinned: node times rise from 0');
    a.ok(s2.timeMode === 'pinned' && Math.abs(s2.duration - 12) < 1e-6, 'pinned: time mode and duration follow the original');
    const kin = getKinematics(normalizeSpaceDoc(doc).sources[1], normalizeSpaceDoc(doc));
    const st = kin.stateAt(6);
    const want = mapCurve(helix(), s2.path.link.map)[300];
    a.ok(Math.hypot(st.x - want.x, st.y - want.y, st.z - want.z) < 2.5, 'pinned: the source is where the original is at that time');
  } finally {
    registerSpaceCurveSource(TEST, null);
  }
  a.equal(listCurves('space').length, 0, 'Space does not offer curves to itself');
}, { group: 'studio' });

registerSelfCheck('space-f1: groups — path / world offsets, turning formation, stereo pair, stems (order, cap), ungroup', (a) => {
  const line = { type: 'line', x0: -50, y0: 10, x1: 50, y1: 10 };
  const lead = createSource(0, { id: 'L', path: line, speed: { value: 20 }, duration: 5 });
  // Own path + offset to the right of a motion along +x → −y / +x로 가는 운동의 오른쪽 = −y
  const d1 = docWith([{ ...lead, group: { lead: null, frame: 'path', off: [0, 2, 0] } }, createSource(1, { id: 'F', path: { type: 'static', x: 0, y: 0 }, group: { lead: 'L', frame: 'world', off: [1, 2, 3] } })]);
  const k0 = getKinematics({ ...d1.sources[0], group: null }, d1);
  const k1 = getKinematics(d1.sources[0], d1);
  const s0 = k0.stateAt(2.5), s1 = k1.stateAt(2.5);
  a.ok(Math.abs(s1.x - s0.x) < 1e-9 && Math.abs(s1.y - (s0.y - 2)) < 1e-9, 'path frame: "right" of a motion along +x is −y');
  a.ok(Math.abs(s1.vx - s0.vx) < 1e-6 && Math.abs(s1.vy) < 1e-6, 'straight path: the displaced point has the same velocity');
  const kf = getKinematics(d1.sources[1], d1).stateAt(2.5);
  a.ok(Math.abs(kf.x - (s0.x + 1)) < 1e-9 && Math.abs(kf.y - (s0.y + 2)) < 1e-9 && Math.abs(kf.z - (s0.z + 3)) < 1e-9, 'a follower rides the lead\'s own path (not the lead\'s offset) + its world offset');
  a.ok(getKinematics({ ...lead, group: null }, d1) === getKinematics({ ...lead, group: { lead: null, frame: 'path', off: [0, 0, 0] } }, d1), 'zero offset = the plain kinematics');
  // Turning formation: outside of a circle → larger radius and proportionally faster / 원의 바깥 = 더 큰 반지름, 더 빠름
  const orbit = createSource(0, { id: 'O', path: { type: 'orbit', cx: 0, cy: 0, rx: 25, ry: 25, dir: 1 }, speed: { value: 10 }, duration: 8 });
  const d2 = docWith([orbit, createSource(1, { id: 'W', group: { lead: 'O', frame: 'path', off: [0, 5, 0] } })]);
  const ko = getKinematics(d2.sources[0], d2).stateAt(3);
  const kw = getKinematics(d2.sources[1], d2).stateAt(3);
  const side = Math.hypot(kw.x, kw.y) - Math.hypot(ko.x, ko.y);
  a.ok(Math.abs(Math.abs(side) - 5) < 1e-6, `orbit wingman: radius differs by the offset (${side.toFixed(3)} m)`);
  a.near(kw.speed / ko.speed, Math.hypot(kw.x, kw.y) / 25, 1e-3, 'its speed scales with its radius (the frame turns)');
  const bw = bakeSource(d2.sources[1], d2);
  a.ok(bw.maxResidual < 1e-6 && Number.isFinite(bw.fObs[10]), 'a follower bakes like any source');
  // Stereo split / 스테레오 분리
  const imp = createSource(0, { id: 'I', name: 'Pad', path: line, speed: { value: 20 }, duration: 5, input: { kind: 'import', target: 'x1' } });
  const d3 = docWith([imp]);
  const right = stereoSplit(d3, 'I');
  a.ok(right && d3.sources.length === 2 && d3.sources[0].input.channel === 'L' && right.input.channel === 'R' && right.group.lead === 'I', 'stereo split: L keeps the path, R follows it');
  const n3 = normalizeSpaceDoc(d3);
  const pl = getKinematics(n3.sources[0], n3).stateAt(1), pr = getKinematics(n3.sources[1], n3).stateAt(1);
  a.ok(Math.abs(pl.y - pr.y - STEREO_SPAN) < 1e-9 && Math.abs(pl.x - pr.x) < 1e-9 && pl.y > pr.y, `L is ${STEREO_SPAN} m to the left of R, at right angles to the travel`);
  a.ok(Math.abs((pl.y + pr.y) / 2 - 10) < 1e-9, 'the pair is centred on the path');
  // Stems: cap by level, placed by pitch / 스템: 음량 순으로 자르고 음고 순으로 배치
  const list = Array.from({ length: 20 }, (_, i) => ({ key: `v${i}`, name: `V${i}`, pitch: 80 - i, level: i < 4 ? 0.1 : 1 }));
  const d4 = docWith([createSource(0, { id: 'S', name: 'Gl', path: line, input: { kind: 'import', target: 'inst1', content: 'heard' } })]);
  const ids = stemSplit(d4, 'S', list);
  a.equal(ids.length, STEM_MAX, `at most ${STEM_MAX} stems`);
  const keys = d4.sources.map((s) => stemOf(s.input.target));
  a.ok(!keys.some((k) => ['v0', 'v1', 'v2', 'v3'].includes(k)) && new Set(keys).size === STEM_MAX, 'the quietest lines are the ones left out; every stem is a different line');
  a.ok(d4.sources.every((s) => baseTarget(s.input.target) === 'inst1'), 'every stem reads the same instance');
  const byRight = [...d4.sources].sort((x, y) => x.group.off[1] - y.group.off[1]).map((s) => list.find((l) => l.key === stemOf(s.input.target)).pitch);
  a.ok(byRight.every((p, i) => i === 0 || p > byRight[i - 1]), 'left → right = low → high pitch');
  a.ok(groupMembers(d4, 'S').length === STEM_MAX - 1 && d4.sources.filter((s) => !s.group.lead).length === 1, 'one lead, the others follow it');
  const arc = arcOffsets(5, 12);
  a.ok(Math.abs(arc[4][1] - arc[0][1] - 12) < 0.02 && arc[2][0] === 0 && arc[0][0] < 0 && Math.abs(arc[1][1] + arc[3][1]) < 1e-9, 'arc: the given span, symmetric, the middle ahead');
  a.equal(stemSplit(docWith([createSource(0, { id: 'q', input: { kind: 'import', target: 'i' } })]), 'q', list.slice(0, 1)).length, 0, 'one line = nothing to split');
  // Ungroup: the follower keeps the lead's path / 그룹 해제: 리드 경로를 복사
  ungroupSource(d3, right.id);
  a.ok(!d3.sources[1].group && d3.sources[1].path.x0 === -50 && d3.sources[0].group, 'ungroup copies the lead\'s path and drops the offset');
  ungroupSource(d4, 'S');
  a.ok(d4.sources.every((s) => !s.group), 'ungrouping the lead releases every follower');
  a.ok(effectiveC(d1) > 0);
}, { group: 'studio' });

registerSelfCheck('space-f1: stems and channels in sound — stem targets, L / R channel, stems add up to the whole', async (a) => {
  a.ok(baseTarget('i1#v2') === 'i1' && stemOf('i1#v2') === 'v2' && stemOf('i1') === null && stemTarget('i1#a', 'b') === 'i1#b', 'stem target syntax');
  if (!Offline()) return;
  const real = getInstanceRenderer();
  // Mock: a stereo sound, 300 Hz left and 700 Hz right / 모의 렌더러: 왼쪽 300 Hz, 오른쪽 700 Hz
  setInstanceRenderer({
    describe: (target) => ({ ok: true, key: `k:${target}`, name: 'Mock', studio: 'glissando', color: '#fff', length: 1 }),
    list: () => [],
    render: async () => {
      const buf = new AudioBuffer({ length: SR, numberOfChannels: 2, sampleRate: SR });
      const L = buf.getChannelData(0), R = buf.getChannelData(1);
      for (let i = 0; i < SR; i++) { L[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR); R[i] = 0.5 * Math.sin((2 * Math.PI * 700 * i) / SR); }
      return buf;
    },
  });
  clearInstanceBuffers();
  const zc = (x, i0, i1) => { let n = 0; for (let i = i0 + 1; i < i1; i++) if (x[i - 1] < 0 && x[i] >= 0) n++; return n / ((i1 - i0) / SR); };
  try {
    const one = (channel) => docWith([createSource(0, { id: 'c', path: { type: 'static', x: 0, y: 8 }, duration: 0.8, airAbsorb: false, input: { kind: 'import', target: 'mock', channel } })]);
    const hz = {};
    const level = {};
    for (const ch of ['L', 'R', 'mix']) {
      const buf = await renderSpaceBuffer({ params: one(ch), sampleRate: SR, outputStage: false });
      const x = buf.getChannelData(0);
      const i0 = Math.floor(0.2 * SR), i1 = Math.floor(0.6 * SR);
      hz[ch] = zc(x, i0, i1);
      let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i];
      level[ch] = Math.sqrt(s / (i1 - i0));
    }
    a.ok(Math.abs(hz.L - 300) < 4 && Math.abs(hz.R - 700) < 4, `channel L / R plays that channel only (${hz.L.toFixed(0)} / ${hz.R.toFixed(0)} Hz)`);
    a.near(level.L / level.mix, 2 * Math.SQRT1_2 / Math.SQRT2, 0.03, 'one channel at −3 dB against the summed pair (two uncorrelated channels)');
  } finally {
    setInstanceRenderer(real);
    clearInstanceBuffers();
  }
  // The real renderer: stems of the Glissando editor add up to the whole / 실제 렌더러: 스템의 합 = 전체
  const st = listInstanceStems('@glissando');
  if (!real?.stems || !st.ok || appState.legatoJoin) return; // one voice, or joined voices (a joint belongs to no single stem) / 보이스 하나이거나 이음 모드
  a.ok(describeInstance('@glissando#' + st.list[0].key).ok && describeInstance('@glissando#' + st.list[0].key).key !== describeInstance('@glissando').key, 'a stem has its own render key');
  const whole = await real.render('@glissando', 'doc', 24000, []);
  if (!whole) return;
  const sum = new Float32Array(whole.length);
  for (const s of st.list) {
    const buf = await real.render(`@glissando#${s.key}`, 'doc', 24000, []);
    if (!buf) continue;
    const x = buf.getChannelData(0);
    for (let i = 0; i < Math.min(sum.length, x.length); i++) sum[i] += x[i];
  }
  const w = whole.getChannelData(0);
  let e = 0, p = 0;
  for (let i = 0; i < w.length; i++) { e += (w[i] - sum[i]) ** 2; p += w[i] * w[i]; }
  const db = p > 0 ? 10 * Math.log10(Math.max(1e-20, e / p)) : -200;
  a.ok(db < -60, `stems add up to the whole render (${db.toFixed(1)} dB)`);
}, { group: 'studio' });
