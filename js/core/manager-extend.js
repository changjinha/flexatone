/**
 * Flexatone — core/manager-extend.js
 * Layer 0 (core): the Manager's Extend tools — make the cycle longer out of what is already in it.
 * Pure data (no DOM, no audio): clip lengths come in through `measure`, like arrangeCycle's lengthOf.
 * 계층 0 (core): 매니저 "연장" 도구 — 이미 있는 것을 재료로 사이클을 늘림. 순수 데이터 (클립 길이는 measure로 받음).
 *
 * Every method appends `seconds` after the current cycle end C and only ADDS things: new tracks
 * (instance.ext = extension id), possibly new ranges (region.ext) and a fixed cycle length C + seconds. The
 * original tracks are not changed, except that a looping clip with no length of its own gets its
 * present length written down (it would otherwise grow into the extension). The step is logged in
 * manager.extensions, so "Remove last extension" restores exactly what was there before.
 * 모든 방법은 현재 사이클 끝 C 뒤에 seconds만큼 덧붙이며 "추가"만 함: 새 트랙(instance.ext), 새 구간(region.ext),
 * 고정 사이클 길이 C + seconds. 원래 트랙은 그대로 (길이 미지정 반복 클립만 현재 길이를 명시). manager.extensions에
 * 기록되므로 "마지막 연장 제거"로 정확히 이전 상태로 돌아감.
 *
 * Methods / 방법 — each one states what it takes "musical" to mean / 각 방법이 정의하는 "음악적임"
 *   retro   Perfect retrograde. Musical = symmetry and closure: the listener hears everything that
 *           happened happen backwards and arrives where the piece began (a palindrome, A | A⁻¹).
 *           Every clip is appended as a time-reversed *take* (core/take-config.js) of the sound it
 *           made — shape masks, range solo / mute, Warps, tremolo, tempo, loops included — mirrored
 *           about the cycle end: a clip on [a, b) comes back on [2C − b, 2C − a), fade-in and
 *           fade-out swap. Longer than one cycle = the mirror keeps reflecting (backwards, forwards,
 *           backwards …); shorter = only the last part comes back.
 *           완벽한 역행. 음악적임 = 대칭과 종결: 일어난 일이 모두 거꾸로 일어나 처음으로 돌아옴 (팰린드롬).
 *   mirror  Settings retrograde. Musical = the same palindrome as retro, but read as a score: what
 *           was set on the timeline (pitch curves, envelopes, entries, automation, masks, Warps)
 *           runs backwards, while every sound itself plays forwards — an attack stays an attack, a
 *           release tail still follows its sound (audio/time-mirror.js). Placement and reflection
 *           as retro.
 *           설정 역행. 역행과 같은 팰린드롬이지만 악보로 읽음: 타임라인에 설정된 것(음고 곡선·엔벨로프·진입·
 *           자동화·마스크·곡률)이 거꾸로 진행하고, 소리 자체는 순방향 (어택은 어택, 잔향은 소리 뒤).
 *   canon   Tape canon (parameter interaction: rigid coupling). Musical = imitation in which the
 *           parameters that physically belong together stay locked to one ratio ρ: speed, pitch,
 *           length, tremolo rate and fade times all change by ρ (a just interval), and the level
 *           steps back 3 dB per octave of distance. The whole cycle answers itself like a slowed or
 *           sped-up tape. The amount picks ρ: the answer lasts C / ρ, so ρ = the just ratio nearest
 *           to C / amount (×2 → 1:2, an octave lower at half speed; ×½ → 2:1).
 *           테이프 카논 (상호작용: 강결합). 음악적임 = 함께 움직여야 하는 매개변수(속도·음고·길이·트레몰로 속도·
 *           페이드)가 하나의 순정 비율 ρ로 묶인 모방. 음량은 옥타브당 3 dB 물러남. 양이 ρ를 결정 (C / 양에 가장 가까운 순정비).
 *   swap    Role exchange (parameter interaction: compensation). Musical = balance — whatever one
 *           part gains, another gives back, so the whole stays and the roles rotate. The cycle is
 *           heard again with the mixing roles passed round: tracks are ranked by how loud they
 *           sound (measured level + fader); each takes over the sounding level, fade-in, fade-out
 *           and tremolo of the next one down, the quietest comes to the front. The set of levels is
 *           the same before and after. Each further cycle of length rotates one step more.
 *           역할 교환 (상호작용: 보상). 음악적임 = 균형 — 한 성부가 얻는 만큼 다른 성부가 내어 주어 전체는 유지되고
 *           역할이 돈다. 들리는 음량 순으로 줄 세워 음량·페이드·트레몰로를 한 칸씩 넘겨받음 (가장 작던 성부가 앞으로).
 *   arc     Tension arc (parameter interaction: co-variation in time). Musical = direction — the
 *           tension parameters rise together to one climax at the golden section (0.618) of the
 *           extension and release together: entries follow each other ever faster (each gap 0.8 ×
 *           the last), each enters louder (−9 → 0 dB) and with a shorter fade-in, and each new
 *           round enters higher and faster on a just tape ratio (1 → 3:2 → 2:1). After the climax
 *           the voices leave one by one, last in first out, so the opening voice closes.
 *           긴장 곡선 (상호작용: 시간에 따른 공변). 음악적임 = 방향성 — 진입 간격·음량·어택·음고/속도가 함께 올라
 *           연장의 황금분할(0.618) 지점에서 정점, 이후 함께 풀림 (늦게 들어온 성부부터 퇴장).
 *   rondo   Ritornello (a formal criterion, not a parameter one). Musical = form: return and
 *           contrast. A refrain — the opening of the cycle, all tracks — keeps coming back, and
 *           between its returns one track at a time is heard alone (a little louder), in the order
 *           the tracks first entered. About one episode + refrain per 10 s (60 % solo, 40 % refrain).
 *           리토르넬로 (형식 기준). 음악적임 = 형식: 회귀와 대비 — 사이클의 첫머리(전체 합주)가 계속 돌아오고,
 *           그 사이마다 한 트랙씩 독주. 약 10초마다 에피소드 + 후렴.
 */

