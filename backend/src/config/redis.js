'use strict';

const IORedis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

const ERROR_LOG_INTERVAL_MS = 30000;

/**
 * Creates a new ioredis connection.
 *
 * ioredis reconnects automatically; errors are logged at most once every
 * 30 seconds per connection to keep logs readable while Redis is down.
 */
function createRedisConnection(name, overrides = {}) {
  const connection = new IORedis(config.redis.url, {
    connectionName: `briefly:${name}`,
    // Required by BullMQ for blocking connections; harmless elsewhere.
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    ...overrides,
  });

  let lastErrorLoggedAt = 0;
  connection.on('error', (error) => {
    const now = Date.now();
    if (now - lastErrorLoggedAt > ERROR_LOG_INTERVAL_MS) {
      lastErrorLoggedAt = now;
      logger.error(`Redis connection error (${name})`, { error: { message: error.message, code: error.code } });
    }
  });
  connection.on('ready', () => {
    lastErrorLoggedAt = 0;
    logger.info(`Redis connected (${name})`);
  });

  return connection;
}

let sharedConnection = null;

/**
 * Shared connection used by queue producers and health checks.
 *
 * The offline queue is disabled so commands fail immediately while Redis is
 * unreachable, instead of hanging an HTTP request until Redis comes back.
 */
function getSharedRedisConnection() {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection('api', { enableOfflineQueue: false });
  }
  return sharedConnection;
}

function isSharedRedisReady() {
  return sharedConnection !== null && sharedConnection.status === 'ready';
}

/** Resolves once the shared connection is ready, or rejects after timeoutMs. */
function waitForSharedRedis(timeoutMs = 5000) {
  const connection = getSharedRedisConnection();
  if (connection.status === 'ready') return Promise.resolve(connection);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.off('ready', onReady);
      reject(new Error(`Redis was not ready within ${timeoutMs}ms`));
    }, timeoutMs);
    function onReady() {
      clearTimeout(timer);
      resolve(connection);
    }
    connection.once('ready', onReady);
  });
}

async function closeSharedRedisConnection() {
  if (sharedConnection) {
    const connection = sharedConnection;
    sharedConnection = null;
    await connection.quit().catch(() => connection.disconnect());
  }
}

module.exports = {
  createRedisConnection,
  getSharedRedisConnection,
  isSharedRedisReady,
  waitForSharedRedis,
  closeSharedRedisConnection,
};
