/**
 * Flexatone — core/midi-file.js
 * Layer 0 (core, pure): Standard MIDI Files ↔ pitch lines, with MPE.
 *   - writeMidiFile(tracks) / readMidiFile(bytes): SMF type 1 writer and a type 0 / 1 reader (running status,
 *     tempo map, SMPTE division, RPN 0 pitch-bend range, MPE Configuration Message).
 *   - linesToMidi(groups, opts): pitch lines [{ t, m }] (seconds, fractional MIDI) → note + pitch-bend events.
 *       mode 'mpe'   lower zone: channel 1 = master, notes on 2…16, one note per channel, ±bendRange (48)
 *       mode 'multi' channel per note on 1…16 except 10, ±bendRange (default 2), no zone message
 *       mode 'notes' notes only: every line is cut where its nearest semitone changes (for notation)
 *     A line that leaves the bend range is re-struck (legato) on a new base note.
 *   - midiToLines(parsed, opts): notes with their bends → lines; `join` merges touching notes of one channel.
 * 계층 0 (core, 순수): 표준 MIDI 파일 ↔ 음고 선 (MPE 포함). 내보내기는 노트 + 피치벤드, 가져오기는 벤드를 따라 선으로.
 */

import { registerSelfCheck } from './state.js';

export const MIDI_PPQ = 960;
export const MIDI_EXPORT_BPM = 120;
export const MIDI_MODES = Object.freeze(['mpe', 'multi', 'notes']);
const TPS = (MIDI_PPQ * MIDI_EXPORT_BPM) / 60; // ticks per second at the export tempo / 초당 틱
const BEND_HZ = 100; // bend messages per second at most / 초당 최대 벤드 메시지
const MAX_LINE_SEC = 3600;

// --------------------------------------------------------------------------
// Bytes / 바이트
// --------------------------------------------------------------------------

function vlq(n) {
  let v = Math.max(0, Math.round(n));
  const out = [v & 0x7f];
  while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
  return out;
}

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const ascii = (s) => [...String(s)].map((c) => c.charCodeAt(0) & 0x7f);

/**
 * tracks: [{ name, events: [{ tick, data: number[] }] }] (data = a channel or meta message without delta).
 * → Uint8Array of an SMF type 1 file. / SMF 타입 1 파일
 */
