/**
 * audio/live-transport.js
 * Shared live transport for the studios: play from the cue (or from a given second), stop,
 * pause at the playhead, loop, playhead clock, and cross-faded re-scheduling while playing.
 * It drives appState.transport, so the shared header works the same in every studio.
 * A studio only says what a pass is (plan + schedule); the transport rules live here once.
 *
 * 스튜디오 공용 실시간 트랜스포트: 큐(또는 지정한 초)부터 재생, 정지, 플레이헤드에서 일시정지,
 * 루프, 플레이헤드 시계, 재생 중 크로스페이드 재스케줄. appState.transport를 갱신하므로
 * 공용 헤더가 모든 스튜디오에서 똑같이 동작한다. 스튜디오는 패스의 내용(plan + schedule)만 정의.
 */

import { appState, setTransport, subscribe } from '../core/state.js';
import { ensureAudioCtx, getAudioCtx, TRANSPORT_FADE_SEC } from './audio-engine.js';

/** A cue this close to the end starts from 0 instead. / 끝에 이만큼 가까운 큐는 0부터 재생 */
const END_GUARD_SEC = 0.02;

/**
 * Fade a pass ({ nodes, master }) out starting at context time `at` (now when earlier) and
 * release its nodes. With `at` = the start time of the next pass this is a cross-fade.
 * 패스를 컨텍스트 시각 at부터 페이드아웃하고 노드를 해제 (다음 패스 시작 시각을 주면 크로스페이드).
 * @param {{ nodes: AudioNode[], master: GainNode }} pass
 * @param {number} [at]
 * @param {(pass: object) => void} [release] extra clean-up once the fade is over / 페이드 후 추가 정리
 */
export function fadeOutPass(pass, at = 0, release = null) {
  if (!pass) return;
  const ctx = getAudioCtx();
  const now = ctx ? ctx.currentTime : 0;
  const tA = Math.max(at, now);
  try {
    pass.master.gain.cancelScheduledValues(now);
    pass.master.gain.setValueAtTime(pass.master.gain.value, now);
    pass.master.gain.setValueAtTime(pass.master.gain.value, tA);
    pass.master.gain.linearRampToValueAtTime(0, tA + TRANSPORT_FADE_SEC);
  } catch { /* context closed */ }
  // dynamicNodes: nodes a self-scheduling pass creates while it plays (Cloud) / 재생 중 만들어지는 노드
  const nodes = [...pass.nodes, ...(pass.dynamicNodes?.() || [])];
  for (const n of nodes) { try { if (n.stop) n.stop(tA + TRANSPORT_FADE_SEC + 0.005); } catch { /* already stopped */ } }
  setTimeout(() => {
    if (release) { try { release(pass); } catch { /* ignore */ } }
    [...nodes, pass.master].forEach((n) => { try { n.disconnect(); } catch { /* ignore */ } });
  }, (tA - now + TRANSPORT_FADE_SEC + 0.1) * 1000);
}

/**
 * Top-level document fields a re-schedule is not needed for: view, selection, tools, and the
 * studio output tremolo (its live stage follows the document by itself).
 * 재스케줄이 필요 없는 최상위 필드: 보기·선택·도구, 그리고 스튜디오 출력 트레몰로(실시간 단이 스스로 따라감)
 */
const UI_FIELDS = new Set(['view', 'activeVoiceId', 'activeStrokeId', 'selectedIds', 'activeLayerId', 'activeRegionId', 'activeSourceId', 'tool', 'drawWidth', 'cueSec', 'importScale', 'trajLink', 'tremolo']);

/**
 * Identity of a studio document's sound for `spec.editKey`: the document without its view /
 * selection fields. / 문서에서 보기·선택 필드를 뺀 소리 식별값
 */
export function soundKey(doc, skip = UI_FIELDS) {
  const out = {};
  for (const k of Object.keys(doc || {})) if (!skip.has(k)) out[k] = doc[k];
  return JSON.stringify(out);
}