import { uid, deepClone, clamp } from './math-utils.js';
import { appState, dispatch, createInstanceDefaults, createDefaultManagerState, registerSelfCheck, withIsolatedState, MAX_TIME } from './state.js';
import { ensureManager, getInstanceDoc, getFocusedInstance, isFocused, focusInstance, setInstance, distinctTrackColor } from './manager-state.js';
import { createDefaultTake } from './take-config.js';

/** Methods in button order. / 버튼 순서의 방법 목록 */
export const EXTEND_METHODS = Object.freeze(['retro', 'mirror', 'canon', 'swap', 'arc', 'rondo']);
/** Methods that need measure.level(inst) → { level, peak } dBFS (the mixer measures it). / 음량 측정이 필요한 방법 */
export const EXTEND_NEEDS_LEVELS = Object.freeze(['swap']);
export const EXTEND_MIN_SEC = 0.1;
/** Fade (s) where an appended clip is cut by the edge of the extension. / 연장 경계에서 잘릴 때의 페이드 */
const EDGE_FADE = 0.03;
const MIN_CLIP = 0.02;

const r3 = (x) => Math.round(x * 1000) / 1000;
const mgr = () => appState.manager || (appState.manager = createDefaultManagerState());

export function listExtensions() {
  const m = mgr();
  if (!Array.isArray(m.extensions)) m.extensions = [];
  return m.extensions;
}

/** Longest extension (s) that still fits the timeline. / 가능한 최대 연장 길이 */
export function maxExtension(cycleLength) {
  return Math.max(0, MAX_TIME - cycleLength);
}

function suffixName(name, suffix) {
  return `${String(name).slice(0, 40 - suffix.length)}${suffix}`;
}

/**
 * A new track that plays a take of `src` (its own copy of the document, mixer, tempo and tremolo).
 * `take` = { rev, at, len, loop }; `over` = arrangement fields (start, length, fades …).
 * src의 테이크를 재생하는 새 트랙 (문서·믹서·템포·트레몰로는 복사본).
 */
function makeTakeTrack(src, opId, take, over, suffix) {
  return {
    ...createInstanceDefaults(src.studio),
    id: uid('in_', 6),
    studio: src.studio,
    name: suffixName(src.name, suffix),
    color: src.color,
    doc: deepClone(getInstanceDoc(src)),
    gainDb: src.gainDb,
    mute: !!src.mute,
    solo: !!src.solo,
    inCycle: true,
    loop: false,
    tempo: deepClone(src.tempo),
    tremolo: deepClone(src.tremolo),
    take: { ...createDefaultTake(), on: true, as: src.id, inner: src.take?.on ? deepClone(src.take) : null, ...take },
    ext: opId,
    ...over,
  };
}

// ==========================================================================
// Methods / 방법
// Each planner gets { C, X, sources: [{ inst, a, b, L }], regions, opId } and returns
// { tracks: [{ after: srcId, inst }], regions: [region] }. Times are cycle seconds.
// ==========================================================================

/**
 * Perfect retrograde: the extension time τ ∈ [0, X) reads the cycle at C − τ, reflecting at both
 * ends (segment k of length C: even = backwards, odd = forwards).
 * 완벽한 역행: 연장 시각 τ는 사이클의 C − τ를 읽고 양 끝에서 반사 (짝수 구간 = 역행, 홀수 구간 = 순행).
 */
