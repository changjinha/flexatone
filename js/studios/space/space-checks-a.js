/**
 * Flexatone — studios/space/space-checks-a.js
 * Layer 2 (studios, pure): self-checks of the Space extension A — 3-D node splines, time modes,
 * speed envelopes in the three domains, parameter lanes, the Comet preset and the view maths.
 * 계층 2 (studios, 순수): 스페이스 확장 A 자가진단 — 3D 노드 스플라인, 시간 모드, 세 도메인의 속도 엔벨로프,
 * 파라미터 레인, 혜성 프리셋, 뷰 수학.
 *
 * Imported by studios/space-studio.js (registration only). Imports: core/*, studios/space/*.
 */

import { deepClone } from '../../core/math-utils.js';
import { registerSelfCheck } from '../../core/state.js';
import { nodesFromPoints } from '../../modules/spline3d.js';
import {
  createSource, createSpacePreset, createDefaultSpaceParams, normalizeSpaceDoc, bakeSource, bakeSpace, getSpaceBakeCount,
  getKinematics, solveEmission, sampleBake, effectiveC, convertPathToSpline, motionSummary, SPACE_PRESETS, airCutoff,
} from './space-engine.js';
import { createLane, laneValue, laneNorm, normalizeLane, pointsFromFunction } from './space-lanes.js';
import { orthoView, perspView, hitNode, moveNode, moveHandle, insertNode, deleteNodes, setSplineDims, worldNodes, liftForZ } from './space-views.js';

const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, ...over, sources });
const flat = (y) => ({ engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y, handles: [] }, { x: 1, y, handles: [] }] });
const ramp = (y0, y1) => ({ engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y: y0, handles: [] }, { x: 1, y: y1, handles: [] }] });
const splinePath = (pts, over = {}) => ({ type: 'spline', spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints(pts), ...over } });
const WIGGLE = [{ x: -60, y: 20, z: 4 }, { x: -20, y: 5, z: 10 }, { x: 10, y: 14, z: 2 }, { x: 45, y: -8, z: 12 }, { x: 80, y: 6, z: 5 }];

registerSelfCheck('space-a: a two-node spline is the legacy line; orbit → spline keeps the Doppler curve', (a) => {
  const line = createSource(0, { id: 'l', path: { type: 'line', x0: -150, y0: 5, x1: 150, y1: 5 }, speed: { value: 20 }, duration: 15, f: { hz: 440 } });
  const spl = createSource(0, { id: 's', path: splinePath([{ x: -150, y: 5, z: 0 }, { x: 150, y: 5, z: 0 }]), speed: { value: 20 }, duration: 15, f: { hz: 440 } });
  const doc = docWith([line, spl], { cScale: 0.5 });
  const b0 = bakeSource(doc.sources[0], doc);
  const b1 = bakeSource(doc.sources[1], doc);
  a.near(getKinematics(doc.sources[1], doc).dur, 15, 1e-9, 'duration = length / speed (a result)');
  a.equal(b1.n, b0.n, 'same sample count');
  let worst = 0;
  // the last sample differs by design: the line keeps moving, the spline rests at its end / 마지막 표본은 의도된 차이 (스플라인은 끝에서 정지)
  for (let i = 0; i < b0.n - 2; i++) worst = Math.max(worst, Math.abs(b1.fObs[i] / b0.fObs[i] - 1), Math.abs(b1.gain[i] - b0.gain[i]), Math.abs(b1.pan[i] - b0.pan[i]));
  a.ok(worst < 1e-9, `spline pass-by = line pass-by (worst ${worst.toExponential(2)})`);
  // Orbit → spline / 궤도 → 스플라인
  const orb = createSource(0, { id: 'o', path: { type: 'orbit', cx: 14, cy: 8, rx: 26, ry: 26 }, speed: { value: 24 }, duration: 6, f: { hz: 330 } });
  const conv = convertPathToSpline(orb, { x: 0, y: 0 });
  a.ok(conv.nodes.length >= 8 && conv.nodes.length <= 64 && conv.closed, `orbit → ${conv.nodes.length} nodes, closed`);
  const { error, angle, ...sp } = conv;
  a.ok(error <= Math.max(0.5, 0.005 * 2 * Math.PI * 26), `deviation ${error.toFixed(3)} m within tolerance`);
  const os = createSource(0, { id: 'os', path: { type: 'spline', spline: sp }, speed: { value: 24 }, duration: 6, f: { hz: 330 } });
  const d2 = docWith([orb, os], { cScale: 0.4 });
  const ba = bakeSource(d2.sources[0], d2);
  const bb = bakeSource(d2.sources[1], d2);
  let dev = 0;
  for (let k = 5; k < 95; k++) { const t = ba.t0 + (k / 100) * (ba.t1 - ba.t0); dev = Math.max(dev, Math.abs(sampleBake(bb, 'fObs', t) / sampleBake(ba, 'fObs', t) - 1)); }
  a.ok(dev < 0.005, `orbit vs converted spline f_obs (worst ${(dev * 100).toFixed(3)} %)`);
  for (const id of SPACE_PRESETS) {
    const d = createSpacePreset(id);
    for (const s of d.sources) { const c = convertPathToSpline(s, d.listener); a.ok(c.nodes.length >= 2 && c.nodes.length <= 64, `${id}: ${c.nodes.length} nodes`); }
  }
}, { group: 'studio' });

