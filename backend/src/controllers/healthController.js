'use strict';

const { pingDatabase } = require('../config/database');
const { getSharedRedisConnection, isSharedRedisReady } = require('../config/redis');
const processingClient = require('../services/processingClient');
const { sendSuccess } = require('../utils/http');

const CHECK_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runCheck(check) {
  const startedAt = Date.now();
  try {
    await withTimeout(check(), CHECK_TIMEOUT_MS);
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch {
    // Failure reasons stay in server logs; clients only learn up/down.
    return { status: 'down' };
  }
}

/** GET /api/health — liveness: the API process is running. */
function liveness(_req, res) {
  return sendSuccess(res, 200, {
    status: 'ok',
    service: 'briefly-ai-api',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

/** GET /api/health/ready — readiness: every dependency the API needs is reachable. */
async function readiness(_req, res) {
  const [database, redis, processingService] = await Promise.all([
    runCheck(pingDatabase),
    runCheck(async () => {
      if (!isSharedRedisReady()) throw new Error('Redis not ready');
      await getSharedRedisConnection().ping();
    }),
    runCheck(() => processingClient.checkHealth({ timeoutMs: CHECK_TIMEOUT_MS })),
  ]);

  const services = { database, redis, processingService };
  const allUp = Object.values(services).every((service) => service.status === 'up');

  // Same envelope as other responses; `success` is false when any dependency is down.
  return res.status(allUp ? 200 : 503).json({
    success: allUp,
    data: { status: allUp ? 'ok' : 'degraded', services, timestamp: new Date().toISOString() },
  });
}

module.exports = { liveness, readiness };
