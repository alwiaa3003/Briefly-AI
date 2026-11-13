'use strict';

const { UnrecoverableError, DelayedError } = require('bullmq');
const config = require('../config/env');
const { getJobHandler } = require('./handlers');
const jobService = require('../services/jobService');
const aiGate = require('../services/ai/aiGate');
const { deferredMessage, gaveUpMessage } = require('../services/ai/aiMessages');
const { JOB_TYPES } = require('../queues/constants');
const logger = require('../utils/logger');

/** Feature (for budgets, usage and messages) of each job type. */
const FEATURE_BY_TYPE = Object.freeze({
  [JOB_TYPES.SUMMARIZE_ARTICLE]: 'summary',
  [JOB_TYPES.SUMMARIZE_YOUTUBE]: 'summary',
  [JOB_TYPES.SUMMARIZE_VIDEO_UPLOAD]: 'summary',
  [JOB_TYPES.SUMMARIZE_DOCUMENT]: 'summary',
  [JOB_TYPES.INDEX_SOURCE]: 'indexing',
  [JOB_TYPES.GENERATE_STUDY_NOTES]: 'notes',
  [JOB_TYPES.GENERATE_QUIZ]: 'quiz',
  [JOB_TYPES.GENERATE_FLASHCARDS]: 'flashcards',
  [JOB_TYPES.GENERATE_SUMMARY_STYLE]: 'style',
});

/**
 * Errors that mean "not now" rather than "this failed": the job is moved to
 * BullMQ's delayed set until the provider / budget allows it again. Waiting
 * does not occupy a worker and does not consume an attempt.
 */
const DEFERRABLE_CODES = new Set([
  'AI_QUOTA_EXHAUSTED',
  'AI_RATE_LIMITED',
  'AI_BUDGET_EXHAUSTED',
  'AI_PACED',
  'AI_BUSY',
  // The shared budget store (Redis) is not reachable: wait for it instead of counting in process memory.
  'AI_BUDGET_UNAVAILABLE',
]);

/**
 * Invalid AI output after the processing service's own retry (it asks Gemini twice before
 * giving up). Re-running the whole job would repeat the same expensive requests, so these
 * fail the job immediately; the user can still retry it manually. Transient failures
 * (network, timeouts, overloaded model, rate limits) keep the normal job-level retries.
 */
const INVALID_AI_OUTPUT_CODES = new Set(['AI_INVALID_RESPONSE', 'TRANSCRIPTION_INVALID_RESPONSE', 'OCR_INVALID_RESPONSE']);

/** Reduces any error to a code and a message that are safe to show to users. */
function toSafeJobError(error) {
  if (error && (error.name === 'ProcessingServiceError' || error.name === 'AiGateError')) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof UnrecoverableError) {
    return { code: 'UNRECOVERABLE', message: error.message };
  }
  return { code: 'JOB_FAILED', message: 'The job failed due to an internal error.' };
}

function retryAfterMsOf(error) {
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) return error.retryAfterMs;
  if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) return error.retryAfterSeconds * 1000;
  const fallback = error.code === 'AI_QUOTA_EXHAUSTED' ? config.ai.quotaFallbackSeconds : config.ai.rateLimitFallbackSeconds;
  return fallback * 1000;
}

/** Delay for the next deferral: what the provider asked for, bounded, plus jitter so workers don't wake together. */
function deferralDelayMs(error, remainingWindowMs) {
  const requested = retryAfterMsOf(error);
  const jitter = Math.round(Math.random() * Math.min(30000, requested * 0.1)) + 1000;
  return Math.max(5000, Math.min(requested + jitter, config.ai.maxDelaySeconds * 1000, remainingWindowMs));
}

/**
 * BullMQ backoff for ordinary retryable failures (attempts are counted): transient
 * AI problems (overloaded model, timeouts) wait longer than other errors.
 */
function backoffStrategy(attemptsMade, _type, error) {
  const transientAi = ['AI_UNAVAILABLE', 'AI_TIMEOUT'].includes(error?.code);
  const base = transientAi ? config.ai.transientRetrySeconds * 1000 : config.queue.backoffMs;
  return Math.min(base * 2 ** Math.max(0, attemptsMade - 1), 30 * 60 * 1000);
}

