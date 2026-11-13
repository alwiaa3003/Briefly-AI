'use strict';

/**
 * API process entry point:  npm run dev  /  npm start
 */

const config = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { getSharedRedisConnection, closeSharedRedisConnection } = require('./config/redis');
const { closeProcessingQueue } = require('./queues/processingQueue');
const { createApp } = require('./app');
const logger = require('./utils/logger');

async function main() {
  await connectDatabase();

  // Open Redis eagerly. The API still starts if Redis is down: auth keeps
  // working, and job submission returns 503 until Redis becomes reachable.
  getSharedRedisConnection();

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info(`Briefly AI API listening on http://localhost:${config.port}`, { env: config.env });
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`);

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    server.close(async () => {
      try {
        await closeProcessingQueue();
        await closeSharedRedisConnection();
        await disconnectDatabase();
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
      }
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled promise rejection', { error: reason }));
}

main().catch((error) => {
  logger.error('API failed to start', { error });
  process.exit(1);
});
