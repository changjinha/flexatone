/**
 * Flexatone — studios/space/space-checks-f2.js
 * Self-checks of the Space follow-up F2: loudspeaker-array output (feeds, channel order, routing,
 * trims, delay compensation, the multichannel WAV) and user HRIR sets (convolver decoder).
 * The pure decoder checks live in modules/speaker-arrays.js.
 * 스페이스 후속 F2 자가진단: 스피커 배열 출력(피드·채널 순서·라우팅·트림·지연 보정·다채널 WAV)과 사용자 HRIR.
 *
 * Imported by space-panels.js (registration only). Renders offline; no sound is played.
 */

import { registerSelfCheck } from '../../core/state.js';
import { createSource, normalizeSpaceDoc, createDefaultSpaceParams, normalizeSpatial, arraySettings } from './space-engine.js';
import { renderSpaceArray, renderSpaceBuffer, arraySetup, arrayLiveSupport, hoaMonitorOptions, exportSpaceArray, scheduleSpace } from './space-audio.js';
import { readWavHeader, WAVE_FORMAT_EXTENSIBLE } from '../../audio/wav-multichannel.js';
import { addHrirSet, removeHrirSet, parseHrirName, nearestHrir, getHrirSet, hrirFor } from '../../audio/hrir-store.js';
import { virtualSpeakerCount } from '../../modules/ambisonics.js';

const Offline = () => globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
const SR = 48000;
const rms = (x, i0 = 0, i1 = x.length) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); };
const docWith = (sources, over = {}) => normalizeSpaceDoc({ ...createDefaultSpaceParams(), cScale: 1, refDist: 5, ...over, sources });
// A resting tone at azimuth `az` (right-positive) and distance 10 m; the listener faces +y / 방위 az의 정지음
const tone = (az, over = {}) => createSource(0, { id: 't', path: { type: 'static', x: 10 * Math.sin((az * Math.PI) / 180), y: 10 * Math.cos((az * Math.PI) / 180) }, duration: 0.5, f: { hz: 500 }, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, airAbsorb: false, ...over });
const firstSound = (x, thr) => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr) return i; return -1; };

registerSelfCheck('space-f2: array settings — old documents unchanged, 2-channel device handling, delay samples', (a) => {
  a.equal(JSON.stringify(normalizeSpatial({ order: 2, weighting: 'basic' })), '{"order":2,"weighting":"basic"}', 'a document without an array keeps exactly { order, weighting }');
  a.equal(JSON.stringify(normalizeSpaceDoc(createDefaultSpaceParams()).spatial), '{"order":3,"weighting":"maxre"}', 'default document: no array, no HRIR key');
  const s = arraySettings({ spatial: { order: 3 } });
  a.ok(s.layout === 'quad' && s.method === 'modematch' && s.energyNorm === false, 'defaults: quad, mode matching, no energy normalisation');
  a.ok(!arrayLiveSupport(2, 4).ok && !arrayLiveSupport(2, 2).ok && !arrayLiveSupport(6, 8).ok && arrayLiveSupport(8, 6).ok, 'live array output: off on a 2-channel device or with too few channels');
  const d = docWith([tone(0)], { panMode: 'array', spatial: { order: 3, array: { layout: '5.1', dist: [2, 2, 3, 2, 2.5] } } });
  const set = arraySetup(d, SR);
  a.ok(set.channels === 6 && set.dec.order === 2 && set.dec.limited, '5.1: six channels, order limited to 2');
  a.equal(set.delays.join(), [1, 1, 0, 1, 0.5].map((m) => Math.round((m / 343) * SR)).join(), 'delay compensation = (farthest − distance) / 343 · rate samples');
  a.ok(hoaMonitorOptions(d).dec === arraySetup(d).dec && !hoaMonitorOptions(d).hrir, 'array mode on two channels: the monitor uses the array\'s own loudspeakers');
  a.ok(hoaMonitorOptions(docWith([tone(0)], { panMode: 'binaural' })).dec === undefined, 'binaural mode: the virtual loudspeakers of the order');
});

