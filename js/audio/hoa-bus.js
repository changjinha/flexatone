/**
 * Flexatone — audio/hoa-bus.js
 * Layer 3 (audio, shared): higher-order Ambisonics in Web Audio graphs.
 *   - Binaural monitoring: mono source → K gains (the HOA panning function of the decoder, as
 *     automation curves) → K virtual loudspeakers = fixed HRTF PannerNodes → stereo.
 *     The number of HRTF nodes is K (16 / 24 / 32 / 50 for orders 1 … 4), whatever the number of sources.
 *   - ambiX bus: mono source → (order + 1)² gains (SN3D coefficients as curves) → ChannelMerger.
 * 계층 3 (audio, 공용): Web Audio 그래프의 고차 앰비소닉스 — 바이노럴 모니터링(가상 스피커 = 고정 HRTF
 * PannerNode)과 ambiX 버스(SN3D 계수 곡선 → ChannelMerger).
 *
 * Why the speaker gains are computed per source instead of mixing an HOA bus through a K × N gain
 * matrix: encode → decode is linear, so the gain of speaker k is D[k] · Y(direction) either way; doing
 * the product when the curves are made needs K gain nodes per source and no matrix of nodes.
 * 인코딩 → 디코딩은 선형이므로 스피커 k의 게인은 D[k] · Y(방향). 곡선을 만들 때 곱해 두면 노드 격자가 필요 없음.
 *
 * Directions are given in the listener's frame as three baked arrays: fwd (front), lat (to the RIGHT),
 * up — the Space bake's `fwd`, `pan`, `up`. ambiX y points LEFT, so y = −lat.
 * 방향은 청취자 좌표계의 세 배열 (fwd = 앞, lat = 오른쪽, up). ambiX의 y는 왼쪽이므로 y = −lat.
 *
 * Imports: modules/ambisonics.js. Browser audio APIs only (no DOM).
 */

import { createDecoder, hoaChannels, shCoeffs, widthWeights, acnOrder, HOA_MAX_ORDER, HOA_WEIGHTINGS } from '../modules/ambisonics.js';

const decoders = new Map(); // `${order}|${weighting}` → decoder (pure, shared) / 순수 디코더 캐시

/** Decoder of an order / weighting (memoised). / 디코더 (메모) */
export function getDecoder(order = 3, weighting = 'maxre') {
  const N = Math.max(1, Math.min(HOA_MAX_ORDER, Math.floor(Number(order) || 3)));
  const w = HOA_WEIGHTINGS.includes(weighting) ? weighting : 'maxre';
  const key = `${N}|${w}`;
  if (!decoders.has(key)) decoders.set(key, createDecoder(N, { weighting: w }));
  return decoders.get(key);
}

const compact = new Map();
/**
 * The smallest regular first-order decoder: six virtual loudspeakers on the axes (an octahedron).
 * Used for what does not need more — the room's reflections in the light playback mode.
 * 가장 작은 정규 1차 디코더: 축 위의 가상 스피커 6개 (정팔면체). 가벼운 재생 모드의 반사용.
 */
export function getCompactDecoder(weighting = 'maxre') {
  const w = HOA_WEIGHTINGS.includes(weighting) ? weighting : 'maxre';
  if (!compact.has(w)) compact.set(w, createDecoder(1, { weighting: w, speakers: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] }));
  return compact.get(w);
}

/** Can this context render the binaural decoder (HRTF PannerNode)? / 바이노럴 디코더 사용 가능 여부 */
export const binauralSupported = (ctx) => !!ctx && typeof ctx.createPanner === 'function';

/**
 * Create the virtual loudspeakers of a decoder and connect them to `dest`.
 * @returns {{ dec, inputs: GainNode[], nodes: AudioNode[] }} inputs[k] = the feed of speaker k
 * 가상 스피커 생성 (inputs[k] = 스피커 k의 입력).
 */
export function createBinauralSpeakers(ctx, dest, { order = 3, weighting = 'maxre', dec: given = null, hrir = null } = {}) {
  const dec = given || getDecoder(order, weighting); // `given`: a loudspeaker array heard over headphones / 헤드폰으로 듣는 스피커 배열
  const inputs = [];
  const nodes = [];
  for (const d of dec.speakers) {
    const feed = ctx.createGain();
    // User HRIR set: one stereo convolver per virtual loudspeaker (the nearest measured direction)
    // 사용자 HRIR: 가상 스피커마다 스테레오 컨볼버 하나 (가장 가까운 측정 방향)
    const ir = hrir ? hrir.bufferFor(ctx, d) : null;
    if (ir) {
      const cv = ctx.createConvolver();
      cv.normalize = false;
      cv.buffer = ir;
      feed.connect(cv).connect(dest);
      inputs.push(feed);
      nodes.push(feed, cv);
      continue;
    }
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'linear';
    p.rolloffFactor = 0; // level is in the gains / 레벨은 게인이 담당
    p.refDistance = 1;
    p.maxDistance = 10000;
    // Web Audio listener: x = right, y = up, −z = front; ambiX: x = front, y = left, z = up
    p.positionX.value = -d[1];
    p.positionY.value = d[2];
    p.positionZ.value = -d[0];
    feed.connect(p).connect(dest);
    inputs.push(feed);
    nodes.push(feed, p);
  }
  return { dec, inputs, nodes };
}

