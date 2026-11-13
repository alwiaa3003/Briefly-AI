'use strict';

const { Queue, Worker } = require('bullmq');
const config = require('../config/env');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_NAMES, MAINTENANCE_JOBS } = require('../queues/constants');
const { cleanupExpiredUploads } = require('../services/cleanupService');
const logger = require('../utils/logger');

const CLEANUP_EVERY_MS = 60 * 60 * 1000;

async function runMaintenanceJob(job) {
  if (job.name === MAINTENANCE_JOBS.CLEANUP_UPLOADS) return cleanupExpiredUploads();
  logger.warn('Unknown maintenance job', { name: job.name });
  return null;
}

/**
 * Starts the maintenance worker and registers the hourly cleanup schedule
 * (idempotent: upsertJobScheduler keeps exactly one schedule across restarts).
 */
async function startMaintenance() {
  const queueConnection = createRedisConnection('maintenance-queue');
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection: queueConnection, prefix: config.queue.prefix });
  await queue.upsertJobScheduler(
    'cleanup-expired-uploads',
    { every: CLEANUP_EVERY_MS },
    { name: MAINTENANCE_JOBS.CLEANUP_UPLOADS, opts: { removeOnComplete: 50, removeOnFail: 50 } }
  );

  const workerConnection = createRedisConnection('maintenance-worker');
  const worker = new Worker(QUEUE_NAMES.MAINTENANCE, runMaintenanceJob, {
    connection: workerConnection,
    prefix: config.queue.prefix,
    concurrency: 1,
  });
  worker.on('error', (error) => logger.error('Maintenance worker error', { error }));

  return {
    async close() {
      await worker.close();
      await queue.close();
      await Promise.all([queueConnection, workerConnection].map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}

module.exports = { startMaintenance, runMaintenanceJob };
