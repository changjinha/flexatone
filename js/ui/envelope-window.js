/**
 * Flexatone — ui/envelope-window.js
 * Layer 4 (ui, shared): the **envelope window** — an editor for one curve-engine object drawn
 * against an x axis that has a unit (seconds, path progress, metres, …) and a y axis with a
 * value range (m/s, Hz, dB, …). Any studio can mount it; it knows nothing about a studio.
 * 계층 4 (ui, 공용): **엔벨로프 창** — 단위가 있는 x축(초·경로 진행도·미터 등)과 값 범위가 있는 y축
 * (m/s·Hz·dB 등) 위에서 곡선 엔진 객체 하나를 편집. 스튜디오에 의존하지 않음.
 *
 * Data / 데이터: the curve is `{ engine: 'custom', customPoints: [{ x, y, handles: [{ u, y }] }] }`
 * — the same piecewise Bézier points as a Glissando voice's custom curve and gain points, edited
 * with the same pure helpers (core/math-utils.js split / elevate / remove), so shapes can move
 * between them. Picking a curve-engine shape converts it to points at once.
 * 글리산도 보이스의 custom 곡선·게인 점과 같은 자료(조각별 베지에)와 같은 순수 헬퍼를 사용.
 *
 * Gestures / 조작
 *   drag a point = move it (the first / last stay at the ends) · drag a handle = bend the segment
 *   double-click the curve = add a point (shape kept) · double-click a point = remove it
 *   Shift + double-click a segment = add a curvature handle · double-click a handle = remove it
 *   One drag = one undo step (the host's `edit(fn, coalesceKey)` + `commit()`).
 *
 * Imports: core/*, modules/curve-engine.js, ui/panels.js, ui/option-inspector.js, ui/canvas-size.js.
 */

import { clamp, roundTo, deepClone, evalPiecewiseBezierPoints, splitSplineSegmentPreservingShape, elevateSplineSegmentHandles, removeSplinePoint, findSplineSegmentIndex, normalizeSplinePoints } from '../core/math-utils.js';
import { I18N, t } from '../core/i18n.js';
import { createDefaultCurveParams } from '../core/state.js';
import { ENGINE_IDS } from '../core/state.js';
import { captureCurveToCustomPoints, evaluateCurveObjectY, getEngineLabel } from '../modules/curve-engine.js';
import { el } from './panels.js';
import { HELP_DB } from './option-inspector.js';
import { sizeCanvas2d } from './canvas-size.js';
import { STUDIO_BTN as BTN, STUDIO_SELECT } from './studio-controls.js';

const EN = {
  'env.on': 'On',
  'env.shape': 'Shape…',
  'env.reverse': 'Reverse',
  'env.invert': 'Invert',
  'env.reset': 'Reset',
  'env.copy': 'Copy',
  'env.paste': 'Paste',
  'env.expand': 'Larger',
  'env.collapse': 'Smaller',
  'env.min': 'min',
  'env.max': 'max',
  'env.lin': 'lin',
  'env.log': 'log',
  'env.domain.time': 'Time',
  'env.domain.path': 'Path',
  'env.domain.distance': 'Distance',
  'env.axis.time': 'source time (s)',
  'env.axis.path': 'path progress (%)',
  'env.axis.distance': 'distance to listener (m)',
  'env.autoRange': 'auto',
  'env.rangeFrom': 'from',
  'env.rangeTo': 'to',
  'env.hint': 'Drag points · double-click = add / remove · ⇧ double-click = bend',
  'env.copied': 'Envelope copied.',
  'env.pasted': 'Envelope pasted.',
  'env.nothing': 'No envelope copied yet.',
};
const KO = {
  'env.on': '켜기',
  'env.shape': '모양…',
  'env.reverse': '좌우 반전',
  'env.invert': '상하 반전',
  'env.reset': '초기화',
  'env.copy': '복사',
  'env.paste': '붙여넣기',
  'env.expand': '크게',
  'env.collapse': '작게',
  'env.min': '최소',
  'env.max': '최대',
  'env.lin': '선형',
  'env.log': '로그',
  'env.domain.time': '시간',
  'env.domain.path': '경로',
  'env.domain.distance': '거리',
  'env.axis.time': '음원 시간 (s)',
  'env.axis.path': '경로 진행도 (%)',
  'env.axis.distance': '청취자와의 거리 (m)',
  'env.autoRange': '자동',
  'env.rangeFrom': '시작',
  'env.rangeTo': '끝',
  'env.hint': '점 드래그 · 더블클릭 = 추가 / 삭제 · ⇧ 더블클릭 = 휘기',
  'env.copied': '엔벨로프를 복사했습니다.',
  'env.pasted': '엔벨로프를 붙여넣었습니다.',
  'env.nothing': '복사한 엔벨로프가 없습니다.',
};
Object.assign(I18N.en, EN);
Object.assign(I18N.ko, KO);

