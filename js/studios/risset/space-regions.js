/**
 * Flexatone — studios/risset/space-regions.js
 * Risset Studio (pure): region modules on the (time × phase) trail space, each with its own pitch
 * range, speed and rotation, and the sounding-point solver used by the green "now" line.
 * 리세 스튜디오 (순수): 궤적 공간(시간 × 위상) 위의 영역 모듈 — 모듈마다 음고 범위·속도·회전을
 * 갖고, 초록 "현재" 선과 교차하는 발음점을 계산.
 *
 * Space / 공간
 *   A region r owns a master phase φᵣ(τ) (τ = seconds relative to now; linked regions use the
 *   global φ). Voice i traces yᵢ(τ) = φᵣ(τ) + offᵢ/span (unwrapped; copies at every integer = S¹).
 *   Space coordinates are (a, y) with a = τ / T (T = time scale, seconds per phase unit).
 *   The region's space is rotated by θ about the pivot (0, c) (c = rotation center phase).
 *   The green line is screen a = 0; screen phase s ∈ [lo, hi] maps back to space as
 *     a(s) = (s − c)·sin θ,   y(s) = c + (s − c)·cos θ
 *   Voice i sounds at every s where φᵣ(T·a(s)) + offᵢ/span − y(s) crosses an integer.
 *   θ = 0 ⇒ exactly the un-rotated field (s = voice phase).  θ = 180° ⇒ mirrored (up ↔ down).
 *   Amplitude = A_global(s) · A_local,i · regionGain · edgeFade(s).
 * Rotation angle θ(t) = angle + spin·t + swing·sin(2π t / swingPeriod)   (degrees)
 * No DOM. No imports from risset-core (the caller passes φᵣ(τ)).
 */

import { clamp, roundTo } from '../../core/math-utils.js';

export const MAX_REGIONS = 6;
/** Max simultaneous sounding points (oscillator slots). / 최대 동시 발음점 */
export const MAX_SLOTS = 128;
/** Match distance (phase) for keeping a sounding point on the same slot. / 슬롯 유지 거리 */
const MATCH_DIST = 0.12;
/** A freed slot is reused only after it has faded for this long (s). / 슬롯 재사용 대기 */
const SLOT_COOLDOWN = 0.06;
const DEG = Math.PI / 180;

/** Voice layouts of a region (first = default). / 영역 보이스 배치 */
export const REGION_LAYOUTS = Object.freeze(['pitch', 'fit', 'window']);

export const REGION_COLORS = Object.freeze(['#34d399', '#f472b6', '#60a5fa', '#fbbf24', '#a78bfa', '#f87171']);

let regionSeq = 0;

/** Default region module (full range, linked to the global v, not rotated). / 기본 영역 모듈 */
export function createDefaultRegion(patch = {}) {
  regionSeq += 1;
  return {
    id: `r${Date.now().toString(36)}${regionSeq}`,
    enabled: true,
    lo: 0,
    hi: 1,
    edge: 0.04,
    gain: 1,
    // voice layout / 보이스 배치:
    //   'pitch' (default) = the region is its own field: base MIDI = its bottom, span = its height in semitones;
    //           the voices and the harmonic grid are laid out in that span (intervals stay in semitones)
    //   'fit'   = the whole ring squeezed into lo…hi (every offset scaled by the region's share of the span)
    //   'window'= a window onto the shared ring over the whole range (only the voices passing through sound)
    //   'pitch'(기본) = 영역 자체가 음장: 기준 MIDI = 아래 끝, 스팬 = 높이(반음); 보이스·화성 격자를 그 스팬에 배치
    //   'fit' = 전체 고리를 lo…hi에 압축, 'window' = 전체 고리를 보는 창
    layout: 'pitch',
    // with 'pitch': the Core's Base MIDI / Span show and edit this region (else they are locked) / 코어 MIDI·스팬 동기화
    syncCore: true,
    linkRate: true,
    rateHz: 0.03,
    rotOn: false,
    rotAngleDeg: 0,
    rotSpinDegPerSec: 0,
    rotSwingDeg: 0,
    rotSwingSec: 8,
    rotCenterAuto: true,
    rotCenter: 0.5,
    timeScaleSec: 6,
    ...patch,
  };
}

