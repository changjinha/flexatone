/**
 * Flexatone — studios/trajectory-targets.js
 * Layer 2 (studios, pure): what "Import trajectory" means in each single-line studio. Each target
 * writes the trajectory and the link in ONE edit of its own document (one undo step).
 * 계층 2 (studios, 순수): 단일 선을 쓰는 각 스튜디오에서 "궤적 불러오기"가 뜻하는 것. 궤적과 연결을 한 번의 편집으로 기록.
 *
 *   Cloud   → the pitch-centre curve (lo / hi = lowest / highest pitch, ≤ 32 breakpoints) and the
 *             piece length = the voice's duration: the cloud is scattered around the glissando
 *   Tempo   → the subject: source 'curve' = the received line (pitch over its own length)
 *   Fractal → FIF mode: the interpolation points (≤ 9) and the pitch range / length — the fractal
 *             detail (vertical scales d) grows on the imported line
 *   Glissando → one voice that the sends write (engine custom)
 * To add a studio: registerTrajectoryTarget(id, { apply }) here and put the send / receive buttons in its
 * strip (ui/trajectory-ui.js `createTrajectoryImportButton`). Sources: studios/trajectory-link.js
 * (Glissando) and audio/send-sources.js (every other studio).
 */

import { clamp, deepClone } from '../core/math-utils.js';
import { midiToFreq } from '../core/units.js';
import { registerSelfCheck, withIsolatedState, appState, createInitialState, resetHistory, createDefaultVoice, undo, dispatch } from '../core/state.js';
import {
  registerTrajectoryTarget, trajectoryBreakpoints, importTrajectory, getTrajLink, linksOfVoice, findLockedViolations, evaluateSends, setVoiceLinksLocked,
  addSend, buildSendPlan, moveInbound, getSends, MASTER, receivedVoiceId, unlinkTrajectory, listSourceLines,
} from './trajectory-link.js';
import { editCloud, getCloudParams } from './cloud-studio.js';
import { editTempo, getTempoParams } from './tempo-studio.js';
import { editFractal, getFractalParams } from './fractal-studio.js';
import { FIF_MAX_POINTS } from './fractal/fractal-engine.js';
import { editDraw } from './draw-studio.js';
import { createStroke, roundRaw } from './draw/draw-engine.js';
import { editField } from './field-studio.js';
import { editSpace } from './space-studio.js';

registerTrajectoryTarget('cloud', {
  apply(traj, { history = true, link = null } = {}) {
    const bp = trajectoryBreakpoints(traj, { maxPoints: 32 });
    editCloud((d) => {
      d.pitch.center = {
        ...d.pitch.center,
        engine: 'custom',
        lo: Number(clamp(bp.lo, 12, 120).toFixed(2)),
        hi: Number(clamp(bp.hi, 12, 120).toFixed(2)),
        reverse: false,
        inverse: false,
        customPoints: bp.points.map((p) => ({ x: p.x, y: p.y, handles: [] })),
      };
      d.length = Number(Math.max(1, traj.duration).toFixed(2));
      if (d.view) { d.view.curveTab = 'center'; d.view.tMin = 0; d.view.tMax = d.length; }
      d.trajLink = link;
    }, { history });
  },
});

registerTrajectoryTarget('tempo', {
  // the subject becomes the received curve (any studio's line) / 주제 = 받은 곡선 (어느 스튜디오의 선이든)
  apply(traj, { history = true, link = null } = {}) {
    editTempo((d) => {
      const L = Math.max(0.05, traj.duration);
      d.subject = { ...d.subject, source: 'curve', curve: traj.pts.map((p) => ({ s: Number((p.u * L).toFixed(4)), midi: Number(p.midi.toFixed(3)) })), curveLen: Number(L.toFixed(4)) };
      d.trajLink = link;
    }, { history });
  },
});

