/**
 * Flexatone — studios/grid/grid-panels.js
 * Grid Studio UI tier: the workspace DOM — status strip, the two windows (Editor + Result) with their
 * resize lock, the tool column, and the racks (tool, layers, timbre, effect stack, output-stage
 * effects, grid / render settings, studio tremolo). Mounted by ui/studio-host.js when the Grid tab is
 * active (registered in ui/workspaces.js).
 * 그리드 스튜디오 작업 공간 DOM (상태 스트립, Editor + Result 두 윈도우와 리사이즈 락, 도구 열, 랙).
 *
 * Shared modules are used throughout (one implementation for every studio): ui/studio-controls.js,
 * ui/timbre-editor.js, ui/view-nav.js, ui/studio-tremolo.js, ui/locate-tool.js, ui/trajectory-ui.js,
 * ui/rack-layout.js (every <section> is a movable rack). Effect cards are generated from the effect
 * registry's schema, so a new effect needs no UI code.
 * 공용 모듈 사용. 효과 카드는 레지스트리 스키마에서 자동 생성 → 새 효과에 UI 코드가 필요 없음.
 */

import { clamp } from '../../core/math-utils.js';
import { midiToNoteName, noteNameToMidi } from '../../core/units.js';
import { t, getLang, pickLocalized } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num, setToggle } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN, STUDIO_SELECT } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { createSendButton, createReceiveUnavailable } from '../../ui/trajectory-ui.js';
import {
  GRID_TOOLS, GRID_PRESET_IDS, GRID_COLORMAPS, GRID_SELECT_KINDS, GRID_MASKS, GRID_QUALITIES, GRID_BINS, GRID_ROWS_PER_SEMI, GRID_MAX_LAYERS, GRID_MAX_STACK, GRID_LAYER_COLORS,
  gridShape, gridDims, activeLayer, matrixItems, bankItem, fitGridView, createGridLayer, createStackItem, emptyRaster, getGridBakeCount, getGridBakeStats, peekGridBake, encodeRaster,
} from './grid-engine.js';
import { GridEffectRegistry, sanitizeEffectParams, LIQUIFY_TOOLS, NOISE_COLORS, CHROMA_RATIOS, CHROMA_CHANNELS, chromaRatio } from './grid-effects.js';
import { normalizeDual, resizePane, toggleDualLock, setDualLayout, dualSizes, effectiveLayout, serializeDual, parseDual, DUAL_DEFAULT, DUAL_GAP } from './grid-layout.js';
import { GRID_ID, getGridParams, editGrid, editGridShape, applyGridPreset, onGridBake, getGridEditLatency, gridBakeLoss, gridBakeLines } from '../grid-studio.js';
import { GRID_HELP } from './grid-i18n.js';
import { createGridCanvases, GRID_VIEW_LIMITS } from './grid-canvases.js';
import { exportGridJson, exportGridWav, isGridPlaying, getGridEngineKind, getGridLiveStat, onGridLiveStat, getGridRenderStats } from './grid-audio.js';

// Register the help entries once (HELP_DB is a plain mutable object). / 도움말 등록
for (const [key, entry] of Object.entries(GRID_HELP)) {
  const mk = ([title, summary, detail, formula]) => ({ title, summary, detail: detail || summary, formula: formula || '' });
  if (!HELP_DB[key]) HELP_DB[key] = { en: mk(entry.en), ko: mk(entry.ko) };
}

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BADGE = 'px-2 py-0.5 rounded-full border text-[11px] font-mono whitespace-nowrap';
const BADGE_IDLE = `${BADGE} bg-slate-800 text-slate-300 border-slate-700`;
const H3 = 'text-xs font-bold uppercase tracking-wider';
const CARD = 'flex flex-col gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-2 min-w-0';
const ICON_BTN = 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 leading-none shrink-0';
const NUM = 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200';
const DUAL_KEY = 'flexatone.grid.dual.v1';
const TOOL_ICON = { brush: '🖌', eraser: '⌫', line: '╱', rect: '▭', ellipse: '◯', bucket: '🪣', gradient: '◐', eyedropper: '💧', select: '⬚', mask: '◩', liquify: '〰' };
/** Tool shortcuts. L (loop), M (Manager), F (fit) and H (help) are taken app-wide, so the line is U and the mask is Q. */
const TOOL_KEY = { b: 'brush', e: 'eraser', u: 'line', r: 'rect', o: 'ellipse', k: 'bucket', g: 'gradient', i: 'eyedropper', s: 'select', q: 'mask', w: 'liquify' };
const COLS_PER_SEC = [2, 4, 8, 12, 16, 24, 32];

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
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void, deleteSelection: () => void }}
 */
