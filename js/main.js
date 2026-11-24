/**
 * Flexatone — main.js
 * Entry point: bootstraps modules, wires header/transport/toolbar DOM events and keyboard
 * shortcuts, applies EN/KO text, and runs a single rAF-batched render loop driven by
 * core state events. / 진입점: 모듈 초기화, 헤더·트랜스포트·툴바 이벤트, 단축키, 언어 적용,
 * 상태 이벤트 기반 rAF 일괄 렌더 루프.
 *
 * Dependency direction: main → ui → audio → studios → modules → core.
 */

import './studios/glissando-studio.js'; // registers the Glissando Studio plugin / 플러그인 등록
import './studios/risset-studio.js'; // registers the Risset Studio plugin / 리세 스튜디오 등록
import './studios/field-studio.js'; // registers the Field Studio plugin / 필드 스튜디오 등록
import './studios/draw-studio.js'; // registers the Draw Studio plugin / 드로잉 스튜디오 등록
import './studios/cloud-studio.js'; // registers the Cloud Studio plugin / 클라우드 스튜디오 등록
import './studios/space-studio.js'; // registers the Space Studio plugin / 스페이스 스튜디오 등록
import './studios/tempo-studio.js'; // registers the Tempo Studio plugin (tempo canons) / 템포 스튜디오 등록
import './studios/chaos-studio.js'; // registers the Chaos Studio plugin / 카오스 스튜디오 등록
import './studios/fractal-studio.js'; // registers the Fractal Studio plugin / 프랙탈 스튜디오 등록
import './studios/wave-studio.js'; // registers the Wave Studio plugin (PDE on the pitch axis) / 웨이브 스튜디오 등록
import './ui/workspaces.js'; // studio workspaces (UI + audio tier) / 스튜디오 작업 공간
import { t, LANG_TEXT_MAP, LANGUAGES, nextLang, getLang } from './core/i18n.js';
import {
  appState,
  subscribe,
  setLanguage,
  setPref,
  setUiZoom,
  undo,
  redo,
  canUndo,
  canRedo,
  duplicateVoice,
  endHistoryGesture,
  loadProjectData,
} from './core/state.js';
import { StudioRegistry } from './studios/registry.js';
import {
  togglePause,
  togglePlay,
  toggleLooping,
  resetCue,
  isPlaying,
} from './audio/audio-engine.js';
import { initCanvases, renderMainCanvas, renderGainCanvas, fitAllViewport, zoomPitch, zoomTime, zoomBoth, nudgeSelection, clearCanvasSelection, deleteSelectedRegion } from './ui/canvases.js';
import { initPanels, renderPanels, setToggle, setSegment } from './ui/panels.js';
import { renderTremoloPanel } from './ui/tremolo-panel.js';
import { initStudioHost, syncStudioLayout, isWorkspaceActive, renderWorkspace, activeTransport, stopAllAudio, fitWorkspace } from './ui/studio-host.js';
import { takeScreenshot } from './ui/screenshot.js';
import { initRackLayout, syncRackLayout, resetRackLayout } from './ui/rack-layout.js';
import { initTrajectoryUi } from './ui/trajectory-ui.js';
import { initSendRouter } from './ui/send-router.js';
import { initStudioTempoUi } from './ui/studio-tempo-ui.js';
import { initMidiWindow } from './ui/midi-window.js';
import { initScreenshotModeChip } from './ui/screenshot-mode-chip.js';
import { initNumberScrub } from './ui/number-scrub.js';
import { initOptionInspector } from './ui/option-inspector.js';
import { initHelpOverlay } from './ui/help-overlay.js';
import { initIconTooltip } from './ui/icon-tooltip.js';
import { initOutputPanel, renderOutputPanel } from './ui/output-panel.js';
import { initSliderReset } from './ui/slider-reset.js';
import { initManagerPanel, renderManagerPanel, toggleManagerPanel, isManagerOpen, toggleManagerCycle } from './ui/manager-panel.js';
import { stopAllManager } from './audio/manager-mixer.js';
import { ensureManager } from './core/manager-state.js';
import { initAutosave, markFileSaved, hasUnsavedFileChanges } from './core/autosave.js';
import { saveProjectToFile, initReloadGuard } from './ui/project-file.js';