registerSelfCheck('space-a: 3-D distance, elevation and solver residual on node splines', (a) => {
  // A straight line passing at height z: closest approach = sqrt(d² + z²) / 높이 z로 지나는 직선
  const src = createSource(0, { id: 'h', path: splinePath([{ x: -80, y: 6, z: 8 }, { x: 80, y: 6, z: 8 }]), speed: { value: 20 }, f: { hz: 440 } });
  const doc = docWith([src], { cScale: 0.5 });
  const b = bakeSource(doc.sources[0], doc);
  a.near(b.rMin, Math.hypot(6, 8), 1e-3, 'closest approach = sqrt(d² + z²)');
  a.ok(Array.from(b.up).every((u) => u > 0), 'a source above the listener has up > 0');
  const low = docWith([src], { cScale: 0.5, listener: { x: 0, y: 0, z: 20, headingDeg: 0 } });
  a.ok(Array.from(bakeSource(low.sources[0], low).up).every((u) => u < 0), 'listener above the source → up < 0');
  a.near(bakeSource(low.sources[0], low).rMin, Math.hypot(6, 12), 1e-3, 'listener height is part of the distance');
  const cases = [
    createSource(0, { id: 'w', path: splinePath(WIGGLE), speed: { value: 30 } }),
    createSource(0, { id: 'c', path: splinePath(WIGGLE.map((p, i) => ({ ...p, curv: i === 2 ? 0 : 1 }))), speed: { value: 30 } }),
    createSource(0, { id: 'p', path: splinePath(WIGGLE, { end: 'pingpong' }), speed: { value: 40 }, duration: 9 }),
    createSpacePreset('comet').sources[0],
    createSpacePreset('helix').sources[0],
  ];
  for (const cScale of [1, 0.3]) {
    const d = docWith(cases, { cScale });
    let worst = 0;
    for (const s of d.sources) {
      const kin = getKinematics(s, d);
      const bk = bakeSource(s, d);
      worst = Math.max(worst, bk.maxResidual);
      for (let k = 1; k < 30; k++) {
        const sol = solveEmission(kin, d.listener, bk.t0 + (k / 30) * (bk.t1 - bk.t0));
        a.ok(sol, `solution exists (${s.id})`);
        worst = Math.max(worst, Math.abs(sol.residual));
      }
      a.ok(['fObs', 'gain', 'lp', 'pan', 'up', 'z'].every((key) => Array.from(bk[key]).every(Number.isFinite)), `finite bake (${s.id})`);
    }
    a.ok(worst < 1e-9, `max residual ${worst.toExponential(2)} at cScale ${cScale}`);
  }
}, { group: 'studio' });