function planRetro({ C, X, sources, opId }, mirror = false) {
  const tracks = [];
  let done = 0;
  for (let k = 0; done < X - 1e-6 && k < 64; k++) {
    const seg = Math.min(C, X - done); // how much of the cycle this reflection covers / 이번 반사가 덮는 길이
    const rev = k % 2 === 0;
    const base = C + done;
    for (const { inst, a, b, L } of sources) {
      let start;
      let play;
      let fadeIn;
      let fadeOut;
      if (rev) {
        // source window [C − seg, C]: the part [o0, b) comes back on [base + C − b, base + C − o0)
        const o0 = Math.max(a, C - seg);
        play = b - o0;
        start = base + (C - b);
        fadeIn = inst.fadeOut;
        fadeOut = o0 > a + 1e-6 ? EDGE_FADE : inst.fadeIn;
      } else {
        // source window [0, seg]: the part [a, o1) plays again on [base + a, base + o1)
        const o1 = Math.min(b, seg);
        play = o1 - a;
        start = base + a;
        fadeIn = inst.fadeIn;
        fadeOut = o1 < b - 1e-6 ? EDGE_FADE : inst.fadeOut;
      }
      if (!(play >= MIN_CLIP)) continue;
      const back = mirror ? { rev: false, mirror: rev } : { rev }; // settings or tape retrograde / 설정 또는 테이프 역행
      const track = makeTakeTrack(inst, opId, { ...back, at: r3(a), len: r3(L), loop: !!inst.loop }, { start: r3(start), length: r3(play), fadeIn, fadeOut }, rev ? (mirror ? ' ◁' : ' ◀') : ' ▶');
      tracks.push({ after: inst.id, inst: track });
    }
    done += seg;
  }
  // No new ranges: range solo / mute and shape masks are inside the takes (rendered as the source track)
  // 새 구간 없음: 구간 솔로·뮤트와 모양 마스크는 테이크 안에 포함 (출처 트랙으로 렌더)
  return { tracks, regions: [] };
}

/** Just ratios a tape canon may answer at (p:q = speed and pitch of the answer). / 테이프 카논의 순정 비율 */
const JUST_RATIOS = Object.freeze([[1, 2], [3, 5], [2, 3], [3, 4], [4, 5], [5, 6], [6, 5], [5, 4], [4, 3], [3, 2], [5, 3], [2, 1]]);
/** Level step of the answer: dB per octave of distance from the original. / 응답의 음량: 옥타브당 dB */
const CANON_DB_PER_OCT = 3;

/**
 * Ratio of the tape canon for an extension of X seconds: the just ratio nearest (in log) to C / X;
 * a tie goes to the lower, slower one. / 연장 X초에 대한 테이프 카논 비율
 * @returns {{ p: number, q: number, rho: number, seconds: number }}
 */
export function canonRatio(C, X) {
  const want = Math.log(Math.max(1e-6, C) / Math.max(1e-6, X));
  let best = JUST_RATIOS[0];
  let bestD = Infinity;
  for (const r of JUST_RATIOS) {
    const d = Math.abs(Math.log(r[0] / r[1]) - want);
    if (d < bestD - 1e-9) { best = r; bestD = d; }
  }
  const rho = best[0] / best[1];
  return { p: best[0], q: best[1], rho, seconds: C / rho };
}

/**
 * Tape canon: the whole cycle again at ratio ρ — a clip on [a, b) answers on [C + a/ρ, C + b/ρ) as a
 * take played at tape ratio ρ; its fades scale by 1/ρ and its fader steps back 3 dB per octave.
 * 테이프 카논: 사이클 전체를 비율 ρ로 다시 — [a, b)의 클립은 [C + a/ρ, C + b/ρ)에서 테이프 배율 ρ의 테이크로 응답.
 */
function planCanon({ C, X, sources, opId }) {
  const { p, q, rho, seconds } = canonRatio(C, X);
  const back = CANON_DB_PER_OCT * Math.abs(Math.log2(rho));
  const tracks = [];
  for (const { inst, a, L } of sources) {
    const track = makeTakeTrack(inst, opId, { rev: false, at: r3(a), len: r3(L), loop: !!inst.loop, rate: rho }, {
      start: r3(C + a / rho),
      length: r3(L / rho),
      fadeIn: clamp((Number(inst.fadeIn) || 0) / rho, 0, 10),
      fadeOut: clamp((Number(inst.fadeOut) || 0) / rho, 0, 10),
      gainDb: clamp(Math.round((inst.gainDb - back) * 10) / 10, -60, 12),
    }, ` ${p}:${q}`);
    tracks.push({ after: inst.id, inst: track });
  }
  return { tracks, regions: [], seconds, note: `${p}:${q}` };
}

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * Role exchange: pass j of the cycle is heard again with every audible track taking the sounding
 * level (measured level + fader), fades and tremolo of the track (j + 1) ranks below it (the
 * quietest wraps to the loudest). Muted tracks are copied as they are.
 * 역할 교환: j번째 반복에서 각 트랙이 (j + 1)칸 아래 트랙의 들리는 음량·페이드·트레몰로를 넘겨받음.
 */
