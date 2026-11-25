/**
 * Flexatone — ui/timbre-editor.js
 * Layer 4 (ui): the shared timbre synthesis editor — the same "Mix | ƒ(x)" block the Glissando
 * Studio has, for every other studio (Field, Draw, Cloud, Space, Tempo, Chaos, Fractal, Wave).
 * 계층 4 (ui): 공용 음색 합성 편집기 — 글리산도 스튜디오의 "믹스 | ƒ(x)" 블록을 다른 모든 스튜디오에서 사용.
 *
 *   Mix  : five sliders (Sine, Tri, Saw, Square, Rich)
 *   ƒ(x) : one cycle from a formula of x ∈ [0, 1) or from a Glissando voice's curve, with a live
 *          preview and the formula error (a broken formula keeps sounding as the Mix)
 *   Sample: (opt-in, `binding.sample: true`) the per-voice Sampler (ui/sample-editor.js). Only studios
 *          whose timbre belongs to one voice opt in (Draw, Tempo, Space, Field) — a Sampler is never
 *          studio-wide. Its edits go through `binding.sampleEdit` (one voice) when given.
 *          보이스별 샘플러. 음색이 보이스 하나에 속하는 스튜디오만 사용 (스튜디오 전체에는 적용하지 않음).
 * The editor is studio-agnostic: it reads and edits a timbre spec (modules/timbre-spec.js) through
 * the binding, so undo, coalescing and "which voice" stay the studio's business.
 * 편집기는 바인딩을 통해 음색 스펙만 읽고 고치므로, 실행 취소·대상 보이스는 각 스튜디오가 결정.
 */

import { t } from '../core/i18n.js';
import { appState, endHistoryGesture, TIMBRE_WAVES } from '../core/state.js';
import { timbreSpecMode, timbreSpecFunc, timbreSpecCoefficients, timbreSpecPreview } from '../modules/timbre-spec.js';
import { normalizeSampleSpec } from '../modules/sample-source.js';
import { el, syncValue, num } from './panels.js';
import { createDefaultVoice } from '../core/state.js';
import { setSliderDefault, probeStudioDefault } from './slider-reset.js';
import { createSampleEditor } from './sample-editor.js';
import { normalizeAdsr, adsrGainAt, createDefaultAdsr } from '../core/adsr.js';

const ACCENT = { sine: '', tri: 'accent-emerald', saw: 'accent-amber', sqr: 'accent-rose', rich: 'accent-violet' };
const LABEL = { sine: 'text-sky-300', tri: 'text-emerald-300', saw: 'text-amber-300', sqr: 'text-rose-300', rich: 'text-violet-300' };
const SEG_ON = 'px-2 py-0.5 rounded bg-violet-600 text-white font-semibold transition';
const SEG_OFF = 'px-2 py-0.5 rounded text-slate-400 hover:text-white transition';

/**
 * Build the editor.
 * @param {{
 *   get: () => object | null | undefined,                       the timbre spec being edited (null = nothing selected)
 *   edit: (fn: (spec: object) => void, key?: string | null) => void,   mutate the spec through the studio's history
 *   idPrefix?: string                                           prefix of the undo-coalescing keys
 *   sample?: boolean                                            show the per-voice Sample tab
 *   sampleEdit?: (fn, key?) => void                             like `edit`, but for the active voice only
 *   toast?: (msg: string) => void
 * }} binding
 * @returns {{ root: HTMLElement, sync: () => void }} call `sync` from the studio's render
 */