registerSelfCheck('space-a: time modes and speed envelopes (time / path / distance): ∫v dτ = path length', (a) => {
  const lane = (domain, over = {}) => createLane('speed', { on: true, domain, min: 5, max: 45, curve: ramp(0.1, 0.9), ...over });
  for (const domain of ['time', 'path', 'distance']) {
    const src = createSource(0, { id: `e_${domain}`, path: splinePath(WIGGLE), speed: { mode: 'env', env: lane(domain) }, duration: 8, timeMode: 'speed' });
    const doc = docWith([src], { cScale: 1 });
    const kin = getKinematics(doc.sources[0], doc);
    const N = 20000;
    let area = 0;
    for (let i = 0; i < N; i++) area += 0.5 * (kin.speedAt((i / N) * kin.dur) + kin.speedAt(((i + 1) / N) * kin.dur)) * (kin.dur / N);
    a.ok(Math.abs(area / kin.geo.len - 1) < 1e-4, `${domain}: ∫v dτ = ${area.toFixed(4)} vs length ${kin.geo.len.toFixed(4)}`);
    a.near(kin.distAt(kin.dur), kin.geo.len, 1e-6 * kin.geo.len, `${domain}: arrives at the end exactly at the resulting duration`);
    // position and speed agree: numeric dS/dτ = speedAt / 위치와 속도가 일치
    const tau = 0.37 * kin.dur;
    const num = (kin.distAt(tau + 1e-5) - kin.distAt(tau - 1e-5)) / 2e-5;
    a.ok(Math.abs(num / kin.speedAt(tau) - 1) < 1e-4, `${domain}: dS/dτ = v (${num.toFixed(4)} vs ${kin.speedAt(tau).toFixed(4)})`);
    const fit = docWith([{ ...src, id: `f_${domain}`, timeMode: 'fit', duration: 11 }]);
    const kf = getKinematics(fit.sources[0], fit);
    a.near(kf.dur, 11, 1e-6, `${domain}: fit → the duration is exactly the requested one`);
    a.near(kf.distAt(kf.dur), kf.geo.len, 1e-5 * kf.geo.len, `${domain}: fit → the whole path is covered`);
  }
  // Fit keeps the profile's proportions (path domain: v(0.25) / v(0.75)) / 고정 모드는 비율을 유지
  const p = createSource(0, { id: 'ratio', path: splinePath([{ x: 0, y: 5, z: 0 }, { x: 200, y: 5, z: 0 }]), speed: { mode: 'env', env: lane('path', { min: 0, max: 40, curve: ramp(0.25, 1) }) }, duration: 10, timeMode: 'fit' });
  const pd = docWith([p]);
  const pk = getKinematics(pd.sources[0], pd);
  const tauAt = (frac) => { let lo = 0, hi = pk.dur; for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (pk.distAt(m) < frac * 200) lo = m; else hi = m; } return lo; };
  a.near(pk.speedAt(tauAt(0.75)) / pk.speedAt(tauAt(0.25)), (0.25 + 0.75 * 0.75) / (0.25 + 0.75 * 0.25), 1e-3, 'fit keeps the speed ratios of the envelope');
  // Loop, run 'duration': keeps the user's duration and wraps / 순환 (지속시간만큼): 지속시간을 유지하며 돈다
  const loop = createSource(0, { id: 'loop', path: splinePath(WIGGLE, { end: 'loop', run: 'duration' }), speed: { value: 50 }, duration: 12 });
  const ld = docWith([loop]);
  const lk = getKinematics(ld.sources[0], ld);
  a.near(lk.dur, 12, 1e-9, 'loop for Duration: duration stays as set');
  // Loop, default run 'scene': it keeps going until the end of the time axis, also in Fit (Duration = one lap)
  // 순환 (기본): 시간 축 끝까지 계속. Fit에서는 지속시간 = 한 바퀴
  for (const tm of ['speed', 'fit']) {
    const sd = docWith([createSource(0, { id: 'run', path: splinePath(WIGGLE, { end: tm === 'fit' ? 'pingpong' : 'loop' }), speed: { value: 50 }, duration: 4, start: 2, timeMode: tm })]);
    const sk = getKinematics(sd.sources[0], sd);
    a.near(sk.dur, sd.length - 2, 1e-9, `${tm}: a looping path runs until the scene ends (${sk.dur.toFixed(1)} s)`);
    if (tm === 'fit') a.near(sk.lapSec, 4, 1e-6, 'fit: Duration is the time of one lap');
    a.ok(sk.speedAt(sk.dur - 0.01) > 0 && sk.distAt(sk.dur) > 2 * sk.geo.len, 'it is still moving at the end, after more than two laps');
  }
  a.ok(lk.distAt(12) > lk.geo.len, 'loop: more than one lap');
  const ms = motionSummary(ld.sources[0], ld);
  a.ok(ms.len > 0 && Math.abs(ms.max - 50) < 1e-6, 'motion summary reports the constant speed');
}, { group: 'studio' });

