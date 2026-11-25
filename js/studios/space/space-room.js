/**
 * Flexatone — studios/space/space-room.js
 * Layer 2 (studios, pure): the **room** of a Space scene — early reflections as image sources and
 * the impulse response of a diffuse reverb. HOA carries direction only; the sense of distance comes
 * from the ratio of direct sound to reflections / reverb and from the arrival times of the reflections.
 * 계층 2 (studios, 순수): 스페이스 장면의 **방** — 영상 음원으로 만든 초기 반사와 확산 잔향의 임펄스 응답.
 * HOA는 방향만 담고, 거리감은 직접음 대 반사·잔향의 비율과 반사의 도착 시간에서 나옴.
 *
 * Room (document field `room`, absent = everything off) / 방
 *   { quality: 'off' | 'ground' | 'first' | 'second',
 *     floorZ, w, d, h, cx, cy,            box: x ∈ cx ± w/2, y ∈ cy ± d/2, z ∈ [floorZ, floorZ + h]
 *     absorb: { floor, ceil, xn, xp, yn, yp }   energy absorption α per surface (0 = mirror, 1 = dead)
 *     hfHz,                                low-pass of one bounce (two bounces: half of it)
 *     reverb: { on, rt60, level, predelay, damp, seed, law: 'physical' | 'follow' } }
 *
 * Image sources / 영상 음원
 *   'ground' — one image: the source mirrored in the floor plane (an open field).
 *   'first'  — the six first-order images of the box.
 *   'second' — plus the 18 second-order images (12 over two perpendicular surfaces, 6 over two
 *              opposite ones): 24 images per source.
 *   An image is a source of its own: mirrored position and velocity, baked through the same
 *   retarded-time solver, so every reflection has its own delay, Doppler shift, direction, distance
 *   law and air absorption. Its level is multiplied by β = √(1 − α) per bounce.
 *   영상은 별개의 음원: 위치·속도를 거울 반사해 같은 지연 시간 솔버로 베이킹 (반사마다 지연·도플러·방향·거리 법칙).
 *   A source outside the box has no box reflections: they fade out over 1 m beyond a wall.
 *
 * Signature / 시그니처: the reflections belong to the bake (geometry, absorption, hfHz); the reverb
 * (length, level, seed) is sound only and never re-bakes.
 *
 * Imports: core/*, space-engine.js.
 */

import { clamp, createSeededRandom } from '../../core/math-utils.js';
import { bakeSource, getKinematics, spaceSignature } from './space-engine.js';

export const ROOM_QUALITIES = Object.freeze(['off', 'ground', 'first', 'second']);
export const REVERB_LAWS = Object.freeze(['physical', 'follow']);
export const SURFACES = Object.freeze(['floor', 'ceil', 'xn', 'xp', 'yn', 'yp']);
export const ROOM_MAX_IMAGE_BAKES = 600; // sources × images baked at most (cost guard) / 영상 베이킹 상한

const num = (x, d) => (Number.isFinite(Number(x)) ? Number(x) : d);

export function createRoom(over = {}) {
  return {
    quality: 'off', floorZ: 0, w: 60, d: 80, h: 12, cx: 0, cy: 0,
    absorb: { floor: 0.3, ceil: 0.5, xn: 0.4, xp: 0.4, yn: 0.4, yp: 0.4 },
    hfHz: 6000,
    reverb: { on: false, rt60: 1.8, level: 0.25, predelay: 0.02, damp: 0.5, seed: 1, law: 'physical' },
    ...over,
  };
}

/** Fill / clamp a room (new object). / 방 보정 */
export function normalizeRoom(raw) {
  const d = createRoom();
  const s = raw && typeof raw === 'object' ? raw : {};
  const r = s.reverb && typeof s.reverb === 'object' ? s.reverb : {};
  const absorb = {};
  for (const k of SURFACES) absorb[k] = clamp(num(s.absorb?.[k], d.absorb[k]), 0, 1);
  return {
    quality: ROOM_QUALITIES.includes(s.quality) ? s.quality : 'off',
    floorZ: clamp(num(s.floorZ, 0), -500, 500),
    w: clamp(num(s.w, d.w), 2, 2000),
    d: clamp(num(s.d, d.d), 2, 2000),
    h: clamp(num(s.h, d.h), 2, 1000),
    cx: clamp(num(s.cx, 0), -1000, 1000),
    cy: clamp(num(s.cy, 0), -1000, 1000),
    absorb,
    hfHz: clamp(num(s.hfHz, d.hfHz), 300, 20000),
    reverb: {
      on: !!r.on,
      rt60: clamp(num(r.rt60, d.reverb.rt60), 0.1, 12),
      level: clamp(num(r.level, d.reverb.level), 0, 2),
      predelay: clamp(num(r.predelay, d.reverb.predelay), 0, 0.5),
      damp: clamp(num(r.damp, d.reverb.damp), 0, 1),
      seed: Math.max(0, Math.round(num(r.seed, 1))),
      law: REVERB_LAWS.includes(r.law) ? r.law : 'physical',
    },
  };
}

