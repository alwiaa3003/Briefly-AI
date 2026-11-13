'use strict';

const logger = require('../utils/logger');

/** Logs method, path (without query string), status and duration. Never bodies or headers. */
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${durationMs.toFixed(1)}ms`);
  });
  next();
}

module.exports = requestLogger;