registerSelfCheck('space-f2: array render — channel order, LFE silent, routing, trim, delay, WAV header', async (a) => {
  if (!Offline()) return;
  const i0 = Math.floor(0.15 * SR), i1 = Math.floor(0.4 * SR);
  const levels = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => rms(buf.getChannelData(c), i0, i1));
  // Octagon, source on loudspeaker 3 (azimuth 90° = right) / 8각 링, 음원이 3번 스피커 방향
  const oct = docWith([tone(90)], { panMode: 'array', spatial: { order: 3, weighting: 'maxre', array: { layout: 'octagon' } } });
  const b1 = await renderSpaceArray({ params: oct, sampleRate: SR });
  a.equal(b1.numberOfChannels, 8, 'octagon → 8 channels');
  const l1 = levels(b1);
  const top = l1.indexOf(Math.max(...l1));
  a.equal(top, 2, `a source at 90° right is loudest on channel 3 (levels ${l1.map((v) => v.toFixed(3)).join(' ')})`);
  a.ok(Math.abs(l1[1] - l1[3]) < 1e-3 * l1[2] && l1[6] < 0.2 * l1[2], 'its neighbours are equal, the opposite loudspeaker is far down');
  // 5.1: the LFE channel is silent, front centre source is loudest on C / 5.1: LFE 무음
  const d51 = docWith([tone(110)], { panMode: 'array', spatial: { order: 3, array: { layout: '5.1', method: 'allrad' } } });
  const b2 = await renderSpaceArray({ params: d51, sampleRate: SR });
  const l2 = levels(b2);
  a.ok(b2.numberOfChannels === 6 && l2[3] === 0, '5.1 → 6 channels, channel 4 (LFE) is silent');
  a.equal(l2.indexOf(Math.max(...l2)), 5, 'a source at 110° right is loudest on Rs (channel 6)');
  const l2f = levels(await renderSpaceArray({ params: docWith([tone(0)], { panMode: 'array', spatial: { order: 3, array: { layout: '5.1', method: 'allrad' } } }), sampleRate: SR }));
  a.ok(Math.abs(l2f[0] - l2f[1]) < 1e-3 * l2f[0] && l2f[2] > 1.5 * l2f[4] && l2f[0] > 1.5 * l2f[4], 'a source straight ahead: L = R, the front three above the surrounds');
  // Routing and trim / 라우팅·트림
  const routed = docWith([tone(90)], { panMode: 'array', spatial: { order: 3, array: { layout: 'octagon', route: [null, null, 9, null], trimDb: [0, 0, -6] } } });
  const b3 = await renderSpaceArray({ params: routed, sampleRate: SR });
  const l3 = levels(b3);
  a.ok(b3.numberOfChannels === 10 && l3[2] === 0, 'routing loudspeaker 3 to output 10 widens the file and empties channel 3');
  a.near(l3[9] / l1[2], Math.pow(10, -6 / 20), 1e-3, 'trim −6 dB on that loudspeaker');
  // Delay compensation: the nearer loudspeaker is later by the computed samples / 지연 보정
  const near = docWith([tone(67.5)], { panMode: 'array', spatial: { order: 3, array: { layout: 'octagon', dist: [3, 3, 2, 3, 3, 3, 3, 3] } } });
  const b4 = await renderSpaceArray({ params: near, sampleRate: SR });
  const b5 = await renderSpaceArray({ params: docWith([tone(67.5)], { panMode: 'array', spatial: { order: 3, array: { layout: 'octagon' } } }), sampleRate: SR });
  const want = Math.round((1 / 343) * SR);
  const lag = firstSound(b4.getChannelData(2), 1e-5) - firstSound(b5.getChannelData(2), 1e-5);
  a.ok(Math.abs(lag - want) <= 1, `loudspeaker 3 at 2 m (others 3 m) is delayed by ${lag} samples (${want} expected)`);
  a.equal(firstSound(b4.getChannelData(1), 1e-5), firstSound(b5.getChannelData(1), 1e-5), 'the farthest loudspeakers are not delayed');
  // The stereo render of an array document = its headphone monitor (2 channels, both sound) / 스테레오 렌더 = 헤드폰 모니터
  const mon = await renderSpaceBuffer({ params: oct, sampleRate: SR, outputStage: false });
  a.ok(mon.numberOfChannels === 2 && rms(mon.getChannelData(1), i0, i1) > 1.5 * rms(mon.getChannelData(0), i0, i1), 'monitor: a source on the right is louder in the right ear');
  // WAV container / WAV 컨테이너
  const out = await exportSpaceArray({ download: false });
  if (out.ok) {
    const h = readWavHeader(out.wav);
    a.ok(h.format === WAVE_FORMAT_EXTENSIBLE && h.bits === 32 && h.channels === out.channels && out.meta.channelOrder.startsWith('1 '), `multichannel WAV: extensible float, ${h.channels} channels, channel order in the sidecar`);
    a.equal(out.meta.speakers.length, out.meta.channels >= out.meta.speakers.length ? out.meta.speakers.length : -1, 'sidecar lists every channel');
  }
}, { group: 'studio' });

