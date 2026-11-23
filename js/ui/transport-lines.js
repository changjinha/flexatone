/**
 * Flexatone — ui/transport-lines.js
 * Layer 4 (ui): the one cue marker and the one playhead every studio canvas draws, so the transport
 * looks the same in Glissando, Field, Draw, Cloud, Space, Tempo, Chaos, Fractal and Wave (and matches
 * the Manager's white playhead).
 * 계층 4 (ui): 모든 스튜디오 캔버스가 공통으로 그리는 큐 표시와 플레이헤드 (매니저의 흰색 플레이헤드와 동일).
 *
 *   cue      = amber line + ▼ flag at the top (where playback starts / returns to)
 *   playhead = white 1.5 px line with a thin dark halo (readable on bright heat maps too) + ▼ cap
 * Callers decide *when* to draw (their own "is playing" rule) and pass plot-area pixels.
 */

export const CUE_COLOR = '#fbbf24';
export const PLAYHEAD_COLOR = '#f8fafc';

function cap(ctx, x, top, half, height, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - half, top);
  ctx.lineTo(x + half, top);
  ctx.lineTo(x, top + height);
  ctx.closePath();
  ctx.fill();
}

/**
 * Cue marker at pixel x between top and bottom. `left` / `right` clip it to the plot.
 * 큐 표시 (플롯 범위 밖이면 그리지 않음).
 */
export function drawCueLine(ctx, x, top, bottom, { left = -Infinity, right = Infinity } = {}) {
  if (!Number.isFinite(x) || x < left - 0.5 || x > right + 0.5) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(251,191,36,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  cap(ctx, x, top, 5, 7, CUE_COLOR); // inside the plot: never cut off by a clip region / 플롯 안쪽 (클립에 잘리지 않음)
  ctx.restore();
}

/** Playhead at pixel x between top and bottom. / 플레이헤드 */
export function drawPlayheadLine(ctx, x, top, bottom, { left = -Infinity, right = Infinity } = {}) {
  if (!Number.isFinite(x) || x < left - 0.5 || x > right + 0.5) return;
  ctx.save();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(2,6,23,0.55)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  ctx.strokeStyle = PLAYHEAD_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, top);
  ctx.lineTo(x, bottom);
  ctx.stroke();
  cap(ctx, x, top, 4, 6, PLAYHEAD_COLOR);
  ctx.restore();
}
