/**
 * Flexatone — ui/studio-tempo-ui.js
 * Layer 4 (ui): the **⏱ tempo chip** in the header transport — the Tempo Manager of the studio on screen
 * (core/studio-tempo.js). A click opens a small panel: × / BPM / Length (duration lock), Follow Manager (master × this studio's focused track), Reset. While the tempo is not 1× the header transport
 * plays the studio through audio/tempo-player.js; Risset scales its live clock.
 * 계층 4 (ui): 헤더 트랜스포트의 ⏱ 템포 칩 — 화면에 있는 스튜디오의 템포 매니저. × / BPM / 길이 고정, 테이프,
 * 매니저 따르기, 초기화.
 */

import { t, I18N } from '../core/i18n.js';
import { appState, subscribe } from '../core/state.js';
import { StudioRegistry } from '../studios/registry.js';
import { getStudioTempo, setStudioTempo, resetStudioTempo, studioRates } from '../core/studio-tempo.js';
import { studioNaturalSec, tempoPlayable, restartTempo, isTempoPlaying } from '../audio/tempo-player.js';
import { setRissetTimeScaleSource } from '../studios/risset/risset-audio.js';
import { activeTransport, stopAllAudio } from './studio-host.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'stempo.tip': 'Tempo of this studio\'s own transport (click to change)',
  'stempo.title': 'Studio tempo',
  'stempo.mode.rate': '×',
  'stempo.mode.bpm': 'BPM',
  'stempo.mode.length': 'Length',
  'stempo.rate': 'Speed',
  'stempo.bpm': 'BPM',
  'stempo.ref': 'ref',
  'stempo.length': 'Plays in (s)',
  'stempo.natural': (s) => `natural length ${s}`,
  'stempo.follow': 'Follow the Manager (master × this studio\'s track)',
  'stempo.reset': 'Reset to 1×',
  'stempo.heard': (r, own, trk) => `Heard ×${r} = studio ×${own} · Manager ×${trk}`,
  'stempo.risset': 'Risset: the field\'s clock runs at this speed (pitch kept). Length does not apply.',
  'stempo.none': 'No tempo for this studio.',
});
Object.assign(I18N.ko, {
  'stempo.tip': '이 스튜디오 자체 트랜스포트의 템포 (클릭해서 변경)',
  'stempo.title': '스튜디오 템포',
  'stempo.mode.rate': '×',
  'stempo.mode.bpm': 'BPM',
  'stempo.mode.length': '길이',
  'stempo.rate': '배속',
  'stempo.bpm': 'BPM',
  'stempo.ref': '기준',
  'stempo.length': '재생 길이 (초)',
  'stempo.natural': (s) => `자연 길이 ${s}`,
  'stempo.follow': '매니저 따르기 (마스터 × 이 스튜디오의 트랙)',
  'stempo.reset': '1×로 초기화',
  'stempo.heard': (r, own, trk) => `들리는 배속 ×${r} = 스튜디오 ×${own} · 매니저 ×${trk}`,
  'stempo.risset': '리세: 음장의 시계가 이 속도로 흐릅니다 (음고 유지). 길이는 적용되지 않습니다.',
  'stempo.none': '이 스튜디오에는 템포가 없습니다.',
});
HELP_DB['app.studioTempo'] = {
  en: { title: 'Studio tempo (Tempo Manager)', summary: 'Speed of the studio on screen when you press Play in the header: × rate, BPM (rate = BPM / ref) or Length (the content is played in exactly that many seconds).', detail: 'Pitch is always kept: every studio rescales its own time (as in the Manager), so only the speed changes. In Space the whole scene runs faster or slower and every heard frequency, Doppler included, stays; an imported sound keeps its own speed. Follow the Manager multiplies the Manager\'s master tempo and the tempo of this studio\'s focused track, so the studio sounds as it does in the Manager. Export WAV uses the same tempo. Edits while playing are re-rendered and cross-faded from the playhead.', formula: 'heard rate = studio × master × track;  Length: studio = natural ÷ (length · master · track)' },
  ko: { title: '스튜디오 템포 (템포 매니저)', summary: '헤더의 재생을 눌렀을 때 화면의 스튜디오가 재생되는 속도: × 배속, BPM (배속 = BPM / 기준), 길이 (내용을 정확히 그 초 동안 재생).', detail: '음고는 항상 유지됩니다: 모든 스튜디오가 자기 시간을 재스케일하므로(매니저와 같음) 속도만 바뀝니다. 스페이스는 장면 전체가 빠르게/느리게 흐르고 들리는 주파수(도플러 포함)는 그대로이며, 가져온 소리는 자기 속도로 재생됩니다. 매니저 따르기는 매니저 마스터 템포와 이 스튜디오의 포커스 트랙 템포를 곱해서, 매니저에서 들리는 그대로 재생합니다. WAV 내보내기도 같은 템포를 씁니다. 재생 중 편집은 다시 렌더해 플레이헤드부터 크로스페이드합니다.', formula: '들리는 배속 = 스튜디오 × 마스터 × 트랙;  길이: 스튜디오 = 자연 길이 ÷ (길이 · 마스터 · 트랙)' },
};

