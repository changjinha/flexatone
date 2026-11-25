/**
 * Flexatone — studios/space/space-checks-c.js
 * Layer 2 (studios, pure): self-checks of the Space extension C — moving listener (retarded time,
 * Doppler ratio, orientation frame), node time pins and the Space Master document.
 * 계층 2 (studios, 순수): 스페이스 확장 C 자가진단 — 움직이는 청취자(지연 시간·도플러 비·방향 좌표계),
 * 노드 시각 핀, 스페이스 마스터 문서.
 *
 * Imported by studios/space-studio.js (registration only).
 */

import { deepClone } from '../../core/math-utils.js';
import { registerSelfCheck } from '../../core/state.js';
import { nodesFromPoints } from '../../modules/spline3d.js';
import {
  createSource, createSpacePreset, createDefaultSpaceParams, normalizeSpaceDoc, bakeSource, bakeSpace, getSpaceBakeCount, getKinematics,
  effectiveC, listenerFrame, listenerStateAt, getListenerMotion,
} from './space-engine.js';
import { createSpaceMaster, normalizeSpaceMaster, syncMasterSources, arcPlace } from './space-master-doc.js';

const path = (pts, over = {}) => ({ type: 'spline', spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints(pts), ...over } });
const mk = (listener, sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, ...over, listener, sources });
const mover = (pts, speed, extra = {}) => ({ x: pts[0].x, y: pts[0].y, z: pts[0].z || 0, headingDeg: 0, move: { on: true, path: path(pts), speed: { mode: 'const', value: speed }, start: 0 }, ...extra });
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

registerSelfCheck('space-c: moving listener — retarded time, dτ/dt = (1 + n·v_L/c) / (1 + n·v_S/c), limits', (a) => {
  // Listener flying towards a resting source: f_obs = f_s (1 + v_L / c) / 정지 음원으로 다가가는 청취자
  const d1 = mk(mover([{ x: 0, y: -200, z: 0 }, { x: 0, y: 200, z: 0 }], 20), [createSource(0, { id: 's', path: { type: 'static', x: 0, y: 1000 }, duration: 12, f: { hz: 440 } })]);
  const c = effectiveC(d1);
  const b1 = bakeSource(d1.sources[0], d1);
  a.near(b1.fObs[Math.floor(b1.n / 2)], 440 * (1 + 20 / c), 1e-9, 'approaching listener: f_s (1 + v_L / c)');
  a.ok(b1.maxResidual < 1e-9, `solver residual ${b1.maxResidual.toExponential(1)}`);
  // Same velocity, side by side: no Doppler shift (middle of the flight) / 같은 속도로 나란히: 도플러 없음
  const d2 = mk(mover([{ x: -100, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }], 25), [createSource(0, { id: 'p', path: path([{ x: -100, y: 30, z: 5 }, { x: 300, y: 30, z: 5 }]), speed: { value: 25 }, f: { hz: 500 } })]);
  const b2 = bakeSource(d2.sources[0], d2);
  let w = 0;
  for (let i = Math.floor(0.25 * b2.n); i < Math.floor(0.75 * b2.n); i++) w = Math.max(w, Math.abs(b2.fObs[i] / 500 - 1));
  a.ok(w < 1e-9, `parallel flight: f_obs = f_s (worst ${w.toExponential(1)})`);
  // General case: the analytic ratio equals the numeric derivative of the solved τ(t) / 해석식 = 수치 미분
  const d3 = mk({ ...mover([{ x: -60, y: -20, z: 0 }, { x: 0, y: 10, z: 4 }, { x: 60, y: -15, z: 0 }], 18), move: { on: true, path: path([{ x: -60, y: -20, z: 0 }, { x: 0, y: 10, z: 4 }, { x: 60, y: -15, z: 0 }]), speed: { mode: 'const', value: 18 }, start: 0.5 } },
    [createSource(0, { id: 'q', path: path([{ x: 80, y: 30, z: 10 }, { x: 0, y: 12, z: 3 }, { x: -70, y: 40, z: 8 }]), speed: { value: 30 }, f: { hz: 440 } })], { cScale: 0.5 });
  const b3 = bakeSource(d3.sources[0], d3);
  let wd = 0;
  for (let i = 20; i < b3.n - 20; i++) wd = Math.max(wd, Math.abs(((b3.te[i + 1] - b3.te[i - 1]) / (2 * b3.dt)) / (b3.fObs[i] / b3.fs[i]) - 1));
  a.ok(wd < 1e-3 && b3.maxResidual < 1e-9, `dτ/dt analytic vs numeric (worst ${wd.toExponential(1)}), residual ${b3.maxResidual.toExponential(1)}`);
  // Motion off = the static bake, bit for bit / 이동을 끄면 정지 베이킹과 비트 단위로 같음
  const src = createSource(0, { id: 'z', path: { type: 'line', x0: -90, y0: 6, x1: 90, y1: 6 }, speed: { value: 30 }, duration: 6 });
  const off = mk({ x: 2, y: -3, z: 1, headingDeg: 20, move: { on: false, path: path([{ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }]), speed: { mode: 'const', value: 9 } } }, [src], { cScale: 0.5 });
  const plain = mk({ x: 2, y: -3, z: 1, headingDeg: 20 }, [src], { cScale: 0.5 });
  const bo = bakeSource(off.sources[0], off);
  const bp = bakeSource(plain.sources[0], plain);
  a.ok(['fObs', 'gain', 'pan', 'lp', 'te'].every((k) => Array.from(bo[k]).every((v, i) => v === bp[k][i])), 'listener motion off → identical arrays');
  a.equal(getListenerMotion(plain), null, 'a static listener has no motion object');
  // Supersonic listener is clamped / 초음속 청취자 클램프
  const fast = mk(mover([{ x: 0, y: 0, z: 0 }, { x: 3000, y: 0, z: 0 }], 900), [src]);
  a.ok(getListenerMotion(fast).kin.clamped, 'listener speed is clamped to 0.98 c');
  const st = listenerStateAt(d1, 3);
  a.near(st.y, -200 + 20 * 3, 1e-6, 'listener position at t');
}, { group: 'studio' });