/** The room of a document (everything off when it has none). / 문서의 방 (없으면 모두 꺼짐) */
export const roomOf = (doc) => normalizeRoom(doc?.room);
export const roomActive = (doc) => { const r = doc?.room; return !!r && (ROOM_QUALITIES.includes(r.quality) && r.quality !== 'off' || !!r.reverb?.on); };
/** What the reflections depend on (part of the bake). / 반사가 의존하는 것 (베이킹의 일부) */
export const roomGeometryKey = (room) => (room.quality === 'off' ? 'off' : JSON.stringify([room.quality, room.floorZ, room.quality === 'ground' ? room.absorb.floor : [room.w, room.d, room.h, room.cx, room.cy, room.absorb], room.hfHz]));

/** The six surfaces of the box as mirror planes. / 상자의 여섯 면 */
export function roomPlanes(room) {
  return {
    floor: { axis: 'z', at: room.floorZ }, ceil: { axis: 'z', at: room.floorZ + room.h },
    xn: { axis: 'x', at: room.cx - room.w / 2 }, xp: { axis: 'x', at: room.cx + room.w / 2 },
    yn: { axis: 'y', at: room.cy - room.d / 2 }, yp: { axis: 'y', at: room.cy + room.d / 2 },
  };
}

/**
 * Image sources of a room: [{ key, planes: [{ axis, at }], beta, bounces, box }].
 * `planes` are applied in order; `beta` = amplitude factor of the bounces.
 * 방의 영상 음원 목록. planes는 순서대로 적용, beta는 반사의 진폭 계수.
 */
export function roomImages(rawRoom) {
  const room = normalizeRoom(rawRoom);
  if (room.quality === 'off') return [];
  const P = roomPlanes(room);
  const beta = (k) => Math.sqrt(1 - room.absorb[k]);
  if (room.quality === 'ground') return [{ key: 'floor', planes: [P.floor], beta: beta('floor'), bounces: 1, box: false }].filter((im) => im.beta > 1e-6);
  const out = SURFACES.map((k) => ({ key: k, planes: [P[k]], beta: beta(k), bounces: 1, box: true }));
  if (room.quality === 'second') {
    const opposite = { floor: 'ceil', ceil: 'floor', xn: 'xp', xp: 'xn', yn: 'yp', yp: 'yn' };
    for (let i = 0; i < SURFACES.length; i++) for (let j = 0; j < SURFACES.length; j++) {
      const a = SURFACES[i], b = SURFACES[j];
      if (a === b) continue;
      const parallel = opposite[a] === b;
      if (!parallel && j < i) continue; // perpendicular surfaces: both orders give the same image / 수직인 면은 순서와 무관
      out.push({ key: `${a}+${b}`, planes: [P[a], P[b]], beta: beta(a) * beta(b), bounces: 2, box: true });
    }
  }
  return out.filter((im) => im.beta > 1e-6);
}

/** A state mirrored in a list of planes (position and velocity). / 평면들에 거울 반사한 상태 */
export function mirrorState(st, planes) {
  const o = { ...st };
  for (const p of planes) {
    o[p.axis] = 2 * p.at - o[p.axis];
    const v = `v${p.axis}`;
    o[v] = -o[v];
  }
  return o;
}

/** How far a point is outside the box (0 inside). / 상자 밖으로 나간 거리 (안이면 0) */
export function outsideDistance(room, p) {
  const dx = Math.max(0, Math.abs(p.x - room.cx) - room.w / 2);
  const dy = Math.max(0, Math.abs(p.y - room.cy) - room.d / 2);
  const dz = Math.max(0, room.floorZ - p.z, p.z - (room.floorZ + room.h));
  return Math.hypot(dx, dy, dz);
}

const cache = new Map();
let bakes = 0;
/** Number of real image bakes so far (diagnostics). / 실제 영상 베이킹 횟수 */
export const getRoomBakeCount = () => bakes;

/**
 * Bake the image sources of every source (memoised by physics signature + room geometry).
 * @returns {{ sig, images: Map<sourceId, [{ key, bounces, beta, bake }]>, count, ms, outside: string[], capped }}
 * 모든 음원의 영상 음원 베이킹 (물리 시그니처 + 방 기하로 캐시).
 */
