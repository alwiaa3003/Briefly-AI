'use strict';

const Source = require('../../models/Source');
const ContentChunk = require('../../models/ContentChunk');
const jobService = require('../jobService');
const config = require('../../config/env');
const { JOB_TYPES, RAG_STATUSES, SOURCE_STATUSES } = require('../../queues/constants');
const logger = require('../../utils/logger');

/**
 * Queues (re)indexing of a completed source for Ask AI and smart search.
 * Skips sources that are already queued/indexing unless `force` is set.
 * Returns the job, or null when nothing was queued.
 */
async function scheduleIndexing({ sourceId, userId, force = false }) {
  const guard = force
    ? {}
    : { 'rag.status': { $nin: [RAG_STATUSES.QUEUED, RAG_STATUSES.INDEXING] } };
  const claimed = await Source.findOneAndUpdate(
    { _id: sourceId, user: userId, status: SOURCE_STATUSES.COMPLETED, ...guard },
    { $set: { 'rag.status': RAG_STATUSES.QUEUED, 'rag.error': null } },
    { new: true }
  );
  if (!claimed) return null;

  try {
    const job = await jobService.enqueueProcessingJob({
      userId,
      type: JOB_TYPES.INDEX_SOURCE,
      input: { sourceId: String(sourceId), userId: String(userId) },
      sourceId,
    });
    await Source.updateOne({ _id: sourceId }, { $set: { 'rag.job': job._id } });
    return job;
  } catch (error) {
    await Source.updateOne(
      { _id: sourceId },
      { $set: { 'rag.status': RAG_STATUSES.FAILED, 'rag.error': { code: 'QUEUE_UNAVAILABLE', message: 'Indexing could not be queued.' } } }
    );
    throw error;
  }
}

/** Called after a summary job completes: index automatically (best effort, never fails the summary). */
async function scheduleAfterSummary({ sourceId }) {
  if (!config.rag.autoIndex || !sourceId) return null;
  const source = await Source.findById(sourceId).select('user status');
  if (!source || source.status !== SOURCE_STATUSES.COMPLETED) return null;
  try {
    return await scheduleIndexing({ sourceId: source._id, userId: source.user, force: true });
  } catch (error) {
    logger.warn('Automatic indexing could not be queued', { sourceId: String(sourceId), code: error.code });
    return null;
  }
}

/** Removes the chunks (and embeddings) of a source. */
function removeIndex(sourceId) {
  return ContentChunk.deleteMany({ source: sourceId });
}

module.exports = { scheduleIndexing, scheduleAfterSummary, removeIndex };
