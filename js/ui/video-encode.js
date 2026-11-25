/**
 * Flexatone — ui/video-encode.js
 * Layer 4 (ui): frame-exact OFFLINE video rendering — WebCodecs (H.264 + AAC) and a small MP4 writer.
 * Used by the studio video export (ui/studio-video.js) and the Manager video (ui/manager-video.js) instead
 * of real-time MediaRecorder capture, which loses the picture when the tab is in the background (no frames
 * are painted) and, on a plain 'video/mp4' fallback, writes VP9 / Opus that QuickTime cannot show.
 *   - Every frame is drawn for its own time t = i / fps, then encoded; nothing depends on the wall clock, so
 *     the render may be slower or faster than real time and the tab may be hidden.
 *   - The sound is an AudioBuffer rendered offline beforehand (the same mix as the WAV export).
 *   - MP4 (ISO BMFF, moov at the end): avc1 (avcC from the encoder) + mp4a (AAC-LC). If AAC cannot be
 *     encoded, the sound is written as 16-bit PCM ('sowt') in a .mov, which QuickTime plays.
 *   - Saving: pickSaveTarget() is called on the click (a save window where the browser has one), the file
 *     is written when the render is done; otherwise a download.
 * 계층 4 (ui): 프레임 단위 오프라인 동영상 렌더 — WebCodecs(H.264 + AAC) + 작은 MP4 작성기. 실시간 녹화
 * (백그라운드 탭에서 화면이 빠지고, 'video/mp4' 대체 시 QuickTime이 못 여는 VP9/Opus)를 대신함.
 */

import { triggerDownload } from '../audio/audio-engine.js';
import { createOfflineOutput } from '../audio/output-bus.js';

/** Yield to the event loop without timers (timers are throttled in a background tab). / 타이머 없이 양보 */
const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
const waiting = [];
if (channel) channel.port1.onmessage = () => { const fn = waiting.shift(); if (fn) fn(); };
export function yieldNow() {
  if (!channel) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { waiting.push(r); channel.port2.postMessage(0); });
}

/** A raw buffer through the output stage (output fader + limiter), offline. / 출력 단계 적용 */
export async function applyOutputStage(buffer) {
  if (!buffer) return null;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = new Offline(Math.max(2, buffer.numberOfChannels), buffer.length, buffer.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(createOfflineOutput(ctx));
  src.start(0);
  return ctx.startRendering();
}

// ==========================================================================
// Support / 지원 확인
// ==========================================================================

function avcLevel(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const rate = mbs * fps;
  if (mbs <= 8192 && rate <= 245760) return '28'; // 4.0: 1080p30
  if (mbs <= 8704 && rate <= 522240) return '2a'; // 4.2: 1080p60
  if (mbs <= 22080 && rate <= 589824) return '32'; // 5.1… 5.2 below / 4K30
  if (mbs <= 36864 && rate <= 983040) return '33';
  return '34'; // 5.2
}

/** Video encoder config that this browser accepts for W × H at fps, or null. / 지원되는 비디오 설정 */
export async function findVideoConfig(W, H, fps, bitrate) {
  if (typeof globalThis.VideoEncoder !== 'function') return null;
  const lv = avcLevel(W, H, fps);
  for (const profile of ['6400', '4d00', '4200']) {
    const config = { codec: `avc1.${profile}${lv}`, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return config; } catch { /* next */ }
  }
  return null;
}

/** AAC config, or null (then PCM in a .mov). / AAC 설정 (없으면 PCM .mov) */
export async function findAudioConfig(sampleRate, channels) {
  if (typeof globalThis.AudioEncoder !== 'function') return null;
  const config = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 256000 };
  try { if ((await AudioEncoder.isConfigSupported(config)).supported) return config; } catch { /* none */ }
  return null;
}

export const offlineVideoAvailable = () => typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function';

// ==========================================================================
// Saving / 저장
// ==========================================================================

/**
 * Ask where to save (must run inside the click). Returns a handle, null (no save window in this browser:
 * download later) or 'cancel'. / 저장 위치 묻기 (클릭 안에서 호출)
 */
