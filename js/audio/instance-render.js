/**
 * Flexatone — audio/instance-render.js
 * Layer 3 (audio): the renderer behind audio/instance-source.js — turns a Manager instance (or a
 * studio's editor document) into an AudioBuffer with the renderers the Manager already uses.
 * 계층 3 (audio): instance-source.js의 렌더러 — 매니저 인스턴스(또는 에디터 문서)를 매니저가 쓰는
 * 렌더러 그대로 AudioBuffer로.
 *
 * Imported once at start-up (main.js). It registers itself; nothing imports its exports, so the
 * studio audio files stay free of a dependency on the mixer (no circular import).
 * 시작 시 한 번 import되어 스스로 등록. 스튜디오 오디오 파일은 믹서에 의존하지 않음.
 *
 * content 'doc'   — the document as it is: rate 1, no masks / warps / tremolo / fader.
 * content 'heard' — what the Manager track plays (mixer `renderHeard`: tempo, warp, masks, tremolo,
 *                   takes; the track fader is not part of the buffer).
 * A target that is being rendered further up the chain (A imports B imports A) is refused: 'cycle'.
 */

import { appState } from '../core/state.js';
import { t } from '../core/i18n.js';
import { listInstances, getInstance, getInstanceDoc, MANAGER_STUDIOS } from '../core/manager-state.js';
import { StudioRegistry } from '../studios/registry.js';
import { renderOfflineBuffer, getPlayableTimeline } from './audio-engine.js';
import { isClipStudio, resolveClipParams, renderClipStudio, clipStudioLength, clipStudioKey } from './studio-clips.js';
import { renderFieldBuffer, getFieldTimeline } from '../studios/field/field-audio.js';
import { renderRissetBuffer, resolveRissetDoc } from '../studios/risset/risset-audio.js';
import { instanceRenderApi, clipLength, DEFAULT_RISSET_CLIP } from './manager-mixer.js';
import { setInstanceRenderer, baseTarget, stemOf } from './instance-source.js';
import { listSourceLines, MEAN_LINE } from '../studios/trajectory-link.js';
import { lineMixGain } from '../core/line-mix.js';

const EDITOR = '@';
const describing = []; // targets whose key is being computed (re-entrancy = a cycle) / 키 계산 중인 대상

/** Editor document of a studio as a pseudo-instance (getInstanceDoc reads ctxDoc). / 에디터 문서 */
function editorInstance(studio) {
  if (!MANAGER_STUDIOS.includes(studio) || !StudioRegistry.has(studio)) return null;
  const doc = studio === 'glissando'
    ? { voices: appState.voices, activeVoiceId: appState.activeVoiceId, params: appState.studioParams?.glissando ?? null }
    : appState.studioParams?.[studio] ?? null;
  return { id: `${EDITOR}${studio}`, studio, name: t(`mgr.short.${studio}`), color: '#94a3b8', ctxDoc: doc, editor: true };
}

function resolve(rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget) return null;
  const target = baseTarget(rawTarget); // '<target>#<stem>' names one line of it / 선 하나를 지정한 대상
  if (target.startsWith(EDITOR)) return editorInstance(target.slice(1));
  return getInstance(target);
}

// --------------------------------------------------------------------------
// Stems: one line / voice of a document, rendered alone / 스템: 문서의 선·보이스 하나만 렌더
// --------------------------------------------------------------------------

/** How a studio renders one line alone: by its voice list, or by soloing in its line mix. / 한 선만 렌더하는 방법 */
export const STEM_STUDIOS = Object.freeze({ glissando: 'voices', field: 'voices', draw: 'strokes', chaos: 'lineMix', fractal: 'lineMix' });

/** The document with only the line `key` sounding (new object; the stored document is untouched). */
export function stemDoc(studio, doc, key) {
  const how = STEM_STUDIOS[studio];
  if (!how || !doc || typeof doc !== 'object') return doc;
  if (studio === 'glissando') return { ...doc, voices: voicesOf(doc).filter((v) => v.id === key).map((v) => ({ ...v, solo: false })) };
  if (how === 'lineMix') {
    const mix = {};
    for (const [k, e] of Object.entries(doc.lineMix || {})) mix[k] = { ...e, solo: false };
    mix[key] = { ...(mix[key] || {}), solo: true };
    return { ...doc, lineMix: mix };
  }
  return { ...doc, [how]: (Array.isArray(doc[how]) ? doc[how] : []).map((v) => ({ ...v, solo: v.id === key })) };
}

/** Rough level of one line (its own gain setting) — only used to choose which stems to keep. / 스템 선별용 대략의 레벨 */
function stemLevel(studio, doc, key) {
  if (STEM_STUDIOS[studio] === 'lineMix') return lineMixGain(doc, key);
  const list = studio === 'draw' ? doc?.strokes : doc?.voices;
  const v = (Array.isArray(list) ? list : []).find((x) => x.id === key);
  const g = Number(v?.baseGain ?? v?.gain);
  return Number.isFinite(g) ? g : 1;
}

