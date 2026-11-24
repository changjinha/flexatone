/**
 * Flexatone — ui/midi-window.js
 * Layer 4 (ui): the **🎹 MIDI** window (header button). Two tabs:
 *   File   — Export: the Manager's audible tracks (cycle time, one MIDI track each) or the studio on screen, as MPE
 *            (notes + per-note pitch bend, ±48), multi-channel bend (±2 … ±96, any synth) or plain notes (notation).
 *            Import: a .mid / .midi file → Glissando voices (each note with its pitch bends; touching notes of one
 *            channel can be joined into one glide), added to the editor, replacing it, or as a new Manager track.
 *   Device — Web MIDI input and Learn (ui/midi-learn.js).
 * Logic: core/midi-file.js. / 계층 4 (ui): MIDI 창 — 파일(내보내기·가져오기), 장치(입력·Learn).
 */

import { t, I18N } from '../core/i18n.js';
import { appState, dispatch, createDefaultVoice } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { linesToMidi, readMidiFile, midiNotes, notesToLines, MIDI_MODES } from '../core/midi-file.js';
import { addInstance } from '../core/manager-state.js';
import { StudioRegistry } from '../studios/registry.js';
import { listSourceLines, lineToTrajectory, trajectoryBreakpoints, MEAN_LINE } from '../studios/trajectory-link.js';
import { triggerDownload } from '../audio/audio-engine.js';
import { masterViewLineGroups } from './manager-panel.js';
import { studioLabel } from './trajectory-ui.js';
import { mountDevicePane } from './midi-learn.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'midi.btn': 'MIDI',
  'midi.btnTitle': 'MIDI: export / import .mid files (MPE), MIDI input and Learn',
  'midi.title': 'MIDI',
  'midi.tab.file': 'File',
  'midi.tab.device': 'Device',
  'midi.export': 'Export',
  'midi.import': 'Import',
  'midi.scope': 'What',
  'midi.scope.manager': 'Manager — audible tracks (cycle time)',
  'midi.scope.studio': (s) => `This studio — ${s}`,
  'midi.mode': 'As',
  'midi.mode.mpe': 'MPE (per-note pitch bend)',
  'midi.mode.multi': 'Multi-channel pitch bend',
  'midi.mode.notes': 'Notes only (nearest semitone)',
  'midi.range': 'Bend range ± st',
  'midi.save': '⬇ Save .mid',
  'midi.summary': (lines, groups) => `${lines} line${lines === 1 ? '' : 's'} in ${groups} track${groups === 1 ? '' : 's'}`,
  'midi.nothing': 'Nothing to export here (no pitch lines).',
  'midi.skipped': (names) => `No pitch lines (not exported): ${names}`,
  'midi.saved': (f, n, st) => `Saved ${f} — ${n} notes${st ? `, ${st} cut short (more than 15 at once)` : ''}`,
  'midi.choose': 'Choose a .mid file…',
  'midi.join': 'Join notes that continue where another stopped (legato, re-struck glides) into one glide',
  'midi.target': 'Into',
  'midi.target.add': 'Glissando — add voices',
  'midi.target.replace': 'Glissando — replace all voices',
  'midi.target.track': 'Manager — new Glissando track',
  'midi.read': (n, lines, mpe, sec) => `${n} notes → ${lines} lines, ${sec} s${mpe ? ' · MPE' : ''}`,
  'midi.doImport': '⤵ Import',
  'midi.imported': (n) => `Imported ${n} voices into Glissando`,
  'midi.cap': (n) => `Only the first ${n} lines are imported.`,
  'midi.readFail': (m) => `Could not read the MIDI file: ${m}`,
  'midi.mpeNote': 'MPE: lower zone, channel 1 = master, notes on 2–16 (15 at once). Multi-channel: channels 1–16 except 10. Every glide is exact within the bend range; past it the note is re-struck legato on a new base note.',
  'midi.close': 'Close',
});
Object.assign(I18N.ko, {
  'midi.btn': 'MIDI',
  'midi.btnTitle': 'MIDI: .mid 파일 내보내기 / 가져오기 (MPE), MIDI 입력과 Learn',
  'midi.title': 'MIDI',
  'midi.tab.file': '파일',
  'midi.tab.device': '장치',
  'midi.export': '내보내기',
  'midi.import': '가져오기',
  'midi.scope': '대상',
  'midi.scope.manager': '매니저 — 들리는 트랙 (사이클 시간)',
  'midi.scope.studio': (s) => `이 스튜디오 — ${s}`,
  'midi.mode': '형식',
  'midi.mode.mpe': 'MPE (노트별 피치벤드)',
  'midi.mode.multi': '다채널 피치벤드',
  'midi.mode.notes': '노트만 (가장 가까운 반음)',
  'midi.range': '벤드 범위 ± 반음',
  'midi.save': '⬇ .mid 저장',
  'midi.summary': (lines, groups) => `선 ${lines}개, 트랙 ${groups}개`,
  'midi.nothing': '내보낼 것이 없습니다 (음고 선 없음).',
  'midi.skipped': (names) => `음고 선이 없어 제외: ${names}`,
  'midi.saved': (f, n, st) => `${f} 저장 — 노트 ${n}개${st ? `, ${st}개는 짧게 끊김 (동시에 15개 초과)` : ''}`,
  'midi.choose': '.mid 파일 선택…',
  'midi.join': '다른 노트가 끝난 자리·음고에서 이어지는 노트(레가토, 재타건된 글리산도)를 하나로 잇기',
  'midi.target': '넣을 곳',
  'midi.target.add': '글리산도 — 보이스 추가',
  'midi.target.replace': '글리산도 — 모든 보이스 교체',
  'midi.target.track': '매니저 — 새 글리산도 트랙',
  'midi.read': (n, lines, mpe, sec) => `노트 ${n}개 → 선 ${lines}개, ${sec}초${mpe ? ' · MPE' : ''}`,
  'midi.doImport': '⤵ 가져오기',
  'midi.imported': (n) => `글리산도에 보이스 ${n}개를 가져왔습니다`,
  'midi.cap': (n) => `처음 ${n}개 선만 가져옵니다.`,
  'midi.readFail': (m) => `MIDI 파일을 읽을 수 없습니다: ${m}`,
  'midi.mpeNote': 'MPE: 로어 존, 채널 1 = 마스터, 노트는 2–16 (동시에 15개). 다채널: 10을 뺀 1–16. 벤드 범위 안의 글리산도는 그대로 담기고, 범위를 넘으면 새 기준음으로 레가토 재타건합니다.',
  'midi.close': '닫기',
});
HELP_DB['app.midi'] = {
  en: { title: 'MIDI', summary: 'Export pitch lines as a Standard MIDI File (MPE, multi-channel bend or plain notes), import a .mid file as Glissando voices, and play the app from a MIDI controller (Device → Learn).', detail: 'Export → Manager: every audible track becomes one MIDI track, in cycle time with the pitch you hear (tempo, tape, Warp included). Export → This studio: the pitch lines of the studio on screen in its own seconds. Risset bands and studios without pitch lines are left out. The file is written at 120 BPM (1 beat = 0.5 s). Import reads tempo maps, running status, RPN bend ranges and MPE zones; each note becomes a voice whose curve follows its bends.', formula: 'bend = 8192 + 8192 · (m − base) / range' },
  ko: { title: 'MIDI', summary: '음고 선을 표준 MIDI 파일(MPE, 다채널 벤드, 노트만)로 내보내고, .mid 파일을 글리산도 보이스로 가져오고, MIDI 컨트롤러로 앱을 조작합니다 (장치 → Learn).', detail: '내보내기 → 매니저: 들리는 트랙마다 MIDI 트랙 하나, 사이클 시간에 들리는 음고 그대로(템포·테이프·곡률 포함). 내보내기 → 이 스튜디오: 화면의 스튜디오 음고 선을 그 스튜디오의 초 단위로. 리세 대역과 음고 선이 없는 스튜디오는 빠집니다. 파일은 120 BPM(1박 = 0.5초)으로 씁니다. 가져오기는 템포 맵, 러닝 스테이터스, RPN 벤드 범위, MPE 존을 읽고, 노트 하나가 벤드를 따르는 곡선의 보이스 하나가 됩니다.', formula: 'bend = 8192 + 8192 · (m − 기준음) / 범위' },
};

