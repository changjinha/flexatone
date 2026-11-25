/**
 * Flexatone — ui/studio-monitors.js
 * Layer 4 (ui): the blocks every studio has by default.
 *   Monitors (right column of the split layout, ui/rack-layout.js):
 *     - main monitor   — the studio's own canvas (unchanged)
 *     - Voices         — multi-voice graph: one card per pitch line the studio makes. A studio that already
 *                        has its own voice list (data-window="list": Glissando grapher, Field particles, Draw
 *                        strokes, Tempo voices, Space sources) keeps it and gets no second one.
 *     - Timeline       — one lane per line over the studio's time, with playhead and cue. Space keeps its own
 *                        (space-timeline).
 *   Toolbox ③ Send & export: Send… (the Send window, ui/trajectory-ui.js) and "Export curves" — every line
 *     as t / MIDI / Hz / slope / curvature (JSON).
 *   Toolbox ③ Send to Space Studio: one click sets up a Space source that imports this studio (live link).
 *   Toolbox ④ Chain: the signal path of the studio as a patch (ui/rack-layout.js getToolChain).
 * 계층 4 (ui): 모든 스튜디오의 기본 블록. 모니터 = 주 모니터 · 보이스 목록(다중 보이스 그래프) · 타임라인,
 * 툴박스 ③ 후처리 = 보내기 · 스페이스 스튜디오로 보내기 · 곡률 내보내기. 자체 보이스 목록·타임라인이 있는
 * 스튜디오는 그것을 그대로 씁니다 (중복 없음).
 *
 * The lines come from the Send sources (studios/trajectory-link.js listSourceLines), so the monitors show
 * exactly what a Send would take. Read-only: nothing here edits a document.
 * 선은 보내기 소스(listSourceLines)에서 오므로 보내기가 가져갈 선과 같습니다. 읽기 전용.
 */

import { appState, dispatch, selectVoice } from '../core/state.js';
import { t, I18N } from '../core/i18n.js';
import { midiToFreq, midiToNoteName } from '../core/units.js';
import { StudioRegistry } from '../studios/registry.js';
import { listSourceLines, isTrajectorySource, MEAN_LINE } from '../studios/trajectory-link.js';
import { openSendWindow } from './trajectory-ui.js';
import { openStudioVideoDialog } from './studio-video.js';
import { HELP_DB } from './option-inspector.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { describeInstance } from '../audio/instance-source.js';
import { getSpaceParams, editSpace } from '../studios/space-studio.js';
import { createSource } from '../studios/space/space-engine.js';
import { setChainDestination, getToolChain, setModuleActive } from './rack-layout.js';
import { renderPatcher, patcherSig, resetFlow, onFlowChange } from './signal-flow.js';
import { buildAutomationUI, renderAutomationUI, tickAutomation, shownLanes, drawLane, lanePointerDown, laneDblClick, laneContext, automationModuleChanged } from './automation.js';

