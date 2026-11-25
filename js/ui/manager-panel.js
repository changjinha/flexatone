/**
 * Flexatone — ui/manager-panel.js
 * Layer 4 (ui): the Manager window (top-right ⧉ button / M key). One place to see and control
 * every studio instance at once:
 *   1. Master View   — all instances on one pitch × cycle-time map + post-fader master spectrum.
 *                      Shape select: pick two curves → choose enclosed areas → Confirm.
 *   2. Cycle timeline — clips per instance (drag = move, right edge = length), Serial / Parallel,
 *                      Select range tool (drag) → ranges with per-instance solo / mute badges.
 *   3. Ranges & shapes — list of ranges / shapes and their rules.
 *   4. Tracks         — launch, mute / solo, gain, meter, start / length / loop / fades, edit.
 * 계층 4 (ui): 매니저 창. 마스터 뷰, 사이클 타임라인, 구간·모양 선택, 트랙 스트립.
 */

import { t, I18N } from '../core/i18n.js';
import { appState, subscribe } from '../core/state.js';
import {
  ensureManager, listInstances, getInstance, getInstanceDoc, isFocused, addInstance, removeInstance, focusInstance,
  setInstance, moveInstance, setManagerPref, arrangeCycle, isInstanceAudible, listRegions, addRegion, addShapeRegion,
  setRegion, removeRegion, regionRule, setRegionRule, studioShortName, MANAGER_STUDIOS, BASE_MANAGER_STUDIOS, setManagerTempo, getMasterTempo, contentRate, channelRates,
  setInstanceWarp, setInstanceTake,
} from '../core/manager-state.js';
import { mountModsCard } from './manager-mods.js';
import { mountScenesCard } from './manager-scenes.js';
import { EXTEND_METHODS, EXTEND_NEEDS_LEVELS, EXTEND_MIN_SEC, extendCycle, extendPreview, removeLastExtension, listExtensions, maxExtension } from '../core/manager-extend.js';
import { INTERP_METHODS, INTERP_NEEDS_LINES, INTERP_MIN_GAP, interpolateRanges, interpGap, isInterpLog } from '../core/manager-interpolate.js';
import { takeReversals, takeOffset } from '../core/take-config.js';
import { WARP_MODES, WARP_PARAMS, WARP_SENS_MIN, WARP_SENS_MAX, WARP_TIME_MODES, WARP_TIME_CLOCKS } from '../core/warp-config.js';
import { buildTimeMap } from '../modules/time-warp.js';
import { tempoRate, normalizeTempoConfig, tapeSemitones } from '../core/tempo.js';
import { computeEnclosedLobes, bandWeight } from '../core/shape-select.js';
import { clamp } from '../core/math-utils.js';
import { midiToNoteName } from '../core/units.js';
import { evaluateVoiceGainAtNormT } from '../modules/gain-bus.js';
import { StudioRegistry } from '../studios/registry.js';
import { phaseToMidi, voiceAmplitude } from '../studios/risset/risset-core.js';
import { resetRissetRuntime, resolveRissetDoc } from '../studios/risset/risset-audio.js';
import * as mixer from '../audio/manager-mixer.js';
import { isClipStudio, clipStudioScalesTime } from '../audio/studio-clips.js';
import { projectStudio, projectionKind, monotonePieces } from '../studios/projection.js';
import { getMasterTap } from '../audio/output-bus.js';
import { getAudioCtx } from '../audio/audio-engine.js';
import { drawCueLine, drawPlayheadLine } from './transport-lines.js';
import { openMasterVideoDialog } from './manager-video.js';
import { openTrackExportDialog } from './track-export.js';
import { stopAllAudio, remountWorkspace } from './studio-host.js';
import { HELP_DB } from './option-inspector.js';
import { toggleHelpOverlay } from './help-overlay.js';
// Space Master (the Manager's spatial master track) / 스페이스 마스터 (매니저의 공간 마스터 트랙)
import { getSpaceMaster, editSpaceMaster, syncMasterSources } from '../studios/space/space-master-doc.js';
import { setSpaceDocTarget } from '../studios/space/space-doc.js';
import { refreshSpaceMaster } from '../audio/space-master.js';

let hooks = { requestRender: () => {}, showToast: () => {}, fitAll: () => {} };
let panel = null;
let rafId = null;

