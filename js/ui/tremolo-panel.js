/**
 * Flexatone — ui/tremolo-panel.js
 * Layer 4 (ui): the tremolo rack. Studio-agnostic: `mountTremolo` builds the controls for any
 * `{ get, edit, duration }` binding, so Field / Risset / Manager can reuse it later; the Glissando
 * Studio binds it to the target voices (honours Group Apply, undo and history coalescing).
 * 계층 4 (ui): 트레몰로 랙. 어떤 바인딩({ get, edit, duration })에도 쓸 수 있어 다른 스튜디오가
 * 재사용할 수 있고, 글리산도 스튜디오는 대상 보이스(그룹 적용·실행 취소 지원)에 연결합니다.
 */

import { t, getLang } from '../core/i18n.js';
import { getActiveVoice, updateVoices } from '../core/state.js';
import { createDefaultTremolo,
  TREMOLO_SHAPES,
  TREMOLO_SYNCS,
  TREMOLO_RATE_ENGINES,
  normalizeTremolo,
  isTremoloOn,
} from '../core/tremolo-config.js';
import { sampleTremoloPreview } from '../modules/tremolo.js';
import { evaluateVoiceGainAtNormT } from '../modules/gain-bus.js';
import { createVoiceModRack } from './voice-mod-rack.js';
import { StudioRegistry } from '../studios/registry.js';
import { el, rangeRow, syncValue, commitGesture, num, setRegionTremoloBuilder } from './panels.js';

const $ = (id) => document.getElementById(id);
const SCOPE = ['gain', 'tremolo', 'canvas'];

// --------------------------------------------------------------------------
// Reusable mount / 재사용 가능한 마운트
// --------------------------------------------------------------------------

/**
 * Build the tremolo controls into `root`.
 * @param {HTMLElement} root
 * @param {{
 *   get: () => object,                                  current tremolo config (may be unnormalized)
 *   edit: (fn: (cfg: object) => void, key?: string|null) => void,   mutate through the host's history
 *   duration: () => number,                             seconds shown in the preview
 *   envelope?: () => ((u:number) => number) | null,     optional envelope drawn under the preview
 *   hintKey?: string                                    i18n key of the header hint (default 'trem.hint')
 *   features?: { sweep?: boolean, fade?: boolean, sync?: boolean }   hide rows a backend can't honour (default all on)
 * }} binding
 * @returns {{ sync: () => void }}
 */
