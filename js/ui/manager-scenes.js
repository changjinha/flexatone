/**
 * Flexatone — ui/manager-scenes.js
 * Layer 4 (ui): the **▶ Scenes** card of the Manager (data: core/manager-scenes.js, playback:
 * audio/scene-player.js). One row per scene: ▶ launch (with a bar for where the scene is), name, the tracks
 * as chips (click = in / out of the scene), length (0 = auto), ▲ ▼, ×. Head: + Scene from what is launched,
 * + Empty, ■ Stop, Switch (at once / at the scene's end), Follow (off / once / loop), ⇥ Write to the cycle and
 * ↶ Undo write. / 계층 4 (ui): 매니저 씬 카드.
 */

import { t, I18N } from '../core/i18n.js';
import { listInstances } from '../core/manager-state.js';
import {
  listScenes, addScene, setScene, toggleSceneTrack, removeScene, moveScene, setSceneOptions, sceneQuant, sceneFollow,
  sceneLength, writeScenesToCycle, unwriteScenes, scenesWritten,
} from '../core/manager-scenes.js';
import { isLaunched, clipLength, DEFAULT_RISSET_CLIP } from '../audio/manager-mixer.js';
import { launchScene, stopScenes, sceneState, onScenesChange } from '../audio/scene-player.js';
import { HELP_DB } from './option-inspector.js';
import { el } from './panels.js';

Object.assign(I18N.en, {
  'scenes.title': 'Scenes',
  'scenes.fromLaunched': '+ Scene from launched',
  'scenes.empty': '+ Empty scene',
  'scenes.stop': '■ Stop all',
  'scenes.none': 'No scenes yet. Launch some tracks (▶ Launch) and press “+ Scene from launched”, or make an empty scene and click track chips.',
  'scenes.quant': 'Switch',
  'scenes.quant.now': 'at once',
  'scenes.quant.end': 'at the scene\'s end',
  'scenes.follow': 'Follow',
  'scenes.follow.off': 'off',
  'scenes.follow.once': 'next scene, once',
  'scenes.follow.loop': 'next scene, loop',
  'scenes.launch': 'Launch this scene (its tracks start, other launched tracks stop)',
  'scenes.len': 'Length (s, 0 = auto: the longest track)',
  'scenes.auto': (s) => `auto ${s} s`,
  'scenes.chipTip': 'Click: put this track in / out of the scene',
  'scenes.write': '⇥ Write to cycle',
  'scenes.writeTip': 'Scenes in list order become the cycle: every scene track loops from 0, and each scene is a range that solos its tracks',
  'scenes.unwrite': '↶ Undo write',
  'scenes.written': (n, s) => `${n} scenes written to the cycle (${s} s)`,
  'scenes.queued': (s) => `next in ${s} s`,
  'scenes.remove': 'Remove this scene',
  'scenes.up': 'Earlier', 'scenes.down': 'Later',
});
Object.assign(I18N.ko, {
  'scenes.title': '씬',
  'scenes.fromLaunched': '+ 런치된 것으로 씬',
  'scenes.empty': '+ 빈 씬',
  'scenes.stop': '■ 모두 정지',
  'scenes.none': '아직 씬이 없습니다. 트랙을 런치(▶ 런치)한 뒤 “+ 런치된 것으로 씬”을 누르거나, 빈 씬을 만들고 트랙 칩을 클릭하세요.',
  'scenes.quant': '전환',
  'scenes.quant.now': '바로',
  'scenes.quant.end': '씬이 끝날 때',
  'scenes.follow': '다음 씬',
  'scenes.follow.off': '끔',
  'scenes.follow.once': '이어서 한 번',
  'scenes.follow.loop': '이어서 반복',
  'scenes.launch': '이 씬 런치 (이 씬의 트랙 시작, 다른 런치된 트랙 정지)',
  'scenes.len': '길이 (초, 0 = 자동: 가장 긴 트랙)',
  'scenes.auto': (s) => `자동 ${s}초`,
  'scenes.chipTip': '클릭: 이 트랙을 씬에 넣기 / 빼기',
  'scenes.write': '⇥ 사이클로 쓰기',
  'scenes.writeTip': '목록 순서의 씬들이 사이클이 됩니다: 씬 트랙은 0부터 반복하고, 씬마다 그 트랙을 솔로하는 구간이 생깁니다',
  'scenes.unwrite': '↶ 쓰기 되돌리기',
  'scenes.written': (n, s) => `씬 ${n}개를 사이클에 썼습니다 (${s}초)`,
  'scenes.queued': (s) => `${s}초 뒤 다음`,
  'scenes.remove': '이 씬 삭제',
  'scenes.up': '앞으로', 'scenes.down': '뒤로',
});
HELP_DB['mgr.scenes'] = {
  en: { title: 'Scenes', summary: 'A scene is a set of tracks launched together. Launching a scene starts its tracks (each loops by itself, like ▶ Launch) and stops the other launched tracks.', detail: 'Switch “at the scene\'s end” waits until the playing scene has run its length; clicking the waiting scene again switches at once. Follow plays the next scene in the list when a scene\'s length is over (once, or looping back to the first). Length 0 = auto (the longest of its tracks; a continuous Risset counts as 8 s). ⇥ Write to cycle turns the list into an arrangement with range solos (the same tool as Extend → Ritornello); ↶ Undo write puts the arrangement back.', formula: 'scene k starts at Σ lengths of scenes 1 … k−1' },
  ko: { title: '씬', summary: '씬은 함께 런치되는 트랙 묶음입니다. 씬을 런치하면 그 트랙이 시작되고(▶ 런치처럼 각자 반복), 다른 런치된 트랙은 멈춥니다.', detail: '“씬이 끝날 때” 전환은 재생 중인 씬이 자기 길이를 다 채울 때까지 기다리고, 대기 중인 씬을 다시 누르면 바로 바뀝니다. 다음 씬은 씬 길이가 끝나면 목록의 다음 씬을 재생합니다(한 번, 또는 처음으로 돌아가 반복). 길이 0 = 자동(트랙 중 가장 긴 것, 연속 리세는 8초). ⇥ 사이클로 쓰기는 목록을 구간 솔로로 된 배치로 바꿉니다(연장 → 리토르넬로와 같은 도구). ↶ 쓰기 되돌리기는 원래 배치로 돌려놓습니다.', formula: '씬 k의 시작 = 씬 1 … k−1 길이의 합' },
};

