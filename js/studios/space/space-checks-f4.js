/**
 * Flexatone — studios/space/space-checks-f4.js
 * Self-checks of the Space follow-up F4: a changing speed of sound c(t), supersonic sources (several
 * arrivals, the sonic boom) and Space in the Manager modulation matrix (signals, document targets).
 * 스페이스 후속 F4 자가진단: 변하는 음속 c(t), 초음속 음원(여러 도착·소닉 붐), 매니저 모듈레이션의 스페이스 신호·문서 대상.
 *
 * Imported by space-panels.js (registration only). The audio check renders offline; no sound is played.
 */

import { registerSelfCheck } from '../../core/state.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams, createSpacePreset, bakeSource, bakeSpace, soundSpeed, effectiveC, superMode, bakeArrivals, boomBake, spaceSignature, getSpaceBakeCount } from './space-engine.js';
import { createLane } from './space-lanes.js';
import { renderSpaceBuffer } from './space-audio.js';
import { spaceSignalLines, applySpaceDocMods, SPACE_DOC_TARGETS } from '../../audio/space-mod.js';
import { MOD_TARGETS, targetsFor, findCrossings } from '../../core/mod-config.js';

const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: 1, ...over, sources });
const pts = (list) => ({ engine: 'custom', reverse: false, inverse: false, customPoints: list.map(([x, y]) => ({ x, y, handles: [] })) });
// An envelope of the c scale through [x, scale] points (the lane's range is 0.05 … 1) / [x, 배율] 점을 지나는 c 배율 엔벨로프
const cLane = (list) => ({ ...createLane('cscale'), on: true, min: 0.05, max: 1, curve: pts(list.map(([x, sc]) => [x, (sc - 0.05) / 0.95])) });
const flyBy = (v, over = {}) => createSource(0, { id: 'f', path: { type: 'line', x0: -600, y0: 40, x1: 600, y1: 40 }, speed: { value: v }, duration: 1200 / v, f: { hz: 300 }, airAbsorb: false, ...over });

registerSelfCheck('space-f4: changing c(t) — constant c unchanged, step against the closed form, Doppler = numeric derivative', (a) => {
  const still = createSource(0, { id: 's', path: { type: 'static', x: 0, y: 300 }, duration: 3, f: { hz: 400 } });
  const plain = docWith([still], { length: 4 });
  a.ok(!('cEnv' in plain) && !('supersonic' in plain) && superMode(plain) === 'clamp' && !soundSpeed(plain).varying, 'defaults: constant c, clamp — and no new keys in the document');
  a.equal(spaceSignature(docWith([still], { length: 4, cEnv: { ...cLane([[0, 1], [1, 0.3]]), on: false } })), spaceSignature(plain), 'an envelope that is off is not part of the signature');
  // A flat envelope = the constant: the general baker agrees with the classic one / 평평한 엔벨로프 = 상수
  const moving = createSource(0, { id: 'm', path: { type: 'line', x0: -90, y0: 12, x1: 90, y1: 12, h: 3 }, speed: { value: 40 }, duration: 4.5, f: { hz: 500 } });
  const classic = bakeSource(moving, docWith([moving], { cScale: 0.6, length: 6 }));
  const general = bakeSource(moving, docWith([moving], { length: 6, cEnv: cLane([[0, 0.6], [1, 0.6]]) }));
  a.ok(general.general && !classic.general && !general.more.length, 'a subsonic source has one arrival');
  a.ok(Math.abs(general.t0 - classic.t0) < 1e-9 && Math.abs(general.t1 - classic.t1) < 1e-9 && general.n === classic.n, 'same listener-time window');
  let wf = 0, wr = 0, wt = 0;
  for (let i = 0; i < classic.n; i++) { wf = Math.max(wf, Math.abs(general.fObs[i] / classic.fObs[i] - 1)); wr = Math.max(wr, Math.abs(general.r[i] - classic.r[i])); wt = Math.max(wt, Math.abs(general.te[i] - classic.te[i])); }
  a.ok(wf < 1e-8 && wr < 1e-7 && wt < 1e-9, `general baker = classic baker at constant c (f ${wf.toExponential(1)}, r ${wr.toExponential(1)} m, τ ${wt.toExponential(1)} s)`);
  a.ok(general.maxResidual < 1e-10, `arrival condition solved to ${general.maxResidual.toExponential(1)} s`);
  // Step: c = 343 until 1 s, then 171.5 (the envelope's ramp is 2 ms wide) / 계단: 1초까지 343, 이후 171.5
  const step = docWith([still], { length: 4, cEnv: cLane([[0, 1], [0.25, 1], [0.2505, 0.5], [1, 0.5]]) });
  const snd = soundSpeed(step);
  a.ok(snd.varying && Math.abs(snd.at(0.5) - 343) < 1e-9 && Math.abs(snd.at(2) - 171.5) < 1e-9 && Math.abs(effectiveC(step) - 171.5) < 1e-9, 'c(t) is read from the envelope; the clamp uses the slowest c');
  a.near(snd.Cinv(snd.C(1.7321)), 1.7321, 1e-10, 'C and its inverse agree');
  const bs = bakeSource(step.sources[0], step);
  // emitted at τ = 0.5: 0.5 s at 343 m/s = 171.5 m, the remaining 128.5 m at 171.5 m/s / τ = 0.5에 방출
  const want = 1 + (300 - 343 * 0.5) / 171.5;
  let k = 0;
  while (k < bs.n - 1 && bs.te[k] < 0.5) k++;
  const f = (0.5 - bs.te[k - 1]) / (bs.te[k] - bs.te[k - 1]);
  a.near(bs.t[k - 1] + f * (bs.t[k] - bs.t[k - 1]), want, 3e-3, 'step in c: arrival time = closed form');
  // Doppler of a resting source while c falls: f_obs / f_s = c(t) / c(τ) = dτ/dt (numeric) / 정지 음원의 도플러
  const ramp = docWith([still], { length: 4, cEnv: cLane([[0, 1], [1, 0.4]]) });
  const br = bakeSource(ramp.sources[0], ramp);
  const sr = soundSpeed(ramp);
  let wd = 0, wa = 0;
  for (let i = 5; i < br.n - 5; i += 7) {
    const numeric = (br.te[i + 1] - br.te[i - 1]) / (br.t[i + 1] - br.t[i - 1]);
    wd = Math.max(wd, Math.abs(br.fObs[i] / br.fs[i] / numeric - 1));
    wa = Math.max(wa, Math.abs(br.fObs[i] / br.fs[i] / (sr.at(br.t[i]) / sr.at(br.te[i])) - 1));
  }
  a.ok(wd < 1e-4, `frequency ratio = numeric dτ/dt (worst ${wd.toExponential(1)})`);
  a.ok(wa < 1e-9 && br.fObs[Math.floor(br.n / 2)] < 400, 'a resting source is heard flat while the medium slows down: f_obs / f_s = c(t) / c(τ)');
});