/**
 * Gain curves of every virtual speaker for a moving source.
 * @param {object} dec       decoder (getDecoder)
 * @param {Float32Array} fwd, lat, up   direction in the listener frame, m samples each
 * @param {Float32Array|null} width      source width 0…1 per sample (null = a point)
 * @returns {Float32Array[]} K curves of m samples
 * 움직이는 음원의 가상 스피커별 게인 곡선.
 */
export function speakerCurves(dec, fwd, lat, up, width = null) {
  const m = fwd.length;
  const K = dec.speakers.length;
  const nCh = hoaChannels(dec.order);
  const out = Array.from({ length: K }, () => new Float32Array(m));
  const b = new Float64Array(nCh);
  const ww = new Float64Array(dec.order + 1);
  const norm = !!dec.energyNorm; // array decoders: constant Σg² per direction (modules/speaker-arrays.js) / 방향마다 Σg² 일정
  for (let i = 0; i < m; i++) {
    shCoeffs(dec.order, fwd[i], -lat[i], up[i], b);
    if (width && width[i] > 0) { widthWeights(dec.order, width[i], ww); for (let n = 1; n < nCh; n++) b[n] *= ww[acnOrder(n)]; }
    let e = 0;
    for (let k = 0; k < K; k++) {
      const row = dec.matrix[k];
      let g = 0;
      for (let n = 0; n < nCh; n++) g += row[n] * b[n];
      out[k][i] = g;
      if (norm) e += g * g;
    }
    if (norm && e > 1e-18) { const sc = 1 / Math.sqrt(e); for (let k = 0; k < K; k++) out[k][i] *= sc; }
  }
  return out;
}

/**
 * Loudspeaker-array bus: one input per loudspeaker → trim → delay compensation → its output channel.
 * @param {object} dec    array decoder (modules/speaker-arrays.js createArrayDecoder)
 * @param {object} opt    { route: [output channel of speaker k], trimDb: [dB], delays: [samples], channels }
 * @returns {{ dec, inputs: GainNode[], nodes: AudioNode[], merger: ChannelMergerNode, channels: number }}
 * 스피커 배열 버스: 스피커마다 입력 하나 → 트림 → 지연 보정 → 출력 채널.
 */
export function createArrayBus(ctx, dec, { route = null, trimDb = null, delays = null, channels = null } = {}) {
  const K = dec.speakers.length;
  const chan = dec.chan.map((c, k) => (Number.isInteger(route?.[k]) && route[k] >= 0 ? route[k] : c));
  const n = Math.max(channels || 0, dec.channels, ...chan.map((c) => c + 1));
  const merger = ctx.createChannelMerger(n);
  const inputs = [];
  const nodes = [merger];
  for (let k = 0; k < K; k++) {
    const feed = ctx.createGain();
    feed.gain.value = Math.pow(10, (Number(trimDb?.[k]) || 0) / 20);
    let tail = feed;
    const d = Math.max(0, Math.round(Number(delays?.[k]) || 0)) / ctx.sampleRate;
    if (d > 0) {
      const dl = ctx.createDelay(Math.max(0.05, d + 0.01));
      dl.delayTime.value = d;
      feed.connect(dl);
      nodes.push(dl);
      tail = dl;
    }
    tail.connect(merger, 0, chan[k]);
    inputs.push(feed);
    nodes.push(feed);
  }
  return { dec, inputs, nodes, merger, channels: n, chan };
}

/** SN3D coefficient curves (ACN order) of a moving source: (order + 1)² curves. / ambiX 계수 곡선 */
export function ambixCurves(order, fwd, lat, up, width = null) {
  const m = fwd.length;
  const nCh = hoaChannels(order);
  const out = Array.from({ length: nCh }, () => new Float32Array(m));
  const b = new Float64Array(nCh);
  const ww = new Float64Array(order + 1);
  for (let i = 0; i < m; i++) {
    shCoeffs(order, fwd[i], -lat[i], up[i], b);
    if (width && width[i] > 0) { widthWeights(order, width[i], ww); for (let n = 1; n < nCh; n++) b[n] *= ww[acnOrder(n)]; }
    for (let n = 0; n < nCh; n++) out[n][i] = b[n];
  }
  return out;
}

/**
 * Connect a mono node to a set of inputs through one automated gain each.
 * `inputs[k]` is an AudioNode, or [node, inputIndex] for a ChannelMerger.
 * 모노 노드를 입력마다 자동화된 게인 하나를 거쳐 연결.
 */
export function connectThroughCurves(ctx, node, inputs, curves, t0, dur, nodes = null) {
  for (let k = 0; k < inputs.length; k++) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(curves[k][0], 0);
    g.gain.setValueCurveAtTime(curves[k], t0, dur);
    node.connect(g);
    if (Array.isArray(inputs[k])) g.connect(inputs[k][0], 0, inputs[k][1]);
    else g.connect(inputs[k]);
    if (nodes) nodes.push(g);
  }
}

/** A ChannelMerger used as an ambiX bus: inputs [[merger, n], …]. / ambiX 버스용 병합기 */
export function createAmbixBus(ctx, order) {
  const nCh = hoaChannels(order);
  const merger = ctx.createChannelMerger(nCh);
  return { merger, inputs: Array.from({ length: nCh }, (_, n) => [merger, n]) };
}
