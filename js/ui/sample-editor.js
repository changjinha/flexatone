/**
 * Flexatone — ui/sample-editor.js
 * Layer 4 (ui): the shared per-voice Sampler panel — sound file, waveform with a draggable region,
 * root note, loop, crossfade, gain. Used by the Glissando timbre section and by the shared timbre
 * editor of the voice-based studios (Draw, Tempo, Space, Field).
 * 계층 4 (ui): 공용 보이스별 샘플러 패널 — 사운드 파일, 구간을 끌어 고르는 파형, 루트 음, 루프,
 * 크로스페이드, 게인. 글리산도 음색 섹션과 보이스 기반 스튜디오의 공용 음색 편집기에서 사용.
 *
 * Also: a fade-in / fade-out envelope (with "overlap" for loops) and a small player (play / stop /
 * playhead) that plays the region as the voices hear it at the root note, on its own (no transport).
 * 또한: 페이드인·아웃 엔벨로프(루프는 "겹침" 선택)와 구간을 루트 음 그대로 따로 재생하는 작은 플레이어.
 *
 * The panel edits one sample spec (modules/sample-source.js) through the binding, so undo and
 * "which voice" stay the caller's business. It always edits a single voice.
 * 바인딩을 통해 샘플 스펙 하나만 편집 (실행 취소·대상 보이스는 호출 측 담당). 항상 보이스 하나만 편집.
 */

import { t, getLang } from '../core/i18n.js';
import { endHistoryGesture, subscribe, appState } from '../core/state.js';
import { midiToNoteName } from '../core/units.js';
import { clamp } from '../core/math-utils.js';
import { getSample, listSamples, onSampleLibraryChange, MAX_SAMPLE_SEC } from '../core/sample-library.js';
import { normalizeSampleSpec, detectSampleRoot, sampleRegionKey, sampleSpecKey, sampleTapeSpeed, renderGrainShift, regionStartOffset, SAMPLE_TAPE_SPEED_MIN, sampleRegionFrames, sampleEnvelopeFrames, SAMPLE_XFADE_MAX_MS, SAMPLE_SPEED_MAX, SAMPLE_GRAIN_MIN_MS, SAMPLE_GRAIN_MAX_MS, SAMPLE_FADE_MAX_MS } from '../modules/sample-source.js';
import { importSampleFile, getSampleRegionBuffer } from '../audio/sample-voice.js';
import { ensureAudioCtx, onPlayheadTick } from '../audio/audio-engine.js';
import { getOutputBus } from '../audio/output-bus.js';
import { el, syncValue, setText } from './panels.js';

