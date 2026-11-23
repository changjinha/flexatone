/**
 * Flexatone — ui/trajectory-ui.js
 * Layer 4 (ui): everything on screen for trajectory **Sends** (logic: studios/trajectory-link.js).
 * 계층 4 (ui): 궤적 보내기의 화면 부분 (로직은 studios/trajectory-link.js).
 *
 *   1. Receive / Send buttons for a studio strip (`createTrajectoryImportButton`, `createSendButton`) with
 *      the receive chip next to them
 *   2. Send window: choose the source studio (and instance) and its line in the window / card list, the
 *      destination (a studio or Master = every studio) and how it combines there (replace / add)
 *   3. Lock button on Glissando voice cards that are sent (🔒 protected ⇄ 🔓 linked editing)
 *   4. Guard: a shape edit of a locked voice is taken back and a dialog asks —
 *      Copy (default) · Change without copying (the receiving studios follow) · Cancel
 *   5. After every edit the sends are evaluated (receiving studios follow, in stage order)
 * The order tool (who receives what, in which order) is ui/send-router.js.
 */

import { t, I18N } from '../core/i18n.js';
import { midiToNoteName } from '../core/units.js';
import { appState, subscribe, undo, canUndo, duplicateVoice, getVoiceById, selectVoice } from '../core/state.js';
import { listInstances, isFocused, focusInstance, ensureManager, getFocusedId } from '../core/manager-state.js';
import {
  getTrajLink, linksOfVoice, linkedVoiceIds, setVoiceLinksLocked, unlinkTrajectory, findLockedViolations, evaluateSends,
  trajectorySignature, isTrajectoryTarget, isTrajectorySource, listSendSources, listSendTargets, listSourceLines, addSend,
  isEvaluatingSends, buildSendPlan, MASTER, MEAN_LINE, receivedVoiceId,
} from '../studios/trajectory-link.js';
import '../studios/trajectory-targets.js'; // registers the receiving studios / 받는 스튜디오 등록
import '../audio/send-sources.js'; // registers the sending studios / 보내는 스튜디오 등록
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'traj.import': 'Receive',
  'traj.na.chaos': 'Chaos cannot receive a line: its lines are the solution of the attractor equations, so there is no base line to replace. It can send.',
  'traj.na.wave': 'Wave cannot receive a line: its lines are the result of the wave simulation, so there is no base line to replace. It can send.',
  'traj.send': 'Send',
  'traj.pickTitle': (studio) => `Receive a trajectory → ${studio}`,
  'traj.sendTitle': (studio) => `Send a trajectory from ${studio}`,
  'traj.source': 'From',
  'traj.dest': 'To',
  'traj.mode': 'Combine',
  'traj.mode.replace': 'Replace',
  'traj.mode.add': 'Add',
  'traj.modeHint.replace': 'Replace — the receiving line becomes this line (sends above it in that studio are discarded).',
  'traj.modeHint.add': 'Add — this line’s motion (its pitch minus its first pitch) is added on top of what the studio received so far.',
  'traj.master': 'Master (every studio)',
  'traj.masterShort': 'Master',
  'traj.sourceEditor': 'editor',
  'traj.window': 'Window',
  'traj.grapher': 'Lines',
  'traj.mean': 'Mean of all lines',
  'traj.pickHint': 'Pick a line (card or click it in the window). Double-click sends it. Order of several sends: ⇄ Sends in the header.',
  'traj.confirm': 'Send',
  'traj.cancel': 'Cancel',
  'traj.none': 'This studio has no line to send.',
  'traj.noSourceHere': 'This studio has no line that can be sent.',
  'traj.sent': (line, to) => `“${line}” sent → ${to}.`,
  'traj.sentLocked': ' The voice is now locked 🔒 in the Glissando Studio.',
  'traj.loopRefused': (path) => `Not sent: it would make a loop (${path}).`,
  'traj.loopSkipped': (list) => ` Skipped (would loop): ${list}.`,
  'traj.selfRefused': 'A studio cannot send to itself.',
  'traj.recvChip': (n, first) => (n === 1 ? `⤵ ${first}` : `⤵ ${n} sends`),
  'traj.chipStage': (k) => `stage ${k}`,
  'traj.linkChipLocked': 'locked',
  'traj.linkChipLinked': 'follows',
  'traj.linkMissing': 'line not found',
  'traj.unlink': 'Stop receiving (keeps the received line)',
  'traj.unlinked': 'This studio no longer receives. The received line stays.',
  'traj.lockTitleLocked': (studios) => `Sent to ${studios}. Locked: changing its shape asks first. Click to allow linked editing (those studios then follow).`,
  'traj.lockTitleLinked': (studios) => `Sent to ${studios}. Linked editing: shape changes flow to those studios. Click to lock again.`,
  'traj.nowLocked': 'Trajectory locked 🔒',
  'traj.nowLinked': (studios) => `Linked editing 🔓 — ${studios} will follow this trajectory.`,
  'traj.guardTitle': 'Locked trajectory',
  'traj.guardMsg': (voice, studios) => `The trajectory “${voice}” is sent to ${studios}. Copy it and continue?`,
  'traj.guardNote': 'Your change was not applied. Copy: edit a duplicate, the original stays as sent. Change without copying: the original becomes editable and the receiving studios follow its shape.',
  'traj.guardCopy': 'Copy',
  'traj.guardLinked': 'Change without copying',
  'traj.guardCancel': 'Cancel',
  'traj.copied': (name) => `Editing the copy “${name}”. The original stays linked and unchanged.`,
  'traj.receivedVoice': 'Written by sends',
});
Object.assign(I18N.ko, {
  'traj.import': '받기',
  'traj.na.chaos': '카오스는 선을 받을 수 없습니다: 선이 끌개 방정식의 해라서 바꿔 넣을 기준선이 없습니다. 보내기는 가능합니다.',
  'traj.na.wave': '웨이브는 선을 받을 수 없습니다: 선이 파동 시뮬레이션의 결과라서 바꿔 넣을 기준선이 없습니다. 보내기는 가능합니다.',
  'traj.send': '보내기',
  'traj.pickTitle': (studio) => `궤적 받기 → ${studio}`,
  'traj.sendTitle': (studio) => `${studio}에서 궤적 보내기`,
  'traj.source': '보내는 곳',
  'traj.dest': '받는 곳',
  'traj.mode': '합치는 방식',
  'traj.mode.replace': '교체',
  'traj.mode.add': '더하기',
  'traj.modeHint.replace': '교체 — 받는 선이 이 선이 됩니다 (그 스튜디오에서 이보다 위에 있는 보내기는 무시됨).',
  'traj.modeHint.add': '더하기 — 이 선의 움직임(음고 − 첫 음고)을 그 스튜디오가 지금까지 받은 선 위에 더합니다.',
  'traj.master': '마스터 (모든 스튜디오)',
  'traj.masterShort': '마스터',
  'traj.sourceEditor': '에디터',
  'traj.window': '윈도우',
  'traj.grapher': '선 목록',
  'traj.mean': '모든 선의 평균',
  'traj.pickHint': '선을 고르세요 (카드 또는 윈도우에서 클릭). 더블클릭하면 바로 보냅니다. 여러 보내기의 순서는 헤더의 ⇄ 보내기에서.',
  'traj.confirm': '보내기',
  'traj.cancel': '취소',
  'traj.none': '이 스튜디오에는 보낼 선이 없습니다.',
  'traj.noSourceHere': '이 스튜디오에는 보낼 수 있는 선이 없습니다.',
  'traj.sent': (line, to) => `“${line}”을(를) ${to}(으)로 보냈습니다.`,
  'traj.sentLocked': ' 글리산도 스튜디오에서는 이 보이스가 잠금 🔒 상태가 됩니다.',
  'traj.loopRefused': (path) => `보내지 않았습니다: 순환이 생깁니다 (${path}).`,
  'traj.loopSkipped': (list) => ` 순환이 생겨 건너뜀: ${list}.`,
  'traj.selfRefused': '스튜디오는 자기 자신에게 보낼 수 없습니다.',
  'traj.recvChip': (n, first) => (n === 1 ? `⤵ ${first}` : `⤵ 보내기 ${n}개`),
  'traj.chipStage': (k) => `${k}단계`,
  'traj.linkChipLocked': '잠금',
  'traj.linkChipLinked': '연동',
  'traj.linkMissing': '선을 찾을 수 없음',
  'traj.unlink': '받기 해제 (받은 선은 유지)',
  'traj.unlinked': '이 스튜디오는 더 이상 받지 않습니다. 받은 선은 그대로 남습니다.',
  'traj.lockTitleLocked': (studios) => `${studios}(으)로 보내진 궤적입니다. 잠금: 모양을 바꾸려 하면 먼저 묻습니다. 클릭하면 연동 편집(해당 스튜디오가 따라옴)으로 바뀝니다.`,
  'traj.lockTitleLinked': (studios) => `${studios}(으)로 보내진 궤적입니다. 연동 편집: 모양 변경이 해당 스튜디오에 반영됩니다. 클릭하면 다시 잠급니다.`,
  'traj.nowLocked': '궤적을 잠갔습니다 🔒',
  'traj.nowLinked': (studios) => `연동 편집 🔓 — ${studios}가 이 궤적을 따라갑니다.`,
  'traj.guardTitle': '잠긴 궤적',
  'traj.guardMsg': (voice, studios) => `이 궤적(“${voice}”)은 ${studios}(으)로 보내진 상태입니다. 복사한 후 진행할까요?`,
  'traj.guardNote': '방금 변경은 적용되지 않았습니다. 복사: 복제본을 편집하고 원본은 보낸 그대로 둡니다. 복사하지 않고 변경: 원본을 편집할 수 있게 되며, 이 궤적을 받는 스튜디오에서도 모양이 자동으로 따라 바뀝니다.',
  'traj.guardCopy': '복사',
  'traj.guardLinked': '복사하지 않고 변경',
  'traj.guardCancel': '취소',
  'traj.copied': (name) => `복제본 “${name}”을 편집합니다. 원본은 연결된 채 그대로입니다.`,
  'traj.receivedVoice': '보내기가 쓰는 보이스',
});

