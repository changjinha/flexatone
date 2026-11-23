/**
 * Flexatone — ui/manager-video.js
 * Layer 4 (ui): "Export video" for the Manager's Master View. Renders the same scene as the live
 * Master View (ui/manager-panel.js drawScene) into an off-screen canvas at a chosen size, plays the
 * exported cycle mix (the same audio as "Export cycle WAV") into it, and records both with
 * MediaRecorder (MP4 where the browser can, else WebM). Layers — grid, axes, curves / graphics,
 * ranges & shapes, cycle markers, playhead, legend, spectrum — can each be left out.
 * Recording runs in real time (one cycle takes one cycle length).
 * 계층 4 (ui): 매니저 마스터 뷰 "동영상 내보내기". 실시간 마스터 뷰와 같은 장면을 지정 크기로 그리고,
 * 사이클 WAV와 같은 믹스를 함께 MediaRecorder로 녹화 (가능하면 MP4, 아니면 WebM). 격자·축·그래픽·구간·
 * 사이클 표시·플레이헤드·범례·스펙트럼을 각각 끄고 켤 수 있음. 실시간 녹화 (사이클 길이만큼 걸림).
 */

import { t } from '../core/i18n.js';
import { clamp } from '../core/math-utils.js';
import { listInstances, getInstanceDoc, isInstanceAudible, channelRates } from '../core/manager-state.js';
import { tapeSemitones } from '../core/tempo.js';
import { runtimeStepScale } from '../modules/tempo-manager.js';
import { createRissetRuntime, stepRuntime, phaseToMidi, voiceAmplitude } from '../studios/risset/risset-core.js';
import { resolveRissetDoc } from '../studios/risset/risset-audio.js';
import * as mixer from '../audio/manager-mixer.js';
import { ensureAudioCtx, triggerDownload } from '../audio/audio-engine.js';
import { drawScene, viewMapDims, masterGeometry, masterCurvedView } from './manager-panel.js';

const SIZES = [
  { id: '720p', w: 1280, h: 720 },
  { id: '1080p', w: 1920, h: 1080 },
  { id: 'square', w: 1080, h: 1080 },
  { id: 'vertical', w: 1080, h: 1920 },
  { id: '4k', w: 3840, h: 2160 },
];

const FORMATS = [
  { id: 'mp4', ext: 'mp4', label: 'MP4 (H.264 / AAC)', mimes: ['video/mp4;codecs=avc1.640033,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'] },
  { id: 'webm', ext: 'webm', label: 'WebM (VP9 / Opus)', mimes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] },
];

/** Layer checkboxes (id → i18n key). Spectrum is drawn here, the rest by drawScene. / 레이어 */
const LAYERS = [
  ['grid', 'mgrVid.grid'],
  ['axes', 'mgrVid.axes'],
  ['graphics', 'mgrVid.graphics'],
  ['regions', 'mgrVid.regions'],
  ['markers', 'mgrVid.markers'],
  ['playhead', 'mgrVid.playhead'],
  ['legend', 'mgrVid.legend'],
  ['spectrum', 'mgrVid.spectrum'],
];

// Settings persist for the session / 세션 동안 유지되는 설정
const opts = {
  layers: { grid: true, axes: true, graphics: true, regions: true, markers: true, playhead: true, legend: false, spectrum: false },
  theme: 'dark',
  size: '1080p',
  fps: 30,
  format: null,
  cycles: 1,
  audio: true,
  monitor: true,
  lineScale: 1,
  view: null, // 'cartesian' | 'curved'; null = follow the Master View when the dialog opens / 보기 (처음엔 마스터 뷰를 따름)
};

let dlg = null;
let job = null; // running recording / 진행 중 녹화

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function supportedFormats() {
  const MR = globalThis.MediaRecorder;
  if (!MR) return [];
  const out = [];
  for (const f of FORMATS) {
    const mime = f.mimes.find((m) => { try { return MR.isTypeSupported(m); } catch { return false; } });
    if (mime) out.push({ ...f, mime });
  }
  return out;
}

