/**
 * Flexatone — core/shape-select.js
 * Layer 0 (core): non-rectangular selection for the Manager. Two curves (cycle time t → MIDI m)
 * enclose areas between their crossings; each area ("lobe") is stored as a band
 * { t[], lo[], hi[] } so membership is a fast lookup. Pure math, no DOM.
 * 계층 0 (core): 매니저용 비사각형 선택. 두 곡선이 교차점 사이에 만드는 닫힌 영역(로브)을
 * { t[], lo[], hi[] } 띠로 저장해 빠르게 포함 여부를 판정.
 *
 * Shape regions: { id, kind: 'shape', name, t0, t1, lobes: [band], solo: [instId], mute: [instId] }
 *   - mute X: X's voices whose pitch lies inside the shape are silenced.
 *   - solo X: inside the shape only X's voices sound (others' voices inside it are silenced).
 *   뮤트 X: 영역 안 음고의 X 보이스 무음 / 솔로 X: 영역 안에서는 X 보이스만 발음.
 */

import { clamp } from './math-utils.js';
import { registerSelfCheck } from './state.js';

/** Linear interpolation of a polyline [{ t, m }] (sorted by t) at time t; NaN outside. */
export function polylineAt(poly, t) {
  if (!poly.length || t < poly[0].t || t > poly[poly.length - 1].t) return NaN;
  let lo = 0;
  let hi = poly.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (poly[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = poly[lo];
  const b = poly[hi];
  const span = b.t - a.t;
  return span > 1e-12 ? a.m + ((t - a.t) / span) * (b.m - a.m) : a.m;
}

/**
 * Areas enclosed by two curves. The common time range is resampled on `n` points; every
 * crossing splits it. Areas between two crossings are `closed`; the ones touching the start or
 * end of the overlap are open (capped by a vertical edge) and flagged closed: false.
 * 두 곡선이 둘러싼 영역 계산: 교차점 사이 = 닫힌 영역, 겹침 구간 양 끝 = 열린 영역(closed:false).
 * @param {Array<{t:number,m:number}>} A
 * @param {Array<{t:number,m:number}>} B
 * @returns {Array<{ t:number[], lo:number[], hi:number[], t0:number, t1:number, closed:boolean, area:number }>}
 */
export function computeEnclosedLobes(A, B, { n = 400, minArea = 0.01 } = {}) {
  if (A.length < 2 || B.length < 2) return [];
  const t0 = Math.max(A[0].t, B[0].t);
  const t1 = Math.min(A[A.length - 1].t, B[B.length - 1].t);
  if (!(t1 - t0 > 1e-4)) return [];
  const ts = [];
  const da = [];
  const ma = [];
  const mb = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + ((t1 - t0) * k) / n;
    const a = polylineAt(A, t);
    const b = polylineAt(B, t);
    ts.push(t);
    ma.push(a);
    mb.push(b);
    da.push(a - b);
  }
  // Split points: exact crossings found by linear interpolation of d(t) / 교차점 (선형 보간)
  const cuts = [{ k: 0, t: t0, edge: true }];
  for (let k = 1; k <= n; k++) {
    const d0 = da[k - 1];
    const d1 = da[k];
    if (d0 === 0 && k - 1 > 0) continue;
    if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0) || d1 === 0) {
      const f = d1 === 0 ? 1 : d0 / (d0 - d1);
      const t = ts[k - 1] + f * (ts[k] - ts[k - 1]);
      if (t - cuts[cuts.length - 1].t > 1e-6 && t < t1 - 1e-6) cuts.push({ k, t, edge: false });
    }
  }
  cuts.push({ k: n + 1, t: t1, edge: true });
  const lobes = [];
  for (let c = 0; c < cuts.length - 1; c++) {
    const a = cuts[c];
    const b = cuts[c + 1];
    const t = [a.t];
    const lo = [];
    const hi = [];
    const at = (tt) => {
      const x = polylineAt(A, tt);
      const y = polylineAt(B, tt);
      return [Math.min(x, y), Math.max(x, y)];
    };
    let [l, h] = at(a.t);
    lo.push(l);
    hi.push(h);
    for (let k = a.k; k < b.k && k <= n; k++) {
      if (ts[k] <= a.t + 1e-9 || ts[k] >= b.t - 1e-9) continue;
      t.push(ts[k]);
      lo.push(Math.min(ma[k], mb[k]));
      hi.push(Math.max(ma[k], mb[k]));
    }
    [l, h] = at(b.t);
    t.push(b.t);
    lo.push(l);
    hi.push(h);
    let area = 0;
    for (let k = 1; k < t.length; k++) area += 0.5 * ((hi[k] - lo[k]) + (hi[k - 1] - lo[k - 1])) * (t[k] - t[k - 1]);
    if (area < minArea) continue;
    lobes.push(decimateBand({ t, lo, hi, t0: a.t, t1: b.t, closed: !a.edge && !b.edge, area }));
  }
  return lobes;
}

