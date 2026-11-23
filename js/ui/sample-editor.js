/**
 * Flexatone — ui/sample-editor.js
 * Layer 4 (ui): the shared per-voice Sampler panel — sound file, waveform with a draggable region,
 * root note, loop, crossfade, gain. Used by the Glissando timbre section and by the shared timbre
 * editor of the voice-based studios (Draw, Tempo, Space, Field).
 * 계층 4 (ui): 공용 보이스별 샘플러 패널 — 사운드 파일, 구간을 끌어 고르는 파형, 루트 음, 루프,
 * 크로스페이드, 게인. 글리산도 음색 섹션과 보이스 기반 스튜디오의 공용 음색 편집기에서 사용.
 *
 * The panel edits one sample spec (modules/sample-source.js) through the binding, so undo and
 * "which voice" stay the caller's business. It always edits a single voice.
 * 바인딩을 통해 샘플 스펙 하나만 편집 (실행 취소·대상 보이스는 호출 측 담당). 항상 보이스 하나만 편집.
 */

import { t } from '../core/i18n.js';
import { endHistoryGesture } from '../core/state.js';
import { midiToNoteName } from '../core/units.js';
import { clamp } from '../core/math-utils.js';
import { getSample, listSamples, onSampleLibraryChange, MAX_SAMPLE_SEC } from '../core/sample-library.js';
import { normalizeSampleSpec, detectSampleRoot, SAMPLE_XFADE_MAX_MS, SAMPLE_SPEED_MAX, SAMPLE_GRAIN_MIN_MS, SAMPLE_GRAIN_MAX_MS } from '../modules/sample-source.js';
import { importSampleFile } from '../audio/sample-voice.js';
import { el, syncValue, setText } from './panels.js';

const INPUT = 'w-full min-w-0 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-xs tabular-nums focus:border-violet-500 focus:outline-none';
const BTN = 'px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition';
const HANDLE_PX = 6;
const SEG_ON = 'px-2 py-0.5 rounded bg-violet-600 text-white font-semibold transition';
const SEG_OFF = 'px-2 py-0.5 rounded text-slate-400 hover:text-white transition';

/** Min / max envelope of a file for drawing (cached per entry and width). / 파형 그리기용 최소·최대 */
const peakCache = new WeakMap();
function peaksOf(entry, cols) {
  let byW = peakCache.get(entry);
  if (!byW) { byW = new Map(); peakCache.set(entry, byW); }
  let p = byW.get(cols);
  if (p) return p;
  const lo = new Float32Array(cols);
  const hi = new Float32Array(cols);
  const d = entry.data;
  const scale = entry.peak > 1e-6 ? 1 / entry.peak : 1;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor((c * d.length) / cols);
    const b = Math.max(a + 1, Math.floor(((c + 1) * d.length) / cols));
    let mn = 0;
    let mx = 0;
    const step = Math.max(1, Math.floor((b - a) / 256));
    for (let i = a; i < b; i += step) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    lo[c] = mn * scale;
    hi[c] = mx * scale;
  }
  p = { lo, hi };
  byW.set(cols, p);
  return p;
}

