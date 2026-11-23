/**
 * Flexatone — studios/risset/risset-panels.js
 * Risset Studio UI tier (added file): workspace DOM + canvases (phase trails, offset grid, looping
 * automation, PEQ response, S¹ ring). Mounted by ui/studio-host.js.
 * 리세 스튜디오 UI 계층 (추가 파일): 작업 공간 DOM과 캔버스 5종.
 *
 * Automation canvas (spline utils from core/math-utils.js, same as 11. Custom):
 *   drag a point (time ↔ value) · double-click adds a point · drag a segment bends it ·
 *   right-click (two-finger click) deletes a point · “Reset Curve” button.
 * Parameter-select mode: turn it on, then touch any control marked data-auto-key — it becomes the
 * active automation target (lane added and enabled). / 선택 모드: 컨트롤을 건드리면 대상 지정.
 * Region modules (space-regions.js): each module limits the field to a pitch range, can run at its
 * own speed and rotates its trail space about the green line. Shift-drag on the trail canvas sets
 * the active module's range. / 영역 모듈: Shift-드래그로 활성 모듈 범위 지정.
 */

import { clamp, roundTo, findSplineSegmentIndex, splitSplineSegmentPreservingShape, elevateSplineSegmentHandles, removeSplinePoint, evalPiecewiseBezierPoints, getSegmentControlArrays, solveSegmentParamS } from '../../core/math-utils.js';
import { midiToFreq, midiToNoteName } from '../../core/units.js';
import { t, getLang, I18N } from '../../core/i18n.js';
import { REGION_OWN_KEYS, evenOffsets } from './risset-core.js';
import { normalizeVoiceMod, VMOD_RATE_MIN, VMOD_RATE_MAX, VMOD_CENTS_MAX, VMOD_TRACK_MAX } from '../../core/voice-mod.js';
import { HELP_DB as VMOD_HELP_DB } from '../../ui/option-inspector.js';
import { endHistoryGesture } from '../../core/state.js';
import { getEngineLabel } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, setToggle } from '../../ui/panels.js';
import { createTremoloHost } from '../../ui/tremolo-panel.js';
import { normalizeTremolo } from '../../core/tremolo-config.js';
import { RISSET_ID, getRissetParams, editRisset as editRissetDoc } from '../risset-studio.js';
import { MAX_VOICES, MIN_VOICES, SHAPE_KINDS, SHAPE_ENGINES, voiceColor, computeVoicePhase, envOf, voiceAmplitude, phaseToMidi, shapedTime, regionPhiFn, relOffsets, BASE_MIDI_RANGE, SPAN_RANGE } from './risset-core.js';
import { DYN_ORDERS, isDynamicsOn, dynHistoryAt, kineticEnergy } from './dynamics.js';
import { COLOR_TARGETS, COLOR_ACTUATORS, COLOR_HISTORY } from './color-analysis.js';
import { MAX_REGIONS, REGION_COLORS, createDefaultRegion, screenToSpace, spaceToScreen, edgeFade, regionCenter, formatAngle } from './space-regions.js';
import { GRID_MODES, GRID_PRESETS, RATIO_PRESETS, parseRatioSeq, formatCents, formatClean, absPitchName, offsetsToIntervalText, offsetsToPitchText, parseIntervalSeq, parsePitchSeq, parsePitchToken, normalizePatternText, presetPatch, OFFSET_MIN, OFFSET_MAX } from './harmony-grid.js';
import { LOCAL_MODES, FADE_DISTS, MIN_M0 } from './local-particles.js';
import { ENV_SHAPES, EQ_PRESETS, MAX_EQ_NODES, createBellNode, evalGlobalEnvelope, eqChainResponseDb, EQ_LIMITS } from './peq-envelope.js';
import { AUTOMATABLE_PARAMS, getAutomatableSpec, createLane, createFlatLane, evalLane, loopPosition, nearestAnchor } from './loop-automation.js';
import { getRissetRuntime, startRissetLoop, stopRissetLoop, setPhaseScrubbing, resetRissetPhase, exportRissetWav, rissetEngineKind, restartRissetAudio, rissetSyncR } from './risset-audio.js';
import { sizeCanvas2d } from '../../ui/canvas-size.js';
import { setSliderDefault, probeStudioDefault } from '../../ui/slider-reset.js';

const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
const BTN = 'px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 transition';
const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const fmtHz = (hz) => (hz < 20 ? `${hz.toFixed(hz < 2 ? 2 : 1)} Hz` : hz < 1000 ? `${hz.toFixed(0)} Hz` : `${(hz / 1000).toFixed(2)} kHz`);
/** Frequency zone of the rhythm ↔ tone continuum. / 연속체 구간 */
const zoneOf = (hz) => (hz < 12 ? 'rhythm' : hz <= 30 ? 'flutter' : 'tone');


// Per-voice tremolo / vibrato texts (core/voice-mod.js) / 보이스별 트레몰로·비브라토 문구
const VMOD_TEXT = {
  en: {
    'risset.vmod.title': 'Voice tremolo · vibrato',
    'risset.vmod.hint': 'Every voice gets its own rate, depth and phase (seeded randomizer). Band follow makes the rate follow where the voice is in the frequency band.',
    'risset.vmod.trem': 'Tremolo',
    'risset.vmod.vib': 'Vibrato',
    'risset.vmod.rate': 'Rate',
    'risset.vmod.depth': 'Depth',
    'risset.vmod.cents': 'Depth',
    'risset.vmod.spread': 'Randomize',
    'risset.vmod.track': 'Band follow',
    'risset.vmod.seed': 'Seed',
    'risset.vmod.reroll': '🎲 New random',
  },
  ko: {
    'risset.vmod.title': '보이스 트레몰로 · 비브라토',
    'risset.vmod.hint': '보이스마다 속도·깊이·위상이 다릅니다(시드 랜덤). 대역 추종을 올리면 속도가 그 보이스의 주파수 대역 위치를 따라갑니다.',
    'risset.vmod.trem': '트레몰로',
    'risset.vmod.vib': '비브라토',
    'risset.vmod.rate': '속도',
    'risset.vmod.depth': '깊이',
    'risset.vmod.cents': '깊이',
    'risset.vmod.spread': '랜덤화',
    'risset.vmod.track': '대역 추종',
    'risset.vmod.seed': '시드',
    'risset.vmod.reroll': '🎲 새 랜덤',
  },
};
Object.assign(VMOD_TEXT.en, {
  'risset.regionScope': 'Region scope',
  'risset.scopeRegion': (m) => `Toolboxes edit ${m}`,
  'risset.scopeAll': 'Edit all regions',
  'risset.scopeBanner': 'Toolboxes act on this region: Glissando rate (its own speed), voices, envelope, trajectory shape.',
  'risset.scopeShared': 'Shared by all regions: pitch range, timbre, color, local particles, dynamics, tremolo.',
  'risset.regionSpeedNote': (v) => `Speed: Core ▸ Glissando rate (${v})`,
  'risset.regionSpeedLinked': 'linked to global',
  'risset.regionOwn': 'Own',
  'risset.regionOwnNone': 'Uses the global settings',
  'risset.regionOwnReset': '↺ Use global',
  'risset.ownKey.voiceCount': 'voices', 'risset.ownKey.globalEnvEnabled': 'env on', 'risset.ownKey.envShape': 'env shape', 'risset.ownKey.envCenter': 'env c', 'risset.ownKey.envWidth': 'env σ', 'risset.ownKey.envSkew': 'env skew', 'risset.ownKey.envGamma': 'env γ',
  'risset.ownKey.shapeKind': 'shape', 'risset.ownKey.shapePeriodSec': 'shape period', 'risset.ownKey.shapeAmount': 'shape amount', 'risset.ownKey.shapePower': 'shape power',
});
Object.assign(VMOD_TEXT.ko, {
  'risset.regionScope': '영역 범위',
  'risset.scopeRegion': (m) => `툴박스 → ${m} 편집`,
  'risset.scopeAll': '모든 영역 편집',
  'risset.scopeBanner': '툴박스가 이 영역에 작동합니다: 글리산도 속도(영역 자체 속도), 보이스 수, 포락선, 궤적 셰이프.',
  'risset.scopeShared': '모든 영역 공유: 음고 범위, 음색, 색채, 로컬 입자, 동역학, 트레몰로.',
  'risset.regionSpeedNote': (v) => `속도: 코어 ▸ 글리산도 속도 (${v})`,
  'risset.regionSpeedLinked': '전역에 연동',
  'risset.regionOwn': '자체 값',
  'risset.regionOwnNone': '전역 설정 사용',
  'risset.regionOwnReset': '↺ 전역 사용',
  'risset.ownKey.voiceCount': '보이스 수', 'risset.ownKey.globalEnvEnabled': '포락선 켜기', 'risset.ownKey.envShape': '포락선 모양', 'risset.ownKey.envCenter': '포락선 c', 'risset.ownKey.envWidth': '포락선 σ', 'risset.ownKey.envSkew': '포락선 기울기', 'risset.ownKey.envGamma': '포락선 γ',
  'risset.ownKey.shapeKind': '셰이프', 'risset.ownKey.shapePeriodSec': '셰이프 주기', 'risset.ownKey.shapeAmount': '셰이프 양', 'risset.ownKey.shapePower': '셰이프 지수',
});
Object.assign(I18N.en, VMOD_TEXT.en);
Object.assign(I18N.ko, VMOD_TEXT.ko);
const vh = (en, ko) => ({ en: { title: en[0], summary: en[1], detail: en[2] || '', formula: en[3] || '' }, ko: { title: ko[0], summary: ko[1], detail: ko[2] || '', formula: en[3] || '' } });
Object.assign(VMOD_HELP_DB, {
  'risset.vmod': vh(['Voice tremolo · vibrato', 'Amplitude (tremolo) and pitch (vibrato) modulation applied to every voice separately, inside the voice bank — each voice with its own rate, depth and phase.', 'Unlike the output tremolo below (one LFO on the whole sound), this one is per voice, so the field shimmers instead of pulsing as a block. Heard live (AudioWorklet engine) and in WAV export.'], ['보이스 트레몰로 · 비브라토', '보이스마다 따로 거는 진폭(트레몰로)·음고(비브라토) 변조. 보이스 뱅크 안에서 보이스별 속도·깊이·위상으로 적용됩니다.', '아래 출력 트레몰로(전체에 LFO 하나)와 달리 보이스별이라, 덩어리로 맥동하지 않고 반짝이듯 흔들립니다. 실시간(AudioWorklet 엔진)과 WAV 내보내기에 적용.']),
  'risset.vmod.tremRate': vh(['Tremolo rate (Hz)', 'Base speed of the per-voice tremolo. Each voice plays it ×2^(Randomize·u) and ×2^(Band follow·(2b−1)).', 'u = the voice\'s own random number (−1…1), b = its place in the frequency band (0 = bottom, 1 = top).', 'rateᵢ = rate · 2^(spread·u) · 2^(track·(2b−1))'], ['트레몰로 속도 (Hz)', '보이스별 트레몰로의 기본 속도. 각 보이스는 ×2^(랜덤화·u), ×2^(대역 추종·(2b−1))로 연주합니다.', 'u = 보이스 고유 난수(−1…1), b = 주파수 대역 안의 위치(0 = 아래, 1 = 위).']),
  'risset.vmod.tremDepth': vh(['Tremolo depth', 'How far the level dips: gain moves between 1 − depth and 1 (never boosts, cannot clip).', 'Randomize lowers the depth of some voices by up to 50 %.', 'g = 1 − depthᵢ·(½ − ½·cos 2π(φ + phaseᵢ))'], ['트레몰로 깊이', '레벨이 내려가는 정도: 이득이 1 − 깊이 ~ 1 사이를 오갑니다(증폭 없음, 클리핑 없음).', '랜덤화는 일부 보이스의 깊이를 최대 50 %까지 줄입니다.']),
  'risset.vmod.tremSpread': vh(['Tremolo randomize', '0 = every voice identical (in phase). 1 = rates spread ±1 octave, phases fully scattered, depths −0…50 %.', 'Seeded: the same seed gives the same voices every time; 🎲 picks a new seed.'], ['트레몰로 랜덤화', '0 = 모든 보이스 동일(같은 위상). 1 = 속도 ±1옥타브, 위상 완전 분산, 깊이 −0…50 %.', '시드 고정: 같은 시드면 항상 같은 결과, 🎲는 새 시드.']),
  'risset.vmod.tremTrack': vh(['Tremolo band follow (oct)', 'Rate follows the frequency band: + = higher voices faster, − = lower voices faster, by up to ±this many octaves from bottom to top.', 'This is the automation by frequency band. A looping (time) automation cannot do it: at any moment every voice is at a different place in the band.'], ['트레몰로 대역 추종 (옥타브)', '속도가 주파수 대역을 따라감: + = 높은 보이스가 빠르게, − = 낮은 보이스가 빠르게 (아래→위로 최대 ±이 옥타브).', '주파수 대역에 따른 오토메이션입니다. 루핑(시간) 오토메이션으로는 불가능 — 같은 순간에 보이스마다 대역 위치가 다르기 때문.']),
  'risset.vmod.vibRate': vh(['Vibrato rate (Hz)', 'Base speed of the per-voice vibrato; randomized and band-followed like the tremolo rate.', '', 'rateᵢ = rate · 2^(spread·u) · 2^(track·(2b−1))'], ['비브라토 속도 (Hz)', '보이스별 비브라토의 기본 속도. 트레몰로 속도처럼 랜덤화·대역 추종이 적용됩니다.']),
  'risset.vmod.vibCents': vh(['Vibrato depth (cents)', 'Pitch swing above and below the voice\'s pitch, in cents (100 = one semitone).', 'Randomize lowers some voices\' depth by up to 50 %.', 'Δ = centsᵢ/100 · sin 2π(φ + phaseᵢ) semitones'], ['비브라토 깊이 (센트)', '보이스 음고 위아래로 흔들리는 폭(센트, 100 = 반음).', '랜덤화는 일부 보이스의 깊이를 최대 50 %까지 줄입니다.']),
  'risset.vmod.vibSpread': vh(['Vibrato randomize', '0 = all voices vibrate together. 1 = rates ±1 octave, phases scattered — a chorus-like spread.', ''], ['비브라토 랜덤화', '0 = 모든 보이스가 함께 떨림. 1 = 속도 ±1옥타브, 위상 분산 — 코러스 같은 퍼짐.']),
  'risset.vmod.vibTrack': vh(['Vibrato band follow (oct)', 'Vibrato rate follows the frequency band: + = higher voices faster.', ''], ['비브라토 대역 추종 (옥타브)', '비브라토 속도가 주파수 대역을 따라감: + = 높은 보이스가 빠르게.']),
  'risset.regionScope': vh(['Region scope (toolboxes → selected region)', 'With two or more region modules, the toolboxes act on the selected region (M1…M6). It keeps its own Glissando rate (= its speed), voice count, envelope and trajectory shape; the list shows which values it owns.', '↺ Use global drops its own values and links its speed again. 🌐 Edit all regions makes the toolboxes edit the shared settings. Pitch range, timbre, color, local particles, dynamics and tremolo are always shared. The former "own speed" slider of this box is the Core Glissando rate now (the same value).'], ['영역 범위 (툴박스 → 선택 영역)', '영역 모듈이 2개 이상이면 툴박스가 선택된 영역(M1…M6)에 작동합니다. 영역은 자체 글리산도 속도(= 속도), 보이스 수, 포락선, 궤적 셰이프를 가지며, 목록에 자체 값이 표시됩니다.', '↺ 전역 사용 = 자체 값을 지우고 속도를 다시 연동. 🌐 모든 영역 편집 = 툴박스가 공유 설정을 편집. 음고 범위·음색·색채·로컬 입자·동역학·트레몰로는 항상 공유. 이 상자의 예전 "자체 속도" 슬라이더는 이제 코어의 글리산도 속도입니다(같은 값).']),
  'risset.vmod.seed': vh(['Randomizer seed', 'Which random set of voice rates / depths / phases is used. 🎲 New random picks another.', ''], ['랜덤 시드', '보이스별 속도·깊이·위상의 어떤 난수 세트를 쓸지. 🎲 새 랜덤으로 다른 세트.']),
});