function planSwap({ C, X, sources, opId, level }) {
  const lv = (s) => (typeof level === 'function' ? level(s.inst) : null) || null;
  const sounding = (s) => (lv(s)?.level ?? 0) + s.inst.gainDb;
  const ranked = sources.filter((s) => !s.inst.mute).sort((x, y) => sounding(y) - sounding(x));
  const rank = new Map(ranked.map((s, k) => [s.inst.id, k]));
  const n = ranked.length;
  const tracks = [];
  let done = 0;
  for (let j = 0; done < X - 1e-6 && j < 64; j++) {
    const seg = Math.min(C, X - done);
    const base = C + done;
    const shift = n > 1 ? (j + 1) % n : 0;
    for (const s of sources) {
      const o1 = Math.min(s.b, seg);
      const play = o1 - s.a;
      if (!(play >= MIN_CLIP)) continue;
      const cut = o1 < s.b - 1e-6;
      const over = { start: r3(base + s.a), length: r3(play), fadeIn: s.inst.fadeIn, fadeOut: s.inst.fadeOut };
      if (shift && rank.has(s.inst.id)) {
        const donor = ranked[(rank.get(s.inst.id) + shift) % n];
        const own = lv(s);
        let gain = sounding(donor) - (own?.level ?? 0);
        if (own) gain = Math.min(gain, -1 - own.peak); // alone it never clips / 혼자서는 클리핑하지 않게
        Object.assign(over, { gainDb: clamp(r1(gain), -60, 12), fadeIn: donor.inst.fadeIn, fadeOut: donor.inst.fadeOut, tremolo: deepClone(donor.inst.tremolo) });
      }
      if (cut) over.fadeOut = EDGE_FADE;
      tracks.push({ after: s.inst.id, inst: makeTakeTrack(s.inst, opId, { rev: false, at: r3(s.a), len: r3(s.L), loop: !!s.inst.loop }, over, ' ⇄') });
    }
    done += seg;
  }
  return { tracks, regions: [] };
}

const PHI = 0.6180339887;
const ARC_GAP_RATIO = 0.8; // each entry gap = 0.8 × the one before / 진입 간격 비
const ARC_START_DB = -9; // first entry below its fader; the last one is at it / 첫 진입의 음량
const ARC_RATIOS = Object.freeze([[1, 1], [3, 2], [2, 1]]); // tape ratio of each round of entries / 진입 라운드별 테이프 배율

/**
 * Tension arc: n entries (the audible tracks in the order they first entered, 2–3 rounds) in a
 * geometric stretto up to the climax at φ·X; level, attack and tape ratio rise with the entry
 * number; after the climax the entries leave last in, first out. Entries are raw takes (the clip
 * itself, without the range solo / mute rules of its place in the cycle).
 * 긴장 곡선: 진입 n회(처음 들어온 순서, 2–3 라운드)가 φ·X의 정점까지 기하급수적으로 촘촘해짐.
 */
function planArc({ C, X, sources, opId }) {
  const voices = sources.filter((s) => !s.inst.mute).sort((x, y) => x.a - y.a);
  const N = voices.length;
  if (!N) return { tracks: [], regions: [] };
  const rounds = clamp(Math.ceil(6 / N), 2, 3);
  const n = Math.min(12, N * rounds);
  const Tc = PHI * X;
  const d0 = n > 1 ? (0.9 * Tc * (1 - ARC_GAP_RATIO)) / (1 - Math.pow(ARC_GAP_RATIO, n - 1)) : 0;
  const trim = Math.max(0, 10 * Math.log10(n / (2 * N))); // two layers per track are the climax; a third round is trimmed / 트랙당 두 겹까지는 정점으로 허용
  const tracks = [];
  let e = 0;
  for (let k = 0; k < n; k++) {
    const s = voices[k % N];
    const [p, q] = ARC_RATIOS[Math.min(ARC_RATIOS.length - 1, Math.floor(k / N))];
    const gap = d0 * Math.pow(ARC_GAP_RATIO, k);
    const end = Tc + ((X - Tc) * (n - k)) / n;
    const u = n > 1 ? k / (n - 1) : 1;
    tracks.push({ after: s.inst.id, inst: makeTakeTrack(s.inst, opId, { rev: false, at: r3(s.a), len: r3(s.L), loop: !!s.inst.loop, rate: p / q, raw: true }, {
      start: r3(C + e),
      length: r3(end - e),
      loop: true, // an entry that outlasts its clip starts it again / 클립보다 길면 다시 시작
      fadeIn: clamp(0.8 * gap, 0.05, 10),
      fadeOut: clamp(0.8 * (end - Tc), 0.3, 10),
      gainDb: clamp(r1(s.inst.gainDb + ARC_START_DB * (1 - u) - trim), -60, 12),
    }, ` ↗${k + 1}`) });
    e += gap;
  }
  return { tracks, regions: [] };
}

const RONDO_PAIR_SEC = 10; // about one episode + refrain per this many seconds / 에피소드 + 후렴 한 쌍의 길이
const RONDO_SOLO_SHARE = 0.6;
const RONDO_SOLO_DB = 2;