const ui = {
  tool: null, // 'range' | null (timeline tool) / 타임라인 도구
  shape: null, // { a, b, lobes, picked:Set } while Shape select is active / 모양 선택 상태
  selRegion: null,
  drag: null,
  deferred: false,
  viewLen: 10,
  hover: null, // { x, y } on the master canvas
  scrub: null, // cycle time while the Master View playhead is dragged / 플레이헤드 드래그 중 위치
  lines: null, // cached master-view geometry (invalidated on every state change)
  trails: new Map(), // Risset live trails / 리세 실시간 궤적
  freeClock: new Map(),
  warpGrid: true, // Master View: draw the pitch grid as the Warp tracks bend it / 곡률 격자 보기
  warpOpen: null, // id of the track whose Warp options panel is open / 곡률 옵션 패널이 열린 트랙
  sel: new Set(), // selected tracks (view only, not saved; separate from M / S) / 선택된 트랙 (보기 전용, M·S와 별개)
  ext: { method: EXTEND_METHODS[0], mult: 1, sec: null }, // Extend tool: method, amount as × cycle or seconds / 연장 도구: 방법, 양(사이클 배수 또는 초)
  ip: { method: INTERP_METHODS[0], a: null, b: null, mode: 'replace' },
  open: new Set(), // tracks whose strip shows everything past the gain (tempo, cycle, fades, tremolo) / 게인 뒤까지 펼친 트랙
  colScroll: null, // scroll of the two columns (landscape) / 두 열의 스크롤 위치 // mode: 'replace' mutes what was there, 'add' layers on top / 덮어쓰기·추가 // Interpolate tool: method and the two range ids (null = picked automatically) / 보간 도구: 방법, 두 구간 id
  addOpen: false, // "＋ Add studio" menu open / 스튜디오 추가 메뉴 열림
  gainUnit: 'db', // track fader shown in 'db' or 'sone' (loudness ratio, ×2 per +10 dB) / 트랙 페이더 단위
  scrollTop: 0, // scroll position kept across re-renders / 재렌더 간 스크롤 위치
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// ==========================================================================
// Init / 초기화
// ==========================================================================

export function initManagerPanel(h) {
  hooks = { ...hooks, ...h };
  ensureManager();
  panel = document.createElement('div');
  panel.id = 'managerPanel';
  panel.className = 'mgr-hidden';
  panel.setAttribute('role', 'dialog');
  document.body.appendChild(panel);
  document.getElementById('btnManager')?.addEventListener('click', () => toggleManagerPanel());
  panel.addEventListener('click', onClick);
  panel.addEventListener('change', onChange);
  panel.addEventListener('input', onInput);
  panel.addEventListener('pointerdown', onPointerDown);
  panel.addEventListener('focusout', () => setTimeout(() => { if (ui.deferred && !isEditing()) { ui.deferred = false; renderPanel(); } }, 0));
  // A click on the studio behind the Manager (or a studio tab) closes it — not in Half mode, where the
  // studio is meant to be used beside it / 뒤의 스튜디오(또는 스튜디오 탭)를 클릭하면 닫힘 (절반 모드 제외)
  document.addEventListener('pointerdown', (e) => {
    if (!isManagerOpen() || size.mode === 'half' || e.button !== 0) return;
    const tg = e.target;
    if (!(tg instanceof Element) || panel.contains(tg)) return;
    if (tg.closest('#workspaceContainer, #studioTabs')) toggleManagerPanel(false);
  }, true);
  subscribe(() => {
    ui.lines = null;
    mixer.syncMixer();
  });
  mixer.onMixerChange(() => hooks.requestRender(['manager']));
}

// ==========================================================================
// Help (H) — uses the app-wide Help mode (ui/help-overlay.js). Manager controls carry
// data-help="mgr.<key>"; their texts (i18n mgrHelp.<key>.t/.d, EN + KO) are registered in HELP_DB.
// 도움말(H) — 앱 공용 도움말 모드 사용. 매니저 컨트롤은 data-help="mgr.<key>", 설명은 HELP_DB에 등록.
// ==========================================================================

// Texts of the 0.14 Manager additions (kept here, next to the code that uses them) / 0.14 추가 항목 문구
Object.assign(I18N.en, {
  'mgr.output': 'Output',
  'mgr.gainUnit': 'Track fader',
  'mgr.addStudio': 'Add studio',
  'mgr.size.float': 'Window',
  'mgr.size.half': 'Half',
  'mgr.size.full': 'Full',
  'mgr.size.drag': 'Drag to resize · double-click = default width',
  'mgr.chkTip': 'Select this track (used by Extend and other tools that act on the selection)',
  'mgr.chkAll': 'Select all / none',
  'mgr.selUsedBy': 'Extend uses only the checked tracks',
  'mgr.takeBent': 'This take keeps the bend of the Warp tracks that reached it',
  'mgrHelp.output.t': 'Output (Loudness Manager)',
  'mgrHelp.output.d': 'The app\'s output stage, shown here while the Manager is open: Amp, dB or Sone Lock, the final fader, meter and loudness. It is the same strip as under the header — the last control before the speakers, for the Manager and every studio.',
  'mgrHelp.gainUnit.t': 'Track fader unit (dB / sone)',
  'mgrHelp.gainUnit.d': 'How the number box next to each track fader reads and accepts values. dB = gain in decibels. sone = loudness ratio to 0 dB (×2 per +10 dB, ½ per −10 dB): type 0.5 for half as loud. The fader itself is the same either way.',
  'mgrHelp.size.t': 'Manager window size',
  'mgrHelp.size.d': 'Window = floating window. Half = docked on the right half; the studio moves aside and stays usable, for monitoring. Full = the whole window. Drag the left edge to set the width; double-click it for the default.',
  'mgrHelp.check.t': 'Track checkbox (selection)',
  'mgrHelp.check.d': 'Checks a track. The selection is shared by the Manager tools: Extend uses only the checked tracks (nothing checked = all tracks). A checked Warp track keeps its bend in the extension; an unchecked one is left out. If only Warp tracks are checked, every sounding track is extended with just their bends. The box in the header checks all / none.',
  'mgr.interp': 'Interpolate',
  'mgr.ip.all': 'Everything',
  'mgr.ipDef.all': 'Every variable moves from the left state to the right state, not only the pitch. Pitch lines are joined by smooth curves as in Pitch glide; each join is played by two layers on the same curve — one with all the settings of the left line (timbre, tremolo, level, and its track\'s fader and tremolo), one with those of the right line — crossfaded in a straight line. The layers run in step, so level and wave mix pass exactly through the values in between; settings a voice cannot change over time cross over as sound. Tracks without pitch lines are dissolved, so nothing in the two ranges is left out.',
  'mgr.ip.glide': 'Pitch glide',
  'mgr.ip.fade': 'Dissolve',
  'mgr.ipDef.glide': 'Every pitch line that sounds in the left range is joined to a line in the right range by a smooth curve: it leaves at the left pitch and slope and arrives at the right pitch and slope, with no step and no corner. Lines are paired low to low and high to high; with unequal counts a line splits or several merge. The joins are voices of new Glissando tracks (a Glissando source lends its timbre). Needs tracks with pitch lines on both sides.',
  'mgr.ipDef.fade': 'For any track, also those without pitch lines. The sound of the left range (its window, looped) carries on and leaves in the second half of the gap; the sound of the right range (its window, looped so that it runs straight into the range) enters in the first half. Both are takes of the clips as they sounded. Both are at full level around the middle, which can be up to 3 dB louder.',
  'mgr.ipFrom': 'From',
  'mgr.ipTo': 'to',
  'mgr.ipGap': (a, b, d) => `fills ${a} → ${b} s (${d} s)`,
  'mgr.ipApply': 'Interpolate',
  'mgr.ipRemove': 'Remove last',
  'mgr.ipNeedRanges': 'Make two ranges with “Select range” in the timeline — one on each side of the part to fill, or two that overlap (the overlap is filled).',
  'mgr.ipNoGap': 'These two ranges only touch: there is nothing between them to fill.',
  'mgr.ipOverlap': 'overlap',
  'mgr.layout.landscape': 'Landscape',
  'mgr.layout.portrait': 'Portrait',
  'mgr.layoutTip': 'Landscape: monitor, timeline and tracks on the left, tools on the right · Portrait: one column',
  'mgr.splitDrag': 'Drag to change the width of the left column',
  'mgr.more': 'More',
  'mgr.moreTip': 'Show / hide the rest of the track settings (tempo, cycle, start, length, loop, fades, tremolo)',
  'mgr.moreAllOpen': 'Open all',
  'mgr.moreAllClose': 'Close all',
  'mgr.ipMode.replace': 'Overwrite',
  'mgr.ipMode.add': 'Add',
  'mgr.ipModeTip.replace': 'The joined tracks give way inside the filled part (a mute range is added)',
  'mgr.ipModeTip.add': 'The transition is only layered on top: what was there keeps sounding',
  'mgr.ipDone': (name, from, to, n) => `${name}: ${from} → ${to} s filled (${n} tracks added)`,
  'mgr.ipRemoved': 'Last interpolation removed',
  'mgr.ipErrGap': 'Nothing to fill: pick two ranges with at least 0.1 s between them',
  'mgr.ipErrEmpty': 'Nothing to interpolate: no track sounds inside the two ranges',
  'mgr.ipErrLines': 'Pitch glide needs a pitch line in the left range and in the right range — use Dissolve for tracks without pitch lines',
  'mgr.ext.ip-glide': 'Interpolate: pitch glide',
  'mgr.ext.ip-fade': 'Interpolate: dissolve',
  'mgrHelp.interp.t': 'Interpolate',
  'mgrHelp.interp.d': 'Pick a range on each side; the part between them is filled with a smooth transformation from the left state to the right state. Only adds tracks, and one range that mutes what the joined tracks had in between. Uses the checked tracks (nothing checked = all). One undo step; Remove last takes it out again.',
  'mgrHelp.ipMethod.t': 'Interpolation method',
  'mgrHelp.ipMethod.d': 'Everything (the default) carries every variable across: pitch by smooth curves, level, timbre, tremolo and track settings by two layers crossfaded in step, tracks without pitch lines by a dissolve. Pitch glide joins the pitch lines of both sides with smooth curves (new Glissando tracks). Dissolve carries the sound of the left range on and brings the sound of the right range in early (takes) — for any track. The text below the buttons says exactly what the chosen one does.',
  'mgrHelp.ipRange.t': 'The two ranges',
  'mgrHelp.ipRange.d': 'The ranges on the left and right of the part to fill (made with Select range in the timeline). Their order does not matter: the earlier one is the start state. The longer a range, the longer the piece the pitch slope is measured over (a quarter of it, 0.05–0.5 s) and the longer the window Dissolve loops.',
  'mgrHelp.layout.t': 'Landscape / portrait',
  'mgrHelp.layout.d': 'Landscape (default): the Master View, the timeline and the track list on the left, Extend, Interpolate, Modulation and the ranges on the right — each column scrolls by itself; drag the line between them to change the width. Portrait: everything in one column, as before.',
  'mgrHelp.more.t': 'More track settings',
  'mgrHelp.more.d': 'A track shows its controls up to the gain; ▸ More opens the rest (tempo, cycle, start, length, loop, fades, tremolo). Open all / Close all in the header does every track.',
  'mgrHelp.ipMode.t': 'Overwrite or add',
  'mgrHelp.ipMode.d': 'Overwrite (default): inside the filled part the joined tracks give way to the transition (a mute range ⇝ n is added). Add: the transition is layered on top and what was there keeps sounding. With overlapping ranges the overlap itself is filled, from the state just before it to the state just after it.',
  'mgrHelp.ipApply.t': 'Interpolate',
  'mgrHelp.ipApply.d': 'Fills the part between the two ranges (one undo step). It is made from the tracks as they are now: after editing them, remove the interpolation and run it again.',
  'mgrHelp.ipRemove.t': 'Remove last interpolation',
  'mgrHelp.ipRemove.d': 'Removes the tracks and the mute range of the newest interpolation. Available while the interpolation is the newest step (extensions made after it are removed first, with Remove last extension).',
});
Object.assign(I18N.ko, {
  'mgr.output': '출력',
  'mgr.gainUnit': '트랙 페이더',
  'mgr.addStudio': '스튜디오 추가',
  'mgr.size.float': '창',
  'mgr.size.half': '절반',
  'mgr.size.full': '전체',
  'mgr.size.drag': '끌어서 크기 조절 · 더블클릭 = 기본 폭',
  'mgr.chkTip': '이 트랙 선택 (연장 등 선택 대상에 작동하는 도구가 사용)',
  'mgr.chkAll': '전체 선택 / 해제',
  'mgr.selUsedBy': '연장은 체크된 트랙에만 적용됩니다',
  'mgr.takeBent': '이 테이크는 닿아 있던 곡률 트랙의 휨을 유지합니다',
  'mgrHelp.output.t': '출력 (라우드니스 매니저)',
  'mgrHelp.output.d': '앱의 출력 단계를 매니저가 열려 있는 동안 여기에 보여 줍니다: Amp·dB·Sone Lock, 최종 페이더, 미터, 라우드니스. 헤더 아래 스트립과 같은 것으로, 매니저와 모든 스튜디오의 스피커 직전 마지막 제어입니다.',
  'mgrHelp.gainUnit.t': '트랙 페이더 단위 (dB / sone)',
  'mgrHelp.gainUnit.d': '트랙 페이더 옆 숫자 상자를 읽고 입력하는 단위. dB = 데시벨 이득. sone = 0 dB 대비 라우드니스 비(+10 dB마다 ×2, −10 dB마다 ½): 절반 크기면 0.5 입력. 페이더 자체는 어느 쪽이든 같습니다.',
  'mgrHelp.size.t': '매니저 창 크기',
  'mgrHelp.size.d': '창 = 떠 있는 창. 절반 = 오른쪽 절반에 고정되고 스튜디오는 옆으로 비켜 계속 사용 가능(모니터링용). 전체 = 화면 전체. 왼쪽 가장자리를 끌면 폭 조절, 더블클릭하면 기본 폭.',
  'mgrHelp.check.t': '트랙 체크박스 (선택)',
  'mgrHelp.check.d': '트랙을 체크합니다. 선택은 매니저 도구들이 함께 씁니다: 연장은 체크된 트랙에만 적용(체크 없음 = 전체). 체크된 곡률 트랙은 연장에서도 휨을 유지하고, 체크 안 된 곡률 트랙은 빠집니다. 곡률 트랙만 체크하면 소리 나는 트랙 전체가 그 곡률만으로 연장됩니다. 헤더의 상자 = 전체 선택/해제.',
  'mgr.interp': '보간',
  'mgr.ip.all': '전체',
  'mgr.ipDef.all': '음고만이 아니라 모든 변수가 왼쪽 상태에서 오른쪽 상태로 옮겨 갑니다. 음고 선은 음고 글라이드처럼 매끄러운 곡선으로 잇고, 연결선마다 같은 곡선 위에 두 층을 둡니다 — 왼쪽 선의 모든 설정(음색·트레몰로·음량, 그리고 그 트랙의 페이더·트레몰로)을 가진 층과 오른쪽 선의 설정을 가진 층 — 을 직선으로 크로스페이드합니다. 두 층은 위상이 맞아 음량과 파형 혼합이 정확히 중간값들을 거쳐 가고, 보이스가 시간에 따라 바꿀 수 없는 설정은 소리로 넘어갑니다. 음고 선이 없는 트랙은 디졸브되므로 두 구간 안의 어떤 것도 빠지지 않습니다.',
  'mgr.ip.glide': '음고 글라이드',
  'mgr.ip.fade': '디졸브',
  'mgr.ipDef.glide': '왼쪽 구간에서 울리는 음고 선마다 오른쪽 구간의 선과 매끄러운 곡선으로 잇습니다: 왼쪽의 음고·기울기로 출발해 오른쪽의 음고·기울기로 도착하므로 계단도 꺾임도 없습니다. 낮은 선끼리·높은 선끼리 짝짓고, 개수가 다르면 한 선이 갈라지거나 여러 선이 합쳐집니다. 연결선은 새 글리산도 트랙의 보이스입니다(글리산도 출처면 그 음색을 물려받음). 양쪽 모두 음고 선이 있는 트랙이 필요합니다.',
  'mgr.ipDef.fade': '음고 선이 없는 트랙을 포함해 무엇이든 가능합니다. 왼쪽 구간의 소리(그 창을 반복)가 이어지다 간격 후반에 빠지고, 오른쪽 구간의 소리(구간으로 바로 이어지도록 반복)가 전반에 들어옵니다. 둘 다 클립이 “들리던 그대로”의 테이크입니다. 가운데 부근에서는 둘 다 최대 음량이라 최대 3 dB 커질 수 있습니다.',
  'mgr.ipFrom': '시작',
  'mgr.ipTo': '→ 끝',
  'mgr.ipGap': (a, b, d) => `${a} → ${b} 초를 채움 (${d} 초)`,
  'mgr.ipApply': '보간하기',
  'mgr.ipRemove': '마지막 보간 제거',
  'mgr.ipNeedRanges': '타임라인의 “구간 선택”으로 구간을 두 개 만드세요 — 채울 부분의 양옆에 하나씩, 또는 서로 겹치게 (겹친 부분을 채움).',
  'mgr.ipNoGap': '두 구간이 맞닿기만 합니다: 사이에 채울 부분이 없습니다.',
  'mgr.ipOverlap': '겹침',
  'mgr.layout.landscape': '가로 모드',
  'mgr.layout.portrait': '세로 모드',
  'mgr.layoutTip': '가로: 왼쪽에 모니터·타임라인·트랙, 오른쪽에 도구 · 세로: 한 열',
  'mgr.splitDrag': '끌어서 왼쪽 열의 폭 조절',
  'mgr.more': '더보기',
  'mgr.moreTip': '트랙의 나머지 설정(템포·사이클·시작·길이·반복·페이드·트레몰로) 열기 / 닫기',
  'mgr.moreAllOpen': '모두 열기',
  'mgr.moreAllClose': '모두 닫기',
  'mgr.ipMode.replace': '덮어쓰기',
  'mgr.ipMode.add': '추가',
  'mgr.ipModeTip.replace': '채우는 부분에서 연결된 트랙은 자리를 비킵니다 (뮤트 구간 추가)',
  'mgr.ipModeTip.add': '전환을 위에 더하기만 합니다: 원래 있던 소리는 계속 울립니다',
  'mgr.ipDone': (name, from, to, n) => `${name}: ${from} → ${to} 초를 채움 (트랙 ${n}개 추가)`,
  'mgr.ipRemoved': '마지막 보간을 제거했습니다',
  'mgr.ipErrGap': '채울 부분이 없습니다: 사이가 0.1초 이상 떨어진 두 구간을 고르세요',
  'mgr.ipErrEmpty': '보간할 것이 없습니다: 두 구간 안에서 울리는 트랙이 없습니다',
  'mgr.ipErrLines': '음고 글라이드는 왼쪽 구간과 오른쪽 구간에 모두 음고 선이 있어야 합니다 — 음고 선이 없는 트랙은 디졸브를 쓰세요',
  'mgr.ext.ip-glide': '보간: 음고 글라이드',
  'mgr.ext.ip-fade': '보간: 디졸브',
  'mgrHelp.interp.t': '보간',
  'mgrHelp.interp.d': '양옆의 구간을 고르면 그 사이를 왼쪽 상태에서 오른쪽 상태로 매끄럽게 변형해 채웁니다. 트랙을 추가만 하고, 연결된 트랙이 사이에 갖고 있던 소리를 뮤트하는 구간 하나를 더합니다. 체크된 트랙에만 적용(체크 없음 = 전체). 실행 취소 1단계이며, 마지막 보간 제거로 다시 뺄 수 있습니다.',
  'mgrHelp.ipMethod.t': '보간 방법',
  'mgrHelp.ipMethod.d': '전체(기본값) = 모든 변수를 옮김: 음고는 매끄러운 곡선으로, 음량·음색·트레몰로·트랙 설정은 위상이 맞는 두 층의 크로스페이드로, 음고 선이 없는 트랙은 디졸브로. 음고 글라이드 = 양쪽의 음고 선을 매끄러운 곡선으로 연결(새 글리산도 트랙). 디졸브 = 왼쪽 구간의 소리를 이어 가고 오른쪽 구간의 소리를 미리 들여옴(테이크) — 어떤 트랙이든 가능. 버튼 아래 글이 고른 방법이 하는 일을 정확히 설명합니다.',
  'mgrHelp.ipRange.t': '두 구간',
  'mgrHelp.ipRange.d': '채울 부분의 왼쪽·오른쪽 구간(타임라인의 구간 선택으로 만듦). 순서는 상관없고 앞선 구간이 시작 상태입니다. 구간이 길수록 음고 기울기를 재는 길이(구간의 ¼, 0.05–0.5초)와 디졸브가 반복하는 창이 길어집니다.',
  'mgrHelp.layout.t': '가로 / 세로 모드',
  'mgrHelp.layout.d': '가로(기본): 왼쪽에 마스터 뷰·타임라인·트랙 목록, 오른쪽에 연장·보간·변조·구간 — 열마다 따로 스크롤되며 사이의 선을 끌어 폭을 바꿉니다. 세로: 예전처럼 한 열.',
  'mgrHelp.more.t': '트랙 설정 더보기',
  'mgrHelp.more.d': '트랙은 게인까지만 보여 주고, ▸ 더보기로 나머지(템포·사이클·시작·길이·반복·페이드·트레몰로)를 엽니다. 머리줄의 모두 열기 / 모두 닫기는 모든 트랙에 적용.',
  'mgrHelp.ipMode.t': '덮어쓰기 또는 추가',
  'mgrHelp.ipMode.d': '덮어쓰기(기본): 채우는 부분에서 연결된 트랙이 전환에 자리를 비킵니다(뮤트 구간 ⇝ n 추가). 추가: 전환을 위에 더하기만 하고 원래 소리는 계속 울립니다. 구간이 겹치면 겹친 부분 자체를 그 직전 상태에서 직후 상태로 채웁니다.',
  'mgrHelp.ipApply.t': '보간하기',
  'mgrHelp.ipApply.d': '두 구간 사이를 채웁니다 (실행 취소 1단계). 지금 상태의 트랙에서 만들어지므로, 트랙을 고친 뒤에는 보간을 제거하고 다시 실행하세요.',
  'mgrHelp.ipRemove.t': '마지막 보간 제거',
  'mgrHelp.ipRemove.d': '가장 최근 보간이 만든 트랙과 뮤트 구간을 지웁니다. 보간이 가장 최근 단계일 때만 가능합니다(그 뒤에 만든 연장은 “마지막 연장 제거”로 먼저 지움).',
});

const MGR_HELP_KEYS = ['output', 'gainUnit', 'size', 'check', 'helpBtn', 'cycle', 'cycleLoop', 'stopAll', 'pos', 'serial', 'parallel', 'add', 'export', 'close', 'master', 'shapeTool',
  'spectrum', 'timeline', 'clip', 'rangeTool', 'rule', 'regions', 'regionRow', 'color', 'name', 'studio', 'edit', 'launch', 'mute', 'solo',
  'gain', 'meter', 'inCycle', 'start', 'length', 'loop', 'fadeIn', 'fadeOut', 'order', 'dup', 'del', 'tempoMaster', 'tempo', 'trem', 'tremRate', 'tremDepth', 'warp', 'warpGrid', 'lenMode', 'exportVideo', 'toStart', 'extend', 'extMethod', 'extAmount', 'extApply', 'extRemove', 'take', 'interp', 'ipMethod', 'ipRange', 'ipApply', 'ipRemove', 'ipMode', 'layout', 'more'];

function registerManagerHelp() {
  const entry = (lang, k) => ({ title: I18N[lang][`mgrHelp.${k}.t`], summary: I18N[lang][`mgrHelp.${k}.d`], detail: '', formula: '' });
  for (const k of MGR_HELP_KEYS) HELP_DB[`mgr.${k}`] = { en: entry('en', k), ko: entry('ko', k) };
  // The header button describes what the Manager actually does / 헤더 버튼 설명
  HELP_DB['app.manager'] = {
    en: { title: 'Manager', summary: 'Open the Manager (M): run several Glissando / Risset / Field instances at once, in series or in parallel.', detail: 'Inside it: Master View, cycle timeline, range and shape selection with per-instance solo / mute, and one track strip per instance. The badge shows how many tracks are playing.', formula: '' },
    ko: { title: '매니저', summary: '매니저를 엽니다 (M): 글리산도·리세·필드 인스턴스 여러 개를 직렬/병렬로 동시에 실행합니다.', detail: '마스터 뷰, 사이클 타임라인, 인스턴스별 솔로/뮤트가 되는 구간·모양 선택, 인스턴스마다 트랙 스트립이 있습니다. 배지 = 재생 중인 트랙 수.', formula: '' },
  };
}
registerManagerHelp();

export function isManagerOpen() {
  return !!appState.manager?.open;
}

/** Play ⇄ stop the Manager cycle (the ▶ button, and Space while the Manager is open). / 매니저 사이클 재생·정지 */
export async function toggleManagerCycle() {
  try {
    const wasPlaying = mixer.isCyclePlaying();
    const ok = await mixer.toggleCycle();
    if (!wasPlaying && !ok) hooks.showToast(t('mgr.nothingToPlay'), 'error');
  } catch (err) {
    console.error(err);
    hooks.showToast(String(err.message || err), 'error');
  }
  hooks.requestRender(['manager']);
}

export function toggleManagerPanel(open = !isManagerOpen()) {
  setManagerPref({ open });
}

function isEditing() {
  const a = document.activeElement;
  return !!(panel && a && panel.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'));
}

/** Called from main.js flush(). / 렌더 루프에서 호출 */
export function renderManagerPanel(scopes) {
  ensureManager();
  renderHeaderBits();
  if (!panel) return;
  const open = isManagerOpen();
  panel.classList.toggle('mgr-hidden', !open);
  if (!open) {
    stopLoop();
    if (stripHome || document.body.classList.contains('mgr-docked')) {
      restoreOutputStrip();
      applySize();
      globalThis.dispatchEvent(new Event('resize'));
    }
    return;
  }
  const trivial = scopes && scopes.size && [...scopes].every((s) => s === 'transport' || s === 'canvas' || s === 'view' || s === 'gain');
  if (!panel.firstChild || !trivial) renderPanel();
  if (!stripHome) { mountOutputStrip(); applySize(); }
  startLoop();
}

function renderHeaderBits() {
  const btn = document.getElementById('btnManager');
  btn?.setAttribute('aria-pressed', isManagerOpen() ? 'true' : 'false');
  const badge = document.getElementById('mgrBadge');
  if (badge) {
    const n = mixer.activeChannelCount();
    badge.textContent = n ? `▶ ${n}` : '';
    badge.classList.toggle('hidden', !n);
    badge.title = n ? t('mgr.playing', n) : '';
  }
  // Studio tabs show the focused instance when a studio has several / 탭에 포커스 인스턴스 표시
  for (const tab of document.querySelectorAll('#studioTabs [data-studio]')) {
    const studio = tab.dataset.studio;
    const same = listInstances().filter((i) => i.studio === studio);
    let b = tab.querySelector('.fx-inst-badge');
    if (same.length > 1) {
      if (!b) { b = document.createElement('span'); b.className = 'fx-inst-badge'; tab.appendChild(b); }
      const f = same.find((i) => isFocused(i));
      b.textContent = f ? f.name : '';
    } else if (b) b.remove();
  }
}

// ==========================================================================
// Markup / 마크업
// ==========================================================================

function niceViewLen(c) {
  const steps = [2, 4, 5, 8, 10, 12, 15, 20, 30, 40, 60, 90, 120, 180, 240, 300];
  const want = c * 1.06;
  return steps.find((s) => s >= want) || Math.ceil(want / 60) * 60;
}

function tickStep(len) {
  return [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => len / s <= 12) || 60;
}

const pct = (sec) => `${clamp((sec / ui.viewLen) * 100, 0, 100)}%`;

function renderPanel() {
  if (ui.drag) return;
  if (isEditing()) { ui.deferred = true; return; }
  const m = appState.manager;
  const C = mixer.cycleLength();
  ui.viewLen = niceViewLen(Math.max(C, mixer.totalLength()));
  const playing = mixer.isCyclePlaying();
  if (ui.selRegion && !listRegions().some((r) => r.id === ui.selRegion)) ui.selRegion = null;
  // A re-render replaces the scroll box: keep where the user had scrolled to (track edits used to jump to the top)
  // 재렌더는 스크롤 상자를 새로 만듦: 스크롤 위치 유지 (트랙 편집 시 맨 위로 튀던 문제)
  const prevScroll = panel.querySelector('.mgr-scroll');
  if (prevScroll) ui.scrollTop = prevScroll.scrollTop;
  const prevCols = [...panel.querySelectorAll('.mgr-col')].map((c) => c.scrollTop);
  if (prevCols.length) ui.colScroll = prevCols;
  const land = mgrLayout.mode !== 'portrait';
  restoreOutputStrip(); // the Loudness Manager strip is moved back before innerHTML drops it / innerHTML 전에 출력 스트립 회수
  panel.innerHTML = `
    <div class="mgr-bar">
      <button type="button" class="mgr-title" data-act="close" data-help="mgr.close" title="${esc(t('mgr.titleClose'))}">⧉ ${esc(t('mgr.title'))}</button>
      <button class="mgr-btn play ${playing ? 'on' : ''}" data-act="cycle" data-help="mgr.cycle">${playing ? '■' : '▶'} ${esc(t(playing ? 'mgr.stopCycle' : 'mgr.playCycle'))}</button>
      <button class="mgr-btn" data-act="toStart" data-help="mgr.toStart" title="${esc(t('mgr.toStart'))}">⏮</button>
      <button class="mgr-btn ${m.cycleLoop ? 'on' : ''}" data-act="cycleLoop" data-help="mgr.cycleLoop">↻ ${esc(t('mgr.cycleLoop'))}</button>
      <button class="mgr-btn danger" data-act="stopAll" data-help="mgr.stopAll">■ ${esc(t('mgr.stopAll'))}</button>
      <span class="mgr-mono mgr-muted" id="mgrPos" data-help="mgr.pos">${esc(t('mgr.cyclePos', '0.00', fmt(C)))}</span>
      <span class="mgr-sep"></span>
      ${tempoControl('master', getMasterTempo(), 'tempoMaster', t('mgr.tempoManager'))}
      <span class="mgr-sep"></span>
      <span class="mgr-muted">${esc(t('mgr.arrange'))}</span>
      <button class="mgr-btn" data-act="serial" data-help="mgr.serial">⇢ ${esc(t('mgr.serial'))}</button>
      <button class="mgr-btn" data-act="parallel" data-help="mgr.parallel">⇉ ${esc(t('mgr.parallel'))}</button>
      <span class="mgr-sep"></span>
      <button class="mgr-btn" data-act="export" data-help="mgr.export">⬇ ${esc(t('mgr.exportCycle'))}</button>
      <button class="mgr-btn" data-act="exportVideo" data-help="mgr.exportVideo">🎬 ${esc(t('mgr.exportVideo'))}</button>
      <button class="mgr-btn" data-act="exportTracks" data-help="app.trackExport" title="${esc(t('trx.menuTip'))}">🎚 ${esc(t('trx.title'))}</button>
      <span style="flex:1"></span>
      <button class="mgr-btn" data-act="mgrLayout" data-help="mgr.layout" title="${esc(t('mgr.layoutTip'))}">⇄ ${esc(t(land ? 'mgr.layout.landscape' : 'mgr.layout.portrait'))}</button>
      ${sizeMarkup()}
      <button class="mgr-btn" data-act="help" data-help="mgr.helpBtn" title="${esc(t('mgr.help'))} (H)">? ${esc(t('mgr.help'))}</button>
      <button class="mgr-btn" data-act="close" data-help="mgr.close" title="${esc(t('mgr.close'))} (M)">✕</button>
    </div>
    <div class="mgr-out" data-help="mgr.output"><span class="mgr-out-label">${esc(t('mgr.output'))}</span><span class="mgr-out-host"></span>
      <span class="mgr-field" data-help="mgr.gainUnit">${esc(t('mgr.gainUnit'))}${['db', 'sone'].map((u) => `<button class="mgr-btn tiny ${ui.gainUnit === u ? 'on' : ''}" data-act="gainUnit" data-unit="${u}">${u === 'db' ? 'dB' : 'sone'}</button>`).join('')}</span></div>
    ${land ? `
    <div class="mgr-scroll mgr-split" style="--mgr-left:${mgrLayout.left}%">
      <div class="mgr-col mgr-col-l custom-scroll">
        ${masterMarkup()}
        ${timelineMarkup(C)}
        ${channelsMarkup()}
      </div>
      <div class="mgr-split-bar" data-mgr-split title="${esc(t('mgr.splitDrag'))}"></div>
      <div class="mgr-col mgr-col-r custom-scroll">
        ${extendMarkup(C)}
        ${interpMarkup()}
        <div class="mgr-mods-host"></div>
        <div class="mgr-scenes-host"></div>
        ${regionsMarkup()}
      </div>
    </div>` : `
    <div class="mgr-scroll custom-scroll">
      ${masterMarkup()}
      ${timelineMarkup(C)}
      ${extendMarkup(C)}
      ${interpMarkup()}
      <div class="mgr-mods-host"></div>
        <div class="mgr-scenes-host"></div>
      ${regionsMarkup()}
      ${channelsMarkup()}
    </div>`}`;
  const sc = panel.querySelector('.mgr-scroll');
  if (sc && ui.scrollTop && !land) sc.scrollTop = ui.scrollTop;
  if (land && ui.colScroll) panel.querySelectorAll('.mgr-col').forEach((c, k) => { c.scrollTop = ui.colScroll[k] || 0; });
  mountOutputStrip();
  mountModsCard(panel.querySelector('.mgr-mods-host'), { showToast: hooks.showToast }); // ⇆ Modulation (ui/manager-mods.js)
  mountScenesCard(panel.querySelector('.mgr-scenes-host'), { showToast: hooks.showToast }); // ▶ Scenes (ui/manager-scenes.js)
  applySize();
  drawMaster();
  placeWarpPop();
}

// --------------------------------------------------------------------------
// Output (Loudness Manager) inside the Manager / 매니저 안의 출력(라우드니스 매니저)
// The app's own output strip (ui/output-panel.js: Amp / dB / Sone Lock, fader, meter) is moved into
// the Manager while it is open — one strip, one set of listeners, the same appState.output — and
// moved back under the header when the Manager closes. / 같은 스트립을 매니저로 옮겼다가 닫으면 되돌림.
// --------------------------------------------------------------------------

let stripHome = null; // { parent, next } where #outputStrip lives in the header / 원래 위치

function mountOutputStrip() {
  const host = panel?.querySelector('.mgr-out-host');
  const strip = document.getElementById('outputStrip');
  if (!host || !strip || !isManagerOpen()) return;
  if (strip.parentElement === host) return;
  if (!stripHome) stripHome = { parent: strip.parentElement, next: strip.nextSibling };
  host.appendChild(strip);
  strip.classList.add('in-mgr');
}

function restoreOutputStrip() {
  const strip = document.getElementById('outputStrip');
  if (!strip || !stripHome || !panel?.contains(strip)) return;
  stripHome.parent.insertBefore(strip, stripHome.next && stripHome.next.parentNode === stripHome.parent ? stripHome.next : null);
  strip.classList.remove('in-mgr');
  stripHome = null;
}

// --------------------------------------------------------------------------
// Window size: Float (default) · Full screen · Half (docked right, the studio stays usable beside it)
// plus a drag handle on the left edge. A view preference (localStorage), not part of the document.
// 창 크기: 기본 · 전체 화면 · 절반(오른쪽 도킹, 옆에서 스튜디오 계속 사용) + 왼쪽 가장자리 드래그. 보기 설정(localStorage).
// --------------------------------------------------------------------------

// Layout of the Manager: landscape (default) = window + timeline + track list on the left, tools on the right;
// portrait = one column as before. A view preference (localStorage). / 가로(기본) = 왼쪽 윈도우·타임라인·트랙, 오른쪽 도구; 세로 = 한 열
const LAYOUT_KEY = 'flexatone.mgrLayout.v1';
const mgrLayout = (() => {
  try { const o = JSON.parse(globalThis.localStorage?.getItem(LAYOUT_KEY) || '{}'); return { mode: o.mode === 'portrait' ? 'portrait' : 'landscape', left: clamp(Number(o.left) || 66, 35, 85) }; } catch { return { mode: 'landscape', left: 66 }; }
})();
function saveMgrLayout() {
  try { globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(mgrLayout)); } catch { /* session only */ }
}
/** Drag the line between the two columns. / 두 열 사이 선 끌기 */
function onSplitDown(e, bar) {
  e.preventDefault();
  const box = bar.parentElement;
  const r = box.getBoundingClientRect();
  const move = (ev) => { mgrLayout.left = clamp(((ev.clientX - r.left) / Math.max(1, r.width)) * 100, 35, 85); box.style.setProperty('--mgr-left', `${mgrLayout.left}%`); };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveMgrLayout(); drawMaster(); globalThis.dispatchEvent(new Event('resize')); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

const SIZE_KEY = 'flexatone.mgrSize.v2'; // v2: full screen is the default (2026-11-23) / 기본 = 전체 화면
const SIZES = ['float', 'half', 'full'];
const SIZE_ICONS = { float: '▭', half: '◨', full: '⛶' };

function loadSize() {
  try {
    const o = JSON.parse(globalThis.localStorage?.getItem(SIZE_KEY) || '{}');
    return { mode: SIZES.includes(o.mode) ? o.mode : 'full', width: Number(o.width) >= 320 ? Number(o.width) : null, anchor: o.anchor === 'left' ? 'left' : null, offset: Number.isFinite(o.offset) ? o.offset : null };
  } catch { return { mode: 'full', width: null }; }
}
let size = loadSize();
function saveSize() {
  try { globalThis.localStorage?.setItem(SIZE_KEY, JSON.stringify(size)); } catch { /* private mode: session only */ }
}

function sizeMarkup() {
  return `<span class="mgr-field" data-help="mgr.size">${SIZES.map((m) => `<button class="mgr-btn tiny ${size.mode === m ? 'on' : ''}" data-act="size" data-size="${m}" title="${esc(t(`mgr.size.${m}`))}">${SIZE_ICONS[m]} ${esc(t(`mgr.size.${m}`))}</button>`).join('')}</span>`;
}

/**
 * Apply the size mode to the panel and (Half) make room for it beside the studio. Both side edges
 * resize it in every mode — in Full too (the panel then keeps the full height at the dragged width,
 * against the opposite edge). Double-click an edge = back to the mode's own width.
 * 크기 적용. 양쪽 가장자리로 모든 모드(전체 포함)에서 폭 조절 — 반대쪽에 붙은 채 전체 높이 유지. 더블클릭 = 원래 폭.
 */
function applySize() {
  if (!panel) return;
  const open = isManagerOpen();
  panel.dataset.size = size.mode;
  const w = size.width ? Math.min(size.width, globalThis.innerWidth - 40) : null;
  panel.style.width = w ? `${w}px` : '';
  // anchored against the side opposite the dragged edge / 끈 가장자리 반대쪽에 고정
  const anchorLeft = w && size.anchor === 'left' && size.mode !== 'half';
  // the anchored side keeps where it was (px from that screen edge) / 고정된 쪽은 원래 위치 유지
  const gapPx = size.mode === 'full' ? 0 : 12;
  const off = Number.isFinite(size.offset) ? Math.max(0, Math.min(size.offset, globalThis.innerWidth - (w || 0))) : gapPx;
  panel.style.left = w ? (anchorLeft ? `${off}px` : 'auto') : '';
  panel.style.right = w ? (anchorLeft ? 'auto' : `${size.mode === 'half' ? 0 : off}px`) : '';
  const docked = open && size.mode === 'half';
  document.body.classList.toggle('mgr-docked', docked);
  document.body.style.setProperty('--mgr-dock-w', docked ? `${Math.round(panel.getBoundingClientRect().width + 12)}px` : '0px');
  for (const side of ['l', 'r']) {
    if (panel.querySelector(`.mgr-edge.${side}`)) continue;
    const edge = document.createElement('div');
    edge.className = `mgr-edge ${side}`;
    edge.title = t('mgr.size.drag');
    edge.addEventListener('pointerdown', (e) => onEdgeDown(e, side));
    edge.addEventListener('dblclick', () => { size.width = null; size.anchor = null; size.offset = null; saveSize(); applySize(); drawMaster(); globalThis.dispatchEvent(new Event('resize')); });
    panel.appendChild(edge);
  }
}

function setSizeMode(mode) {
  if (!SIZES.includes(mode)) return;
  size.mode = mode;
  size.width = null; // a size button gives the mode's own width / 크기 버튼 = 그 모드의 기본 폭
  size.anchor = null;
  size.offset = null;
  saveSize();
  renderPanel();
  globalThis.dispatchEvent(new Event('resize')); // studio canvases re-measure beside a docked Manager / 캔버스 재측정
}

function onEdgeDown(e, side = 'l') {
  if (e.button !== 0 || (size.mode === 'half' && side === 'r')) return;
  e.preventDefault();
  const r = panel.getBoundingClientRect();
  size.anchor = side === 'l' ? 'right' : 'left';
  size.offset = Math.round(side === 'l' ? globalThis.innerWidth - r.right : r.left);
  const move = (ev) => {
    const raw = side === 'l' ? r.right - ev.clientX : ev.clientX - r.left;
    size.width = Math.round(clamp(raw, 360, globalThis.innerWidth));
    applySize();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (size.width >= globalThis.innerWidth - 4) { size.width = null; size.anchor = null; size.offset = null; applySize(); } // dragged back to the edge / 끝까지 끌면 원래대로
    saveSize();
    drawMaster();
    globalThis.dispatchEvent(new Event('resize'));
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Keep the open Warp options inside the panel (shift left, cap the width). / 곡률 옵션이 패널 밖으로 나가지 않게 */
function placeWarpPop() {
  const pop = panel?.querySelector('.mgr-warp-pop');
  const box = panel?.querySelector('.mgr-scroll')?.getBoundingClientRect();
  if (!pop || !box) return;
  pop.style.maxWidth = `${Math.max(240, box.width - 28)}px`;
  pop.style.left = '0px';
  const r = pop.getBoundingClientRect();
  const over = r.right - (box.right - 14);
  if (over > 0) pop.style.left = `${-Math.min(over, Math.max(0, r.left - box.left - 14))}px`;
}

/**
 * Studios that can be added: one "＋ Studio" button per registered studio, all in the same row
 * (the non-base ones used to hide in a "＋ …" menu that was easy to miss).
 * 추가 가능한 스튜디오: 등록된 스튜디오마다 "＋ 스튜디오" 버튼 하나 (예전에는 기본 3개 외에는 "＋ …" 메뉴에 숨어 있었음).
 */
function addStudioMarkup() {
  // One "＋ Add studio ▾" button; its menu lists the studios (all of them, none hidden). / 버튼 하나 + 하위 메뉴
  const avail = MANAGER_STUDIOS.filter((s) => BASE_MANAGER_STUDIOS.includes(s) || StudioRegistry.has(s));
  const menu = ui.addOpen
    ? `<div class="mgr-add-menu" role="menu">${avail.map((s) => `<button class="mgr-add-item" role="menuitem" data-act="add" data-studio="${s}"><span class="mgr-studio ${s}">${esc(studioShortName(s))}</span>${esc(t(`studio.${s}`))}</button>`).join('')}</div>`
    : '';
  return `<span class="mgr-add-anchor"><button class="mgr-btn ${ui.addOpen ? 'on' : ''}" data-act="addMenu" data-help="mgr.add" aria-haspopup="menu" aria-expanded="${ui.addOpen ? 'true' : 'false'}">＋ ${esc(t('mgr.addStudio'))} ${ui.addOpen ? '▴' : '▾'}</button>${menu}</span>`;
}

/** Cycle length mode (Total ⇄ Set) for the Master View header. / 사이클 길이 모드 */
function lengthModeMarkup() {
  const m = appState.manager;
  const fixed = m.cycleMode === 'fixed';
  const total = mixer.totalLength();
  const len = Number(m.cycleLen) >= 0.1 ? Number(m.cycleLen) : total;
  return `<span class="mgr-field" data-help="mgr.lenMode">${esc(t('mgr.lenMode'))}
      <button class="mgr-btn tiny ${fixed ? '' : 'on'}" data-act="lenMode" data-mode="auto">${esc(t('mgr.lenAuto'))}</button><button class="mgr-btn tiny ${fixed ? 'on' : ''}" data-act="lenMode" data-mode="fixed">${esc(t('mgr.lenFixed'))}</button>
      ${fixed
        ? `<input type="number" min="0.1" step="0.1" value="${fmt(len)}" data-cycle-len style="width:64px"><span class="mgr-muted">s</span>
           <button class="mgr-btn tiny" data-act="lenUseTotal" title="${esc(t('mgr.lenUseTotal'))}">⇥</button>
           <span class="mgr-muted mgr-mono">${esc(t('mgr.lenTotal', fmt(total)))}</span>`
        : `<span class="mgr-mono mgr-muted">${fmt(total)} s</span>`}
    </span>`;
}

/**
 * Tempo control (× ⇄ BPM) for the master (`who` = 'master') or one track (`who` = instance id).
 * 템포 컨트롤 (× ⇄ BPM): 마스터 또는 트랙.
 */
function tempoControl(who, cfg, help, label) {
  const c = normalizeTempoConfig(cfg);
  const bpm = c.mode === 'bpm';
  const data = `data-tempo="${who}"`;
  return `<span class="mgr-field" data-help="mgr.${help}">${esc(label)}
    <button class="mgr-btn tiny ${bpm ? '' : 'on'}" data-act="tempoMode" data-tempo-mode="rate" ${data} title="×">${esc(t('mgr.tempoRate'))}</button><button class="mgr-btn tiny ${bpm ? 'on' : ''}" data-act="tempoMode" data-tempo-mode="bpm" ${data}>${esc(t('mgr.tempoBpm'))}</button>
    <input type="number" ${bpm ? 'min="10" max="960" step="1"' : 'min="0.1" max="8" step="0.05"'} value="${bpm ? +c.bpm.toFixed(2) : +c.rate.toFixed(3)}" data-tempo-field="${bpm ? 'bpm' : 'rate'}" ${data} style="width:64px">
    ${bpm ? `<span class="mgr-muted">${esc(t('mgr.tempoRef'))}</span><input type="number" min="10" max="960" step="1" value="${+c.refBpm.toFixed(2)}" data-tempo-field="refBpm" ${data} style="width:56px">` : ''}
    <button class="mgr-btn tiny" data-act="tempoReset" ${data} title="${esc(t('mgr.tempoReset'))}">↺</button></span>`;
}

function masterMarkup() {
  const s = ui.shape;
  let hint = t('mgr.masterHint');
  let cls = '';
  if (s) {
    cls = 'warn';
    hint = !s.a ? t('mgr.shapeHintA') : !s.b ? t('mgr.shapeHintB') : t('mgr.shapeHintPick');
  }
  return `
    <section class="mgr-card" data-rack="mgr-master">
      <div class="mgr-card-head">
        <h3>◉ ${esc(t('mgr.masterView'))}</h3>
        ${lengthModeMarkup()}
        <button class="mgr-btn ${s ? 'on' : ''}" data-act="shapeTool" data-help="mgr.shapeTool">⬭ ${esc(t('mgr.toolShape'))}</button>
        <button class="mgr-btn warp ${ui.warpGrid ? 'on' : ''}" data-act="warpGrid" data-help="mgr.warpGrid" ${mixer.getMasterViewWarp() ? '' : `title="${esc(t('mgr.warpGridNone'))}"`}>⌇ ${esc(t('mgr.warpGrid'))}</button>
        ${s && s.b ? `<button class="mgr-btn play" data-act="shapeConfirm" ${s.picked.size ? '' : 'disabled'}>✓ ${esc(t('mgr.confirm'))} (${s.picked.size}/${s.lobes.length})</button>` : ''}
        ${s ? `<button class="mgr-btn" data-act="shapeCancel">${esc(t('mgr.cancel'))}</button>` : ''}
        <span class="mgr-hint ${cls}" id="mgrMasterHint">${esc(hint)}</span>
      </div>
      <div class="mgr-canvas-wrap" data-help="mgr.master"><canvas id="mgrMaster" style="height:280px;cursor:${s || ui.tool === 'range' ? 'crosshair' : 'col-resize'}"></canvas><span class="mgr-readout mgr-mono" id="mgrReadout"></span></div>
      <div class="mgr-canvas-wrap" style="border-top:1px solid #1e293b" data-help="mgr.spectrum"><canvas id="mgrSpectrum" style="height:84px"></canvas><span class="mgr-readout" style="top:4px">${esc(t('mgr.spectrum'))}</span></div>
    </section>${spaceMasterMarkup()}`;
}

/**
 * Space Master strip: its own place next to the Master View (Space also stays in "Add studio" as an
 * ordinary track). On = every track is a source of the master Space scene (audio/space-master.js).
 * 스페이스 마스터 스트립: 마스터 뷰 옆의 전용 자리 ("스튜디오 추가"의 스페이스는 그대로 일반 트랙).
 */
function spaceMasterMarkup() {
  const m = getSpaceMaster();
  const n = m.doc.sources.filter((x) => x.input?.kind === 'track' && !x.input.bypass).length;
  const state = m.on ? t('mgr.spaceMasterOn', n, t(`space.panMode.${m.doc.panMode}`)) : t('mgr.spaceMasterOff');
  return `
    <section class="mgr-card" data-rack="mgr-space-master" data-help="space.master">
      <div class="mgr-card-head">
        <h3>⌖ ${esc(t('mgr.spaceMaster'))}</h3>
        <button class="mgr-btn play ${m.on ? 'on' : ''}" data-act="smPower" data-help="space.master">${m.on ? '■' : '▶'} ${esc(t('env.on'))}</button>
        <button class="mgr-btn" data-act="smEdit" data-help="space.master">${esc(t('mgr.spaceMasterEdit'))}</button>
        <span class="mgr-hint ${m.on ? '' : 'warn'}">${esc(state)}</span>
        <span class="mgr-hint">${esc(t('mgr.spaceMasterHint'))}</span>
      </div>
    </section>`;
}

/** One Space Master source per track (new tracks get a place on the arc). / 트랙마다 마스터 음원 하나 */
function syncSpaceMaster() {
  const m = getSpaceMaster();
  const C = mixer.cycleLength();
  const len = C > 0 && Number.isFinite(C) ? C : 30;
  const next = syncMasterSources(m.doc, listInstances().map((i) => ({ id: i.id, name: i.name, color: i.color })), len);
  if (next) editSpaceMaster((d) => { d.doc.sources = next; if (!next.some((x) => x.id === d.doc.activeSourceId)) d.doc.activeSourceId = next[0]?.id || ''; d.doc.length = Math.max(d.doc.length, Math.min(300, len)); }, { history: false });
}

function timelineMarkup(C) {
  const step = tickStep(ui.viewLen);
  let ticks = '';
  for (let s = 0; s <= ui.viewLen + 1e-9; s += step) ticks += `<span class="mgr-tick" style="left:${pct(s)}">${+s.toFixed(2)}s</span>`;
  const regions = listRegions();
  const rulerTags = regions.map((r) => `<span class="mgr-band ${r.kind} ${r.id === ui.selRegion ? 'sel' : ''}" style="left:${pct(r.t0)};width:calc(${pct(r.t1)} - ${pct(r.t0)})"></span>`).join('');
  const fixed = mixer.fixedCycleLength() !== null;
  const total = mixer.totalLength();
  const totalTag = fixed && Math.abs(total - C) > 1e-3 ? `<span class="mgr-tick" style="left:${pct(total)};border-left:1px dashed #64748b;color:#64748b">Σ ${fmt(total)}s</span>` : '';
  const cycleEnd = `${totalTag}<span class="mgr-tick ${fixed ? 'mgr-cycle-end' : ''}" ${fixed ? 'data-cycle-end' : ''} style="left:${pct(C)};border-left:2px solid #6366f1;color:#a5b4fc">⟲ ${fmt(C)}s</span>`;
  let firstRule = true;
  const lanes = listInstances().map((inst, laneIdx) => {
    const L = mixer.clipLength(inst);
    const nat = mixer.naturalLength(inst);
    const reps = [];
    if (inst.loop && Number.isFinite(nat) && nat > 0.05) for (let k = 1; k * nat < L - 1e-6 && k < 60; k++) reps.push(`<span class="mgr-rep" style="left:${(k * nat / L) * 100}%"></span>`);
    const dim = !inst.inCycle || !isInstanceAudible(inst);
    const bands = regions.map((r) => {
      const rule = regionRule(r, inst.id);
      const mid = (Math.max(0, r.t0) + Math.min(ui.viewLen, r.t1)) / 2;
      return `<span class="mgr-band ${r.kind} ${r.id === ui.selRegion ? 'sel' : ''}" style="left:${pct(r.t0)};width:calc(${pct(r.t1)} - ${pct(r.t0)})"></span>
        <button class="mgr-rule ${rule || ''}" ${firstRule ? ((firstRule = false), 'data-help="mgr.rule"') : ''} style="left:${pct(mid)}" data-act="rule" data-region="${r.id}" data-id="${inst.id}" title="${esc(r.name)} — ${esc(t('mgr.ruleTip'))}">${rule === 'solo' ? 'S' : rule === 'mute' ? 'M' : '·'}</button>`;
    }).join('');
    return `
      <div class="mgr-tl-row ${selClass(inst.id)}" style="--sel:${esc(inst.color)}">
        <div class="mgr-tl-label" data-act="selTrack" data-id="${inst.id}" title="${esc(inst.name)} — ${esc(t('mgr.selTip'))}"><span class="mgr-dot" style="background:${esc(inst.color)}"></span><span style="overflow:hidden;text-overflow:ellipsis">${esc(inst.name)}</span></div>
        <div class="mgr-tl-track" data-lane="${inst.id}">
          ${L >= 0.02 ? `<div class="mgr-clip ${dim ? 'dim' : ''}" ${laneIdx === 0 ? 'data-help="mgr.clip"' : ''} data-clip="${inst.id}" style="left:${pct(inst.start)};width:calc(${pct((Number(inst.start) || 0) + L)} - ${pct(inst.start)});background:${esc(inst.color)}">${inst.take?.on ? (takeReversals(inst.take) % 2 ? '◀ ' : '▶ ') : ''}${inst.take?.on && mixer.getTrackWarp(mixer.takeContext(inst)) ? `<span title="${esc(t('mgr.takeBent'))}">⌇ </span>` : ''}${esc(inst.name)} · ${fmt(L, 1)}s${reps.join('')}<span class="mgr-resize" data-resize="${inst.id}"></span></div>` : ''}
          ${bands}
        </div>
      </div>`;
  }).join('');
  return `
    <section class="mgr-card" data-rack="mgr-timeline">
      <div class="mgr-card-head">
        <h3>▤ ${esc(t('mgr.timeline'))}</h3>
        <button class="mgr-btn ${ui.tool === 'range' ? 'on' : ''}" data-act="rangeTool" data-help="mgr.rangeTool">⬚ ${esc(t('mgr.toolRange'))}</button>
        <span class="mgr-hint">${esc(ui.tool === 'range' ? t('mgr.rangeHint') : '')}</span>
      </div>
      <div class="mgr-tl ${ui.tool === 'range' ? 'tool-range' : ''}" id="mgrTimeline" data-help="mgr.timeline">
        <div class="mgr-tl-row mgr-tl-ruler"><div class="mgr-tl-label mgr-muted">s</div><div class="mgr-tl-track" data-lane="">${ticks}${cycleEnd}${rulerTags}</div></div>
        ${lanes}
        <div class="mgr-tl-row" style="position:absolute;inset:0;pointer-events:none"><div></div><div style="position:relative"><span class="mgr-cue mgr-hidden" id="mgrCue"></span><span class="mgr-playhead mgr-hidden" id="mgrPlayhead"></span></div></div>
      </div>
    </section>`;
}

/** Icons of the Extend methods (labels and texts are i18n mgr.ext.<id> / mgr.extDef.<id> / mgr.extHow.<id>). */
const EXT_ICONS = { retro: '◀', mirror: '◁', canon: '⏦', swap: '⇄', arc: '↗', rondo: '❖', 'ip-glide': '⇝', 'ip-fade': '⇝' };

/** Seconds the Extend tool would add now: the typed value, or the chosen multiple of the cycle. / 지금 연장할 초 */
function extendSeconds(C) {
  const x = ui.ext.sec !== null ? ui.ext.sec : C * ui.ext.mult;
  return clamp(Math.round(x * 100) / 100, 0, maxExtension(C));
}

/**
 * Extend card: pick a method (button), pick how much (× cycle or seconds), Extend. The text under the
 * buttons says what the method takes "musical" to mean and what it does.
 * 연장 카드: 방법(버튼)과 양(사이클 배수·초)을 고르고 연장. 버튼 아래 글 = 그 방법이 정의하는 "음악적임"과 하는 일.
 */
function extendMarkup(C) {
  if (!EXTEND_METHODS.includes(ui.ext.method)) ui.ext.method = EXTEND_METHODS[0];
  const X = extendSeconds(C);
  const pv = extendPreview(ui.ext.method, C, X); // a method may settle on its own length / 방법이 길이를 정할 수 있음
  const log = listExtensions();
  const last = log[log.length - 1];
  const methods = EXTEND_METHODS.map((id, k) => `<button class="mgr-btn ext ${ui.ext.method === id ? 'on' : ''}" data-act="extMethod" data-method="${id}" ${k === 0 ? 'data-help="mgr.extMethod"' : ''} title="${esc(t(`mgr.extDef.${id}`))}">${k + 1} ${EXT_ICONS[id] || '⤳'} ${esc(t(`mgr.ext.${id}`))}</button>`).join('');
  const mults = [0.25, 0.5, 1, 2].map((m) => `<button class="mgr-btn tiny ${ui.ext.sec === null && ui.ext.mult === m ? 'on' : ''}" data-act="extMult" data-mult="${m}">×${m === 0.25 ? '¼' : m === 0.5 ? '½' : m}</button>`).join('');
  const ok = X >= EXTEND_MIN_SEC;
  const history = log.map((x, k) => `<span class="mgr-ext-step" title="${esc(t(`mgr.ext.${x.method}`))}">${k + 1}. ${EXT_ICONS[x.method] || '⤳'} ${fmt(x.from, 1)} → ${fmt(x.to, 1)} s</span>`).join('');
  return `
    <section class="mgr-card mgr-extend" data-rack="mgr-extend" data-help="mgr.extend">
      <div class="mgr-card-head">
        <h3>⤳ ${esc(t('mgr.extend'))}</h3>
        ${methods}
        <span class="mgr-sep"></span>
        <span class="mgr-field" data-help="mgr.extAmount">${esc(t('mgr.extAmount'))} ${mults}
          <input type="number" min="${EXTEND_MIN_SEC}" step="0.1" value="${fmt(X)}" data-ext-sec style="width:68px"><span class="mgr-muted">s</span></span>
        <span class="mgr-mono mgr-muted">${fmt(C, 1)} → ${fmt(C + pv.seconds, 1)} s${pv.note ? ` · ${esc(pv.note)}` : ''}</span>
        <button class="mgr-btn play" data-act="extApply" data-help="mgr.extApply" ${ok ? '' : 'disabled'}>＋ ${esc(t('mgr.extApply'))}</button>
        <button class="mgr-btn" data-act="extRemove" data-help="mgr.extRemove" ${last ? '' : 'disabled'}>↶ ${esc(t('mgr.extRemove'))}</button>
      </div>
      <div class="mgr-ext-body">
        <p><b>${esc(t('mgr.extDefLabel'))}</b> ${esc(t(`mgr.extDef.${ui.ext.method}`))}</p>
        <p><b>${esc(t('mgr.extHowLabel'))}</b> ${esc(t(`mgr.extHow.${ui.ext.method}`))}</p>
        ${history ? `<p class="mgr-muted">${esc(t('mgr.extLog'))} ${history}</p>` : ''}
      </div>
    </section>`;
}

/**
 * Envelope value (0…1, before baseGain) of the Glissando voice `key` of track `instId` at cycle time `sec`,
 * or null when it cannot be read (another studio, a take, a Warp time drive). Interpolate starts and ends
 * its level there. / 사이클 시각 sec에서 글리산도 보이스의 엔벨로프 값 (읽을 수 없으면 null)
 */
function lineEnvelopeAt(instId, key, sec) {
  const inst = getInstance(instId);
  if (!inst || inst.studio !== 'glissando' || inst.take?.on || mixer.getTrackTime(inst.id)) return null;
  const v = (getInstanceDoc(inst)?.voices || []).find((x) => x.id === key);
  if (!v || !(v.duration > 0)) return null;
  let local = sec - (Number(inst.start) || 0);
  const nat = mixer.naturalLength(inst);
  if (inst.loop && nat > 0.02) local = ((local % nat) + nat) % nat;
  return evaluateVoiceGainAtNormT(v, (local * contentRate(inst) - v.startTime) / v.duration);
}

/** The two ranges Interpolate would use now: the chosen ones, else the selected range and its nearest neighbour, else the first two that leave a gap. */
function interpPick() {
  const ranges = listRegions().filter((r) => r.kind === 'range').sort((x, y) => x.t0 - y.t0);
  const byId = (id) => ranges.find((r) => r.id === id) || null;
  let a = byId(ui.ip.a);
  let b = byId(ui.ip.b);
  if (!a && !b) {
    const sel = byId(ui.selRegion);
    const pairs = [];
    for (let i = 0; i < ranges.length; i++) for (let j = i + 1; j < ranges.length; j++) { const g = interpGap(ranges[i], ranges[j]); if (g) pairs.push(g); }
    // the selected range first, then the closest pair / 선택된 구간 우선, 그다음 가장 가까운 쌍
    pairs.sort((x, y) => (Number(y.A === sel || y.B === sel) - Number(x.A === sel || x.B === sel)) || x.gap - y.gap);
    if (pairs[0]) { a = pairs[0].srcA || pairs[0].A; b = pairs[0].srcB || pairs[0].B; } // overlap: the ranges themselves, not their side windows / 겹침: 원래 구간
  } else if (!a || !b) {
    const one = a || b;
    const other = ranges.filter((r) => interpGap(one, r)).sort((x, y) => interpGap(one, x).gap - interpGap(one, y).gap)[0] || null;
    if (a) b = other; else a = other;
  }
  return { ranges, a, b, gap: interpGap(a, b) };
}

/**
 * Interpolate card: pick a method and the two ranges, Interpolate. The text under the buttons says what
 * the method does. / 보간 카드: 방법과 두 구간을 고르고 보간. 버튼 아래 글 = 그 방법이 하는 일.
 */
function interpMarkup() {
  if (!INTERP_METHODS.includes(ui.ip.method)) ui.ip.method = INTERP_METHODS[0];
  const { ranges, a, b, gap } = interpPick();
  const log = listExtensions();
  const last = log[log.length - 1];
  const methods = INTERP_METHODS.map((id, k) => `<button class="mgr-btn ext ${ui.ip.method === id ? 'on' : ''}" data-act="ipMethod" data-method="${id}" ${k === 0 ? 'data-help="mgr.ipMethod"' : ''} title="${esc(t(`mgr.ipDef.${id}`))}">${k + 1} ${esc(t(`mgr.ip.${id}`))}</button>`).join('');
  const sel = (which, cur) => `<select data-ip-range="${which}" ${ranges.length ? '' : 'disabled'}>${ranges.map((r) => `<option value="${r.id}" ${cur?.id === r.id ? 'selected' : ''}>${esc(r.name)} · ${fmt(r.t0, 1)}–${fmt(r.t1, 1)}s</option>`).join('')}</select>`;
  const ok = !!gap && gap.gap >= INTERP_MIN_GAP;
  const status = ranges.length < 2 ? t('mgr.ipNeedRanges') : ok ? `${gap.overlap ? `${t('mgr.ipOverlap')} · ` : ''}${t('mgr.ipGap', fmt(gap.g0, 1), fmt(gap.g1, 1), fmt(gap.gap, 1))}` : t('mgr.ipNoGap');
  const modes = ['replace', 'add'].map((md) => `<button class="mgr-btn tiny ${ui.ip.mode === md ? 'on' : ''}" data-act="ipMode" data-mode="${md}" data-help="mgr.ipMode" title="${esc(t(`mgr.ipModeTip.${md}`))}">${esc(t(`mgr.ipMode.${md}`))}</button>`).join('');
  return `
    <section class="mgr-card mgr-extend" data-rack="mgr-interp" data-help="mgr.interp">
      <div class="mgr-card-head">
        <h3>⇝ ${esc(t('mgr.interp'))}</h3>
        ${methods}
        <span class="mgr-sep"></span>
        <span class="mgr-field" data-help="mgr.ipRange">${esc(t('mgr.ipFrom'))} ${sel('a', gap ? gap.srcA || gap.A : a)} ${esc(t('mgr.ipTo'))} ${sel('b', gap ? gap.srcB || gap.B : b)}</span>
        <span class="mgr-mono mgr-muted">${esc(status)}</span>
        <span class="mgr-field" data-help="mgr.ipMode">${modes}</span>
        <button class="mgr-btn play" data-act="ipApply" data-help="mgr.ipApply" ${ok ? '' : 'disabled'}>⇝ ${esc(t('mgr.ipApply'))}</button>
        <button class="mgr-btn" data-act="ipRemove" data-help="mgr.ipRemove" ${isInterpLog(last) ? '' : 'disabled'}>↶ ${esc(t('mgr.ipRemove'))}</button>
      </div>
      <div class="mgr-ext-body">
        <p><b>${esc(t('mgr.extHowLabel'))}</b> ${esc(t(`mgr.ipDef.${ui.ip.method}`))}</p>
      </div>
    </section>`;
}

function regionsMarkup() {
  const regions = listRegions();
  const instances = listInstances();
  const rows = regions.map((r, ri) => {
    const chips = instances.map((inst) => {
      const rule = regionRule(r, inst.id);
      return `<span class="mgr-chip ${rule || ''}" data-act="rule" data-region="${r.id}" data-id="${inst.id}" title="${esc(t('mgr.ruleTip'))}"><span class="mgr-dot" style="background:${esc(inst.color)}"></span>${esc(inst.name)}${rule ? ` · ${rule === 'solo' ? 'S' : 'M'}` : ''}</span>`;
    }).join('');
    const timeBits = r.kind === 'range'
      ? `<span class="mgr-field">t₀ <input type="number" step="0.1" min="0" value="${fmt(r.t0)}" data-region-field="t0" data-region="${r.id}"></span>
         <span class="mgr-field">t₁ <input type="number" step="0.1" min="0" value="${fmt(r.t1)}" data-region-field="t1" data-region="${r.id}"></span>`
      : `<span class="mgr-muted mgr-mono">${fmt(r.t0)}–${fmt(r.t1)}s · ${r.lobes.length}× (${r.lobes.map((b) => t(b.closed ? 'mgr.closedArea' : 'mgr.openArea')).join(', ')})</span>`;
    return `
      <div class="mgr-region ${r.id === ui.selRegion ? 'sel' : ''}" ${ri === 0 ? 'data-help="mgr.regionRow"' : ''} data-act="selRegion" data-region="${r.id}">
        <span class="mgr-kind">${esc(t(r.kind === 'shape' ? 'mgr.pitchMask' : 'mgr.timeMask'))}</span>
        <input type="text" value="${esc(r.name)}" data-region-field="name" data-region="${r.id}">
        ${timeBits}
        <span class="mgr-sep"></span>
        ${chips}
        <span style="flex:1"></span>
        <button class="mgr-btn tiny danger" data-act="delRegion" data-region="${r.id}" title="${esc(t('mgr.delete'))}">✕</button>
      </div>`;
  }).join('');
  return `
    <section class="mgr-card" data-rack="mgr-regions">
      <div class="mgr-card-head" data-help="mgr.regions"><h3>◧ ${esc(t('mgr.regions'))}</h3><span class="mgr-hint">${esc(t('mgr.ruleTip'))}</span></div>
      ${rows || `<div class="mgr-region mgr-muted">${esc(t('mgr.noRegions'))}</div>`}
    </section>`;
}

/**
 * Options row of a Warp track (shown when its Warp button is on). / 곡률 트랙의 옵션 행
 * Line sources get Rest / After; Draw brush a radius; Wave amount + smoothing; Cloud the sieve pull.
 */
function warpRowMarkup(inst, instances) {
  const w = inst.warp;
  const id = inst.id;
  const modes = WARP_MODES[inst.studio];
  const opt = (field, values, labelKey) => `<select data-warp-field="${field}" data-id="${id}">${values.map((v) => `<option value="${v}" ${w[field] === v ? 'selected' : ''}>${esc(t(`${labelKey}.${v}`))}</option>`).join('')}</select>`;
  const num = (field, label, attrs) => `<span class="mgr-field">${esc(label)} <input type="number" ${attrs} value="${fmt(w[field])}" data-warp-field="${field}" data-id="${id}" style="width:56px"></span>`;
  const lines = !['cloud', 'wave'].includes(inst.studio) && !(inst.studio === 'field' && w.mode === 'field');
  const parts = [`<span class="mgr-muted" style="flex-basis:100%">⌇ ${esc(t(w.on ? 'mgr.warpSilent' : 'mgr.warpOffHint'))}</span>`];
  if (modes) parts.push(`<span class="mgr-field">${esc(t('mgr.warpMode'))} ${opt('mode', modes, 'mgr.warpMode')}</span>`);
  // What the bend drives, each with its own sensitivity (−5…5, default 1) / 적용 매개변수와 민감도
  const drives = WARP_PARAMS.map((k) => {
    const q = w.params[k];
    const chip = `<span class="mgr-chip ${q.on ? 'warp' : ''}" data-act="warpParam" data-param="${k}" data-id="${id}" title="${esc(t(`mgr.warpParamTip.${k}`))}">${esc(t(`mgr.warpParam.${k}`))}</span>`;
    if (!q.on) return chip;
    const v = +q.sens.toFixed(2);
    return `<span class="mgr-warp-drive">${chip}<input type="range" min="${WARP_SENS_MIN}" max="${WARP_SENS_MAX}" step="0.05" value="${v}" data-default="1" data-warp-sens="${k}" data-id="${id}" title="${esc(t('mgr.warpSens'))}"><input type="number" min="${WARP_SENS_MIN}" max="${WARP_SENS_MAX}" step="0.05" value="${v}" data-warp-sens="${k}" data-id="${id}" title="${esc(t('mgr.warpSens'))}" style="width:56px"></span>`;
  }).join('');
  parts.push(`<span class="mgr-field">${esc(t('mgr.warpParams'))} ${drives}</span>`);
  if (w.params.time?.on) {
    // Time density: how (pitch kept / tape) and on which clock (track / per voice) / 시간 밀도: 방식과 시계
    parts.push(`<span class="mgr-field" title="${esc(t('mgr.warpTimeTip'))}">${esc(t('mgr.warpTimeMode'))} ${opt('timeMode', WARP_TIME_MODES, 'mgr.warpTimeMode')} ${esc(t('mgr.warpTimeClock'))} ${opt('timeClock', WARP_TIME_CLOCKS, 'mgr.warpTimeClock')}</span>`);
  }
  if (lines && inst.studio !== 'risset') parts.push(`<span class="mgr-field">${esc(t('mgr.warpRest'))} ${opt('rest', ['start', 'mean'], 'mgr.warpRest')}</span>`);
  if (lines) {
    parts.push(`<span class="mgr-field">${esc(t('mgr.warpAfter'))} ${opt('after', ['hold', 'return'], 'mgr.warpAfter')}</span>`);
    if (w.after === 'return') parts.push(num('returnSec', t('mgr.warpReturn'), 'step="0.1" min="0.05" max="30"'));
  }
  if (inst.studio === 'draw' && w.mode === 'brush') parts.push(num('radius', t('mgr.warpRadius'), 'step="0.5" min="0.5" max="48"'));
  if (inst.studio === 'wave') {
    if (w.mode !== 'energy') parts.push(num('amount', t('mgr.warpAmount'), 'step="0.5" min="0" max="48"'));
    parts.push(num('smooth', t('mgr.warpSmooth'), 'step="0.05" min="0" max="5"'));
  }
  if (inst.studio === 'cloud') parts.push(num('sieve', t('mgr.warpSieve'), 'step="0.05" min="0" max="1"'));
  const others = instances.filter((o) => o.id !== id && !o.warp?.on);
  const all = !w.targets.length;
  const chips = others.map((o) => `<span class="mgr-chip ${all || w.targets.includes(o.id) ? 'warp' : ''}" data-act="warpTarget" data-id="${id}" data-target="${o.id}"><span class="mgr-dot" style="background:${esc(o.color)}"></span>${esc(o.name)}</span>`).join('');
  parts.push(`<span class="mgr-field">${esc(t('mgr.warpTargets'))} <span class="mgr-chip ${all ? 'warp' : ''}" data-act="warpAll" data-id="${id}">${esc(t('mgr.warpAll'))}</span>${chips}</span>`);
  return `<div class="mgr-warp-row">${parts.join('')}</div>`;
}

/**
 * Track selection (readability only — sound, M / S and the document are untouched). Click selects one
 * track (click it again to clear), Shift+click adds / removes. Selected tracks are highlighted in the
 * strips, the timeline and the Master View; the others are dimmed.
 * 트랙 선택 (가독성 전용 — 소리·M/S·문서는 그대로). 클릭 = 하나 선택(다시 클릭하면 해제), Shift+클릭 = 추가·제거.
 */
function selectTrack(id, additive = false) {
  if (!id) return;
  if (additive) { if (ui.sel.has(id)) ui.sel.delete(id); else ui.sel.add(id); } else if (ui.sel.size === 1 && ui.sel.has(id)) ui.sel.clear();
  else ui.sel = new Set([id]);
  renderPanel();
}

/** Selection classes of a track: 'sel' / 'unsel' / '' (nothing selected). / 선택 클래스 */
function selClass(id) {
  const ids = new Set(listInstances().map((i) => i.id));
  for (const x of [...ui.sel]) if (!ids.has(x)) ui.sel.delete(x); // deleted tracks drop out / 삭제된 트랙 제외
  return !ui.sel.size ? '' : ui.sel.has(id) ? 'sel' : 'unsel';
}

/**
 * Warp button with its options attached: the button (on / off, the active drives shown on it) and
 * a ▾ that opens the options panel right under it. Turning Warp on opens the panel.
 * 곡률 버튼 + 옵션: 버튼(켜기·끄기, 켜진 적용 항목 표시)과 그 아래 옵션 패널을 여는 ▾.
 */
function warpButtonMarkup(inst, instances, h) {
  const w = inst.warp;
  const open = ui.warpOpen === inst.id;
  const tags = w?.on ? WARP_PARAMS.filter((k) => w.params[k]?.on).map((k) => `<span class="mgr-warp-tag">${esc(t(`mgr.warpParam.${k}`))}${w.params[k].sens !== 1 ? ` ${+w.params[k].sens.toFixed(2)}` : ''}</span>`).join('') : '';
  return `<span class="mgr-warp-anchor">
    <button class="mgr-btn tiny warp ${w?.on ? 'on' : ''}" data-act="warp"${h('warp')} data-id="${inst.id}" title="${esc(t('mgrHelp.warp.t'))}">⌇ ${esc(t('mgr.warp'))}${tags}</button><button class="mgr-btn tiny warp-caret ${open ? 'on' : ''}" data-act="warpMenu" data-id="${inst.id}" title="${esc(t('mgr.warpOptions'))}">${open ? '▴' : '▾'}</button>
    ${open ? `<div class="mgr-warp-pop">${warpRowMarkup(inst, instances)}</div>` : ''}
  </span>`;
}

function channelsMarkup() {
  const instances = listInstances();
  const strips = instances.map((inst, idx) => {
    const focused = isFocused(inst);
    const launched = mixer.isLaunched(inst.id);
    const nat = mixer.naturalLength(inst);
    const lenVal = inst.length === null || inst.length === undefined ? '' : fmt(inst.length);
    const h = (k) => (idx === 0 ? ` data-help="mgr.${k}"` : '');
    const lenPh = inst.studio === 'risset' && !inst.take?.on ? '8' : `${t('mgr.auto')} ${fmt(nat, 1)}`;
    return `
      <div class="mgr-strip ${focused ? 'focused' : ''} ${inst.warp?.on ? 'warp' : ''} ${selClass(inst.id)}" data-strip="${inst.id}" style="--sel:${esc(inst.color)}">
        <button class="mgr-chk ${ui.sel.has(inst.id) ? 'on' : ''}"${h('check')} data-act="chkTrack" data-id="${inst.id}" role="checkbox" aria-checked="${ui.sel.has(inst.id) ? 'true' : 'false'}" title="${esc(t('mgr.chkTip'))}">${ui.sel.has(inst.id) ? '✓' : ''}</button>
        <input type="color"${h('color')} value="${esc(inst.color)}" data-field="color" data-id="${inst.id}">
        <input type="text"${h('name')} value="${esc(inst.name)}" data-field="name" data-id="${inst.id}">
        <span class="mgr-studio ${inst.studio}"${h('studio')} data-act="selTrack" data-id="${inst.id}" title="${esc(t('mgr.selTip'))}" style="cursor:pointer">${esc(studioShortName(inst.studio))}</span>
        <button class="mgr-btn ${focused ? 'on' : ''}" data-act="edit"${h('edit')} data-id="${inst.id}">✎ ${esc(t(focused ? 'mgr.editing' : 'mgr.edit'))}</button>
        <button class="mgr-btn launch ${launched ? 'on' : ''}" data-act="launch"${h('launch')} data-id="${inst.id}" title="${esc(t('mgr.launch'))}">${launched ? '■' : '▶'} ${esc(t('mgr.launch'))}</button>
        <button class="mgr-btn tiny mute ${inst.mute ? 'on' : ''}" data-act="mute"${h('mute')} data-id="${inst.id}">M</button>
        <button class="mgr-btn tiny solo ${inst.solo ? 'on' : ''}" data-act="solo"${h('solo')} data-id="${inst.id}">S</button>
        ${warpButtonMarkup(inst, instances, h)}
        ${inst.take?.on ? `<button class="mgr-btn tiny take ${inst.take.rev || inst.take.mirror ? 'on' : ''}" data-act="takeRev" data-help="mgr.take" data-id="${inst.id}" title="${esc(t('mgr.takeTip', fmt(inst.take.at, 1), fmt(inst.take.at + inst.take.len, 1)))}">${inst.take.mirror ? '◁' : inst.take.rev ? '◀' : '▶'} ${esc(t(inst.take.mirror ? 'mgr.takeMirror' : inst.take.rev ? 'mgr.takeRev' : 'mgr.takeFwd'))}</button>` : ''}
        <span class="mgr-field"${h('gain')}>${esc(t('mgr.gain'))} <input type="range" min="-60" max="12" step="0.5" value="${inst.gainDb}" data-default="0" data-field="gainDb" data-id="${inst.id}">${gainBox(inst)}</span>
        <span class="mgr-meter"${h('meter')}><i data-meter="${inst.id}"></i></span>
        <button class="mgr-btn tiny mgr-more-btn ${ui.open.has(inst.id) ? 'on' : ''}" data-act="stripMore"${h('more')} data-id="${inst.id}" title="${esc(t('mgr.moreTip'))}">${ui.open.has(inst.id) ? '▾' : '▸'} ${esc(t('mgr.more'))}</button>
        <span class="mgr-strip-more ${ui.open.has(inst.id) ? 'open' : ''}">
        <span class="mgr-sep"></span>
        ${tempoControl(inst.id, inst.tempo, 'tempo', t('mgr.tempo'))}<span class="mgr-mono mgr-muted" data-tempo-eff="${inst.id}">${esc(t('mgr.tempoEff', +contentRate(inst).toFixed(3)))}</span>
        <button class="mgr-btn tiny ${inst.inCycle ? 'on' : ''}" data-act="inCycle"${h('inCycle')} data-id="${inst.id}">⟲ ${esc(t('mgr.inCycle'))}</button>
        <span class="mgr-field"${h('start')}>${esc(t('mgr.start'))} <input type="number" step="0.1" min="0" value="${fmt(inst.start)}" data-field="start" data-id="${inst.id}"></span>
        <span class="mgr-field"${h('length')}>${esc(t('mgr.length'))} <input type="number" step="0.1" min="0.1" value="${lenVal}" placeholder="${esc(lenPh)}" data-field="length" data-id="${inst.id}" style="width:72px"></span>
        <button class="mgr-btn tiny ${inst.loop ? 'on' : ''}" data-act="loop"${h('loop')} data-id="${inst.id}" ${inst.studio === 'risset' && !inst.take?.on ? 'disabled' : ''}>↻ ${esc(t('mgr.loop'))}</button>
        <span class="mgr-field"${h('fadeIn')}>${esc(t('mgr.fadeIn'))} <input type="number" step="0.01" min="0" value="${fmt(inst.fadeIn)}" data-field="fadeIn" data-id="${inst.id}"></span>
        <span class="mgr-field"${h('fadeOut')}>${esc(t('mgr.fadeOut'))} <input type="number" step="0.01" min="0" value="${fmt(inst.fadeOut)}" data-field="fadeOut" data-id="${inst.id}"></span>
        <button class="mgr-btn tiny ${inst.tremolo?.on ? 'on' : ''}" data-act="trem"${h('trem')} data-id="${inst.id}">〰 ${esc(t('mgr.trem'))}</button>
        <span class="mgr-field"${h('tremRate')}>${esc(t('mgr.tremRate'))} <input type="number" step="0.1" min="0.05" max="40" value="${fmt(inst.tremolo?.rate ?? 5)}" data-field="tremRate" data-id="${inst.id}" style="width:56px"></span>
        <span class="mgr-field"${h('tremDepth')}>${esc(t('mgr.tremDepth'))} <input type="number" step="0.05" min="0" max="1" value="${fmt(inst.tremolo?.depth ?? 0.5)}" data-field="tremDepth" data-id="${inst.id}" style="width:56px"></span>
        </span>
        <span style="flex:1"></span>
        <button class="mgr-btn tiny" data-act="up"${h('order')} data-id="${inst.id}" ${idx === 0 ? 'disabled' : ''} title="${esc(t('mgr.moveUp'))}">↑</button>
        <button class="mgr-btn tiny" data-act="down" data-id="${inst.id}" ${idx === instances.length - 1 ? 'disabled' : ''} title="${esc(t('mgr.moveDown'))}">↓</button>
        <button class="mgr-btn tiny" data-act="dup"${h('dup')} data-id="${inst.id}" title="${esc(t('mgr.duplicate'))}">⧉</button>
        <button class="mgr-btn tiny danger" data-act="del"${h('del')} data-id="${inst.id}" title="${esc(t('mgr.delete'))}">✕</button>
      </div>`;
  }).join('');
  const all = instances.length && ui.sel.size === instances.length;
  const selAll = `<button class="mgr-chk ${all ? 'on' : ui.sel.size ? 'part' : ''}" data-act="chkAll" data-help="mgr.check" role="checkbox" aria-checked="${all ? 'true' : ui.sel.size ? 'mixed' : 'false'}" title="${esc(t('mgr.chkAll'))}">${all ? '✓' : ui.sel.size ? '–' : ''}</button>`;
  const selInfo = ui.sel.size
    ? `<span class="mgr-chip warp">${esc(t('mgr.selCount', ui.sel.size))}</span><button class="mgr-btn tiny" data-act="selClear">${esc(t('mgr.selClear'))}</button><span class="mgr-hint">${esc(t('mgr.selUsedBy'))}</span>`
    : `<span class="mgr-hint">${esc(t('mgr.selHint'))}</span>`;
  const allOpen = instances.length && instances.every((i) => ui.open.has(i.id));
  const moreAll = `<button class="mgr-btn tiny" data-act="stripMoreAll" data-help="mgr.more" title="${esc(t('mgr.moreTip'))}">${allOpen ? '▾' : '▸'} ${esc(t(allOpen ? 'mgr.moreAllClose' : 'mgr.moreAllOpen'))}</button>`;
  // ＋ Add studio lives with the tracks it adds / 스튜디오 추가는 트랙 목록에
  return `<section class="mgr-card" data-rack="mgr-channels"><div class="mgr-card-head">${selAll}<h3>☰ ${esc(t('mgr.channels'))}</h3>${addStudioMarkup()}${moreAll}${selInfo}</div>${strips}</section>`;
}

/** Selected tracks (checkboxes) that still exist, in track order — shared by every tool that acts on "the selection". */
export function selectedTrackIds() {
  return listInstances().filter((i) => ui.sel.has(i.id)).map((i) => i.id);
}

// Track fader unit: dB, or sone = loudness ratio to 0 dB (Stevens: ×2 per +10 dB) / 트랙 페이더 단위
const dbToSoneRatio = (db) => 2 ** (db / 10);
const soneRatioToDb = (s) => 10 * Math.log2(Math.max(1e-6, s));

/** Number box next to a track fader, in the chosen unit. / 선택 단위의 숫자 상자 */
function gainBox(inst) {
  const sone = ui.gainUnit === 'sone';
  const v = sone ? +dbToSoneRatio(inst.gainDb).toFixed(3) : +Number(inst.gainDb).toFixed(1);
  return `<input type="number" class="mgr-mono" ${sone ? 'min="0.016" max="2.3" step="0.01"' : 'min="-60" max="12" step="0.5"'} value="${v}" data-gain-box="${inst.id}" data-id="${inst.id}" style="width:58px"><span class="mgr-muted" data-gain-readout="${inst.id}">${sone ? `sone× · ${fmt(inst.gainDb, 1)} dB` : 'dB'}</span>`;
}

// ==========================================================================
// Events / 이벤트
// ==========================================================================

async function onClick(e) {
  // A click outside the open Warp options closes them / 바깥 클릭 시 곡률 옵션 닫기
  if (ui.warpOpen && !e.target.closest('.mgr-warp-anchor')) { ui.warpOpen = null; renderPanel(); }
  if (ui.addOpen && !e.target.closest('.mgr-add-anchor')) { ui.addOpen = false; renderPanel(); }
  const el = e.target.closest('[data-act]');
  if (!el) {
    // Click on the empty part of a track strip selects it / 트랙 스트립 빈 곳 클릭 = 선택
    const strip = e.target.closest('.mgr-strip');
    if (strip && panel.contains(strip) && !e.target.closest('input,select,textarea,button,label,.mgr-warp-anchor')) selectTrack(strip.dataset.strip, e.shiftKey);
    return;
  }
  if (!panel.contains(el)) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  const inst = id ? getInstance(id) : null;
  try {
    switch (act) {
      case 'close': toggleManagerPanel(false); break;
      case 'help': toggleHelpOverlay(); break;
      case 'cycle': await toggleManagerCycle(); break;
      case 'cycleLoop': setManagerPref({ cycleLoop: !appState.manager.cycleLoop }); break;
      case 'stopAll': mixer.stopAllManager(); break;
      case 'smPower': syncSpaceMaster(); editSpaceMaster((d) => { d.on = !d.on; }); refreshSpaceMaster(); break;
      case 'smEdit': syncSpaceMaster(); setSpaceDocTarget('master'); toggleManagerPanel(false); document.querySelector('#studioTabs [data-studio="space"]')?.click(); hooks.requestRender(['all']); break;
      case 'serial': arrangeCycle('serial', mixer.ownClipLength); break;
      case 'parallel': arrangeCycle('parallel', mixer.ownClipLength); break;
      case 'lenMode': {
        const fixed = el.dataset.mode === 'fixed';
        const m = appState.manager;
        // First switch to Set starts from the current total length / 처음 지정으로 바꾸면 현재 전체 길이에서 시작
        const patch = { cycleMode: fixed ? 'fixed' : 'auto' };
        if (fixed && !(Number(m.cycleLen) >= 0.1)) patch.cycleLen = mixer.totalLength();
        setManagerPref(patch);
        break;
      }
      case 'lenUseTotal': setManagerPref({ cycleLen: mixer.totalLength() }); break;
      case 'addMenu': ui.addOpen = !ui.addOpen; renderPanel(); break;
      case 'add': { ui.addOpen = false; const n = addInstance(el.dataset.studio); if (n) hooks.showToast(t('mgr.added', n.name)); break; }
      case 'size': setSizeMode(el.dataset.size); break;
      case 'gainUnit': ui.gainUnit = el.dataset.unit === 'sone' ? 'sone' : 'db'; renderPanel(); break;
      case 'chkTrack': selectTrack(id, true); break;
      case 'chkAll': {
        const all = listInstances().map((i) => i.id);
        ui.sel = ui.sel.size === all.length ? new Set() : new Set(all);
        renderPanel();
        break;
      }
      case 'export': {
        hooks.showToast(t('mgr.exporting'));
        const res = await mixer.exportCycleWav();
        hooks.showToast(res.message, res.ok ? 'info' : 'error');
        break;
      }
      case 'exportVideo': openMasterVideoDialog({ hooks }); break;
      case 'exportTracks': openTrackExportDialog({ hooks, scope: 'manager' }); break;
      case 'toStart': await mixer.seekCycle(0); break;
      case 'edit': if (inst) editInstance(inst); break;
      case 'launch': if (inst) { const was = mixer.isLaunched(id); const ok = await mixer.toggleLaunch(id); if (!was && !ok) hooks.showToast(t('toast.noAudio'), 'error'); } break;
      case 'mute': case 'solo': case 'loop': case 'inCycle': if (inst) setInstance(id, { [act]: !inst[act] }); break;
      case 'trem': if (inst) setInstance(id, { tremolo: { on: !inst.tremolo?.on } }); break;
      case 'warp': if (inst) { const on = !inst.warp?.on; if (on) ui.warpOpen = id; setInstanceWarp(id, { on }); } break;
      case 'warpMenu': ui.warpOpen = ui.warpOpen === id ? null : id; renderPanel(); break;
      case 'selTrack': selectTrack(id, e.shiftKey); break;
      case 'selClear': ui.sel.clear(); renderPanel(); break;
      case 'warpGrid': ui.warpGrid = !ui.warpGrid; renderPanel(); break;
      case 'warpParam': if (inst) { const k = el.dataset.param; setInstanceWarp(id, { params: { [k]: { on: !inst.warp.params[k]?.on } } }); } break;
      case 'warpAll': if (inst) setInstanceWarp(id, { targets: [] }); break;
      case 'warpTarget': if (inst) {
        // [] = all tracks; the first click picks one, later clicks toggle / [] = 전체, 첫 클릭은 하나만 선택
        const tid = el.dataset.target;
        const cur = inst.warp.targets;
        const next = !cur.length ? [tid] : cur.includes(tid) ? cur.filter((x) => x !== tid) : [...cur, tid];
        setInstanceWarp(id, { targets: next });
        break;
      }
      case 'extMethod': ui.ext.method = el.dataset.method; renderPanel(); break;
      case 'extMult': ui.ext.mult = Number(el.dataset.mult) || 1; ui.ext.sec = null; renderPanel(); break;
      case 'extApply': {
        const C = mixer.cycleLength();
        mixer.stopCycle(); // the arrangement is about to change / 배치가 바뀌므로 사이클 정지
        const measure = { cycleLength: C, clipLength: (i) => mixer.clipLength(i), only: selectedTrackIds() };
        if (EXTEND_NEEDS_LEVELS.includes(ui.ext.method)) {
          // some methods need to know how loud every clip sounds / 일부 방법은 각 클립이 얼마나 크게 들리는지 필요
          hooks.showToast(t('mgr.extMeasuring'));
          const levels = await mixer.measureClipLevels();
          measure.level = (i) => levels.get(i.id) || null;
        }
        const res = extendCycle(ui.ext.method, extendSeconds(C), measure);
        if (res.ok) hooks.showToast(t('mgr.extDone', `${t(`mgr.ext.${ui.ext.method}`)}${res.note ? ` ${res.note}` : ''}`, fmt(res.from, 1), fmt(res.to, 1), res.added));
        else hooks.showToast(t(res.error === 'max' ? 'mgr.extErrMax' : 'mgr.extErrEmpty'), 'error');
        break;
      }
      case 'ipMethod': ui.ip.method = el.dataset.method; renderPanel(); break;
      case 'stripMore': { const id = el.dataset.id; if (ui.open.has(id)) ui.open.delete(id); else ui.open.add(id); renderPanel(); break; }
      case 'stripMoreAll': { const ids = listInstances().map((i) => i.id); const all = ids.length && ids.every((id) => ui.open.has(id)); ui.open = new Set(all ? [] : ids); renderPanel(); break; }
      case 'mgrLayout': mgrLayout.mode = mgrLayout.mode === 'portrait' ? 'landscape' : 'portrait'; saveMgrLayout(); renderPanel(); globalThis.dispatchEvent(new Event('resize')); break;
      case 'ipMode': ui.ip.mode = el.dataset.mode === 'add' ? 'add' : 'replace'; renderPanel(); break;
      case 'ipApply': {
        const { gap } = interpPick();
        if (!gap) { hooks.showToast(t('mgr.ipErrGap'), 'error'); break; }
        mixer.stopCycle(); // the arrangement is about to change / 배치가 바뀌므로 사이클 정지
        const measure = { clipLength: (i) => mixer.clipLength(i), only: selectedTrackIds() };
        // heard pitch lines in cycle time, as the Master View draws them / 마스터 뷰가 그리는 "들리는" 음고 선
        if (INTERP_NEEDS_LINES.includes(ui.ip.method)) {
          measure.lines = geometry().lines.filter((l) => !l.warpSrc).map((l) => ({ instId: l.inst.id, key: l.key, name: l.name, pts: l.pts }));
          measure.voiceGain = lineEnvelopeAt;
        }
        const res = interpolateRanges(ui.ip.method, gap.A, gap.B, measure, { mode: ui.ip.mode });
        if (res.ok) hooks.showToast(t('mgr.ipDone', t(`mgr.ip.${ui.ip.method}`), fmt(res.from, 1), fmt(res.to, 1), res.added));
        else hooks.showToast(t(res.error === 'gap' ? 'mgr.ipErrGap' : res.error === 'lines' ? 'mgr.ipErrLines' : 'mgr.ipErrEmpty'), 'error');
        break;
      }
      case 'ipRemove': if (isInterpLog(listExtensions().at(-1))) { mixer.stopCycle(); if (removeLastExtension()) hooks.showToast(t('mgr.ipRemoved')); } break;
      case 'extRemove': mixer.stopCycle(); if (removeLastExtension()) hooks.showToast(t('mgr.extRemoved')); break;
      // cycle: forward → tape retro → settings retro → forward / 순행 → 테이프 역행 → 설정 역행 → 순행
      case 'takeRev': if (inst?.take?.on) setInstanceTake(id, inst.take.mirror ? { rev: false, mirror: false } : inst.take.rev ? { rev: false, mirror: true } : { rev: true, mirror: false }); break;
      case 'up': moveInstance(id, -1); break;
      case 'down': moveInstance(id, 1); break;
      case 'dup': if (inst) { const n = addInstance(inst.studio, { from: id }); if (n) hooks.showToast(t('mgr.added', n.name)); } break;
      case 'del': if (inst && !removeInstance(id)) hooks.showToast(t('mgr.cannotRemoveLast', studioShortName(inst.studio)), 'error'); break;
      case 'tempoMode': patchTempoOf(el.dataset.tempo, { mode: el.dataset.tempoMode }); break;
      case 'tempoReset': patchTempoOf(el.dataset.tempo, { mode: 'rate', rate: 1 }); break;
      case 'rangeTool': ui.tool = ui.tool === 'range' ? null : 'range'; renderPanel(); break;
      case 'rule': e.stopPropagation(); setRegionRule(el.dataset.region, id); ui.selRegion = el.dataset.region; break;
      case 'selRegion': if (e.target.closest('input,button,[data-act="rule"]') === null) { ui.selRegion = el.dataset.region; renderPanel(); } break;
      case 'delRegion': removeRegion(el.dataset.region); break;
      case 'shapeTool': ui.shape = ui.shape ? null : { a: null, b: null, lobes: [], picked: new Set() }; renderPanel(); break;
      case 'shapeCancel': ui.shape = null; renderPanel(); break;
      case 'shapeConfirm': {
        const s = ui.shape;
        if (!s?.picked.size) break;
        const r = addShapeRegion([...s.picked].sort((x, y) => x - y).map((k) => s.lobes[k]));
        ui.shape = null;
        if (r) ui.selRegion = r.id;
        renderPanel();
        break;
      }
      default: break;
    }
  } catch (err) {
    console.error(err);
    hooks.showToast(String(err.message || err), 'error');
  }
  hooks.requestRender(['manager']);
}

function onInput(e) {
  const el = e.target;
  if (el.dataset.field === 'gainDb') {
    const db = Number(el.value);
    const box = panel.querySelector(`[data-gain-box="${el.dataset.id}"]`);
    if (box) box.value = ui.gainUnit === 'sone' ? String(+dbToSoneRatio(db).toFixed(3)) : String(+db.toFixed(1));
    const ro = panel.querySelector(`[data-gain-readout="${el.dataset.id}"]`);
    if (ro && ui.gainUnit === 'sone') ro.textContent = `sone× · ${db.toFixed(1)} dB`;
    setInstance(el.dataset.id, { gainDb: db });
  } else if (el.dataset.field === 'color') {
    setInstance(el.dataset.id, { color: el.value });
  } else if (el.dataset.warpSens) {
    // keep the slider and the number box together while dragging / 드래그 중 슬라이더·숫자 동기화
    for (const o of panel.querySelectorAll(`[data-warp-sens="${el.dataset.warpSens}"][data-id="${el.dataset.id}"]`)) if (o !== el) o.value = el.value;
  }
}

/** Apply a tempo patch to the master ('master') or to one instance. / 마스터·인스턴스 템포 변경 */
function patchTempoOf(who, patch) {
  if (who === 'master') setManagerTempo(patch);
  else setInstance(who, { tempo: patch });
}

function onChange(e) {
  const el = e.target;
  if (el.matches('[data-add-studio]')) {
    const studio = el.value;
    el.value = '';
    el.blur(); // the panel defers re-rendering while a control inside it has focus / 포커스가 남아 있으면 패널 재렌더가 미뤄짐
    if (!studio) return;
    try {
      const n = addInstance(studio);
      if (n) hooks.showToast(t('mgr.added', n.name));
    } catch (err) { hooks.showToast(String(err.message || err), 'error'); }
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.gainBox) {
    const v = Number(el.value);
    if (Number.isFinite(v)) {
      const db = clamp(ui.gainUnit === 'sone' ? soneRatioToDb(v) : v, -60, 12);
      setInstance(el.dataset.gainBox, { gainDb: Math.round(db * 10) / 10 });
    }
    el.blur();
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.ipRange) {
    // choosing one side keeps the other only while the two still leave a gap / 한쪽을 고르면 다른 쪽은 간격이 남을 때만 유지
    const cur = interpPick();
    ui.ip.a = el.dataset.ipRange === 'a' ? el.value : cur.a?.id ?? null;
    ui.ip.b = el.dataset.ipRange === 'b' ? el.value : cur.b?.id ?? null;
    el.blur();
    hooks.requestRender(['manager']);
    return;
  }
  if (el.matches('[data-ext-sec]')) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) { ui.ext.sec = v; el.blur(); }
    hooks.requestRender(['manager']);
    return;
  }
  if (el.matches('[data-cycle-len]')) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) setManagerPref({ cycleLen: v });
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.tempoField) {
    const v = Number(el.value);
    if (Number.isFinite(v) && v > 0) patchTempoOf(el.dataset.tempo, { [el.dataset.tempoField]: v });
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.warpSens) {
    const v = Number(el.value);
    if (Number.isFinite(v)) setInstanceWarp(el.dataset.id, { params: { [el.dataset.warpSens]: { sens: v } } }, { coalesce: `sens:${el.dataset.warpSens}` });
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.warpField) {
    const k = el.dataset.warpField;
    const v = ['mode', 'rest', 'after', 'timeMode', 'timeClock'].includes(k) ? el.value : Number(el.value);
    if (typeof v === 'string' || Number.isFinite(v)) setInstanceWarp(el.dataset.id, { [k]: v }, { coalesce: k });
    hooks.requestRender(['manager']);
    return;
  }
  if (el.dataset.regionField) {
    setRegion(el.dataset.region, { [el.dataset.regionField]: el.dataset.regionField === 'name' ? el.value : Number(el.value) });
    return;
  }
  const f = el.dataset.field;
  if (!f || f === 'gainDb' || f === 'color') return;
  const id = el.dataset.id;
  if (f === 'name') setInstance(id, { name: el.value });
  else if (f === 'tremRate') { const v = Number(el.value); if (Number.isFinite(v)) setInstance(id, { tremolo: { rate: v, rateEnd: v } }); }
  else if (f === 'tremDepth') { const v = Number(el.value); if (Number.isFinite(v)) setInstance(id, { tremolo: { depth: v } }); }
  else if (f === 'length') setInstance(id, { length: el.value === '' ? (getInstance(id)?.studio === 'risset' && mixer.fixedCycleLength() === null ? mixer.DEFAULT_RISSET_CLIP : null) : Number(el.value) });
  else setInstance(id, { [f]: Number(el.value) });
}

