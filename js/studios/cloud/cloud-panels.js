/**
 * Flexatone — studios/cloud/cloud-panels.js
 * Cloud Studio UI tier: workspace DOM (header + actions, scatter + histogram, curve strip,
 * parameter racks). Mounted by ui/studio-host.js when the Cloud tab is active.
 * 클라우드 스튜디오 작업 공간 DOM (헤더·액션, 산점도·히스토그램, 곡선 스트립, 파라미터 랙).
 *
 * Every control carries data-help="cloud.…" (Option/Alt inspector); number inputs are picked up
 * by ui/number-scrub.js. One slider drag = one undo step (coalesceKey + endHistoryGesture).
 * Events are (re)generated here — at edit time, only when the signature changes — and the live
 * scheduler is handed the new cached list; nothing is generated while audio merely plays.
 * 이벤트는 편집 시점(시그니처 변경 시)에만 여기서 생성되고, 재생 중에는 캐시만 전달.
 */

import { clamp, roundTo } from '../../core/math-utils.js';
import { t, getLang } from '../../core/i18n.js';
import { endHistoryGesture } from '../../core/state.js';
import { PARAM_SCHEMAS, schemaVisible, getEngineLabel, captureCurveToCustomPoints } from '../../modules/curve-engine.js';
import { StudioRegistry } from '../registry.js';
import { el, num, setToggle } from '../../ui/panels.js';
import { createStudioControls, STUDIO_BTN as BTN } from '../../ui/studio-controls.js';
import { createLocateButtons } from '../../ui/locate-tool.js';
import { createTrajectoryImportButton } from '../../ui/trajectory-ui.js';
import { createStudioTremoloRack } from '../../ui/studio-tremolo.js';
import { createZoomBar, zoomViewPitch, zoomViewTime } from '../../ui/view-nav.js';
import { createTimbreEditor } from '../../ui/timbre-editor.js';
import { HELP_DB } from '../../ui/option-inspector.js';
import {
  CLOUD_DISTS, DUR_DISTS, ENVELOPES, GLIDE_MODES, PITCH_COMPS, SIEVE_OPS, SIEVE_GRIDS, CURVE_ENGINES, CURVE_KEYS, CURVE_RANGES,
  MAX_EVENTS_LIMIT, MAX_POLY_LIMIT, MAX_LENGTH_SEC, getCurve, getBakeCount,
} from './cloud-engine.js';
import { CLOUD_ID, CLOUD_PRESETS, getCloudParams as getCloudDoc, editCloud as editCloudDoc, getCloudEvents as getCloudEventsOf, applyCloudPreset, getLastVoiceReport } from '../cloud-studio.js';
import { MAX_MODULES, MODULE_COLORS, MODULE_LAYOUTS, MODULE_OWN_KEYS, moduleView, moduleBand, moduleAudible, addModuleTo } from './cloud-modules.js';
import { voiceGainControl } from '../../ui/voice-gain.js';
import { deepClone } from '../../core/math-utils.js';
import { midiToNoteName } from '../../core/units.js';
import { I18N } from '../../core/i18n.js';
import { CLOUD_HELP } from './cloud-i18n.js';
import { createCloudCanvases } from './cloud-canvases.js';
import { exportCloudJson, exportCloudWav, syncCloudLive, isCloudPlaying, getCloudAudioStats, getCloudRenderState, onCloudRenderProgress } from './cloud-audio.js';