registerSelfCheck('space-f4: supersonic — clamp by default, 0 → 2 arrivals at the cone, backwards arrival, boom time = closed form', (a) => {
  const c = 343;
  const v = 2 * c; // Mach 2
  const clampDoc = docWith([flyBy(v)], { length: 6 });
  const bc = bakeSpace(clampDoc).sources.get('f');
  a.ok(bc.clamped && !bc.general && bc.maxVc > 1.9, 'default: the speed is clamped below c (as before), one arrival');
  const doc = docWith([flyBy(v)], { length: 6, supersonic: 'multi' });
  const main = bakeSpace(doc).sources.get('f');
  const all = bakeArrivals(main);
  a.equal(all.length, 2, 'Mach 2 straight pass: two arrivals');
  const back = all.find((x) => x.reversed), fwd = all.find((x) => !x.reversed);
  a.ok(back && fwd && fwd.born && back.born, 'one runs forwards, one backwards; both begin at the cone');
  // Closest approach at source time 600 / v; the cone passes d·√(M² − 1) / v later / 원뿔 통과 시각
  const tPass = 600 / v;
  const tBoom = tPass + (40 * Math.sqrt(4 - 1)) / v;
  a.near(fwd.t0, tBoom, 2e-4, 'the first sound arrives when the Mach cone does: t = t_pass + d·√(M² − 1) / v');
  a.near(back.t0, tBoom, 2e-4, '… for the backwards arrival too');
  const count = (t) => all.filter((x) => t >= x.t0 && t <= x.t1).length;
  a.ok(count(tBoom - 0.02) === 0 && count(tBoom + 0.05) === 2, 'arrivals heard: 0 before the cone, 2 after it');
  a.ok(back.te[1] > back.te[back.n - 2] && fwd.te[1] < fwd.te[fwd.n - 2], 'backwards arrival: later listener time = EARLIER emission');
  const i = Math.floor(back.n / 2);
  a.ok(back.x[i] < 0 && fwd.x[Math.floor(fwd.n / 2)] > 0 && back.fObs[i] > 0, 'the backwards arrival is heard where the source came from, at a positive pitch');
  a.ok(all.every((x) => x.maxResidual < 1e-9), 'arrival condition solved on every piece');
  // Mach cone half-angle at the boom: the direction of the heard position / 붐 순간에 들리는 방향
  const rBoom = (2 * 40) / Math.sqrt(3); // d·M / √(M² − 1)
  a.near(fwd.r[0], rBoom, 0.05, 'distance of the heard position at the boom = d·M / √(M² − 1)');
  const bb = boomBake(fwd);
  a.ok(bb && Math.abs(bb.shockAt - fwd.t0) < 1e-12 && bb.t0 < fwd.t0 && Math.abs(bb.t0 + bb.lead - fwd.t0) < 1e-12, 'boom: its shock sits exactly on the cone crossing (after a lead-in)');
  a.ok(boomBake(bc) === null, 'no boom without a cone crossing');
  const n0 = getSpaceBakeCount();
  bakeSpace(doc);
  a.equal(getSpaceBakeCount(), n0, 'the arrivals are cached with the bake');
  a.ok(bakeSpace(docWith([flyBy(100)], { length: 14, supersonic: 'multi' })).sources.get('f').general !== true, 'a subsonic source keeps the classic baker when the clamp is off');
  a.ok(createSpacePreset('passby').supersonic === undefined);
});

