'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Real connection settings from backend/.env ...
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ... but isolated from development data.
function toTestDatabaseUri(uri) {
  const url = new URL(uri);
  url.pathname = '/briefly_ai_infra_test';
  return url.toString();
}
process.env.MONGODB_URI =
  process.env.MONGODB_TEST_URI || toTestDatabaseUri(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/briefly_ai');
process.env.QUEUE_PREFIX = 'briefly-infra-test';
process.env.JOB_BACKOFF_MS = '200';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'warn';
process.env.NODE_ENV = 'test';
