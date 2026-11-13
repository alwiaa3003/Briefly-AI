'use strict';

const mongoose = require('mongoose');
const ApiError = require('../utils/ApiError');
const { sendError } = require('../utils/http');
const logger = require('../utils/logger');

function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.path} does not exist.`, 'ROUTE_NOT_FOUND'));
}

/**
 * Converts every error into the standard JSON error envelope.
 * Unexpected errors are logged in full on the server but reported to the
 * client only as a generic message, so internals never leak.
 */
function errorHandler(error, req, res, _next) {
  if (error instanceof ApiError) {
    if (error.statusCode >= 500 && error.statusCode !== 503) logger.error('Service error', { path: req.path, error });
    if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) res.set('Retry-After', String(error.retryAfterSeconds));
    return sendError(res, error.statusCode, error.code, error.message, error.details);
  }

  // Errors raised by express.json() / body-parser
  if (error.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (error.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((item) => ({ field: item.path, message: item.message }));
    return sendError(res, 400, 'VALIDATION_ERROR', 'Some fields are invalid.', details);
  }
  if (error instanceof mongoose.Error.CastError) {
    return sendError(res, 400, 'INVALID_ID', 'The provided identifier is invalid.');
  }

  logger.error('Unhandled error', { method: req.method, path: req.path, error });
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}

module.exports = { notFoundHandler, errorHandler };