HELP_DB['app.trajImport'] = {
  en: { title: 'Send / Receive trajectory', summary: 'Use a pitch line of one studio as the base line of another — or of every studio (Master).', detail: 'Receive: pick the source studio (and instance) and one of its lines; the line is highlighted in the window. Send: the same window, starting from this studio. To: one studio, or Master = every studio that can receive (except the source). Combine: Replace (the receiving line becomes this line) or Add (this line’s motion — its pitch minus its first pitch — is added on top). What each studio does with it — Cloud: the pitch-centre curve and the length. Tempo: the subject. Fractal: the FIF base line, range and length. Draw: a stroke. Field: the active particle and the guiding curve. Space: the pitch curve of the active source. Glissando: one voice written by the sends. The receiving studio follows its sources from then on; a Glissando voice that is sent is locked 🔒. The chip shows what this studio receives (× stops receiving). When several sends meet, their order is set in ⇄ Sends (header).', formula: '' },
  ko: { title: '궤적 보내기 / 받기', summary: '한 스튜디오의 음고 선을 다른 스튜디오(또는 마스터 = 모든 스튜디오)의 기본 선으로 씁니다.', detail: '받기: 보내는 스튜디오(와 인스턴스), 그리고 그 선 하나를 고르면 윈도우에서 강조됩니다. 보내기: 같은 창을 이 스튜디오에서 시작합니다. 받는 곳: 스튜디오 하나 또는 마스터 = 받을 수 있는 모든 스튜디오(보내는 스튜디오 제외). 합치는 방식: 교체(받는 선이 이 선이 됨) 또는 윤곽 더하기(이 선의 움직임을 위에 더함). 스튜디오별 의미 — 클라우드: 음고 중심 곡선과 길이. 템포: 주제. 프랙탈: FIF 기준선·음역·길이. 드로잉: 스트로크. 필드: 활성 입자와 가이드 곡선. 스페이스: 활성 음원의 음고 곡선. 글리산도: 보내기가 쓰는 보이스 하나. 이후에도 받는 스튜디오가 원본을 따라가며, 보내진 글리산도 보이스는 잠금 🔒 상태가 됩니다. 칩은 이 스튜디오가 받는 것을 보여 줍니다 (×로 해제). 여러 보내기가 만나면 순서는 헤더의 ⇄ 보내기에서 정합니다.', formula: '' },
};
HELP_DB['gliss.trajLock'] = {
  en: { title: 'Sent trajectory lock', summary: 'This voice is sent to another studio. 🔒 protects its shape; 🔓 lets you edit it and the other studio follows.', detail: 'While locked, an edit of the curve, the pitch ends or the timing is taken back and you are asked: Copy (edit a duplicate), Change without copying (switch to linked editing) or Cancel. Name, colour, gain, timbre and tremolo are never locked.', formula: '' },
  ko: { title: '보낸 궤적 잠금', summary: '다른 스튜디오로 보내진 보이스입니다. 🔒는 모양을 보호하고, 🔓는 편집을 허용하며 그 스튜디오가 따라옵니다.', detail: '잠금 상태에서 곡선·음고 끝점·타이밍을 바꾸면 변경이 취소되고 선택지가 나옵니다: 복사(복제본 편집), 복사하지 않고 변경(연동 편집으로 전환), 취소. 이름·색·게인·음색·트레몰로는 잠기지 않습니다.', formula: '' },
};