// Multi-module strings and help (the same model as the Risset region modules) / 다중 모듈 문자열·도움말
Object.assign(I18N.en, {
  'cloud.mod.title': 'Modules (pitch bands)',
  'cloud.mod.grapher': 'Multi-module grapher',
  'cloud.mod.count': (n) => `${n} modules`,
  'cloud.mod.add': '+ Module',
  'cloud.mod.remove': '− Module',
  'cloud.mod.none': 'One cloud. “+ Module” splits it into pitch bands, each with its own settings (M1 = the cloud as it is now).',
  'cloud.mod.on': 'On',
  'cloud.mod.lo': 'Band bottom',
  'cloud.mod.hi': 'Band top',
  'cloud.mod.full': 'Full',
  'cloud.mod.layoutLbl': 'Grain layout',
  'cloud.mod.layout.pitch': 'Base MIDI / span',
  'cloud.mod.layout.fit': 'Squeezed cloud',
  'cloud.mod.layout.window': 'Window on the cloud',
  'cloud.mod.syncCore': 'Sync the Pitch range (min / max)',
  'cloud.mod.own': 'Own',
  'cloud.mod.ownNone': 'Uses the shared settings',
  'cloud.mod.ownReset': '↺ Use shared',
  'cloud.mod.scopeOn': (m) => `🎯 Toolboxes → ${m}`,
  'cloud.mod.scopeAll': '🌐 Edit shared',
  'cloud.mod.banner': 'Toolboxes act on this module: density, pitch, sieve, glide, duration, gain, polyphony, seed.',
  'cloud.mod.shared': 'Shared by all modules (🌐): length, timbre, tremolo, voice modulation, view, scheduler.',
  'cloud.mod.sharedChip': '🌐 shared',
  'cloud.mod.locate': 'Locate',
  'cloud.mod.solo': 'Solo this module (only soloed modules sound)',
  'cloud.mod.mute': 'Mute this module',
  'cloud.mod.rangeSynced': (m) => `Pitch range = module ${m} (synced)`,
  'cloud.mod.rangeLocked': 'Pitch range locked: the module band sets it',
  'cloud.mod.lockTitle': 'Pitch min / max are locked',
  'cloud.mod.lockBody': (m) => `Module ${m} uses “Base MIDI / span”: its band is its pitch range, so Pitch min and max belong to it. Sync is off, so they are locked. To change them, turn on “Sync the Pitch range” in the Modules toolbox (they then follow the band and move its edges), or pick another grain layout (Squeezed cloud or Window on the cloud).`,
  'cloud.mod.lockSync': 'Turn on sync',
  'cloud.mod.lockFit': 'Use Squeezed cloud',
  'cloud.mod.lockClose': 'Close',
  'cloud.mod.ownKey.seed': 'seed', 'cloud.mod.ownKey.density': 'density', 'cloud.mod.ownKey.pitch': 'pitch', 'cloud.mod.ownKey.glide': 'glide',
  'cloud.mod.ownKey.duration': 'duration', 'cloud.mod.ownKey.gain': 'gain', 'cloud.mod.ownKey.maxEvents': 'max events', 'cloud.mod.ownKey.maxPolyphony': 'polyphony',
});
Object.assign(I18N.ko, {
  'cloud.mod.title': '모듈 (음고 띠)',
  'cloud.mod.grapher': '다중 모듈 그래퍼',
  'cloud.mod.count': (n) => `모듈 ${n}개`,
  'cloud.mod.add': '+ 모듈',
  'cloud.mod.remove': '− 모듈',
  'cloud.mod.none': '구름 하나. “+ 모듈”을 누르면 음고 띠로 나뉘어 띠마다 자체 설정을 가집니다 (M1 = 지금의 구름).',
  'cloud.mod.on': '켜기',
  'cloud.mod.lo': '띠 아래',
  'cloud.mod.hi': '띠 위',
  'cloud.mod.full': '전체',
  'cloud.mod.layoutLbl': '그레인 배치',
  'cloud.mod.layout.pitch': '기준 MIDI·스팬',
  'cloud.mod.layout.fit': '구름 압축',
  'cloud.mod.layout.window': '구름의 창',
  'cloud.mod.syncCore': '음고 범위(최소·최대) 동기화',
  'cloud.mod.own': '자체 값',
  'cloud.mod.ownNone': '공유 설정 사용',
  'cloud.mod.ownReset': '↺ 공유 사용',
  'cloud.mod.scopeOn': (m) => `🎯 툴박스 → ${m}`,
  'cloud.mod.scopeAll': '🌐 공유 설정 편집',
  'cloud.mod.banner': '툴박스가 이 모듈에 작동합니다: 밀도, 음고, 체, 글라이드, 길이, 게인, 폴리포니, 시드.',
  'cloud.mod.shared': '모든 모듈 공유(🌐): 전체 길이, 음색, 트레몰로, 보이스 변조, 보기, 스케줄러.',
  'cloud.mod.sharedChip': '🌐 공유',
  'cloud.mod.locate': 'Locate',
  'cloud.mod.solo': '이 모듈 솔로 (솔로된 모듈만 소리남)',
  'cloud.mod.mute': '이 모듈 뮤트',
  'cloud.mod.rangeSynced': (m) => `음고 범위 = 모듈 ${m} (동기화 중)`,
  'cloud.mod.rangeLocked': '음고 범위 잠김: 모듈 띠가 정함',
  'cloud.mod.lockTitle': '음고 최소·최대가 잠겨 있습니다',
  'cloud.mod.lockBody': (m) => `모듈 ${m}은 “기준 MIDI·스팬” 배치를 씁니다: 띠가 곧 음고 범위이므로 음고 최소·최대는 이 모듈의 것입니다. 동기화가 꺼져 있어 잠겨 있습니다. 바꾸려면 모듈 툴박스에서 “음고 범위(최소·최대) 동기화”를 켜거나(그러면 띠를 따라가며 띠 끝단을 움직입니다), 다른 그레인 배치(구름 압축 또는 구름의 창)를 고르세요.`,
  'cloud.mod.lockSync': '동기화 켜기',
  'cloud.mod.lockFit': '구름 압축으로',
  'cloud.mod.lockClose': '닫기',
  'cloud.mod.ownKey.seed': '시드', 'cloud.mod.ownKey.density': '밀도', 'cloud.mod.ownKey.pitch': '음고', 'cloud.mod.ownKey.glide': '글라이드',
  'cloud.mod.ownKey.duration': '길이', 'cloud.mod.ownKey.gain': '게인', 'cloud.mod.ownKey.maxEvents': '최대 이벤트', 'cloud.mod.ownKey.maxPolyphony': '폴리포니',
});
const mh = (en, ko) => ({ en: { title: en[0], summary: en[1], detail: en[2] || '', formula: '' }, ko: { title: ko[0], summary: ko[1], detail: ko[2] || '', formula: '' } });
HELP_DB['cloud.modules'] = mh(['Cloud modules', 'Split the cloud into up to 6 pitch bands (modules). Each module has its own density, pitch distribution, sieve, glide, duration, gain, polyphony and seed, plus on / S / M / gain. With two or more modules every toolbox acts on the selected module.', 'The same model as the Risset region modules. Band edges are fractions of the cloud\'s pitch range (Pitch min … max of the shared settings). 🌐 Edit shared switches the toolboxes back to the shared settings; ↺ Use shared drops a module\'s own values.'], ['클라우드 모듈', '구름을 최대 6개의 음고 띠(모듈)로 나눕니다. 모듈마다 밀도·음고 분포·체·글라이드·길이·게인·폴리포니·시드와 켜기/S/M/게인을 가집니다. 모듈이 2개 이상이면 모든 툴박스가 선택 모듈에 작동합니다.', '리세 영역 모듈과 같은 모델. 띠 끝단은 구름 음고 범위(공유 설정의 음고 최소…최대)에 대한 비율. 🌐 공유 설정 편집 = 툴박스를 공유 설정으로, ↺ 공유 사용 = 모듈 자체 값 삭제.']);
HELP_DB['cloud.modGrapher'] = mh(['Multi-module grapher', 'One row per module: click a row to select it (the toolboxes then act on it). ☑ on, gain, S solo, M mute; a module that does not sound is drawn dim. ＋ / − add or remove a module.', 'Like the Glissando voice grapher and the Risset multi-region grapher; it sits under the monitor.'], ['다중 모듈 그래퍼', '모듈마다 한 줄: 줄을 클릭하면 선택(툴박스가 그 모듈에 작동). ☑ 켜기, 게인, S 솔로, M 뮤트; 소리 나지 않는 모듈은 어둡게. ＋ / −로 추가·삭제.', '글리산도 다중 보이스 그래퍼, 리세 다중 영역 그래퍼와 같으며 모니터 아래에 있습니다.']);
HELP_DB['cloud.modLayout'] = mh(['Grain layout of a module', 'Base MIDI / span (default): the band is the module\'s own pitch range — its grains are drawn inside it (base MIDI = the band\'s bottom, span = its height). Squeezed cloud: the module\'s cloud is drawn over its own full pitch range and squeezed into the band. Window on the cloud: the module\'s cloud is drawn as is and only the grains that start inside the band sound.', 'Why a window thins out: a band narrower than the cloud\'s spread only catches the few grains that happen to start inside it.'], ['모듈 그레인 배치', '기준 MIDI·스팬(기본): 띠가 모듈 자체 음고 범위 — 그레인이 그 안에서 뽑힘(기준 MIDI = 띠 아래, 스팬 = 높이). 구름 압축: 모듈 구름을 자체 전체 음고 범위에서 뽑아 띠에 압축. 구름의 창: 모듈 구름을 그대로 뽑고 띠 안에서 시작하는 그레인만 소리남.', '창이 성기는 이유: 구름 분포보다 좁은 띠에는 우연히 그 안에서 시작하는 몇몇 그레인만 걸립니다.']);
HELP_DB['cloud.modSync'] = mh(['Sync the Pitch range', 'With “Base MIDI / span” the selected module\'s band is its pitch range. On (default): Pitch min / max in the Pitch toolbox show the band live and edit its edges. Off: they are locked; touching them explains how to unlock.', 'The cloud\'s whole pitch range (the frame of the bands) is the shared Pitch min / max (🌐 Edit shared).'], ['음고 범위 동기화', '“기준 MIDI·스팬”에서는 선택 모듈의 띠가 곧 음고 범위. 켜짐(기본): 음고 툴박스의 최소·최대가 띠를 실시간으로 보여 주고 띠 끝단을 편집. 꺼짐: 잠기며, 건드리면 푸는 방법을 안내.', '띠들의 기준이 되는 구름 전체 음고 범위는 공유 설정의 음고 최소·최대(🌐 공유 설정 편집).']);
HELP_DB['cloud.modLocate'] = mh(['Locate (module bands)', 'While on, drag a band edge on the monitor to move it, or drag inside a band to move the whole band; clicking a band selects its module.', 'Off: dragging the monitor pans the view as before.'], ['Locate (모듈 띠)', '켜져 있는 동안 모니터에서 띠 끝단을 끌면 그 끝단이, 띠 안을 끌면 띠 전체가 이동; 띠를 클릭하면 그 모듈 선택.', '끄면 예전처럼 모니터 드래그 = 보기 이동.']);

// Help entries (en / ko) for the Option-inspector. / 도움말 등록
for (const [key, entry] of Object.entries(CLOUD_HELP)) HELP_DB[key] = entry;

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const BADGE = 'px-2 py-0.5 rounded-full text-[11px] font-mono border';
const H3 = (key, color, help) => el('h3', { class: `text-xs font-bold uppercase tracking-wider ${color}`, text: t(key), dataset: help ? { help } : undefined });

/**
 * Mount the Cloud workspace into `root`. / 클라우드 작업 공간 마운트
 * @returns {{ render: (scopes: Set<string>) => void, destroy: () => void, fit: () => void }}
 */
