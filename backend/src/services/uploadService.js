'use strict';

/**
 * Streaming uploads: request -> busboy -> signature check + hashing -> object storage.
 * Shared by video (Milestone 3) and document (Milestone 4) uploads via a policy.
 *
 * - The file is never buffered in memory or written to local disk. Only the
 *   first bytes are held, to verify the file signature before anything is
 *   forwarded.
 * - Size is enforced while streaming (busboy fileSize limit), and an
 *   oversized Content-Length is rejected before reading the body.
 * - Exactly one file field is accepted. The storage key is random, so the
 *   client's filename can never influence a storage path (no path traversal).
 * - Any failure aborts the multipart upload, so no partial objects remain.
 */

const crypto = require('crypto');
const { Transform } = require('stream');
const Busboy = require('busboy');
const config = require('../config/env');
const storage = require('./storageService');
const ApiError = require('../utils/ApiError');
const videoFile = require('../utils/videoFile');
const documentFile = require('../utils/documentFile');

const MULTIPART_OVERHEAD = 64 * 1024;

/**
 * @typedef {object} UploadPolicy
 * @property {string} noun                  'video' | 'document' (messages)
 * @property {string} code                  415 error code
 * @property {string} typesLabel            human list of accepted types
 * @property {() => number} maxBytes
 * @property {number} signatureBytes
 * @property {string} keyPrefix
 * @property {(name: string) => string|null} formatFromFilename
 * @property {(format: string, mime: string) => boolean} mimeAllowed
 * @property {(head: Buffer, expected: string) => string|null} detect   returns the detected format or null
 * @property {Record<string,string>} canonicalMime
 */

/** @type {UploadPolicy} */
const VIDEO_POLICY = Object.freeze({
  noun: 'video',
  code: 'UNSUPPORTED_VIDEO_TYPE',
  typesLabel: 'MP4, MOV, WEBM or MKV video',
  maxBytes: () => config.uploads.maxBytes,
  signatureBytes: videoFile.SIGNATURE_BYTES,
  keyPrefix: 'videos',
  formatFromFilename: videoFile.containerFromFilename,
  mimeAllowed: videoFile.mimeAllowed,
  detect(head, expected) {
    const detected = videoFile.detectContainer(head);
    return detected && videoFile.containersCompatible(expected, detected) ? detected : null;
  },
  canonicalMime: videoFile.CANONICAL_MIME,
});

/** @type {UploadPolicy} */
const DOCUMENT_POLICY = Object.freeze({
  noun: 'document',
  code: 'UNSUPPORTED_DOCUMENT_TYPE',
  typesLabel: 'PDF, DOCX or TXT document',
  maxBytes: () => config.documents.maxBytes,
  signatureBytes: documentFile.SIGNATURE_BYTES,
  keyPrefix: 'documents',
  formatFromFilename: documentFile.formatFromFilename,
  mimeAllowed: documentFile.documentMimeAllowed,
  detect(head, expected) {
    const detected = documentFile.detectDocumentFormat(head, expected);
    return detected === expected ? detected : null;
  },
  canonicalMime: documentFile.CANONICAL_MIME,
});

function unsupportedType(policy, message = `Upload an ${policy.typesLabel} file.`) {
  return new ApiError(415, policy.code, message);
}

function tooLarge(policy) {
  const mb = Math.floor(policy.maxBytes() / (1024 * 1024));
  const noun = policy.noun === 'video' ? 'video' : 'file';
  return new ApiError(413, 'FILE_TOO_LARGE', `The ${noun} is larger than the ${mb} MB upload limit.`);
}

/** Verifies the signature from the first bytes, then passes data through while hashing and counting. */
class SignatureInspector extends Transform {
  constructor(policy, expectedFormat) {
    super();
    this.policy = policy;
    this.expected = expectedFormat;
    this.head = Buffer.alloc(0);
    this.verified = false;
    this.format = null;
    this.size = 0;
    this.hash = crypto.createHash('sha256');
  }

  /** Backwards-compatible name used for videos. */
  get container() {
    return this.format;
  }

  _verify() {
    const detected = this.policy.detect(this.head, this.expected);
    if (!detected) {
      throw unsupportedType(this.policy, `The file content is not a valid ${this.policy.typesLabel}.`);
    }
    this.format = detected;
    this.verified = true;
  }

  _transform(chunk, _encoding, callback) {
    this.size += chunk.length;
    this.hash.update(chunk);
    if (this.verified) return callback(null, chunk);

    this.head = Buffer.concat([this.head, chunk]);
    if (this.head.length < this.policy.signatureBytes) return callback();
    try {
      this._verify();
    } catch (error) {
      return callback(error);
    }
    const buffered = this.head;
    this.head = Buffer.alloc(0);
    return callback(null, buffered);
  }

