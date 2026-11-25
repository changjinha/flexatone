/**
 * Flexatone — ui/tool-groups.js
 * Layer 4 (ui): the toolbox groups of every studio, in signal order. The split layout
 * (ui/rack-layout.js) shows the monitors on the left and the toolboxes on the right in these groups; the
 * signal runs through the active toolboxes of ① → ② → ③ (the chain, shown by ports and the Chain toolbox).
 * 계층 4 (ui): 모든 스튜디오 툴박스의 묶음 (신호 순서). 분할 레이아웃은 왼쪽에 모니터, 오른쪽에 이 묶음대로
 * 툴박스를 둡니다. 신호는 ① → ② → ③의 켜진 툴박스를 차례로 지나갑니다 (체인: 포트와 체인 툴박스로 표시).
 *
 *   top   the studio's own strip (name, presets, transport buttons) — above the groups / 스튜디오 띠 (묶음 위)
 *   gen   ① Generate: voices and pitch trajectories (curve engines, fields, systems, strokes …)
 *         ① 생성: 보이스 생성 · 음고 궤적 정의
 *   proc  ② Process: what happens to the sound of those voices (timbre, tremolo, vibrato, gain, room …)
 *         ② 처리: 음색 · 트레몰로 · 비브라토 · 게인 · 공간 …
 *   post  ③ Send & export: after the studio (sends to other studios / Space Studio, curve export, bake)
 *         ③ 후처리: 보내기 이후 (다른 스튜디오·스페이스 스튜디오로 보내기, 곡률 내보내기, 베이크)
 *   util  ④ Utility: tools about the studio itself, outside the signal (the Chain view)
 *         ④ 유틸리티: 신호 밖의 도구 (체인 보기)
 *
 * A rack can state its group with `data-tool-cat="gen|proc|post|top"`; otherwise the table below decides
 * from its data-rack / id / first data-help key, then from its title. Unknown racks go to Generate.
 * 랙은 data-tool-cat으로 직접 묶음을 정할 수 있고, 아니면 아래 표(data-rack · id · 첫 data-help)와 제목으로 정함.
 */

import { I18N } from '../core/i18n.js';
import { HELP_DB } from './option-inspector.js';

export const TOOL_CATS = Object.freeze(['top', 'gen', 'proc', 'post', 'util']);
export const CAT_RANK = Object.freeze({ top: 0, gen: 1, proc: 2, post: 3, util: 4 });
/** Groups the signal runs through, in order. / 신호가 지나가는 묶음 */
export const SIGNAL_CATS = Object.freeze(['gen', 'proc', 'post']);

Object.assign(I18N.en, {
  'tg.gen': '① Generate',
  'tg.gen.sub': 'voices · pitch trajectories',
  'tg.proc': '② Process',
  'tg.proc.sub': 'timbre · tremolo · vibrato · gain · space',
  'tg.post': '③ Send & export',
  'tg.post.sub': 'after the studio: sends · curve export',
  'tg.util': '④ Utility',
  'tg.util.sub': 'outside the signal: chain view',
  'tg.fold': 'Click to fold / unfold this group',
});
Object.assign(I18N.ko, {
  'tg.gen': '① 생성',
  'tg.gen.sub': '보이스 · 음고 궤적',
  'tg.proc': '② 처리',
  'tg.proc.sub': '음색 · 트레몰로 · 비브라토 · 게인 · 공간',
  'tg.post': '③ 후처리',
  'tg.post.sub': '보내기 이후: 다른 스튜디오로 보내기 · 곡률 내보내기',
  'tg.util': '④ 유틸리티',
  'tg.util.sub': '신호 밖: 체인 보기',
  'tg.fold': '클릭하면 이 묶음을 접고 엽니다',
});
HELP_DB['app.toolGroups'] = {
  en: {
    title: 'Toolbox groups',
    summary: 'The toolboxes on the right are sorted in signal order: ① Generate (voices, pitch trajectories) → ② Process (timbre, tremolo, vibrato, gain, space) → ③ Send & export (sends, curve export, Send to Space Studio), plus ④ Utility (chain view).',
    detail: 'The monitors — the main monitor, the module list and the timeline — stay on the left and follow the page. Only the toolboxes you switch on in the module tray are shown; the signal of the monitors runs through them in order (ports ◀ in / out ▶ on each box). Click a group title to fold the whole group. ▲ / ▼ moves a toolbox inside its group.',
    formula: '',
  },
  ko: {
    title: '툴박스 묶음',
    summary: '오른쪽 툴박스는 신호 순서로 묶여 있습니다: ① 생성(보이스·음고 궤적) → ② 처리(음색·트레몰로·비브라토·게인·공간) → ③ 후처리(보내기, 곡률 내보내기, 스페이스 스튜디오로 보내기), 그리고 ④ 유틸리티(체인 보기).',
    detail: '모니터 — 주 모니터, 모듈 리스트, 타임라인 — 는 왼쪽에 남아 페이지를 따라옵니다. 모듈 트레이에서 켠 툴박스만 보이며, 모니터의 신호는 그 툴박스들을 차례로 지나갑니다(각 상자의 ◀ 입력 / 출력 ▶ 포트). 묶음 제목을 클릭하면 묶음 전체가 접힙니다. ▲ / ▼는 같은 묶음 안에서 순서를 바꿉니다.',
    formula: '',
  },
};