const MAX_IMPORT_LINES = 256;

let win = null; // { root, body, tab }
let button = null;
let hooks = { showToast: () => {} };
const prefs = { scope: 'studio', mode: 'mpe', range: { mpe: 48, multi: 2 }, join: true, target: 'add' };
let parsed = null; // { name, notes, lines, mpe }

// --------------------------------------------------------------------------
// Export / 내보내기
// --------------------------------------------------------------------------

function exportGroups() {
  if (prefs.scope === 'manager') return masterViewLineGroups();
  const studio = StudioRegistry.resolveStudioId();
  const lines = listSourceLines(studio).filter((l) => l.key !== MEAN_LINE).map((l) => ({ name: l.name, pts: l.pts }));
  return { groups: lines.length ? [{ name: studioLabel(studio), lines }] : [], skipped: [] };
}

function doExport() {
  const { groups } = exportGroups();
  const n = groups.reduce((s, g) => s + g.lines.length, 0);
  if (!n) { hooks.showToast(t('midi.nothing'), 'error'); return; }
  const range = prefs.mode === 'notes' ? null : prefs.range[prefs.mode];
  const out = linesToMidi(groups, { mode: prefs.mode, bendRange: range, name: 'Flexatone' });
  const what = prefs.scope === 'manager' ? 'manager' : StudioRegistry.resolveStudioId();
  const filename = `flexatone_${what}_${prefs.mode}.mid`;
  triggerDownload(new Blob([out.bytes], { type: 'audio/midi' }), filename);
  hooks.showToast(t('midi.saved', filename, out.notes, out.stolen));
}