const fmt = (x, d = 2) => (Number.isFinite(x) ? (+x.toFixed(d)).toString() : '—');
const studioNow = () => StudioRegistry.resolveStudioId();
const hasTempo = (studio) => studio === 'risset' || tempoPlayable(studio);

let chip = null;
let panel = null;

function naturalOf(studio) {
  return studio === 'risset' ? null : studioNaturalSec(studio);
}

/** A tempo change while playing: switch transport if the routing changed, else re-render from the playhead. */
function afterChange(wasRouted) {
  const studio = studioNow();
  if (!appState.transport.playing || studio === 'risset') return;
  const routed = tempoPlayable(studio) && studioRates(studio, naturalOf(studio)).active;
  if (routed && wasRouted && isTempoPlaying()) { restartTempo(); return; }
  if (routed === wasRouted) return;
  const ph = appState.transport.playheadSec;
  stopAllAudio();
  const tp = activeTransport();
  if (tp.playFrom && ph >= 0) void tp.playFrom(ph);
  else void tp.togglePlay();
}

function edit(patch, coalesceKey = null) {
  const studio = studioNow();
  const nat = naturalOf(studio);
  const wasRouted = tempoPlayable(studio) && studioRates(studio, nat).active;
  setStudioTempo(studio, patch, { naturalSec: nat, coalesceKey });
  afterChange(wasRouted);
  if (!coalesceKey) renderPanel(); // a range drag keeps its element / 슬라이더 드래그 중에는 다시 그리지 않음
  else if (panel) {
    const r = studioRates(studio, nat);
    const n = panel.querySelector('[data-key="rate"]');
    if (n) n.value = fmt(getStudioTempo(studio).rate, 3);
    const h = panel.querySelector('.fx-stempo-heard');
    if (h) h.textContent = t('stempo.heard', fmt(r.rate), fmt(r.own), fmt(r.track));
  }
}

function syncChip() {
  if (!chip) return;
  const studio = studioNow();
  const ok = hasTempo(studio);
  chip.classList.toggle('hidden', !ok);
  if (!ok) return;
  const nat = getStudioTempo(studio).mode === 'length' ? naturalOf(studio) : null;
  const r = studioRates(studio, nat);
  chip.querySelector('.fx-stempo-val').textContent = `×${fmt(r.rate)}`;
  chip.classList.toggle('on', r.active);
  chip.title = t('stempo.tip');
}