/**
 * @param {object} spec
 * @param {() => (number|null)} spec.endSec       end of the timeline now; null = nothing to play / 타임라인 끝 (null이면 재생할 것 없음)
 * @param {(ctx: AudioContext) => object} spec.plan  what one pass plays; must carry `endSec` (read from memoised bakes) / 패스 계획
 * @param {(ctx, master: GainNode, plan, info: { when: number, fromSec: number, nodes: AudioNode[] }) => (object|void)} spec.schedule
 *        schedules the sound into `master`; pushes stoppable nodes to `info.nodes`; may return extra fields kept on the pass
 *        소리를 master에 스케줄. 반환한 객체는 패스에 보관됨.
 * @param {(ctx: AudioContext) => AudioNode} spec.output     where the pass master connects / 마스터의 출력처
 * @param {(plan) => number} [spec.masterGain]               pass level after the fade-in (default 1) / 페이드인 후 레벨
 * @param {(gain: AudioParam, info: { when, now, playDur, plan }) => void} [spec.fadeIn]  replaces the default fade-in / 기본 페이드인 대체
 * @param {(ctx: AudioContext) => Promise<void>} [spec.beforeStart] async set-up before the first pass (worklets) / 첫 패스 전 준비
 * @param {(pass) => void} [spec.onPass]     right after a pass became live (look-ahead schedulers) / 패스 시작 직후
 * @param {() => void} [spec.onClear]        clear the studio's own timers / 스튜디오 자체 타이머 정리
 * @param {(pass) => void} [spec.release]    extra clean-up of a faded pass / 페이드된 패스 추가 정리
 * @param {number} [spec.leadSec]            scheduling lead / 스케줄 선행 시간
 * @param {boolean} [spec.wrapStart]         a pass asked to start at / after the end starts from 0 / 끝 이후 시작 요청은 0부터
 * @param {number|null} [spec.cueDigits]     round the cue pinned by Pause / 일시정지 큐 반올림 자릿수
 * @param {() => any} [spec.editKey]        identity of what the document sounds like; when it changes while playing, the pass is
 *        re-scheduled from the playhead once the edits settle (see soundKey) / 소리 내용의 식별값. 재생 중 바뀌면 플레이헤드에서 재스케줄
 * @param {number} [spec.editDebounceMs]     quiet time before that re-schedule (default 140) / 재스케줄 전 대기 시간
 * @param {boolean} [spec.quietStop]         stop() leaves appState alone when nothing was playing / 재생 중이 아니면 상태를 건드리지 않음
 */
