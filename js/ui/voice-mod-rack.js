/**
 * Flexatone — ui/voice-mod-rack.js
 * Layer 4 (ui): the "Voice tremolo · vibrato" block shared by every studio, Risset included
 * (core/voice-mod.js `voiceMod`): every voice gets its own rate / depth / phase (seeded randomizer)
 * and the rate can follow the frequency band. "Advanced randomizer" (a checkbox, folded by default)
 * splits the randomizer into rate / depth / phase spreads, picks a distribution, adds a slow rate
 * drift and turns band follow into an envelope over the band.
 * 계층 4 (ui): 모든 스튜디오(리세 포함) 공용 "보이스 트레몰로 · 비브라토" 블록. "고급 랜덤화" 체크박스
 * (기본 접힘)를 켜면 속도·깊이·위상 분산, 분포, 느린 속도 표류, 대역 추종 포락선이 열립니다.
 */

import { t, I18N } from '../core/i18n.js';
import { endHistoryGesture } from '../core/state.js';
import { normalizeVoiceMod, trackToEnv, envAt, VMOD_RATE_MIN, VMOD_RATE_MAX, VMOD_CENTS_MAX, VMOD_TRACK_MAX } from '../core/voice-mod.js';
import { el } from './panels.js';
import { createStudioControls, STUDIO_BTN } from './studio-controls.js';
import { HELP_DB } from './option-inspector.js';

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

Object.assign(I18N.en, {
  'vmod.title': 'Voice tremolo · vibrato',
  'vmod.hint': 'Per voice, unlike the output tremolo: every voice gets its own rate, depth and phase (seeded). Band follow makes the rate follow the voice\'s pitch.',
  'vmod.trem': 'Tremolo', 'vmod.vib': 'Vibrato', 'vmod.rate': 'Rate', 'vmod.depth': 'Depth', 'vmod.cents': 'Depth',
  'vmod.spread': 'Randomize', 'vmod.track': 'Band follow', 'vmod.seed': 'Seed', 'vmod.reroll': '🎲 New random',
  'vmod.adv': 'Advanced randomizer',
  'vmod.rateSpread': 'Rate spread', 'vmod.depthSpread': 'Depth spread', 'vmod.phaseSpread': 'Phase spread',
  'vmod.dist': 'Distribution', 'vmod.dist.uniform': 'Even', 'vmod.dist.center': 'Centred', 'vmod.dist.split': 'Two groups',
  'vmod.drift': 'Rate drift', 'vmod.env': 'Band follow envelope (oct)', 'vmod.envLo': 'low', 'vmod.envHi': 'high',
  'vmod.envReset': '↺ From slider', 'vmod.envFlat': '— Flat',
});
Object.assign(I18N.ko, {
  'vmod.title': '보이스 트레몰로 · 비브라토',
  'vmod.hint': '출력 트레몰로와 달리 보이스별: 보이스마다 속도·깊이·위상이 다릅니다(시드). 대역 추종은 속도가 보이스 음고를 따라가게 합니다.',
  'vmod.trem': '트레몰로', 'vmod.vib': '비브라토', 'vmod.rate': '속도', 'vmod.depth': '깊이', 'vmod.cents': '깊이',
  'vmod.spread': '랜덤화', 'vmod.track': '대역 추종', 'vmod.seed': '시드', 'vmod.reroll': '🎲 새 랜덤',
  'vmod.adv': '고급 랜덤화',
  'vmod.rateSpread': '속도 분산', 'vmod.depthSpread': '깊이 분산', 'vmod.phaseSpread': '위상 분산',
  'vmod.dist': '분포', 'vmod.dist.uniform': '고르게', 'vmod.dist.center': '중심 집중', 'vmod.dist.split': '두 무리',
  'vmod.drift': '속도 표류', 'vmod.env': '대역 추종 포락선 (옥타브)', 'vmod.envLo': '저역', 'vmod.envHi': '고역',
  'vmod.envReset': '↺ 슬라이더 값으로', 'vmod.envFlat': '— 평탄',
});