/**
 * Ritornello: m × (episode, refrain). Episode k = one audible track alone from the start of its
 * clip (in the order the tracks first entered); refrain = the first r seconds of the cycle, all tracks.
 * 리토르넬로: m × (에피소드, 후렴). 에피소드 = 한 트랙의 독주, 후렴 = 사이클 첫 r초의 전체 합주.
 */
function planRondo({ C, X, sources, opId }) {
  const solo = sources.filter((s) => !s.inst.mute).sort((x, y) => x.a - y.a);
  const m = clamp(Math.round(X / RONDO_PAIR_SEC), 1, Math.max(1, solo.length));
  const P = X / m;
  const eLen = RONDO_SOLO_SHARE * P;
  const rLen = Math.min(P - eLen, C);
  const tracks = [];
  for (let k = 0; k < m; k++) {
    const base = C + k * P;
    if (solo.length) {
      const s = solo[k % solo.length];
      tracks.push({ after: s.inst.id, inst: makeTakeTrack(s.inst, opId, { rev: false, at: r3(s.a), len: r3(s.L), loop: !!s.inst.loop, raw: true }, {
        start: r3(base),
        length: r3(eLen),
        loop: true,
        fadeIn: clamp(Math.max(Number(s.inst.fadeIn) || 0, 0.05), 0.05, 0.25 * eLen),
        fadeOut: clamp(Math.max(Number(s.inst.fadeOut) || 0, 0.3), 0.05, 0.3 * eLen),
        gainDb: clamp(r1(s.inst.gainDb + RONDO_SOLO_DB), -60, 12),
        mute: false,
        solo: false,
      }, ` · solo ${k + 1}`) });
    }
    const last = k === m - 1;
    for (const s of sources) {
      const o1 = Math.min(s.b, rLen);
      const play = o1 - s.a;
      if (!(play >= MIN_CLIP)) continue;
      const cut = o1 < s.b - 1e-6;
      tracks.push({ after: s.inst.id, inst: makeTakeTrack(s.inst, opId, { rev: false, at: r3(s.a), len: r3(s.L), loop: !!s.inst.loop }, {
        start: r3(base + eLen + s.a),
        length: r3(play),
        fadeIn: s.inst.fadeIn,
        fadeOut: cut ? (last ? Math.min(2, play / 2) : Math.min(0.4, play / 3)) : s.inst.fadeOut, // the last refrain closes / 마지막 후렴은 맺음
      }, ` · R${k + 1}`) });
    }
  }
  return { tracks, regions: [] };
}

/** Settings retrograde: placed like planRetro; the reflected takes mirror the score, not the audio. / 설정 역행 */
function planMirror(args) {
  return planRetro(args, true);
}

const PLANNERS = { retro: planRetro, mirror: planMirror, canon: planCanon, swap: planSwap, arc: planArc, rondo: planRondo };

/**
 * What Extend would add right now: { seconds, note }. A method may settle on a slightly different
 * length than asked (the tape canon snaps to a just ratio). / 지금 연장하면 더해질 길이와 메모
 */
export function extendPreview(method, cycleLength, seconds) {
  const C = Number(cycleLength) || 0;
  const X = clamp(Number(seconds) || 0, 0, maxExtension(C));
  if (method === 'canon' && C > 0 && X > 0) {
    const r = canonRatio(C, X);
    return { seconds: Math.min(r.seconds, maxExtension(C)), note: `${r.p}:${r.q}` };
  }
  return { seconds: X, note: '' };
}

// ==========================================================================
// Apply / remove / 적용·제거
// ==========================================================================

/**
 * Extend the cycle by `seconds` with `method`. `measure` = { cycleLength, clipLength(inst) } from the
 * mixer. One undoable step. / 사이클을 method로 seconds만큼 연장 (실행 취소 1단계)
 * @returns {{ ok: boolean, error?: 'method'|'empty'|'max', id?: string, added?: number, from?: number, to?: number }}
 */