/** Transport of the active studio (Glissando, Field, …). / 활성 스튜디오 트랜스포트 */
const tp = () => activeTransport();

const $ = (id) => document.getElementById(id);

// ==========================================================================
// Toast / 알림
// ==========================================================================

let toastTimer = null;
function showToast(msg, kind = 'info') {
  const box = $('toastBanner');
  if (!box) return;
  box.textContent = msg;
  box.classList.remove('hidden', 'border-sky-500/50', 'border-rose-500/60');
  box.classList.add(kind === 'error' ? 'border-rose-500/60' : 'border-sky-500/50');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add('hidden'), kind === 'error' ? 4000 : 2600);
}

// ==========================================================================
// Language / 언어
// ==========================================================================

function applyLanguage() {
  const lang = getLang();
  document.documentElement.lang = LANGUAGES[lang]?.htmlLang || lang;
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const text = t(node.dataset.i18n);
    if (node.textContent !== text) node.textContent = text;
  }
  for (const [id, attrs] of Object.entries(LANG_TEXT_MAP)) {
    const node = $(id);
    if (!node) continue;
    for (const [attr, key] of Object.entries(attrs)) node.setAttribute(attr, t(key));
  }
  const lbl = $('lblLang');
  if (lbl) lbl.textContent = LANGUAGES[lang]?.label || lang;
}

// ==========================================================================
// Render loop / 렌더 루프
// ==========================================================================

const dirty = new Set();
let frameRequested = false;

/** Queue a re-render for the given scopes; flushed once per animation frame. */
function requestRender(scopes = ['all']) {
  for (const s of scopes) dirty.add(s);
  if (frameRequested) return;
  frameRequested = true;
  // rAF is paused while the page is hidden; fall back to a timer so state-driven layout changes
  // (e.g. a studio switch) still apply. / 숨겨진 페이지에서는 타이머로 대체
  if (document.hidden) setTimeout(flush, 16);
  else requestAnimationFrame(flush);
}

function flush() {
  frameRequested = false;
  const scopes = new Set(dirty);
  dirty.clear();
  try {
    if (scopes.has('all') || scopes.has('lang')) applyLanguage();
    syncStudioLayout();
    syncRackLayout(); // movable racks: re-apply saved places / 이동 랙 위치 재적용
    renderHeader();
    renderOutputPanel(scopes);
    renderManagerPanel(scopes);
    if (isWorkspaceActive()) {
      renderWorkspace(scopes);
    } else {
      renderMainCanvas();
      renderGainCanvas();
      if (!(scopes.size === 1 && (scopes.has('transport') || scopes.has('canvas') || scopes.has('gain') || scopes.has('view')))) {
        renderPanels(scopes);
      }
      if (!(scopes.size === 1 && scopes.has('transport'))) renderTremoloPanel();
    }
  } catch (err) {
    console.error('[Flexatone] render error:', err);
  }
}

