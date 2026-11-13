'use strict';

const { Worker } = require('bullmq');
const config = require('../config/env');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_NAMES } = require('../queues/constants');
const { processJob, backoffStrategy } = require('./processor');
const logger = require('../utils/logger');

/**
 * Creates a BullMQ worker for the processing queue. The worker owns its Redis
 * connection and closes it when `worker.close()` is called.
 */
function createProcessingWorker({ concurrency = config.queue.workerConcurrency } = {}) {
  const connection = createRedisConnection('worker');

  const worker = new Worker(QUEUE_NAMES.PROCESSING, processJob, {
    connection,
    prefix: config.queue.prefix,
    concurrency,
    // A job whose lock is lost twice (e.g. the worker crashed mid-job) is failed
    // instead of being retried forever.
    maxStalledCount: 2,
    // Longer waits for transient AI errors; quota / rate limits use delayed retries instead (processor.js).
    settings: { backoffStrategy },
  });

  worker.on('error', (error) => logger.error('Worker error', { error }));

  const close = worker.close.bind(worker);
  worker.close = async (...args) => {
    await close(...args);
    await connection.quit().catch(() => connection.disconnect());
  };

  return worker;
}

module.exports = { createProcessingWorker };
