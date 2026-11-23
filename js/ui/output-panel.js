/**
 * Flexatone — ui/output-panel.js
 * UI tier: output-stage strip under the header (visible in every studio).
 * UI 계층: 헤더 아래 출력 단계 스트립 (모든 스튜디오 공통).
 *
 *   [Output] [Amp | dB | Sone Lock] [fader ──●──] [−6.0 dB] [Taper A|B] [dB min] [τ ms]
 *     (Sone mode: slider + box = Loudness-Lock target in sone, log scale; taper hidden)
 *   [Peak/RMS meter, dB-linear ticks] [Loudness 3.2 sone · 56.8 phon] [Analyzer] [Bands ▾]
 *   Bands panel: 24 Bark bars (specific loudness) + excitation line + dashed masking threshold
 *   + Total Sone history + calibration.
 * Every number input works with ui/number-scrub.js; every control has data-help.
 * Imports: core/*, modules/*, audio/output-bus.js.
 */

import { t } from '../core/i18n.js';
import { appState, setPref, normalizeOutputConfig } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { createDbTaper } from '../core/units.js';
import { faderDb, faderNormForDb, formatDb, soneToPhonValue, ampDb } from '../modules/output-stage.js';
import { applyOutputConfig, onLoudnessFrame, getLoudnessFrame, getLoudnessStatus, getLockDb, getLimiterReductionDb } from '../audio/output-bus.js';

const BAND_EDGES = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
const HISTORY = 240; // ~8 s at 30 fps

let ui = null;
let lastCfg = null;
let expanded = false;
let frameDirty = true;
let peakHold = 0;
let peakHoldT = 0;
let rafId = 0;
const soneHist = new Float32Array(HISTORY);
let histPos = 0;

const cls = {
  btn: 'px-1.5 py-0.5 rounded text-[10px] font-medium transition',
  seg: 'flex items-center rounded-md bg-slate-950 border border-slate-800 p-0.5',
  num: 'w-12 px-1 py-0.5 rounded bg-slate-900 border border-slate-700 text-right font-mono text-[10px]',
  lbl: 'text-[10px] text-slate-400 whitespace-nowrap',
};

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) n.dataset[dk] = dv;
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}

const cfg = () => normalizeOutputConfig(appState.output);

// Sone target slider: log scale 0.1 … 200 sone / 목표 Sone 슬라이더 (로그 스케일)
const TARGET_MIN = 0.1;
const TARGET_MAX = 200;
const TARGET_DEFAULT = 8;
const targetToNorm = (s) => Math.log(clamp(s, TARGET_MIN, TARGET_MAX) / TARGET_MIN) / Math.log(TARGET_MAX / TARGET_MIN);
const normToTarget = (n) => TARGET_MIN * Math.pow(TARGET_MAX / TARGET_MIN, clamp(n, 0, 1));
const roundTarget = (s) => Math.round(s * 100) / 100;

function setOutput(patch) {
  const next = normalizeOutputConfig({ ...cfg(), ...patch });
  setPref('output', next, ['output']);
  applyOutputConfig(next);
}

function segBtn(text, onClick, help) {
  return el('button', { class: cls.btn, type: 'button', text, data: { help }, on: { click: onClick } });
}

