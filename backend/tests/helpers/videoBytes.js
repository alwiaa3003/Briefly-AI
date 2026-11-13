'use strict';

/** Minimal byte sequences with real container signatures (padded to a few KB). */

function pad(head, size = 4096) {
  const buffer = Buffer.alloc(size, 0x11);
  head.copy(buffer, 0);
  return buffer;
}

const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from(`ftyp${brand}`, 'latin1')]);
const ebml = (docType) =>
  Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from(docType, 'latin1')]);

module.exports = {
  mp4: (size, salt = 0) => {
    const buffer = pad(ftyp('isom'), size);
    buffer.writeUInt32BE(salt, buffer.length - 4); // vary content (and hash) per test
    return buffer;
  },
  mov: (size) => pad(ftyp('qt  '), size),
  webm: (size) => pad(ebml('webm'), size),
  mkv: (size) => pad(ebml('matroska'), size),
  png: () => pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  m4a: () => pad(ftyp('M4A ')),
  html: () => pad(Buffer.from('<!doctype html><script>alert(1)</script>')),
  m3u8: () => pad(Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n')),
};