async function tryDefer(job, token, handler, ctx, error) {
  const { processingJobId, input } = job.data;
  if (!DEFERRABLE_CODES.has(error.code) || typeof job.moveToDelayed !== 'function') return 'not-deferrable';

  const deferrals = (job.data.aiDeferrals || 0) + 1;
  const firstDeferredAt = job.data.firstDeferredAt || Date.now();
  const remainingWindowMs = firstDeferredAt + config.ai.maxDeferHours * 3600 * 1000 - Date.now();
  if (deferrals > config.ai.maxDeferrals || remainingWindowMs <= 5000) return 'limit-reached';

  const delayMs = deferralDelayMs(error, remainingWindowMs);
  const until = new Date(Date.now() + delayMs);
  const safe = { code: error.code, message: deferredMessage(error.code, ctx.feature, delayMs) };

  await job.updateData({ ...job.data, aiDeferrals: deferrals, firstDeferredAt });
  await jobService.markJobDeferred(processingJobId, safe, until, deferrals);
  if (typeof handler.onDeferred === 'function') {
    try {
      await handler.onDeferred({ input, processingJobId, error: safe, until });
    } catch (hookError) {
      logger.error('onDeferred hook failed', { jobId: processingJobId, error: hookError });
    }
  }
  await job.moveToDelayed(until.getTime(), token);
  logger.warn('Job deferred until AI capacity is available', {
    jobId: processingJobId,
    type: job.data.type,
    code: error.code,
    delaySeconds: Math.round(delayMs / 1000),
    deferrals,
  });
  return 'deferred';
}

/**
 * BullMQ processor shared by every job type.
 *
 * Lifecycle recorded in MongoDB:
 *   queued -> active -> completed
 *                    -> queued (retrying, attempts < maxAttempts)
 *                    -> queued (deferred: waiting for AI quota / budget, attempts unchanged)
 *                    -> failed (final attempt, a non-retryable error, or deferral limit reached)
 */
async function processJob(job, token) {
  const { processingJobId, type, input } = job.data;
  const attempt = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts || 1;

  const handler = getJobHandler(type);
  if (!handler) {
    const error = { code: 'UNKNOWN_JOB_TYPE', message: `No handler is registered for job type "${type}".` };
    await jobService.markJobFailed(processingJobId, attempt, error);
    throw new UnrecoverableError(error.message);
  }

  const record = await jobService.markJobActive(processingJobId, attempt);
  const ctx = { feature: FEATURE_BY_TYPE[type] || 'other', userId: record?.user ? String(record.user) : input?.userId || null };
  logger.info('Job started', { jobId: processingJobId, type, attempt, maxAttempts });

  try {
    const result = await aiGate.runWithAiContext(ctx, () => handler({ input, processingJobId, attempt }));
    await jobService.markJobCompleted(processingJobId, attempt, result);
    logger.info('Job completed', { jobId: processingJobId, type, attempt });
    if (typeof handler.onCompleted === 'function') {
      try {
        await handler.onCompleted({ input, result });
      } catch (hookError) {
        logger.error('onCompleted hook failed', { jobId: processingJobId, type, error: hookError });
      }
    }
    return result;
  } catch (error) {
    const deferral = await tryDefer(job, token, handler, ctx, error);
    if (deferral === 'deferred') throw new DelayedError();

    let finalError = error;
    if (deferral === 'limit-reached') {
      // Quota stayed unavailable beyond the deferral window: fail clearly; the user can retry later.
      finalError = Object.assign(new Error(gaveUpMessage(error.code, ctx.feature)), {
        name: 'AiGateError',
        code: error.code,
        retryable: false,
      });
    }
    const safeError = toSafeJobError(finalError);
    const retryable =
      finalError.retryable !== false &&
      !(finalError instanceof UnrecoverableError) &&
      !INVALID_AI_OUTPUT_CODES.has(finalError.code);
    const isFinalAttempt = !retryable || attempt >= maxAttempts;

    if (isFinalAttempt) {
      await jobService.markJobFailed(processingJobId, attempt, safeError);
      logger.error('Job failed permanently', { jobId: processingJobId, type, attempt, error: finalError });
      if (typeof handler.onFinalFailure === 'function') {
        try {
          await handler.onFinalFailure({ input, processingJobId, error: safeError });
        } catch (hookError) {
          logger.error('onFinalFailure hook failed', { jobId: processingJobId, type, error: hookError });
        }
      }
      // UnrecoverableError tells BullMQ to skip any remaining retries.
      if (!retryable && !(finalError instanceof UnrecoverableError)) {
        throw new UnrecoverableError(safeError.message);
      }
      throw finalError;
    }

    await jobService.markJobRetrying(processingJobId, attempt, safeError);
    logger.warn('Job attempt failed; will retry', { jobId: processingJobId, type, attempt, maxAttempts, error });
    throw error;
  }
}

module.exports = { processJob, toSafeJobError, backoffStrategy, deferralDelayMs, FEATURE_BY_TYPE, DEFERRABLE_CODES, INVALID_AI_OUTPUT_CODES };
