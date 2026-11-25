/**
 * Flexatone — core/tempo.js
 * Layer 0 (core): the Tempo Manager's data contract. Pure data + math — no DOM, no audio.
 * 계층 0 (core): Tempo Manager 데이터 규약. 순수 데이터·수학 (DOM·오디오 없음).
 *
 * The Tempo Manager is the time counterpart of the Loudness Manager (amplitude / dB / sone).
 * A tempo is one small object that can live on ANY level:
 *   - the Manager's master            appState.manager.tempo
 *   - one Manager instance (track)    instance.tempo
 *   - (next step) one studio's own transport — same object, same helpers
 * Levels multiply: effective rate = master × instance × …  (combineRates).
 * 템포 객체 하나가 마스터·인스턴스·(다음 단계) 개별 스튜디오 어디에나 붙고, 단계끼리 곱해집니다.
 *
 *   tempo = { mode: 'rate' | 'bpm', rate: 1, bpm: 120, refBpm: 120 }
 *   rate  = playback speed factor (2 = twice as fast, half as long). Pitch is NOT changed:
 *           time is rescaled inside the studio document, not by resampling.
 *   tape / glideSec: retired (always false / 0). A tempo never changes pitch; older projects that
 *           stored tape: true load with pitch kept. The fields stay so every { rate, tape, doc } caller works.
 *           tape / glideSec: 폐지 (항상 false / 0). 템포는 음고를 바꾸지 않음 — 예전 프로젝트의 tape: true도 음고 유지로 로드.
 *   mode 'rate': the user edits `rate` (×).        mode 'bpm': rate = bpm / refBpm.
 *   mode 'length' (duration lock, the Sone-Lock analogue): rate = natural length / lockSec, so the content
 *           lasts exactly lockSec. Only a caller that knows the natural length can resolve it
 *           (tempoRate(cfg, naturalSec)); without it the rate is 1. 길이 고정: 배속 = 자연 길이 / lockSec.
 *   배속(rate) 2 = 두 배 빠르고 길이는 절반. 음고는 변하지 않음 (리샘플링이 아니라 문서의 시간을 재스케일).
 */

export const TEMPO_MODES = Object.freeze(['rate', 'bpm', 'length']);
export const TEMPO_LOCK_MAX = 3600;
export const TEMPO_RATE_MIN = 0.1;
export const TEMPO_RATE_MAX = 8;
export const TEMPO_BPM_MIN = 10;
export const TEMPO_BPM_MAX = 960;
export const DEFAULT_REF_BPM = 120;
export const TAPE_GLIDE_MAX = 10;

/** Neutral tempo (rate 1). / 기본(중립) 템포 */
export function createDefaultTempoConfig() {
  return { mode: 'rate', rate: 1, bpm: DEFAULT_REF_BPM, refBpm: DEFAULT_REF_BPM, tape: false, glideSec: 0, lockSec: 0 };
}

const num = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : fb);

/** Validate a tempo (unknown / missing fields → defaults). / 템포 검증 */
export function normalizeTempoConfig(src) {
  const d = createDefaultTempoConfig();
  const o = src && typeof src === 'object' ? src : {};
  return {
    mode: TEMPO_MODES.includes(o.mode) ? o.mode : d.mode,
    rate: num(o.rate, TEMPO_RATE_MIN, TEMPO_RATE_MAX, d.rate),
    bpm: num(o.bpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX, d.bpm),
    refBpm: num(o.refBpm, TEMPO_BPM_MIN, TEMPO_BPM_MAX, d.refBpm),
    tape: false, // retired: pitch is always kept / 폐지: 음고는 항상 유지
    glideSec: 0,
    lockSec: num(o.lockSec, 0, TEMPO_LOCK_MAX, d.lockSec),
  };
}