registerSelfCheck('space-a: lanes — gain dB, Doppler amount, brightness, air, domains; off = unchanged', (a) => {
  const base = createSource(0, { id: 'b', path: splinePath([{ x: -90, y: 6, z: 0 }, { x: 90, y: 6, z: 0 }]), speed: { value: 30 }, f: { hz: 440 } });
  const d0 = docWith([base], { cScale: 0.5 });
  const b0 = bakeSource(d0.sources[0], d0);
  a.ok(b0.gainLane === undefined && b0.morph === undefined, 'no lane arrays while the lanes are off');
  const withLane = (lanes, over = {}) => { const d = docWith([{ ...deepClone(base), id: `x${Math.random()}`, lanes, ...over }], { cScale: 0.5 }); return bakeSource(d.sources[0], d); };
  // neutral-valued lanes that are OFF change nothing / 꺼진 레인은 아무것도 바꾸지 않음
  const off = withLane({ gain: createLane('gain', { on: false, curve: flat(0) }) });
  a.ok(Array.from(off.fObs).every((v, i) => v === b0.fObs[i]) && Array.from(off.lp).every((v, i) => v === b0.lp[i]), 'lanes off → identical arrays');
  const g = withLane({ gain: createLane('gain', { on: true, min: -12, max: 0, curve: flat(0.5) }) });
  a.ok(Array.from(g.gainLane).every((v) => Math.abs(v - Math.pow(10, -6 / 20)) < 1e-9), 'gain lane −6 dB → ×0.5012');
  const dop0 = withLane({ dopplerAmt: createLane('dopplerAmt', { on: true, min: 0, max: 1, curve: flat(0) }) });
  a.ok(Array.from(dop0.fObs).every((v) => Math.abs(v - 440) < 1e-9), 'Doppler amount 0 → f_obs = f_s');
  const dop1 = withLane({ dopplerAmt: createLane('dopplerAmt', { on: true, min: 0, max: 1, curve: flat(1) }) });
  let w = 0;
  for (let i = 0; i < b0.n; i++) w = Math.max(w, Math.abs(dop1.fObs[i] / b0.fObs[i] - 1));
  a.ok(w < 1e-12, 'Doppler amount 1 → the physical ratio');
  const br = withLane({ bright: createLane('bright', { on: true, min: -3, max: 3, curve: flat(2 / 3) }) });
  let ok = true;
  for (let i = 0; i < b0.n; i++) { const want = Math.min(20000, b0.lp[i] * 2); if (Math.abs(br.lp[i] - want) > 1e-6) ok = false; }
  a.ok(ok, 'brightness +1 oct → cutoff ×2 (inside the clamp)');
  const air0 = withLane({ air: createLane('air', { on: true, min: 0, max: 2, curve: flat(0) }) });
  a.ok(Array.from(air0.lp).every((v) => Math.abs(v - 18000) < 1e-2), 'air amount 0 → no absorption (18 kHz)');
  const air2 = withLane({ air: createLane('air', { on: true, min: 0, max: 2, curve: flat(1) }) });
  a.near(air2.lp[10], airCutoff(air2.r[10], d0.airDist / 2), 1e-9, 'air amount 2 → airDist / 2');
  // Constant speed on an open path: path progress = τ / duration, so both domains give the same lane
  // 등속·열린 경로: 경로 진행도 = τ / 지속시간 → 두 도메인의 레인이 같음
  const gt = withLane({ gain: createLane('gain', { on: true, domain: 'time', curve: ramp(0.2, 0.9) }) });
  const gp = withLane({ gain: createLane('gain', { on: true, domain: 'path', curve: ramp(0.2, 0.9) }) });
  let dv = 0;
  for (let i = 0; i < gt.n; i++) dv = Math.max(dv, Math.abs(gt.gainLane[i] - gp.gainLane[i]));
  a.ok(dv < 1e-6, `time-domain lane = path-domain lane at constant speed (${dv.toExponential(1)})`);
  // Distance domain: the value depends on r only / 거리 도메인: 값은 r에만 의존
  const gd = withLane({ gain: createLane('gain', { on: true, domain: 'distance', dom: [0, 100], min: -20, max: 0, curve: ramp(1, 0) }) });
  for (const i of [5, Math.floor(gd.n / 2), gd.n - 6]) a.near(20 * Math.log10(gd.gainLane[i]), -20 * Math.min(1, gd.r[i] / 100), 2e-2, `distance lane follows r (${gd.r[i].toFixed(1)} m)`);
  const mo = withLane({ timbre: createLane('timbre', { on: true, curve: ramp(0, 1) }) });
  a.ok(mo.morph[0] < 0.01 && mo.morph[mo.n - 1] > 0.99 && Array.from(mo.morph).every((v, i) => i === 0 || v >= mo.morph[i - 1] - 1e-9), 'timbre lane ramps 0 → 1');
  // Pitch envelope (log) / 음고 엔벨로프 (로그)
  const pe = withLane({}, { f: { mode: 'env', env: createLane('pitch', { on: true, domain: 'time', min: 220, max: 880, curve: ramp(0, 1) }) } });
  a.near(pe.fs[0], 220, 0.5, 'pitch envelope starts at min');
  let im = 0; // sample whose EMISSION time is the middle of the source's life / 방출 시각이 중간인 표본
  for (let i = 0; i < pe.n; i++) if (Math.abs(pe.te[i] - 3) < Math.abs(pe.te[im] - 3)) im = i;
  a.near(pe.fs[im], 440, 3, 'log scale: the middle (emission time) is the geometric mean');
  const l = normalizeLane('pitch', { min: 100, max: 1600, scale: 'log' });
  a.near(laneNorm(l, laneValue(l, 0.3)), 0.3, 1e-12, 'lane value ↔ norm round trip');
}, { group: 'studio' });

