/**
 * Flexatone — studios/space/space-panels.js
 * Space Studio UI tier: the workspace DOM (header + actions, source strip, scene / observed-pitch /
 * lane canvases, medium · path · motion · effects racks). Mounted by ui/studio-host.js when the
 * Space tab is active. Also registers the `space.*` help entries in the Option(Alt) inspector.
 * 스페이스 스튜디오 작업 공간 DOM과 `space.*` 도움말 등록.
 *
 * Every control carries data-help="space.…"; every number input is picked up by ui/number-scrub.js.
 * Slider drags coalesce into one undo step (coalesceKey + endHistoryGesture on change).
 * 슬라이더 드래그 1회 = 실행 취소 1단계.
 */

import { lineLinkControl, createGhostToggle } from '../../ui/line-link.js';
import { setLineLink } from '../../core/line-clip.js';
import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { getEngineLabel } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, num } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import {
  SPACE_PATH_TYPES, rankineSpeed, PROFILE_ENGINES, SPACE_PRESETS, BAKE_RATES, PAN_MODES,
  createSpacePreset, createRandomScene, createSource, trajectoryPolyline, sampleBake, pathLength, effectiveC, getSpaceBakeCount,
  convertPathToSpline, pathEndpoints, motionSummary, getKinematics, distanceRange, SPLINE_ENDS, TIME_MODES, HOA_ORDERS, HOA_WEIGHTS, ORIENT_MODES, getListenerMotion,
} from './space-engine.js';
import { SPACE_HELP } from './space-i18n.js';
import { SPACE_HELP_EXT } from './space-i18n-ext.js';
import { createEnvelopeWindow } from '../../ui/envelope-window.js';
import { createNodeEditor, createExtraViews } from './space-scene3d.js';
import { worldNodes, splineClosed, setSplineDims, resetHandles, liftForZ } from './space-views.js';
import { createNodeGraphs } from './space-node-graphs.js';
import { effectiveHandles } from '../../modules/spline3d.js';
import { LANE_DEFS, LANE_DOMAINS, SOURCE_LANES } from './space-lanes.js';
import { SPACE_ID, getSpaceParams, editSpace, getActiveSource, getSpaceBake, SPACE_LINK_KEYS } from './space-doc.js'; // the document on screen: studio or Space Master / 화면의 문서
import { voiceGainControl } from '../../ui/voice-gain.js';
import { createSpaceCanvases, sceneTime } from './space-canvases.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { spaceLevelBound, prerenderStatus, onSpacePrerender } from './space-audio.js';
import { PLAYBACK_MODES, playbackMode, trackLaps } from './space-engine.js';
import { currentOutputAmp } from '../../audio/output-bus.js';
import { appState } from '../../core/state.js';
import { exportSpaceJson, exportSpaceWav, refreshSpaceAudio, exportSpaceAmbix, importState, selfSpaceTarget, freezeImportSound, arraySetup, arrayLiveSupport, exportSpaceArray, playArrayTest } from './space-audio.js';
import { ARRAY_LAYOUTS, ARRAY_METHODS, ARRAY_MAX_SPEAKERS, arrayMetrics, channelOrderText, getLayout } from '../../modules/speaker-arrays.js';
import { listHrirSets, getHrirSet, importHrirFiles, onHrirChange, restoreHrirSets } from '../../audio/hrir-store.js';
import { getAudioCtx } from '../../audio/audio-engine.js';
import { isHoaMode, arraySettings, SUPER_MODES, superMode, bakeArrivals } from './space-engine.js';
import { createLane } from './space-lanes.js';
import './space-checks-f4.js'; // self-checks of follow-up F4 (changing c, supersonic, Manager signals) / 후속 F4 자가진단
import { roomOf, bakeRoom, roomImages, ROOM_QUALITIES, REVERB_LAWS, SURFACES } from './space-room.js';
import './space-checks-f3.js'; // self-checks of follow-up F3 (room: reflections, reverb) / 후속 F3 자가진단
import './space-checks-f2.js'; // self-checks of follow-up F2 (loudspeaker arrays, user HRIR) / 후속 F2 자가진단
import { listInstanceTargets, onInstanceBuffer, listInstanceStems, baseTarget, stemOf, stemTarget } from '../../audio/instance-source.js';
import { listCurveStudios, listCurves, createCurveLink, resolveCurveLink, applyCurveLink, updateCurveLinks, curveLinksStale, normalizeCurveLink, CURVE_AXES, CURVE_FITS, CURVE_TIMES, CURVE_NODE_COUNTS, resetCurveXf, setCurveStretch, STRETCH_MIN, STRETCH_MAX } from './space-curve-link.js';
import { setModuleActive } from '../../ui/rack-layout.js';
import './space-checks-xf.js'; // self-checks of the trajectory transform toolbox / 궤적 변형 툴박스 자가진단
import { stereoSplit, stemSplit, ungroupSource, groupMembers, STEM_MAX } from './space-groups.js';
import './space-checks-f1.js'; // self-checks of follow-up F1 (curve links, stems, groups) / 후속 F1 자가진단
import { hoaChannels, virtualSpeakerCount } from '../../modules/ambisonics.js';
import './space-checks-b.js'; // audio self-checks of extension B / 확장 B 오디오 자가진단
import { createSpaceTimeline } from './space-timeline.js';
import { getSpaceDocTarget, setSpaceDocTarget } from './space-doc.js';
import { getSpaceMaster, editSpaceMaster, syncMasterSources } from './space-master-doc.js';
import { listInstances, getFocusedInstance, channelRates } from '../../core/manager-state.js';
import { cycleLength, fixedCycleLength } from '../../audio/manager-mixer.js';
import { refreshSpaceMaster } from '../../audio/space-master.js';
import { registerVideoStates } from '../../ui/studio-video.js';
import { getEmphasis, setEmphasis, getNodeScale, setNodeScale } from './space-emphasis.js';
import { dispatch } from '../../core/state.js';

// View states the video export can set for its recording (put back when its dialog closes): source-name size,
// waves, views (top only / top + front + side + 3-D). / 동영상 내보내기가 녹화용으로 바꿀 수 있는 보기 상태
registerVideoStates(SPACE_ID, () => {
  const view = (fn) => editSpace((d) => fn(d), { history: false });
  return [
    { id: 'nameSize', label: t('space.nameSize'), help: t('space.nameSize'), type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => (v > 0 ? Number(v).toFixed(2) : t('space.nameSize.off')), get: () => num(getSpaceParams().view3d?.nameSize ?? 0.5), set: (v) => view((d) => { d.view3d.nameSize = clamp(Number(v), 0, 1); }) },
    { id: 'rings', label: t('space.rings'), type: 'toggle', get: () => getSpaceParams().view3d?.rings !== false, set: (v) => view((d) => { d.view3d.rings = !!v; }) },
    // Emphasis: only the sources that sound now are lit (on by default in the video; brightness by level below it)
    // 강조: 지금 소리 나는 음원만 밝게 (동영상 기본값 켬; 그 아래 음량에 따른 밝기)
    { id: 'hlSound', label: t('space.vid.hlSound'), help: t('space.vid.hlSoundTip'), type: 'toggle', videoDefault: true, get: () => getEmphasis().sound, set: (v) => { setEmphasis({ sound: v }); dispatch({ type: 'space/emphasis', scope: ['space', 'studio', 'canvas'] }); } },
    { id: 'hlGain', label: t('space.vid.hlGain'), help: t('space.vid.hlGainTip'), type: 'toggle', videoDefault: true, parent: 'hlSound', get: () => getEmphasis().gain, set: (v) => { setEmphasis({ gain: v }); dispatch({ type: 'space/emphasis', scope: ['space', 'studio', 'canvas'] }); } },
    { id: 'nodeSize', label: t('space.vid.nodeSize'), help: t('space.vid.nodeSizeTip'), type: 'range', min: 0, max: 2, step: 0.05, videoDefault: 0.5, fmt: (v) => (v > 0 ? Number(v).toFixed(2) : t('space.nameSize.off')), get: () => getNodeScale(), set: (v) => { setNodeScale(v); dispatch({ type: 'space/emphasis', scope: ['space', 'studio', 'canvas'] }); } },
    { id: 'layout', label: t('space.vid.layout'), type: 'select', relayout: true, options: [['top', t('space.layout.top')], ['quad', t('space.layout.quad')]], get: () => getSpaceParams().view3d?.layout || 'top', set: (v) => view((d) => { d.view3d.layout = v === 'quad' ? 'quad' : 'top'; }) },
  ];
});

// Help entries for the Option(Alt) inspector (existing keys win). / 도움말 등록 (기존 키 우선)
for (const [k, v] of Object.entries(SPACE_HELP)) if (!HELP_DB[k]) HELP_DB[k] = v;
for (const [k, v] of Object.entries(SPACE_HELP_EXT)) if (!HELP_DB[k]) HELP_DB[k] = v;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';

