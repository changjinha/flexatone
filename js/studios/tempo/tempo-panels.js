/**
 * Flexatone — studios/tempo/tempo-panels.js
 * Tempo Studio UI tier: workspace DOM (header, voice strip, canvases, piece / subject /
 * convergence / phasing / pulse / voice racks). Mounted by ui/studio-host.js on the Tempo tab.
 * 템포 스튜디오 작업 공간 DOM (헤더, 보이스 스트립, 캔버스, 각 랙).
 *
 * Every control carries data-help="tempo.…" (entries from tempo-i18n.js, copied into HELP_DB here);
 * number inputs are scrubbable (ui/number-scrub.js). One slider drag = one undo step.
 * 모든 컨트롤에 data-help가 있고, 슬라이더 드래그 1회 = 실행 취소 1단계.
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
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import { TEMPO_HELP } from './tempo-i18n.js';
import {
  TEMPO_PRESETS, PRESET_IDS, TEMPO_MODES, CURVE_ENGINES, PULSE_KINDS, BAKE_MODES, SUBJECT_SOURCES,
  MAX_TEMPO_VOICES, MAX_SUBJECT_NOTES, LENGTH_MIN, LENGTH_MAX,
  createTempoVoice, createTempoCurve, randomSubjectNotes, convergeRatio, getTempoBakeCount, getLastBakeMs, rateAt,
} from './tempo-engine.js';
import { TEMPO_ID, getTempoParams, editTempo, getActiveTempoVoice, getTempoBake, getBakePlan, resolveSubject } from '../tempo-studio.js';
import { createTempoCanvases } from './tempo-canvases.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { exportTempoJson, exportTempoWav } from './tempo-audio.js';

for (const [k, v] of Object.entries(TEMPO_HELP)) HELP_DB[k] = v;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const H3 = 'text-xs font-bold uppercase tracking-wider';
const fmtRate = (r) => `×${roundTo(r, 3)}`;

/**
 * Mount the Tempo workspace into `root`. / 템포 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountTempoWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let rollEl = null;
  const commit = () => endHistoryGesture();

  // ------------------------------------------------------------------ control helpers
  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label) => `tempo:${label}` });
  /** Delete the active voice (✕ button, Delete / Backspace); the last one stays. / 활성 성부 삭제 */
  function deleteActiveVoice() {
    editTempo((d) => {
      if (d.voices.length <= 1) return;
      const idx = d.voices.findIndex((x) => x.id === d.activeVoiceId);
      d.voices.splice(Math.max(0, idx), 1);
      d.activeVoiceId = d.voices[Math.max(0, idx - 1)].id;
      d.preset = 'custom';
    });
    commit();
  }
  const segment = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  function numBox(get, set, { min, max, step, help, width = 'w-14' }) {
    const inp = el('input', { type: 'number', min, max, step, class: `${width} px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]`, dataset: { help } });
    inp.addEventListener('input', () => { if (inp.dataset.scrubbing) set(clamp(num(inp.value, get()), min, max), `tempo:num:${help}`); });
    inp.addEventListener('change', () => { set(clamp(num(inp.value, get()), min, max), inp.dataset.scrubbing ? `tempo:num:${help}` : null); commit(); });
    syncers.push(() => { if (document.activeElement !== inp) inp.value = String(roundTo(get(), 4)); });
    return inp;
  }
  const info = (fn, help, cls = 'text-[11px] text-slate-400 font-mono') => { const s = el('span', { class: cls, dataset: help ? { help } : {} }); syncers.push(() => { s.textContent = fn(); }); return s; };

  const editActive = (fn, coalesceKey = null) => editTempo((d) => { const v = d.voices.find((x) => x.id === d.activeVoiceId) || d.voices[0]; if (v) fn(v, d); }, { coalesceKey });
  const docNum = (path) => () => num(path.split('.').reduce((o, k) => o?.[k], getTempoParams()));
  const setDocNum = (path) => (val, ck) => editTempo((d) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], d)[last] = val; }, { coalesceKey: ck });
  const vNum = (path) => () => num(path.split('.').reduce((o, k) => o?.[k], getActiveTempoVoice()));
  const setVNum = (path) => (val, ck) => editActive((v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], v)[last] = val; }, ck);

  const voiceRateLabel = (v, i, doc) => {
    const tp = v.tempo;
    if (tp.mode === 'curve') return `${fmtRate(tp.lo)}→${fmtRate(tp.hi)}`;
    if (tp.mode === 'converge') return `${convergeRatio(doc, i)}·r₀ = ${fmtRate(convergeRatio(doc, i) * doc.converge.r0)}`;
    return fmtRate(tp.ratio);
  };

  // ------------------------------------------------------------------ header + strip
  function bake(mode) {
    const plan = getBakePlan();
    if (!plan.total) { hooks.showToast(t('tempo.bakeNone'), 'error'); return; }
    StudioRegistry.bakeVoices(TEMPO_ID, { mode });
    if (plan.over) hooks.showToast(t('tempo.bakeOver', plan.total, plan.cutSec.toFixed(1)), 'error');
    else hooks.showToast(t('tempo.bakedToGliss', plan.kept.length));
  }

  function buildHeader() {
    const badge = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-mono', dataset: { help: 'tempo.bake' } });
    syncers.push(() => {
      const doc = getTempoParams();
      const plan = getBakePlan(doc);
      badge.textContent = t('tempo.bakeStatus', doc.voices.length, plan.total, getTempoBakeCount(), getLastBakeMs().toFixed(1));
      badge.className = `px-2 py-0.5 rounded-full text-[10px] font-mono border ${plan.over ? 'bg-amber-500/15 text-amber-300 border-amber-500/40' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'}`;
    });
    const presetOpts = [...PRESET_IDS, 'custom'].map((id) => [id, t(`tempo.preset.${id}`)]);
    const presetSel = select('tempo.preset', presetOpts, () => getTempoParams().preset || 'custom', (id) => {
      if (!TEMPO_PRESETS[id]) return;
      StudioRegistry.setParams(TEMPO_ID, TEMPO_PRESETS[id](), { history: true });
      canvases?.fit();
      hooks.showToast(t('tempo.presetLoaded', t(`tempo.preset.${id}`)));
    });
    const reseed = el('button', { class: BTN, text: `🎲 ${t('tempo.reseed')}`, dataset: { help: 'tempo.reseed' }, on: { click: () => {
      const seed = (getTempoParams().seed || 1) + 1;
      editTempo((d) => { d.seed = seed; d.subject.notes = randomSubjectNotes(seed, 10); d.subject.source = 'editor'; d.preset = 'custom'; });
      commit();
      hooks.showToast(t('tempo.reseeded', seed));
    } } });
    const seedInfo = info(() => `#${getTempoParams().seed}`, 'tempo.reseed', 'text-[10px] text-slate-500 font-mono');
    const wav = el('button', { class: BTN, text: `⤓ ${t('tempo.exportWav')}`, dataset: { help: 'tempo.export' }, on: { click: async () => {
      hooks.showToast(t('toast.wavStart'));
      try { const r = await exportTempoWav(); hooks.showToast(r.message, r.ok ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
    } } });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2', dataset: { help: 'tempo.studio' } }, [
          el('h2', { class: `${H3} text-pink-300`, text: `${t('studio.tempo')} · ${t('tempo.title')}` }),
          el('span', { class: 'text-[11px] text-slate-400', text: t('tempo.subtitle') }),
          badge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[11px] text-slate-400', text: t('tempo.preset') }), presetSel,
          reseed, seedInfo,
          createTrajectoryImportButton('tempo'), // Glissando trajectory → this studio's base line / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('tempo.bakeGliss')}`, dataset: { help: 'tempo.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('tempo.bakeAppend'), dataset: { help: 'tempo.bakeGliss' }, on: { click: () => bake('append') } }),
          select('tempo.bakeMode', BAKE_MODES.map((m) => [m, t(`tempo.bakeMode.${m}`)]), () => getTempoParams().quantizeBake, (val) => editTempo((d) => { d.quantizeBake = val; })),
          el('button', { class: BTN, text: `⤓ ${t('tempo.exportJson')}`, dataset: { help: 'tempo.export' }, on: { click: () => { exportTempoJson(); hooks.showToast(t('tempo.jsonDone')); } } }),
          wav,
        ]),
      ]),
      el('span', { class: 'text-[10px] text-slate-500', text: t('tempo.lossNote'), dataset: { help: 'tempo.bakeGliss' } }),
    ]);
  }

  function buildStrip(doc) {
    const cards = doc.voices.map((v, i) => {
      const on = v.id === doc.activeVoiceId;
      const flag = (field, label, onCls) => {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[10px] font-bold border', text: label, dataset: { help: 'tempo.voiceCard' }, on: { click: (e) => { e.stopPropagation(); editTempo((d) => { const x = d.voices.find((y) => y.id === v.id); if (x) x[field] = !x[field]; }); commit(); } } });
        syncers.push(() => { const x = getTempoParams().voices.find((y) => y.id === v.id); b.className = `px-1.5 py-0.5 rounded text-[10px] font-bold border ${x?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return b;
      };
      const line = info(() => {
        const d = getTempoParams();
        const x = d.voices.find((y) => y.id === v.id);
        return x ? `${t(`tempo.mode.${x.tempo.mode}`)} ${voiceRateLabel(x, i, d)}` : '';
      }, 'tempo.voiceCard', 'text-[11px] font-mono text-slate-300 truncate');
      return el('div', {
        class: `min-w-[170px] rounded-xl border p-2 flex flex-col gap-1 cursor-pointer transition ${on ? 'bg-slate-900 border-pink-500 shadow-md' : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'tempo.voiceCard' },
        on: { click: () => editTempo((d) => { d.activeVoiceId = v.id; }, { history: false }) },
      }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('div', { class: 'flex items-center gap-1.5 min-w-0' }, [el('span', { class: 'w-2.5 h-2.5 rounded-full shrink-0', style: `background:${v.color}` }), el('span', { class: 'text-xs font-bold text-slate-100 truncate', text: `${i + 1} · ${v.name}` })]),
          el('div', { class: 'flex gap-1' }, [flag('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'), flag('muted', 'M', 'bg-rose-600 text-white border-rose-500')]),
        ]),
        line,
      ]);
    });
    const add = () => {
      if (getTempoParams().voices.length >= MAX_TEMPO_VOICES) { hooks.showToast(t('tempo.maxVoices', MAX_TEMPO_VOICES), 'error'); return; }
      editTempo((d) => {
        const used = new Set(d.voices.map((x) => x.id));
        let k = d.voices.length;
        while (used.has(`tv${k + 1}`)) k++;
        const nv = createTempoVoice(k, { name: `Voice ${d.voices.length + 1}`, color: createTempoVoice(d.voices.length).color });
        d.voices.push(nv);
        d.activeVoiceId = nv.id;
        d.preset = 'custom';
      });
      commit();
    };
    const dup = () => {
      if (getTempoParams().voices.length >= MAX_TEMPO_VOICES) { hooks.showToast(t('tempo.maxVoices', MAX_TEMPO_VOICES), 'error'); return; }
      editTempo((d) => {
        const cur = d.voices.find((x) => x.id === d.activeVoiceId) || d.voices[0];
        const used = new Set(d.voices.map((x) => x.id));
        let k = d.voices.length;
        while (used.has(`tv${k + 1}`)) k++;
        const copy = { ...JSON.parse(JSON.stringify(cur)), id: `tv${k + 1}`, name: `${cur.name}′`, color: createTempoVoice(d.voices.length).color };
        d.voices.push(copy);
        d.activeVoiceId = copy.id;
        d.preset = 'custom';
      });
      commit();
    };
    const del = deleteActiveVoice;
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-300', text: t('tempo.voiceCount', doc.voices.length) }),
        el('div', { class: 'flex flex-wrap gap-1.5' }, [
          el('button', { class: BTN, text: `+ ${t('tempo.addVoice')}`, dataset: { help: 'tempo.voiceEdit' }, on: { click: add } }),
          el('button', { class: BTN, text: `⧉ ${t('tempo.dupVoice')}`, dataset: { help: 'tempo.voiceEdit' }, on: { click: dup } }),
          el('button', { class: BTN, text: `✕ ${t('tempo.delVoice')}`, dataset: { help: 'tempo.voiceEdit' }, on: { click: del } }),
        ]),
      ]),
      el('div', { class: 'flex gap-2 overflow-x-auto pb-1' }, cards),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol() {
    const hud = {
      time: el('span', { class: 'text-sky-300 font-mono text-[11px]', text: '—' }),
      phaseAt: el('span', { class: 'text-slate-400 font-mono text-[11px]', text: '' }),
    };
    const timeline = el('canvas', { class: 'w-full h-[260px] rounded-lg bg-slate-950 block', dataset: { help: 'tempo.timeline' } });
    const score = el('canvas', { class: 'w-full h-[210px] rounded-lg bg-slate-950 block', dataset: { help: 'tempo.scoreGraph' } });
    const phase = el('canvas', { class: 'w-full h-[150px] rounded-lg bg-slate-950 block', dataset: { help: 'tempo.phaseView' } });
    const roll = el('canvas', { class: 'w-full h-[96px] rounded-lg bg-slate-950 block', dataset: { help: 'tempo.subjectRoll' } });
    rollEl = roll; // shown inside the subject card / 주제 카드 안에 표시
    canvases = createTempoCanvases({ timeline, score, phase, roll, hud }, { requestRender: hooks.requestRender });
    const locateBtns = createLocateButtons(); // shared ✥ Locate / 🧲 Snap / 공용 이동·스냅
    syncers.push(locateBtns.sync);
    const head = (titleKey, color, extra = []) => el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [el('h3', { class: `text-xs font-semibold ${color}`, text: t(titleKey) }), el('div', { class: 'flex items-center gap-2' }, extra)]);
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [
        head('tempo.timelineTitle', 'text-sky-300', [...locateBtns, hud.time, el('span', { class: 'text-[10px] text-slate-500', text: t('tempo.canvasHint') }), createZoomBar({ onPitch: (f) => canvases?.zoom('pitch', f), onTime: (f) => canvases?.zoom('time', f), onBoth: (f) => canvases?.zoom('both', f), onFit: () => canvases?.fit() })]),
        timeline,
      ]),
      el('section', { class: SECTION }, [head('tempo.scoreTitle', 'text-pink-300', [el('span', { class: 'text-[10px] text-slate-500', text: t('tempo.scoreHint') })]), score]),
      el('section', { class: SECTION }, [
        head('tempo.phaseTitle', 'text-emerald-300', [hud.phaseAt]),
        el('span', { class: 'text-[10px] text-slate-500', text: t('tempo.phaseLegend') }),
        phase,
      ]),
    ]);
  }

  // ------------------------------------------------------------------ racks
  function buildPieceRack() {
    const doc = getTempoParams();
    const glissMode = doc.subject.source === 'glissandoVoice';
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-sky-300`, text: t('tempo.globalTitle') }),
      slider('tempo.length', 'tempo.length', docNum('length'), (val, ck) => editTempo((d) => { d.length = val; d.converge.Tc = Math.min(d.converge.Tc, val); }, { coalesceKey: ck }), { min: LENGTH_MIN, max: LENGTH_MAX, step: 0.5, unit: 's' }),
      slider('tempo.bpmRef', 'tempo.bpmRef', docNum('subject.bpmRef'), setDocNum('subject.bpmRef'), { min: 20, max: 480, step: 1 }),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        labelled('tempo.source', select('tempo.source', SUBJECT_SOURCES.map((s) => [s, t(`tempo.source.${s}`)]), () => getTempoParams().subject.source, (val) => editTempo((d) => { d.subject.source = val; })), 'tempo.source'),
        glissMode ? labelled('tempo.voiceIndex', numBox(() => getTempoParams().subject.voiceIndex + 1, (val, ck) => editTempo((d) => { d.subject.voiceIndex = Math.round(val) - 1; }, { coalesceKey: ck }), { min: 1, max: 999, step: 1, help: 'tempo.source' }), 'tempo.source') : null,
      ]),
      glissMode && resolveSubject(doc).fallback ? el('span', { class: 'text-[11px] text-amber-300', text: t('tempo.noGlissVoice') }) : null,
    ]);
  }

  function buildSubjectRack(doc) {
    const sub = resolveSubject(doc).sub;
    const editable = sub.kind === 'notes';
    const rows = editable ? doc.subject.notes.map((_, idx) => {
      const getN = () => getTempoParams().subject.notes[idx] || { midi: 60, dur: 1, glide: 0 };
      const setN = (k) => (val, ck) => editTempo((d) => { if (d.subject.notes[idx]) d.subject.notes[idx][k] = val; d.preset = 'custom'; }, { coalesceKey: ck && `${ck}:${idx}` });
      const name = el('input', { type: 'text', class: 'w-12 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-center font-mono text-[11px]', dataset: { help: 'tempo.subject' } });
      name.addEventListener('keydown', (e) => e.stopPropagation());
      name.addEventListener('change', () => {
        const m = noteNameToMidi(name.value);
        if (m === null) { hooks.showToast(t('pitch.invalidNote', name.value), 'error'); return; }
        setN('midi')(clamp(m, 12, 120));
        commit();
      });
      syncers.push(() => { if (document.activeElement !== name) name.value = midiToNoteName(getN().midi); });
      return el('div', { class: 'grid grid-cols-[20px_48px_1fr_1fr_1fr_18px] items-center gap-1 text-[11px]', dataset: { help: 'tempo.subject' } }, [
        el('span', { class: 'text-slate-500 font-mono text-right', text: String(idx + 1) }),
        name,
        numBox(() => getN().midi, setN('midi'), { min: 12, max: 120, step: 1, help: 'tempo.subject', width: 'w-full' }),
        numBox(() => getN().dur, setN('dur'), { min: 0.0625, max: 32, step: 0.25, help: 'tempo.subject', width: 'w-full' }),
        numBox(() => getN().glide, setN('glide'), { min: 0, max: 1, step: 0.05, help: 'tempo.subject', width: 'w-full' }),
        el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold', text: '✕', dataset: { help: 'tempo.subject' }, on: { click: () => { editTempo((d) => { if (d.subject.notes.length > 1) d.subject.notes.splice(idx, 1); d.preset = 'custom'; }); commit(); } } }),
      ]);
    }) : [];
    const roll = rollEl || el('div');
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: `${H3} text-cyan-300`, text: t('tempo.subjectTitle'), dataset: { help: 'tempo.subject' } }),
        info(() => { const s = resolveSubject(getTempoParams()).sub; return s.kind === 'notes' ? t('tempo.subjectInfo', s.notes.length, s.L.toFixed(2)) : t('tempo.curveSubjectInfo', s.L.toFixed(2)); }, 'tempo.subject', 'text-[10px] text-slate-400 font-mono'),
      ]),
      roll,
      editable ? el('div', { class: 'grid grid-cols-[20px_48px_1fr_1fr_1fr_18px] gap-1 text-[10px] uppercase tracking-wider text-slate-500' }, [
        el('span'), el('span', { text: t('tempo.note.pitch') }), el('span', { text: 'MIDI' }), el('span', { text: t('tempo.note.dur') }), el('span', { text: t('tempo.note.glide') }), el('span'),
      ]) : null,
      editable ? el('div', { class: 'flex flex-col gap-1 max-h-[220px] overflow-y-auto pr-1' }, rows) : null,
      editable ? el('button', { class: `${BTN} self-start`, text: `+ ${t('tempo.note.add')}`, dataset: { help: 'tempo.subject' }, on: { click: () => {
        const d0 = getTempoParams();
        if (d0.subject.notes.length >= MAX_SUBJECT_NOTES) return;
        editTempo((d) => { const last = d.subject.notes[d.subject.notes.length - 1]; d.subject.notes.push({ midi: last ? last.midi : 60, dur: 1, glide: 0 }); d.preset = 'custom'; });
        commit();
      } } }) : null,
    ]);
  }

  function buildConvergeRack() {
    const ratios = el('input', { type: 'text', class: 'w-28 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-[11px] text-right', dataset: { help: 'tempo.ratios' } });
    ratios.addEventListener('keydown', (e) => e.stopPropagation());
    ratios.addEventListener('change', () => {
      const list = ratios.value.split(/[:,\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0).slice(0, MAX_TEMPO_VOICES);
      if (list.length) { editTempo((d) => { d.converge.ratios = list; d.preset = 'custom'; }); commit(); }
    });
    syncers.push(() => { if (document.activeElement !== ratios) ratios.value = getTempoParams().converge.ratios.join(':'); });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: `${H3} text-pink-300`, text: t('tempo.convergeTitle'), dataset: { help: 'tempo.converge' } }),
        toggle('tempo.converge.on', 'tempo.converge', () => getTempoParams().converge.enabled, () => { editTempo((d) => { d.converge.enabled = !d.converge.enabled; }); commit(); }),
      ]),
      slider('tempo.Tc', 'tempo.converge', docNum('converge.Tc'), (val, ck) => editTempo((d) => { d.converge.Tc = Math.min(val, d.length); }, { coalesceKey: ck }), { min: 0, max: LENGTH_MAX, step: 0.05, unit: 's', accent: 'accent-pink' }),
      slider('tempo.sc', 'tempo.converge', docNum('converge.sc'), setDocNum('converge.sc'), { min: -60, max: 240, step: 0.05, unit: 's', accent: 'accent-pink' }),
      labelled('tempo.ratios', ratios, 'tempo.ratios'),
      slider('tempo.r0', 'tempo.ratios', docNum('converge.r0'), setDocNum('converge.r0'), { min: 0.01, max: 4, step: 0.005, unit: '×', accent: 'accent-pink' }),
      info(() => { const d = getTempoParams(); return t('tempo.ratesInfo', d.voices.map((v, i) => (v.tempo.mode === 'converge' ? fmtRate(convergeRatio(d, i) * d.converge.r0) : '—')).join(' · ')); }, 'tempo.ratios'),
    ]);
  }

  function buildPhasingRack() {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: `${H3} text-amber-300`, text: t('tempo.phasingTitle'), dataset: { help: 'tempo.phasing' } }),
        toggle('tempo.phasing.on', 'tempo.phasing', () => getTempoParams().phasing.enabled, () => { editTempo((d) => { d.phasing.enabled = !d.phasing.enabled; }); commit(); }),
      ]),
      slider('tempo.epsilon', 'tempo.phasing', docNum('phasing.epsilon'), setDocNum('phasing.epsilon'), { min: -0.05, max: 0.05, step: 0.0005, accent: 'accent-amber' }),
      info(() => { const d = getTempoParams(); const L = getTempoBake(d).L; const e = Math.abs(d.phasing.epsilon); return e > 1e-6 ? t('tempo.phasing.shift', (L / e).toFixed(1)) : '—'; }, 'tempo.phasing'),
    ]);
  }

  function buildPulseRack() {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: `${H3} text-violet-300`, text: t('tempo.pulseTitle'), dataset: { help: 'tempo.pulse' } }),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          toggle('tempo.pulse.on', 'tempo.pulse', () => getTempoParams().pulse.audible, () => { editTempo((d) => { d.pulse.audible = !d.pulse.audible; }); commit(); }),
          segment('tempo.pulse', PULSE_KINDS.map((k) => [k, `tempo.pulse.${k}`]), () => getTempoParams().pulse.kind, (val) => editTempo((d) => { d.pulse.kind = val; }), 'violet'),
          toggle('tempo.pulse.accent', 'tempo.pulse', () => getTempoParams().pulse.accentFirst, () => { editTempo((d) => { d.pulse.accentFirst = !d.pulse.accentFirst; }); commit(); }),
        ]),
      ]),
      slider('tempo.pulse.level', 'tempo.pulse', docNum('pulse.level'), setDocNum('pulse.level'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-violet' }),
    ]);
  }

  function buildCurveParams(v) {
    const parts = [];
    const eng = v.tempo.curve.engine;
    const getC = () => getActiveTempoVoice().tempo.curve;
    for (const s of PARAM_SCHEMAS[eng] || []) {
      if (s.type === 'range') {
        parts.push(slider(s.labelKey, 'tempo.curve', () => num(getC()[s.key], s.default), (val, ck) => editActive((x) => { x.tempo.curve[s.key] = s.integer ? Math.round(val) : val; }, ck), { min: s.softMin ?? s.min, max: s.softMax ?? s.max, step: s.step, accent: 'accent-pink' }));
      } else if (s.type === 'select') {
        parts.push(labelled(s.labelKey, select('tempo.curve', s.options.map((o) => [o.value, t(o.labelKey)]), () => getC()[s.key] ?? s.default, (val) => editActive((x) => { x.tempo.curve[s.key] = val; })), 'tempo.curve'));
      } else if (s.type === 'toggle') {
        parts.push(toggle(s.labelKey, 'tempo.curve', () => !!(getC()[s.key] ?? s.default), () => { editActive((x) => { x.tempo.curve[s.key] = !(x.tempo.curve[s.key] ?? s.default); }); commit(); }));
      }
    }
    return parts;
  }

  function buildVoiceRack(doc) {
    const v = getActiveTempoVoice(doc);
    const idx = doc.voices.indexOf(v);
    const mode = v.tempo.mode;
    const body = [];
    if (mode === 'const') {
      body.push(slider('tempo.ratio', 'tempo.ratio', vNum('tempo.ratio'), setVNum('tempo.ratio'), { min: 0.01, max: 4, step: 0.001, unit: '×', accent: 'accent-pink' }));
    } else if (mode === 'curve') {
      body.push(
        el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
          slider('tempo.lo', 'tempo.curve', vNum('tempo.lo'), setVNum('tempo.lo'), { min: 0.01, max: 4, step: 0.01, unit: '×', accent: 'accent-pink' }),
          slider('tempo.hi', 'tempo.curve', vNum('tempo.hi'), setVNum('tempo.hi'), { min: 0.01, max: 4, step: 0.01, unit: '×', accent: 'accent-pink' }),
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          segment('tempo.curve', [['lin', 'tempo.scale.lin'], ['log', 'tempo.scale.log']], () => getActiveTempoVoice().tempo.scale, (val) => editActive((x) => { x.tempo.scale = val; }), 'pink'),
          labelled('tempo.curveShape', select('tempo.curve', CURVE_ENGINES.map((id) => [id, getEngineLabel(id, { short: true })]), () => getActiveTempoVoice().tempo.curve.engine, (val) => editActive((x) => { x.tempo.curve = createTempoCurve(val); })), 'tempo.curve'),
        ]),
        ...buildCurveParams(v),
      );
    } else {
      body.push(info(() => { const d = getTempoParams(); return `ρ = ${convergeRatio(d, idx)} · r₀ = ${d.converge.r0} → ${fmtRate(convergeRatio(d, idx) * d.converge.r0)}`; }, 'tempo.ratios'));
    }
    const startCtl = slider('tempo.start', 'tempo.start', vNum('start'), setVNum('start'), { min: -60, max: 60, step: 0.05, unit: 's' });
    const solved = info(() => {
      const d = getTempoParams();
      if (!d.converge.enabled) return '';
      const bv = getTempoBake(d).map.get(getActiveTempoVoice(d).id);
      return bv ? t('tempo.startSolved', bv.track.s0.toFixed(3)) : '';
    }, 'tempo.start', 'text-[11px] text-pink-300 font-mono');
    syncers.push(() => { startCtl.style.opacity = getTempoParams().converge.enabled ? '0.4' : '1'; });
    const rateNow = info(() => {
      const d = getTempoParams();
      const bv = getTempoBake(d).map.get(getActiveTempoVoice(d).id);
      return bv ? `r(0) = ${fmtRate(rateAt(bv.track, 0))} · r(T) = ${fmtRate(rateAt(bv.track, d.length))}` : '';
    }, 'tempo.mode');
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: `${H3} text-pink-300`, text: `${t('tempo.voiceTitle')} · ${idx + 1} ${v.name}`, dataset: { help: 'tempo.mode' } }),
        segment('tempo.mode', TEMPO_MODES.map((m) => [m, `tempo.mode.${m}`]), () => getActiveTempoVoice().tempo.mode, (val) => editActive((x) => { x.tempo.mode = val; }), 'pink'),
      ]),
      ...body,
      rateNow,
      startCtl,
      solved,
      el('div', { class: 'flex items-center gap-2' }, [
        toggle('tempo.loop', 'tempo.loop', () => getActiveTempoVoice().loop, () => { editActive((x) => { x.loop = !x.loop; }); commit(); }),
      ]),
    ]);
  }

  function buildSoundRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getActiveTempoVoice()?.timbre, edit: (fn, k) => editActive((v) => { fn(v.timbre); }, k), sample: true, toast: (m) => hooks.showToast(m), idPrefix: 'tempo-timbre' });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'tempo.sound' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: `${H3} text-emerald-300`, text: t('tempo.soundTitle'), dataset: { help: 'tempo.sound' } }),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        slider('tempo.transpose', 'tempo.pitchShift', vNum('transpose'), setVNum('transpose'), { min: -24, max: 24, step: 1, unit: 'st' }),
        slider('tempo.octave', 'tempo.pitchShift', vNum('octaveShift'), setVNum('octaveShift'), { min: -3, max: 3, step: 1 }),
      ]),
      slider('tempo.baseGain', 'tempo.sound', vNum('baseGain'), setVNum('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      el('span', { class: 'text-[11px] text-slate-400', text: t('tempo.timbre'), dataset: { help: 'tempo.sound' } }),
      timbre,
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const doc = getTempoParams();
    syncers = [];
    canvases?.destroy();
    const canvasCol = buildCanvasCol();
    const subject = buildSubjectRack(doc);
    root.replaceChildren(
      buildHeader(),
      buildStrip(doc),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        canvasCol,
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildVoiceRack(doc), buildSoundRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getTempoParams, edit: editTempo })), buildPieceRack(), subject, buildConvergeRack(), buildPhasingRack(), buildPulseRack()]),
      ]),
    );
  }

  function structureKey() {
    const p = getTempoParams();
    const v = getActiveTempoVoice(p);
    return [getLang(), p.activeVoiceId, p.voices.map((x) => x.id).join(','), p.subject.notes.length, p.subject.source, resolveSubject(p).fallback, v.tempo.mode, v.tempo.curve.engine].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render();
    },
    fit: () => canvases?.fit(),
    deleteSelection: deleteActiveVoice, // Delete / Backspace (ui/studio-host.js)
    destroy() {
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