registerSelfCheck('space-a: Comet preset — fastest at the closest approach, pitch up then down, no clamp', (a) => {
  const doc = normalizeSpaceDoc(createSpacePreset('comet'));
  const s = doc.sources[0];
  const kin = getKinematics(s, doc);
  const b = bakeSource(s, doc);
  a.ok(!b.clamped && b.maxVc < 0.98, `subsonic (max v/c ${b.maxVc.toFixed(3)})`);
  const Lz = doc.listener.z || 0;
  const rOf = (st) => Math.hypot(st.x - doc.listener.x, st.y - doc.listener.y, st.z - Lz);
  let tauR = 0, tauV = 0, rBest = Infinity, vBest = 0;
  const N = 2000;
  for (let i = 0; i <= N; i++) {
    const tau = (i / N) * kin.dur;
    const st = kin.stateAt(tau);
    const r = rOf(st);
    if (r < rBest) { rBest = r; tauR = tau; }
    if (st.speed > vBest) { vBest = st.speed; tauV = tau; }
  }
  a.ok(Math.abs(tauR - tauV) < 0.05, `fastest at the closest approach (Δ ${(tauR - tauV).toFixed(3)} s)`);
  a.ok(vBest > 2.5 * kin.speedAt(0) && vBest > 2.5 * kin.speedAt(kin.dur * 0.999), `speeds up and slows down (${kin.speedAt(0).toFixed(1)} → ${vBest.toFixed(1)} → ${kin.speedAt(kin.dur * 0.999).toFixed(1)} m/s)`);
  let mono = true;
  let prev = { r: Infinity, v: 0 };
  for (let i = 0; i <= 400; i++) { // approach: r falls, v rises / 접근: r 감소, v 증가
    const st = kin.stateAt((i / 400) * tauR);
    const r = rOf(st);
    if (r < prev.r - 1e-9 && st.speed < prev.v - 1e-6) mono = false;
    prev = { r, v: st.speed };
  }
  a.ok(mono, 'while approaching, a smaller distance never has a smaller speed');
  let iMin = 0;
  for (let i = 0; i < b.n; i++) if (b.r[i] < b.r[iMin]) iMin = i;
  a.ok(b.fObs[Math.max(0, iMin - 60)] > b.fs[0] * 1.2 && b.fObs[Math.min(b.n - 1, iMin + 60)] < b.fs[0] * 0.9, 'pitch above f_s before the pass, below after');
  a.ok(b.lp[iMin] > b.lp[0] * 4, 'brightness lane opens the filter near the listener');
  a.equal(JSON.stringify(normalizeSpaceDoc(deepClone(doc))), JSON.stringify(doc), 'normalize is idempotent (comet)');
  const helix = normalizeSpaceDoc(createSpacePreset('helix'));
  a.equal(JSON.stringify(normalizeSpaceDoc(JSON.parse(JSON.stringify(helix)))), JSON.stringify(helix), 'normalize is idempotent after a JSON round trip (helix)');
  const hb = bakeSource(helix.sources[0], helix);
  a.ok(hb.up[hb.n - 1] > hb.up[0] + 0.5, 'helix climbs: elevation rises');
}, { group: 'studio' });