Object.assign(I18N.en, {
  'modlist.title': 'Module List',
  'sm.voices': 'Module List',
  'sm.voices.sub': 'voices · multi-voice graph',
  'sm.timeline': 'Timeline',
  'sm.timeline.sub': 'one lane per voice',
  'sm.noSource': 'This studio makes no separate pitch lines (an endless field), so there is nothing to list here.',
  'sm.noLines': 'No voice yet.',
  'sm.post': 'Send & export',
  'sm.send': '⤴ Send…',
  'sm.sendSpace': '⤴ Space Studio',
  'sm.sendSpaceTip': 'Send a line of this studio to the Space Studio (it becomes the path pitch there)',
  'sm.sendSpaceSelf': 'This is the Space Studio — send from another studio',
  'sm.sendOff': 'This studio has no line to send',
  'sm.export': '⤓ Export curves',
  'sm.exportTip': 'Every line as JSON: t (s), MIDI, Hz, slope (st/s) and curvature',
  'sm.exportNone': 'No line to export.',
  'sm.exported': (n) => `Exported ${n} line${n === 1 ? '' : 's'} (t, MIDI, Hz, slope, curvature).`,
  'sm.lines': (n) => `${n} line${n === 1 ? '' : 's'}`,
  'ts.title': 'Send to Space Studio',
  'ts.send': '⤴ Send to Space Studio',
  'ts.resend': '↻ Re-create the Space source',
  'ts.open': 'Open Space Studio ↗',
  'ts.auto': 'Live link',
  'ts.autoTip': 'On: the Space source keeps importing this studio as you work (sound and length follow every edit)',
  'ts.none': 'Not sent yet. One click makes a Space source that plays this studio (import, its length, a pass-by path) — ready to work on in the Space Studio.',
  'ts.linked': (name, sec) => `Space source “${name}” imports this studio · ${sec.toFixed(1)} s · follows every edit`,
  'ts.paused': (name) => `Space source “${name}” exists · live link off (its length no longer follows)`,
  'ts.missing': 'The Space source of this studio was removed.',
  'ts.self': 'This is the Space Studio — every studio sends here.',
  'ts.incoming': (list) => `Receiving from: ${list}`,
  'ts.incomingNone': 'No studio sends here yet. Use “Send to Space Studio” in another studio.',
  'ts.done': (name) => `Sent to the Space Studio as “${name}”.`,
  'ts.empty': 'This studio is silent — nothing to send yet.',
  'ch.title': 'Signal flow',
  'ch.sub': 'who sends to whom in this studio',
  'ch.off': 'Off (click to switch on):',
  'ch.allOn': 'Every signal toolbox is on.',
  'ch.spaceDst': (name) => `Space Studio ▸ ${name}`,
});
Object.assign(I18N.ko, {
  'modlist.title': '모듈 리스트',
  'sm.voices': '모듈 리스트',
  'sm.voices.sub': '보이스 · 다중 보이스 그래프',
  'sm.timeline': '타임라인',
  'sm.timeline.sub': '보이스마다 한 줄',
  'sm.noSource': '이 스튜디오는 따로 떨어진 음고 선을 만들지 않습니다(끝없는 음장). 그래서 여기에 표시할 선이 없습니다.',
  'sm.noLines': '아직 보이스가 없습니다.',
  'sm.post': '보내기 · 내보내기',
  'sm.send': '⤴ 보내기…',
  'sm.sendSpace': '⤴ 스페이스 스튜디오',
  'sm.sendSpaceTip': '이 스튜디오의 선을 스페이스 스튜디오로 보냅니다 (그곳에서 경로의 음고가 됨)',
  'sm.sendSpaceSelf': '여기가 스페이스 스튜디오입니다 — 다른 스튜디오에서 보내세요',
  'sm.sendOff': '이 스튜디오에는 보낼 선이 없습니다',
  'sm.export': '⤓ 곡률 내보내기',
  'sm.exportTip': '모든 선을 JSON으로: t(초), MIDI, Hz, 기울기(반음/초), 곡률',
  'sm.exportNone': '내보낼 선이 없습니다.',
  'sm.exported': (n) => `선 ${n}개를 내보냈습니다 (t, MIDI, Hz, 기울기, 곡률).`,
  'sm.lines': (n) => `선 ${n}개`,
  'ts.title': '스페이스 스튜디오로 보내기',
  'ts.send': '⤴ 스페이스 스튜디오로 보내기',
  'ts.resend': '↻ 스페이스 음원 다시 만들기',
  'ts.open': '스페이스 스튜디오 열기 ↗',
  'ts.auto': '실시간 연결',
  'ts.autoTip': '켜짐: 작업하는 동안 스페이스 음원이 이 스튜디오를 계속 가져옵니다 (소리와 길이가 모든 편집을 따라감)',
  'ts.none': '아직 보내지 않았습니다. 한 번 누르면 이 스튜디오를 재생하는 스페이스 음원(가져오기, 같은 길이, 지나가는 경로)이 만들어져 스페이스 스튜디오에서 바로 작업할 수 있습니다.',
  'ts.linked': (name, sec) => `스페이스 음원 “${name}”이 이 스튜디오를 가져옴 · ${sec.toFixed(1)}초 · 모든 편집을 따라감`,
  'ts.paused': (name) => `스페이스 음원 “${name}” 있음 · 실시간 연결 꺼짐 (길이가 더 이상 따라가지 않음)`,
  'ts.missing': '이 스튜디오의 스페이스 음원이 삭제되었습니다.',
  'ts.self': '여기가 스페이스 스튜디오입니다 — 모든 스튜디오가 이곳으로 보냅니다.',
  'ts.incoming': (list) => `받는 중: ${list}`,
  'ts.incomingNone': '아직 이곳으로 보내는 스튜디오가 없습니다. 다른 스튜디오에서 “스페이스 스튜디오로 보내기”를 쓰세요.',
  'ts.done': (name) => `스페이스 스튜디오에 “${name}”(으)로 보냈습니다.`,
  'ts.empty': '이 스튜디오는 소리가 없습니다 — 아직 보낼 것이 없습니다.',
  'ch.title': '시그널 플로우',
  'ch.sub': '이 스튜디오에서 누가 누구에게 보내는지',
  'ch.off': '꺼짐 (클릭하면 켜짐):',
  'ch.allOn': '모든 신호 툴박스가 켜져 있습니다.',
  'ch.spaceDst': (name) => `스페이스 스튜디오 ▸ ${name}`,
});
HELP_DB['app.sharedVoices'] = {
  en: { title: 'Voices (multi-voice graph)', summary: 'One card per pitch line this studio makes, with its colour, pitch range, time span and a small contour. Click a card to mark its lane in the timeline.', detail: 'The lines are the ones a Send would take (the same list as in the Send window). Studios with their own voice list (Glissando, Field, Draw, Tempo, Space) use that one instead.', formula: '' },
  ko: { title: '보이스 (다중 보이스 그래프)', summary: '이 스튜디오가 만드는 음고 선마다 카드 하나 — 색, 음역, 시간 구간, 작은 윤곽. 카드를 클릭하면 타임라인에서 그 줄이 표시됩니다.', detail: '선은 보내기가 가져갈 선과 같습니다(보내기 창의 목록과 동일). 자체 보이스 목록이 있는 스튜디오(글리산도·필드·드로우·템포·스페이스)는 그 목록을 씁니다.', formula: '' },
};
HELP_DB['app.sharedTimeline'] = {
  en: { title: 'Timeline', summary: 'Each voice of the studio as a lane over time, with its pitch contour inside the lane, the playhead and the cue.', detail: 'Read-only overview of when each line sounds. Drag the corner handle to make it taller; ⛶ shows it full screen. The Space Studio keeps its own editable timeline.', formula: '' },
  ko: { title: '타임라인', summary: '스튜디오의 보이스마다 시간 위의 한 줄 — 줄 안에 음고 윤곽, 재생 헤드와 큐.', detail: '각 선이 언제 울리는지 보여 주는 읽기 전용 개요입니다. 모서리 손잡이로 높이를 바꾸고, ⛶로 전체화면. 스페이스 스튜디오는 편집 가능한 자체 타임라인을 씁니다.', formula: '' },
};
HELP_DB['app.studioPost'] = {
  en: { title: 'Send & export', summary: 'After the studio: send one of its lines to another studio or straight to the Space Studio, or export every line with its slope and curvature.', detail: 'Send… opens the Send window with this studio as the source; Space Studio opens it with the Space Studio as destination. Export curves writes JSON: per line, samples of t (s), MIDI, Hz, slope dm/dt (semitones per second) and curvature κ = |m″| / (1 + m′²)^1.5 (m in semitones, t in seconds).', formula: 'κ = |m″| / (1 + m′²)^{3/2}' },
  ko: { title: '보내기 · 내보내기', summary: '스튜디오 이후 단계: 선 하나를 다른 스튜디오나 곧바로 스페이스 스튜디오로 보내거나, 모든 선을 기울기·곡률과 함께 내보냅니다.', detail: '보내기…는 이 스튜디오를 원본으로 보내기 창을 엽니다. 스페이스 스튜디오는 목적지를 스페이스 스튜디오로 정해 엽니다. 곡률 내보내기는 선마다 t(초), MIDI, Hz, 기울기 dm/dt(반음/초), 곡률 κ = |m″| / (1 + m′²)^1.5 (m = 반음, t = 초)를 JSON으로 씁니다.', formula: 'κ = |m″| / (1 + m′²)^{3/2}' },
};