const E = (title, summary, detail, formula = '') => ({ title, summary, detail, formula });
const H = (en, ko) => ({ en: E(...en), ko: E(...ko) });
const HELP = {
  'env.canvas': H(
    ['Envelope', 'Draw how the value changes along the x axis.', 'Drag a point to move it; the first and last points stay at the ends. Double-click the curve to add a point (the shape is kept), double-click a point to remove it. Shift + double-click a segment adds a curvature handle; drag the small diamond to bend the segment, double-click it to remove it. One drag is one undo step.', 'value = min + (max − min) · y(x)   (log: min · (max / min)^y)'],
    ['엔벨로프', 'x축을 따라 값이 어떻게 변하는지 그립니다.', '점을 끌어 옮깁니다(첫 점과 끝 점은 양 끝에 고정). 곡선을 더블클릭하면 모양을 유지한 채 점이 추가되고, 점을 더블클릭하면 삭제됩니다. Shift + 더블클릭으로 구간에 곡률 핸들을 추가하고, 작은 마름모를 끌어 구간을 휘며, 더블클릭으로 핸들을 지웁니다. 드래그 한 번이 실행 취소 한 단계입니다.', '값 = 최소 + (최대 − 최소) · y(x)   (로그: 최소 · (최대 / 최소)^y)'],
  ),
  'env.domain': H(
    ['X axis (domain)', 'What the envelope is drawn against.', 'Time: seconds of the source\'s own clock. Path: how far along the path the source is (0–100 % of its length), so the shape stays attached to the places on the path. Distance: metres between the source and the listener — draw "faster when closer" once and it holds for any path. Changing the domain keeps the drawn shape and changes the meaning of x.'],
    ['x축 (도메인)', '엔벨로프의 가로축이 무엇인지 정합니다.', '시간: 음원 자체 시계의 초. 경로: 음원이 경로 길이의 몇 %까지 왔는지 — 모양이 경로 위의 장소에 붙어 있습니다. 거리: 음원과 청취자 사이의 미터 — "가까울수록 빠르게"를 한 번 그리면 어떤 경로에도 적용됩니다. 도메인을 바꾸면 그린 모양은 그대로이고 x의 의미만 바뀝니다.'],
  ),
  'env.range': H(
    ['Value range', 'The values at the bottom and top of the envelope.', 'The curve itself is stored as 0…1; these two numbers and the scale (linear / logarithmic) map it to real units. Narrow the range for fine control.'],
    ['값 범위', '엔벨로프의 아래쪽과 위쪽 값.', '곡선 자체는 0…1로 저장되고, 이 두 숫자와 스케일(선형 / 로그)이 실제 단위로 옮깁니다. 범위를 좁히면 미세하게 조절할 수 있습니다.'],
  ),
  'env.xrange': H(
    ['X range', 'The x values at the left and right ends of the envelope.', 'Empty = automatic: the whole duration (time), the whole path (path) or the nearest…farthest distance the source reaches (distance). Outside the range the end values are held.'],
    ['x 범위', '엔벨로프 왼쪽 끝과 오른쪽 끝의 x 값.', '비워 두면 자동: 전체 지속시간(시간), 전체 경로(경로), 음원이 지나는 최근접…최원거리(거리). 범위 밖에서는 끝 값이 유지됩니다.'],
  ),
  'env.shape': H(
    ['Shape', 'Start from one of the curve-engine shapes.', 'The chosen shape is converted to editable points at once (adaptive fit), so every envelope stays a point curve.'],
    ['모양', '곡선 엔진의 모양 하나에서 시작합니다.', '고른 모양은 바로 편집 가능한 점으로 변환됩니다(적응형 근사). 모든 엔벨로프는 점 곡선으로 유지됩니다.'],
  ),
  'env.tools': H(
    ['Envelope tools', 'Reverse (mirror left ↔ right), invert (mirror up ↔ down), reset, copy and paste.', 'Copy / paste carries the shape between envelopes; the value range of the target stays as it is.'],
    ['엔벨로프 도구', '좌우 반전, 상하 반전, 초기화, 복사, 붙여넣기.', '복사 / 붙여넣기는 모양만 옮기며, 붙여넣는 쪽의 값 범위는 그대로 둡니다.'],
  ),
  'env.on': H(
    ['Envelope on / off', 'Off = the neutral value; the drawn shape is kept.', ''],
    ['엔벨로프 켜기 / 끄기', '끄면 중립값이 적용되고, 그린 모양은 보존됩니다.', ''],
  ),
};
for (const [k, v] of Object.entries(HELP)) if (!HELP_DB[k]) HELP_DB[k] = v;

