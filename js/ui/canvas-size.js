/**
 * ui/canvas-size.js
 * Shared canvas backing-store sizing for the studio canvases.
 * 스튜디오 캔버스 공용 크기 맞춤 (CSS 크기 × devicePixelRatio).
 */

/**
 * Match the canvas backing store to its CSS box (× devicePixelRatio); returns the CSS size.
 * 캔버스 버퍼를 CSS 크기에 맞추고 CSS 크기를 돌려줌.
 * @param {HTMLCanvasElement} canvas
 * @param {number} [minW] smallest width used while the element is collapsed / 최소 너비
 * @param {number} [minH]
 * @returns {{ dpr: number, w: number, h: number }}
 */
export function sizeCanvas(canvas, minW = 100, minH = 60) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = Math.max(minW, Math.floor(canvas.clientWidth));
  const h = Math.max(minH, Math.floor(canvas.clientHeight));
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  return { dpr, w, h };
}

/** Same, plus a 2D context already scaled to CSS pixels. / 같은 동작 + CSS 픽셀 단위 2D 컨텍스트 */
export function sizeCanvas2d(canvas, minW = 100, minH = 60) {
  const { dpr, w, h } = sizeCanvas(canvas, minW, minH);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