export function extendCycle(method, seconds, measure) {
  const plan = PLANNERS[method];
  if (!plan) return { ok: false, error: 'method' };
  ensureManager();
  const m = mgr();
  const C = Number(measure.cycleLength);
  const X = r3(clamp(Number(seconds) || 0, 0, maxExtension(C)));
  if (!(C >= EXTEND_MIN_SEC) || !(X >= EXTEND_MIN_SEC)) return { ok: false, error: X >= EXTEND_MIN_SEC ? 'empty' : 'max' };
  const lenOf = (i) => Math.max(0, Number(measure.clipLength(i)) || 0);
  // measure.only = ids of the checked tracks (Manager checkboxes); empty / missing = every track / 선택 트랙만 (없으면 전체)
  // Warp tracks among the checked ones decide which bends the new takes keep; if only Warp tracks are
  // checked, every sounding track is extended with just those bends.
  // 선택된 곡률 트랙 = 새 테이크에 남길 곡률. 곡률 트랙만 선택했으면 소리 나는 트랙 전체를 그 곡률로 연장.
  let only = measure.only && measure.only.length ? new Set(measure.only) : null;
  const keepWarps = only ? m.instances.filter((i) => only.has(i.id) && i.warp?.on).map((i) => i.id) : null;
  if (only && !m.instances.some((i) => only.has(i.id) && !i.warp?.on)) only = null;
  const sources = [];
  for (const inst of m.instances) {
    if (only && !only.has(inst.id)) continue;
    if (!inst.inCycle || inst.warp?.on) continue; // Warp tracks are silent: their bend is inside the takes / 곡률은 테이크 안에 포함
    const a = Number(inst.start) || 0;
    const L = Math.min(lenOf(inst), C - a);
    if (L >= MIN_CLIP) sources.push({ inst, a, b: a + L, L });
  }
  if (!sources.length) return { ok: false, error: 'empty' };
  const opId = uid('x_', 6);
  const out = plan({ C, X, sources, regions: (m.regions || []).filter((r) => !(r.t1 <= 0) && r.t0 < C), opId, level: measure.level || null });
  if (!out.tracks.length) return { ok: false, error: 'empty' };
  if (keepWarps) for (const { inst } of out.tracks) if (inst.take?.on && inst.ext === opId) inst.take.warps = keepWarps;
  // every new track gets a colour of its own (they used to repeat their source's) / 새 트랙마다 고유 색
  const usedColors = new Set(m.instances.map((i) => String(i.color || '').toLowerCase()));
  for (const { inst } of out.tracks) { inst.color = distinctTrackColor(inst.studio, usedColors); usedColors.add(inst.color); }
  const Xa = Number.isFinite(out.seconds) ? r3(clamp(out.seconds, EXTEND_MIN_SEC, maxExtension(C))) : X; // a method may settle its own length / 방법이 길이를 정할 수 있음
  // Looping clips with no length of their own would grow into the new part / 길이 미지정 반복 클립은 새 부분까지 늘어남
  const froze = m.instances.filter((i) => i.inCycle && i.loop && (i.length === null || i.length === undefined) && lenOf(i) >= 0.1).map((i) => ({ id: i.id, length: r3(lenOf(i)) }));
  dispatch({
    type: 'manager/extend',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      const mm = s.manager;
      for (const f of froze) { const inst = mm.instances.find((i) => i.id === f.id); if (inst) inst.length = f.length; }
      for (const { after, inst } of out.tracks) {
        // after the source and the tracks already made from it / 출처와 그로부터 만든 트랙들 뒤
        let at = mm.instances.findIndex((i) => i.id === after);
        if (at < 0) at = mm.instances.length - 1;
        while (at + 1 < mm.instances.length && mm.instances[at + 1].ext === opId && mm.instances[at + 1].take?.as === after) at++;
        mm.instances.splice(at + 1, 0, inst);
      }
      mm.regions = [...(mm.regions || []), ...out.regions];
      if (!Array.isArray(mm.extensions)) mm.extensions = [];
      mm.extensions.push({ id: opId, method, seconds: Xa, from: r3(C), to: r3(C + Xa), prev: { cycleMode: mm.cycleMode === 'fixed' ? 'fixed' : 'auto', cycleLen: mm.cycleLen ?? null }, froze });
      mm.cycleMode = 'fixed';
      mm.cycleLen = r3(C + Xa);
    },
  });
  return { ok: true, id: opId, added: out.tracks.length, from: r3(C), to: r3(C + Xa), note: out.note || '' };
}

/**
 * Remove the newest extension: its tracks, its ranges, the cycle length it set and the lengths it
 * wrote down. One undoable step. / 가장 최근 연장 제거 (트랙·구간·사이클 길이·명시한 길이 복원)
 * @returns {boolean}
 */
