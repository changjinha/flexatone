/**
 * Flexatone — ui/studio-video.js
 * Layer 4 (ui): "Export video" for every studio (button in the ③ Send & export box, ui/studio-monitors.js).
 *   - Monitors: every canvas the studio shows right now (main monitor, 2-D / 3-D views, timeline, lanes …) is
 *     listed; tick the ones to record.
 *   - Layout: each chosen monitor is a tile on the video frame. Presets (grid, focus, rows, columns), then move
 *     a tile by dragging it in the preview and resize it with its corner handle (or type x / y / w / h in %).
 *     Fit per tile: keep proportions (contain), fill (cover) or stretch.
 *   - States: view-only settings of the studio a studio registers here (registerVideoStates) — e.g. the Space
 *     Studio's source-name size, waves and views. They are applied while the dialog is open (the preview shows
 *     them) and put back when it closes. Plus overlays: monitor names, title, time code, borders, background.
 *   - Recording: the studio's own transport plays in real time; the frames are the live monitors composited
 *     into one canvas, the sound is the master output (post-limiter, what you hear). MediaRecorder → MP4 where
 *     the browser can, else WebM. Length = until playback ends, or a fixed number of seconds.
 *   - Progress: a percentage is always on screen while a video is made — in the dialog and in a floating badge
 *     (showVideoProgress, also used by the Manager's video export), which stays when the dialog is minimised.
 * 계층 4 (ui): 모든 스튜디오의 "동영상 내보내기". 지금 보이는 모니터(2D·3D 뷰, 타임라인 …)를 고르고, 미리보기에서
 * 끌어 배치·모서리로 크기 조절. 스튜디오가 등록한 보기 상태(스페이스: 이름 크기·파동·뷰)를 녹화용으로 바꿈(닫으면 복원).
 * 스튜디오 트랜스포트를 실시간 재생하며 모니터 합성 화면 + 마스터 출력을 녹화. 진행률(%)은 항상 표시 (떠 있는 배지 포함).
 */

import { t, I18N } from '../core/i18n.js';
import { appState, setTransport } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { StudioRegistry } from '../studios/registry.js';
import { ensureAudioCtx, triggerDownload } from '../audio/audio-engine.js';
import { getMasterOutput } from '../audio/output-bus.js';
import { studioNaturalSec } from '../audio/tempo-player.js';
import { activeTransport, stopAllAudio } from './studio-host.js';
import { HELP_DB, getHelp } from './option-inspector.js';
import { getProjectFileName } from './file-name-chip.js';
import { renderVideoOffline, offlineVideoAvailable, pickSaveTarget, saveBlob, applyOutputStage } from './video-encode.js';
import * as mixer from '../audio/manager-mixer.js';
import { awaitInstanceBuffer } from '../audio/instance-source.js';
import { renderSpaceBuffer } from '../studios/space/space-audio.js';
import { getSpaceParams, getSpaceDocTarget } from '../studios/space/space-doc.js';