registerSelfCheck('space-f4: Manager — Space signals (closest-approach trigger), document targets, boom in the render', async (a) => {
  a.equal(targetsFor('space').filter((x) => x.startsWith('space.')).join(), SPACE_DOC_TARGETS.join(), 'Space document targets are offered to Space tracks');
  a.ok(!targetsFor('cloud').some((x) => x.startsWith('space.')) && SPACE_DOC_TARGETS.every((x) => MOD_TARGETS[x].doc), '… only to them, and all as document targets (pre-render, never live)');
  const src = createSource(0, { id: 'p', name: 'P', path: { type: 'line', x0: -100, y0: 15, x1: 100, y1: 15 }, speed: { value: 25 }, duration: 8, f: { hz: 440 } });
  const doc = docWith([src], { length: 10 });
  const bake = bakeSpace(doc);
  const lines = spaceSignalLines(doc.sources, bake);
  a.equal(lines.map((l) => l.key).join(), 'p:r,p:vr,p:az,p:el,p:shift,p:approach', 'signals of a source: distance, radial speed, azimuth, elevation, Doppler shift, approach');
  const b = bake.sources.get('p');
  let iMin = 0;
  for (let i = 1; i < b.n; i++) if (b.r[i] < b.r[iMin]) iMin = i;
  const cross = findCrossings(lines.find((l) => l.key === 'p:approach').pts);
  a.ok(cross.length === 1 && Math.abs(cross[0] - b.t[iMin]) <= b.dt, `closest-approach trigger at ${cross[0]?.toFixed(4)} s = the heard minimum of the distance (${b.t[iMin].toFixed(4)} s, ± 1 sample)`);
  const rl = lines.find((l) => l.key === 'p:r').pts;
  a.ok(Math.abs(Math.min(...rl.map((q) => q.m)) - b.rMin) < 0.05, 'the distance line reaches the closest approach');
  // Document targets / 문서 대상
  const laneAt = () => 0;
  const out = applySpaceDocMods({ 'space.c': (T) => -0.5 * (T / 10), 'space.yaw': () => 90, 'space.width': () => 0.4 }, doc, 0, 1, laneAt);
  const nd = normalizeSpaceDoc(out);
  const snd = soundSpeed(nd);
  a.ok(nd.cEnv.on && Math.abs(snd.at(0) - 343) < 0.5 && Math.abs(snd.at(10) - 343 * 0.5) < 0.5, 'space.c: the speed of sound follows the signal (1 → 0.5 × c)');
  a.ok(nd.listener.orient.mode === 'lanes' && Math.abs(nd.listener.orient.yaw.min - 90) < 1e-3, 'space.yaw: the listener turns by the amount (angle range not clamped)');
  a.ok(nd.sources[0].lanes.width.on && Math.abs(nd.sources[0].lanes.width.min - 0.4) < 1e-3 && !doc.sources[0].lanes.width.on, 'space.width: written into a copy, the document itself is untouched');
  a.ok(spaceSignature(nd) !== spaceSignature(doc), 'a document target changes the bake of that clip (pre-render)');
  if (!Offline()) return;
  // The boom is in the render at the cone crossing / 렌더에서 붐이 원뿔 통과 시각에 있음
  const SR = 48000;
  const v = 686;
  const quiet = flyBy(v, { baseGain: 0.0001 });
  const d2 = docWith([quiet], { length: 6, supersonic: 'boom' });
  const buf = await renderSpaceBuffer({ params: d2, sampleRate: SR, outputStage: false });
  const x = buf.getChannelData(0), y = buf.getChannelData(1);
  let peak = 0, at = 0;
  for (let i = 0; i < x.length; i++) { const m = Math.abs(x[i]) + Math.abs(y[i]); if (m > peak) { peak = m; at = i; } }
  const tBoom = 600 / v + (40 * Math.sqrt(3)) / v;
  a.ok(Math.abs(at / SR - tBoom) < 2e-3, `the loudest sample is the shock at ${(at / SR).toFixed(4)} s (cone crossing ${tBoom.toFixed(4)} s)`);
  const noBoom = await renderSpaceBuffer({ params: docWith([quiet], { length: 6, supersonic: 'multi' }), sampleRate: SR, outputStage: false });
  let p2 = 0;
  for (let i = 0; i < noBoom.length; i++) p2 = Math.max(p2, Math.abs(noBoom.getChannelData(0)[i]) + Math.abs(noBoom.getChannelData(1)[i]));
  a.ok(peak > 3 * p2, 'without the boom option there is no shock');
}, { group: 'studio' });