registerSelfCheck('space-c: listener frame (yaw / pitch / roll), facing modes', (a) => {
  const fr = listenerFrame(37, 21, -14);
  a.ok(Math.abs(dot(fr.f, fr.f) - 1) < 1e-12 && Math.abs(dot(fr.r, fr.r) - 1) < 1e-12 && Math.abs(dot(fr.u, fr.u) - 1) < 1e-12, 'unit vectors');
  a.ok(Math.abs(dot(fr.f, fr.r)) < 1e-12 && Math.abs(dot(fr.f, fr.u)) < 1e-12 && Math.abs(dot(fr.r, fr.u)) < 1e-12, 'orthogonal');
  const at = (x, y, h, lis) => { const d = mk({ x: 0, y: 0, z: 0, headingDeg: 0, ...lis }, [createSource(0, { id: 'p', path: { type: 'static', x, y, h }, duration: 1 })]); return bakeSource(d.sources[0], d); };
  let b = at(10, 0, 0, { headingDeg: 90 });
  a.ok(Math.abs(b.pan[0]) < 1e-9 && Math.abs(b.fwd[0] - 1) < 1e-9, 'yaw +90°: a source on the right is in front');
  b = at(0, 0.001, 10, { pitchDeg: 90 });
  a.ok(b.fwd[0] > 0.999 && Math.abs(b.up[0]) < 1e-3, 'pitch +90°: a source overhead is in front');
  b = at(0, 0.001, 10, { rollDeg: 90 });
  a.ok(b.pan[0] < -0.999, 'roll +90° (right ear down): the sky is at the left ear');
  b = at(0, 0.001, 10, { pitchDeg: 0.0001 });
  a.ok(b.up[0] > 0.999, 'a tiny pitch takes the general path and agrees with the fixed one');
  // Direction of travel / 진행 방향
  const dv = mk({ ...mover([{ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }], 10), orient: { mode: 'velocity' } }, [createSource(0, { id: 'a', path: { type: 'static', x: 400, y: 0 }, duration: 8 })]);
  const bv = bakeSource(dv.sources[0], dv);
  a.ok(bv.fwd[Math.floor(bv.n / 2)] > 0.999, 'velocity mode: what lies ahead on the path is in front');
  a.near(listenerStateAt(dv, 5).headingDeg, 90, 1e-6, 'velocity mode: heading follows the motion');
  // Look at a source / 음원을 바라봄
  const chase = normalizeSpaceDoc(createSpacePreset('chase'));
  const bc = bakeSource(chase.sources[0], chase);
  a.ok(Array.from(bc.fwd).every((v) => v > 0.999999) && Array.from(bc.pan).every((v) => Math.abs(v) < 1e-6), 'lookAt: the source is always heard in front');
  // Envelopes / 엔벨로프
  const lanes = mk({ x: 0, y: 0, z: 0, headingDeg: 0, orient: { mode: 'lanes', yaw: { min: 0, max: 180, curve: { engine: 'custom', customPoints: [{ x: 0, y: 0, handles: [] }, { x: 1, y: 1, handles: [] }] } } } }, [createSource(0, { id: 'e', path: { type: 'static', x: 10, y: 0 }, duration: 30 })], { length: 30 });
  a.near(listenerStateAt(lanes, 15).headingDeg, 90, 0.2, 'yaw envelope: half way = 90°');
  for (const id of ['flythrough', 'chase']) { const d = normalizeSpaceDoc(createSpacePreset(id)); a.equal(JSON.stringify(normalizeSpaceDoc(JSON.parse(JSON.stringify(d)))), JSON.stringify(d), `normalize is idempotent (${id})`); }
  const fly = normalizeSpaceDoc(createSpacePreset('flythrough'));
  fly.cScale = 0.25 + Math.random() * 0.01;
  bakeSpace(fly);
  const c0 = getSpaceBakeCount();
  const moved = deepClone(fly);
  moved.listener.move.path.spline.nodes[2].y += 1;
  bakeSpace(moved);
  bakeSpace(moved);
  a.equal(getSpaceBakeCount() - c0, 1, 'moving a listener node re-bakes once');
}, { group: 'studio' });

