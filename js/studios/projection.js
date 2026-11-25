/**
 * Flexatone — studios/projection.js
 * Layer 2 (studios, pure): the **Projection contract** — how any studio shows itself to the Master
 * (Master View, masks, MIDI export, …) on a plain Euclidean grid: time (s) × pitch (MIDI = log Hz).
 * 계층 2 (studios, 순수): **투영 규약** — 스튜디오가 마스터에게 보이는 방식. 마스터는 시간(초) × 음고(MIDI = log Hz)의
 * 유클리드 격자만 안다.
 *
 * Why / 왜
 *   Inside a studio everything may be free: time can be edited (reverse, warp, loops, takes), frequency can live
 *   on a phase space (Risset: the circle S¹ — pitch wraps), partials can interact. The Master must NOT know
 *   any of that. A studio therefore only has to answer one question: "what do you sound like, as curves in
 *   (time, pitch)?". Everything the Master does (draw, mask, export, sample a grid) works on that answer.
 *   스튜디오 안은 자유(시간 편집, 위상공간), 마스터는 (시간, 음고) 곡선만 받는다.
 *
 * Data / 데이터
 *   Pt   = { t, m, a? }   t = seconds in the studio's DOCUMENT time, m = MIDI pitch, a = amplitude 0…1 (optional).
 *                          m = NaN is a break (the line is cut there — gaps, S¹ wraps). t0 / m0 (optional) = the point
 *                          as written when the Master bends it (warp), kept untouched by every helper here.
 *   Path = { key, name, color?, domain: 'euclid' | 'phase', pts: Pt[] }
 *   A path may be ANY curve in the (t, m) plane. The Master always works with its *monotone pieces*
 *   (`monotonePieces`): runs in which t never decreases. Each piece is a single-valued function m(t), so a
 *   reversed, looped or spiralling curve becomes several pieces and a chord / multi-valued pitch is simply
 *   several pieces sounding at once. That is the whole trick that lets free-time studios live on a rigid grid.
 *   임의의 곡선도 t가 줄지 않는 조각들로 나누면 각각 m(t) 함수 → 시간 역행·반복·나선·다성도 격자에 올라감.
 *
 * Phase-space studios (`domain: 'phase'`, period P semitones): the studio hands the path as it sounds
 * (wrapped); `cutAtWrap(pts, P)` inserts the breaks, so a wrap never draws a line across the grid.
 * 위상공간 스튜디오는 래핑 지점마다 끊김(NaN)을 넣어서 격자를 가로지르는 선이 생기지 않게 함.
 *
 * Registry: `registerProjection(studio, { domain, paths(doc, opts) })`. A studio without a projection is a
 * *block* (the Master shows its clip only). A Send line is NOT a projection — it is a line the user chooses to
 * send (Cloud sends its centre curve, the Master draws its grains) — so there is no fallback to it.
 * 레지스트리: 투영이 없으면 블록. Send 선은 "보내려고 고른 선"이지 소리 모양이 아니므로 대체하지 않음.
 *
 * Imports: core/*, studios/trajectory-link.js. No DOM, no audio.
 */

import { registerSelfCheck } from '../core/state.js';
import { sourceDoc } from './trajectory-link.js';

export const PROJECTION_DOMAINS = Object.freeze(['euclid', 'phase']);

const projections = new Map(); // studio id → { domain, period?, paths(doc, opts) → Path[] }

/**
 * Register a studio's own projection.
 * @param {string} studio
 * @param {{ domain?: 'euclid'|'phase', period?: number, paths: (doc: object|null, opts?: object) => Array }} proj
 */
export function registerProjection(studio, proj) {
  projections.set(studio, { domain: proj.domain === 'phase' ? 'phase' : 'euclid', period: proj.period, paths: proj.paths });
}

export const hasProjection = (studio) => projections.has(studio);
export const listProjections = () => [...projections.keys()];

/** 'projection' (the studio draws curves on the grid) | 'block' (clip only). */
export function projectionKind(studio) {
  return projections.has(studio) ? 'projection' : 'block';
}

/**
 * Paths of a studio document in document time.
 *   opts.fromDoc = true → read exactly `doc` (null = the studio's defaults) — the Manager's instance / take documents.
 *   otherwise `doc == null` reads the editor (or the instance `opts.instId`). 문서 시간 기준 경로.
 * A studio without a projection returns [] (a block).
 * @returns {Array<{ key: string, name: string, color?: string, domain: string, pts: Array<{t:number,m:number,a?:number}> }>}
 */
