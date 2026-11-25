/**
 * Flexatone — studios/space/space-checks-f3.js
 * Self-checks of the Space follow-up F3: the room — image sources (position, delay, level, Doppler
 * against closed forms), the comb filter of a ground reflection, the reverb impulse (determinism,
 * RT60) and the regression of the "off" state.
 * 스페이스 후속 F3 자가진단: 방 — 영상 음원(위치·지연·레벨·도플러를 해석값과 대조), 지면 반사의 콤 필터,
 * 잔향 임펄스(결정론·RT60), 꺼짐 상태 회귀.
 *
 * Imported by space-panels.js (registration only). The audio checks render offline; no sound is played.
 */

import { registerSelfCheck } from '../../core/state.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams, createSpacePreset, bakeSource, spaceSignature, effectiveC, getSpaceBakeCount, bakeSpace } from './space-engine.js';
import { roomOf, roomActive, roomImages, bakeRoom, mirrorState, outsideDistance, reverbImpulse, measureRt60, reverbTailSec, normalizeRoom, getRoomBakeCount } from './space-room.js';
import { renderSpaceBuffer, getSpaceTimeline, spaceRenderKey, renderSpaceAmbix, scheduleSpace, prerenderStatus } from './space-audio.js';
import { playbackMode } from './space-engine.js';
import { virtualSpeakerCount } from '../../modules/ambisonics.js';

const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const SR = 48000;
const rms = (x, i0 = 0, i1 = x.length) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: 1, ...over, sources });
const still = (x, y, h, over = {}) => createSource(0, { id: 's', path: { type: 'static', x, y, h }, duration: 0.6, f: { hz: 400 }, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, airAbsorb: false, ...over });
const MIRROR = { quality: 'ground', floorZ: 0, absorb: { floor: 0 }, hfHz: 20000 };

