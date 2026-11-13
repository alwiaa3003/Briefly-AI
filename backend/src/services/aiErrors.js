'use strict';

const ApiError = require('../utils/ApiError');
const { immediateMessage } = require('./ai/aiMessages');

const WAIT_CODES = new Set(['AI_QUOTA_EXHAUSTED', 'AI_RATE_LIMITED', 'AI_BUDGET_EXHAUSTED', 'AI_PACED', 'AI_BUSY']);
const CONFIG_CODES = new Set(['AI_NOT_CONFIGURED', 'AI_MODEL_UNAVAILABLE', 'AI_CONFIGURATION_ERROR']);

function retryAfterSecondsOf(error) {
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) return Math.ceil(error.retryAfterMs / 1000);
  if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) return Math.ceil(error.retryAfterSeconds);
  return null;
}

/**
 * Converts an AI failure during a synchronous request (Ask AI) into a safe ApiError
 * with a feature-specific message and, for temporary limits, a Retry-After value.
 */
function toApiError(error, feature = 'chat') {
  if (!error || (error.name !== 'ProcessingServiceError' && error.name !== 'AiGateError')) return error;
  const retryAfter = retryAfterSecondsOf(error);
  if (WAIT_CODES.has(error.code)) {
    // 429 for Briefly's own budgets / provider quota, 503 when the service is merely busy.
    const status = ['AI_QUOTA_EXHAUSTED', 'AI_BUDGET_EXHAUSTED'].includes(error.code) ? 429 : 503;
    const apiError = new ApiError(status, error.code, immediateMessage(error.code, feature, error.retryAfterMs), {
      retryAfterSeconds: retryAfter,
      scope: error.scope || error.quotaScope || null,
    });
    apiError.retryAfterSeconds = retryAfter;
    return apiError;
  }
  if (CONFIG_CODES.has(error.code)) {
    return ApiError.serviceUnavailable(immediateMessage(error.code, feature), error.code);
  }
  if (error.code === 'PROCESSING_SERVICE_UNREACHABLE' || error.code === 'PROCESSING_SERVICE_TIMEOUT') {
    return ApiError.serviceUnavailable('The AI service is temporarily unavailable. Please try again.', 'AI_UNAVAILABLE');
  }
  if (error.retryable) {
    const known = /^(AI_|EMBEDDING_)/.test(error.code || '');
    return new ApiError(503, known ? error.code : 'AI_UNAVAILABLE', known ? error.message : 'The AI service is busy. Please try again.');
  }
  return new ApiError(502, 'AI_FAILED', 'The AI service could not answer this request.');
}

module.exports = { toApiError, retryAfterSecondsOf };
