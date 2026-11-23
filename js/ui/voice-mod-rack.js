/**
 * Flexatone — ui/voice-mod-rack.js
 * Layer 4 (ui): the "Voice tremolo · vibrato" block shared by the studios (core/voice-mod.js `voiceMod`):
 * every voice gets its own rate / depth / phase (seeded randomizer) and the rate can follow the frequency
 * band. Risset has the same controls in its own panel (risset-panels.js buildVoiceMod).
 * 계층 4 (ui): 스튜디오 공용 "보이스 트레몰로 · 비브라토" 블록. 리세는 자체 패널에 같은 컨트롤.
 */

import { t, I18N } from '../core/i18n.js';
import { endHistoryGesture } from '../core/state.js';
import { normalizeVoiceMod, VMOD_RATE_MIN, VMOD_RATE_MAX, VMOD_CENTS_MAX, VMOD_TRACK_MAX } from '../core/voice-mod.js';
import { el } from './panels.js';
import { createStudioControls, STUDIO_BTN } from './studio-controls.js';
import { HELP_DB } from './option-inspector.js';

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

Object.assign(I18N.en, {
  'vmod.title': 'Voice tremolo · vibrato',
  'vmod.hint': 'Per voice, unlike the output tremolo: every voice gets its own rate, depth and phase (seeded). Band follow makes the rate follow the voice\'s pitch.',
  'vmod.trem': 'Tremolo', 'vmod.vib': 'Vibrato', 'vmod.rate': 'Rate', 'vmod.depth': 'Depth', 'vmod.cents': 'Depth',
  'vmod.spread': 'Randomize', 'vmod.track': 'Band follow', 'vmod.seed': 'Seed', 'vmod.reroll': '🎲 New random',
});
Object.assign(I18N.ko, {
  'vmod.title': '보이스 트레몰로 · 비브라토',
  'vmod.hint': '출력 트레몰로와 달리 보이스별: 보이스마다 속도·깊이·위상이 다릅니다(시드). 대역 추종은 속도가 보이스 음고를 따라가게 합니다.',
  'vmod.trem': '트레몰로', 'vmod.vib': '비브라토', 'vmod.rate': '속도', 'vmod.depth': '깊이', 'vmod.cents': '깊이',
  'vmod.spread': '랜덤화', 'vmod.track': '대역 추종', 'vmod.seed': '시드', 'vmod.reroll': '🎲 새 랜덤',
});

// Per-slider help: the same texts as Risset's (risset.vmod.*), under studio-neutral keys / 리세와 같은 설명
for (const k of ['tremRate', 'tremDepth', 'tremSpread', 'tremTrack', 'vibRate', 'vibCents', 'vibSpread', 'vibTrack', 'seed']) {
  Object.defineProperty(HELP_DB, `vmod.${k}`, { configurable: true, enumerable: true, get: () => HELP_DB[`risset.vmod.${k}`] });
}
HELP_DB.vmod = {
  en: { title: 'Voice tremolo · vibrato', summary: 'Amplitude (tremolo) and pitch (vibrato) modulation applied to every voice separately, each with its own rate, depth and phase.', detail: 'The output tremolo below acts on the whole sound with one LFO; this one is per voice, so the texture shimmers instead of pulsing as a block. Band follow: the rate rises (+) or falls (−) with the voice\'s pitch — a looping automation cannot do this, because the voices are at different pitches at the same moment. Heard live and in WAV export (curves baked into each voice).', formula: '' },
  ko: { title: '보이스 트레몰로 · 비브라토', summary: '보이스마다 따로 거는 진폭(트레몰로)·음고(비브라토) 변조. 보이스별 속도·깊이·위상.', detail: '아래 출력 트레몰로는 전체 소리에 LFO 하나, 이것은 보이스별이라 덩어리로 맥동하지 않고 반짝이듯 흔들립니다. 대역 추종: 보이스 음고에 따라 속도가 오름(+)/내림(−) — 같은 순간 보이스마다 음고가 달라 루핑 오토메이션으로는 불가능. 실시간과 WAV 내보내기에 적용(각 보이스 곡선에 반영).', formula: '' },
};