Object.assign(I18N.en, {
  'svid.button': '🎬 Export video',
  'svid.buttonTip': 'Record the monitors of this studio (choose which, lay them out) with its sound as a video',
  'svid.title': 'Export video',
  'svid.sub': (name) => `${name} · monitors + sound → MP4`,
  'svid.monitors': 'Monitors',
  'svid.monitorsNone': 'This studio shows no monitor canvas right now.',
  'svid.mon.main': 'Main monitor',
  'svid.mon.gain': 'Gain envelope',
  'svid.layout': 'Layout',
  'svid.preset.grid': 'Grid',
  'svid.preset.focus': 'Focus',
  'svid.preset.rows': 'Rows',
  'svid.preset.cols': 'Columns',
  'svid.layoutHint': 'Drag a tile in the preview to move it, its corner to resize it. Click a tile to edit it below.',
  'svid.tile': 'Selected tile',
  'svid.tileNone': 'Click a tile in the preview.',
  'svid.fit': 'Fit',
  'svid.fit.contain': 'Keep proportions',
  'svid.fit.cover': 'Fill (crop)',
  'svid.fit.stretch': 'Stretch',
  'svid.front': 'Bring to front',
  'svid.gap': 'Gap (px)',
  'svid.states': 'States',
  'svid.statesNone': 'This studio has no view states to choose.',
  'svid.statesNote': 'Applied while this dialog is open; put back when it closes.',
  'svid.overlay': 'Overlays',
  'svid.ov.names': 'Monitor names',
  'svid.ov.title': 'Title (studio · file)',
  'svid.ov.time': 'Time code',
  'svid.ov.border': 'Tile borders',
  'svid.background': 'Background',
  'svid.bg.dark': 'Dark',
  'svid.bg.black': 'Black',
  'svid.bg.white': 'White',
  'svid.output': 'Output',
  'svid.size': 'Size',
  'svid.fps': 'Frame rate',
  'svid.format': 'Format',
  'svid.length': 'Length',
  'svid.len.play': 'Until playback ends',
  'svid.len.fixed': 'Fixed (s)',
  'svid.start': 'Start',
  'svid.start.cue': 'From the cue',
  'svid.start.zero': 'From 0',
  'svid.audio': 'Include sound',
  'svid.mode': 'Method',
  'svid.mode.render': 'Render (offline, every frame)',
  'svid.mode.live': 'Live recording (real time)',
  'svid.modeTip': 'Render: each frame is drawn for its own time and encoded (H.264 + AAC MP4); works in a background tab and never drops frames. Live: records the screen while the studio plays (the tab must stay in front).',
  'svid.master': 'Space Master: the sound is the Manager cycle (as tuned in the Manager), the views follow its time.',
  'svid.rAudio': 'Rendering the sound…',
  'svid.rFrames': (pct, i, n) => `Rendering ${pct}% · frame ${i} / ${n}`,
  'svid.rMux': 'Writing the file…',
  'svid.saved': (f, mb) => `Saved ${f} (${mb} MB) · 100%`,
  'svid.renderFail': (m) => `Render failed: ${m}`,
  'svid.record': 'Record',
  'svid.stop': 'Stop',
  'svid.minimize': 'Minimise',
  'svid.show': 'Show',
  'svid.cancel': 'Cancel',
  'svid.close': 'Close',
  'svid.note': (sec) => (sec > 0 ? `About ${sec.toFixed(1)} s; recording takes as long as the playback. The picture is the monitors at their on-screen resolution.` : 'Playback length unknown (endless studio): choose a fixed length.'),
  'svid.unsupported': 'This browser cannot record video (MediaRecorder / canvas capture missing).',
  'svid.noMonitor': 'Choose at least one monitor.',
  'svid.noAudio': 'Nothing plays in this studio — recording a silent video of the fixed length.',
  'svid.noAudioPlay': 'Nothing plays in this studio. Choose a fixed length to record the picture only.',
  'svid.preparing': 'Preparing…',
  'svid.recording': (pct, a, b) => `Recording ${pct}% · ${a} / ${b} s`,
  'svid.saving': 'Saving… 100%',
  'svid.done': (f, mb) => `Saved ${f} (${mb} MB) · 100%`,
  'svid.cancelled': 'Recording cancelled.',
  'svid.badge': (label, pct) => `🎬 ${label} ${pct}%`,
});
Object.assign(I18N.ko, {
  'svid.button': '🎬 동영상 내보내기',
  'svid.buttonTip': '이 스튜디오의 모니터를 (골라서 배치해) 소리와 함께 동영상으로 녹화',
  'svid.title': '동영상 내보내기',
  'svid.sub': (name) => `${name} · 모니터 + 소리 → MP4`,
  'svid.monitors': '모니터',
  'svid.monitorsNone': '지금 이 스튜디오에 보이는 모니터 캔버스가 없습니다.',
  'svid.mon.main': '주 모니터',
  'svid.mon.gain': '게인 엔벨로프',
  'svid.layout': '레이아웃',
  'svid.preset.grid': '격자',
  'svid.preset.focus': '주 화면 크게',
  'svid.preset.rows': '세로 쌓기',
  'svid.preset.cols': '가로 나란히',
  'svid.layoutHint': '미리보기에서 타일을 끌면 이동, 모서리를 끌면 크기 조절. 타일을 클릭하면 아래에서 편집.',
  'svid.tile': '선택한 타일',
  'svid.tileNone': '미리보기에서 타일을 클릭하세요.',
  'svid.fit': '맞춤',
  'svid.fit.contain': '비율 유지',
  'svid.fit.cover': '채우기 (잘림)',
  'svid.fit.stretch': '늘이기',
  'svid.front': '맨 앞으로',
  'svid.gap': '간격 (px)',
  'svid.states': '상태',
  'svid.statesNone': '이 스튜디오에는 고를 보기 상태가 없습니다.',
  'svid.statesNote': '이 창이 열려 있는 동안 적용되고, 닫으면 원래대로 돌아갑니다.',
  'svid.overlay': '오버레이',
  'svid.ov.names': '모니터 이름',
  'svid.ov.title': '제목 (스튜디오 · 파일)',
  'svid.ov.time': '타임코드',
  'svid.ov.border': '타일 테두리',
  'svid.background': '배경',
  'svid.bg.dark': '어둡게',
  'svid.bg.black': '검정',
  'svid.bg.white': '흰색',
  'svid.output': '출력',
  'svid.size': '크기',
  'svid.fps': '프레임 레이트',
  'svid.format': '형식',
  'svid.length': '길이',
  'svid.len.play': '재생이 끝날 때까지',
  'svid.len.fixed': '고정 (초)',
  'svid.start': '시작',
  'svid.start.cue': '큐에서',
  'svid.start.zero': '0초부터',
  'svid.audio': '소리 포함',
  'svid.mode': '방식',
  'svid.mode.render': '렌더 (오프라인, 모든 프레임)',
  'svid.mode.live': '실시간 녹화',
  'svid.modeTip': '렌더: 프레임마다 그 시각의 화면을 그려 인코딩합니다 (H.264 + AAC MP4). 백그라운드 탭에서도 되고 프레임이 빠지지 않습니다. 실시간: 스튜디오를 재생하며 화면을 녹화합니다 (탭이 앞에 있어야 함).',
  'svid.master': '스페이스 마스터: 소리는 매니저 사이클(매니저에서 조율한 그대로), 뷰는 그 시간을 따라갑니다.',
  'svid.rAudio': '소리 렌더링 중…',
  'svid.rFrames': (pct, i, n) => `렌더링 ${pct}% · 프레임 ${i} / ${n}`,
  'svid.rMux': '파일 쓰는 중…',
  'svid.saved': (f, mb) => `${f} 저장 (${mb} MB) · 100%`,
  'svid.renderFail': (m) => `렌더 실패: ${m}`,
  'svid.record': '녹화',
  'svid.stop': '정지',
  'svid.minimize': '최소화',
  'svid.show': '보기',
  'svid.cancel': '취소',
  'svid.close': '닫기',
  'svid.note': (sec) => (sec > 0 ? `약 ${sec.toFixed(1)}초. 재생 시간만큼 녹화됩니다. 화면은 모니터의 화면 해상도 그대로입니다.` : '재생 길이를 알 수 없습니다(끝없는 스튜디오): 고정 길이를 고르세요.'),
  'svid.unsupported': '이 브라우저는 동영상을 녹화할 수 없습니다 (MediaRecorder / 캔버스 캡처 없음).',
  'svid.noMonitor': '모니터를 하나 이상 고르세요.',
  'svid.noAudio': '이 스튜디오에서 재생되는 소리가 없습니다 — 고정 길이의 무음 동영상을 녹화합니다.',
  'svid.noAudioPlay': '이 스튜디오에서 재생되는 소리가 없습니다. 화면만 녹화하려면 고정 길이를 고르세요.',
  'svid.preparing': '준비 중…',
  'svid.recording': (pct, a, b) => `녹화 중 ${pct}% · ${a} / ${b}초`,
  'svid.saving': '저장 중… 100%',
  'svid.done': (f, mb) => `${f} 저장 (${mb} MB) · 100%`,
  'svid.cancelled': '녹화를 취소했습니다.',
  'svid.badge': (label, pct) => `🎬 ${label} ${pct}%`,
});
HELP_DB['app.studioVideo'] = {
  en: { title: 'Export video', summary: 'Records this studio as a video: the monitors you choose, laid out freely on the frame, with the sound you hear.', detail: 'Tick monitors (2-D and 3-D views, timeline, lanes …), pick a layout preset, then drag tiles in the preview to move them and their corner to resize. States are view-only settings of the studio (Space: name size, waves, views) used for the recording and put back afterwards. Recording plays the studio in real time (until the playback ends or for a fixed time); the progress in % is shown in the dialog and in a floating badge. The picture has the on-screen resolution of each monitor.', formula: '' },
  ko: { title: '동영상 내보내기', summary: '이 스튜디오를 동영상으로 녹화합니다: 고른 모니터를 화면에 자유롭게 배치하고, 들리는 소리를 함께 담습니다.', detail: '모니터(2D·3D 뷰, 타임라인, 레인 …)를 체크하고 레이아웃 프리셋을 고른 뒤, 미리보기에서 타일을 끌어 옮기고 모서리를 끌어 크기를 바꿉니다. 상태는 스튜디오의 보기 전용 설정(스페이스: 이름 크기·파동·뷰)으로, 녹화에 쓰이고 끝나면 원래대로 돌아갑니다. 녹화는 스튜디오를 실시간 재생합니다(재생이 끝날 때까지 또는 고정 시간). 진행률(%)은 창과 떠 있는 배지에 표시됩니다. 화면은 각 모니터의 화면 해상도 그대로입니다.', formula: '' },
};

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
const BG = { dark: { bg: '#020617', tile: '#0b1222', text: '#e2e8f0', sub: '#94a3b8', line: '#334155' }, black: { bg: '#000000', tile: '#000000', text: '#f8fafc', sub: '#a3a3a3', line: '#262626' }, white: { bg: '#f8fafc', tile: '#ffffff', text: '#0f172a', sub: '#475569', line: '#cbd5e1' } };

// ==========================================================================
// Studio view states (registered by studios) / 스튜디오 보기 상태 (스튜디오가 등록)
// ==========================================================================

const STATE_REG = new Map(); // studio → () => StateDef[]

/**
 * A studio offers view-only states for its video. `defs()` returns
 * [{ id, label, type: 'range'|'toggle'|'select', min, max, step, options: [[value, label]], get(), set(v) }].
 * 스튜디오가 동영상용 보기 상태를 등록.
 */
export function registerVideoStates(studio, defs) {
  STATE_REG.set(studio, defs);
}

