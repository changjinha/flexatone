/**
 * Flexatone — ui/warp-stack-ui.js
 * Layer 4 (ui): the editor of a space-warp stack (modules/space-warp.js), shared by the Draw Studio
 * (object effects of a stroke) and the Grid Studio (the deformation of its coordinate space). Cards
 * are generated from the registry schema, so a new warp needs no UI code.
 * 계층 4 (ui): 공간 변형 스택 편집기 — 드로잉 스튜디오(획의 객체 효과)와 그리드 스튜디오(좌표 공간 변형)가 공용.
 * 카드는 레지스트리 스키마에서 자동 생성.
 */

import { clamp } from '../core/math-utils.js';
import { t, getLang, pickLocalized, I18N } from '../core/i18n.js';
import { endHistoryGesture } from '../core/state.js';
import { SpaceWarpRegistry, sanitizeWarpParams, createWarpStage, WARP_MAX_STACK, CHROMA_RATIOS, CHROMA_CHANNELS, chromaSemis } from '../modules/space-warp.js';
import { el, num, setToggle } from './panels.js';
import { createStudioControls, STUDIO_BTN as BTN, STUDIO_SELECT } from './studio-controls.js';
import { HELP_DB } from './option-inspector.js';

const EN = {
  'warp.add': 'Effect', 'warp.mix': 'Amount', 'warp.on': 'On / off', 'warp.up': 'Earlier', 'warp.down': 'Later', 'warp.dup': 'Duplicate', 'warp.reset': 'Reset', 'warp.del': 'Remove', 'warp.fold': 'Fold / unfold',
  'warp.empty': 'No effect yet.', 'warp.none': 'Nothing selected.', 'warp.max': 'At most {0} effects.',
  'warp.liq.count': '{0} brush strokes', 'warp.liq.undo': 'Remove last', 'warp.liq.reset': 'Clear strokes',
  'warp.ops.pull': '{0} pulls', 'warp.ops.restore': '{0} restored regions', 'warp.ops.reset': 'Clear all',
  'warp.c.custom': 'p : q', 'warp.c.On': 'On', 'warp.c.Cents': 'Fine', 'warp.c.Gain': 'Gain', 'warp.c.TimeMs': 'Time', 'warp.c.Pan': 'Pan', 'warp.c.hint': 'G = the original; R / B = exact ratios of it.',
  'warp.p.link': 'Link R = 1 / B', 'warp.p.amount': 'Amount', 'warp.p.lockTime': 'Lock time', 'warp.p.cx': 'Centre (time)', 'warp.p.cy': 'Centre (pitch)', 'warp.p.radius': 'Radius (cells)', 'warp.p.strength': 'Strength',
  'warp.p.angle': 'Angle', 'warp.p.ampSemi': 'Depth (pitch)', 'warp.p.periodSec': 'Period (time)', 'warp.p.ampMs': 'Depth (time)', 'warp.p.periodSemi': 'Period (pitch)', 'warp.p.phase': 'Phase',
  'warp.p.scaleSec': 'Grain (time)', 'warp.p.scaleSemi': 'Grain (pitch)', 'warp.p.seed': 'Seed', 'warp.p.stepSemi': 'Step', 'warp.p.axis': 'Axis', 'warp.p.centre': 'Axis position', 'warp.p.mode': 'Mode',
  'warp.p.rate': 'Rate', 'warp.p.durMin': 'Grain min', 'warp.p.durMax': 'Grain max', 'warp.p.rangeSemi': 'Range ±', 'warp.p.timeJumpMs': 'Time jump ±', 'warp.p.probability': 'Probability',
  'warp.p.periodMs': 'Dot period', 'warp.p.duty': 'Duty', 'warp.p.jitter': 'Length jitter', 'warp.p.silenceJitter': 'Silence jitter', 'warp.p.dropout': 'Dropout', 'warp.p.bandSemi': 'Band', 'warp.p.edgeMs': 'Edge',
  'warp.opt.pitch': 'Pitch', 'warp.opt.time': 'Time', 'warp.opt.flip': 'Flip', 'warp.opt.fold': 'Fold', 'warp.opt.both': 'Original + flip',
};
const KO = {
  'warp.add': '효과 추가', 'warp.mix': '적용량', 'warp.on': '켜기 / 끄기', 'warp.up': '앞으로', 'warp.down': '뒤로', 'warp.dup': '복제', 'warp.reset': '초기화', 'warp.del': '제거', 'warp.fold': '접기 / 펼치기',
  'warp.empty': '아직 효과가 없습니다.', 'warp.none': '선택된 것이 없습니다.', 'warp.max': '효과는 최대 {0}개입니다.',
  'warp.liq.count': '브러시 스트로크 {0}개', 'warp.liq.undo': '마지막 제거', 'warp.liq.reset': '스트로크 지우기',
  'warp.ops.pull': '당기기 {0}개', 'warp.ops.restore': '복원 영역 {0}개', 'warp.ops.reset': '모두 지우기',
  'warp.c.custom': 'p : q', 'warp.c.On': '켜기', 'warp.c.Cents': '미세 조정', 'warp.c.Gain': '게인', 'warp.c.TimeMs': '시간', 'warp.c.Pan': '팬', 'warp.c.hint': 'G = 원음, R / B = 원음의 정확한 비율.',
  'warp.p.link': '연결 R = 1 / B', 'warp.p.amount': '세기', 'warp.p.lockTime': '시간 고정', 'warp.p.cx': '중심 (시간)', 'warp.p.cy': '중심 (음고)', 'warp.p.radius': '반지름 (셀)', 'warp.p.strength': '강도',
  'warp.p.angle': '각도', 'warp.p.ampSemi': '깊이 (음고)', 'warp.p.periodSec': '주기 (시간)', 'warp.p.ampMs': '깊이 (시간)', 'warp.p.periodSemi': '주기 (음고)', 'warp.p.phase': '위상',
  'warp.p.scaleSec': '결 크기 (시간)', 'warp.p.scaleSemi': '결 크기 (음고)', 'warp.p.seed': '시드', 'warp.p.stepSemi': '단 크기', 'warp.p.axis': '축', 'warp.p.centre': '축 위치', 'warp.p.mode': '방식',
  'warp.p.rate': '빈도', 'warp.p.durMin': '그레인 최소', 'warp.p.durMax': '그레인 최대', 'warp.p.rangeSemi': '범위 ±', 'warp.p.timeJumpMs': '시간 점프 ±', 'warp.p.probability': '확률',
  'warp.p.periodMs': '점 주기', 'warp.p.duty': '듀티', 'warp.p.jitter': '길이 지터', 'warp.p.silenceJitter': '무음 지터', 'warp.p.dropout': '드롭아웃', 'warp.p.bandSemi': '대역', 'warp.p.edgeMs': '엣지',
  'warp.opt.pitch': '음고', 'warp.opt.time': '시간', 'warp.opt.flip': '뒤집기', 'warp.opt.fold': '접기', 'warp.opt.both': '원본 + 뒤집기',
};
Object.assign(I18N.en, EN);
Object.assign(I18N.ko, KO);

