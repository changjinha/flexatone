/**
 * Flexatone — studios/space/space-checks-b.js
 * Space extension B self-checks (audio tier: they render offline): ambiX channel content, binaural
 * left / right and timing, the float WAV container, imported sounds (Doppler by playback rate,
 * live-link bookkeeping, cycles, freeze) and the Manager clip key.
 * 스페이스 확장 B 자가진단 (오디오 계층: 오프라인 렌더): ambiX 채널 내용, 바이노럴 좌우·시간차, float WAV
 * 컨테이너, 가져온 소리(재생 배속 도플러, 라이브 링크, 순환, 고정), 매니저 클립 키.
 *
 * Imported by space-panels.js (registration only). No sound is played.
 */

import { registerSelfCheck } from '../../core/state.js';
import { _forgetSample, getSample } from '../../core/sample-library.js';
import { StudioRegistry } from '../registry.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams, bakeSource, sampleBake, getSpaceBakeCount } from './space-engine.js';
import { createLane } from './space-lanes.js';
import { renderSpaceBuffer, renderSpaceAmbix, scheduleSpace, importState, spaceRenderKey, freezeImportSound, selfSpaceTarget } from './space-audio.js';
import { encodeWavFloat, readWavHeader, WAVE_FORMAT_EXTENSIBLE, bufferPeak } from '../../audio/wav-multichannel.js';
import { hoaChannels, virtualSpeakerCount, shCoeffs } from '../../modules/ambisonics.js';
import { getInstanceRenderer, setInstanceRenderer, requestInstanceBuffer, awaitInstanceBuffer, getInstanceRenderCount, clearInstanceBuffers } from '../../audio/instance-source.js';

const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const SR = 48000;
const rms = (x, i0 = 0, i1 = x.length) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: 5, ...over, sources });
const still = (id, x, y, h = 0, over = {}) => createSource(0, { id, path: { type: 'static', x, y, h }, duration: 0.5, f: { hz: 400 }, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, airAbsorb: false, ...over });

/** Frequency of a tone in [i0, i1) from interpolated zero crossings. / 영점 교차로 구한 주파수 */
function zeroCrossHz(x, sr, i0, i1) {
  let first = NaN, last = NaN, count = 0;
  for (let i = Math.max(1, i0); i < i1; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = (i - 1 + x[i - 1] / (x[i - 1] - x[i])) / sr;
      if (!count) first = t;
      last = t;
      count++;
    }
  }
  return count > 1 ? (count - 1) / (last - first) : NaN;
}

/** Lag (samples, positive = b later than a) of the largest cross-correlation within ±max. / 최대 상호상관 지연 */
function xcorrLag(a, b, i0, i1, max) {
  let best = 0, bestV = -Infinity;
  for (let lag = -max; lag <= max; lag++) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += a[i] * (b[i + lag] || 0);
    if (s > bestV) { bestV = s; best = lag; }
  }
  return best;
}

