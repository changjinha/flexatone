/**
 * Flexatone — studios/projections.js
 * Layer 2 (studios, pure): registers the studios' own projections (studios/projection.js). Studios that can
 * Send a line need nothing here — they are projected through their Send source. Only a studio whose
 * Master picture is NOT its Send line registers itself.
 * 계층 2 (studios, 순수): 자체 투영 등록. Send 선이 있는 스튜디오는 여기에 등록할 필요 없음.
 *
 *   Glissando · Field — what is HEARD: only audible voices / particles (solo and mute honoured), densely sampled. A
 *            Send line, in contrast, offers every voice. Their Master View pictures used to live in ui/manager-panel.js.
 *   Risset — phase space (S¹): every voice is a point on the circle, pitch = base + span · phase. Its Master
 *            picture is the voices' sawtooth paths cut at the wraps (`simulateSegments`), as `domain: 'phase'`.
 *            Send offers no line for Risset ("an endless field has no line"), so this is its only path source.
 */

import { registerProjection } from './projection.js';
import { clamp } from '../core/math-utils.js';
import { getVoiceFreqAtNormT } from '../modules/curve-engine.js';
import { filterAudibleVoices } from '../modules/gain-bus.js';
import { freqToMidi } from '../core/units.js';
import { StudioRegistry } from './registry.js';
import { getBakedMap, isParticleAudible } from './field-studio.js';
import { lookupBakedSample, lookupBakedSampleExt } from './field/vector-field-engine.js';
import { createDefaultRissetParams, sanitizeRissetParams, simulateSegments } from './risset/risset-core.js';

/**
 * Risset voices as wrap-cut paths in document seconds. `opts`: bakeSec (default 8), rate (Hz, default 40).
 * Deterministic (fixed rng, dynamics read their pre-integrated cache). 리세 보이스를 래핑에서 끊은 경로
 */
export function rissetPaths(doc, { bakeSec = 8, rate = 40 } = {}) {
  const params = sanitizeRissetParams({ ...createDefaultRissetParams(), ...(doc && typeof doc === 'object' ? doc : {}) });
  const segs = simulateSegments(params, { bakeSec, rate });
  return segs.map((seg, k) => {
    const n = seg.midi.length;
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ t: n > 1 ? seg.t0 + ((seg.t1 - seg.t0) * i) / (n - 1) : seg.t0, m: seg.midi[i], a: Math.min(1, Math.max(0, seg.amp[i])) });
    return { key: `v${seg.voice}_${k}`, name: `Voice ${seg.voice + 1}`, domain: 'phase', pts };
  });
}

registerProjection('risset', { domain: 'phase', paths: (doc, opts) => rissetPaths(doc, opts) });

/** Glissando: audible voices, adaptive sampling (24–240 points per voice). / 들리는 보이스만 */
registerProjection('glissando', {
  paths: (doc) => filterAudibleVoices(doc?.voices || []).filter((v) => v.duration > 0.002).map((v) => {
    const n = clamp(Math.ceil(v.duration * 40), 24, 240);
    const pts = [];
    for (let k = 0; k <= n; k++) pts.push({ t: v.startTime + (k / n) * v.duration, m: freqToMidi(getVoiceFreqAtNormT(v, k / n)) });
    return { key: v.id, name: v.name, color: v.color, pts };
  }),
});

/** Field: audible particles as baked (the baked trajectory is cached by physics signature). / 들리는 입자 */
registerProjection('field', {
  paths(doc) {
    const plugin = StudioRegistry.get('field');
    const params = { ...(plugin ? plugin.defaultParams() : {}), ...(doc && typeof doc === 'object' ? doc : {}) };
    const baked = getBakedMap(params);
    const out = [];
    for (const v of params.voices || []) {
      if (!isParticleAudible(v, params) || v.duration <= 0.02) continue;
      const ptsB = baked.get(v.id);
      const pts = [];
      // only the played range (core/line-clip.js) / 재생 구간만
      const u0 = Number.isFinite(v.clip?.u0) ? v.clip.u0 : 0;
      const u1 = Number.isFinite(v.clip?.u1) ? v.clip.u1 : 1;
      for (let k = 0; k <= 120; k++) {
        const f = u0 + ((u1 - u0) * k) / 120;
        pts.push({ t: v.startTime + f * v.duration, m: v.f0Midi + lookupBakedSampleExt(v, ptsB, f).y * (v.f1Midi - v.f0Midi) });
      }
      out.push({ key: v.id, name: v.name || v.id, color: v.color, pts });
    }
    return out;
  },
});
