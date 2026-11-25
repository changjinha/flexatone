/**
 * Flexatone — studios/space/space-checks-xf.js
 * Self-checks of the Space trajectory transform toolbox (0.54.0): rotation about x / y / z, size with
 * the proportions kept, stretch per axis (proportions kept or free), mirror, reverse, reset.
 * 스페이스 궤적 변형 툴박스 자가진단: x / y / z 회전, 비율 유지 크기, 축별 늘이기(비율 유지 / 자유), 거울, 역방향, 초기화.
 *
 * Imported by space-panels.js (registration only). Pure: no audio.
 */

import { registerSelfCheck } from '../../core/state.js';
import {
  mapCurve, defaultCurveMap, normalizeCurveMap, setCurveStretch, resetCurveXf, curveXfActive,
  registerSpaceCurveSource, listCurves, createCurveLink, resolveCurveLink, STRETCH_MAX,
} from './space-curve-link.js';

const TEST = 'zz_xf_test';
// A Glissando-like line: time 0…4 s, pitch 60 → 72 (flat: z = 0) / 글리산도 같은 선
const line = () => Array.from({ length: 41 }, (_, i) => ({ x: i / 10, y: 60 + 3 * (i / 10), z: 0, t: i / 10 }));
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

registerSelfCheck('space-xf: trajectory transform — identity, rotate x / y / z, size + stretch with / without proportions, mirror, reverse', (a) => {
  const pts = line();
  const base = defaultCurveMap('line', { x: 0, y: 0, z: 1.5 });
  // Identity: a map without the new fields gives exactly the old result / 항등: 새 필드 없는 매핑 = 이전과 같은 결과
  const old = { axes: base.axes, fit: base.fit, size: base.size, unit: base.unit, cx: base.cx, cy: base.cy, cz: base.cz, yaw: 0 };
  const m0 = mapCurve(pts, old, 'line');
  const m1 = mapCurve(pts, base, 'line');
  a.ok(m0.every((p, i) => p.x === m1[i].x && p.y === m1[i].y && p.z === m1[i].z), 'no transform = bit-identical to the mapping without the transform fields');
  a.ok(!curveXfActive(old) && !curveXfActive(base), 'an older map reads as "no transform"');
  // Stand up: 90° about x → pitch becomes height / 세우기: 음고 → 높이
  const up = mapCurve(pts, { ...base, rx: 90 }, 'line');
  a.ok(up.every((p, i) => close(p.y, base.cy, 1e-9) && close(p.z - base.cz, m1[i].y - base.cy, 1e-9) && close(p.x, m1[i].x, 1e-12)), 'rotate 90° about x: y → z, x unchanged');
  // About y: x → −z / y축: x → −z
  const ry = mapCurve(pts, { ...base, ry: 90 }, 'line');
  a.ok(ry.every((p, i) => close(p.x - base.cx, 0, 1e-9) && close(p.z - base.cz, -(m1[i].x - base.cx), 1e-9)), 'rotate 90° about y: x → −z');
  // Yaw 90 = the ⟲ 90° button / z축 90°
  const rz = mapCurve(pts, { ...base, yaw: 90 }, 'line');
  a.ok(rz.every((p, i) => close(p.x - base.cx, -(m1[i].y - base.cy), 1e-9) && close(p.y - base.cy, m1[i].x - base.cx, 1e-9)), 'rotate 90° about z: (x, y) → (−y, x)');
  // Rotation keeps distances from the centre / 회전은 중심 거리 보존
  const any = mapCurve(pts, { ...base, rx: 33, ry: -71, yaw: 140 }, 'line');
  const d = (p) => Math.hypot(p.x - base.cx, p.y - base.cy, p.z - base.cz);
  a.ok(any.every((p, i) => close(d(p), d(m1[i]), 1e-9)), 'any rotation keeps every distance from the centre');
  // Size keeps proportions / 크기는 비율 유지
  const half = mapCurve(pts, { ...base, size: base.size / 2 }, 'line');
  a.ok(half.every((p, i) => close(p.x - base.cx, (m1[i].x - base.cx) / 2, 1e-9) && close(p.y - base.cy, (m1[i].y - base.cy) / 2, 1e-9)), 'half the size = every axis halved');
  // Stretch with the proportions kept: all three move by the same factor / 비율 유지 늘이기
  const k = normalizeCurveMap({ ...base, sx: 1, sy: 2, sz: 1 }, 'line');
  setCurveStretch(k, 0, 3);
  a.ok(close(k.sx, 3) && close(k.sy, 6) && close(k.sz, 3), `keep on: x 1 → 3 also scales y and z ×3 (${k.sx} : ${k.sy} : ${k.sz})`);
  setCurveStretch(k, 1, 100);
  a.ok(close(k.sy, STRETCH_MAX) && close(k.sx / k.sy, 0.5, 1e-3) && close(k.sz / k.sy, 0.5, 1e-3), 'keep on: the limit stops the factor, the ratio stays');
  // Free stretch / 자유 늘이기
  const f = normalizeCurveMap({ ...base, keep: false }, 'line');
  setCurveStretch(f, 1, 2.5);
  a.ok(f.sx === 1 && f.sy === 2.5 && f.sz === 1, 'keep off: only that axis changes');
  const st = mapCurve(pts, f, 'line');
  a.ok(st.every((p, i) => close(p.x, m1[i].x, 1e-12) && close(p.y - base.cy, 2.5 * (m1[i].y - base.cy), 1e-9)), 'stretch y × 2.5 scales the pitch axis only');
  // Mirror / 거울
  const fy = mapCurve(pts, { ...base, flip: [false, true, false] }, 'line');
  a.ok(fy.every((p, i) => close(p.y - base.cy, -(m1[i].y - base.cy), 1e-12) && close(p.x, m1[i].x, 1e-12)), 'mirror y flips the pitch axis about the centre');
  // Reset / 초기화
  const r = resetCurveXf(normalizeCurveMap({ ...base, rx: 10, ry: 20, yaw: 30, sx: 2, keep: false, flip: [true, true, true], rev: true, size: 12 }, 'line'));
  a.ok(!curveXfActive(r) && r.size === 12 && r.keep === true, 'reset clears rotation, stretch, mirror and direction; size stays');
  // Reverse through a link (with node times) / 링크를 통한 역방향 (노드 시각)
  registerSpaceCurveSource(TEST, { curves: () => [{ key: 'l', name: 'Line', pts: line().map((p) => ({ ...p, y: p.y + 2 * Math.sin(p.x * 3) })) }] });
  try {
    const c = listCurves(TEST).find((x) => x.key === 'l');
    const fwd = resolveCurveLink({ ...createCurveLink(TEST, c), time: 'pinned' });
    const link = createCurveLink(TEST, c);
    const back = resolveCurveLink({ ...link, time: 'pinned', map: { ...link.map, rev: true } });
    const F = fwd.nodes;
    const B = back.nodes;
    a.ok(fwd.status === 'ok' && back.status === 'ok' && B.length >= 2, 'reversed link resolves');
    a.ok(Math.hypot(B[0].x - F[F.length - 1].x, B[0].y - F[F.length - 1].y) < 1e-3 && Math.hypot(B[B.length - 1].x - F[0].x, B[B.length - 1].y - F[0].y) < 1e-3, 'reverse: the path starts where the forward one ends');
    a.ok(back.pinned && B.every((n, i) => i === 0 || n.t > B[i - 1].t) && close(back.dur, fwd.dur, 1e-6), `reverse keeps node times rising, same duration (${back.dur} s)`);
  } finally {
    registerSpaceCurveSource(TEST, null);
  }
});