let hooks = { showToast: () => {}, requestRender: () => {} };

export const studioLabel = (id) => (id === MASTER ? t('traj.masterShort') : t(`studio.${id}`));
const studioList = (voiceId) => linksOfVoice(voiceId).map((x) => studioLabel(x.studio)).join(', ');
export const lineLabel = (line) => (line.key === MEAN_LINE ? t('traj.mean') : line.name || String(line.key));

// ==========================================================================
// 1. Receive / Send buttons + receive chip / 받기·보내기 버튼과 칩
// ==========================================================================

const BTN = 'px-2.5 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 text-sky-200 border border-sky-500/40 text-[11px] font-semibold transition';
const BTN_SEND = 'px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-200 border border-emerald-500/40 text-[11px] font-semibold transition';

/** Send button only (studios that cannot receive: Chaos, Wave). / 보내기 버튼만 */
export function createSendButton(studioId) {
  return el('button', { class: BTN_SEND, text: `⤴ ${t('traj.send')}`, dataset: { help: 'app.trajImport' }, on: { click: () => openSendWindow({ from: studioId }) } });
}

/** Receive + Send buttons (+ receive chip) for a studio's strip. Self-updating. / 스트립용 버튼 (자동 갱신) */
/**
 * Receive button of a studio that cannot take a line (its lines come out of a simulation):
 * it stays in its usual place, switched off, and says why. `reasonKey` = i18n key.
 * 선을 받을 수 없는 스튜디오의 받기 버튼: 제자리에 꺼진 채로 이유를 표시.
 */