export function createLiveTransport(spec) {
  const { leadSec = 0.03, masterGain = () => 1, wrapStart = false, cueDigits = null, quietStop = false, editDebounceMs = 140 } = spec;
  let live = null; // { nodes, master, ctxStart, fromSec, endSec, token, ...extra }
  let token = 0;
  let rafId = null;
  let endTimer = null;

  const isPlaying = () => !!live;
  /** The pass now sounding (null when stopped). / 현재 패스 */
  const pass = () => live;

  function playheadSec() {
    const ctx = getAudioCtx();
    if (live && ctx) return live.fromSec + Math.max(0, ctx.currentTime - live.ctxStart);
    return appState.transport.playheadSec;
  }

  function clearTimers() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (endTimer !== null) clearTimeout(endTimer);
    rafId = null;
    endTimer = null;
    spec.onClear?.();
  }

  const cueOrStart = (from, endSec) => (from >= endSec - END_GUARD_SEC ? 0 : Math.max(0, from));

  function onEnd(tk) {
    if (!live || live.token !== tk) return;
    // the timeline grew while playing (live.endSec is writable): wait for the new end / 재생 중 길이가 늘었으면 새 끝까지 대기
    const left = live.endSec - playheadSec();
    if (left > 0.05) {
      if (endTimer !== null) clearTimeout(endTimer);
      endTimer = setTimeout(() => onEnd(tk), left * 1000 + 30);
      return;
    }
    if (appState.transport.loop) startPass(cueOrStart(appState.transport.cueSec, live.endSec));
    else stop();
  }

  function tick(tk) {
    if (!live || live.token !== tk) return;
    const sec = playheadSec();
    if (sec >= live.endSec) { onEnd(tk); return; }
    setTransport({ playheadSec: sec });
    rafId = requestAnimationFrame(() => tick(tk));
  }

  /** Start a pass at `fromSec`; a pass already playing is cross-faded out. / fromSec부터 패스 시작 (기존 패스는 크로스페이드) */
  function startPass(fromSec) {
    const ctx = getAudioCtx();
    const plan = spec.plan(ctx);
    const endSec = plan.endSec;
    if (wrapStart && (!(fromSec >= 0) || fromSec >= endSec - END_GUARD_SEC)) fromSec = 0;
    const prev = live;
    clearTimers();
    const when = ctx.currentTime + leadSec;
    if (prev) fadeOutPass(prev, when, spec.release);
    const master = ctx.createGain();
    if (spec.fadeIn) spec.fadeIn(master.gain, { when, now: ctx.currentTime, playDur: endSec - fromSec, plan });
    else {
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.setValueAtTime(0, when);
      master.gain.linearRampToValueAtTime(masterGain(plan), when + TRANSPORT_FADE_SEC);
    }
    master.connect(spec.output(ctx));
    const nodes = [];
    const extra = spec.schedule(ctx, master, plan, { when, fromSec, nodes }) || {};
    const tk = ++token;
    live = { ...extra, nodes, master, ctxStart: when, fromSec, endSec, token: tk, editKey: spec.editKey ? spec.editKey() : null };
    setTransport({ playing: true, playheadSec: fromSec });
    spec.onPass?.(live);
    endTimer = setTimeout(() => onEnd(tk), (endSec - fromSec + leadSec) * 1000 + 30);
    rafId = requestAnimationFrame(() => tick(tk));
  }

  /**
   * Play from the shared cue, or from `fromSec` without moving the cue (Locate drop audition).
   * Resolves false when there is nothing to play.
   * 큐부터 재생, 또는 큐를 옮기지 않고 fromSec부터 재생. 재생할 것이 없으면 false.
   */
  async function start(fromSec = null) {
    if (spec.endSec() === null) return false;
    const ctx = await ensureAudioCtx();
    if (spec.beforeStart) await spec.beforeStart(ctx);
    const endSec = spec.endSec();
    if (endSec === null) return false;
    startPass(cueOrStart(Number.isFinite(fromSec) ? fromSec : appState.transport.cueSec, endSec));
    return true;
  }

  /** Stop with a short fade; the playhead is cleared. / 짧은 페이드로 정지, 플레이헤드 해제 */
  function stop() {
    clearTimers();
    const p = live;
    live = null;
    if (p) fadeOutPass(p, 0, spec.release);
    if (!quietStop || p || appState.transport.playing) setTransport({ playing: false, playheadSec: -1 });
  }

  /** Pause: stop and pin the cue at the playhead. / 일시정지: 플레이헤드에 큐를 고정하고 정지 */
  function pauseAtPlayhead() {
    const sec = playheadSec();
    stop();
    if (sec >= 0) setTransport({ cueSec: Math.max(0, cueDigits === null ? sec : Number(sec.toFixed(cueDigits))) });
  }

  async function togglePause() {
    if (live) { pauseAtPlayhead(); return false; }
    return start();
  }

  async function togglePlay() {
    if (live) { stop(); return false; }
    return start();
  }

  /** While playing: re-schedule from `sec` (default: the playhead) with the current document. / 재생 중 재스케줄 */
  function restart(sec = playheadSec()) {
    if (live) startPass(sec);
  }

  // Edit while playing: the same rule in every studio. Edits arrive through the state bus (the
  // render loop is throttled in a background tab). / 재생 중 편집 반영: 모든 스튜디오 같은 규칙
  if (spec.editKey) {
    let timer = null;
    subscribe(() => {
      if (!live) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!live) return;
        let key;
        try { key = spec.editKey(); } catch { return; }
        if (key === live.editKey) return;
        if (spec.endSec() === null) { stop(); return; }
        const sec = playheadSec();
        if (sec < spec.plan(getAudioCtx()).endSec - 0.05) startPass(sec);
        else live.editKey = key;
      }, editDebounceMs);
    }, { scopes: ['studio'] });
  }

  return { isPlaying, pass, playheadSec, start, stop, pauseAtPlayhead, togglePause, togglePlay, restart };
}
