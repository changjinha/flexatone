/**
 * Flexatone — audio/send-sources.js
 * Layer 3 (audio): what every studio offers as a line to **Send** (studios/trajectory-link.js). Read-only:
 * no document is changed, no sound is made. Each source gets the studio's (instance) document and returns
 * pitch lines in document seconds: [{ key, name, color?, pts: [{ t, m }] }]. Keys must stay stable while
 * the document is edited (a send keeps pointing at the same line).
 * 계층 3 (audio): 스튜디오마다 보낼 수 있는 선 (읽기 전용). 키는 편집해도 바뀌지 않아야 함.
 *
 *   Glissando  voices (registered in trajectory-link.js)
 *   Field      particles as heard (baked)                       key = particle id
 *   Draw       strokes (pieces of one stroke joined)            key = stroke id
 *   Cloud      the pitch-centre curve c(t) — not the grains     key = 'centre'
 *   Chaos · Tempo · Fractal · Space · Wave  the baked lines of the Master View
 *   Risset     none (an endless field has no line)
 *   Every studio with two lines or more also offers 'mean' (trajectory-link.js).
 */

import { appState } from '../core/state.js';
import { registerTrajectorySource } from '../studios/trajectory-link.js';
import '../studios/projections.js'; // own projections (Risset phase space) / 자체 투영
import './clip-projections.js'; // clip studios' projections / 클립 스튜디오 투영
import './projection-parity.js'; // projection ↔ audio self-checks
import { clipStudioLines, resolveClipParams } from './studio-clips.js';
import { lookupBakedSample } from '../studios/field/field-audio.js';
import { getBakedMap, isParticleAudible, getFieldParams } from '../studios/field-studio.js';
import { getCloudParams } from '../studios/cloud-studio.js';
import { evalCloudCurve } from '../studios/cloud/cloud-engine.js';

/** Run `fn` with `doc` standing in for the studio's editor document (synchronous). / 문서를 잠시 교체 */
function withDoc(studio, doc, fn) {
  const prev = appState.studioParams;
  if (doc === (prev || {})[studio]) return fn();
  const sp = { ...(prev || {}) };
  if (doc && typeof doc === 'object') sp[studio] = doc;
  else delete sp[studio];
  appState.studioParams = sp;
  try {
    return fn();
  } finally {
    appState.studioParams = prev;
  }
}

const clipLines = (studio) => ({ lines: (doc) => clipStudioLines(studio, resolveClipParams(studio, doc)) || [] });

for (const studio of ['chaos', 'tempo', 'fractal', 'space', 'wave']) registerTrajectorySource(studio, clipLines(studio));

registerTrajectorySource('draw', {
  lines(doc) {
    const byStroke = new Map();
    for (const l of clipStudioLines('draw', resolveClipParams('draw', doc)) || []) {
      const id = String(l.key).replace(/_\d+$/, ''); // `${stroke.id}_${k}` → stroke id / 스트로크 id
      if (!byStroke.has(id)) byStroke.set(id, { key: id, name: l.name, pts: [] });
      const acc = byStroke.get(id);
      if (acc.pts.length) acc.pts.push({ t: l.pts[0]?.t, m: NaN }); // gap between pieces / 조각 사이 틈
      acc.pts.push(...l.pts);
    }
    return [...byStroke.values()];
  },
});

registerTrajectorySource('cloud', {
  lines(doc) {
    const p = withDoc('cloud', doc, () => getCloudParams());
    const n = 160;
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push({ t: (i / n) * p.length, m: evalCloudCurve(p.pitch.center, i / n, 'center') });
    return [{ key: 'centre', name: 'Centre c(t)', pts }];
  },
});

registerTrajectorySource('field', {
  lines(doc) {
    const params = withDoc('field', doc, () => getFieldParams());
    const baked = getBakedMap(params);
    return (params.voices || []).filter((v) => isParticleAudible(v, params) && v.duration > 0.02).map((v) => {
      const bp = baked.get(v.id);
      const pts = [];
      if (bp) {
        const n = 120;
        for (let i = 0; i < n; i++) {
          const frac = i / (n - 1);
          pts.push({ t: v.startTime + frac * v.duration, m: v.f0Midi + lookupBakedSample(v, bp, frac).y * (v.f1Midi - v.f0Midi) });
        }
      }
      return { key: v.id, name: v.name || v.id, color: v.color, pts };
    });
  },
});
