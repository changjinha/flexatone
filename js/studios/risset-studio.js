/**
 * Flexatone — studios/risset-studio.js
 * Layer 2 (studios): Risset Studio plugin — Shepard-Risset sonic field on the circular phase S¹.
 * 계층 2 (studios): 리세 스튜디오 플러그인 — 원형 위상 S¹ 위의 셰퍼드-리세 음장.
 *
 * Registers `RissetStudio`. The document lives in appState.studioParams.risset (saved with the
 * project, undoable). The workspace UI and the live/offline audio live in
 * studios/risset/risset-panels.js + risset-audio.js and are mounted by ui/studio-host.js when the
 * tab is activated; unmounting stops the audio first (no overlap with other studios).
 * 문서는 studioParams.risset에 저장. UI/오디오는 탭 활성화 시 studio-host가 마운트,
 * 언마운트 전 오디오를 먼저 정지.
 * Imports: core/*, modules/*, studios/registry.js, studios/risset/* (pure modules only).
 */

import { deepClone } from '../core/math-utils.js';
import { registerSelfCheck, withIsolatedState, appState } from '../core/state.js';
import { StudioRegistry } from './registry.js';
import {
  createDefaultRissetParams,
  sanitizeRissetParams,
  simulateSegments,
  segmentsToGlissandoVoices,
  trajectoryDisplacement,
  shapedTime,
  SHAPE_KINDS,
  createRissetRuntime,
  stepRuntime,
  computeVoicePhase,
  outputScale,
  createDefaultRegion,
  RISSET_STAGES,
  getDynBakeCount,
  bakeDynamics,
} from './risset/risset-core.js';
import { createDynState, resetDynState, stepDynamics, kineticEnergy, createDefaultDynamics } from './risset/dynamics.js';
import { signalInRange } from './risset/signal-graph.js';
import { pairRoughness, analyzeColor } from './risset/color-analysis.js';
import { ratioToCents } from './risset/harmony-grid.js';
import { RissetVoiceBank } from './risset/risset-voicebank.js';
import { initVoiceParticles, stepLocalParticles, sCurve, fadeDur, inertialMass, MIN_M0 } from './risset/local-particles.js';
import { formatClean, parsePitchSeq, offsetsFromPattern, offsetsToPitchText, parseIntervalSeq, computeOffsets } from './risset/harmony-grid.js';
import { evalGlobalEnvelope, peakingResponseDb } from './risset/peq-envelope.js';
import { computeEffective, createLane, evalLane } from './risset/loop-automation.js';

export const RISSET_ID = 'risset';

/** Risset document = sanitized saved params. / 리세 문서 */
export function getRissetParams() {
  return sanitizeRissetParams(StudioRegistry.has(RISSET_ID) ? StudioRegistry.getParams(RISSET_ID) : createDefaultRissetParams());
}

/**
 * Edit the Risset document (draft copy → sanitize → commit). Offsets are recomputed from the grid
 * mode unless the edit set gridMode 'custom'. / 리세 문서 편집
 */
export function editRisset(fn, { history = true, coalesceKey = null } = {}) {
  const draft = getRissetParams();
  fn(draft);
  return StudioRegistry.setParams(RISSET_ID, sanitizeRissetParams(draft), { history, coalesceKey });
}

export const RissetStudio = {
  id: RISSET_ID,
  name: { en: 'Risset Studio', ko: '리세 스튜디오' },
  description: { en: 'Shepard-Risset sonic field: up to 60 voices on a circular pitch space', ko: '셰퍼드-리세 음장: 원형 음고 공간 위 최대 60보이스' },
  order: 20,
  status: 'ready',
  usesVoiceEditor: false,
  schema: [],
  workspace: 'risset',
  defaultParams: createDefaultRissetParams,
  /** Bake the current configuration into Glissando voices (one voice per wrap segment). */
  generateVoices(params, helpers) {
    const p = sanitizeRissetParams(params);
    return segmentsToGlissandoVoices(p, simulateSegments(p), helpers);
  },
};

StudioRegistry.register(RissetStudio);

// ==========================================================================
// Self-checks / 자가진단
// ==========================================================================

