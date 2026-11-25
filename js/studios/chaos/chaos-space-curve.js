/**
 * Flexatone — studios/chaos/chaos-space-curve.js
 * Layer 2 (studios): Chaos as a source of **space curves** for Space (space/space-curve-link.js).
 * Read-only: the phase-space trajectory (x, y, z) of every voice over song time, straight from the
 * stage-A bake (cached by the trajectory signature) — nothing in Chaos is changed.
 * 계층 2 (studios): 카오스를 스페이스의 **공간 곡선** 원본으로 (읽기 전용). 보이스마다 위상 공간
 * 궤적 (x, y, z)을 곡 시간에 따라 — 1단계 베이킹 그대로.
 *
 * Imported once at start-up (main.js); it registers itself.
 */

import { bakeChaosTrajectories } from './chaos-engine.js';
import { normalizeChaosDoc } from '../chaos-studio.js';
import { registerSpaceCurveSource } from '../space/space-curve-link.js';

const MAX_POINTS = 2400;

registerSpaceCurveSource('chaos', {
  curves(doc) {
    const d = normalizeChaosDoc(doc);
    const A = bakeChaosTrajectories(d);
    const out = [];
    A.voices.forEach((v, i) => {
      const { x, y, z } = v.src;
      if (!x || !y || !z || v.diverged) return;
      const n = x.length;
      const step = Math.max(1, Math.ceil(n / MAX_POINTS));
      const pts = [];
      for (let j = 0; j < n; j += step) pts.push({ x: x[j], y: y[j], z: z[j], t: A.songSec(j) });
      if (pts.length >= 2) out.push({ key: `c${i}`, name: `Chaos ${i + 1} (x, y, z)`, pts });
    });
    return out;
  },
});
