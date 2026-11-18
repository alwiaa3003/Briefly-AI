'use strict';

const { rateLimit } = require('express-rate-limit');
const config = require('../config/env');
const { sendError } = require('../utils/http');

function createLimiter({ windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyGenerator && { keyGenerator }),
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED', message),
  });
}

/** Brute-force protection for login and registration (per client IP; see TRUST_PROXY). */
const authLimiter = createLimiter({
  windowMs: config.rateLimit.authWindowMs,
  limit: config.rateLimit.authMax,
  message: 'Too many authentication attempts. Please wait a few minutes and try again.',
});

/**
 * Session refresh, separate from authLimiter so that page reloads never use up the
 * login budget. Refresh tokens are long random single-use values (rotation with reuse
 * detection), so this limit caps request floods rather than guessing.
 */
const refreshLimiter = createLimiter({
  windowMs: config.rateLimit.refreshWindowMs,
  limit: config.rateLimit.refreshMax,
  message: 'Too many session requests. Please wait a few minutes and try again.',
});

/** Caps how many background jobs a client can submit. */
const jobLimiter = createLimiter({
  windowMs: config.rateLimit.jobWindowMs,
  limit: config.rateLimit.jobMax,
  message: 'Too many jobs submitted. Please wait a few minutes and try again.',
});

/**
 * Article submissions and retries, counted per signed-in user (each one
 * triggers a page fetch and a Gemini call). Must run after requireAuth.
 */
const articleLimiter = createLimiter({
  windowMs: config.rateLimit.articleWindowMs,
  limit: config.rateLimit.articleMax,
  keyGenerator: (req) => `user:${req.auth.userId}`,
  message: 'You have reached the hourly limit for new summaries. Please try again later.',
});

/** Video uploads per user per hour (bandwidth and storage), in addition to articleLimiter. */
const uploadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.uploadMax,
  keyGenerator: (req) => `upload:${req.auth.userId}`,
  message: 'You have reached the hourly limit for video uploads. Please try again later.',
});

/** Ask AI questions per user per hour (each one is an embedding + a Gemini call). */
const chatLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.chatMax,
  keyGenerator: (req) => `chat:${req.auth.userId}`,
  message: 'You have reached the hourly limit for questions. Please try again later.',
});

/** Study-tool and summary-style generations per user per hour. */
const studyLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.studyMax,
  keyGenerator: (req) => `study:${req.auth.userId}`,
  message: 'You have reached the hourly limit for generating study material. Please try again later.',
});

/** Smart searches per user per hour (each one embeds the query). */
const searchLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: config.rateLimit.searchMax,
  keyGenerator: (req) => `search:${req.auth.userId}`,
  message: 'Too many searches. Please wait a little and try again.',
});

module.exports = { authLimiter, refreshLimiter, jobLimiter, articleLimiter, uploadLimiter, chatLimiter, studyLimiter, searchLimiter };