// --------------------------------------------------------------------------
// Import / 가져오기
// --------------------------------------------------------------------------

/** One imported line → a Glissando voice (custom curve between the line's min and max). / 선 → 글리산도 보이스 */
export function lineToVoice(line, index) {
  const traj = lineToTrajectory({ name: line.name, pts: line.pts });
  if (!traj) return null;
  let lo = Math.floor(traj.midiLo);
  let hi = Math.ceil(traj.midiHi);
  if (hi - lo < 1) { lo -= 1; hi += 1; }
  lo = clamp(lo, 0, 126);
  hi = clamp(hi, lo + 1, 127);
  const bp = trajectoryBreakpoints(traj, { maxPoints: 64, minGap: 0.004, lo, hi });
  return createDefaultVoice(index, {
    name: line.name,
    f0Hz: midiToFreq(lo), f0Midi: lo, f0Fine: 0, f1Hz: midiToFreq(hi), f1Midi: hi, f1Fine: 0, logScale: true,
    engine: 'custom', lastNonCustomEngine: 'harmonic',
    customPoints: bp.points.map((p) => ({ x: p.x, y: p.y, handles: [] })),
    startTime: Number(Math.max(0, traj.startTime).toFixed(4)),
    duration: Number(Math.max(0.02, traj.duration).toFixed(4)),
    baseGain: Number((0.25 + 0.6 * clamp((line.vel ?? 100) / 127, 0, 1)).toFixed(3)),
  });
}

function importLines() {
  if (!parsed) return [];
  const lines = notesToLines(parsed.notes, { join: prefs.join });
  return lines.map((l, i) => ({ ...l, name: `${l.trackName || 'MIDI'} ${l.notes > 1 ? '⌒' : ''}${i + 1}` }));
}

