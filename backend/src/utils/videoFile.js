'use strict';

/**
 * Video upload validation: extension + declared MIME type + file signature.
 *
 * All three must agree. The signature (magic bytes) is read from the actual
 * stream before anything is stored, so a renamed PNG, script or archive is
 * rejected regardless of its name or Content-Type.
 *
 *   MP4/MOV: ISO base media file; bytes 4-8 are a box type ("ftyp", or for
 *            older QuickTime files "moov"/"mdat"/"wide"/"free"). The ftyp major
 *            brand separates QuickTime ("qt  ") from MP4 brands.
 *   WebM/MKV: EBML header 1A 45 DF A3 with DocType "webm" or "matroska".
 */

const path = require('path');

const SIGNATURE_BYTES = 64;

const EXTENSIONS = Object.freeze({
  '.mp4': 'mp4',
  '.m4v': 'mp4',
  '.mov': 'mov',
  '.qt': 'mov',
  '.webm': 'webm',
  '.mkv': 'mkv',
});

// Browsers report MKV inconsistently, so a missing or generic type is accepted
// (the signature check still applies).
const MIME_TYPES = Object.freeze({
  mp4: ['video/mp4', 'video/x-m4v'],
  mov: ['video/quicktime'],
  webm: ['video/webm', 'audio/webm'],
  mkv: ['video/x-matroska', 'video/mkv', 'video/matroska'],
});
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

const CANONICAL_MIME = Object.freeze({
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
});

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71', 'avc1', 'M4V ', 'M4VH', 'M4VP',
  'dash', 'msnv', 'MSNV', 'f4v ', 'NDAS', 'mmp4', '3gp4', '3gp5', '3gp6', '3g2a', 'XAVC',
]);
const QUICKTIME_BOXES = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Detects the container from the first bytes of a file. Returns null if it is not a supported video. */
function detectContainer(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;

  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const text = head.subarray(0, SIGNATURE_BYTES).toString('latin1');
    if (text.includes('webm')) return 'webm';
    if (text.includes('matroska')) return 'mkv';
    return null;
  }

  const boxType = head.subarray(4, 8).toString('latin1');
  if (boxType === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'mov';
    if (MP4_BRANDS.has(brand)) return 'mp4';
    return null; // e.g. "M4A " (audio), "heic"/"avif" (images)
  }
  if (QUICKTIME_BOXES.has(boxType)) return 'mov';
  return null;
}

/** mp4 and mov share the ISO format; many tools write either brand. */
function containersCompatible(fromExtension, detected) {
  if (fromExtension === detected) return true;
  const iso = new Set(['mp4', 'mov']);
  return iso.has(fromExtension) && iso.has(detected);
}

/** Strips any path, control characters and odd whitespace; keeps a readable display name. */
function sanitizeFilename(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'video').slice(0, 200);
}

function containerFromFilename(name) {
  return EXTENSIONS[path.extname(String(name || '')).toLowerCase()] ?? null;
}

function mimeAllowed(container, mimeType) {
  const type = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return GENERIC_MIME_TYPES.has(type) || (MIME_TYPES[container] || []).includes(type);
}

function titleFromFilename(name) {
  const base = sanitizeFilename(name).replace(/\.[^.]+$/, '');
  return base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Uploaded video';
}

module.exports = {
  SIGNATURE_BYTES,
  EXTENSIONS,
  CANONICAL_MIME,
  detectContainer,
  containersCompatible,
  sanitizeFilename,
  containerFromFilename,
  mimeAllowed,
  titleFromFilename,
};