registerSelfCheck('Risset: v = 0 ⇒ y = 0 for every shape; mean speed preserved', (a) => {
  const p = createDefaultRissetParams();
  for (const kind of SHAPE_KINDS) {
    const q = { ...p, shapeKind: kind };
    for (const tau of [0, 0.7, 3.3, 9.1]) a.equal(trajectoryDisplacement(q, tau, 0), 0, `${kind} v=0 τ=${tau}`);
    a.near(shapedTime(q, 0), 0, 1e-12, `${kind} F(0)=0`);
    a.near(shapedTime(q, 2 * q.shapePeriodSec), 2 * q.shapePeriodSec, 1e-9, `${kind} F(kP)=kP`);
  }
  const lin = { ...p, rateHz: 0.1 };
  a.near(trajectoryDisplacement(lin, 5), 0.5, 1e-12, 'linear y = v·τ');
  // Frozen runtime never moves / v=0이면 위상 정지
  const rt = createRissetRuntime({ ...p, rateHz: 0 });
  for (let k = 0; k < 50; k++) stepRuntime({ ...p, rateHz: 0 }, rt, 0.02, { running: true });
  a.equal(rt.masterPhase, 0, 'frozen phase');
}, { group: 'studio' });

registerSelfCheck('Risset: harmony grid parsing, PEQ, envelope, automation, gain', (a) => {
  a.equal(formatClean(12), '12');
  a.equal(formatClean(12.5), '12.5');
  a.equal(formatClean(3.14159), '3.14');
  const ps = parsePitchSeq('c1, g1, f#2, bb2', 24, 4);
  a.equal(ps.normalizedText, 'C1, G1, F#2, Bb2', 'upper-cased tokens');
  a.equal(ps.offsets.join(), [0, 7, 18, 22].join(), 'pitch → offsets');
  a.equal(offsetsToPitchText([0, 12.5], 24), 'C1, C2+50¢', 'abs pitch with cents');
  a.equal(parseIntervalSeq('0, 7', 4).join(), '0,7,0,7', 'interval cycling');
  a.equal(offsetsFromPattern('2, 3', true, 24, 4).join(), '0,2,5,7', 'interval pattern');
  const p = createDefaultRissetParams();
  a.equal(p.offsets.join(), computeOffsets(p).join(), 'equal grid');
  a.equal(p.localMode, 'bypass', 'Local Emergence bypassed by default');
  a.equal(p.envShape, 'bellpass', 'Bell-Pass default');
  const env = { enabled: true, shape: 'bellpass', center: 0.5, width: 1 };
  a.near(evalGlobalEnvelope(env, 0.5), 1, 1e-12, 'bell peak');
  a.ok(evalGlobalEnvelope({ ...env, width: 0.1 }, 0.9) < 0.01, 'narrow bell');
  a.near(peakingResponseDb({ freq: 1000, gain: 6, q: 1 }, 1000), 6, 0.05, 'peaking gain at f0');
  a.near(peakingResponseDb({ freq: 1000, gain: 6, q: 1 }, 20), 0, 0.2, 'peaking flat far away');
  const lane = createLane(0.75, true);
  a.near(evalLane(lane, 0.5), 0.75, 1e-9, 'lane value');
  const eff = computeEffective({ ...p, autoLanes: { rateHz: lane } }, 0.5 * p.autoLoopSec);
  a.near(eff.rateHz, p.rateHz + 0.25 * 2 * 0.5, 1e-9, 'automation bipolar depth');
  a.near(outputScale({ ...p, voiceCount: 16, masterGain: 1 }), 0.65 / 4, 1e-12, '1/√N');
}, { group: 'studio' });