/** Mount the Risset workspace. / 리세 작업 공간 마운트 */
export function mountRissetWorkspace(root, hooks) {
  let syncers = [];
  let frameSyncers = [];
  let key = '';
  let selectParamMode = false;
  const cv = {};
  const commit = () => endHistoryGesture();
  // ---------------------------------------------------------------- region scope / 영역 범위
  // With two or more region modules, every toolbox acts on the selected region: the fields a region can
  // own (REGION_OWN_KEYS) are read from / written to region.own, the Glissando rate is the region's own
  // speed (rateHz + linkRate), everything else stays shared. "Edit all regions" switches back.
  // 영역 모듈이 2개 이상이면 모든 툴박스가 선택된 영역에 작동: 영역이 가질 수 있는 필드는 region.own에서 읽고 쓰며,
  // 글리산도 속도 = 영역 자체 속도(rateHz + linkRate), 나머지는 공유. "모든 영역 편집"으로 되돌림.
  const OWN = new Set(REGION_OWN_KEYS);
  let scopeOn = true;
  const scoped = () => scopeOn && getRissetParams().regions.length >= 2;
  const activeOf = (p) => p.regions[p.activeRegion] || p.regions[0];
  const regionView = (p) => {
    const r = activeOf(p);
    const q = { ...p, ...(r.own || {}) };
    if (r.own && 'voiceCount' in r.own && r.own.voiceCount !== p.voiceCount) q.offsets = evenOffsets(q);
    q.rateHz = r.linkRate ? p.rateHz : r.rateHz;
    return q;
  };
  const P = () => (scoped() ? regionView(getRissetParams()) : getRissetParams());
  const editRisset = (fn, opts) => {
    if (!scoped()) return editRissetDoc(fn, opts);
    return editRissetDoc((d) => {
      const r = d.regions[d.activeRegion] || d.regions[0];
      const px = new Proxy(d, {
        get(tgt, k) {
          if (k === 'rateHz') return r.linkRate ? tgt.rateHz : r.rateHz;
          if (OWN.has(k) && r.own && k in r.own) return r.own[k];
          return tgt[k];
        },
        set(tgt, k, v) {
          if (k === 'rateHz') { r.linkRate = false; r.rateHz = clamp(Number(v) || 0, -1, 1); return true; }
          if (k === 'lastNonZeroRate') return true; // the freeze memory stays global / 정지 기억은 전역
          if (OWN.has(k)) { r.own = { ...(r.own || {}), [k]: v }; return true; }
          tgt[k] = v;
          return true;
        },
      });
      return fn(px);
    }, opts);
  };
  const set = (k) => (val, ck) => editRisset((d) => { d[k] = val; }, { coalesceKey: ck });

  // ---------------------------------------------------------------- controls
  function slider(labelKey, help, get, onSet, { min, max, step, autoKey, accent = '', unit = '' }) {
    const number = el('input', { type: 'number', min, max, step, class: 'w-[4.5rem] px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: autoKey ? { autoKey } : undefined });
    const range = el('input', { type: 'range', min, max, step, class: `w-full ${accent}`, dataset: autoKey ? { autoKey } : undefined });
    setSliderDefault(range, () => probeStudioDefault(get, RISSET_ID)); // double-click → default / 더블클릭 → 기본값
    const ck = `risset:${labelKey}`;
    range.addEventListener('input', () => { number.value = range.value; onSet(Number(range.value), ck); });
    range.addEventListener('change', commit);
    number.addEventListener('input', () => { if (number.dataset.scrubbing) onSet(clamp(num(number.value, get()), min, max), ck); });
    number.addEventListener('change', () => { onSet(clamp(num(number.value, get()), min, max), number.dataset.scrubbing ? ck : null); commit(); });
    syncers.push(() => {
      const v = get();
      if (document.activeElement !== range) range.value = String(v);
      if (document.activeElement !== number) number.value = String(roundTo(v, 4));
    });
    return el('div', { class: 'flex flex-col gap-0.5', dataset: { help } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [el('span', { class: 'text-[11px] text-slate-300 truncate', text: `${t(labelKey)}${unit ? ` (${unit})` : ''}` }), number]),
      range,
    ]);
  }
  function seg(values, labelPrefix, get, onPick, color = 'sky', help) {
    return el('div', { class: 'flex flex-wrap gap-0.5 rounded-lg bg-slate-950 border border-slate-800 p-0.5', dataset: help ? { help } : undefined }, values.map((v) => {
      const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px]', text: t(`${labelPrefix}.${v}`), on: { click: () => { onPick(v); commit(); } } });
      syncers.push(() => { const on = get() === v; b.className = `px-2 py-0.5 rounded text-[11px] transition ${on ? `bg-${color}-600 text-white font-semibold` : 'text-slate-400 hover:text-white'}`; });
      return b;
    }));
  }
  const presetBtns = (items) => el('div', { class: 'flex flex-wrap gap-1' }, items.map(([label, fn, help]) => el('button', { class: `${BTN} font-mono`, text: label, dataset: help ? { help } : undefined, on: { click: () => { fn(); commit(); } } })));
  const textInput = (cls = '') => {
    const i = el('input', { type: 'text', spellcheck: false, class: `min-w-0 flex-1 px-2 py-1 rounded bg-slate-950 border border-slate-700 font-mono text-[11px] ${cls}` });
    i.addEventListener('keydown', (e) => e.stopPropagation());
    return i;
  };

  // ---------------------------------------------------------------- header strip
  function buildHeader() {
    const stats = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' });
    const ring = el('canvas', { class: 'w-[76px] h-[76px] shrink-0', dataset: { help: 'risset.phase' } });
    cv.ring = ring;
    frameSyncers.push((rt) => {
      const p = P();
      const { u, loopSec } = loopPosition(rt.autoTimeSec, p.autoLoopSec);
      const reg = p.regions[p.activeRegion];
      const regSt = reg && rt.regionStates[reg.id];
      const rotTxt = rt.classic ? '' : ` · M${p.activeRegion + 1} θ ${formatAngle(regSt?.angleDeg ?? 0)} · ♪ ${rt.slots.filter((sl) => sl.active).length}`;
      stats.textContent = `φ ${rt.masterPhase.toFixed(3)}${rotTxt} · v ${rt.eff.rateHz >= 0 ? '+' : ''}${rt.eff.rateHz.toFixed(3)} Hz · N ${p.voiceCount}/${MAX_VOICES} · 1/√N ${(1 / Math.sqrt(p.voiceCount)).toFixed(3)} · c ${rt.eff.envCenter.toFixed(2)} σ ${rt.eff.envWidth.toFixed(2)} · ⏱ ${(u * loopSec).toFixed(2)}/${loopSec.toFixed(1)}s`;
    });
    const freeze = el('button', { class: BTN, dataset: { help: 'risset.rate' }, on: { click: () => { editRisset((d) => { if (Math.abs(d.rateHz) > 1e-5) { d.lastNonZeroRate = d.rateHz; d.rateHz = 0; } else d.rateHz = d.lastNonZeroRate || 0.03; }); commit(); } } });
    syncers.push(() => { freeze.textContent = Math.abs(P().rateHz) < 1e-5 ? `▶ ${t('risset.unfreeze')}` : `❄ ${t('risset.freeze')}`; });
    const bake = (mode) => {
      const r = StudioRegistry.bakeVoices(RISSET_ID, { mode });
      hooks.showToast(t('risset.baked', r?.result?.length ?? 0));
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex items-center gap-3' }, [ring, el('div', { class: 'flex flex-col gap-1' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('risset.title') }),
          el('span', { class: 'text-[11px] text-slate-400', text: t('risset.subtitle') }),
          stats,
        ])]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          (() => {
            const tag = el('span', { class: 'font-mono text-[10px] text-slate-400', dataset: { help: 'risset.engine' } });
            frameSyncers.push(() => {
              const k = rissetEngineKind();
              tag.textContent = k ? `● ${t(`risset.engineKind.${k}`)}` : '○';
              tag.className = `font-mono text-[10px] ${k === 'worklet' ? 'text-emerald-300' : k ? 'text-amber-300' : 'text-slate-500'}`;
            });
            return el('div', { class: 'flex items-center gap-1', dataset: { help: 'risset.engine' } }, [
              seg(['auto', 'oscillators'], 'risset.engineMode', () => P().engineMode, (v) => { editRisset((d) => { d.engineMode = v; }); restartRissetAudio(); }, 'emerald', 'risset.engine'),
              tag,
            ]);
          })(),
          freeze,
          el('button', { class: BTN, text: `⟲ ${t('risset.resetPhase')}`, dataset: { help: 'risset.resetPhase' }, on: { click: () => resetRissetPhase() } }),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-400', dataset: { help: 'risset.bake' } }, [t('risset.bakeSec'), (() => {
            const i = el('input', { type: 'number', min: 1, max: 60, step: 0.5, class: 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
            i.addEventListener('change', () => { editRisset((d) => { d.bakeSec = clamp(num(i.value, 8), 1, 60); }); commit(); });
            syncers.push(() => { if (document.activeElement !== i) i.value = String(P().bakeSec); });
            return i;
          })()]),
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('field.bakeGliss')}`, dataset: { help: 'risset.bake' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('field.bakeAppend'), dataset: { help: 'risset.bake' }, on: { click: () => bake('append') } }),
          el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-400', dataset: { help: 'risset.exportSec' } }, [t('risset.exportSec'), (() => {
            const i = el('input', { type: 'number', min: 1, max: 180, step: 1, class: 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
            i.addEventListener('change', () => { editRisset((d) => { d.exportSec = clamp(num(i.value, 15), 1, 180); }); commit(); });
            syncers.push(() => { if (document.activeElement !== i) i.value = String(P().exportSec); });
            return i;
          })()]),
        ]),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- main canvas (trails)
  function buildMain() {
    const c = el('canvas', { class: 'w-full h-[380px] rounded-lg bg-slate-950 block cursor-ew-resize', dataset: { help: 'risset.canvas' } });
    cv.main = c;
    const hud = el('span', { class: 'font-mono text-[11px] text-slate-400', text: '—' });
    let scrub = null;
    let rangeDrag = null;
    const phaseAtY = (e) => {
      const r = c.getBoundingClientRect();
      const plotH = Math.max(20, r.height - 14 - 20);
      return clamp(1 - (e.clientY - r.top - 14) / plotH, 0, 1);
    };
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey) {
        // Shift-drag: set the active module's pitch range / Shift-드래그: 활성 모듈 범위
        rangeDrag = { p0: phaseAtY(e) };
        try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        return;
      }
      const rt = getRissetRuntime();
      scrub = { x: e.clientX, phase: rt.masterPhase };
      setPhaseScrubbing(true);
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      const pad = { left: 50, right: 56, top: 14, bottom: 20 };
      const y = e.clientY - r.top;
      const plotH = Math.max(20, r.height - pad.top - pad.bottom);
      const p = clamp(1 - (y - pad.top) / plotH, 0, 1);
      const params = P();
      const midi = phaseToMidi(params, p);
      hud.textContent = `${midiToNoteName(midi)} · ${midiToFreq(midi).toFixed(1)} Hz · p ${p.toFixed(3)} · A ${evalGlobalEnvelope(envOf(params, getRissetRuntime().eff), p).toFixed(3)}`;
      if (rangeDrag) {
        const p1 = phaseAtY(e);
        const lo = roundTo(Math.min(rangeDrag.p0, p1), 3);
        const hi = roundTo(Math.max(rangeDrag.p0, p1), 3);
        if (hi - lo >= 0.01) editRisset((d) => { const rg = d.regions[d.activeRegion]; rg.lo = lo; rg.hi = hi; }, { coalesceKey: 'risset-region-range' });
      }
      if (scrub) {
        const rt = getRissetRuntime();
        rt.masterPhase = (((scrub.phase + (e.clientX - scrub.x) / Math.max(120, r.width)) % 1) + 1) % 1;
      }
    });
    const end = () => { if (rangeDrag) commit(); rangeDrag = null; scrub = null; setPhaseScrubbing(false); };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    const winSel = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1 py-0.5 text-[11px]', on: { change: (e) => editRisset((d) => { d.view.timeWindowSec = Number(e.target.value) || 16; }, { history: false }) } },
      [4, 8, 16, 32, 64].map((s) => el('option', { value: s, text: `${s}s` })));
    syncers.push(() => { if (document.activeElement !== winSel) winSel.value = String(P().view.timeWindowSec); });
    const viewToggle = (labelKey, field) => {
      const b = el('button', { class: `fx-toggle ${BTN}`, text: t(labelKey), on: { click: () => editRisset((d) => { d.view[field] = !d.view[field]; }, { history: false }) } });
      syncers.push(() => setToggle(b, !!P().view[field]));
      return b;
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'risset.viewOpts' } }, [
        seg(['piano', 'phase'], 'risset.view', () => P().view.viewMode, (v) => editRisset((d) => { d.view.viewMode = v; }, { history: false })),
        viewToggle('risset.trails', 'showTrails'),
        viewToggle('risset.maskBand', 'showMaskBand'),
        el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-400' }, [t('risset.window'), winSel]),
        el('span', { class: 'ml-auto text-[10px] text-slate-500', text: t('risset.scrubHint') }),
      ]),
      hud,
      c,
      (() => {
        const cc = el('canvas', { class: 'w-full h-[84px] rounded-lg bg-slate-950 block', dataset: { help: 'risset.color' } });
        cv.color = cc;
        return cc;
      })(),
    ]);
  }

  function renderMain(rt) {
    if (!cv.main) return;
    const params = P();
    const { ctx, w, h } = sizeCanvas2d(cv.main, 40, 40);
    const pad = { left: 50, right: 56, top: 14, bottom: 20 };
    const plotW = Math.max(20, w - pad.left - pad.right);
    const plotH = Math.max(20, h - pad.top - pad.bottom);
    const pToY = (p) => pad.top + (1 - p) * plotH;
    const env = envOf(params, rt.eff);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, plotW, plotH);
    ctx.clip();
    const minMidi = params.baseMidi;
    const maxMidi = params.baseMidi + params.spanSemitones;
    if (params.view.viewMode === 'piano') {
      const BLACK = new Set([1, 3, 6, 8, 10]);
      const noteH = plotH / Math.max(1, maxMidi - minMidi);
      for (let m = Math.floor(minMidi); m <= Math.ceil(maxMidi); m++) {
        const py = pToY((m - minMidi) / Math.max(1, maxMidi - minMidi));
        const pc = ((m % 12) + 12) % 12;
        if (noteH >= 2.5) {
          ctx.fillStyle = BLACK.has(pc) ? 'rgba(15, 23, 42, 0.85)' : 'rgba(30, 41, 59, 0.25)';
          ctx.fillRect(pad.left, py - noteH * 0.5, plotW, noteH);
        }
        if (pc === 0) {
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.30)';
          ctx.beginPath();
          ctx.moveTo(pad.left, py);
          ctx.lineTo(pad.left + plotW, py);
          ctx.stroke();
        }
      }
    } else {
      for (let k = 0; k <= 8; k++) {
        ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
        ctx.beginPath();
        ctx.moveTo(pad.left, pToY(k / 8));
        ctx.lineTo(pad.left + plotW, pToY(k / 8));
        ctx.stroke();
      }
    }
    if (params.view.showMaskBand && params.localMode !== 'bypass') {
      const yTop = pToY(Math.max(params.bandMin, params.bandMax));
      const yBot = pToY(Math.min(params.bandMin, params.bandMax));
      ctx.fillStyle = 'rgba(139, 92, 246, 0.12)';
      ctx.fillRect(pad.left, yTop, plotW, Math.max(2, yBot - yTop));
    }
    const nowX = pad.left + plotW * 0.78;
    const winSec = params.view.timeWindowSec;
    const histSec = winSec * 0.78;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, pad.top);
    ctx.lineTo(nowX, pad.top + plotH);
    ctx.stroke();
    if (!rt.classic) {
      drawRegionSpace(ctx, rt, params, { pad, plotW, plotH, pToY, nowX, winSec, histSec, env });
      ctx.restore();
      drawMainAxes(ctx, params, env, { pad, plotW, plotH, pToY, minMidi, maxMidi });
      return;
    }
    const steps = params.voiceCount > 24 ? 65 : 110;
    const v = rt.eff.rateHz;
    // Trails follow the shaped trajectory y(τ) = v·F(τ) around the current shape clock.
    // 궤적 선은 현재 셰이프 시계 주변의 y(τ) = v·F(τ)를 따름.
    const F0 = shapedTime(params, rt.shapeTimeSec, rt.eff);
    const phiAt = (dtSec) => rt.masterPhase + v * (shapedTime(params, rt.shapeTimeSec + dtSec, rt.eff) - F0);
    const phiCache = new Float64Array(steps + 1);
    const dynOn = isDynamicsOn(params.dyn) && rt.dyn.N === params.voiceCount;
    for (let k = 0; k <= steps; k++) phiCache[k] = phiAt(-histSec + (k / steps) * winSec);
    for (let i = 0; i < params.voiceCount; i++) {
      const color = voiceColor(i);
      const aLoc = rt.particles[i]?.aLocal ?? 1;
      if (params.view.showTrails) {
        ctx.strokeStyle = color;
        // Dynamics: past = recorded xᵢ history, future = current xᵢ (not predicted). / 과거는 기록, 미래는 현재값
        const trailPhase = dynOn
          ? (k) => { const tau = -histSec + (k / steps) * winSec; const x = tau < 0 ? dynHistoryAt(rt.dyn, i, -tau) : rt.dyn.x[i]; return (((phiCache[k] + x) % 1) + 1) % 1; }
          : (k) => computeVoicePhase(params, phiCache[k], i);
        for (let k = 0; k < steps; k++) {
          const p0 = trailPhase(k);
          const p1 = trailPhase(k + 1);
          if (Math.abs(p1 - p0) > 0.5) continue;
          const e = evalGlobalEnvelope(env, 0.5 * (p0 + p1));
          ctx.globalAlpha = clamp(0.06 + e * aLoc * 0.85, 0.06, 0.9);
          ctx.lineWidth = 1 + e * aLoc * 2.2;
          ctx.beginPath();
          ctx.moveTo(pad.left + (k / steps) * plotW, pToY(p0));
          ctx.lineTo(pad.left + ((k + 1) / steps) * plotW, pToY(p1));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const pNow = rt.phases[i];
      const comb = voiceAmplitude(params, rt, i);
      ctx.fillStyle = color;
      ctx.globalAlpha = clamp(0.15 + comb * 0.85, 0.15, 1);
      ctx.beginPath();
      ctx.arc(nowX, pToY(pNow), 1.8 + comb * 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    drawMainAxes(ctx, params, env, { pad, plotW, plotH, pToY, minMidi, maxMidi });
  }

  function drawMainAxes(ctx, params, env, { pad, plotW, plotH, pToY, minMidi, maxMidi }) {
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
    ctx.font = `9.5px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#38bdf8';
    for (let m = Math.ceil(minMidi); m <= Math.floor(maxMidi); m += 12) {
      const py = pToY((m - minMidi) / Math.max(1, maxMidi - minMidi));
      if (py >= pad.top + 6 && py <= pad.top + plotH - 6) ctx.fillText(midiToNoteName(m), pad.left - 5, py);
    }
    const envX = pad.left + plotW + 6;
    const envW = pad.right - 12;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(envX, pad.top, envW, plotH);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k <= 60; k++) {
      const p = k / 60;
      const ex = envX + clamp(evalGlobalEnvelope(env, p), 0, 1) * (envW - 4);
      if (k === 0) ctx.moveTo(ex, pToY(p));
      else ctx.lineTo(ex, pToY(p));
    }
    ctx.stroke();
  }

  /**
   * Region modules: tinted range bands, rotated trail space per module, sounding points on the
   * green line (rt.slots). / 영역 모듈: 범위 띠, 회전된 궤적 공간, 초록 선 위 발음점.
   */
  function drawRegionSpace(ctx, rt, params, { pad, plotW, pToY, nowX, winSec, histSec, env }) {
    const offs = relOffsets(params, rt);
    const N = params.voiceCount;
    const steps = N > 24 ? 60 : 90;
    const pxPerSec = plotW / winSec;
    const tMin = -histSec;
    const tMax = winSec - histSec;
    params.regions.forEach((r, ri) => {
      const color = REGION_COLORS[ri % REGION_COLORS.length];
      const yTop = pToY(r.hi);
      const yBot = pToY(r.lo);
      const active = ri === params.activeRegion;
      ctx.globalAlpha = r.enabled ? (active ? 0.09 : 0.05) : 0.025;
      ctx.fillStyle = color;
      ctx.fillRect(pad.left, yTop, plotW, yBot - yTop);
      ctx.globalAlpha = r.enabled ? 0.8 : 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = active ? 1.4 : 1;
      ctx.setLineDash([5, 4]);
      for (const yy of [r.hi < 1 ? yTop : null, r.lo > 0 ? yBot : null]) {
        if (yy === null) continue;
        ctx.beginPath();
        ctx.moveTo(pad.left, yy);
        ctx.lineTo(pad.left + plotW, yy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const st = rt.regionStates[r.id];
      if (!r.enabled || !st) return;
      const ang = st.angleDeg;
      if (params.view.showTrails) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(pad.left, yTop, plotW, yBot - yTop);
        ctx.clip();
        const phi = regionPhiFn(params, rt, r);
        const corners = [[tMin, r.lo], [tMin, r.hi], [tMax, r.lo], [tMax, r.hi]].map(([tt, ss]) => screenToSpace(r, ang, tt, ss));
        const tauLo = Math.min(...corners.map((q) => q.tau));
        const tauHi = Math.max(...corners.map((q) => q.tau));
        const yLo = Math.min(...corners.map((q) => q.y));
        const yHi = Math.max(...corners.map((q) => q.y));
        const taus = new Float64Array(steps + 1);
        const phis = new Float64Array(steps + 1);
        let phMin = Infinity;
        let phMax = -Infinity;
        for (let k = 0; k <= steps; k++) {
          taus[k] = tauLo + ((tauHi - tauLo) * k) / steps;
          phis[k] = phi(taus[k]);
          phMin = Math.min(phMin, phis[k]);
          phMax = Math.max(phMax, phis[k]);
        }
        const xs = new Float64Array(steps + 1);
        const sv = new Float64Array(steps + 1);
        for (let i = 0; i < N; i++) {
          const aLoc = rt.particles[i]?.aLocal ?? 1;
          ctx.strokeStyle = voiceColor(i);
          const nLo = Math.floor(yLo - phMax - offs[i]);
          const nHi = Math.min(nLo + 16, Math.ceil(yHi - phMin - offs[i]));
          for (let n = nLo; n <= nHi; n++) {
            for (let k = 0; k <= steps; k++) {
              const sc = spaceToScreen(r, ang, taus[k], phis[k] + offs[i] + n);
              xs[k] = nowX + sc.tau * pxPerSec;
              sv[k] = sc.s;
            }
            for (let k = 0; k < steps; k++) {
              const s0 = sv[k];
              const s1 = sv[k + 1];
              if ((s0 < r.lo && s1 < r.lo) || (s0 > r.hi && s1 > r.hi)) continue;
              if ((xs[k] < pad.left && xs[k + 1] < pad.left) || (xs[k] > pad.left + plotW && xs[k + 1] > pad.left + plotW)) continue;
              const sm = 0.5 * (s0 + s1);
              const e = evalGlobalEnvelope(env, sm) * Math.max(0.25, edgeFade(r, clamp(sm, r.lo, r.hi))) * r.gain;
              ctx.globalAlpha = clamp(0.06 + e * aLoc * 0.85, 0.06, 0.9);
              ctx.lineWidth = 1 + e * aLoc * 2.2;
              ctx.beginPath();
              ctx.moveTo(xs[k], pToY(s0));
              ctx.lineTo(xs[k + 1], pToY(s1));
              ctx.stroke();
            }
          }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      if (r.rotOn) {
        // Pivot + rotated time axis / 회전 중심과 회전된 시간축
        const c = regionCenter(r);
        const th = (ang * Math.PI) / 180;
        const py = pToY(c);
        const L = 26;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(nowX - L * Math.cos(th), py + L * Math.sin(th));
        ctx.lineTo(nowX + L * Math.cos(th), py - L * Math.sin(th));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(nowX, py, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
    // Sounding points on the green line / 초록 선 위 발음점
    for (const sl of rt.slots) {
      if (!sl.active) continue;
      ctx.fillStyle = voiceColor(sl.voice);
      ctx.globalAlpha = clamp(0.2 + sl.amp * 0.8, 0.2, 1);
      ctx.beginPath();
      ctx.arc(nowX, pToY(sl.s), 1.8 + sl.amp * 3.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function renderRing(rt) {
    if (!cv.ring) return;
    const params = P();
    const { ctx, w } = sizeCanvas2d(cv.ring, 40, 40);
    ctx.clearRect(0, 0, w, w);
    const cx = w / 2;
    const r = w * 0.37;
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cx, r, 0, Math.PI * 2);
    ctx.stroke();
    for (const sl of rt.slots) {
      if (!sl.active) continue;
      const comb = sl.amp;
      const ang = -Math.PI / 2 + sl.s * Math.PI * 2;
      ctx.fillStyle = voiceColor(sl.voice);
      ctx.globalAlpha = clamp(0.15 + comb * 0.85, 0.15, 1);
      ctx.beginPath();
      ctx.arc(cx + r * Math.cos(ang), cx + r * Math.sin(ang), 1.6 + comb * 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------- interaction dynamics (A-5)
  /** Studio-level output tremolo (shared panel; LFO backend → no sweep / fade-in / global sync). */
  function buildTremolo() {
    const section = el('section', { class: SECTION });
    const host = createTremoloHost(section, {
      get: () => P().tremolo,
      edit: (fn, k) => editRisset((d) => { d.tremolo = normalizeTremolo(d.tremolo); fn(d.tremolo); d.tremolo = normalizeTremolo(d.tremolo); }, { coalesceKey: k }),
      duration: () => 2,
      envelope: () => null,
      hintKey: 'trem.hintRisset',
      features: { sweep: false, fade: false, sync: false },
    });
    syncers.push(() => host.sync());
    return section;
  }

  /** Per-voice tremolo + vibrato with randomizer and band follow (core/voice-mod.js). / 보이스별 트레몰로·비브라토 */
  function buildVoiceMod() {
    const V = () => normalizeVoiceMod(P().voiceMod);
    const editV = (fn, ck = null) => editRisset((d) => { d.voiceMod = normalizeVoiceMod(d.voiceMod); fn(d.voiceMod); }, { coalesceKey: ck });
    const setL = (laneKey, k) => (val, ck) => editV((m) => { m[laneKey][k] = val; }, ck);
    const onBtn = (laneKey) => {
      const b = el('button', { class: BTN, dataset: { help: 'risset.vmod' }, on: { click: () => { editV((m) => { m[laneKey].on = !m[laneKey].on; }); commit(); } } });
      syncers.push(() => { const on = V()[laneKey].on; b.textContent = `${on ? '●' : '○'} ${t(`risset.vmod.${laneKey}`)}`; b.classList.toggle('bg-cyan-700', on); b.classList.toggle('border-cyan-400', on); });
      return b;
    };
    const lane = (laneKey, depthKey, depthMax, depthStep, accent) => {
      const box = el('div', { class: 'flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2' }, [
        onBtn(laneKey),
        slider('risset.vmod.rate', `risset.vmod.${laneKey}Rate`, () => V()[laneKey].rate, setL(laneKey, 'rate'), { min: VMOD_RATE_MIN, max: Math.min(20, VMOD_RATE_MAX), step: 0.05, unit: 'Hz', accent }),
        slider(`risset.vmod.${depthKey}`, `risset.vmod.${laneKey}${depthKey === 'depth' ? 'Depth' : 'Cents'}`, () => V()[laneKey][depthKey], setL(laneKey, depthKey), { min: 0, max: depthMax, step: depthStep, unit: depthKey === 'cents' ? '¢' : '', accent }),
        slider('risset.vmod.spread', `risset.vmod.${laneKey}Spread`, () => V()[laneKey].spread, setL(laneKey, 'spread'), { min: 0, max: 1, step: 0.01, accent }),
        slider('risset.vmod.track', `risset.vmod.${laneKey}Track`, () => V()[laneKey].track, setL(laneKey, 'track'), { min: -VMOD_TRACK_MAX, max: VMOD_TRACK_MAX, step: 0.05, unit: 'oct', accent }),
      ]);
      syncers.push(() => box.classList.toggle('opacity-60', !V()[laneKey].on));
      return box;
    };
    const seedLbl = el('span', { class: 'font-mono text-[10px] text-slate-400', dataset: { help: 'risset.vmod.seed' } });
    syncers.push(() => { seedLbl.textContent = `${t('risset.vmod.seed')} ${V().seed}`; });
    const reroll = el('button', { class: BTN, dataset: { help: 'risset.vmod.seed' }, text: t('risset.vmod.reroll'), on: { click: () => { editV((m) => { m.seed = (m.seed * 7919 + 104729) % 99991 || 1; }); commit(); } } });
    return el('section', { class: SECTION, dataset: { help: 'risset.vmod', rack: 'risset-voice-mod' } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('risset.vmod.title') }),
        el('div', { class: 'flex items-center gap-2' }, [seedLbl, reroll]),
      ]),
      el('p', { class: 'text-[10.5px] text-slate-400 leading-snug', text: t('risset.vmod.hint') }),
      el('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-2' }, [lane('trem', 'depth', 1, 0.01, 'accent-cyan'), lane('vib', 'cents', VMOD_CENTS_MAX, 1, 'accent-violet')]),
    ]);
  }

  function buildDynamics() {
    const D = () => P().dyn;
    const setD = (k) => (val, ck) => editRisset((d) => { d.dyn[k] = val; }, { coalesceKey: ck });
    const sl = (k, min, max, step, unit = '') => slider(`risset.dyn.${k}`, 'risset.dynamics', () => D()[k], setD(k), { min, max, step, unit, accent: 'accent-rose' });
    const readout = el('div', { class: 'font-mono text-[10px] text-slate-400' });
    frameSyncers.push((rt) => {
      const q = P();
      if (!isDynamicsOn(q.dyn) || rt.dyn.N === 0) { readout.textContent = t('risset.dynOffHint'); return; }
      let mu = 0;
      for (let i = 0; i < rt.dyn.N; i++) mu += Math.abs(rt.dyn.u[i]);
      readout.textContent = `E ${kineticEnergy(rt.dyn, q.massM0, rt.sig.mass).toExponential(2)} · ⟨|ẋ|⟩ ${(mu / rt.dyn.N).toFixed(4)} · t ${rt.dyn.t.toFixed(1)} s`;
    });
    const resetBtn = el('button', { class: BTN, text: t('risset.dynReset'), on: { click: () => { getRissetRuntime().dynKey = ''; } } });
    return el('section', { class: SECTION, dataset: { help: 'risset.dynamics' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-rose-300', text: t('risset.dynTitle') }),
        seg(DYN_ORDERS, 'risset.dynOrder', () => D().order, (v) => editRisset((d) => { d.dyn.order = v; }), 'rose', 'risset.dynamics'),
      ]),
      el('p', { class: 'text-[10px] text-slate-500', text: t('risset.dynDesc') }),
      el('div', { class: 'flex items-center justify-between gap-2' }, [readout, resetBtn]),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1.5' }, [
        sl('K', -5, 5, 0.01),
        sl('frustration', -3.14, 3.14, 0.01, 'rad'),
        sl('repulsion', 0, 5, 0.01),
        el('div', { class: 'flex flex-col gap-0.5' }, [
          sl('viscosity', 0, 20, 0.01),
          seg(['laminar', 'turbulent'], 'risset.dynVisc', () => D().viscMode, (v) => editRisset((d) => { d.dyn.viscMode = v; }), 'rose', 'risset.dynamics'),
        ]),
        sl('view', 0.005, 0.5, 0.005),
        sl('align', 0, 10, 0.01),
        sl('cohesion', 0, 5, 0.01),
        sl('separation', 0, 5, 0.01),
        sl('gravity', -2, 2, 0.01),
        sl('noise', 0, 1, 0.001),
        sl('dragUp', 0, 20, 0.01),
        sl('dragDown', 0, 20, 0.01),
        sl('delaySec', 0.01, 4, 0.01, 's'),
      ]),
      el('p', { class: 'text-[10px] text-slate-500', text: t('risset.dynHint') }),
    ]);
  }

  // ---------------------------------------------------------------- region modules & rotation
  function buildRegions() {
    const p = P();
    const ai = p.activeRegion;
    const R = () => { const q = P(); return q.regions[q.activeRegion] || q.regions[0]; };
    const setR = (k) => (val, ck) => editRisset((d) => { d.regions[d.activeRegion][k] = val; }, { coalesceKey: ck ? `${ck}:${d0id()}` : null });
    const d0id = () => R().id;
    const editR = (fn) => { editRisset((d) => fn(d.regions[d.activeRegion], d)); commit(); };
    const check = (labelKey, field, help) => {
      const i = el('input', { type: 'checkbox', class: 'accent-emerald-500', on: { change: (e) => editR((r) => { r[field] = e.target.checked; }) } });
      syncers.push(() => { i.checked = !!R()[field]; });
      return el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: help ? { help } : undefined }, [i, t(labelKey)]);
    };
    const tabs = el('div', { class: 'flex flex-wrap items-center gap-1' }, [
      ...p.regions.map((r, i) => {
        const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px] font-mono font-semibold border transition', text: `M${i + 1}`, on: { click: () => editRisset((d) => { d.activeRegion = i; }, { history: false }) } });
        syncers.push(() => {
          const q = P();
          const rg = q.regions[i];
          const on = q.activeRegion === i;
          b.style.borderColor = REGION_COLORS[i % REGION_COLORS.length];
          b.style.background = on ? REGION_COLORS[i % REGION_COLORS.length] : 'transparent';
          b.style.color = on ? '#020617' : REGION_COLORS[i % REGION_COLORS.length];
          b.style.opacity = rg?.enabled ? '1' : '0.45';
        });
        return b;
      }),
      p.regions.length < MAX_REGIONS && el('button', { class: BTN, text: t('risset.regionAdd'), on: { click: () => {
        editRisset((d) => {
          d.regions.push(createDefaultRegion({ lo: 0.3, hi: 0.7, linkRate: false, rateHz: -(Math.abs(d.rateHz) > 1e-5 ? d.rateHz : 0.03) }));
          d.activeRegion = d.regions.length - 1;
        });
        commit();
      } } }),
      p.regions.length > 1 && el('button', { class: `${BTN} hover:bg-rose-600`, text: t('risset.regionRemove'), on: { click: () => editR((r, d) => { d.regions.splice(d.activeRegion, 1); d.activeRegion = Math.max(0, d.activeRegion - 1); }) } }),
    ].filter(Boolean));
    const rangeTag = el('span', { class: 'font-mono text-[10px] text-emerald-300' });
    syncers.push(() => {
      const q = P();
      const r = R();
      rangeTag.textContent = `${midiToNoteName(phaseToMidi(q, r.lo))} – ${midiToNoteName(phaseToMidi(q, r.hi))}`;
    });
    const rangePreset = (label, lo, hi) => [label, () => editRisset((d) => { Object.assign(d.regions[d.activeRegion], { lo, hi }); })];
    const fitBtn = el('button', { class: BTN, text: t('risset.rotFit'), dataset: { help: 'risset.rotation' }, on: { click: () => {
      const c = cv.main;
      if (!c) return;
      const plotW = Math.max(20, c.clientWidth - 50 - 56);
      const plotH = Math.max(20, c.clientHeight - 14 - 20);
      const T = roundTo(clamp((plotH * P().view.timeWindowSec) / plotW, 0.25, 120), 2);
      editR((r) => { r.timeScaleSec = T; });
    } } });
    const resetRot = el('button', { class: BTN, text: t('risset.rotReset'), on: { click: () => {
      const st = getRissetRuntime().regionStates[R().id];
      if (st) { st.spinDeg = 0; st.swingTimeSec = 0; }
    } } });
    const speedNote = el('p', { class: 'text-[10px] text-teal-200/80 font-mono', dataset: { help: 'risset.regionScope' } });
    syncers.push(() => { const r = R(); speedNote.textContent = t('risset.regionSpeedNote', r.linkRate ? t('risset.regionSpeedLinked') : `${roundTo(r.rateHz, 3)} Hz`); });
    const ownList = el('span', { class: 'font-mono text-[10px] text-amber-200/90' });
    syncers.push(() => { const r = R(); const ks = Object.keys(r.own || {}); ownList.textContent = ks.length ? `${t('risset.regionOwn')}: ${ks.map((k) => t(`risset.ownKey.${k}`)).join(' · ')}` : t('risset.regionOwnNone'); });
    const resetOwn = el('button', { class: BTN, dataset: { help: 'risset.regionScope' }, text: t('risset.regionOwnReset'), on: { click: () => { editRissetDoc((d) => { const r = d.regions[d.activeRegion]; delete r.own; r.linkRate = true; }); commit(); } } });
    const scopeBtn = el('button', { class: BTN, dataset: { help: 'risset.regionScope' }, on: { click: () => { scopeOn = !scopeOn; key = ''; renderNow(); } } });
    syncers.push(() => { scopeBtn.textContent = scopeOn ? `🎯 ${t('risset.scopeRegion', `M${P().activeRegion + 1}`)}` : `🌐 ${t('risset.scopeAll')}`; scopeBtn.classList.toggle('bg-teal-700', scopeOn); });
    const angPresets = presetBtns([-90, -45, 0, 45, 90, 180].map((a) => [`${a}°`, () => editRisset((d) => { const r = d.regions[d.activeRegion]; r.rotOn = true; r.rotAngleDeg = a; })]));
    return el('section', { class: SECTION, dataset: { help: 'risset.regions' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-teal-300', text: t('risset.regionTitle') }),
        tabs,
      ]),
      el('p', { class: 'text-[10px] text-slate-500', text: t('risset.regionDesc') }),
      p.regions.length >= 2 && el('div', { class: 'flex flex-wrap items-center gap-2 rounded-lg border border-teal-800/70 bg-teal-950/30 px-2 py-1', dataset: { help: 'risset.regionScope' } }, [scopeBtn, ownList, resetOwn]),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-3' }, [
        // Range & speed / 범위와 속도
        el('div', { class: 'flex flex-col gap-1.5', dataset: { help: 'risset.regions' } }, [
          el('div', { class: 'flex items-center justify-between gap-2' }, [el('span', { class: 'text-[11px] font-semibold text-slate-300', text: t('risset.regionRange') }), rangeTag, check('risset.regionOn', 'enabled')]),
          slider('risset.regionLo', 'risset.regions', () => R().lo, setR('lo'), { min: 0, max: 1, step: 0.005, accent: 'accent-teal' }),
          slider('risset.regionHi', 'risset.regions', () => R().hi, setR('hi'), { min: 0, max: 1, step: 0.005, accent: 'accent-teal' }),
          presetBtns([rangePreset(t('risset.regionFull'), 0, 1), rangePreset('↓ ½', 0, 0.5), rangePreset('↑ ½', 0.5, 1), rangePreset('⅓', 1 / 3, 2 / 3), rangePreset('¼', 0.375, 0.625)]),
          slider('risset.regionEdge', 'risset.regions', () => R().edge, setR('edge'), { min: 0, max: 0.5, step: 0.005, accent: 'accent-teal' }),
          slider('risset.regionGain', 'risset.regions', () => R().gain, setR('gain'), { min: 0, max: 2, step: 0.01, accent: 'accent-teal' }),
          el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1' }, [
            check('risset.regionLink', 'linkRate', 'risset.regions'),
            // The region's own speed is the Core "Glissando rate" while this region is selected (no second slider)
            // 영역 자체 속도 = 이 영역 선택 중 코어 "글리산도 속도" (중복 슬라이더 없음)
            speedNote,
          ]),
          el('p', { class: 'text-[10px] text-slate-500', text: t('risset.regionHint') }),
        ]),
        // Rotation / 회전
        el('div', { class: 'flex flex-col gap-1.5', dataset: { help: 'risset.rotation' } }, [
          el('div', { class: 'flex items-center justify-between gap-2' }, [check('risset.rotOn', 'rotOn', 'risset.rotation'), el('div', { class: 'flex gap-1' }, [resetRot])]),
          slider('risset.rotAngle', 'risset.rotation', () => R().rotAngleDeg, setR('rotAngleDeg'), { min: -180, max: 180, step: 0.5, unit: '°', accent: 'accent-teal' }),
          angPresets,
          slider('risset.rotSpin', 'risset.rotation', () => R().rotSpinDegPerSec, setR('rotSpinDegPerSec'), { min: -90, max: 90, step: 0.1, unit: '°/s', accent: 'accent-teal' }),
          slider('risset.rotSwing', 'risset.rotation', () => R().rotSwingDeg, setR('rotSwingDeg'), { min: 0, max: 180, step: 0.5, unit: '°', accent: 'accent-teal' }),
          slider('risset.rotSwingSec', 'risset.rotation', () => R().rotSwingSec, setR('rotSwingSec'), { min: 0.25, max: 60, step: 0.25, unit: 's', accent: 'accent-teal' }),
          el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1' }, [
            check('risset.rotCenterAuto', 'rotCenterAuto', 'risset.rotation'),
            slider('risset.rotCenter', 'risset.rotation', () => (R().rotCenterAuto ? regionCenter(R()) : R().rotCenter), (v, ck) => editRisset((d) => { const r = d.regions[d.activeRegion]; r.rotCenterAuto = false; r.rotCenter = v; }, { coalesceKey: ck }), { min: 0, max: 1, step: 0.005, accent: 'accent-teal' }),
            el('div', { class: 'flex items-end gap-1.5' }, [
              el('div', { class: 'flex-1 min-w-0' }, [slider('risset.rotTimeScale', 'risset.rotation', () => R().timeScaleSec, setR('timeScaleSec'), { min: 0.25, max: 60, step: 0.25, unit: 's', accent: 'accent-teal' })]),
              fitBtn,
            ]),
          ]),
        ]),
      ]),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- harmonic colour (A-2)
  function buildColor() {
    const C = () => P().colorCtl;
    const setC = (k) => (val, ck) => editRisset((d) => { d.colorCtl[k] = val; }, { coalesceKey: ck });
    const chk = el('input', { type: 'checkbox', class: 'accent-amber-500', on: { change: (e) => { editRisset((d) => { d.colorCtl.enabled = e.target.checked; }); commit(); } } });
    syncers.push(() => { chk.checked = !!C().enabled; });
    const readout = el('div', { class: 'font-mono text-[10px] text-slate-400' });
    frameSyncers.push((rt) => {
      const m = rt.color.last;
      const o = rt.color.out;
      readout.textContent = `R ${m.R.toFixed(4)} · H ${m.H.toFixed(4)} · C ${m.Chz ? m.Chz.toFixed(0) : '—'} Hz${o ? ` · ${o.key} → ${o.value.toFixed(3)}` : ''}`;
    });
    const grab = el('button', { class: BTN, text: t('risset.colorGrab'), on: { click: () => {
      const m = getRissetRuntime().color.last;
      editRisset((d) => { if (m.Chz > 0) d.colorCtl.setpointHz = roundTo(m.Chz, 1); if (m.R > 0) d.colorCtl.setpointR = roundTo(m.R, 4); });
      commit();
    } } });
    const isR = P().colorCtl.target === 'rtotal';
    return el('section', { class: SECTION, dataset: { help: 'risset.color' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('risset.colorTitle') }),
        el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'risset.colorCtl' } }, [chk, t('risset.colorCtlOn')]),
      ]),
      readout,
      slider('risset.spectralTilt', 'risset.color', () => P().spectralTilt, set('spectralTilt'), { min: -12, max: 12, step: 0.1, unit: 'dB/oct', autoKey: 'spectralTilt', accent: 'accent-amber' }),
      el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1.5', dataset: { help: 'risset.colorCtl' } }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[10px] text-slate-400', text: t('risset.colorTarget') }),
          seg(COLOR_TARGETS, 'risset.colorTargetKind', () => C().target, (v) => editRisset((d) => { d.colorCtl.target = v; }), 'amber', 'risset.colorCtl'),
        ]),
        isR
          ? slider('risset.colorSetR', 'risset.colorCtl', () => C().setpointR, setC('setpointR'), { min: 0.001, max: 1, step: 0.001, accent: 'accent-amber' })
          : slider('risset.colorSetHz', 'risset.colorCtl', () => C().setpointHz, setC('setpointHz'), { min: 40, max: 8000, step: 1, unit: 'Hz', accent: 'accent-amber' }),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[10px] text-slate-400', text: t('risset.colorActuator') }),
          seg(COLOR_ACTUATORS, 'risset.colorAct', () => C().actuator, (v) => editRisset((d) => { d.colorCtl.actuator = v; }), 'amber', 'risset.colorCtl'),
        ]),
        slider('risset.colorKp', 'risset.colorCtl', () => C().kp, setC('kp'), { min: 0, max: 5, step: 0.01, accent: 'accent-amber' }),
        slider('risset.colorKi', 'risset.colorCtl', () => C().ki, setC('ki'), { min: 0, max: 5, step: 0.01, accent: 'accent-amber' }),
        el('div', { class: 'flex gap-1' }, [grab]),
        el('p', { class: 'text-[10px] text-slate-500', text: t('risset.colorHint') }),
      ]),
    ]);
  }

  function renderColor(rt) {
    if (!cv.color) return;
    const { ctx, w, h } = sizeCanvas2d(cv.color, 40, 40);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    const hist = rt.color.hist;
    const n = hist.count;
    const pad = { left: 50, right: 56, top: 6, bottom: 6 };
    const plotW = Math.max(20, w - pad.left - pad.right);
    const plotH = h - pad.top - pad.bottom;
    const series = [
      ['R', hist.R, '#f472b6', (x, mx) => x / mx],
      ['H', hist.H, '#fbbf24', (x, mx) => x / mx],
      ['C', hist.C, '#38bdf8', (x) => (x > 0 ? (Math.log2(x) - Math.log2(40)) / (Math.log2(8000) - Math.log2(40)) : 0)],
    ];
    ctx.font = `9px ${MONO}`;
    ctx.textBaseline = 'middle';
    series.forEach(([lbl, arr, col, norm], si) => {
      let mx = 1e-9;
      for (let k = 0; k < n; k++) mx = Math.max(mx, arr[(hist.head - 1 - k + COLOR_HISTORY) % COLOR_HISTORY]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const v = arr[(hist.head - n + k + COLOR_HISTORY) % COLOR_HISTORY];
        const x = pad.left + plotW * (1 - (n - 1 - k) / (COLOR_HISTORY - 1));
        const y = pad.top + (1 - clamp(norm(v, mx), 0, 1)) * plotH;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'right';
      ctx.fillText(lbl, pad.left - 6, pad.top + 8 + si * 12);
    });
    const ctl = P().colorCtl;
    if (ctl.enabled && ctl.target === 'cspec') {
      const y = pad.top + (1 - clamp((Math.log2(ctl.setpointHz) - Math.log2(40)) / (Math.log2(8000) - Math.log2(40)), 0, 1)) * plotH;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  }

  // ---------------------------------------------------------------- rhythm ↔ tone continuum (A-3)
  function buildRhythm() {
    // Log slider for f_min: 0.5 Hz … 2 kHz / f_min 로그 슬라이더
    const LO = 0.5;
    const HI = 2000;
    const toHz = (u) => LO * (HI / LO) ** u;
    const toU = (hz) => Math.log(clamp(hz, LO, HI) / LO) / Math.log(HI / LO);
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.001, class: 'w-full accent-cyan' });
    setSliderDefault(range, () => { const m = probeStudioDefault(() => P().baseMidi, RISSET_ID); return m === null ? null : toU(440 * 2 ** ((m - 69) / 12)); });
    const hzIn = el('input', { type: 'number', min: LO, max: HI, step: 0.01, class: 'w-[5.5rem] px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-cyan-200' });
    const setHz = (hz, ck) => editRisset((d) => { d.baseMidi = clamp(roundTo(69 + 12 * Math.log2(clamp(hz, LO, HI) / 440), 2), BASE_MIDI_RANGE[0], BASE_MIDI_RANGE[1]); }, { coalesceKey: ck });
    range.addEventListener('input', () => setHz(toHz(Number(range.value)), 'risset:fmin'));
    range.addEventListener('change', commit);
    hzIn.addEventListener('change', () => { setHz(num(hzIn.value, 24)); commit(); });
    const zones = el('div', { class: 'font-mono text-[10px] text-slate-400' });
    syncers.push(() => {
      const q = P();
      const f0 = midiToFreq(q.baseMidi);
      const f1 = midiToFreq(q.baseMidi + q.spanSemitones);
      if (document.activeElement !== range) range.value = String(toU(f0));
      if (document.activeElement !== hzIn) hzIn.value = String(roundTo(f0, 2));
      zones.textContent = `${fmtHz(f0)} → ${fmtHz(f1)} · ${t(`risset.zone.${zoneOf(f0)}`)} → ${t(`risset.zone.${zoneOf(f1)}`)}`;
    });
    const rTag = el('span', { class: 'font-mono text-[10px] text-cyan-300' });
    frameSyncers.push(() => { const r = rissetSyncR(); rTag.textContent = r === null ? 'r —' : `r ${r.toFixed(2)}`; });
    const warpIn = textInput('text-cyan-200');
    const applyWarp = () => {
      const r = parseRatioSeq(warpIn.value)?.[0];
      if (!r || r.p / r.q <= 1) { hooks.showToast(t('risset.parseError'), 'error'); return; }
      editRisset((d) => {
        d.gridMode = 'ratio';
        d.ratioText = r.label;
        d.spanSemitones = clamp(roundTo((r.cents / 100) * d.voiceCount, 4), SPAN_RANGE[0], SPAN_RANGE[1]);
      });
      commit();
    };
    warpIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyWarp(); });
    syncers.push(() => { if (document.activeElement !== warpIn && !warpIn.value) warpIn.value = '3:2'; });
    return el('section', { class: SECTION, dataset: { help: 'risset.rhythm' } }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-cyan-300', text: t('risset.rhythmTitle') }),
      el('div', { class: 'flex flex-col gap-0.5', dataset: { help: 'risset.rhythm' } }, [
        el('div', { class: 'flex items-center justify-between gap-2' }, [el('span', { class: 'text-[11px] text-slate-300', text: t('risset.fmin') }), hzIn]),
        range,
        zones,
      ]),
      el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1.5', dataset: { help: 'risset.wave' } }, [
        slider('risset.waveMorph', 'risset.wave', () => P().waveMorph, set('waveMorph'), { min: 0, max: 1, step: 0.01, accent: 'accent-cyan' }),
        slider('risset.waveDuty', 'risset.wave', () => P().waveDuty, set('waveDuty'), { min: 0.05, max: 0.95, step: 0.01, accent: 'accent-cyan' }),
      ]),
      el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1.5', dataset: { help: 'risset.sync' } }, [
        el('div', { class: 'flex items-center justify-between' }, [el('span', { class: 'text-[10px] text-slate-500', text: t('risset.syncHint') }), rTag]),
        slider('risset.oscSync', 'risset.sync', () => P().oscSyncHz, set('oscSyncHz'), { min: -40, max: 40, step: 0.1, unit: 'Hz', accent: 'accent-cyan' }),
        slider('risset.flutterDb', 'risset.flutter', () => P().flutterDb, set('flutterDb'), { min: -36, max: 12, step: 0.5, unit: 'dB', accent: 'accent-cyan' }),
      ]),
      el('div', { class: 'border-t border-slate-800 pt-1.5 flex items-center gap-1.5', dataset: { help: 'risset.warp' } }, [
        el('span', { class: 'w-24 text-[10px] text-slate-400', text: t('risset.warp') }),
        warpIn,
        el('button', { class: BTN, text: t('risset.apply'), on: { click: applyWarp } }),
      ]),
      el('p', { class: 'text-[10px] text-slate-500', text: t('risset.rhythmHint') }),
    ]);
  }

  // ---------------------------------------------------------------- core section
  function buildCore() {
    const p = P();
    return el('section', { class: SECTION }, [
      el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('risset.coreTitle') }),
      slider('risset.rate', 'risset.rate', () => P().rateHz, (v, ck) => editRisset((d) => { d.rateHz = v; if (Math.abs(v) > 1e-5) d.lastNonZeroRate = v; }, { coalesceKey: ck }), { min: -1, max: 1, step: 0.001, autoKey: 'rateHz', unit: 'Hz' }),
      presetBtns([['0', 0], ['−0.1', -0.1], ['−0.03', -0.03], ['+0.03', 0.03], ['+0.1', 0.1], ['+0.5', 0.5]].map(([l, v]) => [l, () => editRisset((d) => { d.rateHz = v; }), 'risset.rate'])),
      slider('risset.voices', 'risset.voices', () => P().voiceCount, (v, ck) => editRisset((d) => { d.voiceCount = Math.round(v); }, { coalesceKey: ck }), { min: MIN_VOICES, max: MAX_VOICES, step: 1 }),
      presetBtns([8, 12, 16, 24, 36, 48, 60].map((n) => [String(n), () => editRisset((d) => { d.voiceCount = n; }), 'risset.voices'])),
      slider('risset.span', 'risset.span', () => P().spanSemitones, (v, ck) => editRisset((d) => { d.spanSemitones = roundTo(v, 4); }, { coalesceKey: ck }), { min: SPAN_RANGE[0], max: SPAN_RANGE[1], step: 0.01, unit: 'st' }),
      (() => {
        // Stretched (non-octave) cycle: span = 12·log₂(R) / 비옥타브 스팬
        const i = el('input', { type: 'number', min: 1.06, max: 4096, step: 0.001, class: 'w-24 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-amber-200' });
        const info = el('span', { class: 'font-mono text-[10px] text-slate-400' });
        i.addEventListener('change', () => { const R = num(i.value, 0); if (R > 1) { editRisset((d) => { d.spanSemitones = clamp(roundTo(12 * Math.log2(R), 4), SPAN_RANGE[0], SPAN_RANGE[1]); }); commit(); } });
        syncers.push(() => {
          const sp = P().spanSemitones;
          if (document.activeElement !== i) i.value = String(roundTo(2 ** (sp / 12), 4));
          const oct = sp / 12;
          info.textContent = `${roundTo(oct, 3)} oct · ${formatCents(sp * 100)}`;
        });
        return el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300', dataset: { help: 'risset.ratio' } }, [t('risset.spanRatio'), info, i]);
      })(),
      (() => {
        const tag = el('span', { class: 'font-mono text-[11px] text-emerald-300' });
        syncers.push(() => { const b = P().baseMidi; tag.textContent = `${midiToNoteName(Math.round(b))} (${roundTo(b, 2)}) · ${fmtHz(midiToFreq(b))}`; });
        return el('div', { class: 'flex flex-col gap-1' }, [
          slider('risset.baseMidi', 'risset.span', () => P().baseMidi, (v, ck) => editRisset((d) => { d.baseMidi = roundTo(v, 2); }, { coalesceKey: ck }), { min: BASE_MIDI_RANGE[0], max: BASE_MIDI_RANGE[1], step: 0.01 }),
          tag,
        ]);
      })(),
      slider('risset.masterGain', 'risset.voices', () => P().masterGain, (v, ck) => editRisset((d) => { d.masterGain = v; }, { coalesceKey: ck }), { min: 0, max: 1.5, step: 0.01, autoKey: 'masterGain', accent: 'accent-emerald' }),
      el('div', { class: 'border-t border-slate-800 pt-2 flex flex-col gap-1.5', dataset: { help: 'risset.shape' } }, [
        el('span', { class: 'text-[11px] font-semibold text-slate-300', text: t('risset.shapeTitle') }),
        seg(SHAPE_KINDS, 'risset.shapeKind', () => P().shapeKind, (v) => editRisset((d) => { d.shapeKind = v; }), 'sky', 'risset.shape'),
        slider('risset.shapePeriod', 'risset.shape', () => P().shapePeriodSec, (v, ck) => editRisset((d) => { d.shapePeriodSec = v; }, { coalesceKey: ck }), { min: 0.25, max: 32, step: 0.25, unit: 's' }),
        p.shapeKind === 'sine' && slider('risset.shapeAmount', 'risset.shape', () => P().shapeAmount, (v, ck) => editRisset((d) => { d.shapeAmount = v; }, { coalesceKey: ck }), { min: 0, max: 1, step: 0.01, autoKey: 'shapeAmount' }),
        p.shapeKind === 'polynomial' && slider('risset.shapePower', 'risset.shape', () => P().shapePower, (v, ck) => editRisset((d) => { d.shapePower = v; }, { coalesceKey: ck }), { min: 0.25, max: 6, step: 0.05 }),
        p.shapeKind === 'engine' && el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300' }, [t('risset.shapeEngine'), (() => {
          const s = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]', on: { change: (e) => { editRisset((d) => { d.shapeEngine.engine = e.target.value; }); commit(); } } }, SHAPE_ENGINES.map((id) => el('option', { value: id, text: getEngineLabel(id) })));
          syncers.push(() => { if (document.activeElement !== s) s.value = P().shapeEngine.engine; });
          return s;
        })()]),
        el('p', { class: 'text-[10px] text-slate-500', text: t('risset.shapeHint') }),
      ].filter(Boolean)),
    ]);
  }

  // ---------------------------------------------------------------- harmony grid
  function buildGrid() {
    const p = P();
    const gridCanvas = el('canvas', { class: 'w-full h-[150px] rounded-lg bg-slate-950 block cursor-ns-resize', dataset: { help: 'risset.grid' } });
    cv.grid = gridCanvas;
    let barIdx = -1;
    const setBar = (e) => {
      const r = gridCanvas.getBoundingClientRect();
      const pad = { left: 42, right: 12, top: 14, bottom: 20 };
      const params = P();
      const plotW = Math.max(20, r.width - pad.left - pad.right);
      const plotH = Math.max(20, r.height - pad.top - pad.bottom);
      const idx = barIdx >= 0 ? barIdx : clamp(Math.floor(((e.clientX - r.left - pad.left) / plotW) * params.voiceCount), 0, params.voiceCount - 1);
      barIdx = idx;
      const frac = clamp(1 - (e.clientY - r.top - pad.top) / plotH, 0, 1);
      editRisset((d) => { d.gridMode = 'custom'; d.offsets[idx] = roundTo(frac * Math.max(24, d.spanSemitones), 2); }, { coalesceKey: 'risset-grid-bar' });
    };
    gridCanvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; barIdx = -1; try { gridCanvas.setPointerCapture(e.pointerId); } catch { /* */ } setBar(e); });
    gridCanvas.addEventListener('pointermove', (e) => { if (barIdx >= 0) setBar(e); });
    const endBar = () => { if (barIdx >= 0) commit(); barIdx = -1; };
    gridCanvas.addEventListener('pointerup', endBar);
    gridCanvas.addEventListener('pointercancel', endBar);

    // Interval ⇄ Pitch typing (both directions) / 음정 ⇄ 피치 양방향 입력
    const intervalIn = textInput('text-amber-200');
    const pitchIn = textInput('text-emerald-200');
    const applyInterval = () => {
      const offs = parseIntervalSeq(intervalIn.value, P().voiceCount);
      if (!offs) { hooks.showToast(t('risset.parseError'), 'error'); return; }
      editRisset((d) => { d.gridMode = 'custom'; d.offsets = offs; });
      commit();
    };
    const applyPitch = () => {
      const res = parsePitchSeq(pitchIn.value, P().baseMidi, P().voiceCount);
      if (!res) { hooks.showToast(t('risset.parseError'), 'error'); return; }
      pitchIn.value = res.normalizedText; // auto upper-case (c1 → C1, bb2 → Bb2) / 대문자 보정
      editRisset((d) => { d.gridMode = 'custom'; d.offsets = res.offsets; d.pitchText = res.normalizedText; });
      commit();
      pitchIn.blur();
    };
    intervalIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyInterval(); });
    pitchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPitch(); });
    syncers.push(() => {
      const q = P();
      if (document.activeElement !== intervalIn) intervalIn.value = offsetsToIntervalText(q.offsets);
      if (document.activeElement !== pitchIn) {
        // Keep the user's spelling (Bb2 vs A#2) while it still describes the current offsets.
        // 현재 오프셋과 일치하는 동안 사용자가 입력한 표기(Bb2 등)를 유지
        const typed = q.pitchText ? parsePitchSeq(q.pitchText, q.baseMidi, q.voiceCount) : null;
        const same = typed && typed.offsets.every((o, i) => Math.abs(o - Number(q.offsets[i])) < 1e-6);
        pitchIn.value = same ? q.pitchText : offsetsToPitchText(q.offsets, q.baseMidi);
      }
    });

    const patternIn = textInput();
    const intervalChk = el('input', { type: 'checkbox', class: 'accent-amber-500' });
    const applyPattern = () => {
      editRisset((d) => { d.patternText = normalizePatternText(patternIn.value, intervalChk.checked); d.patternIntervalMode = intervalChk.checked; d.gridMode = 'pattern'; });
      commit();
    };
    intervalChk.addEventListener('change', applyPattern);
    patternIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyPattern(); });
    syncers.push(() => {
      const q = P();
      if (document.activeElement !== patternIn) patternIn.value = q.patternText;
      intervalChk.checked = !!q.patternIntervalMode;
    });
    const fixedIn = el('input', { type: 'number', min: 0.01, max: 96, step: 0.01, class: 'w-16 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
    fixedIn.addEventListener('change', () => { editRisset((d) => { d.fixedStep = clamp(num(fixedIn.value, 12), 0.01, 96); d.gridMode = 'fixed'; }); commit(); });
    syncers.push(() => { if (document.activeElement !== fixedIn) fixedIn.value = String(P().fixedStep); });

    // Compact offset cells with ▲/▼ stacked on the right / 압축 셀 (오른쪽 세로 ▲▼)
    const cells = el('div', { class: p.view.offsetsExpanded ? 'grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-10 gap-1' : 'flex gap-1 overflow-x-auto pb-1' },
      Array.from({ length: p.voiceCount }, (_, i) => {
        const note = el('span', { class: 'font-bold text-emerald-300' });
        const inp = el('input', { type: 'text', class: 'w-full min-w-0 bg-slate-950 border border-slate-700 rounded px-0.5 py-0 text-center font-mono text-[10px] text-amber-300' });
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
        const setOff = (val) => { editRisset((d) => { d.gridMode = 'custom'; d.offsets[i] = roundTo(clamp(val, OFFSET_MIN, OFFSET_MAX), 2); }, { coalesceKey: `risset-off-${i}` }); };
        inp.addEventListener('change', () => {
          const tok = parsePitchToken(inp.value);
          if (tok) setOff(tok.midi - P().baseMidi);
          else if (Number.isFinite(Number(inp.value))) setOff(Number(inp.value));
          commit();
        });
        const stepBtn = (d, label) => el('button', { class: 'px-0.5 leading-none rounded bg-slate-800 hover:bg-slate-700 text-[7px] text-slate-200', text: label, title: d > 0 ? '+0.01 (Shift +1)' : '−0.01 (Shift −1)', on: { click: (e) => { setOff(num(P().offsets[i]) + d * (e.shiftKey ? 1 : 0.01)); commit(); } } });
        syncers.push(() => {
          const q = P();
          const val = num(q.offsets[i]);
          note.textContent = absPitchName(q.baseMidi + val);
          if (document.activeElement !== inp) inp.value = formatClean(val);
        });
        return el('div', { class: `bg-slate-900 border border-slate-800 rounded px-1 py-0.5 flex flex-col gap-0.5 shrink-0 ${p.view.offsetsExpanded ? '' : 'w-[64px]'}` }, [
          el('div', { class: 'flex items-center justify-between text-[9px] font-mono text-slate-400' }, [
            el('span', { class: 'flex items-center gap-0.5' }, [el('span', { class: 'w-1.5 h-1.5 rounded-full', style: `background:${voiceColor(i)}` }), String(i + 1)]),
            note,
          ]),
          el('div', { class: 'flex items-stretch gap-0.5' }, [inp, el('div', { class: 'flex flex-col justify-between shrink-0' }, [stepBtn(1, '▲'), stepBtn(-1, '▼')])]),
        ]);
      }));
    const expandBtn = el('button', { class: `${BTN} w-7 font-bold`, text: p.view.offsetsExpanded ? '−' : '+', title: t('risset.expand'), on: { click: () => editRisset((d) => { d.view.offsetsExpanded = !d.view.offsetsExpanded; }, { history: false }) } });

    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-amber-300', text: t('risset.gridTitle') }),
        seg(GRID_MODES, 'risset.gridMode', () => P().gridMode, (v) => editRisset((d) => { d.gridMode = v; }), 'amber', 'risset.grid'),
      ]),
      p.gridMode === 'fixed' && el('label', { class: 'flex items-center gap-2 text-[11px] text-slate-300' }, [t('risset.fixedStep'), fixedIn]),
      p.gridMode === 'ratio' && (() => {
        const ratioIn = textInput('text-amber-200');
        const cents = el('span', { class: 'font-mono text-[10px] text-emerald-300' });
        const applyRatio = (txt) => {
          const r = parseRatioSeq(txt);
          if (!r) { hooks.showToast(t('risset.parseError'), 'error'); return; }
          editRisset((d) => { d.ratioText = r.map((x) => x.label).join(', '); d.gridMode = 'ratio'; });
          commit();
        };
        ratioIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { applyRatio(ratioIn.value); ratioIn.blur(); } });
        syncers.push(() => {
          const q = P();
          if (document.activeElement !== ratioIn) ratioIn.value = q.ratioText;
          cents.textContent = (parseRatioSeq(q.ratioText) || []).map((r) => `${r.label} = ${formatCents(r.cents)}`).join(' · ');
        });
        return el('div', { class: 'flex flex-col gap-1', dataset: { help: 'risset.ratio' } }, [
          el('div', { class: 'flex items-center gap-1.5' }, [el('span', { class: 'w-24 text-[10px] text-slate-400', text: t('risset.ratioSeq') }), ratioIn, el('button', { class: BTN, text: t('risset.apply'), on: { click: () => applyRatio(ratioIn.value) } })]),
          presetBtns(RATIO_PRESETS.map((r) => [r, () => editRisset((d) => { d.ratioText = r; d.gridMode = 'ratio'; }), 'risset.ratio'])),
          cents,
        ]);
      })(),
      p.gridMode === 'pattern' && el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        patternIn,
        el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-400' }, [intervalChk, t('risset.patternInterval')]),
        el('button', { class: 'px-2 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-bold', text: t('risset.applyPattern'), on: { click: applyPattern } }),
      ]),
      el('div', { class: 'flex items-center gap-1.5', dataset: { help: 'risset.grid' } }, [el('span', { class: 'w-24 text-[10px] text-slate-400', text: t('risset.intervalSeq') }), intervalIn, el('button', { class: BTN, text: t('risset.apply'), on: { click: applyInterval } })]),
      el('div', { class: 'flex items-center gap-1.5', dataset: { help: 'risset.grid' } }, [el('span', { class: 'w-24 text-[10px] text-slate-400', text: t('risset.pitchSeq') }), pitchIn, el('button', { class: BTN, text: t('risset.apply'), on: { click: applyPitch } })]),
      presetBtns(GRID_PRESETS.map((pr) => [t(`risset.preset.${pr}`), () => editRisset((d) => Object.assign(d, presetPatch(pr, d.voiceCount, d.spanSemitones))), 'risset.grid'])),
      gridCanvas,
      el('div', { class: 'flex flex-col gap-1', dataset: { help: 'risset.offsets' } }, [
        el('div', { class: 'flex items-center justify-between' }, [el('span', { class: 'text-[10px] text-slate-400', text: t('risset.manualOffsets') }), expandBtn]),
        cells,
      ]),
    ].filter(Boolean));
  }

  function renderGrid() {
    if (!cv.grid) return;
    const params = P();
    const { ctx, w, h } = sizeCanvas2d(cv.grid, 40, 40);
    const pad = { left: 42, right: 12, top: 14, bottom: 20 };
    const plotW = Math.max(20, w - pad.left - pad.right);
    const plotH = Math.max(20, h - pad.top - pad.bottom);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    const maxSt = Math.max(24, params.spanSemitones);
    ctx.font = `9.5px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let st = 0; st <= maxSt; st += 12) {
      const py = pad.top + (1 - st / maxSt) * plotH;
      ctx.strokeStyle = st % 24 === 0 ? 'rgba(71, 85, 105, 0.55)' : 'rgba(51, 65, 85, 0.30)';
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + plotW, py);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${st}st`, pad.left - 5, py);
    }
    const N = params.voiceCount;
    const barW = plotW / N;
    const gap = N > 30 ? 1 : 2.5;
    const labelStep = N > 36 ? 6 : N > 18 ? 3 : 1;
    for (let i = 0; i < N; i++) {
      const frac = clamp(clamp(num(params.offsets[i]), -24, maxSt) / maxSt, 0, 1);
      const bx = pad.left + i * barW + gap;
      const bw = Math.max(2, barW - gap * 2);
      const bh = frac * plotH;
      const by = pad.top + plotH - bh;
      ctx.fillStyle = voiceColor(i);
      ctx.globalAlpha = 0.7;
      ctx.fillRect(bx, by, bw, Math.max(2, bh));
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(bx, by - 1.5, bw, 2.5);
      if (i % labelStep === 0 || i === N - 1) {
        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(String(i + 1), bx + bw / 2, pad.top + plotH + 4);
      }
    }
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  }

  // ---------------------------------------------------------------- local emergence
  function buildLocal() {
    const p = P();
    const on = p.localMode !== 'bypass';
    return el('section', { class: SECTION, dataset: { help: 'risset.local' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-violet-300', text: t('risset.localTitle') }),
        seg(LOCAL_MODES, 'risset.localMode', () => P().localMode, (v) => editRisset((d) => { d.localMode = v; }), 'violet', 'risset.local'),
      ]),
      on && slider('risset.localRate', 'risset.local', () => P().localRateHz, set('localRateHz'), { min: 0.01, max: 10, step: 0.01, autoKey: 'localRateHz', unit: 'Hz', accent: 'accent-violet' }),
      on && slider('risset.localThreshold', 'risset.local', () => P().localThreshold, set('localThreshold'), { min: -1, max: 0.95, step: 0.01, autoKey: 'localThreshold', accent: 'accent-violet' }),
      on && slider('risset.fadeMean', 'risset.local', () => P().fadeMeanMs, set('fadeMeanMs'), { min: 100, max: 8000, step: 10, unit: 'ms', accent: 'accent-violet' }),
      on && slider('risset.fadeDev', 'risset.local', () => P().fadeDevMs, set('fadeDevMs'), { min: 0, max: 4000, step: 10, unit: 'ms', accent: 'accent-violet' }),
      on && slider('risset.bandMin', 'risset.local', () => P().bandMin, set('bandMin'), { min: 0, max: 1, step: 0.01, accent: 'accent-violet' }),
      on && slider('risset.bandMax', 'risset.local', () => P().bandMax, set('bandMax'), { min: 0, max: 1, step: 0.01, accent: 'accent-violet' }),
      on && el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1.5', dataset: { help: 'risset.particles2' } }, [
        slider('risset.fadeCurve', 'risset.particles2', () => P().fadeCurve, set('fadeCurve'), { min: -0.95, max: 0.95, step: 0.01, accent: 'accent-violet' }),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[10px] text-slate-400', text: t('risset.fadeDist') }),
          seg(FADE_DISTS, 'risset.fadeDistKind', () => P().fadeDist, (v) => editRisset((d) => { d.fadeDist = v; }), 'violet', 'risset.particles2'),
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300' }, [
          t('risset.bandHz'),
          ...['bandMinHz', 'bandMaxHz'].map((k) => {
            const i = el('input', { type: 'number', min: 0, max: 20000, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-violet-200' });
            i.addEventListener('change', () => { editRisset((d) => { d[k] = clamp(num(i.value, 0), 0, 20000); }); commit(); });
            syncers.push(() => { if (document.activeElement !== i) i.value = String(P()[k]); });
            return i;
          }),
          el('span', { class: 'text-[10px] text-slate-500', text: t('risset.bandHzHint') }),
        ]),
      ]),
      !on && el('p', { class: 'text-[10px] text-slate-500', text: t('risset.localBypassHint') }),
      el('div', { class: 'border-t border-slate-800 pt-1.5 flex flex-col gap-1.5', dataset: { help: 'risset.mass' } }, [
        el('span', { class: 'text-[11px] font-semibold text-slate-300', text: t('risset.massTitle') }),
        slider('risset.massM0', 'risset.mass', () => P().massM0, set('massM0'), { min: MIN_M0, max: 2, step: 0.001, accent: 'accent-violet' }),
        slider('risset.buoyancy', 'risset.mass', () => P().buoyancy, set('buoyancy'), { min: -2, max: 2, step: 0.01, accent: 'accent-violet' }),
      ]),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- global envelope + PEQ
  function buildEnvPeq() {
    const p = P();
    const eqCanvas = el('canvas', { class: 'w-full h-[110px] rounded-lg bg-slate-950 block', dataset: { help: 'risset.peq' } });
    cv.eq = eqCanvas;
    const envChk = el('input', { type: 'checkbox', class: 'accent-emerald-500', on: { change: (e) => { editRisset((d) => { d.globalEnvEnabled = e.target.checked; }); commit(); } } });
    syncers.push(() => { envChk.checked = !!P().globalEnvEnabled; });
    const nodeRows = p.eqNodes.map((b, idx) => {
      const field = (k, lim, step, cls) => {
        const i = el('input', { type: 'number', min: lim[0], max: lim[1], step, class: `w-16 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-right ${cls}` });
        i.addEventListener('input', () => { if (i.dataset.scrubbing) editRisset((d) => { d.eqNodes[idx][k] = clamp(num(i.value), lim[0], lim[1]); }, { coalesceKey: `risset-eq-${idx}-${k}` }); });
        i.addEventListener('change', () => { editRisset((d) => { d.eqNodes[idx][k] = clamp(num(i.value, d.eqNodes[idx][k]), lim[0], lim[1]); }, { coalesceKey: i.dataset.scrubbing ? `risset-eq-${idx}-${k}` : null }); commit(); });
        syncers.push(() => { const n = P().eqNodes[idx]; if (n && document.activeElement !== i) i.value = String(roundTo(n[k], 2)); });
        return i;
      };
      return el('div', { class: 'bg-slate-950/90 border border-slate-800 rounded-lg p-1.5 flex flex-wrap items-center justify-between gap-1.5 text-[11px] font-mono', dataset: { help: 'risset.peq' } }, [
        el('span', { class: 'text-sky-300 font-bold w-12', text: `Bell ${idx + 1}` }),
        el('label', { class: 'flex items-center gap-1 text-slate-400' }, ['Hz', field('freq', EQ_LIMITS.freq, 1, 'text-slate-100')]),
        el('label', { class: 'flex items-center gap-1 text-slate-400' }, ['dB', field('gain', EQ_LIMITS.gain, 0.1, 'text-emerald-300')]),
        el('label', { class: 'flex items-center gap-1 text-slate-400' }, ['Q', field('q', EQ_LIMITS.q, 0.05, 'text-amber-300')]),
        el('button', { class: 'px-1.5 py-0.5 rounded bg-slate-800 hover:bg-rose-600 text-slate-400 hover:text-white', text: '✕', on: { click: () => { editRisset((d) => { if (d.eqNodes.length > 1) d.eqNodes.splice(idx, 1); }); commit(); } } }),
      ]);
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-emerald-300', text: t('risset.envPeqTitle') }),
        el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help: 'risset.envelope' } }, [envChk, t('risset.envOn')]),
      ]),
      seg(ENV_SHAPES, 'risset.envShape', () => P().envShape, (v) => editRisset((d) => { d.envShape = v; }), 'emerald', 'risset.envelope'),
      slider('risset.envCenter', 'risset.envelope', () => P().envCenter, set('envCenter'), { min: 0.05, max: 0.95, step: 0.01, autoKey: 'envCenter', accent: 'accent-emerald' }),
      slider('risset.envWidth', 'risset.envelope', () => P().envWidth, set('envWidth'), { min: 0.02, max: 1, step: 0.01, autoKey: 'envWidth', accent: 'accent-emerald' }),
      slider('risset.envSkew', 'risset.envelope', () => P().envSkew, set('envSkew'), { min: -0.9, max: 0.9, step: 0.01, autoKey: 'envSkew', accent: 'accent-emerald' }),
      slider('risset.envGamma', 'risset.envelope', () => P().envGamma, set('envGamma'), { min: 0.5, max: 12, step: 0.1, accent: 'accent-emerald' }),
      eqCanvas,
      el('div', { class: 'flex flex-wrap items-center gap-1', dataset: { help: 'risset.peq' } }, [
        p.eqNodes.length < MAX_EQ_NODES && el('button', { class: 'px-2 py-1 rounded-lg bg-sky-600/20 hover:bg-sky-600/40 text-sky-300 border border-sky-500/30 text-[11px] font-semibold', text: t('risset.addBell'), on: { click: () => { editRisset((d) => { d.eqNodes.push(createBellNode()); }); commit(); } } }),
        el('button', { class: BTN, text: t('risset.resetFlat'), on: { click: () => { editRisset((d) => { d.eqNodes = EQ_PRESETS.flat(); }); commit(); } } }),
        ...['comb', 'formant', 'air'].map((k) => el('button', { class: BTN, text: t(`risset.eqPreset.${k}`), dataset: { help: 'risset.peq' }, on: { click: () => { editRisset((d) => { d.eqNodes = EQ_PRESETS[k](); }); commit(); } } })),
      ].filter(Boolean)),
      ...nodeRows,
    ]);
  }

  function renderEq(rt) {
    if (!cv.eq) return;
    const params = P();
    const { ctx, w, h } = sizeCanvas2d(cv.eq, 40, 40);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    const midY = h / 2;
    ctx.strokeStyle = '#334155';
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    // Envelope over the phase axis (x = phase) / 위상축 포락선
    if (params.globalEnvEnabled) {
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const u = i / 100;
        const py = h - 6 - clamp(evalGlobalEnvelope(envOf(params, rt.eff), u), 0, 1) * (h - 14);
        if (i === 0) ctx.moveTo(u * w, py);
        else ctx.lineTo(u * w, py);
      }
      ctx.stroke();
    }
    // True biquad chain response over 20 Hz – 20 kHz (log x) / 실제 바이쿼드 응답
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 160; i++) {
      const u = i / 160;
      const db = eqChainResponseDb(params.eqNodes, 20 * Math.pow(1000, u));
      const py = clamp(midY - (db / 18) * (h * 0.42), 4, h - 4);
      if (i === 0) ctx.moveTo(u * w, py);
      else ctx.lineTo(u * w, py);
    }
    ctx.stroke();
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = '#64748b';
    ctx.textBaseline = 'bottom';
    for (const hz of [100, 1000, 10000]) {
      const x = (Math.log10(hz / 20) / 3) * w;
      ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 2, h - 2);
    }
  }

  // ---------------------------------------------------------------- looping automation
  function buildAutomation() {
    const p = P();
    const autoCanvas = el('canvas', { class: 'w-full h-[150px] rounded-lg bg-slate-950 block', dataset: { help: 'risset.auto' } });
    cv.auto = autoCanvas;
    const pad = { left: 36, right: 12, top: 10, bottom: 18 };
    const metrics = () => {
      const r = autoCanvas.getBoundingClientRect();
      return { r, plotW: Math.max(20, r.width - pad.left - pad.right), plotH: Math.max(20, r.height - pad.top - pad.bottom) };
    };
    const toNorm = (e) => {
      const { r, plotW, plotH } = metrics();
      return { x: clamp((e.clientX - r.left - pad.left) / plotW, 0, 1), y: clamp(1 - (e.clientY - r.top - pad.top) / plotH, 0, 1) };
    };
    const laneEdit = (fn, ck = null) => editRisset((d) => {
      const k = d.activeAutoKey;
      d.autoLanes[k] = d.autoLanes[k] || createFlatLane(true);
      d.autoLanes[k].enabled = true;
      fn(d.autoLanes[k].points, d.autoLanes[k]);
    }, { coalesceKey: ck });
    let drag = null;
    autoCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const q = toNorm(e);
      const lane = P().autoLanes[P().activeAutoKey];
      const pts = lane?.points || createFlatLane().points;
      const i = nearestAnchor(pts, q.x, q.y);
      try { autoCanvas.setPointerCapture(e.pointerId); } catch { /* */ }
      if (i >= 0) { drag = { type: 'anchor', i }; return; }
      // Click on a segment → bend it (create a handle if straight) / 선분 클릭 → 곡률 조절
      const yCurve = evalLane({ points: pts }, q.x);
      const { plotH } = metrics();
      if (Math.abs(yCurve - q.y) * plotH < 10) {
        const seg = findSplineSegmentIndex(pts, q.x);
        const p0 = pts[seg];
        const p1 = pts[seg + 1];
        const u = clamp((q.x - p0.x) / Math.max(1e-9, p1.x - p0.x), 0.05, 0.95);
        laneEdit((ps) => { if (!(ps[seg].handles || []).length) elevateSplineSegmentHandles(ps[seg], ps[seg + 1], u, 4); }, 'risset-auto-bend');
        const cur = P().autoLanes[P().activeAutoKey].points[seg];
        let k = 0;
        let best = Infinity;
        cur.handles.forEach((hh, kk) => { if (Math.abs(hh.u - u) < best) { best = Math.abs(hh.u - u); k = kk; } });
        const { xs } = getSegmentControlArrays(cur, P().autoLanes[P().activeAutoKey].points[seg + 1]);
        const sp = solveSegmentParamS(xs, u);
        const n = xs.length - 1;
        const j = k + 1;
        let binom = 1;
        for (let qq = 1; qq <= j; qq++) binom = (binom * (n - j + qq)) / qq;
        drag = { type: 'bend', seg, k, y0: cur.handles[k].y, raw0: q.y, w: Math.max(0.12, binom * sp ** j * (1 - sp) ** (n - j)) };
      }
    });
    autoCanvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const q = toNorm(e);
      if (drag.type === 'anchor') {
        laneEdit((ps) => {
          const i = drag.i;
          const last = ps.length - 1;
          if (!ps[i]) return;
          ps[i].x = roundTo(i === 0 ? 0 : i === last ? 1 : clamp(q.x, ps[i - 1].x + 0.005, ps[i + 1].x - 0.005), 4);
          ps[i].y = roundTo(q.y, 4);
        }, 'risset-auto-point');
      } else if (drag.type === 'bend') {
        laneEdit((ps) => { const hh = ps[drag.seg]?.handles?.[drag.k]; if (hh) hh.y = roundTo(clamp(drag.y0 + (q.y - drag.raw0) / drag.w, -1, 2), 4); }, 'risset-auto-bend');
      }
    });
    const endDrag = () => { if (drag) commit(); drag = null; };
    autoCanvas.addEventListener('pointerup', endDrag);
    autoCanvas.addEventListener('pointercancel', endDrag);
    autoCanvas.addEventListener('dblclick', (e) => {
      const q = toNorm(e);
      laneEdit((ps) => { const seg = findSplineSegmentIndex(ps, q.x); splitSplineSegmentPreservingShape(ps, seg, q.x); const near = ps.reduce((b, pt, i) => (Math.abs(pt.x - q.x) < Math.abs(ps[b].x - q.x) ? i : b), 0); ps[near].y = roundTo(q.y, 4); });
      commit();
    });
    autoCanvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const q = toNorm(e);
      const pts = P().autoLanes[P().activeAutoKey]?.points;
      if (!pts) return;
      const i = nearestAnchor(pts, q.x, q.y, 0.03, 0.12);
      if (i > 0 && i < pts.length - 1) { laneEdit((ps) => removeSplinePoint(ps, i)); commit(); }
    });

    // Parameter list (add / select / enable) / 파라미터 목록
    const list = el('div', { class: 'flex flex-col gap-1' }, AUTOMATABLE_PARAMS.filter((s) => p.autoLanes[s.key]).map((spec) => {
      const chk = el('input', { type: 'checkbox', class: 'accent-fuchsia-500', on: { change: (e) => { editRisset((d) => { d.autoLanes[spec.key].enabled = e.target.checked; }); commit(); } } });
      const val = el('span', { class: 'font-mono text-[10px] text-emerald-300 shrink-0' });
      frameSyncers.push((rt) => { val.textContent = Number(rt.eff[spec.key]).toFixed(3); });
      const row = el('div', { class: 'flex items-center justify-between gap-2 px-2 py-1 rounded-lg border text-[11px] cursor-pointer', on: { click: (e) => { if (e.target === chk) return; editRisset((d) => { d.activeAutoKey = spec.key; }, { history: false }); } } }, [
        el('div', { class: 'flex items-center gap-2 min-w-0' }, [chk, el('span', { class: 'font-mono font-semibold truncate', text: t(spec.labelKey) })]),
        el('button', { class: 'text-slate-500 hover:text-rose-400 px-1', text: '✕', on: { click: (e) => { e.stopPropagation(); editRisset((d) => { delete d.autoLanes[spec.key]; if (d.activeAutoKey === spec.key) d.activeAutoKey = Object.keys(d.autoLanes)[0] || 'rateHz'; }); commit(); } } }),
        val,
      ]);
      syncers.push(() => {
        const q = P();
        chk.checked = !!q.autoLanes[spec.key]?.enabled;
        row.className = `flex items-center justify-between gap-2 px-2 py-1 rounded-lg border text-[11px] cursor-pointer ${q.activeAutoKey === spec.key ? 'bg-fuchsia-950/50 border-fuchsia-500/60 text-white' : 'bg-slate-900/70 border-slate-800 text-slate-300'}`;
      });
      return row;
    }));
    const addSel = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]' }, AUTOMATABLE_PARAMS.map((s) => el('option', { value: s.key, text: t(s.labelKey) })));
    const selBtn = el('button', { class: 'px-2.5 py-1 rounded-lg text-[11px] font-bold', dataset: { help: 'risset.auto' }, on: { click: () => { selectParamMode = !selectParamMode; syncers.forEach((fn) => fn()); } } });
    syncers.push(() => {
      selBtn.textContent = selectParamMode ? `🎯 ${t('risset.selectOn')}` : `🎯 ${t('risset.selectOff')}`;
      selBtn.className = `px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${selectParamMode ? 'bg-amber-500 text-slate-950 animate-pulse' : 'bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/40'}`;
    });
    const loopIn = el('input', { type: 'number', min: 0.5, max: 120, step: 0.5, class: 'w-16 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
    loopIn.addEventListener('change', () => { editRisset((d) => { d.autoLoopSec = clamp(num(loopIn.value, 8), 0.5, 120); }); commit(); });
    syncers.push(() => { if (document.activeElement !== loopIn) loopIn.value = String(P().autoLoopSec); });
    const activeLbl = el('span', { class: 'text-[11px] font-semibold text-fuchsia-300' });
    syncers.push(() => { activeLbl.textContent = t(getAutomatableSpec(P().activeAutoKey)?.labelKey || 'risset.rate'); });

    return el('section', { class: SECTION, dataset: { help: 'risset.auto' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('h3', { class: 'text-xs font-bold uppercase tracking-wider text-fuchsia-300', text: t('risset.autoTitle') }),
        selBtn,
      ]),
      el('p', { class: 'text-[10px] text-slate-500', text: t('risset.autoDesc') }),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-2' }, [
        el('div', { class: 'flex flex-col gap-1.5' }, [
          el('div', { class: 'flex items-center gap-1' }, [addSel, el('button', { class: BTN, text: t('risset.addParam'), on: { click: () => { const k = addSel.value; editRisset((d) => { d.autoLanes[k] = d.autoLanes[k] || createLane(0.7, true); d.autoLanes[k].enabled = true; d.activeAutoKey = k; }); commit(); } } })]),
          list,
          el('label', { class: 'flex items-center justify-between gap-2 text-[11px] text-slate-300' }, [t('risset.loopSec'), loopIn]),
        ]),
        el('div', { class: 'md:col-span-2 flex flex-col gap-1' }, [
          el('div', { class: 'flex items-center justify-between gap-2' }, [activeLbl, el('div', { class: 'flex gap-1' }, [
            el('button', { class: BTN, text: t('risset.resetCurve'), on: { click: () => { editRisset((d) => { d.autoLanes[d.activeAutoKey] = createFlatLane(true); }); commit(); } } }),
          ])]),
          autoCanvas,
          el('span', { class: 'text-[10px] text-slate-500', text: t('risset.autoHint') }),
        ]),
      ]),
    ]);
  }

  function renderAuto(rt) {
    if (!cv.auto) return;
    const params = P();
    const { ctx, w, h } = sizeCanvas2d(cv.auto, 40, 40);
    const pad = { left: 36, right: 12, top: 10, bottom: 18 };
    const plotW = Math.max(20, w - pad.left - pad.right);
    const plotH = Math.max(20, h - pad.top - pad.bottom);
    ctx.fillStyle = '#020617';
    ctx.fillRect(0, 0, w, h);
    for (const lvl of [0, 0.5, 1]) {
      const py = pad.top + (1 - lvl) * plotH;
      ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)';
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(pad.left + plotW, py);
      ctx.stroke();
    }
    const lane = params.autoLanes[params.activeAutoKey] || createFlatLane(false);
    ctx.strokeStyle = lane.enabled ? '#e879f9' : '#64748b';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const u = i / 200;
      const px = pad.left + u * plotW;
      const py = pad.top + (1 - clamp(evalPiecewiseBezierPoints(lane.points, u), 0, 1)) * plotH;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (let i = 0; i < lane.points.length; i++) {
      const pt = lane.points[i];
      const px = pad.left + pt.x * plotW;
      const py = pad.top + (1 - clamp(pt.y, 0, 1)) * plotH;
      for (const hh of pt.handles || []) {
        const nx = lane.points[i + 1]?.x ?? 1;
        const hx = pad.left + (pt.x + hh.u * (nx - pt.x)) * plotW;
        const hy = pad.top + (1 - clamp(hh.y, -1, 2)) * plotH;
        ctx.fillStyle = 'rgba(232,121,249,0.6)';
        ctx.fillRect(hx - 2.5, hy - 2.5, 5, 5);
      }
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(px, py, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    const { u, loopSec } = loopPosition(rt.autoTimeSec, params.autoLoopSec);
    const phX = pad.left + u * plotW;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(phX, pad.top);
    ctx.lineTo(phX, pad.top + plotH);
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = `9.5px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('0.0s', pad.left, pad.top + plotH + 3);
    ctx.textAlign = 'right';
    ctx.fillText(`Loop ${loopSec.toFixed(1)}s`, pad.left + plotW, pad.top + plotH + 3);
    ctx.strokeStyle = '#1e293b';
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
  }

  // ---------------------------------------------------------------- parameter-select mode
  const onSelectCapture = (e) => {
    if (!selectParamMode) return;
    const target = e.target?.closest?.('[data-auto-key]');
    if (!target || !root.contains(target)) return;
    const k = target.dataset.autoKey;
    editRisset((d) => { d.autoLanes[k] = d.autoLanes[k] || createLane(0.7, true); d.autoLanes[k].enabled = true; d.activeAutoKey = k; });
    commit();
    selectParamMode = false;
    hooks.showToast(t('risset.autoBound', t(getAutomatableSpec(k)?.labelKey || k)));
  };
  root.addEventListener('pointerdown', onSelectCapture, true);

  /** "Toolboxes act on region Mk" banner (only with 2+ regions in region scope). / 영역 범위 배너 */
  function buildScopeBanner() {
    if (!scoped()) return null;
    const p = P();
    const i = p.activeRegion;
    const color = REGION_COLORS[i % REGION_COLORS.length];
    return el('div', { class: 'rounded-xl border px-3 py-2 text-[11px] flex flex-wrap items-center gap-2', style: `border-color:${color};background:rgba(2,6,23,.9)`, dataset: { help: 'risset.regionScope' } }, [
      el('span', { class: 'font-mono font-bold', style: `color:${color}`, text: `M${i + 1}` }),
      el('span', { class: 'text-slate-200', text: t('risset.scopeBanner') }),
      el('span', { class: 'text-slate-500', text: t('risset.scopeShared') }),
      el('button', { class: BTN, text: `🌐 ${t('risset.scopeAll')}`, on: { click: () => { scopeOn = false; key = ''; renderNow(); } } }),
    ]);
  }

  // ---------------------------------------------------------------- build / render
  function build() {
    syncers = [];
    frameSyncers = [];
    Object.keys(cv).forEach((k) => delete cv[k]);
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        el('div', { class: 'lg:col-span-7 flex flex-col gap-3 min-w-0' }, [buildMain(), buildRegions(), buildDynamics(), buildGrid(), buildAutomation()]),
        el('div', { class: 'lg:col-span-5 flex flex-col gap-3 min-w-0' }, [buildScopeBanner(), buildCore(), buildRhythm(), buildLocal(), buildEnvPeq(), buildVoiceMod(), buildTremolo(), buildColor()]),
      ]),
    );
  }

  function structureKey() {
    const p = P();
    return [getLang(), scoped(), p.voiceCount, p.gridMode, p.shapeKind, p.localMode === 'bypass', p.eqNodes.length, Object.keys(p.autoLanes).join(','), p.view.offsetsExpanded, p.regions.length, p.activeRegion, p.colorCtl.target].join('|');
  }

  const onFrame = (rt) => {
    renderMain(rt);
    renderRing(rt);
    renderAuto(rt);
    renderColor(rt);
    frameSyncers.forEach((fn) => fn(rt));
  };
  startRissetLoop(onFrame);

  function renderNow() {
    const k = structureKey();
    if (k !== key) { key = k; build(); }
    syncers.forEach((fn) => fn());
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      syncers.forEach((fn) => fn());
      const rt = getRissetRuntime();
      renderGrid();
      renderEq(rt);
      onFrame(rt);
    },
    destroy() {
      stopRissetLoop();
      root.removeEventListener('pointerdown', onSelectCapture, true);
      root.replaceChildren();
      key = '';
    },
    exportWav: exportRissetWav,
  };
}