/** Clamp/repair the region list (always ≥ 1 region). / 영역 목록 정규화 */
export function sanitizeRegions(raw) {
  const list = Array.isArray(raw) && raw.length ? raw.slice(0, MAX_REGIONS) : [createDefaultRegion()];
  const seen = new Set();
  return list.map((r0) => {
    const d = createDefaultRegion();
    const r = { ...d, ...(r0 && typeof r0 === 'object' ? r0 : {}) };
    if (typeof r.id !== 'string' || !r.id || seen.has(r.id)) r.id = d.id;
    seen.add(r.id);
    r.enabled = r.enabled !== false;
    r.layout = REGION_LAYOUTS.includes(r.layout) ? r.layout : 'pitch';
    r.syncCore = r.syncCore !== false;
    r.solo = r.solo === true; // S / M of the region (risset-core regionAudible) / 영역 솔로·뮤트
    r.mute = r.mute === true;
    const a = clamp(Number(r.lo), 0, 1);
    const b = clamp(Number(r.hi), 0, 1);
    r.lo = Number.isFinite(a) ? a : 0;
    r.hi = Number.isFinite(b) ? b : 1;
    if (r.hi < r.lo) [r.lo, r.hi] = [r.hi, r.lo];
    if (r.hi - r.lo < 0.01) r.hi = Math.min(1, r.lo + 0.01);
    r.edge = clamp(Number(r.edge) || 0, 0, 0.5);
    r.gain = clamp(Number.isFinite(Number(r.gain)) ? Number(r.gain) : 1, 0, 2);
    r.linkRate = r.linkRate !== false;
    r.rateHz = clamp(Number(r.rateHz) || 0, -1, 1);
    r.rotOn = !!r.rotOn;
    r.rotAngleDeg = clamp(Number(r.rotAngleDeg) || 0, -360, 360);
    r.rotSpinDegPerSec = clamp(Number(r.rotSpinDegPerSec) || 0, -180, 180);
    r.rotSwingDeg = clamp(Number(r.rotSwingDeg) || 0, 0, 180);
    r.rotSwingSec = clamp(Number(r.rotSwingSec) || 8, 0.25, 120);
    r.rotCenterAuto = r.rotCenterAuto !== false;
    r.rotCenter = clamp(Number.isFinite(Number(r.rotCenter)) ? Number(r.rotCenter) : 0.5, 0, 1);
    r.timeScaleSec = clamp(Number(r.timeScaleSec) || 6, 0.25, 120);
    return r;
  });
}

/** One full-range, linked, un-rotated, unity-gain region ⇒ the classic field. / 기존 음장과 동일 */
export function isClassicField(regions) {
  if (!regions || regions.length !== 1) return false;
  const r = regions[0];
  return r.enabled && !r.mute && r.lo <= 0 && r.hi >= 1 && r.linkRate && !r.rotOn && Math.abs(r.gain - 1) < 1e-9;
}

export const regionCenter = (r) => (r.rotCenterAuto ? 0.5 * (r.lo + r.hi) : r.rotCenter);

/** Fresh per-region runtime state. / 영역 런타임 */
export function createRegionState() {
  return { phase: 0, shapeTimeSec: 0, spinDeg: 0, swingTimeSec: 0, angleDeg: 0 };
}

/** Current rotation angle (degrees) of a region; 0 when rotation is off. / 현재 회전각 */
export function regionAngleDeg(r, st) {
  if (!r.rotOn) return 0;
  const swing = r.rotSwingDeg ? r.rotSwingDeg * Math.sin((2 * Math.PI * st.swingTimeSec) / r.rotSwingSec) : 0;
  return r.rotAngleDeg + st.spinDeg + swing;
}