let host = null;
let hooks = { showToast: () => {} };
let raf = null;
const fmt = (x) => (+x.toFixed(2)).toString();

function select(value, opts, onChange) {
  return el('select', { class: 'mgr-scenes-sel', on: { change: (e) => onChange(e.target.value), keydown: (e) => e.stopPropagation() } },
    opts.map(([v, label]) => el('option', { value: v, selected: v === value, text: label })));
}

function sceneRow(sc, k, n, insts, state) {
  const playing = state.current?.id === sc.id;
  const waiting = state.queued?.id === sc.id;
  const auto = sceneLength({ ...sc, lenSec: 0 }, clipLength, DEFAULT_RISSET_CLIP);
  const bar = el('span', { class: 'mgr-scenes-bar', dataset: { scene: sc.id } });
  const play = el('button', {
    class: `mgr-btn mgr-scenes-play ${playing ? 'on' : ''} ${waiting ? 'wait' : ''}`,
    title: t('scenes.launch'),
    on: { click: () => { void launchScene(sc.id); } },
  }, [el('span', { text: playing ? '■' : '▶' }), bar]);
  const name = el('input', {
    class: 'mgr-scenes-name', value: sc.name, style: `border-left:4px solid ${sc.color}`,
    on: { change: (e) => setScene(sc.id, { name: e.target.value }), keydown: (e) => e.stopPropagation() },
  });
  const chips = el('div', { class: 'mgr-scenes-chips' }, insts.map((inst) => el('button', {
    class: `mgr-scenes-chip ${sc.tracks.includes(inst.id) ? 'in' : ''} ${isLaunched(inst.id) ? 'live' : ''}`,
    style: sc.tracks.includes(inst.id) ? `border-color:${inst.color};color:${inst.color}` : '',
    title: t('scenes.chipTip'),
    text: inst.name,
    on: { click: () => toggleSceneTrack(sc.id, inst.id) },
  })));
  const len = el('input', {
    type: 'number', min: '0', max: '300', step: '0.5', value: String(sc.lenSec || 0), class: 'mgr-scenes-len', title: t('scenes.len'),
    on: { change: (e) => setScene(sc.id, { lenSec: Math.max(0, Number(e.target.value) || 0) }), keydown: (e) => e.stopPropagation() },
  });
  return el('div', { class: `mgr-scenes-row ${playing ? 'playing' : ''}` }, [
    play, name,
    el('div', { class: 'flex items-center gap-1 whitespace-nowrap' }, [
      len,
      el('span', { class: 'mgr-muted', text: sc.lenSec ? 's' : t('scenes.auto', fmt(auto)) }),
      waiting ? el('span', { class: 'mgr-scenes-q', dataset: { q: sc.id }, text: t('scenes.queued', fmt(state.queued.in)) }) : null,
      el('button', { class: 'mgr-btn', text: '▲', title: t('scenes.up'), disabled: k === 0, on: { click: () => moveScene(sc.id, -1) } }),
      el('button', { class: 'mgr-btn', text: '▼', title: t('scenes.down'), disabled: k === n - 1, on: { click: () => moveScene(sc.id, 1) } }),
      el('button', { class: 'mgr-btn', text: '×', title: t('scenes.remove'), on: { click: () => removeScene(sc.id) } }),
    ]),
    chips,
  ]);
}