function renderHeader() {
  const tr = appState.transport;
  const playing = tp().isPlaying();
  const lblPlay = $('lblPlay');
  if (lblPlay) lblPlay.textContent = t(playing ? 'transport.pause' : 'transport.play');
  const ico = $('icoPlay');
  if (ico) ico.textContent = playing ? '❚❚' : '▶';
  setToggle($('btnLoop'), tr.loop);
  const lblLoop = $('lblLoop');
  if (lblLoop) lblLoop.textContent = t(tr.loop ? 'transport.loopOn' : 'transport.loopOff');
  const cue = $('lblCueSec');
  if (cue) cue.textContent = `${(tr.cueSec || 0).toFixed(2)}s`;
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();

  const portrait = appState.layout === 'portrait';
  $('mainSplitGrid')?.classList.toggle('layout-portrait', portrait);
  const lblLayout = $('lblLayout');
  if (lblLayout) lblLayout.textContent = t(portrait ? 'view.portrait' : 'view.landscape');
  document.documentElement.style.setProperty('--fx-ui-zoom', String(appState.uiZoom / 100));
  const zoomInput = $('inputUiZoom');
  if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = String(appState.uiZoom);

  const activeStudio = StudioRegistry.resolveStudioId();
  for (const tab of document.querySelectorAll('#studioTabs [data-studio]')) {
    const on = tab.dataset.studio === activeStudio;
    tab.classList.toggle('is-active', on);
    tab.classList.toggle('font-semibold', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  }

  const piano = appState.viewMode === 'piano';
  setSegment(piano ? $('btnViewPiano') : $('btnViewNorm'), piano ? $('btnViewNorm') : $('btnViewPiano'), 'sky');
  setToggle($('btnLocateMode'), appState.locateMode);
  setToggle($('btnSelectMode'), appState.selectMode);
  setToggle($('btnLegatoJoin'), appState.legatoJoin !== false);
  const glide = $('inputJoinGlide');
  if (glide && document.activeElement !== glide) glide.value = String(appState.joinGlideMs ?? 12);
  setToggle($('btnLocateSnap'), appState.locateSnap);
  setToggle($('btnScrubAudio'), appState.scrubAudio);
  setToggle($('btnShowDeriv'), appState.showDeriv);
  const grid = $('selectGridSub');
  if (grid && document.activeElement !== grid) grid.value = String(appState.gridSub);
}

// ==========================================================================
// Header & toolbar bindings / 헤더·툴바 바인딩
// ==========================================================================

async function onPlay() {
  try {
    const wasPlaying = tp().isPlaying();
    const ok = await tp().togglePause();
    if (!wasPlaying && ok === false) showToast(t('toast.noAudio'), 'error');
  } catch (err) {
    console.error(err);
    showToast(String(err.message || err), 'error');
  }
  requestRender(['transport']);
}

async function onExportWav() {
  showToast(t('toast.wavStart'));
  try {
    const res = await tp().exportWav();
    showToast(res.ok ? t('toast.wavDone', res.filename) : res.message, res.ok ? 'info' : 'error');
  } catch (err) {
    console.error(err);
    showToast(String(err.message || err), 'error');
  }
}

/** Reload into the default document (autosave skips the restore on `?new`). / 새 프로젝트 */
function onNewProject() {
  if (hasUnsavedFileChanges() && !globalThis.confirm(t('confirm.newProject'))) return;
  stopAllAudio();
  stopAllManager();
  const url = new URL(location.href);
  url.searchParams.set('new', '');
  location.href = url.toString();
}

async function onSaveProject() {
  const res = await saveProjectToFile();
  if (res === 'error') showToast(t('toast.saveError'), 'error');
  else if (res !== 'cancelled') showToast(t('toast.saved'));
}

async function onLoadFile(evt) {
  const file = evt.target.files?.[0];
  evt.target.value = '';
  if (!file) return;
  stopAllAudio();
  stopAllManager();
  try {
    const res = loadProjectData(await file.text());
    if (!res.ok) {
      showToast(t('toast.loadError'), 'error');
      return;
    }
    ensureManager();
    StudioRegistry.activate(StudioRegistry.resolveStudioId());
    fitAllViewport();
    markFileSaved();
    showToast(t('toast.loaded'));
  } catch (err) {
    console.error(err);
    showToast(t('toast.loadError'), 'error');
  }
}

function onStudioTab(id) {
  const plugin = StudioRegistry.get(id);
  if (plugin && plugin.status === 'ready') {
    stopAllAudio(); // never let two studios sound at once / 두 스튜디오 동시 발음 방지
    StudioRegistry.activate(id);
    return;
  }
  showToast(t('toast.studioSoon', t(`studio.${id}`)));
}

function bindHeader() {
  const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  on('btnPlay', 'click', onPlay);
  on('btnStop', 'click', () => { stopAllAudio(); requestRender(['transport']); });
  on('btnLoop', 'click', () => toggleLooping());
  on('btnCueReset', 'click', () => resetCue());
  on('btnUndo', 'click', () => undo());
  on('btnRedo', 'click', () => redo());
  on('btnScreenshot', 'click', async () => {
    const r = await takeScreenshot();
    if (!r.ok) showToast(t('toast.screenshotFail'), 'error');
    else showToast(t(r.versioned ? 'toast.screenshot' : 'toast.screenshotOnly'));
  });
  on('btnNewProject', 'click', onNewProject);
  on('btnSaveProject', 'click', onSaveProject);
  on('btnLoadProject', 'click', () => $('fileLoadProject').click());
  on('fileLoadProject', 'change', onLoadFile);
  on('btnExportWav', 'click', onExportWav);
  on('btnLangToggle', 'click', () => setLanguage(nextLang()));
  on('btnLayoutReset', 'click', () => showToast(t('toast.layoutReset', resetRackLayout()))); // positions only / 위치만 초기화
  on('btnLayoutToggle', 'click', () => setPref('layout', appState.layout === 'portrait' ? 'landscape' : 'portrait', ['layout', 'canvas']));
  on('btnZoomOut', 'click', () => setUiZoom(appState.uiZoom - 10));
  on('btnZoomIn', 'click', () => setUiZoom(appState.uiZoom + 10));
  on('inputUiZoom', 'change', (e) => setUiZoom(e.target.value));
  for (const tab of document.querySelectorAll('#studioTabs [data-studio]')) tab.addEventListener('click', () => onStudioTab(tab.dataset.studio));

  // Canvas toolbar / 캔버스 툴바
  on('btnViewPiano', 'click', () => setPref('viewMode', 'piano', ['canvas', 'view']));
  on('btnViewNorm', 'click', () => setPref('viewMode', 'norm', ['canvas', 'view']));
  on('selectGridSub', 'change', (e) => setPref('gridSub', Number(e.target.value) || 0, ['canvas', 'gain']));
  // Locate (이동) and Select (선택) are exclusive canvas tools / 이동·선택 도구는 상호 배타
  on('btnLocateMode', 'click', () => {
    if (!appState.locateMode && appState.selectMode) setPref('selectMode', false, ['canvas', 'view', 'panels']);
    setPref('locateMode', !appState.locateMode, ['canvas', 'view']);
  });
  on('btnSelectMode', 'click', () => {
    if (!appState.selectMode && appState.locateMode) setPref('locateMode', false, ['canvas', 'view']);
    setPref('selectMode', !appState.selectMode, ['canvas', 'view', 'panels']);
  });
  on('btnLegatoJoin', 'click', () => setPref('legatoJoin', appState.legatoJoin === false, ['view']));
  on('inputJoinGlide', 'change', (e) => setPref('joinGlideMs', Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0))), ['view']));
  on('btnLocateSnap', 'click', () => setPref('locateSnap', !appState.locateSnap, ['view']));
  on('btnScrubAudio', 'click', () => setPref('scrubAudio', !appState.scrubAudio, ['view']));
  on('btnShowDeriv', 'click', () => setPref('showDeriv', !appState.showDeriv, ['canvas', 'view']));
  on('btnPitchZoomOut', 'click', () => zoomPitch(1.25));
  on('btnPitchZoomIn', 'click', () => zoomPitch(0.8));
  on('btnTimeZoomOut', 'click', () => zoomTime(1.25));
  on('btnTimeZoomIn', 'click', () => zoomTime(0.8));
  on('btnCornerZoomOut', 'click', () => zoomBoth(1.25));
  on('btnCornerZoomIn', 'click', () => zoomBoth(0.8));
  on('btnFitAll', 'click', () => fitAllViewport());
}