/**
 * Speed factor of one tempo, clamped to [0.1, 8]. `naturalSec` (one-pass length at 1×) resolves the
 * 'length' mode; without it that mode is neutral. / 템포 하나의 배속 (길이 모드는 자연 길이가 필요)
 */
export function tempoRate(cfg, naturalSec = null) {
  const c = normalizeTempoConfig(cfg);
  let r = c.mode === 'bpm' ? c.bpm / c.refBpm : c.rate;
  if (c.mode === 'length') r = c.lockSec > 0 && Number(naturalSec) > 0 && Number.isFinite(Number(naturalSec)) ? Number(naturalSec) / c.lockSec : 1;
  return Math.min(TEMPO_RATE_MAX, Math.max(TEMPO_RATE_MIN, r));
}

/** Product of several tempos (master × instance × …). / 여러 템포의 곱 */
export function combineRates(...cfgs) {
  let r = 1;
  for (const c of cfgs) if (c) r *= tempoRate(c);
  return Math.min(TEMPO_RATE_MAX, Math.max(TEMPO_RATE_MIN, r));
}

/** True when the tempo does not change anything. / 중립 템포 여부 */
export function isNeutralTempo(cfg) {
  return Math.abs(tempoRate(cfg) - 1) < 1e-9;
}

/** Real seconds that `sec` of document time takes at `rate`. / 문서 시간 → 실제 시간 */
export function scaleSeconds(sec, rate) {
  return Number(sec) / Math.max(1e-6, rate);
}

/**
 * Patch a tempo: merge, normalize, and keep the *other* mode's number in step so switching
 * ×  ⇄  BPM never jumps (bpm = refBpm × rate).
 * 템포 패치: 모드를 바꿔도 값이 튀지 않도록 반대쪽 값을 동기화.
 */
export function patchTempo(cur, patch, naturalSec = null) {
  // Re-sync both numbers to the effective rate first, so the stored value of the mode that was
  // not active (e.g. bpm while mode = 'rate') can never leak in. / 비활성 모드의 낡은 값이 섞이지 않게 먼저 동기화
  const base = normalizeTempoConfig(cur);
  const eff = tempoRate(base, naturalSec);
  base.rate = eff;
  base.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, base.refBpm * eff));
  const next = normalizeTempoConfig({ ...base, ...(patch || {}) });
  if (patch && 'rate' in patch && !('bpm' in patch)) next.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, next.refBpm * next.rate));
  if (patch && 'bpm' in patch && !('rate' in patch)) next.rate = Math.min(TEMPO_RATE_MAX, Math.max(TEMPO_RATE_MIN, next.bpm / next.refBpm));
  if (patch && 'refBpm' in patch && !('bpm' in patch) && !('rate' in patch)) next.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, next.refBpm * next.rate));
  // entering the length mode without a target: lock the length the content has now / 목표 없이 길이 모드로: 지금 길이로 고정
  if (patch?.mode === 'length' && !(next.lockSec > 0) && Number(naturalSec) > 0) next.lockSec = Math.min(TEMPO_LOCK_MAX, Number(naturalSec) / eff);
  return next;
}

/**
 * Speed of a track: rate = total speed (master × instance), all of it rendered into the document
 * (doc = rate, pitch kept). tape = 1 and glide = 0 always (Tape mode is retired).
 * 트랙 속도: 전부 문서 시간으로 렌더 (음고 유지). tape = 1, glide = 0 (테이프 모드 폐지).
 */
export function splitRates(...cfgs) {
  let rate = 1;
  const tape = 1;
  const glide = 0;
  for (const c of cfgs) {
    if (!c) continue;
    const n = normalizeTempoConfig(c);
    const r = tempoRate(n);
    rate *= r;
  }
  return { rate, tape, doc: rate / tape, glide };
}

/** Pitch shift of a tape ratio in semitones. / 테이프 배율의 반음 이동 */
export function tapeSemitones(tape) {
  return 12 * Math.log2(Math.max(1e-6, tape));
}