registerSelfCheck('Risset: bake to Glissando voices', (a) => {
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 4, rateHz: 0.2, bakeSec: 4 });
  const segs = simulateSegments(p); // same sampling as generateVoices / generateVoices와 동일 샘플링
  a.ok(segs.length >= 4, `segments ${segs.length}`);
  a.ok(segs.every((s) => s.midi.every((m, k) => k === 0 || Math.abs(m - s.midi[k - 1]) < p.spanSemitones * 0.5)), 'no wrap jump inside a segment');
  withIsolatedState(() => {
    const voices = StudioRegistry.generateVoices(RISSET_ID, p);
    a.ok(voices.length === segs.length && voices.every((v) => v.engine === 'custom'), 'custom voices');
    a.ok(appState.voices.length >= 1, 'generateVoices leaves state untouched');
  });
  const frozen = simulateSegments({ ...p, rateHz: 0, bakeSec: 1 }, { rate: 20 });
  a.equal(frozen.length, 4, 'v = 0 → one steady segment per voice');
  a.ok(frozen.every((s) => s.midi.every((m) => Math.abs(m - s.midi[0]) < 1e-9)), 'v = 0 → constant pitch');
  a.equal(computeVoicePhase(p, 0, 1), deepClone(p).offsets[1] / p.spanSemitones, 'voice phase');
}, { group: 'studio' });

registerSelfCheck('Risset: region modules & space rotation', (a) => {
  const base = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 6, rateHz: 0.05, envWidth: 1 });
  const run = (q, steps = 30) => { const rt = createRissetRuntime(q, () => 0.5); for (let k = 0; k < steps; k++) stepRuntime(q, rt, 0.02, { running: true, rng: () => 0.5 }); return rt; };
  const classic = run(base);
  a.ok(classic.classic && classic.slots.length === 6, 'default = classic field (slot i = voice i)');
  // Rotation on at θ = 0 sounds the same pitches as the classic field / θ = 0이면 원래 음장과 동일
  const rot0 = run({ ...base, regions: [createDefaultRegion({ id: 'a', rotOn: true, rotAngleDeg: 0 })] });
  a.ok(!rot0.classic, 'rotation path active');
  const pitches = (rt) => rt.slots.filter((s) => s.active && s.s > 0.01 && s.s < 0.99).map((s) => s.s).sort((x, y) => x - y);
  const pc = pitches(classic);
  const pr = pitches(rot0);
  a.equal(pr.length, pc.length, 'θ=0 point count');
  pr.forEach((x, k) => a.near(x, pc[k], 1e-6, `θ=0 pitch ${k}`));
  // θ = 180° mirrors pitches about the pivot / 180°는 중심 기준 거울상
  const rot180 = run({ ...base, regions: [createDefaultRegion({ id: 'b', rotOn: true, rotAngleDeg: 180, rotCenterAuto: false, rotCenter: 0.5 })] });
  const pm = pitches(rot180).map((x) => 1 - x).sort((x, y) => x - y);
  a.equal(pm.length, pc.length, '180° point count');
  pm.forEach((x, k) => a.near(x, pc[k], 2e-3, `180° mirrored ${k}`));
  // Range limits: nothing sounds outside [lo, hi] / 범위 밖은 무음
  const band = run({ ...base, regions: [createDefaultRegion({ id: 'c', lo: 0.4, hi: 0.6 }), createDefaultRegion({ id: 'd', lo: 0, hi: 0.2, linkRate: false, rateHz: -0.2, rotOn: true, rotSpinDegPerSec: 45 })] });
  a.ok(band.slots.filter((s) => s.active).every((s) => (s.region === 0 ? s.s >= 0.4 - 1e-9 && s.s <= 0.6 + 1e-9 : s.s >= 0 && s.s <= 0.2 + 1e-9)), 'points stay inside their module range');
  a.ok(band.regionStates.d.phase !== band.masterPhase, 'unlinked module moves independently');
  a.ok(band.regionStates.d.angleDeg > 20, 'spin advances θ');
  const segs = simulateSegments({ ...base, bakeSec: 2, regions: [createDefaultRegion({ id: 'e', rotOn: true, rotAngleDeg: 60 })] }, { rate: 50 });
  a.ok(segs.length > 0, `rotated bake segments ${segs.length}`);
}, { group: 'studio' });