// ==========================================================================
// Keyboard shortcuts / 단축키
// ==========================================================================

function isTyping(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/** Space: play ⇄ stop (back to cue). While the Manager is open it plays / stops the Manager cycle instead. */
async function onSpace() {
  if (isManagerOpen()) { await toggleManagerCycle(); return; } // 매니저가 열려 있으면 매니저 사이클 재생·정지
  try {
    const wasPlaying = tp().isPlaying();
    const ok = await tp().togglePlay();
    if (!wasPlaying && ok === false) showToast(t('toast.noAudio'), 'error');
  } catch (err) {
    showToast(String(err.message || err), 'error');
  }
  requestRender(['transport']);
}

/**
 * Global shortcuts / 전역 단축키
 *   Space        play ⇄ stop (return to cue); Manager open → Manager cycle   재생 ⇄ 정지 (매니저가 열려 있으면 매니저)
 *   Enter        pause & pin the cue / resume       일시정지·플레이헤드 고정 / 재개
 *   Shift+R      duplicate active voice after its end  끝점 뒤에 복제
 *   Arrows       nudge selected point/handle, Locate F₀/F₁ end, or whole voice
 *   Shift+Arrows coarse nudge                       크게 이동
 *   Esc          stop + clear point selection       정지·선택 해제
 *   L / F        loop / fit all
 *   M            Manager window                      매니저 창
 *   H            Help mode (ui/help-overlay.js)      도움말 모드
 *   Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Ctrl/⌘+Y  undo / redo
 */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }
    if (mod || e.altKey) return;
    const ws = isWorkspaceActive();
    if (ARROWS[e.key] && !ws) {
      e.preventDefault();
      const [dx, dy] = ARROWS[e.key];
      nudgeSelection(dx, dy, e.shiftKey);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault(); // also stops a focused button from being "clicked" / 포커스된 버튼 클릭 방지
        if (!e.repeat) onSpace();
        break;
      case 'Enter':
        e.preventDefault();
        if (!e.repeat) onPlay();
        break;
      case 'R':
      case 'r':
        if (e.shiftKey && !ws) {
          e.preventDefault();
          duplicateVoice(appState.activeVoiceId, { afterEnd: true });
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (!ws && deleteSelectedRegion()) e.preventDefault();
        break;
      case 'Escape':
        stopAllAudio();
        stopAllManager(); // Esc = panic: editor preview + every Manager track / 전체 정지
        clearCanvasSelection();
        requestRender(['transport']);
        break;
      case 'l':
      case 'L':
        toggleLooping();
        break;
      case 'm':
      case 'M':
        toggleManagerPanel();
        break;
      case 'f':
      case 'F':
        if (ws) fitWorkspace();
        else fitAllViewport();
        break;
      default:
        break;
    }
  });
  document.addEventListener('keyup', (e) => {
    if (isTyping(e.target)) return;
    // A held arrow = one undo step / 방향키 누르고 있는 동안 = 실행 취소 1단계
    if (ARROWS[e.key]) endHistoryGesture();
    // Browsers click a focused button on Space keyup; the shortcut already handled it.
    if (e.key === ' ' && e.target?.tagName === 'BUTTON') e.preventDefault();
  });
}

