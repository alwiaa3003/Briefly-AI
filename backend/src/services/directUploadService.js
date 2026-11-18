'use strict';

/**
 * Direct uploads: the browser sends file bytes straight to object storage with a short-lived
 * presigned PUT URL, so they never pass through the API (Render's free plan counts every byte
 * the service sends to B2 against a small monthly allowance).
 *
 *   1. start     validate name, type and size with the same policies as the streaming upload, pick
 *                TWO random keys under the user's prefix, record a `pending` Upload, and return a
 *                presigned URL for the upload key only (exact size, type and disposition).
 *                  uploadKey   what the browser may write (the URL stays usable until it expires)
 *                  storageKey  where the verified file will live; never given to the browser
 *   2. (browser) PUT the file to the URL.
 *   3. complete  copy uploadKey -> storageKey inside the bucket, then verify THE COPY: HEAD for the
 *                size, then the bytes through the same SignatureInspector (signature, byte count,
 *                SHA-256). Only a verified copy becomes `stored` and enters the existing pipeline,
 *                which reads storageKey only. The upload key is deleted afterwards.
 *
 * Because the verified bytes are in a key no URL can write, reusing the presigned URL after
 * completion cannot change what is processed. Anything written to the upload key later (until the
 * URL expires) is removed by the cleanup sweep once the URL can no longer be used
 * (uploadKeyPurgeAfter = URL expiry + grace for transfers still in flight).
 *
 * Nothing the client sends is trusted for identity or location: the user comes from the session,
 * both keys from the server, and every lookup is scoped to the owner. Completion is idempotent.
 */

const crypto = require('crypto');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
const mongoose = require('mongoose');
const config = require('../config/env');
const Upload = require('../models/Upload');
const Source = require('../models/Source');
const storage = require('./storageService');
const sourceService = require('./sourceService');
const { SignatureInspector, VIDEO_POLICY, DOCUMENT_POLICY } = require('./uploadService');
const { isQueueAvailable } = require('../queues/processingQueue');
const jobService = require('./jobService');
const { SOURCE_KINDS } = require('../queues/constants');
const videoFile = require('../utils/videoFile');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const POLICIES = Object.freeze({ [SOURCE_KINDS.VIDEO]: VIDEO_POLICY, [SOURCE_KINDS.DOCUMENT]: DOCUMENT_POLICY });
// A verification that has not finished in this time (crash, restart) may be claimed again.
const STALE_VERIFICATION_MS = 15 * 60 * 1000;

function policyFor(kind) {
  const policy = POLICIES[kind];
  if (!policy) throw ApiError.badRequest('Unknown upload kind.', 'INVALID_UPLOAD');
  return policy;
}

function tooLarge(policy) {
  const mb = Math.floor(policy.maxBytes() / (1024 * 1024));
  return new ApiError(413, 'FILE_TOO_LARGE', `The ${policy.noun === 'video' ? 'video' : 'file'} is larger than the ${mb} MB upload limit.`);
}

function notFound() {
  return ApiError.notFound('Upload not found.', 'UPLOAD_NOT_FOUND');
}

function storageUnavailable() {
  return ApiError.serviceUnavailable('The file could not be checked right now. Please try again.', 'STORAGE_UNAVAILABLE');
}

function ensureStorage() {
  if (!storage.isStorageConfigured()) throw storage.storageNotConfiguredError();
}

function ensureQueue() {
  if (!isQueueAvailable()) throw ApiError.serviceUnavailable(jobService.QUEUE_UNAVAILABLE_MESSAGE, 'QUEUE_UNAVAILABLE');
}

/** Deletes one object, logging instead of throwing (the cleanup sweep retries). */
async function tryDelete(key, uploadId, what) {
  if (!key) return true;
  try {
    await storage.deleteObject(key);
    return true;
  } catch (error) {
    logger.warn(`Could not delete the ${what} of an upload yet; cleanup will retry`, { uploadId, error: { message: error.message } });
    return false;
  }
}

