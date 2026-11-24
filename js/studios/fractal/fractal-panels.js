/**
 * Flexatone — studios/fractal/fractal-panels.js
 * Fractal Studio UI tier: workspace DOM (header & actions, canvases, analysis, parameter racks).
 * Mounted by ui/studio-host.js (via ui/workspaces.js) when the Fractal tab is active.
 * 프랙탈 스튜디오 작업 공간 DOM (헤더·액션, 캔버스, 분석, 파라미터 랙).
 *
 * Every control carries data-help="fractal.…" (entries in fractal-i18n.js → HELP_DB below), and
 * every number input is picked up by ui/number-scrub.js. A slider drag is one undo step
 * (coalesceKey + endHistoryGesture), exactly like field-panels.js.
 * 모든 컨트롤에 data-help가 있고, 슬라이더 드래그 1회 = 실행 취소 1단계.
 */

import { createLineMixRack } from '../../ui/line-mix-rack.js';
import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture, appState } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN, STUDIO_SELECT } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { FRACTAL_HELP } from './fractal-i18n.js';
import { FRACTAL_MODES, CURVE_MODES, QUANTIZE_MODES, SCALES, GAIN_SOURCES, FBM_METHODS, FIF_MAX_POINTS, maxLevelFor, getFractalBakeCount } from './fractal-engine.js';
import { FRACTAL_ID, getFractalParams, editFractal, getFractalBake, getBakeLoss, PRESET_IDS, applyPresetTo, LSYS_PRESETS } from '../fractal-studio.js';
import { createFractalCanvases } from './fractal-canvases.js';
import { exportFractalJson, exportFractalWav, isFractalPlaying } from './fractal-audio.js';

for (const [k, v] of Object.entries(FRACTAL_HELP)) HELP_DB[k] = v;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const H3 = 'text-xs font-bold uppercase tracking-wider';
const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** "A=AB\nB=A" → [{from:'A', to:'AB'}, …] (also accepts → / -> and ; separators). */
export function parseRules(text) {
  return String(text || '')
    .split(/[\n;,]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\S)\s*(?:=|→|->|:)\s*(.*)$/);
      return m ? { from: m[1], to: m[2].replace(/\s+/g, '') } : null;
    })
    .filter(Boolean);
}
const rulesToText = (rules) => rules.map((r) => `${r.from}=${r.to}`).join('\n');

