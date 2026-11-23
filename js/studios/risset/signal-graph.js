/**
 * Flexatone — studios/risset/signal-graph.js
 * Risset Studio (pure): the multichannel signal contract shared by every stage (mc~ style).
 * 리세 스튜디오 (순수): 모든 단계가 주고받는 다채널 신호 규격 (mc~ 방식).
 *
 * Signal state (one entry per voice i < N, typed arrays sized MAX_VOICES):
 *   phase[i] ∈ [0, 1)  S¹ pitch phase            vel[i]   dp/dt (cycles / s)
 *   amp[i]   ∈ [0, 1]  A_global · A_local        mass[i]  gravitational mass (= amp, A-4)
 *   ampGlobal[i], aLocal[i]  the two amplitude factors, buoy[i] buoyancy B_i (A-4)
 * Stage contract: { id, process(state, dt) } — mutates `state` in place, never allocates per call.
 * The Risset chain (risset-core.js): phaseCore → grid → envelope → local → dynamics → output.
 * 단계 규격: { id, process(state, dt) } — state를 제자리에서 갱신.
 * No DOM, no Web Audio, no imports.
 */

export const SIGNAL_MAX = 60;

/** Fresh signal state. / 새 신호 상태 */
export function createSignalState(maxVoices = SIGNAL_MAX) {
  return {
    N: 0,
    phase: new Float64Array(maxVoices),
    vel: new Float64Array(maxVoices),
    amp: new Float64Array(maxVoices),
    ampGlobal: new Float64Array(maxVoices),
    aLocal: new Float64Array(maxVoices).fill(1),
    mass: new Float64Array(maxVoices),
    buoy: new Float64Array(maxVoices),
    ctx: null, // per-step context { params, rt, eff, scrubbing, rng }
  };
}

/** Define a stage (validates the contract). / 단계 정의 */
export function defineStage(id, process) {
  if (typeof id !== 'string' || typeof process !== 'function') throw new Error('stage needs id + process(state, dt)');
  return Object.freeze({ id, process });
}

/** Run stages in order. / 단계를 순서대로 실행 */
export function runStages(stages, state, dt) {
  for (let k = 0; k < stages.length; k++) stages[k].process(state, dt);
  return state;
}

/** Check the signal ranges (used by self-checks). / 신호 범위 검사 */
export function signalInRange(state) {
  for (let i = 0; i < state.N; i++) {
    const p = state.phase[i];
    const a = state.amp[i];
    if (!(p >= 0 && p < 1) || !(a >= 0 && a <= 1 + 1e-9) || !Number.isFinite(state.mass[i])) return false;
  }
  return true;
}
