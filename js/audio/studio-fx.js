/**
 * Flexatone — audio/studio-fx.js
 * Layer 3 (audio): the two sound features every studio shares, in one place.
 * 계층 3 (audio): 모든 스튜디오가 공유하는 두 가지 소리 기능.
 *
 *   createTimbreWave(ctx, spec)            PeriodicWave of a timbre spec (5-wave Mix or ƒ(x)), cached
 *   connectStudioOutput(ctx, node, dest, tremolo)
 *                                          node → [studio output tremolo] → dest (live and offline)
 * The tremolo is the LFO backend (audio/tremolo-node.js), the same one Risset uses: it needs no
 * timeline, so it fits every engine (scheduled curves, grains, AudioWorklet banks).
 * 트레몰로는 리세와 같은 LFO 백엔드 — 시간축이 필요 없어 어떤 엔진에도 붙일 수 있음.
 */

import { appState } from '../core/state.js';
import { isTremoloOn, normalizeTremolo } from '../core/tremolo-config.js';
import { timbreSpecCoefficients, STUDIO_TIMBRE_HARMONICS } from '../modules/timbre-spec.js';
import { toPeriodicWaveArgs } from '../modules/timbre-synth.js';
import { createTremoloEvaluator } from '../modules/tremolo.js';
import { createTremoloNode } from './tremolo-node.js';

const waveCache = new WeakMap(); // ctx → WeakMap(coeffs.real → PeriodicWave)

/**
 * PeriodicWave for a studio timbre spec, cached per context. A 'voice' ƒ(x) source reads the
 * Glissando voices. / 스튜디오 음색 스펙의 PeriodicWave (컨텍스트별 캐시)
 * @param {BaseAudioContext} ctx
 * @param {object} spec timbre spec (modules/timbre-spec.js)
 */
export function createTimbreWave(ctx, spec, { harmonics = STUDIO_TIMBRE_HARMONICS, voices = appState.voices } = {}) {
  const coeffs = timbreSpecCoefficients(spec, { voices, harmonics });
  let perCtx = waveCache.get(ctx);
  if (!perCtx) { perCtx = new WeakMap(); waveCache.set(ctx, perCtx); }
  let wave = perCtx.get(coeffs.real);
  if (!wave) {
    wave = ctx.createPeriodicWave(...toPeriodicWaveArgs(coeffs));
    perCtx.set(coeffs.real, wave);
  }
  return wave;
}

/**
 * Connect a studio's master node to `dest` through its output tremolo.
 * 스튜디오의 마스터 노드를 출력 트레몰로를 거쳐 dest에 연결.
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} node the studio's last node (after its transport fade)
 * @param {AudioNode} dest getOutputBus(ctx) / createOfflineOutput(ctx) / ctx.destination
 * @param {object} [tremolo] tremolo config (core/tremolo-config.js); off / missing = plain connection
 * @returns {{ update: (cfg: object) => void, dispose: () => void }} `update` follows live edits
 */
export function connectStudioOutput(ctx, node, dest, tremolo = null) {
  let trem = null;
  const wire = (cfg) => {
    trem = createTremoloNode(ctx, normalizeTremolo(cfg));
    try { node.disconnect(dest); } catch { /* was not connected directly */ }
    node.connect(trem.node);
    trem.node.connect(dest);
  };
  if (isTremoloOn(tremolo)) wire(tremolo);
  else node.connect(dest);
  return {
    /** Cheap when nothing changed; inserts the stage the first time the tremolo is switched on. */
    update(cfg) {
      if (trem) trem.update(normalizeTremolo(cfg));
      else if (isTremoloOn(cfg)) wire(cfg);
    },
    dispose() {
      if (trem) { trem.dispose(); trem = null; }
    },
  };
}

// --------------------------------------------------------------------------
// Live output stage per studio / 스튜디오별 실시간 출력 단
// One persistent tremolo stage per studio sits in front of the output bus. Passes come and go
// (play, loop, live re-schedule); the stage stays, so a studio only swaps its connect target and
// tremolo edits are heard while playing without any per-studio plumbing.
// 스튜디오마다 출력 버스 앞에 트레몰로 단을 하나 유지 — 재생 패스가 바뀌어도 단은 그대로이므로
// 스튜디오는 연결 대상만 바꾸면 되고, 재생 중 트레몰로 편집이 바로 들립니다.
// --------------------------------------------------------------------------

const liveStages = new Map(); // studio id → { ctx, trem, get }
let liveTicker = null;

function tickLiveStages() {
  if (!appState.transport?.playing) return; // idle: nothing to follow / 정지 중에는 할 일 없음
  for (const st of liveStages.values()) {
    try { st.trem.update(normalizeTremolo(st.get())); } catch { /* document being swapped */ }
  }
}

/**
 * The node a studio's live pass connects to instead of the output bus.
 * 스튜디오의 실시간 패스가 출력 버스 대신 연결할 노드.
 * @param {AudioContext} ctx
 * @param {string} id studio id
 * @param {() => object} getTremolo current tremolo config of the studio's document
 * @param {AudioNode} bus getOutputBus(ctx)
 */
export function studioLiveOutput(ctx, id, getTremolo, bus) {
  let st = liveStages.get(id);
  if (!st || st.ctx !== ctx) {
    if (st) st.trem.dispose();
    const trem = createTremoloNode(ctx, normalizeTremolo(getTremolo()));
    trem.node.connect(bus);
    st = { ctx, trem, get: getTremolo };
    liveStages.set(id, st);
  }
  st.get = getTremolo;
  st.trem.update(normalizeTremolo(getTremolo()));
  if (!liveTicker && typeof setInterval === 'function') liveTicker = setInterval(tickLiveStages, 100);
  return st.trem.node;
}

/**
 * Multiply rendered sample arrays by a tremolo (for engines that render in JS, not in a graph).
 * JS로 렌더하는 엔진용: 샘플 배열에 트레몰로를 곱함.
 */
export function applyTremoloToSamples(channels, sampleRate, tremolo) {
  const ev = createTremoloEvaluator(normalizeTremolo(tremolo), { startTime: 0, duration: Math.max(1e-3, (channels[0]?.length || 0) / sampleRate) });
  if (!ev) return;
  const n = channels[0].length;
  for (let i = 0; i < n; i++) {
    const g = ev.gainAtSec(i / sampleRate);
    for (const ch of channels) ch[i] *= g;
  }
}