export function createReceiveUnavailable(reasonKey) {
  return el('button', { class: `${BTN} opacity-50 cursor-not-allowed`, text: `⤵ ${t('traj.import')}`, title: t(reasonKey), 'aria-disabled': 'true', dataset: { help: 'app.trajImport', receiveOff: reasonKey } });
}

export function createTrajectoryImportButton(studioId) {
  const chip = el('span', { class: 'hidden items-center gap-1 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[11px] text-slate-200', dataset: { trajChip: studioId, help: 'app.trajImport' } });
  const btn = el('button', { class: BTN, text: `⤵ ${t('traj.import')}`, dataset: { help: 'app.trajImport' }, on: { click: () => openSendWindow({ to: studioId }) } });
  const parts = [btn];
  if (isTrajectorySource(studioId)) parts.push(createSendButton(studioId));
  parts.push(chip);
  const root = el('span', { class: 'inline-flex flex-wrap items-center gap-1.5' }, parts);
  updateChip(chip);
  return root;
}

function updateChip(chip) {
  const studioId = chip.dataset.trajChip;
  const plan = buildSendPlan();
  const inbound = (plan.inbound.get(studioId) || []).filter((e) => e.status === 'ok' || e.status === 'away');
  const key = inbound.map((e) => `${e.sendId}|${e.send.locked}|${e.send.from.name}|${e.mode}`).join(';') + `|${plan.stage.get(studioId) ?? ''}|${appState.lang}`;
  if (chip.dataset.key === key) return;
  chip.dataset.key = key;
  chip.classList.toggle('hidden', !inbound.length);
  chip.classList.toggle('inline-flex', !!inbound.length);
  if (!inbound.length) { chip.replaceChildren(); return; }
  const first = inbound[0].send;
  const name = `${studioLabel(first.from.studio)} ▸ ${first.from.line === MEAN_LINE ? t('traj.mean') : first.from.name || first.from.line}`;
  const glissLocked = inbound.filter((e) => e.from === 'glissando');
  const parts = [el('span', { text: t('traj.recvChip', inbound.length, name) })];
  if (glissLocked.length) {
    const locked = glissLocked.some((e) => e.send.locked);
    parts.push(el('span', { class: locked ? 'text-amber-300' : 'text-emerald-300', text: `${locked ? '🔒' : '🔓'} ${t(locked ? 'traj.linkChipLocked' : 'traj.linkChipLinked')}` }));
  }
  parts.push(el('span', { class: 'text-slate-500', text: `· ${t('traj.chipStage', (plan.stage.get(studioId) ?? 0) + 1)}` }));
  parts.push(el('button', { class: 'ml-0.5 text-slate-400 hover:text-rose-300 font-bold', text: '×', title: t('traj.unlink'), on: { click: () => { if (unlinkTrajectory(studioId)) hooks.showToast(t('traj.unlinked')); } } }));
  chip.replaceChildren(...parts);
}

// ==========================================================================
// 2. Send window / 보내기 창
// ==========================================================================

let picker = null;

/** Source options: every sending studio, one entry per Manager instance. / 보내는 곳 목록 (인스턴스별) */
function sourceOptions() {
  ensureManager();
  const out = [];
  for (const studio of listSendSources()) {
    const insts = listInstances().filter((i) => i.studio === studio);
    if (!insts.length) out.push({ value: `${studio}|`, studio, inst: null, label: `${studioLabel(studio)} (${t('traj.sourceEditor')})`, focused: true });
    for (const inst of insts) out.push({ value: `${studio}|${inst.id}`, studio, inst: inst.id, label: `${studioLabel(studio)} · ${inst.name}${isFocused(inst) ? ' ●' : ''}`, focused: isFocused(inst) });
  }
  return out;
}

function closePicker() {
  if (!picker) return;
  picker.root.remove();
  picker = null;
}