HELP_DB['app.toSpace'] = {
  en: { title: 'Send to Space Studio', summary: 'One click sets the Space Studio up to play this studio: a new Space source imports this studio\'s sound, gets its length and a pass-by path, and is selected there — open the Space Studio and work on it right away.', detail: 'With Live link on, the source keeps importing the current state of this studio (every edit is heard in Space; the length follows). Switch it off to keep the source as it is. The chain of this studio then ends in the Space Studio (ports and Chain toolbox). One source per studio; sending again re-uses it.', formula: '' },
  ko: { title: '스페이스 스튜디오로 보내기', summary: '한 번 누르면 스페이스 스튜디오가 이 스튜디오를 재생하도록 준비됩니다: 새 스페이스 음원이 이 스튜디오의 소리를 가져오고, 같은 길이와 지나가는 경로를 받아 선택된 상태가 됩니다 — 스페이스 스튜디오를 열어 바로 작업하세요.', detail: '실시간 연결이 켜져 있으면 음원이 이 스튜디오의 현재 상태를 계속 가져옵니다(모든 편집이 스페이스에서 들리고 길이도 따라감). 끄면 음원이 지금 상태로 남습니다. 이 스튜디오의 체인은 스페이스 스튜디오에서 끝납니다(포트·체인 툴박스). 스튜디오마다 음원 하나, 다시 보내면 같은 음원을 씁니다.', formula: '' },
};
HELP_DB['app.chainView'] = {
  en: { title: 'Chain', summary: 'The signal path of this studio at a glance, like a patcher: monitors → the switched-on ① ② ③ toolboxes in order → the destination (Output or the Space Studio).', detail: 'Click a box to jump to that toolbox. Dimmed chips below are switched off; click one to switch it on — it joins the chain in its group.', formula: '' },
  ko: { title: '체인', summary: '이 스튜디오의 신호 경로를 패처처럼 한눈에: 모니터 → 켜진 ① ② ③ 툴박스 순서 → 목적지(출력 또는 스페이스 스튜디오).', detail: '상자를 클릭하면 그 툴박스로 이동합니다. 아래의 흐린 칩은 꺼진 툴박스이며, 클릭하면 켜져 자기 묶음 순서대로 체인에 들어갑니다.', formula: '' },
};

const PALETTE = ['#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#34d399', '#fb7185', '#60a5fa', '#f97316', '#2dd4bf'];
const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BTN = 'px-2.5 py-1 rounded-lg text-[11px] font-semibold transition border';
const BTN_ON = `${BTN} bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-200 border-emerald-500/40`;
const BTN_SKY = `${BTN} bg-sky-600/20 hover:bg-sky-600/40 text-sky-200 border-sky-500/40`;

let hooks = { showToast: () => {} };
const nodes = { voices: null, timeline: null, post: null, toSpace: null, chain: null };
let cache = { sig: null, studio: null, lines: [], pending: null };
let sel = null; // key of the marked line / 표시한 선의 키
let lastLang = null;

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function head(titleKey, subKey, help) {
  const row = mk('div', 'flex flex-wrap items-center gap-2');
  const name = mk('span', 'text-xs font-bold uppercase tracking-wider text-sky-400', t(titleKey));
  name.dataset.help = help;
  const sub = mk('span', 'text-[10.5px] text-slate-500', t(subKey));
  const badge = mk('span', 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] font-mono text-slate-300', '0');
  badge.dataset.smBadge = '1';
  row.append(name, sub, badge);
  return row;
}

function buildVoices() {
  const s = mk('section', SECTION);
  Object.assign(s.dataset, { window: 'list', sharedMonitor: 'voices', rack: 'shared-voices', help: 'app.sharedVoices' });
  s.append(head('sm.voices', 'sm.voices.sub', 'app.sharedVoices'), mk('div', 'fx-sm-cards'));
  return s;
}

function buildTimeline() {
  const s = mk('section', SECTION);
  Object.assign(s.dataset, { window: '1', monitor: 'timeline', sharedMonitor: 'timeline', rack: 'shared-timeline', help: 'app.sharedTimeline' });
  const host = mk('div', 'relative w-full rounded-lg overflow-hidden border border-slate-800 bg-slate-950');
  host.style.height = '120px';
  host.dataset.autoH = '120';
  const cv = mk('canvas', 'w-full h-full block');
  cv.addEventListener('pointerdown', onTimelineDown);
  cv.addEventListener('dblclick', onTimelineDbl);
  cv.addEventListener('contextmenu', onTimelineContext);
  host.append(cv);
  // automation (ui/automation.js): button in the header, picker under it, node readout under the canvas
  // 오토메이션: 헤더 버튼, 그 아래 선택기, 캔버스 아래 노드 값
  const au = buildAutomationUI({ redraw: () => draw(), toast: (m) => hooks.showToast(m), pos: (e) => canvasPos(cv, e), nameOf: (key) => cache.lines.find((l) => l.key === key)?.name });
  const hd = head('sm.timeline', 'sm.timeline.sub', 'app.sharedTimeline');
  hd.append(mk('span', 'flex-1'), au.btn);
  s.append(hd, au.picker, host, au.readout);
  return s;
}

function buildPost() {
  const s = mk('section', SECTION);
  Object.assign(s.dataset, { rack: 'studio-post', toolCat: 'post', help: 'app.studioPost' });
  const title = mk('span', 'text-xs font-bold uppercase tracking-wider text-emerald-400', t('sm.post'));
  title.dataset.help = 'app.studioPost';
  const row = mk('div', 'flex flex-wrap items-center gap-1.5');
  const send = mk('button', BTN_ON, t('sm.send'));
  send.type = 'button';
  send.dataset.smAct = 'send';
  send.dataset.help = 'app.trajImport';
  const exp = mk('button', BTN_SKY, t('sm.export'));
  exp.type = 'button';
  exp.dataset.smAct = 'export';
  exp.dataset.help = 'app.studioPost';
  exp.title = t('sm.exportTip');
  const vid = mk('button', `${BTN} bg-rose-600/20 hover:bg-rose-600/40 text-rose-200 border-rose-500/40`, t('svid.button'));
  vid.type = 'button';
  vid.dataset.smAct = 'video';
  vid.dataset.help = 'app.studioVideo';
  vid.title = t('svid.buttonTip');
  const note = mk('span', 'text-[10.5px] text-slate-500');
  note.dataset.smNote = '1';
  row.append(send, exp, vid, note);
  s.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sm-act]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const studio = StudioRegistry.resolveStudioId();
    if (b.dataset.smAct === 'send') openSendWindow({ from: studio });
    else if (b.dataset.smAct === 'export') exportCurves(studio);
    else if (b.dataset.smAct === 'video') openStudioVideoDialog({ hooks });
  });
  s.append(mk('div', 'flex items-center gap-2', null), row);
  s.firstChild.append(title);
  return s;
}