export function removeLastExtension() {
  const list = listExtensions();
  const x = list[list.length - 1];
  if (!x) return false;
  // A track of the extension that is open in an editor hands the editor back first / 에디터에 열린 연장 트랙은 먼저 포커스를 넘김
  for (const inst of [...mgr().instances]) {
    if (inst.ext !== x.id || !isFocused(inst)) continue;
    const other = mgr().instances.find((i) => i.studio === inst.studio && i.ext !== x.id);
    if (other) focusInstance(other.id);
  }
  dispatch({
    type: 'manager/extend-remove',
    history: true,
    scope: ['manager'],
    mutate: (s) => {
      const mm = s.manager;
      const gone = new Set();
      mm.instances = mm.instances.filter((i) => {
        if (i.ext !== x.id) return true;
        if (mm.focus[i.studio] === i.id) { delete i.ext; return true; } // the only track of its studio stays / 스튜디오의 유일한 트랙은 유지
        gone.add(i.id);
        return false;
      });
      mm.regions = (mm.regions || []).filter((r) => r.ext !== x.id);
      for (const r of mm.regions) { r.solo = r.solo.filter((id) => !gone.has(id)); r.mute = r.mute.filter((id) => !gone.has(id)); }
      for (const f of x.froze || []) { const inst = mm.instances.find((i) => i.id === f.id); if (inst) inst.length = null; }
      mm.cycleMode = x.prev?.cycleMode === 'fixed' ? 'fixed' : 'auto';
      mm.cycleLen = x.prev?.cycleLen ?? null;
      mm.extensions = (mm.extensions || []).filter((e) => e.id !== x.id);
    },
  });
  return true;
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Manager extend: perfect retrograde mirrors clips and fades; remove restores', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const g = getFocusedInstance('glissando');
    const r = getFocusedInstance('risset');
    const f = getFocusedInstance('field');
    setInstance(g.id, { start: 1, length: 4, loop: true, fadeIn: 0.2, fadeOut: 0.7 });
    setInstance(r.id, { start: 0, length: 6, fadeIn: 1, fadeOut: 2 });
    setInstance(f.id, { inCycle: false });
    appState.manager.regions = [{ id: 'rg_t', kind: 'range', name: 'A', t0: 2, t1: 3, solo: [g.id], mute: [] }];
    const lens = { [g.id]: 4, [r.id]: 6, [f.id]: 3 };
    const measure = { cycleLength: 6, clipLength: (i) => lens[i.id] ?? Number(i.length) ?? 0 };
    const res = extendCycle('retro', 6, measure);
    a.ok(res.ok && res.added === 2 && res.to === 12, 'two tracks appended, cycle 6 → 12');
    const list = appState.manager.instances;
    const g2 = list[list.findIndex((i) => i.id === g.id) + 1];
    const r2 = list[list.findIndex((i) => i.id === r.id) + 1];
    a.ok(g2.take.on && g2.take.rev && g2.take.as === g.id && g2.take.at === 1 && g2.take.len === 4 && g2.take.loop, 'take of the glissando clip');
    a.equal(g2.start, 7, 'clip [1, 5) comes back on [7, 11)');
    a.equal(g2.length, 4, 'same length');
    a.ok(g2.fadeIn === 0.7 && g2.fadeOut === 0.2 && g2.loop === false, 'fades swapped, the take itself does not loop');
    a.ok(r2.start === 6 && r2.length === 6 && r2.fadeIn === 2 && r2.fadeOut === 1, 'risset [0, 6) → [6, 12)');
    a.equal(appState.manager.regions.length, 1, 'no new range: range rules are inside the takes');
    a.ok(appState.manager.cycleMode === 'fixed' && appState.manager.cycleLen === 12, 'fixed cycle = 12 s');
    // Half a cycle: only the last 3 s come back / 절반: 마지막 3초만 되돌아옴
    lens[g2.id] = 4; lens[r2.id] = 6;
    const half = extendCycle('retro', 3, { cycleLength: 12, clipLength: (i) => lens[i.id] ?? Number(i.length) ?? 0 });
    const g3 = appState.manager.instances.find((i) => i.ext === half.id && i.take.as === g2.id);
    a.ok(g3 && g3.start === 13 && g3.length === 2 && g3.take.inner?.rev === true, 'second pass: [9, 11) of the take → [13, 15), take of a take');
    a.equal(g3.fadeOut, 0.03, 'cut by the extension edge → short fade');
    a.equal(removeLastExtension(), true, 'remove the half');
    a.equal(appState.manager.cycleLen, 12, 'cycle back to 12');
    a.equal(removeLastExtension(), true, 'remove the first');
    a.ok(appState.manager.instances.length === 3 && appState.manager.regions.length === 1, 'tracks and ranges as before');
    a.ok(appState.manager.cycleMode === 'auto' && appState.manager.extensions.length === 0, 'cycle mode and log restored');
    a.equal(extendCycle('retro', 0, measure).ok, false, 'nothing to add');
    a.equal(extendCycle('nope', 2, measure).ok, false, 'unknown method');
  });
}, { group: 'state' });

registerSelfCheck('Manager extend: tape canon locks speed, pitch, length, fades and level to one just ratio', (a) => {
  a.ok(canonRatio(10, 20).p === 1 && canonRatio(10, 20).q === 2, '×2 → 1:2');
  a.ok(canonRatio(10, 5).p === 2 && canonRatio(10, 5).q === 1, '×½ → 2:1');
  a.ok(canonRatio(10, 15).p === 2 && canonRatio(10, 15).q === 3, '×1.5 → 2:3');
  a.ok(canonRatio(10, 10).p === 5 && canonRatio(10, 10).q === 6, '×1 → 5:6 (the tie goes to the slower one)');
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const g = getFocusedInstance('glissando');
    setInstance(g.id, { start: 2, length: 4, loop: true, fadeIn: 0.2, fadeOut: 0.6, gainDb: -6 });
    setInstance(getFocusedInstance('risset').id, { inCycle: false });
    setInstance(getFocusedInstance('field').id, { inCycle: false });
    const res = extendCycle('canon', 12, { cycleLength: 6, clipLength: () => 4 });
    a.ok(res.ok && res.note === '1:2' && res.to === 18, 'cycle 6 + 12');
    const c = appState.manager.instances.find((i) => i.ext === res.id);
    a.ok(c.take.on && !c.take.rev && c.take.rate === 0.5 && c.take.at === 2 && c.take.len === 4, 'forward take at tape ratio 1:2');
    a.ok(c.start === 10 && c.length === 8, 'clip [2, 6) answers on [6 + 4, 6 + 12)');
    a.ok(c.fadeIn === 0.4 && c.fadeOut === 1.2 && c.gainDb === -9, 'fades ×2, level −3 dB per octave');
  });
}, { group: 'state' });