registerSelfCheck('space-f3: image sources — counts, position / delay / level / Doppler vs closed forms, box, outside, off', (a) => {
  a.equal([roomImages({ quality: 'off' }).length, roomImages({ quality: 'ground' }).length, roomImages({ quality: 'first' }).length, roomImages({ quality: 'second' }).length].join(), '0,1,6,24', 'images per source: off 0, ground 1, first order 6, second order 24');
  a.equal(roomImages({ quality: 'first', absorb: { ceil: 1 } }).length, 5, 'a fully absorbing surface has no image');
  const m = mirrorState({ x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 }, [{ axis: 'z', at: 0.5 }]);
  a.ok(m.z === -2 && m.vz === -6 && m.x === 1 && m.vx === 4, 'mirror: z′ = 2·floor − z, v_z′ = −v_z');
  // Resting source above a mirror floor / 거울 바닥 위의 정지 음원
  const d1 = docWith([still(0, 10, 3)], { listener: { x: 0, y: 0, z: 1.7, headingDeg: 0 }, room: { ...MIRROR, absorb: { floor: 0.36 } } });
  const c = effectiveC(d1);
  const im = bakeRoom(d1).images.get('s')[0].bake;
  const rImg = Math.hypot(10, 3 + 1.7);
  const rDir = Math.hypot(10, 3 - 1.7);
  const k = Math.floor(im.n / 2);
  a.near(im.z[k], -3, 1e-12, 'image position: below the floor');
  a.near(im.r[k], rImg, 1e-9, 'image distance = path length of the reflection');
  a.near(im.t[k] - im.te[k], rImg / c, 1e-9, 'reflection delay = r′ / c');
  a.near(im.gain[k], (0.8 * 1) / rImg, 1e-9, 'reflection level = √(1 − α) · ref / r′');
  a.ok(im.up[k] < 0 && Math.abs(im.fObs[k] - 400) < 1e-9, 'it arrives from below; a resting source has no Doppler shift');
  const dir = bakeSpace(d1).sources.get('s');
  a.near((im.t[k] - im.te[k]) - (dir.t[k] - dir.te[k]), (rImg - rDir) / c, 1e-9, 'it is later than the direct sound by Δr / c');
  // Moving source: the image has its own radial speed / 움직이는 음원: 영상은 고유의 시선 속도
  const mv = createSource(0, { id: 'm', path: { type: 'line', x0: -60, y0: 6, x1: 60, y1: 6, h: 4 }, speed: { value: 30 }, duration: 4, f: { hz: 500 } });
  const d2 = docWith([mv], { listener: { x: 0, y: 0, z: 1.7, headingDeg: 0 }, room: MIRROR });
  const i2 = bakeRoom(d2).images.get('m')[0].bake;
  const j = Math.floor(i2.n * 0.2);
  const want = (i2.x[j] * 30) / Math.hypot(i2.x[j], 6, -4 - 1.7); // n̂·v with the image at z = −4 / 영상(z = −4)의 n̂·v
  a.near(i2.vr[j], want, 1e-6, 'radial speed of the image = n̂′ · v');
  a.near(i2.fObs[j], 500 / (1 + want / effectiveC(d2)), 1e-6, 'its Doppler shift follows from it');
  a.ok(i2.maxResidual < 1e-9, `retarded-time solver on the image (residual ${i2.maxResidual.toExponential(1)})`);
  // Box: first and second order / 상자: 1차·2차
  const box = { quality: 'second', floorZ: 0, w: 20, d: 30, h: 8, cx: 2, cy: -1, absorb: { floor: 0, ceil: 0, xn: 0, xp: 0, yn: 0, yp: 0 }, hfHz: 4000 };
  const d3 = docWith([still(5, 3, 2)], { listener: { x: 0, y: 0, z: 1.5, headingDeg: 0 }, room: box });
  const rb = bakeRoom(d3);
  const of = (key) => rb.images.get('s').find((x) => x.key === key).bake;
  a.near(of('xp').x[3], 2 * 12 - 5, 1e-12, 'first order, wall +x: x′ = 2·wall − x');
  a.near(of('xn+xp').x[3], 5 + 2 * 20, 1e-12, 'second order over opposite walls: x′ = x + 2·width');
  a.near(of('xp+xn').x[3], 5 - 2 * 20, 1e-12, '… and the other order of the same two walls: x′ = x − 2·width');
  a.ok(Math.abs(of('floor+xp').x[3] - 19) < 1e-12 && Math.abs(of('floor+xp').z[3] + 2) < 1e-12, 'second order over floor and wall: both mirrored');
  a.ok(of('xp').lp[3] === 4000 && of('xn+xp').lp[3] === 2000, 'reflection low-pass: one bounce = hfHz, two = half');
  a.equal(rb.count, 24, '24 images baked for one source');
  // A source on a wall: the image coincides with it, nothing blows up / 벽 위의 음원
  const d4 = docWith([still(12, 3, 2)], { listener: { x: 11.9, y: 3, z: 2, headingDeg: 0 }, room: { ...box, quality: 'first' } });
  const onWall = bakeRoom(d4).images.get('s').find((x) => x.key === 'xp').bake;
  a.ok(Math.abs(onWall.x[2] - 12) < 1e-12 && Number.isFinite(onWall.gain[2]) && onWall.gain[2] <= 1, 'a source on the wall: finite image level (the distance law is clamped at the reference distance)');
  // Outside the box: no wall reflections, and it is reported / 상자 밖: 벽 반사 없음
  const d5 = docWith([still(40, 3, 2)], { listener: { x: 0, y: 0, z: 1.5, headingDeg: 0 }, room: { ...box, quality: 'first' } });
  const out = bakeRoom(d5);
  a.ok(out.outside.join() === 's' && out.images.get('s').every((x) => x.bake.gain[2] === 0), 'a source beyond the walls: reflections silent, source reported');
  a.near(outsideDistance(normalizeRoom(box), { x: 40, y: 3, z: 2 }), 28, 1e-12, 'distance outside the box');
  a.ok(bakeRoom({ ...d5, room: { ...d5.room, quality: 'ground' } }).images.get('s')[0].bake.gain[2] > 0, 'the ground of an open field reflects everywhere');
  // Off / 꺼짐
  const plain = docWith([still(0, 10, 3)]);
  const offDoc = docWith([still(0, 10, 3)], { room: { quality: 'off', reverb: { on: false } } });
  a.ok(!roomActive(plain) && !roomActive(offDoc) && !('room' in plain), 'a document without a room has no room key; off = inactive');
  a.equal(spaceSignature(offDoc), spaceSignature(plain), 'the room is not part of the physics signature');
  a.equal(getSpaceTimeline(offDoc).endSec, getSpaceTimeline(plain).endSec, 'off: same length');
  a.equal(spaceRenderKey(offDoc), spaceRenderKey(plain), 'off: same render key (no re-render in the Manager)');
  const n0 = getRoomBakeCount();
  const b0 = getSpaceBakeCount();
  bakeRoom(d3);
  bakeRoom({ ...d3, room: { ...d3.room, reverb: { on: true, rt60: 5 } } });
  a.ok(getRoomBakeCount() === n0 && getSpaceBakeCount() === b0, 'reverb settings (and repeated calls) do not re-bake the reflections');
  a.ok(createSpacePreset('openfield').room.quality === 'ground' && createSpacePreset('hall').room.reverb.on && !createSpacePreset('passby').room, 'presets: Open Field = ground only, Hall = box + reverb, older presets have no room');
  a.ok(roomOf(plain).quality === 'off');
});