/**
 * Mount the Space workspace into `root`. / 스페이스 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountSpaceWorkspace(root, hooks) {
  let syncers = [];
  let key = '';
  let canvases = null;
  let extraViews = null;
  let timeline = null;
  let envs = []; // envelope windows of the current build / 현재 빌드의 엔벨로프 창
  const commit = () => endHistoryGesture();
  // Spline node selection + drags, shared by every view (space-scene3d.js) / 모든 뷰가 공유하는 노드 편집기
  const nodeEditor = createNodeEditor({ requestRender: hooks.requestRender });
  // A background render of an imported sound finished → refresh the status badges / 가져온 소리 렌더 완료 → 상태 갱신
  const offImport = onInstanceBuffer(() => hooks.requestRender(['space']));
  let ambixNorm = false; // UI only / UI 전용
  let hrirCcw = true; // file names count the azimuth counter-clockwise (UI only) / 파일 이름의 방위가 반시계 방향 (UI 전용)
  const offHrir = onHrirChange(() => hooks.requestRender(['space']));
  const offPre = onSpacePrerender(() => hooks.requestRender(['space']));
  restoreHrirSets();
  let linkStudio = ''; // studio picked in the "path from a studio" row (UI only) / 경로 원본 스튜디오 선택 (UI 전용)
  let xfStudio = 'glissando'; // studio picked in the Transform toolbox's loader (UI only; Glissando first) / 변형 툴박스의 불러오기 스튜디오
  let xfRack = null; // the Transform toolbox node (for "Transform ↗") / 변형 툴박스 노드
  let linkSyncs = 0; // consecutive link syncs (guard against a loop) / 연속 링크 동기화 횟수
  let trackSyncs = 0; // consecutive track-length syncs / 연속 트랙 길이 동기화 횟수

  /**
   * The Manager track this editor's Space document belongs to, and its length in document seconds
   * (sec = null while the track length is automatic: it follows the document, so syncing to it would chase itself).
   * 이 문서가 속한 매니저 트랙과 그 길이(문서 초). 자동 길이면 sec = null (문서를 따르므로 동기화하면 순환).
   */
  function trackContext() {
    if (getSpaceDocTarget() !== 'studio') return null;
    const inst = getFocusedInstance('space');
    if (!inst) return null;
    // the track's set length (clipLength would cap a one-shot clip at the content it is meant to stretch)
    // 트랙에 지정된 길이 (clipLength는 단발 클립을 내용 길이로 자르므로 쓰지 않음)
    const fixed = fixedCycleLength();
    const set = inst.length !== null && inst.length !== undefined;
    if (!set && !(fixed !== null && inst.loop)) return { inst, sec: null };
    let real = set ? Number(inst.length) : fixed - (Number(inst.start) || 0);
    if (fixed !== null) real = Math.min(real, fixed - (Number(inst.start) || 0));
    const rate = Number(channelRates(inst)?.rate) || 1; // track seconds → document seconds / 트랙 초 → 문서 초
    const sec = real * rate;
    return { inst, sec: Number.isFinite(sec) && sec > 0 ? sec : null };
  }
  /** 'track' speed: duration = track length − start, for every such source (no history). / 지속시간 = 트랙 길이 − 시작 */
  function syncTrackSpeed() {
    const p = getSpaceParams();
    if (!p.sources.some((s) => s.speed.mode === 'track')) return false;
    const ctx = trackContext();
    if (!ctx?.sec) return false;
    const want = (s) => roundTo(clamp(ctx.sec - num(s.start), 0.1, 300), 3);
    if (p.sources.every((s) => s.speed.mode !== 'track' || Math.abs(num(s.duration) - want(s)) < 1e-3)) return false;
    editSpace((d) => { for (const s of d.sources) if (s.speed.mode === 'track') s.duration = want(s); }, { history: false });
    return true;
  }

  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label) => `space:${label}` });
  /** Delete the active source (✕ button, Delete / Backspace); the last one stays. / 활성 음원 삭제 */
  function deleteActiveSource() {
    editSpace((d) => {
      if (d.sources.length <= 1) return;
      const i = d.sources.findIndex((x) => x.id === d.activeSourceId);
      d.sources.splice(Math.max(0, i), 1);
      d.activeSourceId = d.sources[Math.max(0, i - 1)].id;
    });
    commit();
  }
  const seg = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  const readout = (help) => { const s = el('span', { class: 'font-mono text-[11px] text-slate-300', dataset: { help } }); return s; };

  // Document accessors / 문서 접근자
  const docNum = (k) => () => num(getSpaceParams()[k]);
  const setDocNum = (k) => (v, ck) => editSpace((d) => { d[k] = v; }, { coalesceKey: ck });
  const editActive = (fn, ck = null) => editSpace((d) => { const s = getActiveSource(d); if (s) fn(s, d); }, { coalesceKey: ck && `${ck}:${getSpaceParams().activeSourceId}` });
  const srcNum = (path) => () => num(path.split('.').reduce((o, k) => o?.[k], getActiveSource()));
  const setSrcNum = (path, round = null) => (v, ck) => editActive((s) => {
    const keys = path.split('.');
    const last = keys.pop();
    const o = keys.reduce((x, k) => x[k], s);
    o[last] = round === 'int' ? Math.round(v) : v;
  }, ck);
  const setView = (fn) => editSpace((d) => fn(d), { history: false });

  /** Source-name size in the scene views: 0 = hidden, 0.5 = default, 1 = largest (view only). / 음원 이름 크기 */
  function nameSizeControl() {
    const get = () => num(getSpaceParams().view3d?.nameSize ?? 0.5);
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.05, class: 'w-20 accent-sky-500', dataset: { help: 'space.nameSize' } });
    const out = el('span', { class: 'w-8 font-mono text-[11px] text-slate-300', dataset: { help: 'space.nameSize' } });
    range.addEventListener('input', () => { const v = Number(range.value); out.textContent = v > 0 ? v.toFixed(2) : t('space.nameSize.off'); setView((d) => { d.view3d.nameSize = v; }); });
    range.addEventListener('dblclick', () => { range.value = '0.5'; range.dispatchEvent(new Event('input')); });
    syncers.push(() => { const v = get(); if (document.activeElement !== range) range.value = String(v); out.textContent = v > 0 ? v.toFixed(2) : t('space.nameSize.off'); });
    return el('span', { class: 'inline-flex items-center gap-1' }, [range, out]);
  }

  // ------------------------------------------------------------------ header + strip
  function buildHeader(params) {
    const bakeBadge = el('span', { class: 'px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono', dataset: { help: 'space.bake' } });
    const vcBadge = el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] font-mono text-slate-300', dataset: { help: 'space.maxVc' } });
    const superBadge = el('span', { class: 'hidden px-2 py-0.5 rounded-full bg-rose-600/30 text-rose-200 border border-rose-500/40 text-[11px] font-semibold', text: t('space.supersonic'), dataset: { help: 'space.supersonic' } });
    syncers.push(() => {
      const p = getSpaceParams();
      const b = getSpaceBake(p);
      let samples = 0;
      for (const x of b.sources.values()) samples += x.n;
      bakeBadge.textContent = t('space.bakeStatus', p.sources.length, samples, getSpaceBakeCount(), b.ms.toFixed(1));
      vcBadge.textContent = t('space.maxVcBadge', b.maxVc.toFixed(3));
      vcBadge.className = `px-2 py-0.5 rounded-full text-[11px] font-mono ${b.maxVc > 0.7 ? 'bg-amber-500/20 text-amber-200 border border-amber-500/40' : 'bg-slate-800 text-slate-300'}`;
      superBadge.classList.toggle('hidden', !b.clamped);
    });
    const bake = (mode) => {
      StudioRegistry.bakeVoices(SPACE_ID, { mode });
      const all = getSpaceParams().sources;
      const imp = all.filter((x) => x.input.kind === 'import').length;
      hooks.showToast(`${t('space.bakedToGliss', Math.min(64, all.length - imp))} ${t('space.bakeLossToast')}${imp ? ` ${t('space.bakeSkipImports', imp)}` : ''}`);
    };
    const presetSel = select('space.preset', [['', t('space.presetPick')], ...SPACE_PRESETS.map((id) => [id, t(`space.preset.${id}`)])], () => '', (id) => {
      if (!id) return;
      editSpace((d) => { Object.assign(d, createSpacePreset(id)); });
      commit();
      fitView();
      hooks.showToast(t('space.presetApplied', t(`space.preset.${id}`)));
    });
    const seedNum = el('input', { type: 'number', min: 1, max: 99999, step: 1, class: 'w-16 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]', dataset: { help: 'space.random' } });
    seedNum.addEventListener('change', () => { editSpace((d) => { d.seed = clamp(Math.round(num(seedNum.value, d.seed)), 1, 99999); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seedNum) seedNum.value = String(getSpaceParams().seed); });
    const random = () => {
      const seed = getSpaceParams().seed + 1;
      editSpace((d) => { Object.assign(d, createRandomScene(seed)); });
      commit();
      fitView();
      hooks.showToast(t('space.randomApplied', seed));
    };
    const cards = params.sources.map((s) => {
      const on = s.id === params.activeSourceId;
      const flag = (field, label, onCls) => {
        const b = el('button', { class: 'px-1.5 py-0.5 rounded text-[11px] font-bold border', text: label, dataset: { help: 'space.sourceCard' }, on: { click: (e) => { e.stopPropagation(); editSpace((d) => { const x = d.sources.find((y) => y.id === s.id); if (x) x[field] = !x[field]; }); commit(); } } });
        syncers.push(() => { const x = getSpaceParams().sources.find((y) => y.id === s.id); b.className = `px-1.5 py-0.5 rounded text-[11px] font-bold border ${x?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return b;
      };
      const info = el('div', { class: 'flex justify-between gap-2 text-[11px] font-mono text-slate-300' });
      syncers.push(() => {
        const x = getSpaceParams().sources.find((y) => y.id === s.id);
        if (!x) return;
        const f = x.f.mode === 'env' ? `${Math.round(x.f.env.min)}…${Math.round(x.f.env.max)} Hz` : x.f.mode === 'curve' ? `${Math.round(x.f.hz0)}→${Math.round(x.f.hz1)} Hz` : `${roundTo(x.f.hz, 1)} Hz`;
        const v = x.speed.mode === 'env' ? `${roundTo(x.speed.env.min, 1)}…${roundTo(x.speed.env.max, 1)}` : x.speed.mode === 'curve' ? `${x.speed.from}→${x.speed.to}` : x.speed.mode === 'rankine' && x.path.type === 'orbit' ? roundTo(rankineSpeed(Math.sqrt(x.path.rx * x.path.ry), x.speed.gamma, x.speed.core), 1) : x.speed.mode === 'track' ? `⇥ ${roundTo((pathLength(x, getSpaceParams().listener) * trackLaps(x.speed)) / Math.max(0.05, x.duration), 1)}` : `${x.speed.value}`;
        info.textContent = `${t(`space.path.${x.path.type}`)} · ${v} m/s · ${f}`;
      });
      // 🔗 linked piece + play range (ui/line-link.js) / 링크·재생 구간
      const linkSlot = el('span', { class: 'inline-flex' });
      let linkKey = '';
      syncers.push(() => {
        const all = getSpaceParams().sources;
        const x = all.find((y) => y.id === s.id);
        const k = x ? JSON.stringify([x.link, x.clip, all.filter((y) => y.link?.id && y.link.id === x.link?.id).length]) : '';
        if (k === linkKey) return;
        linkKey = k;
        linkSlot.replaceChildren(...[x && lineLinkControl(x, all, (onL) => { editSpace((d) => setLineLink(d.sources, s.id, onL, SPACE_LINK_KEYS)); commit(); })].filter(Boolean));
      });
      return el('div', {
        class: `min-w-[210px] rounded-xl border p-2 flex flex-col gap-1 cursor-pointer transition ${on ? 'bg-slate-900 border-sky-500 shadow-md' : 'bg-slate-950/80 border-slate-800 hover:border-slate-700'}`,
        dataset: { help: 'space.sourceCard' },
        on: { click: () => editSpace((d) => { d.activeSourceId = s.id; }, { history: false }) },
      }, [
        el('div', { class: 'flex items-center justify-between' }, [
          el('div', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'w-2.5 h-2.5 rounded-full', style: `background:${s.color}` }), el('span', { class: 'text-xs font-bold text-slate-100', text: s.name }), linkSlot]),
          el('div', { class: 'flex gap-1' }, [flag('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400'), flag('muted', 'M', 'bg-rose-600 text-white border-rose-500')]),
        ]),
        info,
        el('div', { class: 'flex justify-end' }, [voiceGainControl({ get: () => getSpaceParams().sources.find((y) => y.id === s.id)?.baseGain ?? 0.6, set: (val, ck) => editSpace((dd) => { const x = dd.sources.find((y) => y.id === s.id); if (x) x.baseGain = val; }, { coalesceKey: `space-gain-${s.id}` }), commit, push: (fn) => syncers.push(fn), def: 0.6 })]),
      ]);
    });
    const add = () => { editSpace((d) => { const n = createSource(d.sources.length, { name: `${t('space.source')} ${d.sources.length + 1}` }); d.sources.push(n); d.activeSourceId = n.id; }); commit(); };
    const dup = () => {
      editSpace((d) => {
        const cur = getActiveSource(d);
        if (!cur || d.sources.length >= 64) return;
        const copy = createSource(d.sources.length, { ...JSON.parse(JSON.stringify(cur)), id: undefined, name: `${cur.name} R` });
        copy.color = createSource(d.sources.length).color;
        copy.start = roundTo(cur.start + 1, 2);
        d.sources.push(copy);
        d.activeSourceId = copy.id;
      });
      commit();
    };
    const del = deleteActiveSource;
    const wav = async () => {
      hooks.showToast(t('toast.wavStart'));
      try { const r = await exportSpaceWav(); hooks.showToast(r.message, r.ok ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
    };
    return el('section', { class: SECTION, dataset: { window: 'list', rack: 'space-sources' } }, [
      buildMasterBar(),
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('studio.space'), dataset: { help: 'space.header' } }),
          el('span', { class: 'text-[11px] font-bold uppercase tracking-wider text-sky-400', text: `· ${t('modlist.title')}` }), // shared name of the voice list / 보이스 목록의 공용 이름
          el('span', { class: 'px-2 py-0.5 rounded-full bg-slate-800 text-[11px] text-slate-300', text: t('space.sourceCount', params.sources.length) }),
          bakeBadge, vcBadge, superBadge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          presetSel,
          el('button', { class: BTN, text: `🎲 ${t('space.random')}`, dataset: { help: 'space.random' }, on: { click: random } }),
          seedNum,
          createTrajectoryImportButton('space'), // Glissando trajectory → this studio / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('space.bakeGliss')}`, dataset: { help: 'space.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('space.bakeAppend'), dataset: { help: 'space.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('space.exportJson')}`, dataset: { help: 'space.exportJson' }, on: { click: () => { exportSpaceJson(); hooks.showToast(t('space.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('space.exportWav')}`, dataset: { help: 'space.exportWav' }, on: { click: wav } }),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        el('div', { class: 'flex gap-2 overflow-x-auto pb-1 min-w-0 flex-1' }, cards),
        el('div', { class: 'flex gap-1.5' }, [
          el('button', { class: BTN, text: `+ ${t('space.addSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: add } }),
          el('button', { class: BTN, text: `⧉ ${t('space.dupSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: dup } }),
          el('button', { class: BTN, text: `✕ ${t('space.delSource')}`, dataset: { help: 'space.sourceEdit' }, on: { click: del } }),
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------ canvases
  function buildCanvasCol() {
    const quad = getSpaceParams().view3d.layout === 'quad';
    // Window canvases fill their host box, so a corner resize of the window (ui/rack-layout.js sets the
    // host height) resizes the views instead of letting a fixed-height canvas spill over the next window.
    // 윈도우 캔버스는 호스트 상자를 채움: 모서리로 높이를 바꾸면 뷰가 함께 커지고 줄어듦 (고정 높이 캔버스가 아래 창을 덮던 문제)
    const scene = el('canvas', { class: 'w-full h-full min-h-0 rounded-lg bg-slate-950 block touch-none', dataset: { help: 'space.scene' } });
    const extra = (help) => el('canvas', { class: 'w-full h-full min-h-0 rounded-lg bg-slate-950 block touch-none', dataset: { help } });
    const front = extra('space.layout');
    const side = extra('space.layout');
    const persp = extra('space.layout');
    // names for the video export's monitor list (ui/studio-video.js) / 동영상 내보내기 모니터 목록용 이름
    scene.dataset.videoName = 'space.vid.top';
    front.dataset.videoName = 'space.vid.front';
    side.dataset.videoName = 'space.vid.side';
    persp.dataset.videoName = 'space.vid.persp';
    const obs = el('canvas', { class: 'w-full h-[210px] rounded-lg bg-slate-950 block', dataset: { help: 'space.obs' } });
    const lanes = el('canvas', { class: 'w-full h-[190px] rounded-lg bg-slate-950 block', dataset: { help: 'space.lanes' } });
    const ro = {
      t: el('span', { class: 'text-sky-300' }), ratio: el('span', { class: 'text-emerald-300' }), fobs: el('span', { class: 'text-amber-300' }),
      vr: el('span', { class: 'text-orange-300' }), r: el('span', { class: 'text-violet-300' }), az: el('span', { class: 'text-cyan-300' }), g: el('span', { class: 'text-slate-300' }),
    };
    syncers.push(() => {
      const p = getSpaceParams();
      const s = getActiveSource(p);
      const b = s && getSpaceBake(p).sources.get(s.id);
      const T = sceneTime();
      ro.t.textContent = `${T.toFixed(2)} s`;
      const fo = sampleBake(b, 'fObs', T);
      if (!Number.isFinite(fo)) {
        for (const k of ['ratio', 'fobs', 'vr', 'r', 'az', 'g']) ro[k].textContent = '—';
        ro.fobs.textContent = t('space.silent');
        return;
      }
      const fs = sampleBake(b, 'fs', T);
      ro.fobs.textContent = `${fo.toFixed(2)} / ${fs.toFixed(2)} Hz`;
      ro.ratio.textContent = `×${(fo / fs).toFixed(4)} (${(12 * Math.log2(fo / fs)).toFixed(2)} st)`;
      ro.vr.textContent = `${sampleBake(b, 'vr', T).toFixed(2)} m/s`;
      ro.r.textContent = `${sampleBake(b, 'r', T).toFixed(2)} m`;
      ro.az.textContent = `${sampleBake(b, 'az', T).toFixed(1)}°`;
      ro.g.textContent = `${(20 * Math.log10(Math.max(1e-6, sampleBake(b, 'gain', T)))).toFixed(1)} dB`;
    });
    const zoom = (f) => () => setView((d) => { d.view.span = roundTo(clamp(d.view.span * f, 10, 3000), 2); });
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
      seg('space.tool', [['move', 'space.toolMove'], ['draw', 'space.toolDraw'], ['node', 'space.toolNode']], () => getSpaceParams().tool, (v) => setView((d) => { d.tool = v; })),
      el('span', { class: 'text-[11px] text-slate-500 ml-1', text: t('space.fitLayout') }),
      seg('space.layout', [['top', 'space.layout.top'], ['quad', 'space.layout.quad']], () => getSpaceParams().view3d.layout, (v) => setView((d) => { d.view3d.layout = v; })),
      el('span', { class: 'text-[11px] text-slate-500 ml-1', text: t('space.rings') }),
      seg('space.rings', [['on', 'space.rings.on'], ['off', 'space.rings.off']], () => (getSpaceParams().view3d.rings === false ? 'off' : 'on'), (v) => setView((d) => { d.view3d.rings = v === 'on'; })),
      el('span', { class: 'text-[11px] text-slate-500 ml-1', text: t('space.nameSize'), dataset: { help: 'space.nameSize' } }),
      nameSizeControl(),
      el('span', { class: 'text-[11px] text-slate-500 ml-1', text: t('space.zoom') }),
      el('button', { class: BTN, text: '−', dataset: { help: 'space.zoom' }, on: { click: zoom(1.25) } }),
      el('button', { class: BTN, text: '+', dataset: { help: 'space.zoom' }, on: { click: zoom(0.8) } }),
      el('button', { class: BTN, text: t('zoom.fit'), dataset: { help: 'space.fit' }, on: { click: () => fitView() } }),
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('space.sceneHint') }),
    ]);
    const roRow = el('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400', dataset: { help: 'space.readout' } }, [
      el('span', {}, ['t ', ro.t]), el('span', {}, ['f_obs/f_s ', ro.fobs]), el('span', {}, [ro.ratio]),
      el('span', {}, ['v_r ', ro.vr]), el('span', {}, ['r ', ro.r]), el('span', {}, ['θ ', ro.az]), el('span', {}, ['g ', ro.g]),
    ]);
    canvases = createSpaceCanvases({ scene, obs, lanes }, { requestRender: hooks.requestRender, nodeEditor });
    extraViews = quad ? createExtraViews({ front, side, persp }, { requestRender: hooks.requestRender, nodeEditor, sceneTime }) : null;
    // Quad layout: Top | Perspective over Front | Side, all the same size (one column when narrow)
    // quad 배치: 상단 | 원근, 그 아래 정면 | 측면 — 모두 같은 크기 (좁으면 한 열)
    const sceneBlock = quad
      ? el('div', { class: 'grid grid-cols-1 md:grid-cols-2 auto-rows-fr gap-2 h-[1232px] md:h-[608px] min-h-0' }, [scene, persp, front, side])
      : el('div', { class: 'flex flex-col h-[420px] min-h-0' }, [scene]);
    return el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [
      // The scene is always the studio's window. Without the mark, ui/rack-layout.js takes the rack with
      // the LARGEST canvas: in the quad layout the four views are smaller than the pitch canvas below,
      // so the views were moved to the end of the toolbox column. / 장면은 항상 윈도우 (quad에서 뷰가 툴박스 열 끝으로 밀리던 문제)
      el('section', { class: SECTION, dataset: { window: '1', rack: 'space-scene' } }, [toolbar, roRow, sceneBlock]),
      buildTimelineSection(), // window column: scene · timeline · voice tracks / 윈도우 열: 장면 · 타임라인 · 보이스 트랙
      el('section', { class: SECTION, dataset: { window: '0' } }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 'text-xs font-semibold text-emerald-300', text: t('space.obsTitle') }),
          el('span', { class: 'text-[11px] text-slate-500', text: t('space.obsLegend') }),
        ]),
        // Shared zoom toolbar (ui/view-nav.js) for the time canvases / 시간 캔버스용 공용 줌 툴바
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          ...(() => { const b = createLocateButtons(); syncers.push(b.sync); return b; })(), // shared ✥ Locate / 🧲 Snap
          (() => { const g = createGhostToggle(); syncers.push(g.sync); return g; })(), // ◌ unplayed parts / 재생 안 하는 부분
          createZoomBar({ onPitch: (f) => canvases?.zoomTimeCanvases('pitch', f), onTime: (f) => canvases?.zoomTimeCanvases('time', f), onBoth: (f) => canvases?.zoomTimeCanvases('both', f), onFit: () => canvases?.fitTimeCanvases() }),
          el('span', { class: 'text-[11px] text-slate-500', text: t('view.navHint') }),
        ]),
        obs,
        lanes,
      ]),
    ]);
  }

  /**
   * Timeline window (the document's time axis), in the window column between the scene and the voice
   * tracks. Its rows scroll inside the window when there are many sources; the corner handle sets the
   * height and the title row folds it (ui/rack-layout.js).
   * 타임라인 윈도우: 윈도우 열에서 장면과 보이스 트랙 사이. 음원이 많으면 안에서 스크롤, 모서리 = 높이, 제목 클릭 = 접기.
   */
  function buildTimelineSection() {
    timeline?.destroy();
    const cv = el('canvas', { class: 'w-full rounded-lg bg-slate-950 block touch-none', dataset: { help: 'space.timeline' } });
    timeline = createSpaceTimeline(cv, { requestRender: hooks.requestRender });
    return el('section', { class: SECTION, dataset: { window: '1', rack: 'space-timeline' } }, [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [el('h3', { class: 'text-xs font-semibold text-sky-300', text: t('space.tlTitle'), dataset: { help: 'space.timeline' } }), el('span', { class: 'text-[11px] text-slate-500', text: t('space.tlHint') })]),
      el('div', { class: 'max-h-[200px] overflow-y-auto min-h-0 rounded-lg' }, [cv]),
    ]);
  }

  /** Frame every trajectory and the listener; time axis = audible end. / 보기 맞춤 */
  function fitView() {
    canvases?.fitTimeCanvases(); // F / Fit All also resets the time canvases / 시간 캔버스도 함께 맞춤
    const p = getSpaceParams();
    let x0 = p.listener.x - 10;
    let x1 = p.listener.x + 10;
    let y0 = p.listener.y - 10;
    let y1 = p.listener.y + 10;
    for (const s of p.sources) for (const q of trajectoryPolyline(s, p)) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const aspect = 420 / Math.max(300, root.querySelector('canvas')?.clientWidth || 700);
    const span = clamp(Math.max(x1 - x0, (y1 - y0) / aspect) * 1.12, 10, 3000);
    const end = getSpaceBake(p).endSec;
    setView((d) => { d.view = { cx: roundTo(0.5 * (x0 + x1), 2), cy: roundTo(0.5 * (y0 + y1), 2), span: roundTo(span, 2) }; d.length = roundTo(clamp(end + 0.5, 1, 300), 1); delete d.view3d.cz; });
  }

  // ------------------------------------------------------------------ racks
  function buildMediumRack() {
    const cEff = readout('space.cScale');
    syncers.push(() => { const p = getSpaceParams(); cEff.textContent = t('space.cEff', effectiveC(p).toFixed(1), getSpaceBake(p).maxVc.toFixed(3)); });
    const setL = (k) => (v, ck) => editSpace((d) => { d.listener[k] = v; }, { coalesceKey: ck });
    const getL = (k) => () => num(getSpaceParams().listener[k]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('space.mediumTitle') }),
      slider('space.c', 'space.c', docNum('c'), setDocNum('c'), { min: 100, max: 1500, step: 1, unit: 'm/s' }),
      slider('space.cScale', 'space.cScale', docNum('cScale'), setDocNum('cScale'), { min: 0.05, max: 1, step: 0.01, unit: '×', accent: 'accent-amber' }),
      cEff,
      buildWaveBox(),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.airDist', 'space.airDist', docNum('airDist'), setDocNum('airDist'), { min: 1, max: 500, step: 1, unit: 'm' }),
        slider('space.refDist', 'space.refDist', docNum('refDist'), setDocNum('refDist'), { min: 0.1, max: 20, step: 0.1, unit: 'm' }),
      ]),
      el('div', { class: 'border-t border-slate-800 pt-2 text-[11px] uppercase tracking-wider text-slate-500', text: t('space.listener') }),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.lx', 'space.listener', getL('x'), setL('x'), { min: -500, max: 500, step: 0.5, unit: 'm' }),
        slider('space.ly', 'space.listener', getL('y'), setL('y'), { min: -500, max: 500, step: 0.5, unit: 'm' }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.heading', 'space.heading', getL('headingDeg'), setL('headingDeg'), { min: -180, max: 180, step: 1, unit: '°' }),
        slider('space.lz', 'space.lz', getL('z'), setL('z'), { min: -100, max: 200, step: 0.5, unit: 'm' }),
      ]),
      ...buildListenerMotion(),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('space.panMode', select('space.panMode', PAN_MODES.map((m) => [m, t(`space.panMode.${m}`)]), () => getSpaceParams().panMode, (v) => editSpace((d) => { d.panMode = v; })), 'space.panMode'),
        labelled('space.bakeRate', select('space.bakeRate', BAKE_RATES.map((r) => [String(r), `${r} Hz`]), () => getSpaceParams().bakeRate, (v) => editSpace((d) => { d.bakeRate = Number(v); })), 'space.bakeRate'),
      ]),
      slider('space.length', 'space.length', docNum('length'), (v) => setView((d) => { d.length = v; }), { min: 1, max: 120, step: 0.5, unit: 's' }),
    ]);
  }

  /** Changing speed of sound c(t) and what happens faster than sound (follow-up F4-b). / 변하는 음속과 초음속 처리 */
  function buildWaveBox() {
    const p0 = getSpaceParams();
    const parts = [];
    if (p0.cEnv?.on) {
      const w = createEnvelopeWindow({
        title: t('space.cEnv'), color: '#fbbf24', def: LANE_DEFS.cscale, toggle: true, domains: ['time'],
        get: () => getSpaceParams().cEnv || null,
        edit: (fn, ck) => editSpace((d) => { d.cEnv = d.cEnv || createLane('cscale'); fn(d.cEnv); }, { coalesceKey: ck }),
        commit, info: () => ({ range: [0, Math.max(1, num(getSpaceParams().length, 30))], marker: sceneTime() }), toast: (m) => hooks.showToast(m), id: 'space-env-cscale',
      });
      envs.push(w);
      syncers.push(w.sync);
      parts.push(el('div', { dataset: { help: 'space.cEnv' } }, [w.root]));
    } else {
      parts.push(el('div', { class: 'flex items-center justify-between gap-2', dataset: { help: 'space.cEnv' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.cEnv') }),
        el('button', { class: BTN, text: t('env.on'), dataset: { help: 'space.cEnv' }, on: { click: () => { editSpace((d) => { d.cEnv = { ...(d.cEnv || createLane('cscale', { curve: { engine: 'custom', reverse: false, inverse: false, customPoints: [{ x: 0, y: 1, handles: [] }, { x: 1, y: 0.3, handles: [] }] } })), on: true }; }); commit(); } } }),
      ]));
    }
    const info = readout('space.supersonic');
    syncers.push(() => {
      const p = getSpaceParams();
      const b = getSpaceBake(p);
      let extra = 0, born = 0;
      for (const x of b.sources.values()) { extra += (x.more || []).length; for (const a of bakeArrivals(x)) if (a.born) born++; }
      info.textContent = superMode(p) === 'clamp' ? '' : t('space.superInfo', b.maxVc.toFixed(2), extra, born);
    });
    parts.push(el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.supersonic' } }, [
      el('span', { class: 'text-[11px] text-slate-300', text: t('space.supersonic') }),
      seg('space.supersonic', SUPER_MODES.map((m) => [m, `space.super.${m}`]), () => superMode(getSpaceParams()), (v) => editSpace((d) => { if (v === 'clamp') d.supersonic = 'clamp'; else d.supersonic = v; }), 'rose'),
    ]), info);
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5' }, parts);
  }

  /** Listener: pitch / roll, motion along a path, orientation mode. / 청취자: 피치·롤, 경로 이동, 방향 모드 */
  function buildListenerMotion() {
    const L = getSpaceParams().listener;
    const setL = (k) => (v, ck) => editSpace((d) => { d.listener[k] = v; }, { coalesceKey: ck });
    const getL = (k) => () => num(getSpaceParams().listener[k]);
    const mv = (k) => () => num(k.split('.').reduce((o, x) => o?.[x], getSpaceParams().listener.move));
    const setMv = (k) => (v, ck) => editSpace((d) => { const keys = k.split('.'); const last = keys.pop(); keys.reduce((o, x) => o[x], d.listener.move)[last] = v; }, { coalesceKey: ck });
    const toggleMove = () => {
      editSpace((d) => {
        const m = d.listener.move;
        m.on = !m.on;
        if (m.on && (m.path.type !== 'spline' || m.path.spline.nodes.length < 2)) { // a first path: 60 m straight ahead / 첫 경로: 정면으로 60 m
          const hd = (d.listener.headingDeg * Math.PI) / 180;
          const P = (k) => ({ id: `l${k + 1}`, x: roundTo(d.listener.x + 30 * k * Math.sin(hd), 2), y: roundTo(d.listener.y + 30 * k * Math.cos(hd), 2), z: roundTo(num(d.listener.z), 2), curv: 1, tangent: 'auto', hin: [0, 0, 0], hout: [0, 0, 0] });
          m.path.type = 'spline';
          m.path.spline = { dims: '3d', closed: false, end: 'stop', nodes: [P(0), P(1), P(2)] };
        }
      });
      commit();
      if (!getSpaceParams().listener.move.on) nodeEditor.setTarget('source');
    };
    const out = [
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.lpitch', 'space.lpitch', getL('pitchDeg'), setL('pitchDeg'), { min: -90, max: 90, step: 1, unit: '°', def: 0 }),
        slider('space.lroll', 'space.lpitch', getL('rollDeg'), setL('rollDeg'), { min: -180, max: 180, step: 1, unit: '°', def: 0 }),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        toggle('space.lMove', 'space.lMove', () => !!getSpaceParams().listener.move.on, toggleMove),
        L.move.on ? toggle('space.lEditPath', 'space.lMove', () => nodeEditor.target() === 'listener', () => { nodeEditor.setTarget(nodeEditor.target() === 'listener' ? 'source' : 'listener'); }) : null,
        el('span', { class: 'text-[11px] text-slate-300 ml-1', text: t('space.orient') }),
        select('space.orient', ORIENT_MODES.map((m) => [m, t(`space.orient.${m}`)]), () => getSpaceParams().listener.orient.mode, (v) => editSpace((d) => { d.listener.orient.mode = v; if (v === 'lookAt' && !d.sources.some((x) => x.id === d.listener.orient.lookAt)) d.listener.orient.lookAt = d.activeSourceId; })),
        L.orient.mode === 'lookAt' ? select('space.orient', getSpaceParams().sources.map((x) => [x.id, x.name]), () => getSpaceParams().listener.orient.lookAt, (v) => editSpace((d) => { d.listener.orient.lookAt = v; })) : null,
      ]),
    ];
    if (L.move.on) {
      const info = readout('space.lMove');
      syncers.push(() => { const p = getSpaceParams(); const lm = getListenerMotion(p); if (lm) info.textContent = t('space.motionInfo', lm.kin.geo.len.toFixed(1), lm.kin.dur.toFixed(2), (lm.kin.geo.len / Math.max(1e-6, lm.kin.dur)).toFixed(1), Math.min(lm.kin.rawMax, lm.kin.vMax).toFixed(1)); });
      out.push(
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
          slider('space.lSpeed', 'space.lMove', mv('speed.value'), setMv('speed.value'), { min: 0.5, max: 120, step: 0.5, unit: 'm/s', accent: 'accent-amber', def: 6 }),
          slider('space.start', 'space.lMove', mv('start'), setMv('start'), { min: 0, max: 120, step: 0.05, unit: 's', def: 0 }),
        ]),
        info,
        el('span', { class: 'text-[11px] text-slate-500', text: t('space.lMoveHint') }),
      );
    }
    if (L.orient.mode === 'lanes') {
      const COL = { yaw: '#38bdf8', pitch: '#a3e635', roll: '#f472b6' };
      for (const k of ['yaw', 'pitch', 'roll']) {
        const w = createEnvelopeWindow({
          title: t(`space.orient.${k}`), color: COL[k], def: { unit: '°', lo: -3600, hi: 3600 }, toggle: false, domains: null,
          get: () => getSpaceParams().listener.orient[k],
          edit: (fn, ck) => editSpace((d) => { fn(d.listener.orient[k]); }, { coalesceKey: ck }),
          commit, info: () => ({ range: [0, Math.max(1, num(getSpaceParams().length, 30))], marker: sceneTime() }), toast: (m) => hooks.showToast(m), id: `space-orient-${k}`,
        });
        envs.push(w);
        syncers.push(w.sync);
        out.push(el('div', { class: 'border-t border-slate-800 pt-2', dataset: { help: 'space.orient' } }, [w.root]));
      }
    }
    return out;
  }

  function buildPathRack(src) {
    const type = src.path.type;
    const P = (k) => `path.${k}`;
    const S = (labelKey, k, opt, help = `space.path.${type}`) => slider(labelKey, help, srcNum(P(k)), setSrcNum(P(k), opt.int ? 'int' : null), opt);
    const XY = { min: -500, max: 500, step: 0.5, unit: 'm' };
    const R = { min: 0.5, max: 400, step: 0.5, unit: 'm' };
    const ANG = { min: 0, max: 360, step: 1, unit: '°' };
    const grid = (...c) => el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, c);
    const onL = () => toggle('space.onListener', 'space.onListener', () => !!getActiveSource()?.path.onListener, () => { editActive((s) => { s.path.onListener = !s.path.onListener; }); commit(); });
    const dir = () => toggle('space.ccw', 'space.dir', () => num(getActiveSource()?.path.dir, 1) > 0, () => { editActive((s) => { s.path.dir = num(s.path.dir, 1) > 0 ? -1 : 1; }); commit(); });
    const body = [];
    if (type === 'line') body.push(grid(S('space.x0', 'x0', XY), S('space.y0', 'y0', XY), S('space.x1', 'x1', XY), S('space.y1', 'y1', XY)));
    else if (type === 'orbit') body.push(el('div', { class: 'flex gap-1.5' }, [onL(), dir()]), grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.rx', 'rx', R), S('space.ry', 'ry', R)), S('space.phase', 'phase', ANG));
    else if (type === 'lissajous') body.push(grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.ax', 'ax', R), S('space.ay', 'ay', R), S('space.la', 'a', { min: 1, max: 7, step: 1, int: true }), S('space.lb', 'b', { min: 1, max: 7, step: 1, int: true })), S('space.delta', 'delta', ANG));
    else if (type === 'spiral') body.push(el('div', { class: 'flex gap-1.5' }, [onL(), dir()]), grid(S('space.cx', 'cx', XY), S('space.cy', 'cy', XY), S('space.r0', 'r0', { ...R, min: 0 }), S('space.r1', 'r1', { ...R, min: 0 })), grid(S('space.turns', 'turns', { min: 0.1, max: 8, step: 0.1 }), S('space.phase', 'phase', ANG)));
    else if (type === 'static') body.push(grid(S('space.sx', 'x', XY), S('space.sy', 'y', XY)));
    else if (type === 'draw') {
      const info = readout('space.path.draw');
      syncers.push(() => { const s = getActiveSource(); if (s) info.textContent = t('space.drawInfo', s.path.points.length, pathLength(s, getSpaceParams().listener).toFixed(1)); });
      body.push(info, el('span', { class: 'text-[11px] text-slate-500', text: t('space.drawHint') }));
    }
    else if (type === 'spline') body.push(...buildSplineBody());
    const toSpline = () => {
      let made = null;
      editActive((s, d) => { made = convertPathToSpline(s, d.listener); const { error, angle, ...sp } = made; s.path.spline = sp; s.path.type = 'spline'; });
      commit();
      if (made) hooks.showToast(t('space.toSplineDone', made.nodes.length, roundTo(made.error, 2)));
    };
    const lenInfo = readout(type === 'spline' ? 'space.motion' : 'space.speed');
    syncers.push(() => {
      const p = getSpaceParams();
      const s = getActiveSource(p);
      if (!s) return;
      if (s.path.type === 'spline') {
        const ms = motionSummary(s, p);
        lenInfo.textContent = t('space.motionInfo', ms.len.toFixed(1), ms.dur.toFixed(2), ms.mean.toFixed(1), ms.max.toFixed(1));
        return;
      }
      const travel = s.speed.mode === 'const' ? s.speed.value * s.duration : s.speed.mode === 'track' ? pathLength(s, p.listener) * trackLaps(s.speed) : s.speed.mode === 'rankine' && s.path.type === 'orbit' ? rankineSpeed(Math.sqrt(s.path.rx * s.path.ry), s.speed.gamma, s.speed.core) * s.duration : NaN;
      lenInfo.textContent = t('space.lengthInfo', pathLength(s, p.listener).toFixed(1), Number.isFinite(travel) ? travel.toFixed(1) : '—');
    });
    return el('section', { class: SECTION }, [
      buildGroupBox(src),
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('space.pathTitle') }),
        select('space.pathType', SPACE_PATH_TYPES.map((p) => [p, t(`space.path.${p}`)]), () => getActiveSource()?.path.type || 'line', (v) => editActive((s, d) => {
          // switching to a spline keeps the shape of the current path / 스플라인으로 바꿀 때 현재 경로 모양 유지
          if (v === 'spline' && s.path.type !== 'spline' && (s.path.spline?.nodes || []).length < 2) { const { error, angle, ...sp } = convertPathToSpline(s, d.listener); s.path.spline = sp; }
          s.path.type = v;
        })),
      ]),
      ...body,
      type !== 'spline' ? el('button', { class: BTN, text: `⌇ ${t('space.toSpline')}`, dataset: { help: 'space.toSpline' }, on: { click: toSpline } }) : null,
      buildCurveLinkBox(src),
      el('div', { class: 'border-t border-slate-800 pt-2 grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.start', 'space.timing', srcNum('start'), setSrcNum('start'), { min: 0, max: 120, step: 0.05, unit: 's' }),
        slider('space.duration', 'space.timing', srcNum('duration'), setSrcNum('duration'), { min: 0.1, max: 120, step: 0.05, unit: 's' }),
      ]),
      type !== 'spline' && src.path.hEnv?.on ? null : slider('space.height', 'space.height', srcNum('path.h'), (v, ck) => editActive((s) => {
        // a 3-D spline ignores h, so the slider lifts every node by the change / 3D 스플라인은 h 대신 모든 노드를 올림
        const sp = s.path.type === 'spline' && s.path.spline?.dims === '3d' ? s.path.spline : null;
        if (sp) { const dz = v - num(s.path.h); for (const n of sp.nodes) n.z = roundTo(num(n.z) + dz, 3); }
        s.path.h = v;
      }, ck), { min: 0, max: 100, step: 0.5, unit: 'm' }),
      type !== 'spline' && type !== 'static' ? buildEndsBox() : null,
      type !== 'spline' ? buildHeightEnvelope(src) : buildNodeGraphs(),
      lenInfo,
    ]);
  }

  // ------------------------------------------------------------------ path from another studio (curve link)
  /** Change the link of the active source and re-read its curve in the same undo step. / 링크 변경 + 곡선 재적용 (한 단계) */
  const editLink = (fn, ck = null) => editActive((s) => {
    const link = normalizeCurveLink(s.path.link);
    if (!link) return;
    fn(link);
    s.path.link = { ...link, sig: '' };
    applyCurveLink(s, resolveCurveLink(s.path.link));
  }, ck);
  function buildCurveLinkBox(src) {
    const link = normalizeCurveLink(src.path.link);
    const HELP = 'space.curveLink';
    if (!link || src.path.type !== 'spline') {
      const studios = listCurveStudios();
      if (!studios.includes(linkStudio)) linkStudio = '';
      const curves = linkStudio ? listCurves(linkStudio) : [];
      const pickStudio = select(HELP, [['', t('space.curvePickStudio')], ...studios.map((x) => [x, t(`mgr.short.${x}`)])], () => linkStudio, (v) => { linkStudio = v; hooks.requestRender(['space']); });
      const pickCurve = linkStudio ? select(HELP, [['', curves.length ? t('space.curvePick') : t('space.curveNone')], ...curves.map((c) => [c.key, `${c.kind === '3d' ? '◆' : '∿'} ${c.name}`])], () => '', (v) => {
        const c = curves.find((x) => x.key === v);
        if (!c) return;
        let res = null;
        editActive((s, d) => {
          s.path.link = createCurveLink(linkStudio, c, { x: d.listener.x, y: d.listener.y, z: num(d.listener.z) });
          res = resolveCurveLink(s.path.link);
          applyCurveLink(s, res);
        });
        commit();
        if (res?.status === 'ok') hooks.showToast(t('space.curveLinked', c.name, res.n, roundTo(res.err, 2)));
        else hooks.showToast(t(`space.curveStatus.${res?.status || 'missing'}`), 'error');
      }) : null;
      return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-wrap items-center gap-1.5', dataset: { help: HELP } }, [el('span', { class: 'text-[11px] text-slate-300', text: `⇠ ${t('space.curveFrom')}` }), pickStudio, pickCurve]);
    }
    const info = readout(HELP);
    syncers.push(() => {
      const l = normalizeCurveLink(getActiveSource()?.path.link);
      if (!l) return;
      const where = `${t(`mgr.short.${l.studio}`)} · ${l.name || l.key}`;
      info.textContent = l.status === 'ok' || !l.status ? t('space.curveInfo', where, l.n, l.err.toFixed(2)) : `${where} — ${t(`space.curveStatus.${l.status}`)}`;
      info.className = `font-mono text-[11px] ${l.status === 'ok' || !l.status ? 'text-emerald-300' : 'text-rose-300'}`;
    });
    const axis = (i) => select(HELP, CURVE_AXES.map((a) => [a, a === '0' ? '0' : a.replace('-', '−')]), () => normalizeCurveLink(getActiveSource()?.path.link)?.map.axes[i] || '0', (v) => editLink((l) => { l.map.axes[i] = v; }));
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: HELP } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-1.5' }, [
        el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-violet-300', text: `⇠ ${t('space.curveFrom')}` }),
        el('button', { class: BTN, text: `✂ ${t('space.curveUnlink')}`, dataset: { help: HELP }, on: { click: () => { editActive((s) => { delete s.path.link; }); commit(); } } }),
      ]),
      info,
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.curveMap' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: 'x ←' }), axis(0),
        el('span', { class: 'text-[11px] text-slate-300', text: 'y ←' }), axis(1),
        el('span', { class: 'text-[11px] text-slate-300', text: 'z ←' }), axis(2),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.curveMap' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.curveFit') }),
        seg('space.curveMap', CURVE_FITS.map((f) => [f, `space.curveFit.${f}`]), () => normalizeCurveLink(getActiveSource()?.path.link)?.map.fit, (v) => editLink((l) => { l.map.fit = v; })),
      ]),
      // size / rotation / centre live in the Transform toolbox (0.54.0) / 크기·회전·중심은 변형 툴박스에
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.xf' } }, [
        el('button', { class: BTN, text: `⤧ ${t('space.xfOpen')}`, dataset: { help: 'space.xf' }, on: { click: () => { if (xfRack?.isConnected) setModuleActive(xfRack, true); } } }),
        xfSummary(),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.curveFromPct', HELP, () => 100 * num(normalizeCurveLink(getActiveSource()?.path.link)?.range[0]), (v, ck) => editLink((l) => { l.range = [v / 100, Math.max(l.range[1], v / 100 + 0.01)]; }, ck), { min: 0, max: 99, step: 0.5, unit: '%', def: 0 }),
        slider('space.curveToPct', HELP, () => 100 * num(normalizeCurveLink(getActiveSource()?.path.link)?.range[1], 1), (v, ck) => editLink((l) => { l.range = [Math.min(l.range[0], v / 100 - 0.01), v / 100]; }, ck), { min: 1, max: 100, step: 0.5, unit: '%', def: 100 }),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.curveTime' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.curveTime') }),
        seg('space.curveTime', CURVE_TIMES.map((m) => [m, `space.curveTime.${m}`]), () => normalizeCurveLink(getActiveSource()?.path.link)?.time, (v) => editLink((l) => { l.time = v; }), 'amber'),
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.curveNodes') }),
        select('space.curveLink', CURVE_NODE_COUNTS.map((n) => [String(n), `≤ ${n}`]), () => String(normalizeCurveLink(getActiveSource()?.path.link)?.maxNodes || 64), (v) => editLink((l) => { l.maxNodes = Number(v); })),
      ]),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.curveHint') }),
    ]);
  }

  /** One-line summary of the transform of the active link. / 활성 링크의 변형 요약 */
  function xfSummary() {
    const out = el('span', { class: 'font-mono text-[11px] text-slate-400', dataset: { help: 'space.xf' } });
    syncers.push(() => {
      const m = normalizeCurveLink(getActiveSource()?.path.link)?.map;
      if (!m) return;
      const bits = [];
      if (m.rx || m.ry || m.yaw) bits.push(`⟳ ${[m.rx, m.ry, m.yaw].map((v) => Math.round(v)).join(' / ')}°`);
      bits.push(m.fit === 'none' ? `${roundTo(m.unit, 2)} m/u` : `⌀ ${roundTo(m.size, 1)} m`);
      if (m.sx !== 1 || m.sy !== 1 || m.sz !== 1) bits.push(`× ${[m.sx, m.sy, m.sz].map((v) => roundTo(v, 2)).join(' : ')}`);
      if (m.flip.some(Boolean)) bits.push(`⇋ ${['x', 'y', 'z'].filter((_, i) => m.flip[i]).join('')}`);
      if (m.rev) bits.push('⇤');
      out.textContent = bits.join(' · ');
    });
    return out;
  }

  // ------------------------------------------------------------------ trajectory transform toolbox
  /**
   * Transform toolbox: rotate (x / y / z), size (proportions kept) + stretch per axis (proportions kept
   * or free), mirror, reverse, position — of a trajectory loaded from another studio (Glissando first).
   * The transform is part of the link's mapping, so the path keeps following the original.
   * 변형 툴박스: 다른 스튜디오(글리산도 우선)에서 불러온 궤적의 회전·크기(비율 유지)·축별 늘이기(비율 유지 / 자유)·
   * 거울·역방향·위치. 변형은 링크 매핑의 일부라 경로는 계속 원본을 따릅니다.
   */
  function buildPathXfRack(src) {
    const HELP = 'space.xf';
    const link = src.path.type === 'spline' ? normalizeCurveLink(src.path.link) : null;
    const head = el('div', { class: 'flex items-center justify-between gap-2' }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('space.xfTitle'), dataset: { help: HELP } }),
      link ? el('button', { class: BTN, text: `↺ ${t('space.xfReset')}`, dataset: { help: 'space.xfReset' }, on: { click: () => { editLink((l) => { resetCurveXf(l.map); }); commit(); } } }) : null,
    ]);
    const box = (kids) => el('section', { class: SECTION, dataset: { rack: 'space-path-xf', toolCat: 'gen' } }, kids);
    if (!link) {
      // Loader: pick a trajectory (Glissando first) — the same link as Path → "Path from a studio" / 불러오기
      const studios = listCurveStudios();
      if (!studios.includes(xfStudio)) xfStudio = studios[0] || '';
      const curves = xfStudio ? listCurves(xfStudio) : [];
      const pickStudio = select('space.xfLoad', studios.map((x) => [x, t(`mgr.short.${x}`)]), () => xfStudio, (v) => { xfStudio = v; hooks.requestRender(['space']); });
      const pickCurve = select('space.xfLoad', [['', curves.length ? t('space.xfPickLine') : t('space.curveNone')], ...curves.map((c) => [c.key, `${c.kind === '3d' ? '◆' : '∿'} ${c.name}`])], () => '', (v) => {
        const c = curves.find((x) => x.key === v);
        if (!c) return;
        let res = null;
        editActive((s, d) => {
          s.path.link = createCurveLink(xfStudio, c, { x: d.listener.x, y: d.listener.y, z: num(d.listener.z) });
          res = resolveCurveLink(s.path.link);
          applyCurveLink(s, res);
        });
        commit();
        if (res?.status === 'ok') hooks.showToast(t('space.curveLinked', c.name, res.n, roundTo(res.err, 2)));
        else hooks.showToast(t(`space.curveStatus.${res?.status || 'missing'}`), 'error');
      });
      return box([
        head,
        el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.xfLoad' } }, [el('span', { class: 'text-[11px] text-slate-300', text: `⇠ ${t('space.xfLoad')}` }), pickStudio, pickCurve]),
        // switched off with the reason while there is nothing to transform / 변형할 궤적이 없으면 꺼짐 + 이유
        el('span', { class: 'text-[11px] text-slate-500', text: t('space.xfOff') }),
      ]);
    }
    const map = () => normalizeCurveLink(getActiveSource()?.path.link)?.map;
    const mapNum = (k, d = 0) => () => num(map()?.[k], d);
    const setMap = (k) => (v, ck) => editLink((l) => { l.map[k] = v; }, ck);
    const sub = (key) => el('div', { class: 'border-t border-slate-800 pt-2 text-[11px] uppercase tracking-wider text-slate-500', text: t(key) });
    const ANG = { min: -180, max: 180, step: 1, unit: '°', def: 0 };
    const M = { min: -300, max: 300, step: 0.5, unit: 'm', def: 0 };
    const XS = { min: STRETCH_MIN, max: STRETCH_MAX, step: 0.01, unit: '×', def: 1 };
    const turn = (k, by) => () => { editLink((l) => { let v = num(l.map[k]) + by; v = ((((v + 180) % 360) + 360) % 360) - 180; l.map[k] = v; }); commit(); };
    const quick = (label, help, fn) => el('button', { class: BTN, text: label, dataset: { help }, on: { click: fn } });
    const flip = (i) => toggle(`space.xfFlip${'XYZ'[i]}`, 'space.xfFlip', () => !!map()?.flip[i], () => { editLink((l) => { l.map.flip[i] = !l.map.flip[i]; }); commit(); });
    const stretch = (i) => slider(`space.xfS${'xyz'[i]}`, 'space.xfStretch', mapNum(['sx', 'sy', 'sz'][i], 1), (v, ck) => editLink((l) => { setCurveStretch(l.map, i, v); }, ck), XS);
    const bbox = readout('space.xfBox');
    syncers.push(() => {
      const nodes = getActiveSource()?.path.spline?.nodes || [];
      if (nodes.length < 2) { bbox.textContent = ''; return; }
      const span = ['x', 'y', 'z'].map((k) => { const v = nodes.map((n) => num(n[k])); return Math.max(...v) - Math.min(...v); });
      const zs = nodes.map((n) => num(n.z));
      bbox.textContent = t('space.xfBoxInfo', span.map((v) => v.toFixed(1)).join(' × '), Math.min(...zs).toFixed(1), Math.max(...zs).toFixed(1));
    });
    return box([
      head,
      el('span', { class: 'font-mono text-[11px] text-emerald-300', text: `${t(`mgr.short.${link.studio}`)} · ${link.name || link.key}` }),
      bbox,
      sub('space.xfRotate'),
      el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1', dataset: { help: 'space.xfRotate' } }, [
        slider('space.xfRx', 'space.xfRotate', mapNum('rx'), setMap('rx'), ANG),
        slider('space.xfRy', 'space.xfRotate', mapNum('ry'), setMap('ry'), ANG),
        slider('space.xfRz', 'space.xfRotate', mapNum('yaw'), setMap('yaw'), ANG),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        quick('⟲ 90°', 'space.xfRotate', turn('yaw', 90)),
        quick('⟳ 90°', 'space.xfRotate', turn('yaw', -90)),
        quick(`⤒ ${t('space.xfStand')}`, 'space.xfStand', () => { editLink((l) => { l.map.rx = num(l.map.rx) === 90 ? 0 : 90; }); commit(); }),
      ]),
      sub('space.xfScale'),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1', dataset: { help: 'space.xfScale' } }, [
        link.map.fit === 'none'
          ? slider('space.curveUnit', 'space.xfScale', mapNum('unit', 1), setMap('unit'), { min: 0.01, max: 50, step: 0.01, unit: 'm', def: 1 })
          : slider('space.xfSize', 'space.xfScale', mapNum('size', 60), setMap('size'), { min: 1, max: 400, step: 0.5, unit: 'm', def: 60 }),
        el('div', { class: 'flex items-center gap-1.5' }, [
          toggle('space.xfKeep', 'space.xfKeep', () => map()?.keep !== false, () => { editLink((l) => { l.map.keep = l.map.keep === false; }); commit(); }),
          quick(`1 : 1 : 1`, 'space.xfKeep', () => { editLink((l) => { const g = Math.cbrt(l.map.sx * l.map.sy * l.map.sz); l.map.sx = l.map.sy = l.map.sz = roundTo(clamp(g, STRETCH_MIN, STRETCH_MAX), 4); }); commit(); }),
        ]),
      ]),
      el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1', dataset: { help: 'space.xfStretch' } }, [stretch(0), stretch(1), stretch(2)]),
      sub('space.xfMirror'),
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.xfFlip' } }, [
        flip(0), flip(1), flip(2),
        toggle('space.xfRev', 'space.xfRev', () => !!map()?.rev, () => { editLink((l) => { l.map.rev = !l.map.rev; }); commit(); }),
      ]),
      sub('space.xfPos'),
      el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1', dataset: { help: 'space.xfPos' } }, [
        slider('space.curveCx', 'space.xfPos', mapNum('cx'), setMap('cx'), M),
        slider('space.curveCy', 'space.xfPos', mapNum('cy'), setMap('cy'), M),
        slider('space.curveCz', 'space.xfPos', mapNum('cz'), setMap('cz'), M),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        quick(`◎ ${t('space.xfToListener')}`, 'space.xfPos', () => { editLink((l) => { const L = getSpaceParams().listener; l.map.cx = roundTo(num(L.x), 3); l.map.cy = roundTo(num(L.y), 3); l.map.cz = roundTo(num(L.z), 3); }); commit(); }),
        quick(`⊥ ${t('space.xfToFloor')}`, 'space.xfPos', () => {
          // lowest node on the floor (z = 0) / 가장 낮은 노드를 바닥(z = 0)에
          const zs = (getActiveSource()?.path.spline?.nodes || []).map((n) => num(n.z));
          if (!zs.length) return;
          const dz = -Math.min(...zs);
          editLink((l) => { l.map.cz = roundTo(clamp(num(l.map.cz) + dz, -1000, 1000), 3); });
          commit();
        }),
      ]),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.xfHint') }),
    ]);
  }

  // ------------------------------------------------------------------ group (formation)
  function buildGroupBox(src) {
    const HELP = 'space.group';
    const p = getSpaceParams();
    const g = src.group;
    // no chains: a source that leads others cannot follow, and a follower cannot lead / 사슬 금지
    const others = groupMembers(p, src.id).length ? [] : p.sources.filter((x) => x.id !== src.id && !x.group?.lead);
    const leadPick = select(HELP, [['', t('space.groupNone')], ...others.map((x) => [x.id, x.name])], () => getActiveSource()?.group?.lead || '', (v) => {
      if (v) editActive((s) => { s.group = { lead: v, frame: s.group?.frame || 'path', off: s.group?.off || [0, 4, 0], tag: s.group?.tag || '' }; });
      else editSpace((d) => ungroupSource(d, d.activeSourceId));
    });
    const head = el('div', { class: 'flex flex-wrap items-center justify-between gap-1.5', dataset: { help: HELP } }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-fuchsia-300', text: t('space.groupTitle') }),
      el('div', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'text-[11px] text-slate-300', text: t('space.groupFollow') }), leadPick]),
    ]);
    const members = groupMembers(p, src.id);
    if (!g) return el('div', { class: 'flex flex-col gap-1 border-b border-slate-800 pb-2' }, [head, members.length ? el('span', { class: 'text-[11px] text-fuchsia-200', text: t('space.groupLeads', members.map((m) => m.name).join(', ')) }) : null]);
    const off = (i) => () => num(getActiveSource()?.group?.off?.[i]);
    const setOff = (i) => (v, ck) => editActive((s) => { if (s.group) s.group.off[i] = v; }, ck);
    const O = { min: -100, max: 100, step: 0.1, unit: 'm', def: 0, accent: 'accent-fuchsia' };
    const world = g.frame === 'world';
    return el('div', { class: 'flex flex-col gap-1.5 border-b border-slate-800 pb-2', dataset: { help: HELP } }, [
      head,
      members.length ? el('span', { class: 'text-[11px] text-fuchsia-200', text: t('space.groupLeads', members.map((m) => m.name).join(', ')) }) : null,
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.groupFrame') }),
        seg(HELP, [['path', 'space.groupFrame.path'], ['world', 'space.groupFrame.world']], () => getActiveSource()?.group?.frame, (v) => editActive((s) => { if (s.group) s.group.frame = v; })),
        el('button', { class: BTN, text: `✂ ${t('space.groupUngroup')}`, dataset: { help: HELP }, on: { click: () => { editSpace((d) => ungroupSource(d, d.activeSourceId)); commit(); } } }),
      ]),
      el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1' }, [
        slider(world ? 'space.groupX' : 'space.groupFwd', HELP, off(0), setOff(0), O),
        slider(world ? 'space.groupY' : 'space.groupRight', HELP, off(1), setOff(1), O),
        slider(world ? 'space.groupZ' : 'space.groupUp', HELP, off(2), setOff(2), O),
      ]),
      g.lead ? el('span', { class: 'text-[11px] text-slate-500', text: t('space.groupHint') }) : null,
    ]);
  }

  // ------------------------------------------------------------------ spline: node inspector
  const selNode = (s = getActiveSource()) => {
    if (!s || s.path.type !== 'spline') return null;
    const ids = nodeEditor.selection();
    return s.path.spline.nodes.find((n) => n.id === ids[0]) || null;
  };
  const editNodes = (fn, ck = null) => { const ids = nodeEditor.selection(); editActive((s) => { for (const n of s.path.spline.nodes) if (ids.includes(n.id)) fn(n, s); }, ck && `${ck}:${ids.join(',')}`); };
  function buildSplineBody() {
    const title = readout('space.node');
    syncers.push(() => {
      const s = getActiveSource();
      if (!s || s.path.type !== 'spline') return;
      const ids = nodeEditor.selection();
      const i = s.path.spline.nodes.findIndex((n) => n.id === ids[0]);
      title.textContent = ids.length > 1 ? t('space.nodeMulti', ids.length) : i >= 0 ? t('space.nodeOf', i + 1, s.path.spline.nodes.length) : t('space.nodeNone');
    });
    const XYZ = { min: -500, max: 500, step: 0.1, unit: 'm', accent: 'accent-violet' };
    // z shows the world height (a 2-D spline sits at h); a z edit on a 2-D spline lifts it to 3-D
    // z는 세계 높이 표시 (2D = h); 2D 스플라인에서 z를 바꾸면 3D로 승격
    const coordOf = (k) => { const s = getActiveSource(); const n = selNode(s); if (!n) return 0; return k === 'z' && s.path.spline.dims !== '3d' ? num(s.path.h) : num(n[k]); };
    const coord = (k) => slider(`space.node${k.toUpperCase()}`, 'space.node', () => coordOf(k), (v, ck) => {
      const first = selNode();
      if (!first) return;
      const id = first.id;
      editActive((s) => { if (k === 'z') liftForZ(s.path, v); const n = s.path.spline.nodes.find((x) => x.id === id); if (n && !(k === 'z' && s.path.spline.dims !== '3d')) n[k] = v; }, ck);
    }, XYZ);
    const step = (dir) => () => {
      const s = getActiveSource();
      if (!s || s.path.type !== 'spline') return;
      const nodes = s.path.spline.nodes;
      const i = nodes.findIndex((n) => n.id === nodeEditor.selection()[0]);
      nodeEditor.select([nodes[(Math.max(0, i) + dir + nodes.length) % nodes.length].id]);
    };
    const setTangent = (mode) => {
      const ids = nodeEditor.selection();
      editActive((s) => {
        const world = worldNodes(s.path).map((n) => ({ ...n, z: s.path.spline.dims === '3d' ? n.z : 0 }));
        const closed = splineClosed(s.path.spline);
        if (mode === 'auto') { resetHandles(s.path.spline, ids); return; }
        s.path.spline.nodes.forEach((n, i) => {
          if (!ids.includes(n.id) || n.tangent === 'free') return;
          const eff = effectiveHandles(world, closed, i); // start from the handles in effect / 현재 적용 중인 핸들에서 시작
          n.tangent = 'free';
          n.hin = eff.hin.map((x) => roundTo(x, 2));
          n.hout = eff.hout.map((x) => roundTo(x, 2));
        });
      });
    };
    return [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        seg('space.splineDims', [['2d', 'space.dims.2d'], ['3d', 'space.dims.3d']], () => getActiveSource()?.path.spline.dims, (v) => editActive((s) => { setSplineDims(s.path, v); })),
        el('span', { class: 'text-[11px] text-slate-500', text: t('space.splineEnd') }),
        seg('space.splineEnd', SPLINE_ENDS.map((e) => [e, `space.end.${e}`]), () => getActiveSource()?.path.spline.end, (v) => editActive((s) => { s.path.spline.end = v; s.path.spline.closed = v === 'loop'; })),
      ]),
      getActiveSource()?.path.spline.end !== 'stop' ? el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.splineRun' } }, [
        el('span', { class: 'text-[11px] text-slate-500', text: t('space.splineRun') }),
        seg('space.splineRun', [['scene', 'space.run.scene'], ['duration', 'space.run.duration']], () => getActiveSource()?.path.spline.run, (v) => editActive((s) => { s.path.spline.run = v; })),
      ]) : null,
      el('div', { class: 'border-t border-slate-800 pt-2 flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-violet-300', text: t('space.nodeTitle') }),
        title,
        el('div', { class: 'flex gap-1' }, [
          el('button', { class: BTN, text: t('space.nodePrev'), dataset: { help: 'space.node' }, on: { click: step(-1) } }),
          el('button', { class: BTN, text: t('space.nodeNext'), dataset: { help: 'space.node' }, on: { click: step(1) } }),
        ]),
      ]),
      el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1' }, [coord('x'), coord('y'), coord('z')]),
      slider('space.nodeCurv', 'space.nodeCurv', () => num(selNode()?.curv, 1), (v, ck) => editNodes((n) => { n.curv = v; }, ck), { min: 0, max: 2, step: 0.01, accent: 'accent-violet', def: 1 }),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        seg('space.nodeTangent', [['auto', 'space.tangent.auto'], ['free', 'space.tangent.free']], () => selNode()?.tangent || 'auto', setTangent),
        el('button', { class: BTN, text: t('space.nodeReset'), dataset: { help: 'space.nodeTangent' }, on: { click: () => { setTangent('auto'); commit(); } } }),
        el('button', { class: BTN, text: `✕ ${t('space.nodeDelete')}`, dataset: { help: 'space.node' }, on: { click: () => nodeEditor.deleteSelection() } }),
      ]),
      getActiveSource()?.timeMode === 'pinned' ? (() => {
        // Time pin of the selected node (empty = free) / 선택 노드의 시각 핀 (비우면 자유)
        const box = el('input', { type: 'number', min: 0, max: 300, step: 0.05, placeholder: t('space.nodeTimeNone'), class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-amber-200', dataset: { help: 'space.timeMode' } });
        const apply = () => {
          const first = selNode();
          if (!first) return;
          const id = first.id;
          const v = box.value === '' ? null : Number(box.value);
          let ok = true;
          editActive((s) => {
            const nodes = s.path.spline.nodes;
            const k = nodes.findIndex((n) => n.id === id);
            if (k < 0) return;
            if (v === null || !Number.isFinite(v)) { delete nodes[k].t; return; }
            const pin = (n) => (Number.isFinite(Number(n.t)) && n.t !== null ? Number(n.t) : null);
            const before = nodes.slice(0, k).map(pin).filter((x) => x !== null).pop();
            const after = nodes.slice(k + 1).map(pin).filter((x) => x !== null)[0];
            if ((before !== undefined && v <= before) || (after !== undefined && v >= after)) { ok = false; return; }
            nodes[k].t = roundTo(Math.max(0, v), 3);
          });
          commit();
          if (!ok) hooks.showToast(t('space.pinInvalid'), 'error');
        };
        box.addEventListener('change', apply);
        syncers.push(() => { if (document.activeElement !== box) { const n = selNode(); box.value = n && Number.isFinite(Number(n.t)) && n.t !== null ? String(n.t) : ''; } });
        return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', dataset: { help: 'space.timeMode' } }, [t('space.nodeTime'), box]);
      })() : null,
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.splineHint') }),
      el('div', { class: 'border-t border-slate-800 pt-2 flex flex-wrap items-center gap-1.5' }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.timeMode') }),
        seg('space.timeMode', TIME_MODES.map((m) => [m, `space.timeMode.${m}`]), () => getActiveSource()?.timeMode, (v) => editActive((s) => { s.timeMode = v; }), 'amber'),
      ]),
    ];
  }

  // ------------------------------------------------------------------ path height envelope + node graphs
  /** Analytic paths: z from the start to the end of the path as an envelope. / 해석적 경로: 시작→끝 높이 엔벨로프 */
  function buildHeightEnvelope(src) {
    if (src.path.hEnv?.on) {
      return el('div', { class: 'border-t border-slate-800 pt-2', dataset: { help: 'space.lane.height' } }, [
        envWindow('height', (s) => s.path.hEnv, '#c084fc', { domains: null }),
      ]);
    }
    return el('div', { class: 'flex items-center justify-between gap-2', dataset: { help: 'space.lane.height' } }, [
      el('span', { class: 'text-[11px] text-slate-300', text: t('space.lane.height') }),
      el('button', { class: BTN, text: t('env.on'), dataset: { help: 'env.on' }, on: { click: () => {
        // start flat at the current height / 현재 높이에서 평평하게 시작
        editActive((s) => { const h = num(s.path.h); const l = s.path.hEnv; l.on = true; l.min = Math.min(l.min, h); l.max = Math.max(l.max, h + 1); const y = (h - l.min) / Math.max(1e-9, l.max - l.min); l.curve = { ...l.curve, engine: 'custom', customPoints: [{ x: 0, y: roundTo(y, 4), handles: [] }, { x: 1, y: roundTo(y, 4), handles: [] }] }; });
        commit();
      } } }),
    ]);
  }
  /**
   * Analytic paths: x / y / z of the start and end point. A moved end shifts the path by an offset that
   * is interpolated evenly from the start to the end, so the middle follows in proportion.
   * 해석적 경로: 시작·끝점 x·y·z. 이동량은 시작→끝을 따라 균등 보간되어 중간이 비례해 따라감.
   */
  function buildEndsBox() {
    const AX = ['x', 'y', 'z'];
    const field = (side, k) => {
      const box = el('input', { type: 'number', step: '0.1', class: 'w-full min-w-0 bg-slate-900 border rounded px-1 py-0.5 font-mono text-[11px] text-slate-100', dataset: { help: 'space.ends' } });
      box.addEventListener('input', () => {
        const v = Number(box.value);
        if (box.value === '' || !Number.isFinite(v)) return;
        editActive((s) => { s.path.ends[side][k] = roundTo(v, 3); }, `space-ends-${side}-${k}`);
      });
      box.addEventListener('change', commit);
      box.addEventListener('keydown', (e) => e.stopPropagation());
      syncers.push(() => {
        const p = getSpaceParams();
        const s = getActiveSource(p);
        if (!s || s.path.type === 'spline' || s.path.type === 'static') return;
        const set = s.path.ends?.[side]?.[k] !== null && s.path.ends?.[side]?.[k] !== undefined;
        box.className = box.className.replace(/ border-(violet-400|slate-700)/g, '') + (set ? ' border-violet-400' : ' border-slate-700');
        if (document.activeElement === box) return;
        box.value = String(roundTo(pathEndpoints(s.path, p.listener)[side][k], 2));
      });
      return box;
    };
    const row = (side) => el('div', { class: 'grid grid-cols-[3rem_1fr_1fr_1fr] items-center gap-1' }, [
      el('span', { class: 'text-[11px] text-slate-400', text: t(`space.ends.${side}`) }),
      ...AX.map((k) => field(side, k)),
    ]);
    const reset = () => { editActive((s) => { s.path.ends = { start: { x: null, y: null, z: null }, end: { x: null, y: null, z: null } }; }); commit(); };
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1', dataset: { help: 'space.ends' } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-violet-300', text: t('space.ends') }),
        el('button', { class: BTN, text: `↺ ${t('space.ends.reset')}`, dataset: { help: 'space.ends' }, on: { click: reset } }),
      ]),
      el('div', { class: 'grid grid-cols-[3rem_1fr_1fr_1fr] gap-1 text-[10px] font-mono text-slate-500' }, [el('span'), ...AX.map((k) => el('span', { class: 'text-center', text: k }))]),
      row('start'),
      row('end'),
    ]);
  }
  /** Spline paths: x / y / z of the nodes as three envelopes over the path. / 스플라인: 노드 x·y·z를 세 엔벨로프로 */
  function buildNodeGraphs() {
    const g = createNodeGraphs({
      source: () => { const s = getActiveSource(); return s?.path.type === 'spline' ? s : null; },
      mutate: (fn, ck) => editActive((s) => { if (s.path.type === 'spline') fn(s.path); }, ck),
      commit,
      selection: () => nodeEditor.selection(),
      select: (ids) => nodeEditor.select(ids),
      marker: () => {
        const p = getSpaceParams();
        const s = getActiveSource(p);
        if (!s) return NaN;
        const te = sampleBake(getSpaceBake(p).sources.get(s.id), 'te', sceneTime());
        if (!Number.isFinite(te)) return NaN;
        const kin = getKinematics(s, p);
        return kin.progAt ? kin.progAt(te - kin.start) : NaN;
      },
      label: (k) => t('space.nodeGraph', k),
    });
    syncers.push(g.sync);
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1', dataset: { help: 'space.nodeGraphs' } }, [
      el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-violet-300', text: t('space.nodeGraphs') }),
      el('span', { class: 'text-[10px] text-slate-500', text: t('space.nodeGraphsHint') }),
      g.root,
    ]);
  }

  // ------------------------------------------------------------------ envelope windows
  /** x-axis information of a lane of the active source for its envelope window. / 엔벨로프 창용 x축 정보 */
  const laneInfo = (pick, speedLane = false) => () => {
    const p = getSpaceParams();
    const s = getActiveSource(p);
    const l = s && pick(s);
    if (!l) return { range: [0, 1] };
    const kin = getKinematics(s, p);
    const b = getSpaceBake(p).sources.get(s.id);
    const T = sceneTime();
    const te = sampleBake(b, 'te', T);
    const tau = Number.isFinite(te) ? te - kin.start : NaN; // emission time of what is heard now / 지금 들리는 소리의 방출 시각
    if (l.domain === 'path') {
      const nodeS = kin.geo.spline ? kin.geo.spline.nodeS.map((x) => x / Math.max(1e-9, kin.geo.len)) : [];
      return { range: [0, 1], markers: nodeS, marker: Number.isFinite(tau) ? kin.progAt(tau) : NaN };
    }
    if (l.domain === 'distance') return { range: kin.rRange || distanceRange(kin, p.listener), marker: sampleBake(b, 'r', T) };
    // time: the distance r(τ) as a reference, so the closest approach is visible / 시간: 거리 r(τ)를 참고 곡선으로
    const end = speedLane ? Math.max(0.05, num(s.duration, 15)) : kin.dur;
    const [r0, r1] = distanceRange(kin, p.listener);
    const Lz = num(p.listener.z);
    const overlay = [];
    for (let i = 0; i <= 64; i++) {
      const st = kin.stateAt((i / 64) * kin.dur);
      const r = Math.sqrt((st.x - p.listener.x) ** 2 + (st.y - p.listener.y) ** 2 + (st.z - Lz) ** 2);
      overlay.push([(i / 64) * kin.dur, (r - r0) / Math.max(1e-9, r1 - r0)]);
    }
    return { range: [0, end], overlay, marker: tau };
  };
  const envWindow = (kind, pick, color, { toggle = true, speedLane = false, domains = LANE_DOMAINS } = {}) => {
    const w = createEnvelopeWindow({
      title: t(`space.lane.${kind}`), color, def: LANE_DEFS[kind], toggle, domains,
      get: () => { const s = getActiveSource(); return s ? pick(s) : null; },
      edit: (fn, ck) => editActive((s) => { fn(pick(s)); }, ck),
      commit, info: laneInfo(pick, speedLane), toast: (m) => hooks.showToast(m), id: `space-env-${kind}`,
    });
    envs.push(w);
    syncers.push(w.sync);
    return w.root;
  };

  // ------------------------------------------------------------------ sound: synth | import
  /** Space Master: one source per Manager track (called before every render in master mode). / 마스터 음원 = 매니저 트랙 */
  function syncMaster() {
    const m = getSpaceMaster();
    const C = cycleLength();
    const len = C > 0 && Number.isFinite(C) ? C : 30;
    const next = syncMasterSources(m.doc, listInstances().map((i) => ({ id: i.id, name: i.name, color: i.color })), len);
    if (!next) return false;
    editSpaceMaster((d) => {
      d.doc.sources = next;
      if (!next.some((x) => x.id === d.doc.activeSourceId)) d.doc.activeSourceId = next[0]?.id || '';
      d.doc.length = Math.max(d.doc.length, Math.min(300, len));
    }, { history: false });
    return true;
  }
  /** Header controls of the Space Master (power, dry / wet, delay compensation). / 마스터 헤더 컨트롤 */
  function buildMasterBar() {
    const master = getSpaceDocTarget() === 'master';
    const chip = sharedSegment('space.master', [['studio', t('space.masterChip.studio')], ['master', t('space.masterChip.master')]], () => getSpaceDocTarget(), (v) => { nodeEditor.setTarget('source'); setSpaceDocTarget(v); if (v === 'master') syncMaster(); hooks.requestRender(['space']); }, 'fuchsia');
    if (!master) return el('div', { class: 'flex items-center gap-2' }, [chip]);
    const editM = (fn, ck = null) => { editSpaceMaster(fn, { coalesceKey: ck }); refreshSpaceMaster(); };
    return el('div', { class: 'flex flex-wrap items-center gap-2', dataset: { help: 'space.master' } }, [
      chip,
      el('span', { class: 'px-2 py-0.5 rounded-full bg-fuchsia-600/30 text-fuchsia-100 border border-fuchsia-500/50 text-[11px] font-bold', text: t('space.masterBadge') }),
      toggle('env.on', 'space.master', () => getSpaceMaster().on, () => { editM((d) => { d.on = !d.on; }); commit(); }),
      el('div', { class: 'w-40' }, [slider('space.masterWet', 'space.master', () => getSpaceMaster().wet, (v, ck) => editM((d) => { d.wet = v; }, ck), { min: 0, max: 1, step: 0.01, def: 1, compact: true })]),
      toggle('space.masterComp', 'space.masterComp', () => getSpaceMaster().compensate, () => { editM((d) => { d.compensate = !d.compensate; }); commit(); }),
    ]);
  }

  function buildSoundRack(src) {
    if (src.input.kind === 'track') { // Space Master: the sound is a Manager track / 소리 = 매니저 트랙
      const info = readout('space.master');
      syncers.push(() => { const s = getActiveSource(); if (!s || s.input.kind !== 'track') return; const st = importState(s); info.textContent = t('space.importInfo', st.name || s.name, st.length ? st.length.toFixed(2) : '—', t(`space.importStatus.${st.status}`)); });
      return el('section', { class: SECTION, dataset: { rack: 'space-sound' } }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('space.soundTitle'), dataset: { help: 'space.master' } }), el('span', { class: 'text-[11px] text-fuchsia-200', text: t('space.masterTrack') })]),
        info,
        toggle('space.masterBypass', 'space.master', () => !!getActiveSource()?.input.bypass, () => { editActive((s) => { s.input.bypass = !s.input.bypass; }); commit(); refreshSpaceMaster(); }),
      ]);
    }
    const kindSeg = seg('space.sound', [['synth', 'space.input.synth'], ['import', 'space.input.import']], () => getActiveSource()?.input.kind, (v) => editActive((s) => { s.input.kind = v; }));
    const head = el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('space.soundTitle'), dataset: { help: 'space.sound' } }), kindSeg]);
    if (src.input.kind !== 'import') return el('section', { class: SECTION, dataset: { rack: 'space-sound' } }, [head]);
    const self = selfSpaceTarget();
    const targets = listInstanceTargets().filter((x) => x.target !== self);
    /** Path duration = length of the sound (time mode Fit). / 경로 지속시간 = 소리 길이 */
    const fit = (len) => { if (len > 0.05) editActive((s) => { s.timeMode = 'fit'; s.duration = roundTo(clamp(len, 0.1, 300), 3); }); };
    const pick = select('space.sound', [['', t('space.importPick')], ...targets.map((x) => [x.target, x.editor ? t('space.importEditor', x.name) : `${x.name} · ${t(`mgr.short.${x.studio}`)}`])], () => baseTarget(getActiveSource()?.input.target || ''), (v) => {
      editActive((s) => { s.input.target = v; s.input.frozen = null; });
      const st = v ? importState(getActiveSource()) : null;
      if (st?.length) fit(st.length);
      if (st?.name) hooks.showToast(t('space.importAdded', st.name));
    });
    const status = readout('space.sound');
    syncers.push(() => {
      const s = getActiveSource();
      if (!s || s.input.kind !== 'import') return;
      const st = importState(s);
      status.textContent = t('space.importInfo', st.name || '—', st.length ? st.length.toFixed(2) : '—', t(`space.importStatus.${st.status}`));
      status.className = `font-mono text-[11px] ${st.status === 'ready' || st.status === 'frozen' ? 'text-emerald-300' : st.status === 'rendering' ? 'text-amber-300' : 'text-rose-300'}`;
    });
    const inNum = (k) => () => num(getActiveSource()?.input[k]);
    const setIn = (k) => (v, ck) => editActive((s) => { s.input[k] = v; }, ck);
    const freeze = async () => {
      const s = getActiveSource();
      if (!s) return;
      let res = null;
      try { res = await freezeImportSound(s); } catch (err) { console.error(err); }
      if (!res?.entry) { hooks.showToast(t('space.frozenFail'), 'error'); return; }
      const id = s.id;
      editSpace((d) => { const x = d.sources.find((y) => y.id === id); if (x) x.input.frozen = res.entry.id; });
      commit();
      hooks.showToast(`${t('space.frozenDone', res.entry.name)}${res.truncated ? ` ${t('space.frozenCut')}` : ''}`);
    };
    return el('section', { class: SECTION, dataset: { rack: 'space-sound' } }, [
      head,
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [pick, status]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.importContent' } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.importContent') }),
        seg('space.importContent', [['doc', 'space.content.doc'], ['heard', 'space.content.heard']], () => getActiveSource()?.input.content, (v) => editActive((s) => { s.input.content = v; })),
        seg('space.importPlay', [['once', 'space.play.once'], ['loop', 'space.play.loop']], () => getActiveSource()?.input.play, (v) => editActive((s) => { s.input.play = v; })),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.importTrim', 'space.importPlay', inNum('trimDb'), setIn('trimDb'), { min: -36, max: 24, step: 0.5, unit: 'dB', accent: 'accent-emerald', def: 0 }),
        slider('space.importOffset', 'space.importPlay', inNum('offset'), setIn('offset'), { min: 0, max: 120, step: 0.01, unit: 's', def: 0 }),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('button', { class: BTN, text: `⇔ ${t('space.importFit')}`, dataset: { help: 'space.importFit' }, on: { click: () => { const st = importState(getActiveSource()); fit(st.length); commit(); } } }),
        src.input.frozen
          ? el('button', { class: BTN, text: `⟲ ${t('space.importLink')}`, dataset: { help: 'space.importFreeze' }, on: { click: () => { editActive((s) => { s.input.frozen = null; }); commit(); } } })
          : el('button', { class: BTN, text: `❄ ${t('space.importFreeze')}`, dataset: { help: 'space.importFreeze' }, on: { click: freeze } }),
      ]),
      buildSplitRow(src),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.importNoPitch') }),
    ]);
  }

  /** Stems and stereo split of an imported sound (space-groups.js). / 가져온 소리의 스템·스테레오 분리 */
  function buildSplitRow(src) {
    const HELP = 'space.split';
    const base = baseTarget(src.input.target);
    const st = base ? listInstanceStems(base) : { ok: false, reason: 'missing' };
    const stemPick = st.ok ? select(HELP, [['', t('space.stemWhole')], ...st.list.map((x) => [x.key, x.name])], () => stemOf(getActiveSource()?.input.target) || '', (v) => editActive((s) => { s.input.target = v ? stemTarget(s.input.target, v) : baseTarget(s.input.target); s.input.frozen = null; })) : null;
    const doStems = () => {
      let made = 0;
      editSpace((d) => { made = stemSplit(d, d.activeSourceId, st.list).length; });
      commit();
      hooks.showToast(made ? `${t('space.stemsDone', made)}${st.list.length > STEM_MAX ? ` ${t('space.stemsCut', STEM_MAX, st.list.length)}` : ''}` : t('space.stemsNone'), made ? 'info' : 'error');
    };
    const doStereo = () => {
      let made = null;
      editSpace((d) => { made = stereoSplit(d, d.activeSourceId); });
      commit();
      if (made) hooks.showToast(t('space.stereoDone'));
    };
    const stemBtn = el('button', { class: BTN, text: `⫶ ${t('space.stemsSplit')}`, dataset: { help: HELP }, on: { click: doStems } });
    if (!st.ok || src.input.frozen) { stemBtn.disabled = true; stemBtn.classList.add('opacity-40'); stemBtn.title = t(`space.stemsOff.${src.input.frozen ? 'frozen' : st.reason}`); }
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: HELP } }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.importChannel') }),
        seg(HELP, [['mix', 'space.channel.mix'], ['L', 'space.channel.L'], ['R', 'space.channel.R']], () => getActiveSource()?.input.channel, (v) => editActive((s) => { s.input.channel = v; })),
        el('button', { class: BTN, text: `◐ ${t('space.stereoSplit')}`, dataset: { help: HELP }, on: { click: doStereo } }),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        stemPick ? el('span', { class: 'text-[11px] text-slate-300', text: t('space.stem') }) : null,
        stemPick,
        stemBtn,
      ]),
    ]);
  }

  // ------------------------------------------------------------------ output: HOA settings + ambiX
  function buildOutputRack() {
    const info = readout('space.output');
    syncers.push(() => {
      const p = getSpaceParams();
      info.textContent = p.panMode === 'binaural' ? t('space.hoaInfo', hoaChannels(p.spatial.order), virtualSpeakerCount(p.spatial.order)) : p.panMode === 'array' ? t('space.hoaArray') : t('space.hoaOff');
    });
    const ambix = async () => {
      hooks.showToast(t('toast.wavStart'));
      try { const r = await exportSpaceAmbix({ normalize: ambixNorm }); hooks.showToast(r.message, r.ok && !r.over ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
    };
    const normBtn = el('button', { class: BTN, text: t('space.ambixNormalize'), dataset: { help: 'space.exportAmbix' }, on: { click: () => { ambixNorm = !ambixNorm; hooks.requestRender(['space']); } } });
    syncers.push(() => { normBtn.className = `${BTN} ${ambixNorm ? '!bg-sky-600 !border-sky-500 !text-white font-semibold' : ''}`; });
    const arrayWav = async () => {
      hooks.showToast(t('toast.wavStart'));
      try { const r = await exportSpaceArray({ normalize: ambixNorm }); hooks.showToast(r.message, r.ok && !r.over ? 'info' : 'error'); } catch (err) { console.error(err); hooks.showToast(String(err.message || err), 'error'); }
    };
    const mode = getSpaceParams().panMode;
    // Clipping warning: the scene can exceed full scale (ui: Loudness Manager → Limiter) / 클리핑 경고
    const clip = el('span', { class: 'text-[11px] text-amber-300', dataset: { help: 'space.clip' } });
    syncers.push(() => {
      const bound = spaceLevelBound(getSpaceParams()) * currentOutputAmp();
      const limited = !!appState.output?.limiter;
      clip.textContent = bound > 1 && !limited ? t('space.clipWarn', (20 * Math.log10(bound)).toFixed(1)) : '';
      clip.classList.toggle('hidden', !(bound > 1 && !limited));
    });
    // Playback mode: how the studio plays the scene (exports are always full) / 재생 모드
    const pbInfo = el('span', { class: 'text-[11px] text-slate-400', dataset: { help: 'space.playback' } });
    syncers.push(() => {
      const p = getSpaceParams();
      const m = playbackMode(p);
      pbInfo.textContent = m === 'prerender' ? t(`space.playbackPre.${prerenderStatus(p)}`) : t(`space.playbackInfo.${m}`);
      pbInfo.className = `text-[11px] ${m === 'prerender' && prerenderStatus(p) === 'rendering' ? 'text-amber-300' : 'text-slate-400'}`;
    });
    const playback = el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'space.playback' } }, [
      el('span', { class: 'text-[11px] text-slate-300', text: t('space.playback') }),
      seg('space.playback', PLAYBACK_MODES.map((m) => [m, `space.playback.${m}`]), () => playbackMode(getSpaceParams()), (v) => editSpace((d) => { d.playback = v; }, { history: false }), 'emerald'),
    ]);
    return el('section', { class: SECTION, dataset: { rack: 'space-output' } }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('space.outTitle'), dataset: { help: 'space.output' } }),
      clip,
      playback,
      pbInfo,
      seg('space.output', PAN_MODES.map((m) => [m, `space.panMode.${m}`]), () => getSpaceParams().panMode, (v) => editSpace((d) => { d.panMode = v; })),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('space.hoaOrder', select('space.hoaOrder', HOA_ORDERS.map((o) => [String(o), `${o} · ${hoaChannels(o)} ch`]), () => getSpaceParams().spatial.order, (v) => editSpace((d) => { d.spatial.order = Number(v); })), 'space.hoaOrder'),
        labelled('space.hoaWeight', select('space.hoaWeight', HOA_WEIGHTS.map((w) => [w, t(`space.hoaWeight.${w}`)]), () => getSpaceParams().spatial.weighting, (v) => editSpace((d) => { d.spatial.weighting = v; })), 'space.hoaWeight'),
      ]),
      info,
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('button', { class: BTN, text: `⤓ ${t('space.exportAmbix')}`, dataset: { help: 'space.exportAmbix' }, on: { click: ambix } }),
        el('button', { class: BTN, text: `⤓ ${t('space.exportArray')}`, dataset: { help: 'space.array' }, on: { click: arrayWav } }),
        normBtn,
      ]),
      isHoaMode(mode) ? buildHrirRow() : null,
      mode === 'array' ? buildArrayBox() : null,
    ]);
  }

  // ------------------------------------------------------------------ room: reflections + reverb
  const editRoom = (fn, ck = null) => editSpace((d) => { d.room = roomOf(d); fn(d.room, d); }, { coalesceKey: ck });
  function buildRoomRack() {
    const HELP = 'space.room';
    const room = roomOf(getSpaceParams());
    const rNum = (k) => () => num(roomOf(getSpaceParams())[k]);
    const setR = (k) => (v, ck) => editRoom((r) => { r[k] = v; }, ck);
    const vNum = (k) => () => num(roomOf(getSpaceParams()).reverb[k]);
    const setV = (k) => (v, ck) => editRoom((r) => { r.reverb[k] = v; }, ck);
    const box = room.quality === 'first' || room.quality === 'second';
    const info = readout(HELP);
    syncers.push(() => {
      const p = getSpaceParams();
      const r = roomOf(p);
      if (r.quality === 'off') { info.textContent = t('space.roomOffInfo'); info.className = 'text-[11px] text-slate-500'; return; }
      const rb = bakeRoom(p);
      const names = rb.outside.map((id) => p.sources.find((s) => s.id === id)?.name || id).join(', ');
      info.textContent = `${t('space.roomCost', roomImages(r).length, p.sources.length, rb.count, rb.ms.toFixed(0))}${rb.capped ? ` ${t('space.roomCapped')}` : ''}${names ? ` ${t('space.roomOutside', names)}` : ''}`;
      info.className = `font-mono text-[11px] ${rb.capped || names ? 'text-amber-300' : 'text-slate-300'}`;
    });
    const A = { min: 0, max: 1, step: 0.01, def: 0.4 };
    const absorb = (k) => slider(`space.roomAbs.${k}`, 'space.roomAbsorb', () => num(roomOf(getSpaceParams()).absorb[k]), (v, ck) => editRoom((r) => { r.absorb[k] = v; }, ck), A);
    const M = { min: 2, max: 400, step: 0.5, unit: 'm' };
    const parts = [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('space.roomTitle'), dataset: { help: HELP } }),
        seg(HELP, ROOM_QUALITIES.map((q) => [q, `space.roomQ.${q}`]), () => roomOf(getSpaceParams()).quality, (v) => editRoom((r) => { r.quality = v; }), 'amber'),
      ]),
      info,
    ];
    if (room.quality !== 'off') {
      parts.push(el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.roomFloor', HELP, rNum('floorZ'), setR('floorZ'), { min: -50, max: 50, step: 0.1, unit: 'm', def: 0 }),
        slider('space.roomHf', 'space.roomAbsorb', rNum('hfHz'), setR('hfHz'), { min: 500, max: 20000, step: 100, unit: 'Hz', def: 6000 }),
      ]));
      if (box) parts.push(
        el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1' }, [slider('space.roomW', HELP, rNum('w'), setR('w'), M), slider('space.roomD', HELP, rNum('d'), setR('d'), M), slider('space.roomH', HELP, rNum('h'), setR('h'), { ...M, max: 100 })]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [slider('space.roomCx', HELP, rNum('cx'), setR('cx'), { min: -300, max: 300, step: 0.5, unit: 'm', def: 0 }), slider('space.roomCy', HELP, rNum('cy'), setR('cy'), { min: -300, max: 300, step: 0.5, unit: 'm', def: 0 })]),
        el('div', { class: 'grid grid-cols-3 gap-x-2 gap-y-1', dataset: { help: 'space.roomAbsorb' } }, SURFACES.map(absorb)),
      );
      else parts.push(absorb('floor'));
    }
    parts.push(el('div', { class: 'border-t border-slate-800 pt-2 flex flex-wrap items-center gap-1.5', dataset: { help: 'space.reverb' } }, [
      el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-amber-300', text: t('space.reverbTitle') }),
      toggle('env.on', 'space.reverb', () => roomOf(getSpaceParams()).reverb.on, () => { editRoom((r) => { r.reverb.on = !r.reverb.on; }); commit(); }),
      room.reverb.on ? seg('space.reverbLaw', REVERB_LAWS.map((l) => [l, `space.reverbLaw.${l}`]), () => roomOf(getSpaceParams()).reverb.law, (v) => editRoom((r) => { r.reverb.law = v; })) : null,
    ]));
    if (room.reverb.on) parts.push(
      el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
        slider('space.reverbRt60', 'space.reverb', vNum('rt60'), setV('rt60'), { min: 0.1, max: 12, step: 0.05, unit: 's', def: 1.8 }),
        slider('space.reverbLevel', 'space.reverb', vNum('level'), setV('level'), { min: 0, max: 2, step: 0.01, def: 0.25, accent: 'accent-emerald' }),
        slider('space.reverbPre', 'space.reverb', () => 1000 * num(roomOf(getSpaceParams()).reverb.predelay), (v, ck) => editRoom((r) => { r.reverb.predelay = v / 1000; }, ck), { min: 0, max: 500, step: 1, unit: 'ms', def: 20 }),
        slider('space.reverbDamp', 'space.reverb', vNum('damp'), setV('damp'), { min: 0, max: 1, step: 0.01, def: 0.5 }),
        slider('space.reverbSeed', 'space.reverb', vNum('seed'), (v, ck) => editRoom((r) => { r.reverb.seed = Math.round(v); }, ck), { min: 0, max: 99, step: 1, int: true, def: 1 }),
        slider('space.reverbSend', 'space.reverbLaw', () => num(getActiveSource()?.send ?? 1, 1), (v, ck) => editActive((s) => { s.send = v; }, ck), { min: 0, max: 4, step: 0.01, def: 1, accent: 'accent-emerald' }),
      ]),
    );
    parts.push(el('span', { class: 'text-[11px] text-slate-500', text: `${getSpaceDocTarget() === 'master' ? `${t('space.roomMasterNote')} ` : ''}${t('space.roomBakeLoss')}` }));
    return el('section', { class: SECTION, dataset: { rack: 'space-room' } }, parts);
  }

  // ------------------------------------------------------------------ output: user HRIR
  function buildHrirRow() {
    const HELP = 'space.hrir';
    const sets = listHrirSets();
    const cur = getSpaceParams().spatial.hrir || '';
    const options = [['', t('space.hrirBrowser')], ...sets.map((s) => [s.id, `${s.name} · ${s.count}`])];
    if (cur && !getHrirSet(cur)) options.push([cur, t('space.hrirMissing')]);
    const pick = select(HELP, options, () => getSpaceParams().spatial.hrir || '', (v) => editSpace((d) => { if (v) d.spatial.hrir = v; else delete d.spatial.hrir; }));
    const file = el('input', { type: 'file', accept: '.wav,audio/wav,.sofa', class: 'hidden' });
    file.multiple = true;
    file.addEventListener('change', async () => {
      const list = [...(file.files || [])];
      file.value = '';
      if (!list.length) return;
      const files = [];
      for (const f of list) files.push({ name: f.name, data: await f.arrayBuffer() });
      const common = list[0].name.replace(/\.[a-z0-9]+$/i, '');
      const r = await importHrirFiles(files, { name: list.length > 1 ? `HRIR ${list.length} · ${common.slice(0, 16)}` : common, ccw: hrirCcw });
      if (!r.ok) { hooks.showToast(t(`space.hrirFail.${r.reason || 'nodirs'}`), 'error'); return; }
      editSpace((d) => { d.spatial.hrir = r.id; });
      commit();
      hooks.showToast(`${t('space.hrirLoaded', r.count)}${r.skipped.length ? ` ${t('space.hrirSkipped', r.skipped.length)}` : ''}`);
    });
    const info = readout(HELP);
    syncers.push(() => {
      const id = getSpaceParams().spatial.hrir;
      const s = id ? getHrirSet(id) : null;
      info.textContent = !id ? '' : s ? t('space.hrirInfo', s.dirs.length, ((1000 * (s.L[0]?.length || 0)) / s.sampleRate).toFixed(1), s.sampleRate) : t('space.hrirMissingInfo');
      info.className = `font-mono text-[11px] ${!id || s ? 'text-slate-300' : 'text-rose-300'}`;
    });
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: HELP } }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t('space.hrir') }),
        pick,
        el('button', { class: BTN, text: `⇪ ${t('space.hrirLoad')}`, dataset: { help: HELP }, on: { click: () => file.click() } }),
        toggle('space.hrirCcw', HELP, () => hrirCcw, () => { hrirCcw = !hrirCcw; hooks.requestRender(['space']); }),
        file,
      ]),
      info,
    ]);
  }

  // ------------------------------------------------------------------ output: loudspeaker array
  const editArray = (fn, ck = null) => editSpace((d) => { d.spatial.array = arraySettings(d); fn(d.spatial.array, d); }, { coalesceKey: ck });
  function buildArrayBox() {
    const HELP = 'space.array';
    const a = arraySettings(getSpaceParams());
    const layout = getLayout(a.layout, a.custom);
    const custom = a.layout === 'custom';
    const info = readout(HELP);
    const device = readout('space.arrayDevice');
    syncers.push(() => {
      const p = getSpaceParams();
      const set = arraySetup(p);
      const q = arrayMetrics(set.dec);
      info.textContent = `${t('space.arrayInfo', set.dec.order, q.errMean.toFixed(1), q.errMax.toFixed(1), (q.energyMaxDb - q.energyMinDb).toFixed(2))}${set.dec.limited ? ` ${t('space.arrayLimited', set.dec.asked, set.dec.speakers.length)}` : ''}`;
      const ctx = getAudioCtx();
      const sup = arrayLiveSupport(ctx?.destination?.maxChannelCount ?? 2, set.channels);
      device.textContent = sup.ok ? t('space.arrayLive', sup.have, sup.need) : t('space.arrayMonitor', sup.have || 2, sup.need);
      device.className = `text-[11px] ${sup.ok ? 'text-emerald-300' : 'text-amber-300'}`;
    });
    const cell = (get, set, { min, max, step = 1, ph = '', w = 'w-12', off = false }) => {
      const box = el('input', { type: 'number', min, max, step, placeholder: ph, class: `${w} px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-slate-200 ${off ? 'opacity-40' : ''}`, dataset: { help: HELP } });
      box.disabled = off;
      box.addEventListener('change', () => { set(box.value === '' ? null : Number(box.value)); commit(); });
      syncers.push(() => { if (document.activeElement !== box) { const v = get(); box.value = v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : String(v); } });
      return box;
    };
    const head = (key) => el('span', { class: 'text-[10px] uppercase tracking-wider text-slate-500 text-right', text: t(key) });
    const rows = [];
    let k = 0; // index among the real loudspeakers (LFE not counted) / LFE를 뺀 스피커 번호
    layout.speakers.forEach((s, i) => {
      const idx = s.lfe ? -1 : k++;
      const setCustom = (field) => (v) => editArray((x) => { if (x.custom[i]) x.custom[i][field] = v ?? 0; });
      const per = (field) => (s.lfe ? () => null : () => arraySettings(getSpaceParams())[field][idx] ?? null);
      const setPer = (field) => (v) => editArray((x) => { while (x[field].length <= idx) x[field].push(null); x[field][idx] = v; });
      rows.push(
        el('span', { class: `font-mono text-[11px] ${s.lfe ? 'text-slate-500' : 'text-cyan-200'}`, text: `${i + 1} ${s.label}` }),
        cell(() => getLayout(arraySettings(getSpaceParams()).layout, arraySettings(getSpaceParams()).custom).speakers[i]?.az, setCustom('az'), { min: -180, max: 180, off: !custom || s.lfe }),
        cell(() => getLayout(arraySettings(getSpaceParams()).layout, arraySettings(getSpaceParams()).custom).speakers[i]?.el, setCustom('el'), { min: -90, max: 90, off: !custom || s.lfe }),
        cell(per('dist'), setPer('dist'), { min: 0.2, max: 100, step: 0.05, ph: String(s.dist), off: s.lfe }),
        cell(per('trimDb'), setPer('trimDb'), { min: -36, max: 12, step: 0.5, ph: '0', off: s.lfe }),
        cell(() => { const v = per('route')(); return v === null ? null : v + 1; }, (v) => setPer('route')(v === null ? null : Math.max(0, Math.round(v) - 1)), { min: 1, max: 64, ph: String(i + 1), off: s.lfe }),
      );
    });
    const addSpeaker = () => { editArray((x) => { if (x.custom.length < ARRAY_MAX_SPEAKERS) x.custom.push({ label: String(x.custom.length + 1), az: 0, el: 0, dist: 2, lfe: false }); }); commit(); };
    const dropSpeaker = () => { editArray((x) => { if (x.custom.length > 2) x.custom.pop(); }); commit(); };
    const test = () => { const r = playArrayTest(); hooks.showToast(r.ok ? t(r.live ? 'space.arrayTestLive' : 'space.arrayTestMonitor', r.count) : t('toast.noAudio'), r.ok ? 'info' : 'error'); };
    return el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: HELP } }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        el('h3', { class: 'text-[11px] font-bold uppercase tracking-wider text-cyan-300', text: t('space.arrayTitle') }),
        select(HELP, ARRAY_LAYOUTS.map((id) => [id, t(`space.arrayLayout.${id}`)]), () => arraySettings(getSpaceParams()).layout, (v) => editArray((x) => {
          // a custom table starts from the layout on screen / 사용자 표는 지금 배치에서 시작
          if (v === 'custom' && x.custom.length < 2) x.custom = getLayout(x.layout).speakers.map((s) => ({ ...s }));
          x.layout = v; x.route = []; x.trimDb = []; x.dist = [];
          // irregular rings: mode matching breaks down there (5.1: ±19 dB), AllRAD is the usable default / 불규칙 링은 AllRAD가 기본
          x.method = v === '5.1' || v === '7.1' ? 'allrad' : 'modematch';
        })),
        seg('space.arrayMethod', ARRAY_METHODS.map((m) => [m, `space.arrayMethod.${m}`]), () => arraySettings(getSpaceParams()).method, (v) => editArray((x) => { x.method = v; })),
        toggle('space.arrayEnergy', 'space.arrayMethod', () => arraySettings(getSpaceParams()).energyNorm, () => { editArray((x) => { x.energyNorm = !x.energyNorm; }); commit(); }),
      ]),
      info,
      device,
      el('div', { class: 'grid gap-x-1.5 gap-y-1 items-center', style: 'grid-template-columns: minmax(3.5rem, 1fr) repeat(5, auto);', dataset: { help: 'space.arrayTable' } }, [
        head('space.arrayCh'), head('space.arrayAz'), head('space.arrayEl'), head('space.arrayDist'), head('space.arrayTrim'), head('space.arrayRoute'),
        ...rows,
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        custom ? el('button', { class: BTN, text: `＋ ${t('space.arrayAdd')}`, dataset: { help: 'space.arrayTable' }, on: { click: addSpeaker } }) : null,
        custom ? el('button', { class: BTN, text: `− ${t('space.arrayDrop')}`, dataset: { help: 'space.arrayTable' }, on: { click: dropSpeaker } }) : null,
        el('button', { class: BTN, text: `♪ ${t('space.arrayTest')}`, dataset: { help: 'space.arrayTest' }, on: { click: test } }),
      ]),
      el('span', { class: 'text-[11px] text-slate-500', text: channelOrderText(layout) }),
    ]);
  }

  function buildLanesRack(src) {
    const COLORS = { gain: '#34d399', bright: '#fbbf24', timbre: '#f472b6', air: '#2dd4bf', dopplerAmt: '#a78bfa', width: '#22d3ee' };
    const rows = SOURCE_LANES.map((k) => {
      const lane = src.lanes[k];
      if (lane.on) return el('div', { class: 'border-t border-slate-800 pt-2', dataset: { help: `space.lane.${k}` } }, [envWindow(k, (s) => s.lanes[k], COLORS[k])]);
      return el('div', { class: 'flex items-center justify-between gap-2', dataset: { help: `space.lane.${k}` } }, [
        el('span', { class: 'text-[11px] text-slate-300', text: t(`space.lane.${k}`) }),
        el('button', { class: BTN, text: t('env.on'), dataset: { help: 'env.on' }, on: { click: () => { editActive((s) => { s.lanes[k].on = true; }); commit(); } } }),
      ]);
    });
    let timbreB = null;
    if (src.lanes.timbre.on) {
      const ed = createTimbreEditor({ get: () => getActiveSource()?.timbreB, edit: (fn, k) => editActive((s) => { fn(s.timbreB); }, k), sample: false, toast: (m) => hooks.showToast(m), idPrefix: 'space-timbreB' });
      syncers.push(ed.sync);
      timbreB = el('div', { class: 'min-w-0 border-t border-slate-800 pt-2', dataset: { help: 'space.timbreB' } }, [el('span', { class: 'text-[11px] font-semibold text-pink-300', text: t('space.timbreB') }), ed.root]);
    }
    return el('section', { class: SECTION, dataset: { rack: 'space-lanes' } }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-teal-300', text: t('space.lanesTitle'), dataset: { help: 'space.lanes' } }),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.lanesHint') }),
      ...rows,
      timbreB,
    ]);
  }

  function buildProfileRack(src) {
    const engines = PROFILE_ENGINES.map((e) => [e, getEngineLabel(e, { short: true })]);
    const curveCtl = (field, help) => el('div', { class: 'flex items-center gap-1.5' }, [
      labelled('space.profileEngine', select('space.profileEngine', engines, () => getActiveSource()?.[field].curve.engine || 'harmonic', (v) => editActive((s) => { s[field].curve = { engine: v, reverse: !!s[field].curve.reverse, inverse: false }; })), 'space.profileEngine'),
      toggle('space.reverse', help, () => !!getActiveSource()?.[field].curve.reverse, () => { editActive((s) => { s[field].curve.reverse = !s[field].curve.reverse; }); commit(); }),
    ]);
    const trackOpt = trackContext() || src.speed.mode === 'track' ? [['track', 'space.mode.track']] : []; // entered from the Manager / 매니저에서 들어온 경우
    const modeSeg = (field, help) => seg(help, [['const', 'space.mode.const'], ['curve', 'space.mode.curve'], ...(field === 'speed' ? [['rankine', 'space.mode.rankine'], ...trackOpt] : []), ['env', 'space.mode.env']], () => getActiveSource()?.[field].mode, (v) => editActive((s) => { s[field].mode = v; }));
    const SPD = { min: 0, max: 400, step: 0.5, unit: 'm/s', accent: 'accent-amber' };
    const HZ = { min: 20, max: 4000, step: 0.01, unit: 'Hz', accent: 'accent-emerald' };
    const speedBody = src.speed.mode === 'track'
      ? [
        slider('space.trackLaps', 'space.trackSync', () => trackLaps(getActiveSource()?.speed), (v, ck) => editActive((s) => { s.speed.laps = v; }, ck), { min: 0.05, max: 20, step: 0.05, unit: '×', accent: 'accent-amber', def: 1 }),
        (() => {
          const info = readout('space.trackSync');
          syncers.push(() => {
            const p = getSpaceParams();
            const s = getActiveSource(p);
            if (!s || s.speed.mode !== 'track') return;
            const ctx = trackContext();
            const L = pathLength(s, p.listener) * trackLaps(s.speed);
            const D = Math.max(0.05, num(s.duration));
            const v = roundTo(L / D, 2);
            info.textContent = ctx?.sec ? t('space.trackInfo', roundTo(ctx.sec, 2), roundTo(L, 1), roundTo(D, 2), v) : t(ctx ? 'space.trackAuto' : 'space.trackNoManager', roundTo(L, 1), roundTo(D, 2), v);
          });
          return info;
        })(),
      ]
      : src.speed.mode === 'env'
      ? [el('div', { dataset: { help: 'space.speedEnv' } }, [envWindow('speed', (s) => s.speed.env, '#fbbf24', { toggle: false, speedLane: true })])]
      : src.speed.mode === 'curve'
      ? [el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [slider('space.from', 'space.speedCurve', srcNum('speed.from'), setSrcNum('speed.from'), SPD), slider('space.to', 'space.speedCurve', srcNum('speed.to'), setSrcNum('speed.to'), SPD)]), curveCtl('speed', 'space.speedCurve')]
      : src.speed.mode === 'rankine'
        ? [
          el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [
            slider('space.gamma', 'space.rankine', srcNum('speed.gamma'), setSrcNum('speed.gamma'), { min: 0, max: 20000, step: 10, unit: 'm²/s', accent: 'accent-amber' }),
            slider('space.core', 'space.rankine', srcNum('speed.core'), setSrcNum('speed.core'), { min: 0.5, max: 200, step: 0.5, unit: 'm', accent: 'accent-amber' }),
          ]),
          (() => {
            const info = readout('space.rankine');
            syncers.push(() => {
              const s = getActiveSource();
              if (!s) return;
              info.textContent = s.path.type === 'orbit'
                ? t('space.rankineInfo', roundTo(rankineSpeed(Math.sqrt(s.path.rx * s.path.ry), s.speed.gamma, s.speed.core), 2), roundTo(rankineSpeed(Math.sqrt(s.path.rx * s.path.ry), s.speed.gamma, s.speed.core) / Math.sqrt(s.path.rx * s.path.ry), 3))
                : t('space.rankineNeedsOrbit');
            });
            return info;
          })(),
        ]
        : [slider('space.speedValue', 'space.speed', srcNum('speed.value'), setSrcNum('speed.value'), SPD)];
    const pitchBody = src.input.kind === 'import'
      ? [el('span', { class: 'text-[11px] text-slate-500', text: t('space.importNoPitch') })]
      : src.f.mode === 'env'
      ? [el('div', { dataset: { help: 'space.pitchEnv' } }, [envWindow('pitch', (s) => s.f.env, '#34d399', { toggle: false })])]
      : src.f.mode === 'curve'
      ? [el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1' }, [slider('space.hz0', 'space.pitchCurve', srcNum('f.hz0'), setSrcNum('f.hz0'), HZ), slider('space.hz1', 'space.pitchCurve', srcNum('f.hz1'), setSrcNum('f.hz1'), HZ)]), curveCtl('f', 'space.pitchCurve')]
      : [slider('space.hz', 'space.pitch', srcNum('f.hz'), setSrcNum('f.hz'), HZ)];
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('space.speedTitle') }), modeSeg('speed', 'space.speed')]),
      ...speedBody,
      el('div', { class: 'border-t border-slate-800 pt-2 flex items-center justify-between gap-2' }, [el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('space.pitchTitle') }), modeSeg('f', 'space.pitch')]),
      ...pitchBody,
    ]);
  }

  function buildEffectsRack() {
    const flag = (k) => toggle(`space.fx.${k}`, `space.${k}`, () => getActiveSource()?.[k] !== false, () => { editActive((s) => { s[k] = s[k] === false; }); commit(); });
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getActiveSource()?.timbre, edit: (fn, k) => editActive((s) => { fn(s.timbre); }, k), sample: true, toast: (m) => hooks.showToast(m), idPrefix: 'space-timbre' });
    syncers.push(timbreEd.sync);
    const timbre = el('div', { class: 'min-w-0', dataset: { help: 'space.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-rose-300', text: t('space.fxTitle') }),
      el('div', { class: 'flex flex-wrap gap-1.5' }, ['doppler', 'distanceGain', 'airAbsorb', 'pan'].map(flag)),
      el('span', { class: 'text-[11px] text-slate-500', text: t('space.fxHint') }),
      slider('space.baseGain', 'space.baseGain', srcNum('baseGain'), setSrcNum('baseGain'), { min: 0, max: 1.5, step: 0.01, accent: 'accent-emerald' }),
      timbre,
      el('span', { class: 'text-[11px] text-slate-500', dataset: { help: 'space.bakeLoss' }, text: `${t('space.bakeLoss')} ${t('space.bakeLossExt')}` }),
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    if (getSpaceDocTarget() === 'master') syncMaster();
    const params = getSpaceParams();
    const src = getActiveSource(params);
    syncers = [];
    canvases?.destroy();
    extraViews?.destroy();
    extraViews = null;
    for (const w of envs) w.destroy();
    envs = [];
    if (!src) { // Space Master with no Manager tracks yet / 매니저 트랙이 아직 없는 마스터
      canvases = null;
      root.replaceChildren(buildHeader(params), el('section', { class: SECTION }, [el('span', { class: 'text-[11px] text-slate-400', text: t('space.masterNoTracks') })]));
      return;
    }
    root.replaceChildren(
      buildHeader(params),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildMediumRack(), buildOutputRack(), buildRoomRack(), buildSoundRack(src), buildPathRack(src), ((r) => { xfRack = r; return r; })(buildPathXfRack(src)), buildProfileRack(src), buildLanesRack(src), buildEffectsRack(), ((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getSpaceParams, edit: editSpace }))]),
      ]),
    );
  }

  function structureKey() {
    const p = getSpaceParams();
    const s = getActiveSource(p);
    const lk = s?.path.link;
    const endKey = s?.path.type === 'spline' ? s.path.spline.end : '';
    const ar = p.panMode === 'array' ? arraySettings(p) : null;
    const rm = p.room ? roomOf(p) : null;
    return [getLang(), getSpaceDocTarget(), p.activeSourceId, endKey, p.cEnv?.on ? 'c' : '', rm ? `${rm.quality}:${rm.reverb.on ? 1 : 0}` : '', p.panMode, ar ? `${ar.layout}:${ar.custom.length}:${ar.custom.map((x) => (x.lfe ? 1 : 0)).join('')}` : '', isHoaMode(p.panMode) ? `${p.spatial.hrir || ''}|${listHrirSets().map((x) => x.id).join(',')}` : '', linkStudio, linkStudio && !lk ? listCurves(linkStudio).map((c) => c.key).join(',') : '', xfStudio, !lk ? listCurves(xfStudio).map((c) => c.key).join(',') : '', s?.path.type === 'spline' ? 'S' : '', lk ? [lk.studio, lk.key, lk.map?.fit].join(':') : '', s?.group ? `${s.group.lead || 'own'}:${s.group.frame}` : '', p.sources.map((x) => x.group?.lead || '').join(','), s?.input.kind === 'import' ? baseTarget(s.input.target) : '', s?.path.type, s?.path.hEnv?.on ? 'h' : '', s?.speed.mode, s?.f.mode, p.view3d.layout, SOURCE_LANES.map((k) => (s?.lanes?.[k]?.on ? 1 : 0)).join(''), s?.input.kind, s?.input.frozen ? 'f' : '', p.listener.move.on ? 'm' : '', trackContext() ? 'T' : '', p.listener.orient.mode, nodeEditor.target(), s?.timeMode, s?.input.kind === 'import' ? listInstanceTargets().map((x) => `${x.target}:${x.name}`).join(',') : '', p.sources.map((x) => `${x.id}:${x.name}:${x.color}`).join(',')].join('|');
  }

  return {
    render() {
      if (getSpaceDocTarget() === 'master' && syncMaster()) return; // the sync dispatches a render of its own / 동기화가 다시 렌더를 부름
      // Curve links: paths that follow a curve of another studio (space-curve-link.js) / 다른 스튜디오 곡선을 따르는 경로
      if (linkSyncs < 3 && curveLinksStale(getSpaceParams())) { linkSyncs++; editSpace((d) => { updateCurveLinks(d); }, { history: false }); hooks.requestRender(['space']); return; }
      linkSyncs = 0;
      if (trackSyncs < 3 && syncTrackSpeed()) { trackSyncs++; hooks.requestRender(['space']); return; }
      trackSyncs = 0;
      refreshSpaceMaster();
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      canvases?.render();
      extraViews?.render();
      timeline?.render();
      refreshSpaceAudio();
    },
    fit: fitView,
    // Delete / Backspace (ui/studio-host.js): selected spline nodes first, otherwise the source
    // 선택된 스플라인 노드가 있으면 노드를, 없으면 음원을 삭제
    deleteSelection: () => { if (!nodeEditor.deleteSelection()) deleteActiveSource(); },
    destroy() {
      canvases?.destroy();
      canvases = null;
      extraViews?.destroy();
      extraViews = null;
      for (const w of envs) w.destroy();
      envs = [];
      offImport();
      offHrir();
      offPre();
      timeline?.destroy();
      timeline = null;
      root.replaceChildren();
      key = '';
    },
  };
}
