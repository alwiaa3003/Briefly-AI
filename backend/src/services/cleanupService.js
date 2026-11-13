'use strict';

const Upload = require('../models/Upload');
const storage = require('./storageService');
const logger = require('../utils/logger');

/**
 * Deletes uploaded video files whose retention period has ended.
 * Runs hourly on the maintenance queue (see workers/maintenanceWorker.js).
 *
 * The record is only marked `deleted` after storage confirms the deletion, so a
 * failure leaves it eligible for the next run. Transcripts and summaries are kept.
 */
async function cleanupExpiredUploads({ now = new Date(), batchSize = 100 } = {}) {
  if (!storage.isStorageConfigured()) return { deleted: 0, failed: 0, skipped: true };

  const due = await Upload.find({ status: 'stored', expiresAt: { $lte: now } }).sort({ expiresAt: 1 }).limit(batchSize);

  let deleted = 0;
  let failed = 0;
  for (const upload of due) {
    try {
      await storage.deleteObject(upload.storageKey);
      await Upload.updateOne({ _id: upload._id, status: 'stored' }, { $set: { status: 'deleted', deletedAt: new Date() } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Could not delete expired upload; will retry next run', { uploadId: upload.id, error: { message: error.message } });
    }
  }
  if (deleted || failed) logger.info('Expired upload cleanup finished', { deleted, failed });
  return { deleted, failed, skipped: false };
}

module.exports = { cleanupExpiredUploads };