const H = (en, ko) => ({ en: { title: en[0], summary: en[1], detail: en[2] || en[1], formula: en[3] || '' }, ko: { title: ko[0], summary: ko[1], detail: ko[2] || ko[1], formula: ko[3] || '' } });
Object.assign(HELP_DB, {
  'warp.stack': H(['Effect stack', 'Warps of the time × pitch plane, applied top to bottom. ＋ adds, ↑ ↓ reorder, ⧉ duplicates, ✕ removes.', 'In the Draw Studio the stack belongs to a stroke: only that object moves, the axes stay. In the Grid Studio it belongs to the space: the grid itself is deformed and every line in it is carried along.'],
    ['효과 스택', '시간 × 음고 평면의 변형. 위에서 아래 순서로 적용. ＋ 추가, ↑ ↓ 순서, ⧉ 복제, ✕ 제거.', '드로잉 스튜디오에서는 스택이 획에 속합니다: 그 객체만 움직이고 축은 그대로입니다. 그리드 스튜디오에서는 스택이 공간에 속합니다: 격자 자체가 변형되고 그 안의 모든 선이 함께 옮겨집니다.']),
  'warp.mix': H(['Amount', 'How far the points move: 0 = not at all, 1 = the full warp.', '', 'q′ = q + mix·(W(q) − q)'], ['적용량', '점이 옮겨지는 정도: 0 = 그대로, 1 = 변형 전체.', '', 'q′ = q + mix·(W(q) − q)']),
  'warp.fx.liquify': H(['Liquify', 'Brush strokes (push, twirl, pinch, bloat, reconstruct) stored and replayed as a displacement.', 'Non-destructive: the strokes are kept, Amount scales them, Lock time moves pitch only.', 'q′ = q + a·D(q),  D = Σ strokes · (1 − (d / R)²)²'],
    ['리퀴파이', '브러시 스트로크(밀기·비틀기·오므리기·부풀리기·복원)를 저장해 변위로 재생합니다.', '비파괴: 스트로크는 그대로 남고, 세기로 전체를 조절하며, 시간 고정은 음고만 움직입니다.', 'q′ = q + a·D(q),  D = Σ strokes · (1 − (d / R)²)²']),
  'warp.fx.pull': H(['Pull (region)', 'Selected regions of the original space carried by a drag (the Pull tool of the Grid Studio).', 'Move = the region moves rigidly with a soft edge; Elastic = the grabbed point moves fully and the outline stays. The weight is taken where the point was in the original space, so the place of this stage in the stack does not change what is selected.', 'q′ = q + a·w(q₀)·(dx, dy)'],
    ['당기기 (영역)', '원래 공간에서 선택한 영역을 드래그로 옮깁니다 (그리드 스튜디오의 당기기 도구).', '이동 = 영역이 부드러운 가장자리와 함께 그대로 움직임, 탄성 = 잡은 점이 그대로 따라오고 윤곽은 고정. 가중치는 점이 원래 공간에서 있던 자리로 정하므로, 스택에서의 위치가 선택 대상을 바꾸지 않습니다.', 'q′ = q + a·w(q₀)·(dx, dy)']),
  'warp.fx.restore': H(['Restore (region)', 'Undoes everything above it inside its regions (of the original space): points go back where they were, copies fade out.', 'Made by “Restore selection”; it is kept at the end of the stack. An effect added below it is not restored.', 'q′ = lerp(q, q₀, w(q₀))'],
    ['복원 (영역)', '그 영역 안(원래 공간 기준)에서 위의 모든 변형을 되돌립니다: 점은 원래 자리로, 복제본은 사라집니다.', '“선택 영역 원상태로”로 만들어지며 스택 끝에 놓입니다. 그 아래에 추가한 효과는 복원되지 않습니다.', 'q′ = lerp(q, q₀, w(q₀))']),
  'warp.fx.lens': H(['Lens', 'Bulge (+) widens the intervals around a centre, pinch (−) narrows them.', '', 'r′ = r^e, e = 2^(−1.5·s)'], ['렌즈', '볼록(+)은 중심 주변의 음정을 넓히고, 오목(−)은 좁힙니다.', '', 'r′ = r^e, e = 2^(−1.5·s)']),
  'warp.fx.twirl': H(['Twirl', 'Rotates the plane around a centre, most at the centre: time turns into pitch.', 'A strong twirl can turn time back; the line is then cut into forward runs.', 'θ(r) = angle·(1 − r)²'], ['비틀기', '중심 주위로 평면을 회전 (중심에서 가장 크게): 시간이 음고로 돌아갑니다.', '강한 비틀기는 시간을 되돌릴 수 있으며, 그때 선은 전진 구간으로 잘립니다.', 'θ(r) = angle·(1 − r)²']),
  'warp.fx.wave': H(['Wave', 'A sine ripple of the plane: pitch along time (a written vibrato), time along pitch.', '', 'm′ = m + A·sin 2π(t / T + φ),  t′ = t + B·sin 2π(m / P + φ)'], ['물결', '평면의 사인 물결: 시간에 따른 음고(적힌 비브라토), 음고에 따른 시간.', '', 'm′ = m + A·sin 2π(t / T + φ),  t′ = t + B·sin 2π(m / P + φ)']),
  'warp.fx.turbulence': H(['Turbulence', 'Smooth seeded noise as a displacement: the grain of a picture, as roughness of the space.', ''], ['난류', '부드러운 시드 노이즈를 변위로: 그림의 노이즈를 공간의 거칠기로.', '']),
  'warp.fx.quantize': H(['Pixelate', 'Pitch is pulled onto steps: a glissando becomes a staircase.', '', 'm′ = lerp(m, round(m / s)·s, strength)'], ['픽셀레이트', '음고를 단으로 끌어당깁니다: 글리산도가 계단이 됩니다.', '', 'm′ = lerp(m, round(m / s)·s, strength)']),
  'warp.fx.mirror': H(['Mirror', 'Flip about an axis (pitch = inversion, time = retrograde), fold one side over, or keep the original and add the flip.', ''], ['미러', '축을 기준으로 뒤집기(음고 = 전위, 시간 = 역행), 한쪽을 접기, 또는 원본에 뒤집힌 상을 더하기.', '']),
  'warp.fx.glitch': H(['Glitch', 'Short random tiles of the plane are displaced in pitch (and time): the line jumps for a grain, then returns.', 'Seeded Poisson events.'], ['글리치', '평면의 짧은 조각이 음고(와 시간) 방향으로 랜덤하게 어긋납니다: 선이 그레인 동안 튀었다가 돌아옵니다.', '시드 포아송 이벤트.']),
  'warp.fx.halftone': H(['Halftone', 'Dots instead of a line = a random tremolo: a gate with random on and off lengths.', 'On / off lengths are log-normal; the screen angle shifts the gate with the pitch.', 'on ~ LogN(T·d, jitter),  off ~ LogN(T·(1 − d), silence jitter)'], ['할프톤', '선 대신 점 = 랜덤 트레몰로: 켜짐·꺼짐 길이가 랜덤인 게이트.', '켜짐·꺼짐 길이는 로그정규 분포이며, 스크린 각도는 음고에 따라 게이트를 밉니다.', 'on ~ LogN(T·d, jitter),  off ~ LogN(T·(1 − d), silence jitter)']),
  'warp.fx.chroma': H(['Chromatic Aberration', 'Three images (R, G, B) on exact frequency ratios, each with its own gain, time offset and pan.', 'Default R = 2:3, G = 1:1, B = 3:2: a just fifth below and above.', 'Δ = 12·log2(p / q) semitones'], ['크로매틱 애버레이션', '정확한 주파수 비율 위의 세 상(R, G, B). 각자 게인·시간 오프셋·팬을 가집니다.', '기본값 R = 2:3, G = 1:1, B = 3:2: 순정 5도 아래와 위.', 'Δ = 12·log2(p / q) 반음']),
});

