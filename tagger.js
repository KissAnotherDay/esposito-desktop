// tagger.js — Embed metadata into MP3 and FLAC files entirely in the browser.
// No external libraries required.
//
// USAGE (in app.js):
//   import { embedMetadata } from './tagger.js';
//   const taggedBlob = await embedMetadata(rawBlob, track);
//
// The `track` object should have the same shape used throughout app.js:
//   { title, artist: { name, id }, album: { title, id, image }, 
//     trackNumber, volumeNumber, duration, audioQuality,
//     maximum_bit_depth, maximum_sampling_rate }

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main entry point. Auto-detects MP3 vs FLAC from magic bytes.
 * @param {Blob}   audioBlob  - Raw audio blob from fetch()
 * @param {Object} track      - Track metadata object (app.js shape)
 * @param {string} [coverImgUrl] - Optional override cover URL (https://…)
 * @returns {Promise<Blob>} New blob with embedded tags
 */
export async function embedMetadata(audioBlob, track, coverImgUrl = null) {
  // Read first 4 bytes to detect format
  const header = new Uint8Array(await audioBlob.slice(0, 4).arrayBuffer());
  const isFLAC = header[0] === 0x66 && header[1] === 0x4C &&
                 header[2] === 0x61 && header[3] === 0x43; // "fLaC"

  // Resolve cover art
  let coverBuffer = null;
  const url = coverImgUrl || _resolveCoverUrl(track);
  if (url) {
    try {
      const r = await fetch(url);
      if (r.ok) coverBuffer = await r.arrayBuffer();
    } catch { /* cover optional */ }
  }

  if (isFLAC) {
    return _tagFlac(audioBlob, track, coverBuffer);
  } else {
    return _tagMp3(audioBlob, track, coverBuffer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _resolveCoverUrl(track) {
  const img = track.album?.image;
  if (!img) return null;
  // app.js stores covers as objects with large/small keys or as direct strings
  if (typeof img === 'string') return img;
  return img.large || img.small || img.thumbnail || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MP3 — ID3v2.3
// ─────────────────────────────────────────────────────────────────────────────

async function _tagMp3(blob, track, coverBuffer) {
  const raw = await blob.arrayBuffer();

  // Strip any pre-existing ID3v2 header to avoid duplicates
  const stripped = _stripId3v2(raw);

  const frames = [];

  const add = (id, str) => {
    if (str) frames.push(_id3TextFrame(id, str));
  };

  add('TIT2', track.title);
  add('TPE1', track.artist?.name || track.performer?.name);
  add('TALB', track.album?.title || track.album_title);
  add('TPE2', track.artist?.name || track.performer?.name); // Album artist
  if (track.trackNumber)  add('TRCK', track.volumeNumber
    ? `${track.trackNumber}` : `${track.trackNumber}`);
  if (track.volumeNumber) add('TPOS', `${track.volumeNumber}`);
  if (track.year || track.album?.release_date_original) {
    add('TYER', String(
      track.year || track.album.release_date_original.slice(0, 4)
    ));
  }

  /* Quality comment
  const qual = _qualityComment(track);
  if (qual) frames.push(_id3TextFrame('TCON', 'Classical')); // genre placeholder
  frames.push(_id3CommentFrame('eng', 'Quality', qual));*/

  // Cover art (APIC frame)
  if (coverBuffer) {
    frames.push(_id3ApicFrame(coverBuffer));
  }

  const id3 = _buildId3v2(frames);
  const out = new Uint8Array(id3.byteLength + stripped.byteLength);
  out.set(new Uint8Array(id3), 0);
  out.set(new Uint8Array(stripped), id3.byteLength);
  return new Blob([out], { type: 'audio/mpeg' });
}

/** Remove existing ID3v2 tags at the start of the buffer */
function _stripId3v2(buf) {
  const v = new DataView(buf);
  // ID3v2 magic: 0x49 0x44 0x33 ("ID3")
  if (v.getUint8(0) !== 0x49 || v.getUint8(1) !== 0x44 || v.getUint8(2) !== 0x33) {
    return buf; // no ID3v2
  }
  // Size is syncsafe integer in bytes 6-9
  const size = _syncsafeDecode(v.getUint32(6));
  return buf.slice(10 + size); // skip header (10 bytes) + tag data
}

function _syncsafeDecode(n) {
  return ((n & 0x7F000000) >> 3) | ((n & 0x007F0000) >> 2) |
         ((n & 0x00007F00) >> 1) |  (n & 0x0000007F);
}

function _syncsafeEncode(n) {
  return ((n & 0x0FE00000) << 3) | ((n & 0x001FC000) << 2) |
         ((n & 0x00003F80) << 1) |  (n & 0x0000007F);
}

/** Build the full ID3v2.3 tag from an array of frame ArrayBuffers */
function _buildId3v2(frames) {
  const totalFrameSize = frames.reduce((s, f) => s + f.byteLength, 0);
  const header = new DataView(new ArrayBuffer(10));
  // "ID3" + version 2.3.0 + no flags
  header.setUint8(0, 0x49); header.setUint8(1, 0x44); header.setUint8(2, 0x33);
  header.setUint8(3, 0x03); header.setUint8(4, 0x00); header.setUint8(5, 0x00);
  // Size as syncsafe (does NOT include 10-byte header itself)
  const ss = _syncsafeEncode(totalFrameSize);
  header.setUint32(6, ss);

  const out = new Uint8Array(10 + totalFrameSize);
  out.set(new Uint8Array(header.buffer), 0);
  let offset = 10;
  for (const f of frames) {
    out.set(new Uint8Array(f), offset);
    offset += f.byteLength;
  }
  return out.buffer;
}

/** ID3v2.3 text frame (encoding 0x03 = UTF-8) */
function _id3TextFrame(id, text) {
  const enc = new TextEncoder();
  const body = enc.encode(text);                  // UTF-8
  const buf = new ArrayBuffer(10 + 1 + body.byteLength);
  const dv  = new DataView(buf);
  _writeAscii(dv, 0, id);                         // 4-char frame ID
  dv.setUint32(4, 1 + body.byteLength);           // size (big-endian)
  dv.setUint16(8, 0x0000);                        // flags
  dv.setUint8(10, 0x03);                          // encoding = UTF-8
  new Uint8Array(buf).set(body, 11);
  return buf;
}

/** ID3v2.3 COMM (comment) frame */
function _id3CommentFrame(lang, description, text) {
  const enc = new TextEncoder();
  const desc = enc.encode(description + '\0');
  const val  = enc.encode(text);
  const bodyLen = 1 + 3 + desc.byteLength + val.byteLength;
  const buf  = new ArrayBuffer(10 + bodyLen);
  const dv   = new DataView(buf);
  _writeAscii(dv, 0, 'COMM');
  dv.setUint32(4, bodyLen);
  dv.setUint16(8, 0);
  const arr = new Uint8Array(buf);
  arr[10] = 0x03;                                 // UTF-8
  _writeAscii(dv, 11, lang.padEnd(3,' ').slice(0,3)); // language
  arr.set(desc, 14);
  arr.set(val, 14 + desc.byteLength);
  return buf;
}

/** ID3v2.3 APIC (cover art) frame — MIME: image/jpeg */
function _id3ApicFrame(imgBuffer) {
  const enc  = new TextEncoder();
  const mime = enc.encode('image/jpeg\0');
  const desc = enc.encode('\0');                  // empty description
  // 1 (encoding) + mime + 1 (picType=3) + desc + imgData
  const bodyLen = 1 + mime.byteLength + 1 + desc.byteLength + imgBuffer.byteLength;
  const buf  = new ArrayBuffer(10 + bodyLen);
  const dv   = new DataView(buf);
  _writeAscii(dv, 0, 'APIC');
  dv.setUint32(4, bodyLen);
  dv.setUint16(8, 0);
  const arr  = new Uint8Array(buf);
  arr[10] = 0x03;                                 // encoding UTF-8
  arr.set(mime, 11);
  arr[11 + mime.byteLength] = 0x03;              // picture type = front cover
  arr.set(desc, 11 + mime.byteLength + 1);
  arr.set(new Uint8Array(imgBuffer), 11 + mime.byteLength + 1 + desc.byteLength);
  return buf;
}

function _writeAscii(dv, offset, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAC — Vorbis Comments + PICTURE block
// ─────────────────────────────────────────────────────────────────────────────

async function _tagFlac(blob, track, coverBuffer) {
  const raw    = new Uint8Array(await blob.arrayBuffer());
  const result = _parseFlacBlocks(raw);
  if (!result) return blob; // couldn't parse — return unchanged

  const { streamInfoBlock, otherBlocks } = result;

  // Build VORBIS_COMMENT block (type 4)
  const comments = [];
  const push = (k, v) => { if (v !== undefined && v !== null && v !== '') comments.push(`${k}=${v}`); };

  push('TITLE',        track.title);
  push('ARTIST',       track.artist?.name || track.performer?.name);
  push('ALBUMARTIST',  track.artist?.name || track.performer?.name);
  push('ALBUM',        track.album?.title || track.album_title);
  if (track.trackNumber) push('TRACKNUMBER', track.trackNumber);
  if (track.volumeNumber) push('DISCNUMBER', track.volumeNumber);
  if (track.album?.release_date_original)
    push('DATE', track.album.release_date_original.slice(0, 4));
  //push('COMMENT', _qualityComment(track));

  const vcBlock = _buildVorbisComment(comments);

  // Build PICTURE block (type 6)
  let picBlock = null;
  if (coverBuffer) {
    picBlock = _buildFlacPictureBlock(coverBuffer);
  }

  // Re-assemble: fLaC + STREAMINFO + VORBIS_COMMENT + (PICTURE) + other non-VC/PIC blocks + audio
  const blocks = [streamInfoBlock];
  blocks.push({ type: 4, data: vcBlock });
  if (picBlock) blocks.push({ type: 6, data: picBlock });

  // Keep other blocks except old VC (4) and PICTURE (6) — avoid duplicates
  otherBlocks.forEach(b => {
    if (b.type !== 4 && b.type !== 6) blocks.push(b);
  });

  return _reassembleFlac(blocks, raw);
}

/**
 * Parse FLAC stream into STREAMINFO + other metadata blocks + find audio start.
 */
function _parseFlacBlocks(raw) {
  // Verify magic "fLaC"
  if (raw[0] !== 0x66 || raw[1] !== 0x4C || raw[2] !== 0x61 || raw[3] !== 0x43) return null;

  let offset = 4;
  let streamInfoBlock = null;
  const otherBlocks = [];
  let audioStart = -1;

  while (offset < raw.length) {
    const flagAndType = raw[offset];
    const isLast   = (flagAndType & 0x80) !== 0;
    const blockType = flagAndType & 0x7F;
    const length   = (raw[offset+1] << 16) | (raw[offset+2] << 8) | raw[offset+3];
    const data     = raw.slice(offset + 4, offset + 4 + length);

    if (blockType === 0) {
      streamInfoBlock = { type: 0, data };
    } else {
      otherBlocks.push({ type: blockType, data });
    }

    offset += 4 + length;
    if (isLast) { audioStart = offset; break; }
  }

  if (!streamInfoBlock || audioStart < 0) return null;
  return { streamInfoBlock, otherBlocks, audioStart };
}

/** Build a raw Vorbis comment payload (without the 4-byte block header) */
function _buildVorbisComment(comments) {
  const enc    = new TextEncoder();
  const vendor = enc.encode('');
  const parts  = comments.map(c => enc.encode(c));

  let size = 4 + vendor.byteLength + 4 + parts.reduce((s, p) => s + 4 + p.byteLength, 0);
  const buf = new ArrayBuffer(size);
  const dv  = new DataView(buf);
  const arr = new Uint8Array(buf);
  let off   = 0;

  dv.setUint32(off, vendor.byteLength, true); off += 4;
  arr.set(vendor, off); off += vendor.byteLength;
  dv.setUint32(off, parts.length, true); off += 4;
  for (const p of parts) {
    dv.setUint32(off, p.byteLength, true); off += 4;
    arr.set(p, off); off += p.byteLength;
  }
  return arr;
}

/** Build a raw FLAC PICTURE block payload */
function _buildFlacPictureBlock(imgBuffer) {
  const mime = new TextEncoder().encode('image/jpeg');
  const desc = new Uint8Array(0);
  const img  = new Uint8Array(imgBuffer);
  const size = 4 + 4 + mime.byteLength + 4 + desc.byteLength + 4*4 + 4 + img.byteLength;
  const buf  = new ArrayBuffer(size);
  const dv   = new DataView(buf);
  const arr  = new Uint8Array(buf);
  let off    = 0;

  dv.setUint32(off, 3);          off += 4; // picture type: front cover
  dv.setUint32(off, mime.byteLength); off += 4;
  arr.set(mime, off);             off += mime.byteLength;
  dv.setUint32(off, desc.byteLength); off += 4;
  arr.set(desc, off);             off += desc.byteLength;
  dv.setUint32(off, 0);          off += 4; // width  (0 = unknown)
  dv.setUint32(off, 0);          off += 4; // height
  dv.setUint32(off, 0);          off += 4; // color depth
  dv.setUint32(off, 0);          off += 4; // indexed colors
  dv.setUint32(off, img.byteLength); off += 4;
  arr.set(img, off);
  return arr;
}

/** Re-assemble a complete FLAC file from parsed blocks + original audio frames */
function _reassembleFlac(blocks, rawOriginal) {
  // Calculate total size needed for metadata section
  const headerParts = [new Uint8Array([0x66, 0x4C, 0x61, 0x43])]; // "fLaC"

  for (let i = 0; i < blocks.length; i++) {
    const b       = blocks[i];
    const isLast  = (i === blocks.length - 1) ? 0x80 : 0x00;
    const typeFlag = (isLast | b.type);
    const len     = b.data.byteLength;
    const blockHeader = new Uint8Array([
      typeFlag,
      (len >> 16) & 0xFF,
      (len >>  8) & 0xFF,
       len        & 0xFF,
    ]);
    headerParts.push(blockHeader);
    headerParts.push(b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data));
  }

  // Find audio start in original (re-parse)
  const audioStart = _findFlacAudioStart(rawOriginal);
  const audio      = rawOriginal.slice(audioStart);

  headerParts.push(audio);

  const totalLen = headerParts.reduce((s, p) => s + p.byteLength, 0);
  const out      = new Uint8Array(totalLen);
  let off        = 0;
  for (const p of headerParts) { out.set(p, off); off += p.byteLength; }

  return new Blob([out], { type: 'audio/flac' });
}

function _findFlacAudioStart(raw) {
  let offset = 4;
  while (offset < raw.length) {
    const flagAndType = raw[offset];
    const isLast  = (flagAndType & 0x80) !== 0;
    const length  = (raw[offset+1] << 16) | (raw[offset+2] << 8) | raw[offset+3];
    offset += 4 + length;
    if (isLast) return offset;
  }
  return offset;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UTILS
// ─────────────────────────────────────────────────────────────────────────────

function _qualityComment(track) {
  if (track.audioQuality === 'MP3') return 'MP3 320kbps';
  const depth = parseInt(track.maximum_bit_depth || track.bit_depth || 16, 10);
  const sr    = parseFloat(track.maximum_sampling_rate || track.sampling_rate || 44.1);
  if (depth >= 24 && sr > 48) return `Hi-Res FLAC ${depth}bit/${sr}kHz`;
  if (depth >= 24)             return `FLAC 24bit/${sr}kHz`;
  return `FLAC CD Quality ${depth}bit/${sr}kHz`;
}
