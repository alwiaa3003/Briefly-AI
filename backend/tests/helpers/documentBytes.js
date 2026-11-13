'use strict';

/** Byte sequences with real (or deliberately wrong) document signatures. */

function pad(head, size = 4096, fill = 0x20) {
  const buffer = Buffer.alloc(size, fill);
  head.copy(buffer, 0);
  return buffer;
}

module.exports = {
  pdf: (salt = 0, size = 4096) => {
    const buffer = pad(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'), size);
    buffer.write(`%salt-${salt}`, size - 20, 'latin1');
    return buffer;
  },
  // PDF with leading junk bytes before the header (allowed by the spec).
  pdfWithPreamble: () => pad(Buffer.concat([Buffer.from('JUNK-PREAMBLE\n'), Buffer.from('%PDF-1.4\n')])),
  docx: (salt = 0) => {
    const buffer = pad(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), 4096, 0x00);
    buffer.writeUInt32BE(salt, 100);
    return buffer;
  },
  txt: (text = 'Meeting notes\n\nWe agreed to ship the report on Friday.\n') => Buffer.from(text, 'utf8'),
  utf16: () => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Notes in UTF-16 with é and ü.\n', 'utf16le')]),
  png: () => pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  exe: () => pad(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])),
  legacyDoc: () => pad(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  binaryText: () => Buffer.from([0x48, 0x69, 0x00, 0x00, 0x01, 0x02, 0x03, 0x00, 0x48]),
};
