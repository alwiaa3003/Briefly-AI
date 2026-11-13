'use strict';

/**
 * Operational error with an HTTP status and a stable, machine-readable code.
 * Anything thrown that is NOT an ApiError is treated as an unexpected failure
 * and reported to clients as a generic 500.
 */
class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'The request is invalid.', code = 'BAD_REQUEST', details) {
    return new ApiError(400, code, message, details);
  }

  static validation(details, message = 'Some fields are invalid.') {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication is required.', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'The requested resource was not found.', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static tooManyRequests(message = 'Too many requests. Please try again later.', code = 'RATE_LIMITED') {
    return new ApiError(429, code, message);
  }

  static serviceUnavailable(message = 'The service is temporarily unavailable.', code = 'SERVICE_UNAVAILABLE') {
    return new ApiError(503, code, message);
  }
}

module.exports = ApiError;
