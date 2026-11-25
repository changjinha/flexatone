/**
 * Flexatone — ui/track-export.js
 * Layer 4 (ui): "Export tracks" — every track as its own WAV file.
 *   Sources / 대상:
 *     - Manager (cycle): every audible track of the cycle, each rendered alone over the WHOLE cycle (so the files
 *       line up from 0 in a DAW), through its fader, masks and fades and — when it is routed there — through the
 *       Space Master (the spatialised track). This is the main use: Space Master stems.
 *     - This studio: one file per line / voice / source of the studio on screen — Space sources (soloed scene),
 *       Glissando voices, Field particles, Draw strokes, Chaos / Fractal lines (audio/instance-render.js stems).
 *       A studio that makes a single sound (Risset, Cloud, Tempo, Wave, Grid) gives one file.
 *   Two or more files are collected in ONE folder: by default a .zip that holds the folder (works in every
 *   browser); "Save into a folder" (Chrome / Edge) asks for a place and writes the folder there.
 *   Options: output stage (output fader + limiter; off by default so the tracks add up to the mix), bit depth
 *   (16 / 24 / 32-bit float), the full mix as an extra file. Progress in % in the dialog and the floating badge.
 * 계층 4 (ui): "트랙 따로 내보내기" — 트랙마다 WAV 하나. 매니저(사이클 전체 길이, 스페이스 마스터 공간화 포함) 또는
 * 이 스튜디오의 선·보이스·음원. 2개 이상이면 폴더 하나로 모음 (기본 .zip, 크롬/엣지는 폴더에 직접 저장도 가능).
 */

import { t, I18N } from '../core/i18n.js';
import { appState } from '../core/state.js';
import { clamp } from '../core/math-utils.js';
import { buildZip, safeName } from '../core/zip-store.js';
import { StudioRegistry } from '../studios/registry.js';
import { encodeWav, triggerDownload, EXPORT_SAMPLE_RATE } from '../audio/audio-engine.js';
import { createOfflineOutput } from '../audio/output-bus.js';
import { listInstances, isInstanceAudible } from '../core/manager-state.js';
import * as mixer from '../audio/manager-mixer.js';
import { listInstanceStems, awaitInstanceBuffer, stemTarget } from '../audio/instance-source.js';
import { STEM_STUDIOS } from '../audio/instance-render.js';
import { renderSpaceBuffer } from '../studios/space/space-audio.js';
import { getSpaceParams, getSpaceDocTarget } from '../studios/space/space-doc.js';
import { HELP_DB } from './option-inspector.js';
import { showVideoProgress, hideVideoProgress } from './studio-video.js';
import { getProjectFileName } from './file-name-chip.js';

