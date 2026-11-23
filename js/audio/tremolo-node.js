/**
 * Flexatone — audio/tremolo-node.js
 * Layer 3 (audio): the LFO backend of the shared tremolo — a Web Audio gain stage whose gain is
 * driven by a free-running oscillator. Used where there is no fixed timeline to sample a curve over
 * (Risset's continuous engine, live and offline); timeline studios use the curve backend
 * (modules/tremolo.js `createTremoloEvaluator`).
 * 계층 3 (audio): 공용 트레몰로의 LFO 백엔드. 곡선을 샘플링할 고정 시간축이 없는 엔진(리세의 연속 엔진)용 —
 * 실시간·오프라인 모두 같은 그래프를 씁니다. 시간축이 있는 스튜디오는 곡선 백엔드를 씁니다.
 *
 *   input ─▶ GainNode (gain = offset  +  LFO · depthGain) ─▶ output        (the node is both)
 *   OscillatorNode(PeriodicWave = one LFO cycle's Fourier series) ─▶ depthGain ─▶ node.gain
 */

import { registerSelfCheck } from '../core/state.js';
import { tremoloLfoSpec, createTremoloEvaluator } from '../modules/tremolo.js';

/**
 * @param {BaseAudioContext} ctx
 * @param {object} cfg tremolo config (may be missing / unnormalized: then the stage is transparent)
 * @returns {{ node: GainNode, update: (cfg: object, opts?: { immediate?: boolean }) => void, dispose: () => void }}
 */
export function createTremoloNode(ctx, cfg) {
  const node = ctx.createGain();
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.connect(depth);
  depth.connect(node.gain);
  let lastKey = null;
  let lastWave = '';
  let started = false;

  /** Apply a config. Cheap when nothing changed (called every animation frame). / 변경 없으면 비용 거의 없음 */
  function update(next, { immediate = false } = {}) {
    const key = JSON.stringify(next ?? null);
    if (key === lastKey) return;
    lastKey = key;
    const spec = tremoloLfoSpec(next);
    if (spec.waveKey !== lastWave && spec.on) {
      lfo.setPeriodicWave(ctx.createPeriodicWave(spec.real, spec.imag, { disableNormalization: true }));
      lastWave = spec.waveKey;
    }
    const now = ctx.currentTime;
    const set = (param, v) => { if (immediate) param.setValueAtTime(v, now); else param.setTargetAtTime(v, now, 0.02); };
    set(lfo.frequency, spec.frequency);
    set(depth.gain, spec.depthGain);
    set(node.gain, spec.offset);
    if (!started && spec.on) { started = true; lfo.start(now); }
  }

  update(cfg, { immediate: true });
  return {
    node,
    update,
    dispose() {
      try { if (started) lfo.stop(); } catch { /* already stopped */ }
      for (const n of [lfo, depth, node]) { try { n.disconnect(); } catch { /* ignore */ } }
    },
  };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Tremolo LFO node (offline render) matches the curve backend', async (a) => {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) return;
  const sr = 8000;
  const cfg = { on: true, shape: 'sine', rate: 5, rateEnd: 5, depth: 0.6, phase: 0.25 };
  const ctx = new Offline(1, sr * 2, sr);
  const src = ctx.createConstantSource();
  const trem = createTremoloNode(ctx, cfg);
  src.connect(trem.node);
  trem.node.connect(ctx.destination);
  src.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  const ev = createTremoloEvaluator(cfg, { startTime: 0, duration: 2 });
  let worst = 0;
  for (let i = 200; i < out.length; i += 37) worst = Math.max(worst, Math.abs(out[i] - ev.gainAtSec(i / sr)));
  a.ok(worst < 0.02, `max |LFO − curve| = ${worst.toFixed(4)}`);
  // Off → transparent.
  const ctx2 = new Offline(1, 800, sr);
  const s2 = ctx2.createConstantSource();
  const t2 = createTremoloNode(ctx2, { on: false });
  s2.connect(t2.node);
  t2.node.connect(ctx2.destination);
  s2.start(0);
  const o2 = (await ctx2.startRendering()).getChannelData(0);
  a.ok(o2.every((x) => Math.abs(x - 1) < 1e-6), 'off → unity gain');
}, { group: 'audio' });
