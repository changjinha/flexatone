/**
 * Flexatone — ui/screenshot.js
 * Layer 4 (ui): Screenshot = save the graph on screen as a PNG image (for research, scores,
 * papers). In the Glissando editor each Screenshot also stores a Version — a restorable backup
 * of the document — whose thumbnail is that screenshot.
 * 계층 4 (ui): 스크린샷 = 화면의 그래프를 PNG 이미지로 저장 (연구·악보·논문용). 글리산도 에디터에서는
 * 스크린샷마다 그 이미지를 썸네일로 한 Version(복원 가능한 문서 백업)도 함께 저장.
 *
 * Modes (appState.screenshotMode) / 모드
 *   'full'  — the graph as shown, without editing aids (handles, cursor tooltip, playhead)
 *   'clean' — axes and lines only, on white (like Apple Grapher); with appState.screenshotSvg it is
 *             saved as a vector SVG (papers, score editors) instead of a PNG
 * Other studios: 'full' saves the largest visible canvas of the workspace as is; 'clean' draws the studio's
 * pitch lines on white axes (ui/clean-chart.js, PNG or SVG; Risset has no lines → full). No Version is made,
 * because a Version backs up the Glissando document.
 * 다른 스튜디오: 'full'은 가장 큰 캔버스 그대로, 'clean'은 그 스튜디오의 음고 선을 흰 축 위에 (PNG/SVG, 리세는 full).
 * Version은 만들지 않음.
 */

import { appState, captureVersion } from '../core/state.js';
import { StudioRegistry } from '../studios/registry.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { renderMainScreenshot, renderMainSvg } from './canvases.js';
import { activeWorkspaceId } from './studio-host.js';
import { listSourceLines, MEAN_LINE } from '../studios/trajectory-link.js';
import { cleanLinesCanvas, cleanLinesSvg } from './clean-chart.js';

const THUMB_WIDTH = 240;

function toPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

/** Small JPEG data URL used as the Version thumbnail. / Version 썸네일용 작은 JPEG */
function makeThumb(canvas) {
  const w = THUMB_WIDTH;
  const h = Math.max(1, Math.round((canvas.height * w) / Math.max(1, canvas.width)));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}

/** Largest visible canvas inside the active studio workspace, copied so it can be exported. */
function copyWorkspaceCanvas() {
  const root = document.getElementById('studioWorkspace');
  if (!root) return null;
  const list = [...root.querySelectorAll('canvas')].filter((c) => c.offsetParent !== null && c.width > 0 && c.height > 0);
  if (!list.length) return null;
  list.sort((a, b) => b.width * b.height - a.width * a.height);
  const src = list[0];
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  out.getContext('2d').drawImage(src, 0, 0);
  return out;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Take a screenshot: download the PNG (or SVG) and (Glissando editor only) store a Version.
 * @returns {Promise<{ ok: boolean, mode?: 'full'|'clean', versioned?: boolean, format?: 'png'|'svg' }>}
 */
/** Pitch lines of a workspace studio for the Axes + lines mode (none → full). / 축 + 선 모드용 음고 선 */
function workspaceLines(studio) {
  try { return listSourceLines(studio).filter((l) => l.key !== MEAN_LINE); } catch { return []; }
}

export async function takeScreenshot() {
  const inWorkspace = !!activeWorkspaceId();
  const studio = StudioRegistry.resolveStudioId();
  // every studio with pitch lines has the Axes + lines mode (ui/clean-chart.js); Risset has none / 음고 선이 있으면 축 + 선 모드
  const lines = inWorkspace && appState.screenshotMode === 'clean' ? workspaceLines(studio) : [];
  const mode = appState.screenshotMode === 'clean' && (!inWorkspace || lines.length) ? 'clean' : 'full';
  const canvas = !inWorkspace ? renderMainScreenshot(mode) : mode === 'clean' ? cleanLinesCanvas(lines) : copyWorkspaceCanvas();
  if (!canvas) return { ok: false };
  const base = `flexatone_${studio}_${mode}_${stamp()}`;
  const svg = mode === 'clean' && appState.screenshotSvg ? (inWorkspace ? cleanLinesSvg(lines) : renderMainSvg()) : null;
  if (svg) {
    triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
  } else {
    const blob = await toPngBlob(canvas);
    if (!blob) return { ok: false };
    triggerDownload(blob, `${base}.png`);
  }
  if (inWorkspace) return { ok: true, mode, versioned: false, format: svg ? 'svg' : 'png' };
  captureVersion({ thumb: makeThumb(canvas), mode });
  return { ok: true, mode, versioned: true, format: svg ? 'svg' : 'png' };
}
