'use strict';

const { Queue } = require('bullmq');
const config = require('../config/env');
const { getSharedRedisConnection, isSharedRedisReady } = require('../config/redis');
const { QUEUE_NAMES } = require('./constants');

/**
 * Default options applied to every job on the processing queue:
 *  - bounded retries with exponential backoff
 *  - completed/failed jobs are trimmed from Redis automatically; the durable
 *    record lives in the ProcessingJob collection in MongoDB.
 */
const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: config.queue.maxAttempts,
  // 'custom' = the worker's backoffStrategy (exponential, longer for transient AI errors).
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
});

let processingQueue = null;

function getProcessingQueue() {
  if (!processingQueue) {
    processingQueue = new Queue(QUEUE_NAMES.PROCESSING, {
      connection: getSharedRedisConnection(),
      prefix: config.queue.prefix,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return processingQueue;
}

function isQueueAvailable() {
  return isSharedRedisReady();
}

/**
 * Adds a job to the processing queue.
 * @param {object} params
 * @param {string} params.jobId   Stable id (the ProcessingJob document id) — makes enqueueing idempotent.
 * @param {string} params.type    One of JOB_TYPES; used as the BullMQ job name.
 * @param {object} params.data    Serializable payload for the worker.
 */
async function addProcessingJob({ jobId, type, data, options = {} }) {
  const queue = getProcessingQueue();
  return queue.add(type, data, { jobId, ...options });
}

async function closeProcessingQueue() {
  if (processingQueue) {
    const queue = processingQueue;
    processingQueue = null;
    await queue.close();
  }
}

module.exports = {
  DEFAULT_JOB_OPTIONS,
  getProcessingQueue,
  isQueueAvailable,
  addProcessingJob,
  closeProcessingQueue,
};