export async function pickSaveTarget(filename, { mov = false } = {}) {
  if (typeof globalThis.showSaveFilePicker !== 'function') return null;
  try {
    return await globalThis.showSaveFilePicker({
      suggestedName: filename,
      startIn: 'downloads',
      id: 'flexatone-video',
      types: [mov ? { description: 'QuickTime movie', accept: { 'video/quicktime': ['.mov'] } } : { description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancel';
    return null; // not allowed here: fall back to a download / 다운로드로 대체
  }
}

/** Write the blob to the picked file, or download it. Returns where it went. / 저장 */
export async function saveBlob(blob, filename, handle) {
  if (handle && handle !== 'cancel') {
    try {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return handle.name || filename;
    } catch (err) { console.error('[Flexatone] save:', err); }
  }
  triggerDownload(blob, filename);
  return filename;
}

// ==========================================================================
// MP4 writer / MP4 작성기
// ==========================================================================

const enc = new TextEncoder();

function box(type, ...parts) {
  const body = parts.flat().filter(Boolean);
  const len = 8 + body.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(enc.encode(type), 4);
  let o = 8;
  for (const p of body) { out.set(p, o); o += p.length; }
  return out;
}
const full = (type, version, flags, ...parts) => box(type, u8(version), u24(flags), ...parts);
function u8(v) { return new Uint8Array([v & 255]); }
function u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return a; }
function u24(v) { return new Uint8Array([(v >> 16) & 255, (v >> 8) & 255, v & 255]); }
function u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0); return a; }
function u64(v) { const a = new Uint8Array(8); const dv = new DataView(a.buffer); dv.setUint32(0, Math.floor(v / 2 ** 32)); dv.setUint32(4, v >>> 0); return a; }
const zeros = (n) => new Uint8Array(n);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

function runs(values) {
  const out = [];
  for (const v of values) { const last = out[out.length - 1]; if (last && last[1] === v) last[0]++; else out.push([1, v]); }
  return out;
}

function stbl(tr) {
  const sizes = tr.samples.map((s) => s.size);
  const stts = runs(tr.samples.map((s) => s.dur));
  const stscRows = [];
  tr.chunks.forEach((c, i) => { const last = stscRows[stscRows.length - 1]; if (!last || last[1] !== c.n) stscRows.push([i + 1, c.n]); });
  const constSize = tr.constSize || 0;
  const parts = [
    full('stsd', 0, 0, u32(1), tr.entry),
    full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => [u32(n), u32(d)])),
    full('stsc', 0, 0, u32(stscRows.length), ...stscRows.map(([first, n]) => [u32(first), u32(n), u32(1)])),
    constSize ? full('stsz', 0, 0, u32(constSize), u32(tr.sampleCount)) : full('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32)),
    full('co64', 0, 0, u32(tr.chunks.length), ...tr.chunks.map((c) => u64(c.offset))),
  ];
  if (tr.kind === 'video') {
    const keys = [];
    tr.samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    parts.push(full('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
  }
  return box('stbl', ...parts);
}

function trak(tr, id, movieDur) {
  const isV = tr.kind === 'video';
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDur), zeros(8), u16(0), u16(0), u16(isV ? 0 : 0x0100), u16(0), ...MATRIX, u32(isV ? tr.w * 65536 : 0), u32(isV ? tr.h * 65536 : 0));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(tr.timescale), u32(tr.duration), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), enc.encode(isV ? 'vide' : 'soun'), zeros(12), enc.encode(isV ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mh = isV ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mh, dinf, stbl(tr))));
}

function avc1Entry(w, h, avcC) {
  return box('avc1', zeros(6), u16(1), zeros(16), u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), box('avcC', avcC));
}

function descLen(n) { return n < 128 ? [n] : [0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127]; }
function desc(tag, ...parts) { const body = parts.flat(); const len = body.reduce((a, p) => a + p.length, 0); return [new Uint8Array([tag, ...descLen(len)]), ...body]; }

function mp4aEntry(sr, ch, asc, bitrate) {
  const dcd = desc(4, u8(0x40), u8(0x15), u24(0), u32(bitrate), u32(bitrate), ...desc(5, asc));
  const esd = desc(3, u16(0), u8(0), ...dcd, ...desc(6, u8(2)));
  return box('mp4a', zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(sr * 65536), full('esds', 0, 0, ...esd));
}

function sowtEntry(sr, ch) {
  return box('sowt', zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(Math.min(65535, sr) * 65536));
}

