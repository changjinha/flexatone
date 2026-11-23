/**
 * Flexatone — studios/draw/draw-panels.js
 * Draw Studio UI tier: workspace DOM (header + actions, tool bar, canvas, stroke list, drawing /
 * sound / transform / import racks), keyboard tools and SVG import. Mounted by ui/studio-host.js.
 * 드로잉 스튜디오 작업 공간 DOM (헤더·액션, 도구 막대, 캔버스, 획 목록, 그리기·소리·변환·가져오기 랙),
 * 도구 단축키, SVG 가져오기.
 *
 * Every control carries data-help="draw.…" (Option/Alt inspector); number inputs are handled by
 * ui/number-scrub.js. Settings edits apply to the active stroke and every selected stroke.
 * 모든 컨트롤에 data-help, 설정 편집은 활성 획 + 선택된 획 모두에 적용.
 */

import { clamp, deepClone } from '../../core/math-utils.js';
import { midiToNoteName } from '../../core/units.js';
import { t, getLang } from '../../core/i18n.js';
import { appState, endHistoryGesture } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import {
  DRAW_ID, TOOLS, REVERSAL_MODES, SNAP_MODES, SCALE_IDS, GAIN_SOURCES, TIME_DIVS, PRESET_IDS, MAX_DRAW_VOICES,
  createPresetStrokes, echoCanon, newStrokeId, offsetRaw, pathsToRaw, createStroke, countPieces, getProcessCount, STROKE_COLORS,
} from './draw-engine.js';
import { getDrawParams, editDraw, getActiveStroke, getProcessedMap } from '../draw-studio.js';
import { createDrawCanvases } from './draw-canvases.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { exportDrawJson, exportDrawWav, auditionStroke } from './draw-audio.js';
import { DRAW_HELP, DEMO_SVGS } from './draw-i18n.js';

// Help entries → the shared inspector DB / 도움말 등록
for (const [k, v] of Object.entries(DRAW_HELP)) HELP_DB[k] = v;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const TOOL_KEYS = { draw: 'D', select: 'V', node: 'N', erase: 'E', line: 'L' };

/** SVG text → polylines (one per geometry element / sub-path) via the DOM. / SVG → 폴리라인 */
export function sampleSvgPaths(text) {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = parsed.querySelector('svg');
  if (!src || parsed.querySelector('parsererror')) return null;
  const svg = document.importNode(src, true);
  svg.setAttribute('style', 'position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none');
  if (!svg.getAttribute('width')) svg.setAttribute('width', '400');
  if (!svg.getAttribute('height')) svg.setAttribute('height', '400');
  document.body.append(svg);
  const out = [];
  try {
    for (const g of svg.querySelectorAll('path, circle, ellipse, rect, line, polyline, polygon')) {
      if (typeof g.getTotalLength !== 'function') continue;
      const L = g.getTotalLength();
      if (!(L > 0)) continue;
      const n = clamp(Math.ceil(L / 2), 40, 400);
      const ctm = g.getCTM();
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const q = g.getPointAtLength((L * i) / n);
        const r = ctm ? new DOMPoint(q.x, q.y).matrixTransform(ctm) : q;
        pts.push({ x: r.x, y: r.y });
      }
      // split sub-paths (big jumps between consecutive samples) / 하위 경로 분리
      const step = L / n;
      let cur = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > step * 4 * (ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1)) { if (cur.length > 1) out.push(cur); cur = []; }
        cur.push(pts[i]);
      }
      if (cur.length > 1) out.push(cur);
    }
  } finally {
    svg.remove();
  }
  return out;
}

/**
 * Mount the Draw workspace into `root`. / 드로잉 작업 공간 마운트
 * @returns {{ render: () => void, destroy: () => void, fit: () => void }}
 */