registerSelfCheck('space-a: signature — sound-only edits never re-bake, lane / node edits bake once; old documents', (a) => {
  const doc = normalizeSpaceDoc(createSpacePreset('comet'));
  doc.cScale = 0.3 + Math.random() * 0.01; // unique per run (the bake cache keeps entries) / 실행마다 고유
  const first = bakeSpace(doc);
  const c0 = getSpaceBakeCount();
  const q = deepClone(doc);
  q.sources[0].baseGain = 0.2;
  q.sources[0].timbreB.saw = 0.1;
  q.sources[0].muted = true;
  q.view3d = { layout: 'top', az: 10, el: 60, dist: 2 };
  a.ok(bakeSpace(q) === first, 'baseGain / timbre B / mute / camera → cached');
  a.equal(getSpaceBakeCount() - c0, 0, 'bake count unchanged');
  q.sources[0].lanes.bright.curve.customPoints[3].y += 0.01;
  bakeSpace(q);
  bakeSpace(q);
  a.equal(getSpaceBakeCount() - c0, 1, 'lane point moved → 1 bake');
  q.sources[0].path.spline.nodes[2].z += 1;
  bakeSpace(q);
  a.equal(getSpaceBakeCount() - c0, 2, 'node moved → 1 bake');
  q.listener.z = 1.5;
  bakeSpace(q);
  a.equal(getSpaceBakeCount() - c0, 3, 'listener height → 1 bake');
  // A document saved before the extension / 확장 이전에 저장된 문서
  const old = { c: 343, cScale: 0.5, listener: { x: 1, y: 2, headingDeg: 30 }, sources: [{ id: 'o1', path: { type: 'line', x0: -50, y0: 4, x1: 50, y1: 4 }, speed: { mode: 'const', value: 12 }, duration: 9, f: { mode: 'const', hz: 300 } }] };
  const n = normalizeSpaceDoc(old);
  const s = n.sources[0];
  a.ok(n.listener.z === 0 && n.view3d.layout === 'top' && s.timeMode === 'speed' && s.path.spline.nodes.length === 0 && Object.values(s.lanes).every((l) => l.on === false) && s.speed.env && s.f.env, 'old document gains the new fields with neutral defaults');
  a.equal(JSON.stringify(normalizeSpaceDoc(deepClone(n))), JSON.stringify(n), 'normalize is idempotent (old document)');
}, { group: 'studio' });