registerSelfCheck('Risset A-1: signal graph stages and ranges', (a) => {
  a.equal(RISSET_STAGES.map((st) => st.id).join(' → '), 'phaseCore → grid → envelope → local → dynamics → output → analysis', 'stage order');
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 24, rateHz: 0.3, localMode: 'random' });
  const rt = createRissetRuntime(p, () => 0.37);
  for (let k = 0; k < 120; k++) {
    stepRuntime(p, rt, 1 / 60, { running: true, rng: () => 0.37 });
    if (!signalInRange(rt.sig)) { a.ok(false, `signal out of range at step ${k}`); return; }
  }
  a.equal(rt.sig.N, 24, 'N');
  a.ok(rt.slots.every((sl, i) => Math.abs(sl.s - rt.sig.phase[i]) < 1e-12 && Math.abs(sl.vel - rt.sig.vel[i]) < 1e-12), 'classic slots = signal');
  a.ok(rt.phases === rt.sig.phase, 'rt.phases aliases sig.phase');
}, { group: 'studio' });

registerSelfCheck('Risset A-2: roughness peak, ratio → cents, envelope compatibility', (a) => {
  // Plomp–Levelt (Sethares): two equal sines at 440 Hz — maximum near a minor 2nd (≈ 0.25 CB).
  let best = 0;
  let bestSt = 0;
  for (let st = 0.05; st <= 6; st += 0.05) {
    const r = pairRoughness(440, 1, 440 * 2 ** (st / 12), 1);
    if (r > best) { best = r; bestSt = st; }
  }
  a.ok(bestSt >= 0.6 && bestSt <= 1.6, `R max at ${bestSt.toFixed(2)} st (minor 2nd ≈ 1)`);
  a.ok(pairRoughness(440, 1, 880, 1) < best * 0.01, 'octave nearly smooth');
  const m = analyzeColor(Float64Array.of(440, 880), Float64Array.of(1, 1), 2);
  a.near(m.Chz, Math.sqrt(440 * 880), 1e-6, 'C_spec = weighted log mean');
  a.near(ratioToCents(3, 2), 701.955, 0.001, '3:2 = 701.955¢');
  a.near(ratioToCents(9, 8), 203.91, 0.001, '9:8 = 203.910¢');
  const g = sanitizeRissetParams({ ...createDefaultRissetParams(), gridMode: 'ratio', ratioText: '3:2', voiceCount: 3 });
  a.near(g.offsets[1], 7.0196, 1e-4, 'ratio grid step');
  a.near(g.offsets[2], 14.0391, 1e-4, 'ratio grid stacks');
  // Skew 0 / γ = 4 (defaults) reproduce the previous envelope formulas exactly.
  for (const p of [0, 0.13, 0.37, 0.5, 0.71, 0.99]) {
    const d = (p - 0.5) / 0.24;
    a.near(RissetVoiceBank.envelope({ enabled: true, shape: 'bellpass', center: 0.5, width: 0.24 }, p), 1 / (1 + d ** 4), 1e-12, `bell ${p}`);
    a.near(RissetVoiceBank.envelope({ enabled: true, shape: 'bellpass', center: 0.5, width: 0.24, skew: 0, gamma: 4 }, p), 1 / (1 + d ** 4), 1e-12, `bell defaults ${p}`);
    a.near(RissetVoiceBank.envelope({ enabled: true, shape: 'gaussian', center: 0.5, width: 0.24, skew: 0 }, p), Math.exp(-0.5 * d * d), 1e-12, `gauss ${p}`);
  }
  a.ok(RissetVoiceBank.envelope({ enabled: true, shape: 'bellpass', center: 0.5, width: 0.24, skew: 0.5 }, 0.8) > RissetVoiceBank.envelope({ enabled: true, shape: 'bellpass', center: 0.5, width: 0.24, skew: 0.5 }, 0.2), 'skew > 0 widens the right side');
}, { group: 'studio' });