function drawPickerCanvas() {
  if (!picker) return;
  const { canvas, lines, selectedKey } = picker;
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);
  const PAD = { left: 38, right: 10, top: 10, bottom: 18 };
  const pw = w - PAD.left - PAD.right;
  const ph = h - PAD.top - PAD.bottom;
  let t0 = Infinity; let t1 = -Infinity; let m0 = Infinity; let m1 = -Infinity;
  for (const l of lines) for (const p of l.pts) if (Number.isFinite(p.t) && Number.isFinite(p.m)) { t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t); m0 = Math.min(m0, p.m); m1 = Math.max(m1, p.m); }
  if (!Number.isFinite(t0)) { t0 = 0; t1 = 4; m0 = 48; m1 = 72; }
  t0 = Math.min(0, t0);
  if (t1 - t0 < 0.5) t1 = t0 + 0.5;
  m0 = Math.floor(m0 - 2); m1 = Math.ceil(m1 + 2);
  if (m1 - m0 < 12) { const c = 0.5 * (m0 + m1); m0 = Math.floor(c - 6); m1 = Math.ceil(c + 6); }
  const X = (s) => PAD.left + ((s - t0) / (t1 - t0)) * pw;
  const Y = (m) => PAD.top + (1 - (m - m0) / (m1 - m0)) * ph;
  picker.map = { X, Y };
  ctx.font = '10px ui-monospace, Menlo, monospace';
  for (let m = m0; m <= m1; m++) {
    const pc = ((m % 12) + 12) % 12;
    if ([1, 3, 6, 8, 10].includes(pc)) { ctx.fillStyle = 'rgba(15,23,42,0.9)'; ctx.fillRect(PAD.left, Y(m + 0.5), pw, Math.max(1, Y(m - 0.5) - Y(m + 0.5))); }
    if (pc === 0) {
      ctx.strokeStyle = 'rgba(56,189,248,0.25)';
      ctx.beginPath(); ctx.moveTo(PAD.left, Y(m)); ctx.lineTo(PAD.left + pw, Y(m)); ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(midiToNoteName(m), 4, Y(m) + 3);
    }
  }
  const step = [0.25, 0.5, 1, 2, 5, 10, 20, 30, 60].find((s) => (t1 - t0) / s <= 10) || 120;
  ctx.fillStyle = '#64748b';
  for (let s = 0; s <= t1 + 1e-9; s += step) {
    ctx.strokeStyle = 'rgba(51,65,85,0.4)';
    ctx.beginPath(); ctx.moveTo(X(s), PAD.top); ctx.lineTo(X(s), PAD.top + ph); ctx.stroke();
    ctx.fillText(`${Number(s.toFixed(2))}s`, X(s) + 2, h - 5);
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD.left, PAD.top, pw, ph); ctx.clip();
  ctx.lineJoin = 'round';
  const PALETTE = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#fb923c', '#22d3ee', '#c084fc'];
  for (const pass of [0, 1]) { // dimmed first, the chosen one on top / 흐린 선 먼저, 선택한 선을 맨 위에
    lines.forEach((l, k) => {
      const on = String(l.key) === String(selectedKey);
      if ((pass === 1) !== on) return;
      ctx.globalAlpha = on || selectedKey == null ? 1 : 0.22;
      ctx.strokeStyle = l.key === MEAN_LINE ? '#f8fafc' : l.color || PALETTE[k % PALETTE.length];
      ctx.lineWidth = on ? 3.2 : 1.6;
      ctx.setLineDash(l.key === MEAN_LINE ? [6, 4] : []);
      ctx.beginPath();
      let pen = false;
      for (const p of l.pts) {
        if (!Number.isFinite(p.t) || !Number.isFinite(p.m)) { pen = false; continue; }
        if (!pen) { ctx.moveTo(X(p.t), Y(p.m)); pen = true; } else ctx.lineTo(X(p.t), Y(p.m));
      }
      ctx.stroke();
    });
  }
  ctx.setLineDash([]);
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#1e293b';
  ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, pw - 1, ph - 1);
}

function renderPickerCards() {
  if (!picker) return;
  const { cards, lines, selectedKey } = picker;
  const linked = picker.studio === 'glissando' ? linkedVoiceIds() : new Set();
  if (!lines.length) { cards.replaceChildren(el('p', { class: 'text-xs text-slate-500', text: t('traj.none') })); return; }
  cards.replaceChildren(...lines.map((l) => {
    const on = String(l.key) === String(selectedKey);
    const fin = l.pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.m));
    const a = fin[0];
    const b = fin[fin.length - 1];
    return el('button', {
      class: `fx-traj-card ${on ? 'is-on' : ''}`,
      dataset: { key: String(l.key) },
      on: { click: () => choose(l.key), dblclick: () => { choose(l.key); confirmPick(); } },
    }, [
      el('span', { class: 'fx-traj-dot', style: `background:${l.key === MEAN_LINE ? '#f8fafc' : l.color || '#38bdf8'}` }),
      el('span', { class: 'flex flex-col items-start min-w-0' }, [
        el('span', { class: 'font-semibold truncate max-w-[150px]', text: `${lineLabel(l)}${linked.has(l.key) ? ' 🔗' : ''}` }),
        a && b ? el('span', { class: 'text-[10px] text-slate-400 font-mono', text: `${midiToNoteName(Math.round(a.m))} → ${midiToNoteName(Math.round(b.m))} · ${a.t.toFixed(2)}–${b.t.toFixed(2)} s` }) : null,
      ]),
    ]);
  }));
}