export function bakeRoom(doc) {
  const room = roomOf(doc);
  const sig = `${spaceSignature(doc)}|room${roomGeometryKey(room)}`;
  const hit = cache.get(sig);
  if (hit) return hit;
  const t0 = globalThis.performance?.now() ?? Date.now();
  const list = roomImages(room);
  const images = new Map();
  const outside = [];
  let count = 0;
  let capped = false;
  for (const s of doc.sources || []) {
    const kin = getKinematics(s, doc);
    const mine = [];
    let out = false;
    for (const im of list) {
      if (count >= ROOM_MAX_IMAGE_BAKES) { capped = true; break; }
      const mkin = { ...kin, sig: `${kin.sig}|img:${im.key}`, stateAt: (tau) => mirrorState(kin.stateAt(tau), im.planes), rRange: null, poly: null };
      const b = bakeSource(s, doc, mkin);
      const cut = room.hfHz / im.bounces;
      for (let i = 0; i < b.n; i++) {
        let g = im.beta;
        if (im.box) { // no box reflection from a source beyond the walls: fade over 1 m / 벽 밖의 음원은 반사 없음 (1 m에 걸쳐 감쇠)
          const far = outsideDistance(room, kin.stateAt(b.te[i] - kin.start));
          if (far > 0) { out = true; g *= clamp(1 - far, 0, 1); }
        }
        b.gain[i] *= g;
        if (b.lp[i] > cut) b.lp[i] = cut;
      }
      mine.push({ key: im.key, bounces: im.bounces, beta: im.beta, bake: b });
      count++;
      bakes++;
    }
    images.set(s.id, mine);
    if (out) outside.push(s.id);
  }
  const res = Object.freeze({ sig, images, count, ms: (globalThis.performance?.now() ?? Date.now()) - t0, outside, capped });
  cache.set(sig, res);
  if (cache.size > 4) cache.delete(cache.keys().next().value);
  return res;
}

/** Latest end (listener time) of every image of the audible sources. / 영상까지 포함한 끝 시각 */
export function roomEndSec(doc, audibleIds) {
  if (roomOf(doc).quality === 'off') return 0;
  const rb = bakeRoom(doc);
  let end = 0;
  for (const id of audibleIds) for (const im of rb.images.get(id) || []) end = Math.max(end, im.bake.t1);
  return end;
}

// --------------------------------------------------------------------------
// Diffuse reverb: a generated impulse response / 확산 잔향: 생성한 임펄스 응답
// --------------------------------------------------------------------------

/** Seconds of reverb tail that are rendered after the scene. / 장면 뒤에 렌더하는 잔향 꼬리 */
export const reverbTailSec = (room) => (room.reverb.on && room.reverb.level > 0 ? room.reverb.predelay + Math.min(12, room.reverb.rt60 * 1.1) : 0);

/**
 * Impulse responses of the reverb: `channels` decorrelated channels of exponentially decaying
 * noise (−60 dB after rt60), damped by a one-pole low-pass, each normalised to unit energy.
 * Deterministic: the same seed, rate and settings give the same samples.
 * 잔향 임펄스 응답: 지수 감쇠 잡음 (rt60에 −60 dB), 1극 저역 통과로 감쇠, 채널마다 에너지 1로 정규화. 시드 결정론.
 * @returns {Float32Array[]}
 */
export function reverbImpulse({ rt60 = 1.8, predelay = 0.02, damp = 0.5, seed = 1 } = {}, sampleRate = 48000, channels = 2) {
  const pre = Math.round(clamp(predelay, 0, 0.5) * sampleRate);
  const len = Math.max(64, Math.round(clamp(rt60, 0.1, 12) * 1.1 * sampleRate));
  const k = Math.log(1000) / (clamp(rt60, 0.1, 12) * sampleRate); // amplitude e^(−k n): −60 dB at rt60 / rt60에서 −60 dB
  const fc = 20000 * Math.pow(0.06, clamp(damp, 0, 1)); // damp 0 → 20 kHz, 1 → 1.2 kHz
  const a = Math.exp((-2 * Math.PI * Math.min(fc, sampleRate * 0.49)) / sampleRate);
  const out = [];
  for (let c = 0; c < channels; c++) {
    const rand = createSeededRandom((Math.round(seed) + 1) * 7919 + c * 104729);
    const x = new Float32Array(pre + len);
    let lp = 0;
    let e = 0;
    for (let n = 0; n < len; n++) {
      const w = 2 * rand() - 1;
      lp = (1 - a) * w + a * lp;
      const v = lp * Math.exp(-k * n);
      x[pre + n] = v;
      e += v * v;
    }
    const s = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let n = pre; n < x.length; n++) x[n] *= s;
    out.push(x);
  }
  return out;
}

/** RT60 of an impulse response from the slope of its Schroeder decay (−5 … −35 dB). / 슈뢰더 감쇠 기울기로 구한 RT60 */
export function measureRt60(x, sampleRate) {
  const n = x.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += x[i] * x[i]; edc[i] = acc; }
  if (!(acc > 0)) return NaN;
  const db = (i) => 10 * Math.log10(edc[i] / acc);
  let i5 = -1, i35 = -1;
  for (let i = 0; i < n; i++) { const v = db(i); if (i5 < 0 && v <= -5) i5 = i; if (v <= -35) { i35 = i; break; } }
  if (i5 < 0 || i35 <= i5) return NaN;
  return (60 * (i35 - i5)) / (30 * sampleRate);
}
