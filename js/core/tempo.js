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
 *   tape  = false: pitch is kept (default).  true: TAPE mode — pitch follows the speed like a
 *           varispeed tape (rate 0.5 = half speed AND one octave down). glideSec > 0 makes live
 *           speed changes glide like a tape machine spooling up / slowing down.
 *           tape = true: 테이프 모드 — 속도와 음고가 함께 변함 (0.5× = 한 옥타브 아래). glideSec = 속도 변화가 테이프처럼 미끄러지는 시간.
 *   mode 'rate': the user edits `rate` (×).        mode 'bpm': rate = bpm / refBpm.
 *   배속(rate) 2 = 두 배 빠르고 길이는 절반. 음고는 변하지 않음 (리샘플링이 아니라 문서의 시간을 재스케일).
 */

export const TEMPO_MODES = Object.freeze(['rate', 'bpm']);
export const TEMPO_RATE_MIN = 0.1;
export const TEMPO_RATE_MAX = 8;
export const TEMPO_BPM_MIN = 10;
export const TEMPO_BPM_MAX = 960;
export const DEFAULT_REF_BPM = 120;
export const TAPE_GLIDE_MAX = 10;

/** Neutral tempo (rate 1). / 기본(중립) 템포 */
export function createDefaultTempoConfig() {
  return { mode: 'rate', rate: 1, bpm: DEFAULT_REF_BPM, refBpm: DEFAULT_REF_BPM, tape: false, glideSec: 0 };
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
    tape: o.tape === true,
    glideSec: num(o.glideSec, 0, TAPE_GLIDE_MAX, d.glideSec),
  };
}

/** Speed factor of one tempo, clamped to [0.1, 8]. / 템포 하나의 배속 */
export function tempoRate(cfg) {
  const c = normalizeTempoConfig(cfg);
  const r = c.mode === 'bpm' ? c.bpm / c.refBpm : c.rate;
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
export function patchTempo(cur, patch) {
  // Re-sync both numbers to the effective rate first, so the stored value of the mode that was
  // not active (e.g. bpm while mode = 'rate') can never leak in. / 비활성 모드의 낡은 값이 섞이지 않게 먼저 동기화
  const base = normalizeTempoConfig(cur);
  const eff = tempoRate(base);
  base.rate = eff;
  base.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, base.refBpm * eff));
  const next = normalizeTempoConfig({ ...base, ...(patch || {}) });
  if (patch && 'rate' in patch && !('bpm' in patch)) next.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, next.refBpm * next.rate));
  if (patch && 'bpm' in patch && !('rate' in patch)) next.rate = Math.min(TEMPO_RATE_MAX, Math.max(TEMPO_RATE_MIN, next.bpm / next.refBpm));
  if (patch && 'refBpm' in patch && !('bpm' in patch) && !('rate' in patch)) next.bpm = Math.min(TEMPO_BPM_MAX, Math.max(TEMPO_BPM_MIN, next.refBpm * next.rate));
  return next;
}

/**
 * Split the speed of a track into what the document clock does and what the tape does.
 * Levels with `tape: true` change pitch with their rate; the others keep pitch.
 *   rate = total speed (master × instance)   tape = product of the tape levels' rates (pitch ratio)
 *   doc  = rate / tape (pitch-preserving time scale to render into the document)   glide = longest glide of a tape level
 * 트랙 속도를 문서 시간(음고 유지)과 테이프(음고 동반)로 분리.
 */
export function splitRates(...cfgs) {
  let rate = 1;
  let tape = 1;
  let glide = 0;
  for (const c of cfgs) {
    if (!c) continue;
    const n = normalizeTempoConfig(c);
    const r = tempoRate(n);
    rate *= r;
    if (n.tape) { tape *= r; glide = Math.max(glide, n.glideSec); }
  }
  return { rate, tape, doc: rate / tape, glide };
}

/** Pitch shift of a tape ratio in semitones. / 테이프 배율의 반음 이동 */
export function tapeSemitones(tape) {
  return 12 * Math.log2(Math.max(1e-6, tape));
}