export function projectStudio(studio, doc = null, opts = {}) {
  const d = opts.fromDoc || doc != null ? doc : sourceDoc(studio, opts.instId ?? null);
  const own = projections.get(studio);
  return own ? normalizePaths(own.paths(d, opts), own.domain) : [];
}

function normalizePaths(list, domain) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !Array.isArray(p.pts)) continue;
    out.push({ key: String(p.key), name: String(p.name ?? p.key), ...(p.color ? { color: p.color } : {}), domain: p.domain || domain, pts: p.pts });
  }
  return out;
}

// ==========================================================================
// Pure helpers / 순수 헬퍼
// ==========================================================================

/**
 * Split a point list into the runs between breaks (non-finite t or m). Runs of fewer than 2 points are dropped.
 * 끊김(NaN)으로 나눈 연속 구간 (점 2개 미만은 버림).
 */
export function splitAtBreaks(pts) {
  const runs = [];
  let cur = [];
  for (const p of pts) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.m)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/**
 * Break a path wherever time runs backwards: the result are the monotone pieces (t non-decreasing), each a
 * single-valued function m(t) — what the Master grid can hold. A piece that runs backwards entirely (a reversed
 * line) is flipped so it reads forward in time.
 * 시간이 거꾸로 가는 지점에서 나눔 → 각 조각은 m(t) 함수. 통째로 역행하는 조각은 뒤집어서 정방향으로.
 */
export function monotonePieces(pts) {
  const out = [];
  for (const run of splitAtBreaks(pts)) {
    let cur = [run[0]];
    let dir = 0; // 0 unknown, +1 forward, −1 backward
    for (let i = 1; i < run.length; i++) {
      const dt = run[i].t - run[i - 1].t;
      const d = dt > 0 ? 1 : dt < 0 ? -1 : 0;
      if (d !== 0 && dir !== 0 && d !== dir) {
        out.push(dir < 0 ? cur.reverse() : cur);
        cur = [run[i - 1]];
        dir = 0;
      }
      if (d !== 0 && dir === 0) dir = d;
      cur.push(run[i]);
    }
    if (cur.length >= 2) out.push(dir < 0 ? cur.reverse() : cur);
  }
  return out;
}

/**
 * Phase-space path → Euclidean path: insert a break (m = NaN) between two samples whose pitch jumped by more than
 * `period / 2` (the point went round the circle). `period` in semitones.
 * 위상공간 경로 → 유클리드 경로: 한 바퀴 돈 지점(음고가 period/2보다 크게 점프)에 끊김 삽입.
 */
export function cutAtWrap(pts, period) {
  const out = [];
  let prev = null;
  for (const p of pts) {
    if (prev && Number.isFinite(p.m) && Number.isFinite(prev.m) && Math.abs(p.m - prev.m) > period * 0.5) out.push({ t: prev.t, m: NaN });
    out.push(p);
    prev = p;
  }
  return out;
}

/**
 * Time / pitch re-mapping of a path: heard time = t / rate, heard pitch = m + semis. A tempo, tape or warp map of
 * the Master composes with a studio's own projection through this (and the written values t0 / m0 are kept).
 * 경로 재매핑: 들리는 시간 = t / rate, 음고 = m + semis (원래 값은 t0·m0로 보존).
 */
export function retime(path, { rate = 1, semis = 0, offset = 0 } = {}) {
  const r = rate > 0 ? rate : 1;
  return { ...path, pts: path.pts.map((p) => (Number.isFinite(p.m) ? { ...p, t: p.t / r + offset, m: p.m + semis, t0: p.t0 ?? p.t, m0: p.m0 ?? p.m } : p)) };
}

/** Problems that would break the grid contract (empty = valid). / 규약 위반 목록 (비어 있으면 정상) */
export function validatePath(path) {
  const bad = [];
  if (!path || typeof path.key !== 'string') bad.push('key');
  if (!path || !Array.isArray(path.pts)) return [...bad, 'pts'];
  for (const p of path.pts) {
    if (!p || typeof p.t !== 'number' || Number.isNaN(p.t)) { bad.push('t is not a number'); break; }
    if (!Number.isNaN(p.m) && !Number.isFinite(p.m)) { bad.push('m is ±Infinity'); break; }
    if (p.a !== undefined && !(p.a >= 0 && p.a <= 4)) { bad.push('a out of range'); break; }
  }
  return bad;
}

