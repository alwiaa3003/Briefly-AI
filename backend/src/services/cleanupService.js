'use strict';

const Upload = require('../models/Upload');
const storage = require('./storageService');
const logger = require('../utils/logger');

// A completion still verifying for less than this is left alone (see directUploadService).
const ACTIVE_VERIFICATION_MS = 30 * 60 * 1000;

/**
 * Hourly storage cleanup (run in the worker process, see workers/maintenanceWorker.js):
 *
 *  1. Expiry: files whose retention ended, and direct uploads that were never completed
 *     (pending past their deadline, rejected, stuck verifying). Both objects of a direct upload
 *     (the browser's upload key and the server's copy) are deleted.
 *  2. Upload-key sweep: once a direct upload's presigned URL can no longer be used
 *     (uploadKeyPurgeAfter = URL expiry + grace), its upload key is deleted again, whatever
 *     happened to the upload. This removes anything written by reusing the URL after completion,
 *     cancellation or rejection. Uploads still pending or verifying are skipped (their upload key
 *     may hold the only copy), and the sweep never touches a stored upload's own storage key.
 *
 * Only exact keys recorded on Upload documents are deleted, and a record is only updated after
 * storage confirms the deletion, so a failure leaves it eligible for the next run. Transcripts and
 * summaries are kept.
 */
async function cleanupExpiredUploads({ now = new Date(), batchSize = 100 } = {}) {
  if (!storage.isStorageConfigured()) return { deleted: 0, failed: 0, purged: 0, skipped: true };

  const due = await Upload.find({
    expiresAt: { $lte: now },
    $or: [
      { status: { $in: ['stored', 'pending', 'rejected'] } },
      { status: 'verifying', verifyingAt: { $lt: new Date(now.getTime() - ACTIVE_VERIFICATION_MS) } },
    ],
  })
    .sort({ expiresAt: 1 })
    .limit(batchSize);

  let deleted = 0;
  let failed = 0;
  for (const upload of due) {
    try {
      await storage.deleteObject(upload.storageKey);
      // Direct uploads that never became `stored` may also have bytes under their upload key.
      if (upload.uploadKey && upload.uploadKey !== upload.storageKey && upload.status !== 'stored') {
        await storage.deleteObject(upload.uploadKey);
      }
      await Upload.updateOne({ _id: upload._id, status: upload.status }, { $set: { status: 'deleted', deletedAt: new Date() } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Could not delete expired upload; will retry next run', { uploadId: upload.id, error: { message: error.message } });
    }
  }

  const sweep = await Upload.find({
    uploadKey: { $type: 'string' },
    uploadKeyPurgedAt: null,
    uploadKeyPurgeAfter: { $lte: now },
    status: { $nin: ['pending', 'verifying'] },
  })
    .sort({ uploadKeyPurgeAfter: 1 })
    .limit(batchSize);

  let purged = 0;
  for (const upload of sweep) {
    // Never delete the object a stored upload is processed from.
    if (upload.uploadKey === upload.storageKey) {
      await Upload.updateOne({ _id: upload._id }, { $set: { uploadKeyPurgedAt: new Date() } });
      continue;
    }
    try {
      await storage.deleteObject(upload.uploadKey);
      await Upload.updateOne({ _id: upload._id, uploadKeyPurgedAt: null }, { $set: { uploadKeyPurgedAt: new Date() } });
      purged += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Could not delete an upload key yet; will retry next run', { uploadId: upload.id, error: { message: error.message } });
    }
  }

  if (deleted || failed || purged) logger.info('Upload cleanup finished', { deleted, purged, failed });
  return { deleted, failed, purged, skipped: false };
}

module.exports = { cleanupExpiredUploads };