/** Advance the rotation clocks. / 회전 시계 진행 */
export function stepRegionRotation(r, st, dt) {
  if (r.rotOn) {
    st.spinDeg = ((st.spinDeg + r.rotSpinDegPerSec * dt) % 360 + 360) % 360;
    st.swingTimeSec += dt;
  }
  st.angleDeg = regionAngleDeg(r, st);
}

/** Soft edge fade inside [lo, hi] (only on interior edges). / 범위 가장자리 페이드 */
export function edgeFade(r, s) {
  if (s < r.lo - 1e-9 || s > r.hi + 1e-9) return 0;
  const e = r.edge;
  if (e <= 0) return 1;
  let g = 1;
  if (r.lo > 0) g = Math.min(g, clamp((s - r.lo) / e, 0, 1));
  if (r.hi < 1) g = Math.min(g, clamp((r.hi - s) / e, 0, 1));
  return 0.5 - 0.5 * Math.cos(Math.PI * g);
}

/** Screen → space mapping of the green line: s ↦ (τ, y). / 초록 선의 공간 좌표 */
export function lineToSpace(r, angleDeg, s) {
  const c = regionCenter(r);
  const th = angleDeg * DEG;
  const d = s - c;
  return { tau: d * Math.sin(th) * r.timeScaleSec, y: c + d * Math.cos(th) };
}

/** Space (τ, y) → screen (τ_screen, s) under rotation θ about (0, c). / 공간 → 화면 */
export function spaceToScreen(r, angleDeg, tau, y) {
  const c = regionCenter(r);
  const th = angleDeg * DEG;
  const a = tau / r.timeScaleSec;
  const d = y - c;
  return { tau: (a * Math.cos(th) - d * Math.sin(th)) * r.timeScaleSec, s: c + a * Math.sin(th) + d * Math.cos(th) };
}

/** Screen (τ_screen, s) → space (τ, y). / 화면 → 공간 */
export function screenToSpace(r, angleDeg, tau, s) {
  const c = regionCenter(r);
  const th = angleDeg * DEG;
  const a = tau / r.timeScaleSec;
  const d = s - c;
  return { tau: (a * Math.cos(th) + d * Math.sin(th)) * r.timeScaleSec, y: c - a * Math.sin(th) + d * Math.cos(th) };
}

/** True when the region spreads its voices over itself (layout 'fit', the default). / 영역 안 고른 배치 */
export const regionFit = (r) => r.layout !== 'window';

/** Region space coordinate of a normalized voice phase y′ (fit: lo + (hi − lo)·y′). / 정규화 위상 → 영역 공간 */
export const regionY = (r, y) => (regionFit(r) ? r.lo + (r.hi - r.lo) * y : y);

/**
 * Sounding points of one region on the green line.
 * @param {object} r region
 * @param {number} angleDeg current rotation
 * @param {(tau:number)=>number} phiAt unwrapped region phase at relative time τ (phiAt(0) = φᵣ now)
 * @param {ArrayLike<number>} offs voice offsets as phase (offᵢ/span)
 * @param {number} N voice count
 * @returns {Array<{ voice:number, s:number }>}
 * 영역 하나의 발음점 (보이스, 화면 위상).
 */