registerSelfCheck('space-f3: reverb impulse — deterministic, unit energy, RT60 within 10 %, decorrelated, pre-delay', (a) => {
  const A = reverbImpulse({ rt60: 1.8, predelay: 0.02, damp: 0.5, seed: 7 }, SR, 4);
  const B = reverbImpulse({ rt60: 1.8, predelay: 0.02, damp: 0.5, seed: 7 }, SR, 4);
  const C = reverbImpulse({ rt60: 1.8, predelay: 0.02, damp: 0.5, seed: 8 }, SR, 2);
  a.ok(A.every((x, c) => x.length === B[c].length && x.every((v, i) => v === B[c][i])), 'same seed = the same samples');
  a.ok(A[0].some((v, i) => v !== C[0][i]), 'another seed = another response');
  a.ok(A.every((x) => Math.abs(x.reduce((s, v) => s + v * v, 0) - 1) < 1e-4), 'every channel has unit energy');
  const pre = Math.round(0.02 * SR);
  a.ok(A[0].slice(0, pre).every((v) => v === 0) && A[0][pre + 5] !== 0, 'pre-delay: silence, then the tail');
  let dot = 0;
  for (let i = 0; i < A[0].length; i++) dot += A[0][i] * A[1][i];
  a.ok(Math.abs(dot) < 0.05, `channels are decorrelated (correlation ${dot.toFixed(3)})`);
  for (const [rt, damp] of [[0.5, 0], [1.8, 0.5], [4, 1]]) {
    const x = reverbImpulse({ rt60: rt, predelay: 0, damp, seed: 2 }, SR, 1)[0];
    const got = measureRt60(x, SR);
    a.ok(Math.abs(got / rt - 1) < 0.1, `RT60 ${rt} s (damping ${damp}) measured ${got.toFixed(2)} s`);
  }
  a.ok(reverbTailSec(normalizeRoom({ reverb: { on: false } })) === 0 && reverbTailSec(normalizeRoom({ reverb: { on: true, rt60: 2, predelay: 0.1 } })) > 2, 'the tail is rendered only when the reverb is on');
});