/** MIDI pitches of a path at time t (one per monotone piece covering t) — chords and loops give several. */
export function pitchesAt(paths, t) {
  const out = [];
  for (const path of paths) {
    for (const piece of monotonePieces(path.pts)) {
      if (t < piece[0].t || t > piece[piece.length - 1].t) continue;
      let k = 0;
      while (k < piece.length - 2 && piece[k + 1].t < t) k++;
      const a = piece[k];
      const b = piece[k + 1];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      out.push({ key: path.key, m: a.m + (b.m - a.m) * u, a: a.a === undefined ? 1 : (a.a ?? 1) + ((b.a ?? a.a ?? 1) - (a.a ?? 1)) * u });
    }
  }
  return out;
}

/**
 * Rasterise paths onto the Master's Euclidean grid: `nt` time columns over [t0, t1] × `nm` pitch rows over
 * [mLo, mHi]. Each monotone piece deposits its amplitude (default 1) into the cells its line crosses; within one
 * column a piece's weight is 1·a in total (spread over the rows it sweeps), so a steep and a flat line weigh the
 * same and the sum of a column = Σ amplitudes of the sounding pieces. Row 0 = mLo.
 * 경로를 마스터의 유클리드 격자에 래스터화. 한 열에서 조각 하나의 무게 합 = 진폭 (가파른 선도 같음).
 * @returns {{ nt: number, nm: number, t0: number, t1: number, mLo: number, mHi: number, data: Float32Array }}
 */
export function gridify(paths, { t0, t1, nt = 256, mLo, mHi, nm = 128 }) {
  const data = new Float32Array(nt * nm);
  const dt = (t1 - t0) / nt;
  const dm = (mHi - mLo) / nm;
  const rowOf = (m) => Math.min(nm - 1, Math.max(0, Math.floor((m - mLo) / dm)));
  for (const path of paths) {
    for (const piece of monotonePieces(path.pts)) {
      const ta = piece[0].t;
      const tb = piece[piece.length - 1].t;
      const c0 = Math.max(0, Math.floor((ta - t0) / dt));
      const c1 = Math.min(nt - 1, Math.floor((tb - t0) / dt - 1e-9));
      for (let c = c0; c <= c1; c++) {
        const tc0 = Math.max(ta, t0 + c * dt);
        const tc1 = Math.min(tb, t0 + (c + 1) * dt);
        if (tc1 <= tc0) continue;
        const at = (t) => pitchesAt([{ key: path.key, pts: piece }], t)[0];
        const p0 = at(tc0);
        const p1 = at(tc1);
        if (!p0 || !p1) continue;
        const w = ((p0.a + p1.a) / 2) * ((tc1 - tc0) / dt); // share of the column this piece covers / 열을 차지하는 비율
        const r0 = rowOf(Math.min(p0.m, p1.m));
        const r1 = rowOf(Math.max(p0.m, p1.m));
        for (let r = r0; r <= r1; r++) data[r * nt + c] += w / (r1 - r0 + 1);
      }
    }
  }
  return { nt, nm, t0, t1, mLo, mHi, data };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Projection: monotone pieces, breaks, S¹ wrap, retime', (a) => {
  const L = (xs) => xs.map(([t, m]) => ({ t, m }));
  // forward line stays one piece / 정방향 한 조각
  a.equal(monotonePieces(L([[0, 60], [1, 62], [2, 64]])).length, 1, 'forward line = 1 piece');
  // reversed line is flipped / 역행 선은 뒤집힘
  const rev = monotonePieces(L([[2, 64], [1, 62], [0, 60]]));
  a.equal(rev.length, 1, 'reversed = 1 piece');
  a.equal(rev[0][0].t, 0, 'reversed piece reads forward');
  // out-and-back (time goes forward, then back) = 2 pieces / 갔다가 되돌아오는 곡선
  const loop = monotonePieces(L([[0, 60], [2, 62], [4, 64], [3, 66], [1, 68]]));
  a.equal(loop.length, 2, 'out-and-back = 2 pieces');
  a.equal(loop.reduce((s, p) => s + p.length, 0), 5 + 1, 'every point kept (turning point shared)');
  // NaN is a break / NaN = 끊김
  a.equal(monotonePieces([{ t: 0, m: 60 }, { t: 1, m: 61 }, { t: 1.5, m: NaN }, { t: 2, m: 62 }, { t: 3, m: 63 }]).length, 2, 'NaN splits');
  // S¹ wrap: a sawtooth rising 12 st per second wraps every second / S¹ 래핑
  const saw = [];
  for (let i = 0; i <= 30; i++) saw.push({ t: i / 10, m: 48 + ((i * 1.2) % 12) });
  const cut = cutAtWrap(saw, 12);
  const pieces = monotonePieces(cut);
  a.ok(pieces.length >= 3, `sawtooth cut into ${pieces.length} pieces`);
  a.ok(pieces.every((p) => p.every((q, k) => k === 0 || Math.abs(q.m - p[k - 1].m) < 6)), 'no piece jumps across the circle');
  // retime keeps the written values / 재매핑은 원본 보존
  const rt = retime({ key: 'k', pts: [{ t: 2, m: 60 }] }, { rate: 2, semis: -12 });
  a.equal(rt.pts[0].t, 1, 't ÷ rate');
  a.equal(rt.pts[0].m, 48, 'm + semis');
  a.equal(rt.pts[0].t0, 2, 'written t kept');
  // multi-valued pitch: two lines at the same time / 다성
  const two = [{ key: 'a', pts: L([[0, 60], [4, 64]]) }, { key: 'b', pts: L([[0, 72], [4, 68]]) }];
  const at2 = pitchesAt(two, 2).map((p) => p.m).sort((x, y) => x - y);
  a.equal(JSON.stringify(at2), '[62,70]', 'two pitches at t = 2');
  a.equal(validatePath({ key: 'x', pts: [{ t: 0, m: 60 }, { t: 1, m: NaN }] }).length, 0, 'NaN break is valid');
  a.ok(validatePath({ key: 'x', pts: [{ t: 0, m: Infinity }] }).length > 0, '±Infinity rejected');
}, { group: 'studio' });