registerSelfCheck('space-a: views — ortho round trip, node picking and edits on each plane, perspective depth', (a) => {
  const c = { x: 3, y: -4, z: 6 };
  for (const plane of ['top', 'front', 'side']) {
    const v = orthoView(plane, 640, 400, c, 150);
    const w = v.fromPx(123.4, 56.7);
    const p = v.toPx({ x: 0, y: 0, z: 0, ...w });
    a.ok(Math.abs(p.x - 123.4) < 1e-9 && Math.abs(p.y - 56.7) < 1e-9, `${plane}: screen → world → screen`);
    const nodes = [{ id: 'a', x: 10, y: 5, z: 3 }, { id: 'b', x: -20, y: 30, z: 12 }, { id: 'c', x: 40, y: -15, z: 25 }];
    const q = v.toPx(nodes[1]);
    a.equal(hitNode(nodes, v, q.x + 2, q.y - 2), 1, `${plane}: picks the node under the pointer`);
    a.equal(hitNode(nodes, v, q.x + 60, q.y + 60), -1, `${plane}: nothing far from every node`);
  }
  const path = { type: 'spline', h: 2, spline: { dims: '3d', closed: false, end: 'stop', nodes: nodesFromPoints(WIGGLE) } };
  const sp = path.spline;
  moveNode(sp, 'n2', 'front', 7, 33);
  a.ok(sp.nodes[1].x === 7 && sp.nodes[1].z === 33 && sp.nodes[1].y === 5, 'front view changes x and z only');
  moveNode(sp, 'n2', 'side', -9, 1);
  a.ok(sp.nodes[1].y === -9 && sp.nodes[1].z === 1 && sp.nodes[1].x === 7, 'side view changes y and z only');
  moveHandle(sp, 'n3', 'out', 'top', sp.nodes[2].x + 12, sp.nodes[2].y + 5);
  const n3 = sp.nodes[2];
  a.ok(n3.tangent === 'free' && n3.hout[0] === 12 && n3.hout[1] === 5, 'dragging a handle makes the node free');
  const dot = n3.hin[0] * n3.hout[0] + n3.hin[1] * n3.hout[1] + n3.hin[2] * n3.hout[2];
  a.ok(dot < 0 && Math.abs(dot + Math.hypot(...n3.hin) * Math.hypot(...n3.hout)) < 0.05 * Math.hypot(...n3.hin) * Math.hypot(...n3.hout), 'the opposite handle stays opposite');
  const before = sp.nodes.length;
  const id = insertNode(sp, 0, 0.5);
  a.ok(id && sp.nodes.length === before + 1 && sp.nodes[1].id === id, 'insert adds a node after the first');
  a.equal(deleteNodes(sp, sp.nodes.map((n) => n.id)), sp.nodes.length ? before + 1 - 2 : 0, 'delete keeps two nodes');
  setSplineDims(path, '2d');
  a.ok(sp.dims === '2d' && worldNodes(path).every((n) => n.z === 2), '2-D spline sits at the path height');
  moveNode(sp, sp.nodes[0].id, 'front', 1, 99);
  a.ok(sp.nodes[0].z === 0, 'a 2-D spline ignores z drags');
  a.ok(!liftForZ(path, 2) && sp.dims === '2d', 'a z equal to the height keeps the spline 2-D');
  a.ok(liftForZ(path, 7) && sp.dims === '3d' && sp.nodes.every((n) => n.z === 2), 'a z edit on a 2-D spline lifts it to 3-D at the height');
  setSplineDims(path, '2d');
  const pv = perspView(640, 400, { x: 0, y: 0, z: 0 }, 100, { az: 0, el: 30, dist: 1 });
  a.ok(pv.project({ x: 0, y: 40, z: 0 }).depth > pv.project({ x: 0, y: -40, z: 0 }).depth, 'perspective: farther points have a larger depth');
  a.ok(pv.project({ x: 0, y: 0, z: 20 }).y < pv.project({ x: 0, y: 0, z: 0 }).y, 'perspective: up is up');
  a.ok(pv.project({ x: 20, y: 0, z: 0 }).x > pv.project({ x: -20, y: 0, z: 0 }).x, 'perspective: +x is to the right at azimuth 0');
}, { group: 'studio' });

registerSelfCheck('space-a: speed envelope samples (vis-viva) and effective speed of sound', (a) => {
  const xs = [0, 0.25, 0.5, 0.75, 1];
  const pts = pointsFromFunction((x) => x * x, xs);
  a.ok(pts.length === 5 && pts[2].y === 0.25 && pts.every((p) => Array.isArray(p.handles)), 'pointsFromFunction samples y(x)');
  const doc = normalizeSpaceDoc(createSpacePreset('comet'));
  a.near(effectiveC(doc), 343 * 0.3, 1e-9, 'comet uses the artistic speed of sound');
}, { group: 'studio' });