let clipboard = null; // customPoints of the last copy (shared by every envelope window) / 마지막 복사 (모든 창 공용)
const CURVE_DEFAULTS = createDefaultCurveParams();
const SHAPES = ENGINE_IDS.filter((id) => id !== 'morph' && id !== 'custom');
const PAD = { left: 44, right: 10, top: 8, bottom: 18 };
const FONT = '11px ui-monospace, Menlo, monospace';

/** Editable points of a curve object (converted from an engine shape when needed). / 편집용 점 */
export function envelopePoints(curve) {
  if (curve?.engine === 'custom' && Array.isArray(curve.customPoints) && curve.customPoints.length >= 2) return normalizeSplinePoints(deepClone(curve.customPoints));
  return captureCurveToCustomPoints({ ...CURVE_DEFAULTS, ...(curve || {}), engine: curve?.engine || 'harmonic' }, { tolerance: 0.002, maxAnchors: 24, includeTransforms: true });
}

/** A plain point curve from points. / 점 곡선 객체 */
export const pointCurve = (pts) => ({ engine: 'custom', reverse: false, inverse: false, customPoints: pts });

const fmt = (v) => {
  const a = Math.abs(v);
  return a >= 1000 ? String(Math.round(v)) : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
};

/**
 * @param {object} o
 * @param {string} o.title                  heading text / 제목
 * @param {string} [o.color]                curve colour (hex) / 곡선 색
 * @param {() => object|null} o.get         the lane: { on, domain, dom, min, max, scale, curve }
 * @param {(fn: (lane) => void, coalesceKey?: string|null) => void} o.edit   mutate the lane draft
 * @param {() => void} o.commit             close the undo gesture / 실행 취소 제스처 종료
 * @param {{ unit: string, lo: number, hi: number }} o.def   unit and hard limits of the value range
 * @param {boolean} [o.toggle]              show the on / off switch (default true) / 켜기 스위치
 * @param {string[]|null} [o.domains]       selectable x axes (null = fixed, no selector) / 고를 수 있는 x축
 * @param {() => { range: [number, number], overlay?: Array<[number, number]>, marker?: number, markers?: number[] }} [o.info]
 *        automatic x range in the lane's domain units, optional reference curve (x in domain units,
 *        y 0…1), the current position and tick marks (node positions…) / 자동 x 범위·참고 곡선·현재 위치·눈금
 * @param {(msg: string) => void} [o.toast]
 * @param {string} [o.id]                   prefix of the coalesce keys / 병합 키 접두
 * @returns {{ root: HTMLElement, sync: () => void, destroy: () => void }}
 */
