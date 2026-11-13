'use strict';

/**
 * Document upload validation (PDF, DOCX, TXT): extension + declared MIME type + file signature.
 *
 *   PDF : "%PDF-" within the first 1024 bytes (the PDF spec allows leading bytes)
 *   DOCX: ZIP local-file header "PK\x03\x04". The processing service additionally
 *         verifies the package is a Word document, rejects macro-enabled files and
 *         guards against zip bombs before parsing.
 *   TXT : no magic number, so the head must look like text: no NUL bytes (unless
 *         UTF-16/32 with a BOM), no known binary signatures, few control characters.
 *
 * Legacy .doc, macro-enabled .docm and templates are not accepted.
 */

const path = require('path');

const SIGNATURE_BYTES = 1024;

const EXTENSIONS = Object.freeze({ '.pdf': 'pdf', '.docx': 'docx', '.txt': 'txt', '.text': 'txt', '.md': 'txt' });

const MIME_TYPES = Object.freeze({
  pdf: ['application/pdf', 'application/x-pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  txt: ['text/plain', 'text/markdown', 'text/x-markdown'],
});
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const CANONICAL_MIME = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
});

const BINARY_SIGNATURES = [
  Buffer.from('%PDF-'),
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // zip
  Buffer.from([0x4d, 0x5a]), // MZ (Windows executable)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from('GIF8'),
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), // legacy OLE (.doc/.xls)
  Buffer.from([0x1f, 0x8b]), // gzip
  Buffer.from('Rar!'),
  Buffer.from([0x37, 0x7a, 0xbc, 0xaf]), // 7z
];

const UTF16_32_BOMS = [
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0xfe, 0xff]),
  Buffer.from([0x00, 0x00, 0xfe, 0xff]),
];

function looksLikeText(head) {
  if (head.length === 0) return false;
  if (UTF16_32_BOMS.some((bom) => head.subarray(0, bom.length).equals(bom))) return true;
  if (BINARY_SIGNATURES.some((sig) => head.subarray(0, sig.length).equals(sig))) return false;
  let control = 0;
  for (const byte of head) {
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) control += 1;
  }
  return control <= Math.max(2, head.length * 0.02);
}

/** Detects the format from the first bytes. `expected` is used for TXT, which has no signature. */
function detectDocumentFormat(head, expected) {
  if (!Buffer.isBuffer(head) || head.length === 0) return null;
  const ascii = head.subarray(0, SIGNATURE_BYTES).toString('latin1');
  if (ascii.includes('%PDF-')) return 'pdf';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'docx';
  if (expected === 'txt' && looksLikeText(head.subarray(0, SIGNATURE_BYTES))) return 'txt';
  return null;
}

function formatFromFilename(name) {
  return EXTENSIONS[path.extname(String(name || '')).toLowerCase()] ?? null;
}

function documentMimeAllowed(format, mimeType) {
  const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return GENERIC_MIME_TYPES.has(type) || (MIME_TYPES[format] || []).includes(type);
}

module.exports = {
  SIGNATURE_BYTES,
  EXTENSIONS,
  CANONICAL_MIME,
  detectDocumentFormat,
  formatFromFilename,
  documentMimeAllowed,
  looksLikeText,
};