export function mountDrawWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let lastPieces = -1;
  const commit = () => endHistoryGesture();
  const toast = (k, ...a) => hooks.showToast(t(k, ...a));

  /** Targets of a settings edit: active + selected strokes. / 편집 대상 */
  const editTargets = (fn, coalesceKey = null) => editDraw((d) => {
    const ids = new Set([d.activeStrokeId, ...(d.selectedIds || [])]);
    for (const s of d.strokes) if (ids.has(s.id)) fn(s, d);
  }, { coalesceKey });
  const act = () => getActiveStroke();
  const sNum = (k) => () => num(act()?.[k]);
  const setSNum = (k) => (val, ck) => editTargets((s) => { s[k] = val; }, ck);
  const trNum = (k) => () => num(act()?.transform?.[k], k === 'stretch' ? 1 : 0);
  const setTrNum = (k) => (val, ck) => editTargets((s) => { s.transform = { ...s.transform, [k]: val }; }, ck);
  const setView = (fn) => editDraw((d) => fn(d), { history: false });

  // ------------------------------------------------------------------ control helpers
  const { slider, toggle, select, labelled } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label) => `draw:${label}` });

  // ------------------------------------------------------------------ actions
  function bake(mode) {
    const params = getDrawParams();
    const n = countPieces(params, getProcessedMap(params));
    if (!n) { toast('draw.toast.nothing'); return; }
    StudioRegistry.bakeVoices(DRAW_ID, { mode });
    hooks.showToast(t('draw.toast.baked', Math.min(n, MAX_DRAW_VOICES)) + (n > MAX_DRAW_VOICES ? ` ${t('draw.toast.capped', n)}` : ''));
  }
  function loadPreset(id, seed = getDrawParams().seed) {
    const strokes = createPresetStrokes(id, seed);
    editDraw((d) => { d.strokes = strokes; d.activeStrokeId = strokes[0].id; d.selectedIds = [strokes[0].id]; d.seed = seed; });
    commit();
    fit();
    toast('draw.toast.preset', t(`draw.preset.${id}`));
  }
  function duplicateSelected() {
    editDraw((d) => {
      const ids = new Set(d.selectedIds?.length ? d.selectedIds : [d.activeStrokeId]);
      const copies = d.strokes.filter((s) => ids.has(s.id)).map((s, i) => ({ ...deepClone(s), id: newStrokeId(), name: `${s.name} ⧉`, color: STROKE_COLORS[(d.strokes.length + i) % STROKE_COLORS.length], raw: offsetRaw(s.raw, 0.5, 0) }));
      d.strokes.push(...copies);
      if (copies.length) { d.selectedIds = copies.map((c) => c.id); d.activeStrokeId = copies[0].id; }
    });
    commit();
  }
  function deleteSelected() {
    const params = getDrawParams();
    const ids = new Set(params.selectedIds?.length ? params.selectedIds : [params.activeStrokeId]);
    if (!params.strokes.some((s) => ids.has(s.id))) return;
    editDraw((d) => {
      d.strokes = d.strokes.filter((s) => !ids.has(s.id));
      d.selectedIds = [];
      d.activeStrokeId = d.strokes[0]?.id || '';
    });
    commit();
  }
  function echo() {
    const a = act();
    if (!a) return;
    const params = getDrawParams();
    editDraw((d) => {
      const src = d.strokes.find((s) => s.id === a.id);
      const copies = echoCanon(src, d.echo, d.strokes.length);
      d.strokes.splice(d.strokes.indexOf(src) + 1, 0, ...copies);
      d.selectedIds = [src.id, ...copies.map((c) => c.id)];
    });
    commit();
    toast('draw.toast.echo', params.echo.count);
  }
  function importPaths(paths, label) {
    if (!paths?.length) { hooks.showToast(t('draw.toast.svgEmpty'), 'error'); return; }
    const params = getDrawParams();
    const v = params.view;
    const k = clamp(num(params.importScale, 0.6), 0.1, 1);
    const tc = 0.5 * (v.tMin + v.tMax);
    const pc = 0.5 * (v.midiMin + v.midiMax);
    const hw = 0.5 * k * (v.tMax - v.tMin);
    const hh = 0.5 * k * (v.midiMax - v.midiMin);
    const raws = pathsToRaw(paths, { t0: Math.max(0, tc - hw), t1: tc + hw, p0: pc - hh, p1: pc + hh }, clamp(num(params.drawWidth, 0.7), 0, 1)).slice(0, 32);
    const tpl = getActiveStroke(params);
    const strokes = raws.map((raw, i) => {
      const s = createStroke(params.strokes.length + i, raw, tpl);
      s.name = `${label} ${i + 1}`;
      s.reversal = 'split'; // closed shapes → upper and lower voices / 닫힌 도형 → 위·아래 보이스
      s.smooth = 0.15;
      return s;
    });
    editDraw((d) => { d.strokes.push(...strokes); d.selectedIds = strokes.map((s) => s.id); d.activeStrokeId = strokes[0].id; d.tool = 'select'; });
    commit();
    toast('draw.toast.svg', strokes.length);
  }
  function importSvgText(text, label = 'SVG') {
    let paths = null;
    try { paths = sampleSvgPaths(text); } catch (err) { console.error(err); }
    if (paths === null) { hooks.showToast(t('draw.toast.svgError'), 'error'); return; }
    importPaths(paths, label);
  }
  async function exportWav() {
    toast('toast.wavStart');
    try {
      const res = await exportDrawWav();
      hooks.showToast(res.ok ? t('toast.wavDone', res.filename) : res.message, res.ok ? 'info' : 'error');
    } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
  }

  function fit() {
    const params = getDrawParams();
    const map = getProcessedMap(params);
    let t0 = Infinity;
    let t1 = -Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of params.strokes) for (const pc of map.get(s.id)?.pieces || []) {
      t0 = Math.min(t0, pc.t0);
      t1 = Math.max(t1, pc.t0 + pc.dur);
      for (const q of pc.pts) { lo = Math.min(lo, q.p); hi = Math.max(hi, q.p); }
    }
    if (!Number.isFinite(t0)) { t0 = 0; t1 = 6; lo = 48; hi = 72; }
    const pad = Math.max(0.3, 0.06 * (t1 - t0));
    setView((d) => { Object.assign(d.view, { tMin: Math.max(0, t0 - pad), tMax: t1 + pad, midiMin: clamp(lo - 6, 0, 115), midiMax: clamp(Math.max(hi + 6, lo + 12), 12, 127) }); });
  }

  // ------------------------------------------------------------------ header
  function buildHeader() {
    const badge = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono', dataset: { help: 'draw.status' } });
    syncers.push(() => {
      const p = getDrawParams();
      const n = countPieces(p, getProcessedMap(p));
      badge.textContent = t('draw.status', p.strokes.length, n, getProcessCount());
      badge.className = `px-2 py-0.5 rounded-full text-[10px] font-mono border ${n > MAX_DRAW_VOICES ? 'bg-rose-500/15 text-rose-300 border-rose-500/40' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'}`;
      if (lastPieces >= 0 && n > MAX_DRAW_VOICES && lastPieces <= MAX_DRAW_VOICES) hooks.showToast(t('draw.toast.over64', n), 'error');
      lastPieces = n;
    });
    const fileIn = el('input', { type: 'file', accept: '.svg,image/svg+xml', class: 'hidden', on: { change: async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) importSvgText(await f.text(), f.name.replace(/\.svg$/i, '')); } } });
    const presetSel = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]', dataset: { help: 'draw.preset' }, on: { change: (e) => { if (e.target.value) loadPreset(e.target.value); e.target.value = ''; } } },
      [el('option', { value: '', text: `${t('draw.presets')}…` }), ...PRESET_IDS.map((id) => el('option', { value: id, text: t(`draw.preset.${id}`) }))]);
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-pink-300', text: t('draw.title') }),
          badge,
        ]),
        el('div', { class: 'flex flex-wrap gap-1.5 items-center' }, [
          presetSel,
          el('button', { class: BTN, text: `🎲 ${t('draw.reseed')}`, dataset: { help: 'draw.reseed' }, on: { click: () => loadPreset('swarm', 1 + Math.floor(Math.random() * 99999)) } }),
          el('button', { class: BTN, text: `⤒ ${t('draw.importSvg')}`, dataset: { help: 'draw.importSvg' }, on: { click: () => fileIn.click() } }),
          fileIn,
          createTrajectoryImportButton('draw'), // Glissando trajectory → a stroke / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('draw.bake')}`, dataset: { help: 'draw.bake' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('draw.bakeAppend'), dataset: { help: 'draw.bake' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('draw.exportJson')}`, dataset: { help: 'draw.exportJson' }, on: { click: () => { exportDrawJson(); toast('draw.toast.json'); } } }),
          el('button', { class: BTN, text: `⤓ ${t('draw.exportWav')}`, dataset: { help: 'draw.exportWav' }, on: { click: exportWav } }),
        ]),
      ]),
      el('span', { class: 'text-[11px] text-slate-400', text: t('draw.subtitle') }),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol() {
    const hud = { time: el('span', { class: 'text-sky-300', text: '—' }), note: el('span', { class: 'text-emerald-300', text: '—' }), hz: el('span', { class: 'text-amber-300', text: '—' }) };
    const main = el('canvas', { class: 'w-full h-[480px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'draw.canvas' } });
    const tools = TOOLS.map((tool) => {
      const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px]', text: `${t(`draw.tool.${tool}`)} ${TOOL_KEYS[tool]}`, dataset: { help: `draw.tool.${tool}` }, on: { click: () => setView((d) => { d.tool = tool; }) } });
      syncers.push(() => { const on = getDrawParams().tool === tool; b.className = `px-2 py-0.5 rounded text-[11px] ${on ? 'bg-pink-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`; });
      return b;
    });
    const direct = el('span', { class: 'hidden px-1.5 py-0.5 rounded bg-pink-600/30 text-pink-200 border border-pink-500/40 text-[10px]', text: t('draw.directBadge'), dataset: { help: 'draw.direct' } });
    const release = el('button', { class: `hidden ${BTN}`, text: t('draw.releaseDirect'), dataset: { help: 'draw.direct' }, on: { click: () => { editTargets((s) => { s.direct = false; }); commit(); } } });
    syncers.push(() => { const on = !!act()?.direct; direct.classList.toggle('hidden', !on); release.classList.toggle('hidden', !on); });
    const zoom = (f) => () => setView((d) => canvases.zoomAt(d.view, f, 0.5 * (d.view.tMin + d.view.tMax), 0.5 * (d.view.midiMin + d.view.midiMax)));
    // Shared Locate / Snap (ui/locate-tool.js). Turning Locate on leaves a drawing tool for Select.
    // 공용 이동·스냅 — 이동을 켜면 그리기 도구에서 선택 도구로 전환
    const locateBtns = createLocateButtons();
    locateBtns[0].addEventListener('click', () => { if (appState.locateMode && !['select', 'node'].includes(getDrawParams().tool)) setView((d) => { d.tool = 'select'; }); });
    syncers.push(locateBtns.sync);
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5' }, tools),
      ...locateBtns,
      el('div', { class: 'w-36' }, [slider('draw.penWidth', 'draw.penWidth', () => num(getDrawParams().drawWidth, 0.7), (val) => setView((d) => { d.drawWidth = val; }), { min: 0, max: 1, step: 0.05, accent: 'accent-pink' })]),
      labelled('draw.gridTime', select('draw.grid', TIME_DIVS.map((v) => [String(v), v ? `${v}s` : t('draw.off')]), () => String(getDrawParams().grid?.timeDiv ?? 0.5), (val) => { editDraw((d) => { d.grid = { ...d.grid, timeDiv: Number(val) }; }, { history: false }); }), 'draw.grid'),
      toggle('draw.gridPitch', 'draw.grid', () => getDrawParams().grid?.pitchDiv !== 'off', () => editDraw((d) => { d.grid = { ...d.grid, pitchDiv: d.grid?.pitchDiv === 'off' ? 'semitone' : 'off' }; }, { history: false })),
      // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
      createZoomBar({ onPitch: (f) => setView((d) => zoomViewPitch(d.view, f)), onTime: (f) => setView((d) => zoomViewTime(d.view, f)), onBoth: (f) => zoom(f)(), onFit: fit }),
      direct,
      release,
    ]);
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('draw.canvasHint') }),
    ]);
    canvases = createDrawCanvases({ main, hud }, {
      requestRender: hooks.requestRender,
      showToast: hooks.showToast,
      onStrokeDrawn: (s) => { const p = getDrawParams(); const cur = p.strokes.find((x) => x.id === s.id); if (cur) auditionStroke(cur, getProcessedMap(p).get(s.id)); },
    });
    return el('div', { class: 'lg:col-span-8 flex flex-col gap-3 min-w-0' }, [el('section', { class: SECTION }, [toolbar, hudRow, main])]);
  }

  // ------------------------------------------------------------------ racks
  function buildStrokeList(params) {
    const rows = params.strokes.map((s) => {
      const flag = (field, label, onCls) => {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[10px] font-bold border', text: label, dataset: { help: `draw.${field}` }, on: { click: (e) => { e.stopPropagation(); editDraw((d) => { const x = d.strokes.find((y) => y.id === s.id); if (x) x[field] = !x[field]; }); commit(); } } });
        syncers.push(() => { const x = getDrawParams().strokes.find((y) => y.id === s.id); b.className = `px-1.5 py-0.5 rounded text-[10px] font-bold border ${x?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return b;
      };
      const info = el('span', { class: 'font-mono text-[10px] text-slate-400 truncate' });
      const row = el('div', { class: 'flex items-center gap-1.5 rounded-lg px-1.5 py-1 border cursor-pointer', dataset: { help: 'draw.strokeList' }, on: { click: (e) => editDraw((d) => { d.activeStrokeId = s.id; d.selectedIds = e.shiftKey ? [...new Set([...(d.selectedIds || []), s.id])] : [s.id]; }, { history: false }) } }, [
        el('span', { class: 'w-2.5 h-2.5 rounded-full shrink-0', style: `background:${s.color}` }),
        el('span', { class: 'text-[11px] text-slate-100 truncate flex-1', text: s.name }),
        info,
        flag('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'),
        flag('muted', 'M', 'bg-rose-600 text-white border-rose-500'),
        el('button', { class: 'text-slate-500 hover:text-sky-300 px-1 text-[11px]', text: '⧉', title: t('draw.duplicate'), dataset: { help: 'draw.duplicate' }, on: { click: (e) => { e.stopPropagation(); editDraw((d) => { d.selectedIds = [s.id]; }, { history: false }); duplicateSelected(); } } }),
        el('button', { class: 'text-slate-500 hover:text-rose-400 px-1 text-[11px] font-bold', text: '✕', title: t('draw.delete'), dataset: { help: 'draw.delete' }, on: { click: (e) => { e.stopPropagation(); editDraw((d) => { d.selectedIds = [s.id]; }, { history: false }); deleteSelected(); } } }),
      ]);
      syncers.push(() => {
        const p = getDrawParams();
        const res = getProcessedMap(p).get(s.id);
        const pc = res?.pieces[0];
        info.textContent = pc ? `${midiToNoteName(pc.pA)}→${midiToNoteName(pc.pts[pc.pts.length - 1].p)} · ${res.pieces.length > 1 ? `${res.pieces.length}× · ` : ''}${pc.dur.toFixed(1)}s` : '—';
        const on = s.id === p.activeStrokeId;
        const sel = (p.selectedIds || []).includes(s.id);
        row.className = `flex items-center gap-1.5 rounded-lg px-1.5 py-1 border cursor-pointer ${on ? 'bg-slate-950 border-pink-500/70' : sel ? 'bg-slate-950 border-sky-600/50' : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'}`;
      });
      return row;
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-pink-300', text: t('draw.strokes'), dataset: { help: 'draw.strokeList' } }),
        el('span', { class: 'text-[10px] text-slate-500', text: t('draw.count', params.strokes.length) }),
      ]),
      params.strokes.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('draw.empty') }),
      el('div', { class: 'flex flex-col gap-1 max-h-56 overflow-y-auto pr-1' }, rows),
    ]);
  }

  function buildDrawingRack() {
    const fitInfo = el('span', { class: 'font-mono text-[10px] text-slate-400', dataset: { help: 'draw.fitInfo' } });
    syncers.push(() => {
      const a = act();
      const res = a && getProcessedMap().get(a.id);
      fitInfo.textContent = res?.pieces.length ? t('draw.fitInfo', res.rawCount, res.pieces.reduce((n, pc) => n + pc.customPoints.length, 0), res.pieces.length, Math.max(...res.pieces.map((pc) => pc.rmse)).toFixed(3)) : '—';
    });
    const root = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]', dataset: { help: 'draw.scale' }, on: { change: (e) => { editTargets((s) => { s.scaleRoot = Number(e.target.value); }); commit(); } } },
      Array.from({ length: 12 }, (_, i) => el('option', { value: String(i), text: midiToNoteName(60 + i).replace(/\d+$/, '') })));
    syncers.push(() => { if (document.activeElement !== root) root.value = String(act()?.scaleRoot ?? 0); });
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('draw.drawingTitle') }),
      slider('draw.smooth', 'draw.smooth', sNum('smooth'), setSNum('smooth'), { min: 0, max: 1, step: 0.01, accent: 'accent-sky' }),
      fitInfo,
      labelled('draw.reversal', select('draw.reversal', REVERSAL_MODES.map((m) => [m, t(`draw.reversal.${m}`)]), () => act()?.reversal || 'drop', (val) => editTargets((s) => { s.reversal = val; s.timeMode = val === 'arc' ? 'arc' : 'x'; })), 'draw.reversal'),
      slider('draw.arcSpeed', 'draw.arcSpeed', sNum('arcSpeed'), setSNum('arcSpeed'), { min: 1, max: 60, step: 0.5, accent: 'accent-sky' }),
      labelled('draw.snap', select('draw.snap', SNAP_MODES.map((m) => [m, t(`draw.snap.${m}`)]), () => act()?.pitchSnap || 'off', (val) => editTargets((s) => { s.pitchSnap = val; })), 'draw.snap'),
      el('div', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', dataset: { help: 'draw.scale' } }, [
        t('draw.scale'),
        el('div', { class: 'flex gap-1' }, [root, select('draw.scale', SCALE_IDS.map((m) => [m, t(`draw.scale.${m}`)]), () => act()?.scaleId || 'major', (val) => editTargets((s) => { s.scaleId = val; }))]),
      ]),
      slider('draw.snapStrength', 'draw.snapStrength', sNum('snapStrength'), setSNum('snapStrength'), { min: 0, max: 1, step: 0.01, accent: 'accent-amber' }),
    ]);
  }

  function buildSoundRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({
      get: () => act()?.timbre,
      edit: (fn, k) => editTargets((s) => { s.timbre = { ...s.timbre }; fn(s.timbre); }, k),
      // Per-stroke Sampler: only the active stroke, never the whole selection / 획별 샘플러: 활성 획만
      sample: true,
      sampleEdit: (fn, k) => editDraw((d) => { const s = d.strokes.find((x) => x.id === d.activeStrokeId); if (s) { s.timbre = { ...s.timbre }; fn(s.timbre); } }, { coalesceKey: k }),
      toast: (m) => hooks.showToast(m),
      idPrefix: 'draw-timbre',
    });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'draw.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('draw.soundTitle') }),
      slider('draw.baseGain', 'draw.baseGain', sNum('baseGain'), setSNum('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      labelled('draw.gainSource', select('draw.gainSource', GAIN_SOURCES.map((m) => [m, t(`draw.gainSource.${m}`)]), () => act()?.gainSource || 'width', (val) => editTargets((s) => { s.gainSource = val; })), 'draw.gainSource'),
      slider('draw.widthDepth', 'draw.widthDepth', sNum('widthDepth'), setSNum('widthDepth'), { min: 0, max: 1, step: 0.01, accent: 'accent-emerald' }),
      timbre,
    ]);
  }

  function buildTransformRack() {
    const echoNum = (k) => () => num(getDrawParams().echo?.[k]);
    const setEcho = (k) => (val) => editDraw((d) => { d.echo = { ...d.echo, [k]: val }; }, { history: false });
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('draw.transformTitle') }),
      el('div', { class: 'flex flex-wrap gap-1.5' }, [
        toggle('draw.reverse', 'draw.reverse', () => !!act()?.transform?.reverse, () => { editTargets((s) => { s.transform = { ...s.transform, reverse: !s.transform.reverse }; }); commit(); }),
        toggle('draw.invert', 'draw.invert', () => !!act()?.transform?.invert, () => { editTargets((s) => { s.transform = { ...s.transform, invert: !s.transform.invert }; }); commit(); }),
        el('button', { class: BTN, text: t('draw.resetTransform'), dataset: { help: 'draw.transform' }, on: { click: () => { editTargets((s) => { s.transform = { transpose: 0, stretch: 1, reverse: false, invert: false }; }); commit(); } } }),
      ]),
      slider('draw.transpose', 'draw.transpose', trNum('transpose'), setTrNum('transpose'), { min: -36, max: 36, step: 0.5, unit: 'st', accent: 'accent-violet' }),
      slider('draw.stretch', 'draw.stretch', trNum('stretch'), setTrNum('stretch'), { min: 0.1, max: 4, step: 0.01, unit: '×', accent: 'accent-violet' }),
      el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: 'draw.echo' } }, [
        el('span', { class: 'text-[11px] font-semibold text-violet-200', text: t('draw.echoTitle') }),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
          slider('draw.echoCount', 'draw.echo', echoNum('count'), setEcho('count'), { min: 1, max: 8, step: 1, accent: 'accent-violet' }),
          slider('draw.echoDt', 'draw.echo', echoNum('dt'), setEcho('dt'), { min: 0, max: 4, step: 0.05, unit: 's', accent: 'accent-violet' }),
          slider('draw.echoDp', 'draw.echo', echoNum('dp'), setEcho('dp'), { min: -12, max: 12, step: 0.5, unit: 'st', accent: 'accent-violet' }),
          slider('draw.echoDecay', 'draw.echo', echoNum('decay'), setEcho('decay'), { min: 0.1, max: 1, step: 0.05, accent: 'accent-violet' }),
        ]),
        el('button', { class: BTN, text: `⟿ ${t('draw.echoApply')}`, dataset: { help: 'draw.echo' }, on: { click: echo } }),
      ]),
    ]);
  }

  function buildImportRack() {
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('draw.importTitle') }),
      slider('draw.importScale', 'draw.importScale', () => num(getDrawParams().importScale, 0.6), (val) => setView((d) => { d.importScale = val; }), { min: 0.1, max: 1, step: 0.05, accent: 'accent-cyan' }),
      el('div', { class: 'flex flex-wrap gap-1.5' }, Object.keys(DEMO_SVGS).map((k) => el('button', { class: BTN, text: t(`draw.demo.${k}`), dataset: { help: 'draw.importSvg' }, on: { click: () => importSvgText(DEMO_SVGS[k], t(`draw.demo.${k}`)) } }))),
      el('span', { class: 'text-[11px] text-slate-500', text: t('draw.importHint') }),
    ]);
  }

  // ------------------------------------------------------------------ keyboard tools
  const isTyping = (tg) => tg?.tagName === 'INPUT' || tg?.tagName === 'TEXTAREA' || tg?.tagName === 'SELECT' || tg?.isContentEditable;
  const KEY_TOOL = { d: 'draw', v: 'select', n: 'node', e: 'erase', l: 'line' };
  function onKey(e) {
    if (isTyping(e.target) || e.altKey) return;
    const k = e.key.toLowerCase();
    const mod = e.metaKey || e.ctrlKey;
    if (mod && k === 'd') { e.preventDefault(); e.stopPropagation(); duplicateSelected(); return; }
    if (mod) return;
    if (KEY_TOOL[k] && !e.shiftKey) {
      // L = Line tool here (header loop stays on its button) / 여기서 L은 직선 도구
      e.preventDefault();
      e.stopPropagation();
      setView((d) => { d.tool = KEY_TOOL[k]; });
      return;
    }
  }
  document.addEventListener('keydown', onKey, true);

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = getDrawParams();
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-4 flex flex-col gap-3 min-w-0' }, [buildStrokeList(params), buildDrawingRack(), buildSoundRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getDrawParams, edit: editDraw })), buildTransformRack(), buildImportRack()]),
      ]),
    );
  }

  function structureKey() {
    const p = getDrawParams();
    return [getLang(), p.strokes.map((s) => `${s.id}:${s.name}:${s.color}`).join(',')].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render();
    },
    fit,
    deleteSelection: deleteSelected, // Delete / Backspace (ui/studio-host.js)
    /** For tests / automation: import SVG text as strokes. / SVG 텍스트 가져오기 */
    importSvgText,
    destroy() {
      document.removeEventListener('keydown', onKey, true);
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
