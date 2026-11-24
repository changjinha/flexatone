/**
 * Flexatone — studios/chaos/chaos-panels.js
 * Chaos Studio UI tier: workspace DOM (header / actions, canvases, system · ensemble · mapping ·
 * discrete · sound racks). Mounted by ui/studio-host.js when the Chaos tab is active.
 * 카오스 스튜디오 작업 공간 DOM (헤더·액션, 캔버스, 시스템·앙상블·매핑·이산·음색 랙).
 *
 * Every control carries data-help="chaos.…" (Alt-hover inspector; entries registered into
 * HELP_DB below), and every number input is picked up by ui/number-scrub.js.
 * 모든 컨트롤에 data-help가 있으며 숫자 입력은 number-scrub이 처리.
 */

import { createLineMixRack } from '../../ui/line-mix-rack.js';
import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang, pickLocalized } from '../../core/i18n.js';
import { endHistoryGesture, registerSelfCheck } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN, STUDIO_SELECT } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { withStudioDefaults } from '../../ui/slider-reset.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { createSendButton, createReceiveUnavailable } from '../../ui/trajectory-ui.js';
import {
  CHAOS_SYSTEMS, MAX_CHAOS_VOICES, PITCH_CURVES, QUANTIZE_MODES, SCALES, DISCRETE_MODES, NORMALIZE_MODES, PROJECTIONS,
  getChaosSystem, systemSources, getBakeCount, getMapCount,
  AXIS_IDS, AXIS_TARGETS, axisDirection, defaultChaosAxes, AXIS_CENTER_RANGE, AXIS_LEN_RANGE,
} from './chaos-engine.js';
import { CHAOS_ID, CHAOS_COLORS, PRESET_IDS, getChaosParams, editChaos, getChaosBake, setChaosSystem, applyChaosPreset } from '../chaos-studio.js';
import { createChaosCanvases, AXIS_COLORS } from './chaos-canvases.js';
import { isChaosPlaying, refreshChaosLive, exportChaosJson, exportChaosWav, restartChaosAudio } from './chaos-audio.js';
import { CHAOS_HELP, CHAOS_HELP_KEYS } from './chaos-i18n.js';

// Help entries → the shared inspector DB (ui tier). / 도움말을 공용 DB에 등록
for (const [k, v] of Object.entries(CHAOS_HELP)) HELP_DB[k] = v;

registerSelfCheck('Chaos: every help key has EN/KO help, every label has EN/KO text', (a) => {
  const missing = CHAOS_HELP_KEYS.filter((k) => !HELP_DB[k]?.en?.title || !HELP_DB[k]?.ko?.title);
  a.ok(!missing.length, `missing help: ${missing.join(', ')}`);
}, { group: 'studio' });

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const SYM = { sigma: 'σ', rho: 'ρ', beta: 'β', delta: 'δ', alpha: 'α', gamma: 'γ', omega: 'ω' };
const symOf = (id) => SYM[id] || id;