function paintSeg(btn, on, color = 'sky') {
  btn.classList.toggle(`bg-${color}-600`, on);
  btn.classList.toggle('text-white', on);
  btn.classList.toggle('text-slate-400', !on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function numInput(min, max, step, help, onChange) {
  return el('input', { type: 'number', min, max, step, class: cls.num, data: { help }, on: { change: (e) => onChange(Number(e.target.value)) } });
}

function sync(input, value) {
  if (document.activeElement === input || input.dataset.scrubbing) return;
  const s = String(value);
  if (input.value !== s) input.value = s;
}

/** Build the strip once. / 스트립 생성 */
export function initOutputPanel() {
  const host = document.getElementById('outputStrip');
  if (!host || ui) return;
  const u = {};
  u.title = el('span', { class: 'text-[10px] font-bold uppercase tracking-wider text-sky-300' });
  u.modeAmp = segBtn('Amp', () => setOutput({ mode: 'amp' }), 'out.amp');
  u.modeDb = segBtn('dB', () => setOutput({ mode: 'db' }), 'out.fader');
  u.modeSone = segBtn('Sone', () => setOutput({ mode: 'sone' }), 'out.lock');
  u.fader = el('input', {
    type: 'range', min: 0, max: 1, step: 0.001, class: 'w-28 sm:w-36 accent-sky-500', 'aria-label': 'Output fader', data: { help: 'out.fader', noScrub: '', noReset: '' }, // keeps its own double-click (unit-aware) / 자체 더블클릭 유지
    on: {
      input: (e) => {
        const m = cfg().mode;
        const v = Number(e.target.value);
        setOutput(m === 'amp' ? { ampLevel: v } : m === 'sone' ? { soneTarget: roundTarget(normToTarget(v)) } : { faderNorm: v });
      },
      dblclick: () => {
        const m = cfg().mode;
        setOutput(m === 'amp' ? { ampLevel: 1 } : m === 'sone' ? { soneTarget: TARGET_DEFAULT } : { faderNorm: faderNormForDb(cfg(), 0) });
      },
    },
  });
  u.dbIn = el('input', {
    type: 'number', min: -120, max: 12, step: 0.1, class: `${cls.num} w-14`, data: { help: 'out.fader' },
    on: {
      change: (e) => {
        const v = e.target.value.trim();
        if (cfg().mode === 'amp') setOutput({ ampLevel: v === '' ? 0 : clamp(Number(v) || 0, 0, 1) });
        else if (cfg().mode === 'sone') setOutput({ soneTarget: v === '' ? TARGET_DEFAULT : clamp(Number(v) || TARGET_DEFAULT, TARGET_MIN, TARGET_MAX) });
        else setOutput({ faderNorm: v === '' || /inf/i.test(v) ? 0 : faderNormForDb(cfg(), Number(v)) });
      },
    },
  });
  u.dbUnit = el('span', { class: `${cls.lbl} min-w-[16px]`, text: 'dB' });
  u.taperA = segBtn('A', () => setOutput({ taper: 'linear' }), 'out.taper');
  u.taperB = segBtn('B', () => setOutput({ taper: 'daw' }), 'out.taper');
  u.dbMinLbl = el('span', { class: cls.lbl });
  u.dbMin = numInput(-120, -12, 1, 'out.taper', (v) => setOutput({ dbMin: v }));
  u.smoothLbl = el('span', { class: cls.lbl });
  u.smooth = numInput(5, 10, 0.5, 'out.fader', (v) => setOutput({ smoothMs: v }));
  u.meter = el('canvas', { class: 'w-40 sm:w-52 h-[22px] rounded border border-slate-800 bg-slate-950 block', data: { help: 'out.meter' } });
  u.soneLbl = el('span', { class: cls.lbl });
  u.soneVal = el('span', { class: 'min-w-[150px] text-[11px] font-mono tabular-nums text-amber-300 whitespace-nowrap', data: { help: 'out.sone' } });
  u.analyzer = el('button', { class: `${cls.btn} bg-slate-800 border border-slate-700 text-slate-200`, type: 'button', data: { help: 'out.sone' }, on: { click: () => setOutput({ analyzer: !cfg().analyzer }) } });
  u.expand = el('button', { class: `${cls.btn} bg-slate-800 border border-slate-700 text-slate-200`, type: 'button', data: { help: 'out.sone' }, on: { click: () => { expanded = !expanded; frameDirty = true; renderOutputPanel(new Set(['output'])); } } });

  u.bands = el('canvas', { class: 'w-full h-[150px] rounded border border-slate-800 bg-slate-950 block', data: { help: 'out.sone' } });
  u.calibLbl = el('span', { class: cls.lbl });
  u.calib = numInput(60, 130, 1, 'out.calib', (v) => setOutput({ fullScaleDbSpl: v }));
  u.calibUnit = el('span', { class: cls.lbl });
  u.legend = el('span', { class: 'text-[10px] text-slate-500' });
  u.lockInfo = el('span', { class: 'text-[10px] font-mono text-sky-300' });
  u.limiter = el('button', { class: `${cls.btn} bg-slate-800 border border-slate-700 text-slate-200`, type: 'button', 'aria-pressed': 'false', data: { help: 'out.limiter' }, on: { click: () => setOutput({ limiter: !cfg().limiter }) } });
  u.limGr = el('span', { class: 'min-w-[44px] text-[10px] font-mono tabular-nums text-rose-300', data: { help: 'out.limiter' } });
  u.limCeil = numInput(-12, 0, 0.5, 'out.limiter', (v) => setOutput({ limiterCeilDb: v }));
  u.limCeilLbl = el('span', { class: cls.lbl });
  u.limCeilWrap = el('span', { class: 'flex items-center gap-1' }, [u.limCeilLbl, u.limCeil]);
  u.panel = el('div', { class: 'hidden mt-1.5 flex flex-col gap-1' }, [
    u.bands,
    el('div', { class: 'flex flex-wrap items-center gap-2' }, [el('span', { class: 'flex items-center gap-1' }, [u.calibLbl, u.calib, u.calibUnit]), u.lockInfo, u.legend]),
  ]);

  const row = el('div', { class: 'flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 rounded-lg bg-slate-950/70 border border-slate-800' }, [
    u.title,
    el('div', { class: cls.seg }, [u.modeAmp, u.modeDb, u.modeSone]),
    u.fader,
    el('span', { class: 'flex items-center gap-0.5' }, [u.dbIn, u.dbUnit]),
    (u.taperSeg = el('div', { class: cls.seg, title: '' }, [u.taperA, u.taperB])),
    el('span', { class: 'flex items-center gap-1' }, [u.dbMinLbl, u.dbMin]),
    el('span', { class: 'flex items-center gap-1' }, [u.smoothLbl, u.smooth]),
    u.meter,
    el('span', { class: 'flex items-center gap-1' }, [u.soneLbl, u.soneVal]),
    u.analyzer,
    u.expand,
    u.limCeilWrap,
    u.limGr,
    u.limiter,
  ]);
  host.append(row);
  // The band view lives in the page body so the sticky header stays compact. / 대역 뷰는 본문에
  const bandsHost = document.getElementById('outputBandsHost');
  if (bandsHost) {
    u.panel.className = 'hidden flex flex-col gap-1 bg-slate-900/90 border border-slate-800 rounded-xl p-2';
    bandsHost.append(u.panel);
    u.bandsHost = bandsHost;
  } else host.append(u.panel);
  ui = u;
  onLoudnessFrame((f) => {
    soneHist[histPos] = f.totalSone;
    histPos = (histPos + 1) % HISTORY;
    frameDirty = true;
  });
  applyOutputConfig();
  renderOutputPanel(new Set(['all']));
  const loop = () => {
    rafId = requestAnimationFrame(loop);
    if (!document.hidden) drawMeters();
  };
  rafId = requestAnimationFrame(loop);
}

/** Sync controls with appState.output (and push config changes to the audio graph). */
export function renderOutputPanel(scopes) {
  if (!ui) return;
  const c = cfg();
  if (appState.output !== lastCfg) {
    if (lastCfg) applyOutputConfig(c); // e.g. project load / 불러오기 등 외부 변경
    lastCfg = appState.output;
  }
  if (!(scopes.has('all') || scopes.has('lang') || scopes.has('output') || scopes.has('view'))) return;
  ui.title.textContent = t('out.title');
  ui.modeSone.textContent = t('out.mode.sone');
  ui.modeAmp.textContent = t('out.mode.amp');
  paintSeg(ui.modeAmp, c.mode === 'amp', 'violet');
  paintSeg(ui.modeDb, c.mode === 'db');
  paintSeg(ui.modeSone, c.mode === 'sone', 'amber');
  paintSeg(ui.taperA, c.taper === 'linear', 'emerald');
  paintSeg(ui.taperB, c.taper === 'daw', 'emerald');
  ui.taperA.title = ui.taperB.title = t('out.taper.title');
  ui.fader.disabled = false;
  ui.fader.classList.remove('opacity-40');
  ui.fader.setAttribute('aria-label', c.mode === 'sone' ? 'Sone target' : 'Output fader');
  const isAmp = c.mode === 'amp';
  ui.fader.dataset.help = isAmp ? 'out.amp' : c.mode === 'sone' ? 'out.lock' : 'out.fader';
  ui.dbIn.dataset.help = ui.fader.dataset.help;
  ui.taperSeg.classList.toggle('hidden', isAmp || c.mode === 'sone');
  if (isAmp) {
    // Amp: fader = amplitude, box = amplitude, label = its dB equivalent / 진폭 모드
    ui.dbIn.min = '0';
    ui.dbIn.max = '1';
    ui.dbIn.step = '0.01';
    ui.dbIn.placeholder = '0';
    sync(ui.fader, c.ampLevel);
    sync(ui.dbIn, Math.round(c.ampLevel * 1000) / 1000);
    ui.dbUnit.textContent = `× (${formatDb(ampDb(c.ampLevel))} dB)`;
  } else if (c.mode === 'sone') {
    // Sone: slider = Loudness-Lock target (log), box = target in sone / Sone 모드: 목표 슬라이더
    ui.dbIn.min = String(TARGET_MIN);
    ui.dbIn.max = String(TARGET_MAX);
    ui.dbIn.step = '0.1';
    ui.dbIn.placeholder = String(TARGET_DEFAULT);
    ui.dbUnit.textContent = `sone ${t('out.target')}`;
    sync(ui.fader, targetToNorm(c.soneTarget));
    sync(ui.dbIn, roundTarget(c.soneTarget));
  } else {
    ui.dbIn.min = '-120';
    ui.dbIn.max = '12';
    ui.dbIn.step = '0.1';
    ui.dbIn.placeholder = '−∞';
    ui.dbUnit.textContent = 'dB';
    if (c.mode === 'db') {
      sync(ui.fader, c.faderNorm);
      const d = faderDb(c);
      sync(ui.dbIn, Number.isFinite(d) ? Math.round(d * 10) / 10 : '');
    }
  }
  ui.dbIn.disabled = false;
  ui.dbMinLbl.textContent = t('out.dbMin');
  sync(ui.dbMin, c.dbMin);
  ui.smoothLbl.textContent = t('out.smooth');
  sync(ui.smooth, c.smoothMs);
  ui.soneLbl.textContent = t('out.sone');
  ui.limiter.textContent = `${t('out.limiter')} ${c.limiter ? 'ON' : 'OFF'}`;
  ui.limiter.setAttribute('aria-pressed', c.limiter ? 'true' : 'false');
  ui.limiter.classList.toggle('bg-rose-600', c.limiter);
  ui.limiter.classList.toggle('text-white', c.limiter);
  ui.limCeilLbl.textContent = t('out.limiterCeil');
  sync(ui.limCeil, c.limiterCeilDb);
  ui.limCeilWrap.classList.toggle('hidden', !c.limiter);
  ui.analyzer.textContent = `${t('out.analyzer')} ${c.analyzer ? 'ON' : 'OFF'}`;
  ui.analyzer.classList.toggle('text-emerald-300', c.analyzer);
  ui.expand.textContent = `${t('out.expand')} ${expanded ? '▴' : '▾'}`;
  ui.panel.classList.toggle('hidden', !expanded);
  ui.bandsHost?.classList.toggle('hidden', !expanded);
  ui.calibLbl.textContent = t('out.calib');
  ui.calibUnit.textContent = t('out.calibUnit');
  sync(ui.calib, c.fullScaleDbSpl);
  ui.legend.textContent = t('out.legend');
  frameDirty = true;
}

function sizeCanvas(cv) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.max(10, cv.clientWidth);
  const h = Math.max(10, cv.clientHeight);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function drawMeters() {
  if (!ui || !frameDirty) return;
  frameDirty = false;
  const c = cfg();
  const f = getLoudnessFrame();
  const status = getLoudnessStatus();
  // ---- level meter (always dB-linear: −60 … 0 equally spaced) / 레벨 미터
  const meterTaper = createDbTaper({ dbMin: c.dbMin, dbMax: 0, mode: 'linear' });
  const { g, w, h } = sizeCanvas(ui.meter);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#020617';
  g.fillRect(0, 0, w, h);
  const peak = f ? f.peak : 0;
  const rms = f ? f.rms : 0;
  const now = performance.now();
  if (peak >= peakHold || now - peakHoldT > 1500) {
    peakHold = peak;
    peakHoldT = now;
  }
  const xp = meterTaper.meterNorm(peak) * w;
  const xr = meterTaper.meterNorm(rms) * w;
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#059669');
  grad.addColorStop(0.75, '#84cc16');
  grad.addColorStop(0.9, '#f59e0b');
  grad.addColorStop(1, '#ef4444');
  g.fillStyle = grad;
  g.globalAlpha = 0.45;
  g.fillRect(0, 3, xp, h - 12);
  g.globalAlpha = 1;
  g.fillRect(0, 6, xr, h - 18);
  const xh = meterTaper.meterNorm(peakHold) * w;
  if (xh > 0) {
    g.fillStyle = peakHold >= 1 ? '#ef4444' : '#e2e8f0';
    g.fillRect(Math.min(w - 2, xh), 2, 2, h - 10);
  }
  g.fillStyle = '#64748b';
  g.font = '8px ui-monospace, monospace';
  g.textBaseline = 'bottom';
  for (const tk of meterTaper.meterTicks(15)) {
    const x = tk.x * w;
    g.fillRect(Math.round(x), h - 8, 1, 3);
    g.textAlign = tk.x <= 0 ? 'left' : tk.x >= 1 ? 'right' : 'center';
    g.fillText(String(Math.round(tk.db)), x, h);
  }
  // ---- limiter gain reduction / 리미터 게인 감소
  const gr = getLimiterReductionDb();
  ui.limGr.textContent = c.limiter ? `${gr < -0.05 ? gr.toFixed(1) : '0.0'} dB` : '';
  // ---- Sone readout / Sone 수치
  if (f) {
    const ph = soneToPhonValue(f.totalSone);
    ui.soneVal.textContent = `${f.totalSone.toFixed(2)} sone · ${Number.isFinite(ph) && f.totalSone > 0.01 ? ph.toFixed(1) : '—'} phon`;
  } else {
    ui.soneVal.textContent = t(`out.status.${status === 'ready' ? 'idle' : status}`);
  }
  if (c.mode === 'sone') {
    const lockDb = getLockDb();
    ui.lockInfo.textContent = `${t('out.lockGain')}: ${formatDb(lockDb)} dB`;
  } else ui.lockInfo.textContent = '';
  if (expanded) drawBands(f, c);
}

function drawBands(f, c) {
  const { g, w, h } = sizeCanvas(ui.bands);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#020617';
  g.fillRect(0, 0, w, h);
  const padL = 30;
  const padR = 96;
  const padB = 14;
  const plotW = w - padL - padR;
  const plotH = h - padB - 6;
  const B = 24;
  const bw = plotW / B;
  const dbLo = 0;
  const dbHi = 110;
  const yDb = (db) => 6 + plotH * (1 - clamp((db - dbLo) / (dbHi - dbLo), 0, 1));
  g.font = '9px ui-monospace, monospace';
  g.fillStyle = '#475569';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  for (let db = 0; db <= dbHi; db += 20) {
    const y = yDb(db);
    g.fillRect(padL, y, plotW, 1);
    g.fillText(String(db), padL - 3, y);
  }
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  for (let b = 0; b < B; b += 3) {
    const fc = (BAND_EDGES[b] + BAND_EDGES[b + 1]) / 2;
    g.fillText(fc >= 1000 ? `${(fc / 1000).toFixed(1)}k` : `${Math.round(fc)}`, padL + (b + 0.5) * bw, h);
  }
  if (f) {
    let maxSpec = 0.05;
    for (let b = 0; b < B; b++) maxSpec = Math.max(maxSpec, f.specific[b]);
    for (let b = 0; b < B; b++) {
      const hh = (f.specific[b] / maxSpec) * plotH;
      g.fillStyle = 'rgba(245, 158, 11, 0.55)';
      g.fillRect(padL + b * bw + 1, 6 + plotH - hh, bw - 2, hh);
    }
    const line = (arr, color, dash) => {
      g.strokeStyle = color;
      g.setLineDash(dash);
      g.lineWidth = 1.5;
      g.beginPath();
      for (let b = 0; b < B; b++) {
        const x = padL + (b + 0.5) * bw;
        const y = yDb(arr[b]);
        if (b === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
    };
    line(f.excDb, '#38bdf8', []);
    line(f.maskDb, '#f472b6', [4, 3]);
  }
  // Total Sone history sparkline / Total Sone 기록
  const hx = w - padR + 8;
  const hw = padR - 12;
  g.strokeStyle = '#1e293b';
  g.strokeRect(hx, 6, hw, plotH);
  let maxS = Math.max(1, c.mode === 'sone' ? c.soneTarget * 1.5 : 0);
  for (let i = 0; i < HISTORY; i++) maxS = Math.max(maxS, soneHist[i]);
  g.strokeStyle = '#fbbf24';
  g.lineWidth = 1.2;
  g.beginPath();
  for (let i = 0; i < HISTORY; i++) {
    const v = soneHist[(histPos + i) % HISTORY];
    const x = hx + (i / (HISTORY - 1)) * hw;
    const y = 6 + plotH * (1 - v / maxS);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  if (c.mode === 'sone') {
    g.strokeStyle = '#38bdf8';
    g.setLineDash([3, 3]);
    const y = 6 + plotH * (1 - c.soneTarget / maxS);
    g.beginPath();
    g.moveTo(hx, y);
    g.lineTo(hx + hw, y);
    g.stroke();
    g.setLineDash([]);
  }
  g.fillStyle = '#94a3b8';
  g.textAlign = 'left';
  g.textBaseline = 'top';
  g.fillText(`${maxS.toFixed(1)} sone`, hx + 2, 7);
}

