'use strict';

/**
 * Infrastructure tests against REAL running services:
 * MongoDB, Redis and the Python processing service.
 *
 *   npm run test:infra
 *
 * Reads backend/.env, but always uses a separate database and queue prefix so
 * your development data and any running worker are never touched.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  setupFiles: ['<rootDir>/tests/setup/infraEnv.js'],
  testTimeout: 60000,
};