registerSelfCheck('Risset A-2: colour controller (controller → base, automation → ±)', (a) => {
  const base = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 12, rateHz: 0.05, envWidth: 0.5 });
  const rng = () => 0.5;
  const rt0 = createRissetRuntime(base, rng);
  for (let k = 0; k < 30; k++) stepRuntime(base, rt0, 1 / 60, { running: true, rng });
  const c0 = rt0.color.last.Chz;
  const target = c0 * 2;
  const p = sanitizeRissetParams({ ...base, colorCtl: { enabled: true, target: 'cspec', setpointHz: target, actuator: 'spectralTilt', kp: 0.8, ki: 0.6 } });
  const rt = createRissetRuntime(p, rng);
  for (let k = 0; k < 60 * 8; k++) stepRuntime(p, rt, 1 / 60, { running: true, rng });
  const e0 = Math.abs(Math.log2(target / c0));
  const e1 = Math.abs(Math.log2(target / rt.color.last.Chz));
  a.ok(e1 < e0 * 0.35, `C_spec error ${e0.toFixed(2)} → ${e1.toFixed(3)} oct`);
  a.ok(rt.eff.spectralTilt > 0, 'tilt raised');
  // Automation rides on top of the controller's base value / 오토메이션은 제어기 기준값 위에 ±
  const lane = { enabled: true, points: [{ x: 0, y: 0.75, handles: [] }, { x: 1, y: 0.75, handles: [] }] };
  const eff = computeEffective({ ...p, autoLanes: { spectralTilt: lane } }, 0, { key: 'spectralTilt', value: 2 });
  a.near(eff.spectralTilt, 2 + 0.25 * 24 * 0.5, 1e-9, 'eff = controller base + automation deviation');
}, { group: 'studio' });

/** Seeded RNG for reproducible checks (mulberry32). / 재현 가능한 난수 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The pre-A-4 particle step (verbatim logic) — reference for "defaults unchanged". */
function legacyStep(particles, local, eff, phases, dt, rng) {
  const bMin = Math.min(local.bandMin, local.bandMax);
  const bMax = Math.max(local.bandMin, local.bandMax);
  const fd = () => Math.max(0.12, (local.fadeMeanMs + (rng() * 2 - 1) * local.fadeDevMs) / 1000);
  for (let i = 0; i < particles.length; i++) {
    const vp = particles[i];
    if (local.localMode === 'bypass') { vp.aLocal = 1; continue; }
    const p = phases[i] ?? 0;
    const inBand = p >= bMin - 1e-5 && p <= bMax + 1e-5;
    let aRaw;
    if (local.localMode === 'random') {
      vp.noisePhase += eff.localRateHz * dt;
      if (vp.noisePhase >= 1) { vp.noisePhase -= Math.floor(vp.noisePhase); vp.noiseCur = vp.noiseTarget; vp.noiseTarget = rng() * 2 - 1; }
      const mu = 0.5 - 0.5 * Math.cos(Math.PI * vp.noisePhase);
      const rVal = vp.noiseCur + (vp.noiseTarget - vp.noiseCur) * mu;
      const g = rVal > eff.localThreshold ? 1 : 0;
      if (g !== vp.gate) { vp.gate = g; vp.fadeDurSec = fd(); }
      const stepAmt = dt / Math.max(0.05, vp.fadeDurSec);
      vp.rampLinear = vp.gate > 0.5 ? Math.min(1, vp.rampLinear + stepAmt) : Math.max(0, vp.rampLinear - stepAmt);
      aRaw = 0.5 - 0.5 * Math.cos(Math.PI * vp.rampLinear);
    } else {
      vp.lfoPhase = (vp.lfoPhase + eff.localRateHz * vp.lfoFreqMult * dt) % 1;
      const sVal = 0.5 + 0.5 * Math.sin(2 * Math.PI * vp.lfoPhase);
      const floor = Math.min(0.85, Math.max(0, (eff.localThreshold + 0.8) / 1.65));
      aRaw = Math.min(1, Math.max(0, (sVal - floor) / Math.max(0.15, 1 - floor)));
    }
    vp.aLocal = inBand ? aRaw : 1;
  }
}