Object.assign(I18N.en, {
  'trx.button': '🎚 Tracks',
  'trx.menuTip': 'Every track as its own WAV; two or more are collected in one folder',
  'trx.title': 'Export tracks',
  'trx.sub': 'one WAV per track · 2 or more → one folder',
  'trx.scope': 'Tracks of',
  'trx.scope.manager': 'Manager cycle (Space Master included)',
  'trx.scope.studio': (name) => `This studio — ${name}`,
  'trx.tracks': 'Tracks',
  'trx.all': 'All',
  'trx.none': 'None',
  'trx.empty.manager': 'No audible track in the cycle.',
  'trx.empty.studio': 'This studio has nothing to export.',
  'trx.single': 'This studio makes one sound — it is exported as one file.',
  'trx.options': 'Options',
  'trx.outputStage': 'Output stage (fader + limiter)',
  'trx.outputStageTip': 'Off: the tracks add up to the mix before the output stage. On: each file as loud as it is heard alone (limited).',
  'trx.bits': 'Bit depth',
  'trx.bits.32': '32-bit float',
  'trx.mix': 'Also the full mix',
  'trx.pack': 'Two or more files',
  'trx.pack.zip': 'One folder in a .zip (download)',
  'trx.pack.dir': 'Save into a folder…',
  'trx.packDirOff': 'This browser cannot write into a folder — the .zip is used.',
  'trx.folderName': 'Folder name',
  'trx.export': 'Export',
  'trx.close': 'Close',
  'trx.cancel': 'Cancel',
  'trx.note.manager': 'Each file is the whole cycle with only that track, so all files start together.',
  'trx.note.studio': 'Each file has only that line / source; all start at 0.',
  'trx.rendering': (i, n, name) => `Rendering ${i} / ${n} · ${name}`,
  'trx.packing': 'Packing the folder…',
  'trx.done': (n, f) => `${n} file${n === 1 ? '' : 's'} → ${f}`,
  'trx.cancelled': 'Export cancelled.',
  'trx.nothing': 'Choose at least one track.',
  'trx.failed': (name) => `“${name}” is silent — skipped.`,
  'trx.mixName': 'Mix',
});
Object.assign(I18N.ko, {
  'trx.button': '🎚 트랙',
  'trx.menuTip': '트랙마다 WAV 하나씩; 2개 이상이면 폴더 하나에 모음',
  'trx.title': '트랙 따로 내보내기',
  'trx.sub': '트랙마다 WAV 하나 · 2개 이상 → 폴더 하나',
  'trx.scope': '대상',
  'trx.scope.manager': '매니저 사이클 (스페이스 마스터 포함)',
  'trx.scope.studio': (name) => `이 스튜디오 — ${name}`,
  'trx.tracks': '트랙',
  'trx.all': '전체',
  'trx.none': '없음',
  'trx.empty.manager': '사이클에 들리는 트랙이 없습니다.',
  'trx.empty.studio': '이 스튜디오에는 내보낼 것이 없습니다.',
  'trx.single': '이 스튜디오는 소리 하나를 만듭니다 — 파일 하나로 내보냅니다.',
  'trx.options': '옵션',
  'trx.outputStage': '출력 단계 (페이더 + 리미터)',
  'trx.outputStageTip': '끔: 트랙을 더하면 출력 단계 전의 믹스가 됩니다. 켬: 각 파일을 혼자 들을 때의 크기로 (리미터 적용).',
  'trx.bits': '비트 깊이',
  'trx.bits.32': '32비트 float',
  'trx.mix': '전체 믹스도 함께',
  'trx.pack': '파일이 2개 이상일 때',
  'trx.pack.zip': '폴더 하나를 .zip으로 (다운로드)',
  'trx.pack.dir': '폴더에 저장…',
  'trx.packDirOff': '이 브라우저는 폴더에 쓸 수 없습니다 — .zip을 씁니다.',
  'trx.folderName': '폴더 이름',
  'trx.export': '내보내기',
  'trx.close': '닫기',
  'trx.cancel': '취소',
  'trx.note.manager': '각 파일은 그 트랙만 남긴 사이클 전체 길이라, 모든 파일이 같이 시작합니다.',
  'trx.note.studio': '각 파일에는 그 선·음원만 들어 있고, 모두 0초에서 시작합니다.',
  'trx.rendering': (i, n, name) => `렌더링 ${i} / ${n} · ${name}`,
  'trx.packing': '폴더로 묶는 중…',
  'trx.done': (n, f) => `파일 ${n}개 → ${f}`,
  'trx.cancelled': '내보내기를 취소했습니다.',
  'trx.nothing': '트랙을 하나 이상 고르세요.',
  'trx.failed': (name) => `“${name}”은(는) 소리가 없어 건너뜀.`,
  'trx.mixName': '믹스',
});
HELP_DB['app.trackExport'] = {
  en: { title: 'Export tracks', summary: 'Every track as its own WAV file. Two or more files are collected in one folder (a .zip by default, or written straight into a folder you choose in Chrome / Edge).', detail: 'Manager cycle: each audible track rendered alone over the whole cycle — fader, fades, masks and the Space Master spatialisation included — so the files line up in a DAW (Space Master stems). This studio: one file per line / voice / source (Space sources, Glissando voices, Field particles, Draw strokes, Chaos and Fractal lines). The output stage is off by default so the files add up to the mix.', formula: 'Σ tracks = mix (output stage off)' },
  ko: { title: '트랙 따로 내보내기', summary: '트랙마다 WAV 파일 하나. 2개 이상이면 폴더 하나에 모읍니다 (기본은 .zip, 크롬·엣지에서는 고른 폴더에 직접 저장).', detail: '매니저 사이클: 들리는 트랙마다 사이클 전체 길이로 혼자 렌더 — 페이더·페이드·마스크·스페이스 마스터 공간화 포함 — 이라 DAW에서 그대로 줄이 맞습니다 (스페이스 마스터 스템). 이 스튜디오: 선·보이스·음원마다 파일 하나 (스페이스 음원, 글리산도 보이스, 필드 입자, 드로우 획, 카오스·프랙탈 선). 출력 단계는 기본으로 꺼져 있어 파일을 더하면 믹스가 됩니다.', formula: 'Σ 트랙 = 믹스 (출력 단계 끔)' },
};

