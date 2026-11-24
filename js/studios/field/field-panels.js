/**
 * Flexatone — studios/field/field-panels.js
 * Field Studio UI tier: the workspace DOM (particle strip, toolbar, canvases, field / particle /
 * sonification racks). Mounted by ui/studio-host.js when the Field tab is active.
 * 필드 스튜디오 작업 공간 DOM (입자 스트립, 툴바, 캔버스, 필드·입자·음향화 랙).
 *
 * Every control carries data-help="…" for the Option(Alt) inspector, and every number input is
 * picked up by ui/number-scrub.js (type or drag up/down).
 * 모든 컨트롤에 data-help(인스펙터)가 있고, 숫자 입력은 number-scrub이 처리.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { midiToNoteName, noteNameToMidi } from '../../core/units.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { PARAM_SCHEMAS, getEngineLabel } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { createTremoloHost } from '../../ui/tremolo-panel.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { GUIDING_ENGINES, NODE_TYPES, WELL_GRIDS, BOUNDARY_MODES, RETRO_MODES, createParticleVoice, createForceNode, createFieldLayer, FIELD_STEPS, getBakeCount } from './vector-field-engine.js';
import { LAYER_MODES, LAYER_SHAPES } from './field-layers.js';
import { FIELD_ID, getFieldParams, editField, getActiveParticle } from '../field-studio.js';
import { voiceGainControl } from '../../ui/voice-gain.js';
import { createFieldCanvases } from './field-canvases.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { REGION_SHAPES, REGION_TARGETS, REGION_GAIN_MAX, createFieldRegion } from './field-regions.js';
import { exportBakedJson } from './field-audio.js';
import { FIELD_PRESET_IDS, createFieldPreset } from './field-presets.js';
import { HELP_DB } from '../../ui/option-inspector.js';

HELP_DB['fpreset.select'] = {
  en: { title: 'Field preset', summary: 'Replaces the whole Field document with a ready-made field: particles, force nodes, wells, guiding curve and view.', detail: 'One undo step. Default · Vortex choir · Gravity wells · Pure glide (physics off) · Storm · Mirror (retrograde). Choosing a preset again starts it fresh.', formula: '' },
  ko: { title: '필드 프리셋', summary: '필드 문서 전체를 미리 만든 장으로 바꿉니다: 입자, 힘 노드, 우물, 가이드 곡선, 보기.', detail: '실행 취소 1단계. 기본 · 소용돌이 합창 · 중력 우물 · 순수 글리산도(물리 끔) · 폭풍 · 거울(역행). 같은 프리셋을 다시 고르면 처음 상태로 시작합니다.', formula: '' },
};

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

/**
 * Mount the Field workspace into `root`. / 필드 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void }}
 */
