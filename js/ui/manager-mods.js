/**
 * Flexatone — ui/manager-mods.js
 * Layer 4 (ui): the **⇆ Modulation** card of the Manager (logic: core/mod-config.js, core/manager-mods.js,
 * audio/mod-sources.js). One row per route: source track + what is read (pitch line / loudness = sidechain /
 * triggers) → target track + parameter, amount, invert, attack / release, a preview of the signal over the
 * cycle, ▲ ▼ (list order decides which route of a loop is cut), on / off, ×.
 * Quick buttons add the three typical routes: Modulate (A2), Sidechain duck (A3), Retrigger (A4).
 * 계층 4 (ui): 매니저의 모듈레이션 카드 — 라우트마다 출처 → 대상, 양, 반전, 어택·릴리스, 신호 미리보기.
 */

import { t, I18N } from '../core/i18n.js';
import { getInstance } from '../core/manager-state.js';
import { MOD_TARGETS, TRIG_KINDS, targetsFor, MEAN_KEY } from '../core/mod-config.js';
import { listModStatuses, addMod, setMod, removeMod, moveMod } from '../core/manager-mods.js';
import { routePreview, modLinesOf, modTracks } from '../audio/mod-sources.js';
import { cycleLength } from '../audio/manager-mixer.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'mods.title': 'Modulation',
  'mods.hint': 'A signal of one track moves a parameter of another, in cycle time: a pitch line (modulation), a loudness envelope (sidechain) or events (triggers). Routes on the same parameter add up.',
  'mods.empty': 'No routes yet. Needs two tracks.',
  'mods.quick.mod': '+ Modulate',
  'mods.quick.duck': '+ Sidechain duck',
  'mods.quick.retrig': '+ Retrigger',
  'mods.from': 'From',
  'mods.to': 'To',
  'mods.kind.pitch': 'Pitch line',
  'mods.kind.env': 'Loudness (sidechain)',
  'mods.kind.trig': 'Triggers',
  'mods.trig.onset': 'Line onsets',
  'mods.trig.cross': 'Line crosses its centre',
  'mods.trig.peak': 'Loudness peaks',
  'mods.thr': 'Threshold',
  'mods.mean': 'Mean of all lines',
  'mods.param.gain': 'Level',
  'mods.param.trem': 'Tremolo depth',
  'mods.param.bright': 'Brightness',
  'mods.param.pitch': 'Pitch',
  'mods.param.retrig': 'Retrigger (restart clip)',
  'mods.param.cloud.density': 'Cloud density',
  'mods.param.cloud.width': 'Cloud width',
  'mods.param.cloud.collapse': 'Cloud collapse',
  'mods.param.cloud.center': 'Cloud centre',
  'mods.amount': 'Amount',
  'mods.invert': 'Invert (1 − signal)',
  'mods.attack': 'Att',
  'mods.release': 'Rel',
  'mods.on': 'On / off',
  'mods.up': 'Earlier in the list',
  'mods.down': 'Later in the list',
  'mods.remove': 'Remove route',
  'mods.status.loop': '⟲ loop — not applied (the earlier route in the list wins)',
  'mods.status.self': 'a track cannot follow its own sound',
  'mods.status.off': 'off',
  'mods.status.kind': 'Retrigger needs a trigger source',
  'mods.pending': 'rendering the source envelope…',
  'mods.events': (n) => `${n} events`,
  'mods.needTwo': 'Add a second track first.',
});
Object.assign(I18N.ko, {
  'mods.title': '모듈레이션',
  'mods.hint': '한 트랙의 신호가 다른 트랙의 파라미터를 사이클 시간 위에서 움직입니다: 음고 선(모듈레이션), 음량 엔벨로프(사이드체인), 이벤트(트리거). 같은 파라미터의 라우트는 더해집니다.',
  'mods.empty': '라우트가 없습니다. 트랙이 두 개 필요합니다.',
  'mods.quick.mod': '+ 모듈레이션',
  'mods.quick.duck': '+ 사이드체인 덕킹',
  'mods.quick.retrig': '+ 리트리거',
  'mods.from': '출처',
  'mods.to': '대상',
  'mods.kind.pitch': '음고 선',
  'mods.kind.env': '음량 (사이드체인)',
  'mods.kind.trig': '트리거',
  'mods.trig.onset': '선 시작',
  'mods.trig.cross': '선이 중심을 지남',
  'mods.trig.peak': '음량 피크',
  'mods.thr': '문턱',
  'mods.mean': '모든 선의 평균',
  'mods.param.gain': '음량',
  'mods.param.trem': '트레몰로 깊이',
  'mods.param.bright': '밝기',
  'mods.param.pitch': '음고',
  'mods.param.retrig': '리트리거 (클립 재시작)',
  'mods.param.cloud.density': '클라우드 밀도',
  'mods.param.cloud.width': '클라우드 폭',
  'mods.param.cloud.collapse': '클라우드 수렴',
  'mods.param.cloud.center': '클라우드 중심',
  'mods.amount': '양',
  'mods.invert': '반전 (1 − 신호)',
  'mods.attack': '어택',
  'mods.release': '릴리스',
  'mods.on': '켜기 / 끄기',
  'mods.up': '목록에서 앞으로',
  'mods.down': '목록에서 뒤로',
  'mods.remove': '라우트 삭제',
  'mods.status.loop': '⟲ 순환 — 적용 안 됨 (목록에서 앞의 라우트가 우선)',
  'mods.status.self': '트랙은 자기 소리를 따를 수 없습니다',
  'mods.status.off': '꺼짐',
  'mods.status.kind': '리트리거는 트리거 출처가 필요합니다',
  'mods.pending': '출처 엔벨로프 렌더링 중…',
  'mods.events': (n) => `이벤트 ${n}개`,
  'mods.needTwo': '먼저 트랙을 하나 더 추가하세요.',
});