const opts = { outputStage: false, bits: 24, mix: false, pack: 'zip' };
let dlg = null;
let state = null; // { scope, tracks, sel:Set, folder }
let job = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const studioName = (id) => { const p = StudioRegistry.get(id); return p?.name?.[appState.lang] || p?.name?.en || id; };
const canDir = () => typeof globalThis.showDirectoryPicker === 'function';

// ==========================================================================
// Track sources / 트랙 목록
// ==========================================================================

/** The output stage applied to a raw buffer (output fader + limiter), offline. / 출력 단계 적용 */
async function withOutputStage(buffer) {
  if (!buffer) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(Math.max(2, buffer.numberOfChannels), buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(createOfflineOutput(ctx));
  src.start(0);
  return ctx.startRendering();
}

function managerTracks() {
  const list = listInstances().filter((i) => i.inCycle && isInstanceAudible(i) && mixer.clipLength(i) >= 0.02);
  return {
    tracks: list.map((inst) => ({
      key: inst.id,
      name: inst.name || inst.id,
      color: inst.color || '#94a3b8',
      sub: `${studioName(inst.studio)} · ${(Number(inst.start) || 0).toFixed(1)}–${((Number(inst.start) || 0) + mixer.clipLength(inst)).toFixed(1)} s`,
      render: async (o) => { const r = await mixer.exportCycleWav({ download: false, only: [inst.id], outputStage: o.outputStage }); return r.ok ? r.buffer : null; },
    })),
    mix: async (o) => { const r = await mixer.exportCycleWav({ download: false, outputStage: o.outputStage }); return r.ok ? r.buffer : null; },
    empty: t('trx.empty.manager'),
  };
}

function spaceTracks() {
  const params = getSpaceParams();
  const solo = (id) => ({ ...params, sources: params.sources.map((s) => ({ ...s, solo: s.id === id, muted: s.id === id ? false : s.muted })) });
  const anySolo = params.sources.some((s) => s.solo);
  return {
    tracks: params.sources.filter((s) => (anySolo ? s.solo : !s.muted)).map((s) => ({
      key: s.id,
      name: s.name || s.id,
      color: s.color || '#94a3b8',
      sub: s.input?.kind === 'import' || s.input?.kind === 'track' ? String(s.input.target || '') : '',
      render: (o) => renderSpaceBuffer({ params: solo(s.id), outputStage: o.outputStage }),
    })),
    mix: (o) => renderSpaceBuffer({ params, outputStage: o.outputStage }),
    empty: t('trx.empty.studio'),
  };
}

function studioTracks(studio) {
  if (studio === 'space') return spaceTracks();
  const base = `@${studio}`;
  const whole = async (o) => { const r = await awaitInstanceBuffer({ target: base, content: 'doc', sampleRate: EXPORT_SAMPLE_RATE }); return o.outputStage ? withOutputStage(r.buffer) : r.buffer; };
  const st = STEM_STUDIOS[studio] ? listInstanceStems(base) : { ok: false };
  if (st.ok) {
    return {
      tracks: st.list.map((l) => ({
        key: l.key,
        name: l.name,
        color: '#94a3b8',
        sub: '',
        render: async (o) => { const r = await awaitInstanceBuffer({ target: stemTarget(base, l.key), content: 'doc', sampleRate: EXPORT_SAMPLE_RATE }); return o.outputStage ? withOutputStage(r.buffer) : r.buffer; },
      })),
      mix: whole,
      empty: t('trx.empty.studio'),
    };
  }
  return { tracks: [{ key: base, name: studioName(studio), color: '#94a3b8', sub: '', render: whole }], mix: null, empty: t('trx.empty.studio'), note: t('trx.single') };
}

function loadScope(scope) {
  const studio = StudioRegistry.resolveStudioId();
  let src;
  try { src = scope === 'manager' ? managerTracks() : studioTracks(studio); } catch (err) { console.error('[Flexatone] track export:', err); src = { tracks: [], mix: null, empty: t('trx.empty.studio') }; }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = getProjectFileName().replace(/\.json$/i, '');
  const what = scope === 'manager' ? (getSpaceDocTarget() === 'master' || studio === 'space' ? 'SpaceMaster' : 'Manager') : studio;
  state = { scope, studio, ...src, sel: new Set(src.tracks.map((x) => x.key)), folder: safeName(`${file || 'Flexatone'}_${what}_tracks_${stamp}`) };
}

// ==========================================================================
// Dialog / 대화상자
// ==========================================================================

/**
 * Open Export tracks. scope 'manager' | 'studio'; without it: Manager when the Space Studio shows the Space
 * Master, else this studio. / 트랙 따로 내보내기 열기
 */
export function openTrackExportDialog({ hooks, scope = null } = {}) {
  if (dlg) { dlg.focus(); return; }
  const studio = StudioRegistry.resolveStudioId();
  const sc = scope || (studio === 'space' && getSpaceDocTarget() === 'master' ? 'manager' : 'studio');
  loadScope(sc);
  dlg = document.createElement('div');
  dlg.className = 'mgr-vid-backdrop fx-trx-backdrop';
  dlg.tabIndex = -1;
  dlg.innerHTML = `
    <div class="mgr-vid fx-trx" role="dialog" aria-label="${esc(t('trx.title'))}">
      <div class="mgr-vid-head"><b>🎚 ${esc(t('trx.title'))}</b><span class="mgr-muted">${esc(t('trx.sub'))}</span><span style="flex:1"></span><button class="mgr-btn" data-v="close">✕</button></div>
      <div class="mgr-vid-body"><div class="mgr-vid-opts" id="trxOpts"></div></div>
      <div class="mgr-vid-foot">
        <div class="mgr-vid-progress"><span id="trxBar"></span></div>
        <b class="mgr-mono" id="trxPct">0%</b>
        <span class="mgr-mono mgr-muted" id="trxStatus"></span>
        <span style="flex:1"></span>
        <button class="mgr-btn" data-v="cancel">${esc(t('trx.close'))}</button>
        <button class="mgr-btn play" data-v="export">⬇ ${esc(t('trx.export'))}</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('change', onChange);
  dlg.addEventListener('click', (e) => onClick(e, hooks));
  dlg.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && !job) close(); });
  render();
  dlg.focus();
}

function close() {
  if (job) return;
  dlg?.remove();
  dlg = null;
}

function render() {
  const box = dlg?.querySelector('#trxOpts');
  if (!box) return;
  const tr = state.tracks;
  box.innerHTML = `
    <fieldset><legend>${esc(t('trx.scope'))}</legend>
      <select data-o="scope">
        <option value="manager" ${state.scope === 'manager' ? 'selected' : ''}>${esc(t('trx.scope.manager'))}</option>
        <option value="studio" ${state.scope === 'studio' ? 'selected' : ''}>${esc(t('trx.scope.studio', studioName(state.studio)))}</option>
      </select>
      <div class="mgr-muted">${esc(state.note || t(state.scope === 'manager' ? 'trx.note.manager' : 'trx.note.studio'))}</div>
    </fieldset>
    <fieldset><legend>${esc(t('trx.tracks'))} · ${state.sel.size} / ${tr.length}</legend>
      ${tr.length ? `<div class="mgr-vid-row"><button class="mgr-btn tiny" data-v="all">${esc(t('trx.all'))}</button><button class="mgr-btn tiny" data-v="none">${esc(t('trx.none'))}</button></div>
      <div class="fx-trx-list">${tr.map((x, i) => `<label class="fx-trx-item"><input type="checkbox" data-trk="${esc(x.key)}" ${state.sel.has(x.key) ? 'checked' : ''}><span class="fx-trx-dot" style="background:${esc(x.color)}"></span><span class="mgr-mono mgr-muted">${String(i + 1).padStart(2, '0')}</span><span class="fx-trx-name">${esc(x.name)}</span><span class="mgr-muted">${esc(x.sub || '')}</span></label>`).join('')}</div>` : `<div class="mgr-muted">${esc(state.empty)}</div>`}
    </fieldset>
    <fieldset><legend>${esc(t('trx.options'))}</legend>
      <label title="${esc(t('trx.outputStageTip'))}"><input type="checkbox" data-o="outputStage" ${opts.outputStage ? 'checked' : ''}> ${esc(t('trx.outputStage'))}</label>
      <label>${esc(t('trx.bits'))} <select data-o="bits">${[[16, '16-bit'], [24, '24-bit'], [32, t('trx.bits.32')]].map(([v, l]) => `<option value="${v}" ${opts.bits === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      ${state.mix ? `<label><input type="checkbox" data-o="mix" ${opts.mix ? 'checked' : ''}> ${esc(t('trx.mix'))}</label>` : ''}
      <label>${esc(t('trx.pack'))} <select data-o="pack"><option value="zip" ${opts.pack === 'zip' ? 'selected' : ''}>${esc(t('trx.pack.zip'))}</option><option value="dir" ${opts.pack === 'dir' ? 'selected' : ''} ${canDir() ? '' : 'disabled'}>${esc(t('trx.pack.dir'))}</option></select></label>
      ${canDir() ? '' : `<div class="mgr-muted">${esc(t('trx.packDirOff'))}</div>`}
      <label>${esc(t('trx.folderName'))} <input type="text" data-o="folder" value="${esc(state.folder)}" class="fx-trx-folder"></label>
    </fieldset>`;
  setBusy(!!job);
}

function onChange(e) {
  const el = e.target;
  if (el.dataset.trk) { if (el.checked) state.sel.add(el.dataset.trk); else state.sel.delete(el.dataset.trk); render(); return; }
  const k = el.dataset.o;
  if (!k) return;
  if (k === 'scope') { loadScope(el.value); render(); return; }
  if (k === 'outputStage' || k === 'mix') opts[k] = el.checked;
  else if (k === 'bits') opts.bits = Number(el.value) || 24;
  else if (k === 'pack') opts.pack = el.value === 'dir' && canDir() ? 'dir' : 'zip';
  else if (k === 'folder') state.folder = safeName(el.value, state.folder);
}

async function onClick(e, hooks) {
  const el = e.target.closest('[data-v]');
  if (!el && e.target === dlg && !job) { close(); return; }
  if (!el) return;
  switch (el.dataset.v) {
    case 'close': if (!job) close(); break;
    case 'cancel': if (job) job.cancelled = true; else close(); break;
    case 'all': state.sel = new Set(state.tracks.map((x) => x.key)); render(); break;
    case 'none': state.sel = new Set(); render(); break;
    case 'export': if (!job) await run(hooks); break;
    default: break;
  }
}

function setBusy(on) {
  if (!dlg) return;
  for (const el of dlg.querySelectorAll('#trxOpts input, #trxOpts select, #trxOpts button, [data-v="export"]')) el.disabled = on;
  dlg.classList.toggle('busy', on);
  const c = dlg.querySelector('[data-v="cancel"]');
  if (c) c.textContent = on ? t('trx.cancel') : t('trx.close');
}

function progress(frac, text, { badge = true } = {}) {
  const pct = Math.floor(clamp(frac, 0, 1) * 100);
  const bar = dlg?.querySelector('#trxBar');
  if (bar) bar.style.width = `${pct}%`;
  const p = dlg?.querySelector('#trxPct');
  if (p) p.textContent = `${pct}%`;
  const st = dlg?.querySelector('#trxStatus');
  if (st) st.textContent = text;
  if (badge) showVideoProgress({ icon: '🎚', label: t('trx.title'), frac, text, onStop: job && frac < 1 ? () => { if (job) job.cancelled = true; } : null });
}

// ==========================================================================
// Export / 내보내기
// ==========================================================================

async function run(hooks) {
  const chosen = state.tracks.filter((x) => state.sel.has(x.key));
  if (!chosen.length) { hooks?.showToast?.(t('trx.nothing'), 'error'); return; }
  const o = { outputStage: opts.outputStage };
  const items = chosen.map((x, i) => ({ ...x, file: `${String(i + 1).padStart(2, '0')}_${safeName(x.name)}.wav` }));
  if (opts.mix && state.mix) items.push({ key: '_mix', name: t('trx.mixName'), render: state.mix, file: `00_${safeName(t('trx.mixName'))}.wav` });
  const folder = safeName(state.folder, 'Flexatone_tracks');
  // the folder picker needs the click, so it comes before any rendering / 폴더 선택은 클릭 직후에 (렌더 전)
  let dir = null;
  if (items.length > 1 && opts.pack === 'dir' && canDir()) {
    try { dir = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'flexatone-tracks' }); } catch (err) { if (err?.name === 'AbortError') return; console.error(err); dir = null; }
  }
  job = { cancelled: false };
  setBusy(true);
  const files = [];
  try {
    for (let i = 0; i < items.length; i++) {
      if (job.cancelled) break;
      const it = items[i];
      progress(i / items.length, t('trx.rendering', i + 1, items.length, it.name));
      await new Promise((r) => setTimeout(r, 0)); // let the progress paint / 진행률 그리기
      let buf = null;
      try { buf = await it.render(o); } catch (err) { console.error('[Flexatone] track render:', it.name, err); }
      if (!buf) { hooks?.showToast?.(t('trx.failed', it.name), 'info'); continue; }
      files.push({ name: it.file, data: encodeWav(buf, { bitDepth: opts.bits }) });
    }
    if (job.cancelled) { progress(0, t('trx.cancelled'), { badge: false }); hideVideoProgress(); return; }
    if (!files.length) { hooks?.showToast?.(t('toast.noAudio'), 'error'); progress(0, t('toast.noAudio'), { badge: false }); hideVideoProgress(); return; }
    progress(0.99, t('trx.packing'));
    let where;
    if (files.length === 1) {
      triggerDownload(new Blob([files[0].data], { type: 'audio/wav' }), `${folder}_${files[0].name}`);
      where = `${folder}_${files[0].name}`;
    } else if (dir) {
      const sub = await dir.getDirectoryHandle(folder, { create: true });
      for (const f of files) {
        const h = await sub.getFileHandle(f.name, { create: true });
        const w = await h.createWritable();
        await w.write(f.data);
        await w.close();
      }
      where = `${dir.name}/${folder}/`;
    } else {
      const zip = buildZip(files.map((f) => ({ name: `${folder}/${f.name}`, data: f.data })));
      triggerDownload(zip, `${folder}.zip`);
      where = `${folder}.zip`;
    }
    progress(1, t('trx.done', files.length, where));
    hooks?.showToast?.(t('trx.done', files.length, where));
    hideVideoProgress(4000);
  } catch (err) {
    console.error('[Flexatone] track export:', err);
    hooks?.showToast?.(String(err?.message || err), 'error');
    hideVideoProgress();
  } finally {
    job = null;
    setBusy(false);
  }
}