registerSelfCheck('space-c: node time pins — exact passage, monotone, non-negative speed, bad pins ignored', (a) => {
  const pts = [{ x: -60, y: 20, z: 4 }, { x: -20, y: 5, z: 10 }, { x: 10, y: 14, z: 2 }, { x: 45, y: -8, z: 12 }, { x: 80, y: 6, z: 5 }];
  const nodes = nodesFromPoints(pts);
  nodes[1].t = 2;
  nodes[3].t = 9;
  const src = createSource(0, { id: 'pin', path: { type: 'spline', spline: { dims: '3d', end: 'stop', nodes } }, timeMode: 'pinned', duration: 12 });
  const doc = mk({ x: 0, y: 0, z: 0, headingDeg: 0 }, [src]);
  const kin = getKinematics(doc.sources[0], doc);
  a.near(kin.dur, 12, 1e-9, 'the last node is at the duration');
  for (const [i, t] of [[0, 0], [1, 2], [3, 9], [4, 12]]) {
    const st = kin.stateAt(t);
    a.ok(Math.hypot(st.x - pts[i].x, st.y - pts[i].y, st.z - pts[i].z) < 1e-3, `node ${i + 1} is passed at t = ${t} s`);
  }
  let prev = -1;
  let mono = true;
  let vmin = Infinity;
  for (let k = 0; k <= 600; k++) { const tau = (k / 600) * kin.dur; const s = kin.distAt(tau); if (s < prev - 1e-9) mono = false; prev = s; vmin = Math.min(vmin, kin.speedAt(tau)); }
  a.ok(mono && vmin >= 0, 'distance never goes back, speed never negative');
  const b = bakeSource(doc.sources[0], doc);
  a.ok(b.maxResidual < 1e-9 && Array.from(b.fObs).every(Number.isFinite), 'pinned motion bakes');
  const bad = deepClone(src);
  bad.path.spline.nodes[3].t = 1; // earlier than node 2 → ignored / 노드 2보다 이름 → 무시
  const kb = getKinematics(normalizeSpaceDoc({ ...doc, sources: [bad] }).sources[0], doc);
  const st = kb.stateAt(2);
  a.ok(Math.hypot(st.x - pts[1].x, st.y - pts[1].y, st.z - pts[1].z) < 1e-3 && kb.dur === 12, 'a pin that does not increase is ignored');
}, { group: 'studio' });

