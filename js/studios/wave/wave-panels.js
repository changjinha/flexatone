/**
 * Flexatone — studios/wave/wave-panels.js
 * Wave Studio UI tier: the workspace DOM (status strip, toolbar, canvas, equation / medium /
 * initial-condition / driver / sonification racks). Mounted by ui/studio-host.js when the Wave
 * tab is active (registered in ui/workspaces.js).
 * 웨이브 스튜디오 작업 공간 DOM (상태 스트립, 툴바, 캔버스, 방정식·매질·초기 조건·구동·음향화 랙).
 *
 * Every control carries data-help="wave.…" for the Option(Alt) inspector (entries registered
 * below from wave-i18n.js), and every number input is picked up by ui/number-scrub.js.
 * 모든 컨트롤에 data-help가 있고(아래에서 도움말 등록), 숫자 입력은 number-scrub이 처리.
 */

import { createLineMixRack } from '../../ui/line-mix-rack.js';
import { clamp } from '../../core/math-utils.js';
import { midiToNoteName, noteNameToMidi } from '../../core/units.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN, STUDIO_SELECT } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { WAVE_VIEW_LIMITS } from './wave-canvases.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { createSendButton, createReceiveUnavailable } from '../../ui/trajectory-ui.js';
import {
  WAVE_EQS, WAVE_POTENTIALS, harmonicLength, WAVE_BOUNDARIES, WAVE_INIT_KINDS, WAVE_SOURCES, WAVE_COLORS, WAVE_ENGINES, WAVE_NX, WAVE_PRESET_IDS, WAVE_MAX_INIT, WAVE_MAX_DRIVERS, WAVE_MAX_TRACKS, createWaveInit, createWaveDriver, getWaveBakeCount,
} from './wave-engine.js';
import { WAVE_ID, getWaveParams, editWave, getWaveBake, getWaveRidges, fitWaveView, applyWavePreset } from '../wave-studio.js';
import { WAVE_HELP } from './wave-i18n.js';
import { createWaveCanvases } from './wave-canvases.js';
import { exportWaveJson, exportWaveWav, isWavePlaying, getWaveEngineKind } from './wave-audio.js';

// Register the help entries once (HELP_DB is a plain mutable object). / 도움말 등록
for (const [key, entry] of Object.entries(WAVE_HELP)) {
  const mk = ([title, summary, detail, formula]) => ({ title, summary, detail: detail || summary, formula: formula || '' });
  if (!HELP_DB[key]) HELP_DB[key] = { en: mk(entry.en), ko: mk(entry.ko) };
}

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BADGE = 'px-2 py-0.5 rounded-full border text-[11px] font-mono whitespace-nowrap';
const H3 = 'text-xs font-bold uppercase tracking-wider';