function setOff(btn, off, reason, tip) {
  btn.classList.toggle('opacity-50', off);
  btn.classList.toggle('cursor-not-allowed', off);
  btn.setAttribute('aria-disabled', off ? 'true' : 'false');
  btn.title = off ? reason : tip || '';
}

// ==========================================================================
// Lines / 선
// ==========================================================================

const docRef = (studio) => (studio === 'glissando' ? appState.voices : appState.studioParams?.[studio]);

/** Lines of the studio on screen (cached per document; recomputed at most every 150 ms). / 선 (캐시) */
function currentLines(studio) {
  const ref = docRef(studio);
  if (cache.studio === studio && cache.ref === ref) return cache.lines;
  if (cache.studio !== studio) { cache = { studio, ref: undefined, lines: [], pending: null }; computeLines(studio); return cache.lines; }
  if (!cache.pending) {
    cache.pending = setTimeout(() => {
      cache.pending = null;
      if (StudioRegistry.resolveStudioId() !== studio) return;
      computeLines(studio);
      draw();
    }, 150);
  }
  return cache.lines;
}

function computeLines(studio) {
  const ref = docRef(studio);
  let lines = [];
  try { lines = listSourceLines(studio).filter((l) => l.key !== MEAN_LINE); } catch (err) { console.error('[Flexatone] shared monitors:', err); }
  lines = lines.map((l, i) => {
    const pts = l.pts.filter((p) => Number.isFinite(p.t));
    let t0 = Infinity;
    let t1 = -Infinity;
    let m0 = Infinity;
    let m1 = -Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p.m)) continue;
      t0 = Math.min(t0, p.t); t1 = Math.max(t1, p.t);
      m0 = Math.min(m0, p.m); m1 = Math.max(m1, p.m);
    }
    return { key: String(l.key), name: l.name || String(l.key), color: l.color || PALETTE[i % PALETTE.length], pts, t0, t1, m0, m1, first: pts.find((p) => Number.isFinite(p.m))?.m, last: [...pts].reverse().find((p) => Number.isFinite(p.m))?.m };
  }).filter((l) => Number.isFinite(l.t0));
  cache = { ...cache, studio, ref, lines };
}

// ==========================================================================
// Curve export / 곡률 내보내기
// ==========================================================================

/** Slope and curvature of a sampled line (central differences, gaps kept). / 기울기와 곡률 */
export function curveSamples(pts) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.m)) continue;
    const a = pts[i - 1] && Number.isFinite(pts[i - 1].m) ? pts[i - 1] : null;
    const b = pts[i + 1] && Number.isFinite(pts[i + 1].m) ? pts[i + 1] : null;
    let d1 = 0;
    let d2 = 0;
    if (a && b && b.t > a.t) {
      d1 = (b.m - a.m) / (b.t - a.t);
      const h1 = p.t - a.t;
      const h2 = b.t - p.t;
      if (h1 > 0 && h2 > 0) d2 = (2 * ((b.m - p.m) / h2 - (p.m - a.m) / h1)) / (h1 + h2);
    } else if (b && b.t > p.t) d1 = (b.m - p.m) / (b.t - p.t);
    else if (a && p.t > a.t) d1 = (p.m - a.m) / (p.t - a.t);
    const k = Math.abs(d2) / Math.pow(1 + d1 * d1, 1.5);
    const r = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
    out.push({ t: r(p.t, 4), midi: r(p.m, 4), hz: r(midiToFreq(p.m), 3), slope: r(d1, 4), curvature: r(k, 5) });
  }
  return out;
}

function exportCurves(studio) {
  computeLines(studio);
  const lines = cache.lines;
  if (!lines.length) { hooks.showToast(t('sm.exportNone')); return; }
  const data = {
    format: 'flexatone.curves.v1',
    studio,
    units: { t: 's', midi: 'MIDI note (69 = A4)', hz: 'Hz', slope: 'semitones / s', curvature: '|m″| / (1 + m′²)^1.5, m in semitones, t in s' },
    lines: lines.map((l) => ({ key: l.key, name: l.name, color: l.color, samples: curveSamples(l.pts) })),
  };
  triggerDownload(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `flexatone-${studio}-curves.json`);
  hooks.showToast(t('sm.exported', lines.length));
}

// ==========================================================================
// Drawing / 그리기
// ==========================================================================

function spark(cv, l) {
  const dpr = globalThis.devicePixelRatio || 1;
  const W = 54;
  const H = 18;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const span = Math.max(1e-6, l.t1 - l.t0);
  const mr = Math.max(1, l.m1 - l.m0);
  g.strokeStyle = l.color;
  g.lineWidth = 1.3;
  g.beginPath();
  let pen = false;
  for (const p of l.pts) {
    if (!Number.isFinite(p.m)) { pen = false; continue; }
    const x = 1 + ((p.t - l.t0) / span) * (W - 2);
    const y = H - 2 - ((p.m - l.m0) / mr) * (H - 4);
    if (pen) g.lineTo(x, y); else g.moveTo(x, y);
    pen = true;
  }
  g.stroke();
}