/**
 * Mount the Fractal workspace into `root`. / 프랙탈 작업 공간 마운트
 * @returns {{ render: (scopes?: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountFractalWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let lossKey = '';
  let lossTimer = null;
  let lossEl = null;
  const commit = () => endHistoryGesture();
  const P = () => getFractalParams();

  const { slider: keySlider, toggle, select, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help, opts) => `fractal:${opts.ckey || help}:${label}` });
  const slider = (labelText, help, get, set, opts) => keySlider(labelText, help, get, set, { ...opts, raw: true }); // label is already text / 라벨은 번역된 문자열
  /** Slider on a dotted path of the document, e.g. 'fbm.H'. / 문서 경로 슬라이더 */
  function pathSlider(labelKey, help, path, opts) {
    const [a, b] = path.split('.');
    const get = () => num(b ? P()[a][b] : P()[a]);
    const set = (val, ck) => editFractal((d) => { const v = opts.integer ? Math.round(val) : val; if (b) d[a][b] = v; else d[a] = v; }, { coalesceKey: ck });
    return slider(t(labelKey), help, get, set, opts);
  }
  const segmented = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  const labelled = (labelText, control, help) => el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', dataset: { help } }, [labelText, control]);
  function textInput(help, get, set, { wide = false, area = false } = {}) {
    const inp = el(area ? 'textarea' : 'input', { type: area ? undefined : 'text', rows: area ? 3 : undefined, spellcheck: 'false', class: `${wide ? 'w-full' : 'w-28'} px-1.5 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-[11px] text-slate-100`, dataset: { help } });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (!area && e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => { set(inp.value); commit(); });
    syncers.push(() => { if (document.activeElement !== inp) inp.value = get(); });
    return inp;
  }

  // ------------------------------------------------------------------ header
  function buildHeader() {
    const status = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono', dataset: { help: 'fractal.bake' } });
    const warnBadge = el('span', { class: 'hidden px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/40 text-[11px]', dataset: { help: 'fractal.warnings' } });
    syncers.push(() => {
      const b = getFractalBake();
      status.textContent = t('fractal.status', b.voices.length, Math.round(b.info.rate), getFractalBakeCount());
      const w = b.info.warnings;
      warnBadge.classList.toggle('hidden', !w.length);
      warnBadge.textContent = w.length ? `⚠ ${t(w[0].key, ...w[0].args)}` : '';
    });
    const seed = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'fractal.seed' } });
    seed.addEventListener('change', () => { editFractal((d) => { d.seed = Math.round(clamp(num(seed.value, d.seed), 0, 999999)); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seed) seed.value = String(P().seed); });
    const presetSel = select('fractal.preset', [['', t('fractal.preset.none')], ...PRESET_IDS.map((id) => [id, t(`fractal.preset.${id}`)])], () => (PRESET_IDS.includes(P().preset) ? P().preset : ''), (id) => {
      if (!id) return;
      editFractal((d) => applyPresetTo(d, id));
      canvases?.resetLens();
      hooks.showToast(t('fractal.presetApplied', t(`fractal.preset.${id}`)));
    });
    const bake = (mode) => {
      const loss = getBakeLoss();
      const res = StudioRegistry.bakeVoices(FRACTAL_ID, { mode });
      const n = res.result?.length || 0;
      hooks.showToast(t('fractal.bakedToGliss', n, loss.anchorsMax, loss.maxErrSt.toFixed(2)));
    };
    return el('section', { class: SECTION, dataset: { help: 'fractal.header' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('h2', { class: `${H3} text-fuchsia-300`, text: t('fractal.title') }),
          el('span', { class: 'text-[11px] text-slate-400', text: t('fractal.subtitle') }),
          status,
          warnBadge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          labelled(t('fractal.seed'), seed, 'fractal.seed'),
          el('button', { class: BTN, text: t('fractal.reseed'), dataset: { help: 'fractal.reseed' }, on: { click: () => {
            const s = 1 + Math.floor(Math.random() * 99999);
            editFractal((d) => { d.seed = s; });
            commit();
            hooks.showToast(t('fractal.reseeded', s));
          } } }),
          presetSel,
          createTrajectoryImportButton('fractal'), // Glissando trajectory → this studio's base line / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('fractal.bakeGliss')}`, dataset: { help: 'fractal.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('fractal.bakeAppend'), dataset: { help: 'fractal.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('fractal.exportJson')}`, dataset: { help: 'fractal.exportJson' }, on: { click: () => { exportFractalJson(); hooks.showToast(t('fractal.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('fractal.exportWav')}`, dataset: { help: 'fractal.exportWav' }, on: { click: async () => {
            hooks.showToast(t('toast.wavStart'));
            try {
              const r = await exportFractalWav();
              hooks.showToast(r.ok ? t('toast.wavDone', r.filename) : r.message, r.ok ? 'info' : 'error');
            } catch (err) { hooks.showToast(String(err.message || err), 'error'); }
          } } }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ canvases + analysis
  function buildCanvasCol() {
    const hud = { time: el('span', { class: 'text-sky-300', text: '—' }), note: el('span', { class: 'text-emerald-300', text: '—' }), hz: el('span', { class: 'text-amber-300', text: '—' }) };
    const main = el('canvas', { class: 'w-full h-[380px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'fractal.canvas' } });
    const lens = el('canvas', { class: 'w-full h-[200px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'fractal.lens' } });
    const lensInfo = el('span', { class: 'font-mono text-[11px] text-sky-300' });
    canvases = createFractalCanvases({ main, lens, hud, lensInfo }, { requestRender: hooks.requestRender });
    const legend = el('span', { class: 'hidden text-[11px] text-slate-400', text: t('fractal.refine.legend') });
    syncers.push(() => legend.classList.toggle('hidden', !(P().refine.enabled && CURVE_MODES.includes(P().mode))));
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [
        el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' }, [
          el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]), legend,
          el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('fractal.canvasHint') }),
        ]),
        // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [...createLocateButtons({ unavailable: 'locate.na.generated' }), createZoomBar({ onPitch: (f) => canvases?.zoomMain('pitch', f), onTime: (f) => canvases?.zoomMain('time', f), onBoth: (f) => canvases?.zoomMain('both', f), onFit: () => canvases?.fitMain() })]), // Locate has nothing to move here: off, with the reason / 이동 도구: 꺼진 채 이유 표시
        main,
      ]),
      el('section', { class: SECTION }, [
        el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
          el('div', { class: 'flex items-center gap-2' }, [el('h3', { class: `${H3} text-sky-300`, text: t('fractal.lensTitle'), dataset: { help: 'fractal.lens' } }), lensInfo]),
          el('div', { class: 'flex items-center gap-1' }, [
            el('span', { class: 'text-[11px] text-slate-500 mr-1', text: t('fractal.lensHint') }),
            el('button', { class: BTN, text: '−', dataset: { help: 'fractal.lens' }, on: { click: () => canvases?.zoomLens(2) } }),
            el('button', { class: BTN, text: '+', dataset: { help: 'fractal.lens' }, on: { click: () => canvases?.zoomLens(0.5) } }),
            el('button', { class: BTN, text: t('zoom.fit'), dataset: { help: 'fractal.lens' }, on: { click: () => canvases?.resetLens() } }),
          ]),
        ]),
        lens,
      ]),
      buildAnalysis(),
    ]);
  }

  function buildAnalysis() {
    const rows = el('div', { class: 'grid grid-cols-2 sm:grid-cols-4 gap-2' });
    const warn = el('div', { class: 'flex flex-col gap-1 text-[11px]', dataset: { help: 'fractal.warnings' } });
    const cell = (label, value, help) => el('div', { class: 'bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 flex flex-col', dataset: { help } }, [
      el('span', { class: 'text-[11px] text-slate-500', text: label }),
      el('span', { class: 'font-mono text-[12px] text-slate-100', text: value }),
    ]);
    syncers.push(() => {
      const b = getFractalBake();
      const p = P();
      const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : t('fractal.na'));
      const cells = [cell(t('fractal.dimEst'), f(b.analysis.D), 'fractal.analysis'), cell(t('fractal.dimTheory'), b.analysis.Dtheory == null ? t('fractal.na') : f(b.analysis.Dtheory), 'fractal.analysis')];
      if (p.mode === 'fbm') cells.push(cell(t('fractal.hurstEst'), `${f(b.analysis.H, 2)} / H=${p.fbm.H}`, 'fractal.fbm.H'));
      if (CURVE_MODES.includes(p.mode)) cells.push(cell(t('fractal.levelsUsed'), `${b.info.levelsUsed} / ${b.info.maxLevel + 1}`, 'fractal.refine'));
      if (p.mode === 'lsystem') {
        cells.push(cell(t('fractal.strLen'), String(b.info.stringLength), 'fractal.lsys.iterations'));
        cells.push(cell(t('fractal.branches'), `${b.info.branches} → ${b.info.voiceCount} (♪ ${b.info.sounding})`, 'fractal.mode.lsystem'));
      }
      if (p.mode === 'canon') cells.push(cell(t('fractal.layers'), String(b.info.layers), 'fractal.canon.layers'));
      cells.push(cell(t('fractal.maxConcurrent'), String(b.maxConcurrent), 'fractal.gain.level'));
      rows.replaceChildren(...cells);
      const ws = b.info.warnings;
      warn.replaceChildren(...(ws.length
        ? ws.map((w) => el('span', { class: 'text-amber-300', text: `⚠ ${t(w.key, ...w.args)}` }))
        : [el('span', { class: 'text-slate-500', text: t('fractal.noWarnings') })]));
    });
    return el('section', { class: SECTION, dataset: { help: 'fractal.analysis' } }, [el('h3', { class: `${H3} text-emerald-300`, text: t('fractal.analysisTitle') }), rows, warn]);
  }

  // ------------------------------------------------------------------ generator rack
  function buildModeRack(params) {
    const tabs = el('div', { class: 'grid grid-cols-3 gap-1' }, FRACTAL_MODES.map((id) => {
      const on = params.mode === id;
      return el('button', {
        class: `px-1.5 py-1 rounded-md border text-[11px] truncate transition ${on ? 'bg-fuchsia-600 border-fuchsia-400 text-white font-semibold' : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-600'}`,
        text: t(`fractal.mode.${id}`),
        dataset: { help: `fractal.mode.${id}` },
        on: { click: () => { if (P().mode !== id) { editFractal((d) => { d.mode = id; }); commit(); canvases?.resetLens(); } } },
      });
    }));
    const body = { fif: fifRack, fbm: fbmRack, weierstrass: weierRack, cantor: cantorRack, lsystem: lsysRack, canon: canonRack }[params.mode](params);
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-fuchsia-300`, text: t('fractal.modeTitle'), dataset: { help: `fractal.mode.${params.mode}` } }),
      tabs,
      ...body,
    ]);
  }

  function fifRack(params) {
    const rows = params.fif.points.map((q, i) => slider(t('fractal.fif.y', i), 'fractal.fif.points', () => num(P().fif.points[i]?.y), (val, ck) => editFractal((d) => { if (d.fif.points[i]) d.fif.points[i].y = val; }, { coalesceKey: ck }), { min: -0.25, max: 1.25, step: 0.01, ckey: `fif-y${i}` }));
    const ds = params.fif.d.map((_, i) => slider(t('fractal.fif.d', i + 1), 'fractal.fif.d', () => num(P().fif.d[i]), (val, ck) => editFractal((d) => { d.fif.d[i] = val; }, { coalesceKey: ck }), { min: -0.95, max: 0.95, step: 0.01, accent: 'accent-fuchsia', ckey: `fif-d${i}` }));
    const add = () => {
      editFractal((d) => {
        const pts = d.fif.points;
        if (pts.length >= FIF_MAX_POINTS) return;
        let k = 1;
        for (let i = 1; i < pts.length; i++) if (pts[i].x - pts[i - 1].x > pts[k].x - pts[k - 1].x) k = i;
        const a = pts[k - 1];
        const b = pts[k];
        pts.splice(k, 0, { x: roundTo(0.5 * (a.x + b.x), 4), y: roundTo(0.5 * (a.y + b.y), 4) });
        d.fif.d.splice(k, 0, d.fif.d[k - 1] ?? 0.3);
      });
      commit();
    };
    const remove = () => {
      editFractal((d) => {
        const pts = d.fif.points;
        if (pts.length <= 2) return;
        const k = pts.length - 2;
        pts.splice(k, 1);
        d.fif.d.splice(k, 1);
      });
      commit();
    };
    return [
      el('div', { class: 'flex items-center justify-between gap-2', dataset: { help: 'fractal.fif.points' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: `${t('fractal.fif.points')} (${params.fif.points.length})` }),
        el('div', { class: 'flex gap-1' }, [
          el('button', { class: BTN, text: t('fractal.fif.add'), dataset: { help: 'fractal.fif.points' }, on: { click: add } }),
          el('button', { class: BTN, text: t('fractal.fif.remove'), dataset: { help: 'fractal.fif.points' }, on: { click: remove } }),
        ]),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, rows),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-800 pt-2' }, ds),
      pathSlider('fractal.fif.depth', 'fractal.fif.depth', 'fif.depth', { min: 0, max: 14, step: 1, integer: true }),
    ];
  }

  function fbmRack() {
    return [
      labelled(t('fractal.fbm.method'), segmented('fractal.fbm.method', FBM_METHODS.map((m) => [m, `fractal.fbm.${m}`]), () => P().fbm.method, (v) => editFractal((d) => { d.fbm.method = v; })), 'fractal.fbm.method'),
      pathSlider('fractal.fbm.H', 'fractal.fbm.H', 'fbm.H', { min: 0.05, max: 0.95, step: 0.01 }),
      pathSlider('fractal.fbm.octaves', 'fractal.fbm.octaves', 'fbm.octaves', { min: 1, max: 12, step: 1, integer: true }),
    ];
  }

  function weierRack() {
    return [
      toggle('fractal.weier.takagi', 'fractal.weier.takagi', () => P().weier.takagi, () => { editFractal((d) => { d.weier.takagi = !d.weier.takagi; }); commit(); }),
      pathSlider('fractal.weier.a', 'fractal.weier.a', 'weier.a', { min: 0.05, max: 0.95, step: 0.01 }),
      pathSlider('fractal.weier.b', 'fractal.weier.b', 'weier.b', { min: 1.1, max: 9, step: 0.1 }),
      pathSlider('fractal.weier.terms', 'fractal.weier.terms', 'weier.terms', { min: 1, max: 24, step: 1, integer: true }),
    ];
  }

  function cantorRack() {
    return [
      pathSlider('fractal.cantor.div', 'fractal.cantor.div', 'cantor.div', { min: 3, max: 9, step: 2, integer: true }),
      pathSlider('fractal.cantor.gap', 'fractal.cantor.gap', 'cantor.gap', { min: 0.02, max: 0.9, step: 0.01 }),
      pathSlider('fractal.cantor.depth', 'fractal.cantor.depth', 'cantor.depth', { min: 0, max: 12, step: 1, integer: true }),
    ];
  }

  function lsysRack() {
    const presets = el('div', { class: 'flex flex-wrap items-center gap-1', dataset: { help: 'fractal.lsys.presets' } }, Object.keys(LSYS_PRESETS).map((id) => el('button', {
      class: BTN, text: t(`fractal.lsys.preset.${id}`), dataset: { help: 'fractal.lsys.presets' },
      on: { click: () => { editFractal((d) => { Object.assign(d.lsys, JSON.parse(JSON.stringify(LSYS_PRESETS[id]))); d.preset = ''; if (id === 'binary') d.voicesMax = Math.max(d.voicesMax, 32); }); commit(); canvases?.resetLens(); } },
    })));
    return [
      presets,
      labelled(t('fractal.lsys.axiom'), textInput('fractal.lsys.axiom', () => P().lsys.axiom, (v) => editFractal((d) => { d.lsys.axiom = v.replace(/\s+/g, '') || 'F'; })), 'fractal.lsys.axiom'),
      el('div', { class: 'flex flex-col gap-1', dataset: { help: 'fractal.lsys.rules' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('fractal.lsys.rules') }),
        textInput('fractal.lsys.rules', () => rulesToText(P().lsys.rules), (v) => editFractal((d) => { d.lsys.rules = parseRules(v); }), { wide: true, area: true }),
      ]),
      pathSlider('fractal.lsys.iterations', 'fractal.lsys.iterations', 'lsys.iterations', { min: 0, max: 8, step: 1, integer: true }),
      pathSlider('fractal.lsys.angle', 'fractal.lsys.angle', 'lsys.angleSemitones', { min: -12, max: 12, step: 0.5 }),
      pathSlider('fractal.lsys.step', 'fractal.lsys.step', 'lsys.stepSec', { min: 0.02, max: 2, step: 0.01, unit: 's' }),
      pathSlider('fractal.lsys.start', 'fractal.lsys.start', 'lsys.startNote', { min: 24, max: 108, step: 1, integer: true }),
      toggle('fractal.lsys.glide', 'fractal.lsys.glide', () => P().lsys.glide, () => { editFractal((d) => { d.lsys.glide = !d.lsys.glide; }); commit(); }),
    ];
  }

  function canonRack(params) {
    const parts = [
      labelled(t('fractal.canon.subject'), segmented('fractal.canon.subject', [['norgard', 'fractal.canon.norgard'], ['custom', 'fractal.canon.custom']], () => P().canon.subject, (v) => editFractal((d) => { d.canon.subject = v; })), 'fractal.canon.subject'),
    ];
    if (params.canon.subject === 'custom') {
      parts.push(el('div', { class: 'flex flex-col gap-1', dataset: { help: 'fractal.canon.subject' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('fractal.canon.customIntervals') }),
        textInput('fractal.canon.subject', () => P().canon.customIntervals.join(' '), (v) => editFractal((d) => { d.canon.customIntervals = v.split(/[\s,;]+/).filter(Boolean).map(Number).filter(Number.isFinite); }), { wide: true }),
      ]));
    }
    parts.push(
      pathSlider('fractal.canon.layers', 'fractal.canon.layers', 'canon.layers', { min: 1, max: 8, step: 1, integer: true }),
      pathSlider('fractal.canon.ratio', 'fractal.canon.ratio', 'canon.ratio', { min: 0.2, max: 0.95, step: 0.01 }),
      pathSlider('fractal.canon.baseNote', 'fractal.canon.baseNote', 'canon.baseNote', { min: 24, max: 100, step: 1, integer: true }),
      pathSlider('fractal.canon.step', 'fractal.canon.step', 'canon.stepSemitones', { min: 0.1, max: 12, step: 0.1 }),
      pathSlider('fractal.canon.noteSec', 'fractal.canon.noteSec', 'canon.noteSec', { min: 0.05, max: 8, step: 0.05, unit: 's' }),
      pathSlider('fractal.canon.transpose', 'fractal.canon.transpose', 'canon.layerTranspose', { min: -24, max: 24, step: 1 }),
    );
    return parts;
  }

  // ------------------------------------------------------------------ mapping / refine / sound / bake
  function buildMapRack(params) {
    const parts = [
      el('h3', { class: `${H3} text-sky-300`, text: t('fractal.mapTitle'), dataset: { help: 'fractal.range' } }),
      pathSlider('fractal.length', 'fractal.length', 'length', { min: 1, max: 120, step: 0.5, unit: 's', accent: 'accent-sky' }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        pathSlider('fractal.lo', 'fractal.range', 'lo', { min: 12, max: 115, step: 1, integer: true, accent: 'accent-sky' }),
        pathSlider('fractal.hi', 'fractal.range', 'hi', { min: 13, max: 120, step: 1, integer: true, accent: 'accent-sky' }),
      ]),
      labelled(t('fractal.quantize'), segmented('fractal.quantize', QUANTIZE_MODES.map((q) => [q, `fractal.q.${q}`]), () => P().quantize, (v) => editFractal((d) => { d.quantize = v; }), 'sky'), 'fractal.quantize'),
    ];
    if (params.quantize === 'scale') {
      parts.push(el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled(t('fractal.scale'), select('fractal.scale', Object.keys(SCALES).map((s) => [s, t(`fractal.scale.${s}`)]), () => P().scale, (v) => editFractal((d) => { d.scale = v; })), 'fractal.scale'),
        labelled(t('fractal.scaleRoot'), select('fractal.scale', NOTE_NAMES.map((n, i) => [String(i), n]), () => P().scaleRoot, (v) => editFractal((d) => { d.scaleRoot = Number(v); })), 'fractal.scale'),
      ]));
    }
    return el('section', { class: SECTION }, parts);
  }

  function buildRefineRack(params) {
    const curve = CURVE_MODES.includes(params.mode);
    const parts = [el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: `${H3} text-amber-300`, text: t('fractal.refineTitle'), dataset: { help: 'fractal.refine' } }),
      curve ? toggle('fractal.refine.on', 'fractal.refine', () => P().refine.enabled, () => { editFractal((d) => { d.refine.enabled = !d.refine.enabled; }); commit(); }) : null,
    ])];
    if (!curve) {
      parts.push(el('span', { class: 'text-[11px] text-slate-500', text: t('fractal.refine.na') }));
    } else if (params.refine.enabled) {
      const maxL = Math.min(maxLevelFor(params), 15);
      const chips = [];
      for (let L = 0; L <= maxL; L++) {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[11px] font-mono border', text: String(L), dataset: { help: 'fractal.refine.levels' }, on: { click: () => {
          editFractal((d) => {
            const set = new Set(d.refine.levels.map((x) => Math.min(x, maxL)));
            if (set.has(L)) { if (set.size > 1) set.delete(L); } else set.add(L);
            d.refine.levels = [...set].sort((x, y) => x - y);
          });
          commit();
        } } });
        syncers.push(() => {
          const on = P().refine.levels.map((x) => Math.min(x, maxL)).includes(L);
          b.className = `px-1.5 py-0.5 rounded text-[11px] font-mono border ${on ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold' : 'bg-slate-950 border-slate-700 text-slate-400 hover:border-slate-500'}`;
        });
        chips.push(b);
      }
      parts.push(
        el('div', { class: 'flex flex-col gap-1', dataset: { help: 'fractal.refine.levels' } }, [el('span', { class: 'text-[11px] text-slate-300', text: t('fractal.refine.levels') }), el('div', { class: 'flex flex-wrap gap-1' }, chips)]),
        pathSlider('fractal.refine.stagger', 'fractal.refine.stagger', 'refine.staggerSec', { min: 0, max: 10, step: 0.1, unit: 's', accent: 'accent-amber' }),
      );
    }
    return el('section', { class: SECTION }, parts);
  }

  function buildSoundRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => P().timbre, edit: (fn, k) => editFractal((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'fractal-timbre' });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'fractal.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-emerald-300`, text: t('fractal.soundTitle'), dataset: { help: 'fractal.gain.source' } }),
      labelled(t('fractal.gain.source'), segmented('fractal.gain.source', GAIN_SOURCES.map((g) => [g, `fractal.gain.${g}`]), () => P().gain.source, (v) => editFractal((d) => { d.gain.source = v; }), 'emerald'), 'fractal.gain.source'),
      pathSlider('fractal.gain.level', 'fractal.gain.level', 'gain.level', { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      pathSlider('fractal.gain.slopeAmount', 'fractal.gain.source', 'gain.slopeAmount', { min: 0, max: 1, step: 0.02, accent: 'accent-emerald' }),
      timbre,
    ]);
  }

  function buildBakeRack() {
    lossEl = el('span', { class: 'font-mono text-[11px] text-fuchsia-200', dataset: { help: 'fractal.tolerance' } });
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-fuchsia-300`, text: t('fractal.bakeTitle'), dataset: { help: 'fractal.bake' } }),
      pathSlider('fractal.bakeRate', 'fractal.bakeRate', 'bake.bakeRate', { min: 50, max: 800, step: 10, integer: true, accent: 'accent-fuchsia' }),
      pathSlider('fractal.tolerance', 'fractal.tolerance', 'bake.tolerance', { min: 0.0005, max: 0.05, step: 0.0005, accent: 'accent-fuchsia' }),
      pathSlider('fractal.voicesMax', 'fractal.voicesMax', 'voicesMax', { min: 1, max: 64, step: 1, integer: true, accent: 'accent-fuchsia' }),
      lossEl,
      el('p', { class: 'text-[11px] leading-snug text-slate-400', text: t('fractal.lossNote'), dataset: { help: 'fractal.bakeGliss' } }),
    ]);
  }

  /** Measure the Glissando fit loss after edits settle (never while playing). / 편집이 멈춘 뒤 측정 */
  function scheduleLoss() {
    if (!lossEl) return;
    const p = P();
    const k = `${getFractalBake(p).sig}|${p.bake.tolerance}|${getLang()}`;
    if (k === lossKey) return;
    lossEl.textContent = t('fractal.lossPending');
    if (lossTimer) clearTimeout(lossTimer);
    if (isFractalPlaying() || appState.transport.playing) { lossKey = ''; return; }
    lossTimer = setTimeout(() => {
      lossTimer = null;
      if (isFractalPlaying()) return;
      const loss = getBakeLoss();
      lossKey = k;
      if (lossEl) lossEl.textContent = t('fractal.loss', loss.anchorsMax, loss.maxErrSt.toFixed(2), loss.rmsErrSt.toFixed(2));
    }, 350);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = P();
    syncers = [];
    canvases?.destroy();
    lossKey = '';
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildModeRack(params), buildMapRack(params), buildRefineRack(params), buildSoundRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getFractalParams, edit: editFractal })), ((r) => { syncers.push(r.sync); return r.root; })(createLineMixRack({ studio: 'fractal', get: getFractalParams, edit: editFractal })), buildBakeRack()]),
      ]),
    );
  }

  function structureKey() {
    const p = P();
    return [getLang(), p.mode, p.fif.points.length, p.refine.enabled, p.canon.subject, p.quantize, maxLevelFor(p)].join('|');
  }

  return {
    render(scopes) {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      const onlyTransport = scopes instanceof Set && scopes.size === 1 && scopes.has('transport');
      if (!onlyTransport) syncers.forEach((fn) => fn());
      canvases?.render();
      scheduleLoss(); // cheap unless the signature changed / 시그니처가 바뀔 때만 측정
    },
    fit() { canvases?.fitMain(); canvases?.resetLens(); },
    destroy() {
      if (lossTimer) clearTimeout(lossTimer);
      lossTimer = null;
      canvases?.destroy();
      canvases = null;
      lossEl = null;
      root.replaceChildren();
      key = '';
    },
  };
}