// ==========================================================================
// Boot / 시작
// ==========================================================================

function boot() {
  initStudioHost({ requestRender, showToast, fitAll: fitAllViewport });
  initNumberScrub();
  initSliderReset(); // double-click any slider → default / 슬라이더 더블클릭 → 기본값
  initOptionInspector();
  initHelpOverlay();
  initIconTooltip();
  initOutputPanel();
  initManagerPanel({ requestRender, showToast, fitAll: fitAllViewport });
  initCanvases({ requestRender, showToast });
  initRackLayout();
  initTrajectoryUi({ showToast, requestRender });
  initSendRouter({ showToast }); // ⇄ Sends: send / receive order tool / 보내기 순서 도구
  initStudioTempoUi(); // ⏱ studio tempo on the header transport / 스튜디오 템포
  initMidiWindow({ showToast }); // 🎹 MIDI: .mid export / import, input + Learn / MIDI 창
  initScreenshotModeChip(); // Full / Axes + lines / SVG in every studio / 스크린샷 모드
  initPanels({ showToast, fitAll: fitAllViewport, requestRender });
  bindHeader();
  bindKeyboard();
  initReloadGuard({ showToast });
  subscribe((event) => requestRender([...event.scope]));
  StudioRegistry.activate(StudioRegistry.resolveStudioId());
  fitAllViewport();
  requestRender(['all']);
  restoreSession();
}

/** Bring back the autosaved project (same steps as loading a file). / 자동 저장본 복원 */
async function restoreSession() {
  const res = await initAutosave();
  if (!res.restored) return;
  ensureManager();
  StudioRegistry.activate(StudioRegistry.resolveStudioId());
  fitAllViewport();
  showToast(t('toast.restored'));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