export function createTimbreEditor(binding) {
  const prefix = binding.idPrefix || 'timbre';
  const spec = () => binding.get() || {};
  const commit = () => endHistoryGesture();

  // ---- header: Mix | ƒ(x)
  const btnMix = el('button', { class: SEG_ON, text: t('timbre.mix'), dataset: { help: 'gliss.timbreMode' }, on: { click: () => { binding.edit((s) => { s.mode = 'mix'; }); commit(); } } });
  const btnFunc = el('button', { class: SEG_OFF, text: 'ƒ(x)', dataset: { help: 'gliss.timbreMode' }, on: { click: () => { binding.edit((s) => { s.mode = 'func'; s.func = timbreSpecFunc(s); }); commit(); } } });
  // Per-voice Sampler (opt-in) / 보이스별 샘플러 (선택)
  const editOne = binding.sampleEdit || binding.edit;
  const btnSample = binding.sample
    ? el('button', { class: SEG_OFF, text: t('timbre.sample'), dataset: { help: 'gliss.timbreSample' }, on: { click: () => { editOne((s) => { s.mode = 'sample'; s.sample = normalizeSampleSpec(s.sample); }); commit(); } } })
    : null;
  const sampleEd = binding.sample
    ? createSampleEditor({
      get: () => spec().sample,
      edit: (fn, k) => editOne((s) => { s.sample = normalizeSampleSpec(s.sample); fn(s.sample); }, k ? `${prefix}-${k}` : null),
      toast: binding.toast,
    })
    : null;
  const head = el('div', { class: 'flex items-center justify-end' }, [
    el('div', { class: 'flex rounded-lg bg-slate-950 border border-slate-800 p-0.5 text-[11px]', role: 'group' }, [btnMix, btnFunc, btnSample]),
  ]);

  // ---- Mix: 5 sliders
  const sliders = {};
  const values = {};
  const mix = el('div', { class: 'grid grid-cols-5 gap-1' }, TIMBRE_WAVES.map((w) => {
    const r = el('input', { type: 'range', min: '0', max: '1', step: '0.01', class: `w-full ${ACCENT[w]}` });
    // default: the studio's default document, else the default voice mix / 기본값: 스튜디오 기본 문서, 없으면 기본 보이스 믹스
    setSliderDefault(r, () => (binding.probe || probeStudioDefault)(() => num(spec()[w], NaN)) ?? createDefaultVoice(0).timbre[w]);
    r.addEventListener('input', () => binding.edit((s) => { s[w] = Number(r.value); }, `${prefix}-${w}`));
    r.addEventListener('change', commit);
    const val = el('span', { class: 'text-[10px] font-mono text-slate-400 tabular-nums', text: '0.00' });
    sliders[w] = r;
    values[w] = val;
    return el('div', { class: 'bg-slate-950 border border-slate-800 rounded-lg p-1.5 flex flex-col items-center gap-1 min-w-0' }, [
      el('span', { class: `text-[10px] font-semibold ${LABEL[w]}`, text: t(`timbre.${w}`) }), r, val,
    ]);
  }));

  // ---- ƒ(x): source, formula / voice, preview, error
  const selSource = el('select', { class: 'bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs', on: { change: (e) => { binding.edit((s) => { s.func = { ...timbreSpecFunc(s), source: e.target.value }; }); commit(); } } }, [
    el('option', { value: 'formula', text: t('timbre.srcFormula') }),
    el('option', { value: 'voice', text: t('timbre.srcVoice') }),
  ]);
  const selVoice = el('select', { class: 'hidden bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs min-w-0', on: { change: (e) => { binding.edit((s) => { s.func = { ...timbreSpecFunc(s), voiceId: e.target.value }; }); commit(); } } });
  const expr = el('input', { type: 'text', spellcheck: false, class: 'w-full px-2 py-1 rounded bg-slate-900 border border-slate-700 font-mono text-xs focus:border-violet-500 focus:outline-none' });
  expr.addEventListener('input', () => binding.edit((s) => { s.func = { ...timbreSpecFunc(s), expr: expr.value }; }, `${prefix}-expr`));
  expr.addEventListener('change', commit);
  expr.addEventListener('keydown', (e) => e.stopPropagation()); // typing never triggers studio shortcuts / 단축키와 충돌 방지
  const canvas = el('canvas', { class: 'w-full h-full block' });
  const error = el('p', { class: 'hidden text-[10px] text-rose-400 font-mono' });
  const func = el('div', { class: 'hidden flex flex-col gap-2 bg-slate-950/90 border border-slate-800 rounded-lg p-2.5 text-xs', dataset: { help: 'gliss.timbreFunc' } }, [
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [
      el('label', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'text-slate-400 text-[11px]', text: t('timbre.source') }), selSource]),
      selVoice,
    ]),
    expr,
    el('div', { class: 'h-14 rounded bg-slate-950 border border-slate-800 overflow-hidden' }, [canvas]),
    error,
  ]);

  if (sampleEd) sampleEd.root.classList.add('hidden');

  // ---- ADSR envelope (core/adsr.js), the same block as the Glissando timbre toolbox. `binding.joins`:
  // the studio has lines that join back to back (else ↻ Restart stays off and says why).
  // ADSR 엔벨로프 — 글리산도 음색 툴박스와 같은 블록. binding.joins: 이어지는 선이 있는 스튜디오 (없으면 ↻ 꺼짐 + 이유)
  const adsrEdit = (fn, key) => binding.edit((s) => { s.adsr = normalizeAdsr(s.adsr); fn(s.adsr); }, key ? `${prefix}-${key}` : null);
  const adsrOn = el('input', { type: 'checkbox', class: 'accent-violet-500 w-3.5 h-3.5', on: { change: (e) => { adsrEdit((a) => { a.on = e.target.checked; }); commit(); } } });
  const adsrRe = el('input', { type: 'checkbox', class: 'accent-violet-500 w-3.5 h-3.5', on: { change: (e) => { adsrEdit((a) => { a.retrig = e.target.checked; }); commit(); } } });
  if (!binding.joins) adsrRe.disabled = true;
  const adsrPic = el('canvas', { class: 'ml-auto w-24 h-6 rounded bg-slate-950 border border-slate-800' });
  const adsrDef = createDefaultAdsr();
  const adsrSl = {};
  const adsrVal = {};
  const ADSR_RANGE = { a: [2, 0.005], d: [2, 0.005], s: [1, 0.01], r: [3, 0.005] };
  const adsrGrid = el('div', { class: 'grid grid-cols-4 gap-2' }, ['a', 'd', 's', 'r'].map((k) => {
    const r = el('input', { type: 'range', min: '0', max: String(ADSR_RANGE[k][0]), step: String(ADSR_RANGE[k][1]), class: 'w-full accent-violet' });
    setSliderDefault(r, adsrDef[k]);
    // moving a slider switches the envelope on / 슬라이더를 움직이면 켜짐
    r.addEventListener('input', () => adsrEdit((a) => { a[k] = Number(r.value); a.on = true; }, `adsr-${k}`));
    r.addEventListener('change', commit);
    adsrSl[k] = r;
    adsrVal[k] = el('span', { class: 'text-[10px] font-mono text-slate-400 tabular-nums', text: '' });
    return el('label', { class: 'flex flex-col items-center gap-0.5 min-w-0' }, [el('span', { class: 'text-[10px] font-semibold text-slate-300', text: t(`adsr.${k}`) }), r, adsrVal[k]]);
  }));
  const adsrReLabel = el('label', { class: `flex items-center gap-1.5 text-[11px] ${binding.joins ? 'text-slate-300 cursor-pointer' : 'text-slate-600 cursor-not-allowed'}`, title: binding.joins ? t('adsr.retrigTip') : t('adsr.noJoins') }, [adsrRe, `↻ ${t('adsr.retrig')}`]);
  const adsrBox = el('div', { class: 'flex flex-col gap-1.5 border-t border-slate-800 pt-2', dataset: { help: 'gliss.adsr' } }, [
    el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-1' }, [
      el('label', { class: 'flex items-center gap-1.5 text-[11px] font-semibold text-violet-300 cursor-pointer' }, [adsrOn, t('adsr.title')]),
      adsrReLabel,
      adsrPic,
    ]),
    adsrGrid,
  ]);
  function syncAdsr(s) {
    const a = normalizeAdsr(s.adsr);
    adsrOn.checked = a.on;
    adsrRe.checked = !!binding.joins && a.retrig;
    adsrGrid.classList.toggle('opacity-40', !a.on);
    for (const k of ['a', 'd', 's', 'r']) {
      syncValue(adsrSl[k], a[k]);
      adsrVal[k].textContent = k === 's' ? a[k].toFixed(2) : `${a[k].toFixed(k === 'a' ? 3 : 2)} s`;
    }
    const w = adsrPic.clientWidth;
    const h = adsrPic.clientHeight;
    if (!w || !h) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (adsrPic.width !== Math.round(w * dpr)) { adsrPic.width = Math.round(w * dpr); adsrPic.height = Math.round(h * dpr); }
    const ctx = adsrPic.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = a.on ? '#a78bfa' : '#475569';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i <= w; i++) {
      const y = h - 2 - (h - 4) * adsrGainAt({ ...a, on: true }, (i / w) * 2, 2);
      if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
    }
    ctx.stroke();
  }

  const root = el('div', { class: 'flex flex-col gap-2 min-w-0' }, [head, mix, func, sampleEd?.root, adsrBox]);

  function drawPreview(s) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(148,163,184,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    const { wave } = timbreSpecPreview(s, { voices: appState.voices, points: 256 });
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= wave.length; i++) {
      const y = h / 2 - wave[i % wave.length] * (h / 2 - 4);
      const x = (i / wave.length) * w;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  let lastDrawn = '';
  function sync() {
    const s = spec();
    syncAdsr(s);
    // No tab for a mode this editor cannot edit (Sample without a sample editor; Pulse until ROADMAP D-3) → Mix tab.
    // 편집할 수 없는 모드(샘플 편집기 없는 샘플, D-3 전의 펄스)는 믹스 탭으로 표시.
    const raw = timbreSpecMode(s);
    const mode = (raw === 'sample' && !sampleEd) || raw === 'pulse' ? 'mix' : raw;
    const isFunc = mode === 'func';
    const isSample = mode === 'sample';
    for (const [b, on] of [[btnMix, mode === 'mix'], [btnFunc, isFunc], [btnSample, isSample]]) {
      if (!b) continue;
      b.className = on ? SEG_ON : SEG_OFF;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    mix.classList.toggle('hidden', mode !== 'mix');
    func.classList.toggle('hidden', !isFunc);
    if (sampleEd) {
      sampleEd.root.classList.toggle('hidden', !isSample);
      if (isSample) sampleEd.sync();
    }
    for (const w of TIMBRE_WAVES) {
      const v = Number(s[w]) || 0;
      syncValue(sliders[w], v);
      values[w].textContent = v.toFixed(2);
    }
    if (!isFunc) { lastDrawn = ''; return; }
    const f = timbreSpecFunc(s);
    syncValue(selSource, f.source);
    selVoice.classList.toggle('hidden', f.source !== 'voice');
    expr.classList.toggle('hidden', f.source === 'voice');
    const opts = appState.voices.map((v) => `${v.id}:${v.name}`).join('|');
    if (selVoice.dataset.opts !== opts) {
      selVoice.dataset.opts = opts;
      selVoice.replaceChildren(el('option', { value: '', text: '—' }), ...appState.voices.map((v) => el('option', { value: v.id, text: v.name })));
    }
    syncValue(selVoice, f.voiceId || '');
    syncValue(expr, f.expr);
    const res = timbreSpecCoefficients(s, { voices: appState.voices });
    error.classList.toggle('hidden', !res.error);
    error.textContent = res.error ? t('timbre.exprError', res.error.message) : '';
    // Redraw only when the wave or the canvas size changed (render runs every frame while playing).
    // 파형이나 캔버스 크기가 바뀔 때만 다시 그림.
    const key = `${f.source}|${f.source === 'voice' ? `${f.voiceId}|${opts}` : f.expr}|${canvas.clientWidth}x${canvas.clientHeight}|${res.error ? TIMBRE_WAVES.map((w) => s[w]).join() : ''}`;
    if (key !== lastDrawn && canvas.clientWidth) { lastDrawn = key; drawPreview(s); }
  }

  return { root, sync };
}