export function mountCloudWorkspace(root, hooks) {
  // ------------------------------------------------------------------ multi-module scope (cloud-modules.js)
  // With 2+ modules every toolbox acts on the selected module, like the Risset region modules: its own
  // settings go to module.own, shared ones (length, timbre, tremolo, view …) to the document.
  // 모듈이 2개 이상이면 모든 툴박스가 선택 모듈에 작동 (리세 영역과 같음): 자체 설정은 module.own, 공유 설정은 문서로.
  let scopeOn = true;
  let locateOn = false;
  const scoped = () => scopeOn && getCloudDoc().modules.length >= 2;
  const activeMod = (d) => d.modules[d.activeModule] || d.modules[0];
  const getCloudParams = () => {
    const d = getCloudDoc();
    return scoped() ? { ...moduleView(d, activeMod(d)), modules: d.modules, activeModule: d.activeModule } : d;
  };
  const getCloudEvents = () => getCloudEventsOf(getCloudDoc()); // always the whole cloud / 항상 전체 구름
  const editCloud = (fn, opts) => {
    if (!scoped()) return editCloudDoc(fn, opts);
    let locked = false;
    const res = editCloudDoc((d) => {
      const m = activeMod(d);
      const before = moduleView(d, m);
      const v = moduleView(d, m);
      fn(v);
      for (const k of Object.keys(v)) {
        if (MODULE_OWN_KEYS.includes(k) || k === 'modules' || k === 'activeModule') continue;
        if (JSON.stringify(v[k]) !== JSON.stringify(before[k])) d[k] = deepClone(v[k]); // shared / 공유
      }
      for (const k of MODULE_OWN_KEYS) {
        if (JSON.stringify(v[k]) === JSON.stringify(before[k])) continue;
        if (k !== 'pitch') { m.own[k] = deepClone(v[k]); continue; }
        const pv = deepClone(v.pitch);
        if (m.layout === 'pitch') {
          // the band is the module's pitch range: min / max move its edges (synced) or are locked
          // 띠 = 모듈 음고 범위: min / max는 띠 끝단을 움직이거나(동기화) 잠김
          if (pv.min !== before.pitch.min || pv.max !== before.pitch.max) {
            if (m.syncCore) {
              const a = d.pitch.min;
              const span = Math.max(1e-6, d.pitch.max - a);
              m.lo = clamp((Math.min(pv.min, pv.max) - a) / span, 0, 0.99);
              m.hi = clamp((Math.max(pv.min, pv.max) - a) / span, m.lo + 0.01, 1);
            } else locked = true;
          }
          delete pv.min;
          delete pv.max;
        }
        m.own.pitch = pv;
      }
    }, opts);
    if (locked) showRangeLock();
    return res;
  };
  let syncers = [];
  let key = '';
  let canvases = null;
  let lastReport = null;
  const commit = () => endHistoryGesture();
  const offProgress = onCloudRenderProgress(() => hooks.requestRender(['studio']));

  // ------------------------------------------------------------------ control helpers
  const { slider, toggle, select, labelled, segment: sharedSegment } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help) => `cloud:${label}:${help}` });
  const seg = (help, options, get, set, color) => sharedSegment(help, options.map(([value, labelKey]) => [value, t(labelKey)]), get, set, color); // options: [value, i18n key]
  /** Getter / setter on a dotted path of the document. / 점 경로 접근자 */
  const path = (p) => {
    const parts = p.split('.');
    const read = (d) => parts.reduce((o, k) => o?.[k], d);
    return {
      get: () => num(read(getCloudParams())),
      set: (val, ck) => editCloud((d) => { const o = parts.slice(0, -1).reduce((x, k) => x[k], d); o[parts[parts.length - 1]] = val; }, { coalesceKey: ck }),
      getRaw: () => read(getCloudParams()),
      setRaw: (val) => editCloud((d) => { const o = parts.slice(0, -1).reduce((x, k) => x[k], d); o[parts[parts.length - 1]] = val; }),
    };
  };
  const sl = (labelKey, help, p, opts) => { const a = path(p); return slider(labelKey, help, a.get, a.set, opts); };
  const intSl = (labelKey, help, p, opts) => { const a = path(p); return slider(labelKey, help, a.get, (v, ck) => a.set(Math.round(v), ck), opts); };
  const setView = (fn) => editCloud((d) => fn(d.view), { history: false });

  // ------------------------------------------------------------------ header
  function buildHeader() {
    const evBadge = el('span', { class: `${BADGE} bg-sky-500/10 text-sky-200 border-sky-500/30`, dataset: { help: 'cloud.badges' } });
    const bakeBadge = el('span', { class: `${BADGE} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`, dataset: { help: 'cloud.badges' } });
    const audioBadge = el('span', { class: `${BADGE} bg-slate-800 text-slate-300 border-slate-700`, dataset: { help: 'cloud.sched' } });
    const laneBadge = el('span', { class: `${BADGE} bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-500/30 hidden`, dataset: { help: 'cloud.bakeGliss' } });
    const statLine = el('span', { class: 'text-[11px] text-slate-400 font-mono', dataset: { help: 'cloud.badges' } });
    syncers.push(() => {
      const p = getCloudParams();
      const ev = getCloudEvents(p);
      evBadge.textContent = t('cloud.badge.events', ev.n, roundTo(ev.n / p.length, 1), ev.stats.maxOverlap);
      bakeBadge.textContent = t('cloud.badge.bake', getBakeCount());
      const s = getCloudAudioStats();
      const r = getCloudRenderState();
      audioBadge.textContent = r.active ? t('cloud.badge.render', Math.round(r.frac * 100)) : t('cloud.badge.audio', s.scheduled, s.skipped, s.pool, s.tickAvgMs.toFixed(2), s.tickMaxMs.toFixed(2));
      if (lastReport) { laneBadge.classList.remove('hidden'); laneBadge.textContent = t('cloud.badge.lanes', lastReport.lanes, lastReport.voices, lastReport.dropped); }
      statLine.textContent = `${t('cloud.stats', ev.stats.generated, ev.stats.droppedPoly, ev.stats.droppedSieve)}${ev.stats.truncated ? ` · ${t('cloud.truncated')}` : ''}`;
    });

    const seedInput = el('input', { type: 'number', min: 0, max: 999999, step: 1, class: 'w-20 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200', dataset: { help: 'cloud.seed' } });
    seedInput.addEventListener('change', () => { editCloud((d) => { d.seed = clamp(Math.round(num(seedInput.value, d.seed)), 0, 999999); }); commit(); });
    syncers.push(() => { if (document.activeElement !== seedInput) seedInput.value = String(getCloudParams().seed); });
    const reseed = () => {
      // The UI picks a new seed; generation itself stays fully seeded. / UI가 새 시드 선택 (생성은 시드 결정적)
      const s = Math.floor(Math.random() * 1e6);
      editCloud((d) => { d.seed = s; });
      commit();
      hooks.showToast(t('cloud.reseeded', s));
    };
    const presetSel = el('select', { class: 'bg-slate-950 border border-slate-700 rounded px-1.5 py-1 text-[11px]', dataset: { help: 'cloud.preset' }, on: { change: (e) => {
      const id = e.target.value;
      if (!id) return;
      applyCloudPreset(id);
      commit();
      e.target.value = '';
      fitCloud();
      hooks.showToast(t('cloud.presetApplied', t(`cloud.preset.${id}`)));
    } } }, [el('option', { value: '', text: t('cloud.preset.choose') }), ...CLOUD_PRESETS.map((p) => el('option', { value: p.id, text: t(`cloud.preset.${p.id}`) }))]);
    const bake = (mode) => {
      const res = StudioRegistry.bakeVoices(CLOUD_ID, { mode });
      const rep = getLastVoiceReport();
      if (!res.result?.length || !rep) { hooks.showToast(t('cloud.bakeEmpty'), 'error'); return; }
      lastReport = rep;
      hooks.showToast(t('cloud.bakedToGliss', rep.voices, rep.lanes, rep.kept, rep.dropped));
    };
    const wav = async () => {
      hooks.showToast(t('toast.wavStart'));
      try {
        const res = await exportCloudWav();
        hooks.showToast(res.ok ? t('cloud.wavDone', res.filename, (20 * Math.log10(Math.max(1e-9, res.peak))).toFixed(1)) : res.message, res.ok ? 'info' : 'error');
      } catch (err) {
        console.error(err);
        hooks.showToast(String(err.message || err), 'error');
      }
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [
        el('div', { class: 'flex flex-wrap items-center gap-2' }, [
          el('h2', { class: 'text-xs font-bold uppercase tracking-wider text-sky-300', text: t('cloud.title'), dataset: { help: 'cloud.overview' } }),
          evBadge, bakeBadge, audioBadge, laneBadge,
        ]),
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
          el('span', { class: 'text-[11px] text-slate-400', text: t('cloud.seed') }), seedInput,
          el('button', { class: BTN, text: `🎲 ${t('cloud.reseed')}`, dataset: { help: 'cloud.seed' }, on: { click: reseed } }),
          presetSel,
          createTrajectoryImportButton('cloud'), // Glissando trajectory → this studio's base line / 글리산도 궤적 불러오기
          el('button', { class: 'px-2.5 py-1 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-[11px] font-semibold', text: `⇪ ${t('cloud.bakeGliss')}`, dataset: { help: 'cloud.bakeGliss' }, on: { click: () => bake('replace') } }),
          el('button', { class: BTN, text: t('cloud.bakeAppend'), dataset: { help: 'cloud.bakeGliss' }, on: { click: () => bake('append') } }),
          el('button', { class: BTN, text: `⤓ ${t('cloud.exportJson')}`, dataset: { help: 'cloud.exportJson' }, on: { click: () => { exportCloudJson(); hooks.showToast(t('cloud.jsonDone')); } } }),
          el('button', { class: BTN, text: `⤓ ${t('cloud.exportWav')}`, dataset: { help: 'cloud.exportWav' }, on: { click: wav } }),
        ]),
      ]),
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [statLine, el('span', { class: 'text-[11px] text-slate-500', text: t('cloud.subtitle') })]),
    ]);
  }

  // ------------------------------------------------------------------ canvas column
  function buildCanvasCol(params) {
    const hud = {
      time: el('span', { class: 'text-sky-300', text: '—' }),
      note: el('span', { class: 'text-emerald-300', text: '—' }),
      hz: el('span', { class: 'text-amber-300', text: '—' }),
      active: el('span', { class: 'text-rose-300', text: '0' }),
      hist: el('span', { class: 'text-slate-400' }),
      curveVal: el('span', { class: 'text-slate-200' }),
    };
    const main = el('canvas', { class: 'w-full h-[420px] rounded-lg bg-slate-950 block min-w-0', dataset: { help: 'cloud.canvas' } });
    mainCanvas = main;
    const locateBtn = el('button', { class: `fx-toggle ${BTN}`, dataset: { help: 'cloud.modLocate' }, text: `📍 ${t('cloud.mod.locate')}`, on: { click: () => { locateOn = !locateOn; setToggle(locateBtn, locateOn); hooks.requestRender(['studio']); } } });
    syncers.push(() => { setToggle(locateBtn, locateOn); locateBtn.classList.toggle('hidden', !getCloudDoc().modules.length); });
    const hist = el('canvas', { class: 'w-[110px] shrink-0 h-[420px] rounded-lg bg-slate-950 block', dataset: { help: 'cloud.hist' } });
    const strip = el('canvas', { class: 'w-full h-[130px] rounded-lg bg-slate-950 block', dataset: { help: 'cloud.strip' } });
    const zoom = (fn) => () => setView(fn);
    const toolbar = el('div', { class: 'flex flex-wrap items-center gap-1.5', dataset: { help: 'cloud.zoom' } }, [
      // Shared zoom toolbar (ui/view-nav.js) / 공용 줌 툴바
      el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [...createLocateButtons({ unavailable: 'locate.na.generated' }), createZoomBar({ onPitch: (f) => setView((vw) => zoomViewPitch(vw, f)), onTime: (f) => setView((vw) => zoomViewTime(vw, f)), onBoth: (f) => setView((vw) => { zoomViewTime(vw, f); zoomViewPitch(vw, f); }), onFit: () => fitCloud() })]), // Locate has nothing to move here: off, with the reason / 이동 도구: 꺼진 채 이유 표시
      locateBtn,
      el('span', { class: 'ml-auto text-[11px] text-slate-500', text: t('cloud.canvasHint') }),
    ]);
    const hudRow = el('div', { class: 'flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400' }, [
      el('span', {}, ['t ', hud.time]), el('span', {}, ['♪ ', hud.note]), el('span', {}, [hud.hz]),
      el('span', { dataset: { help: 'cloud.canvas' } }, [`${t('cloud.hud.active')} `, hud.active]),
      el('span', { class: 'ml-auto', dataset: { help: 'cloud.hist' } }, [hud.hist]),
    ]);
    canvases = createCloudCanvases({ main, hist, strip, hud }, { requestRender: hooks.requestRender, edit: editCloud, overlay: drawModuleBands, pointer: modulePointer });
    return el('div', { class: 'lg:col-span-8 flex flex-col gap-3 min-w-0' }, [
      el('section', { class: SECTION }, [toolbar, hudRow, el('div', { class: 'flex gap-2 min-w-0' }, [el('div', { class: 'flex-1 min-w-0' }, [main]), hist])]),
      buildModuleGrapher(),
      buildCurveSection(params, strip, hud),
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------ curve section
  function buildCurveSection(params, strip, hud) {
    const tab = params.view.curveTab;
    const curve = getCurve(params, tab);
    const r = CURVE_RANGES[tab];
    const getC = () => getCurve(getCloudParams(), tab);
    const editC = (fn, ck = null) => editCloud((d) => fn(getCurve(d, tab), d), { coalesceKey: ck });
    const tabs = seg('cloud.strip', CURVE_KEYS.map((k) => [k, `cloud.curve.${k}`]), () => getCloudParams().view.curveTab, (k) => setView((vw) => { vw.curveTab = k; }), 'sky');
    const engineSel = select('cloud.curveEngine', CURVE_ENGINES.map((id) => [id, id === 'custom' ? t('cloud.curve.customLinear') : getEngineLabel(id)]), () => getC().engine, (val) => editC((c) => { c.engine = val; }));
    const parts = [];
    for (const s of PARAM_SCHEMAS[curve.engine] || []) {
      if (!schemaVisible(s, curve)) continue;
      if (s.type === 'range') {
        parts.push(slider(s.labelKey, `engine.${curve.engine}`, () => num(getC()[s.key], s.default), (val, ck) => editC((c) => { c[s.key] = s.integer ? Math.round(val) : val; }, ck), { min: s.softMin, max: s.softMax, step: s.step, accent: 'accent-sky' }));
      } else if (s.type === 'toggle') {
        parts.push(toggle(s.labelKey, `engine.${curve.engine}`, () => !!(getC()[s.key] ?? s.default), () => { editC((c) => { c[s.key] = !(c[s.key] ?? s.default); }); commit(); }));
      } else if (s.type === 'select') {
        parts.push(labelled(s.labelKey, select(`engine.${curve.engine}`, s.options.map((o) => [o.value, t(o.labelKey)]), () => getC()[s.key] ?? s.default, (val) => editC((c) => { c[s.key] = val; })), `engine.${curve.engine}`));
      }
    }
    const toCustom = () => {
      editC((c) => {
        const pts = captureCurveToCustomPoints(c, { tolerance: 0.003, maxAnchors: 24, includeTransforms: true });
        Object.assign(c, { engine: 'custom', customPoints: pts, reverse: false, inverse: false });
      });
      commit();
    };
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        H3('cloud.curvesTitle', 'text-sky-300', 'cloud.strip'),
        tabs,
        el('span', { class: 'text-[11px] font-mono text-slate-400', dataset: { help: 'cloud.strip' } }, [`${t('cloud.curve.now')} `, hud.curveVal]),
      ]),
      strip,
      el('span', { class: 'text-[11px] text-slate-500', text: curve.engine === 'custom' ? t('cloud.stripHint') : t('cloud.stripHintEngine') }),
      el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5' }, [
        labelled('cloud.curve.engine', engineSel, 'cloud.curveEngine'),
        el('div', { class: 'flex flex-wrap gap-1 justify-end' }, [
          toggle('cloud.curve.reverse', 'cloud.curveEngine', () => !!getC().reverse, () => { editC((c) => { c.reverse = !c.reverse; }); commit(); }),
          toggle('cloud.curve.inverse', 'cloud.curveEngine', () => !!getC().inverse, () => { editC((c) => { c.inverse = !c.inverse; }); commit(); }),
          curve.engine !== 'custom' ? el('button', { class: BTN, text: t('cloud.curve.toCustom'), dataset: { help: 'cloud.curveEngine' }, on: { click: toCustom } }) : null,
          el('button', { class: BTN, text: t('cloud.curve.flat'), dataset: { help: 'cloud.curveRange' }, on: { click: () => { editC((c) => { c.hi = c.lo; }); commit(); } } }),
        ]),
        slider('cloud.curve.lo', `cloud.curve.${tab}`, () => num(getC().lo), (v, ck) => editC((c) => { c.lo = v; }, ck), { min: r.min, max: r.max, step: r.step, unit: r.unit }),
        slider('cloud.curve.hi', `cloud.curve.${tab}`, () => num(getC().hi), (v, ck) => editC((c) => { c.hi = v; }, ck), { min: r.min, max: r.max, step: r.step, unit: r.unit }),
        ...parts,
      ]),
    ]);
  }

  function fitCloud() {
    const p = getCloudParams();
    const ev = getCloudEvents(p);
    let lo = 127;
    let hi = 0;
    for (let i = 0; i < ev.n; i++) { lo = Math.min(lo, ev.p0[i], ev.p1[i]); hi = Math.max(hi, ev.p0[i], ev.p1[i]); }
    if (!ev.n) { lo = p.pitch.min; hi = p.pitch.max; }
    setView((vw) => { Object.assign(vw, { tMin: 0, tMax: p.length, midiMin: Math.max(0, Math.floor(lo - 4)), midiMax: Math.min(127, Math.ceil(hi + 4)) }); });
  }


  // ------------------------------------------------------------------ modules (bands) / 모듈 (띠)
  const modColor = (i) => MODULE_COLORS[i % MODULE_COLORS.length];
  const editDoc = (fn) => { editCloudDoc(fn); commit(); };
  const addModule = () => { scopeOn = true; editDoc((d) => { addModuleTo(d); }); };
  const removeModule = () => editDoc((d) => {
    if (!d.modules.length) return;
    d.modules.splice(d.activeModule, 1);
    if (d.modules.length === 1 && d.modules[0].lo <= 0 && d.modules[0].hi >= 1 && !Object.keys(d.modules[0].own).length) d.modules = []; // back to one cloud / 다시 단일 구름
    d.activeModule = Math.max(0, Math.min(d.modules.length - 1, d.activeModule - 1));
  });
  const selectModule = (i) => { if (!scopeOn) { scopeOn = true; key = ''; } editCloudDoc((d) => { d.activeModule = i; }, { history: false }); };

  /** Bands on the window (overlay of the main view). / 윈도우의 띠 */
  function drawModuleBands(ctx, m, params, PAD) {
    const d = getCloudDoc();
    if (!d.modules.length) return;
    d.modules.forEach((mod, i) => {
      const { b0, b1 } = moduleBand(d, mod);
      const yTop = m.midiToY(b1);
      const yBot = m.midiToY(b0);
      const on = moduleAudible(mod, d.modules);
      const act = i === d.activeModule;
      ctx.fillStyle = modColor(i);
      ctx.globalAlpha = on ? (act ? 0.1 : 0.05) : 0.02;
      ctx.fillRect(PAD.left, yTop, m.plotW, yBot - yTop);
      ctx.globalAlpha = on ? 0.85 : 0.25;
      ctx.strokeStyle = modColor(i);
      ctx.lineWidth = act ? 1.6 : 1;
      ctx.setLineDash(locateOn ? [] : [5, 4]);
      for (const y of [yTop, yBot]) { ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + m.plotW, y); ctx.stroke(); }
      ctx.setLineDash([]);
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.fillText(`M${i + 1}`, PAD.left + 4, yTop + 11);
      ctx.globalAlpha = 1;
    });
  }

  /** Locate on the bands: edges resize, inside moves; a click selects the module. / 띠 Locate */
  let bandDrag = null;
  const modulePointer = {
    down(e, m, p) {
      if (!locateOn || e.button !== 0) return false;
      const d = getCloudDoc();
      if (!d.modules.length) return false;
      const order = [d.activeModule, ...d.modules.map((_, i) => i).filter((i) => i !== d.activeModule)];
      let hit = null;
      for (const i of order) { const { b0, b1 } = moduleBand(d, d.modules[i]); if (Math.abs(p.y - m.midiToY(b1)) <= 7) { hit = { i, field: 'hi' }; break; } if (Math.abs(p.y - m.midiToY(b0)) <= 7) { hit = { i, field: 'lo' }; break; } }
      if (!hit) for (const i of order) { const { b0, b1 } = moduleBand(d, d.modules[i]); const mm = m.yToMidi(p.y); if (mm > b0 && mm < b1) { hit = { i, field: 'move' }; break; } }
      if (!hit) return false;
      const mod = d.modules[hit.i];
      bandDrag = { ...hit, m0: m.yToMidi(p.y), lo0: mod.lo, hi0: mod.hi, frame: [d.pitch.min, d.pitch.max] };
      if (d.activeModule !== hit.i) selectModule(hit.i);
      return true;
    },
    move(e, m, p, owned) {
      if (!locateOn) { els().main.style.cursor = ''; return false; }
      const d = getCloudDoc();
      if (!owned || !bandDrag) {
        let cur = '';
        for (const mod of d.modules) { const { b0, b1 } = moduleBand(d, mod); if (Math.abs(p.y - m.midiToY(b0)) <= 7 || Math.abs(p.y - m.midiToY(b1)) <= 7) { cur = 'ns-resize'; break; } if (m.yToMidi(p.y) > b0 && m.yToMidi(p.y) < b1) cur = 'grab'; }
        els().main.style.cursor = cur;
        return false;
      }
      const { i, field, lo0, hi0, m0, frame } = bandDrag;
      const dp = (m.yToMidi(p.y) - m0) / Math.max(1e-6, frame[1] - frame[0]);
      let lo = lo0;
      let hi = hi0;
      if (field === 'lo') lo = clamp(lo0 + dp, 0, hi0 - 0.01);
      else if (field === 'hi') hi = clamp(hi0 + dp, lo0 + 0.01, 1);
      else { const dd = clamp(dp, -lo0, 1 - hi0); lo = lo0 + dd; hi = hi0 + dd; }
      editCloudDoc((dd) => { const mod = dd.modules[i]; if (mod) { mod.lo = roundTo(lo, 4); mod.hi = roundTo(hi, 4); } }, { coalesceKey: 'cloud-mod-locate' });
      return true;
    },
    up() { if (bandDrag) commit(); bandDrag = null; },
  };
  let mainCanvas = null;
  const els = () => ({ main: mainCanvas || document.createElement('canvas') });

  /** Pitch min / max are locked (Base MIDI / span, not synced): explain the two ways out. / 잠금 안내 */
  function showRangeLock() {
    if (document.getElementById('cloudRangeLock')) return;
    const d = getCloudDoc();
    const i = d.activeModule;
    const close = () => box.remove();
    const btn = (text, cls, fn) => el('button', { class: `px-2.5 py-1 rounded-lg text-xs font-semibold border ${cls}`, text, on: { click: () => { fn(); close(); } } });
    const box = el('div', { id: 'cloudRangeLock', class: 'fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4', on: { click: (e) => { if (e.target === box) close(); } } }, [
      el('div', { class: 'max-w-md rounded-xl border border-amber-700/70 bg-slate-900 p-4 text-slate-200 shadow-2xl flex flex-col gap-2', role: 'dialog' }, [
        el('h3', { class: 'text-sm font-bold text-amber-200', text: `🔒 ${t('cloud.mod.lockTitle')}` }),
        el('p', { class: 'text-[12px] leading-relaxed', text: t('cloud.mod.lockBody', `M${i + 1}`) }),
        el('div', { class: 'flex flex-wrap gap-1.5 justify-end' }, [
          btn(`↔ ${t('cloud.mod.lockSync')}`, 'bg-teal-700 border-teal-500 text-white hover:bg-teal-600', () => editDoc((dd) => { const mod = dd.modules[i]; if (mod) mod.syncCore = true; })),
          btn(t('cloud.mod.lockFit'), 'bg-slate-800 border-slate-600 hover:bg-slate-700', () => editDoc((dd) => { const mod = dd.modules[i]; if (mod) mod.layout = 'fit'; })),
          btn(t('cloud.mod.lockClose'), 'bg-slate-800 border-slate-700 hover:bg-slate-700', () => {}),
        ]),
      ]),
    ]);
    document.body.append(box);
  }

  /** The pitch range lock: a note and (locked) a veil over Pitch min / max. / 음고 범위 표시·잠금 */
  function rangeGuard(child) {
    const state = () => { const d = getCloudDoc(); if (!scoped()) return null; const mod = activeMod(d); return mod.layout === 'pitch' ? { mod, i: d.activeModule } : null; };
    const note = el('div', { class: 'text-[10px] font-mono rounded px-1.5 py-0.5 hidden', dataset: { help: 'cloud.modSync' } });
    const veil = el('div', { class: 'absolute inset-0 z-[3] cursor-not-allowed rounded-lg bg-slate-950/55 hidden', title: t('cloud.mod.rangeLocked'), on: { pointerdown: (e) => { e.preventDefault(); e.stopPropagation(); showRangeLock(); } } });
    syncers.push(() => {
      const q = state();
      note.classList.toggle('hidden', !q);
      veil.classList.toggle('hidden', !q || q.mod.syncCore);
      if (q) {
        note.textContent = q.mod.syncCore ? `↔ ${t('cloud.mod.rangeSynced', `M${q.i + 1}`)}` : `🔒 ${t('cloud.mod.rangeLocked')}`;
        note.className = `text-[10px] font-mono rounded px-1.5 py-0.5 ${q.mod.syncCore ? 'bg-teal-950/60 text-teal-200 border border-teal-800/70' : 'bg-amber-950/50 text-amber-200 border border-amber-800/60'}`;
      }
    });
    return el('div', { class: 'flex flex-col gap-1' }, [note, el('div', { class: 'relative' }, [child, veil])]);
  }

  /** In module scope, mark a toolbox that acts on every module with 🌐. / 공유 툴박스 표시 */
  function shared(section) {
    if (!section || !scoped()) return section;
    const head = section.querySelector('h3')?.parentElement === section ? section.querySelector('h3') : section.firstElementChild;
    const chip = el('span', { class: 'ml-2 px-1.5 py-0.5 rounded border border-slate-600 bg-slate-800 text-[10px] text-slate-300 whitespace-nowrap normal-case tracking-normal', text: t('cloud.mod.sharedChip'), title: t('cloud.mod.shared'), dataset: { help: 'cloud.modules' } });
    head?.append(chip);
    return section;
  }

  /** Modules toolbox: tabs, add / remove, layout, sync, band edges. / 모듈 툴박스 */
  function buildModuleRack() {
    const d0 = getCloudDoc();
    const showWhen = (node, fn) => { syncers.push(() => node.classList.toggle('hidden', !fn())); return node; };
    const M = () => { const d = getCloudDoc(); return activeMod(d); };
    const setM = (k) => (val, ck) => editCloudDoc((d) => { const mod = activeMod(d); if (mod) mod[k] = val; }, { coalesceKey: ck });
    const check = (labelKey, field, help) => {
      const i = el('input', { type: 'checkbox', class: 'accent-emerald-500', on: { change: (e) => editDoc((d) => { const mod = activeMod(d); if (mod) mod[field] = e.target.checked; }) } });
      syncers.push(() => { i.checked = !!M()?.[field]; });
      return el('label', { class: 'flex items-center gap-1 text-[11px] text-slate-300', dataset: { help } }, [i, t(labelKey)]);
    };
    const tabs = el('div', { class: 'flex flex-wrap items-center gap-1' }, [
      ...d0.modules.map((_, i) => {
        const b = el('button', { class: 'px-2 py-0.5 rounded text-[11px] font-mono font-semibold border transition', text: `M${i + 1}`, on: { click: () => selectModule(i) } });
        syncers.push(() => { const d = getCloudDoc(); const on = d.activeModule === i; b.style.borderColor = modColor(i); b.style.background = on ? modColor(i) : 'transparent'; b.style.color = on ? '#020617' : modColor(i); b.style.opacity = d.modules[i]?.enabled ? '1' : '0.45'; });
        return b;
      }),
      d0.modules.length < MAX_MODULES ? el('button', { class: BTN, text: t('cloud.mod.add'), dataset: { help: 'cloud.modules' }, on: { click: addModule } }) : null,
      d0.modules.length ? el('button', { class: `${BTN} hover:bg-rose-600`, text: t('cloud.mod.remove'), dataset: { help: 'cloud.modules' }, on: { click: removeModule } }) : null,
    ].filter(Boolean));
    if (!d0.modules.length) return el('section', { class: SECTION, dataset: { help: 'cloud.modules', rack: 'cloud-modules' } }, [el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [H3('cloud.mod.title', 'text-teal-300', 'cloud.modules'), tabs]), el('p', { class: 'text-[10.5px] text-slate-400', text: t('cloud.mod.none') })]);
    const rangeTag = el('span', { class: 'font-mono text-[10px] text-emerald-300' });
    syncers.push(() => { const d = getCloudDoc(); const mod = activeMod(d); if (!mod) return; const { b0, b1 } = moduleBand(d, mod); rangeTag.textContent = `${midiToNoteName(Math.round(b0))} – ${midiToNoteName(Math.round(b1))}`; });
    const ownList = el('span', { class: 'font-mono text-[10px] text-amber-200/90' });
    syncers.push(() => { const ks = Object.keys(M()?.own || {}); ownList.textContent = ks.length ? `${t('cloud.mod.own')}: ${ks.map((k) => t(`cloud.mod.ownKey.${k}`)).join(' · ')}` : t('cloud.mod.ownNone'); });
    const resetOwn = el('button', { class: BTN, dataset: { help: 'cloud.modules' }, text: t('cloud.mod.ownReset'), on: { click: () => editDoc((d) => { const mod = activeMod(d); if (mod) mod.own = {}; }) } });
    const scopeBtn = el('button', { class: BTN, dataset: { help: 'cloud.modules' }, on: { click: () => { scopeOn = !scopeOn; key = ''; hooks.requestRender(['studio']); } } });
    syncers.push(() => { scopeBtn.textContent = scopeOn ? t('cloud.mod.scopeOn', `M${getCloudDoc().activeModule + 1}`) : t('cloud.mod.scopeAll'); scopeBtn.classList.toggle('bg-teal-700', scopeOn); });
    const preset = (label, lo, hi) => el('button', { class: `${BTN} !px-1.5 !py-0.5 !text-[10px]`, text: label, on: { click: () => editDoc((d) => { const mod = activeMod(d); if (mod) Object.assign(mod, { lo, hi }); }) } });
    const segLayout = sharedSegment('cloud.modLayout', MODULE_LAYOUTS.map((v) => [v, t(`cloud.mod.layout.${v}`)]), () => M()?.layout || 'pitch', (v) => editDoc((d) => { const mod = activeMod(d); if (mod) mod.layout = v; }), 'teal');
    return el('section', { class: SECTION, dataset: { help: 'cloud.modules', rack: 'cloud-modules' } }, [
      el('div', { class: 'flex flex-wrap items-center justify-between gap-2' }, [H3('cloud.mod.title', 'text-teal-300', 'cloud.modules'), tabs]),
      d0.modules.length >= 2 ? el('div', { class: 'flex flex-wrap items-center gap-2 rounded-lg border border-teal-800/70 bg-teal-950/30 px-2 py-1', dataset: { help: 'cloud.modules' } }, [scopeBtn, ownList, resetOwn]) : null,
      el('div', { class: 'flex items-center justify-between gap-2' }, [el('span', { class: 'text-[11px] font-semibold text-slate-300', text: t('cloud.mod.layoutLbl') }), rangeTag, check('cloud.mod.on', 'enabled', 'cloud.modules')]),
      showWhen(el('div', { class: 'flex flex-col gap-1.5' }, [
        segLayout,
        showWhen(check('cloud.mod.syncCore', 'syncCore', 'cloud.modSync'), () => (M()?.layout || 'pitch') === 'pitch'),
        slider('cloud.mod.lo', 'cloud.modules', () => M()?.lo ?? 0, (v, ck) => setM('lo')(Math.min(v, (M()?.hi ?? 1) - 0.01), ck), { min: 0, max: 1, step: 0.005, accent: 'accent-teal', def: 0 }),
        slider('cloud.mod.hi', 'cloud.modules', () => M()?.hi ?? 1, (v, ck) => setM('hi')(Math.max(v, (M()?.lo ?? 0) + 0.01), ck), { min: 0, max: 1, step: 0.005, accent: 'accent-teal', def: 1 }),
        el('div', { class: 'flex flex-wrap gap-1' }, [preset(t('cloud.mod.full'), 0, 1), preset('↓ ½', 0, 0.5), preset('↑ ½', 0.5, 1), preset('⅓', 1 / 3, 2 / 3), preset('¼', 0.375, 0.625)]),
      ]), () => !!M()?.enabled),
    ].filter(Boolean));
  }

  /** Multi-module grapher (2+ modules), under the window. / 다중 모듈 그래퍼 */
  function buildModuleGrapher() {
    const d0 = getCloudDoc();
    if (d0.modules.length < 2) return null;
    const rows = d0.modules.map((mod0, i) => {
      const G = () => getCloudDoc().modules[i];
      const sm = (field, label, onCls, tip) => {
        const x = el('button', { class: 'px-1.5 py-0.5 rounded text-[10px] font-bold border', text: label, title: t(tip), dataset: { help: 'cloud.modGrapher' }, on: { click: (e) => { e.stopPropagation(); editDoc((d) => { const mod = d.modules[i]; if (mod) mod[field] = !mod[field]; }); } } });
        syncers.push(() => { x.className = `px-1.5 py-0.5 rounded text-[10px] font-bold border ${G()?.[field] ? onCls : 'bg-slate-900 border-slate-700 text-slate-400'}`; });
        return x;
      };
      const on = el('input', { type: 'checkbox', class: 'accent-emerald-500', title: t('cloud.mod.on'), on: { click: (e) => e.stopPropagation(), change: (e) => editDoc((d) => { d.modules[i].enabled = e.target.checked; }) } });
      syncers.push(() => { on.checked = !!G()?.enabled; });
      const info = el('span', { class: 'font-mono text-[10px] text-slate-400 truncate flex-1' });
      syncers.push(() => { const d = getCloudDoc(); const mod = G(); if (!mod) return; const { b0, b1 } = moduleBand(d, mod); info.textContent = `${midiToNoteName(Math.round(b0))}–${midiToNoteName(Math.round(b1))} · ${t(`cloud.mod.layout.${mod.layout}`)}`; });
      const row = el('div', { class: 'flex items-center gap-1.5 rounded-lg px-1.5 py-1 border cursor-pointer', dataset: { help: 'cloud.modGrapher' }, on: { click: () => selectModule(i) } }, [
        on,
        el('span', { class: 'px-1.5 rounded font-mono text-[11px] font-bold', style: `background:${modColor(i)};color:#020617`, text: `M${i + 1}` }),
        info,
        voiceGainControl({ get: () => G()?.gain ?? 1, set: (val, ck) => editCloudDoc((d) => { const mod = d.modules[i]; if (mod) mod.gain = val; }, { coalesceKey: `${ck}:${mod0.id}` }), commit, push: (fn) => syncers.push(fn), def: 1, max: 2 }),
        sm('solo', 'S', 'bg-amber-500 text-slate-950 border-amber-400', 'cloud.mod.solo'),
        sm('mute', 'M', 'bg-rose-600 text-white border-rose-500', 'cloud.mod.mute'),
      ]);
      syncers.push(() => {
        const d = getCloudDoc();
        const act = d.activeModule === i;
        row.className = `flex items-center gap-1.5 rounded-lg px-1.5 py-1 border cursor-pointer transition-opacity ${act ? 'bg-slate-950' : 'bg-slate-950/60 border-slate-800 hover:border-slate-700'}`;
        row.style.borderColor = act ? modColor(i) : '';
        row.style.opacity = G() && moduleAudible(G(), d.modules) ? '1' : '0.42'; // silent = dim / 소리 없음 = 어둡게
      });
      return row;
    });
    return el('section', { class: SECTION, dataset: { window: 'list', rack: 'cloud-module-grapher', help: 'cloud.modGrapher' } }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        H3('cloud.mod.grapher', 'text-teal-300', 'cloud.modGrapher'),
        el('div', { class: 'flex items-center gap-1.5' }, [
          el('span', { class: 'text-[10px] text-slate-500', text: t('cloud.mod.count', d0.modules.length) }),
          d0.modules.length < MAX_MODULES ? el('button', { class: BTN, text: t('cloud.mod.add'), dataset: { help: 'cloud.modGrapher' }, on: { click: addModule } }) : null,
          el('button', { class: `${BTN} hover:bg-rose-600`, text: t('cloud.mod.remove'), dataset: { help: 'cloud.modGrapher' }, on: { click: removeModule } }),
        ].filter(Boolean)),
      ]),
      el('div', { class: 'flex flex-col gap-1' }, rows),
    ]);
  }

  /** "Toolboxes act on module Mk" banner. / 모듈 범위 배너 */
  function buildScopeBanner() {
    if (!scoped()) return null;
    const d = getCloudDoc();
    const i = d.activeModule;
    return el('div', { class: 'rounded-xl border px-3 py-2 text-[11px] flex flex-wrap items-center gap-2', style: `border-color:${modColor(i)};background:rgba(2,6,23,.9)`, dataset: { help: 'cloud.modules' } }, [
      el('span', { class: 'font-mono font-bold', style: `color:${modColor(i)}`, text: `M${i + 1}` }),
      el('span', { class: 'text-slate-200', text: t('cloud.mod.banner') }),
      el('span', { class: 'text-slate-500', text: t('cloud.mod.shared') }),
      el('button', { class: BTN, text: t('cloud.mod.scopeAll'), on: { click: () => { scopeOn = false; key = ''; hooks.requestRender(['studio']); } } }),
    ]);
  }

  // ------------------------------------------------------------------ racks
  function buildTimeRack() {
    return el('section', { class: SECTION }, [
      H3('cloud.timeTitle', 'text-sky-300', 'cloud.length'),
      sl('cloud.length', 'cloud.length', 'length', { min: 1, max: MAX_LENGTH_SEC, step: 0.5, unit: 's' }),
    ]);
  }

  function buildPitchRack(params) {
    const dist = params.pitch.dist;
    return el('section', { class: SECTION }, [
      H3('cloud.pitchTitle', 'text-violet-300', 'cloud.dist'),
      labelled('cloud.dist', select('cloud.dist', CLOUD_DISTS.map((d) => [d, t(`cloud.dist.${d}`)]), () => getCloudParams().pitch.dist, (val) => editCloud((d) => { d.pitch.dist = val; })), 'cloud.dist'),
      dist === 'levy' ? sl('cloud.levyAlpha', 'cloud.levyAlpha', 'pitch.levyAlpha', { min: 1, max: 2, step: 0.01, accent: 'accent-violet' }) : null,
      dist === 'brownian' ? sl('cloud.brownStep', 'cloud.brown', 'pitch.brownStep', { min: 0, max: 12, step: 0.05, unit: 'st', accent: 'accent-violet' }) : null,
      dist === 'brownian' ? sl('cloud.brownDrift', 'cloud.brown', 'pitch.brownDrift', { min: -2, max: 2, step: 0.01, unit: 'st', accent: 'accent-violet' }) : null,
      rangeGuard(el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.pitchMin', 'cloud.pitchRange', 'pitch.min', { min: 12, max: 120, step: 0.5, unit: 'MIDI', accent: 'accent-violet' }),
        sl('cloud.pitchMax', 'cloud.pitchRange', 'pitch.max', { min: 12, max: 120, step: 0.5, unit: 'MIDI', accent: 'accent-violet' }),
      ])),
    ]);
  }

  function buildSieveRack(params) {
    const sv = params.pitch.sieve;
    const size = el('span', { class: 'text-[11px] font-mono text-amber-300', dataset: { help: 'cloud.sieve' } });
    syncers.push(() => {
      const p = getCloudParams();
      const ev = getCloudEvents(p);
      size.textContent = p.pitch.sieve.enabled ? (ev.stats.sieveSize ? t('cloud.sieve.size', ev.stats.sieveSize) : t('cloud.sieve.empty')) : '';
    });
    const terms = (sv.terms || []).map((term, idx) => {
      const editT = (fn) => { editCloud((d) => { const x = d.pitch.sieve.terms[idx]; if (x) fn(x); }); commit(); };
      const getT = () => getCloudParams().pitch.sieve.terms[idx] || { mod: 1, residues: [0], shift: 0 };
      const mod = el('input', { type: 'number', min: 1, max: 96, step: 1, class: 'w-12 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
      mod.addEventListener('change', () => editT((x) => { x.mod = clamp(Math.round(num(mod.value, x.mod)), 1, 96); }));
      const shift = el('input', { type: 'number', min: -48, max: 48, step: 1, class: 'w-12 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px]' });
      shift.addEventListener('change', () => editT((x) => { x.shift = clamp(Math.round(num(shift.value, x.shift || 0)), -48, 48); }));
      const res = el('input', { type: 'text', class: 'flex-1 min-w-0 px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono text-[11px]' });
      res.addEventListener('keydown', (e) => e.stopPropagation());
      res.addEventListener('change', () => editT((x) => { x.residues = [...new Set(res.value.split(/[^0-9-]+/).filter(Boolean).map((s) => Math.round(Number(s))).filter(Number.isFinite))]; }));
      syncers.push(() => {
        const x = getT();
        if (document.activeElement !== mod) mod.value = String(x.mod);
        if (document.activeElement !== shift) shift.value = String(x.shift || 0);
        if (document.activeElement !== res) res.value = (x.residues || []).join(', ');
      });
      return el('div', { class: 'flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-1.5 text-[11px] text-slate-300', dataset: { help: 'cloud.sieveTerm' } }, [
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.mod') }), mod,
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.residues') }), res,
        el('span', { class: 'text-slate-400', text: t('cloud.sieve.shift') }), shift,
        el('button', { class: 'text-slate-500 hover:text-rose-400 font-bold px-1', text: '✕', on: { click: () => { editCloud((d) => { d.pitch.sieve.terms.splice(idx, 1); }); commit(); } } }),
      ]);
    });
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        H3('cloud.sieveTitle', 'text-amber-300', 'cloud.sieve'),
        toggle('cloud.sieve.enabled', 'cloud.sieve', () => getCloudParams().pitch.sieve.enabled, () => { editCloud((d) => { d.pitch.sieve.enabled = !d.pitch.sieve.enabled; }); commit(); }),
        toggle('cloud.sieve.snap', 'cloud.sieveSnap', () => getCloudParams().pitch.snapSieve, () => { editCloud((d) => { d.pitch.snapSieve = !d.pitch.snapSieve; }); commit(); }),
        size,
      ]),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('cloud.sieve.op', select('cloud.sieve', SIEVE_OPS.map((o) => [o, t(`cloud.sieve.op.${o}`)]), () => getCloudParams().pitch.sieve.op, (val) => editCloud((d) => { d.pitch.sieve.op = val; })), 'cloud.sieve'),
        labelled('cloud.sieve.grid', select('cloud.sieve', Object.keys(SIEVE_GRIDS).map((g) => [g, t(`cloud.sieve.grid.${g}`)]), () => getCloudParams().pitch.sieve.grid, (val) => editCloud((d) => { d.pitch.sieve.grid = val; })), 'cloud.sieve'),
      ]),
      ...terms,
      el('button', { class: `${BTN} self-start`, text: `+ ${t('cloud.sieve.addTerm')}`, dataset: { help: 'cloud.sieveTerm' }, on: { click: () => { editCloud((d) => { d.pitch.sieve.terms.push({ mod: 12, residues: [0, 4, 7], shift: 0 }); }); commit(); } } }),
    ]);
  }

  function buildGlideRack(params) {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        H3('cloud.glideTitle', 'text-emerald-300', 'cloud.glide'),
        seg('cloud.glide', GLIDE_MODES.map((m) => [m, `cloud.glide.${m}`]), () => getCloudParams().glide.mode, (val) => editCloud((d) => { d.glide.mode = val; }), 'emerald'),
      ]),
      params.glide.mode === 'slope' ? sl('cloud.slopeMean', 'cloud.glide', 'glide.slopeMean', { min: 0, max: 48, step: 0.1, unit: 'st/s', accent: 'accent-emerald' }) : null,
      params.glide.mode === 'slope' ? sl('cloud.slopeSpread', 'cloud.glide', 'glide.slopeSpread', { min: 0, max: 48, step: 0.1, unit: 'st/s', accent: 'accent-emerald' }) : null,
      sl('cloud.upBias', 'cloud.upBias', 'glide.upBias', { min: 0, max: 1, step: 0.01, accent: 'accent-emerald' }),
    ]);
  }

  function buildDurRack(params) {
    return el('section', { class: SECTION }, [
      H3('cloud.durTitle', 'text-sky-300', 'cloud.duration'),
      labelled('cloud.durDist', select('cloud.duration', DUR_DISTS.map((d) => [d, t(`cloud.dur.${d}`)]), () => getCloudParams().duration.dist, (val) => editCloud((d) => { d.duration.dist = val; })), 'cloud.duration'),
      params.duration.dist !== 'uniform' ? sl('cloud.durMean', 'cloud.duration', 'duration.mean', { min: 0.02, max: 8, step: 0.01, unit: 's' }) : null,
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.durMin', 'cloud.duration', 'duration.min', { min: 0.03, max: 4, step: 0.01, unit: 's' }),
        sl('cloud.durMax', 'cloud.duration', 'duration.max', { min: 0.05, max: 12, step: 0.01, unit: 's' }),
      ]),
    ]);
  }

  function buildGainRack(params) {
    return el('section', { class: SECTION }, [
      el('div', { class: 'flex items-center justify-between gap-2' }, [
        H3('cloud.gainTitle', 'text-rose-300', 'cloud.gain'),
        toggle('cloud.autoLevel', 'cloud.autoLevel', () => getCloudParams().gain.autoLevel, () => { editCloud((d) => { d.gain.autoLevel = !d.gain.autoLevel; }); commit(); }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        sl('cloud.gainBase', 'cloud.gain', 'gain.base', { min: 0, max: 1, step: 0.01, accent: 'accent-rose' }),
        sl('cloud.gainSpread', 'cloud.gain', 'gain.spread', { min: 0, max: 1, step: 0.01, accent: 'accent-rose' }),
      ]),
      el('div', { class: 'grid grid-cols-2 gap-2' }, [
        labelled('cloud.pitchComp', select('cloud.pitchComp', PITCH_COMPS.map((c) => [c, t(`cloud.pitchComp.${c}`)]), () => getCloudParams().gain.pitchComp, (val) => editCloud((d) => { d.gain.pitchComp = val; })), 'cloud.pitchComp'),
        labelled('cloud.envelope', select('cloud.envelope', ENVELOPES.map((e) => [e, t(`cloud.env.${e}`)]), () => getCloudParams().gain.envelope, (val) => editCloud((d) => { d.gain.envelope = val; })), 'cloud.envelope'),
      ]),
      params.gain.envelope !== 'hann' ? sl('cloud.attack', 'cloud.envelope', 'gain.attack', { min: 0.002, max: 0.5, step: 0.001, unit: 's', accent: 'accent-rose' }) : null,
    ]);
  }

  function buildTimbreRack() {
    // Shared timbre synthesis editor: Mix | ƒ(x), same as the Glissando Studio (ui/timbre-editor.js).
    // 공용 음색 합성 편집기: 믹스 | ƒ(x) — 글리산도 스튜디오와 동일
    const timbreEd = createTimbreEditor({ get: () => getCloudParams().timbre, edit: (fn, k) => editCloud((d) => { fn(d.timbre); }, { coalesceKey: k }), idPrefix: 'cloud-timbre' });
    syncers.push(timbreEd.sync);
    const waves = el('div', { class: 'min-w-0', dataset: { help: 'cloud.timbre' } }, [timbreEd.root]);
    return el('section', { class: SECTION }, [
      H3('cloud.timbreTitle', 'text-emerald-300', 'cloud.timbre'),
      waves,
      sl('cloud.stereo', 'cloud.stereo', 'timbre.stereo', { min: 0, max: 1, step: 0.01, accent: 'accent-emerald' }),
    ]);
  }

  function buildAdvRack() {
    return el('section', { class: SECTION }, [
      H3('cloud.advTitle', 'text-slate-300', 'cloud.sched'),
      el('div', { class: 'grid grid-cols-2 gap-x-3' }, [
        intSl('cloud.maxEvents', 'cloud.maxEvents', 'maxEvents', { min: 10, max: MAX_EVENTS_LIMIT, step: 10 }),
        intSl('cloud.maxPolyphony', 'cloud.maxPolyphony', 'maxPolyphony', { min: 1, max: MAX_POLY_LIMIT, step: 1 }),
        sl('cloud.lookahead', 'cloud.sched', 'sched.lookahead', { min: 0.05, max: 3, step: 0.05, unit: 's' }),
        intSl('cloud.interval', 'cloud.sched', 'sched.interval', { min: 5, max: 200, step: 1, unit: 'ms' }),
      ]),
      slider('cloud.histWin', 'cloud.histWin', () => num(getCloudParams().view.histWin, 4), (v) => setView((vw) => { vw.histWin = v; }), { min: 0.5, max: 60, step: 0.5, unit: 's' }),
    ]);
  }

  // ------------------------------------------------------------------ build / render
  function build() {
    const params = getCloudParams();
    syncers = [];
    canvases?.destroy();
    root.replaceChildren(
      buildHeader(),
      el('div', { class: 'grid grid-cols-1 lg:grid-cols-12 gap-3' }, [
        buildCanvasCol(params),
        el('div', { class: 'lg:col-span-4 flex flex-col gap-3 min-w-0' }, [
          buildScopeBanner(), buildModuleRack(), shared(buildTimeRack()), buildPitchRack(params), buildSieveRack(params), buildGlideRack(params), buildDurRack(params), buildGainRack(params), shared(buildTimbreRack()), shared(((r) => { syncers.push(r.sync); return r.root; })(createStudioTremoloRack({ get: getCloudParams, edit: editCloud }))), buildAdvRack(),
        ].filter(Boolean)),
      ]),
    );
  }

  function structureKey() {
    const p = getCloudParams();
    const tab = p.view.curveTab;
    const d = getCloudDoc();
    return [getLang(), tab, getCurve(p, tab).engine, getCurve(p, tab).flowKind, p.pitch.dist, p.glide.mode, p.duration.dist, p.gain.envelope, (p.pitch.sieve.terms || []).length, d.modules.length, d.activeModule, scoped()].join('|');
  }

  return {
    render() {
      const k = structureKey();
      if (k !== key) { key = k; build(); }
      const params = getCloudParams();
      const ev = getCloudEvents(); // edit-time bake (cache hit unless the signature changed) / 편집 시점 베이킹
      if (isCloudPlaying()) syncCloudLive(ev, getCloudDoc());
      syncers.forEach((fn) => fn());
      canvases?.render(params, ev);
    },
    fit: fitCloud,
    destroy() {
      offProgress();
      canvases?.destroy();
      canvases = null;
      root.replaceChildren();
      key = '';
    },
  };
}