registerSelfCheck('Projection: grid rasterisation conserves weight (flat, steep, multi-valued)', (a) => {
  const flat = gridify([{ key: 'f', pts: [{ t: 0, m: 60 }, { t: 4, m: 60 }] }], { t0: 0, t1: 4, nt: 8, mLo: 48, mHi: 72, nm: 24 });
  const colSum = (g, c) => { let s = 0; for (let r = 0; r < g.nm; r++) s += g.data[r * g.nt + c]; return s; };
  a.near(colSum(flat, 3), 1, 1e-6, 'flat line: column weight 1');
  const steep = gridify([{ key: 's', pts: [{ t: 0, m: 49 }, { t: 4, m: 71 }] }], { t0: 0, t1: 4, nt: 8, mLo: 48, mHi: 72, nm: 24 });
  a.near(colSum(steep, 3), 1, 1e-6, 'steep line: column weight 1');
  const chord = gridify([{ key: 'a', pts: [{ t: 0, m: 55 }, { t: 4, m: 55 }] }, { key: 'b', pts: [{ t: 0, m: 67, a: 0.5 }, { t: 4, m: 67, a: 0.5 }] }], { t0: 0, t1: 4, nt: 8, mLo: 48, mHi: 72, nm: 24 });
  a.near(colSum(chord, 5), 1.5, 1e-6, 'two simultaneous lines add their amplitudes');
  const gap = gridify([{ key: 'g', pts: [{ t: 0, m: 60 }, { t: 1, m: 60 }, { t: 1, m: NaN }, { t: 3, m: 60 }, { t: 4, m: 60 }] }], { t0: 0, t1: 4, nt: 4, mLo: 48, mHi: 72, nm: 24 });
  a.near(colSum(gap, 1), 0, 1e-6, 'a break leaves the column empty');
  a.near(colSum(gap, 3), 1, 1e-6, 'the line continues after the break');
  const rev = gridify([{ key: 'r', pts: [{ t: 4, m: 50 }, { t: 0, m: 70 }] }], { t0: 0, t1: 4, nt: 8, mLo: 48, mHi: 72, nm: 24 });
  a.near(colSum(rev, 2), 1, 1e-6, 'a reversed line still fills every column once');
}, { group: 'studio' });