HELP_DB['mgr.mods'] = {
  en: { title: 'Modulation (matrix · sidechain · triggers)', summary: 'Routes from a signal of one track to a parameter of another track, evaluated in cycle time.', detail: 'From: a track and what is read — Pitch line (one of its lines or their mean, scaled 0…1 between its lowest and highest pitch), Loudness (its clip as heard, −60…0 dB → 0…1, with attack / release = sidechain), Triggers (line onsets, a line crossing its centre, loudness peaks above the threshold) as a pulse with attack / release. To: Level (dB), Tremolo depth, Brightness, Pitch (semitones), Retrigger (every trigger restarts the clip), or a Cloud curve (density, width, collapse, centre: amount × its range). Amount × signal is added; several routes on one parameter add up. Playback, WAV and video hear the same thing (rendered in). A route that would make two tracks follow each other’s sound is not applied; the earlier route in the list wins.', formula: 'param(T) += amount · s(T),  s = invert ? 1 − x : x' },
  ko: { title: '모듈레이션 (매트릭스 · 사이드체인 · 트리거)', summary: '한 트랙의 신호에서 다른 트랙의 파라미터로 가는 라우트. 사이클 시간으로 평가합니다.', detail: '출처: 트랙과 읽을 것 — 음고 선(선 하나 또는 평균, 최저~최고 음고 사이를 0…1로), 음량(들리는 그대로의 클립, −60…0 dB → 0…1, 어택·릴리스 = 사이드체인), 트리거(선 시작, 선이 중심을 지남, 문턱을 넘는 음량 피크)를 어택·릴리스 펄스로. 대상: 음량(dB), 트레몰로 깊이, 밝기, 음고(반음), 리트리거(트리거마다 클립 재시작), 클라우드 곡선(밀도·폭·수렴·중심: 양 × 범위). 양 × 신호를 더하며, 같은 파라미터의 라우트는 합산됩니다. 재생·WAV·동영상이 같은 소리(렌더에 반영). 두 트랙이 서로의 소리를 따르게 되는 라우트는 적용되지 않고, 목록에서 앞의 라우트가 우선합니다.', formula: 'param(T) += 양 · s(T),  s = 반전 ? 1 − x : x' },
};

let opts = { showToast: () => {} };
const STATUS_TXT = (st) => (st === 'ok' ? '' : t(`mods.status.${st}`));
const fmt = (x, d = 2) => String(+Number(x).toFixed(d));

function sel(options, value, onChange, cls = '') {
  const s = el('select', { class: `mgr-mods-sel ${cls}`, on: { change: (e) => { const v = e.target.value; e.target.blur(); onChange(v); } } },
    options.map(([v, label]) => el('option', { value: v, text: label })));
  s.value = value;
  return s;
}

