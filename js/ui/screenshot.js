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
 * Other studios (Field, Risset, …): the largest visible canvas of the workspace is saved as is;
 * no Version is made, because a Version backs up the Glissando document.
 * 다른 스튜디오는 작업 공간에서 가장 큰 캔버스를 그대로 저장하며, Version은 만들지 않음.
 */

import { appState, captureVersion } from '../core/state.js';
import { StudioRegistry } from '../studios/registry.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { renderMainScreenshot, renderMainSvg } from './canvases.js';
import { activeWorkspaceId } from './studio-host.js';

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
export async function takeScreenshot() {
  const inWorkspace = !!activeWorkspaceId();
  const mode = !inWorkspace && appState.screenshotMode === 'clean' ? 'clean' : 'full';
  const canvas = inWorkspace ? copyWorkspaceCanvas() : renderMainScreenshot(mode);
  if (!canvas) return { ok: false };
  const base = `flexatone_${StudioRegistry.resolveStudioId()}_${mode}_${stamp()}`;
  const svg = !inWorkspace && mode === 'clean' && appState.screenshotSvg ? renderMainSvg() : null;
  if (svg) {
    triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
  } else {
    const blob = await toPngBlob(canvas);
    if (!blob) return { ok: false };
    triggerDownload(blob, `${base}.png`);
  }
  if (inWorkspace) return { ok: true, mode, versioned: false, format: 'png' };
  captureVersion({ thumb: makeThumb(canvas), mode });
  return { ok: true, mode, versioned: true, format: svg ? 'svg' : 'png' };
}