export function regionCrossings(r, angleDeg, phiAt, offs, N) {
  const out = [];
  const a = ((angleDeg % 360) + 360) % 360;
  const fit = regionFit(r);
  const w = Math.max(1e-6, r.hi - r.lo);
  if (Math.abs(a) < 1e-9 || Math.abs(a - 360) < 1e-9) {
    // Un-rotated: the voice phase itself (fit: squeezed into lo…hi, every voice inside) / 회전 없음
    const phi = phiAt(0);
    for (let i = 0; i < N; i++) {
      const u = (((phi + offs[i]) % 1) + 1) % 1;
      const s = fit ? r.lo + w * u : u;
      if (s >= r.lo && s <= r.hi) out.push({ voice: i, s });
    }
    return out;
  }
  const M = Math.max(24, Math.ceil(220 * (r.hi - r.lo)));
  const ss = new Float64Array(M + 1);
  const hh = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) {
    const s = r.lo + ((r.hi - r.lo) * k) / M;
    const { tau, y } = lineToSpace(r, angleDeg, s);
    ss[k] = s;
    hh[k] = phiAt(tau) - (fit ? (y - r.lo) / w : y); // fit: the region's own normalized space / 영역 자체 정규화 공간
  }
  for (let i = 0; i < N; i++) {
    const o = offs[i];
    let g0 = hh[0] + o;
    for (let k = 1; k <= M; k++) {
      const g1 = hh[k] + o;
      const n0 = Math.floor(g0);
      const n1 = Math.floor(g1);
      if (n0 !== n1) {
        // Every integer between g0 and g1 is one crossing / 사이의 정수마다 교차 1개
        const lo = Math.min(n0, n1) + 1;
        const hi = Math.max(n0, n1);
        for (let n = lo; n <= hi && n - lo < 4; n++) {
          const u = (n - g0) / (g1 - g0);
          out.push({ voice: i, s: ss[k - 1] + u * (ss[k] - ss[k - 1]) });
        }
      }
      g0 = g1;
    }
  }
  return out;
}

/**
 * Assign sounding points to persistent slots (nearest-phase match per (region, voice)).
 * Slot: { active, region, voice, s, amp, gain (= amp without A_global), vel (dp/dt), idle, fresh }.  Unmatched slots go inactive (amp 0) and
 * keep their pitch while they fade; new points take a slot that has been idle ≥ cooldown.
 * 발음점을 지속 슬롯에 배정 (영역·보이스별 최근접 매칭).
 */
export function assignSlots(slots, points, dt) {
  for (const sl of slots) { sl.fresh = false; sl.matched = false; }
  const byKey = new Map();
  slots.forEach((sl, idx) => {
    if (!sl.active) return;
    const k = `${sl.region}:${sl.voice}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(idx);
  });
  const pending = [];
  for (const pt of points) {
    const cands = byKey.get(`${pt.region}:${pt.voice}`);
    let best = -1;
    let bestD = MATCH_DIST;
    if (cands) for (const idx of cands) {
      const sl = slots[idx];
      if (sl.matched) continue;
      const d = Math.abs(sl.s - pt.s);
      if (d < bestD) { bestD = d; best = idx; }
    }
    if (best >= 0) {
      const sl = slots[best];
      sl.matched = true;
      // dp/dt: exact when the caller knows it, else a finite difference / 속도: 주어지면 그대로, 아니면 차분
      sl.vel = pt.vel !== undefined ? pt.vel : dt > 0 ? (pt.s - sl.s) / dt : 0;
      sl.s = pt.s;
      sl.amp = pt.amp;
      sl.gain = pt.gain !== undefined ? pt.gain : pt.amp;
    } else pending.push(pt);
  }
  for (const sl of slots) {
    if (sl.active && !sl.matched) { sl.active = false; sl.amp = 0; sl.idle = 0; }
    else if (!sl.active) sl.idle += dt;
  }
  for (const pt of pending) {
    let idx = slots.findIndex((sl) => !sl.active && !sl.matched && sl.idle >= SLOT_COOLDOWN);
    if (idx < 0) {
      if (slots.length >= MAX_SLOTS) continue;
      slots.push({ active: false, region: 0, voice: 0, s: 0, amp: 0, gain: 0, vel: 0, idle: 0, fresh: false, matched: false });
      idx = slots.length - 1;
    }
    Object.assign(slots[idx], { active: true, matched: true, fresh: true, region: pt.region, voice: pt.voice, s: pt.s, amp: pt.amp, gain: pt.gain !== undefined ? pt.gain : pt.amp, vel: pt.vel !== undefined ? pt.vel : 0, idle: 0 });
  }
  return slots;
}

/** Pivot readout for the UI. / UI 표시용 */
export const formatAngle = (deg) => `${roundTo(((deg % 360) + 540) % 360 - 180, 1)}°`;