function tick() {
  raf = null;
  if (!host?.isConnected) return;
  const st = sceneState();
  host.querySelectorAll('.mgr-scenes-bar').forEach((b) => {
    const on = st.current && b.dataset.scene === st.current.id;
    b.style.width = on ? `${Math.min(100, (100 * (st.current.pos % st.current.len)) / st.current.len)}%` : '0';
  });
  if (st.queued) host.querySelectorAll('.mgr-scenes-q').forEach((q) => { q.textContent = t('scenes.queued', fmt(st.queued.in)); });
  if (st.current) raf = requestAnimationFrame(tick);
}

export function mountScenesCard(h, o = {}) {
  if (!h) return;
  host = h;
  hooks = { ...hooks, ...o };
  const insts = listInstances().filter((i) => !i.warp?.on);
  const scenes = listScenes();
  const state = sceneState();
  const launched = insts.filter((i) => isLaunched(i.id)).map((i) => i.id);
  const head = el('div', { class: 'mgr-card-head' }, [
    el('h3', { text: `▶ ${t('scenes.title')}` }),
    el('button', { class: 'mgr-btn', text: t('scenes.fromLaunched'), disabled: !launched.length, on: { click: () => addScene(launched) } }),
    el('button', { class: 'mgr-btn', text: t('scenes.empty'), on: { click: () => addScene([]) } }),
    el('button', { class: 'mgr-btn', text: t('scenes.stop'), on: { click: () => { void stopScenes(); } } }),
  ]);
  const opts = el('div', { class: 'mgr-scenes-opts' }, [
    el('span', { class: 'mgr-muted', text: t('scenes.quant') }),
    select(sceneQuant(), [['now', t('scenes.quant.now')], ['end', t('scenes.quant.end')]], (v) => setSceneOptions({ quant: v })),
    el('span', { class: 'mgr-muted', text: t('scenes.follow') }),
    select(sceneFollow(), [['off', t('scenes.follow.off')], ['once', t('scenes.follow.once')], ['loop', t('scenes.follow.loop')]], (v) => setSceneOptions({ follow: v })),
    el('button', {
      class: 'mgr-btn', text: t('scenes.write'), title: t('scenes.writeTip'), disabled: !scenes.some((s) => s.tracks.length),
      on: { click: () => { const r = writeScenesToCycle(clipLength, DEFAULT_RISSET_CLIP); if (r.ranges) hooks.showToast(t('scenes.written', r.ranges, fmt(r.total))); } },
    }),
    scenesWritten() ? el('button', { class: 'mgr-btn', text: t('scenes.unwrite'), on: { click: () => unwriteScenes() } }) : null,
  ]);
  const body = el('div', { class: 'mgr-scenes-body' }, scenes.length
    ? scenes.map((sc, k) => sceneRow(sc, k, scenes.length, insts, state))
    : [el('p', { class: 'mgr-muted', text: t('scenes.none') })]);
  host.replaceChildren(el('section', { class: 'mgr-card mgr-scenes', dataset: { help: 'mgr.scenes', rack: 'mgr-scenes' } }, [head, opts, body]));
  if (raf === null && state.current) raf = requestAnimationFrame(tick);
}

onScenesChange(() => { if (host?.isConnected) mountScenesCard(host); });