registerSelfCheck('space-f3: room in sound — comb notches of a ground reflection, α = 1 and off = the dry render, reverb tail', async (a) => {
  if (!Offline()) return;
  const L = { x: 0, y: 0, z: 1.7, headingDeg: 0 };
  const rDir = Math.hypot(10, 3 - 1.7);
  const rImg = Math.hypot(10, 3 + 1.7);
  const dr = rImg - rDir;
  const i0 = Math.floor(0.25 * SR), i1 = Math.floor(0.5 * SR);
  const level = async (hz, room) => { const buf = await renderSpaceBuffer({ params: docWith([still(0, 10, 3, { f: { hz } })], { listener: L, ...(room ? { room } : {}) }), sampleRate: SR, outputStage: false }); return rms(buf.getChannelData(0), i0, i1); };
  // Notch at (k + ½) c / Δr, peak at k c / Δr / 노치와 피크
  const fNotch = (2.5 * 343) / dr;
  const fPeak = (3 * 343) / dr;
  const dryN = await level(fNotch, null);
  const dryP = await level(fPeak, null);
  const wetN = await level(fNotch, MIRROR);
  const wetP = await level(fPeak, MIRROR);
  const q = rDir / rImg; // level of the reflection relative to the direct sound / 직접음 대비 반사 레벨
  a.near(wetN / dryN, 1 - q, 0.02, `notch at ${fNotch.toFixed(0)} Hz = (k + ½)·c / Δr: level × (1 − r / r′)`);
  a.near(wetP / dryP, 1 + q, 0.02, `peak at ${fPeak.toFixed(0)} Hz = k·c / Δr: level × (1 + r / r′)`);
  // Fully absorbing floor, and the room switched off: the dry render / 완전 흡수·꺼짐 = 원래 렌더
  const base = docWith([still(0, 10, 3)], { listener: L });
  const dry = await renderSpaceBuffer({ params: base, sampleRate: SR, outputStage: false });
  const same = async (room) => { const buf = await renderSpaceBuffer({ params: docWith([still(0, 10, 3)], { listener: L, room }), sampleRate: SR, outputStage: false }); if (buf.length !== dry.length) return 1; let m = 0; for (let ch = 0; ch < 2; ch++) { const x = buf.getChannelData(ch), y = dry.getChannelData(ch); for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i])); } return m; };
  a.ok((await same({ ...MIRROR, absorb: { floor: 1 } })) < 1e-9, 'reflection coefficient 0 = the direct sound alone');
  a.ok((await same({ quality: 'off', reverb: { on: false, rt60: 3 } })) < 1e-9, 'room off = the previous render');
  a.ok((await same({ quality: 'off', reverb: { on: true, level: 0 } })) < 1e-9, 'reverb level 0 = the previous render');
  // Reverb: a tail after the scene, deterministic, louder relative to the direct sound from afar / 잔향
  const rev = { quality: 'off', reverb: { on: true, rt60: 1.2, level: 0.5, predelay: 0.01, damp: 0.3, seed: 4, law: 'physical' } };
  const mk = (y, law = 'physical') => docWith([still(0, y, 3)], { listener: L, room: { ...rev, reverb: { ...rev.reverb, law } } });
  const r1 = await renderSpaceBuffer({ params: mk(10), sampleRate: SR, outputStage: false });
  const r2 = await renderSpaceBuffer({ params: mk(10), sampleRate: SR, outputStage: false });
  a.ok(r1.length > dry.length + SR, 'the render is longer by the reverb tail');
  const tailFrom = dry.length + Math.floor(0.1 * SR);
  a.ok(rms(r1.getChannelData(0), tailFrom, tailFrom + SR / 2) > 1e-5, 'the tail rings after the source has stopped');
  let diff = 0;
  for (let i = 0; i < r1.length; i += 3) diff = Math.max(diff, Math.abs(r1.getChannelData(0)[i] - r2.getChannelData(0)[i]));
  a.ok(diff < 1e-7, 'two renders with the same seed are the same');
  // Level of the tail well after the source has stopped / 음원이 멈춘 뒤 꼬리의 레벨
  const tail = async (y, law) => { const b = await renderSpaceBuffer({ params: mk(y, law), sampleRate: SR, outputStage: false }); const t0 = Math.floor((y / 343 + 0.75) * SR); return rms(b.getChannelData(0), t0, t0 + SR / 4); };
  const near = await tail(10, 'physical');
  const far = await tail(40, 'physical');
  a.ok(Math.abs(far / near - 1) < 0.1, `room level: the reverb is as loud from 40 m as from 10 m (${(far / near).toFixed(3)}) while the direct sound falls to a quarter`);
  const fNear = await tail(10, 'follow');
  const fFar = await tail(40, 'follow');
  a.ok(Math.abs((fFar / fNear) * 4 - 1) < 0.15, `follows direct: the reverb falls with the direct sound (${(fFar / fNear).toFixed(3)} for 4 × the distance)`);
  // HOA: the reverb is a first-order diffuse field / HOA: 1차 확산장
  const amb = await renderSpaceAmbix({ params: mk(10), sampleRate: SR, order: 2 });
  const tl = (ch) => rms(amb.getChannelData(ch), tailFrom, tailFrom + SR / 2);
  a.ok(tl(0) > 1e-6 && tl(1) > 0.3 * tl(0) && tl(3) > 0.3 * tl(0) && tl(4) === 0, 'ambiX: the tail is in W, Y, Z, X and in no higher channel');
}, { group: 'studio' });