// ==========================================================================
// Progress badge (shared with the Manager's video export) / 진행률 배지 (매니저 동영상과 공용)
// ==========================================================================

let badge = null;

/**
 * Show / update the floating progress badge. frac 0…1 (shown as a whole %). / 떠 있는 진행률 배지
 * @param {{ label?: string, frac: number, text?: string, onStop?: Function, onShow?: Function, icon?: string }} p
 */
export function showVideoProgress({ label = t('svid.title'), frac = 0, text = '', onStop = null, onShow = null, icon = '🎬' }) {
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'fx-vid-badge';
    badge.setAttribute('role', 'status');
    badge.setAttribute('aria-live', 'polite');
    badge.innerHTML = '<div class="fx-vid-badge-row"><b data-b="pct"></b><span data-b="text"></span><button type="button" data-b="show"></button><button type="button" data-b="stop"></button></div><div class="fx-vid-badge-bar"><span></span></div>';
    badge.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-b]');
      if (b?.dataset.b === 'stop') badge._onStop?.();
      if (b?.dataset.b === 'show') badge._onShow?.();
    });
    document.body.appendChild(badge);
  }
  const pct = Math.floor(clamp(frac, 0, 1) * 100);
  badge.querySelector('[data-b="pct"]').textContent = `${icon} ${label} ${pct}%`;
  badge.querySelector('[data-b="text"]').textContent = text;
  badge.querySelector('.fx-vid-badge-bar span').style.width = `${pct}%`;
  const stop = badge.querySelector('[data-b="stop"]');
  stop.textContent = `■ ${t('svid.stop')}`;
  stop.hidden = !onStop;
  const show = badge.querySelector('[data-b="show"]');
  show.textContent = t('svid.show');
  show.hidden = !onShow;
  badge._onStop = onStop;
  badge._onShow = onShow;
}

/** Remove the badge (after a short moment showing 100 %). / 배지 제거 */
export function hideVideoProgress(delayMs = 0) {
  const b = badge;
  if (!b) return;
  badge = null;
  if (delayMs > 0) setTimeout(() => b.remove(), delayMs);
  else b.remove();
}

// ==========================================================================
// Options (kept for the session, per studio for monitors / layout) / 옵션
// ==========================================================================

const opts = {
  size: '1080p',
  fps: 30,
  format: null,
  length: 'play',
  fixedSec: 10,
  start: 'cue',
  audio: true,
  theme: 'dark',
  gap: 8,
  ov: { names: true, title: false, time: false, border: true },
  mode: null, // 'render' (offline, frame-exact; default where WebCodecs exists) | 'live' (real-time recording) / 렌더 방식
};
const perStudio = new Map(); // studio → { tiles: [{ key, x, y, w, h, fit }], preset }

let dlg = null;
let studio = null;
let monitors = []; // [{ key, name, canvas }]
let lastScan = 0;
let selKey = null;
let drag = null;
let raf = null;
let job = null;
let savedStates = null; // [{ def, value }] to put back / 복원용

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sizeOf = () => SIZES.find((z) => z.id === opts.size) || SIZES[1];
const layoutOf = () => { if (!perStudio.has(studio)) perStudio.set(studio, { tiles: null, preset: 'grid' }); return perStudio.get(studio); };
const studioName = (id) => { const p = StudioRegistry.get(id); return p?.name?.[appState.lang] || p?.name?.en || id; };

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

// ==========================================================================
// Monitor discovery / 모니터 찾기
// ==========================================================================

function visible(cv) {
  if (!cv.isConnected || !cv.width || !cv.height) return false;
  const r = cv.getBoundingClientRect();
  if (r.width < 60 || r.height < 30) return false;
  return !!(cv.offsetParent || getComputedStyle(cv).position === 'fixed');
}

const ID_NAMES = { mainCanvas: 'svid.mon.main', gainCanvas: 'svid.mon.gain' };

function monitorName(cv, rack) {
  const vn = cv.dataset.videoName || ID_NAMES[cv.id];
  if (vn) return t(vn);
  const help = cv.dataset.help || cv.closest('[data-help]')?.dataset.help;
  const h = help && getHelp(help);
  if (h?.title) return h.title;
  const head = rack?.querySelector('h2, h3, .uppercase');
  const txt = head?.textContent?.trim();
  return txt ? txt.slice(0, 40) : (cv.id || 'Monitor');
}

/** Canvases of the studio on screen, with a stable key and a name. / 화면의 스튜디오 캔버스 */
function scanMonitors(force = false) {
  const now = performance.now();
  if (!force && now - lastScan < 400) return monitors;
  lastScan = now;
  const all = [...document.querySelectorAll('canvas')].filter((cv) => !cv.closest('header, #managerPanel, .mgr-vid-backdrop, .fx-vid-backdrop, .fx-vid-badge, [role="dialog"]') && visible(cv));
  const counts = new Map();
  const out = [];
  for (const cv of all) {
    const rack = cv.closest('[data-rack]');
    const base = `${rack?.dataset.rack || cv.id || 'canvas'}|${cv.dataset.videoName || cv.dataset.help || ''}`;
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    out.push({ key: `${base}#${n}`, name: monitorName(cv, rack), canvas: cv, area: cv.width * cv.height, monitor: !!cv.closest('[data-window="1"], [data-monitor]') });
  }
  // same names → numbered / 같은 이름은 번호
  const byName = new Map();
  for (const m of out) byName.set(m.name, (byName.get(m.name) || 0) + 1);
  const seen = new Map();
  for (const m of out) if (byName.get(m.name) > 1) { const k = (seen.get(m.name) || 0) + 1; seen.set(m.name, k); m.name = `${m.name} ${k}`; }
  monitors = out;
  return out;
}

const canvasOf = (key) => monitors.find((m) => m.key === key)?.canvas || null;

// ==========================================================================
// Layout / 레이아웃
// ==========================================================================

function presetTiles(keys, preset) {
  const n = keys.length;
  if (!n) return [];
  const tile = (key, x, y, w, h) => ({ key, x, y, w, h, fit: 'contain' });
  if (preset === 'rows') return keys.map((k, i) => tile(k, 0, i / n, 1, 1 / n));
  if (preset === 'cols') return keys.map((k, i) => tile(k, i / n, 0, 1 / n, 1));
  if (preset === 'focus' && n > 1) {
    const rest = keys.slice(1);
    const { w, h } = sizeOf();
    if (w >= h) return [tile(keys[0], 0, 0, 0.7, 1), ...rest.map((k, i) => tile(k, 0.7, i / rest.length, 0.3, 1 / rest.length))];
    return [tile(keys[0], 0, 0, 1, 0.7), ...rest.map((k, i) => tile(k, i / rest.length, 0.7, 1 / rest.length, 0.3))];
  }
  const { w, h } = sizeOf();
  let cols = Math.ceil(Math.sqrt(n * (w / h) / 1.6));
  cols = clamp(cols, 1, n);
  const rows = Math.ceil(n / cols);
  return keys.map((k, i) => tile(k, (i % cols) / cols, Math.floor(i / cols) / rows, 1 / cols, 1 / rows));
}