/** Step 1: validate, reserve both keys and return a presigned PUT URL for the upload key. */
async function startUpload({ userId, kind, fileName, sizeBytes, mimeType }) {
  ensureStorage();
  const policy = policyFor(kind);

  const originalName = videoFile.sanitizeFilename(fileName);
  const expected = policy.formatFromFilename(originalName);
  if (!expected || !policy.mimeAllowed(expected, mimeType)) {
    throw new ApiError(415, policy.code, `Upload an ${policy.typesLabel} file.`);
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw ApiError.badRequest('The file size is invalid.', 'INVALID_UPLOAD');
  if (sizeBytes === 0) throw ApiError.badRequest('The file is empty.', 'EMPTY_FILE');
  if (sizeBytes > policy.maxBytes()) throw tooLarge(policy);

  const now = new Date();
  const open = await Upload.countDocuments({ user: userId, status: { $in: ['pending', 'verifying'] }, expiresAt: { $gt: now } });
  if (open >= config.directUploads.maxPendingPerUser) {
    throw new ApiError(429, 'TOO_MANY_PENDING_UPLOADS', 'Finish or cancel your other uploads before starting a new one.');
  }

  const ttlSeconds = config.storage.uploadUrlTtlSeconds;
  const graceMs = config.directUploads.pendingGraceSeconds * 1000;
  const urlExpiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const uploadKey = `${policy.keyPrefix}/${userId}/upload-${crypto.randomUUID()}`;
  const storageKey = `${policy.keyPrefix}/${userId}/${crypto.randomUUID()}`;
  const contentType = policy.canonicalMime[expected];
  const upload = await Upload.create({
    user: userId,
    storageKey,
    uploadKey,
    // The URL is checked when a transfer starts; one started just before expiry may still be
    // arriving afterwards, hence the grace period before the upload key is swept.
    uploadKeyPurgeAfter: new Date(urlExpiresAt.getTime() + graceMs),
    originalName,
    mimeType: contentType,
    container: expected,
    sizeBytes,
    status: 'pending',
    method: 'direct',
    kind,
    expiresAt: new Date(urlExpiresAt.getTime() + graceMs),
  });

  let signed;
  try {
    signed = await storage.getSignedUploadUrl(uploadKey, { contentType, contentLength: sizeBytes, ttlSeconds });
  } catch (error) {
    await Upload.updateOne({ _id: upload._id }, { $set: { status: 'rejected', rejection: 'presign_failed', expiresAt: new Date() } });
    logger.error('Could not presign an upload URL', { error: { name: error.name, message: error.message } });
    throw ApiError.serviceUnavailable('Uploads are temporarily unavailable. Please try again.', 'STORAGE_UNAVAILABLE');
  }

  return {
    uploadId: upload.id,
    upload: { method: signed.method, url: signed.url, headers: signed.headers, expiresAt: signed.expiresAt },
    maxBytes: policy.maxBytes(),
  };
}

async function findOwned({ userId, kind, uploadId }) {
  if (!mongoose.isValidObjectId(uploadId)) throw notFound();
  const upload = await Upload.findOne({ _id: uploadId, user: userId, method: 'direct', kind });
  if (!upload) throw notFound();
  return upload;
}

/**
 * Marks an upload rejected (only from `fromStatuses`) and deletes both of its objects (best effort;
 * the cleanup retries). Returns whether this call made the transition.
 */
async function reject(upload, reason, { fromStatuses = ['pending', 'verifying'] } = {}) {
  const changed = await Upload.updateOne(
    { _id: upload._id, status: { $in: fromStatuses } },
    { $set: { status: 'rejected', rejection: reason, verifyingAt: null, expiresAt: new Date() } }
  );
  if (!changed.modifiedCount) return false;
  const copyGone = await tryDelete(upload.storageKey, upload.id, 'copy');
  const uploadGone = await tryDelete(upload.uploadKey, upload.id, 'upload object');
  if (copyGone && uploadGone) {
    await Upload.updateOne({ _id: upload._id, status: 'rejected' }, { $set: { status: 'deleted', deletedAt: new Date() } });
  }
  return true;
}

/** Back to `pending` after a transient problem, so the user can complete again. */
function release(upload) {
  return Upload.updateOne({ _id: upload._id, status: 'verifying' }, { $set: { status: 'pending', verifyingAt: null } });
}

/** The answer of an earlier successful completion (idempotency). */
async function previousResult(upload, userId) {
  const source = upload.source ? await Source.findOne({ _id: upload.source, user: userId }) : null;
  if (!source) throw ApiError.conflict('This upload was already completed.', 'UPLOAD_ALREADY_COMPLETED');
  return { source, job: null, outcome: upload.outcome === 'existing' ? 'existing' : 'repeated' };
}

/** Reads an object once: signature, byte count and SHA-256, exactly as the streaming upload does. */
async function inspectObject(key, policy, expectedFormat) {
  const inspector = new SignatureInspector(policy, expectedFormat);
  const body = await storage.getObjectStream(key);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(body, inspector, sink);
  return { format: inspector.format, size: inspector.size, sha256: inspector.hash.digest('hex') };
}

/**
 * Step 3: copy to the immutable key, verify the copy, hand it to the existing pipeline,
 * then delete the browser's upload object.
 */
async function completeUpload({ userId, kind, uploadId }) {
  ensureStorage();
  const policy = policyFor(kind);
  const upload = await findOwned({ userId, kind, uploadId });

  if (upload.completedAt) return previousResult(upload, userId);
  if (upload.status === 'rejected' || upload.status === 'deleted') {
    throw ApiError.conflict('This upload can no longer be completed. Please upload the file again.', 'UPLOAD_EXPIRED');
  }
  if (!upload.uploadKey) {
    // Started before uploads used a separate browser key: cannot be completed safely.
    await reject(upload, 'legacy_pending');
    throw ApiError.conflict('This upload can no longer be completed. Please upload the file again.', 'UPLOAD_EXPIRED');
  }
  if (upload.expiresAt <= new Date()) {
    await reject(upload, 'expired');
    throw new ApiError(410, 'UPLOAD_EXPIRED', 'This upload expired. Please upload the file again.');
  }
  ensureQueue();

  // Claim it: only one completion copies and verifies a given upload.
  const claimed = await Upload.findOneAndUpdate(
    {
      _id: upload._id,
      user: userId,
      $or: [{ status: 'pending' }, { status: 'verifying', verifyingAt: { $lt: new Date(Date.now() - STALE_VERIFICATION_MS) } }],
    },
    { $set: { status: 'verifying', verifyingAt: new Date() } },
    { new: true }
  );
  if (!claimed) {
    const current = await Upload.findById(upload._id);
    if (current?.completedAt) return previousResult(current, userId);
    throw ApiError.conflict('This upload is already being completed.', 'UPLOAD_IN_PROGRESS');
  }

  // 1. Did the browser's upload arrive, at the announced size?
  let head;
  try {
    head = await storage.headObject(claimed.uploadKey);
  } catch (error) {
    await release(claimed);
    logger.warn('Storage unavailable while completing an upload', { uploadId: claimed.id, error: { name: error.name } });
    throw storageUnavailable();
  }
  if (!head) {
    await release(claimed);
    throw ApiError.conflict('The file has not finished uploading yet.', 'UPLOAD_NOT_RECEIVED');
  }
  if (head.sizeBytes > policy.maxBytes()) {
    await reject(claimed, 'too_large');
    throw tooLarge(policy);
  }
  if (head.sizeBytes !== claimed.sizeBytes) {
    await reject(claimed, 'size_mismatch');
    throw ApiError.badRequest('The uploaded file does not match the one that was announced.', 'UPLOAD_MISMATCH');
  }

  // 2. Copy it where no presigned URL can reach. A failure leaves the upload object untouched.
  try {
    await storage.copyObject(claimed.uploadKey, claimed.storageKey);
  } catch (error) {
    await tryDelete(claimed.storageKey, claimed.id, 'partial copy');
    await release(claimed);
    logger.warn('Could not copy an upload to its final key', { uploadId: claimed.id, error: { name: error.name } });
    throw storageUnavailable();
  }

  // 3. Verify THE COPY: the bytes that will be processed.
  const copyFailed = async (reason) => {
    // The upload object is still there, so the user can simply complete again.
    await tryDelete(claimed.storageKey, claimed.id, 'unverified copy');
    await release(claimed);
    logger.warn('The copy of an upload could not be verified', { uploadId: claimed.id, reason });
    throw storageUnavailable();
  };
  let copyHead;
  try {
    copyHead = await storage.headObject(claimed.storageKey);
  } catch {
    return copyFailed('head_failed');
  }
  if (!copyHead || copyHead.sizeBytes !== claimed.sizeBytes) return copyFailed('copy_size_mismatch');

  let inspected;
  try {
    inspected = await inspectObject(claimed.storageKey, policy, claimed.container);
  } catch (error) {
    if (error instanceof ApiError) {
      // Content is not the declared type (same rule and message as streaming uploads).
      await reject(claimed, 'invalid_content');
      throw error;
    }
    return copyFailed('read_failed');
  }
  if (inspected.size !== claimed.sizeBytes) return copyFailed('copy_read_size_mismatch');

  // 4. Hand the verified copy to the existing pipeline (it uses storageKey only).
  const stored = {
    storageKey: claimed.storageKey,
    originalName: claimed.originalName,
    mimeType: policy.canonicalMime[inspected.format],
    container: inspected.format,
    sizeBytes: inspected.size,
    sha256: inspected.sha256,
  };
  let result;
  try {
    const submit = kind === SOURCE_KINDS.VIDEO ? sourceService.submitUploadedVideo : sourceService.submitUploadedDocument;
    result = await submit({ userId, stored, pendingUpload: claimed });
  } catch (error) {
    // Not recorded as stored: the upload object is kept so a new completion can copy it again.
    await release(claimed);
    throw error;
  }

  // 5. The browser's object is no longer needed. If this fails, the cleanup sweep removes it later.
  await tryDelete(claimed.uploadKey, claimed.id, 'upload object');
  return result;
}

/** The user cancelled (or the browser upload failed for good): drop the reservation and any bytes. */
async function cancelUpload({ userId, kind, uploadId }) {
  ensureStorage();
  const upload = await findOwned({ userId, kind, uploadId });
  if (upload.completedAt || upload.status === 'stored') {
    throw ApiError.conflict('This upload was already completed.', 'UPLOAD_ALREADY_COMPLETED');
  }
  if (upload.status === 'pending') {
    // Only from `pending`: a completion that claimed it in the meantime is not interrupted.
    if (await reject(upload, 'cancelled', { fromStatuses: ['pending'] })) return;
  }
  const current = await Upload.findById(upload._id);
  if (current?.status === 'verifying') {
    throw ApiError.conflict('This upload is being checked and can no longer be cancelled.', 'UPLOAD_IN_PROGRESS');
  }
  if (current?.completedAt || current?.status === 'stored') {
    throw ApiError.conflict('This upload was already completed.', 'UPLOAD_ALREADY_COMPLETED');
  }
}

module.exports = { startUpload, completeUpload, cancelUpload, STALE_VERIFICATION_MS };