export function createEnvelopeWindow(o) {
  const { title, color = '#38bdf8', get, edit, commit, def, toggle = true, domains = null, info = null, toast = null, id = 'env' } = o;
  let big = false;
  let drag = null;
  let hover = null;
  let M = null;

  const canvas = el('canvas', { class: 'w-full h-[110px] rounded-lg bg-slate-950 block touch-none', dataset: { help: 'env.canvas' } });
  const numBox = (help, getV, setV, step = 0.1) => {
    const n = el('input', { type: 'number', step, class: 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help } });
    const apply = (ck) => { const v = Number(n.value); if (n.value !== '' && Number.isFinite(v)) setV(v, ck); };
    n.addEventListener('input', () => { if (n.dataset.scrubbing) apply(`${id}:num:${help}`); });
    n.addEventListener('change', () => { if (n.value === '') setV(null, null); else apply(null); commit(); });
    n.sync = () => { if (document.activeElement !== n) { const v = getV(); n.value = v === null || v === undefined ? '' : String(roundTo(v, 3)); } };
    return n;
  };
  const lane = () => get() || null;
  const autoRange = () => (info ? info().range : [0, 1]);
  const xRange = () => { const l = lane(); return (l && l.dom) || autoRange(); };

  const onBtn = toggle ? el('button', { class: `fx-toggle ${BTN}`, text: t('env.on'), dataset: { help: 'env.on' }, on: { click: () => { edit((l) => { l.on = !l.on; }); commit(); } } }) : null;
  const domSeg = domains ? el('div', { class: 'flex gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5', dataset: { help: 'env.domain' } }, domains.map((d) => el('button', {
    class: 'px-2 py-0.5 rounded text-[11px]', text: t(`env.domain.${d}`), dataset: { help: 'env.domain', dom: d },
    on: { click: () => { edit((l) => { if (l.domain !== d) { l.domain = d; l.dom = null; } }); commit(); } },
  }))) : null;
  const minBox = numBox('env.range', () => lane()?.min, (v, ck) => { if (v !== null) edit((l) => { l.min = clamp(v, def.lo, def.hi); }, ck); });
  const maxBox = numBox('env.range', () => lane()?.max, (v, ck) => { if (v !== null) edit((l) => { l.max = clamp(v, def.lo, def.hi); }, ck); });
  const x0Box = numBox('env.xrange', () => lane()?.dom?.[0] ?? null, (v, ck) => edit((l) => { const r = l.dom || autoRange().slice(); l.dom = v === null ? null : [v, Math.max(v + 1e-3, r[1])]; }, ck));
  const x1Box = numBox('env.xrange', () => lane()?.dom?.[1] ?? null, (v, ck) => edit((l) => { const r = l.dom || autoRange().slice(); l.dom = v === null ? null : [Math.min(r[0], v - 1e-3), v]; }, ck));
  x0Box.placeholder = t('env.autoRange');
  x1Box.placeholder = t('env.autoRange');
  const scaleBtn = el('button', { class: BTN, dataset: { help: 'env.range' }, on: { click: () => { edit((l) => { l.scale = l.scale === 'log' ? 'lin' : 'log'; if (l.scale === 'log') { l.min = Math.max(l.min, 1e-3); l.max = Math.max(l.max, 1e-3); } }); commit(); } } });
  const setPoints = (fn, ck = null) => edit((l) => { const pts = envelopePoints(l.curve); fn(pts); l.curve = pointCurve(pts); }, ck);
  const shapeSel = el('select', { class: STUDIO_SELECT, dataset: { help: 'env.shape' }, on: { change: (e) => {
    const engine = e.target.value;
    e.target.value = '';
    if (!engine) return;
    edit((l) => { l.curve = pointCurve(envelopePoints({ engine })); });
    commit();
  } } }, [el('option', { value: '', text: t('env.shape') }), ...SHAPES.map((s) => el('option', { value: s, text: getEngineLabel(s, { short: true }) }))]);
  shapeSel.addEventListener('keydown', (e) => e.stopPropagation());
  const tool = (key, fn) => el('button', { class: BTN, text: t(key), dataset: { help: 'env.tools' }, on: { click: fn } });
  const tools = [
    tool('env.reverse', () => { edit((l) => { const y = (x) => evaluateCurveObjectY({ ...CURVE_DEFAULTS, ...pointCurve(envelopePoints(l.curve)) }, 1 - x, { regions: false }); l.curve = pointCurve(captureCurveToCustomPoints({ ...CURVE_DEFAULTS, ...pointCurve(sample(y)) }, { tolerance: 0.002, maxAnchors: 32, includeTransforms: true })); }); commit(); }),
    tool('env.invert', () => { setPoints((pts) => { for (const p of pts) { p.y = roundTo(1 - p.y, 4); for (const h of p.handles || []) h.y = roundTo(1 - h.y, 4); } }); commit(); }),
    tool('env.reset', () => { setPoints((pts) => { const y = pts[0].y; pts.length = 0; pts.push({ x: 0, y, handles: [] }, { x: 1, y, handles: [] }); }); commit(); }),
    tool('env.copy', () => { const l = lane(); if (!l) return; clipboard = envelopePoints(l.curve); toast?.(t('env.copied')); }),
    tool('env.paste', () => { if (!clipboard) { toast?.(t('env.nothing')); return; } const pts = deepClone(clipboard); edit((l) => { l.curve = pointCurve(pts); }); commit(); toast?.(t('env.pasted')); }),
  ];
  const sizeBtn = el('button', { class: BTN, dataset: { help: 'env.canvas' }, on: { click: () => { big = !big; canvas.className = `w-full ${big ? 'h-[260px]' : 'h-[110px]'} rounded-lg bg-slate-950 block touch-none`; sync(); } } });
  const readout = el('span', { class: 'font-mono text-[11px] text-slate-400 ml-auto' });

  function sample(fn) {
    const pts = [];
    for (let i = 0; i <= 64; i++) pts.push({ x: roundTo(i / 64, 4), y: roundTo(clamp(fn(i / 64), 0, 1), 5), handles: [] });
    return pts;
  }

  // ------------------------------------------------------------------ drawing
  const valueOf = (l, y) => (l.scale === 'log' && l.min > 0 && l.max > 0 ? l.min * Math.pow(l.max / l.min, y) : l.min + (l.max - l.min) * y);
  function metrics(w, h) {
    const pw = Math.max(10, w - PAD.left - PAD.right);
    const ph = Math.max(10, h - PAD.top - PAD.bottom);
    return { pw, ph, X: (x) => PAD.left + x * pw, Y: (y) => PAD.top + (1 - y) * ph, x: (px) => (px - PAD.left) / pw, y: (py) => 1 - (py - PAD.top) / ph };
  }
  /** Screen position of handle k of segment i (the Bézier control point). / 핸들 화면 위치 */
  const handlePos = (pts, i, k) => {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const h = p0.handles[k];
    return { x: p0.x + clamp(h.u, 0, 1) * (p1.x - p0.x), y: h.y };
  };

  function render() {
    const { ctx, w, h } = sizeCanvas2d(canvas);
    const l = lane();
    M = metrics(w, h);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    if (!l) return;
    const active = !toggle || l.on;
    ctx.font = FONT;
    ctx.fillStyle = 'rgba(30, 41, 59, 0.35)';
    ctx.fillRect(PAD.left, PAD.top, M.pw, M.ph);
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath(); ctx.moveTo(M.X(i / 4), PAD.top); ctx.lineTo(M.X(i / 4), PAD.top + M.ph); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(PAD.left, M.Y(i / 4)); ctx.lineTo(PAD.left + M.pw, M.Y(i / 4)); ctx.stroke();
    }
    const [xa, xb] = xRange();
    const inf = info ? info() : null;
    const pct = l.domain === 'path' && !l.dom;
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'right';
    for (const y of [0, 0.5, 1]) ctx.fillText(fmt(valueOf(l, y)), PAD.left - 4, M.Y(y) + (y === 1 ? 8 : y === 0 ? 0 : 4));
    ctx.textAlign = 'center';
    for (const x of [0, 0.5, 1]) {
      const v = xa + (xb - xa) * x;
      ctx.textAlign = x === 0 ? 'left' : x === 1 ? 'right' : 'center';
      ctx.fillText(pct ? `${Math.round(v * 100)}%` : fmt(v), M.X(x), h - 5);
    }
    ctx.textAlign = 'left';
    const toX01 = (v) => (v - xa) / Math.max(1e-9, xb - xa);
    ctx.save();
    ctx.beginPath(); ctx.rect(PAD.left, PAD.top, M.pw, M.ph); ctx.clip();
    // reference curve and tick marks from the host / 호스트가 주는 참고 곡선과 눈금
    if (inf?.overlay?.length) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      inf.overlay.forEach(([x, y], i) => (i ? ctx.lineTo(M.X(toX01(x)), M.Y(y)) : ctx.moveTo(M.X(toX01(x)), M.Y(y))));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const mk of inf?.markers || []) {
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.45)';
      ctx.beginPath(); ctx.moveTo(M.X(toX01(mk)), PAD.top + M.ph - 8); ctx.lineTo(M.X(toX01(mk)), PAD.top + M.ph); ctx.stroke();
    }
    const pts = envelopePoints(l.curve);
    ctx.strokeStyle = color;
    ctx.globalAlpha = active ? 1 : 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 240; i++) {
      const x = i / 240;
      const y = clamp(evalPiecewiseBezierPoints(pts, x), 0, 1);
      if (i) ctx.lineTo(M.X(x), M.Y(y)); else ctx.moveTo(M.X(x), M.Y(y));
    }
    ctx.stroke();
    // handles (diamonds) and points / 핸들(마름모)과 점
    for (let i = 0; i < pts.length - 1; i++) {
      (pts[i].handles || []).forEach((_, k) => {
        const hp = handlePos(pts, i, k);
        const on = hover?.type === 'handle' && hover.i === i && hover.k === k;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(M.X(pts[i].x), M.Y(pts[i].y)); ctx.lineTo(M.X(hp.x), M.Y(hp.y)); ctx.lineTo(M.X(pts[i + 1].x), M.Y(pts[i + 1].y)); ctx.stroke();
        ctx.fillStyle = on ? '#f8fafc' : '#94a3b8';
        ctx.save(); ctx.translate(M.X(hp.x), M.Y(hp.y)); ctx.rotate(Math.PI / 4); ctx.fillRect(-3.5, -3.5, 7, 7); ctx.restore();
      });
    }
    pts.forEach((p, i) => {
      const on = hover?.type === 'point' && hover.i === i;
      ctx.fillStyle = '#020617';
      ctx.strokeStyle = on ? '#f8fafc' : color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(M.X(p.x), M.Y(p.y), on ? 5.5 : 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    if (Number.isFinite(inf?.marker)) { // current position / 현재 위치
      const mx = M.X(clamp(toX01(inf.marker), 0, 1));
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mx, PAD.top); ctx.lineTo(mx, PAD.top + M.ph); ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ pointer
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function hit(p) {
    const l = lane();
    if (!l || !M) return null;
    const pts = envelopePoints(l.curve);
    for (let i = 0; i < pts.length; i++) if (Math.hypot(p.x - M.X(pts[i].x), p.y - M.Y(pts[i].y)) < 8) return { type: 'point', i };
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < (pts[i].handles || []).length; k++) {
      const hp = handlePos(pts, i, k);
      if (Math.hypot(p.x - M.X(hp.x), p.y - M.Y(hp.y)) < 8) return { type: 'handle', i, k };
    }
    return null;
  }
  const onDown = (e) => {
    if (e.button !== 0 || e.altKey) return;
    const h = hit(pos(e));
    if (!h) return;
    drag = h;
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  };
  const onMove = (e) => {
    const p = pos(e);
    const l = lane();
    if (!drag) {
      const h = hit(p);
      if (JSON.stringify(h) !== JSON.stringify(hover)) { hover = h; render(); }
      if (l && M) {
        const x = clamp(M.x(p.x), 0, 1);
        const [xa, xb] = xRange();
        const y = clamp(evalPiecewiseBezierPoints(envelopePoints(l.curve), x), 0, 1);
        readout.textContent = `x ${fmt(xa + (xb - xa) * x)} → ${fmt(valueOf(l, y))} ${def.unit}`;
      }
      return;
    }
    const x = clamp(M.x(p.x), 0, 1);
    const y = clamp(M.y(p.y), 0, 1);
    const d = drag;
    setPoints((pts) => {
      if (d.type === 'point') {
        const pt = pts[d.i];
        if (!pt) return;
        const lo = d.i === 0 ? 0 : pts[d.i - 1].x + 0.004;
        const hi = d.i === pts.length - 1 ? 1 : pts[d.i + 1].x - 0.004;
        pt.x = d.i === 0 ? 0 : d.i === pts.length - 1 ? 1 : roundTo(clamp(x, lo, hi), 4);
        pt.y = roundTo(y, 4);
      } else {
        const p0 = pts[d.i];
        const p1 = pts[d.i + 1];
        const hd = p0?.handles?.[d.k];
        if (!hd || !p1) return;
        const lo = d.k === 0 ? 0.02 : p0.handles[d.k - 1].u + 0.02;
        const hi = d.k === p0.handles.length - 1 ? 0.98 : p0.handles[d.k + 1].u - 0.02;
        hd.u = roundTo(clamp((x - p0.x) / Math.max(1e-6, p1.x - p0.x), lo, hi), 4);
        hd.y = roundTo(clamp(M.y(p.y), -0.5, 1.5), 4);
      }
    }, `${id}:drag`);
  };
  const onUp = (e) => {
    if (!drag) return;
    drag = null;
    commit();
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  };
  const onDbl = (e) => {
    if (e.altKey) return;
    const p = pos(e);
    const h = hit(p);
    const x = clamp(M.x(p.x), 0, 1);
    setPoints((pts) => {
      if (h?.type === 'point') { removeSplinePoint(pts, h.i); return; }
      if (h?.type === 'handle') { pts[h.i].handles.splice(h.k, 1); return; }
      const seg = findSplineSegmentIndex(pts, x);
      if (seg < 0) return;
      if (e.shiftKey) elevateSplineSegmentHandles(pts[seg], pts[seg + 1], (x - pts[seg].x) / Math.max(1e-6, pts[seg + 1].x - pts[seg].x), 3);
      else if (pts.length < 48 && x > pts[seg].x + 0.004 && x < pts[seg + 1].x - 0.004) splitSplineSegmentPreservingShape(pts, seg, x);
    });
    commit();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', () => { if (!drag && hover) { hover = null; render(); } });
  canvas.addEventListener('dblclick', onDbl);
  const ro = globalThis.ResizeObserver ? new ResizeObserver(() => render()) : null;
  ro?.observe(canvas);

  function sync() {
    const l = lane();
    if (onBtn) { onBtn.classList.toggle('active', !!l?.on); onBtn.setAttribute('aria-pressed', l?.on ? 'true' : 'false'); onBtn.className = `${BTN} ${l?.on ? '!bg-sky-600 !border-sky-500 !text-white font-semibold' : ''}`; }
    if (domSeg) for (const b of domSeg.children) b.className = `px-2 py-0.5 rounded text-[11px] ${l?.domain === b.dataset.dom ? 'bg-sky-600 text-white font-semibold' : 'text-slate-400 hover:text-white'}`;
    for (const n of [minBox, maxBox, x0Box, x1Box]) n.sync();
    scaleBtn.textContent = t(l?.scale === 'log' ? 'env.log' : 'env.lin');
    sizeBtn.textContent = t(big ? 'env.collapse' : 'env.expand');
    axis.textContent = l ? (domains || l.domain ? t(`env.axis.${l.domain || 'time'}`) : '') : '';
    render();
  }

  const axis = el('span', { class: 'text-[11px] text-slate-500' });
  const root = el('div', { class: 'flex flex-col gap-1.5 min-w-0' }, [
    el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      onBtn,
      el('span', { class: 'text-[11px] font-semibold', style: `color:${color}`, text: title }),
      domSeg,
      el('span', { class: 'text-[11px] text-slate-500', text: def.unit }),
      minBox, el('span', { class: 'text-[11px] text-slate-600', text: '…' }), maxBox, scaleBtn,
      readout,
    ]),
    canvas,
    el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      axis, x0Box, el('span', { class: 'text-[11px] text-slate-600', text: '…' }), x1Box,
      shapeSel, ...tools, sizeBtn,
    ]),
    el('span', { class: 'text-[11px] text-slate-500', text: t('env.hint') }),
  ]);

  return { root, sync, destroy() { ro?.disconnect(); } };
}