/** Tiles of the studio; first open: the monitors (largest first) in a grid. / 타일 (처음엔 모니터 격자) */
function tiles() {
  const L = layoutOf();
  if (!L.tiles) {
    const list = scanMonitors(true);
    // the largest canvas is the main monitor (as in ui/rack-layout.js), then the other monitors / 가장 큰 캔버스 = 주 모니터
    const bySize = list.slice().sort((a, b) => b.area - a.area);
    const keys = bySize.filter((m, i) => i === 0 || m.monitor).map((m) => m.key);
    L.tiles = presetTiles(keys.slice(0, 4), keys.length > 1 ? 'focus' : 'grid');
    L.preset = keys.length > 1 ? 'focus' : 'grid';
  }
  return L.tiles;
}

function applyPreset(preset) {
  const L = layoutOf();
  const keys = tiles().map((x) => x.key);
  const fits = new Map(tiles().map((x) => [x.key, x.fit]));
  L.tiles = presetTiles(keys, preset).map((x) => ({ ...x, fit: fits.get(x.key) || 'contain' }));
  L.preset = preset;
}

function toggleMonitor(key, on) {
  const L = layoutOf();
  const keys = tiles().map((x) => x.key).filter((k) => k !== key);
  if (on) keys.push(key);
  const fits = new Map(tiles().map((x) => [x.key, x.fit]));
  L.tiles = presetTiles(keys, L.preset || 'grid').map((x) => ({ ...x, fit: fits.get(x.key) || 'contain' }));
  if (!on && selKey === key) selKey = null;
}

// ==========================================================================
// Frame / 프레임
// ==========================================================================

function fitRect(sw, sh, dx, dy, dw, dh, fit) {
  if (fit === 'stretch') return { sx: 0, sy: 0, sw, sh, dx, dy, dw, dh };
  const sa = sw / sh;
  const da = dw / dh;
  if (fit === 'cover') {
    if (sa > da) { const w = sh * da; return { sx: (sw - w) / 2, sy: 0, sw: w, sh, dx, dy, dw, dh }; }
    const h = sw / da;
    return { sx: 0, sy: (sh - h) / 2, sw, sh: h, dx, dy, dw, dh };
  }
  if (sa > da) { const h = dw / sa; return { sx: 0, sy: 0, sw, sh, dx, dy: dy + (dh - h) / 2, dw, dh: h }; }
  const w = dh * sa;
  return { sx: 0, sy: 0, sw, sh, dx: dx + (dw - w) / 2, dy, dw: w, dh };
}

const tileBox = (tl, W, H, gap) => {
  const g = gap / 2;
  return { x: tl.x * W + g, y: tl.y * H + g, w: Math.max(4, tl.w * W - gap), h: Math.max(4, tl.h * H - gap) };
};

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/** One frame: tiles of live monitors + overlays. preview = editing marks. / 프레임 한 장 */
function drawFrame(ctx, W, H, { preview = false, timeSec = null } = {}) {
  const th = BG[opts.theme] || BG.dark;
  const k = Math.max(1, Math.min(W, H) / 540);
  const gap = opts.gap * k;
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, W, H);
  let top = 0;
  if (opts.ov.title) {
    top = Math.round(34 * k);
    ctx.fillStyle = th.text;
    ctx.font = `600 ${Math.round(16 * k)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const file = getProjectFileName();
    ctx.fillText(`Flexatone · ${studioName(studio)}${file ? ` · ${file}` : ''}`, 12 * k, top / 2);
    ctx.textBaseline = 'alphabetic';
  }
  const Hh = H - top;
  for (const tl of tiles()) {
    const b = tileBox(tl, W, Hh, gap);
    b.y += top;
    ctx.fillStyle = th.tile;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    const cv = canvasOf(tl.key);
    if (cv && cv.width && cv.height) {
      const r = fitRect(cv.width, cv.height, b.x, b.y, b.w, b.h, tl.fit);
      ctx.save();
      ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.clip();
      try { ctx.drawImage(cv, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh); } catch { /* canvas being resized */ }
      ctx.restore();
    }
    if (opts.ov.border) { ctx.strokeStyle = th.line; ctx.lineWidth = Math.max(1, k); ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1); }
    if (opts.ov.names) {
      const name = monitors.find((m) => m.key === tl.key)?.name || '';
      ctx.font = `${Math.round(11 * k)}px ui-monospace, Menlo, monospace`;
      const tw = ctx.measureText(name).width;
      ctx.fillStyle = 'rgba(2,6,23,.7)';
      ctx.fillRect(b.x + 4 * k, b.y + 4 * k, tw + 10 * k, 17 * k);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(name, b.x + 9 * k, b.y + 16.5 * k);
    }
    if (preview) {
      const on = tl.key === selKey;
      ctx.strokeStyle = on ? '#38bdf8' : 'rgba(56,189,248,.35)';
      ctx.lineWidth = (on ? 3 : 1.5) * k;
      ctx.setLineDash(on ? [] : [6 * k, 5 * k]);
      ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
      ctx.setLineDash([]);
      const hs = 14 * k;
      ctx.fillStyle = on ? '#38bdf8' : 'rgba(56,189,248,.55)';
      ctx.beginPath(); ctx.moveTo(b.x + b.w, b.y + b.h - hs); ctx.lineTo(b.x + b.w, b.y + b.h); ctx.lineTo(b.x + b.w - hs, b.y + b.h); ctx.closePath(); ctx.fill();
    }
  }
  if (!tiles().length) {
    ctx.fillStyle = th.sub;
    ctx.font = `${Math.round(14 * k)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(t('svid.noMonitor'), 20 * k, H / 2);
  }
  if (opts.ov.time) {
    const sec = timeSec ?? Math.max(0, Number(appState.transport.playheadSec) >= 0 ? Number(appState.transport.playheadSec) : Number(appState.transport.cueSec) || 0);
    const s = fmtTime(sec);
    ctx.font = `600 ${Math.round(14 * k)}px ui-monospace, Menlo, monospace`;
    const tw = ctx.measureText(s).width;
    ctx.fillStyle = 'rgba(2,6,23,.75)';
    ctx.fillRect(W - tw - 22 * k, H - 30 * k, tw + 14 * k, 22 * k);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(s, W - tw - 15 * k, H - 14 * k);
  }
}

// ==========================================================================
// Dialog / 대화상자
// ==========================================================================