/**
 * Mount the Wave workspace into `root`. / 웨이브 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountWaveWorkspace(root, hooks) {
  // Two syncer lists: the static part (strip, canvas, sonification) is built once per language;
  // the racks that depend on the document structure are rebuilt on their own, so the canvas
  // element survives while a pulse is being dragged into existence.
  // 정적 부분은 언어당 1회 생성, 구조 의존 랙만 따로 재생성 (드래그 중 캔버스 유지).
  let staticSync = [];
  let rackSync = [];
  let sink = staticSync;
  let hosts = null; // { init, driver, eq }
  let langKey = '';
  let rackKey = '';
  let canvases = null;
  const commit = () => endHistoryGesture();

  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => sink.push(fn), commit, keyOf: (label, help, opts) => `wave:${opts.id ?? label}`, narrow: true });

  /** Segmented buttons. options: [value, label, helpKey]. / 세그먼트 버튼 */
  const segment = (options, get, set, color) => sharedSegment(null, options, get, set, color);
  const stacked = (labelKey, control, help) => el('label', { class: 'flex flex-col gap-0.5 text-[11px] text-slate-300 min-w-0', dataset: { help } }, [el('span', { class: 'truncate', text: t(labelKey) }), control]);

  const P = () => getWaveParams();
  const docNum = (k) => () => num(P()[k]);
  const setDocNum = (k) => (val, ck) => editWave((d) => { d[k] = val; }, { coalesceKey: ck });
  const sonNum = (k) => () => num(P().sonify[k]);
  const setSonNum = (k) => (val, ck) => editWave((d) => { d.sonify[k] = val; }, { coalesceKey: ck });
  const setView = (fn) => editWave((d) => fn(d.view, d), { history: false });

  // ------------------------------------------------------------------ status strip
  function buildStrip() {
    const bake = el('span', { class: `${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`, dataset: { help: 'wave.bake' } });
    const cfl = el('span', { class: BADGE, dataset: { help: 'wave.cfl' } });
    const energy = el('span', { class: `${BADGE} bg-slate-800 text-slate-300 border-slate-700`, dataset: { help: 'wave.energy' } });
    const engine = el('span', { class: `${BADGE} bg-slate-800 text-slate-300 border-slate-700`, dataset: { help: 'wave.engine' } });
    const tracks = el('span', { class: `${BADGE} bg-slate-800 text-slate-300 border-slate-700`, dataset: { help: 'wave.ridgeBadge' } });
    sink.push(() => {
      const p = P();
      const b = getWaveBake(p);
      bake.textContent = t('wave.bakeStatus', b.frames, b.N, getWaveBakeCount(), b.ms.toFixed(0));
      const warn = b.clamped || b.rateClamped;
      cfl.className = `${BADGE} ${warn ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      cfl.textContent = [
        t(p.eq === 'gs' ? 'wave.lambdaBadge' : 'wave.cflBadge', b.cfl.toFixed(2)),
        b.clamped ? t('wave.clampedBadge') : '',
        b.rateClamped ? t('wave.rateClamped', b.rate.toFixed(1)) : '',
      ].filter(Boolean).join(' · ');
      energy.textContent = b.energyErr === null ? t('wave.energyNA') : t('wave.energyBadge', (b.energyErr * 100).toFixed(b.energyErr < 1e-4 ? 4 : 2));
      const kind = isWavePlaying() ? getWaveEngineKind() : null;
      engine.textContent = t(`wave.engineBadge.${kind || 'idle'}`);
      engine.className = `${BADGE} ${kind ? 'bg-sky-500/15 text-sky-300 border-sky-500/40' : 'bg-slate-800 text-slate-300 border-slate-700'}`;
      tracks.textContent = t('wave.tracksBadge', getWaveRidges(p).tracks.length);
    });

    const bakeTo = (mode) => {
      const p = P();
      const res = StudioRegistry.bakeVoices(WAVE_ID, { mode });
      const n = Array.isArray(res.result) ? res.result.length : 0;
      if (!n) { hooks.showToast(t('wave.bakedNone'), 'error'); return; }
      hooks.showToast(t(p.sonify.mode === 'spectral' ? 'wave.bakedSpectral' : 'wave.bakedToGliss', n));
    };
    const preset = select('wave.preset', WAVE_PRESET_IDS.map((id) => [id, t(`wave.preset.${id}`)]), () => P().preset, (id) => {
      applyWavePreset(id);
      hooks.showToast(t('wave.presetApplied', t(`wave.preset.${id}`)));
    });
    const seed = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'wave.seed' } });
    seed.addEventListener('change', () => { editWave((d) => { d.seed = Math.round(clamp(num(seed.value, d.seed), 0, 999999)); }); commit(); });
    sink.push(() => { if (document.activeElement !== seed) seed.value = String(P().seed); });

    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('h2', { class: `${H3} text-sky-300 mr-1`, text: t('wave.title') }),
          bake, cfl, energy, tracks, engine,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          createReceiveUnavailable('traj.na.wave'),
          createSendButton('wave'), // this studio's ridges → another studio / Master / 보내기
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'wave.preset' } }, [t('wave.preset'), preset]),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'wave.seed' } }, [t('wave.seed'), seed]),
          el('button', { class: BTN, text: `🎲 ${t('wave.reseed')}`, dataset: { help: 'wave.seed' }, on: { click: () => {
            const s = Math.floor(Math.random() * 999999) + 1;
            editWave((d) => { d.seed = s; });
            commit();
            hooks.showToast(t('wave.reseeded', s));
          } } }),
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('wave.bakeGliss')}`, dataset: { help: 'wave.bakeGliss' }, on: { click: () => bakeTo('replace') } }),
          el('button', { class: BTN, text: t('wave.bakeAppend'), dataset: { help: 'wave.bakeGliss' }, on: { click: () => bakeTo('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('wave.exportJson')}`, dataset: { help: 'wave.exportJson' }, on: { click: () => { exportWaveJson(); hooks.showToast(t('wave.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('wave.exportWav')}`, dataset: { help: 'wave.exportWav' }, on: { click: async () => {
            hooks.showToast(t('toast.wavStart'));
            try {
              const res = await exportWaveWav();
              hooks.showToast(res.ok ? t('toast.wavDone', res.filename) : res.message, res.ok ? 'info' : 'error');
            } catch (err) {
              console.error(err);
              hooks.showToast(String(err.message || err), 'error');
            }
          } } }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol() {
    const hud = {
      time: el('span', { class: 'text-sky-300', text: '—' }),
      note: el('span', { class: 'text-emerald-300', text: '—' }),
      hz: el('span', { class: 'text-amber-300', text: '—' }),
      val: el('span', { class: 'text-violet-300', text: '—' }),
    };
    const main = el('canvas', { class: 'w-full h-[460px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'wave.canvas' } });
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      segment(WAVE_COLORS.map((c) => [c, t(`wave.color.${c}`), 'wave.color']), () => P().view.color, (c) => setView((vw) => { vw.color = c; })),
      toggle('wave.showRidges', 'wave.showRidges', () => P().view.showRidges, () => setView((vw) => { vw.showRidges = !vw.showRidges; })),
      toggle('wave.showGrid', 'wave.showGrid', () => P().view.showGrid, () => setView((vw) => { vw.showGrid = !vw.showGrid; })),
      ...createLocateButtons({ unavailable: 'locate.na.wave' }), // pulses / drivers are dragged directly / 펄스·구동원은 직접 드래그
      // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
      createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f, null, WAVE_VIEW_LIMITS)), onTime: (f) => setView((vw) => zoomViewTime(vw, f, null, WAVE_VIEW_LIMITS)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f, null, WAVE_VIEW_LIMITS); zoomViewPitch(vw, f, null, WAVE_VIEW_LIMITS); }), onFit: () => fitWave() }),
    ]);
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400', dataset: { help: 'wave.hud' } }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]), el('span', {}, ['u ', hud.val]),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('wave.canvasHint') }),
    ]);
    canvases = createWaveCanvases({ main, hud }, { requestRender: hooks.requestRender, showToast: hooks.showToast });
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [toolbar, hudRow, main]),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-3 items-start' }, [hosts.init, hosts.driver]),
    ]);
  }

  function fitWave() {
    setView((vw, d) => { Object.assign(vw, fitWaveView(d)); });
  }

  // ------------------------------------------------------------------ equation + grid + medium
  function noteInput(k, lo, hi) {
    const inp = el('input', { type: 'text', class: 'w-full min-w-[3.5rem] px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 text-center font-mono text-[11px] text-sky-200' });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    inp.addEventListener('change', () => {
      const raw = inp.value.trim();
      const m = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : noteNameToMidi(raw);
      if (m === null || !Number.isFinite(m)) { hooks.showToast(t('pitch.invalidNote', inp.value), 'error'); return; }
      editWave((d) => { d[k] = clamp(m, lo, hi); });
      commit();
    });
    sink.push(() => { if (document.activeElement !== inp) inp.value = midiToNoteName(P()[k]); });
    return inp;
  }

  function buildEquationRack(p) {
    const gs = p.eq === 'gs';
    const sub = (grp, k, label, min, max, step, unit, accent) =>
      slider(`wave.${grp}.${k}`, `wave.${grp}.${k}`, () => num(P()[grp][k]), (val, ck) => editWave((d) => { d[grp][k] = val; }, { coalesceKey: ck }), { min, max, step, unit, accent });
    const physics = p.eq === 'schrod' ? [
      el('h3', { class: `${H3} text-fuchsia-300 pt-1`, text: t('wave.qmTitle') }),
      labelled('wave.qm.V', select('wave.qm.V', WAVE_POTENTIALS.map((v) => [v, t(`wave.qm.V.${v}`)]), () => P().qm.V, (val) => editWave((d) => { d.qm.V = val; })), 'wave.qm.V'),
      sub('qm', 'D', '', 0.05, 400, 0.05, 'st²/s', 'accent-fuchsia'),
      sub('qm', 'vmax', '', 0.5, 20, 0.5, 'st/s', 'accent-fuchsia'),
      p.qm.V === 'harmonic' ? sub('qm', 'omega', '', 0.05, 20, 0.05, 'rad/s', 'accent-fuchsia') : null,
      p.qm.V === 'harmonic' ? el('div', { class: 'text-[10px] font-mono text-slate-400', dataset: { help: 'wave.qm.omega' }, text: t('wave.qm.ell', harmonicLength(p.qm).toFixed(2)) }) : null,
      p.qm.V === 'barrier' || p.qm.V === 'curve' ? sub('qm', 'V0', '', 0, 60, 0.05, '1/s', 'accent-fuchsia') : null,
      p.qm.V === 'barrier' ? sub('qm', 'vx', '', 0, 1, 0.005, '', 'accent-fuchsia') : null,
      p.qm.V === 'barrier' ? sub('qm', 'vw', '', 0.005, 0.6, 0.005, '', 'accent-fuchsia') : null,
    ] : p.eq === 'diffusion' ? [
      el('h3', { class: `${H3} text-cyan-300 pt-1`, text: t('wave.difTitle') }),
      sub('dif', 'nu', '', 0.05, 400, 0.05, 'st²/s', 'accent-cyan'),
      sub('dif', 'wallHz', '', 0.05, 20, 0.05, 'Hz', 'accent-cyan'),
      sub('dif', 'wallAmp', '', 0, 1, 0.01, '', 'accent-cyan'),
      sub('dif', 'force', '', -0.5, 0.5, 0.001, '1/s', 'accent-cyan'),
    ] : gs ? [
      el('h3', { class: `${H3} text-rose-300 pt-1`, text: t('wave.gsTitle') }),
      ...[['Du', 'wave.gs.diff', 0.002, 0.2, 0.001], ['Dv', 'wave.gs.diff', 0.002, 0.2, 0.001], ['F', 'wave.gs.F', 0.005, 0.08, 0.0005], ['k', 'wave.gs.k', 0.03, 0.075, 0.0005]].map(([k, help, min, max, step]) =>
        slider(`wave.gs.${k}`, help, () => num(P().gs[k]), (val, ck) => editWave((d) => { d.gs[k] = val; }, { coalesceKey: ck }), { min, max, step, accent: 'accent-rose' })),
    ] : [
      el('div', { class: 'flex items-center justify-between gap-2 pt-1' }, [
        el('h3', { class: `${H3} text-amber-300`, text: t('wave.mediumTitle') }),
        el('button', { class: BTN, text: t('wave.cReset'), dataset: { help: 'wave.cRange' }, on: { click: () => { editWave((d) => { d.c.customPoints = [{ x: 0, y: 0.5, handles: [] }, { x: 1, y: 0.5, handles: [] }]; d.cLo = 0.5; d.cHi = 1.5; }); commit(); } } }),
      ]),
      slider('wave.speed', 'wave.speed', docNum('speed'), setDocNum('speed'), { min: 0.5, max: 60, step: 0.5, unit: 'st/s', accent: 'accent-amber' }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('wave.cLo', 'wave.cRange', docNum('cLo'), setDocNum('cLo'), { min: 0.1, max: 4, step: 0.05, unit: '×', accent: 'accent-amber' }),
        slider('wave.cHi', 'wave.cRange', docNum('cHi'), setDocNum('cHi'), { min: 0.1, max: 4, step: 0.05, unit: '×', accent: 'accent-amber' }),
      ]),
      slider('wave.cflParam', 'wave.cflParam', docNum('cfl'), setDocNum('cfl'), { min: 0.05, max: 2, step: 0.05 }),
      slider('wave.damping', 'wave.damping', docNum('damping'), setDocNum('damping'), { min: 0, max: 3, step: 0.01, unit: '1/s' }),
      p.eq === 'wave' ? slider('wave.dispersion', 'wave.dispersion', docNum('dispersion'), setDocNum('dispersion'), { min: 0, max: 4, step: 0.05, unit: 'st²' }) : null,
      p.eq === 'kg' || p.eq === 'sg' ? slider('wave.mass', 'wave.mass', docNum('mass'), setDocNum('mass'), { min: 0, max: 20, step: 0.1, unit: '1/s' }) : null,
    ];
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-sky-300`, text: t('wave.eqTitle') }),
      segment(WAVE_EQS.map((id) => [id, t(`wave.eq.${id}`), `wave.eq.${id}`]), () => P().eq, (id) => editWave((d) => { d.eq = id; }), 'violet'),
      labelled('wave.boundary', select('wave.boundary', WAVE_BOUNDARIES.map((b) => [b, t(`wave.boundary.${b}`)]), () => P().boundary, (val) => editWave((d) => { d.boundary = val; })), 'wave.boundary'),
      el('div', { class: 'grid grid-cols-3 gap-2' }, [
        stacked('wave.nx', select('wave.nx', WAVE_NX.map((n) => [String(n), String(n)]), () => P().Nx, (val) => editWave((d) => { d.Nx = Number(val); })), 'wave.nx'),
        stacked('wave.pLo', noteInput('pLo', 0, 116), 'wave.pitchRange'),
        stacked('wave.pHi', noteInput('pHi', 4, 124), 'wave.pitchRange'),
      ]),
      slider('wave.length', 'wave.length', docNum('length'), (val, ck) => editWave((d) => { d.length = val; Object.assign(d.view, fitWaveView(d)); }, { coalesceKey: ck }), { min: 1, max: 120, step: 0.5, unit: 's' }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('wave.bakeRate', 'wave.bakeRate', docNum('bakeRate'), setDocNum('bakeRate'), { min: 10, max: 200, step: 5, unit: 'Hz' }),
        slider('wave.simSpeed', 'wave.simSpeed', docNum('simSpeed'), setDocNum('simSpeed'), { min: 0.05, max: 8, step: 0.05, unit: '×' }),
      ]),
      ...physics,
    ]);
  }

  // ------------------------------------------------------------------ initial conditions
  function buildInitRack() {
    const p = P();
    const getI = (idx) => P().init[idx];
    const setI = (idx, k) => (val, ck) => editWave((d) => { if (d.init[idx]) d.init[idx][k] = val; }, { coalesceKey: ck });
    let addKind = p.eq === 'sg' ? 'kink' : 'gauss';
    const kindSel = el('select', { class: STUDIO_SELECT, dataset: { help: 'wave.init' }, on: { change: (e) => { addKind = e.target.value; } } },
      WAVE_INIT_KINDS.map((k) => el('option', { value: k, text: t(`wave.kind.${k}`), selected: k === addKind })));
    const cards = p.init.map((it, idx) => {
      const sl = (k, help, min, max, step, unit = '') => slider(`wave.init.${k}`, help, () => num(getI(idx)?.[k]), setI(idx, k), { min, max, step, unit, accent: 'accent-emerald', id: `init.${k}.${idx}`, compact: true });
      const body = [];
      if (it.kind === 'standing') body.push(sl('mode', 'wave.init.mode', 1, 32, 1), sl('amp', 'wave.init.amp', -1, 1, 0.01));
      else if (it.kind === 'noise') body.push(sl('width', 'wave.init.width', 0.25, 24, 0.25, 'st'), sl('amp', 'wave.init.amp', -1, 1, 0.01));
      else {
        body.push(sl('x', 'wave.init.x', 0, 1, 0.005));
        if (!(it.kind === 'kink' && p.eq === 'sg')) body.push(sl('width', 'wave.init.width', 0.25, 24, 0.25, 'st'));
        body.push(sl('amp', 'wave.init.amp', -1, 1, 0.01));
        if (p.eq !== 'gs' && p.eq !== 'diffusion') body.push(sl('velocity', 'wave.init.velocity', -1, 1, 0.05));
      }
      return el('div', { class: 'flex flex-col gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1.5', dataset: { help: 'wave.init' } }, [
        el('div', { class: 'flex items-center justify-between gap-2 text-[11px]' }, [
          el('span', { class: 'font-mono font-bold text-emerald-300', text: `${idx + 1}` }),
          select('wave.init', WAVE_INIT_KINDS.map((k) => [k, t(`wave.kind.${k}`)]), () => getI(idx)?.kind || 'gauss', (val) => editWave((d) => { if (d.init[idx]) d.init[idx].kind = val; })),
          el('button', { class: 'ml-auto text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', dataset: { help: 'wave.init' }, on: { click: () => { editWave((d) => { d.init.splice(idx, 1); }); commit(); } } }),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, body),
      ]);
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('h3', { class: `${H3} text-emerald-300 mr-auto`, text: t('wave.initTitle'), dataset: { help: 'wave.init' } }),
        kindSel,
        el('button', { class: BTN, text: `+ ${t('wave.init.add')}`, dataset: { help: 'wave.init' }, on: { click: () => {
          if (P().init.length >= WAVE_MAX_INIT) { hooks.showToast(t('wave.maxInit', WAVE_MAX_INIT), 'error'); return; }
          editWave((d) => { d.init.push(createWaveInit(addKind, { x: Number((0.25 + 0.5 * Math.random()).toFixed(3)), velocity: addKind === 'kink' ? 0.4 : 0 })); });
          commit();
        } } }),
      ]),
      cards.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('wave.initEmpty') }),
      ...cards,
    ]);
  }

  // ------------------------------------------------------------------ drivers
  function buildDriverRack() {
    const p = P();
    const getD = (idx) => P().drivers[idx];
    const setD = (idx, k) => (val, ck) => editWave((d) => { if (d.drivers[idx]) d.drivers[idx][k] = val; }, { coalesceKey: ck });
    const cards = p.drivers.map((_, idx) => {
      const sl = (k, help, min, max, step, unit = '') => slider(`wave.driver.${k}`, help, () => num(getD(idx)?.[k]), setD(idx, k), { min, max, step, unit, accent: 'accent-amber', id: `driver.${k}.${idx}`, compact: true });
      return el('div', { class: 'flex flex-col gap-1 bg-slate-950 border border-slate-800 rounded-lg p-1.5', dataset: { help: 'wave.drivers' } }, [
        el('div', { class: 'flex items-center justify-between gap-2 text-[11px]' }, [
          el('span', { class: 'font-mono font-bold text-amber-300', text: t('wave.driver.n', idx + 1) }),
          el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', dataset: { help: 'wave.drivers' }, on: { click: () => { editWave((d) => { d.drivers.splice(idx, 1); }); commit(); } } }),
        ]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
          sl('x', 'wave.drivers', 0, 1, 0.005),
          sl('hz', 'wave.driver.hz', 0.05, 12, 0.05, 'Hz'),
          sl('amp', 'wave.drivers', -1, 1, 0.01),
          sl('t0', 'wave.driver.time', 0, 120, 0.1, 's'),
          sl('dur', 'wave.driver.time', 0, 120, 0.1, 's'),
        ]),
      ]);
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('h3', { class: `${H3} text-amber-300 mr-auto`, text: t('wave.driversTitle'), dataset: { help: 'wave.drivers' } }),
        el('button', { class: BTN, text: `+ ${t('wave.driver.add')}`, dataset: { help: 'wave.drivers' }, on: { click: () => {
          if (P().drivers.length >= WAVE_MAX_DRIVERS) { hooks.showToast(t('wave.maxDrivers', WAVE_MAX_DRIVERS), 'error'); return; }
          editWave((d) => { d.drivers.push(createWaveDriver({ x: Number((0.3 + 0.4 * Math.random()).toFixed(3)), dur: Math.min(4, d.length) })); });
          commit();
        } } }),
      ]),
      cards.length ? null : el('span', { class: 'text-[11px] text-slate-500', text: t('wave.driversEmpty') }),
      ...cards,
    ]);
  }

  // ------------------------------------------------------------------ sonification
  function buildSonifyRack() {
    const note = el('span', { class: 'text-[11px] text-slate-400' });
    sink.push(() => { note.textContent = t(`wave.modeNote.${P().sonify.mode}`); });
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => P().timbre, edit: (fn, k) => editWave((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'wave-timbre' });
    sink.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'wave.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-violet-300`, text: t('wave.sonifyTitle') }),
      segment([['spectral', t('wave.mode.spectral'), 'wave.mode.spectral'], ['ridge', t('wave.mode.ridge'), 'wave.mode.ridge']], () => P().sonify.mode, (mode) => editWave((d) => { d.sonify.mode = mode; }), 'violet'),
      note,
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('wave.source', select('wave.source', WAVE_SOURCES.map((s) => [s, t(`wave.source.${s}`)]), () => P().sonify.source, (val) => editWave((d) => { d.sonify.source = val; })), 'wave.source'),
        labelled('wave.engineSel', select('wave.engineSel', WAVE_ENGINES.map((s) => [s, t(`wave.engine.${s}`)]), () => P().sonify.engine, (val) => editWave((d) => { d.sonify.engine = val; })), 'wave.engineSel'),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('wave.gain', 'wave.gain', sonNum('gain'), setSonNum('gain'), { min: 0, max: 4, step: 0.05, accent: 'accent-violet' }),
        slider('wave.ampPower', 'wave.ampPower', sonNum('ampPower'), setSonNum('ampPower'), { min: 0.25, max: 4, step: 0.05, accent: 'accent-violet' }),
        slider('wave.floor', 'wave.floor', sonNum('floor'), setSonNum('floor'), { min: 0, max: 0.2, step: 0.001, accent: 'accent-violet' }),
        slider('wave.stereo', 'wave.stereo', sonNum('stereo'), setSonNum('stereo'), { min: 0, max: 1, step: 0.05, accent: 'accent-violet' }),
      ]),
      el('h3', { class: `${H3} text-slate-300 pt-1`, text: t('wave.ridgeTitle') }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('wave.peakThresh', 'wave.peakThresh', sonNum('peakThresh'), setSonNum('peakThresh'), { min: 0.01, max: 0.95, step: 0.01 }),
        slider('wave.maxTracks', 'wave.maxTracks', sonNum('maxTracks'), (val, ck) => editWave((d) => { d.sonify.maxTracks = Math.round(val); }, { coalesceKey: ck }), { min: 1, max: WAVE_MAX_TRACKS, step: 1 }),
        slider('wave.maxJump', 'wave.maxJump', sonNum('maxJump'), setSonNum('maxJump'), { min: 0.1, max: 12, step: 0.1, unit: 'st' }),
        slider('wave.maxGap', 'wave.maxGap', sonNum('maxGap'), setSonNum('maxGap'), { min: 0, max: 2, step: 0.05, unit: 's' }),
      ]),
      el('h3', { class: `${H3} text-slate-300 pt-1`, text: t('wave.timbreTitle'), dataset: { help: 'wave.timbre' } }),
      timbre,
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function buildStatic() {
    staticSync = [];
    sink = staticSync;
    canvases?.destroy();
    hosts = { init: el('div', { class: 'min-w-0' }), driver: el('div', { class: 'min-w-0' }), eq: el('div', { class: 'min-w-0' }) };
    root.replaceChildren(
      buildStrip(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [hosts.eq, buildSonifyRack(), ((r) => { sink.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getWaveParams, edit: editWave })), ((r) => { sink.push(r.sync); return r.root; })(createLineMixRack({ studio: 'wave', get: getWaveParams, edit: editWave }))]),
      ]),
    );
  }

  function buildRacks() {
    rackSync = [];
    sink = rackSync;
    hosts.init.replaceChildren(buildInitRack());
    hosts.driver.replaceChildren(buildDriverRack());
    hosts.eq.replaceChildren(buildEquationRack(P()));
  }

  const structureKey = () => {
    const p = P();
    return [p.eq, p.qm?.V, p.init.map((it) => it.kind).join(','), p.drivers.length].join('|');
  };

  return {
    render() {
      const lang = getLang();
      const k = structureKey();
      if (lang !== langKey || !hosts) { langKey = lang; rackKey = ''; buildStatic(); }
      if (k !== rackKey) { rackKey = k; buildRacks(); }
      for (const fn of staticSync) fn();
      for (const fn of rackSync) fn();
      canvases?.render();
    },
    fit: fitWave,
    destroy() {
      canvases?.destroy();
      canvases = null;
      hosts = null;
      root.replaceChildren();
      langKey = '';
      rackKey = '';
    },
  };
}