function choose(key) {
  if (!picker) return;
  picker.selectedKey = key;
  updateConfirm();
  renderPickerCards();
  drawPickerCanvas();
}

function updateConfirm() {
  if (!picker) return;
  picker.confirm.disabled = picker.selectedKey == null || !picker.destSel.value || picker.destSel.value === picker.studio;
}

function fillDest() {
  const { destSel } = picker;
  const keep = destSel.value || picker.wantTo;
  const opts = [[MASTER, t('traj.master')], ...listSendTargets().filter((s) => s !== picker.studio).map((s) => [s, studioLabel(s)])];
  destSel.replaceChildren(...opts.map(([v, label]) => el('option', { value: v, text: label })));
  destSel.value = opts.some(([v]) => v === keep) ? keep : opts[1]?.[0] || MASTER;
}

function setSource(value) {
  if (!picker) return;
  const opt = sourceOptions().find((o) => o.value === value) || sourceOptions()[0];
  picker.studio = opt.studio;
  picker.inst = opt.inst;
  picker.focusedSrc = opt.focused;
  picker.lines = listSourceLines(opt.studio, opt.inst);
  fillDest();
  const active = opt.studio === 'glissando' && opt.focused ? appState.activeVoiceId : null;
  const pick = picker.lines.find((l) => l.key === active) || picker.lines[0];
  choose(pick ? pick.key : null);
}

function confirmPick() {
  if (!picker || picker.selectedKey == null || picker.confirm.disabled) return;
  const { studio, inst, focusedSrc, selectedKey, lines } = picker;
  const to = picker.destSel.value;
  const mode = picker.mode;
  const line = lines.find((l) => String(l.key) === String(selectedKey));
  closePicker();
  // A Glissando voice of another instance: bring that instance into the editor first, so its lock
  // refers to the document on screen. / 다른 글리산도 인스턴스의 보이스면 먼저 에디터로 가져옴 (잠금 대상)
  if (studio === 'glissando' && !focusedSrc && inst) focusInstance(inst);
  const res = addSend({ from: { studio, line: selectedKey, name: line ? lineLabel(line) : String(selectedKey), inst: studio === 'glissando' ? getFocusedId('glissando') : inst }, to, mode });
  if (!res.ok) {
    if (res.reason === 'loop') hooks.showToast(t('traj.loopRefused', (res.path || []).map(studioLabel).join(' → ')), 'error');
    else if (res.reason === 'self') hooks.showToast(t('traj.selfRefused'), 'error');
    return;
  }
  const locked = studio === 'glissando' && selectedKey !== receivedVoiceId();
  hooks.showToast(t('traj.sent', line ? lineLabel(line) : selectedKey, studioLabel(to)) + (locked ? t('traj.sentLocked') : '') + (res.loops?.length ? t('traj.loopSkipped', res.loops.map(studioLabel).join(', ')) : ''));
}

/**
 * Open the Send window. `from` = source studio (Send button), `to` = receiving studio (Receive button).
 * 보내기 창 열기 (from = 보내는 스튜디오, to = 받는 스튜디오).
 */