/**
 * Build the panel.
 * @param {{
 *   get: () => object | null | undefined,                 the voice's sample spec (null = nothing selected)
 *   edit: (fn: (spec: object) => void, key?: string|null) => void,   mutate the spec of that one voice
 *   toast?: (msg: string) => void,
 * }} binding
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createSampleEditor(binding) {
  const spec = () => normalizeSampleSpec(binding.get());
  const toast = (msg) => (binding.toast ? binding.toast(msg) : console.info('[Flexatone]', msg));
  const commit = () => endHistoryGesture();

  // ---- file row: library select + Load
  const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a', class: 'hidden' });
  const selFile = el('select', { class: 'flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs' });
  const btnLoad = el('button', { class: BTN, text: t('sample.load') });

  async function loadFile(file) {
    if (!file) return;
    try {
      const { entry, cut } = await importSampleFile(file);
      const r = detectSampleRoot(entry, {});
      binding.edit((s) => {
        s.id = entry.id;
        s.t0 = 0;
        s.t1 = null;
        if (Number.isFinite(r)) s.root = Math.round(r * 100) / 100;
      });
      commit();
      if (cut) toast(t('sample.cut', MAX_SAMPLE_SEC));
      else if (!Number.isFinite(r)) toast(t('sample.noPitch'));
    } catch (err) {
      console.warn('[Flexatone] sample import failed:', err);
      toast(t('sample.loadError'));
    }
  }

  btnLoad.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { loadFile(fileInput.files?.[0]); fileInput.value = ''; });
  selFile.addEventListener('change', () => {
    const id = selFile.value;
    if (!id) return;
    binding.edit((s) => { if (s.id !== id) { s.id = id; s.t0 = 0; s.t1 = null; } });
    commit();
  });

  // ---- waveform
  const canvas = el('canvas', { class: 'w-full h-full block cursor-col-resize touch-none' });
  const wave = el('div', { class: 'relative h-20 rounded bg-slate-950 border border-slate-800 overflow-hidden' }, [canvas]);
  const hint = el('p', { class: 'text-[10px] text-slate-500', text: t('sample.hint') });
  const info = el('p', { class: 'text-[10px] text-slate-400 font-mono truncate' });

  // ---- parameters
  const inRoot = el('input', { type: 'number', min: '0', max: '127', step: '0.01', class: INPUT });
  const rootName = el('span', { class: 'text-[10px] text-slate-400 font-mono w-9 text-right' });
  const btnDetect = el('button', { class: BTN, text: t('sample.detect') });
  const chkLoop = el('input', { type: 'checkbox', class: 'accent-violet-500' });
  const inXf = el('input', { type: 'number', min: '0', max: String(SAMPLE_XFADE_MAX_MS), step: '1', class: INPUT });
  const inGain = el('input', { type: 'number', min: '-36', max: '24', step: '0.5', class: INPUT });
  const btnFull = el('button', { class: BTN, text: t('sample.full') });
  // Playback: Tape (pitch + speed together) | Pitch only (granular, own read speed) / 재생 방식
  const btnTape = el('button', { class: SEG_ON, text: t('sample.playTape') });
  const btnPitch = el('button', { class: SEG_OFF, text: t('sample.playPitch') });
  btnTape.addEventListener('click', () => { binding.edit((s) => { s.play = 'tape'; }); commit(); });
  btnPitch.addEventListener('click', () => { binding.edit((s) => { s.play = 'pitch'; }); commit(); });
  const inSpeed = el('input', { type: 'number', min: '0', max: String(SAMPLE_SPEED_MAX), step: '0.05', class: INPUT });
  const inGrain = el('input', { type: 'number', min: String(SAMPLE_GRAIN_MIN_MS), max: String(SAMPLE_GRAIN_MAX_MS), step: '5', class: INPUT });

  const numEdit = (input, field, key, lo, hi) => {
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || input.value === '') return;
      binding.edit((s) => { s[field] = clamp(v, lo, hi); }, key);
    });
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => e.stopPropagation()); // no studio shortcuts while typing / 단축키 방지
  };
  numEdit(inRoot, 'root', 'sample-root', 0, 127);
  numEdit(inXf, 'xfadeMs', 'sample-xfade', 0, SAMPLE_XFADE_MAX_MS);
  numEdit(inGain, 'gainDb', 'sample-gain', -36, 24);
  numEdit(inSpeed, 'speed', 'sample-speed', 0, SAMPLE_SPEED_MAX);
  numEdit(inGrain, 'grainMs', 'sample-grain', SAMPLE_GRAIN_MIN_MS, SAMPLE_GRAIN_MAX_MS);
  chkLoop.addEventListener('change', () => { binding.edit((s) => { s.loop = chkLoop.checked ? 'loop' : 'off'; }); commit(); });
  btnFull.addEventListener('click', () => { binding.edit((s) => { s.t0 = 0; s.t1 = null; }); commit(); });
  btnDetect.addEventListener('click', () => {
    const s = spec();
    const entry = getSample(s.id);
    if (!entry) return;
    const r = detectSampleRoot(entry, s);
    if (!Number.isFinite(r)) { toast(t('sample.noPitch')); return; }
    binding.edit((x) => { x.root = Math.round(r * 100) / 100; });
    commit();
  });

  const label = (key, child) => el('label', { class: 'flex flex-col gap-0.5 min-w-0' }, [el('span', { class: 'text-[10px] text-slate-400', text: t(key) }), child]);
  const params = el('div', { class: 'grid grid-cols-[1.4fr_1fr_1fr] gap-1.5 items-end' }, [
    el('div', { class: 'flex flex-col gap-0.5 min-w-0' }, [
      el('span', { class: 'text-[10px] text-slate-400', text: t('sample.root') }),
      el('div', { class: 'flex items-center gap-1 min-w-0' }, [inRoot, rootName, btnDetect]),
    ]),
    label('sample.xfade', inXf),
    label('sample.gain', inGain),
  ]);
  const playRow = el('div', { class: 'flex items-center justify-between gap-2' }, [
    el('span', { class: 'text-[10px] text-slate-400', text: t('sample.play') }),
    el('div', { class: 'flex rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-[11px]', role: 'group' }, [btnTape, btnPitch]),
  ]);
  const pitchRow = el('div', { class: 'hidden grid grid-cols-2 gap-1.5' }, [label('sample.speed', inSpeed), label('sample.grain', inGrain)]);
  const playHint = el('p', { class: 'text-[10px] text-slate-500' });
  const row2 = el('div', { class: 'flex items-center justify-between gap-2' }, [
    el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-300' }, [chkLoop, el('span', { text: t('sample.loop') })]),
    btnFull,
  ]);

  const root = el('div', { class: 'flex flex-col gap-2 bg-slate-950/90 border border-slate-800 rounded-lg p-2.5 text-xs', dataset: { help: 'gliss.timbreSample' } }, [
    el('div', { class: 'flex items-center gap-1.5 min-w-0' }, [selFile, btnLoad, fileInput]),
    wave, info, params, playRow, pitchRow, playHint, row2, hint,
  ]);

  // Drop a file anywhere on the panel / 패널 위에 파일 끌어 놓기
  root.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); root.classList.add('ring-1', 'ring-violet-500'); } });
  root.addEventListener('dragleave', () => root.classList.remove('ring-1', 'ring-violet-500'));
  root.addEventListener('drop', (e) => {
    root.classList.remove('ring-1', 'ring-violet-500');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    loadFile(f);
  });

  // ---- region dragging on the waveform / 파형 위 구간 드래그
  let drag = null; // { mode: 'a' | 'b' | 'new', anchor }
  const secAtX = (x, entry) => clamp(x / Math.max(1, canvas.clientWidth), 0, 1) * (entry.length / entry.sampleRate);
  canvas.addEventListener('pointerdown', (e) => {
    const s = spec();
    const entry = getSample(s.id);
    if (!entry) return;
    const dur = entry.length / entry.sampleRate;
    const w = canvas.clientWidth;
    const xa = (s.t0 / dur) * w;
    const xb = ((s.t1 ?? dur) / dur) * w;
    const x = e.offsetX;
    if (Math.abs(x - xa) <= HANDLE_PX) drag = { mode: 'a' };
    else if (Math.abs(x - xb) <= HANDLE_PX) drag = { mode: 'b' };
    else drag = { mode: 'new', anchor: secAtX(x, entry) };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const s = spec();
    const entry = getSample(s.id);
    if (!entry) return;
    if (!drag) {
      const dur = entry.length / entry.sampleRate;
      const w = canvas.clientWidth;
      const near = Math.abs(e.offsetX - (s.t0 / dur) * w) <= HANDLE_PX || Math.abs(e.offsetX - ((s.t1 ?? dur) / dur) * w) <= HANDLE_PX;
      canvas.style.cursor = near ? 'ew-resize' : 'crosshair';
      return;
    }
    const sec = secAtX(e.offsetX, entry);
    const dur = entry.length / entry.sampleRate;
    const minLen = 0.005;
    binding.edit((x) => {
      const t1 = x.t1 ?? dur;
      if (drag.mode === 'a') x.t0 = clamp(sec, 0, t1 - minLen);
      else if (drag.mode === 'b') x.t1 = clamp(sec, (x.t0 || 0) + minLen, dur);
      else {
        const a = Math.min(drag.anchor, sec);
        const b = Math.max(drag.anchor, sec);
        if (b - a < minLen) return;
        x.t0 = a;
        x.t1 = b;
      }
    }, 'sample-region');
  });
  const endDrag = () => { if (drag) { drag = null; commit(); } };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => { binding.edit((s) => { s.t0 = 0; s.t1 = null; }); commit(); });

  function draw(s, entry) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = globalThis.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    if (!entry) {
      ctx.fillStyle = 'rgba(148,163,184,0.55)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.id ? t('sample.missing') : t('sample.empty'), w / 2, h / 2 + 4);
      return;
    }
    const dur = entry.length / entry.sampleRate;
    const xa = (s.t0 / dur) * w;
    const xb = ((s.t1 ?? dur) / dur) * w;
    ctx.fillStyle = 'rgba(139,92,246,0.18)';
    ctx.fillRect(xa, 0, Math.max(1, xb - xa), h);
    const cols = Math.max(16, Math.round(w));
    const { lo, hi } = peaksOf(entry, cols);
    const mid = h / 2;
    for (let c = 0; c < cols; c++) {
      const x = (c / cols) * w;
      const inside = x >= xa && x <= xb;
      ctx.fillStyle = inside ? '#a78bfa' : 'rgba(148,163,184,0.45)';
      const y0 = mid - hi[c] * (mid - 2);
      const y1 = mid - lo[c] * (mid - 2);
      ctx.fillRect(x, y0, Math.max(1, w / cols), Math.max(1, y1 - y0));
    }
    ctx.fillStyle = '#c4b5fd';
    ctx.fillRect(xa - 1, 0, 2, h);
    ctx.fillRect(xb - 1, 0, 2, h);
    if (s.loop === 'loop') {
      ctx.fillStyle = '#c4b5fd';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('↻', xb - 4, 11);
    }
  }

  let libRev = -1;
  let libSeen = 0;
  onSampleLibraryChange(() => { libSeen++; sync(); });
  let lastDrawn = '';

  function sync() {
    const s = spec();
    const entry = getSample(s.id);
    if (libRev !== libSeen || selFile.dataset.cur !== s.id) {
      libRev = libSeen;
      selFile.dataset.cur = s.id;
      const items = listSamples().map((e) => el('option', { value: e.id, text: `${e.name} (${(e.length / e.sampleRate).toFixed(2)} s)` }));
      const none = el('option', { value: '', text: s.id && !entry ? t('sample.missingShort') : t('sample.choose') });
      selFile.replaceChildren(none, ...items);
    }
    syncValue(selFile, entry ? s.id : '');
    syncValue(inRoot, s.root);
    setText(rootName, midiToNoteName(Math.round(s.root)));
    syncValue(inXf, s.xfadeMs);
    syncValue(inGain, s.gainDb);
    const pitchOnly = s.play === 'pitch';
    btnTape.className = pitchOnly ? SEG_OFF : SEG_ON;
    btnPitch.className = pitchOnly ? SEG_ON : SEG_OFF;
    btnTape.setAttribute('aria-pressed', pitchOnly ? 'false' : 'true');
    btnPitch.setAttribute('aria-pressed', pitchOnly ? 'true' : 'false');
    pitchRow.classList.toggle('hidden', !pitchOnly);
    syncValue(inSpeed, s.speed);
    syncValue(inGrain, s.grainMs);
    setText(playHint, t(pitchOnly ? 'sample.playPitchHint' : 'sample.playTapeHint'));
    chkLoop.checked = s.loop === 'loop';
    btnDetect.disabled = !entry;
    if (entry) {
      const dur = entry.length / entry.sampleRate;
      const b = s.t1 ?? dur;
      setText(info, t('sample.region', s.t0.toFixed(3), Math.min(b, dur).toFixed(3), Math.max(0, Math.min(b, dur) - s.t0).toFixed(3), dur.toFixed(2)));
    } else setText(info, '');
    const key = `${s.id}|${!!entry}|${s.t0}|${s.t1}|${s.loop}|${canvas.clientWidth}x${canvas.clientHeight}`;
    if (key !== lastDrawn && canvas.clientWidth) { lastDrawn = key; draw(s, entry); }
  }

  return { root, sync };
}