function renderVoices(studio, lines) {
  const s = nodes.voices;
  if (!s?.isConnected) return;
  s.querySelector('[data-sm-badge]').textContent = String(lines.length);
  const box = s.querySelector('.fx-sm-cards');
  const sig = `${studio}|${appState.lang}|${sel}|${lines.map((l) => `${l.key}:${l.name}:${l.color}:${l.t0.toFixed(2)}:${l.t1.toFixed(2)}:${l.m0.toFixed(1)}:${l.m1.toFixed(1)}`).join(',')}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  if (!lines.length) { box.replaceChildren(mk('div', 'fx-sm-empty', t(isTrajectorySource(studio) ? 'sm.noLines' : 'sm.noSource'))); return; }
  box.replaceChildren(...lines.map((l) => {
    const c = mk('div', `fx-sm-card${sel === l.key ? ' is-on' : ''}`);
    c.title = `${l.name} · ${l.t0.toFixed(2)}–${l.t1.toFixed(2)} s`;
    const dot = mk('span', 'fx-sm-dot');
    dot.style.background = l.color;
    const cv = mk('canvas');
    spark(cv, l);
    const name = mk('span', 'font-semibold text-slate-200', l.name.length > 18 ? `${l.name.slice(0, 17)}…` : l.name);
    const rng = mk('span', 'font-mono text-slate-400', `${midiToNoteName(l.first)}→${midiToNoteName(l.last)}`);
    const tm = mk('span', 'font-mono text-slate-500', `${l.t0.toFixed(1)}–${l.t1.toFixed(1)}s`);
    c.append(dot, name, cv, rng, tm);
    c.addEventListener('click', () => setSel(sel === l.key ? null : l.key));
    return c;
  }));
}

let laneMap = null; // { y0, laneH, keys } for clicks / 클릭용

function renderTimeline(studio, lines) {
  const s = nodes.timeline;
  if (!s?.isConnected) return;
  s.querySelector('[data-sm-badge]').textContent = String(lines.length);
  const cv = s.querySelector('canvas');
  const host = cv.parentElement;
  // automatic height until the user (or full screen) sets one / 사용자가 정하기 전까지 자동 높이
  const autoRows = lines.map((l) => shownLanes(studio, l.key));
  const nAuto = autoRows.reduce((a, r) => a + r.length, 0);
  const autoH = Math.round(Math.min(240, Math.max(72, 26 + Math.max(1, lines.length) * 16)) + nAuto * AUTO_H);
  if (!host.style.height || host.style.height === `${host.dataset.autoH}px`) { host.style.height = `${autoH}px`; host.dataset.autoH = String(autoH); }
  const r = host.getBoundingClientRect();
  const zoom = Math.max(0.1, (Number(appState.uiZoom) || 100) / 100);
  const W = Math.max(50, Math.round(r.width / zoom));
  const H = Math.max(40, Math.round(r.height / zoom));
  const dpr = globalThis.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '10px ui-monospace, monospace';
  if (!lines.length) {
    g.fillStyle = '#64748b';
    g.fillText(t(isTrajectorySource(studio) ? 'sm.noLines' : 'sm.noSource').slice(0, Math.floor(W / 6)), 8, H / 2 + 3);
    laneMap = null;
    return;
  }
  const T = Math.max(1, ...lines.map((l) => l.t1));
  const padL = 6;
  const padR = 8;
  const top = 16;
  const X = (sec) => padL + (sec / T) * (W - padL - padR);
  // time ticks / 시간 눈금
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s2) => (W - padL - padR) / (T / s2) >= 48) || 600;
  g.strokeStyle = '#1e293b';
  g.fillStyle = '#64748b';
  g.lineWidth = 1;
  for (let sec = 0; sec <= T + 1e-9; sec += step) {
    const x = Math.round(X(sec)) + 0.5;
    g.beginPath(); g.moveTo(x, top - 3); g.lineTo(x, H); g.stroke();
    g.fillText(`${+sec.toFixed(2)}s`, x + 2, 10);
  }
  // rows: each module's lane, then its automation lanes under it / 줄: 모듈 줄, 그 아래 오토메이션 레인
  const free = H - top - 2;
  const autoH2 = nAuto ? Math.max(28, Math.min(AUTO_H, (free - lines.length * 10) / nAuto)) : 0;
  const laneH = Math.max(6, (free - nAuto * autoH2) / lines.length);
  const mMin = Math.min(...lines.map((l) => l.m0));
  const mMax = Math.max(...lines.map((l) => l.m1));
  const mr = Math.max(1, mMax - mMin);
  const rows = [];
  let yy = top;
  const autoDraw = [];
  lines.forEach((l, i) => {
    const y0 = yy;
    yy += laneH;
    rows.push({ kind: 'line', key: l.key, y0, h: laneH });
    for (const lane of autoRows[i]) {
      const geo = { x0: padL, x1: W - padR, y0: yy, h: autoH2, X, T };
      rows.push({ kind: 'auto', key: l.key, y0: yy, h: autoH2, lane, geo });
      autoDraw.push([lane, l.color, geo]);
      yy += autoH2;
    }
    const on = sel === l.key;
    g.globalAlpha = on ? 0.38 : 0.18;
    g.fillStyle = l.color;
    g.fillRect(X(l.t0), y0 + 1, Math.max(1.5, X(l.t1) - X(l.t0)), laneH - 2);
    g.globalAlpha = 1;
    if (on) { g.strokeStyle = l.color; g.strokeRect(X(l.t0) + 0.5, y0 + 1.5, Math.max(1.5, X(l.t1) - X(l.t0)) - 1, laneH - 3); }
    g.strokeStyle = l.color;
    g.lineWidth = on ? 1.8 : 1.2;
    g.beginPath();
    let pen = false;
    for (const p of l.pts) {
      if (!Number.isFinite(p.m)) { pen = false; continue; }
      const x = X(p.t);
      const y = y0 + laneH - 2 - ((p.m - mMin) / mr) * Math.max(2, laneH - 4);
      if (pen) g.lineTo(x, y); else g.moveTo(x, y);
      pen = true;
    }
    g.stroke();
    if (laneH >= 11) {
      g.fillStyle = '#e2e8f0';
      g.fillText(l.name.slice(0, 24), X(l.t0) + 3, y0 + Math.min(laneH - 3, 10));
    }
  });
  for (const [lane, color, geo] of autoDraw) drawLane(g, studio, lane, color, geo);
  g.font = '10px ui-monospace, monospace';
  laneMap = { rows, studio };
  // cue + playhead / 큐 + 재생 헤드
  const tr = appState.transport || {};
  if (Number.isFinite(tr.cueSec) && tr.cueSec > 0 && tr.cueSec <= T) {
    g.strokeStyle = 'rgba(251, 191, 36, .7)';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X(tr.cueSec) + 0.5, top - 4); g.lineTo(X(tr.cueSec) + 0.5, H); g.stroke();
    g.setLineDash([]);
  }
  if (Number.isFinite(tr.playheadSec) && tr.playheadSec >= 0) {
    const x = X(Math.min(T, tr.playheadSec)) + 0.5;
    g.strokeStyle = '#f43f5e';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, top - 6); g.lineTo(x, H); g.stroke();
  }
}

const AUTO_H = 56; // px of an automation lane / 오토메이션 레인 높이

/** Pointer → canvas coordinates (page zoom taken out). / 포인터 → 캔버스 좌표 */
function canvasPos(cv, e) {
  const r = cv.getBoundingClientRect();
  const zoom = Math.max(0.1, (Number(appState.uiZoom) || 100) / 100);
  return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
}

function rowAt(e) {
  if (!laneMap) return null;
  const { x, y } = canvasPos(e.currentTarget, e);
  const row = laneMap.rows.find((r) => y >= r.y0 && y < r.y0 + r.h) || null;
  return row ? { row, x, y } : null;
}

function onTimelineDown(e) {
  const hit = rowAt(e);
  if (!hit) return;
  if (hit.row.kind === 'auto') { e.preventDefault(); lanePointerDown(e, hit.row, hit.x, hit.y, laneMap.studio); return; }
  if (e.button !== 0) return;
  setSel(sel === hit.row.key ? null : hit.row.key);
}

function onTimelineDbl(e) {
  const hit = rowAt(e);
  if (hit?.row.kind !== 'auto') return;
  e.preventDefault();
  laneDblClick(hit.row, hit.x, hit.y, laneMap.studio);
}

/** Two-finger click (macOS) / right click on a lane removes a node. / 두 손가락 클릭 = 노드 제거 */
function onTimelineContext(e) {
  const hit = rowAt(e);
  if (hit?.row.kind !== 'auto') return;
  e.preventDefault();
  laneContext(hit.row, hit.x, hit.y, laneMap.studio);
}

/** Mark a module; in Glissando it also becomes the active voice. / 모듈 선택 (글리산도는 활성 보이스도) */
function setSel(key) {
  if (key !== sel) automationModuleChanged();
  sel = key;
  if (key && StudioRegistry.resolveStudioId() === 'glissando' && appState.voices.some((v) => v.id === key)) selectVoice(key);
  draw();
}

function renderPost(studio, lines) {
  const s = nodes.post;
  if (!s?.isConnected) return;
  const src = isTrajectorySource(studio);
  setOff(s.querySelector('[data-sm-act="send"]'), !src, t('sm.sendOff'));
  setOff(s.querySelector('[data-sm-act="export"]'), !lines.length, t('sm.exportNone'), t('sm.exportTip'));
  s.querySelector('[data-sm-note]').textContent = t('sm.lines', lines.length);
}

function draw() {
  const studio = StudioRegistry.resolveStudioId();
  const lines = currentLines(studio);
  if (sel && !lines.some((l) => l.key === sel)) sel = null;
  // Glissando: the active voice of its own list is the selected module / 글리산도: 활성 보이스 = 선택한 모듈
  if (studio === 'glissando' && appState.activeVoiceId !== sel && lines.some((l) => l.key === appState.activeVoiceId)) { if (sel) automationModuleChanged(); sel = appState.activeVoiceId; }
  tickAutomation(studio);
  renderVoices(studio, lines);
  renderTimeline(studio, lines);
  renderAutomationUI(studio, sel, lines.find((l) => l.key === sel)?.name);
  renderPost(studio, lines);
  renderToSpace(studio);
  renderChain();
  syncToSpace(studio);
}

// ==========================================================================
// Send to Space Studio: one Space source per studio that imports that studio ('@<studio>'), kept in step
// while the live link is on. Project data: studioParams._toSpace = { [studio]: { auto: bool } }
// ("_" can never be a studio id). The source is found by its input target, so it survives renaming.
// 스페이스 스튜디오로 보내기: 스튜디오마다 그 스튜디오를 가져오는('@<studio>') 스페이스 음원 하나, 실시간
// 연결 중에는 길이를 맞춤. 프로젝트 데이터: studioParams._toSpace (음원은 입력 대상으로 찾음).
// ==========================================================================

export const TO_SPACE_KEY = '_toSpace';
const toSpaceOf = (studio) => appState.studioParams?.[TO_SPACE_KEY]?.[studio] || null;
const importTarget = (studio) => `@${studio}`;

function setToSpace(studio, patch, { history = true } = {}) {
  dispatch({
    type: 'toSpace/set',
    history,
    scope: ['all'],
    mutate: (st) => {
      const all = { ...(st.studioParams?.[TO_SPACE_KEY] || {}) };
      if (patch === null) delete all[studio]; else all[studio] = { ...(all[studio] || {}), ...patch };
      st.studioParams = { ...(st.studioParams || {}), [TO_SPACE_KEY]: all };
    },
  });
}

/** The Space source that imports `studio`, or null. / 그 스튜디오를 가져오는 스페이스 음원 */
export function spaceSourceOf(studio, params = getSpaceParams()) {
  return params.sources.find((x) => x.input?.kind === 'import' && x.input.target === importTarget(studio)) || null;
}

function studioLength(studio) {
  const d = describeInstance(importTarget(studio), 'doc');
  return d.ok && d.length > 0 ? d.length : 0;
}

/** Shape of the source for a sound of `len` seconds: start 0, a 300 m pass-by crossed in `len`. / 길이에 맞춘 모양 */
function fitSource(src, len) {
  src.start = 0;
  src.duration = Number(len.toFixed(2));
  src.timeMode = 'speed';
  src.speed = { ...src.speed, mode: 'const', value: Number(Math.max(0.5, Math.hypot(src.path.x1 - src.path.x0, src.path.y1 - src.path.y0) / len).toFixed(3)) };
}

/** Create (or re-use) the Space source of `studio` and switch the live link on. / 스페이스 음원 만들기 + 연결 */
export function sendToSpace(studio) {
  if (studio === 'space') return null;
  const len = studioLength(studio);
  if (!(len > 0)) { hooks.showToast(t('ts.empty')); return null; }
  let name = '';
  editSpace((d) => {
    let s = spaceSourceOf(studio, d);
    if (!s) {
      s = createSource(d.sources.length, {
        name: `${t(`studio.${studio}`)} ▸`,
        input: { kind: 'import', target: importTarget(studio), content: 'doc', trimDb: 0, offset: 0, play: 'once' },
        path: { type: 'line', x0: -150, y0: 6, x1: 150, y1: 6 },
      });
      d.sources.push(s);
    }
    fitSource(s, len);
    s.muted = false;
    d.activeSourceId = s.id;
    name = s.name;
  });
  setToSpace(studio, { auto: true });
  hooks.showToast(t('ts.done', name));
  return name;
}

let syncAt = 0;
/** Live link: the length of the Space source follows the studio (no undo step). / 실시간 연결: 길이 따라가기 */
function syncToSpace(studio) {
  if (studio === 'space' || !toSpaceOf(studio)?.auto) return;
  const now = performance.now();
  if (now - syncAt < 400) return;
  syncAt = now;
  const src = spaceSourceOf(studio);
  if (!src) return;
  const len = studioLength(studio);
  if (len > 0 && Math.abs(len - src.duration) > 0.05) editSpace((d) => { const s = spaceSourceOf(studio, d); if (s) fitSource(s, len); }, { history: false });
}

function buildToSpace() {
  const s = mk('section', SECTION);
  Object.assign(s.dataset, { rack: 'send-space', toolCat: 'post', help: 'app.toSpace' });
  const title = mk('span', 'text-xs font-bold uppercase tracking-wider text-pink-300', t('ts.title'));
  title.dataset.help = 'app.toSpace';
  const row = mk('div', 'flex flex-wrap items-center gap-1.5');
  const send = mk('button', `${BTN} bg-pink-600/25 hover:bg-pink-600/45 text-pink-100 border-pink-500/50`, t('ts.send'));
  send.type = 'button';
  send.dataset.tsAct = 'send';
  const auto = mk('button', `${BTN} bg-slate-800 text-slate-200 border-slate-700 fx-toggle`, t('ts.auto'));
  auto.type = 'button';
  auto.dataset.tsAct = 'auto';
  auto.title = t('ts.autoTip');
  const open = mk('button', `${BTN} bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700`, t('ts.open'));
  open.type = 'button';
  open.dataset.tsAct = 'open';
  row.append(send, auto, open);
  const note = mk('p', 'text-[11px] text-slate-400');
  note.dataset.tsNote = '1';
  s.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ts-act]');
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    const studio = StudioRegistry.resolveStudioId();
    if (b.dataset.tsAct === 'send') sendToSpace(studio);
    else if (b.dataset.tsAct === 'auto') setToSpace(studio, { auto: !toSpaceOf(studio)?.auto });
    else if (b.dataset.tsAct === 'open') document.getElementById('btnStudioSpace')?.click();
  });
  s.append(title, row, note);
  return s;
}

function renderToSpace(studio) {
  const s = nodes.toSpace;
  if (!s?.isConnected) return;
  const send = s.querySelector('[data-ts-act="send"]');
  const auto = s.querySelector('[data-ts-act="auto"]');
  const open = s.querySelector('[data-ts-act="open"]');
  const note = s.querySelector('[data-ts-note]');
  if (studio === 'space') {
    setOff(send, true, t('ts.self'));
    setOff(auto, true, t('ts.self'));
    open.classList.add('hidden');
    const params = getSpaceParams();
    const from = params.sources.filter((x) => x.input?.kind === 'import' && String(x.input.target).startsWith('@')).map((x) => `${t(`studio.${x.input.target.slice(1)}`)} → ${x.name}`);
    const txt = from.length ? t('ts.incoming', from.join(', ')) : t('ts.incomingNone');
    if (note.textContent !== txt) note.textContent = txt;
    return;
  }
  open.classList.remove('hidden');
  const src = spaceSourceOf(studio);
  const st = toSpaceOf(studio);
  const live = !!st?.auto && !!src;
  send.textContent = st && !src ? t('ts.resend') : t('ts.send');
  setOff(send, false, '');
  setOff(auto, !src, t('ts.none'), t('ts.autoTip'));
  auto.classList.toggle('is-active', live);
  auto.setAttribute('aria-pressed', live ? 'true' : 'false');
  auto.textContent = `${live ? '●' : '○'} ${t('ts.auto')}`;
  const txt = !src ? (st ? t('ts.missing') : t('ts.none')) : live ? t('ts.linked', src.name, src.duration) : t('ts.paused', src.name);
  if (note.textContent !== txt) note.textContent = txt;
}

/** Destination of the chain (rack-layout ports + Chain toolbox). / 체인의 목적지 */
setChainDestination(() => {
  const studio = StudioRegistry.resolveStudioId();
  if (studio === 'space') return { label: t('chain.output'), space: false };
  const src = toSpaceOf(studio)?.auto ? spaceSourceOf(studio) : null;
  return src ? { label: t('ch.spaceDst', src.name), space: true } : { label: t('chain.output'), space: false };
});

// ==========================================================================
// Chain toolbox (④ Utility): the patch at a glance / 체인 툴박스: 패치를 한눈에
// ==========================================================================

const CAT_COLOR = { src: '#f8fafc', gen: '#38bdf8', proc: '#a78bfa', post: '#34d399', dst: '#fbbf24', space: '#f472b6' };

function buildChain() {
  const s = mk('section', SECTION);
  Object.assign(s.dataset, { rack: 'tool-chain', toolCat: 'util', help: 'app.signalFlow' });
  const h = mk('div', 'flex flex-wrap items-center gap-2');
  const name = mk('span', 'text-xs font-bold uppercase tracking-wider text-amber-300', t('ch.title'));
  name.dataset.help = 'app.signalFlow';
  const serial = mk('button', 'fx-tray-btn', t('sf.serial'));
  serial.type = 'button';
  serial.title = t('sf.serialTip');
  serial.dataset.pfSerial = '1';
  serial.addEventListener('click', () => resetFlow(getToolChain().studio));
  const state = mk('span', 'text-[10.5px] text-amber-300 font-mono');
  state.dataset.pfStateLbl = '1';
  h.append(name, mk('span', 'text-[10.5px] text-slate-500', t('ch.sub')), mk('span', 'flex-1'), state, serial);
  const box = mk('div', 'w-full');
  box.dataset.chBox = '1';
  const off = mk('div', 'flex flex-wrap items-center gap-1');
  off.dataset.chOff = '1';
  const msg = mk('div', 'text-[10px] text-slate-500');
  msg.dataset.pfMsg = '1';
  s.append(h, box, msg, off);
  return s;
}

function renderChain() {
  const s = nodes.chain;
  if (!s?.isConnected) return;
  const ch = getToolChain();
  if (!ch.studio) return;
  const box = s.querySelector('[data-ch-box]');
  const W = Math.max(240, Math.round(box.clientWidth || 300));
  const sig = `${appState.lang}|${patcherSig(ch.studio, ch, W)}|${ch.off.map((n) => n.key).join(',')}`;
  if (s.dataset.sig === sig) return;
  s.dataset.sig = sig;
  // an editable patcher (ui/signal-flow.js): cords between the boxes, several in / out per box, stages = parallel
  // 편집 가능한 패처: 상자 사이의 선, 상자마다 여러 입출력, 같은 단계 = 병렬
  const r = renderPatcher(box, {
    studio: ch.studio,
    chain: ch,
    jump: (node) => node?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    notify: (msg) => { const m = s.querySelector('[data-pf-msg]'); if (m) { m.textContent = msg; setTimeout(() => { m.textContent = t('sf.hint'); }, 2600); } },
  });
  s.querySelector('[data-pf-state-lbl]').textContent = `${t(`sf.state.${r.state}`)}`;
  const hint = s.querySelector('[data-pf-msg]');
  if (hint && !hint.textContent) hint.textContent = t('sf.hint');
  const off = s.querySelector('[data-ch-off]');
  off.replaceChildren(...(ch.off.length ? [mk('span', 'text-[10.5px] text-slate-500', t('ch.off')), ...ch.off.map((n) => {
    const b = mk('button', `fx-nav-chip is-off fx-tg-${n.cat}`, `+ ${n.title}`);
    b.type = 'button';
    b.addEventListener('click', () => setModuleActive(n.node, true));
    return b;
  })] : [mk('span', 'text-[10.5px] text-slate-500', t('ch.allOn'))]));
}

// ==========================================================================
// Placement / 배치
// ==========================================================================

function relabel() {
  for (const n of Object.values(nodes)) n?.remove();
  for (const k of Object.keys(nodes)) nodes[k] = null;
}

/** Put the shared blocks into the studio on screen (only those it does not have itself). / 공용 블록 배치 */
function place(studio) {
  const ws = document.getElementById('studioWorkspace');
  const gliss = !ws || ws.classList.contains('hidden');
  const root = gliss ? document.getElementById('mainSplitGrid') : ws;
  if (!root) return;
  const own = (sel2) => [...root.querySelectorAll(sel2)].some((n) => !n.dataset.sharedMonitor && !n.closest('.hidden, .fx-ws-hidden'));
  // Space's own timeline counts as the timeline monitor / 스페이스 자체 타임라인 = 타임라인 모니터
  for (const n of root.querySelectorAll('[data-rack="space-timeline"]')) n.dataset.monitor = 'timeline';
  const hasList = gliss || own('[data-window="list"]');
  const hasTimeline = own('[data-monitor="timeline"]');
  const want = { voices: !hasList, timeline: !hasTimeline, post: true, toSpace: true, chain: true };
  const host = {
    voices: gliss ? document.getElementById('leftCanvasCol') : ws,
    timeline: gliss ? document.getElementById('leftCanvasCol') : ws,
    post: gliss ? document.getElementById('rightControlCol') : ws,
    toSpace: gliss ? document.getElementById('rightControlCol') : ws,
    chain: gliss ? document.getElementById('rightControlCol') : ws,
  };
  const BUILD = { voices: buildVoices, timeline: buildTimeline, post: buildPost, toSpace: buildToSpace, chain: buildChain };
  for (const k of Object.keys(BUILD)) {
    if (!want[k]) { nodes[k]?.remove(); continue; }
    if (!nodes[k]) nodes[k] = BUILD[k]();
    if (host[k] && nodes[k].parentElement !== host[k]) {
      // a block moved to another studio starts without the old split-layout place (the layout sets it again)
      // 다른 스튜디오로 옮긴 블록은 이전 분할 레이아웃 위치 없이 시작 (레이아웃이 다시 지정)
      nodes[k].classList.remove('fx-win', 'fx-tg-hidden');
      for (const p of ['left', 'top', 'width', 'order']) nodes[k].style[p] = '';
      host[k].append(nodes[k]);
    }
  }
}

/** Called once per render frame (js/main.js). / 렌더마다 호출 */
export function renderStudioMonitors(scopes) {
  const studio = StudioRegistry.resolveStudioId();
  if (lastLang !== appState.lang) { lastLang = appState.lang; relabel(); }
  if (!(scopes?.size === 1 && scopes.has('transport'))) place(studio);
  draw();
}

export function initStudioMonitors(h) {
  hooks = { ...hooks, ...h };
  // The Signal flow toolbox follows module on / off, order and cord edits, which happen outside the app's render
  // scopes (ui/rack-layout.js layout pass): redraw after the layout ran; the signature makes an idle tick free.
  // 시그널 플로우 툴박스는 모듈 켜기/끄기·순서·선 편집을 따라감 (앱 렌더 범위 밖이라 직접 다시 그림)
  const redraw = () => requestAnimationFrame(() => { try { renderChain(); } catch (err) { console.error(err); } });
  onFlowChange(redraw);
  setInterval(() => { if (!document.hidden) redraw(); }, 500);
}