registerTrajectoryTarget('fractal', {
  apply(traj, { history = true, link = null } = {}) {
    // integer pitch range around the line, then breakpoints relative to it / 정수 음역을 잡고 그 안에서 꺾은점 계산
    let lo = Math.floor(traj.midiLo);
    let hi = Math.ceil(traj.midiHi);
    if (hi - lo < 2) { lo -= 6; hi += 6; }
    lo = clamp(lo, 12, 114);
    hi = clamp(hi, lo + 1, 120);
    const bp = trajectoryBreakpoints(traj, { maxPoints: FIF_MAX_POINTS, minGap: 0.02, lo, hi });
    let pts = bp.points;
    if (pts.length < 3) { // FIF needs an inner point to have something to refine / 내부 점이 하나는 있어야 함
      const mid = traj.pts[Math.floor(traj.pts.length / 2)];
      pts = [pts[0], { x: 0.5, y: Number(((mid.midi - lo) / (hi - lo)).toFixed(4)) }, pts[pts.length - 1]];
    }
    editFractal((d) => {
      d.mode = 'fif';
      d.preset = '';
      d.lo = lo;
      d.hi = hi;
      d.length = Number(clamp(traj.duration, 1, 240).toFixed(2));
      d.fif = { ...d.fif, points: pts.map((p) => ({ x: p.x, y: clamp(p.y, -0.5, 1.5) })) };
      d.trajLink = link;
    }, { history });
  },
});

// --- studios with several lines: the import fills one of them ----------------------------------
// Draw  → a stroke (raw points = the sampled line); re-imports replace that same stroke
// Field → the active particle's F0 / F1 / start / duration and the guiding curve (engine 'custom')
// Space → the active source's own pitch f_s(τ) (curve mode, lowest → highest pitch) and its timing
// 여러 선을 가진 스튜디오: 드로잉 = 스트로크 하나, 필드 = 활성 입자 + 가이드 곡선, 스페이스 = 활성 음원의 자체 음고

registerTrajectoryTarget('draw', {
  apply(traj, { history = true, link = null } = {}) {
    editDraw((d) => {
      const raw = traj.pts.map((p) => ({ t: traj.startTime + p.u * traj.duration, p: p.midi, w: 0.7 }));
      const at = link?.strokeId ? d.strokes.findIndex((s) => s.id === link.strokeId) : -1;
      let stroke;
      if (at >= 0) {
        stroke = d.strokes[at];
        stroke.raw = roundRaw(raw);
      } else {
        stroke = createStroke(d.strokes.length, raw, null);
        stroke.smooth = 0.05; // the line is already clean: keep it close to the voice / 이미 매끈한 선이므로 거의 그대로
        stroke.gainSource = 'fixed';
        d.strokes.push(stroke);
      }
      stroke.name = traj.name;
      stroke.direct = false;
      d.activeStrokeId = stroke.id;
      d.trajLink = link ? { ...link, strokeId: stroke.id } : link;
    }, { history });
  },
});

registerTrajectoryTarget('field', {
  apply(traj, { history = true, link = null } = {}) {
    const first = traj.pts[0].midi;
    const last = traj.pts[traj.pts.length - 1].midi;
    // The guide is y ∈ [0, 1] between the particle's F0 and F1. A line that returns to its start has
    // no usable F0 → F1 span, so the lowest / highest pitch are used instead.
    // 가이드는 입자의 F0–F1 사이 y. 시작·끝 음고가 같으면 최저·최고 음고를 사용
    const useEnds = Math.abs(last - first) >= 1;
    const m0 = useEnds ? first : traj.midiLo;
    const m1 = useEnds ? last : Math.max(traj.midiHi, traj.midiLo + 1);
    const span = m1 - m0;
    const bp = trajectoryBreakpoints({ ...traj, pts: traj.pts.map((p) => ({ u: p.u, midi: (p.midi - m0) / span })), midiLo: 0, midiHi: 1 }, { maxPoints: 32, lo: 0, hi: 1 });
    editField((d) => {
      const v = d.voices.find((x) => x.id === (link?.particleId || d.activeVoiceId)) || d.voices[0];
      if (!v) return;
      v.f0Midi = Number(clamp(m0, 0, 127).toFixed(2));
      v.f1Midi = Number(clamp(m1, 0, 127).toFixed(2));
      v.startTime = Number(Math.max(0, traj.startTime).toFixed(2));
      v.duration = Number(Math.max(0.1, traj.duration).toFixed(2));
      d.guiding = { ...d.guiding, engine: 'custom', customPoints: bp.points.map((p) => ({ x: p.x, y: p.y, handles: [] })) };
      d.activeVoiceId = v.id;
      d.trajLink = link ? { ...link, particleId: v.id } : link;
    }, { history });
  },
});