  _flush(callback) {
    if (this.verified) return callback();
    try {
      this._verify(); // file shorter than signatureBytes
    } catch (error) {
      return callback(error);
    }
    callback(null, this.head);
  }
}

/**
 * Receives one file from a multipart request (field "file") and stores it.
 * @returns {Promise<{ storageKey, originalName, mimeType, container, sizeBytes, sha256 }>}
 */
function receiveUpload(req, { userId, policy }) {
  if (!storage.isStorageConfigured()) return Promise.reject(storage.storageNotConfiguredError());
  if (!req.is('multipart/form-data')) {
    return Promise.reject(ApiError.badRequest(`Send the ${policy.noun} as multipart/form-data.`, 'INVALID_UPLOAD'));
  }
  const maxBytes = policy.maxBytes();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes + MULTIPART_OVERHEAD) {
    return Promise.reject(tooLarge(policy));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let fileSeen = false;
    let abortUpload = null;
    let uploadPromise = null;

    function fail(error) {
      if (settled) return;
      settled = true;
      if (abortUpload) abortUpload();
      req.unpipe();
      req.resume(); // drain the rest of the body
      reject(error);
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: maxBytes, fields: 5, fieldSize: 1024, parts: 7 },
      });
    } catch {
      fail(ApiError.badRequest('The upload request is malformed.', 'INVALID_UPLOAD'));
      return;
    }

    busboy.on('file', (fieldName, file, info) => {
      if (fieldName !== 'file' || fileSeen) {
        file.resume();
        return;
      }
      fileSeen = true;

      const originalName = videoFile.sanitizeFilename(info.filename);
      const expected = policy.formatFromFilename(originalName);
      if (!expected || !policy.mimeAllowed(expected, info.mimeType)) {
        file.resume();
        fail(unsupportedType(policy));
        return;
      }

      const inspector = new SignatureInspector(policy, expected);
      const storageKey = `${policy.keyPrefix}/${userId}/${crypto.randomUUID()}`;
      const upload = storage.uploadStream({ key: storageKey, body: inspector, contentType: policy.canonicalMime[expected] });
      abortUpload = upload.abort;

      file.on('limit', () => {
        inspector.destroy(tooLarge(policy));
        fail(tooLarge(policy));
      });
      inspector.on('error', (error) => fail(error instanceof ApiError ? error : unsupportedType(policy)));
      file.pipe(inspector);

      uploadPromise = upload.promise.then(async () => {
        if (file.truncated) {
          await storage.deleteObject(storageKey).catch(() => {});
          throw tooLarge(policy);
        }
        return {
          storageKey,
          originalName,
          mimeType: policy.canonicalMime[inspector.format],
          container: inspector.format,
          sizeBytes: inspector.size,
          sha256: inspector.hash.digest('hex'),
        };
      });
      uploadPromise.catch(() => {}); // handled in 'close'
    });

    busboy.on('filesLimit', () => fail(ApiError.badRequest('Upload one file at a time.', 'INVALID_UPLOAD')));
    busboy.on('error', () => fail(ApiError.badRequest('The upload could not be read.', 'INVALID_UPLOAD')));
    busboy.on('close', async () => {
      if (settled) return;
      if (!uploadPromise) {
        fail(ApiError.badRequest(`Choose a ${policy.noun} file to upload.`, 'NO_FILE'));
        return;
      }
      try {
        const result = await uploadPromise;
        if (settled) return; // failed while storage was finishing (e.g. client aborted)
        if (result.sizeBytes === 0) {
          await storage.deleteObject(result.storageKey).catch(() => {});
          fail(ApiError.badRequest('The file is empty.', 'EMPTY_FILE'));
          return;
        }
        settled = true;
        resolve(result);
      } catch (error) {
        fail(
          error instanceof ApiError
            ? error
            : ApiError.serviceUnavailable(`The ${policy.noun} could not be stored. Please try again.`, 'STORAGE_UPLOAD_FAILED')
        );
      }
    });
    req.on('aborted', () => fail(ApiError.badRequest('The upload was cancelled.', 'UPLOAD_ABORTED')));

    req.pipe(busboy);
  });
}

function receiveVideoUpload(req, { userId }) {
  return receiveUpload(req, { userId, policy: VIDEO_POLICY });
}

function receiveDocumentUpload(req, { userId }) {
  return receiveUpload(req, { userId, policy: DOCUMENT_POLICY });
}

module.exports = {
  receiveUpload,
  receiveVideoUpload,
  receiveDocumentUpload,
  SignatureInspector,
  VideoInspector: SignatureInspector,
  VIDEO_POLICY,
  DOCUMENT_POLICY,
};
