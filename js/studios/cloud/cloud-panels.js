/**
 * Flexatone — studios/cloud/cloud-panels.js
 * Cloud Studio UI tier: workspace DOM (header + actions, scatter + histogram, curve strip,
 * parameter racks). Mounted by ui/studio-host.js when the Cloud tab is active.
 * 클라우드 스튜디오 작업 공간 DOM (헤더·액션, 산점도·히스토그램, 곡선 스트립, 파라미터 랙).
 *
 * Every control carries data-help="cloud.…" (Option/Alt inspector); number inputs are picked up
 * by ui/number-scrub.js. One slider drag = one undo step (coalesceKey + endHistoryGesture).
 * Events are (re)generated here — at edit time, only when the signature changes — and the live
 * scheduler is handed the new cached list; nothing is generated while audio merely plays.
 * 이벤트는 편집 시점(시그니처 변경 시)에만 여기서 생성되고, 재생 중에는 캐시만 전달.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { PARAM_SCHEMAS, getEngineLabel, captureCurveToCustomPoints } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import {
  CLOUD_DISTS, DUR_DISTS, ENVELOPES, GLIDE_MODES, PITCH_COMPS, SIEVE_OPS, SIEVE_GRIDS, CURVE_ENGINES, CURVE_KEYS, CURVE_RANGES,
  MAX_EVENTS_LIMIT, MAX_POLY_LIMIT, MAX_LENGTH_SEC, getCurve, getBakeCount,
} from './cloud-engine.js';
import { CLOUD_ID, CLOUD_PRESETS, getCloudParams, editCloud, getCloudEvents, applyCloudPreset, getLastVoiceReport } from '../cloud-studio.js';
import { CLOUD_HELP } from './cloud-i18n.js';
import { createCloudCanvases } from './cloud-canvases.js';
import { exportCloudJson, exportCloudWav, syncCloudLive, isCloudPlaying, getCloudAudioStats, getCloudRenderState, onCloudRenderProgress } from './cloud-audio.js';

// Help entries (en / ko) for the Option-inspector. / 도움말 등록
for (const [key, entry] of Object.entries(CLOUD_HELP)) HELP_DB[key] = entry;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BADGE = 'px-2 py-0.5 rounded-full text-[11px] font-mono border';
const H3 = (key, color, help) => el('h3', { class: `text-xs font-bold uppercase tracking-wider ${color}`, text: t(key), dataset: help ? { help } : undefined });

/**
 * Mount the Cloud workspace into `root`. / 클라우드 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountCloudWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let lastReport = null;
  const commit = () => endHistoryGesture();
  const offProgress = onCloudRenderProgress(() => hooks.requestRender(['studio']));

  // ------------------------------------------------------------------ control helpers
  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help) => `cloud:${label}:${help}` });
  const seg = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  /** Getter / setter on a dotted path of the document. / 점 경로 접근자 */
  const path = (p) => {
    const parts = p.split('.');
    const read = (d) => parts.reduce((o, k) => o?.[k], d);
    return {
      get: () => num(read(getCloudParams())),
      set: (val, ck) => editCloud((d) => { const o = parts.slice(0, -1).reduce((x, k) => x[k], d); o[parts[parts.length - 1]] = val; }, { coalesceKey: ck }),
      getRaw: () => read(getCloudParams()),
      setRaw: (val) => editCloud((d) => { const o = parts.slice(0, -1).reduce((x, k) => x[k], d); o[parts[parts.length - 1]] = val; }),
    };
  };
  const sl = (labelKey, help, p, opts) => { const a = path(p); return slider(labelKey, help, a.get, a.set, opts); };
  const intSl = (labelKey, help, p, opts) => { const a = path(p); return slider(labelKey, help, a.get, (v, ck) => a.set(Math.round(v), ck), opts); };
  const setView = (fn) => editCloud((d) => fn(d.view), { history: false });

  // ------------------------------------------------------------------ header
  function buildHeader() {
    const evBadge = el('span', { class: `${BADGE} bg-sky-500/10 text-sky-200 border-sky-500/30`, dataset: { help: 'cloud.badges' } });
    const bakeBadge = el('span', { class: `${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`, dataset: { help: 'cloud.badges' } });
    const audioBadge = el('span', { class: `${BADGE} bg-slate-800 text-slate-300 border-slate-700`, dataset: { help: 'cloud.sched' } });
    const laneBadge = el('span', { class: `${BADGE} bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-500/30 hidden`, dataset: { help: 'cloud.bakeGliss' } });
    const statLine = el('span', { class: 'text-[11px] text-slate-400 font-mono', dataset: { help: 'cloud.badges' } });
    syncers.push(() => {
      const p = getCloudParams();
      const ev = getCloudEvents(p);
      evBadge.textContent = t('cloud.badge.events', ev.n, roundTo(ev.n / p.length, 1), ev.stats.maxOverlap);
      bakeBadge.textContent = t('cloud.badge.bake', getBakeCount());
      const s = getCloudAudioStats();
      const r = getCloudRenderState();
      audioBadge.textContent = r.active ? t('cloud.badge.render', Math.round(r.frac * 100)) : t('cloud.badge.audio', s.scheduled, s.skipped, s.pool, s.tickAvgMs.toFixed(2), s.tickMaxMs.toFixed(2));
      if (lastReport) { laneBadge.classList.remove('hidden'); laneBadge.textContent = t('cloud.badge.lanes', lastReport.lanes, lastReport.voices, lastReport.dropped); }
      statLine.textContent = `${t('cloud.stats', ev.stats.generated, ev.stats.droppedPoly, ev.stats.droppedSieve)}${ev.stats.truncated ? ` · ${t('cloud.truncated')}` : ''}`;
    });

    const seedInput = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'cloud.seed' } });
    seedInput.addEventListener('change', () => { editCloud((d) => { d.seed = clamp(Math.round(num(seedInput.value, d.seed)), 0, 999999); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seedInput) seedInput.value = String(getCloudParams().seed); });
    const reseed = () => {
      // The UI picks a new seed; generation itself stays fully seeded. / UI가 새 시드 선택 (생성은 시드 결정적)
      const s = Math.floor(Math.random() * 1e6);
      editCloud((d) => { d.seed = s; });
      commit();
      hooks.showToast(t('cloud.reseeded', s));
    };
    const presetSel = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]', dataset: { help: 'cloud.preset' }, on: { change: (e) => {
      const id = e.target.value;
      if (!id) return;
      applyCloudPreset(id);
      commit();
      e.target.value = '';
      fitCloud();
      hooks.showToast(t('cloud.presetApplied', t(`cloud.preset.${id}`)));
    } } }, [el('option', { value: '', text: t('cloud.preset.choose') }), ...CLOUD_PRESETS.map((p) => el('option', { value: p.id, text: t(`cloud.preset.${p.id}`) }))]);
    const bake = (mode) => {
      const res = StudioRegistry.bakeVoices(CLOUD_ID, { mode });
      const rep = getLastVoiceReport();
      if (!res.result?.length || !rep) { hooks.showToast(t('cloud.bakeEmpty'), 'error'); return; }
      lastReport = rep;
      hooks.showToast(t('cloud.bakedToGliss', rep.voices, rep.lanes, rep.kept, rep.dropped));
    };
    const wav = async () => {
      hooks.showToast(t('toast.wavStart'));
      try {
        const res = await exportCloudWav();
        hooks.showToast(res.ok ? t('cloud.wavDone', res.filename, (20 * Math.log10(Math.max(1e-9, res.peak))).toFixed(1)) : res.message, res.ok ? 'info' : 'error');
      } catch (err) {
        console.error(err);
        hooks.showToast(String(err.message || err), 'error');
      }
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('cloud.title'), dataset: { help: 'cloud.overview' } }),
          evBadge, bakeBadge, audioBadge, laneBadge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[11px] text-slate-400', text: t('cloud.seed') }), seedInput,
          el('button', { class: BTN, text: `🎲 ${t('cloud.reseed')}`, dataset: { help: 'cloud.seed' }, on: { click: reseed } }),
          presetSel,
          createTrajectoryImportButton('cloud'), // Glissando trajectory → this studio's base line / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('cloud.bakeGliss')}`, dataset: { help: 'cloud.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('cloud.bakeAppend'), dataset: { help: 'cloud.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('cloud.exportJson')}`, dataset: { help: 'cloud.exportJson' }, on: { click: () => { exportCloudJson(); hooks.showToast(t('cloud.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('cloud.exportWav')}`, dataset: { help: 'cloud.exportWav' }, on: { click: wav } }),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [statLine, el('span', { class: 'text-[11px] text-slate-500', text: t('cloud.subtitle') })]),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol(params) {
    const hud = {
      time: el('span', { class: 'text-sky-300', text: '—' }),
      note: el('span', { class: 'text-emerald-300', text: '—' }),
      hz: el('span', { class: 'text-amber-300', text: '—' }),
      active: el('span', { class: 'text-rose-300', text: '0' }),
      hist: el('span', { class: 'text-slate-400' }),
      curveVal: el('span', { class: 'text-slate-200' }),
    };
    const main = el('canvas', { class: 'w-full h-[420px] rounded-lg bg-slate-950 block min-w-0', dataset: { help: 'cloud.canvas' } });
    const hist = el('canvas', { class: 'w-[110px] shrink-0 h-[420px] rounded-lg bg-slate-950 block', dataset: { help: 'cloud.hist' } });
    const strip = el('canvas', { class: 'w-full h-[130px] rounded-lg bg-slate-950 block', dataset: { help: 'cloud.strip' } });
    const zoom = (fn) => () => setView(fn);
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'cloud.zoom' } }, [
      // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [...createLocateButtons({ unavailable: 'locate.na.generated' }), createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f)), onTime: (f) => setView((vw) => zoomViewTime(vw, f)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f); zoomViewPitch(vw, f); }), onFit: () => fitCloud() })]), // Locate has nothing to move here: off, with the reason / 이동 도구: 꺼진 채 이유 표시
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('cloud.canvasHint') }),
    ]);
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]),
      el('span', { dataset: { help: 'cloud.canvas' } }, [`${t('cloud.hud.active')} `, hud.active]),
      el('span', { class: 'ml-auto', dataset: { help: 'cloud.hist' } }, [hud.hist]),
    ]);
    canvases = createCloudCanvases({ main, hist, strip, hud }, { requestRender: hooks.requestRender });
    return el('div', { class: 'lg:col-span-8 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [toolbar, hudRow, el('div', { class: 'flex gap-2 min-w-0' }, [el('div', { class: 'flex-1 min-w-0' }, [main]), hist])]),
      buildCurveSection(params, strip, hud),
    ]);
  }

  // ------------------------------------------------------------------ curve section
  function buildCurveSection(params, strip, hud) {
    const tab = params.view.curveTab;
    const curve = getCurve(params, tab);
    const r = CURVE_RANGES[tab];
    const getC = () => getCurve(getCloudParams(), tab);
    const editC = (fn, ck = null) => editCloud((d) => fn(getCurve(d, tab), d), { coalesceKey: ck });
    const tabs = seg('cloud.strip', CURVE_KEYS.map((k) => [k, `cloud.curve.${k}`]), () => getCloudParams().view.curveTab, (k) => setView((vw) => { vw.curveTab = k; }), 'sky');
    const engineSel = select('cloud.curveEngine', CURVE_ENGINES.map((id) => [id, id === 'custom' ? t('cloud.curve.customLinear') : getEngineLabel(id)]), () => getC().engine, (val) => editC((c) => { c.engine = val; }));
    const parts = [];
    for (const s of PARAM_SCHEMAS[curve.engine] || []) {
      if (s.type === 'range') {
        parts.push(slider(s.labelKey, `engine.${curve.engine}`, () => num(getC()[s.key], s.default), (val, ck) => editC((c) => { c[s.key] = s.integer ? Math.round(val) : val; }, ck), { min: s.softMin, max: s.softMax, step: s.step, accent: 'accent-sky' }));
      } else if (s.type === 'toggle') {
        parts.push(toggle(s.labelKey, `engine.${curve.engine}`, () => !!(getC()[s.key] ?? s.default), () => { editC((c) => { c[s.key] = !(c[s.key] ?? s.default); }); commit(); }));
      } else if (s.type === 'select') {
        parts.push(labelled(s.labelKey, select(`engine.${curve.engine}`, s.options.map((o) => [o.value, t(o.labelKey)]), () => getC()[s.key] ?? s.default, (val) => editC((c) => { c[s.key] = val; })), `engine.${curve.engine}`));
      }
    }
    const toCustom = () => {
      editC((c) => {
        const pts = captureCurveToCustomPoints(c, { tolerance: 0.003, maxAnchors: 24, includeTransforms: true });
        Object.assign(c, { engine: 'custom', customPoints: pts, reverse: false, inverse: false });
      });
      commit();
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        H3('cloud.curvesTitle', 'text-sky-300', 'cloud.strip'),
        tabs,
        el('span', { class: 'text-[11px] font-mono text-slate-400', dataset: { help: 'cloud.strip' } }, [`${t('cloud.curve.now')} `, hud.curveVal]),
      ]),
      strip,
      el('span', { class: 'text-[11px] text-slate-500', text: curve.engine === 'custom' ? t('cloud.stripHint') : t('cloud.stripHintEngine') }),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5' }, [
        labelled('cloud.curve.engine', engineSel, 'cloud.curveEngine'),
        el('div', { class: 'flex flex-wrap gap-1 justify-end' }, [
          toggle('cloud.curve.reverse', 'cloud.curveEngine', () => !!getC().reverse, () => { editC((c) => { c.reverse = !c.reverse; }); commit(); }),
          toggle('cloud.curve.inverse', 'cloud.curveEngine', () => !!getC().inverse, () => { editC((c) => { c.inverse = !c.inverse; }); commit(); }),
          curve.engine !== 'custom' ? el('button', { class: BTN, text: t('cloud.curve.toCustom'), dataset: { help: 'cloud.curveEngine' }, on: { click: toCustom } }) : null,
          el('button', { class: BTN, text: t('cloud.curve.flat'), dataset: { help: 'cloud.curveRange' }, on: { click: () => { editC((c) => { c.hi = c.lo; }); commit(); } } }),
        ]),
        slider('cloud.curve.lo', `cloud.curve.${tab}`, () => num(getC().lo), (v, ck) => editC((c) => { c.lo = v; }, ck), { min: r.min, max: r.max, step: r.step, unit: r.unit }),
        slider('cloud.curve.hi', `cloud.curve.${tab}`, () => num(getC().hi), (v, ck) => editC((c) => { c.hi = v; }, ck), { min: r.min, max: r.max, step: r.step, unit: r.unit }),
        ...parts,
      ]),
    ]);
  }

  function fitCloud() {
    const p = getCloudParams();
    const ev = getCloudEvents(p);
    let lo = 127;
    let hi = 0;
    for (let i = 0; i < ev.n; i++) { lo = Math.min(lo, ev.p0[i], ev.p1[i]); hi = Math.max(hi, ev.p0[i], ev.p1[i]); }
    if (!ev.n) { lo = p.pitch.min; hi = p.pitch.max; }
    setView((vw) => { Object.assign(vw, { tMin: 0, tMax: p.length, midiMin: Math.max(0, Math.floor(lo - 4)), midiMax: Math.min(127, Math.ceil(hi + 4)) }); });
  }

  // ------------------------------------------------------------------ racks
  function buildTimeRack() {
    return el('section', { class: SECTION }, [
      H3('cloud.timeTitle', 'text-sky-300', 'cloud.length'),
      sl('cloud.length', 'cloud.length', 'length', { min: 1, max: MAX_LENGTH_SEC, step: 0.5, unit: 's' }),
    ]);
  }

  function buildPitchRack(params) {
    const dist = params.pitch.dist;
    return el('section', { class: SECTION }, [
      H3('cloud.pitchTitle', 'text-violet-300', 'cloud.dist'),
      labelled('cloud.dist', select('cloud.dist', CLOUD_DISTS.map((d) => [d, t(`cloud.dist.${d}`)]), () => getCloudParams().pitch.dist, (val) => editCloud((d) => { d.pitch.dist = val; })), 'cloud.dist'),
      dist === 'levy' ? sl('cloud.levyAlpha', 'cloud.levyAlpha', 'pitch.levyAlpha', { min: 1, max: 2, step: 0.01, accent: 'accent-violet' }) : null,
      dist === 'brownian' ? sl('cloud.brownStep', 'cloud.brown', 'pitch.brownStep', { min: 0, max: 12, step: 0.05, unit: 'st', accent: 'accent-violet' }) : null,
      dist === 'brownian' ? sl('cloud.brownDrift', 'cloud.brown', 'pitch.brownDrift', { min: -2, max: 2, step: 0.01, unit: 'st', accent: 'accent-violet' }) : null,
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.pitchMin', 'cloud.pitchRange', 'pitch.min', { min: 12, max: 120, step: 1, unit: 'MIDI', accent: 'accent-violet' }),
        sl('cloud.pitchMax', 'cloud.pitchRange', 'pitch.max', { min: 12, max: 120, step: 1, unit: 'MIDI', accent: 'accent-violet' }),
      ]),
    ]);
  }

  function buildSieveRack(params) {
    const sv = params.pitch.sieve;
    const size = el('span', { class: 'text-[11px] font-mono text-amber-300', dataset: { help: 'cloud.sieve' } });
    syncers.push(() => {
      const p = getCloudParams();
      const ev = getCloudEvents(p);
      size.textContent = p.pitch.sieve.enabled ? (ev.stats.sieveSize ? t('cloud.sieve.size', ev.stats.sieveSize) : t('cloud.sieve.empty')) : '';
    });
    const terms = (sv.terms || []).map((term, idx) => {
      const editT = (fn) => { editCloud((d) => { const x = d.pitch.sieve.terms[idx]; if (x) fn(x); }); commit(); };
      const getT = () => getCloudParams().pitch.sieve.terms[idx] || { mod: 1, residues: [0], shift: 0 };
      const mod = el('input', { type: 'number', min: 1, max: 96, step: 1, class: 'w-12 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
      mod.addEventListener('change', () => editT((x) => { x.mod = clamp(Math.round(num(mod.value, x.mod)), 1, 96); }));
      const shift = el('input', { type: 'number', min: -48, max: 48, step: 1, class: 'w-12 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
      shift.addEventListener('change', () => editT((x) => { x.shift = clamp(Math.round(num(shift.value, x.shift || 0)), -48, 48); }));
      const res = el('input', { type: 'text', class: 'flex-1 min-w-0 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-[11px]' });
      res.addEventListener('keydown', (e) => e.stopPropagation());
      res.addEventListener('change', () => editT((x) => { x.residues = [...new Set(res.value.split(/[^0-9-]+/).filter(Boolean).map((s) => Math.round(Number(s))).filter(Number.isFinite))]; }));
      syncers.push(() => {
        const x = getT();
        if (document.activeElement !== mod) mod.value = String(x.mod);
        if (document.activeElement !== shift) shift.value = String(x.shift || 0);
        if (document.activeElement !== res) res.value = (x.residues || []).join(', ');
      });
      return el('div', { class: 'flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-1.5 text-[11px] text-slate-300', dataset: { help: 'cloud.sieveTerm' } }, [
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.mod') }), mod,
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.residues') }), res,
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.shift') }), shift,
        el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', on: { click: () => { editCloud((d) => { d.pitch.sieve.terms.splice(idx, 1); }); commit(); } } }),
      ]);
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        H3('cloud.sieveTitle', 'text-amber-300', 'cloud.sieve'),
        toggle('cloud.sieve.enabled', 'cloud.sieve', () => getCloudParams().pitch.sieve.enabled, () => { editCloud((d) => { d.pitch.sieve.enabled = !d.pitch.sieve.enabled; }); commit(); }),
        toggle('cloud.sieve.snap', 'cloud.sieveSnap', () => getCloudParams().pitch.snapSieve, () => { editCloud((d) => { d.pitch.snapSieve = !d.pitch.snapSieve; }); commit(); }),
        size,
      ]),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('cloud.sieve.op', select('cloud.sieve', SIEVE_OPS.map((o) => [o, t(`cloud.sieve.op.${o}`)]), () => getCloudParams().pitch.sieve.op, (val) => editCloud((d) => { d.pitch.sieve.op = val; })), 'cloud.sieve'),
        labelled('cloud.sieve.grid', select('cloud.sieve', Object.keys(SIEVE_GRIDS).map((g) => [g, t(`cloud.sieve.grid.${g}`)]), () => getCloudParams().pitch.sieve.grid, (val) => editCloud((d) => { d.pitch.sieve.grid = val; })), 'cloud.sieve'),
      ]),
      ...terms,
      el('button', { class: `${BTN} self-start`, text: `+ ${t('cloud.sieve.addTerm')}`, dataset: { help: 'cloud.sieveTerm' }, on: { click: () => { editCloud((d) => { d.pitch.sieve.terms.push({ mod: 12, residues: [0, 4, 7], shift: 0 }); }); commit(); } } }),
    ]);
  }

  function buildGlideRack(params) {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        H3('cloud.glideTitle', 'text-emerald-300', 'cloud.glide'),
        seg('cloud.glide', GLIDE_MODES.map((m) => [m, `cloud.glide.${m}`]), () => getCloudParams().glide.mode, (val) => editCloud((d) => { d.glide.mode = val; }), 'emerald'),
      ]),
      params.glide.mode === 'slope' ? sl('cloud.slopeMean', 'cloud.glide', 'glide.slopeMean', { min: 0, max: 48, step: 0.1, unit: 'st/s', accent: 'accent-emerald' }) : null,
      params.glide.mode === 'slope' ? sl('cloud.slopeSpread', 'cloud.glide', 'glide.slopeSpread', { min: 0, max: 48, step: 0.1, unit: 'st/s', accent: 'accent-emerald' }) : null,
      sl('cloud.upBias', 'cloud.upBias', 'glide.upBias', { min: 0, max: 1, step: 0.01, accent: 'accent-emerald' }),
    ]);
  }

  function buildDurRack(params) {
    return el('section', { class: SECTION }, [
      H3('cloud.durTitle', 'text-sky-300', 'cloud.duration'),
      labelled('cloud.durDist', select('cloud.duration', DUR_DISTS.map((d) => [d, t(`cloud.dur.${d}`)]), () => getCloudParams().duration.dist, (val) => editCloud((d) => { d.duration.dist = val; })), 'cloud.duration'),
      params.duration.dist !== 'uniform' ? sl('cloud.durMean', 'cloud.duration', 'duration.mean', { min: 0.02, max: 8, step: 0.01, unit: 's' }) : null,
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.durMin', 'cloud.duration', 'duration.min', { min: 0.03, max: 4, step: 0.01, unit: 's' }),
        sl('cloud.durMax', 'cloud.duration', 'duration.max', { min: 0.05, max: 12, step: 0.01, unit: 's' }),
      ]),
    ]);
  }

  function buildGainRack(params) {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        H3('cloud.gainTitle', 'text-rose-300', 'cloud.gain'),
        toggle('cloud.autoLevel', 'cloud.autoLevel', () => getCloudParams().gain.autoLevel, () => { editCloud((d) => { d.gain.autoLevel = !d.gain.autoLevel; }); commit(); }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.gainBase', 'cloud.gain', 'gain.base', { min: 0, max: 1, step: 0.01, accent: 'accent-rose' }),
        sl('cloud.gainSpread', 'cloud.gain', 'gain.spread', { min: 0, max: 1, step: 0.01, accent: 'accent-rose' }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('cloud.pitchComp', select('cloud.pitchComp', PITCH_COMPS.map((c) => [c, t(`cloud.pitchComp.${c}`)]), () => getCloudParams().gain.pitchComp, (val) => editCloud((d) => { d.gain.pitchComp = val; })), 'cloud.pitchComp'),
        labelled('cloud.envelope', select('cloud.envelope', ENVELOPES.map((e) => [e, t(`cloud.env.${e}`)]), () => getCloudParams().gain.envelope, (val) => editCloud((d) => { d.gain.envelope = val; })), 'cloud.envelope'),
      ]),
      params.gain.envelope !== 'hann' ? sl('cloud.attack', 'cloud.envelope', 'gain.attack', { min: 0.002, max: 0.5, step: 0.001, unit: 's', accent: 'accent-rose' }) : null,
    ]);
  }

  function buildTimbreRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getCloudParams().timbre, edit: (fn, k) => editCloud((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'cloud-timbre' });
    syncers.push(timbreEd.sync);
    const waves = el('div', { class: 'min-w-0', dataset: { help: 'cloud.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      H3('cloud.timbreTitle', 'text-emerald-300', 'cloud.timbre'),
      waves,
      sl('cloud.stereo', 'cloud.stereo', 'timbre.stereo', { min: 0, max: 1, step: 0.01, accent: 'accent-emerald' }),
    ]);
  }

  function buildAdvRack() {
    return el('section', { class: SECTION }, [
      H3('cloud.advTitle', 'text-slate-300', 'cloud.sched'),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        intSl('cloud.maxEvents', 'cloud.maxEvents', 'maxEvents', { min: 10, max: MAX_EVENTS_LIMIT, step: 10 }),
        intSl('cloud.maxPolyphony', 'cloud.maxPolyphony', 'maxPolyphony', { min: 1, max: MAX_POLY_LIMIT, step: 1 }),
        sl('cloud.lookahead', 'cloud.sched', 'sched.lookahead', { min: 0.05, max: 3, step: 0.05, unit: 's' }),
        intSl('cloud.interval', 'cloud.sched', 'sched.interval', { min: 5, max: 200, step: 1, unit: 'ms' }),
      ]),
      slider('cloud.histWin', 'cloud.histWin', () => num(getCloudParams().view.histWin, 4), (v) => setView((vw) => { vw.histWin = v; }), { min: 0.5, max: 60, step: 0.5, unit: 's' }),
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = getCloudParams();
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(params),
        el('div', { class: 'lg:col-span-4 flex flex-col gap-3 min-w-0' }, [
          buildTimeRack(), buildPitchRack(params), buildSieveRack(params), buildGlideRack(params), buildDurRack(params), buildGainRack(params), buildTimbreRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getCloudParams, edit: editCloud })), buildAdvRack(),
        ]),
      ]),
    );
  }

  function structureKey() {
    const p = getCloudParams();
    const tab = p.view.curveTab;
    return [getLang(), tab, getCurve(p, tab).engine, p.pitch.dist, p.glide.mode, p.duration.dist, p.gain.envelope, (p.pitch.sieve.terms || []).length].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      const params = getCloudParams();
      const ev = getCloudEvents(params); // edit-time bake (cache hit unless the signature changed) / 편집 시점 베이킹
      if (isCloudPlaying()) syncCloudLive(ev, params);
      syncers.forEach((fn) => fn());
      canvases?.render(params, ev);
    },
    fit: fitCloud,
    destroy() {
      offProgress();
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