// Exact keys (data-rack, id or first data-help) → group. Checked before the patterns. / 정확한 키 → 묶음
const EXACT = {
  // Generate: also the trajectory transforms and shape effects (they define the pitch line)
  // 생성: 궤적 변형·모양 효과도 포함 (음고 선을 정의함)
  'draw.reverse': 'gen',
  'draw.tool.warp': 'gen',
  'draw-warp-brush': 'gen',
  'draw.fx': 'gen',
  'draw-fx': 'gen',
  'grid.space': 'gen',
  'grid-space': 'gen',
  'grid.brush': 'gen',
  'space.sound': 'gen',
  'space-sound': 'gen',
  // Studio strips / 스튜디오 띠
  studioMount: 'top', // Glissando strip: Generate Voices / 글리산도 띠
  'gen.glissando.panel': 'top',
  'risset.phase': 'top',
  'draw.status': 'top',
  'cloud.overview': 'top',
  'tempo.studio': 'top',
  'chaos.header': 'top',
  'wave.bake': 'top',
  'grid.bake': 'top',
  'grid-strip': 'top',
  // Process / 처리
  'voice-mod': 'proc',
  'risset-voice-mod': 'proc',
  'studio-tremolo': 'proc',
  tremoloMount: 'proc',
  timbreSection: 'proc',
  'draw.baseGain': 'proc',
  'cloud.gain': 'proc',
  'cloud.timbre': 'proc',
  'risset.envelope': 'proc',
  'risset.colorCtl': 'proc',
  'field.retroMode': 'proc',
  'chaos.timbre': 'proc',
  'tempo.sound': 'proc',
  'space.c': 'proc',
  'space.room': 'proc',
  'space-room': 'proc',
  'space.doppler': 'proc',
  'gliss.locate': 'proc', // Space: observed pitch f_obs(t) — the result of the medium / 관측 음고 = 매질의 결과
  'grid.timbre': 'proc',
  'grid-timbre': 'proc',
  vgain: 'proc',
  // Send & export / 후처리
  versionGallerySection: 'post',
  'gliss.versions': 'post',
  'space-output': 'post',
  'space.output': 'post',
  'studio-post': 'post',
  'send-space': 'post',
  'tool-chain': 'util',
};

const PATTERNS = [
  [/^lineMix\./, 'proc'],
  [/^(vmod|trem)\./, 'proc'],
  [/\.(timbre|sound|sonif)/i, 'proc'],
  [/^wave\.mode\./, 'proc'],
  [/^fractal\.gain\./, 'proc'],
  [/(^|\.)(send|export)/i, 'post'],
];

const TITLE_PATTERNS = [
  [/send|export|보내기|내보내기/i, 'post'],
  [/timbre|음색|tremolo|트레몰로|vibrato|비브라토|sonification|소리화|gain|게인|room|공간/i, 'proc'],
];

/** First data-help key of a rack that is not the rack's own chrome. / 랙 자체 장식이 아닌 첫 data-help */
export function firstHelpKey(node) {
  for (const e of node.querySelectorAll('[data-help]')) {
    if (e.closest('.fx-rack-grip') || e.classList.contains('fx-rack-size') || e.classList.contains('fx-mon-full')) continue;
    return e.dataset.help;
  }
  return '';
}

/**
 * Group of a toolbox. `title` = its shown title (used last, and to tell the Fractal strip from its Bake box,
 * which share a help key). / 툴박스의 묶음
 */
export function toolCategory(node, title = '') {
  const own = node.dataset.toolCat;
  if (own && TOOL_CATS.includes(own)) return own;
  const help = firstHelpKey(node);
  if (help === 'fractal.bake') return /studio|스튜디오/i.test(title) ? 'top' : 'post';
  for (const k of [node.dataset.rack, node.id, help]) if (k && EXACT[k]) return EXACT[k];
  for (const k of [node.dataset.rack, help]) {
    if (!k) continue;
    for (const [re, cat] of PATTERNS) if (re.test(k)) return cat;
  }
  for (const [re, cat] of TITLE_PATTERNS) if (re.test(title)) return cat;
  return 'gen';
}