function renderPanel() {
  if (!panel) return;
  const studio = studioNow();
  const body = panel.querySelector('.fx-stempo-body');
  body.replaceChildren();
  if (!hasTempo(studio)) { body.append(el('p', { class: 'text-[11px] text-slate-400', text: t('stempo.none') })); return; }
  const cfg = getStudioTempo(studio);
  const nat = naturalOf(studio);
  const r = studioRates(studio, nat);
  const risset = studio === 'risset';
  const modes = risset ? ['rate', 'bpm'] : ['rate', 'bpm', 'length'];
  const seg = el('div', { class: 'fx-stempo-seg' }, modes.map((m) => el('button', {
    class: cfg.mode === m ? 'on' : '',
    text: t(`stempo.mode.${m}`),
    on: { click: () => edit({ mode: m }) },
  })));
  const numInput = (value, min, max, step, onSet, key) => el('input', {
    type: 'number', min: String(min), max: String(max), step: String(step), value: String(value), class: 'fx-stempo-num',
    on: { change: (e) => onSet(Number(e.target.value)), keydown: (e) => e.stopPropagation() },
    dataset: { key },
  });
  let row;
  if (cfg.mode === 'bpm') {
    row = el('div', { class: 'fx-stempo-row' }, [
      el('span', { text: t('stempo.bpm') }), numInput(fmt(cfg.bpm, 2), 10, 960, 1, (v) => edit({ bpm: v }), 'bpm'),
      el('span', { class: 'text-slate-500', text: t('stempo.ref') }), numInput(fmt(cfg.refBpm, 2), 10, 960, 1, (v) => edit({ refBpm: v }), 'ref'),
    ]);
  } else if (cfg.mode === 'length') {
    row = el('div', { class: 'fx-stempo-row' }, [
      el('span', { text: t('stempo.length') }), numInput(fmt(cfg.lockSec, 3), 0.05, 3600, 0.1, (v) => edit({ lockSec: v }), 'lock'),
      el('span', { class: 'text-slate-500', text: t('stempo.natural', `${fmt(nat, 2)} s`) }),
    ]);
  } else {
    const range = el('input', {
      type: 'range', min: '-3.32', max: '3', step: '0.01', value: String(Math.log2(cfg.rate)), class: 'fx-stempo-range',
      on: { input: (e) => edit({ rate: 2 ** Number(e.target.value) }, 'stempo-rate'), change: () => renderPanel(), dblclick: () => edit({ rate: 1 }) },
    });
    row = el('div', { class: 'fx-stempo-row' }, [
      el('span', { text: t('stempo.rate') }), range, numInput(fmt(cfg.rate, 3), 0.1, 8, 0.05, (v) => edit({ rate: v }), 'rate'),
    ]);
  }
  const check = (label, on, fn, disabled = false) => el('label', { class: `fx-stempo-check ${disabled ? 'opacity-40' : ''}` }, [
    el('input', { type: 'checkbox', checked: on, disabled, on: { change: (e) => fn(e.target.checked) } }), el('span', { text: label }),
  ]);
  body.append(
    seg,
    row,
    check(t('stempo.follow'), cfg.follow, (v) => edit({ follow: v })),
    el('p', { class: 'fx-stempo-heard', text: t('stempo.heard', fmt(r.rate), fmt(r.own), fmt(r.track)) }),
    ...(risset ? [el('p', { class: 'fx-stempo-note', text: t('stempo.risset') })] : []), // append(null) would print "null"
    el('button', { class: 'fx-traj-btn', text: t('stempo.reset'), on: { click: () => { const st = studioNow(); const was = tempoPlayable(st) && studioRates(st, naturalOf(st)).active; resetStudioTempo(st); afterChange(was); } } }),
  );
}

function closePanel() {
  panel?.remove();
  panel = null;
}

function openPanel() {
  if (panel) { closePanel(); return; }
  panel = el('div', { class: 'fx-stempo-panel', dataset: { help: 'app.studioTempo' } }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('span', { class: 'text-xs font-bold text-amber-200', text: `⏱ ${t('stempo.title')}` }),
      el('button', { class: 'text-slate-400 hover:text-white', text: '×', on: { click: closePanel } }),
    ]),
    el('div', { class: 'fx-stempo-body flex flex-col gap-1.5' }),
  ]);
  document.body.append(panel);
  const r = chip.getBoundingClientRect();
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, r.left))}px`;
  panel.style.top = `${r.bottom + 6}px`;
  renderPanel();
}

export function initStudioTempoUi() {
  setRissetTimeScaleSource(() => studioRates('risset').rate);
  const anchor = document.getElementById('btnCueReset');
  if (anchor && !document.getElementById('btnTransportTempo')) {
    chip = el('button', {
      id: 'btnTransportTempo',
      class: 'fx-stempo-chip',
      dataset: { help: 'app.studioTempo' },
      on: { click: openPanel },
    }, [el('span', { text: '⏱' }), el('span', { class: 'fx-stempo-val', text: '×1' })]);
    anchor.after(chip);
  }
  document.addEventListener('pointerdown', (e) => {
    if (panel && !panel.contains(e.target) && e.target !== chip && !chip?.contains(e.target)) closePanel();
  });
  let last = '';
  subscribe((e) => {
    const only = [...e.scope].every((x) => x === 'transport');
    if (only) return;
    syncChip();
    // re-render the panel only when something it shows changed (not while typing in it) / 표시 값이 바뀔 때만
    const studio = studioNow();
    const key = `${studio}|${JSON.stringify(getStudioTempo(studio))}|${JSON.stringify(appState.manager?.tempo ?? null)}|${appState.lang}`;
    if (panel && key !== last && !panel.contains(document.activeElement)) renderPanel();
    last = key;
  });
  syncChip();
}