/** Keep at most `max` samples of a band (JSON-friendly). / 띠 샘플 수 제한 */
export function decimateBand(band, max = 160) {
  const N = band.t.length;
  if (N <= max) return { ...band, t: band.t.map(r4), lo: band.lo.map(r4), hi: band.hi.map(r4) };
  const idx = [];
  for (let k = 0; k < max; k++) idx.push(Math.round((k * (N - 1)) / (max - 1)));
  return { ...band, t: idx.map((i) => r4(band.t[i])), lo: idx.map((i) => r4(band.lo[i])), hi: idx.map((i) => r4(band.hi[i])) };
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Soft membership of (t, m) in a band: 1 deep inside, 0 outside, ramps over `edgeSemi`
 * semitones and `edgeSec` seconds near the border (no clicks). / 띠 포함도 (경계 부드럽게)
 */
export function bandWeight(band, t, m, { edgeSemi = 0.5, edgeSec = 0.02 } = {}) {
  const ts = band.t;
  if (!ts || ts.length < 2 || t <= ts[0] || t >= ts[ts.length - 1]) return 0;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - ts[lo]) / Math.max(1e-12, ts[hi] - ts[lo]);
  const l = band.lo[lo] + f * (band.lo[hi] - band.lo[lo]);
  const h = band.hi[lo] + f * (band.hi[hi] - band.hi[lo]);
  const depth = Math.min(m - l, h - m);
  if (depth <= 0) return 0;
  const tDepth = Math.min(t - ts[0], ts[ts.length - 1] - t);
  return clamp(depth / edgeSemi, 0, 1) * clamp(tDepth / edgeSec, 0, 1);
}

/** Membership of (t, m) in any lobe of a shape region. / 영역 포함도 */
export function shapeWeight(region, t, m) {
  if (t < region.t0 || t > region.t1) return 0;
  let w = 0;
  for (const b of region.lobes || []) w = Math.max(w, bandWeight(b, t, m));
  return w;
}

/**
 * Pitch mask of one instance from the shape regions: (cycleSec, midi) → gain 0…1, or null when no
 * shape region affects it. / 인스턴스의 음고 마스크 (영향 없으면 null)
 */
export function buildShapeMask(instId, regions) {
  const hits = (regions || []).filter((r) => r.kind === 'shape' && (r.mute.includes(instId) || (r.solo.length && !r.solo.includes(instId))));
  if (!hits.length) return null;
  return (t, m) => {
    let g = 1;
    for (const r of hits) g = Math.min(g, 1 - shapeWeight(r, t, m));
    return g;
  };
}

/** Stable key of the shape regions that affect an instance (for render caching). */
export function shapeMaskKey(instId, regions) {
  return JSON.stringify((regions || []).filter((r) => r.kind === 'shape' && (r.mute.includes(instId) || (r.solo.length && !r.solo.includes(instId)))).map((r) => [r.id, r.lobes, r.solo, r.mute]));
}

/** Sanitize a saved band. / 저장된 띠 정규화 */
export function normalizeBand(b) {
  if (!b || !Array.isArray(b.t) || b.t.length < 2) return null;
  const n = Math.min(b.t.length, b.lo?.length || 0, b.hi?.length || 0);
  if (n < 2) return null;
  const num = (arr) => arr.slice(0, n).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0));
  const t = num(b.t);
  return { t, lo: num(b.lo), hi: num(b.hi), t0: t[0], t1: t[n - 1], closed: !!b.closed, area: Number(b.area) || 0 };
}

// ==========================================================================
// Self-check / 자가진단
// ==========================================================================

registerSelfCheck('Shape select: enclosed lobes between two curves, soft mask', (a) => {
  // A = sine around 60, B = flat 60 → crossings at every half period / 사인과 직선
  const A = [];
  const B = [];
  for (let k = 0; k <= 200; k++) {
    const t = (k / 200) * 4;
    A.push({ t, m: 60 + 6 * Math.sin(Math.PI * t) });
    B.push({ t, m: 60 });
  }
  const lobes = computeEnclosedLobes(A, B);
  a.equal(lobes.length, 4, `4 lobes (${lobes.length})`);
  a.equal(lobes.filter((l) => l.closed).length, 2, 'two closed, two capped by the ends');
  a.near(lobes[1].t0, 1, 0.01, 'crossing at t = 1');
  a.near(lobes[1].area, 12 / Math.PI, 0.05, 'area ∫|6 sin πt| over one half period');
  const r = { kind: 'shape', t0: 1, t1: 2, lobes: [lobes[1]], solo: [], mute: ['x'] };
  a.ok(shapeWeight(r, 1.5, 57) > 0.99, 'deep inside');
  a.equal(shapeWeight(r, 1.5, 61), 0, 'outside in pitch');
  a.equal(shapeWeight(r, 0.5, 57), 0, 'outside in time');
  const mask = buildShapeMask('x', [r]);
  a.ok(mask(1.5, 57) < 0.01 && mask(1.5, 70) === 1, 'mute mask');
  a.equal(buildShapeMask('y', [r]), null, 'unaffected instance');
  const solo = buildShapeMask('y', [{ ...r, mute: [], solo: ['x'] }]);
  a.ok(solo && solo(1.5, 57) < 0.01, 'solo silences others inside');
  a.ok(normalizeBand(lobes[0]) && normalizeBand({ t: [1] }) === null, 'band normalisation');
}, { group: 'state' });