export function mountGridWorkspace(root, hooks) {
  let staticSync = [];
  let rackSync = [];
  let sink = staticSync;
  let hosts = null;
  let langKey = '';
  let rackKey = '';
  let canvases = null;
  let dual = (() => { try { return parseDual(globalThis.localStorage?.getItem(DUAL_KEY)); } catch { return normalizeDual(null); } })();
  let dualEls = null; // { host, hostE, hostR, lockBtn, seenE, seenR, mo, ro }
  const folded = new Set(); // effect cards folded by the user (UI only) / 접힌 효과 카드
  const commit = () => endHistoryGesture();
  const offs = [];

  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => sink.push(fn), commit, keyOf: (label, help, opts) => `grid:${opts.id ?? label}`, narrow: true });
  const segment = (options, get, set, color) => sharedSegment(null, options, get, set, color);
  const stacked = (labelKey, control, help) => el('label', { class: 'flex flex-col gap-0.5 text-[11px] text-slate-300 min-w-0', dataset: { help } }, [el('span', { class: 'truncate', text: t(labelKey) }), control]);

  const P = () => getGridParams();
  const L = () => activeLayer(P());
  const setView = (fn) => editGrid((d) => fn(d.view, d), { history: false });
  const setTool = (fn) => editGrid((d) => fn(d.tool, d), { history: false });
  const editLayer = (fn, opts = {}) => editGrid((d) => { const l = d.layers.find((q) => q.id === d.activeLayerId) || d.layers[0]; fn(l, d); }, opts);
  const editItem = (id, fn, opts = {}) => editLayer((l) => { const it = l.stack.find((q) => q.id === id); if (it) fn(it, l); }, opts);
  const toolNum = (k) => () => num(P().tool[k]);
  const setToolNum = (k) => (val) => setTool((tl) => { tl[k] = val; });
  const fxName = (type) => pickLocalized(GridEffectRegistry.get(type).name, getLang());

  // ------------------------------------------------------------------ status strip
  function buildStrip() {
    const bake = el('span', { class: `${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`, dataset: { help: 'grid.bake' } });
    const stages = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.stages' } });
    const dimsB = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.dims' } });
    const active = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.budget' } });
    const engine = el('span', { class: BADGE_IDLE, dataset: { help: 'grid.engine' } });
    const loss = el('span', { class: 'text-[11px] text-slate-400', dataset: { help: 'grid.bakeLoss' } });
    sink.push(() => {
      const p = P();
      const full = peekGridBake(p);
      const st = getGridBakeStats();
      bake.textContent = full ? t('grid.bakeStatus', getGridBakeCount(), st.ms.toFixed(0)) : t('grid.bakePending', getGridBakeCount());
      bake.className = `${BADGE} ${full ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' : 'bg-amber-500/15 text-amber-300 border-amber-500/40'}`;
      stages.textContent = t('grid.stagesBadge', st.recomputed, st.total, getGridEditLatency().toFixed(0));
      const d = gridDims(p);
      dimsB.textContent = t('grid.dimsBadge', d.F, d.N, d.rate, d.bps);
      dimsB.className = `${BADGE} ${d.downgraded ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      const live = getGridLiveStat();
      const rs = getGridRenderStats();
      const playing = isGridPlaying();
      active.textContent = playing ? t('grid.activeBadge', live.active, p.render.maxActive) : rs.maxActive ? t('grid.renderBadge', rs.maxActive, rs.blockMs.toFixed(2)) : t('grid.activeIdle', p.render.maxActive);
      active.className = `${BADGE} ${playing && live.count > p.render.maxActive ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      const kind = playing ? getGridEngineKind() : null;
      engine.textContent = t(`grid.engineBadge.${kind || 'idle'}`);
      engine.className = `${BADGE} ${kind === 'osc' ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : kind ? 'bg-sky-500/15 text-sky-300 border-sky-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      loss.textContent = `${t('grid.lossTitle')}: ${gridBakeLoss(p).map((k) => t(`grid.loss.${k}`)).join(' · ')}`;
    });
    const bakeTo = (mode) => {
      const p = P();
      const total = gridBakeLines(p).total;
      const res = StudioRegistry.bakeVoices(GRID_ID, { mode });
      const n = Array.isArray(res.result) ? res.result.length : 0;
      if (!n) { hooks.showToast(t('grid.bakedNone'), 'error'); return; }
      hooks.showToast(t(total > n ? 'grid.bakedCut' : 'grid.bakedToGliss', n, total, gridBakeLoss(p).map((k) => t(`grid.loss.${k}`)).join(', ')));
    };
    const preset = select('grid.preset', [['', '—'], ...GRID_PRESET_IDS.map((id) => [id, t(`grid.preset.${id}`)])], () => P().preset, (id) => {
      if (!id) return;
      applyGridPreset(id);
      hooks.showToast(t('grid.presetApplied', t(`grid.preset.${id}`)));
    });
    const seed = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'grid.seed' } });
    seed.addEventListener('change', () => { editGrid((d) => { d.render.seed = Math.round(clamp(num(seed.value, d.render.seed), 0, 999999)); }); commit(); });
    sink.push(() => { if (document.activeElement !== seed) seed.value = String(P().render.seed); });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden' });
    file.addEventListener('change', async () => { const f = file.files?.[0]; file.value = ''; if (f) await canvases?.importImage(f); });

    return el('section', { class: SECTION, dataset: { rack: 'grid-strip' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('h2', { class: `${H3} text-sky-300 mr-1`, text: t('grid.title') }),
          bake, stages, dimsB, active, engine,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          createReceiveUnavailable('grid.trajNa'),
          createSendButton('grid'), // this studio's ridge lines → another studio / Master / 보내기
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.preset' } }, [t('grid.preset'), preset]),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.seed' } }, [t('grid.seed'), seed]),
          el('button', { class: BTN, text: `🎲 ${t('grid.reseed')}`, dataset: { help: 'grid.seed' }, on: { click: () => {
            const s = Math.floor(Math.random() * 999999) + 1;
            editGrid((d) => { d.render.seed = s; });
            commit();
            hooks.showToast(t('grid.reseeded', s));
          } } }),
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('grid.bakeGliss')}`, dataset: { help: 'grid.bakeGliss' }, on: { click: () => bakeTo('replace') } }),
          el('button', { class: BTN, text: t('grid.bakeAppend'), dataset: { help: 'grid.bakeGliss' }, on: { click: () => bakeTo('append') } }),
          el('button', { class: BTN, text: `🖼 ${t('grid.importImage')}`, dataset: { help: 'grid.importImage' }, on: { click: () => file.click() } }),
          file,
          el('button', { class: BTN, text: `⤓ ${t('grid.exportJson')}`, dataset: { help: 'grid.exportJson' }, on: { click: () => { exportGridJson(); hooks.showToast(t('grid.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('grid.exportWav')}`, dataset: { help: 'grid.exportWav' }, on: { click: async () => {
            hooks.showToast(t('toast.wavStart'));
            try {
              const res = await exportGridWav();
              hooks.showToast(res.ok ? t('toast.wavDone', res.filename) : res.message, res.ok ? 'info' : 'error');
              hooks.requestRender(['grid']);
            } catch (err) {
              console.error(err);
              hooks.showToast(String(err.message || err), 'error');
            }
          } } }),
        ]),
      ]),
      loss,
    ]);
  }

  // ------------------------------------------------------------------ the two windows
  const saveDual = () => { try { globalThis.localStorage?.setItem(DUAL_KEY, serializeDual(dual)); } catch { /* session only */ } };

  /** Apply the layout state to the DOM: both hosts get their height, the pair its direction. / 레이아웃 상태를 DOM에 적용 */
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
    const hud = {
      time: el('span', { class: 'text-sky-300', text: '—' }),
      note: el('span', { class: 'text-emerald-300', text: '—' }),
      hz: el('span', { class: 'text-amber-300', text: '—' }),
      val: el('span', { class: 'text-violet-300', text: '—' }),
    };
    const status = el('span', { class: 'hidden px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-200 text-[11px]', dataset: { help: 'grid.processing' } });
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
    // DOM order: Result first, so the shared Screenshot (largest canvas, first on a tie) saves the Result;
    // CSS order shows the Editor first. / DOM 순서는 Result 먼저 (공용 스크린샷이 Result를 저장), 화면은 Editor 먼저
    const paneR = el('div', { class: 'flex flex-col gap-1 min-w-0 flex-1', style: 'order:3' }, [hostR, handle('result')]);
    const paneE = el('div', { class: 'flex flex-col gap-1 min-w-0 flex-1', style: 'order:1' }, [hostE, handle('editor')]);
    const lockBtn = el('button', { class: ICON_BTN, dataset: { help: 'grid.lock' }, on: { click: () => setDual(toggleDualLock(dual)) } });
    const lockNote = el('span', { class: 'text-[10.5px] text-amber-300', dataset: { help: 'grid.lock' } });
    const lockBar = el('div', { class: 'flex items-center justify-center gap-2 shrink-0', style: 'order:2' }, [lockBtn, lockNote]);
    const host = el('div', { class: 'flex min-w-0 flex-1', style: `gap:${DUAL_GAP}px` }, [paneR, lockBar, paneE]);
    const layoutBtn = el('button', { class: `fx-toggle ${BTN}`, dataset: { help: 'grid.layout' }, title: '\\', on: { click: () => setDual(setDualLayout(dual, dual.layout === 'side' ? 'stack' : 'side')) } });

    // the shared corner handle (ui/rack-layout.js) writes an inline height on a host: read it as a resize request
    // 공용 모서리 손잡이가 호스트에 쓰는 인라인 높이를 리사이즈 요청으로 읽음
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

    const toolCol = el('div', { class: 'flex flex-col gap-1 shrink-0', dataset: { help: 'grid.tools' } }, GRID_TOOLS.map((id) => {
      const key = Object.keys(TOOL_KEY).find((k) => TOOL_KEY[k] === id);
      const b = el('button', { class: 'w-8 h-8 rounded-lg border text-[14px] leading-none', text: TOOL_ICON[id], title: `${t(`grid.tool.${id}`)} (${key.toUpperCase()})`, dataset: { help: `grid.tool.${id}` }, on: { click: () => setTool((tl) => { tl.id = id; }) } });
      sink.push(() => { b.className = `w-8 h-8 rounded-lg border text-[14px] leading-none ${P().tool.id === id ? 'bg-sky-600 border-sky-400 text-white' : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'}`; });
      return b;
    }));

    const shot = select('grid.shot', ['result', 'editor', 'both'].map((k) => [k, t(`grid.shot.${k}`)]), () => P().tool.shot, (k) => setTool((tl) => { tl.shot = k; }));
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      layoutBtn,
      el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.colormap' } }, [t('grid.win.editor'), select('grid.colormap', GRID_COLORMAPS.map((c) => [c, t(`grid.color.${c}`)]), () => P().view.colorE, (c) => setView((vw) => { vw.colorE = c; }))]),
      el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.colormap' } }, [t('grid.win.result'), select('grid.colormap', GRID_COLORMAPS.map((c) => [c, t(`grid.color.${c}`)]), () => P().view.colorR, (c) => setView((vw) => { vw.colorR = c; }))]),
      toggle('grid.showGrid', 'grid.showGrid', () => P().view.showGrid, () => setView((vw) => { vw.showGrid = !vw.showGrid; })),
      toggle('grid.showChroma', 'grid.overlays', () => P().view.showChroma, () => setView((vw) => { vw.showChroma = !vw.showChroma; })),
      toggle('grid.showEvents', 'grid.overlays', () => P().view.showEvents, () => setView((vw) => { vw.showEvents = !vw.showEvents; })),
      toggle('grid.showMesh', 'grid.overlays', () => P().view.showMesh, () => setView((vw) => { vw.showMesh = !vw.showMesh; })),
      ...createLocateButtons({ unavailable: 'grid.locateNa' }), // the picture is painted, not moved as objects / 그림은 칠하는 것이라 옮길 개체가 없음
      createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f, null, GRID_VIEW_LIMITS)), onTime: (f) => setView((vw) => zoomViewTime(vw, f, null, GRID_VIEW_LIMITS)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f, null, GRID_VIEW_LIMITS); zoomViewPitch(vw, f, null, GRID_VIEW_LIMITS); }), onFit: () => fitGrid() }),
      el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'grid.shot' } }, [shot, el('button', { class: BTN, text: `📷 ${t('grid.shotBtn')}`, dataset: { help: 'grid.shot' }, on: { click: () => canvases?.screenshot(P().tool.shot) } })]),
      status,
    ]);
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400', dataset: { help: 'grid.hud' } }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]), el('span', {}, ['a ', hud.val]),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('grid.canvasHint') }),
    ]);
    canvases = createGridCanvases({ editor, result, hud, status }, { requestRender: hooks.requestRender, showToast: hooks.showToast });
    return el('section', { class: SECTION, dataset: { rack: 'grid-window' } }, [toolbar, hudRow, el('div', { class: 'flex gap-2 min-w-0' }, [toolCol, host])]);
  }

  function fitGrid() {
    setView((vw, d) => { Object.assign(vw, fitGridView(d.grid)); });
  }

  // ------------------------------------------------------------------ tool rack
  function buildToolRack(p) {
    const id = p.tool.id;
    const tl = (k, help, min, max, step, unit = '') => slider(`grid.tool.${k}`, help, toolNum(k), setToolNum(k), { min, max, step, unit, compact: true, id: `tool.${k}` });
    const body = [];
    const paints = ['brush', 'eraser', 'line', 'mask'].includes(id);
    if (paints) {
      body.push(el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        tl('size', 'grid.tool.size', 0.5, 40, 0.5, t('grid.unit.cells')),
        tl('hardness', 'grid.tool.hardness', 0, 1, 0.01),
        tl('opacity', 'grid.tool.opacity', 0.01, 1, 0.01),
        id === 'line' ? null : tl('flow', 'grid.tool.flow', 0.01, 1, 0.01),
        id === 'eraser' ? null : tl('value', 'grid.tool.value', 0, 1, 0.01),
      ]));
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        segment([['round', t('grid.opt.round'), 'grid.tool.shape'], ['square', t('grid.opt.square'), 'grid.tool.shape']], () => P().tool.shape, (v) => setTool((q) => { q.shape = v; })),
        toggle('grid.tool.symTime', 'grid.tool.sym', () => P().tool.symTime, () => setTool((q) => { q.symTime = !q.symTime; })),
        toggle('grid.tool.symPitch', 'grid.tool.sym', () => P().tool.symPitch, () => setTool((q) => { q.symPitch = !q.symPitch; })),
        id === 'line' ? toggle('grid.tool.snap', 'grid.tool.snap', () => P().tool.snap, () => setTool((q) => { q.snap = !q.snap; })) : null,
      ]));
    }
    if (['rect', 'ellipse', 'bucket', 'gradient'].includes(id)) {
      body.push(el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        tl('value', 'grid.tool.value', 0, 1, 0.01),
        tl('opacity', 'grid.tool.opacity', 0.01, 1, 0.01),
        id === 'bucket' ? tl('threshold', 'grid.tool.threshold', 0, 1, 0.01) : null,
      ]));
      if (id === 'gradient') body.push(segment([['linear', t('grid.opt.linear'), 'grid.tool.gradient'], ['radial', t('grid.opt.radial'), 'grid.tool.gradient']], () => P().tool.gradient, (v) => setTool((q) => { q.gradient = v; })));
    }
    if (id === 'eyedropper') body.push(tl('value', 'grid.tool.value', 0, 1, 0.01));
    if (id === 'select') {
      body.push(segment(GRID_SELECT_KINDS.map((k) => [k, t(`grid.opt.${k}`), 'grid.tool.select']), () => P().tool.select, (v) => setTool((q) => { q.select = v; })));
      body.push(slider('grid.tool.feather', 'grid.tool.feather', toolNum('feather'), (val) => editGrid((d) => { d.tool.feather = val; d.selection.feather = val; }, { history: false }), { min: 0, max: 20, step: 0.5, unit: t('grid.unit.cells'), compact: true, id: 'tool.feather' }));
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('button', { class: BTN, text: t('grid.sel.all'), dataset: { help: 'grid.tool.select' }, on: { click: () => editGrid((d) => { const s = gridShape(d.grid); d.selection = { kind: 'rect', x0: 0, y0: 0, x1: s.cols, y1: s.rows, pts: [], feather: d.tool.feather }; }, { history: false }) } }),
        el('button', { class: BTN, text: t('grid.sel.none'), dataset: { help: 'grid.tool.select' }, on: { click: () => editGrid((d) => { d.selection.kind = 'none'; }, { history: false }) } }),
        el('button', { class: BTN, text: `⌫ ${t('grid.sel.delete')}`, dataset: { help: 'grid.sel.delete' }, on: { click: () => canvases?.deleteSelection() } }),
      ]));
    }
    if (id === 'mask') {
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        toggle('grid.showMask', 'grid.tool.mask', () => P().view.showMask, () => setView((vw) => { vw.showMask = !vw.showMask; })),
        el('button', { class: BTN, text: t('grid.mask.fill'), dataset: { help: 'grid.tool.mask' }, on: { click: () => { editLayer((l, d) => { const s = gridShape(d.grid); l.maskRaster = encodeRaster(new Float32Array(s.rows * s.cols).fill(1), s.rows, s.cols); }); commit(); } } }),
        el('button', { class: BTN, text: t('grid.mask.clear'), dataset: { help: 'grid.tool.mask' }, on: { click: () => { editLayer((l) => { l.maskRaster = null; }); commit(); } } }),
      ]));
    }
    if (id === 'liquify') {
      body.push(segment(LIQUIFY_TOOLS.map((k) => [k, t(`grid.liq.${k}`), 'grid.tool.liquify']), () => P().tool.liq, (v) => setTool((q) => { q.liq = v; }), 'violet'));
      body.push(el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('grid.tool.size', 'grid.tool.size', toolNum('liqSize'), setToolNum('liqSize'), { min: 1, max: 60, step: 0.5, unit: t('grid.unit.cells'), compact: true, accent: 'accent-violet', id: 'tool.liqSize' }),
        slider('grid.tool.liqStrength', 'grid.tool.liquify', toolNum('liqStrength'), setToolNum('liqStrength'), { min: 0.01, max: 1, step: 0.01, compact: true, accent: 'accent-violet', id: 'tool.liqStrength' }),
        slider('grid.tool.liqMomentum', 'grid.tool.liquify', toolNum('liqMomentum'), setToolNum('liqMomentum'), { min: 0, max: 0.95, step: 0.01, compact: true, accent: 'accent-violet', id: 'tool.liqMomentum' }),
      ]));
      const count = el('span', { class: 'text-[11px] text-slate-400' });
      sink.push(() => { const it = L().stack.find((q) => q.type === 'liquify'); count.textContent = t('grid.liq.count', it ? it.params.ops.length : 0); });
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        count,
        el('button', { class: BTN, text: `↶ ${t('grid.liq.undoLast')}`, dataset: { help: 'grid.tool.liquify' }, on: { click: () => { editLayer((l) => { const it = l.stack.find((q) => q.type === 'liquify'); if (it) it.params.ops.pop(); }); commit(); } } }),
        el('button', { class: BTN, text: t('grid.liq.reset'), dataset: { help: 'grid.tool.liquify' }, on: { click: () => { editLayer((l) => { const it = l.stack.find((q) => q.type === 'liquify'); if (it) it.params.ops = []; }); commit(); } } }),
      ]));
    }
    return el('section', { class: SECTION, dataset: { rack: 'grid-tool' } }, [
      el('h3', { class: `${H3} text-sky-300`, text: `${TOOL_ICON[id]} ${t(`grid.tool.${id}`)}`, dataset: { help: `grid.tool.${id}` } }),
      el('span', { class: 'text-[11px] text-slate-400', text: t(`grid.toolHint.${id}`) }),
      ...body,
    ]);
  }

  // ------------------------------------------------------------------ layers
  function buildLayerRack(p) {
    const rows = p.layers.map((layer) => {
      const id = layer.id;
      const get = () => P().layers.find((q) => q.id === id);
      const edit = (fn, opts = {}) => editGrid((d) => { const l = d.layers.find((q) => q.id === id); if (l) fn(l, d); }, opts);
      const name = el('input', { type: 'text', class: 'min-w-0 flex-1 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-[11px] text-slate-200', dataset: { help: 'grid.layers' } });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      name.addEventListener('change', () => { edit((l) => { l.name = name.value.slice(0, 40) || l.name; }); commit(); });
      sink.push(() => { if (document.activeElement !== name) name.value = get()?.name || ''; });
      const color = el('input', { type: 'color', class: 'w-6 h-6 rounded bg-transparent border border-slate-700 p-0 shrink-0', dataset: { help: 'grid.layers' } });
      color.addEventListener('change', () => { edit((l) => { l.color = color.value; }); commit(); });
      sink.push(() => { if (document.activeElement !== color) color.value = get()?.color || '#38bdf8'; });
      const pick = el('button', { class: ICON_BTN, text: '●', title: t('grid.layer.select'), dataset: { help: 'grid.layers' }, on: { click: () => editGrid((d) => { d.activeLayerId = id; }, { history: false }) } });
      const mute = el('button', { class: `fx-toggle ${ICON_BTN}`, text: 'M', title: t('grid.layer.mute'), dataset: { help: 'grid.layers' }, on: { click: () => { edit((l) => { l.muted = !l.muted; }); commit(); } } });
      const solo = el('button', { class: `fx-toggle ${ICON_BTN}`, text: 'S', title: t('grid.layer.solo'), dataset: { help: 'grid.layers' }, on: { click: () => { edit((l) => { l.solo = !l.solo; }); commit(); } } });
      const box = el('div', { class: CARD, dataset: { help: 'grid.layers' } }, [
        el('div', { class: 'flex items-center gap-1.5 min-w-0' }, [
          pick, color, name, mute, solo,
          el('button', { class: ICON_BTN, text: '⧉', title: t('grid.layer.duplicate'), dataset: { help: 'grid.layers' }, on: { click: () => {
            if (P().layers.length >= GRID_MAX_LAYERS) { hooks.showToast(t('grid.maxLayers', GRID_MAX_LAYERS), 'error'); return; }
            editGrid((d) => {
              const src = d.layers.find((q) => q.id === id);
              const used = new Set(d.layers.map((q) => q.id));
              let n = d.layers.length;
              while (used.has(`L${n + 1}`)) n++;
              const copy = { ...JSON.parse(JSON.stringify(src)), id: `L${n + 1}`, name: `${src.name} 2`, color: GRID_LAYER_COLORS[n % GRID_LAYER_COLORS.length] };
              d.layers.push(copy);
              d.activeLayerId = copy.id;
            });
            commit();
          } } }),
          el('button', { class: `${ICON_BTN} hover:!text-rose-400`, text: '✕', title: t('grid.layer.delete'), dataset: { help: 'grid.layers' }, on: { click: () => {
            if (P().layers.length <= 1) { hooks.showToast(t('grid.lastLayer'), 'error'); return; }
            editGrid((d) => { d.layers = d.layers.filter((q) => q.id !== id); if (d.activeLayerId === id) d.activeLayerId = d.layers[0].id; });
            commit();
          } } }),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
          slider('grid.layer.gain', 'grid.layer.gain', () => num(get()?.gain, 1), (val, ck) => edit((l) => { l.gain = val; }, { coalesceKey: ck }), { min: 0, max: 2, step: 0.01, compact: true, def: 1, id: `layer.gain.${id}` }),
          slider('grid.layer.pan', 'grid.layer.pan', () => num(get()?.pan, 0), (val, ck) => edit((l) => { l.pan = val; }, { coalesceKey: ck }), { min: -1, max: 1, step: 0.01, compact: true, def: 0, id: `layer.pan.${id}` }),
        ]),
      ]);
      sink.push(() => {
        const l = get();
        if (!l) return;
        const on = P().activeLayerId === id;
        box.className = `${CARD} ${on ? '!border-sky-500' : ''}`;
        pick.style.color = l.color;
        setToggle(mute, l.muted);
        setToggle(solo, l.solo);
      });
      return box;
    });
    return el('section', { class: SECTION, dataset: { rack: 'grid-layers' } }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('h3', { class: `${H3} text-emerald-300 mr-auto`, text: t('grid.layersTitle'), dataset: { help: 'grid.layers' } }),
        el('button', { class: BTN, text: `+ ${t('grid.layer.add')}`, dataset: { help: 'grid.layers' }, on: { click: () => {
          if (P().layers.length >= GRID_MAX_LAYERS) { hooks.showToast(t('grid.maxLayers', GRID_MAX_LAYERS), 'error'); return; }
          editGrid((d) => {
            const used = new Set(d.layers.map((q) => q.id));
            let n = d.layers.length;
            while (used.has(`L${n + 1}`)) n++;
            const s = gridShape(d.grid);
            const layer = createGridLayer(n, s, { raster: emptyRaster(s.rows, s.cols) });
            d.layers.push(layer);
            d.activeLayerId = layer.id;
          });
          commit();
        } } }),
      ]),
      ...rows,
      el('div', { class: 'flex flex-wrap items-center gap-1.5 border-t border-slate-800 pt-1.5', dataset: { help: 'grid.importImage' } }, [
        el('span', { class: 'text-[11px] text-slate-400', text: t('grid.importTo') }),
        select('grid.importImage', [['new', t('grid.import.new')], ['active', t('grid.import.active')]], () => P().tool.importTarget, (v) => setTool((q) => { q.importTarget = v; })),
        toggle('grid.import.invert', 'grid.importImage', () => P().tool.importInvert, () => setTool((q) => { q.importInvert = !q.importInvert; })),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ timbre
  function buildTimbreRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x) (ui/timbre-editor.js). One timbre per layer — no Sampler.
    // 공용 음색 합성 편집기: 믹스 | ƒ(x). 레이어당 음색 하나 — 샘플러 없음
    const ed = createTimbreEditor({ get: () => L().timbre, edit: (fn, k) => editLayer((l) => { fn(l.timbre); }, { coalesceKey: k }), idPrefix: 'grid-timbre' });
    sink.push(ed.sync);
    const who = el('span', { class: 'text-[11px] text-slate-400' });
    sink.push(() => { who.textContent = L().name; });
    return el('section', { class: SECTION, dataset: { rack: 'grid-timbre' } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: `${H3} text-violet-300`, text: t('grid.timbreTitle'), dataset: { help: 'grid.timbre' } }), who]),
      el('div', { class: 'min-w-0', dataset: { help: 'grid.timbre' } }, [ed.root]),
    ]);
  }

  // ------------------------------------------------------------------ effect cards (generated from the schema)
  /** Controls of one schema parameter of a stack item. / 스키마 파라미터 하나의 컨트롤 */
  function paramControl(item, fx, q, accent = '') {
    const id = item.id;
    const help = HELP_DB[`grid.fx.${fx.id}.${q.key}`] ? `grid.fx.${fx.id}.${q.key}` : `grid.fx.${fx.id}`;
    const get = () => L().stack.find((it) => it.id === id)?.params[q.key];
    const set = (val, ck = null) => editItem(id, (it) => { it.params[q.key] = val; it.params = sanitizeEffectParams(it.type, it.params); }, { coalesceKey: ck });
    const label = q.channel ? `grid.c.${q.key.slice(1)}` : `grid.p.${q.key}`;
    if (q.type === 'toggle') return toggle(label, help, () => !!get(), () => { set(!get()); commit(); });
    if (q.type === 'select') return stacked(label, select(help, q.options.map((o) => [o, t(`grid.opt.${o}`)]), () => get(), (v) => set(v)), help);
    return slider(label, help, () => num(get(), 0), set, { min: q.min, max: q.max, step: q.step ?? 0.01, unit: q.unit || '', integer: q.type === 'int', compact: true, accent, def: fx.defaults()[q.key], id: `${L().id}.${id}.${q.key}` });
  }

  function cardHeader(item, fx, { movable, index, count }) {
    const id = item.id;
    const eye = el('button', { class: `fx-toggle ${ICON_BTN}`, text: '👁', title: t('grid.fx.on'), dataset: { help: 'grid.fx.on' }, on: { click: () => { editItem(id, (it) => { it.on = !it.on; }); commit(); } } });
    sink.push(() => { const it = L().stack.find((q) => q.id === id); setToggle(eye, !!it?.on); eye.style.opacity = it?.on ? '1' : '0.45'; });
    const fold = el('button', { class: ICON_BTN, text: folded.has(id) ? '▸' : '▾', title: t('grid.fx.fold'), dataset: { help: 'grid.fx.fold' }, on: { click: () => { if (folded.has(id)) folded.delete(id); else folded.add(id); rackKey = ''; hooks.requestRender(['grid']); } } });
    const btn = (text, title, onClick, help = 'grid.stack') => el('button', { class: ICON_BTN, text, title, dataset: { help }, on: { click: onClick } });
    const move = (dir) => { editLayer((l) => { const list = matrixItems(l); const a = list.findIndex((q) => q.id === id); const b = a + dir; if (a < 0 || b < 0 || b >= list.length) return; const ia = l.stack.indexOf(list[a]); const ib = l.stack.indexOf(list[b]); [l.stack[ia], l.stack[ib]] = [l.stack[ib], l.stack[ia]]; }); commit(); };
    return el('div', { class: 'flex items-center gap-1 min-w-0' }, [
      eye,
      el('span', { class: 'font-semibold text-[11.5px] text-slate-100 truncate mr-auto', text: fxName(fx.id), dataset: { help: `grid.fx.${fx.id}` } }),
      movable && index > 0 ? btn('↑', t('grid.fx.up'), () => move(-1)) : null,
      movable && index < count - 1 ? btn('↓', t('grid.fx.down'), () => move(1)) : null,
      movable ? btn('⧉', t('grid.fx.duplicate'), () => {
        if (matrixItems(L()).length >= GRID_MAX_STACK) { hooks.showToast(t('grid.maxStack', GRID_MAX_STACK), 'error'); return; }
        editLayer((l) => { const k = l.stack.findIndex((q) => q.id === id); if (k >= 0) l.stack.splice(k + 1, 0, { ...JSON.parse(JSON.stringify(l.stack[k])), id: '' }); });
        commit();
      }) : null,
      btn('↺', t('grid.fx.reset'), () => { editItem(id, (it) => { it.params = sanitizeEffectParams(it.type, null); it.mix = 1; it.mask = 'none'; }); commit(); }, 'grid.fx.reset'),
      movable ? el('button', { class: `${ICON_BTN} hover:!text-rose-400`, text: '✕', title: t('grid.fx.delete'), dataset: { help: 'grid.stack' }, on: { click: () => { editLayer((l) => { l.stack = l.stack.filter((q) => q.id !== id); }); commit(); } } }) : null,
      fold,
    ]);
  }

  function commonControls(item, { mask = true } = {}) {
    const id = item.id;
    const get = () => L().stack.find((q) => q.id === id);
    return el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, [
      slider('grid.fx.mix', 'grid.fx.mix', () => num(get()?.mix, 1), (val, ck) => editItem(id, (it) => { it.mix = val; }, { coalesceKey: ck }), { min: 0, max: 1, step: 0.01, compact: true, def: 1, id: `${L().id}.${id}.mix` }),
      mask ? stacked('grid.fx.mask', select('grid.fx.mask', GRID_MASKS.map((mk) => [mk, t(`grid.mask.${mk}`)]), () => get()?.mask || 'none', (v) => editItem(id, (it) => { it.mask = v; })), 'grid.fx.mask') : null,
    ]);
  }

  function matrixCard(item, index, count) {
    const fx = GridEffectRegistry.get(item.type);
    const head = cardHeader(item, fx, { movable: true, index, count });
    if (folded.has(item.id)) return el('div', { class: CARD, dataset: { help: `grid.fx.${fx.id}` } }, [head]);
    const params = fx.params.filter((q) => !q.when || q.when(item.params));
    const extra = [];
    if (item.type === 'liquify') extra.push(el('span', { class: 'text-[11px] text-slate-400', text: t('grid.liq.count', item.params.ops.length) }));
    return el('div', { class: CARD, dataset: { help: `grid.fx.${fx.id}` } }, [
      head,
      commonControls(item),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, params.map((q) => paramControl(item, fx, q))),
      ...extra,
    ]);
  }

  function buildStackRack(p) {
    const layer = activeLayer(p);
    const items = matrixItems(layer);
    const types = GridEffectRegistry.list('matrix');
    let addType = types[0].id;
    const addSel = el('select', { class: STUDIO_SELECT, dataset: { help: 'grid.stack' }, on: { change: (e) => { addType = e.target.value; } } }, types.map((fx) => el('option', { value: fx.id, text: fxName(fx.id) })));
    addSel.addEventListener('keydown', (e) => e.stopPropagation());
    return el('section', { class: SECTION, dataset: { rack: 'grid-stack' } }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('h3', { class: `${H3} text-amber-300 mr-auto`, text: t('grid.stackTitle'), dataset: { help: 'grid.stack' } }),
        addSel,
        el('button', { class: BTN, text: `＋ ${t('grid.fx.add')}`, dataset: { help: 'grid.stack' }, on: { click: () => {
          if (matrixItems(L()).length >= GRID_MAX_STACK) { hooks.showToast(t('grid.maxStack', GRID_MAX_STACK), 'error'); return; }
          editLayer((l) => { const k = l.stack.findIndex((q) => GridEffectRegistry.get(q.type)?.domain === 'bank'); l.stack.splice(k < 0 ? l.stack.length : k, 0, { ...createStackItem(addType, {}), id: '' }); });
          commit();
        } } }),
      ]),
      el('span', { class: 'text-[11px] text-slate-400', text: t('grid.stackHint') }),
      items.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('grid.stackEmpty') }),
      ...items.map((it, k) => matrixCard(it, k, items.length)),
    ]);
  }

  // ------------------------------------------------------------------ output-stage effects (fixed zone)
  function noiseCard(item) {
    const fx = GridEffectRegistry.get('noise');
    const head = cardHeader(item, fx, { movable: false, index: 0, count: 1 });
    if (folded.has(item.id)) return el('div', { class: CARD, dataset: { help: 'grid.fx.noise' } }, [head]);
    return el('div', { class: CARD, dataset: { help: 'grid.fx.noise' } }, [
      head,
      commonControls(item, { mask: false }),
      el('div', { class: 'flex flex-wrap items-center gap-1', dataset: { help: 'grid.fx.noise.slope' } }, Object.entries(NOISE_COLORS).map(([name, slope]) => el('button', { class: BTN, text: t(`grid.noise.${name}`), dataset: { help: 'grid.fx.noise.slope' }, on: { click: () => { editItem(item.id, (it) => { it.params.slope = slope; }); commit(); } } }))),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, fx.params.map((q) => paramControl(item, fx, q, 'accent-rose'))),
    ]);
  }

  function chromaCard(item) {
    const fx = GridEffectRegistry.get('chroma');
    const head = cardHeader(item, fx, { movable: false, index: 0, count: 1 });
    if (folded.has(item.id)) return el('div', { class: CARD, dataset: { help: 'grid.fx.chroma' } }, [head]);
    const id = item.id;
    const get = () => L().stack.find((q) => q.id === id)?.params || item.params;
    const set = (patch) => { editItem(id, (it) => { Object.assign(it.params, patch); it.params = sanitizeEffectParams('chroma', it.params); }); commit(); };
    const chans = CHROMA_CHANNELS.map((ch) => {
      const col = { r: 'text-rose-300', g: 'text-emerald-300', b: 'text-sky-300' }[ch];
      const accent = { r: 'accent-rose', g: 'accent-emerald', b: '' }[ch];
      const by = (suffix) => fx.params.find((q) => q.key === `${ch}${suffix}`);
      const semis = el('span', { class: `font-mono text-[11px] ${col}`, dataset: { help: 'grid.fx.chroma.ratio' } });
      sink.push(() => { const s = 12 * Math.log2(chromaRatio(get(), ch)); semis.textContent = `${s >= 0 ? '+' : ''}${s.toFixed(3)} st`; });
      // ratio menu: presets upward and downward (the reciprocal) / 비율 메뉴: 위·아래(역수) 프리셋
      const opts = [];
      for (const [a, b] of CHROMA_RATIOS) { opts.push([`${a}:${b}`, `${a}:${b}`]); if (a !== b) opts.push([`${b}:${a}`, `${b}:${a} ↓`]); }
      const ratioSel = el('select', { class: STUDIO_SELECT, dataset: { help: 'grid.fx.chroma.ratio' }, on: { change: (e) => { const [a, b] = e.target.value.split(':').map(Number); if (a && b) set({ [`${ch}P`]: a, [`${ch}Q`]: b }); } } }, [el('option', { value: '', text: t('grid.c.custom') }), ...opts.map(([v, lbl]) => el('option', { value: v, text: lbl }))]);
      ratioSel.addEventListener('keydown', (e) => e.stopPropagation());
      const pq = (suffix) => {
        const inp = el('input', { type: 'number', min: 1, max: 32, step: 1, class: NUM, dataset: { help: 'grid.fx.chroma.ratio' } });
        inp.addEventListener('change', () => set({ [`${ch}${suffix}`]: Math.round(clamp(num(inp.value, 1), 1, 32)) }));
        sink.push(() => { if (document.activeElement !== inp) inp.value = String(get()[`${ch}${suffix}`]); });
        return inp;
      };
      sink.push(() => { const p0 = get(); const key = `${p0[`${ch}P`]}:${p0[`${ch}Q`]}`; if (document.activeElement !== ratioSel) ratioSel.value = opts.some(([v]) => v === key) ? key : ''; });
      const linked = () => ch === 'r' && get().link;
      const box = el('div', { class: 'flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1.5 min-w-0', dataset: { help: 'grid.fx.chroma' } }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: `font-bold text-[11.5px] ${col}`, text: ch.toUpperCase() }),
          paramControl(item, fx, by('On')),
          ratioSel, pq('P'), el('span', { class: 'text-slate-500 text-[11px]', text: ':' }), pq('Q'),
          semis,
        ]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, [
          paramControl(item, fx, by('Cents'), accent),
          paramControl(item, fx, by('Gain'), accent),
          paramControl(item, fx, by('TimeMs'), accent),
          paramControl(item, fx, by('Pan'), accent),
          paramControl(item, fx, by('Wave')),
          paramControl(item, fx, by('Harm'), accent),
        ]),
      ]);
      sink.push(() => { box.style.opacity = get()[`${ch}On`] ? '1' : '0.5'; box.title = linked() ? t('grid.c.linkedNote') : ''; });
      return box;
    });
    return el('div', { class: CARD, dataset: { help: 'grid.fx.chroma' } }, [
      head,
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        paramControl(item, fx, fx.params.find((q) => q.key === 'link')),
        el('span', { class: 'text-[11px] text-slate-400', text: t('grid.c.hint') }),
      ]),
      ...chans,
    ]);
  }

  function buildOutputRack(p) {
    const layer = activeLayer(p);
    return el('section', { class: SECTION, dataset: { rack: 'grid-output-fx' } }, [
      el('h3', { class: `${H3} text-rose-300`, text: t('grid.outputTitle'), dataset: { help: 'grid.outputFx' } }),
      el('span', { class: 'text-[11px] text-slate-400', text: t('grid.outputHint'), dataset: { help: 'grid.outputFx' } }),
      noiseCard(bankItem(layer, 'noise')),
      chromaCard(bankItem(layer, 'chroma')),
    ]);
  }

  // ------------------------------------------------------------------ grid + render settings
  function noteInput(k, lo, hi) {
    const inp = el('input', { type: 'text', class: 'w-full min-w-[3.5rem] px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-center font-mono text-[11px] text-sky-200' });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const raw = inp.value.trim();
      const m = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : noteNameToMidi(raw);
      if (m === null || !Number.isFinite(m)) { hooks.showToast(t('pitch.invalidNote', inp.value), 'error'); return; }
      editGridShape((g) => { g[k] = Math.round(clamp(m, lo, hi)); });
      commit();
    });
    sink.push(() => { if (document.activeElement !== inp) inp.value = midiToNoteName(P().grid[k]); });
    return inp;
  }

  function buildGridRack() {
    const length = el('input', { type: 'number', min: 1, max: 120, step: 0.25, class: 'w-full px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200' });
    length.addEventListener('change', () => { editGridShape((g) => { g.length = clamp(num(length.value, g.length), 1, 120); }); commit(); });
    sink.push(() => { if (document.activeElement !== length) length.value = String(P().grid.length); });
    const info = el('span', { class: 'text-[11px] text-slate-400 font-mono', dataset: { help: 'grid.rasterSize' } });
    sink.push(() => {
      const p = P();
      const s = gridShape(p.grid);
      const bytes = p.layers.reduce((a, l) => a + l.raster.data.length + (l.maskRaster ? l.maskRaster.data.length : 0), 0);
      info.textContent = t('grid.rasterInfo', s.cols, s.rows, s.cols * s.rows, (bytes / 1024).toFixed(1));
    });
    const R = (k) => () => num(P().render[k]);
    const setR = (k) => (val, ck) => editGrid((d) => { d.render[k] = val; }, { coalesceKey: ck });
    return el('section', { class: SECTION, dataset: { rack: 'grid-settings' } }, [
      el('h3', { class: `${H3} text-sky-300`, text: t('grid.gridTitle'), dataset: { help: 'grid.gridShape' } }),
      el('div', { class: 'grid grid-cols-3 gap-2' }, [
        stacked('grid.pLo', noteInput('pLo', 0, 115), 'grid.gridShape'),
        stacked('grid.pHi', noteInput('pHi', 6, 127), 'grid.gridShape'),
        stacked('grid.length', length, 'grid.gridShape'),
        stacked('grid.rowsPerSemi', select('grid.gridShape', GRID_ROWS_PER_SEMI.map((n) => [String(n), String(n)]), () => P().grid.rowsPerSemi, (v) => editGridShape((g) => { g.rowsPerSemi = Number(v); })), 'grid.gridShape'),
        stacked('grid.colsPerSec', select('grid.gridShape', COLS_PER_SEC.map((n) => [String(n), String(n)]), () => P().grid.colsPerSec, (v) => editGridShape((g) => { g.colsPerSec = Number(v); })), 'grid.gridShape'),
        stacked('grid.resample', select('grid.resample', [['area', t('grid.opt.area')], ['nearest', t('grid.opt.nearest')]], () => P().tool.resample, (v) => setTool((q) => { q.resample = v; })), 'grid.resample'),
      ]),
      info,
      el('h3', { class: `${H3} text-slate-300 pt-1`, text: t('grid.renderTitle'), dataset: { help: 'grid.render' } }),
      segment(GRID_QUALITIES.map((q) => [q, t(`grid.quality.${q}`), 'grid.quality']), () => P().render.quality, (q) => editGrid((d) => { d.render.quality = q; })),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        stacked('grid.binsPerSemi', select('grid.render', GRID_BINS.map((n) => [String(n), `${n} (${(100 / n).toFixed(1)} ¢)`]), () => P().render.binsPerSemi, (v) => editGrid((d) => { d.render.binsPerSemi = Number(v); })), 'grid.render'),
        stacked('grid.frameRate', select('grid.render', [50, 100, 200, 400].map((n) => [String(n), `${n} Hz`]), () => P().render.frameRate, (v) => editGrid((d) => { d.render.frameRate = Number(v); })), 'grid.render'),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('grid.maxActive', 'grid.budget', R('maxActive'), (val, ck) => setR('maxActive')(Math.round(val), ck), { min: 16, max: 2000, step: 8, compact: true, integer: true }),
        slider('grid.edgeMs', 'grid.edgeMs', R('edgeMs'), setR('edgeMs'), { min: 0, max: 60, step: 1, unit: 'ms', compact: true }),
        slider('grid.gainDb', 'grid.gainDb', R('gainDb'), setR('gainDb'), { min: -24, max: 12, step: 0.5, unit: 'dB', compact: true }),
      ]),
    ]);
  }

  function buildTremoloRack() {
    const r = createStudioTremoloRack({ get: getGridParams, edit: editGrid, studio: 'grid' });
    sink.push(r.sync);
    // The per-voice tremolo / vibrato block stays in its place, switched off: there are no voices here
    // (every bin is a partial of the picture). / 보이스별 트레몰로·비브라토는 제자리에 꺼진 채로 (보이스가 없음)
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
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (TOOL_KEY[k] && !e.shiftKey) { setTool((tl) => { tl.id = TOOL_KEY[k]; }); return; }
    if (k === '[' || k === ']') {
      const f = k === ']' ? 1.25 : 0.8;
      setTool((tl) => { if (tl.id === 'liquify') tl.liqSize = clamp(tl.liqSize * f, 1, 60); else tl.size = clamp(Math.round(tl.size * f * 2) / 2 || 0.5, 0.5, 40); });
      return;
    }
    if (k === '\\') setDual(setDualLayout(dual, dual.layout === 'side' ? 'stack' : 'side'));
  };
  document.addEventListener('keydown', onKey);
  offs.push(() => document.removeEventListener('keydown', onKey));
  offs.push(onGridBake(() => hooks.requestRender(['grid'])));
  offs.push(onGridLiveStat(() => hooks.requestRender(['grid'])));

  // ------------------------------------------------------------------ build / render
  function teardownDual() {
    dualEls?.mo.disconnect();
    dualEls?.ro?.disconnect();
    dualEls = null;
  }

  function buildStatic() {
    staticSync = [];
    sink = staticSync;
    canvases?.destroy();
    teardownDual();
    // display: contents — the racks inside take part in the column directly (rack order, jump bar) / 랙이 열에 직접 참여
    hosts = { tool: el('div', { class: 'contents' }), layers: el('div', { class: 'contents' }), stack: el('div', { class: 'contents' }), output: el('div', { class: 'contents' }) };
    root.replaceChildren(
      buildStrip(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [buildWindows()]),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [hosts.tool, hosts.layers, buildTimbreRack(), hosts.stack, hosts.output, buildGridRack(), buildTremoloRack()]),
      ]),
    );
    applyDual();
  }

  function buildRacks() {
    rackSync = [];
    sink = rackSync;
    const p = P();
    hosts.tool.replaceChildren(buildToolRack(p));
    hosts.layers.replaceChildren(buildLayerRack(p));
    hosts.stack.replaceChildren(buildStackRack(p));
    hosts.output.replaceChildren(buildOutputRack(p));
  }

  /** What the rebuilt racks depend on (structure, not values). / 랙 구조 키 */
  const structureKey = () => {
    const p = P();
    const act = activeLayer(p);
    const shown = (it) => { const fx = GridEffectRegistry.get(it.type); return fx.params.filter((q) => q.when).map((q) => (q.when(it.params) ? 1 : 0)).join(''); };
    return [p.tool.id, p.layers.map((l) => l.id).join(','), act.id, act.stack.map((it) => `${it.id}:${it.type}:${shown(it)}:${folded.has(it.id) ? 1 : 0}:${it.type === 'liquify' ? it.params.ops.length : ''}`).join(',')].join('|');
  };

  return {
    render() {
      const lang = getLang();
      if (lang !== langKey || !hosts) { langKey = lang; rackKey = ''; buildStatic(); }
      const k = structureKey();
      if (k !== rackKey) { rackKey = k; buildRacks(); }
      for (const fn of staticSync) fn();
      for (const fn of rackSync) fn();
      canvases?.render();
    },
    fit: fitGrid,
    /** Delete / Backspace (ui/studio-host.js): clear the selection area of the active layer. / 선택 영역 지우기 */
    deleteSelection() { canvases?.deleteSelection(); },
    destroy() {
      for (const off of offs) off();
      canvases?.destroy();
      canvases = null;
      teardownDual();
      hosts = null;
      root.replaceChildren();
      langKey = '';
      rackKey = '';
    },
  };
}