function numBox(value, { min, max, step, width = 52, title = '' }, onCommit) {
  return el('input', {
    type: 'number', class: 'mgr-mods-num', value: fmt(value), min, max, step, title, style: `width:${width}px`,
    on: { change: (e) => { const v = Number(e.target.value); e.target.blur(); if (Number.isFinite(v)) onCommit(v); } },
  });
}

function drawPreview(canvas, mod, C) {
  const pv = routePreview(mod, C, 140);
  const dpr = globalThis.devicePixelRatio || 1;
  const w = 140;
  const h = 26;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  if (!pv) return '';
  if (pv.times) {
    ctx.strokeStyle = 'rgba(251,191,36,.55)';
    for (const T of pv.times) { const x = (T / Math.max(1e-6, C)) * w; ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, h - 6); ctx.stroke(); }
  }
  ctx.strokeStyle = mod.on ? '#38bdf8' : '#475569';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  pv.v.forEach((v, i) => { const x = (i / (pv.v.length - 1)) * w; const y = h - 2 - v * (h - 4); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.stroke();
  if (pv.pending) return t('mods.pending');
  return pv.times ? t('mods.events', pv.times.length) : '';
}

function trackOptions(tracks) {
  return tracks.map((i) => [i.id, i.name]);
}

function routeRow(item, k, n, tracks, C) {
  const { mod, status } = item;
  const src = getInstance(mod.src.inst);
  const dst = getInstance(mod.dst.inst);
  const spec = MOD_TARGETS[mod.dst.param];
  const set = (patch) => setMod(mod.id, patch);
  const srcParts = [sel(trackOptions(tracks), mod.src.inst, (v) => set({ src: { inst: v, line: MEAN_KEY } }))];
  const kinds = spec.trigOnly ? ['trig'] : ['pitch', 'env', 'trig'];
  const kindOpts = kinds.filter((x) => !(x === 'pitch' && src?.studio === 'risset')).map((x) => [x, t(`mods.kind.${x}`)]);
  srcParts.push(sel(kindOpts, mod.src.kind, (v) => set({ src: { kind: v } })));
  const lineSel = () => {
    const lines = modLinesOf(src);
    const optsL = lines.map((l) => [String(l.key), l.key === MEAN_KEY ? t('mods.mean') : l.name || String(l.key)]);
    if (!optsL.length) return null;
    return sel(optsL, optsL.some(([v]) => v === mod.src.line) ? mod.src.line : optsL[optsL.length - 1][0], (v) => set({ src: { line: v } }), 'line');
  };
  if (mod.src.kind === 'pitch') srcParts.push(lineSel());
  if (mod.src.kind === 'trig') {
    const trigs = TRIG_KINDS.filter((x) => !(src?.studio === 'risset' && x !== 'peak'));
    srcParts.push(sel(trigs.map((x) => [x, t(`mods.trig.${x}`)]), trigs.includes(mod.src.trig) ? mod.src.trig : trigs[0], (v) => set({ src: { trig: v } })));
    if (mod.src.trig === 'cross') srcParts.push(lineSel());
    if (mod.src.trig === 'peak') srcParts.push(el('span', { class: 'mgr-muted', text: t('mods.thr') }), numBox(mod.src.thrDb, { min: -80, max: 0, step: 1, width: 48 }, (v) => set({ src: { thrDb: v } })), el('span', { class: 'mgr-muted', text: 'dB' }));
  }
  const params = dst ? targetsFor(dst.studio) : ['gain'];
  const dstParts = [
    sel(trackOptions(tracks), mod.dst.inst, (v) => set({ dst: { inst: v } })),
    sel(params.map((p) => [p, t(`mods.param.${p}`)]), mod.dst.param, (v) => set({ dst: { param: v } })),
  ];
  if (!spec.trigOnly) {
    dstParts.push(el('span', { class: 'mgr-muted', text: t('mods.amount') }), numBox(mod.amount, { min: spec.min, max: spec.max, step: spec.step, width: 56 }, (v) => set({ amount: v })));
    if (spec.unit) dstParts.push(el('span', { class: 'mgr-muted', text: spec.unit }));
    dstParts.push(el('button', { class: `mgr-btn tiny ${mod.invert ? 'on' : ''}`, text: '⇅', title: t('mods.invert'), on: { click: () => set({ invert: !mod.invert }) } }));
  }
  if (mod.src.kind !== 'pitch' && !spec.trigOnly) {
    dstParts.push(el('span', { class: 'mgr-muted', text: t('mods.attack') }), numBox(mod.attackMs, { min: 0, max: 2000, step: 1, width: 48, title: 'ms' }, (v) => set({ attackMs: v })));
    dstParts.push(el('span', { class: 'mgr-muted', text: t('mods.release') }), numBox(mod.releaseMs, { min: 1, max: 10000, step: 5, width: 54, title: 'ms' }, (v) => set({ releaseMs: v })));
  }
  const canvas = el('canvas', { class: 'mgr-mods-pv', style: 'width:140px;height:26px' });
  const note = el('span', { class: 'mgr-muted mgr-mods-note' });
  requestAnimationFrame(() => { note.textContent = STATUS_TXT(status) || drawPreview(canvas, mod, C); });
  return el('div', { class: `mgr-mods-row ${status !== 'ok' ? 'is-dim' : ''}`, dataset: { mod: mod.id } }, [
    el('span', { class: 'mgr-mods-k', text: String(k + 1) }),
    el('button', { class: `mgr-btn tiny ${mod.on ? 'on' : ''}`, text: mod.on ? '●' : '○', title: t('mods.on'), on: { click: () => set({ on: !mod.on }) } }),
    el('span', { class: 'mgr-mods-part' }, [el('b', { class: 'mgr-muted', text: t('mods.from') }), ...srcParts.filter(Boolean)]),
    el('span', { class: 'mgr-mods-arrow', text: '→' }),
    el('span', { class: 'mgr-mods-part' }, [el('b', { class: 'mgr-muted', text: t('mods.to') }), ...dstParts]),
    canvas,
    note,
    el('span', { style: 'flex:1' }),
    el('button', { class: 'mgr-btn tiny', text: '▲', title: t('mods.up'), disabled: k === 0, on: { click: () => moveMod(mod.id, -1) } }),
    el('button', { class: 'mgr-btn tiny', text: '▼', title: t('mods.down'), disabled: k === n - 1, on: { click: () => moveMod(mod.id, +1) } }),
    el('button', { class: 'mgr-btn tiny danger', text: '×', title: t('mods.remove'), on: { click: () => removeMod(mod.id) } }),
  ]);
}

function quickAdd(kind, tracks) {
  if (tracks.length < 2) { opts.showToast(t('mods.needTwo')); return; }
  const a = tracks[0];
  const b = tracks[1];
  if (kind === 'duck') addMod({ srcInst: a.id, dstInst: b.id, kind: 'env', param: 'gain' });
  else if (kind === 'retrig') {
    const src = tracks.find((x) => x.studio !== 'risset') || a;
    const dst = tracks.find((x) => x.id !== src.id && x.studio !== 'risset') || b;
    addMod({ srcInst: src.id, dstInst: dst.id, kind: 'trig', param: 'retrig' });
  } else {
    const src = tracks.find((x) => x.studio !== 'risset') || a;
    const dst = tracks.find((x) => x.id !== src.id) || b;
    addMod({ srcInst: src.id, dstInst: dst.id, kind: 'pitch', param: dst.studio === 'cloud' ? 'cloud.density' : 'trem' });
  }
}

/** Build the card into `host` (called after every Manager render). / 매니저 렌더 후 카드 생성 */
export function mountModsCard(host, o = {}) {
  if (!host) return;
  opts = { ...opts, ...o };
  const tracks = modTracks();
  const items = listModStatuses();
  const C = cycleLength();
  const head = el('div', { class: 'mgr-card-head' }, [
    el('h3', { text: `⇆ ${t('mods.title')}` }),
    el('button', { class: 'mgr-btn', text: t('mods.quick.mod'), on: { click: () => quickAdd('mod', tracks) } }),
    el('button', { class: 'mgr-btn', text: t('mods.quick.duck'), on: { click: () => quickAdd('duck', tracks) } }),
    el('button', { class: 'mgr-btn', text: t('mods.quick.retrig'), on: { click: () => quickAdd('retrig', tracks) } }),
    el('span', { class: 'mgr-muted mgr-mods-hint', text: t('mods.hint') }),
  ]);
  const body = el('div', { class: 'mgr-mods-body' }, items.length
    ? items.map((it, k) => routeRow(it, k, items.length, tracks, C))
    : [el('p', { class: 'mgr-muted', text: t('mods.empty') })]);
  const card = el('section', { class: 'mgr-card mgr-mods', dataset: { help: 'mgr.mods', rack: 'mgr-mods' } }, [head, body]);
  host.replaceChildren(card);
}
