/**
 * Flexatone — modules/sources/kernel-source.js
 * Layer 1 (modules, pure): compose AudioWorklet module source from self-contained classes
 * (voice banks + source kernels), so one class serves the worklet, the offline render and the checks.
 * 계층 1 (modules, 순수): 자기완결 클래스(보이스 뱅크 + 음원 커널)로 워클릿 모듈 소스를 조립.
 *
 * Order matters only for top-level use; class bodies resolve names when they run, so a bank may call
 * a kernel that is listed after it. Each class appears once. / 각 클래스는 한 번만 들어감.
 *
 * Imports: none.
 */

/** True when the class source has no imports / DOM access (worklet-safe). / 워클릿에 넣을 수 있는지 */
export function isSelfContained(cls) {
  const src = String(cls);
  return !/\bimport\b|\brequire\(|\bdocument\b|\bwindow\b/.test(src);
}

/**
 * Join classes (deduplicated, in order) and an optional tail (the processor + registerProcessor call).
 * 클래스들(중복 제거, 순서 유지)과 꼬리(프로세서 + registerProcessor)를 이어 붙임.
 * @param {Function[]} classes
 * @param {string} [tail]
 */
export function composeKernelSource(classes, tail = '') {
  const seen = new Set();
  const parts = [];
  for (const c of classes) {
    if (typeof c !== 'function' || seen.has(c)) continue;
    seen.add(c);
    parts.push(c.toString());
  }
  if (tail) parts.push(tail);
  return parts.join('\n');
}