export function openSendWindow({ from = null, to = null } = {}) {
  if (to && !isTrajectoryTarget(to)) return;
  if (from && !isTrajectorySource(from)) { hooks.showToast(t('traj.noSourceHere')); return; }
  closePicker();
  const opts = sourceOptions();
  const startStudio = from || 'glissando';
  const start = opts.find((o) => o.studio === startStudio && o.focused) || opts.find((o) => o.studio === startStudio) || opts[0];
  const select = el('select', { class: 'fx-traj-select', on: { change: (e) => setSource(e.target.value) } }, opts.map((o) => el('option', { value: o.value, text: o.label })));
  const destSel = el('select', { class: 'fx-traj-select', on: { change: updateConfirm } });
  const modeHint = el('p', { class: 'text-[11px] text-slate-400' });
  const modeBtns = ['replace', 'add'].map((m) => el('button', { class: 'fx-traj-seg', dataset: { mode: m }, text: t(`traj.mode.${m}`), on: { click: () => setMode(m) } }));
  const setMode = (m) => {
    picker.mode = m;
    for (const b of modeBtns) b.classList.toggle('is-on', b.dataset.mode === m);
    modeHint.textContent = t(`traj.modeHint.${m}`);
  };
  const canvas = el('canvas', { class: 'w-full h-full block rounded-lg' });
  const cards = el('div', { class: 'fx-traj-cards' });
  const confirm = el('button', { class: 'fx-traj-btn primary', text: `⤴ ${t('traj.confirm')}`, on: { click: confirmPick } });
  const title = to ? t('traj.pickTitle', studioLabel(to)) : t('traj.sendTitle', studioLabel(startStudio));
  const dialog = el('div', { class: 'fx-traj-dialog', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('h2', { class: 'text-sm font-bold text-sky-200', text: title }),
      el('button', { class: 'text-slate-400 hover:text-white text-lg leading-none', text: '×', title: t('traj.cancel'), on: { click: closePicker } }),
    ]),
    el('div', { class: 'flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-300' }, [
      el('label', { class: 'flex items-center gap-2' }, [t('traj.source'), select]),
      el('span', { class: 'text-slate-500', text: '→' }),
      el('label', { class: 'flex items-center gap-2' }, [t('traj.dest'), destSel]),
      el('span', { class: 'flex items-center gap-1' }, [t('traj.mode'), el('span', { class: 'fx-traj-segs' }, modeBtns)]),
    ]),
    modeHint,
    el('div', { class: 'fx-traj-body' }, [
      el('div', { class: 'flex flex-col gap-1 min-w-0' }, [el('span', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400', text: t('traj.window') }), el('div', { class: 'fx-traj-canvas' }, [canvas])]),
      el('div', { class: 'flex flex-col gap-1 min-w-0' }, [el('span', { class: 'text-[10px] font-bold uppercase tracking-wider text-slate-400', text: t('traj.grapher') }), cards]),
    ]),
    el('p', { class: 'text-[11px] text-slate-400', text: t('traj.pickHint') }),
    el('div', { class: 'flex justify-end gap-2' }, [el('button', { class: 'fx-traj-btn', text: t('traj.cancel'), on: { click: closePicker } }), confirm]),
  ]);
  const root = el('div', { class: 'fx-traj-root', on: { pointerdown: (e) => { if (e.target === root) closePicker(); } } }, [dialog]);
  root.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep Space / Enter / Esc away from the transport shortcuts / 트랜스포트 단축키와 분리
    if (e.key === 'Escape') closePicker();
    else if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); confirmPick(); }
  });
  canvas.addEventListener('pointerdown', (e) => { // click a line = choose it / 선을 클릭해도 선택
    const m = picker?.map;
    if (!m) return;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.clientWidth;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.clientHeight;
    let best = null;
    let bestD = 14;
    for (const l of picker.lines) for (const p of l.pts) { if (!Number.isFinite(p.m)) continue; const d = Math.hypot(m.X(p.t) - x, m.Y(p.m) - y); if (d < bestD) { bestD = d; best = l.key; } }
    if (best != null) choose(best);
  });
  document.body.append(root);
  picker = { root, canvas, cards, confirm, destSel, wantTo: to, studio: null, inst: null, focusedSrc: true, lines: [], selectedKey: null, map: null, mode: 'replace' };
  setMode('replace');
  select.value = start.value;
  setSource(start.value);
  requestAnimationFrame(drawPickerCanvas);
  setTimeout(() => { drawPickerCanvas(); confirm.focus(); }, 30);
}

/** Kept name: the Receive window of a studio. / 예전 이름: 받기 창 */
export const openTrajectoryPicker = (target) => openSendWindow({ to: target });

// ==========================================================================
// 3. Lock button on Glissando voice cards / 글리산도 보이스 카드의 잠금 버튼
// ==========================================================================

function decorateVoiceCards() {
  const box = document.getElementById('voiceCardsContainer');
  if (!box) return;
  const linked = linkedVoiceIds();
  const managed = receivedVoiceId();
  for (const card of box.querySelectorAll('[data-id]')) {
    const id = card.dataset.id;
    let btn = card.querySelector('.fx-traj-lock');
    const isManaged = id === managed;
    if (!linked.has(id) && !isManaged) { btn?.remove(); continue; }
    const links = linksOfVoice(id);
    const locked = !isManaged && links.some((x) => x.link.locked);
    const key = `${isManaged}|${locked}|${links.map((x) => x.studio).join()}|${appState.lang}`;
    if (btn && btn.dataset.key === key) continue;
    btn?.remove();
    btn = el('button', {
      class: `fx-traj-lock ${isManaged ? 'is-received' : locked ? 'is-locked' : 'is-linked'}`,
      text: isManaged ? '⤵' : locked ? '🔒' : '🔓',
      title: isManaged ? t('traj.receivedVoice') : t(locked ? 'traj.lockTitleLocked' : 'traj.lockTitleLinked', studioList(id)),
      dataset: { key, help: 'gliss.trajLock' },
      on: {
        click: (e) => {
          e.stopPropagation();
          if (isManaged) return;
          setVoiceLinksLocked(id, !locked);
          hooks.showToast(locked ? t('traj.nowLinked', studioList(id)) : t('traj.nowLocked'));
        },
        dblclick: (e) => e.stopPropagation(),
      },
    });
    card.append(btn);
  }
}

// ==========================================================================
// 4. Guard dialog / 잠금 경고 대화상자
// ==========================================================================

let guard = null;