/** Open the studio's Export video dialog. / 동영상 내보내기 열기 */
export function openStudioVideoDialog({ hooks } = {}) {
  if (dlg) { dlg.classList.remove('is-min'); dlg.focus(); return; }
  const formats = supportedFormats();
  if (!offlineVideoAvailable() && (!formats.length || !HTMLCanvasElement.prototype.captureStream)) { hooks?.showToast?.(t('svid.unsupported'), 'error'); return; }
  if (formats.length && (!opts.format || !formats.some((f) => f.id === opts.format))) opts.format = formats[0].id;
  if (!opts.mode || (opts.mode === 'render' && !offlineVideoAvailable())) opts.mode = offlineVideoAvailable() ? 'render' : 'live';
  studio = StudioRegistry.resolveStudioId();
  selKey = null;
  scanMonitors(true);
  const L = layoutOf();
  if (L.tiles && !L.tiles.some((x) => canvasOf(x.key))) L.tiles = null; // none of the saved tiles is on screen: start again / 저장된 타일이 화면에 없으면 새로
  tiles();
  captureStates();
  dlg = document.createElement('div');
  dlg.className = 'mgr-vid-backdrop fx-vid-backdrop';
  dlg.tabIndex = -1;
  dlg.innerHTML = `
    <div class="mgr-vid fx-svid" role="dialog" aria-label="${esc(t('svid.title'))}">
      <div class="mgr-vid-head"><b>${esc(t('svid.button'))}</b><span class="mgr-muted">${esc(t('svid.sub', studioName(studio)))}</span><span style="flex:1"></span><button class="mgr-btn" data-v="close">✕</button></div>
      <div class="mgr-vid-body">
        <div class="fx-svid-left">
          <div class="mgr-vid-preview"><canvas id="svidCanvas"></canvas></div>
          <div class="mgr-muted fx-svid-hint">${esc(t('svid.layoutHint'))}</div>
        </div>
        <div class="mgr-vid-opts" id="svidOpts"></div>
      </div>
      <div class="mgr-vid-foot">
        <div class="mgr-vid-progress"><span id="svidBar"></span></div>
        <b class="mgr-mono" id="svidPct">0%</b>
        <span class="mgr-mono mgr-muted" id="svidStatus"></span>
        <span style="flex:1"></span>
        <button class="mgr-btn" data-v="min" hidden>▾ ${esc(t('svid.minimize'))}</button>
        <button class="mgr-btn" data-v="cancel">${esc(t('svid.close'))}</button>
        <button class="mgr-btn play" data-v="record">● ${esc(t('svid.record'))}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('change', onChange);
  dlg.addEventListener('input', onInput);
  dlg.addEventListener('click', (e) => onClick(e, hooks));
  dlg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && !job) close(); });
  const cv = dlg.querySelector('#svidCanvas');
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp);
  cv.addEventListener('pointercancel', onUp);
  renderOpts();
  dlg.focus();
  previewLoop();
}

function close() {
  if (job) return;
  cancelAnimationFrame(raf);
  raf = null;
  restoreStates();
  dlg?.remove();
  dlg = null;
}

function stateDefs() {
  try { return STATE_REG.get(studio)?.() || []; } catch (err) { console.error('[Flexatone] video states:', err); return []; }
}

/** Remember the studio's view states to put back on close. / 닫을 때 복원할 상태 기억 */
function captureStates() {
  const defs = stateDefs();
  savedStates = defs.map((def) => ({ id: def.id, value: def.get() }));
  // States with a video default (e.g. Space emphasis) start at it — or at the last choice made here
  // 동영상 기본값이 있는 상태는 그 값(또는 여기서 마지막으로 고른 값)으로 시작
  for (const def of defs) {
    if (!('videoDefault' in def)) continue;
    const k = `${studio}:${def.id}`;
    const v = lastVideoState.has(k) ? lastVideoState.get(k) : def.videoDefault;
    try { if (def.get() !== v) def.set(v); } catch (err) { console.error(err); }
  }
}
const lastVideoState = new Map(); // `${studio}:${id}` → value chosen in the dialog / 대화상자에서 고른 값

function restoreStates() {
  if (!savedStates) return;
  const defs = stateDefs();
  for (const s of savedStates) {
    const def = defs.find((d) => d.id === s.id);
    try { if (def && def.get() !== s.value) def.set(s.value); } catch (err) { console.error(err); }
  }
  savedStates = null;
}

function renderOpts() {
  const box = dlg?.querySelector('#svidOpts');
  if (!box) return;
  const list = scanMonitors(true);
  const chosen = new Set(tiles().map((x) => x.key));
  const L = layoutOf();
  const sel = tiles().find((x) => x.key === selKey);
  const pct = (v) => Math.round(v * 1000) / 10;
  const defs = stateDefs();
  const stateRow = (d) => {
    const v = d.get();
    if (d.type === 'range') return `<label title="${esc(d.help || '')}">${esc(d.label)} <span class="fx-svid-range"><input type="range" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}" data-st="${d.id}"><span class="mgr-mono" data-stv="${d.id}">${d.fmt ? esc(d.fmt(v)) : v}</span></span></label>`;
    // a sub-option (parent) is indented and off while its parent is off / 하위 옵션은 들여쓰고 상위가 꺼지면 비활성
    const par = d.parent ? defs.find((x) => x.id === d.parent) : null;
    const dis = par && !par.get();
    if (d.type === 'toggle') return `<label title="${esc(d.help || '')}"${par ? ` style="margin-left:18px;${dis ? 'opacity:.45' : ''}"` : ''}><input type="checkbox" data-st="${d.id}" ${v ? 'checked' : ''} ${dis ? 'disabled data-off="1"' : ''}> ${esc(d.label)}</label>`;
    return `<label title="${esc(d.help || '')}">${esc(d.label)} <select data-st="${d.id}">${d.options.map(([o, lab]) => `<option value="${esc(o)}" ${String(v) === String(o) ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select></label>`;
  };
  const formats = supportedFormats();
  box.innerHTML = `
    <fieldset><legend>${esc(t('svid.monitors'))}</legend>
      ${list.length ? list.map((m) => `<label class="fx-svid-mon"><input type="checkbox" data-mon="${esc(m.key)}" ${chosen.has(m.key) ? 'checked' : ''}> <span>${esc(m.name)}</span><span class="mgr-muted mgr-mono">${m.canvas.width}×${m.canvas.height}</span></label>`).join('') : `<div class="mgr-muted">${esc(t('svid.monitorsNone'))}</div>`}
    </fieldset>
    <fieldset><legend>${esc(t('svid.layout'))}</legend>
      <div class="mgr-vid-row" style="flex-wrap:wrap">${['grid', 'focus', 'rows', 'cols'].map((p) => `<button class="mgr-btn tiny ${L.preset === p ? 'on' : ''}" data-preset="${p}">${esc(t(`svid.preset.${p}`))}</button>`).join('')}</div>
      <label>${esc(t('svid.gap'))} <input type="number" min="0" max="60" step="1" value="${opts.gap}" data-o="gap" style="width:56px"></label>
      <div class="fx-svid-tile">
        <div class="mgr-muted">${esc(t('svid.tile'))}: ${sel ? `<b style="color:#e2e8f0">${esc(monitors.find((m) => m.key === sel.key)?.name || '')}</b>` : esc(t('svid.tileNone'))}</div>
        ${sel ? `<div class="fx-svid-xywh">${['x', 'y', 'w', 'h'].map((k) => `<label>${k} % <input type="number" min="${k === 'w' || k === 'h' ? 2 : 0}" max="100" step="0.5" value="${pct(sel[k])}" data-tile="${k}" style="width:58px"></label>`).join('')}</div>
        <label>${esc(t('svid.fit'))} <select data-tile="fit">${['contain', 'cover', 'stretch'].map((f) => `<option value="${f}" ${sel.fit === f ? 'selected' : ''}>${esc(t(`svid.fit.${f}`))}</option>`).join('')}</select></label>
        <div class="mgr-vid-row"><button class="mgr-btn tiny" data-v="front">${esc(t('svid.front'))}</button></div>` : ''}
      </div>
    </fieldset>
    <fieldset><legend>${esc(t('svid.states'))}</legend>
      ${defs.length ? defs.map(stateRow).join('') + `<div class="mgr-muted">${esc(t('svid.statesNote'))}</div>` : `<div class="mgr-muted">${esc(t('svid.statesNone'))}</div>`}
    </fieldset>
    <fieldset><legend>${esc(t('svid.overlay'))}</legend>
      ${['names', 'title', 'time', 'border'].map((k) => `<label><input type="checkbox" data-ov="${k}" ${opts.ov[k] ? 'checked' : ''}> ${esc(t(`svid.ov.${k}`))}</label>`).join('')}
      <label>${esc(t('svid.background'))} <select data-o="theme">${['dark', 'black', 'white'].map((k) => `<option value="${k}" ${opts.theme === k ? 'selected' : ''}>${esc(t(`svid.bg.${k}`))}</option>`).join('')}</select></label>
    </fieldset>
    <fieldset><legend>${esc(t('svid.output'))}</legend>
      <label>${esc(t('svid.size'))} <select data-o="size">${SIZES.map((z) => `<option value="${z.id}" ${opts.size === z.id ? 'selected' : ''}>${z.w} × ${z.h}</option>`).join('')}</select></label>
      <label>${esc(t('svid.fps'))} <select data-o="fps">${[24, 30, 60].map((k) => `<option value="${k}" ${opts.fps === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>${esc(t('svid.format'))} <select data-o="format">${formats.map((f) => `<option value="${f.id}" ${opts.format === f.id ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></label>
      <label>${esc(t('svid.length'))} <select data-o="length">${['play', 'fixed'].map((k) => `<option value="${k}" ${opts.length === k ? 'selected' : ''}>${esc(t(`svid.len.${k}`))}</option>`).join('')}</select></label>
      ${opts.length === 'fixed' ? `<label>${esc(t('svid.len.fixed'))} <input type="number" min="1" max="1800" step="1" value="${opts.fixedSec}" data-o="fixedSec" style="width:64px"></label>` : ''}
      <label>${esc(t('svid.start'))} <select data-o="start">${['cue', 'zero'].map((k) => `<option value="${k}" ${opts.start === k ? 'selected' : ''}>${esc(t(`svid.start.${k}`))}</option>`).join('')}</select></label>
      <label title="${esc(t('svid.modeTip'))}">${esc(t('svid.mode'))} <select data-o="mode">${(offlineVideoAvailable() ? ['render', 'live'] : ['live']).map((k) => `<option value="${k}" ${opts.mode === k ? 'selected' : ''}>${esc(t(`svid.mode.${k}`))}</option>`).join('')}</select></label>
      <label><input type="checkbox" data-o="audio" ${opts.audio ? 'checked' : ''}> ${esc(t('svid.audio'))}</label>
      ${masterMode() ? `<div class="mgr-muted">${esc(t('svid.master'))}</div>` : ''}
    </fieldset>
    <div class="mgr-muted mgr-vid-note">${esc(t('svid.note', expectedSec()))}</div>`;
  setBusy(!!job);
}

/** Expected length (s) of a recording with the current options. / 예상 길이 */
function expectedSec() {
  if (opts.length === 'fixed') return opts.fixedSec;
  if (masterMode()) return mixer.cycleLength();
  let nat = 0;
  try { nat = studioNaturalSec(studio) || 0; } catch { nat = 0; }
  if (!(nat > 0)) {
    const tp = activeTransport();
    const p = tp.pass?.();
    if (p) nat = p.endSec;
  }
  if (!(nat > 0)) return 0;
  const from = opts.start === 'zero' ? 0 : Math.max(0, Number(appState.transport.cueSec) || 0);
  return Math.max(0, (from >= nat - 0.05 ? nat : nat - from));
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.st && el.type === 'range') {
    const def = stateDefs().find((d) => d.id === el.dataset.st);
    if (!def) return;
    def.set(Number(el.value));
    if ('videoDefault' in def) lastVideoState.set(`${studio}:${def.id}`, def.get());
    const out = dlg.querySelector(`[data-stv="${CSS.escape(def.id)}"]`);
    if (out) out.textContent = def.fmt ? def.fmt(Number(el.value)) : el.value;
  }
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.mon) { toggleMonitor(el.dataset.mon, el.checked); renderOpts(); return; }
  if (el.dataset.st) {
    const def = stateDefs().find((d) => d.id === el.dataset.st);
    if (!def) return;
    if (def.type === 'toggle') def.set(el.checked);
    else if (def.type === 'select') def.set(el.value);
    else def.set(Number(el.value));
    if ('videoDefault' in def) lastVideoState.set(`${studio}:${def.id}`, def.get());
    if (stateDefs().some((d) => d.parent === def.id)) renderOpts(); // sub-options follow / 하위 옵션 갱신
    if (def.relayout) setTimeout(() => { scanMonitors(true); renderOpts(); }, 120); // monitors may have been rebuilt / 모니터가 다시 만들어졌을 수 있음
    return;
  }
  if (el.dataset.ov) { opts.ov[el.dataset.ov] = el.checked; return; }
  if (el.dataset.tile) {
    const tl = tiles().find((x) => x.key === selKey);
    if (!tl) return;
    const k = el.dataset.tile;
    if (k === 'fit') tl.fit = el.value;
    else {
      const v = clamp((Number(el.value) || 0) / 100, k === 'w' || k === 'h' ? 0.02 : 0, 1);
      tl[k] = v;
      tl.w = Math.min(tl.w, 1 - tl.x);
      tl.h = Math.min(tl.h, 1 - tl.y);
    }
    return;
  }
  const k = el.dataset.o;
  if (!k) return;
  if (k === 'audio') opts.audio = el.checked;
  else if (k === 'fps' || k === 'gap') opts[k] = clamp(Number(el.value) || 0, 0, 120);
  else if (k === 'fixedSec') opts.fixedSec = clamp(Math.round(Number(el.value) || 10), 1, 1800);
  else opts[k] = el.value;
  if (k === 'size' || k === 'length' || k === 'start' || k === 'mode') renderOpts();
  else { const n = dlg.querySelector('.mgr-vid-note'); if (n) n.textContent = t('svid.note', expectedSec()); }
}

async function onClick(e, hooks) {
  const el = e.target.closest('[data-v], [data-preset]');
  if (!el && e.target === dlg && !job) { close(); return; }
  if (!el) return;
  if (el.dataset.preset) { applyPreset(el.dataset.preset); renderOpts(); return; }
  switch (el.dataset.v) {
    case 'close': if (!job) close(); else dlg.classList.add('is-min'); break;
    case 'cancel': if (job) stopJob(true); else close(); break;
    case 'min': dlg.classList.add('is-min'); break;
    case 'front': {
      const L = layoutOf();
      const i = L.tiles.findIndex((x) => x.key === selKey);
      if (i >= 0) L.tiles.push(L.tiles.splice(i, 1)[0]);
      break;
    }
    case 'record': if (!job) await record(hooks); else stopJob(false); break;
    default: break;
  }
}

// ---- preview + layout editing / 미리보기 + 레이아웃 편집

function previewLoop() {
  cancelAnimationFrame(raf);
  const step = () => {
    if (!dlg) return;
    if (!job) {
      scanMonitors();
      const c = dlg.querySelector('#svidCanvas');
      const { w, h } = sizeOf();
      const k = Math.min(1, 960 / Math.max(w, h));
      const cw = Math.round(w * k);
      const ch = Math.round(h * k);
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      const ctx = c.getContext('2d');
      ctx.save();
      ctx.scale(k, k);
      drawFrame(ctx, w, h, { preview: true });
      ctx.restore();
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

/** Pointer → frame fraction (0…1) inside the tile area. / 포인터 → 프레임 비율 */
function fracAt(e) {
  const c = e.currentTarget;
  const r = c.getBoundingClientRect();
  const { w, h } = sizeOf();
  const k = Math.max(1, Math.min(w, h) / 540);
  const top = opts.ov.title ? Math.round(34 * k) / h : 0;
  const fx = (e.clientX - r.left) / r.width;
  const fy = ((e.clientY - r.top) / r.height - top) / (1 - top);
  return { fx, fy, ar: (r.width / r.height) };
}

function hitTile(fx, fy) {
  const list = tiles();
  for (let i = list.length - 1; i >= 0; i--) {
    const tl = list[i];
    if (fx >= tl.x && fx <= tl.x + tl.w && fy >= tl.y && fy <= tl.y + tl.h) {
      const corner = fx >= tl.x + tl.w - 0.035 && fy >= tl.y + tl.h - 0.035 * 1.6;
      return { tl, corner };
    }
  }
  return null;
}

const snap = (v) => {
  const s = Math.round(v * 100) / 100;
  for (const g of [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1]) if (Math.abs(s - g) < 0.012) return g;
  return s;
};

function onDown(e) {
  if (job) return;
  const { fx, fy } = fracAt(e);
  const hit = hitTile(fx, fy);
  selKey = hit?.tl.key || null;
  if (hit) {
    drag = { tl: hit.tl, mode: hit.corner ? 'size' : 'move', fx, fy, x: hit.tl.x, y: hit.tl.y, w: hit.tl.w, h: hit.tl.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  renderOpts();
}

function onMove(e) {
  const { fx, fy } = fracAt(e);
  if (!drag) {
    const hit = !job && hitTile(fx, fy);
    e.currentTarget.style.cursor = hit ? (hit.corner ? 'nwse-resize' : 'move') : 'default';
    return;
  }
  const dx = fx - drag.fx;
  const dy = fy - drag.fy;
  const tl = drag.tl;
  if (drag.mode === 'move') {
    tl.x = clamp(snap(drag.x + dx), 0, 1 - tl.w);
    tl.y = clamp(snap(drag.y + dy), 0, 1 - tl.h);
    if (Math.abs(tl.x + tl.w - 1) < 0.012) tl.x = 1 - tl.w;
    if (Math.abs(tl.y + tl.h - 1) < 0.012) tl.y = 1 - tl.h;
  } else {
    tl.w = clamp(snap(drag.x + drag.w + dx) - tl.x, 0.04, 1 - tl.x);
    tl.h = clamp(snap(drag.y + drag.h + dy) - tl.y, 0.04, 1 - tl.y);
  }
}

function onUp() {
  if (!drag) return;
  drag = null;
  layoutOf().preset = 'custom';
  renderOpts();
}

// ==========================================================================
// Recording / 녹화
// ==========================================================================

function setBusy(on) {
  if (!dlg) return;
  for (const el of dlg.querySelectorAll('#svidOpts input, #svidOpts select, #svidOpts button')) el.disabled = on || el.dataset.off === '1'; // a sub-option whose parent is off stays off / 상위가 꺼진 하위 옵션은 비활성 유지
  dlg.classList.toggle('busy', on);
  const rec = dlg.querySelector('[data-v="record"]');
  if (rec) rec.textContent = on ? `■ ${t('svid.stop')}` : `● ${t('svid.record')}`;
  const cancel = dlg.querySelector('[data-v="cancel"]');
  if (cancel) cancel.textContent = on ? t('svid.cancel') : t('svid.close');
  const min = dlg.querySelector('[data-v="min"]');
  if (min) min.hidden = !on;
}

/** Progress everywhere: dialog bar, % and status, floating badge. / 진행률 표시 (창 + 배지) */
function progress(frac, text) {
  const pct = Math.floor(clamp(frac, 0, 1) * 100);
  const bar = dlg?.querySelector('#svidBar');
  if (bar) bar.style.width = `${pct}%`;
  const p = dlg?.querySelector('#svidPct');
  if (p) p.textContent = `${pct}%`;
  const st = dlg?.querySelector('#svidStatus');
  if (st) st.textContent = text;
  showVideoProgress({
    label: studioName(studio),
    frac,
    text,
    onStop: job ? () => stopJob(false) : null,
    onShow: dlg?.classList.contains('is-min') ? () => dlg?.classList.remove('is-min') : null,
  });
}

async function record(hooks) {
  if (!tiles().length) { hooks?.showToast?.(t('svid.noMonitor'), 'error'); return; }
  if (opts.mode === 'render' && offlineVideoAvailable()) { await renderOffline(hooks); return; }
  const fmt = supportedFormats().find((f) => f.id === opts.format) || supportedFormats()[0];
  const { w: W, h: H } = sizeOf();
  const fixed = opts.length === 'fixed';
  const expect = expectedSec();
  if (!fixed && !(expect > 0)) { hooks?.showToast?.(t('svid.noAudioPlay'), 'error'); return; }
  job = { cancelled: false, stopped: false, tracks: [], nodes: [], prev: {} };
  setBusy(true);
  progress(0, t('svid.preparing'));
  const actx = await ensureAudioCtx();
  stopAllAudio();
  // transport set-up for the recording (put back afterwards) / 녹화용 트랜스포트 설정 (나중에 복원)
  job.prev = { loop: appState.transport.loop, cue: appState.transport.cueSec };
  const patch = {};
  if (!fixed && appState.transport.loop) patch.loop = false;
  if (opts.start === 'zero') patch.cueSec = 0;
  if (Object.keys(patch).length) setTransport(patch);

  const canvas = dlg.querySelector('#svidCanvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const vStream = canvas.captureStream(opts.fps);
  job.tracks.push(...vStream.getVideoTracks());
  const out = getMasterOutput();
  if (opts.audio && out) {
    const dest = actx.createMediaStreamDestination();
    out.connect(dest);
    job.nodes.push([out, dest]);
    job.tracks.push(...dest.stream.getAudioTracks());
  }
  const rec = new MediaRecorder(new MediaStream(job.tracks), { mimeType: fmt.mime, videoBitsPerSecond: Math.round(clamp(W * H * opts.fps * 0.12, 2e6, 60e6)), audioBitsPerSecond: 256000 });
  const chunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  job.rec = rec;
  drawFrame(ctx, W, H);
  rec.start(1000);

  const tp = activeTransport();
  job.tp = tp;
  let started = false;
  try { started = (await tp.togglePlay()) !== false && tp.isPlaying(); } catch (err) { console.error(err); }
  if (!started && !fixed) { stopJob(true); hooks?.showToast?.(t('svid.noAudioPlay'), 'error'); }
  else if (!started) hooks?.showToast?.(t('svid.noAudio'), 'info');
  let total = fixed ? opts.fixedSec : expect;
  const pass = tp.pass?.();
  if (!fixed && pass && pass.endSec > pass.fromSec) total = pass.endSec - pass.fromSec;
  const t0 = performance.now();
  job.t0 = t0;
  let endAt = null;

  const tick = () => {
    if (!job || job.stopped) return;
    scanMonitors();
    const el = (performance.now() - t0) / 1000;
    drawFrame(ctx, W, H, { timeSec: fixed ? el : null });
    const playing = started && tp.isPlaying();
    if (fixed) {
      if (el >= total) { finish(); return; }
      progress(el / total, t('svid.recording', Math.floor((el / total) * 100), el.toFixed(1), total.toFixed(1)));
    } else {
      if (!playing && el > 0.3 && endAt === null) endAt = el;
      const frac = endAt !== null ? 1 : Math.min(0.99, el / Math.max(0.1, total));
      progress(frac, t('svid.recording', Math.floor(frac * 100), Math.min(el, total).toFixed(1), total.toFixed(1)));
      if (endAt !== null && el - endAt > 0.35) { finish(); return; } // short tail for the release / 릴리스 꼬리
    }
    job.raf = requestAnimationFrame(tick);
  };
  const finish = () => stopJob(false);
  job.raf = requestAnimationFrame(tick);
  await done;

  const j = job;
  job = null;
  cleanup(j);
  setBusy(false);
  if (j.cancelled) {
    progress(0, t('svid.cancelled'));
    hideVideoProgress(1500);
    renderOpts();
    return;
  }
  progress(1, t('svid.saving'));
  const blob = new Blob(chunks, { type: fmt.mime.split(';')[0] });
  const secs = (j.endSec ?? 0).toFixed(1);
  const filename = `Flexatone_${studio}_${W}x${H}_${secs}s.${fmt.ext}`;
  triggerDownload(blob, filename);
  const mb = (blob.size / 1048576).toFixed(1);
  progress(1, t('svid.done', filename, mb));
  hooks?.showToast?.(t('svid.done', filename, mb));
  hideVideoProgress(4000);
  dlg?.classList.remove('is-min');
  renderOpts();
}

/** Stop recording (cancel = discard). / 녹화 정지 (cancel = 버림) */
function stopJob(cancel) {
  if (!job || job.stopped) return;
  if (job.offline) { job.cancelled = true; return; } // the render loop ends itself / 렌더 루프가 스스로 끝냄
  job.stopped = true;
  job.cancelled = cancel;
  job.endSec = job.rec ? (performance.now() - (job.t0 ?? performance.now())) / 1000 : 0;
  cancelAnimationFrame(job.raf);
  try { if (job.tp?.isPlaying()) job.tp.stop(); } catch (err) { console.error(err); }
  if (job.rec && job.rec.state !== 'inactive') job.rec.stop();
  else if (!job.rec) { const j = job; job = null; cleanup(j); setBusy(false); }
}

function cleanup(j) {
  if (!j) return;
  cancelAnimationFrame(j.raf);
  for (const [a, b] of j.nodes) { try { a.disconnect(b); } catch { /* already gone */ } }
  for (const tr of j.tracks) { try { tr.stop(); } catch { /* ignore */ } }
  const patch = {};
  if (j.prev && 'loop' in j.prev && appState.transport.loop !== j.prev.loop) patch.loop = j.prev.loop;
  if (j.prev && opts.start === 'zero' && Number.isFinite(j.prev.cue)) patch.cueSec = j.prev.cue;
  if (Object.keys(patch).length) setTransport(patch);
}

// ==========================================================================
// Offline render (default): every frame drawn for its own time, H.264 + AAC MP4 (ui/video-encode.js)
// 오프라인 렌더 (기본): 프레임마다 그 시각을 그려 H.264 + AAC MP4로
// ==========================================================================

/** The Space Studio showing the Space Master: the sound is the Manager cycle. / 스페이스 마스터 표시 중 */
function masterMode() {
  try { return studio === 'space' && getSpaceDocTarget() === 'master'; } catch { return false; }
}

/** The studio's sound, offline, with the output stage (what the WAV export gives). / 스튜디오 소리 (오프라인) */
async function renderStudioAudio() {
  if (masterMode()) { const r = await mixer.exportCycleWav({ download: false }); return r.ok ? r.buffer : null; }
  if (studio === 'space') return renderSpaceBuffer({ params: getSpaceParams() });
  const r = await awaitInstanceBuffer({ target: `@${studio}`, content: 'doc', sampleRate: 48000 });
  return r?.buffer ? applyOutputStage(r.buffer) : null;
}

/** Part of a buffer from `from` seconds, `dur` long (silence-padded). / 버퍼 일부 */
function sliceBuffer(buf, from, dur) {
  if (!buf) return null;
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.round(from * sr));
  const n = Math.max(1, Math.round(dur * sr));
  const out = new AudioBuffer({ length: n, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(a, Math.min(buf.length, a + n)));
  return out;
}

async function renderOffline(hooks) {
  const { w: W, h: H } = sizeOf();
  const fps = opts.fps;
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = (getProjectFileName() || '').replace(/\.json$/i, '');
  const base = `${file ? `${file}_` : 'Flexatone_'}${masterMode() ? 'SpaceMaster' : studio}_${W}x${H}_${stamp}`;
  // the save window must open inside the click / 저장 창은 클릭 안에서
  const handle = await pickSaveTarget(`${base}.mp4`);
  if (handle === 'cancel') return;
  job = { cancelled: false, stopped: false, offline: true, tracks: [], nodes: [], prev: { cue: appState.transport.cueSec } };
  setBusy(true);
  stopAllAudio();
  if (masterMode()) mixer.stopAllManager();
  const from = masterMode() || opts.start === 'zero' ? 0 : Math.max(0, Number(appState.transport.cueSec) || 0);
  try {
    progress(0, t('svid.rAudio'));
    let audio = opts.audio || opts.length === 'play' ? await renderStudioAudio() : null;
    let dur = opts.length === 'fixed' ? opts.fixedSec : (audio ? audio.duration - from : expectedSec());
    if (!(dur > 0.05)) throw new Error(t('svid.noAudioPlay'));
    dur = Math.min(dur, 3600);
    audio = opts.audio && audio ? sliceBuffer(audio, from, dur) : null;
    if (job.cancelled) throw new Error('cancelled');
    const canvas = dlg.querySelector('#svidCanvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const nFrames = Math.max(1, Math.round(dur * fps));
    const res = await renderVideoOffline({
      W, H, fps, duration: dur, canvas, audio,
      cancelled: () => !job || job.cancelled,
      draw: async (i, tt) => {
        const T = from + tt;
        setTransport({ cueSec: T });
        try { hooks?.renderNow?.(['transport']); } catch (err) { console.error(err); }
        scanMonitors();
        drawFrame(ctx, W, H, { timeSec: T });
      },
      onProgress: (f, phase) => {
        if (phase === 'mux') progress(0.99, t('svid.rMux'));
        else { const p = 0.05 + f * 0.93; progress(p, t('svid.rFrames', Math.floor(p * 100), Math.round(f * nFrames), nFrames)); }
      },
    });
    if (!res) throw new Error('cancelled');
    const name = `${base}.${res.ext}`;
    const where = await saveBlob(res.blob, name, res.ext === 'mp4' ? handle : null);
    const mb = (res.blob.size / 1048576).toFixed(1);
    progress(1, t('svid.saved', where, mb));
    hooks?.showToast?.(t('svid.saved', where, mb));
    hideVideoProgress(5000);
  } catch (err) {
    if (String(err?.message) === 'cancelled') { progress(0, t('svid.cancelled')); hideVideoProgress(1500); }
    else { console.error('[Flexatone] video render:', err); progress(0, t('svid.renderFail', err?.message || err)); hooks?.showToast?.(t('svid.renderFail', err?.message || err), 'error'); hideVideoProgress(); }
  } finally {
    const prev = job?.prev;
    job = null;
    if (prev && Number.isFinite(prev.cue)) setTransport({ cueSec: prev.cue });
    setBusy(false);
    dlg?.classList.remove('is-min');
    renderOpts();
  }
}
