/**
 * Flexatone — ui/studio-host.js
 * Layer 4 (ui): hosts full-screen studio workspaces (Field, Risset, …) next to the Glissando
 * editor and routes the shared header transport to the active studio.
 * 계층 4 (ui): 전용 작업 공간을 가진 스튜디오(필드·리세 …)를 호스팅하고 공용 트랜스포트를 라우팅.
 *
 * Why this exists / 존재 이유
 *   The StudioRegistry contract (studios/registry.js) is DOM-free, but Field/Risset studios need
 *   their own canvases, panels and audio graphs. A plugin declares `workspace: '<id>'`; the UI
 *   tier registers the matching workspace here (mount + transport). Switching studios stops
 *   every engine first, so audio never overlaps. / 스튜디오 전환 시 모든 오디오를 먼저 정지.
 */

import { appState, setTransport } from '../core/state.js';
import { StudioRegistry } from '../studios/registry.js';
import * as gliss from '../audio/audio-engine.js';

const GLISS_TRANSPORT = Object.freeze({
  isPlaying: gliss.isPlaying,
  togglePlay: gliss.togglePlay,
  togglePause: gliss.togglePause,
  stop: gliss.stopAudio,
  exportWav: () => gliss.exportWavFile(),
});

/** Ids of the Glissando editor blocks hidden while a workspace is shown. / 숨길 글리산도 영역 */
const GLISS_BLOCKS = ['voiceGrapherStrip', 'versionGallerySection', 'studioMount'];

const workspaces = new Map(); // id → { mount(root, hooks) → instance, transport }
let mounted = null; // { id, instance }
let hooks = { requestRender: () => {}, showToast: () => {}, fitAll: () => {} };
let root = null;

/**
 * Register a workspace implementation for a studio whose plugin has `workspace: id`.
 * @param {string} id
 * @param {{ mount: (root: HTMLElement, hooks: object) => { render: Function, destroy: Function, fit?: Function },
 *           transport: { isPlaying, togglePlay, togglePause, stop, exportWav } }} impl
 */
export function registerWorkspace(id, impl) {
  workspaces.set(id, impl);
}

/**
 * Delete / Backspace = delete what is selected in the studio on screen — the same as that
 * studio's ✕ button (one rule for every studio that has a selected object).
 * Delete / Backspace = 화면의 스튜디오에서 선택한 대상 삭제 (그 스튜디오의 ✕ 버튼과 같음).
 */
function onDeleteKey(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
  const tg = e.target;
  if (tg?.tagName === 'INPUT' || tg?.tagName === 'TEXTAREA' || tg?.tagName === 'SELECT' || tg?.isContentEditable) return;
  if (appState.manager?.open || document.querySelector('dialog[open], .fx-traj-dialog')) return; // the Manager or a window is open / 매니저나 창이 열려 있음
  const del = mounted?.instance.deleteSelection;
  if (!del) return;
  e.preventDefault();
  del();
}

export function initStudioHost(h) {
  hooks = { ...hooks, ...h };
  document.addEventListener('keydown', onDeleteKey);
  root = document.getElementById('studioWorkspace');
  if (!root) {
    root = document.createElement('div');
    root.id = 'studioWorkspace';
    root.className = 'hidden flex flex-col gap-3';
    const anchor = document.getElementById('voiceGrapherStrip');
    anchor?.parentElement?.insertBefore(root, anchor);
  }
}

/** Workspace id of the active studio, or null for the Glissando editor. / 활성 작업 공간 */
export function activeWorkspaceId() {
  const plugin = StudioRegistry.get(StudioRegistry.resolveStudioId());
  const id = plugin?.workspace;
  return id && workspaces.has(id) ? id : null;
}

/** Transport of the active studio (Glissando by default). / 활성 스튜디오의 트랜스포트 */
export function activeTransport() {
  const id = activeWorkspaceId();
  return id ? workspaces.get(id).transport : GLISS_TRANSPORT;
}

/** Stop every studio's audio (used on tab switch, Stop, Escape, project load). / 전체 정지 */
export function stopAllAudio() {
  for (const w of workspaces.values()) { try { if (w.transport.isPlaying()) w.transport.stop(); } catch (err) { console.error(err); } }
  if (gliss.isPlaying()) gliss.stopAudio();
  if (appState.transport.playing) setTransport({ playing: false, playheadSec: -1 });
}

function glissBlocks() {
  const left = document.getElementById('leftCanvasCol');
  return [...GLISS_BLOCKS.map((id) => document.getElementById(id)), left?.parentElement].filter(Boolean);
}

/** Show the right workspace for the active studio (mount / unmount as needed). / 레이아웃 동기화 */
export function syncStudioLayout() {
  const id = activeWorkspaceId();
  if ((mounted?.id || null) === id) return;
  stopAllAudio();
  if (mounted) {
    mounted.instance.destroy();
    mounted = null;
  }
  for (const b of glissBlocks()) b.classList.toggle('fx-ws-hidden', !!id);
  root?.classList.toggle('hidden', !id);
  if (id) {
    mounted = { id, instance: workspaces.get(id).mount(root, hooks) };
    mounted.instance.fit?.();
  }
}

/** True when a workspace (not the Glissando editor) is on screen. */
export function isWorkspaceActive() {
  return !!mounted;
}

/** Render the mounted workspace. / 작업 공간 렌더링 */
export function renderWorkspace(scopes) {
  mounted?.instance.render(scopes);
}

/** Fit the workspace view (F key / Fit All). / 보기 맞춤 */
export function fitWorkspace() {
  mounted?.instance.fit?.();
}

/**
 * Re-mount the active workspace (the Manager swapped the document of the studio on screen).
 * 활성 작업 공간 재마운트 (매니저가 화면의 스튜디오 문서를 교체했을 때).
 */
export function remountWorkspace() {
  if (!mounted) return;
  stopAllAudio();
  mounted.instance.destroy();
  mounted = null;
  syncStudioLayout();
}
