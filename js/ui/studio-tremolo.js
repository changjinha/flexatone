/**
 * Flexatone — ui/studio-tremolo.js
 * Layer 4 (ui): the studio output tremolo rack, shared by the studios whose tremolo acts on their
 * whole output (Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave — the same arrangement as Risset).
 * Glissando and Field keep their per-voice / per-particle tremolo.
 * 계층 4 (ui): 출력 전체에 걸리는 스튜디오 트레몰로 랙 (드로잉·클라우드·스페이스·템포·카오스·프랙탈·웨이브 공용,
 * 리세와 같은 방식). 글리산도·필드는 보이스·입자별 트레몰로를 유지.
 *
 * It also adds the per-voice "Voice tremolo · vibrato" block (ui/voice-mod-rack.js, `doc.voiceMod`) above it.
 * The config is the shared tremolo object (core/tremolo-config.js) stored as `doc.tremolo`; the sound
 * comes from the LFO backend (audio/studio-fx.js), live and in WAV export alike.
 */

import { normalizeTremolo } from '../core/tremolo-config.js';
import { el } from './panels.js';
import { createTremoloHost } from './tremolo-panel.js';
import { createVoiceModRack } from './voice-mod-rack.js';

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

/**
 * @param {{ get: () => object, edit: (fn: (doc: object) => void, opts: { coalesceKey: string|null }) => void }} binding
 *   get  → the studio document (its `tremolo` field is read)
 *   edit → the studio's edit function (e.g. editFractal)
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createStudioTremoloRack(binding) {
  const root = el('section', { class: SECTION, dataset: { rack: 'studio-tremolo' } });
  const host = createTremoloHost(root, {
    get: () => binding.get()?.tremolo,
    edit: (fn, k) => binding.edit((d) => { d.tremolo = normalizeTremolo(d.tremolo); fn(d.tremolo); d.tremolo = normalizeTremolo(d.tremolo); }, { coalesceKey: k || null }),
    duration: () => 2,
    envelope: () => null,
    hintKey: 'trem.hintRisset',
    features: { sweep: false, fade: false, sync: false }, // LFO backend: free-running, no sweep / fade-in / 자유 진행 LFO
  });
  // The per-voice tremolo / vibrato block goes right above the output tremolo (every studio using this rack)
  // 보이스별 트레몰로·비브라토 블록을 출력 트레몰로 바로 위에 (이 랙을 쓰는 모든 스튜디오)
  const vmod = createVoiceModRack({ get: binding.get, edit: binding.edit, studio: binding.studio || 'studio' });
  const frag = document.createDocumentFragment();
  frag.append(vmod.root, root);
  return { root: frag, sync: () => { vmod.sync(); host.sync(); } };
}