/**
 * Mount the Chaos workspace into `root`. / 카오스 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountChaosWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let cur = getChaosParams(); // document of the current render / 현재 렌더의 문서
  let bake = null;
  const commit = () => endHistoryGesture();

  // Getters read `cur` (the document of the current render): the default probe swaps it for the default document
  // 게터가 cur를 읽으므로 기본값 조회 시 cur를 기본 문서로 잠시 교체
  const probe = (get) => { const keep = cur; try { cur = withStudioDefaults(() => getChaosParams(), CHAOS_ID); const v = Number(get()); return Number.isFinite(v) ? v : null; } catch { return null; } finally { cur = keep; } };
  const { slider, toggle, select, segment, labelled } = createStudioControls({ push: (fn) => syncers.push(fn), commit, probe, keyOf: (label, help) => `chaos:${label}:${help}`, selectClass: `${STUDIO_SELECT} min-w-0` });
  const showIf = (node, pred) => { syncers.push(() => node.classList.toggle('hidden', !pred())); return node; };

  const setTop = (k, opt = {}) => (val, ck) => editChaos((d) => { d[k] = val; d.preset = ''; }, { coalesceKey: ck, ...opt });
  const getTop = (k) => () => num(cur[k]);

  // ------------------------------------------------------------------ header
  function buildHeader() {
    const status = el('span', { class: 'px-2 py-0.5 rounded-full border text-[11px] font-mono', dataset: { help: 'chaos.status' } });
    const budget = el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] text-slate-300 font-mono', dataset: { help: 'chaos.budget' } });
    syncers.push(() => {
      const A = bake.A;
      const bad = A.voices.map((v, i) => (v.diverged ? i + 1 : 0)).filter(Boolean);
      if (bad.length) {
        status.className = 'px-2 py-0.5 rounded-full border text-[11px] font-mono bg-rose-500/15 text-rose-300 border-rose-500/40';
        status.textContent = t('chaos.statusDiverged', bad.join(', '));
      } else {
        status.className = 'px-2 py-0.5 rounded-full border text-[11px] font-mono bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
        status.textContent = t('chaos.statusBaked', A.N, bake.M, A.bakeMs.toFixed(0), getBakeCount(), getMapCount());
      }
      budget.textContent = `${t('chaos.budgetLine', (A.steps / 1e6).toFixed(2), ((A.N * bake.M) / 1e3).toFixed(0))}${A.dtClamped ? ` · ${t('chaos.dtClamped', A.dt.toPrecision(3))}` : ''}`;
    });
    const presetSel = select('chaos.preset', [['', t('chaos.preset.custom')], ...PRESET_IDS.map((id) => [id, t(`chaos.preset.${id}`)])], () => cur.preset || '', (id) => {
      if (!id) return;
      editChaos((d) => applyChaosPreset(d, id));
      hooks.showToast(t('chaos.presetApplied', t(`chaos.preset.${id}`)));
    });
    const bakeTo = (mode) => {
      const res = StudioRegistry.bakeVoices(CHAOS_ID, { mode });
      hooks.showToast(t('chaos.bakedToGliss', res.result?.length || 0, bake.A.N), 'info');
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2 min-w-0' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-fuchsia-300', text: t('studio.chaos'), dataset: { help: 'chaos.header' } }),
          el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] text-slate-200', text: `${pickLocalized(getChaosSystem(cur.system).name)} · ${t('chaos.voiceCount', cur.voices)}` }),
          status,
          budget,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          createReceiveUnavailable('traj.na.chaos'),
          createSendButton('chaos'), // this studio's lines → another studio / Master / 보내기
          labelled('chaos.presetLabel', presetSel, 'chaos.preset'),
          el('button', { class: BTN, text: `🎲 ${t('chaos.reseed')}`, dataset: { help: 'chaos.seedRoll' }, on: { click: () => { editChaos((d) => { d.seed = 1 + Math.floor(Math.random() * 9999); d.preset = ''; }); commit(); } } }),
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('chaos.bakeGliss')}`, dataset: { help: 'chaos.bakeGliss' }, on: { click: () => bakeTo('replace') } }),
          el('button', { class: BTN, text: t('chaos.bakeAppend'), dataset: { help: 'chaos.bakeGliss' }, on: { click: () => bakeTo('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('chaos.exportJson')}`, dataset: { help: 'chaos.exportJson' }, on: { click: () => { exportChaosJson(); hooks.showToast(t('chaos.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('chaos.exportWav')}`, dataset: { help: 'chaos.exportWav' }, on: { click: async () => {
            hooks.showToast(t('toast.wavStart'));
            try { const r = await exportChaosWav(); hooks.showToast(r.ok ? t('toast.wavDone', r.filename) : r.message, r.ok ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
          } } }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ canvases
  function buildCanvasCol(sys) {
    const portrait = el('canvas', { class: 'w-full h-[320px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'chaos.portrait' } });
    const pitch = el('canvas', { class: 'w-full h-[230px] rounded-lg bg-slate-950 block', dataset: { help: 'chaos.pitchCanvas' } });
    const diverge = el('canvas', { class: 'w-full h-[170px] rounded-lg bg-slate-950 block', dataset: { help: 'chaos.divergeCanvas' } });
    const bif = el('canvas', { class: 'w-full h-[140px] rounded-lg bg-slate-950 block', dataset: { help: 'chaos.bif' } });
    const analysis = el('span', { class: 'text-[11px] font-mono text-amber-200', dataset: { help: 'chaos.analysis' } });
    syncers.push(() => {
      const A = bake.A;
      const unit = A.kind === 'map' ? t('chaos.perIter') : t('chaos.perSec');
      const l = Number.isFinite(A.lyapunov) ? A.lyapunov.toFixed(3) : '—';
      const f = Number.isFinite(A.fitSlope) ? A.fitSlope.toFixed(3) : '—';
      const dv = A.divergeSec !== null ? t('chaos.divergeAt', A.divergeSec.toFixed(2), A.divergeSim.toFixed(1)) : t('chaos.noDiverge');
      analysis.textContent = `λmax ≈ ${l} ${unit} · ${t('chaos.fitSlope')} ${f} · ${dv}`;
    });
    let rot = null;
    canvases = createChaosCanvases({ portrait, pitch, diverge, bif }, {
      requestRender: hooks.requestRender,
      onRotate: (dy, dt, done) => {
        if (done) { rot = null; return; }
        rot = rot || { yaw: num(cur.view.yaw), tilt: num(cur.view.tilt) };
        rot.yaw += dy;
        rot.tilt = clamp(rot.tilt + dt, -1.5, 1.5);
        editChaos((d) => { d.view.yaw = roundTo(rot.yaw, 4); d.view.tilt = roundTo(rot.tilt, 4); }, { history: false });
      },
      // Dragging an axis handle edits the document (one undo step per drag). / 축 핸들 드래그 = 문서 편집
      onAxis: (i, patch, done) => {
        if (done) { commit(); return; }
        editChaos((d) => { Object.assign(d.axes[i], patch); d.preset = ''; }, { coalesceKey: `chaos:axisDrag:${i}` });
      },
    });
    const axisEditBtn = toggle('chaos.axisEdit', 'chaos.axisEdit', () => !!cur.view.axesEdit, () => editChaos((d) => { d.view.axesEdit = !d.view.axesEdit; }, { history: false }));
    axisEditBtn.textContent = `✥ ${t('chaos.axisEdit')}`;
    const projSeg = segment('chaos.proj', PROJECTIONS.map((p) => [p, t(`chaos.proj.${p}`)]), () => cur.view.proj, (p) => editChaos((d) => { d.view.proj = p; }, { history: false }), 'sky');
    const trail = slider('chaos.trail', 'chaos.trail', () => num(cur.view.trailSec, 2.5), (v) => editChaos((d) => { d.view.trailSec = v; }, { history: false }), { min: 0.2, max: 10, step: 0.1, unit: 's', accent: 'accent-sky' });
    const legend = el('div', { class: 'flex flex-wrap gap-1.5' }, Array.from({ length: cur.voices }, (_, i) => el('span', { class: 'flex items-center gap-1 text-[11px] text-slate-400 font-mono' }, [el('span', { class: 'w-2.5 h-2.5 rounded-full', style: `background:${CHAOS_COLORS[i % CHAOS_COLORS.length]}` }), String(i + 1)])));
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [
        el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
          el('h3', { class: 'text-xs font-semibold text-sky-300', text: t('chaos.portraitTitle'), dataset: { help: 'chaos.portrait' } }),
          projSeg,
          axisEditBtn,
          el('div', { class: 'w-40' }, [trail]),
        ]),
        portrait,
        legend,
      ]),
      el('section', { class: SECTION }, [
        el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
          el('h3', { class: 'text-xs font-semibold text-emerald-300', text: t('chaos.pitchTitle'), dataset: { help: 'chaos.pitchCanvas' } }),
          el('span', { class: 'text-[11px] text-slate-500', text: t('view.navHint') }),
        ]),
        // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [...createLocateButtons({ unavailable: 'locate.na.generated' }), createZoomBar({ onPitch: (f) => canvases?.zoomPitchCanvas('pitch', f), onTime: (f) => canvases?.zoomPitchCanvas('time', f), onBoth: (f) => canvases?.zoomPitchCanvas('both', f), onFit: () => canvases?.fit() })]), // Locate has nothing to move here: off, with the reason / 이동 도구: 꺼진 채 이유 표시
        pitch,
      ]),
      el('section', { class: SECTION }, [
        el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
          el('h3', { class: 'text-xs font-semibold text-rose-300', text: t('chaos.divergeTitle'), dataset: { help: 'chaos.divergeCanvas' } }),
          analysis,
        ]),
        diverge,
      ]),
      sys.kind === 'map' ? el('section', { class: SECTION }, [
        el('h3', { class: 'text-xs font-semibold text-violet-300', text: t('chaos.bifTitle'), dataset: { help: 'chaos.bif' } }),
        bif,
      ]) : null,
    ]);
  }

  // ------------------------------------------------------------------ racks
  function buildSystemRack(sys) {
    const tabs = el('div', { class: 'grid grid-cols-4 gap-1' }, [...CHAOS_SYSTEMS.values()].map((s) => el('button', {
      class: `px-1.5 py-1 rounded-md border text-[11px] truncate transition ${s.id === sys.id ? 'bg-fuchsia-600 border-fuchsia-400 text-white font-semibold' : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-600'}`,
      text: pickLocalized(s.name),
      title: pickLocalized(s.name),
      dataset: { help: `chaos.sys.${s.id}` },
      on: { click: () => { if (s.id !== cur.system) { editChaos((d) => { setChaosSystem(d, s.id); d.preset = ''; }); commit(); } } },
    })));
    const params = sys.params.map((p) => slider(symOf(p.id), `chaos.sys.${sys.id}`, () => num(cur.params[p.id], p.default), (v, ck) => editChaos((d) => { d.params[p.id] = v; d.preset = ''; }, { coalesceKey: ck }), { min: p.min, max: p.max, step: p.step, raw: true, accent: 'accent-fuchsia' }));
    const sw = () => cur.sweep;
    const sweepBody = el('div', { class: 'flex flex-col gap-1.5' }, [
      labelled('chaos.sweepParam', select('chaos.sweep', sys.params.map((p) => [p.id, symOf(p.id)]), () => sw().param, (v) => editChaos((d) => { const def = sys.params.find((q) => q.id === v); d.sweep = { ...d.sweep, param: v, from: def.min, to: def.max }; d.preset = ''; })), 'chaos.sweep'),
      ...['from', 'to'].map((k) => slider(`chaos.sweep.${k}`, 'chaos.sweep', () => num(sw()[k]), (v, ck) => editChaos((d) => { d.sweep[k] = v; d.preset = ''; }, { coalesceKey: ck }), (() => { const def = sys.params.find((q) => q.id === cur.sweep.param) || sys.params[0]; return { min: def.min, max: def.max, step: def.step, accent: 'accent-fuchsia' }; })())),
    ]);
    showIf(sweepBody, () => !!cur.sweep.on && sys.params.some((p) => p.id === cur.sweep.param));
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-fuchsia-300', text: t('chaos.systemTitle'), dataset: { help: 'chaos.system' } }),
        el('span', { class: 'text-[11px] text-slate-500', text: t(sys.kind === 'map' ? 'chaos.kind.map' : 'chaos.kind.flow') }),
      ]),
      tabs,
      el('div', { class: 'text-[11px] font-mono text-slate-300 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 break-words', text: sys.equation, dataset: { help: `chaos.sys.${sys.id}` } }),
      ...params,
      el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5' }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('span', { class: 'text-[11px] text-slate-300', text: t('chaos.sweepTitle'), dataset: { help: 'chaos.sweep' } }),
          toggle('chaos.sweepOn', 'chaos.sweep', () => !!cur.sweep.on, () => { editChaos((d) => { d.sweep.on = !d.sweep.on; if (!sys.params.some((p) => p.id === d.sweep.param)) { const p0 = sys.params[0]; Object.assign(d.sweep, { param: p0.id, from: p0.min, to: p0.max }); } d.preset = ''; }); commit(); }),
        ]),
        sweepBody,
      ]),
    ]);
  }

  function buildEnsembleRack(sys) {
    const flow = sys.kind === 'flow';
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('chaos.ensembleTitle'), dataset: { help: 'chaos.voices' } }),
      slider('chaos.voices', 'chaos.voices', getTop('voices'), setTop('voices'), { min: 1, max: MAX_CHAOS_VOICES, step: 1, integer: true }),
      slider('chaos.spread', 'chaos.spread', () => roundTo(Math.log10(num(cur.spread, 1e-6)), 2), (v, ck) => editChaos((d) => { d.spread = Number((10 ** v).toPrecision(4)); d.preset = ''; }, { coalesceKey: ck }), { min: -12, max: -1, step: 0.1, unit: 'log₁₀' }),
      slider('chaos.seed', 'chaos.seed', getTop('seed'), setTop('seed'), { min: 0, max: 9999, step: 1, integer: true }),
      flow ? slider('chaos.dt', 'chaos.dt', getTop('dt'), setTop('dt'), { min: 0.0005, max: 0.05, step: 0.0005 }) : null,
      slider(flow ? 'chaos.transient' : 'chaos.transientIter', 'chaos.transient', getTop('transient'), setTop('transient'), { min: 0, max: flow ? 200 : 2000, step: flow ? 1 : 10 }),
      flow ? slider('chaos.simTime', 'chaos.simTime', getTop('simTime'), setTop('simTime'), { min: 5, max: 1000, step: 1 }) : null,
      slider('chaos.duration', 'chaos.duration', getTop('duration'), setTop('duration'), { min: 2, max: 120, step: 0.5, unit: 's' }),
    ]);
  }

  function channelBlock(ch, sys, accent) {
    const g = () => cur.map[ch];
    const set = (k) => (v, ck) => editChaos((d) => { d.map[ch][k] = v; d.preset = ''; }, { coalesceKey: ck });
    const pitch = ch === 'pitch';
    const sources = [...systemSources(sys), ...AXIS_IDS].map((id) => [id, t(`chaos.src.${id}`)]);
    // A channel assigned to a 3-D axis shows that axis as its source. / 3D 축에 할당되면 소스 = 축
    const getSource = () => { const k = cur.axes.findIndex((a) => a.target === ch); return k >= 0 ? AXIS_IDS[k] : g().source; };
    const setSource = (v) => editChaos((d) => {
      const k = AXIS_IDS.indexOf(v);
      d.axes.forEach((a, q) => { if (a.target === ch && q !== k) a.target = 'none'; });
      if (k >= 0) d.axes[k].target = ch; else d.map[ch].source = v;
      d.preset = '';
    });
    const rangeOpt = pitch ? { min: 12, max: 120, step: 1, unit: 'MIDI' } : { min: 0, max: 1, step: 0.01 };
    const rows = [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('span', { class: `text-[11px] font-semibold ${accent} w-14`, text: t(`chaos.ch.${ch}`), dataset: { help: `chaos.map.${ch}` } }),
        select('chaos.map.source', sources, getSource, setSource),
        select('chaos.map.curve', PITCH_CURVES.map((c) => [c, t(`chaos.curve.${c}`)]), () => g().curve, (v) => editChaos((d) => { d.map[ch].curve = v; d.preset = ''; })),
        toggle('chaos.invert', 'chaos.map.invert', () => !!g().invert, () => { editChaos((d) => { d.map[ch].invert = !d.map[ch].invert; d.preset = ''; }); commit(); }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        slider('chaos.lo', 'chaos.map.range', () => num(g().lo), set('lo'), rangeOpt),
        slider('chaos.hi', 'chaos.map.range', () => num(g().hi), set('hi'), rangeOpt),
      ]),
    ];
    if (pitch) {
      const scaleRow = el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('chaos.scale', select('chaos.map.quantize', Object.keys(SCALES).map((s) => [s, t(`chaos.scale.${s}`)]), () => g().scale, (v) => editChaos((d) => { d.map.pitch.scale = v; d.preset = ''; })), 'chaos.map.quantize'),
        labelled('chaos.root', select('chaos.map.quantize', ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'].map((n, i) => [String(i), n]), () => String(g().root ?? 0), (v) => editChaos((d) => { d.map.pitch.root = Number(v); d.preset = ''; })), 'chaos.map.quantize'),
      ]);
      showIf(scaleRow, () => cur.map.pitch.quantize === 'scale');
      const quantAmt = slider('chaos.quantAmt', 'chaos.map.quantAmt', () => roundTo(num(g().quantAmt, 1) * 100, 1), (v, ck) => editChaos((d) => { d.map.pitch.quantAmt = roundTo(v / 100, 4); d.preset = ''; }, { coalesceKey: ck }), { min: 0, max: 100, step: 1, unit: '%', accent: 'accent-emerald' });
      showIf(quantAmt, () => cur.map.pitch.quantize !== 'off');
      rows.push(
        slider('chaos.sens', 'chaos.map.sens', () => num(g().sens, 1), set('sens'), { min: 0, max: 4, step: 0.05, unit: '×', accent: 'accent-emerald' }),
        labelled('chaos.quantize', segment('chaos.map.quantize', QUANTIZE_MODES.map((q) => [q, t(`chaos.quant.${q}`)]), () => g().quantize, (v) => editChaos((d) => { d.map.pitch.quantize = v; d.preset = ''; }), 'emerald'), 'chaos.map.quantize'),
        quantAmt,
        scaleRow,
        sys.kind === 'flow' ? slider('chaos.slew', 'chaos.map.slew', () => num(g().slewMs), set('slewMs'), { min: 0, max: 500, step: 1, unit: 'ms', accent: 'accent-emerald' }) : null,
      );
    }
    return el('div', { class: 'flex flex-col gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-2', dataset: { help: `chaos.map.${ch}` } }, rows);
  }

  function buildMappingRack(sys) {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('chaos.mapTitle'), dataset: { help: 'chaos.map.source' } }),
        labelled('chaos.normalize', select('chaos.normalize', NORMALIZE_MODES.map((n) => [n, t(`chaos.norm.${n}`)]), () => cur.normalize, (v) => editChaos((d) => { d.normalize = v; d.preset = ''; })), 'chaos.normalize'),
      ]),
      channelBlock('pitch', sys, 'text-emerald-300'),
      channelBlock('gain', sys, 'text-amber-300'),
      channelBlock('bright', sys, 'text-rose-300'),
    ]);
  }

  /**
   * 3-D mapping axes: for each axis choose the sound channel it drives, then turn it (angle),
   * move it (position along the axis) and set its strength (1 / length). The same edits are
   * available by dragging the handles in the portrait (✥ Edit axes).
   * 3D 매핑 축: 축마다 구동할 채널을 고르고 각도·위치·강도(1/길이)를 바꿈. 위상 초상에서 핸들로도 편집.
   */
  function buildAxesRack() {
    const ax = (i) => cur.axes[i];
    const edit = (i, fn, ck = null) => editChaos((d) => { fn(d.axes[i], d); d.preset = ''; }, { coalesceKey: ck });
    const blocks = AXIS_IDS.map((id, i) => {
      const letter = 'ABC'[i];
      const chip = el('span', { class: 'w-5 h-5 rounded-md text-[11px] font-bold flex items-center justify-center text-slate-950', text: letter });
      syncers.push(() => { chip.style.background = AXIS_COLORS[ax(i).target] || AXIS_COLORS.none; });
      const target = segment('chaos.axis.target', AXIS_TARGETS.map((v) => [v, v === 'none' ? t('chaos.axis.none') : t(`chaos.ch.${v}`)]), () => ax(i).target, (v) => editChaos((d) => {
        if (v !== 'none') d.axes.forEach((a, q) => { if (q !== i && a.target === v) a.target = 'none'; });
        d.axes[i].target = v;
        d.preset = '';
      }), 'emerald');
      const align = el('div', { class: 'flex gap-0.5', dataset: { help: 'chaos.axis.angle' } }, [['x', 0, 0], ['y', 90, 0], ['z', 0, 90]].map(([n, az, elv]) => el('button', {
        class: 'px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-[10px] text-slate-300 hover:text-white font-mono',
        text: n,
        title: t('chaos.axis.alignTo', n),
        on: { click: () => { edit(i, (a) => { a.az = az; a.el = elv; }); commit(); } },
      })));
      const weights = el('span', { class: 'text-[10px] font-mono text-slate-400', dataset: { help: 'chaos.axis.angle' } });
      syncers.push(() => {
        const d = axisDirection(ax(i));
        weights.textContent = `${t('chaos.axis.weights')} ${['x', 'y', 'z'].map((n, k) => `${n} ${d[k] >= 0 ? '+' : '−'}${Math.abs(d[k]).toFixed(2)}`).join(' · ')}`;
      });
      const along = () => { const a = ax(i); const d = axisDirection(a); return roundTo(a.c[0] * d[0] + a.c[1] * d[1] + a.c[2] * d[2], 3); };
      const body = el('div', { class: 'flex flex-col gap-1.5' }, [
        el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
          slider('chaos.axis.az', 'chaos.axis.angle', () => ax(i).az, (v, ck) => edit(i, (a) => { a.az = v; }, ck), { min: -180, max: 180, step: 1, unit: '°', accent: 'accent-sky' }),
          slider('chaos.axis.el', 'chaos.axis.angle', () => ax(i).el, (v, ck) => edit(i, (a) => { a.el = v; }, ck), { min: -90, max: 90, step: 1, unit: '°', accent: 'accent-sky' }),
          slider('chaos.axis.strength', 'chaos.axis.strength', () => roundTo(1 / ax(i).len, 2), (v, ck) => edit(i, (a) => { a.len = roundTo(clamp(1 / Math.max(0.01, v), AXIS_LEN_RANGE[0], AXIS_LEN_RANGE[1]), 4); }, ck), { min: 0.25, max: 10, step: 0.05, unit: '×', accent: 'accent-emerald' }),
          slider('chaos.axis.pos', 'chaos.axis.pos', along, (v, ck) => edit(i, (a) => {
            // move the centre along the axis only (the sideways part does not change the sound)
            // 중심을 축 방향으로만 이동 (옆 방향은 소리에 영향 없음)
            const d = axisDirection(a);
            const cur0 = a.c[0] * d[0] + a.c[1] * d[1] + a.c[2] * d[2];
            a.c = a.c.map((q, k) => roundTo(clamp(q + (v - cur0) * d[k], -AXIS_CENTER_RANGE, AXIS_CENTER_RANGE), 4));
          }, ck), { min: -2, max: 2, step: 0.01, accent: 'accent-amber' }),
        ]),
        el('div', { class: 'flex items-center justify-between gap-2' }, [weights, align]),
      ]);
      showIf(body, () => ax(i).target !== 'none' || !!cur.view.axesEdit);
      return el('div', { class: 'flex flex-col gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-2', dataset: { help: 'chaos.axes' } }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [chip, target]),
        body,
      ]);
    });
    const editBtn = toggle('chaos.axisEdit', 'chaos.axisEdit', () => !!cur.view.axesEdit, () => editChaos((d) => { d.view.axesEdit = !d.view.axesEdit; }, { history: false }));
    editBtn.textContent = `✥ ${t('chaos.axisEdit')}`;
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('chaos.axesTitle'), dataset: { help: 'chaos.axes' } }),
        el('div', { class: 'flex gap-1' }, [
          editBtn,
          el('button', { class: BTN, text: t('chaos.axis.reset'), dataset: { help: 'chaos.axis.reset' }, on: { click: () => { editChaos((d) => { d.axes = defaultChaosAxes(); d.preset = ''; }); commit(); } } }),
        ]),
      ]),
      el('span', { class: 'text-[11px] text-slate-500', text: t('chaos.axesNote') }),
      ...blocks,
    ]);
  }

  function buildDiscreteRack() {
    const dget = (k) => () => num(cur.discrete[k]);
    const dset = (k) => (v, ck) => editChaos((d) => { d.discrete[k] = v; d.preset = ''; }, { coalesceKey: ck });
    const glide = slider('chaos.glideMs', 'chaos.discrete.glide', dget('glideMs'), dset('glideMs'), { min: 5, max: 500, step: 1, unit: 'ms' });
    showIf(glide, () => cur.discrete.mode === 'glide');
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('chaos.discreteTitle'), dataset: { help: 'chaos.discrete.mode' } }),
        segment('chaos.discrete.mode', DISCRETE_MODES.map((m) => [m, t(`chaos.disc.${m}`)]), () => cur.discrete.mode, (v) => editChaos((d) => { d.discrete.mode = v; d.preset = ''; })),
      ]),
      slider('chaos.rate', 'chaos.discrete.rate', dget('rate'), dset('rate'), { min: 0.5, max: 32, step: 0.5, unit: t('chaos.notesPerSec') }),
      glide,
    ]);
  }

  function buildSoundRack() {
    const tget = (k) => () => num(cur.timbre[k]);
    const tset = (k) => (v, ck) => editChaos((d) => { d.timbre[k] = v; }, { coalesceKey: ck });
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ probe, get: () => cur.timbre, edit: (fn, k) => editChaos((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'chaos-timbre' });
    syncers.push(timbreEd.sync);
    const waves = el('div', { class: 'min-w-0', dataset: { help: 'chaos.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('chaos.soundTitle'), dataset: { help: 'chaos.timbre' } }),
      waves,
      slider('chaos.baseGain', 'chaos.baseGain', tget('baseGain'), tset('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-amber' }),
      slider('chaos.width', 'chaos.width', tget('width'), tset('width'), { min: 0, max: 1, step: 0.01, accent: 'accent-amber' }),
      slider('chaos.brightAmt', 'chaos.brightAmt', tget('brightAmt'), tset('brightAmt'), { min: 0, max: 1, step: 0.01, accent: 'accent-rose' }),
      el('span', { class: 'text-[11px] text-slate-500', text: t('chaos.bakeLossNote'), dataset: { help: 'chaos.bakeGliss' } }),
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const sys = getChaosSystem(cur.system);
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(sys),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [
          buildSystemRack(sys),
          buildEnsembleRack(sys),
          buildMappingRack(sys),
          buildAxesRack(),
          sys.kind === 'map' ? buildDiscreteRack() : null,
          buildSoundRack(),
          ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getChaosParams, edit: editChaos })),
          ((r) => { syncers.push(r.sync); return r.root; })(createLineMixRack({ studio: 'chaos', get: getChaosParams, edit: editChaos, onChange: restartChaosAudio })), // S / M / gain per voice / 보이스별 S·M·게인
        ]),
      ]),
    );
  }
  const structureKey = () => [getLang(), cur.system, cur.voices, cur.sweep.param].join('|');

  return {
    render() {
      cur = getChaosParams();
      bake = getChaosBake(cur); // edit-time bake; cached on every frame / 편집 시 1회, 이후 캐시
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render(cur, bake);
      if (isChaosPlaying()) refreshChaosLive(bake);
    },
    fit() { canvases?.fit(); },
    destroy() {
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}