/** AudioSpecificConfig for AAC-LC when the encoder gives none. / AAC-LC ASC */
function ascFor(sr, ch) {
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sr);
  const i = idx < 0 ? 3 : idx;
  return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (ch << 3)]);
}

// ==========================================================================
// Render / 렌더
// ==========================================================================

/**
 * Render a video offline.
 * @param {object} o
 * @param {number} o.W @param {number} o.H @param {number} o.fps @param {number} o.duration seconds
 * @param {HTMLCanvasElement} o.canvas  surface the frames are drawn on (W × H)
 * @param {(i:number, t:number) => (void|Promise<void>)} o.draw  draw frame i (time t) on the canvas
 * @param {AudioBuffer|null} o.audio
 * @param {(frac:number, phase:string) => void} [o.onProgress]
 * @param {() => boolean} [o.cancelled]
 * @returns {Promise<{ blob: Blob, ext: 'mp4'|'mov', frames: number, audio: 'aac'|'pcm'|'none' } | null>} null = cancelled
 */
export async function renderVideoOffline({ W, H, fps, duration, canvas, draw, audio = null, onProgress = () => {}, cancelled = () => false }) {
  const bitrate = Math.round(Math.min(60e6, Math.max(3e6, W * H * fps * 0.14)));
  const vcfg = await findVideoConfig(W, H, fps, bitrate);
  if (!vcfg) throw new Error(`H.264 ${W}×${H} @ ${fps} fps is not supported by this browser`);
  const sr = audio?.sampleRate || 48000;
  const ch = audio ? Math.min(2, Math.max(1, audio.numberOfChannels)) : 2;
  const acfg = audio ? await findAudioConfig(sr, ch) : null;
  const pcm = !!audio && !acfg;

  const chunks = []; // mdat payload parts / mdat 내용
  let offset = 0; // within mdat payload / mdat 안의 위치
  const put = (data) => { const o = offset; chunks.push(data); offset += data.length; return o; };
  const VTS = 90000;
  const frameDur = Math.round(VTS / fps);
  const video = { kind: 'video', w: W, h: H, timescale: VTS, samples: [], chunks: [], duration: 0, entry: null };
  const sound = audio ? { kind: 'audio', timescale: sr, samples: [], chunks: [], duration: 0, entry: null } : null;
  let error = null;

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !video.entry) video.entry = avc1Entry(W, H, new Uint8Array(meta.decoderConfig.description));
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const o = put(data);
      video.samples.push({ size: data.length, dur: frameDur, key: chunk.type === 'key' });
      video.chunks.push({ offset: o, n: 1 });
    },
    error: (e) => { error = e; },
  });
  venc.configure(vcfg);

  // ---- audio first (fast; all of it is known) / 오디오 먼저
  if (audio) {
    const total = Math.min(audio.length, Math.round(duration * sr));
    const chans = Array.from({ length: ch }, (_, c) => audio.getChannelData(Math.min(c, audio.numberOfChannels - 1)));
    if (pcm) {
      const block = sr; // one chunk per second / 초당 청크 하나
      for (let s = 0; s < total; s += block) {
        const n = Math.min(block, total - s);
        const data = new Uint8Array(n * ch * 2);
        const dv = new DataView(data.buffer);
        for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][s + i] || 0)); dv.setInt16((i * ch + c) * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true); }
        const o = put(data);
        sound.chunks.push({ offset: o, n });
      }
      sound.sampleCount = total;
      sound.constSize = ch * 2;
      sound.samples = [{ size: ch * 2, dur: 1 }];
      sound.sttsOverride = total;
      sound.entry = sowtEntry(sr, ch);
      sound.duration = total;
    } else {
      let asc = null;
      const aenc = new AudioEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description && !asc) asc = new Uint8Array(meta.decoderConfig.description);
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const o = put(data);
          sound.samples.push({ size: data.length, dur: 1024 });
          sound.chunks.push({ offset: o, n: 1 });
        },
        error: (e) => { error = e; },
      });
      aenc.configure(acfg);
      const step = 4096;
      for (let s = 0; s < total; s += step) {
        const n = Math.min(step, total - s);
        const planar = new Float32Array(n * ch);
        for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(s, s + n), c * n);
        const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((s / sr) * 1e6), data: planar });
        aenc.encode(ad);
        ad.close();
        if (aenc.encodeQueueSize > 32) await yieldNow();
      }
      await aenc.flush();
      aenc.close();
      sound.entry = mp4aEntry(sr, ch, asc || ascFor(sr, ch), acfg.bitrate);
      sound.duration = sound.samples.length * 1024;
    }
    if (error) throw error;
  }

  // ---- video frames / 비디오 프레임
  const frames = Math.max(1, Math.round(duration * fps));
  const keyEvery = Math.max(1, Math.round(fps * 2));
  for (let i = 0; i < frames; i++) {
    if (cancelled()) { try { venc.close(); } catch { /* closed */ } return null; }
    if (error) throw error;
    await draw(i, i / fps);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    while (venc.encodeQueueSize > 6) await yieldNow();
    if (i % 4 === 0) { onProgress(i / frames, 'video'); await yieldNow(); }
  }
  await venc.flush();
  venc.close();
  if (error) throw error;
  if (!video.entry) throw new Error('the video encoder gave no H.264 configuration');
  video.duration = video.samples.length * frameDur;
  onProgress(1, 'mux');

  // ---- file / 파일
  const mov = pcm;
  const movieTs = 1000;
  const movieDur = Math.round(Math.max(video.duration / VTS, sound ? sound.duration / sound.timescale : 0) * movieTs);
  const ftyp = mov
    ? box('ftyp', enc.encode('qt  '), u32(0x200), enc.encode('qt  '))
    : box('ftyp', enc.encode('isom'), u32(0x200), enc.encode('isom'), enc.encode('iso2'), enc.encode('avc1'), enc.encode('mp41'));
  const mdatHead = new Uint8Array(16);
  const mdv = new DataView(mdatHead.buffer);
  mdv.setUint32(0, 1);
  mdatHead.set(enc.encode('mdat'), 4);
  const mdatLen = 16 + offset;
  mdv.setUint32(8, Math.floor(mdatLen / 2 ** 32));
  mdv.setUint32(12, mdatLen >>> 0);
  const base = ftyp.length + 16; // payload starts here / 내용 시작 위치
  for (const tr of [video, sound]) if (tr) for (const c of tr.chunks) c.offset += base;
  const traks = [trak(video, 1, movieDur)];
  if (sound) traks.push(sound.sttsOverride ? pcmTrak(sound, movieDur) : trak(sound, 2, movieDur)); // PCM: constant 1-frame samples / PCM
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(movieDur), u32(0x00010000), u16(0x0100), zeros(10), ...MATRIX, zeros(24), u32(sound ? 3 : 2));
  const moov = box('moov', mvhd, ...traks);
  const blob = new Blob([ftyp, mdatHead, ...chunks, moov], { type: mov ? 'video/quicktime' : 'video/mp4' });
  return { blob, ext: mov ? 'mov' : 'mp4', frames, audio: !audio ? 'none' : pcm ? 'pcm' : 'aac' };
}

/** PCM ('sowt') track: constant 1-frame samples, chunks of up to one second. / PCM 트랙 */
function pcmTrak(sound, movieDur) {
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(movieDur), zeros(8), u16(0), u16(0), u16(0x0100), u16(0), ...MATRIX, u32(0), u32(0));
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(sound.timescale), u32(sound.duration), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), enc.encode('soun'), zeros(12), enc.encode('SoundHandler\0'));
  const stscRows = [];
  sound.chunks.forEach((c, i) => { const last = stscRows[stscRows.length - 1]; if (!last || last[1] !== c.n) stscRows.push([i + 1, c.n]); });
  const st = box('stbl',
    full('stsd', 0, 0, u32(1), sound.entry),
    full('stts', 0, 0, u32(1), u32(sound.sampleCount), u32(1)),
    full('stsc', 0, 0, u32(stscRows.length), ...stscRows.map(([first, n]) => [u32(first), u32(n), u32(1)])),
    full('stsz', 0, 0, u32(sound.constSize), u32(sound.sampleCount)),
    full('co64', 0, 0, u32(sound.chunks.length), ...sound.chunks.map((c) => u64(c.offset))));
  const minf = box('minf', full('smhd', 0, 0, u16(0), u16(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))), st);
  return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
}