registerSelfCheck('Risset A-4: particles 2.0 defaults = previous emergence; S-curve; fade spread', (a) => {
  for (const mode of ['random', 'sine']) {
    const p = sanitizeRissetParams({ ...createDefaultRissetParams(), localMode: mode, voiceCount: 12, bandMin: 0.2, bandMax: 0.8 });
    const eff = { localRateHz: 1.3, localThreshold: 0.1 };
    const A = initVoiceParticles(null, 12, p, seeded(7));
    const B = initVoiceParticles(null, 12, p, seeded(7));
    const rA = seeded(99);
    const rB = seeded(99);
    const ph = Float64Array.from({ length: 12 }, (_, i) => i / 12);
    let maxD = 0;
    for (let k = 0; k < 400; k++) {
      stepLocalParticles(A, p, eff, ph, 1 / 60, rA);
      legacyStep(B, p, eff, ph, 1 / 60, rB);
      for (let i = 0; i < 12; i++) maxD = Math.max(maxD, Math.abs(A[i].aLocal - B[i].aLocal));
    }
    a.ok(maxD < 1e-12, `${mode}: max |new − old| = ${maxD}`);
  }
  for (const x of [0, 0.2, 0.5, 0.9, 1]) a.near(sCurve(x, 0), 0.5 - 0.5 * Math.cos(Math.PI * x), 1e-15, `κ=0 at ${x}`);
  for (const k of [-0.9, 0.5, 0.9]) {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) { const y = sCurve(Math.min(1, x), k); a.ok(y >= prev - 1e-12, `monotone κ=${k}`); prev = y; }
    a.near(sCurve(0, k), 0, 1e-12, `S(0) κ=${k}`);
    a.near(sCurve(1, k), 1, 1e-12, `S(1) κ=${k}`);
  }
  const rng = seeded(3);
  let sum = 0;
  let neg = 0;
  for (let k = 0; k < 4000; k++) { const d = fadeDur({ fadeMeanMs: 1500, fadeDevMs: 500, fadeDist: 'lognormal' }, rng); sum += d; if (d <= 0) neg++; }
  a.near(sum / 4000, 1.5, 0.08, 'log-normal mean ≈ 1.5 s');
  a.equal(neg, 0, 'log-normal positive');
}, { group: 'studio' });

registerSelfCheck('Risset A-4: m₀ > 0 — mass never diverges; buoyancy is a lift ∝ |envelope slope|', (a) => {
  for (const m0 of [0, -1, NaN, 1e-9, 0.05]) {
    for (const M of [0, NaN, -3, 1, Infinity]) {
      const m = inertialMass(m0, M);
      a.ok(Number.isFinite(m) && m >= MIN_M0, `m(${m0}, ${M}) = ${m}`);
      a.ok(Number.isFinite(1e6 / m), 'F/m finite');
    }
  }
  a.ok(sanitizeRissetParams({ ...createDefaultRissetParams(), massM0: 0 }).massM0 >= MIN_M0, 'm₀ = 0 is clamped');
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 8, buoyancy: 1, rateHz: 0 });
  const rt = createRissetRuntime(p, () => 0.5);
  stepRuntime(p, rt, 1 / 60, { running: true, rng: () => 0.5 });
  for (let i = 0; i < 8; i++) {
    const ph = rt.sig.phase[i];
    if (Math.abs(ph - 0.5) < 0.02) continue;
    a.ok(rt.sig.buoy[i] >= 0, `B is an upward lift (p=${ph.toFixed(2)})`);
    a.near(rt.sig.mass[i], rt.sig.ampGlobal[i] * rt.sig.aLocal[i], 1e-12, 'M = A_g·A_l');
  }
}, { group: 'studio' });

registerSelfCheck('Risset A-5: v = 0 + zero coupling ⇒ phases invariant (every order)', (a) => {
  for (const order of ['static', 'first', 'second', 'delay']) {
    const p = sanitizeRissetParams({ ...createDefaultRissetParams(), rateHz: 0, voiceCount: 10, dyn: { ...createDefaultDynamics(), order } });
    const rt = createRissetRuntime(p, () => 0.5);
    stepRuntime(p, rt, 0, { running: true, rng: () => 0.5 });
    const p0 = Array.from(rt.sig.phase.slice(0, 10));
    for (let k = 0; k < 240; k++) stepRuntime(p, rt, 1 / 60, { running: true, rng: () => 0.5 });
    let maxD = 0;
    for (let i = 0; i < 10; i++) maxD = Math.max(maxD, Math.abs(rt.sig.phase[i] - p0[i]));
    a.ok(maxD < 1e-12, `${order}: max |Δp| = ${maxD}`);
  }
}, { group: 'studio' });