const INPUT = 'w-full min-w-0 px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 font-mono text-xs tabular-nums focus:border-violet-500 focus:outline-none';
const BTN = 'px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 text-[11px] font-medium transition';
const HANDLE_PX = 6;
const BTN_ON = 'px-2 py-0.5 rounded bg-amber-500 border border-amber-400 text-slate-950 text-[11px] font-semibold transition';
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
 *   readPos?: (sec: number) => number | null,   region seconds the voice reads at a transport second (playhead)
 * }} binding
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createSampleEditor(binding) {
  const spec = () => normalizeSampleSpec(binding.get());
  const toast = (msg) => (binding.toast ? binding.toast(msg) : console.info('[Flexatone]', msg));
  const commit = () => endHistoryGesture();
  // Static labels re-read on a language switch (sync compares the language) / 언어 전환 시 다시 읽는 고정 라벨
  const i18nNodes = [];
  const tr = (node, key, attr = 'text') => { i18nNodes.push([node, key, attr]); return node; };
  let builtLang = getLang();

  // ---- file row: library select + Load
  const fileInput = el('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac,.m4a', class: 'hidden' });
  const selFile = el('select', { class: 'flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-1.5 py-0.5 text-xs' });
  const btnLoad = tr(el('button', { class: BTN, text: t('sample.load') }), 'sample.load', 'text');

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
  const hint = tr(el('p', { class: 'text-[10px] text-slate-500', text: t('sample.hint') }), 'sample.hint', 'text');
  const info = el('p', { class: 'text-[10px] text-slate-400 font-mono truncate' });

  // ---- parameters
  const inRoot = el('input', { type: 'number', min: '0', max: '127', step: '0.01', class: INPUT });
  const rootName = el('span', { class: 'text-[10px] text-slate-400 font-mono w-9 text-right' });
  const btnDetect = tr(el('button', { class: BTN, text: t('sample.detect') }), 'sample.detect', 'text');
  const chkLoop = el('input', { type: 'checkbox', class: 'accent-violet-500' });
  const inXf = el('input', { type: 'number', min: '0', max: String(SAMPLE_XFADE_MAX_MS), step: '1', class: INPUT });
  const inGain = el('input', { type: 'number', min: '-36', max: '24', step: '0.5', class: INPUT });
  const btnFull = tr(el('button', { class: BTN, text: t('sample.full') }), 'sample.full', 'text');
  // Playback: Tape (pitch + speed together) | Pitch only (granular, own read speed) / 재생 방식
  const btnTape = tr(el('button', { class: SEG_ON, text: t('sample.playTape') }), 'sample.playTape', 'text');
  const btnPitch = tr(el('button', { class: SEG_OFF, text: t('sample.playPitch') }), 'sample.playPitch', 'text');
  btnTape.addEventListener('click', () => { binding.edit((s) => { s.play = 'tape'; }); commit(); });
  btnPitch.addEventListener('click', () => { binding.edit((s) => { s.play = 'pitch'; }); commit(); });
  // Envelope: on/off + fade in / out, and for loops whether the fades overlap / 엔벨로프
  const chkEnv = el('input', { type: 'checkbox', class: 'accent-violet-500' });
  const inFadeIn = el('input', { type: 'number', min: '0', max: String(SAMPLE_FADE_MAX_MS), step: '10', class: INPUT });
  const inFadeOut = el('input', { type: 'number', min: '0', max: String(SAMPLE_FADE_MAX_MS), step: '10', class: INPUT });
  const chkOverlap = el('input', { type: 'checkbox', class: 'accent-violet-500' });
  chkEnv.addEventListener('change', () => { binding.edit((s) => { s.envOn = chkEnv.checked; }); commit(); });
  chkOverlap.addEventListener('change', () => { binding.edit((s) => { s.loopOverlap = chkOverlap.checked; }); commit(); });
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
  numEdit(inFadeIn, 'fadeInMs', 'sample-fadein', 0, SAMPLE_FADE_MAX_MS);
  numEdit(inFadeOut, 'fadeOutMs', 'sample-fadeout', 0, SAMPLE_FADE_MAX_MS);
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

  const label = (key, child) => el('label', { class: 'flex flex-col gap-0.5 min-w-0' }, [tr(el('span', { class: 'text-[10px] text-slate-400', text: t(key) }), key), child]);
  const params = el('div', { class: 'grid grid-cols-[1.4fr_1fr_1fr] gap-1.5 items-end' }, [
    el('div', { class: 'flex flex-col gap-0.5 min-w-0' }, [
      tr(el('span', { class: 'text-[10px] text-slate-400', text: t('sample.root') }), 'sample.root', 'text'),
      el('div', { class: 'flex items-center gap-1 min-w-0' }, [inRoot, rootName, btnDetect]),
    ]),
    label('sample.xfade', inXf),
    label('sample.gain', inGain),
  ]);
  const playRow = el('div', { class: 'flex items-center justify-between gap-2' }, [
    tr(el('span', { class: 'text-[10px] text-slate-400', text: t('sample.play') }), 'sample.play', 'text'),
    el('div', { class: 'flex rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-[11px]', role: 'group' }, [btnTape, btnPitch]),
  ]);
  // Speed: both modes (tape = rate multiplier, pitch only = read speed); Grain: pitch only / 속도는 두 모드, 그레인은 음높이만
  const grainField = label('sample.grain', inGrain);
  const pitchRow = el('div', { class: 'grid grid-cols-2 gap-1.5' }, [label('sample.speed', inSpeed), grainField]);
  const playHint = el('p', { class: 'text-[10px] text-slate-500' });
  const overlapLabel = tr(el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-300', title: t('sample.overlapTip') }, [chkOverlap, tr(el('span', { text: t('sample.overlap') }), 'sample.overlap', 'text')]), 'sample.overlapTip', 'title');
  const row2 = el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
    el('div', { class: 'flex flex-wrap items-center gap-3' }, [
      el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-300' }, [chkLoop, tr(el('span', { text: t('sample.loop') }), 'sample.loop', 'text')]),
      overlapLabel,
    ]),
    btnFull,
  ]);
  const envFields = el('div', { class: 'grid grid-cols-2 gap-1.5 flex-1' }, [label('sample.fadeIn', inFadeIn), label('sample.fadeOut', inFadeOut)]);
  const envRow = el('div', { class: 'flex items-end gap-2' }, [
    tr(el('label', { class: 'flex items-center gap-1.5 text-[11px] text-slate-300 pb-1 shrink-0', title: t('sample.envTip') }, [chkEnv, tr(el('span', { text: t('sample.env') }), 'sample.env', 'text')]), 'sample.envTip', 'title'),
    envFields,
  ]);

  // ---- player: play / stop / playhead, the region at the root note / 플레이어: 재생 · 정지 · 플레이헤드
  const btnPlay = tr(el('button', { class: BTN, text: '▶', title: t('sample.auditionPlay') }), 'sample.auditionPlay', 'title');
  const btnStop = tr(el('button', { class: BTN, text: '■', title: t('sample.auditionStop') }), 'sample.auditionStop', 'title');
  const seek = tr(el('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0', class: 'flex-1 min-w-0 accent-amber', title: t('sample.auditionSeek') }), 'sample.auditionSeek', 'title');
  const posText = el('span', { class: 'text-[10px] font-mono text-slate-400 tabular-nums w-20 text-right' });
  const playerRow = el('div', { class: 'flex items-center gap-1.5' }, [btnPlay, btnStop, seek, posText]);
  const playhead = el('div', { class: 'hidden absolute top-0 bottom-0 w-px bg-amber-300 pointer-events-none' });
  // Transport playhead: where the voice's source is reading while the document plays (sky blue)
  // 트랜스포트 플레이헤드: 문서 재생 중 보이스 소스가 읽는 위치 (하늘색)
  const transportHead = el('div', { class: 'hidden absolute top-0 bottom-0 w-0.5 bg-sky-300 pointer-events-none' });
  wave.append(playhead, transportHead);
  if (binding.readPos) {
    const hide = () => transportHead.classList.add('hidden');
    // Hidden when the transport stops / 트랜스포트가 멈추면 숨김
    subscribe(() => { if (!appState.transport.playing) hide(); }, { scopes: ['transport'] });
    onPlayheadTick((sec) => {
      if (!root.isConnected || root.offsetParent === null) { hide(); return; }
      const s = spec();
      const entry = getSample(s.id);
      const readSec = entry ? binding.readPos(sec) : null;
      const reg = readSec === null || readSec === undefined ? null : getSampleRegionBuffer(s);
      const off = reg ? regionStartOffset(readSec, reg.seconds, reg.loop) : null;
      if (off === null) { hide(); return; }
      const fileDur = entry.length / entry.sampleRate;
      transportHead.style.left = `${(clamp(s.t0 + off, 0, fileDur) / fileDur) * 100}%`;
      transportHead.classList.remove('hidden');
    });
  }

  const root = el('div', { class: 'flex flex-col gap-2 bg-slate-950/90 border border-slate-800 rounded-lg p-2.5 text-xs', dataset: { help: 'gliss.timbreSample' } }, [
    el('div', { class: 'flex items-center gap-1.5 min-w-0' }, [selFile, btnLoad, fileInput]),
    wave, playerRow, info, params, envRow, playRow, pitchRow, playHint, row2, hint,
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

  // ---- dragging on the waveform / 파형 위 드래그
  // Bottom half: the region (as before). Top half: the fades — left of the region's middle sets the
  // fade-in, right of it the fade-out; dragging there turns the envelope on.
  // 아래쪽 반: 구간 (기존과 같음). 위쪽 반: 페이드 — 구간 가운데 왼쪽은 페이드인, 오른쪽은 페이드아웃 (엔벨로프 자동 켜짐).
  let drag = null; // { mode: 'a' | 'b' | 'new' | 'fade', anchor, side }
  const secAtX = (x, entry) => clamp(x / Math.max(1, canvas.clientWidth), 0, 1) * (entry.length / entry.sampleRate);
  const inTopHalf = (e) => e.offsetY < canvas.clientHeight / 2;
  function setFadeAt(x, side, entry) {
    const s = spec();
    const dur = entry.length / entry.sampleRate;
    const t1 = Math.min(s.t1 ?? dur, dur);
    const lenMs = Math.max(0, (t1 - s.t0) * 1000);
    const sec = secAtX(x, entry);
    if (side === 'in') {
      const v = Math.round(clamp((sec - s.t0) * 1000, 0, Math.max(0, Math.min(SAMPLE_FADE_MAX_MS, lenMs - s.fadeOutMs))));
      binding.edit((x2) => { x2.envOn = true; x2.fadeInMs = v; }, 'sample-fade');
    } else {
      const v = Math.round(clamp((t1 - sec) * 1000, 0, Math.max(0, Math.min(SAMPLE_FADE_MAX_MS, lenMs - s.fadeInMs))));
      binding.edit((x2) => { x2.envOn = true; x2.fadeOutMs = v; }, 'sample-fade');
    }
  }
  canvas.addEventListener('pointerdown', (e) => {
    const s = spec();
    const entry = getSample(s.id);
    if (!entry) return;
    const dur = entry.length / entry.sampleRate;
    const w = canvas.clientWidth;
    const xa = (s.t0 / dur) * w;
    const xb = ((s.t1 ?? dur) / dur) * w;
    const x = e.offsetX;
    if (inTopHalf(e)) {
      drag = { mode: 'fade', side: x < (xa + xb) / 2 ? 'in' : 'out' };
      setFadeAt(x, drag.side, entry);
    } else if (Math.abs(x - xa) <= HANDLE_PX) drag = { mode: 'a' };
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
      if (inTopHalf(e)) { canvas.style.cursor = 'col-resize'; return; }
      const near = Math.abs(e.offsetX - (s.t0 / dur) * w) <= HANDLE_PX || Math.abs(e.offsetX - ((s.t1 ?? dur) / dur) * w) <= HANDLE_PX;
      canvas.style.cursor = near ? 'ew-resize' : 'crosshair';
      return;
    }
    if (drag.mode === 'fade') { setFadeAt(e.offsetX, drag.side, entry); return; }
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
  // Double-click the bottom half: whole file (the top half is for the fades) / 아래쪽 반 더블클릭 = 파일 전체
  canvas.addEventListener('dblclick', (e) => { if (inTopHalf(e)) return; binding.edit((s) => { s.t0 = 0; s.t1 = null; }); commit(); });

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
    if (s.envOn) {
      // Envelope line over the region (top = full level); loop + overlap: dashed copy of the
      // fade-out laid over the start / 구간 위 엔벨로프 선 (루프+겹침: 페이드아웃을 시작 위에 점선으로)
      const { a, b } = sampleRegionFrames(s, entry.length, entry.sampleRate);
      const n = Math.max(1, b - a);
      const { A, R } = sampleEnvelopeFrames(s, n, entry.sampleRate);
      const xOf = (i) => xa + ((xb - xa) * i) / n;
      const yOf = (g) => 2 + (1 - g) * (h - 4);
      const steps = 48;
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(xOf(0), yOf(0));
      for (let k = 1; k <= steps; k++) { const i = (A * k) / steps; ctx.lineTo(xOf(i), yOf(A ? Math.sin((0.5 * Math.PI * i) / A) : 1)); }
      ctx.lineTo(xOf(n - R), yOf(1));
      for (let k = 1; k <= steps; k++) { const j = (R * k) / steps; ctx.lineTo(xOf(n - R + j), yOf(R ? Math.cos((0.5 * Math.PI * j) / R) : 1)); }
      ctx.stroke();
      // Knee handles: where the fade-in ends and the fade-out starts (drag in the top half)
      // 꺾임 점: 페이드인 끝 · 페이드아웃 시작 (위쪽 반에서 드래그)
      ctx.fillStyle = '#fbbf24';
      for (const i of [A, n - R]) { ctx.beginPath(); ctx.arc(xOf(i), yOf(1) + 1, 3, 0, 2 * Math.PI); ctx.fill(); }
      if (s.loop === 'loop' && s.loopOverlap && R > 0) {
        const O = Math.min(R, Math.floor(n / 2));
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (let k = 0; k <= steps; k++) { const i = (O * k) / steps; const j = R - O + i; const p = xOf(i); const y = yOf(Math.cos((0.5 * Math.PI * j) / R)); if (k) ctx.lineTo(p, y); else ctx.moveTo(p, y); }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (s.loop === 'loop') {
      ctx.fillStyle = '#c4b5fd';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('↻', xb - 4, 11);
    }
  }

  // ---- audition / 미리 듣기
  let aud = null; // { ctx, src, gain, t0, off, dur, loop, rate, life, key, raf }
  const AUD_GRAIN_MAX_SEC = 15; // pitch-only preview at a read speed ≠ 1 is rendered up to this long / 그레인 미리듣기 최대 길이
  let seekFrac = 0; // where Play starts, 0–1 of the region buffer / 재생 시작 위치
  const posOf = (x) => {
    const p = x.off + x.rate * Math.max(0, x.ctx.currentTime - x.t0);
    return x.loop ? p % x.dur : Math.min(p, x.dur);
  };
  function showPos(sec, dur, s, entry) {
    setText(posText, `${sec.toFixed(2)} / ${dur.toFixed(2)} s`);
    if (document.activeElement !== seek) seek.value = String(dur > 0 ? sec / dur : 0);
    if (!entry) { playhead.classList.add('hidden'); return; }
    // Buffer seconds → file seconds (a crossfaded loop is shorter than the region) / 버퍼 초 → 파일 초
    const fileDur = entry.length / entry.sampleRate;
    const x = (clamp(s.t0 + sec, 0, fileDur) / fileDur) * 100;
    playhead.style.left = `${x}%`;
    playhead.classList.remove('hidden');
  }
  function tick() {
    if (!aud) return;
    if (!root.isConnected || root.offsetParent === null) { auditionStop(); return; } // panel gone or hidden / 패널이 사라지거나 숨겨짐
    const p = posOf(aud);
    const s = spec();
    showPos(p, aud.dur, s, getSample(s.id));
    if ((!aud.loop && p >= aud.dur - 1e-3) || aud.ctx.currentTime - aud.t0 >= aud.life) { auditionStop(true); return; }
    aud.raf = requestAnimationFrame(tick);
  }
  async function auditionPlay(fromFrac = seekFrac) {
    const s = spec();
    const reg = getSampleRegionBuffer(s);
    if (!reg) return;
    auditionStop();
    let ctx;
    try { ctx = await ensureAudioCtx(); } catch { return; }
    const src = ctx.createBufferSource();
    const off = clamp(fromFrac, 0, 0.999) * reg.seconds;
    // At the root note with the play speed: tape = buffer at rate speed (pitch moves with it);
    // pitch only at speed ≠ 1 = grains rendered at the same pitch / 루트 음 + 재생 속도로 미리듣기
    let rate = 1;
    let life = Infinity;
    let startAt = off;
    if (s.play !== 'pitch') {
      rate = sampleTapeSpeed(s);
      src.buffer = reg.buffer;
      src.loop = reg.loop;
      src.playbackRate.value = rate;
    } else if (Math.abs(s.speed - 1) > 1e-6) {
      rate = s.speed;
      life = reg.loop || rate <= 0 ? AUD_GRAIN_MAX_SEC : Math.min(AUD_GRAIN_MAX_SEC, (reg.seconds - off) / rate);
      const n = Math.max(1, Math.round(life * reg.sampleRate));
      const data = renderGrainShift({ src: reg.data, srcRate: reg.sampleRate, loop: reg.loop, outRate: reg.sampleRate, n, readStartSec: off, speed: rate, grainSec: s.grainMs / 1000, ratioAt: () => 1 });
      const buf = ctx.createBuffer(1, n, reg.sampleRate);
      buf.copyToChannel(data, 0);
      src.buffer = buf;
      startAt = 0;
    } else {
      src.buffer = reg.buffer;
      src.loop = reg.loop;
    }
    const gain = ctx.createGain();
    src.connect(gain).connect(getOutputBus(ctx));
    const t0 = ctx.currentTime + 0.01;
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, t0 + 0.005);
    src.start(t0, startAt);
    aud = { ctx, src, gain, t0, off, dur: reg.seconds, loop: reg.loop, rate, life, key: sampleSpecKey(s), raf: 0 };
    btnPlay.className = BTN_ON;
    tick();
  }
  function auditionStop(atEnd = false) {
    if (!aud) return;
    const x = aud;
    aud = null;
    cancelAnimationFrame(x.raf);
    const now = x.ctx.currentTime;
    if (!atEnd) seekFrac = x.dur > 0 ? posOf(x) / x.dur : 0;
    else seekFrac = 0;
    try {
      x.gain.gain.cancelScheduledValues(now);
      x.gain.gain.setValueAtTime(x.gain.gain.value, now);
      x.gain.gain.linearRampToValueAtTime(0, now + 0.015);
      x.src.stop(now + 0.02);
    } catch { /* already stopped / 이미 정지 */ }
    setTimeout(() => { try { x.src.disconnect(); x.gain.disconnect(); } catch { /* ignore */ } }, 80);
    btnPlay.className = BTN;
    const s = spec();
    const entry = getSample(s.id);
    showPos(seekFrac * x.dur, x.dur, s, entry);
  }
  // Region / envelope edited while playing → carry on from the same place with the new sound;
  // file gone → stop / 재생 중 구간·엔벨로프가 바뀌면 같은 위치에서 새 소리로 계속, 파일이 없으면 정지
  function auditionFollow(s, entry) {
    if (aud) {
      if (!entry) { auditionStop(); return; }
      const key = sampleSpecKey(s);
      if (key !== aud.key) { const f = aud.dur > 0 ? posOf(aud) / aud.dur : 0; auditionPlay(f); }
      return;
    }
    const reg = entry ? getSampleRegionBuffer(s) : null;
    if (!reg) { setText(posText, ''); playhead.classList.add('hidden'); return; }
    showPos(seekFrac * reg.seconds, reg.seconds, s, entry);
  }
  btnPlay.addEventListener('click', () => { if (aud) auditionStop(); else auditionPlay(); });
  btnStop.addEventListener('click', () => {
    // Stop; pressed again while stopped → back to the start / 정지, 정지 상태에서 다시 누르면 처음으로
    if (aud) auditionStop();
    else { seekFrac = 0; sync(); }
  });
  seek.addEventListener('input', () => {
    seekFrac = clamp(Number(seek.value) || 0, 0, 1);
    if (aud) auditionPlay(seekFrac);
    else sync();
  });
  seek.addEventListener('keydown', (e) => e.stopPropagation());

  let libRev = -1;
  let libSeen = 0;
  onSampleLibraryChange(() => { libSeen++; sync(); });
  let lastDrawn = '';

  function sync() {
    const s = spec();
    const entry = getSample(s.id);
    const lang = getLang();
    const langChanged = lang !== builtLang;
    if (langChanged) {
      builtLang = lang;
      for (const [node, key, attr] of i18nNodes) {
        if (attr === 'title') node.title = t(key);
        else node.textContent = t(key);
      }
    }
    if (langChanged || libRev !== libSeen || selFile.dataset.cur !== s.id) {
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
    grainField.classList.toggle('invisible', !pitchOnly);
    inSpeed.min = pitchOnly ? '0' : String(SAMPLE_TAPE_SPEED_MIN);
    syncValue(inSpeed, s.speed);
    syncValue(inGrain, s.grainMs);
    setText(playHint, t(pitchOnly ? 'sample.playPitchHint' : 'sample.playTapeHint'));
    chkLoop.checked = s.loop === 'loop';
    chkEnv.checked = s.envOn;
    syncValue(inFadeIn, s.fadeInMs);
    syncValue(inFadeOut, s.fadeOutMs);
    envFields.classList.toggle('opacity-40', !s.envOn);
    inFadeIn.disabled = !s.envOn;
    inFadeOut.disabled = !s.envOn;
    chkOverlap.checked = s.loopOverlap;
    const showOverlap = s.loop === 'loop' && s.envOn;
    overlapLabel.classList.toggle('hidden', !showOverlap);
    // Loop + envelope: the envelope makes the loop seam, so the crossfade field is not used
    // 루프 + 엔벨로프: 엔벨로프가 이음새를 만들므로 크로스페이드 칸은 쓰지 않음
    inXf.disabled = showOverlap;
    inXf.classList.toggle('opacity-40', showOverlap);
    btnDetect.disabled = !entry;
    btnPlay.disabled = !entry;
    auditionFollow(s, entry);
    if (entry) {
      const dur = entry.length / entry.sampleRate;
      const b = s.t1 ?? dur;
      setText(info, t('sample.region', s.t0.toFixed(3), Math.min(b, dur).toFixed(3), Math.max(0, Math.min(b, dur) - s.t0).toFixed(3), dur.toFixed(2)));
    } else setText(info, '');
    const key = `${sampleRegionKey(s)}|${!!entry}|${canvas.clientWidth}x${canvas.clientHeight}|${lang}`;
    if (key !== lastDrawn && canvas.clientWidth) { lastDrawn = key; draw(s, entry); }
  }

  return { root, sync };
}