/** Open the Export video dialog. / 동영상 내보내기 대화상자 열기 */
export function openMasterVideoDialog({ hooks } = {}) {
  if (dlg) { dlg.focus(); return; }
  const formats = supportedFormats();
  if (!formats.length || !HTMLCanvasElement.prototype.captureStream) {
    hooks?.showToast?.(t('mgrVid.unsupported'), 'error');
    return;
  }
  if (!opts.format || !formats.some((f) => f.id === opts.format)) opts.format = formats[0].id;
  if (opts.view === null) opts.view = masterCurvedView() ? 'curved' : 'cartesian';
  dlg = document.createElement('div');
  dlg.className = 'mgr-vid-backdrop';
  dlg.tabIndex = -1;
  const C = mixer.cycleLength();
  dlg.innerHTML = `
    <div class="mgr-vid" role="dialog" aria-label="${esc(t('mgrVid.title'))}">
      <div class="mgr-vid-head"><b>🎬 ${esc(t('mgrVid.title'))}</b><span class="mgr-muted">${esc(t('mgrVid.sub'))}</span><span style="flex:1"></span><button class="mgr-btn" data-v="close">✕</button></div>
      <div class="mgr-vid-body">
        <div class="mgr-vid-preview"><canvas id="mgrVidCanvas"></canvas></div>
        <div class="mgr-vid-opts">
          <fieldset><legend>${esc(t('mgrVid.layers'))}</legend>
            ${LAYERS.map(([id, key]) => `<label><input type="checkbox" data-layer="${id}" ${opts.layers[id] ? 'checked' : ''}> ${esc(t(key))}</label>`).join('')}
            <div class="mgr-vid-row"><button class="mgr-btn tiny" data-v="all">${esc(t('mgrVid.all'))}</button><button class="mgr-btn tiny" data-v="clean">${esc(t('mgrVid.curvesOnly'))}</button></div>
          </fieldset>
          <fieldset><legend>${esc(t('mgrVid.look'))}</legend>
            <label>${esc(t('mgrVid.background'))} <select data-o="theme">${['dark', 'black', 'white'].map((k) => `<option value="${k}" ${opts.theme === k ? 'selected' : ''}>${esc(t(`mgrVid.bg.${k}`))}</option>`).join('')}</select></label>
            <label title="${esc(t(mixer.getMasterViewWarp() ? 'mgrVid.viewTip' : 'mgr.warpGridNone'))}">${esc(t('mgrVid.view'))} <select data-o="view">${['cartesian', 'curved'].map((k) => `<option value="${k}" ${opts.view === k ? 'selected' : ''}>${esc(t(`mgrVid.view.${k}`))}</option>`).join('')}</select></label>
            <label>${esc(t('mgrVid.lineWidth'))} <select data-o="lineScale">${[1, 1.5, 2, 3].map((k) => `<option value="${k}" ${opts.lineScale === k ? 'selected' : ''}>${k}×</option>`).join('')}</select></label>
          </fieldset>
          <fieldset><legend>${esc(t('mgrVid.output'))}</legend>
            <label>${esc(t('mgrVid.size'))} <select data-o="size">${SIZES.map((z) => `<option value="${z.id}" ${opts.size === z.id ? 'selected' : ''}>${z.w} × ${z.h}</option>`).join('')}</select></label>
            <label>${esc(t('mgrVid.fps'))} <select data-o="fps">${[24, 30, 60].map((k) => `<option value="${k}" ${opts.fps === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
            <label>${esc(t('mgrVid.format'))} <select data-o="format">${formats.map((f) => `<option value="${f.id}" ${opts.format === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
            <label>${esc(t('mgrVid.cycles'))} <input type="number" min="1" max="32" step="1" value="${opts.cycles}" data-o="cycles" style="width:56px"></label>
            <label><input type="checkbox" data-o="audio" ${opts.audio ? 'checked' : ''}> ${esc(t('mgrVid.audio'))}</label>
            <label><input type="checkbox" data-o="monitor" ${opts.monitor ? 'checked' : ''}> ${esc(t('mgrVid.monitor'))}</label>
          </fieldset>
          <div class="mgr-muted mgr-vid-note" id="mgrVidNote"></div>
        </div>
      </div>
      <div class="mgr-vid-foot">
        <div class="mgr-vid-progress"><span id="mgrVidBar"></span></div>
        <span class="mgr-mono mgr-muted" id="mgrVidStatus"></span>
        <span style="flex:1"></span>
        <button class="mgr-btn" data-v="cancel">${esc(t('mgr.cancel'))}</button>
        <button class="mgr-btn play" data-v="record">● ${esc(t('mgrVid.record'))}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('change', onChange);
  dlg.addEventListener('click', (e) => onClick(e, hooks));
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  dlg.focus();
  updateNote(C);
  drawPreview();
}

function close() {
  if (job) cancelJob();
  dlg?.remove();
  dlg = null;
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.layer) opts.layers[el.dataset.layer] = el.checked;
  const k = el.dataset.o;
  if (k === 'audio' || k === 'monitor') opts[k] = el.checked;
  else if (k === 'fps' || k === 'lineScale') opts[k] = Number(el.value);
  else if (k === 'cycles') opts.cycles = clamp(Math.round(Number(el.value) || 1), 1, 32);
  else if (k) opts[k] = el.value;
  updateNote(mixer.cycleLength());
  drawPreview();
}

function setLayers(on) {
  for (const id of Object.keys(opts.layers)) opts.layers[id] = on.includes(id);
  for (const el of dlg.querySelectorAll('[data-layer]')) el.checked = !!opts.layers[el.dataset.layer];
  drawPreview();
}

async function onClick(e, hooks) {
  const el = e.target.closest('[data-v]');
  if (!el && e.target === dlg && !job) { close(); return; }
  if (!el) return;
  switch (el.dataset.v) {
    case 'close': close(); break;
    case 'cancel': if (job) cancelJob(); else close(); break;
    case 'all': setLayers(LAYERS.map(([id]) => id)); break;
    case 'clean': setLayers(['graphics']); break;
    case 'record': if (!job) await record(hooks); break;
    default: break;
  }
}

function updateNote(C) {
  const note = dlg?.querySelector('#mgrVidNote');
  if (!note) return;
  const sec = C * opts.cycles;
  note.textContent = t('mgrVid.note', sec.toFixed(1));
}

// --------------------------------------------------------------------------
// Frame drawing / 프레임 그리기
// --------------------------------------------------------------------------

function sizeOf() {
  return SIZES.find((z) => z.id === opts.size) || SIZES[1];
}

/**
 * Draw one video frame: Master View scene (+ spectrum strip). / 동영상 한 프레임
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {number} H
 */
function drawFrame(ctx, W, H, { pos, risset = [], analyser = null }) {
  const g = masterGeometry();
  const scale = Math.max(1, Math.min(W, H) / 360); // label size relative to the frame / 프레임 대비 글자 크기
  const specH = opts.layers.spectrum ? Math.round(H * 0.18) : 0;
  const v = viewMapDims(W, H - specH, scale, g, { axes: opts.layers.axes, viewLen: viewLenFor(), lineScale: opts.lineScale });
  // Curved view: notes as written, grid bent (as with ⌇ Curved grid on) / 곡률 보기: 쓰인 음, 휜 격자
  drawScene(ctx, v, g, { pos, cue: null, risset, layers: opts.layers, theme: opts.theme, export: true, viewWarp: mixer.getMasterViewWarp(), warpGrid: opts.view === 'curved' });
  if (specH) drawSpectrumStrip(ctx, 0, H - specH, W, specH, scale, analyser);
}

/** The video shows the cycle (plus a little air), not the panel's rounded view length. / 사이클 길이 기준 */
function viewLenFor() {
  const C = mixer.cycleLength();
  return Math.max(0.5, C * 1.02);
}

const SPEC_THEME = {
  dark: { bg: '#050a16', grid: '#111c30', text: '#334155', line: 'rgba(248,250,252,.45)' },
  black: { bg: '#000000', grid: '#141414', text: '#404040', line: 'rgba(255,255,255,.45)' },
  white: { bg: '#f8fafc', grid: '#e2e8f0', text: '#94a3b8', line: 'rgba(15,23,42,.45)' },
};

let specBuf = null;
function drawSpectrumStrip(ctx, x0, y0, w, h, dpr, analyser) {
  const th = SPEC_THEME[opts.theme] || SPEC_THEME.dark;
  ctx.save();
  ctx.translate(x0, y0);
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  const fx = (hz) => (Math.log(hz / 20) / Math.log(1000)) * w;
  ctx.font = `${9 * dpr}px JetBrains Mono, monospace`;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    if (opts.layers.grid) {
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(fx(hz), 0); ctx.lineTo(fx(hz), h); ctx.stroke();
    }
    if (opts.layers.axes) { ctx.fillStyle = th.text; ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, fx(hz) + 2 * dpr, h - 3 * dpr); }
  }
  if (analyser) {
    if (!specBuf || specBuf.length !== analyser.frequencyBinCount) specBuf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(specBuf);
    const sr = analyser.context.sampleRate;
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(56,189,248,.8)');
    grad.addColorStop(0.5, 'rgba(167,139,250,.8)');
    grad.addColorStop(1, 'rgba(52,211,153,.8)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 1; i < specBuf.length; i++) {
      const hz = (i * sr) / (2 * specBuf.length);
      if (hz < 20 || hz > 20000) continue;
      ctx.lineTo(fx(hz), h - clamp((specBuf[i] + 100) / 100, 0, 1) * (h - 4 * dpr));
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.2 * dpr;
    ctx.stroke();
  }
  ctx.restore();
}

function drawPreview() {
  const c = dlg?.querySelector('#mgrVidCanvas');
  if (!c || job) return;
  const { w, h } = sizeOf();
  // Preview at reduced resolution, same proportions / 같은 비율, 낮은 해상도 미리보기
  const k = Math.min(1, 960 / Math.max(w, h));
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.scale(k, k);
  drawFrame(ctx, w, h, { pos: mixer.getCycleCue() });
  ctx.restore();
}

// --------------------------------------------------------------------------
// Risset voices for the video (headless runtime, same clock as the recording)
// 동영상용 리세 보이스 (헤드리스 런타임, 녹화와 같은 시계)
// --------------------------------------------------------------------------

function createRissetSims() {
  const sims = [];
  for (const inst of listInstances()) {
    if (inst.studio !== 'risset' || !inst.inCycle || !isInstanceAudible(inst)) continue;
    const params = resolveRissetDoc(getInstanceDoc(inst));
    sims.push({ inst, params, rt: null, last: null, trail: [], semis: tapeSemitones(channelRates(inst).tape) });
  }
  return sims;
}

function stepRissetSims(sims, pos) {
  const out = [];
  for (const s of sims) {
    const a = Number(s.inst.start) || 0;
    const L = mixer.clipLength(s.inst);
    if (pos < a || pos >= a + L) { s.rt = null; s.last = null; s.trail = []; continue; }
    if (!s.rt || s.last === null || pos < s.last) { s.rt = createRissetRuntime(s.params); s.last = a; s.trail = []; }
    let dt = pos - s.last;
    const rate = channelRates(s.inst).rate;
    while (dt > 1e-6) { const d = Math.min(0.025, dt); stepRuntime(s.params, s.rt, runtimeStepScale(d, rate), { running: true }); dt -= d; }
    s.last = pos;
    const N = s.params.voiceCount;
    const ms = new Float32Array(N);
    const as = new Float32Array(N);
    for (let i = 0; i < N; i++) { ms[i] = phaseToMidi(s.params, s.rt.phases[i]) + s.semis; as[i] = voiceAmplitude(s.params, s.rt, i); }
    s.trail.push({ t: pos, ms, as });
    if (s.trail.length > 900) s.trail.splice(0, s.trail.length - 900);
    out.push({ inst: s.inst, tc: pos, ms, as, trail: s.trail, wf: s.inst.warp?.on ? null : mixer.getTrackWarp(s.inst.id), audible: true });
  }
  return out;
}

// --------------------------------------------------------------------------
// Recording / 녹화
// --------------------------------------------------------------------------

function setBusy(on) {
  if (!dlg) return;
  for (const el of dlg.querySelectorAll('.mgr-vid-opts input, .mgr-vid-opts select, .mgr-vid-opts button, [data-v="record"]')) el.disabled = on;
  dlg.classList.toggle('busy', on);
}

function status(text, frac = null) {
  const st = dlg?.querySelector('#mgrVidStatus');
  if (st) st.textContent = text;
  const bar = dlg?.querySelector('#mgrVidBar');
  if (bar && frac !== null) bar.style.width = `${clamp(frac, 0, 1) * 100}%`;
}

async function record(hooks) {
  const C = mixer.cycleLength();
  if (!(C > 0.05)) { hooks?.showToast?.(t('mgr.nothingToPlay'), 'error'); return; }
  const fmt = supportedFormats().find((f) => f.id === opts.format) || supportedFormats()[0];
  const { w: W, h: H } = sizeOf();
  const total = C * opts.cycles;
  setBusy(true);
  status(t('mgr.exporting'), 0);
  mixer.stopAllManager();
  const actx = await ensureAudioCtx();
  let buffer = null;
  if (opts.audio || opts.layers.spectrum) {
    const res = await mixer.exportCycleWav({ download: false });
    if (res.ok) buffer = res.buffer;
    else if (opts.audio) hooks?.showToast?.(t('mgrVid.silent'), 'info');
  }
  if (!dlg) return; // closed while rendering / 렌더링 중 닫힘

  // Video: the dialog preview canvas becomes the recording surface / 미리보기 캔버스 = 녹화 화면
  const canvas = dlg.querySelector('#mgrVidCanvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const vStream = canvas.captureStream(opts.fps);
  const tracks = [...vStream.getVideoTracks()];

  // Audio: exported mix → (analyser) → recorder (and speakers when monitoring) / 오디오 경로
  const nodes = [];
  let src = null;
  let analyser = null;
  if (buffer) {
    src = actx.createBufferSource();
    src.buffer = buffer;
    src.loop = opts.cycles > 1;
    analyser = actx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);
    nodes.push(src, analyser);
    if (opts.audio) {
      const dest = actx.createMediaStreamDestination();
      analyser.connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
      nodes.push(dest);
    }
    if (opts.monitor) analyser.connect(actx.destination);
  }

  const stream = new MediaStream(tracks);
  const px = W * H * opts.fps;
  const rec = new MediaRecorder(stream, { mimeType: fmt.mime, videoBitsPerSecond: Math.round(clamp(px * 0.12, 2e6, 60e6)), audioBitsPerSecond: 256000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const sims = createRissetSims();
  const lead = 0.25;
  job = { rec, src, nodes, raf: null, cancelled: false, tracks };
  drawFrame(ctx, W, H, { pos: 0, risset: stepRissetSims(sims, 0), analyser });
  rec.start(1000);
  const t0 = actx.currentTime + lead;
  if (src) { src.start(t0); src.stop(t0 + total); }

  const done = new Promise((resolve) => { rec.onstop = resolve; });
  const tick = () => {
    if (!job) return;
    const el = actx.currentTime - t0;
    const p = clamp(el, 0, total);
    const pos = p >= total ? C : p % C;
    drawFrame(ctx, W, H, { pos, risset: stepRissetSims(sims, pos), analyser });
    status(t('mgrVid.recording', p.toFixed(1), total.toFixed(1)), p / total);
    if (el >= total + 0.15) { finish(); return; }
    job.raf = requestAnimationFrame(tick);
  };
  const finish = () => { if (rec.state !== 'inactive') rec.stop(); };
  job.finish = finish;
  job.raf = requestAnimationFrame(tick);
  await done;

  const j = job;
  job = null;
  cleanup(j);
  setBusy(false);
  if (j.cancelled) { status(t('mgrVid.cancelled'), 0); drawPreview(); return; }
  const blob = new Blob(chunks, { type: fmt.mime.split(';')[0] });
  const filename = `Flexatone_Master_${W}x${H}_T${total.toFixed(2)}s.${fmt.ext}`;
  triggerDownload(blob, filename);
  status(t('mgrVid.done', filename, (blob.size / 1048576).toFixed(1)), 1);
  hooks?.showToast?.(t('mgrVid.done', filename, (blob.size / 1048576).toFixed(1)));
  drawPreview();
}

function cleanup(j) {
  if (!j) return;
  cancelAnimationFrame(j.raf);
  try { j.src?.stop(); } catch { /* not started / already stopped */ }
  for (const n of j.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
  for (const tr of j.tracks) { try { tr.stop(); } catch { /* ignore */ } }
}

function cancelJob() {
  if (!job) return;
  job.cancelled = true;
  if (job.rec.state !== 'inactive') job.rec.stop();
}