registerSelfCheck('Risset A-5: viscosity ⇒ kinetic energy decays monotonically', (a) => {
  for (const viscMode of ['laminar', 'turbulent']) {
    const d = { ...createDefaultDynamics(), order: 'second', viscosity: 2, viscMode, view: 0.2, dragUp: 0, dragDown: 0 };
    const st = createDynState(16);
    const N = 8;
    resetDynState(st, Float64Array.from({ length: N }, (_, i) => i / N * 0.4), N);
    const u0 = [0.4, -0.3, 0.2, 0.5, -0.6, 0.1, -0.2, 0.3];
    for (let i = 0; i < N; i++) st.u[i] = u0[i];
    const env = { mass: new Float64Array(N), buoy: null, grid: st.grid, cbw: null };
    let prev = kineticEnergy(st, 0.05, env.mass);
    const e0 = prev;
    let ok = true;
    for (let k = 0; k < 300; k++) {
      stepDynamics(d, st, env, 0.05, 0.01);
      const e = kineticEnergy(st, 0.05, env.mass);
      if (e > prev + 1e-12) { ok = false; break; }
      prev = e;
    }
    a.ok(ok, `${viscMode}: E non-increasing`);
    a.ok(prev < e0, `${viscMode}: E ${e0.toFixed(4)} → ${prev.toFixed(4)}`);
  }
}, { group: 'studio' });

registerSelfCheck('Risset A-5: 0 bakes during playback; deterministic cached bake; Kuramoto spacing', (a) => {
  const p = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 6, rateHz: 0.05, dyn: { ...createDefaultDynamics(), order: 'first', K: 2, noise: 0.05, repulsion: 0.3 } });
  const c0 = getDynBakeCount();
  const rt = createRissetRuntime(p, () => 0.5);
  for (let k = 0; k < 120; k++) stepRuntime(p, rt, 1 / 60, { running: true, rng: () => 0.5 });
  a.equal(getDynBakeCount(), c0, 'live playback never bakes');
  const b1 = bakeDynamics(p, 2);
  const c1 = getDynBakeCount(); // c0 or c0 + 1 (an earlier run may have cached it) / 이전 실행 캐시 가능
  a.ok(c1 - c0 <= 1, 'at most one bake for the first request');
  const b2 = bakeDynamics(p, 1.5);
  a.equal(getDynBakeCount(), c1, 'second request reuses the cache');
  a.ok(b1 === b2, 'same cached array');
  const fresh = bakeDynamics({ ...p, dyn: { ...p.dyn, seed: p.dyn.seed } , exportSec: 99 }, 2);
  a.ok(fresh === b1, 'export settings are not part of the signature');
  a.ok(sanitizeRissetParams(createDefaultRissetParams()).regions[0].id === 'r0', 'deterministic default ids');
  // Kuramoto pulls a perturbed configuration back to the grid spacing / 격자 간격으로 복귀
  const q = sanitizeRissetParams({ ...createDefaultRissetParams(), voiceCount: 6, rateHz: 0, dyn: { ...createDefaultDynamics(), order: 'first', K: 3 } });
  const r2 = createRissetRuntime(q, () => 0.5);
  stepRuntime(q, r2, 0, { running: true, rng: () => 0.5 });
  const grid = Array.from(r2.dyn.grid.slice(0, 6));
  for (let i = 0; i < 6; i++) r2.dyn.x[i] += 0.04 * Math.sin(i * 1.7);
  for (let k = 0; k < 60 * 8; k++) stepRuntime(q, r2, 1 / 60, { running: true, rng: () => 0.5 });
  let err = 0;
  for (let i = 1; i < 6; i++) {
    const d = (r2.dyn.x[i] - r2.dyn.x[0]) - (grid[i] - grid[0]);
    err = Math.max(err, Math.abs(d - Math.round(d)));
  }
  a.ok(err < 2e-3, `spacing error ${err.toExponential(2)}`);
}, { group: 'studio' });
