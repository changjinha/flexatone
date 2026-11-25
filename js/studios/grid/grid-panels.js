/**
 * Flexatone — studios/grid/grid-panels.js
 * Grid Studio UI tier: the workspace DOM — status strip, the two windows (Editor + Result) with their
 * resize lock, and the racks (space brush, space stack, source & sound, timbre, studio tremolo).
 * Mounted by ui/studio-host.js when the Grid tab is active (registered in ui/workspaces.js).
 * 그리드 스튜디오 작업 공간 DOM (상태 스트립, Editor + Result 두 윈도우와 리사이즈 락, 랙).
 *
 * Shared modules: ui/warp-stack-ui.js (the same stack editor the Draw Studio uses for object
 * effects), ui/studio-controls.js, ui/timbre-editor.js, ui/view-nav.js, ui/studio-tremolo.js,
 * ui/locate-tool.js, ui/trajectory-ui.js, ui/rack-layout.js (every <section> is a movable rack).
 */

import { clamp } from '../../core/math-utils.js';
import { midiToNoteName, noteNameToMidi } from '../../core/units.js';
import { t, getLang } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num, setToggle } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { createSendButton, createReceiveUnavailable } from '../../ui/trajectory-ui.js';
import { createWarpStackRack } from '../../ui/warp-stack-ui.js';
import { LIQUIFY_TOOLS, BRUSH_AXES, PULL_MODES, REGION_FAR } from '../../modules/space-warp.js';
import { GRID_PRESET_IDS, GRID_OWN, GRID_TOOLS, GRID_SEL_KINDS, GRID_CELL, getGridBakeCount } from './grid-engine.js';
import { normalizeDual, resizePane, toggleDualLock, setDualLayout, dualSizes, effectiveLayout, serializeDual, parseDual, DUAL_DEFAULT, DUAL_GAP } from './grid-layout.js';
import { GRID_ID, getGridParams, editGrid, applyGridPreset, getGridBake, getGridLines, gridSourceStudios, fitGridToLines, gridBakeRuns, restoreGridSpace } from '../grid-studio.js';
import { GRID_HELP } from './grid-i18n.js';
import { createGridCanvases, GRID_VIEW_LIMITS } from './grid-canvases.js';
import { exportGridJson, exportGridWav } from './grid-audio.js';

for (const [key, entry] of Object.entries(GRID_HELP)) {
  const mk = ([title, summary, detail, formula]) => ({ title, summary, detail: detail || summary, formula: formula || '' });
  HELP_DB[key] = { en: mk(entry.en), ko: mk(entry.ko) };
}

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BADGE = 'px-2 py-0.5 rounded-full border text-[11px] font-mono whitespace-nowrap';
const BADGE_IDLE = `${BADGE} bg-slate-800 text-slate-300 border-slate-700`;
const H3 = 'text-xs font-bold uppercase tracking-wider';
const ICON_BTN = 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 leading-none shrink-0';
const DUAL_KEY = 'flexatone.grid.dual.v1';

// The window hosts take their height from --gh; an inline height written by the shared corner handle
// (ui/rack-layout.js) is only read as "the user asked for this size". / 윈도우 높이는 --gh로만 결정
if (typeof document !== 'undefined' && !document.getElementById('fx-grid-style')) {
  const st = document.createElement('style');
  st.id = 'fx-grid-style';
  st.textContent = '.fx-grid-host{height:var(--gh,280px) !important;position:relative;min-width:0}.fx-grid-host>canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;border-radius:.5rem;background:#020617}.fx-grid-handle{height:7px;cursor:ns-resize;border-radius:4px;background:rgba(51,65,85,.6)}.fx-grid-handle:hover{background:rgba(56,189,248,.6)}';
  document.head.append(st);
}