registerSelfCheck('Manager extend: role exchange, tension arc, ritornello', (a) => {
  withIsolatedState(() => {
    appState.manager = createDefaultManagerState();
    ensureManager();
    const [g, r, f] = ['glissando', 'risset', 'field'].map((x) => getFocusedInstance(x));
    setInstance(g.id, { start: 0, length: 8, loop: true, gainDb: -3, fadeIn: 0.1, fadeOut: 0.2 });
    setInstance(r.id, { start: 2, length: 6, gainDb: -9, fadeIn: 1, fadeOut: 2 });
    setInstance(f.id, { start: 4, length: 4, loop: true, gainDb: -15, fadeIn: 0.5, fadeOut: 0.6 });
    const levels = { [g.id]: { level: -20, peak: -8 }, [r.id]: { level: -20, peak: -10 }, [f.id]: { level: -26, peak: -12 } };
    const lens = { [g.id]: 8, [r.id]: 6, [f.id]: 4 };
    const measure = () => ({ cycleLength: 8, clipLength: (i) => lens[i.id] ?? Number(i.length) ?? 0, level: (i) => levels[i.id] });
    const made = (res) => appState.manager.instances.filter((i) => i.ext === res.id);
    // sounding levels: g −23, r −29, f −41 → one step: g ← r, r ← f, f ← g / 한 칸 교환
    let res = extendCycle('swap', 8, measure());
    let t = made(res);
    const by = (src) => t.find((i) => i.take.as === src.id);
    a.ok(res.ok && t.length === 3, 'three tracks');
    a.equal(by(g).gainDb, -9, 'loudest takes the level of the second (−29 − (−20))');
    a.equal(by(r).gainDb, -21, 'second takes the level of the quietest (−41 − (−20))');
    a.equal(by(f).gainDb, 3, 'quietest comes to the front (−23 − (−26))');
    a.ok(by(g).fadeIn === 1 && by(g).fadeOut === 2 && by(f).fadeIn === 0.1, 'fades go with the role');
    const sum = (list) => list.reduce((x, i) => x + i.gainDb + levels[i.take.as].level, 0);
    a.near(sum(t), -23 - 29 - 41, 1e-6, 'the set of sounding levels is kept');
    removeLastExtension();
    // arc: 3 voices → 2 rounds = 6 entries, climax at 0.618 X / 긴장 곡선
    res = extendCycle('arc', 20, measure());
    t = made(res).sort((x, y) => x.start - y.start);
    a.equal(t.length, 6, 'six entries');
    const gaps = t.slice(1).map((x, k) => x.start - t[k].start);
    a.ok(gaps.every((d, k) => k === 0 || Math.abs(d / gaps[k - 1] - 0.8) < 0.01), 'each gap is 0.8 × the one before');
    a.ok(t[5].start < 8 + 0.618 * 20 && t[5].start > 8 + 0.5 * 20, 'last entry just before the climax');
    a.ok(t[0].take.as === g.id && t[3].take.as === g.id && t[3].gainDb > t[0].gainDb, 'the same track enters louder the second time');
    a.ok(t[0].take.rate === 1 && t[3].take.rate === 1.5, 'second round enters a fifth higher');
    a.near(t[0].start + t[0].length, 28, 1e-6, 'the first voice in is the last out');
    a.ok(t[5].start + t[5].length < t[0].start + t[0].length, 'the last voice in leaves first');
    removeLastExtension();
    // ritornello: 20 s → 2 × (12 s solo, 8 s refrain) / 리토르넬로
    res = extendCycle('rondo', 20, measure());
    t = made(res);
    const solos = t.filter((i) => i.name.includes('solo'));
    a.equal(solos.length, 2, 'two episodes');
    a.ok(solos[0].start === 8 && solos[0].length === 6 && solos[0].take.as === g.id && solos[0].gainDb === -1, 'episode 1: the first track alone, +2 dB');
    a.ok(solos[1].start === 18 && solos[1].take.as === r.id, 'episode 2: the next track');
    const ref1 = t.filter((i) => i.name.includes('R1'));
    a.ok(ref1.length === 2 && ref1.every((i) => i.start >= 14 && i.start + i.length <= 18 + 1e-6), 'refrain 1 = the first 4 s of the cycle (tracks that have entered by then)');
    a.equal(removeLastExtension(), true, 'removed');
    a.equal(appState.manager.instances.length, 3, 'back to three tracks');
  });
}, { group: 'state' });