function doImport() {
  const lines = importLines().slice(0, MAX_IMPORT_LINES);
  const voices = lines.map((l, i) => lineToVoice(l, i)).filter(Boolean);
  if (!voices.length) { hooks.showToast(t('midi.nothing'), 'error'); return; }
  const name = parsed?.name?.replace(/\.(mid|midi)$/i, '') || 'MIDI';
  if (prefs.target === 'track') {
    const inst = addInstance('glissando');
    dispatch({
      type: 'midi/importTrack',
      history: true,
      scope: ['manager', 'all'],
      mutate: (s) => {
        const it = s.manager.instances.find((x) => x.id === inst?.id);
        if (!it) return;
        it.name = name.slice(0, 40);
        it.doc = { voices, activeVoiceId: voices[0].id, params: null };
      },
    });
  } else {
    dispatch({
      type: 'midi/import',
      history: true,
      scope: 'all',
      mutate: (s) => {
        if (prefs.target === 'replace') s.voices = voices;
        else s.voices = [...s.voices, ...voices.map((v, i) => ({ ...v, color: createDefaultVoice(s.voices.length + i).color }))];
        s.activeVoiceId = voices[0].id;
      },
    });
  }
  hooks.showToast(t('midi.imported', voices.length));
}

async function readFile(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const p = readMidiFile(buf);
    const { notes, mpe } = midiNotes(p);
    parsed = { name: file.name, notes, mpe };
  } catch (err) {
    parsed = null;
    hooks.showToast(t('midi.readFail', err.message || String(err)), 'error');
  }
  render();
}

// --------------------------------------------------------------------------
// Window / 창
// --------------------------------------------------------------------------

const select = (value, opts, onChange) => el('select', { class: 'fx-midi-select', on: { change: (e) => onChange(e.target.value), keydown: (e) => e.stopPropagation() } },
  opts.map(([v, label]) => el('option', { value: v, selected: v === value, text: label })));
const row = (label, ...kids) => el('div', { class: 'fx-midi-row' }, [el('span', { class: 'fx-midi-lbl', text: label }), ...kids]);

function filePane() {
  const studio = StudioRegistry.resolveStudioId();
  const { groups, skipped } = exportGroups();
  const nLines = groups.reduce((s, g) => s + g.lines.length, 0);
  const exp = el('section', { class: 'fx-midi-card' }, [
    el('h3', { text: `⬇ ${t('midi.export')}` }),
    row(t('midi.scope'), select(prefs.scope, [['studio', t('midi.scope.studio', studioLabel(studio))], ['manager', t('midi.scope.manager')]], (v) => { prefs.scope = v; render(); })),
    row(t('midi.mode'), select(prefs.mode, MIDI_MODES.map((m) => [m, t(`midi.mode.${m}`)]), (v) => { prefs.mode = v; render(); })),
    prefs.mode === 'notes' ? null : row(t('midi.range'), el('input', {
      type: 'number', min: '1', max: '96', step: '1', value: String(prefs.range[prefs.mode]), class: 'fx-midi-num',
      on: { change: (e) => { prefs.range[prefs.mode] = clamp(Math.round(Number(e.target.value) || 2), 1, 96); render(); }, keydown: (e) => e.stopPropagation() },
    })),
    el('p', { class: 'fx-midi-info', text: nLines ? t('midi.summary', nLines, groups.length) : t('midi.nothing') }),
    skipped.length ? el('p', { class: 'fx-midi-note', text: t('midi.skipped', skipped.join(', ')) }) : null,
    el('button', { class: 'fx-traj-btn primary', text: t('midi.save'), disabled: !nLines, on: { click: doExport } }),
    el('p', { class: 'fx-midi-note', text: t('midi.mpeNote') }),
  ]);
  const input = el('input', { type: 'file', accept: '.mid,.midi,audio/midi,audio/x-midi', class: 'hidden', on: { change: (e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; } } });
  const lines = importLines();
  const dur = lines.reduce((m, l) => Math.max(m, l.t1), 0);
  const imp = el('section', { class: 'fx-midi-card' }, [
    el('h3', { text: `⤵ ${t('midi.import')}` }),
    el('div', { class: 'flex items-center gap-2 flex-wrap' }, [
      el('button', { class: 'fx-traj-btn', text: t('midi.choose'), on: { click: () => input.click() } }),
      parsed ? el('span', { class: 'fx-midi-file', text: parsed.name }) : null,
      input,
    ]),
    parsed ? el('p', { class: 'fx-midi-info', text: t('midi.read', parsed.notes.length, lines.length, parsed.mpe, (+dur.toFixed(2)).toString()) }) : null,
    el('label', { class: 'fx-stempo-check' }, [el('input', { type: 'checkbox', checked: prefs.join, on: { change: (e) => { prefs.join = e.target.checked; render(); } } }), el('span', { text: t('midi.join') })]),
    row(t('midi.target'), select(prefs.target, [['add', t('midi.target.add')], ['replace', t('midi.target.replace')], ['track', t('midi.target.track')]], (v) => { prefs.target = v; })),
    lines.length > MAX_IMPORT_LINES ? el('p', { class: 'fx-midi-note', text: t('midi.cap', MAX_IMPORT_LINES) }) : null,
    el('button', { class: 'fx-traj-btn primary', text: t('midi.doImport'), disabled: !lines.length, on: { click: doImport } }),
  ]);
  return el('div', { class: 'fx-midi-grid' }, [exp, imp]);
}