function closeGuard() {
  guard?.root.remove();
  guard = null;
}

function openGuard(voiceId) {
  if (guard) return;
  const voice = getVoiceById(voiceId);
  if (!voice) return;
  const studios = studioList(voiceId);
  const act = (fn) => () => { closeGuard(); fn(); };
  const copy = el('button', { class: 'fx-traj-btn primary', text: t('traj.guardCopy'), on: { click: act(() => {
    selectVoice(voiceId);
    const ev = duplicateVoice(voiceId);
    if (ev?.result) hooks.showToast(t('traj.copied', ev.result.name));
  }) } });
  const linked = el('button', { class: 'fx-traj-btn', text: t('traj.guardLinked'), on: { click: act(() => {
    setVoiceLinksLocked(voiceId, false);
    hooks.showToast(t('traj.nowLinked', studios));
  }) } });
  const cancel = el('button', { class: 'fx-traj-btn', text: t('traj.guardCancel'), on: { click: act(() => {}) } });
  const dialog = el('div', { class: 'fx-traj-dialog small', role: 'alertdialog', 'aria-modal': 'true' }, [
    el('h2', { class: 'text-sm font-bold text-amber-300', text: `🔒 ${t('traj.guardTitle')}` }),
    el('p', { class: 'text-sm text-slate-100', text: t('traj.guardMsg', voice.name, studios) }),
    el('p', { class: 'text-[11px] text-slate-400', text: t('traj.guardNote') }),
    el('div', { class: 'flex flex-wrap justify-end gap-2' }, [cancel, linked, copy]),
  ]);
  const root = el('div', { class: 'fx-traj-root' }, [dialog]);
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeGuard();
  });
  document.body.append(root);
  guard = { root };
  setTimeout(() => copy.focus(), 0); // Copy is the default (Enter) / 복사가 기본값
}

// ==========================================================================
// 5. Guard + evaluation, driven by state events / 상태 이벤트 기반 보호·평가
// ==========================================================================

let busy = false;
const shadows = new Map(); // voice id → last protected voice object (deep copy) / 마지막으로 보호된 보이스 사본
const changeListeners = new Set();

/** Called after every evaluation (the order tool redraws). / 평가 후 호출 */
export function onSendsChanged(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function refreshShadows() {
  const ids = linkedVoiceIds();
  for (const id of [...shadows.keys()]) if (!ids.has(id)) shadows.delete(id);
  for (const id of ids) {
    const v = getVoiceById(id);
    if (v) shadows.set(id, JSON.parse(JSON.stringify(v)));
  }
}

function onStateEvent(e) {
  if (busy || isEvaluatingSends()) return;
  const scope = e.scope;
  if (scope && scope.size === 1 && (scope.has('transport') || scope.has('view') || scope.has('lang'))) return;
  if (typeof e.type === 'string' && e.type.startsWith('sends/') && !e.historyChanged && e.type !== 'sends/commit') return;
  busy = true;
  try {
    const isHistory = typeof e.type === 'string' && e.type.startsWith('history/');
    let blocked = null;
    if (!isHistory) {
      let bad = findLockedViolations();
      if (bad.length) {
        blocked = bad[0].voice.id;
        if (e.historyChanged && canUndo()) {
          undo(); // take the edit back …
          const h = appState.history;
          h.stack.splice(h.index + 1); // … and drop it, so Redo cannot bring it back / 다시 실행으로도 되살릴 수 없게 제거
          bad = findLockedViolations();
        }
        for (const x of bad) { // edits made without an undo step: restore the protected shape / 실행 취소 단계 없는 편집은 사본으로 복원
          const keep = shadows.get(x.voice.id);
          const live = getVoiceById(x.voice.id);
          if (keep && live && trajectorySignature(keep) === x.link.sig) {
            for (const k of Object.keys(live)) if (!(k in keep)) delete live[k];
            Object.assign(live, JSON.parse(JSON.stringify(keep)));
          }
        }
        hooks.requestRender(['all']);
      }
    }
    const written = evaluateSends();
    if (written.length) hooks.requestRender(['all']);
    refreshShadows();
    if (blocked) openGuard(blocked);
  } catch (err) {
    console.error('[Flexatone] trajectory send error:', err);
  } finally {
    busy = false;
  }
  for (const chip of document.querySelectorAll('[data-traj-chip]')) updateChip(chip);
  decorateVoiceCards();
  for (const fn of changeListeners) { try { fn(); } catch (err) { console.error(err); } }
}

export function initTrajectoryUi(h) {
  hooks = { ...hooks, ...h };
  subscribe(onStateEvent);
  const box = document.getElementById('voiceCardsContainer');
  if (box && globalThis.MutationObserver) new MutationObserver(decorateVoiceCards).observe(box, { childList: true });
  globalThis.addEventListener('resize', drawPickerCanvas);
  refreshShadows();
  decorateVoiceCards();
}

export { getTrajLink };
