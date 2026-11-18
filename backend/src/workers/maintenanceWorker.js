'use strict';

const { Queue } = require('bullmq');
const config = require('../config/env');
const { createRedisConnection } = require('../config/redis');
const { QUEUE_NAMES, MAINTENANCE_JOBS } = require('../queues/constants');
const { cleanupExpiredUploads } = require('../services/cleanupService');
const aiGate = require('../services/ai/aiGate');
const logger = require('../utils/logger');

const LEGACY_SCHEDULER_ID = 'cleanup-expired-uploads';
const LOCK_NAME = 'maintenance:cleanup-expired-uploads';
const FIRST_RUN_DELAY_MS = 60 * 1000;

async function runMaintenanceJob(job) {
  if (job.name === MAINTENANCE_JOBS.CLEANUP_UPLOADS) return cleanupExpiredUploads();
  logger.warn('Unknown maintenance job', { name: job.name });
  return null;
}

/**
 * One cleanup run, at most once per interval across all worker processes: a shared Redis
 * lock (with the interval as its lifetime) makes concurrent or repeated runs skip.
 */
async function runScheduledCleanup({ intervalMs = config.queue.maintenanceIntervalMs, acquireLock = aiGate.acquireLock } = {}) {
  let locked;
  try {
    locked = await acquireLock(LOCK_NAME, Math.max(60000, intervalMs - 60000));
  } catch (error) {
    logger.warn('Upload cleanup skipped: the shared lock is unavailable', { error: { message: error.message } });
    return { skipped: true, reason: 'lock_unavailable' };
  }
  if (!locked) return { skipped: true, reason: 'recently_run' };
  return runMaintenanceJob({ name: MAINTENANCE_JOBS.CLEANUP_UPLOADS });
}

/** Removes the hourly BullMQ job scheduler used by earlier versions (it kept a worker polling Redis). */
async function removeLegacyScheduler() {
  const connection = createRedisConnection('maintenance-migration');
  const queue = new Queue(QUEUE_NAMES.MAINTENANCE, { connection, prefix: config.queue.prefix });
  try {
    await queue.removeJobScheduler(LEGACY_SCHEDULER_ID);
  } catch (error) {
    logger.debug('No legacy maintenance scheduler to remove', { error: { message: error.message } });
  } finally {
    await queue.close().catch(() => {});
    await connection.quit().catch(() => connection.disconnect());
  }
}

/**
 * Hourly cleanup of expired uploads, run in the worker process.
 *
 * Earlier versions used a BullMQ job scheduler on a second queue. Its always-present delayed job
 * made that worker poll Redis every 10 s around the clock (~260K commands a month), which does not
 * fit the Upstash free tier. A timer plus a shared lock does the same job with a handful of commands.
 */
async function startMaintenance({ intervalMs = config.queue.maintenanceIntervalMs, firstRunDelayMs = FIRST_RUN_DELAY_MS } = {}) {
  await removeLegacyScheduler();

  let running = null;
  const tick = () => {
    if (running) return;
    running = runScheduledCleanup({ intervalMs })
      .catch((error) => logger.error('Upload cleanup failed', { error: { message: error.message } }))
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, firstRunDelayMs);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();

  return {
    async close() {
      clearTimeout(first);
      clearInterval(timer);
      if (running) await running;
    },
  };
}

module.exports = { startMaintenance, runMaintenanceJob, runScheduledCleanup, LEGACY_SCHEDULER_ID };