registerSelfCheck('space-b: ambiX render — channel content = SN3D coefficients; float WAV container', async (a) => {
  if (!Offline()) return;
  // Left of a listener facing +y: x = −10 → ambiX y = 1 / 왼쪽 음원
  const left = docWith([still('L', -10, 0)]);
  const b1 = await renderSpaceAmbix({ params: left, sampleRate: SR, order: 1 });
  a.equal(b1.numberOfChannels, 4, 'order 1 → 4 channels');
  const i0 = Math.floor(0.15 * SR), i1 = Math.floor(0.4 * SR);
  const r = [0, 1, 2, 3].map((c) => rms(b1.getChannelData(c), i0, i1));
  a.ok(r[0] > 1e-3, `W carries the signal (${r[0].toExponential(2)})`);
  a.ok(Math.abs(r[1] / r[0] - 1) < 0.01 && r[2] / r[0] < 1e-3 && r[3] / r[0] < 1e-3, `left → [W, Y, Z, X] = [1, 1, 0, 0] (${r.map((v) => (v / r[0]).toFixed(3)).join(', ')})`);
  // A general direction at order 3: |channel| / |W| = |Y_n| / 일반 방향 3차
  const src = still('G', 6, 8, 5);
  const gen = docWith([src]);
  const b3 = await renderSpaceAmbix({ params: gen, sampleRate: SR, order: 3 });
  a.equal(b3.numberOfChannels, 16, 'order 3 → 16 channels');
  const bake = bakeSource(gen.sources[0], gen);
  const y = shCoeffs(3, bake.fwd[0], -bake.pan[0], bake.up[0]);
  const j0 = Math.floor((bake.t0 + 0.1) * SR), j1 = Math.floor((bake.t0 + 0.35) * SR);
  const w = rms(b3.getChannelData(0), j0, j1);
  let worst = 0;
  for (let n = 1; n < 16; n++) worst = Math.max(worst, Math.abs(rms(b3.getChannelData(n), j0, j1) / w - Math.abs(y[n])));
  a.ok(worst < 0.01, `16 channel levels follow the SN3D coefficients (worst ${worst.toExponential(1)})`);
  // Container / 컨테이너
  const wav = encodeWavFloat(b3);
  const h = readWavHeader(wav);
  a.ok(h.format === WAVE_FORMAT_EXTENSIBLE && h.subFormat === 3 && h.channelMask === 0, 'WAVE_FORMAT_EXTENSIBLE, IEEE float sub-format, channel mask 0');
  a.ok(h.channels === 16 && h.bits === 32 && h.sampleRate === SR && h.frames === b3.length, `16 ch · 32-bit · ${h.frames} frames`);
  const dv = new DataView(wav);
  const k = Math.floor(0.3 * SR);
  a.near(dv.getFloat32(h.dataOffset + (k * 16 + 5) * 4, true), b3.getChannelData(5)[k], 1e-9, 'samples are stored as they are (no fader, no clipping)');
  a.ok(bufferPeak(b3) > 0, 'peak is measured');
}, { group: 'studio' });

registerSelfCheck('space-b: Binaural (HOA) — left / right level and arrival order, front symmetric, width, node count', async (a) => {
  if (!Offline()) return;
  const render = async (x, y, over = {}) => renderSpaceBuffer({ params: docWith([still('s', x, y, 0, over.src || {})], { panMode: 'binaural', ...(over.doc || {}) }), sampleRate: SR, outputStage: false });
  const win = [Math.floor(0.2 * SR), Math.floor(0.45 * SR)];
  const L = await render(-10, 0);
  const lL = rms(L.getChannelData(0), ...win), lR = rms(L.getChannelData(1), ...win);
  a.ok(lL > 1.25 * lR, `left source: left ear louder (${(20 * Math.log10(lL / lR)).toFixed(1)} dB)`);
  const lagL = xcorrLag(L.getChannelData(0), L.getChannelData(1), ...win, 60);
  a.ok(lagL > 0, `left source: the right ear hears it later (+${lagL} samples)`);
  const R = await render(10, 0);
  const rL = rms(R.getChannelData(0), ...win), rR = rms(R.getChannelData(1), ...win);
  a.ok(rR > 1.25 * rL && xcorrLag(R.getChannelData(0), R.getChannelData(1), ...win, 60) < 0, `right source: mirrored (${(20 * Math.log10(rR / rL)).toFixed(1)} dB)`);
  const F = await render(0, 10);
  const fL = rms(F.getChannelData(0), ...win), fR = rms(F.getChannelData(1), ...win);
  a.ok(Math.abs(20 * Math.log10(fL / fR)) < 1.5, `front source: both ears alike (${(20 * Math.log10(fL / fR)).toFixed(2)} dB)`);
  // Width: a wide source at the left is less lateral / 폭이 넓으면 덜 치우침
  const wide = await render(-10, 0, { src: { lanes: { width: createLane('width', { on: true, domain: 'time', curve: { engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 1, handles: [] }] } }) } } });
  const wL = rms(wide.getChannelData(0), ...win), wR = rms(wide.getChannelData(1), ...win);
  a.ok(wL / wR < lL / lR, `width 1 narrows the level difference (${(20 * Math.log10(wL / wR)).toFixed(1)} dB < ${(20 * Math.log10(lL / lR)).toFixed(1)} dB)`);
  // Node count: K speakers (feed + panner) once, K gains per source / 노드 수
  const count = (doc) => { const nodes = []; const ctx = new (Offline())(2, 4800, SR); scheduleSpace(ctx, ctx.destination, { params: doc, nowTime: 0, cueSec: 0, nodes, imports: new Map() }); return nodes.length; };
  for (const order of [1, 3]) {
    const K = virtualSpeakerCount(order);
    const two = docWith([still('a', -5, 3), still('b', 5, 3)], { panMode: 'binaural', spatial: { order, weighting: 'maxre' } });
    a.equal(count(two), 2 * K + 2 * (3 + K), `order ${order}: ${K} virtual speakers for any number of sources`);
  }
  a.equal(count(docWith([still('a', -5, 3), still('b', 5, 3)])), 8, 'stereo mode: the graph is as before (4 nodes per source)');
  a.equal(hoaChannels(3), 16, 'order 3 = 16 channels');
}, { group: 'studio' });

