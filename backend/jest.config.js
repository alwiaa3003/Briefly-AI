'use strict';

/** Unit and API tests. Uses an in-memory MongoDB; no external services required. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
  setupFiles: ['<rootDir>/tests/setup/testEnv.js'],
  testTimeout: 60000,
};
