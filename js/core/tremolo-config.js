/**
 * Flexatone — core/tremolo-config.js
 * Layer 0 (core): the tremolo configuration object shared by every studio (pure data, no DOM/audio).
 * 계층 0 (core): 모든 스튜디오가 공유하는 트레몰로 설정 객체 (순수 데이터).
 *
 * A tremolo is a periodic amplitude modulation g(t) ∈ [1 − depth, 1]; it never boosts, so it can
 * not clip. The evaluator lives in modules/tremolo.js. Voices carry it as `voice.tremolo`;
 * other studios can store the same object in their own params.
 * 트레몰로는 g(t) ∈ [1 − depth, 1]인 주기적 진폭 변조이며 증폭하지 않으므로 클리핑이 없습니다.
 * 평가기는 modules/tremolo.js에 있고, 보이스는 `voice.tremolo`로 보관합니다.
 */

import { clamp } from './math-utils.js';

export const TREMOLO_SHAPES = Object.freeze(['sine', 'tri', 'square', 'saw', 'random', 'formula']);
/** Phase origin: 'voice' restarts at the voice start, 'global' follows the timeline. */
export const TREMOLO_SYNCS = Object.freeze(['voice', 'global']);
export const TREMOLO_UNITS = Object.freeze(['amp', 'db']);
/** Easing used when the rate sweeps rate → rateEnd across the voice. / 속도 스윕 이징 */
export const TREMOLO_RATE_ENGINES = Object.freeze(['linear', 'harmonic', 'expo', 'plateau']);

export const TREMOLO_RATE_UNITS = Object.freeze(['hz', 'beat']);
export const TREMOLO_BPM_MIN = 10;
export const TREMOLO_BPM_MAX = 960;
export const TREMOLO_RATE_MIN = 0.05;
export const TREMOLO_RATE_MAX = 40;
export const TREMOLO_DB_MAX = 60;
export const TREMOLO_FADE_MAX = 60;
export const TREMOLO_FORMULA_MAX = 240;

export function createDefaultTremolo() {
  return {
    on: false,
    shape: 'sine',
    rateUnit: 'hz', // 'hz' | 'beat': tempo sync — rate is then cycles per beat / 템포 동기: 속도 = 박당 주기 수
    bpm: 120, // beats per minute of the document's own time (used when rateUnit = 'beat') / 문서 시간 기준 BPM
    rate: 5, // Hz (or cycles / beat) at the start / 시작 속도
    rateEnd: 5, // at the end (≠ rate → accelerando / ritardando) / 끝 속도
    rateEngine: 'linear',
    depthUnit: 'amp',
    depth: 0.5, // amp unit: 0 … 1 (g ∈ [1 − depth, 1])
    depthDb: 12, // dB unit: dips down to −depthDb
    fadeIn: 0, // s: depth ramps 0 → full over this time / 깊이 페이드인 시간
    phase: 0, // cycles 0 … 1 / 시작 위상
    sync: 'voice',
    smooth: 0.3, // 0 hard … 1 soft edges (square / saw) / 모서리 부드러움
    seed: 1, // random shape / 랜덤 파형 시드
    formula: 'sin(2*pi*x)', // formula shape, x = cycle position 0…1 / 수식 파형
  };
}

const finite = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);

/** Fill defaults and clamp every field (unknown / missing → default). / 정규화 */
export function normalizeTremolo(raw) {
  const d = createDefaultTremolo();
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    on: s.on === true,
    shape: TREMOLO_SHAPES.includes(s.shape) ? s.shape : d.shape,
    rate: clamp(finite(s.rate, d.rate), TREMOLO_RATE_MIN, TREMOLO_RATE_MAX),
    rateEnd: clamp(finite(s.rateEnd, finite(s.rate, d.rateEnd)), TREMOLO_RATE_MIN, TREMOLO_RATE_MAX),
    rateEngine: TREMOLO_RATE_ENGINES.includes(s.rateEngine) ? s.rateEngine : d.rateEngine,
    rateUnit: TREMOLO_RATE_UNITS.includes(s.rateUnit) ? s.rateUnit : d.rateUnit,
    bpm: clamp(finite(s.bpm, d.bpm), TREMOLO_BPM_MIN, TREMOLO_BPM_MAX),
    depthUnit: TREMOLO_UNITS.includes(s.depthUnit) ? s.depthUnit : d.depthUnit,
    depth: clamp(finite(s.depth, d.depth), 0, 1),
    depthDb: clamp(finite(s.depthDb, d.depthDb), 0, TREMOLO_DB_MAX),
    fadeIn: clamp(finite(s.fadeIn, d.fadeIn), 0, TREMOLO_FADE_MAX),
    phase: ((finite(s.phase, d.phase) % 1) + 1) % 1,
    sync: TREMOLO_SYNCS.includes(s.sync) ? s.sync : d.sync,
    smooth: clamp(finite(s.smooth, d.smooth), 0, 1),
    seed: Math.round(clamp(finite(s.seed, d.seed), 0, 99999)),
    formula: typeof s.formula === 'string' && s.formula.trim() ? s.formula.slice(0, TREMOLO_FORMULA_MAX) : d.formula,
  };
}

/** True when the config exists, is switched on and actually modulates. / 실제로 변조하는지 */
export function isTremoloOn(cfg) {
  if (!cfg || cfg.on !== true) return false;
  return cfg.depthUnit === 'db' ? Number(cfg.depthDb) > 0 : Number(cfg.depth) > 0;
}

/**
 * Effective LFO rate in Hz of a (normalized) config: `rate` itself, or cycles-per-beat × bpm / 60
 * when tempo-synced. `which` picks the start ('rate') or end ('rateEnd') value. Clamped to the
 * supported range. / 실효 속도(Hz): 템포 동기 시 박당 주기 × bpm / 60
 */
export function tremoloHz(cfg, which = 'rate') {
  const v = Number(cfg?.[which]);
  const base = Number.isFinite(v) ? v : 5;
  const hz = cfg?.rateUnit === 'beat' ? (base * (Number(cfg.bpm) || 120)) / 60 : base;
  return clamp(hz, TREMOLO_RATE_MIN, TREMOLO_RATE_MAX);
}
