/**
 * Flexatone — ui/timbre-group-dialog.js
 * Layer 4 (ui): Timbre "Group Apply" for the Glissando voices. Select voices first (card checkboxes),
 * then this dialog lists the different timbres those voices have (Mix / f(x) / Sample) and copies the
 * chosen one onto every selected voice. "Import sound file…" brings in a new file as a Sampler timbre
 * for all of them. Each voice keeps its own copy, so it can still be edited on its own afterwards.
 * 계층 4 (ui): 글리산도 음색 "그룹 적용". 먼저 보이스를 선택(카드 체크박스)한 뒤, 이 창이 선택된 보이스들의
 * 서로 다른 음색(Mix / f(x) / 샘플)을 보여 주고 고른 음색을 선택된 모든 보이스에 복사함. "사운드 파일
 * 가져오기…"는 새 파일을 모든 보이스의 샘플러 음색으로 들여옴. 각 보이스는 자기 사본을 가짐.
 */

import { t } from '../core/i18n.js';
import { appState, getVoiceById, updateVoices, endHistoryGesture, TIMBRE_WAVES } from '../core/state.js';
import { midiToNoteName } from '../core/units.js';
import { getSample, MAX_SAMPLE_SEC } from '../core/sample-library.js';
import { normalizeSampleSpec, detectSampleRoot, sampleSpecKey } from '../modules/sample-source.js';
import { previewTimbreCycle } from '../modules/timbre-synth.js';
import { importSampleFile } from '../audio/sample-voice.js';
import { el } from './panels.js';

const BTN = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-xs font-medium transition';
const BTN_PRIMARY = 'px-2.5 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold transition';
const SCOPE = ['canvas', 'gain', 'panels', 'matrix', 'timbre'];

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/** The timbre part of a Glissando voice (what Group Apply copies). / 보이스의 음색 부분 */
export function voiceTimbreFields(v) {
  const mode = v.timbreMode === 'func' || v.timbreMode === 'sample' ? v.timbreMode : 'mix';
  return { timbreMode: mode, timbre: clone(v.timbre), timbreFunc: clone(v.timbreFunc), timbreSample: mode === 'sample' ? normalizeSampleSpec(v.timbreSample) : clone(v.timbreSample) };
}

/** Key that is equal for two voices that sound the same timbre. / 같은 음색이면 같은 키 */
export function voiceTimbreKey(v) {
  const f = voiceTimbreFields(v);
  if (f.timbreMode === 'sample') return `sample|${sampleSpecKey(f.timbreSample)}`;
  if (f.timbreMode === 'func') {
    const tf = f.timbreFunc || {};
    return tf.source === 'voice' ? `func|voice|${tf.voiceId || ''}` : `func|expr|${String(tf.expr || '').replace(/\s+/g, '')}`;
  }
  return `mix|${TIMBRE_WAVES.map((w) => r2(f.timbre?.[w])).join(',')}`;
}

/** Copy timbre fields onto a voice (mutates). / 음색 필드를 보이스에 복사 */
export function applyTimbreFields(v, f) {
  v.timbreMode = f.timbreMode;
  if (f.timbre) v.timbre = clone(f.timbre);
  if (f.timbreFunc) v.timbreFunc = clone(f.timbreFunc);
  if (f.timbreSample) v.timbreSample = normalizeSampleSpec(clone(f.timbreSample));
}

