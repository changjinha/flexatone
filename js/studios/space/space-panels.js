/**
 * Flexatone — studios/space/space-panels.js
 * Space Studio UI tier: the workspace DOM (header + actions, source strip, scene / observed-pitch /
 * lane canvases, medium · path · motion · effects racks). Mounted by ui/studio-host.js when the
 * Space tab is active. Also registers the `space.*` help entries in the Option(Alt) inspector.
 * 스페이스 스튜디오 작업 공간 DOM과 `space.*` 도움말 등록.
 *
 * Every control carries data-help="space.…"; every number input is picked up by ui/number-scrub.js.
 * Slider drags coalesce into one undo step (coalesceKey + endHistoryGesture on change).
 * 슬라이더 드래그 1회 = 실행 취소 1단계.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { getEngineLabel } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import {
  SPACE_PATH_TYPES, PROFILE_ENGINES, SPACE_PRESETS, BAKE_RATES, PAN_MODES,
  createSpacePreset, createRandomScene, createSource, trajectoryPolyline, sampleBake, pathLength, effectiveC, getSpaceBakeCount,
} from './space-engine.js';
import { SPACE_HELP } from './space-i18n.js';
import { SPACE_ID, getSpaceParams, editSpace, getActiveSource, getSpaceBake } from '../space-studio.js';
import { createSpaceCanvases, sceneTime } from './space-canvases.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { exportSpaceJson, exportSpaceWav, refreshSpaceAudio } from './space-audio.js';

// Help entries for the Option(Alt) inspector (existing keys win). / 도움말 등록 (기존 키 우선)
for (const [k, v] of Object.entries(SPACE_HELP)) if (!HELP_DB[k]) HELP_DB[k] = v;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

/**
 * Mount the Space workspace into `root`. / 스페이스 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountSpaceWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  const commit = () => endHistoryGesture();

  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label) => `space:${label}` });
  /** Delete the active source (✕ button, Delete / Backspace); the last one stays. / 활성 음원 삭제 */
  function deleteActiveSource() {
    editSpace((d) => {
      if (d.sources.length <= 1) return;
      const i = d.sources.findIndex((x) => x.id === d.activeSourceId);
      d.sources.splice(Math.max(0, i), 1);
      d.activeSourceId = d.sources[Math.max(0, i - 1)].id;
    });
    commit();
  }
  const seg = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  const readout = (help) => { const s = el('span', { class: 'font-mono text-[11px] text-slate-300', dataset: { help } }); return s; };

  // Document accessors / 문서 접근자
  const docNum = (k) => () => num(getSpaceParams()[k]);
  const setDocNum = (k) => (v, ck) => editSpace((d) => { d[k] = v; }, { coalesceKey: ck });
  const editActive = (fn, ck = null) => editSpace((d) => { const s = getActiveSource(d); if (s) fn(s, d); }, { coalesceKey: ck && `${ck}:${getSpaceParams().activeSourceId}` });
  const srcNum = (path) => () => num(path.split('.').reduce((o, k) => o?.[k], getActiveSource()));
  const setSrcNum = (path, round = null) => (v, ck) => editActive((s) => {
    const keys = path.split('.');
    const last = keys.pop();
    const o = keys.reduce((x, k) => x[k], s);
    o[last] = round === 'int' ? Math.round(v) : v;
  }, ck);
  const setView = (fn) => editSpace((d) => fn(d), { history: false });

  // ------------------------------------------------------------------ header + strip
  function buildHeader(params) {
    const bakeBadge = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono', dataset: { help: 'space.bake' } });
    const vcBadge = el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] font-mono text-slate-300', dataset: { help: 'space.maxVc' } });
    const superBadge = el('span', { class: 'hidden px-2 py-0.5 rounded-full bg-rose-600/30 text-rose-200 border border-rose-500/40 text-[11px] font-semibold', text: t('space.supersonic'), dataset: { help: 'space.supersonic' } });
    syncers.push(() => {
      const p = getSpaceParams();
      const b = getSpaceBake(p);
      let samples = 0;
      for (const x of b.sources.values()) samples += x.n;
      bakeBadge.textContent = t('space.bakeStatus', p.sources.length, samples, getSpaceBakeCount(), b.ms.toFixed(1));
      vcBadge.textContent = t('space.maxVcBadge', b.maxVc.toFixed(3));
      vcBadge.className = `px-2 py-0.5 rounded-full text-[11px] font-mono ${b.maxVc > 0.7 ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40' : 'bg-slate-800 text-slate-300'}`;
      superBadge.classList.toggle('hidden', !b.clamped);
    });
    const bake = (mode) => {
      StudioRegistry.bakeVoices(SPACE_ID, { mode });
      hooks.showToast(`${t('space.bakedToGliss', Math.min(64, getSpaceParams().sources.length))} ${t('space.bakeLossToast')}`);
    };
    const presetSel = select('space.preset', [['', t('space.presetPick')], ...SPACE_PRESETS.map((id) => [id, t(`space.preset.${id}`)])], () => '', (id) => {
      if (!id) return;
      editSpace((d) => { Object.assign(d, createSpacePreset(id)); });
      commit();
      fitView();
      hooks.showToast(t('space.presetApplied', t(`space.preset.${id}`)));
    });
    const seedNum = el('input', { type: 'number', min: 1, max: 99999, step: 1, class: 'w-16 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]', dataset: { help: 'space.random' } });
    seedNum.addEventListener('change', () => { editSpace((d) => { d.seed = clamp(Math.round(num(seedNum.value, d.seed)), 1, 99999); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seedNum) seedNum.value = String(getSpaceParams().seed); });
    const random = () => {
      const seed = getSpaceParams().seed + 1;
      editSpace((d) => { Object.assign(d, createRandomScene(seed)); });
      commit();
      fitView();
      hooks.showToast(t('space.randomApplied', seed));
    };
    const cards = params.sources.map((s) => {
      const on = s.id === params.activeSourceId;
      const flag = (field, label, onCls) => {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[11px] font-bold border', text: label, dataset: { help: 'space.sourceCard' }, on: { click: (e) => { e.stopPropagation(); editSpace((d) => { const x = d.sources.find((y) => y.id === s.id); if (x) x[field] = !x[field]; }); commit(); } } });
        syncers.push(() => { const x = getSpaceParams().sources.find((y) => y.id === s.id); b.className = `px-1.5 py-0.5 rounded text-[11px] font-bold border ${x?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return b;
      };
      const info = el('div', { class: 'flex justify-between gap-2 text-[11px] font-mono text-slate-300' });
      syncers.push(() => {
        const x = getSpaceParams().sources.find((y) => y.id === s.id);
        if (!x) return;
        const f = x.f.mode === 'curve' ? `${Math.round(x.f.hz0)}→${Math.round(x.f.hz1)} Hz` : `${roundTo(x.f.hz, 1)} Hz`;
        const v = x.speed.mode === 'curve' ? `${x.speed.from}→${x.speed.to}` : `${x.speed.value}`;
        info.textContent = `${t(`space.path.${x.path.type}`)} · ${v} m/s · ${f}`;
      });
      return el('div', {
        class: `min-w-[210px] rounded-xl border p-2 flex flex-col gap-1 cursor-pointer transition ${on ? 'bg-slate-900 border-sky-500 shadow-md' : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'space.sourceCard' },
        on: { click: () => editSpace((d) => { d.activeSourceId = s.id; }, { history: false }) },
      }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('div', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'w-2.5 h-2.5 rounded-full', style: `background:${s.color}` }), el('span', { class: 'text-xs font-bold text-slate-100', text: s.name })]),
          el('div', { class: 'flex gap-1' }, [flag('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'), flag('muted', 'M', 'bg-rose-600 text-white border-rose-500')]),
        ]),
        info,
      ]);
    });
    const add = () => { editSpace((d) => { const n = createSource(d.sources.length, { name: `${t('space.source')} ${d.sources.length + 1}` }); d.sources.push(n); d.activeSourceId = n.id; }); commit(); };
    const dup = () => {
      editSpace((d) => {
        const cur = getActiveSource(d);
        if (!cur || d.sources.length >= 64) return;
        const copy = createSource(d.sources.length, { ...JSON.parse(JSON.stringify(cur)), id: undefined, name: `${cur.name} R` });
        copy.color = createSource(d.sources.length).color;
        copy.start = roundTo(cur.start + 1, 2);
        d.sources.push(copy);
        d.activeSourceId = copy.id;
      });
      commit();
    };
    const del = deleteActiveSource;
    const wav = async () => {
      hooks.showToast(t('toast.wavStart'));
      try { const r = await exportSpaceWav(); hooks.showToast(r.message, r.ok ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('studio.space'), dataset: { help: 'space.header' } }),
          el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] text-slate-300', text: t('space.sourceCount', params.sources.length) }),
          bakeBadge, vcBadge, superBadge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          presetSel,
          el('button', { class: BTN, text: `🎲 ${t('space.random')}`, dataset: { help: 'space.random' }, on: { click: random } }),
          seedNum,
          createTrajectoryImportButton('space'), // Glissando trajectory → this studio / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('space.bakeGliss')}`, dataset: { help: 'space.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('space.bakeAppend'), dataset: { help: 'space.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('space.exportJson')}`, dataset: { help: 'space.exportJson' }, on: { click: () => { exportSpaceJson(); hooks.showToast(t('space.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('space.exportWav')}`, dataset: { help: 'space.exportWav' }, on: { click: wav } }),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        el('div', { class: 'flex gap-2 overflow-x-auto pb-1 min-w-0 flex-1' }, cards),
        el('div', { class: 'flex gap-1.5' }, [
          el('button', { class: BTN, text: `+ ${t('space.addSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: add } }),
          el('button', { class: BTN, text: `⧉ ${t('space.dupSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: dup } }),
          el('button', { class: BTN, text: `✕ ${t('space.delSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: del } }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ canvases
  function buildCanvasCol() {
    const scene = el('canvas', { class: 'w-full h-[420px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'space.scene' } });
    const obs = el('canvas', { class: 'w-full h-[210px] rounded-lg bg-slate-950 block', dataset: { help: 'space.obs' } });
    const lanes = el('canvas', { class: 'w-full h-[190px] rounded-lg bg-slate-950 block', dataset: { help: 'space.lanes' } });
    const ro = {
      t: el('span', { class: 'text-sky-300' }), ratio: el('span', { class: 'text-emerald-300' }), fobs: el('span', { class: 'text-amber-300' }),
      vr: el('span', { class: 'text-orange-300' }), r: el('span', { class: 'text-violet-300' }), az: el('span', { class: 'text-cyan-300' }), g: el('span', { class: 'text-slate-300' }),
    };
    syncers.push(() => {
      const p = getSpaceParams();
      const s = getActiveSource(p);
      const b = s && getSpaceBake(p).sources.get(s.id);
      const T = sceneTime();
      ro.t.textContent = `${T.toFixed(2)} s`;
      const fo = sampleBake(b, 'fObs', T);
      if (!Number.isFinite(fo)) {
        for (const k of ['ratio', 'fobs', 'vr', 'r', 'az', 'g']) ro[k].textContent = '—';
        ro.fobs.textContent = t('space.silent');
        return;
      }
      const fs = sampleBake(b, 'fs', T);
      ro.fobs.textContent = `${fo.toFixed(2)} / ${fs.toFixed(2)} Hz`;
      ro.ratio.textContent = `×${(fo / fs).toFixed(4)} (${(12 * Math.log2(fo / fs)).toFixed(2)} st)`;
      ro.vr.textContent = `${sampleBake(b, 'vr', T).toFixed(2)} m/s`;
      ro.r.textContent = `${sampleBake(b, 'r', T).toFixed(2)} m`;
      ro.az.textContent = `${sampleBake(b, 'az', T).toFixed(1)}°`;
      ro.g.textContent = `${(20 * Math.log10(Math.max(1e-6, sampleBake(b, 'gain', T)))).toFixed(1)} dB`;
    });
    const zoom = (f) => () => setView((d) => { d.view.span = roundTo(clamp(d.view.span * f, 10, 3000), 2); });
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      seg('space.tool', [['move', 'space.toolMove'], ['draw', 'space.toolDraw']], () => getSpaceParams().tool, (v) => setView((d) => { d.tool = v; })),
      el('span', { class: 'text-[11px] text-slate-500 ml-1', text: t('space.zoom') }),
      el('button', { class: BTN, text: '−', dataset: { help: 'space.zoom' }, on: { click: zoom(1.25) } }),
      el('button', { class: BTN, text: '+', dataset: { help: 'space.zoom' }, on: { click: zoom(0.8) } }),
      el('button', { class: BTN, text: t('zoom.fit'), dataset: { help: 'space.fit' }, on: { click: () => fitView() } }),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('space.sceneHint') }),
    ]);
    const roRow = el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400', dataset: { help: 'space.readout' } }, [
      el('span', {}, ['t ', ro.t]), el('span', {}, ['f_obs/f_s ', ro.fobs]), el('span', {}, [ro.ratio]),
      el('span', {}, ['v_r ', ro.vr]), el('span', {}, ['r ', ro.r]), el('span', {}, ['θ ', ro.az]), el('span', {}, ['g ', ro.g]),
    ]);
    canvases = createSpaceCanvases({ scene, obs, lanes }, { requestRender: hooks.requestRender });
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [toolbar, roRow, scene]),
      el('section', { class: SECTION }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 'text-xs font-semibold text-emerald-300', text: t('space.obsTitle') }),
          el('span', { class: 'text-[11px] text-slate-500', text: t('space.obsLegend') }),
        ]),
        // Shared zoom toolbar (ui/view-nav.js) for the time canvases / 시간 캔버스용 공용 줌 툴바
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          ...(() => { const b = createLocateButtons(); syncers.push(b.sync); return b; })(), // shared ✥ Locate / 🧲 Snap
          createZoomBar({ onPitch: (f) => canvases?.zoomTimeCanvases('pitch', f), onTime: (f) => canvases?.zoomTimeCanvases('time', f), onBoth: (f) => canvases?.zoomTimeCanvases('both', f), onFit: () => canvases?.fitTimeCanvases() }),
          el('span', { class: 'text-[11px] text-slate-500', text: t('view.navHint') }),
        ]),
        obs,
        lanes,
      ]),
    ]);
  }

  /** Frame every trajectory and the listener; time axis = audible end. / 보기 맞춤 */
  function fitView() {
    canvases?.fitTimeCanvases(); // F / Fit All also resets the time canvases / 시간 캔버스도 함께 맞춤
    const p = getSpaceParams();
    let x0 = p.listener.x - 10;
    let x1 = p.listener.x + 10;
    let y0 = p.listener.y - 10;
    let y1 = p.listener.y + 10;
    for (const s of p.sources) for (const q of trajectoryPolyline(s, p)) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const aspect = 420 / Math.max(300, root.querySelector('canvas')?.clientWidth || 700);
    const span = clamp(Math.max(x1 - x0, (y1 - y0) / aspect) * 1.12, 10, 3000);
    const end = getSpaceBake(p).endSec;
    setView((d) => { d.view = { cx: roundTo(0.5 * (x0 + x1), 2), cy: roundTo(0.5 * (y0 + y1), 2), span: roundTo(span, 2) }; d.length = roundTo(clamp(end + 0.5, 1, 300), 1); });
  }

  // ------------------------------------------------------------------ racks
  function buildMediumRack() {
    const cEff = readout('space.cScale');
    syncers.push(() => { const p = getSpaceParams(); cEff.textContent = t('space.cEff', effectiveC(p).toFixed(1), getSpaceBake(p).maxVc.toFixed(3)); });
    const setL = (k) => (v, ck) => editSpace((d) => { d.listener[k] = v; }, { coalesceKey: ck });
    const getL = (k) => () => num(getSpaceParams().listener[k]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('space.mediumTitle') }),
      slider('space.c', 'space.c', docNum('c'), setDocNum('c'), { min: 100, max: 1500, step: 1, unit: 'm/s' }),
      slider('space.cScale', 'space.cScale', docNum('cScale'), setDocNum('cScale'), { min: 0.05, max: 1, step: 0.01, unit: '×', accent: 'accent-amber' }),
      cEff,
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.airDist', 'space.airDist', docNum('airDist'), setDocNum('airDist'), { min: 1, max: 500, step: 1, unit: 'm' }),
        slider('space.refDist', 'space.refDist', docNum('refDist'), setDocNum('refDist'), { min: 0.1, max: 20, step: 0.1, unit: 'm' }),
      ]),
      el('div', { class: 'border-t border-slate-800 pt-2 text-[11px] uppercase tracking-wider text-slate-500', text: t('space.listener') }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.lx', 'space.listener', getL('x'), setL('x'), { min: -500, max: 500, step: 0.5, unit: 'm' }),
        slider('space.ly', 'space.listener', getL('y'), setL('y'), { min: -500, max: 500, step: 0.5, unit: 'm' }),
      ]),
      slider('space.heading', 'space.heading', getL('headingDeg'), setL('headingDeg'), { min: -180, max: 180, step: 1, unit: '°' }),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('space.panMode', select('space.panMode', PAN_MODES.map((m) => [m, t(`space.panMode.${m}`)]), () => getSpaceParams().panMode, (v) => editSpace((d) => { d.panMode = v; })), 'space.panMode'),
        labelled('space.bakeRate', select('space.bakeRate', BAKE_RATES.map((r) => [String(r), `${r} Hz`]), () => getSpaceParams().bakeRate, (v) => editSpace((d) => { d.bakeRate = Number(v); })), 'space.bakeRate'),
      ]),
      slider('space.length', 'space.length', docNum('length'), (v) => setView((d) => { d.length = v; }), { min: 1, max: 120, step: 0.5, unit: 's' }),
    ]);
  }

  function buildPathRack(src) {
    const type = src.path.type;
    const P = (k) => `path.${k}`;
    const S = (labelKey, k, opt, help = `space.path.${type}`) => slider(labelKey, help, srcNum(P(k)), setSrcNum(P(k), opt.int ? 'int' : null), opt);
    const XY = { min: -500, max: 500, step: 0.5, unit: 'm' };
    const R = { min: 0.5, max: 400, step: 0.5, unit: 'm' };
    const ANG = { min: 0, max: 360, step: 1, unit: '°' };
    const grid = (...c) => el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, c);
    const onL = () => toggle('space.onListener', 'space.onListener', () => !!getActiveSource()?.path.onListener, () => { editActive((s) => { s.path.onListener = !s.path.onListener; }); commit(); });
    const dir = () => toggle('space.ccw', 'space.dir', () => num(getActiveSource()?.path.dir, 1) > 0, () => { editActive((s) => { s.path.dir = num(s.path.dir, 1) > 0 ? -1 : 1; }); commit(); });
    const body = [];
    if (type === 'line') body.push(grid(S('space.x0', 'x0', XY), S('space.y0', 'y0', XY), S('space.x1', 'x1', XY), S('space.y1', 'y1', XY)));
    else if (type === 'orbit') body.push(el('div', { class: 'flex gap-1.5' }, [onL(), dir()]), grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.rx', 'rx', R), S('space.ry', 'ry', R)), S('space.phase', 'phase', ANG));
    else if (type === 'lissajous') body.push(grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.ax', 'ax', R), S('space.ay', 'ay', R), S('space.la', 'a', { min: 1, max: 7, step: 1, int: true }), S('space.lb', 'b', { min: 1, max: 7, step: 1, int: true })), S('space.delta', 'delta', ANG));
    else if (type === 'spiral') body.push(el('div', { class: 'flex gap-1.5' }, [onL(), dir()]), grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.r0', 'r0', { ...R, min: 0 }), S('space.r1', 'r1', { ...R, min: 0 })), grid(S('space.turns', 'turns', { min: 0.1, max: 8, step: 0.1 }), S('space.phase', 'phase', ANG)));
    else if (type === 'static') body.push(grid(S('space.sx', 'x', XY), S('space.sy', 'y', XY)));
    else if (type === 'draw') {
      const info = readout('space.path.draw');
      syncers.push(() => { const s = getActiveSource(); if (s) info.textContent = t('space.drawInfo', s.path.points.length, pathLength(s, getSpaceParams().listener).toFixed(1)); });
      body.push(info, el('span', { class: 'text-[11px] text-slate-500', text: t('space.drawHint') }));
    }
    const lenInfo = readout('space.speed');
    syncers.push(() => {
      const p = getSpaceParams();
      const s = getActiveSource(p);
      if (!s) return;
      const travel = s.speed.mode === 'const' ? s.speed.value * s.duration : NaN;
      lenInfo.textContent = t('space.lengthInfo', pathLength(s, p.listener).toFixed(1), Number.isFinite(travel) ? travel.toFixed(1) : '—');
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('space.pathTitle') }),
        select('space.pathType', SPACE_PATH_TYPES.map((p) => [p, t(`space.path.${p}`)]), () => getActiveSource()?.path.type || 'line', (v) => editActive((s) => { s.path.type = v; })),
      ]),
      ...body,
      el('div', { class: 'border-t border-slate-800 pt-2 grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.start', 'space.timing', srcNum('start'), setSrcNum('start'), { min: 0, max: 120, step: 0.05, unit: 's' }),
        slider('space.duration', 'space.timing', srcNum('duration'), setSrcNum('duration'), { min: 0.1, max: 120, step: 0.05, unit: 's' }),
      ]),
      slider('space.height', 'space.height', srcNum('path.h'), setSrcNum('path.h'), { min: 0, max: 100, step: 0.5, unit: 'm' }),
      lenInfo,
    ]);
  }

  function buildProfileRack(src) {
    const engines = PROFILE_ENGINES.map((e) => [e, getEngineLabel(e, { short: true })]);
    const curveCtl = (field, help) => el('div', { class: 'flex items-center gap-1.5' }, [
      labelled('space.profileEngine', select('space.profileEngine', engines, () => getActiveSource()?.[field].curve.engine || 'harmonic', (v) => editActive((s) => { s[field].curve = { engine: v, reverse: !!s[field].curve.reverse, inverse: false }; })), 'space.profileEngine'),
      toggle('space.reverse', help, () => !!getActiveSource()?.[field].curve.reverse, () => { editActive((s) => { s[field].curve.reverse = !s[field].curve.reverse; }); commit(); }),
    ]);
    const modeSeg = (field, help) => seg(help, [['const', 'space.mode.const'], ['curve', 'space.mode.curve']], () => getActiveSource()?.[field].mode, (v) => editActive((s) => { s[field].mode = v; }));
    const SPD = { min: 0, max: 400, step: 0.5, unit: 'm/s', accent: 'accent-amber' };
    const HZ = { min: 20, max: 4000, step: 0.01, unit: 'Hz', accent: 'accent-emerald' };
    const speedBody = src.speed.mode === 'curve'
      ? [el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [slider('space.from', 'space.speedCurve', srcNum('speed.from'), setSrcNum('speed.from'), SPD), slider('space.to', 'space.speedCurve', srcNum('speed.to'), setSrcNum('speed.to'), SPD)]), curveCtl('speed', 'space.speedCurve')]
      : [slider('space.speedValue', 'space.speed', srcNum('speed.value'), setSrcNum('speed.value'), SPD)];
    const pitchBody = src.f.mode === 'curve'
      ? [el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [slider('space.hz0', 'space.pitchCurve', srcNum('f.hz0'), setSrcNum('f.hz0'), HZ), slider('space.hz1', 'space.pitchCurve', srcNum('f.hz1'), setSrcNum('f.hz1'), HZ)]), curveCtl('f', 'space.pitchCurve')]
      : [slider('space.hz', 'space.pitch', srcNum('f.hz'), setSrcNum('f.hz'), HZ)];
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('space.speedTitle') }), modeSeg('speed', 'space.speed')]),
      ...speedBody,
      el('div', { class: 'border-t border-slate-800 pt-2 flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('space.pitchTitle') }), modeSeg('f', 'space.pitch')]),
      ...pitchBody,
    ]);
  }

  function buildEffectsRack() {
    const flag = (k) => toggle(`space.fx.${k}`, `space.${k}`, () => getActiveSource()?.[k] !== false, () => { editActive((s) => { s[k] = s[k] === false; }); commit(); });
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getActiveSource()?.timbre, edit: (fn, k) => editActive((s) => { fn(s.timbre); }, k), sample: true, toast: (m) => hooks.showToast(m), idPrefix: 'space-timbre' });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'space.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-rose-300', text: t('space.fxTitle') }),
      el('div', { class: 'flex flex-wrap gap-1.5' }, ['doppler', 'distanceGain', 'airAbsorb', 'pan'].map(flag)),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.fxHint') }),
      slider('space.baseGain', 'space.baseGain', srcNum('baseGain'), setSrcNum('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      timbre,
      el('span', { class: 'text-[11px] text-slate-500', dataset: { help: 'space.bakeLoss' }, text: t('space.bakeLoss') }),
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = getSpaceParams();
    const src = getActiveSource(params);
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildHeader(params),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildMediumRack(), buildPathRack(src), buildProfileRack(src), buildEffectsRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getSpaceParams, edit: editSpace }))]),
      ]),
    );
  }

  function structureKey() {
    const p = getSpaceParams();
    const s = getActiveSource(p);
    return [getLang(), p.activeSourceId, s?.path.type, s?.speed.mode, s?.f.mode, p.sources.map((x) => `${x.id}:${x.name}:${x.color}`).join(',')].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render();
      refreshSpaceAudio();
    },
    fit: fitView,
    deleteSelection: deleteActiveSource, // Delete / Backspace (ui/studio-host.js)
    destroy() {
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