function stems(target) {
  const inst = resolve(target);
  if (!inst) return { ok: false, reason: 'missing' };
  if (!STEM_STUDIOS[inst.studio]) return { ok: false, reason: 'unsupported', studio: inst.studio };
  const doc = getInstanceDoc(inst);
  const list = listSourceLines(inst.studio, inst.editor ? null : inst.id).filter((l) => l.key !== MEAN_LINE).map((l) => {
    let sum = 0;
    let n = 0;
    for (const p of l.pts) if (Number.isFinite(p.m)) { sum += p.m; n++; }
    return { key: String(l.key), name: String(l.name ?? l.key), pitch: n ? sum / n : 0, level: stemLevel(inst.studio, doc, String(l.key)) };
  });
  if (list.length < 2) return { ok: false, reason: 'single', studio: inst.studio };
  return { ok: true, list, studio: inst.studio };
}

const voicesOf = (doc) => (Array.isArray(doc?.voices) ? doc.voices : []);
function fullParams(inst, doc) {
  if (inst.studio === 'risset') return resolveRissetDoc(doc);
  if (isClipStudio(inst.studio)) return resolveClipParams(inst.studio, doc);
  const plugin = StudioRegistry.get(inst.studio);
  return { ...(plugin ? plugin.defaultParams() : {}), ...(doc && typeof doc === 'object' ? doc : {}) };
}

/** One-pass length (s) of the document itself. / 문서 자체의 1회 길이 */
function docLength(inst, doc) {
  if (inst.studio === 'glissando') return getPlayableTimeline(voicesOf(doc)).endSec;
  if (inst.studio === 'risset') return Number(inst.length) > 0 ? Number(inst.length) : DEFAULT_RISSET_CLIP;
  if (isClipStudio(inst.studio)) return clipStudioLength(inst.studio, fullParams(inst, doc));
  return getFieldTimeline(fullParams(inst, doc)).endSec;
}

function describe(rawTarget, content) {
  const inst = resolve(rawTarget);
  if (!inst) return { ok: false, reason: 'missing' };
  const target = baseTarget(rawTarget);
  const stem = stemOf(rawTarget);
  if (stem !== null && !STEM_STUDIOS[inst.studio]) return { ok: false, reason: 'missing' };
  if (describing.includes(target)) return { ok: false, reason: 'cycle' };
  describing.push(target);
  try {
    const doc = getInstanceDoc(inst);
    const heard = content === 'heard' && !inst.editor && stem === null; // a stem is always the document itself / 스템은 항상 문서 그대로
    let key;
    let length;
    if (heard) {
      length = clipLength(inst);
      key = `heard|${length}|${instanceRenderApi.docKey(inst, doc)}`;
    } else {
      length = docLength(inst, doc);
      const own = inst.studio === 'glissando' ? JSON.stringify([voicesOf(doc), appState.legatoJoin, appState.sampleJoin, appState.joinGlideMs, doc?.params?.voiceMod ?? null]) : isClipStudio(inst.studio) ? clipStudioKey(inst.studio, fullParams(inst, doc)) : null;
      key = `doc|${inst.studio}|${length}|${own ?? JSON.stringify(doc ?? null)}`;
    }
    if (stem !== null) key = `${key}|stem:${stem}`;
    return { ok: true, key, name: inst.name, studio: inst.studio, color: inst.color, length: Number.isFinite(length) ? length : 0 };
  } finally {
    describing.pop();
  }
}

async function render(rawTarget, content, sampleRate, chain = []) {
  const inst = resolve(rawTarget);
  const target = baseTarget(rawTarget);
  if (!inst || chain.includes(target)) return null;
  const stem = stemOf(rawTarget);
  const next = [...chain, target];
  if (stem !== null) {
    // One line alone: the full parameters with every other line silenced (same length as the whole)
    // 선 하나만: 다른 선을 모두 끈 전체 파라미터 (길이는 전체와 같음)
    const raw = getInstanceDoc(inst);
    if (inst.studio === 'glissando') return renderOfflineBuffer({ voices: stemDoc('glissando', raw, stem).voices, sampleRate, voiceMod: raw?.params?.voiceMod ?? null });
    const params = stemDoc(inst.studio, fullParams(inst, raw), stem);
    if (isClipStudio(inst.studio)) return renderClipStudio(inst.studio, params, sampleRate, { rate: 1, importChain: next });
    return renderFieldBuffer({ params, sampleRate, outputStage: false });
  }
  const doc = getInstanceDoc(inst);
  if (content === 'heard' && !inst.editor) return instanceRenderApi.renderHeard(inst, doc, sampleRate, clipLength(inst));
  if (inst.studio === 'glissando') return renderOfflineBuffer({ voices: voicesOf(doc), sampleRate, voiceMod: doc?.params?.voiceMod ?? null });
  if (inst.studio === 'risset') return renderRissetBuffer({ seconds: Math.min(180, Math.max(1, Math.ceil(docLength(inst, doc)))), params: fullParams(inst, doc), sampleRate, outputStage: false });
  if (isClipStudio(inst.studio)) return renderClipStudio(inst.studio, fullParams(inst, doc), sampleRate, { rate: 1, importChain: next });
  return renderFieldBuffer({ params: fullParams(inst, doc), sampleRate, outputStage: false });
}

/** Every instance + the editor document of every studio that has no instance. / 가져올 수 있는 대상 */
function list() {
  const out = listInstances().map((i) => ({ target: i.id, name: i.name, studio: i.studio, color: i.color }));
  for (const studio of MANAGER_STUDIOS) {
    if (out.some((x) => x.studio === studio)) continue;
    const e = editorInstance(studio);
    if (e) out.push({ target: e.id, name: e.name, studio, color: e.color, editor: true });
  }
  return out;
}

setInstanceRenderer({ describe, render, list, stems });