function describe(v) {
  const f = voiceTimbreFields(v);
  if (f.timbreMode === 'sample') {
    const s = f.timbreSample;
    const entry = getSample(s.id);
    const dur = entry ? entry.length / entry.sampleRate : 0;
    const b = s.t1 ?? dur;
    const name = entry ? entry.name : t('sample.missingShort');
    const extra = [s.loop === 'loop' ? '↻' : '', s.play === 'pitch' ? t('sample.playPitch') : t('sample.playTape'), s.envOn ? t('sample.env') : ''].filter(Boolean).join(' · ');
    return { mode: t('timbre.sample'), text: `${name} · ${s.t0.toFixed(2)}–${Math.min(b, dur || b).toFixed(2)} s · ${midiToNoteName(Math.round(s.root))}${extra ? ` · ${extra}` : ''}` };
  }
  if (f.timbreMode === 'func') {
    const tf = f.timbreFunc || {};
    if (tf.source === 'voice') return { mode: 'f(x)', text: `← ${getVoiceById(tf.voiceId)?.name || '—'}` };
    return { mode: 'f(x)', text: String(tf.expr || '') };
  }
  const parts = TIMBRE_WAVES.filter((w) => r2(f.timbre?.[w]) > 0).map((w) => `${t(`timbre.${w}`)} ${r2(f.timbre[w]).toFixed(2)}`);
  return { mode: t('timbre.mix'), text: parts.join(' · ') || '—' };
}

