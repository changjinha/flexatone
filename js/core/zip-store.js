/**
 * Flexatone — core/zip-store.js
 * Layer 1 (core, pure): a minimal ZIP writer (method 0 = stored, no compression — WAV barely compresses).
 * Used by the track export (ui/track-export.js) to download several files as one folder.
 * UTF-8 names (flag bit 11), so Korean track names stay readable. 32-bit sizes: up to 4 GB in total.
 * 계층 1 (core, 순수): 최소한의 ZIP 작성기 (저장 방식, 압축 없음). 트랙 따로 내보내기에서 여러 파일을
 * 폴더 하나로 내려받을 때 사용. UTF-8 이름. 전체 4 GB까지.
 */

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

/** CRC-32 (ZIP / PNG polynomial). / CRC-32 */
export function crc32(bytes) {
  const tb = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = tb[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive. entries: [{ name: 'folder/file.wav', data: ArrayBuffer | Uint8Array }].
 * Folder entries are added for every directory in the names. / ZIP 만들기 (폴더 항목 자동 추가)
 * @returns {Blob} application/zip
 */
export function buildZip(entries, { date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: dd } = dosTime(date);
  const files = [];
  const dirs = new Set();
  for (const e of entries) {
    const parts = String(e.name).split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  for (const d of [...dirs].sort()) files.push({ name: d, data: new Uint8Array(0) });
  for (const e of entries) files.push({ name: String(e.name), data: e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data) });
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // version needed / 필요 버전
    lh.setUint16(6, 0x0800, true); // UTF-8 names / UTF-8 이름
    lh.setUint16(8, 0, true); // stored / 저장
    lh.setUint16(10, time, true);
    lh.setUint16(12, dd, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(lh.buffer, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, dd, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, f.name.endsWith('/') ? 0x10 : 0, true); // directory attribute / 폴더 속성
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
    if (offset > 0xffffffff) throw new RangeError('buildZip: more than 4 GB');
  }
  const cdSize = central.reduce((a, b) => a + (b.byteLength ?? b.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'application/zip' });
}

/** Safe file / folder name (letters of any script kept). / 안전한 파일·폴더 이름 */
export function safeName(s, fallback = 'track') {
  const v = String(s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (v || fallback).slice(0, 80);
}