registerTrajectoryTarget('space', {
  apply(traj, { history = true, link = null } = {}) {
    const bp = trajectoryBreakpoints(traj, { maxPoints: 32 });
    editSpace((d) => {
      const s = d.sources.find((x) => x.id === (link?.sourceId || d.activeSourceId)) || d.sources[0];
      if (!s) return;
      s.f = {
        ...s.f,
        mode: 'curve',
        hz0: Number(midiToFreq(bp.lo).toFixed(3)),
        hz1: Number(midiToFreq(bp.hi).toFixed(3)),
        curve: { engine: 'custom', reverse: false, inverse: false, customPoints: bp.points.map((p) => ({ x: p.x, y: p.y, handles: [] })) },
      };
      s.start = Number(Math.max(0, traj.startTime).toFixed(2));
      s.duration = Number(Math.max(0.5, traj.duration).toFixed(2));
      d.activeSourceId = s.id;
      d.trajLink = link ? { ...link, sourceId: s.id } : link;
    }, { history });
  },
});

// Glissando → one voice of the editor (engine custom) that the sends write; its id is kept in the
// receive record. Name, colour, gain, timbre of that voice stay the user's.
// 글리산도 → 보내기가 쓰는 보이스 하나 (엔진 custom). 이름·색·게인·음색은 사용자 것.
const GLISS_SHAPE_KEYS = ['f0Hz', 'f0Midi', 'f0Fine', 'f1Hz', 'f1Midi', 'f1Fine', 'logScale', 'engine', 'lastNonCustomEngine', 'customPoints', 'startTime', 'duration', 'regions'];
registerTrajectoryTarget('glissando', {
  apply(traj, { history = true, link = null } = {}) {
    let lo = Math.floor(traj.midiLo);
    let hi = Math.ceil(traj.midiHi);
    if (hi - lo < 1) { lo -= 1; hi += 1; }
    lo = clamp(lo, 0, 126);
    hi = clamp(hi, lo + 1, 127);
    const bp = trajectoryBreakpoints(traj, { maxPoints: 48, minGap: 0.005, lo, hi });
    dispatch({
      type: 'sends/glissando',
      history,
      mutate: (s) => {
        const at = link?.voiceId ? s.voices.findIndex((v) => v.id === link.voiceId) : -1;
        const shape = createDefaultVoice(s.voices.length, {
          f0Hz: midiToFreq(lo), f0Midi: lo, f0Fine: 0, f1Hz: midiToFreq(hi), f1Midi: hi, f1Fine: 0, logScale: true,
          engine: 'custom', lastNonCustomEngine: 'harmonic', regions: [],
          customPoints: bp.points.map((p) => ({ x: p.x, y: p.y, handles: [] })),
          startTime: Number(Math.max(0, traj.startTime).toFixed(3)), duration: Number(Math.max(0.05, traj.duration).toFixed(3)),
        });
        let v;
        if (at >= 0) {
          v = { ...s.voices[at] };
          for (const k of GLISS_SHAPE_KEYS) v[k] = deepClone(shape[k]);
          s.voices = s.voices.map((x, i) => (i === at ? v : x));
        } else {
          v = { ...shape, name: `⤵ ${traj.name || 'Send'}` };
          s.voices = [...s.voices, v];
        }
        s.studioParams = { ...(s.studioParams || {}), glissando: { ...(s.studioParams?.glissando || {}), trajLink: link ? { ...link, voiceId: v.id } : link } };
      },
    });
  },
});