function cyclePreview(v) {
  const c = el('canvas', { class: 'w-16 h-8 shrink-0 rounded bg-slate-950 border border-slate-800' });
  requestAnimationFrame(() => {
    const w = c.clientWidth || 64;
    const h = c.clientHeight || 32;
    const dpr = globalThis.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    if (v.timbreMode === 'sample') {
      // Region waveform / 구간 파형
      const s = normalizeSampleSpec(v.timbreSample);
      const entry = getSample(s.id);
      if (entry) {
        const a = Math.floor(s.t0 * entry.sampleRate);
        const b = Math.min(entry.length, s.t1 === null ? entry.length : Math.floor(s.t1 * entry.sampleRate));
        const sc = entry.peak > 1e-6 ? 1 / entry.peak : 1;
        for (let x = 0; x < w; x++) {
          const i0 = a + Math.floor(((b - a) * x) / w);
          const i1 = a + Math.floor(((b - a) * (x + 1)) / w);
          let mx = 0;
          for (let i = i0; i < i1; i += Math.max(1, Math.floor((i1 - i0) / 64))) mx = Math.max(mx, Math.abs(entry.data[i]));
          ctx.moveTo(x + 0.5, h / 2 - mx * sc * (h / 2 - 2));
          ctx.lineTo(x + 0.5, h / 2 + mx * sc * (h / 2 - 2));
        }
      }
    } else {
      const { wave } = previewTimbreCycle(v, { voices: appState.voices, points: 96 });
      for (let i = 0; i <= wave.length; i++) {
        const y = h / 2 - wave[i % wave.length] * (h / 2 - 3);
        const x = (i / wave.length) * w;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  });
  return c;
}

let open = null;

/**
 * Open the dialog for the current selection. / 현재 선택에 대해 창 열기
 * @param {{ toast?: (msg: string, kind?: string) => void }} [opts]
 */
export function openTimbreGroupDialog({ toast = () => {} } = {}) {
  if (open) return;
  const ids = appState.selectedVoiceIds.filter((id) => getVoiceById(id));
  if (ids.length < 2) { toast(t('ui.groupNeedsMulti'), 'error'); return; }
  const voices = ids.map(getVoiceById);

  // Distinct timbres, in selection order; the active voice's one first / 서로 다른 음색 (활성 보이스 먼저)
  const groups = new Map();
  const ordered = [...voices].sort((a, b) => (b.id === appState.activeVoiceId) - (a.id === appState.activeVoiceId));
  for (const v of ordered) {
    const k = voiceTimbreKey(v);
    if (!groups.has(k)) groups.set(k, { lead: v, users: [] });
    groups.get(k).users.push(v);
  }

  const apply = (fields) => {
    const set = new Set(ids);
    updateVoices((vv) => { if (set.has(vv.id)) applyTimbreFields(vv, fields); }, { ids, scope: SCOPE });
    endHistoryGesture();
    toast(t('timbreGroup.applied', ids.length));
    close();
  };

  const overlay = el('div', { class: 'fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4', role: 'dialog' });
  overlay.setAttribute('aria-modal', 'true');
  const rows = [...groups.values()].map(({ lead, users }) => {
    const d = describe(lead);
    const shared = users.length === ids.length;
    return el('div', { class: 'flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/70 p-2' }, [
      cyclePreview(lead),
      el('div', { class: 'flex flex-col gap-0.5 min-w-0 flex-1' }, [
        el('div', { class: 'flex items-center gap-1.5 min-w-0' }, [
          el('span', { class: 'px-1.5 rounded bg-violet-900/60 text-violet-200 text-[10px] font-semibold shrink-0', text: d.mode }),
          el('span', { class: 'text-[11px] text-slate-200 font-mono truncate', text: d.text, title: d.text }),
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1' }, users.map((u) => el('span', { class: 'flex items-center gap-1 text-[10px] text-slate-400' }, [
          el('span', { class: 'w-2 h-2 rounded-full', style: `background:${u.color}` }),
          el('span', { text: u.name }),
        ]))),
      ]),
      el('button', {
        class: shared ? `${BTN} opacity-50` : BTN_PRIMARY,
        text: t('timbreGroup.apply', ids.length),
        title: shared ? t('timbreGroup.already') : '',
        on: { click: () => apply(voiceTimbreFields(lead)) },
      }),
    ]);
  });

  // Import a new sound file for every selected voice / 새 사운드 파일을 선택된 모든 보이스로
  const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a', class: 'hidden' });
  const status = el('span', { class: 'text-[11px] text-slate-400' });
  const importFile = async (file) => {
    if (!file) return;
    setStatus(t('timbreGroup.importing'));
    try {
      const { entry, cut } = await importSampleFile(file);
      const r = detectSampleRoot(entry, {});
      // Keep the active voice's Sampler settings when it already is one / 활성 보이스가 샘플러면 설정 유지
      const act = getVoiceById(appState.activeVoiceId);
      const base = act?.timbreMode === 'sample' ? normalizeSampleSpec(act.timbreSample) : normalizeSampleSpec({});
      const spec = { ...base, id: entry.id, t0: 0, t1: null, root: Number.isFinite(r) ? Math.round(r * 100) / 100 : base.root };
      if (cut) toast(t('sample.cut', MAX_SAMPLE_SEC));
      else if (!Number.isFinite(r)) toast(t('sample.noPitch'));
      apply({ timbreMode: 'sample', timbreSample: spec });
    } catch (err) {
      console.warn('[Flexatone] sample import failed:', err);
      setStatus('');
      toast(t('sample.loadError'), 'error');
    }
  };
  function setStatus(x) { status.textContent = x; }
  fileInput.addEventListener('change', () => { importFile(fileInput.files?.[0]); fileInput.value = ''; });
  const importRow = el('div', { class: 'flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-700 p-2' }, [
    el('button', { class: BTN, text: `⤓ ${t('timbreGroup.import')}`, on: { click: () => fileInput.click() } }),
    el('span', { class: 'text-[11px] text-slate-500', text: t('timbreGroup.importHint') }),
    status,
    fileInput,
  ]);
  importRow.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); importRow.classList.add('border-violet-500'); } });
  importRow.addEventListener('dragleave', () => importRow.classList.remove('border-violet-500'));
  importRow.addEventListener('drop', (e) => {
    importRow.classList.remove('border-violet-500');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    importFile(f);
  });

  const card = el('div', { class: 'w-full max-w-lg max-h-[85vh] rounded-2xl bg-slate-900 border border-violet-500/50 shadow-2xl p-4 flex flex-col gap-3' }, [
    el('h3', { class: 'text-sm font-bold text-violet-200', text: t('timbreGroup.title', ids.length) }),
    el('p', { class: 'text-[12px] leading-relaxed text-slate-400', text: t('timbreGroup.body') }),
    el('div', { class: 'flex flex-col gap-1.5 overflow-y-auto custom-scroll pr-1' }, rows),
    importRow,
    el('div', { class: 'flex justify-end' }, [el('button', { class: BTN, text: t('reload.cancel'), on: { click: () => close() } })]),
  ]);
  overlay.append(card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  function close() {
    if (!open) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    open = null;
  }
  open = { close };
  document.body.append(overlay);
}