const SECTION = 'bg-slate-900/90 border border-slate-800 rounded-xl p-3 flex flex-col gap-2';
const CARD = 'flex flex-col gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-2 min-w-0';
const ICON = 'w-6 h-6 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[11px] text-slate-200 leading-none shrink-0';
const NUM = 'w-14 px-1 py-0.5 rounded bg-slate-950 border border-slate-700 text-right font-mono text-[11px] text-sky-200';

/**
 * @param {object} o
 * @param {string} o.titleKey      i18n key of the rack title
 * @param {string} o.hintKey       i18n key of the one-line explanation under it
 * @param {string} o.rackId        data-rack
 * @param {string} o.help          data-help of the rack title
 * @param {() => (Array|null)} o.get             the stack (null = nothing to edit right now)
 * @param {(fn: (stack: Array) => void, opts?: { coalesceKey?: string|null }) => void} o.edit   mutate the stack
 * @param {(msg: string, kind?: string) => void} [o.toast]
 * @param {string} [o.color]       Tailwind text colour of the title
 * @param {string[]} [o.types]     warp ids offered (default: all)
 * @returns {{ root: HTMLElement, sync: () => void }}
 */
export function createWarpStackRack(o) {
  let syncers = [];
  let key = null;
  const folded = new Set();
  const commit = () => endHistoryGesture();
  const { slider, toggle, select } = createStudioControls({ push: (fn) => syncers.push(fn), commit, keyOf: (label, help, opts) => `${o.rackId}:${opts.id ?? label}`, narrow: true });
  const stacked = (labelKey, control, help) => el('label', { class: 'flex flex-col gap-0.5 text-[11px] text-slate-300 min-w-0', dataset: { help } }, [el('span', { class: 'truncate', text: t(labelKey) }), control]);
  const name = (type) => pickLocalized(SpaceWarpRegistry.get(type).name, getLang());
  const stack = () => o.get();
  const item = (id) => (stack() || []).find((it) => it.id === id);
  const editItem = (id, fn, opts) => o.edit((st) => { const it = st.find((q) => q.id === id); if (it) fn(it, st); }, opts);
  // warps made by a tool (Pull, Restore) are not offered in the ＋ menu / 도구가 만드는 변형은 ＋ 메뉴에 없음
  const types = () => (o.types || SpaceWarpRegistry.list().filter((w) => !w.toolOnly).map((w) => w.id));

  function control(it, def, q, accent = '') {
    const id = it.id;
    const help = `warp.fx.${def.id}`;
    const get = () => item(id)?.params[q.key];
    const set = (val, ck = null) => editItem(id, (x) => { x.params[q.key] = val; x.params = sanitizeWarpParams(x.type, x.params); }, { coalesceKey: ck });
    const label = q.channel ? `warp.c.${q.key.slice(1)}` : `warp.p.${q.key}`;
    if (q.type === 'toggle') return toggle(label, help, () => !!get(), () => { set(!get()); commit(); });
    if (q.type === 'select') return stacked(label, select(help, q.options.map((v) => [v, t(`warp.opt.${v}`)]), () => get(), (v) => set(v)), help);
    return slider(label, help, () => num(get(), 0), set, { min: q.min, max: q.max, step: q.step ?? 0.01, unit: q.unit || '', integer: q.type === 'int', compact: true, accent, def: def.defaults()[q.key], id: `${id}.${q.key}` });
  }

  function header(it, def, index, count) {
    const id = it.id;
    const eye = el('button', { class: `fx-toggle ${ICON}`, text: '👁', title: t('warp.on'), dataset: { help: 'warp.stack' }, on: { click: () => { editItem(id, (x) => { x.on = !x.on; }); commit(); } } });
    syncers.push(() => { const x = item(id); setToggle(eye, !!x?.on); eye.style.opacity = x?.on ? '1' : '0.45'; });
    const btn = (text, title, onClick) => el('button', { class: ICON, text, title, dataset: { help: 'warp.stack' }, on: { click: onClick } });
    const move = (dir) => { o.edit((st) => { const a = st.findIndex((q) => q.id === id); const b = a + dir; if (a < 0 || b < 0 || b >= st.length) return; [st[a], st[b]] = [st[b], st[a]]; }); commit(); };
    return el('div', { class: 'flex items-center gap-1 min-w-0' }, [
      eye,
      el('span', { class: 'font-semibold text-[11.5px] text-slate-100 truncate mr-auto', text: name(def.id), dataset: { help: `warp.fx.${def.id}` } }),
      index > 0 ? btn('↑', t('warp.up'), () => move(-1)) : null,
      index < count - 1 ? btn('↓', t('warp.down'), () => move(1)) : null,
      btn('⧉', t('warp.dup'), () => {
        if ((stack() || []).length >= WARP_MAX_STACK) { o.toast?.(t('warp.max', WARP_MAX_STACK), 'error'); return; }
        o.edit((st) => { const k = st.findIndex((q) => q.id === id); if (k >= 0) st.splice(k + 1, 0, { ...JSON.parse(JSON.stringify(st[k])), id: '' }); });
        commit();
      }),
      btn('↺', t('warp.reset'), () => { editItem(id, (x) => { x.params = sanitizeWarpParams(x.type, null); x.mix = 1; }); commit(); }),
      el('button', { class: `${ICON} hover:!text-rose-400`, text: '✕', title: t('warp.del'), dataset: { help: 'warp.stack' }, on: { click: () => { o.edit((st) => { const k = st.findIndex((q) => q.id === id); if (k >= 0) st.splice(k, 1); }); commit(); } } }),
      btn(folded.has(id) ? '▸' : '▾', t('warp.fold'), () => { if (folded.has(id)) folded.delete(id); else folded.add(id); key = null; api.sync(); }),
    ]);
  }

  function chromaBody(it, def) {
    const id = it.id;
    const P = () => item(id)?.params || it.params;
    const set = (patch) => { editItem(id, (x) => { Object.assign(x.params, patch); x.params = sanitizeWarpParams('chroma', x.params); }); commit(); };
    const by = (ch, suffix) => def.params.find((q) => q.key === `${ch}${suffix}`);
    const rows = CHROMA_CHANNELS.map((ch) => {
      const col = { r: 'text-rose-300', g: 'text-emerald-300', b: 'text-sky-300' }[ch];
      const accent = { r: 'accent-rose', g: 'accent-emerald', b: '' }[ch];
      const semis = el('span', { class: `font-mono text-[11px] ${col}` });
      syncers.push(() => { const s = chromaSemis(P(), ch); semis.textContent = `${s >= 0 ? '+' : ''}${s.toFixed(3)} st`; });
      const opts = [];
      for (const [a, b] of CHROMA_RATIOS) { opts.push([`${a}:${b}`, `${a}:${b}`]); if (a !== b) opts.push([`${b}:${a}`, `${b}:${a} ↓`]); }
      const sel = el('select', { class: STUDIO_SELECT, dataset: { help: 'warp.fx.chroma' }, on: { change: (e) => { const [a, b] = e.target.value.split(':').map(Number); if (a && b) set({ [`${ch}P`]: a, [`${ch}Q`]: b }); } } }, [el('option', { value: '', text: t('warp.c.custom') }), ...opts.map(([v, lbl]) => el('option', { value: v, text: lbl }))]);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      const pq = (suffix) => {
        const inp = el('input', { type: 'number', min: 1, max: 32, step: 1, class: NUM, dataset: { help: 'warp.fx.chroma' } });
        inp.addEventListener('change', () => set({ [`${ch}${suffix}`]: Math.round(clamp(num(inp.value, 1), 1, 32)) }));
        syncers.push(() => { if (document.activeElement !== inp) inp.value = String(P()[`${ch}${suffix}`]); });
        return inp;
      };
      syncers.push(() => { const p0 = P(); const k = `${p0[`${ch}P`]}:${p0[`${ch}Q`]}`; if (document.activeElement !== sel) sel.value = opts.some(([v]) => v === k) ? k : ''; });
      const box = el('div', { class: 'flex flex-col gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1.5 min-w-0', dataset: { help: 'warp.fx.chroma' } }, [
        el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [el('span', { class: `font-bold text-[11.5px] ${col}`, text: ch.toUpperCase() }), control(it, def, by(ch, 'On')), sel, pq('P'), el('span', { class: 'text-slate-500 text-[11px]', text: ':' }), pq('Q'), semis]),
        el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, ['Cents', 'Gain', 'TimeMs', 'Pan'].map((sfx) => control(it, def, by(ch, sfx), accent))),
      ]);
      syncers.push(() => { box.style.opacity = P()[`${ch}On`] ? '1' : '0.5'; });
      return box;
    });
    return [el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [control(it, def, def.params.find((q) => q.key === 'link')), el('span', { class: 'text-[11px] text-slate-400', text: t('warp.c.hint') })]), ...rows];
  }

  function card(it, index, count) {
    const def = SpaceWarpRegistry.get(it.type);
    const head = header(it, def, index, count);
    if (folded.has(it.id)) return el('div', { class: CARD, dataset: { help: `warp.fx.${def.id}` } }, [head]);
    const id = it.id;
    const mix = slider('warp.mix', 'warp.mix', () => num(item(id)?.mix, 1), (val, ck) => editItem(id, (x) => { x.mix = val; }, { coalesceKey: ck }), { min: 0, max: 1, step: 0.01, compact: true, def: 1, id: `${id}.mix` });
    let body;
    if (it.type === 'chroma') body = chromaBody(it, def);
    else body = [el('div', { class: 'grid grid-cols-2 gap-x-3 gap-y-1 items-end' }, def.params.filter((q) => !q.when || q.when(it.params)).map((q) => control(it, def, q)))];
    if (it.type === 'pull' || it.type === 'restore') {
      const countOps = el('span', { class: 'text-[11px] text-slate-400' });
      syncers.push(() => { countOps.textContent = t(`warp.ops.${it.type}`, item(id)?.params.ops.length || 0); });
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        countOps,
        el('button', { class: BTN, text: `↶ ${t('warp.liq.undo')}`, dataset: { help: `warp.fx.${it.type}` }, on: { click: () => { editItem(id, (x) => { x.params.ops.pop(); }); commit(); } } }),
        el('button', { class: BTN, text: t('warp.ops.reset'), dataset: { help: `warp.fx.${it.type}` }, on: { click: () => { editItem(id, (x) => { x.params.ops = []; }); commit(); } } }),
      ]));
    }
    if (it.type === 'liquify') {
      const count2 = el('span', { class: 'text-[11px] text-slate-400' });
      syncers.push(() => { count2.textContent = t('warp.liq.count', item(id)?.params.ops.length || 0); });
      body.push(el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [
        count2,
        el('button', { class: BTN, text: `↶ ${t('warp.liq.undo')}`, dataset: { help: 'warp.fx.liquify' }, on: { click: () => { editItem(id, (x) => { x.params.ops.pop(); }); commit(); } } }),
        el('button', { class: BTN, text: t('warp.liq.reset'), dataset: { help: 'warp.fx.liquify' }, on: { click: () => { editItem(id, (x) => { x.params.ops = []; }); commit(); } } }),
      ]));
    }
    return el('div', { class: CARD, dataset: { help: `warp.fx.${def.id}` } }, [head, mix, ...body]);
  }

  const body = el('div', { class: 'flex flex-col gap-2 min-w-0' });
  let addType = types()[0];
  const addSel = el('select', { class: STUDIO_SELECT, dataset: { help: 'warp.stack' }, on: { change: (e) => { addType = e.target.value; } } }, types().map((id) => el('option', { value: id, text: name(id) })));
  addSel.addEventListener('keydown', (e) => e.stopPropagation());
  const addBtn = el('button', { class: BTN, text: `＋ ${t('warp.add')}`, dataset: { help: 'warp.stack' }, on: { click: () => {
    const st = stack();
    if (!st) { o.toast?.(t('warp.none'), 'error'); return; }
    if (st.length >= WARP_MAX_STACK) { o.toast?.(t('warp.max', WARP_MAX_STACK), 'error'); return; }
    o.edit((s) => { s.push(createWarpStage(addType)); });
    commit();
  } } });
  const root = el('section', { class: SECTION, dataset: { rack: o.rackId } }, [
    el('div', { class: 'flex flex-wrap items-center gap-1.5' }, [el('h3', { class: `text-xs font-bold uppercase tracking-wider ${o.color || 'text-amber-300'} mr-auto`, text: t(o.titleKey), dataset: { help: o.help || 'warp.stack' } }), addSel, addBtn]),
    el('span', { class: 'text-[11px] text-slate-400', text: t(o.hintKey), dataset: { help: o.help || 'warp.stack' } }),
    body,
  ]);

  const api = {
    root,
    sync() {
      const st = stack();
      const k = st === null ? 'none' : st.map((it) => `${it.id}:${it.type}:${folded.has(it.id) ? 1 : 0}`).join(',');
      if (k !== key) {
        key = k;
        syncers = [];
        if (st === null) body.replaceChildren(el('span', { class: 'text-[11px] text-slate-500', text: t('warp.none') }));
        else if (!st.length) body.replaceChildren(el('span', { class: 'text-[11px] text-slate-500', text: t('warp.empty') }));
        else body.replaceChildren(...st.map((it, i) => card(it, i, st.length)));
      }
      for (const fn of syncers) fn();
    },
  };
  return api;
}