registerSelfCheck('space: playback modes — light = first-order reflections + inaudible ones dropped (live only), render key unchanged', (a) => {
  const plain = createSpacePreset('hall');
  a.ok(playbackMode(normalizeSpaceDoc(plain)) === 'light' && !('playback' in normalizeSpaceDoc(plain)), 'default: light, and no key in the document');
  a.equal(spaceRenderKey(normalizeSpaceDoc({ ...plain, playback: 'full' })), spaceRenderKey(normalizeSpaceDoc(plain)), 'the playback mode is not part of the render key (exports and Manager clips are the same)');
  a.equal(prerenderStatus(normalizeSpaceDoc(plain)), 'off', 'no background render unless Pre-render is chosen');
  if (!Offline()) return;
  // Gain nodes that feed the virtual loudspeakers, per mode / 모드별 가상 스피커로 가는 게인 노드 수
  const graph = (doc, live) => {
    const ctx = new (Offline())(2, SR, SR);
    const nodes = [];
    scheduleSpace(ctx, ctx.destination, { params: doc, nowTime: 0, cueSec: 0, nodes, imports: new Map(), liveArray: live });
    return { panners: nodes.filter((x) => x instanceof PannerNode).length, gains: nodes.filter((x) => x instanceof GainNode).length, osc: nodes.filter((x) => x instanceof OscillatorNode).length };
  };
  const hall = normalizeSpaceDoc({ ...plain, room: { ...plain.room, reverb: { on: false } } });
  const K3 = virtualSpeakerCount(3), K1 = 6; // light: six first-order loudspeakers on the axes / 가벼운 재생: 축 위의 1차 스피커 6개
  const full = graph(normalizeSpaceDoc({ ...hall, playback: 'full' }), true);
  const light = graph(hall, true);
  const offline = graph(hall, false);
  a.ok(full.panners === K3 && light.panners === K3 + K1, `light adds ${K1} first-order loudspeakers for the reflections (${light.panners} panners, full ${full.panners})`);
  a.equal(full.osc, 7, 'full: the source and its six reflections');
  a.ok(light.osc <= full.osc && light.osc >= 1, `light: ${light.osc} voices (inaudible reflections dropped)`);
  a.ok(full.gains - light.gains >= (light.osc - 1) * (K3 - K1) - K1, `light saves ${full.gains - light.gains} automated gain nodes`);
  a.ok(offline.panners === K3 && offline.osc === 7, 'an offline render is always full, whatever the playback mode');
  // A reflection far below the source is not played in light mode / 아주 작은 반사는 가벼운 재생에서 생략
  const dead = normalizeSpaceDoc({ ...hall, room: { ...hall.room, absorb: { floor: 0.999999, ceil: 0.999999, xn: 0.999999, xp: 0.999999, yn: 0.999999, yp: 0.25 } } });
  a.equal(graph(dead, true).osc, 2, 'light: five reflections at −60 dB are left out, the audible one stays');
  a.equal(graph(dead, false).osc, 7, '… and they are all in the render');
}, { group: 'studio' });
