/**
 * Flexatone — audio/wav-multichannel.js
 * Layer 3 (audio, shared): 32-bit float WAV with any channel count, written as
 * WAVE_FORMAT_EXTENSIBLE (channel mask 0 = "no speaker positions", IEEE-float sub-format) — the
 * container ambiX files use. audio-engine.js `encodeWav` (16-bit PCM) is left as it is.
 * 계층 3 (audio, 공용): 임의 채널 수의 32비트 부동소수 WAV (WAVE_FORMAT_EXTENSIBLE, 채널 마스크 0,
 * IEEE float 서브포맷) — ambiX 파일의 컨테이너. 기존 16비트 `encodeWav`는 그대로 둠.
 *
 * Pure byte work (no DOM, no AudioContext); takes an AudioBuffer or { channels: Float32Array[], sampleRate }.
 */

// KSDATAFORMAT_SUBTYPE_IEEE_FLOAT {00000003-0000-0010-8000-00AA00389B71}
const SUBTYPE_FLOAT = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
export const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const channelsOf = (buffer) => (Array.isArray(buffer.channels) ? buffer.channels : Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)));

/** Largest absolute sample of a buffer. / 최대 절대 표본값 */
export function bufferPeak(buffer) {
  let peak = 0;
  for (const c of channelsOf(buffer)) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
  return peak;
}

/**
 * Encode as 32-bit float WAVE_FORMAT_EXTENSIBLE. `gain` scales every sample (1 = as is).
 * 32비트 부동소수 WAVE_FORMAT_EXTENSIBLE로 인코딩.
 * @returns {ArrayBuffer}
 */
export function encodeWavFloat(buffer, { gain = 1 } = {}) {
  const chans = channelsOf(buffer);
  const numCh = chans.length;
  const frames = chans.reduce((m, c) => Math.max(m, c.length), 0);
  const blockAlign = numCh * 4;
  const dataBytes = frames * blockAlign;
  const ab = new ArrayBuffer(68 + dataBytes);
  const dv = new DataView(ab);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  dv.setUint32(4, 60 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 40, true); // fmt chunk size (extensible) / 확장 fmt 크기
  dv.setUint16(20, WAVE_FORMAT_EXTENSIBLE, true);
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 32, true); // bits per sample
  dv.setUint16(36, 22, true); // cbSize
  dv.setUint16(38, 32, true); // valid bits
  dv.setUint32(40, 0, true); // channel mask 0: not speaker feeds / 스피커 배치 아님
  SUBTYPE_FLOAT.forEach((b, i) => dv.setUint8(44 + i, b));
  str(60, 'data');
  dv.setUint32(64, dataBytes, true);
  let off = 68;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const raw = chans[c][i];
      dv.setFloat32(off, Number.isFinite(raw) ? raw * gain : 0, true);
      off += 4;
    }
  }
  return ab;
}

/** Read the header of a WAV file back (used by the self-checks). / WAV 헤더 다시 읽기 (자가진단용) */
export function readWavHeader(ab) {
  const dv = new DataView(ab);
  const tag = (off) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let off = 12;
  const out = {};
  while (off + 8 <= ab.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      out.format = dv.getUint16(off + 8, true);
      out.channels = dv.getUint16(off + 10, true);
      out.sampleRate = dv.getUint32(off + 12, true);
      out.blockAlign = dv.getUint16(off + 20, true);
      out.bits = dv.getUint16(off + 22, true);
      if (size >= 40) { out.channelMask = dv.getUint32(off + 28, true); out.subFormat = dv.getUint16(off + 32, true); }
    } else if (id === 'data') {
      out.dataOffset = off + 8;
      out.dataBytes = size;
      out.frames = out.blockAlign ? size / out.blockAlign : 0;
      break;
    }
    off += 8 + size + (size & 1);
  }
  return out;
}