export function writeMidiFile(tracks, { ppq = MIDI_PPQ } = {}) {
  const chunks = [[...ascii('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(ppq)]];
  for (const tr of tracks) {
    const evs = [...(tr.events || [])].map((e, i) => ({ ...e, i })).sort((a, b) => a.tick - b.tick || (a.order ?? 0) - (b.order ?? 0) || a.i - b.i);
    const body = [];
    if (tr.name) { const nm = ascii(tr.name).slice(0, 120); body.push(0, 0xff, 0x03, ...vlq(nm.length), ...nm); }
    let last = 0;
    for (const e of evs) {
      const tick = Math.max(last, Math.round(e.tick));
      // several channel messages in one event: each gets its own (zero) delta / 여러 메시지면 각각 델타
      const msgs = e.data[0] === 0xff ? [e.data] : e.data.reduce((acc, x) => { if (x & 0x80 || !acc.length) acc.push([x]); else acc[acc.length - 1].push(x); return acc; }, []);
      msgs.forEach((m, k) => body.push(...vlq(k === 0 ? tick - last : 0), ...m));
      last = tick;
    }
    body.push(0, 0xff, 0x2f, 0);
    chunks.push([...ascii('MTrk'), ...u32(body.length), ...body]);
  }
  return Uint8Array.from(chunks.flat());
}

/**
 * Parse an SMF. → { format, ppq, smpte, tracks: [{ name, events: [{ tick, sec, status, ch, d1, d2, meta?, metaData? }] }], tempos }
 * Seconds come from the tempo map (all tracks). / SMF 해석 (초는 템포 맵 기준)
 */
export function readMidiFile(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; };
  const rd32 = () => { const v = ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]; p += 4; return v; };
  const rd16 = () => { const v = (b[p] << 8) + b[p + 1]; p += 2; return v; };
  const rdVlq = (end) => { let v = 0; for (let k = 0; k < 4 && p < end; k++) { const c = b[p++]; v = (v << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return v; };
  if (b.length < 14 || str(4) !== 'MThd') throw new Error('Not a MIDI file (no MThd header)');
  p += 4;
  const hlen = rd32();
  const hStart = p;
  const format = rd16();
  const ntr = rd16();
  const div = rd16();
  p = hStart + hlen;
  const smpte = (div & 0x8000) !== 0;
  const ppq = smpte ? 0 : div;
  const tpsSmpte = smpte ? (256 - (div >> 8)) * (div & 0xff) : 0; // frames/s × ticks/frame / 초당 틱
  const tracks = [];
  for (let k = 0; k < ntr && p + 8 <= b.length; k++) {
    const id = str(4);
    p += 4;
    const len = rd32();
    const end = Math.min(b.length, p + len);
    if (id !== 'MTrk') { p = end; continue; }
    const events = [];
    let tick = 0;
    let run = 0;
    let name = '';
    while (p < end) {
      tick += rdVlq(end);
      let st = b[p];
      if (st & 0x80) p++;
      else st = run; // running status / 러닝 스테이터스
      if (st === 0xff) {
        const type = b[p++];
        const n = rdVlq(end);
        const data = b.slice(p, p + n);
        p += n;
        if (type === 0x03 && !name) name = String.fromCharCode(...data);
        events.push({ tick, status: 0xff, meta: type, metaData: data });
        if (type === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { const n = rdVlq(end); p += n; continue; } // sysex skipped / sysex 무시
      if (!(st & 0x80)) { p++; continue; } // corrupt byte: skip / 손상 바이트
      run = st;
      const hi = st & 0xf0;
      const d1 = b[p++] ?? 0;
      const d2 = hi === 0xc0 || hi === 0xd0 ? 0 : b[p++] ?? 0;
      events.push({ tick, status: hi, ch: st & 0x0f, d1, d2 });
    }
    p = end;
    tracks.push({ name, events });
  }
  // tempo map from every track (type 1 keeps it in track 0) / 템포 맵
  const tempos = [];
  for (const tr of tracks) for (const e of tr.events) if (e.meta === 0x51 && e.metaData.length >= 3) tempos.push({ tick: e.tick, us: (e.metaData[0] << 16) | (e.metaData[1] << 8) | e.metaData[2] });
  tempos.sort((x, y) => x.tick - y.tick);
  const segs = [];
  let secAt = 0;
  let lastTick = 0;
  let us = 500000;
  for (const tp of tempos) {
    secAt += ((tp.tick - lastTick) * us) / 1e6 / Math.max(1, ppq);
    lastTick = tp.tick;
    us = tp.us;
    segs.push({ tick: tp.tick, sec: secAt, us });
  }
  const toSec = (tick) => {
    if (smpte) return tick / Math.max(1, tpsSmpte);
    let s = { tick: 0, sec: 0, us: 500000 };
    for (const g of segs) { if (g.tick <= tick) s = g; else break; }
    return s.sec + ((tick - s.tick) * s.us) / 1e6 / Math.max(1, ppq);
  };
  for (const tr of tracks) for (const e of tr.events) e.sec = toSec(e.tick);
  return { format, ppq, smpte, tracks, tempos };
}

// --------------------------------------------------------------------------
// Lines → MIDI / 선 → MIDI
// --------------------------------------------------------------------------

const clean = (pts) => (pts || []).filter((q) => Number.isFinite(q.t) && Number.isFinite(q.m)).sort((a, b) => a.t - b.t);

/** Split a line where it has gaps (NaN pitch). / 끊긴 곳(NaN)에서 선 나누기 */
function segmentsOf(pts) {
  const out = [];
  let cur = [];
  for (const q of pts || []) {
    if (!Number.isFinite(q.t) || !Number.isFinite(q.m)) { if (cur.length >= 2) out.push(cur); cur = []; continue; }
    cur.push(q);
  }
  if (cur.length >= 2) out.push(cur);
  return out.map((s) => s.sort((a, b) => a.t - b.t)).filter((s) => s[s.length - 1].t - s[0].t > 1e-3 && s[s.length - 1].t - s[0].t < MAX_LINE_SEC);
}

/** Linear lookup of a line at time t. / 선의 t 시각 음고 */
function lineAt(pts, t, hint = { j: 0 }) {
  let j = hint.j;
  if (j >= pts.length - 1 || pts[j].t > t) j = 0;
  while (j < pts.length - 2 && pts[j + 1].t < t) j++;
  hint.j = j;
  const a = pts[j];
  const b = pts[j + 1] || a;
  const f = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-12, b.t - a.t)));
  return a.m + f * (b.m - a.m);
}

const clamp7 = (x) => Math.max(0, Math.min(127, Math.round(x)));
const bend14 = (semis, range) => Math.max(0, Math.min(16383, Math.round(8192 + (semis / range) * 8192)));
const bendMsg = (ch, v) => [0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f];
const cc = (ch, n, v) => [0xb0 | ch, n & 0x7f, clamp7(v)];
const rpn = (ch, msb, lsb, valMsb, valLsb = 0) => [...cc(ch, 101, msb), ...cc(ch, 100, lsb), ...cc(ch, 6, valMsb), ...cc(ch, 38, valLsb), ...cc(ch, 101, 127), ...cc(ch, 100, 127)];

/**
 * One line → note pieces: [{ t0, t1, key, bends: [{ t, semis }] }] — re-struck when the line leaves
 * ±(range − 0.5) around its base note; 'notes' mode cuts at every change of the nearest semitone.
 * 선 하나 → 노트 조각 (벤드 범위를 벗어나면 새 기준음으로 다시 침).
 */
export function linePieces(pts, { mode = 'mpe', bendRange = 48 } = {}) {
  const out = [];
  for (const seg of segmentsOf(pts)) {
    const t0 = seg[0].t;
    const t1 = seg[seg.length - 1].t;
    const n = Math.max(2, Math.ceil((t1 - t0) * BEND_HZ) + 1);
    const hint = { j: 0 };
    let piece = null;
    for (let i = 0; i < n; i++) {
      const t = t0 + ((t1 - t0) * i) / (n - 1);
      const m = lineAt(seg, t, hint);
      if (mode === 'notes') {
        const k = clamp7(m);
        if (!piece || piece.key !== k) {
          if (piece) { piece.t1 = t; out.push(piece); }
          piece = { t0: t, t1: t, key: k, bends: [] };
        }
        continue;
      }
      if (!piece || Math.abs(m - piece.key) > bendRange - 0.5) {
        if (piece) { piece.t1 = t; out.push(piece); }
        piece = { t0: t, t1: t, key: clamp7(m), bends: [] };
      }
      piece.bends.push({ t, semis: m - piece.key });
    }
    if (piece) { piece.t1 = t1; out.push(piece); }
  }
  return out.filter((q) => q.t1 - q.t0 > 1e-4);
}

/**
 * groups: [{ name, lines: [{ name, pts: [{ t, m }], vel? }] }] — one MIDI track per group.
 * → { bytes, tracks, notes, stolen } . / 그룹마다 MIDI 트랙 하나
 */
export function linesToMidi(groups, { mode = 'mpe', bendRange = null, name = 'Flexatone' } = {}) {
  const md = MIDI_MODES.includes(mode) ? mode : 'mpe';
  const range = Math.max(1, Math.min(96, Math.round(bendRange ?? (md === 'mpe' ? 48 : 2))));
  const channels = md === 'mpe' ? Array.from({ length: 15 }, (_, i) => i + 1) : md === 'multi' ? Array.from({ length: 16 }, (_, i) => i).filter((c) => c !== 9) : [0];
  const tempoUs = Math.round(60e6 / MIDI_EXPORT_BPM);
  const head = { name, events: [
    { tick: 0, data: [0xff, 0x51, 3, (tempoUs >> 16) & 255, (tempoUs >> 8) & 255, tempoUs & 255] },
    { tick: 0, data: [0xff, 0x58, 4, 4, 2, 24, 8] },
  ] };
  const tracks = [head];
  let notes = 0;
  let stolen = 0;
  for (const g of groups) {
    const events = [];
    const tick = (s) => Math.max(0, Math.round(s * TPS));
    // set-up: MPE zone + bend range on every member channel / 설정: MPE 존 + 벤드 범위
    if (md === 'mpe') events.push({ tick: 0, order: -10, data: rpn(0, 0, 6, 15) });
    if (md !== 'notes') for (const ch of channels) events.push({ tick: 0, order: -9, data: rpn(ch, 0, 0, range) });
    const pieces = [];
    for (const ln of g.lines || []) for (const pc of linePieces(clean(ln.pts), { mode: md, bendRange: range })) pieces.push({ ...pc, vel: clamp7(ln.vel ?? 100) || 1 });
    pieces.sort((a, b) => a.t0 - b.t0);
    const freeAt = new Map(channels.map((c) => [c, -Infinity])); // channel → time it is free / 채널이 비는 시각
    const busy = new Map(); // channel → piece sounding / 채널에서 울리는 조각
    for (const pc of pieces) {
      let ch;
      if (md === 'notes') ch = 0;
      else {
        // least recently used free channel; none free → steal the one that started first / 가장 오래 쉰 채널, 없으면 가장 먼저 시작한 노트를 끊음
        const free = channels.filter((c) => freeAt.get(c) <= pc.t0 + 1e-6);
        if (free.length) ch = free.reduce((x, y) => (freeAt.get(y) < freeAt.get(x) ? y : x));
        else {
          ch = channels.reduce((x, y) => ((busy.get(y)?.t0 ?? 0) < (busy.get(x)?.t0 ?? 0) ? y : x));
          const old = busy.get(ch);
          if (old) { old.cut = pc.t0; stolen++; }
        }
      }
      pc.ch = ch;
      busy.set(ch, pc);
      freeAt.set(ch, pc.t1 + 0.002);
    }
    for (const pc of pieces) {
      const end = Math.min(pc.t1, pc.cut ?? Infinity);
      const ch = pc.ch;
      if (md !== 'notes') {
        let last = -1;
        pc.bends.forEach((bd) => {
          if (bd.t > end + 1e-9) return;
          const v = bend14(bd.semis, range);
          if (v === last) return;
          last = v;
          events.push({ tick: tick(bd.t), order: -4, data: bendMsg(ch, v) }); // before a note-off / note-on at the same tick / 같은 틱의 노트오프·온보다 먼저
        });
      }
      events.push({ tick: tick(pc.t0), order: 1, data: [0x90 | ch, pc.key, pc.vel] });
      events.push({ tick: Math.max(tick(pc.t0) + 1, tick(end)), order: -3, data: [0x80 | ch, pc.key, 0] });
      notes++;
    }
    tracks.push({ name: g.name || 'Track', events });
  }
  return { bytes: writeMidiFile(tracks), tracks: tracks.length - 1, notes, stolen, bendRange: range, mode: md };
}

// --------------------------------------------------------------------------
// MIDI → lines / MIDI → 선
// --------------------------------------------------------------------------

/**
 * Notes of a parsed file with their pitch lines. Bend range per channel from RPN 0 (default 2; 48 on MPE
 * member channels once a zone message was seen). → { notes: [{ track, trackName, ch, key, vel, t0, t1, pts }], mpe }
 * 노트와 그 음고 선 (채널별 벤드 범위는 RPN 0, MPE면 기본 48).
 */
export function midiNotes(parsed) {
  const all = [];
  let mpe = false;
  parsed.tracks.forEach((tr, ti) => {
    const range = new Array(16).fill(null);
    const rpnSel = new Array(16).fill(null).map(() => [127, 127]);
    const bend = new Array(16).fill(0);
    const active = new Map(); // ch*128+key → note
    const rangeOf = (ch) => range[ch] ?? (mpe && ch !== 0 && ch !== 15 ? 48 : 2);
    const push = (n, t) => n.pts.push({ t, m: n.key + bend[n.ch] * rangeOf(n.ch) });
    for (const e of tr.events) {
      if (e.status === 0xff || e.status === undefined) continue;
      const ch = e.ch;
      if (e.status === 0xb0) {
        if (e.d1 === 101) rpnSel[ch][0] = e.d2;
        else if (e.d1 === 100) rpnSel[ch][1] = e.d2;
        else if (e.d1 === 6) {
          const [msb, lsb] = rpnSel[ch];
          if (msb === 0 && lsb === 0) range[ch] = Math.max(1, e.d2);
          if (msb === 0 && lsb === 6 && (ch === 0 || ch === 15)) mpe = true;
        }
        continue;
      }
      if (e.status === 0xe0) {
        bend[ch] = ((e.d2 << 7) | e.d1) / 8192 - 1;
        for (const n of active.values()) if (n.ch === ch) push(n, e.sec);
        continue;
      }
      const on = e.status === 0x90 && e.d2 > 0;
      const off = e.status === 0x80 || (e.status === 0x90 && e.d2 === 0);
      const id = ch * 128 + e.d1;
      if (off || on) {
        const n = active.get(id);
        if (n) { n.t1 = e.sec; push(n, e.sec); active.delete(id); all.push(n); }
      }
      if (on) {
        const n = { track: ti, trackName: tr.name || `Track ${ti + 1}`, ch, key: e.d1, vel: e.d2, t0: e.sec, t1: e.sec, pts: [] };
        push(n, e.sec);
        active.set(id, n);
      }
    }
    for (const n of active.values()) { n.t1 = Math.max(n.t1, n.pts[n.pts.length - 1]?.t ?? n.t0); all.push(n); }
  });
  // a bend that arrives at the note-on tick may come after the note-on: the first point takes the last value at t0
  // 노트온과 같은 틱의 벤드: 첫 점은 t0의 마지막 값
  for (const n of all) {
    const at0 = n.pts.filter((q) => q.t <= n.t0 + 1e-9);
    if (at0.length > 1) n.pts = [{ t: n.t0, m: at0[at0.length - 1].m }, ...n.pts.filter((q) => q.t > n.t0 + 1e-9)];
    if (n.pts.length < 2 || n.pts[n.pts.length - 1].t < n.t1) n.pts.push({ t: n.t1, m: n.pts[n.pts.length - 1].m });
  }
  all.sort((a, b) => a.t0 - b.t0 || a.key - b.key);
  return { notes: all.filter((n) => n.t1 - n.t0 > 1e-3), mpe };
}

/**
 * Notes → lines. join = continue a line of the same track when a note starts within `gapSec` of that line's
 * end at (nearly) the pitch where it stopped — legato melodies and the re-strikes of a wide glide, on any channel.
 * 노트 → 선 (join = 같은 트랙에서 끝난 자리·음고에서 바로 이어지는 노트를 한 선으로, 채널 무관)
 */
export function notesToLines(notes, { join = true, gapSec = 0.012, pitchTol = 0.6 } = {}) {
  const lines = [];
  const open = new Map(); // track → lines that may still be continued / 이어질 수 있는 선
  for (const n of notes) {
    const list = open.get(n.track) || [];
    let best = null;
    if (join) {
      const m0 = n.pts[0]?.m ?? n.key;
      for (const ln of list) {
        if (n.t0 < ln.t1 - 1e-6 || n.t0 - ln.t1 > gapSec) continue;
        const d = Math.abs((ln.pts[ln.pts.length - 1]?.m ?? 0) - m0);
        if (d <= pitchTol && (!best || d < best.d)) best = { ln, d };
      }
    }
    if (best) {
      const ln = best.ln;
      ln.pts.push(...n.pts.filter((q) => q.t >= ln.t1 - 1e-9));
      ln.t1 = n.t1;
      ln.notes++;
      continue;
    }
    const ln = { track: n.track, trackName: n.trackName, ch: n.ch, vel: n.vel, t0: n.t0, t1: n.t1, pts: n.pts.slice(), notes: 1 };
    lines.push(ln);
    open.set(n.track, [...list.filter((x) => x.t1 >= n.t0 - gapSec), ln]);
  }
  return lines;
}

registerSelfCheck('MIDI file: MPE / multi-channel / notes round trip of a glide, tempo map, running status', (a) => {
  const glide = { name: 'g', pts: [{ t: 0.5, m: 60 }, { t: 1.5, m: 67.5 }] };
  const flat = { name: 'f', pts: [{ t: 0, m: 48 }, { t: 2, m: 48 }] };
  for (const mode of ['mpe', 'multi']) {
    const out = linesToMidi([{ name: 'A', lines: [glide, flat] }], { mode });
    const back = midiNotes(readMidiFile(out.bytes));
    a.equal(back.mpe, mode === 'mpe', `${mode}: zone message detected`);
    const lines = notesToLines(back.notes);
    const g = lines.find((l) => Math.abs(l.t0 - 0.5) < 0.01);
    a.ok(!!g, `${mode}: glide found`);
    const end = g.pts[g.pts.length - 1];
    a.near(end.m, 67.5, mode === 'mpe' ? 0.01 : 0.01, `${mode}: glide ends at 67.5`);
    a.near(g.t1, 1.5, 0.002, `${mode}: glide length`);
    const mid = g.pts.reduce((x, q) => (Math.abs(q.t - 1) < Math.abs(x.t - 1) ? q : x));
    a.near(mid.m, 63.75, 0.06, `${mode}: halfway pitch`);
    if (mode === 'multi') a.ok(back.notes.length >= 4, 'multi (±2): the 7.5-semitone glide is re-struck');
  }
  const nt = linesToMidi([{ name: 'N', lines: [glide] }], { mode: 'notes' });
  const nn = midiNotes(readMidiFile(nt.bytes)).notes;
  a.equal(nn.map((n) => n.key).join(), '60,61,62,63,64,65,66,67', 'notes mode: one note per nearest semitone (68 only at the last instant)');
  // hand-written type 0 file: 2 beats at 60 BPM, running status note-on velocity 0 as note-off / 손으로 쓴 파일
  const f = Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 18,
    0, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, 0, 0x90, 64, 100, 96, 64, 0, 96, 0xff, 0x2f, 0]);
  const p = midiNotes(readMidiFile(f)).notes;
  a.equal(p.length, 1, 'one note');
  a.near(p[0].t1, 1, 1e-9, '96 ticks at 60 BPM = 1 s');
});