registerSelfCheck('space-c: Space Master document — one source per track, follows the track list', (a) => {
  const m = createSpaceMaster();
  a.ok(m.on === false && m.wet === 1 && m.doc.sources.length === 0, 'a new master is off, wet and empty');
  a.equal(JSON.stringify(normalizeSpaceMaster(JSON.parse(JSON.stringify(m)))), JSON.stringify(m), 'normalize is idempotent (empty master keeps no source)');
  const tracks = [{ id: 'A', name: 'One', color: '#111111' }, { id: 'B', name: 'Two', color: '#222222' }, { id: 'C', name: 'Three', color: '#333333' }];
  const s1 = syncMasterSources(m.doc, tracks, 20);
  a.ok(s1.length === 3 && s1.every((s, i) => s.input.kind === 'track' && s.input.target === tracks[i].id && s.path.type === 'static' && s.duration === 20), 'one resting source per track, as long as the cycle');
  a.ok(s1[0].path.x < 0 && Math.abs(s1[1].path.x) < 1e-9 && s1[2].path.x > 0 && s1.every((s) => s.path.y > 0), 'spread on an arc in front of the listener');
  const doc = { ...m.doc, sources: s1 };
  a.equal(syncMasterSources(doc, tracks, 20), null, 'nothing to do when the lists agree');
  const renamed = syncMasterSources(doc, [tracks[0], { ...tracks[1], name: 'Renamed' }, tracks[2]], 20);
  a.ok(renamed && renamed[1].name === 'Renamed' && renamed[1].id === s1[1].id, 'names follow the tracks');
  const fewer = syncMasterSources(doc, [tracks[0], tracks[2]], 20);
  a.ok(fewer.length === 2 && fewer.every((s) => s.input.target !== 'B'), 'a removed track loses its source');
  const more = syncMasterSources(doc, [...tracks, { id: 'D', name: 'Four', color: '#444444' }], 20);
  a.ok(more.length === 4 && more[0] === s1[0] && more[3].input.target === 'D', 'a new track gets a source; the others keep theirs');
  const withMix = { ...doc, sources: [...s1, createSource(9, { id: 'own', input: { kind: 'synth' } })] };
  a.ok(syncMasterSources(withMix, [tracks[0]], 20).some((s) => s.id === 'own'), 'sources that are not tracks are kept');
  const n = normalizeSpaceMaster({ on: true, wet: 3, doc });
  a.ok(n.on && n.wet === 1 && n.compensate && n.doc.sources.length === 3 && n.doc.sources[0].input.kind === 'track', 'saved master normalises (wet clamped, tracks kept)');
  const p0 = arcPlace(0, 5);
  const p4 = arcPlace(4, 5);
  a.ok(Math.abs(p0.x + p4.x) < 1e-9 && Math.abs(p0.y - p4.y) < 1e-9, 'the arc is symmetric');
}, { group: 'studio' });

registerSelfCheck('space-c: start / end points and the height envelope of analytic paths', async (a) => {
  const E = await import('./space-engine.js');
  const base = E.createSource(0, { id: 'sp', path: { type: 'spiral', cx: 0, cy: 0, r0: 40, r1: 5, turns: 2, h: 1 } }).path;
  const nat = E.pathEndpoints(base, { x: 0, y: 0 }).natural;
  const path = { ...base, ends: { start: { x: null, y: null, z: 3 }, end: { x: nat.end.x + 10, y: null, z: 13 } } };
  const geo = E.buildGeometry(path, { x: 0, y: 0 });
  const s = geo.P(0);
  const e = geo.P(1);
  a.ok(Math.abs(s.x - nat.start.x) < 1e-9 && Math.abs(s.z - 3) < 1e-9, 'start: untouched axes stay, z moved');
  a.ok(Math.abs(e.x - (nat.end.x + 10)) < 1e-9 && Math.abs(e.z - 13) < 1e-9, 'end: x and z moved');
  let mono = true;
  let prev = -Infinity;
  for (let i = 0; i <= 50; i++) { const z = geo.P(i / 50).z; if (z < prev - 1e-9) mono = false; prev = z; }
  a.ok(mono && geo.is3, 'the middle follows evenly (z rises monotonically from start to end)');
  const orbit = E.createSource(0, { path: { type: 'orbit', rx: 20, ry: 20, ends: { start: {}, end: { z: 6 } } } }).path;
  a.ok(!E.buildGeometry(orbit, { x: 0, y: 0 }).closed, 'a closed path with different ends runs once');
  a.ok(E.buildGeometry({ ...orbit, ends: null }, { x: 0, y: 0 }).closed, 'without overrides it stays closed');
}, { group: 'studio' });
