/**
 * Flexatone — audio/projection-parity.js
 * Layer 3 (audio): checks that what a studio *projects* onto the Master grid (studios/projection.js) is what
 * it actually *sounds like* — the contract is only worth anything if the picture equals the audio.
 * 계층 3 (audio): 투영(그림)이 실제 소리와 같은지 대조하는 자가진단.
 */

import { appState, registerSelfCheck } from '../core/state.js';
import { freqToMidi } from '../core/units.js';
import { splitRates } from '../core/tempo.js';
import { applyTempoToVoices } from '../modules/tempo-manager.js';
import { projectStudio, validatePath, retime, pitchesAt, monotonePieces, hasProjection, projectionKind, listProjections } from '../studios/projection.js';
import { renderOfflineBuffer } from './audio-engine.js';
import { rissetPaths } from '../studios/projections.js';
import { createDefaultRissetParams } from '../studios/risset/risset-core.js';

/** Zero-crossing pitch (MIDI) of `sec` seconds starting at `t0`; NaN when unclear. */
function measuredMidi(buf, t0, sec) {
  const d = buf.getChannelData(0);
  const sr = buf.sampleRate;
  const a = Math.floor(t0 * sr);
  const n = Math.floor(sec * sr);
  let c = 0;
  let first = -1;
  let last = -1;
  for (let i = a + 1; i < a + n && i < d.length; i++) {
    if (d[i - 1] <= 0 && d[i] > 0) { c++; if (first < 0) first = i; last = i; }
  }
  return c > 1 ? freqToMidi(((c - 1) * sr) / (last - first)) : NaN;
}

registerSelfCheck('Projection ↔ audio: Glissando path = rendered pitch (document time map)', async (a) => {
  const voices = appState.voices.filter((v) => !v.muted && v.duration > 0.2).slice(0, 1);
  a.ok(voices.length === 1, 'a voice to compare');
  const base = projectStudio('glissando', null).find((p) => p.key === voices[0].id);
  a.ok(base, 'glissando projects its voice');
  // Document time map of the Manager: the `doc` part of splitRates() is rendered into the document (pitch kept); whatever
  // `tape` part remains is a playbackRate in the mixer and is not in the render, so it is not compared here.
  for (const cfg of [{ rate: 1 }, { rate: 2 }, { rate: 0.5 }, { rate: 1.5 }]) {
    const sp = splitRates(cfg);
    const buf = await renderOfflineBuffer({ voices: applyTempoToVoices(voices, sp.doc), sampleRate: 48000 });
    const heard = retime(base, { rate: sp.doc }); // what the render contains / 렌더에 담긴 것
    const [t0, t1] = [heard.pts[0].t, heard.pts[heard.pts.length - 1].t];
    let worst = 0;
    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      const t = t0 + f * (t1 - t0);
      worst = Math.max(worst, Math.abs(measuredMidi(buf, t - 0.02, 0.04) - pitchesAt([heard], t)[0].m) * 100);
    }
    a.ok(worst < 15, `${JSON.stringify(cfg)}: worst ${worst.toFixed(1)} cents`);
    a.ok(buf.duration >= t1 - 1e-3, `render covers the projected line (${buf.duration.toFixed(2)} s ≥ ${t1.toFixed(2)} s)`);
  }
}, { group: 'audio' });

registerSelfCheck('Projection: every studio projects valid paths on its default document', (a) => {
  const report = [];
  for (const studio of listProjections()) {
    const paths = projectStudio(studio, null);
    for (const p of paths) {
      const bad = validatePath(p);
      if (bad.length) report.push(`${studio}/${p.key}: ${bad.join(', ')}`);
    }
  }
  a.equal(report.join('; '), '', 'all projected paths obey the contract');
  a.ok(listProjections().length >= 9, `studios with a projection: ${listProjections().join(', ')}`);
  a.equal(projectionKind('risset'), 'projection', 'Risset has its own projection');
  a.equal(projectionKind('glissando'), 'projection', 'Glissando projects what is heard');
  a.equal(projectionKind('field'), 'projection', 'Field projects what is heard');
  a.equal(projectionKind('draw'), 'projection', 'clip studios project through their adapters');
  a.ok(hasProjection('risset'), 'registered');
}, { group: 'studio' });

registerSelfCheck('Projection: Risset phase space is cut at the wraps and stays on the circle', (a) => {
  const doc = { voiceCount: 6, rateHz: 0.2 };
  const paths = rissetPaths(doc, { bakeSec: 6, rate: 30 });
  a.ok(paths.length > 6, `wraps create more pieces than voices (${paths.length} pieces)`);
  a.ok(paths.every((p) => p.domain === 'phase'), 'domain = phase');
  const span = createDefaultRissetParams().spanSemitones;
  const lo = Math.min(...paths.flatMap((p) => p.pts.map((q) => q.m)));
  const hi = Math.max(...paths.flatMap((p) => p.pts.map((q) => q.m)));
  a.ok(hi - lo <= span + 1e-6, `pitches stay inside the span (${(hi - lo).toFixed(1)} of ${span} st)`);
  const worstStep = Math.max(...paths.flatMap((p) => p.pts.slice(1).map((q, k) => Math.abs(q.m - p.pts[k].m))));
  a.ok(worstStep < span / 2, `no piece jumps across the circle (largest step ${worstStep.toFixed(2)} st)`);
  a.ok(paths.every((p) => monotonePieces(p.pts).length === 1), 'every piece is already monotone in time');
  a.ok(paths.every((p) => validatePath(p).length === 0), 'valid');
  // the same document projects identically twice (deterministic) / 결정적
  const again = rissetPaths(doc, { bakeSec: 6, rate: 30 });
  a.equal(again.length, paths.length, 'deterministic piece count');
}, { group: 'studio' });