registerSelfCheck('space-f2: user HRIR — file names, nearest direction, convolver decoder, node count, fallback', async (a) => {
  const p1 = parseHrirName('azi_45,0_ele_-15,0.wav');
  a.ok(p1 && p1.az === -45 && p1.el === -15, 'SADIE name: azimuth counter-clockwise → 45° left');
  const p2 = parseHrirName('H-10e045a.wav');
  a.ok(p2 && p2.az === 45 && p2.el === -10, 'KEMAR name: elevation first, azimuth clockwise');
  a.ok(parseHrirName('az90_el0.wav').az === -90 && parseHrirName('az90_el0.wav', { ccw: false }).az === 90 && parseHrirName('az270_el10.wav', { ccw: false }).az === -90, 'generic name: the direction of counting is an option; 270° wraps to −90°');
  a.ok(parseHrirName('readme.wav') === null, 'a name without a direction is refused');
  // A synthetic set: every direction = an impulse, louder in the ear on its side / 합성 세트: 방향 쪽 귀가 더 큰 임펄스
  const items = [];
  for (let az = -180; az < 180; az += 30) for (const el of [-30, 0, 30]) {
    const L = new Float32Array(64), R = new Float32Array(64);
    const side = Math.sin((az * Math.PI) / 180); // +1 = right
    L[4] = 0.5 * (1 - 0.8 * side);
    R[4] = 0.5 * (1 + 0.8 * side);
    items.push({ az, el, L, R });
  }
  const made = addHrirSet('check', items, SR, { cache: false });
  try {
    a.ok(made && made.count === 36 && addHrirSet('check again', items, SR, { cache: false }).id === made.id, 'a set gets an id from its content (same files = same id)');
    const set = getHrirSet(made.id);
    const n = nearestHrir(set, [0, -1, 0]); // right
    a.ok(n.angle < 1e-6 && set.R[n.index][4] > set.L[n.index][4], 'nearest direction to "right" is the measured 90°, louder in the right ear');
    if (!Offline()) return;
    const mk = (hrir, mode = 'binaural') => docWith([createSource(0, { id: 'r', path: { type: 'static', x: 10, y: 0 }, duration: 0.5, f: { hz: 500 }, timbre: { sine: 1, tri: 0, saw: 0, sqr: 0, rich: 0 }, airAbsorb: false })], { panMode: mode, spatial: { order: 2, ...(hrir ? { hrir } : {}) } });
    const count = (doc) => {
      const ctx = new (Offline())(2, SR, SR);
      const nodes = [];
      scheduleSpace(ctx, ctx.destination, { params: doc, nowTime: 0, cueSec: 0, nodes, imports: new Map() });
      return { conv: nodes.filter((x) => x instanceof ConvolverNode).length, pan: nodes.filter((x) => x instanceof PannerNode).length };
    };
    const K = virtualSpeakerCount(2);
    const c0 = count(mk(null));
    const c1 = count(mk(made.id));
    a.ok(c0.pan === K && c0.conv === 0, `browser HRTF: ${K} panner nodes, no convolver`);
    a.ok(c1.conv === K && c1.pan === 0, `user HRIR: ${K} convolvers instead of the panners`);
    const cm = count(mk('hrir_not_here'));
    a.ok(cm.pan === K && cm.conv === 0 && hrirFor('hrir_not_here') === null, 'a set that is not on this computer falls back to the browser HRTF');
    const buf = await renderSpaceBuffer({ params: mk(made.id), sampleRate: SR, outputStage: false });
    const i0 = Math.floor(0.15 * SR), i1 = Math.floor(0.4 * SR);
    const l = rms(buf.getChannelData(0), i0, i1), r = rms(buf.getChannelData(1), i0, i1);
    a.ok(r > 1.5 * l && l > 0, `user HRIR render: a source on the right is louder right (${(20 * Math.log10(r / l)).toFixed(1)} dB)`);
    const ca = count(mk(made.id, 'array'));
    a.equal(ca.conv, 4, 'array monitor with a user HRIR: one convolver per loudspeaker of the array (quad)');
  } finally {
    removeHrirSet(made.id);
  }
}, { group: 'studio' });
