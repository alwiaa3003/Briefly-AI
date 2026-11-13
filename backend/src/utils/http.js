'use strict';

/**
 * Helpers for a consistent JSON response envelope:
 *
 *   success: { "success": true,  "data": { ... } }
 *   failure: { "success": false, "error": { "code", "message", "details"? } }
 */

function sendSuccess(res, statusCode, data) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(statusCode).json({ success: false, error });
}

/** Wraps an async route handler so rejected promises reach the error middleware. */
function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { sendSuccess, sendError, asyncHandler };