registerSelfCheck('space-b: imported sound — Doppler by playback rate, live link (re-render only when the original changes), cycles, freeze, clip key', async (a) => {
  if (!Offline()) return;
  const real = getInstanceRenderer();
  let version = 1;
  let hz = 440;
  const mock = {
    list: () => [{ target: 'mock', name: 'Mock', studio: 'glissando', color: '#fff' }],
    describe: (target) => (target === 'mock' ? { ok: true, key: `v${version}`, name: 'Mock', studio: 'glissando', color: '#fff', length: 8 } : { ok: false, reason: 'missing' }),
    render: async (target, content, sampleRate) => {
      const buf = new AudioBuffer({ length: 8 * sampleRate, numberOfChannels: 2, sampleRate });
      for (let c = 0; c < 2; c++) { const x = buf.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / sampleRate); }
      return buf;
    },
  };
  setInstanceRenderer(mock);
  clearInstanceBuffers();
  try {
    const imp = (over = {}) => createSource(0, { id: 'imp', path: { type: 'line', x0: -90, y0: 6, x1: 90, y1: 6 }, speed: { value: 30 }, duration: 6, airAbsorb: false, input: { kind: 'import', target: 'mock' }, ...over });
    const doc = docWith([imp()], { cScale: 0.5, refDist: 6 });
    const buf = await renderSpaceBuffer({ params: doc, sampleRate: SR, outputStage: false });
    a.ok(buf && rms(buf.getChannelData(0)) > 1e-4, 'an imported sound is rendered through the spatial chain');
    const b = bakeSource(doc.sources[0], doc);
    const mono = new Float32Array(buf.length);
    for (let i = 0; i < mono.length; i++) mono[i] = buf.getChannelData(0)[i] + buf.getChannelData(1)[i];
    let worst = 0;
    const tPass = b.t0 + 0.5 * (b.t1 - b.t0);
    for (const t of [b.t0 + 0.4, b.t0 + 1.2, tPass - 1.0, tPass + 1.0, b.t1 - 1.2, b.t1 - 0.4]) {
      const want = 440 * (sampleBake(b, 'fObs', t) / sampleBake(b, 'fs', t));
      const got = zeroCrossHz(mono, SR, Math.floor((t - 0.1) * SR), Math.floor((t + 0.1) * SR));
      worst = Math.max(worst, Math.abs(got / want - 1));
    }
    a.ok(worst < 0.01, `heard pitch = 440 · f_obs / f_s (worst ${(worst * 100).toFixed(3)} %)`);
    const approach = zeroCrossHz(mono, SR, Math.floor((b.t0 + 0.3) * SR), Math.floor((b.t0 + 0.6) * SR));
    const recede = zeroCrossHz(mono, SR, Math.floor((b.t1 - 0.6) * SR), Math.floor((b.t1 - 0.3) * SR));
    a.ok(approach > 440 * 1.1 && recede < 440 * 0.92, `Doppler on the imported tone: ${approach.toFixed(1)} Hz → ${recede.toFixed(1)} Hz`);
    const flat = await renderSpaceBuffer({ params: docWith([imp({ doppler: false })], { cScale: 0.5, refDist: 6 }), sampleRate: SR, outputStage: false });
    const fm = new Float32Array(flat.length);
    for (let i = 0; i < fm.length; i++) fm[i] = flat.getChannelData(0)[i] + flat.getChannelData(1)[i];
    a.near(zeroCrossHz(fm, SR, Math.floor((b.t0 + 0.3) * SR), Math.floor((b.t0 + 0.8) * SR)), 440, 1, 'Doppler off → the pitch of the original');
    // Live link bookkeeping / 라이브 링크
    const r0 = getInstanceRenderCount();
    const bakes0 = getSpaceBakeCount();
    await renderSpaceBuffer({ params: docWith([imp({ path: { type: 'line', x0: -90, y0: 9, x1: 90, y1: 9 } })], { cScale: 0.5 }), sampleRate: SR, outputStage: false });
    a.equal(getInstanceRenderCount() - r0, 0, 'moving the path does not render the sound again');
    a.ok(getSpaceBakeCount() - bakes0 >= 1, 'but it re-bakes the motion');
    const key0 = spaceRenderKey(doc);
    const viewOnly = normalizeSpaceDoc({ ...JSON.parse(JSON.stringify(doc)), view: { cx: 9, cy: 9, span: 44 } });
    a.equal(spaceRenderKey(viewOnly), key0, 'view edits do not change the clip key');
    version = 2;
    hz = 660;
    a.ok(spaceRenderKey(doc) !== key0, 'editing the original changes the clip key of the Space document');
    const st = await awaitInstanceBuffer({ target: 'mock', sampleRate: SR });
    a.equal(getInstanceRenderCount() - r0, 1, 'editing the original renders once');
    a.near(zeroCrossHz(st.buffer.getChannelData(0), SR, 4800, 24000), 660, 0.5, 'the new sound is the edited one');
    a.equal(requestInstanceBuffer({ target: 'mock', sampleRate: SR }).status, 'ready', 'same key → cached');
    a.equal(getInstanceRenderCount() - r0, 1, 'no further render for the same key');
    // Missing / cycle / 없음·순환
    a.equal(requestInstanceBuffer({ target: 'nobody', sampleRate: SR }).status, 'missing', 'unknown target → missing');
    a.equal(requestInstanceBuffer({ target: 'mock', sampleRate: SR, chain: ['x', 'mock'] }).status, 'cycle', 'a target already in the chain → cycle');
    a.equal(importState(createSource(0, { input: { kind: 'import', target: selfSpaceTarget() } }), SR).status, 'cycle', 'the editor document cannot import itself');
    const none = await renderSpaceBuffer({ params: docWith([imp({ input: { kind: 'import', target: 'nobody' } })], { cScale: 0.5 }), sampleRate: 16000, outputStage: false });
    a.ok(none && rms(none.getChannelData(0)) < 1e-9, 'a missing import is silent, not an error');
    // Glissando voices skip imports / 보이스 베이킹에서 제외
    const mixed = docWith([imp(), createSource(1, { id: 'syn', duration: 2 })], { cScale: 0.5 });
    a.equal(StudioRegistry.generateVoices('space', mixed).length, 1, 'Bake to Glissando skips imported sources');
    // Freeze: a mono copy in the sample library plays without the original / 고정
    const frozen = await freezeImportSound(doc.sources[0]);
    a.ok(frozen?.entry?.id && getSample(frozen.entry.id), 'freeze stores a sample');
    a.near(frozen.entry.length / frozen.entry.sampleRate, 8, 1e-3, 'the copy has the length of the sound');
    const fsrc = imp({ input: { kind: 'import', target: 'gone', frozen: frozen.entry.id } });
    a.equal(importState(fsrc, SR).status, 'frozen', 'a frozen source does not need its original');
    const fbuf = await renderSpaceBuffer({ params: docWith([fsrc], { cScale: 0.5, refDist: 6 }), sampleRate: SR, outputStage: false });
    a.ok(rms(fbuf.getChannelData(0)) > 1e-4, 'the frozen copy sounds');
    _forgetSample(frozen.entry.id);
  } finally {
    setInstanceRenderer(real);
    clearInstanceBuffers();
  }
}, { group: 'studio' });