/**
 * @param {{ get: () => object, edit: (fn: (doc: object) => void, opts: { coalesceKey: string|null }) => void, studio: string }} binding
 *   get → the studio document (its `voiceMod` is read), edit → the studio's edit function
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createVoiceModRack(binding) {
  const syncers = [];
  const commit = () => endHistoryGesture();
  const V = () => normalizeVoiceMod(binding.get()?.voiceMod);
  const editV = (fn, ck = null) => binding.edit((d) => { d.voiceMod = normalizeVoiceMod(d.voiceMod); fn(d.voiceMod); }, { coalesceKey: ck });
  const { slider } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help) => `${binding.studio}:vmod:${help}` });
  const onBtn = (lane) => {
    const b = el('button', { class: STUDIO_BTN, dataset: { help: 'vmod' }, on: { click: () => { editV((m) => { m[lane].on = !m[lane].on; }); commit(); } } });
    syncers.push(() => { const on = V()[lane].on; b.textContent = `${on ? '●' : '○'} ${t(`vmod.${lane}`)}`; b.classList.toggle('bg-cyan-700', on); b.classList.toggle('border-cyan-400', on); });
    return b;
  };
  const setL = (lane, k) => (val, ck) => editV((m) => { m[lane][k] = val; }, ck);
  const lane = (key, depthKey, depthMax, depthStep, accent) => {
    const box = el('div', { class: 'flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2 min-w-0' }, [
      onBtn(key),
      slider('vmod.rate', `vmod.${key}Rate`, () => V()[key].rate, setL(key, 'rate'), { min: VMOD_RATE_MIN, max: Math.min(20, VMOD_RATE_MAX), step: 0.05, unit: 'Hz', accent, def: key === 'trem' ? 5 : 5.5 }),
      slider(`vmod.${depthKey}`, `vmod.${key}${depthKey === 'depth' ? 'Depth' : 'Cents'}`, () => V()[key][depthKey], setL(key, depthKey), { min: 0, max: depthMax, step: depthStep, unit: depthKey === 'cents' ? '¢' : '', accent, def: depthKey === 'cents' ? 25 : 0.5 }),
      slider('vmod.spread', `vmod.${key}Spread`, () => V()[key].spread, setL(key, 'spread'), { min: 0, max: 1, step: 0.01, accent, def: 0.5 }),
      slider('vmod.track', `vmod.${key}Track`, () => V()[key].track, setL(key, 'track'), { min: -VMOD_TRACK_MAX, max: VMOD_TRACK_MAX, step: 0.05, unit: 'oct', accent, def: 0 }),
    ]);
    syncers.push(() => box.classList.toggle('opacity-60', !V()[key].on));
    return box;
  };
  const seedLbl = el('span', { class: 'font-mono text-[10px] text-slate-400', dataset: { help: 'vmod.seed' } });
  syncers.push(() => { seedLbl.textContent = `${t('vmod.seed')} ${V().seed}`; });
  const reroll = el('button', { class: STUDIO_BTN, dataset: { help: 'vmod.seed' }, text: t('vmod.reroll'), on: { click: () => { editV((m) => { m.seed = (m.seed * 7919 + 104729) % 99991 || 1; }); commit(); } } });
  const root = el('section', { class: SECTION, dataset: { rack: 'voice-mod', help: 'vmod' } }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('vmod.title') }),
      el('div', { class: 'flex items-center gap-2' }, [seedLbl, reroll]),
    ]),
    el('p', { class: 'text-[10.5px] text-slate-400 leading-snug', text: t('vmod.hint') }),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2' }, [lane('trem', 'depth', 1, 0.01, 'accent-cyan'), lane('vib', 'cents', VMOD_CENTS_MAX, 1, 'accent-violet')]),
  ]);
  return { root, sync: () => syncers.forEach((fn) => fn()) };
}