function render() {
  if (!win) return;
  win.tabs.forEach((b) => b.classList.toggle('on', b.dataset.tab === win.tab));
  win.body.replaceChildren(win.tab === 'device' ? mountDevicePane({ showToast: hooks.showToast, rerender: render }) : filePane());
}

function closeWindow() {
  win?.root.remove();
  win = null;
  button?.setAttribute('aria-pressed', 'false');
}

export function openMidiWindow(tab = 'file') {
  if (win) { win.tab = tab; render(); return; }
  const tabs = ['file', 'device'].map((k) => el('button', { class: 'fx-midi-tab', dataset: { tab: k }, text: t(`midi.tab.${k}`), on: { click: () => { win.tab = k; render(); } } }));
  const body = el('div', { class: 'fx-midi-body flex flex-col gap-2 min-h-0 overflow-auto pr-1' });
  const dialog = el('div', { class: 'fx-traj-dialog fx-midi-dialog', role: 'dialog', 'aria-modal': 'true', dataset: { help: 'app.midi' } }, [
    el('div', { class: 'flex items-center justify-between gap-3' }, [
      el('div', { class: 'flex items-center gap-3' }, [el('h2', { class: 'text-sm font-bold text-fuchsia-200', text: `🎹 ${t('midi.title')}` }), el('div', { class: 'fx-midi-tabs' }, tabs)]),
      el('button', { class: 'text-slate-400 hover:text-white text-lg leading-none', text: '×', title: t('midi.close'), on: { click: closeWindow } }),
    ]),
    body,
  ]);
  const root = el('div', { class: 'fx-traj-root fx-midi-root', on: { pointerdown: (e) => { if (e.target === root) closeWindow(); } } }, [dialog]);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeWindow(); } });
  document.body.append(root);
  win = { root, body, tabs, tab };
  button?.setAttribute('aria-pressed', 'true');
  render();
}

/** Is the MIDI window open (Learn picks controls outside it)? / 창이 열려 있나 */
export const isMidiWindowOpen = () => !!win;
export const midiWindowRoot = () => win?.root || null;

export function initMidiWindow(h = {}) {
  hooks = { ...hooks, ...h };
  const anchor = document.getElementById('btnSends') || document.getElementById('btnManager');
  if (anchor && !document.getElementById('btnMidi')) {
    button = el('button', {
      id: 'btnMidi',
      class: 'fx-sends-btn fx-midi-btn',
      title: t('midi.btnTitle'),
      dataset: { help: 'app.midi' },
      on: { click: () => (win ? closeWindow() : openMidiWindow()) },
    }, [el('span', { text: '🎹' }), el('span', { class: 'fx-midi-txt', text: t('midi.btn') }), el('span', { class: 'fx-midi-dot' })]);
    anchor.before(button);
  }
}

/** Light the header button while MIDI input is active (called by midi-learn). / 입력 활성 표시 */
export function setMidiActivity(on, flash = false) {
  const dot = button?.querySelector('.fx-midi-dot');
  if (!dot) return;
  dot.classList.toggle('on', !!on);
  if (flash) { dot.classList.add('hit'); clearTimeout(dot._t); dot._t = setTimeout(() => dot.classList.remove('hit'), 90); }
}

export function rerenderMidiWindow() {
  if (win?.tab === 'device') render();
}