// Per-slider help: the simple sliders share Risset's texts (risset.vmod.*) under studio-neutral keys / 리세와 같은 설명
for (const k of ['tremRate', 'tremDepth', 'tremSpread', 'tremTrack', 'vibRate', 'vibCents', 'vibSpread', 'vibTrack', 'seed']) {
  Object.defineProperty(HELP_DB, `vmod.${k}`, { configurable: true, enumerable: true, get: () => HELP_DB[`risset.vmod.${k}`] || HELP_DB.vmod });
}
const H = (en, ko) => ({ en: { title: en[0], summary: en[1], detail: en[2] || '', formula: en[3] || '' }, ko: { title: ko[0], summary: ko[1], detail: ko[2] || '', formula: '' } });
HELP_DB.vmod = H(['Voice tremolo · vibrato', 'Amplitude (tremolo) and pitch (vibrato) modulation applied to every voice separately, each with its own rate, depth and phase.', 'The output tremolo acts on the whole sound with one LFO; this one is per voice, so the texture shimmers instead of pulsing as a block. Band follow: the rate rises (+) or falls (−) with the voice\'s pitch — a looping automation cannot do this, because the voices are at different pitches at the same moment. Heard live and in WAV export.'],
  ['보이스 트레몰로 · 비브라토', '보이스마다 따로 거는 진폭(트레몰로)·음고(비브라토) 변조. 보이스별 속도·깊이·위상.', '출력 트레몰로는 전체 소리에 LFO 하나, 이것은 보이스별이라 덩어리로 맥동하지 않고 반짝이듯 흔들립니다. 대역 추종: 보이스 음고에 따라 속도가 오름(+)/내림(−) — 같은 순간 보이스마다 음고가 달라 루핑 오토메이션으로는 불가능. 실시간과 WAV 내보내기에 적용.']);
HELP_DB['vmod.adv'] = H(['Advanced randomizer', 'Tick to open: separate spreads for rate, depth and phase, the shape of the random draw, a slow drift of each voice\'s rate, and band follow drawn as an envelope.', 'Untick to go back to the two simple sliders (Randomize, Band follow) — the advanced values are kept for next time. Same in every studio.'],
  ['고급 랜덤화', '체크하면 열림: 속도·깊이·위상 분산을 따로, 난수 분포, 보이스 속도의 느린 표류, 대역 추종을 포락선으로.', '체크를 끄면 단순 슬라이더 두 개(랜덤화, 대역 추종)로 돌아가며, 고급 값은 다음을 위해 보관됩니다. 모든 스튜디오 동일.']);
HELP_DB['vmod.rateSpread'] = H(['Rate spread (oct)', 'How far each voice\'s rate is scattered: ×2^(spread·u), u = the voice\'s random number. 1 = up to one octave faster or slower.', '', 'rateᵢ = rate · 2^(spread·D(u))'], ['속도 분산 (옥타브)', '보이스별 속도가 흩어지는 폭: ×2^(분산·u). 1 = 최대 한 옥타브 빠르거나 느리게.']);
HELP_DB['vmod.depthSpread'] = H(['Depth spread', 'How much the depth differs between voices: some voices get up to this fraction less depth (1 = some voices do not modulate at all).', '', 'depthᵢ = depth · (1 − ½·spread·(1 + u))'], ['깊이 분산', '보이스마다 깊이가 다른 정도: 일부 보이스는 최대 이 비율만큼 덜 흔들림 (1 = 전혀 흔들리지 않는 보이스도 생김).']);
HELP_DB['vmod.phaseSpread'] = H(['Phase spread', '0 = every voice starts its cycle together (they pulse in step); 1 = starting phases fully scattered.', ''], ['위상 분산', '0 = 모든 보이스가 같은 위상에서 시작 (함께 맥동), 1 = 시작 위상 완전 분산.']);
HELP_DB['vmod.dist'] = H(['Distribution', 'Shape of the random rate draw. Even: rates spread evenly. Centred (u³): most voices close to the base rate, a few outliers. Two groups: half the voices at the fast edge, half at the slow edge.', ''], ['분포', '속도 난수의 모양. 고르게: 고르게 분산. 중심 집중(u³): 대부분 기본 속도 근처, 몇몇만 멀리. 두 무리: 절반은 빠른 끝, 절반은 느린 끝.']);
HELP_DB['vmod.drift'] = H(['Rate drift', 'Each voice\'s rate wanders slowly (about every 7–20 s), by up to ±50 % at 1, each voice on its own course — the modulation never settles into a fixed pattern.', '', 'rate(t) = rateᵢ · (1 + ½·drift·sin 2π(fᵈt + φᵈ))'], ['속도 표류', '보이스마다 속도가 천천히(약 7–20초 주기) 흔들림, 1에서 최대 ±50 %, 보이스별로 제각각 — 변조가 고정된 패턴으로 굳지 않음.']);
HELP_DB['vmod.env'] = H(['Band follow envelope', 'Rate offset in octaves across the frequency band: left = lowest voices, right = highest. Drag a point; click empty space to add one; double-click a point to remove it.', 'Replaces the Band follow slider while the advanced randomizer is on. ↺ rebuilds it from the slider (a straight line), — Flat sets it to 0.'],
  ['대역 추종 포락선', '주파수 대역에 따른 속도 오프셋(옥타브): 왼쪽 = 가장 낮은 보이스, 오른쪽 = 가장 높은 보이스. 점을 끌어 이동, 빈 곳 클릭 = 점 추가, 점 더블클릭 = 삭제.', '고급 랜덤화가 켜져 있는 동안 대역 추종 슬라이더를 대신합니다. ↺는 슬라이더 값(직선)으로 다시 만들고, — 평탄은 0으로.']);

