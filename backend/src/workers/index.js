'use strict';

/**
 * Worker process entry point:  npm run worker
 *
 * Runs separately from the API so heavy background processing never blocks
 * HTTP request handling, and so workers can be scaled independently.
 *
 * Startup order matters: the shared Redis connection holds Briefly's AI budgets
 * (aiGate.js). The worker only starts taking jobs once that connection is ready,
 * and makes the shared store mandatory, so no job ever counts AI requests in
 * process memory. If Redis is not ready in time, startup fails clearly.
 */

const config = require('../config/env');
const { connectDatabase, disconnectDatabase } = require('../config/database');
const { createProcessingWorker } = require('./processingWorker');
const { startMaintenance } = require('./maintenanceWorker');
const { isStorageConfigured } = require('../services/storageService');
const { waitForSharedRedis, closeSharedRedisConnection } = require('../config/redis');
const { closeProcessingQueue } = require('../queues/processingQueue');
const aiGate = require('../services/ai/aiGate');
const logger = require('../utils/logger');

const DEFAULT_DEPS = {
  connectDatabase,
  waitForSharedRedis,
  requireSharedStore: aiGate.requireSharedStore,
  createProcessingWorker,
  startMaintenance,
  isStorageConfigured,
};

/**
 * Starts the processing (and maintenance) workers. Exported for tests: every
 * dependency can be replaced, and nothing consumes jobs before Redis is ready.
 */
async function startWorker(overrides = {}) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const timeoutMs = overrides.redisReadyTimeoutMs || config.queue.redisReadyTimeoutMs;

  await deps.connectDatabase();

  // 1. Shared Redis first: AI budgets, provider blocks and locks live there.
  try {
    await deps.waitForSharedRedis(timeoutMs);
  } catch (error) {
    throw Object.assign(
      new Error(
        `Redis was not ready within ${Math.round(timeoutMs / 1000)} s. The worker will not process jobs without ` +
          "Briefly's shared AI budget store. Check REDIS_URL and that Redis is reachable, then start the worker again."
      ),
      { code: 'WORKER_REDIS_NOT_READY', cause: error }
    );
  }
  // 2. From now on a lost Redis connection pauses AI calls (AI_BUDGET_UNAVAILABLE, deferred) instead of
  //    falling back to per-process counting.
  deps.requireSharedStore(true);

  // 3. Only now start consuming jobs.
  const worker = deps.createProcessingWorker();
  await worker.waitUntilReady();
  logger.info('Processing worker started', {
    queue: worker.name,
    prefix: config.queue.prefix,
    concurrency: config.queue.workerConcurrency,
    aiBudgetStore: config.ai.store === 'memory' ? 'memory (AI_GATE_STORE=memory)' : 'redis (required)',
  });

  // Hourly deletion of expired uploaded videos (only relevant when uploads are enabled).
  const maintenance = deps.isStorageConfigured() ? await deps.startMaintenance() : null;
  if (maintenance) logger.info('Maintenance worker started (expired upload cleanup every hour)');

  return { worker, maintenance };
}

async function main() {
  const { worker, maintenance } = await startWorker();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; finishing active jobs and shutting down`);
    try {
      if (maintenance) await maintenance.close();
      await worker.close();
      await closeProcessingQueue();
      await closeSharedRedisConnection();
      await disconnectDatabase();
      process.exit(0);
    } catch (error) {
      logger.error('Error during worker shutdown', { error });
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch(async (error) => {
    logger.error('Worker failed to start', { error: { message: error.message, code: error.code } });
    await closeSharedRedisConnection().catch(() => {});
    await disconnectDatabase().catch(() => {});
    process.exit(1);
  });
}

module.exports = { startWorker };