/** Show an instance in its editor (swap documents, switch tab). / 인스턴스를 에디터로 */
function editInstance(inst) {
  stopAllAudio(); // editor preview only; the Manager keeps playing / 에디터 미리듣기만 정지
  const sameTab = StudioRegistry.resolveStudioId() === inst.studio;
  const changed = focusInstance(inst.id);
  if (inst.studio === 'risset') resetRissetRuntime();
  StudioRegistry.activate(inst.studio);
  if (changed && sameTab) remountWorkspace();
  if (inst.studio === 'glissando') hooks.fitAll();
  setManagerPref({ open: false });
  hooks.showToast(t('mgr.focused', inst.name));
}

// --------------------------------------------------------------------------
// Timeline drag: move / resize clips, draw ranges / 타임라인 드래그
// --------------------------------------------------------------------------

function trackSec(track, clientX) {
  const r = track.getBoundingClientRect();
  return clamp(((clientX - r.left) / Math.max(1, r.width)) * ui.viewLen, 0, ui.viewLen);
}

const snap = (sec, fine) => (fine ? Math.round(sec * 100) / 100 : Math.round(sec * 10) / 10);

function onPointerDown(e) {
  if (e.button !== 0) return;
  const bar = e.target.closest('[data-mgr-split]');
  if (bar) { onSplitDown(e, bar); return; }
  const canvas = e.target.closest('#mgrMaster');
  if (canvas) { onMasterDown(e, canvas); return; }
  const track = e.target.closest('.mgr-tl-track');
  if (!track || e.target.closest('[data-act]')) return;
  const endEl = e.target.closest('[data-cycle-end]');
  if (endEl) {
    e.preventDefault();
    const len0 = mixer.cycleLength();
    ui.drag = { kind: 'cycleEnd', el: endEl, track, x0: e.clientX, len0, len: len0 };
    startDrag();
    return;
  }
  if (track.closest('.mgr-tl-ruler') && ui.tool !== 'range') {
    // Ruler: click / drag = move the playhead (not while Select range is on) / 눈금자: 플레이헤드 이동 (구간 선택 중 제외)
    startScrub(e, (ev) => trackSec(track, ev.clientX), trackSec(track, e.clientX));
    return;
  }
  if (ui.tool === 'range') {
    e.preventDefault();
    const tl = panel.querySelector('#mgrTimeline');
    const draft = document.createElement('div');
    draft.className = 'mgr-draft';
    const area = tl.querySelector('.mgr-playhead').parentElement;
    area.appendChild(draft);
    const t0 = snap(trackSec(track, e.clientX), e.shiftKey);
    ui.drag = { kind: 'range', track, t0, t1: t0, draft };
    paintDraft();
    startDrag();
    return;
  }
  const clipEl = e.target.closest('[data-clip]');
  if (!clipEl) return;
  e.preventDefault();
  const id = clipEl.dataset.clip;
  const inst = getInstance(id);
  ui.drag = {
    kind: e.target.closest('[data-resize]') ? 'resize' : 'move',
    id,
    el: clipEl,
    track,
    x0: e.clientX,
    start0: Number(inst.start) || 0,
    len0: mixer.clipLength(inst),
    start: Number(inst.start) || 0,
    len: mixer.clipLength(inst),
    shift: e.shiftKey,
  };
  clipEl.style.cursor = 'grabbing';
  startDrag();
}

