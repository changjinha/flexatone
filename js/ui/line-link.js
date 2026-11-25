/**
 * Flexatone — ui/line-link.js
 * Layer 4 (ui): the shared pieces of "play range / trim / split / 🔗 link" (core/line-clip.js) that every
 * studio with movable lines shows the same way — the 🔗 checkbox + play-range tag on a line card, the
 * faint drawing of unplayed parts, and the link sync wrapped around a studio's own edit function.
 * 계층 4 (ui): 재생 구간·자르기·🔗 링크의 공용 UI — 카드의 🔗 체크박스와 재생 구간 표시, 재생하지 않는
 * 부분의 연한 그리기, 스튜디오 편집 함수에 씌우는 링크 동기화.
 */

import { t } from '../core/i18n.js';
import { appState, setPref } from '../core/state.js';
import { linkFamily, clipOf } from '../core/line-clip.js';

/**
 * 🔗 checkbox (only on pieces cut from one line) and the play-range tag (trimmed / extended lines).
 * `setOn(on)` is the studio's edit. Returns null when there is nothing to show.
 * 🔗 체크박스(잘린 조각에만)와 재생 구간 표시. 보여줄 것이 없으면 null.
 */
export function lineLinkControl(line, lines, setOn) {
  const c = clipOf(line);
  const clipped = Math.abs(c.u0) > 1e-9 || Math.abs(c.u1 - 1) > 1e-9;
  const wrap = document.createElement('span');
  wrap.className = 'inline-flex items-center gap-0.5 text-[10px] shrink-0';
  wrap.dataset.help = 'gliss.clip';
  const fam = linkFamily(lines, line);
  if (line.link && fam.length > 1) {
    const on = line.link.on !== false;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'accent-emerald-500 w-3 h-3 cursor-pointer';
    box.checked = on;
    const tip = on ? t('clip.link', fam.length - 1) : t('clip.unlinked', fam.length - 1);
    box.title = tip;
    box.setAttribute('aria-label', tip);
    for (const ev of ['mousedown', 'pointerdown', 'dblclick']) box.addEventListener(ev, (e) => e.stopPropagation());
    box.addEventListener('click', (e) => { e.stopPropagation(); setOn(e.target.checked); });
    const lab = document.createElement('label');
    lab.className = `inline-flex items-center gap-0.5 ${on ? 'text-emerald-300' : 'text-slate-500'}`;
    lab.title = tip;
    lab.append(box, '🔗');
    wrap.append(lab);
  }
  if (clipped) {
    const tag = document.createElement('span');
    tag.className = 'font-mono text-amber-300/80';
    tag.textContent = `${Math.round(c.u0 * 100)}–${Math.round(c.u1 * 100)}%`;
    tag.title = t('clip.range', Math.round(c.u0 * 100), Math.round(c.u1 * 100));
    wrap.append(tag);
  }
  return wrap.childNodes.length ? wrap : null;
}

/**
 * ◌ Unplayed parts toggle for a studio toolbar (the same pref as the Glissando grapher).
 * 재생 안 하는 부분 토글 (글리산도 그래퍼와 같은 설정).
 */
export function createGhostToggle(className = 'px-2 py-1 rounded-lg border text-[11px] font-medium transition') {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.help = 'gliss.clip';
  b.append('◌ ', Object.assign(document.createElement('span'), { textContent: t('clip.ghost') }));
  b.title = t('clip.ghostTip');
  b.addEventListener('click', () => setPref('clipGhost', appState.clipGhost === false, ['canvas', 'panels', 'studio']));
  b.sync = () => {
    const on = appState.clipGhost !== false;
    b.className = `${className} ${on ? 'bg-slate-700 border-slate-500 text-white' : 'bg-slate-950 border-slate-800 text-slate-300 hover:text-white'}`;
    b.setAttribute('aria-pressed', String(on));
  };
  b.sync();
  return b;
}

/**
 * Draw the unplayed parts of a line faint and dotted (nothing when ◌ Unplayed parts is off).
 * `lines` = screen polylines [[{x, y}] | [x, y]]. / 재생하지 않는 부분을 연한 점선으로
 */
export function drawUnplayed(ctx, lines, color, active = false) {
  if (appState.clipGhost === false || !lines || !lines.length) return;
  ctx.save();
  ctx.setLineDash([2, 4]);
  ctx.globalAlpha = active ? 0.32 : 0.18;
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = color;
  for (const pl of lines) {
    if (pl.length < 2) continue;
    ctx.beginPath();
    pl.forEach((p, i) => {
      const x = Array.isArray(p) ? p[0] : p.x;
      const y = Array.isArray(p) ? p[1] : p.y;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.restore();
}
