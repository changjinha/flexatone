/**
 * Flexatone — ui/clean-chart.js
 * Layer 4 (ui): the **Axes + lines** screenshot for every studio — pitch lines [{ t, m }] on white with a time
 * axis (s) and a pitch axis (note names), as a PNG canvas or a vector SVG (papers, score editors). The Glissando
 * editor keeps its own renderer (ui/canvases.js); the other studios draw the lines they send / show in the
 * Manager (studios/trajectory-link.js `listSourceLines`).
 * 계층 4 (ui): 모든 스튜디오의 "축 + 선" 스크린샷 — 흰 배경, 시간 축(초)·음고 축(음이름), PNG 또는 SVG.
 */

const INK = '#1f2937';
const GRID = '#e5e7eb';
const FONT = '12px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const FONT_PX = 12;
const PALETTE = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#9333ea', '#ea580c'];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m) => `${NOTE[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= raw) return k * p;
  return 10 * p;
}

/**
 * Geometry shared by the PNG and the SVG: plot box, axis lines, tick labels and polylines in pixels.
 * PNG·SVG 공용 기하
 */
function layout(lines, w, h) {
  const ok = lines.map((l, i) => ({ color: PALETTE[i % PALETTE.length], // dark ink colours that print on white (studio colours are made for a dark screen) / 흰 바탕용 진한 색
    pts: (l.pts || []).filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m)) })).filter((l) => l.pts.length >= 2);
  let t0 = Infinity; let t1 = -Infinity; let lo = Infinity; let hi = -Infinity;
  for (const l of ok) for (const q of l.pts) { t0 = Math.min(t0, q.t); t1 = Math.max(t1, q.t); lo = Math.min(lo, q.m); hi = Math.max(hi, q.m); }
  if (!Number.isFinite(t0)) { t0 = 0; t1 = 1; lo = 48; hi = 72; }
  t0 = Math.min(0, t0);
  if (t1 - t0 < 1e-3) t1 = t0 + 1;
  lo = Math.floor(lo - 1); hi = Math.ceil(hi + 1);
  if (hi - lo < 6) { const c = (lo + hi) / 2; lo = Math.floor(c - 3); hi = Math.ceil(c + 3); }
  const plot = { x: 56, y: 14, w: w - 56 - 16, h: h - 14 - 36 };
  const X = (t) => plot.x + ((t - t0) / (t1 - t0)) * plot.w;
  const Y = (m) => plot.y + (1 - (m - lo) / (hi - lo)) * plot.h;
  const texts = [];
  const grid = [];
  const ts = niceStep(t1 - t0, Math.max(4, Math.floor(plot.w / 90)));
  for (let t = Math.ceil(t0 / ts) * ts; t <= t1 + 1e-9; t += ts) {
    grid.push([X(t), plot.y, X(t), plot.y + plot.h]);
    texts.push({ x: X(t), y: plot.y + plot.h + 16, text: `${+t.toFixed(3)}`, align: 'middle' });
  }
  texts.push({ x: plot.x + plot.w, y: plot.y + plot.h + 31, text: 's', align: 'end' });
  const span = hi - lo;
  const ms = span > 36 ? 12 : span > 12 ? 3 : 1; // octaves, minor thirds, semitones / 옥타브·단3도·반음
  for (let m = Math.ceil(lo / ms) * ms; m <= hi; m += ms) {
    grid.push([plot.x, Y(m), plot.x + plot.w, Y(m)]);
    texts.push({ x: plot.x - 6, y: Y(m) + FONT_PX * 0.35, text: noteName(m), align: 'end' });
  }
  const axes = [[plot.x, plot.y, plot.x, plot.y + plot.h], [plot.x, plot.y + plot.h, plot.x + plot.w, plot.y + plot.h]];
  const curves = ok.map((l) => ({ color: l.color, pts: l.pts.map((q) => [X(q.t), Y(q.m)]) }));
  return { w, h, plot, grid, axes, texts, curves };
}

/** PNG canvas (CSS size w × h at `scale`). / PNG 캔버스 */
export function cleanLinesCanvas(lines, { w = 1200, h = 600, scale = 2 } = {}) {
  const g = layout(lines, w, h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [a, b, c2, d] of g.grid) { ctx.moveTo(a, b); ctx.lineTo(c2, d); }
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.plot.x, g.plot.y, g.plot.w, g.plot.h);
  ctx.clip();
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const cv of g.curves) {
    ctx.strokeStyle = cv.color;
    ctx.beginPath();
    cv.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.beginPath();
  for (const [a, b, c2, d] of g.axes) { ctx.moveTo(a, b); ctx.lineTo(c2, d); }
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = FONT;
  for (const tx of g.texts) { ctx.textAlign = tx.align === 'middle' ? 'center' : tx.align; ctx.fillText(tx.text, tx.x, tx.y); }
  return c;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** Vector SVG text. / 벡터 SVG */
export function cleanLinesSvg(lines, { w = 1200, h = 600 } = {}) {
  const g = layout(lines, w, h);
  const f = (n) => Number(n.toFixed(2));
  const seg = (list) => list.map(([a, b, c, d]) => `M${f(a)} ${f(b)}L${f(c)} ${f(d)}`).join('');
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" fill="#ffffff"/>`,
    `<path fill="none" stroke="${GRID}" stroke-width="1" d="${seg(g.grid)}"/>`,
    `<clipPath id="plot"><rect x="${f(g.plot.x)}" y="${f(g.plot.y)}" width="${f(g.plot.w)}" height="${f(g.plot.h)}"/></clipPath>`,
    '<g clip-path="url(#plot)" fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">',
    ...g.curves.map((c) => `<polyline stroke="${esc(c.color)}" points="${c.pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}"/>`),
    '</g>',
    `<path fill="none" stroke="${INK}" stroke-width="1" d="${seg(g.axes)}"/>`,
    `<g fill="${INK}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="${FONT_PX}">`,
    ...g.texts.map((tx) => `<text x="${f(tx.x)}" y="${f(tx.y)}" text-anchor="${tx.align}">${esc(tx.text)}</text>`),
    '</g>',
    '</svg>',
  ];
  return out.join('\n');
}