export function mountTremolo(root, binding) {
  const syncers = [];
  const cfg = () => normalizeTremolo(binding.get());
  const set = (patch, key = null) => binding.edit((c) => Object.assign(c, patch), key);
  const toggle = (labelKey, getOn, onClick) => {
    const b = el('button', { class: 'fx-toggle px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs font-medium transition', text: t(labelKey), on: { click: onClick } });
    syncers.push(() => { b.classList.toggle('is-active', getOn()); b.setAttribute('aria-pressed', getOn() ? 'true' : 'false'); });
    return b;
  };
  const select = (labelKey, key, options, helpKey) => {
    const sel = el('select', { class: 'bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px]', on: { change: (e) => { set({ [key]: e.target.value }); commitGesture(); } } }, options.map((o) => el('option', { value: o.value, text: o.label })));
    syncers.push(() => syncValue(sel, cfg()[key]));
    return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', 'data-help': helpKey }, [t(labelKey), sel]);
  };
  const range = (labelKey, key, min, max, step, helpKey, mapKey = key) => {
    const row = rangeRow({ label: t(labelKey), value: num(cfg()[key]), min, max, step, compact: true, def: createDefaultTremolo()[key], key: `trem:${key}`, onInput: (val, k) => {
      // While not sweeping (rate = end rate) the two move together, so editing the rate never
      // creates an accidental accelerando. / 스윕이 아닌 동안은 두 속도가 함께 움직임
      const c = cfg();
      if (key === 'rate' && c.rate === c.rateEnd) set({ rate: val, rateEnd: val }, k);
      else set({ [mapKey]: val }, k);
    } });
    syncers.push(() => row.sync(num(cfg()[key])));
    row.root.dataset.help = helpKey;
    return row.root;
  };

  const c0 = cfg();
  const feat = { sweep: true, fade: true, sync: true, ...(binding.features || {}) };
  const rows = [];
  rows.push(select('trem.shape', 'shape', TREMOLO_SHAPES.map((s) => ({ value: s, label: t(`trem.shape.${s}`) })), 'trem.shape'));
  // Rate unit: Hz, or tempo-synced (cycles per beat at a BPM) / 속도 단위: Hz 또는 템포 동기
  const unitToggle = (u) => toggle(`trem.rateUnit.${u}`, () => cfg().rateUnit === u, () => { set({ rateUnit: u }); commitGesture(); });
  rows.push(el('div', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', 'data-help': 'trem.rateUnit' }, [t('trem.rateUnit'), el('div', { class: 'flex gap-1' }, [unitToggle('hz'), unitToggle('beat')])]));
  const beat = c0.rateUnit === 'beat';
  if (beat) {
    rows.push(range('trem.bpm', 'bpm', 20, 300, 1, 'trem.bpm'));
    // Common divisions = cycles per beat; anything else shows as Custom / 흔한 음표 단위 = 박당 주기
    const DIVS = [[0.5, 'half'], [1, 'quarter'], [2, 'eighth'], [3, 'eighthT'], [4, 'sixteenth'], [6, 'sixteenthT'], [8, 'thirtySecond']];
    const sel = el('select', { class: 'bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px]', on: { change: (e) => {
      if (e.target.value === '') return;
      const v = Number(e.target.value);
      set({ rate: v, rateEnd: v });
      commitGesture();
    } } }, [...DIVS.map(([v, k]) => el('option', { value: String(v), text: t(`trem.div.${k}`) })), el('option', { value: '', text: t('trem.div.custom') })]);
    syncers.push(() => { const c = cfg(); const hit = DIVS.find(([v]) => v === c.rate && v === c.rateEnd); syncValue(sel, hit ? String(hit[0]) : ''); });
    rows.push(el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', 'data-help': 'trem.division' }, [t('trem.division'), sel]));
  }
  rows.push(range(beat ? 'trem.rateBeat' : 'trem.rate', 'rate', 0.05, 20, 0.05, 'trem.rate'));
  if (feat.sweep) rows.push(range(beat ? 'trem.rateEndBeat' : 'trem.rateEnd', 'rateEnd', 0.05, 20, 0.05, 'trem.rateEnd'));
  if (feat.sweep) rows.push(select('trem.rateEngine', 'rateEngine', TREMOLO_RATE_ENGINES.map((s) => ({ value: s, label: t(`trem.ease.${s}`) })), 'trem.rateEngine'));

  // Depth: amp 0 … 1 or dB 0 … 60 / 깊이: 진폭 또는 dB
  const unitBtn = (u) => toggle(`trem.unit.${u}`, () => cfg().depthUnit === u, () => { set({ depthUnit: u }); commitGesture(); });
  rows.push(el('div', { class: 'flex flex-col gap-1', 'data-help': 'trem.depth' }, [
    el('div', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300' }, [t('trem.depth'), el('div', { class: 'flex gap-1' }, [unitBtn('amp'), unitBtn('db')])]),
    c0.depthUnit === 'db' ? range('trem.depthDb', 'depthDb', 0, 36, 0.5, 'trem.depth') : range('trem.depthAmp', 'depth', 0, 1, 0.01, 'trem.depth'),
  ]));
  if (feat.fade) rows.push(range('trem.fadeIn', 'fadeIn', 0, 10, 0.05, 'trem.fadeIn'));
  rows.push(range('trem.phase', 'phase', 0, 1, 0.01, 'trem.phase'));
  if (feat.sync) rows.push(select('trem.sync', 'sync', TREMOLO_SYNCS.map((s) => ({ value: s, label: t(`trem.sync.${s}`) })), 'trem.sync'));
  if (c0.shape === 'square' || c0.shape === 'saw') rows.push(range('trem.smooth', 'smooth', 0, 1, 0.01, 'trem.smooth'));
  if (c0.shape === 'random') rows.push(range('trem.seed', 'seed', 0, 999, 1, 'trem.seed'));
  if (c0.shape === 'formula') {
    const inp = el('input', { type: 'text', spellcheck: 'false', class: 'w-full px-1.5 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-[11px]', on: {
      keydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
      change: (e) => { set({ formula: e.target.value }); commitGesture(); },
    } });
    syncers.push(() => syncValue(inp, cfg().formula));
    rows.push(el('label', { class: 'flex flex-col gap-1 text-[11px] text-slate-300 sm:col-span-2', 'data-help': 'trem.formula' }, [t('trem.formula'), inp]));
  }

  const canvas = el('canvas', { class: 'w-full h-full block' });
  const draw = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const c = cfg();
    const dur = Math.max(0.05, binding.duration());
    const pad = 4;
    const Y = (g) => pad + (1 - g) * (h - 2 * pad);
    const X = (i, n) => pad + (i / (n - 1)) * (w - 2 * pad);
    const n = Math.max(120, Math.min(1200, Math.round(w)));
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 1;
    for (const g of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(pad, Y(g)); ctx.lineTo(w - pad, Y(g)); ctx.stroke(); }
    const tr = sampleTremoloPreview(c, dur, n);
    const env = binding.envelope?.();
    if (env) {
      ctx.strokeStyle = 'rgba(52,211,153,0.45)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = X(i, n); const y = Y(env(i / (n - 1))); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = isTremoloOn(c) ? '#f472b6' : 'rgba(148,163,184,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const g = tr[i] * (env ? env(i / (n - 1)) : 1);
      const x = X(i, n);
      if (i) ctx.lineTo(x, Y(g)); else ctx.moveTo(x, Y(g));
    }
    ctx.stroke();
  };

  const onBtn = toggle('trem.toggle', () => cfg().on, () => { set({ on: !cfg().on }); commitGesture(); });
  onBtn.dataset.help = 'trem.toggle';
  root.replaceChildren(
    el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('div', { class: 'flex items-center gap-2' }, [el('span', { class: 'text-xs font-bold text-pink-400', text: t('trem.title') }), onBtn]),
      el('span', { class: 'text-[10px] text-slate-500 hidden sm:block', text: t(binding.hintKey || 'trem.hint') }),
    ]),
    el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2' }, rows),
    el('div', { class: 'w-full h-[64px] rounded-lg overflow-hidden border border-slate-800 bg-slate-950', 'data-help': 'trem.preview' }, [canvas]),
  );
  return {
    sync() { syncers.forEach((fn) => fn()); draw(); },
  };
}

/**
 * Keyed host around `mountTremolo`: rebuilds only when the layout-relevant settings change
 * (language, shape, depth unit) and otherwise just syncs values. Any studio can use it.
 * 레이아웃에 영향을 주는 설정(언어·파형·깊이 단위)이 바뀔 때만 다시 만들고, 아니면 값만 동기화.
 * @returns {{ sync: () => void }}
 */
export function createTremoloHost(root, binding) {
  let mounted = null;
  let key = '';
  return {
    sync() {
      const c = normalizeTremolo(binding.get());
      const k = `${getLang()}|${c.shape}|${c.depthUnit}|${c.rateUnit}`;
      if (!mounted || k !== key) {
        key = k;
        mounted = mountTremolo(root, binding);
      }
      mounted.sync();
    },
  };
}

// --------------------------------------------------------------------------
// Glissando Studio binding / 글리산도 스튜디오 연결
// --------------------------------------------------------------------------

let host = null;

/** Render the Glissando tremolo rack for the active voice. / 활성 보이스의 트레몰로 랙 갱신 */
export function renderTremoloPanel() {
  const root = $('tremoloMount');
  if (!root) return;
  const v = getActiveVoice();
  root.classList.toggle('hidden', !v);
  if (!v) return;
  if (!host) {
    const active = () => getActiveVoice();
    host = createTremoloHost(root, {
      get: () => active()?.tremolo,
      // Group Apply: updateVoices targets every selected voice; each one is normalized first so a
      // voice without a tremolo block still receives the edit. / 그룹 적용 시 선택 보이스 모두에 반영
      edit: (fn, k) => updateVoices((voice) => { voice.tremolo = normalizeTremolo(voice.tremolo); fn(voice.tremolo); voice.tremolo = normalizeTremolo(voice.tremolo); }, { coalesceKey: k, scope: SCOPE }),
      duration: () => active()?.duration ?? 1,
      envelope: () => {
        const av = active();
        return av ? (u) => evaluateVoiceGainAtNormT(av, u) : null;
      },
    });
    // Studio-wide per-voice tremolo / vibrato (randomized per voice), stored in the Glissando params
    // 스튜디오 전체 보이스별 트레몰로·비브라토 (보이스마다 랜덤), 글리산도 파라미터에 저장
    vmodRack = createVoiceModRack({
      studio: 'glissando',
      get: () => StudioRegistry.getParams('glissando'),
      edit: (fn, { coalesceKey } = {}) => { const d = StudioRegistry.getParams('glissando'); fn(d); StudioRegistry.setParams('glissando', { voiceMod: d.voiceMod }, { coalesceKey }); },
    });
    vmodRack.root.classList.add('mt-1');
    root.after(vmodRack.root);
  }
  host.sync();
  vmodRack?.sync();
}
let vmodRack = null;

// --------------------------------------------------------------------------
// Region tremolo (Select tool) / 구간 트레몰로
// --------------------------------------------------------------------------

// The region panel (panels.js) asks for this block; registered here to keep panels.js free of a
// circular import. / 구간 패널이 요청하는 블록 — 순환 import를 피하려고 여기서 등록
setRegionTremoloBuilder(({ getR, editR, syncers }) => {
  const section = el('div', { class: 'flex flex-col gap-2 rounded-lg border border-pink-500/30 bg-pink-500/5 p-2' });
  const host = createTremoloHost(section, {
    get: () => getR()?.tremolo,
    edit: (fn, k) => editR((x) => { x.tremolo = normalizeTremolo(x.tremolo); fn(x.tremolo); x.tremolo = normalizeTremolo(x.tremolo); }, k),
    duration: () => {
      const vv = getActiveVoice();
      const x = getR();
      return vv && x ? Math.max(0.05, (x.t1 - x.t0) * vv.duration) : 1;
    },
    envelope: () => null,
    hintKey: 'trem.hintRegion',
  });
  syncers.push(() => host.sync());
  return section;
});