export function mountFieldWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  const commit = () => endHistoryGesture();

  const { slider, toggle, select: selectText, labelled } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label) => `field:${label}` });
  const select = (help, options, get, set) => selectText(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set); // options: [value, i18n key]


  /** Delete the active particle (✕ button, Delete / Backspace); the last one stays. / 활성 입자 삭제 */
  function deleteActiveParticle() {
    editField((d) => {
      if (d.voices.length <= 1) return;
      const idx = d.voices.findIndex((x) => x.id === d.activeVoiceId);
      d.voices.splice(Math.max(0, idx), 1);
      d.activeVoiceId = d.voices[Math.max(0, idx - 1)].id;
    });
    commit();
  }
  const editActiveParticle = (fn, coalesceKey = null) => editField((d) => { const v = d.voices.find((x) => x.id === d.activeVoiceId) || d.voices[0]; if (v) fn(v, d); }, { coalesceKey });
  const fieldNum = (k) => () => num(getFieldParams()[k]);
  const setFieldNum = (k) => (val, ck) => editField((d) => { d[k] = val; }, { coalesceKey: ck });
  const pNum = (k) => () => num(getActiveParticle()?.[k]);
  const setPNum = (k) => (val, ck) => editActiveParticle((v) => { v[k] = val; }, ck);
  const setView = (fn) => editField((d) => fn(d.view), { history: false });

  // ------------------------------------------------------------------ strip
  function buildStrip(params) {
    const cards = params.voices.map((v) => {
      const on = v.id === params.activeVoiceId;
      const flag = (field, label, onCls) => {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[10px] font-bold border', text: label, on: { click: (e) => { e.stopPropagation(); editField((d) => { const x = d.voices.find((y) => y.id === v.id); if (x) x[field] = !x[field]; }); commit(); } } });
        syncers.push(() => { const x = getFieldParams().voices.find((y) => y.id === v.id); b.className = `px-1.5 py-0.5 rounded text-[10px] font-bold border ${x?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return b;
      };
      const info = el('div', { class: 'flex justify-between gap-2 text-[11px] font-mono text-slate-300' });
      syncers.push(() => {
        const x = getFieldParams().voices.find((y) => y.id === v.id);
        if (x) info.textContent = `${midiToNoteName(x.f0Midi)} → ${midiToNoteName(x.f1Midi)} · m=${num(x.mass).toFixed(1)} · ${num(x.duration).toFixed(1)}s`;
      });
      return el('div', {
        class: `min-w-[200px] rounded-xl border p-2 flex flex-col gap-1 cursor-pointer transition ${on ? 'bg-slate-900 border-sky-500 shadow-md' : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'field.particleCard' },
        on: { click: () => editField((d) => { d.activeVoiceId = v.id; }, { history: false }) },
      }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('div', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'w-2.5 h-2.5 rounded-full', style: `background:${v.color}` }), el('span', { class: 'text-xs font-bold text-slate-100', text: v.name })]),
          el('div', { class: 'flex gap-1' }, [flag('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'), flag('muted', 'M', 'bg-rose-600 text-white border-rose-500')]),
        ]),
        info,
        el('div', { class: 'flex justify-end' }, [voiceGainControl({ get: () => getFieldParams().voices.find((y) => y.id === v.id)?.baseGain ?? 0.85, set: (val, ck) => editField((dd) => { const x = dd.voices.find((y) => y.id === v.id); if (x) x.baseGain = val; }, { coalesceKey: `field-gain-${v.id}` }), commit, push: (fn) => syncers.push(fn), def: 0.85 })]),
      ]);
    });
    const badge = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono', dataset: { help: 'field.bake' } });
    syncers.push(() => { badge.textContent = t('field.bakeStatus', getFieldParams().voices.length, FIELD_STEPS + 1, getBakeCount()); });
    const bake = (mode) => {
      StudioRegistry.bakeVoices(FIELD_ID, { mode });
      hooks.showToast(t('field.bakedToGliss', getFieldParams().voices.length));
    };
    return el('section', { class: SECTION, dataset: { window: 'list', rack: 'field-voices' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('field.grapher') }),
          el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300', text: t('field.voiceCount', params.voices.length) }),
          badge,
        ]),
        el('div', { class: 'flex flex-wrap gap-1.5' }, [
          el('button', { class: BTN, text: `+ ${t('field.addParticle')}`, dataset: { help: 'field.particleEdit' }, on: { click: () => { editField((d) => { const nv = createParticleVoice(d.voices.length); d.voices.push(nv); d.activeVoiceId = nv.id; }); commit(); } } }),
          el('button', { class: BTN, text: `⧉ ${t('field.dupParticle')}`, dataset: { help: 'field.particleEdit' }, on: { click: () => { editField((d) => {
            const cur = d.voices.find((x) => x.id === d.activeVoiceId) || d.voices[0];
            const copy = { ...JSON.parse(JSON.stringify(cur)), id: createParticleVoice(0).id, name: `${cur.name} R`, color: createParticleVoice(d.voices.length).color, startTime: Number((cur.startTime + cur.duration).toFixed(2)) };
            d.voices.push(copy);
            d.activeVoiceId = copy.id;
          }); commit(); } } }),
          el('button', { class: BTN, text: `✕ ${t('field.delParticle')}`, dataset: { help: 'field.particleEdit' }, on: { click: deleteActiveParticle } }),
          labelled('fpreset.label', select('fpreset.select', [['', 'fpreset.custom'], ...FIELD_PRESET_IDS.map((id) => [id, `fpreset.${id}`])], () => getFieldParams().preset || '', (id) => {
            if (!id) return;
            StudioRegistry.setParams('field', createFieldPreset(id));
            commit();
            hooks.showToast(t('fpreset.applied', t(`fpreset.${id}`)));
          }), 'fpreset.select'), // presets like the other studios / 프리셋
          createTrajectoryImportButton('field'), // Glissando trajectory → this studio / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('field.bakeGliss')}`, dataset: { help: 'field.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('field.bakeAppend'), dataset: { help: 'field.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('field.exportJson')}`, dataset: { help: 'field.exportJson' }, on: { click: () => { exportBakedJson(); hooks.showToast(t('field.jsonDone')); } } }),
        ]),
      ]),
      el('div', { class: 'flex gap-2 overflow-x-auto pb-1' }, cards),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol() {
    const hud = {
      time: el('span', { class: 'text-sky-300', text: '—' }),
      note: el('span', { class: 'text-emerald-300', text: '—' }),
      hz: el('span', { class: 'text-amber-300', text: '—' }),
      vec: el('span', { class: 'text-violet-300', text: '—' }),
      retro: el('span', { class: 'hidden inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-fuchsia-600/30 text-fuchsia-200 border border-fuchsia-500/40', dataset: { help: 'field.retro' } }, [
        el('span', { text: t('field.retroBadge'), dataset: { help: 'field.retro' } }),
        // Retrograde handling chosen right where the notice appears (as-is / retrograde about the reversal start / skip loops)
        // 알림에서 바로 고르는 역행 처리: 그대로 / 역행 시점 기준 retrograde / 루프 건너뜀
        select('field.retroMode', RETRO_MODES.map((m) => [m, `field.retroShort.${m}`]), () => getActiveParticle()?.retroMode || 'unfold', (val) => editActiveParticle((v) => { v.retroMode = val; })),
      ]),
    };
    const main = el('canvas', { class: 'w-full h-[440px] rounded-lg bg-slate-950 block', dataset: { help: 'field.canvas' } });
    const monitor = el('canvas', { class: 'w-full h-[120px] rounded-lg bg-slate-950 block', dataset: { help: 'field.monitor' } });
    const viewSeg = ['piano', 'norm'].map((mode) => {
      const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px]', text: t(mode === 'piano' ? 'view.piano' : 'view.norm'), dataset: { help: 'field.view' }, on: { click: () => setView((vw) => { vw.viewMode = mode; }) } });
      syncers.push(() => { const on = getFieldParams().view.viewMode === mode; b.className = `px-2 py-0.5 rounded text-[11px] ${on ? 'bg-sky-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`; });
      return b;
    });
    // Vector field master ON/OFF (document state, undoable) / 벡터장 전체 ON/OFF (문서 상태, 실행 취소 가능)
    const fieldBtn = el('button', { class: 'px-2 py-1 rounded-md border text-[11px] font-semibold transition', dataset: { help: 'field.fieldToggle' }, on: { click: () => { editField((d) => { d.fieldEnabled = d.fieldEnabled === false; }); commit(); } } });
    syncers.push(() => {
      const on = getFieldParams().fieldEnabled !== false;
      fieldBtn.textContent = t(on ? 'field.fieldOn' : 'field.fieldOff');
      fieldBtn.className = `px-2 py-1 rounded-md border text-[11px] font-semibold transition ${on ? 'bg-violet-600 border-violet-400 text-white' : 'bg-slate-950 border-amber-500/60 text-amber-300'}`;
      fieldBtn.setAttribute('aria-pressed', String(on));
    });
    const locateBtns = createLocateButtons();
    syncers.push(locateBtns.sync);
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      fieldBtn,
      ...locateBtns,
      el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5' }, viewSeg),
      fieldOnlyRack(toggle('field.arrows', 'field.arrows', () => getFieldParams().view.showArrows, () => setView((vw) => { vw.showArrows = !vw.showArrows; }))),
      toggle('field.wells', 'field.wellGrid', () => getFieldParams().view.showWells, () => setView((vw) => { vw.showWells = !vw.showWells; })),
      toggle('field.guide', 'field.guidePull', () => getFieldParams().view.showGuide, () => setView((vw) => { vw.showGuide = !vw.showGuide; })),
      fieldOnlyRack(toggle('field.layersToggle', 'field.layers', () => getFieldParams().view.showLayers !== false, () => setView((vw) => { vw.showLayers = vw.showLayers === false; }))),
      fieldOnlyRack(toggle('field.regionsToggle', 'field.regions', () => getFieldParams().view.showRegions !== false, () => setView((vw) => { vw.showRegions = vw.showRegions === false; }))),
      // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
      createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f)), onTime: (f) => setView((vw) => zoomViewTime(vw, f)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f); zoomViewPitch(vw, f); }), onFit: () => fitField() }),
    ]);
    // Arrow style (view only, not undoable) / 화살표 스타일 (보기 전용)
    const vNum = (k, d) => () => num(getFieldParams().view[k], d);
    const setVNum = (k) => (val) => setView((vw) => { vw[k] = val; });
    const arrowRow = fieldOnlyRack(el('div', { class: 'grid grid-cols-3 gap-3', dataset: { help: 'field.arrowStyle' } }, [
      slider('field.arrowDensity', 'field.arrowStyle', vNum('arrowDensity', 34), setVNum('arrowDensity'), { min: 12, max: 120, step: 1, unit: 'px', accent: 'accent-violet' }),
      slider('field.arrowSize', 'field.arrowStyle', vNum('arrowSize', 1), setVNum('arrowSize'), { min: 0.2, max: 4, step: 0.05, unit: '×', accent: 'accent-violet' }),
      slider('field.arrowWidth', 'field.arrowStyle', vNum('arrowWidth', 1.1), setVNum('arrowWidth'), { min: 0.3, max: 6, step: 0.1, unit: 'px', accent: 'accent-violet' }),
    ]));
    syncers.push(() => arrowRow.classList.toggle('hidden', !getFieldParams().view.showArrows));
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]), el('span', { dataset: { help: 'field.vector' } }, ['F(t,y) ', hud.vec]), hud.retro,
      el('span', { class: 'ml-auto text-[10px] text-slate-500', text: t('field.canvasHint') }),
    ]);
    canvases = createFieldCanvases({ main, monitor, hud }, { requestRender: hooks.requestRender });
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [toolbar, arrowRow, hudRow, main]),
      el('section', { class: SECTION }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('h3', { class: 'text-xs font-semibold text-emerald-300', text: t('field.monitorTitle') }),
          el('span', { class: 'text-[10px] text-slate-500', text: t('field.monitorLegend') }),
        ]),
        monitor,
      ]),
    ]);
  }

  function fitField() {
    const p = getFieldParams();
    let maxT = 3.5;
    let lo = 127;
    let hi = 0;
    for (const v of p.voices) {
      maxT = Math.max(maxT, v.startTime + v.duration + 0.5);
      lo = Math.min(lo, v.f0Midi, v.f1Midi);
      hi = Math.max(hi, v.f0Midi, v.f1Midi);
    }
    setView((vw) => { Object.assign(vw, { tMin: 0, tMax: maxT, midiMin: Math.max(0, lo - 8), midiMax: Math.min(127, hi + 8) }); });
  }

  // ------------------------------------------------------------------ field rack
  function buildGuidingRack(params) {
    const g = params.guiding;
    const parts = [];
    for (const s of PARAM_SCHEMAS[g.engine] || []) {
      if (s.type === 'range') {
        parts.push(slider(s.labelKey, `guide.${g.engine}`, () => num(getFieldParams().guiding[s.key], s.default), (val, ck) => editField((d) => {
          d.guiding[s.key] = s.integer ? Math.round(val) : val;
          if (d.guiding.symLock && s.key === 'x1') d.guiding.x2 = clamp(1 - val, 0.52, 0.95);
        }, { coalesceKey: ck }), { min: s.softMin, max: s.softMax, step: s.step, accent: 'accent-violet' }));
      } else if (s.type === 'toggle') {
        parts.push(toggle(s.labelKey, `guide.${g.engine}`, () => !!(getFieldParams().guiding[s.key] ?? s.default), () => { editField((d) => { d.guiding[s.key] = !(d.guiding[s.key] ?? s.default); }); commit(); }));
      } else if (s.type === 'points') {
        parts.push(slider('field.polyMid', 'guide.polynomial', () => num(getFieldParams().guiding.polyPoints?.[1]?.y, 0.5), (val, ck) => editField((d) => {
          const pts = d.guiding.polyPoints || [];
          if (pts.length < 3) d.guiding.polyPoints = [{ x: 0, y: 0 }, { x: 0.5, y: val }, { x: 1, y: 1 }];
          else pts[1].y = val;
        }, { coalesceKey: ck }), { min: -1, max: 2, step: 0.02, accent: 'accent-violet' }));
      }
    }
    return parts;
  }

  /** Dim + lock a physics-only block while the vector field is OFF. / 벡터장 OFF 시 물리 전용 블록 비활성 */
  function fieldOnlyRack(node) {
    syncers.push(() => { const on = getFieldParams().fieldEnabled !== false; node.classList.toggle('opacity-40', !on); node.classList.toggle('pointer-events-none', !on); });
    return node;
  }

  function buildFieldRack(params) {
    const flowSeg = ['ode', '2d'].map((mode) => {
      const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px]', text: t(`field.flow.${mode}`), dataset: { help: `field.flow.${mode}` }, on: { click: () => { editField((d) => { d.flowMode = mode; }); commit(); } } });
      syncers.push(() => { const on = getFieldParams().flowMode === mode; b.className = `px-2 py-0.5 rounded text-[11px] ${on ? 'bg-violet-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`; });
      return b;
    });
    const tabs = el('div', { class: 'grid grid-cols-3 gap-1' }, GUIDING_ENGINES.map((id) => {
      const on = params.guiding.engine === id;
      return el('button', {
        class: `px-1.5 py-1 rounded-md border text-[11px] truncate transition ${on ? 'bg-violet-600 border-violet-400 text-white font-semibold' : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-600'}`,
        text: getEngineLabel(id, { short: true }),
        title: getEngineLabel(id),
        dataset: { help: `guide.${id}` },
        on: { click: () => { editField((d) => { d.guiding.engine = id; }); commit(); } },
      });
    }));
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('field.fieldTitle') }),
        fieldOnlyRack(el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5' }, flowSeg)),
      ]),
      el('span', { class: 'text-[11px] text-slate-400', text: t('field.guidingSub') }),
      tabs,
      ...buildGuidingRack(params),
      fieldOnlyRack(el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-2' }, [
        slider('field.guidePull', 'field.guidePull', fieldNum('guideAttraction'), setFieldNum('guideAttraction'), { min: 0, max: 5, step: 0.1, accent: 'accent-violet' }),
        labelled('field.wellGrid', select('field.wellGrid', WELL_GRIDS.map((g) => [g, `field.grid.${g}`]), () => getFieldParams().wellGrid, (val) => editField((d) => { d.wellGrid = val; })), 'field.wellGrid'),
        slider('field.wellPull', 'field.wellGrid', fieldNum('wellStrength'), setFieldNum('wellStrength'), { min: 0, max: 2, step: 0.05, accent: 'accent-amber' }),
      ])),
    ]);
  }

  // ------------------------------------------------------------------ field layers
  /**
   * Vector-field layers, listed top → bottom (the stack is evaluated bottom → top).
   * 벡터장 레이어 — 위 → 아래로 표시 (계산은 아래 → 위).
   */
  function buildLayerRack(params) {
    const layers = params.layers || [];
    const getL = (id) => (getFieldParams().layers || []).find((x) => x.id === id);
    const editL = (id, fn, ck = null) => editField((d) => { const L = (d.layers || []).find((x) => x.id === id); if (L) fn(L, d); }, { coalesceKey: ck && `${ck}:${id}` });
    const OPT = { accent: 'accent-violet' };

    const addLocal = () => {
      editField((d) => {
        if (!Array.isArray(d.layers)) d.layers = [];
        const vw = d.view;
        const ts = vw.tMax - vw.tMin;
        const ms = vw.midiMax - vw.midiMin;
        const t0 = Number((vw.tMin + ts * 0.3).toFixed(2));
        const t1 = Number((vw.tMin + ts * 0.6).toFixed(2));
        const m0 = Number((vw.midiMin + ms * 0.35).toFixed(1));
        const m1 = Number((vw.midiMin + ms * 0.65).toFixed(1));
        const n = d.layers.filter((x) => x.id !== 'fl_main').length + 1;
        const L = createFieldLayer({
          name: `${t('field.layer.local')} ${n}`,
          range: { full: false, t0, t1, m0, m1 },
          feather: 0.05,
          nodes: [createForceNode('vortex', Number(((t0 + t1) / 2).toFixed(2)), Number(((m0 + m1) / 2).toFixed(1)))],
        });
        d.layers.push(L); // new layers go on top / 새 레이어는 맨 위
        d.activeLayerId = L.id;
        d.view.showLayers = true;
      });
      commit();
    };
    const move = (id, dir) => {
      editField((d) => {
        const i = d.layers.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.layers.length) return;
        [d.layers[i], d.layers[j]] = [d.layers[j], d.layers[i]];
      });
      commit();
    };

    const cards = layers.map((L, idx) => {
      const active = L.id === params.activeLayerId;
      const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
      const modeSel = select('field.layer.mode', LAYER_MODES.map((md) => [md, `field.layer.mode.${md}`]), () => getL(L.id)?.mode || 'add', (val) => editL(L.id, (x) => { x.mode = val; }));
      modeSel.addEventListener('click', (e) => e.stopPropagation());
      const onBtn = toggle('field.region.on', 'field.layers', () => getL(L.id)?.enabled !== false, stop(() => { editL(L.id, (x) => { x.enabled = x.enabled === false; }); commit(); }));
      const arrow = (txt, dir, help) => el('button', { class: 'px-1 text-slate-400 hover:text-white disabled:opacity-30', text: txt, dataset: { help }, disabled: (dir > 0 ? idx === layers.length - 1 : idx === 0) || undefined, on: { click: stop(() => move(L.id, dir)) } });
      const header = el('div', { class: 'flex items-center gap-1.5 text-[11px]' }, [
        el('span', { class: 'font-mono text-slate-500 w-4 text-right', text: String(idx + 1), title: t('field.layer.orderHint') }),
        el('span', { class: 'font-mono font-bold text-violet-300 truncate max-w-[9rem]', text: L.id === 'fl_main' ? t('field.layer.main') : (L.name || t('field.layer')) }),
        modeSel,
        onBtn,
        el('span', { class: 'ml-auto flex items-center' }, [
          arrow('▲', +1, 'field.layer.order'),
          arrow('▼', -1, 'field.layer.order'),
          el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', on: { click: stop(() => { editField((d) => { d.layers = d.layers.filter((x) => x.id !== L.id); if (d.activeLayerId === L.id) d.activeLayerId = d.layers[d.layers.length - 1]?.id || ''; }); commit(); }) } }),
        ]),
      ]);
      const body = [];
      if (active) {
        const lNum = (k, d = 0) => () => num(getL(L.id)?.[k], d);
        const setLNum = (k) => (val, ck) => editL(L.id, (x) => { x[k] = val; }, ck);
        const rNum = (k) => () => num(getL(L.id)?.range?.[k]);
        const setRNum = (k) => (val, ck) => editL(L.id, (x) => { x.range = { ...x.range, [k]: val }; }, ck);
        const mode = L.mode || 'add';
        if (mode !== 'replace') {
          body.push(slider('field.layer.amount', 'field.layer.amount', lNum('amount', 1), setLNum('amount'), { min: -1, max: 1, step: 0.01, ...OPT }));
        }
        // Range / 범위
        const full = L.range?.full !== false;
        const fullBtn = toggle('field.layer.full', 'field.layer.range', () => getL(L.id)?.range?.full !== false, () => {
          editField((d) => {
            const x = (d.layers || []).find((y) => y.id === L.id);
            if (!x) return;
            const nowFull = x.range?.full !== false;
            if (nowFull) {
              // Leaving full range: start from the visible area / 전체 해제 시 보이는 영역에서 시작
              const vw = d.view;
              x.range = { full: false, t0: Number(vw.tMin.toFixed(2)), t1: Number(vw.tMax.toFixed(2)), m0: Number(vw.midiMin.toFixed(1)), m1: Number(vw.midiMax.toFixed(1)) };
            } else {
              x.range = { ...x.range, full: true };
            }
          });
          commit();
        });
        body.push(el('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 pt-1 flex items-center gap-2' }, [t('field.layer.rangeTitle'), fullBtn]));
        if (!full) {
          const noteName = (k) => { const sp = el('span', { class: 'font-mono text-[10px] text-sky-300' }); syncers.push(() => { sp.textContent = midiToNoteName(Math.round(num(getL(L.id)?.range?.[k]))); }); return sp; };
          body.push(
            el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
              slider('field.layer.t0', 'field.layer.range', rNum('t0'), setRNum('t0'), { min: 0, max: 60, step: 0.01, unit: 's', ...OPT }),
              slider('field.layer.t1', 'field.layer.range', rNum('t1'), setRNum('t1'), { min: 0, max: 60, step: 0.01, unit: 's', ...OPT }),
              el('div', { class: 'flex flex-col' }, [slider('field.layer.m0', 'field.layer.range', rNum('m0'), setRNum('m0'), { min: 0, max: 127, step: 0.5, unit: 'MIDI', ...OPT }), noteName('m0')]),
              el('div', { class: 'flex flex-col' }, [slider('field.layer.m1', 'field.layer.range', rNum('m1'), setRNum('m1'), { min: 0, max: 127, step: 0.5, unit: 'MIDI', ...OPT }), noteName('m1')]),
            ]),
          );
          // Inside / outside and edge / 안·밖과 경계
          const shapeSel = select('field.layer.edge', LAYER_SHAPES.map((sh) => [sh, `field.region.${sh}`]), () => getL(L.id)?.shape || 'rect', (val) => editL(L.id, (x) => { x.shape = val; }));
          const invBtn = toggle('field.region.invert', 'field.layer.invert', () => !!getL(L.id)?.invert, () => { editL(L.id, (x) => { x.invert = !x.invert; }); commit(); });
          const edgeSeg = ['soft', 'hard'].map((kind) => {
            const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px]', text: t(`field.layer.edge.${kind}`), dataset: { help: 'field.layer.edge' }, on: { click: () => {
              editL(L.id, (x) => {
                if (kind === 'hard') { if ((x.feather || 0) > 0) x.softFeather = x.feather; x.feather = 0; }
                else if (!((x.feather || 0) > 0)) x.feather = x.softFeather > 0 ? x.softFeather : 0.08;
              });
              commit();
            } } });
            syncers.push(() => { const hard = !((getL(L.id)?.feather || 0) > 0); const on = kind === 'hard' ? hard : !hard; b.className = `px-2 py-0.5 rounded text-[11px] ${on ? 'bg-violet-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`; });
            return b;
          });
          const featherBox = slider('field.layer.feather', 'field.layer.edge', lNum('feather'), setLNum('feather'), { min: 0, max: 0.5, step: 0.005, ...OPT });
          syncers.push(() => featherBox.classList.toggle('opacity-40', !((getL(L.id)?.feather || 0) > 0)));
          body.push(
            el('div', { class: 'flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300' }, [
              shapeSel,
              invBtn,
              el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5 ml-auto' }, edgeSeg),
            ]),
            featherBox,
          );
        }
        // Content (multiply only scales what is below, so it has none) / 내용 (곱하기는 내용 없음)
        if (mode !== 'multiply') {
          const nodes = (L.nodes || []).map((node) => {
            const getN = () => (getL(L.id)?.nodes || []).find((x) => x.id === node.id);
            const setN = (k) => (val, ck) => editL(L.id, (x) => { const n = (x.nodes || []).find((y) => y.id === node.id); if (n) n[k] = val; }, ck && `${ck}:${node.id}`);
            const pos = el('span', { class: 'font-mono text-slate-400 text-[10px]' });
            syncers.push(() => { const n = getN(); if (n) pos.textContent = `${n.sec.toFixed(2)}s · ${midiToNoteName(Math.round(n.midi))}`; });
            const col = node.type === 'attractor' ? 'text-emerald-300' : node.type === 'repeller' ? 'text-rose-300' : 'text-violet-300';
            return el('div', { class: 'flex flex-col gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1.5', dataset: { help: `field.node.${node.type}` } }, [
              el('div', { class: 'flex items-center justify-between gap-2 text-[11px]' }, [
                el('span', { class: `font-mono font-bold ${col}`, text: t(`field.node.${node.type}`) }),
                pos,
                el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', on: { click: () => { editL(L.id, (x) => { x.nodes = (x.nodes || []).filter((y) => y.id !== node.id); }); commit(); } } }),
              ]),
              slider('field.nodeStrength', `field.node.${node.type}`, () => num(getN()?.strength), setN('strength'), { min: 0.1, max: 3, step: 0.05, ...OPT }),
              slider('field.nodeRadius', `field.node.${node.type}`, () => num(getN()?.radius), setN('radius'), { min: 0.05, max: 0.8, step: 0.01, ...OPT }),
            ]);
          });
          const addNode = (type) => {
            editField((d) => {
              const x = (d.layers || []).find((y) => y.id === L.id);
              if (!x) return;
              const vw = d.view;
              const r = x.range?.full !== false ? { t0: vw.tMin, t1: vw.tMax, m0: vw.midiMin, m1: vw.midiMax } : x.range;
              const f = () => 0.3 + Math.random() * 0.4;
              if (!Array.isArray(x.nodes)) x.nodes = [];
              x.nodes.push(createForceNode(type, Number((r.t0 + (r.t1 - r.t0) * f()).toFixed(2)), Number((r.m0 + (r.m1 - r.m0) * f()).toFixed(1))));
            });
            commit();
          };
          body.push(
            el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-2' }, [
              slider('field.phase', 'field.phase', lNum('fieldPhase'), setLNum('fieldPhase'), { min: 0, max: 1, step: 0.01, ...OPT }),
              slider('field.turbulence', 'field.turbulence', lNum('turbulence'), setLNum('turbulence'), { min: 0, max: 2, step: 0.05, ...OPT }),
              slider('field.turbFreq', 'field.turbulence', lNum('turbFreq', 3.5), setLNum('turbFreq'), { min: 0.5, max: 12, step: 0.1, ...OPT }),
              el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
                slider('field.region.flowAngle', 'field.region.flow', lNum('flowAngle'), setLNum('flowAngle'), { min: -180, max: 180, step: 1, unit: '°', ...OPT }),
                slider('field.region.flowStrength', 'field.region.flow', lNum('flowStrength'), setLNum('flowStrength'), { min: -3, max: 3, step: 0.05, ...OPT }),
              ]),
            ]),
            el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5' }, [
              el('div', { class: 'flex flex-wrap items-center gap-1' }, [
                el('span', { class: 'text-[11px] text-slate-300 mr-1', text: t('field.nodes') }),
                ...NODE_TYPES.map((type) => el('button', { class: BTN, text: `+ ${t(`field.node.${type}`)}`, dataset: { help: `field.node.${type}` }, on: { click: () => addNode(type) } })),
                el('button', { class: `${BTN} ml-auto`, text: t('field.clearNodes'), dataset: { help: 'field.clearNodes' }, on: { click: () => { editL(L.id, (x) => { x.nodes = []; }); commit(); } } }),
              ]),
              ...nodes,
            ]),
          );
        } else {
          body.push(el('span', { class: 'text-[10px] text-slate-500', text: t('field.layer.multiplyNote') }));
        }
      }
      return el('div', {
        class: `flex flex-col gap-1.5 rounded-lg p-1.5 border cursor-pointer ${active ? 'bg-slate-950 border-violet-500/60' : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'field.layers' },
        on: { click: () => { if (!active) editField((d) => { d.activeLayerId = L.id; }, { history: false }); } },
      }, [header, ...body]);
    });

    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('field.layersTitle') }),
        el('button', { class: BTN, text: t('field.layer.addLocal'), dataset: { help: 'field.layers' }, on: { click: addLocal } }),
      ]),
      el('span', { class: 'text-[10px] text-slate-500', text: t('field.layer.stackHint') }),
      layers.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('field.layersEmpty') }),
      // Top of the stack first / 스택 위쪽부터 표시
      ...cards.reverse(),
    ]);
  }

  // ------------------------------------------------------------------ local regions
  function buildRegionRack(params) {
    const regions = params.regions || [];
    const getR = (id) => (getFieldParams().regions || []).find((x) => x.id === id);
    const editR = (id, fn, ck = null) => editField((d) => { const r = (d.regions || []).find((x) => x.id === id); if (r) fn(r, d); }, { coalesceKey: ck && `${ck}:${id}` });
    const add = (shape) => {
      editField((d) => {
        if (!Array.isArray(d.regions)) d.regions = [];
        const vw = d.view;
        const r = createFieldRegion(shape, Number((vw.tMin + (vw.tMax - vw.tMin) * (0.3 + Math.random() * 0.4)).toFixed(2)), Number((vw.midiMin + (vw.midiMax - vw.midiMin) * (0.3 + Math.random() * 0.4)).toFixed(1)));
        d.regions.push(r);
        d.activeRegionId = r.id;
        d.view.showRegions = true;
      });
      commit();
    };

    const cards = regions.map((r, idx) => {
      const active = r.id === params.activeRegionId;
      const flag = (labelKey, help, key, invertSense = false) => toggle(labelKey, help,
        () => { const x = getR(r.id); return invertSense ? x?.[key] !== false : !!x?.[key]; },
        (e) => { e.stopPropagation(); editR(r.id, (x) => { x[key] = invertSense ? x[key] === false : !x[key]; }); commit(); });
      const shapeSel = select('field.regions', REGION_SHAPES.map((sh) => [sh, `field.region.${sh}`]), () => getR(r.id)?.shape || 'rect', (val) => editR(r.id, (x) => { x.shape = val; }));
      shapeSel.addEventListener('click', (e) => e.stopPropagation());
      const header = el('div', { class: 'flex items-center gap-1.5 text-[11px]' }, [
        el('span', { class: 'font-mono font-bold text-cyan-300', text: `${t('field.region')} ${idx + 1}` }),
        shapeSel,
        flag('field.region.on', 'field.regions', 'enabled', true),
        flag('field.region.invert', 'field.region.invert', 'invert'),
        el('button', { class: 'ml-auto text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', on: { click: (e) => { e.stopPropagation(); editField((d) => { d.regions = (d.regions || []).filter((x) => x.id !== r.id); if (d.activeRegionId === r.id) d.activeRegionId = d.regions[d.regions.length - 1]?.id || ''; }); commit(); } } }),
      ]);
      const body = [];
      if (active) {
        const rNum = (k) => () => num(getR(r.id)?.[k]);
        const setRNum = (k) => (val, ck) => editR(r.id, (x) => { x[k] = val; }, ck);
        const gNum = (k) => () => num(getR(r.id)?.gain?.[k], 1);
        const setGNum = (k) => (val, ck) => editR(r.id, (x) => { x.gain = { ...(x.gain || {}), [k]: val }; }, ck);
        const OPT = { accent: 'accent-cyan' };
        body.push(
          el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
            slider('field.region.x', 'field.region.geometry', rNum('x'), setRNum('x'), { min: 0, max: 30, step: 0.01, unit: 's', ...OPT }),
            slider('field.region.y', 'field.region.geometry', rNum('y'), setRNum('y'), { min: 12, max: 120, step: 0.1, unit: 'MIDI', ...OPT }),
            slider('field.region.w', 'field.region.geometry', rNum('w'), setRNum('w'), { min: 0.05, max: 15, step: 0.01, unit: 's', ...OPT }),
            slider('field.region.h', 'field.region.geometry', rNum('h'), setRNum('h'), { min: 0.25, max: 48, step: 0.25, unit: 'st', ...OPT }),
          ]),
          slider('field.region.feather', 'field.region.feather', rNum('feather'), setRNum('feather'), { min: 0, max: 0.4, step: 0.005, ...OPT }),
          el('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 pt-1', text: t('field.region.gainTitle') }),
          el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, REGION_TARGETS.map((k) => slider(`field.region.gain.${k}`, 'field.region.gain', gNum(k), setGNum(k), { min: 0, max: REGION_GAIN_MAX, step: 0.05, unit: '×', ...OPT }))),
          el('div', { class: 'text-[10px] uppercase tracking-wider text-slate-500 pt-1', text: t('field.region.flowTitle') }),
          el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
            slider('field.region.flowAngle', 'field.region.flow', rNum('flowAngle'), setRNum('flowAngle'), { min: -180, max: 180, step: 1, unit: '°', ...OPT }),
            slider('field.region.flowStrength', 'field.region.flow', rNum('flowStrength'), setRNum('flowStrength'), { min: -3, max: 3, step: 0.05, ...OPT }),
          ]),
        );
      }
      return el('div', {
        class: `flex flex-col gap-1.5 rounded-lg p-1.5 border cursor-pointer ${active ? 'bg-slate-950 border-cyan-500/60' : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'field.regions' },
        on: { click: () => { if (!active) editField((d) => { d.activeRegionId = r.id; }, { history: false }); } },
      }, [header, ...body]);
    });

    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-1' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300 mr-1', text: t('field.regionsTitle'), dataset: { help: 'field.regions' } }),
        ...REGION_SHAPES.map((sh) => el('button', { class: BTN, text: `+ ${t(`field.region.${sh}`)}`, dataset: { help: 'field.regions' }, on: { click: () => add(sh) } })),
        el('button', { class: `${BTN} ml-auto`, text: t('field.clearNodes'), dataset: { help: 'field.clearRegions' }, on: { click: () => { editField((d) => { d.regions = []; d.activeRegionId = ''; }); commit(); } } }),
      ]),
      regions.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('field.regionsEmpty') }),
      ...cards,
    ]);
  }

  // ------------------------------------------------------------------ particle + sonify
  function noteInput(side) {
    const inp = el('input', { type: 'text', class: 'w-14 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-center font-mono text-[11px]' });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const m = noteNameToMidi(inp.value);
      if (m === null) { hooks.showToast(t('pitch.invalidNote', inp.value), 'error'); return; }
      editActiveParticle((v) => { v[side] = clamp(m, 21, 108); });
      commit();
    });
    syncers.push(() => { const v = getActiveParticle(); if (v && document.activeElement !== inp) inp.value = midiToNoteName(v[side]); });
    return inp;
  }
  function numberInput(k, min, max, step) {
    const inp = el('input', { type: 'number', min, max, step, class: 'w-16 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
    inp.addEventListener('change', () => { editActiveParticle((v) => { v[k] = clamp(num(inp.value, v[k]), min, max); }); commit(); });
    syncers.push(() => { const v = getActiveParticle(); if (v && document.activeElement !== inp) inp.value = String(roundTo(v[k], 3)); });
    return inp;
  }

  function buildParticleRack() {
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('field.particleTitle') }),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('field.f0', noteInput('f0Midi'), 'field.pitchRange'),
        labelled('field.f1', noteInput('f1Midi'), 'field.pitchRange'),
        labelled('field.start', numberInput('startTime', 0, 120, 0.05), 'field.timing'),
        labelled('field.duration', numberInput('duration', 0.1, 120, 0.05), 'field.timing'),
      ]),
      labelled('field.boundary', select('field.boundary', BOUNDARY_MODES.map((b) => [b, `field.boundary.${b}`]), () => getActiveParticle()?.boundaryMode || 'bounce', (val) => editActiveParticle((v) => { v.boundaryMode = val; })), 'field.boundary'),
      slider('field.mass', 'field.mass', pNum('mass'), setPNum('mass'), { min: 0.2, max: 6, step: 0.1 }),
      slider('field.drag', 'field.drag', pNum('drag'), setPNum('drag'), { min: 0.3, max: 12, step: 0.2 }),
      slider('field.launchAngle', 'field.launch', pNum('launchAngle'), setPNum('launchAngle'), { min: -75, max: 75, step: 1, unit: '°' }),
      slider('field.launchSpeed', 'field.launch', pNum('launchSpeed'), setPNum('launchSpeed'), { min: 0.1, max: 3, step: 0.05 }),
      slider('field.restitution', 'field.boundary', pNum('restitution'), setPNum('restitution'), { min: 0, max: 1, step: 0.05 }),
      slider('field.coupling', 'field.coupling', pNum('coupling'), setPNum('coupling'), { min: -2, max: 2, step: 0.05, accent: 'accent-amber' }),
    ]);
  }

  function buildSonifyRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getActiveParticle()?.timbre, edit: (fn, k) => editActiveParticle((v) => { fn(v.timbre); }, k), sample: true, toast: (m) => hooks.showToast(m), idPrefix: 'field-timbre' });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'field.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('field.sonifyTitle') }),
      labelled('field.retroMode', select('field.retroMode', RETRO_MODES.map((m) => [m, `field.retro.${m}`]), () => getActiveParticle()?.retroMode || 'unfold', (val) => editActiveParticle((v) => { v.retroMode = val; })), 'field.retroMode'),
      slider('field.baseGain', 'field.speedToGain', pNum('baseGain'), setPNum('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      slider('field.speedToGain', 'field.speedToGain', pNum('speedToGain'), setPNum('speedToGain'), { min: 0, max: 1, step: 0.02, accent: 'accent-emerald' }),
      slider('field.curvToBright', 'field.curvToBright', pNum('curvToBright'), setPNum('curvToBright'), { min: 0, max: 1, step: 0.02, accent: 'accent-rose' }),
      timbre,
    ]);
  }

  /** Per-particle tremolo rack (shared panel from ui/tremolo-panel.js). / 입자별 트레몰로 랙 */
  function buildTremoloRack() {
    const section = el('section', { class: SECTION });
    const host = createTremoloHost(section, {
      get: () => getActiveParticle()?.tremolo,
      edit: (fn, k) => editActiveParticle((v) => { v.tremolo = normalizeTremolo(v.tremolo); fn(v.tremolo); v.tremolo = normalizeTremolo(v.tremolo); }, k),
      duration: () => getActiveParticle()?.duration ?? 1,
      envelope: () => null,
      hintKey: 'trem.hintParticle',
    });
    syncers.push(() => host.sync());
    return section;
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = getFieldParams();
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildStrip(params),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildFieldRack(params), fieldOnlyRack(buildLayerRack(params)), fieldOnlyRack(buildRegionRack(params)), buildParticleRack(), buildSonifyRack(), buildTremoloRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getFieldParams, edit: editField }))]), // per-particle tremolo, then the shared studio output tremolo / 입자별 트레몰로 + 공용 스튜디오 출력 트레몰로
      ]),
    );
  }

  function structureKey() {
    const p = getFieldParams();
    const layers = (p.layers || []).map((L) => `${L.id}:${L.name}:${L.id === p.activeLayerId ? `${L.mode}:${L.range?.full !== false}:${(L.nodes || []).map((n) => n.id).join('+')}` : ''}`).join(',');
    return [getLang(), p.activeVoiceId, p.guiding.engine, p.voices.map((v) => v.id).join(','), layers, p.activeLayerId || '', (p.regions || []).map((r) => r.id).join(','), p.activeRegionId || ''].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render();
    },
    fit: fitField,
    deleteSelection: deleteActiveParticle, // Delete / Backspace (ui/studio-host.js)
    destroy() {
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
