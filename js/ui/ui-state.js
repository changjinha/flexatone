/**
 * Flexatone — ui/ui-state.js
 * Layer 4 (ui): transient, view-only UI state shared by canvases.js, panels.js and main.js.
 * Never saved to projects and never part of undo history.
 * 계층 4 (ui): 캔버스·패널·메인이 공유하는 일시적 UI 상태 (저장·실행 취소 대상 아님).
 */

export const uiState = {
  /** Morph node whose ⚙ Edit panel is open; its Custom points become editable on the canvas. */
  morphEditNodeId: null,
  /**
   * Point selected on the main canvas for arrow-key nudging. / 방향키 미세 이동용 선택 점
   * { kind: 'anchor' | 'handle' | 'start' | 'end', voiceId, nodeId?, i?, k? } or null
   */
  selection: null,
  /** 11. Custom capture fidelity 1 (coarse) … 10 (fine). / 캡처 정밀도 */
  captureFidelity: 8,
  /** Reverse fit (custom → engine) precision 1 (fast) … 5 (thorough). / 역근사 정밀도 */
  fitPrecision: 3,
  /** Selected local region { voiceId, regionId } (Select tool) or null. / 선택된 구간 */
  regionSel: null,
  /** When true the engine tabs & rack edit the selected region's curve. / 구간 곡선 편집 모드 */
  regionEdit: false,
};

/** captureCurveToCustomPoints options for the current fidelity. / 캡처 옵션 */
export function captureOptions() {
  const f = Math.min(10, Math.max(1, Number(uiState.captureFidelity) || 8));
  return { tolerance: 0.03 / f, maxAnchors: 12 + f * 4 };
}

/** fitCurveToEngines options for the current precision. / 역근사 옵션 */
export function fitOptions() {
  const p = Math.min(5, Math.max(1, Math.round(Number(uiState.fitPrecision) || 3)));
  return { samples: 32 + p * 24, restarts: p, maxIter: 80 + p * 60 };
}
