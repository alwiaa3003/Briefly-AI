'use strict';

const ProcessingJob = require('../models/ProcessingJob');
const { addProcessingJob, isQueueAvailable, DEFAULT_JOB_OPTIONS } = require('../queues/processingQueue');
const { JOB_TYPES, JOB_STATUSES } = require('../queues/constants');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const QUEUE_UNAVAILABLE_MESSAGE = 'Background processing is temporarily unavailable. Please try again shortly.';

/* ------------------------------ Creation ------------------------------ */

/**
 * Creates the durable ProcessingJob record, then enqueues it in BullMQ.
 * Reusable by every future job type (article, YouTube, document summaries).
 */
async function enqueueProcessingJob({ userId, type, input, sourceId = null }) {
  if (!isQueueAvailable()) {
    throw ApiError.serviceUnavailable(QUEUE_UNAVAILABLE_MESSAGE, 'QUEUE_UNAVAILABLE');
  }

  const job = await ProcessingJob.create({
    user: userId,
    type,
    source: sourceId,
    input,
    status: JOB_STATUSES.QUEUED,
    maxAttempts: DEFAULT_JOB_OPTIONS.attempts,
  });

  try {
    await addProcessingJob({ jobId: job.id, type, data: { processingJobId: job.id, type, input } });
  } catch (error) {
    logger.error('Failed to enqueue processing job', { jobId: job.id, type, error });
    job.status = JOB_STATUSES.FAILED;
    job.failedAt = new Date();
    job.error = { code: 'QUEUE_UNAVAILABLE', message: 'The job could not be queued.' };
    await job.save();
    throw ApiError.serviceUnavailable(QUEUE_UNAVAILABLE_MESSAGE, 'QUEUE_UNAVAILABLE');
  }

  logger.info('Processing job queued', { jobId: job.id, type });
  return job;
}

function createTestJob({ userId, message }) {
  return enqueueProcessingJob({ userId, type: JOB_TYPES.TEST, input: { message } });
}

/* ------------------------------- Queries ------------------------------- */

async function getJobForUser(jobId, userId) {
  const job = await ProcessingJob.findOne({ _id: jobId, user: userId });
  if (!job) throw ApiError.notFound('Job not found.', 'JOB_NOT_FOUND');
  return job;
}

/* --------------------------- Status updates ---------------------------- */
// Called by the worker. Each update is a single atomic write.

/** Returns the job record (with its owner), or null. */
function markJobActive(jobId, attempt) {
  return ProcessingJob.findOneAndUpdate(
    { _id: jobId },
    { $set: { status: JOB_STATUSES.ACTIVE, attempts: attempt, startedAt: new Date(), error: null, nextAttemptAt: null } },
    { new: true, projection: { user: 1 } }
  ).lean();
}

/** Waiting for AI capacity (quota, budget, rate limit): back to "queued" with the reason and the resume time. */
function markJobDeferred(jobId, error, nextAttemptAt, deferrals) {
  return ProcessingJob.updateOne(
    { _id: jobId },
    { $set: { status: JOB_STATUSES.QUEUED, error, nextAttemptAt, aiDeferrals: deferrals } }
  );
}

function markJobCompleted(jobId, attempt, result) {
  return ProcessingJob.updateOne(
    { _id: jobId },
    { $set: { status: JOB_STATUSES.COMPLETED, attempts: attempt, result, error: null, completedAt: new Date() } }
  );
}

/** A non-final failure: the job goes back to "queued" and BullMQ retries it after a backoff. */
function markJobRetrying(jobId, attempt, error) {
  return ProcessingJob.updateOne(
    { _id: jobId },
    { $set: { status: JOB_STATUSES.QUEUED, attempts: attempt, error } }
  );
}

function markJobFailed(jobId, attempt, error) {
  return ProcessingJob.updateOne(
    { _id: jobId },
    { $set: { status: JOB_STATUSES.FAILED, attempts: attempt, error, failedAt: new Date() } }
  );
}

module.exports = {
  QUEUE_UNAVAILABLE_MESSAGE,
  enqueueProcessingJob,
  createTestJob,
  getJobForUser,
  markJobActive,
  markJobDeferred,
  markJobCompleted,
  markJobRetrying,
  markJobFailed,
};