function paintDraft() {
  const d = ui.drag;
  const a = Math.min(d.t0, d.t1);
  const b = Math.max(d.t0, d.t1);
  if (d.paint) { d.paint(a, b); return; }
  d.draft.style.left = pct(a);
  d.draft.style.width = `calc(${pct(b)} - ${pct(a)})`;
}

function startDrag() {
  const move = (ev) => {
    const d = ui.drag;
    if (!d) return;
    if (d.kind === 'range') {
      d.t1 = snap(d.secAt ? d.secAt(ev) : trackSec(d.track, ev.clientX), ev.shiftKey);
      paintDraft();
      return;
    }
    const r = d.track.getBoundingClientRect();
    const dt = ((ev.clientX - d.x0) / Math.max(1, r.width)) * ui.viewLen;
    if (d.kind === 'cycleEnd') {
      d.len = Math.max(0.1, snap(d.len0 + dt, ev.shiftKey));
      d.el.style.left = pct(d.len);
      d.el.textContent = `⟲ ${fmt(d.len)}s`;
      return;
    }
    if (d.kind === 'move') {
      d.start = Math.max(0, snap(d.start0 + dt, ev.shiftKey));
      d.el.style.left = pct(d.start);
    } else {
      d.len = Math.max(0.1, snap(d.len0 + dt, ev.shiftKey));
      d.el.style.width = `calc(${pct(d.start + d.len)} - ${pct(d.start)})`;
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const d = ui.drag;
    ui.drag = null;
    if (!d) return;
    if (d.kind === 'range') {
      d.draft.remove();
      const r = addRegion(d.t0, d.t1);
      if (r) ui.selRegion = r.id;
      renderPanel();
      return;
    }
    if (d.kind === 'cycleEnd') {
      if (Math.abs(d.len - d.len0) > 1e-6) setManagerPref({ cycleLen: d.len });
      else renderPanel();
      return;
    }
    const inst = getInstance(d.id);
    if (!inst) return;
    if (d.kind === 'move' && Math.abs(d.start - d.start0) > 1e-6) setInstance(d.id, { start: d.start });
    else if (d.kind === 'resize' && Math.abs(d.len - d.len0) > 1e-6) {
      const patch = { length: d.len };
      // Longer than one pass → loop it (Glissando / Field) / 자연 길이보다 길면 반복 켜기
      if (inst.studio !== 'risset' && d.len > mixer.naturalLength(inst) + 0.05) patch.loop = true;
      setInstance(d.id, patch);
    } else if (d.kind === 'move') selectTrack(d.id, d.shift); // a click on a clip selects its track / 클립 클릭 = 트랙 선택
    else renderPanel();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ==========================================================================
// Master View geometry / 마스터 뷰 기하
// ==========================================================================

function resolveDocParams(inst) {
  const doc = getInstanceDoc(inst);
  if (inst.studio === 'risset') return resolveRissetDoc(doc);
  const plugin = StudioRegistry.get(inst.studio);
  return { ...(plugin ? plugin.defaultParams() : {}), ...(doc && typeof doc === 'object' ? doc : {}) };
}

/**
 * Pitch geometry of one clip in clip-local time [0, L]: lines [{ key, name, rep, pts: [{ t, m }] }]
 * (repeated when the clip loops), or a Risset band { lo, hi }, or block (a studio without pitch
 * curves here). A take (core/take-config.js) is drawn from the forward clip it was taken from,
 * mirrored in time when it is a retrograde. `inst` may be a take context (mixer.takeContext).
 * 클립 하나의 음고 기하 (클립 기준 시간 [0, L]). 테이크는 원래 클립에서 그리고, 역행이면 시간을 뒤집음.
 */
function clipGeometry(inst, L, depth = 0) {
  const out = { lines: [], band: null, block: false, nat: 0, warpSrc: !!inst.warp?.on };
  if (inst.take?.on && depth < 8) {
    const tk = inst.take;
    const sub = clipGeometry(mixer.takeContext(inst), tk.len, depth + 1);
    // the take's own tape ratio: time ÷ rate, pitch + 12·log2(rate) / 테이크 테이프 배율: 시간 ÷ rate, 음고 이동
    const rate = Number(tk.rate) > 0 ? Number(tk.rate) : 1;
    const semis = tapeSemitones(rate);
    const off = takeOffset(tk); // the take begins `off` seconds into what is played / 재생분의 off초 지점에서 시작
    const nat = (tk.len - off) / rate;
    out.band = sub.band ? { lo: sub.band.lo + semis, hi: sub.band.hi + semis } : null;
    out.block = sub.block;
    out.nat = nat;
    const reps = inst.loop ? Math.min(40, Math.ceil(L / nat)) : 1;
    for (let r = 0; r < reps; r++) {
      for (const ln of sub.lines) {
        const back = tk.rev || tk.mirror; // both read the clip backwards / 둘 다 거꾸로
        const src = back ? [...ln.pts].reverse() : ln.pts;
        const pts = [];
        for (const p of src) {
          const tl = (back ? tk.len - p.t : p.t) - off;
          if (tl < -1e-6) continue;
          const tt = tl / rate + r * nat;
          if (tt > L + 1e-6) break;
          pts.push({ t: tt, m: p.m + semis });
        }
        if (pts.length >= 2) out.lines.push({ key: ln.key, name: ln.name, rep: r * 1000 + ln.rep, pts });
      }
    }
    return out;
  }
  const start = Number(inst.start) || 0;
  if (inst.studio === 'risset') {
    const p = resolveDocParams(inst);
    const sh = tapeSemitones(channelRates(inst).tape); // tape mode moves the pitch / 테이프 모드 음고 이동
    out.band = { lo: p.baseMidi + sh, hi: p.baseMidi + p.spanSemitones + sh };
    return out;
  }
  const nat = mixer.naturalLength(inst);
  out.nat = nat;
  if (!(nat > 0.02)) return out;
  // The studio projects itself onto the Master's time × pitch grid (studios/projection.js); a studio without a
  // projection — or a clip studio whose adapter gives no lines — is drawn as a block.
  // 스튜디오가 스스로 격자에 투영 (studios/projection.js). 투영이 없거나 선이 없으면 블록.
  const paths = projectStudio(inst.studio, getInstanceDoc(inst), { fromDoc: true });
  if (projectionKind(inst.studio) === 'block' || (isClipStudio(inst.studio) && !paths.length)) { out.block = true; return out; }
  const reps = inst.loop ? Math.min(40, Math.ceil(L / nat)) : 1;
  // Varispeed clip studios shift pitch by the whole rate (as the mixer plays them) / varispeed 스튜디오는 전체 배속만큼 음고 이동
  const vari = isClipStudio(inst.studio) && !clipStudioScalesTime(inst.studio);
  const semis = tapeSemitones(vari ? channelRates(inst).rate : channelRates(inst).tape);
  const rate = contentRate(inst); // Tempo Manager: document time → real time / 문서 시간 → 실제 시간
  const base = [];
  // Each path is cut into its monotone pieces (single-valued m(t)); a reversal / S¹ wrap / gap makes more pieces.
  // 경로를 시간 단조 조각(m(t) 함수)으로 나눔 — 역행·래핑·끊김은 조각이 더 생김
  for (const path of paths) {
    const pieces = monotonePieces(path.pts);
    pieces.forEach((piece, k) => base.push({ key: pieces.length > 1 ? `${path.key}#${k}` : path.key, name: path.name, pts: piece.map((q) => ({ t: q.t / rate, m: q.m + semis })) }));
  }
  // Warp: a Warp track shows its own (unbent) lines; a target shows what it sounds like — a looping
  // clip is rendered pass by pass, so every repeat is bent at its own cycle time
  // 곡률: 곡률 트랙은 자기 선(휘지 않음), 대상은 들리는 대로 — 반복 클립도 회차마다 자기 시각의 곡률
  const wf = out.warpSrc ? null : mixer.getTrackWarp(inst.warpOnly ? inst : inst.id);
  // Warp time density: content time → heard time on the track clock (voice clock: each line on its
  // own first pitch); tape also moves the pitch by 12·log2 r / 곡률 시간 밀도: 내용 시간 → 들리는 시간
  const tt = out.warpSrc ? null : mixer.getTrackTime(inst.id);
  const natC = tt ? tt.map(tt.ref).toContent(nat) : nat; // one pass in content time / 1회 내용 시간
  for (let r = 0; r < reps; r++) {
    const off = r * natC;
    for (const b of base) {
      const pts = [];
      const map = tt ? tt.map(tt.voiceClock ? (b.pts.find((q) => Number.isFinite(q.m))?.m ?? tt.ref) : tt.ref) : null;
      for (const p of b.pts) {
        const t0 = p.t + off;
        const th = map ? map.toReal(t0) : t0;
        if (th > L + 1e-6) break;
        if (!Number.isFinite(p.m)) continue;
        const mh = map && tt.mode === 'tape' ? p.m + 12 * Math.log2(map.rateAt(th)) : p.m;
        // t / m = heard (Cartesian view), t0 / m0 = as written (curved view) / t·m = 들리는 값, t0·m0 = 쓰인 값
        pts.push({ t: th, t0, m: wf ? wf(start + th, mh) : mh, m0: p.m });
      }
      if (pts.length >= 2) out.lines.push({ key: b.key, name: b.name, rep: r, pts });
    }
  }
  return out;
}

/**
 * Polylines of every Glissando voice / Field particle / clip-studio line in cycle time, Risset
 * bands, blocks, and the pitch range. / 사이클 시간 기준 곡선, 리세 대역, 블록, 음고 범위
 */
function buildGeometry() {
  const lines = []; // { inst, key, rep, pts:[{t,m}], dashed }
  const bands = []; // risset { inst, t0, t1, lo, hi }
  const blocks = []; // studios without pitch curves here { inst, t0, t1, nat } / 음고 곡선이 없는 스튜디오
  let lo = Infinity;
  let hi = -Infinity;
  for (const inst of listInstances()) {
    if (!inst.inCycle) continue;
    const start = Number(inst.start) || 0;
    const L = mixer.clipLength(inst);
    if (L < 0.02) continue;
    const end = start + L;
    const g = clipGeometry(inst, L);
    if (g.band) {
      // band in written pitch; wf bends it to what is heard (takes are already heard) / 쓰인 음고 대역, wf = 들리는 음고로
      bands.push({ inst, t0: start, t1: end, lo: g.band.lo, hi: g.band.hi, wf: inst.take?.on || inst.warp?.on ? null : mixer.getTrackWarp(inst.id) });
      lo = Math.min(lo, g.band.lo);
      hi = Math.max(hi, g.band.hi);
      continue;
    }
    if (g.block) { blocks.push({ inst, t0: start, t1: end, nat: g.nat }); continue; }
    for (const ln of g.lines) {
      const pts = ln.pts.map((p) => ({ t: p.t + start, t0: (p.t0 ?? p.t) + start, m: p.m, m0: p.m0 }));
      for (const p of pts) { lo = Math.min(lo, p.m, p.m0 ?? p.m); hi = Math.max(hi, p.m, p.m0 ?? p.m); }
      lines.push({ inst, key: ln.key, name: ln.name, rep: ln.rep, pts, dashed: inst.studio === 'field' || g.warpSrc, warpSrc: g.warpSrc });
    }
  }
  if (!Number.isFinite(lo)) { lo = 36; hi = 84; }
  lo = Math.floor(lo - 3);
  hi = Math.ceil(hi + 3);
  if (hi - lo < 24) { const c = (hi + lo) / 2; lo = c - 12; hi = c + 12; }
  return { lines, bands, blocks, lo: clamp(lo, 0, 132), hi: clamp(hi, 6, 140) };
}

/**
 * Master View pitch lines of the audible tracks, grouped per track (cycle seconds, heard pitch) — for MIDI
 * export (ui/midi-window.js). Warp source tracks, Risset bands and block studios have no lines.
 * 들리는 트랙의 마스터 뷰 음고 선을 트랙별로 (사이클 초, 들리는 음고) — MIDI 내보내기용.
 */
export function masterViewLineGroups() {
  const g = buildGeometry();
  const insts = listInstances().filter((i) => i.inCycle);
  const anySolo = insts.some((i) => i.solo);
  const by = new Map();
  for (const ln of g.lines) {
    const inst = ln.inst;
    if (ln.warpSrc || inst.mute || (anySolo && !inst.solo)) continue;
    if (!by.has(inst.id)) by.set(inst.id, { name: inst.name, studio: inst.studio, lines: [] });
    by.get(inst.id).lines.push({ name: ln.name, pts: ln.pts.map((q) => ({ t: q.t, m: q.m })) });
  }
  const skipped = insts.filter((i) => !by.has(i.id) && !i.mute && !(anySolo && !i.solo) && !i.warp?.on).map((i) => i.name);
  return { groups: [...by.values()], skipped };
}

function geometry() {
  if (!ui.lines) ui.lines = buildGeometry();
  return ui.lines;
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.round(c.clientWidth * dpr));
  const h = Math.max(10, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { w, h, dpr };
}

const PAD_L = 38;
function viewMap(c, g) {
  const { w, h, dpr } = fitCanvas(c);
  return viewMapDims(w, h, dpr, g);
}

/**
 * Pixel mapping for a w × h surface. `axes: false` drops the label margins (full-bleed video).
 * w × h 표면의 좌표 변환. axes=false면 라벨 여백 없음.
 */
export function viewMapDims(w, h, dpr, g, { axes = true, viewLen = ui.viewLen, lineScale = 1 } = {}) {
  const padL = axes ? PAD_L * dpr : 0;
  const padB = axes ? 14 * dpr : 0;
  const padR = axes ? 6 * dpr : 0;
  const padT = 6 * dpr;
  const X = (sec) => padL + (sec / viewLen) * (w - padL - padR);
  const Y = (m) => (h - padB) - ((m - g.lo) / (g.hi - g.lo)) * (h - padB - padT);
  const invX = (px) => ((px - padL) / (w - padL - padR)) * viewLen;
  const invY = (py) => g.lo + (((h - padB) - py) / (h - padB - padT)) * (g.hi - g.lo);
  return { w, h, dpr, X, Y, invX, invY, padL, padB, viewLen, lineScale };
}

/** Is the Master View in its curved view (Curved grid on)? Default for the video export. / 곡률 보기 여부 */
export function masterCurvedView() {
  return !!ui.warpGrid;
}

/** Master View geometry (cached) for the video export. / 동영상 내보내기용 기하 */
export function masterGeometry() {
  return geometry();
}

/** PY(t, m): pixel row of heard pitch m at cycle time t (see drawScene). / 들리는 음고의 화면 행 */
function lobePath(ctx, b, X, PY) {
  ctx.beginPath();
  for (let k = 0; k < b.t.length; k++) { const x = X(b.t[k]); const y = PY(b.t[k], b.hi[k]); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  for (let k = b.t.length - 1; k >= 0; k--) ctx.lineTo(X(b.t[k]), PY(b.t[k], b.lo[k]));
  ctx.closePath();
}

function cyclePos() {
  const p = mixer.getCyclePosition();
  return p ? p.pos : null;
}

/** Pseudo cycle time for a free-launched Risset (sweeps its own clip). / 런치된 리세용 시간 */
function freeTime(inst) {
  let t0 = ui.freeClock.get(inst.id);
  if (t0 === undefined) { t0 = performance.now(); ui.freeClock.set(inst.id, t0); }
  const L = mixer.clipLength(inst);
  return (Number(inst.start) || 0) + (((performance.now() - t0) / 1000) % L);
}

// Colors per background (live view = dark; the video may use black or white) / 배경별 색
const SCENE_THEMES = {
  dark: { bg: '#060b18', grid: '#1e293b', gridT: '#111c30', axis: '#64748b', axisT: '#475569', cycle: '#6366f1', dim: 'rgba(2,6,23,0.6)', text: '#f8fafc', playhead: '#f8fafc' },
  black: { bg: '#000000', grid: '#1a1a1a', gridT: '#111111', axis: '#737373', axisT: '#525252', cycle: '#6366f1', dim: 'rgba(0,0,0,0.6)', text: '#fafafa', playhead: '#ffffff' },
  white: { bg: '#ffffff', grid: '#e2e8f0', gridT: '#f1f5f9', axis: '#475569', axisT: '#64748b', cycle: '#6366f1', dim: 'rgba(241,245,249,0.75)', text: '#0f172a', playhead: '#0f172a' },
};

// A few slots each, so the live view and a video frame (other size and view length) don't evict
// each other every frame / 실시간 뷰와 동영상 프레임이 서로 밀어내지 않도록 몇 칸씩
const warpGridCache = []; // [{ fn, key, canvas }] / 곡률 격자 캐시
const warpInvCache = []; // [{ fn, key, inv }] / 역곡률 캐시
const CACHE_SLOTS = 3;
function cacheGet(list, fn, key) {
  const i = list.findIndex((e) => e.fn === fn && e.key === key);
  if (i < 0) return null;
  const e = list[i];
  if (i) { list.splice(i, 1); list.unshift(e); }
  return e;
}
function cachePut(list, e) {
  list.unshift(e);
  if (list.length > CACHE_SLOTS) list.length = CACHE_SLOTS;
}

/**
 * Inverse of the view warp, tabulated per time column: inv(t, h) = the written pitch m with
 * W(t, m) = h (nearest solution when W folds; h itself outside the table). Cached per warp + view.
 * 마스터 뷰 곡률의 역함수 inv(t, h): W(t, m) = h인 쓰인 음고 m (접히면 h에 가장 가까운 해).
 */
function warpInverse(fn, g, viewLen) {
  const key = `${g.lo}|${g.hi}|${viewLen}`;
  const hit = cacheGet(warpInvCache, fn, key);
  if (hit) return hit.inv;
  const NX = 360;
  const STEP = 0.25;
  const mLo = Math.floor(g.lo) - 36;
  const NM = Math.ceil((Math.ceil(g.hi) + 36 - mLo) / STEP);
  const cols = [];
  for (let k = 0; k <= NX; k++) {
    const t = (k / NX) * viewLen;
    const ws = new Float64Array(NM + 1);
    for (let j = 0; j <= NM; j++) ws[j] = fn(t, mLo + j * STEP);
    cols.push(ws);
  }
  const invCol = (ws, h) => {
    const j0 = clamp(Math.round((h - mLo) / STEP), 0, NM - 1);
    for (let d = 0; d <= NM; d++) {
      for (const j of d ? [j0 - d, j0 + d] : [j0]) {
        if (j < 0 || j >= NM) continue;
        const a = ws[j];
        const b = ws[j + 1];
        if ((a <= h && h <= b) || (b <= h && h <= a)) return mLo + (j + (b === a ? 0.5 : (h - a) / (b - a))) * STEP;
      }
      if (j0 - d < 0 && j0 + d >= NM) break;
    }
    return h;
  };
  const inv = (t, h) => {
    const u = clamp((t / viewLen) * NX, 0, NX);
    const k = Math.min(NX - 1, Math.floor(u));
    const f = u - k;
    const m1 = invCol(cols[k], h);
    return f < 1e-9 ? m1 : m1 + f * (invCol(cols[k + 1], h) - m1);
  };
  cachePut(warpInvCache, { fn, key, inv });
  return inv;
}

/**
 * The curved grid of the Master View's curved view (written pitch on the vertical axis).
 * Each semitone line is drawn where that heard pitch h lies in the written pitch space
 * (W⁻¹(t, h)), octaves bold and labelled at the right edge. The band between neighbouring heard
 * semitones is tinted by the local stretch s = ∂W/∂m = 1 / (W⁻¹(h + 1) − W⁻¹(h)): warm where
 * intervals widen (s > 1, lines crowd together), cool where they narrow. Time is not warped, so
 * the vertical lines stay straight. Notes drawn as written sit on the line of the pitch they sound.
 * 곡률 격자 (세로축 = 쓰인 음고): 각 반음선 = 그 음고가 들리는 쓰인 자리 W⁻¹(t, h). 반음 사이 띠는
 * 국소 늘어남 s로 색칠 — 음정이 넓어지면 따뜻한 색, 좁아지면 차가운 색. 시간은 휘지 않음.
 */
const timeGridCache = [];

/**
 * Vertical lines of the Warp time drive, per pitch row (the clock depends on the pitch it is read at).
 * Curved view (written coordinates): lines of equal heard time, x = Φ_m(T). Cartesian view (heard
 * coordinates): where each written second lands, x = Φ_m⁻¹(τ). Dense time = lines close together.
 * Bold every tick of the time ruler, faint quarters in between. Cached per rate field and view.
 * 시간 구동의 세로선 (음고 행마다 시계가 다름). 곡률 보기 = 같은 들리는 시각의 선, 직교 보기 = 쓰인 시각이 놓이는 곳.
 */
function timeGridImage(v, g, rate, viewLen, curved) {
  const { w, h, dpr, X, Y, padL, padB } = v;
  const key = `${w}x${h}|${g.lo}|${g.hi}|${viewLen}|${padL}|${padB}|${curved}`;
  const hit = cacheGet(timeGridCache, rate, key);
  if (hit) return hit.canvas;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.save();
  c.beginPath();
  c.rect(padL, 0, w - padL, h - padB);
  c.clip();
  const step = tickStep(viewLen);
  const rows = [];
  for (let m = Math.floor(g.lo) - 2; m <= Math.ceil(g.hi) + 2; m += 1) {
    const map = buildTimeMap((u) => rate(u, m), viewLen * 1.05, { rate: 60 });
    rows.push({ m, map });
  }
  for (let k = 0, s = 0; s <= viewLen + 1e-9; k++, s = (k * step) / 4) {
    const major = k % 4 === 0;
    c.strokeStyle = major ? 'rgba(251,191,36,0.7)' : 'rgba(251,191,36,0.22)';
    c.lineWidth = (major ? 1.4 : 1) * dpr;
    c.beginPath();
    rows.forEach(({ m, map }, i) => {
      const x = X(curved ? map.toContent(s) : map.toReal(s));
      if (i) c.lineTo(x, Y(m)); else c.moveTo(x, Y(m));
    });
    c.stroke();
  }
  c.restore();
  cachePut(timeGridCache, { fn: rate, key, canvas });
  return canvas;
}

function warpGridImage(v, g, fn, viewLen) {
  const { w, h, dpr, X, Y, padL, padB } = v;
  const key = `${w}x${h}|${g.lo}|${g.hi}|${viewLen}|${padL}|${padB}`;
  const hit = cacheGet(warpGridCache, fn, key);
  if (hit) return hit.canvas;
  const inv = warpInverse(fn, g, viewLen);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.save();
  c.beginPath();
  c.rect(padL, 0, w - padL, h - padB);
  c.clip();
  const nx = clamp(Math.round((w - padL) / (4 * dpr)), 40, 260);
  const xs = new Float64Array(nx + 1);
  const secs = new Float64Array(nx + 1);
  for (let k = 0; k <= nx; k++) { secs[k] = (k / nx) * viewLen; xs[k] = X(secs[k]); }
  const m0 = Math.floor(g.lo) - 24;
  const m1 = Math.ceil(g.hi) + 24;
  let prevY = null;
  let prevM = null;
  const rows = [];
  for (let m = m0; m <= m1; m++) {
    const ys = new Float64Array(nx + 1);
    const ms = new Float64Array(nx + 1);
    for (let k = 0; k <= nx; k++) { ms[k] = inv(secs[k], m); ys[k] = Y(ms[k]); }
    if (prevY) {
      for (let k = 0; k < nx; k++) {
        const dm = 0.5 * ((ms[k] - prevM[k]) + (ms[k + 1] - prevM[k + 1]));
        const l = -Math.log2(Math.max(1e-3, Math.abs(dm)));
        if (Math.abs(l) < 0.03) continue;
        const a = Math.min(0.42, Math.abs(l) * 0.45);
        c.fillStyle = l > 0 ? `rgba(251,146,60,${a})` : `rgba(56,189,248,${a})`;
        c.beginPath();
        c.moveTo(xs[k], prevY[k]); c.lineTo(xs[k + 1], prevY[k + 1]); c.lineTo(xs[k + 1], ys[k + 1]); c.lineTo(xs[k], ys[k]);
        c.closePath();
        c.fill();
      }
    }
    rows.push({ m, ys });
    prevY = ys;
    prevM = ms;
  }
  for (const { m, ys } of rows) {
    const oct = m % 12 === 0;
    c.strokeStyle = oct ? 'rgba(216,180,254,0.85)' : 'rgba(192,132,252,0.22)';
    c.lineWidth = (oct ? 1.5 : 1) * dpr;
    c.beginPath();
    for (let k = 0; k <= nx; k++) { if (k) c.lineTo(xs[k], ys[k]); else c.moveTo(xs[k], ys[k]); }
    c.stroke();
  }
  c.restore();
  c.font = `${9 * dpr}px JetBrains Mono, monospace`;
  c.textAlign = 'right';
  c.textBaseline = 'bottom';
  c.fillStyle = 'rgba(233,213,255,0.9)';
  for (const { m, ys } of rows) {
    const y = ys[nx];
    if (m % 12 === 0 && y > 8 * dpr && y < h - padB) c.fillText(`⌇${midiToNoteName(m)}`, w - 4 * dpr, y - 1 * dpr);
  }
  cachePut(warpGridCache, { fn, key, canvas });
  return canvas;
}

/** Layers of the Master View; the video export can turn each off. / 마스터 뷰 레이어 (동영상에서 개별 끄기) */
export const SCENE_LAYERS = Object.freeze(['grid', 'axes', 'graphics', 'regions', 'markers', 'playhead', 'legend']);

function drawMaster() {
  const c = panel?.querySelector('#mgrMaster');
  if (!c) return;
  const g = geometry();
  const v = viewMap(c, g);
  const ctx = c.getContext('2d');
  const s = ui.shape;
  const hovered = s && ui.hover ? pickLine(ui.hover.x, ui.hover.y, v) : null;
  const pos = ui.scrub !== null && ui.scrub !== undefined ? ui.scrub : cyclePos();
  drawScene(ctx, v, g, {
    pos,
    cue: mixer.isCyclePlaying() ? null : mixer.getCycleCue(),
    hovered,
    shape: s,
    risset: liveRisset(),
    viewWarp: mixer.getMasterViewWarp(),
    viewTime: mixer.getMasterViewTime(),
    sel: ui.sel,
    warpGrid: ui.warpGrid && !s, // Shape select works on what is heard → Cartesian view / 모양 선택은 직교 보기에서
  });
  // Readout / 좌표 표시
  const ro = panel.querySelector('#mgrReadout');
  if (ro) {
    if (ui.hover) {
      const sec = v.invX(ui.hover.x);
      const m = v.invY(ui.hover.y);
      const vw = ui.warpGrid && !s ? mixer.getMasterViewWarp() : null; // curved view: written → heard / 곡률 보기: 쓰인 음 → 들리는 음
      const note = vw ? `${midiToNoteName(Math.round(m))} → ${midiToNoteName(Math.round(vw(sec, m)))}` : midiToNoteName(Math.round(m));
      ro.textContent = `${fmt(sec)} s · ${note}${hovered ? ` · ${hovered.inst.name} / ${hovered.name}` : ''}`;
    } else ro.textContent = '';
  }
}

/** Live Risset voices + trails for the Master View: [{ inst, tc, ms, as, trail, audible }]. / 실시간 리세 보이스 */
function liveRisset() {
  const out = [];
  for (const inst of listInstances()) {
    if (inst.studio !== 'risset') continue;
    const live = mixer.getRissetLive(inst.id);
    let trail = ui.trails.get(inst.id);
    if (!live) { ui.trails.delete(inst.id); ui.freeClock.delete(inst.id); continue; }
    const cp = cyclePos();
    const tc = mixer.isLaunched(inst.id) && cp === null ? freeTime(inst) : cp;
    if (tc === null) continue;
    if (!trail) { trail = []; ui.trails.set(inst.id, trail); }
    if (trail.length && tc < trail[trail.length - 1].t - 0.05) trail.length = 0;
    const N = live.params.voiceCount;
    const ms = new Float32Array(N);
    const as = new Float32Array(N);
    for (let i = 0; i < N; i++) { ms[i] = phaseToMidi(live.params, live.runtime.phases[i]); as[i] = voiceAmplitude(live.params, live.runtime, i); }
    trail.push({ t: tc, ms, as });
    if (trail.length > 900) trail.splice(0, trail.length - 900);
    out.push({ inst, tc, ms, as, trail, wf: inst.warp?.on ? null : mixer.getTrackWarp(inst.id), audible: isInstanceAudible(inst) && mixer.isChannelActive(inst.id) });
  }
  return out;
}

/**
 * Draw the Master View scene into any 2D context (the live canvas or a video frame).
 * opts: { pos, cue, hovered, shape, risset, layers: {grid, axes, graphics, regions, markers, playhead, legend}, theme }
 * 마스터 뷰 장면을 임의의 2D 컨텍스트에 그림 (실시간 캔버스 또는 동영상 프레임).
 */
export function drawScene(ctx, v, g, opts = {}) {
  const L = { grid: true, axes: true, graphics: true, regions: true, markers: true, playhead: true, legend: false, ...(opts.layers || {}) };
  const th = SCENE_THEMES[opts.theme] || SCENE_THEMES.dark;
  const { w, h, dpr, X, Y } = v;
  const viewLen = v.viewLen ?? ui.viewLen;
  const bottom = h - v.padB;
  // Curved view (curved grid on and something bends): the vertical axis is the pitch as written and
  // the grid curves; otherwise (Cartesian view) every note is translated to the pitch it is heard at.
  // 곡률 보기: 세로축 = 쓰인 음고, 격자가 휨. 직교 보기: 모든 음을 들리는 음고로 번역.
  const curved = !!(opts.warpGrid && typeof opts.viewWarp === 'function');
  const inv = curved ? warpInverse(opts.viewWarp, g, viewLen) : null;
  const PY = inv ? (t, m) => Y(inv(t, m)) : (t, m) => Y(m); // heard pitch → pixel row / 들리는 음고 → 화면 행
  // written pitch m → pixel row, bent by the track's own warp wf in the Cartesian view / 쓰인 음고 → 화면 행
  const WY = (wf) => (inv || !wf ? (t, m) => Y(m) : (t, m) => Y(wf(t, m)));
  const lineY = (ln, p) => (!inv || ln.warpSrc ? Y(p.m) : Y(p.m0 ?? inv(p.t, p.m))); // targets: as written / 대상은 쓰인 그대로
  const lineX = (ln, p) => X(inv && !ln.warpSrc ? p.t0 ?? p.t : p.t); // time as written in the curved view / 곡률 보기는 쓰인 시간
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  // Octave grid + note names / 옥타브 격자와 음 이름
  ctx.font = `${10 * dpr}px JetBrains Mono, monospace`;
  ctx.textBaseline = 'middle';
  for (let m = Math.ceil(g.lo / 12) * 12; m <= g.hi; m += 12) {
    if (L.grid) {
      ctx.strokeStyle = th.grid;
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(v.padL, Y(m)); ctx.lineTo(w, Y(m)); ctx.stroke();
    }
    if (L.axes) { ctx.fillStyle = th.axis; ctx.fillText(midiToNoteName(m), 4 * dpr, Y(m)); }
  }
  // Curved grid (non-Euclidean view of the warped pitch space) / 곡률 격자 (휜 피치 공간)
  if (L.grid && curved) {
    ctx.drawImage(warpGridImage(v, g, opts.viewWarp, viewLen), 0, 0);
  }
  // Time density: vertical lines bent by the Warp time drive / 시간 밀도: 휜 세로선
  if (L.grid && opts.warpGrid && typeof opts.viewTime === 'function') {
    ctx.drawImage(timeGridImage(v, g, opts.viewTime, viewLen, curved), 0, 0);
  }
  const step = tickStep(viewLen);
  ctx.textBaseline = 'alphabetic';
  for (let s = 0; s <= viewLen + 1e-9; s += step) {
    if (L.grid) {
      ctx.strokeStyle = th.gridT;
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(X(s), 0); ctx.lineTo(X(s), bottom); ctx.stroke();
    }
    if (L.axes) { ctx.fillStyle = th.axisT; ctx.fillText(`${+s.toFixed(2)}`, X(s) + 2 * dpr, h - 3 * dpr); }
  }
  const C = mixer.cycleLength();
  if (L.markers) {
    ctx.strokeStyle = th.cycle;
    ctx.lineWidth = dpr;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(X(C), 0); ctx.lineTo(X(C), bottom); ctx.stroke();
    if (mixer.fixedCycleLength() !== null) {
      // Total length marked (the area past the set end is dimmed at the end of drawing) / 전체 길이 표시
      const T = mixer.totalLength();
      if (Math.abs(T - C) > 1e-3) {
        ctx.strokeStyle = th.axis;
        ctx.setLineDash([2 * dpr, 4 * dpr]);
        ctx.beginPath(); ctx.moveTo(X(T), 0); ctx.lineTo(X(T), bottom); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // Ranges (time) and shapes (pitch) / 구간과 모양
  if (L.regions) {
    for (const r of listRegions()) {
      const color = r.mute.length ? '251,113,133' : r.solo.length ? '250,204,21' : '148,163,184';
      const sel = r.id === ui.selRegion && !opts.export;
      if (r.kind === 'range') {
        ctx.fillStyle = `rgba(245,158,11,${sel ? 0.16 : 0.09})`;
        ctx.fillRect(X(r.t0), 0, X(r.t1) - X(r.t0), bottom);
      } else {
        for (const b of r.lobes) {
          lobePath(ctx, b, X, PY);
          ctx.fillStyle = `rgba(${color},${sel ? 0.28 : 0.16})`;
          ctx.fill();
          ctx.strokeStyle = `rgba(${color},0.9)`;
          ctx.lineWidth = (sel ? 2 : 1) * dpr;
          ctx.stroke();
        }
      }
    }
  }

  // Track selection: selected tracks drawn bold, the others faded / 선택 트랙은 굵게, 나머지는 흐리게
  const selSet = opts.sel && opts.sel.size ? opts.sel : null;
  const fk = (inst) => (!selSet || selSet.has(inst.id) ? 1 : 0.18);
  const wk = (inst) => (selSet && selSet.has(inst.id) ? 1.8 : 1);
  if (L.graphics) {
    // Clip blocks (Draw, Chaos, Cloud, …): full-height strips, loop seams marked / 클립 블록
    ctx.font = `${10 * dpr}px Inter, sans-serif`;
    (g.blocks || []).forEach((b, k) => {
      const audible = isInstanceAudible(b.inst);
      const x0 = X(b.t0);
      const x1 = X(b.t1);
      ctx.fillStyle = hexA(b.inst.color, (audible ? 0.10 : 0.04) * fk(b.inst));
      ctx.fillRect(x0, 0, x1 - x0, bottom);
      ctx.strokeStyle = hexA(b.inst.color, (audible ? 0.6 : 0.25) * fk(b.inst));
      ctx.lineWidth = dpr * wk(b.inst);
      ctx.strokeRect(x0, 0.5 * dpr, x1 - x0, bottom - dpr);
      ctx.setLineDash([2 * dpr, 3 * dpr]);
      for (let r = 1; b.inst.loop && r * b.nat < b.t1 - b.t0 - 1e-6 && r < 60; r++) {
        const x = X(b.t0 + r * b.nat);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = hexA(b.inst.color, (audible ? 0.95 : 0.4) * fk(b.inst));
      ctx.fillText(`${b.inst.name} · ${studioShortName(b.inst.studio)}`, x0 + 4 * dpr, (14 + 13 * (k % 4)) * dpr);
    });

    // Risset bands / 리세 대역
    for (const b of g.bands) {
      // straight box as written (curved view); bent to what is heard in the Cartesian view / 곡률 보기 = 쓰인 상자, 직교 보기 = 휜 대역
      const BY = WY(b.wf);
      const n = !inv && b.wf ? 96 : 1;
      ctx.beginPath();
      for (let k = 0; k <= n; k++) { const t = b.t0 + (k / n) * (b.t1 - b.t0); if (k) ctx.lineTo(X(t), BY(t, b.hi)); else ctx.moveTo(X(t), BY(t, b.hi)); }
      for (let k = n; k >= 0; k--) { const t = b.t0 + (k / n) * (b.t1 - b.t0); ctx.lineTo(X(t), BY(t, b.lo)); }
      ctx.closePath();
      ctx.fillStyle = hexA(b.inst.color, (isInstanceAudible(b.inst) ? 0.07 : 0.03) * fk(b.inst));
      ctx.fill();
      ctx.strokeStyle = hexA(b.inst.color, 0.35 * fk(b.inst));
      ctx.lineWidth = dpr * wk(b.inst);
      ctx.stroke();
    }

    // Curves / 곡선
    const s = opts.shape;
    for (const ln of g.lines) {
      const audible = isInstanceAudible(ln.inst);
      const isA = s?.a && s.a.inst === ln.inst.id && s.a.key === ln.key && ln.rep === 0;
      const isB = s?.b && s.b.inst === ln.inst.id && s.b.key === ln.key && ln.rep === 0;
      const isHover = opts.hovered === ln;
      ctx.strokeStyle = isA || isB ? th.text : hexA(ln.inst.color, (audible ? (ln.rep ? 0.55 : 0.95) : 0.25) * fk(ln.inst));
      ctx.lineWidth = (isA || isB ? 3 : isHover ? 2.6 : 1.6) * dpr * (v.lineScale || 1) * wk(ln.inst);
      ctx.setLineDash(ln.dashed ? [5 * dpr, 3 * dpr] : []);
      ctx.beginPath();
      ln.pts.forEach((p, k) => (k ? ctx.lineTo(lineX(ln, p), lineY(ln, p)) : ctx.moveTo(lineX(ln, p), lineY(ln, p))));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Shape candidates / 모양 후보
    if (s?.lobes.length) {
      s.lobes.forEach((b, k) => {
        const on = s.picked.has(k);
        lobePath(ctx, b, X, PY);
        ctx.fillStyle = on ? 'rgba(56,189,248,0.42)' : `rgba(56,189,248,${k % 2 ? 0.10 : 0.16})`;
        ctx.fill();
        ctx.strokeStyle = on ? '#e0f2fe' : 'rgba(125,211,252,.7)';
        ctx.lineWidth = (on ? 2 : 1) * dpr;
        ctx.setLineDash(b.closed ? [] : [3 * dpr, 3 * dpr]);
        ctx.stroke();
        ctx.setLineDash([]);
        const mid = Math.floor(b.t.length / 2);
        ctx.fillStyle = '#f8fafc';
        ctx.font = `bold ${11 * dpr}px Inter, sans-serif`;
        ctx.fillText(`${k + 1}`, X(b.t[mid]) - 3 * dpr, PY(b.t[mid], (b.lo[mid] + b.hi[mid]) / 2) + 4 * dpr);
      });
    }

    // Risset voices + trails / 리세 보이스와 궤적
    for (const r of opts.risset || []) {
      const { inst, tc, ms, as, trail, audible } = r;
      const RY = WY(r.wf);
      for (let k = 0; k < trail.length; k += 2) {
        const f = trail[k];
        for (let i = 0; i < f.ms.length; i++) {
          if (f.as[i] < 0.02) continue;
          ctx.fillStyle = hexA(inst.color, (audible ? 0.5 : 0.15) * f.as[i]);
          ctx.fillRect(X(f.t) - dpr, RY(f.t, f.ms[i]) - dpr, 2 * dpr, 2 * dpr);
        }
      }
      for (let i = 0; i < ms.length; i++) {
        if (as[i] < 0.01) continue;
        ctx.fillStyle = hexA(inst.color, audible ? 0.95 : 0.3);
        ctx.beginPath(); ctx.arc(X(tc), RY(tc, ms[i]), (1.5 + 4 * as[i]) * dpr, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // Cue (stopped) and playhead (playing or dragged) / 큐(정지 시)와 플레이헤드
  if (L.playhead) {
    if (opts.cue !== null && opts.cue !== undefined && (opts.pos === null || opts.pos === undefined)) {
      ctx.save();
      ctx.scale(dpr, dpr);
      drawCueLine(ctx, X(opts.cue) / dpr, 0, bottom / dpr);
      ctx.restore();
    }
    if (opts.pos !== null && opts.pos !== undefined) {
      const x = X(opts.pos);
      if (th.playhead === '#f8fafc' || th.playhead === '#ffffff') {
        ctx.save();
        ctx.scale(dpr, dpr);
        drawPlayheadLine(ctx, x / dpr, 0, bottom / dpr);
        ctx.restore();
      } else {
        ctx.strokeStyle = th.playhead;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke();
      }
    }
  }

  // Past a set cycle end: not played, dimmed / 지정 길이 이후는 재생되지 않음 → 어둡게
  if (L.markers && mixer.fixedCycleLength() !== null && X(C) < w) {
    ctx.fillStyle = th.dim;
    ctx.fillRect(X(C), 0, w - X(C), bottom);
    ctx.fillStyle = 'rgba(148,163,184,0.06)';
    for (let x = X(C) - h; x < w; x += 10 * dpr) { ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x + bottom, 0); ctx.lineTo(x + bottom + 3 * dpr, 0); ctx.lineTo(x + 3 * dpr, bottom); ctx.fill(); }
  }

  // Legend: instance names (video) / 범례: 인스턴스 이름
  if (L.legend) {
    ctx.font = `${12 * dpr}px Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    let y = 14 * dpr;
    for (const inst of listInstances()) {
      if (!inst.inCycle || !isInstanceAudible(inst)) continue;
      const x = v.padL + 10 * dpr;
      ctx.fillStyle = inst.color;
      ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = th.text;
      ctx.fillText(`${inst.name} · ${studioShortName(inst.studio)}`, x + 10 * dpr, y);
      y += 18 * dpr;
    }
    ctx.textBaseline = 'alphabetic';
  }
}

function hexA(hex, a) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16);
  if (!Number.isFinite(n)) return `rgba(148,163,184,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Nearest first-pass curve within 8 px of (px, py). / 가장 가까운 곡선 */
function pickLine(px, py, v) {
  let best = null;
  let bestD = 8 * v.dpr;
  for (const ln of geometry().lines) {
    if (ln.rep !== 0) continue;
    for (let k = 1; k < ln.pts.length; k++) {
      const x1 = v.X(ln.pts[k - 1].t); const y1 = v.Y(ln.pts[k - 1].m);
      const x2 = v.X(ln.pts[k].t); const y2 = v.Y(ln.pts[k].m);
      const dx = x2 - x1; const dy = y2 - y1;
      const L2 = dx * dx + dy * dy || 1;
      const u = clamp(((px - x1) * dx + (py - y1) * dy) / L2, 0, 1);
      const d = Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
      if (d < bestD) { bestD = d; best = ln; }
    }
  }
  return best;
}

function canvasPoint(e, c) {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  return { x: (e.clientX - r.left) * (c.width / Math.max(1, r.width)) || (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * (c.height / Math.max(1, r.height)) || (e.clientY - r.top) * dpr };
}

/**
 * Drag the playhead (Master View or timeline ruler). While dragging only the drawing moves; on
 * release the cue is set and, if the cycle plays, playback jumps there.
 * 플레이헤드 드래그: 드래그 중에는 표시만, 놓으면 큐 설정 (재생 중이면 그 위치로 이동).
 */
function startScrub(e, secAt, first) {
  e.preventDefault();
  const C = mixer.cycleLength();
  const lim = (sec) => clamp(sec, 0, Math.max(0, C - 0.01));
  const fine = (ev, sec) => (ev.shiftKey ? sec : Math.round(sec * 100) / 100);
  ui.scrub = lim(fine(e, first));
  paintScrub();
  const move = (ev) => { ui.scrub = lim(fine(ev, secAt(ev))); paintScrub(); };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const sec = ui.scrub;
    ui.scrub = null;
    mixer.seekCycle(sec).catch((err) => console.error(err));
    hooks.requestRender(['manager']);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function paintScrub() {
  const ph = panel?.querySelector('#mgrPlayhead');
  if (ph && ui.scrub !== null) { ph.classList.remove('mgr-hidden'); ph.style.left = pct(ui.scrub); }
  const posEl = panel?.querySelector('#mgrPos');
  if (posEl && ui.scrub !== null) posEl.textContent = t('mgr.cyclePos', fmt(ui.scrub), fmt(mixer.cycleLength()));
  drawMaster();
}

function onMasterDown(e, c) {
  const s = ui.shape;
  const g = geometry();
  const v = viewMap(c, g);
  const p = canvasPoint(e, c);
  if (!s && ui.tool === 'range') {
    // Select range is on: a drag on the Master View draws a range; the playhead stays where it is
    // 구간 선택 중: 마스터 뷰 드래그 = 구간 그리기, 플레이헤드는 움직이지 않음
    e.preventDefault();
    const draft = document.createElement('div');
    draft.className = 'mgr-draft';
    c.parentElement.appendChild(draft);
    const secAt = (ev) => clamp(v.invX(canvasPoint(ev, c).x), 0, ui.viewLen);
    const t0 = snap(secAt(e), e.shiftKey);
    const paint = (a, b) => {
      const k = c.clientWidth / Math.max(1, v.w); // canvas px → CSS px / 캔버스 → CSS 픽셀
      draft.style.left = `${c.offsetLeft + v.X(a) * k}px`;
      draft.style.width = `${Math.max(1, (v.X(b) - v.X(a)) * k)}px`;
    };
    ui.drag = { kind: 'range', t0, t1: t0, draft, secAt, paint };
    paintDraft();
    startDrag();
    return;
  }
  if (!s) { startScrub(e, (ev) => v.invX(canvasPoint(ev, c).x), p.x >= v.padL ? v.invX(p.x) : 0); return; }
  if (s.b) {
    // Toggle the enclosed area under the pointer / 클릭한 닫힌 영역 토글
    const sec = v.invX(p.x);
    const m = v.invY(p.y);
    const k = s.lobes.findIndex((b) => bandWeight(b, sec, m, { edgeSemi: 1e-6, edgeSec: 1e-6 }) > 0);
    if (k >= 0) {
      if (s.picked.has(k)) s.picked.delete(k);
      else s.picked.add(k);
      renderPanel();
    }
    return;
  }
  const ln = pickLine(p.x, p.y, v);
  if (!ln) return;
  const ref = { inst: ln.inst.id, key: ln.key, pts: ln.pts };
  if (!s.a) { s.a = ref; renderPanel(); return; }
  if (s.a.inst === ref.inst && s.a.key === ref.key) return;
  s.b = ref;
  s.lobes = computeEnclosedLobes(s.a.pts, s.b.pts);
  s.picked = new Set(s.lobes.map((b, k) => (b.closed ? k : -1)).filter((k) => k >= 0));
  if (!s.lobes.length) {
    hooks.showToast(t('mgr.shapeNone'), 'error');
    s.b = null;
  }
  renderPanel();
}

// ==========================================================================
// Animation loop (meters, playheads, master view) / 애니메이션 루프
// ==========================================================================

function drawSpectrum() {
  const c = panel?.querySelector('#mgrSpectrum');
  if (!c) return;
  const { w, h, dpr } = fitCanvas(c);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#050a16';
  ctx.fillRect(0, 0, w, h);
  const tap = getAudioCtx() ? getMasterTap() : null;
  const fx = (hz) => (Math.log(hz / 20) / Math.log(1000)) * w; // 20 Hz … 20 kHz
  ctx.font = `${9 * dpr}px JetBrains Mono, monospace`;
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    ctx.strokeStyle = '#111c30';
    ctx.beginPath(); ctx.moveTo(fx(hz), 0); ctx.lineTo(fx(hz), h); ctx.stroke();
    ctx.fillStyle = '#334155';
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, fx(hz) + 2 * dpr, h - 3 * dpr);
  }
  if (!tap) return;
  const bins = ui.specBuf && ui.specBuf.length === tap.frequencyBinCount ? ui.specBuf : (ui.specBuf = new Float32Array(tap.frequencyBinCount));
  tap.getFloatFrequencyData(bins);
  const sr = tap.context.sampleRate;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(56,189,248,.75)');
  grad.addColorStop(0.5, 'rgba(167,139,250,.75)');
  grad.addColorStop(1, 'rgba(52,211,153,.75)');
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 1; i < bins.length; i++) {
    const hz = (i * sr) / (2 * bins.length);
    if (hz < 20 || hz > 20000) continue;
    const y = h - clamp((bins[i] + 100) / 100, 0, 1) * (h - 4 * dpr);
    ctx.lineTo(fx(hz), y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.2 * dpr;
  ctx.stroke();
  // Oscilloscope overlay / 오실로스코프
  const scope = ui.scopeBuf && ui.scopeBuf.length === tap.fftSize ? ui.scopeBuf : (ui.scopeBuf = new Float32Array(tap.fftSize));
  tap.getFloatTimeDomainData(scope);
  ctx.strokeStyle = 'rgba(248,250,252,.45)';
  ctx.lineWidth = dpr;
  ctx.beginPath();
  const n = Math.min(scope.length, 1024);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 - clamp(scope[i], -1, 1) * (h / 2 - 4 * dpr);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
}

function frame() {
  rafId = null;
  if (!isManagerOpen() || !panel) return;
  try {
    const p = mixer.getCyclePosition();
    const cue = mixer.getCycleCue();
    const shown = ui.scrub !== null ? ui.scrub : p ? p.pos : null;
    const posEl = panel.querySelector('#mgrPos');
    if (posEl) posEl.textContent = t('mgr.cyclePos', fmt(shown !== null ? shown : cue), fmt(mixer.cycleLength()));
    const ph = panel.querySelector('#mgrPlayhead');
    if (ph) { ph.classList.toggle('mgr-hidden', shown === null); if (shown !== null) ph.style.left = pct(shown); }
    const cueEl = panel.querySelector('#mgrCue');
    if (cueEl) { cueEl.classList.toggle('mgr-hidden', shown !== null); cueEl.style.left = pct(cue); }
    for (const el of panel.querySelectorAll('[data-meter]')) {
      const db = mixer.channelPeakDb(el.dataset.meter);
      el.style.width = `${clamp((db + 60) / 60, 0, 1) * 100}%`;
    }
    drawMaster();
    drawSpectrum();
  } catch (err) {
    console.error('[Flexatone] manager frame:', err);
  }
  startLoop();
}

function startLoop() {
  if (rafId !== null) return;
  rafId = document.hidden ? setTimeout(frame, 100) : requestAnimationFrame(frame);
}

function stopLoop() {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  clearTimeout(rafId);
  rafId = null;
}

// Hover tracking for the master view / 마스터 뷰 호버
document.addEventListener('pointermove', (e) => {
  const c = e.target?.closest?.('#mgrMaster');
  ui.hover = c ? canvasPoint(e, c) : null;
});