/**
 * Band-follow envelope editor: x = band place (0 low … 1 high), y = −3 … +3 octaves.
 * 대역 추종 포락선 편집기.
 */
function envEditor({ get, set, accent }) {
  const cv = el('canvas', { class: 'w-full h-[72px] rounded border border-slate-800 bg-slate-950 block cursor-crosshair', dataset: { help: 'vmod.env' } });
  const Y = VMOD_TRACK_MAX;
  const toPx = (p, w, h) => [4 + p.x * (w - 8), h / 2 - (p.y / Y) * (h / 2 - 6)];
  const draw = () => {
    const r = cv.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(40, Math.round(r.width));
    const h = Math.max(30, Math.round(r.height));
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#1e293b';
    g.lineWidth = 1;
    for (let k = -Y; k <= Y; k++) { const y = h / 2 - (k / Y) * (h / 2 - 6); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = '#334155';
    g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    const pts = get();
    g.strokeStyle = accent;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let i = 0; i <= 64; i++) { const b = i / 64; const [x, y] = toPx({ x: b, y: envAt(pts, b) }, w, h); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke();
    g.fillStyle = accent;
    for (const p of pts) { const [x, y] = toPx(p, w, h); g.beginPath(); g.arc(x, y, 3.5, 0, 2 * Math.PI); g.fill(); }
    g.fillStyle = '#64748b';
    g.font = '9px ui-monospace, monospace';
    g.fillText(`+${Y}`, 2, 9);
    g.fillText(`−${Y}`, 2, h - 2);
    g.fillText(t('vmod.envLo'), 14, h / 2 - 3);
    const hi = t('vmod.envHi');
    g.fillText(hi, w - 6 - g.measureText(hi).width, h / 2 - 3);
  };
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left - 4) / Math.max(1, r.width - 8))), y: Math.min(Y, Math.max(-Y, -((e.clientY - r.top - r.height / 2) / Math.max(1, r.height / 2 - 6)) * Y)), r };
  };
  const hit = (e) => {
    const { r } = at(e);
    const pts = get();
    let best = -1;
    let bd = 9;
    pts.forEach((p, i) => { const [x, y] = toPx(p, r.width, r.height); const d = Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top)); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  let dragI = -1;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let i = hit(e);
    const p = at(e);
    if (i < 0) { // add a point / 점 추가
      const pts = [...get(), { x: p.x, y: p.y }].sort((a, b) => a.x - b.x);
      i = pts.findIndex((q) => q.x === p.x && q.y === p.y);
      set(pts, 'vmod:env');
    }
    dragI = i;
    try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragI < 0) return;
    const p = at(e);
    const pts = get().map((q) => ({ ...q }));
    if (!pts[dragI]) return;
    const lo = dragI > 0 ? pts[dragI - 1].x : 0;
    const hi = dragI < pts.length - 1 ? pts[dragI + 1].x : 1;
    pts[dragI] = { x: Math.min(hi, Math.max(lo, p.x)), y: Math.round(p.y * 20) / 20 };
    set(pts, 'vmod:env');
  });
  const end = () => { if (dragI >= 0) { dragI = -1; endHistoryGesture(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (e) => {
    const i = hit(e);
    const pts = get();
    if (i < 0 || pts.length <= 2) return;
    set(pts.filter((_, k) => k !== i), null);
    endHistoryGesture();
  });
  return { root: cv, draw };
}

/**
 * @param {{ get: () => object, edit: (fn: (doc: object) => void, opts: { coalesceKey: string|null }) => void, studio: string, rack?: string, help?: string }} binding
 *   get → the studio document (its `voiceMod` is read), edit → the studio's edit function
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createVoiceModRack(binding) {
  const syncers = [];
  const commit = () => endHistoryGesture();
  const V = () => normalizeVoiceMod(binding.get()?.voiceMod);
  const editV = (fn, ck = null) => binding.edit((d) => { d.voiceMod = normalizeVoiceMod(d.voiceMod); fn(d.voiceMod); }, { coalesceKey: ck });
  const { slider, segment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help) => `${binding.studio}:vmod:${help}:${label}` });
  const onBtn = (lane) => {
    const b = el('button', { class: STUDIO_BTN, dataset: { help: 'vmod' }, on: { click: () => { editV((m) => { m[lane].on = !m[lane].on; }); commit(); } } });
    syncers.push(() => { const on = V()[lane].on; b.textContent = `${on ? '●' : '○'} ${t(`vmod.${lane}`)}`; b.classList.toggle('bg-cyan-700', on); b.classList.toggle('border-cyan-400', on); });
    return b;
  };
  const setL = (lane, k) => (val, ck) => editV((m) => { m[lane][k] = val; }, ck);
  const showIf = (node, fn) => { syncers.push(() => node.classList.toggle('hidden', !fn())); return node; };
  const lane = (key, depthKey, depthMax, depthStep, accent, color) => {
    const env = envEditor({
      accent: color,
      get: () => { const L = V()[key]; return L.env || trackToEnv(L.track); },
      set: (pts, ck) => editV((m) => { m[key].env = pts; }, ck),
    });
    syncers.push(() => { if (V().adv) requestAnimationFrame(env.draw); });
    const envBtns = el('div', { class: 'flex items-center gap-1' }, [
      el('button', { class: `${STUDIO_BTN} !text-[10px] !px-1.5 !py-0.5`, dataset: { help: 'vmod.env' }, text: t('vmod.envReset'), on: { click: () => { editV((m) => { m[key].env = trackToEnv(m[key].track); }); commit(); } } }),
      el('button', { class: `${STUDIO_BTN} !text-[10px] !px-1.5 !py-0.5`, dataset: { help: 'vmod.env' }, text: t('vmod.envFlat'), on: { click: () => { editV((m) => { m[key].env = [{ x: 0, y: 0 }, { x: 1, y: 0 }]; }); commit(); } } }),
    ]);
    const adv = showIf(el('div', { class: 'flex flex-col gap-1.5 border-t border-slate-800 pt-1.5' }, [
      slider('vmod.rateSpread', 'vmod.rateSpread', () => V()[key].rateSpread, setL(key, 'rateSpread'), { min: 0, max: 2, step: 0.01, unit: 'oct', accent, def: 0.5 }),
      slider('vmod.depthSpread', 'vmod.depthSpread', () => V()[key].depthSpread, setL(key, 'depthSpread'), { min: 0, max: 1, step: 0.01, accent, def: 0.25 }),
      slider('vmod.phaseSpread', 'vmod.phaseSpread', () => V()[key].phaseSpread, setL(key, 'phaseSpread'), { min: 0, max: 1, step: 0.01, accent, def: 0.5 }),
      el('div', { class: 'flex flex-col gap-0.5', dataset: { help: 'vmod.dist' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('vmod.dist') }),
        segment('vmod.dist', ['uniform', 'center', 'split'].map((d) => [d, t(`vmod.dist.${d}`)]), () => V()[key].dist, (d) => editV((m) => { m[key].dist = d; }), key === 'trem' ? 'cyan' : 'violet'),
      ]),
      slider('vmod.drift', 'vmod.drift', () => V()[key].drift, setL(key, 'drift'), { min: 0, max: 1, step: 0.01, accent, def: 0 }),
      el('div', { class: 'flex items-center justify-between gap-1' }, [el('span', { class: 'text-[11px] text-slate-300', text: t('vmod.env') }), envBtns]),
      env.root,
    ]), () => V().adv);
    const box = el('div', { class: 'flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2 min-w-0' }, [
      onBtn(key),
      slider('vmod.rate', `vmod.${key}Rate`, () => V()[key].rate, setL(key, 'rate'), { min: VMOD_RATE_MIN, max: Math.min(20, VMOD_RATE_MAX), step: 0.05, unit: 'Hz', accent, def: key === 'trem' ? 5 : 5.5 }),
      slider(`vmod.${depthKey}`, `vmod.${key}${depthKey === 'depth' ? 'Depth' : 'Cents'}`, () => V()[key][depthKey], setL(key, depthKey), { min: 0, max: depthMax, step: depthStep, unit: depthKey === 'cents' ? '¢' : '', accent, def: depthKey === 'cents' ? 25 : 0.5 }),
      showIf(slider('vmod.spread', `vmod.${key}Spread`, () => V()[key].spread, setL(key, 'spread'), { min: 0, max: 1, step: 0.01, accent, def: 0.5 }), () => !V().adv),
      showIf(slider('vmod.track', `vmod.${key}Track`, () => V()[key].track, setL(key, 'track'), { min: -VMOD_TRACK_MAX, max: VMOD_TRACK_MAX, step: 0.05, unit: 'oct', accent, def: 0 }), () => !V().adv),
      adv,
    ]);
    syncers.push(() => box.classList.toggle('opacity-60', !V()[key].on));
    return box;
  };
  const seedLbl = el('span', { class: 'font-mono text-[10px] text-slate-400', dataset: { help: 'vmod.seed' } });
  syncers.push(() => { seedLbl.textContent = `${t('vmod.seed')} ${V().seed}`; });
  const reroll = el('button', { class: STUDIO_BTN, dataset: { help: 'vmod.seed' }, text: t('vmod.reroll'), on: { click: () => { editV((m) => { m.seed = (m.seed * 7919 + 104729) % 99991 || 1; }); commit(); } } });
  // "Advanced randomizer" checkbox: folded by default; ticking it opens and switches the advanced model on
  // 고급 랜덤화 체크박스: 기본 접힘, 체크하면 열리고 고급 모델 사용
  const advBox = el('input', { type: 'checkbox', class: 'accent-cyan-500', on: { change: (e) => {
    const on = e.target.checked;
    editV((m) => {
      m.adv = on;
      // first opening: the envelopes start as the straight line of the slider / 처음 열 때 포락선 = 슬라이더 직선
      if (on) for (const k of ['trem', 'vib']) if (!m[k].env) m[k].env = trackToEnv(m[k].track);
    });
    commit();
  } } });
  syncers.push(() => { advBox.checked = V().adv; });
  const advRow = el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none', dataset: { help: 'vmod.adv' } }, [advBox, t('vmod.adv')]);
  const root = el('section', { class: SECTION, dataset: { rack: binding.rack || 'voice-mod', help: binding.help || 'vmod' } }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('vmod.title') }),
      el('div', { class: 'flex items-center gap-2' }, [seedLbl, reroll]),
    ]),
    el('p', { class: 'text-[10.5px] text-slate-400 leading-snug', text: t('vmod.hint') }),
    advRow,
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2' }, [lane('trem', 'depth', 1, 0.01, 'accent-cyan', '#22d3ee'), lane('vib', 'cents', VMOD_CENTS_MAX, 1, 'accent-violet', '#a78bfa')]),
  ]);
  return { root, sync: () => syncers.forEach((fn) => fn()) };
}