/**
 * Mount the Grid workspace into `root`. / 그리드 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountGridWorkspace(root, hooks) {
  let syncers = [];
  let built = '';
  let canvases = null;
  let dual = (() => { try { return parseDual(globalThis.localStorage?.getItem(DUAL_KEY)); } catch { return normalizeDual(null); } })();
  let dualEls = null;
  const commit = () => endHistoryGesture();
  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help, opts) => `grid:${opts.id ?? label}`, narrow: true });
  const segment = (options, get, set, color) => sharedSegment(null, options, get, set, color);
  const stacked = (labelKey, control, help) => el('label', { class: 'flex flex-col gap-0.5 text-[11px] text-slate-300 min-w-0', dataset: { help } }, [el('span', { class: 'truncate', text: t(labelKey) }), control]);
  const P = () => getGridParams();
  const setView = (fn) => editGrid((d) => fn(d.view, d), { history: false });
  const setTool = (fn) => editGrid((d) => fn(d.tool, d), { history: false });
  const studioName = (id) => (id === GRID_OWN ? t('grid.source.own') : t(`studio.${id}`));

  // ------------------------------------------------------------------ status strip
  function buildStrip() {
    const bake = el('span', { class: `${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`, dataset: { help: 'grid.bake' } });
    const runs = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.runs' } });
    const dom = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.range' } });
    syncers.push(() => {
      const p = P();
      const b = getGridBake(p);
      bake.textContent = t('grid.bakeStatus', getGridBakeCount(), b.ms.toFixed(1));
      runs.textContent = t(b.cut ? 'grid.runsCut' : 'grid.runsBadge', getGridLines(p).length, b.runs.length, b.cut);
      runs.className = `${BADGE} ${b.cut || !b.runs.length ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      dom.textContent = t('grid.domBadge', midiToNoteName(b.dom.m0), midiToNoteName(b.dom.m1), b.dom.t1.toFixed(1));
    });
    const bakeTo = (mode) => {
      const total = gridBakeRuns(getGridBake(P())).length;
      const res = StudioRegistry.bakeVoices(GRID_ID, { mode });
      const n = Array.isArray(res.result) ? res.result.length : 0;
      if (!n) { hooks.showToast(t('grid.bakedNone'), 'error'); return; }
      hooks.showToast(t(total > n ? 'grid.bakedCut' : 'grid.bakedToGliss', n, total));
    };
    const preset = select('grid.preset', [['', '—'], ...GRID_PRESET_IDS.map((id) => [id, t(`grid.preset.${id}`)])], () => P().preset, (id) => { if (id) { applyGridPreset(id); hooks.showToast(t('grid.presetApplied', t(`grid.preset.${id}`))); } });
    const seed = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'grid.seed' } });
    seed.addEventListener('change', () => { editGrid((d) => { d.seed = Math.round(clamp(num(seed.value, d.seed), 0, 999999)); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seed) seed.value = String(P().seed); });
    return el('section', { class: SECTION, dataset: { rack: 'grid-strip' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [el('h2', { class: `${H3} text-sky-300 mr-1`, text: t('grid.title') }), bake, runs, dom]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          createReceiveUnavailable('grid.trajNa'), // the Source menu reads every line of a studio instead / 대신 소스 메뉴가 스튜디오의 모든 선을 읽음
          createSendButton('grid'),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.preset' } }, [t('grid.preset'), preset]),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.seed' } }, [t('grid.seed'), seed]),
          el('button', { class: BTN, text: `🎲 ${t('grid.reseed')}`, dataset: { help: 'grid.seed' }, on: { click: () => { const s = Math.floor(Math.random() * 999999) + 1; editGrid((d) => { d.seed = s; }); commit(); hooks.showToast(t('grid.reseeded', s)); } } }),
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('grid.bakeGliss')}`, dataset: { help: 'grid.bakeGliss' }, on: { click: () => bakeTo('replace') } }),
          el('button', { class: BTN, text: t('grid.bakeAppend'), dataset: { help: 'grid.bakeGliss' }, on: { click: () => bakeTo('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('grid.exportJson')}`, dataset: { help: 'grid.exportJson' }, on: { click: () => { exportGridJson(); hooks.showToast(t('grid.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('grid.exportWav')}`, dataset: { help: 'grid.exportWav' }, on: { click: async () => {
            hooks.showToast(t('toast.wavStart'));
            try { const res = await exportGridWav(); hooks.showToast(res.ok ? t('toast.wavDone', res.filename) : res.message, res.ok ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
          } } }),
        ]),
      ]),
      el('span', { class: 'text-[11px] text-slate-400', text: t('grid.concept'), dataset: { help: 'app.studio.grid' } }),
    ]);
  }

  // ------------------------------------------------------------------ the two windows
  const saveDual = () => { try { globalThis.localStorage?.setItem(DUAL_KEY, serializeDual(dual)); } catch { /* session only */ } };
  function applyDual() {
    if (!dualEls) return;
    const w = Math.max(240, dualEls.host.clientWidth || 600);
    const sz = dualSizes(dual, w);
    dualEls.host.style.flexDirection = sz.layout === 'side' ? 'row' : 'column';
    dualEls.lockBar.style.flexDirection = sz.layout === 'side' ? 'column' : 'row';
    dualEls.hostE.style.setProperty('--gh', `${sz.editor.h}px`);
    dualEls.hostR.style.setProperty('--gh', `${sz.result.h}px`);
    dualEls.lockBtn.textContent = dual.lock ? '🔒' : '🔓';
    dualEls.lockBtn.title = t(dual.lock ? 'grid.lock.on' : 'grid.lock.off');
    dualEls.lockBtn.className = `${ICON_BTN} ${dual.lock ? '' : '!bg-amber-600/40 !border-amber-400 !text-amber-100'}`;
    dualEls.lockNote.textContent = dual.lock ? '' : t('grid.lock.note');
    setToggle(dualEls.layoutBtn, effectiveLayout(dual, w) === 'side');
    dualEls.layoutBtn.textContent = dual.layout === 'side' ? `◫ ${t('grid.layout.side')}` : `⊟ ${t('grid.layout.stack')}`;
    hooks.requestRender(['grid']);
  }
  const setDual = (next) => { dual = normalizeDual(next); saveDual(); applyDual(); };

  function buildWindows() {
    const hud = { time: el('span', { class: 'text-sky-300', text: '—' }), note: el('span', { class: 'text-emerald-300', text: '—' }), hz: el('span', { class: 'text-amber-300', text: '—' }) };
    const editor = el('canvas', { dataset: { help: 'grid.win.editor' } });
    const result = el('canvas', { dataset: { help: 'grid.win.result' } });
    const hostE = el('div', { class: 'fx-grid-host' }, [editor]);
    const hostR = el('div', { class: 'fx-grid-host' }, [result]);
    const handle = (pane) => {
      const h = el('div', { class: 'fx-grid-handle', title: t('grid.resizeHandle'), dataset: { help: 'grid.lock' } });
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const y0 = e.clientY;
        const h0 = pane === 'editor' ? dual.hE : dual.hR;
        try { h.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        const move = (ev) => setDual(resizePane(dual, pane, h0 + (ev.clientY - y0)));
        const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
        h.addEventListener('pointermove', move);
        h.addEventListener('pointerup', up);
        h.addEventListener('pointercancel', up);
      });
      h.addEventListener('dblclick', () => setDual(resizePane(dual, pane, DUAL_DEFAULT.hE)));
      return h;
    };
    // DOM order: Result first (the shared Screenshot takes the largest canvas, the first on a tie); CSS order shows the Editor first
    // DOM 순서는 Result 먼저 (공용 스크린샷이 Result를 저장), 화면은 Editor 먼저
    const paneR = el('div', { class: 'flex flex-col gap-1 min-w-0 flex-1', style: 'order:3' }, [hostR, handle('result')]);
    const paneE = el('div', { class: 'flex flex-col gap-1 min-w-0 flex-1', style: 'order:1' }, [hostE, handle('editor')]);
    const lockBtn = el('button', { class: ICON_BTN, dataset: { help: 'grid.lock' }, on: { click: () => setDual(toggleDualLock(dual)) } });
    const lockNote = el('span', { class: 'text-[10.5px] text-amber-300', dataset: { help: 'grid.lock' } });
    const lockBar = el('div', { class: 'flex items-center justify-center gap-2 shrink-0', style: 'order:2' }, [lockBtn, lockNote]);
    const host = el('div', { class: 'flex min-w-0 flex-1', style: `gap:${DUAL_GAP}px` }, [paneR, lockBar, paneE]);
    const layoutBtn = el('button', { class: `fx-toggle ${BTN}`, dataset: { help: 'grid.layout' }, title: '\\', on: { click: () => setDual(setDualLayout(dual, dual.layout === 'side' ? 'stack' : 'side')) } });
    const seen = { editor: hostE.style.height, result: hostR.style.height };
    const mo = new MutationObserver(() => {
      for (const [pane, node] of [['editor', hostE], ['result', hostR]]) {
        const v = node.style.height;
        if (v === seen[pane]) continue;
        seen[pane] = v;
        const px = parseFloat(v);
        setDual(resizePane(dual, pane, Number.isFinite(px) ? px : DUAL_DEFAULT.hE));
      }
    });
    mo.observe(hostE, { attributes: true, attributeFilter: ['style'] });
    mo.observe(hostR, { attributes: true, attributeFilter: ['style'] });
    let lastW = 0;
    const ro = globalThis.ResizeObserver ? new ResizeObserver(() => { const w = host.clientWidth; if (Math.abs(w - lastW) > 1) { lastW = w; applyDual(); } }) : null;
    ro?.observe(host);
    dualEls = { host, hostE, hostR, lockBtn, lockNote, lockBar, layoutBtn, mo, ro };

    const shot = select('grid.shot', ['result', 'editor', 'both'].map((k) => [k, t(`grid.shot.${k}`)]), () => P().tool.shot, (k) => setTool((tl) => { tl.shot = k; }));
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      layoutBtn,
      toggle('grid.showGrid', 'grid.showGrid', () => P().view.showGrid, () => setView((vw) => { vw.showGrid = !vw.showGrid; })),
      toggle('grid.showGhost', 'grid.showGhost', () => P().view.showGhost, () => setView((vw) => { vw.showGhost = !vw.showGhost; })),
      toggle('grid.showStrokes', 'grid.showStrokes', () => P().view.showStrokes, () => setView((vw) => { vw.showStrokes = !vw.showStrokes; })),
      ...createLocateButtons({ unavailable: 'grid.locateNa' }), // the lines belong to the source studio / 선은 소스 스튜디오의 것
      createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f, null, GRID_VIEW_LIMITS)), onTime: (f) => setView((vw) => zoomViewTime(vw, f, null, GRID_VIEW_LIMITS)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f, null, GRID_VIEW_LIMITS); zoomViewPitch(vw, f, null, GRID_VIEW_LIMITS); }), onFit: () => fitGrid() }),
      el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.shot' } }, [shot, el('button', { class: BTN, text: `📷 ${t('grid.shotBtn')}`, dataset: { help: 'grid.shot' }, on: { click: () => canvases?.screenshot(P().tool.shot) } })]),
    ]);
    const toolRow = buildToolRow();
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400', dataset: { help: 'grid.hud' } }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('grid.canvasHint') }),
    ]);
    canvases = createGridCanvases({ editor, result, hud }, { requestRender: hooks.requestRender, showToast: hooks.showToast });
    return el('section', { class: SECTION, dataset: { rack: 'grid-window' } }, [toolbar, toolRow, hudRow, host]);
  }

  // ------------------------------------------------------------------ monitor toolbox: tools, selection, restore
  const setMode = (mode) => setTool((tl) => { tl.mode = mode; });
  const clearSel = () => setTool((tl) => { tl.sel = null; });
  function doRestore() {
    const res = restoreGridSpace();
    commit();
    if (res.ok) hooks.showToast(t(res.scope === 'all' ? 'grid.restore.doneAll' : 'grid.restore.doneSel'));
    else hooks.showToast(t(`grid.restore.${res.reason}`), res.reason === 'full' ? 'error' : 'info');
  }

  /** One-line description of the selection. / 선택 영역 요약 */
  function selInfo(sel) {
    if (!sel) return t('grid.selNone');
    const xs = sel.poly.map((q) => q[0]).filter((x) => Math.abs(x) < REGION_FAR / 2);
    const ys = sel.poly.map((q) => q[1]).filter((y) => Math.abs(y) < REGION_FAR / 2);
    const tt = (x) => (x * GRID_CELL.ut).toFixed(2);
    const nn = (y) => midiToNoteName(Math.round(y * GRID_CELL.um));
    const lo = (a) => Math.min(...a);
    const hi = (a) => Math.max(...a);
    if (sel.kind === 'selPitch') return t('grid.selInfo.selPitch', nn(lo(ys)), nn(hi(ys)));
    if (sel.kind === 'selTime') return t('grid.selInfo.selTime', tt(lo(xs)), tt(hi(xs)));
    if (sel.kind === 'selBox') return t('grid.selInfo.selBox', tt(lo(xs)), tt(hi(xs)), nn(lo(ys)), nn(hi(ys)));
    return t('grid.selInfo.selLasso', sel.poly.length);
  }

  function buildToolRow() {
    const tools = el('div', { class: 'flex flex-wrap gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5', dataset: { help: 'grid.tools' } }, GRID_TOOLS.map((mode) => {
      const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px] whitespace-nowrap', text: t(`grid.tool.${mode}`), title: t(`grid.tool.tip.${mode}`), dataset: { help: mode === 'pull' ? 'grid.pull' : mode === 'brush' ? 'grid.brush' : 'grid.tools' }, on: { click: () => setMode(mode) } });
      syncers.push(() => { const on = P().tool.mode === mode; b.className = `px-2 py-0.5 rounded text-[11px] whitespace-nowrap ${on ? (mode === 'pull' ? 'bg-orange-600 text-white font-semibold' : mode === 'brush' ? 'bg-violet-600 text-white font-semibold' : 'bg-yellow-500 text-slate-950 font-semibold') : 'text-slate-400 hover:text-white'}`; });
      return b;
    }));
    const info = el('span', { class: 'font-mono text-[11px] text-yellow-200/90 truncate max-w-[16rem]', dataset: { help: 'grid.tools' } });
    const deselect = el('button', { class: BTN, text: `✕ ${t('grid.selClear')}`, dataset: { help: 'grid.tools' }, on: { click: clearSel } });
    const feather = el('input', { type: 'number', min: 0, max: 200, step: 0.5, class: 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'grid.pull' } });
    feather.addEventListener('keydown', (e) => e.stopPropagation());
    feather.addEventListener('change', () => setTool((tl) => { tl.feather = clamp(num(feather.value, tl.feather), 0, 200); }));
    const pullMode = segment(PULL_MODES.map((k) => [k, t(`grid.pullMode.${k}`), 'grid.pull']), () => P().tool.pullMode, (v) => setTool((tl) => { tl.pullMode = v; }), 'orange');
    const restore = el('button', { class: 'px-2.5 py-1 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-[11px] font-semibold whitespace-nowrap', dataset: { help: 'grid.restore' }, on: { click: doRestore } });
    syncers.push(() => {
      const p = P();
      info.textContent = selInfo(p.tool.sel);
      deselect.disabled = !p.tool.sel;
      deselect.style.opacity = p.tool.sel ? '1' : '0.45';
      if (document.activeElement !== feather) feather.value = String(p.tool.feather);
      restore.textContent = t(p.tool.sel ? 'grid.restore.sel' : 'grid.restore.all');
    });
    return el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      tools, info, deselect,
      el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.pull' } }, [t('grid.feather'), feather, el('span', { class: 'text-slate-500', text: t('grid.unit.cells') })]),
      el('span', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.pull' } }, [t('grid.pullMode'), pullMode]),
      el('span', { class: 'ml-auto' }), restore,
    ]);
  }

  function fitGrid() {
    setView((vw) => { Object.assign(vw, fitGridToLines()); });
  }

  // ------------------------------------------------------------------ racks
  function buildBrushRack() {
    const count = el('span', { class: 'text-[11px] text-slate-400' });
    syncers.push(() => { count.textContent = t('warp.liq.count', P().space.find((x) => x.type === 'liquify')?.params.ops.length || 0); });
    const editLiq = (fn) => { editGrid((d) => { const it = d.space.find((x) => x.type === 'liquify'); if (it) fn(it); d.preset = ''; }); commit(); };
    return el('section', { class: SECTION, dataset: { rack: 'grid-brush' } }, [
      el('h3', { class: `${H3} text-violet-300`, text: `〰 ${t('grid.brushTitle')}`, dataset: { help: 'grid.brush' } }),
      el('span', { class: 'text-[11px] text-slate-400', text: t('grid.brushHint') }),
      segment(LIQUIFY_TOOLS.map((k) => [k, t(`grid.liq.${k}`), 'grid.brush']), () => P().tool.liq, (v) => setTool((q) => { q.liq = v; }), 'violet'),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('grid.brushSize', 'grid.brush', () => num(P().tool.size), (val) => setTool((q) => { q.size = val; }), { min: 1, max: 120, step: 0.5, unit: t('grid.unit.cells'), compact: true, accent: 'accent-violet', def: 10 }),
        slider('grid.brushStrength', 'grid.brush', () => num(P().tool.strength), (val) => setTool((q) => { q.strength = val; }), { min: 0.01, max: 1, step: 0.01, compact: true, accent: 'accent-violet', def: 0.6 }),
      ]),
      el('details', { class: 'group rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1', dataset: { help: 'grid.brushDetail' } }, [
        el('summary', { class: 'cursor-pointer select-none text-[11px] font-semibold text-violet-200', text: `⚙ ${t('grid.brushDetail')}` }),
        el('div', { class: 'flex flex-col gap-1.5 pt-1.5' }, [
          el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
            slider('grid.brushHardness', 'grid.brushDetail', () => num(P().tool.hardness), (val) => setTool((q) => { q.hardness = val; }), { min: 0, max: 0.95, step: 0.01, compact: true, accent: 'accent-violet', def: 0 }),
            slider('grid.brushAspect', 'grid.brushDetail', () => num(P().tool.aspect), (val) => setTool((q) => { q.aspect = val; }), { min: 0.1, max: 10, step: 0.05, compact: true, accent: 'accent-violet', def: 1 }),
            slider('grid.brushAngle', 'grid.brushDetail', () => num(P().tool.angle), (val) => setTool((q) => { q.angle = val; }), { min: -90, max: 90, step: 1, unit: '°', compact: true, accent: 'accent-violet', def: 0 }),
            slider('grid.brushSmooth', 'grid.brushDetail', () => num(P().tool.smooth), (val) => setTool((q) => { q.smooth = val; }), { min: 0, max: 0.95, step: 0.01, compact: true, accent: 'accent-violet', def: 0 }),
          ]),
          el('div', { class: 'flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300', dataset: { help: 'grid.brushDetail' } }, [
            t('grid.brushAxis'),
            segment(BRUSH_AXES.map((k) => [k, t(`grid.brushAxis.${k}`), 'grid.brushDetail']), () => P().tool.axis, (v) => setTool((q) => { q.axis = v; }), 'violet'),
          ]),
          el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
            toggle('grid.brushClip', 'grid.brushDetail', () => P().tool.clip, () => setTool((q) => { q.clip = !q.clip; })),
            el('button', { class: BTN, text: `↺ ${t('grid.brushReset')}`, dataset: { help: 'grid.brushDetail' }, on: { click: () => setTool((q) => { Object.assign(q, { liq: 'push', size: 10, strength: 0.6, hardness: 0, aspect: 1, angle: 0, axis: 'both', smooth: 0, clip: true }); }) } }),
          ]),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        count,
        el('button', { class: BTN, text: `↶ ${t('warp.liq.undo')}`, dataset: { help: 'grid.brush' }, on: { click: () => editLiq((it) => { it.params.ops.pop(); }) } }),
        el('button', { class: BTN, text: t('warp.liq.reset'), dataset: { help: 'grid.brush' }, on: { click: () => editLiq((it) => { it.params.ops = []; }) } }),
      ]),
    ]);
  }

  function buildSpaceRack() {
    const r = createWarpStackRack({
      titleKey: 'grid.spaceTitle', hintKey: 'grid.spaceHint', rackId: 'grid-space', help: 'grid.space', color: 'text-amber-300',
      get: () => P().space,
      edit: (fn, opts = {}) => editGrid((d) => { fn(d.space); d.preset = ''; }, { coalesceKey: opts.coalesceKey || null }),
      toast: hooks.showToast,
    });
    syncers.push(r.sync);
    return r.root;
  }

  function noteInput(k, lo, hi) {
    const inp = el('input', { type: 'text', class: 'w-full min-w-[3.5rem] px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-center font-mono text-[11px] text-sky-200' });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const raw = inp.value.trim();
      const m = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : noteNameToMidi(raw);
      if (m === null || !Number.isFinite(m)) { hooks.showToast(t('pitch.invalidNote', inp.value), 'error'); return; }
      editGrid((d) => { d.range[k] = Math.round(clamp(m, lo, hi)); d.range.auto = false; });
      commit();
    });
    syncers.push(() => { if (document.activeElement !== inp) inp.value = midiToNoteName(P().range.auto ? getGridBake(P()).dom[k === 'pLo' ? 'm0' : 'm1'] : P().range[k]); });
    return inp;
  }

  function buildSourceRack() {
    const src = select('grid.source', gridSourceStudios().map((id) => [id, studioName(id)]), () => P().source.studio, (id) => { editGrid((d) => { d.source.studio = id; Object.assign(d.view, fitGridToLines(d)); }); });
    const note = el('span', { class: 'text-[11px] text-slate-400' });
    syncers.push(() => { const p = P(); const n = getGridLines(p).length; note.textContent = n ? t('grid.sourceNote', n, studioName(p.source.studio)) : t('grid.sourceEmpty', studioName(p.source.studio)); note.className = `text-[11px] ${n ? 'text-slate-400' : 'text-amber-300'}`; });
    const length = el('input', { type: 'number', min: 1, max: 600, step: 0.5, class: 'w-full px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200' });
    length.addEventListener('change', () => { editGrid((d) => { d.range.length = clamp(num(length.value, d.range.length), 1, 600); d.range.auto = false; }); commit(); });
    syncers.push(() => { if (document.activeElement !== length) length.value = String(P().range.auto ? getGridBake(P()).dom.t1 : P().range.length); });
    const soundNote = el('span', { class: 'text-[11px] text-slate-400' });
    syncers.push(() => { const p = P(); soundNote.textContent = t(p.source.studio === 'glissando' ? `grid.soundNote.${p.sound}` : 'grid.soundNote.other'); });
    return el('section', { class: SECTION, dataset: { rack: 'grid-source' } }, [
      el('h3', { class: `${H3} text-emerald-300`, text: t('grid.sourceTitle'), dataset: { help: 'grid.source' } }),
      labelled('grid.source', src, 'grid.source'),
      note,
      el('h3', { class: `${H3} text-slate-300 pt-1`, text: t('grid.rangeTitle'), dataset: { help: 'grid.range' } }),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        toggle('grid.rangeAuto', 'grid.range', () => P().range.auto, () => { editGrid((d) => { if (d.range.auto) { const b = getGridBake(P()).dom; Object.assign(d.range, { pLo: b.m0, pHi: b.m1, length: b.t1 }); } d.range.auto = !d.range.auto; }); commit(); }),
      ]),
      el('div', { class: 'grid grid-cols-3 gap-2' }, [stacked('grid.pLo', noteInput('pLo', 0, 120), 'grid.range'), stacked('grid.pHi', noteInput('pHi', 6, 132), 'grid.range'), stacked('grid.length', length, 'grid.range')]),
      el('h3', { class: `${H3} text-slate-300 pt-1`, text: t('grid.soundTitle'), dataset: { help: 'grid.sound' } }),
      segment([['source', t('grid.sound.source'), 'grid.sound'], ['grid', t('grid.sound.grid'), 'grid.sound']], () => P().sound, (v) => editGrid((d) => { d.sound = v; })),
      soundNote,
      slider('grid.gain', 'grid.gain', () => num(P().gain), (val, ck) => editGrid((d) => { d.gain = val; }, { coalesceKey: ck }), { min: 0, max: 2, step: 0.01, compact: true, def: 0.8 }),
    ]);
  }

  function buildTimbreRack() {
    const ed = createTimbreEditor({ get: () => P().timbre, edit: (fn, k) => editGrid((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'grid-timbre' });
    syncers.push(ed.sync);
    const sec = el('section', { class: SECTION, dataset: { rack: 'grid-timbre' } }, [
      el('h3', { class: `${H3} text-violet-300`, text: t('grid.timbreTitle'), dataset: { help: 'grid.timbre' } }),
      el('span', { class: 'text-[11px] text-slate-400', text: t('grid.timbreHint') }),
      el('div', { class: 'min-w-0', dataset: { help: 'grid.timbre' } }, [ed.root]),
    ]);
    // used when the lines have no sound of their own / 선에 자체 소리가 없을 때 사용
    syncers.push(() => { const p = P(); sec.style.opacity = p.source.studio === 'glissando' && p.sound === 'source' ? '0.55' : '1'; });
    return sec;
  }

  function buildTremoloRack() {
    const r = createStudioTremoloRack({ get: getGridParams, edit: editGrid, studio: 'grid' });
    syncers.push(r.sync);
    // The per-voice tremolo / vibrato block stays in its place, switched off: the voices belong to the
    // source studio (set it there). / 보이스별 트레몰로·비브라토는 제자리에 꺼진 채로 (보이스는 소스 스튜디오의 것)
    const vm = r.root.querySelector?.('[data-rack="voice-mod"]');
    if (vm) {
      vm.classList.add('opacity-60');
      vm.setAttribute('aria-disabled', 'true');
      vm.title = t('grid.vmodOff');
      for (const n of vm.querySelectorAll('input, button, select, canvas')) { n.disabled = true; n.style.pointerEvents = 'none'; }
      vm.append(el('p', { class: 'text-[11px] text-amber-300', text: t('grid.vmodOff') }));
    }
    return r.root;
  }

  // ------------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const tg = e.target;
    if (tg?.tagName === 'INPUT' || tg?.tagName === 'TEXTAREA' || tg?.tagName === 'SELECT' || tg?.isContentEditable) return;
    if (appState.manager?.open || document.querySelector('dialog[open], .fx-traj-dialog')) return;
    if (e.key === '[' || e.key === ']') { const f = e.key === ']' ? 1.25 : 0.8; setTool((tl) => { tl.size = clamp(Math.round(tl.size * f * 2) / 2, 1, 120); }); return; }
    if (e.key === '\\') setDual(setDualLayout(dual, dual.layout === 'side' ? 'stack' : 'side'));
    if (e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === 'b') setMode('brush');
    else if (k === 'v') setMode('pull');
    else if (k === 's') { const m = P().tool.mode; const i = GRID_SEL_KINDS.indexOf(m); setMode(GRID_SEL_KINDS[(i + 1) % GRID_SEL_KINDS.length]); }
    else if (e.key === 'Escape' && P().tool.sel) clearSel(); // the app's Esc (stop) still runs / 앱의 Esc(정지)도 그대로 동작
  };
  document.addEventListener('keydown', onKey);

  function teardownDual() {
    dualEls?.mo.disconnect();
    dualEls?.ro?.disconnect();
    dualEls = null;
  }

  function build() {
    syncers = [];
    canvases?.destroy();
    teardownDual();
    root.replaceChildren(
      buildStrip(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [buildWindows()]),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildBrushRack(), buildSpaceRack(), buildSourceRack(), buildTimbreRack(), buildTremoloRack()]),
      ]),
    );
    applyDual();
  }

  return {
    render() {
      const key = `${getLang()}|${gridSourceStudios().join()}`;
      if (key !== built) { built = key; build(); }
      for (const fn of syncers) fn();
      canvases?.render();
    },
    fit: fitGrid,
    destroy() {
      document.removeEventListener('keydown', onKey);
      canvases?.destroy();
      canvases = null;
      teardownDual();
      root.replaceChildren();
      built = '';
    },
  };
}