registerSelfCheck('Sends: Glissando → Cloud / Tempo / Fractal, lock is detected, linked edits follow, chains and Master, undo is one step', (a) => {
  withIsolatedState(() => {
    Object.assign(appState, createInitialState());
    const mk = (i, m0, m1, duration) => createDefaultVoice(i, { f0Midi: m0, f0Hz: midiToFreq(m0), f1Midi: m1, f1Hz: midiToFreq(m1), duration });
    appState.voices = [mk(0, 50, 74, 6), mk(1, 60, 55, 3)];
    appState.activeVoiceId = appState.voices[0].id;
    resetHistory();
    let v = appState.voices[0];

    a.ok(importTrajectory('cloud', v).ok, 'cloud import');
    const c = getCloudParams();
    a.near(c.pitch.center.lo, 50, 0.05, 'cloud centre starts at F0');
    a.near(c.pitch.center.hi, 74, 0.05, 'cloud centre reaches F1');
    a.near(c.length, 6, 1e-6, 'cloud length = voice duration');
    a.ok(getTrajLink('cloud')?.sends?.length === 1 && getSends()[0].locked === true, 'receive record stored, send locked');
    a.ok(undo(), 'one undo step');
    a.ok(getTrajLink('cloud') === null && getSends().length === 0 && getCloudParams().length !== 6, 'undo removes the send, the import and the record together');
    v = appState.voices[0]; // undo replaced the voice objects / 실행 취소가 보이스 객체를 교체함

    importTrajectory('cloud', v);
    importTrajectory('fractal', v);
    importTrajectory('tempo', appState.voices[1]);
    const f = getFractalParams();
    a.ok(f.mode === 'fif' && f.fif.points.length >= 3 && f.fif.points.length <= FIF_MAX_POINTS, 'fractal FIF points');
    a.near(f.lo + f.fif.points[0].y * (f.hi - f.lo), 50, 0.05, 'fractal line starts at F0');
    const sub = getTempoParams().subject;
    a.ok(sub.source === 'curve' && Math.abs(sub.curve[0].midi - 60) < 0.01 && Math.abs(sub.curveLen - 3) < 1e-3, 'tempo subject = received curve of voice 2');
    a.equal(linksOfVoice(v.id).map((x) => x.studio).join(), 'cloud,fractal', 'voice knows its studios');

    a.equal(findLockedViolations().length, 0, 'nothing changed yet');
    v.name = 'renamed';
    v.baseGain = 0.2;
    a.equal(findLockedViolations().length, 0, 'sound-only edits are free');
    v.f1Midi = 80;
    v.f1Hz = midiToFreq(80);
    a.equal(findLockedViolations().length, 2, 'a shape edit of a locked voice is detected (two sends)');
    v.f1Midi = 74; v.f1Hz = midiToFreq(74);

    setVoiceLinksLocked(v.id, false); // linked editing / 연동 편집
    v.duration = 9;
    a.equal(evaluateSends().join(), 'cloud,fractal', 'unlocked sends follow the voice');
    a.near(getCloudParams().length, 9, 1e-6, 'cloud followed the new duration');
    a.near(getFractalParams().length, 9, 1e-6, 'fractal followed');
    a.equal(evaluateSends().length, 0, 'second evaluation is a no-op');

    // chain: Glissando → Cloud → Draw, and Glissando → Draw (add) listed first / 사슬
    unlinkTrajectory('fractal');
    const r1 = addSend({ from: { studio: 'glissando', line: appState.voices[1].id }, to: 'draw', mode: 'add' });
    const r2 = addSend({ from: { studio: 'cloud', line: 'centre' }, to: 'draw', mode: 'replace' });
    a.ok(r1.ok && r2.ok, 'two sends into Draw');
    let p = buildSendPlan();
    a.ok(p.order.indexOf('cloud') < p.order.indexOf('draw'), 'Cloud is evaluated before Draw');
    a.equal(p.inbound.get('draw').map((e) => e.from).join(), 'glissando,cloud', 'Draw receives add first, then replace');
    a.ok(moveInbound('draw', r2.id, -1), 'reorder inside Draw');
    p = buildSendPlan();
    a.equal(p.inbound.get('draw').map((e) => e.mode).join(), 'replace,add', 'now replace first, then add');
    a.ok(addSend({ from: { studio: 'draw', line: 'mean' }, to: 'cloud' }).reason === 'loop', 'a direct send that closes a loop is refused');

    // master: every receiver except the source; loops skipped / 마스터
    const fl = listSourceLines('fractal')[0];
    a.ok(!!fl, 'fractal offers a line');
    const rm = addSend({ from: { studio: 'fractal', line: fl?.key }, to: MASTER });
    a.ok(rm.ok, 'master send');
    p = buildSendPlan();
    const via = p.edges.filter((e) => e.sendId === rm.id);
    a.ok(via.length >= 5 && !via.some((e) => e.to === 'fractal'), 'master → all receivers but Fractal');
    a.ok(via.some((e) => e.to === 'glissando') && receivedVoiceId(), 'Glissando received a voice');
    unlinkTrajectory('space');
    a.ok(getSends().find((s) => s.id === rm.id).except.includes('space'), 'unlink from a master send = except');
  });
}, { group: 'studio' });
